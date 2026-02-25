#!/usr/bin/env python3
"""
Blender headless analyzer for FBX/BLEND files.

Run (macOS):
  /Applications/Blender.app/Contents/MacOS/Blender \\
    --background --factory-startup \\
    --python tools/moskomarch/blender_analyze_models.py -- \\
    --input-dir "/path/to/models" \\
    --output-json "/path/to/report.json" \\
    --output-md "/path/to/report.md"
"""

from __future__ import annotations

import argparse
import dataclasses
import datetime as _dt
import json
import os
import re
import sys
import time
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple


def _iso_now() -> str:
    return _dt.datetime.now().astimezone().isoformat(timespec="seconds")


def _safe_float_tuple(values: Sequence[float], digits: int = 6) -> List[float]:
    return [round(float(v), digits) for v in values]


def _near(a: float, b: float, eps: float = 1e-6) -> bool:
    return abs(a - b) <= eps


def _is_identity_transform(location, rotation_euler, scale, eps: float = 1e-6) -> bool:
    return (
        _near(location.x, 0.0, eps)
        and _near(location.y, 0.0, eps)
        and _near(location.z, 0.0, eps)
        and _near(rotation_euler.x, 0.0, eps)
        and _near(rotation_euler.y, 0.0, eps)
        and _near(rotation_euler.z, 0.0, eps)
        and _near(scale.x, 1.0, eps)
        and _near(scale.y, 1.0, eps)
        and _near(scale.z, 1.0, eps)
    )


GLASS_NAME_RE = re.compile(r"(glass|gls|window|windscreen|стек|окн)", re.IGNORECASE)
FACADE_RE = re.compile(r"(facade|fassade|fasad|фасад)", re.IGNORECASE)
ROOF_RE = re.compile(r"(roof|кров|крыш)", re.IGNORECASE)
GROUND_RE = re.compile(r"(ground|terrain|land|земл|грунт)", re.IGNORECASE)

RENDERER_RE = re.compile(r"(vray|v-ray|corona|arnold|redshift|octane)", re.IGNORECASE)
COLLISION_PREFIX_RE = re.compile(r"^(UCX|UBX|UCP|USP)_", re.IGNORECASE)


def _guess_role(name: str) -> List[str]:
    roles: List[str] = []
    if FACADE_RE.search(name):
        roles.append("facade")
    if ROOF_RE.search(name):
        roles.append("roof")
    if GROUND_RE.search(name):
        roles.append("ground")
    return roles


def _try_enable_addon(module: str) -> None:
    try:
        import addon_utils

        addon_utils.enable(module, default_set=True, persistent=False)
    except Exception:
        # Best effort; importer may already be available.
        return


def _reset_to_empty_scene() -> None:
    import bpy

    bpy.ops.wm.read_factory_settings(use_empty=True)


def _iter_used_materials(mesh_objects: Iterable[Any]) -> List[Any]:
    mats: Dict[int, Any] = {}
    for obj in mesh_objects:
        for slot in getattr(obj, "material_slots", []):
            mat = getattr(slot, "material", None)
            if mat is None:
                continue
            mats[mat.as_pointer()] = mat
    return list(mats.values())


@dataclasses.dataclass
class MaterialAnalysis:
    name: str
    use_nodes: bool
    blend_method: Optional[str]
    has_node_graph: bool
    connected_shader_nodes: List[str]
    node_types: List[str]
    uses_principled: bool
    uses_glass_shader: bool
    uses_transparent_shader: bool
    uses_renderer_nodes: List[str]
    renderer_name_hits: List[str]
    transparent: bool
    transparency_reasons: List[str]
    glass: bool
    glass_confidence: str
    glass_reasons: List[str]
    material_type_guess: str
    principled_alpha: Optional[float]
    principled_alpha_linked: bool
    principled_transmission: Optional[float]
    principled_transmission_linked: bool

    def as_dict(self) -> Dict[str, Any]:
        return dataclasses.asdict(self)


def _material_output_nodes(node_tree) -> List[Any]:
    outs = [n for n in node_tree.nodes if n.bl_idname == "ShaderNodeOutputMaterial"]
    active = [n for n in outs if getattr(n, "is_active_output", False)]
    return active or outs


def _collect_upstream_nodes(start_socket) -> List[Any]:
    visited_nodes = set()
    queue = []
    if start_socket is not None:
        queue.append(start_socket)
    nodes: List[Any] = []

    while queue:
        sock = queue.pop()
        if not getattr(sock, "is_linked", False):
            continue
        for link in sock.links:
            from_node = link.from_node
            if from_node is None:
                continue
            ptr = from_node.as_pointer()
            if ptr in visited_nodes:
                continue
            visited_nodes.add(ptr)
            nodes.append(from_node)
            for input_sock in getattr(from_node, "inputs", []):
                queue.append(input_sock)
    return nodes


