// Parameter binding resolution for fluid element and port declarations.

import type { ParamValue } from '../parts/partApi'
import type { FluidBool, FluidNum } from '../parts/partPackage'

export type { FluidBool, FluidNum }

/** Resolve a number binding against resolved part parameters. */
export function resolveFluidNum(
  binding: FluidNum | undefined,
  params: Readonly<Record<string, ParamValue>>,
  fallback = 0,
): number {
  if (binding === undefined) return fallback
  if (typeof binding === 'number') return Number.isFinite(binding) ? binding : fallback
  if (typeof binding === 'object' && binding !== null) {
    const v = params[binding.param]
    if (typeof v === 'number' && Number.isFinite(v)) {
      let result = v * (binding.scale ?? 1) + (binding.add ?? 0)
      if (binding.min !== undefined) result = Math.max(result, binding.min)
      if (binding.max !== undefined) result = Math.min(result, binding.max)
      return result
    }
  }
  return fallback
}

/** Resolve a boolean binding against resolved part parameters. */
export function resolveFluidBool(
  binding: FluidBool | undefined,
  params: Readonly<Record<string, ParamValue>>,
  fallback = false,
): boolean {
  if (binding === undefined) return fallback
  if (typeof binding === 'boolean') return binding
  if (typeof binding === 'object' && binding !== null) {
    const v = params[binding.param]
    if (typeof v === 'boolean') return binding.not ? !v : v
  }
  return fallback
}
