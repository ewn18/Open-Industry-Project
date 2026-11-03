// Struct-of-arrays graph compilation and CSR adjacency generation for the 1D fluid solver.

import { resolvePartParams } from '../geometry/geometryEval'
import type { ParamValue } from '../parts/partApi'
import { getPackage } from '../parts/partRegistry'
import type { PartInstance, SdkPart } from '../types'
import { getFluidElementModule, type GraphEmitter } from './elements/registry'
import { resolveFluidNum } from './fluidBindings'
import { isFluidPart, toWorldPos } from './fluidPorts'
import type { FluidTopology } from './fluidTopology'
import { inToM, psiToPa } from './fluidUnits'

export const NODE_KIND_FREE = 0
export const NODE_KIND_FIXED = 1

export interface CompiledElement {
  kind: string
  partId: string
  name: string
  nodeIndices: number[]
  edgeIndices: number[]
  ratedRpm?: number
  shutoffHead?: number
  ratedFlow?: number
  characteristic?: 'linear' | 'equalPercent' | 'quickOpen'
  area?: number
  height?: number
  level?: number
  nozzleElevations?: number[]
}

export interface FluidComponent {
  id: number
  nodeIndices: number[]
  edgeIndices: number[]
  hasSourceOrTank: boolean
  awake: boolean
}

export interface CompiledTap {
  partId: string
  name: string
  nodeIdx: number
  edgeIdx?: number
}

export interface FluidGraph {
  numNodes: number
  numEdges: number

  // Node arrays (SoA)
  nodeKind: Uint8Array
  nodeIsSupply: Uint8Array
  nodeC: Float64Array
  nodePfixed: Float64Array
  nodeComponent: Int32Array
  nodeVolume: Float64Array

  // Edge arrays (SoA)
  edgeFrom: Int32Array
  edgeTo: Int32Array
  edgeR_lam: Float64Array
  edgeR_turb: Float64Array
  edgeH: Float64Array
  edgeOpen: Float64Array
  edgeOneWay: Uint8Array
  edgeElementIdx: Int32Array

  // Adjacency in Compressed Sparse Row (CSR) format:
  // nodeEdges stores `edgeIdx` (leaving node) or `~edgeIdx` (entering node)
  nodeEdgeStart: Int32Array
  nodeEdges: Int32Array

  components: FluidComponent[]
  elements: CompiledElement[]
  elementsByPart: ReadonlyMap<string, CompiledElement[]>
  junctionToNode: ReadonlyMap<number, number>
  partPortToNode: ReadonlyMap<string, number>
  taps: CompiledTap[]
  tapsByPart: ReadonlyMap<string, CompiledTap[]>
}

