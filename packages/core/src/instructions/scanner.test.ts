import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { diagnoseInstructions } from './diagnostics.js'
import { scanInstructionDocuments } from './scanner.js'

const cleanup: string[] = []

async function createProject(): Promise<string> {
  const root = await fs.mkdtemp(join(tmpdir(), 'skillbuddy-instructions-'))
  cleanup.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => fs.rm(path, { recursive: true, force: true })))
})

describe('instruction bridge scanning', () => {
  it('recognizes an AGENTS.md Markdown import as a Claude Code bridge', async () => {
    const root = await createProject()
    await fs.writeFile(join(root, 'AGENTS.md'), '# Shared\n', 'utf8')
    await fs.writeFile(join(root, 'CLAUDE.md'), '@AGENTS.md\n', 'utf8')

    const result = await scanInstructionDocuments([root], { includeGlobal: false })
    const claude = result.documents.find((document) => document.fileName === 'CLAUDE.md')
    const diagnostics = await diagnoseInstructions(result.documents)

    expect(claude?.bindings).toContainEqual(expect.objectContaining({
      surface: expect.objectContaining({ productId: 'claude-code' }),
      status: 'bridged',
    }))
    expect(diagnostics.map((diagnostic) => diagnostic.code)).not.toContain('missing-claude-bridge')
    expect(diagnostics.map((diagnostic) => diagnostic.code)).not.toContain('claude-bridge-conflict')
  })

  it('marks an independent CLAUDE.md as a conflict without rewriting it', async () => {
    const root = await createProject()
    await fs.writeFile(join(root, 'AGENTS.md'), '# Shared\n', 'utf8')
    await fs.writeFile(join(root, 'CLAUDE.md'), '# Claude only\n', 'utf8')

    const result = await scanInstructionDocuments([root], { includeGlobal: false })
    const claude = result.documents.find((document) => document.fileName === 'CLAUDE.md')
    const diagnostics = await diagnoseInstructions(result.documents)

    expect(claude?.bindings).toContainEqual(expect.objectContaining({
      surface: expect.objectContaining({ productId: 'claude-code' }),
      status: 'conflict',
    }))
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
      expect.arrayContaining(['claude-bridge-conflict', 'drifted']),
    )
  })

  it('does not treat invalid UTF-8 as a valid import bridge', async () => {
    const root = await createProject()
    await fs.writeFile(join(root, 'AGENTS.md'), '# Shared\n', 'utf8')
    await fs.writeFile(
      join(root, 'CLAUDE.md'),
      Buffer.concat([Buffer.from('@AGENTS.md\n'), Buffer.from([0xff])]),
    )

    const result = await scanInstructionDocuments([root], { includeGlobal: false })
    const claude = result.documents.find((document) => document.fileName === 'CLAUDE.md')

    expect(claude?.encodingInvalid).toBe(true)
    expect(claude?.bindings).toContainEqual(expect.objectContaining({
      surface: expect.objectContaining({ productId: 'claude-code' }),
      status: 'conflict',
    }))
  })
})

describe('instruction scanner boundaries', () => {
  it('honors maxDepth and ignores default excluded directories', async () => {
    const root = await createProject()
    await fs.mkdir(join(root, 'nested', 'deep'), { recursive: true })
    await fs.mkdir(join(root, 'node_modules', 'ignored'), { recursive: true })
    await fs.writeFile(join(root, 'AGENTS.md'), 'root\n', 'utf8')
    await fs.writeFile(join(root, 'nested', 'AGENTS.md'), 'nested\n', 'utf8')
    await fs.writeFile(join(root, 'nested', 'deep', 'AGENTS.md'), 'deep\n', 'utf8')
    await fs.writeFile(join(root, 'node_modules', 'ignored', 'AGENTS.md'), 'ignored\n', 'utf8')

    const shallow = await scanInstructionDocuments([root], { includeGlobal: false, maxDepth: 1 })
    const realRoot = await fs.realpath(root)
    expect(shallow.documents.map((item) => item.path)).toEqual([join(realRoot, 'AGENTS.md'), join(realRoot, 'nested', 'AGENTS.md')])

    const full = await scanInstructionDocuments([root], { includeGlobal: false })
    expect(full.documents.map((item) => item.path)).toEqual([
      join(realRoot, 'AGENTS.md'),
      join(realRoot, 'nested', 'AGENTS.md'),
      join(realRoot, 'nested', 'deep', 'AGENTS.md'),
    ])
  })

  it('scans markdown files under registered rules directories', async () => {
    const root = await createProject()
    const rules = join(root, '.cursor', 'rules')
    await fs.mkdir(rules, { recursive: true })
    await fs.writeFile(join(rules, 'review.mdc'), 'rule\n', 'utf8')
    await fs.writeFile(join(rules, 'notes.txt'), 'ignored\n', 'utf8')

    const result = await scanInstructionDocuments([root], { includeGlobal: false })
    expect(result.documents.map((item) => item.fileName)).toContain('review.mdc')
    expect(result.documents.map((item) => item.fileName)).not.toContain('notes.txt')
    expect(result.documents.find((item) => item.fileName === 'review.mdc')?.bindings).toContainEqual(
      expect.objectContaining({ surface: expect.objectContaining({ productId: 'cursor' }), role: 'primary' }),
    )
  })

  it.runIf(process.platform !== 'win32')('marks a symlink escaping the project as broken and read-only', async () => {
    const root = await createProject()
    const outside = await createProject()
    await fs.writeFile(join(outside, 'AGENTS.md'), 'outside\n', 'utf8')
    await fs.symlink(join(outside, 'AGENTS.md'), join(root, 'AGENTS.md'))

    const result = await scanInstructionDocuments([root], { includeGlobal: false })
    const document = result.documents.find((item) => item.fileName === 'AGENTS.md')
    expect(document?.linkBroken).toBe(true)
    expect(document?.readOnly).toBe(true)
    expect(document?.bindings).toContainEqual(expect.objectContaining({ status: 'link-broken' }))
  })
})
