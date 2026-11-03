// Tank element: storage reservoir with multi-elevation nozzles and hydrostatic head.

import type { ParamValue } from '../../parts/partApi'
import { resolveFluidNum } from '../fluidBindings'
import type { TankElementDecl } from '../fluidTypes'
import { GRAVITY_M_S2, WATER_DENSITY_KG_M3 } from '../fluidUnits'
import type { ElementSlots, FluidElementModule, GraphEmitter } from './registry'

export interface TankCommand {
  /** Override or set liquid level in metres (0 .. height). */
  level?: number
}

export const tankElementModule: FluidElementModule<TankElementDecl, TankCommand> = {
  kind: 'tank',
  parseCommand(raw: unknown): TankCommand | undefined {
    if (typeof raw !== 'object' || raw === null) return undefined
    const r = raw as Record<string, unknown>
    if (typeof r.level === 'number' && Number.isFinite(r.level)) {
      return { level: Math.max(0, r.level) }
    }
    return undefined
  },
  compile(
    decl: TankElementDecl,
    params: Readonly<Record<string, ParamValue>>,
    portNodes: ReadonlyMap<string, number>,
    _isPortConnected: (portName: string) => boolean,
    emit: GraphEmitter,
  ): ElementSlots {
    const area = Math.max(0.01, resolveFluidNum(decl.area, params, 1.0)) // m²
    const height = Math.max(0.1, resolveFluidNum(decl.height, params, 2.0)) // m
    const initLevel = Math.max(0, Math.min(height, resolveFluidNum(decl.initialLevel, params, 0))) // m

    // Vented atmospheric reference node
    const isVented = decl.vented !== false
    const refNode = emit.addNode(isVented ? 'fixed' : 'free', area / (WATER_DENSITY_KG_M3 * GRAVITY_M_S2), 0, true)

    const edgeSlots: number[] = []

    for (const pSpec of decl.ports) {
      const nPort = portNodes.get(pSpec.port)
      if (nPort === undefined) continue

      const z = Math.max(0, resolveFluidNum(pSpec.height, params, 0)) // nozzle elevation from bottom
      const head = Math.max(0, initLevel - z) * WATER_DENSITY_KG_M3 * GRAVITY_M_S2

      // Nozzle edge: from refNode to nPort
      // Driving head = hydrostatic pressure rho * g * (level - z)
      const edgeIdx = emit.addEdge(refNode, nPort, 0.001, 100, head, 1, false)
      edgeSlots.push(edgeIdx)
    }

    return {
      nodeIndices: [refNode],
      edgeIndices: edgeSlots,
    }
  },
}
