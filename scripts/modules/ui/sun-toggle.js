export function createSunToggleController(options = {}) {
    const root = options.root || (typeof document !== 'undefined' ? document : null);
    const app = options.app || null;

    const sunEnabledEl = options.sunEnabledEl || null;
    const sunControlsEl = options.sunControlsEl || null;

    const renderer = options.renderer || null;
    const dirLight = options.dirLight || null;

    const layout = typeof options.layout === 'function' ? options.layout : () => {};
    const requestRender = typeof options.requestRender === 'function' ? options.requestRender : () => {};

    const onEnable = typeof options.onEnable === 'function' ? options.onEnable : () => {};
    const onDisable = typeof options.onDisable === 'function' ? options.onDisable : () => {};
    const isDirectionalShadowSuppressed =
        typeof options.isDirectionalShadowSuppressed === 'function'
            ? options.isDirectionalShadowSuppressed
            : () => false;

    let enabled = typeof options.initialEnabled === 'boolean'
        ? options.initialEnabled
        : (sunEnabledEl?.checked ?? true);

    let sunAnchor = null;
    if (sunControlsEl && sunControlsEl.parentNode) {
        sunAnchor = root?.createComment?.('sun-controls-anchor') || null;
        if (sunAnchor) sunControlsEl.parentNode.insertBefore(sunAnchor, sunControlsEl);
    }

    function mountControls() {
        if (!sunControlsEl || !sunAnchor) return;
        if (sunControlsEl.isConnected) return;
        sunAnchor.replaceWith(sunControlsEl);
        try { layout(); } catch (_) {}
    }

    function unmountControls() {
        if (!sunControlsEl || !sunControlsEl.isConnected) return;
        if (!sunAnchor) return;
        sunControlsEl.parentNode.insertBefore(sunAnchor, sunControlsEl);
        sunControlsEl.remove();
        try { layout(); } catch (_) {}
    }

    function setEnabled(on) {
        enabled = !!on;
        if (sunEnabledEl && sunEnabledEl.checked !== enabled) {
            sunEnabledEl.checked = enabled;
        }
        if (app?.sun) {
            app.sun.enabled = enabled;
        }

        if (dirLight) {
            dirLight.visible = enabled;
            dirLight.castShadow = enabled && !isDirectionalShadowSuppressed();
        }
        if (renderer?.shadowMap) {
            renderer.shadowMap.enabled = enabled;
        }

        if (enabled) {
            mountControls();
            onEnable();
        } else {
            unmountControls();
            onDisable();
        }

        requestRender();
    }

    function isEnabled() {
        return enabled;
    }

    sunEnabledEl?.addEventListener('change', (e) => {
        setEnabled(!!e.target?.checked);
    });

    setEnabled(enabled);

    return {
        setEnabled,
        isEnabled,
        mountControls,
        unmountControls,
    };
}
