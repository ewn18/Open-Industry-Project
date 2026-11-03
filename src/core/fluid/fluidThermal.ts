// 1D pure upwind thermal transport and mixing for fluid networks.

import type { FluidGraph } from './fluidGraph'
import type { FluidState } from './fluidSolver'
import { WATER_DENSITY_KG_M3 } from './fluidUnits'

/** Specific heat capacity of liquid water at 20°C: ~4184 J / (kg·K). */
export const WATER_SPECIFIC_HEAT_J_KG_K = 4184

/** Volumetric heat capacity: ρ * Cp ≈ 4.176e6 J / (m³·K). */
const RHO_CP = WATER_DENSITY_KG_M3 * WATER_SPECIFIC_HEAT_J_KG_K

/** Default ambient temperature (°C). */
export const AMBIENT_TEMPERATURE_C = 20.0

export interface FluidThermalState {
  /** Temperature at each node (°C). */
  nodeTemperature: Float64Array
  /** Active heat power added along each edge (Watts, J/s). */
  edgePower: Float64Array
}

export function createInitialThermalState(graph: FluidGraph, ambientC = AMBIENT_TEMPERATURE_C): FluidThermalState {
  const nodeTemperature = new Float64Array(graph.numNodes).fill(ambientC)
  const edgePower = new Float64Array(graph.numEdges)
  return {
    nodeTemperature,
    edgePower,
  }
}

/**
 * Step fluid temperature using first-order upwind advection and energy conservation.
 * Pure function: operates directly on Float64Arrays with zero per-tick heap allocations.
 */
export function stepFluidThermal(
  graph: FluidGraph,
  flowState: FluidState,
  thermalState: FluidThermalState,
  dt: number,
  ambientC = AMBIENT_TEMPERATURE_C,
): void {
  const { numNodes, numEdges } = graph
  if (numNodes === 0 || numEdges === 0) return

  const q = flowState.flow
  const T = thermalState.nodeTemperature
  const power = thermalState.edgePower

  // For each node, compute net enthalpy influx: sum(Q_in * T_in) and sum(Q_in)
  // We use simple scratch accumulation in a static / reuse pattern
  for (const comp of graph.components) {
    for (const u of comp.nodeIndices) {
      if (graph.nodeKind[u] === 1) {
        // Fixed boundary nodes maintain their set temperature (e.g. ambient or source temp)
        continue
      }

      let heatRateIn = 0 // W = (m³/s) * (J/(m³·K)) * K
      let flowRateIn = 0 // m³/s

      const start = graph.nodeEdgeStart[u]!
      const end = graph.nodeEdgeStart[u + 1]!

      for (let idx = start; idx < end; idx++) {
        const rawE = graph.nodeEdges[idx]!
        const isLeaving = rawE >= 0
        const e = isLeaving ? rawE : ~rawE
        const qE = q[e]!

        // If flow is entering node `u` along edge `e`
        const isEntering = isLeaving ? qE < -1e-6 : qE > 1e-6
        if (!isEntering) continue

        const qAbs = Math.abs(qE)
        const v = isLeaving ? graph.edgeTo[e]! : graph.edgeFrom[e]!
        const tSource = T[v]!
        const pEdge = power[e]!

        // Temperature arriving from upstream node `v`, heated by pEdge
        // ΔT = P / (ρ * Cp * Q)
        const deltaT = pEdge !== 0 && qAbs > 1e-6 ? pEdge / (RHO_CP * qAbs) : 0
        const tIn = tSource + deltaT

        heatRateIn += qAbs * tIn
        flowRateIn += qAbs
      }

      const nodeVol = Math.max(0.002, graph.nodeVolume[u]!) // at least 2 litres inertia

      if (flowRateIn > 1e-6) {
        const tMixed = heatRateIn / flowRateIn
        // Exponential approach: 1 - exp(-flowRateIn * dt / nodeVol)
        const alpha = 1 - Math.exp((-flowRateIn * dt) / nodeVol)
        T[u] = T[u]! + alpha * (tMixed - T[u]!)
      } else {
        // Natural ambient thermal dissipation when stagnant (~300s time constant)
        T[u] = T[u]! + (ambientC - T[u]!) * (1 - Math.exp(-dt / 300))
      }
    }
  }
}
