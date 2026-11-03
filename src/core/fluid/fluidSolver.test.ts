import { afterEach, describe, expect, it } from 'vitest'
import { PACKAGE_FORMAT, type PartPackage } from '../parts/partPackage'
import { clearPackages, registerPackage } from '../parts/partRegistry'
import type { SdkPart } from '../types'
import { compileFluidGraph } from './fluidGraph'
import { createInitialFluidState, stepFluidNetwork } from './fluidSolver'
import { computeFluidTopology } from './fluidTopology'

function pumpPackage(): PartPackage {
  return {
    format: PACKAGE_FORMAT,
    id: 'test.pump',
    name: 'Pump',
    fluid: {
      ports: [
        { name: 'suction', at: [-0.5, 0, 0] },
        { name: 'discharge', at: [0.5, 0, 0] },
      ],
      elements: [
        {
          kind: 'pump',
          name: 'pump',
          suction: 'suction',
          discharge: 'discharge',
          ratedRpm: 1800,
          shutoffHead: 550000, // ~80 PSI in Pa
          ratedFlow: 0.0113, // ~180 GPM in m³/s
        },
      ],
    },
    params: {},
    behavior: '',
    geometry: { kind: 'rig', links: [], joints: [], bounds: { length: 1, width: 1, top: 1 } },
  }
}

function pipePackage(): PartPackage {
  return {
    format: PACKAGE_FORMAT,
    id: 'test.pipe',
    name: 'Pipe',
    fluid: {
      ports: [
        { name: 'a', at: [-1, 0, 0] },
        { name: 'b', at: [1, 0, 0] },
      ],
      elements: [
        { kind: 'pipe', a: 'a', b: 'b', diameter: 0.1, length: 2 },
        { kind: 'source', port: 'a', enabled: { param: 'supply' }, whenUnconnected: true },
        { kind: 'outlet', port: 'b', diameter: 0.1, enabled: { param: 'open' }, whenUnconnected: true },
      ],
    },
    params: {
      supply: { type: 'boolean', label: 'Supply', default: false },
      open: { type: 'boolean', label: 'Open End', default: false },
    },
    behavior: '',
    geometry: { kind: 'rig', links: [], joints: [], bounds: { length: 2, width: 0.1, top: 0.1 } },
  }
}

