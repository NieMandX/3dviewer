export function createShadowController(options = {}) {
    const THREE = options.THREE || null;
    const scene = options.scene || null;
    const renderer = options.renderer || null;
    const dirLight = options.dirLight || null;

    const computeSceneBounds = typeof options.computeSceneBounds === 'function' ? options.computeSceneBounds : () => null;

    let shadowCamHelper = null;
    let sunHelper = null;

    let autoFrustum = true;
    let frustumScale = 1;

    function ensureShadowHelpers() {
        if (!THREE || !scene || !dirLight) return;
        if (!shadowCamHelper && dirLight.shadow?.camera) {
            shadowCamHelper = new THREE.CameraHelper(dirLight.shadow.camera);
            shadowCamHelper.visible = false;
            shadowCamHelper.userData.excludeFromBounds = true;
            scene.add(shadowCamHelper);
        }
        if (!sunHelper) {
            sunHelper = new THREE.DirectionalLightHelper(dirLight, 1);
            sunHelper.visible = false;
            sunHelper.userData.excludeFromBounds = true;
            scene.add(sunHelper);
        }
    }

    function setShadowDebug(on) {
        ensureShadowHelpers();
        if (shadowCamHelper) shadowCamHelper.visible = !!on;
        if (sunHelper) sunHelper.visible = !!on;
        shadowCamHelper?.update?.();
        sunHelper?.update?.();
    }

    function isShadowDebugVisible() {
        return !!shadowCamHelper?.visible;
    }

    function getAutoFrustum() {
        return autoFrustum;
    }

    function setAutoFrustum(next) {
        autoFrustum = !!next;
    }

    function getFrustumScale() {
        return frustumScale;
    }

    function setFrustumScale(next) {
        const numeric = Number(next);
        if (!Number.isFinite(numeric)) return;
        frustumScale = Math.max(0.01, numeric);
    }

    function fitSunShadowToScene(recenterTarget = false, margin = 1.3) {
        if (!THREE || !renderer || !dirLight || !dirLight.shadow?.camera) return;

        const box = computeSceneBounds();
        if (!box || typeof box.isEmpty !== 'function' || box.isEmpty()) return;

        const scale = Math.max(0.1, frustumScale || 1);
        const effectiveMargin = margin * scale;

        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        const radius = size.length() * 0.5 * effectiveMargin;
        const spanXY = Math.max(size.x, size.y, size.z) * 0.5 * effectiveMargin;

        if (recenterTarget) {
            dirLight.target.position.copy(center);
            dirLight.target.updateMatrixWorld();
        }

        const cam = dirLight.shadow.camera;
        cam.left = -spanXY;
        cam.right = spanXY;
        cam.top = spanXY;
        cam.bottom = -spanXY;

        const dist = dirLight.position.distanceTo(dirLight.target.position) || (radius * 1.2);
        cam.near = Math.max(0.1, dist - radius);
        cam.far = dist + radius;

        cam.updateProjectionMatrix();

        dirLight.shadow.needsUpdate = true;
        renderer.shadowMap.needsUpdate = true;

        shadowCamHelper?.update?.();
        sunHelper?.update?.();
    }

    return {
        ensureShadowHelpers,
        setShadowDebug,
        isShadowDebugVisible,
        fitSunShadowToScene,
        getAutoFrustum,
        setAutoFrustum,
        getFrustumScale,
        setFrustumScale,
    };
}

