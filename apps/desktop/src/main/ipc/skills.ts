import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from 'electron'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, watch, type FSWatcher } from 'node:fs'
import { promises as fs } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import {
  aggregateSkills,
  allAdapters,
  findSkills,
  getAdapter,
  listPlatformStatus,
  listSkillRoots,
  registerPlatform,
  scanInstalledSkills,
  scanInstalledSkillsWithWarnings,
  type InstalledSkill,
  type Skill,
  type SkillParseWarning,
} from '@skillbuddy/core'
import type { CustomPlatformInput, InstallTarget } from '#shared/ipc'
import { readFilePreview } from '../file-preview'
import { readSecret, writeSecret } from '../secrets'
import { copyUndoSnapshot } from '../undo-stash'
import { PathAccessPolicy, validateCustomPlatform } from '../path-policy'
import { derivePlatformDraft, discoverPlatformCandidates } from '../platform-discovery'
import { setWindowChromeTheme, setWindowVibrancy } from '../window'
import { installTarget, runTargets } from './targets'

const execFileAsync = promisify(execFile)
let skillStateMutationQueue = Promise.resolve()

/** 串行执行 Skill 状态写入，避免共享链接在批量启停时被并发分离。 */
function enqueueSkillStateMutation<T>(mutation: () => Promise<T>): Promise<T> {
  const result = skillStateMutationQueue.then(mutation, mutation)
  skillStateMutationQueue = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

/** 刷新受影响平台的运行时投影目录，普通适配器没有此能力时保持无操作。 */
async function refreshRuntimeForPaths(paths: string[]): Promise<void> {
  await Promise.all(
    allAdapters().map(async (adapter) => {
      if (!adapter.refreshRuntime) return
      const root = adapter.skillsDir('user')
      if (!root) return
      const resolvedRoot = resolve(root)
      const affectsAdapter = paths.some((path) => {
        const relation = relative(resolvedRoot, resolve(path))
        return relation === '' || (!relation.startsWith('..') && !relation.includes(':'))
      })
      if (affectsAdapter) await adapter.refreshRuntime()
    }),
  )
}

/** 将单个 Skill 目录符号链接物化为独立目录，避免后续写入影响链接源。 */
async function materializeSkillDirectoryLink(path: string): Promise<void> {
  const sourcePath = await fs.realpath(path)
  const stagingRoot = await fs.mkdtemp(join(dirname(path), '.skillbuddy-detach-'))
  const stagedPath = join(stagingRoot, basename(path))
  const originalLinkPath = join(stagingRoot, '.original-link')

  try {
    await fs.cp(sourcePath, stagedPath, {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
    })
    await fs.rename(path, originalLinkPath)
    try {
      await fs.rename(stagedPath, path)
    } catch (error) {
      await fs.rename(originalLinkPath, path)
      throw error
    }
  } finally {
    await fs.rm(stagingRoot, { recursive: true, force: true })
  }
}

/**
 * 写入前分离共享同一真实目录的安装。
 * 目标本身是链接时只分离目标；目标是真实目录时分离指向它的其他可写链接。
 */
async function isolateSharedInstallation(
  target: InstalledSkill,
  installations: InstalledSkill[],
): Promise<void> {
  const targetPath = await fs.realpath(target.path)
  const shared: InstalledSkill[] = []

  for (const installation of installations) {
    try {
      if (await fs.realpath(installation.path) === targetPath) shared.push(installation)
    } catch {
      // 扫描后被外部删除的安装交由后续状态更新报告。
    }
  }
  if (shared.length <= 1) return

  const targetStat = await fs.lstat(target.path)
  if (targetStat.isSymbolicLink()) {
    await materializeSkillDirectoryLink(target.path)
    return
  }

  const aliases = new Map<string, InstalledSkill>()
  for (const installation of shared) {
    if (installation.path === target.path) {
      if (installation !== target) {
        throw new Error(
          'skill installation shares the same platform directory and cannot be toggled independently',
        )
      }
      continue
    }
    aliases.set(installation.path, installation)
  }

  for (const installation of aliases.values()) {
    if (installation.readOnly || !(await fs.lstat(installation.path)).isSymbolicLink()) {
      throw new Error(
        'skill installation shares a read-only or non-link directory and cannot be toggled independently',
      )
    }
  }
  for (const installation of aliases.values()) {
    await materializeSkillDirectoryLink(installation.path)
  }
}

/** 切换 Skill 状态，并兼容尚未包含此能力的旧 Adapter 实例。 */
async function setAdapterEnabled(
  name: string,
  enabled: boolean,
  target: InstallTarget,
): Promise<void> {
  const adapter = getAdapter(target.agent)
  if (typeof adapter.setEnabled === 'function') {
    await adapter.setEnabled(name, enabled, target.scope, target.projectRoot)
    return
  }

  const root = adapter.skillsDir(target.scope, target.projectRoot)
  if (!root) throw new Error(`${target.agent}: no skills directory for scope "${target.scope}"`)
  const skillPath = join(root, name)
  const activePath = join(skillPath, 'SKILL.md')
  const disabledPath = join(skillPath, 'SKILL.md.disabled')
  if (enabled) {
    if (existsSync(activePath)) {
      await fs.rm(disabledPath, { force: true })
      return
    }
    if (!existsSync(disabledPath)) throw new Error(`skill not found: ${name}`)
    await fs.rename(disabledPath, activePath)
    return
  }
  if (existsSync(disabledPath)) {
    await fs.rm(activePath, { force: true })
    return
  }
  if (!existsSync(activePath)) throw new Error(`skill not found: ${name}`)
  await fs.rename(activePath, disabledPath)
}

/** 注册本地 Skill、文件系统、设置和导入相关 IPC。 */
export function registerSkillsIpc(pathPolicy: PathAccessPolicy): void {
  let rootsKey: string | undefined
  let cachedRoots: Awaited<ReturnType<typeof listSkillRoots>> | undefined
  const resolveSkillRoots = async (projectRoots: string[], reuseCached = false) => {
    const nextKey = JSON.stringify(projectRoots)
    if (!reuseCached || nextKey !== rootsKey || !cachedRoots) {
      rootsKey = nextKey
      cachedRoots = await listSkillRoots(projectRoots)
    }
    return cachedRoots
  }

  ipcMain.handle('skills:scan', async (_event, projectRoots: string[] = []) => {
    const roots = await resolveSkillRoots(projectRoots)
    pathPolicy.setSkillRoots(roots)
    return await aggregateSkills(await scanInstalledSkills(projectRoots, roots))
  })

  ipcMain.handle('skills:scan-diagnostics', async (_event, projectRoots: string[] = []) => {
    const roots = await resolveSkillRoots(projectRoots)
    pathPolicy.setSkillRoots(roots)
    const result = await scanInstalledSkillsWithWarnings(projectRoots, roots)
    return {
      skills: await aggregateSkills(result.skills),
      warnings: result.warnings,
    }
  })

  ipcMain.handle('platforms:list', () => listPlatformStatus())

  ipcMain.handle('platforms:register', (_event, definitions: CustomPlatformInput[]) => {
    for (const definition of definitions) registerPlatform(validateCustomPlatform(definition))
  })

  ipcMain.handle('skills:install', async (_event, skill: Skill, targets: InstallTarget[]) => {
    await pathPolicy.assertSkillResources(skill)
    return runTargets(targets, (target) => installTarget(skill, target, pathPolicy))
  })

  ipcMain.handle('skills:uninstall', (_event, name: string, targets: InstallTarget[]) =>
    runTargets(targets, (target) => {
      const adapter = getAdapter(target.agent)
      const root = adapter.skillsDir(target.scope, target.projectRoot)
      if (!root) throw new Error(`${target.agent}: no skills directory for scope "${target.scope}"`)
      pathPolicy.assertWritableTargetRoot(root)
      return adapter.uninstall(name, target.scope, target.projectRoot)
    }),
  )

  ipcMain.handle(
    'skills:set-enabled',
    async (_event, name: string, targets: InstallTarget[], enabled: boolean) =>
      runTargets(targets, (target) =>
        enqueueSkillStateMutation(async () => {
          const adapter = getAdapter(target.agent)
          if (adapter.supportsToggle === false) {
            throw new Error(`${target.agent}: enable/disable is not supported safely`)
          }
          const targetRoot = adapter.skillsDir(target.scope, target.projectRoot)
          if (!targetRoot) {
            throw new Error(`${target.agent}: no skills directory for scope "${target.scope}"`)
          }
          pathPolicy.assertWritableTargetRoot(targetRoot)
          const roots = target.scope === 'project' && target.projectRoot ? [target.projectRoot] : []
          const installations = await scanInstalledSkills(roots)
          const installation = installations.find(
            (item) =>
              item.skill.name === name &&
              item.agent === target.agent &&
              item.scope === target.scope &&
              (item.projectRoot ?? '') === (target.projectRoot ?? ''),
          )
          if (!installation) throw new Error(`skill installation not found: ${name}`)
          if (installation.readOnly) throw new Error('skill installation is read-only')
          if (installation.canToggle === false) {
            throw new Error(`${target.agent}: skill installation cannot be toggled`)
          }
          await isolateSharedInstallation(installation, installations)
          return setAdapterEnabled(name, enabled, target)
        }),
      ),
  )

  ipcMain.handle('skills:reveal', async (_event, path: string) => {
    await pathPolicy.assertReadable(path)
    shell.showItemInFolder(path)
  })

  ipcMain.handle('shell:open-external', (_event, value: string) => {
    if (/^https?:\/\//.test(value)) return shell.openExternal(value)
  })

  ipcMain.handle('theme:set', (_event, mode: 'system' | 'light' | 'dark') => {
    nativeTheme.themeSource = mode
  })

  ipcMain.handle('window:set-theme', (_event, colors: unknown) => {
    if (!colors || typeof colors !== 'object') return
    const { background, foreground } = colors as Record<string, unknown>
    if (
      typeof background !== 'string' ||
      typeof foreground !== 'string' ||
      background.trim().length === 0 ||
      foreground.trim().length === 0 ||
      background.length > 128 ||
      foreground.length > 128
    ) {
      return
    }
    setWindowChromeTheme({ background: background.trim(), foreground: foreground.trim() })
  })

  ipcMain.handle('window:set-vibrancy', (_event, enabled: unknown) => {
    setWindowVibrancy(enabled === true)
  })

  ipcMain.handle('secure:get', (_event, key: string) => readSecret(key))

  ipcMain.handle('secure:set', (_event, key: string, value: string) => writeSecret(key, value))

  const undoStash = new Map<
    string,
    { root: string; entries: { path: string; stashPath: string }[] }
  >()

  ipcMain.handle('skills:trash-undoable', async (_event, paths: string[]) => {
    await Promise.all(paths.map((path) => pathPolicy.assertWritableSkillDirectory(path)))
    const token = randomUUID()
    const stashRoot = join(app.getPath('userData'), 'undo', token)
    const entries: { path: string; stashPath: string }[] = []
    for (const [index, path] of paths.entries()) {
      const stashPath = join(stashRoot, `${index}-${basename(path)}`)
      await copyUndoSnapshot(path, stashPath)
      entries.push({ path, stashPath })
    }
    const settled = await Promise.allSettled(paths.map((path) => shell.trashItem(path)))
    await refreshRuntimeForPaths(
      paths.filter((_, index) => settled[index]?.status === 'fulfilled'),
    )
    undoStash.set(token, { root: stashRoot, entries })
    setTimeout(() => {
      const record = undoStash.get(token)
      if (!record) return
      undoStash.delete(token)
      void fs.rm(record.root, { recursive: true, force: true })
    }, 60_000)
    return {
      token,
      results: settled.map((result, index) => ({
        path: paths[index]!,
        ok: result.status === 'fulfilled',
        error:
          result.status === 'rejected'
            ? String(result.reason?.message ?? result.reason)
            : undefined,
      })),
    }
  })

  ipcMain.handle('skills:undo-trash', async (_event, token: string) => {
    const record = undoStash.get(token)
    if (!record) return false
    undoStash.delete(token)
    for (const entry of record.entries) {
      await fs.cp(entry.stashPath, entry.path, { recursive: true })
    }
    await refreshRuntimeForPaths(record.entries.map((entry) => entry.path))
    await fs.rm(record.root, { recursive: true, force: true })
    return true
  })

  let watchers: FSWatcher[] = []
  let notifyTimer: ReturnType<typeof setTimeout> | undefined
  let lastChangedAt = 0
  let watcherKey: string | undefined

  const closeWatchers = (): void => {
    for (const watcher of watchers) watcher.close()
    watchers = []
    watcherKey = undefined
  }

  ipcMain.handle('watch:start', async (_event, projectRoots: string[]) => {
    const roots = await resolveSkillRoots(projectRoots, true)
    const nextKey = roots
      .map((root) => `${root.agent}:${root.path}:${existsSync(root.path) ? 'present' : 'missing'}`)
      .sort()
      .join('\n')
    if (nextKey === watcherKey) return watchers.length
    closeWatchers()
    pathPolicy.setSkillRoots(roots)
    const directories = new Set(roots.map((root) => root.path))
    const notify = (): void => {
      lastChangedAt = Date.now()
      clearTimeout(notifyTimer)
      notifyTimer = setTimeout(() => {
        for (const window of BrowserWindow.getAllWindows()) {
          window.webContents.send('skills:changed', lastChangedAt)
        }
      }, 500)
    }
    const addWatch = (
      target: string,
      recursive: boolean,
      listener: (eventType: string, filename: string | null) => void = notify,
    ): void => {
      if (!existsSync(target)) return
      try {
        watchers.push(watch(target, { recursive }, listener))
      } catch {
        return
      }
    }
    const watchedNamesByParent = new Map<string, Set<string>>()
    for (const directory of directories) {
      addWatch(directory, true)
      const parent = dirname(directory)
      const names = watchedNamesByParent.get(parent) ?? new Set<string>()
      names.add(basename(directory))
      watchedNamesByParent.set(parent, names)
    }
    for (const [parent, names] of watchedNamesByParent) {
      addWatch(parent, false, (_eventType, filename) => {
        if (!filename) {
          notify()
          return
        }
        const changedName = filename.split(/[\\/]/)[0]
        if (changedName && names.has(changedName)) notify()
      })
    }
    watcherKey = nextKey
    return watchers.length
  })

  ipcMain.handle('skills:trash', async (_event, paths: string[]) => {
    await Promise.all(paths.map((path) => pathPolicy.assertWritableSkillDirectory(path)))
    const settled = await Promise.allSettled(paths.map((path) => shell.trashItem(path)))
    await refreshRuntimeForPaths(
      paths.filter((_, index) => settled[index]?.status === 'fulfilled'),
    )
    return settled.map((result, index) => ({
      path: paths[index]!,
      ok: result.status === 'fulfilled',
      error:
        result.status === 'rejected'
          ? String(result.reason?.message ?? result.reason)
          : undefined,
    }))
  })

  const maxPreviewBytes = 256 * 1024
  ipcMain.handle('file:read', async (_event, path: string) => {
    await pathPolicy.assertReadable(path)
    const stat = await fs.stat(path)
    if (stat.size > maxPreviewBytes) {
      const handle = await fs.open(path, 'r')
      try {
        const buffer = Buffer.alloc(maxPreviewBytes)
        await handle.read(buffer, 0, maxPreviewBytes, 0)
        return { content: buffer.toString('utf8'), truncated: true }
      } finally {
        await handle.close()
      }
    }
    return { content: await fs.readFile(path, 'utf8'), truncated: false }
  })

  ipcMain.handle('file:preview', async (_event, path: string) => {
    await pathPolicy.assertReadable(path)
    return readFilePreview(path)
  })

  ipcMain.handle('file:list-tree', async (_event, root: string) => {
    await pathPolicy.assertReadable(root)
    const maxEntries = 2000
    const output: { path: string; size: number; isDir: boolean }[] = []
    const walk = async (directory: string, prefix: string): Promise<void> => {
      if (output.length >= maxEntries) return
      const entries = await fs.readdir(directory, { withFileTypes: true })
      for (const entry of entries) {
        if (output.length >= maxEntries) return
        if (entry.name === '.git' || entry.name === 'node_modules') continue
        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
        if (entry.isDirectory()) {
          output.push({ path: relativePath, size: 0, isDir: true })
          await walk(join(directory, entry.name), relativePath)
        } else if (entry.isFile()) {
          const stat = await fs.stat(join(directory, entry.name))
          output.push({ path: relativePath, size: stat.size, isDir: false })
        }
      }
    }
    await walk(root, '')
    return output
  })

  ipcMain.handle('dialog:pick-directory', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
    })
    const selected = result.canceled ? null : (result.filePaths[0] ?? null)
    if (selected) pathPolicy.grantSelectedRoot(selected)
    return selected
  })

  /* 自定义平台：目录发现与推导都在主进程完成，渲染进程只拿到可直接提交的草稿 */
  ipcMain.handle('platforms:discover', () => discoverPlatformCandidates())

  ipcMain.handle('platforms:pick-directory', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      defaultPath: homedir(),
    })
    const selected = result.canceled ? null : (result.filePaths[0] ?? null)
    return selected ? await derivePlatformDraft(selected) : null
  })

  ipcMain.handle('skills:find-in-dir', async (_event, root: string) => {
    await pathPolicy.assertReadable(root)
    return findSkills(root)
  })

  ipcMain.handle('skills:import-git', async (_event, url: string) => {
    if (!/^(https?:\/\/|git@)[\w.@:/~-]+$/.test(url)) {
      throw new Error(`invalid git url: ${url}`)
    }
    try {
      await execFileAsync('git', ['--version'], { timeout: 5_000 })
    } catch {
      throw new Error('git not found - please install Git first / 未检测到 git，请先安装')
    }
    const root = await fs.mkdtemp(join(tmpdir(), 'skm-import-'))
    pathPolicy.grantTemporaryRoot(root, true)
    try {
      await execFileAsync('git', ['clone', '--depth', '1', url, root], {
        timeout: 60_000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      })
    } catch (error) {
      pathPolicy.revokeTemporaryRoot(root)
      await fs.rm(root, { recursive: true, force: true })
      throw new Error(`git clone failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    const warnings: SkillParseWarning[] = []
    const items = await findSkills(root, 5, (warning) => warnings.push(warning))
    return { root, items, warnings }
  })

  ipcMain.handle('skills:cleanup-import', async (_event, root: string) => {
    pathPolicy.assertTemporaryRoot(root)
    pathPolicy.revokeTemporaryRoot(root)
    await fs.rm(root, { recursive: true, force: true })
  })
}
