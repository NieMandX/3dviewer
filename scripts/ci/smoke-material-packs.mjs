import assert from 'node:assert/strict';

export async function runMaterialPacksSmoke(browser, baseUrl) {
    const page = await browser.newPage(); const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    try {
        await page.goto(`${baseUrl}/__smoke_blank`, { waitUntil: 'domcontentloaded' });
        const results = await page.evaluate(async () => {
            const { checkMaterialPacks } = await import('/scripts/ci/material-packs-fixture.js');
            const results = [await checkMaterialPacks()];
            if (await navigator.gpu?.requestAdapter()) results.push(await checkMaterialPacks({ webgpu: true }));
            return results;
        });
        for (const result of results) {
            assert.deepEqual(result.errors, [], `${result.backend}: no GPU errors`);
            for (const [key, value] of Object.entries(result)) if (!['backend', 'errors'].includes(key)) assert.equal(value, true, `${result.backend}: ${key}`);
        }
        assert.deepEqual(errors, []);
        console.log(`[smoke] material eyedropper, portable packs, water, room restore and stale loads passed (${results.map((r) => r.backend).join(' + ')})`);
    } finally { await page.close(); }
}
