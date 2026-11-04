// Thin SimWorld adapter for the 1D fluid dynamics network.
// Bridges the pure core graph/solver (src/core/fluid/) with SimWorld and behavior scripts.

import { valveOpeningFactor } from '../core/fluid/elements/valve'
import { compileFluidGraph, type FluidGraph } from '../core/fluid/fluidGraph'
import { createInitialFluidState, type FluidState, stepFluidNetwork } from '../core/fluid/fluidSolver'
import { computeFluidTopology, type FluidTopology } from '../core/fluid/fluidTopology'
import type { FluidCommand, FluidReading } from '../core/fluid/fluidTypes'
import { inToM, m3sToGpm, paToPsi } from '../core/fluid/fluidUnits'
import type { PartInstance } from '../core/types'

export const ZERO_FLUID_READING: FluidReading = Object.freeze({
  pressure: 0,
  flow: 0,
  velocity: 0,
  supplied: false,
  ports: {},
  elements: {},
  taps: {},
})

interface PartSnapshot {
  reading: FluidReading
  pumpRpm: number
  pumpMaxRpm: number
  pumpMaxHeadPa: number
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
  private topology: FluidTopology = {
    junctions: [],
    portJunctions: new Map(),
    portExternalDegree: new Map(),
  }
  private graph: FluidGraph = compileFluidGraph([], this.topology)
  private state: FluidState = createInitialFluidState(this.graph)
  private readonly snapshots = new Map<string, PartSnapshot>()
  private simTime = 0

  /** Sync the fluid network topology and compiled graph with the current scene parts. */
  syncScene(parts: readonly PartInstance[]): void {
    this.topology = computeFluidTopology(parts)
    const newGraph = compileFluidGraph(parts, this.topology)
    const newState = createInitialFluidState(newGraph)

    // Preserve pressures from old state where node junctions match
    for (const [jId, oldNodeIdx] of this.graph.junctionToNode) {
      const newNodeIdx = newGraph.junctionToNode.get(jId)
      if (newNodeIdx !== undefined && oldNodeIdx < this.state.pressure.length) {
        newState.pressure[newNodeIdx] = this.state.pressure[oldNodeIdx]!
      }
    }

    this.graph = newGraph
    this.state = newState

    // Sync part snapshots
    const activePartIds = new Set<string>()
    for (const [partId, elements] of this.graph.elementsByPart) {
      activePartIds.add(partId)
      if (!this.snapshots.has(partId)) {
        const pumpEl = elements.find((e) => e.kind === 'pump')
        const elementsReading: Record<string, { flow: number; level?: number; volume?: number }> = {}
        for (const el of elements) {
          if (el.kind === 'tank') {
            elementsReading[el.name] = {
              flow: 0,
              level: el.level,
              volume: el.area && el.level !== undefined ? el.level * el.area : undefined,
            }
          } else {
            elementsReading[el.name] = { flow: 0 }
          }
        }
        const hasTank = elements.some((e) => e.kind === 'tank')
        const initialReading = hasTank
          ? Object.freeze({
              pressure: 0,
              flow: 0,
              velocity: 0,
              supplied: true,
              ports: {},
              elements: elementsReading,
              taps: {},
            })
          : ZERO_FLUID_READING

        this.snapshots.set(partId, {
          reading: initialReading,
          pumpRpm: 0,
          pumpMaxRpm: pumpEl?.ratedRpm ?? 1750,
          pumpMaxHeadPa: pumpEl?.shutoffHead ?? 550000,
        })
      }
    }

    for (const [partId] of this.graph.tapsByPart) {
      activePartIds.add(partId)
      if (!this.snapshots.has(partId)) {
        this.snapshots.set(partId, {
          reading: ZERO_FLUID_READING,
          pumpRpm: 0,
          pumpMaxRpm: 1750,
          pumpMaxHeadPa: 550000,
        })
      }
    }

    for (const id of [...this.snapshots.keys()]) {
      if (!activePartIds.has(id)) this.snapshots.delete(id)
    }
  }

  forget(_partId: string): void {
    // Managed via syncScene on updateScene; individual forget is a no-op to preserve runtime state across edits
  }

