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
    const getChecker = typeof options.getChecker === 'function' ? options.getChecker : () => null;

    let currentShadingMode = (typeof options.initialMode === 'string' && options.initialMode) ? options.initialMode : 'pbr';
    let disposed = false;

    const MATERIAL_PRESERVE_FLAGS = [
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
        return material;
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

        const color = (orig.color && orig.color.isColor)
            ? orig.color.clone()
            : new THREE.Color(0xffffff);

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

    function asMaterialArray(value) {
        if (!value) return [];
        return Array.isArray(value) ? value.filter(Boolean) : [value];
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
            world?.traverse?.(o => { if (o.isMesh) clearBeautyWire(o); });
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
                const variants = origArray.map(m => makeVariantFrom(m, mode));
                obj.material = variants.length === 1 ? variants[0] : variants;
            }
        });

        if (mode === 'pbr') {
            applyEnvToMaterials(scene?.environment || null, parseFloat(getEnvIntensity()) || 1.0);
            applyGlassControlsToScene();
        }

        requestRender();
        scheduleOnce();
        return true;
    }

    function getCurrentMode() {
        return currentShadingMode;
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
        disposeUI();
    }

    return {
        applyShading,
        getCurrentMode,
        bindUI,
        disposeUI,
        dispose,
    };
}
