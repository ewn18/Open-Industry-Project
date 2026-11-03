# Fluid parts

These small parts demonstrate every declarative element in the current fluid
engine. Connect ports by placing their world positions together; most parts
use a horizontal run along local X. Fluid geometry and element values use SI
units.

| Example | Element or feature |
|---|---|
| [pipe](./pipe/) | `pipe` |
| [pump](./pump/) | `pump`, with a behavior-driven speed command |
| [pressure-source](./pressure-source/) | `source` |
| [outlet](./outlet/) | `outlet` |
| [valve](./valve/) | `valve`, with a behavior-driven opening command |
| [check-valve](./check-valve/) | `checkValve` |
| [tank](./tank/) | `tank` |
| [flow-meter](./flow-meter/) | `meter` |
| [heater](./heater/) | `heater` |
| [pressure-tap](./pressure-tap/) | `taps` sensor feature |

The heater example declares the current `heater` element and its rated power.
The simulation adapter does not yet apply heater commands or step thermal
state, so it is a declaration example rather than a working heat source.

The static parts have no fluid-control behavior; their required part behavior
is a no-op. Hydraulic participation comes from the manifest declarations.
These examples use only implemented fluid features and do not include the
planned chemistry engine or liquid-source density properties.
