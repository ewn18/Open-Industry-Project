// 1D lumped-parameter hydraulic network owner for SimWorld (src/sim/world.ts).
// Resolves connected pump/pipe networks from `snap.chain` ports (src/core/fluid/fluidTopology.ts) and steps
// pressure (PSI), volumetric flow (GPM) and fluid velocity (ft/s) each fixed physics tick.

import { computeFluidTopology, type FluidNode, type FluidTopology } from '../core/fluid/fluidTopology'
import { resolvePartParams } from '../core/geometry/geometryEval'
import type { ParamValue } from '../core/parts/partApi'
import type { FluidCommand, FluidReading } from '../core/parts/partPackage'
import { getPackage } from '../core/parts/partRegistry'
import type { PartInstance } from '../core/types'

/** Darcy-Weisbach lumped resistance scale (PSI / GPM^2 per m of 1-inch ID pipe). */
const PIPE_FRICTION_K = 0.08
/** Exit velocity-head resistance factor at an open discharge end (PSI / GPM^2 for a 1-inch ID nozzle). */
const EXIT_NOZZLE_K = 0.35
/** Base hydraulic capacitance time-constant scale (s per m of 1-inch ID pipe). */
const PIPE_CAPACITANCE_K = 0.005
/** Natural depressurization / bleed time constant (s) when a pump stops or loses supply. */
const DEPRESSURIZE_TAU = 0.35

export const ZERO_FLUID_READING: FluidReading = Object.freeze({
  pressure: 0,
  flow: 0,
  velocity: 0,
  supplied: false,
})

interface PartFluidState {
  partId: string
  role: 'pump' | 'pipe'
  // Pump parameters
  rpm: number
  maxRpm: number
  gpmPerRpm: number
  maxHeadPsi: number
  // Pipe parameters
  pipeId: number
  length: number
  fluidSupply: boolean
  openEnd: boolean
  // Live solved state
  pressure: number
  flow: number
  velocity: number
  supplied: boolean
  // Beginning-of-tick snapshot handed to behaviors (order-independent)
  snapshot: FluidReading
}

function numOr(v: unknown, fallback: number, min = -Infinity): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= min ? v : fallback
}

function boolOr(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback
}

/** Resistance (PSI / GPM^2) of a pipe segment of length `lengthM` (m) and inner diameter `pipeIdIn` (inches). */
function pipeResistance(pipeIdIn: number, lengthM: number): number {
  const d = Math.max(0.25, pipeIdIn)
  const l = Math.max(0.05, lengthM)
  return (PIPE_FRICTION_K * l) / Math.pow(d, 5)
}

/** Exit resistance (PSI / GPM^2) of an open pipe end of inner diameter `pipeIdIn` (inches). */
function exitResistance(pipeIdIn: number): number {
  const d = Math.max(0.25, pipeIdIn)
  return EXIT_NOZZLE_K / Math.pow(d, 4)
}

/** Fluid velocity (ft/s) for `flowGpm` (GPM) inside a circular pipe of inner diameter `pipeIdIn` (inches). */
function fluidVelocityFtPerSec(flowGpm: number, pipeIdIn: number): number {
  const d = Math.max(0.25, pipeIdIn)
  return (0.4085 * Math.abs(flowGpm)) / (d * d)
}

