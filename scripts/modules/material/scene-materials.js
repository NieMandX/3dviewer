import { asMaterialArray, resolveEditableMaterialState } from './texture-utils.js';

// Non-enumerable references: owned by the importer resource registry, never GLB extras.
export function keepMaterials(object, key, value) {
    Object.defineProperty(object.userData, key, { value, writable: true, configurable: true });
}

export function captureParsedMaterials(root) {
    const copies = new Map();
    let nextId = 0;
    root.traverse((object) => { for (const material of asMaterialArray(object.userData?._editorOriginalMaterials)) {
        if (Number.isInteger(material.userData.viewerMaterialId)) nextId = Math.max(nextId, material.userData.viewerMaterialId + 1);
    } });
    root.traverse((object) => {
        if (!object.isMesh || object.userData._editorOriginalMaterials) return;
        const clone = (material) => {
            if (!material) return material;
            if (!copies.has(material)) {
                material.userData.viewerMaterialId ??= nextId++;
                copies.set(material, material.clone());
            }
            return copies.get(material);
        };
        keepMaterials(object, '_editorOriginalMaterials', Array.isArray(object.material)
            ? object.material.map(clone) : clone(object.material));
    });
}

export function collectSceneMaterials(loadedModels) {
    const entries = new Map();
    for (const record of loadedModels) {
        record.obj?.traverse((object) => {
            if (!object.isMesh || object.userData?.isCollision || object.userData?.excludeFromExport) return;
            const state = resolveEditableMaterialState(object);
            const materials = asMaterialArray(object.userData._editorEditedMaterials || state.materials);
            materials.forEach((material, index) => {
                if (!material || material.userData?.viewerGeneratedMaterial) return;
                const parsed = asMaterialArray(object.userData._editorOriginalMaterials)[index];
                material.userData.viewerMaterialId ??= parsed?.userData?.viewerMaterialId;
                if (!entries.has(material.uuid)) entries.set(material.uuid, { material, uses: [] });
                entries.get(material.uuid).uses.push({ object, index, root: record.obj });
            });
        });
    }
    return entries;
}
