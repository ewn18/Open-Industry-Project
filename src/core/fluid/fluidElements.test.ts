// Unit tests for expanded fluid elements: valves, check valves, tanks, and sensor taps.

import { afterEach, describe, expect, it } from 'vitest'
import { PACKAGE_FORMAT, type PartPackage } from '../parts/partPackage'
import { clearPackages, registerPackage } from '../parts/partRegistry'
import type { SdkPart } from '../types'
import { valveOpeningFactor } from './elements/valve'
import { compileFluidGraph } from './fluidGraph'
import { createInitialFluidState, stepFluidNetwork } from './fluidSolver'
import { computeFluidTopology } from './fluidTopology'

function makePart(
  id: string,
  packageId: string,
  position: [number, number, number],
  params: Record<string, string | number | boolean>,
  rotationY = 0,
): SdkPart {
  return { id, type: 'part', packageId, position, rotationY, params }
}

function testPackage(pkg: Partial<PartPackage> & { id: string; name: string }): PartPackage {
  return {
    format: PACKAGE_FORMAT,
    params: {},
    behavior: '',
    geometry: { kind: 'rig', links: [], joints: [], bounds: { length: 1, width: 1, top: 1 } },
    ...pkg,
  }
}

describe('fluidElements: Valve, Check Valve, Tank & Taps', () => {
  afterEach(() => {
    clearPackages()
  })

  it('valveOpeningFactor calculates correct curves for linear, equalPercent, and quickOpen', () => {
    // Linear
    expect(valveOpeningFactor(0, 'linear')).toBe(0)
    expect(valveOpeningFactor(0.5, 'linear')).toBe(0.5)
    expect(valveOpeningFactor(1.0, 'linear')).toBe(1)
    expect(valveOpeningFactor(true, 'linear')).toBe(1)
    expect(valveOpeningFactor(false, 'linear')).toBe(0)

    // Quick open (sqrt)
    expect(valveOpeningFactor(0.25, 'quickOpen')).toBeCloseTo(0.5, 3)

    // Equal percentage (50^(x - 1))
    expect(valveOpeningFactor(1.0, 'equalPercent')).toBe(1)
    expect(valveOpeningFactor(0.5, 'equalPercent')).toBeCloseTo(Math.pow(50, -0.5), 3)
  })

  it('compiles declarative valve, check valve, and tank elements with correct ports and edges', () => {
    const valvePkg = testPackage({
      id: 'test.valve',
      name: 'Control Valve',
      fluid: {
        ports: [
          { name: 'inlet', at: [-0.2, 0, 0] },
          { name: 'outlet', at: [0.2, 0, 0] },
        ],
        elements: [
          {
            kind: 'valve',
            name: 'ctrl',
            a: 'inlet',
            b: 'outlet',
            diameter: 0.05,
            characteristic: 'equalPercent',
            normallyOpen: true,
          },
        ],
      },
    })

    const checkValvePkg = testPackage({
      id: 'test.check_valve',
      name: 'Swing Check Valve',
      fluid: {
        ports: [
          { name: 'inlet', at: [-0.2, 0, 0] },
          { name: 'outlet', at: [0.2, 0, 0] },
        ],
        elements: [
          {
            kind: 'checkValve',
            name: 'chk',
            inlet: 'inlet',
            outlet: 'outlet',
            diameter: 0.05,
            crackingPressure: 5000, // 5 kPa cracking pressure
          },
        ],
      },
    })

    const tankPkg = testPackage({
      id: 'test.tank',
      name: 'Storage Tank',
      fluid: {
        ports: [
          { name: 'drain', at: [0.5, 0.1, 0] },
          { name: 'inflow', at: [0, 1.9, 0] },
        ],
        elements: [
          {
            kind: 'tank',
            name: 'storage',
            ports: [
              { port: 'drain', height: 0.1 },
              { port: 'inflow', height: 1.9 },
            ],
            area: 2.0,
            height: 2.0,
            initialLevel: 1.5,
          },
        ],
      },
    })

    const sensorPkg = testPackage({
      id: 'test.pressure_transmitter',
      name: 'Pressure Transmitter',
      fluid: {
        taps: [
          { name: 'pt1', at: [0, 0, 0], reach: 0.1 },
        ],
      },
    })

    registerPackage(valvePkg)
    registerPackage(checkValvePkg)
    registerPackage(tankPkg)
    registerPackage(sensorPkg)

    const valve = makePart('v1', 'test.valve', [0, 0, 0], {})
    const chk = makePart('cv1', 'test.check_valve', [2, 0, 0], {})
    const tank = makePart('t1', 'test.tank', [5, 0, 0], {})
    const sensor = makePart('pt1', 'test.pressure_transmitter', [0.2, 0, 0], {}) // At valve outlet

    const topo = computeFluidTopology([valve, chk, tank, sensor])
    const graph = compileFluidGraph([valve, chk, tank, sensor], topo)

    expect(graph.elements.length).toBe(3) // valve, checkValve, tank
    const compiledValve = graph.elements.find((e) => e.kind === 'valve')!
    expect(compiledValve).toBeDefined()
    expect(compiledValve.characteristic).toBe('equalPercent')

    const compiledCheck = graph.elements.find((e) => e.kind === 'checkValve')!
    expect(compiledCheck).toBeDefined()
    const checkEdge = compiledCheck.edgeIndices[0]!
    expect(graph.edgeOneWay[checkEdge]).toBe(1)
    expect(graph.edgeH[checkEdge]).toBe(-5000) // negative bias for cracking pressure

    const compiledTank = graph.elements.find((e) => e.kind === 'tank')!
    expect(compiledTank).toBeDefined()
    expect(compiledTank.area).toBe(2.0)
    expect(compiledTank.level).toBe(1.5)

    // Sensor tap resolved to valve outlet junction
    expect(graph.taps.length).toBe(1)
    expect(graph.taps[0]!.name).toBe('pt1')
    expect(graph.taps[0]!.partId).toBe('pt1')
  })

  it('throttles flow proportionally through a valve element in nodal solver', () => {
    const valvePkg = testPackage({
      id: 'test.valve_throttling',
      name: 'Throttling Valve',
      fluid: {
        ports: [
          { name: 'inlet', at: [-0.5, 0, 0] },
          { name: 'outlet', at: [0.5, 0, 0] },
        ],
        elements: [
          {
            kind: 'valve',
            name: 'v',
            a: 'inlet',
            b: 'outlet',
            diameter: 0.05,
            characteristic: 'linear',
          },
        ],
      },
    })

    const sourcePkg = testPackage({
      id: 'test.source_p',
      name: 'Pressure Source',
      fluid: {
        ports: [{ name: 'port', at: [0, 0, 0] }],
        elements: [
          {
            kind: 'source',
            name: 'src',
            port: 'port',
            pressure: 100000, // 100 kPa
          },
        ],
      },
    })

    const outletPkg = testPackage({
      id: 'test.outlet_p',
      name: 'Pressure Outlet',
      fluid: {
        ports: [{ name: 'port', at: [0, 0, 0] }],
        elements: [
          {
            kind: 'outlet',
            name: 'out',
            port: 'port',
            diameter: 0.05,
          },
        ],
      },
    })

    registerPackage(valvePkg)
    registerPackage(sourcePkg)
    registerPackage(outletPkg)

    // Source meets valve inlet at (-0.5, 0, 0); outlet meets valve outlet at (0.5, 0, 0)
    const src = makePart('src1', 'test.source_p', [-0.5, 0, 0], {})
    const valve = makePart('v1', 'test.valve_throttling', [0, 0, 0], {})
    const out = makePart('out1', 'test.outlet_p', [0.5, 0, 0], {})

    const topo = computeFluidTopology([src, valve, out])
    const graph = compileFluidGraph([src, valve, out], topo)
    const state = createInitialFluidState(graph)

    const valveEl = graph.elements.find((e) => e.kind === 'valve')!
    const vEdge = valveEl.edgeIndices[0]!

    // 1. Full open (edgeOpen = 1.0)
    graph.edgeOpen[vEdge] = 1.0
    for (let i = 0; i < 30; i++) stepFluidNetwork(graph, state, 1 / 60)
    const fullFlow = state.flow[vEdge]!
    expect(fullFlow).toBeGreaterThan(0.005)

    // 2. Throttled to half (edgeOpen = 0.5)
    graph.edgeOpen[vEdge] = 0.5
    for (let i = 0; i < 30; i++) stepFluidNetwork(graph, state, 1 / 60)
    const halfFlow = state.flow[vEdge]!
    expect(halfFlow).toBeLessThan(fullFlow)
    expect(halfFlow).toBeGreaterThan(0)

    // 3. Fully closed (edgeOpen = 0)
    graph.edgeOpen[vEdge] = 0
    for (let i = 0; i < 30; i++) stepFluidNetwork(graph, state, 1 / 60)
    expect(state.flow[vEdge]!).toBeCloseTo(0, 5)
  })

  it('blocks reverse flow and enforces cracking pressure with checkValve element', () => {
    const checkPkg = testPackage({
      id: 'test.check_flow',
      name: 'Flow Check Valve',
      fluid: {
        ports: [
          { name: 'inlet', at: [-0.5, 0, 0] },
          { name: 'outlet', at: [0.5, 0, 0] },
        ],
        elements: [
          {
            kind: 'checkValve',
            name: 'chk',
            inlet: 'inlet',
            outlet: 'outlet',
            diameter: 0.05,
            crackingPressure: 5000, // 5 kPa cracking threshold
          },
        ],
      },
    })

    const sourcePkg = testPackage({
      id: 'test.source_var',
      name: 'Variable Source',
      fluid: {
        ports: [{ name: 'port', at: [0, 0, 0] }],
        elements: [
          {
            kind: 'source',
            name: 'src',
            port: 'port',
            pressure: 50000,
          },
        ],
      },
    })

    const outletPkg = testPackage({
      id: 'test.outlet_drain',
      name: 'Drain Outlet',
      fluid: {
        ports: [{ name: 'port', at: [0, 0, 0] }],
        elements: [
          {
            kind: 'outlet',
            name: 'out',
            port: 'port',
            diameter: 0.05,
          },
        ],
      },
    })

    registerPackage(checkPkg)
    registerPackage(sourcePkg)
    registerPackage(outletPkg)

    // A. Forward pressure exceeding cracking pressure (50 kPa > 5 kPa) -> forward flow
    const src = makePart('src1', 'test.source_var', [-0.5, 0, 0], {})
    const chk = makePart('cv1', 'test.check_flow', [0, 0, 0], {})
    const out = makePart('out1', 'test.outlet_drain', [0.5, 0, 0], {})

    const topoFwd = computeFluidTopology([src, chk, out])
    const graphFwd = compileFluidGraph([src, chk, out], topoFwd)
    const stateFwd = createInitialFluidState(graphFwd)

    const chkEl = graphFwd.elements.find((e) => e.kind === 'checkValve')!
    const cEdge = chkEl.edgeIndices[0]!

    for (let i = 0; i < 30; i++) stepFluidNetwork(graphFwd, stateFwd, 1 / 60)
    expect(stateFwd.flow[cEdge]!).toBeGreaterThan(0)

    // B. Reverse pressure: higher pressure at outlet than inlet -> completely blocked (0 flow)
    const srcRev = makePart('srcRev', 'test.source_var', [0.5, 0, 0], {}) // At outlet!
    const outRev = makePart('outRev', 'test.outlet_drain', [-0.5, 0, 0], {}) // At inlet!
    const topoRev = computeFluidTopology([srcRev, chk, outRev])
    const graphRev = compileFluidGraph([srcRev, chk, outRev], topoRev)
    const stateRev = createInitialFluidState(graphRev)

    const chkElRev = graphRev.elements.find((e) => e.kind === 'checkValve')!
    const cEdgeRev = chkElRev.edgeIndices[0]!

    for (let i = 0; i < 30; i++) stepFluidNetwork(graphRev, stateRev, 1 / 60)
    expect(stateRev.flow[cEdgeRev]!).toBe(0)
  })
})
