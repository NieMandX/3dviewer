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

    let rendererReady = !useWebGPU;
    let rendererInitPromise = Promise.resolve();

    if (useWebGPU && typeof renderer.init === 'function') {
        rendererInitPromise = renderer.init()
            .then(() => {
                rendererReady = true;
                requestRender();
            })
            .catch((err) => {
                console.error('WebGPU init failed', err);
                setStatusMessage('⚠️ WebGPU: не удалось инициализировать рендерер.');
            });
    } else if (useWebGPU) {
        rendererReady = true;
    }

    if ('shadowMap' in renderer) {
        renderer.shadowMap.enabled = true;
        if (renderer.shadowMap && 'type' in renderer.shadowMap) {
            renderer.shadowMap.type = THREE.PCFSoftShadowMap;
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

    return Object.freeze({
        renderer,
        rendererInitPromise,
        getRendererReady: () => rendererReady,
    });
}

