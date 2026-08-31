import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
  shell: { openPath: async () => '' },
}))

const { runTeamContributionCommand, providerOf } = await import('./team-contribution')

const execFileAsync = promisify(execFile)
const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => fs.rm(path, { recursive: true, force: true })))
})

/** 复刻 teamContributionDiff 中按固定列切割状态码的解析方式。 */
function parsePorcelain(status: string): string[] {
  return status.split('\n').flatMap((line) => {
    if (!line.trim()) return []
    const raw = line.slice(3).trim()
    return [raw.includes(' -> ') ? raw.split(' -> ').at(-1)! : raw]
  })
}

describe('runTeamContributionCommand', () => {
  it('keeps the leading column of git status so paths are not shifted', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'skillbuddy-contribution-status-'))
    cleanup.push(root)
    const git = (...args: string[]) => execFileAsync('git', args, { cwd: root })
    await git('init', '-q', '.')
    await git('config', 'user.email', 'test@example.com')
    await git('config', 'user.name', 'test')
    await fs.mkdir(join(root, 'instructions'))
    await fs.writeFile(join(root, 'instructions', 'base.md'), 'first\n', 'utf8')
    await git('add', '--all')
    await git('commit', '-qm', 'init')

    // 仅改工作区不暂存，状态码首列为空，整行以空格开头。
    await fs.writeFile(join(root, 'instructions', 'base.md'), 'first\nsecond\n', 'utf8')
    await fs.writeFile(join(root, 'instructions', 'added.md'), 'new\n', 'utf8')
    await git('add', '--intent-to-add', '--all')

    const preserved = await runTeamContributionCommand(
      'git', ['status', '--porcelain'], root, 30_000, true,
    )
    expect(parsePorcelain(preserved).sort()).toEqual([
      'instructions/added.md',
      'instructions/base.md',
    ])

    // 全局 trim 会削掉首行的状态码空列，使该行路径整体错位一格。
    const trimmed = await runTeamContributionCommand('git', ['status', '--porcelain'], root)
    const shifted = parsePorcelain(trimmed)
    expect(shifted).not.toEqual(parsePorcelain(preserved))
    expect(shifted.some((path) => path.startsWith('nstructions/'))).toBe(true)
  })
})

/** 复刻 availableContributionBranch 的选名逻辑，验证与真实远端交互的结果。 */
async function pickBranch(root: string, slug: string): Promise<string> {
  const listed = await runTeamContributionCommand(
    'git', ['ls-remote', '--heads', 'origin', `refs/heads/skillbuddy/${slug}*`], root, 30_000,
  ).catch(() => '')
  const taken = new Set(
    listed.split('\n')
      .map((line) => line.split('\t').at(-1)?.replace('refs/heads/', '').trim())
      .filter((name): name is string => Boolean(name)),
  )
  const base = `skillbuddy/${slug}`
  if (!taken.has(base)) return base
  for (let index = 2; index <= 99; index += 1) {
    if (!taken.has(`${base}-${index}`)) return `${base}-${index}`
  }
  throw new Error('exhausted')
}

describe('choosing a draft branch name', () => {
  it('avoids branch names the remote already has so a later push is not rejected', async () => {
    const remote = await fs.mkdtemp(join(tmpdir(), 'skillbuddy-branch-remote-'))
    cleanup.push(remote)
    await execFileAsync('git', ['init', '-q', '--bare', '--initial-branch', 'main', '.'], { cwd: remote })

    const work = await fs.mkdtemp(join(tmpdir(), 'skillbuddy-branch-work-'))
    cleanup.push(work)
    const root = join(work, 'repository')
    await execFileAsync('git', ['clone', '-q', remote, root])
    const git = (...args: string[]) => execFileAsync('git', args, { cwd: root })
    await git('config', 'user.email', 'test@example.com')
    await git('config', 'user.name', 'test')
    await fs.writeFile(join(root, 'a.md'), 'v1\n', 'utf8')
    await git('add', '--all')
    await git('commit', '-qm', 'init')
    await git('push', '-q', 'origin', 'HEAD:main')

    // 第一轮：默认标识可用
    expect(await pickBranch(root, 'manage-team-library')).toBe('skillbuddy/manage-team-library')

    await git('checkout', '-qb', 'skillbuddy/manage-team-library')
    await git('push', '-q', 'origin', 'skillbuddy/manage-team-library')

    // 第二轮：同一个标识已被占用，自动让位
    expect(await pickBranch(root, 'manage-team-library')).toBe('skillbuddy/manage-team-library-2')

    await git('push', '-q', 'origin', 'skillbuddy/manage-team-library:skillbuddy/manage-team-library-2')

    // 第三轮继续顺延，且不会被前缀相同的分支干扰
    expect(await pickBranch(root, 'manage-team-library')).toBe('skillbuddy/manage-team-library-3')
    expect(await pickBranch(root, 'other-change')).toBe('skillbuddy/other-change')
  })
})

describe('providerOf', () => {
  it.each([
    ['https://github.com/acme/library.git', 'github'],
    ['git@gitlab.com:acme/library.git', 'gitlab'],
    ['https://gitee.com/acme/library.git', 'gitee'],
    // 自建实例：gh 与 glab 都支持企业版主机，识别不出等于永远创建不了 PR/MR。
    ['https://gitlab.acme.com/team/library.git', 'gitlab'],
    ['git@github.acme.com:team/library.git', 'github'],
    ['https://acme.ghe.com/team/library.git', 'github'],
  ])('把 %s 识别为 %s', (remoteUrl, expected) => {
    expect(providerOf(remoteUrl)).toBe(expected)
  })

  it.each([
    'https://my-github-mirror.com/acme/library.git',
    'https://git.acme.com/team/library.git',
    'not a url',
  ])('不把无关远程地址 %s 误判成已知平台', (remoteUrl) => {
    expect(providerOf(remoteUrl)).toBe('unsupported')
  })
})
