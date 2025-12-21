let tracerModulePromise = null;

async function loadTracerModule() {
    if (!tracerModulePromise) {
        tracerModulePromise = import('three-gpu-pathtracer');
    }
    return tracerModulePromise;
}

function getPixelRatio(win) {
    const dpr = typeof win?.devicePixelRatio === 'number' ? win.devicePixelRatio : 1;
    return Math.min(Math.max(dpr, 1), 2);
}

export function createPathTracerController(options = {}) {
    const THREE = options.THREE || null;
    const scene = options.scene || null;
    const camera = options.camera || null;
    const renderer = options.renderer || null;
    const rootEl = options.rootEl || null;
    const controls = options.controls || null;
    const flightControls = options.flightControls || null;
    const renderLoop = options.renderLoop || null;

    const requestRender = typeof options.requestRender === 'function' ? options.requestRender : () => {};
    const setStatusMessage = typeof options.setStatusMessage === 'function' ? options.setStatusMessage : () => {};

    const pathTraceBtn = options.pathTraceBtn || null;
    const pathTraceSamplesEl = options.pathTraceSamplesEl || null;
    const pathTraceSpeedEl = options.pathTraceSpeedEl || null;
    const pathTraceShotBtn = options.pathTraceShotBtn || null;
    const pathTracePanelEl = options.pathTracePanelEl || null;
    const ptBouncesEl = options.ptBouncesEl || null;
    const ptTransmissiveEl = options.ptTransmissiveEl || null;
    const ptGlossyEl = options.ptGlossyEl || null;
    const ptClampEl = options.ptClampEl || null;
    const ptRenderScaleEl = options.ptRenderScaleEl || null;
    const ptLowResScaleEl = options.ptLowResScaleEl || null;
    const ptTilesXEl = options.ptTilesXEl || null;
    const ptTilesYEl = options.ptTilesYEl || null;
    const ptDynamicLowResEl = options.ptDynamicLowResEl || null;
    const ptStableNoiseEl = options.ptStableNoiseEl || null;
    const ptMISEl = options.ptMISEl || null;
    const ptPauseEl = options.ptPauseEl || null;
    const ptResetBtn = options.ptResetBtn || null;

    const win = options.window || (typeof window !== 'undefined' ? window : null);
    const doc = options.document || (typeof document !== 'undefined' ? document : null);

    let enabled = false;
    let busy = false;

    let ptRenderer = null;
    let ptCamera = null;
    let pathTracer = null;

    let rafId = 0;
    let resizeHandler = null;

    let prevCanvasOpacity = null;
    let prevCanvasPointer = null;

    let lastSampleValue = null;
    let lastSpeedValue = null;
    let lastSampleTime = 0;
    let lastSampleCount = 0;
    let sampleSpeed = 0;
    let lastUiUpdate = 0;
    const uiUpdateInterval = 120;

    function updateButtonState() {
        if (!pathTraceBtn) return;
        pathTraceBtn.classList.toggle('active', enabled);
        pathTraceBtn.setAttribute('aria-pressed', enabled ? 'true' : 'false');
        pathTraceBtn.disabled = busy;
    }

    function setPanelVisible(visible) {
        if (!pathTracePanelEl) return;
        pathTracePanelEl.hidden = !visible;
    }

    function setSamplesLabel(value) {
        if (!pathTraceSamplesEl) return;
        const label = String(value ?? '');
        if (label === lastSampleValue) return;
        pathTraceSamplesEl.textContent = label;
        lastSampleValue = label;
    }

    function setSpeedLabel(value) {
        if (!pathTraceSpeedEl) return;
        const label = String(value ?? '');
        if (label === lastSpeedValue) return;
        pathTraceSpeedEl.textContent = label;
        lastSpeedValue = label;
    }

    function resetSampleStats() {
        lastSampleTime = 0;
        lastSampleCount = 0;
        sampleSpeed = 0;
        lastUiUpdate = 0;
        setSpeedLabel('0/s');
    }

    function updateSampleStats(samples, nowValue = null) {
        const now = Number.isFinite(nowValue)
            ? nowValue
            : (win?.performance?.now ? win.performance.now() : Date.now());
        if (!Number.isFinite(samples) || !Number.isFinite(now)) {
            setSpeedLabel('0/s');
            return;
        }
        if (!lastSampleTime) {
            lastSampleTime = now;
            lastSampleCount = samples;
            return;
        }
        if (samples < lastSampleCount) {
            lastSampleTime = now;
            lastSampleCount = samples;
            sampleSpeed = 0;
            setSpeedLabel('0/s');
            return;
        }
        const dt = (now - lastSampleTime) / 1000;
        if (dt < 0.5) return;
        const delta = samples - lastSampleCount;
        const nextSpeed = dt > 0 ? delta / dt : 0;
        sampleSpeed = sampleSpeed ? (sampleSpeed * 0.7 + nextSpeed * 0.3) : nextSpeed;
        lastSampleTime = now;
        lastSampleCount = samples;
        const label = Number.isFinite(sampleSpeed) ? `${sampleSpeed.toFixed(2)}/s` : '0/s';
        setSpeedLabel(label);
    }

    function updateSize() {
        if (!ptRenderer || !win) return;
        const w = Math.max(1, Math.floor(win.innerWidth || 1));
        const h = Math.max(1, Math.floor(win.innerHeight || 1));
        ptRenderer.setPixelRatio(getPixelRatio(win));
        ptRenderer.setSize(w, h, false);
        if (ptCamera) {
            ptCamera.aspect = w / h;
            ptCamera.updateProjectionMatrix();
        }
        pathTracer?.reset?.();
    }

    function attachResize() {
        if (!win || resizeHandler) return;
        resizeHandler = () => updateSize();
        win.addEventListener('resize', resizeHandler);
    }

    function detachResize() {
        if (!win || !resizeHandler) return;
        win.removeEventListener('resize', resizeHandler);
        resizeHandler = null;
    }

    function syncCameraFromMain() {
        if (!ptCamera || !camera) return;
        ptCamera.position.copy(camera.position);
        ptCamera.quaternion.copy(camera.quaternion);
        ptCamera.fov = camera.fov;
        ptCamera.near = camera.near;
        ptCamera.far = camera.far;
        ptCamera.aspect = camera.aspect;
        ptCamera.updateProjectionMatrix();
        ptCamera.updateMatrixWorld();
        if (pathTracer) {
            pathTracer.setCamera(ptCamera);
        }
    }

    function showPathTraceCanvas(visible) {
        if (!ptRenderer?.domElement) return;
        ptRenderer.domElement.style.display = visible ? '' : 'none';
    }

    function hideMainCanvas(hide) {
        const canvas = renderer?.domElement;
        if (!canvas) return;
        if (hide) {
            prevCanvasOpacity = canvas.style.opacity;
            prevCanvasPointer = canvas.style.pointerEvents;
            canvas.style.opacity = '0';
            canvas.style.pointerEvents = prevCanvasPointer || 'auto';
            return;
        }
        canvas.style.opacity = prevCanvasOpacity ?? '';
        canvas.style.pointerEvents = prevCanvasPointer ?? '';
        prevCanvasOpacity = null;
        prevCanvasPointer = null;
    }

    function resetAccumulation() {
        pathTracer?.reset?.();
        resetSampleStats();
    }

    function parseNumber(el, fallback) {
        if (!el) return fallback;
        const value = parseFloat(el.value);
        return Number.isFinite(value) ? value : fallback;
    }

    function parseIntNumber(el, fallback) {
        if (!el) return fallback;
        const value = parseInt(el.value, 10);
        return Number.isFinite(value) ? value : fallback;
    }

    function clamp(value, min, max) {
        return Math.min(Math.max(value, min), max);
    }

    function getClampTargets() {
        if (!pathTracer) return [];
        const targets = [];
        const base = pathTracer._pathTracer?.material;
        const low = pathTracer._lowResPathTracer?.material;
        if (base) targets.push(base);
        if (low && low !== base) targets.push(low);
        return targets;
    }

    function patchMaterialClamp(material) {
        if (!material) return false;
        material.userData ||= {};
        if (material.userData._ptClampPatched) return true;

        if (!material.uniforms?.clampMax) {
            material.uniforms.clampMax = { value: 20 };
        }

        let shader = material.fragmentShader;
        if (!shader) return false;

        let patched = shader.includes('clampMax');
        if (!patched) {
            const withUniform = shader.replace(
                'uniform sampler2D stratifiedOffsetTexture;',
                'uniform sampler2D stratifiedOffsetTexture;\nuniform float clampMax;'
            );
            const withClamp = withUniform.replace(
                /min\(\s*1\.0\s*\/\s*rrProb\s*,\s*20\.0\s*\)/,
                'min( 1.0 / rrProb, clampMax )'
            );
            patched = withClamp !== shader;
            shader = withClamp;
        }

        if (patched) {
            material.fragmentShader = shader;
            material.needsUpdate = true;
            material.userData._ptClampPatched = true;
        }
        return patched;
    }

    function ensureClampSupport() {
        const targets = getClampTargets();
        if (!targets.length) return false;
        return targets.every((mat) => patchMaterialClamp(mat));
    }

    function applyClamp(value) {
        const clampValue = Number.isFinite(value) ? value : 20;
        const targets = getClampTargets();
        if (!targets.length) return;
        targets.forEach((mat) => {
            if (!patchMaterialClamp(mat)) return;
            if (mat.uniforms?.clampMax) {
                mat.uniforms.clampMax.value = clampValue;
            }
        });
    }

    function applySettingsFromUI({ reset = true } = {}) {
        if (!pathTracer) return;
        if (ptBouncesEl) {
            const value = clamp(parseIntNumber(ptBouncesEl, pathTracer.bounces ?? 3), 1, 12);
            ptBouncesEl.value = String(value);
            pathTracer.bounces = value;
        }
        if (ptTransmissiveEl) {
            const value = clamp(parseIntNumber(ptTransmissiveEl, pathTracer.transmissiveBounces ?? 3), 0, 12);
            ptTransmissiveEl.value = String(value);
            pathTracer.transmissiveBounces = value;
        }
        if (ptGlossyEl) {
            const value = clamp(parseNumber(ptGlossyEl, pathTracer.filterGlossyFactor ?? 0), 0, 1);
            ptGlossyEl.value = String(value);
            pathTracer.filterGlossyFactor = value;
        }
        if (ptClampEl) {
            const value = clamp(parseNumber(ptClampEl, 20), 1, 50);
            ptClampEl.value = String(value);
            applyClamp(value);
        }
        if (ptRenderScaleEl) {
            const value = clamp(parseNumber(ptRenderScaleEl, pathTracer.renderScale ?? 1), 0.25, 1);
            ptRenderScaleEl.value = String(value);
            pathTracer.renderScale = value;
        }
        if (ptLowResScaleEl) {
            const value = clamp(parseNumber(ptLowResScaleEl, pathTracer.lowResScale ?? 0.25), 0.1, 1);
            ptLowResScaleEl.value = String(value);
            pathTracer.lowResScale = value;
        }
        if (ptTilesXEl || ptTilesYEl) {
            const tiles = pathTracer.tiles;
            const tileX = clamp(parseIntNumber(ptTilesXEl, tiles?.x ?? 3), 1, 8);
            const tileY = clamp(parseIntNumber(ptTilesYEl, tiles?.y ?? 3), 1, 8);
            if (ptTilesXEl) ptTilesXEl.value = String(tileX);
            if (ptTilesYEl) ptTilesYEl.value = String(tileY);
            tiles?.set?.(tileX, tileY);
        }
        if (ptDynamicLowResEl) {
            pathTracer.dynamicLowRes = !!ptDynamicLowResEl.checked;
        }
        if (ptStableNoiseEl) {
            pathTracer.stableNoise = !!ptStableNoiseEl.checked;
        }
        if (ptMISEl) {
            pathTracer.multipleImportanceSampling = !!ptMISEl.checked;
        }
        if (ptPauseEl) {
            pathTracer.pausePathTracing = !!ptPauseEl.checked;
        }

        if (reset) resetAccumulation();
    }

    function bindSetting(el, handler) {
        if (!el?.addEventListener) return;
        el.addEventListener('input', handler);
        el.addEventListener('change', handler);
    }

    function startLoop() {
        if (!win || !pathTracer) return;
        const tick = () => {
            if (!enabled || !pathTracer) return;
            const controlsChanged = !!controls?.update?.();
            const flightChanged = !!flightControls?.update?.();
            if (controlsChanged || flightChanged) {
                syncCameraFromMain();
                resetAccumulation();
            }
            pathTracer.renderSample();
            const samples = pathTracer.samples;
            const now = win?.performance?.now ? win.performance.now() : Date.now();
            const shouldUpdateUi =
                !lastUiUpdate ||
                (Number.isFinite(now) && (now - lastUiUpdate) >= uiUpdateInterval) ||
                !Number.isFinite(samples) ||
                samples <= 1;
            if (shouldUpdateUi) {
                updateSampleStats(samples, now);
                const label = Number.isFinite(samples)
                    ? (Math.abs(samples - Math.round(samples)) > 1e-4 ? samples.toFixed(2) : String(Math.round(samples)))
                    : '--';
                setSamplesLabel(label);
                if (pathTraceShotBtn) {
                    pathTraceShotBtn.disabled = !Number.isFinite(samples) || samples <= 0 || busy;
                }
                lastUiUpdate = Number.isFinite(now) ? now : Date.now();
            }
            rafId = win.requestAnimationFrame(tick);
        };
        rafId = win.requestAnimationFrame(tick);
    }

    function stopLoop() {
        if (!win || !rafId) return;
        win.cancelAnimationFrame(rafId);
        rafId = 0;
    }

    async function ensurePathTracer() {
        if (pathTracer || !THREE) return;
        const module = await loadTracerModule();
        const WebGLPathTracer = module?.WebGLPathTracer;
        const PhysicalCamera = module?.PhysicalCamera;
        if (!WebGLPathTracer || !PhysicalCamera) {
            throw new Error('Path tracer module missing exports.');
        }

        ptRenderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
        ptRenderer.setPixelRatio(getPixelRatio(win));
        ptRenderer.setSize(Math.max(1, win?.innerWidth || 1), Math.max(1, win?.innerHeight || 1));
        if ('outputColorSpace' in ptRenderer) ptRenderer.outputColorSpace = THREE.SRGBColorSpace;
        if ('toneMapping' in ptRenderer) ptRenderer.toneMapping = THREE.NoToneMapping;
        if (ptRenderer.domElement?.classList) {
            ptRenderer.domElement.classList.add('pathtrace-canvas');
        }
        ptRenderer.domElement.style.display = 'none';
        ptRenderer.domElement.style.pointerEvents = 'none';
        rootEl?.appendChild?.(ptRenderer.domElement);

        ptCamera = new PhysicalCamera();
        pathTracer = new WebGLPathTracer(ptRenderer);
        ensureClampSupport();
    }

    async function buildScene() {
        if (!pathTracer) return;
        const result = pathTracer.setScene(scene, ptCamera);
        if (result && typeof result.then === 'function') {
            await result;
        }
    }

    async function enable() {
        if (enabled || busy) return;
        if (!scene || !camera || !renderer || !rootEl) return;

        busy = true;
        updateButtonState();
        setPanelVisible(true);
        setSamplesLabel('0');
        resetSampleStats();
        if (pathTraceShotBtn) pathTraceShotBtn.disabled = true;

        try {
            setStatusMessage('Photo mode: preparing...');
            await ensurePathTracer();
            if (!ptRenderer || !pathTracer || !ptCamera) {
                throw new Error('Path tracer not initialized.');
            }
            if (ptRenderer.capabilities && ptRenderer.capabilities.isWebGL2 === false) {
                throw new Error('WebGL2 is required for path tracing.');
            }
            syncCameraFromMain();
            updateSize();
            await buildScene();
            pathTracer.enablePathTracing = true;
            pathTracer.pausePathTracing = false;
            pathTracer.renderDelay = 0;
            pathTracer.minSamples = 1;
            pathTracer.renderToCanvas = true;
            pathTracer.rasterizeScene = true;
            applySettingsFromUI({ reset: true });
            showPathTraceCanvas(true);
            hideMainCanvas(true);
            renderLoop?.stop?.();
            enabled = true;
            updateButtonState();
            attachResize();
            startLoop();
            setStatusMessage('');
        } catch (err) {
            console.error(err);
            setStatusMessage('Photo mode: failed to start.');
            setPanelVisible(false);
            showPathTraceCanvas(false);
            hideMainCanvas(false);
        } finally {
            busy = false;
            updateButtonState();
        }
    }

    function disable() {
        if (!enabled && !busy) return;
        enabled = false;
        stopLoop();
        detachResize();
        showPathTraceCanvas(false);
        hideMainCanvas(false);
        renderLoop?.start?.();
        setPanelVisible(false);
        updateButtonState();
        requestRender();
    }

    function toggle() {
        if (enabled) {
            disable();
            return;
        }
        void enable();
    }

    function takeSnapshot() {
        if (!ptRenderer?.domElement || busy) return;
        try {
            const url = ptRenderer.domElement.toDataURL('image/png');
            const link = doc?.createElement?.('a');
            if (!link) return;
            link.href = url;
            link.download = `pathtrace-${Date.now()}.png`;
            doc.body?.appendChild?.(link);
            link.click();
            link.remove();
        } catch (err) {
            console.error(err);
            setStatusMessage('Photo mode: snapshot failed.');
        }
    }

    if (pathTraceBtn) {
        pathTraceBtn.addEventListener('click', toggle);
    }
    if (pathTraceShotBtn) {
        pathTraceShotBtn.addEventListener('click', takeSnapshot);
    }
    if (ptResetBtn) {
        ptResetBtn.addEventListener('click', () => resetAccumulation());
    }
    bindSetting(ptBouncesEl, () => applySettingsFromUI());
    bindSetting(ptTransmissiveEl, () => applySettingsFromUI());
    bindSetting(ptGlossyEl, () => applySettingsFromUI());
    bindSetting(ptClampEl, () => applySettingsFromUI());
    bindSetting(ptRenderScaleEl, () => applySettingsFromUI());
    bindSetting(ptLowResScaleEl, () => applySettingsFromUI());
    bindSetting(ptTilesXEl, () => applySettingsFromUI());
    bindSetting(ptTilesYEl, () => applySettingsFromUI());
    bindSetting(ptDynamicLowResEl, () => applySettingsFromUI());
    bindSetting(ptStableNoiseEl, () => applySettingsFromUI());
    bindSetting(ptMISEl, () => applySettingsFromUI());
    bindSetting(ptPauseEl, () => applySettingsFromUI({ reset: false }));

    return Object.freeze({
        isEnabled: () => enabled,
        setEnabled: (next) => (next ? enable() : disable()),
        toggle,
        resize: updateSize,
        reset: resetAccumulation,
        updateEnvironment: () => {
            if (!enabled || !pathTracer?.updateEnvironment) return;
            pathTracer.updateEnvironment();
            resetAccumulation();
        },
        updateLights: () => {
            if (!enabled || !pathTracer?.updateLights) return;
            pathTracer.updateLights();
            resetAccumulation();
        },
        updateMaterials: () => {
            if (!enabled || !pathTracer?.updateMaterials) return;
            pathTracer.updateMaterials();
            resetAccumulation();
        },
        dispose: () => {
            disable();
            pathTracer?.dispose?.();
            ptRenderer?.dispose?.();
        },
    });
}
