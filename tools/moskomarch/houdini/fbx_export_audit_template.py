#!/usr/bin/env python3
"""
Houdini 20.5 template: ROP FBX export + naming/material audit for MKA pipeline.

Expected SOP outputs in a GEO object:
  - OUT_MAIN
  - OUT_MAINGLASS
  - OUT_GROUND
  - OUT_UCX (optional)
  - OUT_LIGHT (optional)

Run with hython:
  hython tools/moskomarch/houdini/fbx_export_audit_template.py \
    --obj /obj/AGR_PIPE \
    --out-dir /path/to/exports \
    --address Avtozavodskaya_Vl_23_Uch_9
"""

from __future__ import annotations

import argparse
import json
import os
import re
from dataclasses import dataclass, asdict
from typing import Dict, List, Optional, Sequence, Set, Tuple


NAME_RE = re.compile(r"^[A-Za-z0-9_]{1,254}$")

OUTPUT_SPECS = {
    "main": ("OUT_MAIN", "SM_{address}.fbx"),
    "main_glass": ("OUT_MAINGLASS", "SM_{address}_MainGlass.fbx"),
    "ground": ("OUT_GROUND", "SM_{address}_Ground.fbx"),
    "ucx": ("OUT_UCX", "SM_{address}_UCX.fbx"),
    "light": ("OUT_LIGHT", "SM_{address}_Light.fbx"),
}


@dataclass
class AuditFinding:
    severity: str  # error | warning
    code: str
    message: str
    node: str


@dataclass
class ExportJob:
    key: str
    sop_path: str
    output_file: str
    rop_path: str
    exported: bool


def _require_hou():
    try:
        import hou  # type: ignore
    except Exception as exc:
        raise RuntimeError("This script must run inside Houdini (hython/python shell with hou).") from exc
    return hou


def _uv_to_udim(u: float, v: float) -> int:
    import math

    return 1001 + int(math.floor(u)) + int(math.floor(v)) * 10


def _collect_udim_tiles(geo, uv_attr_name: str = "uv") -> Set[int]:
    uv_vtx = geo.findVertexAttrib(uv_attr_name)
    uv_pt = geo.findPointAttrib(uv_attr_name)
    if uv_vtx is None and uv_pt is None:
        return set()
    tiles: Set[int] = set()
    for prim in geo.prims():
        for vtx in prim.vertices():
            uv = vtx.attribValue(uv_vtx) if uv_vtx else vtx.point().attribValue(uv_pt)
            tiles.add(_uv_to_udim(float(uv[0]), float(uv[1])))
    return tiles


def _check_udim_policy(key: str, geo, node_path: str) -> List[AuditFinding]:
    findings: List[AuditFinding] = []
    if key in ("ucx", "light"):
        return findings

    tiles = _collect_udim_tiles(geo, "uv")
    if not tiles:
        findings.append(AuditFinding("error", "UV_MISSING", "No UV tiles found (uv attribute missing or empty).", node_path))
        return findings

    if key == "main_glass":
        if tiles != {1001}:
            findings.append(
                AuditFinding(
                    "error",
                    "UDIM_GLASS_1001",
                    f"Glass branch requires only UDIM tile 1001, got {sorted(tiles)}",
                    node_path,
                )
            )
        return findings

    if 1001 not in tiles:
        findings.append(
            AuditFinding(
                "error",
                "UDIM_START_1001",
                f"UDIM sequence must start at 1001, got {sorted(tiles)}",
                node_path,
            )
        )
        return findings

    expected = set(range(1001, max(tiles) + 1))
    missing = sorted(expected - tiles)
    if missing:
        findings.append(
            AuditFinding(
                "error",
                "UDIM_GAPS",
                f"UDIM sequence has gaps: missing {missing}, existing {sorted(tiles)}",
                node_path,
            )
        )
    return findings


def _collect_string_attrib_values(geo, attrib_name: str) -> Set[str]:
    attrib = geo.findPrimAttrib(attrib_name)
    if attrib is None:
        return set()
    values = set()
    for prim in geo.prims():
        value = prim.attribValue(attrib)
        if value:
            values.add(str(value))
    return values


