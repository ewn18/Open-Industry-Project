# Fluid properties and basic chemistry: implementation plan

This plan extends the existing 1D fluid network with source-defined liquid
properties and a deliberately small, scalable chemistry model. It is for the
agent implementing the work. Read [fluid-network.md](./fluid-network.md) and
`AGENTS.md` first; their layer, determinism, SI-unit, and performance rules
apply.

## 1. Goals and boundaries

The intent is to model enough process behavior to make basic water-treatment,
dairy, oil, wastewater, etc. lines useful. This is a bulk-flow model, not a
chemical process simulator.

The implementation should support:

- Liquid sources with configurable density and other basic bulk properties.
- Transport and mixing of named dissolved or suspended constituent
  concentrations.
- Simple, deterministic dosing and reaction operations that parts can declare
  and drive through the existing fluid command/reading surface.
- Useful sensor readings for the properties and concentrations.
- Networks with many parts while keeping per-tick work proportional to the
  number of active network nodes, edges, and chemical species.

It must not add:

- Multi-phase flow, settling, particle-size distributions, or phase changes.
- Full thermodynamic, pH/equilibrium, or biochemical models.
- Unbounded per-part species state, scripts for passive parts, or chemistry
  logic in the hydraulic pressure solver.
- A general-purpose reaction language or arbitrary user-supplied executable
  chemistry.

## 2. Current implementation to preserve and extend

- The hydraulic graph is compiled into struct-of-arrays in
  `src/core/fluid/fluidGraph.ts`; the deterministic per-component solver is in
  `src/core/fluid/fluidSolver.ts`.
- Declarative equipment modules live in `src/core/fluid/elements/`. The source
  element currently creates a pressure boundary; the tank and heater contain
  water-specific constants.
- Fluid declarations and the `FluidReading` / `FluidCommand` SDK contracts are
  in `src/core/parts/partPackage.ts`; bindings are resolved by
  `src/core/fluid/fluidBindings.ts`.
- `src/core/fluid/fluidThermal.ts` is a pure upwind transport helper that
  currently assumes water density and heat capacity. `src/sim/fluidNetwork.ts`
  does not currently step or publish that thermal state.
- `src/core/fluid/fluidGraph.ts` and `src/core/fluid/fluidSolver.ts` should
  remain concerned with hydraulic topology and pressure/flow. Chemistry and
  scalar transport belong in separate pure-core modules, coordinated by the
  existing `src/sim/fluidNetwork.ts` adapter.

The existing fluid network's pressure, flow, and connection behavior must
remain unchanged for projects that do not opt into non-default properties or
chemistry. Avoid a migration that changes the meaning of existing fluid
declarations.

## 3. Recommended model

### 3.1 Separate bulk properties from chemical constituents

Represent two related but distinct kinds of state:

1. **Bulk liquid properties**: density (kg/m³), dynamic viscosity (Pa·s), and
   specific heat capacity (J/(kg·K)). Source declarations provide defaults;
   omitted properties retain the current water-like defaults. These values
   describe the carrier liquid and are not themselves chemical species.
2. **Chemical species concentrations**: named quantities carried in the
   liquid, initially expressed as kg/m³. A species catalog defines each
   stable ID and display metadata. Do not use display names as simulation
   identifiers. Concentrations are non-negative and are transported with
   volumetric flow.

This separation prevents "density" from being confused with a dissolved
constituent and lets a source describe oil-like or dairy-like bulk liquid
without requiring a complete chemical composition model.

The first version should use a validated species catalog and compile only
species actually declared or referenced by the scene. The hot state should be
flat typed arrays indexed by compiled species ID, not a per-node object/map.
Use compile-time maps for name-to-index resolution only. Work and memory should
scale as O((nodes + edges) × active species), without creating one script or
object per passive part. Set and test a documented upper bound on active
species if measurements show one is needed; do not silently truncate species
or concentration data.

### 3.2 Source property contract

