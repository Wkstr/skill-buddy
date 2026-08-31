import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { BUILTIN_PLATFORMS, type PlatformDef } from '../platforms.js'
import type { InstallScope, SkillRoot } from '../types.js'
import { PlatformAdapter } from './platform-adapter.js'

interface ClaudePluginRecord {
  scope?: string
  installPath?: string
  projectPath?: string
  enabled?: boolean
}

export interface OmpEnvironment {
  OMP_PROFILE?: string
  PI_PROFILE?: string
  PI_CONFIG_DIR?: string
  PI_CODING_AGENT_DIR?: string
  XDG_DATA_HOME?: string
}

type PluginRegistry = { plugins?: Record<string, ClaudePluginRecord[]> }

interface EnabledPluginOverrides {
  user: Map<string, boolean>
  projects: Map<string, Map<string, boolean>>
}

function activeProfile(env: OmpEnvironment): string | undefined {
  const value = (env.OMP_PROFILE !== undefined ? env.OMP_PROFILE : env.PI_PROFILE)?.trim()
  return value && value !== 'default' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(value)
    ? value
    : undefined
}

function ompBaseConfigRoot(homeDir: string, env: OmpEnvironment): string {
  return join(homeDir, env.PI_CONFIG_DIR || '.omp')
}

function ompConfigRoot(homeDir: string, env: OmpEnvironment): string {
  const root = ompBaseConfigRoot(homeDir, env)
  const profile = activeProfile(env)
  return profile ? join(root, 'profiles', profile) : root
}

/** Resolve the same profile-aware native agent directory used by OMP. */
export function resolveOmpAgentDir(homeDir: string, env: OmpEnvironment = process.env): string {
  const profile = activeProfile(env)
  if (profile) return join(ompConfigRoot(homeDir, env), 'agent')
  if (env.PI_CODING_AGENT_DIR) {
    return isAbsolute(env.PI_CODING_AGENT_DIR)
      ? env.PI_CODING_AGENT_DIR
      : resolve(homeDir, env.PI_CODING_AGENT_DIR)
  }
  return join(ompBaseConfigRoot(homeDir, env), 'agent')
}

function supplementalRoot(
  agent: SkillRoot['agent'],
  path: string,
  scope: InstallScope = 'user',
  projectRoot?: string,
  origin: SkillRoot['origin'] = 'shared',
): SkillRoot {
  return { agent, scope, path, projectRoot, origin, readOnly: true, canToggle: false }
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(path, 'utf8')) as T
  } catch {
    return null
  }
}

async function readEnabledPluginOverrides(paths: string[]): Promise<Map<string, boolean>> {
  const result = new Map<string, boolean>()
  for (const path of paths) {
    const settings = await readJson<{ enabledPlugins?: Record<string, unknown> }>(path)
    for (const [id, enabled] of Object.entries(settings?.enabledPlugins ?? {})) {
      if (typeof enabled === 'boolean') result.set(id, enabled)
    }
  }
  return result
}

async function enabledPluginOverrides(
  homeDir: string,
  projectRoots: string[],
): Promise<EnabledPluginOverrides> {
  const user = await readEnabledPluginOverrides([join(homeDir, '.claude', 'settings.json')])
  const projects = new Map<string, Map<string, boolean>>()
  await Promise.all(
    projectRoots.map(async (projectRoot) => {
      const project = new Map(user)
      const scoped = await readEnabledPluginOverrides([
        join(projectRoot, '.claude', 'settings.json'),
        join(projectRoot, '.claude', 'settings.local.json'),
      ])
      for (const [id, enabled] of scoped) project.set(id, enabled)
      projects.set(projectRoot, project)
    }),
  )
  return { user, projects }
}

function ompPluginsRoot(homeDir: string, env: OmpEnvironment): string {
  return env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME)
    ? join(env.XDG_DATA_HOME, 'omp', 'plugins')
    : join(ompConfigRoot(homeDir, env), 'plugins')
}

