export function createStatsOverlayController(options = {}) {
    const statsBtn = options.statsBtn || null;
    const statsOverlayEl = options.statsOverlayEl || null;
    const renderer = options.renderer || null;
    const requestRender = typeof options.requestRender === 'function' ? options.requestRender : null;

    const getFpsEstimate = typeof options.getFpsEstimate === 'function' ? options.getFpsEstimate : () => 0;
    const getLastRenderStats = typeof options.getLastRenderStats === 'function' ? options.getLastRenderStats : () => null;
    const getSceneGeometryStats = typeof options.getSceneGeometryStats === 'function' ? options.getSceneGeometryStats : () => ({ triangles: 0 });
    const getRendererMode = typeof options.getRendererMode === 'function' ? options.getRendererMode : () => 'webgl';

    let visible = false;
    let lastUpdate = 0;

    function setVisible(nextVisible) {
        visible = !!nextVisible;
        statsBtn?.classList?.toggle?.('active', visible);
        if (statsOverlayEl) {
            statsOverlayEl.hidden = !visible;
            if (visible) {
                update(true);
                requestRender?.();
            }
        }
    }

    function isVisible() {
        return visible;
    }

    function update(force = false) {
        if (!visible || !statsOverlayEl || !renderer) return;
        const now = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
        if (!force && now - lastUpdate < 250) return;
        lastUpdate = now;

        const info = renderer.info || {};
        const lastRenderStats = getLastRenderStats();
        const renderInfo = lastRenderStats?.render || info.render || {};
        const formatInt = (value) => (typeof value === 'number' ? value.toLocaleString('ru-RU') : String(value ?? 0));

        const fpsEstimate = getFpsEstimate();
        const fpsText = fpsEstimate ? Math.round(fpsEstimate).toString() : '—';
        const sceneStats = getSceneGeometryStats();
        const modeLabel = String(getRendererMode() || 'webgl').toUpperCase();

        const items = [
            `<span class="stats-mode">${modeLabel}</span>`,
            `<span class="stats-item">fps ${fpsText}</span>`,
            `<span class="stats-item">draw calls ${formatInt(renderInfo.drawCalls ?? renderInfo.calls ?? 0)}</span>`,
            `<span class="stats-item">tris ${formatInt(sceneStats.triangles || 0)}</span>`,
        ];

        statsOverlayEl.innerHTML = items.join('<span class="stats-sep">|</span>');
    }

    return Object.freeze({
        setVisible,
        isVisible,
        update,
    });
}
