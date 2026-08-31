import { beforeEach, describe, expect, it, vi } from 'vitest'

const teamContributionPublish = vi.fn()
const teamContributionDiscard = vi.fn(async () => undefined)
const teamContributionCatalog = vi.fn(async () => ({ instructions: [] }))
const teamContributionDiff = vi.fn(async () => ({ files: [] }))
const teamContributionPrepare = vi.fn(async () => workspace)
const teamContributionList = vi.fn(async () => [])

const workspace = {
  id: 'ws-1',
  libraryId: 'acme',
  root: '/tmp/ws-1',
  remoteUrl: 'https://example.com/team.git',
  branch: 'skillbuddy/draft',
  baseBranch: 'main',
  baseRevision: 'abc',
  createdAt: 0,
  provider: 'github' as const,
}

vi.stubGlobal('window', {
  skillsManager: {
    teamContributionPublish,
    teamContributionDiscard,
    teamContributionCatalog,
    teamContributionDiff,
    teamContributionPrepare,
    teamContributionList,
  },
  localStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
})

const { useTeamLibraryManagement } = await import('./useTeamLibraryManagement')

describe('publishing a team library draft', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    teamContributionPrepare.mockResolvedValue(workspace)
  })

  it('ends the draft after a successful push so the next change starts a fresh branch', async () => {
    const manager = useTeamLibraryManagement()
    await manager.start({ remoteUrl: workspace.remoteUrl, branch: 'main' }, 'draft')
    expect(manager.workspace.value).not.toBeNull()

    teamContributionPublish.mockResolvedValue({
      pushed: true,
      provider: 'github',
      branch: workspace.branch,
      url: 'https://example.com/pr/1',
    })
    await manager.publish('feat: x', 'body')

    expect(teamContributionDiscard).toHaveBeenCalledWith(workspace.id)
    expect(manager.workspace.value).toBeNull()
    // PR 链接必须留着，否则用户拿不到刚创建的 PR 地址
    expect(manager.publishResult.value?.url).toBe('https://example.com/pr/1')
  })

  it('keeps the draft when the push did not happen', async () => {
    const manager = useTeamLibraryManagement()
    await manager.start({ remoteUrl: workspace.remoteUrl, branch: 'main' }, 'draft')

    teamContributionPublish.mockResolvedValue({ pushed: false, provider: 'github', branch: workspace.branch })
    await manager.publish('feat: x', 'body')

    expect(teamContributionDiscard).not.toHaveBeenCalled()
    expect(manager.workspace.value).not.toBeNull()
  })
})
