// Small real-renderer regression fixture, also runnable in a hardware browser.
export async function checkMaterialThumbnails({ device, webgpu = true } = {}) {
    const T = await import('three');
    const { createRenderer } = await import('../modules/render/renderer-init.js');
    const { createMaterialThumbnails } = await import('../modules/ui/material-thumbnails.js');
    const { createRiverMaterial } = await import('../modules/material/river-flow.js');
    const W = webgpu ? await import('three/webgpu') : null;
    const owner = createRenderer({
        THREE: T, useWebGPU: webgpu,
        WebGPURendererCtor: webgpu ? class extends W.WebGPURenderer {
            constructor(options) { super({ ...options, device }); }
        } : null,
    });
    const r = owner.renderer;
    await owner.rendererInitPromise;
    r.setPixelRatio(1); r.setSize(256, 256);
    Object.assign(r.domElement.style, { position: 'fixed', top: '8px', right: '144px', zIndex: '9999' });
    document.body.append(r.domElement);
    const gpu = r.backend?.device;
    const errors = [];
    const onError = (event) => errors.push(event.error.message);
    gpu?.addEventListener('uncapturederror', onError);
    const scene = new T.Scene(), camera = new T.PerspectiveCamera(40, 1, .1, 50);
    camera.position.z = 5;
    scene.background = new T.Color('#527a99');
    scene.add(new T.HemisphereLight(0xffffff, 0x444444, 3));
    const geometry = new T.SphereGeometry(1, 24, 16);
    const glass = new T.MeshPhysicalMaterial({ transmission: 1, roughness: .03, thickness: .2, side: T.DoubleSide });
    const solid = new T.MeshStandardMaterial({ color: '#b7753c', roughness: .6 });
    const sphere = new T.Mesh(geometry, glass); scene.add(sphere);
    const normal = new T.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1);
    const field = new T.DataTexture(new Uint8Array([255, 128, 255, 0]), 1, 1);
    normal.needsUpdate = field.needsUpdate = true;
    const waterBase = new T.MeshPhysicalMaterial({ normalMap: normal, transmission: .32, roughness: .055, thickness: .6, ior: 1.333 });
    const water = await createRiverMaterial(waterBase, field, { version: 2, origin: [-5, -5], extent: [10, 10], tileMeters: 1, metersPerSecond: 1, cycleSeconds: 3, specularColor: [1, 1, 1] }, webgpu);
    const waterSphere = new T.Mesh(geometry, water.material); waterSphere.position.x = -1.5; scene.add(waterSphere);
    const image = document.createElement('img'); image.width = image.height = 128;
    Object.assign(image.style, { position: 'fixed', top: '8px', right: '8px', zIndex: '9999' });
    document.body.append(image);
    const thumbnails = createMaterialThumbnails({ renderer: r, ready: owner.rendererInitPromise, getEnvironment: () => null, requestRender() {} });
    let thumbnailCount = 0;
    let scopeOpen = !!gpu;
    gpu?.pushErrorScope('validation');
    try {
        for (let i = 0; i < 6; i++) {
            water.time.value += .1;
            r.render(scene, camera);

            const material = [solid, glass, water.material][i % 3];
            material.needsUpdate = true;
            image.removeAttribute('src'); thumbnails.enqueue(image, material);
            for (let n = 0; n < 250 && !image.src.startsWith('data:image/png'); n++) await new Promise((resolve) => setTimeout(resolve, 20));
            if (!image.src.startsWith('data:image/png')) throw new Error('Thumbnail did not finish');
            thumbnailCount++;
            r.setSize(256 + i * 8, 256 + i * 8); r.render(scene, camera);
            thumbnails.clear();
        }
        const error = await gpu?.popErrorScope();
        scopeOpen = false;
        if (error) errors.push(error.message);
        return { errors, thumbnailCount, backend: gpu ? 'webgpu' : 'webgl', sceneDrawn: r.info.render.calls > 0,
            physicalMaterialsPreserved: glass.transmission === 1 && glass.opacity === 1 && water.material.transmission === .32 && water.material.opacity === 1,
            targetsRestored: r.getRenderTarget() === null && (!webgpu || r.getOutputRenderTarget() === null) };
    } finally {
        if (scopeOpen) await gpu.popErrorScope();
        thumbnails.dispose(); image.remove();
        geometry.dispose(); glass.dispose(); solid.dispose();
        water.material.dispose(); waterBase.dispose(); normal.dispose(); field.dispose();
        owner.dispose(); gpu?.removeEventListener('uncapturederror', onError);
    }
}
