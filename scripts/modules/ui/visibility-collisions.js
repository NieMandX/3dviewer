import { createCollisionVisibilityHelpers } from '../fbx/collisions.js';
import { createVisibilityController } from './visibility.js';

export function createVisibilityAndCollisions(options = {}) {
    const loadedModels = Array.isArray(options.loadedModels) ? options.loadedModels : [];
    const requestRender = typeof options.requestRender === 'function' ? options.requestRender : () => {};
    const markSceneStatsDirty = typeof options.markSceneStatsDirty === 'function' ? options.markSceneStatsDirty : () => {};
    const syncCollisionButtons = typeof options.syncCollisionButtons === 'function' ? options.syncCollisionButtons : () => {};

    const visibility = createVisibilityController({
        world: options.world || null,
        loadedModels,
        outEl: options.outEl || null,
        requestRender,
        markSceneStatsDirty,
    });

    const collisions = createCollisionVisibilityHelpers({
        loadedModels,
        schedulePanelRefresh: options.schedulePanelRefresh,
        updateEyeButtonsForTarget: visibility.updateEyeButtonsForTarget,
        setMeshAndMaterialsVisibility: visibility.setMeshAndMaterialsVisibility,
        syncCollisionButtons,
    });

    function getCollisionsState() {
        let hasAny = false;
        let anyVisible = false;
        loadedModels.forEach((model) => {
            if (!model?.obj) return;
            model.obj.traverse((o) => {
                if (!o?.userData?.isCollision) return;
                hasAny = true;
                if (o.visible !== false) anyVisible = true;
            });
        });
        return { hasAny, anyVisible };
    }

    function setCollisionsVisible(visible) {
        const next = !!visible;
        let hasAny = false;
        let changed = false;

        loadedModels.forEach((model) => {
            if (!model?.obj) return;
            model.obj.traverse((o) => {
                if (!o?.userData?.isCollision) return;
                hasAny = true;

                const mats = Array.isArray(o.material) ? o.material : [o.material];
                mats.forEach((m) => {
                    if (!m) return;
                    if (m.visible !== next) {
                        m.visible = next;
                        changed = true;
                    }
                });
                if (o.visible !== next) {
                    o.visible = next;
                    changed = true;
                }
            });
        });

        if (changed) {
            markSceneStatsDirty();
            syncCollisionButtons();
            requestRender();
        }

        const state = getCollisionsState();
        return { ...state, changed };
    }

    function toggleCollisionsVisible() {
        const state = getCollisionsState();
        if (!state.hasAny) return { ...state, changed: false };
        return setCollisionsVisible(!state.anyVisible);
    }

    return Object.freeze({
        visibility,
        handleEyeToggle: visibility.handleEyeToggle,
        updateEyeButtonsForTarget: visibility.updateEyeButtonsForTarget,
        setMeshAndMaterialsVisibility: visibility.setMeshAndMaterialsVisibility,
        ensureZipCollisionsHidden: collisions.ensureZipCollisionsHidden,
        hideSMCollisions: collisions.hideSMCollisions,
        getCollisionsState,
        setCollisionsVisible,
        toggleCollisionsVisible,
    });
}