Extend the `source` element declaration with optional bindings for:

- `density`: kg/m³, defaulting to `WATER_DENSITY_KG_M3`.
- `viscosity`: Pa·s, defaulting to a documented water-like value.
- `specificHeat`: J/(kg·K), defaulting to the current water constant.
- `temperature`: °C, retaining water/ambient-compatible behavior when omitted.
- `composition`: a list/map of stable species IDs and source concentrations,
  using unambiguous units of kg/m³.

Use the existing `FluidNum` parameter-binding shape where practical. Validate
finite values and physically useful lower/upper bounds at manifest validation
and command boundaries. Invalid declarations must be reported through the
repository's normal validation errors; do not replace them with a silent
fallback. Keep defaults explicit so old projects behave as before.

Sources may continue to be fixed-pressure boundaries. Property/composition
values define the liquid entering from that boundary; they do not alter
pressure directly except through the hydraulic terms described below.

Tanks need both initial-content properties and runtime contents. Extend the
tank declaration with initial bulk properties and concentrations, defaulting
to the existing water behavior. Track tank property/species inventories as
part of its persistent state: inflows add mass and outflows remove it, so the
tank's reported mixture and hydrostatic head evolve as it fills and drains.
Do not treat a tank as a source whose configured composition is reapplied
every tick.

### 3.3 Property transport and hydraulic use

For each active component, the scalar transport step should advect density,
viscosity, specific heat, temperature, and species concentrations from the
upstream state, with source/tank boundaries supplying their declared values.
At a mixing node, calculate the mixed property from incoming volumetric
throughput, preserving the corresponding transported quantity. Keep scalar
transport separate from the pressure solve and use the same solved edge flow
for every channel.

Density must affect hydrostatic head. Replace water-only density in tank head
with the local stored liquid density (and preserve the existing result at the
default water density). Density also affects turbulent hydraulic loss terms
where the current equations use density. Viscosity should affect the laminar
loss term. Define precisely which density is used for an edge (recommended:
the current edge/upstream transported bulk property, with a deterministic
average for reverse flow and mixed endpoints), and avoid recomputing graph
topology for property changes.

Because hydraulic loss depends on the transported liquid, use a bounded,
deterministic coupling order:

1. Solve pressure and flow using the last available edge properties.
2. Advect/mix properties and chemistry using that flow.
3. Use the resulting properties in the next hydraulic step.

This one-tick coupling is intentional for the basic model. Do not introduce
an unbounded hydraulic/chemistry iteration. Document that a source-property
change may take one simulation step to affect downstream hydraulic resistance.

### 3.4 Chemistry and mixing

Implement a generic species transport kernel rather than species-specific
branches in `FluidNetwork`. Each species concentration is advected using the
same upwind direction and mixing logic as other scalar channels. At a junction,
the mixed concentration is the flow-weighted incoming concentration; a
no-flow node retains its value subject to explicitly configured reactions.
Boundaries take their source/tank concentration. Clamp only small
floating-point underflow to zero; invalid, non-finite, or materially negative
state must be surfaced as a diagnostic/test failure, not silently hidden.

Support two initial process operations:

- **Dosing**: an element adds one or more catalogued species at a declared
  mass rate (kg/s). A runtime command enables or scales dosing. Injection must
  be mass-conserving and bounded by the element's declared capacity. Do not
  support concentration-target control in v1.
- **Reaction**: a declarative, host-evaluated reaction maps reactant species
  to product species with stoichiometric coefficients and a simple rate law
  (initially first-order or a bounded fixed-rate conversion). Define rate units,
  limiting-reactant behavior, and maximum conversion per step before
  implementation. V1 reactions are temperature-independent. Use mass-based
  concentration and require the declared coefficients to balance represented
  mass; do not imply molar or pH-equilibrium chemistry. Do not run reaction
  callbacks or evaluate user code in the solver.

