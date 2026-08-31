import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { diagnoseInstructions, instructionStats } from './diagnostics.js'
import { scanInstructionDocuments } from './scanner.js'

const cleanup: string[] = []

async function createProject(): Promise<string> {
  const root = await fs.mkdtemp(join(tmpdir(), 'skillbuddy-diagnostics-'))
  cleanup.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => fs.rm(path, { recursive: true, force: true })))
})

describe('instruction diagnostics', () => {
  it('reports a missing Claude bridge and broken links', async () => {
    const root = await createProject()
    await fs.writeFile(join(root, 'AGENTS.md'), 'shared\n', 'utf8')
    const brokenDir = join(root, 'nested')
    await fs.mkdir(brokenDir)
    await fs.symlink('missing.md', join(brokenDir, 'AGENTS.md'))
    const scan = await scanInstructionDocuments([root], { includeGlobal: false })
    const diagnostics = await diagnoseInstructions(scan.documents)
    expect(diagnostics.map((item) => item.code)).toEqual(expect.arrayContaining(['broken-link', 'missing-claude-bridge']))
  })

  it('summarizes project, linked and read-only documents', async () => {
    const root = await createProject()
    await fs.writeFile(join(root, 'AGENTS.md'), 'shared\n', 'utf8')
    await fs.writeFile(join(root, 'CLAUDE.md'), '@AGENTS.md\n', 'utf8')
    const scan = await scanInstructionDocuments([root], { includeGlobal: false })
    const stats = instructionStats(scan.documents)
    expect(stats.total).toBe(2)
    expect(stats.project).toBe(2)
    expect(stats.global).toBe(0)
    expect(stats.linked).toBe(0)
    expect(stats.readOnly).toBe(0)
  })
})
