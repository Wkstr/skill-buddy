<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { AlertTriangle, FileText, X } from '@lucide/vue'
import {
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
} from 'reka-ui'
import type { InstructionOperationPlanView } from '#shared/ipc'
import DiffView from '@/components/DiffView.vue'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'

const props = defineProps<{ plan: InstructionOperationPlanView | null; applying: boolean }>()
const emit = defineEmits<{ close: []; apply: [] }>()
const { t, te } = useI18n()

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}

function planLabel(suffix: 'Title' | 'Action'): string {
  const key = `instructions.plan.${props.plan?.intent ?? 'write'}${suffix}`
  return te(key) ? t(key) : t(`instructions.plan.write${suffix}`)
}

function issueLabel(code: string, fallback: string): string {
  const key = `instructions.issue.${code}`
  return te(key) ? t(key) : fallback
}
</script>

<template>
  <DialogRoot
    :open="props.plan !== null"
    @update:open="(open) => !open && emit('close')"
  >
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-40 bg-black/40" />
      <DialogContent
        class="fixed left-1/2 top-1/2 z-50 flex max-h-[86vh] w-[min(760px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border bg-background shadow-xl outline-none"
        @open-auto-focus.prevent
      >
        <header class="flex items-start gap-3 border-b px-5 py-4">
          <FileText class="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div class="min-w-0 flex-1">
            <DialogTitle class="text-base font-semibold">
              {{ planLabel('Title') }}
            </DialogTitle>
            <DialogDescription class="mt-1 truncate text-sm text-muted-foreground">
              {{ basename(props.plan?.path ?? '') }} · {{ props.plan?.path }}
            </DialogDescription>
          </div>
          <Button
            variant="ghost"
            size="icon"
            class="size-8"
            :disabled="props.applying"
            :title="t('common.close')"
            :aria-label="t('common.close')"
            @click="emit('close')"
          >
            <X class="size-4" />
          </Button>
        </header>

        <ScrollArea
          class="min-h-0 flex-1"
          viewport-class="px-5 py-4"
        >
          <DiffView
            :base="props.plan?.beforeText ?? ''"
            :other="props.plan?.afterText ?? ''"
          />

          <section
            v-if="props.plan?.impacts?.length"
            class="mt-4 border-t pt-4"
          >
            <h3 class="text-sm font-medium">
              {{ t('instructions.plan.impactsTitle') }}
            </h3>
            <div class="mt-2 divide-y rounded-md border">
              <div
                v-for="impact in props.plan.impacts"
                :key="impact.tool"
                class="px-3 py-2"
              >
                <div class="text-sm font-medium">
                  {{ impact.tool }}
                </div>
                <div
                  v-if="impact.chainPaths.length"
                  class="mt-1 space-y-0.5 text-xs text-muted-foreground"
                >
                  <div
                    v-for="chainPath in impact.chainPaths"
                    :key="chainPath"
                    class="truncate"
                    :title="chainPath"
                  >
                    {{ chainPath }}
                  </div>
                </div>
                <div
                  v-else
                  class="mt-1 text-xs text-muted-foreground"
                >
                  {{ t('instructions.plan.globalImpact') }}
                </div>
              </div>
            </div>
          </section>

          <div
            v-if="props.plan?.warnings.length"
            class="mt-4 space-y-2"
          >
            <p
              v-for="warning in props.plan.warnings"
              :key="warning.code"
              class="flex gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-700 dark:text-amber-400"
            >
              <AlertTriangle class="mt-0.5 size-4 shrink-0" />
              <span>{{ issueLabel(warning.code, warning.message) }}</span>
            </p>
          </div>

          <div
            v-if="props.plan?.blockers.length"
            class="mt-4 space-y-2"
          >
            <p
              v-for="blocker in props.plan.blockers"
              :key="blocker.code"
              class="flex gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
            >
              <AlertTriangle class="mt-0.5 size-4 shrink-0" />
              <span>{{ issueLabel(blocker.code, blocker.message) }}</span>
            </p>
          </div>
        </ScrollArea>

        <footer class="flex justify-end gap-2 border-t px-5 py-4">
          <Button
            variant="ghost"
            size="sm"
            :disabled="props.applying"
            @click="emit('close')"
          >
            {{ t('common.cancel') }}
          </Button>
          <Button
            size="sm"
            :variant="props.plan?.intent === 'delete' ? 'destructive' : 'default'"
            :disabled="!props.plan?.canApply"
            :loading="props.applying"
            @click="emit('apply')"
          >
            {{ planLabel('Action') }}
          </Button>
        </footer>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
