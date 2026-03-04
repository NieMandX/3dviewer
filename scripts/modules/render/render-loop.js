export function createRenderLoopController(options = {}) {
    const controls = options.controls || null;
    const renderer = options.renderer || null;
    const scene = options.scene || null;
    const camera = options.camera || null;

    const isWebGPU = !!options.isWebGPU;
    const getRendererReady = typeof options.getRendererReady === 'function' ? options.getRendererReady : () => true;

    const updateStatsOverlay = typeof options.updateStatsOverlay === 'function' ? options.updateStatsOverlay : () => {};
    const onFrame = typeof options.onFrame === 'function' ? options.onFrame : () => {};

    const raf =
        typeof options.requestAnimationFrame === 'function'
            ? options.requestAnimationFrame
            : (typeof globalThis !== 'undefined' && typeof globalThis.requestAnimationFrame === 'function'
                ? globalThis.requestAnimationFrame.bind(globalThis)
                : null);

    function timeNow() {
        if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
            return performance.now();
        }
        return Date.now();
    }

    let running = false;
    let needsRender = true;
    let fpsEstimate = 0;
    let lastFrameTime = 0;
    let lastRenderStats = null;
    const hasAnimationLoop = typeof renderer?.setAnimationLoop === 'function';

    function requestRender() {
        needsRender = true;
    }

    function getFpsEstimate() {
        return fpsEstimate;
    }

    function getLastRenderStats() {
        return lastRenderStats;
    }

    function animate() {
        if (!running) return;
        if (!hasAnimationLoop && raf) raf(animate);

        const now = timeNow();
        if (!lastFrameTime) lastFrameTime = now;
        const delta = now - lastFrameTime;
        lastFrameTime = now;

        const controlsChanged = controls?.update?.();
        if (controlsChanged) needsRender = true;

        onFrame();

        if (isWebGPU && !getRendererReady()) {
            updateStatsOverlay();
            return;
        }

        if (!needsRender) {
            updateStatsOverlay();
            return;
        }

        if (delta > 0 && delta < 1000) {
            const instant = 1000 / delta;
            fpsEstimate = fpsEstimate ? (fpsEstimate * 0.9 + instant * 0.1) : instant;
        }

        needsRender = false;
        renderer?.render?.(scene, camera);

        const info = renderer?.info || {};
        lastRenderStats = {
            render: info.render ? { ...info.render } : {},
            memory: info.memory ? { ...info.memory } : {},
            programs:
                info.programs != null
                    ? (Array.isArray(info.programs) ? info.programs.length : info.programs)
                    : 0,
        };

        if (info.reset && renderer?.info && renderer.info.autoReset === false) {
            info.reset();
        }

        updateStatsOverlay();
    }

    function start() {
        if (running) return;
        running = true;
        if (hasAnimationLoop) {
            renderer.setAnimationLoop(animate);
            return;
        }
        animate();
    }

    function stop() {
        running = false;
        if (hasAnimationLoop) {
            renderer.setAnimationLoop(null);
        }
    }

    return {
        requestRender,
        start,
        stop,
        getFpsEstimate,
        getLastRenderStats,
    };
}
