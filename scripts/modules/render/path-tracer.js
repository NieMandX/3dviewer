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
    let ptScene = null;
    let ptSceneMap = null;
    let ptGeneratedGeoms = [];

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
    const interactionHoldMs = 260;
    const interactiveTileMin = 4;
    let interactiveActive = false;
    let lastInteractionTime = 0;
    let baseRenderScale = null;
    let baseTiles = null;

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

    function disposePathTraceScene() {
        if (ptGeneratedGeoms?.length) {
            ptGeneratedGeoms.forEach((geom) => {
                if (geom?.dispose) geom.dispose();
            });
        }
        ptGeneratedGeoms = [];
        ptScene = null;
        ptSceneMap = null;
    }

    function copyLightProps(src, dst) {
        if (!src || !dst) return;
        if (src.color && dst.color?.copy) dst.color.copy(src.color);
        if ('intensity' in src) dst.intensity = src.intensity;
        if ('distance' in src) dst.distance = src.distance;
        if ('decay' in src) dst.decay = src.decay;
        if ('angle' in src) dst.angle = src.angle;
        if ('penumbra' in src) dst.penumbra = src.penumbra;
        if ('power' in src) dst.power = src.power;
        dst.visible = src.visible;
        dst.castShadow = src.castShadow;
        dst.position.copy(src.position);
        dst.quaternion.copy(src.quaternion);
        dst.scale.copy(src.scale);
        if (src.target && dst.target) {
            dst.target.position.copy(src.target.position);
            dst.target.quaternion.copy(src.target.quaternion);
            dst.target.scale.copy(src.target.scale);
            dst.target.updateMatrixWorld?.(true);
        }
        dst.updateMatrixWorld?.(true);
    }

    function syncPathTraceEnvironment() {
        if (!ptScene || !scene) return;
        ptScene.environment = scene.environment;
        ptScene.background = scene.background;
        if (scene.environmentRotation?.isEuler && ptScene.environmentRotation?.copy) {
            ptScene.environmentRotation.copy(scene.environmentRotation);
        }
        if (scene.backgroundRotation?.isEuler && ptScene.backgroundRotation?.copy) {
            ptScene.backgroundRotation.copy(scene.backgroundRotation);
        }
    }

    function syncPathTraceLights() {
        if (!ptSceneMap || !scene) return;
        for (const [src, dst] of ptSceneMap.entries()) {
            if (!src?.isLight || !dst?.isLight) continue;
            copyLightProps(src, dst);
        }
        ptScene?.updateMatrixWorld?.(true);
    }

    function buildGroupGeometry(geometry, group) {
        if (!geometry || !group || !THREE) return null;
        if (!geometry.attributes?.position) return null;
        if (Object.keys(geometry.morphAttributes || {}).length) return null;

        const start = Math.max(0, group.start ?? 0);
        const count = Math.max(0, group.count ?? 0);
        if (!count) return null;

        const srcAttrs = geometry.attributes;
        const entries = Object.entries(srcAttrs);

        if (geometry.index) {
            const srcIndex = geometry.index.array;
            const indexSlice = srcIndex.slice(start, start + count);
            if (!indexSlice.length) return null;

            const indexMap = new Map();
            const attrBuffers = {};
            const itemSizes = {};
            const normalizedMap = {};
            const usageMap = {};

            for (const [name, attr] of entries) {
                attrBuffers[name] = [];
                itemSizes[name] = attr.itemSize || 1;
                normalizedMap[name] = !!attr.normalized;
                usageMap[name] = attr.usage;
            }

            let nextIndex = 0;
            const newIndex = new (srcIndex.constructor)(indexSlice.length);

            for (let i = 0; i < indexSlice.length; i++) {
                const oldIndex = indexSlice[i];
                let mapped = indexMap.get(oldIndex);
                if (mapped == null) {
                    mapped = nextIndex++;
                    indexMap.set(oldIndex, mapped);
                    for (const [name, attr] of entries) {
                        const itemSize = itemSizes[name];
                        const srcArray = attr.array;
                        const base = oldIndex * itemSize;
                        const dest = attrBuffers[name];
                        for (let k = 0; k < itemSize; k++) dest.push(srcArray[base + k]);
                    }
                }
                newIndex[i] = mapped;
            }

            const newGeom = new THREE.BufferGeometry();
            for (const [name, attr] of entries) {
                const ctor = attr.array.constructor;
                const data = attrBuffers[name];
                if (!data?.length) continue;
                const typed = new ctor(data);
                const bufferAttr = new THREE.BufferAttribute(typed, itemSizes[name], normalizedMap[name]);
                bufferAttr.name = attr.name;
                if (usageMap[name]) bufferAttr.setUsage(usageMap[name]);
                newGeom.setAttribute(name, bufferAttr);
            }
            newGeom.setIndex(new THREE.BufferAttribute(newIndex, 1));
            if (geometry.boundingBox) newGeom.boundingBox = geometry.boundingBox.clone();
            else newGeom.computeBoundingBox();
            if (geometry.boundingSphere) newGeom.boundingSphere = geometry.boundingSphere.clone();
            else newGeom.computeBoundingSphere();
            newGeom.userData._ptGenerated = true;
            return newGeom;
        }

        const newGeom = new THREE.BufferGeometry();
        for (const [name, attr] of entries) {
            const itemSize = attr.itemSize || 1;
            const srcArray = attr.array;
            const begin = start * itemSize;
            const end = (start + count) * itemSize;
            const slice = srcArray.slice(begin, end);
            if (!slice.length) continue;
            const bufferAttr = new THREE.BufferAttribute(slice, itemSize, attr.normalized);
            bufferAttr.name = attr.name;
            if (attr.usage) bufferAttr.setUsage(attr.usage);
            newGeom.setAttribute(name, bufferAttr);
        }
        if (geometry.boundingBox) newGeom.boundingBox = geometry.boundingBox.clone();
        else newGeom.computeBoundingBox();
        if (geometry.boundingSphere) newGeom.boundingSphere = geometry.boundingSphere.clone();
        else newGeom.computeBoundingSphere();
        newGeom.userData._ptGenerated = true;
        return newGeom;
    }

    function splitMultiMaterialMeshes(root) {
        if (!root || !THREE) return [];
        const targets = [];
        root.traverse((obj) => {
            if (!obj?.isMesh) return;
            if (!Array.isArray(obj.material) || obj.material.length <= 1) return;
            if (!obj.geometry?.groups?.length) return;
            if (obj.isSkinnedMesh || obj.isInstancedMesh) return;
            targets.push(obj);
        });

        const generated = [];
        targets.forEach((mesh) => {
            const parent = mesh.parent;
            if (!parent) return;
            const groups = mesh.geometry.groups || [];
            const materials = mesh.material;
            const newMeshes = [];

            for (const group of groups) {
                const matIndex = Number.isFinite(group?.materialIndex) ? group.materialIndex : 0;
                const material = materials[matIndex] || materials[0];
                const geom = buildGroupGeometry(mesh.geometry, group);
                if (!geom || !material) continue;

                const child = new THREE.Mesh(geom, material);
                child.name = `${mesh.name || mesh.type} · ${material.name || `mat${matIndex}`}`;
                child.castShadow = mesh.castShadow;
                child.receiveShadow = mesh.receiveShadow;
                child.visible = mesh.visible;
                child.matrixAutoUpdate = mesh.matrixAutoUpdate;
                child.position.copy(mesh.position);
                child.quaternion.copy(mesh.quaternion);
                child.scale.copy(mesh.scale);
                if (!mesh.matrixAutoUpdate) child.matrix.copy(mesh.matrix);
                child.userData = { ...(mesh.userData || {}) };
                newMeshes.push(child);
                generated.push(geom);
            }

            if (!newMeshes.length) return;
            const insertAt = parent.children.indexOf(mesh);
            parent.remove(mesh);
            parent.children.splice(insertAt, 0, ...newMeshes);
            newMeshes.forEach((child) => {
                child.parent = parent;
            });
        });

        return generated;
    }

    function shouldSkipObjectForPathTrace(obj) {
        if (!obj || typeof obj !== 'object') return true;
        const ud = obj.userData || null;
        if (ud?.excludeFromExport) return true;
        if (ud?._isBackfaceOverlay) return true;
        if (ud?.lightHelper) return true;
        if (ud?._geoId !== undefined) return true;
        if (ud?._angle !== undefined) return true;

        const type = String(obj.type || obj.constructor?.name || '');
        if (type.endsWith('Helper')) return true;

        const name = String(obj.name || '');
        if (name.includes('(wireframe)') || name.includes('(beautywire)')) return true;

        if ((obj.isLine || obj.isLineSegments) && ud?.excludeFromBounds && obj.parent?.isMesh) return true;

        return (
            !!obj.isHelper ||
            !!obj.isAxesHelper ||
            !!obj.isGridHelper ||
            !!obj.isPolarGridHelper
        );
    }

    function cloneObject3DFilteredWithMap(root, shouldSkipFn) {
        if (!root || typeof root !== 'object') return { root: null, map: new Map() };
        if (shouldSkipFn && shouldSkipFn(root)) return { root: null, map: new Map() };

        const stack = [{ src: root, parentClone: null }];
        let rootClone = null;
        const map = new Map();

        while (stack.length) {
            const { src, parentClone } = stack.pop();
            if (!src || typeof src !== 'object') continue;
            if (shouldSkipFn && shouldSkipFn(src)) continue;

            let cloned = null;
            try {
                const prevUserData = src.userData;
                let didClear = false;
                try {
                    if (prevUserData && typeof prevUserData === 'object' && Object.keys(prevUserData).length > 0) {
                        src.userData = {};
                        didClear = true;
                    }
                    cloned = src.clone(false);
                    if (cloned && typeof cloned === 'object' && cloned.userData && Object.keys(cloned.userData).length > 0) {
                        cloned.userData = {};
                    }
                } finally {
                    if (didClear) src.userData = prevUserData;
                }
            } catch (err) {
                console.warn('Path trace: skipping uncloneable object', src?.type || src?.name || src, err);
                continue;
            }

            if (!rootClone) rootClone = cloned;
            if (parentClone) parentClone.add(cloned);
            map.set(src, cloned);

            const children = Array.isArray(src.children) ? src.children : [];
            for (let i = children.length - 1; i >= 0; i--) {
                stack.push({ src: children[i], parentClone: cloned });
            }
        }

        return { root: rootClone, map };
    }

    function buildPathTracingScene() {
        if (!scene || !THREE) return null;
        disposePathTraceScene();

        const { root: cloned, map } = cloneObject3DFilteredWithMap(scene, shouldSkipObjectForPathTrace);
        if (!cloned) return null;
        cloned.background = scene.background;
        cloned.environment = scene.environment;
        if (scene.environmentRotation?.isEuler && cloned.environmentRotation?.copy) {
            cloned.environmentRotation.copy(scene.environmentRotation);
        }
        if (scene.backgroundRotation?.isEuler && cloned.backgroundRotation?.copy) {
            cloned.backgroundRotation.copy(scene.backgroundRotation);
        }
        if (scene.fog) cloned.fog = scene.fog;

        ptGeneratedGeoms = splitMultiMaterialMeshes(cloned);
        ptScene = cloned;
        ptSceneMap = map;
        return cloned;
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

    function cacheBaseSettings() {
        if (!pathTracer) return;
        if (Number.isFinite(pathTracer.renderScale)) {
            baseRenderScale = pathTracer.renderScale;
        }
        const tiles = pathTracer.tiles;
        if (tiles) {
            baseTiles = {
                x: Number.isFinite(tiles.x) ? tiles.x : 1,
                y: Number.isFinite(tiles.y) ? tiles.y : 1,
            };
        }
    }

    function applyInteractiveSettings() {
        if (!pathTracer) return;
        const baseScale = Number.isFinite(baseRenderScale) ? baseRenderScale : pathTracer.renderScale ?? 1;
        const lowResScale = Number.isFinite(pathTracer.lowResScale) ? pathTracer.lowResScale : baseScale;
        const interactiveScale = clamp(Math.min(baseScale, lowResScale), 0.1, 1);
        if (Number.isFinite(interactiveScale)) {
            pathTracer.renderScale = interactiveScale;
        }
        const tiles = pathTracer.tiles;
        if (tiles?.set) {
            const baseX = baseTiles?.x ?? tiles.x ?? 1;
            const baseY = baseTiles?.y ?? tiles.y ?? 1;
            const interactiveX = clamp(Math.max(baseX, interactiveTileMin), 1, 8);
            const interactiveY = clamp(Math.max(baseY, interactiveTileMin), 1, 8);
            if (tiles.x !== interactiveX || tiles.y !== interactiveY) {
                tiles.set(interactiveX, interactiveY);
            }
        }
    }

    function restoreBaseSettings() {
        if (!pathTracer) return;
        if (Number.isFinite(baseRenderScale)) {
            pathTracer.renderScale = baseRenderScale;
        }
        const tiles = pathTracer.tiles;
        if (tiles?.set && baseTiles) {
            const restoreX = clamp(Number.isFinite(baseTiles.x) ? baseTiles.x : tiles.x ?? 1, 1, 8);
            const restoreY = clamp(Number.isFinite(baseTiles.y) ? baseTiles.y : tiles.y ?? 1, 1, 8);
            if (tiles.x !== restoreX || tiles.y !== restoreY) {
                tiles.set(restoreX, restoreY);
            }
        }
    }

    function enterInteractiveMode() {
        if (!pathTracer || interactiveActive) return;
        cacheBaseSettings();
        interactiveActive = true;
        applyInteractiveSettings();
    }

    function exitInteractiveMode({ reset = true } = {}) {
        if (!pathTracer || !interactiveActive) return;
        interactiveActive = false;
        restoreBaseSettings();
        if (reset) resetAccumulation();
    }

    function clearInteractiveState() {
        interactiveActive = false;
        lastInteractionTime = 0;
        baseRenderScale = null;
        baseTiles = null;
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

        cacheBaseSettings();
        if (interactiveActive) {
            applyInteractiveSettings();
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
            const now = win?.performance?.now ? win.performance.now() : Date.now();
            if (controlsChanged || flightChanged) {
                if (!interactiveActive) {
                    enterInteractiveMode();
                }
                if (Number.isFinite(now)) {
                    lastInteractionTime = now;
                }
                syncCameraFromMain();
                resetAccumulation();
            } else if (
                interactiveActive &&
                Number.isFinite(now) &&
                lastInteractionTime &&
                (now - lastInteractionTime) >= interactionHoldMs
            ) {
                exitInteractiveMode();
            }
            pathTracer.renderSample();
            const samples = pathTracer.samples;
            const shouldUpdateUi =
                !lastUiUpdate ||
                (Number.isFinite(now) && (now - lastUiUpdate) >= uiUpdateInterval) ||
                !Number.isFinite(samples) ||
                samples <= 1;
            if (shouldUpdateUi) {
                updateSampleStats(samples, now);
                const label = Number.isFinite(samples) ? samples.toFixed(2) : '--';
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
        const sourceScene = ptScene || scene;
        const result = pathTracer.setScene(sourceScene, ptCamera);
        if (result && typeof result.then === 'function') {
            await result;
        }
    }

    async function enable() {
        if (enabled || busy) return;
        if (!scene || !camera || !renderer || !rootEl) return;

        clearInteractiveState();
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
            buildPathTracingScene();
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
            disposePathTraceScene();
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
        exitInteractiveMode({ reset: false });
        clearInteractiveState();
        disposePathTraceScene();
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
            syncPathTraceEnvironment();
            pathTracer.updateEnvironment();
            resetAccumulation();
        },
        updateLights: () => {
            if (!enabled || !pathTracer?.updateLights) return;
            syncPathTraceLights();
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
            disposePathTraceScene();
            pathTracer?.dispose?.();
            ptRenderer?.dispose?.();
        },
    });
}