def _analyze_material(mat) -> MaterialAnalysis:
    import bpy

    name = mat.name
    use_nodes = bool(getattr(mat, "use_nodes", False))
    blend_method = getattr(mat, "blend_method", None)
    has_node_graph = bool(use_nodes and getattr(mat, "node_tree", None) and mat.node_tree.nodes)

    connected_nodes: List[Any] = []
    node_types: List[str] = []
    connected_shader_nodes: List[str] = []
    uses_principled = False
    uses_glass_shader = False
    uses_transparent_shader = False
    uses_renderer_nodes: List[str] = []

    principled_alpha: Optional[float] = None
    principled_alpha_linked = False
    principled_transmission: Optional[float] = None
    principled_transmission_linked = False

    renderer_name_hits = []
    if RENDERER_RE.search(name):
        renderer_name_hits.append(name)

    if has_node_graph:
        outs = _material_output_nodes(mat.node_tree)
        for out in outs:
            surf = out.inputs.get("Surface")
            connected_nodes.extend(_collect_upstream_nodes(surf))

        # Deduplicate while preserving order.
        seen = set()
        uniq_nodes = []
        for n in connected_nodes:
            p = n.as_pointer()
            if p in seen:
                continue
            seen.add(p)
            uniq_nodes.append(n)
        connected_nodes = uniq_nodes

        node_types = sorted({n.bl_idname for n in mat.node_tree.nodes})
        connected_shader_nodes = sorted({n.bl_idname for n in connected_nodes})

        for node in connected_nodes:
            bl = node.bl_idname
            if bl == "ShaderNodeBsdfPrincipled":
                uses_principled = True
                alpha_in = node.inputs.get("Alpha")
                if alpha_in is not None:
                    principled_alpha_linked = bool(alpha_in.is_linked)
                    if not alpha_in.is_linked:
                        try:
                            principled_alpha = float(alpha_in.default_value)
                        except Exception:
                            principled_alpha = None
                tr_in = node.inputs.get("Transmission")
                if tr_in is not None:
                    principled_transmission_linked = bool(tr_in.is_linked)
                    if not tr_in.is_linked:
                        try:
                            principled_transmission = float(tr_in.default_value)
                        except Exception:
                            principled_transmission = None
            elif bl == "ShaderNodeBsdfGlass":
                uses_glass_shader = True
            elif bl == "ShaderNodeBsdfTransparent":
                uses_transparent_shader = True

            if "VRay" in bl or "Vray" in bl or "vray" in bl:
                uses_renderer_nodes.append(bl)
            if "Corona" in bl or "corona" in bl:
                uses_renderer_nodes.append(bl)
            if "Arnold" in bl or "arnold" in bl or bl.startswith("Arnold"):
                uses_renderer_nodes.append(bl)

            if bl == "ShaderNodeGroup":
                try:
                    gname = node.node_tree.name if node.node_tree else ""
                except Exception:
                    gname = ""
                if gname and RENDERER_RE.search(gname):
                    uses_renderer_nodes.append(f"Group:{gname}")

    glass_reasons: List[str] = []
    transparency_reasons: List[str] = []
    if GLASS_NAME_RE.search(name):
        glass_reasons.append("name_match")
    if blend_method and blend_method != "OPAQUE":
        transparency_reasons.append(f"blend_method:{blend_method}")
    if uses_glass_shader:
        transparency_reasons.append("glass_bsdf")
    if uses_transparent_shader:
        transparency_reasons.append("transparent_bsdf")
    if uses_principled:
        if principled_transmission_linked:
            transparency_reasons.append("principled_transmission_linked")
        elif principled_transmission is not None and principled_transmission > 0.01:
            transparency_reasons.append(f"principled_transmission:{principled_transmission:.3f}")

        if principled_alpha_linked:
            transparency_reasons.append("principled_alpha_linked")
        elif principled_alpha is not None and principled_alpha < 0.99:
            transparency_reasons.append(f"principled_alpha:{principled_alpha:.3f}")

    transparent = bool(transparency_reasons)

    # Glass is a subset of transparent-ish materials.
    # We avoid marking a material as glass solely because of non-opaque blend_method (often used for cutouts).
    glass_signals: List[str] = []
    if uses_glass_shader:
        glass_signals.append("glass_bsdf")
    if uses_transparent_shader:
        glass_signals.append("transparent_bsdf")
    if uses_principled and (principled_transmission_linked or (principled_transmission is not None and principled_transmission > 0.01)):
        glass_signals.append("principled_transmission")
    if uses_principled and (principled_alpha_linked or (principled_alpha is not None and principled_alpha < 0.99)):
        glass_signals.append("principled_alpha")

    glass = bool(glass_signals) or bool(GLASS_NAME_RE.search(name))
    if glass:
        if "glass_bsdf" in glass_signals or "transparent_bsdf" in glass_signals:
            glass_confidence = "high"
        elif "principled_transmission" in glass_signals or "principled_alpha" in glass_signals:
            glass_confidence = "medium"
        else:
            glass_confidence = "low"
    else:
        glass_confidence = "none"

    if glass:
        if GLASS_NAME_RE.search(name):
            glass_reasons.append("name_match")
        glass_reasons.extend(transparency_reasons)

    if uses_principled:
        if glass:
            material_type_guess = "Principled (glass/transparent)"
        else:
            material_type_guess = "Principled"
    elif uses_glass_shader:
        material_type_guess = "Glass BSDF"
    elif uses_transparent_shader:
        material_type_guess = "Transparent BSDF"
    elif has_node_graph:
        material_type_guess = "Node material (non-Principled)"
    else:
        material_type_guess = "Non-node material"

    return MaterialAnalysis(
        name=name,
        use_nodes=use_nodes,
        blend_method=blend_method,
        has_node_graph=has_node_graph,
        connected_shader_nodes=connected_shader_nodes,
        node_types=node_types,
        uses_principled=uses_principled,
        uses_glass_shader=uses_glass_shader,
        uses_transparent_shader=uses_transparent_shader,
        uses_renderer_nodes=sorted(set(uses_renderer_nodes)),
        renderer_name_hits=renderer_name_hits,
        transparent=transparent,
        transparency_reasons=transparency_reasons,
        glass=glass,
        glass_confidence=glass_confidence,
        glass_reasons=glass_reasons,
        material_type_guess=material_type_guess,
        principled_alpha=principled_alpha,
        principled_alpha_linked=principled_alpha_linked,
        principled_transmission=principled_transmission,
        principled_transmission_linked=principled_transmission_linked,
    )


