export function createHemiLightControlsController(options = {}) {
    const hemiLight = options.hemiLight || null;
    const hemiIntEl = options.hemiIntEl || null;
    const hemiSkyEl = options.hemiSkyEl || null;
    const hemiGroundEl = options.hemiGroundEl || null;

    const requestRender = typeof options.requestRender === 'function' ? options.requestRender : () => {};

    function applyFromInputs() {
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
        applyFromInputs();
        requestRender();
    }

    [hemiIntEl, hemiSkyEl, hemiGroundEl].filter(Boolean).forEach((el) => {
        el.addEventListener('input', syncAndRender);
        el.addEventListener('change', syncAndRender);
    });

    applyFromInputs();

    return {
        applyFromInputs,
    };
}
