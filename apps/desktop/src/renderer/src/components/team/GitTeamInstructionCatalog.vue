<script setup lang="ts">
import { shallowRef } from 'vue'
import { FileCog, Settings2, Upload } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import type { TeamLibraryInstructionSummary } from '#shared/ipc'
import TeamInstructionApplyDialog from '@/components/team/TeamInstructionApplyDialog.vue'
import InstructionWritePlanDialog from '@/components/instructions/InstructionWritePlanDialog.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useInstructionEditor } from '@/composables/useInstructionEditor'
import { useTeamLibraries } from '@/composables/useTeamLibraries'
import { showToast } from '@/composables/useToast'

const emit = defineEmits<{ manage: [] }>()
const { instructions, catalogs } = useTeamLibraries()
const { t } = useI18n()
const {
  plan: templatePlan,
  applying: templateApplying,
  reviewTemplate,
  closePlan,
  applyPlan,
} = useInstructionEditor()
const applyOpen = shallowRef(false)
const applyTarget = shallowRef<TeamLibraryInstructionSummary | null>(null)
const preparing = shallowRef(false)

function openApply(item: TeamLibraryInstructionSummary): void {
  applyTarget.value = item
  applyOpen.value = true
}

/** 目录不携带模板正文，选定项目后按需向团队库仓库读取一次。 */
async function handleApply(target: {
  projectRoot: string
  targetPath: string
  expectedHash: string | null
}): Promise<void> {
  const item = applyTarget.value
  if (!item || preparing.value) return
  preparing.value = true
  try {
    const catalog = catalogs.value.find((entry) => entry.source.libraryId === item.libraryId)
    if (!catalog) throw new Error(t('team.projectApplyInstructionNoLibrary'))
    const instruction = await window.skillsManager.teamLibraryGetInstruction(
      { remoteUrl: catalog.source.remoteUrl, branch: catalog.source.branch },
      item.path,
    )
    applyOpen.value = false
    await reviewTemplate({
      projectRoot: target.projectRoot,
      targetPath: target.targetPath,
      content: instruction.content,
      expectedHash: target.expectedHash,
    })
  } catch (error) {
    showToast.error(error instanceof Error ? error.message : String(error))
  } finally {
    preparing.value = false
  }
}
</script>

<template>
  <section class="flex flex-col gap-3">
    <div
      v-if="instructions.length === 0"
      class="flex flex-col items-center gap-3 rounded-md border border-dashed py-12 text-center"
    >
      <p class="text-sm text-muted-foreground">
        {{ t('team.instructionTemplateEmpty') }}
      </p>
      <Button
        variant="outline"
        size="sm"
        class="cursor-pointer"
        @click="emit('manage')"
      >
        <Settings2 class="size-4" />
        {{ t('team.instructionTemplateGoCreate') }}
      </Button>
    </div>
    <ul
      v-else
      class="divide-y overflow-hidden rounded-md border"
    >
      <li
        v-for="item in instructions"
        :key="`${item.libraryId}:${item.path}`"
        class="flex items-start gap-3 px-4 py-3"
      >
        <FileCog class="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <span class="min-w-0 flex-1">
          <span class="flex items-center gap-2">
            <span class="truncate text-sm font-medium">{{ item.name }}</span>
            <Badge
              v-if="item.version"
              variant="secondary"
            >
              v{{ item.version }}
            </Badge>
          </span>
          <span class="mt-0.5 block text-sm text-muted-foreground">{{ item.description }}</span>
          <span
            class="mt-1 block truncate font-mono text-xs text-muted-foreground"
            :title="`${item.libraryName} · ${item.path}`"
          >
            {{ item.target }} · {{ item.libraryName }} · {{ item.path }}
          </span>
        </span>
        <Button
          variant="outline"
          size="sm"
          class="shrink-0 cursor-pointer self-center"
          :title="t('team.instructionApplyHint')"
          @click="openApply(item)"
        >
          <Upload class="size-3.5" />
          {{ t('team.instructionApplyAction') }}
        </Button>
      </li>
    </ul>

    <TeamInstructionApplyDialog
      v-model:open="applyOpen"
      :instruction="applyTarget"
      @apply="handleApply"
    />
    <InstructionWritePlanDialog
      :plan="templatePlan"
      :applying="templateApplying"
      @close="closePlan"
      @apply="applyPlan"
    />
  </section>
</template>