@dataclasses.dataclass
class MeshObjectAnalysis:
    name: str
    triangles: int
    vertices: int
    edges: int
    polygons: int
    materials_used: List[Dict[str, Any]]
    uv_layers_count: int
    uv_layers: List[str]
    has_uv: bool
    non_manifold_edges: int
    boundary_edges: int
    loose_edges: int
    modifiers: List[Dict[str, Any]]
    transforms_applied: bool
    location: List[float]
    rotation_euler: List[float]
    scale: List[float]
    parent: Optional[str]
    children_count: int
    roles_guess: List[str]
    is_collision_proxy: bool
    glass_object: bool
    glass_object_reasons: List[str]
    self_intersections: Optional[Dict[str, Any]]

    def as_dict(self) -> Dict[str, Any]:
        return dataclasses.asdict(self)


def _analyze_mesh_object(obj, depsgraph, glass_material_names: set, do_self_intersections: bool) -> MeshObjectAnalysis:
    import bpy
    import bmesh

    obj_eval = obj.evaluated_get(depsgraph)
    try:
        mesh_eval = obj_eval.to_mesh(preserve_all_data_layers=True, depsgraph=depsgraph)
    except TypeError:
        mesh_eval = obj_eval.to_mesh()

    if mesh_eval is None:
        return MeshObjectAnalysis(
            name=obj.name,
            triangles=0,
            vertices=0,
            edges=0,
            polygons=0,
            materials_used=[],
            uv_layers_count=0,
            uv_layers=[],
            has_uv=False,
            non_manifold_edges=0,
            boundary_edges=0,
            loose_edges=0,
            modifiers=[],
            transforms_applied=True,
            location=_safe_float_tuple(obj.location),
            rotation_euler=_safe_float_tuple(obj.rotation_euler),
            scale=_safe_float_tuple(obj.scale),
            parent=obj.parent.name if obj.parent else None,
            children_count=len(obj.children),
            roles_guess=_guess_role(obj.name),
            is_collision_proxy=bool(COLLISION_PREFIX_RE.match(obj.name)),
            glass_object=False,
            glass_object_reasons=[],
            self_intersections=None,
        )

    try:
        mesh_eval.calc_loop_triangles()
        tri_count = len(mesh_eval.loop_triangles)
    except Exception:
        tri_count = 0

    # Materials used by polygons (face counts per material index)
    mat_counts: Dict[int, int] = {}
    try:
        for poly in mesh_eval.polygons:
            mat_counts[int(poly.material_index)] = mat_counts.get(int(poly.material_index), 0) + 1
    except Exception:
        mat_counts = {}

    materials_used: List[Dict[str, Any]] = []
    total_polys = max(1, len(mesh_eval.polygons))
    for idx, count in sorted(mat_counts.items(), key=lambda kv: (-kv[1], kv[0])):
        mat = None
        if idx < len(obj.material_slots):
            mat = obj.material_slots[idx].material
        materials_used.append(
            {
                "slot_index": idx,
                "material_name": mat.name if mat else None,
                "polygons": count,
                "polygons_ratio": round(count / total_polys, 6),
            }
        )

    uv_layers = [uv.name for uv in getattr(mesh_eval, "uv_layers", [])] if hasattr(mesh_eval, "uv_layers") else []
    uv_layers_count = len(uv_layers)
    has_uv = uv_layers_count > 0

    # Non-manifold
    bm = bmesh.new()
    try:
        bm.from_mesh(mesh_eval)
        non_manifold_edges = 0
        boundary_edges = 0
        loose_edges = 0
        for e in bm.edges:
            lf = len(e.link_faces)
            if lf == 0:
                loose_edges += 1
            if e.is_boundary:
                boundary_edges += 1
            if not e.is_manifold:
                non_manifold_edges += 1
    finally:
        bm.free()

    modifiers = [
        {"name": m.name, "type": m.type, "show_viewport": bool(m.show_viewport), "show_render": bool(m.show_render)}
        for m in getattr(obj, "modifiers", [])
    ]

    transforms_applied = _is_identity_transform(obj.location, obj.rotation_euler, obj.scale)

    # Glass object heuristic: mostly glass materials OR name match
    glass_object_reasons: List[str] = []
    if GLASS_NAME_RE.search(obj.name):
        glass_object_reasons.append("object_name_match")

    glass_poly_ratio = 0.0
    if mat_counts:
        glass_polys = 0
        for idx, count in mat_counts.items():
            mat = None
            if idx < len(obj.material_slots):
                mat = obj.material_slots[idx].material
            if mat and mat.name in glass_material_names:
                glass_polys += count
        glass_poly_ratio = glass_polys / total_polys
        if glass_poly_ratio >= 0.8:
            glass_object_reasons.append(f"glass_materials_ratio:{glass_poly_ratio:.3f}")

    glass_object = bool(glass_object_reasons)

    self_intersections: Optional[Dict[str, Any]] = None
    if do_self_intersections:
        self_intersections = _estimate_self_intersections(mesh_eval)

    # Cleanup evaluated mesh
    vertices_count = len(mesh_eval.vertices)
    edges_count = len(mesh_eval.edges)
    polygons_count = len(mesh_eval.polygons)
    try:
        obj_eval.to_mesh_clear()
    except Exception:
        pass

    return MeshObjectAnalysis(
        name=obj.name,
        triangles=int(tri_count),
        vertices=vertices_count,
        edges=edges_count,
        polygons=polygons_count,
        materials_used=materials_used,
        uv_layers_count=uv_layers_count,
        uv_layers=uv_layers,
        has_uv=has_uv,
        non_manifold_edges=int(non_manifold_edges),
        boundary_edges=int(boundary_edges),
        loose_edges=int(loose_edges),
        modifiers=modifiers,
        transforms_applied=bool(transforms_applied),
        location=_safe_float_tuple(obj.location),
        rotation_euler=_safe_float_tuple(obj.rotation_euler),
        scale=_safe_float_tuple(obj.scale),
        parent=obj.parent.name if obj.parent else None,
        children_count=len(obj.children),
        roles_guess=_guess_role(obj.name),
        is_collision_proxy=bool(COLLISION_PREFIX_RE.match(obj.name)),
        glass_object=glass_object,
        glass_object_reasons=glass_object_reasons,
        self_intersections=self_intersections,
    )


