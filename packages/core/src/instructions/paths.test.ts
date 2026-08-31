import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { deriveEffectiveInstructionChain } from './effective-chain.js'
import { instructionEffectiveDirectory } from './paths.js'
import { findInstructionProfile } from './profiles.js'
import { scanInstructionDocuments } from './scanner.js'

const cleanup: string[] = []

async function createProject(): Promise<string> {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'skillbuddy-paths-')))
  cleanup.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => fs.rm(path, { recursive: true, force: true })))
})

describe('instruction effective directory', () => {
  it('maps a nested candidate file back to the directory that owns it', async () => {
    const root = await createProject()
    await fs.mkdir(join(root, '.codebuddy'), { recursive: true })
    await fs.writeFile(join(root, '.codebuddy', 'CODEBUDDY.md'), '# nested\n', 'utf8')

    const scan = await scanInstructionDocuments([root], { includeGlobal: false })
    const document = scan.documents.find((item) => item.fileName === 'CODEBUDDY.md')
    const profile = findInstructionProfile({ vendorId: 'tencent', productId: 'codebuddy', surfaceId: 'cli' })

    expect(instructionEffectiveDirectory(document!, profile)).toBe(root)
    const chain = deriveEffectiveInstructionChain(profile!.key, root, root, scan.documents)
    expect(chain.documents.map((item) => item.path)).toContain(join(root, '.codebuddy', 'CODEBUDDY.md'))
  })

  it('maps a rules-directory file back to the directory that owns the rules folder', async () => {
    const root = await createProject()
    const rules = join(root, '.cursor', 'rules')
    await fs.mkdir(rules, { recursive: true })
    await fs.writeFile(join(rules, 'review.mdc'), '# rule\n', 'utf8')

    const scan = await scanInstructionDocuments([root], { includeGlobal: false })
    const document = scan.documents.find((item) => item.fileName === 'review.mdc')
    const profile = findInstructionProfile({ vendorId: 'cursor', productId: 'cursor', surfaceId: 'ide' })

    expect(instructionEffectiveDirectory(document!, profile)).toBe(root)
    const chain = deriveEffectiveInstructionChain(profile!.key, root, root, scan.documents)
    expect(chain.documents.map((item) => item.path)).toContain(join(rules, 'review.mdc'))
  })

  it('keeps plain project files and unknown profiles on their physical directory', async () => {
    const root = await createProject()
    const nested = join(root, 'src')
    await fs.mkdir(nested, { recursive: true })
    await fs.writeFile(join(nested, 'AGENTS.md'), '# leaf\n', 'utf8')

    const scan = await scanInstructionDocuments([root], { includeGlobal: false })
    const document = scan.documents.find((item) => item.fileName === 'AGENTS.md')
    const profile = findInstructionProfile({ vendorId: 'openai', productId: 'codex', surfaceId: 'cli' })

    expect(instructionEffectiveDirectory(document!, profile)).toBe(nested)
    expect(instructionEffectiveDirectory(document!, undefined)).toBe(nested)
  })
})
