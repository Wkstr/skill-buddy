import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { deriveEffectiveInstructionChain } from './effective-chain.js'
import { findInstructionProfile } from './profiles.js'
import { scanInstructionDocuments } from './scanner.js'

const cleanup: string[] = []

async function createProject(): Promise<string> {
  const root = await fs.mkdtemp(join(tmpdir(), 'skillbuddy-effective-'))
  cleanup.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => fs.rm(path, { recursive: true, force: true })))
})

describe('effective instruction chains', () => {
  it('merges project instructions from root to target and keeps global optional', async () => {
    const root = await createProject()
    const nested = join(root, 'src')
    await fs.mkdir(nested)
    await fs.writeFile(join(root, 'AGENTS.md'), 'root\n', 'utf8')
    await fs.writeFile(join(nested, 'AGENTS.md'), 'nested\n', 'utf8')
    const scan = await scanInstructionDocuments([root], { includeGlobal: false })
    const realRoot = await fs.realpath(root)
    const realNested = await fs.realpath(nested)
    const profile = findInstructionProfile({ vendorId: 'openai', productId: 'codex', surfaceId: 'cli' })
    if (!profile) throw new Error('missing codex profile')

    const chain = deriveEffectiveInstructionChain(profile.key, realRoot, realNested, scan.documents)
    expect(chain.documents.map((item) => item.path)).toEqual([
      join(realRoot, 'AGENTS.md'),
      join(realNested, 'AGENTS.md'),
    ])
    expect(chain.includesGlobal).toBe(false)
  })

  it('uses the nearest matching file for OpenCode fallback traversal', async () => {
    const root = await createProject()
    const nested = join(root, 'packages', 'app')
    await fs.mkdir(nested, { recursive: true })
    await fs.writeFile(join(root, 'AGENTS.md'), 'root\n', 'utf8')
    await fs.writeFile(join(nested, 'CLAUDE.md'), 'app\n', 'utf8')
    const scan = await scanInstructionDocuments([root], { includeGlobal: false })
    const realRoot = await fs.realpath(root)
    const realNested = await fs.realpath(nested)
    const chain = deriveEffectiveInstructionChain(
      { vendorId: 'sst', productId: 'opencode', surfaceId: 'cli' },
      realRoot,
      realNested,
      scan.documents,
    )
    expect(chain.documents.map((item) => item.path)).toEqual([join(realNested, 'CLAUDE.md')])
  })

  it('blocks targets outside the project and unknown surfaces', async () => {
    const root = await createProject()
    const scan = await scanInstructionDocuments([root], { includeGlobal: false })
    const outside = deriveEffectiveInstructionChain(
      { vendorId: 'openai', productId: 'codex', surfaceId: 'cli' },
      root,
      join(root, '..', 'outside'),
      scan.documents,
    )
    expect(outside.warnings.map((warning) => warning.code)).toContain('target-outside-project')

    const unknown = deriveEffectiveInstructionChain(
      { vendorId: 'unknown', productId: 'unknown', surfaceId: 'unknown' },
      root,
      root,
      scan.documents,
    )
    expect(unknown.warnings.map((warning) => warning.code)).toContain('unknown-surface')
  })
})
