import {
    configureParcels,
    createParcelsGroupFromGeoJSON,
    getVPMReferenceHeight,
    loadParcels,
} from '../parcels.js';

export function createMosParcelsController(options = {}) {
    const world = options.world || null;
    const app = options.app || null;
    const northGrid = options.northGrid || null;

    const isZUp = typeof options.isZUp === 'function' ? options.isZUp : () => false;
    const requestRender = typeof options.requestRender === 'function' ? options.requestRender : () => {};
    const schedulePanelRefresh = typeof options.schedulePanelRefresh === 'function' ? options.schedulePanelRefresh : () => {};
    const markSceneStatsDirty = typeof options.markSceneStatsDirty === 'function' ? options.markSceneStatsDirty : () => {};
    const setStatusMessage = typeof options.setStatusMessage === 'function' ? options.setStatusMessage : () => {};
    const loadParcelsImpl = typeof options.loadParcels === 'function' ? options.loadParcels : loadParcels;

    const logBind = typeof options.logBind === 'function' ? options.logBind : null;

    const config = options.config || {};
    const defaultFilter = config.filter ?? null;
    const defaultTargetGlobalId = config.targetGlobalId ?? null;

    configureParcels({
        apiKey: config.apiKey,
        datasetId: config.datasetId,
        baseUrl: config.baseUrl,
        filter: defaultFilter,
        targetGlobalId: defaultTargetGlobalId,
        resetOrigin: config.resetOrigin ?? true,
    });

    let parcelsGroup = null;
    let parcelsOrigin = null;
    let disposed = false;
    let loadGeneration = 0;
    let activeLoadController = null;

    const uiListeners = [];
    function addUIListener(target, type, handler, options) {
        if (!target?.addEventListener) return;
        target.addEventListener(type, handler, options);
        uiListeners.push({ target, type, handler, options });
    }

    function disposeUI() {
        while (uiListeners.length) {
            const { target, type, handler, options } = uiListeners.pop();
            try { target.removeEventListener(type, handler, options); } catch (_) {}
        }
    }

    function bindUI(ui = {}) {
        const loadParcelsBtn = ui.loadParcelsBtn || null;
        const loadOptions = ui.loadOptions || null;

        disposeUI();
        addUIListener(loadParcelsBtn, 'click', () => loadMosParcels(loadOptions || undefined));
    }

    function setAppLayer(group) {
        if (!app) return;
        if (!app.layers) app.layers = { parcels: null };
        app.layers.parcels = group || null;
    }

    function buildParcelsGroup(geojson, overrides = {}) {
        return createParcelsGroupFromGeoJSON(geojson, {
            origin: parcelsOrigin,
            verticalIsZ: isZUp(),
            referenceHeight: overrides.referenceHeight ?? getVPMReferenceHeight(),
        });
    }

    function disposeParcelsGroup(group) {
        if (!group?.traverse) return;
        group.traverse(o => {
            o.geometry?.dispose?.();
            const material = o.material;
            if (Array.isArray(material)) {
                material.forEach((entry) => entry?.dispose?.());
            } else {
                material?.dispose?.();
            }
        });
    }

    function makeAbortError(message = 'MOS parcels load superseded') {
        try {
            return new DOMException(message, 'AbortError');
        } catch (_) {
            const err = new Error(message);
            err.name = 'AbortError';
            return err;
        }
    }

    function isAbortError(err) {
        return err?.name === 'AbortError';
    }

    function abortActiveLoad() {
        const controller = activeLoadController;
        activeLoadController = null;
        if (!controller || controller.signal?.aborted) return;
        try {
            controller.abort(makeAbortError());
        } catch (_) {}
    }

    function disposeCurrentParcels() {
        if (!parcelsGroup) return;

        world?.remove?.(parcelsGroup);
        disposeParcelsGroup(parcelsGroup);
        parcelsGroup = null;

        northGrid?.setParcelsGroup?.(null);
        setAppLayer(null);
        markSceneStatsDirty();
        requestRender();
    }

    async function loadMosParcels(options = {}) {
        if (disposed) return null;
        abortActiveLoad();
        const generation = ++loadGeneration;
        const {
            fetchAll = true,
            batchSize = 200,
            maxRecords = defaultTargetGlobalId ? 1 : 10000,
            initialTop = 200,
            filter = defaultFilter,
            targetGlobalId = defaultTargetGlobalId,
            referenceHeight,
            signal: externalSignal = null,
        } = options;
        const loadController = typeof AbortController === 'function' ? new AbortController() : null;
        activeLoadController = loadController;
        const signal = loadController?.signal || externalSignal || null;
        let externalAbortHandler = null;
        const isCurrent = () => (
            !disposed
            && generation === loadGeneration
            && !signal?.aborted
            && !externalSignal?.aborted
        );

        if (externalSignal?.addEventListener && loadController) {
            externalAbortHandler = () => {
                if (!loadController.signal?.aborted) {
                    try {
                        loadController.abort(externalSignal.reason || makeAbortError());
                    } catch (_) {}
                }
            };
            externalSignal.addEventListener('abort', externalAbortHandler, { once: true });
            if (externalSignal.aborted) externalAbortHandler();
        }

        try {
            setStatusMessage('Загрузка участков data.mos.ru…');

            const { features } = await loadParcelsImpl({
                fetchAll,
                batchSize,
                initialTop,
                maxRecords,
                filter,
                targetGlobalId,
                signal,
                onProgress: ({ collectedCount, processedCount }) => {
                    if (!isCurrent()) return;
                    setStatusMessage(`Загрузка участков… найдено ${collectedCount} из ${processedCount}`);
                },
            });

            if (!isCurrent()) return null;

            if (!features.length) {
                setStatusMessage('Участки не найдены');
                return null;
            }

            const aggregated = { type: 'FeatureCollection', features };
            const group = buildParcelsGroup(aggregated, { referenceHeight });
            if (!group) {
                setStatusMessage(`Участки не найдены (0 контуров среди ${features.length} записей)`);
                return null;
            }

            if (!isCurrent()) {
                disposeParcelsGroup(group);
                return null;
            }

            if (parcelsGroup) {
                world?.remove?.(parcelsGroup);
                disposeParcelsGroup(parcelsGroup);
                markSceneStatsDirty();
            }

            parcelsGroup = group;
            parcelsOrigin = group.userData?.originMeters || parcelsOrigin;

            world?.add?.(parcelsGroup);
            northGrid?.setParcelsGroup?.(parcelsGroup);
            northGrid?.alignParcelsGroupToNorth?.();
            setAppLayer(parcelsGroup);
            markSceneStatsDirty();

            logBind?.(`MOS parcels: загружено ${group.children.length} контуров (обработано ${features.length})`, 'info');
            schedulePanelRefresh();
            requestRender();
            setStatusMessage('');
            return group;
        } catch (err) {
            if (!isCurrent() || isAbortError(err)) return null;
            console.error(err);
            setStatusMessage('Не удалось загрузить участки: ' + (err?.message || err));
            return null;
        } finally {
            if (activeLoadController === loadController) activeLoadController = null;
            if (externalSignal?.removeEventListener && externalAbortHandler) {
                try { externalSignal.removeEventListener('abort', externalAbortHandler); } catch (_) {}
            }
        }
    }

    function getParcelsGroup() {
        return parcelsGroup;
    }

    function getParcelsOrigin() {
        return parcelsOrigin;
    }

    function dispose() {
        if (disposed) return;
        disposed = true;
        loadGeneration += 1;
        abortActiveLoad();
        disposeUI();
        disposeCurrentParcels();
    }

    return {
        bindUI,
        disposeUI,
        dispose,
        loadMosParcels,
        disposeCurrentParcels,
        getParcelsGroup,
        getParcelsOrigin,
    };
}
