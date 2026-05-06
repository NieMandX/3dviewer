import { collectMaterialTextures } from '../material/texture-utils.js';

export function createFBXFileHandler(options = {}) {
    const THREE = options.THREE;
    const fbxLoader = options.fbxLoader || null;

    const logSessionHeader = typeof options.logSessionHeader === 'function' ? options.logSessionHeader : () => {};
    const logBind = typeof options.logBind === 'function' ? options.logBind : () => {};
    const hideSidePanel = typeof options.hideSidePanel === 'function' ? options.hideSidePanel : () => {};
    const setStatusMessage = typeof options.setStatusMessage === 'function' ? options.setStatusMessage : () => {};
    const requestRender = typeof options.requestRender === 'function' ? options.requestRender : () => {};
    const schedulePanelRefresh = typeof options.schedulePanelRefresh === 'function' ? options.schedulePanelRefresh : () => {};

    const basename = typeof options.basename === 'function' ? options.basename : (p) => (p || '').split(/[\\/]/).pop();

    const parseFBXInWorker = typeof options.parseFBXInWorker === 'function' ? options.parseFBXInWorker : null;
    const parseFBXOnMainThread = typeof options.parseFBXOnMainThread === 'function' ? options.parseFBXOnMainThread : null;
    const isWorkerSupported = typeof options.isWorkerSupported === 'function' ? options.isWorkerSupported : () => false;
    const setWorkerSupported = typeof options.setWorkerSupported === 'function' ? options.setWorkerSupported : () => {};
    const disableWorker = typeof options.disableWorker === 'function' ? options.disableWorker : () => {};

    const extractImagesFromFBX = typeof options.extractImagesFromFBX === 'function' ? options.extractImagesFromFBX : null;
    const sniffImage = typeof options.sniffImage === 'function' ? options.sniffImage : null;

    const allEmbedded = Array.isArray(options.allEmbedded) ? options.allEmbedded : [];
    const markGalleryNeedsRefresh = typeof options.markGalleryNeedsRefresh === 'function' ? options.markGalleryNeedsRefresh : () => {};

    const world = options.world || null;
    const loadedModels = Array.isArray(options.loadedModels) ? options.loadedModels : [];

    const determineOrientationType = typeof options.determineOrientationType === 'function' ? options.determineOrientationType : () => ({ type: 'unknown' });
    const describeOrientationType = typeof options.describeOrientationType === 'function' ? options.describeOrientationType : (t) => String(t || 'unknown');
    const describeFBXOrientation = typeof options.describeFBXOrientation === 'function' ? options.describeFBXOrientation : () => '';
    const readFBXOrientationFromTree = typeof options.readFBXOrientationFromTree === 'function' ? options.readFBXOrientationFromTree : () => null;
    const parseOrientationFromNode = typeof options.parseOrientationFromNode === 'function' ? options.parseOrientationFromNode : () => null;
    const normalizeObjectOrientation = typeof options.normalizeObjectOrientation === 'function' ? options.normalizeObjectOrientation : () => {};

    const getSMOffset = typeof options.getSMOffset === 'function' ? options.getSMOffset : () => ({ x: 0, y: 0, z: 0 });
    const applyGeoOffsetByOrientation = typeof options.applyGeoOffsetByOrientation === 'function' ? options.applyGeoOffsetByOrientation : () => {};
    const setVPMReferenceHeight = typeof options.setVPMReferenceHeight === 'function' ? options.setVPMReferenceHeight : () => {};

    const restoreLightTargetsFromOrientation = typeof options.restoreLightTargetsFromOrientation === 'function' ? options.restoreLightTargetsFromOrientation : () => {};
    const disableShadowsOnImportedLights = typeof options.disableShadowsOnImportedLights === 'function' ? options.disableShadowsOnImportedLights : () => {};
    const ensureLightHelpers = typeof options.ensureLightHelpers === 'function' ? options.ensureLightHelpers : () => {};
    const renameMaterialsByFBXObject = typeof options.renameMaterialsByFBXObject === 'function' ? options.renameMaterialsByFBXObject : () => {};

    const markCollisionMeshes = typeof options.markCollisionMeshes === 'function' ? options.markCollisionMeshes : () => {};
    const splitAllMeshesByUDIM_SM = typeof options.splitAllMeshesByUDIM_SM === 'function' ? options.splitAllMeshesByUDIM_SM : () => {};
    const optimizeGlassMeshes = typeof options.optimizeGlassMeshes === 'function' ? options.optimizeGlassMeshes : () => {};
    const enableDebugGlobals = options.enableDebugGlobals === true;

    const autoBindByNamesForModel = typeof options.autoBindByNamesForModel === 'function' ? options.autoBindByNamesForModel : () => {};
    const setImportedLightsEnabled = typeof options.setImportedLightsEnabled === 'function' ? options.setImportedLightsEnabled : () => {};
    const getImportedLightsEnabled = typeof options.getImportedLightsEnabled === 'function' ? options.getImportedLightsEnabled : () => false;
    const applyGlassControlsToScene = typeof options.applyGlassControlsToScene === 'function' ? options.applyGlassControlsToScene : () => {};
    const setEmptyHintVisible = typeof options.setEmptyHintVisible === 'function' ? options.setEmptyHintVisible : () => {};
    const markSceneStatsDirty = typeof options.markSceneStatsDirty === 'function' ? options.markSceneStatsDirty : () => {};

    function isAbortError(error) {
        return error?.name === 'AbortError';
    }

    function makeAbortError(message = 'FBX import aborted') {
        try {
            return new DOMException(message, 'AbortError');
        } catch (_) {
            const err = new Error(message);
            err.name = 'AbortError';
            return err;
        }
    }

    function revokeEmbeddedUrls(entries) {
        (Array.isArray(entries) ? entries : []).forEach((entry) => {
            const url = String(entry?.url || '');
            if (!url.startsWith('blob:')) return;
            try {
                URL.revokeObjectURL(url);
            } catch (_) {}
        });
    }

    function disposeObjectResources(root) {
        if (!root?.traverse) return;
        const geometries = new Set();
        const materials = new Set();
        const textures = new Set();
        const skipTextureKeys = new Set(['envMap', 'matcap']);
        const skeletons = new Set();
        const asMaterialArray = (value) => {
            if (!value) return [];
            return Array.isArray(value) ? value.filter(Boolean) : [value];
        };
        const disposeMaterial = (material, { disposeTextures = true } = {}) => {
            if (!material || materials.has(material)) return;
            materials.add(material);
            if (disposeTextures) {
                collectMaterialTextures(material, { skipTextureKeys }).forEach((value) => {
                    if (!value?.isTexture || textures.has(value)) return;
                    textures.add(value);
                    value.dispose?.();
                });
            }
            material.dispose?.();
        };
        root.traverse((node) => {
            const skeleton = node?.skeleton || null;
            if (skeleton?.dispose && !skeletons.has(skeleton)) {
                skeletons.add(skeleton);
                skeleton.dispose();
            }
            if (node?.geometry?.dispose && !geometries.has(node.geometry)) {
                geometries.add(node.geometry);
                node.geometry.dispose();
            }
            [
                ...asMaterialArray(node?.userData?._origMaterial),
                ...asMaterialArray(node?.userData?._removedMaterials),
            ].forEach((material) => disposeMaterial(material, { disposeTextures: true }));
            [
                ...asMaterialArray(node?.userData?._bfFront),
                ...asMaterialArray(node?.userData?._bfBack),
                ...asMaterialArray(node?.userData?._wireBase),
                ...asMaterialArray(node?.userData?._beautyBase),
                ...asMaterialArray(node?.userData?._removedCustomDepthMaterial),
                ...asMaterialArray(node?.userData?._removedCustomDistanceMaterial),
                ...asMaterialArray(node?.customDepthMaterial),
                ...asMaterialArray(node?.customDistanceMaterial),
            ].forEach((material) => disposeMaterial(material, { disposeTextures: false }));
            asMaterialArray(node?.material).forEach((material) => {
                disposeMaterial(material, { disposeTextures: true });
            });
        });
    }

    function buildEmbeddedEntriesFromWorker(entries, fileName) {
        const out = [];
        try {
            (Array.isArray(entries) ? entries : []).forEach((entry) => {
                const buf = entry?.buffer;
                const mime = entry?.mime || (buf && sniffImage ? sniffImage(new Uint8Array(buf)).mime : 'application/octet-stream');
                const url = buf ? URL.createObjectURL(new Blob([buf], { type: mime })) : null;
                if (!url) return;
                out.push({
                    short: entry?.short || basename(entry?.full || '')?.toLowerCase?.() || '',
                    url,
                    full: entry?.full || entry?.short || '',
                    mime,
                    source: 'embedded',
                    fileName,
                });
            });
            return out;
        } catch (err) {
            revokeEmbeddedUrls(out);
            throw err;
        }
    }

    function setDebugGlobals(root, parsedViaWorker) {
        if (!enableDebugGlobals || typeof globalThis === 'undefined') return;
        globalThis.__fbxLoader = fbxLoader;
        globalThis.__lastFBXLoaded = root;
        globalThis.__fbxParsedInWorker = parsedViaWorker;
    }

    function clearDebugGlobalsFor(root) {
        if (!enableDebugGlobals || typeof globalThis === 'undefined') return;
        if (globalThis.__lastFBXLoaded === root) {
            globalThis.__lastFBXLoaded = null;
        }
    }

    return async function handleFBXFile(file, groupName = null, zipKind = null, zipMeta = null, callOptions = null) {
        const signal = callOptions?.signal || null;
        const throwIfAborted = (root = null, embeddedEntries = null) => {
            if (!signal?.aborted) return;
            revokeEmbeddedUrls(embeddedEntries);
            disposeObjectResources(root);
            throw makeAbortError();
        };

        throwIfAborted();
        logSessionHeader(`FBX: ${file.name}`);
        hideSidePanel();

        // если zipKind не передали из handleZIPFile — определим по имени ZIP здесь
        if (!zipKind && groupName) {
            zipKind = /^\d/.test(groupName) ? 'NPM' : (/^SM/i.test(groupName) ? 'SM' : null);
        }

        const bufferOverride = callOptions?.buffer || null;
        let ab = bufferOverride || await file.arrayBuffer();
        let embedded = [];
        throwIfAborted();

        let orientationInfo = null;
        let orientationSource = null;
        let orientationMeta = determineOrientationType(null);
        let orientationType = orientationMeta.type;

        setStatusMessage(`Парсинг FBX: ${file.name}…`);

        let parsedObj = null;
        let parsedViaWorker = false;
        let parseDuration = 0;

        if (parseFBXInWorker && isWorkerSupported()) {
            try {
                const workerResult = await parseFBXInWorker(ab, { embedded: true, orientation: true }, { signal });
                parsedObj = workerResult.obj;
                parsedViaWorker = true;
                parseDuration = workerResult.duration;
                orientationInfo = workerResult.orientationInfo || null;
                orientationSource = orientationInfo?.source || null;

                embedded = buildEmbeddedEntriesFromWorker(workerResult.embedded, file.name);
            } catch (err) {
                revokeEmbeddedUrls(embedded);
                disposeObjectResources(parsedObj);
                parsedObj = null;
                embedded = [];
                parsedViaWorker = false;
                parseDuration = 0;
                orientationInfo = null;
                orientationSource = null;
                if (isAbortError(err)) throw err;
                logBind(`FBX: фон. парсер не сработал → ${err?.message || err}`, 'warn');
                setWorkerSupported(false);
                disableWorker(err);
                try {
                    ab = await file.arrayBuffer();
                    throwIfAborted();
                } catch (reloadErr) {
                    logBind(`FBX: повторное чтение файла не удалось → ${reloadErr?.message || reloadErr}`, 'warn');
                    throw err;
                }
            }
        }

        if (!parsedObj) {
            try {
                parsedViaWorker = false;
                if (!parseFBXOnMainThread) throw new Error('parseFBXOnMainThread not available');
                throwIfAborted();
                const mainResult = await Promise.resolve(parseFBXOnMainThread(ab));
                parsedObj = mainResult.obj;
                parseDuration = mainResult.duration;
                throwIfAborted(parsedObj);

                // embedded-извлечение (fallback на UI-потоке)
                if (extractImagesFromFBX) {
                    const previousEmbedded = embedded;
                    embedded = await extractImagesFromFBX(ab);
                    if (previousEmbedded !== embedded) revokeEmbeddedUrls(previousEmbedded);
                    embedded.forEach(e => e.fileName = file.name);
                    throwIfAborted(parsedObj, embedded);
                }
            } catch (err) {
                if (!isAbortError(err)) {
                    revokeEmbeddedUrls(embedded);
                    disposeObjectResources(parsedObj);
                    parsedObj = null;
                    embedded = [];
                }
                if (isAbortError(err)) throw err;
                setStatusMessage(`Ошибка парсинга: ${file.name}`);
                logBind(`⚠️ Ошибка парсинга ${file.name}: ${err?.message || String(err)}`, 'warn');
                throw err;
            }
        }

        let embeddedPushed = false;
        throwIfAborted(parsedObj, embedded);
        const obj = parsedObj;
        if (!obj) {
            revokeEmbeddedUrls(embedded);
            setStatusMessage(`Ошибка парсинга: ${file.name}`);
            logBind(`⚠️ Парсер FBX вернул пустой объект для ${file.name}`, 'warn');
            throw new Error(`FBX parser returned empty object for ${file.name}`);
        }
        if (embedded.length) {
            allEmbedded.push(...embedded);
            embeddedPushed = true;
            markGalleryNeedsRefresh();
        }

        let modelRecord = null;
        let addedToWorld = false;
        try {
        throwIfAborted(obj);
        setStatusMessage('Обработка сцены…');

        setDebugGlobals(obj, parsedViaWorker);

        obj.userData._fbxFileName = file.name;

        if (orientationInfo) {
            orientationMeta = determineOrientationType(orientationInfo);
            orientationType = orientationMeta.type;
        }

        if (!orientationInfo && obj.userData?.fbxTree) {
            const infoFromTree = readFBXOrientationFromTree(obj.userData.fbxTree);
            if (infoFromTree) {
                orientationInfo = infoFromTree;
                orientationSource = infoFromTree.source || 'tree';
                orientationMeta = determineOrientationType(orientationInfo);
                orientationType = orientationMeta.type;
            }
        }
        if (!orientationInfo) {
            const infoFromGeom = parseOrientationFromNode(obj);
            if (infoFromGeom) {
                orientationInfo = infoFromGeom;
                orientationSource = infoFromGeom.source || 'geometry';
                orientationMeta = determineOrientationType(orientationInfo);
                orientationType = orientationMeta.type;
            }
        }

        const inheritedOrientationType = callOptions?.inheritOrientationType;
        const inheritedTypeNumber = Number(inheritedOrientationType);
        const hasInheritedOrientationType = inheritedOrientationType != null && Number.isFinite(inheritedTypeNumber);
        if (hasInheritedOrientationType) {
            orientationType = inheritedTypeNumber;
            if (inheritedTypeNumber === 1) {
                orientationMeta = { type: 1, handedness: 'right', upAxis: 'Y' };
            } else if (inheritedTypeNumber === 2) {
                orientationMeta = { type: 2, handedness: 'right', upAxis: 'Z' };
            } else if (inheritedTypeNumber === 3) {
                orientationMeta = { type: 3, handedness: 'left', upAxis: 'Z' };
            } else if (inheritedTypeNumber === 4) {
                orientationMeta = { type: 4, handedness: 'left', upAxis: 'Y' };
            } else {
                orientationMeta = { type: inheritedTypeNumber, handedness: 'unknown', upAxis: null };
            }
            if (!orientationInfo) {
                orientationInfo = { up: null, front: null, coord: null };
            }
            orientationInfo.source = 'zip-inherit';
            orientationSource = 'zip-inherit';
        }

        if (orientationInfo) {
            orientationInfo.type = orientationType;
            orientationInfo.handedness = orientationMeta.handedness;
            orientationInfo.upAxisResolved = orientationMeta.upAxis;
            obj.userData.orientation = orientationInfo;
            const sourceLabels = { binary: 'GlobalSettings', tree: 'fbxTree', geometry: 'геометрия', 'zip-inherit': 'ZIP (унаследовано)' };
            const src = sourceLabels[orientationSource] || orientationSource || 'unknown';
            logBind(`FBX: ориентация — определена через ${src}`, 'info');
            logBind(`FBX: ориентация — тип: ${describeOrientationType(orientationType)} — ${describeFBXOrientation(orientationInfo)}`, 'info');
        } else {
            logBind(`FBX: ориентация — никак не определил (тип: ${describeOrientationType(orientationType)})`, 'warn');
        }

        if (parseDuration) {
            logBind(`FBX: парсинг ${parsedViaWorker ? 'в воркере' : 'на UI-потоке'} занял ${Math.round(parseDuration)} мс`, 'info');
        }

        obj.userData.orientationType = orientationType;
        obj.userData.orientationHandedness = orientationMeta.handedness;
        obj.userData.orientationUpAxis = orientationMeta.upAxis;

        let normalizedOrientationType = null;
        if (hasInheritedOrientationType) {
            normalizeObjectOrientation(obj, orientationType);
            normalizedOrientationType = orientationType;
        } else {
            const isKnownOrientation = orientationType === 1 || orientationType === 2 || orientationType === 3 || orientationType === 4;
            if (isKnownOrientation) {
                normalizeObjectOrientation(obj, orientationType);
                normalizedOrientationType = orientationType;
            } else {
                let hasMesh = false;
                try {
                    obj.traverse?.((node) => {
                        if (hasMesh) return;
                        if (node?.isMesh) hasMesh = true;
                    });
                } catch (_) {}
                if (hasMesh) {
                    normalizeObjectOrientation(obj, orientationType);
                    normalizedOrientationType = orientationType;
                }
            }
        }

        // ★ NEW: если это ВПМ и есть geojson — сохраним мету и применим смещение
        if ((zipKind || '').toUpperCase() === 'SM' && zipMeta) {
            obj.userData._geojsonMeta = zipMeta;

            const { x, y, z } = getSMOffset(zipMeta, {
                log: (msg, level) => logBind(msg, level),
                setVPMReferenceHeight,
            });

            applyGeoOffsetByOrientation(obj, orientationType, { x, y, z });

            logBind(`VPM: смещение для ${file.name} из GeoJSON → Δx=${x} Δy=${y} Δz=${z}`, 'ok');
        }

            throwIfAborted(obj);
            world?.add?.(obj);
            addedToWorld = true;

            modelRecord = {
                obj,
                name: file.name,
                group: groupName || null,
                zipKind: zipKind || null,
                geojson: zipMeta || null,
                orientation: orientationInfo || null,
                orientationType,
                normalizedOrientationType,
            };
            loadedModels.push(modelRecord);

            restoreLightTargetsFromOrientation(obj);
            disableShadowsOnImportedLights(obj);
            ensureLightHelpers(obj);

            renameMaterialsByFBXObject(obj);

            obj.traverse(o => {
                if (!o.isMesh) return;
                const mats = Array.isArray(o.material) ? o.material : [o.material];

                let willCast = false;
                mats.forEach(m => {
                    if (m.side === THREE?.DoubleSide) m.shadowSide = THREE.FrontSide;

                    const hasMask = !!m.alphaMap || (m.alphaTest > 0);
                    const trulyTransparent = m.transparent && !hasMask;

                    if (hasMask) {
                        m.transparent = false;
                        m.alphaTest = Math.max(0.001, m.alphaTest || 0.5);
                        m.depthWrite = true;
                        willCast = true;
                    } else if (!trulyTransparent) {
                        willCast = true;
                    }
                });

                o.castShadow = willCast;
                o.receiveShadow = true;
            });

            markCollisionMeshes(obj);

            if ((zipKind || '').toUpperCase() === 'SM' || (obj.userData?.zipKind || '').toUpperCase() === 'SM') {
                splitAllMeshesByUDIM_SM(obj);
            }
            optimizeGlassMeshes(obj);
            obj.userData.zipGroup = groupName || null;
            obj.userData.zipKind = zipKind || null;

            if ((zipKind || '').toUpperCase() === 'SM' || /^SM_/i.test(file.name)) {
                logBind(`VPM: отложенная автопривязка для ${file.name}`, 'info');
            } else {
                autoBindByNamesForModel(obj, file.name, embedded);
            }
            setImportedLightsEnabled(getImportedLightsEnabled(), obj, { silent: true });
            applyGlassControlsToScene();
            setEmptyHintVisible(false);
            markSceneStatsDirty();

            schedulePanelRefresh();
            requestRender();
            setStatusMessage('');
        } catch (err) {
            if (modelRecord) {
                const index = loadedModels.indexOf(modelRecord);
                if (index >= 0) loadedModels.splice(index, 1);
            }
            if (embeddedPushed) {
                embedded.forEach((entry) => {
                    const index = allEmbedded.indexOf(entry);
                    if (index >= 0) allEmbedded.splice(index, 1);
                });
                revokeEmbeddedUrls(embedded);
                markGalleryNeedsRefresh();
            }
            if (addedToWorld && obj?.parent?.remove) {
                try {
                    obj.parent.remove(obj);
                } catch (_) {}
            }
            clearDebugGlobalsFor(obj);
            disposeObjectResources(obj);
            throw err;
        }
    };
}
