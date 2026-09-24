import { captureParsedMaterials } from '../material/scene-materials.js';
import { collectMaterialTextures } from '../material/texture-utils.js';

export function createGLBFileHandler(options = {}) {
    const THREE = options.THREE;
    const gltfLoader = options.gltfLoader || null;

    const logSessionHeader = typeof options.logSessionHeader === 'function' ? options.logSessionHeader : () => {};
    const logBind = typeof options.logBind === 'function' ? options.logBind : () => {};
    const hideSidePanel = typeof options.hideSidePanel === 'function' ? options.hideSidePanel : () => {};
    const setStatusMessage = typeof options.setStatusMessage === 'function' ? options.setStatusMessage : () => {};
    const requestRender = typeof options.requestRender === 'function' ? options.requestRender : () => {};
    const schedulePanelRefresh = typeof options.schedulePanelRefresh === 'function' ? options.schedulePanelRefresh : () => {};
    const basename = typeof options.basename === 'function'
        ? options.basename
        : (path) => (path || '').split(/[\\/]/).pop();

    const world = options.world || null;
    const loadedModels = Array.isArray(options.loadedModels) ? options.loadedModels : [];
    const disableShadowsOnImportedLights = typeof options.disableShadowsOnImportedLights === 'function'
        ? options.disableShadowsOnImportedLights
        : () => {};
    const ensureLightHelpers = typeof options.ensureLightHelpers === 'function'
        ? options.ensureLightHelpers
        : () => {};
    const renameMaterialsByFBXObject = typeof options.renameMaterialsByFBXObject === 'function'
        ? options.renameMaterialsByFBXObject
        : () => {};
    const markCollisionMeshes = typeof options.markCollisionMeshes === 'function'
        ? options.markCollisionMeshes
        : () => {};
    const optimizeGlassMeshes = typeof options.optimizeGlassMeshes === 'function'
        ? options.optimizeGlassMeshes
        : () => {};
    const setImportedLightsEnabled = typeof options.setImportedLightsEnabled === 'function'
        ? options.setImportedLightsEnabled
        : () => {};
    const getImportedLightsEnabled = typeof options.getImportedLightsEnabled === 'function'
        ? options.getImportedLightsEnabled
        : () => false;
    const applyGlassControlsToScene = typeof options.applyGlassControlsToScene === 'function'
        ? options.applyGlassControlsToScene
        : () => {};
    const setEmptyHintVisible = typeof options.setEmptyHintVisible === 'function'
        ? options.setEmptyHintVisible
        : () => {};
    const markSceneStatsDirty = typeof options.markSceneStatsDirty === 'function'
        ? options.markSceneStatsDirty
        : () => {};

    function makeAbortError(message = 'GLB import aborted') {
        try {
            return new DOMException(message, 'AbortError');
        } catch (_) {
            const error = new Error(message);
            error.name = 'AbortError';
            return error;
        }
    }

    function isAbortError(error) {
        return error?.name === 'AbortError';
    }

    function disposeObjectResources(root) {
        if (!root?.traverse) return;
        const geometries = new Set();
        const materials = new Set();
        const textures = new Set();
        const images = new Set();
        const skeletons = new Set();
        const asMaterialArray = (value) => {
            if (!value) return [];
            return Array.isArray(value) ? value.filter(Boolean) : [value];
        };
        const disposeMaterial = (material, { disposeTextures = true } = {}) => {
            if (!material || materials.has(material)) return;
            materials.add(material);
            if (disposeTextures) {
                collectMaterialTextures(material).forEach((texture) => {
                    if (!texture?.isTexture || textures.has(texture)) return;
                    textures.add(texture);
                    const image = texture?.source?.data || texture?.image || null;
                    const sourceImages = Array.isArray(image) ? image.filter(Boolean) : (image ? [image] : []);
                    sourceImages.forEach((sourceImage) => {
                        if (images.has(sourceImage)) return;
                        images.add(sourceImage);
                        if (typeof sourceImage.close === 'function') {
                            try { sourceImage.close(); } catch (_) {}
                        }
                    });
                    texture.dispose?.();
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
                ...asMaterialArray(node?.userData?._editorOriginalMaterials),
                ...asMaterialArray(node?.userData?._editorEditedMaterials),
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

    function parseGLB(arrayBuffer) {
        if (!gltfLoader?.parse) {
            return Promise.reject(new Error('GLTFLoader is not available'));
        }
        return new Promise((resolve, reject) => {
            gltfLoader.parse(arrayBuffer, '', resolve, reject);
        });
    }

    return async function handleGLBFile(file, callOptions = null) {
        const signal = callOptions?.signal || null;
        const throwIfAborted = () => {
            if (!signal?.aborted) return;
            throw makeAbortError();
        };

        throwIfAborted();
        logSessionHeader(`GLB: ${file.name}`);
        hideSidePanel();
        setStatusMessage(`Парсинг GLB: ${file.name}…`);

        let root = null;
        let modelRecord = null;
        let addedToWorld = false;
        try {
            const buffer = callOptions?.buffer || await file.arrayBuffer();
            throwIfAborted();
            const startedAt = (typeof performance !== 'undefined' && performance.now)
                ? performance.now()
                : Date.now();
            const gltf = await parseGLB(buffer);
            const finishedAt = (typeof performance !== 'undefined' && performance.now)
                ? performance.now()
                : Date.now();
            root = gltf?.scene || gltf?.scenes?.[0] || null;
            throwIfAborted();
            if (!root) throw new Error(`GLTFLoader returned no scene for ${file.name}`);

            captureParsedMaterials(root);
            const fileBaseName = basename(file.name).replace(/\.glb$/i, '') || 'GLB';
            if (!root.name) root.name = fileBaseName;
            root.animations = Array.isArray(gltf.animations) ? gltf.animations : [];
            (root.userData ||= {}).sourceFormat = 'glb';
            root.userData.sourceFileName = file.name;
            root.userData.orientationType = 1;
            root.userData.orientationHandedness = 'right';
            root.userData.orientationUpAxis = 'Y';

            // Lazy-load custom water only for files that explicitly carry its metadata.
            let hasRiverFlow = false;
            root.traverse((object) => {
                const materials = Array.isArray(object.material) ? object.material : [object.material];
                if (materials.some((m) => m?.userData?.lpmview_water)) hasRiverFlow = true;
            });
            if (hasRiverFlow) {
                const { installRiverFlow } = await import('../material/river-flow.js');
                await installRiverFlow(root, { useWebGPU: !!options.useWebGPU, requestRender, signal, world });
                throwIfAborted();
            }

            setStatusMessage('Обработка сцены…');
            world?.add?.(root);
            addedToWorld = true;

            modelRecord = {
                obj: root,
                name: file.name,
                group: null,
                zipKind: null,
                geojson: null,
                orientation: {
                    source: 'gltf',
                    type: 1,
                    handedness: 'right',
                    upAxisResolved: 'Y',
                },
                orientationType: 1,
                normalizedOrientationType: 1,
                format: 'glb',
                animations: root.animations,
            };
            loadedModels.push(modelRecord);

            disableShadowsOnImportedLights(root);
            ensureLightHelpers(root);
            renameMaterialsByFBXObject(root);

            root.traverse((object) => {
                if (!object?.isMesh) return;
                const materials = Array.isArray(object.material) ? object.material : [object.material];
                let willCast = false;
                materials.filter(Boolean).forEach((material) => {
                    if (material.side === THREE?.DoubleSide) material.shadowSide = THREE.FrontSide;
                    const hasMask = !!material.alphaMap || material.alphaTest > 0;
                    const trulyTransparent = material.transparent && !hasMask;
                    if (hasMask) {
                        material.transparent = false;
                        material.alphaTest = Math.max(0.001, material.alphaTest || 0.5);
                        material.depthWrite = true;
                        willCast = true;
                    } else if (!trulyTransparent) {
                        willCast = true;
                    }
                });
                object.castShadow = willCast;
                object.receiveShadow = true;
            });

            markCollisionMeshes(root);
            optimizeGlassMeshes(root);
            root.userData.zipGroup = null;
            root.userData.zipKind = null;
            setImportedLightsEnabled(getImportedLightsEnabled(), root, { silent: true });
            applyGlassControlsToScene();
            setEmptyHintVisible(false);
            markSceneStatsDirty();
            schedulePanelRefresh();
            requestRender();
            setStatusMessage('');
            logBind(`GLB: парсинг занял ${Math.round(finishedAt - startedAt)} мс`, 'info');
            return modelRecord;
        } catch (error) {
            if (modelRecord) {
                const index = loadedModels.indexOf(modelRecord);
                if (index >= 0) loadedModels.splice(index, 1);
            }
            if (addedToWorld && root?.parent?.remove) {
                try { root.parent.remove(root); } catch (_) {}
            }
            disposeObjectResources(root);
            if (!isAbortError(error)) {
                setStatusMessage(`Ошибка парсинга: ${file.name}`);
                logBind(`Ошибка парсинга GLB ${file.name}: ${error?.message || String(error)}`, 'warn');
            }
            throw error;
        }
    };
}
