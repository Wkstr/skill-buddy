<script setup lang="ts">
import { shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { Eye, Pencil, Save, X } from '@lucide/vue'
import MarkdownEditor from '@/components/MarkdownEditor.vue'
import MarkdownView from '@/components/MarkdownView.vue'
import { Button } from '@/components/ui/button'

const props = defineProps<{ path: string; dirty: boolean }>()
const emit = defineEmits<{ cancel: []; review: [] }>()
const draft = defineModel<string>({ default: '' })
const { t } = useI18n()
const viewMode = shallowRef<'edit' | 'preview'>('edit')
</script>

<template>
  <section class="flex min-w-0 flex-1 flex-col">
    <header class="flex h-14 shrink-0 items-center gap-3 border-b px-4">
      <Pencil class="size-4 shrink-0 text-muted-foreground" />
      <div class="min-w-0 flex-1">
        <div class="text-sm font-medium">
          {{ t('instructions.editor.title') }}
        </div>
        <div
          class="truncate text-xs text-muted-foreground"
          :title="props.path"
        >
          {{ props.path }}
        </div>
      </div>
      <div
        role="group"
        :aria-label="t('instructions.editor.viewMode')"
        class="flex h-8 items-center rounded-md border bg-muted/45 p-0.5"
      >
        <button
          type="button"
          :aria-pressed="viewMode === 'edit'"
          :class="[
            'flex h-6 items-center gap-1.5 rounded px-2.5 text-sm transition-colors',
            viewMode === 'edit'
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground',
          ]"
          @click="viewMode = 'edit'"
        >
          <Pencil class="size-3.5" />
          {{ t('common.edit') }}
        </button>
        <button
          type="button"
          :aria-pressed="viewMode === 'preview'"
          :class="[
            'flex h-6 items-center gap-1.5 rounded px-2.5 text-sm transition-colors',
            viewMode === 'preview'
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground',
          ]"
          @click="viewMode = 'preview'"
        >
          <Eye class="size-3.5" />
          {{ t('instructions.editor.preview') }}
        </button>
      </div>
      <Button
        variant="ghost"
        size="sm"
        @click="emit('cancel')"
      >
        <X class="size-4" />
        {{ t('common.cancel') }}
      </Button>
      <Button
        size="sm"
        :disabled="!props.dirty"
        @click="emit('review')"
      >
        <Save class="size-4" />
        {{ t('instructions.editor.review') }}
      </Button>
    </header>

    <div
      v-show="viewMode === 'edit'"
      class="min-h-0 flex-1 p-4"
    >
      <MarkdownEditor
        v-model="draft"
        height="100%"
      />
    </div>
    <div
      v-show="viewMode === 'preview'"
      class="instruction-scroll min-h-0 flex-1 overflow-y-auto px-6 py-5"
    >
      <MarkdownView
        :content="draft"
        preview-id="instruction-edit-preview"
      />
    </div>
  </section>
</template>
