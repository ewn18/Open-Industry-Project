// Pipe element: conduit between two ports with Darcy-Weisbach friction.

import type { ParamValue } from '../../parts/partApi'
import { resolveFluidNum } from '../fluidBindings'
import type { PipeElementDecl } from '../fluidTypes'
import { WATER_DENSITY_KG_M3 } from '../fluidUnits'
import type { ElementSlots, FluidElementModule, GraphEmitter } from './registry'

/** Darcy friction factor estimation for commercial steel / industrial piping. */
const DARCY_F = 0.02

export const pipeElementModule: FluidElementModule<PipeElementDecl> = {
  kind: 'pipe',
  compile(
    decl: PipeElementDecl,
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
    const l = Math.max(0.05, resolveFluidNum(decl.length, params, 1.0)) // metres

    // Darcy-Weisbach pressure drop: ΔP = (8 * f * ρ * L / (π² * D⁵)) * Q²
    const R = (8 * DARCY_F * WATER_DENSITY_KG_M3 * l) / (Math.PI * Math.PI * Math.pow(d, 5))
    // Small laminar / regularization slope around Q=0 to keep conductance regular:
    // r = (128 * μ * L) / (π * D⁴) with μ ≈ 1e-3 Pa·s
    const r = (128 * 0.001 * l) / (Math.PI * Math.pow(d, 4))

    const edgeIdx = emit.addEdge(na, nb, r, R, 0, 1, false)
    return { nodeIndices: [], edgeIndices: [edgeIdx] }
  },
}
