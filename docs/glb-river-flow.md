# Animated river materials in GLB

The GLB importer optionally restores river-normal advection from
`material.extras.lpmview_water`. The ordinary glTF physical material remains a
static fallback in viewers without this feature. All asset data is contained
in the GLB; no shader source or external texture URL is executed or fetched.

Version 1 fields:

- `version`: `1`.
- `flowMap`: PNG data URI, at most 4 MiB of encoded text. Linear RG channels
  encode direction from -1 to 1; B is relative speed; A is phase offset.
- `origin`, `extent`: two numbers each, in source XY metres. Both extents must
  be positive. Image row zero corresponds to minimum source Y (`flipY=false`).
- `tileMeters`: positive normal-map period in metres.
- `cycleSeconds`: positive duration of an advection cycle.
- `metersPerSecond`: nonnegative reference speed.
- `speed`: multiplier, clamped to 0–30, defaults to 1.
- `specularColor`: optional linear RGB reflection tint, each component 0–2.

The normal texture must use metric UVs, exported from Blender as
`(sourceX / tileMeters, 1 - sourceY / tileMeters)`, with an identity texture
transform. Geometry and object transforms remain in their original frame;
only this water UV channel is prepared in source metres. World rebasing,
model translation and model rotation therefore do not detach the flow field.

WebGPU uses a physical node material; WebGL uses the physical material shader
hook. Both blend two advected normal samples half a cycle apart to hide reset
seams. This moves apparent surface ripples, not mesh vertices or a fluid
simulation. Reflection comes from the viewer environment.

Rendering uses the existing `requestRender()` owner and mesh render hook.
Hidden documents, detached roots, material display overrides and paused water
do not request animation frames. Disposal removes visibility listeners and
render hooks. `riverFlowMap` is registered as a material texture for normal
import cleanup, including aborted imports. GLB files without these extras use
the existing import path unchanged.

Validation: the viewer smoke suite imports a self-contained water GLB and
checks animation, pause, detachment, reflection values and single disposal of
the material/flow map. The full M8 export was also inspected in WebGPU and
WebGL. The viewer's generic scene re-export currently strips material extras;
retain the Blender-produced GLB as the reusable flow asset.
