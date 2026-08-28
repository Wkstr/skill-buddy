import { homedir } from 'node:os'
import { join } from 'node:path'
import { BUILTIN_PLATFORMS, type PlatformDef } from '../platforms.js'
import type { SkillRoot } from '../types.js'
import { PlatformAdapter } from './platform-adapter.js'

/** Pi adapter, including its shared cross-agent user Skill root. */
export class PiAdapter extends PlatformAdapter {
  constructor(
    def: PlatformDef,
    private readonly piHomeDir: string = homedir(),
  ) {
    super(def, piHomeDir)
  }

  supplementalRoots(projectRoots: string[] = []): SkillRoot[] {
    return [
      {
        agent: this.agent,
        scope: 'user',
        path: join(this.piHomeDir, '.agents', 'skills'),
        origin: 'shared',
        readOnly: true,
        canToggle: false,
      },
      ...projectRoots.map((projectRoot): SkillRoot => ({
        agent: this.agent,
        scope: 'project',
        path: join(projectRoot, '.agents', 'skills'),
        projectRoot,
        origin: 'shared',
        readOnly: true,
        canToggle: false,
      })),
    ]
  }
}

export function discoverPiSupplementalRoots(
  homeDir: string = homedir(),
  projectRoots: string[] = [],
): SkillRoot[] {
  const def = BUILTIN_PLATFORMS.find((platform) => platform.id === 'pi')!
  return new PiAdapter(def, homeDir).supplementalRoots(projectRoots)
}