The v1 reaction engine should compile only the reactions used in the scene,
operate on species indices rather than repeated string lookups, and use a
bounded number of operations per node/element per tick. Reactions must conserve
the represented quantity according to their declared stoichiometry, remain
non-negative, and be deterministic for a fixed input and time step.

Do not claim to model pH, ionic strength, equilibrium, microbial growth, or
separation unless a later plan adds independently validated models for them.
In particular, acid/base neutralization should not be approximated as a pH
solver: it can be represented later as a documented stoichiometric reaction
only when its units and limits are clear.

### 3.5 Thermal transport

Refactor the existing thermal helper to consume the transported bulk density
and specific heat instead of a single hard-coded water constant. Preserve
energy accounting when streams with different bulk properties mix:
mix enthalpy by mass/heat-capacity flow, then derive output temperature.
Source temperatures must enter through fixed-boundary state.

Integrate thermal state in `src/sim/fluidNetwork.ts` after the hydraulic solve.
Keep heater power as an edge energy input and ensure the thermal implementation
uses the local `rho * Cp` and solved volumetric flow. Preserve default-water
results with regression tests. This is a prerequisite for reactions that opt
into temperature-dependent rate laws; temperature dependence itself can
remain out of v1 if not needed by the first equipment.

### 3.6 Parts, commands, and readings

Extend the existing fluid declaration and SDK contracts in place, keeping the
current command/read API. Use declarative element modules for chemistry
equipment; behavior scripts only set dynamic dosing/reaction controls or read
measurements.

Readings should expose only useful, stable outputs:

- Bulk properties and temperature at ports/taps.
- Concentrations for species that the part's declaration asks to observe.
- Optional reaction/dosing element readings such as actual rate, conversion,
  or limiting-reactant status.

Do not copy the full network's species vector into every part reading. Project
only the species requested by that part's taps or element declarations, and
reuse host-side reading storage where the existing adapter pattern permits.
Sandbox-facing values must continue to be copies, never mutable host arrays.

Update the authoring documentation and fluid type/manifest validation so units,
IDs, bounds, defaults, and supported command fields are clear. Keep localization
and schema-generation conventions in step with the SDK.

## 4. Implementation phases

Each phase should be independently reviewable and retain existing hydraulic
behavior. Run focused tests first, then `npm run typecheck`, `npm run lint`,
and `npm test` for the integrated change. Use existing build/check commands
when generated SDK files or schemas change.

### Phase 0: baseline and characterization

- Read the existing fluid design and test suites; record the current default
  water values and source/tank/heater behavior before changing them.
- Add or identify regression tests that prove a default-water source produces
  the same pressure/flow and thermal results.
- Confirm deterministic stepping and the established run/scene ownership rules
  for fluid state.

**Acceptance:** tests characterize default behavior and no unrelated hydraulic
semantics need to change to add property state.

### Phase 1: property state and source bindings

- Add source density, viscosity, specific heat, temperature, and composition
  declarations, plus tank initial-content property/composition declarations;
  update types, validation, and compiled element state.
- Add graph-aligned property state in pure `src/core/fluid/` modules; preserve
  source/tank property and species inventories across graph recompilation by
  stable node/element identity.
- Keep property updates out of the behavior loop for passive sources.

**Tests:** omitted fields use defaults; explicit constants and param bindings
resolve; invalid, non-finite, out-of-range, and unknown species declarations
fail clearly; tank initial contents survive graph recompilation; unchanged
project fixtures compile and behave as before.

### Phase 2: scalar and chemistry transport core

- Extract/reuse a pure upwind mixing kernel that accepts compiled scalar
  channels and uses existing hydraulic edge flows.
- Implement density/property mixing and species concentration transport with
  no per-tick object/map allocation.
- Define and test the behavior for zero flow, flow reversal, source boundaries,
  fixed tank boundaries, dead-end nodes, and graph recompilation.

