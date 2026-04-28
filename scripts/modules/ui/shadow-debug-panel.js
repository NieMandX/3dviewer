export function createShadowDebugPanelController(options = {}) {
    const root = options.root || (typeof document !== 'undefined' ? document : null);

    const THREE = options.THREE || null;
    const renderer = options.renderer || null;
    const dirLight = options.dirLight || null;

    const requestRender = typeof options.requestRender === 'function' ? options.requestRender : () => {};
    const fitSunShadowToScene = typeof options.fitSunShadowToScene === 'function' ? options.fitSunShadowToScene : () => {};
    const setShadowDebug = typeof options.setShadowDebug === 'function' ? options.setShadowDebug : () => {};

    const getShadowDebugVisible =
        typeof options.getShadowDebugVisible === 'function' ? options.getShadowDebugVisible : () => false;
    const getShadowAutoFrustum =
        typeof options.getShadowAutoFrustum === 'function' ? options.getShadowAutoFrustum : () => true;
    const setShadowAutoFrustum =
        typeof options.setShadowAutoFrustum === 'function' ? options.setShadowAutoFrustum : () => {};
    const getShadowFrustumScale =
        typeof options.getShadowFrustumScale === 'function' ? options.getShadowFrustumScale : () => 1;
    const setShadowFrustumScale =
        typeof options.setShadowFrustumScale === 'function' ? options.setShadowFrustumScale : () => {};

    const $ = (id) => root?.getElementById?.(id);

    const shadowDbgBtn = $('shadowDbgBtn');
    const shadowDbg = $('shadowDbg');
    const shadowDbgClose = $('shadowDbgClose');

    const inType = $('shadowType');
    const inSize = $('shadowMapSize');
    const inBias = $('shadowBias');
    const inNBias = $('shadowNormalBias');
    const inRadius = $('shadowRadius');
    const inNear = $('shadowNear');
    const inFar = $('shadowFar');
    const inAuto = $('shadowAuto');
    const inScale = $('shadowFrustumScale');

    const listeners = [];
    function addListener(target, type, handler, options) {
        if (!target?.addEventListener || typeof handler !== 'function') return;
        target.addEventListener(type, handler, options);
        listeners.push({ target, type, handler, options });
    }

    function syncShadowUIFromLight() {
        if (!dirLight || !renderer) return;
        if (!inBias || !inNBias || !inRadius || !inNear || !inFar || !inSize || !inType || !inAuto || !inScale) return;

        const s = dirLight.shadow;
        inBias.value = String(s.bias ?? -0.00005);
        inNBias.value = String(s.normalBias ?? 0.02);
        inRadius.value = String(('radius' in s) ? (s.radius ?? 1) : 1);
        inNear.value = String(s.camera?.near ?? 0.1);
        inFar.value = String(s.camera?.far ?? 200);
        inSize.value = String(s.mapSize?.x ?? 4096);

        const t = renderer.shadowMap.type;
        inType.value = (t === THREE?.VSMShadowMap) ? 'VSM' : (t === THREE?.PCFShadowMap ? 'PCF' : 'PCFSoft');

        inAuto.checked = !!getShadowAutoFrustum();
        inScale.value = String(getShadowFrustumScale());
    }

    function applyShadowUIToLight() {
        if (!dirLight || !renderer) return;
        if (!inBias || !inNBias || !inRadius || !inNear || !inFar || !inSize || !inType || !inAuto || !inScale) return;

        const typeMap = { PCF: THREE?.PCFShadowMap, PCFSoft: THREE?.PCFSoftShadowMap, VSM: THREE?.VSMShadowMap };
        renderer.shadowMap.type = typeMap[inType.value] ?? THREE?.PCFSoftShadowMap;
        renderer.shadowMap.enabled = true;
        dirLight.castShadow = true;

        const size = Math.max(256, parseInt(inSize.value, 10) || 1024);
        if (dirLight.shadow.mapSize.x !== size || dirLight.shadow.mapSize.y !== size) {
            dirLight.shadow.mapSize.set(size, size);
            dirLight.shadow.map?.dispose?.();
        }

        dirLight.shadow.bias = parseFloat(inBias.value) || 0;
        dirLight.shadow.normalBias = parseFloat(inNBias.value) || 0;

        if ('radius' in dirLight.shadow) {
            dirLight.shadow.radius = parseFloat(inRadius.value) || 0;
        }

        const cam = dirLight.shadow.camera;
        if (cam) {
            cam.near = Math.max(0.0001, parseFloat(inNear.value) || 0.1);
            cam.far = Math.max(cam.near + 0.01, parseFloat(inFar.value) || cam.far || 200);
            cam.updateProjectionMatrix();
        }

        const auto = !!inAuto.checked;
        const scale = Math.max(0.01, parseFloat(inScale.value) || 1);
        setShadowAutoFrustum(auto);
        setShadowFrustumScale(scale);
        if (auto) fitSunShadowToScene(false);

        dirLight.shadow.needsUpdate = true;
        requestRender();
    }

    function open() {
        if (!shadowDbg) return;
        syncShadowUIFromLight();
        shadowDbg.classList.add('show');
    }

    function close() {
        shadowDbg?.classList.remove('show');
    }

    addListener($('shadowHelpersBtn'), 'click', () => {
        const next = !getShadowDebugVisible();
        setShadowDebug(next);
        fitSunShadowToScene();
    });

    addListener(shadowDbgBtn, 'click', open);
    addListener(shadowDbgClose, 'click', close);

    addListener($('shadowApply'), 'click', applyShadowUIToLight);
    addListener($('shadowReset'), 'click', () => {
        if (!inType || !inSize || !inBias || !inNBias || !inRadius || !inNear || !inFar || !inAuto || !inScale) return;
        inType.value = 'PCFSoft';
        inSize.value = '4096';
        inBias.value = '-0.00005';
        inNBias.value = '0.02';
        inRadius.value = '1';
        inNear.value = '0.1';
        inFar.value = '200';
        inAuto.checked = true;
        inScale.value = '1';
        applyShadowUIToLight();
    });

    function dispose() {
        close();
        while (listeners.length) {
            const { target, type, handler, options } = listeners.pop();
            try { target.removeEventListener(type, handler, options); } catch (_) {}
        }
    }

    return {
        open,
        close,
        syncShadowUIFromLight,
        applyShadowUIToLight,
        dispose,
    };
}
