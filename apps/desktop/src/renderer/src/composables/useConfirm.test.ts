import { describe, expect, it } from 'vitest'
import { confirmDialog, useConfirmHost } from './useConfirm'

const options = {
  title: '删除',
  message: '确定要删除吗',
  confirmLabel: '删除',
  cancelLabel: '取消',
}

describe('useConfirm', () => {
  it('resolves true when the host confirms and false when it cancels', async () => {
    const { confirm, respond } = useConfirmHost()

    const accepted = confirmDialog(options)
    expect(confirm.value?.title).toBe('删除')
    respond(true)
    await expect(accepted).resolves.toBe(true)
    expect(confirm.value).toBeNull()

    const rejected = confirmDialog(options)
    respond(false)
    await expect(rejected).resolves.toBe(false)
  })

  it('never leaves an earlier request pending when a new one replaces it', async () => {
    const { respond } = useConfirmHost()
    const first = confirmDialog({ ...options, title: '第一个' })
    const second = confirmDialog({ ...options, title: '第二个' })

    await expect(first).resolves.toBe(false)
    respond(true)
    await expect(second).resolves.toBe(true)
  })

  it('ignores extra responses after the dialog is already settled', async () => {
    const { confirm, respond } = useConfirmHost()
    const pending = confirmDialog(options)
    respond(true)
    respond(false)
    await expect(pending).resolves.toBe(true)
    expect(confirm.value).toBeNull()
  })

  it('carries the danger flag through to the host', () => {
    const { confirm, respond } = useConfirmHost()
    void confirmDialog({ ...options, danger: true })
    expect(confirm.value?.danger).toBe(true)
    respond(false)
  })
})