def _estimate_self_intersections(mesh_eval) -> Dict[str, Any]:
    """
    Best-effort, approximate self-intersection check.
    We keep it lightweight: only checks BVH AABB overlaps, so it can over-report.
    """

    # Avoid heavy work on extremely dense meshes.
    try:
        mesh_eval.calc_loop_triangles()
        tris = mesh_eval.loop_triangles
    except Exception:
        return {"status": "unavailable", "reason": "no_loop_triangles"}

    tri_count = len(tris)
    if tri_count == 0:
        return {"status": "ok", "triangles": 0, "pairs_checked": 0, "overlap_pairs": 0}

    # Conservative limit: self-intersection checks scale poorly on dense meshes.
    if tri_count > 50_000:
        return {"status": "skipped", "reason": "too_many_triangles", "triangles": tri_count}

    try:
        from mathutils.bvhtree import BVHTree
    except Exception:
        return {"status": "unavailable", "reason": "no_bvhtree"}

    verts = [v.co[:] for v in mesh_eval.vertices]
    polys = [tuple(t.vertices) for t in tris]

    try:
        bvh = BVHTree.FromPolygons(verts, polys, all_triangles=True)
    except Exception as e:
        return {"status": "unavailable", "reason": f"bvh_build_failed:{e.__class__.__name__}"}

    # Note: overlap() here only reports bounding-box overlaps, not true triangle intersections.
    overlap_pairs = bvh.overlap(bvh)
    uniq_pairs = set()
    for a, b in overlap_pairs:
        if a == b:
            continue
        if a > b:
            a, b = b, a
        uniq_pairs.add((a, b))

    # This can still be noisy; we just report magnitude.
    return {
        "status": "approx",
        "triangles": tri_count,
        "overlap_pairs": len(uniq_pairs),
        "note": "BVH overlap is an approximate proxy and may include adjacent faces; use Blender 'Mesh > Clean Up > Select Self Intersect' for confirmation.",
    }


