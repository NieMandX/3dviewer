import {
    assignEditableMaterial,
    collectMaterialTextures,
    disposeUnusedMaterialTree,
    editableMaterialIsAssigned,
    resolveEditableMaterialState,
} from './texture-utils.js';

export function createVPMBinder(options = {}) {
    const THREE = options.THREE || null;

    const basename = typeof options.basename === 'function'
        ? options.basename
        : (p) => (p || '').split(/[\\/]/).pop();
    const labelFromURL = typeof options.labelFromURL === 'function' ? options.labelFromURL : (url) => url || '';

    const toStandard = typeof options.toStandard === 'function' ? options.toStandard : (m) => m;
    const textureLoader = options.textureLoader || null;
    const copyTextureSettings =
        typeof options.copyTextureSettings === 'function' ? options.copyTextureSettings : () => {};
    const cacheOriginalMaterialFor =
        typeof options.cacheOriginalMaterialFor === 'function' ? options.cacheOriginalMaterialFor : () => {};

    const requestRender = typeof options.requestRender === 'function' ? options.requestRender : () => {};
    const schedulePanelRefresh = typeof options.schedulePanelRefresh === 'function' ? options.schedulePanelRefresh : () => {};
    const materialsPanel = options.materialsPanel || null;
    const logBind = typeof options.logBind === 'function' ? options.logBind : () => {};

    const getEnvironment = typeof options.getEnvironment === 'function' ? options.getEnvironment : () => null;
    const getEnvMapIntensity = typeof options.getEnvMapIntensity === 'function' ? options.getEnvMapIntensity : () => 1.0;
    const isWebGL2 = typeof options.isWebGL2 === 'function' ? options.isWebGL2 : () => false;

    const hasLoadedModelRegistry = Array.isArray(options.loadedModels);
    const loadedModels = hasLoadedModelRegistry ? options.loadedModels : [];
    const detectSlotFromMatOrObj = typeof options.detectSlotFromMatOrObj === 'function' ? options.detectSlotFromMatOrObj : () => 1;
    const findGeomSuffix = typeof options.findGeomSuffix === 'function' ? options.findGeomSuffix : () => null;
    const isGlassByName = typeof options.isGlassByName === 'function' ? options.isGlassByName : () => false;
    const isGlassGeomSuffix = typeof options.isGlassGeomSuffix === 'function' ? options.isGlassGeomSuffix : () => false;

    function vpmKeyFromFbxName(fbxName) {
        const base = basename(fbxName).replace(/\.[^.]+$/, '');
        const parts = base.split('_');
        return parts.slice(-2).join('_').toLowerCase(); // напр. "Vl_35" или "35_Ground"
    }

    function vpmKeyFromTexName(texLabel) {
        const base = texLabel.replace(/\.[^.]+$/, '').replace(/\.(10\d{2})$/, ''); // убрать .1001
        const tokens = base.split('_');
        const chIdx = tokens.findIndex(t => /^(diffuse|normal|erm)$/i.test(t));
        if (chIdx >= 2) return (tokens[chIdx - 2] + '_' + tokens[chIdx - 1]).toLowerCase();
        return tokens.slice(-2).join('_').toLowerCase();
    }

    function parseVpmParts(label) {
        const m = /_(Diffuse|Normal|ERM)_(\d+)\.(10\d{2})\b/i.exec(label);
        if (!m) return null;
        return {
            channel: m[1],           // 'Diffuse' | 'Normal' | 'ERM'
            slot: parseInt(m[2], 10), // число до точки
            udim: parseInt(m[3], 10), // 1001..1040
        };
    }

    function disposeCustomShadowMaterials(obj) {
        obj?.customDepthMaterial?.dispose?.();
        obj?.customDistanceMaterial?.dispose?.();
        if (obj) {
            obj.customDepthMaterial = undefined;
            obj.customDistanceMaterial = undefined;
        }
    }

    function disposePendingShadowMaterials(depthMaterial, distanceMaterial) {
        depthMaterial?.dispose?.();
        distanceMaterial?.dispose?.();
    }

    function isRootLive(root) {
        if (!root) return false;
        if (!hasLoadedModelRegistry) return true;
        return loadedModels.some((model) => model?.obj === root);
    }

    function disposeMaterialTree(material, options = {}) {
        if (!material) return;
        const materials = Array.isArray(material) ? material.filter(Boolean) : [material];
        const sharedTextures = new Set(Array.isArray(options.sharedTextures) ? options.sharedTextures.filter(Boolean) : []);
        const skipTextureKeys = new Set(options.skipTextureKeys || ['envMap', 'matcap']);
        const textures = new Set();
        materials.forEach((mat) => {
            collectMaterialTextures(mat, { skipTextureKeys, sharedTextures }).forEach((value) => {
                if (textures.has(value)) return;
                textures.add(value);
                value.dispose?.();
            });
            mat.dispose?.();
        });
    }

    /**
     * Строит индекс T_* текстур, присутствующих в ZIP, сгруппированных по ключу FBX.
     * Формат: Map<fbxKey, Map<`${slot}.${udim}`, { Diffuse, Normal, ERM }>>
     */
    function buildVPMIndex(allImages) {
        const byFBX = new Map();
        for (const e of allImages) {
            if (!e?.url) continue;
            const label = labelFromURL(e.url);
            const parts = parseVpmParts(label);
            if (!parts) continue;
            const fbxKey = vpmKeyFromTexName(label);
            const key2 = `${parts.slot}.${parts.udim}`;

            let sub = byFBX.get(fbxKey);
            if (!sub) {
                sub = new Map();
                byFBX.set(fbxKey, sub);
            }

            let rec = sub.get(key2);
            if (!rec) {
                rec = {};
                sub.set(key2, rec);
            }

            rec[parts.channel] = e.url; // Diffuse/Normal/ERM → URL
        }
        return byFBX;
    }

    /**
     * Разделяет ERM-карту (RGB: emissive/roughness/metalness) на отдельные CanvasTexture в линейном цветовом пространстве.
     */
    async function splitERMtoThreeMaps(url) {
        let img = null;
        try {
            img = await createImageBitmap(await (await fetch(url)).blob());
            const w = img.width, h = img.height;

            const base = document.createElement('canvas');
            base.width = w;
            base.height = h;
            const bctx = base.getContext('2d', { willReadFrequently: true });
            bctx.drawImage(img, 0, 0);
            const src = bctx.getImageData(0, 0, w, h);

            function chanToTex(ci) {
                const c = document.createElement('canvas');
                c.width = w;
                c.height = h;
                const ctx = c.getContext('2d');
                const dst = ctx.createImageData(w, h);
                for (let i = 0; i < src.data.length; i += 4) {
                    const v = src.data[i + ci];
                    dst.data[i] = dst.data[i + 1] = dst.data[i + 2] = v;
                    dst.data[i + 3] = 255;
                }
                ctx.putImageData(dst, 0, 0);
                const t = new THREE.CanvasTexture(c);
                t.colorSpace = THREE.LinearSRGBColorSpace; // линейные для rough/metal/emissiveMap
                t.flipY = false;
                return t;
            }

            return {
                emissiveMap: chanToTex(0), // R
                roughnessMap: chanToTex(1), // G
                metalnessMap: chanToTex(2), // B
            };
        } finally {
            img?.close?.();
        }
    }

    /**
     * Вычисляет UDIM-тайл по геометрии: берёт средние координаты UV и конвертирует в 1001+.
     */
    function detectUDIMfromGeo(geo) {
        const uv = geo?.getAttribute?.('uv');
        if (!uv) return 1001;
        let uMin = +Infinity, vMin = +Infinity, uMax = -Infinity, vMax = -Infinity;
        for (let i = 0; i < uv.count; i++) {
            const u = uv.getX(i), v = uv.getY(i);
            uMin = Math.min(uMin, u);
            vMin = Math.min(vMin, v);
            uMax = Math.max(uMax, u);
            vMax = Math.max(vMax, v);
        }
        const tileU = Math.floor((uMin + uMax) * 0.5);
        const tileV = Math.floor((vMin + vMax) * 0.5);
        return 1001 + tileU + tileV * 10;
    }

    /**
     * Автоматически привязывает Diffuse/Normal/ERM карты к каждому UDIM-сабмешу модели ВПМ.
     * Перезаписывает материалы (clone → MeshStandardMaterial), применяет стекло, ERM и окружение.
     */
    async function autoBindVPMForModel(root, vpmIndex) {
        if (!root || !vpmIndex) return;
        if (!THREE) return;
        if (!isRootLive(root)) return;

        const env = getEnvironment();
        const envInt = parseFloat(getEnvMapIntensity());

        // 1) имя FBX и ключ набора (двойной хвост)
        const fileName =
            root?.userData?._fbxFileName ||
            (loadedModels.find(m => m.obj === root)?.name) ||
            null;

        if (!fileName) {
            logBind('VPM: не удалось вычислить имя FBX — привязываю без фильтра', 'warn');
        }

        const fbxKey = fileName ? vpmKeyFromFbxName(fileName) : null;
        const sub = fbxKey ? vpmIndex.get(fbxKey) : null;
        if (!sub) {
            logBind(`VPM: для набора ${fbxKey || '(unknown)'} нет индекса — пропускаю модель`, 'info');
            return;
        }

	        const bindOps = []; // промисы (для ERM)
	        let appliedCount = 0;

        root.traverse(o => {
            if (!isRootLive(root)) return;
            if (!o.isMesh || !o.geometry) return;
            if (o.userData?.isCollision) return;
            const materialState = resolveEditableMaterialState(o);
            if (!materialState.materials.length) return;

            // 2) UDIM и SLOT для текущего меша
            const udim = o.userData?.udim || detectUDIMfromGeo(o.geometry);
            const primaryMat = materialState.materials[0];
            const slot = detectSlotFromMatOrObj(o, primaryMat);

            const label = `${primaryMat?.name || ''} ${o.name || ''}`;
            const geomSuffix = findGeomSuffix(label);
            if (isGlassByName(label) || isGlassGeomSuffix(geomSuffix)) {
                logBind(`VPM: пропущен стеклянный меш "${o.name}" (slot ${slot}, udim ${udim})`, 'info');
                return;
            }

            logBind(`VPM: mesh="${o.name}" → slot=${slot}, udim=${udim}`, 'info');

            // 3) Берём набор карт для ЭТОГО FBX по ключу slot.udim
            const key = `${slot}.${udim}`;
            const set = sub.get(key);
            if (!set) {
                logBind(`VPM: нет карт для slot=${slot}, udim=${udim}`, 'info');
                return;
            }

            // (опция) двойная проверка хвоста: карта действительно от этого FBX?
            if (fbxKey) {
                const anyUrl = set.Diffuse || set.Normal || set.ERM;
                const texKey = anyUrl ? vpmKeyFromTexName(labelFromURL(anyUrl)) : null;
                if (texKey && texKey !== fbxKey) {
                    logBind(`VPM: "${labelFromURL(anyUrl)}" → ключ ${texKey} ≠ ${fbxKey} — пропускаю`, 'info');
                    return;
                }
            }

            // 4) Базовый материал → Standard-клон
            const previousMaterial = materialState.source === 'original' ? materialState.originalValue : o.material;
            const sourceMaterial = primaryMat;
            const bindGeneration = (Number(o.userData?._vpmBindGeneration) || 0) + 1;
            (o.userData ||= {})._vpmBindGeneration = bindGeneration;
            let bindActive = true;
            const isBindCurrent = () => (
                bindActive &&
                isRootLive(root) &&
                o.userData?._vpmBindGeneration === bindGeneration &&
                (
                    materialState.source === 'original'
                        ? (
                            o.userData?._origMaterial === materialState.originalValue ||
                            editableMaterialIsAssigned(o, materialState, mat)
                        )
                        : (o.material === previousMaterial || o.material === mat)
                )
            );
            const base = toStandard(sourceMaterial);
            const mat = base.clone();
            if (base !== sourceMaterial) {
                base.dispose?.();
            }
            const fallbackName = base.name || `M · UDIM ${udim}`;
            mat.name = base.name ? base.name : fallbackName;
            (mat.userData ||= {}).vpm = { key, slot, udim };
            let pendingDepthMaterial = null;
            let pendingDistanceMaterial = null;

            function isTextureStillOwned(texture, materialSlot) {
                if (!texture?.isTexture) return false;
                if (!bindActive) return false;
                if (!isRootLive(root)) return false;
                if (o.userData?._vpmBindGeneration !== bindGeneration) return false;
                if (materialState.source === 'original') {
                    const originalUnchanged = o.userData?._origMaterial === materialState.originalValue;
                    if (!originalUnchanged && !editableMaterialIsAssigned(o, materialState, mat)) return false;
                } else if (o.material !== previousMaterial && o.material !== mat) {
                    return false;
                }
                return mat?.[materialSlot] === texture;
            }

            function handleLoadedTexture(texture, materialSlot) {
                if (!isTextureStillOwned(texture, materialSlot)) {
                    texture?.dispose?.();
                    return;
                }
                if (o.material === mat) requestRender();
            }

            function handleTextureLoadError(texture, materialSlot, label, err) {
                if (!isTextureStillOwned(texture, materialSlot)) {
                    texture?.dispose?.();
                    return;
                }
                logBind(`VPM: ${label} не загрузилась → ${err?.message || err || 'unknown error'}`, 'warn');
            }

            function applyPendingShadowMaterials() {
                if (!pendingDepthMaterial && !pendingDistanceMaterial) return;
                disposeCustomShadowMaterials(o);
                o.customDepthMaterial = pendingDepthMaterial || undefined;
                o.customDistanceMaterial = pendingDistanceMaterial || undefined;
                pendingDepthMaterial = null;
                pendingDistanceMaterial = null;
            }

            // Diffuse
            if (set.Diffuse && textureLoader) {
                const prevMap = mat.map || null;
                const nm = labelFromURL(set.Diffuse);
                let map = null;
                map = textureLoader.load(
                    set.Diffuse,
                    () => handleLoadedTexture(map, 'map'),
                    undefined,
                    (err) => handleTextureLoadError(map, 'map', nm, err),
                );
                map.name = nm;
                map.userData ||= {};
                map.userData.origName = nm;
                map.colorSpace = THREE.SRGBColorSpace;
                // map.flipY = false;
                copyTextureSettings(prevMap, map);
                mat.map = map;

                // не для стекла — маска по альфа-каналу диффуза
                const lowerLabel = `${mat.name || ''} ${o.name || ''}`.toLowerCase();
                const isGlass = /mainglass|groundglass|groundelglass/.test(lowerLabel);
                if (!isGlass) {
                    mat.transparent = false; // маска, не блендинг
                    mat.depthWrite = true;
	                    mat.alphaTest = Math.max(0.001, mat.alphaTest || 0.4);
	                    if (isWebGL2()) mat.alphaToCoverage = true;

	                    const common = { map: mat.map, alphaTest: mat.alphaTest, side: THREE.FrontSide };
	                    pendingDepthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, ...common });
	                    pendingDistanceMaterial = new THREE.MeshDistanceMaterial(common);
	                }
	            }

            // Normal
            if (set.Normal && textureLoader) {
                const prevNormal = mat.normalMap || null;
                const nm = labelFromURL(set.Normal);
                let n = null;
                n = textureLoader.load(
                    set.Normal,
                    () => handleLoadedTexture(n, 'normalMap'),
                    undefined,
                    (err) => handleTextureLoadError(n, 'normalMap', nm, err),
                );
                n.name = nm;
                n.userData ||= {};
                n.userData.origName = nm;
                n.colorSpace = THREE.LinearSRGBColorSpace; // нормали в линейном
                // n.flipY = false;
                copyTextureSettings(prevNormal, n);
                mat.normalMap = n;
                mat.normalScale = new THREE.Vector2(1, 1);
            }

            // ERM (асинхронно распакуем каналы)
            if (set.ERM) {
                const p = (async () => {
                    try {
                        const maps = await splitERMtoThreeMaps(set.ERM);
                        const baseNm = labelFromURL(set.ERM);

                        if (maps.emissiveMap) {
                            maps.emissiveMap.name = `${baseNm} [R]`;
                            maps.emissiveMap.userData ||= {};
                            maps.emissiveMap.userData.origName = maps.emissiveMap.name;
                        }
                        if (maps.roughnessMap) {
                            maps.roughnessMap.name = `${baseNm} [G]`;
                            maps.roughnessMap.userData ||= {};
                            maps.roughnessMap.userData.origName = maps.roughnessMap.name;
                        }
                        if (maps.metalnessMap) {
                            maps.metalnessMap.name = `${baseNm} [B]`;
                            maps.metalnessMap.userData ||= {};
                            maps.metalnessMap.userData.origName = maps.metalnessMap.name;
                        }

                        mat.emissive = new THREE.Color(1, 1, 1);
                        mat.emissiveIntensity = 1.0;
                        mat.emissiveMap = maps.emissiveMap; // R
                        mat.roughnessMap = maps.roughnessMap; // G
                        mat.metalnessMap = maps.metalnessMap; // B
                        mat.metalness = 1.0; // карта задаёт финальное значение
                        mat.needsUpdate = true;

                        if (!isBindCurrent()) {
                            bindActive = false;
                            disposeMaterialTree(mat, {
                                sharedTextures: Array.from(collectMaterialTextures(previousMaterial)),
                            });
                            disposePendingShadowMaterials(pendingDepthMaterial, pendingDistanceMaterial);
                            return;
                        }

                        if (env) {
                            mat.envMap = env;
                            mat.envMapIntensity = envInt;
                        }
                        applyPendingShadowMaterials();
                        assignEditableMaterial(o, materialState, 0, mat);
                        cacheOriginalMaterialFor(o, true);
                        disposeUnusedMaterialTree(previousMaterial, { root });
                        appliedCount += 1;
                        logBind(`VPM: Slot ${slot}, UDIM ${udim} → ${mat.name}`, 'ok');
                    } catch (err) {
                        const wasBindCurrent = isBindCurrent();
                        bindActive = false;
                        disposeMaterialTree(mat, {
                            sharedTextures: Array.from(collectMaterialTextures(previousMaterial)),
                        });
                        disposePendingShadowMaterials(pendingDepthMaterial, pendingDistanceMaterial);
                        if (wasBindCurrent) {
                            logBind(`VPM: ERM ${labelFromURL(set.ERM)} не обработан → ${err?.message || err}`, 'warn');
                        }
                    }
                })();
                bindOps.push(p);
            } else {
                if (env) {
                    mat.envMap = env;
                    mat.envMapIntensity = envInt;
                }
                applyPendingShadowMaterials();
                assignEditableMaterial(o, materialState, 0, mat);
                cacheOriginalMaterialFor(o, true);
                disposeUnusedMaterialTree(previousMaterial, { root });
                appliedCount += 1;
                logBind(`VPM: Slot ${slot}, UDIM ${udim} (без ERM) → ${mat.name}`, 'ok');
            }
        });

	        await Promise.all(bindOps);
	        if (!isRootLive(root)) return;
	        if (!appliedCount) return;
	        requestRender();
        materialsPanel?.markNeedsFullRefresh?.();
        schedulePanelRefresh();
    }

    return {
        buildVPMIndex,
        autoBindVPMForModel,
    };
}
