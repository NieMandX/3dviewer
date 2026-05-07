export function copyTextureSettings(src, dst) {
    if (!src || !dst || src === dst) return;
    if (src.wrapS != null) dst.wrapS = src.wrapS;
    if (src.wrapT != null) dst.wrapT = src.wrapT;
    if ('wrapR' in src && 'wrapR' in dst && src.wrapR != null) dst.wrapR = src.wrapR;
    if (src.offset?.isVector2 && dst.offset?.copy) dst.offset.copy(src.offset);
    if (src.repeat?.isVector2 && dst.repeat?.copy) dst.repeat.copy(src.repeat);
    if (src.center?.isVector2 && dst.center?.copy) dst.center.copy(src.center);
    if (typeof src.rotation === 'number') dst.rotation = src.rotation;
    if (typeof src.matrixAutoUpdate === 'boolean') {
        dst.matrixAutoUpdate = src.matrixAutoUpdate;
        if (!dst.matrixAutoUpdate && src.matrix && dst.matrix?.copy) {
            dst.matrix.copy(src.matrix);
        }
    }
    if (typeof src.flipY === 'boolean') dst.flipY = src.flipY;
    if (typeof src.anisotropy === 'number') dst.anisotropy = src.anisotropy;
    if (typeof src.generateMipmaps === 'boolean') dst.generateMipmaps = src.generateMipmaps;
    if (dst.image && (dst.image.width || dst.image.height || dst.image.data)) {
        dst.needsUpdate = true;
    }
}

export function asMaterialArray(value) {
    if (!value) return [];
    return Array.isArray(value) ? value.filter(Boolean) : [value];
}

export function isGeneratedDisplayMaterial(obj, material) {
    return !!material && (
        material?.userData?.viewerGeneratedMaterial === 'shading-variant' ||
        material === obj?.userData?._bfFront ||
        material === obj?.userData?._bfBack ||
        material === obj?.userData?._wireBase ||
        material === obj?.userData?._beautyBase
    );
}

export function resolveEditableMaterialState(obj) {
    const currentMaterials = asMaterialArray(obj?.material);
    const originalMaterials = asMaterialArray(obj?.userData?._origMaterial);
    const currentIsGeneratedDisplay = currentMaterials.some((material) => isGeneratedDisplayMaterial(obj, material));
    if (originalMaterials.length > 0 && currentIsGeneratedDisplay) {
        return {
            source: 'original',
            materials: originalMaterials,
            originalValue: obj.userData._origMaterial,
            currentValue: obj.material,
        };
    }
    return {
        source: 'current',
        materials: currentMaterials,
        originalValue: obj?.userData?._origMaterial,
        currentValue: obj?.material,
    };
}

export function assignEditableMaterial(obj, state, index, material) {
    if (!obj || !state || !material) return;
    const previousMaterial = state.materials?.[index] || null;
    if (state.source === 'original') {
        obj.userData ||= {};
        if (Array.isArray(obj.userData._origMaterial)) {
            obj.userData._origMaterial[index] = material;
        } else {
            obj.userData._origMaterial = material;
        }
        if (obj.material === previousMaterial) {
            obj.material = material;
        } else if (
            Array.isArray(obj.material) &&
            obj.material[index] === previousMaterial &&
            !isGeneratedDisplayMaterial(obj, previousMaterial)
        ) {
            obj.material[index] = material;
        }
        return;
    }
    if (Array.isArray(obj.material)) {
        obj.material[index] = material;
    } else {
        obj.material = material;
    }
}

export function editableMaterialIsAssigned(obj, state, material) {
    if (!obj || !state || !material) return false;
    const value = state.source === 'original' ? obj.userData?._origMaterial : obj.material;
    return asMaterialArray(value).includes(material);
}

function toResourceSet(value) {
    if (value instanceof Set) return value;
    if (Array.isArray(value)) return new Set(value.filter(Boolean));
    return new Set();
}

export function collectMaterialTextures(material, options = {}) {
    const textures = new Set();
    const skipTextureKeys = new Set(options.skipTextureKeys || []);
    const sharedTextures = toResourceSet(options.sharedTextures);

    const addTexture = (texture) => {
        if (!texture?.isTexture || sharedTextures.has(texture)) return;
        textures.add(texture);
    };

    const scanValue = (value) => {
        if (!value) return;
        if (value.isTexture) {
            addTexture(value);
            return;
        }
        if (Array.isArray(value)) {
            value.forEach(scanValue);
            return;
        }
        if (value.value?.isTexture) {
            addTexture(value.value);
            return;
        }
        if (Array.isArray(value.value)) {
            value.value.forEach(scanValue);
        }
    };

    asMaterialArray(material).forEach((mat) => {
        Object.entries(mat).forEach(([key, value]) => {
            if (!skipTextureKeys.has(key)) scanValue(value);
        });
        const uniforms = mat.uniforms && typeof mat.uniforms === 'object' ? mat.uniforms : null;
        if (!uniforms) return;
        Object.entries(uniforms).forEach(([key, value]) => {
            if (!skipTextureKeys.has(key)) scanValue(value);
        });
    });

    return textures;
}