def _analyze_scene(scene, do_self_intersections: bool) -> Dict[str, Any]:
    import bpy

    depsgraph = bpy.context.evaluated_depsgraph_get()
    all_objects = list(scene.objects)
    mesh_objects = [o for o in all_objects if o.type == "MESH"]
    non_mesh_types: Dict[str, int] = {}
    for o in all_objects:
        if o.type != "MESH":
            non_mesh_types[o.type] = non_mesh_types.get(o.type, 0) + 1

    used_mats = _iter_used_materials(mesh_objects)
    materials_analysis = [_analyze_material(m) for m in sorted(used_mats, key=lambda m: m.name.lower())]
    glass_material_names = {m.name for m in materials_analysis if m.glass}

    object_analyses: List[MeshObjectAnalysis] = []
    for obj in sorted(mesh_objects, key=lambda o: o.name.lower()):
        object_analyses.append(_analyze_mesh_object(obj, depsgraph, glass_material_names, do_self_intersections))

    render_mesh_objects = [o for o in object_analyses if not o.is_collision_proxy]
    collision_mesh_objects = [o for o in object_analyses if o.is_collision_proxy]

    triangles_total = sum(o.triangles for o in object_analyses)
    triangles_render = sum(o.triangles for o in render_mesh_objects)
    triangles_collision = sum(o.triangles for o in collision_mesh_objects)
    non_manifold_total = sum(o.non_manifold_edges for o in object_analyses)
    meshes_without_uv = [o.name for o in object_analyses if not o.has_uv]
    render_meshes_without_uv = [o.name for o in render_mesh_objects if not o.has_uv]
    non_applied_transforms = [o.name for o in object_analyses if not o.transforms_applied]
    has_modifiers = any(o.modifiers for o in object_analyses)
    has_hierarchy = any(o.parent for o in object_analyses) or any(o.children_count for o in object_analyses)
    glass_objects = [o.name for o in object_analyses if o.glass_object]

    # Logical separation heuristic
    facade_objects = [o.name for o in object_analyses if "facade" in o.roles_guess]
    roof_objects = [o.name for o in object_analyses if "roof" in o.roles_guess]
    ground_objects = [o.name for o in object_analyses if "ground" in o.roles_guess]

    allowed_materials_only = all(m.uses_principled or not m.has_node_graph for m in materials_analysis)
    has_renderer_shaders = any(m.uses_renderer_nodes or m.renderer_name_hits for m in materials_analysis)

    return {
        "scene_name": scene.name,
        "objects_total": len(all_objects),
        "mesh_objects": len(mesh_objects),
        "render_mesh_objects": len(render_mesh_objects),
        "collision_mesh_objects": len(collision_mesh_objects),
        "non_mesh_objects": sum(non_mesh_types.values()),
        "non_mesh_types": non_mesh_types,
        "triangles_total": triangles_total,
        "triangles_render_meshes": triangles_render,
        "triangles_collision_meshes": triangles_collision,
        "materials_total": len(materials_analysis),
        "materials": [m.as_dict() for m in materials_analysis],
        "glass_materials": [m.name for m in materials_analysis if m.glass],
        "transparent_materials": [m.name for m in materials_analysis if m.transparent],
        "glass_objects": glass_objects,
        "separate_glass_meshes": bool(glass_objects),
        "geometry": {
            "non_manifold_edges_total": non_manifold_total,
            "meshes_with_non_manifold": [o.name for o in object_analyses if o.non_manifold_edges > 0],
            "self_intersections": {
                "available": do_self_intersections,
                "note": "Per-object approximate BVH overlap is reported in objects[].self_intersections when enabled.",
            },
            "modifiers_present": has_modifiers,
            "non_applied_transforms_objects": non_applied_transforms,
            "has_hierarchy": has_hierarchy,
        },
        "structure": {
            "facade_objects_guess": facade_objects,
            "roof_objects_guess": roof_objects,
            "ground_objects_guess": ground_objects,
            "has_facade_roof_ground_split_guess": bool(facade_objects or roof_objects or ground_objects),
        },
        "materials_checks": {
            "allowed_only_standard_physical_principled_guess": allowed_materials_only,
            "has_renderer_shaders_guess": has_renderer_shaders,
            "has_node_graphs": any(m.has_node_graph for m in materials_analysis),
        },
        "uv": {
            "all_meshes_have_uv": len(meshes_without_uv) == 0,
            "meshes_without_uv": meshes_without_uv,
            "render_meshes_have_uv": len(render_meshes_without_uv) == 0,
            "render_meshes_without_uv": render_meshes_without_uv,
            "max_uv_channels": max((o.uv_layers_count for o in object_analyses), default=0),
        },
        "objects": [o.as_dict() for o in object_analyses],
    }


