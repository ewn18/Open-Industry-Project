# Fluid engine: a structure that scales (implementation plan)

This plan is for the agent that will restructure the 1D fluid engine added in commit `90e0eaf` ("added fluid engine
1.0", branch `fluid-dynamics`). It reviews what exists, sets a target architecture, and splits the work into phases,
each with acceptance checks. Read `AGENTS.md` before starting. Its layer rules, determinism rules and doc conventions
apply throughout.

## 0. Decisions already made (by the project owner)

| Question | Answer | Consequence for this plan |
|---|---|---|
| Has the fluid SDK surface (part-sdk level 14) shipped? | **No.** Reshape it freely. No migration. | Change `FluidSpec` / `FluidCommand` / `FluidReading` / `ctx.setFluid` / `ctx.fluid` in place. Re-record level 14 (see §6.3). |
| Next equipment | **Valves** (on/off, proportional, check), **tanks** with level, **sensors as their own parts**, **temperature / heat** | The solver must handle loops, one-way edges, storage nodes and a transported scalar (temperature). Sensors read the network without being a pump or pipe. |
| Target size | **About 2,000 fluid parts** in one scene (a whole plant) | No O(n²) work on any path, no per-tick allocation, no per-tick script for passive parts, and a solve cost of O(edges × a few iterations). |
| Who defines the physics | **Host primitives only.** Scripts send commands and read results. | Equipment is built by composing a closed set of host elements. Element physics never runs in the sandbox. |
| Fidelity | **A quick transient**, as now: pressure builds and decays in fractions of a second. No water hammer. | Quasi-steady edges (no flow inertia) plus node capacitance, stepped implicitly. |

## 1. What exists today

| File | Role |
|---|---|
| [fluidTopology.ts](../src/core/fluid/fluidTopology.ts) | Builds ports from `snap.chain` endpoints, pairs coincident ports into `neighbors`. Memoized with `memoizeByParticipants`. |
| [fluidNetwork.ts](../src/sim/fluidNetwork.ts) | Per-part state, the per-pump tree solver, first-order lag integration, turbulence noise, readings. |
| [fluidNetwork.test.ts](../src/sim/fluidNetwork.test.ts) | Test pump and pipe packages, plus 6 scenarios. These are the only pump/pipe definitions in the repo. |
| [world.ts](../src/sim/world.ts) | Owns `FluidNetwork`. Calls `syncScene` on load and on `updateScene`, `readingOf` per behavior, `applyCommand` after each behavior, and `step(dt)` at the end of `tickBehaviors`. Attaches a behavior to `drawn` fluid parts. |
| [embeddedBehavior.ts](../src/sim/embeddedBehavior.ts) | `ctx.setFluid` (validates and fills `out.fluid`) and `ctx.fluid` (copies the input reading). |
| `partPackage.ts`, `partApi.ts`, `partValidate.ts`, `validatePart.ts`, `snapConnectors.ts`, `snapFeatures.ts` | SDK types, validation, and `snap.chain` widened to `SnapChain \| SnapChain[]`. |

The engine works for one pump feeding a tree of pipes. Its structure blocks the stated goals in the ways below.

## 2. Review findings

### 2.1 Cost that grows with network size

1. **O(P²) port pairing.** `computeFluidTopologyUncached` compares every port with every other port. With 2,000 parts
   (~4,000+ ports) that is ~8M distance checks on every fluid edit, and the memo recomputes all of it whenever any one
   fluid part changes.
2. **The tick redoes topology work.** Each tick, `step()` repeats the BFS (`tracePipeTree`) per pump on both sides,
   `pathFromRoot` per open leaf, and in the capped case per discharge pipe. This is O(N · depth) per pump per tick, so
   O(N²) on a long line, even though the graph changes only on scene edits.
3. **Per-tick allocation.** Three `Map`s, `Set`s, path arrays and a frozen reading object per part per tick. At
   2,000 parts and 60–480 Hz this is GC pressure in the sim worker.
4. **A script per passive part.** A pipe needs a behavior that calls `ctx.setFluid` every tick just to restate its
   params. 2,000 pipes means 2,000 sandboxed script calls per step, and that cost will dwarf the solver.
   `world.ts` also only registers fluid on `drawn` and `rig` parts, through the behavior attach path.
5. **No partitioning.** Every pump is solved every tick, including networks that are off and settled. Nothing
   sleeps.

### 2.2 Extensibility: each new kind of equipment means editing the core

1. **Roles are hard-coded.** `'pump' | 'pipe'` appears in the SDK, the validator, the topology and the solver, and the
   solver's main loop is a role switch. A valve, tank or heater would mean changes to all of them.
2. **Physics lives in the solver, not in elements.** The pump curve, pipe friction, exit loss, "capped vs open" and
   "supply" are all inline in `step()`. There is no element interface for new equipment to implement.
3. **One flat command and reading bag.** `FluidCommand` holds every field of every role (`rpm`, `pipeId`, `openEnd`…),
   and `FluidReading` is one `pressure/flow/velocity` per *part*. A tank needs `level`, a valve needs `opening` and
   ΔP, a heat exchanger needs two streams, and a pump has distinct suction and discharge pressures. Each new element
   would grow the shared bag.
4. **Ports are inferred from `snap.chain`.** Side assignment uses role and chain count (`multiChainPump`). A 2-chain
   pump makes 4 ports, two of them on top of each other at the centre, and it only works because same-part ports are
   skipped. A tee, a 3-way valve or a tank with several nozzles cannot be expressed. It also forced
   `Plug.label` from the literal `'chain'` to `string` in `snapConnectors.ts`.
5. **Two sources of truth for static values.** `syncScene` reads hard-coded param names (`pipeId`, `length`,
   `fluidSupply`, `openEnd`, `maxRpm`, `gpmPerRpm`, `maxHeadPsi`) straight from part params, and the behavior also
   sends them through `setFluid` each tick. The fallback ports read a magic `params.length`. Validation is duplicated
   between `ctx.setFluid` and `applyCommand`.

### 2.3 Physics that will break with the planned equipment

1. **Trees only.** The BFS keeps one parent per pipe, so a loop or two branches that rejoin are silently cut.
2. **Several pumps on one network are wrong.** Each pump is solved alone, and the results are merged with
   `Math.max` (pressure) and `+` (flow). Pumps in series or parallel, or two pumps sharing a header, give meaningless
   numbers.
3. **Pressure belongs to a part, not a position.** A pipe has one pressure, and a pump reports only discharge
   pressure. Sensors as separate parts need pressure at a point (node).
4. **"Supply" is a pipe flag** that turns the whole pipe into an infinite source. Tanks and reservoirs need a real
   boundary element with a pressure that depends on level.
5. **The solver adds noise.** `turbulentNoise` is applied inside the solver's readings. Once sensors are their own
   parts, noise belongs to the sensor (its own script and `ctx` RNG). In the solver it hides exact steady states from
   tests.
6. **Mixed units and empirical constants.** PSI, GPM and inches are mixed with metres, and `PIPE_FRICTION_K` is called
   Darcy-Weisbach but is a fitted constant. A thermal model needs consistent units (density, specific heat).
7. **State is lost on a param edit.** A param edit rebuilds the part (`destroyPart` → `fluid.forget`), then
   `syncScene` creates fresh state with `rpm: 0` and zero pressure. With tanks this would empty a tank whenever
   someone touches the Inspector.

### 2.4 Hygiene in the commit

1. **Unrelated doc comments were shortened or removed** in `partApi.ts` (the `SnapSpec.flush` and `mounts`
   rationale, the `SnapChain` group, length and omit docs, the `edgeMount` note) and therefore in the generated SDK
   and schema. Restore them. `AGENTS.md` and the user rules require keeping unrelated comments.
2. **No design doc.** `AGENTS.md` expects a `docs/` page for each non-obvious system, and the part authoring guide
   must follow SDK capabilities.
3. **No first-party pump or pipe parts.** Only test fixtures exist. This is fine for now, but the test packages
   become the reference for the new SDK shape.

## 3. Target architecture

### 3.1 Principles

- **Closed set of host primitives, open set of equipment.** The solver knows only a few generic *edge* and *node*
  behaviours. Each element kind (pipe, pump, valve, tank…) is a small module in `core/fluid/elements/` that maps its
  declaration, params and commands onto those primitives. New equipment is either a new part that composes existing
  elements (no engine change) or, occasionally, one new element module plus one registry line.
- **Declarative first.** Static values come from the manifest, bound to params. A passive part (a pipe, an elbow, a
  tank with no PLC tags) needs **no behavior script**. Scripts exist only to send dynamic commands (pump speed, valve
  opening, heater power) and to write tags.
- **Compile once, step cheaply.** Topology and graph compilation run on scene edits. The tick only updates element
  coefficients from commands and runs the solver over typed arrays.
- **Pure, portable core.** Everything except the SimWorld adapter lives in `src/core/fluid/`: no DOM, three, Jolt or
  sim imports, and deterministic. That allows headless CLIs, project tests and a future editor overlay to share it.
  Today's solver is in `src/sim/` but imports nothing from Jolt, so moving it down follows "the lowest layer that can
  hold it".
- **SI inside.** Pa (gauge), m³/s, m, kg/m³, J/(kg·K), °C. Unit conversion happens only at the edges (in part
  scripts, or in sensor-part params such as `units: 'psi' | 'bar' | 'kPa'`).

### 3.2 Module layout

```
src/core/fluid/
  fluidTypes.ts        SDK-facing decl types re-exported by partPackage.ts (FluidSpec, FluidPortDecl, element decls,
                       FluidReading), plus internal graph types
  fluidUnits.ts        conversions (psi↔Pa, gpm↔m³/s, in↔m) and fluid property defaults (water)
  fluidBindings.ts     resolve a NumBinding / BoolBinding against resolved params
  fluidPorts.ts        ports of a part instance in world space (explicit `at` or a `chain` endpoint reference)
  fluidTopology.ts     spatial-hash port pairing → junctions (union-find), incremental per part ref
  fluidGraph.ts        compile parts + topology → FluidGraph (SoA typed arrays, CSR adjacency, components)
  fluidSolver.ts       pure step: (graph, state, dt) → state. Implicit nodal solve per awake component
  fluidThermal.ts      upwind scalar transport (temperature, later concentration) on the same graph
  fluidDiagnostics.ts  authoring problems (unconnected port, pump with no source) and run facts (dead-head, cavitation)
  elements/
    registry.ts        FLUID_ELEMENTS: kind → FluidElementModule
    pipe.ts  pump.ts  valve.ts  checkValve.ts  source.ts  outlet.ts  tank.ts  meter.ts  heater.ts  (by phase)
  *.test.ts, fluidSolver.bench.ts

src/sim/fluidNetwork.ts  thin SimWorld owner: holds FluidGraph + FluidState, applies commands, calls the core solver,
                         serves readings. No physics of its own.
```

```mermaid
flowchart LR
  subgraph core["src/core/fluid (pure)"]
    decl["Manifest fluid decl<br/>ports + elements + taps"] --> ports["fluidPorts"]
    ports --> topo["fluidTopology<br/>spatial hash + union-find"]
    topo --> graph["fluidGraph<br/>SoA arrays, components"]
    reg["elements/registry"] --> graph
    graph --> solver["fluidSolver<br/>implicit nodal"]
    solver --> thermal["fluidThermal"]
  end
  subgraph sim["src/sim"]
    net["FluidNetwork (adapter)"]
  end
  world["SimWorld.updateScene"] -->|"scene edit"| net
  net -->|"recompile on change"| graph
  beh["behaviors: ctx.setFluid"] -->|"commands"| net
  net -->|"each tick"| solver
  net -->|"readings snapshot"| ctx["ctx.fluid() / sensor taps"]
```

### 3.3 The element model (the extension point)

The solver works on a graph of **nodes** (junctions where ports meet, plus element-internal nodes) and **edges**
(flow paths between two nodes). Every element kind compiles into these primitives:

**Node primitives**
- `free`: pressure is solved and capacitance `C` comes from attached volume.
- `fixed`: pressure is set for this tick. Used for a source, atmosphere, or a tank's bottom (ρ·g·h). An element can
  update it every tick.

**Edge primitive.** One generalised resistive edge, ΔP = Pᵢ − Pⱼ:

$$\Delta P + H(\omega) = r\,Q + R\,Q|Q|$$

with fields `r` (laminar term, which also keeps the system regular near Q = 0), `R` (turbulent term), `H` (head gain;
non-zero for pumps), `open` ∈ [0, 1] (0 makes the edge fully closed, g = 0), and `oneWay` (check valve: closed when
Q would go negative). Pipe, pump, valve, check valve, orifice, outlet nozzle, inline meter and the hydraulic side of a
heat exchanger are all this edge with different coefficients.

```ts
// core/fluid/elements/registry.ts (shape, not final code)
export interface FluidElementModule<D extends FluidElementDecl = FluidElementDecl, C = unknown, X = unknown> {
  kind: D['kind']
  /** structural checks for partValidate (port names exist, bindings name params of the right type) */
  validate(decl: D, ctx: ElementValidateCtx): PackageProblem[]
  /** emit nodes/edges once per compile; return an opaque per-element slot record */
  compile(decl: D, params: ResolvedParams, emit: GraphEmitter): ElementSlots
  /** sanitise a script command (the single place commands are validated) */
  parseCommand?(raw: unknown): C | undefined
  /** per tick, before the solve: write edge coefficients / fixed pressures from params + last command */
  update(slots: ElementSlots, cmd: C | undefined, graph: FluidGraph, state: FluidState, dt: number): void
  /** per tick, after the solve: integrate element-owned state (tank level) */
  integrate?(slots: ElementSlots, graph: FluidGraph, state: FluidState, dt: number): void
  /** the element's entry in ctx.fluid().elements[name] */
  read(slots: ElementSlots, graph: FluidGraph, state: FluidState): X
}
```

The solver never branches on element kind. It sees only `r, R, H, open, oneWay` per edge and `free/fixed, C, Pfixed`
per node. Adding a kind adds one module and one registry entry. Adding a new *primitive* (rare) means changing the
solver, and that needs a design note in `docs/fluid-network.md`.

### 3.4 SDK shape (replaces level-14 `FluidSpec`)

```ts
/** a number, or a param binding: params[param] * (scale ?? 1) + (add ?? 0) */
type FluidNum = number | { param: string; scale?: number; add?: number }
type FluidBool = boolean | { param: string; not?: boolean }

interface FluidPortDecl {
  name: string                                  // 'suction', 'discharge', 'a', 'b', 'n1'
  at?: [number, number, number]                 // local position, or …
  atParams?: SnapParamOffset[]                  //   … param-driven shifts (same shape as snap)
  chain?: { index: number; end: 'start' | 'end' } // … reuse a snap.chain endpoint (no duplicate coordinates)
  dir?: [number, number, number]                // outward direction (later used for port-to-port snap mating)
}

type FluidElementDecl =
  | { kind: 'pipe';       name?: string; a: string; b: string; diameter: FluidNum; length?: FluidNum; roughness?: FluidNum }
  | { kind: 'pump';       name?: string; suction: string; discharge: string; ratedRpm: FluidNum; shutoffHead: FluidNum; ratedFlow: FluidNum; reverseFlow?: boolean }
  | { kind: 'valve';      name?: string; a: string; b: string; diameter: FluidNum; characteristic?: 'linear' | 'equalPercent' | 'quickOpen'; normallyOpen?: FluidBool }
  | { kind: 'checkValve'; name?: string; inlet: string; outlet: string; diameter: FluidNum; crackingPressure?: FluidNum }
  | { kind: 'source';     name?: string; port: string; pressure?: FluidNum; temperature?: FluidNum; enabled?: FluidBool; whenUnconnected?: boolean }
  | { kind: 'outlet';     name?: string; port: string; diameter: FluidNum; enabled?: FluidBool; whenUnconnected?: boolean }
  | { kind: 'tank';       name?: string; ports: { port: string; height: FluidNum }[]; area: FluidNum; height: FluidNum; initialLevel?: FluidNum; vented?: boolean }
  | { kind: 'meter';      name?: string; a: string; b: string; diameter: FluidNum }      // zero-loss inline sensor body
  | { kind: 'heater';     name?: string; a: string; b: string; diameter: FluidNum; maxPower: FluidNum } // phase 5

interface FluidTapDecl { name: string; at: [number, number, number]; reach?: number } // a sensor reading a nearby node

interface FluidSpec {
  ports?: FluidPortDecl[]
  elements?: FluidElementDecl[]
  /** internal junctions a composite part wires its elements through (names must not clash with ports) */
  nodes?: string[]
  taps?: FluidTapDecl[]
}
```

How today's test parts map onto it:

```ts
// pipe: no behavior needed unless it writes tags
fluid: {
  ports: [{ name: 'a', chain: { index: 0, end: 'start' } }, { name: 'b', chain: { index: 0, end: 'end' } }],
  elements: [
    { kind: 'pipe', a: 'a', b: 'b', diameter: { param: 'pipeId', scale: 0.0254 }, length: { param: 'length' } },
    { kind: 'source', port: 'a', enabled: { param: 'fluidSupply' }, whenUnconnected: true },
    { kind: 'outlet', port: 'b', diameter: { param: 'pipeId', scale: 0.0254 }, enabled: { param: 'openEnd' }, whenUnconnected: true },
  ],
}
// pump: behavior sends only the speed
fluid: {
  ports: [{ name: 'suction', at: [-0.5, 0, 0] }, { name: 'discharge', at: [0, 0.4, 0.3] }],
  elements: [{ kind: 'pump', name: 'pump', suction: 'suction', discharge: 'discharge',
               ratedRpm: { param: 'maxRpm' }, shutoffHead: { param: 'maxHeadPsi', scale: 6894.76 },
               ratedFlow: { param: 'ratedGpm', scale: 6.309e-5 } }],
}
```

> [!NOTE]
> Keep the existing semantics: `fluidSupply` makes an unconnected end a source, `openEnd` makes an unconnected end
> discharge freely, and an unconnected end with neither is capped. `whenUnconnected: true` disables a boundary element
> whenever its port meets another part's port, so a run of identical pipe parts only has boundaries at its real ends.
> Note that today `fluidSupply` makes the *whole pipe* a supply wherever it sits. Moving it to the unconnected end
> is an intentional, documented change.

**Script surface**

```ts
ctx.setFluid(element: string, cmd: Record<string, number | boolean>): void
//   pump:   { speed }       fraction 0..1 of ratedRpm (or { rpm })
//   valve:  { opening }     0..1
//   heater: { power }       0..1 of maxPower
//   each element module's parseCommand is the only validator; unknown keys are ignored
ctx.fluid(): FluidReading
interface FluidReading {
  ports: Record<string, { pressure: number; temperature: number }>   // Pa gauge, °C
  elements: Record<string, { flow: number; velocity?: number; level?: number; opening?: number; [k: string]: number | boolean | undefined }>
  taps: Record<string, { pressure: number; temperature: number; flow: number; connected: boolean }>
  supplied: boolean   // this part's component contains a source or tank
}
```

The element `name` defaults to its `kind` when a part has only one element of that kind. Validation requires unique
names.

### 3.5 Topology (`fluidTopology.ts`)

- **Spatial hash.** Quantise each world port position to an integer cell of size `FLUID_PORT_TOL` and key on
  `ix,iy,iz` (a string, or a packed number). To pair, look up the port's cell and its 26 neighbours and test the
  distance. The cost is O(P). Do not reuse `footprintGrid` (it is 2D by footprint disc); the hash is ~40 lines.
- **Junctions by union-find.** Every group of coincident ports becomes one junction node. Three or more ports in one
  spot is a legal tee, so a manifold works without a dedicated tee part. A real tee part is still a composite
  (3 ports and 3 short pipe elements to an internal node) when its geometry needs to be visible.
- **Incremental.** Keep `Map<partId, { ref: PartInstance; ports; cellKeys }>`. On sync, re-hash only parts whose ref
  or registry revision changed, plus removed ones. Recompute union-find and components from the hash (O(P), cheap).
  Rebuild the graph arrays only if the junction set or any element changed. Moving a non-fluid part costs nothing,
  and moving one pipe costs O(that pipe + rebuild), never O(P²).
- **Rotation.** Port world positions follow the existing part transform convention (`rotationY` only, `rotateXZ`).
- **Orientation is optional.** Pairing is positional. `dir` is stored for the later snap plug and for a diagnostic
  ("ports meet but face the same way").

### 3.6 Graph compile (`fluidGraph.ts`)

Compile into struct-of-arrays so the solver's hot loop allocates nothing:

```
nodes:  kind Uint8 (free/fixed) · C Float64 · Pfixed Float64 · component Int32 · volume Float64
edges:  from Int32 · to Int32 · r, R, H, open Float64 · oneWay Uint8 · element Int32
CSR:    nodeEdgeStart Int32[n+1] · nodeEdges Int32[] (signed: +k leaving, -k-1 entering)
components: list of node index ranges (nodes sorted by component), hasBoundary Uint8, awake Uint8
elements: kind, slots (indices into the arrays above), partId, name
```

- Node capacitance: `C = Σ(attached edge volume / 2) / K_eff`, where `K_eff` is an effective (tuned, soft) bulk
  modulus chosen so that the pressurisation time constants match today's (~0.04–1.5 s). Keep a minimum `C` so a
  zero-volume junction stays well-conditioned.
- Node and edge order is deterministic: parts in scene order, elements in declaration order. Never iterate a `Set` of
  ids to build arrays.
- Keep the previous `FluidState` across recompiles by mapping old node and edge *identities* (`partId/port`,
  `partId/element`) to the new indices, so edits never reset pressure, flow or tank level (fixes §2.3.7).

### 3.7 Solver (`fluidSolver.ts`): implicit nodal solve

Per awake component, per tick:

1. **Update.** Each element's `update` writes `r, R, H, open, oneWay` and the fixed pressures from params and its
   last command. This is O(elements).
2. **Linearise** every edge around the last flow (Picard step):
   `g_k = open_k / (r_k + R_k·|Q_k| + ε)`, and the edge carries `Q_k = g_k (Pᵢ − Pⱼ + H_k)`. For `oneWay` edges, if
   the last solve gave Q < 0, set `g_k = 0`.
3. **Continuity, implicit Euler** on free nodes:

   $$\left(\frac{C_i}{\Delta t} + \sum_k g_k\right) P_i - \sum_k g_k P_j = \frac{C_i}{\Delta t} P_i^{\text{old}} \pm \sum_k g_k H_k$$

   This is symmetric and strictly diagonally dominant (C > 0), so **Gauss–Seidel** warm-started from last tick's
   pressures converges in a few sweeps. Use a fixed cap (for example 16 sweeps) plus a residual tolerance, so the
   cost is bounded and deterministic. Fixed nodes are boundary terms.
4. **Flows.** Recompute `Q_k` from the new pressures, then run one optional extra Picard pass if `|ΔQ|/Q` is large
   (bounded, deterministic).
5. **Integrate** element state (`tank.level += ΣQ·dt / area`, clamped 0..height, with overflow and empty flags). It
   is explicit per tick and stable for any realistic tank area. The tank's fixed pressure follows next tick.
6. **Sleep.** If a component has no running pump, no open path with flow, and its max |ΔP| and |Q| are below
   thresholds, mark it asleep and skip it until a command, param or topology change touches it. This mirrors Jolt
   body sleeping.

Semantics to keep:
- **Supplied.** A component is supplied iff it contains a source or a tank with level > 0. Computed at compile time
  (and when a tank empties). An unsupplied component is skipped and reads zero, as today's starved pump does.
- **Pump curve.** `H = H₀·ω²`, `R_pump = H₀ / Q_rated²` (the same affine-in-Q² curve as today, now an edge
  property), `ω = rpm / ratedRpm`, with a default reverse-flow block (`oneWay`).
- **Capped discharge** pressurises to shutoff head and flow decays to 0. **Open discharge** settles where the pump
  curve meets the system curve. Both emerge from the same solve, with no special case.
- **Vacuum floor.** Clamp gauge pressure at −101,325 Pa. If a pump suction node sits below a vapour threshold, raise a
  `cavitating` reading and run fact.

Per-tick cost: O(Σ edges × sweeps) over awake components only. At 2,000 parts that is ~4k edges × 16 ≈ 64k
multiply-adds, well under 0.5 ms.

### 3.8 Thermal and scalar transport (`fluidThermal.ts`, phase 5)

- Each node holds `T` and a thermal mass `m·c = ρ·c·V_node`. After the hydraulic solve, an **upwind** update runs:
  each node mixes in the temperature of incoming flow (`ρ·c·Q·(T_up − T_i)`), plus element heat terms (`heater`: power
  × command; later `heatExchanger`: `UA·(T_a − T_b)` coupling two edges). Sources and tanks carry their own `T`.
- Implement it on a generic `scalars: Float64Array[]` channel so concentration or batch tracking can reuse it later
  without solver changes.
- Use explicit sub-steps with a CFL-style bound (`Σ Q_in·dt ≤ V_node`). If a step needs more than N sub-steps, use
  implicit upwind instead (the same Gauss–Seidel pattern).

### 3.9 Host integration (`src/sim/fluidNetwork.ts` and `world.ts`)

- `FluidNetwork` becomes an owned-state module in `SimWorld` (it already is; keep it a `readonly` field, as `AGENTS.md`
  requires). Public API: `syncScene(parts)`, `command(partId, element, raw)`, `readingOf(partId)`, `step(dt)`,
  `clear()`. Drop `forget()`: removing a part from the scene is handled by `syncScene`, so a rebuild never discards
  run state.
- **No behavior is needed for fluid participation.** Register fluid from the package declaration in `syncScene`,
  regardless of geometry kind. Attach a behavior only if the package has one, and do it through the existing paths.
  Remove the `drawn`-branch special case
  (`if (pkg.fluid && !this.attachJointBehavior(...))`) and replace it with the general rule that any part with a
  behavior gets it attached, if that rule doesn't already exist for drawn parts. Check this against how other drawn
  non-conveying parts with behaviors attach.
- Readings stay a **beginning-of-tick snapshot** (order-independent, as now). Reuse reading objects per part and
  mutate them in place between ticks. The behavior runtime already copies into the sandbox (`ctx.fluid()` builds a
  fresh object), so host objects never reach part code (the SES `hostCopy` rule).
- **Commands are sticky** (the last value holds until changed), so a pump script may send `speed` only on change.
  Document this.
- **Sensors as parts.** A sensor part declares `fluid.taps`. On compile, each tap attaches to the nearest junction
  node, or to the nearest pipe edge with interpolated pressure, within `reach`. Its reading appears under
  `ctx.fluid().taps[name]`, and `connected: false` when nothing is in reach. Inline meters (flow meter, inline
  transmitter) instead declare a `meter` element with two ports. Both cost nothing when unread.
- Drop `turbulentNoise` and `partPhase` from the solver. A transmitter part adds its own noise in its script (seeded
  `ctx` RNG; see `src/core/determinism.ts`).

## 4. Phases

Each phase ends green on `npm run typecheck`, `npm run lint` and `npm test`, and the last phase on `npm run check`.
Commit per phase.

### Phase 0: hygiene (small, do first)
- Restore the doc comments the commit shortened or removed in `src/core/parts/partApi.ts` (`SnapSpec.flush`,
  `mounts`, `surfaces`, `chain`, `edgeMount`; `SnapChain.group`, `lengthParam`, `start`, `end`, `omitStartParam`;
  the `SnapChain` block comment). Diff against `aee4ab0`. Keep only the wording actually needed for the
  `SnapChain | SnapChain[]` change. Regenerate the SDK with `npm run build-part-sdk`.
- Create `docs/fluid-network.md` (what the system is, how it works, and the element model). Fill it in as phases land.
  Link it from `AGENTS.md` "Where things live" next to the other design docs.

### Phase 1: core model, ports, topology, graph (pure, no behaviour change yet)
- Add `fluidTypes.ts`, `fluidUnits.ts`, `fluidBindings.ts`, `fluidPorts.ts`, the new `fluidTopology.ts` (spatial hash
  + union-find + incremental), `fluidGraph.ts`, and `elements/registry.ts` with `pipe`, `pump`, `source` and
  `outlet`.
- Tests: port extraction (explicit `at`, `atParams`, chain references, rotation); pairing equivalence against a
  brute-force reference on random scenes (the memo-equivalence pattern used elsewhere); tees with 3+ ports;
  incremental sync equals a full rebuild after random edit sequences; deterministic node and edge order.
- Bench: topology + compile for 2,000 parts. Target under 20 ms cold and under 2 ms for one moved part.

### Phase 2: solver
- `fluidSolver.ts` as in §3.7, with components, sleeping and supplied flags.
- Tests (in `src/core/fluid/`, SI units):
  - Pump against an open pipe: steady Q within 1% of the analytic intersection of the pump curve and the system curve.
  - Capped discharge pressurises to H₀·ω², and Q goes to 0. Halving speed quarters the head (today's 80 → 20 psi case).
  - Two pumps in parallel and in series on one header give the expected combined curve.
  - A loop (two branches that rejoin) splits flow by conductance and conserves mass at every node.
  - An unsupplied component reads zero. Starting and stopping relaxes within today's time constants.
  - The same input gives bit-identical output (determinism).
- Bench `fluidSolver.bench.ts`: 2,000 elements (a long line and a branched grid). Budget ≤ 0.5 ms per step. Add a
  loose floor test so a regression fails (never lower it to make a test pass, as with `scanSpeed.test.ts`).

### Phase 3: switch the host and SDK to the new model
- Rewrite `src/sim/fluidNetwork.ts` as the adapter in §3.9. Update `world.ts` (no `forget`, fluid registered without
  a behavior, attach rule cleaned up).
- Reshape the SDK (`partPackage.ts` types, `partApi.ts` `ctx.setFluid(element, cmd)` / `ctx.fluid()`), with
  `embeddedBehavior.ts` delegating command parsing to the element modules (one validator), `partValidate.ts`
  calling each module's `validate` (port names, unique element names, bindings naming params of the right type,
  following the `SNAP_PARAM_REFS` pattern), and `validatePart.ts` (keep the manifest-over-`definePart` precedence used
  for `snap` and `unit`).
- If chain endpoints are no longer the only port source, consider reverting `Plug.label` to literals
  (`'chain' | \`chain[${number}]\``) to keep the plug type tight.
- Port all 6 existing `fluidNetwork.test.ts` scenarios to the new packages (§3.4 mapping). Assertions change only for
  units and the removed noise. Delete the jitter test, or move it to a transmitter-part fixture.
- SDK level: level 14 was never released (decision §0). Remove the `"14"` entry from `packages/part-sdk/levels.json`,
  keep `PART_SDK_LEVEL = 14`, and run `npm run build-part-sdk` to re-record it. The script refuses to rewrite a
  recorded level, which is why the entry must be removed by hand first.
- Update `docs/part-authoring-guide.md` and `docs/custom-part-capability-surface.md` with the fluid declaration,
  commands and readings.

### Phase 4: valves, check valves, tanks, sensors
- Add the element modules `valve` (characteristics, `opening` command, `normallyOpen`), `checkValve`, `tank`
  (multiple nozzles at heights, level integration, vented, overflow and empty flags) and `meter`, plus `taps`.
- Tests: valve closing drops flow monotonically to 0. A check valve blocks reverse flow. Tank mass balance:
  ∫ΣQ dt = ΔV within 1e-9 relative. Draining a tank empties it and flips `supplied` downstream. Two tanks
  equalise levels through a pipe. A tap reads the nearest node and reports `connected: false` out of reach.
- Add fixture parts for a pressure transmitter, a flow meter and a level switch (sensor parts with tag params whose
  scripts convert units and add noise).

### Phase 5: temperature
- `fluidThermal.ts` and the `heater` element, `temperature` on sources and tanks, and `temperature` in readings.
- Tests: energy balance of a heater against `ρ·c·Q·ΔT`, two inflows mixing to the flow-weighted mean, and no drift
  in an isolated, insulated network.

### Phase 6 (optional, schedule separately): editor integration
- A **`port` snap plug** compiled from `fluid.ports` (position + `dir`, mating face to face, yaw solved). Pipes then
  stop borrowing the barrier `chain` snap (L-corners and omit-posts mean nothing to a pipe). Read
  `docs/part-snap-connectors.md` first.
- **Diagnostics.** Unconnected uncapped ports and pumps with no source go to `get_problems` / Problems. Dead-heading,
  cavitation and empty or overflowing tanks are flow facts (facts, never problems; see `AGENTS.md`). Consider a
  headless `check-fluid` CLI, documented in `docs/cli.md`.
- **Frame readings** for an Inspector or overlay: ship only changed element and port values, capped like display
  strings in `embeddedBehavior.ts`.

## 5. Constraints for the implementing agent

- **Layers.** `src/core/fluid/**` imports only from `src/core/**`. `src/sim/fluidNetwork.ts` may import core.
  ESLint enforces this; a lint error means a crossed layer.
- **Determinism.** No `Math.random`, no wall clock, no `Set` or `Map` iteration order that depends on insertion
  history across recompiles, and a fixed iteration cap in the solver. Do not name free globals in anything that
  could become generated code.
- **SES lockdown.** Intrinsics are frozen. Don't assign intrinsic-prototype property names, and `.fill()` typed or
  regular arrays before filling them in hot loops (`AGENTS.md` foot-guns).
- **No per-tick allocation** in `FluidNetwork.step` or the solver. Preallocate on compile.
- **Comments and docs** follow `AGENTS.md`: say what and why, briefly, with no history. Docs describe the system as it
  is. Delete this plan, or fold it into `docs/fluid-network.md`, once it is done.
- **Vendor boundary.** Use textbook hydraulics only (the pump affinity laws, Darcy-style losses, valve
  characteristics described generically). Do not copy any vendor process simulator's element names, curves or UI.
- **i18n.** Any new editor-visible string (diagnostics, Inspector labels) goes through `src/core/i18n.ts`.
- **Generated files.** `packages/part-sdk/*` is generated by `npm run build-part-sdk`. Never hand-edit it
  (`levels.json` entry removal in phase 3 is the one sanctioned exception).

## 6. Open items to settle while implementing (with defaults)

1. **Units in the SDK reading.** Default is SI (Pa gauge, m³/s, m, °C), with conversion in sensor parts through a
   `units` param. The alternative is engineering units in the reading. Pick SI unless the owner objects; it is what
   the thermal model needs.
2. **`fluidSupply` scope.** Default is that it applies at an unconnected end (`whenUnconnected`), as described in
   §3.4. If the owner wants "this whole pipe is a supply", use a `source` without `whenUnconnected`.
3. **Fill state.** Pipes are treated as always full when supplied. Modelling empty or partly filled lines (priming)
   is out of scope. Leave room for it as a node flag, not an edge field.
