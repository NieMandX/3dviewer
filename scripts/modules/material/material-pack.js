import * as THREE from 'three';
import { getDepthPriority, setDepthPriority } from './depth-priority.js';
import { createRiverMaterial, readRiverFlowSettings } from './river-flow.js';

export const PACK_FORMAT = 'lpmview-material-pack';
export const PACK_MAPS = ['map', 'normalMap', 'bumpMap', 'displacementMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'alphaMap', 'lightMap', 'clearcoatMap', 'clearcoatRoughnessMap', 'clearcoatNormalMap', 'transmissionMap', 'thicknessMap', 'specularIntensityMap', 'specularColorMap', 'sheenColorMap', 'sheenRoughnessMap', 'iridescenceMap', 'iridescenceThicknessMap', 'anisotropyMap'];
const NUMBERS = ['roughness', 'metalness', 'opacity', 'transmission', 'ior', 'specularIntensity', 'envMapIntensity', 'thickness', 'clearcoat', 'clearcoatRoughness', 'attenuationDistance', 'alphaTest', 'emissiveIntensity', 'bumpScale', 'displacementScale', 'displacementBias', 'aoMapIntensity', 'lightMapIntensity', 'reflectivity', 'sheen', 'sheenRoughness', 'iridescence', 'iridescenceIOR', 'anisotropy', 'anisotropyRotation'];
const COLORS = ['color', 'emissive', 'attenuationColor', 'specularColor', 'sheenColor'];
const VECTORS = ['normalScale', 'clearcoatNormalScale'];
const BOOLS = ['transparent', 'depthWrite', 'depthTest', 'colorWrite', 'flatShading', 'vertexColors', 'premultipliedAlpha', 'dithering', 'toneMapped', 'alphaToCoverage', 'forceSinglePass', 'visible'];
const enums = { side: [0, 1, 2], normalMapType: [0, 1], blending: [0, 1, 2, 3, 4], depthFunc: [0, 1, 2, 3, 4, 5, 6, 7] };
export const PACK_ASSET = /^textures\/[0-9a-f]{64}\.png$/;
const dataImage = /^data:image\/(png|jpeg|webp);base64,/;
const finiteArray = (v, n) => Array.isArray(v) && v.length === n && v.every((x) => Number.isFinite(x) && Math.abs(x) <= 1e12);
export const packAbort = () => new DOMException('Операция отменена: модель или комната изменилась.', 'AbortError');

export function textureDescriptor(t, image) {
    return { ...image, repeat: t.repeat.toArray(), offset: t.offset.toArray(), center: t.center.toArray(), rotation: t.rotation,
        matrix: t.matrix.toArray(), matrixAutoUpdate: t.matrixAutoUpdate, flipY: t.flipY, channel: t.channel,
        wrapS: t.wrapS, wrapT: t.wrapT, minFilter: t.minFilter, magFilter: t.magFilter, anisotropy: t.anisotropy,
        generateMipmaps: t.generateMipmaps, colorSpace: t.colorSpace, premultiplyAlpha: t.premultiplyAlpha };
}

export function describeMaterial(material, mapImage) {
    const properties = {};
    // Physical reflectivity is an alias whose setter clamps IOR. Preserve IOR
    // directly (including the approved IOR=3 glass) instead of writing both.
    for (const key of NUMBERS) if (typeof material[key] === 'number' && (key !== 'reflectivity' || material.isMeshBasicMaterial)) properties[key] = Number.isFinite(material[key]) ? material[key] : null;
    for (const key of COLORS) if (material[key]?.isColor) properties[key] = material[key].toArray();
    for (const key of VECTORS) if (material[key]?.isVector2) properties[key] = material[key].toArray();
    for (const key of BOOLS) if (typeof material[key] === 'boolean') properties[key] = material[key];
    for (const key of Object.keys(enums)) if (material[key] != null) properties[key] = material[key];
    if (material.iridescenceThicknessRange) properties.iridescenceThicknessRange = [...material.iridescenceThicknessRange];
    const water = material.userData?.lpmview_water ? structuredClone(material.userData.lpmview_water) : null;
    if (water) { water.speed = material.riverFlow?.speed ?? water.speed; water.playing = material.riverFlow?.playing !== false; water.specularColor = material.specularColor.toArray(); }
    return { name: material.name || '', type: material.isMeshBasicMaterial ? 'basic' : 'physical', properties,
        preset: material.userData?.viewerPreset || null, depthPriority: getDepthPriority(material), water,
        maps: Object.fromEntries(PACK_MAPS.map((key) => [key, material[key] ? textureDescriptor(material[key], mapImage(material[key], key)) : null])) };
}

async function pngBlob(texture) {
    const image = texture.image;
    const width = image?.width || image?.videoWidth, height = image?.height || image?.videoHeight;
    if (!width || !height || width > 8192 || height > 8192 || texture.isCompressedTexture) throw Error('Не удалось сохранить текстуру: требуется обычная карта размером до 8192 px.');
    // HTMLCanvas.toBlob may wait for idle time indefinitely while a large water
    // scene keeps rendering. Offscreen encoding does not depend on that queue.
    const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(width, height) : document.createElement('canvas'); canvas.width = width; canvas.height = height;
    try {
        const ctx = canvas.getContext('2d');
        if (image.data) {
            if (!(image.data instanceof Uint8Array || image.data instanceof Uint8ClampedArray) || image.data.length !== width * height * 4) throw Error('Неподдерживаемый формат текстуры материала.');
            ctx.putImageData(new ImageData(new Uint8ClampedArray(image.data), width, height), 0, 0);
        } else ctx.drawImage(image, 0, 0);
        const blob = canvas.convertToBlob ? await canvas.convertToBlob({ type: 'image/png' }) : await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
        if (!blob || blob.size > 32 * 1024 * 1024) throw Error('Текстура превышает 32 МБ.');
        return blob;
    } finally { canvas.width = canvas.height = 1; }
}

// Images are streamed to Storage separately, without a huge base64 JSON copy.
export async function captureMaterialPack(entries, { writeAsset, isCurrent = () => true, onProgress = () => {} }) {
    const sources = new Map(), assets = new Set(), materials = []; let bytes = 0;
    async function store(blob) {
        if (!isCurrent()) throw packAbort();
        const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].map((v) => v.toString(16).padStart(2, '0')).join('');
        const name = `textures/${hash}.png`;
        if (!assets.has(name)) {
            bytes += blob.size; if (bytes > 512 * 1024 * 1024) throw Error('Набор текстур превышает 512 МБ.');
            await writeAsset(name, blob); assets.add(name);
        }
        if (!isCurrent()) throw packAbort();
        return name;
    }
    if (!entries.length || entries.length > 4096) throw Error('Выберите модель с материалами (не более 4096).');
    for (const entry of entries) {
        const m = entry.material, images = new Map();
        if (!(m.isMeshStandardMaterial || m.isMeshBasicMaterial || m.isMeshPhysicalNodeMaterial)) throw Error(`Материал «${m.name}» использует неподдерживаемый пользовательский шейдер.`);
        for (const key of PACK_MAPS) if (m[key]) {
            const t = m[key], source = t.image;
            if (!sources.has(source)) sources.set(source, await store(await pngBlob(t)));
            images.set(t, { asset: sources.get(source) });
        }
        const descriptor = describeMaterial(m, (t) => images.get(t));
        if (descriptor.water?.flowMap) {
            if (!readRiverFlowSettings(descriptor.water)) throw Error('Некорректные настройки течения.');
            descriptor.water.flowAsset = await store(await (await fetch(descriptor.water.flowMap)).blob());
            delete descriptor.water.flowMap;
        }
        materials.push(descriptor); onProgress(materials.length, entries.length);
    }
    return { format: PACK_FORMAT, version: 1, materials, textureCount: assets.size, textureBytes: bytes };
}

