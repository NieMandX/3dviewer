export function createRenderLoopController(options = {}) {
    const controls = options.controls || null;
    const renderer = options.renderer || null;
    const scene = options.scene || null;
    const camera = options.camera || null;

    const isWebGPU = !!options.isWebGPU;
    const getRendererReady = typeof options.getRendererReady === 'function' ? options.getRendererReady : () => true;

    const updateStatsOverlay = typeof options.updateStatsOverlay === 'function' ? options.updateStatsOverlay : () => {};
    const onFrame = typeof options.onFrame === 'function' ? options.onFrame : () => {};
    const onError = typeof options.onError === 'function' ? options.onError : null;

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
    let rafToken = 0;
    const hasAnimationLoop = typeof renderer?.setAnimationLoop === 'function';

    function requestRender() {
        if (!running && !hasAnimationLoop && !raf) return;
        needsRender = true;
    }

    function getFpsEstimate() {
        return fpsEstimate;
    }

    function getLastRenderStats() {
        return lastRenderStats;
    }

    function reportLoopError(err, phase = 'frame') {
        stop();
        if (onError) {
            try {
                onError(err, { phase });
            } catch (handlerErr) {
                console.error('Render loop error handler failed', handlerErr);
            }
        } else {
            console.error(`Render loop stopped during ${phase}`, err);
        }
    }

    function updateStatsSafely() {
        try {
            updateStatsOverlay();
        } catch (err) {
            reportLoopError(err, 'stats');
        }
    }

    function scheduleNextFrame() {
        if (hasAnimationLoop || !raf || !running || rafToken) return;
        rafToken = raf(animate);
    }

    function animate() {
        if (!running) return;
        rafToken = 0;
        scheduleNextFrame();

        const now = timeNow();
        if (!lastFrameTime) lastFrameTime = now;
        const delta = now - lastFrameTime;
        lastFrameTime = now;

        try {
            const controlsChanged = controls?.update?.();
            if (controlsChanged) needsRender = true;
        } catch (err) {
            reportLoopError(err, 'controls');
            return;
        }

        try {
            onFrame();
        } catch (err) {
            reportLoopError(err, 'frame');
            return;
        }

        if (isWebGPU && !getRendererReady()) {
            updateStatsSafely();
            return;
        }

        const xrPresenting = !!renderer?.xr?.isPresenting;

        if (!needsRender && !xrPresenting) {
            updateStatsSafely();
            return;
        }

        if (delta > 0 && delta < 1000) {
            const instant = 1000 / delta;
            fpsEstimate = fpsEstimate ? (fpsEstimate * 0.9 + instant * 0.1) : instant;
        }

        needsRender = false;
        try {
            renderer?.render?.(scene, camera);
        } catch (err) {
            needsRender = true;
            reportLoopError(err, 'render');
            return;
        }

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

        updateStatsSafely();
    }

    function start() {
        if (running) return;
        running = true;
        if (hasAnimationLoop) {
            renderer.setAnimationLoop(animate);
            return;
        }
        scheduleNextFrame();
        needsRender = true;
    }

    function stop() {
        running = false;
        if (rafToken && cancelRaf) {
            cancelRaf(rafToken);
        }
        rafToken = 0;
        if (hasAnimationLoop) {
            renderer.setAnimationLoop(null);
        }
    }

    return {
        requestRender,
        start,
        stop,
        dispose: stop,
        getFpsEstimate,
        getLastRenderStats,
    };
}