export function materialUsesTexture(material, texture) {
    if (!material || !texture?.isTexture) return false;
    return collectMaterialTextures(material).has(texture);
}

export function materialReferencesMaterial(materialValue, material) {
    if (!material || !materialValue) return false;
    return asMaterialArray(materialValue).includes(material);
}

export function objectTreeUsesMaterial(root, material) {
    if (!root?.traverse || !material) return false;
    let found = false;
    const materialKeys = [
        'material',
        'customDepthMaterial',
        'customDistanceMaterial',
    ];
    const userDataMaterialKeys = [
        '_origMaterial',
        '_removedMaterials',
        '_bfFront',
        '_bfBack',
        '_wireBase',
        '_beautyBase',
        '_removedCustomDepthMaterial',
        '_removedCustomDistanceMaterial',
    ];

    root.traverse((node) => {
        if (found || !node) return;
        for (const key of materialKeys) {
            if (materialReferencesMaterial(node[key], material)) {
                found = true;
                return;
            }
        }
        const userData = node.userData || {};
        for (const key of userDataMaterialKeys) {
            if (materialReferencesMaterial(userData[key], material)) {
                found = true;
                return;
            }
        }
    });

    return found;
}

export function objectTreeUsesTexture(root, texture) {
    if (!root?.traverse || !texture?.isTexture) return false;
    let found = false;
    const materialKeys = [
        'material',
        'customDepthMaterial',
        'customDistanceMaterial',
    ];
    const userDataMaterialKeys = [
        '_origMaterial',
        '_removedMaterials',
        '_bfFront',
        '_bfBack',
        '_wireBase',
        '_beautyBase',
        '_removedCustomDepthMaterial',
        '_removedCustomDistanceMaterial',
    ];

    root.traverse((node) => {
        if (found || !node) return;
        for (const key of materialKeys) {
            if (asMaterialArray(node[key]).some((material) => materialUsesTexture(material, texture))) {
                found = true;
                return;
            }
        }
        const userData = node.userData || {};
        for (const key of userDataMaterialKeys) {
            if (asMaterialArray(userData[key]).some((material) => materialUsesTexture(material, texture))) {
                found = true;
                return;
            }
        }
    });

    return found;
}

export function loadedModelsUseTexture(loadedModels, texture) {
    if (!Array.isArray(loadedModels) || !texture?.isTexture) return false;
    return loadedModels.some((record) => objectTreeUsesTexture(record?.obj, texture));
}

export function loadedModelsUseMaterial(loadedModels, material) {
    if (!Array.isArray(loadedModels) || !material) return false;
    return loadedModels.some((record) => objectTreeUsesMaterial(record?.obj, material));
}

function normalizeRoots({ root = null, world = null, loadedModels = null } = {}) {
    const roots = [];
    if (root) roots.push(root);
    if (world && world !== root) roots.push(world);
    if (Array.isArray(loadedModels)) {
        loadedModels.forEach((record) => {
            const obj = record?.obj || null;
            if (obj && !roots.includes(obj)) roots.push(obj);
        });
    }
    return roots;
}

function rootsUseMaterial(roots, material) {
    return roots.some((root) => objectTreeUsesMaterial(root, material));
}

function rootsUseTexture(roots, texture) {
    return roots.some((root) => objectTreeUsesTexture(root, texture));
}

export function disposeUnusedMaterialTree(material, options = {}) {
    const roots = normalizeRoots(options);
    const sharedTextures = new Set(Array.isArray(options.sharedTextures) ? options.sharedTextures.filter(Boolean) : []);
    const skipTextureKeys = new Set(options.skipTextureKeys || ['envMap', 'matcap']);
    const disposedMaterials = new Set();
    const candidateTextures = new Set();

    asMaterialArray(material).forEach((mat) => {
        if (!mat || disposedMaterials.has(mat)) return;
        if (rootsUseMaterial(roots, mat)) return;
        disposedMaterials.add(mat);
        collectMaterialTextures(mat, { skipTextureKeys, sharedTextures }).forEach((texture) => {
            candidateTextures.add(texture);
        });
        mat.dispose?.();
    });

    const disposedTextures = new Set();
    candidateTextures.forEach((texture) => {
        if (!texture?.isTexture || sharedTextures.has(texture) || disposedTextures.has(texture)) return;
        if (rootsUseTexture(roots, texture)) return;
        disposedTextures.add(texture);
        texture.dispose?.();
    });

    return {
        materials: disposedMaterials.size,
        textures: disposedTextures.size,
    };
}
