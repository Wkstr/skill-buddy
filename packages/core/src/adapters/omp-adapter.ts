import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { BUILTIN_PLATFORMS, type PlatformDef } from '../platforms.js'
import type { SkillRoot } from '../types.js'
import { PlatformAdapter } from './platform-adapter.js'

interface ClaudePluginRecord {
  installPath?: string
}

/**
 * OMP adapter.
 *
 * `~/.omp/agent/skills` remains the writable native target. Supplemental
 * roots mirror the other user-level providers OMP loads and are read-only in
 * SkillBuddy, so the sidebar reflects the Skills available in OMP's `/skill`.
 */
export class OmpAdapter extends PlatformAdapter {
  constructor(
    def: PlatformDef,
    private readonly ompHomeDir: string = homedir(),
  ) {
    super(def, ompHomeDir)
  }

  async supplementalRoots(): Promise<SkillRoot[]> {
    const roots: SkillRoot[] = ['.agent', '.agents'].map((directory) => ({
      agent: this.agent,
      scope: 'user',
      path: join(this.ompHomeDir, directory, 'skills'),
      origin: 'legacy',
      readOnly: true,
      canToggle: false,
    }))

    roots.push(
      ...[
        join(this.ompHomeDir, '.claude', 'skills'),
        join(this.ompHomeDir, '.codex', 'skills'),
        join(this.ompHomeDir, '.omp', 'agent', 'managed-skills'),
      ].map((path): SkillRoot => ({
        agent: this.agent,
        scope: 'user',
        path,
        origin: 'legacy',
        readOnly: true,
        canToggle: false,
      })),
    )

    const manifestPath = join(
      this.ompHomeDir,
      '.claude',
      'plugins',
      'installed_plugins.json',
    )
    let parsed: { plugins?: Record<string, ClaudePluginRecord[]> }
    try {
      parsed = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as typeof parsed
    } catch {
      return roots
    }
    for (const records of Object.values(parsed.plugins ?? {})) {
      if (!Array.isArray(records)) continue
      for (const record of records) {
        if (typeof record.installPath !== 'string') continue
        roots.push({
          agent: this.agent,
          scope: 'user',
          path: join(record.installPath, 'skills'),
          origin: 'plugin',
          readOnly: true,
          canToggle: false,
        })
      }
    }
    return roots
  }
}

export function discoverOmpSupplementalRoots(
  homeDir: string = homedir(),
): Promise<SkillRoot[]> {
  const def = BUILTIN_PLATFORMS.find((platform) => platform.id === 'omp')!
  return new OmpAdapter(def, homeDir).supplementalRoots()
}
