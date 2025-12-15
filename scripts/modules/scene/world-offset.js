export function createWorldOffsetController(options = {}) {
    const THREE = options.THREE || null;
    const world = options.world || null;
    const camera = options.camera || null;
    const dirLight = options.dirLight || null;

    const isZUp = typeof options.isZUp === 'function' ? options.isZUp : () => false;
    const computeSceneBounds =
        typeof options.computeSceneBounds === 'function' ? options.computeSceneBounds : () => null;
    const getBgMesh = typeof options.getBgMesh === 'function' ? options.getBgMesh : () => null;

    const worldOffset = THREE ? new THREE.Vector3(0, 0, 0) : null;

    function setWorldOffset(offset) {
        if (!worldOffset || !world || !offset) return;
        worldOffset.copy(offset);
        world.position.set(-offset.x, -offset.y, -offset.z);
        world.updateMatrixWorld(true);

        const bgMesh = getBgMesh();
        if (bgMesh && camera) bgMesh.position.copy(camera.position);

        if (dirLight?.target) {
            dirLight.target.position.set(0, 0, 0);
            dirLight.target.updateMatrixWorld();
        }
    }

    function computeAutoOffset() {
        if (!THREE) return null;
        const box = computeSceneBounds();
        if (!box || typeof box.isEmpty !== 'function' || box.isEmpty()) return new THREE.Vector3(0, 0, 0);
        return box.getCenter(new THREE.Vector3());
    }

    function computeAutoOffsetHorizontalOnly() {
        const center = computeAutoOffset();
        if (!center) return center;
        if (isZUp()) {
            center.z = 0;
        } else {
            center.y = 0;
        }
        return center;
    }

    return {
        setWorldOffset,
        computeAutoOffset,
        computeAutoOffsetHorizontalOnly,
    };
}

