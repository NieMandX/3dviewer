import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';
import {
    configureParcels,
    loadParcels,
    createParcelsGroupFromGeoJSON,
    setVPMReferenceHeight,
    getVPMReferenceHeight,
    parseGeoNumber,
} from './modules/parcels.js';

const REQUESTED_RENDERER_MODE = (() => {
    const forced = globalThis.__LPMVIEW_RENDERER;
    if (forced) return String(forced).toLowerCase();
    if (typeof window !== 'undefined') {
        const param = new URLSearchParams(window.location.search).get('renderer');
        if (param) return param.toLowerCase();
    }
    return 'auto';
})();
const WEBGPU_SUPPORTED = typeof navigator !== 'undefined' && 'gpu' in navigator;
let activeRendererMode = 'webgl';
if (REQUESTED_RENDERER_MODE === 'webgl') {
    activeRendererMode = 'webgl';
} else if (REQUESTED_RENDERER_MODE === 'webgpu') {
    activeRendererMode = WEBGPU_SUPPORTED ? 'webgpu' : 'webgl';
} else {
    activeRendererMode = WEBGPU_SUPPORTED ? 'webgpu' : 'webgl';
}
let USE_WEBGPU = activeRendererMode === 'webgpu';
let WebGPURendererCtor = null;
let webgpuModuleError = null;
let rendererModeNote = '';
let backfaceNodeSupport = null;

if (USE_WEBGPU) {
    try {
        const mod = await import('three/src/renderers/webgpu/WebGPURenderer.js');
        WebGPURendererCtor = mod.WebGPURenderer || mod.default || null;
        if (!WebGPURendererCtor) {
            throw new Error('WebGPURenderer export not found');
        }
        activeRendererMode = 'webgpu';
    } catch (err) {
        console.warn('WebGPU module load failed', err);
        webgpuModuleError = err;
        USE_WEBGPU = false;
        activeRendererMode = 'webgl';
        rendererModeNote = 'fallback: init failed';
    }
}

if (USE_WEBGPU) {
    try {
        const [
            { default: MeshBasicNodeMaterial },
            normalMod,
            positionMod,
            tslMod,
        ] = await Promise.all([
            import('three/src/materials/nodes/MeshBasicNodeMaterial.js'),
            import('three/src/nodes/accessors/Normal.js'),
            import('three/src/nodes/accessors/Position.js'),
            import('three/src/nodes/tsl/TSLBase.js'),
        ]);

        if (MeshBasicNodeMaterial && normalMod?.normalView && positionMod?.positionViewDirection && tslMod?.float && tslMod?.vec3) {
            backfaceNodeSupport = {
                MeshBasicNodeMaterial,
                normalView: normalMod.normalView,
                positionViewDirection: positionMod.positionViewDirection,
                floatNode: tslMod.float,
                vec3Node: tslMod.vec3,
            };
        }
    } catch (err) {
        console.warn('Backface node support init failed', err);
        backfaceNodeSupport = null;
    }
}

if (!USE_WEBGPU && REQUESTED_RENDERER_MODE === 'webgpu') {
    rendererModeNote = 'fallback: unsupported';
}