def _import_fbx(filepath: str) -> None:
    import bpy

    _try_enable_addon("io_scene_fbx")

    # FBX import operator can throw; we let it bubble and record error per file.
    bpy.ops.import_scene.fbx(
        filepath=filepath,
        use_custom_props=True,
        use_custom_props_enum_as_string=True,
    )


def _open_blend(filepath: str) -> None:
    import bpy

    bpy.ops.wm.open_mainfile(filepath=filepath)


def _analyze_file(path: str, do_self_intersections: bool) -> Dict[str, Any]:
    import bpy

    started = time.time()
    ext = os.path.splitext(path)[1].lower()
    file_entry: Dict[str, Any] = {
        "path": path,
        "name": os.path.basename(path),
        "ext": ext,
        "started_at": _iso_now(),
        "status": "ok",
        "error": None,
    }

    try:
        if ext == ".fbx":
            _reset_to_empty_scene()
            _import_fbx(path)
        elif ext == ".blend":
            _open_blend(path)
        else:
            file_entry["status"] = "skipped"
            file_entry["error"] = f"unsupported_extension:{ext}"
            return file_entry

        scene = bpy.context.scene
        file_entry["scene"] = _analyze_scene(scene, do_self_intersections=do_self_intersections)
    except Exception as e:
        file_entry["status"] = "error"
        file_entry["error"] = f"{e.__class__.__name__}: {e}"
    finally:
        file_entry["duration_sec"] = round(time.time() - started, 3)
        file_entry["finished_at"] = _iso_now()

    return file_entry


def _collect_model_files(input_dir: str) -> List[str]:
    paths: List[str] = []
    for root, _, files in os.walk(input_dir):
        for fn in files:
            ext = os.path.splitext(fn)[1].lower()
            if ext in (".fbx", ".blend"):
                paths.append(os.path.join(root, fn))
    return sorted(paths, key=lambda p: os.path.basename(p).lower())


def _md_escape(s: str) -> str:
    return s.replace("|", "\\|")


