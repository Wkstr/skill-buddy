<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  ArrowRightLeft,
  CircleAlert,
  ExternalLink,
  FolderGit2,
  Power,
  PowerOff,
  ShieldAlert,
  Trash2,
  TriangleAlert,
} from '@lucide/vue'
import type {
  AggregatedMcpServer,
  McpInstallation,
  McpPlatformStatus,
  McpValueRef,
} from '@skillbuddy/core'
import { isMcpCredentialName } from '#shared/mcp-credentials'
import PlatformIcon from '@/components/PlatformIcon.vue'
import McpSecretEditor from '@/components/mcp/McpSecretEditor.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'

const props = defineProps<{
  server: AggregatedMcpServer
  platforms: McpPlatformStatus[]
  busy?: boolean
}>()
const emit = defineEmits<{
  sync: [installation: McpInstallation]
  remove: [installationIds: string[]]
  toggle: [installationId: string, enabled: boolean]
}>()
const { t } = useI18n()

const definition = computed(() => props.server.installations[0]?.definition)
const writableInstallations = computed(() =>
  props.server.installations.filter((installation) => !installation.source.readOnly),
)
const canUseDefaultSource = computed(
  () => !props.server.hasDefinitionDrift && !props.server.conflictKind,
)
const credentialRequirements = computed(() =>
  (definition.value?.requiredSecrets ?? []).filter(isMcpCredentialName),
)
const environmentRequirements = computed(() =>
  (definition.value?.requiredSecrets ?? []).filter((name) => !isMcpCredentialName(name)),
)

function capability(installation: McpInstallation): McpPlatformStatus | undefined {
  return props.platforms.find(
    (platform) =>
      platform.agent === installation.source.agent &&
      platform.surface === installation.source.surface,
  )
}

function canToggle(installation: McpInstallation): boolean {
  return (
    !installation.source.readOnly && capability(installation)?.capabilities.toggle === 'native'
  )
}

function authLabel(installation: McpInstallation): string {
  return t(`mcp.auth.${installation.authState}`)
}

