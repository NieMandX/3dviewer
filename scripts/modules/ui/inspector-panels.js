import { createMaterialsUI } from './materials-ui.js';
import { createTexturesUI } from './textures-ui.js';

export function createInspectorPanels(options = {}) {
    const materialsUi = createMaterialsUI({
        world: options.world,
        loadedModels: options.loadedModels,
        sceneIndex: options.sceneIndex,
        outEl: options.outEl,
        matSelect: options.matSelect,
        requestRender: options.requestRender,
        handleEyeToggle: options.handleEyeToggle,
        updateEyeButtonsForTarget: options.updateEyeButtonsForTarget,
        openGeoModal: options.openGeoModal,
        texInfo: options.texInfo,
        applyGlassControlsToScene: options.applyGlassControlsToScene,
    });
    const materialsPanel = materialsUi?.materialsPanel || null;

    function schedulePanelRefresh(afterRender) {
        materialsPanel?.scheduleRefresh?.(afterRender);
    }

    function syncCollisionButtons() {
        materialsPanel?.syncCollisionButtons?.();
        options.appbarVisibilityToggles?.enforceSuppressionIfNeeded?.();
        options.appbarVisibilityToggles?.updateAll?.();
    }

    const texturesUi = createTexturesUI({
        THREE: options.THREE,
        dom: options.dom,
        world: options.world,
        loadedModels: options.loadedModels,
        matSelectEl: options.matSelect,
        basename: options.basename,
        guessKindFromName: options.guessKindFromName,
        getSelectedMaterialLink: options.getSelectedMaterialLink,
        textureLoader: options.textureLoader,
        toStandard: options.toStandard,
        copyTextureSettings: options.copyTextureSettings,
        getEnvironment: options.getEnvironment,
        getEnvMapIntensity: options.getEnvMapIntensity,
        cacheOriginalMaterialFor: options.cacheOriginalMaterialFor,
        applyGlassControlsToScene: options.applyGlassControlsToScene,
        schedulePanelRefresh,
        requestRender: options.requestRender,
        logBind: options.logBind,
        markGalleryRendered: options.markGalleryRendered,
    });

    return Object.freeze({
        materialsPanel,
        renderGallery: texturesUi?.renderGallery,
        schedulePanelRefresh,
        syncCollisionButtons,
        dispose: () => {
            materialsPanel?.dispose?.();
            texturesUi?.dispose?.();
        },
    });
}
