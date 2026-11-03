// Pump element: active head generator with quadratic pump curve.

import type { ParamValue } from '../../parts/partApi'
import { resolveFluidNum } from '../fluidBindings'
import type { PumpElementDecl } from '../fluidTypes'
import type { ElementSlots, FluidElementModule, GraphEmitter } from './registry'

export interface PumpCommand {
  speed?: number
  rpm?: number
}

export const pumpElementModule: FluidElementModule<PumpElementDecl, PumpCommand> = {
  kind: 'pump',
  parseCommand(raw: unknown): PumpCommand | undefined {
    if (typeof raw !== 'object' || raw === null) return undefined
    const r = raw as Record<string, unknown>
    const out: PumpCommand = {}
    if (typeof r.speed === 'number' && Number.isFinite(r.speed)) {
      out.speed = Math.max(0, r.speed)
    }
    if (typeof r.rpm === 'number' && Number.isFinite(r.rpm)) {
      out.rpm = Math.max(0, r.rpm)
    }
    return out
  },
  compile(
    decl: PumpElementDecl,
    params: Readonly<Record<string, ParamValue>>,
    portNodes: ReadonlyMap<string, number>,
    _isPortConnected: (portName: string) => boolean,
    emit: GraphEmitter,
  ): ElementSlots {
    const nSuction = portNodes.get(decl.suction)
    const nDischarge = portNodes.get(decl.discharge)
    if (nSuction === undefined || nDischarge === undefined) {
      return { nodeIndices: [], edgeIndices: [] }
    }

    const pShutoff = Math.max(1, resolveFluidNum(decl.shutoffHead, params, 550000)) // Pa
    const qRated = Math.max(1e-5, resolveFluidNum(decl.ratedFlow, params, 0.01)) // m³/s
    const RPump = pShutoff / (qRated * qRated)
    const rPump = 0.05 * (pShutoff / qRated)

    const oneWay = decl.reverseFlow === false
    const edgeIdx = emit.addEdge(nSuction, nDischarge, rPump, RPump, 0, 1, oneWay)
    return { nodeIndices: [], edgeIndices: [edgeIdx] }
  },
}