function authClass(installation: McpInstallation): string {
  if (installation.authState === 'ready') return 'text-emerald-600 dark:text-emerald-400'
  if (installation.authState === 'missing-secrets') return 'text-amber-600 dark:text-amber-400'
  return 'text-muted-foreground'
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

function scopeLabel(installation: McpInstallation): string {
  return installation.source.scope === 'user'
    ? t('mcp.target.global')
    : installation.source.scope === 'local'
      ? t('mcp.target.local')
      : t('mcp.target.project')
}

function referenceMatches(ref: McpValueRef, secretName: string): boolean {
  return ref.kind === 'env' ? ref.name === secretName : ref.kind === 'secret' && ref.key === secretName
}

function editableCredentialNames(installation: McpInstallation): string[] {
  if (installation.source.readOnly) return []
  const refs = credentialRefs(installation)
  // 只放开确实缺值的引用。authState 是整个安装的聚合状态，按它放行会让同一安装下
  // 已经生效的 ${VAR} 引用被明文密钥覆盖。
  return installation.missingSecrets.filter(
    (name) =>
      isMcpCredentialName(name) &&
      Object.values(refs).some((ref) => referenceMatches(ref, name)),
  )
}

/** 密钥内嵌在命令参数或 URL 里，定位不到可写字段，只能提示用户手动改配置文件。 */
function unsupportedCredentialNames(installation: McpInstallation): string[] {
  const refs = credentialRefs(installation)
  return installation.definition.requiredSecrets.filter(
    (name) =>
      isMcpCredentialName(name) &&
      !Object.values(refs).some((ref) => referenceMatches(ref, name)),
  )
}

function credentialRefs(installation: McpInstallation): Record<string, McpValueRef> {
  const transport = installation.definition.transport
  return transport.kind === 'stdio' ? transport.env : transport.headers
}
</script>

<template>
  <div class="flex h-full min-h-0 min-w-0 flex-col">
    <header class="flex shrink-0 items-start justify-between gap-4 border-b px-6 py-5">
      <div class="min-w-0">
        <div class="flex flex-wrap items-center gap-2">
          <h2 class="truncate text-lg font-semibold">{{ server.name }}</h2>
          <Badge variant="secondary" class="font-normal">
            {{ definition?.transport.kind }}
          </Badge>
          <Badge
            v-if="server.conflictKind"
            variant="outline"
            class="gap-1 border-destructive/40 text-destructive"
          >
            <CircleAlert class="size-3" />
            {{ t('mcp.conflict', { kind: server.conflictKind }) }}
          </Badge>
          <Badge
            v-else-if="server.hasDefinitionDrift || server.hasStateDrift"
            variant="outline"
            class="gap-1 border-amber-500/40 text-amber-600 dark:text-amber-400"
          >
            <TriangleAlert class="size-3" />
            {{ t('mcp.drift') }}
          </Badge>
        </div>
        <p v-if="definition?.description" class="mt-1 text-sm text-muted-foreground">
          {{ definition.description }}
        </p>
      </div>
      <div class="flex shrink-0 items-center gap-2">
        <Button
          v-if="canUseDefaultSource && server.installations[0]"
          variant="outline"
          size="sm"
          :disabled="busy"
          @click="emit('sync', server.installations[0])"
        >
          <ArrowRightLeft />
          {{ t('mcp.actions.sync') }}
        </Button>
        <Button
          v-if="writableInstallations.length > 0"
          variant="outline"
          size="icon"
          class="text-destructive hover:bg-destructive/10 hover:text-destructive"
          :disabled="busy"
          :title="t('mcp.actions.removeAll')"
          :aria-label="t('mcp.actions.removeAll')"
          @click="emit('remove', writableInstallations.map((installation) => installation.id))"
        >
          <Trash2 />
        </Button>
      </div>
    </header>

    <ScrollArea class="min-h-0 flex-1">
      <section class="border-b px-6 py-5">
        <h3 class="text-sm font-semibold">{{ t('mcp.definition') }}</h3>
        <dl class="mt-3 grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
          <div v-if="definition?.transport.kind === 'stdio'">
            <dt class="text-xs text-muted-foreground">{{ t('mcp.command') }}</dt>
            <dd class="mt-1 break-all font-mono">{{ definition.transport.command }}</dd>
          </div>
          <div v-if="definition?.transport.kind === 'stdio'">
            <dt class="text-xs text-muted-foreground">{{ t('mcp.arguments') }}</dt>
            <dd class="mt-1 break-all font-mono text-xs">
              {{ definition.transport.args.join(' ') || '—' }}
            </dd>
          </div>
          <div v-if="definition?.transport.kind !== 'stdio'">
            <dt class="text-xs text-muted-foreground">URL</dt>
            <dd class="mt-1 flex items-center gap-1 break-all font-mono text-xs">
              {{ definition?.transport.url }}
              <ExternalLink class="size-3 shrink-0 text-muted-foreground" />
            </dd>
          </div>
          <div v-if="credentialRequirements.length > 0">
            <dt class="text-xs text-muted-foreground">
              {{ t('mcp.requiredCredentials') }}
            </dt>
            <dd class="mt-1 flex flex-wrap gap-1.5">
              <Badge
                v-for="secret in credentialRequirements"
                :key="secret"
                variant="secondary"
                class="font-mono text-xs font-normal"
              >
                {{ secret }}
              </Badge>
            </dd>
          </div>
          <div v-if="environmentRequirements.length > 0">
            <dt class="text-xs text-muted-foreground">
              {{ t('mcp.environmentRequirements') }}
            </dt>
            <dd class="mt-1 flex flex-wrap gap-1.5">
              <Badge
                v-for="environmentName in environmentRequirements"
                :key="environmentName"
                variant="outline"
                class="font-mono text-xs font-normal text-muted-foreground"
              >
                {{ environmentName }}
              </Badge>
            </dd>
          </div>
          <div v-if="credentialRequirements.length === 0 && environmentRequirements.length === 0">
            <dt class="text-xs text-muted-foreground">
              {{ t('mcp.configurationRequirements') }}
            </dt>
            <dd class="mt-1 text-muted-foreground">—</dd>
          </div>
        </dl>
      </section>

      <section class="px-6 py-5">
        <div class="flex items-center justify-between">
          <h3 class="text-sm font-semibold">{{ t('mcp.installations') }}</h3>
          <span class="text-xs tabular-nums text-muted-foreground">
            {{ server.installations.length }}
          </span>
        </div>
        <div class="mt-3 divide-y rounded-md border">
          <div
            v-for="installation in server.installations"
            :key="installation.id"
            class="min-w-0"
          >
            <div class="flex items-center gap-3 px-3 py-3">
              <PlatformIcon :id="installation.source.agent" :size="20" />
              <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-center gap-2">
                  <span class="text-sm font-medium">
                    {{ capability(installation)?.displayName ?? installation.source.agent }}
                  </span>
                  <span class="text-xs text-muted-foreground">
                    {{ installation.source.surface }} · {{ scopeLabel(installation) }}
                  </span>
                  <Badge
                    v-if="installation.source.readOnly"
                    variant="secondary"
                    class="px-2 py-0 text-xs font-normal"
                  >
                    {{ t('mcp.readOnly') }}
                  </Badge>
                  <Badge
                    v-if="installation.enabled === false"
                    variant="secondary"
                    class="px-2 py-0 text-xs font-normal text-amber-600 dark:text-amber-400"
                  >
                    {{ t('mcp.disabled') }}
                  </Badge>
                </div>
                <div class="mt-1 flex min-w-0 items-center gap-3 text-xs">
                  <span :class="['flex items-center gap-1', authClass(installation)]">
                    <ShieldAlert v-if="installation.authState !== 'ready'" class="size-3" />
                    {{ authLabel(installation) }}
                  </span>
                  <span
                    v-if="installation.source.projectRoot"
                    class="flex min-w-0 items-center gap-1 text-muted-foreground"
                    :title="installation.source.projectRoot"
                  >
                    <FolderGit2 class="size-3 shrink-0" />
                    <span class="max-w-40 truncate">
                      {{ basename(installation.source.projectRoot) }}
                    </span>
                  </span>
                  <span
                    class="truncate font-mono text-muted-foreground"
                    :title="installation.source.configPath"
                  >
                    {{ basename(installation.source.configPath) }}
                  </span>
                </div>
              </div>
              <div class="flex shrink-0 items-center gap-1">
                <button
                  v-if="!canUseDefaultSource"
                  type="button"
                  class="cursor-pointer rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                  :disabled="busy"
                  :title="t('mcp.actions.useAsSource')"
                  :aria-label="t('mcp.actions.useAsSource')"
                  @click="emit('sync', installation)"
                >
                  <ArrowRightLeft class="size-4" />
                </button>
                <button
                  v-if="canToggle(installation)"
                  type="button"
                  :class="[
                    'cursor-pointer rounded-md p-2 transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                    installation.enabled === false
                      ? 'bg-amber-500/10 text-amber-600 hover:bg-amber-500/15 dark:text-amber-400'
                      : 'bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500/15 dark:text-emerald-400',
                  ]"
                  :disabled="busy"
                  :aria-pressed="installation.enabled !== false"
                  :title="
                    installation.enabled === false
                      ? t('mcp.actions.enable')
                      : t('mcp.actions.disable')
                  "
                  :aria-label="
                    installation.enabled === false
                      ? t('mcp.actions.enable')
                      : t('mcp.actions.disable')
                  "
                  @click="emit('toggle', installation.id, installation.enabled === false)"
                >
                  <PowerOff v-if="installation.enabled === false" class="size-4" />
                  <Power v-else class="size-4" />
                </button>
                <button
                  v-if="!installation.source.readOnly"
                  type="button"
                  class="cursor-pointer rounded-md p-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-50"
                  :disabled="busy"
                  :title="t('mcp.actions.remove')"
                  :aria-label="t('mcp.actions.remove')"
                  @click="emit('remove', [installation.id])"
                >
                  <Trash2 class="size-4" />
                </button>
              </div>
            </div>
            <McpSecretEditor
              v-if="editableCredentialNames(installation).length > 0"
              :installation="installation"
              :secret-names="editableCredentialNames(installation)"
              :busy="busy"
            />
            <p
              v-if="unsupportedCredentialNames(installation).length > 0"
              class="flex items-start gap-1.5 border-t bg-muted/20 px-3 py-2 text-xs text-muted-foreground"
            >
              <ShieldAlert class="mt-0.5 size-3.5 shrink-0" />
              <span>
                {{ t('mcp.secrets.unsupported') }}
                <span class="font-mono">{{ unsupportedCredentialNames(installation).join('、') }}</span>
              </span>
            </p>
          </div>
        </div>
      </section>
    </ScrollArea>
  </div>
</template>
