import assert from 'node:assert/strict';
export async function runModelCheckPanelSmoke(browser, baseUrl, screenshotDir) {
    const page = await browser.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
    try {
        await page.goto(`${baseUrl}/__smoke_blank`);
        const eligibility = await page.evaluate(async () => {
            const { eligibleModelCheckPackages, createModelCheckPanel } = await import('/scripts/modules/ui/model-check-panel.js');
            window.checkFactory = createModelCheckPanel;
            const scope = { kind: 'room', roomId: 'room-a', modelId: 'model-a' };
            const valid = { scope, group: '0123_model.zip', zipKind: 'NPM', category: 'NPM', sourceContainer: 'zip' };
            const cases = [valid, { ...valid, name: 'second-fbx' }, { ...valid, scope: { ...scope, modelId: 'env' }, category: 'ENV' },
                { ...valid, scope: { kind: 'local' } }, { ...valid, sourceContainer: 'file' }, { ...valid, scope: { ...scope, roomId: 'other' } },
                { ...valid, scope: { ...scope, modelId: 'vpm' }, zipKind: 'SM', group: 'SM_valid.zip' }];
            const btn = document.createElement('button'); document.body.append(btn);
            const inactive = createModelCheckPanel({ button: btn, apiBaseUrl: '', getContext: () => ({}), getAccessToken: async () => '' });
            btn.click(); const hidden = btn.hidden && !document.querySelector('dialog'); inactive.dispose(); btn.remove();
            return { packages: eligibleModelCheckPackages(cases, 'room-a'), hidden };
        });
        assert.deepEqual(eligibility, { packages: [{ id: 'model-a', name: '0123_model.zip' }, { id: 'vpm', name: 'SM_valid.zip' }], hidden: true });
        await page.addStyleTag({ url: `${baseUrl}/styles/viewer.css` });
        await page.evaluate(() => {
            const button = document.createElement('button'); button.id = 'check-entry'; button.textContent = 'Проверить'; document.body.append(button);
            window.checkContext = { key: 'room-a:user-a', canManage: true, models: [{ id: 'model-a', name: '0123_Нагатинская_1.zip' }, { id: 'model-b', name: 'SM_Вторая_модель.zip' }] };
            window.checkCalls = []; window.checkNetworkDown = false; window.checkDelay = null;
            window.checkJob = null;
            window.checkReport = { checker_version: '1.6.1', blender_version: '5.1.0', source_sha256: 'a'.repeat(64), summary: { failed: 2, warning: 1, passed: 39, not_checked: 28 }, checks: [
                { status: 'failed', profile: 'НПМ', requirement_ref: '2.1', name: 'Имена объектов', errors_text: '<img src=x onerror=alert(1)>\nИмя объекта не соответствует требованиям.' },
                { status: 'warning', profile: 'НПМ', requirement_ref: '3.2', name: 'Текстуры', recommendations_text: 'Проверьте разрешение текстуры.' },
                { status: 'not_checked', profile: 'НПМ', requirement_ref: '4.1', name: 'Визуальное соответствие проекту' },
            ] };
            window.checkPanel = window.checkFactory({ button, apiBaseUrl: 'https://checker.invalid/v1/checks', getContext: () => window.checkContext, getAccessToken: async () => 'user-token', pollMs: 30,
                fetchImpl: async (url, options) => {
                    window.checkCalls.push({ path: url.pathname, auth: options.headers.Authorization, method: options.method });
                    if (window.checkDelay) await new Promise(resolve => { window.finishCheckDelay = resolve; });
                    if (window.checkNetworkDown) throw new Error('Нет сети. Нажмите «Обновить» после восстановления соединения.');
                    let data;
                    if (url.pathname.includes('/models/')) data = { jobs: window.checkJob ? [window.checkJob] : [] };
                    else if (options.method === 'POST' && url.pathname.endsWith('/jobs')) { window.checkJob = { id: 'job-a', status: 'queued', source_name: '0123_Нагатинская_1.zip', engine_revision: 'test161' }; data = { job: window.checkJob }; }
                    else if (url.pathname.endsWith('/cancel')) { window.checkJob = { ...window.checkJob, status: 'cancelled' }; data = { job: window.checkJob }; }
                    else data = { job: url.pathname.endsWith('/report') ? { ...window.checkJob, report: window.checkReport } : window.checkJob };
                    return new Response(JSON.stringify(data));
                } });
        });
        await page.click('#check-entry');
        await page.waitForFunction(() => document.querySelector('[role=status]')?.textContent.includes('пока нет'));
        await page.getByRole('button', { name: 'Проверить модель', exact: true }).click();
        await page.waitForFunction(() => document.querySelector('[role=status]')?.textContent.includes('В очереди'));
        await page.evaluate(() => { window.checkJob = { ...window.checkJob, status: 'running', stage: 'blender_checks' }; });
        await page.waitForFunction(() => document.querySelector('[role=status]')?.textContent.includes('Blender'));
        await page.getByRole('button', { name: 'Отменить проверку', exact: true }).click();
        await page.waitForFunction(() => document.querySelector('[role=status]')?.textContent.includes('отменена'));
        await page.evaluate(() => { window.checkJob = { ...window.checkJob, status: 'completed', source_current: false, source_sha256: 'a'.repeat(64) }; });
        await page.getByRole('button', { name: 'Обновить', exact: true }).click();
        await page.waitForSelector('.model-check-report a[download]');
        assert.match(await page.locator('.model-check-report').textContent(), /Не проверено: 28/);
        assert.match(await page.locator('.model-check-stale').textContent(), /Архив изменён/);
        await page.evaluate(() => { window.checkJob.engine_current = false; });
        await page.getByRole('button', { name: 'Обновить', exact: true }).click();
        await page.waitForFunction(() => document.querySelector('.model-check-report')?.textContent.includes('отключённым обработчиком'));
        assert.equal(await page.locator('.model-check-report img').count(), 0, 'Report text became executable HTML');
        await page.setViewportSize({ width: 390, height: 844 });
        await page.locator('.model-check-item summary').first().click();
        assert.equal(await page.evaluate(() => document.querySelector('.model-check-body').scrollWidth <= document.querySelector('.model-check-body').clientWidth + 1), true, 'Report overflows mobile viewport');
        if (screenshotDir) await page.screenshot({ path: `${screenshotDir}/checker-mobile.png` });
        await page.setViewportSize({ width: 1280, height: 900 });
        if (screenshotDir) await page.screenshot({ path: `${screenshotDir}/checker-desktop.png` });
        // Offline fetch remains recoverable; never reinterpret it as a passing result.
        await page.evaluate(() => { window.checkNetworkDown = true; });
        await page.getByRole('button', { name: 'Обновить', exact: true }).click();
        await page.waitForFunction(() => document.querySelector('[role=alert]')?.textContent.includes('Нет связи'));
        await page.evaluate(() => { window.checkNetworkDown = false; });
        await page.getByRole('button', { name: 'Обновить', exact: true }).click();
        await page.waitForFunction(() => !document.querySelector('[role=alert]')?.textContent);
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('dialog').evaluate(el => el.open), false);
        assert.equal(await page.evaluate(() => document.activeElement.id), 'check-entry');
        // Guest sees reports but cannot start/cancel jobs.
        await page.evaluate(() => { window.checkContext.canManage = false; });
        await page.click('#check-entry'); await page.waitForSelector('.model-check-report a[download]');
        assert.equal(await page.getByRole('button', { name: 'Проверить модель', exact: true }).isDisabled(), true);
        // A late response is rejected when a room changes, even if fetch ignores AbortSignal.
        await page.evaluate(() => { window.checkDelay = true; });
        await page.getByRole('button', { name: 'Обновить', exact: true }).click();
        await page.waitForFunction(() => !!window.finishCheckDelay);
        await page.evaluate(() => { window.checkContext = { key: 'room-b:user-a', models: [], canManage: true }; });
        await page.waitForFunction(() => !document.querySelector('dialog').open);
        await page.evaluate(() => { window.checkDelay = null; window.finishCheckDelay(); });
        await page.waitForTimeout(80);
        assert.equal(await page.locator('.model-check-report').textContent(), '');
        // Disposal rejects late updates and removes listeners/timers/Blob URLs.
        await page.evaluate(() => { window.checkContext = { key: 'room-a:user-a', models: [{ id: 'model-a', name: '0123.zip' }], canManage: true }; window.checkPanel.open(); });
        await page.waitForSelector('.model-check-report a[download]');
        const callsAtDispose = await page.evaluate(() => { window.checkPanel.dispose(); window.checkPanel.dispose(); document.querySelector('#check-entry').click(); return window.checkCalls.length; });
        await page.waitForTimeout(600);
        assert.equal(await page.locator('dialog').count(), 0);
        assert.equal(await page.evaluate(() => window.checkCalls.length), callsAtDispose);
        assert.ok((await page.evaluate(() => window.checkCalls)).every(c => c.auth === 'Bearer user-token' && c.path.startsWith('/v1/checks/')));
        assert.deepEqual(errors, []);
    } finally { await page.close(); }
}

