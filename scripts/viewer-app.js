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
import { createTextureLabelResolver } from './modules/utils/texture-labels.js';
import { makeGeoJsonMeta } from './modules/geo/geojson-meta.js';
import { getSMOffset } from './modules/geo/sm-offset.js';
import { createFBXWorkerClient } from './modules/workers/fbx-worker-client.js';
import { createZIPWorkerClient } from './modules/workers/zip-worker-client.js';
import { extractImagesFromFBX, sniffImage } from './modules/fbx/embedded-images.js';
import { createSceneGeometryStats } from './modules/scene/geometry-stats.js';
import { createSceneFramingController } from './modules/scene/framing.js';
import { createNorthGridController } from './modules/scene/north-grid.js';
import { createImportedLightsController } from './modules/scene/imported-lights.js';
import { createWorldOffsetController } from './modules/scene/world-offset.js';
import { createStatsOverlayController } from './modules/ui/stats-overlay.js';
import { createBindLogController } from './modules/ui/bind-log.js';
import { createSliderValueDisplayController } from './modules/ui/slider-value-displays.js';
import { createShadowDebugPanelController } from './modules/ui/shadow-debug-panel.js';
import { createSunToggleController } from './modules/ui/sun-toggle.js';
import { createSunInputsController } from './modules/ui/sun-inputs.js';
import { createEnvironmentControlsController } from './modules/ui/environment-controls.js';
import { createGeoJsonModalController } from './modules/ui/geojson-modal.js';
import { createSelectedMaterialLinkResolver, createTextureInfoFormatter, guessKindFromName } from './modules/ui/texture-helpers.js';
import { createLayoutController } from './modules/ui/layout.js';
import { createTextureGalleryController } from './modules/ui/texture-gallery.js';
import { createVisibilityController } from './modules/ui/visibility.js';
import { createMaterialsPanelController } from './modules/ui/materials-panel.js';
import { createGlassOverridesController } from './modules/ui/glass-overrides.js';
import { createTextureModalController } from './modules/ui/texture-modal.js';
import { createEnvironmentManager, HDRI_LIBRARY } from './modules/render/environment-manager.js';
import { createBackgroundController } from './modules/render/background-controller.js';
import { createRenderLoopController } from './modules/render/render-loop.js';
import { createBackfaceOverlayController } from './modules/render/backface-overlay.js';
import { createShadingController } from './modules/render/shading-controller.js';
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
import { createGlassMeshOptimizer } from './modules/material/glass-mesh-optimizer.js';
import { createMaterialRenamer } from './modules/material/rename-materials.js';
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
import { detectRendererMode } from './modules/render/renderer-mode.js';

const rendererMode = await detectRendererMode();
const activeRendererMode = rendererMode.activeRendererMode;
const USE_WEBGPU = rendererMode.useWebGPU;
const WebGPURendererCtor = rendererMode.WebGPURendererCtor;
const webgpuModuleError = rendererMode.webgpuModuleError;
const rendererModeNote = rendererMode.rendererModeNote;
const backfaceNodeSupport = rendererMode.backfaceNodeSupport;

