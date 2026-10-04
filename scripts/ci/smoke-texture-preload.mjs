import assert from 'node:assert/strict';

export async function runTexturePreloadSmoke(browser, baseUrl) {
    const page = await browser.newPage();
    try {
        await page.goto(`${baseUrl}/__smoke_blank`);
        const result = await page.evaluate(async () => {
            const { createTexturePreloader } = await import('/scripts/modules/render/texture-preload.js');
            const T = await import('three');
            const check = (condition, message) => { if (!condition) throw Error(message); };
            const fake = name => ({ name, image: { width: 4, height: 4 } });
            const a = fake('a'), b = fake('b'), c = fake('c');
            let releaseReady, current = true, disposed = false;
            const calls = [];
            const preloader = createTexturePreloader({
                ready: new Promise(resolve => { releaseReady = resolve; }), isDisposed: () => disposed,
                renderer: { initTexture(texture) { calls.push(texture.name); if (texture === a) setTimeout(() => { current = false; }, 0); } },
            });
            const loading = preloader.prepare([a,a,b,c], () => current);
            await new Promise(resolve => setTimeout(resolve, 5));
            check(calls.length === 0, 'uploaded before renderer init'); releaseReady(); await loading;
            check(calls.join() === 'a', 'upload did not yield or ignored stale generation');
            current = true; disposed = true; await preloader.prepare([b]);
            check(calls.join() === 'a', 'uploaded after app disposal'); preloader.dispose();
            const canceledCalls = [];
            const canceled = createTexturePreloader({ renderer: {initTexture: t => canceledCalls.push(t)} });
            const pending = canceled.prepare([a,b]); await Promise.resolve(); canceled.dispose(); await pending;
            check(canceledCalls.length === 0, 'pending timer survived preloader disposal');
            const failed = createTexturePreloader({renderer: {initTexture() { throw Error('upload failed'); }}});
            check(await failed.prepare([a]).then(()=>false,e=>e.message==='upload failed'), 'upload error swallowed'); failed.dispose();

            // Real GPU resource creation must preserve rendered pixels and release
            // its allocations through the normal Texture.dispose lifecycle.
            const renderer = new T.WebGLRenderer({antialias:false, preserveDrawingBuffer:true}); renderer.setSize(32,32);
            const scene = new T.Scene(), camera = new T.OrthographicCamera(-1,1,1,-1,.1,10); camera.position.z=2;
            const canvas = document.createElement('canvas'); canvas.width=canvas.height=4;
            const ctx=canvas.getContext('2d'); ctx.fillStyle='#336699'; ctx.fillRect(0,0,4,4); ctx.fillStyle='#ddaa44'; ctx.fillRect(0,0,2,2);
            const texture = new T.CanvasTexture(canvas), geometry = new T.PlaneGeometry(2,2);
            const material = new T.MeshBasicMaterial({map:texture}); scene.add(new T.Mesh(geometry,material));
            const pixels = () => { renderer.render(scene,camera); const p=new Uint8Array(32*32*4); const gl=renderer.getContext(); gl.readPixels(0,0,32,32,gl.RGBA,gl.UNSIGNED_BYTE,p); return p; };
            const before = pixels(); texture.dispose();
            const real = createTexturePreloader({renderer}); await real.prepare([texture,texture]);
            const after = pixels(); check(before.every((v,i)=>v===after[i]), 'preloading changes pixels');
            check(renderer.info.memory.textures===1, 'duplicate upload allocated another texture');
            texture.dispose(); check(renderer.info.memory.textures===0, 'preloaded texture leaked');
            real.dispose(); geometry.dispose(); material.dispose(); renderer.dispose();
            return true;
        });
        assert.equal(result, true);
    } finally { await page.close(); }
}
