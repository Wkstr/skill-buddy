import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { InstructionWatcher } from './watcher'

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => fs.rm(path, { recursive: true, force: true })))
})

describe('InstructionWatcher', () => {
  it('debounces changes and stop cancels pending callbacks', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'skillbuddy-watcher-'))
    cleanup.push(root)
    const watcher = new InstructionWatcher({ debounceMs: 20 })
    const onChange = vi.fn()
    expect(watcher.start([], [root], onChange)).toBe(1)
    await fs.writeFile(join(root, 'AGENTS.md'), 'one\n', 'utf8')
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(onChange).toHaveBeenCalled()
    const callsAfterFirstWrite = onChange.mock.calls.length
    watcher.stop()
    await fs.writeFile(join(root, 'AGENTS.md'), 'two\n', 'utf8')
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(onChange).toHaveBeenCalledTimes(callsAfterFirstWrite)
  })

  it('ignores writes under excluded directories and its own temporary files', async () => {
    const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'skillbuddy-watcher-ignore-')))
    cleanup.push(root)
    await fs.mkdir(join(root, 'node_modules', 'pkg'), { recursive: true })
    await fs.mkdir(join(root, 'dist'), { recursive: true })
    const watcher = new InstructionWatcher({ debounceMs: 20 })
    const onChange = vi.fn()
    watcher.start([root], [], onChange)
    // 递归监听启动时会补报启动前的历史事件，先等它排空再断言过滤行为。
    await new Promise((resolve) => setTimeout(resolve, 300))
    onChange.mockClear()

    await fs.writeFile(join(root, 'node_modules', 'pkg', 'AGENTS.md'), 'noise\n', 'utf8')
    await fs.writeFile(join(root, 'dist', 'AGENTS.md'), 'noise\n', 'utf8')
    await fs.writeFile(join(root, '.skillbuddy-abc.tmp'), 'noise\n', 'utf8')
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(onChange).not.toHaveBeenCalled()

    await fs.writeFile(join(root, 'AGENTS.md'), 'real\n', 'utf8')
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(onChange).toHaveBeenCalled()
    watcher.stop()
  })

  it('restarts cleanly without retaining old watchers', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'skillbuddy-watcher-restart-'))
    cleanup.push(root)
    const watcher = new InstructionWatcher({ debounceMs: 10 })
    const onChange = vi.fn()
    expect(watcher.start([], [root], onChange)).toBe(1)
    expect(watcher.start([], [root], onChange)).toBe(1)
    watcher.stop()
  })
})
