import { resolveEditableMaterialState } from './texture-utils.js';

const SOURCE_COLOR_KEY = 'viewerSourceBaseColor';
const NEUTRALIZED_KEY = 'viewerBaseColorNeutralized';
export const TEXTURED_BASE_COLOR_MULTIPLIER = 127 / 255;

const TEXTURED_BASE_COLOR = [
    TEXTURED_BASE_COLOR_MULTIPLIER,
    TEXTURED_BASE_COLOR_MULTIPLIER,
    TEXTURED_BASE_COLOR_MULTIPLIER,
];

function readStoredColor(material) {
    const value = material?.userData?.[SOURCE_COLOR_KEY];
    if (!Array.isArray(value) || value.length < 3) return null;
    const color = value.slice(0, 3).map(Number);
    return color.every(Number.isFinite) ? color : null;
}

function storeCurrentColor(material) {
    if (!material?.color?.isColor) return null;
    const value = [material.color.r, material.color.g, material.color.b];
    (material.userData ||= {})[SOURCE_COLOR_KEY] = value;
    return value;
}

function colorsEqual(color, values) {
    if (!color?.isColor || !values) return false;
    return color.r === values[0] && color.g === values[1] && color.b === values[2];
}

export function getMaterialSourceBaseColor(material) {
    if (!material?.color?.isColor) return null;
    const color = material.color.clone();
    const stored = material.userData?.[NEUTRALIZED_KEY] === true
        ? readStoredColor(material)
        : null;
    if (stored) color.setRGB(stored[0], stored[1], stored[2]);
    return color;
}

export function copyMaterialBaseColorPolicyState(source, target) {
    if (!source || !target) return target;
    const stored = readStoredColor(source);
    if (stored) {
        (target.userData ||= {})[SOURCE_COLOR_KEY] = stored.slice();
    }
    if (source.userData?.[NEUTRALIZED_KEY] === true) {
        (target.userData ||= {})[NEUTRALIZED_KEY] = true;
    }
    return target;
}

export function applyMaterialBaseColorPolicy(material, options = {}) {
    if (!material?.color?.isColor) return false;
    const preserveTint = options.preserveTint === true;
    const hasBaseColorMap = !!material.map?.isTexture;
    const userData = material.userData ||= {};
    const wasNeutralized = userData[NEUTRALIZED_KEY] === true;
    let changed = false;

    if (hasBaseColorMap && !preserveTint) {
        if (!wasNeutralized || !readStoredColor(material)) {
            storeCurrentColor(material);
        }
        if (!colorsEqual(material.color, TEXTURED_BASE_COLOR)) {
            material.color.setRGB(...TEXTURED_BASE_COLOR);
            changed = true;
        }
        userData[NEUTRALIZED_KEY] = true;
    } else if (wasNeutralized) {
        const stored = readStoredColor(material);
        if (stored && !colorsEqual(material.color, stored)) {
            material.color.setRGB(stored[0], stored[1], stored[2]);
            changed = true;
        }
        userData[NEUTRALIZED_KEY] = false;
    }

    if (changed) material.needsUpdate = true;
    return changed;
}

export function applyBaseColorPolicyToObjectTree(root, options = {}) {
    if (!root?.traverse) return 0;
    const shouldPreserveTint = typeof options.shouldPreserveTint === 'function'
        ? options.shouldPreserveTint
        : () => false;
    let changed = 0;

    root.traverse((obj) => {
        if (!obj?.isMesh || obj.userData?.isCollision || !obj.material) return;
        const materials = resolveEditableMaterialState(obj).materials;
        materials.forEach((material) => {
            if (!material) return;
            const preserveTint = shouldPreserveTint(obj, material) === true;
            if (applyMaterialBaseColorPolicy(material, { preserveTint })) changed += 1;
        });
    });
    return changed;
}
