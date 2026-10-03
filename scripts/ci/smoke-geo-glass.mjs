import assert from 'node:assert/strict';

export async function runGeoGlassSmoke(browser, baseUrl, { useWebGPU = false } = {}) {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    try {
        await page.goto(`${baseUrl}/__smoke_blank`, { waitUntil: 'domcontentloaded' });
        const result = await page.evaluate(async (useWebGPU) => {
            const T = await import('three');
            const { createGlassController } = await import('/scripts/modules/material/glass-controller.js');
            const { createRenderer } = await import('/scripts/modules/render/renderer-init.js');
            const owner = createRenderer({
                THREE: T, useWebGPU,
                WebGPURendererCtor: useWebGPU ? (await import('three/webgpu')).WebGPURenderer : null,
            });
            await owner.rendererInitPromise;
            const renderer = owner.renderer;
            if (useWebGPU && !renderer.backend.isWebGPUBackend) throw Error('Native WebGPU is required');
            renderer.setSize(32, 32);
            renderer.setPixelRatio(1);
            renderer.toneMapping = T.NoToneMapping;
            const scene = new T.Scene(), world = new T.Group();
            scene.add(world);
            scene.background = new T.Color(0);
            const camera = new T.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
            camera.position.z = 2;
            const target = new T.WebGLRenderTarget(32, 32);
            const geometry = new T.PlaneGeometry(2, 2);
            renderer.setRenderTarget(target);
            const values = [];
            try {
                // Basic isolates alpha blending from lighting/transmission; Physical
                // also checks the production glass state and cached original contract.
                for (const physical of [false, true]) {
                    for (const input of [0, 0.379, 1]) {
                        const Material = physical ? T.MeshPhysicalMaterial : T.MeshBasicMaterial;
                        const material = new Material({ color: 0xffffff, transparent: true, opacity: 0.8 });
                        material.name = 'M_Test_MainGlass_1';
                        const mesh = new T.Mesh(geometry, material), root = new T.Group();
                        root.userData.zipKind = 'SM';
                        root.userData._geojsonMeta = { parsed: { type: 'FeatureCollection', features: [{
                            type: 'ObjectFeature', Glasses: [{ M_Test_MainGlass_1: { transparency: input } }],
                        }] } };
                        root.add(mesh);
                        world.add(root);
                        const slider = document.createElement('input');
                        slider.type = 'range'; slider.min = '0'; slider.max = '1'; slider.step = '0.001';
                        slider.value = '0.1';
                        const controller = createGlassController({
                            THREE: T, scene, world, elements: { glassOpacityEl: slider },
                        });
                        try {
                            controller.applyToScene();
                            controller.applyToScene();
                            const original = material.userData.glassOriginal.opacity;
                            const initial = material.opacity;
                            const info = material.userData.glassInfo.opacity;
                            let pixel = null;
                            if (!physical) {
                                renderer.render(scene, camera);
                                const bytes = useWebGPU
                                    ? await renderer.readRenderTargetPixelsAsync(target, 16, 16, 1, 1)
                                    : await renderer.readRenderTargetPixelsAsync(target, 16, 16, 1, 1, new Uint8Array(4));
                                pixel = Array.from(bytes);
                            }
                            slider.value = '0.72'; slider.dataset.userSet = '1';
                            controller.applyToScene();
                            const global = material.opacity;
                            material.userData.glassOverrides = { opacity: 0.24 };
                            controller.applyToScene();
                            const individual = material.opacity;
                            controller.resetToOriginal();
                            values.push({ input, physical, initial, original, info, pixel, global, individual,
                                reset: material.opacity, cachedOriginal: material.userData.glassOriginal.opacity,
                                overridesCleared: !material.userData.glassOverrides && !slider.dataset.userSet,
                            });
                        } finally {
                            controller.dispose(); world.remove(root); material.dispose();
                        }
                    }
                }
                return values;
            } finally {
                renderer.setRenderTarget(null);
                geometry.dispose(); target.dispose(); await owner.dispose();
            }
        }, useWebGPU);
        for (const row of result) {
            const label = `${useWebGPU ? 'WebGPU' : 'WebGL'} ${row.physical ? 'Physical' : 'Basic'} ${row.input}`;
            for (const key of ['initial', 'original', 'info', 'reset', 'cachedOriginal']) {
                assert.equal(row[key], row.input, `${label}: ${key} must use the GeoJSON opacity convention`);
            }
            assert.equal(row.global, 0.72, `${label}: global opacity`);
            assert.equal(row.individual, 0.24, `${label}: material override`);
            assert.equal(row.overridesCleared, true, `${label}: reset clears overrides`);
            if (row.pixel) {
                for (const channel of row.pixel.slice(0, 3)) {
                    assert.ok(Math.abs(channel - Math.round(row.input * 255)) <= 2, `${label}: alpha blending pixel`);
                }
            }
        }
        assert.deepEqual(errors, []);
        console.log(`[smoke] GeoJSON glass opacity, pixels, overrides and reset passed (${useWebGPU ? 'WebGPU' : 'WebGL'})`);
    } finally {
        await page.close();
    }
}