async function pluginRootsFromRegistry(
  agent: SkillRoot['agent'],
  registryPath: string,
  overrides: EnabledPluginOverrides | null,
  defaultProjectRoot?: string,
  activeProjectRoots: string[] = [],
): Promise<SkillRoot[]> {
  const registry = await readJson<PluginRegistry>(registryPath)
  const roots: SkillRoot[] = []
  for (const [pluginId, records] of Object.entries(registry?.plugins ?? {})) {
    if (!Array.isArray(records)) continue
    for (const record of records) {
      if (record.enabled === false || typeof record.installPath !== 'string') continue
      const isProject = record.scope === 'local' || record.scope === 'project' || !!defaultProjectRoot
      if (!isProject) {
        if (overrides?.user.get(pluginId) === false) continue
        roots.push(supplementalRoot(agent, join(record.installPath, 'skills'), 'user', undefined, 'plugin'))
        continue
      }
      const recordedProjectRoot = record.projectPath ?? defaultProjectRoot
      const targetProjects = defaultProjectRoot
        ? [defaultProjectRoot]
        : activeProjectRoots.filter(
            (projectRoot) =>
              projectRoot === recordedProjectRoot
              || overrides?.projects.get(projectRoot)?.get(pluginId) === true,
          )
      for (const projectRoot of targetProjects) {
        if (overrides?.projects.get(projectRoot)?.get(pluginId) === false) continue
        roots.push(
          supplementalRoot(
            agent,
            join(record.installPath, 'skills'),
            'project',
            projectRoot,
            'plugin',
          ),
        )
      }
    }
  }
  return roots
}

async function installedOmpExtensionRoots(
  agent: SkillRoot['agent'],
  pluginsRoot: string,
  scope: InstallScope,
  projectRoot?: string,
): Promise<SkillRoot[]> {
  const packageJson = await readJson<{ dependencies?: Record<string, string> }>(
    join(pluginsRoot, 'package.json'),
  )
  const lock = await readJson<{
    plugins?: Record<string, { enabled?: boolean }>
  }>(join(pluginsRoot, 'omp-plugins.lock.json'))
  const overrides = projectRoot
    ? await readJson<{ disabled?: string[] }>(join(projectRoot, '.omp', 'plugin-overrides.json'))
    : null
  const names = new Set([
    ...Object.keys(packageJson?.dependencies ?? {}),
    ...Object.keys(lock?.plugins ?? {}),
  ])
  const roots: SkillRoot[] = []
  for (const name of names) {
    if (lock?.plugins?.[name]?.enabled === false || overrides?.disabled?.includes(name)) continue
    const pluginRoot = join(pluginsRoot, 'node_modules', name)
    const pluginPackage = await readJson<{ omp?: unknown; pi?: unknown }>(join(pluginRoot, 'package.json'))
    if (!pluginPackage?.omp && !pluginPackage?.pi) continue
    roots.push(supplementalRoot(agent, join(pluginRoot, 'skills'), scope, projectRoot, 'plugin'))
  }
  return roots
}

function extensionPaths(value: unknown, projectRoot: string, homeDir: string): string[] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const extensions = (value as { extensions?: unknown }).extensions
  if (!Array.isArray(extensions)) return null
  return extensions
    .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    .map((entry) => {
      const expanded = entry === '~'
        ? homeDir
        : entry.startsWith('~/')
          ? join(homeDir, entry.slice(2))
          : entry
      return isAbsolute(expanded) ? expanded : resolve(projectRoot, expanded)
    })
}

async function readExtensionPaths(
  path: string,
  projectRoot: string,
  homeDir: string,
): Promise<string[] | null> {
  try {
    const content = await fs.readFile(path, 'utf8')
    const parsed = path.endsWith('.json') ? JSON.parse(content) : parseYaml(content)
    return extensionPaths(parsed, projectRoot, homeDir)
  } catch {
    return null
  }
}

async function configuredExtensionRoots(
  agent: SkillRoot['agent'],
  homeDir: string,
  agentDir: string,
  projectRoots: string[],
): Promise<SkillRoot[]> {
  const contexts = projectRoots.length > 0 ? projectRoots : [agentDir]
  const roots: SkillRoot[] = []
  for (const projectRoot of contexts) {
    const sources = [
      ...(projectRoot === agentDir
        ? []
        : [
            { path: join(projectRoot, '.omp', 'config.yml'), scope: 'project' as const },
            { path: join(projectRoot, '.omp', 'settings.json'), scope: 'project' as const },
          ]),
      { path: join(agentDir, 'config.yml'), scope: 'user' as const },
      { path: join(agentDir, 'config.yaml'), scope: 'user' as const },
      { path: join(agentDir, 'settings.json'), scope: 'user' as const },
    ]
    for (const source of sources) {
      const paths = await readExtensionPaths(source.path, projectRoot, homeDir)
      if (paths === null) continue
      roots.push(
        ...paths.map((path) =>
          supplementalRoot(
            agent,
            join(path, 'skills'),
            source.scope,
            source.scope === 'project' ? projectRoot : undefined,
            'plugin',
          ),
        ),
      )
      break
    }
  }
  return roots
}

