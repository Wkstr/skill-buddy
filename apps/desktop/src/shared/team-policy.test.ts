import { describe, expect, it } from 'vitest'
import { emptyTeamPolicy, mergeTeamPolicies } from './team-policy'

describe('team instruction policies', () => {
  it('merges required and recommended instruction templates across scopes', () => {
    const organization = emptyTeamPolicy()
    organization.required.instructions.push('instructions/baseline.md')
    const team = emptyTeamPolicy()
    team.recommended.instructions.push('instructions/frontend.md')

    expect(mergeTeamPolicies(organization, team)).toMatchObject({
      required: { instructions: ['instructions/baseline.md'] },
      recommended: { instructions: ['instructions/frontend.md'] },
    })
  })
})
