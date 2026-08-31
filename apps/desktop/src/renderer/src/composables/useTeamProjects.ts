import { computed, readonly, shallowRef, watch, type DeepReadonly } from 'vue'
import type {
  InstructionDocument,
  TeamLibraryBundleSummary,
  TeamLibraryCatalog,
  TeamLibraryInstallRecord,
  TeamLibraryInstructionSummary,
  TeamLibraryMcpSummary,
  TeamLibrarySkillSummary,
  TeamLibraryPolicy,
  TeamProjectConfig,
  TeamProjectConfigResult,
} from '#shared/ipc'
import { blockedTeamAssetReason, emptyTeamPolicy, mergeTeamPolicies } from '#shared/team-policy'
import { useSettings } from './useSettings'
import { useTeamLibraries } from './useTeamLibraries'
import { setTeamProjectAttentionCount } from './useAttentionCounters'

export type TeamProjectRequirementType = 'bundle' | 'skill' | 'mcp' | 'instruction'
export type TeamProjectRequirementState = 'satisfied' | 'missing' | 'outdated' | 'unresolved' | 'blocked'

export interface TeamProjectRequirementStatus {
  type: TeamProjectRequirementType
  ref: string
  label: string
  state: TeamProjectRequirementState
  reason?: 'unresolved-ref' | 'bundle-missing-members' | 'bundle-incomplete' | 'blocked-policy'
  detail?: number
  policyReason?: string
  recommended?: boolean
  /** 仅指令模板：可直接写入项目时携带定位信息，供“应用模板”使用。 */
  template?: TeamProjectInstructionTemplateRef
}

export interface TeamProjectInstructionTemplateRef {
  libraryId: string
  templatePath: string
  projectRoot: string
  targetPath: string
  /** 目标文件当前内容哈希；文件不存在时为 null。 */
  expectedHash: string | null
}

export interface TeamProjectCompliance {
  projectRoot: string
  configPath: string
  found: boolean
  config?: TeamProjectConfig
  error?: string
  requirements: TeamProjectRequirementStatus[]
  satisfied: number
  missing: number
  outdated: number
  unresolved: number
  blocked: number
  recommended: number
}

const projectConfigs = shallowRef<TeamProjectConfigResult[]>([])
const loading = shallowRef(false)
const instructionDocuments = shallowRef<InstructionDocument[]>([])
let initialized = false
let attentionCountWired = false

function normalizedPath(value: string | undefined): string {
  if (!value) return ''
  const normalized = value.replaceAll('\\', '/').replace(/\/+$/, '')
  return /^[A-Za-z]:/.test(normalized) ? normalized.toLowerCase() : normalized
}

function splitRef(ref: string, fallbackLibrary?: string): { libraryId?: string; value: string } {
  const separator = ref.indexOf(':')
  if (separator > 0) {
    return { libraryId: ref.slice(0, separator), value: ref.slice(separator + 1) }
  }
  return { libraryId: fallbackLibrary, value: ref }
}

function qualifiedRef(libraryId: string, ref: string): string {
  return ref.includes(':') ? ref : `${libraryId}:${ref}`
}

function qualifyPolicy(policy: DeepReadonly<TeamLibraryPolicy>, libraryId: string): TeamLibraryPolicy {
  return {
    required: {
      skills: policy.required.skills.map((ref) => qualifiedRef(libraryId, ref)),
      mcp: policy.required.mcp.map((ref) => qualifiedRef(libraryId, ref)),
      instructions: policy.required.instructions.map((ref) => qualifiedRef(libraryId, ref)),
    },
    recommended: {
      skills: policy.recommended.skills.map((ref) => qualifiedRef(libraryId, ref)),
      mcp: policy.recommended.mcp.map((ref) => qualifiedRef(libraryId, ref)),
      instructions: policy.recommended.instructions.map((ref) => qualifiedRef(libraryId, ref)),
    },
    blocked: policy.blocked.map((item) => ({
      ...item,
      ref: qualifiedRef(libraryId, item.ref),
    })),
  }
}

