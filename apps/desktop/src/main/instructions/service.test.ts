import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_INSTRUCTION_FILE_BYTES } from '@skillbuddy/core'

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))

const { InstructionService } = await import('./service')

const cleanup: string[] = []

async function createRoot(prefix: string): Promise<string> {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), prefix)))
  cleanup.push(root)
  return root
}

async function createService(): Promise<InstanceType<typeof InstructionService>> {
  return new InstructionService(join(await createRoot('skillbuddy-service-backups-'), 'backups'))
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => fs.rm(path, { recursive: true, force: true })))
})

describe('InstructionService delete plans', () => {
  it('deletes a symlinked instruction file without reporting an external change', async () => {
    const root = await createRoot('skillbuddy-service-link-')
    const service = await createService()
    await fs.writeFile(join(root, 'AGENTS.md'), '# shared\n', 'utf8')
    await fs.symlink(join(root, 'AGENTS.md'), join(root, 'CLAUDE.md'))

    const scan = await service.scan([root])
    const document = scan.documents.find((item) => item.path === join(root, 'CLAUDE.md'))
    expect(document?.linked).toBe(true)

    const plan = await service.createDeletePlan({
      projectRoots: [root],
      path: document!.path,
      expectedHash: document!.contentHash,
    })

    expect(plan.blockers).toEqual([])
    expect(plan.warnings.map((warning) => warning.code)).toContain('delete-link-only')
    expect(plan.canApply).toBe(true)

    await expect(service.applyPlan(plan.planId)).resolves.toMatchObject({ ok: true })
    await expect(fs.lstat(join(root, 'CLAUDE.md'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.readFile(join(root, 'AGENTS.md'), 'utf8')).resolves.toBe('# shared\n')
  })

  it('deletes an oversized instruction file whose content was never hashed', async () => {
    const root = await createRoot('skillbuddy-service-large-')
    const service = await createService()
    const path = join(root, 'AGENTS.md')
    await fs.writeFile(path, 'x'.repeat(MAX_INSTRUCTION_FILE_BYTES + 1), 'utf8')

    const scan = await service.scan([root])
    const document = scan.documents.find((item) => item.path === path)
    expect(document?.contentTruncated).toBe(true)

    const plan = await service.createDeletePlan({
      projectRoots: [root],
      path,
      expectedHash: document!.contentHash,
    })

    expect(plan.blockers).toEqual([])
    expect(plan.canApply).toBe(true)
    await expect(service.applyPlan(plan.planId)).resolves.toMatchObject({ ok: true })
    await expect(fs.lstat(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('still blocks a delete whose document changed since the caller read it', async () => {
    const root = await createRoot('skillbuddy-service-stale-')
    const service = await createService()
    const path = join(root, 'AGENTS.md')
    await fs.writeFile(path, '# first\n', 'utf8')

    const scan = await service.scan([root])
    const document = scan.documents.find((item) => item.path === path)
    await fs.writeFile(path, '# second\n', 'utf8')

    const plan = await service.createDeletePlan({
      projectRoots: [root],
      path,
      expectedHash: document!.contentHash,
    })

    expect(plan.blockers.map((blocker) => blocker.code)).toContain('externally-changed')
    expect(plan.canApply).toBe(false)
  })
})

describe('applying a team instruction template', () => {
  it('creates a missing target and overwrites an outdated one after showing the diff', async () => {
    const root = await createRoot('skillbuddy-template-apply-')
    const service = await createService()
    const target = join(root, 'AGENTS.md')
    const content = '# Team baseline\n\n- Use pnpm.\n'
    await service.scan([root])

    const created = await service.createWritePlan({
      projectRoots: [root],
      path: target,
      content,
      expectedHash: null,
    })
    expect(created.blockers).toEqual([])
    expect(created.created).toBe(true)
    expect(created.afterText).toBe(content)
    await expect(service.applyPlan(created.planId)).resolves.toMatchObject({ ok: true })
    await expect(fs.readFile(target, 'utf8')).resolves.toBe(content)

    const scan = await service.scan([root])
    const document = scan.documents.find((item) => item.path === target)
    const updated = '# Team baseline v2\n\n- Use pnpm.\n'
    const overwrite = await service.createWritePlan({
      projectRoots: [root],
      path: target,
      content: updated,
      expectedHash: document!.contentHash,
    })
    expect(overwrite.blockers).toEqual([])
    expect(overwrite.beforeText).toBe(content)
    expect(overwrite.afterText).toBe(updated)
    await expect(service.applyPlan(overwrite.planId)).resolves.toMatchObject({ ok: true })
    await expect(fs.readFile(target, 'utf8')).resolves.toBe(updated)
  })

  it('refuses a template target that escapes the project or is not a known instruction file', async () => {
    const root = await createRoot('skillbuddy-template-escape-')
    const outside = await createRoot('skillbuddy-template-outside-')
    const service = await createService()
    await service.scan([root])

    const escaped = await service.createWritePlan({
      projectRoots: [root],
      path: join(outside, 'AGENTS.md'),
      content: '# evil\n',
      expectedHash: null,
    })
    expect(escaped.canApply).toBe(false)
    expect(escaped.blockers.map((blocker) => blocker.code)).toContain('invalid-target')

    const unknownName = await service.createWritePlan({
      projectRoots: [root],
      path: join(root, '.zshrc'),
      content: '# evil\n',
      expectedHash: null,
    })
    expect(unknownName.canApply).toBe(false)
    expect(unknownName.blockers.map((blocker) => blocker.code)).toContain('invalid-target')
  })
})
