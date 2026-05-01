import { disposeUnusedMaterialTree, objectTreeUsesTexture } from './texture-utils.js';

export function createFilenameBinder(options = {}) {
    const THREE = options.THREE || null;

    const basename = typeof options.basename === 'function'
        ? options.basename
        : (p) => (p || '').split(/[\\/]/).pop();
    const geomSuffixes = Array.isArray(options.geomSuffixes) ? options.geomSuffixes : [];
    const guessKindFromName = typeof options.guessKindFromName === 'function' ? options.guessKindFromName : () => 'other';
    const findGeomSuffix = typeof options.findGeomSuffix === 'function' ? options.findGeomSuffix : () => null;

    const toStandard = typeof options.toStandard === 'function' ? options.toStandard : (m) => m;
    const textureLoader = options.textureLoader || null;
    const copyTextureSettings =
        typeof options.copyTextureSettings === 'function' ? options.copyTextureSettings : () => {};
    const cacheOriginalMaterialFor =
        typeof options.cacheOriginalMaterialFor === 'function' ? options.cacheOriginalMaterialFor : () => {};
    const logBind = typeof options.logBind === 'function' ? options.logBind : () => {};
    const undoStack = Array.isArray(options.undoStack) ? options.undoStack : null;

    const getEnvironment = typeof options.getEnvironment === 'function' ? options.getEnvironment : () => null;
    const getEnvMapIntensity = typeof options.getEnvMapIntensity === 'function' ? options.getEnvMapIntensity : () => 1.0;

    function parseTexName(filename) {
        const rawBase = basename(filename).replace(/\.[a-z0-9]+$/i, '');
        const base = rawBase.toLowerCase();
        const parts = rawBase.split('_');
        const lowerParts = base.split('_');

        // id в конце опционален → по умолчанию 1
        let id = 1;
        const last = lowerParts[lowerParts.length - 1];
        if (/^\d+$/.test(last)) {
            id = parseInt(parts.pop(), 10);
            lowerParts.pop();
        }

        // поддерживаем оба порядка: ..._<geom>_<map>_[id] И ..._<map>_<geom>_[id]
        const a = lowerParts.slice(-2);
        if (a.length < 2) return null;
        let [p1, p2] = a;

        let geom, map;
        if (geomSuffixes.includes(p1)) {
            geom = p1;
            map = p2;
        } else if (geomSuffixes.includes(p2)) {
            geom = p2;
            map = p1;
        } else {
            return null;
        }

        const kindMap = { d: 'base', n: 'normal', o: 'alpha', m: 'metalness', r: 'roughness' };
        const kind = kindMap[map] || guessKindFromName(filename);

        let code3 = null;
        const lowerGeomIndex = lowerParts.lastIndexOf(geom);
        if (lowerGeomIndex > 0) {
            const candidate = parts[lowerGeomIndex - 1];
            if (/^\d{3}$/i.test(candidate)) {
                code3 = candidate.padStart(3, '0');
            }
        }

        return { id, geomSuffix: geom, mapSuffix: map, code3, kind };
    }

    function kindToSlot(kind) {
        switch (kind) {
            case 'base': return 'map';
            case 'normal': return 'normalMap';
            case 'alpha': return 'alphaMap';
            case 'metalness': return 'metalnessMap';
            case 'roughness': return 'roughnessMap';
            case 'ao': return 'aoMap';
            default: return null;
        }
    }

    function indexModelMaterials(root) {
        const idx = new Map();
        root.traverse(o => {
            if (!o.isMesh || !o.material) return;
            if (o.userData?.isCollision) return;
            const mats = Array.isArray(o.material) ? o.material : [o.material];
            mats.forEach((m, i) => {
                const materialId = i + 1;
                const label = `${m.name || ''} ${o.name || ''}`.toLowerCase();
                const code3Match = label.match(/(^|[_\W])(\d{3})([_\W]|$)/);
                const code3 = code3Match ? code3Match[2] : null;
                const geom = findGeomSuffix(label);
                const keys = [];
                if (geom) {
                    keys.push(`${code3 || '—'}|${geom}|${materialId}`);
                    keys.push(`—|${geom}|${materialId}`);
                }
                keys.push(`${code3 || '—'}|—|${materialId}`);
                keys.push(`—|—|${materialId}`);
                keys.forEach(k => {
                    if (!idx.has(k)) {
                        idx.set(k, { obj: o, material: m, slotIndex: i, materialId, geom, code3 });
                    }
                });
            });
        });
        return idx;
    }

    /**
     * Автопривязка для "обычных" моделей (НПМ): сопоставление текстур по имени файла.
     * Ожидает входные embeddedList (файлы из ZIP/FBX) и обновляет материалы в сцене.
     */
    function autoBindByNamesForModel(root, fileName, embeddedList) {
        if (!root || !Array.isArray(embeddedList) || !embeddedList.length) return;
        if (!textureLoader || !THREE) return;

        const history = [];
        const matIndex = indexModelMaterials(root);
        embeddedList.forEach(tex => {
            const p = parseTexName(tex.short);
            if (!p) {
                logBind(`⚠️ ${tex.short} — не распознан шаблон имени`, 'warn');
                return;
            }
            const { id, geomSuffix, code3, kind } = p;
            const slot = kindToSlot(kind);
            if (!slot) {
                logBind(`⚠️ ${tex.short} — нераспознан тип карты`, 'warn');
                return;
            }
            const keyWith = `${code3 || '—'}|${geomSuffix}|${id}`;
            const keyNoC3 = `—|${geomSuffix}|${id}`;
            let target = matIndex.get(keyWith) || matIndex.get(keyNoC3);

            if (!target && code3) {
                for (const entry of matIndex.values()) {
                    if (!entry) continue;
                    if (entry.geom === geomSuffix && entry.code3 === code3 && entry.materialId === id) {
                        target = entry;
                        break;
                    }
                }
            }

            if (!target && code3) {
                for (const entry of matIndex.values()) {
                    if (!entry) continue;
                    if (entry.geom === geomSuffix && entry.code3 === code3) {
                        target = entry;
                        break;
                    }
                }
            }

            if (!target) {
                logBind(`⚠️ ${tex.short} — нет материала по «${code3 || '—'} / ${geomSuffix} / id:${id}»`, 'warn');
                return;
            }

            const mats = Array.isArray(target.obj.material) ? target.obj.material : [target.obj.material];
            const previousMaterial = mats[target.slotIndex];
            let m = toStandard(previousMaterial);
            mats[target.slotIndex] = m;
            target.obj.material = Array.isArray(target.obj.material) ? mats : m;
            cacheOriginalMaterialFor(target.obj, true);

            const currentTexture = m[slot] || null;
            const humanName = basename(tex.full || tex.short);
            const existingName = currentTexture && (currentTexture.userData?.origName || currentTexture.name || '').toLowerCase();
            const newName = humanName.toLowerCase();
            const sameTexture = currentTexture && existingName && existingName === newName;

            if (currentTexture && !sameTexture) {
                logBind(`ℹ️ ${tex.short} — слот ${slot} будет перезаписан`, 'info');
            }

            if (currentTexture && sameTexture) {
                if (m !== previousMaterial) {
                    disposeUnusedMaterialTree(previousMaterial, { root });
                }
                logBind(`ℹ️ ${tex.short} — слот ${slot} уже содержит эту карту`, 'info');
                return;
            }

            const t = textureLoader.load(tex.url);
            t.name = humanName;
            (t.userData ||= {}).origName = humanName;
            t.colorSpace = (slot === 'map' || slot === 'emissiveMap') ? THREE.SRGBColorSpace : THREE.LinearSRGBColorSpace;
            t.userData.autoBound = true;

            copyTextureSettings(currentTexture, t);

            if (slot === 'roughnessMap') {
                m.roughnessMap = t;
                m.roughness = 0.6;
            } else if (slot === 'metalnessMap') {
                m.metalnessMap = t;
                m.metalness = 1.0;
            } else if (slot === 'alphaMap') {
                m.alphaMap = t;
                m.alphaTest = 0.5;
                m.transparent = false;
                m.depthWrite = true;
            } else {
                m[slot] = t;
            }

            let disposedCurrentTexture = false;
            if (currentTexture && !sameTexture && !objectTreeUsesTexture(root, currentTexture)) {
                currentTexture.dispose?.();
                disposedCurrentTexture = true;
            }
            if (m !== previousMaterial) {
                disposeUnusedMaterialTree(previousMaterial, {
                    root,
                    sharedTextures: disposedCurrentTexture ? [currentTexture] : [],
                });
            }

            const env = getEnvironment();
            if (env) {
                m.envMap = env;
                m.envMapIntensity = parseFloat(getEnvMapIntensity());
            }
            m.needsUpdate = true;
            history.push({ obj: target.obj, matIndex: target.slotIndex, slot, prev: currentTexture || null, url: tex.url, tex: t });
            logBind(`✅ ${tex.short} → ${m.name || 'материал'}.${slot}`, 'ok');
        });
        if (history.length && undoStack) undoStack.push({ fileName, bindings: history });
    }

    return { autoBindByNamesForModel };
}