  clear(): void {
    this.topology = {
      junctions: [],
      portJunctions: new Map(),
      portExternalDegree: new Map(),
    }
    this.graph = compileFluidGraph([], this.topology)
    this.state = createInitialFluidState(this.graph)
    this.snapshots.clear()
    this.simTime = 0
  }

  /** Beginning-of-tick fluid reading for `partId` (handed to `BehaviorInput.fluid`). */
  readingOf(partId: string | null | undefined): FluidReading | undefined {
    if (!partId) return undefined
    return this.snapshots.get(partId)?.reading
  }

  /** Apply a behavior script's `ctx.setFluid(cmd)` command for this tick. */
  applyCommand(partId: string | null | undefined, cmd: FluidCommand | undefined): void {
    if (!partId || !cmd) return
    const snap = this.snapshots.get(partId)
    const elements = this.graph.elementsByPart.get(partId)
    if (!elements) return

    // 1. Pump command handling
    const pumpEl = elements.find((e) => e.kind === 'pump')
    if (pumpEl && pumpEl.edgeIndices.length > 0) {
      const eIdx = pumpEl.edgeIndices[0]!
      if (cmd.maxRpm !== undefined && typeof cmd.maxRpm === 'number' && cmd.maxRpm > 0) {
        if (snap) snap.pumpMaxRpm = cmd.maxRpm
      }
      if (cmd.maxHeadPsi !== undefined && typeof cmd.maxHeadPsi === 'number' && cmd.maxHeadPsi > 0) {
        if (snap) snap.pumpMaxHeadPa = cmd.maxHeadPsi * 6894.757
      }
      if (cmd.rpm !== undefined && typeof cmd.rpm === 'number') {
        const rpm = Math.max(0, cmd.rpm)
        if (snap) snap.pumpRpm = rpm
        const maxRpm = snap?.pumpMaxRpm ?? pumpEl.ratedRpm ?? 1750
        const omega = Math.min(2.0, rpm / Math.max(1, maxRpm))
        const pShutoff = (snap?.pumpMaxHeadPa ?? pumpEl.shutoffHead ?? 550000) * omega * omega
        this.graph.edgeH[eIdx] = pShutoff
      } else if (cmd.speed !== undefined && typeof cmd.speed === 'number') {
        const speed = Math.max(0, Math.min(2.0, cmd.speed))
        const maxRpm = snap?.pumpMaxRpm ?? pumpEl.ratedRpm ?? 1750
        if (snap) snap.pumpRpm = speed * maxRpm
        const pShutoff = (snap?.pumpMaxHeadPa ?? pumpEl.shutoffHead ?? 550000) * speed * speed
        this.graph.edgeH[eIdx] = pShutoff
      }
    }

    // 2. Pipe command handling (openEnd / fluidSupply / pipeId / length)
    const pipeEl = elements.find((e) => e.kind === 'pipe')
    if (pipeEl) {
      if (cmd.openEnd !== undefined && typeof cmd.openEnd === 'boolean') {
        // Find outlet boundary edge if present
        for (const eIdx of pipeEl.edgeIndices) {
          const toNode = this.graph.edgeTo[eIdx]!
          if (this.graph.nodeKind[toNode] === 1 && this.graph.nodeIsSupply[toNode] === 0) {
            this.graph.edgeOpen[eIdx] = cmd.openEnd ? 1 : 0
          }
        }
      }
      if (cmd.fluidSupply !== undefined && typeof cmd.fluidSupply === 'boolean') {
        // Find source boundary edge if present
        for (const eIdx of pipeEl.edgeIndices) {
          const fromNode = this.graph.edgeFrom[eIdx]!
          if (this.graph.nodeKind[fromNode] === 1 && this.graph.nodeIsSupply[fromNode] === 1) {
            this.graph.edgeOpen[eIdx] = cmd.fluidSupply ? 1 : 0
          }
        }
      }
      if (typeof cmd.pipeId === 'number' && cmd.pipeId > 0) {
        const d = inToM(cmd.pipeId)
        const lengthM = typeof cmd.length === 'number' && cmd.length > 0 ? cmd.length : 1
        const mainEdge = pipeEl.edgeIndices[0]
        if (mainEdge !== undefined) {
          this.graph.edgeR_turb[mainEdge] = (8 * 0.02 * 998.2 * lengthM) / (Math.PI * Math.PI * Math.pow(d, 5))
          this.graph.edgeR_lam[mainEdge] = (128 * 0.001 * lengthM) / (Math.PI * Math.pow(d, 4))
        }
        for (const eIdx of pipeEl.edgeIndices) {
          const toNode = this.graph.edgeTo[eIdx]!
          if (this.graph.nodeKind[toNode] === 1 && this.graph.nodeIsSupply[toNode] === 0) {
            this.graph.edgeR_turb[eIdx] = (0.35 * 1.7323e12) / Math.pow(Math.max(0.25, cmd.pipeId), 4)
          }
        }
      }
    }

    // 3. Valve command handling (open: number | boolean)
    const valveEl = elements.find((e) => e.kind === 'valve')
    if (valveEl && valveEl.edgeIndices.length > 0) {
      const eIdx = valveEl.edgeIndices[0]!
      const rawOpen = (cmd as Record<string, unknown>).open ?? (cmd as Record<string, unknown>)[valveEl.name]
      if (rawOpen !== undefined) {
        const factor = valveOpeningFactor(
          typeof rawOpen === 'object' && rawOpen !== null && 'open' in rawOpen
            ? (rawOpen as { open?: number | boolean }).open
            : (rawOpen as number | boolean),
          valveEl.characteristic,
        )
        this.graph.edgeOpen[eIdx] = factor
      }
    }

    // 4. Tank command handling (level: number)
    const tankEl = elements.find((e) => e.kind === 'tank')
    if (tankEl && typeof (cmd as Record<string, unknown>).level === 'number') {
      tankEl.level = Math.max(0, Math.min(tankEl.height ?? 10, (cmd as Record<string, unknown>).level as number))
    }
  }

