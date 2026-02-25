#!/usr/bin/env python3
"""
Evaluate Blender analysis JSON against extracted MKA high-poly requirements.

Inputs:
  - JSON report from `blender_analyze_models.py`
  - Optional OCR text file (for reference path only)

Outputs:
  - compliance JSON
  - compliance markdown
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
from dataclasses import dataclass
from typing import Any, Dict, List, Sequence, Tuple


NAME_ALLOWED_RE = re.compile(r"^[A-Za-z0-9_]+$")


@dataclass
class CheckResult:
    check_id: str
    title: str
    source_line: str
    status: str  # pass | fail | unknown
    details: str

    def as_dict(self) -> Dict[str, Any]:
        return {
            "check_id": self.check_id,
            "title": self.title,
            "source_line": self.source_line,
            "status": self.status,
            "details": self.details,
        }


def _status_rollup(checks: Sequence[CheckResult]) -> str:
    statuses = {c.status for c in checks}
    if "fail" in statuses:
        return "fail"
    if "unknown" in statuses:
        return "warn"
    return "pass"


def _render_objects(scene: Dict[str, Any]) -> List[Dict[str, Any]]:
    objects = scene.get("objects") or []
    if not isinstance(objects, list):
        return []
    return [o for o in objects if not o.get("is_collision_proxy")]


def _check_no_hierarchy(scene: Dict[str, Any]) -> CheckResult:
    has_hierarchy = bool(((scene.get("geometry") or {}).get("has_hierarchy")))
    if has_hierarchy:
        return CheckResult(
            "GEO_08",
            "No object hierarchy/groups",
            "requirements_ocr:1519-1520",
            "fail",
            "Detected parent-child links in scene objects.",
        )
    return CheckResult(
        "GEO_08",
        "No object hierarchy/groups",
        "requirements_ocr:1519-1520",
        "pass",
        "No parent-child hierarchy detected.",
    )


def _check_no_modifiers(scene: Dict[str, Any]) -> CheckResult:
    objs = _render_objects(scene)
    with_modifiers = [o.get("name") for o in objs if o.get("modifiers")]
    if with_modifiers:
        return CheckResult(
            "GEO_11_MOD",
            "No additional modifiers",
            "requirements_ocr:1571",
            "fail",
            f"Render objects with modifiers: {', '.join(with_modifiers[:20])}",
        )
    return CheckResult(
        "GEO_11_MOD",
        "No additional modifiers",
        "requirements_ocr:1571",
        "pass",
        "No modifiers on render objects.",
    )


def _check_transforms_applied(scene: Dict[str, Any]) -> CheckResult:
    objs = _render_objects(scene)
    not_applied = [o.get("name") for o in objs if not o.get("transforms_applied")]
    if not_applied:
        return CheckResult(
            "GEO_18_TR",
            "Transforms applied (reset)",
            "requirements_ocr:1607-1608",
            "fail",
            f"Render objects with unapplied transforms: {', '.join(not_applied[:20])}",
        )
    return CheckResult(
        "GEO_18_TR",
        "Transforms applied (reset)",
        "requirements_ocr:1607-1608",
        "pass",
        "All render object transforms are applied.",
    )


def _check_triangulated(scene: Dict[str, Any]) -> CheckResult:
    objs = _render_objects(scene)
    non_triangulated = []
    for o in objs:
        triangles = int(o.get("triangles", 0))
        polygons = int(o.get("polygons", 0))
        if polygons <= 0:
            continue
        # For fully triangulated meshes, polygons == triangles.
        if polygons != triangles:
            non_triangulated.append((o.get("name"), polygons, triangles))

    if non_triangulated:
        sample = ", ".join(f"{name}(polys={p}, tris={t})" for name, p, t in non_triangulated[:10])
        return CheckResult(
            "GEO_17_TRI",
            "Mesh triangulated before FBX export",
            "requirements_ocr:1604-1605",
            "fail",
            f"Non-triangulated render meshes detected: {sample}",
        )
    return CheckResult(
        "GEO_17_TRI",
        "Mesh triangulated before FBX export",
        "requirements_ocr:1604-1605",
        "pass",
        "All render meshes are triangulated.",
    )


def _check_triangle_limit_okc(file_name: str, scene: Dict[str, Any]) -> CheckResult:
    if "ground" in file_name.lower():
        return CheckResult(
            "GEO_09_TRILIM",
            "Triangle limit for OKC <= 1,000,000 (excluding collisions)",
            "requirements_ocr:1522-1525",
            "unknown",
            "Not evaluated for Ground file (separate благоустройство limit depends on area).",
        )

    render_tris = int(scene.get("triangles_render_meshes", 0))
    if render_tris > 1_000_000:
        return CheckResult(
            "GEO_09_TRILIM",
            "Triangle limit for OKC <= 1,000,000 (excluding collisions)",
            "requirements_ocr:1522-1525",
            "fail",
            f"Render triangles: {render_tris} > 1,000,000.",
        )
    return CheckResult(
        "GEO_09_TRILIM",
        "Triangle limit for OKC <= 1,000,000 (excluding collisions)",
        "requirements_ocr:1522-1525",
        "pass",
        f"Render triangles: {render_tris}.",
    )


def _check_glass_separate(file_name: str, scene: Dict[str, Any]) -> CheckResult:
    if file_name.lower().endswith("_light.fbx"):
        return CheckResult(
            "GEO_04_GLASS_OBJ",
            "Glass geometry separated from facade geometry",
            "requirements_ocr:1501-1503,1842-1846",
            "unknown",
            "Lighting FBX contains no geometry objects.",
        )

    glass_mats = scene.get("glass_materials") or []
    separate = bool(scene.get("separate_glass_meshes"))
    if glass_mats and not separate:
        return CheckResult(
            "GEO_04_GLASS_OBJ",
            "Glass geometry separated from facade geometry",
            "requirements_ocr:1501-1503,1842-1846",
            "fail",
            "Glass-like materials exist, but no separate glass mesh object detected.",
        )
    return CheckResult(
        "GEO_04_GLASS_OBJ",
        "Glass geometry separated from facade geometry",
        "requirements_ocr:1501-1503,1842-1846",
        "pass",
        "Separate glass mesh detection is consistent with material assignment.",
    )


def _check_no_extra_nonmesh(file_name: str, scene: Dict[str, Any]) -> CheckResult:
    non_mesh = int(scene.get("non_mesh_objects", 0))
    if file_name.lower().endswith("_light.fbx"):
        return CheckResult(
            "SCN_01_EXTRAS",
            "No extra non-geometry objects in geometry FBX",
            "requirements_ocr:1481-1489",
            "pass",
            "Lighting FBX intentionally contains lights/empty objects.",
        )
    if non_mesh > 0:
        return CheckResult(
            "SCN_01_EXTRAS",
            "No extra non-geometry objects in geometry FBX",
            "requirements_ocr:1481-1489",
            "fail",
            f"Found non-mesh objects count={non_mesh}.",
        )
    return CheckResult(
        "SCN_01_EXTRAS",
        "No extra non-geometry objects in geometry FBX",
        "requirements_ocr:1481-1489",
        "pass",
        "No extra non-mesh scene objects.",
    )


def _check_allowed_materials(scene: Dict[str, Any]) -> CheckResult:
    mats = scene.get("materials") or []
    bad = []
    for m in mats:
        if m.get("has_node_graph") and not m.get("uses_principled"):
            bad.append(m.get("name"))
    if bad:
        return CheckResult(
            "MAT_01_TYPES",
            "Only Standard/Physical/Principled shaders",
            "requirements_ocr:1616-1621",
            "fail",
            f"Materials outside allowed shader set: {', '.join(bad[:20])}",
        )
    return CheckResult(
        "MAT_01_TYPES",
        "Only Standard/Physical/Principled shaders",
        "requirements_ocr:1616-1621",
        "pass",
        "All detected node materials use Principled or non-node defaults.",
    )


def _check_no_renderer_shaders(scene: Dict[str, Any]) -> CheckResult:
    mats = scene.get("materials") or []
    bad = []
    for m in mats:
        names = []
        if m.get("uses_renderer_nodes"):
            names.extend(m.get("uses_renderer_nodes"))
        if m.get("renderer_name_hits"):
            names.extend(m.get("renderer_name_hits"))
        if names:
            bad.append(f"{m.get('name')}: {','.join(names)}")
    if bad:
        return CheckResult(
            "MAT_02_RENDER",
            "No VRay/Octane/Corona/Arnold materials",
            "requirements_ocr:1629-1631",
            "fail",
            f"Renderer-specific traces: {'; '.join(bad[:20])}",
        )
    return CheckResult(
        "MAT_02_RENDER",
        "No VRay/Octane/Corona/Arnold materials",
        "requirements_ocr:1629-1631",
        "pass",
        "No renderer-specific shader traces detected.",
    )


def _check_materials_per_object(scene: Dict[str, Any]) -> CheckResult:
    objs = _render_objects(scene)
    bad = []
    for o in objs:
        used = o.get("materials_used") or []
        count = len([x for x in used if x.get("material_name")])
        if count > 7:
            bad.append(f"{o.get('name')}={count}")
    if bad:
        return CheckResult(
            "MAT_05_COUNT",
            "Max materials per geometry object <= 7",
            "requirements_ocr:1653-1655",
            "fail",
            f"Objects above limit: {', '.join(bad[:20])}",
        )
    return CheckResult(
        "MAT_05_COUNT",
        "Max materials per geometry object <= 7",
        "requirements_ocr:1653-1655",
        "pass",
        "All render objects are within 7 materials.",
    )


def _check_glass_without_textures(scene: Dict[str, Any]) -> CheckResult:
    mats = scene.get("materials") or []
    bad = []
    for m in mats:
        if not m.get("glass"):
            continue
        node_types = set(m.get("node_types") or [])
        if "ShaderNodeTexImage" in node_types:
            bad.append(m.get("name"))
    if bad:
        return CheckResult(
            "MAT_GLASS_TEX",
            "Glass material without texture maps",
            "requirements_ocr:1849-1851",
            "fail",
            f"Glass materials with image textures: {', '.join(bad[:20])}",
        )
    return CheckResult(
        "MAT_GLASS_TEX",
        "Glass material without texture maps",
        "requirements_ocr:1849-1851",
        "pass",
        "No image texture nodes detected in glass materials.",
    )


def _check_uv_one_channel(scene: Dict[str, Any]) -> CheckResult:
    objs = _render_objects(scene)
    bad = [f"{o.get('name')}={o.get('uv_layers_count')}" for o in objs if int(o.get("uv_layers_count", 0)) != 1]
    if bad:
        return CheckResult(
            "UV_01_CH",
            "Single UV channel per geometry",
            "requirements_ocr:1719,1756",
            "fail",
            f"Render objects with UV channel count != 1: {', '.join(bad[:20])}",
        )
    return CheckResult(
        "UV_01_CH",
        "Single UV channel per geometry",
        "requirements_ocr:1719,1756",
        "pass",
        "All render meshes have exactly one UV channel.",
    )


def _check_uv_present(scene: Dict[str, Any]) -> CheckResult:
    uv = scene.get("uv") or {}
    missing = uv.get("render_meshes_without_uv") or []
    if missing:
        return CheckResult(
            "UV_00_REQ",
            "Model contains UV unwrap",
            "requirements_ocr:1101-1110",
            "fail",
            f"Render meshes without UV: {', '.join(missing[:20])}",
        )
    return CheckResult(
        "UV_00_REQ",
        "Model contains UV unwrap",
        "requirements_ocr:1101-1110",
        "pass",
        "All render meshes contain UV data.",
    )


def _check_name_rules(file_name: str, scene: Dict[str, Any]) -> CheckResult:
    violations = []
    if len(file_name) > 254 or not NAME_ALLOWED_RE.match(os.path.splitext(file_name)[0].replace(".", "_")):
        violations.append(f"file:{file_name}")

    for obj in scene.get("objects") or []:
        n = obj.get("name") or ""
        if len(n) > 254 or not NAME_ALLOWED_RE.match(n):
            violations.append(f"obj:{n}")
            if len(violations) >= 20:
                break
    if len(violations) < 20:
        for m in scene.get("materials") or []:
            n = m.get("name") or ""
            if len(n) > 254 or not NAME_ALLOWED_RE.match(n):
                violations.append(f"mat:{n}")
                if len(violations) >= 20:
                    break

    if violations:
        return CheckResult(
            "NAME_01",
            "Names: latin/digits/_ and length <= 254",
            "requirements_ocr:1897-1906",
            "fail",
            f"Naming violations: {', '.join(violations)}",
        )
    return CheckResult(
        "NAME_01",
        "Names: latin/digits/_ and length <= 254",
        "requirements_ocr:1897-1906",
        "pass",
        "File/object/material names match allowed symbol set and length.",
    )


def _check_nonmesh_line(file_name: str, scene: Dict[str, Any]) -> CheckResult:
    # Keep this as soft informational check for dedicated light files.
    if file_name.lower().endswith("_light.fbx"):
        return CheckResult(
            "LIGHT_FILE",
            "Lighting file separated from geometry file",
            "requirements_ocr:1355-1356,2129-2133",
            "pass",
            "Detected dedicated lighting FBX.",
        )
    return CheckResult(
        "LIGHT_FILE",
        "Lighting file separated from geometry file",
        "requirements_ocr:1355-1356,2129-2133",
        "unknown",
        "Not a lighting-specific file.",
    )


def _check_unknown_items(scene: Dict[str, Any]) -> List[CheckResult]:
    # Items from PDF not covered by current analyzer output.
    return [
        CheckResult(
            "GEO_11_DUPSELF",
            "Duplicates/self-intersections <= 100 (0.002m)",
            "requirements_ocr:1562-1564",
            "unknown",
            "Current report has no robust count of duplicate/self-intersect elements within the required tolerance.",
        ),
        CheckResult(
            "GEO_11_ZERO",
            "No zero-length edges",
            "requirements_ocr:1567",
            "unknown",
            "Zero-length edge metric is not currently computed.",
        ),
        CheckResult(
            "GEO_11_ISOL",
            "No isolated vertices/edges/polygons",
            "requirements_ocr:1565",
            "unknown",
            "Only partial loose-edge metric exists; full isolated-vertex/polygon checks are not in current report.",
        ),
        CheckResult(
            "GEO_11_ANIM",
            "No animation keys",
            "requirements_ocr:1569",
            "unknown",
            "Animation key data is not extracted in current analyzer output.",
        ),
        CheckResult(
            "UV_UDIM_SEQ",
            "UDIM sequence starts at 1001 without gaps",
            "requirements_ocr:1727-1729",
            "unknown",
            "UDIM tile occupancy is not captured in current report.",
        ),
        CheckResult(
            "UV_GLASS_1001",
            "Glass UV restricted to tile 1001",
            "requirements_ocr:1748-1752",
            "unknown",
            "Per-island UV tile location is not captured in current report.",
        ),
        CheckResult(
            "UV_OVERLAP",
            "UV overlap constraint",
            "requirements_ocr:1731-1734",
            "unknown",
            "Automatic UV overlap quality check is not implemented in this pass.",
        ),
    ]


def evaluate_file(file_entry: Dict[str, Any]) -> Dict[str, Any]:
    name = file_entry.get("name", "")
    scene = file_entry.get("scene")
    if not isinstance(scene, dict):
        checks = [
            CheckResult(
                "FILE_STATUS",
                "File parsed successfully",
                "requirements_ocr:1241-1243",
                "fail",
                f"Analyzer status={file_entry.get('status')} error={file_entry.get('error')}",
            )
        ]
        return {"name": name, "status": "fail", "checks": [c.as_dict() for c in checks]}

    checks: List[CheckResult] = []
    checks.append(_check_no_hierarchy(scene))
    checks.append(_check_no_modifiers(scene))
    checks.append(_check_transforms_applied(scene))
    checks.append(_check_triangulated(scene))
    checks.append(_check_triangle_limit_okc(name, scene))
    checks.append(_check_glass_separate(name, scene))
    checks.append(_check_no_extra_nonmesh(name, scene))
    checks.append(_check_allowed_materials(scene))
    checks.append(_check_no_renderer_shaders(scene))
    checks.append(_check_materials_per_object(scene))
    checks.append(_check_glass_without_textures(scene))
    checks.append(_check_uv_one_channel(scene))
    checks.append(_check_uv_present(scene))
    checks.append(_check_name_rules(name, scene))
    checks.append(_check_nonmesh_line(name, scene))
    checks.extend(_check_unknown_items(scene))

    status = _status_rollup(checks)
    return {"name": name, "status": status, "checks": [c.as_dict() for c in checks]}


def _write_md(report: Dict[str, Any], out_path: str) -> None:
    lines: List[str] = []
    lines.append("# MKA High-Poly Compliance Report")
    lines.append("")
    lines.append(f"- Generated at: `{report['generated_at']}`")
    lines.append(f"- Source analysis: `{report['analysis_json']}`")
    if report.get("requirements_text"):
        lines.append(f"- Requirements OCR text: `{report['requirements_text']}`")
    lines.append("")
    lines.append("## Summary")
    lines.append("")
    lines.append("| File | Overall | Pass | Fail | Unknown |")
    lines.append("|---|---:|---:|---:|---:|")
    for f in report.get("files", []):
        checks = f.get("checks", [])
        p = sum(1 for c in checks if c.get("status") == "pass")
        fail = sum(1 for c in checks if c.get("status") == "fail")
        unk = sum(1 for c in checks if c.get("status") == "unknown")
        lines.append(f"| {f.get('name')} | {f.get('status')} | {p} | {fail} | {unk} |")

    lines.append("")
    lines.append("## Details")
    lines.append("")
    for f in report.get("files", []):
        lines.append(f"### {f.get('name')}")
        lines.append("")
        lines.append(f"- Overall: `{f.get('status')}`")
        for c in f.get("checks", []):
            lines.append(
                f"- `{c.get('status').upper()}` `{c.get('check_id')}` {c.get('title')} [{c.get('source_line')}]: {c.get('details')}"
            )
        lines.append("")

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines).rstrip() + "\n")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--analysis-json", required=True)
    parser.add_argument("--requirements-text")
    parser.add_argument("--output-json", required=True)
    parser.add_argument("--output-md", required=True)
    args = parser.parse_args()

    with open(args.analysis_json, "r", encoding="utf-8") as fh:
        analysis = json.load(fh)

    files_eval = [evaluate_file(f) for f in analysis.get("files", [])]
    summary = {
        "files_total": len(files_eval),
        "files_pass": sum(1 for f in files_eval if f.get("status") == "pass"),
        "files_warn": sum(1 for f in files_eval if f.get("status") == "warn"),
        "files_fail": sum(1 for f in files_eval if f.get("status") == "fail"),
    }

    report = {
        "generated_at": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        "analysis_json": os.path.abspath(args.analysis_json),
        "requirements_text": os.path.abspath(args.requirements_text) if args.requirements_text else None,
        "summary": summary,
        "files": files_eval,
    }

    os.makedirs(os.path.dirname(os.path.abspath(args.output_json)), exist_ok=True)
    with open(args.output_json, "w", encoding="utf-8") as fh:
        json.dump(report, fh, ensure_ascii=False, indent=2)

    _write_md(report, args.output_md)
    print(f"Wrote compliance JSON: {args.output_json}")
    print(f"Wrote compliance MD:   {args.output_md}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

