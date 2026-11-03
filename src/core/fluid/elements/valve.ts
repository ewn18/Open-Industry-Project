// Valve element: variable resistance flow control (on/off, proportional, throttling).

import type { ParamValue } from '../../parts/partApi'
import { resolveFluidBool, resolveFluidNum } from '../fluidBindings'
import type { ValveElementDecl } from '../fluidTypes'
import { WATER_DENSITY_KG_M3 } from '../fluidUnits'
import type { ElementSlots, FluidElementModule, GraphEmitter } from './registry'

export interface ValveCommand {
  /** Valve position: fraction open 0 (closed) to 1 (fully open), or boolean. */
  open?: number | boolean
}

/** Compute the effective opening factor `0..1` for a given command and characteristic. */
export function valveOpeningFactor(
  cmdVal: number | boolean | undefined,
  characteristic: 'linear' | 'equalPercent' | 'quickOpen' = 'linear',
): number {
  if (cmdVal === undefined) return 1
  const x = typeof cmdVal === 'boolean' ? (cmdVal ? 1 : 0) : Math.max(0, Math.min(1, cmdVal))
  if (x <= 1e-4) return 0
  if (x >= 0.999) return 1

  switch (characteristic) {
    case 'equalPercent':
      // Rangeability R0 = 50: f(x) = R0^(x - 1)
      return Math.pow(50, x - 1)
    case 'quickOpen':
      return Math.sqrt(x)
    case 'linear':
    default:
      return x
  }
}

export const valveElementModule: FluidElementModule<ValveElementDecl, ValveCommand> = {
  kind: 'valve',
  parseCommand(raw: unknown): ValveCommand | undefined {
    if (typeof raw !== 'object' || raw === null) return undefined
    const r = raw as Record<string, unknown>
    if (typeof r.open === 'boolean') {
      return { open: r.open }
    }
    if (typeof r.open === 'number' && Number.isFinite(r.open)) {
      return { open: Math.max(0, Math.min(1, r.open)) }
    }
    return undefined
  },
  compile(
    decl: ValveElementDecl,
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

    const d = Math.max(0.005, resolveFluidNum(decl.diameter, params, 0.1)) // metres
    const isNormallyOpen = decl.normallyOpen ? resolveFluidBool(decl.normallyOpen, params, true) : true
    const initOpen = isNormallyOpen ? 1 : 0

    // Loss coefficient K ≈ 1.5 for full open valve
    // ΔP = (8 * K * ρ / (π² * D⁴)) * Q²
    const R = (8 * 1.5 * WATER_DENSITY_KG_M3) / (Math.PI * Math.PI * Math.pow(d, 4))
    const r = 0.01

    const edgeIdx = emit.addEdge(na, nb, r, R, 0, initOpen, false)
    return { nodeIndices: [], edgeIndices: [edgeIdx] }
  },
}
