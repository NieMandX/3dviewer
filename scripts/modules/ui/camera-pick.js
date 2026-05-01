export function createCameraPickController(options = {}) {
    const THREE = options.THREE || null;
    const camera = options.camera || null;
    const controls = options.controls || null;
    const world = options.world || null;
    const renderer = options.renderer || null;
    const pickBtn = options.pickBtn || null;

    const requestRender = typeof options.requestRender === 'function' ? options.requestRender : () => {};
    const isBlocked = typeof options.isBlocked === 'function' ? options.isBlocked : () => false;

    if (!THREE || !camera || !controls || !world || !renderer || !pickBtn) {
        return Object.freeze({
            setActive: () => {},
            isActive: () => false,
            dispose: () => {},
        });
    }

    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const tmpOffset = new THREE.Vector3();
    const tmpTarget = new THREE.Vector3();
    const tmpDir = new THREE.Vector3();
    const approachRatio = Number.isFinite(options.approachRatio)
        ? Math.min(Math.max(options.approachRatio, 0.02), 0.9)
        : 0.08;
    const canvas = renderer.domElement;

    let active = false;
    let prevControlsEnabled = null;
    let prevCursor = '';
    let disposed = false;

    function hasAncestorFlag(obj, flag) {
        let current = obj;
        while (current) {
            if (current.userData && current.userData[flag]) return true;
            current = current.parent;
        }
        return false;
    }

    function isPickableObject(obj) {
        if (!obj || !obj.visible) return false;
        if (hasAncestorFlag(obj, 'annotationRoot')) return false;
        if (hasAncestorFlag(obj, 'excludeFromBounds')) return false;
        if (obj.isPoints || obj.isLine || obj.isLineSegments || obj.isLineLoop) return false;
        return !!(obj.isMesh || obj.isSkinnedMesh || obj.isInstancedMesh);
    }

    function pickHit(event) {
        if (!canvas) return null;
        const rect = canvas.getBoundingClientRect();
        if (!rect.width || !rect.height) return null;

        const x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        const y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
        ndc.set(x, y);

        raycaster.setFromCamera(ndc, camera);
        const hits = raycaster.intersectObjects(world.children, true);
        for (const hit of hits) {
            if (isPickableObject(hit.object)) return hit;
        }
        return null;
    }

    function applyPick(hit) {
        if (disposed) return;
        const point = hit?.point;
        if (!point) return;
        const minDistance =
            Math.max(Number.isFinite(controls.minDistance) ? controls.minDistance : 0, 0.05);
        const desiredDistance = Math.max((hit.distance || 0) * approachRatio, minDistance);
        tmpDir.copy(camera.position).sub(point);
        if (tmpDir.lengthSq() < 1e-8) return;
        tmpDir.normalize();
        controls.target.copy(point);
        camera.position.copy(tmpTarget.copy(point).addScaledVector(tmpDir, desiredDistance));
        controls.update();
        requestRender();
    }

    function setActive(next) {
        if (disposed) return;
        const desired = !!next;
        if (desired === active) return;
        if (desired && isBlocked()) return;

        active = desired;
        pickBtn.classList.toggle('active', active);
        pickBtn.setAttribute('aria-pressed', active ? 'true' : 'false');

        if (active) {
            prevControlsEnabled = controls.enabled;
            controls.enabled = false;
            prevCursor = canvas.style.cursor || '';
            canvas.style.cursor = 'crosshair';
        } else {
            if (prevControlsEnabled != null) {
                controls.enabled = prevControlsEnabled;
            }
            prevControlsEnabled = null;
            canvas.style.cursor = prevCursor || '';
            prevCursor = '';
        }
    }

    function handlePointerDown(event) {
        if (disposed) return;
        if (!active) return;
        if (event.button !== 0) return;
        if (isBlocked()) return;
        const hit = pickHit(event);
        if (!hit) return;
        event.preventDefault();
        event.stopPropagation();
        applyPick(hit);
        setActive(false);
    }

    const listeners = [];
    function addListener(target, type, handler, options) {
        if (!target?.addEventListener) return;
        target.addEventListener(type, handler, options);
        listeners.push({ target, type, handler, options });
    }

    addListener(pickBtn, 'click', () => setActive(!active));
    addListener(canvas, 'pointerdown', handlePointerDown, { passive: false });

    function dispose() {
        if (disposed) return;
        setActive(false);
        disposed = true;
        while (listeners.length) {
            const { target, type, handler, options } = listeners.pop();
            try { target.removeEventListener(type, handler, options); } catch (_) {}
        }
    }

    return Object.freeze({
        setActive,
        isActive: () => !disposed && active,
        dispose,
    });
}