def _audit_branch(
    key: str,
    sop_node,
    allowed_mat_types: Set[str],
    max_materials: int,
) -> List[AuditFinding]:
    hou = _require_hou()
    findings: List[AuditFinding] = []
    geo = sop_node.geometry()
    node_path = sop_node.path()

    # Basic node naming.
    if not NAME_RE.match(sop_node.name()):
        findings.append(AuditFinding("error", "NAME_NODE", f"Invalid SOP node name: {sop_node.name()}", node_path))

    # Primitive "name" audit when available.
    name_attr = geo.findPrimAttrib("name")
    if name_attr is not None:
        for n in sorted(_collect_string_attrib_values(geo, "name")):
            if not NAME_RE.match(n):
                findings.append(AuditFinding("error", "NAME_PRIM", f"Invalid primitive name: {n}", node_path))

    # Material audit.
    mat_paths = sorted(_collect_string_attrib_values(geo, "shop_materialpath"))
    if key not in ("ucx", "light"):
        if not mat_paths:
            findings.append(AuditFinding("warning", "MAT_NONE", "No shop_materialpath assignments found.", node_path))
        if len(mat_paths) > max_materials:
            findings.append(
                AuditFinding(
                    "error",
                    "MAT_LIMIT",
                    f"Material count {len(mat_paths)} exceeds limit {max_materials}.",
                    node_path,
                )
            )

    for mat_path in mat_paths:
        mat_node = hou.node(mat_path)
        if mat_node is None:
            findings.append(AuditFinding("error", "MAT_PATH", f"Broken material path: {mat_path}", node_path))
            continue
        mat_name = mat_node.name()
        mat_type = mat_node.type().name()
        if not NAME_RE.match(mat_name):
            findings.append(AuditFinding("error", "NAME_MAT", f"Invalid material name: {mat_name}", node_path))

        is_allowed = mat_type in allowed_mat_types or "principled" in mat_type.lower()
        if not is_allowed:
            findings.append(
                AuditFinding(
                    "error",
                    "MAT_TYPE",
                    f"Material node type '{mat_type}' is outside allowed set.",
                    node_path,
                )
            )

    # Triangulation audit.
    non_tri = 0
    for prim in geo.prims():
        if prim.type().name() == "Polygon" and len(prim.vertices()) != 3:
            non_tri += 1
    if non_tri > 0 and key not in ("light",):
        findings.append(
            AuditFinding(
                "error",
                "TRIANGULATION",
                f"Found {non_tri} non-triangle polygon primitives.",
                node_path,
            )
        )

    # UDIM policy per branch.
    findings.extend(_check_udim_policy(key, geo, node_path))
    return findings


def _set_first_existing_parm(node, parm_names: Sequence[str], value) -> Optional[str]:
    for name in parm_names:
        parm = node.parm(name)
        if parm is not None:
            parm.set(value)
            return name
    return None


def _find_or_create_fbx_rop(hou, rop_name: str):
    out = hou.node("/out")
    if out is None:
        out = hou.node("/").createNode("out")

    node = out.node(rop_name)
    if node is not None:
        return node

    # Try known FBX ROP type names across builds.
    for type_name in ("filmboxfbx", "rop_fbx", "fbx"):
        try:
            return out.createNode(type_name, rop_name)
        except Exception:
            continue
    raise RuntimeError("Unable to create FBX ROP node. Expected type like 'filmboxfbx'.")


def _execute_rop(node) -> bool:
    # Try common execute buttons.
    for parm_name in ("execute", "render", "executebackground"):
        parm = node.parm(parm_name)
        if parm is not None:
            parm.pressButton()
            return True
    return False


