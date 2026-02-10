import { createShadowController } from '../render/shadow-controller.js';
import { createShadowDebugPanelController } from '../ui/shadow-debug-panel.js';
import { createSunToggleController } from '../ui/sun-toggle.js';
import { createSceneFramingController } from './framing.js';
import { createSunController } from './sun-controller.js';

export function createSunShadowsController(options = {}) {
    const THREE = options.THREE || null;
    const app = options.app || null;
    const scene = options.scene || null;
    const world = options.world || null;
    const camera = options.camera || null;
    const controls = options.controls || null;
    const renderer = options.renderer || null;
    const dirLight = options.dirLight || null;
    const northGrid = options.northGrid || null;

    const requestRender = typeof options.requestRender === 'function' ? options.requestRender : () => {};
    const layout = typeof options.layout === 'function' ? options.layout : () => {};
    const getBgMesh = typeof options.getBgMesh === 'function' ? options.getBgMesh : () => null;

    const latitude = Number.isFinite(options.latitude) ? options.latitude : 0;
    const longitude = Number.isFinite(options.longitude) ? options.longitude : 0;

    const getDay = typeof options.getDay === 'function' ? options.getDay : () => 1;
    const getMonth = typeof options.getMonth === 'function' ? options.getMonth : () => 6;
    const getHour = typeof options.getHour === 'function' ? options.getHour : () => 12;
    const getNorthDeg = typeof options.getNorthDeg === 'function' ? options.getNorthDeg : () => 0;

    const sunEnabledEl = options.sunEnabledEl || null;
    const sunControlsEl = options.sunControlsEl || null;
    const root = options.root || (typeof document !== 'undefined' ? document : null);

    if (!THREE) throw new Error('createSunShadowsController: THREE is required');

    const sceneFraming = createSceneFramingController({
        THREE,
        world,
        camera,
        controls,
        renderer,
        requestRender,
        getBgMesh,
    });

    function computeSceneBounds(rootObj = world) {
        return sceneFraming.computeSceneBounds(rootObj);
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
        latitude,
        longitude,
        getDay,
        getMonth,
        getHour,
        getNorthDeg,
        computeSceneBounds,
        fitSunShadowToScene,
        requestRender,
    });

    createShadowDebugPanelController({
        root,
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

    createSunToggleController({
        root,
        app,
        sunEnabledEl,
        sunControlsEl,
        renderer,
        dirLight,
        layout,
        requestRender,
        onEnable: () => {
            updateSun();
            fitSunShadowToScene();
        },
    });

    return Object.freeze({
        sceneFraming,
        shadowController,
        updateSun,
        fitSunShadowToScene,
        setShadowDebug,
        computeSceneBounds,
        focusOn,
        fitAll,
        computeWorldCenter,
    });
}
