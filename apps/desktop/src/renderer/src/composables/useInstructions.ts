import { computed, effectScope, readonly, shallowReadonly, shallowRef, watch } from 'vue'
import type {
  EffectiveInstructionChain,
  InstructionDocument,
  InstructionRuleProfile,
  InstructionServiceScan,
} from '#shared/ipc'
import { useSettings } from './useSettings'

const scan = shallowRef<InstructionServiceScan | null>(null)
const loading = shallowRef(false)
const error = shallowRef('')
const selectedScope = shallowRef('global')
const selectedDocument = shallowRef<InstructionDocument | null>(null)
const selectedSurfaceKey = shallowRef('')
const targetDirectory = shallowRef('')
const content = shallowRef('')
const contentLoading = shallowRef(false)
const contentTruncated = shallowRef(false)
const chain = shallowRef<EffectiveInstructionChain | null>(null)
let refreshPromise: Promise<void> | null = null
let watchedRootsKey = ''

function profileKey(profile: InstructionRuleProfile): string {
  return `${profile.key.vendorId}/${profile.key.productId}/${profile.key.surfaceId}`
}

function createInstructionsStore() {
  const { projectRoots: registeredProjectRoots } = useSettings()

  const documents = computed(() => scan.value?.documents ?? [])
  const profiles = computed(() => scan.value?.profiles ?? [])
  const diagnostics = computed(() => scan.value?.diagnostics ?? [])
  const visibleDocuments = computed(() => documents.value.filter((document) =>
    selectedScope.value === 'global'
      ? document.scope === 'user'
      : document.scope === 'project' && document.projectRoot === selectedScope.value,
  ))
  const projectRoots = computed(() => scan.value?.scannedRoots ?? [])
  const projectCounts = computed(() => Object.fromEntries(projectRoots.value.map((root) => [
    root,
    documents.value.filter((document) => document.projectRoot === root).length,
  ])))
  const globalCount = computed(() => documents.value.filter((document) => document.scope === 'user').length)
  const selectedProfile = computed(() => profiles.value.find((profile) => profileKey(profile) === selectedSurfaceKey.value) ?? null)
  const projectFileNames = computed(() => [...new Set(profiles.value.flatMap((profile) => [
    ...profile.projectFileCandidates,
    ...profile.projectFallbacks,
    ...profile.localOverlayCandidates,
    ...(profile.overrideCandidates ?? []),
  ]).map((candidate) => candidate.split(/[\\/]/).at(-1)).filter((name): name is string => Boolean(name)))].sort())
  const availableGlobalPaths = computed(() => {
    const existing = new Set(documents.value.filter((document) => document.scope === 'user').map((document) => document.path))
    return [...new Set(profiles.value.flatMap((profile) => profile.globalPaths))]
      .filter((path) => !existing.has(path))
      .sort()
  })
  const targetDirectories = computed(() => {
    if (selectedScope.value === 'global') return []
    return (scan.value?.directories ?? [])
      .filter((directory) => directory.projectRoot === selectedScope.value)
      .map((directory) => directory.path)
      .sort((left, right) => left.localeCompare(right))
  })

  async function refresh(): Promise<void> {
    if (refreshPromise) return refreshPromise
    refreshPromise = refreshInternal()
    try {
      await refreshPromise
    } finally {
      refreshPromise = null
    }
  }

  async function refreshInternal(): Promise<void> {
    loading.value = true
    error.value = ''
    try {
      scan.value = await window.skillsManager.scanInstructions({ projectRoots: [...registeredProjectRoots.value] })
      if (!selectedSurfaceKey.value && scan.value.profiles[0]) selectedSurfaceKey.value = profileKey(scan.value.profiles[0])
      if (selectedScope.value !== 'global' && !projectRoots.value.includes(selectedScope.value)) selectedScope.value = 'global'
      if (selectedDocument.value && !scan.value.documents.some((item) => item.id === selectedDocument.value?.id)) {
        selectedDocument.value = null
        content.value = ''
      }
      const nextRootsKey = JSON.stringify([...registeredProjectRoots.value].sort())
      if (nextRootsKey !== watchedRootsKey) {
        await window.skillsManager.watchInstructionsStart([...registeredProjectRoots.value])
        watchedRootsKey = nextRootsKey
      }
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
    } finally {
      loading.value = false
    }
  }

  function selectScope(scope: string): void {
    selectedScope.value = scope
    selectedDocument.value = null
    content.value = ''
    contentTruncated.value = false
    chain.value = null
    if (scope !== 'global') targetDirectory.value = scope
  }

  function clearSelection(): void {
    selectedDocument.value = null
    content.value = ''
    contentTruncated.value = false
  }

  async function selectDocument(document: InstructionDocument): Promise<void> {
    selectedDocument.value = document
    contentLoading.value = true
    try {
      const result = await window.skillsManager.readInstruction({ path: document.path })
      content.value = result.content
      contentTruncated.value = result.truncated
      if (document.projectRoot) {
        selectedScope.value = document.projectRoot
        targetDirectory.value = document.relativeDirectory === '.'
          ? document.projectRoot
          : joinPath(document.projectRoot, document.relativeDirectory ?? '.')
      }
    } catch (cause) {
      content.value = ''
      contentTruncated.value = false
      error.value = cause instanceof Error ? cause.message : String(cause)
    } finally {
      contentLoading.value = false
    }
  }

  async function refreshChain(): Promise<void> {
    if (!selectedProfile.value || selectedScope.value === 'global' || !targetDirectory.value) {
      chain.value = null
      return
    }
    try {
      chain.value = await window.skillsManager.effectiveInstructionChain({
        surface: selectedProfile.value.key,
        projectRoot: selectedScope.value,
        targetDirectory: targetDirectory.value,
        includesGlobal: true,
      })
    } catch (cause) {
      chain.value = null
      error.value = cause instanceof Error ? cause.message : String(cause)
    }
  }

  window.skillsManager.onInstructionsChanged(() => void refresh())
  watch(registeredProjectRoots, () => void refresh(), { deep: true })
  watch([selectedSurfaceKey, targetDirectory, selectedScope], () => void refreshChain())

  return {
    scan: readonly(scan),
    loading: readonly(loading),
    error: readonly(error),
    selectedScope,
    selectedDocument: shallowReadonly(selectedDocument),
    selectedSurfaceKey,
    targetDirectory,
    content: readonly(content),
    contentLoading: readonly(contentLoading),
    contentTruncated: readonly(contentTruncated),
    chain: shallowReadonly(chain),
    documents,
    profiles,
    diagnostics,
    visibleDocuments,
    projectCounts,
    globalCount,
    projectRoots,
    targetDirectories,
    projectFileNames,
    availableGlobalPaths,
    refresh,
    selectScope,
    selectDocument,
    clearSelection,
    refreshChain,
    profileKey,
  }
}

type InstructionsStore = ReturnType<typeof createInstructionsStore>

let store: InstructionsStore | null = null

/**
 * 全局唯一的指令 store。
 *
 * store 内的 computed 与 watch 都创建在独立的 effect scope 中，不归属任何组件实例。
 * 否则它们会挂在首个调用方（当前是 DashboardPage）的 scope 上，一旦该组件被
 * `<KeepAlive :max="3">` 按 LRU 淘汰卸载，生效链刷新和项目根目录重扫就会永久失效。
 */
export function useInstructions(): InstructionsStore {
  store ??= effectScope(true).run(createInstructionsStore) ?? null
  if (!store) throw new Error('指令 store 初始化失败')
  return store
}

function joinPath(root: string, relativePath: string): string {
  const separator = root.includes('\\') ? '\\' : '/'
  return `${root.replace(/[\\/]$/, '')}${separator}${relativePath.replaceAll(/[\\/]/g, separator)}`
}
