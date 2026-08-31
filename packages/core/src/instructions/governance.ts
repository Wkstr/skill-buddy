import { createHash } from 'node:crypto'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'
import matter from 'gray-matter'
import { INSTRUCTION_PROFILES } from './profiles.js'
import { MAX_INSTRUCTION_FILE_BYTES } from './constants.js'
import type { InstructionDocument } from './types.js'

const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const SUPPORTED_FILE_NAMES = new Set(INSTRUCTION_PROFILES.flatMap((profile) => [
  ...profile.projectFileCandidates,
  ...profile.projectFallbacks,
  ...profile.localOverlayCandidates,
  ...(profile.overrideCandidates ?? []),
]).map((candidate) => basename(candidate)))

export interface InstructionTemplateDefinition {
  id: string
  name: string
  description: string
  version?: string
  target: string
  content: string
  contentHash: string
}

export type InstructionTemplateComplianceState = 'satisfied' | 'missing' | 'outdated'

export interface InstructionTemplateCompliance {
  templateId: string
  targetPath: string
  state: InstructionTemplateComplianceState
  expectedHash: string
  actualHash?: string
}

function requiredText(value: unknown, field: string, max = 2_000): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} 不能为空`)
  const result = value.trim()
  if (result.length > max || [...result].some((character) => character.charCodeAt(0) < 32)) {
    throw new Error(`${field} 无效`)
  }
  return result
}

export function normalizeInstructionTemplateContent(content: string): string {
  const normalized = content.replaceAll('\r\n', '\n').replace(/^\n/, '').trimEnd()
  if (!normalized) throw new Error('指令模板内容不能为空')
  const result = `${normalized}\n`
  if (Buffer.byteLength(result) > MAX_INSTRUCTION_FILE_BYTES) {
    throw new Error('指令模板内容超过 1 MiB 上限')
  }
  if (result.includes('\0')) throw new Error('指令模板内容包含 NUL 字符')
  return result
}

export function normalizeInstructionTemplateTarget(value: unknown): string {
  const target = requiredText(value ?? 'AGENTS.md', 'target', 500).replaceAll('\\', '/')
  if (isAbsolute(target) || /^[A-Za-z]:\//.test(target)) throw new Error('target 必须是项目内相对路径')
  const segments = target.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('target 包含无效路径片段')
  }
  if (!SUPPORTED_FILE_NAMES.has(basename(target))) throw new Error('target 不是已登记的指令文件名')
  return target
}

export function instructionTemplateContentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

/** 解析团队库中的 Markdown 指令模板，并验证其目标路径与内容边界。 */
export function parseInstructionTemplate(raw: string, fallbackId = ''): InstructionTemplateDefinition {
  let parsed: matter.GrayMatterFile<string>
  try {
    parsed = matter(raw)
  } catch (error) {
    throw new Error(
      `指令模板 frontmatter 无效：${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
  const data = parsed.data as Record<string, unknown>
  const id = requiredText(data.id ?? fallbackId, 'id', 100)
  if (!ID_RE.test(id)) throw new Error('id 必须使用 kebab-case')
  const name = requiredText(data.name ?? id, 'name', 200)
  const description = requiredText(data.description ?? '团队共享项目指令', 'description')
  const version = typeof data.version === 'string' && data.version.trim()
    ? data.version.trim()
    : undefined
  const target = normalizeInstructionTemplateTarget(data.target ?? 'AGENTS.md')
  const content = normalizeInstructionTemplateContent(parsed.content)
  return {
    id,
    name,
    description,
    ...(version ? { version } : {}),
    target,
    content,
    contentHash: instructionTemplateContentHash(content),
  }
}

/** 仅使用项目级扫描结果校验模板，避免 CI 或团队治理读取用户全局指令。 */
export function evaluateInstructionTemplateCompliance(
  projectRoot: string,
  template: Pick<InstructionTemplateDefinition, 'id' | 'target' | 'contentHash'>,
  documents: readonly InstructionDocument[],
): InstructionTemplateCompliance {
  const root = resolve(projectRoot)
  const targetPath = resolve(root, template.target)
  const relation = relative(root, targetPath)
  if (relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new Error('指令模板目标越出项目目录')
  }
  const document = documents.find((item) => item.scope === 'project' && resolve(item.path) === targetPath)
  if (!document) {
    return {
      templateId: template.id,
      targetPath,
      state: 'missing',
      expectedHash: template.contentHash,
    }
  }
  return {
    templateId: template.id,
    targetPath,
    state: document.contentHash === template.contentHash ? 'satisfied' : 'outdated',
    expectedHash: template.contentHash,
    actualHash: document.contentHash,
  }
}
