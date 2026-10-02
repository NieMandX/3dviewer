import { createServer } from 'node:http';
import assert from 'node:assert/strict';

export async function runDownloadUISmoke(browser, baseUrl, createRoomPage) {
    let payload = null;
    let downloads = 0;
    let closedEarly = 0;
    const server = createServer((req, res) => {
        downloads += 1;
        res.writeHead(200, { 'content-type': 'model/gltf-binary', 'content-length': payload.length, 'access-control-allow-origin': '*' });
        let offset = 0;
        const chunk = Math.ceil(payload.length / 10);
        const timer = setInterval(() => {
            res.write(payload.subarray(offset, offset + chunk));
            offset += chunk;
            if (offset >= payload.length) { clearInterval(timer); res.end(); }
        }, 150);
        res.on('close', () => { if (offset < payload.length) closedEarly += 1; clearInterval(timer); });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const downloadUrl = `http://127.0.0.1:${server.address().port}/model.glb`;
    const { page, diagnostics } = await createRoomPage(browser, baseUrl);
    try {
        payload = Buffer.from(await page.evaluate(async () => {
            const T = await import('three');
            const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');
            const mesh = new T.Mesh(new T.BoxGeometry(), new T.MeshStandardMaterial());
            const data = await new GLTFExporter().parseAsync(mesh, { binary: true });
            mesh.geometry.dispose(); mesh.material.dispose();
            return Array.from(new Uint8Array(data));
        }));
        await page.evaluate(({ downloadUrl, size }) => {
            window.__signedDownloadCalls = [];
            window.__adminSmokeClient.storage.from = bucket => ({
                createSignedUrl: async (path, expires) => {
                    window.__signedDownloadCalls.push({ bucket, path, expires });
                    return { data: { signedUrl: downloadUrl }, error: null };
                },
            });
            const model = { id: 'progress-model', project_id: 'project-switch', name: 'server-context.glb',
                url: 'storage://models/progress/model.glb', meta: { kind: 'glb', size, storagePath: 'progress/model.glb' } };
            window.__lpmSwitchSmokeRoomContent.roomModels = [{ room_id: 'room-a', model_id: model.id, sort_order: 1, project_models: model }];
            window.__lpmSwitchSmokeRoomContent.projectModels = [model];
            document.querySelector('#collabEmail').value = 'switch@example.com';
            document.querySelector('#collabPassword').value = 'secret123';
            document.querySelector('#collabJoinBtn').click();
        }, { downloadUrl, size: payload.length });
        await page.waitForFunction(() => Array.from(document.querySelector('#collabProjectSelect').options).some(o => o.value === 'project-switch'));
        await page.selectOption('#collabProjectSelect', 'project-switch', { force: true });
        await page.waitForFunction(() => Array.from(document.querySelector('#collabRoomSelect').options).some(o => o.value === 'room-a'));
        await page.selectOption('#collabRoomSelect', 'room-a', { force: true });
        await page.waitForFunction(() => /[1-9]\d?%.*из/.test(document.querySelector('#status')?.textContent || ''));
        const during = await page.locator('#status').textContent();
        assert.match(during, /Загрузка модели.*%.*из.*server-context.glb/);
        assert.ok(Number(await page.locator('#status [role=progressbar]').getAttribute('aria-valuenow')) > 0);
        await page.waitForFunction(() => viewerApp.loadedModels.some(m => m.name === 'server-context.glb'));
        assert.equal(await page.evaluate(() => viewerApp.loadedModels[0].category), 'ENV');
        assert.deepEqual(await page.evaluate(() => window.__signedDownloadCalls), [{ bucket: 'models', path: 'progress/model.glb', expires: 3600 }]);
        assert.equal(downloads, 1);
        // Switch away, start again, then leave while bytes are arriving.
        await page.selectOption('#collabProjectSelect', 'project-switch-b', { force: true });
        await page.waitForFunction(() => viewerApp.loadedModels.length === 0);
        await page.selectOption('#collabProjectSelect', 'project-switch', { force: true });
        await page.waitForFunction(() => Array.from(document.querySelector('#collabRoomSelect').options).some(o => o.value === 'room-a'));
        await page.selectOption('#collabRoomSelect', 'room-a', { force: true });
        await page.waitForFunction(() => /[1-9]\d?%.*из/.test(document.querySelector('#status')?.textContent || ''));
        await page.selectOption('#collabProjectSelect', 'project-switch-b', { force: true });
        await page.waitForTimeout(1800);
        assert.equal(await page.evaluate(() => viewerApp.loadedModels.length), 0, 'Stale download entered new project');
        assert.ok(closedEarly > 0, 'Switch did not cancel the network stream');
        assert.doesNotMatch(await page.locator('#status').textContent(), /Загрузка модели.*server-context/);
        diagnostics.assertNoErrors('Private model download progress and abort');
    } finally {
        await page.evaluate(() => viewerApp.dispose()).catch(() => {});
        await page.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    }
}
