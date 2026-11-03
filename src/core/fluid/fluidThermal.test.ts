// Unit tests for 1D thermal transport, heater energy injection, and stream mixing.

import { describe, expect, it } from 'vitest'
import type { FluidGraph } from './fluidGraph'
import type { FluidState } from './fluidSolver'
import {
  createInitialThermalState,
  stepFluidThermal,
  WATER_SPECIFIC_HEAT_J_KG_K,
} from './fluidThermal'
import { WATER_DENSITY_KG_M3 } from './fluidUnits'

describe('fluidThermal: Advection, Heating & Mixing', () => {
  it('raises downstream temperature according to first law of thermodynamics (P = rho * Cp * Q * deltaT)', () => {
    // 3-node linear line: Node 0 (fixed source at 20°C) -> Node 1 (before heater) -> Node 2 (after heater)
    // Edge 0: 0 -> 1 (pipe)
    // Edge 1: 1 -> 2 (heater)
    const graph: FluidGraph = {
      numNodes: 3,
      numEdges: 2,
      nodeKind: new Uint8Array([1, 0, 0]),
      nodeIsSupply: new Uint8Array([1, 0, 0]),
      nodeC: new Float64Array(3).fill(1e-8),
      nodePfixed: new Float64Array([100000, 0, 0]),
      nodeComponent: new Int32Array([0, 0, 0]),
      nodeVolume: new Float64Array([0.005, 0.005, 0.005]),
      edgeFrom: new Int32Array([0, 1]),
      edgeTo: new Int32Array([1, 2]),
      edgeR_lam: new Float64Array(2).fill(0.01),
      edgeR_turb: new Float64Array(2).fill(100),
      edgeH: new Float64Array(2),
      edgeOpen: new Float64Array(2).fill(1),
      edgeOneWay: new Uint8Array(2),
      edgeElementIdx: new Int32Array([-1, -1]),
      nodeEdgeStart: new Int32Array([0, 1, 3, 4]),
      nodeEdges: new Int32Array([0, ~0, 1, ~1]),
      components: [
        {
          id: 0,
          nodeIndices: [0, 1, 2],
          edgeIndices: [0, 1],
          hasSourceOrTank: true,
          awake: true,
        },
      ],
      elements: [],
      elementsByPart: new Map(),
      junctionToNode: new Map(),
      partPortToNode: new Map(),
      taps: [],
      tapsByPart: new Map(),
    }

    const flowState: FluidState = {
      pressure: new Float64Array([100000, 50000, 0]),
      flow: new Float64Array([0.001, 0.001]), // Q = 0.001 m³/s (1 L/s)
    }

    const thermal = createInitialThermalState(graph, 20.0)

    // Heater injects P = 41764.7 Watts into Edge 1
    // Delta T = P / (rho * Cp * Q) = 41764.7 / (998.2 * 4184 * 0.001) = 10.0 °C
    const RHO_CP = WATER_DENSITY_KG_M3 * WATER_SPECIFIC_HEAT_J_KG_K
    const expectedDeltaT = 10.0
    thermal.edgePower[1] = RHO_CP * 0.001 * expectedDeltaT

    // Step thermal simulation for 40 seconds to reach steady-state thermal profile
    for (let i = 0; i < 2400; i++) {
      stepFluidThermal(graph, flowState, thermal, 1 / 60)
    }

    expect(thermal.nodeTemperature[0]).toBe(20.0) // Fixed source
    expect(thermal.nodeTemperature[1]).toBeCloseTo(20.0, 1) // Unheated upstream node
    expect(thermal.nodeTemperature[2]).toBeCloseTo(20.0 + expectedDeltaT, 1) // Heated downstream node (30°C)
  })

  it('conserves energy when mixing two streams at different temperatures at a junction', () => {
    // T-junction:
    // Node 0: Source A at 20°C, flow = 0.002 m³/s
    // Node 1: Source B at 60°C, flow = 0.001 m³/s
    // Node 2: Mixed node (0 -> 2 and 1 -> 2)
    const graph: FluidGraph = {
      numNodes: 3,
      numEdges: 2,
      nodeKind: new Uint8Array([1, 1, 0]),
      nodeIsSupply: new Uint8Array([1, 1, 0]),
      nodeC: new Float64Array(3).fill(1e-8),
      nodePfixed: new Float64Array([100000, 100000, 0]),
      nodeComponent: new Int32Array([0, 0, 0]),
      nodeVolume: new Float64Array([0.005, 0.005, 0.005]),
      edgeFrom: new Int32Array([0, 1]),
      edgeTo: new Int32Array([2, 2]),
      edgeR_lam: new Float64Array(2).fill(0.01),
      edgeR_turb: new Float64Array(2).fill(100),
      edgeH: new Float64Array(2),
      edgeOpen: new Float64Array(2).fill(1),
      edgeOneWay: new Uint8Array(2),
      edgeElementIdx: new Int32Array([-1, -1]),
      nodeEdgeStart: new Int32Array([0, 1, 2, 4]),
      nodeEdges: new Int32Array([0, 1, ~0, ~1]),
      components: [
        {
          id: 0,
          nodeIndices: [0, 1, 2],
          edgeIndices: [0, 1],
          hasSourceOrTank: true,
          awake: true,
        },
      ],
      elements: [],
      elementsByPart: new Map(),
      junctionToNode: new Map(),
      partPortToNode: new Map(),
      taps: [],
      tapsByPart: new Map(),
    }

    const flowState: FluidState = {
      pressure: new Float64Array([100000, 100000, 0]),
      flow: new Float64Array([0.002, 0.001]),
    }

    const thermal = createInitialThermalState(graph, 20.0)
    thermal.nodeTemperature[0] = 20.0 // 2 L/s at 20°C
    thermal.nodeTemperature[1] = 60.0 // 1 L/s at 60°C

    // Expected mixed temperature:
    // T_mixed = (2 * 20 + 1 * 60) / (2 + 1) = (40 + 60) / 3 = 100 / 3 ≈ 33.33 °C
    for (let i = 0; i < 600; i++) {
      stepFluidThermal(graph, flowState, thermal, 1 / 60)
    }

    expect(thermal.nodeTemperature[2]).toBeCloseTo(33.33, 1)
  })
})