def _write_markdown(report: Dict[str, Any], output_path: str) -> None:
    def _fmt_list(items: Sequence[str], limit: int = 25) -> str:
        items = list(items)
        if not items:
            return ""
        if len(items) <= limit:
            return ", ".join(items)
        head = ", ".join(items[:limit])
        return f"{head} (+{len(items) - limit} more)"

    lines: List[str] = []
    lines.append(f"# Moskomarkhitektura 3D QA report")
    lines.append("")
    lines.append(f"- Generated at: `{report.get('generated_at')}`")
    lines.append(f"- Blender: `{report.get('blender_version')}`")
    lines.append(f"- Input dir: `{report.get('input_dir')}`")
    lines.append("")

    files = report.get("files", [])

    lines.append("## Summary")
    lines.append("")
    lines.append(
        "| File | Status | Meshes | Render | Collision | Triangles | Materials | Glass mats | Transparent mats | Non-manifold edges | Render UV missing | Transforms not applied | Hierarchy |"
    )
    lines.append("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|")
    for f in files:
        scene = f.get("scene") or {}
        geom = (scene.get("geometry") or {}) if isinstance(scene, dict) else {}
        uv = (scene.get("uv") or {}) if isinstance(scene, dict) else {}
        status = f.get("status")
        meshes = scene.get("mesh_objects", 0)
        render_meshes = scene.get("render_mesh_objects", 0)
        collision_meshes = scene.get("collision_mesh_objects", 0)
        tris = scene.get("triangles_total", 0)
        mats = scene.get("materials_total", 0)
        glass_mats = len(scene.get("glass_materials") or [])
        transparent_mats = len(scene.get("transparent_materials") or [])
        non_manifold = geom.get("non_manifold_edges_total", 0)
        uv_missing = len(uv.get("render_meshes_without_uv") or [])
        transforms_not_applied = len(geom.get("non_applied_transforms_objects") or [])
        hierarchy = "yes" if geom.get("has_hierarchy") else "no"
        lines.append(
            "| "
            + " | ".join(
                [
                    _md_escape(f.get("name", "?")),
                    str(status),
                    str(meshes),
                    str(render_meshes),
                    str(collision_meshes),
                    str(tris),
                    str(mats),
                    str(glass_mats),
                    str(transparent_mats),
                    str(non_manifold),
                    str(uv_missing),
                    str(transforms_not_applied),
                    hierarchy,
                ]
            )
            + " |"
        )
    lines.append("")

    lines.append("## Details")
    lines.append("")
    for f in files:
        lines.append(f"### {f.get('name')}")
        lines.append("")
        lines.append(f"- Status: `{f.get('status')}`")
        if f.get("error"):
            lines.append(f"- Error: `{f.get('error')}`")
        lines.append(f"- Duration: `{f.get('duration_sec')}s`")

        scene = f.get("scene")
        if not isinstance(scene, dict):
            lines.append("")
            continue

        geom = scene.get("geometry") or {}
        mats_checks = scene.get("materials_checks") or {}
        structure = scene.get("structure") or {}
        uv = scene.get("uv") or {}

        lines.append(
            f"- Mesh objects: `{scene.get('mesh_objects')}` (render: `{scene.get('render_mesh_objects')}`, collision proxies: `{scene.get('collision_mesh_objects')}`, non-mesh: `{scene.get('non_mesh_objects')}`)"
        )
        lines.append(
            f"- Triangles (evaluated): `{scene.get('triangles_total')}` (render: `{scene.get('triangles_render_meshes')}`, collision: `{scene.get('triangles_collision_meshes')}`)"
        )
        lines.append(f"- Materials used: `{scene.get('materials_total')}`")
        if scene.get("glass_materials"):
            lines.append(f"- Glass materials (heuristic): `{_fmt_list(scene.get('glass_materials'))}`")
        if scene.get("transparent_materials"):
            lines.append(f"- Transparent materials (heuristic): `{_fmt_list(scene.get('transparent_materials'))}`")
        lines.append(f"- Non-manifold edges (total): `{geom.get('non_manifold_edges_total')}`")
        if geom.get("meshes_with_non_manifold"):
            lines.append(f"- Meshes with non-manifold: `{_fmt_list(geom.get('meshes_with_non_manifold'))}`")
        if geom.get("modifiers_present"):
            lines.append("- Modifiers present: `yes`")
        if geom.get("non_applied_transforms_objects"):
            lines.append(f"- Transforms not applied (objects): `{_fmt_list(geom.get('non_applied_transforms_objects'))}`")
        lines.append(f"- Hierarchy: `{'yes' if geom.get('has_hierarchy') else 'no'}`")
        lines.append("")

        lines.append("**Structure (heuristic)**")
        lines.append(f"- Separate glass meshes: `{'yes' if scene.get('separate_glass_meshes') else 'no'}`")
        lines.append(f"- Facade objects guess: `{', '.join(structure.get('facade_objects_guess') or [])}`")
        lines.append(f"- Roof objects guess: `{', '.join(structure.get('roof_objects_guess') or [])}`")
        lines.append(f"- Ground objects guess: `{', '.join(structure.get('ground_objects_guess') or [])}`")
        lines.append("")

        lines.append("**Materials checks (heuristic)**")
        lines.append(
            f"- Only Standard/Physical/Principled guess: `{'yes' if mats_checks.get('allowed_only_standard_physical_principled_guess') else 'no'}`"
        )
        lines.append(f"- Renderer shaders (VRay/Corona/Arnold) guess: `{'yes' if mats_checks.get('has_renderer_shaders_guess') else 'no'}`")
        lines.append(f"- Node graphs: `{'yes' if mats_checks.get('has_node_graphs') else 'no'}`")
        lines.append("")

        mats = scene.get("materials") or []
        if isinstance(mats, list) and mats:
            lines.append("**Materials**")
            for m in mats:
                if not isinstance(m, dict):
                    continue
                renderer_bits = []
                if m.get("uses_renderer_nodes"):
                    renderer_bits.extend(m.get("uses_renderer_nodes") or [])
                if m.get("renderer_name_hits"):
                    renderer_bits.extend(m.get("renderer_name_hits") or [])
                renderer_txt = ", ".join(renderer_bits) if renderer_bits else "none"
                lines.append(
                    f"- `{m.get('name')}`: type=`{m.get('material_type_guess')}`, glass=`{m.get('glass')}`, transparent=`{m.get('transparent')}`, blend=`{m.get('blend_method')}`, renderer=`{renderer_txt}`"
                )
            lines.append("")

        lines.append("**UV**")
        lines.append(f"- Render meshes have UV: `{'yes' if uv.get('render_meshes_have_uv') else 'no'}`")
        if uv.get("render_meshes_without_uv"):
            lines.append(f"- Render meshes without UV: `{_fmt_list(uv.get('render_meshes_without_uv'))}`")
        if not uv.get("all_meshes_have_uv") and uv.get("meshes_without_uv"):
            lines.append(
                f"- All meshes without UV (incl. collision proxies): `{_fmt_list(uv.get('meshes_without_uv'))}`"
            )
        lines.append(f"- Max UV channels: `{uv.get('max_uv_channels')}`")
        lines.append("")

        # Top objects by triangles (helpful for high-poly assets)
        objs = scene.get("objects") or []
        if isinstance(objs, list) and objs:
            render_objs = [o for o in objs if not o.get("is_collision_proxy")]
            try:
                top = sorted(render_objs, key=lambda o: int(o.get("triangles", 0)), reverse=True)[:15]
            except Exception:
                top = render_objs[:15]
            lines.append("**Top render mesh objects by triangles**")
            for o in top:
                lines.append(
                    f"- `{o.get('name')}`: tris={o.get('triangles')}, UV={o.get('uv_layers_count')}, non-manifold={o.get('non_manifold_edges')}, transforms_applied={o.get('transforms_applied')}, glass_object={o.get('glass_object')}"
                )
            lines.append("")

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines).rstrip() + "\n")


