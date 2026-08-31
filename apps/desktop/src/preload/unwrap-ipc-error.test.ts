import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: () => undefined },
  ipcRenderer: { invoke: async () => undefined, on: () => undefined, send: () => undefined },
}))

const { unwrapIpcError } = await import('./index')

describe('unwrapIpcError', () => {
  it('strips the Electron remote-method wrapper', () => {
    const error = new Error(
      "Error invoking remote method 'team-library:contribution-publish': Error: 团队库主分支已经更新，请同步后创建新的变更分支",
    )
    expect(unwrapIpcError(error).message).toBe('团队库主分支已经更新，请同步后创建新的变更分支')
  })

  it('keeps a plain message untouched', () => {
    expect(unwrapIpcError(new Error('目标文件已存在')).message).toBe('目标文件已存在')
  })

  it('only strips the outer prefix so the message keeps its own wording', () => {
    const error = new Error(
      "Error invoking remote method 'x': Error: git 执行失败：Error: fatal: not a repository",
    )
    expect(unwrapIpcError(error).message).toBe('git 执行失败：Error: fatal: not a repository')
  })

  it('falls back to the raw text when stripping would empty the message', () => {
    expect(unwrapIpcError(new Error('Error:')).message).toBe('Error:')
    expect(unwrapIpcError('boom').message).toBe('boom')
  })
})
