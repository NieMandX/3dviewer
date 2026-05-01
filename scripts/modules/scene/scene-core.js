import { createBackgroundController } from '../render/background-controller.js';
import { createRenderer } from '../render/renderer-init.js';
import { createWASDFlightController } from '../render/wasd-flight.js';
import { createSceneGeometryStats } from './geometry-stats.js';

export function createSceneCore(options = {}) {
    const THREE = options.THREE || null;
    const OrbitControls = options.OrbitControls || null;

    const app = options.app || null;
    const rootEl = options.rootEl || null;

    const requestRender = typeof options.requestRender === 'function' ? options.requestRender : () => {};
    const setStatusMessage = typeof options.setStatusMessage === 'function' ? options.setStatusMessage : () => {};

    const useWebGPU = !!options.useWebGPU;
    const WebGPURendererCtor = options.WebGPURendererCtor || null;

    const bg = options.background || {};
    const isEnvironmentEnabled =
        typeof bg.isEnvironmentEnabled === 'function' ? bg.isEnvironmentEnabled : () => false;
    const getAlpha = typeof bg.getAlpha === 'function' ? bg.getAlpha : () => 1;

    const bgAlphaEl = bg.bgAlphaEl || null;
    const bgToggleBtn = bg.bgToggleBtn || null;
    const body = bg.body || (typeof document !== 'undefined' ? document.body : null);

    if (!THREE) throw new Error('createSceneCore: THREE is required');

    const scene = new THREE.Scene();
    const world = new THREE.Group();
    scene.add(world);

    const sceneGeometryStats = createSceneGeometryStats({ world });
    function markSceneStatsDirty() {
        sceneGeometryStats?.markDirty?.();
    }
    function getSceneGeometryStats() {
        return sceneGeometryStats?.getStats?.() || { triangles: 0 };
    }

    const whiteClearColor = new THREE.Color().setRGB(1.5, 1.5, 1.5);

    const camera = new THREE.PerspectiveCamera(60, 1, 0.01, 5000);
    camera.position.set(0, 1.5, -5);

    const rendererInit = createRenderer({
        THREE,
        rootEl,
        useWebGPU,
        WebGPURendererCtor,
        requestRender,
        setStatusMessage,
    });
    const renderer = rendererInit.renderer;
    const rendererInitPromise = rendererInit.rendererInitPromise;
    const getRendererReady = rendererInit.getRendererReady;

    const backgroundController = createBackgroundController({
        THREE,
        renderer,
        scene,
        camera,
        app,
        requestRender,
        isEnvironmentEnabled,
        getAlpha,
        bgAlphaEl,
        bgToggleBtn,
        whiteClearColor,
        body,
    });

    let controls = null;
    let onControlsChange = null;
    if (OrbitControls) {
        controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        onControlsChange = () => requestRender();
        controls.addEventListener('change', onControlsChange);
    }

    const flightControls = createWASDFlightController({
        THREE,
        camera,
        controls,
        requestRender,
        window: options.window || null,
        document: options.document || null,
    });

    const hemiLight = new THREE.HemisphereLight(0xffffff, 0xcfd8dc, 1);
    scene.add(hemiLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 10.0);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.set(4096, 4096);
    dirLight.shadow.bias = -0.0005;
    dirLight.shadow.normalBias = 0.02;
    dirLight.position.set(3, 5, 4);
    scene.add(dirLight);
    dirLight.target.name = dirLight.target.name || 'SunLightTarget';
    dirLight.target.userData.excludeFromBounds = true;
    scene.add(dirLight.target);

    let disposed = false;

    function disposeLightShadow(light) {
        const shadow = light?.shadow || null;
        if (!shadow) return;

        let shadowDisposeSucceeded = false;
        try {
            if (typeof shadow.dispose === 'function') {
                shadow.dispose();
                shadowDisposeSucceeded = true;
            }
        } catch (_) {}
        if (!shadowDisposeSucceeded) {
            try { shadow.map?.dispose?.(); } catch (_) {}
            try { shadow.mapPass?.dispose?.(); } catch (_) {}
        }
        if (shadow.map) shadow.map = null;
        if (shadow.mapPass) shadow.mapPass = null;
    }

    function dispose() {
        if (disposed) return;
        disposed = true;
        if (controls && onControlsChange) {
            try {
                controls.removeEventListener('change', onControlsChange);
            } catch (_) {}
        }
        try {
            controls?.dispose?.();
        } catch (_) {}
        try {
            flightControls?.dispose?.();
        } catch (_) {}
        try {
            backgroundController?.dispose?.();
        } catch (_) {}
        disposeLightShadow(dirLight);
        try {
            scene.remove(world, hemiLight, dirLight, dirLight.target);
        } catch (_) {}
        try {
            rendererInit?.dispose?.();
        } catch (_) {}
    }

    return Object.freeze({
        scene,
        world,
        camera,
        renderer,
        rendererInitPromise,
        getRendererReady,
        backgroundController,
        controls,
        flightControls,
        hemiLight,
        dirLight,
        markSceneStatsDirty,
        getSceneGeometryStats,
        dispose,
    });
}
