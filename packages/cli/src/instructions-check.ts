import { promises as fs } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  evaluateInstructionTemplateCompliance,
  parseInstructionTemplate,
  scanInstructionDocuments,
  type InstructionTemplateDefinition,
  type InstructionTemplateComplianceState,
} from '@skillbuddy/core'
import { parse as parseYaml } from 'yaml'

interface InstructionPolicy {
  required: string[]
  recommended: string[]
}

interface InstructionCheckItem {
  ref: string
  recommended: boolean
  state: InstructionTemplateComplianceState | 'unresolved'
  target?: string
  templatePath?: string
  version?: string
}

export interface InstructionCheckResult {
  projectRoot: string
  libraryRoot: string
  libraryId: string
  compliant: boolean
  items: InstructionCheckItem[]
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => item.trim()))]
    : []
}

function instructionPolicy(value: unknown): InstructionPolicy {
  const policy = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  const required = typeof policy.required === 'object' && policy.required !== null
    ? policy.required as Record<string, unknown>
    : {}
  const recommended = typeof policy.recommended === 'object' && policy.recommended !== null
    ? policy.recommended as Record<string, unknown>
    : {}
  return {
    required: stringList(required.instructions),
    recommended: stringList(recommended.instructions),
  }
}

function mergePolicies(...policies: InstructionPolicy[]): InstructionPolicy {
  return {
    required: [...new Set(policies.flatMap((policy) => policy.required))],
    recommended: [...new Set(policies.flatMap((policy) => policy.recommended))],
  }
}

function isWithin(root: string, target: string): boolean {
  const relation = relative(root, target)
  return relation === '' || (relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation))
}

async function readYamlWithin(root: string, path: string): Promise<unknown> {
  const target = resolve(root, path)
  if (!isWithin(root, target)) throw new Error(`policy path leaves library: ${path}`)
  const stat = await fs.lstat(target)
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`policy must be a regular file: ${path}`)
  return parseYaml(await fs.readFile(target, 'utf8')) as unknown
}

async function loadTemplates(root: string): Promise<Map<string, { path: string; template: InstructionTemplateDefinition }[]>> {
  const directory = join(root, 'instructions')
  const directoryStat = await fs.lstat(directory).catch(() => null)
  if (directoryStat?.isSymbolicLink() || (directoryStat && !directoryStat.isDirectory())) {
    throw new Error('instructions must be a regular directory')
  }
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => [])
  const index = new Map<string, { path: string; template: InstructionTemplateDefinition }[]>()
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue
    const path = `instructions/${entry.name}`
    const template = parseInstructionTemplate(
      await fs.readFile(join(directory, entry.name), 'utf8'),
      basename(entry.name, '.md'),
    )
    const item = { path, template }
    for (const key of new Set([path, template.id, template.name])) {
      index.set(key, [...(index.get(key) ?? []), item])
    }
  }
  return index
}

function localRef(ref: string, libraryId: string): string | null {
  const separator = ref.indexOf(':')
  if (separator < 0) return ref
  return ref.slice(0, separator) === libraryId ? ref.slice(separator + 1) : null
}

export async function checkProjectInstructions(input: {
  projectRoot: string
  libraryRoot: string
}): Promise<InstructionCheckResult> {
  const projectRoot = await fs.realpath(resolve(input.projectRoot))
  const libraryRoot = await fs.realpath(resolve(input.libraryRoot))
  const manifest = await readYamlWithin(libraryRoot, 'team-library.yaml')
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    throw new Error('team-library.yaml must be an object')
  }
  const source = manifest as Record<string, unknown>
  const libraryId = typeof source.id === 'string' ? source.id.trim() : ''
  if (!libraryId) throw new Error('team-library.yaml is missing id')
  const projectConfigPath = join(projectRoot, '.skillbuddy', 'team.yaml')
  const projectConfig = parseYaml(await fs.readFile(projectConfigPath, 'utf8')) as unknown
  if (typeof projectConfig !== 'object' || projectConfig === null || Array.isArray(projectConfig)) {
    throw new Error('.skillbuddy/team.yaml must be an object')
  }
  const config = projectConfig as Record<string, unknown>
  if (typeof config.library === 'string' && config.library.trim() && config.library.trim() !== libraryId) {
    throw new Error(`project requires library ${config.library.trim()}, received ${libraryId}`)
  }

  const policies = typeof source.policies === 'object' && source.policies !== null && !Array.isArray(source.policies)
    ? source.policies as Record<string, unknown>
    : {}
  const loadedPolicies: InstructionPolicy[] = []
  if (typeof policies.organization === 'string' && policies.organization.trim()) {
    loadedPolicies.push(instructionPolicy(await readYamlWithin(libraryRoot, policies.organization.trim())))
  }
  const teamPolicies = typeof policies.teams === 'object' && policies.teams !== null && !Array.isArray(policies.teams)
    ? policies.teams as Record<string, unknown>
    : {}
  for (const teamRef of stringList(config.teams)) {
    const teamId = localRef(teamRef, libraryId)
    if (!teamId) continue
    const entry = teamPolicies[teamId]
    const file = typeof entry === 'string'
      ? entry
      : typeof entry === 'object' && entry !== null && !Array.isArray(entry)
        ? (entry as Record<string, unknown>).file
        : null
    if (typeof file === 'string' && file.trim()) {
      loadedPolicies.push(instructionPolicy(await readYamlWithin(libraryRoot, file.trim())))
    }
  }
  loadedPolicies.push(instructionPolicy(config.policy))
  const merged = mergePolicies(...loadedPolicies)
  const requires = typeof config.requires === 'object' && config.requires !== null && !Array.isArray(config.requires)
    ? config.requires as Record<string, unknown>
    : {}
  const required = [...new Set([...stringList(requires.instructions), ...merged.required])]
  const recommended = [...new Set(merged.recommended)].filter((ref) => !required.includes(ref))
  const templates = await loadTemplates(libraryRoot)
  const scan = await scanInstructionDocuments([projectRoot], { includeGlobal: false })

  const evaluate = (ref: string, isRecommended: boolean): InstructionCheckItem => {
    const value = localRef(ref, libraryId)
    const matches = value ? templates.get(value) ?? [] : []
    if (matches.length !== 1) return { ref, recommended: isRecommended, state: 'unresolved' }
    const item = matches[0]!
    const compliance = evaluateInstructionTemplateCompliance(projectRoot, item.template, scan.documents)
    return {
      ref,
      recommended: isRecommended,
      state: compliance.state,
      target: item.template.target,
      templatePath: item.path,
      version: item.template.version,
    }
  }
  const items = [
    ...required.map((ref) => evaluate(ref, false)),
    ...recommended.map((ref) => evaluate(ref, true)),
  ]
  return {
    projectRoot,
    libraryRoot,
    libraryId,
    compliant: items.every((item) => item.recommended || item.state === 'satisfied'),
    items,
  }
}