class ViewerApp {
    constructor() {
        const app = this;

/*
            Полный рефакторинг JS:
            - структурирован по разделам
            - все функции и переменные явно именованы
            - подробные комментарии на русском
            - аккуратные 4-пробельные отступы
        */


        

        // =====================
        // DOM references
        // =====================
        const rootEl          = document.getElementById('viewer');
        const dropEl          = document.getElementById('drop');
        const statusEl        = document.getElementById('status');
        const appbarStatusEl  = document.getElementById('appbarStatus') || statusEl;
        const emptyHintEl     = document.getElementById('emptyHint');

        const setStatusMessage = (message = '') => {
            if (!statusEl) return;
            const hasMessage = !!(message && message.trim());
            statusEl.textContent = hasMessage ? message : '';
            statusEl.hidden = !hasMessage;
            if (appbarStatusEl && appbarStatusEl !== statusEl) {
                appbarStatusEl.textContent = statusEl.textContent;
            }
        };

        const setEmptyHintVisible = (visible) => {
            if (!emptyHintEl) return;
            emptyHintEl.hidden = !visible;
            emptyHintEl.style.opacity = visible ? '1' : '0';
        };
        const shadingSel      = document.getElementById('shadingMode');

        

        const sunHourEl  = document.getElementById('sunHour');
        const sunHourInputEl = document.getElementById('sunHourInput');
        const sunIntensityEl = document.getElementById('sunIntensity');
        const sunIntensityInputEl = document.getElementById('sunIntensityInput');
        const sunDayEl   = document.getElementById('sunDay');
        const sunMonthEl = document.getElementById('sunMonth');
        const sunNorthEl = document.getElementById('sunNorth');

        const imagesDetails = document.getElementById('imagesDetails');
        const bindLogDetails = document.getElementById('bindLogDetails');
        
        if (typeof document !== 'undefined') {
            document.body?.setAttribute('data-renderer', activeRendererMode);
        }

        app.activeRendererMode = activeRendererMode;
        app.rendererModeNote = rendererModeNote;
        if (rendererModeNote) {
            console.warn(rendererModeNote, webgpuModuleError || '');
        }
        app.activeRendererMode = activeRendererMode;
        if (typeof globalThis !== 'undefined') {
            globalThis.__LPMVIEW_ACTIVE_RENDERER = activeRendererMode;
        }

        // Москва
        const MOSCOW_LAT = 55.6666;
        const MOSCOW_LON = 37.5;

        const MOS_PARCELS = Object.freeze({
            datasetId: 1497,
            apiKey: '205841bf-e747-4627-87ba-dd0f36392884',
            baseUrl: 'https://apidata.mos.ru/v1/datasets'
        });
        // const MOS_PARCELS_TARGET_GLOBAL_ID = '2703068986';
        // const MOS_PARCELS_TARGET_GLOBAL_ID = '2703013442';
        const MOS_PARCELS_TARGET_GLOBAL_ID = '';

        const MOS_PARCELS_FILTER = null;

        const iblChk          = document.getElementById('hdriChk');
        const hdriPresetSel   = document.getElementById('hdriPreset');
        const iblIntEl        = document.getElementById('iblInt');
        const iblGammaEl      = document.getElementById('iblGamma');
        const iblTintEl       = document.getElementById('iblTint');
        const iblRotEl        = document.getElementById('iblRot');
        const hemiIntEl       = document.getElementById('hemiInt');
        const hemiSkyEl       = document.getElementById('hemiSky');
        const hemiGroundEl    = document.getElementById('hemiGround');
        const hdriExposureEl  = document.getElementById('hdriExposure');
        const hdriSaturationEl= document.getElementById('hdriSaturation');
        const hdriBlurEl      = document.getElementById('hdriBlur');
        const axisSel         = null;
        const isZUp = () => false;
        const toggleSideBtn   = document.getElementById('toggleSideBtn');
        const statsBtn        = document.getElementById('statsBtn');
        const statsOverlayEl  = document.getElementById('statsOverlay');

        const glassOpacityEl      = document.getElementById('glassOpacity');
        const glassIorEl          = document.getElementById('glassIor');
        const glassTransmissionEl = document.getElementById('glassTransmission');
        const glassReflectEl      = document.getElementById('glassReflect');
        const glassRoughEl        = document.getElementById('glassRough');
        const glassMetalEl        = document.getElementById('glassMetal');
        const glassAttenDistEl    = document.getElementById('glassAttenDist');
        const glassAttenColorEl   = document.getElementById('glassAttenColor');
        const glassColorEl        = document.getElementById('glassColor');
        const glassResetBtn       = document.getElementById('glassReset');

        const glassValueDisplays = new Map();

        function registerGlassDisplay(id, input) {
            if (!input) return;
            const display = document.querySelector(`[data-value-for="${id}"]`);
            if (!display) return;
            glassValueDisplays.set(id, { input, display });
        }

        function sliderStepDecimals(input) {
            if (!input) return 2;
            const stepAttr = input.getAttribute?.('step');
            if (!stepAttr || stepAttr === 'any') return 2;
            if (stepAttr.includes('.')) {
                const decimals = stepAttr.split('.')[1]?.length || 0;
                return Math.min(Math.max(decimals, 0), 4);
            }
            return 0;
        }

        function applyGlassDisplay(entry) {
            if (!entry) return;
            const { input, display } = entry;
            if (!display || !input) return;
            if (input.type === 'color') {
                const val = String(input.value || '').toUpperCase();
                if (display instanceof HTMLInputElement) display.value = val;
                else display.textContent = val;
                return;
            }
            const numeric = parseFloat(input.value);
            if (!Number.isFinite(numeric)) {
                if (display instanceof HTMLInputElement) display.value = input.value || '';
                else display.textContent = input.value || '';
                return;
            }
            const formatted = numeric.toFixed(sliderStepDecimals(input));
            if (display instanceof HTMLInputElement) display.value = formatted;
            else display.textContent = formatted;
        }

        function updateGlassDisplay(id) {
            applyGlassDisplay(glassValueDisplays.get(id));
        }

        function updateAllGlassDisplays() {
            glassValueDisplays.forEach(applyGlassDisplay);
        }

        registerGlassDisplay('glassOpacity', glassOpacityEl);
        registerGlassDisplay('glassReflect', glassReflectEl);
        registerGlassDisplay('glassRough', glassRoughEl);
        registerGlassDisplay('glassMetal', glassMetalEl);
        registerGlassDisplay('glassIor', glassIorEl);
        registerGlassDisplay('glassTransmission', glassTransmissionEl);
        registerGlassDisplay('glassAttenDist', glassAttenDistEl);
        registerGlassDisplay('glassAttenColor', glassAttenColorEl);
        registerGlassDisplay('glassColor', glassColorEl);
        updateAllGlassDisplays();

        const lightValueDisplays = new Map();

        function registerLightDisplay(id, slider) {
            if (!slider) return;
            const display = document.querySelector(`[data-light-value-for="${id}"]`);
            if (!display || !(display instanceof HTMLInputElement)) return;
            lightValueDisplays.set(id, { slider, display });
            slider.addEventListener('input', () => updateLightDisplay(id));
        }

        function applyLightDisplay(entry) {
            if (!entry) return;
            const { slider, display } = entry;
            if (!slider || !(display instanceof HTMLInputElement)) return;
            const numeric = parseFloat(slider.value);
            if (!Number.isFinite(numeric)) {
                display.value = slider.value || '';
                return;
            }
            display.value = numeric.toFixed(sliderStepDecimals(slider));
        }

        function updateLightDisplay(id) {
            applyLightDisplay(lightValueDisplays.get(id));
        }

        function updateAllLightDisplays() {
            lightValueDisplays.forEach(applyLightDisplay);
        }

        function commitLightDisplayInput(id) {
            const entry = lightValueDisplays.get(id);
            if (!entry) return;
            const { slider, display } = entry;
            if (!slider || !(display instanceof HTMLInputElement)) return;

            const raw = (display.value || '').replace(',', '.').trim();
            const parsed = parseFloat(raw);
            if (!Number.isFinite(parsed)) {
                updateLightDisplay(id);
                return;
            }

            let next = clampValueToSlider(slider, parsed);
            next = snapValueToStep(slider, next);
            next = clampValueToSlider(slider, next);

            const decimals = sliderStepDecimals(slider);
            const formatted = Number.isFinite(decimals) ? next.toFixed(decimals) : String(next);

            slider.value = formatted;
            display.value = formatted;
            updateLightDisplay(id);
            slider.dispatchEvent(new Event('input', { bubbles: true }));
        }

        function attachLightDisplayInputs() {
            lightValueDisplays.forEach(({ display }, id) => {
                if (!(display instanceof HTMLInputElement)) return;
                const commit = () => commitLightDisplayInput(id);
                display.addEventListener('change', commit);
                display.addEventListener('blur', commit);
                display.addEventListener('keydown', (event) => {
                    if (event.key === 'Enter') {
                        event.preventDefault();
                        commit();
                        display.blur();
                    } else if (event.key === 'Escape') {
                        updateLightDisplay(id);
                        display.blur();
                    }
                });
            });
        }

        const outEl           = document.getElementById('out');
        const galleryEl       = document.getElementById('gallery');
        const texCountEl      = document.getElementById('texCount');
        const matSelect       = document.getElementById('matSelect');
        const bindLogEl       = document.getElementById('bindLog');

        const bgAlphaEl       = document.getElementById('bgAlpha');
        bgAlphaEl.addEventListener('input', updateBgVisibility);

        [
            ['hemiInt', hemiIntEl],
            ['bgAlpha', bgAlphaEl],
            ['iblInt', iblIntEl],
            ['iblGamma', iblGammaEl],
            ['iblRot', iblRotEl],
            ['hdriExposure', hdriExposureEl],
            ['hdriSaturation', hdriSaturationEl],
            ['hdriBlur', hdriBlurEl],
        ].forEach(([id, slider]) => registerLightDisplay(id, slider));
        updateAllLightDisplays();
        attachLightDisplayInputs();

        const sampleSelect    = document.getElementById('sampleSelect');


        let didInitialRebase = false;
        let currentShadingMode = 'pbr';
        let galleryNeedsRefresh = false;
        let galleryRenderedCount = 0;
        let gallerySpacerEl = null;
        let lastFinalizedModelIndex = 0;
        let needsRender = true;
        let parcelsGroup = null;
        let parcelsOrigin = null;
        const panelState = {
            rootDetails: null,
            ungroupedMarker: null,
            groups: new Map(),
            renderedModels: new Set(),
        };
        let statsVisible = false;
        let lastStatsUpdate = 0;
        let fpsEstimate = 0;
        let lastFrameTime = 0;
        let lastRenderStats = null;
        let sceneStatsDirty = true;
        let cachedSceneStats = { triangles: 0 };
        app.dom = {
            rootEl,
            dropEl,
            statusEl,
            appbarStatusEl,
            emptyHintEl,
            shadingSel,
            sunHourEl,
            sunDayEl,
            sunMonthEl,
            sunNorthEl,
            imagesDetails,
            bindLogDetails,
            iblChk,
            hdriPresetSel,
            iblIntEl,
            iblGammaEl,
            iblTintEl,
            iblRotEl,
            axisSel,
            toggleSideBtn,
            glassOpacityEl,
            glassIorEl,
            glassTransmissionEl,
            glassReflectEl,
            glassMetalEl,
            glassAttenDistEl,
            glassAttenColorEl,
            outEl,
            galleryEl,
            texCountEl,
            matSelect,
            bindLogEl,
            bgAlphaEl,
            sampleSelect,
            statsBtn,
            statsOverlayEl,
        };
        app.location = { latitude: MOSCOW_LAT, longitude: MOSCOW_LON };

        function requestRender() {
            needsRender = true;
        }



        // =====================
        // THREE.js scene init
        // =====================
        const scene    = new THREE.Scene();
        scene.background = new THREE.Color(0xffffff);

        const world    = new THREE.Group();
        scene.add(world);

        function markSceneStatsDirty() {
            sceneStatsDirty = true;
        }

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
                geometry.groups.forEach(group => {
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

        function getSceneGeometryStats() {
            if (!sceneStatsDirty && cachedSceneStats) return cachedSceneStats;
            const stats = { triangles: 0 };
            if (!world) {
                cachedSceneStats = stats;
                sceneStatsDirty = false;
                return stats;
            }
            world.traverse(obj => {
                if (!obj?.isMesh) return;
                if (obj.userData?._isBackfaceOverlay) return;
                if (!isObjectGloballyVisible(obj)) return;
                if (obj.material && Array.isArray(obj.material) && obj.material.every(mat => mat && mat.visible === false)) return;
                if (obj.material && !Array.isArray(obj.material) && obj.material.visible === false) return;
                const triCount = estimateTrianglesForMesh(obj);
                if (triCount > 0) stats.triangles += triCount;
            });
            cachedSceneStats = stats;
            sceneStatsDirty = false;
            return stats;
        }

        let bgMesh = null; // background sphere used to show HDRI
        app.bgMesh = bgMesh;

        const camera   = new THREE.PerspectiveCamera(60, 1, 0.01, 5000);
        camera.position.set(2.5, 1.5, 3.5);

        const renderer = USE_WEBGPU && WebGPURendererCtor
            ? new WebGPURendererCtor({ antialias: true })
            : new THREE.WebGLRenderer({ antialias: true });
        app.renderer = renderer;
        if (renderer.info && Object.prototype.hasOwnProperty.call(renderer.info, 'autoReset')) {
            renderer.info.autoReset = false;
        }

        let rendererReady = !USE_WEBGPU;
        let rendererInitPromise = Promise.resolve();
        if (USE_WEBGPU && typeof renderer.init === 'function') {
            rendererInitPromise = renderer.init()
                .then(() => {
                    rendererReady = true;
                    requestRender();
                })
                .catch(err => {
                    console.error('WebGPU init failed', err);
                    setStatusMessage('⚠️ WebGPU: не удалось инициализировать рендерер.');
                });
        } else if (USE_WEBGPU) {
            rendererReady = true;
        }
        app.rendererInitPromise = rendererInitPromise;

        if ('shadowMap' in renderer) {
            renderer.shadowMap.enabled = true;
            if (renderer.shadowMap && 'type' in renderer.shadowMap) {
                renderer.shadowMap.type = THREE.PCFSoftShadowMap; // можно VSM, если хотите более мягкие
            }
        }

        if (typeof devicePixelRatio === 'number' && renderer.setPixelRatio) {
            renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
        }
        if ('outputColorSpace' in renderer) renderer.outputColorSpace = THREE.SRGBColorSpace;
        if ('toneMapping' in renderer) renderer.toneMapping = THREE.ACESFilmicToneMapping;
        if ('toneMappingExposure' in renderer) renderer.toneMappingExposure = 1.0;
        rootEl.appendChild(renderer.domElement);

        
        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.addEventListener('change', requestRender);

        // Простое освещение и сетка
        const hemiLight = new THREE.HemisphereLight(0xffffff, 0xcfd8dc, 1);

        scene.add(hemiLight);
        const dirLight = new THREE.DirectionalLight(0xffffff, 10.0);
        dirLight.castShadow = true;
        dirLight.shadow.mapSize.set(4096, 4096);
        dirLight.shadow.bias = -0.0005;      // боремся с acne
        dirLight.shadow.normalBias = 0.02;    // боремся с peter-panning
        dirLight.position.set(3, 5, 4);
        scene.add(dirLight);

        let sunEnabled = true;
        const sunDir = new THREE.Vector3(0, 1, 0); // актуальное направление солнца (единичный)



        const GRID_SIZE = 100;
        const grid = createPointGridHelper({ size: GRID_SIZE, divisions: 100, color: 0x888888 });
        grid.userData.excludeFromBounds = true;
        scene.add(grid);
        app.grid = grid;

        const northPointer = createNorthPointer();
        scene.add(northPointer);
        app.northPointer = northPointer;

        const _northTmpDir = new THREE.Vector3();
        const _northBaseVec = new THREE.Vector3();
        const _northUpVec = new THREE.Vector3();
        const _northPlaneVec2 = new THREE.Vector2();
        const _glassTmpColor = new THREE.Color();

        function createNorthPointer() {
            const color = 0xff3d00;
            const group = new THREE.Group();
            group.name = 'NorthPointer';
            group.userData.excludeFromBounds = true;

            const material = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 });
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 1], 3));
            const line = new THREE.Line(geometry, material);
            line.frustumCulled = false;
            line.userData.excludeFromBounds = true;
            group.add(line);

            group.userData.line = line;
            return group;
        }

        function createPointGridHelper({ size = 100, divisions = 10, color = 0x888888 } = {}) {
            const group = new THREE.Group();
            group.name = 'PointGrid';

            const half = size * 0.5;
            const step = divisions > 0 ? size / divisions : size;

            const positions = [];
            for (let x = -half; x <= half + 1e-6; x += step) {
                for (let z = -half; z <= half + 1e-6; z += step) {
                    positions.push(x, 0, z);
                }
            }

            const geometry = new THREE.BufferGeometry();
            const array = new Float32Array(positions);
            const attr = new THREE.BufferAttribute(array, 3);
            geometry.setAttribute('position', attr);
            geometry.setDrawRange(0, array.length / 3);

                        const material = new THREE.PointsMaterial({
                color,
                size: 0.8,
                sizeAttenuation: false,
                transparent: true,
                opacity: 0.75,
            });

            const points = new THREE.Points(geometry, material);
            points.renderOrder = -10;
            points.userData.excludeFromBounds = true;
            points.isGridHelper = true;

            group.add(points);
            group.userData.excludeFromBounds = true;
            group.isGridHelper = true;

            group.userData.gridSize = size;
            group.userData.step = step;
            group.userData.geometry = geometry;
            group.userData.basePositions = array.slice(0);
            group.userData.lineLength = size * 0.5;

            return group;
        }

        function alignParcelsGroupToNorth() {
            if (!parcelsGroup) return;

            parcelsGroup.rotation.set(0, 0, 0);
            parcelsGroup.quaternion.identity();

            parcelsGroup.updateMatrixWorld(true);
            requestRender();
        }

        function updateNorthPointer() {
            if (!northPointer) return;
            const line = northPointer.userData?.line;
            if (!line) return;

            const northDeg = parseFloat(sunNorthEl?.value) || 0;
            const up = isZUp() ? _northUpVec.set(0, 0, 1) : _northUpVec.set(0, 1, 0);
            const base = isZUp() ? _northBaseVec.set(0, 1, 0) : _northBaseVec.set(0, 0, 1);

            const dir = _northTmpDir.copy(base).applyAxisAngle(up, THREE.MathUtils.degToRad(-northDeg)).normalize();
            dir.multiplyScalar(-1);
            const gridSize = (app.grid?.userData?.gridSize) ?? GRID_SIZE;
            const lineLength = gridSize * 0.5;

            const positions = line.geometry.attributes.position.array;
            positions[0] = 0; positions[1] = 0; positions[2] = 0;
            positions[3] = dir.x * lineLength;
            positions[4] = dir.y * lineLength;
            positions[5] = dir.z * lineLength;
            line.geometry.attributes.position.needsUpdate = true;

            northPointer.position.set(0, 0, 0);
            app.northDirection = dir.clone();

            updateGridNorthGap(dir, lineLength);
            alignParcelsGroupToNorth();
            requestRender();
        }

        function updateGridNorthGap(dir, lineLength) {
            const gridHelper = app.grid;
            if (!gridHelper) return;
            const geometry = gridHelper.userData?.geometry;
            const basePositions = gridHelper.userData?.basePositions;
            if (!geometry || !basePositions) return;

            const attr = geometry.attributes.position;
            const arr = attr.array;
            const step = gridHelper.userData.step || 1;
            const size = gridHelper.userData.gridSize || GRID_SIZE;

            let maxAlong = lineLength;
            if (maxAlong == null) {
                maxAlong = gridHelper.userData.lineLength;
                if (maxAlong == null) maxAlong = size * 0.5;
            }
            const cutoff = maxAlong + step * 0.5;
            const threshold = Math.max(step * 0.5, 0.2);
            const forwardTolerance = Math.min(step * 0.25, 0.1);

            const vec2 = isZUp()
                ? _northPlaneVec2.set(dir.x, dir.y)
                : _northPlaneVec2.set(dir.x, dir.z);
            let len = vec2.length();
            if (!Number.isFinite(len) || len < 1e-6) {
                vec2.set(0, 1);
                len = 1;
            }
            vec2.divideScalar(len);

            let write = 0;
            for (let i = 0; i < basePositions.length; i += 3) {
                const x = basePositions[i];
                const y = basePositions[i + 1];
                const z = basePositions[i + 2];
                const px = x;
                const pz = z;

                const along = px * vec2.x + pz * vec2.y;
                const perp = Math.abs(px * vec2.y - pz * vec2.x);
                const masked = along >= -forwardTolerance && along <= cutoff && perp <= threshold;

                if (!masked) {
                    arr[write] = x;
                    arr[write + 1] = y;
                    arr[write + 2] = z;
                    write += 3;
                }
            }

            attr.needsUpdate = true;
            geometry.setDrawRange(0, write / 3);
            geometry.computeBoundingSphere();
        }

        configureParcels({
            apiKey: MOS_PARCELS.apiKey,
            datasetId: MOS_PARCELS.datasetId,
            baseUrl: MOS_PARCELS.baseUrl,
            filter: MOS_PARCELS_FILTER,
            targetGlobalId: MOS_PARCELS_TARGET_GLOBAL_ID,
            resetOrigin: true,
        });

        const buildParcelsGroup = (geojson, overrides = {}) => createParcelsGroupFromGeoJSON(geojson, {
            origin: parcelsOrigin,
            verticalIsZ: isZUp(),
            referenceHeight: overrides.referenceHeight ?? getVPMReferenceHeight(),
        });

        async function loadMosParcels(options = {}) {
            const {
                fetchAll = true,
                batchSize = 200,
                maxRecords = MOS_PARCELS_TARGET_GLOBAL_ID ? 1 : 10000,
                initialTop = 200,
                filter = MOS_PARCELS_FILTER,
                targetGlobalId = MOS_PARCELS_TARGET_GLOBAL_ID,
            } = options;

            try {
                setStatusMessage('Загрузка участков data.mos.ru…');

                const { features, processedCount } = await loadParcels({
                    fetchAll,
                    batchSize,
                    initialTop,
                    maxRecords,
                    filter,
                    targetGlobalId,
                    onProgress: ({ collectedCount, processedCount }) => {
                        setStatusMessage(`Загрузка участков… найдено ${collectedCount} из ${processedCount}`);
                    },
                });

                if (!features.length) {
                    setStatusMessage('Участки не найдены');
                    return;
                }

                const aggregated = { type: 'FeatureCollection', features };
                const group = buildParcelsGroup(aggregated);
                if (!group) {
                    setStatusMessage(`Участки не найдены (0 контуров среди ${features.length} записей)`);
                    return;
                }

                if (parcelsGroup) {
                    world.remove(parcelsGroup);
                    parcelsGroup.traverse(o => o.geometry?.dispose?.());
                    markSceneStatsDirty();
                }

                parcelsGroup = group;
                parcelsOrigin = group.userData.originMeters || parcelsOrigin;
                world.add(parcelsGroup);
                alignParcelsGroupToNorth();
                app.layers.parcels = parcelsGroup;
                markSceneStatsDirty();

                logBind?.(`MOS parcels: загружено ${group.children.length} контуров (обработано ${features.length})`, 'info');
                schedulePanelRefresh();
                requestRender();
                setStatusMessage('');
            } catch (err) {
                console.error(err);
                setStatusMessage('Не удалось загрузить участки: ' + (err?.message || err));
            }
        }

        updateNorthPointer();
        app.scene = scene;
        app.world = world;
        app.camera = camera;
        app.renderer = renderer;
        app.controls = controls;
        app.hemiLight = hemiLight;
        app.dirLight = dirLight;
        app.grid = grid;
        app.sun = { enabled: sunEnabled, direction: sunDir.clone() };
        app.layers = { parcels: null };



        // =====================================================================
        // Lighting & Shadows · Sun control / debug panel
        // =====================================================================

        // --- Shadows debug panel (после создания dirLight!) ---
                const $ = (id) => document.getElementById(id);

                const shadowDbgBtn   = $('shadowDbgBtn');
                const shadowDbg      = $('shadowDbg');
                const shadowDbgClose = $('shadowDbgClose');

                const inType   = $('shadowType');
                const inSize   = $('shadowMapSize');
                const inBias   = $('shadowBias');
                const inNBias  = $('shadowNormalBias');
                const inRadius = $('shadowRadius');
                const inNear   = $('shadowNear');
                const inFar    = $('shadowFar');
                const inAuto   = $('shadowAuto');
                const inScale  = $('shadowFrustumScale');

                /** Открывает панель отладки теней и синхронизирует значения. */
                function openShadowDbg(){ if (shadowDbg) { syncShadowUIFromLight(); shadowDbg.classList.add('show'); } }
                /** Закрывает панель отладки теней. */
                function closeShadowDbg(){ shadowDbg?.classList.remove('show'); }

                document.getElementById('shadowHelpersBtn').addEventListener('click', () => {
                    const next = !(shadowCamHelper?.visible);
                    setShadowDebug(next);
                    fitSunShadowToScene();
                });

                shadowDbgBtn?.addEventListener('click', openShadowDbg);
                shadowDbgClose?.addEventListener('click', closeShadowDbg);

                /** Передаёт текущие настройки directional light в UI-поля панели. */
                function syncShadowUIFromLight(){
                if (!dirLight) return;
                const s = dirLight.shadow;
                inBias.value   = String(s.bias ?? -0.00005);
                inNBias.value  = String(s.normalBias ?? 0.02);
                inRadius.value = String(('radius' in s) ? (s.radius ?? 1) : 1);
                inNear.value   = String(s.camera?.near ?? 0.1);
                inFar.value    = String(s.camera?.far  ?? 200);
                inSize.value   = String(s.mapSize?.x ?? 4096);

                // тип теней
                const t = renderer.shadowMap.type;
                inType.value = (t === THREE.VSMShadowMap) ? 'VSM' : (t === THREE.PCFShadowMap ? 'PCF' : 'PCFSoft');

                inAuto.checked = !!shadowAutoFrustum;
                inScale.value  = String(shadowFrustumScale);
                }

                /** Применяет значения из UI к источнику света и обновляет сцену. */
                function applyShadowUIToLight(){
                if (!dirLight) return;

                // тип теней
                const typeMap = { PCF: THREE.PCFShadowMap, PCFSoft: THREE.PCFSoftShadowMap, VSM: THREE.VSMShadowMap };
                renderer.shadowMap.type = typeMap[inType.value] ?? THREE.PCFSoftShadowMap;
                renderer.shadowMap.enabled = true;
                dirLight.castShadow = true;

                // размер карты
                const size = Math.max(256, parseInt(inSize.value, 10) || 1024);
                if (dirLight.shadow.mapSize.x !== size || dirLight.shadow.mapSize.y !== size) {
                    dirLight.shadow.mapSize.set(size, size);
                    dirLight.shadow.map?.dispose?.(); // пересоздать рендер-таргет
                }

                // смещения
                dirLight.shadow.bias       = parseFloat(inBias.value)  || 0;
                dirLight.shadow.normalBias = parseFloat(inNBias.value) || 0;

                // радиус (для PCFSoft/VSM)
                if ('radius' in dirLight.shadow) {
                    dirLight.shadow.radius = parseFloat(inRadius.value) || 0;
                }

                // near/far + фрустум
                const cam = dirLight.shadow.camera;
                if (cam) {
                    cam.near = Math.max(0.0001, parseFloat(inNear.value) || 0.1);
                    cam.far  = Math.max(cam.near + 0.01, parseFloat(inFar.value)  || cam.far || 200);
                    cam.updateProjectionMatrix();
                }

                // авто-фрустум от сцены + масштаб
                shadowAutoFrustum = !!inAuto.checked;
                shadowFrustumScale = Math.max(0.01, parseFloat(inScale.value) || 1);
                if (shadowAutoFrustum) fitSunShadowToScene(false);

                dirLight.shadow.needsUpdate = true;
                requestRender();
                }

                $('shadowApply')?.addEventListener('click', applyShadowUIToLight);
                $('shadowReset')?.addEventListener('click', () => {
                inType.value   = 'PCFSoft';
                inSize.value   = '4096';
                inBias.value   = '-0.00005';
                inNBias.value  = '0.02';
                inRadius.value = '1';
                inNear.value   = '0.1';
                inFar.value    = '200';
                inAuto.checked = true;
                inScale.value  = '1';
                applyShadowUIToLight();
                });

        // ---------------------------------
        // END OF DEBUG SHADDOW PANNEL LOGIC
        // ---------------------------------

       
        // SUN elements
        // ссылки
        const sunEnabledEl  = document.getElementById('sunEnabled');
        const sunControlsEl = document.getElementById('sunControls');

        // якорь для "возврата" панели на то же место
        let sunAnchor = null;
        if (sunControlsEl && sunControlsEl.parentNode) {
            sunAnchor = document.createComment('sun-controls-anchor');
            sunControlsEl.parentNode.insertBefore(sunAnchor, sunControlsEl); // ставим якорь прямо перед блоком
        }

        // функции монтажа/демонтажа
        /** Возвращает элементы управления солнцем назад в тулбар. */
        function mountSunControls() {
            if (!sunControlsEl || !sunAnchor) return;
            if (sunControlsEl.isConnected) return;         // уже на месте
            sunAnchor.replaceWith(sunControlsEl);          // вернуть ровно туда, где стоял якорь
            try { layout(); } catch(_) {}
        }

        /** Удаляет элементы управления солнцем из тулбара. */
        function unmountSunControls() {
            if (!sunControlsEl || !sunControlsEl.isConnected) return;
            if (!sunAnchor) return;
            // вернуть якорь перед панелью и убрать панель
            sunControlsEl.parentNode.insertBefore(sunAnchor, sunControlsEl);
            sunControlsEl.remove();
            try { layout(); } catch(_) {}
        }

        // главный переключатель солнца+теней
        /** Переключает directional light и блок управления солнцем. */
        function setSunEnabled(on){
            on = !!on;
            sunEnabled = on;
            app.sun.enabled = on;

            // источник и тени
            dirLight.visible = on;
            dirLight.castShadow = on;
            renderer.shadowMap.enabled = on;

            // убираем/возвращаем регуляторы в тулбар
            if (on) {
                mountSunControls();
                updateSun();            // пересчитать позицию солнца
                fitSunShadowToScene();  // обновить объём теней
            } else {
                unmountSunControls();
            }
            requestRender();
        }

        // инициализация тумблера
        sunEnabledEl?.addEventListener('change', e => setSunEnabled(e.target.checked));
        setSunEnabled(sunEnabledEl?.checked ?? true);


        // =====================
        // Loaders & caches
        // =====================
        const fbxLoader      = new FBXLoader();
        const textureLoader  = new THREE.TextureLoader();
        const texLd          = new THREE.TextureLoader(); // for small helper textures

        const fbxWorkerUrl = (() => {
            try { return new URL('./fbx-worker.js', import.meta.url); }
            catch (_) { return null; }
        })();
        let fbxWorkerSupported = typeof Worker !== 'undefined' && !!fbxWorkerUrl;
        let fbxWorkerInstance = null;
        let fbxWorkerReqId = 0;
        const fbxWorkerPending = new Map();

        function ensureFBXWorker() {
            if (!fbxWorkerSupported) return null;
            if (fbxWorkerInstance) return fbxWorkerInstance;
            try {
                fbxWorkerInstance = new Worker(fbxWorkerUrl, { type: 'module' });
                fbxWorkerInstance.onmessage = (event) => {
                    const { id, ok, json, error, duration, fbxTree } = event.data || {};
                    const job = fbxWorkerPending.get(id);
                    if (!job) return;
                    fbxWorkerPending.delete(id);
                    if (ok) job.resolve({ json, duration, fbxTree });
                    else job.reject(new Error(error || 'FBX worker error'));
                };
                fbxWorkerInstance.onerror = (event) => {
                    event.preventDefault?.();
                    const err = event?.error || event?.message || new Error('FBX worker error');
                    fbxWorkerPending.forEach(({ reject }) => reject(err));
                    fbxWorkerPending.clear();
                    fbxWorkerInstance?.terminate?.();
                    fbxWorkerInstance = null;
                    fbxWorkerSupported = false;
                };
            } catch (err) {
                console.warn('FBX worker init failed', err);
                fbxWorkerSupported = false;
                fbxWorkerInstance = null;
            }
            return fbxWorkerInstance;
        }

        async function parseFBXInWorker(buffer) {
            const worker = ensureFBXWorker();
            if (!worker) throw new Error('worker not available');
            const id = ++fbxWorkerReqId;
            const promise = new Promise((resolve, reject) => {
                fbxWorkerPending.set(id, { resolve, reject });
            });
            worker.postMessage({ id, buffer }, [buffer]);
            const { json, duration } = await promise;
            const loader = new THREE.ObjectLoader();
            const parsed = loader.parse(json);
            if (json.animations?.length) {
                const clips = json.animations.map(THREE.AnimationClip.parse).filter(Boolean);
                if (clips.length) parsed.animations = clips;
            }
            return { obj: parsed, duration: duration || 0 };
        }

        function parseFBXOnMainThread(buffer) {
            const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
            const parsed = fbxLoader.parse(buffer, '');
            const end = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
            if (fbxLoader?.fbxTree) {
                (parsed.userData ||= {}).fbxTree = fbxLoader.fbxTree;
            }
            return { obj: parsed, duration: end - now };
        }

        let pmremGen     = app.pmremGen     = null;      // PMREM generator (lazy)
        let hdrBaseTex   = app.hdrBaseTex   = null;      // original equirect HDR (DataTexture)
        const DEFAULT_ENV_URL = 'exr/forest-01-1024.exr';
        const FALLBACK_HDR_URL = 'https://threejs.org/examples/textures/equirectangular/royal_esplanade_1k.hdr';

        const HDRI_LIBRARY = [
            { name: "Forest EXR (local)", url: DEFAULT_ENV_URL },
            { name: "Royal Esplanade",    url: "https://threejs.org/examples/textures/equirectangular/royal_esplanade_1k.hdr" },
            { name: "Venice Sunset",      url: "https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/venice_sunset_1k.hdr" },
            // { name: "Blouberg Sunrise",   url: "https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/blouberg_sunrise_1k.hdr" },
            // { name: "Tropical Beach",     url: "https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/tropical_beach_1k.hdr" },
            // { name: "Country Field",      url: "https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/country_field_1k.hdr" },
            // { name: "Construction Site",  url: "https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/construction_1k.hdr" },
            { name: "Skyline Rooftop",    url: "https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/roof_garden_1k.hdr" },
            // { name: "City Overpass",      url: "https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/urban_overpass_1k.hdr" },
            // { name: "Forest Trail",       url: "https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/forest_trail_1k.hdr" },
            { name: "Rocky Ridge",        url: "https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/rocky_ridge_1k.hdr" },
            { name: "Mountain Sunset",    url: "https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/mountain_sunset_1k.hdr" },
            // { name: "Industrial Yard",    url: "https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/industrial_pipe_1k.hdr" },
            // { name: "Tokyo Night",        url: "https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/tokyo_neon_1k.hdr" },
            // { name: "Small Hangar",       url: "https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/hangar_1k.hdr" },
            { name: "Studio Small",       url: "https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/studio_small_09_1k.hdr" }
        ];
        let currentEnv   = app.currentEnv   = null;      // pmrem result (for scene.environment)
        let currentBg    = app.currentBg    = null;      // shifted equirect (для фона)
        let currentRotDeg = app.currentRotDeg = 0;        // rotation slider value
        let currentBgTint = new THREE.Color(0xffffff);
        let currentExposure = 1;

        // =====================================================================
        // Asset Loading · Shared State
        // =====================================================================
        /**
         * Все загруженные модели (FBX) в рамках текущей сессии.
         * Храним объект сцены, имя файла и дополнительную мета-информацию.
         * Формат: { obj: THREE.Object3D, name: string, group?, zipKind?, geojson? }
         */
        const loadedModels = app.loadedModels = [];

        /**
         * Список всех изображений, извлечённых из FBX или ZIP (включая embedded).
         * Используется для автопривязки материалов и галереи текстур.
         */
        const allEmbedded  = app.allEmbedded  = [];

        /**
         * Стек для операций «отмены» при ручной привязке текстур.
         * Пока используется только для логирования, но оставляем для будущего undo.
         */
        const undoStack    = app.undoStack    = [];

        const SAMPLE_MODELS = [
            { label: 'Примеры…', files: [] },
            {
                label: 'SH35_LPM (0610_Shabolovka_Vl_35.zip)',
                files: [
                    'https://storage.yandexcloud.net/maragojeep/0610_Shabolovka_Vl_35.zip?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=YCAJENUFHbvNEEcd7Rb00AGxU%2F20250923%2Fru-central1%2Fs3%2Faws4_request&X-Amz-Date=20250923T230730Z&X-Amz-Expires=2592000&X-Amz-Signature=943e5ff00396c1cc7f942e434853be47d68d7a31d6bcd346e6c191b8e6c6d157&X-Amz-SignedHeaders=host'
                ]
            },
            {
                label: 'SH34_LPM (0610_Shabolovka_Vl_34.zip)',
                files: [
                    'https://storage.yandexcloud.net/maragojeep/0610_Shabolovka_Vl_34.zip?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=YCAJENUFHbvNEEcd7Rb00AGxU%2F20250923%2Fru-central1%2Fs3%2Faws4_request&X-Amz-Date=20250923T230545Z&X-Amz-Expires=2592000&X-Amz-Signature=d25d916a2754c41a582a7618cee65834fcfb4931f70f0ba583c625b617c20430&X-Amz-SignedHeaders=host'
                ]
            },
            {
                label: 'SH35_HPM (Ground + Building)',
                files: [
                    'https://storage.yandexcloud.net/maragojeep/SM_Shabolovka_Vl_35.zip?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=YCAJENUFHbvNEEcd7Rb00AGxU%2F20250923%2Fru-central1%2Fs3%2Faws4_request&X-Amz-Date=20250923T230932Z&X-Amz-Expires=2592000&X-Amz-Signature=6419e24698888a213131664bdee893f90b07fd79d5dc46ec3db66bcc5862f6f6&X-Amz-SignedHeaders=host',
                    'https://storage.yandexcloud.net/maragojeep/SM_Shabolovka_Vl_35_Ground.zip?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=YCAJENUFHbvNEEcd7Rb00AGxU%2F20250923%2Fru-central1%2Fs3%2Faws4_request&X-Amz-Date=20250923T231155Z&X-Amz-Expires=2592000&X-Amz-Signature=826ed6e3fb7b07c9ac490396cabac4acbfd284d4c41d3e77786934f10318a7bb&X-Amz-SignedHeaders=host'
                ]
            },
            {
                label: 'SH34_HPM (Ground + Building)',
                files: [
                    'https://storage.yandexcloud.net/maragojeep/SM_Shabolovka_Vl_34.zip?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=YCAJENUFHbvNEEcd7Rb00AGxU%2F20250923%2Fru-central1%2Fs3%2Faws4_request&X-Amz-Date=20250923T230806Z&X-Amz-Expires=2592000&X-Amz-Signature=47cf7ad4a3548de434900644f8de1bedc24facda64553d58c823bab2ff349844&X-Amz-SignedHeaders=host',
                    'https://storage.yandexcloud.net/maragojeep/SM_Shabolovka_Vl_34_Ground.zip?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=YCAJENUFHbvNEEcd7Rb00AGxU%2F20250923%2Fru-central1%2Fs3%2Faws4_request&X-Amz-Date=20250923T230833Z&X-Amz-Expires=2592000&X-Amz-Signature=bdf7d9cb9ca7ede1344ff0b89b59d54768fdaa1ad7810f87136c39f9ec61c017&X-Amz-SignedHeaders=host'
                ]
            }
        ];



        // =====================
        // REBASE
        // =====================      

        function computeAutoOffsetHorizontalOnly() {
            const c = computeAutoOffset(); // центр до ребейза (в текущих координатах world)
            if (isZUp()) {
                // Z — вертикаль → не трогаем Z
                c.z = 0;
            } else {
                // Y — вертикаль → не трогаем Y
                c.y = 0;
            }
            return c;
        }



        // ===== Rebase (origin rebasing)
        let worldOffset = new THREE.Vector3(0,0,0); // абсолютный оффсет сцены (куда была унесена модель)

        // применяем/меняем оффсет (ничего в детях не трогаем)

        function setWorldOffset(offset){
            worldOffset.copy(offset);
            world.position.set(-offset.x, -offset.y, -offset.z);
            world.updateMatrixWorld(true);

            if (bgMesh) bgMesh.position.set(0,0,0);
            dirLight.target.position.set(0,0,0);
            dirLight.target.updateMatrixWorld();

            // ВАЖНО: сетку тут не двигаем!

        }

        // посчитать авто-оффсет по центру всех объектов (в абсолютных координатах ДО сдвига)
        function computeAutoOffset() {
            const box = computeSceneBounds();
            if (box.isEmpty()) return new THREE.Vector3(0,0,0);
            return box.getCenter(new THREE.Vector3());
        }

        // =====================
        // Layout helper
        // =====================
        /** Инвертирует equirectangular HDR по вертикали (для корректного отображения). */
        function flipHDRTextureVertically(srcTex) {
            const { data, width, height } = srcTex.image;
            const channels = 4; // RGBA/RGBE
            const flipped = new (data.constructor)(data.length);

            for (let y = 0; y < height; y++) {
                const srcRow = y * width * channels;
                const dstRow = (height - 1 - y) * width * channels;
                flipped.set(data.subarray(srcRow, srcRow + width * channels), dstRow);
            }

            const tex = new THREE.DataTexture(flipped, width, height, srcTex.format, srcTex.type);
            tex.encoding = srcTex.encoding;
            tex.mapping = THREE.EquirectangularReflectionMapping;
            tex.needsUpdate = true;

            return tex;
        }

        function layout() {
            // 1) measure header height and set CSS var
            const appbar = document.querySelector('.appbar');
            const appH = Math.ceil(appbar?.getBoundingClientRect().height || 48);
            document.body.style.setProperty('--appbarH', appH + 'px');

            // 2) compute canvas size (side panel overlays, so use full width)
            const w = Math.max(1, window.innerWidth);
            const h = Math.max(1, window.innerHeight - appH);
            renderer.setSize(w, h);
            camera.aspect = w / h;
            camera.updateProjectionMatrix();
            requestRender();
        }

        window.addEventListener('resize', layout);
        toggleSideBtn.addEventListener('click', () => { document.body.classList.toggle('side-hidden'); layout(); });
        loadParcelsBtn?.addEventListener('click', () => loadMosParcels({ fetchAll: true, batchSize: 1000, maxRecords: 20000 }));

        function hideSidePanel() {
            if (!document?.body) return;
            if (!document.body.classList.contains('side-hidden')) {
                document.body.classList.add('side-hidden');
                try { layout(); } catch (_) {}
            }
        }

        hideSidePanel();

   

                // ---------------------------------------
                // DEBUG SHADOW PANEL AUTOUPDATE
                // ---------------------------------------
                    let shadowCamHelper = null;
                    let sunHelper = null;

                    /** Создаёт helpers для тюнинга теней (камера + направление). */
                    function ensureShadowHelpers() {
                        if (!shadowCamHelper) {
                            shadowCamHelper = new THREE.CameraHelper(dirLight.shadow.camera);
                            shadowCamHelper.visible = false;
                            shadowCamHelper.userData.excludeFromBounds = true; // не учитываем в bbox/fitAll
                            scene.add(shadowCamHelper);
                        }
                        if (!sunHelper) {
                            sunHelper = new THREE.DirectionalLightHelper(dirLight, 1);
                            sunHelper.visible = false;
                            sunHelper.userData.excludeFromBounds = true;
                            scene.add(sunHelper);
                        }
                    }

                    /** Включает/выключает визуализацию параметров теней. */
                    function setShadowDebug(on) {
                        ensureShadowHelpers();
                        shadowCamHelper.visible = !!on;
                        sunHelper.visible = !!on;
                        shadowCamHelper.update();
                        sunHelper.update();
                    }

                    let shadowAutoFrustum = true;
                    let shadowFrustumScale = 1;

                    /** Подгоняет orthographic frustum для directional light под текущую сцену. */
                    function fitSunShadowToScene(recenterTarget = false, margin = 1.3) {
                        if (!dirLight || !dirLight.shadow || !dirLight.shadow.camera) return;

                        const box = computeSceneBounds();
                        if (box.isEmpty()) return;

                        const scale = Math.max(0.1, shadowFrustumScale || 1);
                        const effectiveMargin = margin * scale;

                        const center = box.getCenter(new THREE.Vector3());
                        const size   = box.getSize(new THREE.Vector3());
                        const radius = size.length() * 0.5 * effectiveMargin;
                        const spanXY = Math.max(size.x, size.y, size.z) * 0.5 * effectiveMargin;

                        // По желанию — один раз «поймать» центр
                        if (recenterTarget) {
                            dirLight.target.position.copy(center);
                            dirLight.target.updateMatrixWorld();
                        }

                        const cam = dirLight.shadow.camera; // OrthographicCamera
                        cam.left = -spanXY;
                        cam.right = spanXY;
                        cam.top = spanXY;
                        cam.bottom = -spanXY;

                        // near/far вокруг текущей геометрии относительно текущего луча
                        const dist = dirLight.position.distanceTo(dirLight.target.position) || (radius * 1.2);
                        cam.near = Math.max(0.1, dist - radius);
                        cam.far  = dist + radius;

                        cam.updateProjectionMatrix();

                        dirLight.shadow.needsUpdate = true;
                        renderer.shadowMap.needsUpdate = true;

                        shadowCamHelper?.update?.();
                        sunHelper?.update?.();
                    }

                // ----------------------------------------------
                // END OF DEBUG SHADDOW PANNEL'S LOGIC AUTOUPDATE
                // ----------------------------------------------

                
        // === Bounds (без гридов/хелперов) ===
        function expandBoxFiltered(box, obj) {
            if (!obj || !obj.visible) return;

            // исключения: помеченные объекты, стандартные хелперы, фон, источники света и точки
            if (obj.userData?.excludeFromBounds) return;
            if (obj.isGridHelper || obj.isAxesHelper || obj.isPolarGridHelper) return;
            if (obj === bgMesh) return;
            if (obj.isLight || obj.isPoints) return;

            // учитываем только геометрию
            if (obj.isMesh && obj.geometry) {
                obj.updateWorldMatrix(true, false);
                if (!obj.geometry.boundingBox) obj.geometry.computeBoundingBox();
                const bb = obj.geometry.boundingBox.clone().applyMatrix4(obj.matrixWorld);
                if (!bb.isEmpty()) box.union(bb);
            }

            for (const c of obj.children) expandBoxFiltered(box, c);
        }

        function computeSceneBounds(root = world) {
            const box = new THREE.Box3();
            expandBoxFiltered(box, root);
            return box;
        }


        function focusOn(targets, pad = 1.4) {
            // targets may be an object or array of objects
            const box = new THREE.Box3();
            const add = (obj) => obj && box.expandByObject(obj);

            if (Array.isArray(targets)) {
                let any = false;
                targets.forEach(o => { if (o) { add(o); any = true; } });
                if (!any) return;
            } else if (targets) {
                add(targets);
            } else return;

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
            const box = computeSceneBounds();
            if (box.isEmpty()) return;
            const size = new THREE.Vector3(), center = new THREE.Vector3();
            box.getSize(size); box.getCenter(center);
            controls.target.copy(center);

            const fov = THREE.MathUtils.degToRad(camera.fov);
            const aspect = renderer.domElement.clientWidth / Math.max(renderer.domElement.clientHeight, 1);
            const max = Math.max(size.x, size.y, size.z);
            const dist = Math.max(max / (2 * Math.tan(fov/2)), (max * aspect) / (2 * Math.tan(fov/2))) * 1.5;

            camera.position.copy(center).add(new THREE.Vector3(1,0.6,1).normalize().multiplyScalar(dist));
            camera.near = Math.max(dist / 1000, 0.01);
            camera.far  = dist * 1000;
            camera.updateProjectionMatrix();
            requestRender();
        }

        function computeWorldCenter() {
            const box = computeSceneBounds();
            if (box.isEmpty()) return new THREE.Vector3(0,0,0);
            return box.getCenter(new THREE.Vector3());
        }

        // =====================
        // HDR / IBL handling
        // =====================
        async function loadEquirectTexture(url) {
            const lower = String(url || '').toLowerCase();
            let tex;
            if (lower.endsWith('.exr')) {
                tex = await new EXRLoader().loadAsync(url);
            } else {
                tex = await new HDRLoader().loadAsync(url);
                tex = flipHDRTextureVertically(tex);
            }
            tex.mapping = THREE.EquirectangularReflectionMapping;
            tex.wrapS = THREE.RepeatWrapping;
            tex.wrapT = THREE.ClampToEdgeWrapping;
            tex.flipY = false;
            if ('flipX' in tex) tex.flipX = false;
            if ('flipZ' in tex) tex.flipZ = false;
            if ('colorSpace' in tex) tex.colorSpace = THREE.LinearSRGBColorSpace;
            tex.needsUpdate = true;
            return tex;
        }

        async function loadHDRBase() {
            if (hdrBaseTex) return hdrBaseTex;
            try {
                hdrBaseTex = await loadEquirectTexture(DEFAULT_ENV_URL);
            } catch (err) {
                console.warn('Default EXR environment failed to load, falling back to HDR.', err);
                hdrBaseTex = await loadEquirectTexture(FALLBACK_HDR_URL);
            }
            app.hdrBaseTex = hdrBaseTex;
            return hdrBaseTex;
        }

        /**
         * Вычисляет высоту и азимут солнца по упрощённой модели (для UI солнца).
         * Возвращает { altitude, azimuth } в радианах.
         */
        function sunPosition(date, lat, lon) {
            const rad = Math.PI / 180;
            const day = Math.floor((date - new Date(date.getFullYear(), 0, 0)) / 86400000);

            const M = (357.5291 + 0.98560028 * day) * rad;
            const L = (280.4665 + 0.98564736 * day) * rad + (1.915 * Math.sin(M) + 0.020 * Math.sin(2*M)) * rad;
            const e = 23.439 * rad;

            const RA = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
            const dec = Math.asin(Math.sin(e) * Math.sin(L));

            const now = date.getUTCHours() + date.getUTCMinutes()/60;
            const lst = (100.46 + 0.985647 * day + lon + 15*now) * rad;
            const H = lst - RA;

            const latRad = lat * rad;
            const alt = Math.asin(Math.sin(latRad) * Math.sin(dec) + Math.cos(latRad) * Math.cos(dec) * Math.cos(H));
            const az = Math.atan2(-Math.sin(H), Math.tan(dec) * Math.cos(latRad) - Math.sin(latRad) * Math.cos(H));

            return { altitude: alt, azimuth: az };
        }

        /** Обновляет направление солнечного света и helpers на основе UI-параметров. */
        function updateSun() {
            if (!dirLight || !dirLight.visible) return;

            const day   = parseInt(sunDayEl.value, 10) || 1;
            const month = parseInt(sunMonthEl.value, 10) || 6;
            const hour  = parseFloat(sunHourEl.value)   || 12;
            const north = parseFloat(sunNorthEl.value)  || 0;

            const date = new Date();
            date.setUTCMonth(month - 1, day);
            date.setUTCHours(hour, 0, 0, 0);

            const { altitude, azimuth } = sunPosition(date, MOSCOW_LAT, MOSCOW_LON);

            // «Север» — это поворот сцены относительно географического севера.
            // Если крутилка в UI ощущается "наоборот", замените +northRad на -northRad.
            const northRad = THREE.MathUtils.degToRad(north) + Math.PI;

            // Единичный вектор направления света (Y — вверх)
            const fullTurn = Math.PI * 2;
            const correctedAzimuth = (fullTurn - ((azimuth % fullTurn) + fullTurn) % fullTurn);
            const angle = correctedAzimuth - northRad;

            const dir = new THREE.Vector3(
                Math.cos(altitude) * Math.sin(angle),
                Math.sin(altitude),
                Math.cos(altitude) * Math.cos(angle)
            ).normalize();
            app.sun.direction = dir.clone();

            // Центр сцены — куда смотрит солнце (таргет оставляем как есть, если он уже на центре)
            const box = computeSceneBounds();
            if (box.isEmpty()) return;
            const center = box.getCenter(new THREE.Vector3());

            // Если таргет не в центре — один раз подвинем (для согласованности с коробкой теней)
            if (!dirLight.target.position.equals(center)) {
                dirLight.target.position.copy(center);
                dirLight.target.updateMatrixWorld();
            }

            // Дистанция — текущая, чтобы ползунки меняли только направление
            const currDist = dirLight.position.distanceTo(dirLight.target.position) || 50;

            dirLight.position.copy(center).add(dir.multiplyScalar(currDist));
            dirLight.updateMatrixWorld();

            // Подгоняем фрустум (НЕ меняем ни target, ни позицию света)
            fitSunShadowToScene(false); // передаём флажок: не ресентрить таргет
            updateNorthPointer();
            requestRender();
        }


        // shift equirectangular map in U direction by a fraction [0..1)
        function shiftEquirectColumns(srcTex, fracU) {
            const img = srcTex.image;
            const w = img.width, h = img.height;
            const data = img.data;
            const channels = Math.max(3, Math.round(data.length / Math.max(1, w * h)) || 4);
            const out = new (data.constructor)(data.length);

            const shift = Math.round(((fracU % 1 + 1) % 1) * w);
            for (let y = 0; y < h; y++) {
                const rowOff = y * w * channels;
                for (let x = 0; x < w; x++) {
                    const sx = (x - shift + w) % w;
                    const si = rowOff + sx * channels;
                    const di = rowOff + x * channels;
                    for (let c = 0; c < channels; c++) {
                        out[di + c] = data[si + c];
                    }
                }
            }

            const tex = new THREE.DataTexture(out, w, h, srcTex.format, srcTex.type);
            tex.encoding = srcTex.encoding;
            tex.mapping = THREE.EquirectangularReflectionMapping;
            tex.wrapS = THREE.RepeatWrapping;
            tex.wrapT = THREE.ClampToEdgeWrapping;
            tex.needsUpdate = true;
            return tex;
        }

        function clampNumericInput(value, min, max) {
            if (!Number.isFinite(value)) return null;
            if (min != null) value = Math.max(min, value);
            if (max != null) value = Math.min(max, value);
            return value;
        }

        function syncEnvAdjustmentsState() {
            const gamma = Math.max(0.01, parseFloat(iblGammaEl?.value) || 1.0);
            const tintHex = (iblTintEl?.value && /^#/u.test(iblTintEl.value)) ? iblTintEl.value : '#ffffff';
            const tintLinear = new THREE.Color(tintHex).convertSRGBToLinear();
            const exposure = clampNumericInput(parseFloat(hdriExposureEl?.value), 0, 2) ?? 1;
            const saturation = clampNumericInput(parseFloat(hdriSaturationEl?.value), 0, 2) ?? 1;
            const blur = clampNumericInput(parseFloat(hdriBlurEl?.value), 0, 1) ?? 0;
            const state = { gamma, tintHex, tintLinear, exposure, saturation, blur };
            app.envAdjustments = state;
            return state;
        }

        function applySimpleBlurToData(data, width, height, stride, amount) {
            if (!(amount > 1e-3)) return;
            const neighborWeight = amount * 0.5;
            const centerWeight = 1;
            const totalWeight = centerWeight + neighborWeight * 4;
            const tmp = new (data.constructor)(data.length);

            const sampleIndex = (x, y) => {
                const sx = (x % width + width) % width;
                const sy = Math.min(height - 1, Math.max(0, y));
                return (sy * width + sx) * stride;
            };

            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    let r = 0, g = 0, b = 0;
                    let weight = 0;

                    const addSample = (ix, iy, w) => {
                        const idx = sampleIndex(ix, iy);
                        r += data[idx] * w;
                        g += data[idx + 1] * w;
                        b += data[idx + 2] * w;
                        weight += w;
                    };

                    addSample(x, y, centerWeight);
                    addSample(x - 1, y, neighborWeight);
                    addSample(x + 1, y, neighborWeight);
                    addSample(x, y - 1, neighborWeight);
                    addSample(x, y + 1, neighborWeight);

                    const outIdx = (y * width + x) * stride;
                    const invW = weight > 0 ? (1 / weight) : 1;
                    tmp[outIdx] = r * invW;
                    tmp[outIdx + 1] = g * invW;
                    tmp[outIdx + 2] = b * invW;

                    for (let s = 3; s < stride; s++) {
                        tmp[outIdx + s] = data[outIdx + s];
                    }
                }
            }
            data.set(tmp);
        }

        function applyHDRAdjustments(dataTex, {
            gamma = 1.0,
            tintColor = null,
            exposure = 1.0,
            saturation = 1.0,
            blur = 0.0,
        } = {}) {
            if (!dataTex?.image?.data) return dataTex;
            const { data, width, height } = dataTex.image;
            if (!width || !height) return dataTex;

            const strideFloat = data.length / Math.max(1, width * height);
            const stride = Number.isFinite(strideFloat) && strideFloat >= 3 ? Math.round(strideFloat) : 3;
            const hasGamma = Math.abs(gamma - 1.0) > 1e-3;
            const hasTint = !!tintColor && (
                Math.abs(tintColor.r - 1) > 1e-3 ||
                Math.abs(tintColor.g - 1) > 1e-3 ||
                Math.abs(tintColor.b - 1) > 1e-3
            );
            const hasExposure = Math.abs(exposure - 1.0) > 1e-3;
            const hasSaturation = Math.abs(saturation - 1.0) > 1e-3;
            const hasBlur = blur > 1e-3;

            if (!hasGamma && !hasTint && !hasExposure && !hasSaturation && !hasBlur) return dataTex;

            const gammaPow = hasGamma ? (1 / gamma) : 1.0;

            for (let i = 0; i < data.length; i += stride) {
                let r = data[i];
                let g = data[i + 1];
                let b = data[i + 2];

                if (hasGamma) {
                    r = Math.pow(Math.max(r, 0), gammaPow);
                    g = Math.pow(Math.max(g, 0), gammaPow);
                    b = Math.pow(Math.max(b, 0), gammaPow);
                }
                if (hasTint) {
                    r *= tintColor.r;
                    g *= tintColor.g;
                    b *= tintColor.b;
                }
                 if (hasExposure) {
                    r *= exposure;
                    g *= exposure;
                    b *= exposure;
                }
                if (hasSaturation) {
                    const lum = r * 0.2126 + g * 0.7152 + b * 0.0722;
                    r = lum + (r - lum) * saturation;
                    g = lum + (g - lum) * saturation;
                    b = lum + (b - lum) * saturation;
                }

                data[i] = r;
                data[i + 1] = g;
                data[i + 2] = b;
            }

            if (hasBlur) {
                applySimpleBlurToData(data, width, height, stride, blur);
            }

            dataTex.needsUpdate = true;
            return dataTex;
        }

        /** Генерирует PMREM из повернутого HDRI и применяет к окружению/фону. */
        async function buildAndApplyEnvFromRotation(deg) {
            currentRotDeg = deg;
            app.currentRotDeg = currentRotDeg;
            if (USE_WEBGPU) {
                try {
                    await rendererInitPromise;
                } catch (err) {
                    console.error('WebGPU init failed before env build', err);
                    return;
                }
            }
            const { gamma, tintLinear, exposure, saturation, blur } = syncEnvAdjustmentsState();
            const frac = ((deg % 360) + 360) % 360 / 360;
            if (bgMesh) {
                bgMesh.rotation.y = THREE.MathUtils.degToRad(deg);
            }

            if (currentEnv) { currentEnv.dispose?.(); currentEnv = null; app.currentEnv = null; }
            if (currentBg && currentBg !== hdrBaseTex) { currentBg.dispose?.(); }
            currentBg = null;
            currentEnv = null;

            const shifted = shiftEquirectColumns(hdrBaseTex, frac);
            applyHDRAdjustments(shifted, { gamma, tintColor: tintLinear, exposure, saturation, blur });
            shifted.mapping = THREE.EquirectangularReflectionMapping;
            if ('colorSpace' in shifted) {
                shifted.colorSpace = THREE.LinearSRGBColorSpace;
            }
            shifted.needsUpdate = true;

            if (USE_WEBGPU) {
                shifted.needsPMREMUpdate = true;
                currentBg = shifted;
                currentEnv = shifted;
                app.currentBg = currentBg;
                app.currentEnv = currentEnv;

                scene.environment = iblChk.checked ? currentEnv : null;
                scene.environmentRotation.set(0, THREE.MathUtils.degToRad(deg), 0);
                scene.backgroundRotation.set(0, THREE.MathUtils.degToRad(deg), 0);
                if (iblChk.checked) {
                    ensureBgMesh();
                    if (bgMesh) {
                        bgMesh.material.map = currentBg;
                        bgMesh.material.needsUpdate = true;
                        bgMesh.visible = true;
                    }
                }
                applyEnvToMaterials(scene.environment, parseFloat(iblIntEl.value));
                return;
            }

            if (!pmremGen) {
                pmremGen = new THREE.PMREMGenerator(renderer);
                app.pmremGen = pmremGen;
            }

            currentBg = shifted;
            app.currentBg = currentBg;
            const rt = pmremGen.fromEquirectangular(shifted);
            currentEnv = rt.texture;
            app.currentEnv = currentEnv;

            scene.environment = iblChk.checked ? currentEnv : null;
            applyEnvToMaterials(scene.environment, parseFloat(iblIntEl.value));
            ensureBgMesh();
            if (bgMesh) {
                bgMesh.material.map = currentBg;
                bgMesh.material.needsUpdate = true;
            }
        }

        /** Включает/выключает окружение (HDRI) и обновляет фон + стекло. */
        async function setEnvironmentEnabled(on) {
            await loadHDRBase();
            if (on) {
                await buildAndApplyEnvFromRotation(currentRotDeg || 0);
            } else {
                scene.environment = null;
                applyEnvToMaterials(null, 1.0);
                if (bgMesh) bgMesh.visible = false;
            }
            updateBgVisibility();
            applyGlassControlsToScene();
        }

        function applyEnvToMaterials(env, intensity) {
            if (USE_WEBGPU && scene) {
                scene.environmentIntensity = intensity;
            }
            world.traverse(o => {
                if (!o.isMesh || !o.material) return;
                const mats = getPanelMaterials(o);
                mats.forEach(m => {
                    if (m.isMeshStandardMaterial || m.isMeshPhysicalMaterial) {
                        m.envMap = env;
                        m.envMapIntensity = intensity;
                        m.needsUpdate = true;
                    }
                });
           });

            requestRender();
        }

        function setStatsVisible(visible) {
            statsVisible = !!visible;
            statsBtn?.classList.toggle('active', statsVisible);
            if (statsOverlayEl) {
                statsOverlayEl.hidden = !statsVisible;
                if (statsVisible) {
                    updateStatsOverlay(true);
                    requestRender();
                }
            }
        }

        function updateStatsOverlay(force = false) {
            if (!statsVisible || !statsOverlayEl) return;
            const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
            if (!force && now - lastStatsUpdate < 250) return;
            lastStatsUpdate = now;

            const info = renderer.info || {};
            const renderInfo = lastRenderStats?.render || info.render || {};
            const mem = lastRenderStats?.memory || info.memory || {};
            const programsRaw = lastRenderStats?.programs ?? info.programs ?? 0;
            const programs = Array.isArray(programsRaw) ? programsRaw.length : programsRaw;
            const formatInt = (value) => (typeof value === 'number' ? value.toLocaleString('ru-RU') : String(value ?? 0));
            const fpsText = fpsEstimate ? Math.round(fpsEstimate).toString() : '—';
            const sceneStats = getSceneGeometryStats();

            const modeLabel = (app.activeRendererMode || 'webgl').toUpperCase();
            const lines = [
                `fps        : ${fpsText}`,
                `draw calls : ${formatInt(renderInfo.drawCalls ?? renderInfo.calls ?? 0)}`,
                `scene tris : ${formatInt(sceneStats.triangles || 0)}`,
            ];
            if (programs) lines.push(`programs   : ${formatInt(programs)}`);

            const html = [`<span class="stats-mode">${(app.activeRendererMode || 'webgl').toUpperCase()}</span>`, ...lines].join('<br>');
            statsOverlayEl.innerHTML = html;
        }

        // helper textures
        let _matcapTex = null;
        let _checkerTex = null;

        function getMatcap() {
            if (_matcapTex) return _matcapTex;
            _matcapTex = texLd.load('https://raw.githubusercontent.com/nidorx/matcaps/1b1e43a338335b6401034d48488298966755d717/1024/2A2A2A_B3B3B3_6D6D6D_848C8C.png');
            return _matcapTex;
        }

        function getChecker() {
            if (_checkerTex) return _checkerTex;
            const S = 256, N = 8;
            const c = document.createElement('canvas'); c.width = c.height = S;
            const g = c.getContext('2d');
            for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
                g.fillStyle = ((x + y) & 1) ? '#bbbbbb' : '#222222';
                g.fillRect(x * S / N, y * S / N, S / N, S / N);
            }
            _checkerTex = new THREE.CanvasTexture(c);
            _checkerTex.wrapS = _checkerTex.wrapT = THREE.RepeatWrapping;
                const maxAniso = renderer.capabilities?.getMaxAnisotropy?.();
                _checkerTex.anisotropy = maxAniso || 1;
            return _checkerTex;
        }

        // =====================================================================
        // Rendering Modes · Points/Beauty Wire helpers
        // =====================================================================

        /** Гарантирует наличие Points-объекта и материала для указанного меша. */
        function ensurePointsForMesh(mesh, size = 3, color = 0x00aaff) {
            if (!mesh.isMesh || !mesh.geometry || !mesh.parent) return null;

            if (!mesh.userData._pointsObj) {
                const pm = new THREE.PointsMaterial({ size, sizeAttenuation: false, color, depthTest: true, depthWrite: false });
                const pts = new THREE.Points(mesh.geometry, pm);
                pts.name = (mesh.name || mesh.type) + ' (points)';
                pts.renderOrder = (mesh.renderOrder || 0) + 1;
                pts.visible = false;

                mesh.parent.add(pts);
                pts.position.copy(mesh.position);
                pts.quaternion.copy(mesh.quaternion);
                pts.scale.copy(mesh.scale);

                mesh.userData._pointsObj = pts;
                mesh.userData._pointsMat = pm;
            } else {
                const pm = mesh.userData._pointsMat;
                if (pm) { pm.size = size; pm.color = new THREE.Color(color); pm.needsUpdate = true; }
            }
            return mesh.userData._pointsObj;
        }

        /** Переключает режим отображения вершин: прячет исходные меши и показывает Points. */
        function setPointsMode(enabled, { size = 0.5, color = 0x666666 } = {}) {
            let changed = false;
            world.traverse(o => {
                if (!o.isMesh) return;
                const pts = ensurePointsForMesh(o, size, color);
                if (!pts) return;
                const prevMeshVisible = o.visible;
                const prevPtsVisible = pts.visible;
                o.visible = !enabled;
                pts.visible = enabled;
                if (prevMeshVisible !== o.visible || prevPtsVisible !== pts.visible) changed = true;
            });
            if (changed) markSceneStatsDirty();
        }

        // ================================
        // Edges (wireframe без диагоналей)
        // ================================

        // === Backface debug (2-pass: front white + back red) ===

        /**
         * Создаёт ShaderMaterial, повторяющий fresnel-подсветку из WebGL-варианта,
         * но без onBeforeCompile, чтобы одинаково работать и в WebGPU, и в WebGL.
         */
        function makeViewAngleShadedBasic(params = {}, { power = 2.0, min = 1.4, max = 2.0, invert = false } = {}) {
            const {
                color = 0xffffff,
                side = THREE.FrontSide,
                transparent = false,
                opacity = 1.0,
                alphaMap = null,
                alphaTest = 0.0,
                depthWrite = true,
                depthTest = true,
                blending = THREE.NormalBlending,
                polygonOffset = false,
                polygonOffsetFactor = 0,
                polygonOffsetUnits = 0,
                skinning = false,
                morphTargets = false,
                morphNormals = false,
                morphColors = false,
                vertexColors = false,
            } = params;

            const baseColor = (params.color && params.color.isColor)
                ? params.color.clone()
                : new THREE.Color(color);

            if (USE_WEBGPU && backfaceNodeSupport) {
                const {
                    MeshBasicNodeMaterial,
                    normalView,
                    positionViewDirection,
                    floatNode,
                    vec3Node,
                } = backfaceNodeSupport;

                try {
                    const nodeParams = {
                        side,
                        transparent,
                        depthWrite,
                        depthTest,
                        blending,
                        polygonOffset,
                        polygonOffsetFactor,
                        polygonOffsetUnits,
                        alphaTest,
                        vertexColors,
                    };
                    if (alphaMap && alphaMap.isTexture) nodeParams.alphaMap = alphaMap;

                    const material = new MeshBasicNodeMaterial(nodeParams);
                    material.name = params.name || 'ViewAngleBackface';
                    material.opacity = opacity;
                    material.toneMapped = false;
                    material.fog = true;
                    material.color.copy(baseColor);
                    material.polygonOffset = polygonOffset;
                    material.polygonOffsetFactor = polygonOffsetFactor;
                    material.polygonOffsetUnits = polygonOffsetUnits;
                    material.vertexColors = !!vertexColors;

                    if (alphaMap && alphaMap.isTexture) {
                        alphaMap.colorSpace = THREE.LinearSRGBColorSpace;
                        material.alphaMap = alphaMap;
                    }

                    const normalNode = normalView.normalize();
                    const viewDirNode = positionViewDirection;
                    const ndv = normalNode.dot(viewDirNode).abs().clamp();
                    const fresBase = floatNode(1.0).sub(ndv).max(floatNode(1e-5));
                    const fres = fresBase.pow(floatNode(power));
                    const tNode = invert ? floatNode(1.0).sub(fres) : fres;
                    const fresFactor = floatNode(min).mix(floatNode(max), tNode.clamp());
                    const colorNode = vec3Node(baseColor.r, baseColor.g, baseColor.b).mul(fresFactor);

                    material.colorNode = colorNode;
                    material.opacityNode = floatNode(opacity);
                    material.needsUpdate = true;
                    return material;
                } catch (err) {
                    console.warn('Backface node material build failed', err);
                }
            }

            if (USE_WEBGPU) {
                const mat = new THREE.MeshBasicMaterial({
                    color: baseColor,
                    side,
                    transparent,
                    opacity,
                    alphaMap,
                    alphaTest,
                    depthWrite,
                    depthTest,
                    blending,
                });
                mat.polygonOffset = polygonOffset;
                mat.polygonOffsetFactor = polygonOffsetFactor;
                mat.polygonOffsetUnits = polygonOffsetUnits;
                mat.skinning = !!skinning;
                mat.morphTargets = !!morphTargets;
                mat.morphNormals = !!morphNormals;
                mat.morphColors = !!morphColors;
                mat.vertexColors = !!vertexColors;
                mat.needsUpdate = true;
                return mat;
            }

            const baseLib = THREE.ShaderLib?.basic;
            if (!baseLib) {
                console.warn('ShaderLib.basic отсутствует, backface fallback');
                return new THREE.MeshBasicMaterial({
                    color: baseColor,
                    side,
                    transparent,
                    opacity,
                    alphaMap,
                    alphaTest,
                    depthWrite,
                    depthTest,
                    blending,
                });
            }
            const uniforms = THREE.UniformsUtils.clone(baseLib.uniforms);

            uniforms.diffuse.value.copy(baseColor);
            uniforms.opacity.value = opacity;
            uniforms.uPower = { value: power };
            uniforms.uMin = { value: min };
            uniforms.uMax = { value: max };
            uniforms.uInvert = { value: invert ? 1 : 0 };

            if (alphaMap && alphaMap.isTexture) {
                uniforms.alphaMap.value = alphaMap;
                alphaMap.colorSpace = THREE.LinearSRGBColorSpace;
                if (alphaMap.matrix) {
                    uniforms.alphaMapTransform.value.copy(alphaMap.matrix);
                }
            }

            const vertexShader = baseLib.vertexShader
                .replace(
                    '#include <fog_pars_vertex>',
                    '#include <fog_pars_vertex>\nvarying vec3 vViewDir;\nvarying vec3 vPosView;'
                )
                .replace(
                    '#include <project_vertex>',
                    '#include <project_vertex>\n\tvViewDir = -mvPosition.xyz;\n\tvPosView = mvPosition.xyz;'
                );

            const fragmentShader = baseLib.fragmentShader
                .replace(
                    'uniform float opacity;',
                    'uniform float opacity;\nuniform float uPower;\nuniform float uMin;\nuniform float uMax;\nuniform int uInvert;\nvarying vec3 vViewDir;\nvarying vec3 vPosView;'
                )
                .replace(
                    'vec4 diffuseColor = vec4( diffuse, opacity );',
                    `vec4 diffuseColor = vec4( diffuse, opacity );
    vec3 viewDir = normalize( vViewDir );
    vec3 normalDir = normalize( cross( dFdx( vPosView ), dFdy( vPosView ) ) );
    normalDir *= ( gl_FrontFacing ? 1.0 : -1.0 );
    float ndv = clamp( abs( dot( normalDir, viewDir ) ), 0.0, 1.0 );
    float fres = pow( max( 1.0 - ndv, 1e-5 ), uPower );
    float t = ( uInvert == 1 ) ? ( 1.0 - fres ) : fres;
    float fresFactor = mix( uMin, uMax, clamp( t, 0.0, 1.0 ) );
    diffuseColor.rgb *= fresFactor;`
                );

            const material = new THREE.ShaderMaterial({
                uniforms,
                vertexShader,
                fragmentShader,
                side,
                transparent,
                depthWrite,
                depthTest,
                blending,
            });

            if (alphaMap && alphaMap.isTexture) {
                material.defines = {
                    ...(material.defines || {}),
                    USE_ALPHAMAP: '',
                    USE_UV: '',
                    ALPHAMAP_UV: 'vUv',
                };
            }

            material.extensions = { ...(material.extensions || {}), derivatives: true };
            material.name = params.name || 'ViewAngleBackface';
            material.alphaTest = alphaTest;
            material.toneMapped = false;
            material.fog = true;
            material.polygonOffset = polygonOffset;
            material.polygonOffsetFactor = polygonOffsetFactor;
            material.polygonOffsetUnits = polygonOffsetUnits;
            material.skinning = !!skinning;
            material.morphTargets = !!morphTargets;
            material.morphNormals = !!morphNormals;
            material.morphColors = !!morphColors;
            material.vertexColors = !!vertexColors;
            material.uniformsNeedUpdate = true;
            material.needsUpdate = true;

            return material;
        }

        function ensureBackfaceOverlay(mesh, origMat) {
        if (!mesh.isMesh || !mesh.geometry) return;
        if (mesh.userData._isBackfaceOverlay) return;
        if (!origMat) origMat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;

        if (!mesh.userData._origMaterial) mesh.userData._origMaterial = mesh.material;

        // Общие параметры (уважаем альфу исходника)
        const baseParams = {
            transparent: !!(origMat.transparent || origMat.alphaMap),
            opacity: origMat.opacity ?? 1,
            alphaMap: origMat.alphaMap || null,
            alphaTest: (origMat.alphaMap ? (origMat.alphaTest ?? 0.5) : (origMat.alphaTest ?? 0.0)),
            depthWrite: origMat.depthWrite ?? true,
            depthTest: origMat.depthTest ?? true,
            blending: origMat.blending ?? THREE.NormalBlending,
            polygonOffset: !!origMat.polygonOffset,
            polygonOffsetFactor: origMat.polygonOffsetFactor ?? 0,
            polygonOffsetUnits: origMat.polygonOffsetUnits ?? 0,
            skinning: !!origMat.skinning,
            morphTargets: !!origMat.morphTargets,
            morphNormals: !!origMat.morphNormals,
            morphColors: !!origMat.morphColors,
            vertexColors: !!origMat.vertexColors,
        };

        // FRONT: белый + угловое затенение (рим-подсветка к краям)
        if (!mesh.userData._bfFront) {
            const front = makeViewAngleShadedBasic(
            { ...baseParams, side: THREE.FrontSide, color: 0xffffff },
            { power: 1.2, min: 0.55, max: 1.2, invert: true} // ярче на гранях
            );
            mesh.userData._bfFront = front;
        }

        // BACK: красный + тоже угловое (можно чуть сильнее)
        if (!mesh.userData._bfBack) {
            const back = makeViewAngleShadedBasic(
            { ...baseParams, side: THREE.BackSide, color: 0xff3333 },
            { power: 1.2, min: 0.55, max: 1.0, invert: false }
            );
            mesh.userData._bfBack = back;
        }

        // применяем
        mesh.material = mesh.userData._bfFront;

        if (!mesh.userData._bfChild) {
            const child = new THREE.Mesh(mesh.geometry, mesh.userData._bfBack);
            child.renderOrder = (mesh.renderOrder || 0);
            child.userData.excludeFromBounds = true;
            child.userData._isBackfaceOverlay = true;
            mesh.add(child);
            mesh.userData._bfChild = child;
        } else {
            mesh.userData._bfChild.visible = true;
        }
        }

        function removeBackfaceOverlay(mesh) {
        if (!mesh.isMesh) return;
        if (mesh.userData._isBackfaceOverlay) return; // служебный — пропускаем
        // вернуть оригинальный материал
        if (mesh.userData._origMaterial) {
            mesh.material = mesh.userData._origMaterial;
        }
        // убрать/спрятать ребёнка
        if (mesh.userData._bfChild) {
            if (mesh.userData._bfChild.parent) mesh.userData._bfChild.parent.remove(mesh.userData._bfChild);
            mesh.userData._bfChild = null;
        }
        // кэшированные материалы оставим (переиспользуем при повторном включении)
        }

        function setBackfaceMode(on) {
        // Сначала собираем список целевых мешей (не служебных), чтобы
        // не модифицировать дерево прямо во время обхода
        const targets = [];
        world.traverse(o => {
            if (!o.isMesh) return;
            if (o.userData?._isBackfaceOverlay) return;
            targets.push(o);
        });

        if (on) {
            targets.forEach(m => {
                if (m.userData?.isCollision) return;
                ensureBackfaceOverlay(m, Array.isArray(m.material) ? m.material[0] : m.material);
            });
        } else {
            targets.forEach(removeBackfaceOverlay);
        }
        }






        // === Beauty wire helpers ===
