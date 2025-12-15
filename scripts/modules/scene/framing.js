export function createSceneFramingController(options = {}) {
    const THREE = options.THREE || null;
    const world = options.world || null;
    const camera = options.camera || null;
    const controls = options.controls || null;
    const renderer = options.renderer || null;

    const requestRender = typeof options.requestRender === 'function' ? options.requestRender : () => {};
    const getBgMesh = typeof options.getBgMesh === 'function' ? options.getBgMesh : () => null;

    function expandBoxFiltered(box, obj) {
        if (!obj || !obj.visible) return;

        if (obj.userData?.excludeFromBounds) return;
        if (obj.isGridHelper || obj.isAxesHelper || obj.isPolarGridHelper) return;
        if (obj === getBgMesh()) return;
        if (obj.isLight || obj.isPoints) return;

        if (obj.isMesh && obj.geometry) {
            obj.updateWorldMatrix(true, false);
            if (!obj.geometry.boundingBox) obj.geometry.computeBoundingBox();
            const bb = obj.geometry.boundingBox.clone().applyMatrix4(obj.matrixWorld);
            if (!bb.isEmpty()) box.union(bb);
        }

        for (const c of obj.children) expandBoxFiltered(box, c);
    }

    function computeSceneBounds(root = world) {
        if (!THREE) return null;
        const box = new THREE.Box3();
        expandBoxFiltered(box, root);
        return box;
    }

    function focusOn(targets, pad = 1.4) {
        if (!THREE || !camera || !renderer || !controls) return;

        const box = new THREE.Box3();
        const add = (obj) => obj && box.expandByObject(obj);

        if (Array.isArray(targets)) {
            let any = false;
            targets.forEach(o => { if (o) { add(o); any = true; } });
            if (!any) return;
        } else if (targets) {
            add(targets);
        } else {
            return;
        }

        if (box.isEmpty()) return;

        const size = new THREE.Vector3();
        const center = new THREE.Vector3();
        box.getSize(size);
        box.getCenter(center);
        controls.target.copy(center);

        const fov = THREE.MathUtils.degToRad(camera.fov);
        const canvas = renderer.domElement;
        const aspect = canvas.clientWidth / Math.max(canvas.clientHeight, 1);
        const maxDim = Math.max(size.x, size.y, size.z);

        const distForH = (maxDim / (2 * Math.tan(fov / 2)));
        const distForW = (maxDim * aspect / (2 * Math.tan(fov / 2)));
        const dist = Math.max(distForH, distForW) * pad;

        const dirv = new THREE.Vector3(1, 0.6, 1).normalize();
        camera.position.copy(center.clone().add(dirv.multiplyScalar(dist)));
        camera.near = Math.max(dist / 1000, 0.01);
        camera.far = dist * 1000;
        camera.updateProjectionMatrix();
        controls.update();
        requestRender();
    }

    function fitAll() {
        if (!THREE || !camera || !renderer || !controls) return;

        const box = computeSceneBounds();
        if (!box || box.isEmpty()) return;
        const size = new THREE.Vector3(), center = new THREE.Vector3();
        box.getSize(size); box.getCenter(center);
        controls.target.copy(center);

        const fov = THREE.MathUtils.degToRad(camera.fov);
        const aspect = renderer.domElement.clientWidth / Math.max(renderer.domElement.clientHeight, 1);
        const max = Math.max(size.x, size.y, size.z);
        const dist = Math.max(max / (2 * Math.tan(fov / 2)), (max * aspect) / (2 * Math.tan(fov / 2))) * 1.5;

        camera.position.copy(center).add(new THREE.Vector3(1, 0.6, 1).normalize().multiplyScalar(dist));
        camera.near = Math.max(dist / 1000, 0.01);
        camera.far = dist * 1000;
        camera.updateProjectionMatrix();
        requestRender();
    }

    function computeWorldCenter() {
        if (!THREE) return null;
        const box = computeSceneBounds();
        if (!box || box.isEmpty()) return new THREE.Vector3(0, 0, 0);
        return box.getCenter(new THREE.Vector3());
    }

    return {
        computeSceneBounds,
        focusOn,
        fitAll,
        computeWorldCenter,
    };
}

