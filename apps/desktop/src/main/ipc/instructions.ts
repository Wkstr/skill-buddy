import { app, ipcMain } from 'electron'
import { join } from 'node:path'
import type {
  InstructionBridgePlanRequest,
  InstructionDeletePlanRequest,
  InstructionEffectiveChainRequest,
  InstructionReadRequest,
  InstructionScanRequest,
  InstructionWritePlanRequest,
} from '#shared/ipc'
import { InstructionService } from '../instructions/service'

export function registerInstructionsIpc(): InstructionService {
  const service = new InstructionService(join(app.getPath('userData'), 'instruction-backups'))
  ipcMain.handle('instructions:profiles', () => service.profiles())
  ipcMain.handle('instructions:scan', (_event, request: InstructionScanRequest) => service.scan(request.projectRoots))
  ipcMain.handle('instructions:scan-projects', (_event, request: InstructionScanRequest) => service.scanProjects(request.projectRoots))
  ipcMain.handle('instructions:effective-chain', (_event, request: InstructionEffectiveChainRequest) => service.effectiveChain(request.surface, request.projectRoot, request.targetDirectory, request.includesGlobal ?? true))
  ipcMain.handle('instructions:read', (_event, request: InstructionReadRequest) => service.read(request.path))
  ipcMain.handle('instructions:plan-write', (_event, request: InstructionWritePlanRequest) => service.createWritePlan(request))
  ipcMain.handle('instructions:plan-delete', (_event, request: InstructionDeletePlanRequest) => service.createDeletePlan(request))
  ipcMain.handle('instructions:plan-bridge', (_event, request: InstructionBridgePlanRequest) => service.createBridgePlan(request))
  ipcMain.handle('instructions:apply-plan', (_event, planId: string) => service.applyPlan(planId))
  ipcMain.handle('instructions:apply-bridge', (_event, planId: string) => service.applyBridgePlan(planId))
  ipcMain.handle('instructions:restore', (_event, operationId: string) => service.restore(operationId))
  ipcMain.handle('instructions:watch-start', (_event, projectRoots: string[]) => service.watch(projectRoots))
  return service
}
