// Source element: pressure/supply boundary on a fluid port.

import type { ParamValue } from '../../parts/partApi'
import { resolveFluidBool, resolveFluidNum } from '../fluidBindings'
import type { SourceElementDecl } from '../fluidTypes'
import type { ElementSlots, FluidElementModule, GraphEmitter } from './registry'

export const sourceElementModule: FluidElementModule<SourceElementDecl> = {
  kind: 'source',
  compile(
    decl: SourceElementDecl,
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

    const pressure = resolveFluidNum(decl.pressure, params, 0) // Pa gauge
    const fixedNode = emit.addNode('fixed', 0, pressure, active)
    // Connect boundary node to port junction with low resistance
    const edgeIdx = emit.addEdge(fixedNode, nPort, 1e-4, 0, 0, active ? 1 : 0, false)
    return { nodeIndices: [fixedNode], edgeIndices: [edgeIdx] }
  },
}
