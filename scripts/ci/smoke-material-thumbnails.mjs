import assert from 'node:assert/strict';

export async function runMaterialThumbnailsSmoke(browser, baseUrl) {
    const page = await browser.newPage();
    const errors = []; page.on('pageerror', (error) => errors.push(error.message));
    try {
        await page.goto(`${baseUrl}/__smoke_blank`, { waitUntil: 'domcontentloaded' });
        const result = await page.evaluate(async () => {
            const { checkMaterialThumbnails } = await import('/scripts/ci/material-thumbnails-fixture.js');
            const webgl = [];
            for (const pixelRatio of [1, 2]) webgl.push(await checkMaterialThumbnails({ webgpu: false, pixelRatio }));
            const adapter = await navigator.gpu?.requestAdapter();
            const webgpu = [];
            if (adapter) for (const pixelRatio of [1, 2]) webgpu.push(await checkMaterialThumbnails({ pixelRatio }));
            return { webgl, webgpu };
        });
        for (const value of [...result.webgl, ...result.webgpu]) {
            assert.deepEqual(value.errors, [], `${value.backend}: no destroyed texture submissions`);
            assert.equal(value.thumbnailCount, 6);
            assert.equal(value.sceneDrawn, true);
            assert.equal(value.physicalMaterialsPreserved, true);
            assert.equal(value.targetsRestored, true);
            assert.equal(value.viewportRestored, true, 'Thumbnail must preserve viewport, scissor and pixel ratio');
            assert.equal(value.uniformColorEdits, true, 'Color edits refresh previews without a shader rebuild');
        }
        for (const group of [result.webgl, result.webgpu]) if (group.length) {
            assert.equal(group[0].firstPreviewHash, group[1].firstPreviewHash, `${group[0].backend}: Retina preview must have identical framing and pixels`);
        }
        assert.deepEqual(errors, []);
        console.log(`[smoke] glass, flowing water, Retina thumbnails and resize passed (WebGL${result.webgpu.length ? ' + WebGPU' : '; WebGPU adapter unavailable in this runner'})`);
    } finally { await page.close(); }
}
