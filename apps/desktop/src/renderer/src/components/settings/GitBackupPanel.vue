<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { CloudDownload, CloudUpload, GitBranch } from '@lucide/vue'
import type { GitRestorePreview, InstallTarget } from '#shared/ipc'
import PlatformTargetPicker from '@/components/PlatformTargetPicker.vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useSettings } from '@/composables/useSettings'
import { useSkills } from '@/composables/useSkills'
import { showToast } from '@/composables/useToast'
import { mergePreset } from '@/lib/preset-format'
import { confirmDialog } from '@/composables/useConfirm'

const { t } = useI18n()
const { groups } = useSettings()
const { installSkill, refresh } = useSkills()

const remoteUrl = ref(localStorage.getItem('skm.backupRemote')?.replace(/^"|"$/g, '') ?? '')
const branch = ref(localStorage.getItem('skm.backupBranch')?.replace(/^"|"$/g, '') ?? 'main')
const busy = shallowRef(false)
const error = shallowRef<string | null>(null)
const preview = shallowRef<GitRestorePreview | null>(null)
const restoreTargets = ref<InstallTarget[]>([])

const canRun = computed(() => Boolean(remoteUrl.value.trim() && branch.value.trim() && !busy.value))
const instructionConflicts = computed(() =>
  preview.value?.instructions.filter((instruction) => instruction.state === 'conflict').length ?? 0,
)
const actionableInstructions = computed(() =>
  preview.value?.instructions.filter((instruction) =>
    instruction.state === 'create' || instruction.state === 'conflict',
  ).length ?? 0,
)
const canRestore = computed(() => {
  const snapshot = preview.value
  if (!snapshot || busy.value) return false
  if (snapshot.items.length > 0 && restoreTargets.value.length === 0) return false
  return snapshot.items.length > 0 || snapshot.presets.length > 0 || actionableInstructions.value > 0
})

