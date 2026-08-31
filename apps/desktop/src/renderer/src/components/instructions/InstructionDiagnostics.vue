<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { CircleAlert } from '@lucide/vue'
import type { InstructionDiagnostic } from '#shared/ipc'
import { Button } from '@/components/ui/button'

const props = defineProps<{ diagnostics: InstructionDiagnostic[]; projectRoot?: string }>()
const emit = defineEmits<{ fix: [diagnostic: InstructionDiagnostic] }>()
const { t, te } = useI18n()

const visibleDiagnostics = computed(() => props.diagnostics.filter((diagnostic) => {
  if (!props.projectRoot) return false
  return diagnostic.paths.some((path) =>
    path === props.projectRoot
    || path.startsWith(`${props.projectRoot}/`)
    || path.startsWith(`${props.projectRoot}\\`),
  )
}))

function diagnosticLabel(code: string, fallback: string): string {
  const key = `instructions.diagnostic.${code}`
  return te(key) ? t(key) : fallback
}
</script>

<template>
  <section
    v-if="visibleDiagnostics.length"
    class="mt-5 border-t pt-4"
  >
    <div class="mb-3 text-xs font-medium text-muted-foreground">
      {{ t('instructions.diagnosticsTitle') }}
    </div>
    <div class="space-y-3">
      <div
        v-for="diagnostic in visibleDiagnostics"
        :key="`${diagnostic.code}:${diagnostic.paths[0]}`"
        class="flex gap-2 text-xs"
      >
        <CircleAlert :class="['mt-0.5 size-3.5 shrink-0', diagnostic.severity === 'error' ? 'text-destructive' : 'text-amber-600']" />
        <div class="min-w-0 flex-1">
          <div>{{ diagnosticLabel(diagnostic.code, diagnostic.message) }}</div>
          <div
            v-if="diagnostic.paths[0]"
            class="mt-0.5 truncate text-muted-foreground"
            :title="diagnostic.paths[0]"
          >
            {{ diagnostic.paths[0] }}
          </div>
        </div>
        <Button
          v-if="diagnostic.fixable"
          variant="outline"
          size="sm"
          class="h-7 shrink-0 px-2 text-xs"
          @click="emit('fix', diagnostic)"
        >
          {{ t('instructions.bridge.action') }}
        </Button>
      </div>
    </div>
  </section>
</template>
