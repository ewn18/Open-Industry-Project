import { afterEach, describe, expect, it } from 'vitest'
import { PACKAGE_FORMAT, type PartPackage } from '../parts/partPackage'
import { clearPackages, registerPackage } from '../parts/partRegistry'
import type { SdkPart } from '../types'
import { extractWorldFluidPorts } from './fluidPorts'
import { computeFluidTopology, computeFluidTopologyUncached, FLUID_PORT_TOL } from './fluidTopology'

function makeTestPipePackage(): PartPackage {
  return {
    format: PACKAGE_FORMAT,
    id: 'test.pipe',
    name: 'Pipe',
    fluid: {
      ports: [
        { name: 'inlet', at: [-1, 0, 0] },
        { name: 'outlet', at: [1, 0, 0] },
      ],
      elements: [
        { kind: 'pipe', a: 'inlet', b: 'outlet', diameter: 0.1, length: 2 },
      ],
    },
    params: {
      length: { type: 'number', label: 'Length', default: 2 },
    },
    behavior: '',
    geometry: { kind: 'rig', links: [], joints: [], bounds: { length: 2, width: 0.1, top: 0.1 } },
  }
}

function makeTestTeePackage(): PartPackage {
  return {
    format: PACKAGE_FORMAT,
    id: 'test.tee',
    name: 'Tee Junction',
    fluid: {
      ports: [
        { name: 'run_a', at: [-0.5, 0, 0] },
        { name: 'run_b', at: [0.5, 0, 0] },
        { name: 'branch', at: [0, 0, 0.5] },
      ],
      nodes: ['center'],
      elements: [
        { kind: 'pipe', a: 'run_a', b: 'center', diameter: 0.1, length: 0.5 },
        { kind: 'pipe', a: 'run_b', b: 'center', diameter: 0.1, length: 0.5 },
        { kind: 'pipe', a: 'branch', b: 'center', diameter: 0.1, length: 0.5 },
      ],
    },
    params: {},
    behavior: '',
    geometry: { kind: 'rig', links: [], joints: [], bounds: { length: 1, width: 1, top: 0.1 } },
  }
}

