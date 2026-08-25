import * as THREE from 'three';
import { copyMaterialBaseColorPolicyState } from './base-color-policy.js';

export function createToStandard(options = {}) {
    const getEnvironment =
        typeof options.getEnvironment === 'function'
            ? options.getEnvironment
            : () => (options.environment != null ? options.environment : null);

    const getEnvMapIntensity =
        typeof options.getEnvMapIntensity === 'function'
            ? options.getEnvMapIntensity
            : () => (options.envMapIntensity != null ? options.envMapIntensity : 1);

    return function toStandard(m) {
        if (!m) return m;
        if (m.isMeshStandardMaterial || m.isMeshPhysicalMaterial) return m;
        const std = new THREE.MeshPhysicalMaterial({
            side: THREE.DoubleSide,
            color: m.color?.clone?.() ?? new THREE.Color(0xffffff),
            map: m.map ?? null,
            normalMap: m.normalMap ?? null,
            aoMap: m.aoMap ?? null,
            emissive: m.emissive?.clone?.() ?? new THREE.Color(0x000000),
            emissiveMap: m.emissiveMap ?? null,
            emissiveIntensity: m.emissiveIntensity ?? 1.0,
            transparent: !!m.transparent,
            opacity: m.opacity ?? 1.0,
            metalness: 0.0,
            roughness: Math.max(0.04, 1 - (m.shininess ?? 30) / 100),
        });

        if (std.isMeshPhysicalMaterial) {
            if (m.isMeshPhysicalMaterial) {
                std.sheen = m.sheen ?? 0;
                std.sheenColor = m.sheenColor?.clone?.() ?? new THREE.Color(0xffffff);
                std.sheenRoughness = m.sheenRoughness ?? 1;
                std.clearcoat = m.clearcoat ?? 0;
                std.clearcoatRoughness = m.clearcoatRoughness ?? 0;
                std.transmission = m.transmission ?? 0;
                std.ior = m.ior ?? 1.0;
                std.thickness = m.thickness ?? 0;
                std.attenuationColor = m.attenuationColor?.clone?.() ?? new THREE.Color(0xffffff);
                std.attenuationDistance = m.attenuationDistance ?? Infinity;
                std.anisotropy = m.anisotropy ?? 0;
                std.anisotropyRotation = m.anisotropyRotation ?? 0;
                std.iridescence = m.iridescence ?? 0;
                std.iridescenceIOR = m.iridescenceIOR ?? 1.3;
                std.iridescenceThicknessRange = m.iridescenceThicknessRange?.slice?.() ?? [100, 400];
            } else {
                std.clearcoat = 0;
                std.clearcoatRoughness = 1.0;
                std.transmission = 0;
                std.ior = 1.0;
                std.thickness = 0.1;
                std.attenuationColor = new THREE.Color(0xffffff);
                std.attenuationDistance = Infinity;
                std.sheen = 0;
                std.iridescence = 0;
                std.anisotropy = 0;
            }
        }

        std.name = m.name || std.name;
        copyMaterialBaseColorPolicyState(m, std);

        if (std.map) std.map.colorSpace = THREE.SRGBColorSpace;
        if (std.emissiveMap) std.emissiveMap.colorSpace = THREE.SRGBColorSpace;
        if (std.normalMap) std.normalMap.colorSpace = THREE.LinearSRGBColorSpace;
        if (std.aoMap) std.aoMap.colorSpace = THREE.LinearSRGBColorSpace;

        if (m.alphaMap) {
            std.alphaMap = m.alphaMap;
            std.alphaMap.colorSpace = THREE.LinearSRGBColorSpace;
            std.alphaTest = 0.5;
            std.transparent = false;
            std.depthWrite = true;
        }

        const env = getEnvironment();
        if (env) {
            std.envMap = env;
            std.envMapIntensity = Number(getEnvMapIntensity());
        }
        return std;
    };
}
