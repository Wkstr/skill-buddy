import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  discoverClaudePluginRoots,
  discoverCodexSupplementalRoots,
  discoverLingxiSupplementalRoots,
  discoverOmpSupplementalRoots,
  discoverPiSupplementalRoots,
  scanInstalledSkills,
  type SkillRoot,
} from './scanner.js'

const cleanup: string[] = []

async function tempHome(): Promise<string> {
  const path = await fs.mkdtemp(join(tmpdir(), 'skillbuddy-scanner-'))
  cleanup.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => fs.rm(path, { recursive: true, force: true })))
})

describe('supplemental skill roots', () => {
  it('discovers the shared user Skills roots loaded by OMP as read-only', async () => {
    const home = await tempHome()
    const installedPlugin = join(home, '.claude', 'plugins', 'cache', 'market', 'installed', '1.0.0')
    const manifestPath = join(home, '.claude', 'plugins', 'installed_plugins.json')
    await fs.mkdir(dirname(manifestPath), { recursive: true })
    await fs.writeFile(
      manifestPath,
      JSON.stringify({
        plugins: {
          'installed@market': [{ scope: 'user', installPath: installedPlugin }],
        },
      }),
      'utf8',
    )

    expect(await discoverOmpSupplementalRoots(home)).toEqual([
      {
        agent: 'omp',
        scope: 'user',
        path: join(home, '.agent', 'skills'),
        origin: 'legacy',
        readOnly: true,
        canToggle: false,
      },
      {
        agent: 'omp',
        scope: 'user',
        path: join(home, '.agents', 'skills'),
        origin: 'legacy',
        readOnly: true,
        canToggle: false,
      },
      {
        agent: 'omp',
        scope: 'user',
        path: join(home, '.claude', 'skills'),
        origin: 'legacy',
        readOnly: true,
        canToggle: false,
      },
      {
        agent: 'omp',
        scope: 'user',
        path: join(home, '.codex', 'skills'),
        origin: 'legacy',
        readOnly: true,
        canToggle: false,
      },
      {
        agent: 'omp',
        scope: 'user',
        path: join(home, '.omp', 'agent', 'managed-skills'),
        origin: 'legacy',
        readOnly: true,
        canToggle: false,
      },
      {
        agent: 'omp',
        scope: 'user',
        path: join(installedPlugin, 'skills'),
        origin: 'plugin',
        readOnly: true,
        canToggle: false,
      },
    ])
  })

  it('scans Skills loaded by OMP from shared and plugin roots', async () => {
    const home = await tempHome()
    const sharedSkill = join(home, '.agents', 'skills', 'shared-skill')
    const installedPlugin = join(home, '.claude', 'plugins', 'cache', 'market', 'plugin', '1.0.0')
    const pluginSkill = join(installedPlugin, 'skills', 'plugin-skill')
    const manifestPath = join(home, '.claude', 'plugins', 'installed_plugins.json')
    await fs.mkdir(sharedSkill, { recursive: true })
    await fs.mkdir(pluginSkill, { recursive: true })
    await fs.writeFile(
      join(sharedSkill, 'SKILL.md'),
      '---\nname: shared-skill\ndescription: Shared OMP Skill\n---\n',
    )
    await fs.writeFile(
      join(pluginSkill, 'SKILL.md'),
      '---\nname: plugin-skill\ndescription: Plugin OMP Skill\n---\n',
    )
    await fs.mkdir(dirname(manifestPath), { recursive: true })
    await fs.writeFile(
      manifestPath,
      JSON.stringify({
        plugins: {
          'plugin@market': [{ scope: 'user', installPath: installedPlugin }],
        },
      }),
      'utf8',
    )

    const roots = await discoverOmpSupplementalRoots(home)
    const installations = await scanInstalledSkills([], roots)

    expect(installations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agent: 'omp',
          path: sharedSkill,
          readOnly: true,
          skill: expect.objectContaining({ name: 'shared-skill' }),
        }),
        expect.objectContaining({
          agent: 'omp',
          path: pluginSkill,
          readOnly: true,
          skill: expect.objectContaining({ name: 'plugin-skill' }),
        }),
      ]),
    )
  })

  it('discovers the shared user Skills root loaded by Pi as read-only', async () => {
    const home = await tempHome()

    expect(discoverPiSupplementalRoots(home)).toEqual([
      {
        agent: 'pi',
        scope: 'user',
        path: join(home, '.agents', 'skills'),
        origin: 'legacy',
        readOnly: true,
        canToggle: false,
      },
    ])
  })

  it('discovers Codex legacy, system, admin and latest plugin roots', async () => {
    const home = await tempHome()
    const codexHome = join(home, '.codex')
    const oldVersion = join(codexHome, 'plugins', 'cache', 'market', 'plugin', '1.0.0')
    const newVersion = join(codexHome, 'plugins', 'cache', 'market', 'plugin', '2.0.0')
    await fs.mkdir(join(oldVersion, 'skills'), { recursive: true })
    await fs.mkdir(join(newVersion, 'skills'), { recursive: true })
    await fs.utimes(oldVersion, new Date(1_000), new Date(1_000))
    await fs.utimes(newVersion, new Date(2_000), new Date(2_000))

    const roots = await discoverCodexSupplementalRoots(home, codexHome)

    expect(roots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: join(codexHome, 'skills'),
          origin: 'legacy',
          readOnly: true,
        }),
        expect.objectContaining({
          path: join(codexHome, 'skills', '.system'),
          origin: 'system',
          readOnly: true,
        }),
        expect.objectContaining({
          path: '/etc/codex/skills',
          origin: 'admin',
          readOnly: true,
        }),
        expect.objectContaining({
          path: join(newVersion, 'skills'),
          origin: 'plugin',
          readOnly: true,
        }),
      ]),
    )
    expect(roots.some((root) => root.path === join(oldVersion, 'skills'))).toBe(false)
    expect(roots.some((root) => root.path.includes('.tmp'))).toBe(false)
  })

  it('discovers only Claude plugins listed in installed_plugins.json', async () => {
    const home = await tempHome()
    const installedPath = join(home, '.claude', 'plugins', 'cache', 'market', 'installed', '1.0.0')
    const marketplacePath = join(
      home,
      '.claude',
      'plugins',
      'marketplaces',
      'market',
      'plugins',
      'not-installed',
    )
    const manifestPath = join(home, '.claude', 'plugins', 'installed_plugins.json')
    await fs.mkdir(join(installedPath, 'skills'), { recursive: true })
    await fs.mkdir(join(marketplacePath, 'skills'), { recursive: true })
    await fs.mkdir(dirname(manifestPath), { recursive: true })
    await fs.writeFile(
      manifestPath,
      JSON.stringify({
        plugins: {
          'installed@market': [
            { scope: 'user', installPath: installedPath, version: '1.0.0' },
          ],
        },
      }),
      'utf8',
    )

    const roots = await discoverClaudePluginRoots(home)

    expect(roots).toEqual([
      expect.objectContaining({
        path: join(installedPath, 'skills'),
        origin: 'plugin',
        readOnly: true,
      }),
    ])
    expect(roots.some((root) => root.path.startsWith(marketplacePath))).toBe(false)
  })

  it('preserves Claude project plugin scope from the installed manifest', async () => {
    const home = await tempHome()
    const installPath = join(home, '.claude', 'plugins', 'cache', 'market', 'local', '1.0.0')
    const projectPath = join(home, 'project')
    const manifestPath = join(home, '.claude', 'plugins', 'installed_plugins.json')
    await fs.mkdir(dirname(manifestPath), { recursive: true })
    await fs.writeFile(
      manifestPath,
      JSON.stringify({
        plugins: {
          'local@market': [{ scope: 'local', installPath, projectPath }],
        },
      }),
      'utf8',
    )

    expect(await discoverClaudePluginRoots(home)).toEqual([
      expect.objectContaining({
        scope: 'project',
        projectRoot: projectPath,
        path: join(installPath, 'skills'),
      }),
    ])
  })
})

