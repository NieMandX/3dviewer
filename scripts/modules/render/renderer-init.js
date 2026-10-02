export function createRenderer(options = {}) {
    const THREE = options.THREE || null;
    const rootEl = options.rootEl || null;
    const useWebGPU = !!options.useWebGPU;
    const WebGPURendererCtor = options.WebGPURendererCtor || null;

    const requestRender = typeof options.requestRender === 'function' ? options.requestRender : () => {};
    const setStatusMessage = typeof options.setStatusMessage === 'function' ? options.setStatusMessage : () => {};

    if (!THREE) throw new Error('createRenderer: THREE is required');

    const renderer = useWebGPU && WebGPURendererCtor
        ? new WebGPURendererCtor({ antialias: true })
        : new THREE.WebGLRenderer({ antialias: true });

    if (renderer.info && Object.prototype.hasOwnProperty.call(renderer.info, 'autoReset')) {
        renderer.info.autoReset = false;
    }

    let disposed = false;
    let disposePromise = null;
    let rendererReady = !useWebGPU;
    let rendererInitError = null;
    let rendererInitPromise = Promise.resolve();
    let rendererInitialized = !(useWebGPU && typeof renderer.init === 'function');

    if (useWebGPU && typeof renderer.init === 'function') {
        rendererInitPromise = renderer.init()
            .then(() => {
                rendererInitialized = true;
                if (disposed) return;
                rendererReady = true;
                rendererInitError = null;
                requestRender();
            })
            .catch((err) => {
                if (disposed) return;
                rendererInitError = err instanceof Error ? err : new Error(err?.message || String(err || 'WebGPU init failed'));
                rendererReady = false;
                console.error('WebGPU init failed', err);
                setStatusMessage('⚠️ WebGPU: не удалось инициализировать рендерер.');
                throw rendererInitError;
            });
        rendererInitPromise.catch(() => {});
    } else if (useWebGPU) {
        rendererReady = true;
    }

    if ('shadowMap' in renderer) {
        renderer.shadowMap.enabled = true;
        if (renderer.shadowMap && 'type' in renderer.shadowMap) {
            renderer.shadowMap.type = THREE.PCFShadowMap;
        }
    }

    if (typeof devicePixelRatio === 'number' && renderer.setPixelRatio) {
        renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    }
    if ('outputColorSpace' in renderer) renderer.outputColorSpace = THREE.SRGBColorSpace;
    if ('toneMapping' in renderer) renderer.toneMapping = THREE.NoToneMapping;
    if ('toneMappingExposure' in renderer) renderer.toneMappingExposure = 1.0;

    if (rootEl?.appendChild && renderer.domElement) {
        rootEl.appendChild(renderer.domElement);
    }

    function dispose() {
        if (disposePromise) return disposePromise;
        disposed = true;
        rendererReady = false;
        try { renderer.domElement?.remove?.(); } catch (_) {}
        // r186 WebGPU disposal is asynchronous and only frees an initialized
        // backend. A late init must finish before we release its resources.
        disposePromise = (async () => {
            if (useWebGPU) await rendererInitPromise.catch(() => {});
            try {
                if (rendererInitialized) {
                    await renderer.setAnimationLoop?.(null);
                    await renderer.dispose?.();
                } else {
                    // r186 Renderer.dispose() calls setAnimationLoop(), which
                    // retries failed init and can reject without a handler.
                    // Only the partial backend exists when init has failed.
                    await renderer.backend?.dispose?.();
                }
            } catch (error) {
                console.warn('Renderer cleanup failed', error);
            } finally {
                try { renderer.forceContextLoss?.(); } catch (_) {}
            }
        })();
        return disposePromise;
    }

    return Object.freeze({
        renderer,
        rendererInitPromise,
        getRendererReady: () => rendererReady,
        getRendererError: () => rendererInitError,
        dispose,
    });
}
