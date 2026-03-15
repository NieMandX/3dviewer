export function createLoadedModelSceneIndex(options = {}) {
    const loadedModels = Array.isArray(options.loadedModels) ? options.loadedModels : [];
    let modelCache = new WeakMap();

    function resolveRoot(target) {
        if (!target) return null;
        if (target.obj) return target.obj;
        return target;
    }

    function buildModelEntry(root) {
        const collisions = [];
        const renderables = [];
        const panelTargets = new Map();

        root?.traverse?.((obj) => {
            if (!obj) return;

            const panelId = String(obj.userData?._panelId || '').trim();
            if (panelId) panelTargets.set(panelId, obj);

            if (obj.isMesh && obj.userData?.isCollision) {
                collisions.push(obj);
                return;
            }

            if (obj.isMesh || obj.isLine || obj.isPoints) {
                renderables.push(obj);
            }
        });

        return {
            collisions,
            renderables,
            panelTargets,
        };
    }

    function getModelEntry(target) {
        const root = resolveRoot(target);
        if (!root) {
            return {
                collisions: [],
                renderables: [],
                panelTargets: new Map(),
            };
        }

        let entry = modelCache.get(root);
        if (!entry) {
            entry = buildModelEntry(root);
            modelCache.set(root, entry);
        }
        return entry;
    }

    function invalidateModel(target) {
        const root = resolveRoot(target);
        if (!root) return;
        modelCache.delete(root);
    }

    function invalidateAll() {
        modelCache = new WeakMap();
    }

    function getModelCollisions(target) {
        return getModelEntry(target).collisions;
    }

    function getModelRenderables(target, options = {}) {
        const root = resolveRoot(target);
        const excludeRoot = !!options?.excludeRoot;
        const renderables = getModelEntry(root).renderables;
        if (!excludeRoot || !root) return renderables;
        return renderables.filter((obj) => obj !== root);
    }

    function findPanelTarget(panelId) {
        const targetId = String(panelId || '').trim();
        if (!targetId) return null;

        for (const model of loadedModels) {
            const target = getModelEntry(model).panelTargets.get(targetId);
            if (target) return target;
        }
        return null;
    }

    function findModelByRootUuid(uuid) {
        const targetUuid = String(uuid || '').trim();
        if (!targetUuid) return null;
        return loadedModels.find((model) => String(model?.obj?.uuid || '') === targetUuid) || null;
    }

    return Object.freeze({
        invalidateModel,
        invalidateAll,
        getModelCollisions,
        getModelRenderables,
        findPanelTarget,
        findModelByRootUuid,
    });
}
