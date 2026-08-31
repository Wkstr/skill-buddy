import { computed, readonly, shallowReadonly, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'
import type {
  InstructionDocument,
  InstructionOperationPlanView,
} from '#shared/ipc'
import { showToast } from './useToast'
import { useInstructions } from './useInstructions'
import { confirmDialog } from '@/composables/useConfirm'

const mode = shallowRef<'edit' | 'create' | null>(null)
const path = shallowRef('')
const baseContent = shallowRef('')
const draft = shallowRef('')
const expectedHash = shallowRef<string | null>(null)
const plan = shallowRef<InstructionOperationPlanView | null>(null)
const applying = shallowRef(false)

export function useInstructionEditor() {
  const { t } = useI18n()
  const instructions = useInstructions()
  const active = computed(() => mode.value !== null)
  const dirty = computed(() => mode.value === 'create' || draft.value !== baseContent.value)

  function startEdit(document: InstructionDocument, content: string): void {
    if (document.readOnly || document.linked || document.contentTruncated || document.encodingInvalid) return
    mode.value = 'edit'
    path.value = document.path
    baseContent.value = content
    draft.value = content
    expectedHash.value = document.contentHash
    plan.value = null
  }

  function startCreate(targetPath: string): void {
    mode.value = 'create'
    path.value = targetPath
    baseContent.value = ''
    draft.value = '# Project Instructions\n\n'
    expectedHash.value = null
    plan.value = null
  }

  function reset(): void {
    mode.value = null
    path.value = ''
    baseContent.value = ''
    draft.value = ''
    expectedHash.value = null
    plan.value = null
  }

  async function confirmDiscard(): Promise<boolean> {
    if (!active.value || !dirty.value) return true
    return confirmDialog({
      title: t('instructions.editor.discardTitle'),
      message: t('instructions.editor.discardMessage'),
      confirmLabel: t('instructions.editor.discardAction'),
      cancelLabel: t('common.cancel'),
      danger: true,
    })
  }

  async function cancel(): Promise<void> {
    if (await confirmDiscard()) reset()
  }

  async function reviewWrite(): Promise<void> {
    plan.value = await window.skillsManager.createInstructionWritePlan({
      projectRoots: [...instructions.projectRoots.value],
      path: path.value,
      content: draft.value,
      expectedHash: expectedHash.value,
    })
  }

  async function reviewDelete(document: InstructionDocument): Promise<void> {
    plan.value = await window.skillsManager.createInstructionDeletePlan({
      projectRoots: [...instructions.projectRoots.value],
      path: document.path,
      expectedHash: document.contentHash,
    })
  }

  /**
   * 团队模板落地：复用写入计划，用户在同一个预览对话框里确认差异，
   * 因此覆盖既有内容前一定看得到 diff，事后也能撤销。
   */
  async function reviewTemplate(template: {
    projectRoot: string
    targetPath: string
    content: string
    expectedHash: string | null
  }): Promise<void> {
    plan.value = await window.skillsManager.createInstructionWritePlan({
      projectRoots: [template.projectRoot],
      path: template.targetPath,
      content: template.content,
      expectedHash: template.expectedHash,
    })
  }

  async function reviewBridge(document: InstructionDocument): Promise<void> {
    plan.value = await window.skillsManager.createInstructionBridgePlan({
      projectRoots: [...instructions.projectRoots.value],
      sourcePath: document.path,
      expectedHash: document.contentHash,
    })
  }

  function closePlan(): void {
    plan.value = null
  }

  /** 返回是否真正写入成功，供调用方决定后续刷新。 */
  async function applyPlan(): Promise<boolean> {
    if (!plan.value) return false
    applying.value = true
    const intent = plan.value.intent
    const targetPath = plan.value.path
    try {
      const result = intent === 'bridge'
        ? await window.skillsManager.applyInstructionBridgePlan(plan.value.planId)
        : await window.skillsManager.applyInstructionPlan(plan.value.planId)
      if (!result.ok) throw new Error(result.error ?? t('instructions.editor.applyFailed'))
      plan.value = null
      reset()
      await instructions.refresh()
      if (intent === 'write' || intent === 'bridge') {
        const document = instructions.documents.value.find((item) => item.path === targetPath)
        if (document) await instructions.selectDocument(document)
      } else {
        instructions.clearSelection()
      }
      showToast.info(
        intent === 'delete'
          ? t('instructions.editor.deleted')
          : intent === 'bridge'
            ? t('instructions.editor.bridged')
            : t('instructions.editor.saved'),
        {
          actionLabel: t('common.undo'),
          duration: 10_000,
          onAction: async () => {
            const restored = await window.skillsManager.restoreInstructionOperation(result.operationId)
            if (!restored.some((item) => item.ok)) {
              showToast.error(restored[0]?.error ?? t('instructions.editor.restoreFailed'))
              return
            }
            await instructions.refresh()
            const document = instructions.documents.value.find((item) => item.path === targetPath)
            if (document) await instructions.selectDocument(document)
            showToast.success(t('common.restored'))
          },
        },
      )
      return true
    } catch (error) {
      showToast.error(error instanceof Error ? error.message : String(error))
      return false
    } finally {
      applying.value = false
    }
  }

  return {
    active,
    mode: readonly(mode),
    path: readonly(path),
    baseContent: readonly(baseContent),
    draft,
    dirty,
    plan: shallowReadonly(plan),
    applying: readonly(applying),
    startEdit,
    startCreate,
    confirmDiscard,
    cancel,
    discard: reset,
    reviewWrite,
    reviewDelete,
    reviewBridge,
    reviewTemplate,
    closePlan,
    applyPlan,
  }
}
