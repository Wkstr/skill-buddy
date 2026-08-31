import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { InstructionBackupStore } from './backups'
import { InstructionPathPolicy } from './path-policy'
import {
  hashInstructionContent,
  readInstructionSnapshot,
  transactionalDeleteInstruction,
  transactionalWriteInstruction,
} from './transaction'

const cleanup: string[] = []

async function createRoot(): Promise<string> {
  const temporaryRoot = await fs.mkdtemp(join(tmpdir(), 'skillbuddy-instruction-transaction-'))
  const root = await fs.realpath(temporaryRoot)
  cleanup.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => fs.rm(path, { recursive: true, force: true })))
})

describe('instruction transactions', () => {
  it('refuses to replace a file changed after the plan snapshot', async () => {
    const root = await createRoot()
    const path = join(root, 'AGENTS.md')
    await fs.writeFile(path, 'before\n', 'utf8')
    const snapshot = await readInstructionSnapshot(path)
    await fs.writeFile(path, 'external\n', 'utf8')

    await expect(transactionalWriteInstruction({
      path,
      content: 'planned\n',
      expectedIdentity: snapshot?.identity ?? null,
    })).rejects.toThrow('其他程序修改')
    await expect(fs.readFile(path, 'utf8')).resolves.toBe('external\n')
  })

  it.runIf(process.platform !== 'win32')('deletes only a symlink entry', async () => {
    const root = await createRoot()
    const source = join(root, 'AGENTS.md')
    const link = join(root, 'CLAUDE.md')
    const tombstone = join(root, '.skillbuddy-deleted-test-CLAUDE.md')
    await fs.writeFile(source, '# Shared\n', 'utf8')
    await fs.symlink('AGENTS.md', link)
    const snapshot = await readInstructionSnapshot(link)

    await transactionalDeleteInstruction({
      path: link,
      tombstonePath: tombstone,
      expectedIdentity: snapshot?.identity ?? '',
    })

    await expect(fs.lstat(link)).rejects.toThrow()
    expect((await fs.lstat(tombstone)).isSymbolicLink()).toBe(true)
    await expect(fs.readFile(source, 'utf8')).resolves.toBe('# Shared\n')
  })

  it('restores a newly created project file within the undo window', async () => {
    const root = await createRoot()
    const backupRoot = join(root, 'backups')
    const path = join(root, 'AGENTS.md')
    const content = '# Created\n'
    const policy = new InstructionPathPolicy()
    policy.setState([root], [], [])
    const backups = new InstructionBackupStore(backupRoot)
    await backups.stage(
      'operation',
      'write',
      { path, scope: 'project', projectRoot: root },
      null,
      hashInstructionContent(Buffer.from(content)),
    )
    await transactionalWriteInstruction({
      path,
      content,
      expectedIdentity: null,
      createMode: 0o644,
    })

    const results = await backups.restore('operation', policy)

    expect(results).toEqual([{ path, ok: true }])
    await expect(fs.lstat(path)).rejects.toThrow()
  })
})
