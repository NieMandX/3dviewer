import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
    setVPMReferenceHeight,
} from '../parcels.js';
import { basename } from '../utils/path.js';
import { makeGeoJsonMeta } from '../geo/geojson-meta.js';
import { getSMOffset } from '../geo/sm-offset.js';
import { extractImagesFromFBX, sniffImage } from '../fbx/embedded-images.js';
import { createNorthGridController } from '../scene/north-grid.js';
import { createImportedLightsController } from '../scene/imported-lights.js';
import { createMosParcelsController } from '../scene/mos-parcels.js';
import { createWorldOffsetController } from '../scene/world-offset.js';
import { createSceneCore } from '../scene/scene-core.js';
import { createSunShadowsController } from '../scene/sun-shadows.js';
import { createStatsOverlayController } from '../ui/stats-overlay.js';
import { createBindLogController } from '../ui/bind-log.js';
import { createSliderValuesUIController } from '../ui/slider-values-ui.js';
import { createSunInputsController } from '../ui/sun-inputs.js';
import { createEnvironmentControlsController } from '../ui/environment-controls.js';
import { createGeoJsonModalController } from '../ui/geojson-modal.js';
import { createSelectedMaterialLinkResolver, createTextureInfoFormatter, guessKindFromName } from '../ui/texture-helpers.js';
import { createHemiLightControlsController } from '../ui/hemi-light-controls.js';
import { createStatusUIController } from '../ui/status-ui.js';
import { createAppbarControlsController } from '../ui/appbar-controls.js';
import { createAppbarVisibilityTogglesController } from '../ui/appbar-visibility-toggles.js';
import { createCameraPresetsController } from '../ui/camera-presets.js';
import { createGridVisibilityController } from '../ui/grid-visibility.js';
import { createLayoutController } from '../ui/layout.js';
import { createInspectorPanels } from '../ui/inspector-panels.js';
import { createVisibilityAndCollisions } from '../ui/visibility-collisions.js';
import { collectViewerDom } from '../ui/viewer-dom.js';
import { HDRI_LIBRARY } from '../render/environment-manager.js';
import { createAndStartRenderLoop } from '../render/render-loop-bootstrap.js';
import { createDebugTextureProvider } from '../render/debug-textures.js';
import { createEnvironmentWiring } from '../render/environment-wiring.js';
import { createBackfaceOverlayController } from '../render/backface-overlay.js';
import { createShadingController } from '../render/shading-controller.js';
import { createAssetLoaders } from '../io/asset-loaders.js';
import { createImportHandlers } from '../io/import-handlers.js';
import { createFileFlowUIController } from '../io/file-flow-ui.js';
import { SAMPLE_MODELS } from '../io/sample-models.js';
import { createBatchFinalizer } from '../io/batch-finalizer.js';
import {
    detectSlotFromMatOrObj,
    findGeomSuffix,
    GEOM_SUFFIXES,
    isGlassByName,
    isGlassGeomSuffix,
} from '../material/naming.js';
import { createGlassController } from '../material/glass-controller.js';
import { createGlassMeshOptimizer } from '../material/glass-mesh-optimizer.js';
import { createMaterialRenamer } from '../material/rename-materials.js';
import { createAutobindPipeline } from '../material/autobind-pipeline.js';
import { copyTextureSettings } from '../material/texture-utils.js';
import { createToStandard } from '../material/to-standard.js';
import {
    applyGeoOffsetByOrientation,
    describeFBXOrientation,
    describeOrientationType,
    determineOrientationType,
    normalizeObjectOrientation,
    parseOrientationFromNode,
    readFBXOrientationFromTree,
} from '../fbx/orientation.js';
import { markCollisionMeshes } from '../fbx/collisions.js';
import { splitAllMeshesByUDIM_SM } from '../fbx/udim-split.js';
import {
    BEAUTY_WIRE_ANGLE_DEG,
    clearBeautyWire,
    clearWireframeOverlay,
    ensureBeautyWire,
    ensureWireframeOverlay,
} from '../render/wire-overlays.js';
import { detectRendererMode } from '../render/renderer-mode.js';

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
        const dom = collectViewerDom(document);
        app.dom = dom;

        const statusUI = createStatusUIController({
            statusEl: dom.statusEl,
            appbarStatusEl: dom.appbarStatusEl,
            emptyHintEl: dom.emptyHintEl,
        });
        const statusEl = dom.statusEl;
        const emptyHintEl = dom.emptyHintEl;
        const setStatusMessage = statusUI.setStatusMessage;
        const setEmptyHintVisible = statusUI.setEmptyHintVisible;
        const shadingSel = dom.shadingSel;

        

        const sunHourEl = dom.sunHourEl;
        const sunHourInputEl = dom.sunHourInputEl;
        const sunIntensityEl = dom.sunIntensityEl;
        const sunIntensityInputEl = dom.sunIntensityInputEl;
        const sunDayEl = dom.sunDayEl;
        const sunMonthEl = dom.sunMonthEl;
        const sunNorthEl = dom.sunNorthEl;

        const imagesDetails = dom.imagesDetails;
        const bindLogDetails = dom.bindLogDetails;
        
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

        const iblChk = dom.iblChk;
        const hdriPresetSel = dom.hdriPresetSel;
        const iblIntEl = dom.iblIntEl;
        const iblGammaEl = dom.iblGammaEl;
        const iblTintEl = dom.iblTintEl;
        const iblRotEl = dom.iblRotEl;
        const hemiIntEl = dom.hemiIntEl;
        const hemiSkyEl = dom.hemiSkyEl;
        const hemiGroundEl = dom.hemiGroundEl;
        const hdriExposureEl = dom.hdriExposureEl;
        const hdriSaturationEl = dom.hdriSaturationEl;
        const hdriBlurEl = dom.hdriBlurEl;
	        const isZUp = () => false;
	        const toggleSideBtn = dom.toggleSideBtn;
	        const loadParcelsBtn = dom.loadParcelsBtn;
	        const resetViewerBtn = dom.resetViewerBtn;
	        const resetViewBtn = dom.resetViewBtn;
	        const fullscreenBtn = dom.fullscreenBtn;
	        const statsBtn = dom.statsBtn;
	        const solidToggleBtn = dom.solidToggleBtn;
	        const collToggleBtn = dom.collToggleBtn;
	        const vpmToggleBtn = dom.vpmToggleBtn;
	        const npmToggleBtn = dom.npmToggleBtn;
	        const bgToggleBtn = dom.bgToggleBtn;
	        const camsToggleBtn = dom.camsToggleBtn;
	        const gridToggleBtn = dom.gridToggleBtn;
	        const statsOverlayEl = dom.statsOverlayEl;
	        const camsBarEl = dom.camsBarEl;
	        const camsBarListEl = dom.camsBarListEl;
	        const camsDetailsEl = dom.camsDetailsEl;
	        const camsCountEl = dom.camsCountEl;
	        const camsSideListEl = dom.camsSideListEl;

        const glassOpacityEl = dom.glassOpacityEl;
        const glassIorEl = dom.glassIorEl;
        const glassTransmissionEl = dom.glassTransmissionEl;
        const glassReflectEl = dom.glassReflectEl;
        const glassRoughEl = dom.glassRoughEl;
        const glassMetalEl = dom.glassMetalEl;
        const glassAttenDistEl = dom.glassAttenDistEl;
        const glassAttenColorEl = dom.glassAttenColorEl;
        const glassColorEl = dom.glassColorEl;
        const glassResetBtn = dom.glassResetBtn;

        const outEl = dom.outEl;
        const matSelect = dom.matSelect;
        const bindLogEl = dom.bindLogEl;
		        const { logBind, logSessionHeader } = createBindLogController({ bindLogEl });

		        const bgAlphaEl = dom.bgAlphaEl;

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

        const sampleSelect = dom.sampleSelect;

	        let didInitialRebase = false;
	        let galleryNeedsRefresh = false;
	        let layoutController = null;
	        let lastFinalizedModelIndex = 0;
		        let renderLoop = null;
		        let glassController = null;
		        let materialsPanel = null;
		        let appbarVisibilityToggles = null;
		        let schedulePanelRefreshImpl = () => {};
		        let syncCollisionButtonsImpl = () => {
		            appbarVisibilityToggles?.enforceSuppressionIfNeeded?.();
		            appbarVisibilityToggles?.updateAll?.();
		        };

        const rootEl = dom.rootEl;
        const dropEl = dom.dropEl;
        app.location = { latitude: MOSCOW_LAT, longitude: MOSCOW_LON };

        function requestRender() {
            renderLoop?.requestRender?.();
        }

	        // =====================
	        // THREE.js scene init
	        // =====================
	        const sceneCore = createSceneCore({
	            THREE,
	            OrbitControls,
	            app,
	            rootEl,
	            requestRender,
	            setStatusMessage,
	            useWebGPU: USE_WEBGPU,
	            WebGPURendererCtor,
	            background: {
	                isEnvironmentEnabled: () => !!iblChk?.checked,
	                getAlpha: () => parseFloat(bgAlphaEl?.value || '1'),
	                bgAlphaEl,
	                bgToggleBtn,
	                body: document?.body || null,
	            },
	            window,
	            document,
	        });

	        const scene = sceneCore.scene;
	        const world = sceneCore.world;
	        const camera = sceneCore.camera;
	        const renderer = sceneCore.renderer;
	        const rendererInitPromise = sceneCore.rendererInitPromise;
	        const getRendererReady = sceneCore.getRendererReady;
	        const backgroundController = sceneCore.backgroundController;
		        const controls = sceneCore.controls;
		        const flightControls = sceneCore.flightControls;
		        const hemiLight = sceneCore.hemiLight;
		        const dirLight = sceneCore.dirLight;
	        const markSceneStatsDirty = sceneCore.markSceneStatsDirty;
	        const getSceneGeometryStats = sceneCore.getSceneGeometryStats;

	        app.renderer = renderer;
	        app.rendererInitPromise = rendererInitPromise;

		        const cameraPresets = createCameraPresetsController({
		            THREE,
		            camera,
		            controls,
		            requestRender,
		            requestLayout: () => getLayoutController().layout(),
		            camsToggleBtn,
		            camsBarEl,
		            camsBarListEl,
		            camsDetailsEl,
		            camsCountEl,
		            camsSideListEl,
		        });
		        app.cameraPresets = cameraPresets;

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

			        const sunEnabledEl = dom.sunEnabledEl;
			        const sunControlsEl = dom.sunControlsEl;

			        const sunShadows = createSunShadowsController({
			            root: document,
			            THREE,
			            app,
			            scene,
			            world,
			            camera,
			            controls,
			            renderer,
			            dirLight,
			            northGrid,
			            latitude: MOSCOW_LAT,
			            longitude: MOSCOW_LON,
			            getDay: () => sunDayEl?.value,
			            getMonth: () => sunMonthEl?.value,
			            getHour: () => sunHourEl?.value,
			            getNorthDeg: () => sunNorthEl?.value,
			            sunEnabledEl,
			            sunControlsEl,
			            getBgMesh: backgroundController.getBgMesh,
			            layout,
			            requestRender,
			        });
			        const computeSceneBounds = sunShadows.computeSceneBounds;
			        const focusOn = sunShadows.focusOn;
			        const fitAll = sunShadows.fitAll;
			        const computeWorldCenter = sunShadows.computeWorldCenter;
			        const updateSun = sunShadows.updateSun;
			        const fitSunShadowToScene = sunShadows.fitSunShadowToScene;


	        // =====================
	        // Loaders & caches
	        // =====================
		        const {
		            fbxLoader,
		            textureLoader,
	            texLd,
	            parseFBXInWorker,
	            parseFBXOnMainThread,
	            isWorkerSupported: isFBXWorkerSupported,
	            setWorkerSupported: setFBXWorkerSupported,
	            disableWorker: disableFBXWorker,
		            unpackZIPInWorker,
		        } = createAssetLoaders({ THREE });
		        const {
		            setEnvironmentRotation,
		            requestEnvironmentRebuild,
		            loadHDRBase,
		            syncEnvAdjustmentsState,
		            buildAndApplyEnvFromRotation,
		            setEnvironmentEnabled,
		            applyEnvToMaterials,
		            getCurrentEnv,
		            getCurrentBg,
		            selectPresetIndex,
		        } = createEnvironmentWiring({
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

	   
			        // Bounds / framing now provided by `createSunShadowsController`.
			        // HDR / IBL handling moved to `modules/render/environment-manager.js`

			        const gridVisibilityController = createGridVisibilityController({
			            app,
			            grid: app.grid,
			            gridToggleBtn,
			            requestRender,
			            initialVisible: true,
			        });

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
		            checkerUrl: 'textures/uv_grid1.jpg',
		            requestRender,
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
	        shadingController.bindUI({ shadingSel });

			        // =====================
			        // Objects visibility
			        // =====================

			        const {
			            handleEyeToggle: handleEyeToggleRaw,
			            updateEyeButtonsForTarget,
			            setMeshAndMaterialsVisibility,
			            ensureZipCollisionsHidden,
			            hideSMCollisions,
			            getCollisionsState,
			            toggleCollisionsVisible,
			            getNonGlassState,
			            toggleNonGlassSuppressed,
			            applyNonGlassSuppression,
			            getVPMModelsState,
			            toggleVPMModelsVisible,
			            getNPMModelsState,
				            toggleNPMModelsVisible,
				        } = createVisibilityAndCollisions({
				            world,
				            loadedModels,
				            outEl,
			            requestRender,
		            markSceneStatsDirty,
		            schedulePanelRefresh,
				            syncCollisionButtons,
				        });

				        appbarVisibilityToggles = createAppbarVisibilityTogglesController({
				            solidToggleBtn,
				            collToggleBtn,
				            vpmToggleBtn,
				            npmToggleBtn,
				            schedulePanelRefresh,
				            api: {
				                handleEyeToggleRaw,
				                getNonGlassState,
				                toggleNonGlassSuppressed,
				                applyNonGlassSuppression,
				                getCollisionsState,
				                toggleCollisionsVisible,
				                getVPMModelsState,
				                toggleVPMModelsVisible,
				                getNPMModelsState,
				                toggleNPMModelsVisible,
				            },
				        });
				        const handleEyeToggle = appbarVisibilityToggles.handleEyeToggle;
				        appbarVisibilityToggles.updateAll();


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
				            getCurrentEnv,
				            selectPresetIndex,
				        });

			        createAppbarControlsController({
			            document,
			            window,
			            statsBtn,
			            gridToggleBtn,
			            resetViewerBtn,
			            resetViewBtn,
				            fullscreenBtn,
				            isStatsVisible: () => statsOverlayController.isVisible(),
				            setStatsVisible,
				            isGridVisible: gridVisibilityController.isVisible,
				            setGridVisible: gridVisibilityController.setVisible,
			            onResetView: () => {
			                if (!loadedModels.length) return;
			                fitAll();
			                focusOn(loadedModels.map(m => m.obj));
			            },
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
		            lightHelpersBtn: dom.lightHelpersBtn,
		            lightEmittersBtn: dom.lightEmittersBtn,
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
			        const inspectorPanels = createInspectorPanels({
			            THREE,
			            dom,
			            world,
			            loadedModels,
			            outEl,
			            matSelect,
			            requestRender,
			            handleEyeToggle,
			            updateEyeButtonsForTarget,
			            openGeoModal,
			            texInfo,
			            applyGlassControlsToScene,
			            appbarVisibilityToggles,
			            basename,
			            guessKindFromName,
			            getSelectedMaterialLink,
			            textureLoader,
			            toStandard,
			            copyTextureSettings,
			            getEnvironment: () => scene.environment,
			            getEnvMapIntensity: () => parseFloat(iblIntEl.value),
			            cacheOriginalMaterialFor,
			            logBind,
			            markGalleryRendered: () => { galleryNeedsRefresh = false; },
			        });
			        materialsPanel = inspectorPanels.materialsPanel;
			        const renderGallery = inspectorPanels.renderGallery;
			        schedulePanelRefreshImpl = inspectorPanels.schedulePanelRefresh;
			        syncCollisionButtonsImpl = inspectorPanels.syncCollisionButtons;

			        function schedulePanelRefresh(afterRender) {
			            schedulePanelRefreshImpl(afterRender);
			        }

			        /** Синхронизирует состояние кнопок «Коллизии» (по файлам и группам) с текущей видимостью. */
			        function syncCollisionButtons() {
			            syncCollisionButtonsImpl();
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

	        const {
	            buildVPMIndex,
	            autoBindVPMForModel,
	            autoBindByNamesForModel,
	        } = createAutobindPipeline({
	            THREE,
	            basename,
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
	            geomSuffixes: GEOM_SUFFIXES,
	            guessKindFromName,
	            isGlassByName,
	            isGlassGeomSuffix,
	            undoStack,
	            getEntries: () => allEmbedded,
	            getEnvironment: () => scene.environment,
	            getEnvMapIntensity: () => parseFloat(iblIntEl.value),
	            isWebGL2: () => !!renderer.capabilities?.isWebGL2,
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
		        const { handleFBXFile, handleZIPFile } = createImportHandlers({
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
		            isWorkerSupported: isFBXWorkerSupported,
		            setWorkerSupported: setFBXWorkerSupported,
		            disableWorker: disableFBXWorker,
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
		            unpackZIPInWorker,
		            makeGeoJsonMeta,
			            ensureZipCollisionsHidden,
			            JSZip: (typeof globalThis !== 'undefined' ? globalThis.JSZip : null),
			        });

	        // =====================
	        // File flow
	        // =====================
	        const fileInput = dom.fileInput;
	        const openBtn = dom.openBtn;
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
		                    bgMesh.material.map = getCurrentBg() || null;
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
	            getRendererReady,
	            updateStatsOverlay,
	            onFrame: () => {
	                flightControls.update();
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
