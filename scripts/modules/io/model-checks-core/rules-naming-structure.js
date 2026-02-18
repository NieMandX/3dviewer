import { addCheck, collectMaterialTextures } from './utils.js';

const INVALID_NAME_RX = /[^a-zA-Z0-9_.]/;
const MAX_NAME_LENGTH = 254;
const DEFAULT_MATERIAL_NAME_RX = /^_*default(?:_?material)?\s*$/i;

function limitDetails(lines, maxCount = 12) {
    if (!Array.isArray(lines) || lines.length <= maxCount) return lines || [];
    const hidden = lines.length - maxCount;
    return [...lines.slice(0, maxCount), `…и еще ${hidden} шт.`];
}

function getNodeMaterials(node) {
    if (!node?.isMesh) return [];
    const source = Array.isArray(node.material) ? node.material : [node.material];
    return source.filter(Boolean);
}

function isTechnicalDefaultMaterialName(name) {
    const normalized = String(name || '').trim();
    return !normalized || DEFAULT_MATERIAL_NAME_RX.test(normalized);
}

function checkNamingRules(loadedModels) {
    const invalidNames = [];
    const tooLongNames = [];
    const visited = new Set();

    function pushName(kind, value) {
        const name = String(value || '').trim();
        if (!name) return;
        const key = `${kind}:${name}`;
        if (visited.has(key)) return;
        visited.add(key);

        if (INVALID_NAME_RX.test(name)) {
            invalidNames.push(`${kind}: ${name}`);
        }
        if (name.length > MAX_NAME_LENGTH) {
            tooLongNames.push(`${kind}: ${name} (${name.length})`);
        }
    }

    loadedModels.forEach((model, index) => {
        const modelName = model?.name || `model-${index + 1}`;
        pushName('FBX', modelName);
        pushName('ZIP', model?.group || '');

        const root = model?.obj;
        if (!root?.traverse) return;

        root.traverse((node) => {
            pushName('Object', node?.name || '');
            if (!node?.isMesh) return;
            getNodeMaterials(node).forEach((mat) => {
                pushName('Material', mat?.name || '');
                collectMaterialTextures(mat).forEach((texture) => {
                    pushName('Texture', texture?.name || texture?.uuid || '');
                });
            });
        });
    });

    const checks = [];
    if (invalidNames.length > 0) {
        addCheck(
            checks,
            'warn',
            'Наименования: недопустимые символы',
            `${invalidNames.length.toLocaleString('ru-RU')} имен содержат недопустимые символы`,
            limitDetails(invalidNames)
        );
    } else {
        addCheck(checks, 'pass', 'Наименования: недопустимые символы', 'Проблем не найдено');
    }

    if (tooLongNames.length > 0) {
        addCheck(
            checks,
            'fail',
            'Наименования: длина',
            `${tooLongNames.length.toLocaleString('ru-RU')} имен длиннее ${MAX_NAME_LENGTH} символов`,
            limitDetails(tooLongNames)
        );
    } else {
        addCheck(checks, 'pass', 'Наименования: длина', 'Проблем не найдено');
    }

    return checks;
}

function analyzeModelStructure(model, index) {
    const modelName = model?.name || `model-${index + 1}`;
    const root = model?.obj || null;
    const isLightModel = /_Light\.fbx$/i.test(modelName);
    const modelZipKind = String(model?.zipKind || '').trim().toUpperCase();
    const isNpmModel = modelZipKind === 'NPM';

    const issuesFail = [];
    const issuesWarn = [];
    if (!root?.traverse) {
        issuesFail.push(`${modelName}: отсутствует корневой объект`);
        return { issuesFail, issuesWarn };
    }

    let ucxCount = 0;
    let glassMeshCount = 0;
    let lightCount = 0;
    let cameraCount = 0;
    let meshHierarchyCount = 0;
    let meshCount = 0;

    root.traverse((node) => {
        if (!node) return;
        if (node.isLight) {
            lightCount += 1;
            return;
        }
        if (node.isCamera) {
            cameraCount += 1;
            return;
        }
        if (!node.isMesh) return;
        if (node.userData?.isCollision) {
            ucxCount += 1;
            return;
        }
        meshCount += 1;
        if (/glass/i.test(String(node.name || ''))) {
            glassMeshCount += 1;
        }
        if (node.parent?.isMesh && !node.parent?.userData?.isCollision) {
            meshHierarchyCount += 1;
        }
    });

    if (isLightModel) {
        if (meshCount > 0) {
            issuesFail.push(`${modelName}: light-FBX содержит геометрию (${meshCount} mesh)`);
        }
        if (lightCount === 0) {
            issuesWarn.push(`${modelName}: не найдено источников света`);
        }
    } else {
        if (!isNpmModel && ucxCount === 0) {
            issuesFail.push(`${modelName}: не найдены коллизии UCX`);
        }
        if (isNpmModel && ucxCount > 0) {
            issuesFail.push(`${modelName}: в НПМ обнаружены коллизии UCX (${ucxCount})`);
        }
        if (glassMeshCount > 1) {
            issuesFail.push(`${modelName}: остекление разбито на ${glassMeshCount} mesh (должен быть 1)`);
        }
        if (meshHierarchyCount > 0) {
            issuesFail.push(`${modelName}: обнаружены иерархические связи mesh->mesh (${meshHierarchyCount})`);
        }
        if (lightCount > 0) {
            issuesWarn.push(`${modelName}: найдено ${lightCount} источников света в обычном FBX`);
        }
        if (cameraCount > 0) {
            issuesWarn.push(`${modelName}: найдено ${cameraCount} камер в обычном FBX`);
        }
    }

    return { issuesFail, issuesWarn };
}