export function validateMaterialPack(pack) {
    if (pack?.format !== PACK_FORMAT || pack.version !== 1 || !Array.isArray(pack.materials) || !pack.materials.length || pack.materials.length > 4096) throw Error('Неподдерживаемый набор материалов.');
    for (const m of pack.materials) {
        if (!m || typeof m.name !== 'string' || m.name.length > 1024 || !['basic', 'physical'].includes(m.type)) throw Error('Повреждено описание материала.');
        for (const value of Object.values(m.maps || {})) if (value && !PACK_ASSET.test(value.asset || '')) throw Error('Недопустимый путь текстуры набора.');
        if (m.water && !PACK_ASSET.test(m.water.flowAsset || '')) throw Error('Недопустимая карта течения.');
    }
    return pack;
}

const nameKey = (name) => String(name || '').normalize('NFKC').trim().toLocaleLowerCase();
export function matchMaterialPack(pack, entries) {
    const bySource = new Map(), byTarget = new Map();
    pack.materials.forEach((m, index) => { const key = nameKey(m.name); if (!bySource.has(key)) bySource.set(key, []); bySource.get(key).push(index); });
    for (const entry of entries) { const key = nameKey(entry.material.name); if (!byTarget.has(key)) byTarget.set(key, []); byTarget.get(key).push(entry); }
    const matches = [], missing = [], ambiguous = [];
    for (const [key, targets] of byTarget) {
        const sources = bySource.get(key) || [];
        if (!sources.length) missing.push(...targets.map((e) => e.material.name));
        else if (!key || sources.length !== 1 || targets.length !== 1) ambiguous.push(...targets.map((e) => e.material.name || 'Без имени'));
        else matches.push({ entry: targets[0], index: sources[0] });
    }
    return { matches, missing, ambiguous };
}

export function blobDataURL(blob) {
    return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob); });
}

