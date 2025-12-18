import { createCollisionVisibilityHelpers } from '../fbx/collisions.js';
import { findGeomSuffix, isGlassByName, isGlassGeomSuffix } from '../material/naming.js';
import { createVisibilityController } from './visibility.js';

export function createVisibilityAndCollisions(options = {}) {
    const loadedModels = Array.isArray(options.loadedModels) ? options.loadedModels : [];
    const world = options.world || null;
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

    function isGlassRenderable(obj) {
        if (!obj?.isMesh) return false;

        if (obj.userData?.glassInfo || obj.userData?.glassOverrides) return true;

        const labels = [obj.name, obj.geometry?.name];

        const mats = [];
        const direct = Array.isArray(obj.material) ? obj.material : [obj.material];
        direct.forEach((m) => { if (m) mats.push(m); });
        const orig = obj.userData?._origMaterial;
        const origArr = Array.isArray(orig) ? orig : orig ? [orig] : [];
        origArr.forEach((m) => { if (m && !mats.includes(m)) mats.push(m); });

        mats.forEach((m) => {
            labels.push(m?.name);
        });

        for (const label of labels) {
            if (!label) continue;
            if (isGlassByName(label)) return true;
            const suffix = findGeomSuffix(label);
            if (isGlassGeomSuffix(suffix)) return true;
            if (/\bglass\b/i.test(String(label))) return true;
        }

        for (const m of mats) {
            if (!m) continue;
            if (m.userData?.glassInfo || m.userData?.glassOverrides) return true;
            const transmission = Number(m.transmission);
            if (Number.isFinite(transmission) && transmission > 0.01) return true;
            const opacity = Number(m.opacity);
            if (Number.isFinite(opacity) && opacity < 0.99 && m.transparent) return true;
        }

        return false;
    }

    function getNonGlassState() {
        let hasAny = false;
        let anyVisible = false;
        if (!world) return { hasAny, anyVisible, suppressed: nonGlassSuppressed };

        world.traverse((o) => {
            if (anyVisible) return;
            if (!(o?.isMesh || o?.isLine || o?.isPoints)) return;
            if (isGlassRenderable(o)) return;
            hasAny = true;

            const mats = Array.isArray(o.material) ? o.material : [o.material];
            const anyMatVisible = mats.some((m) => (m ? m.visible !== false : false));
            if (o.visible !== false && anyMatVisible) anyVisible = true;
        });

        return { hasAny, anyVisible, suppressed: nonGlassSuppressed };
    }

    let nonGlassSuppressed = false;
    const savedNonGlassObjectVisibility = new Map();
    const savedNonGlassMaterialVisibility = new Map();

    function applyNonGlassSuppression({ captureNew = false } = {}) {
        if (!world) return { ...getNonGlassState(), changed: false };

        let changed = false;
        world.traverse((o) => {
            if (!(o?.isMesh || o?.isLine || o?.isPoints)) return;
            if (isGlassRenderable(o)) return;

            if (captureNew && !savedNonGlassObjectVisibility.has(o)) {
                savedNonGlassObjectVisibility.set(o, o.visible !== false);
            }
            if (o.visible !== false) {
                o.visible = false;
                changed = true;
            }

            const mats = Array.isArray(o.material) ? o.material : [o.material];
            mats.forEach((m) => {
                if (!m) return;
                if (captureNew && !savedNonGlassMaterialVisibility.has(m)) {
                    savedNonGlassMaterialVisibility.set(m, m.visible !== false);
                }
                if (m.visible !== false) {
                    m.visible = false;
                    changed = true;
                }
                if ('needsUpdate' in m) m.needsUpdate = true;
            });
        });

        if (changed) {
            markSceneStatsDirty();
            requestRender();
        }

        return { ...getNonGlassState(), changed };
    }

    function restoreNonGlassFromSuppression() {
        let changed = false;

        savedNonGlassObjectVisibility.forEach((wasVisible, obj) => {
            if (!obj) return;
            const next = wasVisible !== false;
            if (obj.visible !== next) {
                obj.visible = next;
                changed = true;
            }
        });

        savedNonGlassMaterialVisibility.forEach((wasVisible, mat) => {
            if (!mat) return;
            const next = wasVisible !== false;
            if (mat.visible !== next) {
                mat.visible = next;
                changed = true;
            }
            if ('needsUpdate' in mat) mat.needsUpdate = true;
        });

        savedNonGlassObjectVisibility.clear();
        savedNonGlassMaterialVisibility.clear();

        if (changed) {
            markSceneStatsDirty();
            requestRender();
        }

        return { ...getNonGlassState(), changed };
    }

    function setNonGlassSuppressed(nextSuppressed) {
        const next = !!nextSuppressed;
        if (next === nonGlassSuppressed) {
            if (next) return applyNonGlassSuppression({ captureNew: true });
            return { ...getNonGlassState(), changed: false };
        }

        if (next) {
            savedNonGlassObjectVisibility.clear();
            savedNonGlassMaterialVisibility.clear();
            nonGlassSuppressed = true;
            return applyNonGlassSuppression({ captureNew: true });
        }

        nonGlassSuppressed = false;
        return restoreNonGlassFromSuppression();
    }

    function toggleNonGlassSuppressed() {
        return setNonGlassSuppressed(!nonGlassSuppressed);
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
        getNonGlassState,
        setNonGlassSuppressed,
        toggleNonGlassSuppressed,
        applyNonGlassSuppression,
        getVPMModelsState,
        setVPMModelsVisible,
        toggleVPMModelsVisible,
        getNPMModelsState,
        setNPMModelsVisible,
        toggleNPMModelsVisible,
    });
}
