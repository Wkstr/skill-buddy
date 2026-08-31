import { readonly, shallowRef } from 'vue'
import type { ConfirmOptions } from '#shared/ipc'

interface ConfirmState extends ConfirmOptions {
  resolve: (confirmed: boolean) => void
}

const state = shallowRef<ConfirmState | null>(null)

/**
 * 应用内确认对话框，签名与旧的原生 `window.skillsManager.confirmDialog` 一致。
 *
 * 与原生对话框不同，这里由渲染层绘制，因此 `danger` 能真正呈现为危险样式；
 * 代价是它只在窗口内模态，需要阻塞整个系统的场景仍应使用主进程通道。
 */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  /** 后来的确认取代未决的旧确认，避免调用方的 Promise 永远挂起。 */
  state.value?.resolve(false)
  return new Promise<boolean>((resolve) => {
    state.value = { ...options, resolve }
  })
}

/** 供宿主组件读取当前待确认项并回传结果。 */
export function useConfirmHost() {
  function respond(confirmed: boolean): void {
    const current = state.value
    if (!current) return
    state.value = null
    current.resolve(confirmed)
  }
  return { confirm: readonly(state), respond }
}
