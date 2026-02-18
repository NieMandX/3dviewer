const TEXTURE_SLOTS = Object.freeze([
    'map',
    'normalMap',
    'roughnessMap',
    'metalnessMap',
    'aoMap',
    'emissiveMap',
    'alphaMap',
    'displacementMap',
    'bumpMap',
    'lightMap',
    'specularMap',
    'envMap',
    'clearcoatMap',
    'clearcoatNormalMap',
    'clearcoatRoughnessMap',
    'sheenColorMap',
    'sheenRoughnessMap',
    'transmissionMap',
    'thicknessMap',
    'anisotropyMap',
    'iridescenceMap',
    'iridescenceThicknessMap',
    'specularIntensityMap',
    'specularColorMap',
]);

function toNumber(value, digits = 6) {
    const num = Number(value);
    if (!Number.isFinite(num)) return null;
    const scale = 10 ** digits;
    return Math.round(num * scale) / scale;
}

function toVec3Like(value) {
    if (!value) return null;
    return [toNumber(value.x), toNumber(value.y), toNumber(value.z)];
}

function toQuatLike(value) {
    if (!value) return null;
    return [toNumber(value.x), toNumber(value.y), toNumber(value.z), toNumber(value.w)];
}

function toEulerLike(value) {
    if (!value) return null;
    return [toNumber(value.x), toNumber(value.y), toNumber(value.z)];
}

