import assert from 'node:assert/strict';

export async function runReconnectSelectionSmoke(browser, baseUrl, createPage, { renderer = 'webgl' } = {}) {
    for (const selection of ['room', 'project', 'clear']) {
        const { page, diagnostics } = await createPage(browser, baseUrl, { renderer });
        try {
            assert.equal(await page.evaluate(() => viewerApp.renderer.backend?.isWebGPUBackend ? 'webgpu' : 'webgl'), renderer);
            await page.evaluate(() => {
                document.querySelector('#collabEmail').value = 'switch@example.com';
                document.querySelector('#collabPassword').value = 'secret123';
                document.querySelector('#collabJoinBtn').click();
            });
            await page.waitForFunction(() => [...document.querySelector('#collabProjectSelect').options].some(o => o.value === 'project-switch'));
            await page.selectOption('#collabProjectSelect', 'project-switch', { force: true });
            await page.waitForFunction(() => [...document.querySelector('#collabRoomSelect').options].some(o => o.value === 'room-a'));
            await page.selectOption('#collabRoomSelect', 'room-a', { force: true });
            await page.waitForFunction(() => viewerApp.getDiagnostics().collab.connected && viewerApp.getDiagnostics().collab.autoResumeEnabled);
            await page.evaluate(async () => {
                const T = await import('three');
                const texture = new T.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
                const root = new T.Mesh(new T.BoxGeometry(), new T.MeshStandardMaterial({ map: texture }));
                root.userData.importScope = { kind: 'room', roomId: 'room-a', modelId: 'old-model' };
                viewerApp.world.add(root);
                viewerApp.loadedModels.push({ obj: root, name: 'old-model.fbx', scope: { ...root.userData.importScope } });
                const q = window.__reconnectSelection = { root, disposed: { geometry: 0, material: 0, texture: 0 } };
                for (const [kind, resource] of [['geometry', root.geometry], ['material', root.material], ['texture', texture]]) {
                    resource.addEventListener('dispose', () => q.disposed[kind]++);
                }
                const client = window.__adminSmokeClient, channel = client.channel;
                client.channel = name => {
                    const ch = channel(name);
                    if (name === 'room:room-a') {
                        const subscribe = ch.subscribe.bind(ch);
                        ch.subscribe = callback => {
                            q.releaseOldSubscribe = () => subscribe(callback);
                            return ch;
                        };
                    }
                    return ch;
                };
                // The ordinary room-switch smoke separately exercises transient failures.
                window.__lpmSwitchSmoke.roomBChannelErrors = 3;
                window.dispatchEvent(new Event('offline'));
                window.dispatchEvent(new Event('online'));
            });
            await page.waitForFunction(() => !!window.__reconnectSelection.releaseOldSubscribe, null, { timeout: 10000 });
            const reconnecting = await page.evaluate(() => ({
                inFlight: viewerApp.getDiagnostics().collab.autoResumeInFlight,
                channels: viewerApp.getDiagnostics().collab.totalRealtimeChannels,
                loaded: viewerApp.loadedModels.length,
            }));
            assert.deepEqual(reconnecting, { inFlight: true, channels: 0, loaded: 1 });
            if (selection === 'project') {
                await page.selectOption('#collabProjectSelect', 'project-switch-b', { force: true });
                await page.waitForFunction(() => [...document.querySelector('#collabRoomSelect').options].some(o => o.value === 'room-c'));
            } else {
                await page.selectOption('#collabRoomSelect', selection === 'room' ? 'room-b' : '', { force: true });
                if (selection === 'room') await page.waitForFunction(() => viewerApp.getDiagnostics().collab.connected);
            }
            await page.evaluate(() => window.__reconnectSelection.releaseOldSubscribe());
            await page.waitForTimeout(100);
            const after = await page.evaluate(() => ({
                loaded: viewerApp.loadedModels.length,
                detached: !window.__reconnectSelection.root.parent,
                disposed: window.__reconnectSelection.disposed,
                project: document.querySelector('#collabProjectSelect').value,
                room: document.querySelector('#collabRoomSelect').value,
                pending: viewerApp.getDiagnostics().models.pendingImports,
            }));
            assert.equal(after.loaded, 0, `${selection}: previous room model survived reconnect selection`);
            assert.equal(after.detached, true, `${selection}: previous root stayed in world`);
            assert.deepEqual(after.disposed, { geometry: 1, material: 1, texture: 1 }, `${selection}: resources must be disposed once`);
            assert.equal(after.project, selection === 'project' ? 'project-switch-b' : 'project-switch');
            assert.equal(after.room, selection === 'room' ? 'room-b' : '');
            assert.equal(after.pending, 0);
            diagnostics.assertNoErrors(`Reconnect ${selection} selection`);
            console.log(`[smoke] ${renderer} reconnect -> ${selection}: old scene disposed, late subscribe ignored`);
        } finally {
            await page.evaluate(() => viewerApp?.dispose?.()).catch(() => {});
            await page.close();
        }
    }
}