function effectivePolicy(
  config: TeamProjectConfig,
  catalogs: readonly DeepReadonly<TeamLibraryCatalog>[],
): TeamLibraryPolicy {
  const policies: TeamLibraryPolicy[] = catalogs
    .filter((catalog) => !config.library || catalog.source.libraryId === config.library)
    .map((catalog) => qualifyPolicy(catalog.policy, catalog.source.libraryId))
  for (const teamRef of config.teams) {
    const parsed = splitRef(teamRef, config.library)
    const matches = catalogs.filter((catalog) =>
      (!parsed.libraryId || catalog.source.libraryId === parsed.libraryId) &&
      catalog.teamPolicies[parsed.value],
    )
    if (matches.length !== 1) continue
    const catalog = matches[0]!
    policies.push(qualifyPolicy(catalog.teamPolicies[parsed.value]!, catalog.source.libraryId))
  }
  if (config.policy) {
    policies.push(config.library ? qualifyPolicy(config.policy, config.library) : config.policy)
  }
  return policies.length > 0 ? mergeTeamPolicies(...policies) : emptyTeamPolicy()
}

function uniqueMatch<T>(items: T[]): T | null {
  return items.length === 1 ? items[0]! : null
}

interface ResourceIndex<T extends { libraryId: string }> {
  byQualifiedKey: Map<string, T[]>
  byValue: Map<string, T[]>
}

interface ComplianceIndexes {
  skills: ResourceIndex<TeamLibrarySkillSummary>
  mcpServers: ResourceIndex<TeamLibraryMcpSummary>
  bundles: ResourceIndex<TeamLibraryBundleSummary>
  instructions: ResourceIndex<TeamLibraryInstructionSummary>
  installations: Map<string, TeamLibraryInstallRecord[]>
}

function createResourceIndex<T extends { libraryId: string }>(): ResourceIndex<T> {
  return { byQualifiedKey: new Map(), byValue: new Map() }
}

function addResourceIndex<T extends { libraryId: string }>(
  index: ResourceIndex<T>,
  item: T,
  values: readonly string[],
): void {
  for (const value of new Set(values)) {
    const qualifiedKey = `${item.libraryId}:${value}`
    const qualifiedItems = index.byQualifiedKey.get(qualifiedKey) ?? []
    qualifiedItems.push(item)
    index.byQualifiedKey.set(qualifiedKey, qualifiedItems)

    const items = index.byValue.get(value) ?? []
    items.push(item)
    index.byValue.set(value, items)
  }
}

function resolveIndexed<T extends { libraryId: string }>(
  ref: string,
  library: string | undefined,
  index: ResourceIndex<T>,
): T | null {
  const parsed = splitRef(ref, library)
  const items = parsed.libraryId
    ? index.byQualifiedKey.get(`${parsed.libraryId}:${parsed.value}`) ?? []
    : index.byValue.get(parsed.value) ?? []
  return uniqueMatch(items)
}

function installationKey(
  type: TeamLibraryInstallRecord['type'],
  libraryId: string,
  path: string,
  projectRoot: string,
): string {
  return `${type}:${libraryId}:${path}:${normalizedPath(projectRoot)}`
}

function buildComplianceIndexes(
  skills: readonly TeamLibrarySkillSummary[],
  mcpServers: readonly TeamLibraryMcpSummary[],
  bundles: readonly TeamLibraryBundleSummary[],
  instructions: readonly TeamLibraryInstructionSummary[],
  installations: readonly TeamLibraryInstallRecord[],
): ComplianceIndexes {
  const indexes: ComplianceIndexes = {
    skills: createResourceIndex(),
    mcpServers: createResourceIndex(),
    bundles: createResourceIndex(),
    instructions: createResourceIndex(),
    installations: new Map(),
  }
  for (const item of skills) addResourceIndex(indexes.skills, item, [item.path, item.name])
  for (const item of mcpServers) addResourceIndex(indexes.mcpServers, item, [item.path, item.name])
  for (const item of bundles) {
    addResourceIndex(indexes.bundles, item, [item.id, item.path, item.name])
  }
  for (const item of instructions) {
    addResourceIndex(indexes.instructions, item, [item.id, item.path, item.name])
  }
  for (const record of installations) {
    const projectRoot = record.target.projectRoot
    const isProjectTarget = record.type === 'skill'
      ? record.target.scope === 'project'
      : record.target.scope !== 'user'
    if (!isProjectTarget || !projectRoot) continue
    const key = installationKey(record.type, record.libraryId, record.path, projectRoot)
    const records = indexes.installations.get(key) ?? []
    records.push(record)
    indexes.installations.set(key, records)
  }
  return indexes
}

