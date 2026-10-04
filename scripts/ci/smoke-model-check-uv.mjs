import assert from 'node:assert/strict';

// Synthetic public fixture. Real private ZIP evidence is tested outside the repo.
export async function installUVReportFixture(page) {
    return page.evaluate(() => {
        const image = document.createElement('canvas'); image.width = image.height = 256;
        const ctx = image.getContext('2d'); ctx.fillStyle = '#68747d'; ctx.fillRect(0, 0, 256, 128);
        ctx.fillStyle = '#b8ae92'; ctx.fillRect(0, 128, 256, 128);
        const preview = { data_url: image.toDataURL('image/png'), size: [256, 256] };
        const region = [0.36, 0.28, 0.445, 0.365];
        const crop = document.createElement('canvas'); crop.width = crop.height = 128;
        crop.getContext('2d').drawImage(image, region[0] * 256, (1 - region[3]) * 256, (region[2] - region[0]) * 256, (region[3] - region[1]) * 256, 0, 0, 128, 128);
        const segments = (a, b) => [[[a, .15], [b, .15]], [[b, .15], [b, .7]], [[b, .7], [a, .7]], [[a, .7], [a, .15]]];
        const visual = { schema: 'agr-uv-evidence-v1', profile: 'VPM', requirement_ref: '2.5.1.5', source_fbx: 'SM_Example.fbx', coordinate_space: 'tile_uv_bottom_left',
            textures: [{ id: 'texture-a', name: 'T_Example_Diffuse_1.1001.png', size: [4096, 4096], tile: 1001, sha256: 'b'.repeat(64), preview }],
            cases: [{ id: '1', kind: 'small_gap', texture_id: 'texture-a', gap_px: 20.48, threshold_px: 32, points_uv: [[.4, .32], [.405, .32]],
                island_segments_uv: [segments(.1, .4), segments(.405, .72)], detail: { data_url: crop.toDataURL('image/png'), size: [128, 128], region_uv: region } }] };
        window.uvTestReport = { checker_version: '1.6.1', checker_product: { id: 'agr_vision_model_check', version: '0.1.10' }, source_sha256: 'a'.repeat(64),
            summary: { warning: 1 }, checks: [{ profile: 'VPM', requirement_ref: '2.5.1.5', name: 'Отступ между островами', status: 'warning', recommendations_text: 'Найдено место для просмотра.' }],
            additional_checks: [{ id: 'AV.UV.SPACING.001', groups: [{ source_group: 'True:SM_Example', objects: [{ measurements: { coverage_complete: false, visuals: visual } }] }] }] };
        return window.uvTestReport;
    });
}