const BEAUTY_WIRE_ANGLE_DEG = 25;   // угол между нормалями, > исключит мягкие рёбра/диагонали
const BEAUTY_WIRE_COLOR     = 0x111111;
const BEAUTY_WIRE_OPACITY   = 0.9;

/** Готовит красочную обводку (beauty wire) для заданного меша. */
function ensureBeautyWire(mesh, angleDeg = BEAUTY_WIRE_ANGLE_DEG) {
    if (!mesh.isMesh || !mesh.geometry) return null;

    // базовая подложка — нейтральный matcap, слегка "утопим" полигоны, чтоб не мерцали с линиями
    if (!mesh.userData._origMaterial) mesh.userData._origMaterial = mesh.material;

    if (!mesh.userData._beautyBase) {
        const base = new THREE.MeshMatcapMaterial({
            color: 0xffffff,
            matcap: getMatcap(), // у тебя уже есть getMatcap()
            polygonOffset: true,
            polygonOffsetFactor: 1,
            polygonOffsetUnits: 1
        });
        mesh.userData._beautyBase = base;
    }

    // линии рёбер
    let line = mesh.userData._beautyWire;
    if (!line) {
        const edges = new THREE.EdgesGeometry(mesh.geometry, angleDeg);
        const mat   = new THREE.LineBasicMaterial({ color: BEAUTY_WIRE_COLOR, transparent: true, opacity: BEAUTY_WIRE_OPACITY });
        line = new THREE.LineSegments(edges, mat);
        line.name = (mesh.name || mesh.type) + ' (beautywire)';
        line.renderOrder = (mesh.renderOrder || 0) + 1;
        line.userData.excludeFromBounds = true; // не влияeт на fit/shadows
        mesh.add(line);
        mesh.userData._beautyWire = line;
        line.userData._angle = angleDeg;
    } else if (line.userData._angle !== angleDeg) {
        // обновим геометрию при смене угла
        line.geometry?.dispose?.();
        line.geometry = new THREE.EdgesGeometry(mesh.geometry, angleDeg);
        line.userData._angle = angleDeg;
    }

    // применить базовый материал подложки
    mesh.material = mesh.userData._beautyBase;
    line.visible = true;
    return line;
}

