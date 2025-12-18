import { createGlassOverridesController } from './glass-overrides.js';
import { createMaterialsPanelController } from './materials-panel.js';

export function createMaterialsUI(options = {}) {
    const requestRender = typeof options.requestRender === 'function' ? options.requestRender : () => {};
    const applyGlassControlsToScene =
        typeof options.applyGlassControlsToScene === 'function' ? options.applyGlassControlsToScene : () => {};

    const handleEyeToggle = typeof options.handleEyeToggle === 'function' ? options.handleEyeToggle : () => {};
    const updateEyeButtonsForTarget =
        typeof options.updateEyeButtonsForTarget === 'function' ? options.updateEyeButtonsForTarget : () => {};
    const openGeoModal = typeof options.openGeoModal === 'function' ? options.openGeoModal : () => {};

    let materialsPanel = null;
    const glassOverrides = createGlassOverridesController({
        requestRender,
        applyGlassControlsToScene,
        resolveGlassMaterial: (uuid, matIndex) => materialsPanel?.resolveGlassMaterial?.(uuid, matIndex) || null,
    });

    const {
        handleGlassSliderInput,
        handleGlassColorInput,
        formatColorForDisplay,
    } = glassOverrides;

    materialsPanel = createMaterialsPanelController({
        world: options.world || null,
        loadedModels: Array.isArray(options.loadedModels) ? options.loadedModels : [],
        outEl: options.outEl || null,
        matSelect: options.matSelect || null,
        requestRender,
        handleEyeToggle,
        updateEyeButtonsForTarget,
        openGeoModal,
        handleGlassSliderInput,
        handleGlassColorInput,
        texInfo: options.texInfo,
        formatColorForDisplay,
    });

    return { materialsPanel };
}