function guessFormatFromPath(path) {
    const name = String(path || '').toLowerCase();
    const match = name.match(/\.([a-z0-9]+)(?:\?|#|$)/i);
    return match?.[1] || null;
}

function extractFileName(path, fallbackName = '') {
    const source = String(path || '').trim();
    if (!source) return String(fallbackName || '').trim();
    const clean = source.split('?')[0].split('#')[0];
    const parts = clean.split(/[\\/]/);
    return parts[parts.length - 1] || String(fallbackName || '').trim();
}

function detectTextureSourcePath(texture) {
    if (!texture || typeof texture !== 'object') return '';
    const sourceData = texture.source?.data || null;
    return (
        texture.userData?.originalPath ||
        texture.userData?.path ||
        sourceData?.currentSrc ||
        sourceData?.src ||
        texture.image?.currentSrc ||
        texture.image?.src ||
        texture.name ||
        ''
    );
}

function detectEmbedState(path) {
    const value = String(path || '').trim();
    if (!value) return 'missing';
    if (/^(data:|blob:)/i.test(value)) return 'embedded';
    return 'external';
}

function detectModelType(zipKind, fileName = '', groupName = '') {
    const kind = String(zipKind || '').trim().toUpperCase();
    if (kind === 'SM' || /^SM_/i.test(String(fileName || ''))) return 'ВПМ';
    if (kind === 'NPM' || /^\d/.test(String(fileName || '')) || /^\d/.test(String(groupName || ''))) return 'НПМ';
    return 'Не определено';
}

function collectUvSummary(geometry) {
    const attributes = geometry?.attributes || {};
    const uvKeys = Object.keys(attributes).filter((key) => key === 'uv' || /^uv\d+$/i.test(key));
    const uvBoundsRaw = {};
    const udimTilesSet = new Set();
    let uvOutCount = 0;
    let uvSampleCount = 0;

    uvKeys.forEach((key, index) => {
        const attr = attributes[key];
        if (!attr || !Number.isFinite(attr.count) || attr.itemSize < 2) return;
        let minU = Number.POSITIVE_INFINITY;
        let minV = Number.POSITIVE_INFINITY;
        let maxU = Number.NEGATIVE_INFINITY;
        let maxV = Number.NEGATIVE_INFINITY;

        for (let i = 0; i < attr.count; i += 1) {
            const u = toNumber(attr.getX(i));
            const v = toNumber(attr.getY(i));
            if (!Number.isFinite(u) || !Number.isFinite(v)) continue;
            if (u < minU) minU = u;
            if (v < minV) minV = v;
            if (u > maxU) maxU = u;
            if (v > maxV) maxV = v;

            if (index === 0) {
                uvSampleCount += 1;
                if (u < 0 || u > 1 || v < 0 || v > 1) uvOutCount += 1;
                const tileU = Math.floor(u);
                const tileV = Math.floor(v);
                if (tileU !== 0 || tileV !== 0) {
                    udimTilesSet.add(`${tileU},${tileV}`);
                }
            }
        }

        if (Number.isFinite(minU) && Number.isFinite(minV) && Number.isFinite(maxU) && Number.isFinite(maxV)) {
            uvBoundsRaw[key] = {
                u: [toNumber(minU), toNumber(maxU)],
                v: [toNumber(minV), toNumber(maxV)],
            };
        }
    });

    return {
        uvChannelCount: uvKeys.length,
        uvSetNamesRaw: uvKeys,
        uvBoundsRaw,
        udimTilesRaw: Array.from(udimTilesSet).sort(),
        uvOutOfRangePercent: uvSampleCount > 0 ? toNumber((uvOutCount / uvSampleCount) * 100, 4) : 0,
    };
}

function computeBoundingBoxRaw(geometry) {
    if (!geometry) return null;
    try {
        if (!geometry.boundingBox && typeof geometry.computeBoundingBox === 'function') {
            geometry.computeBoundingBox();
        }
    } catch (_) {}
    const box = geometry.boundingBox;
    if (!box || !box.min || !box.max) return null;
    const min = toVec3Like(box.min);
    const max = toVec3Like(box.max);
    const size = [
        toNumber((max?.[0] ?? 0) - (min?.[0] ?? 0)),
        toNumber((max?.[1] ?? 0) - (min?.[1] ?? 0)),
        toNumber((max?.[2] ?? 0) - (min?.[2] ?? 0)),
    ];
    return { min, max, size };
}

export function buildImportSnapshot(options = {}) {
    const root = options.obj || null;
    if (!root?.traverse) return null;

    const fileName = options.fileName || '';
    const groupName = options.groupName || null;
    const zipKind = options.zipKind || null;
    const modelType = detectModelType(zipKind, fileName, groupName);
    const isVPM = modelType === 'ВПМ';
    const capturedAt = options.capturedAt || new Date().toISOString();

    const isTechnicalDefaultMaterialName =
        typeof options.isTechnicalDefaultMaterialName === 'function'
            ? options.isTechnicalDefaultMaterialName
            : (name) => !String(name || '').trim();

    const nodeIdMap = new Map();
    const nodes = [];
    const meshes = [];
    const meshMaterialsRaw = [];
    const uvUdimRaw = [];
    const materials = [];
    const textures = [];
    const meshByName = {};
    const nodeChildrenMap = {};
    const materialsById = {};
    const texturesById = {};
    const ucxMeshIds = [];
    const precheckFindings = [];

    const materialIdByUuid = new Map();
    const textureIdByUuid = new Map();
    const textureUsageById = new Map();
    let materialCounter = 0;
    let textureCounter = 0;
    let textureRefCount = 0;
    let materialSlotCount = 0;
    let uvSetCount = 0;
    let triangleCountTotal = 0;

    function ensureTexture(texture, context = {}) {
        if (!texture || typeof texture !== 'object') return null;
        const textureUuid = texture.uuid || `texture-anon-${textureCounter + 1}`;
        const existingId = textureIdByUuid.get(textureUuid);
        if (existingId) {
            const usage = textureUsageById.get(existingId);
            if (usage && context.materialId && context.slot) {
                usage.add(`${context.materialId}:${context.slot}`);
            }
            return existingId;
        }

        const textureId = `tex${++textureCounter}`;
        textureIdByUuid.set(textureUuid, textureId);
        const sourcePath = detectTextureSourcePath(texture);
        const fileNameRaw = extractFileName(sourcePath, texture.name || textureId);
        const image = texture.image || texture.source?.data || null;
        const width = Number(image?.naturalWidth || image?.videoWidth || image?.width || 0) || null;
        const height = Number(image?.naturalHeight || image?.videoHeight || image?.height || 0) || null;
        const formatGuess = guessFormatFromPath(sourcePath);
        const usage = new Set();
        if (context.materialId && context.slot) {
            usage.add(`${context.materialId}:${context.slot}`);
        }
        textureUsageById.set(textureId, usage);

        const textureEntry = {
            textureId,
            filePathRaw: sourcePath || null,
            fileName: fileNameRaw || textureId,
            mimeOrFormatRaw: formatGuess || texture.source?.data?.type || texture.format || null,
            resolutionRaw: width && height ? { width, height } : null,
            embedState: detectEmbedState(sourcePath),
        };
        textures.push(textureEntry);
        texturesById[textureId] = textureEntry.fileName;
        return textureId;
    }

    function ensureMaterial(material) {
        if (!material || typeof material !== 'object') return null;
        const materialUuid = material.uuid || `mat-anon-${materialCounter + 1}`;
        const existingId = materialIdByUuid.get(materialUuid);
        if (existingId) return existingId;

        const materialId = `mat${++materialCounter}`;
        materialIdByUuid.set(materialUuid, materialId);
        const materialNameRaw = String(material.name || '').trim();
        const textureBindingsRaw = {};
        TEXTURE_SLOTS.forEach((slot) => {
            const texture = material[slot];
            const textureId = ensureTexture(texture, { slot, materialId });
            if (textureId) {
                textureBindingsRaw[slot] = textureId;
                textureRefCount += 1;
            }
        });

        const materialEntry = {
            materialId,
            materialNameRaw,
            shadingModelRaw: material.type || null,
            opacityModeRaw: {
                transparent: !!material.transparent,
                opacity: toNumber(material.opacity),
                alphaTest: toNumber(material.alphaTest),
                depthWrite: !!material.depthWrite,
                blending: material.blending ?? null,
            },
            twoSidedRaw: material.side === 2,
            textureBindingsRaw,
        };
        materials.push(materialEntry);
        materialsById[materialId] = materialNameRaw || materialId;
        return materialId;
    }

    let nodeCounter = 0;
    root.traverse((node) => {
        const nodeId = `n${++nodeCounter}`;
        nodeIdMap.set(node, nodeId);
    });

    root.traverse((node) => {
        const nodeId = nodeIdMap.get(node);
        const parentId = nodeIdMap.get(node.parent) || null;
        const nodeTypeRaw = node?.isMesh
            ? 'mesh'
            : node?.isLight
                ? 'light'
                : node?.isCamera
                    ? 'camera'
                    : node?.type || 'node';

        const nodeEntry = {
            nodeId,
            nameRaw: String(node?.name || ''),
            parentId,
            nodeTypeRaw,
            localTransformRaw: {
                position: toVec3Like(node?.position),
                rotation: toEulerLike(node?.rotation),
                quaternion: toQuatLike(node?.quaternion),
                scale: toVec3Like(node?.scale),
            },
            visibilityRaw: node?.visible !== false,
        };
        nodes.push(nodeEntry);
        nodeChildrenMap[nodeId] = [];

        if (!node?.isMesh) return;

        const geometry = node.geometry;
        const positionAttr = geometry?.attributes?.position || null;
        const vertexCountRaw = Number(positionAttr?.count || 0) || 0;
        const triangleCountRaw = geometry?.index?.count
            ? Math.floor(Number(geometry.index.count || 0) / 3)
            : Math.floor(vertexCountRaw / 3);
        triangleCountTotal += triangleCountRaw;

        const uvSummary = collectUvSummary(geometry);
        uvSetCount += uvSummary.uvChannelCount;
        const meshId = `mesh${meshes.length + 1}`;
        const meshNameRaw = String(node?.name || '');
        const ucxByName = /^UCX_/i.test(meshNameRaw);
        if (ucxByName) ucxMeshIds.push(meshId);

        const mats = Array.isArray(node.material) ? node.material : [node.material];
        const materialRows = mats.filter(Boolean);
        if (materialRows.length === 0) {
            meshMaterialsRaw.push({
                meshId,
                slotIndex: 0,
                materialIdRef: null,
                materialNameRaw: '',
                materialPresentInSource: false,
                assignedByViewer: false,
                sourceNote: 'material slot empty in source',
            });
            materialSlotCount += 1;
        } else {
            materialRows.forEach((mat, slotIndex) => {
                const materialIdRef = ensureMaterial(mat);
                const materialNameRaw = String(mat?.name || '').trim();
                const hasAuthoredMaterial = materialNameRaw && !isTechnicalDefaultMaterialName(materialNameRaw);
                meshMaterialsRaw.push({
                    meshId,
                    slotIndex,
                    materialIdRef,
                    materialNameRaw,
                    materialPresentInSource: !!hasAuthoredMaterial,
                    assignedByViewer: false,
                    sourceNote: hasAuthoredMaterial ? 'from-source' : 'technical-default',
                });
                materialSlotCount += 1;
            });
        }

        uvUdimRaw.push({
            meshId,
            uvChannelCount: uvSummary.uvChannelCount,
            uvSetNamesRaw: uvSummary.uvSetNamesRaw,
            uvBoundsRaw: uvSummary.uvBoundsRaw,
            udimTilesRaw: uvSummary.udimTilesRaw,
            uvOutOfRangePercent: uvSummary.uvOutOfRangePercent,
            requiresViewerSplit: isVPM && uvSummary.udimTilesRaw.length > 0,
        });

        const meshEntry = {
            meshId,
            meshNameRaw,
            ownerNodeId: nodeId,
            vertexCountRaw,
            triangleCountRaw,
            boundingBoxRaw: computeBoundingBoxRaw(geometry),
            isUcXByNameRaw: ucxByName,
        };
        meshes.push(meshEntry);

        if (!meshByName[meshNameRaw]) meshByName[meshNameRaw] = [];
        meshByName[meshNameRaw].push(meshId);
    });

    nodes.forEach((nodeEntry) => {
        if (!nodeEntry?.parentId) return;
        if (!nodeChildrenMap[nodeEntry.parentId]) nodeChildrenMap[nodeEntry.parentId] = [];
        nodeChildrenMap[nodeEntry.parentId].push(nodeEntry.nodeId);
    });

    if (modelType === 'НПМ' && ucxMeshIds.length > 0) {
        precheckFindings.push(`НПМ содержит UCX-меши (${ucxMeshIds.length})`);
    }
    if (modelType === 'ВПМ' && ucxMeshIds.length === 0) {
        precheckFindings.push('ВПМ не содержит UCX-меши');
    }

    const hasLights = nodes.some((node) => node.nodeTypeRaw === 'light');
    const hasCameras = nodes.some((node) => node.nodeTypeRaw === 'camera');
    const hasAnimation = Array.isArray(root.animations) && root.animations.length > 0;
    const sectionSummary = {
        nodeCount: nodes.length,
        meshCount: meshes.length,
        triangleCount: triangleCountTotal,
        materialCount: materials.length,
        textureCount: textures.length,
    };

    return {
        snapshotId: options.snapshotId || null,
        modelId: options.modelId || null,
        modelType,
        zipKind: zipKind || null,
        fileName,
        sourceContainer: groupName ? `zip:${groupName}` : 'direct-file',
        capturedAt,
        identity: {
            snapshotId: options.snapshotId || null,
            modelId: options.modelId || null,
            modelType,
            fileName,
            sourceContainer: groupName ? `zip:${groupName}` : 'direct-file',
            capturedAt,
        },
        importMeta: {
            importSessionId: options.importSessionId || (groupName || 'direct-file'),
            importOrder: options.importOrder || null,
            byteSize: Number(options.byteSize || 0) || 0,
            hash: options.hash || null,
            parseDurationMs: Number(options.parseDurationMs || 0) || 0,
            parseWarningsRaw: Array.isArray(options.parseWarningsRaw) ? options.parseWarningsRaw : [],
            parsedViaWorker: !!options.parsedViaWorker,
            embeddedImagesCount: Number(options.embeddedImagesCount || 0) || 0,
        },
        orientationRaw: {
            rawUpAxis: options.orientationInfo?.up ?? options.orientationInfo?.upAxis ?? options.orientationMeta?.upAxis ?? null,
            rawFrontAxis: options.orientationInfo?.front ?? null,
            rawCoordSystem: options.orientationInfo?.coord ?? options.orientationMeta?.handedness ?? null,
            unitScaleFactor: options.orientationInfo?.unitScale ?? options.orientationInfo?.unitScaleFactor ?? null,
            preRotationFlags: null,
            viewerTransformPlan: {
                targetOrientationType: options.orientationType ?? null,
                normalizedOrientationApplied: null,
                hasGeoOffset: !!(isVPM && options.zipMeta),
                willRenameMaterials: true,
                willMarkCollisionMeshes: true,
                willSplitUdim: isVPM,
            },
        },
        sceneSummaryRaw: {
            nodeCount: nodes.length,
            meshCount: meshes.length,
            triangleCount: triangleCountTotal,
            materialCount: materials.length,
            textureCount: textures.length,
            materialSlotCount,
            textureRefCount,
            uvSetCount,
            hasAnimationLightsCameras: {
                animation: hasAnimation,
                lights: hasLights,
                cameras: hasCameras,
            },
        },
        nodes,
        meshes,
        meshMaterialsRaw,
        uvUdimRaw,
        materials,
        textures: textures.map((item) => ({
            ...item,
            referencedBy: Array.from(textureUsageById.get(item.textureId) || []),
        })),
        linksAndIndex: {
            meshByName,
            nodeChildrenMap,
            materialsById,
            texturesById,
            ucxMeshIds,
            precheckFindings,
        },
        summary: sectionSummary,
    };
}
