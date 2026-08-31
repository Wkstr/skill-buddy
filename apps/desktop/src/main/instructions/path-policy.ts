import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, parse, relative, resolve, sep } from 'node:path'
import type { InstructionDocument, InstructionRuleProfile } from '@skillbuddy/core'

const MAX_PROJECT_ROOTS = 64

function isWithin(root: string, path: string): boolean {
  const relation = relative(root, path)
  return relation === '' || (relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation))
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => character.charCodeAt(0) < 32)
}

/** 仅接受真实存在的绝对项目目录，排除文件系统根和用户主目录。 */
export async function sanitizeInstructionProjectRoots(roots: unknown): Promise<string[]> {
  if (!Array.isArray(roots)) return []
  const home = await fs.realpath(resolve(homedir())).catch(() => resolve(homedir()))
  const sanitized = new Set<string>()
  for (const root of roots.slice(0, MAX_PROJECT_ROOTS)) {
    if (typeof root !== 'string' || !root.trim() || hasControlCharacters(root)) continue
    if (!isAbsolute(root)) continue
    const resolved = resolve(root)
    if (parse(resolved).root === resolved) continue
    try {
      const canonical = await fs.realpath(resolved)
      if (canonical === home || !(await fs.stat(canonical)).isDirectory()) continue
      sanitized.add(canonical)
    } catch {
      /** 不可访问的目录不进入写入白名单。 */
    }
  }
  return [...sanitized]
}

export interface InstructionManagedTarget {
  path: string
  scope: 'user' | 'project'
  projectRoot?: string
  document?: InstructionDocument
}

export interface InstructionBridgeTarget {
  source: InstructionDocument
  target: InstructionManagedTarget
}

/** 指令域写入白名单：只允许扫描结果或注册表声明的创建目标。 */
export class InstructionPathPolicy {
  #documents = new Map<string, InstructionDocument>()
  #globalPaths = new Set<string>()
  #projectRoots: string[] = []
  #projectFileNames = new Set<string>()

  setState(
    projectRoots: string[],
    documents: InstructionDocument[],
    profiles: InstructionRuleProfile[],
  ): void {
    this.#projectRoots = projectRoots.map((root) => resolve(root))
    this.#documents = new Map(documents.map((document) => [resolve(document.path), document]))
    this.#globalPaths = new Set(profiles.flatMap((profile) =>
      profile.globalPaths.map((path) => resolve(path)),
    ))
    this.#projectFileNames = new Set(profiles.flatMap((profile) => [
      ...profile.projectFileCandidates,
      ...profile.projectFallbacks,
      ...profile.localOverlayCandidates,
      ...(profile.overrideCandidates ?? []),
    ]).map((candidate) => basename(candidate)))
  }

  async assertWriteTarget(path: string): Promise<InstructionManagedTarget> {
    const target = this.assertPathShape(path)
    const document = this.#documents.get(target)
    if (document) {
      if (document.linked) throw new Error('链接型指令文件不可直接编辑，请编辑其源文件')
      if (document.readOnly || document.contentTruncated) throw new Error('该指令文件为只读状态')
      return {
        path: target,
        scope: document.scope,
        ...(document.projectRoot ? { projectRoot: document.projectRoot } : {}),
        document,
      }
    }
    return this.assertCreateTarget(target)
  }

  async assertDeleteTarget(path: string): Promise<InstructionManagedTarget> {
    const target = this.assertPathShape(path)
    const document = this.#documents.get(target)
    if (!document) throw new Error('待删除文件不在当前指令扫描结果中')
    if (document.scope === 'user' && document.linked) throw new Error('全局链接型指令文件不允许修改')
    return {
      path: target,
      scope: document.scope,
      ...(document.projectRoot ? { projectRoot: document.projectRoot } : {}),
      document,
    }
  }

  async assertBridgeTarget(sourcePath: string): Promise<InstructionBridgeTarget> {
    const source = this.#documents.get(this.assertPathShape(sourcePath))
    if (!source || source.scope !== 'project' || source.fileName !== 'AGENTS.md') {
      throw new Error('桥接源必须是当前扫描结果中的项目级 AGENTS.md')
    }
    if (!source.projectRoot || source.linkBroken) throw new Error('桥接源文件无效')
    const targetPath = resolve(dirname(source.path), 'CLAUDE.md')
    const targetDocument = this.#documents.get(targetPath)
    const target = targetDocument
      ? {
          path: targetPath,
          scope: targetDocument.scope,
          ...(targetDocument.projectRoot ? { projectRoot: targetDocument.projectRoot } : {}),
          document: targetDocument,
        }
      : await this.assertCreateTarget(targetPath)
    if (target.scope !== 'project' || target.projectRoot !== source.projectRoot) {
      throw new Error('桥接目标必须与 AGENTS.md 位于同一项目目录')
    }
    return { source, target }
  }

  async assertRestoreTarget(target: InstructionManagedTarget): Promise<void> {
    if (target.scope === 'user') {
      if (!this.#globalPaths.has(resolve(target.path))) throw new Error('全局恢复目标不在规则注册表中')
      return
    }
    const projectRoot = target.projectRoot ? resolve(target.projectRoot) : null
    if (!projectRoot || !this.#projectRoots.includes(projectRoot)) throw new Error('恢复目标项目未登记')
    const parent = await fs.realpath(dirname(target.path)).catch(() => null)
    if (!parent || !isWithin(projectRoot, parent)) throw new Error('恢复目标越出项目目录')
  }

  private async assertCreateTarget(target: string): Promise<InstructionManagedTarget> {
    if (this.#globalPaths.has(target)) {
      return { path: target, scope: 'user' }
    }
    if (!this.#projectFileNames.has(basename(target))) throw new Error('不支持创建该指令文件名')
    const parent = await fs.realpath(dirname(target)).catch(() => null)
    if (!parent) throw new Error('目标目录不存在或不可访问')
    const projectRoot = this.#projectRoots.find((root) => isWithin(root, parent))
    if (!projectRoot) throw new Error('创建目标不在已登记项目中')
    return { path: target, scope: 'project', projectRoot }
  }

  private assertPathShape(path: string): string {
    if (typeof path !== 'string' || !path.trim() || hasControlCharacters(path)) {
      throw new Error('指令文件路径无效')
    }
    if (!isAbsolute(path)) throw new Error('指令文件路径必须是绝对路径')
    return resolve(path)
  }
}
