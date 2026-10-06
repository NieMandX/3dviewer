import assert from 'node:assert/strict';

export async function runTextureSourceReleaseSmoke(browser, baseUrl, createPage, { renderer = 'webgl' } = {}) {
    const { page, diagnostics } = await createPage(browser, baseUrl, { renderer });
    try {
        await page.evaluate(() => {
            const client = window.__adminSmokeClient, channel = client.channel;
            window.__sourceReleaseCallbacks = [];
            client.channel = (name) => {
                const ch = channel(name), on = ch.on.bind(ch);
                ch.on = (event, filter, callback) => {
                    if (filter?.table === 'room_models') window.__sourceReleaseCallbacks.push(callback);
                    return on(event, filter, callback);
                };
                return ch;
            };
            document.querySelector('#collabEmail').value = 'switch@example.com';
            document.querySelector('#collabPassword').value = 'secret123';
            document.querySelector('#collabJoinBtn').click();
        });
        await page.waitForFunction(() => [...document.querySelector('#collabProjectSelect').options].some(o => o.value === 'project-switch'));
        await page.selectOption('#collabProjectSelect', 'project-switch', { force: true });
        await page.waitForFunction(() => [...document.querySelector('#collabRoomSelect').options].some(o => o.value === 'room-a'));
        await page.selectOption('#collabRoomSelect', 'room-a', { force: true });
        await page.waitForFunction(() => viewerApp.getDiagnostics().collab.connected && window.__sourceReleaseCallbacks.length);
        await page.evaluate(async () => {
            const T = await import('three');
            const image = { data: new Uint8Array([255, 100, 50, 255]), width: 1, height: 1 };
            const removed = new T.DataTexture(image.data, 1, 1), kept = removed.clone();
            const shared = new T.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1);
            removed.needsUpdate = kept.needsUpdate = shared.needsUpdate = true;
            const q = window.__sourceRelease = { removed, kept, shared, source: kept.source, image: kept.image, disposed: { removed: 0, kept: 0, shared: 0 }, sourceAtDispose: null };
            for (const key of ['removed', 'kept', 'shared']) q[key].addEventListener('dispose', () => {
                q.disposed[key]++;
                if (key === 'removed') q.sourceAtDispose = removed.source;
            });
            for (const [id, texture, x] of [['a', removed, -1], ['b', kept, 1]]) {
                const obj = new T.Mesh(new T.BoxGeometry(), new T.MeshStandardMaterial({ map: texture, normalMap: shared }));
                obj.position.x = x;
                const scope = { kind: 'room', roomId: 'room-a', modelId: id };
                obj.userData.importScope = scope;
                viewerApp.world.add(obj);
                viewerApp.loadedModels.push({ obj, name: id + '.glb', scope });
                window.__lpmSwitchSmokeRoomContent.roomModels.push({ room_id: 'room-a', model_id: id });
            }
            viewerApp.controls?.dispatchEvent({ type: 'change' });
        });
        await page.waitForTimeout(100);
        await page.evaluate(() => {
            window.__lpmSwitchSmokeRoomContent.roomModels = [{ room_id: 'room-a', model_id: 'b' }];
            window.__sourceReleaseCallbacks.forEach(fn => fn({ eventType: 'DELETE', old: { room_id: 'room-a', model_id: 'a' } }));
        });
        await page.waitForFunction(() => viewerApp.loadedModels.length === 1);
        const partial = await page.evaluate(() => {
            const q = window.__sourceRelease;
            return { disposed: q.disposed, removedImage: q.removed.image, keptSource: q.kept.source === q.source,
                keptImage: q.kept.image === q.image, sharedImage: !!q.shared.image,
                sourceAtDispose: q.sourceAtDispose === q.source, removedSource: q.removed.source !== q.source };
        });
        assert.deepEqual(partial, { disposed: { removed: 1, kept: 0, shared: 0 }, removedImage: null,
            keptSource: true, keptImage: true, sharedImage: true, sourceAtDispose: true, removedSource: true },
        'Removing one model must detach its disposed source after listeners run and preserve surviving shared images/textures');
        await page.selectOption('#collabRoomSelect', '', { force: true });
        await page.waitForFunction(() => viewerApp.loadedModels.length === 0);
        const cleared = await page.evaluate(() => {
            const q = window.__sourceRelease;
            return { disposed: q.disposed, images: [q.removed.image, q.kept.image, q.shared.image],
                urls: viewerApp.getDiagnostics().resources.knownBlobUrls };
        });
        assert.deepEqual(cleared, { disposed: { removed: 1, kept: 1, shared: 1 }, images: [null, null, null], urls: 0 });
        diagnostics.assertNoErrors('Texture source release smoke');
        console.log(JSON.stringify({ textureSourceRelease: renderer, passed: true }));
    } finally {
        await page.evaluate(() => viewerApp.dispose()).catch(() => {});
        await page.close();
    }
}
