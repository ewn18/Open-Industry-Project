// 3D Spatial-hash port pairing and union-find topological junction extraction.

import { memoizeByParticipants } from '../memoParts'
import type { PartInstance, SdkPart } from '../types'
import { extractWorldFluidPorts, isFluidPart, type WorldFluidPort } from './fluidPorts'

/** Distance tolerance (m) within which two ports connect. */
export const FLUID_PORT_TOL = 0.05
const FLUID_PORT_TOL_SQ = FLUID_PORT_TOL * FLUID_PORT_TOL

export interface FluidJunctionPort {
  partId: string
  name: string
  portIndex: number
  worldPos: [number, number, number]
}

export interface FluidJunction {
  id: number
  ports: FluidJunctionPort[]
  worldPos: [number, number, number]
}

export interface FluidTopology {
  junctions: readonly FluidJunction[]
  /** Map from `${partId}:${name}` and `${partId}:#${portIndex}` to junction ID. */
  portJunctions: ReadonlyMap<string, number>
  /** Number of other parts connected to this specific port. */
  portExternalDegree: ReadonlyMap<string, number>
}

// Disjoint-set union (union-find) with path compression and rank
class UnionFind {
  private readonly parent: Int32Array
  private readonly rank: Uint8Array

  constructor(size: number) {
    this.parent = new Int32Array(size)
    this.rank = new Uint8Array(size)
    for (let i = 0; i < size; i++) this.parent[i] = i
  }

  find(i: number): number {
    let root = i
    while (root !== this.parent[root]) root = this.parent[root]!
    let curr = i
    while (curr !== root) {
      const next = this.parent[curr]!
      this.parent[curr] = root
      curr = next
    }
    return root
  }

  union(i: number, j: number): boolean {
    const rootI = this.find(i)
    const rootJ = this.find(j)
    if (rootI === rootJ) return false
    const rankI = this.rank[rootI]!
    const rankJ = this.rank[rootJ]!
    if (rankI < rankJ) {
      this.parent[rootI] = rootJ
    } else if (rankI > rankJ) {
      this.parent[rootJ] = rootI
    } else {
      this.parent[rootJ] = rootI
      this.rank[rootI] = rankI + 1
    }
    return true
  }
}

function cellCoord(val: number): number {
  return Math.floor(val / FLUID_PORT_TOL)
}

function cellKey(ix: number, iy: number, iz: number): string {
  return `${ix},${iy},${iz}`
}

export function computeFluidTopologyUncached(parts: readonly PartInstance[]): FluidTopology {
  const fluidParts = parts.filter(isFluidPart) as SdkPart[]
  const allPorts: WorldFluidPort[] = []

  for (const part of fluidParts) {
    const ports = extractWorldFluidPorts(part)
    for (const p of ports) allPorts.push(p)
  }

  const n = allPorts.length
  if (n === 0) {
    return {
      junctions: [],
      portJunctions: new Map(),
      portExternalDegree: new Map(),
    }
  }

  // 1. Spatial hashing into 3D grid
  const grid = new Map<string, number[]>()
  for (let i = 0; i < n; i++) {
    const p = allPorts[i]!
    const key = cellKey(cellCoord(p.worldPos[0]), cellCoord(p.worldPos[1]), cellCoord(p.worldPos[2]))
    let list = grid.get(key)
    if (!list) {
      list = []
      grid.set(key, list)
    }
    list.push(i)
  }

  // 2. Query 27 neighboring cells for each port and union coincident pairs
  const uf = new UnionFind(n)
  const portExternalDegree = new Map<string, number>()

  for (let i = 0; i < n; i++) {
    const pA = allPorts[i]!
    const cx = cellCoord(pA.worldPos[0])
    const cy = cellCoord(pA.worldPos[1])
    const cz = cellCoord(pA.worldPos[2])

    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const list = grid.get(cellKey(cx + dx, cy + dy, cz + dz))
          if (!list) continue
          for (const j of list) {
            if (j <= i) continue
            const pB = allPorts[j]!
            if (pA.partId === pB.partId) continue // Ports on the same part do not merge ambiently
            const distSq =
              (pA.worldPos[0] - pB.worldPos[0]) ** 2 +
              (pA.worldPos[1] - pB.worldPos[1]) ** 2 +
              (pA.worldPos[2] - pB.worldPos[2]) ** 2
            if (distSq <= FLUID_PORT_TOL_SQ) {
              uf.union(i, j)
              const keyA = `${pA.partId}:${pA.name}`
              const keyB = `${pB.partId}:${pB.name}`
              portExternalDegree.set(keyA, (portExternalDegree.get(keyA) ?? 0) + 1)
              portExternalDegree.set(keyB, (portExternalDegree.get(keyB) ?? 0) + 1)
            }
          }
        }
      }
    }
  }

  // 3. Collect ports into junctions
  const junctionGroups = new Map<number, number[]>()
  for (let i = 0; i < n; i++) {
    const root = uf.find(i)
    let group = junctionGroups.get(root)
    if (!group) {
      group = []
      junctionGroups.set(root, group)
    }
    group.push(i)
  }

  const junctions: FluidJunction[] = []
  const portJunctions = new Map<string, number>()
  let nextJunctionId = 0

  for (const portIndices of junctionGroups.values()) {
    const jId = nextJunctionId++
    let sumX = 0
    let sumY = 0
    let sumZ = 0
    const jPorts: FluidJunctionPort[] = []

    for (const idx of portIndices) {
      const p = allPorts[idx]!
      sumX += p.worldPos[0]
      sumY += p.worldPos[1]
      sumZ += p.worldPos[2]
      jPorts.push({
        partId: p.partId,
        name: p.name,
        portIndex: p.portIndex,
        worldPos: p.worldPos,
      })
      portJunctions.set(`${p.partId}:${p.name}`, jId)
      portJunctions.set(`${p.partId}:#${p.portIndex}`, jId)
    }

    const count = portIndices.length
    junctions.push({
      id: jId,
      ports: jPorts,
      worldPos: [sumX / count, sumY / count, sumZ / count],
    })
  }

  return {
    junctions,
    portJunctions,
    portExternalDegree,
  }
}

/** Memoized topology computation keyed on fluid-participating part references. */
export const computeFluidTopology = memoizeByParticipants(isFluidPart, computeFluidTopologyUncached)