describe('scanInstalledSkills', () => {
  it('保留调用方传入的未注册平台根', async () => {
    const home = await tempHome()
    const root = join(home, 'custom-skills')
    await fs.mkdir(join(root, 'custom-skill'), { recursive: true })
    await fs.writeFile(
      join(root, 'custom-skill', 'SKILL.md'),
      '---\nname: custom-skill\ndescription: test\n---\n',
    )
    const roots: SkillRoot[] = [
      {
        agent: 'custom-agent',
        scope: 'user',
        path: root,
        origin: 'user',
        readOnly: false,
      },
    ]

    expect(await scanInstalledSkills([], roots)).toEqual([
      expect.objectContaining({ agent: 'custom-agent', path: join(root, 'custom-skill') }),
    ])
  })

  it('单个损坏的 Skill 不阻断同一根目录下的其他 Skill，并被标记为解析失败', async () => {
    const home = await tempHome()
    const root = join(home, 'custom-skills')
    await fs.mkdir(join(root, 'broken'), { recursive: true })
    await fs.mkdir(join(root, 'healthy'), { recursive: true })
    await fs.writeFile(
      join(root, 'broken', 'SKILL.md'),
      '---\nname: broken\ndescription: invalid: yaml\n---\n',
      'utf8',
    )
    await fs.writeFile(
      join(root, 'healthy', 'SKILL.md'),
      '---\nname: healthy\ndescription: ok\n---\n',
      'utf8',
    )
    const roots: SkillRoot[] = [
      { agent: 'custom-agent', scope: 'user', path: root, origin: 'user', readOnly: false },
    ]

    const skills = await scanInstalledSkills([], roots)
    // 损坏的 Skill 不再被静默丢弃，而是带上 parseError 一并返回，
    // 这样界面能提示用户去修文件；健康的 Skill 不受影响。
    expect(skills).toHaveLength(2)
    const healthy = skills.find((item) => item.path === join(root, 'healthy'))
    const broken = skills.find((item) => item.path === join(root, 'broken'))
    expect(healthy?.parseError).toBeUndefined()
    expect(healthy?.skill.description).toBe('ok')
    expect(broken?.parseError).toEqual(
      expect.objectContaining({ path: join(root, 'broken', 'SKILL.md') }),
    )
  })
})

describe('discoverLingxiSupplementalRoots', () => {
  it.each([
    ['darwin', ['Library', 'Application Support', 'WPS 灵犀']],
    ['win32', ['AppData', 'Roaming', 'WPS 灵犀']],
    ['linux', ['.config', 'WPS 灵犀']],
  ] as const)('points at the bundled official_skills dir on %s', (os, segments) => {
    expect(discoverLingxiSupplementalRoots('/home/test', os)).toEqual([
      {
        agent: 'wps-lingxi',
        scope: 'user',
        path: join('/home/test', ...segments, 'serverdir', 'official_skills'),
        origin: 'system',
        readOnly: true,
        canToggle: false,
      },
    ])
  })
})