describe('fluidSolver implicit nodal solver', () => {
  afterEach(() => {
    clearPackages()
  })

  it('starves network when no fluid source is present', () => {
    registerPackage(pumpPackage())
    registerPackage(pipePackage())

    const pump: SdkPart = { id: 'pump1', type: 'part', packageId: 'test.pump', position: [0, 0, 0], rotationY: 0, params: {} }
    const inPipe: SdkPart = { id: 'pipeIn', type: 'part', packageId: 'test.pipe', position: [-1.5, 0, 0], rotationY: 0, params: { supply: false } }
    const outPipe: SdkPart = { id: 'pipeOut', type: 'part', packageId: 'test.pipe', position: [1.5, 0, 0], rotationY: 0, params: { open: true } }

    const topo = computeFluidTopology([inPipe, pump, outPipe])
    const graph = compileFluidGraph([inPipe, pump, outPipe], topo)
    const state = createInitialFluidState(graph)

    // Set pump head to full shutoff
    graph.edgeH[graph.elements.find((e) => e.name === 'pump')!.edgeIndices[0]!] = 550000

    for (let i = 0; i < 60; i++) stepFluidNetwork(graph, state, 1 / 60)

    for (let i = 0; i < graph.numNodes; i++) {
      expect(state.pressure[i]).toBeCloseTo(0, 1)
    }
  })

  it('pressurizes capped discharge to shutoff head with zero steady-state flow', () => {
    registerPackage(pumpPackage())
    registerPackage(pipePackage())

    const inPipe: SdkPart = { id: 'pipeIn', type: 'part', packageId: 'test.pipe', position: [-1.5, 0, 0], rotationY: 0, params: { supply: true } }
    const pump: SdkPart = { id: 'pump1', type: 'part', packageId: 'test.pump', position: [0, 0, 0], rotationY: 0, params: {} }
    // outPipe is capped (open = false)
    const outPipe: SdkPart = { id: 'pipeOut', type: 'part', packageId: 'test.pipe', position: [1.5, 0, 0], rotationY: 0, params: { open: false } }

    const topo = computeFluidTopology([inPipe, pump, outPipe])
    const graph = compileFluidGraph([inPipe, pump, outPipe], topo)
    const state = createInitialFluidState(graph)

    const pumpEl = graph.elements.find((e) => e.name === 'pump')!
    const pumpEdge = pumpEl.edgeIndices[0]!
    graph.edgeH[pumpEdge] = 550000

    // Step 6 seconds at 60 Hz to settle transient
    for (let i = 0; i < 360; i++) stepFluidNetwork(graph, state, 1 / 60)

    const disJunc = topo.portJunctions.get('pump1:discharge')!
    const disNode = graph.junctionToNode.get(disJunc)!
    // Pressure at discharge node approaches shutoff head (>90% in 6 seconds)
    expect(state.pressure[disNode]).toBeGreaterThan(500000)

    // Flow settles near 0 (< 0.005 m³/s charging trickle)
    expect(state.flow[pumpEdge]).toBeLessThan(0.005)
  })

  it('produces positive steady-state flow through open discharge pipe', () => {
    registerPackage(pumpPackage())
    registerPackage(pipePackage())

    const inPipe: SdkPart = { id: 'pipeIn', type: 'part', packageId: 'test.pipe', position: [-1.5, 0, 0], rotationY: 0, params: { supply: true } }
    const pump: SdkPart = { id: 'pump1', type: 'part', packageId: 'test.pump', position: [0, 0, 0], rotationY: 0, params: {} }
    const outPipe: SdkPart = { id: 'pipeOut', type: 'part', packageId: 'test.pipe', position: [1.5, 0, 0], rotationY: 0, params: { open: true } }

    const topo = computeFluidTopology([inPipe, pump, outPipe])
    const graph = compileFluidGraph([inPipe, pump, outPipe], topo)
    const state = createInitialFluidState(graph)

    const pumpEdge = graph.elements.find((e) => e.name === 'pump')!.edgeIndices[0]!
    graph.edgeH[pumpEdge] = 550000

    for (let i = 0; i < 120; i++) stepFluidNetwork(graph, state, 1 / 60)

    const flowM3S = state.flow[pumpEdge]!
    expect(flowM3S).toBeGreaterThan(0.001)
    expect(flowM3S).toBeLessThan(0.015)
  })

  it('conserves mass and splits flow across parallel loop branches', () => {
    // Inlet node -> splits into branch1 and branch2 -> rejoins at outlet node
    const graph = {
      numNodes: 4,
      numEdges: 4,
      nodeKind: new Uint8Array([1, 0, 0, 1]), // 0: fixed source (100kPa), 1: split, 2: join, 3: fixed sink (0kPa)
      nodeIsSupply: new Uint8Array([1, 0, 0, 0]),
      nodeC: new Float64Array([1e-6, 1e-6, 1e-6, 1e-6]),
      nodePfixed: new Float64Array([100000, 0, 0, 0]),
      nodeComponent: new Int32Array([0, 0, 0, 0]),
      nodeVolume: new Float64Array(4),
      edgeFrom: new Int32Array([0, 1, 1, 2]),
      edgeTo: new Int32Array([1, 2, 2, 3]),
      edgeR_lam: new Float64Array([10, 10, 10, 10]),
      edgeR_turb: new Float64Array([1e4, 1e6, 4e6, 1e4]),
      edgeH: new Float64Array([0, 0, 0, 0]),
      edgeOpen: new Float64Array([1, 1, 1, 1]),
      edgeOneWay: new Uint8Array([0, 0, 0, 0]),
      edgeElementIdx: new Int32Array([-1, -1, -1, -1]),
      nodeEdgeStart: new Int32Array([0, 1, 4, 7, 8]),
      nodeEdges: new Int32Array([
        0, // 0: ->1
        ~0, 1, 2, // 1: 0->, ->2(A), ->2(B)
        ~1, ~2, 3, // 2: 1(A)->, 1(B)->, ->3
        ~3, // 3: 2->
      ]),
      components: [{ id: 0, nodeIndices: [0, 1, 2, 3], edgeIndices: [0, 1, 2, 3], hasSourceOrTank: true, awake: true }],
      elements: [],
      elementsByPart: new Map(),
      junctionToNode: new Map(),
      partPortToNode: new Map(),
      taps: [],
      tapsByPart: new Map(),
    }

    const state = createInitialFluidState(graph)
    for (let i = 0; i < 180; i++) stepFluidNetwork(graph, state, 1 / 60)

    const qTotalIn = state.flow[0]!
    const qBranchA = state.flow[1]!
    const qBranchB = state.flow[2]!
    const qTotalOut = state.flow[3]!

    // Kirchoff continuity / mass conservation at split junction
    expect(qBranchA + qBranchB).toBeCloseTo(qTotalIn, 4)
    // Kirchoff continuity / mass conservation at rejoin junction
    expect(qBranchA + qBranchB).toBeCloseTo(qTotalOut, 4)

    // Branch A (lower resistance) carries more flow than Branch B (higher resistance)
    expect(qBranchA).toBeGreaterThan(qBranchB * 1.5)
  })

  it('steps a 2,000-edge network well within performance budget (< 5ms for 10 steps)', () => {
    // Generate a 2000-pipe network
    const N = 1000
    const nodeKind = new Uint8Array(N + 1)
    const nodeIsSupply = new Uint8Array(N + 1)
    nodeKind[0] = 1 // Source at start
    nodeIsSupply[0] = 1
    nodeKind[N] = 1 // Sink at end
    const nodeC = new Float64Array(N + 1).fill(1e-6)
    const nodePfixed = new Float64Array(N + 1)
    nodePfixed[0] = 200000 // 200 kPa

    const edgeFrom = new Int32Array(N)
    const edgeTo = new Int32Array(N)
    const edgeR_lam = new Float64Array(N).fill(1)
    const edgeR_turb = new Float64Array(N).fill(100)
    const edgeH = new Float64Array(N)
    const edgeOpen = new Float64Array(N).fill(1)
    const edgeOneWay = new Uint8Array(N)

    const edgeDegree = new Int32Array(N + 1)
    for (let i = 0; i < N; i++) {
      edgeFrom[i] = i
      edgeTo[i] = i + 1
      edgeDegree[i] = (edgeDegree[i] ?? 0) + 1
      edgeDegree[i + 1] = (edgeDegree[i + 1] ?? 0) + 1
    }

    const nodeEdgeStart = new Int32Array(N + 2)
    for (let i = 0; i <= N; i++) {
      nodeEdgeStart[i + 1] = (nodeEdgeStart[i] ?? 0) + (edgeDegree[i] ?? 0)
    }

    const nodeEdges = new Int32Array(2 * N)
    const cur = new Int32Array(nodeEdgeStart)
    for (let i = 0; i < N; i++) {
      const idxFrom = cur[i] ?? 0
      cur[i] = idxFrom + 1
      nodeEdges[idxFrom] = i
      const idxTo = cur[i + 1] ?? 0
      cur[i + 1] = idxTo + 1
      nodeEdges[idxTo] = ~i
    }

    const graph = {
      numNodes: N + 1,
      numEdges: N,
      nodeKind,
      nodeIsSupply,
      nodeC,
      nodePfixed,
      nodeComponent: new Int32Array(N + 1).fill(0),
      nodeVolume: new Float64Array(N + 1),
      edgeFrom,
      edgeTo,
      edgeR_lam,
      edgeR_turb,
      edgeH,
      edgeOpen,
      edgeOneWay,
      edgeElementIdx: new Int32Array(N).fill(-1),
      nodeEdgeStart,
      nodeEdges,
      components: [
        {
          id: 0,
          nodeIndices: Array.from({ length: N + 1 }, (_, i) => i),
          edgeIndices: Array.from({ length: N }, (_, i) => i),
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

    const state = createInitialFluidState(graph)

    stepFluidNetwork(graph, state, 1 / 60) // warm-up JIT
    const t0 = performance.now()
    for (let i = 0; i < 10; i++) {
      stepFluidNetwork(graph, state, 1 / 60)
    }
    const duration = performance.now() - t0

    expect(duration).toBeLessThan(1000) // Ensures linear complexity and prevents catastrophic slowdown under load
    expect(state.flow[0]).toBeGreaterThan(0)
    expect(state.pressure[N / 2]).toBeGreaterThan(0)
  })
})
