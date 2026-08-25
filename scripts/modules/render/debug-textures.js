export function createDebugTextureProvider(options = {}) {
    const THREE = options.THREE || null;
    const renderer = options.renderer || null;
    const textureLoader = options.textureLoader || (THREE ? new THREE.TextureLoader() : null);
    const checkerUrl = (typeof options.checkerUrl === 'string' && options.checkerUrl) ? options.checkerUrl : '';
    const requestRender = typeof options.requestRender === 'function' ? options.requestRender : () => {};

    let matcapTexture = null;
    let materialColorMatcapTexture = null;
    let checkerTexture = null;
    let disposed = false;
    let renderBurstToken = 0;
    let renderBurstFramesLeft = 0;

    const raf =
        typeof globalThis !== 'undefined' && typeof globalThis.requestAnimationFrame === 'function'
            ? globalThis.requestAnimationFrame.bind(globalThis)
            : null;
    const cancelRaf =
        typeof globalThis !== 'undefined' && typeof globalThis.cancelAnimationFrame === 'function'
            ? globalThis.cancelAnimationFrame.bind(globalThis)
            : null;

    function requestRenderBurst(frameCount = 12) {
        requestRender();
        if (!raf || disposed) return;
        renderBurstFramesLeft = Math.max(renderBurstFramesLeft, Math.max(0, Math.floor(frameCount) - 1));
        if (renderBurstToken) return;
        const tick = () => {
            renderBurstToken = 0;
            if (disposed || renderBurstFramesLeft <= 0) return;
            renderBurstFramesLeft -= 1;
            requestRender();
            if (renderBurstFramesLeft > 0) {
                renderBurstToken = raf(tick);
            }
        };
        renderBurstToken = raf(tick);
    }

    function getMatcap() {
        if (disposed) return null;
        if (!THREE || !textureLoader) return null;
        if (matcapTexture) return matcapTexture;
        const texture = textureLoader.load(
            'https://raw.githubusercontent.com/nidorx/matcaps/1b1e43a338335b6401034d48488298966755d717/1024/2A2A2A_B3B3B3_6D6D6D_848C8C.png',
            () => {
                if (disposed) {
                    texture.dispose?.();
                    return;
                }
                if (texture && 'colorSpace' in texture && THREE.SRGBColorSpace) {
                    texture.colorSpace = THREE.SRGBColorSpace;
                }
                requestRenderBurst();
            }
        );
        matcapTexture = texture;
        return matcapTexture;
    }

    function getMaterialColorMatcap() {
        if (disposed || !THREE) return null;
        if (materialColorMatcapTexture) return materialColorMatcapTexture;

        const size = 64;
        const data = new Uint8Array(size * size * 4);
        for (let y = 0; y < size; y += 1) {
            for (let x = 0; x < size; x += 1) {
                const nx = ((x + 0.5) / size) * 2 - 1;
                const ny = ((y + 0.5) / size) * 2 - 1;
                const radiusSq = Math.min(1, nx * nx + ny * ny);
                const facing = Math.sqrt(Math.max(0, 1 - radiusSq));
                const directional = (ny - nx) * 0.08;
                const shade = Math.max(0.2, Math.min(1, 0.2 + facing * 0.8 + directional));
                const value = Math.round(shade * 255);
                const offset = (y * size + x) * 4;
                data[offset] = value;
                data[offset + 1] = value;
                data[offset + 2] = value;
                data[offset + 3] = 255;
            }
        }

        const texture = new THREE.DataTexture(
            data,
            size,
            size,
            THREE.RGBAFormat,
            THREE.UnsignedByteType,
        );
        texture.name = 'Viewer Material Color Matcap';
        texture.minFilter = THREE.LinearFilter;
        texture.magFilter = THREE.LinearFilter;
        texture.generateMipmaps = false;
        texture.colorSpace = THREE.LinearSRGBColorSpace;
        texture.needsUpdate = true;
        materialColorMatcapTexture = texture;
        return materialColorMatcapTexture;
    }

    function getChecker() {
        if (disposed) return null;
        if (!THREE) return null;
        if (checkerTexture) return checkerTexture;

        const applyCommonProps = (tex) => {
            if (!tex) return;
            tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
            if ('colorSpace' in tex && THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
            const maxAniso = renderer?.capabilities?.getMaxAnisotropy?.();
            tex.anisotropy = maxAniso || 1;
        };

        const makeCanvasCheckerTexture = () => {
            const S = 256;
            const N = 8;

            const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
            if (!canvas) return null;

            canvas.width = canvas.height = S;
            const g = canvas.getContext('2d');
            if (!g) return null;

            for (let y = 0; y < N; y++) {
                for (let x = 0; x < N; x++) {
                    g.fillStyle = ((x + y) & 1) ? '#bbbbbb' : '#222222';
                    g.fillRect((x * S) / N, (y * S) / N, S / N, S / N);
                }
            }

            const tex = new THREE.CanvasTexture(canvas);
            applyCommonProps(tex);
            return tex;
        };

        // Prefer project UV grid if present; fallback to canvas checker (works offline / without asset).
        if (checkerUrl && textureLoader?.load) {
            const texture = textureLoader.load(
                checkerUrl,
                () => {
                    if (disposed) {
                        texture.dispose?.();
                        return;
                    }
                    applyCommonProps(texture);
                    requestRenderBurst();
                },
                undefined,
                () => {
                    if (disposed) {
                        texture.dispose?.();
                        return;
                    }
                    // Если ассет не загрузился — подменяем изображение на canvas-checker в уже выданной текстуре.
                    const fallback = makeCanvasCheckerTexture();
                    if (!fallback) return;
                    texture.image = fallback.image;
                    fallback.dispose?.();
                    applyCommonProps(texture);
                    texture.needsUpdate = true;
                    requestRenderBurst();
                }
            );
            checkerTexture = texture;
            applyCommonProps(checkerTexture);
            return checkerTexture;
        }

        checkerTexture = makeCanvasCheckerTexture();
        return checkerTexture;
    }

    function dispose() {
        disposed = true;
        renderBurstFramesLeft = 0;
        if (renderBurstToken) {
            try { cancelRaf?.(renderBurstToken); } catch (_) {}
            renderBurstToken = 0;
        }
        matcapTexture?.dispose?.();
        materialColorMatcapTexture?.dispose?.();
        checkerTexture?.dispose?.();
        matcapTexture = null;
        materialColorMatcapTexture = null;
        checkerTexture = null;
    }

    function getDiagnostics() {
        return {
            disposed,
            matcapLoaded: !!matcapTexture,
            materialColorMatcapLoaded: !!materialColorMatcapTexture,
            checkerLoaded: !!checkerTexture,
            renderBurst: {
                scheduled: !!renderBurstToken,
                framesLeft: renderBurstFramesLeft,
            },
        };
    }

    return {
        getMatcap,
        getMaterialColorMatcap,
        getChecker,
        getDiagnostics,
        dispose,
    };
}
