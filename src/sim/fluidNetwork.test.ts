import { afterEach, describe, expect, it } from 'vitest'
import { PACKAGE_FORMAT, type PartPackage } from '../core/parts/partPackage'
import { clearPackages, registerPackage } from '../core/parts/partRegistry'
import { validatePartPackage } from '../core/parts/partValidate'
import type { SdkPart } from '../core/types'
import * as behavior from './embeddedBehavior'
import { FluidNetwork, ZERO_FLUID_READING } from './fluidNetwork'

function pumpPackage(): PartPackage {
  return {
    format: PACKAGE_FORMAT,
    id: 'test.pump',
    name: 'Test Centrifugal Pump',
    fluid: { role: 'pump' },
    snap: {
      // chain[0] = intake port at (-0.5, 0, 0); chain[1] = discharge port at (0, 0.4, 0.3)
      chain: [
        { group: 'piping', reach: 0.4, start: [-0.5, 0, 0], end: [0, 0, 0] },
        { group: 'piping', reach: 0.4, start: [0, 0, 0], end: [0, 0.4, 0.3] },
      ],
    },
    params: {
      maxRpm: { type: 'number', label: 'Max RPM (100%)', default: 1800, min: 100, max: 3600 },
      gpmPerRpm: { type: 'number', label: 'GPM per RPM', default: 0.1, min: 0.001, max: 10 },
      maxHeadPsi: { type: 'number', label: 'Max Shutoff Head (PSI)', default: 80, min: 1, max: 500 },
      startTag: { type: 'tag', label: 'Pump Start Command', default: '' },
      speedPctTag: { type: 'tag', label: 'Motor Speed Command (%)', default: '' },
      runningTag: { type: 'tag', label: 'Pump Running Feedback', default: '' },
      pressureTag: { type: 'tag', label: 'Discharge Pressure (PSI)', default: '' },
      flowTag: { type: 'tag', label: 'Pump Flow (GPM)', default: '' },
    },
    behavior: `definePart({
      fluid: { role: 'pump' },
      step(ctx) {
        const running = ctx.readTag(ctx.params.startTag)
        const speedPct = ctx.params.speedPctTag
          ? Math.max(0, Math.min(100, ctx.readNumber(ctx.params.speedPctTag)))
          : 100
        const rpm = running ? ctx.params.maxRpm * (speedPct / 100) : 0
        ctx.setFluid({
          rpm,
          maxRpm: ctx.params.maxRpm,
          gpmPerRpm: ctx.params.gpmPerRpm,
          maxHeadPsi: ctx.params.maxHeadPsi,
        })
        const { pressure, flow } = ctx.fluid()
        ctx.writeTag(ctx.params.runningTag, running)
        ctx.writeNumber(ctx.params.pressureTag, pressure)
        ctx.writeNumber(ctx.params.flowTag, flow)
      }
    })`,
    geometry: {
      kind: 'rig',
      links: [{ name: 'body', shape: { kind: 'box', size: [1, 1, 1] }, offset: [0, 0, 0] }],
      joints: [],
      bounds: { length: 1, width: 1, top: 1 },
    },
  }
}

