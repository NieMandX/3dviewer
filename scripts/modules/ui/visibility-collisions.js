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

    function isVPMModel(model) {
        return String(model?.zipKind || '').toUpperCase() === 'SM';
    }

    function isNPMModel(model) {
        const kind = String(model?.zipKind || '').toUpperCase();
        return kind !== 'SM';
    }

    function getVPMModelsState() {
        let hasAny = false;
        let anyVisible = false;
        loadedModels.forEach((model) => {
            if (!isVPMModel(model)) return;
            hasAny = true;
            if (!model?.obj || model.obj.visible === false) return;
            let hasRenderable = false;
            model.obj.traverse((o) => {
                if (anyVisible) return;
                if (o === model.obj) return;
                if (o?.userData?.isCollision) return;
                if (!(o?.isMesh || o?.isLine || o?.isPoints)) return;
                hasRenderable = true;
                if (o.visible !== false) anyVisible = true;
            });
            if (!hasRenderable) {
                // если в модели нет геометрии/линий/поинтов — считаем как "не видимую"
                // (но сам факт наличия модели учитываем через hasAny)
            }
        });
        return { hasAny, anyVisible };
    }

    function setVPMModelsVisible(visible) {
        const next = !!visible;
        let changed = false;

        loadedModels.forEach((model) => {
            if (!isVPMModel(model)) return;
            const root = model?.obj;
            if (!root) return;
            root.traverse((o) => {
                if (o === root) return;
                if (o?.userData?.isCollision) return;
                if (!(o?.isMesh || o?.isLine || o?.isPoints)) return;

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

            // синхронизируем иконку "файл" (file-root eye) по целевому id
            const modelId = `file-${root.uuid}`;
            try { visibility.updateEyeButtonsForTarget(modelId, next); } catch (_) {}
        });

        if (changed) {
            markSceneStatsDirty();
            requestRender();
        }

        const state = getVPMModelsState();
        return { ...state, changed };
    }

    function toggleVPMModelsVisible() {
        const state = getVPMModelsState();
        if (!state.hasAny) return { ...state, changed: false };
        return setVPMModelsVisible(!state.anyVisible);
    }

    function getNPMModelsState() {
        let hasAny = false;
        let anyVisible = false;
        loadedModels.forEach((model) => {
            if (!isNPMModel(model)) return;
            hasAny = true;
            if (!model?.obj || model.obj.visible === false) return;
            let hasRenderable = false;
            model.obj.traverse((o) => {
                if (anyVisible) return;
                if (o === model.obj) return;
                if (o?.userData?.isCollision) return;
                if (!(o?.isMesh || o?.isLine || o?.isPoints)) return;
                hasRenderable = true;
                if (o.visible !== false) anyVisible = true;
            });
            if (!hasRenderable) {
                // нет renderables → считаем как "не видимую"
            }
        });
        return { hasAny, anyVisible };
    }

    function setNPMModelsVisible(visible) {
        const next = !!visible;
        let changed = false;

        loadedModels.forEach((model) => {
            if (!isNPMModel(model)) return;
            const root = model?.obj;
            if (!root) return;
            root.traverse((o) => {
                if (o === root) return;
                if (o?.userData?.isCollision) return;
                if (!(o?.isMesh || o?.isLine || o?.isPoints)) return;

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

            const modelId = `file-${root.uuid}`;
            try { visibility.updateEyeButtonsForTarget(modelId, next); } catch (_) {}
        });

        if (changed) {
            markSceneStatsDirty();
            requestRender();
        }

        const state = getNPMModelsState();
        return { ...state, changed };
    }

    function toggleNPMModelsVisible() {
        const state = getNPMModelsState();
        if (!state.hasAny) return { ...state, changed: false };
        return setNPMModelsVisible(!state.anyVisible);
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
        getVPMModelsState,
        setVPMModelsVisible,
        toggleVPMModelsVisible,
        getNPMModelsState,
        setNPMModelsVisible,
        toggleNPMModelsVisible,
    });
}
