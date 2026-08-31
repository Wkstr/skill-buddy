<script setup lang="ts">
import { onMounted, shallowRef } from 'vue'
import { Plus, RefreshCw } from '@lucide/vue'
import InstructionCreateDialog from './InstructionCreateDialog.vue'
import InstructionDetail from './InstructionDetail.vue'
import InstructionEditor from './InstructionEditor.vue'
import InstructionScopeTree from './InstructionScopeTree.vue'
import InstructionWritePlanDialog from './InstructionWritePlanDialog.vue'
import { Button } from '@/components/ui/button'
import SidebarToggle from '@/components/SidebarToggle.vue'
import { useInstructionEditor } from '@/composables/useInstructionEditor'
import { useInstructions } from '@/composables/useInstructions'

const props = defineProps<{ inset?: boolean }>()
const {
  loading,
  error,
  diagnostics,
  selectedScope,
  selectedDocument,
  selectedSurfaceKey,
  targetDirectory,
  targetDirectories,
  content,
  contentLoading,
  contentTruncated,
  chain,
  profiles,
  visibleDocuments,
  documents,
  projectCounts,
  globalCount,
  projectRoots,
  projectFileNames,
  availableGlobalPaths,
  refresh,
  selectScope,
  selectDocument,
} = useInstructions()
const {
  active: editorActive,
  path: editorPath,
  draft: editorDraft,
  dirty: editorDirty,
  plan: editorPlan,
  applying: editorApplying,
  startEdit,
  startCreate,
  confirmDiscard,
  cancel: cancelEditor,
  discard: discardEditor,
  reviewWrite,
  reviewDelete,
  reviewBridge,
  closePlan,
  applyPlan,
} = useInstructionEditor()
const createOpen = shallowRef(false)

async function handleSelectScope(scope: string): Promise<void> {
  if (!(await confirmDiscard())) return
  discardEditor()
  selectScope(scope)
}

async function handleSelectDocument(document: Parameters<typeof selectDocument>[0]): Promise<void> {
  if (!(await confirmDiscard())) return
  discardEditor()
  await selectDocument(document)
}

async function openCreate(): Promise<void> {
  if (!(await confirmDiscard())) return
  discardEditor()
  createOpen.value = true
}

function handleCreate(path: string): void {
  startCreate(path)
}

function handleEdit(): void {
  if (selectedDocument.value) startEdit(selectedDocument.value, content.value)
}

async function handleDelete(): Promise<void> {
  if (selectedDocument.value) await reviewDelete(selectedDocument.value)
}

async function handleBridge(sourcePath?: string): Promise<void> {
  const source = sourcePath
    ? visibleDocuments.value.find((document) => document.path === sourcePath)
    : selectedDocument.value?.fileName === 'AGENTS.md'
    ? selectedDocument.value
    : visibleDocuments.value.find((document) =>
        document.fileName === 'AGENTS.md'
        && document.path.replace(/[\\/]AGENTS\.md$/, '') === targetDirectory.value,
      )
  if (source) await reviewBridge(source)
}

onMounted(() => void refresh())
</script>

<template>
  <div class="flex h-full flex-col">
    <header :class="['app-drag flex h-14 shrink-0 items-center gap-3 border-b px-5', props.inset && 'pl-[118px]']">
      <SidebarToggle />
      <div>
        <h1 class="text-sm font-semibold">
          {{ $t('instructions.title') }}
        </h1>
        <p class="text-xs text-muted-foreground">
          {{ $t('instructions.subtitle') }}
        </p>
      </div>
      <div class="flex-1" />
      <Button
        variant="outline"
        size="sm"
        class="app-no-drag"
        :title="$t('instructions.create.action')"
        @click="openCreate"
      >
        <Plus class="size-4" />
        {{ $t('instructions.create.action') }}
      </Button>
      <Button
        variant="outline"
        size="sm"
        class="app-no-drag"
        :loading="loading"
        :title="$t('instructions.refresh')"
        @click="refresh"
      >
        <RefreshCw
          v-if="!loading"
          class="size-4"
        />
      </Button>
    </header>

    <div
      v-if="error"
      class="border-b bg-destructive/8 px-5 py-2 text-sm text-destructive"
    >
      {{ error }}
    </div>
    <div class="flex min-h-0 flex-1">
      <InstructionScopeTree
        :documents="documents"
        :projects="projectRoots"
        :selected-scope="selectedScope"
        :selected-id="selectedDocument?.id"
        :project-counts="projectCounts"
        :global-count="globalCount"
        @select-scope="handleSelectScope"
        @select-document="handleSelectDocument"
      />
      <InstructionEditor
        v-if="editorActive"
        v-model="editorDraft"
        :path="editorPath"
        :dirty="editorDirty"
        @cancel="cancelEditor"
        @review="reviewWrite"
      />
      <InstructionDetail
        v-else
        :document="selectedDocument"
        :content="content"
        :content-loading="contentLoading"
        :content-truncated="contentTruncated"
        :profiles="profiles"
        :surface-key="selectedSurfaceKey"
        :target-directory="targetDirectory"
        :target-directories="targetDirectories"
        :project-root="selectedScope === 'global' ? undefined : selectedScope"
        :project-scope="selectedScope !== 'global'"
        :chain="chain"
        :diagnostics="diagnostics"
        @update:surface-key="selectedSurfaceKey = $event"
        @update:target-directory="targetDirectory = $event"
        @edit="handleEdit"
        @delete="handleDelete"
        @bridge="handleBridge"
      />
    </div>
    <InstructionCreateDialog
      v-model:open="createOpen"
      :scope="selectedScope"
      :directories="targetDirectories"
      :file-names="projectFileNames"
      :global-paths="availableGlobalPaths"
      @create="handleCreate"
    />
    <InstructionWritePlanDialog
      :plan="editorPlan"
      :applying="editorApplying"
      @close="closePlan"
      @apply="applyPlan"
    />
  </div>
</template>

<style scoped lang="scss">
:deep(.instruction-scroll) {
  scrollbar-color: var(--scrollbar-thumb) transparent;
  scrollbar-width: thin;

  &::-webkit-scrollbar {
    width: 8px;
    height: 8px;
  }

  &::-webkit-scrollbar-track {
    background: transparent;
  }

  &::-webkit-scrollbar-thumb {
    background: var(--scrollbar-thumb);
    background-clip: padding-box;
    border: 2px solid transparent;
    border-radius: 999px;

    &:hover {
      background: var(--scrollbar-thumb-hover);
      background-clip: padding-box;
    }
  }
}
</style>