def main(argv: Sequence[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input-dir", required=True, help="Folder containing .fbx/.blend files (recursively).")
    parser.add_argument("--output-json", required=True)
    parser.add_argument("--output-md", required=True)
    parser.add_argument(
        "--self-intersections",
        action="store_true",
        help="Enable approximate self-intersection detection (BVH overlap proxy). Can be slow/noisy.",
    )
    args = parser.parse_args(argv)

    input_dir = os.path.abspath(args.input_dir)
    model_files = _collect_model_files(input_dir)

    import bpy

    report: Dict[str, Any] = {
        "generated_at": _iso_now(),
        "blender_version": ".".join(map(str, bpy.app.version)),
        "input_dir": input_dir,
        "files_found": len(model_files),
        "files": [],
    }

    for path in model_files:
        report["files"].append(_analyze_file(path, do_self_intersections=bool(args.self_intersections)))

    # Aggregate quick summary
    ok_files = [f for f in report["files"] if f.get("status") == "ok"]
    report["summary"] = {
        "files_ok": len(ok_files),
        "files_error": len([f for f in report["files"] if f.get("status") == "error"]),
        "total_triangles": sum((f.get("scene") or {}).get("triangles_total", 0) for f in ok_files),
        "total_mesh_objects": sum((f.get("scene") or {}).get("mesh_objects", 0) for f in ok_files),
        "total_materials": sum((f.get("scene") or {}).get("materials_total", 0) for f in ok_files),
    }

    os.makedirs(os.path.dirname(os.path.abspath(args.output_json)), exist_ok=True)
    with open(args.output_json, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)

    _write_markdown(report, args.output_md)

    print(f"Wrote JSON: {args.output_json}")
    print(f"Wrote MD:   {args.output_md}")
    return 0


if __name__ == "__main__":
    # Blender passes script args after `--`
    try:
        sep = sys.argv.index("--")
        script_args = sys.argv[sep + 1 :]
    except ValueError:
        script_args = []
    raise SystemExit(main(script_args))
