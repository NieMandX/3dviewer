#!/usr/bin/env python3
"""
Best-effort Blender "fix" script for Moskomarkhitektura pipeline prep.

Goals (safe-ish defaults):
  - Remove Unreal-style collision proxy meshes (UCX_/UBX_/UCP_/USP_) if requested
  - Optionally remove non-mesh objects (lights/empties/cameras)
  - Optionally apply transforms to mesh data (bake matrix_world into geometry)
  - Optionally apply modifiers (convert evaluated mesh to real mesh)
  - Export a cleaned FBX (or save a cleaned .blend copy)

Run (macOS):
  /Applications/Blender.app/Contents/MacOS/Blender \\
    --background --factory-startup \\
    --python tools/moskomarch/blender_fix_models.py -- \\
    --input "/path/to/file_or_dir" \\
    --output "/path/to/out_dir" \\
    --remove-collision \\
    --remove-non-mesh \\
    --apply-transforms \\
    --apply-modifiers
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from typing import Iterable, List, Optional, Sequence, Tuple


GLASS_NAME_RE = re.compile(r"(glass|gls|window|windscreen|стек|окн)", re.IGNORECASE)
COLLISION_PREFIX_RE = re.compile(r"^(UCX|UBX|UCP|USP)_", re.IGNORECASE)


def _try_enable_addon(module: str) -> None:
    try:
        import addon_utils

        addon_utils.enable(module, default_set=True, persistent=False)
    except Exception:
        return


def _reset_to_empty_scene() -> None:
    import bpy

    bpy.ops.wm.read_factory_settings(use_empty=True)


def _collect_inputs(path: str) -> List[str]:
    path = os.path.abspath(path)
    if os.path.isfile(path):
        return [path]
    found: List[str] = []
    for root, _, files in os.walk(path):
        for fn in files:
            ext = os.path.splitext(fn)[1].lower()
            if ext in (".fbx", ".blend"):
                found.append(os.path.join(root, fn))
    return sorted(found, key=lambda p: os.path.basename(p).lower())


def _is_collision_proxy(obj_name: str) -> bool:
    return bool(COLLISION_PREFIX_RE.match(obj_name))


def _iter_mesh_objects(scene) -> List[object]:
    return [o for o in scene.objects if o.type == "MESH"]


def _materials_used_by_objects(objects: Iterable[object]) -> List[object]:
    mats = {}
    for obj in objects:
        for slot in getattr(obj, "material_slots", []):
            mat = getattr(slot, "material", None)
            if mat is None:
                continue
            mats[mat.as_pointer()] = mat
    return list(mats.values())


def _material_is_glass(mat) -> bool:
    # Simple heuristic: name + Principled alpha/transmission + Glass/Transparent BSDF.
    if GLASS_NAME_RE.search(mat.name or ""):
        return True

    if not getattr(mat, "use_nodes", False) or not getattr(mat, "node_tree", None):
        return False

    for node in mat.node_tree.nodes:
        bl = getattr(node, "bl_idname", "")
        if bl in ("ShaderNodeBsdfGlass", "ShaderNodeBsdfTransparent"):
            return True
        if bl == "ShaderNodeBsdfPrincipled":
            alpha = node.inputs.get("Alpha")
            transmission = node.inputs.get("Transmission")
            if alpha and (alpha.is_linked or (hasattr(alpha, "default_value") and alpha.default_value < 0.99)):
                return True
            if transmission and (
                transmission.is_linked or (hasattr(transmission, "default_value") and transmission.default_value > 0.01)
            ):
                return True

    return False


def _apply_transforms_to_mesh(obj) -> None:
    import mathutils

    mw = obj.matrix_world.copy()
    if mw == mathutils.Matrix.Identity(4):
        return
    obj.data.transform(mw)
    obj.matrix_world = mathutils.Matrix.Identity(4)


def _apply_modifiers(obj, depsgraph) -> None:
    import bpy

    if not getattr(obj, "modifiers", None):
        return

    obj_eval = obj.evaluated_get(depsgraph)
    try:
        mesh_eval = obj_eval.to_mesh(preserve_all_data_layers=True, depsgraph=depsgraph)
    except TypeError:
        mesh_eval = obj_eval.to_mesh()
    if mesh_eval is None:
        return

    new_mesh = bpy.data.meshes.new(name=f"{obj.data.name}_applied")
    new_mesh.from_mesh(mesh_eval)
    obj.data = new_mesh
    obj.modifiers.clear()
    try:
        obj_eval.to_mesh_clear()
    except Exception:
        pass


def _import_or_open(path: str) -> Tuple[str, object]:
    import bpy

    ext = os.path.splitext(path)[1].lower()
    if ext == ".fbx":
        _reset_to_empty_scene()
        _try_enable_addon("io_scene_fbx")
        bpy.ops.import_scene.fbx(filepath=path)
    elif ext == ".blend":
        bpy.ops.wm.open_mainfile(filepath=path)
    else:
        raise ValueError(f"Unsupported extension: {ext}")
    return ext, bpy.context.scene


def _export(path_in: str, out_dir: str, scene, export_fbx: bool) -> str:
    import bpy

    base = os.path.splitext(os.path.basename(path_in))[0]
    os.makedirs(out_dir, exist_ok=True)

    if export_fbx:
        out_path = os.path.join(out_dir, f"{base}_fixed.fbx")
        bpy.ops.export_scene.fbx(
            filepath=out_path,
            use_selection=False,
            add_leaf_bones=False,
            bake_space_transform=False,
            path_mode="AUTO",
        )
        return out_path

    out_path = os.path.join(out_dir, f"{base}_fixed.blend")
    bpy.ops.wm.save_as_mainfile(filepath=out_path, compress=True)
    return out_path


def main(argv: Sequence[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, help="FBX/BLEND file or directory (recursive).")
    parser.add_argument("--output", required=True, help="Output directory for _fixed exports.")
    parser.add_argument("--remove-collision", action="store_true", help="Delete UCX_/UBX_/UCP_/USP_ meshes.")
    parser.add_argument("--remove-non-mesh", action="store_true", help="Delete non-mesh objects (lights/empties/cameras).")
    parser.add_argument("--apply-transforms", action="store_true", help="Bake matrix_world into mesh data.")
    parser.add_argument("--apply-modifiers", action="store_true", help="Apply modifiers by converting evaluated mesh.")
    parser.add_argument(
        "--force-opaque-non-glass",
        action="store_true",
        help="If a non-glass material is transparent, force it to OPAQUE (can be destructive for cutouts).",
    )
    parser.add_argument(
        "--export-fbx",
        action="store_true",
        help="Export FBX (default). If not set, exports BLEND copy.",
    )
    args = parser.parse_args(argv)

    paths = _collect_inputs(args.input)
    if not paths:
        print("No .fbx/.blend files found.")
        return 2

    import bpy

    for path in paths:
        print(f"Processing: {path}")
        ext, scene = _import_or_open(path)

        depsgraph = bpy.context.evaluated_depsgraph_get()

        # Delete collision proxies
        if args.remove_collision:
            for obj in list(scene.objects):
                if obj.type == "MESH" and _is_collision_proxy(obj.name):
                    bpy.data.objects.remove(obj, do_unlink=True)

        # Delete non-mesh objects
        if args.remove_non_mesh:
            for obj in list(scene.objects):
                if obj.type != "MESH":
                    bpy.data.objects.remove(obj, do_unlink=True)

        # Apply modifiers / transforms
        mesh_objs = _iter_mesh_objects(scene)
        for obj in mesh_objs:
            if args.apply_modifiers:
                _apply_modifiers(obj, depsgraph)
            if args.apply_transforms:
                _apply_transforms_to_mesh(obj)

        # Material blend methods
        mesh_objs = _iter_mesh_objects(scene)
        used_mats = _materials_used_by_objects(mesh_objs)
        for mat in used_mats:
            is_glass = _material_is_glass(mat)
            if is_glass:
                try:
                    mat.blend_method = "BLEND"
                except Exception:
                    pass
                continue

            if args.force_opaque_non_glass:
                try:
                    if getattr(mat, "blend_method", "OPAQUE") != "OPAQUE":
                        mat.blend_method = "OPAQUE"
                except Exception:
                    pass

        export_fbx = True if args.export_fbx else (ext == ".fbx")
        out_path = _export(path, args.output, scene, export_fbx=export_fbx)
        print(f"Exported: {out_path}")

    return 0


if __name__ == "__main__":
    try:
        sep = sys.argv.index("--")
        script_args = sys.argv[sep + 1 :]
    except ValueError:
        script_args = []
    raise SystemExit(main(script_args))

