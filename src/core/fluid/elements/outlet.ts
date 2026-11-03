// Outlet element: discharge boundary into atmosphere with exit kinetic loss.

import type { ParamValue } from '../../parts/partApi'
import { resolveFluidBool, resolveFluidNum } from '../fluidBindings'
import type { OutletElementDecl } from '../fluidTypes'
import { WATER_DENSITY_KG_M3 } from '../fluidUnits'
import type { ElementSlots, FluidElementModule, GraphEmitter } from './registry'

export const outletElementModule: FluidElementModule<OutletElementDecl> = {
  kind: 'outlet',
  compile(
    decl: OutletElementDecl,
    params: Readonly<Record<string, ParamValue>>,
    portNodes: ReadonlyMap<string, number>,
    isPortConnected: (portName: string) => boolean,
    emit: GraphEmitter,
  ): ElementSlots {
    const nPort = portNodes.get(decl.port)
    if (nPort === undefined) return { nodeIndices: [], edgeIndices: [] }

    const isConnected = isPortConnected(decl.port)
    const enabled = resolveFluidBool(decl.enabled, params, true)
    const active = enabled && (!decl.whenUnconnected || !isConnected)

    const d = Math.max(0.005, resolveFluidNum(decl.diameter, params, 0.1))
    // Exit nozzle dynamic pressure head loss: ΔP = (8 * ρ / (π² * D⁴)) * Q²
    const RExit = (8 * WATER_DENSITY_KG_M3) / (Math.PI * Math.PI * Math.pow(d, 4))

    const fixedNode = emit.addNode('fixed', 0, 0)
    const edgeIdx = emit.addEdge(nPort, fixedNode, 1e-4, RExit, 0, active ? 1 : 0, false)
    return { nodeIndices: [fixedNode], edgeIndices: [edgeIdx] }
  },
}
