import { describe, expect, it } from 'vitest'
import { isMcpCredentialName } from './mcp-credentials.js'

describe('isMcpCredentialName', () => {
  it.each([
    'GITHUB_PERSONAL_ACCESS_TOKEN',
    'OPENAI_API_KEY',
    'DATABASE_URL',
    'Authorization',
    'SUPABASE_SERVICE_ROLE_KEY',
    'OPENAI_KEY',
    'BRAVE_SEARCH_KEY',
    'SENTRY_DSN',
    'GITHUB_PAT',
  ])('识别凭据名称 %s', (name) => expect(isMcpCredentialName(name)).toBe(true))

  it.each(['CODEX_HOME', 'CODEX_CLI_PATH', 'BROWSER_USE_CODEX_APP_VERSION', 'KEYWORDS', 'MONKEY_MODE'])(
    '不把运行时环境变量 %s 当作凭据',
    (name) => expect(isMcpCredentialName(name)).toBe(false),
  )

  it.each(['SSH_PRIVATE_KEY_PATH', 'ACCESS_KEY_ID', 'TOKEN_FILE', 'SECRET_NAME'])(
    '不把指向凭据的路径或标识 %s 当作凭据本身',
    (name) => expect(isMcpCredentialName(name)).toBe(false),
  )
})
