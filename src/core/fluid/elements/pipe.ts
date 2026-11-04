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
    isPortConnected: (portName: string) => boolean,
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

    const nodeSlots: number[] = []
    const edgeSlots: number[] = [edgeIdx]

    const fluidSupply = params.fluidSupply === true
    const openEnd = params.openEnd === true
    const pipeIdIn = d * 39.3700787
    const RExit = (0.35 * 1.7323e12) / Math.pow(Math.max(0.25, pipeIdIn), 4)

    // Boundaries for unconnected ports
    const addBoundaries = (portName: string, pNode: number) => {
      if (!isPortConnected(portName)) {
        // Supply reservoir boundary (acts as infinite source when fluidSupply is true)
        const srcNode = emit.addNode('fixed', 0, 0, true)
        const srcEdge = emit.addEdge(srcNode, pNode, 1e-4, 0, 0, fluidSupply ? 1 : 0, false)
        nodeSlots.push(srcNode)
        edgeSlots.push(srcEdge)

        // Atmospheric discharge boundary (free-flows when openEnd is true)
        const outNode = emit.addNode('fixed', 0, 0, false)
        const outEdge = emit.addEdge(pNode, outNode, 1e-4, RExit, 0, openEnd ? 1 : 0, false)
        nodeSlots.push(outNode)
        edgeSlots.push(outEdge)
      }
    }

    addBoundaries(decl.a, na)
    addBoundaries(decl.b, nb)

    return { nodeIndices: nodeSlots, edgeIndices: edgeSlots }
  },
}
