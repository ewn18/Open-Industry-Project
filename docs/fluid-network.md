# 1D Hydraulic Fluid Network

This document describes the design and architecture of the 1D lumped-parameter hydraulic fluid network in Open Industry Project.

## Principles

- **Closed set of host primitives, open set of equipment**: The solver works on generic graph primitives (nodes and resistive edges). Specific equipment types (pipes, pumps, valves, tanks, meters) are declarative element modules in `src/core/fluid/elements/` that map onto these primitives.
- **Declarative first**: Static parameters are bound to part parameters in the manifest. Passive parts (pipes, fittings) require no behavior script. Behavior scripts only run when actively driving dynamic setpoints (pump speed, valve position) or interacting with PLC tags.
- **Pure core**: All topology discovery, graph compilation, and numerical solving live in `src/core/fluid/` without DOM, three.js, or Jolt physics dependencies. The simulation worker simply steps the network alongside physics and behaviors.
- **SI internal units**: Internal state uses Pa (gauge), m³/s, m, kg/m³, and °C. Unit conversion happens only at sensor script boundaries or part parameters.
- **Quasi-steady flow with nodal capacitance**: Pressure transients (build-up, shutoff head, depressurization) are simulated via nodal fluid capacitance stepped with an implicit solver (Gauss-Seidel). Flow rate along edges responds instantaneously to pressure differences.

## Architecture

- **`src/core/fluid/fluidTopology.ts`**: Port extraction and world-space pairing via 3D spatial hashing (`FLUID_PORT_TOL = 0.05m`). Coincident ports merge into topological junctions using disjoint-set union (union-find).
- **`src/core/fluid/fluidGraph.ts`**: Compiles topological junctions and element declarations into a struct-of-arrays (SoA) graph representation with CSR adjacency and connected component partitioning.
- **`src/core/fluid/fluidSolver.ts`**: Implicit nodal pressure solver per connected component. Inactive components sleep automatically.
- **`src/core/fluid/elements/`**: Element definitions (`pipe`, `pump`, `valve`, `tank`, `source`, `outlet`, `meter`, `heater`).
- **`src/sim/fluidNetwork.ts`**: SimWorld adapter managing graph compilation on scene edits, applying behavior commands, and publishing beginning-of-tick readings to parts.
