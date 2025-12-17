import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import {
    setVPMReferenceHeight,
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
import { createMosParcelsController } from './modules/scene/mos-parcels.js';
import { createSunController } from './modules/scene/sun-controller.js';
import { createWorldOffsetController } from './modules/scene/world-offset.js';
import { createStatsOverlayController } from './modules/ui/stats-overlay.js';
import { createBindLogController } from './modules/ui/bind-log.js';
import { createSliderValuesUIController } from './modules/ui/slider-values-ui.js';
import { createShadowDebugPanelController } from './modules/ui/shadow-debug-panel.js';
import { createSunToggleController } from './modules/ui/sun-toggle.js';
import { createSunInputsController } from './modules/ui/sun-inputs.js';
import { createEnvironmentControlsController } from './modules/ui/environment-controls.js';
import { createGeoJsonModalController } from './modules/ui/geojson-modal.js';
import { createSelectedMaterialLinkResolver, createTextureInfoFormatter, guessKindFromName } from './modules/ui/texture-helpers.js';
import { createHemiLightControlsController } from './modules/ui/hemi-light-controls.js';
import { createStatusUIController } from './modules/ui/status-ui.js';
import { createAppbarControlsController } from './modules/ui/appbar-controls.js';
import { createLayoutController } from './modules/ui/layout.js';
import { createTextureGalleryController } from './modules/ui/texture-gallery.js';
import { createVisibilityController } from './modules/ui/visibility.js';
import { createMaterialsPanelController } from './modules/ui/materials-panel.js';
import { createGlassOverridesController } from './modules/ui/glass-overrides.js';
import { createTextureModalController } from './modules/ui/texture-modal.js';
import { createEnvironmentManager, HDRI_LIBRARY } from './modules/render/environment-manager.js';
import { createBackgroundController } from './modules/render/background-controller.js';
import { createAndStartRenderLoop } from './modules/render/render-loop-bootstrap.js';
import { createDebugTextureProvider } from './modules/render/debug-textures.js';
import { createBackfaceOverlayController } from './modules/render/backface-overlay.js';
import { createShadingController } from './modules/render/shading-controller.js';
import { createShadowController } from './modules/render/shadow-controller.js';
import { createFBXFileHandler } from './modules/io/fbx-file.js';
import { createZIPFileHandler } from './modules/io/zip-file.js';
import { createFileFlowUIController } from './modules/io/file-flow-ui.js';
import { SAMPLE_MODELS } from './modules/io/sample-models.js';
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
        const emptyHintEl     = document.getElementById('emptyHint');

        const statusUI = createStatusUIController({ statusEl, appbarStatusEl, emptyHintEl });
        const setStatusMessage = statusUI.setStatusMessage;
        const setEmptyHintVisible = statusUI.setEmptyHintVisible;
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
	        const hdriSaturationEl = document.getElementById('hdriSaturation');
	        const hdriBlurEl      = document.getElementById('hdriBlur');
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

	        createSliderValuesUIController({
	            root: document,
	            sliders: [
                ['hemiInt', hemiIntEl],
                ['bgAlpha', bgAlphaEl],
                ['iblInt', iblIntEl],
                ['iblGamma', iblGammaEl],
                ['iblRot', iblRotEl],
                ['hdriExposure', hdriExposureEl],
                ['hdriSaturation', hdriSaturationEl],
                ['hdriBlur', hdriBlurEl],
            ],
        });

        const sampleSelect    = document.getElementById('sampleSelect');

        let didInitialRebase = false;
        let galleryNeedsRefresh = false;
        let layoutController = null;
        let lastFinalizedModelIndex = 0;
        let renderLoop = null;
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
        const scene = new THREE.Scene();
        // scene.background = null;

        const world = new THREE.Group();
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
	            bgAlphaEl,
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

	        const mosParcels = createMosParcelsController({
	            world,
	            app,
	            northGrid,
	            isZUp,
	            requestRender,
	            schedulePanelRefresh,
	            markSceneStatsDirty,
	            setStatusMessage,
	            logBind,
	            config: {
	                apiKey: MOS_PARCELS.apiKey,
	                datasetId: MOS_PARCELS.datasetId,
	                baseUrl: MOS_PARCELS.baseUrl,
	                filter: MOS_PARCELS_FILTER,
	                targetGlobalId: MOS_PARCELS_TARGET_GLOBAL_ID,
	                resetOrigin: true,
	            },
	        });

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

			        const { updateSun } = createSunController({
			            THREE,
			            app,
			            dirLight,
			            northGrid,
			            latitude: MOSCOW_LAT,
			            longitude: MOSCOW_LON,
			            getDay: () => sunDayEl?.value,
			            getMonth: () => sunMonthEl?.value,
			            getHour: () => sunHourEl?.value,
			            getNorthDeg: () => sunNorthEl?.value,
			            computeSceneBounds,
			            fitSunShadowToScene,
			            requestRender,
			        });

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

				        mosParcels.bindUI({
				            loadParcelsBtn,
				            loadOptions: { fetchAll: true, batchSize: 1000, maxRecords: 20000 },
				        });

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

        const debugTextures = createDebugTextureProvider({
            THREE,
            renderer,
            textureLoader: texLd,
        });
        const getMatcap = debugTextures.getMatcap;
        const getChecker = debugTextures.getChecker;

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
			            presets: HDRI_LIBRARY,
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

			        createAppbarControlsController({
			            document,
			            window,
			            statsBtn,
			            gridToggleBtn,
			            resetViewerBtn,
			            fullscreenBtn,
			            isStatsVisible: () => statsOverlayController.isVisible(),
			            setStatsVisible,
			            isGridVisible: () => gridVisible,
			            setGridVisible,
			        });

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
        createFileFlowUIController({
            statusEl,
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
            hideSidePanel,
            setStatusMessage,
            setEmptyHintVisible,
            getLoadedModelCount: () => loadedModels.length,
        });

        // =====================
        // LIGHT CONTROLL
        // =====================
        createHemiLightControlsController({
            hemiLight,
            hemiIntEl,
            hemiSkyEl,
            hemiGroundEl,
            requestRender,
        });

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
        renderLoop = createAndStartRenderLoop({
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
        layout();
        // IBL не запускаем автоматически — управляется чекбоксом
    }
}

const viewerApp = new ViewerApp();
if (typeof globalThis !== 'undefined') {
    globalThis.viewerApp = viewerApp;
}

export default viewerApp;