function pipePackage(): PartPackage {
  return {
    format: PACKAGE_FORMAT,
    id: 'test.pipe',
    name: 'Test Pipe Section',
    fluid: { role: 'pipe' },
    snap: {
      chain: { group: 'piping', reach: 0.4, lengthParam: 'length', start: [0, 0, 0], end: [0, 0, 0] },
    },
    params: {
      length: { type: 'number', label: 'Length (m)', default: 2, min: 0.1, max: 20 },
      pipeId: { type: 'number', label: 'Pipe Inner Diameter (in)', default: 4, min: 0.5, max: 48 },
      fluidSupply: { type: 'boolean', label: 'Infinite Fluid Supply (Intake Source)', default: false },
      openEnd: { type: 'boolean', label: 'Unconnected End Open (Free Flow)', default: false },
      pressureTag: { type: 'tag', label: 'Pressure Transmitter (PSI)', default: '' },
      flowTag: { type: 'tag', label: 'Flow Meter (GPM)', default: '' },
    },
    behavior: `definePart({
      fluid: { role: 'pipe' },
      step(ctx) {
        ctx.setFluid({
          pipeId: ctx.params.pipeId,
          length: ctx.params.length,
          fluidSupply: ctx.params.fluidSupply,
          openEnd: ctx.params.openEnd,
        })
        const { pressure, flow } = ctx.fluid()
        ctx.writeNumber(ctx.params.pressureTag, pressure)
        ctx.writeNumber(ctx.params.flowTag, flow)
      }
    })`,
    geometry: {
      kind: 'rig',
      links: [{ name: 'tube', shape: { kind: 'box', size: [2, 0.2, 0.2] }, offset: [0, 0, 0] }],
      joints: [],
      bounds: { length: 2, width: 0.2, top: 0.2 },
    },
  }
}

function makePart(id: string, packageId: string, position: [number, number, number], params: Record<string, string | number | boolean>): SdkPart {
  return { id, type: 'part', packageId, position, rotationY: 0, params }
}

