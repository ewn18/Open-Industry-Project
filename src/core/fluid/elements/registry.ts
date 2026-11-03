// Fluid element registry and compilation interface.

import type { ParamValue } from '../../parts/partApi'
import type { FluidElementDecl } from '../fluidTypes'

export interface ElementSlots {
  nodeIndices: number[]
  edgeIndices: number[]
}

export interface GraphEmitter {
  /** Add an internal or boundary node. Returns the node index in the graph. */
  addNode(kind: 'free' | 'fixed', capacitance: number, fixedPressure?: number, isSupply?: boolean): number
  /** Add a hydraulic edge. Returns the edge index in the graph. */
  addEdge(
    fromNode: number,
    toNode: number,
    r: number,
    R: number,
    H?: number,
    open?: number,
    oneWay?: boolean,
  ): number
}

/** Interface implemented by each fluid element module. */
export interface FluidElementModule<D extends FluidElementDecl = FluidElementDecl, C = unknown> {
  readonly kind: D['kind']
  compile(
    decl: D,
    params: Readonly<Record<string, ParamValue>>,
    portNodes: ReadonlyMap<string, number>,
    isPortConnected: (portName: string) => boolean,
    emit: GraphEmitter,
  ): ElementSlots
  parseCommand?(raw: unknown): C | undefined
}

import { checkValveElementModule } from './checkValve'
import { heaterElementModule } from './heater'
import { outletElementModule } from './outlet'
import { pipeElementModule } from './pipe'
import { pumpElementModule } from './pump'
import { sourceElementModule } from './source'
import { tankElementModule } from './tank'
import { valveElementModule } from './valve'

const REGISTRY = new Map<string, FluidElementModule>()

export function registerFluidElement<D extends FluidElementDecl, C>(module: FluidElementModule<D, C>): void {
  REGISTRY.set(module.kind, module as unknown as FluidElementModule)
}

// Auto-register built-in elements
registerFluidElement(pipeElementModule)
registerFluidElement(pumpElementModule)
registerFluidElement(sourceElementModule)
registerFluidElement(outletElementModule)
registerFluidElement(valveElementModule)
registerFluidElement(checkValveElementModule)
registerFluidElement(tankElementModule)
registerFluidElement(heaterElementModule)

export function getFluidElementModule(kind: string): FluidElementModule | undefined {
  return REGISTRY.get(kind)
}