  /** Advance the 1D hydraulic network by one physics step `dt` (seconds). */
  step(dt: number): void {
    if (this.graph.numNodes === 0) return
    this.simTime += dt

    // Set driving head H = H_shutoff * omega^2 for each pump
    for (const [partId, snap] of this.snapshots) {
      const elements = this.graph.elementsByPart.get(partId)
      if (!elements) continue
      const pumpEl = elements.find((e) => e.kind === 'pump')
      if (pumpEl && pumpEl.edgeIndices.length > 0) {
        const eIdx = pumpEl.edgeIndices[0]!
        const maxRpm = snap.pumpMaxRpm
        const omega = Math.min(2.0, snap.pumpRpm / Math.max(1, maxRpm))
        const pShutoff = snap.pumpMaxHeadPa * omega * omega
        this.graph.edgeH[eIdx] = pShutoff
      }
    }

    // Update tank levels and nozzle hydrostatic heads
    for (const el of this.graph.elements) {
      if (el.kind === 'tank' && el.area && el.height !== undefined && el.level !== undefined) {
        let netFlowIn = 0
        for (let i = 0; i < el.edgeIndices.length; i++) {
          const eIdx = el.edgeIndices[i]!
          const q = this.state.flow[eIdx]!
          netFlowIn -= q
        }
        const newLevel = Math.max(0, Math.min(el.height, el.level + (dt * netFlowIn) / el.area))
        el.level = newLevel

        const elevations = el.nozzleElevations ?? []
        for (let i = 0; i < el.edgeIndices.length; i++) {
          const eIdx = el.edgeIndices[i]!
          const z = elevations[i] ?? 0
          const hHead = Math.max(0, newLevel - z) * 998.2 * 9.80665
          this.graph.edgeH[eIdx] = hHead
        }
      }
    }

    stepFluidNetwork(this.graph, this.state, dt)

    // Build beginning-of-tick snapshots for next tick's script evaluation
    for (const [partId, snap] of this.snapshots) {
      const elements = this.graph.elementsByPart.get(partId)

      let maxPressurePa = 0
      let maxFlowM3S = 0
      let isSupplied = false

      const portsReading: Record<string, { pressure: number; temperature: number }> = {}
      const elementsReading: Record<string, { flow: number; velocity?: number; level?: number; volume?: number; opening?: number }> = {}
      const tapsReading: Record<string, { pressure: number; temperature: number; flow: number; connected: boolean }> = {}

      // Measure taps for this part (e.g. pressure transmitters, gauges)
      const partTaps = this.graph.tapsByPart.get(partId)
      if (partTaps) {
        for (const tap of partTaps) {
          const p = this.state.pressure[tap.nodeIdx] ?? 0
          if (p > maxPressurePa) maxPressurePa = p
          const compId = this.graph.nodeComponent[tap.nodeIdx]!
          if (compId >= 0 && this.isCompSupplied(compId)) {
            isSupplied = true
          }
          tapsReading[tap.name] = {
            pressure: paToPsi(p),
            temperature: 20,
            flow: 0,
            connected: true,
          }
        }
      }

      if (elements) {
        for (const el of elements) {
          let elFlow = 0
          for (const eIdx of el.edgeIndices) {
            const q = this.state.flow[eIdx]!
            if (Math.abs(q) > Math.abs(elFlow)) elFlow = q
            const u = this.graph.edgeFrom[eIdx]!
            const v = this.graph.edgeTo[eIdx]!
            if (this.state.pressure[u]! > maxPressurePa) maxPressurePa = this.state.pressure[u]!
            if (this.state.pressure[v]! > maxPressurePa) maxPressurePa = this.state.pressure[v]!

            const compId = this.graph.nodeComponent[u]!
            if (compId >= 0 && this.isCompSupplied(compId)) {
              isSupplied = true
            }
          }
          if (Math.abs(elFlow) > maxFlowM3S) maxFlowM3S = Math.abs(elFlow)

          if (el.kind === 'tank') {
            elementsReading[el.name] = {
              flow: elFlow,
              level: el.level,
              volume: el.area && el.level !== undefined ? el.level * el.area : undefined,
            }
          } else if (el.kind === 'valve') {
            const eIdx = el.edgeIndices[0]
            elementsReading[el.name] = {
              flow: elFlow,
              opening: eIdx !== undefined ? this.graph.edgeOpen[eIdx] : 1,
            }
          } else {
            elementsReading[el.name] = { flow: elFlow }
          }
        }
      }

      // Convert to legacy engineering units for backward compatibility
      let pressurePsi = paToPsi(maxPressurePa)
      let flowGpm = m3sToGpm(maxFlowM3S)

      // Micro-jitter when active and pressurized/flowing
      if (pressurePsi > 0.05 && isSupplied) {
        const phi = partPhase(partId)
        const np = turbulentNoise(this.simTime, phi)
        pressurePsi = Math.max(0, pressurePsi * (1 + 0.008 * np))
      }
      if (flowGpm > 0.05 && isSupplied) {
        const phi = partPhase(partId)
        const nq = turbulentNoise(this.simTime + 0.37, phi + 1.2)
        flowGpm = Math.max(0, flowGpm * (1 + 0.0001 * nq))
      }

      if (pressurePsi < 1e-4) pressurePsi = 0
      if (flowGpm < 0.02) flowGpm = 0

      const velocityFtSec = (0.4085 * flowGpm) / 16 // based on 4-inch pipe

      snap.reading =
        pressurePsi === 0 && flowGpm === 0 && !isSupplied
          ? ZERO_FLUID_READING
          : Object.freeze({
              pressure: pressurePsi,
              flow: flowGpm,
              velocity: velocityFtSec,
              supplied: isSupplied,
              ports: portsReading,
              elements: elementsReading,
              taps: tapsReading,
            })
    }
  }

  private isCompSupplied(compId: number): boolean {
    const comp = this.graph.components[compId]
    if (!comp || !comp.hasSourceOrTank) return false
    for (const u of comp.nodeIndices) {
      if (this.graph.nodeIsSupply[u] === 1) {
        const start = this.graph.nodeEdgeStart[u]!
        const end = this.graph.nodeEdgeStart[u + 1]!
        for (let idx = start; idx < end; idx++) {
          const rawE = this.graph.nodeEdges[idx]!
          const e = rawE >= 0 ? rawE : ~rawE
          if (this.graph.edgeOpen[e]! > 0) return true
        }
      }
    }
    return false
  }
}
