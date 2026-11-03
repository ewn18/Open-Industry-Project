// Fluid conversion factors and physical constants for SI 1D hydraulic modeling.

export const PSI_TO_PA = 6894.757293168
export const PA_TO_PSI = 1 / PSI_TO_PA

export const GPM_TO_M3_S = 0.0000630901964
export const M3_S_TO_GPM = 1 / GPM_TO_M3_S

export const IN_TO_M = 0.0254
export const M_TO_IN = 1 / IN_TO_M

/** Standard gravitational acceleration (m/s²). */
export const GRAVITY_M_S2 = 9.80665

/** Standard density of liquid water at ~20 °C (kg/m³). */
export const WATER_DENSITY_KG_M3 = 998.2

/** Specific heat capacity of liquid water (J / (kg·K)). */
export const WATER_SPECIFIC_HEAT_J_KG_K = 4184

/** Standard atmospheric pressure (Pa absolute). */
export const ATMOSPHERIC_PRESSURE_PA = 101325

export function psiToPa(psi: number): number {
  return psi * PSI_TO_PA
}

export function paToPsi(pa: number): number {
  return pa * PA_TO_PSI
}

export function gpmToM3S(gpm: number): number {
  return gpm * GPM_TO_M3_S
}

export function m3sToGpm(m3s: number): number {
  return m3s * M3_S_TO_GPM
}

export function inToM(inches: number): number {
  return inches * IN_TO_M
}

export function mToIn(m: number): number {
  return m * M_TO_IN
}
