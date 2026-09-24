import * as THREE from 'three';

// Reuse the application renderer; no second WebGL context or animation loop.
export function createMaterialThumbnails({ renderer, ready, getEnvironment, requestRender }) {
    const scene = new THREE.Scene(); scene.background = new THREE.Color('#e6e9ed');
    scene.add(new THREE.HemisphereLight(0xffffff, 0x697280, 3));
    const key = new THREE.DirectionalLight(0xffffff, 4); key.position.set(2, 3, 4); scene.add(key);
    const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 20); camera.position.set(0, 0, 4);
    const sphere = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 20)); scene.add(sphere);
    const placeholder = sphere.material;
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), new THREE.MeshStandardMaterial({ color: 0xb8bec7, roughness: 0.8 })); floor.rotation.x = -Math.PI / 2; floor.position.y = -1.05; scene.add(floor);
    const target = new THREE.WebGLRenderTarget(128, 128, { type: THREE.UnsignedByteType, format: THREE.RGBAFormat });
    const queue = new Map(); let busy = false, disposed = false;
    async function next() {
        if (busy || disposed || !queue.size) return;
        busy = true;
        const [image, material] = queue.entries().next().value; queue.delete(image);
        let preview;
        try {
            await ready;
            if (disposed || !image.isConnected) return;
            preview = new THREE.MeshPhysicalMaterial();
            if (material.isMeshPhysicalMaterial) THREE.MeshPhysicalMaterial.prototype.copy.call(preview, material);
            else if (material.isMeshStandardMaterial) THREE.MeshStandardMaterial.prototype.copy.call(preview, material);
            else { preview.color.copy(material.color || new THREE.Color('white')); preview.map = material.map || null; }
            preview.userData = {}; preview.envMap = null;
            sphere.material = preview; scene.environment = getEnvironment?.() || null;
            const oldTarget = renderer.getRenderTarget(), oldAuto = renderer.autoClear;
            const viewport = renderer.getViewport(new THREE.Vector4()), scissor = renderer.getScissor(new THREE.Vector4()), scissorTest = renderer.getScissorTest();
            try {
                renderer.setRenderTarget(target); renderer.autoClear = true; renderer.setViewport(0, 0, 128, 128); renderer.setScissorTest(false);
                renderer.render(scene, camera);
            } finally {
                renderer.setRenderTarget(oldTarget); renderer.autoClear = oldAuto; renderer.setViewport(viewport); renderer.setScissor(scissor); renderer.setScissorTest(scissorTest); requestRender();
            }
            const pixels = renderer.isWebGPURenderer ? await renderer.readRenderTargetPixelsAsync(target, 0, 0, 128, 128)
                : await renderer.readRenderTargetPixelsAsync(target, 0, 0, 128, 128, new Uint8Array(128 * 128 * 4));
            if (disposed || !image.isConnected || queue.has(image)) return;
            const canvas = document.createElement('canvas'); canvas.width = canvas.height = 128;
            const ctx = canvas.getContext('2d'), data = ctx.createImageData(128, 128);
            for (let y = 0; y < 128; y++) data.data.set(pixels.subarray(y * 512, (y + 1) * 512), (renderer.isWebGPURenderer ? y : 127 - y) * 512);
            ctx.putImageData(data, 0, 0); image.src = canvas.toDataURL();
        } catch (error) { if (!disposed) console.warn('Material thumbnail:', error.message); }
        finally { preview?.dispose(); busy = false; if (disposed) target.dispose(); else if (queue.size) setTimeout(next, 0); }
    }
    const observer = new IntersectionObserver((items) => { for (const item of items) if (item.isIntersecting) { const material = item.target._thumbnailMaterial; observer.unobserve(item.target); queue.set(item.target, material); next(); } }, { rootMargin: '100px' });
    return {
        enqueue(image, material) { image._thumbnailMaterial = material; observer.observe(image); },
        clear() { observer.disconnect(); queue.clear(); },
        dispose() { disposed = true; observer.disconnect(); queue.clear(); sphere.geometry.dispose(); placeholder.dispose(); floor.geometry.dispose(); floor.material.dispose(); if (!busy) target.dispose(); },
    };
}
