import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { InstructionRuleProfile } from '@skillbuddy/core'
import { InstructionPathPolicy } from './path-policy'

const cleanup: string[] = []

async function createRoot(): Promise<string> {
  const root = await fs.mkdtemp(join(tmpdir(), 'skillbuddy-policy-'))
  cleanup.push(root)
  return root
}

function profile(globalPath: string): InstructionRuleProfile {
  return {
    key: { vendorId: 'test', productId: 'test', surfaceId: 'cli' },
    displayName: 'Test',
    platformId: null,
    globalPaths: [globalPath],
    projectFileCandidates: ['AGENTS.md', 'CLAUDE.md'],
    localOverlayCandidates: [],
    projectFallbacks: [],
    bridgeStrategies: ['markdown-import'],
    supportsNested: true,
    traversal: 'merge-root-to-leaf',
    sameDirectoryPrecedence: ['AGENTS.md'],
    evidence: 'official',
  }
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => fs.rm(path, { recursive: true, force: true })))
})

describe('InstructionPathPolicy', () => {
  it('allows registered global paths and project files only', async () => {
    const root = await createRoot()
    const realRoot = await fs.realpath(root)
    const globalPath = join(root, 'global', 'AGENTS.md')
    await fs.mkdir(join(root, 'global'))
    const policy = new InstructionPathPolicy()
    policy.setState([realRoot], [], [profile(globalPath)])

    await expect(policy.assertWriteTarget(globalPath)).resolves.toMatchObject({ scope: 'user', path: globalPath })
    await expect(policy.assertWriteTarget(join(realRoot, 'AGENTS.md'))).resolves.toMatchObject({ scope: 'project', projectRoot: realRoot })
    await expect(policy.assertWriteTarget(join(root, 'README.md'))).rejects.toThrow('不支持创建')
  })

  it('rejects project targets whose parent resolves outside the project', async () => {
    const root = await createRoot()
    const realRoot = await fs.realpath(root)
    const outside = await createRoot()
    await fs.symlink(outside, join(root, 'linked-dir'))
    const policy = new InstructionPathPolicy()
    policy.setState([realRoot], [], [profile(join(root, 'global', 'AGENTS.md'))])

    await expect(policy.assertWriteTarget(join(root, 'linked-dir', 'AGENTS.md'))).rejects.toThrow('不在已登记项目中')
    await expect(policy.assertRestoreTarget({ path: join(root, 'linked-dir', 'AGENTS.md'), scope: 'project', projectRoot: realRoot })).rejects.toThrow('越出项目目录')
  })

  it('requires bridge targets to remain in the same project', async () => {
    const root = await createRoot()
    const realRoot = await fs.realpath(root)
    const source = join(root, 'AGENTS.md')
    const policy = new InstructionPathPolicy()
    policy.setState([realRoot], [{
      id: source,
      kind: 'agents',
      fileName: 'AGENTS.md',
      path: source,
      scope: 'project',
      projectRoot: realRoot,
      bindings: [],
      contentHash: 'hash',
      modifiedAt: 0,
      size: 1,
      readOnly: false,
      linked: false,
    }], [profile(join(root, 'global', 'AGENTS.md'))])

    await expect(policy.assertBridgeTarget(source)).resolves.toMatchObject({ target: { path: join(root, 'CLAUDE.md'), scope: 'project' } })
  })
})
