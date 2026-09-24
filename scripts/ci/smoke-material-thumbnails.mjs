import assert from 'node:assert/strict';

export async function runMaterialThumbnailsSmoke(browser, baseUrl) {
    const page = await browser.newPage();
    const errors = []; page.on('pageerror', (error) => errors.push(error.message));
    try {
        await page.goto(`${baseUrl}/__smoke_blank`, { waitUntil: 'domcontentloaded' });
        const result = await page.evaluate(async () => {
            const { checkMaterialThumbnails } = await import('/scripts/ci/material-thumbnails-fixture.js');
            const webgl = await checkMaterialThumbnails({ webgpu: false });
            const adapter = await navigator.gpu?.requestAdapter();
            const webgpu = adapter ? await checkMaterialThumbnails() : null;
            return { webgl, webgpu };
        });
        for (const value of [result.webgl, result.webgpu].filter(Boolean)) {
            assert.deepEqual(value.errors, [], `${value.backend}: no destroyed texture submissions`);
            assert.equal(value.thumbnailCount, 6);
            assert.equal(value.sceneDrawn, true);
            assert.equal(value.physicalMaterialsPreserved, true);
            assert.equal(value.targetsRestored, true);
        }
        assert.deepEqual(errors, []);
        console.log(`[smoke] glass, flowing water, thumbnails and resize passed (WebGL${result.webgpu ? ' + WebGPU' : '; WebGPU adapter unavailable in this runner'})`);
    } finally { await page.close(); }
}
