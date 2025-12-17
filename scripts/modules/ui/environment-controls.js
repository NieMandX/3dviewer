export function createEnvironmentControlsController(options = {}) {
    const scene = options.scene || null;

    const iblChk = options.iblChk || null;
    const hdriPresetSel = options.hdriPresetSel || null;
    const presets = Array.isArray(options.presets) ? options.presets : null;
    const iblIntEl = options.iblIntEl || null;
    const iblGammaEl = options.iblGammaEl || null;
    const iblTintEl = options.iblTintEl || null;
    const iblRotEl = options.iblRotEl || null;
    const hdriExposureEl = options.hdriExposureEl || null;
    const hdriSaturationEl = options.hdriSaturationEl || null;
    const hdriBlurEl = options.hdriBlurEl || null;

    const setEnvironmentEnabled =
        typeof options.setEnvironmentEnabled === 'function' ? options.setEnvironmentEnabled : () => {};
    const setEnvironmentRotation =
        typeof options.setEnvironmentRotation === 'function' ? options.setEnvironmentRotation : () => {};
    const applyEnvToMaterials =
        typeof options.applyEnvToMaterials === 'function' ? options.applyEnvToMaterials : () => {};
    const requestEnvironmentRebuild =
        typeof options.requestEnvironmentRebuild === 'function' ? options.requestEnvironmentRebuild : () => {};
    const syncEnvAdjustmentsState =
        typeof options.syncEnvAdjustmentsState === 'function' ? options.syncEnvAdjustmentsState : () => {};

    const getCurrentEnv = typeof options.getCurrentEnv === 'function' ? options.getCurrentEnv : () => null;
    const selectPresetIndex = typeof options.selectPresetIndex === 'function' ? options.selectPresetIndex : async () => {};

    function populateHdriPresets() {
        if (!hdriPresetSel || !presets) return;
        if (typeof document === 'undefined') return;

        const prev = hdriPresetSel.value;

        const placeholder = (() => {
            const existing = hdriPresetSel.querySelector?.('option[value=""]');
            return existing?.textContent || '— выберите —';
        })();

        hdriPresetSel.innerHTML = '';

        const placeholderOpt = document.createElement('option');
        placeholderOpt.value = '';
        placeholderOpt.textContent = placeholder;
        hdriPresetSel.appendChild(placeholderOpt);

        presets.forEach((preset, i) => {
            const opt = document.createElement('option');
            opt.value = String(i);
            opt.textContent = preset?.name || `Preset ${i + 1}`;
            hdriPresetSel.appendChild(opt);
        });

        if (prev && [...hdriPresetSel.options].some(o => o.value === prev)) {
            hdriPresetSel.value = prev;
        }
    }

    function scheduleEnvRebuildFromUI() {
        syncEnvAdjustmentsState();
        requestEnvironmentRebuild({ immediate: false });
    }

    function bind() {
        populateHdriPresets();
        syncEnvAdjustmentsState();

        iblChk?.addEventListener('change', () => setEnvironmentEnabled(!!iblChk.checked));

        iblIntEl?.addEventListener('input', () => {
            if (!iblChk?.checked) return;
            const env = scene?.environment || getCurrentEnv();
            if (!env) return;
            const raw = parseFloat(iblIntEl.value);
            const intensity = Number.isFinite(raw) ? raw : 1.0;
            applyEnvToMaterials(env, intensity);
        });

        iblGammaEl?.addEventListener('input', scheduleEnvRebuildFromUI);
        iblTintEl?.addEventListener('input', scheduleEnvRebuildFromUI);
        hdriExposureEl?.addEventListener('input', scheduleEnvRebuildFromUI);
        hdriSaturationEl?.addEventListener('input', scheduleEnvRebuildFromUI);
        hdriBlurEl?.addEventListener('input', scheduleEnvRebuildFromUI);

        iblRotEl?.addEventListener('input', () => {
            setEnvironmentRotation(parseFloat(iblRotEl?.value) || 0);
        });

        hdriPresetSel?.addEventListener('change', async (e) => {
            const idx = parseInt(e.target.value, 10);
            if (Number.isNaN(idx)) return;
            await selectPresetIndex(idx);
        });
    }

    bind();

    return {
        scheduleEnvRebuildFromUI,
        populateHdriPresets,
    };
}
