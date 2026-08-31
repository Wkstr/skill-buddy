<script setup lang="ts">
import { shallowRef } from 'vue'
import { RefreshCw } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import TeamProjectComplianceItem from '@/components/team/TeamProjectComplianceItem.vue'
import InstructionWritePlanDialog from '@/components/instructions/InstructionWritePlanDialog.vue'
import { Button } from '@/components/ui/button'
import { useInstructionEditor } from '@/composables/useInstructionEditor'
import { useTeamLibraries } from '@/composables/useTeamLibraries'
import { showToast } from '@/composables/useToast'
import type {
  TeamProjectCompliance,
  TeamProjectInstructionTemplateRef,
} from '@/composables/useTeamProjects'

defineProps<{
  projects: TeamProjectCompliance[]
  loading: boolean
}>()
const emit = defineEmits<{ refresh: []; configure: [project: TeamProjectCompliance] }>()
const { t } = useI18n()
const { catalogs } = useTeamLibraries()
const {
  plan: templatePlan,
  applying: templateApplying,
  reviewTemplate,
  closePlan,
  applyPlan,
} = useInstructionEditor()
const preparing = shallowRef(false)

/** 目录不携带模板正文，应用前按需向团队库仓库读取一次。 */
async function handleApplyTemplate(template: TeamProjectInstructionTemplateRef): Promise<void> {
  if (preparing.value) return
  preparing.value = true
  try {
    const catalog = catalogs.value.find((item) => item.source.libraryId === template.libraryId)
    if (!catalog) throw new Error(t('team.projectApplyInstructionNoLibrary'))
    const instruction = await window.skillsManager.teamLibraryGetInstruction(
      { remoteUrl: catalog.source.remoteUrl, branch: catalog.source.branch },
      template.templatePath,
    )
    await reviewTemplate({
      projectRoot: template.projectRoot,
      targetPath: template.targetPath,
      content: instruction.content,
      expectedHash: template.expectedHash,
    })
  } catch (error) {
    showToast.error(error instanceof Error ? error.message : String(error))
  } finally {
    preparing.value = false
  }
}

async function handleApplyPlan(): Promise<void> {
  if (await applyPlan()) emit('refresh')
}
</script>

<template>
  <section class="flex flex-col gap-2">
    <div class="flex items-center justify-between gap-3">
      <h2 class="text-sm font-semibold">{{ t('team.projectComplianceTitle') }}</h2>
      <Button
        variant="ghost"
        size="icon"
        class="size-8 cursor-pointer"
        :title="t('team.projectRefresh')"
        :aria-label="t('team.projectRefresh')"
        :loading="loading"
        @click="emit('refresh')"
      >
        <RefreshCw v-if="!loading" class="size-4" />
      </Button>
    </div>
    <TeamProjectComplianceItem
      v-for="project in projects"
      :key="project.projectRoot"
      :project="project"
      @configure="emit('configure', $event)"
      @apply-template="handleApplyTemplate"
    />
    <InstructionWritePlanDialog
      :plan="templatePlan"
      :applying="templateApplying"
      @close="closePlan"
      @apply="handleApplyPlan"
    />
  </section>
</template>
