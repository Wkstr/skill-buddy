import { describe, expect, it } from 'vitest'
import { normalizeMarkdownPreviewId } from './markdown-preview'

describe('normalizeMarkdownPreviewId', () => {
  it('converts absolute paths into valid selector ids', () => {
    const id = normalizeMarkdownPreviewId('instruction-/Users/cheng/Documents/AGENTS.md')
    expect(id).toBe('instruction-_Users_cheng_Documents_AGENTS_md')
    expect(id).toMatch(/^[a-zA-Z_][a-zA-Z0-9_-]*$/)
  })

  it('adds a prefix when the value starts with a digit', () => {
    expect(normalizeMarkdownPreviewId('123-preview')).toBe('md-preview-123-preview')
  })
})
