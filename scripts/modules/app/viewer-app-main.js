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
import { createCameraSyncController } from '../collab/camera-sync.js';
import { createSupabaseClient } from '../collab/supabase-client.js';
import { HDRI_LIBRARY } from '../render/environment-manager.js';
import { createAndStartRenderLoop } from '../render/render-loop-bootstrap.js';
import { createDebugTextureProvider } from '../render/debug-textures.js';
import { createEnvironmentWiring } from '../render/environment-wiring.js';
import { createBackfaceOverlayController } from '../render/backface-overlay.js';
import { createShadingController } from '../render/shading-controller.js';
import { createPathTracerController } from '../render/path-tracer.js';
import { createAssetLoaders } from '../io/asset-loaders.js';
import { createImportHandlers } from '../io/import-handlers.js';
import { createFileFlowUIController } from '../io/file-flow-ui.js';
import { SAMPLE_MODELS } from '../io/sample-models.js';
import { createBatchFinalizer } from '../io/batch-finalizer.js';
import { exportWorldAsGLTF } from '../io/gltf-export.js';
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
            fillEl: dom.rectAnnotFillEl,
            infoEl: dom.rectAnnotInfoEl,
            areaEl: dom.rectAnnotAreaEl,
            textEl: dom.rectAnnotTextEl,
            textRowEl: dom.rectAnnotTextRowEl,
        });

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
	        const focusPickBtn = dom.focusPickBtn;
	        const exportBtn = dom.exportBtn;
	        const orderBtn = dom.orderBtn;
	        const pathTraceBtn = dom.pathTraceBtn;
	        const fullscreenBtn = dom.fullscreenBtn;

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
            orderBtn.addEventListener('click', () => setOrderModalVisible(true));
        }
        if (orderModalEl) {
            orderModalEl.addEventListener('click', (event) => {
                if (event.target === orderModalEl) {
                    setOrderModalVisible(false);
                }
            });
        }
        if (typeof window !== 'undefined' && orderModalEl) {
            window.addEventListener('keydown', (event) => {
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
		        const pathTraceSamplesEl = dom.pathTraceSamplesEl;
		        const pathTraceSpeedEl = dom.pathTraceSpeedEl;
		        const pathTraceShotBtn = dom.pathTraceShotBtn;
		        const pathTracePanelEl = dom.pathTracePanelEl;
	        const ptBouncesEl = dom.ptBouncesEl;
	        const ptTransmissiveEl = dom.ptTransmissiveEl;
	        const ptGlossyEl = dom.ptGlossyEl;
	        const ptClampEl = dom.ptClampEl;
	        const ptRenderScaleEl = dom.ptRenderScaleEl;
	        const ptLowResScaleEl = dom.ptLowResScaleEl;
	        const ptTilesXEl = dom.ptTilesXEl;
	        const ptTilesYEl = dom.ptTilesYEl;
	        const ptDynamicLowResEl = dom.ptDynamicLowResEl;
	        const ptStableNoiseEl = dom.ptStableNoiseEl;
	        const ptMISEl = dom.ptMISEl;
	        const ptPauseEl = dom.ptPauseEl;
	        const ptResetBtn = dom.ptResetBtn;

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
	        const notifyPathTracerEnv = () => {
	            if (app.pathTracer?.isEnabled?.()) {
	                app.pathTracer.updateEnvironment?.();
	            }
	        };
	        const notifyPathTracerLights = () => {
	            if (app.pathTracer?.isEnabled?.()) {
	                app.pathTracer.updateLights?.();
	            }
	        };
	        const notifyPathTracerMaterials = () => {
	            if (app.pathTracer?.isEnabled?.()) {
	                app.pathTracer.updateMaterials?.();
	            }
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
        const collabFooterEl = dom.collabFooterEl;
        const collabFooterGuestEl = dom.collabFooterGuestEl;
        const collabFooterRegisteredEl = dom.collabFooterRegisteredEl;
        const collabFooterProjectNameEl = dom.collabFooterProjectNameEl;
        const collabFooterRoomNameEl = dom.collabFooterRoomNameEl;
        const collabStatusBtn = dom.collabStatusBtn;
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
        }

        function getInitialAuthMode() {
            const hasProject = !!getProjectSlugFromUrl();
            const hasRoom = !!getRoomSlugFromUrl();
            return hasProject && hasRoom ? 'roomEntry' : 'initial';
        }

        function setAuthMode(mode) {
            const next = mode || 'initial';
            collabAuthMode = next;
            if (collabAuthPanelEl) {
                collabAuthPanelEl.dataset.mode = next;
            }
            clearAuthErrors();
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

        function canGuestEnter() {
            return !!getProjectSlugFromUrl() && !!getRoomSlugFromUrl();
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
        }

        const supabaseUrl =
            (typeof window !== 'undefined' && window.__SUPABASE_URL ? String(window.__SUPABASE_URL) : '') ||
            (typeof localStorage !== 'undefined' ? String(localStorage.getItem('lpmview.supabaseUrl') || '') : '');
        const supabaseAnonKey =
            (typeof window !== 'undefined' && window.__SUPABASE_ANON_KEY ? String(window.__SUPABASE_ANON_KEY) : '') ||
            (typeof localStorage !== 'undefined' ? String(localStorage.getItem('lpmview.supabaseAnonKey') || '') : '');

        const collabReady = !!(supabaseUrl && supabaseAnonKey);
        let collabSupabase = null;
        let collabUser = null;
        let collabAuthed = false;
        let collabIsRegistered = false;
        let collabIsSuperuser = false;
        let collabProject = null;
        let collabRoom = null;
        let collabProjects = [];
        let collabRooms = [];
        let collabOwnerId = null;
        let collabParticipants = [];
        let roomModelsChannel = null;
        const loadedRoomModelIds = new Set();
        let isLoadingRoomModels = false;
        let roomModelCount = 0;
        let roomCamerasChannel = null;
        let roomTransitionsChannel = null;
        let cameraSyncMuted = false;
        let cameraPersistTimer = null;
        let roomCameraCount = 0;
        let chatPanelVisible = true;
        const seenChatMessageIds = new Set();
        const collabContributors = new Map();
        let contributorsRenderQueued = false;

        function setCollabStatus(text) {
            if (!collabStatusEl) return;
            const label = String(text || '').trim();
            collabStatusEl.textContent = label || (collabController ? 'on' : 'off');
        }

        function updateCollabStatusButton() {
            if (!collabStatusBtn) return;
            if (!collabReady) {
                collabStatusBtn.hidden = true;
                return;
            }
            const isOnline = !!collabController;
            collabStatusBtn.hidden = false;
            collabStatusBtn.textContent = isOnline ? 'ONLINE' : 'OFFLINE';
            collabStatusBtn.classList.toggle('is-online', isOnline);
            collabStatusBtn.classList.toggle('is-offline', !isOnline);
            collabStatusBtn.setAttribute('aria-pressed', isOnline ? 'true' : 'false');
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
                setChatPanelVisible(true);
            }
        }

        function recordContributor(id, name) {
            if (!id) return;
            const safeName = String(name || '').trim() || 'Guest';
            const entry = collabContributors.get(id) || { id, name: safeName, hidden: false };
            if (safeName && safeName !== entry.name) entry.name = safeName;
            collabContributors.set(id, entry);
            scheduleContributorsRender();
        }

        function scheduleContributorsRender() {
            if (contributorsRenderQueued) return;
            contributorsRenderQueued = true;
            const raf =
                typeof requestAnimationFrame === 'function'
                    ? requestAnimationFrame
                    : (fn) => setTimeout(fn, 0);
            raf(() => {
                contributorsRenderQueued = false;
                renderChatContributors();
            });
        }

        function normalizeContributorKey(value) {
            return String(value || 'Guest').trim().toLowerCase();
        }

        function renderChatContributors() {
            if (!collabChatParticipantsEl) return;
            const onlineIds = new Set((collabParticipants || []).map((p) => p.id));
            const onlineNameKeys = new Set(
                (collabParticipants || [])
                    .map((p) => normalizeContributorKey(p?.name || ''))
                    .filter((key) => key)
            );
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
                    });
                    return;
                }
                existing.ids.push(entry.id);
                existing.online = existing.online || online || onlineNameKeys.has(key);
                existing.hiddenAll = existing.hiddenAll && !!entry.hidden;
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

                const nameEl = document.createElement('span');
                nameEl.className = 'collab-chat-user-name';
                nameEl.textContent = entry.name || 'Guest';

                row.append(eyeBtn, nameEl);
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

        function setRoomSlugInUrl(projectSlug, roomSlug) {
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
                window.history.replaceState({}, '', url.toString());
                return url.toString();
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

        async function teardownCollabSession() {
            cameraSync?.dispose?.();
            cameraSync = null;
            cameraSyncMuted = false;

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
            setCollabStatus('off');
            updateCollabStatusButton();
            setChatPanelAvailability(false);
            seenChatMessageIds.clear();
            if (collabChatLogEl) collabChatLogEl.innerHTML = '';
            collabContributors.clear();
            if (collabChatParticipantsEl) collabChatParticipantsEl.innerHTML = '';

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
                const { error } = await collabSupabase.from('projects').delete().eq('id', projectId);
                if (error) throw error;
                if (collabController?.project?.id === projectId) {
                    await teardownCollabSession();
                }
                if (collabProject?.id === projectId) {
                    collabProject = null;
                    collabRoom = null;
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
                if (participant.id === collabOwnerId) {
                    meta.textContent = 'ведёт';
                } else if (participant.id === collabController?.user?.id) {
                    meta.textContent = 'вы';
                } else {
                    meta.textContent = '';
                }
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
                collabOwnerEl.textContent = 'свободно';
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

        async function ensureSupabaseClient() {
            if (!collabReady) return null;
            if (!collabSupabase) {
                collabSupabase = await createSupabaseClient({ url: supabaseUrl, anonKey: supabaseAnonKey });
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
            if (!collabSupabase) {
                collabSupabase = await createSupabaseClient({ url: supabaseUrl, anonKey: supabaseAnonKey });
            }

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
            updateCollabFooter();

            const displayName = resolveDisplayName(name);
            await collabSupabase.from('profiles').upsert({
                id: collabUser.id,
                display_name: displayName,
            });
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
            const baseSlug = slugifyName(trimmed) || makeSlug(6);
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
                nextSlug = `${baseSlug}-${makeSlug(4)}`;
            }
            if (!created) return;
            if (!created.owner_id) created.owner_id = collabUser.id;
            collabProject = created;
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
            if (existing) return existing;
            if (!collabIsRegistered) return null;
            const { data: created, error } = await collabSupabase
                .from('rooms')
                .insert({
                    project_id: projectId,
                    slug,
                    owner_id: collabUser?.id,
                })
                .select('id, slug, project_id, owner_id, created_at')
                .single();
            if (error) throw error;
            return created;
        }

        async function connectToRoom(name) {
            if (!collabSupabase || !collabUser || !collabProject || !collabRoom) return;
            collabJoinBtn.disabled = true;
            setCollabStatus('connecting');
            try {
                collabController = await createCollabController({
                    supabaseUrl,
                    supabaseAnonKey,
                    supabase: collabSupabase,
                    user: collabUser,
                    project: collabProject,
                    room: collabRoom,
                    projectSlug: collabProject.slug,
                    roomSlug: collabRoom.slug,
                    displayName: name,
                    onStatus: setCollabStatus,
                    onProjectReady: (project) => {
                        collabProject = project;
                        updateCollabFooter();
                    },
                    onRoomReady: ({ project, room }) => {
                        collabProject = project || collabProject;
                        collabRoom = room || collabRoom;
                        const shareUrl = setRoomSlugInUrl(collabProject?.slug, collabRoom?.slug);
                        if (collabRoomLinkEl) collabRoomLinkEl.value = shareUrl;
                        updateCollabFooter();
                    },
                    onParticipants: (list) => {
                        renderParticipants(list);
                        updateOwnerLabel();
                    },
                    onMessage: (message, meta) => {
                        appendChatMessage(message, { scroll: meta?.source !== 'history' });
                    },
                    onAnnotation: (record) => {
                        if (record?.author_id) {
                            recordContributor(record.author_id, record.author_name);
                        }
                        annotations3d?.addRemoteAnnotation?.(record);
                    },
                    onAnnotationDelete: (record) => {
                        annotations3d?.removeRemoteAnnotation?.(record?.id);
                    },
                    onCameraState: (state) => {
                        cameraSync?.handleRemoteState?.(state);
                    },
                    onCameraOwner: (ownerId) => {
                        setCollabOwner(ownerId);
                    },
                    onRoomUpdate: (room) => roomUpdateHandler?.(room),
                });
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
                await loadRoomCameras();
                if (roomCameraCount === 0) {
                    scheduleCameraPersist({
                        presets: cameraPresets.getPresets?.() || [],
                        transitions: cameraPresets.getTransitions?.() || [],
                    });
                }
                subscribeRoomCameraChanges();
                if (lastLocalModelFile && !collabRoomModelsPresent()) {
                    const synced = await syncModelToRoom(lastLocalModelFile);
                    if (synced) lastLocalModelFile = null;
                }

                if (dom.annotateCanvasEl) {
                    dom.annotateCanvasEl.addEventListener('pointerdown', () => cameraSync?.markLocalActivity(true));
                    dom.annotateCanvasEl.addEventListener('pointerup', () => cameraSync?.markLocalActivity(false));
                    dom.annotateCanvasEl.addEventListener('pointercancel', () => cameraSync?.markLocalActivity(false));
                }

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
                if (collabController?.user?.id && collabContributors.has(collabController.user.id)) {
                    recordContributor(collabController.user.id, collabController.getDisplayName?.());
                    annotations3d?.refreshAuthorVisibility?.(collabController.user.id);
                }
            } catch (err) {
                console.error('Collab init failed', err);
                setCollabStatus('error');
            } finally {
                collabJoinBtn.disabled = false;
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

                const projectSlug = getProjectSlugFromUrl();
                const roomSlug = getRoomSlugFromUrl();
                if (projectSlug) {
                    const joinedProject = await collabSupabase.rpc('join_project_by_slug', { project_slug: projectSlug });
                    if (joinedProject.error) throw joinedProject.error;
                    collabProject = joinedProject.data;
                    await loadProjects();
                    await loadRooms(collabProject.id);
                    if (roomSlug) {
                        const room = await ensureRoomBySlug(collabProject.id, roomSlug);
                        if (!room) {
                            setCollabStatus('room missing');
                            return;
                        }
                        collabRoom = room;
                        await loadRooms(collabProject.id);
                        updateAdminControls();
                        await connectToRoom(displayName || 'Guest');
                        return;
                    }
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
                    setFieldError(collabPasswordErrorEl, 'Неверный email или пароль.');
                } else if (message.toLowerCase().includes('invalid format')) {
                    setFieldError(collabEmailErrorEl, 'Некорректный email.');
                } else {
                    setCollabStatus('error');
                    setAuthError('Не удалось войти. Проверьте данные.');
                }
            } finally {
                collabJoinBtn.disabled = false;
                if (collabSignupBtn) collabSignupBtn.disabled = false;
                if (collabGuestBtn) collabGuestBtn.disabled = false;
            }
        }

        if (collabNameEl && typeof localStorage !== 'undefined') {
            const storedName = localStorage.getItem('lpmview.displayName');
            if (storedName) collabNameEl.value = storedName;
        }

        function stopKeydownPropagation(el) {
            if (!el?.addEventListener) return;
            el.addEventListener('keydown', (event) => {
                event.stopPropagation();
            });
        }

        if (typeof document !== 'undefined') {
            document.addEventListener('keydown', (event) => {
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

        collabEmailEl?.addEventListener?.('keyup', authEnterHandler);
        collabNameEl?.addEventListener?.('keyup', authEnterHandler);
        collabPasswordEl?.addEventListener?.('keyup', authEnterHandler);
        collabPasswordConfirmEl?.addEventListener?.('keyup', authEnterHandler);

        setAuthMode(getInitialAuthMode());

        if (collabShowLoginBtn) {
            collabShowLoginBtn.addEventListener('click', () => {
                setAuthMode('login');
            });
        }

        if (collabShowRegisterBtn) {
            collabShowRegisterBtn.addEventListener('click', () => {
                setAuthMode('register');
            });
        }

        if (collabBackBtns && collabBackBtns.length) {
            collabBackBtns.forEach((btn) => {
                btn.addEventListener('click', () => {
                    setAuthMode(getInitialAuthMode());
                });
            });
        }

        if (collabJoinBtn) {
            collabJoinBtn.disabled = !collabReady;
            collabJoinBtn.addEventListener('click', () => {
                void connectCollab('login');
            });
        }

        if (collabSignupBtn) {
            collabSignupBtn.disabled = !collabReady;
            collabSignupBtn.addEventListener('click', () => {
                void connectCollab('signup');
            });
        }

        if (collabGuestBtn) {
            collabGuestBtn.disabled = !collabReady;
            collabGuestBtn.addEventListener('click', () => {
                void connectCollab('guest');
            });
        }

        if (collabPanelBtn && collabDrawerEl) {
            collabPanelBtn.addEventListener('click', () => {
                setCollabDrawerOpen(collabDrawerEl.hidden);
            });
        }

        if (collabStatusBtn) {
            collabStatusBtn.disabled = !collabReady;
            collabStatusBtn.addEventListener('click', async () => {
                if (!collabReady) return;
                if (!collabController) {
                    setCollabDrawerOpen(true);
                    return;
                }
                const confirmed = await confirmModal.open({
                    title: 'Выйти из совместной работы',
                    message: 'Вы точно хотите выйти из режима совместной работы?',
                    okText: 'Выйти',
                    cancelText: 'Отмена',
                });
                if (!confirmed) return;
                await teardownCollabSession();
            });
        }

        if (collabDrawerCloseBtn) {
            collabDrawerCloseBtn.addEventListener('click', () => {
                setCollabDrawerOpen(false);
            });
        }

        if (collabResetBtn) {
            collabResetBtn.disabled = !collabReady;
            collabResetBtn.addEventListener('click', () => {
                void requestPasswordReset();
            });
        }

        if (collabResendBtn) {
            collabResendBtn.disabled = !collabReady;
            collabResendBtn.addEventListener('click', () => {
                void requestSignupConfirmation();
            });
        }

        if (collabProjectSelectEl) {
            collabProjectSelectEl.addEventListener('change', async () => {
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
                renderRoomOptions([], '');
                if (!collabProject && collabRoomLinkEl) {
                    collabRoomLinkEl.value = '';
                }
                if (collabProject) {
                    await loadRooms(collabProject.id);
                }
                updateAdminControls();
            });
            collabProjectSelectEl.addEventListener('customselect:delete', (event) => {
                const value = event?.detail?.value;
                if (!value) return;
                void deleteProjectById(String(value));
            });
        }

        if (collabRoomSelectEl) {
            collabRoomSelectEl.addEventListener('change', async () => {
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
                if (collabRoom && collabAuthed && !collabController) {
                    void connectToRoom(String(collabNameEl?.value || '').trim() || 'Guest');
                }
                updateAdminControls();
            });
            collabRoomSelectEl.addEventListener('customselect:delete', (event) => {
                const value = event?.detail?.value;
                if (!value) return;
                void deleteRoomById(String(value));
            });
        }

        collabProjectNameInputEl?.addEventListener?.('keyup', (event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            void submitProjectCreate();
        });

        collabRoomNameInputEl?.addEventListener?.('keyup', (event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            void submitRoomCreate();
        });

        if (collabChatSendBtn && collabChatInputEl) {
            collabChatSendBtn.addEventListener('click', () => {
                const text = String(collabChatInputEl.value || '').trim();
                if (!text || !collabController) return;
                collabController.sendMessage(text).catch((err) => console.error('Chat send failed', err));
                collabChatInputEl.value = '';
            });
            collabChatInputEl.addEventListener('keyup', (event) => {
                if (event.key !== 'Enter' || event.shiftKey) return;
                event.preventDefault();
                collabChatSendBtn.click();
            });
        }

        if (!collabChatSendBtn && collabChatInputEl) {
            collabChatInputEl.addEventListener('keyup', (event) => {
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
            collabChatToggleBtn.addEventListener('click', () => {
                if (!collabController) return;
                setChatPanelVisible(!chatPanelVisible);
            });
        }

        if (collabCopyBtn && collabRoomLinkEl) {
            collabCopyBtn.addEventListener('click', () => {
                const value = String(collabRoomLinkEl.value || '').trim();
                if (!value) return;
                if (navigator?.clipboard?.writeText) {
                    void navigator.clipboard.writeText(value);
                }
            });
        }

        if (collabReserveBtn) {
            collabReserveBtn.addEventListener('click', async () => {
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
        updateCollabStatusButton();
        setChatPanelAvailability(false);
        updateAdminControls();
        void maybeHandlePasswordRecovery();
        void clearPersistedEmailSession();

        exportBtn?.addEventListener?.('click', () => {
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
		            onEnvironmentUpdated: notifyPathTracerEnv,
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
		            onLightsUpdated: notifyPathTracerLights,
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
	            onLightsUpdated: notifyPathTracerLights,
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
	            notifyPathTracerMaterials();
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
            onLightsUpdated: notifyPathTracerLights,
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
        let lastLocalModelFile = null;
        let isRemoteModelLoad = false;
        let activeRoomModelId = '';

        async function handleFBXFile(file) {
            await rawHandleFBXFile(file);
            if (!isRemoteModelLoad) lastLocalModelFile = file;
        }

        async function handleZIPFile(file) {
            await rawHandleZIPFile(file);
            if (!isRemoteModelLoad) lastLocalModelFile = file;
        }

        function getModelKindFromName(name) {
            if (!name) return 'zip';
            if (/\.fbx$/i.test(name)) return 'fbx';
            if (/\.zip$/i.test(name)) return 'zip';
            return 'zip';
        }

        async function uploadModelToProject(file) {
            if (!collabController || !file) return null;
            const supabase = collabController.supabase;
            const bucket = supabase.storage.from('models');
            const safeName = String(file.name || 'model.zip').replace(/\s+/g, '_');
            const projectId = collabController.project?.id || 'project';
            const path = `projects/${projectId}/${Date.now()}-${safeName}`;
            const { error: uploadError } = await bucket.upload(path, file, {
                upsert: true,
                contentType: file.type || 'application/octet-stream',
            });
            if (uploadError) throw uploadError;
            const { data } = bucket.getPublicUrl(path);
            return data?.publicUrl || '';
        }

        async function syncModelToRoom(file) {
            if (!collabController || !file || isRemoteModelLoad) return false;
            try {
                setStatusMessage('Синхронизация модели…');
                const url = await uploadModelToProject(file);
                if (!url) return false;
                const meta = {
                    size: file.size || 0,
                    type: file.type || '',
                    kind: getModelKindFromName(file.name),
                    lastModified: file.lastModified || null,
                };
                const { data: modelRow, error: modelError } = await collabController.supabase
                    .from('project_models')
                    .insert({
                        project_id: collabController.project.id,
                        name: file.name || 'model.zip',
                        url,
                        meta,
                    })
                    .select('*')
                    .single();
                if (modelError) throw modelError;

                await collabController.supabase
                    .from('room_models')
                    .insert({
                        room_id: collabController.room.id,
                        project_id: collabController.project.id,
                        model_id: modelRow.id,
                        sort_order: roomModelCount,
                    });

                await collabController.supabase
                    .from('rooms')
                    .update({ active_model_id: modelRow.id })
                    .eq('id', collabController.room.id);

                activeRoomModelId = modelRow.id;
                loadedRoomModelIds.add(modelRow.id);
                roomModelCount += 1;
                return true;
            } catch (err) {
                console.error('Model sync failed', err);
                return false;
            } finally {
                setStatusMessage('');
            }
        }

        async function loadProjectModel(model) {
            if (!model || !model.url || isRemoteModelLoad) return;
            if (loadedRoomModelIds.has(model.id)) return;
            const url = model.url;
            const name = model.name || url.split('/').pop() || 'model.zip';
            const kind = model.meta?.kind || getModelKindFromName(name);
            try {
                setStatusMessage('Загрузка модели из комнаты…');
                const response = await fetch(url, { cache: 'no-cache' });
                if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
                const blob = await response.blob();
                const file = new File([blob], name, { type: blob.type || 'application/octet-stream' });
                isRemoteModelLoad = true;
                lastLocalModelFile = null;
                if (kind === 'fbx') {
                    await rawHandleFBXFile(file);
                } else {
                    await rawHandleZIPFile(file);
                }
                await finalizeBatchAfterAllFiles();
                loadedRoomModelIds.add(model.id);
            } catch (err) {
                console.error('Room model load failed', err);
            } finally {
                isRemoteModelLoad = false;
                setStatusMessage('');
            }
        }

        async function loadRoomModels() {
            if (!collabController || isLoadingRoomModels) return;
            isLoadingRoomModels = true;
            try {
                const { data, error } = await collabController.supabase
                    .from('room_models')
                    .select('model_id, sort_order, project_models (id, url, name, meta)')
                    .eq('room_id', collabController.room.id)
                    .order('sort_order', { ascending: true });
                if (error) throw error;
                const rows = Array.isArray(data) ? data : [];
                roomModelCount = rows.length;
                for (const row of rows) {
                    const model = row.project_models;
                    if (model) {
                        await loadProjectModel(model);
                    }
                }
                if (!roomModelsChannel && collabController) {
                    roomModelsChannel = collabController.supabase.channel(`room:${collabController.room.id}:models`);
                    roomModelsChannel.on(
                        'postgres_changes',
                        { event: 'INSERT', schema: 'public', table: 'room_models', filter: `room_id=eq.${collabController.room.id}` },
                        async (payload) => {
                            const row = payload.new;
                            if (!row?.model_id) return;
                            roomModelCount += 1;
                            const { data: modelRow, error: modelError } = await collabController.supabase
                                .from('project_models')
                                .select('*')
                                .eq('id', row.model_id)
                                .limit(1)
                                .maybeSingle();
                            if (modelError) return;
                            if (modelRow) await loadProjectModel(modelRow);
                        }
                    );
                    roomModelsChannel.subscribe();
                }
            } catch (err) {
                console.error('Room models load failed', err);
            } finally {
                isLoadingRoomModels = false;
            }
        }

        function collabRoomModelsPresent() {
            return roomModelCount > 0;
        }

        async function loadRoomCameras() {
            if (!collabController || !cameraPresets?.loadState) return;
            cameraSyncMuted = true;
            try {
                const roomId = collabController.room.id;
                const { data: camRows, error: camError } = await collabController.supabase
                    .from('room_cameras')
                    .select('*')
                    .eq('room_id', roomId)
                    .order('created_at', { ascending: true });
                if (camError) throw camError;
                roomCameraCount = Array.isArray(camRows) ? camRows.length : 0;

                const { data: trRows, error: trError } = await collabController.supabase
                    .from('room_transitions')
                    .select('*')
                    .eq('room_id', roomId);
                if (trError) throw trError;

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
                cameraPresets.loadState({
                    presets,
                    transitions,
                    activeId: cameraPresets.getActiveId?.(),
                    lastCreatedId: cameraPresets.getLastCreatedId?.(),
                });
            } catch (err) {
                console.error('Room cameras load failed', err);
            } finally {
                cameraSyncMuted = false;
            }
        }

        function scheduleCameraPersist(state) {
            if (!collabController || cameraSyncMuted) return;
            if (cameraPersistTimer) clearTimeout(cameraPersistTimer);
            cameraPersistTimer = setTimeout(async () => {
                if (!collabController || cameraSyncMuted) return;
                cameraSyncMuted = true;
                try {
                    const roomId = collabController.room.id;
                    const presets = Array.isArray(state?.presets) ? state.presets : [];
                    const transitions = Array.isArray(state?.transitions) ? state.transitions : [];

                    await collabController.supabase
                        .from('room_transitions')
                        .delete()
                        .eq('room_id', roomId);

                    await collabController.supabase
                        .from('room_cameras')
                        .delete()
                        .eq('room_id', roomId);

                    if (presets.length) {
                        const camRows = presets.map((preset) => ({
                            id: preset.id,
                            room_id: roomId,
                            name: preset.name || 'Camera',
                            position: preset.position || [0, 0, 0],
                            target: preset.target || [0, 0, 0],
                            up: preset.up || [0, 1, 0],
                            fov: preset.fov,
                            zoom: preset.zoom,
                            near: preset.near,
                            far: preset.far,
                            shift_x: preset.shiftX ?? 0,
                            shift_y: preset.shiftY ?? 0,
                        }));
                        await collabController.supabase.from('room_cameras').insert(camRows);
                    }

                    if (transitions.length) {
                        const trRows = transitions
                            .filter((tr) => tr.fromId && tr.toId)
                            .map((tr) => ({
                                room_id: roomId,
                                from_camera_id: tr.fromId,
                                to_camera_id: tr.toId,
                                seconds: tr.seconds ?? 0,
                                type: tr.type || 'ease-in-out',
                                trajectory: tr.trajectory || 'linear',
                            }));
                        if (trRows.length) {
                            await collabController.supabase.from('room_transitions').insert(trRows);
                        }
                    }
                } catch (err) {
                    console.error('Room cameras sync failed', err);
                } finally {
                    cameraSyncMuted = false;
                }
            }, 300);
        }

        cameraPresetsChangeHandler = scheduleCameraPersist;

        function subscribeRoomCameraChanges() {
            if (!collabController) return;
            const roomId = collabController.room.id;
            if (!roomCamerasChannel) {
                roomCamerasChannel = collabController.supabase.channel(`room:${roomId}:cameras`);
                roomCamerasChannel.on(
                    'postgres_changes',
                    { event: '*', schema: 'public', table: 'room_cameras', filter: `room_id=eq.${roomId}` },
                    () => {
                        if (!cameraSyncMuted) {
                            void loadRoomCameras();
                        }
                    }
                );
                roomCamerasChannel.subscribe();
            }
            if (!roomTransitionsChannel) {
                roomTransitionsChannel = collabController.supabase.channel(`room:${roomId}:transitions`);
                roomTransitionsChannel.on(
                    'postgres_changes',
                    { event: '*', schema: 'public', table: 'room_transitions', filter: `room_id=eq.${roomId}` },
                    () => {
                        if (!cameraSyncMuted) {
                            void loadRoomCameras();
                        }
                    }
                );
                roomTransitionsChannel.subscribe();
            }
        }

        async function loadModelFromRoom(room) {
            if (!room || !room.active_model_id || isRemoteModelLoad) return;
            if (room.active_model_id === activeRoomModelId) return;
            activeRoomModelId = room.active_model_id;
            if (!collabController) return;
            const { data: modelRow, error } = await collabController.supabase
                .from('project_models')
                .select('*')
                .eq('id', room.active_model_id)
                .limit(1)
                .maybeSingle();
            if (error || !modelRow) return;
            await loadProjectModel(modelRow);
        }

        roomUpdateHandler = (room) => {
            void loadModelFromRoom(room);
        };

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

        const revealEmptyHintWhenReady = async () => {
            try {
                await rendererInitPromise;
            } catch (_) {
                /* ignore */
            }
            setEmptyHintVisible(loadedModels.length === 0);
        };
        if (typeof window !== 'undefined') {
            if (document.readyState === 'complete') {
                void revealEmptyHintWhenReady();
            } else {
                window.addEventListener('load', () => {
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

        /**
         * Финальный шаг после загрузки всех файлов: применяет HDRI/фокус, автопривязку ВПМ и перерисовывает UI.
         */
        async function finalizeBatchAfterAllFiles() {
            const result = await batchFinalizer.finalizeBatchAfterAllFiles();
            if (lastLocalModelFile) {
                const synced = await syncModelToRoom(lastLocalModelFile);
                if (synced) lastLocalModelFile = null;
            }
            return result;
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
	                const flightChanged = flightControls.update();
	                if (flightChanged) {
	                    cameraPresets?.updateLastCreatedFromCurrentView?.();
	                }
	                backgroundController.syncToCamera();
	            },
        });
		        const pathTracerController = createPathTracerController({
		            THREE,
		            scene,
		            camera,
	            renderer,
	            rootEl,
	            controls,
	            flightControls,
	            renderLoop,
		            requestRender,
		            setStatusMessage,
	            pathTraceBtn,
	            pathTraceSamplesEl,
	            pathTraceSpeedEl,
	            pathTraceShotBtn,
	            pathTracePanelEl,
            ptBouncesEl,
            ptTransmissiveEl,
            ptGlossyEl,
            ptClampEl,
            ptRenderScaleEl,
            ptLowResScaleEl,
            ptTilesXEl,
	            ptTilesYEl,
	            ptDynamicLowResEl,
	            ptStableNoiseEl,
	            ptMISEl,
	            ptPauseEl,
	            ptResetBtn,
	            window,
	            document,
	        });
	        app.pathTracer = pathTracerController;
        layout();
        // IBL не запускаем автоматически — управляется чекбоксом
    }
}

const viewerApp = new ViewerApp();
if (typeof globalThis !== 'undefined') {
    globalThis.viewerApp = viewerApp;
}

export default viewerApp;
