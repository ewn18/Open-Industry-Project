import { resolvePartParams } from '../geometry/geometryEval'
import { memoizeByParticipants } from '../memoParts'
import type { ParamValue } from '../parts/partApi'
import { getPackage } from '../parts/partRegistry'
import { chainEndpoints, chainsOf } from '../snap/snapConnectors'
import { rotateXZ } from '../transforms'
import type { PartInstance, SdkPart } from '../types'

/** World-space distance tolerance (m) within which two fluid ports connect. Matches snap tolerance. */
const FLUID_PORT_TOL = 0.05

export type FluidPortSide = 'intake' | 'discharge' | 'conduit'

export interface FluidPort {
  partId: string
  portIndex: number
  chainIndex: number
  side: FluidPortSide
  worldPos: [number, number, number]
  /** Connected ports on other fluid parts whose world positions coincide within FLUID_PORT_TOL. */
  neighbors: { partId: string; portIndex: number }[]
}

export interface FluidNode {
  partId: string
  role: 'pump' | 'pipe'
  ports: FluidPort[]
}

export interface FluidTopology {
  nodes: ReadonlyMap<string, FluidNode>
}

function isFluidPart(part: PartInstance): boolean {
  return part.type === 'part' && getPackage(part.packageId)?.fluid !== undefined
}

function toWorldPos(part: SdkPart, local: readonly [number, number, number]): [number, number, number] {
  const rot = rotateXZ(local[0], local[2], part.rotationY)
  return [part.position[0] + rot.x, part.position[1] + local[1], part.position[2] + rot.z]
}

function extractFluidPorts(part: SdkPart): FluidPort[] {
  const pkg = getPackage(part.packageId)
  if (!pkg?.fluid) return []
  const role = pkg.fluid.role
  const params = resolvePartParams(pkg.params, part.params as Record<string, ParamValue>)
  const chains = chainsOf(pkg.snap)
  const ports: FluidPort[] = []

  if (chains.length > 0) {
    const multiChainPump = role === 'pump' && chains.length >= 2
    chains.forEach((chain, chainIndex) => {
      const ends = chainEndpoints(chain, params)
      if (!ends) return
      // For a single-chain pump: start = intake, end = discharge.
      // For a multi-chain pump: chain[0] = intake nozzle, chain[1+] = discharge nozzle(s).
      const startSide: FluidPortSide =
        role === 'pump' ? (multiChainPump ? (chainIndex === 0 ? 'intake' : 'discharge') : 'intake') : 'conduit'
      const endSide: FluidPortSide =
        role === 'pump' ? (multiChainPump ? (chainIndex === 0 ? 'intake' : 'discharge') : 'discharge') : 'conduit'
      ports.push({
        partId: part.id,
        portIndex: ports.length,
        chainIndex,
        side: startSide,
        worldPos: toWorldPos(part, ends.start),
        neighbors: [],
      })
      ports.push({
        partId: part.id,
        portIndex: ports.length,
        chainIndex,
        side: endSide,
        worldPos: toWorldPos(part, ends.end),
        neighbors: [],
      })
    })
  }

  if (ports.length === 0) {
    const lenParam = typeof params.length === 'number' && params.length > 0 ? params.length : 1
    const half = lenParam / 2
    ports.push({
      partId: part.id,
      portIndex: 0,
      chainIndex: 0,
      side: role === 'pump' ? 'intake' : 'conduit',
      worldPos: toWorldPos(part, [-half, 0, 0]),
      neighbors: [],
    })
    ports.push({
      partId: part.id,
      portIndex: 1,
      chainIndex: 0,
      side: role === 'pump' ? 'discharge' : 'conduit',
      worldPos: toWorldPos(part, [half, 0, 0]),
      neighbors: [],
    })
  }

  return ports
}

function computeFluidTopologyUncached(parts: readonly PartInstance[]): FluidTopology {
  const fluidParts = parts.filter(isFluidPart) as SdkPart[]
  const nodes = new Map<string, FluidNode>()
  const allPorts: FluidPort[] = []

  for (const part of fluidParts) {
    const pkg = getPackage(part.packageId)
    if (!pkg?.fluid) continue
    const ports = extractFluidPorts(part)
    nodes.set(part.id, { partId: part.id, role: pkg.fluid.role, ports })
    for (const p of ports) allPorts.push(p)
  }

  const tolSq = FLUID_PORT_TOL * FLUID_PORT_TOL
  for (let i = 0; i < allPorts.length; i++) {
    const a = allPorts[i]!
    for (let j = i + 1; j < allPorts.length; j++) {
      const b = allPorts[j]!
      if (a.partId === b.partId) continue
      const dx = a.worldPos[0] - b.worldPos[0]
      const dy = a.worldPos[1] - b.worldPos[1]
      const dz = a.worldPos[2] - b.worldPos[2]
      if (dx * dx + dy * dy + dz * dz <= tolSq) {
        a.neighbors.push({ partId: b.partId, portIndex: b.portIndex })
        b.neighbors.push({ partId: a.partId, portIndex: a.portIndex })
      }
    }
  }

  return { nodes }
}

/** Memoized on fluid-participating parts (`memoParts.ts`) so non-fluid scene edits cost nothing. */
export const computeFluidTopology = memoizeByParticipants(isFluidPart, computeFluidTopologyUncached)

