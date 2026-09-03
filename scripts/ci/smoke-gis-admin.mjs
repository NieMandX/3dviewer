import assert from 'node:assert/strict';

export async function runGisAdminSmoke({ page, diagnostics }) {
    const requests = [];
    let configured = false;
    await page.route('https://voice-api.agr.vision/v1/admin/2gis', async (route) => {
        const request = route.request();
        const method = request.method();
        requests.push({ method, authorization: request.headers().authorization || '', body: request.postData() || '' });
        if (request.headers().authorization !== 'Bearer admin-access-token') {
            await route.fulfill({ status: 401, json: { error: 'missing token' },
                headers: { 'access-control-allow-origin': '*' } });
            return;
        }
        if (method === 'PUT') {
            const body = request.postDataJSON();
            configured = body.apiKey === 'production-2gis-smoke-key';
        } else if (method === 'DELETE') {
            configured = false;
        }
        await route.fulfill({ status: 200, json: {
            configured,
            fingerprint: configured ? 'ABC123DEF456' : '',
            updatedAt: configured ? '2026-09-03T12:00:00Z' : '',
        }, headers: { 'access-control-allow-origin': '*' } });
    });

    try {
        await page.evaluate(() => {
            const client = window.__adminSmokeClient;
            const rpc = client.rpc.bind(client);
            client.rpc = (name, params) => name === 'is_superuser'
                ? Promise.resolve({ data: true, error: null }) : rpc(name, params);
            client.auth.getSession = () => Promise.resolve({ data: { session: {
                access_token: 'admin-access-token',
                user: { id: 'registered-user', email: 'switch@example.com' },
            } }, error: null });
        });
        await page.locator('#collabStatusBtn').click();
        await page.locator('#collabShowLoginBtn').click();
        await page.locator('#collabEmail').fill('switch@example.com');
        await page.locator('#collabPassword').fill('secret123');
        await page.locator('#collabJoinBtn').click();
        await page.locator('#collabRoomManageBtn').click();
        await page.waitForFunction(() => !document.querySelector('#roomContentRefresh').disabled);
        assert.equal(await page.locator('#roomContentTab2gis').isVisible(), true);
        assert.equal(await page.locator('#mapUnderlayToggle').count(), 0, 'Raster underlay control is still public');
        assert.equal(await page.getByText('Окружение 2ГИС', { exact: true }).count(), 1);
        await page.locator('#roomContentTab2gis').click();
        await page.getByText('API-ключ не настроен', { exact: true }).waitFor();
        assert.equal(await page.locator('#roomContentRoomSelect').isVisible(), false);
        const input = page.locator('input[name="gis-api-key"]');
        await input.fill('production-2gis-smoke-key');
        await page.getByRole('button', { name: 'Сохранить ключ' }).click();
        await page.getByText('API-ключ настроен', { exact: true }).waitFor();
        assert.match(await page.locator('.gis-admin-key-meta').innerText(), /ABC123DEF456/);
        assert.equal(await page.locator('input[name="gis-api-key"]').inputValue(), '');
        assert.equal((await page.locator('#roomContentModal').innerText()).includes('production-2gis-smoke-key'), false);
        await page.setViewportSize({ width: 390, height: 844 });
        assert.equal(await page.locator('.room-content-panel').evaluate((panel) => (
            panel.getBoundingClientRect().left < 0
            || panel.getBoundingClientRect().right > innerWidth
            || panel.scrollWidth > panel.clientWidth + 1
        )), false, '2GIS admin panel overflows mobile viewport');
        await page.setViewportSize({ width: 1440, height: 960 });
        await page.locator('.gis-admin-panel').getByRole('button', { name: 'Удалить ключ' }).click();
        await page.locator('#confirmOk').click();
        await page.getByText('API-ключ не настроен', { exact: true }).waitFor();
        assert.deepEqual(requests.map((entry) => entry.method), ['GET', 'PUT', 'DELETE']);
        assert.equal(requests.every((entry) => entry.authorization === 'Bearer admin-access-token'), true);
        diagnostics.assertNoErrors('2GIS administration smoke');
    } finally {
        await page.close();
    }
}
