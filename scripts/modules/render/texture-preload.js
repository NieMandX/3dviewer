// Preload a material's ready images before publishing it to the scene, so one
// render does not have to upload an entire building's textures synchronously.
export function createTexturePreloader({ renderer, ready = Promise.resolve(), isDisposed = () => false }) {
    let disposed = false;
    const waits = new Map();
    const isLive = current => !disposed && !isDisposed() && current();
    const yieldTask = () => new Promise(resolve => {
        const timer = setTimeout(() => { waits.delete(timer); resolve(); }, 0);
        waits.set(timer, resolve);
    });
    return {
        async prepare(textures, isCurrent = () => true) {
            if (!renderer?.initTexture || !isLive(isCurrent)) return;
            await ready;
            for (const texture of new Set(textures)) {
                if (!isLive(isCurrent)) return;
                const image = texture?.image;
                if (!image || !image.width || !image.height || image.complete === false) continue;
                await yieldTask();
                if (!isLive(isCurrent)) return;
                renderer.initTexture(texture);
            }
        },
        dispose() {
            disposed = true;
            for (const [timer, resolve] of waits) { clearTimeout(timer); resolve(); }
            waits.clear();
        },
    };
}
