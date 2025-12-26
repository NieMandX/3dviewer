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

        const transitionModal = createTransitionModalController({
            modalEl: dom.transitionModalEl,
            titleEl: dom.transitionTitleEl,
            secondsEl: dom.transitionSecondsEl,
            typeEl: dom.transitionTypeEl,
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
	        const pathTraceBtn = dom.pathTraceBtn;
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
		            promptTransition: ({ from, to, seconds, type }) => transitionModal.open({
		                title: `Переход: ${(from?.name || 'Camera')} → ${(to?.name || 'Camera')}`,
		                seconds: seconds ?? 0,
		                type: type ?? 'soft',
		            }),
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
        const collabJoinBtn = dom.collabJoinBtn;
        const collabRoomLinkEl = dom.collabRoomLinkEl;
        const collabCopyBtn = dom.collabCopyBtn;
        const collabReserveBtn = dom.collabReserveBtn;
        const collabOwnerEl = dom.collabOwnerEl;
        const collabParticipantsEl = dom.collabParticipantsEl;
        const collabChatLogEl = dom.collabChatLogEl;
        const collabChatInputEl = dom.collabChatInputEl;
        const collabChatSendBtn = dom.collabChatSendBtn;

        const supabaseUrl =
            (typeof window !== 'undefined' && window.__SUPABASE_URL ? String(window.__SUPABASE_URL) : '') ||
            (typeof localStorage !== 'undefined' ? String(localStorage.getItem('lpmview.supabaseUrl') || '') : '');
        const supabaseAnonKey =
            (typeof window !== 'undefined' && window.__SUPABASE_ANON_KEY ? String(window.__SUPABASE_ANON_KEY) : '') ||
            (typeof localStorage !== 'undefined' ? String(localStorage.getItem('lpmview.supabaseAnonKey') || '') : '');

        const collabReady = !!(supabaseUrl && supabaseAnonKey);
        let collabOwnerId = null;
        let collabParticipants = [];

        function setCollabStatus(text) {
            if (!collabStatusEl) return;
            const label = String(text || '').trim();
            collabStatusEl.textContent = label || (collabController ? 'on' : 'off');
        }

        function getRoomSlugFromUrl() {
            try {
                const url = new URL(window.location.href);
                return url.searchParams.get('room') || '';
            } catch (_) {
                return '';
            }
        }

        function setRoomSlugInUrl(slug) {
            try {
                const url = new URL(window.location.href);
                url.searchParams.set('room', slug);
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

        function appendChatMessage(message, options = {}) {
            if (!collabChatLogEl || !message) return;
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
            });
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

        function updateReserveButton() {
            if (!collabReserveBtn) return;
            if (!collabController) {
                collabReserveBtn.disabled = true;
                collabReserveBtn.textContent = 'Резерв вращения';
                return;
            }
            const isOwner = !!cameraSync?.isOwner?.();
            collabReserveBtn.disabled = false;
            collabReserveBtn.textContent = isOwner ? 'Снять резерв' : 'Резерв вращения';
        }

        async function connectCollab() {
            if (!collabReady || !collabJoinBtn || !collabNameEl) return;
            const name = String(collabNameEl.value || '').trim() || 'Guest';
            if (collabController) {
                await collabController.setDisplayName(name);
                if (typeof localStorage !== 'undefined') {
                    localStorage.setItem('lpmview.displayName', name);
                }
                renderParticipants(collabParticipants);
                updateOwnerLabel();
                return;
            }
            collabJoinBtn.disabled = true;
            setCollabStatus('connecting');
            try {
                collabController = await createCollabController({
                    supabaseUrl,
                    supabaseAnonKey,
                    roomSlug: getRoomSlugFromUrl(),
                    displayName: name,
                    onStatus: setCollabStatus,
                    onRoomReady: ({ slug }) => {
                        const shareUrl = setRoomSlugInUrl(slug);
                        if (collabRoomLinkEl) collabRoomLinkEl.value = shareUrl;
                    },
                    onParticipants: (list) => {
                        renderParticipants(list);
                        updateOwnerLabel();
                    },
                    onMessage: (message, meta) => {
                        appendChatMessage(message, { scroll: meta?.source !== 'history' });
                    },
                    onAnnotation: (record) => {
                        annotations3d?.addRemoteAnnotation?.(record);
                    },
                    onAnnotationDelete: (record) => {
                        annotations3d?.removeRemoteAnnotation?.(record?.id);
                    },
                    onCameraState: (state) => {
                        cameraSync?.handleRemoteState?.(state);
                    },
                    onCameraOwner: (ownerId) => {
                        collabOwnerId = ownerId;
                        cameraSync?.setOwner?.(ownerId);
                        renderParticipants(collabParticipants);
                        updateOwnerLabel();
                        updateReserveButton();
                    },
                    onRoomUpdate: (room) => roomUpdateHandler?.(room),
                });

                cameraSync = createCameraSyncController({
                    camera,
                    controls,
                    requestRender,
                    collab: collabController,
                    localUserId: collabController.user.id,
                    isLocalBusy: () => annotations3d?.getDrawEnabled?.() || annotations3d?.isPointerDown?.(),
                });
                if (collabOwnerId) {
                    cameraSync.setOwner(collabOwnerId);
                }
                roomUpdateHandler?.(collabController.room);
                if (lastLocalModelFile && !collabController.room?.model_url) {
                    const synced = await syncModelToRoom(lastLocalModelFile);
                    if (synced) lastLocalModelFile = null;
                }

                if (dom.annotateCanvasEl) {
                    dom.annotateCanvasEl.addEventListener('pointerdown', () => cameraSync?.markLocalActivity(true));
                    dom.annotateCanvasEl.addEventListener('pointerup', () => cameraSync?.markLocalActivity(false));
                    dom.annotateCanvasEl.addEventListener('pointercancel', () => cameraSync?.markLocalActivity(false));
                }

                if (typeof localStorage !== 'undefined') {
                    localStorage.setItem('lpmview.displayName', name);
                }
                setCollabStatus('on');
                renderParticipants(collabParticipants);
                updateReserveButton();
                updateOwnerLabel();
                scrollChatToBottom();
            } catch (err) {
                console.error('Collab init failed', err);
                setCollabStatus('error');
                collabJoinBtn.disabled = false;
            }
        }

        if (collabNameEl && typeof localStorage !== 'undefined') {
            const storedName = localStorage.getItem('lpmview.displayName');
            if (storedName) collabNameEl.value = storedName;
        }

        if (collabJoinBtn) {
            collabJoinBtn.disabled = !collabReady;
            collabJoinBtn.addEventListener('click', () => {
                void connectCollab();
            });
        }

        if (collabChatSendBtn && collabChatInputEl) {
            collabChatSendBtn.addEventListener('click', () => {
                const text = String(collabChatInputEl.value || '').trim();
                if (!text || !collabController) return;
                collabController.sendMessage(text).catch((err) => console.error('Chat send failed', err));
                collabChatInputEl.value = '';
            });
            collabChatInputEl.addEventListener('keydown', (event) => {
                if (event.key !== 'Enter' || event.shiftKey) return;
                event.preventDefault();
                collabChatSendBtn.click();
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
            collabReserveBtn.addEventListener('click', () => {
                if (!collabController) return;
                if (cameraSync?.isOwner?.()) {
                    void collabController.releaseCamera();
                } else {
                    void collabController.claimCamera();
                }
            });
        }

        if (collabStatusEl && !collabReady) {
            collabStatusEl.textContent = 'config';
        }

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
        let activeRoomModelUrl = '';

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

        async function uploadModelToRoom(file) {
            if (!collabController || !file) return null;
            const supabase = collabController.supabase;
            const bucket = supabase.storage.from('models');
            const safeName = String(file.name || 'model.zip').replace(/\s+/g, '_');
            const path = `rooms/${collabController.room.id}/${Date.now()}-${safeName}`;
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
                const url = await uploadModelToRoom(file);
                if (!url) return false;
                activeRoomModelUrl = url;
                const meta = {
                    size: file.size || 0,
                    type: file.type || '',
                    kind: getModelKindFromName(file.name),
                    lastModified: file.lastModified || null,
                };
                await collabController.supabase
                    .from('rooms')
                    .update({
                        model_url: url,
                        model_name: file.name || 'model.zip',
                        model_meta: meta,
                    })
                    .eq('id', collabController.room.id);
                return true;
            } catch (err) {
                console.error('Model sync failed', err);
                return false;
            } finally {
                setStatusMessage('');
            }
        }

        async function loadModelFromRoom(room) {
            if (!room || !room.model_url || isRemoteModelLoad) return;
            const url = room.model_url;
            if (url === activeRoomModelUrl) return;
            activeRoomModelUrl = url;
            const name = room.model_name || url.split('/').pop() || 'model.zip';
            const kind = room.model_meta?.kind || getModelKindFromName(name);
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
            } catch (err) {
                console.error('Room model load failed', err);
            } finally {
                isRemoteModelLoad = false;
                setStatusMessage('');
            }
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
