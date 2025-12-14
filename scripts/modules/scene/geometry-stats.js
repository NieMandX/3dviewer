function isObjectGloballyVisible(obj) {
    let current = obj;
    while (current) {
        if (current.visible === false) return false;
        current = current.parent;
    }
    return true;
}

function estimateTrianglesForMesh(mesh) {
    const geometry = mesh.geometry;
    if (!geometry) return 0;

    const instanceMultiplier = mesh.isInstancedMesh ? Math.max(0, mesh.count || 0) : 1;

    if (Array.isArray(mesh.material) && geometry.groups?.length) {
        let grouped = 0;
        geometry.groups.forEach((group) => {
            if (!group || typeof group.count !== 'number' || group.count <= 0) return;
            const mat = mesh.material[group.materialIndex];
            if (!mat || mat.visible === false) return;
            grouped += group.count / 3;
        });
        if (grouped > 0 && Number.isFinite(grouped)) {
            return Math.max(0, Math.floor(grouped)) * instanceMultiplier;
        }
    }

    if (geometry.index && geometry.index.count) {
        return Math.max(0, Math.floor(geometry.index.count / 3)) * instanceMultiplier;
    }
    const position = geometry.attributes?.position;
    if (position && position.count) {
        return Math.max(0, Math.floor(position.count / 3)) * instanceMultiplier;
    }
    return 0;
}

export function createSceneGeometryStats(options = {}) {
    const getWorld = typeof options.getWorld === 'function' ? options.getWorld : () => options.world || null;
    const isExcluded =
        typeof options.isExcluded === 'function' ? options.isExcluded : (obj) => !!obj?.userData?._isBackfaceOverlay;

    let dirty = true;
    let cached = { triangles: 0 };

    function markDirty() {
        dirty = true;
    }

    function getStats() {
        if (!dirty && cached) return cached;

        const stats = { triangles: 0 };
        const world = getWorld();
        if (!world?.traverse) {
            cached = stats;
            dirty = false;
            return stats;
        }

        world.traverse((obj) => {
            if (!obj?.isMesh) return;
            if (isExcluded(obj)) return;
            if (!isObjectGloballyVisible(obj)) return;
            if (obj.material && Array.isArray(obj.material) && obj.material.every((mat) => mat && mat.visible === false)) return;
            if (obj.material && !Array.isArray(obj.material) && obj.material.visible === false) return;

            const triCount = estimateTrianglesForMesh(obj);
            if (triCount > 0) stats.triangles += triCount;
        });

        cached = stats;
        dirty = false;
        return stats;
    }

    return Object.freeze({
        markDirty,
        getStats,
    });
}

