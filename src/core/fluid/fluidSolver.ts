// Implicit nodal pressure and flow solver (Gauss-Seidel) for 1D hydraulic networks.

import { NODE_KIND_FIXED, type FluidComponent, type FluidGraph } from './fluidGraph'
import { ATMOSPHERIC_PRESSURE_PA } from './fluidUnits'

const MAX_GAUSS_SEIDEL_SWEEPS = 96
const SOR_OMEGA = 1.6
const PRESSURE_CONVERGENCE_TOL_PA = 1e-4
const REGULARIZATION_EPSILON = 1e-6
const VACUUM_FLOOR_PA = -ATMOSPHERIC_PRESSURE_PA

export interface FluidState {
  pressure: Float64Array
  flow: Float64Array
  pOld?: Float64Array
  g?: Float64Array
}

export function createInitialFluidState(graph: FluidGraph): FluidState {
  const pressure = new Float64Array(graph.numNodes)
  for (let i = 0; i < graph.numNodes; i++) {
    if (graph.nodeKind[i] === NODE_KIND_FIXED) {
      pressure[i] = graph.nodePfixed[i]!
    }
  }
  return {
    pressure,
    flow: new Float64Array(graph.numEdges),
    pOld: new Float64Array(graph.numNodes),
    g: new Float64Array(graph.numEdges),
  }
}

function isComponentSupplied(comp: FluidComponent, graph: FluidGraph): boolean {
  if (!comp.hasSourceOrTank) return false
  if (!graph.nodeIsSupply) return true
  for (const u of comp.nodeIndices) {
    if (graph.nodeIsSupply[u] === 1) {
      const start = graph.nodeEdgeStart[u]!
      const end = graph.nodeEdgeStart[u + 1]!
      for (let idx = start; idx < end; idx++) {
        const rawE = graph.nodeEdges[idx]!
        const e = rawE >= 0 ? rawE : ~rawE
        if (graph.edgeOpen[e]! > 0) return true
      }
    }
  }
  return false
}

/** Step the fluid network by `dt` seconds using implicit nodal integration. */
export function stepFluidNetwork(graph: FluidGraph, state: FluidState, dt: number): void {
  const { numNodes, numEdges } = graph
  if (numNodes === 0 || numEdges === 0) return

  const p = state.pressure
  const q = state.flow
  const pOld = state.pOld ?? new Float64Array(numNodes)
  pOld.set(p)
  const g = state.g ?? new Float64Array(numEdges)

  // Conductance g_k for each edge
  for (let e = 0; e < numEdges; e++) {
    const open = graph.edgeOpen[e]!
    if (open <= 1e-4) {
      g[e] = 0
      continue
    }
    const r = graph.edgeR_lam[e]!
    const R = graph.edgeR_turb[e]!
    const qAbs = Math.abs(q[e]!)
    const oneWay = graph.edgeOneWay[e] === 1

    // If one-way and previously reversed, shut off
    if (oneWay && q[e]! < -1e-6) {
      g[e] = 0
    } else {
      g[e] = open / (r + R * qAbs + REGULARIZATION_EPSILON)
    }
  }

  // Solve each connected component
  for (const comp of graph.components) {
    solveComponent(comp, graph, p, pOld, g, dt)
  }

  // Update edge flows from solved pressures with Picard under-relaxation
  for (const comp of graph.components) {
    if (!isComponentSupplied(comp, graph)) {
      for (const e of comp.edgeIndices) {
        q[e] = 0
      }
      continue
    }
    for (const e of comp.edgeIndices) {
      const open = graph.edgeOpen[e]!
      if (open <= 1e-4 || g[e] === 0) {
        q[e] = 0
        continue
      }
      const u = graph.edgeFrom[e]!
      const v = graph.edgeTo[e]!
      const H = graph.edgeH[e]!
      let qTarget = g[e]! * (p[u]! - p[v]! + H)
      if (graph.edgeOneWay[e] === 1 && qTarget < 0) {
        qTarget = 0
      }
      // Damped relaxation: prevents limit cycles on quadratic non-linear friction
      const nextQ = 0.5 * q[e]! + 0.5 * qTarget
      q[e] = Math.abs(nextQ) < 1e-9 ? 0 : nextQ
    }
  }
}

function solveComponent(
  comp: FluidComponent,
  graph: FluidGraph,
  p: Float64Array,
  pOld: Float64Array,
  g: Float64Array,
  dt: number,
): void {
  const { nodeIndices } = comp

  // If component has no active supply/source, depressurize towards 0
  if (!isComponentSupplied(comp, graph)) {
    for (const u of nodeIndices) {
      if (graph.nodeKind[u] !== NODE_KIND_FIXED) {
        p[u] = 0
      }
    }
    return
  }

  // Check if any pump or source is actively driving head
  let hasActiveDrive = false
  for (const e of comp.edgeIndices) {
    if (graph.edgeH[e]! > 10 && graph.edgeOpen[e]! > 0) {
      hasActiveDrive = true
      break
    }
  }
  if (!hasActiveDrive) {
    for (const u of nodeIndices) {
      if (graph.nodeKind[u] === NODE_KIND_FIXED && graph.nodePfixed[u]! > 10) {
        hasActiveDrive = true
        break
      }
    }
  }

  // Bleed pressure down to 0 if all pumps/sources in the component are stopped
  if (!hasActiveDrive) {
    for (const u of nodeIndices) {
      if (graph.nodeKind[u] !== NODE_KIND_FIXED) {
        p[u] = p[u]! * Math.exp(-dt / 0.15)
        if (p[u]! < 1.0) p[u] = 0
      }
    }
    return
  }

  // Ensure fixed nodes keep their fixed pressure
  for (const u of nodeIndices) {
    if (graph.nodeKind[u] === NODE_KIND_FIXED) {
      p[u] = graph.nodePfixed[u]!
    }
  }

  const dtInv = 1 / Math.max(1e-4, dt)

  // Gauss-Seidel relaxation
  for (let sweep = 0; sweep < MAX_GAUSS_SEIDEL_SWEEPS; sweep++) {
    let maxChange = 0

    for (const u of nodeIndices) {
      if (graph.nodeKind[u] === NODE_KIND_FIXED) continue

      const C = graph.nodeC[u]!
      const capTerm = C * dtInv
      let diag = capTerm
      let rhs = capTerm * pOld[u]!

      const start = graph.nodeEdgeStart[u]!
      const end = graph.nodeEdgeStart[u + 1]!

      for (let idx = start; idx < end; idx++) {
        const rawE = graph.nodeEdges[idx]!
        const isLeaving = rawE >= 0
        const e = isLeaving ? rawE : ~rawE
        const gE = g[e]!
        if (gE <= 0) continue

        const v = isLeaving ? graph.edgeTo[e]! : graph.edgeFrom[e]!
        const H = graph.edgeH[e]!
        const pV = p[v]!

        diag += gE
        if (isLeaving) {
          rhs += gE * (pV - H)
        } else {
          rhs += gE * (pV + H)
        }
      }

      if (diag > 1e-9) {
        const target = rhs / diag
        const pNew = Math.max(VACUUM_FLOOR_PA, p[u]! + SOR_OMEGA * (target - p[u]!))
        const dP = Math.abs(pNew - p[u]!)
        if (dP > maxChange) maxChange = dP
        p[u] = pNew
      }
    }

    if (maxChange < PRESSURE_CONVERGENCE_TOL_PA) break
  }
}
