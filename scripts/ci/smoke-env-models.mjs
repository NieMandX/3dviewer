import assert from 'node:assert/strict';

export async function runEnvModelsSmoke(browser, baseUrl) {
    const page = await browser.newPage();
    try {
        await page.goto(`${baseUrl}/__smoke_blank`);
        const result = await page.evaluate(async () => {
            const T = await import('three');
            const { classifyZIP } = await import('/scripts/modules/io/model-category.js');
            const { createFBXFileHandler } = await import('/scripts/modules/io/fbx-file.js');
            const { createZIPFileHandler } = await import('/scripts/modules/io/zip-file.js');
            const { createVisibilityAndCollisions } = await import('/scripts/modules/ui/visibility-collisions.js');
            const { createMaterialsPanelController } = await import('/scripts/modules/ui/materials-panel.js');
            const world = new T.Group(), loadedModels = [];
            const makeRoot = () => {
                const root = new T.Group();
                root.add(new T.Mesh(new T.BoxGeometry(), new T.MeshStandardMaterial()));
                const hidden = root.children[0].clone(); hidden.visible = false; root.add(hidden);
                return root;
            };
            const handleFBXFile = createFBXFileHandler({
                THREE: T, world, loadedModels,
                parseFBXOnMainThread: () => ({ obj: makeRoot() }),
            });
            await handleFBXFile(new File(['fixture'], 'SM_context.fbx'));
            // Exercise both real ZIP orchestration paths. The parser is a stub:
            // this test isolates classification before FBX normalization.
            for (const worker of [true, false]) {
                for (const [name, geo] of [['0123_NPM.zip', false], ['SM_incomplete.zip', false], ['context.zip', false], ['renamed.zip', true]]) {
                    const entry = { name: 'model.fbx', async: async () => new ArrayBuffer(1) };
                    const entries = geo ? [entry, { name: 'model.geojson', async: async () => new TextEncoder().encode('{}') }] : [entry];
                    const handleZIP = createZIPFileHandler({
                        loadedModels, handleFBXFile,
                        makeGeoJsonMeta: () => ({ featureCount: 1 }),
                        unpackZIPInWorker: worker ? async (file, callbacks) => {
                            callbacks.onMeta({ counts: { geojson: Number(geo) } });
                            if (geo) await callbacks.onGeoJSON({ name: 'model.geojson', text: '{}' });
                            await callbacks.onFBX({ blob: new Blob(['fixture']), fileName: 'model.fbx' });
                        } : null,
                        JSZip: { loadAsync: async () => ({ files: Object.fromEntries(entries.map(e => [e.name, e])) }) },
                    });
                    await handleZIP(new File(['zip'], name));
                }
            }
            const categories = loadedModels.map(m => [m.sourceContainer, m.category, m.zipKind]);
            const outEl = document.createElement('div'); document.body.append(outEl);
            const panel = createMaterialsPanelController({ world, loadedModels, outEl });
            panel.renderMaterialsPanel();
            const visibility = createVisibilityAndCollisions({ world, loadedModels, outEl });
            visibility.toggleEnvModelsVisible();
            const hidden = loadedModels.map(m => m.obj.visible);
            visibility.toggleNPMModelsVisible();
            const envStillHidden = !loadedModels[0].obj.visible;
            visibility.toggleEnvModelsVisible();
            const preserved = loadedModels[0].obj.children[1].visible === false;
            const eye = outEl.querySelector(`[data-target="file-${loadedModels[0].obj.uuid}"]`);
            visibility.handleEyeToggle(eye);
            const eyeHidesEnv = loadedModels[0].obj.visible === false;
            visibility.handleEyeToggle(eye);
            const eyeRestoresEnv = loadedModels[0].obj.visible === true;
            panel.dispose();
            return { categories, hidden, envStillHidden, preserved, eyeHidesEnv, eyeRestoresEnv,
                classifications: [classifyZIP('0123_NPM.zip'), classifyZIP('SM_bad.zip'), classifyZIP('plain.zip'), classifyZIP('plain.zip', true)] };
        });
        assert.deepEqual(result.classifications, ['NPM', 'SM', 'ENV', 'SM']);
        assert.deepEqual(result.categories, [
            ['file', 'ENV', null],
            ...Array.from({ length: 2 }, () => [['zip', 'NPM', 'NPM'], ['zip', 'SM', 'SM'], ['zip', 'ENV', 'ENV'], ['zip', 'SM', 'SM']]).flat(),
        ]);
        assert.deepEqual(result.hidden, [false, true, true, false, true, true, true, false, true]);
        for (const key of ['envStillHidden', 'preserved', 'eyeHidesEnv', 'eyeRestoresEnv']) assert.equal(result[key], true, key);
    } finally { await page.close(); }
}