export async function runModelCheckUVSmoke(browser, baseUrl, screenshotDir) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
    await page.setViewportSize({ width: 1280, height: 960 });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    try {
        await page.goto(`${baseUrl}/__smoke_blank`); await page.addStyleTag({ url: `${baseUrl}/styles/viewer.css` });
        await installUVReportFixture(page);
        const validation = await page.evaluate(async () => {
            const { uvEvidence } = await import('/scripts/modules/ui/model-check-uv.js');
            const good = uvEvidence(window.uvTestReport).length;
            const paths = [v => { v.textures[0].preview.data_url = 'data:image/svg+xml,<svg onload="alert(1)"/>'; },
                v => { v.cases[0].gap_px = 123; }, v => { v.cases[0].points_uv[0][0] = Infinity; },
                v => { v.cases[0].island_segments_uv[0] = Array(2049).fill([[0, 0], [1, 1]]); },
                v => { v.textures[0].preview.size = [4096, 4096]; }, v => { v.schema = 'unknown'; },
                v => { v.cases[0].detail.region_uv = [1, 0, 0, 1]; }, v => { v.textures[0].preview.data_url = 'https://example.com/private'; }];
            const rejected = paths.map(change => { const report = structuredClone(window.uvTestReport); change(report.additional_checks[0].groups[0].objects[0].measurements.visuals); return uvEvidence(report).length === 0; });
            return { good, rejected, legacy: uvEvidence({ checks: [] }).length };
        });
        assert.equal(validation.good, 1); assert.equal(validation.legacy, 0); assert.ok(validation.rejected.every(Boolean));
        await page.evaluate(async () => {
            const { createModelCheckPanel } = await import('/scripts/modules/ui/model-check-panel.js');
            const button = document.createElement('button'); button.id = 'uv-check-entry'; button.textContent = 'Проверка модели'; document.body.append(button);
            window.uvContext = { key: 'room-a:user', models: [{ id: 'source', name: 'SM_Example.zip' }], canManage: false };
            window.uvPanel = createModelCheckPanel({ button, apiBaseUrl: 'https://checker.invalid', getContext: () => window.uvContext, getAccessToken: async () => 'test', fetchImpl: async url => ({ ok: true, json: async () => String(url).includes('/models/') ? { jobs: [{ id: 'job' }] } : { job: { id: 'job', status: 'completed', source_current: true, report: window.uvTestReport } } }) });
        });
        await page.click('#uv-check-entry'); await page.locator('.model-check-item summary').click();
        await page.getByRole('button', { name: 'Показать на текстуре · 1', exact: true }).click();
        await page.waitForFunction(() => document.querySelector('#modelCheckUVDialog')?.open && !document.querySelector('.model-check-uv-status')?.textContent);
        assert.match(await page.locator('.model-check-uv-facts').textContent(), /20,48 px/);
        assert.match(await page.locator('.model-check-uv-body').textContent(), /частично/);
        assert.equal(await page.locator('#modelCheckDialog').evaluate(d => d.open), true);
        if (screenshotDir) await page.screenshot({ path: `${screenshotDir}/uv-texture-desktop.png` });
        const imageBefore = await page.locator('#modelCheckUVDialog canvas').evaluate(c => c.toDataURL());
        await page.getByRole('button', { name: 'Увеличить', exact: true }).click();
        assert.notEqual(await page.locator('#modelCheckUVDialog canvas').evaluate(c => c.toDataURL()), imageBefore);
        await page.getByRole('button', { name: 'Весь тайл', exact: true }).click();
        const pixels = await page.locator('#modelCheckUVDialog canvas').evaluate(c => {
            const scale = Math.min(c.width, c.height); const ctx = c.getContext('2d');
            const sample = (u, v) => [...ctx.getImageData(Math.round(c.width / 2 + (u - .5) * scale), Math.round(c.height / 2 + (.5 - v) * scale), 1, 1).data];
            return { upper: sample(.25, .82), lower: sample(.25, .08) };
        });
        assert.deepEqual(pixels.upper, [104, 116, 125, 255], 'UV V axis is flipped over the PNG');
        assert.deepEqual(pixels.lower, [184, 174, 146, 255]);
        const canvas = page.locator('#modelCheckUVDialog canvas'); const bounds = await canvas.boundingBox();
        const beforePan = await canvas.evaluate(c => c.toDataURL());
        await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2); await page.mouse.down(); await page.mouse.move(bounds.x + bounds.width / 2 + 50, bounds.y + bounds.height / 2 + 30); await page.mouse.up();
        assert.notEqual(await canvas.evaluate(c => c.toDataURL()), beforePan);
        await page.setViewportSize({ width: 390, height: 844 }); await page.getByRole('button', { name: 'Участок', exact: true }).click();
        assert.equal(await page.locator('.model-check-uv-body').evaluate(e => e.scrollWidth <= e.clientWidth + 1), true);
        if (screenshotDir) await page.screenshot({ path: `${screenshotDir}/uv-texture-mobile.png` });
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('#modelCheckUVDialog').evaluate(d => d.open), false);
        assert.equal(await page.locator('#modelCheckDialog').evaluate(d => d.open), true);
        assert.equal(await page.evaluate(() => document.activeElement.classList.contains('model-check-uv-open')), true);
        const reportFile = Buffer.from(JSON.stringify(await page.evaluate(() => window.uvTestReport)));
        await page.locator('#modelCheckDialog input[type=file]').setInputFiles({ name: 'saved-report.json', mimeType: 'application/json', buffer: reportFile });
        await page.waitForFunction(() => document.querySelector('.model-check-report')?.textContent.includes('Открыт сохранённый отчёт'));
        await page.locator('.model-check-item summary').click();
        await page.getByRole('button', { name: 'Показать на текстуре · 1', exact: true }).click();
        await page.evaluate(() => { window.uvContext.key = 'room-b:user'; });
        await page.waitForFunction(() => [...document.querySelectorAll('dialog')].every(d => !d.open));
        assert.equal(await canvas.evaluate(c => c.width), 1);
        // Offline report reading also works before joining a room or importing a model.
        await page.evaluate(() => { window.uvContext = { key: '', models: [], canManage: false }; window.uvPanel.open(); });
        await page.locator('#modelCheckDialog input[type=file]').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{broken') });
        await page.waitForFunction(() => document.querySelector('#modelCheckDialog [role=alert]')?.textContent.includes('корректный JSON'));
        await page.locator('#modelCheckDialog input[type=file]').setInputFiles({ name: 'saved-report.json', mimeType: 'application/json', buffer: reportFile });
        await page.waitForSelector('.model-check-uv-open', { state: 'attached' });
        assert.equal(await page.getByRole('button', { name: 'Проверить модель', exact: true }).isDisabled(), true);
        await page.evaluate(() => { window.uvContext.key = 'room-a:user'; window.uvPanel.open(); });
        await page.locator('#modelCheckDialog input[type=file]').setInputFiles({ name: 'saved-report.json', mimeType: 'application/json', buffer: reportFile });
        await page.locator('.model-check-item summary').click();
        await page.getByRole('button', { name: 'Показать на текстуре · 1', exact: true }).click();
        // Dispose while picture callbacks may still be pending.
        await page.evaluate(() => { window.uvPanel.dispose(); window.uvPanel.dispose(); });
        await page.waitForTimeout(100);
        assert.equal(await page.locator('dialog').count(), 0); assert.deepEqual(errors, []);
    } finally { await page.close(); }
}
