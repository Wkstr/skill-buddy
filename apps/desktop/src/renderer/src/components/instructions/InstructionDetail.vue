<script setup lang="ts">
import { computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { CircleAlert, FileText, Link2, Pencil, ShieldCheck, Trash2 } from '@lucide/vue'
import {
  PopoverContent,
  PopoverPortal,
  PopoverRoot,
  PopoverTrigger,
} from 'reka-ui'
import type { EffectiveInstructionChain, InstructionDiagnostic, InstructionDocument, InstructionRuleProfile } from '#shared/ipc'
import MarkdownView from '@/components/MarkdownView.vue'
import PlatformIcon from '@/components/PlatformIcon.vue'
import InstructionDiagnostics from './InstructionDiagnostics.vue'
import InstructionEffectiveChain from './InstructionEffectiveChain.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { Tooltip } from '@/components/ui/tooltip'
import { VirtualSelect } from '@/components/ui/virtual-select'
import { useSkills } from '@/composables/useSkills'

const props = defineProps<{
  document: InstructionDocument | null
  content: string
  contentLoading: boolean
  contentTruncated: boolean
  profiles: InstructionRuleProfile[]
  surfaceKey: string
  targetDirectory: string
  targetDirectories: string[]
  projectRoot?: string
  projectScope: boolean
  chain: EffectiveInstructionChain | null
  diagnostics: InstructionDiagnostic[]
}>()
const { locale } = useI18n()
const { detectedPlatforms } = useSkills()
const emit = defineEmits<{
  'update:surfaceKey': [value: string]
  'update:targetDirectory': [value: string]
  edit: []
  delete: []
  bridge: [sourcePath?: string]
}>()

const detectedProfiles = computed(() => props.profiles.filter((profile) =>
  detectedPlatforms.value.some((platform) => platform.id === profile.platformId)))
/** 一个平台都没检测到时回退到全部 Surface，否则下拉为空、触发器空白且无法切换分析工具。 */
const profileOptions = computed(() =>
  (detectedProfiles.value.length > 0 ? detectedProfiles.value : props.profiles)
    .map((profile) => ({
      value: `${profile.key.vendorId}/${profile.key.productId}/${profile.key.surfaceId}`,
      label: profile.displayName,
      iconId: profile.platformId ?? undefined,
    })))
const selectedProfile = computed(() => props.profiles.find((profile) =>
  `${profile.key.vendorId}/${profile.key.productId}/${profile.key.surfaceId}` === props.surfaceKey,
) ?? null)
const targetOptions = computed(() => props.targetDirectories.map((value) => ({
  value,
  label: value === props.projectRoot
    ? '.'
    : value.slice((props.projectRoot?.length ?? -1) + 1),
})))
const bindingTools = computed(() => {
  const seen = new Set<string>()
  return props.document?.bindings.flatMap((binding) => {
    const key = `${binding.surface.vendorId}/${binding.surface.productId}/${binding.surface.surfaceId}`
    if (seen.has(key)) return []
    seen.add(key)
    const profile = props.profiles.find((item) =>
      `${item.key.vendorId}/${item.key.productId}/${item.key.surfaceId}` === key,
    )
    return [{
      key,
      label: profile?.displayName ?? key,
      iconId: profile?.platformId ?? binding.surface.productId,
    }]
  }) ?? []
})
const bindingLabels = computed(() => bindingTools.value.map((tool) => tool.label))
const bindingSummary = computed(() => {
  const first = bindingLabels.value[0]
  if (!first) return ''
  return bindingLabels.value.length === 1 ? first : `${first} +${bindingLabels.value.length - 1}`
})
const fileMetadata = computed(() => {
  if (!props.document) return ''
  const size = props.document.size < 1024
    ? `${props.document.size} B`
    : `${(props.document.size / 1024).toFixed(1)} KB`
  const modified = new Intl.DateTimeFormat(locale.value, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(props.document.modifiedAt)
  return `${size} · ${modified}`
})
const bridged = computed(() =>
  props.document?.bindings.some((binding) => binding.status === 'bridged') ?? false,
)
const selectedRole = computed(() => props.document?.bindings.find((binding) =>
  `${binding.surface.vendorId}/${binding.surface.productId}/${binding.surface.surfaceId}` === props.surfaceKey,
)?.role)
const diagnosticCount = computed(() => props.diagnostics.filter((diagnostic) => {
  if (!props.projectRoot) return false
  return diagnostic.paths.some((path) =>
    path === props.projectRoot
    || path.startsWith(`${props.projectRoot}/`)
    || path.startsWith(`${props.projectRoot}\\`),
  )
}).length)
const canEdit = computed(() => Boolean(
  props.document
  && !props.document.readOnly
  && !props.document.linked
  && !props.document.contentTruncated
  && !props.document.encodingInvalid
  && !props.contentLoading,
))
const canDelete = computed(() => Boolean(
  props.document
  && !(props.document.scope === 'user' && props.document.linked),
))
const canBridge = computed(() => Boolean(
  props.document
  && props.document.scope === 'project'
  && props.document.fileName === 'AGENTS.md'
  && !props.document.linkBroken,
))

watch(
  profileOptions,
  (options) => {
    if (options.length > 0 && !options.some((option) => option.value === props.surfaceKey)) {
      emit('update:surfaceKey', options[0]!.value)
    }
  },
  { immediate: true },
)

function updateSurfaceKey(value: string | undefined): void {
  if (value) emit('update:surfaceKey', value)
}

function updateTargetDirectory(value: string | undefined): void {
  if (value) emit('update:targetDirectory', value)
}
</script>

<template>
  <section class="flex min-w-0 flex-1 flex-col">
    <div
      v-if="props.document"
      class="flex h-14 shrink-0 items-center gap-3 border-b px-4"
    >
      <FileText class="size-4 shrink-0 text-muted-foreground" />
      <div class="min-w-0 flex-1">
        <div class="truncate text-sm font-medium">
          {{ props.document.fileName }}
        </div>
        <div class="text-xs text-muted-foreground">
          {{ fileMetadata }}
        </div>
      </div>
      <Tooltip
        v-if="bindingSummary"
        side="bottom"
        align="end"
        content-class="w-52"
      >
        <Badge
          variant="secondary"
          class="flex max-w-40 items-center gap-1 whitespace-nowrap text-xs"
        >
          <PlatformIcon
            v-if="bindingTools[0]"
            :id="bindingTools[0].iconId"
            :size="13"
          />
          <span class="truncate">{{ bindingSummary }}</span>
        </Badge>
        <template #content>
          <div class="font-medium">
            {{ $t('instructions.supportedTools') }}
          </div>
          <ul class="mt-1 space-y-1 text-muted-foreground">
            <li
              v-for="tool in bindingTools"
              :key="tool.key"
              class="flex items-center gap-2"
            >
              <PlatformIcon
                :id="tool.iconId"
                :size="14"
              />
              <span class="truncate">{{ tool.label }}</span>
            </li>
          </ul>
        </template>
      </Tooltip>
      <Badge
        v-if="bridged"
        variant="success"
      >
        {{ $t('instructions.bridged') }}
      </Badge>
      <Badge
        v-if="selectedRole && selectedRole !== 'primary'"
        variant="outline"
      >
        {{ $t(`instructions.role.${selectedRole}`) }}
      </Badge>
      <Badge
        v-if="props.document.linked"
        variant="secondary"
        :title="props.document.linkTarget"
      >
        <Link2 class="size-3" />{{ $t('instructions.linked') }}
      </Badge>
      <Badge
        v-if="props.document.readOnly"
        variant="outline"
      >
        {{ $t('instructions.readOnly') }}
      </Badge>
      <Badge
        v-if="props.contentTruncated"
        variant="outline"
      >
        {{ $t('instructions.truncated') }}
      </Badge>
      <Badge
        v-if="props.document.encodingInvalid"
        variant="outline"
      >
        {{ $t('instructions.invalidEncoding') }}
      </Badge>
      <Button
        v-if="canBridge"
        variant="ghost"
        size="icon"
        class="size-8"
        :title="$t('instructions.bridge.action')"
        :aria-label="$t('instructions.bridge.action')"
        @click="emit('bridge')"
      >
        <Link2 class="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        class="size-8"
        :disabled="!canEdit"
        :title="$t('instructions.editor.editAction')"
        :aria-label="$t('instructions.editor.editAction')"
        @click="emit('edit')"
      >
        <Pencil class="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        class="size-8 text-destructive hover:text-destructive"
        :disabled="!canDelete"
        :title="$t('instructions.editor.deleteAction')"
        :aria-label="$t('instructions.editor.deleteAction')"
        @click="emit('delete')"
      >
        <Trash2 class="size-4" />
      </Button>
    </div>

    <div
      v-if="props.projectScope"
      class="flex shrink-0 items-center gap-2 border-b px-4 py-2"
    >
      <div class="flex shrink-0 items-center gap-2">
        <span class="text-xs text-muted-foreground">{{ $t('instructions.analysisTool') }}</span>
        <Select
          :model-value="props.surfaceKey"
          :options="profileOptions"
          class="w-40"
          @update:model-value="updateSurfaceKey"
        >
          <template #value="{ option }">
            <span class="flex min-w-0 items-center gap-2">
              <PlatformIcon
                v-if="option?.iconId"
                :id="option.iconId"
                :size="14"
              />
              <span class="truncate">{{ option?.label }}</span>
            </span>
          </template>
          <template #option="{ option }">
            <span class="flex items-center gap-2">
              <PlatformIcon
                v-if="option.iconId"
                :id="option.iconId"
                :size="14"
              />
              <span class="truncate">{{ option.label }}</span>
            </span>
          </template>
        </Select>
      </div>
      <Badge
        variant="outline"
        class="text-xs"
      >
        {{ $t(`instructions.evidence.${selectedProfile?.evidence ?? 'unknown'}`) }}
      </Badge>
      <Badge
        v-if="selectedProfile && selectedProfile.platformId === null"
        variant="secondary"
        class="text-xs"
      >
        {{ $t('instructions.instructionsOnly') }}
      </Badge>
      <div class="flex min-w-0 flex-1 items-center gap-2">
        <span class="shrink-0 text-xs text-muted-foreground">{{ $t('instructions.targetDirectory') }}</span>
        <VirtualSelect
          :model-value="props.targetDirectory"
          :options="targetOptions"
          :placeholder="$t('instructions.targetDirectory')"
          :search-placeholder="$t('instructions.searchDirectories')"
          :empty-text="$t('instructions.noMatchingDirectories')"
          class="min-w-52 flex-1"
          @update:model-value="updateTargetDirectory"
        />
      </div>
      <PopoverRoot v-if="props.projectScope">
        <PopoverTrigger as-child>
          <button
            type="button"
            class="flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            :title="$t('instructions.effectiveChain')"
            :aria-label="$t('instructions.effectiveChain')"
          >
            <ShieldCheck class="size-3.5" />
            {{ props.chain?.documents.length ?? 0 }} {{ $t('instructions.chainFiles') }}
            <CircleAlert
              v-if="diagnosticCount"
              class="size-3.5 text-amber-600 dark:text-amber-400"
            />
          </button>
        </PopoverTrigger>
        <PopoverPortal>
          <PopoverContent
            align="end"
            side="bottom"
            :side-offset="8"
            class="instruction-scroll z-50 max-h-[min(70vh,560px)] w-[min(360px,calc(100vw-32px))] overflow-y-auto rounded-lg border bg-popover p-4 text-popover-foreground shadow-lg outline-none"
          >
            <InstructionEffectiveChain
              :chain="props.chain"
              :project-scope="props.projectScope"
            />
            <InstructionDiagnostics
              :diagnostics="props.diagnostics"
              :project-root="props.projectRoot"
              @fix="emit('bridge', $event.paths[0])"
            />
          </PopoverContent>
        </PopoverPortal>
      </PopoverRoot>
    </div>

    <div class="grid min-h-0 flex-1 grid-cols-1">
      <div
        v-if="props.document"
        class="instruction-scroll overflow-y-auto px-6 py-5"
      >
        <div
          v-if="props.contentLoading"
          class="text-sm text-muted-foreground"
        >
          {{ $t('instructions.loading') }}
        </div>
        <MarkdownView
          v-else
          :content="props.content"
          :preview-id="`instruction-${props.document.id}`"
        />
      </div>
      <div
        v-else
        class="flex flex-col items-center justify-center gap-2 text-muted-foreground"
      >
        <FileText class="size-8 opacity-50" />
        <p class="text-sm">
          {{ $t('instructions.selectFile') }}
        </p>
      </div>
    </div>
  </section>
</template>
