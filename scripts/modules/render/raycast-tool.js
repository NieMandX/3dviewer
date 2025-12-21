export function createRaycastTool(options = {}) {
    const THREE = options.THREE || null;
    const world = options.world || null;
    const camera = options.camera || null;
    const renderer = options.renderer || null;
    const rayToggleBtn = options.rayToggleBtn || null;
    const requestRender = typeof options.requestRender === 'function' ? options.requestRender : () => {};
    const setStatusMessage = typeof options.setStatusMessage === 'function' ? options.setStatusMessage : () => {};

    if (!THREE) throw new Error('createRaycastTool: THREE is required');

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();

    let enabled = false;
    let lastMessage = '';

    function isPickable(obj) {
        if (!obj?.isMesh) return false;
        if (!obj.visible) return false;
        const ud = obj.userData || {};
        if (ud.excludeFromRaycast) return false;
        if (ud.excludeFromBounds) return false;
        if (ud._isBackfaceOverlay) return false;
        if (ud.lightHelper) return false;
        if (ud.isCollision) return false;
        return true;
    }

    function setEnabled(next) {
        const value = !!next;
        if (enabled === value) return;
        enabled = value;
        rayToggleBtn?.classList?.toggle?.('active', enabled);
        if (rayToggleBtn?.setAttribute) {
            rayToggleBtn.setAttribute('aria-pressed', enabled ? 'true' : 'false');
        }

        if (enabled) {
            renderer?.domElement?.addEventListener?.('click', handleClick);
            lastMessage = 'Ray: кликните по объекту';
            setStatusMessage(lastMessage);
        } else {
            renderer?.domElement?.removeEventListener?.('click', handleClick);
            if (lastMessage) {
                setStatusMessage('');
                lastMessage = '';
            }
        }
    }

    function toggle() {
        setEnabled(!enabled);
    }

    function formatNumber(v) {
        if (!Number.isFinite(v)) return '—';
        const abs = Math.abs(v);
        if (abs >= 1000) return v.toFixed(1);
        if (abs >= 10) return v.toFixed(2);
        return v.toFixed(3);
    }

    function handleClick(event) {
        if (!enabled) return;
        if (!world || !camera || !renderer?.domElement) return;
        if (event?.button != null && event.button !== 0) return;

        const rect = renderer.domElement.getBoundingClientRect?.();
        if (!rect?.width || !rect?.height) return;

        pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

        raycaster.setFromCamera(pointer, camera);

        const hits = raycaster.intersectObject(world, true);
        const hit = hits.find((h) => isPickable(h.object));
        if (!hit) {
            lastMessage = 'Ray: нет пересечений';
            setStatusMessage(lastMessage);
            return;
        }

        const obj = hit.object;
        const name = obj.name || obj.geometry?.name || obj.material?.name || obj.type || obj.uuid;
        const p = hit.point;
        const msg =
            `Ray: ${name} · d=${formatNumber(hit.distance)} · p=${formatNumber(p.x)}, ${formatNumber(p.y)}, ${formatNumber(p.z)}`;
        lastMessage = msg;
        setStatusMessage(msg);
        requestRender();
    }

    if (rayToggleBtn?.addEventListener) {
        rayToggleBtn.addEventListener('click', toggle);
    }

    return Object.freeze({
        isEnabled: () => enabled,
        setEnabled,
        toggle,
    });
}

