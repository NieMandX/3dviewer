// The cloud boundary is an allowlist. Never carry images, asset URLs, shader
// source, pack references or unknown extras forward from legacy room documents.
const numbers = ['roughness', 'metalness', 'opacity', 'transmission', 'ior', 'specularIntensity', 'envMapIntensity', 'thickness', 'clearcoat', 'clearcoatRoughness', 'attenuationDistance', 'alphaTest', 'emissiveIntensity', 'bumpScale', 'displacementScale', 'displacementBias', 'aoMapIntensity', 'lightMapIntensity', 'sheen', 'sheenRoughness', 'iridescence', 'iridescenceIOR', 'anisotropy', 'anisotropyRotation', 'side', 'normalMapType', 'blending', 'depthFunc'];
const bools = ['transparent', 'depthWrite', 'depthTest', 'colorWrite', 'flatShading', 'vertexColors', 'premultipliedAlpha', 'dithering', 'toneMapped', 'alphaToCoverage', 'forceSinglePass', 'visible'];
const vectors = { color: 3, emissive: 3, attenuationColor: 3, specularColor: 3, sheenColor: 3, normalScale: 2, clearcoatNormalScale: 2, iridescenceThicknessRange: 2 };
const vector = (v, n) => Array.isArray(v) && v.length === n && v.every((x) => Number.isFinite(x) && Math.abs(x) <= 1e12);
export function waterParameters(w) {
    if (!w || ![1, 2].includes(w.version)) return null;
    const result = { version: w.version };
    for (const key of ['tileMeters', 'cycleSeconds', 'metersPerSecond', 'speed']) if (Number.isFinite(w[key])) result[key] = w[key];
    for (const [key, n] of [['origin', 2], ['extent', 2], ['specularColor', 3]]) if (vector(w[key], n)) result[key] = [...w[key]];
    if (typeof w.playing === 'boolean') result.playing = w.playing;
    if (w.network && Array.isArray(w.network.nodes) && Array.isArray(w.network.edges) && w.network.nodes.length <= 2048 && w.network.edges.length <= 4096) {
        result.network = {
            nodes: w.network.nodes.filter((n) => typeof n.id === 'string' && n.id.length <= 128 && vector(n.position, 3)).map((n) => ({ id: n.id, position: [...n.position] })),
            edges: w.network.edges.filter((e) => Array.isArray(e) && e.length === 2 && e.every((id) => typeof id === 'string' && id.length <= 128)).map((e) => [...e]),
        };
    }
    return result;
}
export function settingsFromDescriptor(d) {
    const properties = {}, p = d?.properties || {};
    for (const key of numbers) if (Number.isFinite(p[key]) && Math.abs(p[key]) <= 1e6) properties[key] = p[key];
    if (p.attenuationDistance === null) properties.attenuationDistance = null;
    for (const key of bools) if (typeof p[key] === 'boolean') properties[key] = p[key];
    for (const [key, n] of Object.entries(vectors)) if (vector(p[key], n)) properties[key] = [...p[key]];
    return { type: d?.type === 'basic' ? 'basic' : 'physical', properties,
        preset: ['glass', 'water', 'grass', 'stone', 'brick'].includes(d?.preset) ? d.preset : null,
        depthPriority: Math.max(-8, Math.min(8, Number(d?.depthPriority) || 0)), water: waterParameters(d?.water) };
}
export function settingsOnlyDocument(document) {
    if (document?.format !== 'lpmview-materials' || document.version !== 1 || !Array.isArray(document.materials) || document.materials.length > 4096) throw Error('Неподдерживаемый документ настроек материалов.');
    return { format: 'lpmview-materials', version: 1, settingsOnly: true, materials: document.materials.map((row) => {
        if (typeof row.model !== 'string' || !['string', 'number'].includes(typeof row.material)) throw Error('Неверная привязка материала.');
        const legacy = { type: 'physical', preset: row.preset, depthPriority: row.depthPriority, water: row.water,
            properties: { ...row.values, color: row.color, emissive: row.emissive, attenuationColor: row.attenuationColor, specularColor: row.specularColor, normalScale: row.normalScale, side: row.side, transparent: row.transparent } };
        return { model: row.model, material: row.material, name: String(row.name || '').slice(0, 1024), settings: settingsFromDescriptor(row.settings || row.portable || legacy) };
    }) };
}
