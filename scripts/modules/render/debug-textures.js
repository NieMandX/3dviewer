export function createDebugTextureProvider(options = {}) {
    const THREE = options.THREE || null;
    const renderer = options.renderer || null;
    const textureLoader = options.textureLoader || (THREE ? new THREE.TextureLoader() : null);

    let matcapTexture = null;
    let checkerTexture = null;

    function getMatcap() {
        if (!THREE || !textureLoader) return null;
        if (matcapTexture) return matcapTexture;
        matcapTexture = textureLoader.load(
            'https://raw.githubusercontent.com/nidorx/matcaps/1b1e43a338335b6401034d48488298966755d717/1024/2A2A2A_B3B3B3_6D6D6D_848C8C.png'
        );
        return matcapTexture;
    }

    function getChecker() {
        if (!THREE) return null;
        if (checkerTexture) return checkerTexture;

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

        checkerTexture = new THREE.CanvasTexture(canvas);
        checkerTexture.wrapS = checkerTexture.wrapT = THREE.RepeatWrapping;

        const maxAniso = renderer?.capabilities?.getMaxAnisotropy?.();
        checkerTexture.anisotropy = maxAniso || 1;

        return checkerTexture;
    }

    return {
        getMatcap,
        getChecker,
    };
}

