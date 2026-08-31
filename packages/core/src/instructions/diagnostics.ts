import { dirname, resolve } from 'node:path'
import type { InstructionDiagnostic, InstructionDocument } from './types.js'

export async function diagnoseInstructions(documents: InstructionDocument[]): Promise<InstructionDiagnostic[]> {
  const diagnostics: InstructionDiagnostic[] = []
  const byDirectory = new Map<string, InstructionDocument[]>()
  for (const document of documents.filter((item) => item.scope === 'project')) {
    const key = dirname(document.path)
    const list = byDirectory.get(key) ?? []
    list.push(document)
    byDirectory.set(key, list)
    if (document.linkBroken) diagnostics.push({ code: 'broken-link', severity: 'error', message: `链接目标不存在：${document.path}`, paths: [document.path], fixable: false })
  }
  for (const [directory, items] of byDirectory) {
    const agents = items.find((item) => item.fileName.toLowerCase() === 'agents.md')
    const claude = items.find((item) => item.fileName === 'CLAUDE.md')
    if (agents && !claude) {
      diagnostics.push({ code: 'missing-claude-bridge', severity: 'info', message: '目录存在 AGENTS.md，但没有 Claude Code 兼容文件', paths: [agents.path, resolve(directory, 'CLAUDE.md')], fixable: true })
    }
    if (agents && claude) {
      const bridge = claude.bindings.some((binding) => binding.status === 'bridged')
      if (!bridge && !agents.linkBroken && !claude.linkBroken) {
        diagnostics.push({ code: 'claude-bridge-conflict', severity: 'warning', message: 'CLAUDE.md 已存在独立内容，无法自动创建桥接', paths: [agents.path, claude.path], fixable: false })
        if (agents.contentHash && claude.contentHash && agents.contentHash !== claude.contentHash) {
          diagnostics.push({ code: 'drifted', severity: 'warning', message: 'AGENTS.md 与 CLAUDE.md 内容存在差异', paths: [agents.path, claude.path], fixable: false })
        }
      }
    }
  }
  return diagnostics
}

export function instructionStats(documents: InstructionDocument[]): { total: number; project: number; global: number; linked: number; readOnly: number } {
  return {
    total: documents.length,
    project: documents.filter((item) => item.scope === 'project').length,
    global: documents.filter((item) => item.scope === 'user').length,
    linked: documents.filter((item) => item.linked).length,
    readOnly: documents.filter((item) => item.readOnly).length,
  }
}
