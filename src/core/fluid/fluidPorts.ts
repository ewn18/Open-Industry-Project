// Extraction and world-space transform of fluid ports from part instances.

import { resolvePartParams } from '../geometry/geometryEval'
import type { ParamValue, SnapParamOffset } from '../parts/partApi'
import { getPackage } from '../parts/partRegistry'
import { chainEndpoints, chainsOf } from '../snap/snapConnectors'
import { rotateXZ } from '../transforms'
import type { PartInstance, SdkPart } from '../types'
import type { FluidPortDecl } from './fluidTypes'

export interface WorldFluidPort {
  partId: string
  name: string
  portIndex: number
  worldPos: [number, number, number]
  dir?: [number, number, number]
}

function applyParamOffsets(
  base: readonly [number, number, number] | undefined,
  offsets: readonly SnapParamOffset[] | undefined,
  params: Readonly<Record<string, unknown>>,
  xBase = 0,
): [number, number, number] {
  const out: [number, number, number] = [base ? xBase + base[0] : xBase, base?.[1] ?? 0, base?.[2] ?? 0]
  for (const r of offsets ?? []) {
    const v = params[r.param]
    if (typeof v !== 'number' || !Number.isFinite(v)) continue
    let d = v * (r.scale ?? 1) + (r.add ?? 0)
    if (r.min !== undefined) d = Math.max(d, r.min)
    if (r.max !== undefined) d = Math.min(d, r.max)
    out[r.axis] += d
  }
  return out
}

export function toWorldPos(part: SdkPart, local: readonly [number, number, number]): [number, number, number] {
  const rot = rotateXZ(local[0], local[2], part.rotationY)
  return [part.position[0] + rot.x, part.position[1] + local[1], part.position[2] + rot.z]
}

function toWorldDir(part: SdkPart, localDir: readonly [number, number, number]): [number, number, number] {
  const rot = rotateXZ(localDir[0], localDir[2], part.rotationY)
  return [rot.x, localDir[1], rot.z]
}

/** Extract all world-space fluid connection ports defined on `part`. */
export function extractWorldFluidPorts(part: SdkPart): WorldFluidPort[] {
  const pkg = getPackage(part.packageId)
  if (!pkg?.fluid) return []
  const params = resolvePartParams(pkg.params, part.params as Record<string, ParamValue>)
  const out: WorldFluidPort[] = []

  // 1. Declarative fluid.ports
  if (Array.isArray(pkg.fluid.ports) && pkg.fluid.ports.length > 0) {
    const chains = chainsOf(pkg.snap)
    pkg.fluid.ports.forEach((decl: FluidPortDecl, i: number) => {
      let localPos: [number, number, number] | null = null
      if (decl.chain) {
        const c = chains[decl.chain.index]
        if (c) {
          const ends = chainEndpoints(c, params)
          if (ends) {
            const pt = decl.chain.end === 'start' ? ends.start : ends.end
            localPos = [pt[0], pt[1], pt[2]]
          }
        }
      }
      if (!localPos) {
        localPos = applyParamOffsets(decl.at ?? [0, 0, 0], decl.atParams, params)
      }
      const worldPos = toWorldPos(part, localPos)
      const dir = decl.dir ? toWorldDir(part, decl.dir) : undefined
      out.push({
        partId: part.id,
        name: decl.name,
        portIndex: i,
        worldPos,
        dir,
      })
    })
    return out
  }

  // 2. Transitional fallback for role: 'pump' | 'pipe' (deriving ports from snap.chain)
  const role = pkg.fluid.role
  const chains = chainsOf(pkg.snap)
  if (chains.length > 0) {
    if (role === 'pump' && chains.length >= 2) {
      // Multi-chain pump: chain[0].start is suction nozzle, chain[1].end is discharge nozzle
      const ends0 = chainEndpoints(chains[0]!, params)
      const ends1 = chainEndpoints(chains[1]!, params)
      if (ends0) {
        out.push({
          partId: part.id,
          name: 'suction',
          portIndex: 0,
          worldPos: toWorldPos(part, ends0.start),
        })
      }
      if (ends1) {
        out.push({
          partId: part.id,
          name: 'discharge',
          portIndex: 1,
          worldPos: toWorldPos(part, ends1.end),
        })
      }
    } else {
      chains.forEach((chain, chainIndex) => {
        const ends = chainEndpoints(chain, params)
        if (!ends) return
        const startName = role === 'pump' ? 'suction' : chainIndex === 0 ? 'a' : `a_${chainIndex}`
        const endName = role === 'pump' ? 'discharge' : chainIndex === 0 ? 'b' : `b_${chainIndex}`
        out.push({
          partId: part.id,
          name: startName,
          portIndex: out.length,
          worldPos: toWorldPos(part, ends.start),
        })
        out.push({
          partId: part.id,
          name: endName,
          portIndex: out.length,
          worldPos: toWorldPos(part, ends.end),
        })
      })
    }
  }

  if (out.length === 0) {
    const lenParam = typeof params.length === 'number' && params.length > 0 ? params.length : 1
    const half = lenParam / 2
    out.push({
      partId: part.id,
      name: role === 'pump' ? 'suction' : 'a',
      portIndex: 0,
      worldPos: toWorldPos(part, [-half, 0, 0]),
    })
    out.push({
      partId: part.id,
      name: role === 'pump' ? 'discharge' : 'b',
      portIndex: 1,
      worldPos: toWorldPos(part, [half, 0, 0]),
    })
  }

  return out
}

export function isFluidPart(part: PartInstance): boolean {
  return part.type === 'part' && getPackage(part.packageId)?.fluid !== undefined
}
