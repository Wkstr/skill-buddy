<script setup lang="ts">
import { reactive } from 'vue'
import { Eye, EyeOff, KeyRound, Save, TriangleAlert } from '@lucide/vue'
import type { McpInstallation } from '@skillbuddy/core'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useMcpServers } from '@/composables/useMcpServers'
import { showToast } from '@/composables/useToast'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  installation: McpInstallation
  secretNames: string[]
  busy?: boolean
}>()
const { t } = useI18n()
const { error, secretSavingKey, setSecret, mcpSecretSavingKey } = useMcpServers()
const values = reactive<Record<string, string>>({})
const visibleSecrets = reactive<Record<string, boolean>>({})

function saving(secretName: string): boolean {
  return (
    secretSavingKey.value === mcpSecretSavingKey(props.installation.id, secretName)
  )
}

function toggleVisibility(secretName: string): void {
  visibleSecrets[secretName] = !visibleSecrets[secretName]
}

async function save(secretName: string): Promise<void> {
  const value = values[secretName] ?? ''
  if (!value) return
  const result = await setSecret(props.installation.id, secretName, value)
  if (!result) {
    showToast.error(error.value ?? t('mcp.secrets.saveFailed'))
    return
  }
  values[secretName] = ''
  visibleSecrets[secretName] = false
  showToast.success(t('mcp.secrets.saved', { name: secretName }))
}
</script>

<template>
  <section class="border-t bg-muted/20 px-3 py-3">
    <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
      <div class="flex items-center gap-1.5 text-xs font-medium">
        <KeyRound class="size-3.5 text-muted-foreground" />
        {{ t('mcp.secrets.title') }}
      </div>
      <span class="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
        <TriangleAlert class="size-3" />
        {{ t('mcp.secrets.plaintextWarning') }}
      </span>
    </div>
    <div class="grid gap-2">
      <div
        v-for="(secretName, index) in props.secretNames"
        :key="secretName"
        class="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-end gap-2"
      >
        <div class="min-w-0">
          <label
            :for="`mcp-secret-${props.installation.id}-${index}`"
            class="mb-1.5 block truncate font-mono text-xs text-muted-foreground"
          >
            {{ secretName }}
          </label>
          <div class="relative">
            <Input
              :id="`mcp-secret-${props.installation.id}-${index}`"
              v-model="values[secretName]"
              :type="visibleSecrets[secretName] ? 'text' : 'password'"
              autocomplete="new-password"
              :clearable="false"
              :disabled="props.installation.source.readOnly || props.busy"
              class="pr-10 font-mono"
              :placeholder="t('mcp.secrets.placeholder')"
              @keydown.enter="save(secretName)"
            />
            <button
              v-if="values[secretName]"
              type="button"
              class="absolute right-2 top-1/2 grid size-7 -translate-y-1/2 cursor-pointer place-items-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="props.installation.source.readOnly || props.busy"
              :title="
                visibleSecrets[secretName]
                  ? t('mcp.secrets.hide', { name: secretName })
                  : t('mcp.secrets.show', { name: secretName })
              "
              :aria-label="
                visibleSecrets[secretName]
                  ? t('mcp.secrets.hide', { name: secretName })
                  : t('mcp.secrets.show', { name: secretName })
              "
              :aria-pressed="visibleSecrets[secretName] === true"
              @click="toggleVisibility(secretName)"
            >
              <EyeOff
                v-if="visibleSecrets[secretName]"
                class="size-4"
              />
              <Eye
                v-else
                class="size-4"
              />
            </button>
          </div>
        </div>
        <Button
          variant="outline"
          size="icon"
          class="cursor-pointer"
          :loading="saving(secretName)"
          :disabled="
            props.installation.source.readOnly ||
              props.busy ||
              !(values[secretName] ?? '')
          "
          :title="t('mcp.secrets.save', { name: secretName })"
          :aria-label="t('mcp.secrets.save', { name: secretName })"
          @click="save(secretName)"
        >
          <Save v-if="!saving(secretName)" />
        </Button>
      </div>
    </div>
  </section>
</template>
