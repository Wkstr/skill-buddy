/** 将业务值转换为 md-editor-v3 可安全用于 CSS 选择器的 id。 */
export function normalizeMarkdownPreviewId(value: string | undefined): string {
  const safe = (value ?? 'md-view').replace(/[^a-zA-Z0-9_-]/g, '_')
  return /^[a-zA-Z_]/.test(safe) ? safe : `md-preview-${safe}`
}
