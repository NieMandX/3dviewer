import { createCollisionVisibilityHelpers } from '../fbx/collisions.js';
import { createVisibilityController } from './visibility.js';

export function createVisibilityAndCollisions(options = {}) {
    const visibility = createVisibilityController({
        world: options.world || null,
        loadedModels: Array.isArray(options.loadedModels) ? options.loadedModels : [],
        outEl: options.outEl || null,
        requestRender: options.requestRender,
        markSceneStatsDirty: options.markSceneStatsDirty,
    });

    const collisions = createCollisionVisibilityHelpers({
        loadedModels: Array.isArray(options.loadedModels) ? options.loadedModels : [],
        schedulePanelRefresh: options.schedulePanelRefresh,
        updateEyeButtonsForTarget: visibility.updateEyeButtonsForTarget,
        setMeshAndMaterialsVisibility: visibility.setMeshAndMaterialsVisibility,
        syncCollisionButtons: options.syncCollisionButtons,
    });

    return Object.freeze({
        visibility,
        handleEyeToggle: visibility.handleEyeToggle,
        updateEyeButtonsForTarget: visibility.updateEyeButtonsForTarget,
        setMeshAndMaterialsVisibility: visibility.setMeshAndMaterialsVisibility,
        ensureZipCollisionsHidden: collisions.ensureZipCollisionsHidden,
        hideSMCollisions: collisions.hideSMCollisions,
    });
}

