import { BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import {
  deriveEffectiveInstructionChain,
  diagnoseInstructions,
  listInstructionProfiles,
  scanInstructionDocuments,
  MAX_INSTRUCTION_FILE_BYTES,
  type EffectiveInstructionChain,
  type InstructionRuleProfile,
  type SurfaceRef,
} from '@skillbuddy/core'
import type {
  InstructionBridgePlanRequest,
  InstructionDeletePlanRequest,
  InstructionOperationPlanView,
  InstructionOperationResult,
  InstructionReadResult,
  InstructionServiceScan,
  InstructionWritePlanRequest,
} from '#shared/ipc'
import { InstructionBackupStore, type InstructionBackupRecord } from './backups'
import {
  InstructionPathPolicy,
  sanitizeInstructionProjectRoots,
  type InstructionManagedTarget,
} from './path-policy'
import {
  hashInstructionContent,
  instructionTombstonePath,
  readInstructionSnapshot,
  transactionalDeleteInstruction,
  transactionalWriteInstruction,
  validateInstructionContent,
} from './transaction'
import { InstructionWatcher } from './watcher'

interface StoredInstructionPlan {
  view: InstructionOperationPlanView
  mutation: {
    target: InstructionManagedTarget
    expectedIdentity: string | null
    content?: string
    bridgeSourcePath?: string
  }
}

const PLAN_TTL = 5 * 60_000
const BACKUP_TTL = 11 * 60_000

export class InstructionService {
  readonly #backups: InstructionBackupStore
  readonly #plans = new Map<string, StoredInstructionPlan>()
  readonly #policy = new InstructionPathPolicy()
  readonly #watcher = new InstructionWatcher()
  #projectRoots: string[] = []
  #scan: InstructionServiceScan | null = null

  constructor(backupRoot: string) {
    this.#backups = new InstructionBackupStore(backupRoot)
  }

  profiles(): InstructionRuleProfile[] {
    return listInstructionProfiles()
  }

  async scan(projectRoots: string[] = []): Promise<InstructionServiceScan> {
    const roots = await sanitizeInstructionProjectRoots(projectRoots)
    const result = await scanInstructionDocuments(roots)
    const diagnostics = [...result.warnings, ...await diagnoseInstructions(result.documents)]
    this.#projectRoots = roots
    this.#scan = { ...result, profiles: listInstructionProfiles(), diagnostics }
    this.#policy.setState(result.scannedRoots, result.documents, this.#scan.profiles)
    return this.#scan
  }

  async scanProjects(projectRoots: string[] = []): Promise<InstructionServiceScan> {
    const roots = await sanitizeInstructionProjectRoots(projectRoots)
    const result = await scanInstructionDocuments(roots, { includeGlobal: false })
    const diagnostics = [...result.warnings, ...await diagnoseInstructions(result.documents)]
    return { ...result, profiles: listInstructionProfiles(), diagnostics }
  }

  async effectiveChain(surface: SurfaceRef, projectRoot: string, targetDirectory: string, includeGlobal = true): Promise<EffectiveInstructionChain> {
    const scan = this.#scan ?? await this.scan(this.#projectRoots)
    const chain = deriveEffectiveInstructionChain(surface, projectRoot, targetDirectory, scan.documents)
    return includeGlobal ? chain : { ...chain, documents: chain.documents.filter((document) => document.scope === 'project'), includesGlobal: false }
  }

  async read(path: string): Promise<InstructionReadResult> {
    const scan = this.#scan ?? await this.scan(this.#projectRoots)
    const document = scan.documents.find((item) => item.path === resolve(path))
    if (!document) throw new Error('指令文件不在受管扫描结果中')
    if (document.linkBroken) throw new Error('链接目标无效或已越出允许范围')
    const source = await fs.realpath(document.path)
    const allowedRoot = await fs.realpath(resolve(document.projectRoot ?? homedir())).catch(() => resolve(document.projectRoot ?? homedir()))
    const relation = relative(allowedRoot, source)
    if (relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
      throw new Error('指令文件已越出允许范围')
    }
    const handle = await fs.open(document.path, 'r')
    try {
      const current = await handle.stat()
      const buffer = Buffer.alloc(Math.min(current.size, MAX_INSTRUCTION_FILE_BYTES))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      return {
        path: document.path,
        content: buffer.subarray(0, bytesRead).toString('utf8'),
        truncated: current.size > MAX_INSTRUCTION_FILE_BYTES,
        document,
      }
    } finally {
      await handle.close()
    }
  }

  async watch(projectRoots: string[]): Promise<number> {
    this.stopWatch()
    const roots = await sanitizeInstructionProjectRoots(projectRoots)
    const globalParents = new Set(this.profiles().flatMap((profile) => profile.globalPaths.map(dirname)))
    return this.#watcher.start(roots, [...globalParents], () => {
      const before = this.#scan ? instructionScanFingerprint(this.#scan) : ''
      void this.scan(roots).then((next) => {
        if (before === instructionScanFingerprint(next)) return
        for (const window of BrowserWindow.getAllWindows()) window.webContents.send('instructions:changed')
      }).catch(() => undefined)
    })
  }

  async createWritePlan(request: InstructionWritePlanRequest): Promise<InstructionOperationPlanView> {
    await this.scan(request.projectRoots)
    const blockers: InstructionOperationPlanView['blockers'] = []
    const warnings: InstructionOperationPlanView['warnings'] = []
    let target: InstructionManagedTarget
    try {
      validateInstructionContent(request.content)
      target = await this.#policy.assertWriteTarget(request.path)
    } catch (error) {
      return this.storeBlockedPlan('write', request.path, '', request.content, error)
    }

    const snapshot = await readInstructionSnapshot(target.path)
    let beforeText = ''
    if (snapshot?.kind === 'symlink') {
      blockers.push({ code: 'link-read-only', message: '链接型指令文件不可直接编辑' })
    } else if (snapshot) {
      try {
        beforeText = new TextDecoder('utf-8', { fatal: true }).decode(snapshot.content)
      } catch {
        blockers.push({ code: 'invalid-encoding', message: '现有文件不是有效 UTF-8，禁止直接保存' })
      }
    }
    const actualIdentity = snapshot?.identity ?? null
    if (actualIdentity !== request.expectedHash) {
      blockers.push(request.expectedHash === null
        ? { code: 'already-exists', message: '目标文件已存在，请改为编辑现有指令文件' }
        : { code: 'externally-changed', message: '文件已在编辑期间发生外部变化，请比较后重新编辑' })
    }
    const view = this.makePlanView({
      intent: 'write',
      path: target.path,
      beforeText,
      afterText: request.content,
      created: snapshot === null,
      linked: false,
      blockers,
      warnings,
    })
    this.storePlan(view, { target, expectedIdentity: actualIdentity, content: request.content })
    return view
  }

  async createDeletePlan(request: InstructionDeletePlanRequest): Promise<InstructionOperationPlanView> {
    await this.scan(request.projectRoots)
    let target: InstructionManagedTarget
    try {
      target = await this.#policy.assertDeleteTarget(request.path)
    } catch (error) {
      return this.storeBlockedPlan('delete', request.path, '', '', error)
    }
    const snapshot = await readInstructionSnapshot(target.path)
    if (!snapshot) return this.storeBlockedPlan('delete', target.path, '', '', new Error('待删除文件不存在'))
    const blockers: InstructionOperationPlanView['blockers'] = []
    const warnings: InstructionOperationPlanView['warnings'] = []
    let invalidEncoding = false
    const beforeText = snapshot.kind === 'symlink'
      ? `symlink -> ${snapshot.linkTarget ?? ''}`
      : (() => {
          try {
            return new TextDecoder('utf-8', { fatal: true }).decode(snapshot.content)
          } catch {
            invalidEncoding = true
            return '[non-UTF-8 content]'
          }
        })()
    /**
     * 与扫描结果比较而不是与 snapshot.identity 比较：符号链接的 contentHash 是链接目标
     * 内容哈希，超限文件的 contentHash 为空，两者都与文件身份哈希不同源。plan 生成之后的
     * 外部改动由 transactionalDeleteInstruction 的 expectedIdentity 校验负责。
     */
    if (target.document?.contentHash !== request.expectedHash) {
      blockers.push({ code: 'externally-changed', message: '文件已在操作前发生外部变化，请刷新后重试' })
    }
    if (snapshot.kind === 'symlink') {
      warnings.push({ code: 'delete-link-only', message: '只会删除链接条目，被链接的源文件保持不变' })
    } else {
      if (invalidEncoding) {
        warnings.push({ code: 'invalid-encoding', message: '文件不是有效 UTF-8，删除前仍会按原始字节备份' })
      }
    }
    const view = this.makePlanView({
      intent: 'delete',
      path: target.path,
      beforeText,
      afterText: '',
      created: false,
      linked: snapshot.kind === 'symlink',
      blockers,
      warnings,
      impacts: this.deleteImpacts(target),
    })
    this.storePlan(view, { target, expectedIdentity: snapshot.identity })
    return view
  }

  async createBridgePlan(request: InstructionBridgePlanRequest): Promise<InstructionOperationPlanView> {
    await this.scan(request.projectRoots)
    let bridge: Awaited<ReturnType<InstructionPathPolicy['assertBridgeTarget']>>
    try {
      bridge = await this.#policy.assertBridgeTarget(request.sourcePath)
    } catch (error) {
      return this.storeBlockedPlan('bridge', request.sourcePath, '', '@AGENTS.md\n', error)
    }

    const blockers: InstructionOperationPlanView['blockers'] = []
    const warnings: InstructionOperationPlanView['warnings'] = []
    if (bridge.source.contentHash !== request.expectedHash) {
      blockers.push({ code: 'externally-changed', message: 'AGENTS.md 已发生外部变化，请刷新后重试' })
    }

    const snapshot = await readInstructionSnapshot(bridge.target.path)
    let beforeText = ''
    let afterText = '@AGENTS.md\n'
    if (snapshot) {
      if (snapshot.kind === 'symlink') {
        beforeText = `symlink -> ${snapshot.linkTarget ?? ''}`
        if (bridge.target.document?.bindings.some((binding) => binding.status === 'bridged')) {
          warnings.push({ code: 'bridge-already-exists', message: 'CLAUDE.md 已经桥接到 AGENTS.md' })
          afterText = beforeText
        } else {
          blockers.push({ code: 'bridge-conflict', message: 'CLAUDE.md 已存在，SkillBuddy 不会替换现有文件' })
        }
      } else {
        try {
          beforeText = new TextDecoder('utf-8', { fatal: true }).decode(snapshot.content)
          if (hasAgentsImport(beforeText)) {
            warnings.push({ code: 'bridge-already-exists', message: 'CLAUDE.md 已包含 AGENTS.md 导入' })
            afterText = beforeText
          } else {
            blockers.push({ code: 'bridge-conflict', message: 'CLAUDE.md 已存在独立内容，SkillBuddy 不会自动覆盖' })
          }
        } catch {
          beforeText = '[non-UTF-8 content]'
          blockers.push({ code: 'invalid-encoding', message: '现有 CLAUDE.md 不是有效 UTF-8，禁止自动桥接' })
        }
      }
    }

    const view = this.makePlanView({
      intent: 'bridge',
      path: bridge.target.path,
      beforeText,
      afterText,
      created: snapshot === null,
      linked: snapshot?.kind === 'symlink',
      blockers,
      warnings,
    })
    this.storePlan(view, {
      target: bridge.target,
      expectedIdentity: snapshot?.identity ?? null,
      content: '@AGENTS.md\n',
      bridgeSourcePath: bridge.source.path,
    })
    return view
  }

  async applyPlan(planId: string): Promise<InstructionOperationResult> {
    const stored = this.#plans.get(planId)
    if (!stored || stored.view.expiresAt < Date.now()) {
      this.#plans.delete(planId)
      throw new Error('指令操作计划已过期，请重新预览')
    }
    if (!stored.view.canApply) throw new Error('指令操作计划不可执行')
    const operationId = randomUUID()
    let backup: InstructionBackupRecord | undefined
    try {
      if (stored.view.intent === 'write' || stored.view.intent === 'bridge') {
        if (stored.view.intent === 'bridge') {
          if (!stored.mutation.bridgeSourcePath) throw new Error('桥接计划缺少源文件')
          await this.scan(this.#projectRoots)
          const bridge = await this.#policy.assertBridgeTarget(stored.mutation.bridgeSourcePath)
          if (bridge.target.document) throw new Error('CLAUDE.md 已存在，桥接计划不再有效')
        }
        await this.#policy.assertWriteTarget(stored.mutation.target.path)
        const content = stored.mutation.content ?? ''
        const afterHash = hashInstructionContent(Buffer.from(content))
        await transactionalWriteInstruction({
          path: stored.mutation.target.path,
          content,
          expectedIdentity: stored.mutation.expectedIdentity,
          createMode: stored.mutation.target.scope === 'project' ? 0o644 : 0o600,
          beforeCommit: async (original) => {
            backup = await this.#backups.stage(
              operationId,
              stored.view.intent === 'bridge' ? 'write' : stored.view.intent,
              stored.mutation.target,
              original,
              afterHash,
            )
          },
        })
      } else {
        await this.#policy.assertDeleteTarget(stored.mutation.target.path)
        const tombstonePath = instructionTombstonePath(stored.mutation.target.path)
        await transactionalDeleteInstruction({
          path: stored.mutation.target.path,
          tombstonePath,
          expectedIdentity: stored.mutation.expectedIdentity ?? '',
          beforeCommit: async (original) => {
            backup = await this.#backups.stage(
              operationId,
              'delete',
              stored.mutation.target,
              original,
              null,
              tombstonePath,
            )
          },
        })
      }
      this.#plans.delete(planId)
      this.#backups.expire(operationId, BACKUP_TTL)
      await this.scan(this.#projectRoots).catch(() => undefined)
      return { operationId, path: stored.mutation.target.path, ok: true }
    } catch (error) {
      if (backup) await this.#backups.discard(backup)
      this.#plans.delete(planId)
      return {
        operationId,
        path: stored.mutation.target.path,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  async applyBridgePlan(planId: string): Promise<InstructionOperationResult> {
    const stored = this.#plans.get(planId)
    if (stored?.view.intent !== 'bridge') throw new Error('该计划不是 Claude Code 桥接计划')
    return this.applyPlan(planId)
  }

  async restore(operationId: string): Promise<{ path: string; ok: boolean; error?: string }[]> {
    const results = await this.#backups.restore(operationId, this.#policy)
    if (results.some((result) => result.ok)) await this.scan(this.#projectRoots).catch(() => undefined)
    return results
  }

  stopWatch(): void {
    this.#watcher.stop()
  }

  private makePlanView(input: Omit<InstructionOperationPlanView, 'planId' | 'expiresAt' | 'canApply'>): InstructionOperationPlanView {
    return {
      ...input,
      planId: randomUUID(),
      expiresAt: Date.now() + PLAN_TTL,
      canApply:
        input.blockers.length === 0
        && (input.created || input.intent === 'delete' || input.beforeText !== input.afterText),
    }
  }

  private storePlan(
    view: InstructionOperationPlanView,
    mutation: StoredInstructionPlan['mutation'],
  ): void {
    this.#plans.set(view.planId, { view, mutation })
    setTimeout(() => this.#plans.delete(view.planId), PLAN_TTL).unref()
  }

  private storeBlockedPlan(
    intent: InstructionOperationPlanView['intent'],
    path: string,
    beforeText: string,
    afterText: string,
    error: unknown,
  ): InstructionOperationPlanView {
    return this.makePlanView({
      intent,
      path,
      beforeText,
      afterText,
      created: false,
      linked: false,
      blockers: [{
        code: 'invalid-target',
        message: error instanceof Error ? error.message : String(error),
      }],
      warnings: [],
    })
  }

  private deleteImpacts(target: InstructionManagedTarget): NonNullable<InstructionOperationPlanView['impacts']> {
    if (!target.document) return []
    const seen = new Set<string>()
    const profiles = this.profiles()
    return target.document.bindings.flatMap((binding) => {
      const key = `${binding.surface.vendorId}/${binding.surface.productId}/${binding.surface.surfaceId}`
      if (seen.has(key)) return []
      seen.add(key)
      const profile = profiles.find((candidate) =>
        candidate.key.vendorId === binding.surface.vendorId
        && candidate.key.productId === binding.surface.productId
        && candidate.key.surfaceId === binding.surface.surfaceId,
      )
      const chainPaths = target.projectRoot && this.#scan
        ? deriveEffectiveInstructionChain(
            binding.surface,
            target.projectRoot,
            dirname(target.path),
            this.#scan.documents,
          ).documents.map((document) => document.path)
        : []
      return [{ tool: profile?.displayName ?? key, chainPaths }]
    })
  }
}

function instructionScanFingerprint(scan: InstructionServiceScan): string {
  return JSON.stringify({
    documents: scan.documents.map((document) => [
      document.path,
      document.contentHash,
      document.modifiedAt,
      document.size,
      document.linked,
      document.linkBroken,
      document.encodingInvalid,
    ]),
    warnings: scan.warnings.map((warning) => [warning.code, warning.message, warning.paths]),
    diagnostics: scan.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.message, diagnostic.paths]),
  })
}

function hasAgentsImport(content: string): boolean {
  return content.split(/\r?\n/).some((line) => line.trim() === '@AGENTS.md')
}
