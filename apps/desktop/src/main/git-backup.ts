import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import {
  aggregateSkills,
  findSkills,
  listInstructionProfiles,
  resolveResourcePath,
  scanInstructionDocuments,
  scanInstalledSkills,
  surfaceKey,
  type InstalledSkill,
  type Installation,
  type InstructionDocument,
  type InstructionRuleProfile,
  type SurfaceRef,
} from '@skillbuddy/core'
import type {
  BackupPreset,
  GitBackupRequest,
  GitBackupResult,
  GitInstructionRestoreRequest,
  GitInstructionRestoreResult,
  GitInstructionRestorePreview,
  GitRestorePreview,
} from '#shared/ipc'
import { InstructionPathPolicy } from './instructions/path-policy'
import {
  hashInstructionContent,
  readInstructionSnapshot,
  transactionalWriteInstruction,
  validateInstructionContent,
} from './instructions/transaction'
import type { PathAccessPolicy } from './path-policy'

const execFileAsync = promisify(execFile)
const MANIFEST_NAME = 'skillbuddy-backup.json'
const MAX_FILES = 2_000
const MAX_BYTES = 50 * 1024 * 1024

interface BackupManifestV1 {
  kind: 'skillbuddy-backup'
  version: 1
  createdAt: string
  skills: { name: string; contentHash: string }[]
  presets: BackupPreset[]
}

interface BackupInstruction {
  surface: SurfaceRef
  fileName: string
  contentHash: string
}

interface BackupManifestV2 {
  kind: 'skillbuddy-backup'
  version: 2
  createdAt: string
  skills: { name: string; contentHash: string }[]
  presets: BackupPreset[]
  instructions: BackupInstruction[]
}

type ParsedBackupManifest = BackupManifestV2 | (BackupManifestV1 & { instructions: [] })

interface GitBackupOptions {
  allowLocalRemote?: boolean
  scan?: () => Promise<InstalledSkill[]>
  scanInstructions?: () => Promise<InstructionDocument[]>
  instructionProfiles?: () => InstructionRuleProfile[]
}

const exactKeys = (value: Record<string, unknown>, expected: string[]): boolean => {
  const actual = Object.keys(value).sort()
  const keys = [...expected].sort()
  return actual.length === keys.length && actual.every((key, index) => key === keys[index])
}

function validateRemoteUrl(value: string, allowLocalRemote = false): string {
  const url = value.trim()
  if (!url || url.startsWith('-') || url.includes('\0')) throw new Error('invalid Git remote')
  if (/^(?:https?|git):\/\//.test(url)) {
    const parsed = new URL(url)
    if (parsed.username || parsed.password) {
      throw new Error('Git remote must not contain credentials')
    }
    if (
      parsed.protocol === 'git:' &&
      !['127.0.0.1', '::1', 'localhost'].includes(parsed.hostname)
    ) {
      throw new Error('git:// is only allowed for loopback remotes; use HTTPS or SSH')
    }
    return url
  }
  if (/^(?:git@|ssh:\/\/)[\w.@:/~-]+$/.test(url)) return url
  if (allowLocalRemote && resolve(url) === url) return url
  throw new Error('unsupported Git remote')
}

