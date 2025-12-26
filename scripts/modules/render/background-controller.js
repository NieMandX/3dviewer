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

    function resolveAlpha() {
        const parsed = Number.parseFloat(getAlpha());
        if (!Number.isFinite(parsed)) return 1;
        return Math.min(1, Math.max(0, parsed));
    }

    function getBgMesh() {
        return bgMesh;
    }

    function ensureBgMesh() {
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
        bgMesh.position.copy(camera.position);
        return bgMesh;
    }

    function updateVisibility() {
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
        setMode(bgMode === 'black' ? 'white' : 'black');
    }

    function syncToCamera() {
        if (!bgMesh || !camera) return;
        bgMesh.position.copy(camera.position);
    }

    if (bgToggleBtn && options.attachToggleButton !== false) {
        bgToggleBtn.addEventListener('click', toggleMode);
    }
    if (bgAlphaEl && options.attachAlphaInput !== false) {
        const handleAlphaInput = () => updateVisibility();
        bgAlphaEl.addEventListener('input', handleAlphaInput);
        bgAlphaEl.addEventListener('change', handleAlphaInput);
    }

    setMode(bgMode);

    return {
        ensureBgMesh,
        getBgMesh,
        updateVisibility,
        setMode,
        getMode,
        toggleMode,
        syncToCamera,
    };
}