describe('FluidNetwork 1D hydraulic solver & PLC behavior integration', () => {
  afterEach(() => {
    clearPackages()
  })

  it('accepts fluid role and SnapChain[] declarations in validatePartPackage', () => {
    expect(validatePartPackage(pumpPackage())).toEqual([])
    expect(validatePartPackage(pipePackage())).toEqual([])
  })

  it('keeps a pump starved (0 PSI, 0 GPM) when the connected intake pipe has fluidSupply = false', () => {
    registerPackage(pumpPackage())
    registerPackage(pipePackage())

    // Intake pipe spans x = -2.5 .. -0.5, meeting pump intake port at (-0.5, 0, 0).
    // Discharge pipe spans x = 0 .. 2.0 at (y=0.4, z=0.3), meeting pump discharge port at (0, 0.4, 0.3).
    const intakePipe = makePart('pipe_in', 'test.pipe', [-1.5, 0, 0], { length: 2, pipeId: 4, fluidSupply: false, openEnd: false })
    const pump = makePart('pump_1', 'test.pump', [0, 0, 0], { maxRpm: 1800, gpmPerRpm: 0.1, maxHeadPsi: 80 })
    const dischargePipe = makePart('pipe_out', 'test.pipe', [1.0, 0.4, 0.3], { length: 2, pipeId: 4, fluidSupply: false, openEnd: true })

    const net = new FluidNetwork()
    net.syncScene([intakePipe, pump, dischargePipe])
    net.applyCommand('pipe_in', { pipeId: 4, length: 2, fluidSupply: false, openEnd: false })
    net.applyCommand('pump_1', { rpm: 1800, maxRpm: 1800, gpmPerRpm: 0.1, maxHeadPsi: 80 })
    net.applyCommand('pipe_out', { pipeId: 4, length: 2, fluidSupply: false, openEnd: true })

    for (let i = 0; i < 60; i++) net.step(1 / 60)

    expect(net.readingOf('pump_1')).toEqual(ZERO_FLUID_READING)
    expect(net.readingOf('pipe_out')).toEqual(ZERO_FLUID_READING)
  })

  it('pressurizes capped discharge pipes (openEnd = false) to shutoff head and settles flow to 0 GPM', () => {
    registerPackage(pumpPackage())
    registerPackage(pipePackage())

    const intakePipe = makePart('pipe_in', 'test.pipe', [-1.5, 0, 0], { length: 2, pipeId: 4, fluidSupply: true, openEnd: false })
    const pump = makePart('pump_1', 'test.pump', [0, 0, 0], {
      maxRpm: 1800,
      gpmPerRpm: 0.1,
      maxHeadPsi: 80,
      startTag: 'Pump_Start',
      speedPctTag: 'Pump_SpeedPct',
      runningTag: 'Pump_Running',
      pressureTag: 'Pump_PSI',
      flowTag: 'Pump_GPM',
    })
    const disPipe1 = makePart('pipe_d1', 'test.pipe', [1.0, 0.4, 0.3], {
      length: 2,
      pipeId: 4,
      fluidSupply: false,
      openEnd: false,
      pressureTag: 'Pipe1_PSI',
      flowTag: 'Pipe1_GPM',
    })
    const disPipe2 = makePart('pipe_d2', 'test.pipe', [3.0, 0.4, 0.3], {
      length: 2,
      pipeId: 4,
      fluidSupply: false,
      openEnd: false,
      pressureTag: 'Pipe2_PSI',
      flowTag: 'Pipe2_GPM',
    })

    const net = new FluidNetwork()
    net.syncScene([intakePipe, pump, disPipe1, disPipe2])

    const hIn = behavior.create(pipePackage().behavior, JSON.stringify(intakePipe.params))
    const hPump = behavior.create(pumpPackage().behavior, JSON.stringify(pump.params))
    const hD1 = behavior.create(pipePackage().behavior, JSON.stringify(disPipe1.params))
    const hD2 = behavior.create(pipePackage().behavior, JSON.stringify(disPipe2.params))

    const tags: Record<string, number | boolean> = { Pump_Start: true, Pump_SpeedPct: 100 }
    const stepAll = (dt: number) => {
      for (const [id, h] of [
        ['pipe_in', hIn],
        ['pump_1', hPump],
        ['pipe_d1', hD1],
        ['pipe_d2', hD2],
      ] as const) {
        const out = behavior.stepDirect(h, { simTime: 0, position: [0, 0, 0], forward: [1, 0, 0], tags, fluid: net.readingOf(id) }, dt)
        if (out?.fluid) net.applyCommand(id, out.fluid)
        if (out?.tags) Object.assign(tags, out.tags)
      }
      net.step(dt)
    }

    // Run 6 seconds at 60 Hz with 100% speed (1800 RPM -> 80 PSI shutoff head)
    for (let i = 0; i < 360; i++) stepAll(1 / 60)

    expect(tags.Pump_Running).toBe(true)
    expect(Number(tags.Pipe1_PSI)).toBeCloseTo(80, 0)
    expect(Number(tags.Pipe2_PSI)).toBeCloseTo(80, 0)
    expect(Number(tags.Pipe1_GPM)).toBeCloseTo(0, 1)
    expect(Number(tags.Pipe2_GPM)).toBeCloseTo(0, 1)

    // Drop speed command to 50% (900 RPM -> shutoff head scales by (0.5)^2 = 20 PSI)
    tags.Pump_SpeedPct = 50
    for (let i = 0; i < 360; i++) stepAll(1 / 60)

    expect(Number(tags.Pipe1_PSI)).toBeCloseTo(20, 0)
    expect(Number(tags.Pipe2_PSI)).toBeCloseTo(20, 0)

    behavior.destroy(hIn)
    behavior.destroy(hPump)
    behavior.destroy(hD1)
    behavior.destroy(hD2)
  })

  it('produces steady-state GPM and PSI when an unconnected discharge pipe has openEnd = true, scaling with pipeId', () => {
    registerPackage(pumpPackage())
    registerPackage(pipePackage())

    const intakePipe = makePart('pipe_in', 'test.pipe', [-1.5, 0, 0], { length: 2, pipeId: 4, fluidSupply: true, openEnd: false })
    const pump = makePart('pump_1', 'test.pump', [0, 0, 0], { maxRpm: 1800, gpmPerRpm: 0.1, maxHeadPsi: 80 })
    // disPipe1 has length 5 -> centered at x = 2.5 so its start is at x = 0 (meeting pump discharge) and end is at x = 5.0
    const disPipe1 = makePart('pipe_d1', 'test.pipe', [2.5, 0.4, 0.3], { length: 5, pipeId: 2, fluidSupply: false, openEnd: false })
    // disPipe2 has length 2 -> centered at x = 6.0 so its start is at x = 5.0 (meeting disPipe1) and end is at x = 7.0
    const disPipe2 = makePart('pipe_d2', 'test.pipe', [6.0, 0.4, 0.3], { length: 2, pipeId: 2, fluidSupply: false, openEnd: true })

    const net = new FluidNetwork()
    net.syncScene([intakePipe, pump, disPipe1, disPipe2])
    net.applyCommand('pipe_in', { pipeId: 4, length: 2, fluidSupply: true, openEnd: false })
    net.applyCommand('pump_1', { rpm: 1800, maxRpm: 1800, gpmPerRpm: 0.1, maxHeadPsi: 80 })
    net.applyCommand('pipe_d1', { pipeId: 2, length: 5, fluidSupply: false, openEnd: false })
    net.applyCommand('pipe_d2', { pipeId: 2, length: 2, fluidSupply: false, openEnd: true })

    for (let i = 0; i < 180; i++) net.step(1 / 60)

    const smallIdPump = net.readingOf('pump_1')!
    const smallIdPipe1 = net.readingOf('pipe_d1')!
    const smallIdPipe2 = net.readingOf('pipe_d2')!

    expect(smallIdPump.flow).toBeGreaterThan(10)
    expect(smallIdPump.flow).toBeLessThan(180)
    expect(smallIdPipe1.flow).toBeCloseTo(smallIdPump.flow, 1)
    expect(smallIdPipe2.flow).toBeCloseTo(smallIdPump.flow, 1)
    expect(smallIdPipe1.pressure).toBeGreaterThan(0)
    expect(smallIdPipe1.velocity).toBeGreaterThan(0)

    // Widening the discharge pipes from 2" ID to 6" ID lowers hydraulic resistance and increases GPM
    net.applyCommand('pipe_d1', { pipeId: 6, length: 5, fluidSupply: false, openEnd: false })
    net.applyCommand('pipe_d2', { pipeId: 6, length: 2, fluidSupply: false, openEnd: true })
    for (let i = 0; i < 180; i++) net.step(1 / 60)

    const largeIdPump = net.readingOf('pump_1')!
    expect(largeIdPump.flow).toBeGreaterThan(smallIdPump.flow)
  })

  it('transitions live from capped shutoff to open flow when openEnd is toggled', () => {
    registerPackage(pumpPackage())
    registerPackage(pipePackage())

    const intakePipe = makePart('pipe_in', 'test.pipe', [-1.5, 0, 0], { length: 2, pipeId: 4, fluidSupply: true, openEnd: false })
    const pump = makePart('pump_1', 'test.pump', [0, 0, 0], { maxRpm: 1800, gpmPerRpm: 0.1, maxHeadPsi: 80 })
    const disPipe = makePart('pipe_out', 'test.pipe', [1.0, 0.4, 0.3], { length: 2, pipeId: 4, fluidSupply: false, openEnd: false })

    const net = new FluidNetwork()
    net.syncScene([intakePipe, pump, disPipe])
    net.applyCommand('pipe_in', { pipeId: 4, length: 2, fluidSupply: true, openEnd: false })
    net.applyCommand('pump_1', { rpm: 1800, maxRpm: 1800, gpmPerRpm: 0.1, maxHeadPsi: 80 })
    net.applyCommand('pipe_out', { pipeId: 4, length: 2, fluidSupply: false, openEnd: false })

    for (let i = 0; i < 180; i++) net.step(1 / 60)
    expect(net.readingOf('pump_1')!.pressure).toBeCloseTo(80, 0)
    expect(net.readingOf('pump_1')!.flow).toBeCloseTo(0, 1)

    // Now open the pipe live
    net.applyCommand('pipe_out', { pipeId: 4, length: 2, fluidSupply: false, openEnd: true })
    for (let i = 0; i < 180; i++) net.step(1 / 60)

    const openPump = net.readingOf('pump_1')!
    const openPipe = net.readingOf('pipe_out')!
    expect(openPump.flow).toBeGreaterThan(100)
    expect(openPipe.flow).toBeCloseTo(openPump.flow, 0)
    expect(openPump.pressure).toBeGreaterThan(20)
    expect(openPipe.pressure).toBeGreaterThan(20)
  })

  it('generates realistic turbulent micro-jitter when running and zero noise when stopped', () => {
    registerPackage(pumpPackage())
    registerPackage(pipePackage())

    const intakePipe = makePart('pipe_in', 'test.pipe', [-1.5, 0, 0], { length: 2, pipeId: 4, fluidSupply: true, openEnd: false })
    const pump = makePart('pump_1', 'test.pump', [0, 0, 0], { maxRpm: 1800, gpmPerRpm: 0.1, maxHeadPsi: 80 })
    const disPipe = makePart('pipe_out', 'test.pipe', [1.0, 0.4, 0.3], { length: 2, pipeId: 4, fluidSupply: false, openEnd: true })

    const net = new FluidNetwork()
    net.syncScene([intakePipe, pump, disPipe])
    net.applyCommand('pipe_in', { pipeId: 4, length: 2, fluidSupply: true, openEnd: false })
    net.applyCommand('pump_1', { rpm: 1800, maxRpm: 1800, gpmPerRpm: 0.1, maxHeadPsi: 80 })
    net.applyCommand('pipe_out', { pipeId: 4, length: 2, fluidSupply: false, openEnd: true })

    // Let system reach steady-state
    for (let i = 0; i < 180; i++) net.step(1 / 60)

    // Sample consecutive ticks to confirm subtle micro-variation
    const samples: number[] = []
    for (let i = 0; i < 30; i++) {
      net.step(1 / 60)
      samples.push(net.readingOf('pump_1')!.pressure)
    }

    const minP = Math.min(...samples)
    const maxP = Math.max(...samples)
    expect(maxP).toBeGreaterThan(minP) // Proves non-static, realistic dynamic quiver
    expect(maxP - minP).toBeLessThan(1.5) // Proves variance is subtle (~0.5 - 1 PSI), not erratic

    // Turn pump off and verify noise cleanly settles to 0
    net.applyCommand('pump_1', { rpm: 0, maxRpm: 1800, gpmPerRpm: 0.1, maxHeadPsi: 80 })
    for (let i = 0; i < 240; i++) net.step(1 / 60)
    expect(net.readingOf('pump_1')!.pressure).toBe(0)
    expect(net.readingOf('pump_1')!.flow).toBe(0)
  })

  it('drains a tank through gravity head, tracking level integration and volume conservation', () => {
    const tankPackage: PartPackage = {
      format: PACKAGE_FORMAT,
      id: 'test.tank_grav',
      name: 'Gravity Drain Tank',
      fluid: {
        ports: [{ name: 'drain', at: [0, 0, 0] }],
        elements: [
          {
            kind: 'tank',
            name: 'storage',
            ports: [{ port: 'drain', height: 0 }],
            area: 1.0, // 1 m²
            height: 2.0, // 2 m
            initialLevel: 1.5, // 1.5 m
          },
        ],
      },
      params: {},
      behavior: '',
      geometry: {
        kind: 'rig',
        links: [{ name: 'body', shape: { kind: 'cylinder', radius: 0.5, height: 2 }, offset: [0, 0, 0] }],
        joints: [],
        bounds: { length: 1, width: 1, top: 2 },
      },
    }

    const drainPipePackage: PartPackage = {
      format: PACKAGE_FORMAT,
      id: 'test.drain_pipe',
      name: 'Drain Pipe',
      fluid: {
        ports: [
          { name: 'inlet', at: [0, 0, 0] },
          { name: 'outlet', at: [1, 0, 0] },
        ],
        elements: [
          {
            kind: 'pipe',
            name: 'p',
            a: 'inlet',
            b: 'outlet',
            diameter: 0.05,
            length: 1.0,
          },
          {
            kind: 'outlet',
            name: 'discharge',
            port: 'outlet',
            diameter: 0.05,
          },
        ],
      },
      params: {},
      behavior: '',
      geometry: {
        kind: 'rig',
        links: [{ name: 'tube', shape: { kind: 'box', size: [1, 0.1, 0.1] }, offset: [0, 0, 0] }],
        joints: [],
        bounds: { length: 1, width: 0.1, top: 0.1 },
      },
    }

    registerPackage(tankPackage)
    registerPackage(drainPipePackage)

    const tank = makePart('tank_1', 'test.tank_grav', [0, 0, 0], {})
    const pipe = makePart('pipe_1', 'test.drain_pipe', [0, 0, 0], {})

    const net = new FluidNetwork()
    net.syncScene([tank, pipe])

    // Initial reading
    const initRead = net.readingOf('tank_1')!
    expect(initRead.elements.storage?.level).toBe(1.5)

    // Run 60 ticks (1.0 second) of draining
    for (let i = 0; i < 60; i++) net.step(1 / 60)

    const drained = net.readingOf('tank_1')!
    const lvl = drained.elements.storage?.level ?? 0
    expect(lvl).toBeLessThan(1.5)
    expect(lvl).toBeGreaterThan(1.0)
    expect(drained.elements.storage?.volume).toBeCloseTo(lvl * 1.0, 3)
  })

  it('reads pressure from independent sensor parts equipped with fluid taps', () => {
    registerPackage(pumpPackage())
    registerPackage(pipePackage())

    const sensorPackage: PartPackage = {
      format: PACKAGE_FORMAT,
      id: 'test.gauge',
      name: 'Digital Pressure Gauge',
      fluid: {
        taps: [
          { name: 'tap_in', at: [0, 0, 0], reach: 0.1 },
        ],
      },
      params: {},
      behavior: '',
      geometry: {
        kind: 'rig',
        links: [{ name: 'body', shape: { kind: 'box', size: [0.1, 0.1, 0.1] }, offset: [0, 0, 0] }],
        joints: [],
        bounds: { length: 0.1, width: 0.1, top: 0.1 },
      },
    }
    registerPackage(sensorPackage)

    // Intake pipe -> Pump -> Capped discharge pipe
    const intakePipe = makePart('pipe_in', 'test.pipe', [-1.5, 0, 0], { length: 2, pipeId: 4, fluidSupply: true, openEnd: false })
    const pump = makePart('pump_1', 'test.pump', [0, 0, 0], { maxRpm: 1800, gpmPerRpm: 0.1, maxHeadPsi: 80 })
    const disPipe = makePart('pipe_d', 'test.pipe', [1.0, 0.4, 0.3], { length: 2, pipeId: 4, fluidSupply: false, openEnd: false })

    // Separate gauge placed exactly at pump discharge nozzle (0, 0.4, 0.3)
    const gauge = makePart('gauge_1', 'test.gauge', [0, 0.4, 0.3], {})

    const net = new FluidNetwork()
    net.syncScene([intakePipe, pump, disPipe, gauge])
    net.applyCommand('pipe_in', { pipeId: 4, length: 2, fluidSupply: true, openEnd: false })
    net.applyCommand('pump_1', { rpm: 1800, maxRpm: 1800, gpmPerRpm: 0.1, maxHeadPsi: 80 })
    net.applyCommand('pipe_d', { pipeId: 4, length: 2, fluidSupply: false, openEnd: false })

    // Run to shutoff pressure
    for (let i = 0; i < 180; i++) net.step(1 / 60)

    const gRead = net.readingOf('gauge_1')!
    expect(gRead.taps.tap_in).toBeDefined()
    expect(gRead.taps.tap_in?.connected).toBe(true)
    expect(gRead.taps.tap_in?.pressure).toBeCloseTo(80, 0)
    expect(gRead.pressure).toBeCloseTo(80, 0)
  })

  it('runs declarative pump and pipe with ctx.setFluid({ speed }) and fluidSupply', () => {
    const decPumpPkg: PartPackage = {
      format: PACKAGE_FORMAT,
      id: 'test.dec_pump',
      name: 'Declarative Pump',
      snap: {
        chain: [
          { group: 'piping', reach: 1.5, start: [-0.5, 0, 0], end: [-0.5, 0, 0] },
          { group: 'piping', reach: 1.5, start: [0.5, 0, 0], end: [0.5, 0, 0] },
        ],
      },
      fluid: {
        ports: [
          { name: 'suction', at: [-0.5, 0, 0] },
          { name: 'discharge', at: [0.5, 0, 0] },
        ],
        elements: [
          { kind: 'pump', name: 'pump', suction: 'suction', discharge: 'discharge', ratedRpm: 1750, shutoffHead: 550000, ratedFlow: 0.01 },
        ],
      },
      params: {},
      behavior: '',
      geometry: { kind: 'rig', links: [], joints: [], bounds: { length: 1, width: 0.5, top: 0.5 } },
    }

    const decPipePkg: PartPackage = {
      format: PACKAGE_FORMAT,
      id: 'test.dec_pipe',
      name: 'Declarative Pipe',
      snap: {
        chain: { group: 'piping', lengthParam: 'length', reach: 1.5 },
      },
      fluid: {
        ports: [
          { name: 'inlet', chain: { index: 0, end: 'start' } },
          { name: 'outlet', chain: { index: 0, end: 'end' } },
        ],
        elements: [
          { kind: 'pipe', name: 'tube', a: 'inlet', b: 'outlet', diameter: 0.05, length: { param: 'length' } },
        ],
      },
      params: {
        length: { type: 'number', label: 'Length', default: 2 },
      },
      behavior: '',
      geometry: { kind: 'rig', links: [], joints: [], bounds: { length: 2, width: 0.1, top: 0.1 } },
    }

    registerPackage(decPumpPkg)
    registerPackage(decPipePkg)

    // Intake pipe [-1.5, 0, 0] with length 2: inlet at -2.5, outlet at -0.5 (meets pump suction at -0.5)
    const inPipe = makePart('in_pipe', 'test.dec_pipe', [-1.5, 0, 0], { length: 2, fluidSupply: true, openEnd: false })
    // Pump at [0, 0, 0]: suction at -0.5, discharge at +0.5
    const pump = makePart('pump_dec', 'test.dec_pump', [0, 0, 0], {})
    // Discharge pipe [1.5, 0, 0] with length 2: inlet at +0.5 (meets pump discharge at +0.5), outlet at +2.5
    const outPipe = makePart('out_pipe', 'test.dec_pipe', [1.5, 0, 0], { length: 2, fluidSupply: false, openEnd: true })

    const net = new FluidNetwork()
    net.syncScene([inPipe, pump, outPipe])

    net.applyCommand('in_pipe', { fluidSupply: true, openEnd: false })
    net.applyCommand('pump_dec', { speed: 1.0 })
    net.applyCommand('out_pipe', { fluidSupply: false, openEnd: true })

    for (let i = 0; i < 120; i++) net.step(1 / 60)

    const pRead = net.readingOf('pump_dec')!
    expect(pRead.pressure).toBeGreaterThan(5) // Discharge pressure > 5 PSI
    expect(pRead.flow).toBeGreaterThan(10) // Flow > 10 GPM

    const outRead = net.readingOf('out_pipe')!
    expect(outRead.flow).toBeGreaterThan(10)
  })
})
