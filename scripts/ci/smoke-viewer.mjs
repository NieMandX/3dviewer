import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const roomProject = process.env.LPMVIEW_SMOKE_PROJECT || 'shmit';
const roomSlug = process.env.LPMVIEW_SMOKE_ROOM || '1';

const MIME_TYPES = new Map([
    ['.css', 'text/css; charset=utf-8'],
    ['.exr', 'application/octet-stream'],
    ['.fbx', 'application/octet-stream'],
    ['.hdr', 'application/octet-stream'],
    ['.html', 'text/html; charset=utf-8'],
    ['.ico', 'image/x-icon'],
    ['.jpeg', 'image/jpeg'],
    ['.jpg', 'image/jpeg'],
    ['.js', 'text/javascript; charset=utf-8'],
    ['.json', 'application/json; charset=utf-8'],
    ['.png', 'image/png'],
    ['.svg', 'image/svg+xml'],
    ['.webp', 'image/webp'],
    ['.zip', 'application/zip'],
]);

function resolveFsPath(urlPathname) {
    const normalizedPath = normalize(decodeURIComponent(urlPathname.split('?')[0] || '/'));
    const relativePath = normalizedPath === '/' ? 'index.html' : normalizedPath.replace(/^\/+/, '');
    const absolutePath = resolve(projectRoot, relativePath);
    const relativeToRoot = relative(projectRoot, absolutePath);
    if (relativeToRoot.startsWith('..') || isAbsolute(relativeToRoot)) {
        return null;
    }
    return absolutePath;
}

async function createStaticServer() {
    const server = createServer(async (req, res) => {
        try {
            if (String(req.url || '').startsWith('/__smoke_blank')) {
                const body = Buffer.from('<!doctype html><meta charset="utf-8"><title>LPM smoke</title>');
                res.writeHead(200, {
                    'Content-Length': body.length,
                    'Content-Type': 'text/html; charset=utf-8',
                });
                res.end(body);
                return;
            }

            const fsPath = resolveFsPath(req.url || '/');
            if (!fsPath) {
                res.writeHead(403);
                res.end('Forbidden');
                return;
            }

            const fileStats = await stat(fsPath);
            if (!fileStats.isFile()) {
                res.writeHead(404);
                res.end('Not found');
                return;
            }

            const body = await readFile(fsPath);
            const contentType = MIME_TYPES.get(extname(fsPath).toLowerCase()) || 'application/octet-stream';
            res.writeHead(200, {
                'Content-Length': body.length,
                'Content-Type': contentType,
            });
            res.end(body);
        } catch (error) {
            const code = error?.code === 'ENOENT' ? 404 : 500;
            res.writeHead(code);
            res.end(code === 404 ? 'Not found' : 'Internal server error');
        }
    });

    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });

    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('Failed to resolve smoke server address');
    }

    return {
        server,
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((resolve, reject) => {
            server.close((error) => {
                if (error) reject(error);
                else resolve();
            });
        }),
    };
}

function attachPageDiagnostics(page, options = {}) {
    const consoleErrors = [];
    const pageErrors = [];
    const ignoreConsoleError =
        typeof options.ignoreConsoleError === 'function' ? options.ignoreConsoleError : () => false;

    page.on('console', (message) => {
        if (message.type() !== 'error') return;
        const text = message.text();
        if (!ignoreConsoleError(text)) consoleErrors.push(text);
    });
    page.on('pageerror', (error) => {
        pageErrors.push(String(error));
    });

    return {
        assertNoErrors(context) {
            assert.equal(pageErrors.length, 0, `${context}: page errors\n${pageErrors.join('\n')}`);
            assert.equal(consoleErrors.length, 0, `${context}: console errors\n${consoleErrors.join('\n')}`);
        },
    };
}

