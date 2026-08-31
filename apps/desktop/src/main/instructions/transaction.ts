import { createHash, randomUUID } from 'node:crypto'
import { constants, promises as fs } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { MAX_INSTRUCTION_FILE_BYTES } from '@skillbuddy/core'

export interface InstructionFileSnapshot {
  kind: 'file' | 'symlink'
  content: Buffer
  mode: number
  identity: string
  linkTarget?: string
}

export function hashInstructionContent(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex')
}

export function validateInstructionContent(content: string | Buffer): void {
  if (typeof content === 'string' && content.includes('\0')) {
    throw new Error('指令内容不能包含 NUL 字符')
  }
  if (Buffer.byteLength(content) > MAX_INSTRUCTION_FILE_BYTES) {
    throw new Error('指令内容超过 1 MiB 上限')
  }
}

export async function readInstructionSnapshot(path: string): Promise<InstructionFileSnapshot | null> {
  try {
    const entry = await fs.lstat(path)
    if (entry.isSymbolicLink()) {
      const linkTarget = await fs.readlink(path)
      return {
        kind: 'symlink',
        content: Buffer.from(linkTarget),
        mode: entry.mode,
        identity: hashInstructionContent(Buffer.from(`link:${linkTarget}`)),
        linkTarget,
      }
    }
    if (!entry.isFile()) throw new Error('目标不是普通文件')
    const content = await fs.readFile(path)
    return {
      kind: 'file',
      content,
      mode: entry.mode,
      identity: hashInstructionContent(content),
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function assertIdentity(actual: string | null, expected: string | null): void {
  if (actual === expected) return
  throw new Error('指令文件在计划生成后已被其他程序修改，请刷新后重试')
}

async function syncDirectory(path: string): Promise<void> {
  try {
    const handle = await fs.open(path, constants.O_RDONLY)
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch {
    /** Windows 可能不允许 fsync 目录，文件本身已同步。 */
  }
}

/** 同目录临时文件写入并原子替换，提交前再次校验文件身份。 */
export async function transactionalWriteInstruction(input: {
  path: string
  content: string | Buffer
  expectedIdentity: string | null
  createMode?: number
  beforeCommit?: (snapshot: InstructionFileSnapshot | null) => Promise<void>
}): Promise<{ afterHash: string; created: boolean }> {
  validateInstructionContent(input.content)
  const content = typeof input.content === 'string' ? Buffer.from(input.content) : input.content
  const directory = dirname(input.path)
  const initial = await readInstructionSnapshot(input.path)
  if (initial?.kind === 'symlink') throw new Error('链接型指令文件不可直接编辑')
  assertIdentity(initial?.identity ?? null, input.expectedIdentity)
  if (initial) await fs.access(input.path, constants.W_OK)
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })

  const temporaryPath = join(directory, `.skillbuddy-${randomUUID()}.tmp`)
  let temporaryCreated = false
  try {
    const handle = await fs.open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      initial?.mode ?? input.createMode ?? 0o600,
    )
    temporaryCreated = true
    try {
      await handle.writeFile(content)
      await handle.sync()
    } finally {
      await handle.close()
    }
    if (initial) await fs.chmod(temporaryPath, initial.mode)
    await input.beforeCommit?.(initial)
    const latest = await readInstructionSnapshot(input.path)
    assertIdentity(latest?.identity ?? null, initial?.identity ?? null)
    await fs.rename(temporaryPath, input.path)
    temporaryCreated = false
    await syncDirectory(directory)
    return {
      afterHash: hashInstructionContent(content),
      created: initial === null,
    }
  } finally {
    if (temporaryCreated) await fs.unlink(temporaryPath).catch(() => undefined)
  }
}

/** 备份成功且身份未变化后删除文件条目；符号链接只删除链接本身。 */
export async function transactionalDeleteInstruction(input: {
  path: string
  tombstonePath: string
  expectedIdentity: string
  beforeCommit?: (snapshot: InstructionFileSnapshot) => Promise<void>
}): Promise<InstructionFileSnapshot> {
  const initial = await readInstructionSnapshot(input.path)
  if (!initial) throw new Error('待删除指令文件不存在')
  assertIdentity(initial.identity, input.expectedIdentity)
  await input.beforeCommit?.(initial)
  const latest = await readInstructionSnapshot(input.path)
  assertIdentity(latest?.identity ?? null, initial.identity)
  await fs.rename(input.path, input.tombstonePath)
  await syncDirectory(dirname(input.path))
  return initial
}

export function instructionTombstonePath(path: string): string {
  return join(dirname(path), `.skillbuddy-deleted-${randomUUID()}-${basename(path)}`)
}
