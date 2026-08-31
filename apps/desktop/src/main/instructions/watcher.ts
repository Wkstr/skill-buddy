import { watch, type FSWatcher } from 'node:fs'
import { INSTRUCTION_SCAN_EXCLUDES } from '@skillbuddy/core'

export interface InstructionWatcherOptions {
  debounceMs?: number
}

/**
 * 过滤掉扫描本来就会跳过的目录，以及本进程自己的原子写临时文件。
 * 否则一次依赖安装或构建就会让整个项目树被反复重扫。
 * 拿不到文件名时（部分平台的 rename 事件）保守地按需要刷新处理。
 */
function isIgnoredChange(filename: string | null): boolean {
  if (!filename) return false
  return filename.split(/[\\/]/).some((segment) =>
    INSTRUCTION_SCAN_EXCLUDES.has(segment.toLowerCase())
    || segment.startsWith('.skillbuddy-'),
  )
}

/** 监听项目与全局指令目录，并将连续文件系统事件合并为一次刷新。 */
export class InstructionWatcher {
  readonly #watchers: FSWatcher[] = []
  readonly #debounceMs: number
  #timer: ReturnType<typeof setTimeout> | undefined
  #onChange: (() => void) | undefined

  constructor(options: InstructionWatcherOptions = {}) {
    this.#debounceMs = options.debounceMs ?? 180
  }

  start(projectRoots: string[], globalParents: string[], onChange: () => void): number {
    this.stop()
    this.#onChange = onChange
    const schedule = (): void => {
      if (this.#timer) clearTimeout(this.#timer)
      this.#timer = setTimeout(() => {
        this.#timer = undefined
        this.#onChange?.()
      }, this.#debounceMs)
    }
    for (const root of [...new Set([...projectRoots, ...globalParents])]) {
      try {
        const watcher = watch(root, { recursive: projectRoots.includes(root) }, (_event, filename) => {
          if (!isIgnoredChange(typeof filename === 'string' ? filename : null)) schedule()
        })
        watcher.on('error', () => watcher.close())
        this.#watchers.push(watcher)
      } catch {
        // 单个目录不可监听时，扫描和手动刷新仍然可用。
      }
    }
    return this.#watchers.length
  }

  stop(): void {
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = undefined
    for (const watcher of this.#watchers.splice(0)) watcher.close()
    this.#onChange = undefined
  }
}
