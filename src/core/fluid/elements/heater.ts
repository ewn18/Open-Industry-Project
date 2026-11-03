// Heater element: in-line thermal energy injector (Watts).

import type { ParamValue } from '../../parts/partApi'
import { resolveFluidNum } from '../fluidBindings'
import type { HeaterElementDecl } from '../fluidTypes'
import { WATER_DENSITY_KG_M3 } from '../fluidUnits'
import type { ElementSlots, FluidElementModule, GraphEmitter } from './registry'

export interface HeaterCommand {
  /** Commanded power in Watts (0 .. maxPower), or boolean enable. */
  power?: number
  enabled?: boolean
}

export const heaterElementModule: FluidElementModule<HeaterElementDecl, HeaterCommand> = {
  kind: 'heater',
  parseCommand(raw: unknown): HeaterCommand | undefined {
    if (typeof raw !== 'object' || raw === null) return undefined
    const r = raw as Record<string, unknown>
    const out: HeaterCommand = {}
    if (typeof r.power === 'number' && Number.isFinite(r.power)) {
      out.power = Math.max(0, r.power)
    }
    if (typeof r.enabled === 'boolean') {
      out.enabled = r.enabled
    }
    return out
  },
  compile(
    decl: HeaterElementDecl,
    params: Readonly<Record<string, ParamValue>>,
    portNodes: ReadonlyMap<string, number>,
    _isPortConnected: (portName: string) => boolean,
    emit: GraphEmitter,
  ): ElementSlots {
    const na = portNodes.get(decl.a)
    const nb = portNodes.get(decl.b)
    if (na === undefined || nb === undefined) {
      return { nodeIndices: [], edgeIndices: [] }
    }

    const d = Math.max(0.005, resolveFluidNum(decl.diameter, params, 0.05)) // metres

    // Low pressure drop: K ≈ 0.5
    const R = (8 * 0.5 * WATER_DENSITY_KG_M3) / (Math.PI * Math.PI * Math.pow(d, 4))
    const r = 0.005

    const edgeIdx = emit.addEdge(na, nb, r, R, 0, 1, false)
    return { nodeIndices: [], edgeIndices: [edgeIdx] }
  },
}
