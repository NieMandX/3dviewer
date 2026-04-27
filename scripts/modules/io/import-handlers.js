import { createFBXFileHandler } from './fbx-file.js';
import { createZIPFileHandler } from './zip-file.js';

export function createImportHandlers(options = {}) {
    const THREE = options.THREE;
    const fbxLoader = options.fbxLoader || null;

    const basename = typeof options.basename === 'function' ? options.basename : (p) => (p || '').split(/[\\/]/).pop();

    const logSessionHeader = typeof options.logSessionHeader === 'function' ? options.logSessionHeader : () => {};
    const logBind = typeof options.logBind === 'function' ? options.logBind : () => {};
    const hideSidePanel = typeof options.hideSidePanel === 'function' ? options.hideSidePanel : () => {};
    const setStatusMessage = typeof options.setStatusMessage === 'function' ? options.setStatusMessage : () => {};
    const requestRender = typeof options.requestRender === 'function' ? options.requestRender : () => {};
    const schedulePanelRefresh = typeof options.schedulePanelRefresh === 'function' ? options.schedulePanelRefresh : () => {};

    const parseFBXInWorker = typeof options.parseFBXInWorker === 'function' ? options.parseFBXInWorker : null;
    const parseFBXOnMainThread = typeof options.parseFBXOnMainThread === 'function' ? options.parseFBXOnMainThread : null;
    const isWorkerSupported = typeof options.isWorkerSupported === 'function' ? options.isWorkerSupported : () => false;
    const setWorkerSupported = typeof options.setWorkerSupported === 'function' ? options.setWorkerSupported : () => {};
    const disableWorker = typeof options.disableWorker === 'function' ? options.disableWorker : () => {};

    const extractImagesFromFBX = typeof options.extractImagesFromFBX === 'function' ? options.extractImagesFromFBX : null;
    const sniffImage = typeof options.sniffImage === 'function' ? options.sniffImage : null;

    const allEmbedded = Array.isArray(options.allEmbedded) ? options.allEmbedded : [];
    const markGalleryNeedsRefresh =
        typeof options.markGalleryNeedsRefresh === 'function' ? options.markGalleryNeedsRefresh : () => {};

    const world = options.world || null;
    const loadedModels = Array.isArray(options.loadedModels) ? options.loadedModels : [];

    const determineOrientationType = typeof options.determineOrientationType === 'function' ? options.determineOrientationType : () => ({ type: 'unknown' });
    const describeOrientationType = typeof options.describeOrientationType === 'function' ? options.describeOrientationType : (t) => String(t || 'unknown');
    const describeFBXOrientation = typeof options.describeFBXOrientation === 'function' ? options.describeFBXOrientation : () => '';
    const readFBXOrientationFromTree = typeof options.readFBXOrientationFromTree === 'function' ? options.readFBXOrientationFromTree : () => null;
    const parseOrientationFromNode = typeof options.parseOrientationFromNode === 'function' ? options.parseOrientationFromNode : () => null;
    const normalizeObjectOrientation =
        typeof options.normalizeObjectOrientation === 'function' ? options.normalizeObjectOrientation : () => {};

    const getSMOffset = typeof options.getSMOffset === 'function' ? options.getSMOffset : () => ({ x: 0, y: 0, z: 0 });
    const applyGeoOffsetByOrientation =
        typeof options.applyGeoOffsetByOrientation === 'function' ? options.applyGeoOffsetByOrientation : () => {};
    const setVPMReferenceHeight =
        typeof options.setVPMReferenceHeight === 'function' ? options.setVPMReferenceHeight : () => {};

    const restoreLightTargetsFromOrientation =
        typeof options.restoreLightTargetsFromOrientation === 'function' ? options.restoreLightTargetsFromOrientation : () => {};
    const disableShadowsOnImportedLights =
        typeof options.disableShadowsOnImportedLights === 'function' ? options.disableShadowsOnImportedLights : () => {};
    const ensureLightHelpers =
        typeof options.ensureLightHelpers === 'function' ? options.ensureLightHelpers : () => {};
    const renameMaterialsByFBXObject =
        typeof options.renameMaterialsByFBXObject === 'function' ? options.renameMaterialsByFBXObject : () => {};

    const markCollisionMeshes =
        typeof options.markCollisionMeshes === 'function' ? options.markCollisionMeshes : () => {};
    const splitAllMeshesByUDIM_SM =
        typeof options.splitAllMeshesByUDIM_SM === 'function' ? options.splitAllMeshesByUDIM_SM : () => {};
    const optimizeGlassMeshes =
        typeof options.optimizeGlassMeshes === 'function' ? options.optimizeGlassMeshes : () => {};

    const autoBindByNamesForModel =
        typeof options.autoBindByNamesForModel === 'function' ? options.autoBindByNamesForModel : () => {};

    const setImportedLightsEnabled =
        typeof options.setImportedLightsEnabled === 'function' ? options.setImportedLightsEnabled : () => {};
    const getImportedLightsEnabled =
        typeof options.getImportedLightsEnabled === 'function' ? options.getImportedLightsEnabled : () => false;

    const applyGlassControlsToScene =
        typeof options.applyGlassControlsToScene === 'function' ? options.applyGlassControlsToScene : () => {};
    const setEmptyHintVisible =
        typeof options.setEmptyHintVisible === 'function' ? options.setEmptyHintVisible : () => {};
    const markSceneStatsDirty =
        typeof options.markSceneStatsDirty === 'function' ? options.markSceneStatsDirty : () => {};

    const unpackZIPInWorker = typeof options.unpackZIPInWorker === 'function' ? options.unpackZIPInWorker : null;
    const makeGeoJsonMeta = typeof options.makeGeoJsonMeta === 'function' ? options.makeGeoJsonMeta : null;
    const ensureZipCollisionsHidden =
        typeof options.ensureZipCollisionsHidden === 'function' ? options.ensureZipCollisionsHidden : () => {};
    const JSZip = options.JSZip || (typeof globalThis !== 'undefined' ? globalThis.JSZip : null);

    const handleFBXFileImpl = createFBXFileHandler({
        THREE,
        fbxLoader,
        basename,
        logSessionHeader,
        logBind,
        hideSidePanel,
        setStatusMessage,
        requestRender,
        schedulePanelRefresh,
        parseFBXInWorker,
        parseFBXOnMainThread,
        isWorkerSupported,
        setWorkerSupported,
        disableWorker,
        extractImagesFromFBX,
        sniffImage,
        allEmbedded,
        markGalleryNeedsRefresh,
        world,
        loadedModels,
        determineOrientationType,
        describeOrientationType,
        describeFBXOrientation,
        readFBXOrientationFromTree,
        parseOrientationFromNode,
        normalizeObjectOrientation,
        getSMOffset,
        applyGeoOffsetByOrientation,
        setVPMReferenceHeight,
        restoreLightTargetsFromOrientation,
        disableShadowsOnImportedLights,
        ensureLightHelpers,
        renameMaterialsByFBXObject,
        markCollisionMeshes,
        splitAllMeshesByUDIM_SM,
        optimizeGlassMeshes,
        autoBindByNamesForModel,
        setImportedLightsEnabled,
        getImportedLightsEnabled,
        applyGlassControlsToScene,
        setEmptyHintVisible,
        markSceneStatsDirty,
    });

    const handleZIPFileImpl = createZIPFileHandler({
        basename,
        unpackZIPInWorker,
        makeGeoJsonMeta,
        handleFBXFile: handleFBXFileImpl,
        logSessionHeader,
        logBind,
        hideSidePanel,
        setStatusMessage,
        schedulePanelRefresh,
        ensureZipCollisionsHidden,
        setEmptyHintVisible,
        allEmbedded,
        markGalleryNeedsRefresh,
        loadedModels,
        JSZip,
    });

    async function handleFBXFile(file, groupName = null, zipKind = null, zipMeta = null, callOptions = null) {
        const fileName = file?.name || '';
        const isLightFBX = /_Light\.fbx$/i.test(fileName);
        const hasInheritedOrientation = callOptions && callOptions.inheritOrientationType != null;
        let nextOptions = callOptions;

        if (isLightFBX && !hasInheritedOrientation) {
            const lastModel = loadedModels
                .filter((m) => m && m.obj && (!groupName || m.group === groupName))
                .slice()
                .reverse()
                .find((m) => m.normalizedOrientationType != null || m.orientationType != null);
            const inheritedType = lastModel?.normalizedOrientationType ?? lastModel?.orientationType ?? null;
            if (inheritedType != null) {
                nextOptions = { ...(nextOptions || {}), inheritOrientationType: inheritedType };
            }
        }

        return handleFBXFileImpl(file, groupName, zipKind, zipMeta, nextOptions);
    }

    async function handleZIPFile(file, callOptions = null) {
        return handleZIPFileImpl(file, callOptions);
    }

    return {
        handleFBXFile,
        handleZIPFile,
    };
}