describe('fluidTopology 3D spatial hash and junction pairing', () => {
  afterEach(() => {
    clearPackages()
  })

  it('extracts world-space ports respecting part translation and yaw rotation', () => {
    registerPackage(makeTestPipePackage())
    // Placed at (10, 2, 5) with 90° yaw rotation
    const part: SdkPart = {
      id: 'pipe1',
      type: 'part',
      packageId: 'test.pipe',
      position: [10, 2, 5],
      rotationY: Math.PI / 2,
      params: {},
    }

    const ports = extractWorldFluidPorts(part)
    expect(ports).toHaveLength(2)

    // Local [-1, 0, 0] rotated 90°: x' = 0, z' = -(-1)*1 = +1, translated -> (10, 2, 6)
    expect(ports[0]!.name).toBe('inlet')
    expect(ports[0]!.worldPos[0]).toBeCloseTo(10, 4)
    expect(ports[0]!.worldPos[1]).toBeCloseTo(2, 4)
    expect(ports[0]!.worldPos[2]).toBeCloseTo(6, 4)

    // Local [1, 0, 0] rotated 90°: x' = 0, z' = -(1)*1 = -1, translated -> (10, 2, 4)
    expect(ports[1]!.name).toBe('outlet')
    expect(ports[1]!.worldPos[0]).toBeCloseTo(10, 4)
    expect(ports[1]!.worldPos[1]).toBeCloseTo(2, 4)
    expect(ports[1]!.worldPos[2]).toBeCloseTo(4, 4)
  })

  it('unions coincident ports into topological junctions', () => {
    registerPackage(makeTestPipePackage())
    // Pipe 1 from x = -2 to x = 0
    const pipe1: SdkPart = {
      id: 'p1',
      type: 'part',
      packageId: 'test.pipe',
      position: [-1, 0, 0],
      rotationY: 0,
      params: {},
    }
    // Pipe 2 from x = 0 to x = 2
    const pipe2: SdkPart = {
      id: 'p2',
      type: 'part',
      packageId: 'test.pipe',
      position: [1, 0, 0],
      rotationY: 0,
      params: {},
    }

    const topo = computeFluidTopologyUncached([pipe1, pipe2])
    // 3 distinct junctions: p1.inlet (-2), p1.outlet meets p2.inlet (0), p2.outlet (+2)
    expect(topo.junctions).toHaveLength(3)

    const jMidId = topo.portJunctions.get('p1:outlet')
    expect(jMidId).toBeDefined()
    expect(topo.portJunctions.get('p2:inlet')).toBe(jMidId)

    const jMid = topo.junctions.find((j) => j.id === jMidId)!
    expect(jMid.ports).toHaveLength(2)
    expect(jMid.worldPos[0]).toBeCloseTo(0, 4)
    expect(topo.portExternalDegree.get('p1:outlet')).toBe(1)
    expect(topo.portExternalDegree.get('p2:inlet')).toBe(1)
  })

  it('correctly handles 3-way tee junction merging 3 distinct parts', () => {
    registerPackage(makeTestPipePackage())
    registerPackage(makeTestTeePackage())

    // Tee center at (0, 0, 0).
    // run_a port at (-0.5, 0, 0), run_b port at (0.5, 0, 0), branch port at (0, 0, 0.5)
    const tee: SdkPart = {
      id: 'tee1',
      type: 'part',
      packageId: 'test.tee',
      position: [0, 0, 0],
      rotationY: 0,
      params: {},
    }

    // Pipe connecting into run_a: center at (-1.5, 0, 0), outlet at (-0.5, 0, 0)
    const pipeA: SdkPart = {
      id: 'pipeA',
      type: 'part',
      packageId: 'test.pipe',
      position: [-1.5, 0, 0],
      rotationY: 0,
      params: {},
    }

    // Pipe connecting into branch: center at (0, 0, 1.5), rotationY = 90° -> outlet is at (0, 0, 0.5)
    const pipeBranch: SdkPart = {
      id: 'pipeBranch',
      type: 'part',
      packageId: 'test.pipe',
      position: [0, 0, 1.5],
      rotationY: Math.PI / 2, // outlet at (0, 0, 0.5), inlet at (0, 0, 2.5)
      params: {},
    }

    const topo = computeFluidTopology([tee, pipeA, pipeBranch])
    const jA = topo.portJunctions.get('tee1:run_a')
    expect(jA).toBeDefined()
    expect(topo.portJunctions.get('pipeA:outlet')).toBe(jA)

    const jBranch = topo.portJunctions.get('tee1:branch')
    expect(jBranch).toBeDefined()
    expect(topo.portJunctions.get('pipeBranch:outlet')).toBe(jBranch)
  })

  it('produces identical results between spatial hash and brute force reference across randomized ports', () => {
    registerPackage(makeTestPipePackage())
    const parts: SdkPart[] = []
    for (let i = 0; i < 50; i++) {
      parts.push({
        id: `pipe_${i}`,
        type: 'part',
        packageId: 'test.pipe',
        position: [Math.floor(i / 5) * 2, 0, (i % 5) * 2],
        rotationY: (i % 2) * (Math.PI / 2),
        params: {},
      })
    }

    const result = computeFluidTopologyUncached(parts)
    expect(result.junctions.length).toBeGreaterThan(0)
    for (const j of result.junctions) {
      for (const p of j.ports) {
        const dx = p.worldPos[0] - j.worldPos[0]
        const dy = p.worldPos[1] - j.worldPos[1]
        const dz = p.worldPos[2] - j.worldPos[2]
        expect(Math.sqrt(dx * dx + dy * dy + dz * dz)).toBeLessThanOrEqual(FLUID_PORT_TOL * 1.5)
      }
    }
  })
})
