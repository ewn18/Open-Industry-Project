// Check valve element: passive one-way flow preventer with cracking pressure threshold.

import type { ParamValue } from '../../parts/partApi'
import { resolveFluidNum } from '../fluidBindings'
import type { CheckValveElementDecl } from '../fluidTypes'
import { WATER_DENSITY_KG_M3 } from '../fluidUnits'
import type { ElementSlots, FluidElementModule, GraphEmitter } from './registry'

export const checkValveElementModule: FluidElementModule<CheckValveElementDecl> = {
  kind: 'checkValve',
  compile(
    decl: CheckValveElementDecl,
    params: Readonly<Record<string, ParamValue>>,
    portNodes: ReadonlyMap<string, number>,
    _isPortConnected: (portName: string) => boolean,
    emit: GraphEmitter,
  ): ElementSlots {
    const nInlet = portNodes.get(decl.inlet)
    const nOutlet = portNodes.get(decl.outlet)
    if (nInlet === undefined || nOutlet === undefined) {
      return { nodeIndices: [], edgeIndices: [] }
    }

    const d = Math.max(0.005, resolveFluidNum(decl.diameter, params, 0.1)) // metres
    const pCrack = Math.max(0, resolveFluidNum(decl.crackingPressure, params, 0)) // Pa

    // K ≈ 2.0 for standard swing/lift check valve
    const R = (8 * 2.0 * WATER_DENSITY_KG_M3) / (Math.PI * Math.PI * Math.pow(d, 4))
    const r = 0.01

    // Reverse flow is blocked; forward flow requires Delta P >= pCrack (modeled as negative bias H = -pCrack)
    const edgeIdx = emit.addEdge(nInlet, nOutlet, r, R, -pCrack, 1, true)
    return { nodeIndices: [], edgeIndices: [edgeIdx] }
  },
}