function instructionStatus(
  ref: string,
  config: TeamProjectConfig,
  projectRoot: string,
  indexes: ComplianceIndexes,
  policy: TeamLibraryPolicy,
  recommended = false,
): TeamProjectRequirementStatus {
  const resource = resolveIndexed(ref, config.library, indexes.instructions)
  if (!resource) {
    return {
      type: 'instruction',
      ref,
      label: ref,
      state: 'unresolved',
      reason: 'unresolved-ref',
      ...(recommended ? { recommended: true } : {}),
    }
  }
  const policyReason = blockedTeamAssetReason(
    policy,
    `${resource.libraryId}:${resource.path}`,
    resource.version,
  )
  if (policyReason) {
    return {
      type: 'instruction',
      ref,
      label: resource.name,
      state: 'blocked',
      reason: 'blocked-policy',
      policyReason,
      ...(recommended ? { recommended: true } : {}),
    }
  }
  const targetPath = `${projectRoot.replace(/[\\/]$/, '')}/${resource.target.replaceAll('\\', '/')}`
  const document = instructionDocuments.value.find((item) =>
    normalizedPath(item.path) === normalizedPath(targetPath),
  )
  const state = !document
    ? 'missing'
    : document.contentHash === resource.contentHash
      ? 'satisfied'
      : 'outdated'
  /**
   * 只有可安全写入的目标才提供“应用模板”：链接文件、只读文件、超限文件
   * 都交给指令页处理，避免在团队页给出一个必然被计划拦下的按钮。
   */
  const writable = !document
    || (!document.linked && !document.readOnly && !document.contentTruncated && !document.encodingInvalid)
  return {
    type: 'instruction',
    ref,
    label: resource.name,
    state,
    ...(recommended ? { recommended: true } : {}),
    ...(state !== 'satisfied' && writable
      ? {
          template: {
            libraryId: resource.libraryId,
            templatePath: resource.path,
            projectRoot,
            targetPath,
            expectedHash: document?.contentHash ?? null,
          },
        }
      : {}),
  }
}

function resourceState(
  resource: TeamLibrarySkillSummary | TeamLibraryMcpSummary,
  projectRoot: string,
  indexes: ComplianceIndexes,
): TeamProjectRequirementState {
  const records = indexes.installations.get(
    installationKey(resource.type, resource.libraryId, resource.path, projectRoot),
  ) ?? []
  if (records.length === 0) return 'missing'
  if (records.some((record) => record.status === 'current')) return 'satisfied'
  if (records.some((record) => record.status === 'outdated')) return 'outdated'
  if (records.every((record) => record.status === 'missing')) return 'missing'
  const current = records.some((record) =>
    record.type === 'skill' && resource.type === 'skill'
      ? record.contentHash === resource.contentHash
      : record.type === 'mcp' && resource.type === 'mcp'
        ? record.definitionHash === resource.definitionHash
        : false,
  )
  return current ? 'satisfied' : 'outdated'
}

function directStatus(
  type: 'skill' | 'mcp',
  ref: string,
  config: TeamProjectConfig,
  projectRoot: string,
  indexes: ComplianceIndexes,
  policy: TeamLibraryPolicy,
): TeamProjectRequirementStatus {
  const resource = type === 'skill'
    ? resolveIndexed(ref, config.library, indexes.skills)
    : resolveIndexed(ref, config.library, indexes.mcpServers)
  if (!resource) {
    return { type, ref, label: ref, state: 'unresolved', reason: 'unresolved-ref' }
  }
  const policyReason = blockedTeamAssetReason(
    policy,
    `${resource.libraryId}:${resource.path}`,
    resource.version,
  )
  if (policyReason) {
    return {
      type,
      ref,
      label: resource.name,
      state: 'blocked',
      reason: 'blocked-policy',
      policyReason,
    }
  }
  return {
    type,
    ref,
    label: resource.name,
    state: resourceState(resource, projectRoot, indexes),
  }
}

function bundleStatus(
  ref: string,
  config: TeamProjectConfig,
  projectRoot: string,
  indexes: ComplianceIndexes,
  policy: TeamLibraryPolicy,
): TeamProjectRequirementStatus {
  const bundle = resolveIndexed(ref, config.library, indexes.bundles)
  if (!bundle) {
    return { type: 'bundle', ref, label: ref, state: 'unresolved', reason: 'unresolved-ref' }
  }
  if (bundle.missingSkills.length + bundle.missingMcpServers.length > 0) {
    return { type: 'bundle', ref, label: bundle.name, state: 'unresolved', reason: 'bundle-missing-members' }
  }
  const memberStates = [
    ...bundle.skills.map((path) => {
      const resource = resolveIndexed(`${bundle.libraryId}:${path}`, undefined, indexes.skills)
      if (!resource) return 'unresolved'
      if (blockedTeamAssetReason(policy, `${resource.libraryId}:${resource.path}`, resource.version)) return 'blocked'
      return resourceState(resource, projectRoot, indexes)
    }),
    ...bundle.mcpServers.map((path) => {
      const resource = resolveIndexed(`${bundle.libraryId}:${path}`, undefined, indexes.mcpServers)
      if (!resource) return 'unresolved'
      if (blockedTeamAssetReason(policy, `${resource.libraryId}:${resource.path}`, resource.version)) return 'blocked'
      return resourceState(resource, projectRoot, indexes)
    }),
  ]
  const state = memberStates.includes('blocked')
    ? 'blocked'
    : memberStates.includes('unresolved')
    ? 'unresolved'
    : memberStates.includes('missing')
      ? 'missing'
      : memberStates.includes('outdated')
        ? 'outdated'
        : 'satisfied'
  const incomplete = memberStates.filter((item) => item !== 'satisfied').length
  return {
    type: 'bundle',
    ref,
    label: bundle.name,
    state,
    ...(state === 'blocked'
      ? { reason: 'blocked-policy' as const }
      : incomplete > 0
        ? { reason: 'bundle-incomplete' as const, detail: incomplete }
        : {}),
  }
}

