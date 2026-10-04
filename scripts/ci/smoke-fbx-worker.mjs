import assert from 'node:assert/strict';

export async function runFBXWorkerSmoke(browser, baseUrl) {
    const page = await browser.newPage();
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    try {
        await page.goto(`${baseUrl}/__smoke_blank`);
        const result = await page.evaluate(async () => {
            const T = await import('three');
            const { FBXLoader } = await import('three/addons/loaders/FBXLoader.js');
            const { createFBXWorkerClient } = await import('/scripts/modules/workers/fbx-worker-client.js');
            const { serializeFBXTransfer } = await import('/scripts/modules/workers/fbx-transfer.js');
            const { parseFBXTransfer } = await import('/scripts/modules/workers/fbx-transfer-loader.js');
            const { createWorkerFBXFixture } = await import('/scripts/ci/fbx-worker-fixture.js');
            const check = (condition, message) => { if (!condition) throw Error(message); };
            const dispose = root => {
                const geometries = new Set(), materials = new Set(), textures = new Set(), skeletons = new Set();
                root.traverse(node => {
                    if (node.geometry) geometries.add(node.geometry);
                    if (node.skeleton) skeletons.add(node.skeleton);
                    for (const material of Array.isArray(node.material) ? node.material : [node.material]) if (material) {
                        materials.add(material);
                        for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
                    }
                });
                for (const resource of [...skeletons, ...geometries, ...textures, ...materials]) resource.dispose();
            };

            // Typed buffer transport: topology, skinning, morphs, clips and shared
            // resources survive; neither sender nor receiver copies vertex arrays.
            const root = new T.Group(), geometry = new T.BufferGeometry();
            geometry.setAttribute('position', new T.Float32BufferAttribute([0,0,0, 1,0,0, 0,1,0], 3));
            geometry.setAttribute('skinIndex', new T.Uint16BufferAttribute(new Uint16Array(12), 4));
            geometry.setAttribute('skinWeight', new T.Float32BufferAttribute([1,0,0,0, 1,0,0,0, 1,0,0,0], 4));
            geometry.setIndex([0,1,2]); geometry.addGroup(0,3,0); geometry.computeBoundingBox(); geometry.computeBoundingSphere();
            geometry.morphAttributes.position = [new T.Float32BufferAttribute([0,0,1, 0,0,1, 0,0,1], 3)]; geometry.morphTargetsRelative = true;
            const material = new T.MeshPhongMaterial({color: '#aa7755'});
            const mesh = new T.SkinnedMesh(geometry, material); mesh.name = 'Animated'; mesh.userData.sourceFBXModelId = '123';
            const bone = new T.Bone(); bone.name = 'RootBone'; mesh.add(bone); mesh.bind(new T.Skeleton([bone]));
            mesh.morphTargetInfluences[0] = .25; root.add(mesh, new T.Mesh(geometry, material));
            root.position.set(4,5,6); root.updateMatrixWorld(true);
            const clip = new T.AnimationClip('Move', 1, [new T.VectorKeyframeTrack('Animated.position', [0,1], [0,0,0, 2,0,0])]);
            clip.userData = { marker: 'preserve' }; root.animations.push(clip);
            const sourceArray = geometry.attributes.position.array;
            const packed = serializeFBXTransfer(root);
            check(packed.json.geometries[0].data.attributes.position.array === sourceArray, 'serialization copied vertices');
            check(!Object.hasOwn(geometry, 'toJSON') && !Object.hasOwn(clip, 'toJSON'), 'temporary serializers leaked');
            const received = structuredClone(packed.json, { transfer: packed.transfer });
            check(sourceArray.byteLength === 0, 'sender retained geometry buffers');
            const rebuilt = await parseFBXTransfer(received);
            const skin = rebuilt.getObjectByName('Animated');
            check(skin.geometry.attributes.position.array === received.geometries[0].data.attributes.position.array, 'receiver copied vertices');
            check(skin.geometry === rebuilt.children[1].geometry && skin.material === rebuilt.children[1].material, 'shared resources lost');
            check(skin.skeleton.bones[0] === skin.getObjectByName('RootBone'), 'skeleton rebound incorrectly');
            check(skin.geometry.index.array.join() === '0,1,2' && skin.geometry.groups[0].count === 3, 'topology changed');
            check(skin.morphTargetInfluences[0] === .25 && skin.geometry.morphTargetsRelative, 'morph state changed');
            check(skin.userData.sourceFBXModelId === '123' && rebuilt.position.equals(root.position), 'source ID or transforms lost');
            check(rebuilt.animations[0].userData.marker === 'preserve', 'clip metadata lost');
            check(rebuilt.animations[0].tracks[0].values === received.animations[0].tracks[0].values, 'track values copied');
            const mixer = new T.AnimationMixer(rebuilt); mixer.clipAction(rebuilt.animations[0]).play(); mixer.update(.5);
            check(Math.abs(skin.position.x - 1) < 1e-6, 'animation no longer plays'); mixer.stopAllAction(); mixer.uncacheRoot(rebuilt);
            dispose(root); dispose(rebuilt);

            // Real worker + real r186 loader, including an image that would throw
            // "document is not defined" in a worker with the regular TextureLoader.
            const canvas = document.createElement('canvas'); canvas.width = canvas.height = 32;
            const ctx = canvas.getContext('2d'), pixels = ctx.createImageData(32,32);
            for (let i=0; i<pixels.data.length; i+=4) { pixels.data[i]=(i*19)%251; pixels.data[i+1]=(i*31)%253; pixels.data[i+2]=179; pixels.data[i+3]=255; }
            ctx.putImageData(pixels,0,0);
            const buffer = createWorkerFBXFixture(canvas.toDataURL().split(',')[1]);
            const originals = [];
            const manager = new T.LoadingManager();
            const imagesReady = new Promise(resolve => { manager.onLoad = resolve; });
            const direct = new FBXLoader(manager).parse(buffer.slice(0), ''); originals.push(direct);
            await imagesReady;
            const client = createFBXWorkerClient({ idleTimeoutMs: 0 });
            const parsed = await client.parseFBXInWorker(buffer, { embedded: true, orientation: true }); originals.push(parsed.obj);
            check(buffer.byteLength === 0, 'FBX input was copied instead of transferred');
            check(client.getDiagnostics().lastParse.transport === 1 && !client.getDiagnostics().workerActive, 'real worker failed or stayed resident');
            const a = direct.getObjectByName('Triangle'), b = parsed.obj.getObjectByName('Triangle');
            direct.updateMatrixWorld(true); parsed.obj.updateMatrixWorld(true);
            check(a.geometry.attributes.position.array.join() === b.geometry.attributes.position.array.join(), 'real geometry differs');
            check(a.geometry.attributes.uv.array.join() === b.geometry.attributes.uv.array.join(), 'real UV differs');
            check(a.matrix.elements.every((n,i)=>Math.abs(n-b.matrix.elements[i])<1e-12), 'real transform differs');
            check(a.matrixWorld.elements.every((n,i)=>Math.abs(n-b.matrixWorld.elements[i])<1e-12), 'Z-up world transform differs');
            check(b.userData.sourceFBXModelId === '12' && b.material.map.image.width === 32, 'source ID or embedded image missing');
            check(parsed.embedded.length === 1, 'embedded gallery extraction regressed');
            const renderer = new T.WebGLRenderer({preserveDrawingBuffer: true, antialias: false}); renderer.setSize(96,96);
            const scene = new T.Scene(); scene.add(new T.AmbientLight(0xffffff, 2));
            const camera = new T.PerspectiveCamera(50,1,.1,10); camera.position.set(0,4,.5); camera.lookAt(0,0,0);
            const renderPixels = obj => { scene.add(obj); renderer.render(scene,camera); const data=new Uint8Array(96*96*4); const gl=renderer.getContext(); gl.readPixels(0,0,96,96,gl.RGBA,gl.UNSIGNED_BYTE,data); scene.remove(obj); return data; };
            const before = renderPixels(direct), after = renderPixels(parsed.obj);
            check(before.every((v,i)=>v===after[i]), 'embedded textured render differs');
            check(before.some((v,i)=>i%4!==3 && v>0), 'pixel comparison rendered an empty scene');
            renderer.dispose();
            const image = b.material.map.image;
            originals.forEach(dispose);
            check(!image.hasAttribute('src') && b.material.map.source.data === null, 'decoded image survived texture disposal');
            // Cold abort, new worker after abort, two queued parses with one abort,
            // and disposal during asynchronous image hydration.
            const aborted = new AbortController();
            const pending = client.parseFBXInWorker(createWorkerFBXFixture(''), null, {signal: aborted.signal}).catch(e=>e.name);
            aborted.abort(); check(await pending === 'AbortError', 'worker abort did not reject');
            const recovered = await client.parseFBXInWorker(createWorkerFBXFixture(canvas.toDataURL().split(',')[1])); dispose(recovered.obj);
            const canceled = new AbortController();
            const first = client.parseFBXInWorker(createWorkerFBXFixture(''), null, {signal: canceled.signal}).catch(e=>e.name);
            const second = client.parseFBXInWorker(createWorkerFBXFixture(canvas.toDataURL().split(',')[1])); canceled.abort();
            check(await first === 'AbortError', 'queued abort did not reject'); dispose((await second).obj);
            client.dispose();
            check(client.getDiagnostics().pending === 0 && client.getDiagnostics().hydrating === 0, 'worker jobs leaked');
            const controller = new AbortController();
            const blocked = parseFBXTransfer({images:[{uuid:'slow',url:'/__fbx_slow_image'}]}, {signal:controller.signal}).catch(e=>e.name);
            controller.abort(); check(await blocked === 'AbortError', 'image hydration ignored abort');
            const NativeWorker = globalThis.Worker, NativeImage = globalThis.Image;
            const originalRevoke = URL.revokeObjectURL;
            const deferredImages = [], revoked = [];
            globalThis.Image = class {
                constructor() { deferredImages.push(this); }
                removeAttribute(name) { if (name === 'src') this.src = ''; }
            };
            globalThis.Worker = class {
                postMessage(message) {
                    queueMicrotask(() => this.onmessage?.({data: {id:message.id,ok:true,transport:1,
                        json:{images:[{uuid:'deferred',blob:new Blob(['image'])}]}}}));
                }
                terminate() {}
            };
            URL.revokeObjectURL = url => { revoked.push(url); originalRevoke(url); };
            try {
                const hydratingClient = createFBXWorkerClient();
                const hydration = hydratingClient.parseFBXInWorker(new ArrayBuffer(4)).catch(e=>e.name);
                for (let i=0; i<20 && !deferredImages.length; i++) await Promise.resolve();
                check(hydratingClient.getDiagnostics().hydrating === 1, 'hydration race fixture did not start');
                hydratingClient.dispose();
                check(await hydration === 'AbortError', 'client disposal ignored image hydration');
                check(revoked.length === 1 && !deferredImages[0].src && deferredImages[0].onload === null, 'pending image or Blob URL leaked');
                check(hydratingClient.getDiagnostics().hydrating === 0, 'hydration controller leaked');
                const batchWorkers = [];
                let respond = true;
                globalThis.Worker = class {
                    constructor() { batchWorkers.push(this); this.terminated = false; }
                    postMessage(message) { this.id = message.id; if (respond) queueMicrotask(()=>this.finish()); }
                    finish() { this.onmessage({data:{id:this.id,ok:true,json:new T.Group().toJSON()}}); }
                    terminate() { this.terminated = true; }
                };
                const batch = createFBXWorkerClient({ idleTimeoutMs: 20 });
                await batch.parseFBXInWorker(new ArrayBuffer(1));
                respond = false;
                const running = batch.parseFBXInWorker(new ArrayBuffer(1));
                await new Promise(resolve=>setTimeout(resolve,35));
                check(batchWorkers.length === 1 && !batchWorkers[0].terminated, 'idle timer interrupted the next job');
                batchWorkers[0].finish(); await running;
                await new Promise(resolve=>setTimeout(resolve,35));
                check(batchWorkers[0].terminated && !batch.getDiagnostics().workerActive, 'idle batch worker leaked');
                respond = true; await batch.parseFBXInWorker(new ArrayBuffer(1));
                check(batchWorkers.length === 2, 'worker did not recreate after idle release'); batch.dispose();
            } finally { globalThis.Worker = NativeWorker; globalThis.Image = NativeImage; URL.revokeObjectURL = originalRevoke; }
            return { transport: packed.stats, realWorker: true, pixelParity: true, abortRecovery: true };
        });
        assert.equal(result.realWorker, true);
        assert.deepEqual(errors, []);
    } finally { await page.close(); }
}
