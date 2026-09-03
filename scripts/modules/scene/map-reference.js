import { loadMapCoordinateSystem } from '../geo/map-coordinates.js';

export function createMapReferenceController({ THREE, world, getModels, isZUp,
    loadCoordinateSystem = loadMapCoordinateSystem }) {
    let disposed = false;

    function requireActive() {
        if (disposed) throw new Error('Map reference is disposed');
    }

    function getModelBounds() {
        requireActive();
        world.updateWorldMatrix(true, true);
        const inverseWorld = world.matrixWorld.clone().invert();
        const bounds = new THREE.Box3();
        const relative = new THREE.Matrix4();
        const transformed = new THREE.Box3();
        for (const record of getModels()) {
            const root = record?.obj;
            if (!root) continue;
            let parent = root;
            while (parent && parent !== world) parent = parent.parent;
            if (!parent) continue;
            root.traverse((object) => {
                if (!object.isMesh || object.userData?.excludeFromBounds) return;
                const owner = object.isSkinnedMesh || object.isInstancedMesh ? object : object.geometry;
                if (!owner) return;
                if (!owner.boundingBox || object.isSkinnedMesh || object.isInstancedMesh) owner.computeBoundingBox?.();
                if (!owner.boundingBox || owner.boundingBox.isEmpty()) return;
                relative.multiplyMatrices(inverseWorld, object.matrixWorld);
                transformed.copy(owner.boundingBox).applyMatrix4(relative);
                bounds.union(transformed);
            });
        }
        if (bounds.isEmpty()) throw new Error('No georeferenced model is loaded');
        const center = bounds.getCenter(new THREE.Vector3());
        return {
            center: { east: center.x, north: isZUp() ? center.y : -center.z },
            min: bounds.min.toArray(), max: bounds.max.toArray(),
        };
    }

    async function getMapArea(options = {}) {
        requireActive();
        const system = await loadCoordinateSystem();
        // Re-read the current models after the lazy import, including a room switch.
        requireActive();
        const source = getModelBounds();
        return { ...system.getMapArea(source.center, options), sourceBounds: source };
    }

    return { getModelBounds, getMapArea, dispose: () => { disposed = true; } };
}
