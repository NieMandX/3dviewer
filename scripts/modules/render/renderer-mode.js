export async function detectRendererMode(options = {}) {
    const forced =
        options.forcedRendererMode ??
        (typeof globalThis !== 'undefined' ? globalThis.__LPMVIEW_RENDERER : undefined);
    const locationSearch =
        options.locationSearch ??
        (typeof window !== 'undefined' ? window.location?.search || '' : '');
    const navigatorGpu =
        options.navigatorGpu ??
        (typeof navigator !== 'undefined' && navigator ? navigator.gpu || null : null);
    const webgpuSupported =
        options.webgpuSupported ??
        !!navigatorGpu;
    const requestAdapter =
        typeof options.requestAdapter === 'function'
            ? options.requestAdapter
            : (typeof navigatorGpu?.requestAdapter === 'function'
                ? navigatorGpu.requestAdapter.bind(navigatorGpu)
                : null);
    const loadWebGPUModule =
        typeof options.loadWebGPUModule === 'function'
            ? options.loadWebGPUModule
            : () => import('three/webgpu');
    const loadTSLModule =
        typeof options.loadTSLModule === 'function'
            ? options.loadTSLModule
            : () => import('three/tsl');

    let requestedRendererMode = 'auto';
    if (forced) {
        requestedRendererMode = String(forced).toLowerCase();
    } else if (typeof locationSearch === 'string' && locationSearch) {
        const param = new URLSearchParams(locationSearch).get('renderer');
        if (param) requestedRendererMode = String(param).toLowerCase();
    }

    let activeRendererMode = 'webgl';
    if (requestedRendererMode === 'webgl') {
        activeRendererMode = 'webgl';
    } else if (requestedRendererMode === 'webgpu') {
        activeRendererMode = webgpuSupported ? 'webgpu' : 'webgl';
    } else {
        activeRendererMode = webgpuSupported ? 'webgpu' : 'webgl';
    }

    let useWebGPU = activeRendererMode === 'webgpu';
    let WebGPURendererCtor = null;
    let webgpuModuleError = null;
    let rendererModeNote = '';
    let backfaceNodeSupport = null;
    let webgpuModule = null;

    if (useWebGPU) {
        try {
            if (requestAdapter) {
                const adapter = await requestAdapter();
                if (!adapter) {
                    throw new Error('WebGPU adapter not available');
                }
            }
            const mod = await loadWebGPUModule();
            webgpuModule = mod;
            WebGPURendererCtor = mod.WebGPURenderer || mod.default || null;
            if (!WebGPURendererCtor) {
                throw new Error('WebGPURenderer export not found');
            }
            activeRendererMode = 'webgpu';
        } catch (err) {
            console.warn('WebGPU module load failed', err);
            webgpuModuleError = err;
            useWebGPU = false;
            activeRendererMode = 'webgl';
            rendererModeNote = 'fallback: init failed';
        }
    }

    if (useWebGPU) {
        try {
            const [webgpuMod, tslMod] = await Promise.all([
                webgpuModule ? Promise.resolve(webgpuModule) : loadWebGPUModule(),
                loadTSLModule(),
            ]);

            if (webgpuMod?.MeshBasicNodeMaterial && tslMod?.normalView && tslMod?.positionViewDirection && tslMod?.float && tslMod?.vec3) {
                backfaceNodeSupport = {
                    MeshBasicNodeMaterial: webgpuMod.MeshBasicNodeMaterial,
                    normalView: tslMod.normalView,
                    positionViewDirection: tslMod.positionViewDirection,
                    floatNode: tslMod.float,
                    vec3Node: tslMod.vec3,
                };
            }
        } catch (err) {
            console.warn('Backface node support init failed', err);
            backfaceNodeSupport = null;
        }
    }

    if (!useWebGPU && requestedRendererMode === 'webgpu' && !rendererModeNote) {
        rendererModeNote = 'fallback: unsupported';
    }

    return {
        requestedRendererMode,
        activeRendererMode,
        useWebGPU,
        WebGPURendererCtor,
        webgpuModuleError,
        rendererModeNote,
        backfaceNodeSupport,
    };
}
