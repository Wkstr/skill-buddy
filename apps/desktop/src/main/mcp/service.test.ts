import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  PlatformMcpAdapter,
  defineMcpCapabilities,
  type McpPlatformProfile,
  type McpServerDefinition,
  type McpTarget,
} from '@skillbuddy/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { McpService } from './service.js'

const capabilities = defineMcpCapabilities({
  scopes: ['user', 'local'],
  transports: ['stdio'],
  configFormats: ['json'],
  supportsOAuth: false,
  supportsEnvReferences: true,
  supportsHeaderReferences: false,
  toggle: 'native',
  protocolFeatures: { tools: true },
})

const definition: McpServerDefinition = {
  name: 'filesystem',
  transport: {
    kind: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem'],
    env: {},
  },
  requiredSecrets: [],
}

function createProfile(configPath: string): McpPlatformProfile {
  return {
    agent: 'test-agent',
    surface: 'cli',
    displayName: 'Test Agent',
    schema: 'standard',
    capabilities,
    detectPaths: () => [],
    sourceTemplates: (_homeDir, projectRoots) => [
      {
        scope: 'user',
        path: configPath,
        format: 'json',
        nodePath: ['mcpServers'],
        origin: 'user',
      },
      ...projectRoots.map((projectRoot) => ({
        scope: 'local' as const,
        projectRoot: resolve(projectRoot),
        path: configPath,
        format: 'json' as const,
        nodePath: ['projects', resolve(projectRoot), 'mcpServers'],
        origin: 'local' as const,
      })),
    ],
  }
}