/** Возвращает меш из режима beauty wire к исходному материалу. */
function clearBeautyWire(mesh) {
    if (!mesh.isMesh) return;
    // вернуть исходный материал
    if (mesh.userData._origMaterial) {
        mesh.material = mesh.userData._origMaterial;
    }
    // скрыть (или удалить) линии
    if (mesh.userData._beautyWire) {
        mesh.userData._beautyWire.visible = false; // мягко: прячем
        // если хочется удалять:
        // mesh.remove(mesh.userData._beautyWire);
        // mesh.userData._beautyWire.geometry?.dispose?.();
        // mesh.userData._beautyWire.material?.dispose?.();
        // delete mesh.userData._beautyWire;
    }
    // подложку можно оставить кешированной
}
        // =====================
        // Shading modes
        // =====================

        /**
         * Возвращает материал-вариант для режима отображения.
         * В режиме PBR возвращаем исходный материал, в остальных — создаём clone подходящего типа.
         */
        function makeVariantFrom(orig, mode) {
            // Общие параметры, включая поддержку альфа
            const common = {

                side: THREE.FrontSide,
                transparent: orig.transparent || !!orig.alphaMap,
                alphaTest: 0.3,
                // depthWrite: false,
                opacity: orig.opacity ?? 1,
                alphaMap: orig.alphaMap || null
            };

            const color = (orig.color && orig.color.isColor)
                ? orig.color.clone()
                : new THREE.Color(0xffffff);

            const map = orig.map || null;

            switch (mode) {
                case 'lambert':
                    return new THREE.MeshLambertMaterial({ ...common, color, map });

                case 'phong':
                    return new THREE.MeshPhongMaterial({
                        ...common,
                        color,
                        map,
                        shininess: 50,
                        specular: new THREE.Color(0x111111)
                    });

                case 'toon':
                    return new THREE.MeshToonMaterial({ ...common, color, map });

                case 'normal':
                    // у NormalMaterial нет alphaMap, но можно сохранить прозрачность
                    return new THREE.MeshNormalMaterial({
                        side: common.side,
                        transparent: common.transparent,
                        opacity: common.opacity,
                        flatShading: false
                    });

                case 'basic':
                    return new THREE.MeshBasicMaterial({
                        ...common,
                        color: map ? 0xffffff : color,
                        map
                    });

                case 'wire':
                    return new THREE.MeshBasicMaterial({
                        ...common,
                        color: 0x666666,
                        wireframe: true,
                        transparent: true,
                        opacity: 0.3,
                    });

                

                case 'matcap':
                    return new THREE.MeshMatcapMaterial({
                        ...common,
                        color: 0xffffff,
                        matcap: getMatcap()
                    });

                case 'xray':
                    return new THREE.MeshBasicMaterial({
                        ...common,
                        color: 0x8844ff,
                        transparent: true,
                        opacity: 0.5,
                        depthWrite: false
                    });

                case 'uv':
                    return new THREE.MeshBasicMaterial({
                        ...common,
                        color: 0xffffff,
                        map: getChecker()
                    });

                case 'depth':
                    return new THREE.MeshDepthMaterial({
                        depthPacking: THREE.RGBADepthPacking
                        // alphaMap тут не поддерживается
                    });

                case 'vcol':
                    return new THREE.MeshBasicMaterial({
                        ...common,
                        vertexColors: true
                    });

                case 'roughOnly': {
                    const tex = orig.roughnessMap || null;
                    if (tex) return new THREE.MeshBasicMaterial({ ...common, color: 0xffffff, map: tex });
                    const v = Math.max(0, Math.min(1, Number(orig.roughness ?? 0.5)));
                    const c = new THREE.Color().setScalar(v);
                    return new THREE.MeshBasicMaterial({ ...common, color: c });
                }

                case 'metalOnly': {
                    const tex = orig.metalnessMap || null;
                    if (tex) return new THREE.MeshBasicMaterial({ ...common, color: 0xffffff, map: tex });
                    const v = Math.max(0, Math.min(1, Number(orig.metalness ?? 0.0)));
                    const c = new THREE.Color().setScalar(v);
                    return new THREE.MeshBasicMaterial({ ...common, color: c });
                }

                default:
                    return orig; // режим PBR оставляем без изменений


            }
        }

        /**
         * Главный переключатель режимов шейдинга. Кэширует исходные материалы (для PBR),
         * управляет режимами точек/beauty wire и обновляет панель материалов.
         */
        function applyShading(mode, afterRender) {
            currentShadingMode = mode;
            let panelScheduled = false;
            const scheduleOnce = () => {
                if (panelScheduled) return;
                schedulePanelRefresh(afterRender);
                panelScheduled = true;
                afterRender = undefined;
            };

            // выключаем точки, если были
            if (mode !== 'points') setPointsMode(false);

            // backface — отдельный режим (двухпроходный), его не делаем через makeVariantFrom
            if (mode === 'backface') {
                setPointsMode(false);
                setBackfaceMode(true);
                requestRender();
                scheduleOnce();
                return;
            } else {
                // выходим из backface при любом другом режиме
                setBackfaceMode(false);
            }

            if (mode === 'points') {
                setPointsMode(true, { size: 3, color: 0x00aaff });
                return;
            } else {
                setPointsMode(false);
            }
                if (mode === 'beautywire') {
                    // включаем beautywire у всех мешей
                    world.traverse(o => {
                        if (o.userData?.isCollision) return; // не переписывать материал коллизий
                        if (!o.isMesh) return;
                        ensureBeautyWire(o, BEAUTY_WIRE_ANGLE_DEG);
                    });
                    scheduleOnce();
                    return;
                } else {
                    // выходим из beautywire, если он был включён
                    world.traverse(o => { if (o.isMesh) clearBeautyWire(o); });
                }
            world.traverse(obj => {
                if (obj.userData?.isCollision) return; // не переписывать материал коллизий
                if (!obj.isMesh || !obj.material) return;
                if (!obj.userData._origMaterial) obj.userData._origMaterial = obj.material;
                const origArray = Array.isArray(obj.userData._origMaterial) ? obj.userData._origMaterial : [obj.userData._origMaterial];
                if (mode === 'pbr') {
                    obj.material = obj.userData._origMaterial;
                } else {
                    const variants = origArray.map(m => makeVariantFrom(m, mode));
                    obj.material = variants.length === 1 ? variants[0] : variants;
                }
            });

            if (mode === 'pbr') {
                applyEnvToMaterials(scene.environment, parseFloat(iblIntEl.value));
                applyGlassControlsToScene();
            }
            requestRender();
            scheduleOnce();
        }

        shadingSel.addEventListener('change', () => applyShading(shadingSel.value));

        // =====================
        // Objects visibility
        // =====================


        function handleEyeToggle(el) {
            const uuid = el.dataset.uuid;
            const matIndexAttr = el.dataset.matIndex;
            const matIndex = matIndexAttr !== undefined ? Number(matIndexAttr) : null;
            if (uuid) {
                toggleObjectVisibility(uuid, Number.isNaN(matIndex) ? null : matIndex);
                return;
            }
            const id = el.dataset.target;
            toggleVisibilityById(id, el);
        }

        function setEyeIcon(el, visible) {
            if (!el) return;
            const iconOn = el.dataset.iconOn || '👁';
            const iconOff = el.dataset.iconOff || '🚫';
            el.textContent = visible ? iconOn : iconOff;
        }

        function updateEyeButtonsForTarget(target, visible) {
            if (!outEl) return;
            outEl.querySelectorAll(`.eye[data-target="${target}"]`).forEach(btn => setEyeIcon(btn, visible));
        }

        function setMeshAndMaterialsVisibility(target, visible) {
            const materials = Array.isArray(target.material) ? target.material : [target.material];
            let changed = false;
            materials.forEach(mat => {
                if (!mat) return;
                if (mat.visible !== visible) {
                    mat.visible = visible;
                    changed = true;
                }
            });
            if (target.visible !== visible) {
                target.visible = visible;
                changed = true;
            }
            if (changed) markSceneStatsDirty();
            requestRender();
        }

        function updateMeshVisibilityFromMaterials(target) {
            const materials = Array.isArray(target.material) ? target.material : [target.material];
            const anyVisible = materials.some(mat => mat ? mat.visible !== false : false);
            if (target.visible !== anyVisible) {
                target.visible = anyVisible;
                markSceneStatsDirty();
            }
        }

        function toggleObjectVisibility(uuid, matIndex = null) {
            const target = world.getObjectByProperty('uuid', uuid);
            if (!target) return;

            if (matIndex !== null && Array.isArray(target.material)) {
                const materials = target.material;
                const mat = materials[matIndex];
                if (!mat) return;
                const nextVisible = !(mat.visible !== false);
                if (mat.visible !== nextVisible) {
                    mat.visible = nextVisible;
                    markSceneStatsDirty();
                }
                if ('needsUpdate' in mat) mat.needsUpdate = true;
                updateMeshVisibilityFromMaterials(target);
                requestRender();
                syncEyeIconsForObject(uuid, nextVisible, matIndex);
                return;
            }

            const nextVisible = !target.visible;
            setMeshAndMaterialsVisibility(target, nextVisible);
            syncEyeIconsForObject(uuid, nextVisible);
        }

        function syncEyeIconsForObject(uuid, visible, matIndex = null) {
            if (!outEl) return;
            const baseSelector = `.eye[data-uuid="${uuid}"]`;
            if (matIndex !== null) {
                outEl.querySelectorAll(`${baseSelector}[data-mat-index="${matIndex}"]`).forEach(icon => {
                    setEyeIcon(icon, visible);
                });
                const mesh = world.getObjectByProperty('uuid', uuid);
                if (mesh) {
                    const meshVisible = mesh.visible !== false;
                    outEl.querySelectorAll(`${baseSelector}:not([data-mat-index])`).forEach(icon => {
                        setEyeIcon(icon, meshVisible);
                    });
                }
                return;
            }
            outEl.querySelectorAll(baseSelector).forEach(icon => {
                setEyeIcon(icon, visible);
            });
        }

        function toggleVisibilityById(id, el) {
        // Группа: id формата "group|<zipName>"
            if (id.startsWith('group|')) {
                const groupName = id.slice(6);
                const items = loadedModels.filter(m => m.group === groupName);
                if (!items.length) return;

                // если в группе есть что-то видимое — скрываем всё; иначе показываем всё
                const anyVisible = items.some(m => m.obj.visible !== false);
                const newVisible = !anyVisible;
                items.forEach(m => {
                    if (!m?.obj) return;
                    setMeshAndMaterialsVisibility(m.obj, newVisible);
                    syncEyeIconsForObject(m.obj.uuid, newVisible);
                });
                updateEyeButtonsForTarget(id, newVisible);
                return;
            }

            if (id.startsWith('zipcoll|')) {
                const groupName = id.slice(8);
                const items = loadedModels.filter(m => m.group === groupName);
                if (!items.length) { updateEyeButtonsForTarget(id, true); return; }

                const allColl = [];
                const perFileIds = new Map();
                items.forEach(m => {
                    if (!m?.obj) return;
                    const perId = `colgrp|${m.obj.uuid}`;
                    const list = [];
                    m.obj.traverse(o => {
                        if (o.isMesh && o.userData?.isCollision) {
                            allColl.push(o);
                            list.push(o);
                        }
                    });
                    if (list.length) perFileIds.set(perId, list);
                });

                if (!allColl.length) { updateEyeButtonsForTarget(id, true); return; }

                const anyVisible = allColl.some(o => o.visible !== false);
                const newVis = !anyVisible;
                allColl.forEach(o => {
                    setMeshAndMaterialsVisibility(o, newVis);
                    syncEyeIconsForObject(o.uuid, newVis);
                });
                perFileIds.forEach((_, perId) => updateEyeButtonsForTarget(perId, newVis));
                updateEyeButtonsForTarget(id, newVis);
                return;
            }

            // Группа коллизий внутри конкретного FBX
            if (id.startsWith('colgrp|')) {
                const fileUuid = id.slice(7);
                let root = null;
                world.traverse(o => { if (!root && o.uuid === fileUuid) root = o; });
                if (!root) return;
                const coll = [];
                root.traverse(o => { if (o.isMesh && o.userData?.isCollision) coll.push(o); });
                const anyVisible = coll.some(o => o.visible !== false);
                const newVis = !anyVisible;
                coll.forEach(o => {
                    setMeshAndMaterialsVisibility(o, newVis);
                    syncEyeIconsForObject(o.uuid, newVis);
                });
                updateEyeButtonsForTarget(id, newVis);

                const hostModel = loadedModels.find(m => m.obj?.uuid === fileUuid);
                if (hostModel?.group) {
                    const groupName = hostModel.group;
                    let groupHasAny = false;
                    let groupHasVisible = false;
                    loadedModels.forEach(m => {
                        if (m.group !== groupName || !m.obj) return;
                        m.obj.traverse(o => {
                            if (!o.isMesh || !o.userData?.isCollision) return;
                            groupHasAny = true;
                            if (o.visible !== false) groupHasVisible = true;
                        });
                    });
                    if (groupHasAny) updateEyeButtonsForTarget(`zipcoll|${groupName}`, groupHasVisible);
                }
                return;
            }

            // Обычный объект: ищем по userData._panelId
            let target = null;
            world.traverse(o => { if ((o.userData?._panelId) === id) target = o; });
            if (!target) return;

            if (target.userData?._panelKind === 'file-root') {
                const renderables = [];
                target.traverse(o => {
                    if (o === target) return;
                    if (o.userData?.isCollision) return;
                    if (o.isMesh || o.isLine || o.isPoints) renderables.push(o);
                });
                if (!renderables.length) {
                    setEyeIcon(el, true);
                    return;
                }
                const anyVisible = renderables.some(o => o.visible !== false);
                const newVisible = !anyVisible;
                renderables.forEach(o => {
                    setMeshAndMaterialsVisibility(o, newVisible);
                    syncEyeIconsForObject(o.uuid, newVisible);
                });
                setEyeIcon(el, newVisible);
                return;
            }

            const nextVisible = !target.visible;
            setMeshAndMaterialsVisibility(target, nextVisible);
            syncEyeIconsForObject(target.uuid, nextVisible);
            setEyeIcon(el, nextVisible);
        }


        // =====================
        // Background sphere helpers
        // =====================
        function ensureBgMesh() {
            if (bgMesh) return bgMesh;
            const geo = new THREE.SphereGeometry(100000, 64, 32);
            const mat = new THREE.MeshBasicMaterial({
                map: null, side: THREE.BackSide, depthWrite: false, toneMapped: false,
                transparent: true, opacity: parseFloat(bgAlphaEl.value || '1')
            });
            bgMesh = new THREE.Mesh(geo, mat);
            app.bgMesh = bgMesh;
            bgMesh.userData.excludeFromBounds = true;   // ⬅️ добавь
            scene.add(camera);      // гарантируем, что камера в сцене
            camera.add(bgMesh);     // фон “следует” за камерой
            bgMesh.position.set(0,0,0);
            return bgMesh;
        }

        function updateBgVisibility() {
            if (!bgMesh) return;
            bgMesh.visible = !!iblChk.checked;
            bgMesh.material.opacity = parseFloat(bgAlphaEl.value || '1');
            bgMesh.material.transparent = bgMesh.material.opacity < 0.999;
            bgMesh.material.needsUpdate = true;
            requestRender();
        }

        // Привязываем обработчики ghliodon
        [sunHourEl, sunDayEl, sunMonthEl, sunNorthEl].forEach(el =>
            el.addEventListener('input', updateSun)
        );
        updateSun();


        syncEnvAdjustmentsState();

        const formatSunHour = (value) => {
            const totalMinutes = Math.round(value * 60);
            const hours = Math.floor(totalMinutes / 60) % 24;
            const minutes = totalMinutes % 60;
            return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
        };

        const formatSunIntensity = (value) => value.toFixed(1);


        const parseSunHour = (text) => {
            const match = /^\s*(\d{1,2})\s*[:.]\s*(\d{1,2})\s*$/u.exec(text);
            if (!match) return null;
            let hours = parseInt(match[1], 10);
            let minutes = parseInt(match[2], 10);
            if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
            minutes = Math.max(0, Math.min(59, minutes));
            hours = Math.max(0, Math.min(23, hours));
            return hours + minutes / 60;
        };

        if (statsBtn) {
            statsBtn.addEventListener('click', () => setStatsVisible(!statsVisible));
        }
        setStatsVisible(true);

        iblChk?.addEventListener('change', () => setEnvironmentEnabled(iblChk.checked));
        iblIntEl?.addEventListener('input', () => {
            if (iblChk?.checked) applyEnvToMaterials(scene.environment, parseFloat(iblIntEl.value));
        });
        const rebuildEnvOnAdjustments = async () => {
            syncEnvAdjustmentsState();
            if (!iblChk?.checked) return;
            await loadHDRBase();
            await buildAndApplyEnvFromRotation(parseFloat(iblRotEl?.value) || 0);
        };
        iblGammaEl?.addEventListener('input', rebuildEnvOnAdjustments);
        iblTintEl?.addEventListener('input', rebuildEnvOnAdjustments);
        hdriExposureEl?.addEventListener('input', rebuildEnvOnAdjustments);
        hdriSaturationEl?.addEventListener('input', rebuildEnvOnAdjustments);
        hdriBlurEl?.addEventListener('input', rebuildEnvOnAdjustments);
        iblRotEl?.addEventListener('input', async () => {
            if (!iblChk?.checked) return;
            await loadHDRBase();
            await buildAndApplyEnvFromRotation(parseFloat(iblRotEl?.value) || 0);
        });
        hdriPresetSel?.addEventListener('change', async (e) => {
            const idx = parseInt(e.target.value, 10);
            if (isNaN(idx)) return;
            const entry = HDRI_LIBRARY[idx];
            if (!entry) return;

            hdrBaseTex = await loadEquirectTexture(entry.url);
            app.hdrBaseTex = hdrBaseTex;

            await buildAndApplyEnvFromRotation(parseFloat(iblRotEl?.value) || 0);
            ensureBgMesh();
            bgMesh.material.map = currentBg;
            bgMesh.material.needsUpdate = true;
        });
        // =====================
        // Axis toggle
        // =====================

        // =====================
        // Utilities
        // =====================

        let showLightHelpers = false;
        let importedLightsEnabled = false;
        const LIGHT_HELPER_COLOR = 0xffc107;
        const LIGHT_DIR_TMP = new THREE.Vector3();
        const LIGHT_WORLD_POS = new THREE.Vector3();
        const LIGHT_WORLD_QUAT = new THREE.Quaternion();
        const TARGET_WORLD_POS = new THREE.Vector3();
        const TEMP_BOX = new THREE.Box3();
        const TEMP_SIZE = new THREE.Vector3();

        function disableShadowsOnImportedLights(root){
            let shadowsOff = 0;
            let intensityOff = 0;
            let hidden = 0;

            root.traverse(o => {
                if (!o?.isLight) return;
                if (!o.userData) o.userData = {};

                if ('castShadow' in o && o.castShadow) {
                    o.castShadow = false;
                    shadowsOff++;
                }

                if ('intensity' in o && o.intensity !== 0) {
                    if (o.userData._origIntensity === undefined) {
                        o.userData._origIntensity = o.intensity;
                    }
                    o.intensity = 0;
                    intensityOff++;
                }

                if ('power' in o && o.power !== 0) {
                    if (o.userData._origPower === undefined) {
                        o.userData._origPower = o.power;
                    }
                    o.power = 0;
                }

                if (o.visible) {
                    if (o.userData._origVisible === undefined) {
                        o.userData._origVisible = true;
                    }
                    o.visible = false;
                    hidden++;
                }
            });

            if ((shadowsOff || intensityOff || hidden) && typeof logBind === 'function') {
                const parts = [];
                if (shadowsOff) parts.push(`тени → ${shadowsOff}`);
                if (intensityOff) parts.push(`intensity=0 → ${intensityOff}`);
                if (hidden) parts.push(`hidden → ${hidden}`);
                logBind(`Lights: ${parts.join(', ')}`, 'info');
            }
        }

        function restoreLightTargetsFromOrientation(root) {
            if (!root) return;

            root.updateMatrixWorld(true);

            TEMP_BOX.setFromObject(root);
            const sceneDiag = TEMP_BOX.getSize(TEMP_SIZE).length();
            const defaultDistance = Number.isFinite(sceneDiag) && sceneDiag > 0.0001
                ? THREE.MathUtils.clamp(sceneDiag * 0.25, 5, 500)
                : 25;

            root.traverse(light => {
                if (!light?.isLight) return;
                const isDirectional = !!light.isDirectionalLight;
                const isSpot = !!light.isSpotLight;
                if (!isDirectional && !isSpot) return;

                const target = light.target || (light.target = new THREE.Object3D());
                const host = target.parent || root;
                if (target.parent !== host) host.add(target);
                host.updateMatrixWorld(true);

                light.getWorldPosition(LIGHT_WORLD_POS);
                light.getWorldQuaternion(LIGHT_WORLD_QUAT);

                LIGHT_DIR_TMP.set(0, -1, 0).applyQuaternion(LIGHT_WORLD_QUAT).normalize();

                let length = isDirectional ? defaultDistance : light.distance;
                if (!Number.isFinite(length) || length <= 0.01) length = defaultDistance;

                TARGET_WORLD_POS.copy(LIGHT_WORLD_POS).addScaledVector(LIGHT_DIR_TMP, length);

                host.worldToLocal(TARGET_WORLD_POS);
                target.position.copy(TARGET_WORLD_POS);
                target.updateMatrixWorld(true);

                if (light.isSpotLight) {
                    light.translateY(-1);
                    light.updateMatrix();
                    light.updateMatrixWorld(true);
                }
            });
        }

        function ensureLightHelpers(root) {
            if (!root) return;

            const box = new THREE.Box3();
            const sizeVec = new THREE.Vector3();
            box.setFromObject(root);
            const diag = box.getSize(sizeVec).length() || 1;
            const baseSize = THREE.MathUtils.clamp(diag * 0.02, 0.25, 10);

            root.updateMatrixWorld(true);

            root.traverse(o => {
                if (!o?.isLight) return;

                let helper = o.userData?._lightHelper || null;
                if (!helper || !helper.parent) {
                    helper = null;
                    if (o.isDirectionalLight) {
                        helper = new THREE.DirectionalLightHelper(o, baseSize, LIGHT_HELPER_COLOR);
                    } else if (o.isPointLight) {
                        helper = new THREE.PointLightHelper(o, baseSize * 0.35, LIGHT_HELPER_COLOR);
                    } else if (o.isSpotLight) {
                        helper = new THREE.SpotLightHelper(o, LIGHT_HELPER_COLOR);
                    } else if (o.isHemisphereLight) {
                        helper = new THREE.HemisphereLightHelper(o, baseSize * 0.5, LIGHT_HELPER_COLOR);
                    } else if (o.isRectAreaLight && typeof THREE.RectAreaLightHelper === 'function') {
                        helper = new THREE.RectAreaLightHelper(o, LIGHT_HELPER_COLOR);
                    }

                    if (!helper) return;

                    helper.userData.excludeFromBounds = true;
                    helper.userData.lightHelper = true;
                    helper.name = helper.name || `${o.name || o.type}-helper`;

                    const host = o.parent || root;
                    host.add(helper);
                    helper.update?.();

                    o.userData ||= {};
                    o.userData._lightHelper = helper;
                } else {
                    helper.update?.();
                }

                if (o.isSpotLight) {
                    const dist = (Number.isFinite(o.distance) && o.distance > 0.01) ? o.distance : 20;
                    o.distance = dist;
                    helper.cone.scale.set(20, 20, 20);
                }

                helper.visible = showLightHelpers;
            });
        }

        function setLightHelpersVisible(visible) {
            showLightHelpers = !!visible;
            loadedModels.forEach(model => {
                model.obj?.traverse(o => {
                    if (o?.userData?._lightHelper) {
                        o.userData._lightHelper.visible = showLightHelpers;
                        o.userData._lightHelper.update?.();
                    }
                });
            });
            requestRender();
        }

        function setImportedLightsEnabled(enabled, targetRoot = null, options = {}) {
            const { silent = false } = options || {};
            const roots = targetRoot
                ? (Array.isArray(targetRoot) ? targetRoot : [targetRoot])
                : loadedModels.map(m => m.obj).filter(Boolean);

            let affected = 0;

            roots.forEach(root => {
                if (!root) return;
                root.traverse(o => {
                    if (!o?.isLight) return;
                    o.userData ||= {};

                    if (enabled) {
                        if ('intensity' in o && o.userData._origIntensity !== undefined) {
                            // o.intensity = o.userData._origIntensity;
                            o.intensity = 1000;
                        }
                        if ('power' in o && o.userData._origPower !== undefined) {
                            // o.power = o.userData._origPower;
                            o.power = 1000;
                        }
                        const restoreVisible = o.userData._origVisible;
                        o.visible = restoreVisible !== undefined ? restoreVisible : true;
                    } else {
                        if ('intensity' in o) {
                            if (o.userData._origIntensity === undefined) o.userData._origIntensity = o.intensity;
                            o.intensity = 0;
                        }
                        if ('power' in o) {
                            if (o.userData._origPower === undefined) o.userData._origPower = o.power;
                            o.power = 0;
                        }
                        if (o.userData._origVisible === undefined) o.userData._origVisible = o.visible;
                        o.visible = false;
                    }

                    o.userData._lightEnabled = !!enabled;
                    affected++;
                });
            });

            importedLightsEnabled = !!enabled;

            if (!silent && typeof logBind === 'function') {
                logBind(`Lights: ${enabled ? 'включены' : 'выключены'} (${affected})`, 'info');
            }
            requestRender();
        }

        const lightHelpersBtn = document.getElementById('lightHelpersBtn');
        if (lightHelpersBtn) {
            lightHelpersBtn.addEventListener('click', () => {
                const next = !showLightHelpers;
                setLightHelpersVisible(next);
                lightHelpersBtn.classList.toggle('active', next);
            });
            lightHelpersBtn.classList.toggle('active', showLightHelpers);
        }

        const lightEmittersBtn = document.getElementById('lightEmittersBtn');
        if (lightEmittersBtn) {
            lightEmittersBtn.addEventListener('click', () => {
                const next = !importedLightsEnabled;
                setImportedLightsEnabled(next);
                lightEmittersBtn.classList.toggle('active', next);
            });
            lightEmittersBtn.classList.toggle('active', importedLightsEnabled);
        }


        const AXIS_VECTORS = {
            X: new THREE.Vector3(1, 0, 0),
            Y: new THREE.Vector3(0, 1, 0),
            Z: new THREE.Vector3(0, 0, 1)
        };

        function vectorFromPart(part) {
            if (!part || !part.axis) return null;
            const base = AXIS_VECTORS[part.axis];
            if (!base) return null;
            return base.clone().multiplyScalar(part.sign >= 0 ? 1 : -1);
        }

        function readFBXOrientationFromBuffer(arrayBuffer) {
            if (!arrayBuffer) return null;
            try {
                const view = new Uint8Array(arrayBuffer);
                const encoder = new TextEncoder();
                const cache = new Map();
                const getBytes = (prop) => {
                    if (!cache.has(prop)) cache.set(prop, encoder.encode(prop));
                    return cache.get(prop);
                };

                const readIntProperty = (prop) => {
                    const bytes = getBytes(prop);
                    const end = view.length - bytes.length;
                    let base = -1;
                    outer: for (let i = 0; i <= end; i++) {
                        for (let j = 0; j < bytes.length; j++) {
                            if (view[i + j] !== bytes[j]) continue outer;
                        }
                        base = i + bytes.length;
                        break;
                    }
                    if (base === -1) return null;

                    let pos = base;
                    const dv = new DataView(arrayBuffer);

                    // пропускаем возможные разделители и служебные байты (пробелы/табуляция/переводы строк)
                    while (pos < view.length && view[pos] <= 0x20) pos++;

                    const nextString = () => {
                        if (pos >= view.length || view[pos] !== 0x53) return false; // 'S'
                        const len = dv.getUint32(pos + 1, true);
                        pos += 5 + len;
                        return true;
                    };

                    for (let i = 0; i < 4; i++) {
                        if (!nextString()) break;
                    }

                    if (pos >= view.length) return null;
                    const typeCode = view[pos];
                    pos += 1;

                    switch (typeCode) {
                        case 0x49: return dv.getInt32(pos, true); // 'I'
                        case 0x4C: return Number(dv.getBigInt64(pos, true)); // 'L'
                        case 0x44: return dv.getFloat64(pos, true); // 'D'
                        case 0x46: return dv.getFloat32(pos, true); // 'F'
                        default: return null;
                    }
                };

                const axisNames = ['X', 'Y', 'Z'];
                const makePart = (index, sign) => {
                    if (index == null) return null;
                    const axis = axisNames[index] ?? `Axis${index}`;
                    const signValue = Number.isFinite(sign) ? Number(sign) : 1;
                    const normalizedSign = signValue >= 0 ? 1 : -1;
                    return { index, axis, sign: normalizedSign, symbol: normalizedSign >= 0 ? '+' : '-' };
                };

                const upAxis = readIntProperty('UpAxis');
                const upSign = readIntProperty('UpAxisSign');
                const frontAxis = readIntProperty('FrontAxis');
                const frontSign = readIntProperty('FrontAxisSign');
                const coordAxis = readIntProperty('CoordAxis');
                const coordSign = readIntProperty('CoordAxisSign');

                if ([upAxis, frontAxis, coordAxis].every(v => !Number.isFinite(v))) return null;

                return {
                    up: makePart(upAxis, upSign),
                    front: makePart(frontAxis, frontSign),
                    coord: makePart(coordAxis, coordSign),
                    raw: {
                        UpAxis: upAxis,
                        UpAxisSign: upSign,
                        FrontAxis: frontAxis,
                        FrontAxisSign: frontSign,
                        CoordAxis: coordAxis,
                        CoordAxisSign: coordSign,
                    },
                    source: 'binary'
                };
            } catch {
                return null;
            }
        }

                        function parseOrientationFromNode(root) {
            if (!root) return null;
            const axes = { X: new THREE.Vector3(1, 0, 0), Y: new THREE.Vector3(0, 1, 0), Z: new THREE.Vector3(0, 0, 1) };
            const result = { up: null, front: null, coord: null, source: 'geometry' };
            const tempMatrix = new THREE.Matrix4();
            const tempNormal = new THREE.Vector3();
            const tempTangent = new THREE.Vector3();

            root.traverse(node => {
                if (!node?.isMesh) return;
                node.updateWorldMatrix(true, false);
                tempMatrix.copy(node.matrixWorld).extractRotation(tempMatrix);
                tempNormal.set(0, 0, 1).applyMatrix4(tempMatrix).normalize();
                tempTangent.set(1, 0, 0).applyMatrix4(tempMatrix).normalize();
                assignFromVector('up', tempNormal);
                assignFromVector('front', tempTangent);
            });

            if (!result.up && root.up) {
                assignFromVector('up', root.up.clone().normalize());
            }

            if (!result.front && root.children?.length) {
                const firstMesh = root.children.find(c => c?.isMesh);
                if (firstMesh) {
                    firstMesh.updateWorldMatrix(true, false);
                    tempMatrix.copy(firstMesh.matrixWorld).extractRotation(tempMatrix);
                    tempTangent.set(1, 0, 0).applyMatrix4(tempMatrix).normalize();
                    assignFromVector('front', tempTangent);
                }
            }

            if (!result.coord && result.up && result.front) {
                const upVec = toVector(result.up);
                const frontVec = toVector(result.front);
                const rightVec = new THREE.Vector3().crossVectors(upVec, frontVec).normalize();
                assignFromVector('coord', rightVec);
            }

            if (!result.up && !result.front) return null;
            return result;

            function assignFromVector(type, vec) {
                if (!vec || !vec.lengthSq() || result[type]) return;
                let bestAxis = null;
                let bestSign = 1;
                let bestDot = -Infinity;
                Object.entries(axes).forEach(([axisName, axisVec]) => {
                    const dot = vec.dot(axisVec);
                    const absDot = Math.abs(dot);
                    if (absDot > bestDot) {
                        bestDot = absDot;
                        bestAxis = axisName;
                        bestSign = dot >= 0 ? 1 : -1;
                    }
                });
                if (!bestAxis) return;
                result[type] = { axis: bestAxis, symbol: bestSign >= 0 ? '+' : '-', sign: bestSign };
            }

            function toVector(data) {
                if (!data) return new THREE.Vector3();
                const axis = axes[data.axis];
                if (!axis) return new THREE.Vector3();
                return axis.clone().multiplyScalar(data.sign >= 0 ? 1 : -1);
            }
        }

        function describeFBXOrientation(info) {
            if (!info) return 'не найдена';
            const part = (label, data) => {
                if (!data) return `${label}: ?`;
                return `${label}: ${data.symbol}${data.axis}`;
            };
            return [
                part('Up', info.up),
                part('Front', info.front),
                part('Coord', info.coord)
            ].join(' · ');
        }

        function determineOrientationType(info) {
            const TYPE_UNKNOWN = 5;
            const result = { type: TYPE_UNKNOWN, handedness: 'unknown', upAxis: null };
            if (!info) return result;

            const upVec = vectorFromPart(info.up);
            const frontVec = vectorFromPart(info.front);
            const coordVec = vectorFromPart(info.coord);

            if (!upVec || !frontVec || !coordVec) return result;

            const handedness = coordVec.clone().cross(upVec).dot(frontVec) >= 0 ? 'right' : 'left';
            result.handedness = handedness;
            result.upAxis = info.up?.axis || null;

            if (info.up?.axis === 'Y') {
                result.type = handedness === 'right' ? 1 : 4;
            } else if (info.up?.axis === 'Z') {
                result.type = handedness === 'right' ? 2 : 3;
            }

            return result;
        }

        function describeOrientationType(type) {
            switch (type) {
                case 1: return 'Y-up · правосторонняя';
                case 2: return 'Z-up · правосторонняя';
                case 3: return 'Z-up · левосторонняя';
                case 4: return 'Y-up · левосторонняя';
                default: return 'неизвестно';
            }
        }

        function normalizeObjectOrientation(obj, orientationType) {
            if (!obj) return;
            // obj.rotation.set(0, 0, 0);
            switch (orientationType) {
                case 1: // Y-up right-handed
                    break;
                case 2: // Z-up right-handed
                    obj.rotateX(-Math.PI / 2);
                    break;
                case 3: // Z-up left-handed
                    obj.rotateX(-Math.PI / 2);
                    obj.rotateY(Math.PI);
                    break;
                case 4: // Y-up left-handed
                    obj.rotateY(Math.PI);
                    break;
                default:
                    obj.rotateX(-Math.PI / 2);
                    break;
            }
        }

        function applyGeoOffsetByOrientation(obj, orientationType, coords = {}) {
            if (!obj) return;
            const { x = 0, y = 0, z = 0 } = coords;
            obj.position.x = x;
            obj.position.y = z;
            obj.position.z = -y;
        }

        function readFBXOrientationFromTree(tree) {
            if (!tree) return null;
            const targetKeys = ['UpAxis', 'UpAxisSign', 'FrontAxis', 'FrontAxisSign', 'CoordAxis', 'CoordAxisSign'];
            const found = {};

            const extractNumeric = (value) => {
                if (value == null) return null;
                if (typeof value === 'number') return value;
                if (typeof value === 'string') {
                    const parsed = parseInt(value, 10);
                    return Number.isFinite(parsed) ? parsed : null;
                }
                if (Array.isArray(value)) {
                    for (const item of value) {
                        const extracted = extractNumeric(item);
                        if (extracted != null) return extracted;
                    }
                    return null;
                }
                if (typeof value === 'object') {
                    if ('value' in value) return extractNumeric(value.value);
                    for (const k of Object.keys(value)) {
                        if (k === 'type' || k === 'name') continue;
                        const extracted = extractNumeric(value[k]);
                        if (extracted != null) return extracted;
                    }
                }
                return null;
            };

            const visit = (node) => {
                if (!node || typeof node !== 'object') return;
                if (Array.isArray(node)) {
                    node.forEach(visit);
                    return;
                }
                for (const key of targetKeys) {
                    if (found[key] == null && key in node) {
                        const value = extractNumeric(node[key]);
                        if (value != null) found[key] = value;
                    }
                }
                for (const value of Object.values(node)) {
                    visit(value);
                }
            };

            visit(tree);

            if (targetKeys.every(key => found[key] == null)) return null;

            const axisNames = ['X', 'Y', 'Z'];
            const makePart = (index, sign) => {
                if (index == null) return null;
                const axis = axisNames[index] ?? `Axis${index}`;
                const signValue = Number.isFinite(sign) ? sign : 1;
                const signSymbol = signValue >= 0 ? '+' : '-';
                return { index, axis, sign: signValue, symbol: signSymbol };
            };

            return {
                up: makePart(found.UpAxis, found.UpAxisSign),
                front: makePart(found.FrontAxis, found.FrontAxisSign),
                coord: makePart(found.CoordAxis, found.CoordAxisSign),
                raw: found,
                source: 'tree'
            };
        }


        // =====================
        // UDIM split (для ВПМ/SM)
        // =====================

        function udimTile(ud) {
            const i = ud - 1001;
            return { tu: i % 10, tv: Math.floor(i / 10) };
        }

        // UDIM для треугольника по средним UV
        function triUDIM(u1,v1, u2,v2, u3,v3){
            const u = (u1+u2+u3)/3, v = (v1+v2+v3)/3;
            const tu = Math.max(0, Math.floor(u));   // не уходим в отрицательные тайлы
            const tv = Math.max(0, Math.floor(v));
            return 1001 + tu + tv*10;
        }

        // Разбить МЕШ на подподузлы по UDIM; вернёт true, если реально был сплит
        function splitMeshByUDIM(mesh){
            const g0 = mesh.geometry;
            if (!g0 || !g0.getAttribute?.('uv')) return false;

            // UCX/коллизии не трогаем
            const nm = (mesh.name || '').toLowerCase();
            if (/^ucx/.test(nm)) return false;

            // Разворачиваем индексы — так проще резать по треугольникам
            const g = g0.index ? g0.toNonIndexed() : g0.clone();
            const pos = g.getAttribute('position').array;
            const uv  = g.getAttribute('uv').array;
            const nrmAttr = g.getAttribute('normal');

            // Разложим треугольники по «ведёркам» UDIM
            const buckets = new Map(); // udim -> {pos:[], uv:[], nrm:[], tu, tv}
            const ensure = (ud) => {
                let b = buckets.get(ud);
                if (!b) {
                    const {tu,tv} = udimTile(ud);
                    b = { pos:[], uv:[], nrm:[], tu, tv };
                    buckets.set(ud, b);
                }
                return b;
            };

            const triCount = pos.length / 9;
            for (let t=0; t<triCount; t++){
                const pBase = t*9, uBase = t*6;
                const ud = triUDIM(
                    uv[uBase], uv[uBase+1],
                    uv[uBase+2], uv[uBase+3],
                    uv[uBase+4], uv[uBase+5]
                );
                const b = ensure(ud);

                // копируем 3 вершины
                for (let k=0;k<9;k++) b.pos.push(pos[pBase+k]);
                // for (let k=0;k<6;k++) b.uv.push(uv[uBase+k]);

                // UV: «сдвигаем» тайл к [0..1] вычитая целую часть
                b.uv.push(
                    uv[uBase]   - b.tu, uv[uBase+1] - b.tv,
                    uv[uBase+2] - b.tu, uv[uBase+3] - b.tv,
                    uv[uBase+4] - b.tu, uv[uBase+5] - b.tv
                );

                if (nrmAttr){
                    const nrm = nrmAttr.array;
                    for (let k=0;k<9;k++) b.nrm.push(nrm[pBase+k]);
                }
            }

            if (buckets.size <= 1) return false; // весь меш в одном UDIM — нечего делить

            // Контейнер на месте старого меша
            const holder = new THREE.Group();
            holder.name = 'UDIM';
            holder.userData.udimHolder = true;

            // переносим трансформ меша на holder; дети — с единичными трансформами
            holder.position.copy(mesh.position);
            holder.quaternion.copy(mesh.quaternion);
            holder.scale.copy(mesh.scale);

            // На каждый UDIM — свой узел с дочерним Mesh
            for (const [ud, b] of buckets){
                const gg = new THREE.BufferGeometry();
                gg.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
                gg.setAttribute('uv',       new THREE.Float32BufferAttribute(b.uv,  2));
                if (b.nrm.length) gg.setAttribute('normal', new THREE.Float32BufferAttribute(b.nrm, 3));
                else gg.computeVertexNormals();

                const tileGroup = new THREE.Group();
                tileGroup.name = `UDIM ${ud}`;
                tileGroup.userData.udim = ud;

                // ✅ делаем уникальный материал для КАЖДОГО UDIM
                let childMat;
                const srcMat = mesh.material;
                if (Array.isArray(srcMat)) {
                    childMat = srcMat.map((m, i) => {
                        const c = m.clone();
                        c.name = (m.name || mesh.name || 'Material') +
                                ` · UDIM ${ud}` +
                                (srcMat.length > 1 ? `_${i+1}` : '');
                        return c;
                    });
                } else {
                    childMat = srcMat.clone();
                    childMat.name = (srcMat.name || mesh.name || 'Material') + ` · UDIM ${ud}`;
                }

                const child = new THREE.Mesh(gg, childMat);
                child.name = `${mesh.name || mesh.type} · UDIM ${ud}`;
                child.castShadow = mesh.castShadow;
                child.receiveShadow = mesh.receiveShadow;
                child.userData.udim = ud;

                tileGroup.add(child);
                holder.add(tileGroup);
            }

            // Подменяем меш на holder у того же родителя (сохраним местоположение в списке детей)
            const parent = mesh.parent;
            const i = parent.children.indexOf(mesh);
            parent.remove(mesh);
            parent.children.splice(i, 0, holder);
            holder.parent = parent;

            // Чистим исходную геометрию, если она нам больше не нужна
            g0.dispose?.();

            return true;
        }

        // Запустить сплит по всему FBX-объекту (только для ВПМ/SM)
        function splitAllMeshesByUDIM_SM(root){
            const list = [];
            root.traverse(o => {
                if (o.isMesh && o.geometry?.getAttribute?.('uv')) list.push(o);
            });
            // важнo: менять дерево после обхода
            list.forEach(m => splitMeshByUDIM(m));
        }

        /**
         * Пытается уменьшить количество draw call'ов для стекла:
         * собирает треугольники в два последовательных блока по материалам.
         */
        function optimizeGlassMeshes(root) {
            if (!root) return;

            const isGlassMesh = (mesh) => {
                const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
                if (mats.length < 2) return false;
                const nameStr = `${mesh.name || ''} ${mats.map(m => m?.name || '').join(' ')}`;
                const geomSuffix = findGeomSuffix(nameStr);
                return isGlassByName(nameStr) || isGlassGeomSuffix(geomSuffix);
            };

            const rebuildGeometryByMaterial = (geometry) => {
                if (!geometry || !geometry.attributes?.position) return null;
                if (!geometry.groups || geometry.groups.length === 0) return null;
                if (Object.keys(geometry.morphAttributes || {}).length) return null; // не трогаем morph target'ы

                const makeSource = () => {
                    if (geometry.index) return geometry.toNonIndexed();
                    const clone = geometry.clone();
                    return clone;
                };

                const source = makeSource();
                const groups = source.groups || [];
                if (!groups.length) {
                    if (source !== geometry) source.dispose?.();
                    return null;
                }

                const attrEntries = Object.entries(source.attributes);
                if (!attrEntries.length) {
                    if (source !== geometry) source.dispose?.();
                    return null;
                }

                // Не поддерживаем interleaved атрибуты
                if (attrEntries.some(([, attr]) => attr?.isInterleavedBufferAttribute)) {
                    if (source !== geometry) source.dispose?.();
                    return null;
                }

                const matOrder = [];
                const perMaterial = new Map(); // matIndex -> { attrBuffers: { name: [] }, vertexCount }

                const ensureMatData = (matIndex) => {
                    let data = perMaterial.get(matIndex);
                    if (!data) {
                        data = { attrBuffers: {}, vertexCount: 0 };
                        perMaterial.set(matIndex, data);
                        matOrder.push(matIndex);
                    }
                    return data;
                };

                const positionAttr = source.attributes.position;
                const vertexCount = positionAttr?.count ?? 0;

                for (const group of groups) {
                    const matIndex = group?.materialIndex ?? 0;
                    const start = Math.max(0, group?.start ?? 0);
                    const count = Math.max(0, group?.count ?? 0);
                    if (count === 0) continue;
                    const end = Math.min(vertexCount, start + count);
                    if (end <= start) continue;

                    const matData = ensureMatData(matIndex);

                    for (let i = start; i < end; i++) {
                        for (const [name, attr] of attrEntries) {
                            const itemSize = attr.itemSize || 1;
                            const srcArray = attr.array;
                            const base = i * itemSize;
                            const dest = matData.attrBuffers[name] || (matData.attrBuffers[name] = []);
                            for (let k = 0; k < itemSize; k++) {
                                dest.push(srcArray[base + k]);
                            }
                        }
                        matData.vertexCount += 1;
                    }
                }

                if (source !== geometry) source.dispose?.();

                if (!matOrder.length) return null;

                const newGeom = new THREE.BufferGeometry();
                newGeom.name = geometry.name || '';
                newGeom.userData = { ...(geometry.userData || {}) };

                for (const [name, attr] of attrEntries) {
                    const ctor = attr.array.constructor;
                    const itemSize = attr.itemSize || 1;
                    const normalized = attr.normalized || false;

                    const totalLength = matOrder.reduce((sum, idx) => {
                        const data = perMaterial.get(idx);
                        return sum + (data?.attrBuffers[name]?.length ?? 0);
                    }, 0);

                    if (totalLength === 0) continue;

                    const typed = new ctor(totalLength);
                    let offset = 0;
                    for (const idx of matOrder) {
                        const data = perMaterial.get(idx);
                        const chunk = data?.attrBuffers[name];
                        if (!chunk || !chunk.length) continue;
                        typed.set(chunk, offset);
                        offset += chunk.length;
                    }

                    const bufferAttr = new THREE.BufferAttribute(typed, itemSize, normalized);
                    bufferAttr.name = attr.name;
                    if (attr.usage) bufferAttr.setUsage(attr.usage);
                    newGeom.setAttribute(name, bufferAttr);
                }

                newGeom.clearGroups();
                let cursor = 0;
                for (const idx of matOrder) {
                    const data = perMaterial.get(idx);
                    const count = data?.vertexCount || 0;
                    if (!count) continue;
                    newGeom.addGroup(cursor, count, idx);
                    cursor += count;
                }

                if (geometry.boundingBox) newGeom.boundingBox = geometry.boundingBox.clone();
                else newGeom.computeBoundingBox();

                if (geometry.boundingSphere) newGeom.boundingSphere = geometry.boundingSphere.clone();
                else newGeom.computeBoundingSphere();

                return newGeom;
            };

            let optimized = 0;
            root.traverse(mesh => {
                if (!mesh?.isMesh || mesh.userData?.isCollision) return;
                if (!mesh.geometry || !mesh.material) return;
                if (!isGlassMesh(mesh)) return;

                const matArray = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
                if (matArray.length < 2) return;
                const geom = mesh.geometry;
                const groups = geom.groups || [];
                if (groups.length <= matArray.length) return;

                const rebuilt = rebuildGeometryByMaterial(geom);
                if (!rebuilt) return;

                mesh.geometry.dispose?.();
                mesh.geometry = rebuilt;
                if (rebuilt.attributes?.position) {
                    rebuilt.attributes.position.needsUpdate = true;
                }
                optimized += 1;
            });

            if (optimized && typeof logBind === 'function') {
                logBind(`Glass optimization: пересобрано мешей — ${optimized}`, 'info');
            }
        }

        function getSelectedMaterialLink() {
            if (!matSelect) return null;
            const val = matSelect.value;
            if (val === '' || val == null) return null;

            let map = [];
            try { map = JSON.parse(matSelect.dataset._map || '[]'); } catch {}

            const entry = map.find(e => String(e.idx) === String(val));
            if (!entry) return null;

            const [uuid, idxStr] = String(entry.path).split(':');
            const targetIndex = parseInt(idxStr, 10) || 0;

            let link = null;
            world.traverse(o => {
                if (link || !o.isMesh) return;
                if (o.uuid !== uuid) return;
                const mats = Array.isArray(o.material) ? o.material : [o.material];
                link = { obj: o, index: targetIndex, mat: mats[targetIndex] || null };
            });
            return link;
        }

        // --- ПОДПИСАТЬ МАТЕРИАЛЫ ПО ИМЕНИ ОБЪЕКТА/UCX ---
        function renameMaterialsByFBXObject(root){
        const RX_DEFAULT = /^_*default(?:_?material)?\s*$/i;  // __DEFAULT / Default / DefaultMaterial / "" и т.п.
        const RX_UCX = /^ucx\b/i;

        const nearestUCX = (o) => {
            for (let p = o; p; p = p.parent){
            if (RX_UCX.test(p.name || '')) return p.name;
            if (p.geometry?.name && RX_UCX.test(p.geometry.name)) return p.geometry.name;
            }
            return null;
        };

        let renamed = 0;
        root.traverse(mesh => {
            if (!mesh.isMesh || !mesh.material) return;

            const ucx = nearestUCX(mesh);
            const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
            let changed = false;
            for (let i = 0; i < mats.length; i++){
            const m = mats[i]; if (!m) continue;

            const isDefault = RX_DEFAULT.test(m.name || '') || !(m.name || '').trim();
            const mustRename = isDefault || !!ucx;               // все UCX получат имя по объекту

            if (!mustRename) continue;

            const base = (ucx || mesh.name || mesh.parent?.name || 'MATERIAL').trim();
            const cloned = m.clone();                            // свой инстанс для этого меша
            cloned.name = mats.length > 1 ? `${base}_${i+1}` : base;

            if (Array.isArray(mesh.material)) mesh.material[i] = cloned;
            else mesh.material = cloned;

            renamed++;
            changed = true;
            }
            if (changed) cacheOriginalMaterialFor(mesh, true);
        });

        if (typeof logBind === 'function') {
            logBind(`UCX rename: переименовано материалов — ${renamed}`, renamed ? 'ok' : 'warn');
        }
        }

        // вернёт созданную/найденную группу "КОЛЛИЗИИ" или null, если UCX не найден
        // Собираем UCX-ноды в "КОЛЛИЗИИ" и подписываем материалы по ИМЕНИ ОБЪЕКТА.
        // ВАЖНО: каждому UCX-объекту — свой клон материала, чтобы имена не конфликтовали.
        function groupUCXUnderCollisions(root){
            const rx = /^ucx\b/i;

            // найдём все UCX-узлы
            const ucxNodes = [];
            root.traverse(o => {
                const n1 = o?.name || '';
                const n2 = o?.geometry?.name || '';
                if (rx.test(n1) || rx.test(n2)) ucxNodes.push(o);
            });

            // оставим только верхнеуровневые UCX (чтобы не дублировать дочерние)
            const tops = ucxNodes.filter(n => {
                let p = n.parent;
                while (p) {
                const pn = p?.name || '';
                const pg = p?.geometry?.name || '';
                if (rx.test(pn) || rx.test(pg)) return false;
                p = p.parent;
                }
                return true;
            });
            if (!tops.length) return null;

            // создаём/находим группу «КОЛЛИЗИИ»
            let col = root.getObjectByName('КОЛЛИЗИИ');
            if (!col) {
                col = new THREE.Group();
                col.name = 'КОЛЛИЗИИ';
                root.add(col);
            }

            // для каждого UCX-узла: переименуем материалы во всех мешах-потомках и перенесём под группу
            tops.forEach(node => {
                const base = (node.name || node.geometry?.name || 'UCX').trim();

                node.traverse(m => {
                if (!m.isMesh || !m.material) return;
                const mats = Array.isArray(m.material) ? m.material : [m.material];
                for (let i = 0; i < mats.length; i++) {
                    const cloned = mats[i].clone();                 // свой инстанс на меш
                    cloned.name = mats.length > 1 ? `${base}_${i+1}` : base; // имя по объекту
                    if (Array.isArray(m.material)) m.material[i] = cloned;
                    else m.material = cloned;
                }
                });

                if (node.parent !== col) col.attach(node);
            });

            return col;
            }

        function basename(p) { return (p || '').split(/[\\\/]/).pop(); }
        

        // helper: формируем метаданные GeoJSON (url для скачивания, prettified текст, подсчёт features)
        // =====================================================================
        // GeoJSON & Glass parameters
        // =====================================================================

        /**
         * Формирует удобную структуру с распарсенным GeoJSON, количеством features
         * и blob-URL для скачивания. Используется для SM (ВПМ) проектов.
         */
        function makeGeoJsonMeta(zipName, entryName, text){
            let parsed = null, featureCount = null;
            try {
                parsed = JSON.parse(text);
                if (parsed?.type === 'FeatureCollection' && Array.isArray(parsed.features)) {
                    featureCount = parsed.features.length;
                }
            } catch(_) {}

            const blob = new Blob([text], { type: 'application/geo+json' });
            const url  = URL.createObjectURL(blob);

            return {
                zipName,
                entryName: basename(entryName),
                text,           // исходный JSON-текст
                parsed,         // распарсенный объект (если получилось)
                featureCount,   // число features (если это FeatureCollection)
                url             // blob-url для кнопки "Скачать"
            };
        }

        /** Безопасно переводит строку вида "0,1" → число, возвращает fallback при ошибке. */
        /** Ограничивает значение диапазоном [0,1], не выбрасывая NaN. */
        function clamp01(v) {
            const num = Number.isFinite(v) ? v : 0;
            return Math.min(1, Math.max(0, num));
        }

        /** Нормализует hex-цвет в формат #RRGGBB или возвращает fallback. */
        function normalizeHexColor(value, fallback = null) {
            if (typeof value !== 'string') return fallback;
            let hex = value.trim();
            if (!hex) return fallback;
            if (!hex.startsWith('#')) hex = `#${hex}`;
            if (/^#[0-9a-fA-F]{3}$/.test(hex)) {
                hex = `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`;
            }
            if (/^#[0-9a-fA-F]{8}$/.test(hex)) {
                hex = hex.slice(0, 7);
            }
            if (/^#[0-9a-fA-F]{6}$/.test(hex)) {
                return hex.toUpperCase();
            }
            return fallback;
        }

        /** Преобразует объект цвета GeoJSON в hex-строку. */
        function geoColorToHex(colorObj) {
            if (!colorObj) return null;
            try {
                if (Array.isArray(colorObj) && colorObj.length >= 3) {
                    _glassTmpColor.setRGB(
                        clamp01(colorObj[0]),
                        clamp01(colorObj[1]),
                        clamp01(colorObj[2])
                    );
                } else if (typeof colorObj === 'object' && colorObj !== null && 'r' in colorObj) {
                    _glassTmpColor.setRGB(
                        clamp01(colorObj.r ?? 0),
                        clamp01(colorObj.g ?? 0),
                        clamp01(colorObj.b ?? 0)
                    );
                } else if (typeof colorObj === 'string') {
                    _glassTmpColor.set(colorObj);
                } else {
                    return null;
                }
                return `#${_glassTmpColor.getHexString().toUpperCase()}`;
            } catch (_) {
                return null;
            }
        }

        /** Приводит имя стеклянного материала к нормализованному ключу (lowercase). */
        function normalizeGlassKey(name) {
            if (!name) return null;
            return String(name).trim().toLowerCase();
        }

        /**
         * Извлекает массив `Glasses` из GeoJSON и кеширует результат: Map<matName, params>.
         * params → { color, transparency, roughness, metalness, refraction } в нормализованном виде.
         */
        function ensureGeoGlassIndex(meta) {
            if (!meta) return null;
            if (meta._glassIndex) return meta._glassIndex;
            const index = new Map();
            const parsed = meta.parsed;
            const features = parsed?.type === 'FeatureCollection' && Array.isArray(parsed.features)
                ? parsed.features
                : Array.isArray(parsed?.features) ? parsed.features : [];

            features.forEach(feature => {
                const glasses = feature?.Glasses;
                if (!Array.isArray(glasses)) return;
                glasses.forEach(entry => {
                    if (!entry || typeof entry !== 'object') return;
                    Object.entries(entry).forEach(([matName, params]) => {
                        const key = normalizeGlassKey(matName);
                        if (!key || index.has(key) || !params || typeof params !== 'object') return;

                        const color = params.color_RGB || params.color_rgb || params.color || null;
                        let colorData = null;
                        if (color && typeof color === 'object') {
                            const toChan = v => {
                                const val = parseGeoNumber(v);
                                return Number.isFinite(val) ? clamp01(val / 255) : null;
                            };
                            const r = toChan(color.Red ?? color.red ?? color.R ?? color.r);
                            const g = toChan(color.Green ?? color.green ?? color.G ?? color.g);
                            const b = toChan(color.Blue ?? color.blue ?? color.B ?? color.b);
                            if (r != null || g != null || b != null) {
                                colorData = {
                                    r: r ?? 0,
                                    g: g ?? 0,
                                    b: b ?? 0,
                                };
                            }
                        }

                        const transparency = parseGeoNumber(params.transparency);
                        const refraction = parseGeoNumber(params.refraction ?? params.ior ?? params.n);
                        const roughness = parseGeoNumber(params.roughness);
                        const metallicity = parseGeoNumber(params.metallicity ?? params.metalness);

                        const transparencyClamped = transparency != null ? clamp01(transparency) : null;
                        index.set(key, {
                            color: colorData,
                            transparency: transparencyClamped,
                            opacity: transparencyClamped,
                            refraction,
                            roughness: roughness != null ? clamp01(roughness) : null,
                            metalness: metallicity != null ? clamp01(metallicity) : null,
                        });
                    });
                });
            });

            meta._glassIndex = index;
            return index;
        }

        /** Возвращает параметры стекла для указанных имён (материал/объект), либо null. */
        function findGeoGlassParams(meta, nameCandidates) {
            if (!meta) return null;
            const index = ensureGeoGlassIndex(meta);
            if (!index || !index.size) return null;
            for (const candidate of nameCandidates) {
                const key = normalizeGlassKey(candidate);
                if (!key) continue;
                const hit = index.get(key);
                if (hit) return hit;
            }
            return null;
        }
    
        function openGeoModal(meta, title = 'GeoJSON') {
        let geoModal = document.getElementById('geoModal');
        if (!geoModal) {
            geoModal = document.createElement('div');
            geoModal.id = 'geoModal';
            geoModal.className = 'modal';
            geoModal.innerHTML = `
            <div class="sheet">
                <div class="head">
                <div class="row" style="gap:8px; align-items:center">
                    <b id="geoTitle"></b>
                    <span class="muted" id="geoInfo" style="font-size:12px"></span>
                </div>
                <button id="geoClose" class="btn" title="Закрыть">×</button>
                </div>
                <div class="body" style="grid-template-columns: 1fr">
                <div class="side" style="max-height:70vh; overflow:auto">
                    <pre id="geoPre" style="margin:0; white-space:pre; font-size:12px; line-height:1.35; tab-size:2"></pre>
                    <div class="row" style="margin-top:8px">
                    <a id="geoDl" class="btn" download>Скачать GeoJSON</a>
                    </div>
                </div>
                </div>
            </div>
            `;
            document.body.appendChild(geoModal);

            // закрытия
            geoModal.querySelector('#geoClose').addEventListener('click', () => geoModal.classList.remove('show'));
            geoModal.addEventListener('click', (e) => { if (e.target === geoModal) geoModal.classList.remove('show'); });
        }

        const pre   = geoModal.querySelector('#geoPre');
        const h     = geoModal.querySelector('#geoTitle');
        const info  = geoModal.querySelector('#geoInfo');
        const dl    = geoModal.querySelector('#geoDl');

        h.textContent = title;
        info.textContent = meta.entryName ? ` · ${meta.entryName}${Number.isFinite(meta.featureCount) ? ` · features: ${meta.featureCount}` : ''}` : '';
        dl.href = meta.url || '#';
        if (meta.entryName) dl.download = meta.entryName;

        // красивый вывод
        const pretty = meta.parsed ? JSON.stringify(meta.parsed, null, 2) : (meta.text || '');
        pre.textContent = pretty;

        geoModal.classList.add('show');
        }

        function guessKindFromName(name) {
            const n = (name || '').toLowerCase();
            if (/(rough|rgh|_rough|\br_)/.test(n)) return 'roughness';
            if (/gloss/.test(n)) return 'gloss';
            if (/(metal|mtl|\b_m\b)/.test(n)) return 'metalness';
            if (/(normal|_nrm|_nor)\b/.test(n)) return 'normal';
            if (/ao|ambient[_-]?occ/i.test(n)) return 'ao';
            if (/opacity|alpha|transp/i.test(n)) return 'alpha';
            if (/basecolor|albedo|diff(use)?/i.test(n)) return 'base';
            if (/spec(ular)?/i.test(n)) return 'spec';
            return 'other';
        }

        function texInfo(tex) {
            if (!tex) return '<span class="muted">—</span>';
            const human = tex.name || tex.userData?.origName || null;
            let rawSrc = '';
            const img = tex.image;
            if (img) rawSrc = img.currentSrc || img.src || img.url || '';
            const fallback = basename(decodeURIComponent(String(rawSrc || '')).split('?')[0] || '');
            const pretty = human || fallback || '(texture)';
            const cs = tex?.colorSpace === THREE.SRGBColorSpace ? 'srgb' : tex?.colorSpace === THREE.LinearSRGBColorSpace ? 'srgb-linear' : (tex?.colorSpace ?? '—');
            return `${pretty}  ·  ${cs}`;
        }

        function logBind(message, level = 'info') {
            if (!bindLogEl) return;
            const prefix = level === 'warn' ? '⚠️ ' : level === 'ok' ? '✅ ' : '';
            if (bindLogEl.textContent.trim() === '— пока пусто —') { bindLogEl.textContent = ''; }
            bindLogEl.textContent += prefix + message + '\n';
        }

        function logSessionHeader(title) {
            if (!bindLogEl) return;
            const ts = new Date().toLocaleTimeString();
            if (bindLogEl.textContent.trim() !== '— пока пусто —') { bindLogEl.textContent += '\n'; }
            bindLogEl.textContent += `——— ${title} @ ${ts} ———\n`;
        }

        
        // =====================
        // FBX embedded images extraction
        // =====================
        function isBinaryFBX(arrayBuffer) {
            const sig = new Uint8Array(arrayBuffer, 0, 23);
            const magic = 'Kaydara FBX Binary  \0';
            for (let i = 0; i < magic.length; i++) { if (sig[i] !== magic.charCodeAt(i)) return false; }
            return true;
        }

        function sniffImage(u8) {
            let mime = 'application/octet-stream';
            if (u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4E && u8[3] === 0x47) mime = 'image/png';
            else if (u8[0] === 0xFF && u8[1] === 0xD8) mime = 'image/jpeg';
            else if (u8[0] === 0x47 && u8[1] === 0x49 && u8[2] === 0x46) mime = 'image/gif';
            else if (u8[0] === 0x52 && u8[1] === 0x49 && u8[2] === 0x46 && u8[8] === 0x57 && u8[9] === 0x45) mime = 'image/webp';
            return { mime };
        }

        async function extractImagesFromFBX(arrayBuffer) {
            return isBinaryFBX(arrayBuffer) ? extractEmbeddedImagesFromFBX_binary(arrayBuffer) : extractEmbeddedImagesFromFBX_ascii(arrayBuffer);
        }

        async function extractEmbeddedImagesFromFBX_ascii(arrayBuffer) {
            const text = new TextDecoder('latin1').decode(new Uint8Array(arrayBuffer));
            const videos = [];
            const rxVideo = /Video::([^,\"\s]+)[^{]*?(?:FileName|RelativeFilename)\s*:\s*\"([^\"]+)\"/gi;
            let mv;
            while ((mv = rxVideo.exec(text))) videos.push({ nameInFbx: mv[1], filePath: mv[2] });

            const out = [];
            const rxContent = /Content\s*:\s*,/g;
            let mc, idx = 0;
            while ((mc = rxContent.exec(text))) {
                const start = mc.index + mc[0].length;
                const chunk = text.slice(start, start + 8_000_000);
                const b64m = chunk.match(/([A-Za-z0-9+\/=\r\n]{800,})/);
                if (!b64m) continue;
                const b64 = b64m[1].replace(/\s+/g, '');
                try {
                    const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
                    const { mime } = sniffImage(bin);
                    const url = URL.createObjectURL(new Blob([bin], { type: mime }));
                    const vid = videos[idx++] || {};
                    const filePath = vid.filePath || `embedded_${out.length}.${(mime.split('/')[1] || 'img')}`;
                    const short = basename(filePath).toLowerCase();
                    out.push({ short, url, full: filePath, mime, source: 'embedded' });
                } catch (__) { /* ignore decode errors */ }
            }
            return out;
        }

        function extractEmbeddedImagesFromFBX_binary(arrayBuffer) {
            const view = new DataView(arrayBuffer);
            const version = view.getUint32(23, true);
            const is64 = version >= 7500;
            const u8 = new Uint8Array(arrayBuffer);
            const td = new TextDecoder('utf-8');

            const u32 = (o) => view.getUint32(o, true);
            const u64 = (o) => { const low = view.getUint32(o, true), high = view.getUint32(o + 4, true); return high * 0x100000000 + low; };
            const readLen = (o) => is64 ? u64(o) : u32(o);

            function readNode(offset) {
                const endOffset = readLen(offset); offset += is64 ? 8 : 4;
                const numProps = readLen(offset); offset += is64 ? 8 : 4;
                const propsLen = readLen(offset); offset += is64 ? 8 : 4;
                const nameLen = view.getUint8(offset); offset += 1;
                if (endOffset === 0) return { nextOffset: endOffset, nullRecord: true };

                const name = td.decode(u8.subarray(offset, offset + nameLen)); offset += nameLen;
                const props = [];

                for (let i = 0; i < numProps; i++) {
                    const t = String.fromCharCode(view.getUint8(offset)); offset += 1;
                    if (t === 'S' || t === 'R') {
                        const len = u32(offset); offset += 4;
                        const data = u8.subarray(offset, offset + len); offset += len;
                        props.push({ type: t, data });
                    } else if (t === 'Y') { offset += 2; props.push({ type: t }); }
                    else if (t === 'C') { offset += 1; props.push({ type: t }); }
                    else if (t === 'I') { offset += 4; props.push({ type: t }); }
                    else if (t === 'F') { offset += 4; props.push({ type: t }); }
                    else if (t === 'D') { offset += 8; props.push({ type: t }); }
                    else if (t === 'L') { offset += 8; props.push({ type: t }); }
                    else if ('bcdfil'.includes(t)) {
                        const arrayLen = u32(offset); offset += 4;
                        const encoding = u32(offset); offset += 4;
                        const compLen = u32(offset); offset += 4;
                        if (encoding === 0) {
                            const elemSize = (t === 'd' || t === 'D') ? 8 : (t === 'l' || t === 'L' || t === 'i' || t === 'I') ? 4 : (t === 'f' || t === 'F') ? 4 : 1;
                            offset += arrayLen * elemSize;
                        } else {
                            offset += compLen;
                        }
                        props.push({ type: t, array: true });
                    } else {
                        return { name, props, children: [], nextOffset: endOffset };
                    }
                }

                const children = [];
                while (offset < endOffset) {
                    const child = readNode(offset);
                    if (child.nullRecord) { offset = is64 ? offset + 25 : offset + 13; break; }
                    children.push(child);
                    offset = child.nextOffset;
                }
                return { name, props, children, nextOffset: endOffset };
            }

            let offset = 27;
            const top = [];
            while (offset < arrayBuffer.byteLength) {
                const node = readNode(offset);
                if (!node || node.nullRecord) break;
                top.push(node);
                offset = node.nextOffset || (offset + 1);
            }

            const videos = [];
            (function visit(n) { if (!n) return; if (Array.isArray(n)) return n.forEach(visit); if (n.name === 'Video') videos.push(n); if (n.children) n.children.forEach(visit); })(top);

            const out = [];
            for (const vid of videos) {
                let filePath = null, content = null;
                const stack = [...(vid.children || [])];
                while (stack.length) {
                    const c = stack.shift();
                    if (!c) continue;
                    if (c.name === 'FileName' || c.name === 'RelativeFilename') {
                        const p = c.props?.[0];
                        if (p && p.type === 'S') filePath = new TextDecoder('utf-8').decode(p.data).replace(/\0/g, '');
                    }
                    if (c.name === 'Content') {
                        const p = c.props?.[0];
                        if (p && p.type === 'R') content = p.data;
                    }
                    if (c.children) stack.push(...c.children);
                }
                if (content) {
                    const { mime } = sniffImage(content);
                    const url = URL.createObjectURL(new Blob([content], { type: mime }));
                    const short = basename(filePath || `embedded_${out.length}.${(mime.split('/')[1] || 'img')}`).toLowerCase();
                    out.push({ short, url, full: filePath || short, mime, source: 'embedded' });
                }
            }
            return out;
        }

        // =====================
        // Material helpers
        // =====================


        // === COLLISIONS (UCX) =========================================
        const COLLISION_MAT_BASE = new THREE.MeshBasicMaterial({
            color: 0xff3333,
            transparent: true,
            opacity: 0.25,
            depthWrite: false,
            side: THREE.DoubleSide,
            toneMapped: false
        });

        function isUCXName(s){ return /^ucx/i.test(String(s||'')); }

        function getNearestUCXName(obj){
            for (let p = obj; p; p = p.parent){
                if (isUCXName(p.name)) return p.name;
                if (p.geometry && isUCXName(p.geometry.name)) return p.geometry.name;
            }
            return null;
        }

        /**
         * Помечает UCX-меши, задаёт им красный прозрачный материал (с именем UCX-объекта)
         * и отключает тени у коллизий.
         */
        function markCollisionMeshes(root){
            root.traverse(o => {
                if (!o.isMesh) return;
                const ucxBase = getNearestUCXName(o);
                if (!ucxBase) return;

                o.userData.isCollision = true;
                o.castShadow = false;
                o.receiveShadow = false;

                const nm = ucxBase || o.name || o.geometry?.name || '__COLLISION__';
                const m = COLLISION_MAT_BASE.clone();
                m.name = nm;

                if (Array.isArray(o.material)) {
                    o.material = o.material.map(() => m);
                } else {
                    o.material = m;
                }

                // Чтобы рисовались поверх, но без мерцания
                o.renderOrder = Math.max(o.renderOrder || 0, 999);
                o.visible = false;
                o.userData._origMaterial = o.material;
            });
        }

        /** Если в группе ZIP остались видимые коллизии, скрывает их и синхронизирует кнопки. */
        function ensureZipCollisionsHidden(groupName) {
            if (!groupName) return;
            const models = loadedModels.filter(m => m.group === groupName);
            if (!models.length) return;

            let anyCollision = false;
            models.forEach(model => {
                if (!model?.obj) return;
                model.obj.traverse(o => {
                    if (!o.isMesh || !o.userData?.isCollision) return;
                    anyCollision = true;
                    if (o.visible !== false) {
                        setMeshAndMaterialsVisibility(o, false);
                    }
                });
            });

            if (!anyCollision) return;

            schedulePanelRefresh(() => {
                updateEyeButtonsForTarget(`zipcoll|${groupName}`, false);
                models.forEach(model => {
                    if (model?.obj?.uuid) updateEyeButtonsForTarget(`colgrp|${model.obj.uuid}`, false);
                });
                syncCollisionButtons();
            });
        }

        function hideCollisions(root, refresh = true) {
            let changed = false;
            root.traverse(o => {
                if (o.userData?.isCollision) {
                    if (o.visible !== false) {
                        setMeshAndMaterialsVisibility(o, false);
                        changed = true;
                    }
                }
            });
            if (changed && refresh) schedulePanelRefresh(() => syncCollisionButtons());
            return changed;
        }

        function hideSMCollisions(syncUI = true) {
            let changed = false;
            loadedModels.forEach(model => {
                if ((model.zipKind || '').toUpperCase() !== 'SM') return;
                if (!model?.obj) return;
                if (hideCollisions(model.obj, false)) changed = true;
            });
            if (changed && syncUI) syncCollisionButtons();
            return changed;
        }


        function toStandard(m) {
            if (m.isMeshStandardMaterial || m.isMeshPhysicalMaterial) return m;
            const std = new THREE.MeshPhysicalMaterial({
                side: THREE.DoubleSide,
                color: m.color?.clone?.() ?? new THREE.Color(0xffffff),
                map: m.map ?? null,
                normalMap: m.normalMap ?? null,
                aoMap: m.aoMap ?? null,
                emissive: m.emissive?.clone?.() ?? new THREE.Color(0x000000),
                emissiveMap: m.emissiveMap ?? null,
                emissiveIntensity: m.emissiveIntensity ?? 1.0,
                transparent: !!m.transparent,
                opacity: m.opacity ?? 1.0,
                metalness: 0.0,
                roughness: Math.max(0.04, 1 - (m.shininess ?? 30) / 100)
            });

            if (std.isMeshPhysicalMaterial) {
                if (m.isMeshPhysicalMaterial) {
                    std.sheen = m.sheen ?? 0;
                    std.sheenColor = m.sheenColor?.clone?.() ?? new THREE.Color(0xffffff);
                    std.sheenRoughness = m.sheenRoughness ?? 1;
                    std.clearcoat = m.clearcoat ?? 0;
                    std.clearcoatRoughness = m.clearcoatRoughness ?? 0;
                    std.transmission = m.transmission ?? 0;
                    std.ior = m.ior ?? 1.0;
                    std.thickness = m.thickness ?? 0;
                    std.attenuationColor = m.attenuationColor?.clone?.() ?? new THREE.Color(0xffffff);
                    std.attenuationDistance = m.attenuationDistance ?? Infinity;
                    std.anisotropy = m.anisotropy ?? 0;
                    std.anisotropyRotation = m.anisotropyRotation ?? 0;
                    std.iridescence = m.iridescence ?? 0;
                    std.iridescenceIOR = m.iridescenceIOR ?? 1.3;
                    std.iridescenceThicknessRange = m.iridescenceThicknessRange?.slice?.() ?? [100, 400];
                } else {
                    std.clearcoat = 0;
                    std.clearcoatRoughness =1.0;
                    std.transmission = 0;
                    std.ior = 1.0;
                    std.thickness = 0.1;
                    std.attenuationColor = new THREE.Color(0xffffff);
                    std.attenuationDistance = Infinity;
                    std.sheen = 0;
                    std.iridescence = 0;
                    std.anisotropy = 0;
                }
            }

            // НЕ ТЕРЯЕМ ИМЯ
            std.name = m.name || std.name;

            if (std.map) std.map.colorSpace = THREE.SRGBColorSpace;
            if (std.emissiveMap) std.emissiveMap.colorSpace = THREE.SRGBColorSpace;
            if (std.normalMap) std.normalMap.colorSpace = THREE.LinearSRGBColorSpace;
            if (std.aoMap) std.aoMap.colorSpace = THREE.LinearSRGBColorSpace;
            if (m.alphaMap) { std.alphaMap = m.alphaMap; std.alphaMap.colorSpace = THREE.LinearSRGBColorSpace; std.alphaTest = 0.5; std.transparent = false; std.depthWrite = true; }
            if (scene.environment) { std.envMap = scene.environment; std.envMapIntensity = parseFloat(iblIntEl.value); }
            return std;
        }

        function copyTextureSettings(src, dst) {
            if (!src || !dst || src === dst) return;
            if (src.wrapS != null) dst.wrapS = src.wrapS;
            if (src.wrapT != null) dst.wrapT = src.wrapT;
            if ('wrapR' in src && 'wrapR' in dst && src.wrapR != null) dst.wrapR = src.wrapR;
            if (src.offset?.isVector2 && dst.offset?.copy) dst.offset.copy(src.offset);
            if (src.repeat?.isVector2 && dst.repeat?.copy) dst.repeat.copy(src.repeat);
            if (src.center?.isVector2 && dst.center?.copy) dst.center.copy(src.center);
            if (typeof src.rotation === 'number') dst.rotation = src.rotation;
            if (typeof src.matrixAutoUpdate === 'boolean') {
                dst.matrixAutoUpdate = src.matrixAutoUpdate;
                if (!dst.matrixAutoUpdate && src.matrix && dst.matrix?.copy) {
                    dst.matrix.copy(src.matrix);
                }
            }
            if (typeof src.flipY === 'boolean') dst.flipY = src.flipY;
            if (typeof src.anisotropy === 'number') dst.anisotropy = src.anisotropy;
            if (typeof src.generateMipmaps === 'boolean') dst.generateMipmaps = src.generateMipmaps;
            if (dst.image && (dst.image.width || dst.image.height || dst.image.data)) {
                dst.needsUpdate = true;
            }
        }

        const GEOM_SUFFIXES = ['mainglass', 'main', 'groundglass', 'groundelglass', 'groundel', 'ground', 'flora'];

        function findGeomSuffix(label) {
            const s = (label || '').toLowerCase();
            for (const g of GEOM_SUFFIXES) {
                const re = new RegExp(`(?:^|[^a-z0-9])${g}(?:[^a-z0-9]|$)`, 'i');
                if (re.test(s)) return g;
            }
            return null;
        }

        // Определяем номер слота из имени материала/объекта.
        // Ищем паттерн вида "..._Main_1" / "..._MainGlass_2" / "..._Ground_3" и пр.
        function detectSlotFromMaterialName(name) {
            if (!name) return null;
            const s = String(name);

            // Явный случай: _<GeomSuffix>_<slot> в конце
            // GEOM_SUFFIXES = ['mainglass','main','groundglass','groundelglass','groundel','ground','flora']
            const rx = new RegExp(`_(?:${GEOM_SUFFIXES.join('|')})_(\\d{1,3})(?!\\d)\\s*$`, 'i');
            const m1 = s.match(rx);
            if (m1) return parseInt(m1[1], 10);

            // Защита: не трогаем имена, заканчивающиеся на "UDIM 1005" и т.п.
            if (/UDIM\s*\d{4}\s*$/i.test(s)) return null;

            // Бэкап: если в самом конце просто "_<число>", берём его (например "M_..._1")
            const m2 = s.match(/_(\d{1,3})\s*$/);
            if (m2) return parseInt(m2[1], 10);

            return null;
        }

        // Используем её и для объекта, и для материала
        function detectSlotFromMatOrObj(obj, mat){
            const byMat = detectSlotFromMaterialName(mat?.name);
            if (byMat != null) return byMat;
            const byObj = detectSlotFromMaterialName(obj?.name);
            if (byObj != null) return byObj;
            return 1; // запасной вариант
        }


        function isGlassGeomSuffix(geomSuffix) { return /^(mainglass|groundglass|groundelglass)$/.test((geomSuffix || '').toLowerCase()); }
        function isGlassByName(name) { return /\b(mainglass|groundglass|groundelglass)\b/.test((name || '').toLowerCase()); }



        
        // ----------------------------------
        // OFFSET FROM GEOJSON UTILS FOR VPNS
        // ----------------------------------


function getSMOffset(meta) {
    function log(msg, level){ try{ typeof logBind==='function'?logBind(msg,level||'info'):console.log(msg); }catch(_){ console.log(msg); } }
    const src = meta?.parsed ?? meta?.json ?? meta?.text ?? meta;
    let data = null;
    try { data = (typeof src === 'string') ? JSON.parse(src) : src; }
    catch(e){ log(`GeoJSON parse error: ${e?.message||e} → Δ=0`, 'warn'); return {x:0,y:0,z:0}; }
    if (!data || typeof data!=='object'){ log('GeoJSON: empty → Δ=0','warn'); return {x:0,y:0,z:0}; }

    // ищем первый узел с geometry.type === 'Point'
    let node = null;
    (function find(o){
        if (node || !o || typeof o!=='object') return;
        if (o.geometry && o.geometry.type==='Point' && Array.isArray(o.geometry.coordinates)) { node = o; return; }
        for (const k in o){ const v=o[k]; if (v && typeof v==='object') find(v); if (node) break; }
    })(data);
    if (!node){ log('GeoJSON: Point not found → Δ=0','warn'); return {x:0,y:0,z:0}; }

    const c = node.geometry.coordinates;
    const toNum = v => (typeof v==='number'&&isFinite(v))?v: (typeof v==='string'? parseFloat(v.replace(/\s+/g,'').replace(',','.')):NaN);
    const X = toNum(c[0]) || 0;
    const Y = toNum(c[1]) || 0;
    let Z = 0;
    if (node.properties && node.properties.h_relief != null) {
        const hr = toNum(node.properties.h_relief);
        if (isFinite(hr)) Z = hr;
    }
    log(`VPM: GeoJSON offset → Δx=${X} Δy=${Y} Δz=${Z}`,'ok');
    if (Number.isFinite(Z)) setVPMReferenceHeight(Z);
    return { x:X, y:Y, z:Z };
}






        // =====================================================================
        // UI · Materials Panel & Gallery
        // =====================================================================

        let panelRefreshPending = false;
        const panelRefreshCallbacks = [];
        const PANEL_TEX_KEYS = ['map','alphaMap','normalMap','bumpMap','aoMap','emissiveMap','specularMap','roughnessMap','metalnessMap'];
        let panelNeedsFullRefresh = false;

        function resetMaterialsPanelState() {
            panelState.groups.forEach(entry => entry?.wrapper?.remove?.());
            panelState.groups.clear();
            panelState.renderedModels.clear();
            if (panelState.rootDetails) {
                panelState.rootDetails.remove();
                panelState.rootDetails = null;
            }
            panelState.ungroupedMarker = null;
            panelNeedsFullRefresh = false;
        }

        function schedulePanelRefresh(afterRender) {
            if (typeof afterRender === 'function') panelRefreshCallbacks.push(afterRender);
            if (panelRefreshPending) return;
            panelRefreshPending = true;
            Promise.resolve().then(() => {
                panelRefreshPending = false;
                if (panelNeedsFullRefresh) resetMaterialsPanelState();
                renderMaterialsPanel();
                const callbacks = panelRefreshCallbacks.splice(0);
                callbacks.forEach(cb => {
                    try { cb(); } catch (err) { console.error('panel refresh callback failed', err); }
                });
            });
        }

        function getPanelMaterials(obj) {
            if (!obj) return [];
            const orig = obj.userData?._origMaterial;
            if (orig) {
                const mats = Array.isArray(orig) ? orig : [orig];
                const hasTex = mats.some(m => PANEL_TEX_KEYS.some(k => !!m?.[k]));
                if (hasTex) return mats;
            }
            const mat = obj.material;
            return Array.isArray(mat) ? mat : mat ? [mat] : [];
        }

        function populateSampleSelect() {
            if (!sampleSelect) return;
            sampleSelect.innerHTML = '';
            SAMPLE_MODELS.forEach(sample => {
                const opt = document.createElement('option');
                opt.value = (sample.files && sample.files[0]) || '';
                opt.textContent = sample.label;
                sampleSelect.appendChild(opt);
            });
        }

        function formatPanelLabel(label, maxChars = 36, dots = '....') {
            if (label == null) return '';
            const str = String(label);
            if (str.length <= maxChars) return str;
            const ellipsis = dots || '....';
            const reserved = Math.min(maxChars, ellipsis.length);
            const available = Math.max(maxChars - reserved, 0);
            if (available <= 0) return str.slice(0, maxChars);

            let headLen = Math.max(2, Math.ceil(available / 2));
            let tailLen = Math.max(2, available - headLen);

            const minSegment = 3;
            if (headLen < minSegment && available >= minSegment * 2) {
                tailLen = Math.max(minSegment, tailLen - (minSegment - headLen));
                headLen = minSegment;
            }
            if (tailLen < minSegment && available >= minSegment * 2) {
                headLen = Math.max(minSegment, headLen - (minSegment - tailLen));
                tailLen = minSegment;
            }

            while (headLen + tailLen > available) {
                if (headLen > tailLen && headLen > 1) headLen--;
                else if (tailLen > 1) tailLen--;
                else break;
            }

            const head = str.slice(0, headLen);
            const tail = str.slice(Math.max(str.length - tailLen, headLen));
            return head + ellipsis + tail;
        }

        function escapeHtml(value) {
            return String(value ?? '')
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
        }

        /**
         * Рендерит один FBX в панель материалов: заголовок, секции коллизий,
         * список мешей, интерактивные контролы стекла и кнопки видимости.
         */
        function renderOneModel(model, chunksArr) {
            function glassInfoRow(obj, material, matIndex) {
                const info = material?.userData?.glassInfo;
                if (!info) return '';
                const overrides = material?.userData?.glassOverrides || {};
                const alphaVal = clamp01(overrides.opacity ?? info.opacity ?? material.opacity ?? 1);
                const roughVal = clamp01(overrides.roughness ?? info.roughness ?? material.roughness ?? 0.1);
                const metalVal = clamp01(overrides.metalness ?? info.metalness ?? material.metalness ?? 0);
                const transVal = clamp01(overrides.transmission ?? info.transmission ?? (material.transmission ?? Math.max(0, 1 - (material.opacity ?? 1))));
                const refractionRaw = overrides.refraction ?? info.refraction ?? material.ior ?? 1.5;
                const iorVal = Number.isFinite(refractionRaw) ? refractionRaw : 1.5;
                const reflectVal = Number.isFinite(overrides.envIntensity) ? overrides.envIntensity : (Number.isFinite(info.envIntensity) ? info.envIntensity : (Number.isFinite(material.envMapIntensity) ? material.envMapIntensity : 1));
                const rawColor = overrides.color || info.colorHex || (material.color?.isColor ? `#${material.color.getHexString()}` : '#ffffff');
                const colorHex = (rawColor.startsWith ? rawColor : `#${rawColor}`).toUpperCase();
                const rgbDisplay = formatColorForDisplay(material?.color);
                const sourceLabel = info.source === 'override' ? 'Custom' : (info.source === 'geojson' ? 'GeoJSON' : 'UI');
                return `
                <tr class="glass-row">
                    <td class="k glass-cell">Glass</td>
                    <td>
                        <div class="glass-controls" data-uuid="${obj.uuid}" data-mat-index="${matIndex}">
                            <div class="glass-group">
                                <label><span>α</span>
                                    <input type="range" min="0" max="1" step="0.01" value="${alphaVal}" class="glass-slider" data-prop="opacity" data-uuid="${obj.uuid}" data-mat-index="${matIndex}">
                                    <span class="glass-value" data-prop="opacity">${alphaVal.toFixed(2)}</span>
                                </label>
                            </div>
                            <div class="glass-group">
                                <label><span>rough</span>
                                    <input type="range" min="0" max="1" step="0.01" value="${roughVal}" class="glass-slider" data-prop="roughness" data-uuid="${obj.uuid}" data-mat-index="${matIndex}">
                                    <span class="glass-value" data-prop="roughness">${roughVal.toFixed(2)}</span>
                                </label>
                            </div>
                            <div class="glass-group">
                                <label><span>metal</span>
                                    <input type="range" min="0" max="1" step="0.01" value="${metalVal}" class="glass-slider" data-prop="metalness" data-uuid="${obj.uuid}" data-mat-index="${matIndex}">
                                    <span class="glass-value" data-prop="metalness">${metalVal.toFixed(2)}</span>
                                </label>
                            </div>
                            <div class="glass-group">
                                <label><span>trans</span>
                                    <input type="range" min="0" max="1" step="0.01" value="${transVal}" class="glass-slider" data-prop="transmission" data-uuid="${obj.uuid}" data-mat-index="${matIndex}">
                                    <span class="glass-value" data-prop="transmission">${transVal.toFixed(2)}</span>
                                </label>
                            </div>
                            <div class="glass-group">
                                <label><span>IOR</span>
                                    <input type="range" min="1" max="4" step="0.01" value="${iorVal}" class="glass-slider" data-prop="refraction" data-uuid="${obj.uuid}" data-mat-index="${matIndex}">
                                    <span class="glass-value" data-prop="refraction">${iorVal.toFixed(2)}</span>
                                </label>
                            </div>
                            <div class="glass-group">
                                <label><span>reflect</span>
                                    <input type="range" min="0" max="5" step="0.05" value="${reflectVal}" class="glass-slider" data-prop="envIntensity" data-uuid="${obj.uuid}" data-mat-index="${matIndex}">
                                    <span class="glass-value" data-prop="envIntensity">${reflectVal.toFixed(2)}</span>
                                </label>
                            </div>
                            <div class="glass-group">
                                <label><span>color</span>
                                    <input type="color" class="glass-color-input" data-prop="color" data-uuid="${obj.uuid}" data-mat-index="${matIndex}" value="${colorHex}">
                                    <span class="glass-value" data-prop="color-rgb">${rgbDisplay}</span>
                                </label>
                            </div>
                            <div class="glass-group glass-source-wrap">
                                <span class="glass-source" data-role="glass-source">${sourceLabel}</span>
                            </div>
                        </div>
                    </td>
                </tr>`;
            }

            const modelId = `file-${model.obj.uuid}`;
            const kindBadge =
                model.zipKind === 'NPM' ? '<span class="pill">НПМ</span>' :
                model.zipKind === 'SM'  ? '<span class="pill">ВПМ</span>'  : '';

            const hasGeo = !!(model.geojson || model.obj.userData?.geojson);
            const collisions = [];
            model.obj.traverse(o => { if (o.isMesh && o.userData?.isCollision) collisions.push(o); });

            // заголовок файла FBX
            const fileControls = `${hasGeo ? `<button type="button" class="doc" data-uuid="${model.obj.uuid}" title="Показать GeoJSON">📄</button>` : ''}<button type="button" class="eye" data-target="${modelId}" title="Показать/скрыть файл">👁</button>`;
            const fileTitlePieces = [];
            if (kindBadge) fileTitlePieces.push(kindBadge);
            const displayName = formatPanelLabel(model.name);
            fileTitlePieces.push(`<span title="${escapeHtml(model.name)}">${escapeHtml(displayName)}</span>`);

            const fileTitle = fileTitlePieces.join('');
            chunksArr.push(`
                <div class="collapsible" data-level="file">
                    <details data-level="file">
                        <summary>
                            <span class="sumline">${fileTitle}</span>
                        </summary>
            `);
            model.obj.userData._panelId = modelId;
            model.obj.userData._panelKind = 'file-root';

            // ---- СЕКЦИЯ КОЛЛИЗИЙ (UCX) ВНУТРИ ЭТОГО FBX ----
            if (collisions.length) {
                const colGroupId = `colgrp|${model.obj.uuid}`;
                const colControls = `<button type="button" class="eye" data-target="${colGroupId}" data-icon-on="🧱" data-icon-off="🚫" title="Показать/скрыть все коллизии файла">🧱</button>`;
                chunksArr.push(`
                    <div class="collapsible" data-level="collisions">
                        <details open data-level="collisions">
                            <summary>
                                <span class="sumline">
                                    <span>🧱 КОЛЛИЗИИ</span>
                                </span>
                            </summary>
                `);

                collisions.forEach(o => {
                    const mats = Array.isArray(o.material) ? o.material : [o.material];
                    mats.forEach((m, idx) => {
                        const objId = `collision-${o.uuid}-${idx}`;
                        o.userData._panelId = objId;
                        const humanIdx = mats.length > 1 ? ` [${idx+1}]` : '';
                        const rawTitle = (m?.name || o.name || o.geometry?.name || '__COLLISION__') + humanIdx;
                        const title = formatPanelLabel(rawTitle);

                        const present = [];
                        ['map','alphaMap','normalMap','aoMap','roughnessMap','metalnessMap']
                            .forEach(k => { if (m?.[k]) present.push(`<span class="tag">${k}</span>`); });

                        const colEntryControls = `<button type="button" class="eye" data-target="${objId}" data-uuid="${o.uuid}" data-mat-index="${idx}" title="Показать/скрыть">👁</button>`;
                        chunksArr.push(`
                            <div class="collapsible" data-level="collision-mesh">
                                <details>
                                    <summary>
                                        <span class="sumline"><span title="${escapeHtml(rawTitle)}">${escapeHtml(title)}</span></span>
                                    </summary>
                                <table>
                                    <tr><td class="k">Тип</td><td>${m?.type || '—'}</td></tr>
                                    <tr><td class="k">Цвет/α</td><td>#ff3333 · α=${(m?.opacity ?? 1).toFixed(2)}</td></tr>
                                    <tr><td class="k">Карты</td><td>${present.length ? present.join(' ') : '<span class="muted">—</span>'}</td></tr>
                                    ${glassInfoRow(o, m, idx)}
                                </table>
                                </details>
                                <div class="collapsible-controls">${colEntryControls}</div>
                            </div>
                        `);
                    });
                });

                chunksArr.push(`</details><div class="collapsible-controls">${colControls}</div></div>`);
            }

            // ---- ОСТАЛЬНЫЕ МЕШИ (ИСКЛЮЧАЕМ КОЛЛИЗИИ) ----
            model.obj.traverse((obj) => {
                if (!obj.isMesh) return;
                const mats = getPanelMaterials(obj);
                if (!mats.length) return;
                if (obj.userData?.isCollision) return; // 👈 не мешаем коллизиям

                mats.forEach((m, idx) => {
                    const humanIdx = idx + 1;
                    const matName = m.name || obj.name || `${m.type}`;
                    const rawTitle = `${matName}${mats.length > 1 ? ` [${humanIdx}]` : ''}`;
                    const title = formatPanelLabel(rawTitle);
                    const present = [];
                    ['map','alphaMap','normalMap','bumpMap','aoMap','emissiveMap','specularMap','roughnessMap','metalnessMap']
                        .forEach(k => { if (m[k]) present.push(`<span class="tag">${k}</span>`); });

                    const objId = `${modelId}-mesh-${obj.uuid}-${idx}`;
                    obj.userData._panelId = objId;

                    const meshControls = `<button type="button" class="eye" data-target="${objId}" data-uuid="${obj.uuid}" data-mat-index="${idx}" title="Показать/скрыть">👁</button>`;
                    chunksArr.push(`
                        <div class="collapsible" data-level="mesh">
                            <details>
                                <summary>
                                    <span class="sumline"><span title="${escapeHtml(rawTitle)}">${escapeHtml(title)}</span></span>
                                </summary>
                            <table>
                                <tr><td class="k">Карты</td><td>${present.length ? present.join(' ') : '<span class="muted">—</span>'}</td></tr>
                                <tr><td class="k">Diffuse</td><td>${m.map ? texInfo(m.map) : '<span class="muted">—</span>'}</td></tr>
                                <tr><td class="k">Alpha</td><td>${m.alphaMap ? texInfo(m.alphaMap) : '<span class="muted">—</span>'}</td></tr>
                                <tr><td class="k">Normal</td><td>${m.normalMap ? texInfo(m.normalMap) : '<span class="muted">—</span>'}</td></tr>
                                <tr><td class="k">AO</td><td>${m.aoMap ? texInfo(m.aoMap) : '<span class="muted">—</span>'}</td></tr>
                                <tr><td class="k">Roughness</td><td>${m.roughnessMap ? texInfo(m.roughnessMap) : '<span class="muted">—</span>'}</td></tr>
                                <tr><td class="k">Metalness</td><td>${m.metalnessMap ? texInfo(m.metalnessMap) : '<span class="muted">—</span>'}</td></tr>
                                ${glassInfoRow(obj, m, idx)}
                            </table>
                            </details>
                            <div class="collapsible-controls">${meshControls}</div>
                        </div>
                    `);
                });
            });

            chunksArr.push(`</details><div class="collapsible-controls">${fileControls}</div></div>`);
        }     

        function ensurePanelRoot() {
            if (panelState.rootDetails && panelState.ungroupedMarker?.isConnected) {
                return panelState.rootDetails;
            }
            panelState.groups.clear();
            panelState.renderedModels.clear();
            panelState.rootDetails = null;
            panelState.ungroupedMarker = null;
            if (outEl) outEl.innerHTML = '';
            const rootDetails = document.createElement('details');
            rootDetails.open = true;
            rootDetails.dataset.level = 'root';
            const summary = document.createElement('summary');
            summary.textContent = 'Объекты';
            rootDetails.appendChild(summary);
            const marker = document.createComment('ungrouped-marker');
            rootDetails.appendChild(marker);
            outEl.appendChild(rootDetails);
            panelState.rootDetails = rootDetails;
            panelState.ungroupedMarker = marker;
            return rootDetails;
        }

        function ensureGroupEntry(groupName, zipKind = '') {
            const rootDetails = ensurePanelRoot();
            if (panelState.groups.has(groupName)) {
                return panelState.groups.get(groupName);
            }

            const wrapper = document.createElement('div');
            wrapper.className = 'collapsible';
            wrapper.dataset.level = 'group';

            const details = document.createElement('details');
            details.dataset.level = 'group';

            const summary = document.createElement('summary');
            const sumline = document.createElement('span');
            sumline.className = 'sumline';

            if (zipKind) {
                const pill = document.createElement('span');
                pill.className = 'pill';
                pill.style.marginRight = '6px';
                pill.textContent = zipKind === 'NPM' ? 'НПМ' : zipKind === 'SM' ? 'ВПМ' : zipKind;
                sumline.appendChild(pill);
            }

            const label = document.createElement('span');
            const displayGroup = formatPanelLabel(groupName);
            label.textContent = `📦 ${displayGroup}`;
            label.title = groupName || '';
            sumline.appendChild(label);

            summary.appendChild(sumline);
            details.appendChild(summary);
            wrapper.appendChild(details);

            const controls = document.createElement('div');
            controls.className = 'collapsible-controls';
            const eyeBtn = document.createElement('button');
            eyeBtn.type = 'button';
            eyeBtn.className = 'eye';
            eyeBtn.dataset.target = `group|${groupName}`;
            eyeBtn.title = 'Показать/скрыть группу';
            eyeBtn.textContent = '👁';
            controls.appendChild(eyeBtn);
            wrapper.appendChild(controls);

            rootDetails.insertBefore(wrapper, panelState.ungroupedMarker);
            attachPanelEvents(wrapper);

            const entry = { wrapper, details, controls, groupName, hasCollisionButton: false, zipKind };
            panelState.groups.set(groupName, entry);
            return entry;
        }

        function appendNodesToRoot(nodes) {
            const rootDetails = ensurePanelRoot();
            nodes.forEach(node => {
                rootDetails.insertBefore(node, panelState.ungroupedMarker);
                attachPanelEvents(node);
            });
        }

        function createNodesFromModel(model) {
            const chunks = [];
            renderOneModel(model, chunks);
            const html = chunks.join('').trim();
            if (!html) return [];
            const template = document.createElement('template');
            template.innerHTML = html;
            return Array.from(template.content.children);
        }

        function appendModelToPanel(model, targetDetails) {
            const nodes = createNodesFromModel(model);
            if (!nodes.length) return;
            nodes.forEach(node => {
                targetDetails.appendChild(node);
                attachPanelEvents(node);
            });
            panelState.renderedModels.add(model.obj.uuid);
        }

        function modelHasCollisions(model) {
            let found = false;
            model.obj?.traverse(o => {
                if (!found && o.isMesh && o.userData?.isCollision) found = true;
            });
            return found;
        }

        function ensureGroupCollisionButton(entry, groupName) {
            if (entry.hasCollisionButton) return;
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'eye';
            btn.dataset.target = `zipcoll|${groupName}`;
            btn.dataset.iconOn = '🧱';
            btn.dataset.iconOff = '🚫';
            btn.title = 'Показать/скрыть коллизии группы';
            btn.textContent = '🧱';
            entry.controls.insertBefore(btn, entry.controls.firstChild);
            attachPanelEvents(btn);
            entry.hasCollisionButton = true;
        }

        function attachPanelEvents(root) {
            if (!root) return;
            const elements = [];
            if (root instanceof Element) {
                if (root.matches('.eye')) elements.push(root);
                root.querySelectorAll('.eye').forEach(el => elements.push(el));
            }
            elements.forEach(bindEyeButton);

            const docButtons = [];
            if (root instanceof Element) {
                if (root.matches('.doc')) docButtons.push(root);
                root.querySelectorAll('.doc').forEach(el => docButtons.push(el));
            }
            docButtons.forEach(bindDocButton);

            const glassSliders = [];
            if (root instanceof Element) {
                if (root.matches('.glass-slider')) glassSliders.push(root);
                root.querySelectorAll('.glass-slider').forEach(el => glassSliders.push(el));
            }
            glassSliders.forEach(bindGlassSlider);

            const glassColors = [];
            if (root instanceof Element) {
                if (root.matches('.glass-color-input')) glassColors.push(root);
                root.querySelectorAll('.glass-color-input').forEach(el => glassColors.push(el));
            }
            glassColors.forEach(bindGlassColorInput);
        }

        function bindEyeButton(btn) {
            if (!btn || btn.dataset.boundEye) return;
            btn.dataset.boundEye = '1';
            btn.style.cursor = 'pointer';
            btn.addEventListener('click', () => handleEyeToggle(btn));
        }

        function bindDocButton(btn) {
            if (!btn || btn.dataset.boundDoc) return;
            btn.dataset.boundDoc = '1';
            btn.style.cursor = 'pointer';
            btn.addEventListener('click', ev => {
                ev.preventDefault();
                ev.stopPropagation();
                const uuid = btn.dataset.uuid;
                if (!uuid) return;
                const mdl = loadedModels.find(m => m.obj.uuid === uuid);
                const meta = mdl?.geojson || mdl?.obj?.userData?.geojson;
                if (!meta) {
                    alert('GeoJSON не найден для этого FBX');
                    return;
                }
                openGeoModal(meta, mdl?.name || 'GeoJSON');
            });
        }

        function bindGlassSlider(input) {
            if (!input || input.dataset.boundGlassSlider) return;
            input.dataset.boundGlassSlider = '1';
            input.addEventListener('input', handleGlassSliderInput);
        }

        function bindGlassColorInput(input) {
            if (!input || input.dataset.boundGlassColor) return;
            input.dataset.boundGlassColor = '1';
            input.addEventListener('input', handleGlassColorInput);
            input.addEventListener('change', handleGlassColorInput);
        }

        /**
         * Собирает данные по всем загруженным моделям и перерисовывает панель материалов.
         * Обновляет выпадающий список, интерактивные элементы и синхронизацию коллизий.
         */
        function renderMaterialsPanel() {
            const newModels = loadedModels.filter(m => !panelState.renderedModels.has(m.obj.uuid));
            if (!newModels.length) return;

            newModels.forEach(model => {
                if (model.group) {
                    const entry = ensureGroupEntry(model.group, model.zipKind || '');
                    appendModelToPanel(model, entry.details);
                    if (modelHasCollisions(model)) {
                        ensureGroupCollisionButton(entry, model.group);
                    }
                } else {
                    const nodes = createNodesFromModel(model);
                    if (!nodes.length) return;
                    appendNodesToRoot(nodes);
                    panelState.renderedModels.add(model.obj.uuid);
                }
            });

            rebuildMaterialsDropdown();
            syncCollisionButtons();
        }

        /** Возвращает { mesh, mat, index } по UUID и индексу материала для стеклянных контролов. */
        function resolveGlassMaterial(uuid, matIndex) {
            if (!uuid) return null;
            const mesh = world.getObjectByProperty('uuid', uuid);
            if (!mesh || !mesh.material) return null;
            const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
            const index = Number.isInteger(matIndex) ? matIndex : (Number.isFinite(matIndex) ? matIndex : 0);
            const safeIndex = (index >= 0 && index < mats.length) ? index : 0;
            const mat = mats[safeIndex];
            if (!mat) return null;
            return { mesh, mat, index: safeIndex };
        }

        /** Навешивает обработчики на контролы стекла после перерисовки панели. */
        function bindGlassControls() {
            attachPanelEvents(outEl);
        }

        /** Синхронизирует состояние кнопок «Коллизии» (по файлам и группам) с текущей видимостью. */
        function syncCollisionButtons() {
            if (!outEl) return;

            loadedModels.forEach(model => {
                const root = model.obj;
                if (!root) return;
                let hasAny = false;
                let anyVisible = false;
                root.traverse(o => {
                    if (o.userData?.isCollision) {
                        hasAny = true;
                        if (o.visible !== false) anyVisible = true;
                    }
                });
                if (hasAny) updateEyeButtonsForTarget(`colgrp|${root.uuid}`, anyVisible);
            });

            const grouped = new Map();
            loadedModels.forEach(model => {
                if (!model.group) return;
                if (!grouped.has(model.group)) grouped.set(model.group, []);
                grouped.get(model.group).push(model);
            });

            grouped.forEach((models, groupName) => {
                let hasAny = false;
                let anyVisible = false;
                models.forEach(model => {
                    const root = model.obj;
                    if (!root) return;
                    root.traverse(o => {
                        if (o.userData?.isCollision) {
                            hasAny = true;
                            if (o.visible !== false) anyVisible = true;
                        }
                    });
                });
                if (hasAny) updateEyeButtonsForTarget(`zipcoll|${groupName}`, anyVisible);
            });
        }

        /** Обработчик изменения значений слайдеров стекла (α/rough/metal). */
        function handleGlassSliderInput(ev) {
            const input = ev.currentTarget;
            if (!input) return;
            const prop = input.dataset.prop;
            const uuid = input.dataset.uuid;
            const matIndex = Number.parseInt(input.dataset.matIndex ?? '0', 10) || 0;
            const resolved = resolveGlassMaterial(uuid, matIndex);
            if (!resolved) return;
            const { mat } = resolved;
            let rawValue = parseFloat(input.value);
            if (!Number.isFinite(rawValue)) rawValue = 0;
            const minAttr = Number.parseFloat(input.min ?? '');
            const maxAttr = Number.parseFloat(input.max ?? '');
            if (Number.isFinite(minAttr)) rawValue = Math.max(minAttr, rawValue);
            if (Number.isFinite(maxAttr)) rawValue = Math.min(maxAttr, rawValue);
            input.value = String(rawValue);

            let storedValue;
            if (prop === 'opacity' || prop === 'roughness' || prop === 'metalness' || prop === 'transmission') {
                storedValue = clamp01(rawValue);
            } else {
                storedValue = rawValue;
            }

            const overrides = (mat.userData ||= {}).glassOverrides ||= {};
            overrides[prop] = storedValue;
            if (prop === 'envIntensity') overrides.envIntensity = storedValue;
            if (prop === 'transmission') {
                (mat.userData.glassOriginal ||= {}).transmission = storedValue;
            }

            applyGlassControlsToScene();

            const container = input.closest('.glass-controls');
            if (container) {
                const span = container.querySelector(`.glass-value[data-prop="${prop}"]`);
                if (span) span.textContent = Number.isFinite(storedValue) ? storedValue.toFixed(2) : '—';
                updateGlassSourceLabel(container, mat);
                if (prop === 'color' || prop === 'opacity' || prop === 'roughness' || prop === 'metalness' || prop === 'transmission' || prop === 'envIntensity' || prop === 'refraction') {
                    const colorSpan = container.querySelector('.glass-value[data-prop="color-rgb"]');
                    if (colorSpan) colorSpan.textContent = formatColorForDisplay(mat?.color);
                }
            }
            requestRender();
        }

        /** Обработчик выбора цвета стекла. */
        function handleGlassColorInput(ev) {
            const input = ev.currentTarget;
            if (!input) return;
            const uuid = input.dataset.uuid;
            const matIndex = Number.parseInt(input.dataset.matIndex ?? '0', 10) || 0;
            const resolved = resolveGlassMaterial(uuid, matIndex);
            if (!resolved) return;
            const { mat } = resolved;
            const hex = normalizeHexColor(input.value, '#FFFFFF') || '#FFFFFF';
            input.value = hex;

            const overrides = (mat.userData ||= {}).glassOverrides ||= {};
            overrides.color = hex;

            applyGlassControlsToScene();

            const container = input.closest('.glass-controls');
            if (container) {
                updateGlassSourceLabel(container, mat);
                const colorSpan = container.querySelector('.glass-value[data-prop="color-rgb"]');
                if (colorSpan) colorSpan.textContent = formatColorForDisplay(mat?.color);
            }
            requestRender();
        }

        /** Обновляет текстовое поле-источник для стеклянного материала. */
        function updateGlassSourceLabel(container, mat) {
            if (!container || !mat) return;
            const label = container.querySelector('.glass-source');
            if (!label) return;
            const info = mat.userData?.glassInfo;
            let text = 'UI';
            if (info?.source === 'geojson') text = 'GeoJSON';
            else if (info?.source === 'override') text = 'Custom';
            label.textContent = text;
        }

        function formatColorForDisplay(color) {
            if (!color || !color.isColor) return '—';
            const to255 = (v) => Math.round(clamp01(v) * 255);
            return `${to255(color.r)}/${to255(color.g)}/${to255(color.b)}`;
        }

        // =====================
        // Gallery / modal
        // =====================
        /**
         * Обновляет галерею текстур в боковой панели: миниатюры embedded/zip изображений.
         */
        function renderGallery(listAll) {
            const total = Array.isArray(listAll) ? listAll.length : 0;

            if (!gallerySpacerEl || gallerySpacerEl.parentNode !== galleryEl) {
                gallerySpacerEl = document.createElement('div');
                gallerySpacerEl.className = 'gallery-spacer';
            }

            if (total === 0) {
                galleryEl.innerHTML = '';
                gallerySpacerEl = document.createElement('div');
                gallerySpacerEl.className = 'gallery-spacer';
                galleryEl.appendChild(gallerySpacerEl);
                galleryRenderedCount = 0;
                texCountEl.textContent = '0';
                return;
            }

            if (total < galleryRenderedCount) {
                galleryEl.innerHTML = '';
                galleryRenderedCount = 0;
            }

            const fragment = document.createDocumentFragment();
            for (let i = galleryRenderedCount; i < total; i++) {
                const e = listAll[i];
                const div = document.createElement('div');
                div.className = 'thumb';

                const imgWrap = document.createElement('div');
                if (e?.url) {
                    const img = document.createElement('img');
                    img.loading = 'lazy';
                    img.decoding = 'async';
                    img.alt = e.short || '';
                    img.src = e.url;
                    img.onerror = () => {
                        div.classList.add('broken');
                        img.replaceWith(makePlaceholder(e));
                    };
                    imgWrap.appendChild(img);
                } else {
                    div.classList.add('broken');
                    imgWrap.appendChild(makePlaceholder(e));
                }

                const nm = document.createElement('div');
                nm.className = 'nm';
                nm.title = (e.full || e.short || '') + (e.fileName ? ` — ${e.fileName}` : '');
                nm.textContent = e.short || `(entry ${i})`;

                const pill = document.createElement('span');
                pill.className = 'pill';
                pill.textContent = `${guessKindFromName(e.short)}${e.fileName ? ` · ${basename(e.fileName)}` : ''}`;

                div.appendChild(imgWrap);
                div.appendChild(nm);
                div.appendChild(pill);
                div.addEventListener('click', () => openTexModal(e));

                fragment.appendChild(div);
            }

            if (fragment.childNodes.length) {
                if (galleryRenderedCount === 0) {
                    galleryEl.innerHTML = '';
                }
                if (gallerySpacerEl.parentNode !== galleryEl) {
                    galleryEl.appendChild(gallerySpacerEl);
                }
                galleryEl.insertBefore(fragment, gallerySpacerEl);
            }

            if (gallerySpacerEl.parentNode !== galleryEl) {
                galleryEl.appendChild(gallerySpacerEl);
            }

            galleryRenderedCount = total;
            texCountEl.textContent = String(total);

            function makePlaceholder(entry) {
                const ph = document.createElement('div');
                ph.className = 'ph';
                ph.textContent = entry?.mime ? entry.mime : 'preview error';
                return ph;
            }

            galleryNeedsRefresh = false;
        }

        const texModal = document.getElementById('texModal');
        const mClose = document.getElementById('mClose');
        const mImg = document.getElementById('mImg');
        const mTitle = document.getElementById('mTitle');
        const mFile = document.getElementById('mFile');
        const mKind = document.getElementById('mKind');
        const mMime = document.getElementById('mMime');
        const dlLink = document.getElementById('dlLink');
        const bindBtn = document.getElementById('bindBtn');
        const slotSelect = document.getElementById('slotSelect');

        let modalTex = null;
        function openTexModal(entry) {
            modalTex = entry;
            mImg.src = entry.url;
            mTitle.textContent = (entry.full || entry.short) + (entry.fileName ? ` — ${entry.fileName}` : '');
            mFile.textContent = entry.short;
            mKind.textContent = guessKindFromName(entry.short);
            mMime.textContent = entry.mime || '';
            dlLink.href = entry.url; dlLink.download = basename(entry.short);
            texModal.classList.add('show');

            if (matSelect && (matSelect.value === '' || matSelect.selectedIndex <= 0) && matSelect.options.length > 1) { matSelect.selectedIndex = 1; }

            const k = guessKindFromName(entry.short);
            slotSelect.value = k === 'base' ? 'map' : k === 'alpha' ? 'alphaMap' : k === 'normal' ? 'normalMap' : k === 'ao' ? 'aoMap' : (k === 'roughness' || k === 'gloss') ? 'roughnessMap' : k === 'metalness' ? 'metalnessMap' : 'map';
        }

        mClose.addEventListener('click', () => texModal.classList.remove('show'));
        texModal.addEventListener('click', (e) => { if (e.target === texModal) texModal.classList.remove('show'); });

        bindBtn.addEventListener('click', () => {
            if (!modalTex) return;

            const link = getSelectedMaterialLink();
            if (!link || !link.mat) { alert('Выберите материал в списке'); return; }

            const { obj, index } = link;
            const slot   = slotSelect.value;
            const linear = !(slot === 'map' || slot === 'emissiveMap');

            const t = textureLoader.load(modalTex.url);
            const humanName = basename(modalTex.full || modalTex.short);
            t.name = humanName; (t.userData ||= {}).origName = humanName;
            t.colorSpace = linear ? THREE.LinearSRGBColorSpace : THREE.SRGBColorSpace;

            // делаем PBR-эквивалент и назначаем карту на НОВЫЙ материал
            let std = toStandard(link.mat);

            let prevTex = null;
            if (slot === 'roughnessMap') { prevTex = std.roughnessMap || null; std.roughnessMap = t; std.roughness = 0.6; }
            else if (slot === 'metalnessMap') { prevTex = std.metalnessMap || null; std.metalnessMap = t; std.metalness = 1.0; }
            else if (slot === 'alphaMap') { prevTex = std.alphaMap || null; std.alphaMap = t; std.alphaTest = 0.5; std.transparent = false; std.depthWrite = true; }
            else { prevTex = std[slot] || null; std[slot] = t; }

            copyTextureSettings(prevTex, t);

            if (scene.environment) {
                std.envMap = scene.environment;
                std.envMapIntensity = parseFloat(iblIntEl.value);
            }
            std.needsUpdate = true;

            // ВАЖНО: подменяем материал у меша
            if (Array.isArray(obj.material)) {
                obj.material[index] = std;
            } else {
                obj.material = std;
            }
            cacheOriginalMaterialFor(obj, true);

            applyGlassControlsToScene();  // опционально
            schedulePanelRefresh();
            logBind(`${modalTex.short} → ${std.name || 'материал'}.${slot}`, 'ok');
        });

        // =====================
        // Glass controls
        // =====================
        function cacheOriginalMaterialFor(obj, force = false) {
            if (!obj) return;
            if (!force && currentShadingMode !== 'pbr') return;
            obj.userData._origMaterial = obj.material;
        }

        /**
         * Применяет настройки стекла ко всем мешам: GeoJSON → overrides → UI-слайдеры.
         * Актуализирует `userData.glassInfo` для панели и при необходимости сохраняет overrides.
         */
        function applyGlassControlsToScene() {
            const sliderOpacity = parseFloat(glassOpacityEl?.value ?? 0.1);
            const sliderReflect = parseFloat(glassReflectEl?.value ?? 3.0);
            const sliderRough = parseFloat(glassRoughEl?.value ?? 0.05);
            const sliderMetal = parseFloat(glassMetalEl?.value ?? 1.0);
            const sliderTransmission = parseFloat(glassTransmissionEl?.value ?? 1);
            const sliderIor = parseFloat(glassIorEl?.value ?? 1.5);
            const sliderAttenDist = parseFloat(glassAttenDistEl?.value ?? 0.2);
            const useGlobalOpacity = glassOpacityEl?.dataset.userSet === '1';
            const useGlobalIor = glassIorEl?.dataset.userSet === '1';
            const useGlobalTransmission = glassTransmissionEl?.dataset.userSet === '1';
            const useGlobalReflect = glassReflectEl?.dataset.userSet === '1';
            const useGlobalRoughness = glassRoughEl?.dataset.userSet === '1';
            const useGlobalMetalness = glassMetalEl?.dataset.userSet === '1';
            const useGlobalColor = glassColorEl?.dataset.userSet === '1';
            const useGlobalAttenDist = glassAttenDistEl?.dataset.userSet === '1';
            const useGlobalAttenColor = glassAttenColorEl?.dataset.userSet === '1';
            const globalColorHex = useGlobalColor
                ? normalizeHexColor(glassColorEl.value, '#FFFFFF')
                : null;
            const globalAttenColorHex = useGlobalAttenColor
                ? normalizeHexColor(glassAttenColorEl.value, '#FFFFFF')
                : null;

            function findGeoMetaForObject(obj) {
                let node = obj;
                while (node) {
                    const meta = node.userData?._geojsonMeta || node.userData?.geojson;
                    if (meta) return meta;
                    node = node.parent || null;
                }
                return null;
            }

            function findZipKindForObject(obj) {
                let node = obj;
                while (node) {
                    const kind = node.userData?.zipKind || node.userData?.zipKindOverride;
                    if (kind) return kind;
                    node = node.parent || null;
                }
                return null;
            }

            world.traverse(o => {
                if (o.userData?.isCollision) return;
                if (!o.isMesh || !o.material) return;
                const mats = Array.isArray(o.material) ? o.material : [o.material];
                mats.forEach((m, i) => {
                    const nameStr = `${m.name || ''} ${o.name || ''}`;
                    const geomSuffix = findGeomSuffix(nameStr);
                    const glass = isGlassByName(nameStr) || isGlassGeomSuffix(geomSuffix);
                    if (!glass) return;

                    const std = toStandard(m);
                    std.transparent = true;
                    std.envMap = scene.environment || std.envMap;
                    std.userData ||= {};

                    let overrides = std.userData.glassOverrides || null;
                    const geoMeta = findGeoMetaForObject(o);
                    const glassParams = geoMeta ? findGeoGlassParams(geoMeta, [m.name, o.name, nameStr]) : null;
                    const currentEnvIntensity = Number.isFinite(std.envMapIntensity) ? std.envMapIntensity : sliderReflect;
                    const zipKind = (findZipKindForObject(o) || '').toUpperCase();
                    const isNPM = zipKind === 'NPM';
                    const isSM = zipKind === 'SM';

                    if (!std.userData.glassOriginal) {
                        const baseColorFromGeo = glassParams?.color ? geoColorToHex(glassParams.color) : (std.color?.isColor ? `#${std.color.getHexString().toUpperCase()}` : null);
                        const geoTransparency = glassParams?.transparency;
                        const originalOpacity = (geoTransparency != null)
                            ? clamp01(1 - geoTransparency)
                            : (glassParams?.opacity ?? std.opacity ?? sliderOpacity);
                        const originalRoughness = glassParams?.roughness ?? std.roughness ?? sliderRough;
                        const originalMetalness = glassParams?.metalness ?? std.metalness ?? sliderMetal;
                        const originalRefraction = glassParams?.refraction ?? (('ior' in std) ? std.ior : null);
                        const baseAttenuationColor = baseColorFromGeo || (std.attenuationColor?.isColor ? `#${std.attenuationColor.getHexString().toUpperCase()}` : null);
                        const originalData = {
                            opacity: Number.isFinite(originalOpacity) ? clamp01(originalOpacity) : null,
                            roughness: Number.isFinite(originalRoughness) ? clamp01(originalRoughness) : null,
                            metalness: Number.isFinite(originalMetalness) ? clamp01(originalMetalness) : null,
                            envIntensity: Number.isFinite(currentEnvIntensity) ? currentEnvIntensity : sliderReflect,
                            color: baseColorFromGeo,
                            refraction: originalRefraction,
                            transmission: 1,
                            attenuationColor: baseAttenuationColor,
                            attenuationDistance: 0.2,
                        };
                        if (isNPM) {
                            originalData.opacity = 0.30;
                            originalData.roughness = 0.05;
                            originalData.metalness = 0.1;
                            originalData.envIntensity = 3.0;
                            originalData.refraction = 3.0;
                            originalData.transmission = 1;
                            originalData.attenuationColor = baseColorFromGeo || (std.color?.isColor ? `#${std.color.getHexString().toUpperCase()}` : null);
                            originalData.attenuationDistance = 0.1;
                            std.transmission = 1;
                        }
                        if (isSM && !isNPM && glassParams) {
                            if (glassParams.color) std.color?.set?.(originalData.color || glassParams.color);
                            if (glassParams.transparency != null) originalData.opacity = clamp01(1 - glassParams.transparency);
                            if (glassParams.roughness != null) originalData.roughness = clamp01(glassParams.roughness);
                            if (glassParams.metalness != null) originalData.metalness = clamp01(glassParams.metalness);
                            if (glassParams.refraction != null) originalData.refraction = glassParams.refraction;
                            if (glassParams.transparency != null) originalData.transmission = 1;
                        }
                        std.userData.glassOriginal = originalData;
                    }

                    const original = std.userData.glassOriginal || {};

            let targetOpacity = useGlobalOpacity
                ? clamp01(sliderOpacity)
                : clamp01(original.opacity ?? std.opacity ?? sliderOpacity);
            let targetMetalness = useGlobalMetalness
                ? clamp01(sliderMetal)
                        : clamp01(original.metalness ?? std.metalness ?? sliderMetal);
                    let targetRoughness = useGlobalRoughness
                        ? clamp01(sliderRough)
                        : clamp01(original.roughness ?? std.roughness ?? sliderRough);
            let targetRefraction = useGlobalIor
                ? (Number.isFinite(sliderIor) ? sliderIor : 1.5)
                : (overrides?.refraction ?? original.refraction ?? (('ior' in std) ? std.ior : null));
                    let targetColorHex = globalColorHex ?? normalizeHexColor(original.color, std.color?.isColor ? `#${std.color.getHexString().toUpperCase()}` : null);
                    let targetEnvIntensity = useGlobalReflect
                        ? sliderReflect
                        : (Number.isFinite(original.envIntensity) ? original.envIntensity : currentEnvIntensity);
            const hasOverrideTransmission = overrides?.transmission != null;
            const hasGeoTransmission = false;
            let targetTransmission = 1;
            if (useGlobalTransmission) {
                targetTransmission = clamp01(Number.isFinite(sliderTransmission) ? sliderTransmission : 1);
            } else if (hasOverrideTransmission) {
                targetTransmission = clamp01(overrides.transmission);
            } else if (original.transmission != null) {
                targetTransmission = clamp01(original.transmission);
            }
            let targetAttenuationDistance = original.attenuationDistance != null ? original.attenuationDistance : (Number.isFinite(std.attenuationDistance) ? std.attenuationDistance : null);
            let targetAttenuationColorHex = normalizeHexColor(original.attenuationColor, null);
            if (useGlobalAttenDist) {
                const fallback = Number.isFinite(sliderAttenDist) ? sliderAttenDist : (targetAttenuationDistance != null ? targetAttenuationDistance : 0.2);
                targetAttenuationDistance = Math.max(0, fallback);
            }
            if (useGlobalAttenColor && globalAttenColorHex) {
                targetAttenuationColorHex = globalAttenColorHex;
            }

                    const hasOverrides = overrides && Object.keys(overrides).length > 0;
                    if (hasOverrides) {
                        if (overrides.opacity != null) targetOpacity = clamp01(overrides.opacity);
                        if (overrides.roughness != null) targetRoughness = clamp01(overrides.roughness);
                        if (overrides.metalness != null) targetMetalness = clamp01(overrides.metalness);
                        if (overrides.transmission != null) targetTransmission = clamp01(overrides.transmission);
                        if (overrides.envIntensity != null) targetEnvIntensity = overrides.envIntensity;
                        if (overrides.color) {
                            const overrideHex = normalizeHexColor(overrides.color, targetColorHex);
                            if (overrideHex) {
                                overrides.color = overrideHex;
                                targetColorHex = overrideHex;
                            }
                        }
                        if (overrides.refraction != null && 'ior' in std) {
                            targetRefraction = overrides.refraction;
                            std.ior = overrides.refraction;
                            std.userData.refraction = overrides.refraction;
                        }
                        if (overrides.attenuationDistance != null) {
                            targetAttenuationDistance = Math.max(0, overrides.attenuationDistance);
                        }
                        if (overrides.attenuationColor) {
                            const overrideAttHex = normalizeHexColor(overrides.attenuationColor, targetAttenuationColorHex);
                            if (overrideAttHex) {
                                overrides.attenuationColor = overrideAttHex;
                                targetAttenuationColorHex = overrideAttHex;
                            }
                        }
                    }

                    if (isNPM && !useGlobalRoughness && !(hasOverrides && overrides?.roughness != null)) {
                        targetRoughness = 0.05;
                    }
                    if (isNPM && !useGlobalMetalness && !(hasOverrides && overrides?.metalness != null)) {
                        targetMetalness = 0.1;
                    }
                    if (targetRefraction != null && 'ior' in std) {
                        std.ior = targetRefraction;
                        std.userData.refraction = targetRefraction;
                    }

                    if (!targetAttenuationColorHex) {
                        targetAttenuationColorHex = normalizeHexColor(targetColorHex, null);
                    } else {
                        targetAttenuationColorHex = normalizeHexColor(targetAttenuationColorHex, targetColorHex);
                    }
                    if (isNPM && !useGlobalTransmission && !(hasOverrides && overrides?.transmission != null)) {
                        targetTransmission = 1;
                        targetAttenuationDistance = 0.1;
                        targetAttenuationColorHex = normalizeHexColor(targetColorHex, targetAttenuationColorHex);
                    }

                    if (targetColorHex) {
                        try { std.color.set(targetColorHex); } catch (_) {}
                    }

                    const finalOpacity = clamp01(targetOpacity);
                    std.opacity = finalOpacity;
                    if (!std.metalnessMap) std.metalness = clamp01(targetMetalness);
                    if (!std.roughnessMap) std.roughness = clamp01(targetRoughness);
                    std.envMapIntensity = targetEnvIntensity;
                    if (std.isMeshPhysicalMaterial) {
                        const transmission = clamp01(targetTransmission ?? 0);
                        std.transmission = transmission;
                        std.transparent = transmission > 0.01 || finalOpacity < 0.999;
                        std.opacity = finalOpacity;
                        std.thickness = Number.isFinite(std.thickness) ? std.thickness : 0.2;
                        std.ior = Number.isFinite(std.ior) ? std.ior : 1.5;
                        if (targetAttenuationColorHex) {
                            try {
                                if (std.attenuationColor?.isColor) std.attenuationColor.set(targetAttenuationColorHex);
                                else std.attenuationColor = new THREE.Color(targetAttenuationColorHex);
                            } catch (_) {}
                        }
                        if (targetAttenuationDistance != null) {
                            const dist = Math.max(0, targetAttenuationDistance);
                            std.attenuationDistance = dist;
                            if ('thickness' in std) std.thickness = dist;
                        }
                    }

                    const globalOverrideActive = useGlobalOpacity || useGlobalRoughness || useGlobalMetalness || useGlobalReflect || useGlobalColor || useGlobalTransmission || useGlobalIor || useGlobalAttenDist || useGlobalAttenColor;
                    const infoSource = hasOverrides ? 'override' : (globalOverrideActive ? 'ui' : (glassParams ? 'geojson' : 'ui'));
                    const infoColorHex = normalizeHexColor(targetColorHex ?? (std.color?.isColor ? `#${std.color.getHexString().toUpperCase()}` : null), null);
                    const info = {
                        opacity: finalOpacity,
                        transparency: finalOpacity,
                        roughness: std.roughness,
                        metalness: std.metalness,
                        envIntensity: targetEnvIntensity,
                        source: infoSource,
                        colorHex: infoColorHex,
                        transmission: std.isMeshPhysicalMaterial ? clamp01(std.transmission ?? 0) : 0,
                        attenuationDistance: std.attenuationDistance,
                        attenuationColor: targetAttenuationColorHex,
                    };
                    if (targetRefraction != null) info.refraction = targetRefraction;
                    std.userData.glassInfo = info;

                    std.needsUpdate = true;

                    if (Array.isArray(o.material)) { o.material[i] = std; } else { o.material = std; }
                    cacheOriginalMaterialFor(o, true);
                });
            });
            requestRender();
        }

        function resetGlassToOriginal() {
            let firstOriginal = null;

            world.traverse(o => {
                if (o.userData?.isCollision) return;
                if (!o.isMesh || !o.material) return;
                const mats = Array.isArray(o.material) ? o.material : [o.material];
                mats.forEach((m, i) => {
                    const nameStr = `${m.name || ''} ${o.name || ''}`;
                    const geomSuffix = findGeomSuffix(nameStr);
                    const glass = isGlassByName(nameStr) || isGlassGeomSuffix(geomSuffix);
                    if (!glass) return;

                    const std = toStandard(m);
                    std.userData ||= {};

                    const original = std.userData.glassOriginal;
                    if (!original) return;
                    if (!firstOriginal) firstOriginal = { ...original };

                    if (std.userData.glassOverrides) delete std.userData.glassOverrides;

                    if (original.opacity != null) std.opacity = clamp01(original.opacity);
                    if (!std.metalnessMap && original.metalness != null) std.metalness = clamp01(original.metalness);
                    if (!std.roughnessMap && original.roughness != null) std.roughness = clamp01(original.roughness);
                    if (original.envIntensity != null) std.envMapIntensity = original.envIntensity;
                    if (original.color) {
                        const colorHex = normalizeHexColor(original.color, null);
                        if (colorHex) {
                            try { std.color.set(colorHex); } catch (_) {}
                        }
                    }
                    if (original.refraction != null && 'ior' in std) {
                        std.ior = original.refraction;
                        std.userData.refraction = original.refraction;
                    }
                    if (original.transmission != null && 'transmission' in std) {
                        std.transmission = clamp01(original.transmission);
                        std.transparent = std.transmission > 0.01 || std.opacity < 0.999;
                    }
                    if (original.attenuationDistance != null && 'attenuationDistance' in std) {
                        std.attenuationDistance = original.attenuationDistance;
                    }
                    if (original.attenuationColor) {
                        const attHex = normalizeHexColor(original.attenuationColor, original.color || null);
                        if (attHex) {
                            try {
                                if (std.attenuationColor?.isColor) std.attenuationColor.set(attHex);
                                else std.attenuationColor = new THREE.Color(attHex);
                            } catch (_) {}
                        }
                    }

                    std.needsUpdate = true;

                    if (Array.isArray(o.material)) { o.material[i] = std; } else { o.material = std; }
                });
            });

            if (firstOriginal) {
                if (glassOpacityEl && firstOriginal.opacity != null) {
                    glassOpacityEl.value = clamp01(firstOriginal.opacity).toFixed(2);
                    delete glassOpacityEl.dataset.userSet;
                }
                if (glassReflectEl && firstOriginal.envIntensity != null) {
                    const min = Number.isFinite(parseFloat(glassReflectEl.min)) ? parseFloat(glassReflectEl.min) : 0;
                    const max = Number.isFinite(parseFloat(glassReflectEl.max)) ? parseFloat(glassReflectEl.max) : 5;
                    const val = Number.isFinite(firstOriginal.envIntensity) ? firstOriginal.envIntensity : parseFloat(glassReflectEl.value ?? '1');
                    const clamped = Math.min(max, Math.max(min, val));
                    glassReflectEl.value = clamped.toFixed(2);
                    delete glassReflectEl.dataset.userSet;
                }
                if (glassMetalEl && firstOriginal.metalness != null) {
                    glassMetalEl.value = clamp01(firstOriginal.metalness).toFixed(2);
                    delete glassMetalEl.dataset.userSet;
                }
                if (glassRoughEl && firstOriginal.roughness != null) {
                    glassRoughEl.value = clamp01(firstOriginal.roughness).toFixed(2);
                    delete glassRoughEl.dataset.userSet;
                }
                if (glassIorEl && firstOriginal.refraction != null) {
                    const safe = Math.min(Math.max(firstOriginal.refraction, 1.0), 2.5);
                    glassIorEl.value = safe.toFixed(2);
                    delete glassIorEl.dataset.userSet;
                }
                if (glassTransmissionEl && firstOriginal.transmission != null) {
                    glassTransmissionEl.value = clamp01(firstOriginal.transmission).toFixed(2);
                    delete glassTransmissionEl.dataset.userSet;
                }
                if (glassAttenDistEl && firstOriginal.attenuationDistance != null) {
                    glassAttenDistEl.value = Number(firstOriginal.attenuationDistance).toFixed(2);
                    delete glassAttenDistEl.dataset.userSet;
                }
                if (glassAttenColorEl) {
                    const attHex = normalizeHexColor(firstOriginal.attenuationColor, '#FFFFFF') || '#FFFFFF';
                    glassAttenColorEl.value = attHex;
                    delete glassAttenColorEl.dataset.userSet;
                }
                if (glassColorEl) {
                    const colorHex = normalizeHexColor(firstOriginal.color, '#FFFFFF') || '#FFFFFF';
                    glassColorEl.value = colorHex;
                    delete glassColorEl.dataset.userSet;
                }
            } else if (glassColorEl) {
                delete glassColorEl.dataset.userSet;
                glassOpacityEl && delete glassOpacityEl.dataset.userSet;
                glassMetalEl && delete glassMetalEl.dataset.userSet;
                glassReflectEl && delete glassReflectEl.dataset.userSet;
                glassRoughEl && delete glassRoughEl.dataset.userSet;
                glassIorEl && delete glassIorEl.dataset.userSet;
                glassTransmissionEl && delete glassTransmissionEl.dataset.userSet;
                glassAttenDistEl && delete glassAttenDistEl.dataset.userSet;
                glassAttenColorEl && delete glassAttenColorEl.dataset.userSet;
            }

            updateAllGlassDisplays();
            applyGlassControlsToScene();
            schedulePanelRefresh();
        }


        if (sunHourEl && sunHourInputEl) {
            sunHourInputEl.value = formatSunHour(parseFloat(sunHourEl.value));
            sunHourEl.addEventListener('input', () => {
                sunHourInputEl.value = formatSunHour(parseFloat(sunHourEl.value));
            });
            sunHourInputEl.addEventListener('change', () => {
                const parsed = parseSunHour(sunHourInputEl.value);
                if (parsed == null) {
                    sunHourInputEl.value = formatSunHour(parseFloat(sunHourEl.value));
                    return;
                }
                sunHourEl.value = String(parsed);
                sunHourInputEl.value = formatSunHour(parsed);
                sunHourEl.dispatchEvent(new Event('input', { bubbles: true }));
            });
        }

        if (sunIntensityEl && sunIntensityInputEl && dirLight) {
            sunIntensityEl.value = String(dirLight.intensity);
            sunIntensityInputEl.value = formatSunIntensity(dirLight.intensity);
            sunIntensityEl.addEventListener('input', () => {
                const value = clampNumericInput(parseFloat(sunIntensityEl.value), parseFloat(sunIntensityEl.min) || 0, parseFloat(sunIntensityEl.max) || 20);
                if (value == null) return;
                dirLight.intensity = value;
                sunIntensityEl.value = String(value);
                sunIntensityInputEl.value = formatSunIntensity(value);
                requestRender();
            });
            sunIntensityInputEl.addEventListener('change', () => {
                let value = clampNumericInput(parseFloat(sunIntensityInputEl.value), parseFloat(sunIntensityInputEl.min) || 0, parseFloat(sunIntensityInputEl.max) || 20);
                if (value == null) {
                    sunIntensityInputEl.value = formatSunIntensity(dirLight.intensity);
                    return;
                }
                sunIntensityEl.value = String(value);
                sunIntensityInputEl.value = formatSunIntensity(value);
                dirLight.intensity = value;
                requestRender();
            });
        }

        const handleGlobalGlassInput = () => {
            applyGlassControlsToScene();
            schedulePanelRefresh();
            requestRender();
        };

        function clampValueToSlider(slider, value) {
            let next = value;
            const minAttr = slider.getAttribute('min');
            const maxAttr = slider.getAttribute('max');
            const min = minAttr !== null && minAttr !== '' ? parseFloat(minAttr) : null;
            const max = maxAttr !== null && maxAttr !== '' ? parseFloat(maxAttr) : null;
            if (Number.isFinite(min)) next = Math.max(next, min);
            if (Number.isFinite(max)) next = Math.min(next, max);
            return next;
        }

        function snapValueToStep(slider, value) {
            const stepAttr = slider.getAttribute('step');
            if (!stepAttr || stepAttr === 'any') return value;
            const step = parseFloat(stepAttr);
            if (!Number.isFinite(step) || step <= 0) return value;
            const minAttr = slider.getAttribute('min');
            const origin = minAttr !== null && minAttr !== '' ? parseFloat(minAttr) : 0;
            const steps = Math.round((value - origin) / step);
            return origin + steps * step;
        }

        const commitGlassDisplayInput = (id) => {
            const entry = glassValueDisplays.get(id);
            if (!entry) return;
            const { input: slider, display } = entry;
            if (!slider || !(display instanceof HTMLInputElement)) return;

            if (slider.type === 'color') {
                const normalized = normalizeHexColor(display.value, null);
                if (!normalized) {
                    updateGlassDisplay(id);
                    return;
                }
                if (slider.value === normalized) {
                    slider.dataset.userSet = '1';
                    updateGlassDisplay(id);
                    return;
                }
                slider.value = normalized;
                display.value = normalized;
                slider.dataset.userSet = '1';
                updateGlassDisplay(id);
                handleGlobalGlassInput();
                return;
            }

            const raw = display.value.replace(',', '.').trim();
            const parsed = parseFloat(raw);
            if (!Number.isFinite(parsed)) {
                updateGlassDisplay(id);
                return;
            }

            let next = clampValueToSlider(slider, parsed);
            next = snapValueToStep(slider, next);
            next = clampValueToSlider(slider, next);

            const decimals = sliderStepDecimals(slider);
            const formatted = Number.isFinite(decimals) ? next.toFixed(decimals) : String(next);

            if (slider.value === formatted) {
                slider.dataset.userSet = '1';
                updateGlassDisplay(id);
                return;
            }

            slider.value = formatted;
            display.value = formatted;
            slider.dataset.userSet = '1';
            updateGlassDisplay(id);
            handleGlobalGlassInput();
        };

        function attachGlassDisplayInputs() {
            glassValueDisplays.forEach(({ display }, id) => {
                if (!(display instanceof HTMLInputElement)) return;
                const commit = () => commitGlassDisplayInput(id);
                display.addEventListener('change', commit);
                display.addEventListener('blur', commit);
                display.addEventListener('keydown', (event) => {
                    if (event.key === 'Enter') {
                        event.preventDefault();
                        commit();
                    } else if (event.key === 'Escape') {
                        updateGlassDisplay(id);
                        display.blur();
                    }
                });
            });
        }
        attachGlassDisplayInputs();

        if (glassOpacityEl) {
            glassOpacityEl.addEventListener('input', () => {
                glassOpacityEl.dataset.userSet = '1';
                updateGlassDisplay('glassOpacity');
                handleGlobalGlassInput();
            });
        }
        if (glassReflectEl) {
            glassReflectEl.addEventListener('input', () => {
                glassReflectEl.dataset.userSet = '1';
                updateGlassDisplay('glassReflect');
                handleGlobalGlassInput();
            });
        }
        if (glassMetalEl) {
            glassMetalEl.addEventListener('input', () => {
                glassMetalEl.dataset.userSet = '1';
                updateGlassDisplay('glassMetal');
                handleGlobalGlassInput();
            });
        }
        if (glassRoughEl) {
            glassRoughEl.addEventListener('input', () => {
                glassRoughEl.dataset.userSet = '1';
                updateGlassDisplay('glassRough');
                handleGlobalGlassInput();
            });
        }
        if (glassIorEl) {
            glassIorEl.addEventListener('input', () => {
                glassIorEl.dataset.userSet = '1';
                updateGlassDisplay('glassIor');
                handleGlobalGlassInput();
            });
        }
        if (glassTransmissionEl) {
            glassTransmissionEl.addEventListener('input', () => {
                glassTransmissionEl.dataset.userSet = '1';
                updateGlassDisplay('glassTransmission');
                handleGlobalGlassInput();
            });
        }
        if (glassAttenDistEl) {
            glassAttenDistEl.addEventListener('input', () => {
                glassAttenDistEl.dataset.userSet = '1';
                updateGlassDisplay('glassAttenDist');
                handleGlobalGlassInput();
            });
        }
        if (glassAttenColorEl) {
            glassAttenColorEl.addEventListener('input', () => {
                glassAttenColorEl.dataset.userSet = '1';
                updateGlassDisplay('glassAttenColor');
                handleGlobalGlassInput();
            });
        }
        if (glassColorEl) {
            glassColorEl.addEventListener('input', () => {
                glassColorEl.dataset.userSet = '1';
                updateGlassDisplay('glassColor');
                handleGlobalGlassInput();
            });
        }
        glassResetBtn?.addEventListener('click', resetGlassToOriginal);

        // =====================
        // Auto-bind based on filenames
        // =====================

        function findTexEntryByURL(url) {
        return (allEmbedded || []).find(e => e && e.url === url) || null;
        }

        function labelFromURL(url) {
        const e = findTexEntryByURL(url);
        // отдаём настоящее имя файла (full или short), иначе хоть basename(url)
        const s = e?.full || e?.short || '';
        if (s) return s.split(/[\\/]/).pop();
        // blob: ссылки имён не содержат — вернём хоть последний сегмент
        try {
            const u = new URL(url);
            return u.pathname.split('/').pop() || '(texture)';
        } catch {
            return '(texture)';
        }
        }
        // =====================
        // VPM (SM_) — индексация текстур и привязка по UDIM+Slot
        // =====================

                    // // …_Vl_35_Ground.fbx → "35_ground"
                    // function vpmKeyFromFbxName(fbxFilename){
                    //     const base = basename(fbxFilename).replace(/\.[^.]+$/,'');
                    //     const parts = base.split('_').filter(Boolean);
                    //     if (parts.length < 3) return null;
                    //     return parts.slice(-2).join('_').toLowerCase();
                    // }

                    // // …_Vl_35_Ground_Diffuse_1.1002.png → "35_ground"
                    // const VPM_CHANNEL_RX = /^(diffuse|normal|erm|ao|alpha|opacity)$/i;
                    // function vpmKeyFromTexName(texFilename){
                    //     const base = basename(texFilename).replace(/\.[^.]+$/,'');
                    //     const parts = base.split('_').filter(Boolean);
                    //     const chanIdx = parts.findIndex(p => VPM_CHANNEL_RX.test(p));
                    //     if (chanIdx > 1) return parts.slice(chanIdx - 2, chanIdx).join('_').toLowerCase();
                    //     return null;
                    // }

        function vpmKeyFromFbxName(fbxName){
            const base = basename(fbxName).replace(/\.[^.]+$/,'');
            const parts = base.split('_');
            return parts.slice(-2).join('_').toLowerCase();   // напр. "Vl_35" или "35_Ground"
        }

            function vpmKeyFromTexName(texLabel){
            const base = texLabel.replace(/\.[^.]+$/,'').replace(/\.(10\d{2})$/,''); // убрать .1001
            const tokens = base.split('_');
            const chIdx = tokens.findIndex(t => /^(diffuse|normal|erm)$/i.test(t));
            if (chIdx >= 2) return (tokens[chIdx-2] + '_' + tokens[chIdx-1]).toLowerCase();
            return tokens.slice(-2).join('_').toLowerCase();
        }

            function parseVpmParts(label){
            const m = /_(Diffuse|Normal|ERM)_(\d+)\.(10\d{2})\b/i.exec(label);
            if (!m) return null;
            return {
                channel: m[1],               // 'Diffuse' | 'Normal' | 'ERM'
                slot: parseInt(m[2],10),     // число до точки
                udim: parseInt(m[3],10)      // 1001..1040
            };
        }

            // строим: Map<fbxKey, Map<`${slot}.${udim}`, {Diffuse,Normal,ERM}>>
        // =====================================================================
        // VPM (SM) helpers — индекс карт и разбивка ERM
        // =====================================================================

        /**
         * Строит индекс T_* текстур, присутствующих в ZIP, сгруппированных по ключу FBX.
         * Формат: Map<fbxKey, Map<`${slot}.${udim}`, { Diffuse, Normal, ERM }>>
         */
        function buildVPMIndex(allImages){
            const byFBX = new Map();
            for (const e of allImages){
                if (!e?.url) continue;
                const label = labelFromURL(e.url);
                const parts = parseVpmParts(label);
                if (!parts) continue;
                const fbxKey = vpmKeyFromTexName(label);
                const key2 = `${parts.slot}.${parts.udim}`;

                let sub = byFBX.get(fbxKey);
                if (!sub){ sub = new Map(); byFBX.set(fbxKey, sub); }

                let rec = sub.get(key2);
                if (!rec){ rec = {}; sub.set(key2, rec); }

                rec[parts.channel] = e.url; // Diffuse/Normal/ERM → URL
            }
            return byFBX;
        }

        // T_Адрес_(Diffuse|ERM|Normal)_<slot>.<udim>.(png|jpg|jpeg|webp)
        const RX_VPM_TEX = /(?:^|\/)T_.+_(Diffuse|ERM|Normal)_(\d+)\.(\d{4})\.(?:png|jpe?g|webp)$/i;

        /**
         * Разбирает имя texture entry из ZIP (формат T_*_Diffuse_1.1001.png) в структуру {kind, slot, udim}.
         */
        function parseVPMTexEntry(entry){
            const nm = String(entry?.full || entry?.short || '');
            const m = nm.match(RX_VPM_TEX);
            if (!m) return null;
            const kind = m[1];                    // Diffuse | ERM | Normal
            const slot = parseInt(m[2], 10);
            const udim = parseInt(m[3], 10);
            if (!Number.isFinite(slot) || !Number.isFinite(udim)) return null;
            return { kind, slot, udim, url: entry.url };
        }

        /**
         * Строит упрощённый индекс для автопривязки: ключ `${slot}.${udim}` → { Diffuse?, ERM?, Normal? }.
         */
        function buildVPMIndexFromImages(images){
            const map = new Map(); // key -> {Diffuse,ERM,Normal}
            (images || []).forEach(e => {
                const p = parseVPMTexEntry(e);
                if (!p) return;
                const key = `${p.slot}.${p.udim}`;
                if (!map.has(key)) map.set(key, {});
                map.get(key)[p.kind] = p.url;
            });
            return map;
        }

        /**
         * Разделяет ERM-карту (RGB: emissive/roughness/metalness) на отдельные CanvasTexture в линейном цветовом пространстве.
         */
        async function splitERMtoThreeMaps(url){
            const img = await createImageBitmap(await (await fetch(url)).blob());
            const w = img.width, h = img.height;

            const base = document.createElement('canvas'); base.width=w; base.height=h;
            const bctx = base.getContext('2d', { willReadFrequently:true }); 
            bctx.drawImage(img, 0, 0);

            function chanToTex(ci){
                const c = document.createElement('canvas'); c.width=w; c.height=h;
                const ctx = c.getContext('2d');
                const src = bctx.getImageData(0,0,w,h);
                const dst = ctx.createImageData(w,h);
                for (let i=0;i<src.data.length;i+=4){
                    const v = src.data[i+ci];
                    dst.data[i]=dst.data[i+1]=dst.data[i+2]=v; dst.data[i+3]=255;
                }
                ctx.putImageData(dst,0,0);
                const t = new THREE.CanvasTexture(c);
                t.colorSpace = THREE.LinearSRGBColorSpace; // линейные для rough/metal/emissiveMap
                t.flipY = false;
                return t;
            }
            return {
                emissiveMap:  chanToTex(0), // R
                roughnessMap: chanToTex(1), // G
                metalnessMap: chanToTex(2)  // B
            };
        }

        // function detectSlotFromMatOrObj(o, m){
        //     // у тебя уже есть detectSlotFromMaterialName(name), переиспользуем:
        //     const byMat = detectSlotFromMaterialName(m?.name);
        //     if (byMat) return byMat;
        //     const byObj = detectSlotFromMaterialName(o?.name);
        //     if (byObj) return byObj;
        //     return 1; // запасной вариант
        // }

        /**
         * Вычисляет UDIM-тайл по геометрии: берёт средние координаты UV и конвертирует в 1001+.
         */
        function detectUDIMfromGeo(geo){
            const uv = geo?.getAttribute?.('uv');
            if (!uv) return 1001;
            let uMin=+Infinity, vMin=+Infinity, uMax=-Infinity, vMax=-Infinity;
            for (let i=0;i<uv.count;i++){
                const u=uv.getX(i), v=uv.getY(i);
                uMin=Math.min(uMin,u); vMin=Math.min(vMin,v);
                uMax=Math.max(uMax,u); vMax=Math.max(vMax,v);
            }
            const tileU = Math.floor((uMin+uMax)*0.5);
            const tileV = Math.floor((vMin+vMax)*0.5);
            return 1001 + tileU + tileV*10;
        }

        /**
         * Автоматически привязывает Diffuse/Normal/ERM карты к каждому UDIM-сабмешу модели ВПМ.
         * Перезаписывает материалы (clone → MeshStandardMaterial), применяет стекло, ERM и окружение.
         */
        async function autoBindVPMForModel(root, vpmIndex){
            const env = scene.environment;
            const envInt = parseFloat(iblIntEl.value);

            // 1) имя FBX и ключ набора (двойной хвост)
            const fileName =
                root?.userData?._fbxFileName ||
                (loadedModels.find(m => m.obj === root)?.name) ||
                null;

            if (!fileName) {
                logBind(`VPM: не удалось вычислить имя FBX — привязываю без фильтра`, 'warn');
            }

            const fbxKey = fileName ? vpmKeyFromFbxName(fileName) : null;
            const sub = fbxKey ? vpmIndex.get(fbxKey) : null;
            if (!sub) {
                logBind(`VPM: для набора ${fbxKey || '(unknown)'} нет индекса — пропускаю модель`, 'info');
                return;
            }

            const bindOps = []; // промисы (для ERM)

            root.traverse(o => {
                if (!o.isMesh || !o.geometry) return;
                if (o.userData?.isCollision) return;

                // 2) UDIM и SLOT для текущего меша
                const udim = o.userData?.udim || detectUDIMfromGeo(o.geometry);
                const slot = detectSlotFromMatOrObj(o, Array.isArray(o.material) ? o.material[0] : o.material);

                const primaryMat = Array.isArray(o.material) ? o.material[0] : o.material;
                const label = `${primaryMat?.name || ''} ${o.name || ''}`;
                const geomSuffix = findGeomSuffix(label);
                if (isGlassByName(label) || isGlassGeomSuffix(geomSuffix)) {
                    logBind(`VPM: пропущен стеклянный меш "${o.name}" (slot ${slot}, udim ${udim})`, 'info');
                    return;
                }

                logBind(`VPM: mesh="${o.name}" → slot=${slot}, udim=${udim}`, 'info');

                // 3) Берём набор карт для ЭТОГО FBX по ключу slot.udim
                const key = `${slot}.${udim}`;
                const set = sub.get(key);
                if (!set) {
                    logBind(`VPM: нет карт для slot=${slot}, udim=${udim}`, 'info');
                    return;
                }

                // (опция) двойная проверка хвоста: карта действительно от этого FBX?
                if (fbxKey) {
                    const anyUrl = set.Diffuse || set.Normal || set.ERM;
                    const texKey = anyUrl ? vpmKeyFromTexName(labelFromURL(anyUrl)) : null;
                    if (texKey && texKey !== fbxKey) {
                        logBind(`VPM: "${labelFromURL(anyUrl)}" → ключ ${texKey} ≠ ${fbxKey} — пропускаю`, 'info');
                        return;
                    }
                }

                // 4) Базовый материал → Standard-клон
                const base = toStandard(Array.isArray(o.material) ? o.material[0] : o.material);
                const mat = base.clone();
                const fallbackName = base.name || `M · UDIM ${udim}`;
                mat.name = base.name ? base.name : fallbackName;
                (mat.userData ||= {}).vpm = { key, slot, udim };

                // Diffuse
                if (set.Diffuse) {
                    const prevMap = mat.map || null;
                    const map = textureLoader.load(set.Diffuse);
                    const nm = labelFromURL(set.Diffuse);
                    map.name = nm;
                    map.userData ||= {};
                    map.userData.origName = nm;
                    map.colorSpace = THREE.SRGBColorSpace;
                    // map.flipY = false;
                    copyTextureSettings(prevMap, map);
                    mat.map = map;

                    // не для стекла — маска по альфа-каналу диффуза
                    const label = `${mat.name || ''} ${o.name || ''}`.toLowerCase();
                    const isGlass = /mainglass|groundglass|groundelglass/.test(label);
                    if (!isGlass) {
                        mat.transparent = false;             // маска, не блендинг
                        mat.depthWrite = true;
                        mat.alphaTest = Math.max(0.001, mat.alphaTest || 0.4);
                        if (renderer.capabilities?.isWebGL2) mat.alphaToCoverage = true;

                        const common = { map: mat.map, alphaTest: mat.alphaTest, side: THREE.FrontSide };
                        o.customDepthMaterial    = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, ...common });
                        o.customDistanceMaterial = new THREE.MeshDistanceMaterial(common);
                    }
                }

                // Normal
                if (set.Normal) {
                    const prevNormal = mat.normalMap || null;
                    const n = textureLoader.load(set.Normal);
                    const nm = labelFromURL(set.Normal);
                    n.name = nm;
                    n.userData ||= {};
                    n.userData.origName = nm;
                    n.colorSpace = THREE.LinearSRGBColorSpace; // нормали в линейном
                    // n.flipY = false;
                    copyTextureSettings(prevNormal, n);
                    mat.normalMap = n;
                    mat.normalScale = new THREE.Vector2(1,1);
                }

                // ERM (асинхронно распакуем каналы)
                if (set.ERM) {
                    const p = (async () => {
                        const maps = await splitERMtoThreeMaps(set.ERM);
                        const baseNm = labelFromURL(set.ERM);

                        if (maps.emissiveMap) {
                            maps.emissiveMap.name = `${baseNm} [R]`;
                            maps.emissiveMap.userData ||= {};
                            maps.emissiveMap.userData.origName = maps.emissiveMap.name;
                        }
                        if (maps.roughnessMap) {
                            maps.roughnessMap.name = `${baseNm} [G]`;
                            maps.roughnessMap.userData ||= {};
                            maps.roughnessMap.userData.origName = maps.roughnessMap.name;
                        }
                        if (maps.metalnessMap) {
                            maps.metalnessMap.name = `${baseNm} [B]`;
                            maps.metalnessMap.userData ||= {};
                            maps.metalnessMap.userData.origName = maps.metalnessMap.name;
                        }

                        mat.emissive = new THREE.Color(1,1,1);
                        mat.emissiveIntensity = 1.0;
                        mat.emissiveMap  = maps.emissiveMap;   // R
                        mat.roughnessMap = maps.roughnessMap;  // G
                        mat.metalnessMap = maps.metalnessMap;  // B
                        mat.metalness = 1.0;                   // карта задаёт финальное значение
                        mat.needsUpdate = true;

                        if (env) { mat.envMap = env; mat.envMapIntensity = envInt; }
                        o.material = mat;
                        cacheOriginalMaterialFor(o, true);
                        logBind(`VPM: Slot ${slot}, UDIM ${udim} → ${mat.name}`, 'ok');
                    })();
                    bindOps.push(p);
                } else {
                    if (env) { mat.envMap = env; mat.envMapIntensity = envInt; }
                    o.material = mat;
                    cacheOriginalMaterialFor(o, true);
                    logBind(`VPM: Slot ${slot}, UDIM ${udim} (без ERM) → ${mat.name}`, 'ok');
                }
            });

            await Promise.all(bindOps);
            requestRender();
            panelNeedsFullRefresh = true;
            schedulePanelRefresh();
        }






        function parseTexName(filename){
            const rawBase = basename(filename).replace(/\.[a-z0-9]+$/i, '');
            const base = rawBase.toLowerCase();
            const parts = rawBase.split('_');
            const lowerParts = base.split('_');

            // id в конце опционален → по умолчанию 1
            let id = 1;
            const last = lowerParts[lowerParts.length-1];
            if (/^\d+$/.test(last)) {
                id = parseInt(parts.pop(), 10);
                lowerParts.pop();
            }

            // поддерживаем оба порядка: ..._<geom>_<map>_[id] И ..._<map>_<geom>_[id]
            const a = lowerParts.slice(-2);
            if (a.length < 2) return null;
            let [p1,p2] = a;

            let geom, map;
            if (GEOM_SUFFIXES.includes(p1)) { geom = p1; map = p2; }
            else if (GEOM_SUFFIXES.includes(p2)) { geom = p2; map = p1; }
            else return null;

            const kindMap = { d:'base', n:'normal', o:'alpha', m:'metalness', r:'roughness' };
            const kind = kindMap[map] || guessKindFromName(filename);

            let code3 = null;
            const lowerGeomIndex = lowerParts.lastIndexOf(geom);
            if (lowerGeomIndex > 0) {
                const candidate = parts[lowerGeomIndex - 1];
                if (/^\d{3}$/i.test(candidate)) {
                    code3 = candidate.padStart(3, '0');
                }
            }

            return { id, geomSuffix: geom, mapSuffix: map, code3, kind };
        }

        function kindToSlot(kind) {
            switch (kind) {
                case 'base': return 'map';
                case 'normal': return 'normalMap';
                case 'alpha': return 'alphaMap';
                case 'metalness': return 'metalnessMap';
                case 'roughness': return 'roughnessMap';
                case 'ao': return 'aoMap';
                default: return null;
            }
        }

        function indexModelMaterials(root) {
            const idx = new Map();
            root.traverse(o => {
                if (!o.isMesh || !o.material) return;
                if (o.userData?.isCollision) return;
                const mats = Array.isArray(o.material) ? o.material : [o.material];
                mats.forEach((m, i) => {
                    const materialId = i + 1;
                    const label = `${m.name || ''} ${o.name || ''}`.toLowerCase();
                    const code3Match = label.match(/(^|[_\W])(\d{3})([_\W]|$)/);
                    const code3 = code3Match ? code3Match[2] : null;
                    const geom = findGeomSuffix(label);
                    const keys = [];
                    if (geom) { keys.push(`${code3 || '—'}|${geom}|${materialId}`); keys.push(`—|${geom}|${materialId}`); }
                    keys.push(`${code3 || '—'}|—|${materialId}`); keys.push(`—|—|${materialId}`);
                    keys.forEach(k => { if (!idx.has(k)) idx.set(k, { obj: o, material: m, slotIndex: i, materialId, geom, code3 }); });
                });
            });
            return idx;
        }

        /**
         * Автопривязка для "обычных" моделей (НПМ): сопоставление текстур по имени файла.
         * Ожидает входные embeddedList (файлы из ZIP/FBX) и обновляет материалы в сцене.
         */
        function autoBindByNamesForModel(root, fileName, embeddedList) {
            const history = [];
            const matIndex = indexModelMaterials(root);
            embeddedList.forEach(tex => {
                const p = parseTexName(tex.short);
                if (!p) { logBind(`⚠️ ${tex.short} — не распознан шаблон имени`, 'warn'); return; }
                const { id, geomSuffix, code3, kind } = p;
                const slot = kindToSlot(kind);
                if (!slot) { logBind(`⚠️ ${tex.short} — нераспознан тип карты`, 'warn'); return; }
                const keyWith = `${code3 || '—'}|${geomSuffix}|${id}`;
                const keyNoC3 = `—|${geomSuffix}|${id}`;
                let target = matIndex.get(keyWith) || matIndex.get(keyNoC3);

                if (!target && code3) {
                    for (const entry of matIndex.values()) {
                        if (!entry) continue;
                        if (entry.geom === geomSuffix && entry.code3 === code3 && entry.materialId === id) {
                            target = entry;
                            break;
                        }
                    }
                }

                if (!target && code3) {
                    for (const entry of matIndex.values()) {
                        if (!entry) continue;
                        if (entry.geom === geomSuffix && entry.code3 === code3) {
                            target = entry;
                            break;
                        }
                    }
                }

                if (!target) { logBind(`⚠️ ${tex.short} — нет материала по «${code3 || '—'} / ${geomSuffix} / id:${id}»`, 'warn'); return; }

                const mats = Array.isArray(target.obj.material) ? target.obj.material : [target.obj.material];
                let m = mats[target.slotIndex];
                m = toStandard(m);
                mats[target.slotIndex] = m; target.obj.material = Array.isArray(target.obj.material) ? mats : m;
                cacheOriginalMaterialFor(target.obj, true);

                const currentTexture = m[slot] || null;
                const t = textureLoader.load(tex.url);
                const humanName = basename(tex.full || tex.short);
                t.name = humanName; (t.userData ||= {}).origName = humanName;
                t.colorSpace = (slot === 'map' || slot === 'emissiveMap') ? THREE.SRGBColorSpace : THREE.LinearSRGBColorSpace;
                t.userData.autoBound = true;

                const existingName = currentTexture && (currentTexture.userData?.origName || currentTexture.name || '').toLowerCase();
                const newName = humanName.toLowerCase();
                const sameTexture = currentTexture && existingName && existingName === newName;

                if (currentTexture && !sameTexture) {
                    logBind(`ℹ️ ${tex.short} — слот ${slot} будет перезаписан`, 'info');
                }

                if (currentTexture && sameTexture) {
                    logBind(`ℹ️ ${tex.short} — слот ${slot} уже содержит эту карту`, 'info');
                    return;
                }

                copyTextureSettings(currentTexture, t);

                if (currentTexture && !sameTexture) {
                    currentTexture.dispose?.();
                }

                if (slot === 'roughnessMap') { m.roughnessMap = t; m.roughness = 0.6; }
                else if (slot === 'metalnessMap') { m.metalnessMap = t; m.metalness = 1.0; }
                else if (slot === 'alphaMap') { m.alphaMap = t; m.alphaTest = 0.5; m.transparent = false; m.depthWrite = true; }
                else { m[slot] = t; }

                if (scene.environment) { m.envMap = scene.environment; m.envMapIntensity = parseFloat(iblIntEl.value); }
                m.needsUpdate = true;
                history.push({ obj: target.obj, matIndex: target.slotIndex, slot, prev: currentTexture || null, url: tex.url, tex: t });
                logBind(`✅ ${tex.short} → ${m.name || 'материал'}.${slot}`, 'ok');
            });
            if (history.length) undoStack.push({ fileName, bindings: history });
        }

        // =====================
        // Dropdown & material collection
        // =====================
        /**
         * Пересобирает выпадающий список материалов для ручной привязки текстур.
         */
        function rebuildMaterialsDropdown() {
            const items = collectMaterialsFromWorld();
            matSelect.innerHTML = '<option value="">— выберите материал —</option>';
            items.forEach((it, i) => {
                const opt = document.createElement('option'); opt.value = String(i); opt.textContent = it.label; matSelect.appendChild(opt);
            });
            matSelect.dataset._map = JSON.stringify(items.map((x, idx) => ({ idx, path: x.path })));
        }

        /**
         * Собирает материалы из сцены (кроме коллизий) для выпадающего списка.
         */
        function collectMaterialsFromWorld() {
            const out = [];
            world.traverse(o => {
                if (!o.isMesh) return;
                if (o.userData?.isCollision) return; // 👈 не показываем UCX в выпадающем списке
                const mats = getPanelMaterials(o);
                if (!mats.length) return;
                mats.forEach((m, i) => {
                    const humanIdx = i + 1;
                    const label = `${o.name || o.type} · ${m.type}${m.name ? ` (${m.name})` : ''}${mats.length > 1 ? ` [${humanIdx}]` : ''}`;
                    out.push({ obj: o, index: i, label, path: `${o.uuid}:${i}` });
                });
            });
            return out;
        }

        /**
         * Возвращает объект { obj, index, mat } для текущего выбранного материала в выпадающем списке.
         */
        // =====================
        // File flow
        // =====================
        const fileInput = document.getElementById('fileInput');
        const openBtn = document.getElementById('openBtn');

        const registerFileOpenTrigger = (el) => {
            if (!el || !fileInput) return;
            el.addEventListener('click', () => fileInput.click());
        };
        registerFileOpenTrigger(openBtn);
        registerFileOpenTrigger(emptyHintEl);

        // =====================
        // LIGHT CONTROLL
        // =====================
        if (hemiIntEl) {
            hemiIntEl.addEventListener('input', (e) => {
                hemiLight.intensity = parseFloat(e.target.value);
            });
        }

        if (hemiSkyEl) {
            hemiSkyEl.addEventListener('input', (e) => {
                hemiLight.color.set(e.target.value);
            });
        }

        if (hemiGroundEl) {
            hemiGroundEl.addEventListener('input', (e) => {
                hemiLight.groundColor.set(e.target.value);
            });
        }

        if (fileInput) {
            fileInput.addEventListener('change', async (e) => {
                const files = [...(e.target.files || [])];
                for (const f of files) {
                    if (/\.fbx$/i.test(f.name)) {
                        await handleFBXFile(f);
                    } else if (/\.zip$/i.test(f.name)) {
                        await handleZIPFile(f);
                    }
                }
                if (fileInput) fileInput.value = '';
                setEmptyHintVisible(loadedModels.length === 0);
                await finalizeBatchAfterAllFiles();
            });
        }

        populateSampleSelect();
        if (sampleSelect) {
            sampleSelect.addEventListener('change', async () => {
                const idx = sampleSelect.selectedIndex;
                const sample = SAMPLE_MODELS[idx];
                if (!sample || !sample.files || !sample.files.length) return;
                await loadSampleModel(sample);
            });
        }

        ['dragenter','dragover'].forEach(ev => window.addEventListener(ev, e => { e.preventDefault(); dropEl.classList.add('show'); }));
        ['dragleave','drop'].forEach(ev => window.addEventListener(ev, e => { e.preventDefault(); if (ev === 'drop') return; dropEl.classList.remove('show'); }));

        window.addEventListener('drop', async e => {
            e.preventDefault(); dropEl.classList.remove('show');
            const files = [...(e.dataTransfer?.files || [])];
            for (const f of files) {
                if (/\.fbx$/i.test(f.name)) {
                    await handleFBXFile(f);
                } else if (/\.zip$/i.test(f.name)) {
                    await handleZIPFile(f);
                }
            }
            await finalizeBatchAfterAllFiles();
        });

        // =====================================================================
        // Asset Loading · Core Procedures
        // =====================================================================

        async function loadSampleModel(sample) {
            if (!sample || !sample.files || !sample.files.length) return;
            if (!statusEl) return;
            try {
                if (sampleSelect) sampleSelect.disabled = true;
                setStatusMessage(`Загрузка примера: ${sample.label}`);
                setEmptyHintVisible(false);
                hideSidePanel();

                const downloadedFiles = [];
                for (const url of sample.files) {
                    const response = await fetch(url, { cache: 'no-cache' });
                    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
                    const blob = await response.blob();
                    const base = url.split('?')[0];
                    const name = decodeURIComponent(base.split('/').pop() || 'sample.zip');
                    downloadedFiles.push(new File([blob], name, { type: blob.type || 'application/zip' }));
                }
                for (const file of downloadedFiles) await handleZIPFile(file);
                await finalizeBatchAfterAllFiles();

                setStatusMessage('');
                setEmptyHintVisible(loadedModels.length === 0);
            } catch (err) {
                console.error(err);
                setStatusMessage(`Ошибка загрузки примера: ${err?.message || err}`);
                setEmptyHintVisible(loadedModels.length === 0);
            } finally {
                if (sampleSelect) {
                    sampleSelect.disabled = false;
                    sampleSelect.value = '';
                }
            }
        }

        /**
         * Загружает одиночный FBX-файл: парсит ориентацию, применяет смещения (GeoJSON),
         * извлекает embedded текстуры, выполняет автопривязку и обновляет панель/шейдинг.
         */
        async function handleFBXFile(file, groupName = null, zipKind = null, zipMeta = null) {
        logSessionHeader(`FBX: ${file.name}`);
        hideSidePanel();

        // если zipKind не передали из handleZIPFile — определим по имени ZIP здесь
        if (!zipKind && groupName) {
            zipKind = /^\d/.test(groupName) ? 'NPM' : (/^SM/i.test(groupName) ? 'SM' : null);
        }

        let ab = await file.arrayBuffer();
        let orientationInfo = readFBXOrientationFromBuffer(ab);
        let orientationSource = orientationInfo?.source || null;
        let orientationMeta = determineOrientationType(orientationInfo);
        let orientationType = orientationMeta.type;

        const embedded = await extractImagesFromFBX(ab);
        embedded.forEach(e => e.fileName = file.name);
        if (embedded.length) {
            allEmbedded.push(...embedded);
            galleryNeedsRefresh = true;
        }

        setStatusMessage(`Парсинг FBX: ${file.name}…`);

        let parsedObj = null;
        let parsedViaWorker = false;
        let parseDuration = 0;

        if (fbxWorkerSupported) {
            try {
                const workerResult = await parseFBXInWorker(ab);
                parsedObj = workerResult.obj;
                parsedViaWorker = true;
                parseDuration = workerResult.duration;
            } catch (err) {
                logBind(`FBX: фон. парсер не сработал → ${err?.message || err}`, 'warn');
                fbxWorkerSupported = false;
                try {
                    ab = await file.arrayBuffer();
                } catch (reloadErr) {
                    logBind(`FBX: повторное чтение файла не удалось → ${reloadErr?.message || reloadErr}`, 'warn');
                    throw err;
                }
            }
        }

        if (!parsedObj) {
            try {
                const mainResult = parseFBXOnMainThread(ab);
                parsedObj = mainResult.obj;
                parseDuration = mainResult.duration;
            } catch (err) {
                setStatusMessage(`Ошибка парсинга: ${file.name}`);
                logBind(`⚠️ Ошибка парсинга ${file.name}: ${err?.message || String(err)}`, 'warn');
                throw err;
            }
        }

        const obj = parsedObj;
        if (!obj) {
            setStatusMessage(`Ошибка парсинга: ${file.name}`);
            logBind(`⚠️ Парсер FBX вернул пустой объект для ${file.name}`, 'warn');
            return;
        }

        setStatusMessage('Обработка сцены…');

        if (typeof window !== 'undefined') {
            window.__fbxLoader = fbxLoader;
            window.__lastFBXLoaded = obj;
            window.__fbxParsedInWorker = parsedViaWorker;
        }

        obj.userData._fbxFileName = file.name;

        if (!orientationInfo && obj.userData?.fbxTree) {
            const infoFromTree = readFBXOrientationFromTree(obj.userData.fbxTree);
            if (infoFromTree) {
                orientationInfo = infoFromTree;
                orientationSource = infoFromTree.source || 'tree';
                orientationMeta = determineOrientationType(orientationInfo);
                orientationType = orientationMeta.type;
            }
        }
        if (!orientationInfo) {
            const infoFromGeom = parseOrientationFromNode(obj);
            if (infoFromGeom) {
                orientationInfo = infoFromGeom;
                orientationSource = infoFromGeom.source || 'geometry';
                orientationMeta = determineOrientationType(orientationInfo);
                orientationType = orientationMeta.type;
            }
        }

        if (orientationInfo) {
            orientationInfo.type = orientationType;
            orientationInfo.handedness = orientationMeta.handedness;
            orientationInfo.upAxisResolved = orientationMeta.upAxis;
            obj.userData.orientation = orientationInfo;
            const sourceLabels = { binary: 'GlobalSettings', tree: 'fbxTree' };
            const src = sourceLabels[orientationSource] || orientationSource || 'unknown';
            logBind(`FBX: ориентация (${src}; ${describeOrientationType(orientationType)}) — ${describeFBXOrientation(orientationInfo)}`, 'info');
        } else {
            logBind(`FBX: ориентация — не найдена (тип: ${describeOrientationType(orientationType)})`, 'warn');
        }

        if (parseDuration) {
            logBind(`FBX: парсинг ${parsedViaWorker ? 'в воркере' : 'на UI-потоке'} занял ${Math.round(parseDuration)} мс`, 'info');
        }

        obj.userData.orientationType = orientationType;
        obj.userData.orientationHandedness = orientationMeta.handedness;
        obj.userData.orientationUpAxis = orientationMeta.upAxis;

        normalizeObjectOrientation(obj, orientationType);

        // ★ NEW: если это ВПМ и есть geojson — сохраним мету и применим смещение
        if ((zipKind || '').toUpperCase() === 'SM' && zipMeta) {
            obj.userData._geojsonMeta = zipMeta;

            const { x, y, z } = getSMOffset(zipMeta);

            applyGeoOffsetByOrientation(obj, orientationType, { x, y, z });

            logBind(`VPM: смещение для ${file.name} из GeoJSON → Δx=${x} Δy=${y} Δz=${z}`, 'ok');
        }

        world.add(obj);

        restoreLightTargetsFromOrientation(obj);
        disableShadowsOnImportedLights(obj);
        ensureLightHelpers(obj);

        renameMaterialsByFBXObject(obj);

        obj.traverse(o => {
            if (!o.isMesh) return;
            const mats = Array.isArray(o.material) ? o.material : [o.material];

            let willCast = false;
            mats.forEach(m => {
                if (m.side === THREE.DoubleSide) m.shadowSide = THREE.FrontSide;

                const hasMask = !!m.alphaMap || (m.alphaTest > 0);
                const trulyTransparent = m.transparent && !hasMask;

                if (hasMask) {
                    m.transparent = false;
                    m.alphaTest = Math.max(0.001, m.alphaTest || 0.5);
                    m.depthWrite = true;
                    willCast = true;
                } else if (!trulyTransparent) {
                    willCast = true;
                }
            });

            o.castShadow = willCast;
            o.receiveShadow = true;
        });

        markCollisionMeshes(obj);

        if ((zipKind || '').toUpperCase() === 'SM' || (obj.userData?.zipKind || '').toUpperCase() === 'SM') {
            splitAllMeshesByUDIM_SM(obj);
        }
        optimizeGlassMeshes(obj);
        loadedModels.push({
            obj,
            name: file.name,
            group: groupName || null,
            zipKind: zipKind || null,
            geojson: zipMeta || null,
            orientation: orientationInfo || null,
            orientationType
        });
        obj.userData.zipGroup = groupName || null;
        obj.userData.zipKind  = zipKind || null;

        if ((zipKind || '').toUpperCase() === 'SM' || /^SM_/i.test(file.name)) {
            logBind(`VPM: отложенная автопривязка для ${file.name}`, 'info');
        } else {
            autoBindByNamesForModel(obj, file.name, embedded);
        }
        setImportedLightsEnabled(importedLightsEnabled, obj, { silent: true });
        applyGlassControlsToScene();
        setEmptyHintVisible(false);
        markSceneStatsDirty();

        schedulePanelRefresh();
        requestRender();
        setStatusMessage('');
        }
        /**
         * Обработка ZIP-архива: находит FBX/текстуры/GeoJSON, загружает FBX, сохраняет текстуры,
         * привязывает GeoJSON к моделям и обновляет UI.
         */
        async function handleZIPFile(file) {
            logSessionHeader(`ZIP: ${file.name}`);
            setStatusMessage(`Чтение ZIP: ${file.name}…`);
            hideSidePanel();

            const zipKind = /^\d/.test(file.name) ? 'NPM' : /^SM/i.test(file.name) ? 'SM' : null;
            const zip = await JSZip.loadAsync(file);
            const entries = Object.values(zip.files);

            // 1) прочитаем geojson (если есть) — один на ZIP
            // let zipGeoMeta = null;
            // const geoEntry = entries.find(e => !e.dir && /\.geojson$/i.test(e.name));
            // if (geoEntry) {
            //     const geoText = await geoEntry.async('string');
            //     zipGeoMeta = makeGeoJsonMeta(file.name, geoEntry.name, geoText);
            // }


            // ↓↓↓ ТОЛЬКО ДЛЯ ВПМ
            let zipGeoMeta = null;
            if (zipKind === 'SM') {
                const geoEntries = entries.filter(e => !e.dir && /\.geojson$/i.test(e.name));
                if (geoEntries.length) {
                const bytes = await geoEntries[0].async('uint8array');
                let geoText = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
                // снять BOM, если есть
                geoText = geoText.replace(/^\uFEFF/, '');
                
                zipGeoMeta = makeGeoJsonMeta(file.name, geoEntries[0].name, geoText);
                logBind(`GeoJSON: найден в «${file.name}» → ${geoEntries[0].name}`, 'ok');
                } else {
                logBind(`GeoJSON: в «${file.name}» не найден (ВПМ без меты)`, 'info');
                }
            }


           // Сначала FBX — каждому передаём zipGeoMeta (для SM) или null (для NPM/прочих)
            for (const entry of entries) {
                if (entry.dir) continue;
                if (/\.fbx$/i.test(entry.name)) {
                const ab = await entry.async("arraybuffer");
                const fbxFile = new File([ab], basename(entry.name), { type: "model/fbx" });
                await handleFBXFile(fbxFile, file.name, zipKind, zipGeoMeta);
                setEmptyHintVisible(false);
                }
            }

            // Затем картинки как было
            for (const entry of entries) {
                if (entry.dir) continue;
                if (/\.(png|jpe?g|webp)$/i.test(entry.name)) {
                    const blob = await entry.async("blob");
                    const url = URL.createObjectURL(blob);
                    const short = basename(entry.name).toLowerCase();
                    allEmbedded.push({ short, url, full: entry.name, mime: blob.type || "image/png", source: "zip" });
                    galleryNeedsRefresh = true;
                }
            }

            // 4) если в ZIP был geojson — прикрепим его ко ВСЕМ FBX из этого ZIP
            if (zipGeoMeta) {
                let attached = 0;
                loadedModels
                    .filter(m => m.group === file.name)      // модели, загруженные из этого же архива
                    .forEach(m => {
                        m.geojson = zipGeoMeta;              // для рендера в панели
                        (m.obj.userData ||= {}).geojson = zipGeoMeta; // на сам объект — если удобно обращаться из дерева
                        attached++;
                    });

                if (attached) {
                    logBind(`GeoJSON: прикреплён к ${attached} FBX из «${file.name}» (${zipGeoMeta.entryName}${zipGeoMeta.featureCount!=null ? `, features: ${zipGeoMeta.featureCount}` : ''})`, 'ok');
                    schedulePanelRefresh(); // перерисуем, чтобы появилась 📄
                } else {
                    logBind(`GeoJSON: файл найден в «${file.name}», но FBX из этого ZIP не обнаружены`, 'warn');
                }
            }

            ensureZipCollisionsHidden(file.name);

            setStatusMessage(`Готово: ${file.name}`);
        }

        /**
         * Финальный шаг после загрузки всех файлов: применяет HDRI/фокус, автопривязку ВПМ и перерисовывает UI.
         */
        async function finalizeBatchAfterAllFiles() {
            if (!loadedModels.length) return;

            const newModels = loadedModels.slice(lastFinalizedModelIndex);
            const hasNewModels = newModels.length > 0;
            const needGalleryRefresh = galleryNeedsRefresh;

            if (!hasNewModels && !needGalleryRefresh) {
                setStatusMessage('Готово');
                setEmptyHintVisible(loadedModels.length === 0);
                return;
            }

            if (needGalleryRefresh) {
                renderGallery(allEmbedded);
                galleryNeedsRefresh = false;
            }

            // — ребейз только один раз —
            let firstTime = false;
            if (!didInitialRebase && hasNewModels) {
                const off = computeAutoOffsetHorizontalOnly();
                setWorldOffset(off);
                didInitialRebase = true;
                firstTime = true;
            }

            if (hasNewModels) {
                if (iblChk.checked) {
                    await loadHDRBase();
                    await buildAndApplyEnvFromRotation(parseFloat(iblRotEl.value) || 0);
                }

                ensureBgMesh();
                bgMesh.material.map = currentBg || null;
                bgMesh.material.needsUpdate = true;
                updateBgVisibility();

                applyGlassControlsToScene();
                fitSunShadowToScene(true);
                updateSun();
            }

            const newSmModels = newModels.filter(m => (m.zipKind || '').toUpperCase() === 'SM');
            let modelsForBinding = newSmModels;
            if (!modelsForBinding.length && needGalleryRefresh) {
                modelsForBinding = loadedModels.filter(m => (m.zipKind || '').toUpperCase() === 'SM');
            }

            if (modelsForBinding.length) {
                try {
                    const vpmIndex = buildVPMIndex(allEmbedded);
                    for (const m of modelsForBinding) {
                        await autoBindVPMForModel(m.obj, vpmIndex);
                    }
                } catch (e) {
                    logBind(`⚠️ VPM: ошибка автопривязки — ${e?.message || e}`, 'warn');
                }
            }

            if (hasNewModels) {
                const smGroups = new Set();
                newModels.forEach(model => {
                    if ((model.zipKind || '').toUpperCase() !== 'SM') return;
                    if (model.group) smGroups.add(model.group);
                });
                smGroups.forEach(groupName => ensureZipCollisionsHidden(groupName));

                if (firstTime) {
                    fitAll();
                    focusOn(loadedModels.map(m => m.obj));
                }
            }

            const finalizeUI = () => {
                outEl.querySelectorAll('details[data-level="group"], details[data-level="file"]').forEach(d => d.open = false);
                if (firstTime) {
                    if (imagesDetails) imagesDetails.open = false;
                    if (bindLogDetails) bindLogDetails.open = false;
                }

                const hiddenAgain = hasNewModels ? hideSMCollisions(false) : false;
                if (hasNewModels || hiddenAgain) {
                    syncCollisionButtons();
                }

                setStatusMessage('Готово');
                setEmptyHintVisible(loadedModels.length === 0);
            };

            if (hasNewModels) {
                applyShading(currentShadingMode, finalizeUI);
            } else {
                finalizeUI();
            }

            if (hasNewModels) {
                lastFinalizedModelIndex = loadedModels.length;
            }
        }

        
        app.api = Object.freeze({
            applyShading,
            setEnvironmentEnabled,
            updateSun,
            focusOn,
            fitAll,
            computeSceneBounds,
            layout,
            updateBgVisibility,
            computeWorldCenter,
            setStatsVisible,
            requestRender,
        });