export function compileFluidGraph(parts: readonly PartInstance[], topology: FluidTopology): FluidGraph {
  const fluidParts = parts.filter(isFluidPart) as SdkPart[]

  // Temporary builders
  const nodeKinds: number[] = []
  const nodeIsSupply: number[] = []
  const nodeCapacitances: number[] = []
  const nodePfixed: number[] = []
  const nodeVolumes: number[] = []

  const edgeFrom: number[] = []
  const edgeTo: number[] = []
  const edgeR_lam: number[] = []
  const edgeR_turb: number[] = []
  const edgeH: number[] = []
  const edgeOpen: number[] = []
  const edgeOneWay: number[] = []
  const edgeElementIdx: number[] = []

  const junctionToNode = new Map<number, number>()
  const partPortToNode = new Map<string, number>()

  // 1. Allocate a graph node for every topological junction
  for (const j of topology.junctions) {
    const nodeIdx = nodeKinds.length
    junctionToNode.set(j.id, nodeIdx)
    nodeKinds.push(NODE_KIND_FREE)
    nodeIsSupply.push(0)
    nodeCapacitances.push(1e-10) // Fast, realistic ~0.05s hydraulic capacitance
    nodePfixed.push(0)
    nodeVolumes.push(0)

    for (const p of j.ports) {
      partPortToNode.set(`${p.partId}:${p.name}`, nodeIdx)
      partPortToNode.set(`${p.partId}:#${p.portIndex}`, nodeIdx)
    }
  }

  const emitter: GraphEmitter = {
    addNode(kind: 'free' | 'fixed', capacitance: number, fixedPressure = 0, isSupply = false): number {
      const idx = nodeKinds.length
      nodeKinds.push(kind === 'fixed' ? NODE_KIND_FIXED : NODE_KIND_FREE)
      nodeIsSupply.push(isSupply ? 1 : 0)
      nodeCapacitances.push(Math.max(1e-10, capacitance))
      nodePfixed.push(fixedPressure)
      nodeVolumes.push(0)
      return idx
    },
    addEdge(
      from: number,
      to: number,
      r: number,
      R: number,
      H = 0,
      open = 1,
      oneWay = false,
    ): number {
      const idx = edgeFrom.length
      edgeFrom.push(from)
      edgeTo.push(to)
      edgeR_lam.push(Math.max(1e-6, r))
      edgeR_turb.push(Math.max(0, R))
      edgeH.push(H)
      edgeOpen.push(open)
      edgeOneWay.push(oneWay ? 1 : 0)
      edgeElementIdx.push(-1)
      return idx
    },
  }

  const elements: CompiledElement[] = []
  const elementsByPart = new Map<string, CompiledElement[]>()

  // Helper to record compiled element
  const recordElement = (el: CompiledElement) => {
    const elIdx = elements.length
    elements.push(el)
    for (const eIdx of el.edgeIndices) {
      edgeElementIdx[eIdx] = elIdx
    }
    let list = elementsByPart.get(el.partId)
    if (!list) {
      list = []
      elementsByPart.set(el.partId, list)
    }
    list.push(el)
  }

  // 2. Compile elements for each part
  for (const part of fluidParts) {
    const pkg = getPackage(part.packageId)
    if (!pkg?.fluid) continue
    const params = resolvePartParams(pkg.params, part.params as Record<string, ParamValue>)

    // Build part port-to-node map for element resolution
    const portNodes = new Map<string, number>()
    if (Array.isArray(pkg.fluid.ports)) {
      pkg.fluid.ports.forEach((p, idx) => {
        const n = partPortToNode.get(`${part.id}:${p.name}`) ?? partPortToNode.get(`${part.id}:#${idx}`)
        if (n !== undefined) portNodes.set(p.name, n)
      })
    } else {
      // Transitional fallback for role: 'pump' | 'pipe'
      const sNode = partPortToNode.get(`${part.id}:suction`) ?? partPortToNode.get(`${part.id}:#0`)
      const dNode = partPortToNode.get(`${part.id}:discharge`) ?? partPortToNode.get(`${part.id}:#1`)
      const aNode = partPortToNode.get(`${part.id}:a`) ?? partPortToNode.get(`${part.id}:#0`)
      const bNode = partPortToNode.get(`${part.id}:b`) ?? partPortToNode.get(`${part.id}:#1`)
      if (sNode !== undefined) portNodes.set('suction', sNode)
      if (dNode !== undefined) portNodes.set('discharge', dNode)
      if (aNode !== undefined) portNodes.set('a', aNode)
      if (bNode !== undefined) portNodes.set('b', bNode)
    }

    const isConnected = (pName: string): boolean => {
      return (topology.portExternalDegree.get(`${part.id}:${pName}`) ?? 0) > 0
    }

    // A. Declarative elements
    if (Array.isArray(pkg.fluid.elements) && pkg.fluid.elements.length > 0) {
      for (const elDecl of pkg.fluid.elements) {
        const mod = getFluidElementModule(elDecl.kind)
        if (!mod) continue
        const slots = mod.compile(elDecl, params, portNodes, isConnected, emitter)
        const compiled: CompiledElement = {
          kind: elDecl.kind,
          partId: part.id,
          name: elDecl.name ?? elDecl.kind,
          nodeIndices: slots.nodeIndices,
          edgeIndices: slots.edgeIndices,
        }
        if (elDecl.kind === 'valve') {
          compiled.characteristic = elDecl.characteristic
        } else if (elDecl.kind === 'tank') {
          compiled.area = Math.max(0.01, resolveFluidNum(elDecl.area, params, 1.0))
          compiled.height = Math.max(0.1, resolveFluidNum(elDecl.height, params, 2.0))
          compiled.level = Math.max(0, Math.min(compiled.height, resolveFluidNum(elDecl.initialLevel, params, 0)))
          compiled.nozzleElevations = elDecl.ports.map((p) => Math.max(0, resolveFluidNum(p.height, params, 0)))
        }
        recordElement(compiled)
      }
      continue
    }

    // B. Legacy / transitional fallback element compilation
    if (pkg.fluid.role === 'pump') {
      const sNode = portNodes.get('suction')
      const dNode = portNodes.get('discharge')
      if (sNode !== undefined && dNode !== undefined) {
        const maxRpm = typeof params.maxRpm === 'number' ? params.maxRpm : 1750
        const gpmPerRpm = typeof params.gpmPerRpm === 'number' ? params.gpmPerRpm : 0.1
        const maxHeadPsi = typeof params.maxHeadPsi === 'number' ? params.maxHeadPsi : 80
        const pShutoff = psiToPa(maxHeadPsi)
        const qRated = gpmPerRpm * maxRpm * 0.0000630901964

        // Pump curve: Delta P = H - RPump * Q^2. Regularize with small linear term at Q=0.
        const RPump = pShutoff / (qRated * qRated)
        const rPump = 0.05 * (pShutoff / qRated)

        const edgeIdx = emitter.addEdge(sNode, dNode, rPump, RPump, 0, 1, false)
        recordElement({
          kind: 'pump',
          partId: part.id,
          name: 'pump',
          nodeIndices: [],
          edgeIndices: [edgeIdx],
          ratedRpm: maxRpm,
          shutoffHead: pShutoff,
          ratedFlow: qRated,
        })
      }
    } else if (pkg.fluid.role === 'pipe') {
      const aNode = portNodes.get('a')
      const bNode = portNodes.get('b')
      if (aNode !== undefined && bNode !== undefined) {
        const pipeIdIn = typeof params.pipeId === 'number' ? params.pipeId : 4
        const lengthM = typeof params.length === 'number' ? params.length : 1
        const fluidSupply = params.fluidSupply === true
        const openEnd = params.openEnd === true
        const d = inToM(pipeIdIn)

        // Pipe friction edge
        const R = (8 * 0.02 * 998.2 * lengthM) / (Math.PI * Math.PI * Math.pow(d, 5))
        const r = (128 * 0.001 * lengthM) / (Math.PI * Math.pow(d, 4))
        const pipeEdge = emitter.addEdge(aNode, bNode, r, R, 0, 1, false)

        const nodeSlots: number[] = []
        const edgeSlots: number[] = [pipeEdge]

        // Supply source boundary if port 'a' is not connected to another part
        const isConnA = (topology.portExternalDegree.get(`${part.id}:a`) ?? 0) > 0
        if (!isConnA) {
          const srcNode = emitter.addNode('fixed', 0, 0, true)
          const srcEdge = emitter.addEdge(srcNode, aNode, 1e-4, 0, 0, fluidSupply ? 1 : 0, false)
          nodeSlots.push(srcNode)
          edgeSlots.push(srcEdge)
        }

        // Open end discharge boundary if port 'b' is not connected to another part
        const isConnB = (topology.portExternalDegree.get(`${part.id}:b`) ?? 0) > 0
        if (!isConnB) {
          const outNode = emitter.addNode('fixed', 0, 0, false)
          const RExit = (0.35 * 1.7323e12) / Math.pow(Math.max(0.25, pipeIdIn), 4)
          const outEdge = emitter.addEdge(bNode, outNode, 1e-4, RExit, 0, openEnd ? 1 : 0, false)
          nodeSlots.push(outNode)
          edgeSlots.push(outEdge)
        }

        recordElement({
          kind: 'pipe',
          partId: part.id,
          name: 'pipe',
          nodeIndices: nodeSlots,
          edgeIndices: edgeSlots,
        })
      }
    }
  }

  const numNodes = nodeKinds.length
  const numEdges = edgeFrom.length

  // 3. Build CSR adjacency representation
  const edgeDegree = new Int32Array(numNodes)
  for (let e = 0; e < numEdges; e++) {
    const u = edgeFrom[e]!
    const v = edgeTo[e]!
    edgeDegree[u] = (edgeDegree[u] ?? 0) + 1
    edgeDegree[v] = (edgeDegree[v] ?? 0) + 1
  }

  const nodeEdgeStart = new Int32Array(numNodes + 1)
  for (let i = 0; i < numNodes; i++) {
    nodeEdgeStart[i + 1] = (nodeEdgeStart[i] ?? 0) + (edgeDegree[i] ?? 0)
  }

  const nodeEdges = new Int32Array(2 * numEdges)
  const currentOffset = new Int32Array(nodeEdgeStart)

  for (let e = 0; e < numEdges; e++) {
    const u = edgeFrom[e]!
    const v = edgeTo[e]!
    const offU = currentOffset[u] ?? 0
    currentOffset[u] = offU + 1
    nodeEdges[offU] = e
    const offV = currentOffset[v] ?? 0
    currentOffset[v] = offV + 1
    nodeEdges[offV] = ~e
  }

  // 4. Connected components via BFS
  const nodeComponent = new Int32Array(numNodes).fill(-1)
  const components: FluidComponent[] = []
  let nextCompId = 0

  for (let i = 0; i < numNodes; i++) {
    if (nodeComponent[i] !== -1) continue
    const compId = nextCompId++
    const cNodes: number[] = []
    const cEdges = new Set<number>()
    let hasSourceOrTank = false

    const queue = [i]
    nodeComponent[i] = compId

    while (queue.length > 0) {
      const u = queue.shift()!
      cNodes.push(u)
      if (nodeIsSupply[u] === 1) {
        hasSourceOrTank = true
      }

      const start = nodeEdgeStart[u]!
      const end = nodeEdgeStart[u + 1]!
      for (let idx = start; idx < end; idx++) {
        const rawE = nodeEdges[idx]!
        const e = rawE >= 0 ? rawE : ~rawE
        cEdges.add(e)
        const v = rawE >= 0 ? edgeTo[e]! : edgeFrom[e]!
        if (nodeComponent[v] === -1) {
          nodeComponent[v] = compId
          queue.push(v)
        }
      }
    }

    components.push({
      id: compId,
      nodeIndices: cNodes,
      edgeIndices: [...cEdges],
      hasSourceOrTank,
      awake: true,
    })
  }

  // 5. Compile measurement taps
  const compiledTaps: CompiledTap[] = []
  const tapsByPart = new Map<string, CompiledTap[]>()

  for (const part of fluidParts) {
    const pkg = getPackage(part.packageId)
    if (!pkg?.fluid?.taps || pkg.fluid.taps.length === 0) continue

    for (const tapDecl of pkg.fluid.taps) {
      const worldPos = toWorldPos(part, tapDecl.at)
      const reach = tapDecl.reach ?? 0.15
      const reachSq = reach * reach

      let bestNode = -1
      let bestDistSq = reachSq
      for (const j of topology.junctions) {
        const dx = j.worldPos[0] - worldPos[0]
        const dy = j.worldPos[1] - worldPos[1]
        const dz = j.worldPos[2] - worldPos[2]
        const dSq = dx * dx + dy * dy + dz * dz
        if (dSq <= bestDistSq) {
          bestDistSq = dSq
          const n = junctionToNode.get(j.id)
          if (n !== undefined) bestNode = n
        }
      }

      if (bestNode !== -1) {
        const cTap: CompiledTap = {
          partId: part.id,
          name: tapDecl.name,
          nodeIdx: bestNode,
        }
        compiledTaps.push(cTap)
        let list = tapsByPart.get(part.id)
        if (!list) {
          list = []
          tapsByPart.set(part.id, list)
        }
        list.push(cTap)
      }
    }
  }

  return {
    numNodes,
    numEdges,
    nodeKind: new Uint8Array(nodeKinds),
    nodeIsSupply: new Uint8Array(nodeIsSupply),
    nodeC: new Float64Array(nodeCapacitances),
    nodePfixed: new Float64Array(nodePfixed),
    nodeComponent,
    nodeVolume: new Float64Array(nodeVolumes),
    edgeFrom: new Int32Array(edgeFrom),
    edgeTo: new Int32Array(edgeTo),
    edgeR_lam: new Float64Array(edgeR_lam),
    edgeR_turb: new Float64Array(edgeR_turb),
    edgeH: new Float64Array(edgeH),
    edgeOpen: new Float64Array(edgeOpen),
    edgeOneWay: new Uint8Array(edgeOneWay),
    edgeElementIdx: new Int32Array(edgeElementIdx),
    nodeEdgeStart,
    nodeEdges,
    components,
    elements,
    elementsByPart,
    junctionToNode,
    partPortToNode,
    taps: compiledTaps,
    tapsByPart,
  }
}
