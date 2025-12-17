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

    function disposeCurrentParcels() {
        if (!parcelsGroup) return;

        world?.remove?.(parcelsGroup);
        parcelsGroup.traverse(o => o.geometry?.dispose?.());
        parcelsGroup = null;

        northGrid?.setParcelsGroup?.(null);
        setAppLayer(null);
        markSceneStatsDirty();
        requestRender();
    }

    async function loadMosParcels(options = {}) {
        const {
            fetchAll = true,
            batchSize = 200,
            maxRecords = defaultTargetGlobalId ? 1 : 10000,
            initialTop = 200,
            filter = defaultFilter,
            targetGlobalId = defaultTargetGlobalId,
            referenceHeight,
        } = options;

        try {
            setStatusMessage('Загрузка участков data.mos.ru…');

            const { features } = await loadParcels({
                fetchAll,
                batchSize,
                initialTop,
                maxRecords,
                filter,
                targetGlobalId,
                onProgress: ({ collectedCount, processedCount }) => {
                    setStatusMessage(`Загрузка участков… найдено ${collectedCount} из ${processedCount}`);
                },
            });

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

            if (parcelsGroup) {
                world?.remove?.(parcelsGroup);
                parcelsGroup.traverse(o => o.geometry?.dispose?.());
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
            console.error(err);
            setStatusMessage('Не удалось загрузить участки: ' + (err?.message || err));
            return null;
        }
    }

    function getParcelsGroup() {
        return parcelsGroup;
    }

    function getParcelsOrigin() {
        return parcelsOrigin;
    }

    return {
        bindUI,
        disposeUI,
        loadMosParcels,
        disposeCurrentParcels,
        getParcelsGroup,
        getParcelsOrigin,
    };
}
