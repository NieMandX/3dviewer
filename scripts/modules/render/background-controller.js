export function createBackgroundController(options = {}) {
    const THREE = options.THREE || null;
    const renderer = options.renderer || null;
    const scene = options.scene || null;
    const camera = options.camera || null;
    const app = options.app || null;

    const requestRender = typeof options.requestRender === 'function' ? options.requestRender : () => {};
    const isEnvironmentEnabled =
        typeof options.isEnvironmentEnabled === 'function' ? options.isEnvironmentEnabled : () => false;
    const getAlpha = typeof options.getAlpha === 'function' ? options.getAlpha : () => 1;

    const bgToggleBtn = options.bgToggleBtn || null;
    const bgAlphaEl = options.bgAlphaEl || null;
    const body = options.body || (typeof document !== 'undefined' ? document.body : null);

    const whiteClearColor = options.whiteClearColor || null;

    let bgMesh = null;
    let bgMode = options.initialMode === 'black' ? 'black' : 'white';
    let disposed = false;
    const worldCameraPos = THREE ? new THREE.Vector3() : null;
    const listeners = [];

    function addListener(target, type, handler, options) {
        if (!target?.addEventListener || typeof handler !== 'function') return;
        target.addEventListener(type, handler, options);
        listeners.push({ target, type, handler, options });
    }

    function resolveAlpha() {
        const parsed = Number.parseFloat(getAlpha());
        if (!Number.isFinite(parsed)) return 1;
        return Math.min(1, Math.max(0, parsed));
    }

    function getBgMesh() {
        if (disposed) return null;
        return bgMesh;
    }

    function ensureBgMesh() {
        if (disposed) return null;
        if (bgMesh) return bgMesh;
        if (!THREE || !scene || !camera) return null;

        const resolvedAlpha = resolveAlpha();

        const geo = new THREE.SphereGeometry(100000, 64, 32);
        const mat = new THREE.MeshBasicMaterial({
            map: null,
            side: THREE.BackSide,
            depthWrite: false,
            toneMapped: false,
            transparent: true,
            opacity: resolvedAlpha,
        });
        bgMesh = new THREE.Mesh(geo, mat);
        if (app) app.bgMesh = bgMesh;
        bgMesh.userData.excludeFromBounds = true;
        bgMesh.frustumCulled = false;
        bgMesh.renderOrder = -1000;
        scene.add(bgMesh);
        if (worldCameraPos && typeof camera.getWorldPosition === 'function') {
            camera.getWorldPosition(worldCameraPos);
            bgMesh.position.copy(worldCameraPos);
        } else {
            bgMesh.position.copy(camera.position);
        }
        return bgMesh;
    }

    function updateVisibility() {
        if (disposed) return;
        if (!bgMesh) return;
        const alpha = resolveAlpha();
        const shouldShow = !!isEnvironmentEnabled() && (bgMode !== 'black' || alpha > 1e-6);
        bgMesh.visible = shouldShow;
        bgMesh.material.opacity = alpha;
        bgMesh.material.transparent = bgMesh.material.opacity < 0.999;
        bgMesh.material.needsUpdate = true;
        requestRender();
    }

    function applyModeUI() {
        if (disposed) return;
        if (bgToggleBtn) {
            bgToggleBtn.classList.toggle('active', bgMode === 'black');
            if (bgMode === 'black') {
                // Сейчас чёрный фон → кнопка предлагает переключиться на светлую тему.
                bgToggleBtn.title = 'Светлая тема';
                bgToggleBtn.setAttribute('aria-label', 'Светлая тема');
                bgToggleBtn.classList.remove('white-mode');
                bgToggleBtn.classList.add('black-mode');
            } else {
                // Сейчас белый фон → кнопка предлагает переключиться на тёмную тему.
                bgToggleBtn.title = 'Тёмная тема';
                bgToggleBtn.setAttribute('aria-label', 'Тёмная тема');
                bgToggleBtn.classList.remove('black-mode');
                bgToggleBtn.classList.add('white-mode');
            }
            bgToggleBtn.dataset.mode = bgMode;
        }
        if (body) {
            body.classList.toggle('bg-black', bgMode === 'black');
        }
    }

    function setMode(mode) {
        if (disposed) return;
        bgMode = mode === 'black' ? 'black' : 'white';

        if (bgMode === 'black') {
            if (typeof renderer?.setClearColor === 'function') {
                renderer.setClearColor(0x000000, 1);
            }
            if (scene) {
                if (scene.background) scene.background.set(0x000000);
                else if (THREE) scene.background = new THREE.Color(0x000000);
            }
        } else {
            if (typeof renderer?.setClearColor === 'function' && whiteClearColor?.clone) {
                renderer.setClearColor(whiteClearColor.clone(), 1);
            }
            if (scene) scene.background = null;
        }

        applyModeUI();
        updateVisibility();
        requestRender();
    }

    function getMode() {
        return bgMode;
    }

    function toggleMode() {
        if (disposed) return;
        setMode(bgMode === 'black' ? 'white' : 'black');
    }

    function syncToCamera() {
        if (disposed) return;
        if (!bgMesh || !camera) return;
        if (worldCameraPos && typeof camera.getWorldPosition === 'function') {
            camera.getWorldPosition(worldCameraPos);
            bgMesh.position.copy(worldCameraPos);
            return;
        }
        bgMesh.position.copy(camera.position);
    }

    if (bgToggleBtn && options.attachToggleButton !== false) {
        addListener(bgToggleBtn, 'click', toggleMode);
    }
    const handleAlphaInput = () => updateVisibility();
    if (bgAlphaEl && options.attachAlphaInput !== false) {
        addListener(bgAlphaEl, 'input', handleAlphaInput);
        addListener(bgAlphaEl, 'change', handleAlphaInput);
    }

    setMode(bgMode);

    function dispose() {
        if (disposed) return;
        disposed = true;
        while (listeners.length) {
            const { target, type, handler, options } = listeners.pop();
            try { target.removeEventListener(type, handler, options); } catch (_) {}
        }
        if (bgMesh) {
            bgMesh.parent?.remove?.(bgMesh);
            bgMesh.geometry?.dispose?.();
            bgMesh.material?.dispose?.();
            bgMesh = null;
        }
        if (app?.bgMesh) app.bgMesh = null;
    }

    return {
        ensureBgMesh,
        getBgMesh,
        updateVisibility,
        setMode,
        getMode,
        toggleMode,
        syncToCamera,
        dispose,
    };
}