async function refresh(): Promise<void> {
  const { projectRoots } = useSettings()
  loading.value = true
  try {
    const [configs, scan] = await Promise.all([
      Promise.all(projectRoots.value.map((root) => window.skillsManager.teamProjectConfig(root))),
      window.skillsManager.scanProjectInstructions({ projectRoots: [...projectRoots.value] }),
    ])
    projectConfigs.value = configs
    instructionDocuments.value = scan.documents.filter((document) => document.scope === 'project')
  } finally {
    loading.value = false
  }
}

export function useTeamProjects() {
  const { projectRoots } = useSettings()
  const { catalogs, bundles, skills, mcpServers, instructions, installations } = useTeamLibraries()
  if (!initialized) {
    initialized = true
    void refresh()
    watch(
      () => [...projectRoots.value],
      () => void refresh(),
    )
    window.skillsManager.onInstructionsChanged(() => void refresh())
  }
  const indexes = computed(() => buildComplianceIndexes(
    skills.value,
    mcpServers.value,
    bundles.value,
    instructions.value,
    installations.value,
  ))
  const projects = computed<TeamProjectCompliance[]>(() => projectConfigs.value.map((result) => {
    const config = result.config
    const policy = config ? effectivePolicy(config, catalogs.value) : emptyTeamPolicy()
    const requirements = config
      ? (() => {
          const requiredInstructions = [...new Set([
            ...config.requires.instructions,
            ...policy.required.instructions,
          ])]
          const recommendedInstructions = [...new Set(policy.recommended.instructions)]
            .filter((ref) => !requiredInstructions.includes(ref))
          return [
            ...config.requires.bundles.map((ref) => bundleStatus(
              ref,
              config,
              result.projectRoot,
              indexes.value,
              policy,
            )),
            ...[...new Set([...config.requires.skills, ...policy.required.skills])].map((ref) => directStatus(
              'skill',
              ref,
              config,
              result.projectRoot,
              indexes.value,
              policy,
            )),
            ...[...new Set([...config.requires.mcp, ...policy.required.mcp])].map((ref) => directStatus(
              'mcp',
              ref,
              config,
              result.projectRoot,
              indexes.value,
              policy,
            )),
            ...requiredInstructions.map((ref) => instructionStatus(
              ref,
              config,
              result.projectRoot,
              indexes.value,
              policy,
            )),
            ...recommendedInstructions.map((ref) => instructionStatus(
              ref,
              config,
              result.projectRoot,
              indexes.value,
              policy,
              true,
            )),
          ]
        })()
      : []
    const requiredRequirements = requirements.filter((item) => !item.recommended)
    return {
      ...result,
      requirements,
      satisfied: requiredRequirements.filter((item) => item.state === 'satisfied').length,
      missing: requiredRequirements.filter((item) => item.state === 'missing').length,
      outdated: requiredRequirements.filter((item) => item.state === 'outdated').length,
      unresolved: requiredRequirements.filter((item) => item.state === 'unresolved').length,
      blocked: requiredRequirements.filter((item) => item.state === 'blocked').length,
      recommended: requirements.filter((item) => item.recommended && item.state !== 'satisfied').length,
    }
  }))
  const attentionCount = computed(() => projects.value.reduce(
    (total, project) => total + project.missing + project.outdated + project.unresolved + project.blocked,
    0,
  ))
  if (!attentionCountWired) {
    attentionCountWired = true
    watch(attentionCount, setTeamProjectAttentionCount, { immediate: true })
  }
  return {
    projects,
    loading: readonly(loading),
    attentionCount,
    refresh,
  }
}
