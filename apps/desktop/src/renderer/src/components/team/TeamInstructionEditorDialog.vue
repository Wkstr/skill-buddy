<script setup lang="ts">
import { computed, reactive, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui'
import type { TeamLibraryInstructionDraft } from '#shared/ipc'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

const props = defineProps<{
  open: boolean
  initial?: TeamLibraryInstructionDraft | null
  busy?: boolean
}>()
const emit = defineEmits<{
  close: []
  save: [value: TeamLibraryInstructionDraft]
}>()
const { t } = useI18n()
const form = reactive<TeamLibraryInstructionDraft>({
  id: '',
  name: '',
  description: '',
  version: '',
  target: 'AGENTS.md',
  content: '',
})

function reset(): void {
  const initial = props.initial
  Object.assign(form, {
    originalPath: initial?.originalPath,
    id: initial?.id ?? '',
    name: initial?.name ?? '',
    description: initial?.description ?? '',
    version: initial?.version ?? '',
    target: initial?.target ?? 'AGENTS.md',
    content: initial?.content ?? '# Project Instructions\n\n',
  })
}

watch(() => [props.open, props.initial], () => {
  if (props.open) reset()
}, { immediate: true })

/**
 * 描述留空由主进程补默认值，与 parseInstructionTemplate 的兜底保持一致，
 * 因此这里只校验真正无法推导的字段。
 */
const missingFields = computed(() => [
  ...(form.id.trim() ? [] : [t('team.formId')]),
  ...(form.name.trim() ? [] : [t('team.formName')]),
  ...(form.target.trim() ? [] : [t('team.instructionTarget')]),
  ...(form.content.trim() ? [] : [t('team.instructionContent')]),
])

function submit(): void {
  emit('save', {
    ...form,
    version: form.version?.trim() || undefined,
  })
}
</script>

<template>
  <DialogRoot
    :open="props.open"
    @update:open="(value) => !value && emit('close')"
  >
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-40 bg-black/40" />
      <DialogContent class="fixed left-1/2 top-1/2 z-50 flex max-h-[90vh] w-[min(820px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border bg-background shadow-xl outline-none">
        <div class="border-b px-5 py-4">
          <DialogTitle class="text-base font-semibold">
            {{ props.initial ? t('team.instructionTemplateEdit') : t('team.instructionTemplateCreate') }}
          </DialogTitle>
          <DialogDescription class="mt-1 text-sm text-muted-foreground">
            {{ t('team.instructionTemplateEditorHint') }}
          </DialogDescription>
        </div>
        <form
          class="instruction-scroll min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4"
          @submit.prevent="submit"
        >
          <div class="grid gap-4 sm:grid-cols-3">
            <label class="grid gap-1.5 text-sm font-medium">
              {{ t('team.formId') }}
              <Input
                v-model="form.id"
                placeholder="engineering-baseline"
              />
            </label>
            <label class="grid gap-1.5 text-sm font-medium">
              {{ t('team.formVersion') }}
              <Input
                v-model="form.version"
                :placeholder="t('team.formVersionPh')"
              />
            </label>
            <label class="grid gap-1.5 text-sm font-medium">
              {{ t('team.instructionTarget') }}
              <Input
                v-model="form.target"
                placeholder="AGENTS.md"
              />
            </label>
          </div>
          <label class="grid gap-1.5 text-sm font-medium">
            {{ t('team.formName') }}
            <Input v-model="form.name" />
          </label>
          <label class="grid gap-1.5 text-sm font-medium">
            {{ t('team.formDescription') }}
            <Input v-model="form.description" />
          </label>
          <label class="grid gap-1.5 text-sm font-medium">
            {{ t('team.instructionContent') }}
            <textarea
              v-model="form.content"
              rows="16"
              class="w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </label>
        </form>
        <div class="flex items-center justify-end gap-2 border-t px-5 py-4">
          <p
            v-if="missingFields.length"
            class="mr-auto text-xs text-muted-foreground"
          >
            {{ t('team.formMissingFields', { fields: missingFields.join('、') }) }}
          </p>
          <Button
            variant="ghost"
            size="sm"
            class="cursor-pointer"
            @click="emit('close')"
          >
            {{ t('common.cancel') }}
          </Button>
          <Button
            size="sm"
            class="cursor-pointer"
            :disabled="missingFields.length > 0"
            :title="missingFields.length ? t('team.formMissingFields', { fields: missingFields.join('、') }) : undefined"
            :loading="props.busy"
            @click="submit"
          >
            {{ t('team.saveToChanges') }}
          </Button>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

<style scoped lang="scss">
.instruction-scroll {
  scrollbar-color: var(--scrollbar-thumb) transparent;
  scrollbar-width: thin;

  &::-webkit-scrollbar {
    width: 8px;
  }

  &::-webkit-scrollbar-track {
    background: transparent;
  }

  &::-webkit-scrollbar-thumb {
    background: var(--scrollbar-thumb);
    background-clip: padding-box;
    border: 2px solid transparent;
    border-radius: 999px;
  }
}
</style>