function validateBranch(value: string): string {
  const branch = value.trim()
  if (
    !branch ||
    branch.startsWith('-') ||
    branch.startsWith('.') ||
    branch.endsWith('.') ||
    branch.endsWith('/') ||
    branch.includes('..') ||
    branch.includes('@{') ||
    /[\s~^:?*[\\]/.test(branch)
  ) {
    throw new Error('invalid Git branch')
  }
  return branch
}

function normalizePresets(value: unknown): BackupPreset[] {
  if (!Array.isArray(value)) throw new Error('invalid backup presets')
  const names = new Set<string>()
  return value.map((item) => {
    if (typeof item !== 'object' || item === null) throw new Error('invalid backup preset')
    const preset = item as Record<string, unknown>
    if (!exactKeys(preset, ['name', 'skills'])) throw new Error('invalid backup preset fields')
    const name = typeof preset.name === 'string' ? preset.name.trim() : ''
    if (!name || names.has(name) || !Array.isArray(preset.skills)) {
      throw new Error('invalid backup preset data')
    }
    names.add(name)
    const skills: string[] = []
    const seen = new Set<string>()
    for (const value of preset.skills) {
      if (typeof value !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
        throw new Error('invalid backup preset skill')
      }
      if (!seen.has(value)) {
        seen.add(value)
        skills.push(value)
      }
    }
    return { name, skills }
  })
}

function normalizeSurface(value: unknown): SurfaceRef {
  if (typeof value !== 'object' || value === null) throw new Error('invalid backup instruction surface')
  const surface = value as Record<string, unknown>
  if (!exactKeys(surface, ['vendorId', 'productId', 'surfaceId'])) {
    throw new Error('invalid backup instruction surface fields')
  }
  const fields = ['vendorId', 'productId', 'surfaceId'] as const
  for (const field of fields) {
    if (
      typeof surface[field] !== 'string' ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(surface[field])
    ) {
      throw new Error('invalid backup instruction surface data')
    }
  }
  return {
    vendorId: surface.vendorId as string,
    productId: surface.productId as string,
    surfaceId: surface.surfaceId as string,
  }
}

function normalizeInstructions(value: unknown): BackupInstruction[] {
  if (!Array.isArray(value)) throw new Error('invalid backup instructions')
  const keys = new Set<string>()
  return value.map((item) => {
    if (typeof item !== 'object' || item === null) throw new Error('invalid backup instruction')
    const instruction = item as Record<string, unknown>
    if (!exactKeys(instruction, ['surface', 'fileName', 'contentHash'])) {
      throw new Error('invalid backup instruction fields')
    }
    const surface = normalizeSurface(instruction.surface)
    const fileName = typeof instruction.fileName === 'string' ? instruction.fileName : ''
    const contentHash = typeof instruction.contentHash === 'string' ? instruction.contentHash : ''
    const key = `${surfaceKey(surface)}/${fileName}`
    if (
      !fileName ||
      basename(fileName) !== fileName ||
      !/^[\w.-]+\.md$/i.test(fileName) ||
      !/^[a-f0-9]{64}$/.test(contentHash) ||
      keys.has(key)
    ) {
      throw new Error('invalid backup instruction data')
    }
    keys.add(key)
    return { surface, fileName, contentHash }
  })
}

function parseManifest(content: string): ParsedBackupManifest {
  const value: unknown = JSON.parse(content)
  if (typeof value !== 'object' || value === null) throw new Error('invalid backup manifest')
  const manifest = value as Record<string, unknown>
  const version = manifest.version
  const expectedKeys = version === 2
    ? ['kind', 'version', 'createdAt', 'skills', 'presets', 'instructions']
    : ['kind', 'version', 'createdAt', 'skills', 'presets']
  if (!exactKeys(manifest, expectedKeys)) {
    throw new Error('invalid backup manifest fields')
  }
  if (
    manifest.kind !== 'skillbuddy-backup' ||
    (version !== 1 && version !== 2) ||
    typeof manifest.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(manifest.createdAt)) ||
    !Array.isArray(manifest.skills)
  ) {
    throw new Error('unsupported backup manifest')
  }
  const skillNames = new Set<string>()
  const skills = manifest.skills.map((item) => {
    if (typeof item !== 'object' || item === null) throw new Error('invalid backup skill')
    const skill = item as Record<string, unknown>
    if (!exactKeys(skill, ['name', 'contentHash'])) throw new Error('invalid backup skill fields')
    if (
      typeof skill.name !== 'string' ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.name) ||
      skillNames.has(skill.name) ||
      typeof skill.contentHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(skill.contentHash)
    ) {
      throw new Error('invalid backup skill data')
    }
    skillNames.add(skill.name)
    return { name: skill.name, contentHash: skill.contentHash }
  })
  const common = {
    kind: 'skillbuddy-backup' as const,
    createdAt: manifest.createdAt,
    skills,
    presets: normalizePresets(manifest.presets),
  }
  return version === 2
    ? { ...common, version: 2, instructions: normalizeInstructions(manifest.instructions) }
    : { ...common, version: 1, instructions: [] }
}