export async function runModelCheckIntegrationSmoke(browser, baseUrl, createRoomPage, screenshotDir) {
    let apiCalls = 0; let cancelled = false;
    const { page, diagnostics } = await createRoomPage(browser, baseUrl, { beforeLoad: async page => {
        await page.route('**/config/runtime.js', async route => {
            const response = await route.fetch();
            await route.fulfill({ response, body: (await response.text()) + "\nwindow.__LPMVIEW_RUNTIME.modelCheckApiUrl='https://checker.invalid';" });
        });
        await page.route('https://checker.invalid/**', async route => {
            apiCalls++;
            assert.equal(route.request().headers().authorization, 'Bearer room-test-token');
            const path = new URL(route.request().url()).pathname;
            const job = { id: 'job-integration', status: cancelled ? 'cancelled' : 'running', stage: 'blender_checks' };
            if (path.endsWith('/cancel')) { cancelled = true; job.status = 'cancelled'; }
            await route.fulfill({ json: path.startsWith('/models/') ? { jobs: [job] } : { job } });
        });
    } });
    try {
        await page.evaluate(() => {
            window.__adminSmokeClient.auth.getSession = async () => ({ data: { session: { access_token: 'room-test-token' } } });
            document.querySelector('#collabEmail').value = 'switch@example.com';
            document.querySelector('#collabPassword').value = 'secret123'; document.querySelector('#collabJoinBtn').click();
        });
        await page.waitForFunction(() => Array.from(document.querySelector('#collabProjectSelect').options).some(o => o.value === 'project-switch'));
        await page.selectOption('#collabProjectSelect', 'project-switch', { force: true });
        await page.waitForFunction(() => Array.from(document.querySelector('#collabRoomSelect').options).some(o => o.value === 'room-a'));
        await page.selectOption('#collabRoomSelect', 'room-a', { force: true });
        await page.waitForFunction(() => viewerApp.getDiagnostics().collab.connected);
        await page.evaluate(async () => {
            const { Group } = await import('three');
            viewerApp.loadedModels.push({ obj: new Group(), group: '0123_original.zip', name: 'model.fbx', category: 'NPM', zipKind: 'NPM', sourceContainer: 'zip', scope: { kind: 'room', roomId: 'room-a', modelId: 'model-npm' } });
            viewerApp.loadedModels.push({ obj: new Group(), name: 'environment.glb', category: 'ENV', sourceContainer: 'file', scope: { kind: 'room', roomId: 'room-a', modelId: 'model-env' } });
        });
        await page.setViewportSize({ width: 390, height: 844 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Checker button overflows mobile appbar');
        if (screenshotDir) await page.screenshot({ path: `${screenshotDir}/checker-viewer-mobile.png` });
        await page.click('#modelCheckBtn');
        await page.waitForFunction(() => document.querySelector('#modelCheckDialog [role=status]')?.textContent.includes('Blender'));
        const cameraBeforeKeys = await page.evaluate(() => viewerApp.camera.position.toArray());
        await page.getByRole('button', { name: 'Закрыть', exact: true }).focus();
        await page.keyboard.down('w'); await page.waitForTimeout(150); await page.keyboard.up('w');
        assert.deepEqual(await page.evaluate(() => viewerApp.camera.position.toArray()), cameraBeforeKeys, 'Report keyboard input moved the Viewer camera');
        assert.equal(await page.locator('#modelCheckSource option').count(), 1);
        assert.equal(await page.locator('#modelCheckSource').inputValue(), 'model-npm');
        await page.getByRole('button', { name: 'Отменить проверку', exact: true }).click();
        await page.waitForFunction(() => document.querySelector('#modelCheckDialog [role=status]')?.textContent.includes('отменена'));
        assert.ok(cancelled);
        // Real composition-root teardown closes the dialog synchronously.
        await page.evaluate(() => { const select = document.querySelector('#collabProjectSelect'); select.value = 'project-switch-b'; select.dispatchEvent(new Event('change', { bubbles: true })); });
        await page.waitForFunction(() => !document.querySelector('#modelCheckDialog').open);
        await page.waitForFunction(() => viewerApp.loadedModels.length === 0);
        const afterSwitch = apiCalls; await page.waitForTimeout(1700); assert.equal(apiCalls, afterSwitch, 'Previous room kept polling');
        await page.evaluate(() => viewerApp.dispose());
        assert.equal(await page.locator('#modelCheckDialog').count(), 0);
        diagnostics.assertNoErrors('Model check composition and room teardown');
    } finally { await page.evaluate(() => viewerApp.dispose()).catch(() => {}); await page.close(); }
}
