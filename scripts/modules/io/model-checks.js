function toFiniteNumber(value) {
    const num = Number(value);
    return Number.isFinite(num) ? num : 0;
}

function getTriangleCount(geometry) {
    if (!geometry?.attributes?.position) return 0;
    if (geometry.index?.count) {
        return Math.max(0, Math.floor(geometry.index.count / 3));
    }
    return Math.max(0, Math.floor(geometry.attributes.position.count / 3));
}

function pushCheck(checks, status, title, message, details = null) {
    checks.push({
        status,
        title,
        message,
        details: Array.isArray(details) ? details.filter(Boolean) : null,
    });
}

function mapStatus(value) {
    if (value === 'error') return 'fail';
    if (value === 'warn') return 'warn';
    return 'pass';
}

function formatBounds(size) {
    if (!size) return '0 x 0 x 0';
    return `${size.x.toFixed(1)} x ${size.y.toFixed(1)} x ${size.z.toFixed(1)}`;
}

function collectMaterialTextures(material) {
    const textures = [];
    if (!material || typeof material !== 'object') return textures;
    Object.values(material).forEach((value) => {
        if (value?.isTexture) textures.push(value);
    });
    return textures;
}

export function createModelChecksRunner(options = {}) {
    const THREE = options.THREE || null;
    const loadedModels = Array.isArray(options.loadedModels) ? options.loadedModels : [];

    const limits = Object.freeze({
        trianglesWarn: 2_000_000,
        trianglesError: 5_000_000,
        drawCallsWarn: 2_000,
        drawCallsError: 4_000,
        meshesWarn: 1_500,
        meshesError: 3_000,
        materialsWarn: 300,
        materialsError: 700,
        texturesWarn: 250,
        texturesError: 500,
        modelTrianglesWarn: 900_000,
        modelTrianglesError: 1_800_000,
        boundsWarn: 8_000,
        boundsError: 20_000,
        textureSizeWarn: 4096,
        textureSizeError: 8192,
        ...(options.limits || {}),
    });

    function run() {
        const checks = [];
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

        loadedModels.forEach((model, index) => {
            const root = model?.obj || null;
            if (!root?.traverse) return;

            const modelName = model?.name || `model-${index + 1}`;
            const modelMaterials = new Set();
            const modelTextures = new Set();
            const modelIssues = [];
            const bounds = THREE ? new THREE.Box3() : null;

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
                        const texId = texture.uuid || `${modelName}-${texture.name || 'texture'}`;
                        modelTextures.add(texId);
                        if (!uniqueTextures.has(texId)) {
                            uniqueTextures.set(texId, texture);
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

                const hasBadTransform = !Number.isFinite(node.position?.x) ||
                    !Number.isFinite(node.position?.y) ||
                    !Number.isFinite(node.position?.z) ||
                    !Number.isFinite(node.scale?.x) ||
                    !Number.isFinite(node.scale?.y) ||
                    !Number.isFinite(node.scale?.z);
                if (hasBadTransform) {
                    modelBadTransforms += 1;
                }
            });

            const orientationType = Number(model?.orientationType);
            const normalizedOrientationType = Number(model?.normalizedOrientationType);
            const orientationKnown = [1, 2, 3, 4].includes(normalizedOrientationType) || [1, 2, 3, 4].includes(orientationType);
            if (!orientationKnown) {
                modelIssues.push('Неопределённая ориентация FBX');
            }
            if (modelUvMissing > 0) {
                modelIssues.push(`Материалы с текстурами без UV: ${modelUvMissing}`);
            }
            if (modelBadTransforms > 0) {
                modelIssues.push(`Некорректные transform (NaN/Inf): ${modelBadTransforms}`);
            }

            const boundsSize = bounds ? bounds.getSize(new THREE.Vector3()) : null;
            const maxEdge = boundsSize ? Math.max(boundsSize.x, boundsSize.y, boundsSize.z) : 0;
            if (maxEdge > limits.boundsWarn) {
                modelIssues.push(`Очень крупный bounding box: ${formatBounds(boundsSize)}`);
            }

            const modelStatus =
                modelTriangles >= limits.modelTrianglesError || modelIssues.length > 2
                    ? 'error'
                    : modelTriangles >= limits.modelTrianglesWarn || modelIssues.length > 0
                        ? 'warn'
                        : 'pass';

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
                bounds: boundsSize
                    ? {
                        x: boundsSize.x,
                        y: boundsSize.y,
                        z: boundsSize.z,
                        maxEdge,
                    }
                    : null,
            });

            modelIssues.forEach((issue) => {
                issues.push(`${modelName}: ${issue}`);
            });
        });

        const totalMaterials = uniqueMaterials.size;
        const totalTextures = uniqueTextures.size;

        const trianglesStatus =
            totalTriangles >= limits.trianglesError
                ? 'error'
                : totalTriangles >= limits.trianglesWarn
                    ? 'warn'
                    : 'pass';
        pushCheck(
            checks,
            mapStatus(trianglesStatus),
            'Треугольники сцены',
            `${totalTriangles.toLocaleString('ru-RU')} трис.`,
            [
                `Порог warn: ${limits.trianglesWarn.toLocaleString('ru-RU')}`,
                `Порог fail: ${limits.trianglesError.toLocaleString('ru-RU')}`,
            ]
        );

        const drawCallsStatus =
            totalDrawCallsEstimate >= limits.drawCallsError
                ? 'error'
                : totalDrawCallsEstimate >= limits.drawCallsWarn
                    ? 'warn'
                    : 'pass';
        pushCheck(
            checks,
            mapStatus(drawCallsStatus),
            'Оценка draw calls',
            `${totalDrawCallsEstimate.toLocaleString('ru-RU')} вызовов`,
            [
                `Порог warn: ${limits.drawCallsWarn.toLocaleString('ru-RU')}`,
                `Порог fail: ${limits.drawCallsError.toLocaleString('ru-RU')}`,
            ]
        );

        const meshesStatus =
            totalMeshes >= limits.meshesError
                ? 'error'
                : totalMeshes >= limits.meshesWarn
                    ? 'warn'
                    : 'pass';
        pushCheck(
            checks,
            mapStatus(meshesStatus),
            'Количество мешей',
            `${totalMeshes.toLocaleString('ru-RU')} мешей`,
            [
                `Порог warn: ${limits.meshesWarn.toLocaleString('ru-RU')}`,
                `Порог fail: ${limits.meshesError.toLocaleString('ru-RU')}`,
            ]
        );

        const materialsStatus =
            totalMaterials >= limits.materialsError
                ? 'error'
                : totalMaterials >= limits.materialsWarn
                    ? 'warn'
                    : 'pass';
        pushCheck(
            checks,
            mapStatus(materialsStatus),
            'Уникальные материалы',
            `${totalMaterials.toLocaleString('ru-RU')} материалов`,
            [
                `Порог warn: ${limits.materialsWarn.toLocaleString('ru-RU')}`,
                `Порог fail: ${limits.materialsError.toLocaleString('ru-RU')}`,
            ]
        );

        const texturesStatus =
            totalTextures >= limits.texturesError
                ? 'error'
                : totalTextures >= limits.texturesWarn
                    ? 'warn'
                    : 'pass';
        pushCheck(
            checks,
            mapStatus(texturesStatus),
            'Уникальные текстуры',
            `${totalTextures.toLocaleString('ru-RU')} текстур`,
            [
                `Порог warn: ${limits.texturesWarn.toLocaleString('ru-RU')}`,
                `Порог fail: ${limits.texturesError.toLocaleString('ru-RU')}`,
            ]
        );

        const textureEdgeStatus =
            maxTextureEdge >= limits.textureSizeError
                ? 'error'
                : maxTextureEdge >= limits.textureSizeWarn
                    ? 'warn'
                    : 'pass';
        if (maxTextureEdge > 0) {
            pushCheck(
                checks,
                mapStatus(textureEdgeStatus),
                'Максимальный размер текстуры',
                `${maxTextureEdge}px`,
                [
                    `Файл: ${maxTextureName || '—'}`,
                    `Модель: ${maxTextureOwner || '—'}`,
                    `Порог warn: ${limits.textureSizeWarn}px`,
                    `Порог fail: ${limits.textureSizeError}px`,
                ]
            );
        }

        if (totalUvMissing > 0) {
            pushCheck(
                checks,
                'warn',
                'UV-координаты',
                `${totalUvMissing.toLocaleString('ru-RU')} мешей с текстурами без UV`,
                ['Проверьте развертку UV перед экспортом.']
            );
        } else {
            pushCheck(
                checks,
                'pass',
                'UV-координаты',
                'Проблем не найдено'
            );
        }

        if (totalBadTransforms > 0) {
            pushCheck(
                checks,
                'fail',
                'Transform валидность',
                `${totalBadTransforms.toLocaleString('ru-RU')} мешей с NaN/Inf`,
                ['Нужно очистить transform перед экспортом.']
            );
        } else {
            pushCheck(
                checks,
                'pass',
                'Transform валидность',
                'Проблем не найдено'
            );
        }

        const severeModels = models
            .filter((model) => model.status !== 'pass')
            .map((model) => `${model.name}: ${model.status === 'error' ? 'fail' : 'warn'}`);
        if (severeModels.length) {
            pushCheck(
                checks,
                severeModels.some((value) => value.includes('fail')) ? 'fail' : 'warn',
                'Проблемные модели',
                `${severeModels.length.toLocaleString('ru-RU')} шт.`,
                severeModels.slice(0, 10)
            );
        } else {
            pushCheck(
                checks,
                'pass',
                'Проблемные модели',
                'Критичных проблем не найдено'
            );
        }

        const errors = checks.filter((item) => item.status === 'fail').length;
        const warnings = checks.filter((item) => item.status === 'warn').length;
        const passes = checks.filter((item) => item.status === 'pass').length;

        models.sort((a, b) => {
            if (b.triangles !== a.triangles) return b.triangles - a.triangles;
            return b.meshes - a.meshes;
        });

        return {
            generatedAt: new Date().toISOString(),
            summary: {
                models: models.length,
                triangles: totalTriangles,
                meshes: totalMeshes,
                drawCalls: totalDrawCallsEstimate,
                materials: totalMaterials,
                textures: totalTextures,
                warnings,
                errors,
                passes,
            },
            checks,
            models,
            issues,
            limits,
        };
    }

    return Object.freeze({ run });
}
