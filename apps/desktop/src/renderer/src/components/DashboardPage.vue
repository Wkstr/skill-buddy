<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { Blocks, ChevronRight, FileCog, FolderGit2, MonitorCheck, TriangleAlert } from '@lucide/vue'
import { Card } from '@/components/ui/card'
import { useSettings } from '@/composables/useSettings'
import { useInstructions } from '@/composables/useInstructions'
import { useSkills } from '@/composables/useSkills'
import MarketDiscovery from '@/components/MarketDiscovery.vue'
import type { MarketItem } from '@/lib/market'

const emit = defineEmits<{
  openMarket: [item: MarketItem]
  openDrift: []
  openInstructions: []
}>()

const { skills, detectedPlatforms } = useSkills()
const { documents, refresh: refreshInstructions } = useInstructions()
const { projectRoots } = useSettings()
const { t } = useI18n()

const driftSkills = computed(() => skills.value.filter((s) => s.hasDrift))

const stats = computed(() => [
  {
    icon: FileCog,
    label: t('dashboard.instructionFiles'),
    desc: t('dashboard.instructionFilesDesc'),
    value: documents.value.length,
    tone: 'bg-rose-500/12 text-rose-600 dark:text-rose-400',
    action: 'instructions' as const,
  },
  {
    icon: Blocks,
    label: t('dashboard.totalSkills'),
    desc: t('dashboard.totalSkillsDesc'),
    value: skills.value.length,
    tone: 'bg-sky-500/12 text-sky-600 dark:text-sky-400',
  },
  {
    icon: MonitorCheck,
    label: t('dashboard.platformsDetected'),
    desc: t('dashboard.platformsDetectedDesc'),
    value: detectedPlatforms.value.length,
    tone: 'bg-emerald-500/12 text-emerald-600 dark:text-emerald-400',
  },
  {
    icon: TriangleAlert,
    label: t('dashboard.driftCount'),
    desc: t('dashboard.driftCountDesc'),
    value: driftSkills.value.length,
    tone: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
    warn: driftSkills.value.length > 0,
    action: 'drift' as const,
  },
  {
    icon: FolderGit2,
    label: t('dashboard.projectDirs'),
    desc: t('dashboard.projectDirsDesc'),
    value: projectRoots.value.length,
    tone: 'bg-violet-500/12 text-violet-600 dark:text-violet-400',
  },
])

const driftCardListeners = { click: () => emit('openDrift') }
const instructionCardListeners = { click: () => emit('openInstructions') }

onMounted(() => void refreshInstructions())
</script>

<template>
  <div class="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-6">
    <!-- stats -->
    <!--
      按容器可用宽度分列，而不是视口断点：断点看的是视口，但容器被 max-w 锁死，
      md:grid-cols-5 在窄窗口下会算出 ~118px 的列宽，把中文标题压成竖排。
      auto-fill 让宽度够时自然排满 5 列，不够时逐级降到 4/3/2 列；
      不用 auto-fit 是为了让落单的第 5 张保持正常宽度，而不是被拉伸成整行。
    -->
    <div class="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-3">
      <Card
        v-for="stat in stats"
        :key="stat.label"
        :class="[
          stat.action &&
            'group transition-[border-color,box-shadow] duration-150 hover:shadow-sm focus-within:ring-2',
          stat.action === 'drift' &&
            'hover:border-amber-500/45 focus-within:border-amber-500/45 focus-within:ring-amber-500/20',
          stat.action === 'instructions' &&
            'hover:border-rose-500/45 focus-within:border-rose-500/45 focus-within:ring-rose-500/20',
        ]"
      >
        <component
          :is="stat.action ? 'button' : 'div'"
          :type="stat.action ? 'button' : undefined"
          :class="[
            'flex w-full flex-col gap-2 rounded-lg p-4 text-left outline-none',
            stat.action && 'cursor-pointer',
          ]"
          v-on="stat.action === 'drift'
            ? driftCardListeners
            : stat.action === 'instructions'
              ? instructionCardListeners
              : {}"
        >
          <span class="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
            <span
              :class="[
                'flex size-9 shrink-0 items-center justify-center rounded-full',
                stat.tone,
              ]"
            >
              <component :is="stat.icon" class="size-4" />
            </span>
            <!--
              min-w-20 让标题在放不下时整体换行到第二行，而不是被压缩到 min-content。
              中文没有空格断点，min-content 等于单字宽，压缩的结果就是逐字竖排。
            -->
            <span class="min-w-20 flex-1 text-sm font-semibold leading-tight">{{ stat.label }}</span>
            <ChevronRight
              v-if="stat.action"
              :class="[
                'ml-auto size-4 shrink-0 text-muted-foreground transition-colors',
                stat.action === 'drift'
                  ? 'group-hover:text-amber-600 group-focus-within:text-amber-600 dark:group-hover:text-amber-400 dark:group-focus-within:text-amber-400'
                  : 'group-hover:text-rose-600 group-focus-within:text-rose-600 dark:group-hover:text-rose-400 dark:group-focus-within:text-rose-400',
              ]"
            />
          </span>
          <span
            :class="[
              'text-3xl font-bold tabular-nums tracking-tight',
              stat.warn && 'text-amber-600 dark:text-amber-400',
            ]"
          >
            {{ stat.value }}
          </span>
          <span class="text-sm text-muted-foreground">{{ stat.desc }}</span>
        </component>
      </Card>
    </div>

    <!-- marketplace discovery -->
    <MarketDiscovery @open="emit('openMarket', $event)" />
  </div>
</template>
