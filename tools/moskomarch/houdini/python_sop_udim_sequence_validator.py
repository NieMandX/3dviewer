"""
Python SOP UDIM validator for Houdini 20.5.

Usage inside a Python SOP:

1) Add parameters on the Python SOP:
   - mode (String Menu): sequential | single_1001
   - fail_on_error (Toggle): 0/1
   - uv_attrib (String): uv

2) In the Python SOP code:

   import importlib.util
   path = "/ABS/PATH/tools/moskomarch/houdini/python_sop_udim_sequence_validator.py"
   spec = importlib.util.spec_from_file_location("udim_validator", path)
   mod = importlib.util.module_from_spec(spec)
   spec.loader.exec_module(mod)
   mod.run(hou.pwd())
"""

from __future__ import annotations

import math
from typing import Iterable, List, Set, Tuple


def _get_uv_values(geo, uv_attrib_name: str) -> Iterable[Tuple[float, float]]:
    uv_vtx = geo.findVertexAttrib(uv_attrib_name)
    uv_pt = geo.findPointAttrib(uv_attrib_name)
    if uv_vtx is None and uv_pt is None:
        return []

    values: List[Tuple[float, float]] = []
    for prim in geo.prims():
        for vtx in prim.vertices():
            if uv_vtx is not None:
                uv = vtx.attribValue(uv_vtx)
            else:
                uv = vtx.point().attribValue(uv_pt)
            values.append((float(uv[0]), float(uv[1])))
    return values


def _uv_to_udim(u: float, v: float) -> int:
    return 1001 + int(math.floor(u)) + int(math.floor(v)) * 10


def _validate_tiles(tiles: Set[int], mode: str) -> Tuple[bool, str]:
    if not tiles:
        return False, "No UDIM tiles found: missing or empty UV data."

    if any(t < 1001 for t in tiles):
        return False, f"Invalid UDIM tiles below 1001: {sorted(t for t in tiles if t < 1001)}"

    if mode == "single_1001":
        if tiles == {1001}:
            return True, "OK: all UVs are in tile 1001."
        return False, f"Expected only 1001 tile, got: {sorted(tiles)}"

    if mode == "sequential":
        if 1001 not in tiles:
            return False, f"Sequential mode requires start tile 1001, got: {sorted(tiles)}"
        expected = set(range(1001, max(tiles) + 1))
        missing = sorted(expected - tiles)
        if missing:
            return False, f"Missing UDIM tiles in sequence: {missing}; present={sorted(tiles)}"
        return True, f"OK: sequential tiles {min(tiles)}..{max(tiles)} without gaps."

    return False, f"Unknown mode '{mode}'. Allowed: sequential | single_1001"


def _set_or_create_detail_attrib(geo, name: str, value):
    attrib = geo.findGlobalAttrib(name)
    if attrib is None:
        geo.addAttrib(__import__("hou").attribType.Global, name, value)
    geo.setGlobalAttribValue(name, value)


def run(node) -> None:
    import hou

    geo = node.geometry()

    mode_parm = node.parm("mode")
    fail_parm = node.parm("fail_on_error")
    uv_parm = node.parm("uv_attrib")

    mode = mode_parm.evalAsString().strip() if mode_parm else "sequential"
    fail_on_error = bool(fail_parm.eval()) if fail_parm else True
    uv_attrib_name = uv_parm.evalAsString().strip() if uv_parm else "uv"
    if not uv_attrib_name:
        uv_attrib_name = "uv"

    uv_values = list(_get_uv_values(geo, uv_attrib_name))
    tiles = {_uv_to_udim(u, v) for (u, v) in uv_values}
    is_valid, message = _validate_tiles(tiles, mode)

    tiles_csv = ",".join(str(t) for t in sorted(tiles))
    _set_or_create_detail_attrib(geo, "mka_udim_mode", mode)
    _set_or_create_detail_attrib(geo, "mka_udim_tiles", tiles_csv)
    _set_or_create_detail_attrib(geo, "mka_udim_tile_count", len(tiles))
    _set_or_create_detail_attrib(geo, "mka_udim_valid", 1 if is_valid else 0)
    _set_or_create_detail_attrib(geo, "mka_udim_message", message)

    if not is_valid and fail_on_error:
        raise hou.NodeError(message)

