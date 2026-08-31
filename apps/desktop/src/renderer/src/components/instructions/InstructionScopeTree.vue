<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ChevronDown, ChevronRight, FileText, FolderGit2, Globe2, Link2, LockKeyhole } from '@lucide/vue'
import type { InstructionDocument } from '#shared/ipc'

const props = defineProps<{
  documents: InstructionDocument[]
  projects: string[]
  selectedScope: string
  selectedId?: string
  projectCounts: Record<string, number>
  globalCount: number
}>()
const emit = defineEmits<{
  selectScope: [scope: string]
  selectDocument: [document: InstructionDocument]
}>()

const expanded = ref(new Set<string>(['global']))

const scopes = computed(() => [
  { key: 'global', label: 'instructions.global', count: props.globalCount, icon: Globe2 },
  ...props.projects.map((project) => ({
    key: project,
    label: project,
    count: props.projectCounts[project] ?? 0,
    icon: FolderGit2,
  })),
])

watch(() => props.selectedScope, (scope) => {
  expanded.value = new Set([...expanded.value, scope])
}, { immediate: true })

function name(path: string): string {
  return path.replaceAll('\\', '/').split('/').filter(Boolean).at(-1) ?? path
}

function documentsFor(scope: string): InstructionDocument[] {
  return props.documents.filter((document) =>
    scope === 'global' ? document.scope === 'user' : document.scope === 'project' && document.projectRoot === scope,
  )
}

function toggle(scope: string): void {
  const next = new Set(expanded.value)
  if (next.has(scope)) next.delete(scope)
  else next.add(scope)
  expanded.value = next
}

function selectScope(scope: string): void {
  emit('selectScope', scope)
  if (!expanded.value.has(scope)) toggle(scope)
}
</script>

<template>
  <section class="instruction-scroll flex w-72 shrink-0 flex-col overflow-y-auto border-r bg-muted/15">
    <div class="space-y-0.5 p-2">
      <section
        v-for="scope in scopes"
        :key="scope.key"
      >
        <button
          type="button"
          class="flex w-full cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors hover:bg-accent/60"
          :class="props.selectedScope === scope.key ? 'nav-active' : ''"
          :title="scope.key === 'global' ? $t(scope.label) : scope.label"
          @click="selectScope(scope.key)"
        >
          <component
            :is="expanded.has(scope.key) ? ChevronDown : ChevronRight"
            class="size-3.5 shrink-0 text-muted-foreground"
            @click.stop="toggle(scope.key)"
          />
          <component
            :is="scope.icon"
            class="size-4 shrink-0 text-muted-foreground"
          />
          <span class="min-w-0 flex-1 truncate">
            {{ scope.key === 'global' ? $t(scope.label) : name(scope.label) }}
          </span>
          <span class="text-xs tabular-nums text-muted-foreground">{{ scope.count }}</span>
        </button>
        <div
          v-if="expanded.has(scope.key)"
          class="ml-5 mt-2 space-y-0.5 border-l pl-1"
        >
          <button
            v-for="document in documentsFor(scope.key)"
            :key="document.id"
            type="button"
            :class="[
              'flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
              props.selectedId === document.id ? 'nav-active' : 'hover:bg-accent/60',
            ]"
            :title="document.path"
            @click="emit('selectDocument', document)"
          >
            <FileText class="size-3.5 shrink-0 text-muted-foreground" />
            <span class="min-w-0 flex-1 truncate">{{ document.fileName }}</span>
            <Link2
              v-if="document.linked"
              class="size-3.5 shrink-0 text-muted-foreground"
              :title="$t('instructions.linked')"
            />
            <LockKeyhole
              v-if="document.readOnly"
              class="size-3.5 shrink-0 text-muted-foreground"
              :title="$t('instructions.readOnly')"
            />
          </button>
          <div
            v-if="documentsFor(scope.key).length === 0"
            class="px-2 py-1.5 text-xs text-muted-foreground"
          >
            {{ $t('instructions.empty') }}
          </div>
        </div>
      </section>
    </div>
  </section>
</template>
