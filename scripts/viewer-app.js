import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import {
    configureParcels,
    loadParcels,
    createParcelsGroupFromGeoJSON,
    setVPMReferenceHeight,
    getVPMReferenceHeight,
} from './modules/parcels.js';
import { basename } from './modules/utils/path.js';
import { clamp01 } from './modules/utils/math.js';
import { normalizeHexColor } from './modules/utils/color.js';
import { createTextureLabelResolver } from './modules/utils/texture-labels.js';
import { makeGeoJsonMeta } from './modules/geo/geojson-meta.js';
import { getSMOffset } from './modules/geo/sm-offset.js';
import { createFBXWorkerClient } from './modules/workers/fbx-worker-client.js';
import { createZIPWorkerClient } from './modules/workers/zip-worker-client.js';
import { extractImagesFromFBX, sniffImage } from './modules/fbx/embedded-images.js';
import { createSceneGeometryStats } from './modules/scene/geometry-stats.js';
import { createStatsOverlayController } from './modules/ui/stats-overlay.js';
import { createSliderValueDisplayController } from './modules/ui/slider-value-displays.js';
import { createShadowDebugPanelController } from './modules/ui/shadow-debug-panel.js';
import { createTextureGalleryController } from './modules/ui/texture-gallery.js';
import { createVisibilityController } from './modules/ui/visibility.js';
import { createMaterialsPanelController } from './modules/ui/materials-panel.js';
import { createTextureModalController } from './modules/ui/texture-modal.js';
import { createEnvironmentManager, HDRI_LIBRARY } from './modules/render/environment-manager.js';
import { createShadowController } from './modules/render/shadow-controller.js';
import { createFBXFileHandler } from './modules/io/fbx-file.js';
import { createZIPFileHandler } from './modules/io/zip-file.js';
import { createFileFlowController } from './modules/io/file-flow.js';
import { createSampleLoader } from './modules/io/sample-loader.js';
import { createBatchFinalizer } from './modules/io/batch-finalizer.js';
import {
    detectSlotFromMatOrObj,
    findGeomSuffix,
    GEOM_SUFFIXES,
    isGlassByName,
    isGlassGeomSuffix,
} from './modules/material/naming.js';
import { createGlassController } from './modules/material/glass-controller.js';
import { createVPMBinder } from './modules/material/vpm-autobind.js';
import { createFilenameBinder } from './modules/material/filename-autobind.js';
import { copyTextureSettings } from './modules/material/texture-utils.js';
import { createToStandard } from './modules/material/to-standard.js';
import {
    applyGeoOffsetByOrientation,
    describeFBXOrientation,
    describeOrientationType,
    determineOrientationType,
    normalizeObjectOrientation,
    parseOrientationFromNode,
    readFBXOrientationFromTree,
} from './modules/fbx/orientation.js';
import { createCollisionVisibilityHelpers, markCollisionMeshes } from './modules/fbx/collisions.js';
import { splitAllMeshesByUDIM_SM } from './modules/fbx/udim-split.js';
import {
    BEAUTY_WIRE_ANGLE_DEG,
    clearBeautyWire,
    clearWireframeOverlay,
    ensureBeautyWire,
    ensureWireframeOverlay,
} from './modules/render/wire-overlays.js';

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
        let statusClearTimer = null;
        const emptyHintEl     = document.getElementById('emptyHint');

        const setStatusMessage = (message = '') => {
            if (!statusEl) return;
            if (statusClearTimer) {
                clearTimeout(statusClearTimer);
                statusClearTimer = null;
            }
            const hasMessage = !!(message && message.trim());
            statusEl.textContent = hasMessage ? message : '';
            statusEl.hidden = !hasMessage;
            if (appbarStatusEl && appbarStatusEl !== statusEl) {
                appbarStatusEl.textContent = statusEl.textContent;
            }
            if (hasMessage) {
                const norm = message.trim().toLowerCase();
                if (norm.startsWith('готово')) {
                    statusClearTimer = setTimeout(() => {
                        statusClearTimer = null;
                        setStatusMessage('');
                    }, 2000);
                }
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
        const resetViewerBtn  = document.getElementById('resetViewerBtn');
        const fullscreenBtn   = document.getElementById('fullscreenBtn');
        const statsBtn        = document.getElementById('statsBtn');
        const bgToggleBtn     = document.getElementById('bgToggleBtn');
        const gridToggleBtn   = document.getElementById('gridToggleBtn');
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

	        const outEl           = document.getElementById('out');
	        const galleryEl       = document.getElementById('gallery');
	        const texCountEl      = document.getElementById('texCount');
        const matSelect       = document.getElementById('matSelect');
        const bindLogEl       = document.getElementById('bindLog');

        const bgAlphaEl       = document.getElementById('bgAlpha');
	        bgAlphaEl.addEventListener('input', updateBgVisibility);

	        const sliderValueDisplays = createSliderValueDisplayController({ root: document });
	        [
	            ['hemiInt', hemiIntEl],
	            ['bgAlpha', bgAlphaEl],
	            ['iblInt', iblIntEl],
            ['iblGamma', iblGammaEl],
            ['iblRot', iblRotEl],
	            ['hdriExposure', hdriExposureEl],
	            ['hdriSaturation', hdriSaturationEl],
	            ['hdriBlur', hdriBlurEl],
	        ].forEach(([id, slider]) => sliderValueDisplays.register(id, slider));
	        sliderValueDisplays.updateAll();
	        sliderValueDisplays.attachInputs();

        const sampleSelect    = document.getElementById('sampleSelect');


	        let didInitialRebase = false;
	        let currentShadingMode = 'pbr';
	        let galleryNeedsRefresh = false;
	        let lastFinalizedModelIndex = 0;
	        let needsRender = true;
	        let parcelsGroup = null;
	        let parcelsOrigin = null;
			        let fpsEstimate = 0;
			        let lastFrameTime = 0;
			        let lastRenderStats = null;
			        let sceneGeometryStats = null;
			        let glassController = null;
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
            bgToggleBtn,
            gridToggleBtn,
            resetViewerBtn,
            fullscreenBtn,
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
        // scene.background = null;

	        const world    = new THREE.Group();
	        scene.add(world);

	        sceneGeometryStats = createSceneGeometryStats({ world });

	        function markSceneStatsDirty() {
	            sceneGeometryStats?.markDirty?.();
	        }
	
	        function getSceneGeometryStats() {
	            return sceneGeometryStats?.getStats?.() || { triangles: 0 };
	        }

        let bgMesh = null; // background sphere used to show HDRI
        app.bgMesh = bgMesh;
        let bgMode = 'white';
        let gridVisible = true;
        const whiteClearColor = new THREE.Color().setRGB(1.5, 1.5, 1.5);

        const camera   = new THREE.PerspectiveCamera(60, 1, 0.01, 5000);
        camera.position.set(0, 1.5, -5);

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
        if ('toneMapping' in renderer) renderer.toneMapping = THREE.NoToneMapping;
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

                const { features } = await loadParcels({
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
		        const shadowController = createShadowController({
		            THREE,
		            scene,
		            renderer,
		            dirLight,
		            computeSceneBounds,
		        });

		        function setShadowDebug(on) {
		            shadowController.setShadowDebug(on);
		        }

		        function fitSunShadowToScene(recenterTarget = false, margin = 1.3) {
		            shadowController.fitSunShadowToScene(recenterTarget, margin);
		        }

		        createShadowDebugPanelController({
		            root: document,
		            THREE,
		            renderer,
		            dirLight,
		            requestRender,
		            fitSunShadowToScene,
		            setShadowDebug,
		            getShadowDebugVisible: () => shadowController.isShadowDebugVisible(),
		            getShadowAutoFrustum: () => shadowController.getAutoFrustum(),
		            setShadowAutoFrustum: (next) => { shadowController.setAutoFrustum(next); },
		            getShadowFrustumScale: () => shadowController.getFrustumScale(),
		            setShadowFrustumScale: (next) => { shadowController.setFrustumScale(next); },
		        });

	       
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

        const fbxWorkerClient = createFBXWorkerClient();
        let fbxWorkerSupported = fbxWorkerClient.isSupported();
        const parseFBXInWorker = fbxWorkerClient.parseFBXInWorker;

        function parseFBXOnMainThread(buffer) {
            const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
            const parsed = fbxLoader.parse(buffer, '');
            const end = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
            if (fbxLoader?.fbxTree) {
                (parsed.userData ||= {}).fbxTree = fbxLoader.fbxTree;
            }
            return { obj: parsed, duration: end - now };
        }

	        const zipWorkerClient = createZIPWorkerClient();
	        const unpackZIPInWorker = zipWorkerClient.unpackZIPInWorker;
	        const environmentManager = createEnvironmentManager({
	            renderer,
	            scene,
	            world,
	            app,
	            requestRender,
	            ensureBgMesh,
	            getBgMesh: () => bgMesh,
	            updateBgVisibility,
	            applyGlassControlsToScene,
	            useWebGPU: USE_WEBGPU,
	            rendererInitPromise,
	            iblGammaEl,
	            iblTintEl,
	            hdriExposureEl,
	            hdriSaturationEl,
	            hdriBlurEl,
	            getIntensity: () => parseFloat(iblIntEl?.value) || 1.0,
	            initialRotationDeg: parseFloat(iblRotEl?.value) || 0,
	            enabled: !!iblChk?.checked,
	        });

	        function setEnvironmentRotation(deg) {
	            environmentManager.setRotation(deg);
	        }

        function requestEnvironmentRebuild({ immediate = false } = {}) {
            environmentManager.requestRebuild({ immediate });
        }

	        async function loadHDRBase() {
	            return environmentManager.loadHDRBase();
	        }

	        function syncEnvAdjustmentsState() {
	            return environmentManager.syncAdjustmentsState();
	        }

	        async function buildAndApplyEnvFromRotation(deg) {
	            await environmentManager.buildAndApplyFromRotation(deg);
	        }

	        async function setEnvironmentEnabled(on) {
	            await environmentManager.setEnabled(on);
	        }

	        function applyEnvToMaterials(env, intensity) {
	            environmentManager.applyEnvToMaterials(env, intensity);
	        }

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

            if (bgMesh) bgMesh.position.copy(camera.position);
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

	        function layout() {
	            // 1) measure header height and set CSS var
	            const appbar = document.querySelector('.appbar');
            const appH = Math.ceil(appbar?.getBoundingClientRect().height || 48);
            document.body.style.setProperty('--appbarH', appH + 'px');

            // 2) compute canvas size (side panel overlays, so use full width)
            const w = Math.max(1, window.innerWidth);
            const h = Math.max(1, window.innerHeight);
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
	        // HDR / IBL handling moved to `modules/render/environment-manager.js`

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

	        function clampNumericInput(value, min, max) {
	            if (!Number.isFinite(value)) return null;
	            if (min != null) value = Math.max(min, value);
	            if (max != null) value = Math.min(max, value);
	            return value;
	        }

	        function setBackgroundMode(mode) {
	            const next = mode === 'black' ? 'black' : 'white';
	            bgMode = next;
            if (next === 'black') {
                if (typeof renderer.setClearColor === 'function') {
                    renderer.setClearColor(0x000000, 1);
                }
                if (scene.background) scene.background.set(0x000000); else scene.background = new THREE.Color(0x000000);
                bgToggleBtn?.classList.add('active');
                if (bgToggleBtn) {
                    bgToggleBtn.textContent = 'White';
                    bgToggleBtn.classList.remove('white-mode');
                    bgToggleBtn.classList.add('black-mode');
                }
                if (typeof document !== 'undefined' && document.body) {
                    document.body.classList.add('bg-black');
                }
            } else {
                if (typeof renderer.setClearColor === 'function') {
                    renderer.setClearColor(whiteClearColor.clone(), 1);
                }
                scene.background = null;
                bgToggleBtn?.classList.remove('active');
                if (bgToggleBtn) {
                    bgToggleBtn.textContent = 'Black';
                    bgToggleBtn.classList.remove('black-mode');
                    bgToggleBtn.classList.add('white-mode');
                }
                if (typeof document !== 'undefined' && document.body) {
                    document.body.classList.remove('bg-black');
                }
            }
            updateBgVisibility();
            requestRender();
        }

	        function setGridVisible(visible) {
	            gridVisible = !!visible;
	            const gridHelper = app.grid;
	            if (gridHelper) {
	                gridHelper.visible = gridVisible;
	            }
	            app.gridVisible = gridVisible;
	            if (gridToggleBtn) {
	                gridToggleBtn.classList.toggle('active', gridVisible);
	                gridToggleBtn.textContent = gridVisible ? 'Grid off' : 'Grid on';
	                gridToggleBtn.setAttribute('aria-pressed', gridVisible ? 'true' : 'false');
	            }
	            requestRender();
	        }

	        const statsOverlayController = createStatsOverlayController({
	            statsBtn,
	            statsOverlayEl,
	            renderer,
	            requestRender,
	            getFpsEstimate: () => fpsEstimate,
	            getLastRenderStats: () => lastRenderStats,
	            getSceneGeometryStats,
	            getRendererMode: () => app.activeRendererMode,
	        });

	        function setStatsVisible(visible) {
	            statsOverlayController.setVisible(visible);
	        }

	        function updateStatsOverlay(force = false) {
	            statsOverlayController.update(force);
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






	        // Wire/beauty overlays
	        // (moved to `scripts/modules/render/wire-overlays.js`)
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
         * управляет режимом beauty wire и обновляет панель материалов.
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

            if (USE_WEBGPU && mode !== 'wire') {
                world.traverse(o => { if (o.isMesh) clearWireframeOverlay(o); });
            }

            // backface — отдельный режим (двухпроходный), его не делаем через makeVariantFrom
            if (mode === 'backface') {
                // если ранее был включён beautywire — выключаем его при входе в backface
                world.traverse(o => { if (o.isMesh) clearBeautyWire(o); });
                setBackfaceMode(true);
                requestRender();
                scheduleOnce();
                return;
            } else {
                // выходим из backface при любом другом режиме
                setBackfaceMode(false);
            }
            if (mode === 'beautywire') {
                // включаем beautywire у всех мешей
                world.traverse(o => {
                    if (o.userData?.isCollision) return; // не переписывать материал коллизий
                    if (!o.isMesh) return;
                    ensureBeautyWire(o, BEAUTY_WIRE_ANGLE_DEG);
                });
                requestRender();
                scheduleOnce();
                return;
            } else {
                // выходим из beautywire, если он был включён
                world.traverse(o => { if (o.isMesh) clearBeautyWire(o); });
            }

            if (mode === 'wire' && USE_WEBGPU) {
                world.traverse(o => {
                    if (o.userData?.isCollision) return;
                    if (!o.isMesh) return;
                    ensureWireframeOverlay(o);
                });
                requestRender();
                scheduleOnce();
                return;
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

	        const visibilityController = createVisibilityController({
	            world,
	            loadedModels,
	            outEl,
	            requestRender,
	            markSceneStatsDirty,
	        });

	        function handleEyeToggle(el) {
	            visibilityController.handleEyeToggle(el);
	        }

	        function updateEyeButtonsForTarget(target, visible) {
	            visibilityController.updateEyeButtonsForTarget(target, visible);
	        }

	        function setMeshAndMaterialsVisibility(target, visible) {
	            visibilityController.setMeshAndMaterialsVisibility(target, visible);
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
            bgMesh.userData.excludeFromBounds = true;
            bgMesh.frustumCulled = false;
            bgMesh.renderOrder = -1000;
            scene.add(bgMesh);
            bgMesh.position.copy(camera.position);
            return bgMesh;
        }

        function updateBgVisibility() {
            if (!bgMesh) return;
            const shouldShow = !!iblChk?.checked && bgMode !== 'black';
            bgMesh.visible = shouldShow;
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
            statsBtn.addEventListener('click', () => setStatsVisible(!statsOverlayController.isVisible()));
        }
        setStatsVisible(true);

        bgToggleBtn?.addEventListener('click', () => {
            setBackgroundMode(bgMode === 'black' ? 'white' : 'black');
        });
        setBackgroundMode('white');
        if (bgToggleBtn) bgToggleBtn.classList.add('white-mode');

        gridToggleBtn?.addEventListener('click', () => {
            setGridVisible(!gridVisible);
        });
        setGridVisible(true);

        resetViewerBtn?.addEventListener('click', () => {
            window.location.reload();
        });

        fullscreenBtn?.addEventListener('click', () => {
            const elem = document.documentElement;
            const fullscreenEl = document.fullscreenElement || document.webkitFullscreenElement;
            if (!fullscreenEl) {
                if (elem.requestFullscreen) elem.requestFullscreen();
                else if (elem.webkitRequestFullscreen) elem.webkitRequestFullscreen();
            } else {
                if (document.exitFullscreen) document.exitFullscreen();
                else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
            }
        });

	        iblChk?.addEventListener('change', () => setEnvironmentEnabled(iblChk.checked));
	        iblIntEl?.addEventListener('input', () => {
	            if (!iblChk?.checked) return;
	            const env = scene.environment || environmentManager.getCurrentEnv();
	            if (!env) return;
	            applyEnvToMaterials(env, parseFloat(iblIntEl.value));
	        });
        const scheduleEnvRebuildFromUI = () => {
            syncEnvAdjustmentsState();
            requestEnvironmentRebuild({ immediate: false });
        };
        iblGammaEl?.addEventListener('input', scheduleEnvRebuildFromUI);
        iblTintEl?.addEventListener('input', scheduleEnvRebuildFromUI);
        hdriExposureEl?.addEventListener('input', scheduleEnvRebuildFromUI);
        hdriSaturationEl?.addEventListener('input', scheduleEnvRebuildFromUI);
        hdriBlurEl?.addEventListener('input', scheduleEnvRebuildFromUI);

	        iblRotEl?.addEventListener('input', () => {
	            setEnvironmentRotation(parseFloat(iblRotEl?.value) || 0);
	        });
	        hdriPresetSel?.addEventListener('change', async (e) => {
	            const idx = parseInt(e.target.value, 10);
	            if (isNaN(idx)) return;
	            await environmentManager.selectPresetIndex(idx);
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
	        // =====================
	        // UDIM split (для ВПМ/SM)
	        // (moved to `scripts/modules/fbx/udim-split.js`)
	        // =====================

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

	        // helper: формируем метаданные GeoJSON (url для скачивания, prettified текст, подсчёт features)
	        // =====================================================================
	        // GeoJSON & Glass parameters
	        // =====================================================================

        /**
         * Формирует удобную структуру с распарсенным GeoJSON, количеством features
         * и blob-URL для скачивания. Используется для SM (ВПМ) проектов.
         */
	        // `basename` moved to `scripts/modules/utils/path.js`
	        // `makeGeoJsonMeta` moved to `scripts/modules/geo/geojson-meta.js`

	        // `clamp01` moved to `scripts/modules/utils/math.js`
	        // `normalizeHexColor` / `geoColorToHex` moved to `scripts/modules/utils/color.js`

        function openGeoModal(meta, title = 'GeoJSON') {
        let geoModal = document.getElementById('geoModal');
        if (!geoModal) {
            geoModal = document.createElement('div');
            geoModal.id = 'geoModal';
            geoModal.className = 'modal';
            geoModal.innerHTML = `
            <div class="sheet sheet-geo">
                <div class="head">
                    <div class="row head-line">
                        <b id="geoTitle"></b>
                        <span class="muted" id="geoInfo"></span>
                    </div>
                    <button id="geoClose" class="btn" title="Закрыть">×</button>
                </div>
                <div class="sheet-body">
                    <pre id="geoPre"></pre>
                    <div class="row geo-actions">
                        <a id="geoDl" class="btn" download>Скачать GeoJSON</a>
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
        // (moved to `scripts/modules/fbx/embedded-images.js`)
        // =====================
        // Material helpers
        // =====================


	        // === COLLISIONS (UCX) =========================================
	        const { ensureZipCollisionsHidden, hideSMCollisions } = createCollisionVisibilityHelpers({
	            loadedModels,
	            schedulePanelRefresh,
	            updateEyeButtonsForTarget,
	            setMeshAndMaterialsVisibility,
	            syncCollisionButtons,
	        });

	        const toStandard = createToStandard({
	            getEnvironment: () => scene.environment,
	            getEnvMapIntensity: () => parseFloat(iblIntEl.value),
	        });

	        // `copyTextureSettings` moved to `scripts/modules/material/texture-utils.js`

	        // `GEOM_SUFFIXES`/slot + glass name helpers moved to `scripts/modules/material/naming.js`



        
        // ----------------------------------
        // OFFSET FROM GEOJSON UTILS FOR VPNS
        // ----------------------------------


	        // `getSMOffset` moved to `scripts/modules/geo/sm-offset.js`






	        // =====================================================================
	        // UI · Materials Panel & Gallery
	        // =====================================================================

	        const materialsPanel = createMaterialsPanelController({
	            world,
	            loadedModels,
	            outEl,
	            matSelect,
	            requestRender,
	            handleEyeToggle,
	            updateEyeButtonsForTarget,
	            openGeoModal,
	            handleGlassSliderInput,
	            handleGlassColorInput,
	            texInfo,
	            formatColorForDisplay,
	        });

	        function schedulePanelRefresh(afterRender) {
	            materialsPanel.scheduleRefresh(afterRender);
	        }

		        /** Возвращает { mesh, mat, index } по UUID и индексу материала для стеклянных контролов. */
		        function resolveGlassMaterial(uuid, matIndex) {
		            return materialsPanel.resolveGlassMaterial(uuid, matIndex);
		        }

	        /** Синхронизирует состояние кнопок «Коллизии» (по файлам и группам) с текущей видимостью. */
	        function syncCollisionButtons() {
	            materialsPanel.syncCollisionButtons();
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

	        const textureModal = createTextureModalController({
	            texModalEl: texModal,
	            closeBtnEl: mClose,
	            imgEl: mImg,
	            titleEl: mTitle,
	            fileEl: mFile,
	            kindEl: mKind,
	            mimeEl: mMime,
	            downloadLinkEl: dlLink,
	            bindBtnEl: bindBtn,
	            slotSelectEl: slotSelect,
	            matSelectEl: matSelect,
	            basename,
	            guessKindFromName,
	            getSelectedMaterialLink,
	            textureLoader,
	            toStandard,
	            copyTextureSettings,
	            getEnvironment: () => scene.environment,
	            getEnvMapIntensity: () => parseFloat(iblIntEl.value),
	            cacheOriginalMaterialFor,
	            applyGlassControlsToScene,
	            schedulePanelRefresh,
	            logBind,
	            colorSpaces: {
	                linear: THREE.LinearSRGBColorSpace,
	                srgb: THREE.SRGBColorSpace,
	            },
	        });

		        const textureGallery = createTextureGalleryController({
		            galleryEl,
		            texCountEl,
		            basename,
		            guessKindFromName,
		            onOpen: textureModal.open,
		        });
		        /**
		         * Обновляет галерею текстур в боковой панели: миниатюры embedded/zip изображений.
		         */
		        function renderGallery(listAll) {
		            textureGallery.render(listAll);
		            galleryNeedsRefresh = false;
		        }

        // =====================
        // Glass controls
        // =====================
        function cacheOriginalMaterialFor(obj, force = false) {
            if (!obj) return;
            if (currentShadingMode !== 'pbr') {
                // Не затираем исходный PBR-материал временными материалами из режимов (beautywire/backface/wire и т.п.).
                if (obj.userData?._origMaterial) return;
                if (!force) return;
            }
            obj.userData._origMaterial = obj.material;
        }

        glassController = createGlassController({
            THREE,
            world,
            scene,
            toStandard,
            cacheOriginalMaterialFor,
            requestRender,
            schedulePanelRefresh,
            elements: {
                glassOpacityEl,
                glassIorEl,
                glassTransmissionEl,
                glassReflectEl,
                glassRoughEl,
                glassMetalEl,
                glassAttenDistEl,
                glassAttenColorEl,
                glassColorEl,
                glassResetBtn,
            },
        });


	        /**
	         * Применяет настройки стекла ко всем мешам: GeoJSON → overrides → UI-слайдеры.
	         * Актуализирует `userData.glassInfo` для панели и при необходимости сохраняет overrides.
	         */
	        function applyGlassControlsToScene() {
	            glassController?.applyToScene?.();
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

	        
	        // =====================
	        // Auto-bind based on filenames
        // =====================

        const { labelFromURL } = createTextureLabelResolver({
            getEntries: () => allEmbedded,
        });
        // =====================
        // VPM (SM_) — индексация текстур и привязка по UDIM+Slot
        // =====================

        const vpmBinder = createVPMBinder({
            THREE,
            basename,
            labelFromURL,
            toStandard,
            textureLoader,
            copyTextureSettings,
            cacheOriginalMaterialFor,
            requestRender,
            materialsPanel,
            schedulePanelRefresh,
            logBind,
            loadedModels,
            detectSlotFromMatOrObj,
            findGeomSuffix,
            isGlassByName,
            isGlassGeomSuffix,
            getEnvironment: () => scene.environment,
            getEnvMapIntensity: () => parseFloat(iblIntEl.value),
            isWebGL2: () => !!renderer.capabilities?.isWebGL2,
        });

        function buildVPMIndex(allImages){
            return vpmBinder.buildVPMIndex(allImages);
        }

        /**
         * Автоматически привязывает Diffuse/Normal/ERM карты к каждому UDIM-сабмешу модели ВПМ.
         * Перезаписывает материалы (clone → MeshStandardMaterial), применяет стекло, ERM и окружение.
         */
        async function autoBindVPMForModel(root, vpmIndex){
            return vpmBinder.autoBindVPMForModel(root, vpmIndex);
        }

        const filenameBinder = createFilenameBinder({
            THREE,
            basename,
            geomSuffixes: GEOM_SUFFIXES,
            guessKindFromName,
            findGeomSuffix,
            toStandard,
            textureLoader,
            copyTextureSettings,
            cacheOriginalMaterialFor,
            logBind,
            undoStack,
            getEnvironment: () => scene.environment,
            getEnvMapIntensity: () => parseFloat(iblIntEl.value),
        });

        /**
         * Автопривязка для "обычных" моделей (НПМ): сопоставление текстур по имени файла.
         * Ожидает входные embeddedList (файлы из ZIP/FBX) и обновляет материалы в сцене.
         */
        function autoBindByNamesForModel(root, fileName, embeddedList) {
            return filenameBinder.autoBindByNamesForModel(root, fileName, embeddedList);
        }

        // =====================
        // File flow
        // =====================
        const fileInput = document.getElementById('fileInput');
        const openBtn = document.getElementById('openBtn');
        const sampleLoader = createSampleLoader({
            statusEl,
            sampleSelect,
            setStatusMessage,
            setEmptyHintVisible,
            hideSidePanel,
            handleZIPFile,
            finalizeBatchAfterAllFiles,
            getLoadedModelCount: () => loadedModels.length,
        });

        async function loadSampleModel(sample) {
            return sampleLoader.loadSampleModel(sample);
        }

        createFileFlowController({
            fileInput,
            openBtn,
            emptyHintEl,
            rootEl,
            dropEl,
            sampleSelect,
            sampleModels: SAMPLE_MODELS,
            handleFBXFile,
            handleZIPFile,
            finalizeBatchAfterAllFiles,
            loadSampleModel,
            setEmptyHintVisible,
            getLoadedModelCount: () => loadedModels.length,
        });

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

        // =====================================================================
        // Asset Loading · Core Procedures
        // =====================================================================

        /**
         * Загружает одиночный FBX-файл: парсит ориентацию, применяет смещения (GeoJSON),
         * извлекает embedded текстуры, выполняет автопривязку и обновляет панель/шейдинг.
         */
        const handleFBXFileImpl = createFBXFileHandler({
            THREE,
            fbxLoader,
            basename,
            logSessionHeader,
            logBind,
            hideSidePanel,
            setStatusMessage,
            requestRender,
            schedulePanelRefresh,
            parseFBXInWorker,
            parseFBXOnMainThread,
            isWorkerSupported: () => fbxWorkerSupported,
            setWorkerSupported: (next) => { fbxWorkerSupported = next; },
            disableWorker: (err) => { try { fbxWorkerClient.disable(err); } catch (_) {} },
            extractImagesFromFBX,
            sniffImage,
            allEmbedded,
            markGalleryNeedsRefresh: () => { galleryNeedsRefresh = true; },
            world,
            loadedModels,
            determineOrientationType,
            describeOrientationType,
            describeFBXOrientation,
            readFBXOrientationFromTree,
            parseOrientationFromNode,
            normalizeObjectOrientation,
            getSMOffset,
            applyGeoOffsetByOrientation,
            setVPMReferenceHeight,
            restoreLightTargetsFromOrientation,
            disableShadowsOnImportedLights,
            ensureLightHelpers,
            renameMaterialsByFBXObject,
            markCollisionMeshes,
            splitAllMeshesByUDIM_SM,
            optimizeGlassMeshes,
            autoBindByNamesForModel,
            setImportedLightsEnabled,
            getImportedLightsEnabled: () => importedLightsEnabled,
            applyGlassControlsToScene,
            setEmptyHintVisible,
            markSceneStatsDirty,
        });

        const handleZIPFileImpl = createZIPFileHandler({
            basename,
            unpackZIPInWorker,
            makeGeoJsonMeta,
            handleFBXFile: handleFBXFileImpl,
            logSessionHeader,
            logBind,
            hideSidePanel,
            setStatusMessage,
            schedulePanelRefresh,
            ensureZipCollisionsHidden,
            setEmptyHintVisible,
            allEmbedded,
            markGalleryNeedsRefresh: () => { galleryNeedsRefresh = true; },
            loadedModels,
            JSZip: (typeof globalThis !== 'undefined' ? globalThis.JSZip : null),
        });

        async function handleFBXFile(file, groupName = null, zipKind = null, zipMeta = null, options = null) {
            return handleFBXFileImpl(file, groupName, zipKind, zipMeta, options);
        }
        /**
         * Обработка ZIP-архива: находит FBX/текстуры/GeoJSON, загружает FBX, сохраняет текстуры,
         * привязывает GeoJSON к моделям и обновляет UI.
         */
        async function handleZIPFile(file) {
            return handleZIPFileImpl(file);
        }

        const batchFinalizer = createBatchFinalizer({
            loadedModels,
            allEmbedded,
            getLastFinalizedModelIndex: () => lastFinalizedModelIndex,
            setLastFinalizedModelIndex: (next) => { lastFinalizedModelIndex = next; },
            getGalleryNeedsRefresh: () => galleryNeedsRefresh,
            setGalleryNeedsRefresh: (next) => { galleryNeedsRefresh = next; },
            renderGallery,
            getDidInitialRebase: () => didInitialRebase,
            setDidInitialRebase: (next) => { didInitialRebase = next; },
            computeAutoOffsetHorizontalOnly,
            setWorldOffset,
            isIBLEnabled: () => iblChk.checked,
            getIBLRotation: () => parseFloat(iblRotEl.value) || 0,
            loadHDRBase,
            buildAndApplyEnvFromRotation,
            syncBackgroundToEnvironment: () => {
                ensureBgMesh();
                bgMesh.material.map = environmentManager.getCurrentBg() || null;
                bgMesh.material.needsUpdate = true;
                updateBgVisibility();
            },
            applyGlassControlsToScene,
            fitSunShadowToScene,
            updateSun,
            buildVPMIndex,
            autoBindVPMForModel,
            logBind,
            ensureZipCollisionsHidden,
            fitAll,
            focusOn,
            outEl,
            imagesDetails,
            bindLogDetails,
            hideSMCollisions,
            syncCollisionButtons,
            setStatusMessage,
            setEmptyHintVisible,
            applyShading,
            getCurrentShadingMode: () => currentShadingMode,
        });

        /**
         * Финальный шаг после загрузки всех файлов: применяет HDRI/фокус, автопривязку ВПМ и перерисовывает UI.
         */
        async function finalizeBatchAfterAllFiles() {
            return batchFinalizer.finalizeBatchAfterAllFiles();
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

            if (bgMesh) {
                bgMesh.position.copy(camera.position);
            }

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
