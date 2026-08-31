<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { AlertTriangle } from '@lucide/vue'
import type { EffectiveInstructionChain } from '#shared/ipc'

const props = defineProps<{ chain: EffectiveInstructionChain | null; projectScope: boolean }>()
const { t, te } = useI18n()

function warningLabel(code: string, fallback: string): string {
  const key = `instructions.warning.${code}`
  return te(key) ? t(key) : fallback
}
</script>

<template>
  <section>
    <div class="mb-3 text-xs font-medium text-muted-foreground">
      {{ t('instructions.effectiveChain') }}
    </div>
    <div
      v-if="!props.projectScope"
      class="text-sm text-muted-foreground"
    >
      {{ t('instructions.globalChainHint') }}
    </div>
    <div
      v-else-if="!props.chain?.documents.length"
      class="text-sm text-muted-foreground"
    >
      {{ t('instructions.noChain') }}
    </div>
    <ol
      v-else
      class="space-y-3"
    >
      <li
        v-for="(item, index) in props.chain.documents"
        :key="item.id"
        class="flex gap-2 text-sm"
      >
        <span class="flex size-5 shrink-0 items-center justify-center rounded bg-muted text-[11px] tabular-nums">{{ index + 1 }}</span>
        <div class="min-w-0">
          <div class="truncate font-medium">
            {{ item.fileName }}
          </div>
          <div
            class="truncate text-xs text-muted-foreground"
            :title="item.path"
          >
            {{ item.relativeDirectory ?? t('instructions.global') }}
          </div>
        </div>
      </li>
    </ol>
    <div
      v-if="props.chain?.warnings.length"
      class="mt-5 space-y-2 border-t pt-4"
    >
      <div
        v-for="warning in props.chain.warnings"
        :key="warning.code"
        class="flex gap-2 text-xs text-muted-foreground"
      >
        <AlertTriangle class="mt-0.5 size-3.5 shrink-0 text-amber-600" />
        <span>{{ warningLabel(warning.code, warning.message) }}</span>
      </div>
    </div>
  </section>
</template>
