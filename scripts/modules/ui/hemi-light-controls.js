export function createHemiLightControlsController(options = {}) {
    const hemiLight = options.hemiLight || null;
    const hemiIntEl = options.hemiIntEl || null;
    const hemiSkyEl = options.hemiSkyEl || null;
    const hemiGroundEl = options.hemiGroundEl || null;

    const requestRender = typeof options.requestRender === 'function' ? options.requestRender : () => {};
    const onLightsUpdated = typeof options.onLightsUpdated === 'function' ? options.onLightsUpdated : () => {};
    const listeners = [];
    let disposed = false;

    function addListener(target, type, handler, options) {
        if (!target?.addEventListener || typeof handler !== 'function') return;
        target.addEventListener(type, handler, options);
        listeners.push({ target, type, handler, options });
    }

    function applyFromInputs() {
        if (disposed) return;
        if (!hemiLight) return;

        if (hemiIntEl) {
            const next = parseFloat(hemiIntEl.value);
            if (Number.isFinite(next)) hemiLight.intensity = next;
        }

        if (hemiSkyEl && hemiLight.color?.set) {
            hemiLight.color.set(hemiSkyEl.value);
        }

        if (hemiGroundEl && hemiLight.groundColor?.set) {
            hemiLight.groundColor.set(hemiGroundEl.value);
        }
    }

    function syncAndRender() {
        if (disposed) return;
        applyFromInputs();
        requestRender();
        onLightsUpdated();
    }

    [hemiIntEl, hemiSkyEl, hemiGroundEl].filter(Boolean).forEach((el) => {
        addListener(el, 'input', syncAndRender);
        addListener(el, 'change', syncAndRender);
    });

    applyFromInputs();

    function dispose() {
        if (disposed) return;
        disposed = true;
        while (listeners.length) {
            const { target, type, handler, options } = listeners.pop();
            try { target.removeEventListener(type, handler, options); } catch (_) {}
        }
    }

    return {
        applyFromInputs,
        dispose,
    };
}