function checkStructureRules(loadedModels) {
    const fail = [];
    const warn = [];

    loadedModels.forEach((model, index) => {
        const result = analyzeModelStructure(model, index);
        fail.push(...result.issuesFail);
        warn.push(...result.issuesWarn);
    });

    const checks = [];
    if (fail.length > 0) {
        addCheck(
            checks,
            'fail',
            'FBX: состав и структура',
            `${fail.length.toLocaleString('ru-RU')} критичных несоответствий`,
            limitDetails([...fail, ...warn])
        );
    } else if (warn.length > 0) {
        addCheck(
            checks,
            'warn',
            'FBX: состав и структура',
            `${warn.length.toLocaleString('ru-RU')} предупреждений`,
            limitDetails(warn)
        );
    } else {
        addCheck(checks, 'pass', 'FBX: состав и структура', 'Проблем не найдено');
    }

    return checks;
}

function checkMaterialRules(loadedModels) {
    const critical = [];
    const warnings = [];

    loadedModels.forEach((model, index) => {
        const modelName = model?.name || `model-${index + 1}`;
        const root = model?.obj || null;
        if (!root?.traverse) return;

        root.traverse((node) => {
            if (!node?.isMesh) return;
            const meshName = String(node.name || node.uuid || 'mesh');
            const mats = getNodeMaterials(node);
            const matCount = mats.length;
            const isCollision = !!node.userData?.isCollision;
            const importState = node.userData?.importMaterialState || null;
            const sourceMatCount = Number.isFinite(Number(importState?.materialCount))
                ? Number(importState.materialCount)
                : matCount;
            const sourceMaterialNames = Array.isArray(importState?.materialNames)
                ? importState.materialNames
                    .map((name) => String(name || '').trim())
                    .filter(Boolean)
                : [];
            const sourceAuthoredNames = Array.isArray(importState?.authoredMaterialNames)
                ? importState.authoredMaterialNames
                    .map((name) => String(name || '').trim())
                    .filter(Boolean)
                : sourceMaterialNames.filter((name) => !isTechnicalDefaultMaterialName(name));
            const sourceAuthoredMatCount = Number.isFinite(Number(importState?.authoredMaterialCount))
                ? Number(importState.authoredMaterialCount)
                : sourceAuthoredNames.length;
            const sourceHasMaterial = importState
                ? (
                    typeof importState.hasAuthoredMaterial === 'boolean'
                        ? importState.hasAuthoredMaterial
                        : sourceAuthoredMatCount > 0
                )
                : sourceMatCount > 0;
            const isGlass = /glass/i.test(meshName);
            const isMain = /main/i.test(meshName);

            if (isCollision) {
                if (sourceHasMaterial) {
                    const namesForView = sourceAuthoredNames.length ? sourceAuthoredNames : sourceMaterialNames;
                    const shownCount = sourceAuthoredMatCount > 0 ? sourceAuthoredMatCount : sourceMatCount;
                    const named = namesForView.length
                        ? ` [${namesForView.slice(0, 3).join(', ')}${namesForView.length > 3 ? ', …' : ''}]`
                        : '';
                    critical.push(
                        `${modelName} / ${meshName}: у UCX назначены материалы в исходном FBX (${shownCount})${named}`
                    );
                }
                return;
            }

            if (matCount === 0) {
                critical.push(`${modelName} / ${meshName}: отсутствует материал`);
            }
            if (isGlass && matCount > 7) {
                critical.push(`${modelName} / ${meshName}: материалов остекления больше 7 (${matCount})`);
            }
            if (!isGlass && matCount > 7) {
                critical.push(`${modelName} / ${meshName}: материалов больше 7 (${matCount})`);
            }

            if (isMain && matCount > 1) {
                const slotNumbers = [];
                mats.forEach((mat) => {
                    const match = String(mat?.name || '').match(/_(\d+)$/);
                    if (!match) {
                        critical.push(`${modelName} / ${meshName}: у материала ${mat?.name || 'Unnamed'} нет SlotNumber (_N)`);
                        return;
                    }
                    slotNumbers.push(Number(match[1]));
                });
                if (slotNumbers.length) {
                    const expected = Array.from({ length: slotNumbers.length }, (_, i) => i + 1);
                    const actual = slotNumbers.slice().sort((a, b) => a - b);
                    const valid = actual.length === expected.length && actual.every((value, i) => value === expected[i]);
                    if (!valid) {
                        critical.push(`${modelName} / ${meshName}: SlotNumber должен быть 1..N (сейчас ${actual.join(', ')})`);
                    }
                }
            }

            if (isGlass) {
                mats.forEach((mat) => {
                    const textures = collectMaterialTextures(mat);
                    if (textures.length > 0) {
                        warnings.push(`${modelName} / ${meshName}: материал ${mat?.name || 'Unnamed'} содержит текстуры (${textures.length})`);
                    }
                });
            }
        });
    });

    const checks = [];
    if (critical.length > 0) {
        addCheck(
            checks,
            'fail',
            'Материалы: базовые ограничения',
            `${critical.length.toLocaleString('ru-RU')} критичных несоответствий`,
            limitDetails([...critical, ...warnings])
        );
    } else if (warnings.length > 0) {
        addCheck(
            checks,
            'warn',
            'Материалы: базовые ограничения',
            `${warnings.length.toLocaleString('ru-RU')} предупреждений`,
            limitDetails(warnings)
        );
    } else {
        addCheck(checks, 'pass', 'Материалы: базовые ограничения', 'Проблем не найдено');
    }

    return checks;
}

export function runNamingStructureChecksRule(context = {}) {
    const loadedModels = Array.isArray(context?.loadedModels) ? context.loadedModels : [];
    return [
        ...checkNamingRules(loadedModels),
        ...checkStructureRules(loadedModels),
        ...checkMaterialRules(loadedModels),
    ];
}
