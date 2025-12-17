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

    function handleHemiIntInput(e) {
        if (!hemiLight) return;
        const next = parseFloat(e?.target?.value);
        if (!Number.isFinite(next)) return;
        hemiLight.intensity = next;
        requestRender();
    }

    function handleSkyColorInput(e) {
        if (!hemiLight?.color?.set) return;
        const value = e?.target?.value;
        if (!value) return;
        hemiLight.color.set(value);
        requestRender();
    }

    function handleGroundColorInput(e) {
        if (!hemiLight?.groundColor?.set) return;
        const value = e?.target?.value;
        if (!value) return;
        hemiLight.groundColor.set(value);
        requestRender();
    }

    hemiIntEl?.addEventListener('input', handleHemiIntInput);
    hemiSkyEl?.addEventListener('input', handleSkyColorInput);
    hemiGroundEl?.addEventListener('input', handleGroundColorInput);

    applyFromInputs();

    return {
        applyFromInputs,
    };
}

