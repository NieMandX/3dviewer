export function createBatchFinalizer(options = {}) {
    const loadedModels = Array.isArray(options.loadedModels) ? options.loadedModels : [];
    const allEmbedded = Array.isArray(options.allEmbedded) ? options.allEmbedded : [];

    const getLastFinalizedModelIndex =
        typeof options.getLastFinalizedModelIndex === 'function' ? options.getLastFinalizedModelIndex : () => 0;
    const setLastFinalizedModelIndex =
        typeof options.setLastFinalizedModelIndex === 'function' ? options.setLastFinalizedModelIndex : () => {};

    const getGalleryNeedsRefresh =
        typeof options.getGalleryNeedsRefresh === 'function' ? options.getGalleryNeedsRefresh : () => false;
    const setGalleryNeedsRefresh =
        typeof options.setGalleryNeedsRefresh === 'function' ? options.setGalleryNeedsRefresh : () => {};
    const renderGallery = typeof options.renderGallery === 'function' ? options.renderGallery : () => {};

    const getDidInitialRebase = typeof options.getDidInitialRebase === 'function' ? options.getDidInitialRebase : () => false;
    const setDidInitialRebase = typeof options.setDidInitialRebase === 'function' ? options.setDidInitialRebase : () => {};
    const computeAutoOffsetHorizontalOnly =
        typeof options.computeAutoOffsetHorizontalOnly === 'function' ? options.computeAutoOffsetHorizontalOnly : () => null;
    const setWorldOffset = typeof options.setWorldOffset === 'function' ? options.setWorldOffset : () => {};

    const isIBLEnabled = typeof options.isIBLEnabled === 'function' ? options.isIBLEnabled : () => false;
    const getIBLRotation = typeof options.getIBLRotation === 'function' ? options.getIBLRotation : () => 0;
    const loadHDRBase = typeof options.loadHDRBase === 'function' ? options.loadHDRBase : async () => {};
    const buildAndApplyEnvFromRotation =
        typeof options.buildAndApplyEnvFromRotation === 'function' ? options.buildAndApplyEnvFromRotation : async () => {};
    const syncBackgroundToEnvironment =
        typeof options.syncBackgroundToEnvironment === 'function' ? options.syncBackgroundToEnvironment : () => {};

    const applyGlassControlsToScene =
        typeof options.applyGlassControlsToScene === 'function' ? options.applyGlassControlsToScene : () => {};
    const fitSunShadowToScene = typeof options.fitSunShadowToScene === 'function' ? options.fitSunShadowToScene : () => {};
    const updateSun = typeof options.updateSun === 'function' ? options.updateSun : () => {};

    const buildVPMIndex = typeof options.buildVPMIndex === 'function' ? options.buildVPMIndex : () => null;
    const autoBindVPMForModel =
        typeof options.autoBindVPMForModel === 'function' ? options.autoBindVPMForModel : async () => {};
    const logBind = typeof options.logBind === 'function' ? options.logBind : () => {};
    const ensureZipCollisionsHidden =
        typeof options.ensureZipCollisionsHidden === 'function' ? options.ensureZipCollisionsHidden : () => {};

    const fitAll = typeof options.fitAll === 'function' ? options.fitAll : () => {};
    const focusOn = typeof options.focusOn === 'function' ? options.focusOn : () => {};
    const onInitialFraming =
        typeof options.onInitialFraming === 'function' ? options.onInitialFraming : () => {};

    const outEl = options.outEl || null;
    const imagesDetails = options.imagesDetails || null;
    const bindLogDetails = options.bindLogDetails || null;
    const hideSMCollisions = typeof options.hideSMCollisions === 'function' ? options.hideSMCollisions : () => false;
    const syncCollisionButtons =
        typeof options.syncCollisionButtons === 'function' ? options.syncCollisionButtons : () => {};

    const setStatusMessage = typeof options.setStatusMessage === 'function' ? options.setStatusMessage : () => {};
    const setEmptyHintVisible = typeof options.setEmptyHintVisible === 'function' ? options.setEmptyHintVisible : () => {};

    const applyShading = typeof options.applyShading === 'function' ? options.applyShading : (_mode, done) => done?.();
    const getCurrentShadingMode =
        typeof options.getCurrentShadingMode === 'function' ? options.getCurrentShadingMode : () => 'pbr';

    let disposed = false;
    let finalizeGeneration = 0;

    function isCurrent(generation) {
        return !disposed && generation === finalizeGeneration;
    }

    async function finalizeBatchAfterAllFiles() {
        if (disposed || !loadedModels.length) return false;
        const generation = ++finalizeGeneration;

        const newModels = loadedModels.slice(getLastFinalizedModelIndex());
        const hasNewModels = newModels.length > 0;
        const needGalleryRefresh = getGalleryNeedsRefresh();

        if (!hasNewModels && !needGalleryRefresh) {
            if (!isCurrent(generation)) return false;
            setStatusMessage('Готово');
            setEmptyHintVisible(loadedModels.length === 0);
            return true;
        }

        if (needGalleryRefresh) {
            if (!isCurrent(generation)) return false;
            renderGallery(allEmbedded);
            if (!isCurrent(generation)) return false;
            setGalleryNeedsRefresh(false);
        }

        // — ребейз только один раз —
        let firstTime = false;
        if (!getDidInitialRebase() && hasNewModels) {
            const off = computeAutoOffsetHorizontalOnly();
            if (!isCurrent(generation)) return false;
            setWorldOffset(off);
            setDidInitialRebase(true);
            firstTime = true;
        }

        if (hasNewModels) {
            if (isIBLEnabled()) {
                await loadHDRBase();
                if (!isCurrent(generation)) return false;
                await buildAndApplyEnvFromRotation(getIBLRotation());
                if (!isCurrent(generation)) return false;
            }

            if (!isCurrent(generation)) return false;
            syncBackgroundToEnvironment();

            applyGlassControlsToScene();
            fitSunShadowToScene(true);
            updateSun();
        }

        const newSmModels = newModels.filter(m => (m.zipKind || '').toUpperCase() === 'SM');
        let modelsForBinding = newSmModels;
        if (!modelsForBinding.length && needGalleryRefresh) {
            modelsForBinding = loadedModels.filter(m => (m.zipKind || '').toUpperCase() === 'SM');
        }

        if (modelsForBinding.length) {
            try {
                const vpmIndex = buildVPMIndex(allEmbedded);
                for (const m of modelsForBinding) {
                    if (!isCurrent(generation)) return false;
                    await autoBindVPMForModel(m.obj, vpmIndex);
                    if (!isCurrent(generation)) return false;
                }
            } catch (e) {
                if (!isCurrent(generation)) return false;
                logBind(`⚠️ VPM: ошибка автопривязки — ${e?.message || e}`, 'warn');
            }
        }

        if (hasNewModels) {
            if (!isCurrent(generation)) return false;
            const smGroups = new Set();
            newModels.forEach(model => {
                if ((model.zipKind || '').toUpperCase() !== 'SM') return;
                if (model.group) smGroups.add(model.group);
            });
            smGroups.forEach(groupName => ensureZipCollisionsHidden(groupName));

            if (firstTime) {
                fitAll();
                focusOn(loadedModels.map(m => m.obj));
                onInitialFraming();
            }
        }

        const finalizeUI = () => {
            if (!isCurrent(generation)) return;
            outEl.querySelectorAll('details[data-level="group"], details[data-level="file"]').forEach(d => d.open = false);
            if (firstTime) {
                if (imagesDetails) imagesDetails.open = false;
                if (bindLogDetails) bindLogDetails.open = false;
            }

            const hiddenAgain = hasNewModels ? hideSMCollisions(false) : false;
            if (hasNewModels || hiddenAgain) {
                syncCollisionButtons();
            }

            setStatusMessage('Готово');
            setEmptyHintVisible(loadedModels.length === 0);
        };

        if (hasNewModels) {
            if (!isCurrent(generation)) return false;
            applyShading(getCurrentShadingMode(), finalizeUI);
        } else {
            finalizeUI();
        }

        if (hasNewModels) {
            if (!isCurrent(generation)) return false;
            setLastFinalizedModelIndex(loadedModels.length);
        }
        return true;
    }

    function dispose() {
        if (disposed) return;
        disposed = true;
        finalizeGeneration += 1;
    }

    return { finalizeBatchAfterAllFiles, dispose };
}
