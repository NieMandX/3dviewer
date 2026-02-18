export function createFBXFileHandler(options = {}) {
    const THREE = options.THREE;
    const fbxLoader = options.fbxLoader || null;
    const DEFAULT_MATERIAL_NAME_RX = /^_*default(?:_?material)?\s*$/i;

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

    const autoBindByNamesForModel = typeof options.autoBindByNamesForModel === 'function' ? options.autoBindByNamesForModel : () => {};
    const setImportedLightsEnabled = typeof options.setImportedLightsEnabled === 'function' ? options.setImportedLightsEnabled : () => {};
    const getImportedLightsEnabled = typeof options.getImportedLightsEnabled === 'function' ? options.getImportedLightsEnabled : () => false;
    const applyGlassControlsToScene = typeof options.applyGlassControlsToScene === 'function' ? options.applyGlassControlsToScene : () => {};
    const setEmptyHintVisible = typeof options.setEmptyHintVisible === 'function' ? options.setEmptyHintVisible : () => {};
    const markSceneStatsDirty = typeof options.markSceneStatsDirty === 'function' ? options.markSceneStatsDirty : () => {};

    function isTechnicalDefaultMaterialName(name) {
        const normalized = String(name || '').trim();
        return !normalized || DEFAULT_MATERIAL_NAME_RX.test(normalized);
    }

    function captureImportedMaterialState(root) {
        if (!root?.traverse) return 0;
        let captured = 0;
        root.traverse((node) => {
            if (!node?.isMesh) return;
            const source = Array.isArray(node.material) ? node.material : [node.material];
            const mats = source.filter(Boolean);
            const names = mats
                .map((mat) => String(mat?.name || '').trim())
                .filter(Boolean);
            const authoredNames = names.filter((name) => !isTechnicalDefaultMaterialName(name));
            node.userData ||= {};
            node.userData.importMaterialState = {
                hasMaterial: mats.length > 0,
                materialCount: mats.length,
                materialNames: names,
                hasAuthoredMaterial: authoredNames.length > 0,
                authoredMaterialCount: authoredNames.length,
                authoredMaterialNames: authoredNames,
                capturedAt: 'fbx-parse',
            };
            captured += 1;
        });
        return captured;
    }

    return async function handleFBXFile(file, groupName = null, zipKind = null, zipMeta = null, callOptions = null) {
        logSessionHeader(`FBX: ${file.name}`);
        hideSidePanel();

        // если zipKind не передали из handleZIPFile — определим по имени ZIP здесь
        if (!zipKind && groupName) {
            zipKind = /^\d/.test(groupName) ? 'NPM' : (/^SM/i.test(groupName) ? 'SM' : null);
        }

        const bufferOverride = callOptions?.buffer || null;
        let ab = bufferOverride || await file.arrayBuffer();
        let embedded = [];

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
                const workerResult = await parseFBXInWorker(ab, { embedded: true, orientation: true });
                parsedObj = workerResult.obj;
                parsedViaWorker = true;
                parseDuration = workerResult.duration;
                orientationInfo = workerResult.orientationInfo || null;
                orientationSource = orientationInfo?.source || null;

                const embeddedRaw = Array.isArray(workerResult.embedded) ? workerResult.embedded : [];
                embedded = embeddedRaw.map((entry) => {
                    const buf = entry?.buffer;
                    const mime = entry?.mime || (buf && sniffImage ? sniffImage(new Uint8Array(buf)).mime : 'application/octet-stream');
                    const url = buf ? URL.createObjectURL(new Blob([buf], { type: mime })) : null;
                    return {
                        short: entry?.short || basename(entry?.full || '')?.toLowerCase?.() || '',
                        url,
                        full: entry?.full || entry?.short || '',
                        mime,
                        source: 'embedded',
                        fileName: file.name,
                    };
                }).filter((e) => e && e.url);
            } catch (err) {
                logBind(`FBX: фон. парсер не сработал → ${err?.message || err}`, 'warn');
                setWorkerSupported(false);
                disableWorker(err);
                try {
                    ab = await file.arrayBuffer();
                } catch (reloadErr) {
                    logBind(`FBX: повторное чтение файла не удалось → ${reloadErr?.message || reloadErr}`, 'warn');
                    throw err;
                }
            }
        }

        if (!parsedObj) {
            try {
                if (!parseFBXOnMainThread) throw new Error('parseFBXOnMainThread not available');
                const mainResult = parseFBXOnMainThread(ab);
                parsedObj = mainResult.obj;
                parseDuration = mainResult.duration;

                // embedded-извлечение (fallback на UI-потоке)
                if (extractImagesFromFBX) {
                    embedded = await extractImagesFromFBX(ab);
                    embedded.forEach(e => e.fileName = file.name);
                }
            } catch (err) {
                setStatusMessage(`Ошибка парсинга: ${file.name}`);
                logBind(`⚠️ Ошибка парсинга ${file.name}: ${err?.message || String(err)}`, 'warn');
                throw err;
            }
        }

        if (embedded.length) {
            allEmbedded.push(...embedded);
            markGalleryNeedsRefresh();
        }

        const obj = parsedObj;
        if (!obj) {
            setStatusMessage(`Ошибка парсинга: ${file.name}`);
            logBind(`⚠️ Парсер FBX вернул пустой объект для ${file.name}`, 'warn');
            return;
        }

        setStatusMessage('Обработка сцены…');

        if (typeof globalThis !== 'undefined') {
            globalThis.__fbxLoader = fbxLoader;
            globalThis.__lastFBXLoaded = obj;
            globalThis.__fbxParsedInWorker = parsedViaWorker;
        }

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

        captureImportedMaterialState(obj);

        world?.add?.(obj);

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
        loadedModels.push({
            obj,
            name: file.name,
            group: groupName || null,
            zipKind: zipKind || null,
            geojson: zipMeta || null,
            orientation: orientationInfo || null,
            orientationType,
            normalizedOrientationType,
        });
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
    };
}