// =====================
        // Animation loop & init
        // =====================
        function animate() {
            requestAnimationFrame(animate);
            const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
            if (!lastFrameTime) lastFrameTime = now;
            const delta = now - lastFrameTime;
            lastFrameTime = now;

            const controlsChanged = controls.update();
            if (controlsChanged) needsRender = true;

            if (USE_WEBGPU && !rendererReady) {
                updateStatsOverlay();
                return;
            }

            if (!needsRender) {
                updateStatsOverlay();
                return;
            }

            if (delta > 0 && delta < 1000) {
                const instant = 1000 / delta;
                fpsEstimate = fpsEstimate ? (fpsEstimate * 0.9 + instant * 0.1) : instant;
            }

            needsRender = false;
            renderer.render(scene, camera);
            const info = renderer.info || {};
            lastRenderStats = {
                render: info.render ? { ...info.render } : {},
                memory: info.memory ? { ...info.memory } : {},
                programs: info.programs != null ? (Array.isArray(info.programs) ? info.programs.length : info.programs) : 0,
            };
            if (info.reset && renderer.info && renderer.info.autoReset === false) {
                info.reset();
            }
            updateStatsOverlay();
        }
        animate();
        layout();
        HDRI_LIBRARY.forEach((h, i) => {
            const opt = document.createElement('option');
            opt.value = i;
            opt.textContent = h.name;
            hdriPresetSel.appendChild(opt);
        });
        // IBL не запускаем автоматически — управляется чекбоксом
    }
}

const viewerApp = new ViewerApp();
if (typeof globalThis !== "undefined") {
    globalThis.viewerApp = viewerApp;
}

export default viewerApp;