// Prepare all GPU resources before committing any assignment. Failed/stale loads
// dispose only resources owned by this operation, never textures in the scene.
export async function preparePackMaterials(descriptors, { loadAsset, isCurrent = () => true, useWebGPU = false }) {
    const textures = new Set(), materials = new Set(), textureCache = new Map(), results = [];
    const check = () => { if (!isCurrent()) throw packAbort(); };
    const dispose = () => { materials.forEach((m) => m.dispose()); textures.forEach((t) => t.dispose()); };
    async function texture(value) {
        const cacheKey = JSON.stringify(value);
        if (textureCache.has(cacheKey)) return textureCache.get(cacheKey);
        let url, owned = false;
        if (value.asset) { if (!PACK_ASSET.test(value.asset)) throw Error('Недопустимый путь текстуры.'); url = URL.createObjectURL(await loadAsset(value.asset)); owned = true; }
        else if (dataImage.test(value.data || '') && value.data.length <= 8 * 1024 * 1024) url = value.data;
        else throw Error('Недопустимая текстура материала.');
        let t;
        try { check(); t = await new THREE.TextureLoader().loadAsync(url); textures.add(t); check(); }
        finally { if (owned) URL.revokeObjectURL(url); }
        if (t.image.width > 8192 || t.image.height > 8192) throw Error('Слишком большая текстура.');
        for (const key of ['repeat', 'offset', 'center']) if (finiteArray(value[key], 2)) t[key].fromArray(value[key]);
        if (Number.isFinite(value.rotation)) t.rotation = value.rotation;
        if (finiteArray(value.matrix, 9) && value.matrixAutoUpdate === false) { t.matrixAutoUpdate = false; t.matrix.fromArray(value.matrix); }
        for (const key of ['flipY', 'generateMipmaps', 'premultiplyAlpha']) if (typeof value[key] === 'boolean') t[key] = value[key];
        t.channel = [0, 1, 2, 3].includes(value.channel) ? value.channel : 0;
        for (const key of ['wrapS', 'wrapT']) if ([1000, 1001, 1002].includes(value[key])) t[key] = value[key];
        if ([1003, 1006].includes(value.magFilter)) t.magFilter = value.magFilter;
        if ([1003, 1004, 1005, 1006, 1007, 1008].includes(value.minFilter)) t.minFilter = value.minFilter;
        t.anisotropy = Math.min(16, Math.max(1, Number(value.anisotropy) || 1));
        t.colorSpace = [THREE.SRGBColorSpace, THREE.LinearSRGBColorSpace, THREE.NoColorSpace].includes(value.colorSpace) ? value.colorSpace : THREE.NoColorSpace;
        t.needsUpdate = true; textureCache.set(cacheKey, t); return t;
    }
    try {
        for (const saved of descriptors) {
            check(); let m = saved.type === 'basic' ? new THREE.MeshBasicMaterial() : new THREE.MeshPhysicalMaterial(); materials.add(m); m.name = saved.name;
            const props = saved.properties || {};
            for (const key of NUMBERS) if (key in m && (key !== 'reflectivity' || m.isMeshBasicMaterial) && Number.isFinite(props[key]) && Math.abs(props[key]) <= 1e6) m[key] = props[key];
            if (props.attenuationDistance === null && 'attenuationDistance' in m) m.attenuationDistance = Infinity;
            for (const key of COLORS) if (m[key]?.isColor && finiteArray(props[key], 3)) m[key].fromArray(props[key]);
            for (const key of VECTORS) if (m[key]?.isVector2 && finiteArray(props[key], 2)) m[key].fromArray(props[key]);
            for (const key of BOOLS) if (typeof props[key] === 'boolean') m[key] = props[key];
            for (const [key, values] of Object.entries(enums)) if (values.includes(props[key])) m[key] = props[key];
            if (finiteArray(props.iridescenceThicknessRange, 2)) m.iridescenceThicknessRange = [...props.iridescenceThicknessRange];
            setDepthPriority(m, Math.max(-8, Math.min(8, Number(saved.depthPriority) || 0)));
            if (saved.preset) m.userData.viewerPreset = String(saved.preset);
            for (const key of PACK_MAPS) if (saved.maps?.[key] && key in m) m[key] = await texture(saved.maps[key]);
            let runtime = null;
            if (saved.water) {
                const meta = structuredClone(saved.water);
                if (meta.flowAsset) { meta.flowMap = await blobDataURL(await loadAsset(meta.flowAsset)); delete meta.flowAsset; }
                if (!readRiverFlowSettings(meta) || !m.normalMap) throw Error('Невозможно восстановить течение воды.');
                const field = await texture({ data: meta.flowMap, flipY: false, generateMipmaps: false, minFilter: 1006, magFilter: 1006 });
                check(); runtime = await createRiverMaterial(m, field, meta, useWebGPU); materials.add(runtime.material); m.dispose(); materials.delete(m); m = runtime.material;
                m.userData.lpmview_water = meta;
            }
            check(); results.push({ material: m, runtime });
        }
        return { results, dispose };
    } catch (error) { dispose(); throw error; }
}