class ViewerApp {
    constructor() {
        const app = this;
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
	        const loadParcelsBtn  = document.getElementById('loadParcelsBtn');
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
	        const { logBind, logSessionHeader } = createBindLogController({ bindLogEl });

	        const bgAlphaEl       = document.getElementById('bgAlpha');
	        bgAlphaEl.addEventListener('input', () => backgroundController.updateVisibility());

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
				        let galleryNeedsRefresh = false;
			        let layoutController = null;
			        let lastFinalizedModelIndex = 0;
		        let renderLoop = null;
		        let parcelsGroup = null;
		        let parcelsOrigin = null;
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
	            renderLoop?.requestRender?.();
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

        const backgroundController = createBackgroundController({
            THREE,
            renderer,
            scene,
            camera,
            app,
            requestRender,
            isEnvironmentEnabled: () => !!iblChk?.checked,
            getAlpha: () => parseFloat(bgAlphaEl?.value || '1'),
            bgToggleBtn,
            whiteClearColor,
            body: document?.body || null,
        });

        
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

	        const sunDir = new THREE.Vector3(0, 1, 0); // актуальное направление солнца (единичный)

	        const northGrid = createNorthGridController({
	            THREE,
	            scene,
	            app,
	            requestRender,
	            isZUp,
	            getNorthDeg: () => parseFloat(sunNorthEl?.value) || 0,
	            gridSize: 100,
	            gridDivisions: 100,
	            gridColor: 0x888888,
	            pointerColor: 0xff3d00,
	        });

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
                northGrid.setParcelsGroup(parcelsGroup);
                northGrid.alignParcelsGroupToNorth();
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

        northGrid.updateNorthPointer();
        app.scene = scene;
        app.world = world;
        app.camera = camera;
        app.renderer = renderer;
	        app.controls = controls;
	        app.hemiLight = hemiLight;
	        app.dirLight = dirLight;
	        app.grid = northGrid.grid;
	        app.sun = { enabled: true, direction: sunDir.clone() };
	        app.layers = { parcels: null };



		        // =====================================================================
		        // Lighting & Shadows · Sun control / debug panel
		        // =====================================================================

		        // --- Shadows debug panel (после создания dirLight!) ---
		        const sceneFraming = createSceneFramingController({
		            THREE,
		            world,
		            camera,
		            controls,
		            renderer,
		            requestRender,
		            getBgMesh: backgroundController.getBgMesh,
		        });

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
	        createSunToggleController({
	            root: document,
	            app,
	            sunEnabledEl,
	            sunControlsEl,
	            renderer,
	            dirLight,
	            layout,
	            requestRender,
	            onEnable: () => {
	                updateSun();            // пересчитать позицию солнца
	                fitSunShadowToScene();  // обновить объём теней
	            },
	        });


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
		            ensureBgMesh: backgroundController.ensureBgMesh,
		            getBgMesh: backgroundController.getBgMesh,
		            updateBgVisibility: backgroundController.updateVisibility,
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

		        const worldOffsetController = createWorldOffsetController({
		            THREE,
		            world,
		            camera,
		            dirLight,
		            isZUp,
		            computeSceneBounds,
		            getBgMesh: backgroundController.getBgMesh,
		        });

	        function computeAutoOffsetHorizontalOnly() {
	            return worldOffsetController.computeAutoOffsetHorizontalOnly();
	        }

	        function setWorldOffset(offset) {
	            worldOffsetController.setWorldOffset(offset);
	        }

		        // =====================
		        // Layout helper
		        // =====================

		        function getLayoutController() {
		            if (!layoutController) {
		                layoutController = createLayoutController({
		                    root: document,
		                    window,
		                    renderer,
		                    camera,
		                    requestRender,
		                    toggleSideBtn,
		                });
		            }
		            return layoutController;
		        }

		        function layout() {
		            return getLayoutController().layout();
		        }

		        function hideSidePanel() {
		            return getLayoutController().hideSidePanel();
		        }

		        loadParcelsBtn?.addEventListener('click', () => loadMosParcels({ fetchAll: true, batchSize: 1000, maxRecords: 20000 }));

		        hideSidePanel();

	   

		        // === Bounds / framing ===
		        function computeSceneBounds(root = world) {
		            return sceneFraming.computeSceneBounds(root);
		        }

		        function focusOn(targets, pad = 1.4) {
		            return sceneFraming.focusOn(targets, pad);
		        }

		        function fitAll() {
		            return sceneFraming.fitAll();
		        }

		        function computeWorldCenter() {
		            return sceneFraming.computeWorldCenter();
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
	            northGrid.updateNorthPointer();
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
		            getFpsEstimate: () => renderLoop?.getFpsEstimate?.() || 0,
		            getLastRenderStats: () => renderLoop?.getLastRenderStats?.() || null,
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

        const backfaceOverlay = createBackfaceOverlayController({
            THREE,
            world,
            useWebGPU: USE_WEBGPU,
            backfaceNodeSupport,
        });
        const setBackfaceMode = backfaceOverlay.setBackfaceMode;






	        // Wire/beauty overlays
	        // (moved to `scripts/modules/render/wire-overlays.js`)
        // =====================
        // Shading modes
        // =====================

        const shadingController = createShadingController({
            THREE,
            world,
            scene,
            requestRender,
            schedulePanelRefresh,
            useWebGPU: USE_WEBGPU,
            clearWireframeOverlay,
            ensureWireframeOverlay,
            clearBeautyWire,
            ensureBeautyWire,
            beautyWireAngleDeg: BEAUTY_WIRE_ANGLE_DEG,
            setBackfaceMode,
            applyEnvToMaterials,
            applyGlassControlsToScene,
            getEnvIntensity: () => parseFloat(iblIntEl.value),
            getMatcap,
            getChecker,
        });
        const applyShading = shadingController.applyShading;

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


		        createSunInputsController({
		            sunHourEl,
		            sunHourInputEl,
	            sunDayEl,
	            sunMonthEl,
	            sunNorthEl,
	            sunIntensityEl,
	            sunIntensityInputEl,
	            dirLight,
	            updateSun,
		            requestRender,
		        });

		        createEnvironmentControlsController({
		            scene,
		            iblChk,
		            hdriPresetSel,
		            iblIntEl,
		            iblGammaEl,
		            iblTintEl,
		            iblRotEl,
		            hdriExposureEl,
		            hdriSaturationEl,
		            hdriBlurEl,
		            setEnvironmentEnabled,
		            setEnvironmentRotation,
		            applyEnvToMaterials,
		            requestEnvironmentRebuild,
		            syncEnvAdjustmentsState,
		            getCurrentEnv: () => environmentManager.getCurrentEnv(),
		            selectPresetIndex: (idx) => environmentManager.selectPresetIndex(idx),
		        });

		        if (statsBtn) {
		            statsBtn.addEventListener('click', () => setStatsVisible(!statsOverlayController.isVisible()));
		        }
	        setStatsVisible(true);

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

	        // =====================
	        // Axis toggle
	        // =====================

	        // =====================
	        // Utilities
	        // =====================

	        const importedLightsController = createImportedLightsController({
	            THREE,
	            loadedModels,
	            requestRender,
	            logBind,
	        });
	        importedLightsController.bindUI({
	            lightHelpersBtn: document.getElementById('lightHelpersBtn'),
	            lightEmittersBtn: document.getElementById('lightEmittersBtn'),
	        });
	        // =====================
	        // UDIM split (для ВПМ/SM)
	        // (moved to `scripts/modules/fbx/udim-split.js`)
	        // =====================

	        const optimizeGlassMeshes = createGlassMeshOptimizer({
	            THREE,
	            logBind,
	            findGeomSuffix,
	            isGlassByName,
	            isGlassGeomSuffix,
	        });

		        const getSelectedMaterialLink = createSelectedMaterialLinkResolver({
		            matSelectEl: matSelect,
		            world,
		        });

		        // --- ПОДПИСАТЬ МАТЕРИАЛЫ ПО ИМЕНИ ОБЪЕКТА/UCX ---
		        const renameMaterialsByFBXObject = createMaterialRenamer({
		            logBind,
	            cacheOriginalMaterialFor,
	        });

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

	        const geoJsonModal = createGeoJsonModalController({ document });
	        const openGeoModal = geoJsonModal.open;

	        const texInfo = createTextureInfoFormatter({
	            THREE,
	            basename,
	        });

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

	        let materialsPanel = null;
	        const glassOverrides = createGlassOverridesController({
	            requestRender,
	            applyGlassControlsToScene,
	            resolveGlassMaterial: (uuid, matIndex) => materialsPanel?.resolveGlassMaterial(uuid, matIndex),
	        });
	        const {
	            handleGlassSliderInput,
	            handleGlassColorInput,
	            formatColorForDisplay,
	        } = glassOverrides;

	        materialsPanel = createMaterialsPanelController({
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
	            materialsPanel?.scheduleRefresh(afterRender);
	        }

	        /** Синхронизирует состояние кнопок «Коллизии» (по файлам и группам) с текущей видимостью. */
	        function syncCollisionButtons() {
	            materialsPanel?.syncCollisionButtons?.();
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
	            if (shadingController.getCurrentMode() !== 'pbr') {
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
	            restoreLightTargetsFromOrientation: importedLightsController.restoreLightTargetsFromOrientation,
	            disableShadowsOnImportedLights: importedLightsController.disableShadowsOnImportedLights,
	            ensureLightHelpers: importedLightsController.ensureLightHelpers,
	            renameMaterialsByFBXObject,
	            markCollisionMeshes,
	            splitAllMeshesByUDIM_SM,
	            optimizeGlassMeshes,
	            autoBindByNamesForModel,
	            setImportedLightsEnabled: importedLightsController.setImportedLightsEnabled,
	            getImportedLightsEnabled: importedLightsController.getImportedLightsEnabled,
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
	                const bgMesh = backgroundController.ensureBgMesh();
	                if (bgMesh) {
	                    bgMesh.material.map = environmentManager.getCurrentBg() || null;
	                    bgMesh.material.needsUpdate = true;
	                }
	                backgroundController.updateVisibility();
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
	            getCurrentShadingMode: shadingController.getCurrentMode,
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
	            updateBgVisibility: backgroundController.updateVisibility,
	            computeWorldCenter,
	            setStatsVisible,
	            requestRender,
	        });
	        // =====================
	        // Animation loop & init
	        // =====================
	        renderLoop = createRenderLoopController({
	            controls,
	            renderer,
	            scene,
	            camera,
	            isWebGPU: USE_WEBGPU,
	            getRendererReady: () => rendererReady,
	            updateStatsOverlay,
	            onFrame: () => {
	                backgroundController.syncToCamera();
	            },
	        });
	        renderLoop.start();
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
