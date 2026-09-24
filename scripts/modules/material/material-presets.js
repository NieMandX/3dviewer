import * as THREE from 'three';

export const MATERIAL_PRESETS = [
    { id: 'water', name: 'Вода', color: '#465057' },
    { id: 'glass', name: 'Стекло', color: '#d8ede5' },
    { id: 'grass', name: 'Трава', color: '#627846' },
    { id: 'stone', name: 'Камень', color: '#9a9389' },
    { id: 'brick', name: 'Кирпич', color: '#a65f45' },
];

export function makeSurfaceMaps(kind, size = 256) {
    const heights = new Float32Array(size * size), color = new Uint8Array(size * size * 4), normal = new Uint8Array(size * size * 4);
    let seed = 71;
    const random = () => { seed = Math.imul(seed, 1664525) + 1013904223 | 0; return (seed >>> 0) / 4294967296; };
    const base = kind === 'grass' ? [101, 122, 72] : kind === 'brick' ? [166, 95, 69] : [153, 147, 138];
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const noise = random(), row = Math.floor(y / (size / 8));
        const joint = kind === 'brick' && (y % (size / 8) < 3 || (x + (row % 2) * size / 8) % (size / 4) < 3);
        const height = kind === 'water' ? 0.5 + Math.sin(x / size * Math.PI * 16 + Math.sin(y / size * Math.PI * 8)) * 0.04 + Math.cos(y / size * Math.PI * 12 + Math.sin(x / size * Math.PI * 4)) * 0.04
            : joint ? 0.05 : 0.5 + noise * (kind === 'grass' ? 0.45 : 0.12);
        const i = y * size + x; heights[i] = height;
        for (let c = 0; c < 3; c++) color[i * 4 + c] = joint ? 126 : base[c] * (0.85 + noise * 0.3);
        color[i * 4 + 3] = 255;
    }
    const h = (x, y) => heights[((y + size) % size) * size + (x + size) % size];
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const n = new THREE.Vector3((h(x - 1, y) - h(x + 1, y)) * 2, (h(x, y - 1) - h(x, y + 1)) * 2, 1).normalize(), i = (y * size + x) * 4;
        normal[i] = (n.x + 1) * 127.5; normal[i + 1] = (n.y + 1) * 127.5; normal[i + 2] = (n.z + 1) * 127.5; normal[i + 3] = 255;
    }
    const texture = (data, srgb) => { const t = new THREE.DataTexture(data, size, size); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true; t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; t.needsUpdate = true; return t; };
    return { map: kind === 'water' ? null : texture(color, true), normalMap: texture(normal, false) };
}

export function createPresetMaterial(id, source) {
    const material = new THREE.MeshPhysicalMaterial({ name: source?.name || MATERIAL_PRESETS.find((p) => p.id === id)?.name, side: source?.side ?? THREE.FrontSide });
    material.userData.viewerPreset = id;
    if (id === 'glass') {
        material.color.setRGB(0.8751376, 0.9322768, 0.8993845);
        Object.assign(material, { roughness: 0.03, metalness: 0, transmission: 1, ior: 3, specularIntensity: 0.6, thickness: 0.1 });
    } else if (id === 'water') {
        material.color.setRGB(0.068, 0.078, 0.087);
        Object.assign(material, { roughness: 0.055, transmission: 0.32, ior: 1.333, thickness: 0.6, attenuationDistance: 2 });
        material.attenuationColor.setRGB(0.36, 0.40, 0.43); material.specularColor.setRGB(2, 2, 2);
        material.normalMap = makeSurfaceMaps('water').normalMap; material.normalScale.setScalar(8);
    } else {
        Object.assign(material, makeSurfaceMaps(id)); material.roughness = id === 'grass' ? 0.95 : 0.82;
        material.normalScale.setScalar(id === 'grass' ? 3 : 2);
    }
    material.envMap = source?.envMap || null; material.envMapIntensity = source?.envMapIntensity ?? 1;
    return material;
}
