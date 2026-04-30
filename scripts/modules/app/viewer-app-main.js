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
import { createLoadedModelSceneIndex } from '../scene/loaded-model-scene-index.js';
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
import { createCameraPickController } from '../ui/camera-pick.js';
import { createAnnotations3DController } from '../annotations/annotations-3d.js';
import { createPromptModalController } from '../ui/prompt-modal.js';
import { createConfirmModalController } from '../ui/confirm-modal.js';
import { createPasswordResetModalController } from '../ui/password-reset-modal.js';
import { createTransitionModalController } from '../ui/transition-modal.js';
import { createExportModalController } from '../ui/export-modal.js';
import { createRectAnnotationModalController } from '../ui/rect-annotation-modal.js';
import { createGridVisibilityController } from '../ui/grid-visibility.js';
import { createLayoutController } from '../ui/layout.js';
import { createInspectorPanels } from '../ui/inspector-panels.js';
import { createVisibilityAndCollisions } from '../ui/visibility-collisions.js';
import { collectViewerDom } from '../ui/viewer-dom.js';
import { createCustomSelectController } from '../ui/custom-select.js';
import { createCollabController } from '../collab/collab-controller.js';
import { runAbortableTusUpload } from '../collab/abortable-tus-upload.js';
import { createCameraSyncController } from '../collab/camera-sync.js';
import { createDeferredRealtimeReload } from '../collab/deferred-realtime-reload.js';
import { createRoomModelLoadQueue } from '../collab/room-model-load-queue.js';
import { createSupabaseClient } from '../collab/supabase-client.js';
import { createVoiceController } from '../voice/voice-controller.js';
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
import { exportWorldAsGLTF } from '../io/gltf-export.js';
import { createVRController } from '../vr/vr-controller.js';
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
import { installConsoleDiagnosticsGate } from '../utils/console-diagnostics.js';
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

installConsoleDiagnosticsGate();

const rendererMode = await detectRendererMode();
const activeRendererMode = rendererMode.activeRendererMode;
const USE_WEBGPU = rendererMode.useWebGPU;
const WebGPURendererCtor = rendererMode.WebGPURendererCtor;
const webgpuModuleError = rendererMode.webgpuModuleError;
const rendererModeNote = rendererMode.rendererModeNote;
const backfaceNodeSupport = rendererMode.backfaceNodeSupport;

