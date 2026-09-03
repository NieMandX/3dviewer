import { asMaterialArray } from '../material/texture-utils.js';
import { getMaterialSourceBaseColor } from '../material/base-color-policy.js';

export function createShadingController(options = {}) {
    const THREE = options.THREE || null;
    const world = options.world || null;
    const scene = options.scene || null;

    const requestRender = typeof options.requestRender === 'function' ? options.requestRender : () => {};
    const schedulePanelRefresh =
        typeof options.schedulePanelRefresh === 'function' ? options.schedulePanelRefresh : () => {};

    const useWebGPU = !!options.useWebGPU;

    const clearWireframeOverlay =
        typeof options.clearWireframeOverlay === 'function' ? options.clearWireframeOverlay : () => {};
    const ensureWireframeOverlay =
        typeof options.ensureWireframeOverlay === 'function' ? options.ensureWireframeOverlay : () => {};

    const clearBeautyWire =
        typeof options.clearBeautyWire === 'function' ? options.clearBeautyWire : () => {};
    const ensureBeautyWire =
        typeof options.ensureBeautyWire === 'function' ? options.ensureBeautyWire : () => {};
    const beautyWireAngleDeg = Number.isFinite(options.beautyWireAngleDeg) ? options.beautyWireAngleDeg : 45;

    const setBackfaceMode = typeof options.setBackfaceMode === 'function' ? options.setBackfaceMode : () => {};

    const applyEnvToMaterials =
        typeof options.applyEnvToMaterials === 'function' ? options.applyEnvToMaterials : () => {};
    const applyGlassControlsToScene =
        typeof options.applyGlassControlsToScene === 'function' ? options.applyGlassControlsToScene : () => {};
    const getEnvIntensity = typeof options.getEnvIntensity === 'function' ? options.getEnvIntensity : () => 1.0;

    const getMatcap = typeof options.getMatcap === 'function' ? options.getMatcap : () => null;
    const getMaterialColorMatcap =
        typeof options.getMaterialColorMatcap === 'function' ? options.getMaterialColorMatcap : () => null;
    const getChecker = typeof options.getChecker === 'function' ? options.getChecker : () => null;

    let currentShadingMode = (typeof options.initialMode === 'string' && options.initialMode) ? options.initialMode : 'pbr';
    let disposed = false;
    let textureRenderBurstToken = 0;
    let textureRenderBurstFramesLeft = 0;

    const textureRenderBurstFrames = (() => {
        const value = Number(options.textureRenderBurstFrames);
        return Number.isFinite(value) && value > 0 ? Math.min(30, Math.floor(value)) : 12;
    })();

    const raf =
        typeof options.requestAnimationFrame === 'function'
            ? options.requestAnimationFrame
            : (typeof globalThis !== 'undefined' && typeof globalThis.requestAnimationFrame === 'function'
                ? globalThis.requestAnimationFrame.bind(globalThis)
                : null);
    const cancelRaf =
        typeof options.cancelAnimationFrame === 'function'
            ? options.cancelAnimationFrame
            : (typeof globalThis !== 'undefined' && typeof globalThis.cancelAnimationFrame === 'function'
                ? globalThis.cancelAnimationFrame.bind(globalThis)
                : null);

    const MATERIAL_PRESERVE_FLAGS = [
        'mapUnderlay',
        'annotationRoot',
        'annotationLayer',
        'annotationStroke',
        'annotationFill',
        'annotationLabel',
        'annotationPin',
    ];

    function shouldPreserveMeshMaterial(obj) {
        let current = obj;
        while (current) {
            const userData = current.userData || null;
            if (MATERIAL_PRESERVE_FLAGS.some((flag) => !!userData?.[flag])) return true;
            if (userData?.annotationRect) return true;
            current = current.parent || null;
        }
        return false;
    }

    function restorePreservedMeshMaterial(obj) {
        if (!obj?.isMesh) return;
        clearBeautyWire(obj);
        clearWireframeOverlay(obj);
        if (obj.userData?._origMaterial) {
            obj.material = obj.userData._origMaterial;
        }
    }

    /**
     * Возвращает материал-вариант для режима отображения.
     * В режиме PBR возвращаем исходный материал, в остальных — создаём clone подходящего типа.
     */
    function markGeneratedShadingVariant(material) {
        if (material?.userData) {
            material.userData.viewerGeneratedMaterial = 'shading-variant';
        }
        if (material) material.needsUpdate = true;
        return material;
    }

    function textureNeedsRefresh(texture) {
        return !!(texture?.isTexture && texture.image);
    }

    function collectMaterialTexturesForRefresh(material, target) {
        if (!material || !target) return;
        [
            material.map,
            material.matcap,
            material.alphaMap,
            material.roughnessMap,
            material.metalnessMap,
        ].forEach((texture) => {
            if (textureNeedsRefresh(texture)) target.add(texture);
        });
    }

    function refreshTextureMaterials(materials, textures) {
        asMaterialArray(materials).forEach((material) => {
            if (!material) return;
            material.needsUpdate = true;
            collectMaterialTexturesForRefresh(material, textures);
        });
    }

    function modeMayNeedTextureRenderBurst(mode) {
        return (
            mode === 'basic'
            || mode === 'matcap'
            || mode === 'materialColor'
            || mode === 'uv'
            || mode === 'roughOnly'
            || mode === 'metalOnly'
        );
    }

    function cancelTextureRenderBurst() {
        textureRenderBurstFramesLeft = 0;
        if (!textureRenderBurstToken) return;
        try { cancelRaf?.(textureRenderBurstToken); } catch (_) {}
        textureRenderBurstToken = 0;
    }

    function requestTextureRenderBurst() {
        requestRender();
        if (!raf || disposed || textureRenderBurstFrames <= 1) return;
        textureRenderBurstFramesLeft = Math.max(textureRenderBurstFramesLeft, textureRenderBurstFrames - 1);
        if (textureRenderBurstToken) return;

        const tick = () => {
            textureRenderBurstToken = 0;
            if (disposed || textureRenderBurstFramesLeft <= 0) return;
            textureRenderBurstFramesLeft -= 1;
            requestRender();
            if (textureRenderBurstFramesLeft > 0) {
                textureRenderBurstToken = raf(tick);
            }
        };
        textureRenderBurstToken = raf(tick);
    }

    function makeVariantFrom(orig, mode) {
        if (!THREE) return orig;

        // Общие параметры, включая поддержку альфа
        const common = {
            side: THREE.FrontSide,
            transparent: orig.transparent || !!orig.alphaMap,
            alphaTest: 0.3,
            // depthWrite: false,
            opacity: orig.opacity ?? 1,
            alphaMap: orig.alphaMap || null,
        };

        const color = getMaterialSourceBaseColor(orig) || new THREE.Color(0xffffff);

        const map = orig.map || null;

        switch (mode) {
            case 'normal':
                // у NormalMaterial нет alphaMap, но можно сохранить прозрачность
                return markGeneratedShadingVariant(new THREE.MeshNormalMaterial({
                    side: common.side,
                    transparent: common.transparent,
                    opacity: common.opacity,
                    flatShading: false,
                }));

            case 'basic':
                return markGeneratedShadingVariant(new THREE.MeshBasicMaterial({
                    ...common,
                    color: map ? 0xffffff : color,
                    map,
                }));

            case 'materialColor':
                return markGeneratedShadingVariant(new THREE.MeshMatcapMaterial({
                    side: orig.side ?? THREE.FrontSide,
                    color,
                    matcap: getMaterialColorMatcap(),
                    transparent: !!orig.transparent || Number(orig.opacity ?? 1) < 1,
                    opacity: orig.opacity ?? 1,
                    depthWrite: orig.depthWrite !== false,
                    depthTest: orig.depthTest !== false,
                    toneMapped: false,
                }));

            case 'materialColorMask':
                return markGeneratedShadingVariant(new THREE.MeshBasicMaterial({
                    side: orig.side ?? THREE.FrontSide,
                    color,
                    transparent: !!orig.transparent || Number(orig.opacity ?? 1) < 1,
                    opacity: orig.opacity ?? 1,
                    depthWrite: orig.depthWrite !== false,
                    depthTest: orig.depthTest !== false,
                    toneMapped: false,
                }));

            case 'wire':
                return markGeneratedShadingVariant(new THREE.MeshBasicMaterial({
                    ...common,
                    color: 0x666666,
                    wireframe: true,
                    transparent: true,
                    opacity: 0.3,
                }));

            case 'matcap':
                return markGeneratedShadingVariant(new THREE.MeshMatcapMaterial({
                    ...common,
                    color: 0xffffff,
                    matcap: getMatcap(),
                }));

            case 'xray':
                return markGeneratedShadingVariant(new THREE.MeshBasicMaterial({
                    ...common,
                    color: 0x8844ff,
                    transparent: true,
                    opacity: 0.5,
                    depthWrite: false,
                }));

            case 'uv':
                return markGeneratedShadingVariant(new THREE.MeshBasicMaterial({
                    ...common,
                    color: 0xffffff,
                    map: getChecker(),
                }));

            case 'roughOnly': {
                const tex = orig.roughnessMap || null;
                if (tex) return markGeneratedShadingVariant(new THREE.MeshBasicMaterial({ ...common, color: 0xffffff, map: tex }));
                const v = Math.max(0, Math.min(1, Number(orig.roughness ?? 0.5)));
                const c = new THREE.Color().setScalar(v);
                return markGeneratedShadingVariant(new THREE.MeshBasicMaterial({ ...common, color: c }));
            }

            case 'metalOnly': {
                const tex = orig.metalnessMap || null;
                if (tex) return markGeneratedShadingVariant(new THREE.MeshBasicMaterial({ ...common, color: 0xffffff, map: tex }));
                const v = Math.max(0, Math.min(1, Number(orig.metalness ?? 0.0)));
                const c = new THREE.Color().setScalar(v);
                return markGeneratedShadingVariant(new THREE.MeshBasicMaterial({ ...common, color: c }));
            }

            default:
                return orig; // режим PBR оставляем без изменений
        }
    }

    function disposeCurrentShadingVariant(obj) {
        if (!obj?.material || !obj.userData?._origMaterial) return;
        const originalSet = new Set(asMaterialArray(obj.userData._origMaterial));
        asMaterialArray(obj.material).forEach((material) => {
            if (!material || originalSet.has(material)) return;
            if (
                material === obj.userData._bfFront ||
                material === obj.userData._bfBack ||
                material === obj.userData._wireBase ||
                material === obj.userData._beautyBase
            ) {
                return;
            }
            material.dispose?.();
        });
    }

    function applyShading(mode, afterRender) {
        if (disposed) return false;
        currentShadingMode = mode;

        let panelScheduled = false;
        const scheduleOnce = () => {
            if (panelScheduled) return;
            schedulePanelRefresh(afterRender);
            panelScheduled = true;
            afterRender = undefined;
        };

        if (useWebGPU && mode !== 'wire') {
            world?.traverse?.(o => { if (o.isMesh) clearWireframeOverlay(o); });
        }

        // backface — отдельный режим (двухпроходный), его не делаем через makeVariantFrom
        if (mode === 'backface') {
            // если ранее был включён beautywire — выключаем его при входе в backface
            world?.traverse?.(o => {
                if (!o.isMesh) return;
                disposeCurrentShadingVariant(o);
                clearBeautyWire(o);
            });
            setBackfaceMode(true);
            requestRender();
            scheduleOnce();
            return true;
        } else {
            // выходим из backface при любом другом режиме
            setBackfaceMode(false);
        }

        if (mode === 'beautywire') {
            // включаем beautywire у всех мешей
            world?.traverse?.(o => {
                if (o.userData?.isCollision) return; // не переписывать материал коллизий
                if (!o.isMesh) return;
                disposeCurrentShadingVariant(o);
                if (shouldPreserveMeshMaterial(o)) {
                    restorePreservedMeshMaterial(o);
                    return;
                }
                ensureBeautyWire(o, beautyWireAngleDeg);
            });
            requestRender();
            scheduleOnce();
            return true;
        } else {
            // выходим из beautywire, если он был включён
            world?.traverse?.(o => { if (o.isMesh) clearBeautyWire(o); });
        }

        if (mode === 'wire' && useWebGPU) {
            world?.traverse?.(o => {
                if (o.userData?.isCollision) return;
                if (!o.isMesh) return;
                disposeCurrentShadingVariant(o);
                if (shouldPreserveMeshMaterial(o)) {
                    restorePreservedMeshMaterial(o);
                    return;
                }
                ensureWireframeOverlay(o);
            });
            requestRender();
            scheduleOnce();
            return true;
        }

        const textureRefreshSet = new Set();
        const needsTextureRenderBurst = modeMayNeedTextureRenderBurst(mode);

        world?.traverse?.(obj => {
            if (obj.userData?.isCollision) return; // не переписывать материал коллизий
            if (!obj.isMesh || !obj.material) return;
            if (shouldPreserveMeshMaterial(obj)) {
                restorePreservedMeshMaterial(obj);
                return;
            }
            if (!obj.userData._origMaterial) obj.userData._origMaterial = obj.material;
            const origArray = Array.isArray(obj.userData._origMaterial) ? obj.userData._origMaterial : [obj.userData._origMaterial];
            disposeCurrentShadingVariant(obj);
            if (mode === 'pbr') {
                obj.material = obj.userData._origMaterial;
            } else {
                const variants = origArray.map((m) => {
                    const variant = makeVariantFrom(m, mode);
                    if (variant && variant !== m) variant.visible = m.visible !== false;
                    return variant;
                });
                obj.material = variants.length === 1 ? variants[0] : variants;
            }
            if (needsTextureRenderBurst) refreshTextureMaterials(obj.material, textureRefreshSet);
        });

        textureRefreshSet.forEach((texture) => {
            texture.needsUpdate = true;
        });

        if (mode === 'pbr') {
            applyEnvToMaterials(scene?.environment || null, parseFloat(getEnvIntensity()) || 1.0);
            applyGlassControlsToScene();
        }

        if (needsTextureRenderBurst) requestTextureRenderBurst();
        else requestRender();
        scheduleOnce();
        return true;
    }

    function getCurrentMode() {
        return currentShadingMode;
    }

    function getDiagnostics() {
        return {
            disposed,
            mode: currentShadingMode,
            textureRenderBurst: {
                scheduled: !!textureRenderBurstToken,
                framesLeft: textureRenderBurstFramesLeft,
                configuredFrames: textureRenderBurstFrames,
            },
        };
    }

    const uiListeners = [];
    function addUIListener(target, type, handler, options) {
        if (!target?.addEventListener) return;
        target.addEventListener(type, handler, options);
        uiListeners.push({ target, type, handler, options });
    }

    function disposeUI() {
        while (uiListeners.length) {
            const { target, type, handler, options } = uiListeners.pop();
            try { target.removeEventListener(type, handler, options); } catch (_) {}
        }
    }

    function bindUI(ui = {}) {
        if (disposed) return;
        const shadingSel = ui.shadingSel || null;
        disposeUI();
        addUIListener(shadingSel, 'change', () => applyShading(shadingSel.value));
    }

    function dispose() {
        if (disposed) return;
        disposed = true;
        cancelTextureRenderBurst();
        disposeUI();
    }

    return {
        applyShading,
        getCurrentMode,
        getDiagnostics,
        bindUI,
        disposeUI,
        dispose,
    };
}
