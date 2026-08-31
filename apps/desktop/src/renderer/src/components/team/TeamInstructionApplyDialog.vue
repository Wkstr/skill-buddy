<script setup lang="ts">
import { computed, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { FolderGit2 } from '@lucide/vue'
import {
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
} from 'reka-ui'
import type { InstructionDocument, TeamLibraryInstructionSummary } from '#shared/ipc'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useSettings } from '@/composables/useSettings'
import { pathBasename } from '@/lib/paths'

const props = defineProps<{
  open: boolean
  instruction: TeamLibraryInstructionSummary | null
}>()
const emit = defineEmits<{
  'update:open': [open: boolean]
  apply: [target: { projectRoot: string; targetPath: string; expectedHash: string | null }]
}>()
const { t } = useI18n()
const { projectRoots } = useSettings()
const documents = shallowRef<InstructionDocument[]>([])
const loading = shallowRef(false)
const error = shallowRef('')

function joinPath(root: string, relative: string): string {
  const separator = root.includes('\\') ? '\\' : '/'
  return `${root.replace(/[\\/]$/, '')}${separator}${relative.replaceAll(/[\\/]/g, separator)}`
}

function normalize(path: string): string {
  return path.replaceAll('\\', '/')
}

const targets = computed(() => {
  const instruction = props.instruction
  if (!instruction) return []
  return projectRoots.value.map((projectRoot) => {
    const targetPath = joinPath(projectRoot, instruction.target)
    const document = documents.value.find((item) => normalize(item.path) === normalize(targetPath))
    const state = !document
      ? 'missing'
      : document.contentHash === instruction.contentHash
        ? 'satisfied'
        : 'outdated'
    const writable = !document
      || (!document.linked && !document.readOnly && !document.contentTruncated && !document.encodingInvalid)
    return { projectRoot, targetPath, state, writable, expectedHash: document?.contentHash ?? null }
  })
})

/** 每次打开都重新扫描，避免展示上一次打开时的陈旧状态。 */
watch(
  () => props.open,
  async (open) => {
    if (!open) return
    documents.value = []
    error.value = ''
    loading.value = true
    try {
      const scan = await window.skillsManager.scanProjectInstructions({
        projectRoots: [...projectRoots.value],
      })
      documents.value = scan.documents.filter((item) => item.scope === 'project')
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
    } finally {
      loading.value = false
    }
  },
)
</script>

<template>
  <DialogRoot
    :open="props.open"
    @update:open="(value) => emit('update:open', value)"
  >
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-40 bg-black/40" />
      <DialogContent
        class="fixed left-1/2 top-1/2 z-50 flex max-h-[80vh] w-[min(620px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border bg-background shadow-xl outline-none"
        @open-auto-focus.prevent
      >
        <header class="border-b px-5 py-4">
          <DialogTitle class="text-base font-semibold">
            {{ t('team.instructionApplyTitle') }}
          </DialogTitle>
          <DialogDescription class="mt-1 truncate text-sm text-muted-foreground">
            {{ props.instruction?.name }} · {{ props.instruction?.target }}
          </DialogDescription>
        </header>

        <ScrollArea
          class="min-h-0 flex-1"
          viewport-class="px-5 py-4"
        >
          <p
            v-if="error"
            class="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
          >
            {{ error }}
          </p>
          <p
            v-else-if="loading"
            class="py-6 text-center text-sm text-muted-foreground"
          >
            {{ t('team.instructionApplyLoading') }}
          </p>
          <p
            v-else-if="targets.length === 0"
            class="rounded-md border border-dashed py-10 text-center text-sm text-muted-foreground"
          >
            {{ t('team.projectDirectoriesEmpty') }}
          </p>
          <ul
            v-else
            class="divide-y overflow-hidden rounded-md border"
          >
            <li
              v-for="target in targets"
              :key="target.projectRoot"
              class="flex items-center gap-3 px-3 py-2.5"
            >
              <FolderGit2 class="size-4 shrink-0 text-muted-foreground" />
              <span class="min-w-0 flex-1">
                <span
                  class="block truncate text-sm font-medium"
                  :title="target.projectRoot"
                >
                  {{ pathBasename(target.projectRoot) }}
                </span>
                <span
                  class="block truncate font-mono text-xs text-muted-foreground"
                  :title="target.targetPath"
                >
                  {{ target.targetPath }}
                </span>
              </span>
              <Badge
                variant="outline"
                :class="target.state === 'satisfied'
                  ? 'border-emerald-500/50 text-emerald-700 dark:text-emerald-400'
                  : 'border-amber-500/50 text-amber-700 dark:text-amber-400'"
              >
                {{ t(`team.projectInstructionState.${target.state}`) }}
              </Badge>
              <Button
                variant="outline"
                size="sm"
                class="shrink-0 cursor-pointer"
                :disabled="target.state === 'satisfied' || !target.writable"
                :title="target.writable ? undefined : t('team.instructionApplyNotWritable')"
                @click="emit('apply', {
                  projectRoot: target.projectRoot,
                  targetPath: target.targetPath,
                  expectedHash: target.expectedHash,
                })"
              >
                {{ t('team.projectApplyInstruction') }}
              </Button>
            </li>
          </ul>
        </ScrollArea>

        <footer class="flex justify-end border-t px-5 py-3">
          <Button
            variant="ghost"
            size="sm"
            @click="emit('update:open', false)"
          >
            {{ t('common.close') }}
          </Button>
        </footer>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
