export function createLayoutController(options = {}) {
    const root = options.root || (typeof document !== 'undefined' ? document : null);
    const win = options.window || (typeof window !== 'undefined' ? window : null);

    const renderer = options.renderer || null;
    const camera = options.camera || null;

    const requestRender = typeof options.requestRender === 'function' ? options.requestRender : () => {};
    const toggleSideBtn = options.toggleSideBtn || null;

    function layout() {
        if (!renderer || !camera || !root) return;

        const appbar = root.querySelector?.('.appbar');
        const appH = Math.ceil(appbar?.getBoundingClientRect?.().height || 48);
        root.body?.style?.setProperty?.('--appbarH', appH + 'px');

        const w = Math.max(1, win?.innerWidth || 1);
        const h = Math.max(1, win?.innerHeight || 1);
        renderer.setSize(w, h);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        requestRender();
    }

    function hideSidePanel() {
        if (!root?.body) return;
        if (!root.body.classList.contains('side-hidden')) {
            root.body.classList.add('side-hidden');
            try { layout(); } catch (_) {}
        }
    }

    win?.addEventListener?.('resize', layout);
    toggleSideBtn?.addEventListener?.('click', () => {
        root?.body?.classList?.toggle?.('side-hidden');
        layout();
    });

    return {
        layout,
        hideSidePanel,
    };
}

