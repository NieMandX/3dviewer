export function createLayoutController(options = {}) {
    const root = options.root || (typeof document !== 'undefined' ? document : null);
    const win = options.window || (typeof window !== 'undefined' ? window : null);

    const renderer = options.renderer || null;
    const camera = options.camera || null;

    const requestRender = typeof options.requestRender === 'function' ? options.requestRender : () => {};
    const toggleSideBtn = options.toggleSideBtn || null;

    let lastW = 0;
    let lastH = 0;
    let disposed = false;

    function layout() {
        if (disposed) return;
        if (!renderer || !camera || !root) return;

        const appbar = root.querySelector?.('.appbar');
        const appH = Math.ceil(appbar?.getBoundingClientRect?.().height || 48);
        root.body?.style?.setProperty?.('--appbarH', appH + 'px');

        const camsBar = root.getElementById?.('camsBar') || root.querySelector?.('#camsBar');
        const camsH =
            camsBar && !camsBar.hidden
                ? Math.ceil(camsBar.getBoundingClientRect?.().height || 0)
                : 0;
        root.body?.style?.setProperty?.('--camsBarH', camsH + 'px');

        const w = Math.max(1, win?.innerWidth || 1);
        const h = Math.max(1, win?.innerHeight || 1);
        if (w !== lastW || h !== lastH) {
            lastW = w;
            lastH = h;
            renderer.setSize(w, h);
            camera.aspect = w / h;
            camera.updateProjectionMatrix();
            requestRender();
        }
    }

    function hideSidePanel() {
        if (disposed) return;
        if (!root?.body) return;
        if (!root.body.classList.contains('side-hidden')) {
            root.body.classList.add('side-hidden');
            try { layout(); } catch (_) {}
        }
    }

    function onToggleSideClick() {
        if (disposed) return;
        root?.body?.classList?.toggle?.('side-hidden');
        layout();
    }

    function dispose() {
        if (disposed) return;
        disposed = true;
        win?.removeEventListener?.('resize', layout);
        toggleSideBtn?.removeEventListener?.('click', onToggleSideClick);
    }

    win?.addEventListener?.('resize', layout);
    toggleSideBtn?.addEventListener?.('click', onToggleSideClick);

    return {
        layout,
        hideSidePanel,
        dispose,
    };
}
