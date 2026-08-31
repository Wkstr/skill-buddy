<script setup lang="ts">
import { computed, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  DialogContent,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
} from 'reka-ui'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'

const props = defineProps<{
  open: boolean
  scope: string
  directories: string[]
  fileNames: string[]
  globalPaths: string[]
}>()
const emit = defineEmits<{
  'update:open': [open: boolean]
  create: [path: string]
}>()
const { t } = useI18n()
const directory = shallowRef('')
const fileName = shallowRef('AGENTS.md')
const globalPath = shallowRef('')

const projectScope = computed(() => props.scope !== 'global')
const directoryOptions = computed(() => props.directories.map((path) => ({
  value: path,
  label: path === props.scope ? '.' : path.slice(props.scope.length + 1),
})))
const fileOptions = computed(() => props.fileNames.map((value) => ({ value, label: value })))
const globalOptions = computed(() => props.globalPaths.map((value) => ({ value, label: value })))
const canCreate = computed(() => projectScope.value
  ? Boolean(directory.value && fileName.value)
  : Boolean(globalPath.value))

watch(
  () => props.open,
  (open) => {
    if (!open) return
    directory.value = props.directories.includes(props.scope) ? props.scope : (props.directories[0] ?? '')
    fileName.value = props.fileNames.includes('AGENTS.md') ? 'AGENTS.md' : (props.fileNames[0] ?? '')
    globalPath.value = props.globalPaths[0] ?? ''
  },
)

function joinPath(root: string, child: string): string {
  const separator = root.includes('\\') ? '\\' : '/'
  return `${root.replace(/[\\/]$/, '')}${separator}${child}`
}

function submit(): void {
  if (!canCreate.value) return
  emit('create', projectScope.value ? joinPath(directory.value, fileName.value) : globalPath.value)
  emit('update:open', false)
}
</script>

<template>
  <DialogRoot
    :open="props.open"
    @update:open="(open) => emit('update:open', open)"
  >
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-40 bg-black/40" />
      <DialogContent
        class="fixed left-1/2 top-1/2 z-50 w-[min(460px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-lg border bg-background p-5 shadow-xl outline-none"
        @open-auto-focus.prevent
      >
        <DialogTitle class="text-base font-semibold">
          {{ t('instructions.create.title') }}
        </DialogTitle>
        <div
          v-if="projectScope"
          class="mt-4 space-y-3"
        >
          <label class="block space-y-1.5 text-sm">
            <span class="text-muted-foreground">{{ t('instructions.create.directory') }}</span>
            <Select
              v-model="directory"
              :options="directoryOptions"
              class="w-full"
            />
          </label>
          <label class="block space-y-1.5 text-sm">
            <span class="text-muted-foreground">{{ t('instructions.create.fileName') }}</span>
            <Select
              v-model="fileName"
              :options="fileOptions"
              class="w-full"
            />
          </label>
        </div>
        <label
          v-else
          class="mt-4 block space-y-1.5 text-sm"
        >
          <span class="text-muted-foreground">{{ t('instructions.create.globalPath') }}</span>
          <Select
            v-model="globalPath"
            :options="globalOptions"
            class="w-full"
          />
        </label>
        <p
          v-if="!canCreate"
          class="mt-4 text-sm text-muted-foreground"
        >
          {{ t('instructions.create.unavailable') }}
        </p>
        <footer class="mt-5 flex justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            @click="emit('update:open', false)"
          >
            {{ t('common.cancel') }}
          </Button>
          <Button
            size="sm"
            :disabled="!canCreate"
            @click="submit"
          >
            {{ t('instructions.create.action') }}
          </Button>
        </footer>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
