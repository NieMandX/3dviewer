// Small real-renderer fixture. Storage is mocked here; RLS is tested on PostgreSQL.
export async function checkMaterialPacks({ webgpu = false } = {}) {
    const T = await import('three');
    const { createRenderer } = await import('../modules/render/renderer-init.js');
    const { createMaterialEditor } = await import('../modules/ui/material-editor.js');
    const { createProjectMaterialPacks } = await import('../modules/collab/project-material-packs.js');
    const { collectSceneMaterials, captureParsedMaterials } = await import('../modules/material/scene-materials.js');
    const { createPresetMaterial } = await import('../modules/material/material-presets.js');
    const { matchMaterialPack, preparePackMaterials } = await import('../modules/material/material-pack.js');
    const { collectMaterialTextures } = await import('../modules/material/texture-utils.js');
    const W = webgpu ? await import('three/webgpu') : null;
    const owner = createRenderer({ THREE: T, useWebGPU: webgpu, WebGPURendererCtor: W?.WebGPURenderer });
    await owner.rendererInitPromise;
    const renderer = owner.renderer; renderer.setSize(360, 240);
    const gpu = renderer.backend?.device, errors = [], onError = (event) => errors.push(event.error.message);
    gpu?.addEventListener('uncapturederror', onError);
    document.body.innerHTML = '<button id="sceneTab">Сцена</button><button id="materialsTab">Материалы</button><div id="scenePanel"></div><section id="materialEditor" hidden></section>';
    Object.assign(renderer.domElement.style, { position: 'fixed', top: '0', left: '0' }); document.body.append(renderer.domElement);
    const scene = new T.Scene(), world = new T.Group(), sourceRoot = new T.Group(), root = new T.Group(); scene.add(world); world.add(root);
    world.position.set(-100000, 0, -200000); root.position.set(100000, 0, 200000);
    scene.background = new T.Color('#637585'); scene.add(new T.HemisphereLight(0xffffff, 0x444444, 3));
    const camera = new T.PerspectiveCamera(50, 1.5, .1, 100); camera.position.set(0, 0, 10); camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
    const controls = { enabled: true, target: new T.Vector3() }, geometry = new T.PlaneGeometry(2, 2);
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64; canvas.getContext('2d').fillStyle = '#a25732'; canvas.getContext('2d').fillRect(0, 0, 64, 64);
    const map = new T.CanvasTexture(canvas); map.wrapS = T.MirroredRepeatWrapping; map.repeat.set(2, 3); map.center.set(.3, .4); map.rotation = .2; map.flipY = false; map.colorSpace = T.SRGBColorSpace;
    const brick = new T.MeshPhysicalMaterial({ name: 'Кирпич', roughness: .37, map }); brick.clearcoatMap = map; brick.normalScale.setScalar(2);
    const metal = new T.MeshPhysicalMaterial({ name: 'Сталь', metalness: 1, roughness: .15, map: map.clone() }); metal.map.repeat.set(4, 5);
    const glass = createPresetMaterial('glass'); glass.name = 'Стекло';
    const water = createPresetMaterial('water'); water.name = 'Вода';
    const field = document.createElement('canvas'); field.width = field.height = 16; field.getContext('2d').fillStyle = '#ff80ff'; field.getContext('2d').fillRect(0, 0, 16, 16);
    water.userData.lpmview_water = { version: 2, origin: [99995, 199995], extent: [10, 10], tileMeters: 6, cycleSeconds: 8, metersPerSecond: .2, speed: 12, flowMap: field.toDataURL(), specularColor: [2, 2, 2], network: { nodes: [{ id: 'a', position: [100000, 0, 200000] }, { id: 'b', position: [100000, 0, 200002] }], edges: [['a', 'b']] } };
    for (const m of [brick, metal, glass, water]) sourceRoot.add(new T.Mesh(geometry, m));
    captureParsedMaterials(sourceRoot);
    const blobs = new Map(), records = new Map(); let failUpload = false, cleanupCalls = 0;
    const projectId = '10000000-0000-0000-0000-000000000061', roomId = '20000000-0000-0000-0000-000000000061';
    const bucket = { upload: async (key, blob) => { if (failUpload) return { error: Error('offline') }; blobs.set(key, blob); return {}; }, download: async (key) => ({ data: blobs.get(key) }), remove: async (keys) => { cleanupCalls++; keys.forEach((key) => blobs.delete(key)); return {}; } };
    const client = {
        storage: { from: () => bucket },
        from: () => { const filters = {}; const query = { select: () => query, eq: (k, v) => { filters[k] = v; return query; }, order: async () => ({ data: [...records.values()].filter((r) => r.project_id === filters.project_id) }), maybeSingle: async () => ({ data: [...records.values()].find((r) => Object.entries(filters).every(([k, v]) => r[k] === v)) || null }) }; return query; },
        rpc: async (_, p) => { records.set(p.p_id, { id: p.p_id, project_id: p.p_project_id, name: p.p_name, source_model: p.p_source_model, material_count: p.p_material_count, texture_count: p.p_texture_count, created_at: new Date().toISOString() }); return { data: p.p_id }; },
    };
    let context = { controller: { project: { id: projectId, name: 'Test' }, room: { id: roomId }, supabase: client }, canManage: true };
    const store = createProjectMaterialPacks({ getContext: () => context });
    const sourceEntries = [...collectSceneMaterials([{ obj: sourceRoot }]).values()];
    let editor;
    try {
        const saved = await store.save({ name: 'Основные материалы', sourceModel: 'revision-1.glb', entries: sourceEntries });
        const source = await store.open(saved.id), list = await store.list();
        const fullPack = source.pack.materials.length === 4 && list.length === 1 && source.pack.textureCount === 3;
        const png = await source.loadAsset(source.pack.materials[0].maps.map.asset);
        const image = await createImageBitmap(png); const nativeResolution = image.width === 64; image.close();
        const imageDeduplication = source.pack.materials[0].maps.map.asset === source.pack.materials[1].maps.map.asset && source.pack.materials[0].maps.map.asset === source.pack.materials[0].maps.clearcoatMap.asset;
        // A new revision changes material ordering and model IDs.
        const target = {};
        for (const [i, name] of ['Стекло', 'Вода', 'Кирпич', 'Сталь', 'Новый материал'].entries()) {
            const m = new T.MeshPhysicalMaterial({ name, roughness: .9 }); const object = new T.Mesh(geometry, m); object.position.x = (i - 2) * 2.2; root.add(object); target[name] = object;
        }
        const models = [{ obj: root, name: 'revision-2.glb', scope: { roomId, modelId: 'new-model' } }];
        captureParsedMaterials(root);
        editor = createMaterialEditor({ renderer, rendererReady: owner.rendererInitPromise, scene, world, camera, controls, useWebGPU: webgpu, loadedModels: models, projectPacks: store, requestRender() {}, getEnvironment: () => null });
        document.querySelector('#materialsTab').click();
        const entries = [...collectSceneMaterials(models).values()], match = matchMaterialPack(source.pack, entries);
        const nameMatching = match.matches.length === 4 && match.missing.length === 1;
        const duplicate = { material: brick, uses: [] };
        const ambiguousSafe = matchMaterialPack(source.pack, [...entries, duplicate]).ambiguous.includes('Кирпич');
        document.querySelector('.me-packs').open = true;
        for (let i = 0; i < 100 && document.querySelector('[data-pack-list]').options.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
        document.querySelector('[data-pack-list]').value = saved.id;
        document.querySelector('[data-pack-list]').dispatchEvent(new Event('change', { bubbles: true }));
        document.querySelector('[data-pack-action=preview]').click();
        for (let i = 0; i < 100 && document.querySelector('[data-pack-action=apply]').disabled; i++) await new Promise((r) => setTimeout(r, 10));
        const uiPreview = document.querySelector('[data-pack-summary]').textContent.includes('Совпало: 4');
        document.querySelector('[data-pack-action=apply]').click();
        for (let i = 0; i < 200 && document.querySelector('#materialEditor').getAttribute('aria-busy') === 'true'; i++) await new Promise((r) => setTimeout(r, 10));
        const uiApplied = document.querySelector('[data-pack-summary]').textContent.includes('Применено материалов: 4');
        renderer.render(scene, camera);
        const properties = target.Кирпич.material.roughness === .37 && target.Стекло.material.ior === 3 && target.Сталь.material.metalness === 1 && target['Новый материал'].material.roughness === .9;
        const textureSettings = target.Кирпич.material.map.wrapS === T.MirroredRepeatWrapping && target.Кирпич.material.map.flipY === false && target.Сталь.material.map.repeat.x === 4 && target.Кирпич.material.map.center.x === .3;
        const animatedWater = !!target.Вода.material.riverFlow && target.Вода.material.riverFlow.speed === 12 && target.Вода.material.userData.lpmview_water.network.edges.length === 1;
        const room = editor.serialize();
        const roomReferencesPack = room.materials.length === 4 && room.materials.every((m) => m.pack === saved.id && m.portable) && JSON.stringify(room).length < 15000;
        editor.setMode(true); const originalComparison = target.Кирпич.material.roughness === .9 && !target.Вода.material.riverFlow; editor.setMode(false);
        target.Кирпич.material.roughness = .8; await editor.applySettings(room); renderer.render(scene, camera);
        const roomRoundtrip = target.Кирпич.material.roughness === .37 && !!target.Вода.material.riverFlow && editor.serialize().materials.every((m) => m.portable);
        document.querySelector('[data-pack-name]').value = 'Вторая версия'; document.querySelector('[data-pack-action=save]').click();
        const animationSuspended = target.Вода.material.riverFlow.suspended === true && target.Вода.material.riverFlow.playing === true;
        for (let i = 0; i < 200 && document.querySelector('#materialEditor').getAttribute('aria-busy') === 'true'; i++) await new Promise((r) => setTimeout(r, 10));
        const uiSaved = records.size === 2 && document.querySelector('.me-status').textContent.includes('сохранена в проекте') && editor.serialize().materials.length === 5;
        const animationResumed = !target.Вода.material.riverFlow.suspended && target.Вода.material.riverFlow.playing;
        const legacyDescriptor = structuredClone(source.pack.materials.find((m) => m.name === 'Вода'));
        legacyDescriptor.water.version = 1; delete legacyDescriptor.water.network;
        const legacy = await preparePackMaterials([legacyDescriptor], { loadAsset: source.loadAsset, useWebGPU: webgpu });
        const legacyWater = !!legacy.results[0].runtime && legacy.results[0].material.userData.lpmview_water.version === 1; legacy.dispose();
        // Multimaterial face under cursor; hidden parent must not intercept it.
        const box = new T.Mesh(new T.BoxGeometry(1, 1, 1), Array.from({ length: 6 }, (_, i) => new T.MeshPhysicalMaterial({ name: `Грань ${i}` })));
        box.position.z = 3; root.add(box);
        const hidden = new T.Group(), blocker = new T.Mesh(geometry, new T.MeshPhysicalMaterial({ name: 'Скрытый' })); blocker.position.z = 5; hidden.add(blocker); hidden.visible = false; root.add(hidden);
        editor.refresh();
        const rect = renderer.domElement.getBoundingClientRect(), event = (type, x = 180, y = 120) => renderer.domElement.dispatchEvent(new PointerEvent(type, { button: 0, isPrimary: true, pointerId: 1, clientX: rect.left + x, clientY: rect.top + y }));
        document.querySelector('.me-search').value = 'Вода'; document.querySelector('.me-search').dispatchEvent(new Event('input'));
        document.querySelector('[data-action=pick]').click(); event('pointerdown'); event('pointerup');
        const surfacePick = document.querySelector('.me-inspector h3').textContent === 'Грань 4' && !editor.picking && controls.enabled && document.querySelector('.me-search').value === '';
        const faces = box.material; box.material = faces[0];
        document.querySelector('[data-action=pick]').click(); event('pointerdown'); event('pointerup');
        const diagnosticPick = document.querySelector('.me-inspector h3').textContent === 'Грань 4'; box.material = faces;
        editor.setMode(true); document.querySelector('[data-action=pick]').click(); event('pointerdown'); event('pointerup');
        const originalPick = document.querySelector('.me-inspector h3').textContent === 'Грань 4' && editor.originalMode; editor.setMode(false);
        const instances = new T.InstancedMesh(box.geometry, new T.MeshPhysicalMaterial({ name: 'Инстанс' }), 1); instances.setMatrixAt(0, new T.Matrix4().makeTranslation(0, 0, 5)); root.add(instances); editor.refresh();
        document.querySelector('[data-action=pick]').click(); event('pointerdown'); event('pointerup');
        const instancedPick = document.querySelector('.me-inspector h3').textContent === 'Инстанс';
        document.querySelector('[data-action=pick]').click(); event('pointerdown'); event('pointermove', 200); event('pointerup', 200);
        const dragIgnored = editor.picking; document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        const cancelRestores = !editor.picking && controls.enabled;
        // Failure / stale response cannot assign partially prepared materials.
        const before = target.Кирпич.material; let release;
        const delayed = { ...source, loadAsset: () => new Promise((resolve) => { release = resolve; }) };
        const single = matchMaterialPack(source.pack, [...collectSceneMaterials(models).values()]).matches.filter((m) => m.entry.material.name === 'Кирпич');
        const pending = editor.applyPack({ matches: single, source: delayed }).then(() => false, (e) => e.name === 'AbortError');
        await Promise.resolve(); editor.cancelInteraction(); release(png);
        const staleRejected = await pending && target.Кирпич.material === before;
        let loadFailureSafe = false;
        try { await preparePackMaterials([source.pack.materials[0]], { loadAsset: async () => { throw Error('offline'); } }); } catch { loadFailureSafe = target.Кирпич.material === before; }
        failUpload = true;
        try { await store.save({ name: 'Не завершено', sourceModel: 'test', entries: sourceEntries }); } catch {}
        const failedNotPublished = records.size === 2 && cleanupCalls > 0;
        failUpload = false;
        const prior = context; let finishDownload; const originalDownload = bucket.download;
        bucket.download = () => new Promise((resolve) => { finishDownload = resolve; });
        const opening = store.open(saved.id).then(() => false, (e) => e.name === 'AbortError');
        for (let n = 0; !finishDownload && n < 20; n++) await Promise.resolve();
        context = { ...context, controller: { ...context.controller, room: { id: 'another-room' } } };
        finishDownload({ data: blobs.get(`${projectId}/${saved.id}/materials.json`) });
        const roomChangeRejected = await opening; bucket.download = originalDownload; context = prior;
        return { backend: webgpu ? 'webgpu' : 'webgl', errors, fullPack, nativeResolution, imageDeduplication, nameMatching, ambiguousSafe, uiPreview, uiApplied, uiSaved, animationSuspended, animationResumed, properties, textureSettings, animatedWater, legacyWater, roomReferencesPack, originalComparison, roomRoundtrip, surfacePick, diagnosticPick, originalPick, instancedPick, dragIgnored, cancelRestores, staleRejected, loadFailureSafe, failedNotPublished, roomChangeRejected };
    } finally {
        editor?.dispose(); store.dispose();
        const materials = new Set(), textures = new Set(), geometries = new Set();
        for (const r of [root, sourceRoot]) r.traverse((o) => {
            if (o.geometry) geometries.add(o.geometry);
            for (const value of [o.material, o.userData._origMaterial, o.userData._removedMaterials, o.userData._editorOriginalMaterials, o.userData._editorEditedMaterials]) for (const m of (Array.isArray(value) ? value : [value])) if (m) materials.add(m);
        });
        for (const m of materials) { collectMaterialTextures(m).forEach((t) => textures.add(t)); m.dispose(); }
        textures.forEach((t) => t.dispose()); geometries.forEach((g) => g.dispose());
        owner.dispose(); renderer.domElement.remove(); gpu?.removeEventListener('uncapturederror', onError);
    }
}
