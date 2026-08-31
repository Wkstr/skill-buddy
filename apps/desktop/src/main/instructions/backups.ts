import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { InstructionManagedTarget } from './path-policy'
import type { InstructionFileSnapshot } from './transaction'
import {
  readInstructionSnapshot,
  transactionalWriteInstruction,
} from './transaction'
import type { InstructionPathPolicy } from './path-policy'

export interface InstructionBackupRecord {
  id: string
  operationId: string
  intent: 'write' | 'delete'
  target: InstructionManagedTarget
  original: InstructionFileSnapshot | null
  afterIdentity: string | null
  backupPath: string
  tombstonePath?: string
}

/** 保存短期可撤销的指令文件快照；退出后清理，避免长期保留项目规则副本。 */
export class InstructionBackupStore {
  readonly #ready: Promise<void>
  readonly #root: string
  readonly #operations = new Map<string, InstructionBackupRecord[]>()

  constructor(root: string) {
    this.#root = root
    this.#ready = this.sweep()
  }

  async sweep(): Promise<void> {
    const operations = await fs.readdir(this.#root, { withFileTypes: true }).catch(() => [])
    for (const operation of operations.filter((entry) => entry.isDirectory())) {
      const directory = join(this.#root, operation.name)
      const manifests = await fs.readdir(directory).catch(() => [])
      for (const name of manifests.filter((item) => item.endsWith('.json'))) {
        try {
          const data = JSON.parse(await fs.readFile(join(directory, name), 'utf8')) as {
            targetPath?: unknown
            tombstonePath?: unknown
          }
          if (
            typeof data.targetPath === 'string'
            && typeof data.tombstonePath === 'string'
            && isManagedTombstone(data.targetPath, data.tombstonePath)
          ) {
            await fs.unlink(data.tombstonePath).catch(() => undefined)
          }
        } catch {
          /** 损坏的清单不阻断其他备份清理。 */
        }
      }
    }
    await fs.rm(this.#root, { recursive: true, force: true }).catch(() => undefined)
  }

  async stage(
    operationId: string,
    intent: InstructionBackupRecord['intent'],
    target: InstructionManagedTarget,
    original: InstructionFileSnapshot | null,
    afterIdentity: string | null,
    tombstonePath?: string,
  ): Promise<InstructionBackupRecord> {
    await this.#ready
    const id = randomUUID()
    const directory = join(this.#root, operationId)
    const backupPath = join(directory, `${id}-${basename(target.path)}.bak`)
    await fs.mkdir(directory, { recursive: true, mode: 0o700 })
    await fs.writeFile(backupPath, original?.content ?? Buffer.alloc(0), { mode: 0o600 })
    const record = {
      id,
      operationId,
      intent,
      target,
      original,
      afterIdentity,
      backupPath,
      ...(tombstonePath ? { tombstonePath } : {}),
    }
    await fs.writeFile(
      join(directory, `${id}.json`),
      JSON.stringify({ targetPath: target.path, tombstonePath: tombstonePath ?? null }),
      { mode: 0o600 },
    )
    const records = this.#operations.get(operationId) ?? []
    records.push(record)
    this.#operations.set(operationId, records)
    return record
  }

  async discard(record: InstructionBackupRecord): Promise<void> {
    const records = this.#operations.get(record.operationId) ?? []
    const remaining = records.filter((candidate) => candidate.id !== record.id)
    if (remaining.length > 0) this.#operations.set(record.operationId, remaining)
    else {
      this.#operations.delete(record.operationId)
      if (record.tombstonePath) await fs.unlink(record.tombstonePath).catch(() => undefined)
      await fs.rm(join(this.#root, record.operationId), { recursive: true, force: true })
      return
    }
    await fs.unlink(record.backupPath).catch(() => undefined)
    await fs.unlink(join(this.#root, record.operationId, `${record.id}.json`)).catch(() => undefined)
    if (record.tombstonePath) await fs.unlink(record.tombstonePath).catch(() => undefined)
  }

  expire(operationId: string, delay: number): void {
    setTimeout(() => void this.remove(operationId), delay).unref()
  }

  async restore(
    operationId: string,
    policy: InstructionPathPolicy,
  ): Promise<{ path: string; ok: boolean; error?: string }[]> {
    await this.#ready
    const records = this.#operations.get(operationId)
    if (!records) return []
    const results: { path: string; ok: boolean; error?: string }[] = []
    const failed: InstructionBackupRecord[] = []
    for (const record of [...records].reverse()) {
      try {
        await policy.assertRestoreTarget(record.target)
        const current = await readInstructionSnapshot(record.target.path)
        if (record.intent === 'write') {
          if ((current?.identity ?? null) !== record.afterIdentity) {
            throw new Error('文件在操作后再次变化，无法撤销')
          }
          if (!record.original) {
            await fs.unlink(record.target.path)
          } else {
            await transactionalWriteInstruction({
              path: record.target.path,
              content: record.original.content,
              expectedIdentity: record.afterIdentity,
              createMode: record.target.scope === 'project' ? 0o644 : 0o600,
            })
          }
        } else {
          if (current) throw new Error('删除位置已出现新文件，无法恢复')
          if (!record.original) throw new Error('删除备份不存在')
          if (record.tombstonePath && await fs.lstat(record.tombstonePath).then(() => true, () => false)) {
            await fs.rename(record.tombstonePath, record.target.path)
          } else if (record.original.kind === 'symlink') {
            await fs.symlink(record.original.linkTarget ?? record.original.content.toString('utf8'), record.target.path)
          } else {
            await transactionalWriteInstruction({
              path: record.target.path,
              content: record.original.content,
              expectedIdentity: null,
              createMode: record.target.scope === 'project' ? 0o644 : 0o600,
            })
            await fs.chmod(record.target.path, record.original.mode)
          }
        }
        results.push({ path: record.target.path, ok: true })
      } catch (error) {
        failed.push(record)
        results.push({
          path: record.target.path,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    if (failed.length === 0) await this.remove(operationId)
    else this.#operations.set(operationId, failed.reverse())
    return results
  }

  private async remove(operationId: string): Promise<void> {
    const records = this.#operations.get(operationId) ?? []
    this.#operations.delete(operationId)
    for (const record of records) {
      if (record.tombstonePath) await fs.unlink(record.tombstonePath).catch(() => undefined)
    }
    await fs.rm(join(this.#root, operationId), { recursive: true, force: true })
  }
}

function isManagedTombstone(targetPath: string, tombstonePath: string): boolean {
  const target = resolve(targetPath)
  const tombstone = resolve(tombstonePath)
  return dirname(target) === dirname(tombstone)
    && basename(tombstone).startsWith('.skillbuddy-deleted-')
}
