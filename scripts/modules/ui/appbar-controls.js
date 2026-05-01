export function createAppbarControlsController(options = {}) {
    const statsBtn = options.statsBtn || null;
    const gridToggleBtn = options.gridToggleBtn || null;
    const resetViewerBtn = options.resetViewerBtn || null;
    const resetViewBtn = options.resetViewBtn || null;
    const fullscreenBtn = options.fullscreenBtn || null;

    const documentRef = options.document || (typeof document !== 'undefined' ? document : null);
    const windowRef = options.window || (typeof window !== 'undefined' ? window : null);

    const setStatsVisible = typeof options.setStatsVisible === 'function' ? options.setStatsVisible : () => {};
    const isStatsVisible = typeof options.isStatsVisible === 'function' ? options.isStatsVisible : () => false;

    const setGridVisible = typeof options.setGridVisible === 'function' ? options.setGridVisible : () => {};
    const isGridVisible = typeof options.isGridVisible === 'function' ? options.isGridVisible : () => false;

    const initialStatsVisible = typeof options.initialStatsVisible === 'boolean' ? options.initialStatsVisible : true;
    const initialGridVisible = typeof options.initialGridVisible === 'boolean' ? options.initialGridVisible : true;

    const listeners = [];
    let disposed = false;

    function addListener(target, type, handler, options) {
        if (!target?.addEventListener) return;
        target.addEventListener(type, handler, options);
        listeners.push({ target, type, handler, options });
    }

    function toggleFullscreen() {
        if (disposed) return;
        if (!documentRef) return;
        const elem = documentRef.documentElement;
        if (!elem) return;

        const fullscreenEl = documentRef.fullscreenElement || documentRef.webkitFullscreenElement;
        if (!fullscreenEl) {
            if (elem.requestFullscreen) elem.requestFullscreen();
            else if (elem.webkitRequestFullscreen) elem.webkitRequestFullscreen();
            return;
        }

        if (documentRef.exitFullscreen) documentRef.exitFullscreen();
        else if (documentRef.webkitExitFullscreen) documentRef.webkitExitFullscreen();
    }

    function resetViewer() {
        if (disposed) return;
        if (typeof options.onReset === 'function') {
            options.onReset();
            return;
        }
        windowRef?.location?.reload?.();
    }

    function resetView() {
        if (disposed) return;
        if (typeof options.onResetView === 'function') {
            options.onResetView();
        }
    }

    function toggleStats() {
        if (disposed) return;
        setStatsVisible(!isStatsVisible());
    }

    function toggleGrid() {
        if (disposed) return;
        setGridVisible(!isGridVisible());
    }

    function handleFullscreenClick() {
        if (disposed) return;
        if (typeof options.onToggleFullscreen === 'function') {
            options.onToggleFullscreen();
            return;
        }
        toggleFullscreen();
    }

    addListener(statsBtn, 'click', toggleStats);
    addListener(gridToggleBtn, 'click', toggleGrid);
    addListener(resetViewerBtn, 'click', resetViewer);
    addListener(resetViewBtn, 'click', resetView);
    addListener(fullscreenBtn, 'click', handleFullscreenClick);

    setStatsVisible(initialStatsVisible);
    setGridVisible(initialGridVisible);

    function dispose() {
        if (disposed) return;
        disposed = true;
        while (listeners.length) {
            const { target, type, handler, options } = listeners.pop();
            try { target.removeEventListener(type, handler, options); } catch (_) {}
        }
    }

    return Object.freeze({
        dispose,
        resetViewer,
        resetView,
        toggleFullscreen,
    });
}