function persistConnection(): void {
  localStorage.setItem('skm.backupRemote', JSON.stringify(remoteUrl.value.trim()))
  localStorage.setItem('skm.backupBranch', JSON.stringify(branch.value.trim()))
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function backup(): Promise<void> {
  if (!canRun.value) return
  busy.value = true
  error.value = null
  persistConnection()
  try {
    const result = await window.skillsManager.pushGitBackup({
      remoteUrl: remoteUrl.value,
      branch: branch.value,
      presets: groups.value.map((group) => ({ ...group, skills: [...group.skills] })),
    })
    showToast({
      message: result.committed
        ? t('settings.backupPushed', {
            skills: result.skills,
            presets: result.presets,
            instructions: result.instructions,
          })
        : t('settings.backupUnchanged'),
      type: result.committed ? 'success' : 'info',
    })
  } catch (cause) {
    error.value = message(cause)
  } finally {
    busy.value = false
  }
}

async function prepareRestore(): Promise<void> {
  if (!canRun.value) return
  busy.value = true
  error.value = null
  persistConnection()
  try {
    const previous = preview.value
    const next = await window.skillsManager.prepareGitRestore({
      remoteUrl: remoteUrl.value,
      branch: branch.value,
    })
    preview.value = next
    if (previous) await window.skillsManager.cleanupImport(previous.root)
  } catch (cause) {
    error.value = message(cause)
  } finally {
    busy.value = false
  }
}

onBeforeUnmount(() => {
  if (preview.value) void window.skillsManager.cleanupImport(preview.value.root)
})

async function restore(): Promise<void> {
  const snapshot = preview.value
  const targets = restoreTargets.value
  if (!snapshot || !canRestore.value) return
  const confirmed = await confirmDialog({
    title: t('settings.restoreConfirmTitle'),
    message: t('settings.restoreConfirmMsg', {
      skills: snapshot.items.length,
      presets: snapshot.presets.length,
      targets: targets.length,
      instructions: actionableInstructions.value,
      conflicts: instructionConflicts.value,
    }),
    confirmLabel: t('settings.restoreConfirmAction'),
    cancelLabel: t('common.cancel'),
    danger: true,
  })
  if (!confirmed) return

  busy.value = true
  error.value = null
  try {
    let completed = 0
    let instructionCompleted = 0
    const failures: string[] = []
    for (const item of snapshot.items) {
      const results = await installSkill(item.skill, targets, { refresh: false })
      completed += results.filter((result) => result.ok).length
      failures.push(
        ...results
          .filter((result) => !result.ok)
          .map((result) => result.error ?? '')
          .filter(Boolean),
      )
    }
    const instructionResults = await window.skillsManager.restoreGitInstructions({
      root: snapshot.root,
      overwriteConflicts: true,
    })
    instructionCompleted = instructionResults.filter((result) => result.ok && !result.skipped).length
    failures.push(
      ...instructionResults
        .filter((result) => !result.ok)
        .map((result) => result.error ?? '')
        .filter(Boolean),
    )
    let merged = groups.value
    for (const preset of snapshot.presets) merged = mergePreset(merged, preset).groups
    groups.value = merged
    await refresh({ silent: true })
    showToast.success(t('settings.restoreDone', {
      skills: completed,
      instructions: instructionCompleted,
    }))
    if (failures.length > 0) showToast.error(failures.join('；'))
    preview.value = null
  } catch (cause) {
    error.value = message(cause)
  } finally {
    await window.skillsManager.cleanupImport(snapshot.root)
    preview.value = null
    busy.value = false
  }
}
</script>

<template>
  <div class="space-y-4 rounded-xl border p-5">
    <div class="flex items-start gap-3">
      <GitBranch class="mt-0.5 size-5 shrink-0 text-muted-foreground" />
      <div class="min-w-0">
        <h3 class="text-sm font-medium">{{ t('settings.backupTitle') }}</h3>
        <p class="mt-0.5 text-sm text-muted-foreground">{{ t('settings.backupDesc') }}</p>
      </div>
    </div>
    <div class="grid gap-3 sm:grid-cols-[minmax(0,1fr)_8rem]">
      <label for="git-backup-remote" class="space-y-1.5 text-sm">
        <span class="text-muted-foreground">{{ t('settings.backupRemote') }}</span>
        <Input
          id="git-backup-remote"
          v-model="remoteUrl"
          :placeholder="t('settings.backupRemotePh')"
        />
      </label>
      <label for="git-backup-branch" class="space-y-1.5 text-sm">
        <span class="text-muted-foreground">{{ t('settings.backupBranch') }}</span>
        <Input id="git-backup-branch" v-model="branch" placeholder="main" />
      </label>
    </div>
    <p class="text-xs text-muted-foreground">{{ t('settings.backupSecurity') }}</p>
    <p v-if="error" class="break-words text-sm text-destructive">{{ error }}</p>
    <div class="flex flex-wrap gap-2">
      <Button class="cursor-pointer" size="sm" :disabled="!canRun" :loading="busy" @click="backup">
        <CloudUpload v-if="!busy" class="size-3.5" />
        {{ busy ? t('settings.backupWorking') : t('settings.backupAction') }}
      </Button>
      <Button
        class="cursor-pointer"
        variant="outline"
        size="sm"
        :disabled="!canRun"
        @click="prepareRestore"
      >
        <CloudDownload class="size-3.5" />
        {{ t('settings.restorePreviewAction') }}
      </Button>
    </div>

    <div v-if="preview" class="space-y-3 border-t pt-4">
      <p class="text-sm font-medium">{{ t('settings.restorePreviewTitle') }}</p>
      <p class="text-sm text-muted-foreground">
        {{
          t('settings.restorePreviewSummary', {
            date: new Date(preview.createdAt).toLocaleString(),
            skills: preview.items.length,
            presets: preview.presets.length,
            instructions: preview.instructions.length,
          })
        }}
      </p>
      <PlatformTargetPicker
        v-if="preview.items.length > 0"
        v-model="restoreTargets"
        :label="t('settings.restoreTargets')"
      />
      <div v-if="preview.instructions.length > 0" class="divide-y border-y">
        <div
          v-for="instruction in preview.instructions"
          :key="`${instruction.surface.vendorId}/${instruction.surface.productId}/${instruction.surface.surfaceId}/${instruction.fileName}`"
          class="flex items-start justify-between gap-4 py-2.5"
        >
          <div class="min-w-0">
            <p class="text-sm font-medium">
              {{ instruction.displayName }} · {{ instruction.fileName }}
            </p>
            <p class="truncate text-xs text-muted-foreground" :title="instruction.targetPath">
              {{ instruction.targetPath || instruction.error }}
            </p>
            <p v-if="instruction.error && instruction.targetPath" class="text-xs text-destructive">
              {{ instruction.error }}
            </p>
          </div>
          <span
            :class="[
              'shrink-0 text-xs',
              instruction.state === 'conflict' || instruction.state === 'blocked'
                ? 'text-destructive'
                : 'text-muted-foreground',
            ]"
          >
            {{ t(`settings.restoreInstructionState.${instruction.state}`) }}
          </span>
        </div>
      </div>
      <p v-if="instructionConflicts > 0" class="text-xs text-destructive">
        {{ t('settings.restoreInstructionConflict', { n: instructionConflicts }) }}
      </p>
      <Button
        class="cursor-pointer"
        variant="destructive"
        size="sm"
        :disabled="!canRestore"
        @click="restore"
      >
        {{ t('settings.restoreAction') }}
      </Button>
    </div>
  </div>
</template>
