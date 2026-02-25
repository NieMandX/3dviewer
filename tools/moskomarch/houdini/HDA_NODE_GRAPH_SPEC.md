# HDA Node Graph Spec (Houdini 20.5, MKA High-Poly + UDIM)

Asset name suggestion: `mka_agr_pipeline::1.0`

## 1. Object-Level Layout

Create one `geo` object container:

- `/obj/AGR_PIPE`

Inside the object, build one SOP network and expose only final controls as HDA parameters.

## 2. SOP Graph (Canonical Order)

Use this exact block order. Node names are recommended as-is for predictable automation.

1. `null` `IN_GEO`
2. `clean` `CLEAN_PRE`
3. `polydoctor` `PD_PRE`
4. `attribwrangle` `WR_CLASSIFY`
5. `split` `SPLIT_MAIN`
6. `split` `SPLIT_GLASS`
7. `split` `SPLIT_GROUND`
8. `split` `SPLIT_UCX`
9. Branch: `MAIN_BRANCH`
10. Branch: `GLASS_BRANCH`
11. Branch: `GROUND_BRANCH`
12. Branch: `UCX_BRANCH`
13. `null` outputs: `OUT_MAIN`, `OUT_MAINGLASS`, `OUT_GROUND`, `OUT_UCX`
14. Optional merge view: `merge` `OUT_VIEW_ALL`

## 3. Core Node Settings

## `CLEAN_PRE` (Clean SOP)

- Remove Degenerate Primitives: `on`
- Remove Unused Points: `on`
- Consolidate Points: `on`
- Fix Overlaps: `on` (if source is noisy)

## `PD_PRE` (PolyDoctor SOP)

- Enable checks:
  - Non-Manifold Edges
  - Self-Intersections
  - Open Faces
  - Degenerate Prims
  - Zero-Area Prims
- Auto-Fix: `conservative` (do not over-fuse architectural edges)

## `WR_CLASSIFY` (Attribute Wrangle, Run Over Primitives)

Create a primitive string attribute `part_class` for routing:

```c
string n = tolower(s@name);
string m = tolower(s@shop_materialpath);
if (match("*ucx_*", n)) s@part_class = "ucx";
else if (match("*ground*", n) || match("*ground*", m)) s@part_class = "ground";
else if (match("*glass*", n) || match("*glass*", m) || match("*window*", n)) s@part_class = "glass";
else s@part_class = "main";
```

## Split rules

- `SPLIT_MAIN`: keep `@part_class=main`
- `SPLIT_GLASS`: keep `@part_class=glass`
- `SPLIT_GROUND`: keep `@part_class=ground`
- `SPLIT_UCX`: keep `@part_class=ucx`

## 4. Branch Design

## `MAIN_BRANCH`

1. `clean` `CLEAN_MAIN`
2. `normal` `N_MAIN` (cusp angle from HDA parm, default `60`)
3. `uvflatten` `UVF_MAIN`
4. `uvlayout` `UVL_MAIN`
5. `python` `PY_UDIM_MAIN`
6. `attribwrangle` `WR_NAME_MAIN`
7. `material` `MAT_MAIN`
8. `divide` `TRI_MAIN` (Compute Dual off, Triangulate Non-Planar on)
9. `null` `OUT_MAIN`

`UVL_MAIN`:

- Pack into UDIM: `on`
- Normalize Islands: `on`
- Scale to Match Density: `on`
- Start tile: `1001`

`PY_UDIM_MAIN`:

- `mode = sequential`
- `fail_on_error = 1`

## `GLASS_BRANCH`

1. `clean` `CLEAN_GLASS`
2. `normal` `N_GLASS`
3. `uvflatten` `UVF_GLASS`
4. `uvlayout` `UVL_GLASS`
5. `python` `PY_UDIM_GLASS`
6. `attribwrangle` `WR_NAME_GLASS`
7. `material` `MAT_GLASS`
8. `divide` `TRI_GLASS`
9. `null` `OUT_MAINGLASS`

`UVL_GLASS`:

- Pack to single tile `1001` only (0-1 UV space)
- Overlap allowed for repeated parts

`PY_UDIM_GLASS`:

- `mode = single_1001`
- `fail_on_error = 1`

## `GROUND_BRANCH`

1. `clean` `CLEAN_GROUND`
2. `normal` `N_GROUND`
3. `uvflatten` `UVF_GROUND`
4. `uvlayout` `UVL_GROUND`
5. `python` `PY_UDIM_GROUND`
6. `attribwrangle` `WR_NAME_GROUND`
7. `material` `MAT_GROUND`
8. `divide` `TRI_GROUND`
9. `null` `OUT_GROUND`

`PY_UDIM_GROUND`:

- `mode = sequential`
- `fail_on_error = 1`

## `UCX_BRANCH`

1. `clean` `CLEAN_UCX`
2. `polydoctor` `PD_UCX` (closed/convex checks)
3. `attribwrangle` `WR_NAME_UCX`
4. `divide` `TRI_UCX`
5. `null` `OUT_UCX`

Policy:

- UCX meshes are closed convex hulls.
- No UV requirement.
- No material slots required.

## 5. Naming Wrangles

All names should match: `[A-Za-z0-9_]{1,254}`

Recommended object suffixes:

- Main: `_Main`
- Glass: `_MainGlass`
- Ground: `_Ground`
- UCX: `UCX_SM_*_Main_001` style

## 6. HDA Parameter Interface (Top Level)

Expose:

- `asset_address` (string)
- `cusp_angle` (float, default `60`)
- `udim_mode_main` (menu: `sequential`)
- `udim_mode_glass` (menu: `single_1001`)
- `udim_mode_ground` (menu: `sequential`)
- `fail_on_udim_error` (toggle)
- `auto_triangulate` (toggle)
- `run_polydoctor` (toggle)

## 7. Export Wiring

Do not export from intermediate nodes. Export only:

- `OUT_MAIN`
- `OUT_MAINGLASS`
- `OUT_GROUND`
- `OUT_UCX` (if needed per delivery)

Use `/out` `ROP FBX` nodes and execute `fbx_export_audit_template.py` before batch export.

