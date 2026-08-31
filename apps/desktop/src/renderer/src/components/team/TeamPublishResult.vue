<script setup lang="ts">
import { ExternalLink } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import type { DeepReadonly } from 'vue'
import type { TeamContributionPublishResult } from '#shared/ipc'
import { Button } from '@/components/ui/button'

const props = defineProps<{ result: DeepReadonly<TeamContributionPublishResult> | null }>()
const { t } = useI18n()

function openResult(): void {
  if (props.result?.url) void window.skillsManager.openLink(props.result.url)
}
</script>

<template>
  <div
    v-if="props.result"
    class="rounded-md border px-4 py-3 text-sm"
  >
    <p>{{ t('team.contributionPushed', { branch: props.result.branch }) }}</p>
    <p
      v-if="props.result.warning"
      class="mt-1 text-amber-700 dark:text-amber-400"
    >
      {{ props.result.warning }}
    </p>
    <Button
      v-if="props.result.url"
      variant="link"
      class="mt-1 h-auto cursor-pointer p-0"
      @click="openResult"
    >
      <ExternalLink />{{ t('team.contributionOpenRequest') }}
    </Button>
  </div>
</template>