def _configure_and_export_rop(
    hou,
    rop_node,
    sop_path: str,
    output_file: str,
    dry_run: bool,
) -> Tuple[bool, List[str]]:
    logs: List[str] = []

    sop_parm = _set_first_existing_parm(rop_node, ("startnode", "soppath", "sopoutputnode"), sop_path)
    out_parm = _set_first_existing_parm(rop_node, ("sopoutput", "output", "filename", "filepath"), output_file)

    if sop_parm is None:
        logs.append("Could not find SOP path parameter on FBX ROP node.")
    if out_parm is None:
        logs.append("Could not find output file parameter on FBX ROP node.")

    # Best-effort compatibility defaults.
    _set_first_existing_parm(rop_node, ("trange",), 0)  # current frame
    _set_first_existing_parm(rop_node, ("exportkind",), 0)

    if dry_run:
        logs.append("Dry run enabled, export not executed.")
        return False, logs

    ok = _execute_rop(rop_node)
    if not ok:
        logs.append("Failed to execute FBX ROP: no execute/render button found.")
    return ok, logs


def _collect_jobs(obj_node, address: str, out_dir: str) -> List[Tuple[str, object, str]]:
    jobs = []
    for key, (out_node_name, file_mask) in OUTPUT_SPECS.items():
        out_sop = obj_node.node(out_node_name)
        if out_sop is None:
            continue
        out_file = os.path.join(out_dir, file_mask.format(address=address))
        jobs.append((key, out_sop, out_file))
    return jobs


def run_export(
    obj_path: str,
    out_dir: str,
    address: str,
    allowed_material_types: Sequence[str],
    max_materials: int,
    dry_run: bool,
) -> Dict[str, object]:
    hou = _require_hou()
    obj_node = hou.node(obj_path)
    if obj_node is None:
        raise RuntimeError(f"Object node not found: {obj_path}")
    os.makedirs(out_dir, exist_ok=True)

    allowed_set = {x.strip() for x in allowed_material_types if x.strip()}
    jobs = _collect_jobs(obj_node, address, out_dir)
    if not jobs:
        raise RuntimeError(f"No output SOP nodes found under {obj_path}. Expected OUT_* nulls.")

    findings: List[AuditFinding] = []
    export_jobs: List[ExportJob] = []

    for key, sop_node, out_file in jobs:
        findings.extend(_audit_branch(key, sop_node, allowed_set, max_materials))

    has_errors = any(f.severity == "error" for f in findings)
    if has_errors:
        return {
            "success": False,
            "error": "Audit failed; export aborted.",
            "findings": [asdict(f) for f in findings],
            "jobs": [asdict(j) for j in export_jobs],
        }

    for key, sop_node, out_file in jobs:
        rop_name = f"ROP_FBX_{key.upper()}"
        rop_node = _find_or_create_fbx_rop(hou, rop_name)
        exported, logs = _configure_and_export_rop(hou, rop_node, sop_node.path(), out_file, dry_run)
        if logs:
            for msg in logs:
                findings.append(AuditFinding("warning", "ROP_LOG", f"{rop_name}: {msg}", rop_node.path()))
        export_jobs.append(
            ExportJob(
                key=key,
                sop_path=sop_node.path(),
                output_file=out_file,
                rop_path=rop_node.path(),
                exported=exported,
            )
        )

    return {
        "success": True,
        "findings": [asdict(f) for f in findings],
        "jobs": [asdict(j) for j in export_jobs],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--obj", required=True, help="Path to GEO object, e.g. /obj/AGR_PIPE")
    parser.add_argument("--out-dir", required=True, help="Directory for exported FBX files")
    parser.add_argument("--address", required=True, help="Address token used in file naming")
    parser.add_argument(
        "--allowed-material-types",
        default="principledshader::2.0,principledshader",
        help="Comma-separated Houdini material node type names",
    )
    parser.add_argument("--max-materials", type=int, default=7)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--audit-json", default="")
    args = parser.parse_args()

    result = run_export(
        obj_path=args.obj,
        out_dir=args.out_dir,
        address=args.address,
        allowed_material_types=[x.strip() for x in args.allowed_material_types.split(",")],
        max_materials=args.max_materials,
        dry_run=args.dry_run,
    )

    if args.audit_json:
        with open(args.audit_json, "w", encoding="utf-8") as fh:
            json.dump(result, fh, ensure_ascii=False, indent=2)

    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result.get("success") else 2


if __name__ == "__main__":
    raise SystemExit(main())