/** OMP adapter mirroring its native, shared and plugin Skill providers. */
export class OmpAdapter extends PlatformAdapter {
  constructor(
    def: PlatformDef,
    private readonly ompHomeDir: string = homedir(),
    private readonly env: OmpEnvironment = process.env,
  ) {
    super(def, ompHomeDir)
  }

  override skillsDir(scope: InstallScope, projectRoot?: string): string | null {
    if (scope === 'user') return join(resolveOmpAgentDir(this.ompHomeDir, this.env), 'skills')
    return super.skillsDir(scope, projectRoot)
  }

  override async detect(): Promise<boolean> {
    return fs.access(resolveOmpAgentDir(this.ompHomeDir, this.env)).then(
      () => true,
      () => false,
    )
  }

  async supplementalRoots(projectRoots: string[] = []): Promise<SkillRoot[]> {
    const agentDir = resolveOmpAgentDir(this.ompHomeDir, this.env)
    const pluginsRoot = ompPluginsRoot(this.ompHomeDir, this.env)
    const roots: SkillRoot[] = [
      join(this.ompHomeDir, '.agent', 'skills'),
      join(this.ompHomeDir, '.agents', 'skills'),
      join(this.ompHomeDir, '.claude', 'skills'),
      join(this.ompHomeDir, '.codex', 'skills'),
      join(this.ompHomeDir, '.pi', 'agent', 'skills'),
      join(this.ompHomeDir, '.config', 'opencode', 'skills'),
      join(agentDir, 'managed-skills'),
    ].map((path) => supplementalRoot(this.agent, path))

    const projectProviders = ['.agent', '.agents', '.claude', '.codex', '.pi', '.opencode', '.github']
    for (const projectRoot of projectRoots) {
      roots.push(
        ...projectProviders.map((directory) =>
          supplementalRoot(this.agent, join(projectRoot, directory, 'skills'), 'project', projectRoot),
        ),
      )
    }

    const overrides = await enabledPluginOverrides(this.ompHomeDir, projectRoots)
    roots.push(
      ...(await pluginRootsFromRegistry(
        this.agent,
        join(this.ompHomeDir, '.claude', 'plugins', 'installed_plugins.json'),
        overrides,
        undefined,
        projectRoots,
      )),
      ...(await pluginRootsFromRegistry(
        this.agent,
        join(pluginsRoot, 'installed_plugins.json'),
        null,
        undefined,
        projectRoots,
      )),
    )
    for (const projectRoot of projectRoots) {
      roots.push(
        ...(await pluginRootsFromRegistry(
          this.agent,
          join(projectRoot, '.omp', 'plugins', 'installed_plugins.json'),
          null,
          projectRoot,
          projectRoots,
        )),
      )
    }
    roots.push(
      ...(await configuredExtensionRoots(this.agent, this.ompHomeDir, agentDir, projectRoots)),
      ...(await installedOmpExtensionRoots(this.agent, pluginsRoot, 'user')),
    )
    for (const projectRoot of projectRoots) {
      roots.push(
        ...(await installedOmpExtensionRoots(
          this.agent,
          join(projectRoot, '.omp', 'plugins'),
          'project',
          projectRoot,
        )),
      )
    }
    return roots
  }
}

export function discoverOmpSupplementalRoots(
  homeDir: string = homedir(),
  projectRoots: string[] = [],
  env: OmpEnvironment = process.env,
): Promise<SkillRoot[]> {
  const def = BUILTIN_PLATFORMS.find((platform) => platform.id === 'omp')!
  return new OmpAdapter(def, homeDir, env).supplementalRoots(projectRoots)
}
