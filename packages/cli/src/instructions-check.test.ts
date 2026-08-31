import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkProjectInstructions } from './instructions-check.js'

const cleanup: string[] = []

async function fixture(): Promise<{ libraryRoot: string; projectRoot: string }> {
  const root = await fs.mkdtemp(join(tmpdir(), 'skillbuddy-instruction-check-'))
  cleanup.push(root)
  const libraryRoot = join(root, 'library')
  const projectRoot = join(root, 'project')
  await fs.mkdir(join(libraryRoot, 'instructions'), { recursive: true })
  await fs.mkdir(join(libraryRoot, 'policies'), { recursive: true })
  await fs.mkdir(join(projectRoot, '.skillbuddy'), { recursive: true })
  await fs.writeFile(
    join(libraryRoot, 'team-library.yaml'),
    'version: 1\nid: engineering\nname: Engineering\npolicies:\n  organization: policies/organization.yaml\n',
    'utf8',
  )
  await fs.writeFile(
    join(libraryRoot, 'policies', 'organization.yaml'),
    'required:\n  instructions:\n    - instructions/baseline.md\nrecommended:\n  instructions: []\nblocked: []\n',
    'utf8',
  )
  await fs.writeFile(
    join(libraryRoot, 'instructions', 'baseline.md'),
    '---\nid: baseline\nname: Baseline\ndescription: Shared rules\ntarget: AGENTS.md\n---\n\n# Rules\n',
    'utf8',
  )
  await fs.writeFile(
    join(projectRoot, '.skillbuddy', 'team.yaml'),
    'version: 1\nlibrary: engineering\nteams: []\nrequires:\n  bundles: []\n  skills: []\n  mcp: []\n  instructions: []\n',
    'utf8',
  )
  await fs.writeFile(join(projectRoot, 'AGENTS.md'), '# Rules\n', 'utf8')
  return { libraryRoot, projectRoot }
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => fs.rm(path, { recursive: true, force: true })))
})

describe('instruction policy check', () => {
  it('passes when a required project instruction matches the team template', async () => {
    const input = await fixture()

    const result = await checkProjectInstructions(input)

    expect(result.compliant).toBe(true)
    expect(result.items).toEqual([
      expect.objectContaining({
        ref: 'instructions/baseline.md',
        state: 'satisfied',
        recommended: false,
      }),
    ])
  })

  it('fails when the required project instruction has drifted', async () => {
    const input = await fixture()
    await fs.writeFile(join(input.projectRoot, 'AGENTS.md'), '# Local override\n', 'utf8')

    const result = await checkProjectInstructions(input)

    expect(result.compliant).toBe(false)
    expect(result.items[0]?.state).toBe('outdated')
  })
})
