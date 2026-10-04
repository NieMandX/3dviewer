import assert from 'node:assert/strict';

export async function runMaterialAccessSmoke(browser, baseUrl) {
    const page = await browser.newPage();
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    try {
        await page.goto(`${baseUrl}/__smoke_blank`);
        const result = await page.evaluate(async () => {
            const T = await import('three');
            const { createMaterialAccess } = await import('/scripts/modules/ui/material-access.js');
            const { createMaterialEditor } = await import('/scripts/modules/ui/material-editor.js');
            const { createTexturesUI } = await import('/scripts/modules/ui/textures-ui.js');
            const { createRoomMaterialSettings } = await import('/scripts/modules/collab/material-settings.js');
            document.body.innerHTML = '<button id="sceneTab">Сцена</button><button id="materialsTab">Материалы</button><div id="scenePanel"></div><section id="materialEditor" hidden></section><details id="imagesDetails"><div id="gallery"></div></details><span id="count"></span><select id="matSelect"></select><div id="texModal"><img id="mImg"></div>';
            const renderer = new T.WebGLRenderer(); renderer.setSize(128, 128); document.body.append(renderer.domElement);
            const render = renderer.render.bind(renderer); let previewRenders = 0, previewDecodes = 0;
            renderer.render = (...args) => { previewRenders++; return render(...args); };
            const bitmap = globalThis.createImageBitmap;
            globalThis.createImageBitmap = (...args) => { previewDecodes++; return bitmap(...args); };
            const world = new T.Group(), scene = new T.Scene(), camera = new T.PerspectiveCamera(); scene.add(world);
            const root = new T.Group(), localRoot = new T.Group(); world.add(root, localRoot);
            const roomMesh = new T.Mesh(new T.BoxGeometry(), new T.MeshStandardMaterial({ color: '#aa4422', roughness: .8 })); roomMesh.material.name = 'Room'; root.add(roomMesh);
            const localMesh = new T.Mesh(new T.BoxGeometry(), new T.MeshStandardMaterial({ color: '#2244aa' })); localMesh.material.name = 'Local'; localRoot.add(localMesh);
            const context = { authenticated: false, registered: false, roomId: '', suspended: false };
            const localRecord = { obj: localRoot, name: 'local.glb', scope: { kind: 'local', fileKey: 'local' } };
            const roomRecord = { obj: root, name: 'room.glb', scope: { kind: 'room', roomId: 'room', modelId: 'model' } };
            const models = [localRecord];
            const access = createMaterialAccess({ getContext: () => context, loadedModels: models });
            const editor = createMaterialEditor({ loadedModels: models, world, scene, camera, renderer, rendererReady: Promise.resolve(), controls: { enabled: true }, requestRender() {},
                getMaterialModels: access.getModels, canUseMaterialModel: access.canUseModel });
            const dom = Object.fromEntries(['imagesDetails','texModal','mImg'].map(id=>[id,document.getElementById(id)]));
            dom.galleryEl = document.querySelector('#gallery'); dom.texCountEl = document.querySelector('#count');
            const textures = createTexturesUI({ THREE: T, dom, loadedModels: models, world,
                canUseTexture: access.canUseTexture, canUseMaterialObject: access.canUseObject });
            const canvas = document.createElement('canvas'); canvas.width = canvas.height = 8; canvas.getContext('2d').fillRect(0, 0, 8, 8);
            const entries = [{ short: 'local', scope: localRecord.scope, url: canvas.toDataURL() }, { short: 'room', scope: roomRecord.scope, url: canvas.toDataURL() }];
            const tab = document.querySelector('#materialsTab'), host = document.querySelector('#materialEditor');
            const refresh = () => { editor.refresh(); textures.renderGallery(entries); };
            const blocked = () => tab.hidden && host.hidden && dom.imagesDetails.hidden && !dom.galleryEl.querySelector('canvas') && !host.querySelector('.me-card');
            try {
                refresh(); tab.click(); const anonymousLocal = blocked();
                context.authenticated = context.registered = true; refresh(); tab.click(); const registeredLocal = blocked();
                const localNotPrepared = !localMesh.userData._editorOriginalMaterials;
                context.roomId = 'room'; models.push(roomRecord); refresh();
                const entitled = !tab.hidden && !dom.imagesDetails.hidden && dom.galleryEl.querySelectorAll('canvas').length === 1;
                tab.click(); const names = [...host.querySelectorAll('.me-card span')].map(e=>e.textContent);
                const roughness = host.querySelector('#me-roughness'); roughness.value = '.22'; roughness.dispatchEvent(new Event('change', { bubbles: true }));
                const color = host.querySelector('#meColor'); color.value = '#33aa66'; color.dispatchEvent(new Event('change', { bubbles: true }));
                const saved = editor.serialize();
                const staleThumb = dom.galleryEl.querySelector('.thumb'); staleThumb.click();
                const opened = dom.texModal.classList.contains('show');
                context.registered = false; refresh();
                staleThumb.click(); tab.click();
                const guestClosed = blocked() && !dom.texModal.classList.contains('show') && !dom.mImg.hasAttribute('src');
                await new Promise(r=>setTimeout(r,80));
                const rendersBefore = previewRenders, decodesBefore = previewDecodes;
                roomMesh.material.roughness = .9; roomMesh.material.color.set('#000000');
                const persistence = createRoomMaterialSettings({ getContext: () => ({ roomId: 'room', controller }), apply: (data, guards) => editor.applySettings(data, guards) });
                const controller = { supabase: { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { document: saved, revision: 1 } }) }) }) }) } };
                await persistence.refresh(models); await new Promise(r=>setTimeout(r,80));
                const guestPlayback = roomMesh.material.roughness === .22 && roomMesh.material.color.getHexString() === '33aa66';
                const noGuestPreviews = rendersBefore === previewRenders && decodesBefore === previewDecodes && blocked();
                const localUntouched = localMesh.material.color.getHexString() === '2244aa';
                persistence.dispose();
                context.registered = true; refresh(); tab.click();
                host.querySelector('[data-action=pick]').click();
                const picking = editor.picking;
                context.suspended = true; refresh();
                const teardown = blocked() && !editor.picking;
                context.suspended = false; context.roomId = 'other'; refresh(); const otherRoom = blocked();
                context.roomId = 'room'; refresh(); models.splice(models.indexOf(roomRecord),1); refresh(); const removed = blocked();
                return { anonymousLocal, registeredLocal, localNotPrepared, entitled, names, opened, guestClosed, guestPlayback, noGuestPreviews, localUntouched, picking, teardown, otherRoom, removed };
            } finally {
                textures.dispose(); editor.dispose(); renderer.dispose(); globalThis.createImageBitmap = bitmap;
                for (const obj of [roomMesh,localMesh]) { obj.geometry.dispose(); obj.material.dispose(); }
            }
        });
        assert.deepEqual(result.names, ['Room']);
        for (const [key,value] of Object.entries(result)) if (key !== 'names') assert.equal(value, true, key);
        assert.deepEqual(errors, []);
        console.log('[smoke] registered room-only material UI and guest saved-material playback passed');
    } finally { await page.close(); }
}