**Tests:** two-source mixing matches the analytic flow-weighted result; species
mass balance across a junction is conserved within documented numerical
tolerance; a closed/stagnant loop retains state; reverse flow changes the
upstream sample correctly; stepping the same state is deterministic.

### Phase 3: hydraulics and thermal coupling

- Apply transported density to tank hydrostatic head and density-dependent
  hydraulic loss terms; apply viscosity to the laminar term with explicit
  unit-consistent formulas.
- Couple the property state to the hydraulic solver with the bounded
  one-step-lag order in §3.3.
- Refactor and integrate thermal state with source temperature, density,
  specific heat, and heater power.

**Tests:** default-water tests remain unchanged; non-water density changes tank
head by the expected ratio; viscosity changes laminar flow in the expected
direction; heated/mixed streams conserve energy; all outputs stay finite and
inside declared bounds. Verify a source-property change reaches hydraulics on
the documented next step.

### Phase 4: dosing and simple reactions

- Add validated declarative dosing and reaction element types/modules.
- Compile declarations to stable species indices and bounded runtime data.
- Parse commands through the existing element command parser; do not duplicate
  validation in the adapter.
- Publish only element-specific readings and requested species measurements.

**Tests:** dosing adds the declared mass over a known interval; zero/disabled
dosing adds none; rate/capacity bounds hold; a single-reactant reaction follows
its expected rate and cannot consume more than is present; multi-source mixing
and reaction conserve represented mass under the declared stoichiometry;
invalid commands/declarations fail through established validation paths.

### Phase 5: integration, scale, and documentation

- Add representative headless network fixtures for a water-treatment dose +
  reaction line, dairy-like fluid heating/mixing, oil-like density/viscosity,
  and wastewater-like constituent reduction. Keep them generic and do not
  imply detailed industrial accuracy.
- Benchmark scenes near the existing fluid target (about 2,000 fluid parts)
  with several active species and reactions.
- Document cost as a function of active nodes, edges, and species; set a
  measured budget and reject any per-tick work that scales with unrelated
  scene parts or all possible catalog species.
- Update `docs/fluid-network.md`, `docs/part-authoring-guide.md`, and any SDK
  schema/generation artifacts that the implementation changes.

**Acceptance:** targeted checks, typecheck, lint, and tests pass; no behavior
script is required for passive transport; performance remains within the
measured budget; source properties, chemistry readings, and supported limits
are described for part authors.

## 5. Required design decisions for the implementing agent

Resolve these in the code and documentation before implementing the relevant
phase; do not leave different modules to make independent choices:

1. Exact stable species ID syntax, catalog ownership, and catalog extension
   rules for project/custom parts.
2. Units and bounds for every source property, species concentration, dosing
   rate, stoichiometric coefficient, and reaction rate.
3. The v1 rate law and time integration strategy, including limiting-reactant
   handling and maximum conversion per step. Keep reactions
   temperature-independent in v1.
4. The hydraulic density/viscosity used at an edge when fluid properties vary
   along the edge or streams mix.
5. Species-count / reaction-count limits only if measured memory or step cost
   requires them; make such limits explicit validation errors.

## 6. Completion checklist

- [ ] Default fluid projects retain their current hydraulic behavior.
- [ ] Density is configurable on sources and participates in tank head and
  documented hydraulic loss terms.
- [ ] Temperature uses transported density and heat capacity and is stepped by
  the simulation adapter.
- [ ] Species are transported and mixed conservatively using compiled,
  bounded scalar state.
- [ ] Dosing and reactions are declarative, deterministic, host-evaluated, and
  covered by mass-balance tests.
- [ ] Readings expose requested measurements without copying every network
  species to every part.
- [ ] Type/manifest validation, generated SDK/schema surfaces, and authoring
  documentation match the implemented contract.
- [ ] Scale tests show cost proportional to active network size and active
  species, with no quadratic work or per-tick passive-part scripts.
- [ ] The fluid system documentation describes implemented behavior rather
  than planned behavior.
