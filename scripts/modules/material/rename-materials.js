import {
    assignEditableMaterial,
    disposeUnusedMaterialTree,
    resolveEditableMaterialState,
} from './texture-utils.js';

export function createMaterialRenamer(options = {}) {
    const logBind = typeof options.logBind === 'function' ? options.logBind : null;
    const cacheOriginalMaterialFor =
        typeof options.cacheOriginalMaterialFor === 'function' ? options.cacheOriginalMaterialFor : null;

    const RX_DEFAULT = /^_*default(?:_?material)?\s*$/i; // __DEFAULT / Default / DefaultMaterial / "" и т.п.
    const RX_UCX = /^ucx\b/i;

    const nearestUCX = (obj) => {
        for (let current = obj; current; current = current.parent) {
            if (RX_UCX.test(current.name || '')) return current.name;
            if (current.geometry?.name && RX_UCX.test(current.geometry.name)) return current.geometry.name;
        }
        return null;
    };

    return function renameMaterialsByFBXObject(root) {
        if (!root?.traverse) return;

        let renamed = 0;
        root.traverse(mesh => {
            if (!mesh?.isMesh || !mesh.material) return;

            const ucx = nearestUCX(mesh);
            const materialState = resolveEditableMaterialState(mesh);
            const mats = materialState.materials;
            let changed = false;

            for (let i = 0; i < mats.length; i++) {
                const mat = mats[i];
                if (!mat) continue;

                const name = mat.name || '';
                const isDefault = RX_DEFAULT.test(name) || !name.trim();
                const mustRename = isDefault || !!ucx; // все UCX получат имя по объекту
                if (!mustRename) continue;

                const base = (ucx || mesh.name || mesh.parent?.name || 'MATERIAL').trim();
                const cloned = mat.clone(); // свой инстанс для этого меша
                cloned.name = mats.length > 1 ? `${base}_${i + 1}` : base;

                assignEditableMaterial(mesh, materialState, i, cloned);
                disposeUnusedMaterialTree(mat, { root });

                renamed++;
                changed = true;
            }

            if (changed) cacheOriginalMaterialFor?.(mesh, true);
        });

        if (logBind) {
            logBind(`UCX rename: переименовано материалов — ${renamed}`, renamed ? 'ok' : 'warn');
        }
    };
}
