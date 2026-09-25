import { Raycaster, Vector2 } from 'three';

// One-shot surface selection. Only imported, visible meshes participate; face slots
// also work for multi-material and instanced meshes.
export function createMaterialPicker({ canvas, camera, controls, getEntries, onPick, onActive = () => {}, onMiss = () => {} }) {
    const ray = new Raycaster(), pointer = new Vector2();
    let active = false, press = null, previousEnabled, previousCursor;
    function stop() {
        if (!active) return;
        active = false; press = null; controls.enabled = previousEnabled; canvas.style.cursor = previousCursor;
        document.removeEventListener('keydown', key); onActive(false);
    }
    function key(event) { if (event.key === 'Escape') { event.preventDefault(); stop(); } }
    function consume(event) { event.preventDefault(); event.stopImmediatePropagation(); }
    function down(event) {
        if (!active) return;
        consume(event);
        if (event.button === 0 && event.isPrimary !== false) press = { x: event.clientX, y: event.clientY, id: event.pointerId };
    }
    function move(event) { if (active) { consume(event); if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 6) press = null; } }
    function cancel() { press = null; }
    function up(event) {
        if (!active) return;
        consume(event);
        const started = press; press = null;
        if (!started || event.pointerId !== started.id || Math.hypot(event.clientX - started.x, event.clientY - started.y) > 6) return;
        const rect = canvas.getBoundingClientRect(); if (!rect.width || !rect.height) return;
        pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, 1 - (event.clientY - rect.top) / rect.height * 2);
        camera.updateWorldMatrix(true, false); ray.layers.mask = camera.layers.mask; ray.setFromCamera(pointer, camera);
        const slots = new Map();
        for (const entry of getEntries().values()) for (const { object, index } of entry.uses) {
            let visible = object.layers.test(camera.layers);
            for (let p = object; p && visible; p = p.parent) visible = p.visible && !p.userData?.isCollision && !p.userData?.excludeFromExport;
            if (!visible) continue;
            if (!slots.has(object)) { slots.set(object, new Map()); object.updateWorldMatrix(true, false); }
            slots.get(object).set(index, entry);
        }
        for (const hit of ray.intersectObjects([...slots.keys()], false)) {
            let slot = Array.isArray(hit.object.material) ? hit.face?.materialIndex ?? 0 : 0;
            // Diagnostic shading may use one display material for every face.
            // The underlying editable slots still follow the geometry groups.
            if (!Array.isArray(hit.object.material) && slots.get(hit.object)?.size > 1) {
                const index = (hit.faceIndex ?? 0) * 3;
                slot = hit.object.geometry.groups.find((g) => index >= g.start && index < g.start + g.count)?.materialIndex ?? 0;
            }
            const entry = slots.get(hit.object)?.get(slot);
            const display = Array.isArray(hit.object.material) ? hit.object.material[slot] : hit.object.material;
            if (entry && display?.visible !== false) { stop(); onPick(entry); return; }
        }
        onMiss();
    }
    for (const [name, fn] of [['pointerdown', down], ['pointermove', move], ['pointerup', up], ['pointercancel', cancel], ['pointerleave', cancel]]) canvas.addEventListener(name, fn, true);
    return {
        get active() { return active; }, stop,
        start() { if (active) return; active = true; previousEnabled = controls.enabled; previousCursor = canvas.style.cursor; controls.enabled = false; canvas.style.cursor = 'crosshair'; document.addEventListener('keydown', key); onActive(true); },
        dispose() { stop(); for (const [name, fn] of [['pointerdown', down], ['pointermove', move], ['pointerup', up], ['pointercancel', cancel], ['pointerleave', cancel]]) canvas.removeEventListener(name, fn, true); },
    };
}