/** Hash a partId string into a deterministic scalar phase angle (0 .. 2π). */
function partPhase(partId: string): number {
  let h = 2166136261
  for (let i = 0; i < partId.length; i++) {
    h ^= partId.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return ((h >>> 0) % 6283) / 1000
}

/**
 * Realistic turbulent multi-frequency fluctuation (-1 .. 1).
 * Composed of multiple incommensurate frequencies (~3.7 Hz, ~9.3 Hz, ~17.1 Hz)
 * to produce smooth, non-repeating turbulent noise without free globals or unseeded RNG calls.
 */
function turbulentNoise(t: number, phase: number): number {
  return (
    0.55 * Math.sin(23.1 * t + phase) +
    0.30 * Math.sin(58.7 * t + 1.9 * phase) +
    0.15 * Math.sin(107.3 * t + 3.1 * phase)
  )
}

export class FluidNetwork {
  private readonly states = new Map<string, PartFluidState>()
  private topology: FluidTopology = { nodes: new Map() }
  private simTime = 0

  /** Sync the fluid network's participant table and port topology with the current scene parts. */
  syncScene(parts: readonly PartInstance[]): void {
    this.topology = computeFluidTopology(parts)
    const activeIds = new Set<string>()

    for (const part of parts) {
      if (part.type !== 'part') continue
      const pkg = getPackage(part.packageId)
      if (!pkg?.fluid) continue
      activeIds.add(part.id)

      const params = resolvePartParams(pkg.params, part.params as Record<string, ParamValue>)
      const existing = this.states.get(part.id)
      const pipeId = numOr(params.pipeId, 4, 0.1)
      const length = numOr(params.length, 1, 0.05)
      const fluidSupply = boolOr(params.fluidSupply, false)
      const openEnd = boolOr(params.openEnd, false)
      const maxRpm = numOr(params.maxRpm, 1750, 1)
      const gpmPerRpm = numOr(params.gpmPerRpm, 0.1, 0)
      const maxHeadPsi = numOr(params.maxHeadPsi, 80, 0)

      if (existing) {
        existing.role = pkg.fluid.role
        existing.pipeId = pipeId
        existing.length = length
        existing.fluidSupply = fluidSupply
        existing.openEnd = openEnd
        existing.maxRpm = maxRpm
        existing.gpmPerRpm = gpmPerRpm
        existing.maxHeadPsi = maxHeadPsi
      } else {
        this.states.set(part.id, {
          partId: part.id,
          role: pkg.fluid.role,
          rpm: 0,
          maxRpm,
          gpmPerRpm,
          maxHeadPsi,
          pipeId,
          length,
          fluidSupply,
          openEnd,
          pressure: 0,
          flow: 0,
          velocity: 0,
          supplied: false,
          snapshot: ZERO_FLUID_READING,
        })
      }
    }

    for (const id of [...this.states.keys()]) {
      if (!activeIds.has(id)) this.states.delete(id)
    }
  }

  /** Remove a single destroyed part from the fluid network. */
  forget(partId: string): void {
    this.states.delete(partId)
  }

  /** Clear all state on world teardown. */
  clear(): void {
    this.states.clear()
    this.topology = { nodes: new Map() }
    this.simTime = 0
  }

  /** Beginning-of-tick fluid reading for `partId` (handed to `BehaviorInput.fluid`). */
  readingOf(partId: string | null | undefined): FluidReading | undefined {
    if (!partId) return undefined
    return this.states.get(partId)?.snapshot
  }

  /** Apply a behavior script's `ctx.setFluid(cmd)` command for this tick. */
  applyCommand(partId: string | null | undefined, cmd: FluidCommand | undefined): void {
    if (!partId || !cmd) return
    const st = this.states.get(partId)
    if (!st) return
    if (cmd.rpm !== undefined) st.rpm = Math.max(0, cmd.rpm)
    if (cmd.maxRpm !== undefined && cmd.maxRpm > 0) st.maxRpm = cmd.maxRpm
    if (cmd.gpmPerRpm !== undefined && cmd.gpmPerRpm >= 0) st.gpmPerRpm = cmd.gpmPerRpm
    if (cmd.maxHeadPsi !== undefined && cmd.maxHeadPsi >= 0) st.maxHeadPsi = cmd.maxHeadPsi
    if (cmd.pipeId !== undefined && cmd.pipeId > 0) st.pipeId = cmd.pipeId
    if (cmd.length !== undefined && cmd.length > 0) st.length = cmd.length
    if (cmd.fluidSupply !== undefined) st.fluidSupply = cmd.fluidSupply
    if (cmd.openEnd !== undefined) st.openEnd = cmd.openEnd
  }

  /** Advance the 1D hydraulic network by one physics step `dt` (seconds). */
  step(dt: number): void {
    if (this.states.size === 0) return
    this.simTime += dt
    const nodes = this.topology.nodes

    // Accumulators for target pressure, target flow, and supply status across all parts
    const targetPressure = new Map<string, number>()
    const targetFlow = new Map<string, number>()
    const isSupplied = new Map<string, boolean>()

    for (const st of this.states.values()) {
      targetPressure.set(st.partId, 0)
      targetFlow.set(st.partId, 0)
      isSupplied.set(st.partId, st.role === 'pipe' && st.fluidSupply)
    }

    // 1. Propagate static `fluidSupply` connectivity across passive pipe networks even when pumps are off
    for (const [id, st] of this.states) {
      if (st.role === 'pipe' && st.fluidSupply) {
        this.markConnectedPipesSupplied(id, nodes, isSupplied)
      }
    }

    // 2. Solve each pump and its connected intake + discharge pipe trees
    for (const [pumpId, pumpState] of this.states) {
      if (pumpState.role !== 'pump') continue
      const pumpNode = nodes.get(pumpId)
      if (!pumpNode) continue

      // Discover the intake (suction) pipe tree connected to the pump's intake ports
      const intakeTree = this.tracePipeTree(pumpNode, 'intake', nodes)
      let supplyPipeId: string | null = null
      for (const pid of intakeTree.order) {
        const pst = this.states.get(pid)
        if (pst?.fluidSupply) {
          supplyPipeId = pid
          break
        }
      }

      if (!supplyPipeId) {
        // Pump has no fluid supply on its intake side -> starved (0 PSI, 0 GPM)
        continue
      }
      isSupplied.set(pumpId, true)

      // Compute intake path resistance from the supply pipe to the pump intake
      const intakePath = this.pathFromRoot(supplyPipeId, intakeTree.parent)
      let rIntake = 0
      for (const pid of intakePath) {
        const pst = this.states.get(pid)
        if (pst) rIntake += pipeResistance(pst.pipeId, pst.length)
      }

      // Discover the discharge pipe tree connected to the pump's discharge ports
      const dischargeTree = this.tracePipeTree(pumpNode, 'discharge', nodes)
      for (const pid of dischargeTree.order) {
        isSupplied.set(pid, true)
      }

      const rpm = Math.max(0, pumpState.rpm)
      if (rpm <= 1e-3) continue

      const omega = rpm / Math.max(1, pumpState.maxRpm)
      const qMax = Math.max(1e-4, pumpState.gpmPerRpm * rpm)
      const pShutoff = Math.max(0, pumpState.maxHeadPsi * omega * omega)
      const rPump = pShutoff / (qMax * qMax)

      // Find all discharge pipes that have an unconnected port AND `openEnd === true`
      const openLeaves: string[] = []
      for (const pid of dischargeTree.order) {
        const pst = this.states.get(pid)
        const pnode = nodes.get(pid)
        if (!pst?.openEnd || !pnode) continue
        if (pnode.ports.some((port) => port.neighbors.length === 0)) {
          openLeaves.push(pid)
        }
      }

      if (openLeaves.length === 0) {
        // CLOSED / CAPPED DISCHARGE:
        // Pressure across the pump and all connected discharge pipes rises to shutoff head `pShutoff`.
        // While pressurizing (current pressure < pShutoff), transient charging flow enters the pipes.
        targetPressure.set(pumpId, Math.max(targetPressure.get(pumpId) ?? 0, pShutoff))
        let totalChargingFlow = 0
        for (const pid of dischargeTree.order) {
          const pst = this.states.get(pid)
          if (!pst) continue
          targetPressure.set(pid, Math.max(targetPressure.get(pid) ?? 0, pShutoff))
          const dP = Math.max(0, pShutoff - pst.pressure)
          if (dP > 1e-3 && pShutoff > 1e-3) {
            const pathIds = this.pathFromRoot(pid, dischargeTree.parent)
            const capScale = Math.min(1, 0.04 * pst.pipeId * pst.pipeId * pst.length)
            const qCharge = qMax * (dP / pShutoff) * capScale
            totalChargingFlow += qCharge
            for (const upId of pathIds) {
              targetFlow.set(upId, (targetFlow.get(upId) ?? 0) + qCharge)
            }
          }
        }
        totalChargingFlow = Math.min(qMax, totalChargingFlow)
        targetFlow.set(pumpId, Math.max(targetFlow.get(pumpId) ?? 0, totalChargingFlow))
        for (const pid of intakePath) {
          targetFlow.set(pid, Math.max(targetFlow.get(pid) ?? 0, totalChargingFlow))
        }
      } else {
        // FREE-FLOW DISCHARGE (`openEnd === true` on at least one unconnected discharge pipe):
        // Compute path resistance for each open leaf and combine parallel branches via conductance (1 / sqrt(R)).
        const leafPaths = openLeaves.map((leafId) => {
          const pathIds = this.pathFromRoot(leafId, dischargeTree.parent)
          let rPath = 0
          for (const pid of pathIds) {
            const pst = this.states.get(pid)
            if (pst) rPath += pipeResistance(pst.pipeId, pst.length)
          }
          const leafSt = this.states.get(leafId)
          rPath += exitResistance(leafSt?.pipeId ?? 4)
          return { leafId, pathIds, rPath: Math.max(1e-6, rPath) }
        })

        let totalConductance = 0
        for (const lp of leafPaths) totalConductance += 1 / Math.sqrt(lp.rPath)
        const rDischargeEq = totalConductance > 0 ? 1 / (totalConductance * totalConductance) : 1
        const rTotal = rIntake + rDischargeEq

        // Operating flow Q where Pump Curve intersects System Resistance Curve
        const qOperating = Math.min(qMax, Math.sqrt(pShutoff / Math.max(1e-6, rPump + rTotal)))
        const pDischarge = Math.max(0, pShutoff - rPump * qOperating * qOperating)

        targetPressure.set(pumpId, Math.max(targetPressure.get(pumpId) ?? 0, pDischarge))
        targetFlow.set(pumpId, Math.max(targetFlow.get(pumpId) ?? 0, qOperating))

        // Intake pipes carry `qOperating`
        for (const pid of intakePath) {
          targetFlow.set(pid, (targetFlow.get(pid) ?? 0) + qOperating)
        }

        // Distribute `qOperating` across open discharge paths
        for (const lp of leafPaths) {
          const share = totalConductance > 0 ? (1 / Math.sqrt(lp.rPath)) / totalConductance : 0
          const qBranch = qOperating * share
          for (const pid of lp.pathIds) {
            targetFlow.set(pid, (targetFlow.get(pid) ?? 0) + qBranch)
          }
        }

        // Compute pressure along every connected discharge pipe (upstream pressure minus pipe friction drop)
        const pipePressures = new Map<string, number>()
        for (const pid of dischargeTree.order) {
          const parentId = dischargeTree.parent.get(pid)
          const pUpstream = parentId ? (pipePressures.get(parentId) ?? pDischarge) : pDischarge
          const pst = this.states.get(pid)
          const qPipe = targetFlow.get(pid) ?? 0
          const rPipe = pst ? pipeResistance(pst.pipeId, pst.length) : 0
          const pHere = Math.max(0, pUpstream - rPipe * qPipe * qPipe)
          pipePressures.set(pid, pHere)
          targetPressure.set(pid, Math.max(targetPressure.get(pid) ?? 0, pHere))
        }
      }
    }

    // 3. Integrate each part's pressure & flow over `dt` and publish next tick's snapshot
    for (const [id, st] of this.states) {
      const pTarget = targetPressure.get(id) ?? 0
      const qTarget = targetFlow.get(id) ?? 0
      const supplied = isSupplied.get(id) ?? false

      // Time constant depends on pipe volume (ID^2 * length) when pressurizing, or DEPRESSURIZE_TAU when decaying
      const tau =
        pTarget >= st.pressure
          ? Math.max(0.04, Math.min(1.5, PIPE_CAPACITANCE_K * st.pipeId * st.pipeId * st.length))
          : DEPRESSURIZE_TAU
      const alpha = Math.min(1, dt / tau)

      st.pressure += (pTarget - st.pressure) * alpha
      st.flow += (qTarget - st.flow) * alpha
      if (st.pressure < 1e-3 && pTarget === 0) st.pressure = 0
      if (st.flow < 1e-3 && qTarget === 0) st.flow = 0
      st.velocity = st.role === 'pipe' ? fluidVelocityFtPerSec(st.flow, st.pipeId) : 0
      st.supplied = supplied

      // Realistic turbulent micro-jitter (~0.8% pressure, ~1.2% flow) when running/flowing
      let snapPressure = st.pressure
      let snapFlow = st.flow
      if (st.pressure > 0.05) {
        const phi = partPhase(st.partId)
        const np = turbulentNoise(this.simTime, phi)
        snapPressure = Math.max(0, st.pressure * (1 + 0.008 * np))
      }
      if (st.flow > 0.05) {
        const phi = partPhase(st.partId)
        const nq = turbulentNoise(this.simTime + 0.37, phi + 1.2)
        snapFlow = Math.max(0, st.flow * (1 + 0.012 * nq))
      }
      const snapVelocity = st.role === 'pipe' ? fluidVelocityFtPerSec(snapFlow, st.pipeId) : 0

      st.snapshot =
        snapPressure === 0 && snapFlow === 0 && !st.supplied
          ? ZERO_FLUID_READING
          : Object.freeze({
              pressure: snapPressure,
              flow: snapFlow,
              velocity: snapVelocity,
              supplied: st.supplied,
            })
    }
  }

  /** BFS from a pump's `side` ('intake' | 'discharge') ports through connected `'pipe'` nodes. */
  private tracePipeTree(
    pumpNode: FluidNode,
    side: 'intake' | 'discharge',
    nodes: ReadonlyMap<string, FluidNode>,
  ): { order: string[]; parent: Map<string, string | null> } {
    const order: string[] = []
    const parent = new Map<string, string | null>()
    const visited = new Set<string>([pumpNode.partId])

    for (const port of pumpNode.ports) {
      if (port.side !== side) continue
      for (const nb of port.neighbors) {
        const nbNode = nodes.get(nb.partId)
        if (!nbNode || nbNode.role !== 'pipe' || visited.has(nb.partId)) continue
        visited.add(nb.partId)
        parent.set(nb.partId, null)
        order.push(nb.partId)
      }
    }

    for (let i = 0; i < order.length; i++) {
      const curId = order[i]!
      const curNode = nodes.get(curId)
      if (!curNode) continue
      for (const port of curNode.ports) {
        for (const nb of port.neighbors) {
          const nbNode = nodes.get(nb.partId)
          if (!nbNode || nbNode.role !== 'pipe' || visited.has(nb.partId)) continue
          visited.add(nb.partId)
          parent.set(nb.partId, curId)
          order.push(nb.partId)
        }
      }
    }

    return { order, parent }
  }

  /** Reconstruct the ordered pipe path from the pump-adjacent root pipe to `targetPipeId`. */
  private pathFromRoot(targetPipeId: string, parent: ReadonlyMap<string, string | null>): string[] {
    const path: string[] = []
    let cur: string | null | undefined = targetPipeId
    while (cur) {
      path.push(cur)
      cur = parent.get(cur)
    }
    path.reverse()
    return path
  }

  /** Mark all passive pipes connected to a `fluidSupply = true` pipe as supplied. */
  private markConnectedPipesSupplied(
    startId: string,
    nodes: ReadonlyMap<string, FluidNode>,
    isSupplied: Map<string, boolean>,
  ): void {
    const queue = [startId]
    const seen = new Set<string>([startId])
    while (queue.length > 0) {
      const id = queue.shift()!
      isSupplied.set(id, true)
      const node = nodes.get(id)
      if (!node) continue
      for (const port of node.ports) {
        for (const nb of port.neighbors) {
          const nbNode = nodes.get(nb.partId)
          if (!nbNode || nbNode.role !== 'pipe' || seen.has(nb.partId)) continue
          seen.add(nb.partId)
          queue.push(nb.partId)
        }
      }
    }
  }
}
