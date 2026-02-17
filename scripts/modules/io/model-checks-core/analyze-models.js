import {
    collectMaterialTextures,
    formatBounds,
    getTriangleCount,
    toFiniteNumber,
} from './utils.js';

function isOrientationKnown(model) {
    const orientationType = Number(model?.orientationType);
    const normalizedOrientationType = Number(model?.normalizedOrientationType);
    return [1, 2, 3, 4].includes(normalizedOrientationType) || [1, 2, 3, 4].includes(orientationType);
}

function isInvalidTransform(node) {
    return !Number.isFinite(node.position?.x) ||
        !Number.isFinite(node.position?.y) ||
        !Number.isFinite(node.position?.z) ||
        !Number.isFinite(node.scale?.x) ||
        !Number.isFinite(node.scale?.y) ||
        !Number.isFinite(node.scale?.z);
}

function getModelStatus(modelTriangles, modelIssuesCount, limits) {
    if (modelTriangles >= limits.modelTrianglesError || modelIssuesCount > 2) return 'error';
    if (modelTriangles >= limits.modelTrianglesWarn || modelIssuesCount > 0) return 'warn';
    return 'pass';
}

function makeBoundsHelpers(THREE) {
    if (!THREE?.Box3 || !THREE?.Vector3) {
        return {
            createBounds: () => null,
            measureBounds: () => null,
        };
    }
    return {
        createBounds: () => new THREE.Box3(),
        measureBounds: (bounds) => {
            if (!bounds) return null;
            const size = bounds.getSize(new THREE.Vector3());
            return {
                x: size.x,
                y: size.y,
                z: size.z,
                maxEdge: Math.max(size.x, size.y, size.z),
            };
        },
    };
}

export function analyzeLoadedModels({ THREE = null, loadedModels = [], limits }) {
    const models = [];
    const issues = [];

    const uniqueMaterials = new Map();
    const uniqueTextures = new Map();

    let totalTriangles = 0;
    let totalMeshes = 0;
    let totalDrawCallsEstimate = 0;
    let totalUvMissing = 0;
    let totalBadTransforms = 0;
    let maxTextureEdge = 0;
    let maxTextureName = '';
    let maxTextureOwner = '';

    const { createBounds, measureBounds } = makeBoundsHelpers(THREE);

    loadedModels.forEach((model, index) => {
        const root = model?.obj || null;
        if (!root?.traverse) return;

        const modelName = model?.name || `model-${index + 1}`;
        const modelMaterials = new Set();
        const modelTextures = new Set();
        const modelIssues = [];
        const bounds = createBounds();

        let modelTriangles = 0;
        let modelMeshes = 0;
        let modelDrawCalls = 0;
        let modelUvMissing = 0;
        let modelBadTransforms = 0;

        if (bounds) {
            try {
                bounds.setFromObject(root);
            } catch (_) {}
        }

        root.traverse((node) => {
            if (!node?.isMesh) return;
            if (node.userData?.isCollision) return;
            modelMeshes += 1;

            const geometry = node.geometry;
            if (!geometry?.attributes?.position) {
                modelIssues.push(`Mesh "${node.name || node.uuid}" без геометрии позиции`);
                return;
            }

            const triangles = getTriangleCount(geometry);
            modelTriangles += triangles;

            const mats = Array.isArray(node.material) ? node.material : [node.material];
            const drawCalls = Math.max(1, mats.filter(Boolean).length);
            modelDrawCalls += drawCalls;

            const uvPresent = !!geometry.attributes?.uv;
            mats.forEach((mat) => {
                if (!mat) return;
                if (mat.uuid) modelMaterials.add(mat.uuid);
                if (mat.uuid && !uniqueMaterials.has(mat.uuid)) {
                    uniqueMaterials.set(mat.uuid, mat);
                }

                const textures = collectMaterialTextures(mat);
                if (!uvPresent && textures.length > 0) {
                    modelUvMissing += 1;
                }

                textures.forEach((texture) => {
                    const textureId = texture.uuid || `${modelName}-${texture.name || 'texture'}`;
                    modelTextures.add(textureId);
                    if (!uniqueTextures.has(textureId)) {
                        uniqueTextures.set(textureId, texture);
                    }

                    const width = toFiniteNumber(texture.image?.width);
                    const height = toFiniteNumber(texture.image?.height);
                    const edge = Math.max(width, height);
                    if (edge > maxTextureEdge) {
                        maxTextureEdge = edge;
                        maxTextureName = texture.name || texture.source?.data?.currentSrc || texture.uuid || 'texture';
                        maxTextureOwner = modelName;
                    }
                });
            });

            if (isInvalidTransform(node)) {
                modelBadTransforms += 1;
            }
        });

        if (!isOrientationKnown(model)) {
            modelIssues.push('Неопределённая ориентация FBX');
        }
        if (modelUvMissing > 0) {
            modelIssues.push(`Материалы с текстурами без UV: ${modelUvMissing}`);
        }
        if (modelBadTransforms > 0) {
            modelIssues.push(`Некорректные transform (NaN/Inf): ${modelBadTransforms}`);
        }

        const boundsData = measureBounds(bounds);
        if (boundsData?.maxEdge > limits.boundsWarn) {
            modelIssues.push(`Очень крупный bounding box: ${formatBounds(boundsData)}`);
        }

        const modelStatus = getModelStatus(modelTriangles, modelIssues.length, limits);

        totalTriangles += modelTriangles;
        totalMeshes += modelMeshes;
        totalDrawCallsEstimate += modelDrawCalls;
        totalUvMissing += modelUvMissing;
        totalBadTransforms += modelBadTransforms;

        models.push({
            name: modelName,
            zipKind: model?.zipKind || '',
            group: model?.group || '',
            triangles: modelTriangles,
            meshes: modelMeshes,
            drawCalls: modelDrawCalls,
            materials: modelMaterials.size,
            textures: modelTextures.size,
            issues: modelIssues,
            status: modelStatus,
            bounds: boundsData,
        });

        modelIssues.forEach((issue) => {
            issues.push(`${modelName}: ${issue}`);
        });
    });

    models.sort((a, b) => {
        if (b.triangles !== a.triangles) return b.triangles - a.triangles;
        return b.meshes - a.meshes;
    });

    return {
        models,
        issues,
        totals: {
            triangles: totalTriangles,
            meshes: totalMeshes,
            drawCalls: totalDrawCallsEstimate,
            uvMissing: totalUvMissing,
            badTransforms: totalBadTransforms,
            materials: uniqueMaterials.size,
            textures: uniqueTextures.size,
            maxTextureEdge,
            maxTextureName,
            maxTextureOwner,
        },
    };
}