describe('McpService', () => {
  let root: string
  let configPath: string
  let projectRoot: string
  let service: McpService

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'skillbuddy-mcp-service-'))
    configPath = join(root, 'agent.json')
    projectRoot = join(root, 'project')
    await fs.mkdir(projectRoot)
    await fs.writeFile(configPath, '{\n  "keep": "private source text"\n}\n', 'utf8')
    const adapter = new PlatformMcpAdapter(createProfile(configPath), root)
    service = new McpService(join(root, 'backups'), {
      adapters: [adapter],
      backupTtl: 60_000,
    })
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    service.dispose()
    await fs.rm(root, { recursive: true, force: true })
  })

  it('计划视图不暴露配置原文', async () => {
    const plan = await service.createUpsertPlan({
      projectRoots: [],
      definition,
      targets: [{ agent: 'test-agent', surface: 'cli', scope: 'user' }],
    })

    expect(JSON.stringify(plan)).not.toContain('private source text')
    expect(plan.intent).toBe('upsert')
    expect(plan.actions).toHaveLength(1)
    expect(plan.canApply).toBe(true)
  })

  it.each([
    { enabled: true, intent: 'enable' },
    { enabled: false, intent: 'disable' },
  ] as const)('启停计划向界面暴露 $intent 意图', async ({ enabled, intent }) => {
    await fs.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          filesystem: {
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-filesystem'],
            enabled: !enabled,
          },
        },
      }),
      'utf8',
    )
    const scan = await service.scan()
    const installation = scan.installations.find((item) => item.definition.name === 'filesystem')
    expect(installation).toBeDefined()
    if (!installation) throw new Error('测试 MCP 安装不存在')

    const plan = await service.createTogglePlan({
      projectRoots: [],
      installationIds: [installation.id],
      enabled,
    })

    expect(plan).toMatchObject({ kind: 'toggle', intent, name: 'filesystem', canApply: true })
  })

  it('把同一文件中的用户节点和项目本地节点合并为一次写入', async () => {
    const targets: McpTarget[] = [
      { agent: 'test-agent', surface: 'cli', scope: 'user' },
      {
        agent: 'test-agent',
        surface: 'cli',
        scope: 'local',
        projectRoot,
      },
    ]
    const plan = await service.createUpsertPlan({
      projectRoots: [projectRoot],
      definition,
      targets,
    })

    expect(plan.actions).toHaveLength(2)
    const result = await service.applyPlan(plan.planId)
    expect(result.results).toHaveLength(1)
    expect(result.results[0]?.ok).toBe(true)

    const config = JSON.parse(await fs.readFile(configPath, 'utf8')) as {
      mcpServers: Record<string, unknown>
      projects: Record<string, { mcpServers: Record<string, unknown> }>
    }
    expect(config.mcpServers.filesystem).toBeDefined()
    expect(config.projects[resolve(projectRoot)]?.mcpServers.filesystem).toBeDefined()
    expect(config).toMatchObject({ keep: 'private source text' })
  })

  it('拒绝执行过期计划', async () => {
    const adapter = new PlatformMcpAdapter(createProfile(configPath), root)
    const expiringService = new McpService(join(root, 'expiring-backups'), {
      adapters: [adapter],
      planTtl: -1,
    })
    const plan = await expiringService.createUpsertPlan({
      projectRoots: [],
      definition,
      targets: [{ agent: 'test-agent', surface: 'cli', scope: 'user' }],
    })

    await expect(expiringService.applyPlan(plan.planId)).rejects.toThrow('计划已过期')
    expiringService.dispose()
  })

  it('配置在预览后变化时拒绝覆盖', async () => {
    const plan = await service.createUpsertPlan({
      projectRoots: [],
      definition,
      targets: [{ agent: 'test-agent', surface: 'cli', scope: 'user' }],
    })
    await fs.writeFile(configPath, '{"changedByUser":true}\n', 'utf8')

    const result = await service.applyPlan(plan.planId)
    expect(result.results[0]).toMatchObject({ ok: false, code: 'MCP_CONFIG_CHANGED' })
    await expect(fs.readFile(configPath, 'utf8')).resolves.toContain('changedByUser')
  })

  it('撤销时拒绝覆盖操作后的用户修改', async () => {
    const plan = await service.createUpsertPlan({
      projectRoots: [],
      definition,
      targets: [{ agent: 'test-agent', surface: 'cli', scope: 'user' }],
    })
    const applied = await service.applyPlan(plan.planId)
    await fs.writeFile(configPath, '{"changedAfterApply":true}\n', 'utf8')

    const restored = await service.restore(applied.operationId)
    expect(restored).toEqual([
      expect.objectContaining({ path: configPath, ok: false }),
    ])
    await expect(fs.readFile(configPath, 'utf8')).resolves.toContain('changedAfterApply')
  })

  it('只向指定安装写入密钥且 IPC 结果不返回密钥值', async () => {
    await fs.writeFile(
      configPath,
      JSON.stringify({
        keep: 'private source text',
        mcpServers: {
          database: {
            command: 'node',
            args: ['server.js'],
            env: { DATABASE_URL: '${DATABASE_URL}' },
          },
        },
      }),
      'utf8',
    )
    const scan = await service.scan()
    const installation = scan.installations.find((item) => item.definition.name === 'database')
    expect(installation).toBeDefined()
    if (!installation) throw new Error('测试 MCP 安装不存在')

    const result = await service.setSecret({
      projectRoots: [],
      installationId: installation.id,
      secretName: 'DATABASE_URL',
      secretValue: 'postgres://local-secret',
    })

    expect(result.results).toEqual([
      expect.objectContaining({ path: configPath, ok: true }),
    ])
    expect(JSON.stringify(result)).not.toContain('postgres://local-secret')
    const config = JSON.parse(await fs.readFile(configPath, 'utf8')) as {
      keep: string
      mcpServers: { database: { env: Record<string, string> } }
    }
    expect(config.keep).toBe('private source text')
    expect(config.mcpServers.database.env.DATABASE_URL).toBe('postgres://local-secret')

    const restored = await service.restore(result.operationId)
    expect(restored).toEqual([expect.objectContaining({ path: configPath, ok: true })])
    await expect(fs.readFile(configPath, 'utf8')).resolves.toContain('${DATABASE_URL}')
  })

  it('拒绝把普通运行时环境变量当作密钥写入', async () => {
    await fs.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          internal: {
            command: 'node',
            args: ['server.js'],
            env: { CODEX_HOME: '${CODEX_HOME}' },
          },
        },
      }),
      'utf8',
    )
    const scan = await service.scan()
    const installation = scan.installations.find((item) => item.definition.name === 'internal')
    expect(installation).toBeDefined()
    if (!installation) throw new Error('测试 MCP 安装不存在')

    await expect(
      service.setSecret({
        projectRoots: [],
        installationId: installation.id,
        secretName: 'CODEX_HOME',
        secretValue: '/tmp/codex-home',
      }),
    ).rejects.toThrow('不是需要手动填写的凭据')
    await expect(fs.readFile(configPath, 'utf8')).resolves.not.toContain('/tmp/codex-home')
  })

  it('同一安装内不覆盖已经取到值的凭据引用', async () => {
    vi.stubEnv('SB_TEST_PRESENT_TOKEN', 'from-shell')
    vi.stubEnv('SB_TEST_ABSENT_TOKEN', '')
    await fs.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          mixed: {
            command: 'node',
            args: ['server.js'],
            env: {
              SB_TEST_PRESENT_TOKEN: '${SB_TEST_PRESENT_TOKEN}',
              SB_TEST_ABSENT_TOKEN: '${SB_TEST_ABSENT_TOKEN}',
            },
          },
        },
      }),
      'utf8',
    )
    const scan = await service.scan()
    const installation = scan.installations.find((item) => item.definition.name === 'mixed')
    if (!installation) throw new Error('测试 MCP 安装不存在')

    // 缺一个就整体 missing-secrets，但只有真正缺值的那个可以写入。
    expect(installation.authState).toBe('missing-secrets')
    expect(installation.missingSecrets).toEqual(['SB_TEST_ABSENT_TOKEN'])

    await expect(
      service.setSecret({
        projectRoots: [],
        installationId: installation.id,
        secretName: 'SB_TEST_PRESENT_TOKEN',
        secretValue: 'plaintext-should-not-land',
      }),
    ).rejects.toThrow('当前已有取值')
    await expect(fs.readFile(configPath, 'utf8')).resolves.toContain('${SB_TEST_PRESENT_TOKEN}')

    const result = await service.setSecret({
      projectRoots: [],
      installationId: installation.id,
      secretName: 'SB_TEST_ABSENT_TOKEN',
      secretValue: 'plaintext-allowed',
    })
    expect(result.results).toEqual([expect.objectContaining({ path: configPath, ok: true })])
    const config = JSON.parse(await fs.readFile(configPath, 'utf8')) as {
      mcpServers: { mixed: { env: Record<string, string> } }
    }
    expect(config.mcpServers.mixed.env.SB_TEST_ABSENT_TOKEN).toBe('plaintext-allowed')
    expect(config.mcpServers.mixed.env.SB_TEST_PRESENT_TOKEN).toBe('${SB_TEST_PRESENT_TOKEN}')
  })

  it.each([
    {
      label: 'URL 用户名密码',
      definition: {
        name: 'unsafe',
        transport: {
          kind: 'streamable-http',
          url: 'https://user:password@example.com/mcp',
          headers: {},
        },
        requiredSecrets: [],
      },
    },
    {
      label: 'URL 查询参数',
      definition: {
        name: 'unsafe',
        transport: {
          kind: 'streamable-http',
          url: 'https://example.com/mcp?token=plain-secret',
          headers: {},
        },
        requiredSecrets: [],
      },
    },
    {
      label: 'URL 片段',
      definition: {
        name: 'unsafe',
        transport: {
          kind: 'streamable-http',
          url: 'https://example.com/mcp#secret',
          headers: {},
        },
        requiredSecrets: [],
      },
    },
    {
      label: '敏感命令参数',
      definition: {
        name: 'unsafe',
        transport: {
          kind: 'stdio',
          command: 'node',
          args: ['server.js', '--api-key=plain-secret'],
          env: {},
        },
        requiredSecrets: [],
      },
    },
    {
      label: '明文环境变量',
      definition: {
        name: 'unsafe',
        transport: {
          kind: 'stdio',
          command: 'node',
          args: ['server.js'],
          env: { TOKEN: { kind: 'literal', value: 'plain-secret' } },
        },
        requiredSecrets: [],
      },
    },
  ])('拒绝来自 Renderer 的恶意 MCP 定义：$label', async ({ definition: unsafe }) => {
    await expect(
      service.createUpsertPlan({
        projectRoots: [],
        definition: unsafe as McpServerDefinition,
        targets: [{ agent: 'test-agent', surface: 'cli', scope: 'user' }],
      }),
    ).rejects.toMatchObject({ code: 'MCP_WRITE_VALIDATION_FAILED' })
    await expect(fs.readFile(configPath, 'utf8')).resolves.not.toContain('plain-secret')
  })
})
