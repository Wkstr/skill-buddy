import { dirname, relative } from 'node:path'
import type { InstructionDocument, InstructionRuleProfile } from './types.js'

export function normalizedPath(path: string): string {
  return path.replaceAll('\\', '/')
}

/**
 * 把指令文件的物理目录回溯为该工具眼中的“逻辑目录”。
 *
 * 形如 `.codebuddy/CODEBUDDY.md` 的嵌套候选路径，或 `.cursor/rules/x.md` 这类规则目录，
 * 在工具语义上都归属于其上层项目目录；扫描的候选遮蔽判定与有效链的层级归并都依赖这个映射，
 * 两处必须使用同一份实现，否则新增带斜杠的候选路径时会出现扫描与有效链不一致。
 */
export function instructionEffectiveDirectory(
  document: InstructionDocument,
  profile: InstructionRuleProfile | undefined,
): string {
  const physicalDirectory = dirname(document.path)
  if (!profile || document.scope !== 'project' || !document.projectRoot) return physicalDirectory
  const relativePath = normalizedPath(relative(document.projectRoot, document.path))
  const nestedCandidates = [
    ...profile.projectFileCandidates,
    ...profile.projectFallbacks,
    ...profile.localOverlayCandidates,
    ...(profile.overrideCandidates ?? []),
  ].filter((candidate) => normalizedPath(candidate).includes('/'))
  for (const candidate of nestedCandidates) {
    const normalized = normalizedPath(candidate)
    if (relativePath !== normalized && !relativePath.endsWith(`/${normalized}`)) continue
    return climb(physicalDirectory, normalized.split('/').length - 1)
  }
  const relativeDirectory = normalizedPath(dirname(relativePath))
  for (const candidate of profile.rulesDirCandidates ?? []) {
    const normalized = normalizedPath(candidate).replace(/\/$/, '')
    if (relativeDirectory !== normalized && !relativeDirectory.endsWith(`/${normalized}`)) continue
    return climb(physicalDirectory, normalized.split('/').length)
  }
  return physicalDirectory
}

function climb(directory: string, levels: number): string {
  let current = directory
  for (let index = 0; index < levels; index += 1) current = dirname(current)
  return current
}
