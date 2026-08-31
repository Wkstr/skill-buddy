import { describe, expect, it } from 'vitest'
import { normalizeTeamProjectConfig } from './team-project'

describe('team project instruction requirements', () => {
  it('normalizes instruction requirements and project policy', () => {
    expect(normalizeTeamProjectConfig({
      version: 1,
      library: 'engineering',
      teams: [],
      requires: {
        bundles: [],
        skills: [],
        mcp: [],
        instructions: ['instructions/baseline.md'],
      },
      policy: {
        required: { instructions: ['instructions/security.md'] },
        recommended: { instructions: ['instructions/frontend.md'] },
        blocked: [],
      },
    })).toMatchObject({
      requires: { instructions: ['instructions/baseline.md'] },
      policy: {
        required: { skills: [], mcp: [], instructions: ['instructions/security.md'] },
        recommended: { skills: [], mcp: [], instructions: ['instructions/frontend.md'] },
      },
    })
  })

  it('keeps version 1 project files without instruction fields backward compatible', () => {
    expect(normalizeTeamProjectConfig({
      version: 1,
      teams: [],
      requires: { bundles: [], skills: [], mcp: [] },
    }).requires.instructions).toEqual([])
  })
})
