# Houdini 20.5 MKA Pipeline Templates

This folder contains practical templates for building an AGR high-poly pipeline in Houdini 20.5 with UDIM:

- `HDA_NODE_GRAPH_SPEC.md` - exact SOP/HDA block design and recommended node parameters.
- `python_sop_udim_sequence_validator.py` - Python SOP script for UDIM checks (`1001..N` without gaps or `1001`-only mode for glass).
- `fbx_export_audit_template.py` - hython/shelf-ready exporter template with naming/material audits and ROP FBX execution.

## Quick Start

1. Create a geometry HDA and build the graph from `HDA_NODE_GRAPH_SPEC.md`.
2. Add a Python SOP in each UV branch and paste/import `python_sop_udim_sequence_validator.py`.
3. Build `/out` FBX ROP nodes and run `fbx_export_audit_template.py` before each export batch.

## Typical Use

Python SOP parameters:

- `mode`: `sequential` for `Main/Ground`, `single_1001` for `MainGlass/GroundGlass`.
- `fail_on_error`: `1` to raise an exception in cook if UDIM policy is violated.

hython export call (example):

```bash
hython tools/moskomarch/houdini/fbx_export_audit_template.py \
  --obj /obj/AGR_PIPE \
  --out-dir /path/to/exports \
  --address Avtozavodskaya_Vl_23_Uch_9
```