async function runBootSmoke(browser, baseUrl) {
    const page = await browser.newPage();
    const diagnostics = attachPageDiagnostics(page);
    await page.goto(`${baseUrl}/?renderer=webgl`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForFunction(() => (
        !!globalThis.viewerApp && !document.body.classList.contains('app-loading')
    ), null, { timeout: 45000 });

    const state = await page.evaluate(() => ({
        appReady: !!globalThis.viewerApp,
        loading: document.body.classList.contains('app-loading'),
        activeRenderer: globalThis.__LPMVIEW_ACTIVE_RENDERER || null,
    }));
    const webgpuImports = await page.evaluate(async () => {
        const [webgpu, tsl] = await Promise.all([
            import('three/webgpu'),
            import('three/tsl'),
        ]);
        return {
            webgpuRenderer: !!webgpu.WebGPURenderer,
            meshBasicNodeMaterial: !!webgpu.MeshBasicNodeMaterial,
            normalView: !!tsl.normalView,
            positionViewDirection: !!tsl.positionViewDirection,
        };
    });

    assert.equal(state.appReady, true, 'Boot smoke: viewerApp not initialized');
    assert.equal(state.loading, false, 'Boot smoke: body still in app-loading state');
    assert.equal(state.activeRenderer, 'webgl', 'Boot smoke: unexpected renderer mode');
    assert.equal(webgpuImports.webgpuRenderer, true, 'Boot smoke: three/webgpu WebGPURenderer export missing');
    assert.equal(webgpuImports.meshBasicNodeMaterial, true, 'Boot smoke: three/webgpu MeshBasicNodeMaterial export missing');
    assert.equal(webgpuImports.normalView, true, 'Boot smoke: three/tsl normalView export missing');
    assert.equal(webgpuImports.positionViewDirection, true, 'Boot smoke: three/tsl positionViewDirection export missing');
    diagnostics.assertNoErrors('Boot smoke');
    await page.close();
}

async function runRoomEntrySmoke(browser, baseUrl) {
    const page = await browser.newPage();
    const diagnostics = attachPageDiagnostics(page);
    const targetUrl = `${baseUrl}/?project=${encodeURIComponent(roomProject)}&room=${encodeURIComponent(roomSlug)}&renderer=webgl`;
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForFunction(() => (
        !!globalThis.viewerApp &&
        !document.body.classList.contains('app-loading') &&
        document.body.classList.contains('room-entry-landing') &&
        document.querySelector('#collabDrawer')?.hidden === false &&
        document.querySelector('#collabAuthPanel')?.dataset?.mode === 'roomEntry' &&
        (() => {
            const guestBtn = document.querySelector('#collabGuestBtn');
            return !!guestBtn && guestBtn.offsetParent !== null && guestBtn.disabled === false;
        })()
    ), null, { timeout: 45000 });

    const state = await page.evaluate(() => {
        const guestBtn = document.querySelector('#collabGuestBtn');
        return {
            appReady: !!globalThis.viewerApp,
            loading: document.body.classList.contains('app-loading'),
            roomEntryLanding: document.body.classList.contains('room-entry-landing'),
            drawerHidden: document.querySelector('#collabDrawer')?.hidden ?? null,
            authMode: document.querySelector('#collabAuthPanel')?.dataset?.mode || null,
            guestVisible: !!guestBtn && guestBtn.offsetParent !== null,
            guestDisabled: guestBtn?.disabled ?? null,
        };
    });

    assert.equal(state.appReady, true, 'Room smoke: viewerApp not initialized');
    assert.equal(state.loading, false, 'Room smoke: body still in app-loading state');
    assert.equal(state.roomEntryLanding, true, 'Room smoke: room-entry landing state missing');
    assert.equal(state.drawerHidden, false, 'Room smoke: collab drawer is closed');
    assert.equal(state.authMode, 'roomEntry', 'Room smoke: unexpected auth mode');
    assert.equal(state.guestVisible, true, 'Room smoke: guest button is not visible');
    assert.equal(state.guestDisabled, false, 'Room smoke: guest button is disabled');
    diagnostics.assertNoErrors('Room smoke');
    await page.close();
}

async function runDisposeReinitSmoke(browser, baseUrl) {
    const page = await browser.newPage();
    await page.addInitScript(() => {
        const nativeAdd = EventTarget.prototype.addEventListener;
        const nativeRemove = EventTarget.prototype.removeEventListener;
        const registry = new WeakMap();

        function captureFlag(options) {
            if (options === true) return true;
            if (!options || typeof options !== 'object') return false;
            return !!options.capture;
        }

        function getTargetEntries(target, type, create = false) {
            let byType = registry.get(target);
            if (!byType && create) {
                byType = new Map();
                registry.set(target, byType);
            }
            if (!byType) return null;
            let entries = byType.get(type);
            if (!entries && create) {
                entries = [];
                byType.set(type, entries);
            }
            return entries || null;
        }

        EventTarget.prototype.addEventListener = function patchedAddEventListener(type, listener, options) {
            if (listener) {
                const eventType = String(type || '');
                const capture = captureFlag(options);
                const entries = getTargetEntries(this, eventType, true);
                const exists = entries.some((entry) => entry.listener === listener && entry.capture === capture);
                if (!exists) entries.push({ listener, capture });
            }
            return nativeAdd.call(this, type, listener, options);
        };

        EventTarget.prototype.removeEventListener = function patchedRemoveEventListener(type, listener, options) {
            const eventType = String(type || '');
            const capture = captureFlag(options);
            const entries = getTargetEntries(this, eventType, false);
            if (entries) {
                const index = entries.findIndex((entry) => entry.listener === listener && entry.capture === capture);
                if (index !== -1) entries.splice(index, 1);
            }
            return nativeRemove.call(this, type, listener, options);
        };

        globalThis.__lpmSmokeListenerCount = (targetRef, type) => {
            let target = null;
            if (targetRef === 'window') target = window;
            else if (targetRef === 'document') target = document;
            else if (targetRef === 'body') target = document.body;
            else target = document.querySelector(String(targetRef || ''));
            if (!target) return 0;
            return getTargetEntries(target, String(type || ''), false)?.length || 0;
        };
    });

    const diagnostics = attachPageDiagnostics(page);
    await page.goto(`${baseUrl}/?renderer=webgl`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForFunction(() => (
        !!globalThis.viewerApp && !document.body.classList.contains('app-loading')
    ), null, { timeout: 45000 });

    const readCounts = () => page.evaluate(() => {
        const count = globalThis.__lpmSmokeListenerCount;
        const dragTargets = ['window', 'document', 'body', '#viewer', '#drop'];
        const dragTypes = ['dragenter', 'dragover', 'dragleave', 'drop'];
        return {
            fileInputChange: count('#fileInput', 'change'),
            emptyHintClick: count('#emptyHint', 'click'),
            sampleChange: count('#sampleSelect', 'change'),
            textureCloseClick: count('#mClose', 'click'),
            textureModalClick: count('#texModal', 'click'),
            textureBindClick: count('#bindBtn', 'click'),
            dragListeners: dragTargets.reduce((total, target) => (
                total + dragTypes.reduce((sum, type) => sum + count(target, type), 0)
            ), 0),
            canvasCount: document.querySelectorAll('canvas').length,
        };
    });

    const firstInit = await readCounts();
    assert.equal(firstInit.fileInputChange, 1, 'Dispose smoke: file input listener missing after first init');
    assert.equal(firstInit.emptyHintClick, 1, 'Dispose smoke: empty hint listener missing after first init');
    assert.equal(firstInit.sampleChange, 2, 'Dispose smoke: sample select listeners missing after first init');
    assert.equal(firstInit.textureCloseClick, 1, 'Dispose smoke: texture close listener missing after first init');
    assert.equal(firstInit.textureModalClick, 1, 'Dispose smoke: texture modal listener missing after first init');
    assert.equal(firstInit.textureBindClick, 1, 'Dispose smoke: texture bind listener missing after first init');
    assert.equal(firstInit.dragListeners, 20, 'Dispose smoke: unexpected file drop listener count after first init');
    assert.ok(firstInit.canvasCount >= 1, 'Dispose smoke: renderer canvas missing after first init');

    await page.evaluate(async () => {
        await globalThis.viewerApp.dispose();
    });
    const afterFirstDispose = await readCounts();
    assert.equal(afterFirstDispose.fileInputChange, 0, 'Dispose smoke: file input listener leaked after dispose');
    assert.equal(afterFirstDispose.emptyHintClick, 0, 'Dispose smoke: empty hint listener leaked after dispose');
    assert.equal(afterFirstDispose.sampleChange, 0, 'Dispose smoke: sample select listener leaked after dispose');
    assert.equal(afterFirstDispose.textureCloseClick, 0, 'Dispose smoke: texture close listener leaked after dispose');
    assert.equal(afterFirstDispose.textureModalClick, 0, 'Dispose smoke: texture modal listener leaked after dispose');
    assert.equal(afterFirstDispose.textureBindClick, 0, 'Dispose smoke: texture bind listener leaked after dispose');
    assert.equal(afterFirstDispose.dragListeners, 0, 'Dispose smoke: file drop listeners leaked after dispose');

    await page.evaluate(async () => {
        const { ViewerApp } = await import('/scripts/modules/app/viewer-app-main.js');
        globalThis.viewerApp = new ViewerApp();
    });
    await page.waitForFunction(() => (
        !!globalThis.viewerApp && document.querySelectorAll('canvas').length >= 1
    ), null, { timeout: 45000 });

    const secondInit = await readCounts();
    assert.equal(secondInit.fileInputChange, 1, 'Dispose smoke: file input listener duplicated after reinit');
    assert.equal(secondInit.emptyHintClick, 1, 'Dispose smoke: empty hint listener duplicated after reinit');
    assert.equal(secondInit.sampleChange, 2, 'Dispose smoke: sample select listeners duplicated after reinit');
    assert.equal(secondInit.textureCloseClick, 1, 'Dispose smoke: texture close listener duplicated after reinit');
    assert.equal(secondInit.textureModalClick, 1, 'Dispose smoke: texture modal listener duplicated after reinit');
    assert.equal(secondInit.textureBindClick, 1, 'Dispose smoke: texture bind listener duplicated after reinit');
    assert.equal(secondInit.dragListeners, 20, 'Dispose smoke: unexpected file drop listener count after reinit');

    await page.evaluate(async () => {
        await globalThis.viewerApp.dispose();
    });
    diagnostics.assertNoErrors('Dispose/reinit smoke');
    await page.close();
}

async function runFileFlowFailureSmoke(browser, baseUrl) {
    const page = await browser.newPage();
    const diagnostics = attachPageDiagnostics(page, {
        ignoreConsoleError: (text) => text.includes('File import failed: broken.fbx'),
    });
    await page.goto(`${baseUrl}/__smoke_blank`, { waitUntil: 'domcontentloaded', timeout: 15000 });

    const result = await page.evaluate(async () => {
        const { createFileFlowController } = await import('/scripts/modules/io/file-flow.js');

        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.multiple = true;
        const emptyHintEl = document.createElement('button');
        const rootEl = document.createElement('main');
        const dropEl = document.createElement('div');
        const sampleSelect = document.createElement('select');
        document.body.append(fileInput, emptyHintEl, rootEl, dropEl, sampleSelect);

        const calls = [];
        let loadedCount = 0;
        let finalizeResolve = null;
        const finalized = new Promise((resolve) => {
            finalizeResolve = resolve;
        });

        const controller = createFileFlowController({
            fileInput,
            emptyHintEl,
            rootEl,
            dropEl,
            sampleSelect,
            sampleModels: [],
            handleFBXFile: async (file) => {
                calls.push(`fbx:${file.name}`);
                throw new Error('broken import');
            },
            handleZIPFile: async (file) => {
                calls.push(`zip:${file.name}`);
                loadedCount += 1;
            },
            finalizeBatchAfterAllFiles: async () => {
                calls.push('finalize');
                finalizeResolve();
            },
            setEmptyHintVisible: (visible) => calls.push(`empty:${visible ? 'on' : 'off'}`),
            getLoadedModelCount: () => loadedCount,
        });

        const files = [
            new File(['bad'], 'broken.fbx', { type: 'application/octet-stream' }),
            new File(['ok'], 'ok.zip', { type: 'application/zip' }),
        ];
        Object.defineProperty(fileInput, 'files', {
            configurable: true,
            value: files,
        });
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
        await finalized;
        controller.dispose();

        return {
            calls,
            fileInputValue: fileInput.value,
            dropVisible: dropEl.classList.contains('show'),
        };
    });

    assert.deepEqual(result.calls, [
        'empty:off',
        'fbx:broken.fbx',
        'zip:ok.zip',
        'empty:off',
        'finalize',
    ], 'File-flow smoke: failed file blocked batch finalization or later files');
    assert.equal(result.fileInputValue, '', 'File-flow smoke: file input value was not reset');
    assert.equal(result.dropVisible, false, 'File-flow smoke: drop overlay stayed visible after dispose');
    diagnostics.assertNoErrors('File-flow failure smoke');
    await page.close();
}

async function runCollabRealtimeDisposeSmoke(browser, baseUrl) {
    const page = await browser.newPage();
    const diagnostics = attachPageDiagnostics(page);
    await page.goto(`${baseUrl}/__smoke_blank`, { waitUntil: 'domcontentloaded', timeout: 15000 });

    const result = await page.evaluate(async () => {
        const { createCollabController } = await import('/scripts/modules/collab/collab-controller.js');

        class FakeQuery {
            constructor(table) {
                this.table = table;
                this.payload = null;
            }
            upsert(payload) {
                this.payload = payload;
                return Promise.resolve({ data: payload, error: null });
            }
            insert(payload) {
                this.payload = payload;
                return this;
            }
            update(payload) {
                this.payload = payload;
                return this;
            }
            delete() {
                return this;
            }
            select() {
                return this;
            }
            eq() {
                return this;
            }
            order() {
                return Promise.resolve({ data: [], error: null });
            }
            limit() {
                return this;
            }
            maybeSingle() {
                return Promise.resolve({ data: null, error: null });
            }
            single() {
                const data = {
                    id: `${this.table}-row`,
                    ...(this.payload && typeof this.payload === 'object' ? this.payload : {}),
                };
                return Promise.resolve({ data, error: null });
            }
        }

        class FakeChannel {
            constructor(name) {
                this.name = name;
                this.handlers = [];
                this.state = 'joined';
                this.socket = { isConnected: () => true };
                this.tracked = [];
            }
            on(type, filter, callback) {
                this.handlers.push({ type, filter: filter || {}, callback });
                return this;
            }
            subscribe(callback) {
                if (typeof callback === 'function') {
                    Promise.resolve().then(() => callback('SUBSCRIBED'));
                }
                return Promise.resolve('SUBSCRIBED');
            }
            track(meta) {
                this.tracked.push({ ...(meta || {}) });
                return Promise.resolve('ok');
            }
            presenceState() {
                return {
                    peer: [{ name: 'Peer', joinedAt: 't0', lastSeenAt: 't1' }],
                };
            }
            send() {
                return Promise.resolve('ok');
            }
            httpSend() {
                return Promise.resolve('ok');
            }
            emit(type, event, payload) {
                this.handlers
                    .filter((handler) => handler.type === type && handler.filter?.event === event)
                    .forEach((handler) => handler.callback(payload));
            }
        }

        const channels = [];
        const removedChannels = [];
        const supabase = {
            from: (table) => new FakeQuery(table),
            channel: (name) => {
                const channel = new FakeChannel(name);
                channels.push(channel);
                return channel;
            },
            removeChannel: async (channel) => {
                removedChannels.push(channel.name);
                return 'ok';
            },
            rpc: async () => ({ data: null, error: null }),
        };

        const calls = [];
        const controller = await createCollabController({
            supabase,
            user: { id: 'local-user' },
            project: { id: 'project-1', slug: 'project' },
            room: { id: 'room-1', slug: 'room', camera_owner_id: null, camera_state: null },
            displayName: 'Local',
            onParticipants: (list) => calls.push(`participants:${list.length}`),
            onMessage: (record, meta) => calls.push(`message:${meta?.source || ''}:${record?.id || ''}`),
            onAnnotation: (record, meta) => calls.push(`annotation:${meta?.source || ''}:${record?.id || ''}`),
            onAnnotationDelete: (record) => calls.push(`annotation-delete:${record?.id || ''}`),
            onCameraState: (state) => calls.push(`camera:${state?.source || 'broadcast'}`),
            onCameraOwner: (ownerId) => calls.push(`owner:${ownerId || ''}`),
            onRoomUpdate: (room) => calls.push(`room:${room?.id || ''}`),
            onConnectionState: ({ connected, reason }) => calls.push(`connection:${connected ? 'on' : 'off'}:${reason}`),
        });

        const roomChannel = channels.find((channel) => channel.name === 'room:room-1');
        const updatesChannel = channels.find((channel) => channel.name === 'room:room-1:updates');
        const annotationsChannel = channels.find((channel) => channel.name === 'room:room-1:annotations');
        const messagesChannel = channels.find((channel) => channel.name === 'room:room-1:messages');

        roomChannel.emit('presence', 'sync', {});
        roomChannel.emit('broadcast', 'message', { payload: { id: 'broadcast-message', sender: 'peer-user' } });
        roomChannel.emit('broadcast', 'annotation', { payload: { id: 'broadcast-annotation', sender: 'peer-user' } });
        roomChannel.emit('broadcast', 'annotation-delete', { payload: { id: 'broadcast-delete', sender: 'peer-user' } });
        roomChannel.emit('broadcast', 'camera', { payload: { sender: 'peer-user' } });
        roomChannel.emit('broadcast', 'camera-lock', { payload: { ownerId: 'peer-user', sender: 'peer-user' } });
        updatesChannel.emit('postgres_changes', 'UPDATE', {
            new: { id: 'room-1', camera_owner_id: 'db-owner', camera_state: { position: [1, 2, 3] } },
        });
        annotationsChannel.emit('postgres_changes', 'INSERT', { new: { id: 'annotation-row' } });
        annotationsChannel.emit('postgres_changes', 'DELETE', { old: { id: 'annotation-old' } });
        messagesChannel.emit('postgres_changes', 'INSERT', { new: { id: 'message-row' } });

        await Promise.resolve();
        const beforeDispose = calls.slice();
        await controller.dispose();
        const afterDispose = calls.slice();

        roomChannel.emit('presence', 'sync', {});
        roomChannel.emit('broadcast', 'message', { payload: { id: 'late-broadcast-message', sender: 'peer-user' } });
        roomChannel.emit('broadcast', 'annotation', { payload: { id: 'late-broadcast-annotation', sender: 'peer-user' } });
        roomChannel.emit('broadcast', 'annotation-delete', { payload: { id: 'late-broadcast-delete', sender: 'peer-user' } });
        roomChannel.emit('broadcast', 'camera', { payload: { sender: 'peer-user' } });
        roomChannel.emit('broadcast', 'camera-lock', { payload: { ownerId: 'late-owner', sender: 'peer-user' } });
        updatesChannel.emit('postgres_changes', 'UPDATE', {
            new: { id: 'room-1', camera_owner_id: 'late-db-owner', camera_state: { position: [4, 5, 6] } },
        });
        annotationsChannel.emit('postgres_changes', 'INSERT', { new: { id: 'late-annotation-row' } });
        annotationsChannel.emit('postgres_changes', 'DELETE', { old: { id: 'late-annotation-old' } });
        messagesChannel.emit('postgres_changes', 'INSERT', { new: { id: 'late-message-row' } });

        await Promise.resolve();
        return {
            beforeDispose,
            afterDispose,
            afterLateEvents: calls.slice(),
            removedChannels,
            channelNames: channels.map((channel) => channel.name),
        };
    });

    assert.deepEqual(result.channelNames, [
        'room:room-1',
        'room:room-1:updates',
        'room:room-1:annotations',
        'room:room-1:messages',
    ], 'Collab smoke: unexpected realtime channel set');
    assert.ok(result.beforeDispose.includes('message:broadcast:broadcast-message'), 'Collab smoke: broadcast message did not fire before dispose');
    assert.ok(result.beforeDispose.includes('annotation:realtime:annotation-row'), 'Collab smoke: realtime annotation did not fire before dispose');
    assert.ok(result.beforeDispose.includes('room:room-1'), 'Collab smoke: room update did not fire before dispose');
    assert.ok(result.afterDispose.includes('connection:off:DISPOSED'), 'Collab smoke: dispose did not emit connection close');
    assert.deepEqual(result.removedChannels, result.channelNames, 'Collab smoke: dispose did not remove all realtime channels');
    assert.deepEqual(result.afterLateEvents, result.afterDispose, 'Collab smoke: stale realtime callbacks fired after dispose');
    diagnostics.assertNoErrors('Collab realtime dispose smoke');
    await page.close();
}

const smokeServer = await createStaticServer();
const browser = await chromium.launch({
    headless: true,
    args: [
        '--use-angle=swiftshader',
        '--use-gl=angle',
        '--enable-unsafe-swiftshader',
        '--ignore-gpu-blocklist',
    ],
});

try {
    console.log(`Smoke server: ${smokeServer.baseUrl}`);
    await runBootSmoke(browser, smokeServer.baseUrl);
    console.log('Boot smoke passed.');
    await runRoomEntrySmoke(browser, smokeServer.baseUrl);
    console.log('Room-entry smoke passed.');
    await runDisposeReinitSmoke(browser, smokeServer.baseUrl);
    console.log('Dispose/reinit smoke passed.');
    await runFileFlowFailureSmoke(browser, smokeServer.baseUrl);
    console.log('File-flow failure smoke passed.');
    await runCollabRealtimeDisposeSmoke(browser, smokeServer.baseUrl);
    console.log('Collab realtime dispose smoke passed.');
} finally {
    await browser.close();
    await smokeServer.close();
}