export class ViewerApp {
    constructor() {
        const app = this;
        // =====================
        // DOM references
        // =====================
        const dom = collectViewerDom(document);
        app.dom = dom;
        const bootLoaderEl = dom.bootLoaderEl;
        const bootLoaderBarEl = dom.bootLoaderBarEl;
        const bootLoaderTextEl = dom.bootLoaderTextEl;
        const bootLoaderPctEl = dom.bootLoaderPctEl;
        const bodyEl = document?.body || null;
        let bootProgress = 0;
        let bootLoaderHidden = false;
        const appEventCleanups = [];
        const appTimeouts = new Set();

        function addAppEventListener(target, type, handler, options) {
            if (!target?.addEventListener || typeof handler !== 'function') return false;
            target.addEventListener(type, handler, options);
            appEventCleanups.push(() => {
                try {
                    target.removeEventListener(type, handler, options);
                } catch (_) {}
            });
            return true;
        }

        function setAppTimeout(handler, delay = 0, ...args) {
            const setTimer =
                typeof window !== 'undefined' && typeof window.setTimeout === 'function'
                    ? window.setTimeout.bind(window)
                    : setTimeout;
            const token = setTimer(() => {
                appTimeouts.delete(token);
                handler(...args);
            }, delay);
            appTimeouts.add(token);
            return token;
        }

        function clearAppTimeout(token) {
            if (!token) return;
            const clearTimer =
                typeof window !== 'undefined' && typeof window.clearTimeout === 'function'
                    ? window.clearTimeout.bind(window)
                    : clearTimeout;
            appTimeouts.delete(token);
            clearTimer(token);
        }

        function disposeAppEventListeners() {
            appEventCleanups.splice(0).forEach((cleanup) => {
                try {
                    cleanup();
                } catch (_) {}
            });
        }

        function disposeAppTimers() {
            Array.from(appTimeouts).forEach((token) => clearAppTimeout(token));
            appTimeouts.clear();
        }

        const pageLoadedPromise = new Promise((resolve) => {
            if (typeof window === 'undefined' || document.readyState === 'complete') {
                resolve();
                return;
            }
            addAppEventListener(window, 'load', () => resolve(), { once: true });
        });

        const isCoarseMobileViewport = () => {
            if (typeof window === 'undefined') return false;
            const narrowViewport =
                typeof window.matchMedia === 'function'
                    ? window.matchMedia('(max-width: 980px)').matches
                    : Number(window.innerWidth || 0) <= 980;
            const coarsePointer =
                typeof window.matchMedia === 'function'
                    ? window.matchMedia('(hover: none) and (pointer: coarse)').matches
                    : true;
            return narrowViewport && coarsePointer;
        };

        function setupMobileImmersiveViewport() {
            if (typeof window === 'undefined' || !document?.documentElement || !bodyEl) return;
            if (!isCoarseMobileViewport()) return;

            const rootEl = document.documentElement;
            bodyEl.classList.add('mobile-immersive');

            let rafToken = 0;
            let collapseTimer = 0;
            let fullscreenAttempted = false;

            const syncViewportHeight = () => {
                const visualViewport = window.visualViewport || null;
                const viewportHeight = Math.max(1, Math.round(visualViewport?.height || window.innerHeight || 1));
                rootEl.style.setProperty('--mobileViewportH', `${viewportHeight}px`);
            };

            const scheduleViewportSync = () => {
                if (rafToken) {
                    cancelAnimationFrame(rafToken);
                }
                rafToken = requestAnimationFrame(() => {
                    rafToken = 0;
                    syncViewportHeight();
                });
            };

            const collapseBrowserChrome = () => {
                if (collapseTimer) {
                    clearAppTimeout(collapseTimer);
                }
                collapseTimer = setAppTimeout(() => {
                    collapseTimer = 0;
                    syncViewportHeight();
                    try {
                        window.scrollTo(0, 1);
                    } catch (_) {}
                }, 70);
            };

            const tryRequestFullscreen = () => {
                if (fullscreenAttempted) return;
                fullscreenAttempted = true;
                const requestFullscreen = rootEl.requestFullscreen || rootEl.webkitRequestFullscreen;
                if (typeof requestFullscreen !== 'function') return;
                try {
                    const maybePromise = requestFullscreen.call(rootEl);
                    if (maybePromise && typeof maybePromise.catch === 'function') {
                        maybePromise.catch(() => {});
                    }
                } catch (_) {}
            };

            syncViewportHeight();
            collapseBrowserChrome();

            addAppEventListener(window, 'resize', () => {
                scheduleViewportSync();
                collapseBrowserChrome();
            }, { passive: true });
            addAppEventListener(window, 'orientationchange', () => {
                scheduleViewportSync();
                collapseBrowserChrome();
            }, { passive: true });
            addAppEventListener(window, 'focus', collapseBrowserChrome, { passive: true });
            addAppEventListener(window, 'pageshow', collapseBrowserChrome, { passive: true });
            addAppEventListener(window, 'pointerup', collapseBrowserChrome, { passive: true });
            addAppEventListener(window, 'pointerdown', tryRequestFullscreen, { once: true, passive: true });
            addAppEventListener(window.visualViewport, 'resize', scheduleViewportSync, { passive: true });
            addAppEventListener(window.visualViewport, 'scroll', scheduleViewportSync, { passive: true });
            appEventCleanups.push(() => {
                if (rafToken && typeof cancelAnimationFrame === 'function') {
                    cancelAnimationFrame(rafToken);
                }
                rafToken = 0;
                if (collapseTimer) {
                    clearAppTimeout(collapseTimer);
                    collapseTimer = 0;
                }
                rootEl.style.removeProperty('--mobileViewportH');
                bodyEl?.classList.remove('mobile-immersive');
            });
        }

        setupMobileImmersiveViewport();

        function setBootProgress(nextValue, message) {
            const value = Math.max(0, Math.min(100, Number(nextValue) || 0));
            bootProgress = Math.max(bootProgress, value);
            if (bootLoaderBarEl) {
                bootLoaderBarEl.style.width = `${bootProgress}%`;
            }
            if (bootLoaderPctEl) {
                bootLoaderPctEl.textContent = `${Math.round(bootProgress)}%`;
            }
            if (bootLoaderTextEl && message) {
                bootLoaderTextEl.textContent = String(message);
            }
            if (bootLoaderEl) {
                bootLoaderEl.querySelector('.boot-loader-track')?.setAttribute('aria-valuenow', String(Math.round(bootProgress)));
            }
        }

        function hideBootLoader() {
            if (appDisposed) return;
            if (bootLoaderHidden) return;
            bootLoaderHidden = true;
            setBootProgress(100, 'Готово');
            if (!bootLoaderEl) {
                bodyEl?.classList.remove('app-loading');
                return;
            }
            bootLoaderEl.classList.add('is-leaving');
            setAppTimeout(() => {
                if (appDisposed) return;
                bootLoaderEl.hidden = true;
                bodyEl?.classList.remove('app-loading');
            }, 230);
        }

        setBootProgress(8, 'Подготовка интерфейса...');

        const customSelects = createCustomSelectController({ root: document });
        app.customSelects = customSelects;

        const promptModal = createPromptModalController({
            modalEl: dom.promptModalEl,
            titleEl: dom.promptTitleEl,
            inputEl: dom.promptInputEl,
            okBtn: dom.promptOkBtn,
            cancelBtn: dom.promptCancelBtn,
            closeBtn: dom.promptCloseBtn,
        });

        const confirmModal = createConfirmModalController({
            modalEl: dom.confirmModalEl,
            titleEl: dom.confirmTitleEl,
            messageEl: dom.confirmMessageEl,
            okBtn: dom.confirmOkBtn,
            cancelBtn: dom.confirmCancelBtn,
            closeBtn: dom.confirmCloseBtn,
        });

        const resetModal = createPasswordResetModalController({
            modalEl: dom.resetModalEl,
            titleEl: dom.resetTitleEl,
            messageEl: dom.resetMessageEl,
            passwordEl: dom.resetPasswordEl,
            repeatEl: dom.resetPasswordRepeatEl,
            okBtn: dom.resetOkBtn,
            cancelBtn: dom.resetCancelBtn,
            closeBtn: dom.resetCloseBtn,
        });

        const transitionModal = createTransitionModalController({
            modalEl: dom.transitionModalEl,
            titleEl: dom.transitionTitleEl,
            secondsEl: dom.transitionSecondsEl,
            typeEl: dom.transitionTypeEl,
            trajectoryEl: dom.transitionTrajectoryEl,
            okBtn: dom.transitionOkBtn,
            cancelBtn: dom.transitionCancelBtn,
            closeBtn: dom.transitionCloseBtn,
        });

        const exportModal = createExportModalController({
            modalEl: dom.exportModalEl,
            titleEl: dom.exportTitleEl,
            formatEl: dom.exportFormatEl,
            coordsEl: dom.exportCoordsEl,
            okBtn: dom.exportOkBtn,
            cancelBtn: dom.exportCancelBtn,
            closeBtn: dom.exportCloseBtn,
        });

        const rectAnnotModal = createRectAnnotationModalController({
            modalEl: dom.rectAnnotModalEl,
            titleEl: dom.rectAnnotTitleEl,
            closeBtn: dom.rectAnnotCloseBtn,
            okBtn: dom.rectAnnotOkBtn,
            cancelBtn: dom.rectAnnotCancelBtn,
            colorEl: dom.rectAnnotColorEl,
            fillRowEl: dom.rectAnnotFillRowEl,
            fillEl: dom.rectAnnotFillEl,
            infoRowEl: dom.rectAnnotInfoRowEl,
            infoEl: dom.rectAnnotInfoEl,
            areaEl: dom.rectAnnotAreaEl,
            textEl: dom.rectAnnotTextEl,
            textRowEl: dom.rectAnnotTextRowEl,
        });
        setBootProgress(18, 'Инициализация модулей...');

        const statusUI = createStatusUIController({
            statusEl: dom.statusEl,
            appbarStatusEl: dom.appbarStatusEl,
            emptyHintEl: dom.emptyHintEl,
        });
        setBootProgress(24, 'Инициализация панелей...');
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
		        const focusPickBtn = dom.focusPickBtn;
		        const exportBtn = dom.exportBtn;
		        const orderBtn = dom.orderBtn;
		        const fullscreenBtn = dom.fullscreenBtn;
        const vrToggleBtn = dom.vrToggleBtn;

        const orderModalEl = dom.orderModalEl;
        let prevEmptyHintVisible = null;
        const setOrderModalVisible = (visible) => {
            if (!orderModalEl) return;
            const nextVisible = !!visible;
            orderModalEl.classList.toggle('show', nextVisible);
            if (!emptyHintEl) return;
            if (nextVisible) {
                prevEmptyHintVisible = !emptyHintEl.hidden;
                setEmptyHintVisible(false);
            } else if (prevEmptyHintVisible != null) {
                setEmptyHintVisible(prevEmptyHintVisible);
                prevEmptyHintVisible = null;
            }
        };
        if (orderBtn && orderModalEl) {
            addAppEventListener(orderBtn, 'click', () => setOrderModalVisible(true));
        }
        if (orderModalEl) {
            addAppEventListener(orderModalEl, 'click', (event) => {
                if (event.target === orderModalEl) {
                    setOrderModalVisible(false);
                }
            });
        }
        if (typeof window !== 'undefined' && orderModalEl) {
            addAppEventListener(window, 'keydown', (event) => {
                if (event.key === 'Escape' && orderModalEl.classList.contains('show')) {
                    setOrderModalVisible(false);
                }
            });
        }
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
			        const camPropsDetailsEl = dom.camPropsDetailsEl;
			        const camPropsTitleEl = dom.camPropsTitleEl;
			        const camPropsPanelEl = dom.camPropsPanelEl;

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

		        const sliderValuesUI = createSliderValuesUIController({
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
	        let appDisposed = false;
		        let renderLoop = null;
	        let glassController = null;
	        let materialsPanel = null;
	        let appbarVisibilityToggles = null;
	        let fileFlowUI = null;
	        let assetLoaders = null;
	        let inspectorPanels = null;
		        let schedulePanelRefreshImpl = () => {};
		        let syncCollisionButtonsImpl = () => {
		            appbarVisibilityToggles?.enforceSuppressionIfNeeded?.();
		            appbarVisibilityToggles?.updateAll?.();
		        };

        const rootEl = dom.rootEl;
        const dropEl = dom.dropEl;
        app.location = { latitude: MOSCOW_LAT, longitude: MOSCOW_LON };

        function requestRender() {
            if (appDisposed) return;
            renderLoop?.requestRender?.();
        }

	        // =====================
	        // THREE.js scene init
	        // =====================
        setBootProgress(34, 'Создание сцены...');
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
        setBootProgress(50, 'Сцена готова...');

        app.renderer = renderer;
        app.rendererInitPromise = rendererInitPromise;

        let cameraPresetsChangeHandler = null;
        const cameraPresets = createCameraPresetsController({
            THREE,
            camera,
            controls,
            annotationsEnabled: false,
            annotateCanvasEl: dom.annotateCanvasEl,
            annotateToolbarEl: dom.annotateToolbarEl,
            annoToggleBtn: dom.annoToggleBtn,
            annoVisibleBtn: dom.annoVisibleBtn,
            annoDrawBtn: dom.annoDrawBtn,
			            annoColorEl: dom.annoColorEl,
			            annoDashEl: dom.annoDashEl,
			            annoWidthEl: dom.annoWidthEl,
			            annoUndoBtn: dom.annoUndoBtn,
			            annoClearBtn: dom.annoClearBtn,
			            requestRender,
			            requestLayout: () => getLayoutController().layout(),
			            promptCameraName: (defaultName) => promptModal.open({
			                title: 'Имя камеры',
		                value: defaultName,
		                placeholder: 'Имя камеры',
		                type: 'text',
		            }),
		            promptAnnotationText: (defaultValue = '') => promptModal.open({
		                title: 'Текст аннотации',
		                value: defaultValue,
		                placeholder: 'Текст…',
		                type: 'text',
		            }),
		            confirmCameraDelete: (preset) => confirmModal.open({
		                title: 'Удалить камеру?',
		                message: `Вы точно хотите удалить камеру “${preset?.name || 'Camera'}”?`,
		                okText: 'Удалить',
		                cancelText: 'Отмена',
		            }),
		            promptTransition: ({ from, to, seconds, type, trajectory }) => transitionModal.open({
		                title: `Переход: ${(from?.name || 'Camera')} → ${(to?.name || 'Camera')}`,
		                seconds: seconds ?? 0,
		                type: type ?? 'soft',
		                trajectory: trajectory ?? 'linear',
		            }),
		            onChange: (state) => cameraPresetsChangeHandler?.(state),
		            camsToggleBtn,
		            camsBarEl,
		            camsBarListEl,
		            camsDetailsEl,
		            camsCountEl,
		            camsSideListEl,
            camPropsDetailsEl,
            camPropsTitleEl,
            camPropsPanelEl,
        });
        app.cameraPresets = cameraPresets;

        let collabController = null;
        let cameraSync = null;
        let annotations3d = null;
        let roomUpdateHandler = null;

        function makeClientId() {
            if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
                return crypto.randomUUID();
            }
            return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
        }

        annotations3d = createAnnotations3DController({
            THREE,
            world,
            camera,
            controls,
            flightControls,
            renderer,
            annotateCanvasEl: dom.annotateCanvasEl,
            annotateToolbarEl: dom.annotateToolbarEl,
            annoToggleBtn: dom.annoToggleBtn,
            annoVisibleBtn: dom.annoVisibleBtn,
            annoDrawBtn: dom.annoDrawBtn,
            annoColorEl: dom.annoColorEl,
            annoDashEl: dom.annoDashEl,
            annoWidthEl: dom.annoWidthEl,
            annoUndoBtn: dom.annoUndoBtn,
            annoClearBtn: dom.annoClearBtn,
            annoLayerSelectEl: dom.annoLayerSelectEl,
            annoLayerAddBtn: dom.annoLayerAddBtn,
            requestRender,
            canRemoveStroke: (stroke) => {
                const localUserId = collabController?.user?.id || null;
                const authorId = stroke?.userData?.authorId || null;
                if (!localUserId) {
                    return !authorId;
                }
                if (!authorId) return true;
                return authorId === localUserId;
            },
            promptLayerName: (defaultName) => promptModal.open({
                title: 'Имя слоя',
                value: defaultName,
                placeholder: 'Имя слоя',
                type: 'text',
            }),
            promptRectSettings: (options) => rectAnnotModal.open({
                title: 'Прямоугольник',
                ...(options || {}),
            }),
            onStrokeCommitted: ({ stroke, record }) => {
                if (!collabController || !record || !stroke) return;
                const id = makeClientId();
                record.id = id;
                if (record.kind === 'pin' && record.payload?.camera) {
                    const text = String(record.payload?.settings?.text || '').trim();
                    const name = text ? `Pin: ${text}` : `Pin ${Date.now()}`;
                    cameraPresets?.addFromSnapshot?.(record.payload.camera, name, { activate: false });
                }
                const authorName = collabController.getDisplayName?.();
                if (authorName) {
                    record.author_name = authorName;
                    stroke.userData = stroke.userData || {};
                    stroke.userData.authorName = authorName;
                    stroke.userData.authorId = collabController.user?.id || null;
                    if (stroke.userData.authorId) {
                        recordContributor(stroke.userData.authorId, authorName);
                        annotations3d?.refreshAuthorVisibility?.(stroke.userData.authorId);
                    }
                }
                annotations3d?.registerAnnotationId?.(stroke, id);
                collabController.sendAnnotation(record).catch((err) => {
                    console.error('Annotation sync failed', err);
                });
            },
            onStrokeRemoved: ({ annotationId }) => {
                if (!collabController || !annotationId) return;
                collabController.deleteAnnotation(annotationId).catch((err) => {
                    console.error('Annotation delete failed', err);
                });
            },
        });
        app.annotations3d = annotations3d;
        setBootProgress(66, 'Подготовка инструментов...');

        const collabStatusEl = dom.collabStatusEl;
        const collabNameEl = dom.collabNameEl;
        const collabEmailEl = dom.collabEmailEl;
        const collabPasswordEl = dom.collabPasswordEl;
        const collabPasswordConfirmEl = dom.collabPasswordConfirmEl;
        const collabEmailErrorEl = dom.collabEmailErrorEl;
        const collabNameErrorEl = dom.collabNameErrorEl;
        const collabPasswordErrorEl = dom.collabPasswordErrorEl;
        const collabPasswordConfirmErrorEl = dom.collabPasswordConfirmErrorEl;
        const collabAuthErrorEl = dom.collabAuthErrorEl;
        const collabShowLoginBtn = dom.collabShowLoginBtn;
        const collabShowRegisterBtn = dom.collabShowRegisterBtn;
        const collabBackBtns = dom.collabBackBtns;
        const collabJoinBtn = dom.collabJoinBtn;
        const collabSignupBtn = dom.collabSignupBtn;
        const collabGuestBtn = dom.collabGuestBtn;
        const collabResetBtn = dom.collabResetBtn;
        const collabResendBtn = dom.collabResendBtn;
        const collabPanelBtn = dom.collabPanelBtn;
        const collabDrawerEl = dom.collabDrawerEl;
        const collabDrawerCloseBtn = dom.collabDrawerCloseBtn;
        const collabAuthPanelEl = dom.collabAuthPanelEl;
        const collabRoomEntryIntroEl = dom.collabRoomEntryIntroEl;
        const collabEntryProjectEl = dom.collabEntryProjectEl;
        const collabEntryRoomEl = dom.collabEntryRoomEl;
        const collabFooterEl = dom.collabFooterEl;
        const collabFooterGuestEl = dom.collabFooterGuestEl;
        const collabFooterRegisteredEl = dom.collabFooterRegisteredEl;
        const collabFooterProjectNameEl = dom.collabFooterProjectNameEl;
        const collabFooterRoomNameEl = dom.collabFooterRoomNameEl;
        const collabStatusBtn = dom.collabStatusBtn;
        const voiceJoinBtn = dom.voiceJoinBtn;
        const voiceMuteBtn = dom.voiceMuteBtn;
        const voiceAudioMountEl = dom.voiceAudioMountEl;
        const collabChatPanelEl = dom.collabChatPanelEl;
        const collabChatToggleBtn = dom.collabChatToggleBtn;
        const collabProjectSelectEl = dom.collabProjectSelectEl;
        const collabProjectCreateEl = dom.collabProjectCreateEl;
        const collabProjectNameInputEl = dom.collabProjectNameInputEl;
        const collabRoomSelectEl = dom.collabRoomSelectEl;
        const collabRoomCreateEl = dom.collabRoomCreateEl;
        const collabRoomNameInputEl = dom.collabRoomNameInputEl;
        const collabRoomLinkEl = dom.collabRoomLinkEl;
        const collabCopyBtn = dom.collabCopyBtn;
        const collabReserveBtn = dom.collabReserveBtn;
        const collabOwnerEl = dom.collabOwnerEl;
        const collabParticipantsEl = dom.collabParticipantsEl;
        const collabChatLogEl = dom.collabChatLogEl;
        const collabChatInputEl = dom.collabChatInputEl;
        const collabChatSendBtn = dom.collabChatSendBtn;
        const collabChatParticipantsEl = dom.collabChatParticipantsEl;

        let collabAuthMode = 'initial';
        const collabCreateOptionValue = '__create__';

        function setCollabDrawerOpen(next) {
            if (!collabDrawerEl) return;
            const isOpen = !!next;
            collabDrawerEl.hidden = !isOpen;
            if (collabPanelBtn) {
                collabPanelBtn.classList.toggle('active', isOpen);
                collabPanelBtn.setAttribute('aria-pressed', isOpen ? 'true' : 'false');
            }
            if (isOpen && !collabAuthed) {
                setAuthMode(getInitialAuthMode());
            }
            syncRoomEntryLandingState();
        }

        function getInitialAuthMode() {
            return hasRoomEntryLinkInUrl() ? 'roomEntry' : 'initial';
        }

        function setAuthMode(mode) {
            const next = mode || 'initial';
            collabAuthMode = next;
            if (collabAuthPanelEl) {
                collabAuthPanelEl.dataset.mode = next;
            }
            clearAuthErrors();
            syncRoomEntryLandingState();
        }

        function submitAuthFromEnter() {
            if (!collabDrawerEl || collabDrawerEl.hidden) return;
            const mode = collabAuthPanelEl?.dataset?.mode || collabAuthMode || getInitialAuthMode();
            if (mode === 'login') {
                void connectCollab('login');
            } else if (mode === 'register') {
                void connectCollab('signup');
            } else if (mode === 'roomEntry') {
                void connectCollab('guest');
            }
        }

        function clearAuthErrors() {
            const targets = [
                collabEmailErrorEl,
                collabNameErrorEl,
                collabPasswordErrorEl,
                collabPasswordConfirmErrorEl,
                collabAuthErrorEl,
            ];
            targets.forEach((el) => {
                if (!el) return;
                el.textContent = '';
            });
        }

        function setFieldError(el, message) {
            if (!el) return;
            el.textContent = String(message || '').trim();
        }

        function setAuthError(message) {
            setFieldError(collabAuthErrorEl, message);
        }

        function formatRoomEntrySlug(value, fallback = '—') {
            const safeValue = String(value || '').trim();
            return safeValue || fallback;
        }

        function formatRoomEntryProjectLabel(value, fallback = '—') {
            const safeValue = String(value || '').trim();
            if (!safeValue) return fallback;
            const parts = safeValue.split('-').filter(Boolean);
            if (parts.length < 2) return safeValue;
            const suffix = parts[parts.length - 1] || '';
            if (suffix.length >= 8 && /[a-z]/i.test(suffix) && /\d/.test(suffix)) {
                return parts.slice(0, -1).join('-') || safeValue;
            }
            return safeValue;
        }

        function updateRoomEntryIntro() {
            if (!collabRoomEntryIntroEl) return;
            const projectLabel = formatRoomEntryProjectLabel(collabProject?.name || collabProject?.slug || getProjectSlugFromUrl());
            const roomLabel = formatRoomEntrySlug(collabRoom?.slug || getRoomSlugFromUrl());
            if (collabEntryProjectEl) {
                collabEntryProjectEl.textContent = projectLabel;
            }
            if (collabEntryRoomEl) {
                collabEntryRoomEl.textContent = roomLabel;
            }
        }

        function canGuestEnter() {
            return hasRoomEntryLinkInUrl();
        }

        function isRoomEntryLandingActive() {
            return canGuestEnter() && !collabAuthed;
        }

        function syncRoomEntryLandingState() {
            const active = isRoomEntryLandingActive();
            bodyEl?.classList?.toggle?.('room-entry-landing', active);
            if (collabDrawerEl) {
                const mode = collabAuthPanelEl?.dataset?.mode || collabAuthMode || getInitialAuthMode();
                collabDrawerEl.classList.toggle('room-entry-overlay', active && mode === 'roomEntry');
            }
            if (active) {
                setEmptyHintVisible(false);
            }
            updateRoomEntryIntro();
        }

        function updateCollabFooter() {
            if (!collabFooterEl) return;
            const hasSession = !!collabAuthed;
            collabFooterEl.hidden = !hasSession;
            if (!hasSession) return;

            const isRegistered = !!collabIsRegistered;
            if (collabFooterGuestEl) collabFooterGuestEl.hidden = isRegistered;
            if (collabFooterRegisteredEl) collabFooterRegisteredEl.hidden = !isRegistered;

            if (!isRegistered) {
                if (collabFooterProjectNameEl) {
                    collabFooterProjectNameEl.textContent = collabProject?.name || collabProject?.slug || '—';
                }
                if (collabFooterRoomNameEl) {
                    collabFooterRoomNameEl.textContent = collabRoom?.slug || '—';
                }
            }

            if (collabReserveBtn) {
                collabReserveBtn.hidden = !collabController;
            }
            if (collabOwnerEl) {
                collabOwnerEl.hidden = !collabController;
            }
            updateVoiceButtons();
        }

        const supabaseUrl =
            (typeof window !== 'undefined' && window.__SUPABASE_URL ? String(window.__SUPABASE_URL) : '') ||
            (typeof localStorage !== 'undefined' ? String(localStorage.getItem('lpmview.supabaseUrl') || '') : '');
        const supabaseAnonKey =
            (typeof window !== 'undefined' && window.__SUPABASE_ANON_KEY ? String(window.__SUPABASE_ANON_KEY) : '') ||
            (typeof localStorage !== 'undefined' ? String(localStorage.getItem('lpmview.supabaseAnonKey') || '') : '');
        const voiceApiUrl =
            (typeof window !== 'undefined' && window.__VOICE_API_URL ? String(window.__VOICE_API_URL) : '') ||
            (typeof localStorage !== 'undefined' ? String(localStorage.getItem('lpmview.voiceApiUrl') || '') : '');

        const collabReady = !!(supabaseUrl && supabaseAnonKey);
        const voiceReady = !!voiceApiUrl;
        let collabSupabase = null;
        let collabSupabaseMode = 'default';
        let collabUser = null;
        let collabAuthed = false;
        let collabIsRegistered = false;
        let collabIsSuperuser = false;
        let collabProject = null;
        let collabRoom = null;
        let collabRoomInviteToken = '';
        let collabRoomInviteRoomId = '';
        let collabProjects = [];
        let collabRooms = [];
        let collabOwnerId = null;
        let collabParticipants = [];
        let collabSessionGeneration = 0;
        let presenceRefreshTimer = null;
        const PRESENCE_REFRESH_MS = 3000;
        const PRESENCE_STALE_MS = 15000;
        let roomModelsChannel = null;
        const loadedRoomModelIds = new Set();
        let isLoadingRoomModels = false;
        let loadingRoomModelsGeneration = 0;
        let roomModelCount = 0;
        let roomLoadGeneration = 0;
        const activeRoomImportControllers = new Set();
        const activeRoomModelSyncControllers = new Set();
        let roomModelLoadQueue = null;
        let remoteModelLoadRoomId = '';
        let remoteModelLoadModelId = '';
        let roomCamerasChannel = null;
        let roomTransitionsChannel = null;
        let cameraSyncMuted = false;
        let cameraSyncMuteToken = 0;
        let cameraPersistTimer = null;
        let roomCameraRealtimeReload = null;
        let roomCameraCount = 0;
        let collabConnectionOnline = false;
        let collabAutoResumeEnabled = false;
        let collabAutoResumeTimer = null;
        let collabAutoResumeInFlight = false;
        let collabAutoResumeAttempt = 0;
        let collabAnnotatePointerHooksBound = false;
        const isMobileUi = () => {
            if (typeof window === 'undefined') return false;
            if (typeof window.matchMedia === 'function') {
                return window.matchMedia('(max-width: 980px)').matches;
            }
            return Number(window.innerWidth || 0) <= 980;
        };
        let chatPanelVisible = !isMobileUi();
        const seenChatMessageIds = new Set();
        const collabContributors = new Map();
        let contributorsRenderQueued = false;
        let contributorsRenderTimer = null;
        let voiceController = null;
        let voiceConnected = false;
        let voiceConnecting = false;
        let voiceMicEnabled = false;
        let voiceParticipants = [];
        let voiceAutoJoinRequested = false;

        function getVoiceParticipantState(ids) {
            const list = Array.isArray(ids) ? ids : [ids];
            let connected = false;
            let speaking = false;
            let isLocal = false;
            list.forEach((id) => {
                if (!id) return;
                const match = voiceParticipants.find((participant) => participant.id === id);
                if (!match) return;
                connected = true;
                speaking = speaking || !!match.speaking;
                isLocal = isLocal || !!match.isLocal;
            });
            return { connected, speaking, isLocal };
        }

        function getVoiceRoomName() {
            const roomId = String(collabRoom?.id || '').trim();
            if (!roomId) return '';
            return `room:${roomId}`;
        }

        function getVoiceDisplayName() {
            return String(collabController?.getDisplayName?.() || collabNameEl?.value || '').trim() || 'Guest';
        }

        function getVoiceMetadata() {
            return {
                source: 'lpmview',
                projectId: String(collabProject?.id || ''),
                roomId: String(collabRoom?.id || ''),
                registered: !!collabIsRegistered,
            };
        }

        function applyVoiceState(snapshot = {}) {
            voiceConnected = !!snapshot.connected;
            voiceConnecting = !!snapshot.connecting;
            voiceMicEnabled = !!snapshot.micEnabled;
            voiceParticipants = Array.isArray(snapshot.participants) ? snapshot.participants : [];
            updateVoiceButtons();
            renderParticipants(collabParticipants);
            scheduleContributorsRender();
            if (snapshot?.error) {
                console.error('Voice state error', snapshot.error);
            }
        }

        async function ensureVoiceController() {
            if (voiceController) return voiceController;
            voiceController = createVoiceController({
                voiceApiUrl,
                audioMountEl: voiceAudioMountEl,
                onState: applyVoiceState,
            });
            return voiceController;
        }

        function updateVoiceButtons() {
            const canUseVoice = !!(voiceReady && collabController && collabRoom);
            if (voiceJoinBtn) {
                voiceJoinBtn.hidden = !canUseVoice;
                voiceJoinBtn.disabled = !canUseVoice || voiceConnecting;
                voiceJoinBtn.textContent = voiceConnecting
                    ? 'VOICE…'
                    : voiceConnected
                        ? (voiceParticipants.some((participant) => participant.speaking) ? 'VOICE LIVE' : 'VOICE ON')
                        : 'VOICE';
                voiceJoinBtn.classList.toggle('is-online', voiceConnected);
                voiceJoinBtn.classList.toggle('is-offline', !voiceConnected);
                voiceJoinBtn.classList.toggle('is-speaking', voiceParticipants.some((participant) => participant.speaking));
                voiceJoinBtn.setAttribute('aria-pressed', voiceConnected ? 'true' : 'false');
            }
            if (voiceMuteBtn) {
                voiceMuteBtn.hidden = !voiceConnected;
                voiceMuteBtn.disabled = !voiceConnected || voiceConnecting;
                voiceMuteBtn.textContent = voiceMicEnabled ? 'MIC ON' : 'MIC OFF';
                voiceMuteBtn.classList.toggle('is-unmuted', voiceConnected && voiceMicEnabled);
                voiceMuteBtn.classList.toggle('is-muted', voiceConnected && !voiceMicEnabled);
                voiceMuteBtn.setAttribute('aria-pressed', voiceConnected && !voiceMicEnabled ? 'true' : 'false');
            }
        }

        async function joinVoiceRoom(options = {}) {
            if (!voiceReady || !collabController || !collabRoom) return;
            voiceAutoJoinRequested = true;
            try {
                const controller = await ensureVoiceController();
                await controller.connect({
                    room: getVoiceRoomName(),
                    identity: String(collabController?.user?.id || '').trim() || undefined,
                    name: getVoiceDisplayName(),
                    metadata: getVoiceMetadata(),
                });
            } catch (error) {
                if (!options?.preserveIntent) {
                    voiceAutoJoinRequested = false;
                }
                console.error('Voice connect failed', error);
            }
        }

        async function disconnectVoiceRoom(options = {}) {
            const preserveIntent = !!options?.preserveIntent;
            if (!preserveIntent) {
                voiceAutoJoinRequested = false;
            }
            if (!voiceController) {
                applyVoiceState({ connected: false, connecting: false, micEnabled: false, participants: [] });
                return;
            }
            try {
                await voiceController.disconnect();
            } catch (error) {
                console.error('Voice disconnect failed', error);
            }
        }

        function formatCollabStatusLabel(value) {
            const raw = String(value || '').trim();
            if (!raw) {
                if (collabController) {
                    return collabConnectionOnline ? 'в комнате' : 'не в сети';
                }
                return isRoomEntryLandingActive() ? 'по ссылке' : 'не подключено';
            }
            const key = raw.toLowerCase();
            const mapped = {
                on: 'в комнате',
                off: isRoomEntryLandingActive() ? 'по ссылке' : 'не подключено',
                offline: 'не в сети',
                ready: 'готово',
                auth: 'вход',
                connecting: 'подключение',
                reconnecting: 'переподключение',
                error: 'ошибка',
                'confirm email': 'подтвердите email',
                'room missing': 'комната не найдена',
                'project missing': 'проект не найден',
            };
            return mapped[key] || raw;
        }

        function setCollabStatus(text) {
            if (!collabStatusEl) return;
            collabStatusEl.textContent = formatCollabStatusLabel(text);
        }

        function updateCollabStatusButton() {
            if (!collabStatusBtn) return;
            if (!collabReady) {
                collabStatusBtn.hidden = true;
                return;
            }
            const isOnline = !!collabController && collabConnectionOnline;
            const isEntry = !collabAuthed;
            const isIdle = collabAuthed && !collabController && !isOnline;
            collabStatusBtn.hidden = false;
            collabStatusBtn.textContent = isOnline ? 'ONLINE' : (isEntry ? 'ВХОД' : 'ГОТОВО');
            collabStatusBtn.classList.toggle('is-online', isOnline);
            collabStatusBtn.classList.toggle('is-offline', !isOnline && !isEntry && !isIdle);
            collabStatusBtn.classList.toggle('is-entry', isEntry || isIdle);
            collabStatusBtn.setAttribute('aria-pressed', (isOnline || isIdle) ? 'true' : 'false');
            updateVoiceButtons();
        }

        function clearCollabAutoResumeTimer() {
            if (!collabAutoResumeTimer) return;
            clearAppTimeout(collabAutoResumeTimer);
            collabAutoResumeTimer = null;
        }

        function makeRoomLoadAbortError(message = 'Room model load superseded') {
            try {
                return new DOMException(message, 'AbortError');
            } catch (_) {
                const err = new Error(message);
                err.name = 'AbortError';
                return err;
            }
        }

        function isAbortError(error) {
            return error?.name === 'AbortError';
        }

        function abortActiveRoomImports() {
            if (!activeRoomImportControllers.size && !activeRoomModelSyncControllers.size) return;
            const reason = makeRoomLoadAbortError();
            activeRoomImportControllers.forEach((controller) => {
                try {
                    if (!controller.signal?.aborted) controller.abort(reason);
                } catch (_) {}
            });
            activeRoomModelSyncControllers.forEach((controller) => {
                try {
                    if (!controller.signal?.aborted) controller.abort(reason);
                } catch (_) {}
            });
            activeRoomImportControllers.clear();
            activeRoomModelSyncControllers.clear();
        }

        function getRoomModelLoadQueue() {
            if (!roomModelLoadQueue) {
                roomModelLoadQueue = createRoomModelLoadQueue({
                    isCurrent: ({ generation, roomId }) => isActiveRoomLoad(generation, roomId),
                    loadModelNow: (model, context) => loadProjectModelNow(model, context),
                    onError: (err) => console.error('Room model queued load failed', err),
                });
            }
            return roomModelLoadQueue;
        }

        function bumpRoomLoadGeneration() {
            roomLoadGeneration += 1;
            roomModelLoadQueue?.clear?.();
            abortActiveRoomImports();
            return roomLoadGeneration;
        }

        function isActiveRoomLoad(generation, roomId) {
            if (generation !== roomLoadGeneration) return false;
            if (!collabController?.room?.id) return false;
            return String(collabController.room.id) === String(roomId || '');
        }

        function bumpCollabSessionGeneration() {
            collabSessionGeneration += 1;
            return collabSessionGeneration;
        }

        function isActiveCollabSession(generation) {
            return generation === collabSessionGeneration;
        }

        function beginCameraSyncMute() {
            cameraSyncMuted = true;
            cameraSyncMuteToken += 1;
            return cameraSyncMuteToken;
        }

        function endCameraSyncMute(token) {
            if (token !== cameraSyncMuteToken) return;
            cameraSyncMuted = false;
        }

        function clearCameraSyncMute() {
            cameraSyncMuteToken += 1;
            cameraSyncMuted = false;
        }

        function getRoomCameraRealtimeReload() {
            if (!roomCameraRealtimeReload) {
                roomCameraRealtimeReload = createDeferredRealtimeReload({
                    isMuted: () => cameraSyncMuted,
                    isCurrent: ({ controller, roomId, generation }) => (
                        !!controller
                        && controller === collabController
                        && isActiveRoomLoad(generation, roomId)
                    ),
                    reload: ({ controller, roomId, generation }) => (
                        loadRoomCameras({ controller, roomId, generation })
                    ),
                    onError: (err) => console.error('Room cameras realtime reload failed', err),
                });
            }
            return roomCameraRealtimeReload;
        }

        function requestRoomCameraRealtimeReload(context) {
            getRoomCameraRealtimeReload().request(context);
        }

        function flushRoomCameraRealtimeReload(context) {
            roomCameraRealtimeReload?.flush?.(context);
        }

        function setCollabConnectionState(connected, reason = '') {
            void reason;
            collabConnectionOnline = !!connected;
            updateCollabStatusButton();
        }

        function hasCollabReconnectContext() {
            return !!(
                collabAutoResumeEnabled
                && collabProject
                && collabRoom
                && collabUser
                && collabSupabase
            );
        }

        async function resumeCollabSession(trigger = '') {
            if (appDisposed) return;
            if (collabAutoResumeInFlight || !collabAutoResumeEnabled) return;
            if (!hasCollabReconnectContext()) return;
            if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
            collabAutoResumeInFlight = true;
            collabAutoResumeAttempt += 1;
            setCollabStatus('reconnecting');
            try {
                const displayName = String(collabController?.getDisplayName?.() || collabNameEl?.value || '').trim() || 'Guest';
                if (collabController) {
                    await teardownCollabSession({ preserveAutoResume: true });
                }
                await connectToRoom(displayName, { isAutoReconnect: true, throwOnError: true });
                collabAutoResumeAttempt = 0;
            } catch (err) {
                console.error('Collab auto-resume failed', err);
                setCollabConnectionState(false, `resume-failed:${String(trigger || '')}`);
                scheduleCollabAutoResume('retry');
            } finally {
                collabAutoResumeInFlight = false;
            }
        }

        function scheduleCollabAutoResume(trigger = '') {
            if (appDisposed) return;
            if (!hasCollabReconnectContext()) return;
            if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
            if (collabAutoResumeInFlight) return;
            clearCollabAutoResumeTimer();
            const delay = Math.min(15000, 1000 * (2 ** Math.min(collabAutoResumeAttempt, 4)));
            collabAutoResumeTimer = setAppTimeout(() => {
                collabAutoResumeTimer = null;
                if (appDisposed) return;
                void resumeCollabSession(trigger);
            }, delay);
        }

        function handleBrowserOffline() {
            if (!collabController) return;
            setCollabConnectionState(false, 'browser-offline');
            setCollabStatus('offline');
        }

        function handleBrowserOnline() {
            if (!collabController) return;
            scheduleCollabAutoResume('browser-online');
        }

        function setChatPanelVisible(next) {
            chatPanelVisible = !!next;
            if (collabChatPanelEl) {
                collabChatPanelEl.hidden = !chatPanelVisible;
            }
            if (collabChatToggleBtn) {
                collabChatToggleBtn.classList.toggle('active', chatPanelVisible);
                collabChatToggleBtn.setAttribute('aria-pressed', chatPanelVisible ? 'true' : 'false');
            }
        }

        function setChatPanelAvailability(enabled) {
            if (collabChatToggleBtn) {
                collabChatToggleBtn.hidden = !enabled;
            }
            if (!enabled) {
                setChatPanelVisible(false);
            } else {
                setChatPanelVisible(!isMobileUi());
            }
        }

        function recordContributor(id, name) {
            if (appDisposed) return;
            if (!id) return;
            const safeName = String(name || '').trim() || 'Guest';
            const entry = collabContributors.get(id) || { id, name: safeName, hidden: false, hiddenPins: false };
            if (safeName && safeName !== entry.name) entry.name = safeName;
            collabContributors.set(id, entry);
            scheduleContributorsRender();
        }

        function cancelContributorsRender() {
            if (contributorsRenderTimer) {
                clearAppTimeout(contributorsRenderTimer);
                contributorsRenderTimer = null;
            }
            contributorsRenderQueued = false;
        }

        function scheduleContributorsRender() {
            if (appDisposed) return;
            if (contributorsRenderQueued) return;
            contributorsRenderQueued = true;
            contributorsRenderTimer = setAppTimeout(() => {
                contributorsRenderTimer = null;
                contributorsRenderQueued = false;
                if (appDisposed) return;
                renderChatContributors();
            }, 0);
        }

        function startPresenceRefresh() {
            if (presenceRefreshTimer) return;
            presenceRefreshTimer = setInterval(() => {
                if (!collabController) return;
                renderChatContributors();
            }, PRESENCE_REFRESH_MS);
        }

        function stopPresenceRefresh() {
            if (!presenceRefreshTimer) return;
            clearInterval(presenceRefreshTimer);
            presenceRefreshTimer = null;
        }

        function normalizeContributorKey(value) {
            return String(value || 'Guest').trim().toLowerCase();
        }

        function renderChatContributors() {
            if (appDisposed) return;
            if (!collabChatParticipantsEl) return;
            const now = Date.now();
            const onlineIds = new Set();
            const onlineNameKeys = new Set();
            (collabParticipants || []).forEach((participant) => {
                const lastSeen = participant?.lastSeenAt ? Date.parse(participant.lastSeenAt) : NaN;
                const isFresh = Number.isFinite(lastSeen) ? now - lastSeen <= PRESENCE_STALE_MS : true;
                if (!isFresh) return;
                if (participant?.id) onlineIds.add(participant.id);
                const key = normalizeContributorKey(participant?.name || '');
                if (key) onlineNameKeys.add(key);
            });
            const localUserId = collabController?.user?.id || null;
            const localNameKey = collabController?.getDisplayName
                ? normalizeContributorKey(collabController.getDisplayName())
                : '';
            if (localNameKey) {
                onlineNameKeys.add(localNameKey);
            }
            const grouped = new Map();
            collabContributors.forEach((entry) => {
                const key = normalizeContributorKey(entry.name);
                const online = onlineIds.has(entry.id) || (localUserId && entry.id === localUserId);
                const existing = grouped.get(key);
                if (!existing) {
                    grouped.set(key, {
                        name: entry.name || 'Guest',
                        ids: [entry.id],
                        online: online || onlineNameKeys.has(key),
                        hiddenAll: !!entry.hidden,
                        hiddenPinsAll: !!entry.hiddenPins,
                    });
                    return;
                }
                existing.ids.push(entry.id);
                existing.online = existing.online || online || onlineNameKeys.has(key);
                existing.hiddenAll = existing.hiddenAll && !!entry.hidden;
                existing.hiddenPinsAll = existing.hiddenPinsAll && !!entry.hiddenPins;
                if (online && entry.name) {
                    existing.name = entry.name;
                }
            });
            const list = Array.from(grouped.values())
                .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
            collabChatParticipantsEl.innerHTML = '';
            if (!list.length) {
                collabChatParticipantsEl.textContent = '—';
                return;
            }
            list.forEach((entry) => {
                const row = document.createElement('div');
                const online = entry.online;
                row.className = `collab-chat-user ${online ? 'online' : 'offline'}`;
                const voiceState = getVoiceParticipantState(entry.ids);

                const eyeBtn = document.createElement('button');
                eyeBtn.type = 'button';
                eyeBtn.className = 'eye';
                eyeBtn.textContent = entry.hiddenAll ? '🙈' : '👁';
                eyeBtn.title = entry.hiddenAll ? 'Показать аннотации' : 'Скрыть аннотации';
                eyeBtn.addEventListener('click', () => {
                    const nextHidden = !entry.hiddenAll;
                    entry.hiddenAll = nextHidden;
                    entry.ids.forEach((authorId) => {
                        const stored = collabContributors.get(authorId);
                        if (stored) {
                            stored.hidden = nextHidden;
                        }
                        annotations3d?.setAuthorVisibility?.(authorId, !nextHidden);
                    });
                    scheduleContributorsRender();
                });

                const pinBtn = document.createElement('button');
                pinBtn.type = 'button';
                pinBtn.className = 'eye eye-pin';
                pinBtn.textContent = entry.hiddenPinsAll ? '📍' : '📌';
                pinBtn.title = entry.hiddenPinsAll ? 'Показать PIN' : 'Скрыть PIN';
                pinBtn.addEventListener('click', () => {
                    const nextHidden = !entry.hiddenPinsAll;
                    entry.hiddenPinsAll = nextHidden;
                    entry.ids.forEach((authorId) => {
                        const stored = collabContributors.get(authorId);
                        if (stored) {
                            stored.hiddenPins = nextHidden;
                        }
                        annotations3d?.setPinVisibility?.(authorId, !nextHidden);
                    });
                    scheduleContributorsRender();
                });

                const nameEl = document.createElement('span');
                nameEl.className = 'collab-chat-user-name';
                nameEl.textContent = entry.name || 'Guest';

                const voiceEl = document.createElement('span');
                voiceEl.className = 'collab-chat-user-voice';
                if (voiceState.connected) voiceEl.classList.add('is-online');
                if (voiceState.speaking) voiceEl.classList.add('is-speaking');
                voiceEl.title = voiceState.connected
                    ? (voiceState.speaking ? 'В голосовом чате, говорит' : 'В голосовом чате')
                    : 'Не в голосовом чате';

                row.append(eyeBtn, pinBtn, voiceEl, nameEl);
                collabChatParticipantsEl.appendChild(row);
            });
        }

        function getRoomSlugFromUrl() {
            try {
                const url = new URL(window.location.href);
                return url.searchParams.get('room') || '';
            } catch (_) {
                return '';
            }
        }

        function getProjectSlugFromUrl() {
            try {
                const url = new URL(window.location.href);
                return url.searchParams.get('project') || '';
            } catch (_) {
                return '';
            }
        }

        function getInviteTokenFromUrl() {
            try {
                const url = new URL(window.location.href);
                return String(url.searchParams.get('invite') || '').trim();
            } catch (_) {
                return '';
            }
        }

        function hasRoomEntryLinkInUrl() {
            return !!getInviteTokenFromUrl() || (!!getProjectSlugFromUrl() && !!getRoomSlugFromUrl());
        }

        function buildRoomLinkUrl(projectSlug, roomSlug, inviteToken = '') {
            try {
                const url = new URL(window.location.href);
                if (projectSlug) {
                    url.searchParams.set('project', projectSlug);
                } else {
                    url.searchParams.delete('project');
                }
                if (roomSlug) {
                    url.searchParams.set('room', roomSlug);
                } else {
                    url.searchParams.delete('room');
                }
                if (inviteToken) {
                    url.searchParams.set('invite', inviteToken);
                } else {
                    url.searchParams.delete('invite');
                }
                return url.toString();
            } catch (_) {
                return '';
            }
        }

        function setRoomSlugInUrl(projectSlug, roomSlug, inviteToken = '', options = {}) {
            try {
                const nextUrl = buildRoomLinkUrl(projectSlug, roomSlug, inviteToken);
                if (nextUrl && options?.replaceHistory !== false) {
                    window.history.replaceState({}, '', nextUrl);
                }
                return nextUrl;
            } catch (_) {
                return '';
            }
        }

        function formatChatTime(value) {
            if (!value) return '';
            const date = new Date(value);
            if (Number.isNaN(date.getTime())) return '';
            return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
        }

        function makeSlug(length = 8) {
            const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
            let out = '';
            for (let i = 0; i < length; i += 1) {
                out += chars[Math.floor(Math.random() * chars.length)];
            }
            return out;
        }

        function slugifyName(value) {
            const cleaned = String(value || '')
                .trim()
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-+|-+$/g, '');
            return cleaned || '';
        }

        function isMissingRpcSignature(error, functionName) {
            const code = String(error?.code || '').trim();
            const message = `${error?.message || ''} ${error?.details || ''}`.trim();
            return (
                code === 'PGRST202'
                || (
                    message.includes(functionName)
                    && (
                        message.includes('Could not find the function')
                        || message.includes('No function matches')
                    )
                )
            );
        }

        function isMissingJoinProjectRpcSignature(error) {
            return isMissingRpcSignature(error, 'join_project_by_slug');
        }

        function isMissingJoinRoomInviteRpcSignature(error) {
            return isMissingRpcSignature(error, 'join_room_by_invite');
        }

        function isMissingEnsureRoomInviteRpcSignature(error) {
            return isMissingRpcSignature(error, 'ensure_room_invite');
        }

        function clearRoomInviteTokenState() {
            collabRoomInviteToken = '';
            collabRoomInviteRoomId = '';
        }

        function setRoomInviteTokenState(token, roomId) {
            collabRoomInviteToken = String(token || '').trim();
            collabRoomInviteRoomId = String(roomId || '').trim();
        }

        function getRoomInviteTokenState(roomId) {
            const safeRoomId = String(roomId || '').trim();
            if (!safeRoomId || collabRoomInviteRoomId !== safeRoomId) return '';
            return String(collabRoomInviteToken || '').trim();
        }

        function setCollabControlsDisabled(disabled) {
            const targets = [
                collabProjectSelectEl,
                collabRoomSelectEl,
            ];
            targets.forEach((el) => {
                if (!el) return;
                el.disabled = !!disabled;
            });
        }

        function setCollabCreateEnabled(enabled) {
            if (!enabled) {
                toggleCreatePanel(collabProjectCreateEl, collabProjectNameInputEl, false);
                toggleCreatePanel(collabRoomCreateEl, collabRoomNameInputEl, false);
            }
        }

        function requireRegistered() {
            if (collabIsRegistered) return true;
            setCollabStatus('регистрация');
            setAuthError('Только зарегистрированные пользователи могут создавать проекты и комнаты.');
            return false;
        }

        function setCollabSessionEnabled(enabled) {
            const targets = [
                collabCopyBtn,
                collabReserveBtn,
                collabChatInputEl,
                collabChatSendBtn,
            ];
            targets.forEach((el) => {
                if (!el) return;
                el.disabled = !enabled;
            });
        }

        function setCollabToolsEnabled(enabled) {
            const next = !!enabled;
            if (camsToggleBtn) camsToggleBtn.disabled = !next;
            if (dom.camsDetailsEl) {
                dom.camsDetailsEl.classList.toggle('collab-disabled', !next);
            }
            if (!next && camsBarEl) camsBarEl.hidden = true;
            if (dom.camPropsDetailsEl) {
                dom.camPropsDetailsEl.classList.toggle('collab-disabled', !next);
            }
            if (dom.annoToggleBtn) dom.annoToggleBtn.disabled = !next;
            if (dom.annotateToolbarEl) dom.annotateToolbarEl.classList.toggle('collab-disabled', !next);
            if (!next) {
                annotations3d?.setEnabled?.(false);
            }
        }

        async function teardownCollabSession(options = {}) {
            const preserveAutoResume = !!options?.preserveAutoResume;
            const previousRoomId = String(collabController?.room?.id || collabRoom?.id || '');
            bumpCollabSessionGeneration();
            bumpRoomLoadGeneration();
            await disconnectVoiceRoom({ preserveIntent: preserveAutoResume && voiceAutoJoinRequested });
            stopPresenceRefresh();
            cancelContributorsRender();
            cameraSync?.dispose?.();
            cameraSync = null;
            clearCameraSyncMute();
            if (cameraPersistTimer) {
                clearTimeout(cameraPersistTimer);
                cameraPersistTimer = null;
            }
            clearCollabAutoResumeTimer();
            if (!preserveAutoResume) {
                collabAutoResumeEnabled = false;
                collabAutoResumeAttempt = 0;
                collabAutoResumeInFlight = false;
            }

            const supabase = collabController?.supabase || collabSupabase;
            const extraChannels = [roomModelsChannel, roomCamerasChannel, roomTransitionsChannel];
            for (const channel of extraChannels) {
                if (!channel || !supabase?.removeChannel) continue;
                try {
                    await supabase.removeChannel(channel);
                } catch (_) {}
            }
            roomModelsChannel = null;
            roomCamerasChannel = null;
            roomTransitionsChannel = null;
            roomCameraRealtimeReload?.clear?.();

            if (collabController?.dispose) {
                try {
                    await collabController.dispose();
                } catch (_) {}
            }
            collabController = null;
            collabOwnerId = null;
            collabParticipants = [];
            renderParticipants(collabParticipants);
            updateOwnerLabel();
            updateReserveButton();
            setCollabSessionEnabled(false);
            setCollabToolsEnabled(false);
            setCollabConnectionState(false, preserveAutoResume ? 'reconnect' : 'session-closed');
            setCollabStatus('off');
            updateCollabStatusButton();
            setChatPanelAvailability(false);
            seenChatMessageIds.clear();
            if (collabChatLogEl) collabChatLogEl.innerHTML = '';
            collabContributors.clear();
            if (collabChatParticipantsEl) collabChatParticipantsEl.innerHTML = '';

            cleanupRoomScopedAssets(previousRoomId);
            roomModelCount = 0;
            roomCameraCount = 0;
            activeRoomModelId = '';
            loadedRoomModelIds.clear();
            if (collabRoomLinkEl) collabRoomLinkEl.value = '';
        }

        function canDeleteProjectItem(project) {
            if (!project || !collabUser) return false;
            return collabIsSuperuser || project.owner_id === collabUser.id;
        }

        function canDeleteRoomItem(room) {
            if (!room || !collabUser) return false;
            if (collabIsSuperuser) return true;
            if (room.owner_id === collabUser.id) return true;
            return collabProject?.owner_id === collabUser.id;
        }

        async function deleteProjectById(projectId) {
            if (!collabSupabase || !projectId) return;
            const project = collabProjects.find((p) => p.id === projectId) || collabProject;
            if (!canDeleteProjectItem(project)) return;
            const name = project?.name || project?.slug || 'проект';
            const confirmed = await confirmModal.open({
                title: 'Удалить проект',
                message: `Удалить проект "${name}" и все комнаты внутри?`,
                okText: 'Удалить',
                cancelText: 'Отмена',
            });
            if (!confirmed) return;
            try {
                await cleanupProjectStorageObjects(projectId);
                const { error } = await collabSupabase.from('projects').delete().eq('id', projectId);
                if (error) throw error;
                if (collabController?.project?.id === projectId) {
                    await teardownCollabSession();
                }
                if (collabProject?.id === projectId) {
                    collabProject = null;
                    collabRoom = null;
                    clearRoomInviteTokenState();
                    setRoomSlugInUrl('', '');
                }
                await loadProjects();
                renderRoomOptions([], '');
            } catch (err) {
                console.error('Project delete failed', err);
                setCollabStatus('error');
            } finally {
                updateAdminControls();
            }
        }

        async function deleteRoomById(roomId) {
            if (!collabSupabase || !roomId) return;
            const room = collabRooms.find((r) => r.id === roomId) || collabRoom;
            if (!canDeleteRoomItem(room)) return;
            const name = room?.slug || 'комната';
            const confirmed = await confirmModal.open({
                title: 'Удалить комнату',
                message: `Удалить комнату "${name}"?`,
                okText: 'Удалить',
                cancelText: 'Отмена',
            });
            if (!confirmed) return;
            try {
                const { error } = await collabSupabase.from('rooms').delete().eq('id', roomId);
                if (error) throw error;
                if (collabController?.room?.id === roomId) {
                    await teardownCollabSession();
                }
                if (collabRoom?.id === roomId) {
                    collabRoom = null;
                    clearRoomInviteTokenState();
                    setRoomSlugInUrl(collabProject?.slug || '', '');
                }
                if (collabProject) {
                    await loadRooms(collabProject.id);
                } else {
                    renderRoomOptions([], '');
                }
            } catch (err) {
                console.error('Room delete failed', err);
                setCollabStatus('error');
            } finally {
                updateAdminControls();
            }
        }

        async function deleteCurrentRoom() {
            if (!collabRoom) return;
            await deleteRoomById(collabRoom.id);
        }

        async function deleteCurrentProject() {
            if (!collabProject) return;
            await deleteProjectById(collabProject.id);
        }

        function appendChatMessage(message, options = {}) {
            if (!collabChatLogEl || !message) return;
            const messageId = message.id || message.message_id || null;
            if (messageId && seenChatMessageIds.has(messageId)) return;
            if (messageId) seenChatMessageIds.add(messageId);
            if (message.author_id) {
                recordContributor(message.author_id, message.author_name);
            }
            const row = document.createElement('div');
            row.className = 'collab-chat-msg';
            const meta = document.createElement('div');
            meta.className = 'collab-chat-meta';
            const timeText = formatChatTime(message.created_at);
            meta.textContent = `${message.author_name || 'Guest'}${timeText ? ' · ' + timeText : ''}`;
            const body = document.createElement('div');
            body.className = 'collab-chat-text';
            body.textContent = message.body || '';
            row.append(meta, body);
            collabChatLogEl.appendChild(row);
            if (options.scroll) {
                collabChatLogEl.scrollTop = collabChatLogEl.scrollHeight;
            }
        }

        function scrollChatToBottom() {
            if (!collabChatLogEl) return;
            collabChatLogEl.scrollTop = collabChatLogEl.scrollHeight;
        }

        function renderParticipants(list) {
            collabParticipants = Array.isArray(list) ? list : [];
            if (!collabParticipantsEl) return;
            collabParticipantsEl.innerHTML = '';
            if (!collabParticipants.length) {
                collabParticipantsEl.textContent = '—';
                scheduleContributorsRender();
                return;
            }
            collabParticipants.forEach((participant) => {
                const row = document.createElement('div');
                row.className = 'collab-member';
                const nameEl = document.createElement('span');
                nameEl.textContent = participant.name || 'Guest';
                const meta = document.createElement('small');
                const metaParts = [];
                if (participant.id === collabOwnerId) {
                    metaParts.push('ведёт');
                } else if (participant.id === collabController?.user?.id) {
                    metaParts.push('вы');
                }
                const voiceState = getVoiceParticipantState(participant.id);
                if (voiceState.connected) {
                    metaParts.push(voiceState.speaking ? 'говорит' : 'voice');
                }
                meta.textContent = metaParts.join(' · ');
                row.append(nameEl, meta);
                collabParticipantsEl.appendChild(row);
                const existing = collabContributors.get(participant.id);
                if (existing && participant.name && participant.name !== existing.name) {
                    existing.name = participant.name;
                }
            });
            scheduleContributorsRender();
        }

        function getOwnerName() {
            if (!collabOwnerId) return '';
            const match = collabParticipants.find((p) => p.id === collabOwnerId);
            return match?.name || '';
        }

        function updateOwnerLabel() {
            if (!collabOwnerEl) return;
            if (!collabOwnerId) {
                collabOwnerEl.textContent = isMobileUi() ? '-' : 'свободно';
                return;
            }
            const name = getOwnerName();
            collabOwnerEl.textContent = name ? `ведёт: ${name}` : 'ведёт: участник';
        }

        function setCollabOwner(ownerId) {
            collabOwnerId = ownerId || null;
            cameraSync?.setOwner?.(collabOwnerId);
            renderParticipants(collabParticipants);
            updateOwnerLabel();
            updateReserveButton();
        }

        function updateReserveButton() {
            if (!collabReserveBtn) return;
            if (!collabController) {
                collabReserveBtn.disabled = true;
                collabReserveBtn.classList.remove('active');
                collabReserveBtn.setAttribute('aria-pressed', 'false');
                collabReserveBtn.title = 'Резерв вращения';
                return;
            }
            const isOwner = !!cameraSync?.isOwner?.();
            collabReserveBtn.disabled = false;
            collabReserveBtn.classList.toggle('active', isOwner);
            collabReserveBtn.setAttribute('aria-pressed', isOwner ? 'true' : 'false');
            collabReserveBtn.title = isOwner ? 'Снять резерв' : 'Резерв вращения';
        }

        function resolveDisplayName(value) {
            const trimmed = String(value || '').trim();
            if (trimmed) return trimmed;
            if (typeof localStorage !== 'undefined') {
                const stored = String(localStorage.getItem('lpmview.displayName') || '').trim();
                if (stored) return stored;
            }
            return 'Guest';
        }

        function normalizeDisplayName(value) {
            const trimmed = String(value || '').trim();
            return trimmed || 'Guest';
        }

        function normalizeEmailInput(value) {
            let email = String(value || '').trim();
            const angleMatch = email.match(/<([^>]+)>/);
            if (angleMatch) {
                email = angleMatch[1];
            }
            return email.replace(/\s+/g, '');
        }

        function isValidEmail(value) {
            return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
        }

        function isExistingSignupError(err) {
            const code = String(err?.code || '').toLowerCase();
            if (code === 'user_already_exists' || code === 'email_address_already_in_use') {
                return true;
            }
            const message = String(err?.message || '').toLowerCase();
            return (
                message.includes('already registered') ||
                message.includes('already been registered') ||
                message.includes('user already') ||
                message.includes('user exists') ||
                message.includes('email already') ||
                message.includes('user_already_exists')
            );
        }

        function isRegisteredUser(user) {
            return !!(user && user.email);
        }

        async function refreshSuperuserFlag() {
            if (!collabSupabase) {
                collabIsSuperuser = false;
                return false;
            }
            const { data, error } = await collabSupabase.rpc('is_superuser');
            if (error) {
                collabIsSuperuser = false;
                return false;
            }
            collabIsSuperuser = !!data;
            return collabIsSuperuser;
        }

        function updateAdminControls() {
            const canDeleteProject = !!collabProject && canDeleteProjectItem(collabProject);
            const canDeleteRoom = !!collabRoom && canDeleteRoomItem(collabRoom);
            if (canDeleteProject || canDeleteRoom) {
                setCollabStatus('ready');
            }
        }

        function buildResetRedirectUrl() {
            try {
                const url = new URL(window.location.href);
                const removeKeys = ['type', 'token', 'code', 'access_token', 'refresh_token'];
                removeKeys.forEach((key) => url.searchParams.delete(key));
                url.hash = '';
                return url.toString();
            } catch (_) {
                return window.location.origin + window.location.pathname;
            }
        }

        function isRecoveryUrl() {
            try {
                const url = new URL(window.location.href);
                if (url.searchParams.get('type') === 'recovery') return true;
                const hashParams = new URLSearchParams(String(url.hash || '').replace(/^#/, ''));
                return hashParams.get('type') === 'recovery';
            } catch (_) {
                return false;
            }
        }

        function clearRecoveryUrl() {
            try {
                const url = new URL(window.location.href);
                const removeKeys = ['type', 'token', 'code', 'access_token', 'refresh_token'];
                removeKeys.forEach((key) => url.searchParams.delete(key));
                url.hash = '';
                window.history.replaceState({}, '', url.toString());
            } catch (_) {}
        }

        async function ensureSupabaseClient(mode = 'default') {
            if (!collabReady) return null;
            const nextMode = mode === 'guest' ? 'guest' : 'default';
            if (!collabSupabase || collabSupabaseMode !== nextMode) {
                collabUser = null;
                if (nextMode === 'guest' && typeof window !== 'undefined' && window.sessionStorage) {
                    collabSupabase = await createSupabaseClient({
                        url: supabaseUrl,
                        anonKey: supabaseAnonKey,
                        auth: {
                            persistSession: true,
                            storage: window.sessionStorage,
                            storageKey: 'lpmview.supabase.guest',
                        },
                    });
                } else {
                    collabSupabase = await createSupabaseClient({ url: supabaseUrl, anonKey: supabaseAnonKey });
                }
                collabSupabaseMode = nextMode;
            }
            return collabSupabase;
        }

        let resetFlowActive = false;
        let clearedPersistedEmailSession = false;

        async function openPasswordResetFlow() {
            if (resetFlowActive || !resetModal) return;
            resetFlowActive = true;
            try {
                const supabase = await ensureSupabaseClient();
                if (!supabase) return;
                try {
                    const url = new URL(window.location.href);
                    const code = url.searchParams.get('code');
                    if (code) {
                        await supabase.auth.exchangeCodeForSession(code);
                    }
                } catch (_) {}
                await supabase.auth.getSession();
                const newPassword = await resetModal.open({
                    title: 'Сброс пароля',
                    message: 'Введите новый пароль.',
                    okText: 'Сохранить',
                    cancelText: 'Отмена',
                });
                if (!newPassword) return;
                const { error } = await supabase.auth.updateUser({ password: newPassword });
                if (error) throw error;
                clearRecoveryUrl();
                alert('Пароль обновлён.');
            } catch (err) {
                console.error('Password reset failed', err);
                alert('Не удалось обновить пароль.');
            } finally {
                resetFlowActive = false;
            }
        }

        async function requestPasswordReset() {
            const email = normalizeEmailInput(collabEmailEl?.value);
            if (collabEmailEl && email) {
                collabEmailEl.value = email;
            }
            if (!email || !isValidEmail(email)) {
                setFieldError(collabEmailErrorEl, 'Введите корректный email.');
                return;
            }
            try {
                const supabase = await ensureSupabaseClient();
                if (!supabase) return;
                const redirectTo = buildResetRedirectUrl();
                const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
                if (error) throw error;
                setAuthError('Ссылка для сброса отправлена на email.');
            } catch (err) {
                console.error('Password reset email failed', err);
                setAuthError('Не удалось отправить письмо для сброса.');
            }
        }

        async function requestSignupConfirmation() {
            const email = normalizeEmailInput(collabEmailEl?.value);
            if (collabEmailEl && email) {
                collabEmailEl.value = email;
            }
            if (!email || !isValidEmail(email)) {
                setFieldError(collabEmailErrorEl, 'Введите корректный email.');
                return;
            }
            try {
                const supabase = await ensureSupabaseClient();
                if (!supabase) return;
                const redirectTo = buildResetRedirectUrl();
                const { error } = await supabase.auth.resend({
                    type: 'signup',
                    email,
                    options: { emailRedirectTo: redirectTo },
                });
                if (error) throw error;
                setAuthError('Письмо подтверждения отправлено.');
            } catch (err) {
                console.error('Resend signup email failed', err);
                setAuthError('Не удалось отправить письмо подтверждения.');
            }
        }

        async function maybeHandlePasswordRecovery() {
            if (!isRecoveryUrl()) return;
            await openPasswordResetFlow();
        }

        async function clearPersistedEmailSession() {
            if (clearedPersistedEmailSession) return;
            clearedPersistedEmailSession = true;
            if (!collabReady) return;
            if (isRecoveryUrl()) return;
            try {
                const supabase = await ensureSupabaseClient();
                if (!supabase) return;
                const { data } = await supabase.auth.getUser();
                const user = data?.user;
                if (!user?.email) return;
                await supabase.auth.signOut();
                collabUser = null;
                collabAuthed = false;
                collabIsRegistered = false;
                collabIsSuperuser = false;
                syncRoomEntryLandingState();
                setCollabControlsDisabled(false);
                setCollabCreateEnabled(false);
                setCollabSessionEnabled(false);
                setCollabToolsEnabled(false);
                setCollabStatus('off');
                updateCollabStatusButton();
                setChatPanelAvailability(false);
                updateAdminControls();
                updateCollabFooter();
            } catch (err) {
                console.error('Session clear failed', err);
            }
        }

        async function ensureCollabAuth({ mode, name, email, password } = {}) {
            if (!collabReady) return null;
            await ensureSupabaseClient(mode === 'guest' ? 'guest' : 'default');

            if (collabUser && (mode === 'login' || mode === 'signup') && !collabUser.email) {
                await collabSupabase.auth.signOut();
                collabUser = null;
            }

            if (!collabUser) {
                const { data: userData } = await collabSupabase.auth.getUser();
                if (userData?.user) {
                    collabUser = userData.user;
                }
            }

            if (!collabUser) {
                if (mode === 'login') {
                    const { data, error } = await collabSupabase.auth.signInWithPassword({
                        email: String(email || '').trim(),
                        password: String(password || ''),
                    });
                    if (error) throw error;
                    collabUser = data.user;
                } else if (mode === 'signup') {
                    const redirectTo = buildResetRedirectUrl();
                    const { data, error } = await collabSupabase.auth.signUp({
                        email: String(email || '').trim(),
                        password: String(password || ''),
                        options: { emailRedirectTo: redirectTo },
                    });
                    if (error) throw error;
                    if (!data?.session) {
                        setCollabStatus('confirm email');
                        throw new Error('Подтвердите email, чтобы войти.');
                    }
                    collabUser = data.user;
                } else if (mode === 'guest') {
                    const { data, error } = await collabSupabase.auth.signInAnonymously();
                    if (error) throw error;
                    collabUser = data.user;
                }
            }

            if (!collabUser) {
                throw new Error('Auth failed.');
            }

            collabAuthed = true;
            collabIsRegistered = isRegisteredUser(collabUser);
            syncRoomEntryLandingState();
            updateCollabFooter();

            const fetchProfileDisplayName = async (userId) => {
                if (!userId) return '';
                const { data, error } = await collabSupabase
                    .from('profiles')
                    .select('display_name')
                    .eq('id', userId)
                    .maybeSingle();
                if (error) return '';
                return String(data?.display_name || '').trim();
            };

            const rawName = String(name || '').trim();
            let displayName = '';
            if (mode === 'login') {
                displayName = await fetchProfileDisplayName(collabUser.id);
                if (!displayName) {
                    const metaName = String(
                        collabUser?.user_metadata?.display_name ||
                        collabUser?.user_metadata?.name ||
                        ''
                    ).trim();
                    displayName = metaName;
                }
                if (!displayName && rawName) {
                    displayName = rawName;
                }
            } else {
                displayName = resolveDisplayName(rawName);
            }
            displayName = normalizeDisplayName(displayName);

            if (mode !== 'login' && displayName) {
                await collabSupabase.from('profiles').upsert({
                    id: collabUser.id,
                    display_name: displayName,
                });
            }
            if (collabNameEl && displayName) {
                collabNameEl.value = displayName;
            }
            if (typeof localStorage !== 'undefined') {
                localStorage.setItem('lpmview.displayName', displayName);
            }
            return displayName;
        }

        function renderProjectOptions(list, selectedId) {
            if (!collabProjectSelectEl) return;
            collabProjectSelectEl.innerHTML = '';
            const placeholder = document.createElement('option');
            placeholder.value = '';
            placeholder.textContent = '— выберите проект —';
            collabProjectSelectEl.appendChild(placeholder);
            list.forEach((project) => {
                const opt = document.createElement('option');
                opt.value = project.id;
                opt.textContent = project.name || project.slug || 'Проект';
                if (project.owner_id) opt.dataset.ownerId = project.owner_id;
                if (canDeleteProjectItem(project)) opt.dataset.deletable = '1';
                collabProjectSelectEl.appendChild(opt);
            });
            if (collabIsRegistered) {
                const createOpt = document.createElement('option');
                createOpt.value = collabCreateOptionValue;
                createOpt.textContent = '+ Создать проект';
                collabProjectSelectEl.appendChild(createOpt);
            }
            collabProjectSelectEl.value = selectedId || '';
            updateAdminControls();
            updateCollabFooter();
        }

        function renderRoomOptions(list, selectedId) {
            if (!collabRoomSelectEl) return;
            collabRoomSelectEl.innerHTML = '';
            const placeholder = document.createElement('option');
            placeholder.value = '';
            placeholder.textContent = '— выберите комнату —';
            collabRoomSelectEl.appendChild(placeholder);
            list.forEach((room) => {
                const opt = document.createElement('option');
                opt.value = room.id;
                opt.textContent = room.slug || 'Комната';
                if (room.owner_id) opt.dataset.ownerId = room.owner_id;
                if (canDeleteRoomItem(room)) opt.dataset.deletable = '1';
                collabRoomSelectEl.appendChild(opt);
            });
            const enabled = !!collabProject;
            if (collabIsRegistered && enabled) {
                const createOpt = document.createElement('option');
                createOpt.value = collabCreateOptionValue;
                createOpt.textContent = '+ Создать комнату';
                collabRoomSelectEl.appendChild(createOpt);
            }
            collabRoomSelectEl.value = selectedId || '';
            collabRoomSelectEl.disabled = !enabled;
            updateAdminControls();
            updateCollabFooter();
        }

        async function loadProjects() {
            if (!collabSupabase) return [];
            const { data, error } = await collabSupabase
                .from('projects')
                .select('id, name, slug, owner_id, created_at')
                .order('created_at', { ascending: true });
            if (error) throw error;
            collabProjects = Array.isArray(data) ? data : [];
            renderProjectOptions(collabProjects, collabProject?.id || '');
            return collabProjects;
        }

        async function loadRooms(projectId) {
            if (!collabSupabase || !projectId) return [];
            const { data, error } = await collabSupabase
                .from('rooms')
                .select('id, slug, owner_id, created_at')
                .eq('project_id', projectId)
                .order('created_at', { ascending: true });
            if (error) throw error;
            collabRooms = Array.isArray(data) ? data : [];
            renderRoomOptions(collabRooms, collabRoom?.id || '');
            return collabRooms;
        }

        async function createProjectFlow(nameOverride) {
            if (!collabSupabase || !collabUser) return;
            if (!requireRegistered()) return;
            let trimmed = String(nameOverride || '').trim();
            if (!trimmed) return;
            const nameSlug = slugifyName(trimmed);
            const baseSlug = nameSlug ? `${nameSlug}-${makeSlug(10)}` : makeSlug(12);
            let nextSlug = baseSlug;
            let created = null;
            for (let i = 0; i < 3; i += 1) {
                const { data, error } = await collabSupabase
                    .from('projects')
                    .insert({
                        name: trimmed,
                        slug: nextSlug,
                        owner_id: collabUser.id,
                    })
                    .select('id, name, slug, owner_id, created_at')
                    .single();
                if (!error) {
                    created = data;
                    break;
                }
                nextSlug = nameSlug ? `${nameSlug}-${makeSlug(12)}` : makeSlug(12);
            }
            if (!created) return;
            if (!created.owner_id) created.owner_id = collabUser.id;
            collabProject = created;
            collabRoom = null;
            clearRoomInviteTokenState();
            await loadProjects();
            await loadRooms(created.id);
            updateAdminControls();
            updateCollabFooter();
        }

        async function createRoomFlow(nameOverride) {
            if (!collabSupabase || !collabUser || !collabProject) return;
            if (!requireRegistered()) return;
            let trimmed = String(nameOverride || '').trim();
            if (!trimmed) return;
            const baseSlug = slugifyName(trimmed) || makeSlug(6);
            let nextSlug = baseSlug;
            let created = null;
            for (let i = 0; i < 3; i += 1) {
                const { data, error } = await collabSupabase
                    .from('rooms')
                    .insert({
                        project_id: collabProject.id,
                        slug: nextSlug,
                        owner_id: collabUser.id,
                    })
                    .select('id, slug, owner_id, created_at')
                    .single();
                if (!error) {
                    created = data;
                    break;
                }
                nextSlug = `${baseSlug}-${makeSlug(4)}`;
            }
            if (!created) return;
            if (!created.owner_id) created.owner_id = collabUser.id;
            collabRoom = created;
            clearRoomInviteTokenState();
            await loadRooms(collabProject.id);
            if (collabAuthed && !collabController) {
                await connectToRoom(String(collabNameEl?.value || '').trim() || 'Guest');
            }
            updateAdminControls();
            updateCollabFooter();
        }

        function toggleCreatePanel(panelEl, inputEl, forceOpen) {
            if (!panelEl) return;
            const nextOpen = typeof forceOpen === 'boolean' ? forceOpen : panelEl.hidden;
            panelEl.hidden = !nextOpen;
            if (nextOpen && inputEl?.focus) {
                inputEl.focus();
                inputEl.select?.();
            }
        }

        async function submitProjectCreate() {
            if (!collabProjectNameInputEl) return;
            const name = String(collabProjectNameInputEl.value || '').trim();
            if (!name) return;
            await createProjectFlow(name);
            collabProjectNameInputEl.value = '';
            toggleCreatePanel(collabProjectCreateEl, collabProjectNameInputEl, false);
        }

        async function submitRoomCreate() {
            if (!collabRoomNameInputEl) return;
            const name = String(collabRoomNameInputEl.value || '').trim();
            if (!name) return;
            await createRoomFlow(name);
            collabRoomNameInputEl.value = '';
            toggleCreatePanel(collabRoomCreateEl, collabRoomNameInputEl, false);
        }

        async function ensureRoomBySlug(projectId, slug) {
            if (!collabSupabase || !projectId || !slug) return null;
            const { data: existing, error: findError } = await collabSupabase
                .from('rooms')
                .select('id, slug, project_id, owner_id, created_at')
                .eq('project_id', projectId)
                .eq('slug', slug)
                .limit(1)
                .maybeSingle();
            if (findError) throw findError;
            return existing || null;
        }

        async function fetchProjectById(projectId) {
            if (!collabSupabase || !projectId) return null;
            const { data, error } = await collabSupabase
                .from('projects')
                .select('id, name, slug, owner_id, created_at')
                .eq('id', projectId)
                .limit(1)
                .maybeSingle();
            if (error) throw error;
            return data || null;
        }

        async function fetchRoomById(roomId) {
            if (!collabSupabase || !roomId) return null;
            const { data, error } = await collabSupabase
                .from('rooms')
                .select('id, slug, project_id, owner_id, created_at')
                .eq('id', roomId)
                .limit(1)
                .maybeSingle();
            if (error) throw error;
            return data || null;
        }

        async function ensureRoomInviteToken(roomId) {
            const safeRoomId = String(roomId || '').trim();
            if (!collabSupabase || !safeRoomId) return '';
            const cachedToken = getRoomInviteTokenState(safeRoomId);
            if (cachedToken) return cachedToken;

            const result = await collabSupabase.rpc('ensure_room_invite', {
                room_id: safeRoomId,
            });
            if (result.error) {
                if (isMissingEnsureRoomInviteRpcSignature(result.error)) return '';
                throw result.error;
            }
            const payload = Array.isArray(result.data) ? result.data[0] : result.data;
            const token = String(payload?.token || payload?.invite_token || '').trim();
            if (token) {
                setRoomInviteTokenState(token, safeRoomId);
            }
            return token;
        }

        async function refreshRoomShareLink(options = {}) {
            const updateHistory = !!options?.updateHistory;
            if (!collabProject || !collabRoom) {
                if (collabRoomLinkEl) collabRoomLinkEl.value = '';
                return '';
            }

            let inviteToken = getRoomInviteTokenState(collabRoom.id);
            if (!inviteToken && collabAuthed && collabSupabase) {
                try {
                    inviteToken = await ensureRoomInviteToken(collabRoom.id);
                } catch (err) {
                    console.error('Room invite fetch failed', err);
                }
            }

            const shareUrl = updateHistory
                ? setRoomSlugInUrl(collabProject.slug, collabRoom.slug, inviteToken)
                : buildRoomLinkUrl(collabProject.slug, collabRoom.slug, inviteToken);
            if (collabRoomLinkEl) collabRoomLinkEl.value = shareUrl;
            return shareUrl;
        }

        async function connectToRoom(name, options = {}) {
            if (!collabSupabase || !collabUser || !collabProject || !collabRoom) return;
            const isAutoReconnect = !!options?.isAutoReconnect;
            const throwOnError = !!options?.throwOnError;
            const sessionGeneration = bumpCollabSessionGeneration();
            const isCurrentSession = () => isActiveCollabSession(sessionGeneration);
            bumpRoomLoadGeneration();
            collabJoinBtn.disabled = true;
            setCollabStatus('connecting');
            try {
                const nextController = await createCollabController({
                    supabaseUrl,
                    supabaseAnonKey,
                    supabase: collabSupabase,
                    user: collabUser,
                    project: collabProject,
                    room: collabRoom,
                    projectSlug: collabProject.slug,
                    roomSlug: collabRoom.slug,
                    displayName: name,
                    onStatus: (text) => {
                        if (!isCurrentSession()) return;
                        const label = String(text || '').trim();
                        if (!label) {
                            setCollabStatus(collabConnectionOnline ? 'on' : 'offline');
                            return;
                        }
                        setCollabStatus(label);
                    },
                    onConnectionState: ({ connected, reason }) => {
                        if (!isCurrentSession()) return;
                        setCollabConnectionState(connected, reason);
                        if (connected) {
                            collabAutoResumeAttempt = 0;
                            clearCollabAutoResumeTimer();
                            if (collabController) setCollabStatus('on');
                            return;
                        }
                        if (!collabController) return;
                        setCollabStatus('offline');
                        scheduleCollabAutoResume(reason || 'channel-disconnected');
                    },
                    onProjectReady: (project) => {
                        if (!isCurrentSession()) return;
                        collabProject = project;
                        updateCollabFooter();
                    },
                    onRoomReady: ({ project, room }) => {
                        if (!isCurrentSession()) return;
                        collabProject = project || collabProject;
                        collabRoom = room || collabRoom;
                        void refreshRoomShareLink({ updateHistory: true });
                        updateCollabFooter();
                    },
                    onParticipants: (list) => {
                        if (!isCurrentSession()) return;
                        renderParticipants(list);
                        updateOwnerLabel();
                    },
                    onMessage: (message, meta) => {
                        if (!isCurrentSession()) return;
                        appendChatMessage(message, { scroll: meta?.source !== 'history' });
                    },
                    onAnnotation: (record) => {
                        if (!isCurrentSession()) return;
                        if (record?.author_id) {
                            recordContributor(record.author_id, record.author_name);
                        }
                        annotations3d?.addRemoteAnnotation?.(record);
                    },
                    onAnnotationDelete: (record) => {
                        if (!isCurrentSession()) return;
                        annotations3d?.removeRemoteAnnotation?.(record?.id);
                    },
                    onCameraState: (state) => {
                        if (!isCurrentSession()) return;
                        cameraSync?.handleRemoteState?.(state);
                    },
                    onCameraOwner: (ownerId) => {
                        if (!isCurrentSession()) return;
                        setCollabOwner(ownerId);
                    },
                    onRoomUpdate: (room) => {
                        if (!isCurrentSession()) return;
                        roomUpdateHandler?.(room);
                    },
                });
                if (!isCurrentSession()) {
                    await nextController.dispose?.();
                    return;
                }
                collabController = nextController;
                updateCollabFooter();

                cameraSync = createCameraSyncController({
                    camera,
                    controls,
                    requestRender,
                    collab: collabController,
                    localUserId: collabController.user.id,
                    isLocalBusy: () => annotations3d?.getDrawEnabled?.() || annotations3d?.isPointerDown?.(),
                });
                if (collabOwnerId) {
                    setCollabOwner(collabOwnerId);
                }
                roomUpdateHandler?.(collabController.room);
                await loadRoomModels();
                if (!isCurrentSession()) return;
                await loadRoomCameras();
                if (!isCurrentSession()) return;
                if (roomCameraCount === 0) {
                    scheduleCameraPersist({
                        presets: cameraPresets.getPresets?.() || [],
                        transitions: cameraPresets.getTransitions?.() || [],
                    });
                }
                subscribeRoomCameraChanges();
                await syncPendingLocalModels({ onlyIfRoomEmpty: true });
                if (!isCurrentSession()) return;

                if (dom.annotateCanvasEl && !collabAnnotatePointerHooksBound) {
                    addAppEventListener(dom.annotateCanvasEl, 'pointerdown', () => cameraSync?.markLocalActivity(true));
                    addAppEventListener(dom.annotateCanvasEl, 'pointerup', () => cameraSync?.markLocalActivity(false));
                    addAppEventListener(dom.annotateCanvasEl, 'pointercancel', () => cameraSync?.markLocalActivity(false));
                    collabAnnotatePointerHooksBound = true;
                }

                collabAutoResumeEnabled = true;
                collabAutoResumeAttempt = 0;
                collabAutoResumeInFlight = false;
                setCollabConnectionState(true, isAutoReconnect ? 'reconnected' : 'connected');
                setCollabStatus('on');
                renderParticipants(collabParticipants);
                updateReserveButton();
                updateOwnerLabel();
                scrollChatToBottom();
                setCollabControlsDisabled(true);
                setCollabCreateEnabled(false);
                setCollabSessionEnabled(true);
                setCollabToolsEnabled(true);
                updateCollabStatusButton();
                setChatPanelAvailability(true);
                startPresenceRefresh();
                if (collabController?.user?.id && collabContributors.has(collabController.user.id)) {
                    recordContributor(collabController.user.id, collabController.getDisplayName?.());
                    annotations3d?.refreshAuthorVisibility?.(collabController.user.id);
                }
                if (voiceAutoJoinRequested && voiceReady && !voiceConnected && !voiceConnecting) {
                    void joinVoiceRoom({ preserveIntent: true });
                }
            } catch (err) {
                if (!isCurrentSession()) return;
                console.error('Collab init failed', err);
                setCollabConnectionState(false, 'connect-error');
                if (!isAutoReconnect) {
                    collabAutoResumeEnabled = false;
                }
                setCollabStatus('error');
                if (throwOnError) throw err;
            } finally {
                if (isCurrentSession()) collabJoinBtn.disabled = false;
            }
        }

        async function connectCollab(mode) {
            if (!collabReady || !collabJoinBtn) return;
            const name = String(collabNameEl?.value || '').trim();
            const email = normalizeEmailInput(collabEmailEl?.value);
            const password = String(collabPasswordEl?.value || '');
            const passwordConfirm = String(collabPasswordConfirmEl?.value || '');
            const authMode = mode || 'login';

            clearAuthErrors();
            if (collabEmailEl && email) {
                collabEmailEl.value = email;
            }
            if (authMode === 'login') {
                let valid = true;
                if (!email || !isValidEmail(email)) {
                    setFieldError(collabEmailErrorEl, 'Введите корректный email.');
                    valid = false;
                }
                if (!password) {
                    setFieldError(collabPasswordErrorEl, 'Введите пароль.');
                    valid = false;
                }
                if (!valid) return;
            }
            if (authMode === 'signup') {
                let valid = true;
                if (!email || !isValidEmail(email)) {
                    setFieldError(collabEmailErrorEl, 'Введите корректный email.');
                    valid = false;
                }
                if (!name) {
                    setFieldError(collabNameErrorEl, 'Введите имя пользователя.');
                    valid = false;
                }
                if (!password) {
                    setFieldError(collabPasswordErrorEl, 'Введите пароль.');
                    valid = false;
                }
                if (!passwordConfirm) {
                    setFieldError(collabPasswordConfirmErrorEl, 'Подтвердите пароль.');
                    valid = false;
                } else if (password && passwordConfirm && password !== passwordConfirm) {
                    setFieldError(collabPasswordConfirmErrorEl, 'Пароли не совпадают.');
                    valid = false;
                }
                if (!valid) return;
            }
            if (authMode === 'guest') {
                if (!canGuestEnter()) {
                    setAuthError('Гостевой вход доступен только по ссылке комнаты.');
                    return;
                }
                if (!name) {
                    setFieldError(collabNameErrorEl, 'Введите имя пользователя.');
                    return;
                }
            }

            if (collabController) {
                const displayName = resolveDisplayName(name);
                await collabController.setDisplayName(displayName);
                if (typeof localStorage !== 'undefined') {
                    localStorage.setItem('lpmview.displayName', displayName);
                }
                if (voiceConnected) {
                    await disconnectVoiceRoom({ preserveIntent: true });
                    await joinVoiceRoom({ preserveIntent: true });
                }
                renderParticipants(collabParticipants);
                updateOwnerLabel();
                const localId = collabController.user?.id || null;
                if (localId && collabContributors.has(localId)) {
                    recordContributor(localId, displayName);
                    annotations3d?.refreshAuthorVisibility?.(localId);
                }
                return;
            }

            collabJoinBtn.disabled = true;
            if (collabSignupBtn) collabSignupBtn.disabled = true;
            if (collabGuestBtn) collabGuestBtn.disabled = true;
            setCollabStatus('auth');
            try {
                const displayName = await ensureCollabAuth({
                    mode: authMode,
                    name,
                    email,
                    password,
                });
                setCollabDrawerOpen(false);
                await refreshSuperuserFlag();
                updateAdminControls();
                setCollabControlsDisabled(false);
                setCollabCreateEnabled(collabIsRegistered);
                updateCollabFooter();

                const inviteToken = getInviteTokenFromUrl();
                const projectSlug = getProjectSlugFromUrl();
                const roomSlug = getRoomSlugFromUrl();
                if (inviteToken) {
                    let joinedRoom = await collabSupabase.rpc('join_room_by_invite', {
                        invite_token: inviteToken,
                    });
                    if (joinedRoom.error && isMissingJoinRoomInviteRpcSignature(joinedRoom.error)) {
                        if (!projectSlug || !roomSlug) {
                            throw new Error('Invite links are not enabled on the server yet.');
                        }
                    } else if (joinedRoom.error) {
                        throw joinedRoom.error;
                    }
                    if (!joinedRoom.error) {
                        const roomFromInvite = Array.isArray(joinedRoom.data) ? joinedRoom.data[0] : joinedRoom.data;
                        if (!roomFromInvite?.id) {
                            setCollabStatus('room missing');
                            setAuthError('Комната по ссылке не найдена.');
                            return;
                        }
                        collabRoom = roomFromInvite;
                        setRoomInviteTokenState(inviteToken, roomFromInvite.id);
                        collabProject = await fetchProjectById(roomFromInvite.project_id);
                        if (!collabProject) {
                            setCollabStatus('project missing');
                            setAuthError('Проект по ссылке не найден.');
                            return;
                        }
                        await loadProjects();
                        await loadRooms(collabProject.id);
                        const roomRecord = await fetchRoomById(roomFromInvite.id);
                        if (roomRecord) {
                            collabRoom = roomRecord;
                        }
                        updateAdminControls();
                        await connectToRoom(displayName || 'Guest');
                        return;
                    }
                }
                if (projectSlug && roomSlug) {
                    clearRoomInviteTokenState();
                    let joinedProject = await collabSupabase.rpc('join_project_by_slug', {
                        project_slug: projectSlug,
                        room_slug: roomSlug,
                    });
                    if (joinedProject.error && isMissingJoinProjectRpcSignature(joinedProject.error)) {
                        joinedProject = await collabSupabase.rpc('join_project_by_slug', {
                            project_slug: projectSlug,
                        });
                    }
                    if (joinedProject.error) throw joinedProject.error;
                    collabProject = joinedProject.data;
                    await loadProjects();
                    await loadRooms(collabProject.id);
                    const room = await ensureRoomBySlug(collabProject.id, roomSlug);
                    if (!room) {
                        setCollabStatus('room missing');
                        setAuthError('Комната по ссылке не найдена.');
                        return;
                    }
                    collabRoom = room;
                    await loadRooms(collabProject.id);
                    updateAdminControls();
                    await connectToRoom(displayName || 'Guest');
                    return;
                }
                if (!inviteToken && projectSlug && !roomSlug) {
                    setAuthError('Для входа по ссылке нужна полная ссылка комнаты.');
                }

                await loadProjects();
                if (collabProjects.length === 1) {
                    collabProject = collabProjects[0];
                    renderProjectOptions(collabProjects, collabProject.id);
                    await loadRooms(collabProject.id);
                } else {
                    collabProject = null;
                    renderRoomOptions([], '');
                }

                setCollabStatus('ready');
            } catch (err) {
                console.error('Collab auth failed', err);
                const message = String(err?.message || '');
                if (authMode === 'signup' && isExistingSignupError(err)) {
                    setCollabStatus('confirm email');
                    await requestSignupConfirmation();
                    setAuthError('Аккаунт уже существует. Отправили письмо для подтверждения.');
                } else if (message.includes('Подтвердите email')) {
                    setCollabStatus('confirm email');
                    setAuthError('Подтвердите email, чтобы войти.');
                } else if (message.toLowerCase().includes('invalid login credentials')) {
                    setCollabStatus('off');
                    setFieldError(collabPasswordErrorEl, 'Неверный email или пароль.');
                } else if (message.toLowerCase().includes('invalid format')) {
                    setCollabStatus('off');
                    setFieldError(collabEmailErrorEl, 'Некорректный email.');
                } else {
                    setCollabStatus('error');
                    setAuthError('Не удалось войти. Проверьте данные.');
                }
            } finally {
                collabJoinBtn.disabled = false;
                if (collabSignupBtn) collabSignupBtn.disabled = false;
                if (collabGuestBtn) collabGuestBtn.disabled = false;
                updateCollabStatusButton();
            }
        }

        if (collabNameEl && typeof localStorage !== 'undefined') {
            const storedName = localStorage.getItem('lpmview.displayName');
            if (storedName) collabNameEl.value = storedName;
        }

        function stopKeydownPropagation(el) {
            addAppEventListener(el, 'keydown', (event) => {
                event.stopPropagation();
            });
        }

        if (typeof document !== 'undefined') {
            addAppEventListener(document, 'keydown', (event) => {
                const target = event?.target;
                const tag = String(target?.tagName || '').toLowerCase();
                if (tag === 'input' || tag === 'textarea' || tag === 'select' || target?.isContentEditable) {
                    event.stopImmediatePropagation();
                }
            }, true);
        }

        stopKeydownPropagation(collabNameEl);
        stopKeydownPropagation(collabEmailEl);
        stopKeydownPropagation(collabPasswordEl);
        stopKeydownPropagation(collabPasswordConfirmEl);
        stopKeydownPropagation(collabProjectNameInputEl);
        stopKeydownPropagation(collabRoomNameInputEl);
        stopKeydownPropagation(collabChatInputEl);

        const authEnterHandler = (event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            submitAuthFromEnter();
        };

        addAppEventListener(collabEmailEl, 'keyup', authEnterHandler);
        addAppEventListener(collabNameEl, 'keyup', authEnterHandler);
        addAppEventListener(collabPasswordEl, 'keyup', authEnterHandler);
        addAppEventListener(collabPasswordConfirmEl, 'keyup', authEnterHandler);

        setAuthMode(getInitialAuthMode());
        if (canGuestEnter() && !collabAuthed) {
            setCollabDrawerOpen(true);
        }

        if (collabShowLoginBtn) {
            addAppEventListener(collabShowLoginBtn, 'click', () => {
                setAuthMode('login');
            });
        }

        if (collabShowRegisterBtn) {
            addAppEventListener(collabShowRegisterBtn, 'click', () => {
                setAuthMode('register');
            });
        }

        if (collabBackBtns && collabBackBtns.length) {
            collabBackBtns.forEach((btn) => {
                addAppEventListener(btn, 'click', () => {
                    setAuthMode(getInitialAuthMode());
                });
            });
        }

        if (collabJoinBtn) {
            collabJoinBtn.disabled = !collabReady;
            addAppEventListener(collabJoinBtn, 'click', () => {
                void connectCollab('login');
            });
        }

        if (collabSignupBtn) {
            collabSignupBtn.disabled = !collabReady;
            addAppEventListener(collabSignupBtn, 'click', () => {
                void connectCollab('signup');
            });
        }

        if (collabGuestBtn) {
            collabGuestBtn.disabled = !collabReady;
            addAppEventListener(collabGuestBtn, 'click', () => {
                void connectCollab('guest');
            });
        }

        if (collabPanelBtn && collabDrawerEl) {
            addAppEventListener(collabPanelBtn, 'click', () => {
                setCollabDrawerOpen(collabDrawerEl.hidden);
            });
        }

        if (collabStatusBtn) {
            collabStatusBtn.disabled = !collabReady;
            addAppEventListener(collabStatusBtn, 'click', async () => {
                if (!collabReady) return;
                if (!collabController) {
                    setCollabDrawerOpen(true);
                    return;
                }
                const exitAsRegistered = !!collabIsRegistered;
                const exitProjectSlug = getProjectSlugFromUrl();
                const exitRoomSlug = getRoomSlugFromUrl();
                const exitInviteToken = getInviteTokenFromUrl();
                const confirmed = await confirmModal.open({
                    title: 'Выйти из совместной работы',
                    message: 'Вы точно хотите выйти из режима совместной работы?',
                    okText: 'Выйти',
                    cancelText: 'Отмена',
                });
                if (!confirmed) return;
                await teardownCollabSession();
                if (exitAsRegistered) {
                    setRoomSlugInUrl('', '');
                    if (typeof window !== 'undefined') {
                        window.location.reload();
                    }
                } else if (exitInviteToken || (exitProjectSlug && exitRoomSlug)) {
                    setRoomSlugInUrl(exitProjectSlug, exitRoomSlug, exitInviteToken);
                    if (typeof window !== 'undefined') {
                        window.location.reload();
                    }
                }
            });
        }

        if (voiceJoinBtn) {
            voiceJoinBtn.disabled = true;
            addAppEventListener(voiceJoinBtn, 'click', () => {
                if (voiceConnecting) return;
                if (voiceConnected) {
                    void disconnectVoiceRoom();
                    return;
                }
                void joinVoiceRoom();
            });
        }

        if (voiceMuteBtn) {
            voiceMuteBtn.disabled = true;
            addAppEventListener(voiceMuteBtn, 'click', () => {
                if (!voiceController || !voiceConnected) return;
                void voiceController.toggleMute().catch((error) => {
                    console.error('Voice mute toggle failed', error);
                });
            });
        }

        if (collabDrawerCloseBtn) {
            addAppEventListener(collabDrawerCloseBtn, 'click', () => {
                setCollabDrawerOpen(false);
            });
        }

        if (collabResetBtn) {
            collabResetBtn.disabled = !collabReady;
            addAppEventListener(collabResetBtn, 'click', () => {
                void requestPasswordReset();
            });
        }

        if (collabResendBtn) {
            collabResendBtn.disabled = !collabReady;
            addAppEventListener(collabResendBtn, 'click', () => {
                void requestSignupConfirmation();
            });
        }

        if (collabProjectSelectEl) {
            addAppEventListener(collabProjectSelectEl, 'change', async () => {
                const id = collabProjectSelectEl.value;
                if (id === collabCreateOptionValue) {
                    toggleCreatePanel(collabProjectCreateEl, collabProjectNameInputEl, true);
                    collabProjectSelectEl.value = collabProject?.id || '';
                    return;
                }
                if (collabController && collabProject?.id && collabProject.id !== id) {
                    await teardownCollabSession();
                }
                collabProject = collabProjects.find((p) => p.id === id) || null;
                collabRoom = null;
                clearRoomInviteTokenState();
                renderRoomOptions([], '');
                if (!collabProject && collabRoomLinkEl) {
                    collabRoomLinkEl.value = '';
                }
                if (collabProject) {
                    await loadRooms(collabProject.id);
                }
                updateAdminControls();
            });
            addAppEventListener(collabProjectSelectEl, 'customselect:delete', (event) => {
                const value = event?.detail?.value;
                if (!value) return;
                void deleteProjectById(String(value));
            });
        }

        if (collabRoomSelectEl) {
            addAppEventListener(collabRoomSelectEl, 'change', async () => {
                const id = collabRoomSelectEl.value;
                if (id === collabCreateOptionValue) {
                    toggleCreatePanel(collabRoomCreateEl, collabRoomNameInputEl, true);
                    collabRoomSelectEl.value = collabRoom?.id || '';
                    return;
                }
                if (collabController && collabRoom?.id && collabRoom.id !== id) {
                    await teardownCollabSession();
                }
                collabRoom = collabRooms.find((r) => r.id === id) || null;
                clearRoomInviteTokenState();
                if (!collabRoom && collabRoomLinkEl) {
                    collabRoomLinkEl.value = '';
                }
                if (collabRoom && collabAuthed && !collabController) {
                    void connectToRoom(String(collabNameEl?.value || '').trim() || 'Guest');
                }
                updateAdminControls();
            });
            addAppEventListener(collabRoomSelectEl, 'customselect:delete', (event) => {
                const value = event?.detail?.value;
                if (!value) return;
                void deleteRoomById(String(value));
            });
        }

        addAppEventListener(collabProjectNameInputEl, 'keyup', (event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            void submitProjectCreate();
        });

        addAppEventListener(collabRoomNameInputEl, 'keyup', (event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            void submitRoomCreate();
        });

        if (collabChatSendBtn && collabChatInputEl) {
            addAppEventListener(collabChatSendBtn, 'click', () => {
                const text = String(collabChatInputEl.value || '').trim();
                if (!text || !collabController) return;
                collabController.sendMessage(text).catch((err) => console.error('Chat send failed', err));
                collabChatInputEl.value = '';
            });
            addAppEventListener(collabChatInputEl, 'keyup', (event) => {
                if (event.key !== 'Enter' || event.shiftKey) return;
                event.preventDefault();
                collabChatSendBtn.click();
            });
        }

        if (!collabChatSendBtn && collabChatInputEl) {
            addAppEventListener(collabChatInputEl, 'keyup', (event) => {
                if (event.key !== 'Enter' || event.shiftKey) return;
                event.preventDefault();
                const text = String(collabChatInputEl.value || '').trim();
                if (!text || !collabController) return;
                collabChatInputEl.value = '';
                void (async () => {
                    try {
                        const message = await collabController.sendMessage(text);
                        if (message) appendChatMessage(message, { scroll: true });
                    } catch (err) {
                        console.error('Chat send failed', err);
                    }
                })();
            });
        }

        if (collabChatToggleBtn) {
            addAppEventListener(collabChatToggleBtn, 'click', () => {
                if (!collabController) return;
                setChatPanelVisible(!chatPanelVisible);
            });
        }

        if (collabCopyBtn && collabRoomLinkEl) {
            addAppEventListener(collabCopyBtn, 'click', () => {
                const value = String(collabRoomLinkEl.value || '').trim();
                if (!value) return;
                if (navigator?.clipboard?.writeText) {
                    void navigator.clipboard.writeText(value);
                }
            });
        }

        if (collabReserveBtn) {
            addAppEventListener(collabReserveBtn, 'click', async () => {
                if (!collabController) return;
                collabReserveBtn.disabled = true;
                try {
                    if (cameraSync?.isOwner?.()) {
                        await collabController.releaseCamera();
                        setCollabOwner(null);
                    } else {
                        await collabController.claimCamera();
                        setCollabOwner(collabController.user?.id || null);
                    }
                } catch (err) {
                    console.error('Camera reserve failed', err);
                } finally {
                    collabReserveBtn.disabled = false;
                }
            });
        }

        if (collabStatusEl && !collabReady) {
            collabStatusEl.textContent = 'config';
        }
        setCollabControlsDisabled(true);
        setCollabCreateEnabled(false);
        setCollabSessionEnabled(false);
        setCollabToolsEnabled(false);
        if (collabReady) {
            setCollabStatus(collabAuthed ? 'ready' : 'off');
        }
        updateCollabStatusButton();
        setChatPanelAvailability(false);
        if (typeof window !== 'undefined') {
            addAppEventListener(window, 'offline', handleBrowserOffline, { passive: true });
            addAppEventListener(window, 'online', handleBrowserOnline, { passive: true });
        }
        updateAdminControls();
        void maybeHandlePasswordRecovery();
        void clearPersistedEmailSession();

        addAppEventListener(exportBtn, 'click', () => {
            void (async () => {
                const selection = await exportModal.open({
                    title: 'Экспорт сцены',
                    format: 'glb',
		                    coords: 'rebased',
		                });
		                if (!selection) return;

		                try {
		                    setStatusMessage('Экспорт…');
		                    await exportWorldAsGLTF({
		                        world,
		                        renderer,
		                        format: selection.format,
		                        coords: selection.coords,
		                        document,
		                    });
		                    setStatusMessage('');
		                } catch (err) {
		                    console.error(err);
		                    setStatusMessage('Экспорт: ошибка — ' + (err?.message || err));
                }
            })();
        });

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
	        assetLoaders = createAssetLoaders({ THREE });
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
		        } = assetLoaders;
                const environmentWiring = createEnvironmentWiring({
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
		        } = environmentWiring;

        // =====================================================================
        // Asset Loading · Shared State
        // =====================================================================
        /**
         * Все загруженные модели (FBX) в рамках текущей сессии.
         * Храним объект сцены, имя файла и дополнительную мета-информацию.
         * Формат: { obj: THREE.Object3D, name: string, group?, zipKind?, geojson?, scope? }
         */
        const loadedModels = app.loadedModels = [];
        const sceneIndex = createLoadedModelSceneIndex({ loadedModels });
        app.sceneIndex = sceneIndex;
        environmentWiring.setMaterialSources?.({ loadedModels, sceneIndex });

        /**
         * Список всех изображений, извлечённых из FBX или ZIP (включая embedded).
         * Используется для автопривязки материалов и галереи текстур.
         * Элементы могут быть привязаны к scope комнаты, чтобы чистить их при room switch.
         */
        const allEmbedded  = app.allEmbedded  = [];

        function cloneImportScope(scope) {
            if (!scope || typeof scope !== 'object') return null;
            return { ...scope };
        }

        function scopeMatchesRoom(scope, roomId) {
            if (!scope || typeof scope !== 'object') return false;
            if (scope.kind !== 'room') return false;
            if (!roomId) return true;
            return String(scope.roomId || '') === String(roomId);
        }

        function scopeMatchesRoomModel(scope, roomId, modelId) {
            if (!scopeMatchesRoom(scope, roomId)) return false;
            if (!modelId) return true;
            return String(scope.modelId || '') === String(modelId);
        }

        function assignImportScopeToRange({ modelStart = 0, embeddedStart = 0, scope = null } = {}) {
            const nextScope = cloneImportScope(scope);
            if (!nextScope) return;

            for (let i = Math.max(0, modelStart); i < loadedModels.length; i += 1) {
                const record = loadedModels[i];
                if (!record || record.scope) continue;
                record.scope = cloneImportScope(nextScope);
                if (record.obj?.userData) {
                    record.obj.userData.importScope = cloneImportScope(nextScope);
                }
            }

            for (let i = Math.max(0, embeddedStart); i < allEmbedded.length; i += 1) {
                const entry = allEmbedded[i];
                if (!entry || entry.scope) continue;
                entry.scope = cloneImportScope(nextScope);
            }
        }

        function cleanupImportedRange({ modelStart = 0, embeddedStart = 0 } = {}) {
            const safeModelStart = Math.max(0, Math.min(Number(modelStart) || 0, loadedModels.length));
            const safeEmbeddedStart = Math.max(0, Math.min(Number(embeddedStart) || 0, allEmbedded.length));
            const removedModels = loadedModels.splice(safeModelStart);
            const removedEntries = allEmbedded.splice(safeEmbeddedStart);

            removedModels.forEach((record) => {
                const obj = record?.obj || null;
                try { obj?.parent?.remove?.(obj); } catch (_) {}
                disposeImportedObjectTree(obj);
            });

            removedEntries.forEach((entry) => revokeEmbeddedEntryUrl(entry));

            if (removedModels.length) {
                lastFinalizedModelIndex = Math.min(lastFinalizedModelIndex, loadedModels.length);
                materialsPanel?.markNeedsFullRefresh?.();
            }

            if (removedEntries.length) {
                galleryNeedsRefresh = false;
                renderGallery(allEmbedded);
            }

            if (removedModels.length || removedEntries.length) {
                markSceneStatsDirty();
                schedulePanelRefresh();
                setEmptyHintVisible(loadedModels.length === 0 && !isRoomEntryLandingActive());
                requestRender();
            }

            return removedModels.length > 0 || removedEntries.length > 0;
        }

        async function runImportWithScope(scope, loadFn) {
            const modelStart = loadedModels.length;
            const embeddedStart = allEmbedded.length;
            try {
                assignImportScopeToRange({ modelStart, embeddedStart, scope });
                return await loadFn();
            } catch (err) {
                assignImportScopeToRange({ modelStart, embeddedStart, scope });
                cleanupImportedRange({ modelStart, embeddedStart });
                throw err;
            } finally {
                assignImportScopeToRange({ modelStart, embeddedStart, scope });
            }
        }

        function revokeEmbeddedEntryUrl(entry) {
            const url = String(entry?.url || '').trim();
            if (!url || !url.startsWith('blob:')) return;
            try {
                URL.revokeObjectURL(url);
            } catch (_) {}
        }

        function disposeImportedObjectTree(root) {
            if (!root) return;
            const disposedGeometries = new Set();
            const disposedMaterials = new Set();
            const disposedTextures = new Set();
            const disposedSkeletons = new Set();
            const sharedTextures = new Set();
            if (scene?.environment?.isTexture) sharedTextures.add(scene.environment);
            if (scene?.background?.isTexture) sharedTextures.add(scene.background);

            const asMaterialArray = (value) => {
                if (!value) return [];
                return Array.isArray(value) ? value.filter(Boolean) : [value];
            };

            const disposeMaterial = (material, { disposeTextures = true } = {}) => {
                if (!material || disposedMaterials.has(material)) return;
                disposedMaterials.add(material);
                if (disposeTextures) {
                    Object.values(material).forEach((value) => {
                        if (!value?.isTexture || sharedTextures.has(value) || disposedTextures.has(value)) return;
                        disposedTextures.add(value);
                        value.dispose?.();
                    });
                }
                material.dispose?.();
            };

            root.traverse?.((child) => {
                const geometry = child?.geometry || null;
                if (geometry?.dispose && !disposedGeometries.has(geometry) && child?.isSprite !== true) {
                    disposedGeometries.add(geometry);
                    geometry.dispose();
                }
                const skeleton = child?.skeleton || null;
                if (skeleton?.dispose && !disposedSkeletons.has(skeleton)) {
                    disposedSkeletons.add(skeleton);
                    skeleton.dispose();
                }

                const originalMaterials = [
                    ...asMaterialArray(child?.userData?._origMaterial),
                    ...asMaterialArray(child?.userData?._removedMaterials),
                ];
                const originalSet = new Set(originalMaterials);
                originalMaterials.forEach((material) => disposeMaterial(material, { disposeTextures: true }));

                const generatedMaterialKeys = [
                    '_bfFront',
                    '_bfBack',
                    '_wireBase',
                    '_beautyBase',
                    '_removedCustomDepthMaterial',
                    '_removedCustomDistanceMaterial',
                ];
                generatedMaterialKeys.forEach((key) => {
                    asMaterialArray(child?.userData?.[key]).forEach((material) => {
                        disposeMaterial(material, { disposeTextures: false });
                    });
                });

                asMaterialArray(child?.customDepthMaterial).forEach((material) => {
                    disposeMaterial(material, { disposeTextures: false });
                });
                asMaterialArray(child?.customDistanceMaterial).forEach((material) => {
                    disposeMaterial(material, { disposeTextures: false });
                });

                asMaterialArray(child?.material).forEach((material) => {
                    const isOriginal = originalSet.has(material) || originalMaterials.length === 0;
                    disposeMaterial(material, { disposeTextures: isOriginal });
                });

                const generatedChildKeys = ['_bfChild', '_wireOverlay', '_beautyWire'];
                generatedChildKeys.forEach((key) => {
                    const generatedChild = child?.userData?.[key] || null;
                    if (!generatedChild) return;
                    asMaterialArray(generatedChild.material).forEach((material) => {
                        disposeMaterial(material, { disposeTextures: false });
                    });
                    if (generatedChild.geometry?.dispose && !disposedGeometries.has(generatedChild.geometry)) {
                        disposedGeometries.add(generatedChild.geometry);
                        generatedChild.geometry.dispose();
                    }
                });

            });
            environmentWiring.invalidateMaterialRegistry?.();
        }

        function cleanupRoomModelScopedAssets({ roomId = '', modelId = '' } = {}) {
            const targetRoomId = roomId ? String(roomId) : '';
            const targetModelId = modelId ? String(modelId) : '';
            if (targetModelId) {
                roomModelLoadQueue?.delete?.({ roomId: targetRoomId, modelId: targetModelId });
                const isActiveImportTarget = remoteModelLoadModelId === targetModelId
                    && (!targetRoomId || remoteModelLoadRoomId === targetRoomId);
                if (isActiveImportTarget) abortActiveRoomImports();
            }
            const roomModelRecords = loadedModels.filter((record) => (
                scopeMatchesRoomModel(record?.scope, targetRoomId, targetModelId)
            ));
            const roomTextureEntries = allEmbedded.filter((entry) => (
                scopeMatchesRoomModel(entry?.scope, targetRoomId, targetModelId)
            ));
            if (!roomModelRecords.length && !roomTextureEntries.length) {
                if (targetModelId) {
                    loadedRoomModelIds.delete(targetModelId);
                    if (activeRoomModelId === targetModelId) activeRoomModelId = '';
                }
                return false;
            }

            roomModelRecords.forEach((record) => {
                const obj = record?.obj || null;
                if (obj?.parent?.remove) {
                    try {
                        obj.parent.remove(obj);
                    } catch (_) {}
                }
                disposeImportedObjectTree(obj);
            });

            if (roomModelRecords.length) {
                const keptModels = loadedModels.filter((record) => !scopeMatchesRoomModel(record?.scope, targetRoomId, targetModelId));
                loadedModels.splice(0, loadedModels.length, ...keptModels);
                lastFinalizedModelIndex = Math.min(lastFinalizedModelIndex, loadedModels.length);
                materialsPanel?.markNeedsFullRefresh?.();
            }

            if (roomTextureEntries.length) {
                roomTextureEntries.forEach((entry) => revokeEmbeddedEntryUrl(entry));
                const keptEntries = allEmbedded.filter((entry) => !scopeMatchesRoomModel(entry?.scope, targetRoomId, targetModelId));
                allEmbedded.splice(0, allEmbedded.length, ...keptEntries);
                galleryNeedsRefresh = false;
                renderGallery(allEmbedded);
            }

            if (targetModelId) {
                loadedRoomModelIds.delete(targetModelId);
                if (activeRoomModelId === targetModelId) activeRoomModelId = '';
            }

            markSceneStatsDirty();
            schedulePanelRefresh();
            setEmptyHintVisible(loadedModels.length === 0 && !isRoomEntryLandingActive());
            requestRender();
            return true;
        }

        function cleanupRoomScopedAssets(roomId) {
            return cleanupRoomModelScopedAssets({ roomId });
        }

        /**
         * Стек для операций «отмены» при ручной привязке текстур.
         * Пока используется только для логирования, но оставляем для будущего undo.
         */
	        const undoStack    = app.undoStack    = [];

        let vrController = {
            update: () => false,
            enterVR: async () => false,
            exitVR: async () => false,
            isQuestDevice: () => false,
            isSupported: () => false,
            isPresenting: () => false,
            dispose: () => {},
        };



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
            const prevWorldPos = world?.position ? world.position.clone() : null;
            worldOffsetController.setWorldOffset(offset);
            if (prevWorldPos && annotations3d?.applyWorldOffsetDelta) {
                const nextWorldPos = world?.position ? world.position.clone() : null;
                if (nextWorldPos) {
                    const delta = nextWorldPos.sub(prevWorldPos);
                    annotations3d.applyWorldOffsetDelta(delta);
                }
            }
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
                            sceneIndex,
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


			        const sunInputsController = createSunInputsController({
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

				        const environmentControlsController = createEnvironmentControlsController({
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

			        const appbarControlsController = createAppbarControlsController({
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

		        const cameraPickController = createCameraPickController({
		            THREE,
		            camera,
		            controls,
		            world,
		            renderer,
		            pickBtn: focusPickBtn,
		            requestRender,
		            isBlocked: () => annotations3d?.getDrawEnabled?.() || annotations3d?.isPointerDown?.(),
		        });
		        app.cameraPick = cameraPickController;

			        // =====================
			        // Utilities
		        // =====================

	        const importedLightsController = createImportedLightsController({
	            THREE,
	            loadedModels,
	            requestRender,
	            logBind,
	            useWebGPU: USE_WEBGPU,
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
			        inspectorPanels = createInspectorPanels({
			            THREE,
			            dom,
			            world,
			            loadedModels,
                        sceneIndex,
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
                environmentWiring.invalidateMaterialRegistry?.();
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
        const hemiLightControlsController = createHemiLightControlsController({
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
        const importHandlers = createImportHandlers({
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
        const rawHandleFBXFile = importHandlers.handleFBXFile;
        const rawHandleZIPFile = importHandlers.handleZIPFile;
        const pendingLocalModelFiles = [];
        const pendingLocalModelKeys = new Set();
        const nonRetryableModelSyncKeys = new Set();
        let isRemoteModelLoad = false;
        let remoteModelLoadGeneration = 0;
        let isSyncingLocalModels = false;
        let activeRoomModelId = '';
        const RESUMABLE_UPLOAD_THRESHOLD_BYTES = 16 * 1024 * 1024;
        const RESUMABLE_UPLOAD_CHUNK_BYTES = 6 * 1024 * 1024;
        let tusClientPromise = null;

        function getModelFileKey(file) {
            if (!file) return '';
            return `${file.name || ''}|${file.size || 0}|${file.lastModified || 0}`;
        }

        function queueLocalModelFile(file) {
            if (!file || isRemoteModelLoad) return;
            const key = getModelFileKey(file);
            if (!key || pendingLocalModelKeys.has(key)) return;
            pendingLocalModelKeys.add(key);
            pendingLocalModelFiles.push(file);
        }

        async function handleFBXFile(file, callOptions = null) {
            await runImportWithScope({ kind: 'local' }, () => (
                rawHandleFBXFile(file, null, null, null, callOptions)
            ));
            queueLocalModelFile(file);
        }

        async function handleZIPFile(file, callOptions = null) {
            await runImportWithScope({ kind: 'local' }, () => rawHandleZIPFile(file, callOptions));
            queueLocalModelFile(file);
        }

        function getModelKindFromName(name) {
            if (!name) return 'zip';
            if (/\.fbx$/i.test(name)) return 'fbx';
            if (/\.zip$/i.test(name)) return 'zip';
            return 'zip';
        }

        function isModelSyncFileTooLargeError(error) {
            const status = Number(error?.status || error?.statusCode || 0);
            if (status === 413) return true;
            const message = String(error?.message || error || '').toLowerCase();
            if (!message) return false;
            return message.includes('413')
                || message.includes('maximum size exceeded')
                || message.includes('content too large');
        }

        function buildProjectModelRecordUrl(path) {
            const cleanPath = String(path || '').trim().replace(/^\/+/, '');
            return cleanPath ? `storage://models/${cleanPath}` : '';
        }

        function decodeProjectModelStoragePath(value) {
            const raw = String(value || '').trim().replace(/^\/+/, '');
            if (!raw) return '';
            try {
                return decodeURIComponent(raw);
            } catch (_) {
                return raw;
            }
        }

        function getProjectModelStoragePath(model) {
            const metaPath = decodeProjectModelStoragePath(
                model?.meta?.storagePath || model?.meta?.storage_path || ''
            );
            if (metaPath) return metaPath;

            const rawUrl = String(model?.url || '').trim();
            if (!rawUrl) return '';

            if (rawUrl.startsWith('storage://')) {
                const bucketPrefix = 'storage://models/';
                if (!rawUrl.startsWith(bucketPrefix)) return '';
                return decodeProjectModelStoragePath(rawUrl.slice(bucketPrefix.length));
            }

            const storageMarker = '/storage/v1/object/';
            const markerIndex = rawUrl.indexOf(storageMarker);
            if (markerIndex === -1) return '';

            let rawPath = rawUrl.slice(markerIndex + storageMarker.length).split('?')[0] || '';
            rawPath = rawPath.replace(/^(public|sign|authenticated)\//, '');
            if (!rawPath.startsWith('models/')) return '';
            return decodeProjectModelStoragePath(rawPath.slice('models/'.length));
        }

        async function ensureTusClient() {
            const existing = globalThis?.tus;
            if (existing?.Upload) return existing;
            if (tusClientPromise) return tusClientPromise;
            tusClientPromise = new Promise((resolve, reject) => {
                if (typeof document === 'undefined') {
                    reject(new Error('TUS loader is unavailable outside browser.'));
                    return;
                }
                const script = document.createElement('script');
                script.src = 'https://cdn.jsdelivr.net/npm/tus-js-client@3.1.3/dist/tus.min.js';
                script.async = true;
                script.onload = () => {
                    const tus = globalThis?.tus;
                    if (tus?.Upload) {
                        resolve(tus);
                    } else {
                        reject(new Error('tus-js-client loaded without Upload API.'));
                    }
                };
                script.onerror = () => reject(new Error('Failed to load tus-js-client from CDN.'));
                document.head.appendChild(script);
            });
            return tusClientPromise;
        }

        async function uploadModelToProjectResumable({ supabase, file, path, onProgress = null, signal = null }) {
            if (signal?.aborted) throw makeRoomLoadAbortError();
            const sessionResult = await supabase.auth.getSession();
            if (signal?.aborted) throw makeRoomLoadAbortError();
            const accessToken = sessionResult?.data?.session?.access_token || '';
            if (!accessToken) {
                throw new Error('No active Supabase session for resumable upload.');
            }
            const tus = await ensureTusClient();
            if (signal?.aborted) throw makeRoomLoadAbortError();
            let lastProgressPercent = -1;
            await runAbortableTusUpload({
                tus,
                file,
                endpoint: `${supabaseUrl}/storage/v1/upload/resumable`,
                retryDelays: [0, 3000, 5000, 10000, 20000],
                chunkSize: RESUMABLE_UPLOAD_CHUNK_BYTES,
                uploadDataDuringCreation: true,
                removeFingerprintOnSuccess: true,
                signal,
                abortMessage: 'Model sync superseded',
                headers: {
                    authorization: `Bearer ${accessToken}`,
                    apikey: supabaseAnonKey,
                    'x-upsert': 'true',
                },
                metadata: {
                    bucketName: 'models',
                    objectName: path,
                    contentType: file.type || 'application/octet-stream',
                    cacheControl: '3600',
                },
                onProgress: (bytesUploaded, bytesTotal) => {
                    if (typeof onProgress !== 'function') return;
                    const total = Number(bytesTotal || file.size || 0);
                    if (!Number.isFinite(total) || total <= 0) return;
                    const uploaded = Math.max(0, Number(bytesUploaded || 0));
                    const percent = Math.max(0, Math.min(99, Math.floor((uploaded / total) * 100)));
                    if (percent === lastProgressPercent) return;
                    lastProgressPercent = percent;
                    onProgress(percent);
                },
            });
        }

        async function uploadModelToProject(file, options = {}) {
            const supabase = options.supabase || collabController?.supabase || null;
            if (!supabase || !file) return null;
            const bucket = supabase.storage.from('models');
            const safeName = String(file.name || 'model.zip').replace(/\s+/g, '_');
            const projectId = options.projectId || collabController?.project?.id || 'project';
            const path = `projects/${projectId}/${Date.now()}-${safeName}`;
            const useResumable = Number(file.size || 0) > RESUMABLE_UPLOAD_THRESHOLD_BYTES;
            if (useResumable) {
                await uploadModelToProjectResumable({
                    supabase,
                    file,
                    path,
                    onProgress: options.onProgress,
                    signal: options.signal || null,
                });
            } else {
                if (options.signal?.aborted) throw makeRoomLoadAbortError();
                const { error: uploadError } = await bucket.upload(path, file, {
                    upsert: true,
                    contentType: file.type || 'application/octet-stream',
                });
                if (options.signal?.aborted) throw makeRoomLoadAbortError();
                if (uploadError) throw uploadError;
            }
            return {
                path,
                url: buildProjectModelRecordUrl(path),
            };
        }

        async function cleanupUploadedModelObject(path, supabaseClient = null) {
            const supabase = supabaseClient || collabController?.supabase || collabSupabase || null;
            if (!supabase || !path) return;
            try {
                await removeModelStorageObjects([path], supabase);
            } catch (err) {
                console.error('Model storage cleanup failed', err);
            }
        }

        async function removeModelStorageObjects(paths, supabaseClient = collabSupabase) {
            if (!supabaseClient) return;
            const uniquePaths = Array.from(new Set(
                (Array.isArray(paths) ? paths : [])
                    .map((path) => String(path || '').trim().replace(/^\/+/, ''))
                    .filter(Boolean)
            ));
            if (!uniquePaths.length) return;
            const bucket = supabaseClient.storage.from('models');
            const chunkSize = 100;
            for (let index = 0; index < uniquePaths.length; index += chunkSize) {
                const chunk = uniquePaths.slice(index, index + chunkSize);
                const { error } = await bucket.remove(chunk);
                if (error) throw error;
            }
        }

        async function cleanupProjectStorageObjects(projectId) {
            if (!collabSupabase || !projectId) return;
            const { data: models, error } = await collabSupabase
                .from('project_models')
                .select('url, meta')
                .eq('project_id', projectId);
            if (error) throw error;
            const paths = (Array.isArray(models) ? models : [])
                .map((model) => getProjectModelStoragePath(model))
                .filter(Boolean);
            if (!paths.length) return;
            await removeModelStorageObjects(paths, collabSupabase);
        }

        async function cleanupSyncedModelArtifacts({ modelRowId = '', uploadedPath = '', supabaseClient = null, roomId = '' } = {}) {
            const supabase = supabaseClient || collabController?.supabase || collabSupabase || null;
            let canRemoveStorage = !modelRowId;
            if (supabase && modelRowId) {
                if (roomId) {
                    try {
                        const { error: roomError } = await supabase
                            .from('rooms')
                            .update({ active_model_id: null })
                            .eq('id', roomId)
                            .eq('active_model_id', modelRowId);
                        if (roomError) console.error('Room active model cleanup failed', roomError);
                    } catch (err) {
                        console.error('Room active model cleanup failed', err);
                    }
                }
                try {
                    let roomModelsDelete = supabase
                        .from('room_models')
                        .delete()
                        .eq('model_id', modelRowId);
                    if (roomId) roomModelsDelete = roomModelsDelete.eq('room_id', roomId);
                    const { error: roomModelError } = await roomModelsDelete;
                    if (roomModelError) console.error('Room model link cleanup failed', roomModelError);
                } catch (err) {
                    console.error('Room model link cleanup failed', err);
                }
                try {
                    const { error } = await supabase
                        .from('project_models')
                        .delete()
                        .eq('id', modelRowId);
                    if (error) {
                        console.error('Project model cleanup failed', error);
                    } else {
                        canRemoveStorage = true;
                    }
                } catch (err) {
                    console.error('Project model cleanup failed', err);
                }
            }
            if (uploadedPath && canRemoveStorage) {
                await cleanupUploadedModelObject(uploadedPath, supabase);
            }
        }

        async function syncModelToRoom(file, options = {}) {
            const controller = options.controller || collabController;
            const supabase = controller?.supabase || null;
            const roomId = String(options.roomId || controller?.room?.id || '');
            const projectId = String(options.projectId || controller?.project?.id || '');
            const generation = Number.isFinite(options.generation) ? options.generation : roomLoadGeneration;
            const isCurrent = () => (
                !!controller
                && controller === collabController
                && !!roomId
                && !!projectId
                && isActiveRoomLoad(generation, roomId)
            );
            if (!controller || !supabase || !file || isRemoteModelLoad || !isCurrent()) return false;
            const syncAbortController = typeof AbortController !== 'undefined' ? new AbortController() : null;
            const syncSignal = syncAbortController?.signal || null;
            let shouldKeepStatusMessage = false;
            let uploadedPath = '';
            let createdModelRowId = '';
            const throwIfStale = () => {
                if (syncSignal?.aborted || !isCurrent()) throw makeRoomLoadAbortError('Model sync superseded');
            };
            const setSyncStatus = (message) => {
                if (!syncSignal?.aborted && isCurrent()) setStatusMessage(`Синхронизация: ${message}`);
            };
            if (syncAbortController) activeRoomModelSyncControllers.add(syncAbortController);
            try {
                throwIfStale();
                setSyncStatus('загрузка модели…');
                const uploadResult = await uploadModelToProject(file, {
                    supabase,
                    projectId,
                    onProgress: (percent) => setSyncStatus(`загрузка ${percent}%…`),
                    signal: syncSignal,
                });
                const url = uploadResult?.url || '';
                uploadedPath = uploadResult?.path || '';
                throwIfStale();
                if (!url) {
                    throw new Error('Uploaded model URL is empty.');
                }
                const meta = {
                    size: file.size || 0,
                    type: file.type || '',
                    kind: getModelKindFromName(file.name),
                    lastModified: file.lastModified || null,
                    storagePath: uploadedPath,
                };
                setSyncStatus('запись модели в проект…');
                const { data: modelRow, error: modelError } = await supabase
                    .from('project_models')
                    .insert({
                        project_id: projectId,
                        name: file.name || 'model.zip',
                        url,
                        meta,
                    })
                    .select('*')
                    .single();
                if (modelError) throw modelError;
                createdModelRowId = modelRow?.id || '';
                if (!createdModelRowId) throw new Error('Project model insert returned empty id.');
                loadedRoomModelIds.add(createdModelRowId);
                throwIfStale();

                setSyncStatus('привязка модели к комнате…');
                const { data: roomModelRow, error: roomModelError } = await supabase
                    .from('room_models')
                    .insert({
                        room_id: roomId,
                        project_id: projectId,
                        model_id: modelRow.id,
                        sort_order: roomModelCount,
                    })
                    .select('model_id')
                    .single();
                if (roomModelError) throw roomModelError;
                throwIfStale();
                if (!roomModelRow?.model_id) {
                    throw new Error('Room model link was not persisted.');
                }

                setSyncStatus('обновление активной модели…');
                activeRoomModelId = modelRow.id;
                const { data: updatedRoomRow, error: activeModelError } = await supabase
                    .from('rooms')
                    .update({ active_model_id: modelRow.id })
                    .eq('id', roomId)
                    .select('id, active_model_id')
                    .single();
                if (activeModelError) throw activeModelError;
                throwIfStale();
                if (updatedRoomRow?.active_model_id !== modelRow.id) {
                    throw new Error('Room active model was not updated.');
                }

                roomModelCount += 1;
                setStatusMessage('готово: модель синхронизирована');
                shouldKeepStatusMessage = true;
                return true;
            } catch (err) {
                if (isAbortError(err) || !isCurrent()) {
                    if (createdModelRowId) {
                        loadedRoomModelIds.delete(createdModelRowId);
                        if (activeRoomModelId === createdModelRowId) activeRoomModelId = '';
                    }
                    await cleanupSyncedModelArtifacts({
                        modelRowId: createdModelRowId,
                        uploadedPath,
                        supabaseClient: supabase,
                        roomId,
                    });
                    return false;
                }
                if (isModelSyncFileTooLargeError(err)) {
                    const key = getModelFileKey(file);
                    if (key) nonRetryableModelSyncKeys.add(key);
                    const sizeMb = Math.max(1, Math.round((Number(file.size || 0) / (1024 * 1024)) * 10) / 10);
                    setStatusMessage(
                        `Синхронизация отклонена: файл ${sizeMb} МБ превышает лимит Storage. `
                        + 'В Supabase: Storage -> Settings -> Global file size limit.'
                    );
                    shouldKeepStatusMessage = true;
                }
                console.error('Model sync failed', err);
                if (createdModelRowId) {
                    loadedRoomModelIds.delete(createdModelRowId);
                    if (activeRoomModelId === createdModelRowId) activeRoomModelId = '';
                }
                await cleanupSyncedModelArtifacts({
                    modelRowId: createdModelRowId,
                    uploadedPath,
                    supabaseClient: supabase,
                    roomId,
                });
                return false;
            } finally {
                if (syncAbortController) activeRoomModelSyncControllers.delete(syncAbortController);
                if (!shouldKeepStatusMessage && isCurrent()) setStatusMessage('');
            }
        }

        async function syncPendingLocalModels({ onlyIfRoomEmpty = false } = {}) {
            if (isSyncingLocalModels) return false;
            const controller = collabController;
            const roomId = String(controller?.room?.id || '');
            const projectId = String(controller?.project?.id || '');
            const generation = roomLoadGeneration;
            const isCurrent = () => (
                !!controller
                && controller === collabController
                && !!roomId
                && !!projectId
                && isActiveRoomLoad(generation, roomId)
            );
            if (!controller || isRemoteModelLoad || !isCurrent()) return false;
            if (onlyIfRoomEmpty && collabRoomModelsPresent()) return false;
            if (!pendingLocalModelFiles.length) return false;
            let syncedAny = false;
            isSyncingLocalModels = true;
            try {
                while (pendingLocalModelFiles.length && isCurrent() && !isRemoteModelLoad) {
                    if (onlyIfRoomEmpty && collabRoomModelsPresent()) break;
                    const files = pendingLocalModelFiles.slice();
                    pendingLocalModelFiles.length = 0;
                    pendingLocalModelKeys.clear();
                    const failed = [];
                    for (const file of files) {
                        if (!isCurrent() || isRemoteModelLoad) {
                            failed.length = 0;
                            break;
                        }
                        const synced = await syncModelToRoom(file, {
                            controller,
                            roomId,
                            projectId,
                            generation,
                        });
                        if (synced) {
                            syncedAny = true;
                        } else if (isCurrent()) {
                            const key = getModelFileKey(file);
                            if (!key || !nonRetryableModelSyncKeys.has(key)) {
                                failed.push(file);
                            }
                        }
                    }
                    if (failed.length) {
                        for (const file of failed) {
                            const key = getModelFileKey(file);
                            if (!key || pendingLocalModelKeys.has(key)) continue;
                            pendingLocalModelKeys.add(key);
                            pendingLocalModelFiles.push(file);
                        }
                        break;
                    }
                }
            } finally {
                isSyncingLocalModels = false;
            }
            return syncedAny;
        }

        async function loadProjectModel(model, options = {}) {
            if (!model) return;
            const expectedRoomId = String(options.roomId || collabController?.room?.id || '');
            const expectedGeneration = Number.isFinite(options.generation)
                ? options.generation
                : roomLoadGeneration;
            return getRoomModelLoadQueue().load(model, {
                ...options,
                roomId: expectedRoomId,
                generation: expectedGeneration,
                modelId: model.id,
            });
        }

        async function loadProjectModelNow(model, options = {}) {
            if (!model) return false;
            const expectedRoomId = String(options.roomId || collabController?.room?.id || '');
            const expectedGeneration = Number.isFinite(options.generation)
                ? options.generation
                : roomLoadGeneration;
            const modelId = String(model.id || '').trim();
            const isStaleLoad = () => !isActiveRoomLoad(expectedGeneration, expectedRoomId);
            if (isStaleLoad()) return false;
            if (loadedRoomModelIds.has(modelId)) return true;

            const storagePath = getProjectModelStoragePath(model);
            const modelRef = storagePath || model.url || '';
            if (!modelRef) return false;
            const name = model.name || basename(modelRef) || 'model.zip';
            const kind = model.meta?.kind || getModelKindFromName(name);
            const importAbortController = typeof AbortController !== 'undefined' ? new AbortController() : null;
            const importSignal = importAbortController?.signal || null;
            const abortImport = () => {
                if (!importAbortController || importSignal?.aborted) return;
                try {
                    importAbortController.abort(makeRoomLoadAbortError());
                } catch (_) {}
            };
            if (importAbortController) activeRoomImportControllers.add(importAbortController);
            try {
                isRemoteModelLoad = true;
                remoteModelLoadGeneration = expectedGeneration;
                remoteModelLoadRoomId = expectedRoomId;
                remoteModelLoadModelId = modelId;
                setStatusMessage('Загрузка модели из комнаты…');
                let blob = null;
                if (storagePath && collabController?.supabase) {
                    const { data, error } = await collabController.supabase.storage
                        .from('models')
                        .download(storagePath);
                    if (error) throw error;
                    blob = data || null;
                } else if (model.url && !String(model.url).startsWith('storage://')) {
                    const response = await fetch(model.url, { cache: 'no-cache', signal: importSignal || undefined });
                    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
                    blob = await response.blob();
                }
                if (isStaleLoad() || importSignal?.aborted) {
                    abortImport();
                    return false;
                }
                if (!blob) {
                    throw new Error('Model download returned empty payload.');
                }
                const file = new File([blob], name, { type: blob.type || 'application/octet-stream' });
                pendingLocalModelFiles.length = 0;
                pendingLocalModelKeys.clear();
                const roomImportScope = {
                    kind: 'room',
                    roomId: expectedRoomId,
                    modelId,
                };
                if (kind === 'fbx') {
                    await runImportWithScope(roomImportScope, () => (
                        rawHandleFBXFile(file, null, null, null, { signal: importSignal })
                    ));
                } else {
                    await runImportWithScope(roomImportScope, () => rawHandleZIPFile(file, { signal: importSignal }));
                }
                if (isStaleLoad()) {
                    abortImport();
                    cleanupRoomModelScopedAssets({ roomId: expectedRoomId, modelId });
                    return false;
                }
                await finalizeBatchAfterAllFiles();
                if (isStaleLoad()) {
                    abortImport();
                    cleanupRoomModelScopedAssets({ roomId: expectedRoomId, modelId });
                    return false;
                }
                loadedRoomModelIds.add(modelId);
                return true;
            } catch (err) {
                if (isAbortError(err) || isStaleLoad()) {
                    cleanupRoomModelScopedAssets({ roomId: expectedRoomId, modelId });
                    return false;
                }
                console.error('Room model load failed', err);
                return false;
            } finally {
                if (importAbortController) activeRoomImportControllers.delete(importAbortController);
                if (remoteModelLoadGeneration === expectedGeneration && remoteModelLoadModelId === modelId) {
                    isRemoteModelLoad = false;
                    remoteModelLoadGeneration = 0;
                    remoteModelLoadRoomId = '';
                    remoteModelLoadModelId = '';
                }
                if (isActiveRoomLoad(expectedGeneration, expectedRoomId)) setStatusMessage('');
            }
        }

        async function loadRoomModels() {
            if (!collabController) return;
            const roomId = String(collabController.room?.id || '');
            const generation = roomLoadGeneration;
            if (!roomId) return;
            if (isLoadingRoomModels && loadingRoomModelsGeneration === generation) return;
            isLoadingRoomModels = true;
            loadingRoomModelsGeneration = generation;
            try {
                const { data, error } = await collabController.supabase
                    .from('room_models')
                    .select('model_id, sort_order, project_models (id, url, name, meta)')
                    .eq('room_id', roomId)
                    .order('sort_order', { ascending: true });
                if (error) throw error;
                if (!isActiveRoomLoad(generation, roomId)) return;
                const rows = Array.isArray(data) ? data : [];
                roomModelCount = rows.length;
                for (const row of rows) {
                    if (!isActiveRoomLoad(generation, roomId)) return;
                    const model = row.project_models;
                    if (model) {
                        await loadProjectModel(model, { roomId, generation });
                    }
                }
                if (!roomModelsChannel && collabController) {
                    roomModelsChannel = collabController.supabase.channel(`room:${roomId}:models`);
                    roomModelsChannel.on(
                        'postgres_changes',
                        { event: '*', schema: 'public', table: 'room_models', filter: `room_id=eq.${roomId}` },
                        async (payload) => {
                            if (!isActiveRoomLoad(generation, roomId)) return;
                            const eventType = String(payload?.eventType || '').toUpperCase();
                            if (eventType === 'DELETE') {
                                const deletedRow = payload.old;
                                if (!deletedRow?.model_id) return;
                                roomModelCount = Math.max(0, roomModelCount - 1);
                                cleanupRoomModelScopedAssets({
                                    roomId,
                                    modelId: deletedRow.model_id,
                                });
                                return;
                            }
                            if (eventType !== 'INSERT') return;

                            const row = payload.new;
                            if (!row?.model_id) return;
                            const alreadyLoaded = loadedRoomModelIds.has(row.model_id);
                            if (alreadyLoaded) return;
                            roomModelCount += 1;
                            const { data: modelRow, error: modelError } = await collabController.supabase
                                .from('project_models')
                                .select('*')
                                .eq('id', row.model_id)
                                .limit(1)
                                .maybeSingle();
                            if (modelError) return;
                            if (!isActiveRoomLoad(generation, roomId)) return;
                            if (modelRow) await loadProjectModel(modelRow, { roomId, generation });
                        }
                    );
                    roomModelsChannel.subscribe();
                }
            } catch (err) {
                console.error('Room models load failed', err);
            } finally {
                if (loadingRoomModelsGeneration === generation) {
                    isLoadingRoomModels = false;
                    loadingRoomModelsGeneration = 0;
                }
            }
        }

        function collabRoomModelsPresent() {
            return roomModelCount > 0;
        }

        async function loadRoomCameras(options = {}) {
            const controller = options.controller || collabController;
            const roomId = String(options.roomId || controller?.room?.id || '');
            const generation = Number.isFinite(options.generation) ? options.generation : roomLoadGeneration;
            const isCurrent = () => (
                !!controller
                && controller === collabController
                && isActiveRoomLoad(generation, roomId)
            );
            if (!controller || !roomId || !cameraPresets?.loadState || !isCurrent()) return;
            const muteToken = beginCameraSyncMute();
            try {
                const { data: camRows, error: camError } = await controller.supabase
                    .from('room_cameras')
                    .select('*')
                    .eq('room_id', roomId)
                    .order('created_at', { ascending: true });
                if (camError) throw camError;
                if (!isCurrent()) return;

                const { data: trRows, error: trError } = await controller.supabase
                    .from('room_transitions')
                    .select('*')
                    .eq('room_id', roomId);
                if (trError) throw trError;
                if (!isCurrent()) return;

                const presets = (camRows || []).map((row) => ({
                    id: row.id,
                    name: row.name,
                    position: row.position,
                    target: row.target,
                    up: row.up,
                    fov: row.fov,
                    zoom: row.zoom,
                    near: row.near,
                    far: row.far,
                    shiftX: row.shift_x,
                    shiftY: row.shift_y,
                }));
                const transitions = (trRows || []).map((row) => ({
                    fromId: row.from_camera_id,
                    toId: row.to_camera_id,
                    seconds: row.seconds,
                    type: row.type,
                    trajectory: row.trajectory,
                }));
                roomCameraCount = Array.isArray(camRows) ? camRows.length : 0;
                cameraPresets.loadState({
                    presets,
                    transitions,
                    activeId: cameraPresets.getActiveId?.(),
                    lastCreatedId: cameraPresets.getLastCreatedId?.(),
                });
            } catch (err) {
                if (isCurrent()) console.error('Room cameras load failed', err);
            } finally {
                endCameraSyncMute(muteToken);
                flushRoomCameraRealtimeReload({ controller, roomId, generation });
            }
        }

        function normalizeRoomCameraVec3(value, fallback = [0, 0, 0]) {
            const base = Array.isArray(value) ? value : fallback;
            return [
                Number.isFinite(Number(base[0])) ? Number(base[0]) : fallback[0],
                Number.isFinite(Number(base[1])) ? Number(base[1]) : fallback[1],
                Number.isFinite(Number(base[2])) ? Number(base[2]) : fallback[2],
            ];
        }

        function normalizeRoomCameraNumber(value, fallback = 0) {
            const next = Number(value);
            return Number.isFinite(next) ? next : fallback;
        }

        function normalizeRoomCameraNullableNumber(value) {
            const next = Number(value);
            return Number.isFinite(next) ? next : null;
        }

        function makeRoomCameraRow(roomId, preset) {
            const id = String(preset?.id || '').trim();
            if (!roomId || !id) return null;
            return {
                id,
                room_id: roomId,
                name: String(preset?.name || 'Camera').trim() || 'Camera',
                position: normalizeRoomCameraVec3(preset?.position, [0, 0, 0]),
                target: normalizeRoomCameraVec3(preset?.target, [0, 0, 0]),
                up: normalizeRoomCameraVec3(preset?.up, [0, 1, 0]),
                fov: normalizeRoomCameraNullableNumber(preset?.fov),
                zoom: normalizeRoomCameraNullableNumber(preset?.zoom),
                near: normalizeRoomCameraNullableNumber(preset?.near),
                far: normalizeRoomCameraNullableNumber(preset?.far),
                shift_x: normalizeRoomCameraNumber(preset?.shiftX, 0),
                shift_y: normalizeRoomCameraNumber(preset?.shiftY, 0),
            };
        }

        function roomCameraComparable(row) {
            return JSON.stringify({
                name: String(row?.name || 'Camera').trim() || 'Camera',
                position: normalizeRoomCameraVec3(row?.position, [0, 0, 0]),
                target: normalizeRoomCameraVec3(row?.target, [0, 0, 0]),
                up: normalizeRoomCameraVec3(row?.up, [0, 1, 0]),
                fov: normalizeRoomCameraNullableNumber(row?.fov),
                zoom: normalizeRoomCameraNullableNumber(row?.zoom),
                near: normalizeRoomCameraNullableNumber(row?.near),
                far: normalizeRoomCameraNullableNumber(row?.far),
                shift_x: normalizeRoomCameraNumber(row?.shift_x ?? row?.shiftX, 0),
                shift_y: normalizeRoomCameraNumber(row?.shift_y ?? row?.shiftY, 0),
            });
        }

        function roomTransitionKey(fromId, toId) {
            return `${String(fromId || '')}->${String(toId || '')}`;
        }

        function normalizeRoomTransitionType(value) {
            const next = String(value || '').trim().toLowerCase();
            if (next === 'linear') return 'linear';
            if (next === 'soft-in' || next === 'ease-in') return 'soft-in';
            if (next === 'soft-out' || next === 'ease-out') return 'soft-out';
            if (next === 'ease-in-out' || next === 'soft') return 'ease-in-out';
            return 'ease-in-out';
        }

        function normalizeRoomTransitionTrajectory(value) {
            const next = String(value || '').trim().toLowerCase();
            if (next === 'spline' || next === 'curve' || next === 'curved') return 'spline';
            if (next === 'linear' || next === 'line') return 'linear';
            return 'linear';
        }

        function makeRoomTransitionRow(roomId, transition, validCameraIds) {
            const fromId = String(transition?.fromId || transition?.from_camera_id || '').trim();
            const toId = String(transition?.toId || transition?.to_camera_id || '').trim();
            if (!roomId || !fromId || !toId) return null;
            if (validCameraIds && (!validCameraIds.has(fromId) || !validCameraIds.has(toId))) return null;
            return {
                room_id: roomId,
                from_camera_id: fromId,
                to_camera_id: toId,
                seconds: Math.max(0, normalizeRoomCameraNumber(transition?.seconds, 0)),
                type: normalizeRoomTransitionType(transition?.type),
                trajectory: normalizeRoomTransitionTrajectory(transition?.trajectory),
            };
        }

        function roomTransitionComparable(row) {
            return JSON.stringify({
                from_camera_id: String(row?.from_camera_id || row?.fromId || '').trim(),
                to_camera_id: String(row?.to_camera_id || row?.toId || '').trim(),
                seconds: Math.max(0, normalizeRoomCameraNumber(row?.seconds, 0)),
                type: normalizeRoomTransitionType(row?.type),
                trajectory: normalizeRoomTransitionTrajectory(row?.trajectory),
            });
        }

        async function persistRoomCameraState(state, options = {}) {
            const controller = options.controller || collabController;
            const roomId = String(options.roomId || controller?.room?.id || '');
            const generation = Number.isFinite(options.generation) ? options.generation : roomLoadGeneration;
            const isCurrent = () => (
                !!controller
                && controller === collabController
                && isActiveRoomLoad(generation, roomId)
            );
            const supabase = controller?.supabase || null;
            if (!roomId || !supabase || !isCurrent()) return;

            const presets = Array.isArray(state?.presets) ? state.presets : [];
            const transitions = Array.isArray(state?.transitions) ? state.transitions : [];

            const desiredCameraRows = presets
                .map((preset) => makeRoomCameraRow(roomId, preset))
                .filter(Boolean);
            const desiredCameraIds = new Set(desiredCameraRows.map((row) => row.id));

            const { data: existingCameraRows, error: existingCameraError } = await supabase
                .from('room_cameras')
                .select('*')
                .eq('room_id', roomId);
            if (existingCameraError) throw existingCameraError;
            if (!isCurrent()) return;

            const existingCameraById = new Map(
                (Array.isArray(existingCameraRows) ? existingCameraRows : [])
                    .filter((row) => row?.id)
                    .map((row) => [row.id, row])
            );

            const cameraRowsToSave = desiredCameraRows.filter((row) => {
                const existing = existingCameraById.get(row.id);
                return !existing || roomCameraComparable(existing) !== roomCameraComparable(row);
            });

            if (cameraRowsToSave.length) {
                if (!isCurrent()) return;
                const { error: saveCameraError } = await supabase
                    .from('room_cameras')
                    .upsert(cameraRowsToSave, { onConflict: 'id' });
                if (saveCameraError) throw saveCameraError;
                if (!isCurrent()) return;
            }

            const desiredTransitionRows = transitions
                .map((transition) => makeRoomTransitionRow(roomId, transition, desiredCameraIds))
                .filter(Boolean);
            const desiredTransitionByKey = new Map(
                desiredTransitionRows.map((row) => [roomTransitionKey(row.from_camera_id, row.to_camera_id), row])
            );

            const { data: existingTransitionRows, error: existingTransitionError } = await supabase
                .from('room_transitions')
                .select('*')
                .eq('room_id', roomId);
            if (existingTransitionError) throw existingTransitionError;
            if (!isCurrent()) return;

            const existingTransitionsByKey = new Map();
            (Array.isArray(existingTransitionRows) ? existingTransitionRows : []).forEach((row) => {
                const key = roomTransitionKey(row?.from_camera_id, row?.to_camera_id);
                if (!existingTransitionsByKey.has(key)) {
                    existingTransitionsByKey.set(key, []);
                }
                existingTransitionsByKey.get(key).push(row);
            });

            const transitionIdsToDelete = [];
            const transitionRowsToUpdate = [];
            const handledTransitionKeys = new Set();

            // Keep at most one row per logical transition and update only the changed row.
            existingTransitionsByKey.forEach((rows, key) => {
                const desired = desiredTransitionByKey.get(key);
                if (!desired) {
                    rows.forEach((row) => {
                        if (row?.id) transitionIdsToDelete.push(row.id);
                    });
                    return;
                }

                handledTransitionKeys.add(key);
                const desiredComparable = roomTransitionComparable(desired);
                const matchingRow = rows.find((row) => roomTransitionComparable(row) === desiredComparable) || null;
                const keeper = matchingRow || rows[0] || null;

                if (!keeper) return;
                if (!matchingRow && keeper.id) {
                    transitionRowsToUpdate.push({ id: keeper.id, ...desired });
                }

                rows.forEach((row) => {
                    if (!row?.id || row.id === keeper.id) return;
                    transitionIdsToDelete.push(row.id);
                });
            });

            const transitionRowsToInsert = [];
            desiredTransitionByKey.forEach((row, key) => {
                if (!handledTransitionKeys.has(key)) {
                    transitionRowsToInsert.push(row);
                }
            });

            for (const row of transitionRowsToUpdate) {
                if (!isCurrent()) return;
                const { id, ...payload } = row;
                const { error: updateTransitionError } = await supabase
                    .from('room_transitions')
                    .update(payload)
                    .eq('id', id);
                if (updateTransitionError) throw updateTransitionError;
            }

            if (transitionRowsToInsert.length) {
                if (!isCurrent()) return;
                const { error: insertTransitionError } = await supabase
                    .from('room_transitions')
                    .insert(transitionRowsToInsert);
                if (insertTransitionError) throw insertTransitionError;
                if (!isCurrent()) return;
            }

            if (transitionIdsToDelete.length) {
                if (!isCurrent()) return;
                const { error: deleteTransitionError } = await supabase
                    .from('room_transitions')
                    .delete()
                    .in('id', transitionIdsToDelete);
                if (deleteTransitionError) throw deleteTransitionError;
                if (!isCurrent()) return;
            }

            const cameraIdsToDelete = (Array.isArray(existingCameraRows) ? existingCameraRows : [])
                .filter((row) => row?.id && !desiredCameraIds.has(row.id))
                .map((row) => row.id);

            if (cameraIdsToDelete.length) {
                if (!isCurrent()) return;
                const { error: deleteCameraError } = await supabase
                    .from('room_cameras')
                    .delete()
                    .in('id', cameraIdsToDelete);
                if (deleteCameraError) throw deleteCameraError;
                if (!isCurrent()) return;
            }

            roomCameraCount = desiredCameraRows.length;
        }

        function scheduleCameraPersist(state) {
            const controller = collabController;
            const roomId = String(controller?.room?.id || '');
            const generation = roomLoadGeneration;
            const isCurrent = () => (
                !!controller
                && controller === collabController
                && isActiveRoomLoad(generation, roomId)
            );
            if (!controller || !roomId || cameraSyncMuted || !isCurrent()) return;
            if (cameraPersistTimer) clearTimeout(cameraPersistTimer);
            cameraPersistTimer = setTimeout(async () => {
                cameraPersistTimer = null;
                if (cameraSyncMuted || !isCurrent()) return;
                const muteToken = beginCameraSyncMute();
                try {
                    await persistRoomCameraState(state, { controller, roomId, generation });
                } catch (err) {
                    if (isCurrent()) {
                        console.error('Room cameras sync failed', err);
                        await loadRoomCameras({ controller, roomId, generation });
                    }
                } finally {
                    endCameraSyncMute(muteToken);
                    flushRoomCameraRealtimeReload({ controller, roomId, generation });
                }
            }, 300);
        }

        cameraPresetsChangeHandler = scheduleCameraPersist;

        function subscribeRoomCameraChanges() {
            const controller = collabController;
            if (!controller) return;
            const roomId = String(controller.room?.id || '');
            const generation = roomLoadGeneration;
            const isCurrent = () => (
                !!roomId
                && controller === collabController
                && isActiveRoomLoad(generation, roomId)
            );
            if (!isCurrent()) return;
            if (!roomCamerasChannel) {
                roomCamerasChannel = controller.supabase.channel(`room:${roomId}:cameras`);
                roomCamerasChannel.on(
                    'postgres_changes',
                    { event: '*', schema: 'public', table: 'room_cameras', filter: `room_id=eq.${roomId}` },
                    () => {
                        if (isCurrent()) requestRoomCameraRealtimeReload({ controller, roomId, generation });
                    }
                );
                roomCamerasChannel.subscribe();
            }
            if (!roomTransitionsChannel) {
                roomTransitionsChannel = controller.supabase.channel(`room:${roomId}:transitions`);
                roomTransitionsChannel.on(
                    'postgres_changes',
                    { event: '*', schema: 'public', table: 'room_transitions', filter: `room_id=eq.${roomId}` },
                    () => {
                        if (isCurrent()) requestRoomCameraRealtimeReload({ controller, roomId, generation });
                    }
                );
                roomTransitionsChannel.subscribe();
            }
        }

        async function loadModelFromRoom(room) {
            const activeModelId = String(room?.active_model_id || '').trim();
            if (!room || !activeModelId) return;
            if (activeModelId === activeRoomModelId && loadedRoomModelIds.has(activeModelId)) return;
            if (!collabController) return;
            const roomId = String(room.id || collabController.room?.id || '');
            const generation = roomLoadGeneration;
            if (!isActiveRoomLoad(generation, roomId)) return;
            const { data: modelRow, error } = await collabController.supabase
                .from('project_models')
                .select('*')
                .eq('id', activeModelId)
                .limit(1)
                .maybeSingle();
            if (!isActiveRoomLoad(generation, roomId)) return;
            if (error || !modelRow) return;
            activeRoomModelId = activeModelId;
            await loadProjectModel(modelRow, { roomId, generation });
        }

        roomUpdateHandler = (room) => {
            void loadModelFromRoom(room);
        };

	        // =====================
	        // File flow
	        // =====================
	        const fileInput = dom.fileInput;
	        const openBtn = dom.openBtn;
        fileFlowUI = createFileFlowUIController({
            statusEl,
            fileInput,
            openBtn,
	            emptyHintEl,
	            rootEl,
	            dropEl,
	            sampleSelect,
	            sampleModels: SAMPLE_MODELS,
            onSampleChosen: () => setOrderModalVisible(false),
	            handleFBXFile,
	            handleZIPFile,
            finalizeBatchAfterAllFiles,
            hideSidePanel,
            setStatusMessage,
            setEmptyHintVisible: (visible) => {
                setEmptyHintVisible(!!visible && !isRoomEntryLandingActive());
            },
            getLoadedModelCount: () => loadedModels.length,
        });
        vrController = createVRController({
            THREE,
            scene,
            renderer,
            camera,
            controls,
            flightControls,
            loadedModels,
            sceneIndex,
            vrToggleBtn,
            requestRender,
            setStatusMessage,
            document,
            window,
            sampleModels: SAMPLE_MODELS,
            loadSampleModel: fileFlowUI.loadSampleModel,
        });
        setBootProgress(76, 'Подключение загрузчиков...');

        const revealEmptyHintWhenReady = async () => {
            try {
                await rendererInitPromise;
            } catch (_) {
                /* ignore */
            }
            setEmptyHintVisible(loadedModels.length === 0 && !isRoomEntryLandingActive());
        };
        if (typeof window !== 'undefined') {
            if (document.readyState === 'complete') {
                void revealEmptyHintWhenReady();
            } else {
                addAppEventListener(window, 'load', () => {
                    void revealEmptyHintWhenReady();
                }, { once: true });
            }
        } else {
            void revealEmptyHintWhenReady();
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
            onInitialFraming: () => cameraPresets?.updateLastCreatedFromCurrentView?.(),
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
        setBootProgress(84, 'Готовим интерфейс...');

        /**
         * Финальный шаг после загрузки всех файлов: применяет HDRI/фокус, автопривязку ВПМ и перерисовывает UI.
         */
	        async function finalizeBatchAfterAllFiles() {
	            const result = await batchFinalizer.finalizeBatchAfterAllFiles();
	            await syncPendingLocalModels();
	            return result;
	        }

	        async function disposeApp() {
	            if (appDisposed) return;
	            appDisposed = true;

	            try { renderLoop?.dispose?.(); } catch (_) {}
	            try { disposeAppTimers(); } catch (_) {}
	            try { disposeAppEventListeners(); } catch (_) {}
	            try { await teardownCollabSession(); } catch (_) {}
	            try { vrController?.dispose?.(); } catch (_) {}
	            try { annotations3d?.dispose?.(); } catch (_) {}
	            try { cameraPresets?.dispose?.(); } catch (_) {}
	            try { cameraPickController?.dispose?.(); } catch (_) {}
	            try { fileFlowUI?.dispose?.(); } catch (_) {}
	            try { assetLoaders?.dispose?.(); } catch (_) {}
	            try { inspectorPanels?.dispose?.(); } catch (_) {}
	            try { shadingController?.disposeUI?.(); } catch (_) {}
	            try { importedLightsController?.dispose?.(); } catch (_) {}
	            try { appbarVisibilityToggles?.dispose?.(); } catch (_) {}
	            try { appbarControlsController?.dispose?.(); } catch (_) {}
	            try { sunInputsController?.dispose?.(); } catch (_) {}
	            try { environmentControlsController?.dispose?.(); } catch (_) {}
	            try { hemiLightControlsController?.dispose?.(); } catch (_) {}
	            try { glassController?.dispose?.(); } catch (_) {}
	            try { sliderValuesUI?.dispose?.(); } catch (_) {}
	            try { debugTextures?.dispose?.(); } catch (_) {}
	            try { backfaceOverlay?.dispose?.(); } catch (_) {}
	            try { environmentWiring?.dispose?.(); } catch (_) {}
	            try { sunShadows?.dispose?.(); } catch (_) {}
	            try { mosParcels?.dispose?.(); } catch (_) {}
	            try { northGrid?.dispose?.(); } catch (_) {}
	            try { geoJsonModal?.dispose?.(); } catch (_) {}
	            try { promptModal?.dispose?.(); } catch (_) {}
	            try { confirmModal?.dispose?.(); } catch (_) {}
	            try { resetModal?.dispose?.(); } catch (_) {}
	            try { transitionModal?.dispose?.(); } catch (_) {}
	            try { exportModal?.dispose?.(); } catch (_) {}
	            try { rectAnnotModal?.dispose?.(); } catch (_) {}
	            try { layoutController?.dispose?.(); } catch (_) {}
	            try { customSelects?.dispose?.(); } catch (_) {}
	            try { statusUI?.dispose?.(); } catch (_) {}

	            loadedModels.forEach((record) => {
	                const obj = record?.obj || null;
	                try { obj?.parent?.remove?.(obj); } catch (_) {}
	                disposeImportedObjectTree(obj);
	            });
	            loadedModels.length = 0;
	            allEmbedded.forEach((entry) => revokeEmbeddedEntryUrl(entry));
	            allEmbedded.length = 0;

	            try { sceneCore?.dispose?.(); } catch (_) {}
	        }
	        app.dispose = disposeApp;

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
	            dispose: disposeApp,
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
                const vrChanged = vrController.update();
	                const flightChanged = vrController.isPresenting() ? false : flightControls.update();
	                if (flightChanged) {
	                    cameraPresets?.updateLastCreatedFromCurrentView?.();
	                }
                if (vrChanged) {
                    cameraPresets?.updateLastCreatedFromCurrentView?.();
                }
		                backgroundController.syncToCamera();
		            },
	            onError: (err, meta = {}) => {
	                const phase = String(meta.phase || 'frame');
	                console.error(`Render loop stopped during ${phase}`, err);
	                setStatusMessage(`Ошибка рендера: ${phase}`);
	            },
	        });
        setBootProgress(92, 'Запускаем рендер...');
        layout();
        const nextFrame = () => new Promise((resolve) => {
            const rafFn =
                typeof globalThis !== 'undefined' && typeof globalThis.requestAnimationFrame === 'function'
                    ? globalThis.requestAnimationFrame.bind(globalThis)
                    : null;
            if (!rafFn) {
                setTimeout(resolve, 30);
                return;
            }
            rafFn(() => resolve());
        });

        const finishBoot = async () => {
            if (appDisposed) return;
            setBootProgress(96, 'Финальная подготовка...');
            try {
                await Promise.allSettled([rendererInitPromise, pageLoadedPromise]);
            } catch (_) {
                /* ignore */
            }
            if (appDisposed) return;
            requestRender();
            await nextFrame();
            if (appDisposed) return;
            await nextFrame();
            if (appDisposed) return;
            hideBootLoader();
        };

        void finishBoot();

        if (typeof window !== 'undefined') {
            setAppTimeout(() => {
                if (appDisposed) return;
                hideBootLoader();
            }, 20000);
        }

        // IBL не запускаем автоматически — управляется чекбоксом
    }
}

const viewerApp = new ViewerApp();
if (typeof globalThis !== 'undefined') {
    globalThis.viewerApp = viewerApp;
}

export default viewerApp;
