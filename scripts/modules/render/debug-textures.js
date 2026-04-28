export function createDebugTextureProvider(options = {}) {
    const THREE = options.THREE || null;
    const renderer = options.renderer || null;
    const textureLoader = options.textureLoader || (THREE ? new THREE.TextureLoader() : null);
    const checkerUrl = (typeof options.checkerUrl === 'string' && options.checkerUrl) ? options.checkerUrl : '';
    const requestRender = typeof options.requestRender === 'function' ? options.requestRender : () => {};

    let matcapTexture = null;
    let checkerTexture = null;
    let disposed = false;

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
                requestRender();
            }
        );
        matcapTexture = texture;
        return matcapTexture;
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
                    requestRender();
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
                    requestRender();
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
        matcapTexture?.dispose?.();
        checkerTexture?.dispose?.();
        matcapTexture = null;
        checkerTexture = null;
    }

    return {
        getMatcap,
        getChecker,
        dispose,
    };
}