async function git(cwd: string | undefined, args: string[], timeout = 60_000): Promise<string> {
  try {
    const result = await execFileAsync('git', args, {
      cwd,
      timeout,
      maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
    return result.stdout.trim()
  } catch (error) {
    const message = error instanceof Error ? error.message.split('\n')[0] : String(error)
    throw new Error(`Git operation failed: ${message}`)
  }
}

async function cloneBranch(remoteUrl: string, branch: string): Promise<string> {
  await git(undefined, ['--version'], 5_000)
  const root = await fs.mkdtemp(join(tmpdir(), 'skillbuddy-backup-'))
  try {
    await git(undefined, ['clone', '--depth', '1', '--no-checkout', remoteUrl, root])
    const exists = await execFileAsync(
      'git',
      ['ls-remote', '--exit-code', '--heads', 'origin', `refs/heads/${branch}`],
      { cwd: root, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
    ).then(() => true, () => false)
    if (exists) {
      await git(root, ['fetch', '--depth', '1', 'origin', branch])
      await git(root, ['checkout', '-B', branch, 'FETCH_HEAD'])
    } else {
      await git(root, ['checkout', '--orphan', branch])
      for (const entry of await fs.readdir(root)) {
        if (entry !== '.git') await fs.rm(join(root, entry), { recursive: true, force: true })
      }
    }
    return root
  } catch (error) {
    await fs.rm(root, { recursive: true, force: true })
    throw error
  }
}

async function inspectBackupTree(root: string): Promise<void> {
  let files = 0
  let bytes = 0
  async function walk(directory: string): Promise<void> {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.name === '.git') continue
      const path = join(directory, entry.name)
      const stat = await fs.lstat(path)
      if (stat.isSymbolicLink()) throw new Error('backup repository contains symbolic links')
      if (stat.isDirectory()) await walk(path)
      else if (stat.isFile()) {
        files += 1
        bytes += stat.size
        if (files > MAX_FILES || bytes > MAX_BYTES) throw new Error('backup repository is too large')
      }
    }
  }
  await walk(root)
}

async function writeSkill(source: Installation, destination: string): Promise<void> {
  await fs.mkdir(destination, { recursive: true })
  const sourceFile = join(source.path, source.enabled === false ? 'SKILL.md.disabled' : 'SKILL.md')
  await fs.copyFile(sourceFile, join(destination, 'SKILL.md'))
  for (const [relativePath, sourcePath] of Object.entries(source.skill.resources ?? {})) {
    const target = resolveResourcePath(destination, relativePath)
    await fs.mkdir(dirname(target), { recursive: true })
    await fs.copyFile(sourcePath, target)
  }
}

interface CollectedBackupInstruction extends BackupInstruction {
  sourcePath: string
}

function instructionSnapshotPath(root: string, instruction: BackupInstruction): string {
  return join(
    root,
    'instructions',
    instruction.surface.vendorId,
    instruction.surface.productId,
    instruction.surface.surfaceId,
    instruction.fileName,
  )
}

async function collectBackupInstructions(
  scan: GitBackupOptions['scanInstructions'],
  profiles: InstructionRuleProfile[],
): Promise<CollectedBackupInstruction[]> {
  const documents = scan ? await scan() : (await scanInstructionDocuments([])).documents
  const collected: CollectedBackupInstruction[] = []
  for (const document of documents) {
    if (
      document.scope !== 'user' ||
      document.readOnly ||
      document.linked ||
      document.contentTruncated ||
      document.encodingInvalid
    ) {
      continue
    }
    for (const binding of document.bindings.filter((item) => item.role === 'primary')) {
      const profile = profiles.find((item) => surfaceKey(item.key) === surfaceKey(binding.surface))
      if (!profile?.globalPaths.some((path) => resolve(path) === resolve(document.path))) continue
      collected.push({
        surface: binding.surface,
        fileName: document.fileName,
        contentHash: document.contentHash,
        sourcePath: document.path,
      })
    }
  }
  return collected.sort((first, second) => {
    const surface = surfaceKey(first.surface).localeCompare(surfaceKey(second.surface))
    return surface || first.fileName.localeCompare(second.fileName)
  })
}

async function writeInstructionSnapshot(
  root: string,
  instruction: CollectedBackupInstruction,
): Promise<void> {
  const content = await fs.readFile(instruction.sourcePath)
  const text = new TextDecoder('utf-8', { fatal: true }).decode(content)
  validateInstructionContent(text)
  if (hashInstructionContent(content) !== instruction.contentHash) {
    throw new Error(`instruction changed during backup: ${instruction.fileName}`)
  }
  const target = instructionSnapshotPath(root, instruction)
  await fs.mkdir(dirname(target), { recursive: true })
  await fs.writeFile(target, content, { mode: 0o600 })
}

function resolveInstructionTarget(
  instruction: BackupInstruction,
  profiles: InstructionRuleProfile[],
): { displayName: string; targetPath: string } {
  const profile = profiles.find((item) => surfaceKey(item.key) === surfaceKey(instruction.surface))
  const targetPath = profile?.globalPaths.find((path) => basename(path) === instruction.fileName)
  if (!profile || !targetPath) throw new Error('当前版本不支持该 AI 指令目标')
  return { displayName: profile.displayName, targetPath: resolve(targetPath) }
}

async function readInstructionSnapshotContent(
  root: string,
  instruction: BackupInstruction,
): Promise<Buffer> {
  const content = await fs.readFile(instructionSnapshotPath(root, instruction))
  const text = new TextDecoder('utf-8', { fatal: true }).decode(content)
  validateInstructionContent(text)
  if (hashInstructionContent(content) !== instruction.contentHash) {
    throw new Error('backup AI instruction content does not match its manifest')
  }
  return content
}

async function instructionRestoreContext(
  profiles: InstructionRuleProfile[],
): Promise<{
  policy: InstructionPathPolicy
  documents: InstructionDocument[]
}> {
  const documents = (await scanInstructionDocuments([])).documents
  const policy = new InstructionPathPolicy()
  policy.setState([], documents, profiles)
  return { policy, documents }
}

async function previewInstructionRestore(
  root: string,
  instruction: BackupInstruction,
  policy: InstructionPathPolicy,
  profiles: InstructionRuleProfile[],
): Promise<GitInstructionRestorePreview> {
  let displayName = surfaceKey(instruction.surface)
  let targetPath = ''
  try {
    const target = resolveInstructionTarget(instruction, profiles)
    displayName = target.displayName
    targetPath = target.targetPath
    const content = await readInstructionSnapshotContent(root, instruction)
    await policy.assertWriteTarget(targetPath)
    const current = await readInstructionSnapshot(targetPath)
    return {
      surface: instruction.surface,
      displayName,
      fileName: instruction.fileName,
      targetPath,
      state: current === null
        ? 'create'
        : hashInstructionContent(current.content) === hashInstructionContent(content)
          ? 'unchanged'
          : 'conflict',
    }
  } catch (error) {
    return {
      surface: instruction.surface,
      displayName,
      fileName: instruction.fileName,
      targetPath,
      state: 'blocked',
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

async function snapshotCreatedAt(
  root: string,
  skills: BackupManifestV1['skills'],
  presets: BackupPreset[],
  instructions: BackupInstruction[],
): Promise<string> {
  try {
    const previous = parseManifest(await fs.readFile(join(root, MANIFEST_NAME), 'utf8'))
    if (
      JSON.stringify(previous.skills) === JSON.stringify(skills) &&
      JSON.stringify(previous.presets) === JSON.stringify(presets) &&
      JSON.stringify(previous.instructions) === JSON.stringify(instructions)
    ) {
      return previous.createdAt
    }
  } catch {
    // 缺失或旧格式 manifest 会在本次备份中被安全替换。
  }
  return new Date().toISOString()
}

/** 将所有可管理的用户级 Skill、Preset 和全局 AI 指令推送到普通 Git 快照。 */
export async function pushGitBackup(
  request: GitBackupRequest,
  options: GitBackupOptions = {},
): Promise<GitBackupResult> {
  const remoteUrl = validateRemoteUrl(request.remoteUrl, options.allowLocalRemote)
  const branch = validateBranch(request.branch)
  const presets = normalizePresets(request.presets)
  const installed = (await (options.scan?.() ?? scanInstalledSkills())).filter(
    (item) => item.scope === 'user' && !item.readOnly,
  )
  const skills = await aggregateSkills(installed)
  const drifted = skills.filter((skill) => skill.hasDrift).map((skill) => skill.name)
  if (drifted.length > 0) throw new Error(`resolve Skill drift before backup: ${drifted.join(', ')}`)
  const profiles = options.instructionProfiles?.() ?? listInstructionProfiles()
  const collectedInstructions = await collectBackupInstructions(options.scanInstructions, profiles)
  const instructions = collectedInstructions.map(({ sourcePath: _sourcePath, ...instruction }) => instruction)

  const root = await cloneBranch(remoteUrl, branch)
  try {
    await inspectBackupTree(root)
    const skillsRoot = join(root, 'skills')
    await fs.rm(skillsRoot, { recursive: true, force: true })
    await fs.mkdir(skillsRoot, { recursive: true })
    for (const skill of skills) await writeSkill(skill.installations[0]!, join(skillsRoot, skill.name))
    const instructionsRoot = join(root, 'instructions')
    await fs.rm(instructionsRoot, { recursive: true, force: true })
    for (const instruction of collectedInstructions) {
      await writeInstructionSnapshot(root, instruction)
    }

    const manifestSkills = skills.map((skill) => ({
      name: skill.name,
      contentHash: skill.installations[0]!.contentHash,
    }))
    const manifest: BackupManifestV2 = {
      kind: 'skillbuddy-backup',
      version: 2,
      createdAt: await snapshotCreatedAt(root, manifestSkills, presets, instructions),
      skills: manifestSkills,
      presets,
      instructions,
    }
    await fs.writeFile(join(root, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    const managedPaths = [MANIFEST_NAME]
    if (skills.length > 0 || await git(root, ['ls-files', '--', 'skills'])) {
      managedPaths.push('skills')
    }
    if (instructions.length > 0 || await git(root, ['ls-files', '--', 'instructions'])) {
      managedPaths.push('instructions')
    }
    await git(root, ['add', '-A', '--', ...managedPaths])
    const dirty = await git(root, ['status', '--porcelain', '--', ...managedPaths])
    if (!dirty) {
      return {
        committed: false,
        skills: skills.length,
        presets: presets.length,
        instructions: instructions.length,
      }
    }

    await git(root, ['-c', 'user.name=SkillBuddy', '-c', 'user.email=backup@skillbuddy.local', 'commit', '-m', 'SkillBuddy backup'])
    await git(root, ['push', 'origin', branch])
    return {
      committed: true,
      skills: skills.length,
      presets: presets.length,
      instructions: instructions.length,
      commit: await git(root, ['rev-parse', '--short', 'HEAD']),
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

/** 浅克隆并严格校验最新备份，临时目录由调用方在安装结束后清理。 */
export async function prepareGitRestore(
  request: Pick<GitBackupRequest, 'remoteUrl' | 'branch'>,
  pathPolicy: PathAccessPolicy,
  options: Pick<GitBackupOptions, 'allowLocalRemote' | 'instructionProfiles'> = {},
): Promise<GitRestorePreview> {
  const root = await cloneBranch(
    validateRemoteUrl(request.remoteUrl, options.allowLocalRemote),
    validateBranch(request.branch),
  )
  try {
    await inspectBackupTree(root)
    const manifest = parseManifest(await fs.readFile(join(root, MANIFEST_NAME), 'utf8'))
    const items = await findSkills(join(root, 'skills'))
    const expected = [...manifest.skills.map((skill) => skill.name)].sort()
    const actual = [...items.map((item) => item.skill.name)].sort()
    if (expected.length !== actual.length || expected.some((name, index) => name !== actual[index])) {
      throw new Error('backup manifest does not match its Skill directories')
    }
    const aggregated = await aggregateSkills(
      items.map((item) => ({
        skill: item.skill,
        agent: 'backup',
        scope: 'user',
        path: item.dir,
      })),
    )
    const hashes = new Map(
      aggregated.map((skill) => [skill.name, skill.installations[0]!.contentHash]),
    )
    if (manifest.skills.some((skill) => hashes.get(skill.name) !== skill.contentHash)) {
      throw new Error('backup Skill content does not match its manifest')
    }
    const profiles = options.instructionProfiles?.() ?? listInstructionProfiles()
    const { policy } = await instructionRestoreContext(profiles)
    const instructions = await Promise.all(
      manifest.instructions.map((instruction) =>
        previewInstructionRestore(root, instruction, policy, profiles),
      ),
    )
    const targetPaths = instructions
      .filter((instruction) => instruction.state !== 'blocked')
      .map((instruction) => instruction.targetPath)
    if (new Set(targetPaths).size !== targetPaths.length) {
      throw new Error('backup manifest contains duplicate AI instruction targets')
    }
    pathPolicy.grantTemporaryRoot(root, true)
    return {
      root,
      createdAt: manifest.createdAt,
      items,
      presets: manifest.presets,
      instructions,
    }
  } catch (error) {
    await fs.rm(root, { recursive: true, force: true })
    throw error
  }
}

/** 按本机 Agent 注册表恢复全局 AI 指令；冲突是否覆盖由用户在预览后明确确认。 */
export async function restoreGitInstructions(
  request: GitInstructionRestoreRequest,
  pathPolicy: PathAccessPolicy,
  options: Pick<GitBackupOptions, 'instructionProfiles'> = {},
): Promise<GitInstructionRestoreResult[]> {
  pathPolicy.assertTemporaryRoot(request.root)
  await inspectBackupTree(request.root)
  const manifest = parseManifest(
    await fs.readFile(join(request.root, MANIFEST_NAME), 'utf8'),
  )
  const profiles = options.instructionProfiles?.() ?? listInstructionProfiles()
  const { policy } = await instructionRestoreContext(profiles)
  const results: GitInstructionRestoreResult[] = []
  const restoredTargets = new Set<string>()
  for (const instruction of manifest.instructions) {
    let targetPath = ''
    try {
      targetPath = resolveInstructionTarget(instruction, profiles).targetPath
      if (restoredTargets.has(targetPath)) {
        throw new Error('备份中存在重复的 AI 指令恢复目标')
      }
      restoredTargets.add(targetPath)
      const content = await readInstructionSnapshotContent(request.root, instruction)
      await policy.assertWriteTarget(targetPath)
      const current = await readInstructionSnapshot(targetPath)
      if (current && hashInstructionContent(current.content) === instruction.contentHash) {
        results.push({ path: targetPath, ok: true, skipped: true })
        continue
      }
      if (current && !request.overwriteConflicts) {
        results.push({ path: targetPath, ok: true, skipped: true })
        continue
      }
      await transactionalWriteInstruction({
        path: targetPath,
        content,
        expectedIdentity: current?.identity ?? null,
        createMode: 0o600,
      })
      results.push({ path: targetPath, ok: true })
    } catch (error) {
      results.push({
        path: targetPath || surfaceKey(instruction.surface),
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return results
}
