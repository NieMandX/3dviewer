import { createServer } from 'node:http';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { extname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { runProjectAdminTreeSmoke } from './smoke-project-admin.mjs';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const roomProject = process.env.LPMVIEW_SMOKE_PROJECT || 'shmit';
const roomSlug = process.env.LPMVIEW_SMOKE_ROOM || '1';
const smokeCdnCacheDir = process.env.LPMVIEW_SMOKE_CDN_CACHE
    || join(tmpdir(), 'lpmview-smoke-cdn-cache-v1');
const smokeCdnRetryCount = Math.max(1, Number(process.env.LPMVIEW_SMOKE_CDN_RETRIES || 4) || 4);
const smokeCdnRetryDelayMs = Math.max(0, Number(process.env.LPMVIEW_SMOKE_CDN_RETRY_DELAY_MS || 350) || 350);
const SMOKE_CDN_HOSTS = new Set(['cdn.jsdelivr.net', 'cdnjs.cloudflare.com']);

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

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isSmokeCdnUrl(value) {
    try {
        return SMOKE_CDN_HOSTS.has(new URL(value).hostname);
    } catch (_) {
        return false;
    }
}

function getSmokeCdnCacheKey(url) {
    return createHash('sha256').update(String(url || '')).digest('hex');
}

function normalizeFulfillHeaders(headers = {}) {
    const out = {};
    Object.entries(headers || {}).forEach(([key, value]) => {
        const lower = String(key || '').toLowerCase();
        if (!lower) return;
        if (lower === 'content-length' || lower === 'content-encoding' || lower === 'transfer-encoding' || lower === 'connection') return;
        out[lower] = String(value || '');
    });
    out['access-control-allow-origin'] = '*';
    return out;
}

async function readSmokeCdnCache(url) {
    const key = getSmokeCdnCacheKey(url);
    try {
        const [body, metaRaw] = await Promise.all([
            readFile(join(smokeCdnCacheDir, `${key}.body`)),
            readFile(join(smokeCdnCacheDir, `${key}.json`), 'utf8'),
        ]);
        const meta = JSON.parse(metaRaw);
        return {
            body,
            status: Number(meta.status || 200),
            headers: normalizeFulfillHeaders(meta.headers || {}),
        };
    } catch (_) {
        return null;
    }
}

async function writeSmokeCdnCache(url, response, body) {
    if (!response || response.status() < 200 || response.status() >= 300) return;
    const key = getSmokeCdnCacheKey(url);
    try {
        await mkdir(smokeCdnCacheDir, { recursive: true });
        await Promise.all([
            writeFile(join(smokeCdnCacheDir, `${key}.body`), body),
            writeFile(join(smokeCdnCacheDir, `${key}.json`), JSON.stringify({
                url,
                status: response.status(),
                headers: normalizeFulfillHeaders(response.headers()),
            })),
        ]);
    } catch (_) {
        // Cache writes are best-effort; smoke should still run from the live response.
    }
}

async function installSmokeCdnRoute(context, options = {}) {
    const memoryCache = new Map();
    const blockedUrls = new Set(Array.isArray(options.blockedUrls) ? options.blockedUrls.map(String) : []);
    const handleSmokeCdnRoute = async (route, request) => {
        const url = request.url();
        if (!isSmokeCdnUrl(url)) {
            await route.continue();
            return;
        }
        if (blockedUrls.has(url)) {
            await route.abort('failed');
            return;
        }

        const cached = memoryCache.get(url) || await readSmokeCdnCache(url);
        if (cached) {
            memoryCache.set(url, cached);
            await route.fulfill(cached);
            return;
        }

        let lastError = null;
        for (let attempt = 1; attempt <= smokeCdnRetryCount; attempt += 1) {
            try {
                const response = await route.fetch({ timeout: 30000 });
                const body = await response.body();
                const cachedResponse = {
                    body,
                    status: response.status(),
                    headers: normalizeFulfillHeaders(response.headers()),
                };
                if (response.status() >= 200 && response.status() < 300) {
                    memoryCache.set(url, cachedResponse);
                    await writeSmokeCdnCache(url, response, body);
                }
                await route.fulfill(cachedResponse);
                return;
            } catch (err) {
                lastError = err;
                if (attempt < smokeCdnRetryCount) {
                    await wait(smokeCdnRetryDelayMs * attempt);
                }
            }
        }

        console.warn(`Smoke CDN fetch failed after ${smokeCdnRetryCount} attempts: ${url}`, lastError?.message || lastError || '');
        await route.abort('failed');
    };
    await context.route('https://cdn.jsdelivr.net/**', handleSmokeCdnRoute);
    await context.route('https://cdnjs.cloudflare.com/**', handleSmokeCdnRoute);
}

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
                const body = Buffer.from(`<!doctype html>
                    <meta charset="utf-8">
                    <title>LPM smoke</title>
                    <script type="importmap">
                    {
                        "imports": {
                            "three": "https://cdn.jsdelivr.net/npm/three@0.184.0/build/three.module.js",
                            "three/webgpu": "https://cdn.jsdelivr.net/npm/three@0.184.0/build/three.webgpu.js",
                            "three/tsl": "https://cdn.jsdelivr.net/npm/three@0.184.0/build/three.tsl.js",
                            "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.184.0/examples/jsm/",
                            "three/examples/": "https://cdn.jsdelivr.net/npm/three@0.184.0/examples/",
                            "three-mesh-bvh": "https://cdn.jsdelivr.net/npm/three-mesh-bvh@0.7.4/build/index.module.js"
                        }
                    }
                    </script>`);
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
    const collabDrawerSwap = await page.evaluate(async () => {
        const waitFrame = () => new Promise((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(resolve));
        });
        const emptyHint = document.querySelector('#emptyHint');
        const drawer = document.querySelector('#collabDrawer');
        const panelBtn = document.querySelector('#collabPanelBtn');
        const closeBtn = document.querySelector('#collabDrawerClose');
        if (!emptyHint || !drawer || !panelBtn || !closeBtn) {
            return { missing: true };
        }

        emptyHint.hidden = false;
        emptyHint.style.opacity = '1';
        drawer.hidden = true;
        drawer.classList.remove('empty-hint-overlay');
        const emptyRect = emptyHint.getBoundingClientRect();
        const emptyCenterY = emptyRect.top + emptyRect.height / 2;

        panelBtn.click();
        await waitFrame();
        const drawerRect = drawer.getBoundingClientRect();
        const drawerCenterY = drawerRect.top + drawerRect.height / 2;
        const opened = {
            emptyHidden: emptyHint.hidden,
            drawerHidden: drawer.hidden,
            drawerSwapClass: drawer.classList.contains('empty-hint-overlay'),
            centerDeltaY: Math.abs(drawerCenterY - emptyCenterY),
        };

        closeBtn.click();
        await waitFrame();

        return {
            missing: false,
            opened,
            closed: {
                emptyHidden: emptyHint.hidden,
                emptyOpacity: emptyHint.style.opacity,
                drawerHidden: drawer.hidden,
                drawerSwapClass: drawer.classList.contains('empty-hint-overlay'),
            },
        };
    });

    assert.equal(state.appReady, true, 'Boot smoke: viewerApp not initialized');
    assert.equal(state.loading, false, 'Boot smoke: body still in app-loading state');
    assert.equal(state.activeRenderer, 'webgl', 'Boot smoke: unexpected renderer mode');
    assert.equal(webgpuImports.webgpuRenderer, true, 'Boot smoke: three/webgpu WebGPURenderer export missing');
    assert.equal(webgpuImports.meshBasicNodeMaterial, true, 'Boot smoke: three/webgpu MeshBasicNodeMaterial export missing');
    assert.equal(webgpuImports.normalView, true, 'Boot smoke: three/tsl normalView export missing');
    assert.equal(webgpuImports.positionViewDirection, true, 'Boot smoke: three/tsl positionViewDirection export missing');
    assert.equal(collabDrawerSwap.missing, false, 'Boot smoke: collab drawer swap elements missing');
    assert.equal(collabDrawerSwap.opened.emptyHidden, true, 'Boot smoke: empty hint stayed visible under collab drawer');
    assert.equal(collabDrawerSwap.opened.drawerHidden, false, 'Boot smoke: collab drawer did not open');
    assert.equal(collabDrawerSwap.opened.drawerSwapClass, true, 'Boot smoke: collab drawer did not move into empty hint position');
    assert.ok(collabDrawerSwap.opened.centerDeltaY <= 1, 'Boot smoke: collab drawer did not align to empty hint position');
    assert.equal(collabDrawerSwap.closed.emptyHidden, false, 'Boot smoke: empty hint was not restored after closing collab drawer');
    assert.equal(collabDrawerSwap.closed.emptyOpacity, '1', 'Boot smoke: restored empty hint opacity was wrong');
    assert.equal(collabDrawerSwap.closed.drawerHidden, true, 'Boot smoke: collab drawer stayed open after close');
    assert.equal(collabDrawerSwap.closed.drawerSwapClass, false, 'Boot smoke: collab drawer retained empty hint position after close');
    diagnostics.assertNoErrors('Boot smoke');
    await page.evaluate(() => globalThis.viewerApp?.dispose?.()).catch(() => {});
    await page.close();
}

async function runBootRuntimeFailureSmoke(browser, baseUrl) {
    const rootBrowser = typeof browser.browser === 'function' ? browser.browser() : browser;
    const context = await rootBrowser.newContext();
    await installSmokeCdnRoute(context, {
        blockedUrls: ['https://cdn.jsdelivr.net/npm/three@0.184.0/build/three.module.js'],
    });
    const page = await context.newPage();
    try {
        await page.goto(`${baseUrl}/?renderer=webgl&bootTimeoutMs=1000`, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForFunction(() => document.body.classList.contains('app-boot-error'), null, { timeout: 5000 });
        const state = await page.evaluate(() => ({
            hasViewerApp: !!globalThis.viewerApp,
            loading: document.body.classList.contains('app-loading'),
            bootError: document.body.classList.contains('app-boot-error'),
            text: document.getElementById('bootLoaderText')?.textContent || '',
            pct: document.getElementById('bootLoaderPct')?.textContent || '',
            barWidth: document.getElementById('bootLoaderBar')?.style?.width || '',
        }));

        assert.equal(state.hasViewerApp, false, 'Boot runtime failure smoke: viewerApp started after blocked runtime module');
        assert.equal(state.loading, true, 'Boot runtime failure smoke: app-loading was cleared after boot failure');
        assert.equal(state.bootError, true, 'Boot runtime failure smoke: boot error state was not set');
        assert.match(state.text, /runtime viewer|Viewer не стартовал|CDN/i, 'Boot runtime failure smoke: boot error text did not explain runtime/CDN failure');
        assert.equal(state.pct, 'ошибка', 'Boot runtime failure smoke: boot error status was not shown');
        assert.equal(state.barWidth, '100%', 'Boot runtime failure smoke: boot progress bar was not completed on error');
    } finally {
        await page.close();
        await context.close();
    }
}

async function runBootJSZipCdnNonBlockingSmoke(browser, baseUrl) {
    const rootBrowser = typeof browser.browser === 'function' ? browser.browser() : browser;
    const context = await rootBrowser.newContext();
    let releaseBlockedScript = null;
    const blockedScript = new Promise((resolve) => {
        releaseBlockedScript = resolve;
    });
    await context.route(/\/jszip(?:@|\/)3\.10\.1\/.*jszip\.min\.js$/, async (route) => {
        await blockedScript;
        await route.abort('failed').catch(() => {});
    });
    const page = await context.newPage();
    try {
        await page.goto(`${baseUrl}/?renderer=webgl&bootTimeoutMs=1000`, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForFunction(() => !!globalThis.viewerApp, null, { timeout: 15000 });
        const state = await page.evaluate(() => ({
            hasViewerApp: !!globalThis.viewerApp,
            loading: document.body.classList.contains('app-loading'),
            bootError: document.body.classList.contains('app-boot-error'),
            text: document.getElementById('bootLoaderText')?.textContent || '',
            pct: document.getElementById('bootLoaderPct')?.textContent || '',
            barWidth: document.getElementById('bootLoaderBar')?.style?.width || '',
            hasJSZip: !!globalThis.JSZip,
        }));

        assert.equal(state.hasViewerApp, true, 'Boot JSZip CDN smoke: viewerApp did not start while JSZip CDN was stalled');
        assert.equal(state.bootError, false, 'Boot JSZip CDN smoke: non-critical JSZip load triggered boot failure');
        assert.equal(state.hasJSZip, false, 'Boot JSZip CDN smoke: JSZip should not be eagerly loaded during boot');
    } finally {
        releaseBlockedScript?.();
        await page.close();
        await context.close();
    }
}

async function runRuntimeDiagnosticsSmoke(browser, baseUrl) {
    const page = await browser.newPage();
    const diagnostics = attachPageDiagnostics(page);
    await page.goto(`${baseUrl}/?renderer=webgl&debug=1`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForFunction(() => (
        !!globalThis.viewerApp && !document.body.classList.contains('app-loading')
    ), null, { timeout: 45000 });

    const result = await page.evaluate(async () => {
        const THREE = await import('three');
        const api = globalThis.__LPMVIEW_DIAGNOSTICS || null;
        const before = api?.getSnapshot?.() || null;

        const root = new THREE.Group();
        root.userData.importScope = {
            kind: 'room',
            roomId: 'diagnostics-room',
            modelId: 'diagnostics-model',
        };
        globalThis.viewerApp.scene.add(root);
        globalThis.viewerApp.loadedModels.push({
            obj: root,
            name: 'diagnostics-model.fbx',
            scope: { ...root.userData.importScope },
        });
        globalThis.viewerApp.allEmbedded.push({
            short: 'diagnostics.png',
            url: 'blob:diagnostics-texture',
            full: 'diagnostics.png',
            source: 'smoke',
        });

        const after = globalThis.viewerApp.api.getDiagnostics();
        const printed = api?.print?.() || null;
        await globalThis.viewerApp.dispose();
        const globalCleared = !globalThis.__LPMVIEW_DIAGNOSTICS;

        return {
            hasGlobal: !!api,
            before,
            after,
            printed,
            globalCleared,
        };
    });

    assert.equal(result.hasGlobal, true, 'Runtime diagnostics smoke: debug global was not exposed for ?debug=1');
    assert.equal(result.before.renderer.mode, 'webgl', 'Runtime diagnostics smoke: renderer mode missing from snapshot');
    assert.equal(result.before.models.loaded, 0, 'Runtime diagnostics smoke: boot snapshot expected empty model list');
    assert.equal(result.after.models.loaded, 1, 'Runtime diagnostics smoke: loaded model count did not update');
    assert.equal(result.after.models.roomScoped, 1, 'Runtime diagnostics smoke: room-scoped model count did not update');
    assert.equal(result.after.embedded.total, 1, 'Runtime diagnostics smoke: embedded count did not update');
    assert.equal(result.after.resources.knownBlobUrls, 1, 'Runtime diagnostics smoke: blob URL count did not update');
    assert.equal(result.after.collab.totalRealtimeChannels, 0, 'Runtime diagnostics smoke: idle viewer reported active realtime channels');
    assert.equal(result.after.collab.roomLoadAbortRegistry.imports, 0, 'Runtime diagnostics smoke: idle viewer reported active room imports');
    assert.equal(result.after.workers.fbx.pending, 0, 'Runtime diagnostics smoke: idle FBX worker reported pending jobs');
    assert.equal(result.after.workers.zip.pending, 0, 'Runtime diagnostics smoke: idle ZIP worker reported pending jobs');
    assert.equal(result.after.renderBursts.scene.framesLeft >= 0, true, 'Runtime diagnostics smoke: scene render burst state missing');
    assert.equal(result.printed.models.loaded, result.after.models.loaded, 'Runtime diagnostics smoke: print did not return current snapshot');
    assert.equal(result.globalCleared, true, 'Runtime diagnostics smoke: dispose left debug global installed');
    diagnostics.assertNoErrors('Runtime diagnostics smoke');
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

    await Promise.all([
        page.waitForURL(`${baseUrl}/`, { waitUntil: 'domcontentloaded', timeout: 45000 }),
        page.evaluate(() => document.querySelector('#collabDrawerClose')?.click()),
    ]);
    await page.waitForFunction(() => (
        !!globalThis.viewerApp && !document.body.classList.contains('app-loading')
    ), null, { timeout: 45000 });
    const closeState = await page.evaluate(() => {
        const url = new URL(window.location.href);
        return {
            pathname: url.pathname,
            search: url.search,
            hash: url.hash,
            roomEntryLanding: document.body.classList.contains('room-entry-landing'),
        };
    });
    assert.equal(closeState.pathname, '/', 'Room smoke: close did not return to viewer root');
    assert.equal(closeState.search, '', 'Room smoke: close kept room/link query parameters');
    assert.equal(closeState.hash, '', 'Room smoke: close kept URL hash');
    assert.equal(closeState.roomEntryLanding, false, 'Room smoke: close reopened room-entry landing');
    diagnostics.assertNoErrors('Room smoke');
    await page.close();
}

async function runRoomInviteModelUploadGuardSmoke(browser, baseUrl) {
    const page = await browser.newPage();
    const diagnostics = attachPageDiagnostics(page);
    await page.addInitScript(() => {
        window.__SUPABASE_URL = 'https://smoke.supabase.co';
        window.__SUPABASE_ANON_KEY = 'smoke-key';

        const project = {
            id: 'project-owner',
            name: 'Owner Project',
            slug: 'owner-project',
            owner_id: 'owner-user',
            created_at: '2026-01-01T00:00:00Z',
        };
        const room = {
            id: 'room-invite',
            slug: 'invite-room',
            project_id: project.id,
            owner_id: 'owner-user',
            created_at: '2026-01-01T00:00:00Z',
            active_model_id: '',
        };
        const guest = {
            id: 'guest-user',
            email: '',
            is_anonymous: true,
            user_metadata: {},
        };
        const calls = {
            anonymous: 0,
            joinInvite: 0,
            projectModelInserts: 0,
            roomModelInserts: 0,
            storageUploads: 0,
        };
        window.__lpmInviteGuardSmoke = calls;

        class FakeQuery {
            constructor(table) {
                this.table = table;
                this.filters = [];
                this.payload = null;
                this.operation = 'select';
            }
            select() { return this; }
            order() { return this; }
            limit() { return this; }
            eq(column, value) {
                this.filters.push({ column: String(column || ''), value: String(value || '') });
                return this;
            }
            insert(payload) {
                this.operation = 'insert';
                this.payload = payload;
                if (this.table === 'project_models') calls.projectModelInserts += 1;
                if (this.table === 'room_models') calls.roomModelInserts += 1;
                return this;
            }
            upsert(payload) {
                this.operation = 'upsert';
                this.payload = payload;
                return this;
            }
            update(payload) {
                this.operation = 'update';
                this.payload = payload;
                return this;
            }
            matchesFilters(row) {
                return this.filters.every((entry) => String(row?.[entry.column] || '') === entry.value);
            }
            rows() {
                if (this.table === 'profiles') return [];
                if (this.table === 'projects') return [project].filter((row) => this.matchesFilters(row));
                if (this.table === 'rooms') return [room].filter((row) => this.matchesFilters(row));
                if (this.table === 'room_models') return [];
                if (this.table === 'project_models') return [];
                if (this.table === 'room_cameras') return [];
                if (this.table === 'room_transitions') return [];
                if (this.table === 'annotations') return [];
                if (this.table === 'messages') return [];
                return [];
            }
            async execute() {
                if (this.operation !== 'select') return { data: this.payload || null, error: null };
                return { data: this.rows(), error: null };
            }
            async maybeSingle() {
                return { data: this.rows()[0] || null, error: null };
            }
            async single() {
                return { data: { id: `${this.table}-row`, ...(this.payload || {}) }, error: null };
            }
            then(resolve, reject) {
                return this.execute().then(resolve, reject);
            }
        }

        class FakeChannel {
            constructor(name) {
                this.name = name;
                this.state = 'closed';
                this.socket = { isConnected: () => this.state === 'joined' };
            }
            on() { return this; }
            subscribe(callback) {
                this.state = 'joined';
                queueMicrotask(() => callback?.('SUBSCRIBED'));
                return this;
            }
            presenceState() {
                return { [guest.id]: [{ name: 'Guest User', joinedAt: '2026-01-01T00:00:00Z' }] };
            }
            track() { return Promise.resolve('ok'); }
            send() { return Promise.resolve('ok'); }
            httpSend() { return Promise.resolve('ok'); }
        }

        const client = {
            auth: {
                getUser: () => Promise.resolve({ data: { user: null }, error: null }),
                signInAnonymously: () => {
                    calls.anonymous += 1;
                    return Promise.resolve({ data: { user: guest }, error: null });
                },
                signOut: () => Promise.resolve({ error: null }),
                getSession: () => Promise.resolve({ data: { session: { access_token: 'guest-token' } }, error: null }),
            },
            from: (table) => new FakeQuery(table),
            rpc: (name) => {
                if (name === 'is_superuser') return Promise.resolve({ data: false, error: null });
                if (name === 'join_room_by_invite') {
                    calls.joinInvite += 1;
                    return Promise.resolve({ data: room, error: null });
                }
                if (name === 'claim_camera' || name === 'release_camera') {
                    return Promise.resolve({ data: null, error: null });
                }
                return Promise.resolve({ data: null, error: null });
            },
            channel: (name) => new FakeChannel(String(name || '')),
            removeChannel: () => Promise.resolve({ error: null }),
            storage: {
                from: () => ({
                    upload: () => {
                        calls.storageUploads += 1;
                        return Promise.resolve({ data: null, error: null });
                    },
                    download: () => Promise.resolve({ data: null, error: null }),
                }),
            },
        };

        window.supabase = {
            createClient() {
                return client;
            },
        };
    });

    const targetUrl = `${baseUrl}/?renderer=webgl&debug=1&project=owner-project&room=invite-room&invite=room-token`;
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForFunction(() => (
        !!globalThis.viewerApp
        && !document.body.classList.contains('app-loading')
        && document.querySelector('#collabAuthPanel')?.dataset?.mode === 'roomEntry'
    ), null, { timeout: 45000 });

    await page.fill('#collabName', 'Guest User');
    await page.click('#collabGuestBtn');
    await page.waitForFunction(() => (
        (globalThis.__lpmInviteGuardSmoke?.joinInvite || 0) === 1
        && globalThis.__LPMVIEW_DIAGNOSTICS?.getSnapshot?.().collab?.connected === true
    ), null, { timeout: 45000 });
    assert.equal(
        await page.locator('#status').textContent(),
        '—',
        'Room invite upload guard smoke: guest saw upload rejection before choosing a file'
    );

    await page.setInputFiles('#fileInput', {
        name: 'guest-upload.fbx',
        mimeType: 'application/octet-stream',
        buffer: Buffer.from('not-a-real-fbx'),
    });
    await page.waitForFunction(() => (
        document.querySelector('#status')?.textContent?.includes('Только владелец комнаты')
    ), null, { timeout: 8000 });

    const state = await page.evaluate(async () => {
        const snapshot = globalThis.__LPMVIEW_DIAGNOSTICS.getSnapshot();
        const status = document.querySelector('#status')?.textContent || '';
        await globalThis.viewerApp.dispose();
        return {
            calls: { ...globalThis.__lpmInviteGuardSmoke },
            status,
            loadedModels: snapshot.models.loaded,
            roomSelectionLocked: snapshot.collab.roomSelectionLocked,
            registered: snapshot.collab.registered,
        };
    });

    assert.equal(state.calls.anonymous, 1, 'Room invite upload guard smoke: guest auth did not start');
    assert.equal(state.calls.joinInvite, 1, 'Room invite upload guard smoke: invite RPC did not run');
    assert.equal(state.calls.projectModelInserts, 0, 'Room invite upload guard smoke: guest inserted a project model');
    assert.equal(state.calls.roomModelInserts, 0, 'Room invite upload guard smoke: guest inserted a room model');
    assert.equal(state.calls.storageUploads, 0, 'Room invite upload guard smoke: guest uploaded to storage');
    assert.equal(state.loadedModels, 0, 'Room invite upload guard smoke: guest local model was imported');
    assert.equal(state.roomSelectionLocked, true, 'Room invite upload guard smoke: invite room selection was not locked');
    assert.equal(state.registered, false, 'Room invite upload guard smoke: anonymous guest became registered');
    assert.equal(state.status.includes('Только владелец комнаты'), true, 'Room invite upload guard smoke: missing owner-only status');
    diagnostics.assertNoErrors('Room invite upload guard smoke');
    await page.close();
}

async function runResetViewerUrlSmoke(browser, baseUrl) {
    const page = await browser.newPage();
    const diagnostics = attachPageDiagnostics(page);
    const targetUrl = `${baseUrl}/index.html?project=${encodeURIComponent(roomProject)}&room=${encodeURIComponent(roomSlug)}&invite=smoke-invite&renderer=webgl#room`;
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForFunction(() => (
        !!globalThis.viewerApp && !document.body.classList.contains('app-loading')
    ), null, { timeout: 45000 });

    await Promise.all([
        page.waitForURL(`${baseUrl}/index.html`, { waitUntil: 'domcontentloaded', timeout: 45000 }),
        page.evaluate(() => document.querySelector('#resetViewerBtn')?.click()),
    ]);
    await page.waitForFunction(() => (
        !!globalThis.viewerApp && !document.body.classList.contains('app-loading')
    ), null, { timeout: 45000 });

    const state = await page.evaluate(() => {
        const url = new URL(window.location.href);
        return {
            pathname: url.pathname,
            search: url.search,
            hash: url.hash,
            roomEntryLanding: document.body.classList.contains('room-entry-landing'),
        };
    });

    assert.equal(state.pathname.endsWith('/index.html'), true, 'Reset viewer smoke: reset did not stay on viewer entrypoint');
    assert.equal(state.search, '', 'Reset viewer smoke: reset kept room/link query parameters');
    assert.equal(state.hash, '', 'Reset viewer smoke: reset kept URL hash');
    assert.equal(state.roomEntryLanding, false, 'Reset viewer smoke: clean reset reopened room-entry landing');
    diagnostics.assertNoErrors('Reset viewer smoke');
    await page.close();
}

async function runAuthAsyncDisposeSmoke(browser, baseUrl) {
    {
        const page = await browser.newPage();
        const diagnostics = attachPageDiagnostics(page);
        await page.addInitScript(() => {
            window.__SUPABASE_URL = 'https://smoke.supabase.co';
            window.__SUPABASE_ANON_KEY = 'smoke-key';

            const calls = {
                createClient: 0,
                getUser: 0,
                signOut: 0,
                storedAuthAtCreate: '',
            };
            let resolveGetUser;
            const getUserPromise = new Promise((resolve) => {
                resolveGetUser = resolve;
            });
            window.__lpmAuthSmoke = calls;
            window.__lpmResolveGetUser = (payload) => resolveGetUser(payload);
            try {
                window.localStorage.setItem('sb-smoke-auth-token', JSON.stringify({
                    access_token: 'stale-access',
                    refresh_token: 'stale-refresh',
                    expires_at: 1,
                }));
            } catch (_) {}
            window.supabase = {
                createClient() {
                    calls.createClient += 1;
                    try {
                        calls.storedAuthAtCreate = window.localStorage.getItem('sb-smoke-auth-token') || '';
                    } catch (_) {}
                    return {
                        auth: {
                            getUser() {
                                calls.getUser += 1;
                                return getUserPromise;
                            },
                            signOut() {
                                calls.signOut += 1;
                                return Promise.resolve({ error: null });
                            },
                            getSession: () => Promise.resolve({ data: { session: null }, error: null }),
                            resetPasswordForEmail: () => Promise.resolve({ error: null }),
                            resend: () => Promise.resolve({ error: null }),
                        },
                        from: () => ({
                            select() { return this; },
                            eq() { return this; },
                            maybeSingle: () => Promise.resolve({ data: null, error: null }),
                        }),
                        rpc: () => Promise.resolve({ data: false, error: null }),
                    };
                },
            };
        });
        await page.goto(`${baseUrl}/?renderer=webgl`, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForFunction(() => (
            !!globalThis.viewerApp && !document.body.classList.contains('app-loading')
        ), null, { timeout: 45000 });
        await page.waitForFunction(() => globalThis.__lpmAuthSmoke?.getUser >= 1, null, { timeout: 5000 });

        const result = await page.evaluate(async () => {
            await globalThis.viewerApp.dispose();
            globalThis.__lpmResolveGetUser({ data: { user: { id: 'persisted-user', email: 'old@example.com' } }, error: null });
            await new Promise((resolve) => setTimeout(resolve, 30));
            return { ...globalThis.__lpmAuthSmoke };
        });

        assert.equal(result.signOut, 0, 'Auth async dispose smoke: disposed persisted-session cleanup still signed out');
        assert.equal(result.storedAuthAtCreate, '', 'Auth async dispose smoke: stale default auth storage was not cleared before client init');
        diagnostics.assertNoErrors('Auth async dispose smoke: persisted session');
        await page.close();
    }

    {
        const page = await browser.newPage();
        const diagnostics = attachPageDiagnostics(page);
        await page.addInitScript(() => {
            window.__SUPABASE_URL = 'https://smoke.supabase.co';
            window.__SUPABASE_ANON_KEY = 'smoke-key';

            const calls = {
                createClient: 0,
                getUser: 0,
                resetPassword: 0,
                resetEmail: '',
            };
            let resolveReset;
            const resetPromise = new Promise((resolve) => {
                resolveReset = resolve;
            });
            window.__lpmAuthSmoke = calls;
            window.__lpmResolveResetPassword = (payload) => resolveReset(payload);
            window.supabase = {
                createClient() {
                    calls.createClient += 1;
                    return {
                        auth: {
                            getUser() {
                                calls.getUser += 1;
                                return Promise.resolve({ data: { user: null }, error: null });
                            },
                            signOut: () => Promise.resolve({ error: null }),
                            getSession: () => Promise.resolve({ data: { session: null }, error: null }),
                            resetPasswordForEmail(email) {
                                calls.resetPassword += 1;
                                calls.resetEmail = String(email || '');
                                return resetPromise;
                            },
                            resend: () => Promise.resolve({ error: null }),
                        },
                        from: () => ({
                            select() { return this; },
                            eq() { return this; },
                            maybeSingle: () => Promise.resolve({ data: null, error: null }),
                        }),
                        rpc: () => Promise.resolve({ data: false, error: null }),
                    };
                },
            };
        });
        await page.goto(`${baseUrl}/?renderer=webgl`, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForFunction(() => (
            !!globalThis.viewerApp && !document.body.classList.contains('app-loading')
        ), null, { timeout: 45000 });

        const result = await page.evaluate(async () => {
            const emailEl = document.querySelector('#collabEmail');
            const resetBtn = document.querySelector('#collabResetBtn');
            const errorEl = document.querySelector('#collabAuthError');
            emailEl.value = 'reset@example.com';
            resetBtn.click();
            while ((globalThis.__lpmAuthSmoke?.resetPassword || 0) < 1) {
                await new Promise((resolve) => setTimeout(resolve, 0));
            }
            await globalThis.viewerApp.dispose();
            globalThis.__lpmResolveResetPassword({ error: null });
            await new Promise((resolve) => setTimeout(resolve, 30));
            return {
                ...globalThis.__lpmAuthSmoke,
                authErrorText: errorEl?.textContent || '',
                resetButtonDisabled: resetBtn?.disabled ?? null,
            };
        });

        assert.equal(result.resetPassword, 1, 'Auth async dispose smoke: reset email request did not start');
        assert.equal(result.resetEmail, 'reset@example.com', 'Auth async dispose smoke: reset email was not normalized');
        assert.equal(result.authErrorText, '', 'Auth async dispose smoke: disposed reset request still wrote auth status');
        assert.equal(result.resetButtonDisabled, true, 'Auth async dispose smoke: disposed reset flow re-enabled button');
        diagnostics.assertNoErrors('Auth async dispose smoke: reset email');
        await page.close();
    }
}

async function runBrowserSdkRetrySmoke(browser, baseUrl) {
    const page = await browser.newPage();
    const diagnostics = attachPageDiagnostics(page);
    await page.goto(`${baseUrl}/__smoke_blank`, { waitUntil: 'domcontentloaded', timeout: 15000 });

    const result = await page.evaluate(async () => {
        const nativeAppendChild = document.head.appendChild.bind(document.head);

        async function smokeSupabaseRetry() {
            delete window.supabase;
            let scriptAttempts = 0;
            let scriptRemovals = 0;
            let firstHandlersCleared = false;
            let secondHandlersCleared = false;
            document.head.appendChild = (node) => {
                const src = String(node?.src || '');
                if (node?.tagName === 'SCRIPT' && src.includes('@supabase/supabase-js')) {
                    scriptAttempts += 1;
                    const nativeRemove = node.remove?.bind(node);
                    node.remove = () => {
                        scriptRemovals += 1;
                        nativeRemove?.();
                    };
                    queueMicrotask(() => {
                        if (scriptAttempts === 1) {
                            node.onerror?.(new Event('error'));
                            firstHandlersCleared = node.onload === null && node.onerror === null;
                            return;
                        }
                        window.supabase = {
                            createClient: (url, anonKey, options) => ({ url, anonKey, options }),
                        };
                        node.onload?.(new Event('load'));
                        secondHandlersCleared = node.onload === null && node.onerror === null;
                    });
                    return node;
                }
                return nativeAppendChild(node);
            };

            const { createSupabaseClient } = await import(`/scripts/modules/collab/supabase-client.js?retry=${Date.now()}-${Math.random()}`);
            let firstError = '';
            try {
                await createSupabaseClient({ url: 'https://retry.supabase.co', anonKey: 'anon' });
            } catch (err) {
                firstError = err?.message || String(err);
            }
            const client = await createSupabaseClient({ url: 'https://retry.supabase.co', anonKey: 'anon' });
            return {
                firstError,
                scriptAttempts,
                scriptRemovals,
                firstHandlersCleared,
                secondHandlersCleared,
                secondUrl: client?.url || '',
                secondAnonKey: client?.anonKey || '',
            };
        }

        async function smokeLiveKitRetry() {
            delete window.LivekitClient;
            let scriptAttempts = 0;
            let scriptRemovals = 0;
            let firstHandlersCleared = false;
            let secondHandlersCleared = false;
            document.head.appendChild = (node) => {
                const src = String(node?.src || '');
                if (node?.tagName === 'SCRIPT' && src.includes('livekit-client')) {
                    scriptAttempts += 1;
                    const nativeRemove = node.remove?.bind(node);
                    node.remove = () => {
                        scriptRemovals += 1;
                        nativeRemove?.();
                    };
                    queueMicrotask(() => {
                        if (scriptAttempts === 1) {
                            node.onerror?.(new Event('error'));
                            firstHandlersCleared = node.onload === null && node.onerror === null;
                            return;
                        }
                        window.LivekitClient = { Room: function RetryRoom() {} };
                        node.onload?.(new Event('load'));
                        secondHandlersCleared = node.onload === null && node.onerror === null;
                    });
                    return node;
                }
                return nativeAppendChild(node);
            };

            const { loadLiveKitClient } = await import(`/scripts/modules/voice/livekit-browser.js?retry=${Date.now()}-${Math.random()}`);
            let firstError = '';
            try {
                await loadLiveKitClient();
            } catch (err) {
                firstError = err?.message || String(err);
            }
            const sdk = await loadLiveKitClient();
            return {
                firstError,
                scriptAttempts,
                scriptRemovals,
                firstHandlersCleared,
                secondHandlersCleared,
                hasRoom: typeof sdk?.Room === 'function',
            };
        }

        async function smokeTusRetry() {
            delete window.tus;
            let scriptAttempts = 0;
            let scriptRemovals = 0;
            let firstHandlersCleared = false;
            let secondHandlersCleared = false;
            document.head.appendChild = (node) => {
                const src = String(node?.src || '');
                if (node?.tagName === 'SCRIPT' && src.includes('tus-js-client')) {
                    scriptAttempts += 1;
                    const nativeRemove = node.remove?.bind(node);
                    node.remove = () => {
                        scriptRemovals += 1;
                        nativeRemove?.();
                    };
                    queueMicrotask(() => {
                        if (scriptAttempts === 1) {
                            node.onerror?.(new Event('error'));
                            firstHandlersCleared = node.onload === null && node.onerror === null;
                            return;
                        }
                        window.tus = { Upload: function RetryUpload() {} };
                        node.onload?.(new Event('load'));
                        secondHandlersCleared = node.onload === null && node.onerror === null;
                    });
                    return node;
                }
                return nativeAppendChild(node);
            };

            const { loadTusClient } = await import(`/scripts/modules/collab/tus-client.js?retry=${Date.now()}-${Math.random()}`);
            let firstError = '';
            try {
                await loadTusClient();
            } catch (err) {
                firstError = err?.message || String(err);
            }
            const tus = await loadTusClient();
            return {
                firstError,
                scriptAttempts,
                scriptRemovals,
                firstHandlersCleared,
                secondHandlersCleared,
                hasUpload: typeof tus?.Upload === 'function',
            };
        }

        async function smokeSupabaseTimeoutRetry() {
            delete window.supabase;
            window.__LPMVIEW_SUPABASE_CDN_TIMEOUT_MS = 30;
            let scriptAttempts = 0;
            let scriptRemovals = 0;
            let firstNode = null;
            let firstHandlersCleared = false;
            let secondHandlersCleared = false;
            document.head.appendChild = (node) => {
                const src = String(node?.src || '');
                if (node?.tagName === 'SCRIPT' && src.includes('@supabase/supabase-js')) {
                    scriptAttempts += 1;
                    const nativeRemove = node.remove?.bind(node);
                    node.remove = () => {
                        scriptRemovals += 1;
                        nativeRemove?.();
                    };
                    if (scriptAttempts === 1) {
                        firstNode = node;
                        return node;
                    }
                    queueMicrotask(() => {
                        window.supabase = {
                            createClient: (url, anonKey, options) => ({ url, anonKey, options }),
                        };
                        node.onload?.(new Event('load'));
                        secondHandlersCleared = node.onload === null && node.onerror === null;
                    });
                    return node;
                }
                return nativeAppendChild(node);
            };

            const { createSupabaseClient } = await import(`/scripts/modules/collab/supabase-client.js?timeout=${Date.now()}-${Math.random()}`);
            let firstError = '';
            try {
                await createSupabaseClient({ url: 'https://timeout.supabase.co', anonKey: 'anon' });
            } catch (err) {
                firstError = err?.message || String(err);
            }
            firstHandlersCleared = firstNode?.onload === null && firstNode?.onerror === null;
            const client = await createSupabaseClient({ url: 'https://timeout.supabase.co', anonKey: 'anon' });
            return {
                firstError,
                scriptAttempts,
                scriptRemovals,
                firstHandlersCleared,
                secondHandlersCleared,
                secondUrl: client?.url || '',
            };
        }

        async function smokeLiveKitTimeoutRetry() {
            delete window.LivekitClient;
            window.__LPMVIEW_LIVEKIT_CDN_TIMEOUT_MS = 30;
            let scriptAttempts = 0;
            let scriptRemovals = 0;
            let firstNode = null;
            let firstHandlersCleared = false;
            let secondHandlersCleared = false;
            document.head.appendChild = (node) => {
                const src = String(node?.src || '');
                if (node?.tagName === 'SCRIPT' && src.includes('livekit-client')) {
                    scriptAttempts += 1;
                    const nativeRemove = node.remove?.bind(node);
                    node.remove = () => {
                        scriptRemovals += 1;
                        nativeRemove?.();
                    };
                    if (scriptAttempts === 1) {
                        firstNode = node;
                        return node;
                    }
                    queueMicrotask(() => {
                        window.LivekitClient = { Room: function TimeoutRetryRoom() {} };
                        node.onload?.(new Event('load'));
                        secondHandlersCleared = node.onload === null && node.onerror === null;
                    });
                    return node;
                }
                return nativeAppendChild(node);
            };

            const { loadLiveKitClient } = await import(`/scripts/modules/voice/livekit-browser.js?timeout=${Date.now()}-${Math.random()}`);
            let firstError = '';
            try {
                await loadLiveKitClient();
            } catch (err) {
                firstError = err?.message || String(err);
            }
            firstHandlersCleared = firstNode?.onload === null && firstNode?.onerror === null;
            const sdk = await loadLiveKitClient();
            return {
                firstError,
                scriptAttempts,
                scriptRemovals,
                firstHandlersCleared,
                secondHandlersCleared,
                hasRoom: typeof sdk?.Room === 'function',
            };
        }

        async function smokeTusTimeoutRetry() {
            delete window.tus;
            window.__LPMVIEW_TUS_CDN_TIMEOUT_MS = 30;
            let scriptAttempts = 0;
            let scriptRemovals = 0;
            let firstNode = null;
            let firstHandlersCleared = false;
            let secondHandlersCleared = false;
            document.head.appendChild = (node) => {
                const src = String(node?.src || '');
                if (node?.tagName === 'SCRIPT' && src.includes('tus-js-client')) {
                    scriptAttempts += 1;
                    const nativeRemove = node.remove?.bind(node);
                    node.remove = () => {
                        scriptRemovals += 1;
                        nativeRemove?.();
                    };
                    if (scriptAttempts === 1) {
                        firstNode = node;
                        return node;
                    }
                    queueMicrotask(() => {
                        window.tus = { Upload: function TimeoutRetryUpload() {} };
                        node.onload?.(new Event('load'));
                        secondHandlersCleared = node.onload === null && node.onerror === null;
                    });
                    return node;
                }
                return nativeAppendChild(node);
            };

            const { loadTusClient } = await import(`/scripts/modules/collab/tus-client.js?timeout=${Date.now()}-${Math.random()}`);
            let firstError = '';
            try {
                await loadTusClient();
            } catch (err) {
                firstError = err?.message || String(err);
            }
            firstHandlersCleared = firstNode?.onload === null && firstNode?.onerror === null;
            const tus = await loadTusClient();
            return {
                firstError,
                scriptAttempts,
                scriptRemovals,
                firstHandlersCleared,
                secondHandlersCleared,
                hasUpload: typeof tus?.Upload === 'function',
            };
        }

        try {
            const supabase = await smokeSupabaseRetry();
            const livekit = await smokeLiveKitRetry();
            const tus = await smokeTusRetry();
            const supabaseTimeout = await smokeSupabaseTimeoutRetry();
            const livekitTimeout = await smokeLiveKitTimeoutRetry();
            const tusTimeout = await smokeTusTimeoutRetry();
            return { supabase, livekit, tus, supabaseTimeout, livekitTimeout, tusTimeout };
        } finally {
            document.head.appendChild = nativeAppendChild;
            delete window.supabase;
            delete window.LivekitClient;
            delete window.tus;
            delete window.__LPMVIEW_SUPABASE_CDN_TIMEOUT_MS;
            delete window.__LPMVIEW_LIVEKIT_CDN_TIMEOUT_MS;
            delete window.__LPMVIEW_TUS_CDN_TIMEOUT_MS;
        }
    });

    assert.equal(result.supabase.firstError, 'Supabase UMD failed to load.', 'SDK retry smoke: expected first Supabase load to fail');
    assert.equal(result.supabase.scriptAttempts, 2, 'SDK retry smoke: Supabase loader did not retry after failed script');
    assert.equal(result.supabase.scriptRemovals, 1, 'SDK retry smoke: Supabase failed script was not removed');
    assert.equal(result.supabase.firstHandlersCleared, true, 'SDK retry smoke: Supabase failed script handlers were not cleared');
    assert.equal(result.supabase.secondHandlersCleared, true, 'SDK retry smoke: Supabase loaded script handlers were not cleared');
    assert.equal(result.supabase.secondUrl, 'https://retry.supabase.co', 'SDK retry smoke: Supabase retry did not create client');
    assert.equal(result.supabase.secondAnonKey, 'anon', 'SDK retry smoke: Supabase retry used wrong anon key');
    assert.equal(result.livekit.firstError, 'LiveKit browser SDK failed to load.', 'SDK retry smoke: expected first LiveKit load to fail');
    assert.equal(result.livekit.scriptAttempts, 2, 'SDK retry smoke: LiveKit loader did not retry after failed script');
    assert.equal(result.livekit.scriptRemovals, 1, 'SDK retry smoke: LiveKit failed script was not removed');
    assert.equal(result.livekit.firstHandlersCleared, true, 'SDK retry smoke: LiveKit failed script handlers were not cleared');
    assert.equal(result.livekit.secondHandlersCleared, true, 'SDK retry smoke: LiveKit loaded script handlers were not cleared');
    assert.equal(result.livekit.hasRoom, true, 'SDK retry smoke: LiveKit retry did not resolve SDK');
    assert.equal(result.tus.firstError, 'Failed to load tus-js-client from CDN.', 'SDK retry smoke: expected first TUS load to fail');
    assert.equal(result.tus.scriptAttempts, 2, 'SDK retry smoke: TUS loader did not retry after failed script');
    assert.equal(result.tus.scriptRemovals, 1, 'SDK retry smoke: TUS failed script was not removed');
    assert.equal(result.tus.firstHandlersCleared, true, 'SDK retry smoke: TUS failed script handlers were not cleared');
    assert.equal(result.tus.secondHandlersCleared, true, 'SDK retry smoke: TUS loaded script handlers were not cleared');
    assert.equal(result.tus.hasUpload, true, 'SDK retry smoke: TUS retry did not resolve Upload API');
    assert.equal(result.supabaseTimeout.firstError, 'Supabase UMD load timed out.', 'SDK retry smoke: expected hanging Supabase load to time out');
    assert.equal(result.supabaseTimeout.scriptAttempts, 2, 'SDK retry smoke: Supabase loader did not retry after timed-out script');
    assert.equal(result.supabaseTimeout.scriptRemovals, 1, 'SDK retry smoke: Supabase timed-out script was not removed');
    assert.equal(result.supabaseTimeout.firstHandlersCleared, true, 'SDK retry smoke: Supabase timed-out script handlers were not cleared');
    assert.equal(result.supabaseTimeout.secondHandlersCleared, true, 'SDK retry smoke: Supabase post-timeout script handlers were not cleared');
    assert.equal(result.supabaseTimeout.secondUrl, 'https://timeout.supabase.co', 'SDK retry smoke: Supabase timeout retry did not create client');
    assert.equal(result.livekitTimeout.firstError, 'LiveKit browser SDK load timed out.', 'SDK retry smoke: expected hanging LiveKit load to time out');
    assert.equal(result.livekitTimeout.scriptAttempts, 2, 'SDK retry smoke: LiveKit loader did not retry after timed-out script');
    assert.equal(result.livekitTimeout.scriptRemovals, 1, 'SDK retry smoke: LiveKit timed-out script was not removed');
    assert.equal(result.livekitTimeout.firstHandlersCleared, true, 'SDK retry smoke: LiveKit timed-out script handlers were not cleared');
    assert.equal(result.livekitTimeout.secondHandlersCleared, true, 'SDK retry smoke: LiveKit post-timeout script handlers were not cleared');
    assert.equal(result.livekitTimeout.hasRoom, true, 'SDK retry smoke: LiveKit timeout retry did not resolve SDK');
    assert.equal(result.tusTimeout.firstError, 'tus-js-client CDN load timed out.', 'SDK retry smoke: expected hanging TUS load to time out');
    assert.equal(result.tusTimeout.scriptAttempts, 2, 'SDK retry smoke: TUS loader did not retry after timed-out script');
    assert.equal(result.tusTimeout.scriptRemovals, 1, 'SDK retry smoke: TUS timed-out script was not removed');
    assert.equal(result.tusTimeout.firstHandlersCleared, true, 'SDK retry smoke: TUS timed-out script handlers were not cleared');
    assert.equal(result.tusTimeout.secondHandlersCleared, true, 'SDK retry smoke: TUS post-timeout script handlers were not cleared');
    assert.equal(result.tusTimeout.hasUpload, true, 'SDK retry smoke: TUS timeout retry did not resolve Upload API');
    diagnostics.assertNoErrors('Browser SDK retry smoke');
    await page.close();
}

async function runCollabCrudStaleSmoke(browser, baseUrl) {
    const page = await browser.newPage();
    const diagnostics = attachPageDiagnostics(page);
    await page.addInitScript(() => {
        window.__SUPABASE_URL = 'https://smoke.supabase.co';
        window.__SUPABASE_ANON_KEY = 'smoke-key';

        const calls = {
            createClient: 0,
            getUser: 0,
            signIn: 0,
            createProject: 0,
            projectPayload: null,
        };
        let resolveCreateProject;
        const createProjectPromise = new Promise((resolve) => {
            resolveCreateProject = resolve;
        });
        window.__lpmCrudSmoke = calls;
        window.__lpmResolveCreateProject = (payload) => resolveCreateProject(payload);

        class FakeQuery {
            constructor(table) {
                this.table = table;
                this.payload = null;
            }
            insert(payload) {
                this.payload = payload;
                return this;
            }
            select() {
                return this;
            }
            eq() {
                return this;
            }
            order() {
                if (this.table === 'projects') return Promise.resolve({ data: [], error: null });
                if (this.table === 'rooms') return Promise.resolve({ data: [], error: null });
                return Promise.resolve({ data: [], error: null });
            }
            maybeSingle() {
                if (this.table === 'profiles') {
                    return Promise.resolve({ data: { display_name: 'Smoke User' }, error: null });
                }
                return Promise.resolve({ data: null, error: null });
            }
            single() {
                if (this.table === 'projects') {
                    calls.createProject += 1;
                    calls.projectPayload = { ...(this.payload || {}) };
                    return createProjectPromise;
                }
                return Promise.resolve({ data: { id: `${this.table}-row`, ...(this.payload || {}) }, error: null });
            }
        }

        window.supabase = {
            createClient() {
                calls.createClient += 1;
                return {
                    auth: {
                        getUser() {
                            calls.getUser += 1;
                            return Promise.resolve({ data: { user: null }, error: null });
                        },
                        signInWithPassword() {
                            calls.signIn += 1;
                            return Promise.resolve({
                                data: {
                                    user: {
                                        id: 'registered-user',
                                        email: 'crud@example.com',
                                        user_metadata: { display_name: 'Smoke User' },
                                    },
                                },
                                error: null,
                            });
                        },
                        signOut: () => Promise.resolve({ error: null }),
                        getSession: () => Promise.resolve({ data: { session: null }, error: null }),
                        resetPasswordForEmail: () => Promise.resolve({ error: null }),
                        resend: () => Promise.resolve({ error: null }),
                    },
                    from: (table) => new FakeQuery(table),
                    rpc: () => Promise.resolve({ data: false, error: null }),
                };
            },
        };
    });
    await page.goto(`${baseUrl}/?renderer=webgl`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForFunction(() => (
        !!globalThis.viewerApp && !document.body.classList.contains('app-loading')
    ), null, { timeout: 45000 });

    const result = await page.evaluate(async () => {
        document.querySelector('#collabName').value = 'Smoke User';
        document.querySelector('#collabEmail').value = 'crud@example.com';
        document.querySelector('#collabPassword').value = 'secret123';
        document.querySelector('#collabJoinBtn').click();

        while ((globalThis.__lpmCrudSmoke?.signIn || 0) < 1) {
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
        while (!Array.from(document.querySelector('#collabProjectSelect')?.options || [])
            .some((option) => option.value === '__create__')) {
            await new Promise((resolve) => setTimeout(resolve, 0));
        }

        const input = document.querySelector('#collabProjectNameInput');
        input.value = 'Late Project';
        input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
        while ((globalThis.__lpmCrudSmoke?.createProject || 0) < 1) {
            await new Promise((resolve) => setTimeout(resolve, 0));
        }

        await globalThis.viewerApp.dispose();
        globalThis.__lpmResolveCreateProject({
            data: {
                id: 'created-project',
                name: 'Late Project',
                slug: 'late-project',
                owner_id: 'registered-user',
                created_at: '2026-01-01T00:00:00Z',
            },
            error: null,
        });
        await new Promise((resolve) => setTimeout(resolve, 30));

        const projectOptions = Array.from(document.querySelector('#collabProjectSelect')?.options || [])
            .map((option) => option.value);
        return {
            ...globalThis.__lpmCrudSmoke,
            projectOptions,
            inputValue: input.value,
        };
    });

    assert.equal(result.createProject, 1, 'Collab CRUD stale smoke: project create did not start');
    assert.equal(result.projectPayload?.name, 'Late Project', 'Collab CRUD stale smoke: project create payload mismatch');
    assert.equal(result.projectOptions.includes('created-project'), false, 'Collab CRUD stale smoke: stale project create mutated select');
    assert.equal(result.inputValue, 'Late Project', 'Collab CRUD stale smoke: stale project create cleared input');
    diagnostics.assertNoErrors('Collab CRUD stale smoke');
    await page.close();
}

async function runCollabAutoResumeKeepsModelsSmoke(browser, baseUrl) {
    const page = await browser.newPage();
    const diagnostics = attachPageDiagnostics(page, {
        ignoreConsoleError: (text) => (
            text.includes('Collab init failed')
            || text.includes('Collab auto-resume failed')
        ),
    });
    await page.addInitScript(() => {
        window.__SUPABASE_URL = 'https://smoke.supabase.co';
        window.__SUPABASE_ANON_KEY = 'smoke-key';

        const project = {
            id: 'project-1',
            name: 'Smoke Project',
            slug: 'smoke-project',
            owner_id: 'registered-user',
            created_at: '2026-01-01T00:00:00Z',
        };
        const room = {
            id: 'room-1',
            slug: 'smoke-room',
            project_id: 'project-1',
            owner_id: 'registered-user',
            created_at: '2026-01-01T00:00:00Z',
            active_model_id: '',
        };
        const user = {
            id: 'registered-user',
            email: 'resume@example.com',
            user_metadata: { display_name: 'Resume User' },
        };
        const roomModelId = 'room-model-1';
        const calls = {
            createClient: 0,
            signIn: 0,
            removeChannel: 0,
            roomChannelCreates: 0,
            roomChannelFailures: 0,
            roomModelQueries: 0,
        };
        window.__lpmResumeSmoke = calls;

        class FakeQuery {
            constructor(table) {
                this.table = table;
                this.filters = [];
                this.payload = null;
                this.operation = 'select';
            }
            select() { return this; }
            order() { return this; }
            limit() { return this; }
            eq(column, value) {
                this.filters.push({ column: String(column || ''), value: String(value || '') });
                return this;
            }
            insert(payload) {
                this.operation = 'insert';
                this.payload = payload;
                return this;
            }
            upsert(payload) {
                this.operation = 'upsert';
                this.payload = payload;
                return this;
            }
            update(payload) {
                this.operation = 'update';
                this.payload = payload;
                return this;
            }
            delete() {
                this.operation = 'delete';
                return this;
            }
            hasFilter(column, value) {
                const expected = String(value || '');
                return this.filters.some((entry) => entry.column === column && entry.value === expected);
            }
            async execute() {
                if (this.operation !== 'select') return { data: this.payload || null, error: null };
                if (this.table === 'profiles') return { data: [], error: null };
                if (this.table === 'projects') return { data: [project], error: null };
                if (this.table === 'rooms') return { data: [room], error: null };
                if (this.table === 'room_models') {
                    calls.roomModelQueries += 1;
                    const row = {
                        model_id: roomModelId,
                        sort_order: 0,
                        project_models: null,
                    };
                    if (this.hasFilter('model_id', roomModelId)) {
                        return { data: [row], error: null };
                    }
                    return { data: [row], error: null };
                }
                if (this.table === 'room_cameras') return { data: [], error: null };
                if (this.table === 'annotations') return { data: [], error: null };
                if (this.table === 'messages') return { data: [], error: null };
                return { data: [], error: null };
            }
            async maybeSingle() {
                if (this.table === 'profiles') {
                    return { data: { display_name: 'Resume User' }, error: null };
                }
                if (this.table === 'room_models' && this.hasFilter('model_id', roomModelId)) {
                    calls.roomModelQueries += 1;
                    return { data: { model_id: roomModelId }, error: null };
                }
                if (this.table === 'project_models') {
                    return { data: null, error: null };
                }
                if (this.table === 'rooms') return { data: room, error: null };
                if (this.table === 'projects') return { data: project, error: null };
                return { data: null, error: null };
            }
            async single() {
                return { data: { id: `${this.table}-row`, ...(this.payload || {}) }, error: null };
            }
            then(resolve, reject) {
                return this.execute().then(resolve, reject);
            }
        }

        class FakeChannel {
            constructor(name) {
                this.name = name;
                this.state = 'closed';
                this.socket = { isConnected: () => this.state === 'joined' };
            }
            on() { return this; }
            subscribe(callback) {
                let status = 'SUBSCRIBED';
                if (this.name === 'room:room-1') {
                    calls.roomChannelCreates += 1;
                    if (calls.roomChannelCreates === 2) {
                        calls.roomChannelFailures += 1;
                        status = 'CHANNEL_ERROR';
                    }
                }
                this.state = status === 'SUBSCRIBED' ? 'joined' : 'errored';
                queueMicrotask(() => callback?.(status));
                return this;
            }
            presenceState() {
                return { [user.id]: [{ name: 'Resume User', joinedAt: '2026-01-01T00:00:00Z' }] };
            }
            track() { return Promise.resolve('ok'); }
            send() { return Promise.resolve('ok'); }
            httpSend() { return Promise.resolve('ok'); }
        }

        const client = {
            auth: {
                getUser: () => Promise.resolve({ data: { user: null }, error: null }),
                signInWithPassword: () => {
                    calls.signIn += 1;
                    return Promise.resolve({ data: { user }, error: null });
                },
                signOut: () => Promise.resolve({ error: null }),
                getSession: () => Promise.resolve({ data: { session: null }, error: null }),
                resetPasswordForEmail: () => Promise.resolve({ error: null }),
                resend: () => Promise.resolve({ error: null }),
            },
            from: (table) => new FakeQuery(table),
            rpc: (name) => {
                if (name === 'is_superuser') return Promise.resolve({ data: false, error: null });
                if (name === 'ensure_room_invite') return Promise.resolve({ data: { token: 'resume-token' }, error: null });
                return Promise.resolve({ data: null, error: null });
            },
            channel: (name) => new FakeChannel(String(name || '')),
            removeChannel: () => {
                calls.removeChannel += 1;
                return Promise.resolve({ error: null });
            },
            storage: {
                from: () => ({
                    download: () => Promise.resolve({ data: null, error: null }),
                }),
            },
        };

        window.supabase = {
            createClient() {
                calls.createClient += 1;
                return client;
            },
        };
    });
    await page.goto(`${baseUrl}/?renderer=webgl&debug=1`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForFunction(() => (
        !!globalThis.viewerApp && !document.body.classList.contains('app-loading')
    ), null, { timeout: 45000 });

    const result = await page.evaluate(async () => {
        const waitFor = async (predicate, timeoutMs = 8000) => {
            const started = performance.now();
            while (performance.now() - started < timeoutMs) {
                if (predicate()) return true;
                await new Promise((resolve) => setTimeout(resolve, 25));
            }
            return false;
        };

        document.querySelector('#collabName').value = 'Resume User';
        document.querySelector('#collabEmail').value = 'resume@example.com';
        document.querySelector('#collabPassword').value = 'secret123';
        document.querySelector('#collabJoinBtn').click();
        await waitFor(() => (globalThis.__lpmResumeSmoke?.signIn || 0) >= 1);
        await waitFor(() => Array.from(document.querySelector('#collabRoomSelect')?.options || [])
            .some((option) => option.value === 'room-1'));

        const roomSelect = document.querySelector('#collabRoomSelect');
        roomSelect.value = 'room-1';
        roomSelect.dispatchEvent(new Event('change', { bubbles: true }));
        await waitFor(() => (globalThis.__lpmResumeSmoke?.roomChannelCreates || 0) >= 1);

        const THREE = await import('three');
        const root = new THREE.Group();
        root.name = 'resume-preserved-room-model';
        root.userData.importScope = {
            kind: 'room',
            roomId: 'room-1',
            modelId: 'room-model-1',
        };
        globalThis.viewerApp.scene.add(root);
        globalThis.viewerApp.loadedModels.push({
            obj: root,
            name: 'resume-preserved-room-model.fbx',
            scope: { ...root.userData.importScope },
        });
        const before = {
            loadedCount: globalThis.viewerApp.loadedModels.length,
            inScene: root.parent === globalThis.viewerApp.scene,
            roomChannelCreates: globalThis.__lpmResumeSmoke.roomChannelCreates,
        };

        window.dispatchEvent(new Event('offline'));
        window.dispatchEvent(new Event('online'));
        const recovered = await waitFor(() => (
            (globalThis.__lpmResumeSmoke?.roomChannelCreates || 0) >= 3
            && globalThis.__LPMVIEW_DIAGNOSTICS?.getSnapshot?.().collab?.connected === true
        ), 10000);
        await new Promise((resolve) => setTimeout(resolve, 300));

        const afterRecord = globalThis.viewerApp.loadedModels.find((record) => record?.obj === root) || null;
        const collabDiagnostics = globalThis.__LPMVIEW_DIAGNOSTICS?.getSnapshot?.().collab || null;
        const after = {
            recovered,
            loadedCount: globalThis.viewerApp.loadedModels.length,
            preservedRecord: !!afterRecord,
            inScene: root.parent === globalThis.viewerApp.scene,
            roomChannelCreates: globalThis.__lpmResumeSmoke.roomChannelCreates,
            roomChannelFailures: globalThis.__lpmResumeSmoke.roomChannelFailures,
            removeChannel: globalThis.__lpmResumeSmoke.removeChannel,
            connected: collabDiagnostics?.connected === true,
            realtimeChannels: Number(collabDiagnostics?.totalRealtimeChannels || 0),
        };

        await globalThis.viewerApp.dispose();
        return {
            before,
            after,
            calls: { ...globalThis.__lpmResumeSmoke },
        };
    });

    assert.equal(result.calls.signIn, 1, 'Collab auto-resume smoke: login did not start');
    assert.equal(result.before.loadedCount, 1, 'Collab auto-resume smoke: seeded room model missing before reconnect');
    assert.equal(result.before.inScene, true, 'Collab auto-resume smoke: seeded room model was not in scene');
    assert.equal(result.after.roomChannelFailures, 1, 'Collab auto-resume smoke: transient reconnect failure was not exercised');
    assert.equal(result.after.roomChannelCreates >= 3, true, 'Collab auto-resume smoke: failed reconnect was not retried');
    assert.equal(result.after.removeChannel > 0, true, 'Collab auto-resume smoke: old realtime channels were not disposed');
    assert.equal(result.after.recovered, true, 'Collab auto-resume smoke: reconnect did not become stable');
    assert.equal(result.after.connected, true, 'Collab auto-resume smoke: diagnostics remained offline after retry');
    assert.equal(result.after.realtimeChannels > 0, true, 'Collab auto-resume smoke: retry restored no realtime channels');
    assert.equal(result.after.loadedCount, 1, 'Collab auto-resume smoke: reconnect removed loaded room model');
    assert.equal(result.after.preservedRecord, true, 'Collab auto-resume smoke: loaded model record was not preserved');
    assert.equal(result.after.inScene, true, 'Collab auto-resume smoke: loaded room model was removed from scene');
    diagnostics.assertNoErrors('Collab auto-resume keeps models smoke');
    await page.close();
}

async function runCollabRegisteredRoomSwitchSmoke(browser, baseUrl) {
    const page = await browser.newPage();
    const diagnostics = attachPageDiagnostics(page);
    await page.addInitScript(() => {
        window.__SUPABASE_URL = 'https://smoke.supabase.co';
        window.__SUPABASE_ANON_KEY = 'smoke-key';

        const project = {
            id: 'project-switch',
            name: 'Switch Project',
            slug: 'switch-project',
            owner_id: 'registered-user',
            created_at: '2026-01-01T00:00:00Z',
        };
        const projectB = {
            id: 'project-switch-b',
            name: 'Switch Project B',
            slug: 'switch-project-b',
            owner_id: 'registered-user',
            created_at: '2026-01-01T00:00:00Z',
        };
        const foreignProject = {
            id: 'project-foreign',
            name: 'Foreign Project',
            slug: 'foreign-project',
            owner_id: 'other-user',
            created_at: '2026-01-01T00:00:00Z',
        };
        const projects = [project, projectB, foreignProject];
        const rooms = [
            {
                id: 'room-a',
                slug: 'room-a',
                project_id: project.id,
                owner_id: 'registered-user',
                created_at: '2026-01-01T00:00:00Z',
                active_model_id: '',
            },
            {
                id: 'room-b',
                slug: 'room-b',
                project_id: project.id,
                owner_id: 'registered-user',
                created_at: '2026-01-01T00:00:00Z',
                active_model_id: '',
            },
            {
                id: 'room-c',
                slug: 'room-c',
                project_id: projectB.id,
                owner_id: 'registered-user',
                created_at: '2026-01-01T00:00:00Z',
                active_model_id: '',
            },
            {
                id: 'room-foreign',
                slug: 'room-foreign',
                project_id: foreignProject.id,
                owner_id: 'other-user',
                created_at: '2026-01-01T00:00:00Z',
                active_model_id: '',
            },
        ];
        const user = {
            id: 'registered-user',
            email: 'switch@example.com',
            user_metadata: { display_name: 'Switch User' },
        };
        const calls = {
            signIn: 0,
            removeChannel: 0,
            roomAChannelCreates: 0,
            roomBChannelCreates: 0,
            roomBChannelErrors: 0,
            roomContentModelDeletes: 0,
            projectModelDeletes: 0,
        };
        const roomContent = {
            roomModels: [],
            projectModels: [],
            annotations: [],
            cameras: [],
        };
        window.__lpmSwitchSmoke = calls;
        window.__lpmSwitchSmokeRoomContent = roomContent;

        class FakeQuery {
            constructor(table) {
                this.table = table;
                this.filters = [];
                this.payload = null;
                this.operation = 'select';
            }
            select() { return this; }
            order() { return this; }
            limit() { return this; }
            eq(column, value) {
                this.filters.push({ column: String(column || ''), value: String(value || '') });
                return this;
            }
            insert(payload) {
                this.operation = 'insert';
                this.payload = payload;
                return this;
            }
            upsert(payload) {
                this.operation = 'upsert';
                this.payload = payload;
                return this;
            }
            update(payload) {
                this.operation = 'update';
                this.payload = payload;
                return this;
            }
            delete() {
                this.operation = 'delete';
                return this;
            }
            hasFilter(column, value) {
                const expected = String(value || '');
                return this.filters.some((entry) => entry.column === column && entry.value === expected);
            }
            matchesFilters(row) {
                return this.filters.every((entry) => String(row?.[entry.column] || '') === entry.value);
            }
            async execute() {
                if (['projects', 'rooms'].includes(this.table) && this.operation !== 'select') {
                    const list = this.table === 'projects' ? projects : rooms;
                    if (this.operation === 'insert') {
                        const row = { id: `${this.table}-admin-created`, created_at: '2026-01-01', ...this.payload };
                        list.push(row);
                        return { data: [row], error: null };
                    }
                    const affected = list.filter((row) => this.matchesFilters(row));
                    if (this.operation === 'update') affected.forEach((row) => Object.assign(row, this.payload));
                    if (this.operation === 'delete') affected.forEach((row) => list.splice(list.indexOf(row), 1));
                    return { data: affected, error: null };
                }
                if (this.operation === 'delete') {
                    if (this.table === 'room_models') {
                        const before = roomContent.roomModels.length;
                        roomContent.roomModels = roomContent.roomModels.filter((row) => !this.matchesFilters(row));
                        calls.roomContentModelDeletes += before - roomContent.roomModels.length;
                    }
                    if (this.table === 'project_models') {
                        const before = roomContent.projectModels.length;
                        roomContent.projectModels = roomContent.projectModels.filter((row) => !this.matchesFilters(row));
                        calls.projectModelDeletes += before - roomContent.projectModels.length;
                    }
                    if (this.table === 'annotations') {
                        roomContent.annotations = roomContent.annotations.filter((row) => !this.matchesFilters(row));
                    }
                    if (this.table === 'room_cameras') {
                        roomContent.cameras = roomContent.cameras.filter((row) => !this.matchesFilters(row));
                    }
                    return { data: null, error: null };
                }
                if (this.operation === 'update') {
                    if (this.table === 'rooms') {
                        rooms.forEach((room) => {
                            if (this.matchesFilters(room)) Object.assign(room, this.payload || {});
                        });
                    }
                    return { data: this.payload || null, error: null };
                }
                if (this.operation !== 'select') return { data: this.payload || null, error: null };
                if (this.table === 'profiles') return { data: [], error: null };
                if (this.table === 'projects') {
                    const data = projects.filter((row) => this.matchesFilters(row));
                    return { data, error: null };
                }
                if (this.table === 'rooms') {
                    const projectFilter = this.filters.find((entry) => entry.column === 'project_id');
                    const data = projectFilter
                        ? rooms.filter((room) => String(room.project_id) === projectFilter.value)
                        : rooms;
                    return { data, error: null };
                }
                if (this.table === 'room_models') {
                    const data = roomContent.roomModels.filter((row) => this.matchesFilters(row));
                    return { data, error: null };
                }
                if (this.table === 'project_models') {
                    const data = roomContent.projectModels.filter((row) => this.matchesFilters(row));
                    return { data, error: null };
                }
                if (this.table === 'room_cameras') {
                    const data = roomContent.cameras.filter((row) => this.matchesFilters(row));
                    return { data, error: null };
                }
                if (this.table === 'annotations') {
                    const data = roomContent.annotations.filter((row) => this.matchesFilters(row));
                    return { data, error: null };
                }
                if (this.table === 'messages') return { data: [], error: null };
                return { data: [], error: null };
            }
            async maybeSingle() {
                if (['projects', 'rooms'].includes(this.table) && this.operation !== 'select') {
                    const result = await this.execute();
                    return { ...result, data: result.data?.[0] || null };
                }
                if (this.table === 'profiles') {
                    return { data: { display_name: 'Switch User' }, error: null };
                }
                if (this.table === 'rooms') {
                    const room = rooms.find((item) => (
                        this.hasFilter('id', item.id)
                        || (this.hasFilter('project_id', item.project_id) && this.hasFilter('slug', item.slug))
                    ));
                    return { data: room || null, error: null };
                }
                if (this.table === 'projects') {
                    const nextProject = projects.find((item) => (
                        this.hasFilter('id', item.id) || this.hasFilter('slug', item.slug)
                    )) || project;
                    return { data: nextProject, error: null };
                }
                return { data: null, error: null };
            }
            async single() {
                if (['projects', 'rooms'].includes(this.table) && this.operation !== 'select') return this.maybeSingle();
                return { data: { id: `${this.table}-row`, ...(this.payload || {}) }, error: null };
            }
            then(resolve, reject) {
                return this.execute().then(resolve, reject);
            }
        }

        class FakeChannel {
            constructor(name) {
                this.name = name;
                this.state = 'closed';
                this.socket = { isConnected: () => this.state === 'joined' };
            }
            on() { return this; }
            subscribe(callback) {
                this.state = 'joined';
                if (this.name === 'room:room-a') calls.roomAChannelCreates += 1;
                if (this.name === 'room:room-b') calls.roomBChannelCreates += 1;
                if (this.name === 'room:room-b' && calls.roomBChannelErrors < 3) {
                    calls.roomBChannelErrors += 1;
                    this.state = 'errored';
                    queueMicrotask(() => callback?.('CHANNEL_ERROR'));
                    return this;
                }
                queueMicrotask(() => callback?.('SUBSCRIBED'));
                return this;
            }
            presenceState() {
                return { [user.id]: [{ name: 'Switch User', joinedAt: '2026-01-01T00:00:00Z' }] };
            }
            track() { return Promise.resolve('ok'); }
            send() { return Promise.resolve('ok'); }
            httpSend() { return Promise.resolve('ok'); }
        }

        const client = {
            auth: {
                getUser: () => Promise.resolve({ data: { user: null }, error: null }),
                signInWithPassword: () => {
                    calls.signIn += 1;
                    return Promise.resolve({ data: { user }, error: null });
                },
                signOut: () => Promise.resolve({ error: null }),
                getSession: () => Promise.resolve({ data: { session: null }, error: null }),
                resetPasswordForEmail: () => Promise.resolve({ error: null }),
                resend: () => Promise.resolve({ error: null }),
            },
            from: (table) => new FakeQuery(table),
            rpc: (name) => {
                if (name === 'is_superuser') return Promise.resolve({ data: false, error: null });
                if (name === 'ensure_room_invite') return Promise.resolve({ data: { token: 'switch-token' }, error: null });
                if (name === 'project_admin_owners' && window.__holdAdminOwners) {
                    return new Promise((resolve) => { window.__resolveAdminOwners = resolve; });
                }
                return Promise.resolve({ data: null, error: null });
            },
            channel: (name) => new FakeChannel(String(name || '')),
            removeChannel: () => {
                calls.removeChannel += 1;
                return Promise.resolve({ error: null });
            },
            storage: {
                from: () => ({
                    download: () => Promise.resolve({ data: null, error: null }),
                }),
            },
        };

        window.supabase = {
            createClient() {
                return client;
            },
        };
    });
    await page.goto(`${baseUrl}/?renderer=webgl&debug=1`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForFunction(() => (
        !!globalThis.viewerApp && !document.body.classList.contains('app-loading')
    ), null, { timeout: 45000 });

    const result = await page.evaluate(async () => {
        const waitFor = async (predicate, timeoutMs = 8000) => {
            const started = performance.now();
            while (performance.now() - started < timeoutMs) {
                if (predicate()) return true;
                await new Promise((resolve) => setTimeout(resolve, 25));
            }
            return false;
        };
        const optionValues = (selector) => Array.from(document.querySelector(selector)?.options || [])
            .map((option) => option.value);

        document.querySelector('#collabName').value = 'Switch User';
        document.querySelector('#collabEmail').value = 'switch@example.com';
        document.querySelector('#collabPassword').value = 'secret123';
        document.querySelector('#collabJoinBtn').click();
        await waitFor(() => (globalThis.__lpmSwitchSmoke?.signIn || 0) >= 1);

        const projectSelect = document.querySelector('#collabProjectSelect');
        await waitFor(() => optionValues('#collabProjectSelect').includes('project-switch'));
        const projectOptionsAfterLogin = optionValues('#collabProjectSelect');

        const roomContentModel = {
            id: 'inventory-model',
            project_id: 'project-switch',
            name: 'inventory-model.fbx',
            url: 'storage://models/projects/project-switch/inventory-model.fbx',
            meta: {
                size: 1536,
                kind: 'fbx',
                storagePath: 'projects/project-switch/inventory-model.fbx',
                uploadedBy: 'registered-user',
                uploadedByName: 'Switch User',
            },
            created_at: '2026-01-01T00:00:00Z',
        };
        globalThis.__lpmSwitchSmokeRoomContent.projectModels.push(roomContentModel);
        globalThis.__lpmSwitchSmokeRoomContent.roomModels.push({
            room_id: 'room-a',
            project_id: 'project-switch',
            model_id: 'inventory-model',
            sort_order: 0,
            visible: true,
            created_at: '2026-01-01T00:01:00Z',
            project_models: roomContentModel,
        });
        globalThis.__lpmSwitchSmokeRoomContent.annotations.push({
            id: 'anno-a',
            room_id: 'room-a',
            author_id: 'registered-user',
            author_name: 'Switch User',
            kind: 'pin',
            payload: { text: 'pin' },
            created_at: '2026-01-01T00:02:00Z',
        });
        globalThis.__lpmSwitchSmokeRoomContent.cameras.push({
            id: 'camera-a',
            room_id: 'room-a',
            name: 'Camera A',
            position: [1, 2, 3],
            target: [0, 0, 0],
            created_at: '2026-01-01T00:03:00Z',
        });

        const managerButton = document.querySelector('#collabRoomManageBtn');
        const managerButtonVisible = !!managerButton && !managerButton.hidden && managerButton.disabled === false;
        managerButton?.click();
        await waitFor(() => document.querySelector('#roomContentModal')?.classList.contains('show'));
        await waitFor(() => document.querySelectorAll('.project-admin-project').length === 2
            && !document.querySelector('#roomContentRefresh').disabled);
        const adminDefault = document.querySelector('#roomContentTabProjects')?.getAttribute('aria-selected');
        const adminCollapsed = document.querySelectorAll('.project-admin-project[open]').length;
        const press = (root, label) => Array.from(root.querySelectorAll('button')).find((button) => button.textContent === label)?.click();
        const submitAdminName = async (name) => {
            if (!await waitFor(() => document.querySelector('#promptModal')?.classList.contains('show'))) throw new Error('Admin prompt did not open');
            document.querySelector('#promptInput').value = name;
            document.querySelector('#promptOk').click();
            if (!await waitFor(() => document.querySelector('#roomContentStatus')?.textContent === 'Сохранено'
                && !document.querySelector('#roomContentRefresh').disabled)) {
                throw new Error(`Admin save failed: ${document.querySelector('#roomContentStatus')?.textContent}`);
            }
        };
        press(document.querySelector('#roomContentList'), 'Создать проект');
        await submitAdminName('Empty admin project');
        const emptyProjectShown = !!document.querySelector('[data-project-id="projects-admin-created"]');
        const emptyProjectFilter = Array.from(document.querySelector('#roomContentRoomSelect').options)
            .some((option) => option.textContent === 'Empty admin project');
        press(document.querySelector('[data-project-id="projects-admin-created"]'), 'Переименовать проект');
        await submitAdminName('Renamed admin project');
        const renamedProjectShown = document.querySelector('[data-project-id="projects-admin-created"]')?.textContent.includes('Renamed admin project');
        press(document.querySelector('[data-project-id="projects-admin-created"]'), 'Создать комнату');
        await submitAdminName('Admin room');
        const newRoomShown = !!document.querySelector('[data-room-id="rooms-admin-created"]');
        press(document.querySelector('[data-room-id="rooms-admin-created"]'), 'Переименовать');
        await submitAdminName('Renamed room');
        const renamedRoomShown = document.querySelector('[data-room-id="rooms-admin-created"]')?.textContent.includes('Renamed room');
        press(document.querySelector('[data-room-id="rooms-admin-created"]'), 'Удалить комнату');
        await waitFor(() => document.querySelector('#confirmModal')?.classList.contains('show'));
        document.querySelector('#confirmOk').click();
        await waitFor(() => !document.querySelector('[data-room-id="rooms-admin-created"]'));
        press(document.querySelector('[data-project-id="projects-admin-created"]'), 'Удалить проект');
        await waitFor(() => document.querySelector('#confirmModal')?.classList.contains('show'));
        document.querySelector('#confirmOk').click();
        await waitFor(() => !document.querySelector('[data-project-id="projects-admin-created"]'));
        const adminNeverJoined = globalThis.__lpmSwitchSmoke.roomAChannelCreates === 0;
        document.querySelector('#roomContentClose').click();
        globalThis.__holdAdminOwners = true;
        managerButton.click();
        if (!await waitFor(() => !!globalThis.__resolveAdminOwners)) throw new Error('Admin stale request was not started');
        document.querySelector('#roomContentClose').click();
        globalThis.__holdAdminOwners = false;
        managerButton.click();
        await waitFor(() => !document.querySelector('#roomContentRefresh').disabled);
        globalThis.__resolveAdminOwners({ data: [{ user_id: 'registered-user', email: 'stale@example.com' }], error: null });
        await new Promise((resolve) => setTimeout(resolve, 50));
        const staleOwnerIgnored = !document.querySelector('#roomContentList').textContent.includes('stale@example.com');
        document.querySelector('#roomContentTabModels')?.click();
        await waitFor(() => document.querySelector('#roomContentList')?.textContent?.includes('inventory-model.fbx'));
        const managerBeforeDelete = {
            summary: document.querySelector('#roomContentSummary')?.textContent || '',
            listText: document.querySelector('#roomContentList')?.textContent || '',
            modelVisible: document.querySelector('#roomContentList')?.textContent?.includes('inventory-model.fbx') || false,
            locationVisible: (
                document.querySelector('#roomContentList')?.textContent?.includes('Switch Project')
                && document.querySelector('#roomContentList')?.textContent?.includes('room-a')
            ) || false,
            selection: document.querySelector('#roomContentRoomSelect')?.value || '',
            filterOptions: Array.from(document.querySelector('#roomContentRoomSelect')?.options || []).map((option) => option.textContent || ''),
            filterValues: Array.from(document.querySelector('#roomContentRoomSelect')?.options || []).map((option) => option.value || ''),
            filterOptgroups: document.querySelectorAll('#roomContentRoomSelect optgroup').length,
            titleText: document.querySelector('#roomContentTitle')?.textContent || '',
            toolbarLabelText: document.querySelector('.room-content-toolbar .collab-label')?.textContent || '',
            toolbarInHead: !!document.querySelector('.room-content-head > .room-content-toolbar'),
            closeInHead: !!document.querySelector('.room-content-head > #roomContentClose'),
            toolbarInBody: !!document.querySelector('.room-content-body > .room-content-toolbar'),
            userEmailText: document.querySelector('#roomContentUserEmail')?.textContent || '',
            expandedProjects: document.querySelectorAll('.room-content-project[open]').length,
            expandedRooms: document.querySelectorAll('.room-content-room[open]').length,
            projectDeleteButtons: document.querySelectorAll('.room-content-project > summary .room-content-tree-action .btn.danger').length,
            roomDeleteButtons: document.querySelectorAll('.room-content-room > summary .room-content-tree-action .btn.danger').length,
            annotationTabText: '',
            cameraTabText: '',
        };
        document.querySelector('#roomContentTabAnnotations')?.click();
        await waitFor(() => document.querySelector('#roomContentList')?.textContent?.includes('pin'));
        managerBeforeDelete.annotationTabText = document.querySelector('#roomContentList')?.textContent || '';
        document.querySelector('#roomContentTabCameras')?.click();
        await waitFor(() => document.querySelector('#roomContentList')?.textContent?.includes('Camera A'));
        managerBeforeDelete.cameraTabText = document.querySelector('#roomContentList')?.textContent || '';
        document.querySelector('#roomContentTabModels')?.click();
        await waitFor(() => document.querySelector('#roomContentList')?.textContent?.includes('inventory-model.fbx'));
        document.querySelector('.room-content-row:not(.room-content-head) .btn.danger')?.click();
        await waitFor(() => document.querySelector('#confirmModal')?.classList.contains('show'));
        document.querySelector('#confirmOk')?.click();
        await waitFor(() => (globalThis.__lpmSwitchSmoke?.roomContentModelDeletes || 0) >= 1);
        await waitFor(() => !document.querySelector('#roomContentList')?.textContent?.includes('inventory-model.fbx'));
        const managerAfterDelete = {
            modelStillListed: document.querySelector('#roomContentList')?.textContent?.includes('inventory-model.fbx') || false,
            roomModelRows: globalThis.__lpmSwitchSmokeRoomContent.roomModels.length,
            projectModelRows: globalThis.__lpmSwitchSmokeRoomContent.projectModels.length,
        };
        document.querySelector('#roomContentClose')?.click();
        await waitFor(() => !document.querySelector('#roomContentModal')?.classList.contains('show'));

        projectSelect.value = 'project-switch';
        projectSelect.dispatchEvent(new Event('change', { bubbles: true }));
        await waitFor(() => optionValues('#collabRoomSelect').includes('room-a'));

        const roomSelect = document.querySelector('#collabRoomSelect');
        roomSelect.value = 'room-a';
        roomSelect.dispatchEvent(new Event('change', { bubbles: true }));
        await waitFor(() => (globalThis.__lpmSwitchSmoke?.roomAChannelCreates || 0) >= 1);

        const THREE = await import('three');
        const root = new THREE.Group();
        root.name = 'room-a-model';
        root.userData.importScope = {
            kind: 'room',
            roomId: 'room-a',
            modelId: 'room-a-model',
        };
        globalThis.viewerApp.scene.add(root);
        globalThis.viewerApp.loadedModels.push({
            obj: root,
            name: 'room-a-model.fbx',
            scope: { ...root.userData.importScope },
        });
        const localRoot = new THREE.Group();
        localRoot.name = 'local-model-before-switch';
        globalThis.viewerApp.scene.add(localRoot);
        globalThis.viewerApp.loadedModels.push({
            obj: localRoot,
            name: 'local-before-switch.fbx',
        });
        globalThis.viewerApp.undoStack.push({ model: localRoot });

        const controlsAfterRoomA = {
            projectDisabled: document.querySelector('#collabProjectSelect')?.disabled,
            roomDisabled: document.querySelector('#collabRoomSelect')?.disabled,
            projectOptions: optionValues('#collabProjectSelect'),
            roomOptions: optionValues('#collabRoomSelect'),
        };

        roomSelect.value = 'room-b';
        roomSelect.dispatchEvent(new Event('change', { bubbles: true }));
        await waitFor(() => (globalThis.__lpmSwitchSmoke?.roomBChannelCreates || 0) >= 4);
        await waitFor(() => globalThis.viewerApp.loadedModels.length === 0 && !root.parent && !localRoot.parent);
        await new Promise((resolve) => setTimeout(resolve, 100));

        const snapshot = globalThis.__LPMVIEW_DIAGNOSTICS.getSnapshot();
        const afterSwitch = {
            projectDisabled: document.querySelector('#collabProjectSelect')?.disabled,
            roomDisabled: document.querySelector('#collabRoomSelect')?.disabled,
            currentRoom: document.querySelector('#collabRoomSelect')?.value,
            oldRootDetached: !root.parent,
            localRootDetached: !localRoot.parent,
            loadedModels: globalThis.viewerApp.loadedModels.length,
            loadedRoomAModels: globalThis.viewerApp.loadedModels.filter((record) => (
                record?.obj?.userData?.importScope?.roomId === 'room-a'
            )).length,
            undoStack: globalThis.viewerApp.undoStack.length,
            removeChannel: globalThis.__lpmSwitchSmoke.removeChannel,
            realtimeChannels: snapshot.collab.totalRealtimeChannels,
            roomSelectionLocked: snapshot.collab.roomSelectionLocked,
        };

        const roomBRoot = new THREE.Group();
        roomBRoot.name = 'room-b-local-model';
        globalThis.viewerApp.scene.add(roomBRoot);
        globalThis.viewerApp.loadedModels.push({
            obj: roomBRoot,
            name: 'room-b-local.fbx',
        });
        projectSelect.value = 'project-switch-b';
        projectSelect.dispatchEvent(new Event('change', { bubbles: true }));
        await waitFor(() => optionValues('#collabRoomSelect').includes('room-c'));
        await waitFor(() => globalThis.viewerApp.loadedModels.length === 0 && !roomBRoot.parent);
        const afterProjectSwitch = {
            currentProject: document.querySelector('#collabProjectSelect')?.value,
            roomOptions: optionValues('#collabRoomSelect'),
            roomBRootDetached: !roomBRoot.parent,
            loadedModels: globalThis.viewerApp.loadedModels.length,
        };

        await globalThis.viewerApp.dispose();
        return {
            calls: { ...globalThis.__lpmSwitchSmoke },
            adminDefault, adminCollapsed, emptyProjectShown, emptyProjectFilter, newRoomShown, renamedProjectShown, renamedRoomShown, adminNeverJoined, staleOwnerIgnored,
            managerButtonVisible,
            projectOptionsAfterLogin,
            managerBeforeDelete,
            managerAfterDelete,
            controlsAfterRoomA,
            afterSwitch,
            afterProjectSwitch,
        };
    });

    assert.equal(result.calls.signIn, 1, 'Registered room switch smoke: login did not start');
    assert.equal(result.adminDefault, 'true', 'Admin: projects must be the initial tab');
    assert.equal(result.adminCollapsed, 0, 'Admin: projects must open collapsed');
    assert.equal(result.emptyProjectShown, true, 'Admin: empty project missing from panel');
    assert.equal(result.emptyProjectFilter, true, 'Admin: empty project missing from filter');
    assert.equal(result.renamedProjectShown, true, 'Admin: project rename failed');
    assert.equal(result.newRoomShown, true, 'Admin: room creation failed');
    assert.equal(result.renamedRoomShown, true, 'Admin: room rename failed');
    assert.equal(result.adminNeverJoined, true, 'Admin: management unexpectedly joined a room');
    assert.equal(result.staleOwnerIgnored, true, 'Admin: response from closed panel leaked into reopened panel');
    assert.equal(result.calls.roomAChannelCreates >= 1, true, 'Registered room switch smoke: first room did not connect');
    assert.equal(result.projectOptionsAfterLogin.includes('project-foreign'), false, 'Registered room switch smoke: non-owned project was exposed to registered user');
    assert.equal(result.managerButtonVisible, true, 'Registered room switch smoke: room content manager button is not available after registered login');
    assert.equal(result.managerBeforeDelete.selection, '__all_projects__', 'Registered room switch smoke: room content manager did not default to all projects');
    assert.equal(result.managerBeforeDelete.filterOptions.includes('Все проекты'), true, 'Registered room switch smoke: project filter did not include all projects');
    assert.equal(result.managerBeforeDelete.filterOptions.includes('Switch Project'), true, 'Registered room switch smoke: project filter did not list owned project');
    assert.equal(result.managerBeforeDelete.filterOptions.includes('Switch Project B'), true, 'Registered room switch smoke: project filter did not list second owned project');
    assert.equal(result.managerBeforeDelete.filterOptions.includes('room-a'), false, 'Registered room switch smoke: project filter listed rooms');
    assert.equal(result.managerBeforeDelete.filterValues.includes('room-a'), false, 'Registered room switch smoke: project filter used room ids');
    assert.equal(result.managerBeforeDelete.filterOptgroups, 0, 'Registered room switch smoke: project filter should not group rooms');
    assert.equal(result.managerBeforeDelete.titleText, '', 'Registered room switch smoke: room content title should be hidden');
    assert.equal(result.managerBeforeDelete.toolbarLabelText, '', 'Registered room switch smoke: room content toolbar label should be hidden');
    assert.equal(result.managerBeforeDelete.toolbarInHead, true, 'Registered room switch smoke: room content toolbar should be in modal head');
    assert.equal(result.managerBeforeDelete.closeInHead, true, 'Registered room switch smoke: room content close button should be in modal head');
    assert.equal(result.managerBeforeDelete.toolbarInBody, false, 'Registered room switch smoke: room content toolbar should not be in modal body');
    assert.equal(result.managerBeforeDelete.userEmailText, 'switch@example.com', 'Registered room switch smoke: room content user email was not shown');
    assert.equal(result.managerBeforeDelete.summary.includes('Комнат: 3'), true, 'Registered room switch smoke: room content manager did not count rooms across projects');
    assert.equal(result.managerBeforeDelete.summary.includes('Моделей: 1'), true, 'Registered room switch smoke: room content manager did not count models');
    assert.equal(result.managerBeforeDelete.summary.includes('Аннотаций: 1'), true, 'Registered room switch smoke: room content manager did not count annotations');
    assert.equal(result.managerBeforeDelete.summary.includes('Камер: 1'), true, 'Registered room switch smoke: room content manager did not count cameras');
    assert.equal(result.managerBeforeDelete.modelVisible, true, 'Registered room switch smoke: room content manager did not list model');
    assert.equal(result.managerBeforeDelete.locationVisible, true, 'Registered room switch smoke: room content manager did not show project and room location');
    assert.equal(result.managerBeforeDelete.expandedProjects, 0, 'Registered room switch smoke: project tree should be collapsed by default');
    assert.equal(result.managerBeforeDelete.expandedRooms, 0, 'Registered room switch smoke: room tree should be collapsed by default');
    assert.equal(result.managerBeforeDelete.projectDeleteButtons, 2, 'Registered room switch smoke: room content manager did not expose project delete buttons');
    assert.equal(result.managerBeforeDelete.roomDeleteButtons, 3, 'Registered room switch smoke: room content manager did not expose room delete buttons');
    assert.equal(result.managerBeforeDelete.annotationTabText.includes('pin'), true, 'Registered room switch smoke: room content manager did not list annotation');
    assert.equal(result.managerBeforeDelete.cameraTabText.includes('Camera A'), true, 'Registered room switch smoke: room content manager did not list camera');
    assert.equal(result.managerBeforeDelete.listText.includes('Foreign Project'), false, 'Registered room switch smoke: room content manager listed non-owned project');
    assert.equal(result.calls.roomContentModelDeletes, 1, 'Registered room switch smoke: room content manager did not delete room model link');
    assert.equal(result.calls.projectModelDeletes, 1, 'Registered room switch smoke: room content manager did not delete orphan project model');
    assert.equal(result.managerAfterDelete.modelStillListed, false, 'Registered room switch smoke: room content manager still listed deleted model');
    assert.equal(result.managerAfterDelete.roomModelRows, 0, 'Registered room switch smoke: room content manager left room model rows');
    assert.equal(result.managerAfterDelete.projectModelRows, 0, 'Registered room switch smoke: room content manager left orphan project model rows');
    assert.equal(result.calls.roomBChannelCreates >= 4, true, 'Registered room switch smoke: second room was not retried after deferred transient channel error');
    assert.equal(result.calls.roomBChannelErrors, 3, 'Registered room switch smoke: deferred transient channel errors were not simulated exactly');
    assert.equal(result.controlsAfterRoomA.projectDisabled, false, 'Registered room switch smoke: project select stayed disabled in registered room');
    assert.equal(result.controlsAfterRoomA.roomDisabled, false, 'Registered room switch smoke: room select stayed disabled in registered room');
    assert.equal(result.controlsAfterRoomA.projectOptions.includes('__create__'), false, 'Registered room switch smoke: project create option was exposed during active room');
    assert.equal(result.controlsAfterRoomA.roomOptions.includes('__create__'), false, 'Registered room switch smoke: room create option was exposed during active room');
    assert.equal(result.afterSwitch.currentRoom, 'room-b', 'Registered room switch smoke: selected room did not update');
    assert.equal(result.afterSwitch.oldRootDetached, true, 'Registered room switch smoke: old room root was not detached');
    assert.equal(result.afterSwitch.localRootDetached, true, 'Registered room switch smoke: unscoped model was not detached');
    assert.equal(result.afterSwitch.loadedModels, 0, 'Registered room switch smoke: scene was not fully reset');
    assert.equal(result.afterSwitch.loadedRoomAModels, 0, 'Registered room switch smoke: old room model records were not removed');
    assert.equal(result.afterSwitch.undoStack, 0, 'Registered room switch smoke: material undo stack survived scene reset');
    assert.equal(result.afterSwitch.removeChannel > 0, true, 'Registered room switch smoke: old realtime channels were not removed');
    assert.equal(result.afterSwitch.projectDisabled, false, 'Registered room switch smoke: project select disabled after switch');
    assert.equal(result.afterSwitch.roomDisabled, false, 'Registered room switch smoke: room select disabled after switch');
    assert.equal(result.afterSwitch.roomSelectionLocked, false, 'Registered room switch smoke: non-link registered session was locked');
    assert.equal(result.afterSwitch.realtimeChannels > 0, true, 'Registered room switch smoke: new room did not report realtime channels');
    assert.equal(result.afterProjectSwitch.currentProject, 'project-switch-b', 'Registered room switch smoke: selected project did not update');
    assert.equal(result.afterProjectSwitch.roomOptions.includes('room-c'), true, 'Registered room switch smoke: next project rooms did not load');
    assert.equal(result.afterProjectSwitch.roomBRootDetached, true, 'Registered room switch smoke: project switch did not detach previous model');
    assert.equal(result.afterProjectSwitch.loadedModels, 0, 'Registered room switch smoke: project switch did not fully reset scene');
    diagnostics.assertNoErrors('Registered room switch smoke');
    await page.close();
}

async function runDisposeReinitSmoke(browser, baseUrl) {
    const page = await browser.newPage();
    await page.addInitScript(() => {
        const nativeAdd = EventTarget.prototype.addEventListener;
        const nativeRemove = EventTarget.prototype.removeEventListener;
        const nativeSetTimeout = window.setTimeout.bind(window);
        const nativeClearTimeout = window.clearTimeout.bind(window);
        const registry = new WeakMap();
        const activeTimeouts = new Set();

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

        window.setTimeout = function patchedSetTimeout(handler, delay = 0, ...args) {
            const token = nativeSetTimeout((...cbArgs) => {
                activeTimeouts.delete(token);
                if (typeof handler === 'function') {
                    handler(...cbArgs);
                } else {
                    (0, eval)(String(handler || ''));
                }
            }, delay, ...args);
            activeTimeouts.add(token);
            return token;
        };

        window.clearTimeout = function patchedClearTimeout(token) {
            activeTimeouts.delete(token);
            return nativeClearTimeout(token);
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
        globalThis.__lpmSmokeActiveTimeoutCount = () => activeTimeouts.size;
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
            documentKeydown: count('document', 'keydown'),
            windowOffline: count('window', 'offline'),
            windowOnline: count('window', 'online'),
            orderClick: count('#orderBtn', 'click'),
            orderModalClick: count('#orderModal', 'click'),
            exportClick: count('#exportBtn', 'click'),
            collabNameKeydown: count('#collabName', 'keydown'),
            collabNameKeyup: count('#collabName', 'keyup'),
            collabEmailKeydown: count('#collabEmail', 'keydown'),
            collabEmailKeyup: count('#collabEmail', 'keyup'),
            collabJoinClick: count('#collabJoinBtn', 'click'),
            collabGuestClick: count('#collabGuestBtn', 'click'),
            camsToggleClick: count('#camsToggleBtn', 'click'),
            camsBarClick: count('#camsBarList', 'click'),
            camsBarDragStart: count('#camsBarList', 'dragstart'),
            camsBarDragOver: count('#camsBarList', 'dragover'),
            camsBarDrop: count('#camsBarList', 'drop'),
            camsBarDragEnd: count('#camsBarList', 'dragend'),
            camsSideClick: count('#camsSideList', 'click'),
            annotatePointerDown: count('#annotateCanvas', 'pointerdown'),
            annotatePointerMove: count('#annotateCanvas', 'pointermove'),
            annotatePointerUp: count('#annotateCanvas', 'pointerup'),
            annotatePointerCancel: count('#annotateCanvas', 'pointercancel'),
            annoToggleClick: count('#annoToggleBtn', 'click'),
            annoVisibleClick: count('#annoVisibleBtn', 'click'),
            annoDrawClick: count('#annoDrawBtn', 'click'),
            statsClick: count('#statsBtn', 'click'),
            gridClick: count('#gridToggleBtn', 'click'),
            resetViewerClick: count('#resetViewerBtn', 'click'),
            resetViewClick: count('#resetViewBtn', 'click'),
            fullscreenClick: count('#fullscreenBtn', 'click'),
            bgToggleClick: count('#bgToggleBtn', 'click'),
            bgAlphaInput: count('#bgAlpha', 'input'),
            bgAlphaChange: count('#bgAlpha', 'change'),
            sunEnabledChange: count('#sunEnabled', 'change'),
            sunDayInput: count('#sunDay', 'input'),
            sunMonthInput: count('#sunMonth', 'input'),
            sunHourInput: count('#sunHour', 'input'),
            sunHourTextChange: count('#sunHourInput', 'change'),
            sunIntensityInput: count('#sunIntensity', 'input'),
            sunIntensityTextChange: count('#sunIntensityInput', 'change'),
            sunNorthInput: count('#sunNorth', 'input'),
            hdriCheckChange: count('#hdriChk', 'change'),
            hdriPresetChange: count('#hdriPreset', 'change'),
            iblIntInput: count('#iblInt', 'input'),
            iblGammaInput: count('#iblGamma', 'input'),
            iblRotInput: count('#iblRot', 'input'),
            hdriExposureInput: count('#hdriExposure', 'input'),
            hdriSaturationInput: count('#hdriSaturation', 'input'),
            hdriBlurInput: count('#hdriBlur', 'input'),
            hemiIntInput: count('#hemiInt', 'input'),
            hemiIntChange: count('#hemiInt', 'change'),
            hemiSkyInput: count('#hemiSky', 'input'),
            hemiSkyChange: count('#hemiSky', 'change'),
            hemiGroundInput: count('#hemiGround', 'input'),
            hemiGroundChange: count('#hemiGround', 'change'),
            shadingChange: count('#shadingMode', 'change'),
            solidToggleClick: count('#solidToggleBtn', 'click'),
            collToggleClick: count('#collToggleBtn', 'click'),
            vpmToggleClick: count('#vpmToggleBtn', 'click'),
            npmToggleClick: count('#npmToggleBtn', 'click'),
            lightHelpersClick: count('#lightHelpersBtn', 'click'),
            lightEmittersClick: count('#lightEmittersBtn', 'click'),
            shadowHelpersClick: count('#shadowHelpersBtn', 'click'),
            shadowDbgClick: count('#shadowDbgBtn', 'click'),
            shadowDbgCloseClick: count('#shadowDbgClose', 'click'),
            shadowApplyClick: count('#shadowApply', 'click'),
            shadowResetClick: count('#shadowReset', 'click'),
            glassOpacityInput: count('#glassOpacity', 'input'),
            glassIorInput: count('#glassIor', 'input'),
            glassTransmissionInput: count('#glassTransmission', 'input'),
            glassReflectInput: count('#glassReflect', 'input'),
            glassRoughInput: count('#glassRough', 'input'),
            glassMetalInput: count('#glassMetal', 'input'),
            glassAttenDistInput: count('#glassAttenDist', 'input'),
            glassAttenColorInput: count('#glassAttenColor', 'input'),
            glassColorInput: count('#glassColor', 'input'),
            glassResetClick: count('#glassReset', 'click'),
            promptOkClick: count('#promptOk', 'click'),
            promptCancelClick: count('#promptCancel', 'click'),
            promptCloseClick: count('#promptClose', 'click'),
            promptModalClick: count('#promptModal', 'click'),
            promptInputKeydown: count('#promptInput', 'keydown'),
            confirmOkClick: count('#confirmOk', 'click'),
            confirmCancelClick: count('#confirmCancel', 'click'),
            confirmCloseClick: count('#confirmClose', 'click'),
            confirmModalClick: count('#confirmModal', 'click'),
            confirmModalKeydown: count('#confirmModal', 'keydown'),
            resetOkClick: count('#resetOk', 'click'),
            resetCancelClick: count('#resetCancel', 'click'),
            resetCloseClick: count('#resetClose', 'click'),
            resetModalClick: count('#resetModal', 'click'),
            resetModalKeydown: count('#resetModal', 'keydown'),
            transitionOkClick: count('#transitionOk', 'click'),
            transitionCancelClick: count('#transitionCancel', 'click'),
            transitionCloseClick: count('#transitionClose', 'click'),
            transitionModalClick: count('#transitionModal', 'click'),
            transitionSecondsKeydown: count('#transitionSeconds', 'keydown'),
            transitionTypeKeydown: count('#transitionType', 'keydown'),
            transitionTrajectoryKeydown: count('#transitionTrajectory', 'keydown'),
            exportOkClick: count('#exportOk', 'click'),
            exportCancelClick: count('#exportCancel', 'click'),
            exportCloseClick: count('#exportClose', 'click'),
            exportModalClick: count('#exportModal', 'click'),
            exportFormatKeydown: count('#exportFormat', 'keydown'),
            exportCoordsKeydown: count('#exportCoords', 'keydown'),
            exportModalKeydown: count('#exportModal', 'keydown'),
            rectAnnotOkClick: count('#rectAnnotOk', 'click'),
            rectAnnotCancelClick: count('#rectAnnotCancel', 'click'),
            rectAnnotCloseClick: count('#rectAnnotClose', 'click'),
            rectAnnotInfoChange: count('#rectAnnotInfo', 'change'),
            rectAnnotModalClick: count('#rectAnnotModal', 'click'),
            rectAnnotModalKeydown: count('#rectAnnotModal', 'keydown'),
            dragListeners: dragTargets.reduce((total, target) => (
                total + dragTypes.reduce((sum, type) => sum + count(target, type), 0)
            ), 0),
            canvasCount: document.querySelectorAll('canvas').length,
            activeTimeoutCount: globalThis.__lpmSmokeActiveTimeoutCount?.() || 0,
        };
    });

    const lifecycleListenerExpectations = Object.freeze({
        statsClick: 1,
        gridClick: 1,
        resetViewerClick: 1,
        resetViewClick: 1,
        fullscreenClick: 1,
        bgToggleClick: 1,
        bgAlphaInput: 2,
        bgAlphaChange: 1,
        sunEnabledChange: 1,
        sunDayInput: 1,
        sunMonthInput: 1,
        sunHourInput: 2,
        sunHourTextChange: 1,
        sunIntensityInput: 1,
        sunIntensityTextChange: 1,
        sunNorthInput: 1,
        hdriCheckChange: 1,
        hdriPresetChange: 2,
        iblIntInput: 2,
        iblGammaInput: 2,
        iblRotInput: 2,
        hdriExposureInput: 2,
        hdriSaturationInput: 2,
        hdriBlurInput: 2,
        hemiIntInput: 2,
        hemiIntChange: 1,
        hemiSkyInput: 1,
        hemiSkyChange: 1,
        hemiGroundInput: 1,
        hemiGroundChange: 1,
        shadingChange: 2,
        solidToggleClick: 1,
        collToggleClick: 1,
        vpmToggleClick: 1,
        npmToggleClick: 1,
        lightHelpersClick: 1,
        lightEmittersClick: 1,
        shadowHelpersClick: 1,
        shadowDbgClick: 1,
        shadowDbgCloseClick: 1,
        shadowApplyClick: 1,
        shadowResetClick: 1,
        glassOpacityInput: 1,
        glassIorInput: 1,
        glassTransmissionInput: 1,
        glassReflectInput: 1,
        glassRoughInput: 1,
        glassMetalInput: 1,
        glassAttenDistInput: 1,
        glassAttenColorInput: 1,
        glassColorInput: 1,
        glassResetClick: 1,
        promptOkClick: 1,
        promptCancelClick: 1,
        promptCloseClick: 1,
        promptModalClick: 1,
        promptInputKeydown: 1,
        confirmOkClick: 1,
        confirmCancelClick: 1,
        confirmCloseClick: 1,
        confirmModalClick: 1,
        confirmModalKeydown: 1,
        resetOkClick: 1,
        resetCancelClick: 1,
        resetCloseClick: 1,
        resetModalClick: 1,
        resetModalKeydown: 1,
        transitionOkClick: 1,
        transitionCancelClick: 1,
        transitionCloseClick: 1,
        transitionModalClick: 1,
        transitionSecondsKeydown: 1,
        transitionTypeKeydown: 1,
        transitionTrajectoryKeydown: 1,
        exportOkClick: 1,
        exportCancelClick: 1,
        exportCloseClick: 1,
        exportModalClick: 1,
        exportFormatKeydown: 1,
        exportCoordsKeydown: 1,
        exportModalKeydown: 1,
        rectAnnotOkClick: 1,
        rectAnnotCancelClick: 1,
        rectAnnotCloseClick: 1,
        rectAnnotInfoChange: 2,
        rectAnnotModalClick: 1,
        rectAnnotModalKeydown: 1,
    });

    function assertLifecycleListeners(snapshot, phase) {
        for (const [key, expected] of Object.entries(lifecycleListenerExpectations)) {
            assert.equal(snapshot[key], expected, `Dispose smoke: ${key} listener count mismatch ${phase}`);
        }
    }

    function assertNoLifecycleListeners(snapshot, phase) {
        for (const key of Object.keys(lifecycleListenerExpectations)) {
            assert.equal(snapshot[key], 0, `Dispose smoke: ${key} listener leaked ${phase}`);
        }
    }

    const firstInit = await readCounts();
    assert.equal(firstInit.fileInputChange, 1, 'Dispose smoke: file input listener missing after first init');
    assert.equal(firstInit.emptyHintClick, 1, 'Dispose smoke: empty hint listener missing after first init');
    assert.equal(firstInit.sampleChange, 2, 'Dispose smoke: sample select listeners missing after first init');
    assert.equal(firstInit.textureCloseClick, 1, 'Dispose smoke: texture close listener missing after first init');
    assert.equal(firstInit.textureModalClick, 1, 'Dispose smoke: texture modal listener missing after first init');
    assert.equal(firstInit.textureBindClick, 1, 'Dispose smoke: texture bind listener missing after first init');
    assert.equal(firstInit.documentKeydown, 3, 'Dispose smoke: document keydown listeners missing after first init');
    assert.equal(firstInit.windowOffline, 1, 'Dispose smoke: window offline listener missing after first init');
    assert.equal(firstInit.windowOnline, 1, 'Dispose smoke: window online listener missing after first init');
    assert.equal(firstInit.orderClick, 1, 'Dispose smoke: order button listener missing after first init');
    assert.equal(firstInit.orderModalClick, 1, 'Dispose smoke: order modal listener missing after first init');
    assert.equal(firstInit.exportClick, 1, 'Dispose smoke: export listener missing after first init');
    assert.equal(firstInit.collabNameKeydown, 1, 'Dispose smoke: collab name keydown listener missing after first init');
    assert.equal(firstInit.collabNameKeyup, 1, 'Dispose smoke: collab name keyup listener missing after first init');
    assert.equal(firstInit.collabEmailKeydown, 1, 'Dispose smoke: collab email keydown listener missing after first init');
    assert.equal(firstInit.collabEmailKeyup, 1, 'Dispose smoke: collab email keyup listener missing after first init');
    assert.equal(firstInit.collabJoinClick, 1, 'Dispose smoke: collab join listener missing after first init');
    assert.equal(firstInit.collabGuestClick, 1, 'Dispose smoke: collab guest listener missing after first init');
    assert.equal(firstInit.camsToggleClick, 1, 'Dispose smoke: camera toggle listener missing after first init');
    assert.equal(firstInit.camsBarClick, 1, 'Dispose smoke: camera bar click listener missing after first init');
    assert.equal(firstInit.camsBarDragStart, 1, 'Dispose smoke: camera bar dragstart listener missing after first init');
    assert.equal(firstInit.camsBarDragOver, 1, 'Dispose smoke: camera bar dragover listener missing after first init');
    assert.equal(firstInit.camsBarDrop, 1, 'Dispose smoke: camera bar drop listener missing after first init');
    assert.equal(firstInit.camsBarDragEnd, 1, 'Dispose smoke: camera bar dragend listener missing after first init');
    assert.equal(firstInit.camsSideClick, 1, 'Dispose smoke: camera side click listener missing after first init');
    assert.ok(firstInit.annotatePointerDown >= 1, 'Dispose smoke: annotation pointerdown listener missing after first init');
    assert.ok(firstInit.annotatePointerMove >= 1, 'Dispose smoke: annotation pointermove listener missing after first init');
    assert.ok(firstInit.annotatePointerUp >= 1, 'Dispose smoke: annotation pointerup listener missing after first init');
    assert.ok(firstInit.annotatePointerCancel >= 1, 'Dispose smoke: annotation pointercancel listener missing after first init');
    assert.equal(firstInit.annoToggleClick, 1, 'Dispose smoke: annotation toggle listener missing after first init');
    assert.equal(firstInit.annoVisibleClick, 1, 'Dispose smoke: annotation visibility listener missing after first init');
    assert.equal(firstInit.annoDrawClick, 0, 'Dispose smoke: annotation draw button unexpectedly present after first init');
    assert.equal(firstInit.dragListeners, 20, 'Dispose smoke: unexpected file drop listener count after first init');
    assert.ok(firstInit.canvasCount >= 1, 'Dispose smoke: renderer canvas missing after first init');
    assertLifecycleListeners(firstInit, 'after first init');

    await page.evaluate(async () => {
        const THREE = await import('three');
        const disposeCounts = {
            originalTexture: 0,
            replacementTexture: 0,
            originalMaterial: 0,
            replacementMaterial: 0,
            uniformTexture: 0,
            uniformArrayTexture: 0,
            uniformMaterial: 0,
            sharedCrossRootTexture: 0,
            sharedCrossRootMaterialTexture: 0,
            sharedCrossRootMaterial: 0,
        };
        const track = (resource, key) => {
            resource.addEventListener?.('dispose', () => {
                disposeCounts[key] += 1;
            });
            return resource;
        };
        const originalTexture = track(new THREE.Texture(), 'originalTexture');
        const replacementTexture = track(new THREE.Texture(), 'replacementTexture');
        const originalMaterial = track(new THREE.MeshStandardMaterial({ map: originalTexture }), 'originalMaterial');
        const replacementMaterial = track(new THREE.MeshStandardMaterial({ map: replacementTexture }), 'replacementMaterial');
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), replacementMaterial);
        mesh.userData._origMaterial = originalMaterial;
        const root = new THREE.Group();
        root.add(mesh);
        const uniformTexture = track(new THREE.Texture(), 'uniformTexture');
        const uniformArrayTexture = track(new THREE.Texture(), 'uniformArrayTexture');
        const uniformMaterial = track(new THREE.MeshBasicMaterial(), 'uniformMaterial');
        uniformMaterial.uniforms = {
            smokeMap: { value: uniformTexture },
            smokeArray: { value: [uniformArrayTexture] },
        };
        const uniformRoot = new THREE.Group();
        uniformRoot.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), uniformMaterial));
        const sharedCrossRootTexture = track(new THREE.Texture(), 'sharedCrossRootTexture');
        const sharedTextureRootA = new THREE.Group();
        const sharedTextureRootB = new THREE.Group();
        sharedTextureRootA.add(new THREE.Mesh(
            new THREE.BoxGeometry(1, 1, 1),
            new THREE.MeshStandardMaterial({ map: sharedCrossRootTexture })
        ));
        sharedTextureRootB.add(new THREE.Mesh(
            new THREE.BoxGeometry(1, 1, 1),
            new THREE.MeshStandardMaterial({ map: sharedCrossRootTexture })
        ));
        const sharedCrossRootMaterialTexture = track(new THREE.Texture(), 'sharedCrossRootMaterialTexture');
        const sharedCrossRootMaterial = track(
            new THREE.MeshStandardMaterial({ map: sharedCrossRootMaterialTexture }),
            'sharedCrossRootMaterial'
        );
        const sharedMaterialRootA = new THREE.Group();
        const sharedMaterialRootB = new THREE.Group();
        sharedMaterialRootA.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), sharedCrossRootMaterial));
        sharedMaterialRootB.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), sharedCrossRootMaterial));
        globalThis.__lpmDisposeMaterialTextureCounts = disposeCounts;
        globalThis.viewerApp.loadedModels.push(
            { obj: root, name: 'dispose-replacement-texture.fbx' },
            { obj: uniformRoot, name: 'dispose-uniform-texture.fbx' },
            { obj: sharedTextureRootA, name: 'shared-texture-a.fbx' },
            { obj: sharedTextureRootB, name: 'shared-texture-b.fbx' },
            { obj: sharedMaterialRootA, name: 'shared-material-a.fbx' },
            { obj: sharedMaterialRootB, name: 'shared-material-b.fbx' },
        );
    });

    await page.evaluate(async () => {
        await globalThis.viewerApp.dispose();
    });
    const afterFirstDispose = await readCounts();
    const disposeResourceCounts = await page.evaluate(() => globalThis.__lpmDisposeMaterialTextureCounts || {});
    assert.equal(disposeResourceCounts.originalTexture, 1, 'Dispose smoke: original material texture was not disposed');
    assert.equal(disposeResourceCounts.replacementTexture, 1, 'Dispose smoke: replacement material texture leaked when _origMaterial exists');
    assert.equal(disposeResourceCounts.originalMaterial, 1, 'Dispose smoke: original material was not disposed');
    assert.equal(disposeResourceCounts.replacementMaterial, 1, 'Dispose smoke: replacement material was not disposed');
    assert.equal(disposeResourceCounts.uniformTexture, 1, 'Dispose smoke: material uniform texture leaked');
    assert.equal(disposeResourceCounts.uniformArrayTexture, 1, 'Dispose smoke: material uniform texture array leaked');
    assert.equal(disposeResourceCounts.uniformMaterial, 1, 'Dispose smoke: material with uniforms was not disposed');
    assert.equal(disposeResourceCounts.sharedCrossRootTexture, 1, 'Dispose smoke: shared cross-model texture was disposed more than once');
    assert.equal(disposeResourceCounts.sharedCrossRootMaterialTexture, 1, 'Dispose smoke: shared cross-model material texture was disposed more than once');
    assert.equal(disposeResourceCounts.sharedCrossRootMaterial, 1, 'Dispose smoke: shared cross-model material was disposed more than once');
    assert.equal(afterFirstDispose.fileInputChange, 0, 'Dispose smoke: file input listener leaked after dispose');
    assert.equal(afterFirstDispose.emptyHintClick, 0, 'Dispose smoke: empty hint listener leaked after dispose');
    assert.equal(afterFirstDispose.sampleChange, 0, 'Dispose smoke: sample select listener leaked after dispose');
    assert.equal(afterFirstDispose.textureCloseClick, 0, 'Dispose smoke: texture close listener leaked after dispose');
    assert.equal(afterFirstDispose.textureModalClick, 0, 'Dispose smoke: texture modal listener leaked after dispose');
    assert.equal(afterFirstDispose.textureBindClick, 0, 'Dispose smoke: texture bind listener leaked after dispose');
    assert.equal(afterFirstDispose.documentKeydown, 0, 'Dispose smoke: document keydown listener leaked after dispose');
    assert.equal(afterFirstDispose.windowOffline, 0, 'Dispose smoke: window offline listener leaked after dispose');
    assert.equal(afterFirstDispose.windowOnline, 0, 'Dispose smoke: window online listener leaked after dispose');
    assert.equal(afterFirstDispose.orderClick, 0, 'Dispose smoke: order button listener leaked after dispose');
    assert.equal(afterFirstDispose.orderModalClick, 0, 'Dispose smoke: order modal listener leaked after dispose');
    assert.equal(afterFirstDispose.exportClick, 0, 'Dispose smoke: export listener leaked after dispose');
    assert.equal(afterFirstDispose.collabNameKeydown, 0, 'Dispose smoke: collab name keydown listener leaked after dispose');
    assert.equal(afterFirstDispose.collabNameKeyup, 0, 'Dispose smoke: collab name keyup listener leaked after dispose');
    assert.equal(afterFirstDispose.collabEmailKeydown, 0, 'Dispose smoke: collab email keydown listener leaked after dispose');
    assert.equal(afterFirstDispose.collabEmailKeyup, 0, 'Dispose smoke: collab email keyup listener leaked after dispose');
    assert.equal(afterFirstDispose.collabJoinClick, 0, 'Dispose smoke: collab join listener leaked after dispose');
    assert.equal(afterFirstDispose.collabGuestClick, 0, 'Dispose smoke: collab guest listener leaked after dispose');
    assert.equal(afterFirstDispose.camsToggleClick, 0, 'Dispose smoke: camera toggle listener leaked after dispose');
    assert.equal(afterFirstDispose.camsBarClick, 0, 'Dispose smoke: camera bar click listener leaked after dispose');
    assert.equal(afterFirstDispose.camsBarDragStart, 0, 'Dispose smoke: camera bar dragstart listener leaked after dispose');
    assert.equal(afterFirstDispose.camsBarDragOver, 0, 'Dispose smoke: camera bar dragover listener leaked after dispose');
    assert.equal(afterFirstDispose.camsBarDrop, 0, 'Dispose smoke: camera bar drop listener leaked after dispose');
    assert.equal(afterFirstDispose.camsBarDragEnd, 0, 'Dispose smoke: camera bar dragend listener leaked after dispose');
    assert.equal(afterFirstDispose.camsSideClick, 0, 'Dispose smoke: camera side click listener leaked after dispose');
    assert.equal(afterFirstDispose.annotatePointerDown, 0, 'Dispose smoke: annotation pointerdown listener leaked after dispose');
    assert.equal(afterFirstDispose.annotatePointerMove, 0, 'Dispose smoke: annotation pointermove listener leaked after dispose');
    assert.equal(afterFirstDispose.annotatePointerUp, 0, 'Dispose smoke: annotation pointerup listener leaked after dispose');
    assert.equal(afterFirstDispose.annotatePointerCancel, 0, 'Dispose smoke: annotation pointercancel listener leaked after dispose');
    assert.equal(afterFirstDispose.annoToggleClick, 0, 'Dispose smoke: annotation toggle listener leaked after dispose');
    assert.equal(afterFirstDispose.annoVisibleClick, 0, 'Dispose smoke: annotation visibility listener leaked after dispose');
    assert.equal(afterFirstDispose.annoDrawClick, 0, 'Dispose smoke: annotation draw listener leaked after dispose');
    assert.equal(afterFirstDispose.dragListeners, 0, 'Dispose smoke: file drop listeners leaked after dispose');
    assert.equal(afterFirstDispose.activeTimeoutCount, 0, 'Dispose smoke: app timeout leaked after dispose');
    assertNoLifecycleListeners(afterFirstDispose, 'after dispose');

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
    assert.equal(secondInit.documentKeydown, 3, 'Dispose smoke: document keydown listeners duplicated after reinit');
    assert.equal(secondInit.windowOffline, 1, 'Dispose smoke: window offline listener duplicated after reinit');
    assert.equal(secondInit.windowOnline, 1, 'Dispose smoke: window online listener duplicated after reinit');
    assert.equal(secondInit.orderClick, 1, 'Dispose smoke: order button listener duplicated after reinit');
    assert.equal(secondInit.orderModalClick, 1, 'Dispose smoke: order modal listener duplicated after reinit');
    assert.equal(secondInit.exportClick, 1, 'Dispose smoke: export listener duplicated after reinit');
    assert.equal(secondInit.collabNameKeydown, 1, 'Dispose smoke: collab name keydown listener duplicated after reinit');
    assert.equal(secondInit.collabNameKeyup, 1, 'Dispose smoke: collab name keyup listener duplicated after reinit');
    assert.equal(secondInit.collabEmailKeydown, 1, 'Dispose smoke: collab email keydown listener duplicated after reinit');
    assert.equal(secondInit.collabEmailKeyup, 1, 'Dispose smoke: collab email keyup listener duplicated after reinit');
    assert.equal(secondInit.collabJoinClick, 1, 'Dispose smoke: collab join listener duplicated after reinit');
    assert.equal(secondInit.collabGuestClick, 1, 'Dispose smoke: collab guest listener duplicated after reinit');
    assert.equal(secondInit.camsToggleClick, 1, 'Dispose smoke: camera toggle listener duplicated after reinit');
    assert.equal(secondInit.camsBarClick, 1, 'Dispose smoke: camera bar click listener duplicated after reinit');
    assert.equal(secondInit.camsBarDragStart, 1, 'Dispose smoke: camera bar dragstart listener duplicated after reinit');
    assert.equal(secondInit.camsBarDragOver, 1, 'Dispose smoke: camera bar dragover listener duplicated after reinit');
    assert.equal(secondInit.camsBarDrop, 1, 'Dispose smoke: camera bar drop listener duplicated after reinit');
    assert.equal(secondInit.camsBarDragEnd, 1, 'Dispose smoke: camera bar dragend listener duplicated after reinit');
    assert.equal(secondInit.camsSideClick, 1, 'Dispose smoke: camera side click listener duplicated after reinit');
    assert.equal(secondInit.annotatePointerDown, firstInit.annotatePointerDown, 'Dispose smoke: annotation pointerdown listener duplicated after reinit');
    assert.equal(secondInit.annotatePointerMove, firstInit.annotatePointerMove, 'Dispose smoke: annotation pointermove listener duplicated after reinit');
    assert.equal(secondInit.annotatePointerUp, firstInit.annotatePointerUp, 'Dispose smoke: annotation pointerup listener duplicated after reinit');
    assert.equal(secondInit.annotatePointerCancel, firstInit.annotatePointerCancel, 'Dispose smoke: annotation pointercancel listener duplicated after reinit');
    assert.equal(secondInit.annoToggleClick, 1, 'Dispose smoke: annotation toggle listener duplicated after reinit');
    assert.equal(secondInit.annoVisibleClick, 1, 'Dispose smoke: annotation visibility listener duplicated after reinit');
    assert.equal(secondInit.annoDrawClick, 0, 'Dispose smoke: annotation draw button unexpectedly present after reinit');
    assert.equal(secondInit.dragListeners, 20, 'Dispose smoke: unexpected file drop listener count after reinit');
    assertLifecycleListeners(secondInit, 'after reinit');

    await page.evaluate(async () => {
        await globalThis.viewerApp.dispose();
    });
    const afterSecondDispose = await readCounts();
    assert.equal(afterSecondDispose.activeTimeoutCount, 0, 'Dispose smoke: app timeout leaked after second dispose');
    diagnostics.assertNoErrors('Dispose/reinit smoke');
    await page.close();
}

async function runRendererDisposeLifecycleSmoke(browser, baseUrl) {
    const page = await browser.newPage();
    const diagnostics = attachPageDiagnostics(page, {
        ignoreConsoleError: (text) => text.includes('WebGPU init failed'),
    });
    await page.goto(`${baseUrl}/__smoke_blank`, { waitUntil: 'domcontentloaded', timeout: 15000 });

    const result = await page.evaluate(async () => {
        const { createRenderer } = await import('/scripts/modules/render/renderer-init.js');

        class FakeWebGLRenderer {
            constructor() {
                this.domElement = document.createElement('canvas');
                this.info = { autoReset: true };
                this.shadowMap = { type: null };
                this.calls = [];
            }
            setAnimationLoop(callback) {
                this.calls.push(callback === null ? 'loop:null' : 'loop:set');
            }
            dispose() {
                this.calls.push('dispose');
            }
            forceContextLoss() {
                this.calls.push('forceContextLoss');
            }
            setPixelRatio(value) {
                this.calls.push(`pixel:${value}`);
            }
        }

        const THREE = {
            WebGLRenderer: FakeWebGLRenderer,
            PCFSoftShadowMap: 'pcf-soft',
            SRGBColorSpace: 'srgb',
            NoToneMapping: 'none',
        };

        const root = document.createElement('div');
        document.body.appendChild(root);
        const webgl = createRenderer({ THREE, rootEl: root });
        const webglRenderer = webgl.renderer;
        const appendedBeforeDispose = root.contains(webglRenderer.domElement);
        webgl.dispose();
        webgl.dispose();

        let resolveInit = null;
        class FakeWebGPURenderer extends FakeWebGLRenderer {
            init() {
                this.calls.push('init');
                return new Promise((resolve) => {
                    resolveInit = resolve;
                });
            }
        }

        const webgpuEvents = [];
        const webgpuRoot = document.createElement('div');
        document.body.appendChild(webgpuRoot);
        const webgpu = createRenderer({
            THREE,
            rootEl: webgpuRoot,
            useWebGPU: true,
            WebGPURendererCtor: FakeWebGPURenderer,
            requestRender: () => webgpuEvents.push('render'),
            setStatusMessage: (message) => webgpuEvents.push(`status:${message}`),
        });
        const webgpuRenderer = webgpu.renderer;
        const readyBeforeDispose = webgpu.getRendererReady();
        webgpu.dispose();
        resolveInit();
        await webgpu.rendererInitPromise;

        class RejectWebGPURenderer extends FakeWebGLRenderer {
            init() {
                this.calls.push('init');
                return Promise.reject(new Error('init failed'));
            }
        }
        const failingEvents = [];
        const failingRoot = document.createElement('div');
        document.body.appendChild(failingRoot);
        const failingWebgpu = createRenderer({
            THREE,
            rootEl: failingRoot,
            useWebGPU: true,
            WebGPURendererCtor: RejectWebGPURenderer,
            requestRender: () => failingEvents.push('render'),
            setStatusMessage: (message) => failingEvents.push(`status:${message}`),
        });
        const failingRenderer = failingWebgpu.renderer;
        const failingResult = await failingWebgpu.rendererInitPromise.then(
            () => 'resolved',
            (err) => err?.message || String(err),
        );
        const failingErrorMessage = failingWebgpu.getRendererError()?.message || '';
        const failingReadyAfterError = failingWebgpu.getRendererReady();
        const failingStillMountedAfterError = failingRoot.contains(failingRenderer.domElement);
        failingWebgpu.dispose();

        return {
            appendedBeforeDispose,
            webglRemoved: !root.contains(webglRenderer.domElement),
            webglCalls: webglRenderer.calls,
            webglAutoResetDisabled: webglRenderer.info.autoReset === false,
            webglShadowType: webglRenderer.shadowMap.type,
            webgpuReadyBeforeDispose: readyBeforeDispose,
            webgpuReadyAfterLateInit: webgpu.getRendererReady(),
            webgpuRemoved: !webgpuRoot.contains(webgpuRenderer.domElement),
            webgpuCalls: webgpuRenderer.calls,
            webgpuEvents,
            failingResult,
            failingErrorMessage,
            failingReadyAfterError,
            failingStillMountedAfterError,
            failingEvents,
        };
    });

    assert.equal(result.appendedBeforeDispose, true, 'Renderer dispose smoke: canvas was not appended');
    assert.equal(result.webglRemoved, true, 'Renderer dispose smoke: canvas stayed in DOM after dispose');
    assert.equal(result.webglAutoResetDisabled, true, 'Renderer dispose smoke: renderer info autoReset was not disabled');
    assert.equal(result.webglShadowType, 'pcf-soft', 'Renderer dispose smoke: WebGL shadow map type was not configured');
    assert.deepEqual(
        result.webglCalls.filter((entry) => entry === 'loop:null'),
        ['loop:null'],
        'Renderer dispose smoke: animation loop was not cleared exactly once',
    );
    assert.deepEqual(
        result.webglCalls.filter((entry) => entry === 'dispose'),
        ['dispose'],
        'Renderer dispose smoke: renderer.dispose was not idempotent',
    );
    assert.deepEqual(
        result.webglCalls.filter((entry) => entry === 'forceContextLoss'),
        ['forceContextLoss'],
        'Renderer dispose smoke: WebGL context was not released exactly once',
    );
    assert.equal(result.webgpuReadyBeforeDispose, false, 'Renderer dispose smoke: WebGPU renderer was ready before init');
    assert.equal(result.webgpuReadyAfterLateInit, false, 'Renderer dispose smoke: disposed WebGPU renderer became ready after late init');
    assert.equal(result.webgpuRemoved, true, 'Renderer dispose smoke: WebGPU canvas stayed in DOM after dispose');
    assert.deepEqual(result.webgpuEvents, [], 'Renderer dispose smoke: disposed late WebGPU init fired callbacks');
    assert.equal(result.failingResult, 'init failed', 'Renderer dispose smoke: WebGPU init failure did not reject init promise');
    assert.equal(result.failingErrorMessage, 'init failed', 'Renderer dispose smoke: WebGPU init failure was not retained');
    assert.equal(result.failingReadyAfterError, false, 'Renderer dispose smoke: failed WebGPU renderer became ready');
    assert.equal(result.failingStillMountedAfterError, true, 'Renderer dispose smoke: failed WebGPU renderer removed canvas before dispose');
    assert.deepEqual(
        result.failingEvents,
        ['status:⚠️ WebGPU: не удалось инициализировать рендерер.'],
        'Renderer dispose smoke: WebGPU init failure fired wrong callbacks',
    );
    assert.deepEqual(
        result.webgpuCalls.filter((entry) => entry === 'dispose'),
        ['dispose'],
        'Renderer dispose smoke: WebGPU renderer dispose was not idempotent',
    );
    diagnostics.assertNoErrors('Renderer dispose lifecycle smoke');
    await page.close();
}

async function runRendererModeDetectionSmoke(browser, baseUrl) {
    const page = await browser.newPage();
    const diagnostics = attachPageDiagnostics(page);
    await page.goto(`${baseUrl}/__smoke_blank`, { waitUntil: 'domcontentloaded', timeout: 15000 });

    const result = await page.evaluate(async () => {
        const { detectRendererMode } = await import('/scripts/modules/render/renderer-mode.js');

        let noAdapterModuleLoads = 0;
        let noAdapterRequests = 0;
        const noAdapter = await detectRendererMode({
            locationSearch: '?renderer=webgpu',
            webgpuSupported: true,
            requestAdapter: async () => {
                noAdapterRequests += 1;
                return null;
            },
            loadWebGPUModule: async () => {
                noAdapterModuleLoads += 1;
                return {};
            },
        });

        let adapterErrorRequests = 0;
        const adapterError = await detectRendererMode({
            locationSearch: '?renderer=webgpu',
            webgpuSupported: true,
            requestAdapter: async () => {
                adapterErrorRequests += 1;
                throw new Error('adapter failed');
            },
            loadWebGPUModule: async () => ({}),
        });

        let hungAdapterRequests = 0;
        const hungAdapter = await detectRendererMode({
            locationSearch: '?renderer=webgpu',
            webgpuSupported: true,
            webgpuDetectionTimeoutMs: 25,
            requestAdapter: async () => {
                hungAdapterRequests += 1;
                return new Promise(() => {});
            },
            loadWebGPUModule: async () => {
                throw new Error('hung adapter should not load webgpu');
            },
        });

        let forcedWebglAdapterRequests = 0;
        const forcedWebgl = await detectRendererMode({
            forcedRendererMode: 'webgl',
            webgpuSupported: true,
            requestAdapter: async () => {
                forcedWebglAdapterRequests += 1;
                return {};
            },
            loadWebGPUModule: async () => {
                throw new Error('forced webgl should not load webgpu');
            },
        });

        const success = await detectRendererMode({
            locationSearch: '?renderer=webgpu',
            webgpuSupported: true,
            requestAdapter: async () => ({ name: 'adapter' }),
            loadWebGPUModule: async () => ({
                WebGPURenderer: function SmokeWebGPURenderer() {},
                MeshBasicNodeMaterial: function SmokeNodeMaterial() {},
            }),
            loadTSLModule: async () => ({
                normalView: {},
                positionViewDirection: {},
                float: function smokeFloat() {},
                vec3: function smokeVec3() {},
            }),
        });

        return {
            noAdapter: {
                activeRendererMode: noAdapter.activeRendererMode,
                useWebGPU: noAdapter.useWebGPU,
                note: noAdapter.rendererModeNote,
                error: noAdapter.webgpuModuleError?.message || '',
            },
            noAdapterRequests,
            noAdapterModuleLoads,
            adapterError: {
                activeRendererMode: adapterError.activeRendererMode,
                useWebGPU: adapterError.useWebGPU,
                note: adapterError.rendererModeNote,
                error: adapterError.webgpuModuleError?.message || '',
            },
            adapterErrorRequests,
            hungAdapter: {
                activeRendererMode: hungAdapter.activeRendererMode,
                useWebGPU: hungAdapter.useWebGPU,
                note: hungAdapter.rendererModeNote,
                errorName: hungAdapter.webgpuModuleError?.name || '',
                error: hungAdapter.webgpuModuleError?.message || '',
            },
            hungAdapterRequests,
            forcedWebgl: {
                activeRendererMode: forcedWebgl.activeRendererMode,
                useWebGPU: forcedWebgl.useWebGPU,
                requestedRendererMode: forcedWebgl.requestedRendererMode,
            },
            forcedWebglAdapterRequests,
            success: {
                activeRendererMode: success.activeRendererMode,
                useWebGPU: success.useWebGPU,
                requestedRendererMode: success.requestedRendererMode,
                hasCtor: typeof success.WebGPURendererCtor === 'function',
                hasNodeSupport: !!success.backfaceNodeSupport?.MeshBasicNodeMaterial,
            },
        };
    });

    assert.deepEqual(result.noAdapter, {
        activeRendererMode: 'webgl',
        useWebGPU: false,
        note: 'fallback: init failed',
        error: 'WebGPU adapter not available',
    }, 'Renderer mode smoke: unavailable WebGPU adapter did not fall back to WebGL');
    assert.equal(result.noAdapterRequests, 1, 'Renderer mode smoke: WebGPU adapter was not requested');
    assert.equal(result.noAdapterModuleLoads, 0, 'Renderer mode smoke: WebGPU module loaded despite missing adapter');
    assert.deepEqual(result.adapterError, {
        activeRendererMode: 'webgl',
        useWebGPU: false,
        note: 'fallback: init failed',
        error: 'adapter failed',
    }, 'Renderer mode smoke: WebGPU adapter error did not fall back to WebGL');
    assert.equal(result.adapterErrorRequests, 1, 'Renderer mode smoke: WebGPU adapter error path was not exercised');
    assert.deepEqual(result.hungAdapter, {
        activeRendererMode: 'webgl',
        useWebGPU: false,
        note: 'fallback: init failed',
        errorName: 'TimeoutError',
        error: 'WebGPU adapter request timed out',
    }, 'Renderer mode smoke: hung WebGPU adapter did not time out and fall back');
    assert.equal(result.hungAdapterRequests, 1, 'Renderer mode smoke: hung WebGPU adapter path was not exercised');
    assert.deepEqual(result.forcedWebgl, {
        activeRendererMode: 'webgl',
        useWebGPU: false,
        requestedRendererMode: 'webgl',
    }, 'Renderer mode smoke: forced WebGL did not stay on WebGL');
    assert.equal(result.forcedWebglAdapterRequests, 0, 'Renderer mode smoke: forced WebGL still requested a WebGPU adapter');
    assert.deepEqual(result.success, {
        activeRendererMode: 'webgpu',
        useWebGPU: true,
        requestedRendererMode: 'webgpu',
        hasCtor: true,
        hasNodeSupport: true,
    }, 'Renderer mode smoke: WebGPU success path did not initialize mode metadata');
    diagnostics.assertNoErrors('Renderer mode detection smoke');
    await page.close();
}

async function runSceneCoreDisposeLifecycleSmoke(browser, baseUrl) {
    const page = await browser.newPage();
    const diagnostics = attachPageDiagnostics(page);
    await page.goto(`${baseUrl}/__smoke_blank`, { waitUntil: 'domcontentloaded', timeout: 15000 });

    const result = await page.evaluate(async () => {
        const THREE = await import('three');
        const { createSceneCore } = await import('/scripts/modules/scene/scene-core.js');

        class FakeRenderer {
            constructor() {
                this.domElement = document.createElement('canvas');
                this.info = { autoReset: true };
                this.shadowMap = { enabled: false, type: null };
                this.calls = [];
            }
            setAnimationLoop(callback) {
                this.calls.push(callback === null ? 'loop:null' : 'loop:set');
            }
            setPixelRatio(value) {
                this.calls.push(`pixel:${value}`);
            }
            setClearColor() {
                this.calls.push('clearColor');
            }
            dispose() {
                this.calls.push('dispose');
            }
            forceContextLoss() {
                this.calls.push('forceContextLoss');
            }
        }

        const root = document.createElement('div');
        document.body.appendChild(root);
        const app = {};
        let renderRequests = 0;
        const core = createSceneCore({
            THREE,
            rootEl: root,
            app,
            useWebGPU: true,
            WebGPURendererCtor: FakeRenderer,
            requestRender: () => { renderRequests += 1; },
            background: {
                isEnvironmentEnabled: () => true,
                getAlpha: () => 1,
                body: document.body,
            },
        });

        const bgMesh = core.backgroundController.ensureBgMesh();
        const shadowMap = new THREE.WebGLRenderTarget(1, 1);
        const shadowMapPass = new THREE.WebGLRenderTarget(1, 1);
        let shadowMapDisposed = 0;
        let shadowMapPassDisposed = 0;
        shadowMap.addEventListener('dispose', () => {
            shadowMapDisposed += 1;
        });
        shadowMapPass.addEventListener('dispose', () => {
            shadowMapPassDisposed += 1;
        });
        core.dirLight.shadow.map = shadowMap;
        core.dirLight.shadow.mapPass = shadowMapPass;

        const childrenBeforeDispose = core.scene.children.length;
        const canvasBeforeDispose = root.contains(core.renderer.domElement);
        const appBgBeforeDispose = app.bgMesh === bgMesh;
        const rendererCallsBeforeDispose = core.renderer.calls.slice();
        core.dispose();
        core.dispose();

        return {
            childrenBeforeDispose,
            canvasBeforeDispose,
            appBgBeforeDispose,
            childrenAfterDispose: core.scene.children.length,
            canvasAfterDispose: root.contains(core.renderer.domElement),
            appBgAfterDispose: app.bgMesh || null,
            shadowMapDisposed,
            shadowMapPassDisposed,
            shadowMapCleared: core.dirLight.shadow.map == null,
            shadowMapPassCleared: core.dirLight.shadow.mapPass == null,
            renderRequests,
            rendererCallsBeforeDispose,
            rendererCallsAfterDispose: core.renderer.calls,
        };
    });

    assert.equal(result.childrenBeforeDispose, 5, 'Scene core smoke: expected world/lights/background children before dispose');
    assert.equal(result.canvasBeforeDispose, true, 'Scene core smoke: renderer canvas was not attached');
    assert.equal(result.appBgBeforeDispose, true, 'Scene core smoke: background mesh was not exposed on app');
    assert.equal(result.childrenAfterDispose, 0, 'Scene core smoke: scene-owned objects stayed attached after dispose');
    assert.equal(result.canvasAfterDispose, false, 'Scene core smoke: renderer canvas stayed attached after dispose');
    assert.equal(result.appBgAfterDispose, null, 'Scene core smoke: app.bgMesh stayed after dispose');
    assert.equal(result.shadowMapDisposed, 1, 'Scene core smoke: directional shadow map was not disposed exactly once');
    assert.equal(result.shadowMapPassDisposed, 1, 'Scene core smoke: directional shadow mapPass was not disposed exactly once');
    assert.equal(result.shadowMapCleared, true, 'Scene core smoke: directional shadow map reference was not cleared');
    assert.equal(result.shadowMapPassCleared, true, 'Scene core smoke: directional shadow mapPass reference was not cleared');
    assert.deepEqual(
        result.rendererCallsAfterDispose.filter((entry) => entry === 'dispose'),
        ['dispose'],
        'Scene core smoke: renderer dispose was not idempotent through scene core',
    );
    assert.deepEqual(
        result.rendererCallsAfterDispose.filter((entry) => entry === 'forceContextLoss'),
        ['forceContextLoss'],
        'Scene core smoke: renderer context was not released through scene core',
    );
    diagnostics.assertNoErrors('Scene core dispose lifecycle smoke');
    await page.close();
}

async function runRenderLoopLifecycleSmoke(browser, baseUrl) {
    const page = await browser.newPage();
    const diagnostics = attachPageDiagnostics(page);
    await page.goto(`${baseUrl}/__smoke_blank`, { waitUntil: 'domcontentloaded', timeout: 15000 });

    const result = await page.evaluate(async () => {
        const { createRenderLoopController } = await import('/scripts/modules/render/render-loop.js');

        function createRafHarness() {
            let nextId = 1;
            const callbacks = new Map();
            const canceled = [];
            return {
                raf(callback) {
                    const id = nextId;
                    nextId += 1;
                    callbacks.set(id, callback);
                    return id;
                },
                cancel(id) {
                    canceled.push(id);
                    callbacks.delete(id);
                },
                flushOne(time = 16) {
                    const entry = callbacks.entries().next().value;
                    if (!entry) return false;
                    const [id, callback] = entry;
                    callbacks.delete(id);
                    callback(time);
                    return true;
                },
                flushAll(limit = 20) {
                    let count = 0;
                    while (callbacks.size && count < limit) {
                        count += 1;
                        this.flushOne(16 + count);
                    }
                    return count;
                },
                get pendingCount() {
                    return callbacks.size;
                },
                canceled,
            };
        }

        const rafHarness = createRafHarness();
        let rafControlsUpdates = 0;
        let rafFrames = 0;
        let rafRenders = 0;
        let rafStats = 0;
        let rafInfoResets = 0;
        const rafRenderer = {
            info: {
                autoReset: false,
                render: { calls: 0 },
                memory: { geometries: 2, textures: 3 },
                programs: [{}, {}],
                reset: () => {
                    rafInfoResets += 1;
                },
            },
            render: () => {
                rafRenders += 1;
                rafRenderer.info.render.calls = rafRenders;
            },
        };
        const rafLoop = createRenderLoopController({
            controls: {
                update: () => {
                    rafControlsUpdates += 1;
                    return rafControlsUpdates === 1;
                },
            },
            renderer: rafRenderer,
            scene: { name: 'scene' },
            camera: { name: 'camera' },
            requestAnimationFrame: (callback) => rafHarness.raf(callback),
            cancelAnimationFrame: (id) => rafHarness.cancel(id),
            onFrame: () => {
                rafFrames += 1;
            },
            updateStatsOverlay: () => {
                rafStats += 1;
            },
        });
        rafLoop.start();
        const rafPendingAfterStart = rafHarness.pendingCount;
        rafHarness.flushOne(16);
        const rafAfterFirst = {
            controls: rafControlsUpdates,
            frames: rafFrames,
            renders: rafRenders,
            stats: rafStats,
            resets: rafInfoResets,
            pending: rafHarness.pendingCount,
            lastStats: rafLoop.getLastRenderStats(),
        };
        rafLoop.dispose();
        const rafCanceledOnDispose = rafHarness.canceled.length;
        const rafPendingAfterDispose = rafHarness.pendingCount;
        rafHarness.flushAll();
        const rafRendersAfterLateFlush = rafRenders;

        const renderErrorHarness = createRafHarness();
        const renderErrors = [];
        const renderErrorLoop = createRenderLoopController({
            renderer: {
                info: { render: {}, memory: {} },
                render: () => {
                    throw new Error('render failed');
                },
            },
            requestAnimationFrame: (callback) => renderErrorHarness.raf(callback),
            cancelAnimationFrame: (id) => renderErrorHarness.cancel(id),
            onError: (err, meta) => renderErrors.push(`${meta?.phase || ''}:${err?.message || err}`),
        });
        renderErrorLoop.start();
        renderErrorHarness.flushOne(16);

        const controlsErrorHarness = createRafHarness();
        const controlsErrors = [];
        let controlsErrorRenders = 0;
        const controlsErrorLoop = createRenderLoopController({
            controls: {
                update: () => {
                    throw new Error('controls failed');
                },
            },
            renderer: {
                info: { render: {}, memory: {} },
                render: () => {
                    controlsErrorRenders += 1;
                },
            },
            requestAnimationFrame: (callback) => controlsErrorHarness.raf(callback),
            cancelAnimationFrame: (id) => controlsErrorHarness.cancel(id),
            onError: (err, meta) => controlsErrors.push(`${meta?.phase || ''}:${err?.message || err}`),
        });
        controlsErrorLoop.start();
        controlsErrorHarness.flushOne(16);

        const webgpuHarness = createRafHarness();
        let webgpuReady = false;
        let webgpuRenders = 0;
        let webgpuStats = 0;
        const webgpuLoop = createRenderLoopController({
            isWebGPU: true,
            getRendererReady: () => webgpuReady,
            renderer: {
                info: { render: {}, memory: {} },
                render: () => {
                    webgpuRenders += 1;
                },
            },
            requestAnimationFrame: (callback) => webgpuHarness.raf(callback),
            cancelAnimationFrame: (id) => webgpuHarness.cancel(id),
            updateStatsOverlay: () => {
                webgpuStats += 1;
            },
        });
        webgpuLoop.start();
        webgpuHarness.flushOne(16);
        const webgpuBeforeReady = { renders: webgpuRenders, stats: webgpuStats };
        webgpuReady = true;
        webgpuLoop.requestRender();
        webgpuHarness.flushOne(32);
        const webgpuAfterReady = { renders: webgpuRenders, stats: webgpuStats };
        webgpuLoop.dispose();

        const webgpuInitErrorHarness = createRafHarness();
        const webgpuInitErrors = [];
        let webgpuInitErrorStats = 0;
        let webgpuInitErrorRenders = 0;
        const webgpuInitErrorLoop = createRenderLoopController({
            isWebGPU: true,
            getRendererReady: () => false,
            getRendererError: () => new Error('init failed'),
            renderer: {
                info: { render: {}, memory: {} },
                render: () => {
                    webgpuInitErrorRenders += 1;
                },
            },
            requestAnimationFrame: (callback) => webgpuInitErrorHarness.raf(callback),
            cancelAnimationFrame: (id) => webgpuInitErrorHarness.cancel(id),
            updateStatsOverlay: () => {
                webgpuInitErrorStats += 1;
            },
            onError: (err, meta) => webgpuInitErrors.push(`${meta?.phase || ''}:${err?.message || err}`),
        });
        webgpuInitErrorLoop.start();
        webgpuInitErrorHarness.flushOne(16);

        let animationCallback = null;
        const animationEvents = [];
        let animationRenders = 0;
        const animationRenderer = {
            xr: { isPresenting: false },
            info: { render: {}, memory: {} },
            setAnimationLoop: (callback) => {
                animationEvents.push(callback ? 'set' : 'clear');
                animationCallback = callback || null;
            },
            render: () => {
                animationRenders += 1;
            },
        };
        const animationLoop = createRenderLoopController({
            renderer: animationRenderer,
            updateStatsOverlay: () => {},
        });
        animationLoop.start();
        const firstAnimationCallback = animationCallback;
        firstAnimationCallback?.(16);
        const animationAfterFirst = animationRenders;
        animationLoop.stop();
        firstAnimationCallback?.(24);
        const animationAfterStaleStopCallback = animationRenders;
        animationLoop.start();
        animationCallback?.(32);
        const animationAfterRestart = animationRenders;
        firstAnimationCallback?.(40);
        const animationAfterStaleRestartCallback = animationRenders;
        animationLoop.dispose();

        const asyncAnimationEvents = [];
        const asyncAnimationErrors = [];
        const asyncAnimationRenderer = {
            xr: { isPresenting: false },
            info: { render: {}, memory: {} },
            setAnimationLoop: (callback) => {
                asyncAnimationEvents.push(callback ? 'set' : 'clear');
                return Promise.reject(new Error('animation init failed'));
            },
            render: () => {},
        };
        const asyncAnimationLoop = createRenderLoopController({
            renderer: asyncAnimationRenderer,
            onError: (err, meta) => asyncAnimationErrors.push(`${meta?.phase || ''}:${err?.message || err}`),
        });
        asyncAnimationLoop.start();
        await Promise.resolve();
        await Promise.resolve();

        return {
            rafPendingAfterStart,
            rafAfterFirst,
            rafCanceledOnDispose,
            rafPendingAfterDispose,
            rafRendersAfterLateFlush,
            renderErrors,
            renderErrorPending: renderErrorHarness.pendingCount,
            renderErrorCanceled: renderErrorHarness.canceled.length,
            controlsErrors,
            controlsErrorRenders,
            controlsErrorPending: controlsErrorHarness.pendingCount,
            controlsErrorCanceled: controlsErrorHarness.canceled.length,
            webgpuBeforeReady,
            webgpuAfterReady,
            webgpuInitErrors,
            webgpuInitErrorPending: webgpuInitErrorHarness.pendingCount,
            webgpuInitErrorCanceled: webgpuInitErrorHarness.canceled.length,
            webgpuInitErrorStats,
            webgpuInitErrorRenders,
            animationEvents,
            animationAfterFirst,
            animationAfterStaleStopCallback,
            animationAfterRestart,
            animationAfterStaleRestartCallback,
            asyncAnimationEvents,
            asyncAnimationErrors,
        };
    });

    assert.equal(result.rafPendingAfterStart, 1, 'Render loop smoke: RAF frame was not scheduled on start');
    assert.equal(result.rafAfterFirst.controls, 1, 'Render loop smoke: controls were not updated on frame');
    assert.equal(result.rafAfterFirst.frames, 1, 'Render loop smoke: onFrame did not run');
    assert.equal(result.rafAfterFirst.renders, 1, 'Render loop smoke: requested frame did not render');
    assert.equal(result.rafAfterFirst.stats, 1, 'Render loop smoke: stats did not update after render');
    assert.equal(result.rafAfterFirst.resets, 1, 'Render loop smoke: renderer.info.reset was not called');
    assert.equal(result.rafAfterFirst.pending, 1, 'Render loop smoke: next RAF frame was not scheduled');
    assert.equal(result.rafAfterFirst.lastStats.programs, 2, 'Render loop smoke: program count was not captured');
    assert.equal(result.rafCanceledOnDispose, 1, 'Render loop smoke: pending RAF was not canceled on dispose');
    assert.equal(result.rafPendingAfterDispose, 0, 'Render loop smoke: RAF callback stayed pending after dispose');
    assert.equal(result.rafRendersAfterLateFlush, 1, 'Render loop smoke: disposed RAF callback rendered late');
    assert.deepEqual(result.renderErrors, ['render:render failed'], 'Render loop smoke: render error was not reported');
    assert.equal(result.renderErrorPending, 0, 'Render loop smoke: render error left pending RAF');
    assert.equal(result.renderErrorCanceled, 1, 'Render loop smoke: render error did not cancel RAF');
    assert.deepEqual(result.controlsErrors, ['controls:controls failed'], 'Render loop smoke: controls error was not reported');
    assert.equal(result.controlsErrorRenders, 0, 'Render loop smoke: controls error still rendered');
    assert.equal(result.controlsErrorPending, 0, 'Render loop smoke: controls error left pending RAF');
    assert.equal(result.controlsErrorCanceled, 1, 'Render loop smoke: controls error did not cancel RAF');
    assert.deepEqual(result.webgpuBeforeReady, { renders: 0, stats: 1 }, 'Render loop smoke: WebGPU rendered before ready');
    assert.deepEqual(result.webgpuAfterReady, { renders: 1, stats: 2 }, 'Render loop smoke: WebGPU did not render after ready');
    assert.deepEqual(result.webgpuInitErrors, ['renderer-init:init failed'], 'Render loop smoke: WebGPU init error was not reported');
    assert.equal(result.webgpuInitErrorPending, 0, 'Render loop smoke: WebGPU init error left pending RAF');
    assert.equal(result.webgpuInitErrorCanceled, 1, 'Render loop smoke: WebGPU init error did not cancel RAF');
    assert.equal(result.webgpuInitErrorStats, 0, 'Render loop smoke: WebGPU init error still updated stats');
    assert.equal(result.webgpuInitErrorRenders, 0, 'Render loop smoke: WebGPU init error still rendered');
    assert.deepEqual(result.animationEvents, ['set', 'clear', 'set', 'clear'], 'Render loop smoke: setAnimationLoop lifecycle is wrong');
    assert.equal(result.animationAfterFirst, 1, 'Render loop smoke: setAnimationLoop first frame did not render');
    assert.equal(result.animationAfterStaleStopCallback, 1, 'Render loop smoke: stale animation callback rendered after stop');
    assert.equal(result.animationAfterRestart, 2, 'Render loop smoke: setAnimationLoop restart did not request a fresh render');
    assert.equal(result.animationAfterStaleRestartCallback, 2, 'Render loop smoke: stale animation callback rendered after restart');
    assert.deepEqual(result.asyncAnimationEvents, ['set', 'clear'], 'Render loop smoke: async setAnimationLoop failure was not cleared');
    assert.deepEqual(
        result.asyncAnimationErrors,
        ['animation-loop:animation init failed'],
        'Render loop smoke: async setAnimationLoop failure was not reported',
    );
    diagnostics.assertNoErrors('Render loop lifecycle smoke');
    await page.close();
}

async function runWASDFlightLifecycleSmoke(browser, baseUrl) {
    const page = await browser.newPage();
    const diagnostics = attachPageDiagnostics(page);
    await page.goto(`${baseUrl}/__smoke_blank`, { waitUntil: 'domcontentloaded', timeout: 15000 });

    const result = await page.evaluate(async () => {
        const THREE = await import('three');
        const { createWASDFlightController } = await import('/scripts/modules/render/wasd-flight.js');

        const win = new EventTarget();
        const listenerCounts = { keydown: 0, keyup: 0, blur: 0 };
        const nativeAddEventListener = win.addEventListener.bind(win);
        const nativeRemoveEventListener = win.removeEventListener.bind(win);
        win.addEventListener = (type, listener, options) => {
            if (Object.prototype.hasOwnProperty.call(listenerCounts, type)) {
                listenerCounts[type] += 1;
            }
            return nativeAddEventListener(type, listener, options);
        };
        win.removeEventListener = (type, listener, options) => {
            if (Object.prototype.hasOwnProperty.call(listenerCounts, type)) {
                listenerCounts[type] = Math.max(0, listenerCounts[type] - 1);
            }
            return nativeRemoveEventListener(type, listener, options);
        };

        const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
        camera.position.set(0, 0, 0);
        camera.lookAt(0, 0, -1);
        const controls = {
            target: new THREE.Vector3(0, 0, -10),
        };
        const doc = { activeElement: document.body };
        let renderRequests = 0;
        const controller = createWASDFlightController({
            THREE,
            camera,
            controls,
            window: win,
            document: doc,
            requestRender: () => {
                renderRequests += 1;
            },
        });

        const listenersAfterCreate = { ...listenerCounts };
        const keyDown = new KeyboardEvent('keydown', { code: 'KeyW', cancelable: true });
        win.dispatchEvent(keyDown);
        const firstUpdate = controller.update();
        await new Promise((resolve) => setTimeout(resolve, 20));
        const moved = controller.update();
        const positionAfterMove = camera.position.clone();
        const targetAfterMove = controls.target.clone();
        const renderRequestsAfterMove = renderRequests;

        win.dispatchEvent(new Event('blur'));
        await new Promise((resolve) => setTimeout(resolve, 20));
        const movedAfterBlur = controller.update();

        controller.dispose();
        controller.dispose();
        const listenersAfterDispose = { ...listenerCounts };
        const enabledAfterDispose = controller.isEnabled();
        const positionBeforeLateCalls = camera.position.clone();
        const targetBeforeLateCalls = controls.target.clone();
        controller.setEnabled(true);
        win.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', cancelable: true }));
        await new Promise((resolve) => setTimeout(resolve, 20));
        const lateMoved = controller.update();

        return {
            listenersAfterCreate,
            keyDownPrevented: keyDown.defaultPrevented,
            firstUpdate,
            moved,
            positionMoved: positionAfterMove.distanceTo(new THREE.Vector3(0, 0, 0)) > 0,
            targetMoved: targetAfterMove.distanceTo(new THREE.Vector3(0, 0, -10)) > 0,
            renderRequestsAfterMove,
            movedAfterBlur,
            listenersAfterDispose,
            enabledAfterDispose,
            enabledAfterLateSet: controller.isEnabled(),
            lateMoved,
            positionStableAfterDispose: camera.position.distanceTo(positionBeforeLateCalls) < 1e-9,
            targetStableAfterDispose: controls.target.distanceTo(targetBeforeLateCalls) < 1e-9,
        };
    });

    assert.deepEqual(result.listenersAfterCreate, { keydown: 1, keyup: 1, blur: 1 }, 'WASD smoke: listeners were not registered');
    assert.equal(result.keyDownPrevented, true, 'WASD smoke: handled movement key did not prevent default');
    assert.equal(result.firstUpdate, false, 'WASD smoke: first zero-delta update moved camera');
    assert.equal(result.moved, true, 'WASD smoke: held movement key did not move camera');
    assert.equal(result.positionMoved, true, 'WASD smoke: camera position did not change');
    assert.equal(result.targetMoved, true, 'WASD smoke: controls target did not move with camera');
    assert.equal(result.renderRequestsAfterMove, 1, 'WASD smoke: movement did not request render once');
    assert.equal(result.movedAfterBlur, false, 'WASD smoke: blur did not clear held keys');
    assert.deepEqual(result.listenersAfterDispose, { keydown: 0, keyup: 0, blur: 0 }, 'WASD smoke: listeners leaked after dispose');
    assert.equal(result.enabledAfterDispose, false, 'WASD smoke: disposed controller stayed enabled');
    assert.equal(result.enabledAfterLateSet, false, 'WASD smoke: disposed controller was re-enabled by late setEnabled');
    assert.equal(result.lateMoved, false, 'WASD smoke: disposed controller moved camera');
    assert.equal(result.positionStableAfterDispose, true, 'WASD smoke: disposed controller changed camera position');
    assert.equal(result.targetStableAfterDispose, true, 'WASD smoke: disposed controller changed controls target');
    diagnostics.assertNoErrors('WASD flight lifecycle smoke');
    await page.close();
}

async function runShadingControllersLifecycleSmoke(browser, baseUrl) {
    const page = await browser.newPage();
    const diagnostics = attachPageDiagnostics(page);
    await page.goto(`${baseUrl}/__smoke_blank`, { waitUntil: 'domcontentloaded', timeout: 15000 });

    const result = await page.evaluate(async () => {
        const THREE = await import('three');
        const { createBackfaceOverlayController } = await import('/scripts/modules/render/backface-overlay.js');
        const { createDebugTextureProvider } = await import('/scripts/modules/render/debug-textures.js');
        const { createShadingController } = await import('/scripts/modules/render/shading-controller.js');
        const {
            applyBaseColorPolicyToObjectTree,
            applyMaterialBaseColorPolicy,
            getMaterialSourceBaseColor,
            TEXTURED_BASE_COLOR_MULTIPLIER,
        } = await import('/scripts/modules/material/base-color-policy.js');
        const { createToStandard } = await import('/scripts/modules/material/to-standard.js');
        const {
            clearBeautyWire,
            clearWireframeOverlay,
            ensureBeautyWire,
            ensureWireframeOverlay,
        } = await import('/scripts/modules/render/wire-overlays.js');

        const backfaceWorld = new THREE.Group();
        const backfaceMaterial = new THREE.MeshStandardMaterial({ name: 'backface-original' });
        const backfaceMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), backfaceMaterial);
        backfaceWorld.add(backfaceMesh);
        const backface = createBackfaceOverlayController({ THREE, world: backfaceWorld });
        backface.setBackfaceMode(true);
        const backfaceChildCreated = !!backfaceMesh.userData._bfChild;
        const backfaceMaterialSwapped = backfaceMesh.material !== backfaceMaterial;
        backface.dispose();
        backface.dispose();
        const backfaceRestoredAfterDispose = backfaceMesh.material === backfaceMaterial;
        const backfaceChildRemovedAfterDispose = backfaceMesh.children.length === 0;
        backface.setBackfaceMode(true);
        backface.ensureBackfaceOverlay(backfaceMesh);
        const backfaceLateChildCount = backfaceMesh.children.length;
        const backfaceLateMaterialStable = backfaceMesh.material === backfaceMaterial;

        const shadingWorld = new THREE.Group();
        const shadingScene = new THREE.Scene();
        const shadingMaterial = new THREE.MeshStandardMaterial({ name: 'shading-original' });
        const shadingMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), shadingMaterial);
        shadingWorld.add(shadingMesh);
        const shadingCalls = [];
        const shadingSelect = document.createElement('select');
        shadingSelect.append(new Option('Normal', 'normal'));
        const shading = createShadingController({
            THREE,
            world: shadingWorld,
            scene: shadingScene,
            requestRender: () => shadingCalls.push('render'),
            schedulePanelRefresh: () => shadingCalls.push('panel'),
            setBackfaceMode: (on) => shadingCalls.push(`backface:${!!on}`),
        });
        shading.bindUI({ shadingSel: shadingSelect });
        shading.dispose();
        shading.dispose();
        shadingSelect.value = 'normal';
        shadingSelect.dispatchEvent(new Event('change', { bubbles: true }));
        const lateApplyResult = shading.applyShading('normal');
        shading.bindUI({ shadingSel: shadingSelect });
        shadingSelect.dispatchEvent(new Event('change', { bubbles: true }));

        const beautyMesh = new THREE.Mesh(
            new THREE.BoxGeometry(1, 1, 1),
            new THREE.MeshStandardMaterial({ name: 'beauty-original' }),
        );
        ensureBeautyWire(beautyMesh, 25);
        const firstBeautyLine = beautyMesh.userData._beautyWire;
        const firstBeautyGeometry = firstBeautyLine?.geometry || null;
        let firstBeautyGeometryDisposed = 0;
        const nativeFirstBeautyDispose = firstBeautyGeometry?.dispose?.bind(firstBeautyGeometry);
        if (firstBeautyGeometry && nativeFirstBeautyDispose) {
            firstBeautyGeometry.dispose = (...args) => {
                firstBeautyGeometryDisposed += 1;
                return nativeFirstBeautyDispose(...args);
            };
        }
        beautyMesh.geometry = new THREE.BoxGeometry(2, 1, 1);
        ensureBeautyWire(beautyMesh, 25);
        const beautyLineReused = beautyMesh.userData._beautyWire === firstBeautyLine;
        const beautyGeometryRebuilt = !!firstBeautyLine?.geometry && firstBeautyLine.geometry !== firstBeautyGeometry;

        const patchDisposeCounter = (material) => {
            let count = 0;
            const nativeDispose = material?.dispose?.bind(material);
            if (material && nativeDispose) {
                material.dispose = (...args) => {
                    count += 1;
                    return nativeDispose(...args);
                };
            }
            return () => count;
        };

        const materialColorTextures = createDebugTextureProvider({ THREE });
        const generatedMaterialColorMatcap = materialColorTextures.getMaterialColorMatcap();
        const generatedMaterialColorMatcapReused = materialColorTextures.getMaterialColorMatcap()
            === generatedMaterialColorMatcap;
        const generatedMaterialColorPixels = generatedMaterialColorMatcap?.image?.data || [];
        let generatedMaterialColorMin = 255;
        let generatedMaterialColorMax = 0;
        for (let index = 0; index < generatedMaterialColorPixels.length; index += 4) {
            generatedMaterialColorMin = Math.min(generatedMaterialColorMin, generatedMaterialColorPixels[index]);
            generatedMaterialColorMax = Math.max(generatedMaterialColorMax, generatedMaterialColorPixels[index]);
        }
        const generatedMaterialColorMatcapValid = generatedMaterialColorMatcap?.isDataTexture === true
            && generatedMaterialColorMin < generatedMaterialColorMax;
        const getGeneratedMaterialColorDisposeCount = patchDisposeCounter(generatedMaterialColorMatcap);
        materialColorTextures.dispose();
        materialColorTextures.dispose();
        const generatedMaterialColorMatcapDisposed = getGeneratedMaterialColorDisposeCount();
        const generatedMaterialColorMatcapUnavailableAfterDispose = materialColorTextures.getMaterialColorMatcap() === null;

        const beautyTransitionWorld = new THREE.Group();
        const beautyTransitionMesh = new THREE.Mesh(
            new THREE.BoxGeometry(1, 1, 1),
            new THREE.MeshStandardMaterial({ name: 'beauty-transition-original' }),
        );
        beautyTransitionWorld.add(beautyTransitionMesh);
        const beautyTransitionShading = createShadingController({
            THREE,
            world: beautyTransitionWorld,
            scene: new THREE.Scene(),
            clearBeautyWire,
            ensureBeautyWire,
            setBackfaceMode: () => {},
        });
        beautyTransitionShading.applyShading('normal');
        const beautyTransitionVariant = beautyTransitionMesh.material;
        const getBeautyTransitionDisposeCount = patchDisposeCounter(beautyTransitionVariant);
        beautyTransitionShading.applyShading('beautywire');

        const backfaceTransitionWorld = new THREE.Group();
        const backfaceTransitionMesh = new THREE.Mesh(
            new THREE.BoxGeometry(1, 1, 1),
            new THREE.MeshStandardMaterial({ name: 'backface-transition-original' }),
        );
        backfaceTransitionWorld.add(backfaceTransitionMesh);
        const backfaceTransitionShading = createShadingController({
            THREE,
            world: backfaceTransitionWorld,
            scene: new THREE.Scene(),
            clearBeautyWire,
            setBackfaceMode: () => {},
        });
        backfaceTransitionShading.applyShading('normal');
        const backfaceTransitionVariant = backfaceTransitionMesh.material;
        const getBackfaceTransitionDisposeCount = patchDisposeCounter(backfaceTransitionVariant);
        backfaceTransitionShading.applyShading('backface');

        const wireTransitionWorld = new THREE.Group();
        const wireTransitionMesh = new THREE.Mesh(
            new THREE.BoxGeometry(1, 1, 1),
            new THREE.MeshStandardMaterial({ name: 'wire-transition-original' }),
        );
        wireTransitionWorld.add(wireTransitionMesh);
        const wireTransitionShading = createShadingController({
            THREE,
            world: wireTransitionWorld,
            scene: new THREE.Scene(),
            useWebGPU: true,
            clearWireframeOverlay,
            ensureWireframeOverlay,
            setBackfaceMode: () => {},
        });
        wireTransitionShading.applyShading('normal');
        const wireTransitionVariant = wireTransitionMesh.material;
        const getWireTransitionDisposeCount = patchDisposeCounter(wireTransitionVariant);
        wireTransitionShading.applyShading('wire');

        const textureBurstWorld = new THREE.Group();
        const textureBurstChecker = new THREE.Texture();
        textureBurstChecker.image = { width: 2, height: 2 };
        const textureBurstMeshes = [
            new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial()),
            new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial()),
        ];
        textureBurstMeshes.forEach((mesh) => textureBurstWorld.add(mesh));
        const textureBurstCalls = [];
        const textureBurstRafCallbacks = [];
        const textureBurst = createShadingController({
            THREE,
            world: textureBurstWorld,
            scene: new THREE.Scene(),
            requestRender: () => textureBurstCalls.push('render'),
            setBackfaceMode: () => {},
            getChecker: () => textureBurstChecker,
            requestAnimationFrame: (callback) => {
                textureBurstRafCallbacks.push(callback);
                return textureBurstRafCallbacks.length;
            },
            cancelAnimationFrame: () => {},
        });
        textureBurst.applyShading('uv');
        let textureBurstTicks = 0;
        while (textureBurstRafCallbacks.length && textureBurstTicks < 20) {
            const callback = textureBurstRafCallbacks.shift();
            callback();
            textureBurstTicks += 1;
        }
        const textureBurstMaterials = textureBurstMeshes.map((mesh) => mesh.material);
        const textureBurstAllMapped = textureBurstMaterials.every((material) => material.map === textureBurstChecker);
        const textureBurstAllMaterialsDirty = textureBurstMaterials.every((material) => material.version > 0);
        const textureBurstTextureDirty = textureBurstChecker.version > 0;
        textureBurst.dispose();

        const texturedBaseColor = new THREE.Color().setRGB(
            TEXTURED_BASE_COLOR_MULTIPLIER,
            TEXTURED_BASE_COLOR_MULTIPLIER,
            TEXTURED_BASE_COLOR_MULTIPLIER,
        );
        const materialColorWorld = new THREE.Group();
        const materialColorMap = new THREE.Texture();
        const materialColorAlphaMap = new THREE.Texture();
        const materialColorMatcap = new THREE.Texture();
        const materialColorOriginal = new THREE.Color(0.21, 0.07, 0.59);
        const materialColorSource = new THREE.MeshStandardMaterial({
            name: 'material-color-original',
            color: materialColorOriginal.clone(),
            map: materialColorMap,
            alphaMap: materialColorAlphaMap,
            transparent: true,
            opacity: 0.42,
            side: THREE.DoubleSide,
        });
        const materialColorPolicyChanged = applyMaterialBaseColorPolicy(materialColorSource);
        const materialColorPbrNeutralized = materialColorSource.color.equals(texturedBaseColor);
        const materialColorSourceStored = getMaterialSourceBaseColor(materialColorSource)?.equals(materialColorOriginal) === true;
        const materialColorMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), materialColorSource);
        materialColorWorld.add(materialColorMesh);
        const materialColorShading = createShadingController({
            THREE,
            world: materialColorWorld,
            scene: new THREE.Scene(),
            setBackfaceMode: () => {},
            getMaterialColorMatcap: () => materialColorMatcap,
        });
        materialColorShading.applyShading('materialColorMask');
        const materialColorMaskVariant = materialColorMesh.material;
        const getMaterialColorMaskDisposeCount = patchDisposeCounter(materialColorMaskVariant);
        const materialColorMaskIsBasic = materialColorMaskVariant.isMeshBasicMaterial === true;
        const materialColorMaskPreserved = materialColorMaskVariant.color.equals(materialColorOriginal);
        const materialColorMaskHasNoTextures = materialColorMaskVariant.map === null
            && materialColorMaskVariant.alphaMap === null;
        materialColorShading.applyShading('materialColor');
        const materialColorMaskVariantDisposed = getMaterialColorMaskDisposeCount();
        const materialColorVariant = materialColorMesh.material;
        const getMaterialColorDisposeCount = patchDisposeCounter(materialColorVariant);
        const materialColorIsMatcap = materialColorVariant.isMeshMatcapMaterial === true;
        const materialColorPreserved = materialColorVariant.color.equals(materialColorOriginal);
        const materialColorUsesNeutralShading = materialColorVariant.matcap === materialColorMatcap
            && materialColorVariant.map === null;
        const materialColorTransparencyPreserved = materialColorVariant.transparent === true
            && materialColorVariant.opacity === materialColorSource.opacity;
        const materialColorSidePreserved = materialColorVariant.side === materialColorSource.side;
        const materialColorIgnoresToneMapping = materialColorVariant.toneMapped === false;
        materialColorShading.applyShading('pbr');
        const materialColorOriginalRestored = materialColorMesh.material === materialColorSource;
        const materialColorVariantDisposed = getMaterialColorDisposeCount();
        materialColorShading.dispose();

        materialColorSource.map = null;
        const materialColorPolicyRestored = applyMaterialBaseColorPolicy(materialColorSource)
            && materialColorSource.color.equals(materialColorOriginal);

        const untexturedColor = new THREE.Color(0.14, 0.38, 0.72);
        const untexturedMaterial = new THREE.MeshStandardMaterial({ color: untexturedColor.clone() });
        const untexturedColorPreserved = applyMaterialBaseColorPolicy(untexturedMaterial) === false
            && untexturedMaterial.color.equals(untexturedColor);

        const glassColor = new THREE.Color(0.31, 0.67, 0.82);
        const glassMaterial = new THREE.MeshPhysicalMaterial({
            name: 'M_Glass_01',
            color: glassColor.clone(),
            map: new THREE.Texture(),
        });
        const glassTintPreserved = applyMaterialBaseColorPolicy(glassMaterial, { preserveTint: true }) === false
            && glassMaterial.color.equals(glassColor);

        const hiddenSourceColor = new THREE.Color(0.73, 0.26, 0.11);
        const hiddenSourceMaterial = new THREE.MeshStandardMaterial({
            color: hiddenSourceColor.clone(),
            map: new THREE.Texture(),
        });
        const hiddenDisplayMaterial = new THREE.MeshBasicMaterial({ color: 0x123456 });
        hiddenDisplayMaterial.userData.viewerGeneratedMaterial = 'shading-variant';
        const hiddenSourceMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), hiddenDisplayMaterial);
        hiddenSourceMesh.userData._origMaterial = hiddenSourceMaterial;
        const hiddenSourceWorld = new THREE.Group();
        hiddenSourceWorld.add(hiddenSourceMesh);
        const hiddenDisplayColor = hiddenDisplayMaterial.color.clone();
        const hiddenSourcePolicyChanged = applyBaseColorPolicyToObjectTree(hiddenSourceWorld) === 1;
        const hiddenSourceNeutralized = hiddenSourceMaterial.color.equals(texturedBaseColor);
        const hiddenDisplayUntouched = hiddenDisplayMaterial.color.equals(hiddenDisplayColor);

        const legacySourceColor = new THREE.Color(0.44, 0.18, 0.63);
        const legacyMaterial = new THREE.MeshBasicMaterial({
            color: legacySourceColor.clone(),
            map: new THREE.Texture(),
        });
        applyMaterialBaseColorPolicy(legacyMaterial);
        const convertedMaterial = createToStandard()(legacyMaterial);
        const convertedPolicyStatePreserved = convertedMaterial.color.equals(texturedBaseColor)
            && getMaterialSourceBaseColor(convertedMaterial)?.equals(legacySourceColor) === true;

        return {
            backfaceChildCreated,
            backfaceMaterialSwapped,
            backfaceRestoredAfterDispose,
            backfaceChildRemovedAfterDispose,
            backfaceLateChildCount,
            backfaceLateMaterialStable,
            shadingLateApplyResult: lateApplyResult,
            shadingMaterialStable: shadingMesh.material === shadingMaterial,
            shadingCalls,
            beautyLineReused,
            beautyGeometryRebuilt,
            firstBeautyGeometryDisposed,
            beautyTransitionVariantDisposed: getBeautyTransitionDisposeCount(),
            backfaceTransitionVariantDisposed: getBackfaceTransitionDisposeCount(),
            wireTransitionVariantDisposed: getWireTransitionDisposeCount(),
            generatedMaterialColorMatcapReused,
            generatedMaterialColorMatcapValid,
            generatedMaterialColorMatcapDisposed,
            generatedMaterialColorMatcapUnavailableAfterDispose,
            textureBurstRenderCount: textureBurstCalls.length,
            textureBurstAllMapped,
            textureBurstAllMaterialsDirty,
            textureBurstTextureDirty,
            materialColorMaskIsBasic,
            materialColorPolicyChanged,
            materialColorPbrNeutralized,
            materialColorSourceStored,
            materialColorMaskPreserved,
            materialColorMaskHasNoTextures,
            materialColorMaskVariantDisposed,
            materialColorIsMatcap,
            materialColorPreserved,
            materialColorUsesNeutralShading,
            materialColorTransparencyPreserved,
            materialColorSidePreserved,
            materialColorIgnoresToneMapping,
            materialColorOriginalRestored,
            materialColorVariantDisposed,
            materialColorPolicyRestored,
            untexturedColorPreserved,
            glassTintPreserved,
            hiddenSourcePolicyChanged,
            hiddenSourceNeutralized,
            hiddenDisplayUntouched,
            convertedPolicyStatePreserved,
        };
    });

    assert.equal(result.backfaceChildCreated, true, 'Shading lifecycle smoke: backface child was not created');
    assert.equal(result.backfaceMaterialSwapped, true, 'Shading lifecycle smoke: backface material was not applied');
    assert.equal(result.backfaceRestoredAfterDispose, true, 'Shading lifecycle smoke: backface dispose did not restore source material');
    assert.equal(result.backfaceChildRemovedAfterDispose, true, 'Shading lifecycle smoke: backface dispose left child overlay');
    assert.equal(result.backfaceLateChildCount, 0, 'Shading lifecycle smoke: disposed backface controller recreated overlay');
    assert.equal(result.backfaceLateMaterialStable, true, 'Shading lifecycle smoke: disposed backface controller changed material');
    assert.equal(result.shadingLateApplyResult, false, 'Shading lifecycle smoke: disposed shading controller accepted applyShading');
    assert.equal(result.shadingMaterialStable, true, 'Shading lifecycle smoke: disposed shading controller changed material');
    assert.deepEqual(result.shadingCalls, [], 'Shading lifecycle smoke: disposed shading controller fired callbacks');
    assert.equal(result.beautyLineReused, true, 'Shading lifecycle smoke: BeautyWire recreated line object instead of updating geometry');
    assert.equal(result.beautyGeometryRebuilt, true, 'Shading lifecycle smoke: BeautyWire did not rebuild stale edge geometry');
    assert.equal(result.firstBeautyGeometryDisposed, 1, 'Shading lifecycle smoke: BeautyWire old edge geometry was not disposed');
    assert.equal(result.beautyTransitionVariantDisposed, 1, 'Shading lifecycle smoke: BeautyWire transition leaked previous shading material');
    assert.equal(result.backfaceTransitionVariantDisposed, 1, 'Shading lifecycle smoke: backface transition leaked previous shading material');
    assert.equal(result.wireTransitionVariantDisposed, 1, 'Shading lifecycle smoke: WebGPU wire transition leaked previous shading material');
    assert.equal(result.generatedMaterialColorMatcapReused, true, 'Shading lifecycle smoke: Material Color recreated its shared matcap');
    assert.equal(result.generatedMaterialColorMatcapValid, true, 'Shading lifecycle smoke: Material Color matcap has no tonal range');
    assert.equal(result.generatedMaterialColorMatcapDisposed, 1, 'Shading lifecycle smoke: Material Color matcap was not disposed exactly once');
    assert.equal(result.generatedMaterialColorMatcapUnavailableAfterDispose, true, 'Shading lifecycle smoke: disposed texture provider recreated Material Color matcap');
    assert.equal(result.textureBurstRenderCount >= 12, true, 'Shading lifecycle smoke: textured shading mode did not request a render burst');
    assert.equal(result.textureBurstAllMapped, true, 'Shading lifecycle smoke: UV shading did not apply shared checker texture to all meshes');
    assert.equal(result.textureBurstAllMaterialsDirty, true, 'Shading lifecycle smoke: textured shading materials were not marked dirty');
    assert.equal(result.textureBurstTextureDirty, true, 'Shading lifecycle smoke: textured shading texture was not marked for upload');
    assert.equal(result.materialColorMaskIsBasic, true, 'Shading lifecycle smoke: Material Color Mask did not use an unlit material');
    assert.equal(result.materialColorPolicyChanged, true, 'Base color policy smoke: textured material was not updated');
    assert.equal(result.materialColorPbrNeutralized, true, 'Base color policy smoke: textured PBR multiplier was not neutralized');
    assert.equal(result.materialColorSourceStored, true, 'Base color policy smoke: original material color was not retained');
    assert.equal(result.materialColorMaskPreserved, true, 'Shading lifecycle smoke: Material Color Mask changed the source material color');
    assert.equal(result.materialColorMaskHasNoTextures, true, 'Shading lifecycle smoke: Material Color Mask retained texture maps');
    assert.equal(result.materialColorMaskVariantDisposed, 1, 'Shading lifecycle smoke: Material Color Mask leaked its generated material');
    assert.equal(result.materialColorIsMatcap, true, 'Shading lifecycle smoke: Material Color did not use view-relative shading');
    assert.equal(result.materialColorPreserved, true, 'Shading lifecycle smoke: Material Color changed the source material color');
    assert.equal(result.materialColorUsesNeutralShading, true, 'Shading lifecycle smoke: Material Color did not use its neutral matcap');
    assert.equal(result.materialColorTransparencyPreserved, true, 'Shading lifecycle smoke: Material Color changed transparency');
    assert.equal(result.materialColorSidePreserved, true, 'Shading lifecycle smoke: Material Color changed material side');
    assert.equal(result.materialColorIgnoresToneMapping, true, 'Shading lifecycle smoke: Material Color remained tone mapped');
    assert.equal(result.materialColorOriginalRestored, true, 'Shading lifecycle smoke: PBR did not restore the source material');
    assert.equal(result.materialColorVariantDisposed, 1, 'Shading lifecycle smoke: Material Color leaked its generated material');
    assert.equal(result.materialColorPolicyRestored, true, 'Base color policy smoke: removing base map did not restore the native color');
    assert.equal(result.untexturedColorPreserved, true, 'Base color policy smoke: untextured material color changed');
    assert.equal(result.glassTintPreserved, true, 'Base color policy smoke: glass tint was neutralized');
    assert.equal(result.hiddenSourcePolicyChanged, true, 'Base color policy smoke: original material under display mode was not updated');
    assert.equal(result.hiddenSourceNeutralized, true, 'Base color policy smoke: hidden PBR material retained a tint');
    assert.equal(result.hiddenDisplayUntouched, true, 'Base color policy smoke: generated display material was modified');
    assert.equal(result.convertedPolicyStatePreserved, true, 'Base color policy smoke: material conversion lost the original color');
    diagnostics.assertNoErrors('Shading controllers lifecycle smoke');
    await page.close();
}

async function runAnnotationsDisposeLifecycleSmoke(browser, baseUrl) {
    const page = await browser.newPage();
    const diagnostics = attachPageDiagnostics(page);
    await page.goto(`${baseUrl}/__smoke_blank`, { waitUntil: 'domcontentloaded', timeout: 15000 });

    const result = await page.evaluate(async () => {
        const THREE = await import('three');
        const { createAnnotations3DController } = await import('/scripts/modules/annotations/annotations-3d.js');

        const nativeRaf = globalThis.requestAnimationFrame;
        const nativeGeometryDispose = THREE.BufferGeometry.prototype.dispose;
        const nativeMaterialDispose = THREE.Material.prototype.dispose;
        const rafCallbacks = [];
        let geometryDisposed = 0;
        let materialDisposed = 0;
        let queueWaits = 0;
        let renderCount = 0;

        globalThis.requestAnimationFrame = (callback) => {
            rafCallbacks.push(callback);
            return rafCallbacks.length;
        };
        THREE.BufferGeometry.prototype.dispose = function patchedGeometryDispose(...args) {
            geometryDisposed += 1;
            return nativeGeometryDispose.apply(this, args);
        };
        THREE.Material.prototype.dispose = function patchedMaterialDispose(...args) {
            materialDisposed += 1;
            return nativeMaterialDispose.apply(this, args);
        };

        try {
            const world = new THREE.Group();
            const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
            camera.position.set(0, 0, 5);
            const canvas = document.createElement('canvas');
            const toolbar = document.createElement('div');
            const layerSelect = document.createElement('select');
            const layerAdd = document.createElement('button');
            document.body.append(canvas, toolbar, layerSelect, layerAdd);
            const controls = { enabled: true };
            const renderer = {
                isWebGPURenderer: true,
                info: { render: { frame: 100 } },
                device: {
                    queue: {
                        onSubmittedWorkDone: () => {
                            queueWaits += 1;
                            return Promise.resolve();
                        },
                    },
                },
            };
            let resolveLayerPrompt = null;
            let layerPromptCalls = 0;

            const controller = createAnnotations3DController({
                THREE,
                world,
                camera,
                controls,
                renderer,
                annotateCanvasEl: canvas,
                annotateToolbarEl: toolbar,
                annoLayerSelectEl: layerSelect,
                annoLayerAddBtn: layerAdd,
                requestRender: () => {
                    renderCount += 1;
                },
                promptLayerName: () => {
                    layerPromptCalls += 1;
                    return new Promise((resolve) => {
                        resolveLayerPrompt = resolve;
                    });
                },
            });
            const layerOptionsBeforePrompt = layerSelect.options.length;
            layerAdd.click();
            await Promise.resolve();

            const record = {
                id: 'anno-1',
                kind: 'path',
                payload: {
                    coordSpace: 'world',
                    points: [[0, 0, 0], [1, 0, 0]],
                    style: { color: '#ffcc00', width: 3, dash: 'solid' },
                },
                author_id: 'peer-1',
                author_name: 'Peer',
            };
            const stroke = controller.addRemoteAnnotation(record);
            const added = !!stroke && world.children[0]?.name === 'Annotations';
            const removed = controller.removeRemoteAnnotation('anno-1');
            const deferredBeforeDispose = removed
                && geometryDisposed === 0
                && materialDisposed === 0
                && rafCallbacks.length > 0;

            controller.setEnabled(true);
            const canvasActiveBeforeDispose = canvas.classList.contains('active');
            controller.dispose();
            controller.dispose();
            resolveLayerPrompt?.('Late Layer');
            await Promise.resolve();
            await Promise.resolve();
            const renderCountAfterDispose = renderCount;
            const geometryDisposedAfterDispose = geometryDisposed;
            const materialDisposedAfterDispose = materialDisposed;

            const lateRecord = {
                ...record,
                id: 'anno-late',
                payload: {
                    ...record.payload,
                    points: [[0, 1, 0], [1, 1, 0]],
                },
            };
            const lateAdd = controller.addRemoteAnnotation(lateRecord);
            const lateRemove = controller.removeRemoteAnnotation('anno-late');
            const lateSetEnabled = controller.setEnabled(true);
            const lateSetVisible = controller.setVisible(true);
            controller.setAuthorVisibility('peer-1', false);
            controller.setPinVisibility('peer-1', false);
            controller.refreshAuthorVisibility('peer-1');
            controller.refreshPinVisibility('peer-1');
            controller.applyWorldOffsetDelta(new THREE.Vector3(1, 0, 0));

            const callbacks = rafCallbacks.slice();
            callbacks.forEach((callback, index) => callback(1000 + index));
            await Promise.resolve();
            await Promise.resolve();
            const geometryDisposedAfterLateCallbacks = geometryDisposed;
            const materialDisposedAfterLateCallbacks = materialDisposed;
            const renderUnchangedAfterLateCalls = renderCount === renderCountAfterDispose;

            const beforeDraftGeometryDisposed = geometryDisposed;
            const beforeDraftMaterialDisposed = materialDisposed;
            const beforeDraftRafCount = rafCallbacks.length;
            const draftWorld = new THREE.Group();
            const draftCamera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
            draftCamera.position.set(0, 0, 5);
            draftCamera.lookAt(0, 0, 0);
            draftCamera.updateMatrixWorld(true);
            const draftCanvas = document.createElement('canvas');
            const draftToolbar = document.createElement('div');
            const draftLayerSelect = document.createElement('select');
            draftCanvas.getBoundingClientRect = () => ({
                left: 0,
                top: 0,
                right: 100,
                bottom: 100,
                width: 100,
                height: 100,
            });
            draftCanvas.setPointerCapture = () => {};
            draftCanvas.releasePointerCapture = () => {};
            document.body.append(draftCanvas, draftToolbar, draftLayerSelect);
            const draftController = createAnnotations3DController({
                THREE,
                world: draftWorld,
                camera: draftCamera,
                controls: { enabled: true, target: new THREE.Vector3(0, 0, 0) },
                renderer: {
                    isWebGPURenderer: true,
                    info: { render: { frame: 200 } },
                    device: {
                        queue: {
                            onSubmittedWorkDone: () => {
                                queueWaits += 1;
                                return Promise.resolve();
                            },
                        },
                    },
                },
                annotateCanvasEl: draftCanvas,
                annotateToolbarEl: draftToolbar,
                annoLayerSelectEl: draftLayerSelect,
                requestRender: () => {
                    renderCount += 1;
                },
            });
            draftController.setEnabled(true);
            const makePointer = (type, props = {}) => new PointerEvent(type, {
                bubbles: true,
                pointerId: 9,
                pointerType: 'mouse',
                button: 0,
                buttons: type === 'pointerup' || type === 'pointercancel' ? 0 : 1,
                clientX: 50,
                clientY: 50,
                ...props,
            });
            draftCanvas.dispatchEvent(makePointer('pointerdown', { clientX: 50, clientY: 50 }));
            draftCanvas.dispatchEvent(makePointer('pointermove', { clientX: 90, clientY: 50 }));
            draftCanvas.dispatchEvent(makePointer('pointermove', { clientX: 90, clientY: 90 }));
            const draftDeferredBeforeDispose = (
                geometryDisposed === beforeDraftGeometryDisposed
                && materialDisposed === beforeDraftMaterialDisposed
                && rafCallbacks.length > beforeDraftRafCount
            );
            draftCanvas.dispatchEvent(makePointer('pointercancel', { clientX: 90, clientY: 90 }));
            draftController.dispose();
            draftController.dispose();
            const draftGeometryDisposedOnDispose = geometryDisposed - beforeDraftGeometryDisposed;
            const draftMaterialDisposedOnDispose = materialDisposed - beforeDraftMaterialDisposed;

            return {
                added,
                deferredBeforeDispose,
                draftDeferredBeforeDispose,
                draftGeometryDisposedOnDispose,
                draftMaterialDisposedOnDispose,
                canvasActiveBeforeDispose,
                rootRemoved: controller.getRoot().parent == null,
                canvasInactiveAfterDispose: !canvas.classList.contains('active'),
                controlsRestored: controls.enabled === true,
                geometryDisposedAfterDispose,
                materialDisposedAfterDispose,
                geometryDisposedAfterLateCallbacks,
                materialDisposedAfterLateCallbacks,
                queueWaits,
                layerPromptCalls,
                layerOptionsBeforePrompt,
                layerOptionsAfterLatePrompt: layerSelect.options.length,
                renderUnchangedAfterLateCalls,
                lateAddIsNull: lateAdd == null,
                lateRemove,
                lateSetEnabled,
                lateSetVisible,
                worldChildCount: world.children.length,
            };
        } finally {
            globalThis.requestAnimationFrame = nativeRaf;
            THREE.BufferGeometry.prototype.dispose = nativeGeometryDispose;
            THREE.Material.prototype.dispose = nativeMaterialDispose;
        }
    });

    assert.equal(result.added, true, 'Annotations dispose smoke: remote annotation was not added');
    assert.equal(result.deferredBeforeDispose, true, 'Annotations dispose smoke: WebGPU disposal was not deferred before dispose');
    assert.equal(result.draftDeferredBeforeDispose, true, 'Annotations dispose smoke: WebGPU draft disposal was not deferred');
    assert.ok(result.draftGeometryDisposedOnDispose > 0, 'Annotations dispose smoke: deferred draft geometries were not flushed on dispose');
    assert.ok(result.draftMaterialDisposedOnDispose > 0, 'Annotations dispose smoke: deferred draft materials were not flushed on dispose');
    assert.equal(result.canvasActiveBeforeDispose, true, 'Annotations dispose smoke: draw mode did not activate canvas');
    assert.equal(result.rootRemoved, true, 'Annotations dispose smoke: annotations root stayed attached after dispose');
    assert.equal(result.canvasInactiveAfterDispose, true, 'Annotations dispose smoke: canvas stayed active after dispose');
    assert.equal(result.controlsRestored, true, 'Annotations dispose smoke: controls were not restored on dispose');
    assert.ok(result.geometryDisposedAfterDispose > 0, 'Annotations dispose smoke: deferred geometries were not flushed on dispose');
    assert.ok(result.materialDisposedAfterDispose > 0, 'Annotations dispose smoke: deferred materials were not flushed on dispose');
    assert.equal(result.geometryDisposedAfterLateCallbacks, result.geometryDisposedAfterDispose, 'Annotations dispose smoke: stale RAF disposed geometry twice');
    assert.equal(result.materialDisposedAfterLateCallbacks, result.materialDisposedAfterDispose, 'Annotations dispose smoke: stale RAF disposed material twice');
    assert.equal(result.queueWaits, 0, 'Annotations dispose smoke: stale RAF reached WebGPU queue after dispose');
    assert.equal(result.layerPromptCalls, 1, 'Annotations dispose smoke: layer prompt was not opened');
    assert.equal(result.layerOptionsAfterLatePrompt, result.layerOptionsBeforePrompt, 'Annotations dispose smoke: stale layer prompt mutated toolbar after dispose');
    assert.equal(result.renderUnchangedAfterLateCalls, true, 'Annotations dispose smoke: late calls requested render after dispose');
    assert.equal(result.lateAddIsNull, true, 'Annotations dispose smoke: late remote annotation was accepted after dispose');
    assert.equal(result.lateRemove, false, 'Annotations dispose smoke: late remove succeeded after dispose');
    assert.equal(result.lateSetEnabled, false, 'Annotations dispose smoke: late setEnabled succeeded after dispose');
    assert.equal(result.lateSetVisible, false, 'Annotations dispose smoke: late setVisible succeeded after dispose');
    assert.equal(result.worldChildCount, 0, 'Annotations dispose smoke: disposed annotations left world children behind');
    diagnostics.assertNoErrors('Annotations dispose lifecycle smoke');
    await page.close();
}

async function runCameraPresetsLifecycleSmoke(browser, baseUrl) {
    const page = await browser.newPage();
    const diagnostics = attachPageDiagnostics(page);
    await page.goto(`${baseUrl}/__smoke_blank`, { waitUntil: 'domcontentloaded', timeout: 15000 });

    const result = await page.evaluate(async () => {
        const THREE = await import('three');
        const { createCameraPresetsController } = await import('/scripts/modules/ui/camera-presets.js');

        const nativeRaf = globalThis.requestAnimationFrame;
        const nativeCancelRaf = globalThis.cancelAnimationFrame;
        const rafCallbacks = new Map();
        let nextRafId = 1;

        globalThis.requestAnimationFrame = (callback) => {
            const id = nextRafId++;
            rafCallbacks.set(id, callback);
            return id;
        };
        globalThis.cancelAnimationFrame = (id) => {
            rafCallbacks.delete(id);
        };

        function makeDom() {
            const root = document.createElement('div');
            const toggle = document.createElement('button');
            const bar = document.createElement('div');
            const barList = document.createElement('div');
            const sideList = document.createElement('div');
            const count = document.createElement('span');
            const canvas = document.createElement('canvas');
            canvas.width = 100;
            canvas.height = 100;
            canvas.getBoundingClientRect = () => ({
                left: 0,
                top: 0,
                right: 100,
                bottom: 100,
                width: 100,
                height: 100,
                x: 0,
                y: 0,
                toJSON: () => {},
            });
            const toolbar = document.createElement('div');
            const pencilTool = document.createElement('button');
            pencilTool.className = 'anno-tool';
            pencilTool.dataset.tool = 'pencil';
            const textTool = document.createElement('button');
            textTool.className = 'anno-tool';
            textTool.dataset.tool = 'text';
            toolbar.append(pencilTool, textTool);
            const annoVisible = document.createElement('button');
            const annoDraw = document.createElement('button');
            const annoUndo = document.createElement('button');
            const annoClear = document.createElement('button');
            const annoColor = document.createElement('input');
            annoColor.value = '#ffcc00';
            const annoDash = document.createElement('select');
            const annoWidth = document.createElement('input');
            annoWidth.value = '3';
            root.append(
                toggle,
                bar,
                barList,
                sideList,
                count,
                canvas,
                toolbar,
                annoVisible,
                annoDraw,
                annoUndo,
                annoClear,
                annoColor,
                annoDash,
                annoWidth,
            );
            document.body.appendChild(root);
            return {
                root,
                toggle,
                bar,
                barList,
                sideList,
                count,
                canvas,
                toolbar,
                pencilTool,
                textTool,
                annoVisible,
                annoDraw,
                annoUndo,
                annoClear,
                annoColor,
                annoDash,
                annoWidth,
            };
        }

        function makeHarness(extra = {}) {
            const dom = makeDom();
            const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
            camera.position.set(0, 0, 5);
            const events = [];
            const controls = {
                enabled: true,
                enableDamping: true,
                target: new THREE.Vector3(0, 0, 0),
                update: () => events.push('controls:update'),
            };
            const controller = createCameraPresetsController({
                THREE,
                camera,
                controls,
                annotationsEnabled: false,
                annotateCanvasEl: dom.canvas,
                annotateToolbarEl: dom.toolbar,
                annoVisibleBtn: dom.annoVisible,
                annoDrawBtn: dom.annoDraw,
                annoColorEl: dom.annoColor,
                annoDashEl: dom.annoDash,
                annoWidthEl: dom.annoWidth,
                annoUndoBtn: dom.annoUndo,
                annoClearBtn: dom.annoClear,
                camsToggleBtn: dom.toggle,
                camsBarEl: dom.bar,
                camsBarListEl: dom.barList,
                camsSideListEl: dom.sideList,
                camsCountEl: dom.count,
                requestRender: () => events.push('render'),
                requestLayout: () => events.push('layout'),
                ...extra,
            });
            return { ...dom, camera, controls, controller, events };
        }

        function firePointer(target, type, init = {}) {
            const options = {
                bubbles: true,
                cancelable: true,
                clientX: init.clientX ?? 10,
                clientY: init.clientY ?? 10,
                button: init.button ?? 0,
                buttons: init.buttons ?? 1,
                pointerId: init.pointerId ?? 1,
            };
            const event = typeof PointerEvent === 'function'
                ? new PointerEvent(type, options)
                : new MouseEvent(type, options);
            if (!('pointerId' in event)) {
                Object.defineProperty(event, 'pointerId', { value: options.pointerId });
            }
            target.dispatchEvent(event);
        }

        const presets = [
            {
                id: 'cam-a',
                name: 'A',
                isDefault: true,
                position: [0, 0, 5],
                target: [0, 0, 0],
                up: [0, 1, 0],
                fov: 60,
                zoom: 1,
                near: 0.1,
                far: 1000,
            },
            {
                id: 'cam-b',
                name: 'B',
                position: [5, 0, 5],
                target: [1, 0, 0],
                up: [0, 1, 0],
                fov: 45,
                zoom: 1,
                near: 0.1,
                far: 1000,
            },
        ];

        try {
            const play = makeHarness();
            play.controller.loadState({
                presets,
                transitions: [{
                    fromId: 'cam-a',
                    toId: 'cam-b',
                    seconds: 1,
                    type: 'linear',
                    trajectory: 'linear',
                }],
                activeId: 'cam-a',
                lastCreatedId: 'cam-a',
            });

            const playButton = play.barList.querySelector('[data-action="play"]');
            playButton?.click?.();
            await Promise.resolve();
            const controlsDisabledDuringPlay = play.controls.enabled === false && play.controls.enableDamping === false;
            const pendingRafBeforeDispose = rafCallbacks.size;
            const staleCallbacks = Array.from(rafCallbacks.values());
            play.controller.dispose();
            await Promise.resolve();
            await Promise.resolve();
            const controlsRestoredAfterDispose = play.controls.enabled === true && play.controls.enableDamping === true;
            const pendingRafAfterDispose = rafCallbacks.size;
            const eventsAfterDispose = play.events.length;
            staleCallbacks.forEach((callback, index) => callback(1000 + index));
            await Promise.resolve();

            const lateApply = play.controller.applyPreset(presets[1]);
            const lateAdd = play.controller.addFromSnapshot({
                position: [9, 9, 9],
                target: [0, 0, 0],
                up: [0, 1, 0],
                fov: 35,
                zoom: 1,
                near: 0.1,
                far: 1000,
            }, 'Late');
            const lateLoad = play.controller.loadState({
                presets: [presets[1]],
                transitions: [],
                activeId: 'cam-b',
            });
            const lateUpdate = play.controller.updateLastCreatedFromCurrentView();
            const lateMutationEvents = play.events.length === eventsAfterDispose;

            let resolvePrompt = null;
            const promptHarness = makeHarness({
                promptCameraName: () => new Promise((resolve) => {
                    resolvePrompt = resolve;
                }),
            });
            const promptStartCount = promptHarness.controller.getPresets().length;
            const addPromise = promptHarness.controller.addFromCurrentView();
            await Promise.resolve();
            promptHarness.controller.dispose();
            resolvePrompt?.('Late Camera');
            const promptAddResult = await addPromise;
            await Promise.resolve();
            const promptEndCount = promptHarness.controller.getPresets().length;

            const annotationChanges = [];
            let resolveTextPrompt = null;
            const annotationPromptHarness = makeHarness({
                annotationsEnabled: true,
                onChange: (state) => annotationChanges.push(state),
                promptAnnotationText: () => new Promise((resolve) => {
                    resolveTextPrompt = resolve;
                }),
            });
            annotationPromptHarness.controller.loadState({
                presets: [presets[0]],
                transitions: [],
                activeId: 'cam-a',
                lastCreatedId: 'cam-a',
            });
            annotationChanges.length = 0;
            annotationPromptHarness.textTool.click();
            const textAnnotationsBefore = annotationPromptHarness.controller.getPresets()[0]?.annotations?.length || 0;
            firePointer(annotationPromptHarness.canvas, 'pointerdown', {
                clientX: 25,
                clientY: 25,
                pointerId: 11,
            });
            await Promise.resolve();
            annotationPromptHarness.controller.dispose();
            resolveTextPrompt?.('Late annotation');
            await Promise.resolve();
            await Promise.resolve();
            const textAnnotationsAfter = annotationPromptHarness.controller.getPresets()[0]?.annotations?.length || 0;

            const drawChanges = [];
            const drawHarness = makeHarness({
                annotationsEnabled: true,
                onChange: (state) => drawChanges.push(state),
            });
            drawHarness.controller.loadState({
                presets: [presets[0]],
                transitions: [],
                activeId: 'cam-a',
                lastCreatedId: 'cam-a',
            });
            drawHarness.pencilTool.click();
            firePointer(drawHarness.canvas, 'pointerdown', {
                clientX: 10,
                clientY: 10,
                pointerId: 12,
                buttons: 1,
            });
            firePointer(drawHarness.canvas, 'pointermove', {
                clientX: 50,
                clientY: 50,
                pointerId: 12,
                buttons: 1,
            });
            firePointer(drawHarness.canvas, 'pointerup', {
                clientX: 50,
                clientY: 50,
                pointerId: 12,
                buttons: 0,
            });
            await new Promise((resolve) => setTimeout(resolve, 250));
            const drawPreset = drawHarness.controller.getPresets()[0] || {};
            const persistedDrawState = drawChanges[drawChanges.length - 1] || null;
            const persistedDrawPreset = persistedDrawState?.presets?.[0] || {};

            const staleChangeEvents = [];
            const staleChangeHarness = makeHarness({
                onChange: (state) => staleChangeEvents.push(state),
            });
            staleChangeHarness.controller.loadState({
                presets: [presets[0]],
                transitions: [],
                activeId: 'cam-a',
                lastCreatedId: 'cam-a',
            });
            staleChangeEvents.length = 0;
            const addedBeforeReload = staleChangeHarness.controller.addFromSnapshot({
                position: [7, 7, 7],
                target: [0, 0, 0],
                up: [0, 1, 0],
                fov: 55,
                zoom: 1,
                near: 0.1,
                far: 1000,
            }, 'Local Pending');
            const countBeforeRealtimeLoad = staleChangeHarness.controller.getPresets().length;
            staleChangeHarness.controller.loadState({
                presets: [presets[1]],
                transitions: [],
                activeId: 'cam-b',
                lastCreatedId: 'cam-b',
            });
            await new Promise((resolve) => setTimeout(resolve, 250));
            const staleChangeCountAfterRealtimeLoad = staleChangeEvents.length;
            const countAfterRealtimeLoad = staleChangeHarness.controller.getPresets().length;
            staleChangeHarness.controller.dispose();

            rafCallbacks.clear();
            const reloadPlay = makeHarness();
            reloadPlay.controller.loadState({
                presets,
                transitions: [{
                    fromId: 'cam-a',
                    toId: 'cam-b',
                    seconds: 1,
                    type: 'linear',
                    trajectory: 'linear',
                }],
                activeId: 'cam-a',
                lastCreatedId: 'cam-a',
            });
            reloadPlay.barList.querySelector('[data-action="play"]')?.click?.();
            await Promise.resolve();
            const reloadPendingBeforeLoad = rafCallbacks.size;
            const staleReloadCallbacks = Array.from(rafCallbacks.values());
            reloadPlay.events.length = 0;
            reloadPlay.controller.loadState({
                presets: [{
                    id: 'cam-c',
                    name: 'C',
                    position: [9, 9, 9],
                    target: [0, 0, 0],
                    up: [0, 1, 0],
                    fov: 50,
                    zoom: 1,
                    near: 0.1,
                    far: 1000,
                }],
                transitions: [],
                activeId: 'cam-c',
                lastCreatedId: 'cam-c',
            });
            await Promise.resolve();
            await Promise.resolve();
            const reloadPendingAfterLoad = rafCallbacks.size;
            const reloadControlsRestored = reloadPlay.controls.enabled === true && reloadPlay.controls.enableDamping === true;
            const reloadActiveAfterLoad = reloadPlay.controller.getActiveId();
            const cameraBeforeStaleReload = reloadPlay.camera.position.toArray();
            const eventsAfterReloadLoad = reloadPlay.events.length;
            staleReloadCallbacks.forEach((callback, index) => callback(100000 + index));
            await Promise.resolve();
            const cameraAfterStaleReload = reloadPlay.camera.position.toArray();
            const reloadActiveAfterStale = reloadPlay.controller.getActiveId();
            const reloadStaleDidNotRender = reloadPlay.events.length === eventsAfterReloadLoad;
            reloadPlay.controller.dispose();

            return {
                controlsDisabledDuringPlay,
                pendingRafBeforeDispose,
                controlsRestoredAfterDispose,
                pendingRafAfterDispose,
                staleCallbacksDidNotRender: play.events.length === eventsAfterDispose,
                lateApply,
                lateAddIsNull: lateAdd == null,
                lateLoad,
                lateUpdate,
                lateMutationEvents,
                presetCountAfterLateCalls: play.controller.getPresets().length,
                promptStartCount,
                promptAddIsNull: promptAddResult == null,
                promptEndCount,
                textAnnotationsBefore,
                textAnnotationsAfter,
                staleTextPromptChanges: annotationChanges.length,
                localDrawAnnotationCount: drawPreset.annotations?.length || 0,
                persistedDrawAnnotationCount: persistedDrawPreset.annotations?.length || 0,
                staleChangeAdded: !!addedBeforeReload,
                countBeforeRealtimeLoad,
                countAfterRealtimeLoad,
                staleChangeCountAfterRealtimeLoad,
                reloadPendingBeforeLoad,
                reloadPendingAfterLoad,
                reloadControlsRestored,
                reloadActiveAfterLoad,
                cameraBeforeStaleReload,
                cameraAfterStaleReload,
                reloadActiveAfterStale,
                reloadStaleDidNotRender,
            };
        } finally {
            globalThis.requestAnimationFrame = nativeRaf;
            globalThis.cancelAnimationFrame = nativeCancelRaf;
        }
    });

    assert.equal(result.controlsDisabledDuringPlay, true, 'Camera presets smoke: controls were not disabled during transition playback');
    assert.ok(result.pendingRafBeforeDispose > 0, 'Camera presets smoke: transition did not schedule RAF');
    assert.equal(result.controlsRestoredAfterDispose, true, 'Camera presets smoke: controls were not restored after dispose during playback');
    assert.equal(result.pendingRafAfterDispose, 0, 'Camera presets smoke: transition RAF was not cancelled on dispose');
    assert.equal(result.staleCallbacksDidNotRender, true, 'Camera presets smoke: stale transition callback rendered after dispose');
    assert.equal(result.lateApply, false, 'Camera presets smoke: applyPreset mutated after dispose');
    assert.equal(result.lateAddIsNull, true, 'Camera presets smoke: addFromSnapshot succeeded after dispose');
    assert.equal(result.lateLoad, false, 'Camera presets smoke: loadState succeeded after dispose');
    assert.equal(result.lateUpdate, false, 'Camera presets smoke: updateLastCreatedFromCurrentView succeeded after dispose');
    assert.equal(result.lateMutationEvents, true, 'Camera presets smoke: late public calls emitted events after dispose');
    assert.equal(result.presetCountAfterLateCalls, 2, 'Camera presets smoke: late public calls changed preset state after dispose');
    assert.equal(result.promptAddIsNull, true, 'Camera presets smoke: pending add prompt resolved into a preset after dispose');
    assert.equal(result.promptEndCount, result.promptStartCount, 'Camera presets smoke: pending add prompt changed preset count after dispose');
    assert.equal(result.textAnnotationsAfter, result.textAnnotationsBefore, 'Camera presets smoke: pending text prompt wrote an annotation after dispose');
    assert.equal(result.staleTextPromptChanges, 0, 'Camera presets smoke: pending text prompt emitted onChange after dispose');
    assert.equal(result.localDrawAnnotationCount, 1, 'Camera presets smoke: drawn 2D annotation was not stored locally');
    assert.equal(result.persistedDrawAnnotationCount, 1, 'Camera presets smoke: drawn 2D annotation was not included in onChange state');
    assert.equal(result.staleChangeAdded, true, 'Camera presets smoke: pending local camera was not created');
    assert.equal(result.countBeforeRealtimeLoad, 2, 'Camera presets smoke: pending local camera setup failed');
    assert.equal(result.countAfterRealtimeLoad, 1, 'Camera presets smoke: realtime load did not replace pending local camera state');
    assert.equal(result.staleChangeCountAfterRealtimeLoad, 0, 'Camera presets smoke: realtime load did not cancel pending onChange debounce');
    assert.ok(result.reloadPendingBeforeLoad > 0, 'Camera presets smoke: reload-during-play did not schedule a transition RAF');
    assert.equal(result.reloadPendingAfterLoad, 0, 'Camera presets smoke: realtime load did not cancel active transition RAF');
    assert.equal(result.reloadControlsRestored, true, 'Camera presets smoke: realtime load during playback left controls disabled');
    assert.equal(result.reloadActiveAfterLoad, 'cam-c', 'Camera presets smoke: realtime load during playback did not keep the loaded active camera');
    assert.deepEqual(result.cameraAfterStaleReload, result.cameraBeforeStaleReload, 'Camera presets smoke: stale transition RAF moved camera after realtime load');
    assert.equal(result.reloadActiveAfterStale, 'cam-c', 'Camera presets smoke: stale transition RAF restored an old active camera after realtime load');
    assert.equal(result.reloadStaleDidNotRender, true, 'Camera presets smoke: stale transition RAF rendered after realtime load');
    diagnostics.assertNoErrors('Camera presets lifecycle smoke');
    await page.close();
}

async function runCameraPickLifecycleSmoke(browser, baseUrl) {
    const page = await browser.newPage();
    const diagnostics = attachPageDiagnostics(page);
    await page.goto(`${baseUrl}/__smoke_blank`, { waitUntil: 'domcontentloaded', timeout: 15000 });

    const result = await page.evaluate(async () => {
        const THREE = await import('three');
        const { createCameraPickController } = await import('/scripts/modules/ui/camera-pick.js');

        const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
        camera.position.set(0, 0, 5);
        const world = new THREE.Group();
        const canvas = document.createElement('canvas');
        canvas.style.cursor = 'grab';
        canvas.getBoundingClientRect = () => ({
            left: 0,
            top: 0,
            width: 100,
            height: 100,
            right: 100,
            bottom: 100,
            x: 0,
            y: 0,
            toJSON: () => {},
        });
        const pickBtn = document.createElement('button');
        document.body.append(canvas, pickBtn);
        const controls = {
            enabled: true,
            target: new THREE.Vector3(),
            update: () => {},
        };

        const controller = createCameraPickController({
            THREE,
            camera,
            controls,
            world,
            renderer: { domElement: canvas },
            pickBtn,
            requestRender: () => {},
        });

        controller.setActive(true);
        const activeBeforeDispose = controller.isActive();
        const controlsDisabledBeforeDispose = controls.enabled === false;
        const cursorBeforeDispose = canvas.style.cursor;
        const buttonActiveBeforeDispose = pickBtn.classList.contains('active');

        controller.dispose();
        controller.dispose();
        const restoredAfterDispose =
            controller.isActive() === false &&
            controls.enabled === true &&
            canvas.style.cursor === 'grab' &&
            !pickBtn.classList.contains('active');

        controls.enabled = true;
        canvas.style.cursor = 'grab';
        controller.setActive(true);
        pickBtn.click();
        canvas.dispatchEvent(new PointerEvent('pointerdown', {
            bubbles: true,
            cancelable: true,
            pointerId: 1,
            button: 0,
            clientX: 50,
            clientY: 50,
        }));

        return {
            activeBeforeDispose,
            controlsDisabledBeforeDispose,
            cursorBeforeDispose,
            buttonActiveBeforeDispose,
            restoredAfterDispose,
            activeAfterLateCalls: controller.isActive(),
            controlsAfterLateCalls: controls.enabled,
            cursorAfterLateCalls: canvas.style.cursor,
            buttonActiveAfterLateCalls: pickBtn.classList.contains('active'),
        };
    });

    assert.equal(result.activeBeforeDispose, true, 'Camera pick smoke: pick mode did not activate');
    assert.equal(result.controlsDisabledBeforeDispose, true, 'Camera pick smoke: controls were not disabled while active');
    assert.equal(result.cursorBeforeDispose, 'crosshair', 'Camera pick smoke: cursor was not changed while active');
    assert.equal(result.buttonActiveBeforeDispose, true, 'Camera pick smoke: button was not marked active');
    assert.equal(result.restoredAfterDispose, true, 'Camera pick smoke: dispose did not restore controls/cursor/button state');
    assert.equal(result.activeAfterLateCalls, false, 'Camera pick smoke: disposed controller became active again');
    assert.equal(result.controlsAfterLateCalls, true, 'Camera pick smoke: disposed controller disabled controls after dispose');
    assert.equal(result.cursorAfterLateCalls, 'grab', 'Camera pick smoke: disposed controller changed cursor after dispose');
    assert.equal(result.buttonActiveAfterLateCalls, false, 'Camera pick smoke: disposed controller changed button after dispose');
    diagnostics.assertNoErrors('Camera pick lifecycle smoke');
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

async function runFileFlowSerializationSmoke(browser, baseUrl) {
    const page = await browser.newPage();
    const diagnostics = attachPageDiagnostics(page);
    await page.goto(`${baseUrl}/__smoke_blank`, { waitUntil: 'domcontentloaded', timeout: 15000 });

    const result = await page.evaluate(async () => {
        const { createFileFlowController } = await import('/scripts/modules/io/file-flow.js');

        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.multiple = true;
        const rootEl = document.createElement('main');
        const dropEl = document.createElement('div');
        document.body.append(fileInput, rootEl, dropEl);

        const calls = [];
        let loadedCount = 0;
        let releaseFirst = null;
        const firstBlocked = new Promise((resolve) => {
            releaseFirst = resolve;
        });
        let firstStarted = null;
        const waitFirstStarted = new Promise((resolve) => {
            firstStarted = resolve;
        });
        let finalizeCount = 0;

        const controller = createFileFlowController({
            fileInput,
            rootEl,
            dropEl,
            sampleModels: [],
            handleFBXFile: async () => {},
            handleZIPFile: async (file) => {
                calls.push(`zip:start:${file.name}`);
                if (file.name === 'one.zip') {
                    firstStarted();
                    await firstBlocked;
                }
                calls.push(`zip:done:${file.name}`);
                loadedCount += 1;
            },
            finalizeBatchAfterAllFiles: async () => {
                finalizeCount += 1;
                calls.push('finalize');
            },
            setEmptyHintVisible: (visible) => calls.push(`hint:${!!visible}`),
            getLoadedModelCount: () => loadedCount,
        });

        Object.defineProperty(fileInput, 'files', {
            configurable: true,
            value: [new File(['one'], 'one.zip', { type: 'application/zip' })],
        });
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
        await waitFirstStarted;

        Object.defineProperty(fileInput, 'files', {
            configurable: true,
            value: [new File(['two'], 'two.zip', { type: 'application/zip' })],
        });
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
        for (let i = 0; i < 5; i += 1) await Promise.resolve();
        const callsBeforeRelease = calls.slice();

        releaseFirst();
        for (let i = 0; i < 50 && finalizeCount < 2; i += 1) {
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
        const callsAfterCompletion = calls.slice();
        controller.dispose();

        return {
            callsBeforeRelease,
            callsAfterCompletion,
            finalizeCount,
            loadedCount,
        };
    });

    assert.deepEqual(result.callsBeforeRelease, [
        'hint:false',
        'zip:start:one.zip',
    ], 'File-flow serialization smoke: second batch started while first import was still active');
    assert.deepEqual(result.callsAfterCompletion, [
        'hint:false',
        'zip:start:one.zip',
        'zip:done:one.zip',
        'hint:false',
        'finalize',
        'hint:false',
        'zip:start:two.zip',
        'zip:done:two.zip',
        'hint:false',
        'finalize',
    ], 'File-flow serialization smoke: queued batches did not finish in order');
    assert.equal(result.finalizeCount, 2, 'File-flow serialization smoke: queued batches did not both finalize');
    assert.equal(result.loadedCount, 2, 'File-flow serialization smoke: queued batch did not load the second file');
    diagnostics.assertNoErrors('File-flow serialization smoke');
    await page.close();
}

async function runImportPipelineQueueSmoke(browser, baseUrl) {
    const page = await browser.newPage();
    const diagnostics = attachPageDiagnostics(page);
    await page.goto(`${baseUrl}/__smoke_blank`, { waitUntil: 'domcontentloaded', timeout: 15000 });

    const result = await page.evaluate(async () => {
        const { createImportPipelineQueue } = await import('/scripts/modules/io/import-pipeline.js');

        const makeAbortError = (message = 'aborted') => {
            try {
                return new DOMException(message, 'AbortError');
            } catch (_) {
                const err = new Error(message);
                err.name = 'AbortError';
                return err;
            }
        };

        const queue = createImportPipelineQueue({ makeAbortError });
        const events = [];
        const deferred = () => {
            let resolve = null;
            const promise = new Promise((nextResolve) => {
                resolve = nextResolve;
            });
            return { promise, resolve };
        };

        const startedA = deferred();
        const releaseA = deferred();
        const first = queue.enqueue(async () => {
            events.push('start:A');
            startedA.resolve();
            await releaseA.promise;
            events.push('done:A');
            return 'A';
        });
        await startedA.promise;
        const second = queue.enqueue(async () => {
            events.push('start:B');
            events.push(`pending:B:${queue.getPendingCount()}`);
            return 'B';
        });
        for (let i = 0; i < 5; i += 1) await Promise.resolve();
        const beforeRelease = events.slice();
        const pendingBeforeRelease = queue.getPendingCount();
        releaseA.resolve();
        const serialValues = await Promise.all([first, second]);
        const afterSerial = events.slice();
        const pendingAfterSerial = queue.getPendingCount();

        const startedBlocker = deferred();
        const releaseBlocker = deferred();
        const blocker = queue.enqueue(async () => {
            events.push('start:blocker');
            startedBlocker.resolve();
            await releaseBlocker.promise;
            events.push('done:blocker');
        });
        await startedBlocker.promise;
        const abortController = new AbortController();
        const abortedQueued = queue.enqueue(async () => {
            events.push('start:aborted');
            return 'bad';
        }, {
            signal: abortController.signal,
            abortMessage: 'queued abort',
        });
        abortController.abort(makeAbortError('queued abort'));
        releaseBlocker.resolve();
        await blocker;
        let abortedResult = '';
        try {
            await abortedQueued;
            abortedResult = 'resolved';
        } catch (err) {
            abortedResult = `${err?.name || ''}:${err?.message || err}`;
        }

        const startedCurrentBlocker = deferred();
        const releaseCurrentBlocker = deferred();
        const currentBlocker = queue.enqueue(async () => {
            events.push('start:current-blocker');
            startedCurrentBlocker.resolve();
            await releaseCurrentBlocker.promise;
            events.push('done:current-blocker');
        });
        await startedCurrentBlocker.promise;
        let current = true;
        const staleQueued = queue.enqueue(async () => {
            events.push('start:stale');
            return 'stale';
        }, {
            isCurrent: () => current,
            abortMessage: 'queued stale',
        });
        current = false;
        releaseCurrentBlocker.resolve();
        await currentBlocker;
        let staleResult = '';
        try {
            await staleQueued;
            staleResult = 'resolved';
        } catch (err) {
            staleResult = `${err?.name || ''}:${err?.message || err}`;
        }

        return {
            beforeRelease,
            pendingBeforeRelease,
            serialValues,
            afterSerial,
            pendingAfterSerial,
            abortedResult,
            staleResult,
            events,
            pendingEnd: queue.getPendingCount(),
        };
    });

    assert.deepEqual(result.beforeRelease, ['start:A'], 'Import pipeline smoke: second import started before first settled');
    assert.equal(result.pendingBeforeRelease, 2, 'Import pipeline smoke: queued import was not tracked as pending');
    assert.deepEqual(result.serialValues, ['A', 'B'], 'Import pipeline smoke: serialized imports returned wrong results');
    assert.deepEqual(result.afterSerial, [
        'start:A',
        'done:A',
        'start:B',
        'pending:B:1',
    ], 'Import pipeline smoke: serialized import order changed');
    assert.equal(result.pendingAfterSerial, 0, 'Import pipeline smoke: pending count did not clear after serialized imports');
    assert.equal(result.abortedResult, 'AbortError:queued abort', 'Import pipeline smoke: aborted queued import did not reject with AbortError');
    assert.equal(result.staleResult, 'AbortError:queued stale', 'Import pipeline smoke: stale queued import did not reject with AbortError');
    assert.equal(result.events.includes('start:aborted'), false, 'Import pipeline smoke: aborted queued import still ran');
    assert.equal(result.events.includes('start:stale'), false, 'Import pipeline smoke: stale queued import still ran');
    assert.equal(result.pendingEnd, 0, 'Import pipeline smoke: pending count leaked after abort/stale cases');
    diagnostics.assertNoErrors('Import pipeline queue smoke');
    await page.close();
}

async function runFileFlowDisposeLifecycleSmoke(browser, baseUrl) {
    const page = await browser.newPage();
    const diagnostics = attachPageDiagnostics(page);
    await page.goto(`${baseUrl}/__smoke_blank`, { waitUntil: 'domcontentloaded', timeout: 15000 });

    const result = await page.evaluate(async () => {
        const { createSampleLoader } = await import('/scripts/modules/io/sample-loader.js');
        const { createFileFlowController } = await import('/scripts/modules/io/file-flow.js');

        const makeAbortError = (message = 'aborted') => {
            try {
                return new DOMException(message, 'AbortError');
            } catch (_) {
                const err = new Error(message);
                err.name = 'AbortError';
                return err;
            }
        };

        const nativeFetch = globalThis.fetch;
        const sampleEvents = [];
        let sampleFetchSignal = null;
        globalThis.fetch = (_url, options = {}) => new Promise((_resolve, reject) => {
            sampleFetchSignal = options.signal || null;
            sampleFetchSignal?.addEventListener?.('abort', () => {
                reject(sampleFetchSignal.reason || makeAbortError('sample aborted'));
            }, { once: true });
        });

        try {
            const statusEl = document.createElement('div');
            const sampleSelect = document.createElement('select');
            sampleSelect.appendChild(new Option('Sample', '/slow.zip'));
            document.body.append(statusEl, sampleSelect);

            const sampleLoader = createSampleLoader({
                statusEl,
                sampleSelect,
                setStatusMessage: (message) => sampleEvents.push(`status:${message}`),
                setEmptyHintVisible: (visible) => sampleEvents.push(`hint:${!!visible}`),
                hideSidePanel: () => sampleEvents.push('hide'),
                handleZIPFile: async () => sampleEvents.push('zip'),
                finalizeBatchAfterAllFiles: async () => sampleEvents.push('finalize'),
                getLoadedModelCount: () => 0,
            });

            const samplePromise = sampleLoader.loadSampleModel({
                label: 'Sample',
                files: ['/slow.zip'],
            });
            for (let i = 0; i < 20 && !sampleFetchSignal; i += 1) {
                await Promise.resolve();
            }
            const sampleDisabledDuringLoad = sampleSelect.disabled;
            sampleLoader.dispose();
            const sampleSignalAborted = !!sampleFetchSignal?.aborted;
            const sampleResult = await samplePromise;
            const sampleAfterDisposeResult = await sampleLoader.loadSampleModel({
                label: 'Late',
                files: ['/late.zip'],
            });

            const guardedSampleEvents = [];
            let releaseGuardedFinalize = null;
            let resolveGuardedFinalizeStarted = null;
            const guardedFinalizeStarted = new Promise((resolve) => {
                resolveGuardedFinalizeStarted = resolve;
            });
            globalThis.fetch = async (_url, options = {}) => {
                guardedSampleEvents.push(`fetchSignal:${!!options.signal}`);
                return {
                    ok: true,
                    status: 200,
                    statusText: 'OK',
                    blob: async () => new Blob([new Uint8Array([9])], { type: 'application/zip' }),
                };
            };
            const guardedStatusEl = document.createElement('div');
            const guardedSampleSelect = document.createElement('select');
            guardedSampleSelect.appendChild(new Option('Guarded', '/guarded.zip'));
            document.body.append(guardedStatusEl, guardedSampleSelect);
            const guardedSampleLoader = createSampleLoader({
                statusEl: guardedStatusEl,
                sampleSelect: guardedSampleSelect,
                setStatusMessage: (message) => guardedSampleEvents.push(`status:${message}`),
                setEmptyHintVisible: (visible) => guardedSampleEvents.push(`hint:${!!visible}`),
                hideSidePanel: () => guardedSampleEvents.push('hide'),
                handleZIPFile: async (_file, options = {}) => {
                    guardedSampleEvents.push(`zipSignal:${!!options.signal}`);
                },
                finalizeBatchAfterAllFiles: async (options = {}) => {
                    const hasGuard = typeof options.isCurrent === 'function';
                    guardedSampleEvents.push(`finalizeGuard:${hasGuard}`);
                    resolveGuardedFinalizeStarted?.();
                    await new Promise((resolve) => {
                        releaseGuardedFinalize = resolve;
                    });
                    const currentAfterDispose = hasGuard ? options.isCurrent() : 'missing';
                    guardedSampleEvents.push(`finalizeCurrent:${currentAfterDispose}`);
                    if (currentAfterDispose !== false) guardedSampleEvents.push('finalizeMutated');
                    return currentAfterDispose !== false;
                },
                getLoadedModelCount: () => 1,
            });
            const guardedSamplePromise = guardedSampleLoader.loadSampleModel({
                label: 'Guarded',
                files: ['/guarded.zip'],
            });
            await guardedFinalizeStarted;
            guardedSampleLoader.dispose();
            releaseGuardedFinalize?.();
            const guardedSampleResult = await guardedSamplePromise;

            const fileInput = document.createElement('input');
            fileInput.type = 'file';
            const openBtn = document.createElement('button');
            const emptyHint = document.createElement('button');
            const root = document.createElement('div');
            const drop = document.createElement('div');
            document.body.append(fileInput, openBtn, emptyHint, root, drop);

            const flowEvents = [];
            let flowSignal = null;
            const fileFlow = createFileFlowController({
                fileInput,
                openBtn,
                emptyHintEl: emptyHint,
                rootEl: root,
                dropEl: drop,
                sampleSelect: null,
                sampleModels: [],
                handleFBXFile: async () => flowEvents.push('fbx'),
                handleZIPFile: async (_file, options = {}) => {
                    flowEvents.push('zip:start');
                    flowSignal = options?.signal || null;
                    await new Promise((_resolve, reject) => {
                        flowSignal?.addEventListener?.('abort', () => {
                            flowEvents.push('zip:abort');
                            reject(flowSignal.reason || makeAbortError('batch aborted'));
                        }, { once: true });
                    });
                },
                finalizeBatchAfterAllFiles: async () => flowEvents.push('finalize'),
                setEmptyHintVisible: (visible) => flowEvents.push(`hint:${!!visible}`),
                getLoadedModelCount: () => 0,
            });

            Object.defineProperty(fileInput, 'files', {
                configurable: true,
                value: [new File([new Uint8Array([1])], 'model.zip', { type: 'application/zip' })],
            });
            fileInput.dispatchEvent(new Event('change'));
            for (let i = 0; i < 20 && !flowSignal; i += 1) {
                await Promise.resolve();
            }
            drop.classList.add('show');
            fileFlow.dispose();
            await Promise.resolve();
            await Promise.resolve();
            const flowSignalAborted = !!flowSignal?.aborted;
            const flowDropCleared = !drop.classList.contains('show');
            const flowEventsAfterDispose = flowEvents.slice();

            Object.defineProperty(fileInput, 'files', {
                configurable: true,
                value: [new File([new Uint8Array([2])], 'late.zip', { type: 'application/zip' })],
            });
            fileInput.dispatchEvent(new Event('change'));
            await Promise.resolve();

            const guardedFlowInput = document.createElement('input');
            guardedFlowInput.type = 'file';
            const guardedOpenBtn = document.createElement('button');
            const guardedEmptyHint = document.createElement('button');
            const guardedRoot = document.createElement('div');
            const guardedDrop = document.createElement('div');
            document.body.append(guardedFlowInput, guardedOpenBtn, guardedEmptyHint, guardedRoot, guardedDrop);
            const guardedFlowEvents = [];
            let releaseGuardedFlowFinalize = null;
            let resolveGuardedFlowFinalizeStarted = null;
            const guardedFlowFinalizeStarted = new Promise((resolve) => {
                resolveGuardedFlowFinalizeStarted = resolve;
            });
            const guardedFileFlow = createFileFlowController({
                fileInput: guardedFlowInput,
                openBtn: guardedOpenBtn,
                emptyHintEl: guardedEmptyHint,
                rootEl: guardedRoot,
                dropEl: guardedDrop,
                sampleSelect: null,
                sampleModels: [],
                handleFBXFile: async () => guardedFlowEvents.push('fbx'),
                handleZIPFile: async () => guardedFlowEvents.push('zip'),
                finalizeBatchAfterAllFiles: async (options = {}) => {
                    const hasGuard = typeof options.isCurrent === 'function';
                    guardedFlowEvents.push(`finalizeGuard:${hasGuard}`);
                    resolveGuardedFlowFinalizeStarted?.();
                    await new Promise((resolve) => {
                        releaseGuardedFlowFinalize = resolve;
                    });
                    const currentAfterDispose = hasGuard ? options.isCurrent() : 'missing';
                    guardedFlowEvents.push(`finalizeCurrent:${currentAfterDispose}`);
                    if (currentAfterDispose !== false) guardedFlowEvents.push('finalizeMutated');
                    return currentAfterDispose !== false;
                },
                setEmptyHintVisible: (visible) => guardedFlowEvents.push(`hint:${!!visible}`),
                getLoadedModelCount: () => 1,
            });
            Object.defineProperty(guardedFlowInput, 'files', {
                configurable: true,
                value: [new File([new Uint8Array([3])], 'guarded.zip', { type: 'application/zip' })],
            });
            guardedFlowInput.dispatchEvent(new Event('change'));
            await guardedFlowFinalizeStarted;
            guardedFileFlow.dispose();
            releaseGuardedFlowFinalize?.();
            for (let i = 0; i < 10; i += 1) {
                await Promise.resolve();
            }

            return {
                sampleDisabledDuringLoad,
                sampleSignalAborted,
                sampleResult,
                sampleAfterDisposeResult,
                sampleSelectReenabled: sampleSelect.disabled === false,
                sampleSelectReset: sampleSelect.value === '',
                sampleZipCalled: sampleEvents.includes('zip'),
                sampleFinalizeCalled: sampleEvents.includes('finalize'),
                sampleAbortShowedError: sampleEvents.some((entry) => entry.includes('Ошибка загрузки примера')),
                guardedSampleResult,
                guardedSampleSelectReenabled: guardedSampleSelect.disabled === false,
                guardedFinalizeHadGuard: guardedSampleEvents.includes('finalizeGuard:true'),
                guardedFinalizeCurrentAfterDispose: guardedSampleEvents.includes('finalizeCurrent:false'),
                guardedFinalizeMutated: guardedSampleEvents.includes('finalizeMutated'),
                flowSignalAborted,
                flowDropCleared,
                flowEventsAfterDispose,
                flowEvents,
                flowFinalizeCalled: flowEvents.includes('finalize'),
                guardedFlowFinalizeHadGuard: guardedFlowEvents.includes('finalizeGuard:true'),
                guardedFlowFinalizeCurrentAfterDispose: guardedFlowEvents.includes('finalizeCurrent:false'),
                guardedFlowFinalizeMutated: guardedFlowEvents.includes('finalizeMutated'),
            };
        } finally {
            globalThis.fetch = nativeFetch;
        }
    });

    assert.equal(result.sampleDisabledDuringLoad, true, 'File-flow dispose smoke: sample select was not disabled during load');
    assert.equal(result.sampleSignalAborted, true, 'File-flow dispose smoke: sample fetch was not aborted on dispose');
    assert.equal(result.sampleResult, false, 'File-flow dispose smoke: disposed sample load did not resolve false');
    assert.equal(result.sampleAfterDisposeResult, false, 'File-flow dispose smoke: sample loader accepted load after dispose');
    assert.equal(result.sampleSelectReenabled, true, 'File-flow dispose smoke: sample select stayed disabled after dispose');
    assert.equal(result.sampleSelectReset, true, 'File-flow dispose smoke: sample select value was not reset after dispose');
    assert.equal(result.sampleZipCalled, false, 'File-flow dispose smoke: sample ZIP handler ran after dispose');
    assert.equal(result.sampleFinalizeCalled, false, 'File-flow dispose smoke: sample finalize ran after dispose');
    assert.equal(result.sampleAbortShowedError, false, 'File-flow dispose smoke: sample abort showed an error status');
    assert.equal(result.guardedSampleResult, false, 'File-flow dispose smoke: guarded sample finalize did not resolve false after dispose');
    assert.equal(result.guardedSampleSelectReenabled, true, 'File-flow dispose smoke: guarded sample select stayed disabled after dispose');
    assert.equal(result.guardedFinalizeHadGuard, true, 'File-flow dispose smoke: sample finalizer did not receive an isCurrent guard');
    assert.equal(result.guardedFinalizeCurrentAfterDispose, true, 'File-flow dispose smoke: sample finalizer guard stayed current after dispose');
    assert.equal(result.guardedFinalizeMutated, false, 'File-flow dispose smoke: stale sample finalizer still mutated after dispose');
    assert.equal(result.flowSignalAborted, true, 'File-flow dispose smoke: active file batch was not aborted on dispose');
    assert.equal(result.flowDropCleared, true, 'File-flow dispose smoke: drop overlay stayed visible after dispose');
    assert.deepEqual(result.flowEventsAfterDispose, ['hint:false', 'zip:start', 'zip:abort'], 'File-flow dispose smoke: unexpected active batch events after dispose');
    assert.deepEqual(result.flowEvents, result.flowEventsAfterDispose, 'File-flow dispose smoke: disposed file input still handled changes');
    assert.equal(result.flowFinalizeCalled, false, 'File-flow dispose smoke: file batch finalize ran after dispose');
    assert.equal(result.guardedFlowFinalizeHadGuard, true, 'File-flow dispose smoke: file finalizer did not receive an isCurrent guard');
    assert.equal(result.guardedFlowFinalizeCurrentAfterDispose, true, 'File-flow dispose smoke: file finalizer guard stayed current after dispose');
    assert.equal(result.guardedFlowFinalizeMutated, false, 'File-flow dispose smoke: stale file finalizer still mutated after dispose');
    diagnostics.assertNoErrors('File-flow dispose lifecycle smoke');
    await page.close();
}

async function runBatchFinalizerDisposeSmoke(browser, baseUrl) {
    const page = await browser.newPage();
    const diagnostics = attachPageDiagnostics(page);
    await page.goto(`${baseUrl}/__smoke_blank`, { waitUntil: 'domcontentloaded', timeout: 15000 });

    const result = await page.evaluate(async () => {
        const { createBatchFinalizer } = await import('/scripts/modules/io/batch-finalizer.js');

        const calls = [];
        const loadedModels = [{ obj: { name: 'model' }, zipKind: 'SM', group: 'grp' }];
        const allEmbedded = [{ short: 'tex', url: 'blob:tex' }];
        let lastFinalizedModelIndex = 0;
        let galleryNeedsRefresh = true;
        let didInitialRebase = false;
        let resolveHdr = null;
        const hdrStarted = new Promise((resolve) => {
            resolveHdr = resolve;
        });
        let finishHdr = null;
        const hdrBlocked = new Promise((resolve) => {
            finishHdr = resolve;
        });
        const outEl = document.createElement('div');
        outEl.innerHTML = '<details data-level="group" open></details>';

        const finalizer = createBatchFinalizer({
            loadedModels,
            allEmbedded,
            getLastFinalizedModelIndex: () => lastFinalizedModelIndex,
            setLastFinalizedModelIndex: (next) => {
                calls.push(`last:${next}`);
                lastFinalizedModelIndex = next;
            },
            getGalleryNeedsRefresh: () => galleryNeedsRefresh,
            setGalleryNeedsRefresh: (next) => {
                calls.push(`galleryNeeds:${next}`);
                galleryNeedsRefresh = next;
            },
            renderGallery: () => calls.push('renderGallery'),
            getDidInitialRebase: () => didInitialRebase,
            setDidInitialRebase: (next) => {
                calls.push(`didRebase:${next}`);
                didInitialRebase = next;
            },
            computeAutoOffsetHorizontalOnly: () => ({ x: 1, y: 0, z: 2 }),
            setWorldOffset: () => calls.push('setWorldOffset'),
            isIBLEnabled: () => true,
            getIBLRotation: () => 30,
            loadHDRBase: async () => {
                calls.push('loadHDR:start');
                resolveHdr();
                await hdrBlocked;
                calls.push('loadHDR:done');
            },
            buildAndApplyEnvFromRotation: async () => calls.push('buildEnv'),
            syncBackgroundToEnvironment: () => calls.push('syncBg'),
            applyGlassControlsToScene: () => calls.push('glass'),
            fitSunShadowToScene: () => calls.push('shadow'),
            updateSun: () => calls.push('sun'),
            buildVPMIndex: () => {
                calls.push('vpmIndex');
                return {};
            },
            autoBindVPMForModel: async () => calls.push('autobind'),
            logBind: (message) => calls.push(`log:${message}`),
            ensureZipCollisionsHidden: () => calls.push('hideCollisions'),
            fitAll: () => calls.push('fitAll'),
            focusOn: () => calls.push('focusOn'),
            onInitialFraming: () => calls.push('initialFraming'),
            outEl,
            imagesDetails: document.createElement('details'),
            bindLogDetails: document.createElement('details'),
            hideSMCollisions: () => {
                calls.push('hideSM');
                return true;
            },
            syncCollisionButtons: () => calls.push('syncCollisions'),
            setStatusMessage: (message) => calls.push(`status:${message}`),
            setEmptyHintVisible: (visible) => calls.push(`hint:${!!visible}`),
            applyShading: (_mode, done) => {
                calls.push('shading');
                done?.();
            },
            getCurrentShadingMode: () => 'pbr',
        });

        const promise = finalizer.finalizeBatchAfterAllFiles();
        await hdrStarted;
        const callsBeforeDispose = calls.slice();
        finalizer.dispose();
        finalizer.dispose();
        finishHdr();
        const finalizeResult = await promise;
        const callsAfterDispose = calls.slice();
        const lateResult = await finalizer.finalizeBatchAfterAllFiles();

        const staleCalls = [];
        const staleModels = [{ obj: { name: 'stale-model' }, zipKind: 'SM', group: 'stale-group' }];
        const staleOutEl = document.createElement('div');
        staleOutEl.innerHTML = '<details data-level="group" open></details>';
        let staleLastFinalizedModelIndex = 0;
        let staleCurrent = true;
        let resolveStaleHdr = null;
        const staleHdrStarted = new Promise((resolve) => {
            resolveStaleHdr = resolve;
        });
        let finishStaleHdr = null;
        const staleHdrBlocked = new Promise((resolve) => {
            finishStaleHdr = resolve;
        });
        const staleFinalizer = createBatchFinalizer({
            loadedModels: staleModels,
            allEmbedded: [],
            getLastFinalizedModelIndex: () => staleLastFinalizedModelIndex,
            setLastFinalizedModelIndex: (next) => {
                staleCalls.push(`stale:last:${next}`);
                staleLastFinalizedModelIndex = next;
            },
            getGalleryNeedsRefresh: () => false,
            getDidInitialRebase: () => true,
            isIBLEnabled: () => true,
            getIBLRotation: () => 30,
            loadHDRBase: async () => {
                staleCalls.push('stale:loadHDR:start');
                resolveStaleHdr();
                await staleHdrBlocked;
                staleCalls.push('stale:loadHDR:done');
            },
            buildAndApplyEnvFromRotation: async () => staleCalls.push('stale:buildEnv'),
            syncBackgroundToEnvironment: () => staleCalls.push('stale:syncBg'),
            applyGlassControlsToScene: () => staleCalls.push('stale:glass'),
            fitSunShadowToScene: () => staleCalls.push('stale:shadow'),
            updateSun: () => staleCalls.push('stale:sun'),
            buildVPMIndex: () => {
                staleCalls.push('stale:vpmIndex');
                return {};
            },
            autoBindVPMForModel: async () => staleCalls.push('stale:autobind'),
            ensureZipCollisionsHidden: () => staleCalls.push('stale:hideCollisions'),
            fitAll: () => staleCalls.push('stale:fitAll'),
            focusOn: () => staleCalls.push('stale:focusOn'),
            onInitialFraming: () => staleCalls.push('stale:initialFraming'),
            outEl: staleOutEl,
            hideSMCollisions: () => {
                staleCalls.push('stale:hideSM');
                return true;
            },
            syncCollisionButtons: () => staleCalls.push('stale:syncCollisions'),
            setStatusMessage: (message) => staleCalls.push(`stale:status:${message}`),
            setEmptyHintVisible: (visible) => staleCalls.push(`stale:hint:${!!visible}`),
            applyShading: (_mode, done) => {
                staleCalls.push('stale:shading');
                done?.();
            },
            getCurrentShadingMode: () => 'pbr',
        });
        const stalePromise = staleFinalizer.finalizeBatchAfterAllFiles({
            isCurrent: () => staleCurrent,
        });
        await staleHdrStarted;
        const staleCallsBeforeSupersede = staleCalls.slice();
        staleCurrent = false;
        finishStaleHdr();
        const staleResult = await stalePromise;
        const staleCallsAfterSupersede = staleCalls.slice();

        const pbrBurstCalls = [];
        const pbrBurstOutEl = document.createElement('div');
        pbrBurstOutEl.innerHTML = '<details data-level="group" open></details>';
        const pbrBurstFinalizer = createBatchFinalizer({
            loadedModels: [{ obj: { name: 'pbr-model' }, zipKind: 'LPM' }],
            allEmbedded: [],
            getLastFinalizedModelIndex: () => 0,
            setLastFinalizedModelIndex: (next) => pbrBurstCalls.push(`last:${next}`),
            getGalleryNeedsRefresh: () => false,
            getDidInitialRebase: () => true,
            isIBLEnabled: () => false,
            applyShading: (mode, done) => {
                pbrBurstCalls.push(`shading:${mode}`);
                done?.();
            },
            getCurrentShadingMode: () => 'pbr',
            requestPostImportRenderBurst: () => pbrBurstCalls.push('burst'),
            applyBaseColorPolicyToRoot: (root) => pbrBurstCalls.push(`baseColor:${root?.name || ''}`),
            outEl: pbrBurstOutEl,
        });
        const pbrBurstResult = await pbrBurstFinalizer.finalizeBatchAfterAllFiles();

        const nonPbrBurstCalls = [];
        const nonPbrBurstOutEl = document.createElement('div');
        nonPbrBurstOutEl.innerHTML = '<details data-level="group" open></details>';
        const nonPbrBurstFinalizer = createBatchFinalizer({
            loadedModels: [{ obj: { name: 'normal-model' }, zipKind: 'LPM' }],
            allEmbedded: [],
            getLastFinalizedModelIndex: () => 0,
            setLastFinalizedModelIndex: (next) => nonPbrBurstCalls.push(`last:${next}`),
            getGalleryNeedsRefresh: () => false,
            getDidInitialRebase: () => true,
            isIBLEnabled: () => false,
            applyShading: (mode, done) => {
                nonPbrBurstCalls.push(`shading:${mode}`);
                done?.();
            },
            getCurrentShadingMode: () => 'normal',
            requestPostImportRenderBurst: () => nonPbrBurstCalls.push('burst'),
            applyBaseColorPolicyToRoot: (root) => nonPbrBurstCalls.push(`baseColor:${root?.name || ''}`),
            outEl: nonPbrBurstOutEl,
        });
        const nonPbrBurstResult = await nonPbrBurstFinalizer.finalizeBatchAfterAllFiles();

        return {
            callsBeforeDispose,
            callsAfterDispose,
            finalizeResult,
            lateResult,
            lastFinalizedModelIndex,
            galleryNeedsRefresh,
            staleCallsBeforeSupersede,
            staleCallsAfterSupersede,
            staleResult,
            staleLastFinalizedModelIndex,
            pbrBurstResult,
            pbrBurstCalls,
            nonPbrBurstResult,
            nonPbrBurstCalls,
        };
    });

    assert.deepEqual(
        result.callsAfterDispose,
        [...result.callsBeforeDispose, 'loadHDR:done'],
        'Batch finalizer smoke: disposed finalizer continued scene/UI finalization after await',
    );
    assert.equal(result.finalizeResult, false, 'Batch finalizer smoke: disposed in-flight finalizer did not return false');
    assert.equal(result.lateResult, false, 'Batch finalizer smoke: disposed finalizer accepted a late finalize call');
    assert.equal(result.lastFinalizedModelIndex, 0, 'Batch finalizer smoke: disposed finalizer advanced finalized index');
    assert.equal(result.galleryNeedsRefresh, false, 'Batch finalizer smoke: pre-dispose gallery refresh state did not update as expected');
    assert.deepEqual(
        result.staleCallsAfterSupersede,
        [...result.staleCallsBeforeSupersede, 'stale:loadHDR:done'],
        'Batch finalizer smoke: stale finalizer continued scene/UI finalization after await',
    );
    assert.equal(result.staleResult, false, 'Batch finalizer smoke: stale in-flight finalizer did not return false');
    assert.equal(result.staleLastFinalizedModelIndex, 0, 'Batch finalizer smoke: stale finalizer advanced finalized index');
    assert.equal(result.pbrBurstResult, true, 'Batch finalizer smoke: PBR finalizer did not complete');
    assert.deepEqual(
        result.pbrBurstCalls,
        ['baseColor:pbr-model', 'shading:pbr', 'burst', 'last:1'],
        'Batch finalizer smoke: successful PBR import did not request a post-import render burst',
    );
    assert.equal(result.nonPbrBurstResult, true, 'Batch finalizer smoke: non-PBR finalizer did not complete');
    assert.deepEqual(
        result.nonPbrBurstCalls,
        ['baseColor:normal-model', 'shading:normal', 'last:1'],
        'Batch finalizer smoke: non-PBR import unexpectedly requested a post-import render burst',
    );
    diagnostics.assertNoErrors('Batch finalizer dispose smoke');
    await page.close();
}

async function runTextureGalleryLifecycleSmoke(browser, baseUrl) {
    const page = await browser.newPage();
    const diagnostics = attachPageDiagnostics(page);
    await page.goto(`${baseUrl}/__smoke_blank`, { waitUntil: 'domcontentloaded', timeout: 15000 });

    const result = await page.evaluate(async () => {
        const { createTextureGalleryController } = await import('/scripts/modules/ui/texture-gallery.js');

        const gallery = document.createElement('div');
        const count = document.createElement('span');
        document.body.append(gallery, count);

        const opened = [];
        const controller = createTextureGalleryController({
            galleryEl: gallery,
            texCountEl: count,
            basename: (value) => String(value || '').split('/').pop(),
            guessKindFromName: () => 'base',
            onOpen: (entry) => opened.push(entry?.short || ''),
        });

        const oldEntry = {
            short: 'old_base.png',
            full: 'textures/old_base.png',
            url: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=',
            mime: 'image/png',
        };
        const newEntry = {
            short: 'new_base.png',
            full: 'textures/new_base.png',
            url: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=',
            mime: 'image/png',
        };

        controller.render([oldEntry]);
        const oldThumb = gallery.querySelector('.thumb');
        const firstName = gallery.querySelector('.nm')?.textContent || '';
        oldThumb?.click();

        controller.render([newEntry]);
        const newThumb = gallery.querySelector('.thumb');
        const secondName = gallery.querySelector('.nm')?.textContent || '';
        oldThumb?.click();
        newThumb?.click();

        controller.dispose();
        const htmlAfterDispose = gallery.innerHTML;
        const countAfterDispose = count.textContent;
        newThumb?.click();
        controller.render([oldEntry]);

        return {
            opened,
            firstName,
            secondName,
            htmlAfterDispose,
            countAfterDispose,
            htmlAfterLateRender: gallery.innerHTML,
            renderedCount: controller.getRenderedCount(),
        };
    });

    assert.deepEqual(
        result.opened,
        ['old_base.png', 'new_base.png'],
        'Texture gallery lifecycle smoke: stale/disposed thumbnail callback opened an entry',
    );
    assert.equal(result.firstName, 'old_base.png', 'Texture gallery lifecycle smoke: initial entry did not render');
    assert.equal(result.secondName, 'new_base.png', 'Texture gallery lifecycle smoke: equal-length replacement did not rerender');
    assert.equal(result.htmlAfterDispose, '', 'Texture gallery lifecycle smoke: dispose left thumbnail DOM behind');
    assert.equal(result.htmlAfterLateRender, '', 'Texture gallery lifecycle smoke: disposed gallery accepted late render');
    assert.equal(result.countAfterDispose, '0', 'Texture gallery lifecycle smoke: dispose did not reset count');
    assert.equal(result.renderedCount, 0, 'Texture gallery lifecycle smoke: disposed gallery retained rendered count');
    diagnostics.assertNoErrors('Texture gallery lifecycle smoke');
    await page.close();
}

async function runTextureModalStaleEntrySmoke(browser, baseUrl) {
    const page = await browser.newPage();
    const diagnostics = attachPageDiagnostics(page);
    await page.goto(`${baseUrl}/__smoke_blank`, { waitUntil: 'domcontentloaded', timeout: 15000 });

    const result = await page.evaluate(async () => {
        const { createTextureModalController } = await import('/scripts/modules/ui/texture-modal.js');

        const modal = document.createElement('div');
        const closeBtn = document.createElement('button');
        const img = document.createElement('img');
        const title = document.createElement('div');
        const file = document.createElement('div');
        const kind = document.createElement('div');
        const mime = document.createElement('div');
        const dl = document.createElement('a');
        const bind = document.createElement('button');
        const slot = document.createElement('select');
        const mat = document.createElement('select');
        modal.append(closeBtn, img, title, file, kind, mime, dl, bind, slot, mat);
        document.body.appendChild(modal);

        const controller = createTextureModalController({
            texModalEl: modal,
            closeBtnEl: closeBtn,
            imgEl: img,
            titleEl: title,
            fileEl: file,
            kindEl: kind,
            mimeEl: mime,
            downloadLinkEl: dl,
            bindBtnEl: bind,
            slotSelectEl: slot,
            matSelectEl: mat,
            basename: (value) => String(value || '').split('/').pop(),
            guessKindFromName: () => 'base',
        });

        const staleEntry = {
            short: 'old_base.png',
            full: 'textures/old_base.png',
            url: 'blob:old-texture',
            mime: 'image/png',
        };
        controller.open(staleEntry);
        const opened = modal.classList.contains('show') && controller.getEntry() === staleEntry;

        controller.reconcileEntries([{ short: 'other.png', full: 'textures/other.png', url: 'blob:other' }]);
        const cleared = !modal.classList.contains('show')
            && controller.getEntry() == null
            && !img.hasAttribute('src')
            && !dl.hasAttribute('href');

        const liveEntry = {
            short: 'live_base.png',
            full: 'textures/live_base.png',
            url: 'blob:live-texture',
            mime: 'image/png',
        };
        controller.open(liveEntry);
        controller.reconcileEntries([{ ...liveEntry }]);
        const kept = modal.classList.contains('show') && controller.getEntry() === liveEntry;

        controller.dispose();
        controller.open(staleEntry);
        const disposedOpenIgnored = !modal.classList.contains('show')
            && controller.getEntry() == null
            && !img.hasAttribute('src');
        return { opened, cleared, kept, disposedOpenIgnored };
    });

    assert.equal(result.opened, true, 'Texture modal stale smoke: entry did not open');
    assert.equal(result.cleared, true, 'Texture modal stale smoke: removed gallery entry stayed active');
    assert.equal(result.kept, true, 'Texture modal stale smoke: live gallery entry was cleared');
    assert.equal(result.disposedOpenIgnored, true, 'Texture modal stale smoke: disposed modal accepted a late open');
    diagnostics.assertNoErrors('Texture modal stale entry smoke');
    await page.close();
}

async function runTextureReplacementLifecycleSmoke(browser, baseUrl) {
    const page = await browser.newPage();
    const diagnostics = attachPageDiagnostics(page);
    await page.goto(`${baseUrl}/__smoke_blank`, { waitUntil: 'domcontentloaded', timeout: 15000 });

	    const result = await page.evaluate(async () => {
	        const THREE = await import('three');
	        const { createFilenameBinder } = await import('/scripts/modules/material/filename-autobind.js');
	        const {
	            getMaterialSourceBaseColor,
	            TEXTURED_BASE_COLOR_MULTIPLIER,
	        } = await import('/scripts/modules/material/base-color-policy.js');
	        const { createToStandard } = await import('/scripts/modules/material/to-standard.js');
	        const { createTextureModalController } = await import('/scripts/modules/ui/texture-modal.js');
	        const { createSelectedMaterialLinkResolver } = await import('/scripts/modules/ui/texture-helpers.js');
	        const { createVPMBinder } = await import('/scripts/modules/material/vpm-autobind.js');
	        const toStandard = createToStandard();
	        const texturedBaseColor = new THREE.Color().setRGB(
	            TEXTURED_BASE_COLOR_MULTIPLIER,
	            TEXTURED_BASE_COLOR_MULTIPLIER,
	            TEXTURED_BASE_COLOR_MULTIPLIER,
	        );

        const trackDispose = (texture) => {
            let count = 0;
            texture.addEventListener('dispose', () => {
                count += 1;
            });
            return () => count;
        };

        const createDeferredTextureLoader = () => {
            const loads = [];
            return {
                loads,
                loader: {
                    load: (url, onLoad, _onProgress, onError) => {
                        const texture = new THREE.Texture();
                        texture.name = String(url || '');
                        loads.push({ url, texture, onLoad, onError });
                        return texture;
                    },
                },
            };
        };

        const filenameShared = new THREE.Texture();
        filenameShared.name = 'filename-shared';
        const filenameSharedDisposed = trackDispose(filenameShared);
        const root = new THREE.Group();
        const wall = new THREE.Mesh(
            new THREE.BoxGeometry(1, 1, 1),
            new THREE.MeshStandardMaterial({ name: 'wall material', map: filenameShared })
        );
        const ceiling = new THREE.Mesh(
            new THREE.BoxGeometry(1, 1, 1),
            new THREE.MeshStandardMaterial({ name: 'ceiling material', map: filenameShared })
        );
        wall.name = 'mesh_wall';
        ceiling.name = 'mesh_ceiling';
        root.add(wall, ceiling);

        const binder = createFilenameBinder({
            THREE,
            geomSuffixes: ['wall', 'ceiling'],
            guessKindFromName: () => 'base',
            findGeomSuffix: (label) => {
                const lower = String(label || '').toLowerCase();
                if (lower.includes('wall')) return 'wall';
                if (lower.includes('ceiling')) return 'ceiling';
                return null;
            },
            textureLoader: { load: () => new THREE.Texture() },
            toStandard: (material) => material,
            copyTextureSettings: () => {},
        });

        binder.autoBindByNamesForModel(root, 'model.fbx', [
            { short: 'T_wall_d_1.png', full: 'T_wall_d_1.png', url: 'blob:wall-new' },
        ]);
        const filenameAfterFirstBind = filenameSharedDisposed();
	        binder.autoBindByNamesForModel(root, 'model.fbx', [
	            { short: 'T_ceiling_d_1.png', full: 'T_ceiling_d_1.png', url: 'blob:ceiling-new' },
	        ]);
	        const filenameAfterSecondBind = filenameSharedDisposed();

	        const filenameConvertedTexture = new THREE.Texture();
	        filenameConvertedTexture.name = 'filename-converted';
	        const filenameConvertedTextureDisposed = trackDispose(filenameConvertedTexture);
	        const filenameConvertedMaterial = new THREE.MeshBasicMaterial({
	            name: 'panel material',
	            map: filenameConvertedTexture,
	        });
	        const filenameConvertedMaterialDisposed = trackDispose(filenameConvertedMaterial);
	        const convertRoot = new THREE.Group();
	        const panel = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), filenameConvertedMaterial);
	        panel.name = 'mesh_panel';
	        convertRoot.add(panel);
	        const conversionBinder = createFilenameBinder({
	            THREE,
	            geomSuffixes: ['panel'],
	            guessKindFromName: () => 'base',
	            findGeomSuffix: (label) => (String(label || '').toLowerCase().includes('panel') ? 'panel' : null),
	            textureLoader: { load: () => new THREE.Texture() },
	            toStandard,
	            copyTextureSettings: () => {},
	        });
	        conversionBinder.autoBindByNamesForModel(convertRoot, 'model.fbx', [
	            { short: 'T_panel_d_1.png', full: 'T_panel_d_1.png', url: 'blob:panel-new' },
	        ]);
	        const filenameConvertedMaterialAfterBind = filenameConvertedMaterialDisposed();
	        const filenameConvertedTextureAfterBind = filenameConvertedTextureDisposed();

	        const filenameDeferred = createDeferredTextureLoader();
	        let filenameRenderCount = 0;
	        const filenameRenderRoot = new THREE.Group();
	        const filenameRenderSourceColor = new THREE.Color(0.62, 0.27, 0.13);
	        const filenameRenderMesh = new THREE.Mesh(
	            new THREE.BoxGeometry(1, 1, 1),
	            new THREE.MeshStandardMaterial({ name: 'render wall', color: filenameRenderSourceColor.clone() })
	        );
	        filenameRenderMesh.name = 'mesh_wall';
	        filenameRenderRoot.add(filenameRenderMesh);
	        const filenameRenderBinder = createFilenameBinder({
	            THREE,
	            geomSuffixes: ['wall'],
	            guessKindFromName: () => 'base',
	            findGeomSuffix: (label) => (String(label || '').toLowerCase().includes('wall') ? 'wall' : null),
	            textureLoader: filenameDeferred.loader,
	            toStandard: (material) => material,
	            copyTextureSettings: () => {},
	            requestRender: () => { filenameRenderCount += 1; },
	        });
	        filenameRenderBinder.autoBindByNamesForModel(filenameRenderRoot, 'model.fbx', [
	            { short: 'T_wall_d_1.png', full: 'T_wall_d_1.png', url: 'blob:filename-render' },
	        ]);
	        const filenameRenderColorNeutralized = filenameRenderMesh.material.color.equals(texturedBaseColor);
	        const filenameRenderSourceColorStored = getMaterialSourceBaseColor(filenameRenderMesh.material)?.equals(filenameRenderSourceColor) === true;
	        const filenameRenderBeforeLoad = filenameRenderCount;
	        filenameDeferred.loads[0].onLoad?.(filenameDeferred.loads[0].texture);
	        const filenameRenderAfterLoad = filenameRenderCount;

	        const filenameStaleDeferred = createDeferredTextureLoader();
	        let filenameStaleRenderCount = 0;
	        let filenameRootLive = true;
	        const filenameStaleRoot = new THREE.Group();
	        const filenameStaleMesh = new THREE.Mesh(
	            new THREE.BoxGeometry(1, 1, 1),
	            new THREE.MeshStandardMaterial({ name: 'stale wall' })
	        );
	        filenameStaleMesh.name = 'mesh_wall';
	        filenameStaleRoot.add(filenameStaleMesh);
	        const filenameStaleBinder = createFilenameBinder({
	            THREE,
	            geomSuffixes: ['wall'],
	            guessKindFromName: () => 'base',
	            findGeomSuffix: (label) => (String(label || '').toLowerCase().includes('wall') ? 'wall' : null),
	            textureLoader: filenameStaleDeferred.loader,
	            toStandard: (material) => material,
	            copyTextureSettings: () => {},
	            requestRender: () => { filenameStaleRenderCount += 1; },
	            isRootLive: () => filenameRootLive,
	        });
	        filenameStaleBinder.autoBindByNamesForModel(filenameStaleRoot, 'model.fbx', [
	            { short: 'T_wall_d_1.png', full: 'T_wall_d_1.png', url: 'blob:filename-stale' },
	        ]);
	        const filenameStaleDisposed = trackDispose(filenameStaleDeferred.loads[0].texture);
	        filenameRootLive = false;
	        filenameStaleDeferred.loads[0].onLoad?.(filenameStaleDeferred.loads[0].texture);

	        const filenameShadingOldTexture = new THREE.Texture();
	        filenameShadingOldTexture.name = 'filename-shading-old';
	        const filenameShadingOldTextureDisposed = trackDispose(filenameShadingOldTexture);
	        const filenameShadingOriginalMaterial = new THREE.MeshStandardMaterial({
	            name: 'wall material',
	            map: filenameShadingOldTexture,
	        });
	        const filenameShadingGeneratedMaterial = new THREE.MeshBasicMaterial({ name: 'display material' });
	        filenameShadingGeneratedMaterial.userData.viewerGeneratedMaterial = 'shading-variant';
	        const filenameShadingRoot = new THREE.Group();
	        const filenameShadingMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), filenameShadingGeneratedMaterial);
	        filenameShadingMesh.name = 'mesh_wall';
	        filenameShadingMesh.userData._origMaterial = filenameShadingOriginalMaterial;
	        filenameShadingRoot.add(filenameShadingMesh);
	        let filenameShadingCacheCalls = 0;
	        const filenameShadingBinder = createFilenameBinder({
	            THREE,
	            geomSuffixes: ['wall'],
	            guessKindFromName: () => 'base',
	            findGeomSuffix: (label) => (String(label || '').toLowerCase().includes('wall') ? 'wall' : null),
	            textureLoader: { load: () => new THREE.Texture() },
	            toStandard: (material) => material,
	            copyTextureSettings: () => {},
	            cacheOriginalMaterialFor: () => { filenameShadingCacheCalls += 1; },
	        });
	        filenameShadingBinder.autoBindByNamesForModel(filenameShadingRoot, 'model.fbx', [
	            { short: 'T_wall_d_1.png', full: 'T_wall_d_1.png', url: 'blob:filename-shading-new' },
	        ]);
	        const filenameShadingVisiblePreserved = filenameShadingMesh.material === filenameShadingGeneratedMaterial;
	        const filenameShadingOriginalUpdated = filenameShadingMesh.userData._origMaterial?.map?.name === 'T_wall_d_1.png';
	        const filenameShadingGeneratedUntouched = !filenameShadingGeneratedMaterial.map;
	        const filenameShadingOldTextureAfterBind = filenameShadingOldTextureDisposed();

        const modalShared = new THREE.Texture();
        modalShared.name = 'modal-shared';
        const modalSharedDisposed = trackDispose(modalShared);
        const modalRoot = new THREE.Group();
        const modalA = new THREE.Mesh(
            new THREE.BoxGeometry(1, 1, 1),
            new THREE.MeshStandardMaterial({ name: 'modal-a', map: modalShared })
        );
        const modalB = new THREE.Mesh(
            new THREE.BoxGeometry(1, 1, 1),
            new THREE.MeshStandardMaterial({ name: 'modal-b', map: modalShared })
        );
        modalRoot.add(modalA, modalB);
	        const loadedModels = [{ obj: modalRoot, name: 'modal.fbx' }];
	        let selectedLink = { obj: modalA, mat: modalA.material, index: 0 };

        const modal = document.createElement('div');
        const closeBtn = document.createElement('button');
        const img = document.createElement('img');
        const title = document.createElement('div');
        const file = document.createElement('div');
        const kind = document.createElement('div');
        const mime = document.createElement('div');
        const dl = document.createElement('a');
        const bind = document.createElement('button');
        const slot = document.createElement('select');
        slot.appendChild(new Option('map', 'map'));
        document.body.append(modal, closeBtn, img, title, file, kind, mime, dl, bind, slot);

        const controller = createTextureModalController({
            texModalEl: modal,
            closeBtnEl: closeBtn,
            imgEl: img,
            titleEl: title,
            fileEl: file,
            kindEl: kind,
            mimeEl: mime,
            downloadLinkEl: dl,
            bindBtnEl: bind,
            slotSelectEl: slot,
            basename: (value) => String(value || '').split('/').pop(),
            guessKindFromName: () => 'base',
            getSelectedMaterialLink: () => selectedLink,
            loadedModels,
            textureLoader: { load: () => new THREE.Texture() },
	            toStandard,
	            copyTextureSettings: () => {},
	        });

        controller.open({ short: 'first.png', full: 'textures/first.png', url: 'blob:first', mime: 'image/png' });
        controller.bindSelected();
        const modalAfterFirstBind = modalSharedDisposed();
        selectedLink = { obj: modalB, mat: modalB.material, index: 0 };
        controller.open({ short: 'second.png', full: 'textures/second.png', url: 'blob:second', mime: 'image/png' });
	        controller.bindSelected();
	        const modalAfterSecondBind = modalSharedDisposed();

	        const modalConvertedTexture = new THREE.Texture();
	        modalConvertedTexture.name = 'modal-converted';
	        const modalConvertedTextureDisposed = trackDispose(modalConvertedTexture);
	        const modalConvertedMaterial = new THREE.MeshBasicMaterial({
	            name: 'modal panel',
	            map: modalConvertedTexture,
	        });
	        const modalConvertedMaterialDisposed = trackDispose(modalConvertedMaterial);
	        const modalConvertedRoot = new THREE.Group();
	        const modalConvertedMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), modalConvertedMaterial);
	        modalConvertedRoot.add(modalConvertedMesh);
	        loadedModels.push({ obj: modalConvertedRoot, name: 'modal-converted.fbx' });
	        selectedLink = { obj: modalConvertedMesh, mat: modalConvertedMesh.material, index: 0 };
	        controller.open({ short: 'converted.png', full: 'textures/converted.png', url: 'blob:converted', mime: 'image/png' });
	        controller.bindSelected();
	        const modalConvertedMaterialAfterBind = modalConvertedMaterialDisposed();
	        const modalConvertedTextureAfterBind = modalConvertedTextureDisposed();

	        const modalShadingOldTexture = new THREE.Texture();
	        modalShadingOldTexture.name = 'modal-shading-old';
	        const modalShadingOldTextureDisposed = trackDispose(modalShadingOldTexture);
	        const modalShadingOriginalMaterial = new THREE.MeshStandardMaterial({
	            name: 'modal-shading-original',
	            map: modalShadingOldTexture,
	        });
	        const modalShadingGeneratedMaterial = new THREE.MeshBasicMaterial({ name: 'modal-shading-generated' });
	        modalShadingGeneratedMaterial.userData.viewerGeneratedMaterial = 'shading-variant';
	        const modalShadingRoot = new THREE.Group();
	        const modalShadingMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), modalShadingGeneratedMaterial);
	        modalShadingMesh.userData._origMaterial = modalShadingOriginalMaterial;
	        modalShadingRoot.add(modalShadingMesh);
	        loadedModels.push({ obj: modalShadingRoot, name: 'modal-shading.fbx' });
	        const modalShadingSelect = document.createElement('select');
	        modalShadingSelect.appendChild(new Option('original', '0'));
	        modalShadingSelect.value = '0';
	        modalShadingSelect.dataset._map = JSON.stringify([{ idx: 0, path: `${modalShadingMesh.uuid}:0` }]);
	        const modalShadingResolver = createSelectedMaterialLinkResolver({
	            matSelectEl: modalShadingSelect,
	            world: modalShadingRoot,
	        });
	        selectedLink = modalShadingResolver();
	        controller.open({ short: 'shading.png', full: 'textures/shading.png', url: 'blob:shading', mime: 'image/png' });
	        controller.bindSelected();
	        const modalShadingResolverSource = selectedLink?.source || '';
	        const modalShadingVisiblePreserved = modalShadingMesh.material === modalShadingGeneratedMaterial;
	        const modalShadingOriginalUpdated = modalShadingMesh.userData._origMaterial?.map?.name === 'shading.png';
	        const modalShadingGeneratedUntouched = !modalShadingGeneratedMaterial.map;
	        const modalShadingOldTextureAfterBind = modalShadingOldTextureDisposed();
	        controller.dispose();

	        const modalDeferred = createDeferredTextureLoader();
	        let modalRenderCount = 0;
	        const modalRenderRoot = new THREE.Group();
	        const modalRenderSourceColor = new THREE.Color(0.19, 0.41, 0.68);
	        const modalRenderMesh = new THREE.Mesh(
	            new THREE.BoxGeometry(1, 1, 1),
	            new THREE.MeshStandardMaterial({ name: 'modal-render', color: modalRenderSourceColor.clone() })
	        );
	        modalRenderRoot.add(modalRenderMesh);
	        const modalRenderLoadedModels = [{ obj: modalRenderRoot, name: 'modal-render.fbx' }];
	        const modalRenderController = createTextureModalController({
	            slotSelectEl: slot,
	            basename: (value) => String(value || '').split('/').pop(),
	            guessKindFromName: () => 'base',
	            getSelectedMaterialLink: () => ({ obj: modalRenderMesh, mat: modalRenderMesh.material, index: 0 }),
	            loadedModels: modalRenderLoadedModels,
	            textureLoader: modalDeferred.loader,
	            toStandard,
	            copyTextureSettings: () => {},
	            requestRender: () => { modalRenderCount += 1; },
	        });
	        modalRenderController.open({ short: 'render.png', full: 'textures/render.png', url: 'blob:modal-render', mime: 'image/png' });
	        modalRenderController.bindSelected();
	        const modalRenderColorNeutralized = modalRenderMesh.material.color.equals(texturedBaseColor);
	        const modalRenderSourceColorStored = getMaterialSourceBaseColor(modalRenderMesh.material)?.equals(modalRenderSourceColor) === true;
	        const modalRenderBeforeLoad = modalRenderCount;
	        modalDeferred.loads[0].onLoad?.(modalDeferred.loads[0].texture);
	        const modalRenderAfterLoad = modalRenderCount;
	        modalRenderController.dispose();

	        const modalStaleDeferred = createDeferredTextureLoader();
	        let modalStaleRenderCount = 0;
	        const modalStaleRoot = new THREE.Group();
	        const modalStaleMesh = new THREE.Mesh(
	            new THREE.BoxGeometry(1, 1, 1),
	            new THREE.MeshStandardMaterial({ name: 'modal-stale' })
	        );
	        modalStaleRoot.add(modalStaleMesh);
	        const modalStaleLoadedModels = [{ obj: modalStaleRoot, name: 'modal-stale.fbx' }];
	        const modalStaleController = createTextureModalController({
	            slotSelectEl: slot,
	            basename: (value) => String(value || '').split('/').pop(),
	            guessKindFromName: () => 'base',
	            getSelectedMaterialLink: () => ({ obj: modalStaleMesh, mat: modalStaleMesh.material, index: 0 }),
	            loadedModels: modalStaleLoadedModels,
	            textureLoader: modalStaleDeferred.loader,
	            toStandard,
	            copyTextureSettings: () => {},
	            requestRender: () => { modalStaleRenderCount += 1; },
	        });
	        modalStaleController.open({ short: 'stale.png', full: 'textures/stale.png', url: 'blob:modal-stale', mime: 'image/png' });
	        modalStaleController.bindSelected();
	        const modalStaleDisposed = trackDispose(modalStaleDeferred.loads[0].texture);
	        modalStaleLoadedModels.length = 0;
	        modalStaleDeferred.loads[0].onLoad?.(modalStaleDeferred.loads[0].texture);
	        modalStaleController.dispose();

	        const vpmOldTexture = new THREE.Texture();
	        vpmOldTexture.name = 'vpm-old';
	        const vpmOldTextureDisposed = trackDispose(vpmOldTexture);
	        const vpmOldMaterial = new THREE.MeshStandardMaterial({ name: 'vpm old', map: vpmOldTexture });
	        const vpmOldMaterialDisposed = trackDispose(vpmOldMaterial);
	        const vpmMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), vpmOldMaterial);
	        vpmMesh.name = 'vpm_mesh';
	        const vpmRoot = new THREE.Group();
	        vpmRoot.userData._fbxFileName = 'SM_foo_bar.fbx';
	        vpmRoot.add(vpmMesh);
	        const vpmLoadedModels = [{ obj: vpmRoot, name: 'SM_foo_bar.fbx', zipKind: 'SM' }];
	        const labels = new Map([['blob:vpm-diffuse', 'T_foo_bar_Diffuse_1.1001.png']]);
	        const vpmBinder = createVPMBinder({
	            THREE,
	            loadedModels: vpmLoadedModels,
	            labelFromURL: (url) => labels.get(url) || '',
	            toStandard,
	            textureLoader: { load: () => new THREE.Texture() },
	            detectSlotFromMatOrObj: () => 1,
	            copyTextureSettings: () => {},
	        });
	        const vpmIndex = vpmBinder.buildVPMIndex([{ url: 'blob:vpm-diffuse' }]);
	        await vpmBinder.autoBindVPMForModel(vpmRoot, vpmIndex);
	        const vpmOldMaterialAfterBind = vpmOldMaterialDisposed();
	        const vpmOldTextureAfterBind = vpmOldTextureDisposed();

	        const vpmShadingOldTexture = new THREE.Texture();
	        vpmShadingOldTexture.name = 'vpm-shading-old';
	        const vpmShadingOldTextureDisposed = trackDispose(vpmShadingOldTexture);
	        const vpmShadingOldMaterial = new THREE.MeshStandardMaterial({
	            name: 'vpm shading old',
	            map: vpmShadingOldTexture,
	        });
	        const vpmShadingOldMaterialDisposed = trackDispose(vpmShadingOldMaterial);
	        const vpmShadingGeneratedMaterial = new THREE.MeshBasicMaterial({ name: 'vpm generated display' });
	        vpmShadingGeneratedMaterial.userData.viewerGeneratedMaterial = 'shading-variant';
	        const vpmShadingMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), vpmShadingGeneratedMaterial);
	        vpmShadingMesh.name = 'vpm_shading_mesh';
	        vpmShadingMesh.userData._origMaterial = vpmShadingOldMaterial;
	        const vpmShadingRoot = new THREE.Group();
	        vpmShadingRoot.userData._fbxFileName = 'SM_shading_case.fbx';
	        vpmShadingRoot.add(vpmShadingMesh);
	        const vpmShadingLoadedModels = [{ obj: vpmShadingRoot, name: 'SM_shading_case.fbx', zipKind: 'SM' }];
	        const shadingLabels = new Map([['blob:vpm-shading-diffuse', 'T_shading_case_Diffuse_1.1001.png']]);
	        let vpmShadingCacheCalls = 0;
	        const vpmShadingBinder = createVPMBinder({
	            THREE,
	            loadedModels: vpmShadingLoadedModels,
	            labelFromURL: (url) => shadingLabels.get(url) || '',
	            toStandard,
	            textureLoader: { load: () => new THREE.Texture() },
	            detectSlotFromMatOrObj: () => 1,
	            copyTextureSettings: () => {},
	            cacheOriginalMaterialFor: () => { vpmShadingCacheCalls += 1; },
	        });
	        const vpmShadingIndex = vpmShadingBinder.buildVPMIndex([{ url: 'blob:vpm-shading-diffuse' }]);
	        await vpmShadingBinder.autoBindVPMForModel(vpmShadingRoot, vpmShadingIndex);
	        const vpmShadingVisiblePreserved = vpmShadingMesh.material === vpmShadingGeneratedMaterial;
	        const vpmShadingOriginalUpdated = vpmShadingMesh.userData._origMaterial?.map?.name === 'T_shading_case_Diffuse_1.1001.png';
	        const vpmShadingGeneratedUntouched = !vpmShadingGeneratedMaterial.map;
	        const vpmShadingOldMaterialAfterBind = vpmShadingOldMaterialDisposed();
	        const vpmShadingOldTextureAfterBind = vpmShadingOldTextureDisposed();

	        const vpmDeferred = createDeferredTextureLoader();
	        let vpmRenderCount = 0;
	        const vpmRenderSourceColor = new THREE.Color(0.28, 0.57, 0.16);
	        const vpmRenderMesh = new THREE.Mesh(
	            new THREE.BoxGeometry(1, 1, 1),
	            new THREE.MeshStandardMaterial({ name: 'vpm render', color: vpmRenderSourceColor.clone() })
	        );
	        vpmRenderMesh.name = 'vpm_render_mesh';
	        const vpmRenderRoot = new THREE.Group();
	        vpmRenderRoot.userData._fbxFileName = 'SM_render_case.fbx';
	        vpmRenderRoot.add(vpmRenderMesh);
	        const vpmRenderLoadedModels = [{ obj: vpmRenderRoot, name: 'SM_render_case.fbx', zipKind: 'SM' }];
	        const renderLabels = new Map([['blob:vpm-render-diffuse', 'T_render_case_Diffuse_1.1001.png']]);
	        const vpmRenderBinder = createVPMBinder({
	            THREE,
	            loadedModels: vpmRenderLoadedModels,
	            labelFromURL: (url) => renderLabels.get(url) || '',
	            toStandard,
	            textureLoader: vpmDeferred.loader,
	            detectSlotFromMatOrObj: () => 1,
	            copyTextureSettings: () => {},
	            requestRender: () => { vpmRenderCount += 1; },
	        });
	        const vpmRenderIndex = vpmRenderBinder.buildVPMIndex([{ url: 'blob:vpm-render-diffuse' }]);
	        await vpmRenderBinder.autoBindVPMForModel(vpmRenderRoot, vpmRenderIndex);
	        const vpmRenderColorNeutralized = vpmRenderMesh.material.color.equals(texturedBaseColor);
	        const vpmRenderSourceColorStored = getMaterialSourceBaseColor(vpmRenderMesh.material)?.equals(vpmRenderSourceColor) === true;
	        const vpmRenderAfterBind = vpmRenderCount;
	        vpmDeferred.loads[0].onLoad?.(vpmDeferred.loads[0].texture);
	        const vpmRenderAfterLoad = vpmRenderCount;

	        const vpmStaleDeferred = createDeferredTextureLoader();
	        let vpmStaleRenderCount = 0;
	        const vpmStaleMesh = new THREE.Mesh(
	            new THREE.BoxGeometry(1, 1, 1),
	            new THREE.MeshStandardMaterial({ name: 'vpm stale' })
	        );
	        vpmStaleMesh.name = 'vpm_stale_mesh';
	        const vpmStaleRoot = new THREE.Group();
	        vpmStaleRoot.userData._fbxFileName = 'SM_stale_case.fbx';
	        vpmStaleRoot.add(vpmStaleMesh);
	        const vpmStaleLoadedModels = [{ obj: vpmStaleRoot, name: 'SM_stale_case.fbx', zipKind: 'SM' }];
	        const staleLabels = new Map([['blob:vpm-stale-diffuse', 'T_stale_case_Diffuse_1.1001.png']]);
	        const vpmStaleBinder = createVPMBinder({
	            THREE,
	            loadedModels: vpmStaleLoadedModels,
	            labelFromURL: (url) => staleLabels.get(url) || '',
	            toStandard,
	            textureLoader: vpmStaleDeferred.loader,
	            detectSlotFromMatOrObj: () => 1,
	            copyTextureSettings: () => {},
	            requestRender: () => { vpmStaleRenderCount += 1; },
	        });
	        const vpmStaleIndex = vpmStaleBinder.buildVPMIndex([{ url: 'blob:vpm-stale-diffuse' }]);
	        await vpmStaleBinder.autoBindVPMForModel(vpmStaleRoot, vpmStaleIndex);
	        const vpmStaleRenderAfterBind = vpmStaleRenderCount;
	        const vpmStaleDisposed = trackDispose(vpmStaleDeferred.loads[0].texture);
	        vpmStaleLoadedModels.length = 0;
	        vpmStaleDeferred.loads[0].onLoad?.(vpmStaleDeferred.loads[0].texture);

	        const nativeMaterialDispose = THREE.Material.prototype.dispose;
	        const nativeFetch = globalThis.fetch;
	        const vpmFailureDisposedMaterials = [];
	        THREE.Material.prototype.dispose = function patchedFailureMaterialDispose(...args) {
	            vpmFailureDisposedMaterials.push(this.name || this.type || 'material');
	            return nativeMaterialDispose.apply(this, args);
	        };
	        const vpmFailureDisposedTextures = [];
	        let vpmFailureResult = '';
	        let vpmFailureMaterialStillOriginal = false;
	        try {
	            globalThis.fetch = async () => {
	                throw new Error('ERM fetch failed');
	            };
	            const vpmFailureOldTexture = new THREE.Texture();
	            vpmFailureOldTexture.name = 'vpm-failure-old';
	            const vpmFailureOldMaterial = new THREE.MeshStandardMaterial({
	                name: 'vpm failure old',
	                map: vpmFailureOldTexture,
	            });
	            const vpmFailureMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), vpmFailureOldMaterial);
	            vpmFailureMesh.name = 'vpm_failure_mesh';
	            const vpmFailureRoot = new THREE.Group();
	            vpmFailureRoot.userData._fbxFileName = 'SM_fail_case.fbx';
	            vpmFailureRoot.add(vpmFailureMesh);
	            const vpmFailureLoadedModels = [{ obj: vpmFailureRoot, name: 'SM_fail_case.fbx', zipKind: 'SM' }];
	            const failureLabels = new Map([
	                ['blob:vpm-failure-diffuse', 'T_fail_case_Diffuse_1.1001.png'],
	                ['blob:vpm-failure-normal', 'T_fail_case_Normal_1.1001.png'],
	                ['blob:vpm-failure-erm', 'T_fail_case_ERM_1.1001.png'],
	            ]);
	            const vpmFailureBinder = createVPMBinder({
	                THREE,
	                loadedModels: vpmFailureLoadedModels,
	                labelFromURL: (url) => failureLabels.get(url) || '',
	                toStandard,
	                textureLoader: {
	                    load: (url) => {
	                        const texture = new THREE.Texture();
	                        texture.name = failureLabels.get(url) || url;
	                        texture.addEventListener('dispose', () => {
	                            vpmFailureDisposedTextures.push(texture.name);
	                        });
	                        return texture;
	                    },
	                },
	                detectSlotFromMatOrObj: () => 1,
	                copyTextureSettings: () => {},
	            });
	            const vpmFailureIndex = vpmFailureBinder.buildVPMIndex([
	                { url: 'blob:vpm-failure-diffuse' },
	                { url: 'blob:vpm-failure-normal' },
	                { url: 'blob:vpm-failure-erm' },
	            ]);
	            vpmFailureResult = await vpmFailureBinder.autoBindVPMForModel(vpmFailureRoot, vpmFailureIndex).then(
	                () => 'resolved',
	                (err) => err?.message || String(err),
	            );
	            vpmFailureMaterialStillOriginal = vpmFailureMesh.material === vpmFailureOldMaterial;
	        } finally {
	            THREE.Material.prototype.dispose = nativeMaterialDispose;
	            globalThis.fetch = nativeFetch;
	        }

	        return {
	            filenameAfterFirstBind,
	            filenameAfterSecondBind,
	            filenameConvertedMaterialAfterBind,
	            filenameConvertedTextureAfterBind,
	            filenameRenderBeforeLoad,
	            filenameRenderAfterLoad,
	            filenameRenderColorNeutralized,
	            filenameRenderSourceColorStored,
	            filenameStaleRenderCount,
	            filenameStaleDisposed: filenameStaleDisposed(),
	            filenameShadingVisiblePreserved,
	            filenameShadingOriginalUpdated,
	            filenameShadingGeneratedUntouched,
	            filenameShadingOldTextureAfterBind,
	            filenameShadingCacheCalls,
	            modalAfterFirstBind,
	            modalAfterSecondBind,
	            modalConvertedMaterialAfterBind,
	            modalConvertedTextureAfterBind,
	            modalShadingResolverSource,
	            modalShadingVisiblePreserved,
	            modalShadingOriginalUpdated,
	            modalShadingGeneratedUntouched,
	            modalShadingOldTextureAfterBind,
	            modalRenderBeforeLoad,
	            modalRenderAfterLoad,
	            modalRenderColorNeutralized,
	            modalRenderSourceColorStored,
	            modalStaleRenderCount,
	            modalStaleDisposed: modalStaleDisposed(),
	            vpmOldMaterialAfterBind,
	            vpmOldTextureAfterBind,
	            vpmShadingVisiblePreserved,
	            vpmShadingOriginalUpdated,
	            vpmShadingGeneratedUntouched,
	            vpmShadingOldMaterialAfterBind,
	            vpmShadingOldTextureAfterBind,
	            vpmShadingCacheCalls,
	            vpmRenderAfterBind,
	            vpmRenderAfterLoad,
	            vpmRenderColorNeutralized,
	            vpmRenderSourceColorStored,
	            vpmStaleRenderAfterBind,
	            vpmStaleRenderAfterLoad: vpmStaleRenderCount,
	            vpmStaleDisposed: vpmStaleDisposed(),
	            vpmFailureResult,
	            vpmFailureMaterialStillOriginal,
	            vpmFailureDisposedTextures,
	            vpmFailureDisposedMaterials,
	        };
	    });

	    assert.equal(result.filenameAfterFirstBind, 0, 'Texture replacement smoke: filename binder disposed texture still used by another mesh');
	    assert.equal(result.filenameAfterSecondBind, 1, 'Texture replacement smoke: filename binder did not dispose texture after last reference was replaced');
	    assert.equal(result.filenameConvertedMaterialAfterBind, 1, 'Texture replacement smoke: filename binder leaked converted source material');
	    assert.equal(result.filenameConvertedTextureAfterBind, 1, 'Texture replacement smoke: filename binder leaked converted source texture');
	    assert.equal(result.filenameRenderBeforeLoad, 0, 'Texture replacement smoke: filename binder requested render before image decode');
	    assert.equal(result.filenameRenderAfterLoad, 1, 'Texture replacement smoke: filename binder did not request render after image decode');
	    assert.equal(result.filenameRenderColorNeutralized, true, 'Texture replacement smoke: filename binder retained material tint on base map');
	    assert.equal(result.filenameRenderSourceColorStored, true, 'Texture replacement smoke: filename binder lost the original material color');
	    assert.equal(result.filenameStaleRenderCount, 0, 'Texture replacement smoke: stale filename texture requested render after model removal');
	    assert.equal(result.filenameStaleDisposed, 1, 'Texture replacement smoke: stale filename texture was not disposed after late decode');
	    assert.equal(result.filenameShadingVisiblePreserved, true, 'Texture replacement smoke: filename binder replaced visible shading material');
	    assert.equal(result.filenameShadingOriginalUpdated, true, 'Texture replacement smoke: filename binder did not update original material under shading mode');
	    assert.equal(result.filenameShadingGeneratedUntouched, true, 'Texture replacement smoke: filename binder bound texture to generated shading material');
	    assert.equal(result.filenameShadingOldTextureAfterBind, 1, 'Texture replacement smoke: filename binder leaked replaced original texture under shading mode');
	    assert.equal(result.filenameShadingCacheCalls, 1, 'Texture replacement smoke: filename binder did not invalidate original material cache under shading mode');
	    assert.equal(result.modalAfterFirstBind, 0, 'Texture replacement smoke: texture modal disposed texture still used by another mesh');
	    assert.equal(result.modalAfterSecondBind, 1, 'Texture replacement smoke: texture modal did not dispose texture after last reference was replaced');
	    assert.equal(result.modalConvertedMaterialAfterBind, 1, 'Texture replacement smoke: texture modal leaked converted source material');
	    assert.equal(result.modalConvertedTextureAfterBind, 1, 'Texture replacement smoke: texture modal leaked converted source texture');
	    assert.equal(result.modalShadingResolverSource, 'original', 'Texture replacement smoke: texture modal did not resolve original material while shading variant was visible');
	    assert.equal(result.modalShadingVisiblePreserved, true, 'Texture replacement smoke: texture modal replaced visible shading material');
	    assert.equal(result.modalShadingOriginalUpdated, true, 'Texture replacement smoke: texture modal did not update original material under shading mode');
	    assert.equal(result.modalShadingGeneratedUntouched, true, 'Texture replacement smoke: texture modal bound texture to generated shading material');
	    assert.equal(result.modalShadingOldTextureAfterBind, 1, 'Texture replacement smoke: texture modal leaked replaced original texture under shading mode');
	    assert.equal(result.modalRenderBeforeLoad, 0, 'Texture replacement smoke: texture modal requested render before image decode');
	    assert.equal(result.modalRenderAfterLoad, 1, 'Texture replacement smoke: texture modal did not request render after image decode');
	    assert.equal(result.modalRenderColorNeutralized, true, 'Texture replacement smoke: texture modal retained material tint on base map');
	    assert.equal(result.modalRenderSourceColorStored, true, 'Texture replacement smoke: texture modal lost the original material color');
	    assert.equal(result.modalStaleRenderCount, 0, 'Texture replacement smoke: stale modal texture requested render after model removal');
	    assert.equal(result.modalStaleDisposed, 1, 'Texture replacement smoke: stale modal texture was not disposed after late decode');
	    assert.equal(result.vpmOldMaterialAfterBind, 1, 'Texture replacement smoke: VPM bind leaked replaced source material');
	    assert.equal(result.vpmOldTextureAfterBind, 1, 'Texture replacement smoke: VPM bind leaked replaced source texture');
	    assert.equal(result.vpmShadingVisiblePreserved, true, 'Texture replacement smoke: VPM bind replaced visible shading material');
	    assert.equal(result.vpmShadingOriginalUpdated, true, 'Texture replacement smoke: VPM bind did not update original material under shading mode');
	    assert.equal(result.vpmShadingGeneratedUntouched, true, 'Texture replacement smoke: VPM bind bound texture to generated shading material');
	    assert.equal(result.vpmShadingOldMaterialAfterBind, 1, 'Texture replacement smoke: VPM bind leaked replaced original material under shading mode');
	    assert.equal(result.vpmShadingOldTextureAfterBind, 1, 'Texture replacement smoke: VPM bind leaked replaced original texture under shading mode');
	    assert.equal(result.vpmShadingCacheCalls, 1, 'Texture replacement smoke: VPM bind did not invalidate original material cache under shading mode');
	    assert.equal(result.vpmRenderAfterBind, 1, 'Texture replacement smoke: VPM bind did not request initial render');
	    assert.equal(result.vpmRenderAfterLoad, 2, 'Texture replacement smoke: VPM bind did not request render after diffuse decode');
	    assert.equal(result.vpmRenderColorNeutralized, true, 'Texture replacement smoke: VPM bind retained material tint on diffuse map');
	    assert.equal(result.vpmRenderSourceColorStored, true, 'Texture replacement smoke: VPM bind lost the original material color');
	    assert.equal(result.vpmStaleRenderAfterLoad, result.vpmStaleRenderAfterBind, 'Texture replacement smoke: stale VPM texture requested render after model removal');
	    assert.equal(result.vpmStaleDisposed, 1, 'Texture replacement smoke: stale VPM texture was not disposed after late decode');
	    assert.equal(result.vpmFailureResult, 'resolved', 'Texture replacement smoke: VPM ERM failure rejected whole bind');
	    assert.equal(result.vpmFailureMaterialStillOriginal, true, 'Texture replacement smoke: VPM ERM failure replaced mesh material');
	    assert.deepEqual(result.vpmFailureDisposedTextures.sort(), [
	        'T_fail_case_Diffuse_1.1001.png',
	        'T_fail_case_Normal_1.1001.png',
	    ].sort(), 'Texture replacement smoke: VPM ERM failure leaked loaded textures');
	    assert.ok(
	        result.vpmFailureDisposedMaterials.includes('vpm failure old')
	            && result.vpmFailureDisposedMaterials.includes('MeshDepthMaterial')
	            && result.vpmFailureDisposedMaterials.includes('MeshDistanceMaterial'),
	        'Texture replacement smoke: VPM ERM failure leaked temp or shadow materials',
	    );
    diagnostics.assertNoErrors('Texture replacement lifecycle smoke');
    await page.close();
}

async function runGlassGeneratedDisplayMaterialSmoke(browser, baseUrl) {
    const page = await browser.newPage();
    const diagnostics = attachPageDiagnostics(page);
    await page.goto(`${baseUrl}/__smoke_blank`, { waitUntil: 'domcontentloaded', timeout: 15000 });

    const result = await page.evaluate(async () => {
        const THREE = await import('three');
        const { createGlassController } = await import('/scripts/modules/material/glass-controller.js');
        const { createToStandard } = await import('/scripts/modules/material/to-standard.js');
        const { createGlassOverridesController } = await import('/scripts/modules/ui/glass-overrides.js');
        const { createMaterialsPanelController } = await import('/scripts/modules/ui/materials-panel.js');

        const makeRange = (value, min = 0, max = 1, step = 0.01) => {
            const input = document.createElement('input');
            input.type = 'range';
            input.min = String(min);
            input.max = String(max);
            input.step = String(step);
            input.value = String(value);
            return input;
        };

        const world = new THREE.Group();
        const scene = new THREE.Scene();
        const originalMaterial = new THREE.MeshPhysicalMaterial({
            name: 'mainglass window',
            transparent: true,
            opacity: 0.88,
            roughness: 0.2,
            metalness: 0.05,
            transmission: 0.15,
            color: 0xffffff,
        });
        const generatedMaterial = new THREE.MeshBasicMaterial({
            name: 'mainglass display variant',
            opacity: 1,
        });
        generatedMaterial.userData.viewerGeneratedMaterial = 'shading-variant';
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), generatedMaterial);
        mesh.name = 'displayed mainglass mesh';
        mesh.userData._origMaterial = originalMaterial;
        world.add(mesh);

        const panel = createMaterialsPanelController({
            world,
            loadedModels: [],
            outEl: document.createElement('div'),
            matSelect: document.createElement('select'),
            requestRender: () => {},
        });
        const panelMaterials = panel.getPanelMaterials(mesh);
        const resolvedBefore = panel.resolveGlassMaterial(mesh.uuid, 0);

        let cacheCalls = 0;
        let renderCalls = 0;
        let panelRefreshCalls = 0;
        const glassOpacityEl = makeRange(0.42);
        glassOpacityEl.dataset.userSet = '1';
        const glassController = createGlassController({
            THREE,
            world,
            scene,
            toStandard: createToStandard(),
            cacheOriginalMaterialFor: () => { cacheCalls += 1; },
            requestRender: () => { renderCalls += 1; },
            schedulePanelRefresh: () => { panelRefreshCalls += 1; },
            elements: {
                glassOpacityEl,
                glassIorEl: makeRange(1.5, 1, 4),
                glassTransmissionEl: makeRange(1),
                glassReflectEl: makeRange(1, 0, 5, 0.05),
                glassRoughEl: makeRange(0.05),
                glassMetalEl: makeRange(0.05),
                glassAttenDistEl: makeRange(0.2, 0, 5),
                glassAttenColorEl: (() => {
                    const input = document.createElement('input');
                    input.type = 'color';
                    input.value = '#ffffff';
                    return input;
                })(),
                glassColorEl: (() => {
                    const input = document.createElement('input');
                    input.type = 'color';
                    input.value = '#ffffff';
                    return input;
                })(),
            },
        });

        glassController.applyToScene();
        const originalAfterApply = mesh.userData._origMaterial;
        const originalOpacityAfterApply = originalAfterApply?.opacity;

        const glassOverrides = createGlassOverridesController({
            resolveGlassMaterial: (uuid, matIndex) => panel.resolveGlassMaterial(uuid, matIndex),
            applyGlassControlsToScene: () => glassController.applyToScene(),
            requestRender: () => { renderCalls += 1; },
        });
        const roughnessInput = makeRange(0.77);
        roughnessInput.dataset.prop = 'roughness';
        roughnessInput.dataset.uuid = mesh.uuid;
        roughnessInput.dataset.matIndex = '0';
        glassOverrides.handleGlassSliderInput({ currentTarget: roughnessInput });
        const originalAfterOverride = mesh.userData._origMaterial;
        const originalRoughnessAfterOverride = originalAfterOverride?.roughness;
        const originalOverrideRoughness = originalAfterOverride?.userData?.glassOverrides?.roughness;

        glassController.resetToOriginal();
        const originalAfterReset = mesh.userData._origMaterial;
        const originalRoughnessAfterReset = originalAfterReset?.roughness;
        const overridesClearedAfterReset = !originalAfterReset?.userData?.glassOverrides;

        glassController.dispose();
        panel.dispose();

        return {
            panelUsesOriginal: panelMaterials[0] === originalMaterial,
            resolverSource: resolvedBefore?.source || '',
            resolverUsesOriginal: resolvedBefore?.mat === originalMaterial,
            visibleMaterialPreservedAfterApply: mesh.material === generatedMaterial,
            visibleMaterialPreservedAfterOverride: mesh.material === generatedMaterial,
            visibleMaterialPreservedAfterReset: mesh.material === generatedMaterial,
            generatedUntouched: generatedMaterial.opacity === 1
                && !generatedMaterial.userData.glassInfo
                && !generatedMaterial.userData.glassOverrides,
            originalOpacityAfterApply,
            originalRoughnessAfterOverride,
            originalOverrideRoughness,
            originalRoughnessAfterReset,
            overridesClearedAfterReset,
            cacheCalls,
            renderCalls,
            panelRefreshCalls,
        };
    });

    assert.equal(result.panelUsesOriginal, true, 'Glass generated material smoke: panel did not expose original material under shading mode');
    assert.equal(result.resolverSource, 'original', 'Glass generated material smoke: glass resolver did not select original material under shading mode');
    assert.equal(result.resolverUsesOriginal, true, 'Glass generated material smoke: glass resolver returned generated material');
    assert.equal(result.visibleMaterialPreservedAfterApply, true, 'Glass generated material smoke: global glass apply replaced visible shading material');
    assert.equal(result.visibleMaterialPreservedAfterOverride, true, 'Glass generated material smoke: glass override replaced visible shading material');
    assert.equal(result.visibleMaterialPreservedAfterReset, true, 'Glass generated material smoke: reset replaced visible shading material');
    assert.equal(result.generatedUntouched, true, 'Glass generated material smoke: glass controls mutated generated display material');
    assert.ok(Math.abs(result.originalOpacityAfterApply - 0.42) < 0.001, 'Glass generated material smoke: global glass opacity was not applied to original material');
    assert.ok(Math.abs(result.originalRoughnessAfterOverride - 0.77) < 0.001, 'Glass generated material smoke: override roughness was not applied to original material');
    assert.ok(Math.abs(result.originalOverrideRoughness - 0.77) < 0.001, 'Glass generated material smoke: override state was not stored on original material');
    assert.ok(Math.abs(result.originalRoughnessAfterReset - 0.2) < 0.001, 'Glass generated material smoke: reset did not restore original roughness');
    assert.equal(result.overridesClearedAfterReset, true, 'Glass generated material smoke: reset did not clear original material overrides');
    assert.ok(result.cacheCalls >= 2, 'Glass generated material smoke: original material cache was not invalidated');
    assert.ok(result.renderCalls >= 4, 'Glass generated material smoke: glass changes did not request renders');
    assert.ok(result.panelRefreshCalls >= 1, 'Glass generated material smoke: reset did not schedule panel refresh');
    diagnostics.assertNoErrors('Glass generated display material smoke');
    await page.close();
}

async function runMaterialVisibilityDisplayModeSmoke(browser, baseUrl) {
    const page = await browser.newPage();
    const diagnostics = attachPageDiagnostics(page);
    await page.goto(`${baseUrl}/__smoke_blank`, { waitUntil: 'domcontentloaded', timeout: 15000 });

    const result = await page.evaluate(async () => {
        const THREE = await import('three');
        const { createBackfaceOverlayController } = await import('/scripts/modules/render/backface-overlay.js');
        const { createShadingController } = await import('/scripts/modules/render/shading-controller.js');
        const { createSceneGeometryStats } = await import('/scripts/modules/scene/geometry-stats.js');
        const {
            clearBeautyWire,
            clearWireframeOverlay,
            ensureBeautyWire,
            ensureWireframeOverlay,
        } = await import('/scripts/modules/render/wire-overlays.js');
        const { createVisibilityController } = await import('/scripts/modules/ui/visibility.js');

        let renderRequests = 0;
        let statsDirty = 0;

        const world = new THREE.Group();
        const multiMatA = new THREE.MeshStandardMaterial({ name: 'multi-a' });
        const multiMatB = new THREE.MeshStandardMaterial({ name: 'multi-b' });
        const multiMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), [multiMatA, multiMatB]);
        world.add(multiMesh);

        const singleMat = new THREE.MeshStandardMaterial({ name: 'single' });
        const singleMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), singleMat);
        world.add(singleMesh);

        const visibility = createVisibilityController({
            world,
            loadedModels: [],
            outEl: document.createElement('div'),
            requestRender: () => { renderRequests += 1; },
            markSceneStatsDirty: () => { statsDirty += 1; },
        });
        const shading = createShadingController({
            THREE,
            world,
            scene: new THREE.Scene(),
            clearBeautyWire,
            clearWireframeOverlay,
            ensureBeautyWire,
            ensureWireframeOverlay,
            setBackfaceMode: () => {},
        });

        shading.applyShading('basic');
        const multiGeneratedBeforeToggle = multiMesh.material;
        visibility.toggleObjectVisibility(multiMesh.uuid, 1);
        const multiAfterToggle = {
            originalA: multiMatA.visible,
            originalB: multiMatB.visible,
            generatedA: multiGeneratedBeforeToggle[0]?.visible,
            generatedB: multiGeneratedBeforeToggle[1]?.visible,
            meshVisible: multiMesh.visible,
        };

        shading.applyShading('pbr');
        const multiPbrPreserved = multiMesh.material[1]?.visible === false;
        shading.applyShading('normal');
        const multiGeneratedAfterModeSwitch = multiMesh.material;
        const multiGeneratedPreserved = multiGeneratedAfterModeSwitch[1]?.visible === false;

        visibility.toggleObjectVisibility(singleMesh.uuid, 0);
        const singleAfterToggle = {
            original: singleMat.visible,
            generated: singleMesh.material?.visible,
            meshVisible: singleMesh.visible,
        };
        shading.dispose();

        const beautyWorld = new THREE.Group();
        const beautyMat = new THREE.MeshStandardMaterial({ name: 'beauty-source' });
        const beautyMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), beautyMat);
        beautyWorld.add(beautyMesh);
        let beautyRenderRequests = 0;
        let beautyStatsDirty = 0;
        const beautyVisibility = createVisibilityController({
            world: beautyWorld,
            loadedModels: [],
            outEl: document.createElement('div'),
            requestRender: () => { beautyRenderRequests += 1; },
            markSceneStatsDirty: () => { beautyStatsDirty += 1; },
        });
        const beautyShading = createShadingController({
            THREE,
            world: beautyWorld,
            scene: new THREE.Scene(),
            clearBeautyWire,
            ensureBeautyWire,
            setBackfaceMode: () => {},
        });
        beautyShading.applyShading('beautywire');
        beautyVisibility.toggleObjectVisibility(beautyMesh.uuid, 0);
        const beautyAfterToggle = {
            original: beautyMat.visible,
            base: beautyMesh.userData._beautyBase?.visible,
            line: beautyMesh.userData._beautyWire?.visible,
            meshVisible: beautyMesh.visible,
        };
        beautyShading.dispose();

        const backfaceWorld = new THREE.Group();
        const backfaceMat = new THREE.MeshStandardMaterial({ name: 'backface-source' });
        backfaceMat.visible = false;
        const backfaceMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), backfaceMat);
        backfaceWorld.add(backfaceMesh);
        const backface = createBackfaceOverlayController({ THREE, world: backfaceWorld });
        const backfaceShading = createShadingController({
            THREE,
            world: backfaceWorld,
            scene: new THREE.Scene(),
            clearBeautyWire,
            setBackfaceMode: backface.setBackfaceMode,
        });
        backfaceShading.applyShading('backface');
        const backfaceAfterApply = {
            front: backfaceMesh.userData._bfFront?.visible,
            back: backfaceMesh.userData._bfBack?.visible,
            child: backfaceMesh.userData._bfChild?.visible,
        };
        backfaceShading.dispose();
        backface.dispose();

        const statsWorld = new THREE.Group();
        const statsGeometry = new THREE.BufferGeometry();
        statsGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
            0, 0, 0,
            1, 0, 0,
            0, 1, 0,
            0, 0, 0,
            1, 0, 0,
            1, 1, 0,
        ]), 3));
        statsGeometry.addGroup(0, 3, 0);
        statsGeometry.addGroup(3, 3, 1);
        const statsOriginalA = new THREE.MeshStandardMaterial({ name: 'stats-original-a' });
        const statsOriginalB = new THREE.MeshStandardMaterial({ name: 'stats-original-b' });
        statsOriginalB.visible = false;
        const statsGeneratedA = new THREE.MeshBasicMaterial({ name: 'stats-generated-a' });
        const statsGeneratedB = new THREE.MeshBasicMaterial({ name: 'stats-generated-b' });
        statsGeneratedA.userData.viewerGeneratedMaterial = 'shading-variant';
        statsGeneratedB.userData.viewerGeneratedMaterial = 'shading-variant';
        statsGeneratedB.visible = true;
        const statsMesh = new THREE.Mesh(statsGeometry, [statsGeneratedA, statsGeneratedB]);
        statsMesh.userData._origMaterial = [statsOriginalA, statsOriginalB];
        statsWorld.add(statsMesh);
        const statsTriangles = createSceneGeometryStats({ world: statsWorld }).getStats().triangles;

        [world, beautyWorld, backfaceWorld, statsWorld].forEach((root) => {
            root.traverse((node) => {
                node.geometry?.dispose?.();
                const materials = Array.isArray(node.material) ? node.material : [node.material];
                materials.filter(Boolean).forEach((material) => material.dispose?.());
            });
        });

        return {
            multiAfterToggle,
            multiPbrPreserved,
            multiGeneratedPreserved,
            singleAfterToggle,
            beautyAfterToggle,
            beautyRenderRequests,
            beautyStatsDirty,
            backfaceAfterApply,
            statsTriangles,
            renderRequests,
            statsDirty,
        };
    });

    assert.deepEqual(result.multiAfterToggle, {
        originalA: true,
        originalB: false,
        generatedA: true,
        generatedB: false,
        meshVisible: true,
    }, 'Material visibility smoke: multi-material toggle did not sync original and generated materials');
    assert.equal(result.multiPbrPreserved, true, 'Material visibility smoke: hidden material was not preserved after returning to PBR');
    assert.equal(result.multiGeneratedPreserved, true, 'Material visibility smoke: hidden material was not copied into generated shading variant');
    assert.deepEqual(result.singleAfterToggle, {
        original: false,
        generated: false,
        meshVisible: false,
    }, 'Material visibility smoke: single-material generated toggle did not hide original/current material');
    assert.deepEqual(result.beautyAfterToggle, {
        original: false,
        base: false,
        line: false,
        meshVisible: false,
    }, 'Material visibility smoke: BeautyWire overlay did not follow material visibility');
    assert.ok(result.beautyRenderRequests >= 1, 'Material visibility smoke: BeautyWire visibility did not request render');
    assert.ok(result.beautyStatsDirty >= 1, 'Material visibility smoke: BeautyWire visibility did not mark stats dirty');
    assert.deepEqual(result.backfaceAfterApply, {
        front: false,
        back: false,
        child: false,
    }, 'Material visibility smoke: Backface overlay ignored hidden source material');
    assert.equal(result.statsTriangles, 1, 'Material visibility smoke: geometry stats ignored hidden original material under generated shading');
    assert.ok(result.renderRequests >= 1, 'Material visibility smoke: visibility changes did not request render');
    assert.ok(result.statsDirty >= 1, 'Material visibility smoke: visibility changes did not mark stats dirty');
    diagnostics.assertNoErrors('Material visibility display-mode smoke');
    await page.close();
}

async function runMaterialUndoStackLifecycleSmoke(browser, baseUrl) {
    const page = await browser.newPage();
    const diagnostics = attachPageDiagnostics(page);
    await page.goto(`${baseUrl}/__smoke_blank`, { waitUntil: 'domcontentloaded', timeout: 15000 });

    const result = await page.evaluate(async () => {
        const THREE = await import('three');
        const { createFilenameBinder } = await import('/scripts/modules/material/filename-autobind.js');
        const { pruneMaterialUndoStackForRoots } = await import('/scripts/modules/material/undo-stack.js');

        const rootA = new THREE.Group();
        const meshA = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
        const meshA2 = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
        meshA.name = 'mesh-a';
        meshA2.name = 'mesh-a2';
        rootA.add(meshA, meshA2);

        const rootB = new THREE.Group();
        const meshB = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
        meshB.name = 'mesh-b';
        rootB.add(meshB);

        const undoStack = [
            { fileName: 'mixed.fbx', bindings: [{ obj: meshA }, { obj: meshB }] },
            { fileName: 'removed.fbx', bindings: [{ obj: meshA2 }] },
            { fileName: 'empty.fbx', bindings: [] },
            { fileName: 'metadata-only.fbx' },
        ];

        const removed = pruneMaterialUndoStackForRoots(undoStack, [rootA]);
        const afterFirstPrune = undoStack.map((entry) => ({
            fileName: entry.fileName,
            bindings: Array.isArray(entry.bindings)
                ? entry.bindings.map((binding) => binding.obj?.name || '')
                : null,
        }));
        const noopRemoved = pruneMaterialUndoStackForRoots(undoStack, [new THREE.Group()]);

        const bindRoot = new THREE.Group();
        const previousTexture = new THREE.Texture();
        previousTexture.name = 'previous-texture';
        const bindMaterial = new THREE.MeshBasicMaterial({ name: 'M_001_wall', map: previousTexture });
        const bindMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), bindMaterial);
        bindMesh.name = 'G_001_wall';
        bindRoot.add(bindMesh);
        const bindUndoStack = [];
        const loadedTextures = [];
        const textureLoader = {
            load(url, onLoad) {
                const texture = new THREE.Texture();
                texture.name = 'loaded-texture';
                texture.image = { width: 1, height: 1 };
                texture.needsUpdate = true;
                loadedTextures.push(texture);
                queueMicrotask(() => onLoad?.(texture));
                return texture;
            },
        };
        const binder = createFilenameBinder({
            THREE,
            geomSuffixes: ['wall'],
            textureLoader,
            undoStack: bindUndoStack,
            isRootLive: (root) => root === bindRoot,
            findGeomSuffix: (label) => (String(label || '').includes('wall') ? 'wall' : null),
        });
        binder.autoBindByNamesForModel(bindRoot, 'bound.fbx', [{
            short: '001_wall_d_1.png',
            full: '001_wall_d_1.png',
            url: 'blob:bound-texture',
        }]);
        await Promise.resolve();
        const bindHistory = bindUndoStack[0]?.bindings?.[0] || {};
        const bindHistoryRetainsTextures = bindHistory.prev === previousTexture || loadedTextures.includes(bindHistory.tex);
        const bindHistoryKeys = Object.keys(bindHistory).sort();

        rootA.traverse((node) => {
            node.geometry?.dispose?.();
            node.material?.dispose?.();
        });
        rootB.traverse((node) => {
            node.geometry?.dispose?.();
            node.material?.dispose?.();
        });
        bindRoot.traverse((node) => {
            node.geometry?.dispose?.();
            const materials = Array.isArray(node.material) ? node.material : [node.material];
            materials.filter(Boolean).forEach((material) => {
                material.map?.dispose?.();
                material.dispose?.();
            });
        });

        return {
            removed,
            noopRemoved,
            afterFirstPrune,
            bindHistoryRetainsTextures,
            bindHistoryKeys,
            bindHistoryPrevName: bindHistory.prevName || '',
            bindHistoryTexName: bindHistory.texName || '',
        };
    });

    assert.equal(result.removed, 2, 'Material undo stack smoke: removed model bindings were not pruned');
    assert.equal(result.noopRemoved, 0, 'Material undo stack smoke: unrelated root pruned bindings');
    assert.deepEqual(result.afterFirstPrune, [
        { fileName: 'mixed.fbx', bindings: ['mesh-b'] },
        { fileName: 'empty.fbx', bindings: [] },
        { fileName: 'metadata-only.fbx', bindings: null },
    ], 'Material undo stack smoke: remaining undo stack entries are wrong');
    assert.equal(result.bindHistoryRetainsTextures, false, 'Material undo stack smoke: filename autobind history retained texture object references');
    assert.deepEqual(result.bindHistoryKeys, ['matIndex', 'obj', 'prevName', 'slot', 'texName', 'url'], 'Material undo stack smoke: filename autobind history stores unexpected fields');
    assert.equal(result.bindHistoryPrevName, 'previous-texture', 'Material undo stack smoke: filename autobind history lost previous texture label');
    assert.equal(result.bindHistoryTexName, '001_wall_d_1.png', 'Material undo stack smoke: filename autobind history lost new texture label');
    diagnostics.assertNoErrors('Material undo stack lifecycle smoke');
    await page.close();
}

async function runVisibilitySuppressionPruneSmoke(browser, baseUrl) {
    const page = await browser.newPage();
    const diagnostics = attachPageDiagnostics(page);
    await page.goto(`${baseUrl}/__smoke_blank`, { waitUntil: 'domcontentloaded', timeout: 15000 });

    const result = await page.evaluate(async () => {
        const THREE = await import('three');
        const { createVisibilityAndCollisions } = await import('/scripts/modules/ui/visibility-collisions.js');

        const world = new THREE.Group();
        const materialA = new THREE.MeshBasicMaterial({ name: 'solid-a' });
        const materialB = new THREE.MeshBasicMaterial({ name: 'solid-b' });
        const meshA = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), materialA);
        const meshB = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), materialB);
        meshA.name = 'solid-a';
        meshB.name = 'solid-b';
        const rootA = new THREE.Group();
        const rootB = new THREE.Group();
        rootA.add(meshA);
        rootB.add(meshB);
        world.add(rootA, rootB);

        const loadedModels = [
            { obj: rootA, name: 'a.fbx' },
            { obj: rootB, name: 'b.fbx' },
        ];
        let renderRequests = 0;
        let statsDirty = 0;
        const controller = createVisibilityAndCollisions({
            world,
            loadedModels,
            requestRender: () => { renderRequests += 1; },
            markSceneStatsDirty: () => { statsDirty += 1; },
        });

        controller.setNonGlassSuppressed(true);
        const afterSuppress = {
            meshA: meshA.visible,
            matA: materialA.visible,
            meshB: meshB.visible,
            matB: materialB.visible,
        };

        loadedModels.splice(0, 1);
        world.remove(rootA);
        const pruned = controller.pruneNonGlassSuppressionForRoots([rootA]);
        controller.setNonGlassSuppressed(false);

        const afterRestore = {
            meshA: meshA.visible,
            matA: materialA.visible,
            meshB: meshB.visible,
            matB: materialB.visible,
        };

        rootA.traverse((node) => {
            node.geometry?.dispose?.();
            const materials = Array.isArray(node.material) ? node.material : [node.material];
            materials.filter(Boolean).forEach((material) => material.dispose?.());
        });
        rootB.traverse((node) => {
            node.geometry?.dispose?.();
            const materials = Array.isArray(node.material) ? node.material : [node.material];
            materials.filter(Boolean).forEach((material) => material.dispose?.());
        });

        return {
            afterSuppress,
            pruned,
            afterRestore,
            renderRequests,
            statsDirty,
        };
    });

    assert.deepEqual(result.afterSuppress, {
        meshA: false,
        matA: false,
        meshB: false,
        matB: false,
    }, 'Visibility suppression smoke: non-glass objects were not suppressed');
    assert.deepEqual(result.pruned, {
        objects: 1,
        materials: 1,
    }, 'Visibility suppression smoke: removed model suppression state was not pruned');
    assert.deepEqual(result.afterRestore, {
        meshA: false,
        matA: false,
        meshB: true,
        matB: true,
    }, 'Visibility suppression smoke: removed model visibility was restored or kept model visibility was not restored');
    assert.equal(result.renderRequests >= 2, true, 'Visibility suppression smoke: visibility changes did not request render');
    assert.equal(result.statsDirty >= 2, true, 'Visibility suppression smoke: visibility changes did not mark stats dirty');
    diagnostics.assertNoErrors('Visibility suppression prune smoke');
    await page.close();
}

async function runCollabRealtimeDisposeSmoke(browser, baseUrl) {
    const page = await browser.newPage();
    const diagnostics = attachPageDiagnostics(page);
    await page.goto(`${baseUrl}/__smoke_blank`, { waitUntil: 'domcontentloaded', timeout: 15000 });

    const result = await page.evaluate(async () => {
        const { createCollabController } = await import('/scripts/modules/collab/collab-controller.js');
        const unhandled = [];
        const handleUnhandled = (event) => {
            unhandled.push(String(event?.reason?.message || event?.reason || 'unhandled'));
            event?.preventDefault?.();
        };
        globalThis.addEventListener('unhandledrejection', handleUnhandled);

        let delayedProfileUpsertResolve = null;
        let delayedProfileUpsertStartedResolve = null;
        const delayedProfileUpsertStarted = new Promise((resolve) => {
            delayedProfileUpsertStartedResolve = resolve;
        });
        let delayedMessageInsertResolve = null;
        let delayedMessageInsertStartedResolve = null;
        const delayedMessageInsertStarted = new Promise((resolve) => {
            delayedMessageInsertStartedResolve = resolve;
        });
        let delayedMessageErrorResolve = null;
        let delayedMessageErrorStartedResolve = null;
        const delayedMessageErrorStarted = new Promise((resolve) => {
            delayedMessageErrorStartedResolve = resolve;
        });
        let delayedAnnotationInsertResolve = null;
        let delayedAnnotationInsertStartedResolve = null;
        const delayedAnnotationInsertStarted = new Promise((resolve) => {
            delayedAnnotationInsertStartedResolve = resolve;
        });
        let delayedAnnotationErrorResolve = null;
        let delayedAnnotationErrorStartedResolve = null;
        const delayedAnnotationErrorStarted = new Promise((resolve) => {
            delayedAnnotationErrorStartedResolve = resolve;
        });

        class FakeQuery {
            constructor(table) {
                this.table = table;
                this.payload = null;
            }
            upsert(payload) {
                this.payload = payload;
                if (this.table === 'profiles' && payload?.display_name === 'Late Name') {
                    delayedProfileUpsertStartedResolve?.();
                    return new Promise((resolve) => {
                        delayedProfileUpsertResolve = () => resolve({ data: payload, error: null });
                    });
                }
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
                if (this.table === 'annotations') {
                    return Promise.resolve({
                        data: [{
                            id: 'history-annotation',
                            author_id: 'history-author',
                            author_name: 'History Author',
                        }],
                        error: null,
                    });
                }
                if (this.table === 'messages') {
                    return Promise.resolve({
                        data: [{
                            id: 'history-message',
                            author_id: 'history-author',
                            author_name: 'History Author',
                            body: 'history message',
                        }],
                        error: null,
                    });
                }
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
                if (this.table === 'messages' && this.payload?.body === 'Late message') {
                    delayedMessageInsertStartedResolve?.();
                    return new Promise((resolve) => {
                        delayedMessageInsertResolve = () => resolve({ data, error: null });
                    });
                }
                if (this.table === 'messages' && this.payload?.body === 'Late error message') {
                    delayedMessageErrorStartedResolve?.();
                    return new Promise((resolve) => {
                        delayedMessageErrorResolve = () => resolve({ data: null, error: new Error('late message failed') });
                    });
                }
                if (this.table === 'annotations' && this.payload?.kind === 'late-pin') {
                    delayedAnnotationInsertStartedResolve?.();
                    return new Promise((resolve) => {
                        delayedAnnotationInsertResolve = () => resolve({ data, error: null });
                    });
                }
                if (this.table === 'annotations' && this.payload?.kind === 'late-error-pin') {
                    delayedAnnotationErrorStartedResolve?.();
                    return new Promise((resolve) => {
                        delayedAnnotationErrorResolve = () => resolve({ data: null, error: new Error('late annotation failed') });
                    });
                }
                return Promise.resolve({ data, error: null });
            }
        }

        class FakeChannel {
            constructor(name) {
                this.name = name;
                this.handlers = [];
                this.statusCallback = null;
                this.state = 'joined';
                this.socket = { isConnected: () => true };
                this.tracked = [];
            }
            on(type, filter, callback) {
                this.handlers.push({ type, filter: filter || {}, callback });
                return this;
            }
            subscribe(callback) {
                this.statusCallback = typeof callback === 'function' ? callback : null;
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
            emitStatus(status, err = null) {
                this.statusCallback?.(status, err);
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

        class RejectTrackChannel extends FakeChannel {
            track() {
                this.tracked.push({ failed: true });
                return Promise.reject(new Error('initial presence track failed'));
            }
        }

        const trackRejectChannels = [];
        const trackRejectSupabase = {
            ...supabase,
            channel: (name) => {
                const channel = new RejectTrackChannel(name);
                trackRejectChannels.push(channel);
                return channel;
            },
            removeChannel: async () => 'ok',
        };
        const trackRejectController = await createCollabController({
            supabase: trackRejectSupabase,
            user: { id: 'track-user' },
            project: { id: 'track-project', slug: 'track-project' },
            room: { id: 'track-room', slug: 'track-room', camera_owner_id: null, camera_state: null },
            displayName: 'Track',
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
        const trackRejectUpdatePresence = await trackRejectController.updatePresence({ mode: 'smoke' }).then(
            () => 'resolved',
            (err) => `rejected:${err?.message || String(err)}`,
        );
        await trackRejectController.dispose();
        const trackRejectUnhandled = unhandled.slice();
        const trackRejectCalls = trackRejectChannels
            .filter((channel) => channel.name === 'room:track-room')
            .reduce((sum, channel) => sum + channel.tracked.length, 0);
        unhandled.length = 0;

        const boundedCalls = [];
        const boundedChannels = [];
        const boundedRemovedChannels = [];
        const boundedSupabase = {
            ...supabase,
            channel: (name) => {
                const channel = new FakeChannel(name);
                boundedChannels.push(channel);
                return channel;
            },
            removeChannel: async (channel) => {
                boundedRemovedChannels.push(channel.name);
                return 'ok';
            },
        };
        const boundedController = await createCollabController({
            supabase: boundedSupabase,
            user: { id: 'bounded-user' },
            project: { id: 'bounded-project', slug: 'bounded-project' },
            room: { id: 'bounded-room', slug: 'bounded-room', camera_owner_id: null, camera_state: null },
            displayName: 'Bounded',
            dedupeIdLimit: 3,
            onMessage: (record, meta) => boundedCalls.push(`message:${meta?.source || ''}:${record?.id || ''}`),
        });
        const boundedMessagesChannel = boundedChannels.find((channel) => channel.name === 'room:bounded-room:messages');
        ['bounded-1', 'bounded-2', 'bounded-3', 'bounded-4'].forEach((id) => {
            boundedMessagesChannel.emit('postgres_changes', 'INSERT', { new: { id } });
        });
        boundedMessagesChannel.emit('postgres_changes', 'INSERT', { new: { id: 'bounded-4' } });
        boundedMessagesChannel.emit('postgres_changes', 'INSERT', { new: { id: 'bounded-1' } });
        await Promise.resolve();
        await boundedController.dispose();
        const boundedMessageCounts = {
            history: boundedCalls.filter((entry) => entry === 'message:history:history-message').length,
            first: boundedCalls.filter((entry) => entry === 'message:realtime:bounded-1').length,
            second: boundedCalls.filter((entry) => entry === 'message:realtime:bounded-2').length,
            fourth: boundedCalls.filter((entry) => entry === 'message:realtime:bounded-4').length,
        };

        const calls = [];
        const controller = await createCollabController({
            supabase,
            user: { id: 'local-user' },
            project: { id: 'project-1', slug: 'project' },
            room: { id: 'room-1', slug: 'room', camera_owner_id: null, camera_state: null, active_model_id: 'initial-model' },
            displayName: 'Local',
            onParticipants: (list) => calls.push(`participants:${list.length}`),
            onMessage: (record, meta) => calls.push(`message:${meta?.source || ''}:${record?.id || ''}`),
            onAnnotation: (record, meta) => calls.push(`annotation:${meta?.source || ''}:${record?.id || ''}`),
            onAnnotationDelete: (record) => calls.push(`annotation-delete:${record?.id || ''}`),
            onCameraState: (state) => calls.push(`camera:${state?.source || 'broadcast'}`),
            onCameraOwner: (ownerId) => calls.push(`owner:${ownerId || ''}`),
            onRoomUpdate: (room) => calls.push(`room:${room?.id || ''}:${room?.active_model_id || ''}`),
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
            new: { id: 'room-1', camera_owner_id: 'db-owner', camera_state: { position: [1, 2, 3] }, active_model_id: 'db-model' },
        });
        annotationsChannel.emit('postgres_changes', 'INSERT', { new: { id: 'annotation-row' } });
        annotationsChannel.emit('postgres_changes', 'DELETE', { old: { id: 'annotation-old' } });
        messagesChannel.emit('postgres_changes', 'INSERT', { new: { id: 'message-row' } });
        annotationsChannel.emit('postgres_changes', 'INSERT', {
            new: { id: 'history-annotation', author_id: 'history-author', author_name: 'History Author' },
        });
        messagesChannel.emit('postgres_changes', 'INSERT', {
            new: { id: 'history-message', author_id: 'history-author', author_name: 'History Author', body: 'history message' },
        });
        annotationsChannel.emit('postgres_changes', 'DELETE', { old: { id: 'delete-before-insert' } });
        annotationsChannel.emit('postgres_changes', 'INSERT', { new: { id: 'delete-before-insert' } });

        await Promise.resolve();
        const controllerRoomActiveModelAfterUpdate = controller.room?.active_model_id || '';
        annotationsChannel.emitStatus('CHANNEL_ERROR');
        await Promise.resolve();
        const afterChannelFailure = calls.slice();
        const trackedBeforeSetName = roomChannel.tracked.length;
        const setNameAfterDispose = controller
            .setDisplayName('Late Name')
            .then((value) => `resolved:${value}`, (err) => `rejected:${err?.message || String(err)}`);
        const messageAfterDispose = controller
            .sendMessage('Late message')
            .then((value) => `resolved:${value?.id || 'null'}`, (err) => `rejected:${err?.message || String(err)}`);
        const annotationAfterDispose = controller
            .sendAnnotation({ kind: 'late-pin', payload: { text: 'late' } })
            .then((value) => `resolved:${value?.id || 'null'}`, (err) => `rejected:${err?.message || String(err)}`);
        const messageErrorAfterDispose = controller
            .sendMessage('Late error message')
            .then((value) => `resolved:${value?.id || 'null'}`, (err) => `rejected:${err?.message || String(err)}`);
        const annotationErrorAfterDispose = controller
            .sendAnnotation({ kind: 'late-error-pin', payload: { text: 'late-error' } })
            .then((value) => `resolved:${value?.id || 'null'}`, (err) => `rejected:${err?.message || String(err)}`);
        await delayedProfileUpsertStarted;
        await delayedMessageInsertStarted;
        await delayedAnnotationInsertStarted;
        await delayedMessageErrorStarted;
        await delayedAnnotationErrorStarted;
        const trackedWhileSetNamePending = roomChannel.tracked.length;
        const beforeDispose = calls.slice();
        await controller.dispose();
        const afterDispose = calls.slice();
        delayedProfileUpsertResolve?.();
        delayedMessageInsertResolve?.();
        delayedAnnotationInsertResolve?.();
        delayedMessageErrorResolve?.();
        delayedAnnotationErrorResolve?.();
        const setNameAfterDisposeResult = await setNameAfterDispose;
        const messageAfterDisposeResult = await messageAfterDispose;
        const annotationAfterDisposeResult = await annotationAfterDispose;
        const messageErrorAfterDisposeResult = await messageErrorAfterDispose;
        const annotationErrorAfterDisposeResult = await annotationErrorAfterDispose;
        await Promise.resolve();
        const trackedAfterLateSetName = roomChannel.tracked.length;

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
        annotationsChannel.emitStatus('CLOSED');

        await Promise.resolve();
        const afterLateEvents = calls.slice();
        globalThis.removeEventListener('unhandledrejection', handleUnhandled);
        return {
            beforeDispose,
            afterChannelFailure,
            afterDispose,
            afterLateEvents,
            unhandled,
            trackRejectUnhandled,
            trackRejectCalls,
            trackRejectUpdatePresence,
            trackedBeforeSetName,
            trackedWhileSetNamePending,
            trackedAfterLateSetName,
            setNameAfterDisposeResult,
            messageAfterDisposeResult,
            annotationAfterDisposeResult,
            messageErrorAfterDisposeResult,
            annotationErrorAfterDisposeResult,
            historyAnnotationCalls: calls.filter((entry) => entry === 'annotation:history:history-annotation').length,
            historyAnnotationDuplicateCalls: calls.filter((entry) => entry === 'annotation:realtime:history-annotation').length,
            historyMessageCalls: calls.filter((entry) => entry === 'message:history:history-message').length,
            historyMessageDuplicateCalls: calls.filter((entry) => entry === 'message:realtime:history-message').length,
            tombstoneDeleteCalls: calls.filter((entry) => entry === 'annotation-delete:delete-before-insert').length,
            tombstoneInsertCalls: calls.filter((entry) => entry === 'annotation:realtime:delete-before-insert').length,
            controllerRoomActiveModelAfterUpdate,
            removedChannels,
            channelNames: channels.map((channel) => channel.name),
            boundedMessageCounts,
            boundedRemovedChannels,
            boundedChannelNames: boundedChannels.map((channel) => channel.name),
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
    assert.ok(result.beforeDispose.includes('room:room-1:db-model'), 'Collab smoke: room update did not fire before dispose');
    assert.equal(result.controllerRoomActiveModelAfterUpdate, 'db-model', 'Collab smoke: room update did not refresh controller room state');
    assert.equal(result.historyAnnotationCalls, 1, 'Collab smoke: history annotation was not delivered once');
    assert.equal(result.historyAnnotationDuplicateCalls, 0, 'Collab smoke: duplicate realtime annotation was delivered after history');
    assert.equal(result.historyMessageCalls, 1, 'Collab smoke: history message was not delivered once');
    assert.equal(result.historyMessageDuplicateCalls, 0, 'Collab smoke: duplicate realtime message was delivered after history');
    assert.deepEqual(result.boundedMessageCounts, {
        history: 1,
        first: 2,
        second: 1,
        fourth: 1,
    }, 'Collab smoke: bounded message dedupe did not prune only the oldest ids');
    assert.deepEqual(result.boundedRemovedChannels, result.boundedChannelNames, 'Collab smoke: bounded dedupe controller did not remove realtime channels');
    assert.equal(result.tombstoneDeleteCalls, 1, 'Collab smoke: realtime annotation delete was not delivered once');
    assert.equal(result.tombstoneInsertCalls, 0, 'Collab smoke: stale annotation insert was delivered after delete');
    assert.ok(result.afterChannelFailure.includes('connection:off:annotations:CHANNEL_ERROR'), 'Collab smoke: auxiliary channel failure did not emit offline state');
    assert.ok(result.afterDispose.includes('connection:off:DISPOSED'), 'Collab smoke: dispose did not emit connection close');
    assert.equal(result.setNameAfterDisposeResult, 'resolved:Late Name', 'Collab smoke: delayed display name update did not settle');
    assert.equal(result.messageAfterDisposeResult, 'resolved:null', 'Collab smoke: delayed message insert returned stale data after dispose');
    assert.equal(result.annotationAfterDisposeResult, 'resolved:null', 'Collab smoke: delayed annotation insert returned stale data after dispose');
    assert.equal(result.messageErrorAfterDisposeResult, 'resolved:null', 'Collab smoke: delayed message error was propagated after dispose');
    assert.equal(result.annotationErrorAfterDisposeResult, 'resolved:null', 'Collab smoke: delayed annotation error was propagated after dispose');
    assert.equal(result.trackRejectCalls, 2, 'Collab smoke: presence track failures were not exercised');
    assert.equal(result.trackRejectUpdatePresence, 'resolved', 'Collab smoke: rejected updatePresence track was propagated');
    assert.deepEqual(result.trackRejectUnhandled, [], 'Collab smoke: initial presence track rejection was unhandled');
    assert.deepEqual(result.unhandled, [], 'Collab smoke: realtime dispose flow caused unhandled rejections');
    assert.equal(result.trackedWhileSetNamePending, result.trackedBeforeSetName, 'Collab smoke: delayed display name tracked presence before its write completed');
    assert.equal(result.trackedAfterLateSetName, result.trackedWhileSetNamePending, 'Collab smoke: delayed display name tracked presence after dispose');
    assert.deepEqual(result.removedChannels, result.channelNames, 'Collab smoke: dispose did not remove all realtime channels');
    assert.deepEqual(result.afterLateEvents, result.afterDispose, 'Collab smoke: stale realtime callbacks fired after dispose');
    diagnostics.assertNoErrors('Collab realtime dispose smoke');
    await page.close();
}

async function runCollabInitFailureCleanupSmoke(browser, baseUrl) {
    const page = await browser.newPage();
    const diagnostics = attachPageDiagnostics(page);
    await page.goto(`${baseUrl}/__smoke_blank`, { waitUntil: 'domcontentloaded', timeout: 15000 });

    const result = await page.evaluate(async () => {
        const { createCollabController } = await import('/scripts/modules/collab/collab-controller.js');

        const nativeSetInterval = globalThis.setInterval;
        const nativeClearInterval = globalThis.clearInterval;
        const intervalIds = [];
        const clearedIntervals = [];
        globalThis.setInterval = (fn, ms, ...args) => {
            const id = nativeSetInterval(fn, ms, ...args);
            intervalIds.push(id);
            return id;
        };
        globalThis.clearInterval = (id) => {
            clearedIntervals.push(id);
            return nativeClearInterval(id);
        };

        class FakeQuery {
            constructor(table) {
                this.table = table;
            }
            upsert() {
                return Promise.resolve({ data: null, error: null });
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
        }

        class FakeChannel {
            constructor(name) {
                this.name = name;
                this.handlers = [];
                this.state = 'joined';
                this.socket = { isConnected: () => true };
            }
            on(type, filter, callback) {
                this.handlers.push({ type, filter: filter || {}, callback });
                return this;
            }
            subscribe(callback) {
                if (this.name.endsWith(':annotations')) {
                    return Promise.reject(new Error('annotations subscribe failed'));
                }
                if (typeof callback === 'function') {
                    Promise.resolve().then(() => callback('SUBSCRIBED'));
                }
                return Promise.resolve('SUBSCRIBED');
            }
            track() {
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
        let thrown = '';
        try {
            await createCollabController({
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
        } catch (err) {
            thrown = err?.message || String(err);
        }

        class TimeoutChannel extends FakeChannel {
            subscribe(callback) {
                this.statusCallback = typeof callback === 'function' ? callback : null;
                if (typeof callback === 'function') {
                    Promise.resolve().then(() => callback('TIMED_OUT'));
                }
                return Promise.resolve('TIMED_OUT');
            }
            emitStatus(status, err = null) {
                this.statusCallback?.(status, err);
            }
        }

        const timeoutChannels = [];
        const timeoutRemovedChannels = [];
        const timeoutCalls = [];
        const timeoutSupabase = {
            from: (table) => new FakeQuery(table),
            channel: (name) => {
                const channel = new TimeoutChannel(name);
                timeoutChannels.push(channel);
                return channel;
            },
            removeChannel: async (channel) => {
                timeoutRemovedChannels.push(channel.name);
                return 'ok';
            },
            rpc: async () => ({ data: null, error: null }),
        };
        const timeoutThrown = await Promise.race([
            createCollabController({
                supabase: timeoutSupabase,
                user: { id: 'timeout-user' },
                project: { id: 'project-timeout', slug: 'project-timeout' },
                room: { id: 'room-timeout', slug: 'room-timeout', camera_owner_id: null, camera_state: null },
                displayName: 'Timeout',
                onConnectionState: ({ connected, reason }) => timeoutCalls.push(`connection:${connected ? 'on' : 'off'}:${reason}`),
            }).then(
                () => 'resolved',
                (err) => err?.message || String(err),
            ),
            new Promise((resolve) => setTimeout(() => resolve('hung'), 50)),
        ]);
        const timeoutCallsAfterFailure = timeoutCalls.slice();
        timeoutChannels[0]?.emitStatus('SUBSCRIBED');
        await Promise.resolve();
        const timeoutCallsAfterLateStatus = timeoutCalls.slice();

        class SilentInitialChannel extends FakeChannel {
            subscribe(callback) {
                this.statusCallback = typeof callback === 'function' ? callback : null;
                return new Promise(() => {});
            }
            emitStatus(status, err = null) {
                this.statusCallback?.(status, err);
            }
        }
        const silentInitialChannels = [];
        const silentInitialRemovedChannels = [];
        const silentInitialCalls = [];
        const silentInitialSupabase = {
            from: (table) => new FakeQuery(table),
            channel: (name) => {
                const channel = new SilentInitialChannel(name);
                silentInitialChannels.push(channel);
                return channel;
            },
            removeChannel: async (channel) => {
                silentInitialRemovedChannels.push(channel.name);
                return 'ok';
            },
            rpc: async () => ({ data: null, error: null }),
        };
        const silentInitialThrown = await Promise.race([
            createCollabController({
                supabase: silentInitialSupabase,
                user: { id: 'silent-initial-user' },
                project: { id: 'project-silent-initial', slug: 'project-silent-initial' },
                room: { id: 'room-silent-initial', slug: 'room-silent-initial', camera_owner_id: null, camera_state: null },
                displayName: 'Silent Initial',
                realtimeSubscribeTimeoutMs: 20,
                onConnectionState: ({ connected, reason }) => silentInitialCalls.push(`connection:${connected ? 'on' : 'off'}:${reason}`),
            }).then(
                () => 'resolved',
                (err) => err?.message || String(err),
            ),
            new Promise((resolve) => setTimeout(() => resolve('hung'), 80)),
        ]);
        const silentInitialCallsAfterFailure = silentInitialCalls.slice();
        silentInitialChannels[0]?.emitStatus('SUBSCRIBED');
        await Promise.resolve();
        const silentInitialCallsAfterLateStatus = silentInitialCalls.slice();

        class SilentTrackedChannel extends FakeChannel {
            subscribe(callback) {
                this.statusCallback = typeof callback === 'function' ? callback : null;
                if (this.name.endsWith(':updates')) {
                    return new Promise(() => {});
                }
                if (typeof callback === 'function') {
                    Promise.resolve().then(() => callback('SUBSCRIBED'));
                }
                return Promise.resolve('SUBSCRIBED');
            }
            emitStatus(status, err = null) {
                this.statusCallback?.(status, err);
            }
        }
        const silentTrackedChannels = [];
        const silentTrackedRemovedChannels = [];
        const silentTrackedCalls = [];
        const silentTrackedSupabase = {
            from: (table) => new FakeQuery(table),
            channel: (name) => {
                const channel = new SilentTrackedChannel(name);
                silentTrackedChannels.push(channel);
                return channel;
            },
            removeChannel: async (channel) => {
                silentTrackedRemovedChannels.push(channel.name);
                return 'ok';
            },
            rpc: async () => ({ data: null, error: null }),
        };
        const silentTrackedThrown = await Promise.race([
            createCollabController({
                supabase: silentTrackedSupabase,
                user: { id: 'silent-tracked-user' },
                project: { id: 'project-silent-tracked', slug: 'project-silent-tracked' },
                room: { id: 'room-silent-tracked', slug: 'room-silent-tracked', camera_owner_id: null, camera_state: null },
                displayName: 'Silent Tracked',
                realtimeSubscribeTimeoutMs: 20,
                onConnectionState: ({ connected, reason }) => silentTrackedCalls.push(`connection:${connected ? 'on' : 'off'}:${reason}`),
            }).then(
                () => 'resolved',
                (err) => err?.message || String(err),
            ),
            new Promise((resolve) => setTimeout(() => resolve('hung'), 80)),
        ]);
        const silentTrackedCallsAfterFailure = silentTrackedCalls.slice();
        silentTrackedChannels[1]?.emitStatus('SUBSCRIBED');
        await Promise.resolve();
        const silentTrackedCallsAfterLateStatus = silentTrackedCalls.slice();

        let abortHistoryStartedResolve = null;
        let abortHistoryResolve = null;
        const abortHistoryStarted = new Promise((resolve) => {
            abortHistoryStartedResolve = resolve;
        });
        class AbortHistoryQuery extends FakeQuery {
            order(...args) {
                if (this.table === 'annotations') {
                    abortHistoryStartedResolve?.();
                    return new Promise((resolve) => {
                        abortHistoryResolve = () => resolve({ data: [], error: null });
                    });
                }
                return super.order(...args);
            }
        }
        class AbortChannel extends FakeChannel {
            subscribe(callback) {
                if (typeof callback === 'function') {
                    Promise.resolve().then(() => callback('SUBSCRIBED'));
                }
                return Promise.resolve('SUBSCRIBED');
            }
        }
        const abortChannels = [];
        const abortRemovedChannels = [];
        const abortCalls = [];
        const initAbortController = new AbortController();
        const abortSupabase = {
            from: (table) => new AbortHistoryQuery(table),
            channel: (name) => {
                const channel = new AbortChannel(name);
                abortChannels.push(channel);
                return channel;
            },
            removeChannel: async (channel) => {
                abortRemovedChannels.push(channel.name);
                return 'ok';
            },
            rpc: async () => ({ data: null, error: null }),
        };
        const abortInitPromise = createCollabController({
            supabase: abortSupabase,
            user: { id: 'abort-user' },
            project: { id: 'project-abort', slug: 'project-abort' },
            room: { id: 'room-abort', slug: 'room-abort', camera_owner_id: null, camera_state: null },
            displayName: 'Abort',
            signal: initAbortController.signal,
            onConnectionState: ({ connected, reason }) => abortCalls.push(`connection:${connected ? 'on' : 'off'}:${reason}`),
        }).then(
            () => 'resolved',
            (err) => `${err?.name || 'Error'}:${err?.message || String(err)}`,
        );
        await abortHistoryStarted;
        initAbortController.abort(new DOMException('init switched', 'AbortError'));
        const abortThrown = await Promise.race([
            abortInitPromise,
            new Promise((resolve) => setTimeout(() => resolve('hung'), 50)),
        ]);
        abortHistoryResolve?.();

        const afterFailure = calls.slice();
        channels.forEach((channel) => {
            channel.emit('presence', 'sync', {});
            channel.emit('broadcast', 'message', { payload: { id: 'late-message', sender: 'peer-user' } });
            channel.emit('broadcast', 'annotation', { payload: { id: 'late-annotation', sender: 'peer-user' } });
            channel.emit('postgres_changes', 'UPDATE', {
                new: { id: 'room-1', camera_owner_id: 'late-owner', camera_state: { position: [1, 2, 3] } },
            });
            channel.emit('postgres_changes', 'INSERT', { new: { id: 'late-row' } });
            channel.emit('postgres_changes', 'DELETE', { old: { id: 'late-old' } });
        });
        await Promise.resolve();

        globalThis.setInterval = nativeSetInterval;
        globalThis.clearInterval = nativeClearInterval;

        return {
            thrown,
            channelNames: channels.map((channel) => channel.name),
            removedChannels,
            afterFailure,
            afterLateEvents: calls.slice(),
            intervalCount: intervalIds.length,
            clearedIntervalCount: clearedIntervals.length,
            heartbeatCleared: intervalIds.length === clearedIntervals.length,
            timeoutThrown,
            timeoutCalls,
            timeoutCallsAfterFailure,
            timeoutCallsAfterLateStatus,
            timeoutChannelNames: timeoutChannels.map((channel) => channel.name),
            timeoutRemovedChannels,
            silentInitialThrown,
            silentInitialCalls,
            silentInitialCallsAfterFailure,
            silentInitialCallsAfterLateStatus,
            silentInitialChannelNames: silentInitialChannels.map((channel) => channel.name),
            silentInitialRemovedChannels,
            silentTrackedThrown,
            silentTrackedCalls,
            silentTrackedCallsAfterFailure,
            silentTrackedCallsAfterLateStatus,
            silentTrackedChannelNames: silentTrackedChannels.map((channel) => channel.name),
            silentTrackedRemovedChannels,
            abortThrown,
            abortCalls,
            abortChannelNames: abortChannels.map((channel) => channel.name),
            abortRemovedChannels,
        };
    });

    assert.equal(result.thrown, 'annotations subscribe failed', 'Collab init-failure smoke: expected subscribe failure');
    assert.deepEqual(result.channelNames, [
        'room:room-1',
        'room:room-1:updates',
        'room:room-1:annotations',
    ], 'Collab init-failure smoke: unexpected channel set before failure');
    assert.deepEqual(result.removedChannels, result.channelNames, 'Collab init-failure smoke: failed init did not remove opened channels');
    assert.ok(result.afterFailure.includes('connection:on:SUBSCRIBED'), 'Collab init-failure smoke: room channel did not subscribe before failure');
    assert.deepEqual(result.afterLateEvents, result.afterFailure, 'Collab init-failure smoke: stale callbacks fired after failed init cleanup');
    assert.equal(result.intervalCount, 3, 'Collab init-failure smoke: expected failed and aborted init heartbeats');
    assert.equal(result.heartbeatCleared, true, 'Collab init-failure smoke: presence heartbeat leaked after failed init');
    assert.equal(result.timeoutThrown, 'Room realtime subscribe TIMED_OUT', 'Collab init-failure smoke: initial subscribe timeout hung');
    assert.ok(result.timeoutCalls.includes('connection:off:TIMED_OUT'), 'Collab init-failure smoke: timeout status was not emitted');
    assert.deepEqual(result.timeoutCallsAfterLateStatus, result.timeoutCallsAfterFailure, 'Collab init-failure smoke: late subscribed status revived a failed room channel');
    assert.deepEqual(result.timeoutChannelNames, ['room:room-timeout'], 'Collab init-failure smoke: timeout opened unexpected channels');
    assert.deepEqual(result.timeoutRemovedChannels, result.timeoutChannelNames, 'Collab init-failure smoke: timeout channel was not removed');
    assert.equal(result.silentInitialThrown, 'Room realtime subscribe SUBSCRIBE_TIMEOUT', 'Collab init-failure smoke: silent initial subscribe hung');
    assert.ok(result.silentInitialCalls.includes('connection:off:SUBSCRIBE_TIMEOUT'), 'Collab init-failure smoke: silent initial timeout status was not emitted');
    assert.deepEqual(result.silentInitialCallsAfterLateStatus, result.silentInitialCallsAfterFailure, 'Collab init-failure smoke: late status revived a silent initial channel');
    assert.deepEqual(result.silentInitialChannelNames, ['room:room-silent-initial'], 'Collab init-failure smoke: silent initial opened unexpected channels');
    assert.deepEqual(result.silentInitialRemovedChannels, result.silentInitialChannelNames, 'Collab init-failure smoke: silent initial channel was not removed');
    assert.equal(result.silentTrackedThrown, 'room_updates realtime subscribe SUBSCRIBE_TIMEOUT', 'Collab init-failure smoke: silent tracked subscribe hung');
    assert.ok(result.silentTrackedCalls.includes('connection:off:room_updates:SUBSCRIBE_TIMEOUT'), 'Collab init-failure smoke: silent tracked timeout status was not emitted');
    assert.deepEqual(result.silentTrackedCallsAfterLateStatus, result.silentTrackedCallsAfterFailure, 'Collab init-failure smoke: late status revived a silent tracked channel');
    assert.deepEqual(result.silentTrackedChannelNames, ['room:room-silent-tracked', 'room:room-silent-tracked:updates'], 'Collab init-failure smoke: silent tracked opened unexpected channels');
    assert.deepEqual(result.silentTrackedRemovedChannels, result.silentTrackedChannelNames, 'Collab init-failure smoke: silent tracked channels were not removed');
    assert.equal(result.abortThrown, 'AbortError:init switched', 'Collab init-failure smoke: aborted init did not reject promptly');
    assert.ok(result.abortCalls.includes('connection:on:SUBSCRIBED'), 'Collab init-failure smoke: aborted init did not subscribe before abort');
    assert.deepEqual(result.abortChannelNames, [
        'room:room-abort',
        'room:room-abort:updates',
        'room:room-abort:annotations',
        'room:room-abort:messages',
    ], 'Collab init-failure smoke: aborted init opened unexpected channels');
    assert.deepEqual(result.abortRemovedChannels, result.abortChannelNames, 'Collab init-failure smoke: aborted init did not remove opened channels');
    diagnostics.assertNoErrors('Collab init-failure cleanup smoke');
    await page.close();
}

async function runCollabDeleteQueueDisposeSmoke(browser, baseUrl) {
    const page = await browser.newPage();
    const diagnostics = attachPageDiagnostics(page);
    await page.goto(`${baseUrl}/__smoke_blank`, { waitUntil: 'domcontentloaded', timeout: 15000 });

    const result = await page.evaluate(async () => {
        const { createCollabController } = await import('/scripts/modules/collab/collab-controller.js');

        const nativeAddEventListener = window.addEventListener.bind(window);
        const nativeRemoveEventListener = window.removeEventListener.bind(window);
        const nativeSetTimeout = window.setTimeout.bind(window);
        const nativeClearTimeout = window.clearTimeout.bind(window);
        const onlineOwner = Object.prototype.hasOwnProperty.call(navigator, 'onLine')
            ? navigator
            : Object.getPrototypeOf(navigator);
        const onlineDescriptor = Object.getOwnPropertyDescriptor(onlineOwner, 'onLine');
        let online = false;
        let capturedOnlineHandler = null;
        let onlineListenerCount = 0;
        let deleteCalls = 0;
        let deleteFailuresRemaining = 0;
        const deletedIds = [];
        const backoffTimerIds = new Set();
        let backoffTimers = 0;
        let clearedBackoffTimers = 0;

        window.addEventListener = (type, listener, options) => {
            if (type === 'online') {
                capturedOnlineHandler = listener;
                onlineListenerCount += 1;
            }
            return nativeAddEventListener(type, listener, options);
        };
        window.removeEventListener = (type, listener, options) => {
            if (type === 'online' && listener === capturedOnlineHandler) {
                onlineListenerCount = Math.max(0, onlineListenerCount - 1);
            }
            return nativeRemoveEventListener(type, listener, options);
        };
        window.setTimeout = (callback, ms, ...args) => {
            const id = nativeSetTimeout(callback, ms, ...args);
            if (ms === 300) {
                backoffTimers += 1;
                backoffTimerIds.add(id);
            }
            return id;
        };
        window.clearTimeout = (id) => {
            if (backoffTimerIds.has(id)) {
                clearedBackoffTimers += 1;
                backoffTimerIds.delete(id);
            }
            return nativeClearTimeout(id);
        };
        Object.defineProperty(onlineOwner, 'onLine', {
            configurable: true,
            get: () => online,
        });

        class FakeQuery {
            constructor(table) {
                this.table = table;
                this.isDelete = false;
            }
            upsert(payload) {
                return Promise.resolve({ data: payload || null, error: null });
            }
            delete() {
                this.isDelete = true;
                return this;
            }
            select() {
                return this;
            }
            eq(column, value) {
                if (this.isDelete) {
                    deleteCalls += 1;
                    deletedIds.push(String(value || ''));
                    if (deleteFailuresRemaining > 0) {
                        deleteFailuresRemaining -= 1;
                        return Promise.resolve({ data: null, error: new Error('network timeout') });
                    }
                    return Promise.resolve({ data: null, error: null });
                }
                return this;
            }
            order() {
                return Promise.resolve({ data: [], error: null });
            }
        }

        class FakeChannel {
            constructor(name) {
                this.name = name;
                this.handlers = [];
                this.state = 'joined';
                this.socket = { isConnected: () => true };
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
            track() {
                return Promise.resolve('ok');
            }
            presenceState() {
                return {};
            }
            send() {
                return Promise.resolve('ok');
            }
            httpSend() {
                return Promise.resolve('ok');
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

        let deleteResult = '';
        let retryResult = '';
        let retryDeleteCalls = 0;
        try {
            const controller = await createCollabController({
                supabase,
                user: { id: 'local-user' },
                project: { id: 'project-1', slug: 'project' },
                room: { id: 'room-1', slug: 'room', camera_owner_id: null, camera_state: null },
                displayName: 'Local',
            });

            const pendingDelete = controller
                .deleteAnnotation('annotation-offline')
                .then(() => 'resolved', (err) => `rejected:${err?.message || String(err)}`);
            await Promise.resolve();
            const listenersBeforeDispose = onlineListenerCount;

            await controller.dispose();
            deleteResult = await pendingDelete;
            capturedOnlineHandler?.(new Event('online'));
            await new Promise((resolve) => setTimeout(resolve, 0));

            online = true;
            deleteFailuresRemaining = 1;
            const retryController = await createCollabController({
                supabase,
                user: { id: 'local-user' },
                project: { id: 'project-1', slug: 'project' },
                room: { id: 'room-1', slug: 'room', camera_owner_id: null, camera_state: null },
                displayName: 'Local',
            });
            const deleteCallsBeforeRetry = deleteCalls;
            const retryDelete = retryController
                .deleteAnnotation('annotation-retry')
                .then(() => 'resolved', (err) => `rejected:${err?.message || String(err)}`);
            for (let i = 0; i < 20 && backoffTimers < 1; i += 1) {
                await new Promise((resolve) => nativeSetTimeout(resolve, 0));
            }
            await retryController.dispose();
            retryResult = await retryDelete;
            await new Promise((resolve) => nativeSetTimeout(resolve, 0));
            retryDeleteCalls = deleteCalls - deleteCallsBeforeRetry;

            return {
                deleteResult,
                retryResult,
                retryDeleteCalls,
                backoffTimers,
                clearedBackoffTimers,
                deleteCalls,
                deletedIds,
                listenersBeforeDispose,
                onlineListenerCount,
                removedChannels,
                channelNames: channels.map((channel) => channel.name),
            };
        } finally {
            window.addEventListener = nativeAddEventListener;
            window.removeEventListener = nativeRemoveEventListener;
            window.setTimeout = nativeSetTimeout;
            window.clearTimeout = nativeClearTimeout;
            if (onlineDescriptor) {
                Object.defineProperty(onlineOwner, 'onLine', onlineDescriptor);
            } else {
                delete onlineOwner.onLine;
            }
        }
    });

    assert.equal(result.listenersBeforeDispose, 1, 'Collab delete queue smoke: offline wait listener was not installed');
    assert.equal(result.onlineListenerCount, 0, 'Collab delete queue smoke: offline wait listener leaked after dispose');
    assert.equal(result.deleteResult, 'rejected:Collab controller disposed', 'Collab delete queue smoke: pending delete was not rejected on dispose');
    assert.equal(result.retryResult, 'rejected:Collab controller disposed', 'Collab delete queue smoke: retrying delete was not rejected on dispose');
    assert.equal(result.retryDeleteCalls, 1, 'Collab delete queue smoke: retrying delete should stop after the first failed attempt');
    assert.equal(result.backoffTimers, 1, 'Collab delete queue smoke: retry backoff timer was not scheduled');
    assert.equal(result.clearedBackoffTimers, 1, 'Collab delete queue smoke: retry backoff timer was not cleared on dispose');
    assert.equal(result.deleteCalls, 1, 'Collab delete queue smoke: disposed controller performed a stale delete');
    assert.deepEqual(result.deletedIds, ['annotation-retry'], 'Collab delete queue smoke: stale delete used an annotation id');
    assert.deepEqual(result.removedChannels, result.channelNames, 'Collab delete queue smoke: dispose did not remove all realtime channels');
    diagnostics.assertNoErrors('Collab delete queue dispose smoke');
    await page.close();
}

async function runCameraSyncLifecycleSmoke(browser, baseUrl) {
    const page = await browser.newPage();
    const diagnostics = attachPageDiagnostics(page);
    await page.goto(`${baseUrl}/__smoke_blank`, { waitUntil: 'domcontentloaded', timeout: 15000 });

    const result = await page.evaluate(async () => {
        const { createCameraSyncController } = await import('/scripts/modules/collab/camera-sync.js');

        const unhandled = [];
        const onUnhandled = (event) => {
            event.preventDefault();
            unhandled.push(String(event.reason?.message || event.reason || 'unknown'));
        };
        window.addEventListener('unhandledrejection', onUnhandled);

        function makeVector(x, y, z) {
            return {
                values: [x, y, z],
                toArray() {
                    return this.values.slice();
                },
                set(nx, ny, nz) {
                    this.values = [nx, ny, nz];
                },
            };
        }

        const controls = new EventTarget();
        controls.target = makeVector(0, 0, 0);
        controls.update = () => {
            calls.push('controls:update');
        };
        const camera = {
            position: makeVector(1, 2, 3),
            up: makeVector(0, 1, 0),
            fov: 50,
            zoom: 1,
            near: 0.1,
            far: 1000,
            updateProjectionMatrix: () => {
                calls.push('camera:updateProjectionMatrix');
            },
        };
        const calls = [];
        const immediateCalls = [];
        const immediateControls = new EventTarget();
        immediateControls.target = makeVector(0, 0, 0);
        immediateControls.update = () => {
            immediateCalls.push('controls:update');
        };
        const immediateCamera = {
            position: makeVector(1, 2, 3),
            up: makeVector(0, 1, 0),
            fov: 50,
            zoom: 1,
            near: 0.1,
            far: 1000,
            updateProjectionMatrix: () => {
                immediateCalls.push('camera:updateProjectionMatrix');
            },
        };
        const immediateController = createCameraSyncController({
            camera: immediateCamera,
            controls: immediateControls,
            localUserId: 'local-user',
            requestRender: () => immediateCalls.push('render'),
            idleDelayMs: 10000,
        });
        immediateController.handleRemoteState({
            sender: 'peer-user',
            ts: 1,
            position: [10, 11, 12],
            target: [1, 1, 1],
            up: [0, 1, 0],
            fov: 45,
        });
        const afterImmediateRemote = immediateCamera.position.toArray();
        immediateController.markLocalActivity(true);
        immediateController.handleRemoteState({
            sender: 'peer-user',
            ts: 2,
            position: [20, 21, 22],
            target: [2, 2, 2],
            up: [0, 1, 0],
            fov: 40,
        });
        const afterBusyRemote = immediateCamera.position.toArray();
        immediateController.dispose();
        const collab = {
            broadcastCameraState: async () => {
                calls.push('broadcast');
                throw new Error('broadcast offline');
            },
            persistCameraState: async () => {
                calls.push('persist');
                throw new Error('persist offline');
            },
        };

        const controller = createCameraSyncController({
            camera,
            controls,
            collab,
            localUserId: 'local-user',
            requestRender: () => calls.push('render'),
            broadcastIntervalMs: 20,
            persistIntervalMs: 200,
            idleDelayMs: 200,
        });
        controller.setOwner('local-user');
        await new Promise((resolve) => setTimeout(resolve, 220));
        controls.dispatchEvent(new Event('change'));
        await new Promise((resolve) => setTimeout(resolve, 0));
        await Promise.resolve();
        const beforeDisposeCalls = calls.slice();

        controller.setOwner('peer-user');
        controller.handleRemoteState({
            sender: 'peer-user',
            ts: 500,
            position: ['bad', 5, 6],
            target: [1, 1, 1],
            up: [0, 1, 0],
            fov: 'bad',
        });
        const afterInvalidRemote = {
            position: camera.position.toArray(),
            target: controls.target.toArray(),
            fov: camera.fov,
        };
        controller.handleRemoteState({
            sender: 'peer-user',
            ts: 501,
            position: [11, 11, 11],
            target: [1, 1, 1],
            up: [0, 1, 0],
            fov: 0,
        });
        const afterInvalidFovRemote = {
            position: camera.position.toArray(),
            fov: camera.fov,
        };
        controller.handleRemoteState({
            sender: 'peer-user',
            ts: 502,
            position: [12, 12, 12],
            target: [1, 1, 1],
            up: [0, 1, 0],
            near: 10,
            far: 1,
        });
        const afterInvalidClipRemote = {
            position: camera.position.toArray(),
            near: camera.near,
            far: camera.far,
        };
        controller.handleRemoteState({
            sender: 'peer-user',
            ts: 200,
            position: [4, 5, 6],
            target: [1, 1, 1],
            up: [0, 1, 0],
            fov: 45,
        });
        const afterFreshRemote = camera.position.toArray();
        controller.handleRemoteState({
            sender: 'peer-user',
            ts: 100,
            position: [8, 8, 8],
            target: [2, 2, 2],
            up: [0, 1, 0],
            fov: 35,
        });
        const afterStaleRemote = camera.position.toArray();
        controller.handleRemoteState({
            sender: 'peer-user',
            ts: 300,
            position: [7, 7, 7],
            target: [3, 3, 3],
            up: [0, 1, 0],
            fov: 40,
        });
        const afterNewerRemote = camera.position.toArray();
        controller.handleRemoteState({
            sender: 'peer-user',
            position: [13, 13, 13],
            target: [4, 4, 4],
            up: [0, 1, 0],
            fov: 35,
        });
        const afterUntimestampedRemote = camera.position.toArray();
        const beforeDisposeWithRemoteCalls = calls.slice();

        controller.dispose();
        controller.setOwner('local-user');
        controls.dispatchEvent(new Event('change'));
        controller.handleRemoteState({
            sender: 'peer-user',
            position: [9, 9, 9],
            target: [1, 1, 1],
            up: [0, 1, 0],
            fov: 35,
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
        window.removeEventListener('unhandledrejection', onUnhandled);

        return {
            beforeDisposeCalls,
            beforeDisposeWithRemoteCalls,
            afterDisposeCalls: calls.slice(),
            unhandled,
            afterImmediateRemote,
            afterBusyRemote,
            afterInvalidRemote,
            afterInvalidFovRemote,
            afterInvalidClipRemote,
            afterFreshRemote,
            afterStaleRemote,
            afterNewerRemote,
            afterUntimestampedRemote,
            cameraPosition: camera.position.toArray(),
        };
    });

    assert.deepEqual(result.beforeDisposeCalls, ['broadcast', 'persist'], 'Camera sync smoke: owner change did not send camera updates');
    assert.deepEqual(result.unhandled, [], 'Camera sync smoke: rejected camera sync promises became unhandled');
    assert.deepEqual(result.afterImmediateRemote, [10, 11, 12], 'Camera sync smoke: initial remote state was blocked by idle delay');
    assert.deepEqual(result.afterBusyRemote, [10, 11, 12], 'Camera sync smoke: active local interaction did not block remote state');
    assert.deepEqual(
        result.afterInvalidRemote,
        { position: [1, 2, 3], target: [0, 0, 0], fov: 50 },
        'Camera sync smoke: invalid remote camera payload mutated camera state',
    );
    assert.deepEqual(
        result.afterInvalidFovRemote,
        { position: [1, 2, 3], fov: 50 },
        'Camera sync smoke: invalid remote fov partially mutated camera state',
    );
    assert.deepEqual(
        result.afterInvalidClipRemote,
        { position: [1, 2, 3], near: 0.1, far: 1000 },
        'Camera sync smoke: invalid remote clipping planes partially mutated camera state',
    );
    assert.deepEqual(result.afterFreshRemote, [4, 5, 6], 'Camera sync smoke: fresh remote state was not applied');
    assert.deepEqual(result.afterStaleRemote, [4, 5, 6], 'Camera sync smoke: stale remote state overwrote newer camera state');
    assert.deepEqual(result.afterNewerRemote, [7, 7, 7], 'Camera sync smoke: newer remote state was ignored after stale state');
    assert.deepEqual(result.afterUntimestampedRemote, [7, 7, 7], 'Camera sync smoke: untimestamped stale remote state overwrote timestamped camera state');
    assert.deepEqual(result.afterDisposeCalls, result.beforeDisposeWithRemoteCalls, 'Camera sync smoke: disposed controller still reacted to controls/remote state');
    assert.deepEqual(result.cameraPosition, [7, 7, 7], 'Camera sync smoke: disposed controller applied remote camera state');
    diagnostics.assertNoErrors('Camera sync lifecycle smoke');
    await page.close();
}

async function runVoiceControllerLifecycleSmoke(browser, baseUrl) {
    const page = await browser.newPage();
    const diagnostics = attachPageDiagnostics(page);
    await page.goto(`${baseUrl}/__smoke_blank`, { waitUntil: 'domcontentloaded', timeout: 15000 });

    const result = await page.evaluate(async () => {
        const nativeFetch = globalThis.fetch;
        const roomInstances = [];
        const connectPlans = [];

        class FakeRoom {
            constructor() {
                this.handlers = new Map();
                this.remoteParticipants = new Map();
                this.activeSpeakers = [];
                this.disconnectCalls = 0;
                this.startAudioCalls = 0;
                this.connectCalls = 0;
                this.offCalls = 0;
                this.micCalls = [];
                this.localParticipant = {
                    identity: 'local-user',
                    name: 'Local User',
                    setMicrophoneEnabled: async (enabled) => {
                        this.micCalls.push(!!enabled);
                    },
                };
                roomInstances.push(this);
            }

            on(event, handler) {
                if (!this.handlers.has(event)) this.handlers.set(event, []);
                this.handlers.get(event).push(handler);
            }

            off(event, handler) {
                this.offCalls += 1;
                const handlers = this.handlers.get(event) || [];
                this.handlers.set(event, handlers.filter((entry) => entry !== handler));
            }

            handlerCount() {
                let count = 0;
                this.handlers.forEach((handlers) => {
                    count += handlers.length;
                });
                return count;
            }

            emit(event, ...args) {
                (this.handlers.get(event) || []).forEach((handler) => handler(...args));
            }

            async connect() {
                this.connectCalls += 1;
                const plan = connectPlans.shift();
                if (plan) {
                    plan.started?.();
                    await plan.promise;
                }
            }

            async startAudio() {
                this.startAudioCalls += 1;
            }

            async disconnect() {
                this.disconnectCalls += 1;
                this.emit('Disconnected');
            }
        }

        window.LivekitClient = {
            Room: FakeRoom,
            RoomEvent: {
                ParticipantConnected: 'ParticipantConnected',
                ParticipantDisconnected: 'ParticipantDisconnected',
                ActiveSpeakersChanged: 'ActiveSpeakersChanged',
                LocalTrackPublished: 'LocalTrackPublished',
                LocalTrackUnpublished: 'LocalTrackUnpublished',
                TrackMuted: 'TrackMuted',
                TrackUnmuted: 'TrackUnmuted',
                ConnectionStateChanged: 'ConnectionStateChanged',
                TrackSubscribed: 'TrackSubscribed',
                TrackUnsubscribed: 'TrackUnsubscribed',
                Disconnected: 'Disconnected',
            },
            Track: { Kind: { Audio: 'audio' } },
        };

        const resolvingTokenFetch = async () => ({
            ok: true,
            json: async () => ({ token: 'token', wsUrl: 'wss://voice.example', room: 'voice-room' }),
        });
        globalThis.fetch = resolvingTokenFetch;

        try {
            const { createVoiceController } = await import('/scripts/modules/voice/voice-controller.js');

            let releaseConnect = null;
            const connectStarted = new Promise((resolve) => {
                connectPlans.push({
                    started: resolve,
                    promise: new Promise((connectResolve) => {
                        releaseConnect = connectResolve;
                    }),
                });
            });

            const states = [];
            const controller = createVoiceController({
                voiceApiUrl: 'https://voice.example',
                onState: (state) => states.push({
                    connected: !!state.connected,
                    connecting: !!state.connecting,
                    micEnabled: !!state.micEnabled,
                    reason: state.reason || '',
                    error: state.error || '',
                }),
            });

            const connectResultPromise = controller
                .connect({ room: 'room:one', identity: 'local-user', name: 'Local User' })
                .then(() => 'resolved', (err) => `rejected:${err?.message || String(err)}`);
            await connectStarted;
            const staleRoom = roomInstances[0];
            await controller.disconnect();
            const staleHandlersAfterDisconnect = staleRoom?.handlerCount?.() ?? -1;
            releaseConnect();
            const connectResult = await connectResultPromise;
            const statesAfterRace = states.slice();

            let tokenAbortSignal = null;
            let resolveTokenFetchStarted = null;
            const tokenFetchStarted = new Promise((resolve) => {
                resolveTokenFetchStarted = resolve;
            });
            globalThis.fetch = (_url, options = {}) => new Promise((_resolve, reject) => {
                tokenAbortSignal = options.signal || null;
                resolveTokenFetchStarted();
                tokenAbortSignal?.addEventListener?.('abort', () => {
                    reject(tokenAbortSignal.reason || new DOMException('voice token aborted', 'AbortError'));
                }, { once: true });
            });
            const tokenAbortRoomCountBefore = roomInstances.length;
            const tokenAbortController = createVoiceController({
                voiceApiUrl: 'https://voice.example',
                onState: () => {},
            });
            const tokenAbortResultPromise = tokenAbortController
                .connect({ room: 'room:token-abort', identity: 'local-user', name: 'Local User' })
                .then(() => 'resolved', (err) => `rejected:${err?.name || ''}:${err?.message || String(err)}`);
            await tokenFetchStarted;
            const tokenFetchHadSignal = !!tokenAbortSignal;
            await tokenAbortController.disconnect();
            const tokenFetchAborted = !!tokenAbortSignal?.aborted;
            const tokenAbortResult = await tokenAbortResultPromise;
            const tokenAbortRoomCreated = roomInstances.length > tokenAbortRoomCountBefore;
            globalThis.fetch = resolvingTokenFetch;

            let rejectStaleConnect = null;
            const staleRejectStarted = new Promise((resolve) => {
                connectPlans.push({
                    started: resolve,
                    promise: new Promise((_connectResolve, connectReject) => {
                        rejectStaleConnect = () => connectReject(new Error('stale voice connect failed'));
                    }),
                });
            });
            const staleRejectAudioMount = document.createElement('div');
            document.body.appendChild(staleRejectAudioMount);
            let staleRejectDetachCalls = 0;
            const staleRejectController = createVoiceController({
                voiceApiUrl: 'https://voice.example',
                audioMountEl: staleRejectAudioMount,
                onState: () => {},
            });
            const staleRejectResultPromise = staleRejectController
                .connect({ room: 'room:stale-reject', identity: 'local-user', name: 'Local User' })
                .then(() => 'resolved', (err) => `rejected:${err?.message || String(err)}`);
            await staleRejectStarted;
            const staleRejectOldRoom = roomInstances.at(-1);
            await staleRejectController.disconnect();
            const staleRejectOldHandlersAfterDisconnect = staleRejectOldRoom?.handlerCount?.() ?? -1;
            await staleRejectController.connect({ room: 'room:current', identity: 'local-user', name: 'Local User' });
            const currentVoiceRoom = roomInstances.at(-1);
            currentVoiceRoom.emit('TrackSubscribed', {
                kind: 'audio',
                attach: () => document.createElement('audio'),
                detach: () => {
                    staleRejectDetachCalls += 1;
                },
            }, { kind: 'audio', trackSid: 'current-audio' });
            const staleRejectAudioBeforeOldFailure = staleRejectAudioMount.children.length;
            rejectStaleConnect?.();
            const staleRejectResult = await staleRejectResultPromise;
            await Promise.resolve();
            const staleRejectAudioAfterOldFailure = staleRejectAudioMount.children.length;
            const staleRejectDetachBeforeDispose = staleRejectDetachCalls;
            await staleRejectController.dispose();
            const staleRejectCurrentHandlersAfterDispose = currentVoiceRoom?.handlerCount?.() ?? -1;

            const audioMount = document.createElement('div');
            document.body.appendChild(audioMount);
            let detachCalls = 0;
            let attachCalls = 0;
            const controllerWithAudio = createVoiceController({
                voiceApiUrl: 'https://voice.example',
                audioMountEl: audioMount,
                onState: () => {},
            });
            await controllerWithAudio.connect({ room: 'room:two', identity: 'local-user', name: 'Local User' });
            const audioRoom = roomInstances.at(-1);
            const publicationWithoutSid = { kind: 'audio' };
            const trackWithoutSid = {
                kind: 'audio',
                attach: () => {
                    attachCalls += 1;
                    return document.createElement('audio');
                },
                detach: () => {
                    detachCalls += 1;
                },
            };
            audioRoom.emit('TrackSubscribed', trackWithoutSid, publicationWithoutSid);
            const audioChildrenAfterAttach = audioMount.children.length;
            audioRoom.emit('TrackUnsubscribed', trackWithoutSid, publicationWithoutSid);
            const audioChildrenAfterDetach = audioMount.children.length;
            await controllerWithAudio.dispose();
            const audioRoomHandlersAfterDispose = audioRoom?.handlerCount?.() ?? -1;

            return {
                connectResult,
                statesAfterRace,
                staleDisconnectCalls: staleRoom?.disconnectCalls || 0,
                staleHandlersAfterDisconnect,
                staleMicCalls: staleRoom?.micCalls || [],
                staleStartAudioCalls: staleRoom?.startAudioCalls || 0,
                tokenFetchHadSignal,
                tokenFetchAborted,
                tokenAbortResult,
                tokenAbortRoomCreated,
                staleRejectResult,
                staleRejectAudioBeforeOldFailure,
                staleRejectAudioAfterOldFailure,
                staleRejectDetachBeforeDispose,
                staleRejectOldHandlersAfterDisconnect,
                staleRejectCurrentHandlersAfterDispose,
                audioChildrenAfterAttach,
                audioChildrenAfterDetach,
                audioRoomHandlersAfterDispose,
                attachCalls,
                detachCalls,
            };
        } finally {
            globalThis.fetch = nativeFetch;
            delete window.LivekitClient;
        }
    });

    assert.equal(result.connectResult, 'resolved', 'Voice controller smoke: cancelled connect rejected');
    assert.equal(result.staleDisconnectCalls >= 1, true, 'Voice controller smoke: stale connecting room was not disconnected');
    assert.equal(result.staleHandlersAfterDisconnect, 0, 'Voice controller smoke: stale room event handlers leaked after disconnect');
    assert.deepEqual(result.staleMicCalls, [], 'Voice controller smoke: stale connect enabled the microphone');
    assert.equal(result.staleStartAudioCalls, 0, 'Voice controller smoke: stale connect started audio');
    assert.equal(
        result.statesAfterRace.some((state) => state.connected || state.micEnabled),
        false,
        'Voice controller smoke: stale connect reported connected state after disconnect',
    );
    assert.equal(result.tokenFetchHadSignal, true, 'Voice controller smoke: token request did not receive an abort signal');
    assert.equal(result.tokenFetchAborted, true, 'Voice controller smoke: token request was not aborted on disconnect');
    assert.equal(result.tokenAbortResult, 'resolved', 'Voice controller smoke: aborted token request rejected stale connect');
    assert.equal(result.tokenAbortRoomCreated, false, 'Voice controller smoke: aborted token request still created a room');
    assert.equal(result.staleRejectResult, 'resolved', 'Voice controller smoke: stale rejected connect propagated after reconnect');
    assert.equal(result.staleRejectAudioBeforeOldFailure, 1, 'Voice controller smoke: current room audio was not attached before stale failure');
    assert.equal(result.staleRejectAudioAfterOldFailure, 1, 'Voice controller smoke: stale connect failure cleared current room audio');
    assert.equal(result.staleRejectDetachBeforeDispose, 0, 'Voice controller smoke: stale connect failure detached current room audio');
    assert.equal(result.staleRejectOldHandlersAfterDisconnect, 0, 'Voice controller smoke: stale rejected room handlers leaked after disconnect');
    assert.equal(result.staleRejectCurrentHandlersAfterDispose, 0, 'Voice controller smoke: current room handlers leaked after dispose');
    assert.equal(result.audioChildrenAfterAttach, 1, 'Voice controller smoke: audio track was not attached');
    assert.equal(result.audioChildrenAfterDetach, 0, 'Voice controller smoke: fallback track key leaked attached audio element');
    assert.equal(result.audioRoomHandlersAfterDispose, 0, 'Voice controller smoke: audio room handlers leaked after dispose');
    assert.equal(result.attachCalls, 1, 'Voice controller smoke: audio track attach count mismatch');
    assert.equal(result.detachCalls, 1, 'Voice controller smoke: audio track detach count mismatch');
    diagnostics.assertNoErrors('Voice controller lifecycle smoke');
    await page.close();
}

async function runVRDisposeLifecycleSmoke(browser, baseUrl) {
    const page = await browser.newPage();
    const diagnostics = attachPageDiagnostics(page);
    await page.goto(`${baseUrl}/__smoke_blank`, { waitUntil: 'domcontentloaded', timeout: 15000 });

    const result = await page.evaluate(async () => {
        const THREE = await import('three');
        const { createVRController } = await import('/scripts/modules/vr/vr-controller.js');

        class FakeSession extends EventTarget {
            constructor(label) {
                super();
                this.label = label;
                this.inputSources = [];
                this.ended = 0;
                this.removedEndListeners = 0;
            }
            removeEventListener(type, handler, opts) {
                if (type === 'end') this.removedEndListeners += 1;
                return super.removeEventListener(type, handler, opts);
            }
            end() {
                this.ended += 1;
                this.dispatchEvent(new Event('end'));
                return Promise.resolve();
            }
        }

        function makeRenderer(ref, events) {
            const xr = {
                enabled: false,
                isPresenting: false,
                getSession: () => ref.current,
                getController: () => null,
                getControllerGrip: () => null,
                setReferenceSpaceType: (type) => events.push(`reference:${type}`),
                setSession: async (session) => {
                    events.push(`setSession:${session?.label || 'null'}`);
                    ref.current = session;
                    xr.isPresenting = !!session;
                },
                updateCamera: () => {},
            };
            return { xr };
        }

        function makeHarness(label, xrApi, options = {}) {
            const scene = new THREE.Scene();
            const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
            camera.position.set(0, 1.6, 4);
            scene.add(camera);
            const loadedModels = Array.isArray(options.loadedModels) ? options.loadedModels : [];
            loadedModels.forEach((model) => {
                if (model?.obj && !model.obj.parent) {
                    scene.add(model.obj);
                }
            });
            const sessionRef = { current: null };
            const events = [];
            const controls = {
                enabled: options.controlsEnabled !== false,
                target: new THREE.Vector3(0, 1.6, 0),
                update: () => events.push(`${label}:controls:update`),
            };
            const button = document.createElement('button');
            document.body.appendChild(button);
            const controller = createVRController({
                THREE,
                scene,
                renderer: makeRenderer(sessionRef, events),
                camera,
                controls,
                loadedModels,
                sceneIndex: options.sceneIndex,
                vrToggleBtn: button,
                window: { navigator: { xr: xrApi, userAgent: 'Smoke' } },
                document,
                requestRender: () => events.push(`${label}:render`),
            });
            return { scene, camera, controls, button, controller, sessionRef, events, loadedModels };
        }

        function makeCollisionModel(label) {
            const geometry = new THREE.BoxGeometry(1, 1, 1);
            const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
            mesh.name = `${label}:collision`;
            const originalRaycast = mesh.raycast;
            const root = new THREE.Group();
            root.name = `${label}:root`;
            root.add(mesh);
            return {
                model: { obj: root, zipKind: 'SM' },
                mesh,
                geometry,
                originalRaycast,
            };
        }

        const activeCollider = makeCollisionModel('active-a');
        const switchedCollider = makeCollisionModel('active-b');
        const collisionMap = new Map([
            [activeCollider.model, [activeCollider.mesh]],
            [switchedCollider.model, [switchedCollider.mesh]],
        ]);
        const activeSession = new FakeSession('active');
        let activeRequestCount = 0;
        const active = makeHarness('active', {
            isSessionSupported: async () => true,
            requestSession: async () => {
                activeRequestCount += 1;
                return activeSession;
            },
        }, {
            loadedModels: [activeCollider.model],
            sceneIndex: {
                getModelCollisions: (model) => collisionMap.get(model) || [],
            },
        });
        const entered = await active.controller.enterVR();
        const activeCameraInRig = active.camera.parent?.name === 'XRUserRig';
        const activeControlsDisabled = active.controls.enabled === false;
        const bodyClassDuringVR = document.body.classList.contains('vr-ui-active');
        const activeBvhCreated = !!activeCollider.geometry.boundsTree;
        const activeRaycastPatched = activeCollider.mesh.raycast !== activeCollider.originalRaycast;
        active.scene.add(switchedCollider.model.obj);
        active.loadedModels.splice(0, active.loadedModels.length, switchedCollider.model);
        active.controller.update();
        const switchOldBvhDisposed = !activeCollider.geometry.boundsTree;
        const switchOldRaycastRestored = activeCollider.mesh.raycast === activeCollider.originalRaycast;
        const switchOldMarkerCleared = !activeCollider.mesh.userData?._vrBvhPrepared;
        const switchNewBvhCreated = !!switchedCollider.geometry.boundsTree;
        const switchNewRaycastPatched = switchedCollider.mesh.raycast !== switchedCollider.originalRaycast;
        active.controller.dispose();
        const switchNewBvhDisposed = !switchedCollider.geometry.boundsTree;
        const switchNewRaycastRestored = switchedCollider.mesh.raycast === switchedCollider.originalRaycast;
        const switchNewMarkerCleared = !switchedCollider.mesh.userData?._vrBvhPrepared;
        const activeRequestCountBeforeClick = activeRequestCount;
        active.button.click();
        await Promise.resolve();

        const concurrentSession = new FakeSession('concurrent');
        let concurrentRequestCount = 0;
        const concurrent = makeHarness('concurrent', {
            isSessionSupported: async () => true,
            requestSession: async () => {
                concurrentRequestCount += 1;
                await Promise.resolve();
                return concurrentSession;
            },
        });
        const concurrentFirstEnter = concurrent.controller.enterVR();
        const concurrentSecondEnter = concurrent.controller.enterVR();
        const [concurrentFirstResult, concurrentSecondResult] = await Promise.all([
            concurrentFirstEnter,
            concurrentSecondEnter,
        ]);
        const concurrentSetSessionCalls = concurrent.events
            .filter((entry) => entry === 'setSession:concurrent')
            .length;
        concurrent.controller.dispose();

        let failedRequestCount = 0;
        const failed = makeHarness('failed', {
            isSessionSupported: async () => true,
            requestSession: async () => {
                failedRequestCount += 1;
                throw new Error('denied');
            },
        });
        let failedEnterError = '';
        try {
            await failed.controller.enterVR();
        } catch (err) {
            failedEnterError = String(err?.message || err || '');
        }

        let releasePendingSession = null;
        let pendingRequestCount = 0;
        const pendingSession = new FakeSession('pending');
        const requestStarted = new Promise((resolve) => {
            const pending = makeHarness('pending', {
                isSessionSupported: async () => true,
                requestSession: async () => {
                    pendingRequestCount += 1;
                    resolve(pending);
                    return new Promise((sessionResolve) => {
                        releasePendingSession = () => sessionResolve(pendingSession);
                    });
                },
            }, { controlsEnabled: false });
            globalThis.__vrPendingHarness = pending;
            void pending.controller.enterVR().then((value) => {
                pending.events.push(`enterResult:${value}`);
            });
        });
        const pending = await requestStarted;
        const pendingCameraInRigBeforeDispose = pending.camera.parent?.name === 'XRUserRig';
        pending.controller.dispose();
        releasePendingSession();
        for (let i = 0; i < 10 && !pending.events.includes('enterResult:false'); i += 1) {
            await Promise.resolve();
        }
        delete globalThis.__vrPendingHarness;

        return {
            entered,
            activeCameraInRig,
            activeControlsDisabled,
            bodyClassDuringVR,
            activeBvhCreated,
            activeRaycastPatched,
            switchOldBvhDisposed,
            switchOldRaycastRestored,
            switchOldMarkerCleared,
            switchNewBvhCreated,
            switchNewRaycastPatched,
            switchNewBvhDisposed,
            switchNewRaycastRestored,
            switchNewMarkerCleared,
            activeSessionEnded: activeSession.ended,
            activeEndListenerRemoved: activeSession.removedEndListeners > 0,
            activeCameraRestored: active.camera.parent === active.scene,
            activeRigRemoved: active.scene.getObjectByName('XRUserRig') == null,
            activeControlsRestored: active.controls.enabled === true,
            activeBodyClassCleared: !document.body.classList.contains('vr-ui-active'),
            activeRequestCountBeforeClick,
            activeRequestCountAfterClick: activeRequestCount,
            activeIsPresentingAfterDispose: active.controller.isPresenting(),
            concurrentRequestCount,
            concurrentFirstResult,
            concurrentSecondResult,
            concurrentSetSessionCalls,
            concurrentSessionEnded: concurrentSession.ended,
            failedRequestCount,
            failedEnterError,
            failedCameraRestored: failed.camera.parent === failed.scene,
            failedRigRemoved: failed.scene.getObjectByName('XRUserRig') == null,
            failedControlsRestored: failed.controls.enabled === true,
            failedBodyClassCleared: !document.body.classList.contains('vr-ui-active'),
            failedIsPresenting: failed.controller.isPresenting(),
            pendingRequestCount,
            pendingCameraInRigBeforeDispose,
            pendingSessionEnded: pendingSession.ended,
            pendingSetSessionCalled: pending.events.some((entry) => entry.startsWith('setSession:')),
            pendingCameraRestored: pending.camera.parent === pending.scene,
            pendingRigRemoved: pending.scene.getObjectByName('XRUserRig') == null,
            pendingEnterResolvedFalse: pending.events.includes('enterResult:false'),
            pendingControlsRestored: pending.controls.enabled === false,
        };
    });

    assert.equal(result.entered, true, 'VR dispose smoke: active session did not enter');
    assert.equal(result.activeCameraInRig, true, 'VR dispose smoke: camera was not attached to XR rig');
    assert.equal(result.activeControlsDisabled, true, 'VR dispose smoke: controls stayed enabled during VR');
    assert.equal(result.bodyClassDuringVR, true, 'VR dispose smoke: body VR class was not set');
    assert.equal(result.activeBvhCreated, true, 'VR dispose smoke: collider BVH was not created on enter');
    assert.equal(result.activeRaycastPatched, true, 'VR dispose smoke: collider raycast was not accelerated on enter');
    assert.equal(result.switchOldBvhDisposed, true, 'VR dispose smoke: stale collider BVH survived model switch');
    assert.equal(result.switchOldRaycastRestored, true, 'VR dispose smoke: stale collider raycast was not restored on model switch');
    assert.equal(result.switchOldMarkerCleared, true, 'VR dispose smoke: stale collider VR marker survived model switch');
    assert.equal(result.switchNewBvhCreated, true, 'VR dispose smoke: replacement collider BVH was not created');
    assert.equal(result.switchNewRaycastPatched, true, 'VR dispose smoke: replacement collider raycast was not accelerated');
    assert.equal(result.switchNewBvhDisposed, true, 'VR dispose smoke: active collider BVH survived controller dispose');
    assert.equal(result.switchNewRaycastRestored, true, 'VR dispose smoke: active collider raycast was not restored on dispose');
    assert.equal(result.switchNewMarkerCleared, true, 'VR dispose smoke: active collider VR marker survived dispose');
    assert.equal(result.activeSessionEnded, 1, 'VR dispose smoke: active session was not ended on dispose');
    assert.equal(result.activeEndListenerRemoved, true, 'VR dispose smoke: active end listener was not removed on dispose');
    assert.equal(result.activeCameraRestored, true, 'VR dispose smoke: camera stayed attached to XR rig after dispose');
    assert.equal(result.activeRigRemoved, true, 'VR dispose smoke: XR rig stayed in scene after dispose');
    assert.equal(result.activeControlsRestored, true, 'VR dispose smoke: controls were not restored after dispose');
    assert.equal(result.activeBodyClassCleared, true, 'VR dispose smoke: body VR class stayed after dispose');
    assert.equal(result.activeRequestCountAfterClick, result.activeRequestCountBeforeClick, 'VR dispose smoke: disposed button listener started a new session');
    assert.equal(result.activeIsPresentingAfterDispose, false, 'VR dispose smoke: disposed controller still reports presenting');
    assert.equal(result.concurrentRequestCount, 1, 'VR dispose smoke: concurrent enterVR calls opened duplicate WebXR sessions');
    assert.equal(result.concurrentFirstResult, true, 'VR dispose smoke: first concurrent enterVR did not resolve true');
    assert.equal(result.concurrentSecondResult, true, 'VR dispose smoke: second concurrent enterVR did not share the active enter result');
    assert.equal(result.concurrentSetSessionCalls, 1, 'VR dispose smoke: concurrent enterVR calls installed duplicate renderer sessions');
    assert.equal(result.concurrentSessionEnded, 1, 'VR dispose smoke: concurrent session was not ended on dispose');
    assert.equal(result.failedRequestCount, 1, 'VR dispose smoke: failed enter did not request a session');
    assert.equal(result.failedEnterError, 'denied', 'VR dispose smoke: failed enter swallowed the request error');
    assert.equal(result.failedCameraRestored, true, 'VR dispose smoke: failed enter left camera attached to XR rig');
    assert.equal(result.failedRigRemoved, true, 'VR dispose smoke: failed enter left XR rig in scene');
    assert.equal(result.failedControlsRestored, true, 'VR dispose smoke: failed enter did not restore controls');
    assert.equal(result.failedBodyClassCleared, true, 'VR dispose smoke: failed enter left body VR class active');
    assert.equal(result.failedIsPresenting, false, 'VR dispose smoke: failed enter reports presenting');
    assert.equal(result.pendingRequestCount, 1, 'VR dispose smoke: pending session request did not start');
    assert.equal(result.pendingCameraInRigBeforeDispose, true, 'VR dispose smoke: pending enter did not attach camera before request');
    assert.equal(result.pendingSessionEnded, 1, 'VR dispose smoke: pending session was not ended after dispose');
    assert.equal(result.pendingSetSessionCalled, false, 'VR dispose smoke: disposed pending session was still installed on renderer');
    assert.equal(result.pendingCameraRestored, true, 'VR dispose smoke: pending dispose did not restore camera');
    assert.equal(result.pendingRigRemoved, true, 'VR dispose smoke: pending dispose left XR rig in scene');
    assert.equal(result.pendingEnterResolvedFalse, true, 'VR dispose smoke: pending enter did not resolve false after dispose');
    assert.equal(result.pendingControlsRestored, true, 'VR dispose smoke: pending dispose did not restore pre-existing disabled controls');
    diagnostics.assertNoErrors('VR dispose lifecycle smoke');
    await page.close();
}

async function runRoomModelLoadQueueSmoke(browser, baseUrl) {
    const page = await browser.newPage();
    const diagnostics = attachPageDiagnostics(page);
    await page.goto(`${baseUrl}/__smoke_blank`, { waitUntil: 'domcontentloaded', timeout: 15000 });

    const result = await page.evaluate(async () => {
        const { createRoomModelLoadQueue } = await import('/scripts/modules/collab/room-model-load-queue.js');

        let currentGeneration = 1;
        let currentActiveRequestGeneration = 0;
        const events = [];
        const errors = [];
        const releases = new Map();
        const starts = new Map();

        const waitForStart = (id) => {
            if (starts.has(id)) return starts.get(id).promise;
            let resolve = null;
            const promise = new Promise((nextResolve) => {
                resolve = nextResolve;
            });
            starts.set(id, { promise, resolve });
            return promise;
        };

        const markStart = (id) => {
            if (!starts.has(id)) void waitForStart(id);
            starts.get(id).resolve();
        };
        const eventCount = (entry) => events.filter((value) => value === entry).length;
        const waitForEventCount = async (entry, count) => {
            for (let i = 0; i < 20 && eventCount(entry) < count; i += 1) {
                await Promise.resolve();
            }
        };

        const queue = createRoomModelLoadQueue({
            isCurrent: ({ generation, roomId, activeRequestGeneration = 0 }) => (
                generation === currentGeneration
                && roomId === 'room-1'
                && (!activeRequestGeneration || activeRequestGeneration === currentActiveRequestGeneration)
            ),
            loadModelNow: async (model) => {
                const id = String(model?.id || '');
                events.push(`start:${id}`);
                markStart(id);
                if (
                    id === 'A'
                    || id === 'C'
                    || id === 'BLOCKED'
                    || id === 'AFTER_RESET'
                    || id === 'ACTIVE_STALE'
                    || id === 'SAME_KEY'
                    || id === 'STALE_ERROR'
                    || id === 'AFTER_STALE_ERROR'
                    || id === 'WAIT_A'
                    || id === 'WAIT_ACTIVE'
                ) {
                    await new Promise((resolve) => {
                        releases.set(id, resolve);
                    });
                }
                if (id === 'STALE_ERROR') {
                    events.push(`fail:${id}`);
                    throw new Error('stale room model load failed');
                }
                events.push(`done:${id}`);
                return true;
            },
            onError: (err, { context } = {}) => {
                errors.push(`${context?.modelId || ''}:${err?.message || err}`);
            },
        });

        const firstLoad = queue.load({ id: 'A' }, { roomId: 'room-1', generation: 1 });
        await waitForStart('A');
        const secondLoadResult = await queue.load({ id: 'B' }, { roomId: 'room-1', generation: 1 });
        const staleLoadResult = await queue.load({ id: 'STALE' }, { roomId: 'room-1', generation: 2 });
        const pendingDuringActive = queue.getPendingModelIds();
        releases.get('A')();
        const firstLoadResult = await firstLoad;
        await waitForStart('B');

        currentGeneration = 2;
        const thirdLoad = queue.load({ id: 'C' }, { roomId: 'room-1', generation: 2 });
        await waitForStart('C');
        const removedBeforeDrain = queue.load({ id: 'D' }, { roomId: 'room-1', generation: 2 });
        const deletedPending = queue.delete({ roomId: 'room-1', modelId: 'D' });
        releases.get('C')();
        const thirdLoadResult = await thirdLoad;
        const removedLoadResult = await removedBeforeDrain;

        currentGeneration = 3;
        const blockedLoad = queue.load({ id: 'BLOCKED' }, { roomId: 'room-1', generation: 3 });
        await waitForStart('BLOCKED');
        const queuedBeforeResetResult = await queue.load({ id: 'BEFORE_RESET' }, { roomId: 'room-1', generation: 3 });
        currentGeneration = 4;
        queue.reset();
        const afterResetLoad = queue.load({ id: 'AFTER_RESET' }, { roomId: 'room-1', generation: 4 });
        await waitForStart('AFTER_RESET');
        const afterResetStartedBeforeBlockedDone = events.includes('start:AFTER_RESET')
            && !events.includes('done:BLOCKED');
        releases.get('BLOCKED')();
        releases.get('AFTER_RESET')();
        const blockedLoadResult = await blockedLoad;
        const afterResetLoadResult = await afterResetLoad;

        currentGeneration = 5;
        currentActiveRequestGeneration = 1;
        const activeStaleLoad = queue.load(
            { id: 'ACTIVE_STALE' },
            { roomId: 'room-1', generation: 5, activeRequestGeneration: 1 },
        );
        await waitForStart('ACTIVE_STALE');
        currentActiveRequestGeneration = 2;
        releases.get('ACTIVE_STALE')();
        const activeStaleLoadResult = await activeStaleLoad;
        const activeFreshLoadResult = await queue.load(
            { id: 'ACTIVE_FRESH' },
            { roomId: 'room-1', generation: 5, activeRequestGeneration: 2 },
        );

        currentGeneration = 6;
        currentActiveRequestGeneration = 10;
        const sameKeyStaleLoad = queue.load(
            { id: 'SAME_KEY' },
            { roomId: 'room-1', generation: 6, activeRequestGeneration: 10 },
        );
        await waitForStart('SAME_KEY');
        currentActiveRequestGeneration = 11;
        const sameKeyFreshQueuedResult = await queue.load(
            { id: 'SAME_KEY' },
            { roomId: 'room-1', generation: 6, activeRequestGeneration: 11 },
        );
        const sameKeyPendingDuringStale = queue.getPendingModelIds();
        releases.get('SAME_KEY')();
        await waitForEventCount('start:SAME_KEY', 2);
        const sameKeyStartCount = eventCount('start:SAME_KEY');
        releases.get('SAME_KEY')?.();
        const sameKeyStaleLoadResult = await sameKeyStaleLoad;

        const eventsBeforeStaleErrorScenario = events.slice();
        const errorsBeforeStaleErrorScenario = errors.slice();

        currentGeneration = 7;
        const staleErrorLoad = queue.load(
            { id: 'STALE_ERROR' },
            { roomId: 'room-1', generation: 7 },
        );
        await waitForStart('STALE_ERROR');
        currentGeneration = 8;
        queue.reset();
        const afterStaleErrorLoad = queue.load(
            { id: 'AFTER_STALE_ERROR' },
            { roomId: 'room-1', generation: 8 },
        );
        await waitForStart('AFTER_STALE_ERROR');
        const afterStaleErrorStartedBeforeFailure = events.includes('start:AFTER_STALE_ERROR')
            && !events.includes('fail:STALE_ERROR');
        releases.get('STALE_ERROR')();
        releases.get('AFTER_STALE_ERROR')();
        const staleErrorLoadResult = await staleErrorLoad;
        const afterStaleErrorLoadResult = await afterStaleErrorLoad;

        currentGeneration = 9;
        const waitFirstLoad = queue.load({ id: 'WAIT_A' }, { roomId: 'room-1', generation: 9 });
        await waitForStart('WAIT_A');
        let waitSecondSettled = false;
        const waitSecondLoad = queue.loadAndWait({ id: 'WAIT_B' }, { roomId: 'room-1', generation: 9 })
            .finally(() => {
                waitSecondSettled = true;
            });
        await Promise.resolve();
        const waitSecondSettledBeforeRelease = waitSecondSettled;
        releases.get('WAIT_A')();
        const waitFirstLoadResult = await waitFirstLoad;
        const waitSecondLoadResult = await waitSecondLoad;

        currentGeneration = 10;
        const waitActiveLoad = queue.load({ id: 'WAIT_ACTIVE' }, { roomId: 'room-1', generation: 10 });
        await waitForStart('WAIT_ACTIVE');
        let waitActiveSameSettled = false;
        const waitActiveSameLoad = queue.loadAndWait({ id: 'WAIT_ACTIVE' }, { roomId: 'room-1', generation: 10 })
            .finally(() => {
                waitActiveSameSettled = true;
            });
        await Promise.resolve();
        const waitActiveSameSettledBeforeRelease = waitActiveSameSettled;
        releases.get('WAIT_ACTIVE')();
        const waitActiveLoadResult = await waitActiveLoad;
        const waitActiveSameLoadResult = await waitActiveSameLoad;
        const waitActiveStartCount = eventCount('start:WAIT_ACTIVE');

        return {
            events,
            eventsBeforeStaleErrorScenario,
            errors,
            errorsBeforeStaleErrorScenario,
            firstLoadResult,
            secondLoadResult,
            staleLoadResult,
            thirdLoadResult,
            removedLoadResult,
            queuedBeforeResetResult,
            blockedLoadResult,
            afterResetLoadResult,
            activeStaleLoadResult,
            activeFreshLoadResult,
            sameKeyFreshQueuedResult,
            sameKeyPendingDuringStale,
            sameKeyStartCount,
            sameKeyStaleLoadResult,
            staleErrorLoadResult,
            afterStaleErrorLoadResult,
            waitFirstLoadResult,
            waitSecondLoadResult,
            waitSecondSettledBeforeRelease,
            waitActiveLoadResult,
            waitActiveSameLoadResult,
            waitActiveSameSettledBeforeRelease,
            waitActiveStartCount,
            afterResetStartedBeforeBlockedDone,
            afterStaleErrorStartedBeforeFailure,
            pendingDuringActive,
            deletedPending,
            pendingAfter: queue.getPendingModelIds(),
            activeAfter: queue.isActive(),
        };
    });

    assert.equal(result.firstLoadResult, true, 'Room model queue smoke: first load did not complete');
    assert.equal(result.secondLoadResult, false, 'Room model queue smoke: concurrent load should be queued');
    assert.equal(result.staleLoadResult, false, 'Room model queue smoke: stale load should be ignored');
    assert.equal(result.thirdLoadResult, true, 'Room model queue smoke: next generation load did not complete');
    assert.equal(result.removedLoadResult, false, 'Room model queue smoke: queued load should resolve false immediately');
    assert.equal(result.queuedBeforeResetResult, false, 'Room model queue smoke: pre-reset queued load should resolve false immediately');
    assert.equal(result.blockedLoadResult, false, 'Room model queue smoke: reset active load still reported success');
    assert.equal(result.afterResetLoadResult, true, 'Room model queue smoke: reset generation load did not finish');
    assert.equal(result.activeStaleLoadResult, false, 'Room model queue smoke: stale active-model request still reported success');
    assert.equal(result.activeFreshLoadResult, true, 'Room model queue smoke: fresh active-model request did not load');
    assert.equal(result.sameKeyFreshQueuedResult, false, 'Room model queue smoke: same-key fresh active request should queue behind stale active load');
    assert.equal(result.sameKeyStaleLoadResult, false, 'Room model queue smoke: same-key stale active load still reported success');
    assert.deepEqual(result.sameKeyPendingDuringStale, ['SAME_KEY'], 'Room model queue smoke: same-key fresh active request was not queued');
    assert.equal(result.sameKeyStartCount, 2, 'Room model queue smoke: same-key fresh active request was lost behind stale active load');
    assert.equal(result.staleErrorLoadResult, false, 'Room model queue smoke: stale failing load should resolve false');
    assert.equal(result.afterStaleErrorLoadResult, true, 'Room model queue smoke: post-reset load did not finish after stale failure');
    assert.equal(result.waitFirstLoadResult, true, 'Room model queue smoke: loadAndWait setup load did not finish');
    assert.equal(result.waitSecondLoadResult, true, 'Room model queue smoke: loadAndWait queued load did not finish');
    assert.equal(result.waitSecondSettledBeforeRelease, false, 'Room model queue smoke: loadAndWait resolved before active load finished');
    assert.equal(result.waitActiveLoadResult, true, 'Room model queue smoke: same-key active load did not finish');
    assert.equal(result.waitActiveSameLoadResult, true, 'Room model queue smoke: same-key loadAndWait did not wait for active load');
    assert.equal(result.waitActiveSameSettledBeforeRelease, false, 'Room model queue smoke: same-key loadAndWait resolved before active load finished');
    assert.equal(result.waitActiveStartCount, 1, 'Room model queue smoke: same-key loadAndWait started a duplicate load');
    assert.equal(result.afterResetStartedBeforeBlockedDone, true, 'Room model queue smoke: reset did not release active stale load slot');
    assert.equal(result.afterStaleErrorStartedBeforeFailure, true, 'Room model queue smoke: reset did not release active failing load slot');
    assert.deepEqual(result.errors, result.errorsBeforeStaleErrorScenario, 'Room model queue smoke: stale load failure reached onError after reset');
    assert.deepEqual(result.pendingDuringActive, ['B'], 'Room model queue smoke: concurrent model was not queued');
    assert.equal(result.deletedPending, true, 'Room model queue smoke: pending delete did not remove queued model');
    assert.deepEqual(result.pendingAfter, [], 'Room model queue smoke: pending queue did not drain');
    assert.equal(result.activeAfter, false, 'Room model queue smoke: queue stayed active after drain');
    assert.deepEqual(
        result.eventsBeforeStaleErrorScenario,
        [
            'start:A', 'done:A', 'start:B', 'done:B',
            'start:C', 'done:C',
            'start:BLOCKED', 'start:AFTER_RESET', 'done:BLOCKED', 'done:AFTER_RESET',
            'start:ACTIVE_STALE', 'done:ACTIVE_STALE',
            'start:ACTIVE_FRESH', 'done:ACTIVE_FRESH',
            'start:SAME_KEY', 'done:SAME_KEY', 'start:SAME_KEY', 'done:SAME_KEY',
        ],
        'Room model queue smoke: queued/stale/deleted model order is wrong',
    );
    diagnostics.assertNoErrors('Room model load queue smoke');
    await page.close();
}

async function runRoomLoadAbortRegistrySmoke(browser, baseUrl) {
    const page = await browser.newPage();
    const diagnostics = attachPageDiagnostics(page);
    await page.goto(`${baseUrl}/__smoke_blank`, { waitUntil: 'domcontentloaded', timeout: 15000 });

    const result = await page.evaluate(async () => {
        const { createRoomLoadAbortRegistry } = await import('/scripts/modules/collab/room-load-abort-registry.js');

        const aborts = [];
        const makeController = (name) => ({
            name,
            signal: { aborted: false },
            abort(reason) {
                this.signal.aborted = true;
                aborts.push(`${name}:${reason?.name || 'Error'}`);
            },
        });

        const registry = createRoomLoadAbortRegistry({
            makeAbortError: () => {
                try {
                    return new DOMException('room abort', 'AbortError');
                } catch (_) {
                    const err = new Error('room abort');
                    err.name = 'AbortError';
                    return err;
                }
            },
        });

        const importA = makeController('import-a');
        const importB = makeController('import-b');
        const syncA = makeController('sync-a');
        registry.addImportController(importA, { activeRequestGeneration: 1 });
        registry.addImportController(importB, { activeRequestGeneration: 2 });
        registry.addSyncController(syncA);
        const supersededCount = registry.abortSupersededImports(2);
        const afterSuperseded = {
            aborts: aborts.slice(),
            importCount: registry.getImportCount(),
            syncCount: registry.getSyncCount(),
            importBAborted: importB.signal.aborted,
            syncAAborted: syncA.signal.aborted,
        };

        const importC = makeController('import-c');
        registry.addImportController(importC, { activeRequestGeneration: 2 });
        const targetedResult = registry.abort({
            importPredicate: (controller) => controller.name === 'import-c',
            includeSyncControllers: false,
        });
        const afterTargeted = {
            aborts: aborts.slice(),
            result: targetedResult,
            importCount: registry.getImportCount(),
            syncCount: registry.getSyncCount(),
            importBAborted: importB.signal.aborted,
            syncAAborted: syncA.signal.aborted,
        };

        const fullResult = registry.abort();
        const afterFull = {
            aborts: aborts.slice(),
            result: fullResult,
            importCount: registry.getImportCount(),
            syncCount: registry.getSyncCount(),
            importBAborted: importB.signal.aborted,
            syncAAborted: syncA.signal.aborted,
        };

        const importDeleted = makeController('import-deleted');
        const syncDeleted = makeController('sync-deleted');
        registry.addImportController(importDeleted, { activeRequestGeneration: 3 });
        registry.addSyncController(syncDeleted);
        registry.deleteImportController(importDeleted);
        registry.deleteSyncController(syncDeleted);
        const afterDeletedAbort = registry.abort();

        return {
            supersededCount,
            afterSuperseded,
            afterTargeted,
            afterFull,
            afterDeletedAbort,
            importDeletedAborted: importDeleted.signal.aborted,
            syncDeletedAborted: syncDeleted.signal.aborted,
        };
    });

    assert.equal(result.supersededCount, 1, 'Room load abort registry smoke: superseded import count is wrong');
    assert.deepEqual(result.afterSuperseded.aborts, ['import-a:AbortError'], 'Room load abort registry smoke: superseded abort touched wrong controllers');
    assert.equal(result.afterSuperseded.importCount, 1, 'Room load abort registry smoke: fresh import was removed by superseded abort');
    assert.equal(result.afterSuperseded.syncCount, 1, 'Room load abort registry smoke: sync controller was removed by superseded abort');
    assert.equal(result.afterSuperseded.importBAborted, false, 'Room load abort registry smoke: fresh import was aborted by superseded abort');
    assert.equal(result.afterSuperseded.syncAAborted, false, 'Room load abort registry smoke: sync was aborted by superseded abort');
    assert.deepEqual(result.afterTargeted.result, { imports: 1, syncs: 0 }, 'Room load abort registry smoke: targeted abort returned wrong counts');
    assert.deepEqual(
        result.afterTargeted.aborts,
        ['import-a:AbortError', 'import-c:AbortError'],
        'Room load abort registry smoke: targeted model cleanup aborted wrong controllers',
    );
    assert.equal(result.afterTargeted.importBAborted, false, 'Room load abort registry smoke: targeted cleanup aborted unrelated import');
    assert.equal(result.afterTargeted.syncAAborted, false, 'Room load abort registry smoke: targeted cleanup aborted sync upload');
    assert.deepEqual(result.afterFull.result, { imports: 1, syncs: 1 }, 'Room load abort registry smoke: full abort returned wrong counts');
    assert.equal(result.afterFull.importCount, 0, 'Room load abort registry smoke: full abort left import controllers');
    assert.equal(result.afterFull.syncCount, 0, 'Room load abort registry smoke: full abort left sync controllers');
    assert.equal(result.afterFull.importBAborted, true, 'Room load abort registry smoke: full abort did not abort remaining import');
    assert.equal(result.afterFull.syncAAborted, true, 'Room load abort registry smoke: full abort did not abort sync');
    assert.deepEqual(result.afterDeletedAbort, { imports: 0, syncs: 0 }, 'Room load abort registry smoke: deleted controllers were still tracked');
    assert.equal(result.importDeletedAborted, false, 'Room load abort registry smoke: deleted import controller was aborted later');
    assert.equal(result.syncDeletedAborted, false, 'Room load abort registry smoke: deleted sync controller was aborted later');
    diagnostics.assertNoErrors('Room load abort registry smoke');
    await page.close();
}

async function runRoomModelStateSmoke(browser, baseUrl) {
    const page = await browser.newPage();
    const diagnostics = attachPageDiagnostics(page);
    await page.goto(`${baseUrl}/__smoke_blank`, { waitUntil: 'domcontentloaded', timeout: 15000 });

    const result = await page.evaluate(async () => {
        const {
            createRoomModelLinkTracker,
            isRoomModelIdLinked,
            promoteLocalImportScopeToRoom,
            pruneLoadedRoomModelIds,
        } = await import('/scripts/modules/collab/room-model-state.js');
        const loadedRoomModelIds = new Set(['A', 'B', 'C', 'D']);
        const loadedModels = [
            {
                scope: { kind: 'local', fileKey: 'local.zip|10|1' },
                obj: { userData: { importScope: { kind: 'local', fileKey: 'local.zip|10|1' } } },
            },
            {
                scope: { kind: 'local', fileKey: 'other.zip|10|1' },
                obj: { userData: { importScope: { kind: 'local', fileKey: 'other.zip|10|1' } } },
            },
        ];
        const allEmbedded = [
            { scope: { kind: 'local', fileKey: 'local.zip|10|1' } },
            { scope: { kind: 'local', fileKey: 'other.zip|10|1' } },
        ];
        const promoted = promoteLocalImportScopeToRoom({
            loadedModels,
            allEmbedded,
            fileKey: 'local.zip|10|1',
            roomId: 'room-1',
            modelId: 'model-1',
        });
        const roomPrune = pruneLoadedRoomModelIds({
            loadedRoomModelIds,
            activeRoomModelId: 'B',
            records: [
                { scope: { modelId: 'A' } },
                { obj: { userData: { importScope: { modelId: 'B' } } } },
            ],
        });
        const explicitPrune = pruneLoadedRoomModelIds({
            loadedRoomModelIds,
            activeRoomModelId: roomPrune.activeRoomModelId,
            modelId: 'C',
            records: [],
        });

        const realtimeIds = new Set();
        const realtimeLoads = [];
        let releaseInsertFetch = null;
        const insertFetch = new Promise((resolve) => {
            releaseInsertFetch = resolve;
        });
        const handleInsert = async (modelId) => {
            realtimeIds.add(modelId);
            await insertFetch;
            if (isRoomModelIdLinked(realtimeIds, modelId)) {
                realtimeLoads.push(modelId);
            }
        };
        const insertPromise = handleInsert('late-delete');
        realtimeIds.delete('late-delete');
        releaseInsertFetch();
        await insertPromise;
        realtimeIds.add('kept');
        const keptStillLinked = isRoomModelIdLinked(realtimeIds, 'kept');

        const linkTracker = createRoomModelLinkTracker();
        const firstRemember = linkTracker.remember('race-model');
        const deletedRemembered = linkTracker.forget('race-model', { tombstone: true });
        const staleRememberAfterDelete = linkTracker.remember('race-model');
        const linkedAfterStaleRemember = linkTracker.has('race-model');
        const tombstoneAfterDelete = linkTracker.isTombstoned('race-model');
        const insertRememberAfterDelete = linkTracker.remember('race-model', { clearTombstone: true });
        const linkedAfterInsertRemember = linkTracker.has('race-model');
        const tombstoneAfterInsert = linkTracker.isTombstoned('race-model');
        linkTracker.forget('race-model', { tombstone: true });
        const linkedAfterSecondDelete = linkTracker.has('race-model');
        const replaceCount = linkTracker.replace(['race-model', 'other-model']);
        const linkedAfterReconcile = linkTracker.has('race-model');
        const valuesAfterReconcile = linkTracker.values().sort();
        linkTracker.clear();
        const clearState = {
            size: linkTracker.size(),
            linked: linkTracker.has('race-model'),
            tombstoned: linkTracker.isTombstoned('race-model'),
        };
        const outOfOrderTracker = createRoomModelLinkTracker();
        outOfOrderTracker.remember('out-of-order-model');
        outOfOrderTracker.forget('out-of-order-model', { tombstone: true });
        const staleInsertLinkExists = false;
        if (staleInsertLinkExists) {
            outOfOrderTracker.remember('out-of-order-model', { clearTombstone: true });
        }
        const staleInsertRevived = outOfOrderTracker.has('out-of-order-model');
        const tombstoneAfterIgnoredStaleInsert = outOfOrderTracker.isTombstoned('out-of-order-model');
        const freshInsertLinkExists = true;
        if (freshInsertLinkExists) {
            outOfOrderTracker.remember('out-of-order-model', { clearTombstone: true });
        }
        const freshInsertRevived = outOfOrderTracker.has('out-of-order-model');
        const tombstoneAfterFreshInsert = outOfOrderTracker.isTombstoned('out-of-order-model');

        return {
            roomRemoved: roomPrune.removedIds,
            activeAfterRoomPrune: roomPrune.activeRoomModelId,
            explicitRemoved: explicitPrune.removedIds,
            activeAfterExplicitPrune: explicitPrune.activeRoomModelId,
            remaining: Array.from(loadedRoomModelIds),
            promoted,
            promotedModelScope: loadedModels[0].scope,
            promotedUserDataScope: loadedModels[0].obj.userData.importScope,
            untouchedModelScope: loadedModels[1].scope,
            promotedEmbeddedScope: allEmbedded[0].scope,
            untouchedEmbeddedScope: allEmbedded[1].scope,
            realtimeLoads,
            keptStillLinked,
            firstRemember,
            deletedRemembered,
            staleRememberAfterDelete,
            linkedAfterStaleRemember,
            tombstoneAfterDelete,
            insertRememberAfterDelete,
            linkedAfterInsertRemember,
            tombstoneAfterInsert,
            linkedAfterSecondDelete,
            replaceCount,
            linkedAfterReconcile,
            valuesAfterReconcile,
            clearState,
            staleInsertRevived,
            tombstoneAfterIgnoredStaleInsert,
            freshInsertRevived,
            tombstoneAfterFreshInsert,
        };
    });

    assert.deepEqual(result.roomRemoved, ['A', 'B'], 'Room model state smoke: room cleanup did not collect scoped model ids');
    assert.equal(result.activeAfterRoomPrune, '', 'Room model state smoke: active room model id survived scoped cleanup');
    assert.deepEqual(result.explicitRemoved, ['C'], 'Room model state smoke: explicit model cleanup did not remove id');
    assert.equal(result.activeAfterExplicitPrune, '', 'Room model state smoke: inactive explicit cleanup changed active state');
    assert.deepEqual(result.remaining, ['D'], 'Room model state smoke: stale loaded room model ids remained');
    assert.deepEqual(result.promoted, { modelCount: 1, embeddedCount: 1 }, 'Room model state smoke: local import promotion touched wrong counts');
    assert.deepEqual(result.promotedModelScope, { kind: 'room', roomId: 'room-1', modelId: 'model-1' }, 'Room model state smoke: model scope was not promoted to room');
    assert.deepEqual(result.promotedUserDataScope, { kind: 'room', roomId: 'room-1', modelId: 'model-1' }, 'Room model state smoke: object userData scope was not promoted to room');
    assert.equal(result.untouchedModelScope.kind, 'local', 'Room model state smoke: unrelated local model scope was changed');
    assert.deepEqual(result.promotedEmbeddedScope, { kind: 'room', roomId: 'room-1', modelId: 'model-1' }, 'Room model state smoke: embedded scope was not promoted to room');
    assert.equal(result.untouchedEmbeddedScope.kind, 'local', 'Room model state smoke: unrelated embedded scope was changed');
    assert.deepEqual(result.realtimeLoads, [], 'Room model state smoke: deleted realtime INSERT still loaded after async gap');
    assert.equal(result.keptStillLinked, true, 'Room model state smoke: linked model id was not recognized');
    assert.equal(result.firstRemember, true, 'Room model state smoke: first link tracker remember failed');
    assert.equal(result.deletedRemembered, true, 'Room model state smoke: link tracker delete did not remove remembered id');
    assert.equal(result.staleRememberAfterDelete, false, 'Room model state smoke: stale remember revived tombstoned model');
    assert.equal(result.linkedAfterStaleRemember, false, 'Room model state smoke: tombstoned model stayed linked after stale remember');
    assert.equal(result.tombstoneAfterDelete, true, 'Room model state smoke: delete did not tombstone model id');
    assert.equal(result.insertRememberAfterDelete, true, 'Room model state smoke: confirmed insert did not revive tombstoned model');
    assert.equal(result.linkedAfterInsertRemember, true, 'Room model state smoke: confirmed insert did not restore link');
    assert.equal(result.tombstoneAfterInsert, false, 'Room model state smoke: confirmed insert did not clear tombstone');
    assert.equal(result.linkedAfterSecondDelete, false, 'Room model state smoke: second delete left model linked');
    assert.equal(result.replaceCount, 2, 'Room model state smoke: reconcile replace returned wrong count');
    assert.equal(result.linkedAfterReconcile, true, 'Room model state smoke: reconcile did not clear tombstone for present row');
    assert.deepEqual(result.valuesAfterReconcile, ['other-model', 'race-model'], 'Room model state smoke: link tracker values were wrong after reconcile');
    assert.deepEqual(
        result.clearState,
        { size: 0, linked: false, tombstoned: false },
        'Room model state smoke: link tracker clear did not reset state',
    );
    assert.equal(result.staleInsertRevived, false, 'Room model state smoke: stale INSERT without DB link revived tombstoned model');
    assert.equal(result.tombstoneAfterIgnoredStaleInsert, true, 'Room model state smoke: stale INSERT without DB link cleared tombstone');
    assert.equal(result.freshInsertRevived, true, 'Room model state smoke: confirmed INSERT did not revive tombstoned model');
    assert.equal(result.tombstoneAfterFreshInsert, false, 'Room model state smoke: confirmed INSERT did not clear tombstone');
    diagnostics.assertNoErrors('Room model state smoke');
    await page.close();
}

async function runDeferredRealtimeReloadSmoke(browser, baseUrl) {
    const page = await browser.newPage();
    const diagnostics = attachPageDiagnostics(page);
    await page.goto(`${baseUrl}/__smoke_blank`, { waitUntil: 'domcontentloaded', timeout: 15000 });

    const result = await page.evaluate(async () => {
        const { createDeferredRealtimeReload } = await import('/scripts/modules/collab/deferred-realtime-reload.js');

        let muted = true;
        let currentGeneration = 1;
        const events = [];
        const errors = [];
        const releases = new Map();
        const starts = new Map();
        const dones = new Map();
        const failures = new Map();

        const waitFor = (map, label) => {
            if (map.has(label)) return map.get(label).promise;
            let resolve = null;
            const promise = new Promise((nextResolve) => {
                resolve = nextResolve;
            });
            map.set(label, { promise, resolve });
            return promise;
        };
        const mark = (map, label) => {
            if (!map.has(label)) void waitFor(map, label);
            map.get(label).resolve();
        };

        const reloader = createDeferredRealtimeReload({
            isMuted: () => muted,
            isCurrent: ({ generation }) => generation === currentGeneration,
            reload: async ({ label }) => {
                events.push(`start:${label}`);
                mark(starts, label);
                if (label === 'A' || label === 'B' || label === 'D' || label === 'F' || label === 'G' || label === 'H') {
                    await new Promise((resolve) => {
                        releases.set(label, resolve);
                    });
                }
                if (label === 'G') {
                    events.push(`fail:${label}`);
                    mark(failures, label);
                    throw new Error('stale reload failed');
                }
                events.push(`done:${label}`);
                mark(dones, label);
            },
            onError: (err, context) => {
                errors.push(`${context?.label || ''}:${err?.message || err}`);
            },
        });

        const requestMuted = reloader.request({ label: 'A', generation: 1 });
        const dirtyAfterMuted = reloader.isDirty();
        muted = false;
        const flushA = reloader.flush();
        await waitFor(starts, 'A');

        const requestQueued = reloader.request({ label: 'B', generation: 1 });
        currentGeneration = 2;
        const staleIgnored = reloader.request({ label: 'STALE', generation: 1 });
        currentGeneration = 1;

        releases.get('A')();
        await waitFor(dones, 'A');
        await waitFor(starts, 'B');

        muted = true;
        const requestWhileMutedInFlight = reloader.request({ label: 'C', generation: 1 });
        releases.get('B')();
        await waitFor(dones, 'B');
        await new Promise((resolve) => setTimeout(resolve, 0));
        const beforeFlushEvents = events.slice();

        muted = false;
        const flushC = reloader.flush();
        await waitFor(dones, 'C');

        currentGeneration = 3;
        const requestD = reloader.request({ label: 'D', generation: 3 });
        await waitFor(starts, 'D');
        const requestE = reloader.request({ label: 'E', generation: 3 });
        const queuedBeforeClear = reloader.isQueued();
        reloader.clear();
        const stateAfterClear = {
            dirty: reloader.isDirty(),
            queued: reloader.isQueued(),
            inFlight: reloader.isInFlight(),
            lastContext: reloader.getLastContext(),
        };
        const requestF = reloader.request({ label: 'F', generation: 3 });
        await waitFor(starts, 'F');
        const fStartedBeforeDDone = events.includes('start:F') && !events.includes('done:D');
        releases.get('D')();
        releases.get('F')();
        await waitFor(dones, 'D');
        await waitFor(dones, 'F');
        await new Promise((resolve) => setTimeout(resolve, 0));
        const eventsBeforeStaleErrorScenario = events.slice();
        const errorsBeforeStaleErrorScenario = errors.slice();
        const stateBeforeStaleErrorScenario = {
            dirty: reloader.isDirty(),
            queued: reloader.isQueued(),
            inFlight: reloader.isInFlight(),
            lastContext: reloader.getLastContext(),
        };

        currentGeneration = 4;
        const requestG = reloader.request({ label: 'G', generation: 4 });
        await waitFor(starts, 'G');
        reloader.clear();
        const stateAfterStaleErrorClear = {
            dirty: reloader.isDirty(),
            queued: reloader.isQueued(),
            inFlight: reloader.isInFlight(),
            lastContext: reloader.getLastContext(),
        };
        const requestH = reloader.request({ label: 'H', generation: 4 });
        await waitFor(starts, 'H');
        const hStartedBeforeGFailed = events.includes('start:H') && !events.includes('fail:G');
        releases.get('G')();
        releases.get('H')();
        await waitFor(failures, 'G');
        await waitFor(dones, 'H');
        await new Promise((resolve) => setTimeout(resolve, 0));

        return {
            requestMuted,
            dirtyAfterMuted,
            flushA,
            requestQueued,
            staleIgnored,
            requestWhileMutedInFlight,
            flushC,
            requestD,
            requestE,
            queuedBeforeClear,
            stateAfterClear,
            requestF,
            fStartedBeforeDDone,
            requestG,
            requestH,
            hStartedBeforeGFailed,
            beforeFlushEvents,
            events,
            eventsBeforeStaleErrorScenario,
            errors,
            errorsBeforeStaleErrorScenario,
            stateBeforeStaleErrorScenario,
            stateAfterStaleErrorClear,
            dirtyAfterFlush: reloader.isDirty(),
            queuedAfterFlush: reloader.isQueued(),
            inFlightAfterFlush: reloader.isInFlight(),
            lastContext: reloader.getLastContext(),
        };
    });

    assert.equal(result.requestMuted, false, 'Deferred realtime smoke: muted request should be deferred');
    assert.equal(result.dirtyAfterMuted, true, 'Deferred realtime smoke: muted request did not mark dirty');
    assert.equal(result.flushA, true, 'Deferred realtime smoke: flush did not start deferred reload');
    assert.equal(result.requestQueued, false, 'Deferred realtime smoke: in-flight request should be queued');
    assert.equal(result.staleIgnored, false, 'Deferred realtime smoke: stale request should be ignored');
    assert.equal(result.requestWhileMutedInFlight, false, 'Deferred realtime smoke: muted in-flight request should be deferred');
    assert.deepEqual(result.beforeFlushEvents, ['start:A', 'done:A', 'start:B', 'done:B'], 'Deferred realtime smoke: dirty muted reload ran before unmute');
    assert.equal(result.flushC, true, 'Deferred realtime smoke: unmute flush did not replay dirty reload');
    assert.equal(result.requestD, true, 'Deferred realtime smoke: reset scenario did not start in-flight reload');
    assert.equal(result.requestE, false, 'Deferred realtime smoke: in-flight reset scenario request should be queued');
    assert.equal(result.queuedBeforeClear, true, 'Deferred realtime smoke: queued reload was not recorded before clear');
    assert.deepEqual(
        result.stateAfterClear,
        { dirty: false, queued: false, inFlight: false, lastContext: null },
        'Deferred realtime smoke: clear did not reset dirty/queued/in-flight state',
    );
    assert.equal(result.requestF, true, 'Deferred realtime smoke: clear did not release in-flight slot for new reload');
    assert.equal(result.fStartedBeforeDDone, true, 'Deferred realtime smoke: new reload waited for stale in-flight reload after clear');
    assert.deepEqual(
        result.eventsBeforeStaleErrorScenario,
        ['start:A', 'done:A', 'start:B', 'done:B', 'start:C', 'done:C', 'start:D', 'start:F', 'done:D', 'done:F'],
        'Deferred realtime smoke: reload order is wrong',
    );
    assert.equal(result.requestG, true, 'Deferred realtime smoke: stale-error scenario did not start reload');
    assert.deepEqual(
        result.stateAfterStaleErrorClear,
        { dirty: false, queued: false, inFlight: false, lastContext: null },
        'Deferred realtime smoke: stale-error clear did not reset in-flight state',
    );
    assert.equal(result.requestH, true, 'Deferred realtime smoke: stale-error clear did not allow the next reload');
    assert.equal(result.hStartedBeforeGFailed, true, 'Deferred realtime smoke: stale-error scenario did not overlap runs');
    assert.deepEqual(result.errors, result.errorsBeforeStaleErrorScenario, 'Deferred realtime smoke: stale reload error reached onError after clear');
    assert.equal(result.dirtyAfterFlush, false, 'Deferred realtime smoke: dirty flag stayed set');
    assert.equal(result.queuedAfterFlush, false, 'Deferred realtime smoke: queued flag stayed set');
    assert.equal(result.inFlightAfterFlush, false, 'Deferred realtime smoke: in-flight flag stayed set');
    assert.equal(result.stateBeforeStaleErrorScenario.lastContext?.label, 'F', 'Deferred realtime smoke: stale context replaced latest valid context');
    assert.equal(result.lastContext?.label, 'H', 'Deferred realtime smoke: latest context was not updated after stale-error recovery');
    diagnostics.assertNoErrors('Deferred realtime reload smoke');
    await page.close();
}

async function runAuxRealtimeChannelRegistrySmoke(browser, baseUrl) {
    const page = await browser.newPage();
    const diagnostics = attachPageDiagnostics(page);
    await page.goto(`${baseUrl}/__smoke_blank`, { waitUntil: 'domcontentloaded', timeout: 15000 });

    const result = await page.evaluate(async () => {
        const { createAuxRealtimeChannelRegistry } = await import('/scripts/modules/collab/aux-realtime-channels.js');

        const registry = createAuxRealtimeChannelRegistry();
        const removed = [];
        const oldModelsChannel = { name: 'old-models' };
        const nextModelsChannel = { name: 'next-models' };
        const cameraChannel = { name: 'camera' };
        const transitionsChannel = { name: 'transitions' };
        const errorChannel = { name: 'error-channel' };

        registry.set('room_models', oldModelsChannel);
        registry.set('room_models', nextModelsChannel);
        const staleRemoveResult = await registry.remove('room_models', {
            channel: oldModelsChannel,
            removeChannel: async (channel) => removed.push(channel.name),
        });
        const currentAfterStaleFailure = registry.get('room_models')?.name || '';
        const currentRemoveResult = await registry.remove('room_models', {
            channel: nextModelsChannel,
            removeChannel: async (channel) => removed.push(channel.name),
        });

        registry.set('room_cameras', cameraChannel);
        registry.set('room_transitions', transitionsChannel);
        const clearAllNames = registry.clearAll().map((channel) => channel.name).sort();
        const sizeAfterClearAll = registry.size();

        registry.set('room_models', errorChannel);
        const removeErrorSwallowed = await registry.remove('room_models', {
            channel: errorChannel,
            removeChannel: async () => {
                throw new Error('remove failed');
            },
        }).then(
            (value) => value,
            (err) => `rejected:${err?.message || String(err)}`,
        );

        return {
            staleRemoveResult,
            currentAfterStaleFailure,
            currentRemoveResult,
            removed,
            clearAllNames,
            sizeAfterClearAll,
            removeErrorSwallowed,
            sizeAfterRemoveError: registry.size(),
        };
    });

    assert.equal(result.staleRemoveResult, false, 'Aux realtime registry smoke: stale channel failure removed current channel');
    assert.equal(result.currentAfterStaleFailure, 'next-models', 'Aux realtime registry smoke: stale channel failure changed current channel');
    assert.equal(result.currentRemoveResult, true, 'Aux realtime registry smoke: current failed channel was not removed');
    assert.deepEqual(result.removed, ['next-models'], 'Aux realtime registry smoke: removed wrong realtime channel');
    assert.deepEqual(result.clearAllNames, ['camera', 'transitions'], 'Aux realtime registry smoke: clearAll returned wrong channels');
    assert.equal(result.sizeAfterClearAll, 0, 'Aux realtime registry smoke: clearAll left channel refs behind');
    assert.equal(result.removeErrorSwallowed, true, 'Aux realtime registry smoke: removeChannel failure was propagated');
    assert.equal(result.sizeAfterRemoveError, 0, 'Aux realtime registry smoke: removeChannel failure left channel ref behind');
    diagnostics.assertNoErrors('Aux realtime channel registry smoke');
    await page.close();
}

async function runAbortableTusUploadSmoke(browser, baseUrl) {
    const page = await browser.newPage();
    const diagnostics = attachPageDiagnostics(page);
    await page.goto(`${baseUrl}/__smoke_blank`, { waitUntil: 'domcontentloaded', timeout: 15000 });

    const result = await page.evaluate(async () => {
        const {
            runAbortableOperation,
            runAbortableTusUpload,
        } = await import('/scripts/modules/collab/abortable-tus-upload.js');

        const events = [];
        let previousUploadsResolver = null;

        class SlowUpload {
            static instances = [];
            constructor(file, options) {
                this.file = file;
                this.options = options;
                SlowUpload.instances.push(this);
                events.push(`create:${file.name}`);
            }
            findPreviousUploads() {
                events.push('findPreviousUploads');
                return new Promise((resolve) => {
                    previousUploadsResolver = resolve;
                });
            }
            resumeFromPreviousUpload() {
                events.push('resume');
            }
            start() {
                events.push('start');
            }
            abort(shouldTerminate) {
                events.push(`abort:${shouldTerminate ? 'terminate' : 'keep'}`);
                return Promise.resolve();
            }
        }

        const abortController = new AbortController();
        const abortedPromise = runAbortableTusUpload({
            UploadCtor: SlowUpload,
            file: new File([new Uint8Array([1, 2, 3])], 'large.zip'),
            endpoint: '/upload',
            signal: abortController.signal,
            abortMessage: 'sync superseded',
        }).then(
            () => 'resolved',
            (err) => `${err?.name || 'Error'}:${err?.message || err}`,
        );

        for (let i = 0; i < 20 && !previousUploadsResolver; i += 1) {
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
        abortController.abort();
        previousUploadsResolver?.([]);
        const abortResult = await abortedPromise;

        class SuccessUpload {
            constructor(file, options) {
                this.file = file;
                this.options = options;
                events.push(`create:${file.name}`);
            }
            findPreviousUploads() {
                events.push('success:findPreviousUploads');
                return Promise.resolve([{ url: 'previous' }]);
            }
            resumeFromPreviousUpload() {
                events.push('success:resume');
            }
            start() {
                events.push('success:start');
                this.options.onProgress(25, 100);
                this.options.onSuccess();
            }
        }

        const progress = [];
        const successResult = await runAbortableTusUpload({
            UploadCtor: SuccessUpload,
            file: new File([new Uint8Array([1])], 'ok.zip'),
            endpoint: '/upload',
            onProgress: (bytesUploaded, bytesTotal) => progress.push(`${bytesUploaded}/${bytesTotal}`),
        }).then(() => 'resolved');

        class LateSuccessAfterAbortUpload {
            constructor(file, options) {
                this.file = file;
                this.options = options;
                events.push(`late:create:${file.name}`);
            }
            findPreviousUploads() {
                events.push('late:findPreviousUploads');
                return Promise.resolve([]);
            }
            start() {
                events.push('late:start');
            }
            abort(shouldTerminate) {
                events.push(`late:abort:${shouldTerminate ? 'terminate' : 'keep'}`);
                return Promise.resolve().then(() => {
                    events.push('late:onSuccess-after-abort');
                    this.options.onSuccess();
                });
            }
        }

        const lateSuccessAbortController = new AbortController();
        let lateSuccessCleanupCount = 0;
        const lateSuccessAbortPromise = runAbortableTusUpload({
            UploadCtor: LateSuccessAfterAbortUpload,
            file: new File([new Uint8Array([9])], 'late.zip'),
            endpoint: '/upload',
            signal: lateSuccessAbortController.signal,
            abortMessage: 'late sync superseded',
            onLateSuccess: () => {
                lateSuccessCleanupCount += 1;
                events.push('late:cleanup');
            },
        }).then(
            () => 'resolved',
            (err) => `${err?.name || 'Error'}:${err?.message || err}`,
        );
        for (let i = 0; i < 20 && !events.includes('late:start'); i += 1) {
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
        lateSuccessAbortController.abort(new DOMException('late sync superseded', 'AbortError'));
        const lateSuccessAbortResult = await lateSuccessAbortPromise;

        let blockedOperationStarted = false;
        let releaseBlockedOperation = null;
        const operationAbortController = new AbortController();
        const operationAbortResult = await Promise.race([
            runAbortableOperation(() => {
                blockedOperationStarted = true;
                return new Promise((resolve) => {
                    releaseBlockedOperation = () => resolve('late');
                });
            }, {
                signal: operationAbortController.signal,
                abortMessage: 'operation superseded',
                onLateResolve: (value) => events.push(`operation:lateResolve:${value}`),
                onLateReject: () => events.push('operation:lateReject'),
            }).then(
                (value) => `resolved:${value}`,
                (err) => `${err?.name || 'Error'}:${err?.message || err}`,
            ),
            Promise.resolve().then(() => {
                operationAbortController.abort(new DOMException('operation superseded', 'AbortError'));
                return null;
            }).then(() => new Promise((resolve) => setTimeout(resolve, 0))).then(() => 'hung'),
        ]);
        releaseBlockedOperation?.();
        await Promise.resolve();
        await Promise.resolve();

        return {
            abortResult,
            successResult,
            lateSuccessAbortResult,
            lateSuccessCleanupCount,
            operationAbortResult,
            blockedOperationStarted,
            progress,
            events,
        };
    });

    assert.equal(result.abortResult, 'AbortError:sync superseded', 'Abortable TUS smoke: aborted upload did not reject with AbortError');
    assert.equal(result.events.includes('start'), false, 'Abortable TUS smoke: aborted upload started after abort');
    assert.ok(result.events.includes('abort:terminate'), 'Abortable TUS smoke: upload.abort(true) was not called');
    assert.equal(result.successResult, 'resolved', 'Abortable TUS smoke: successful upload did not resolve');
    assert.equal(result.lateSuccessAbortResult, 'AbortError:late sync superseded', 'Abortable TUS smoke: late-success abort did not reject');
    assert.equal(result.lateSuccessCleanupCount, 1, 'Abortable TUS smoke: late-success cleanup did not run once');
    assert.equal(result.blockedOperationStarted, true, 'Abortable operation smoke: operation did not start');
    assert.equal(result.operationAbortResult, 'AbortError:operation superseded', 'Abortable operation smoke: non-abortable operation did not reject on abort');
    assert.ok(result.events.includes('operation:lateResolve:late'), 'Abortable operation smoke: late resolve cleanup hook did not fire');
    assert.equal(result.events.includes('operation:lateReject'), false, 'Abortable operation smoke: late reject hook fired for a late resolve');
    assert.deepEqual(result.progress, ['25/100'], 'Abortable TUS smoke: progress callback did not fire');
    assert.ok(result.events.includes('success:resume'), 'Abortable TUS smoke: previous upload was not resumed');
    assert.ok(result.events.includes('success:start'), 'Abortable TUS smoke: successful upload did not start');
    assert.ok(result.events.includes('late:cleanup'), 'Abortable TUS smoke: late success did not invoke cleanup hook');
    diagnostics.assertNoErrors('Abortable TUS upload smoke');
    await page.close();
}

async function runWorkerLifecycleSmoke(browser, baseUrl) {
    const page = await browser.newPage();
    const diagnostics = attachPageDiagnostics(page);
    await page.goto(`${baseUrl}/__smoke_blank`, { waitUntil: 'domcontentloaded', timeout: 15000 });

    const result = await page.evaluate(async () => {
        const NativeWorker = globalThis.Worker;
        const THREE = await import('three');
        const successJson = new THREE.Group().toJSON();

        const events = [];
        let fbxAutoRespond = false;
        let zipAutoRespond = true;

        class FakeWorker {
            static instances = [];
            constructor(url) {
                this.url = String(url || '');
                this.onmessage = null;
                this.onerror = null;
                this.terminated = false;
                this.posts = [];
                FakeWorker.instances.push(this);
            }
            postMessage(message) {
                this.posts.push(message);
                if (this.terminated) {
                    events.push(`post-after-terminate:${this.kind}`);
                    return;
                }
                if (this.url.includes('fbx-worker')) {
                    this.kind = 'fbx';
                    if (fbxAutoRespond && message?.id != null) {
                        queueMicrotask(() => {
                            this.onmessage?.({
                                data: {
                                    id: message.id,
                                    ok: true,
                                    json: successJson,
                                    duration: 1,
                                    embedded: [],
                                    orientation: null,
                                },
                            });
                        });
                    }
                    return;
                }
                if (this.url.includes('zip-worker')) {
                    this.kind = 'zip';
                    if (message?.type === 'ack') {
                        events.push(`ack:${message.seq}`);
                        return;
                    }
                    if (zipAutoRespond && message?.id != null) {
                        queueMicrotask(() => {
                            this.onmessage?.({
                                data: {
                                    id: message.id,
                                    type: 'meta',
                                    counts: { fbx: 0, images: 0, geojson: 0 },
                                },
                            });
                            this.onmessage?.({ data: { id: message.id, type: 'done' } });
                        });
                    }
                }
            }
            terminate() {
                this.terminated = true;
                events.push(`terminate:${this.kind || 'unknown'}`);
            }
        }

        globalThis.Worker = FakeWorker;
        try {
            const { createFBXWorkerClient } = await import('/scripts/modules/workers/fbx-worker-client.js');
            const { createZIPWorkerClient } = await import('/scripts/modules/workers/zip-worker-client.js');

            const fbxClient = createFBXWorkerClient();
            const fbxAbort = new AbortController();
            const fbxFirst = fbxClient.parseFBXInWorker(
                new ArrayBuffer(8),
                { embedded: true, orientation: true },
                { signal: fbxAbort.signal },
            ).then(
                () => 'resolved',
                (err) => err?.name || String(err),
            );
            await Promise.resolve();
            fbxAbort.abort();
            const fbxAbortResult = await fbxFirst;
            const fbxOldWorker = FakeWorker.instances.find((worker) => worker.url.includes('fbx-worker'));
            fbxOldWorker?.onmessage?.({
                data: {
                    id: 1,
                    ok: true,
                    json: successJson,
                    duration: 1,
                    embedded: [{ short: 'late.png', buffer: new ArrayBuffer(1) }],
                    orientation: { source: 'late' },
                },
            });

            fbxAutoRespond = false;
            const fbxSecondPromise = fbxClient.parseFBXInWorker(
                new ArrayBuffer(8),
                { embedded: true, orientation: true },
            ).then(
                (value) => value,
                (err) => ({ error: err?.name || String(err) }),
            );
            await Promise.resolve();
            const fbxNewWorker = FakeWorker.instances.filter((worker) => worker.url.includes('fbx-worker')).at(-1);
            const fbxSecondJobId = fbxNewWorker?.posts?.[0]?.id || 2;
            fbxOldWorker?.onerror?.({
                message: 'stale old FBX worker error',
                preventDefault: () => {
                    events.push('prevent-stale-fbx-error');
                },
            });
            const fbxSupportedAfterStaleError = fbxClient.isSupported();
            fbxNewWorker?.onmessage?.({
                data: {
                    id: fbxSecondJobId,
                    ok: true,
                    json: successJson,
                    duration: 1,
                    embedded: [],
                    orientation: null,
                },
            });
            const fbxSecond = await fbxSecondPromise;

            const zipClient = createZIPWorkerClient();
            zipAutoRespond = false;
            const zipAbort = new AbortController();
            let resolveZipBuffer = null;
            const zipFile = {
                name: 'slow.zip',
                arrayBuffer: () => new Promise((resolve) => {
                    resolveZipBuffer = resolve;
                }),
            };
            const zipCallbacks = [];
            const zipFirst = zipClient.unpackZIPInWorker(zipFile, {
                onError: (err) => zipCallbacks.push(`onError:${err?.name || err}`),
            }, { signal: zipAbort.signal }).then(
                () => 'resolved',
                (err) => err?.name || String(err),
            );
            await Promise.resolve();
            zipAbort.abort();
            resolveZipBuffer(new ArrayBuffer(4));
            const zipAbortResult = await zipFirst;
            await Promise.resolve();
            const zipOldWorker = FakeWorker.instances.find((worker) => worker.url.includes('zip-worker'));
            zipOldWorker?.onmessage?.({ data: { id: 1, type: 'done' } });

            zipAutoRespond = false;
            const zipSecondMeta = [];
            const zipSecondPromise = zipClient.unpackZIPInWorker({
                name: 'ok.zip',
                arrayBuffer: async () => new ArrayBuffer(4),
            }, {
                onMeta: (msg) => zipSecondMeta.push(msg.counts?.fbx ?? -1),
                onError: (err) => zipCallbacks.push(`lateOnError:${err?.name || err}`),
            });
            await Promise.resolve();
            await Promise.resolve();
            const zipNewWorker = FakeWorker.instances.filter((worker) => worker.url.includes('zip-worker')).at(-1);
            const zipSecondJobId = zipNewWorker?.posts?.[0]?.id || 2;
            zipOldWorker?.onerror?.({
                message: 'stale old ZIP worker error',
                preventDefault: () => {
                    events.push('prevent-stale-zip-error');
                },
            });
            const zipSupportedAfterStaleError = zipClient.isSupported();
            zipNewWorker?.onmessage?.({
                data: {
                    id: zipSecondJobId,
                    type: 'meta',
                    counts: { fbx: 0, images: 0, geojson: 0 },
                },
            });
            zipNewWorker?.onmessage?.({ data: { id: zipSecondJobId, type: 'done' } });
            const zipSecond = await zipSecondPromise;

            return {
                fbxAbortResult,
                fbxOldTerminated: !!fbxOldWorker?.terminated,
                fbxSecondOk: !!fbxSecond?.obj,
                fbxSecondError: fbxSecond?.error || null,
                fbxSupportedAfterStaleError,
                fbxWorkerCount: FakeWorker.instances.filter((worker) => worker.url.includes('fbx-worker')).length,
                zipAbortResult,
                zipOldTerminated: !!zipOldWorker?.terminated,
                zipSecondType: zipSecond?.type || null,
                zipSupportedAfterStaleError,
                zipWorkerCount: FakeWorker.instances.filter((worker) => worker.url.includes('zip-worker')).length,
                zipCallbacks,
                zipSecondMeta,
                events,
            };
        } finally {
            globalThis.Worker = NativeWorker;
        }
    });

    assert.equal(result.fbxAbortResult, 'AbortError', 'Worker smoke: FBX abort did not reject with AbortError');
    assert.equal(result.fbxOldTerminated, true, 'Worker smoke: FBX worker was not terminated on abort');
    assert.equal(result.fbxSecondOk, true, 'Worker smoke: FBX worker did not recover after abort');
    assert.equal(result.fbxSecondError, null, 'Worker smoke: stale FBX worker error killed the next job');
    assert.equal(result.fbxSupportedAfterStaleError, true, 'Worker smoke: stale FBX worker error disabled the live client');
    assert.equal(result.fbxWorkerCount, 2, 'Worker smoke: FBX worker was not recreated after abort');
    assert.equal(result.zipAbortResult, 'AbortError', 'Worker smoke: ZIP abort did not reject with AbortError');
    assert.equal(result.zipOldTerminated, true, 'Worker smoke: ZIP worker was not terminated on abort');
    assert.equal(result.zipSecondType, 'done', 'Worker smoke: ZIP worker did not recover after abort');
    assert.equal(result.zipSupportedAfterStaleError, true, 'Worker smoke: stale ZIP worker error disabled the live client');
    assert.equal(result.zipWorkerCount, 2, 'Worker smoke: ZIP worker was not recreated after abort');
    assert.deepEqual(result.zipCallbacks, [], 'Worker smoke: ZIP stale onError fired after abort');
    assert.deepEqual(result.zipSecondMeta, [0], 'Worker smoke: ZIP next job did not receive meta after abort');
    assert.equal(result.events.includes('post-after-terminate:zip'), false, 'Worker smoke: ZIP posted ack to a terminated worker');
    diagnostics.assertNoErrors('Worker lifecycle smoke');
    await page.close();
}

async function runWorkerClientDisposeSmoke(browser, baseUrl) {
    const page = await browser.newPage();
    const diagnostics = attachPageDiagnostics(page);
    await page.goto(`${baseUrl}/__smoke_blank`, { waitUntil: 'domcontentloaded', timeout: 15000 });

    const result = await page.evaluate(async () => {
        const nativeWorker = globalThis.Worker;
        const workers = [];

        class FakeWorker {
            constructor(url, options) {
                this.url = url;
                this.options = options;
                this.messages = [];
                this.terminated = 0;
                this.onmessage = null;
                this.onerror = null;
                workers.push(this);
            }
            postMessage(message) {
                this.messages.push(message);
            }
            terminate() {
                this.terminated += 1;
            }
            emit(message) {
                this.onmessage?.({ data: message });
            }
        }

        globalThis.Worker = FakeWorker;
        try {
            const { createFBXWorkerClient } = await import('/scripts/modules/workers/fbx-worker-client.js');
            const { createZIPWorkerClient } = await import('/scripts/modules/workers/zip-worker-client.js');
            const { createAssetLoaders } = await import('/scripts/modules/io/asset-loaders.js');
            const THREE = await import('three');

            async function waitForWorkerMessage(index, count = 1) {
                for (let i = 0; i < 50; i += 1) {
                    const worker = workers[index] || null;
                    if ((worker?.messages?.length || 0) >= count) return worker;
                    await new Promise((resolve) => setTimeout(resolve, 0));
                }
                return workers[index] || null;
            }

            const fbxClient = createFBXWorkerClient({ workerUrl: '/fake-fbx-worker.js' });
            const fbxPromise = fbxClient.parseFBXInWorker(
                new ArrayBuffer(4),
                { embedded: true, orientation: true }
            ).then(
                () => 'resolved',
                (err) => `${err?.name || 'Error'}:${err?.message || err}`,
            );
            await Promise.resolve();
            const fbxWorker = workers[0] || null;
            const fbxPostedBeforeDispose = fbxWorker?.messages?.length || 0;
            const fbxSupportedBeforeDispose = fbxClient.isSupported();
            fbxClient.dispose();
            fbxClient.dispose();
            const fbxResult = await fbxPromise;
            fbxWorker?.emit?.({ id: 1, ok: true, json: { metadata: { version: 4.5, type: 'Object' } } });
            const fbxAfterDispose = await fbxClient.parseFBXInWorker(new ArrayBuffer(1)).then(
                () => 'resolved',
                (err) => `${err?.name || 'Error'}:${err?.message || err}`,
            );

            const zipClient = createZIPWorkerClient({ workerUrl: '/fake-zip-worker.js' });
            const zipFile = new File([new Uint8Array([1, 2, 3])], 'model.zip', { type: 'application/zip' });
            const zipEvents = [];
            const zipPromise = zipClient.unpackZIPInWorker(zipFile, {
                onProgress: () => zipEvents.push('progress'),
                onFBX: () => zipEvents.push('fbx'),
                onImage: () => zipEvents.push('image'),
            }).then(
                () => 'resolved',
                (err) => `${err?.name || 'Error'}:${err?.message || err}`,
            );
            const zipWorker = await waitForWorkerMessage(1, 1);
            const zipPostedBeforeDispose = zipWorker?.messages?.length || 0;
            const zipSupportedBeforeDispose = zipClient.isSupported();
            zipClient.dispose();
            zipClient.dispose();
            const zipResult = await zipPromise;
            zipWorker?.emit?.({ id: 1, type: 'progress' });
            zipWorker?.emit?.({ id: 1, type: 'fbx', seq: 1, blob: new Blob([new Uint8Array([1])]) });
            await Promise.resolve();
            await Promise.resolve();
            const zipAfterDispose = await zipClient.unpackZIPInWorker(zipFile).then(
                () => 'resolved',
                (err) => `${err?.name || 'Error'}:${err?.message || err}`,
            );

            const lateFbxClient = createFBXWorkerClient({ workerUrl: '/fake-fbx-worker-late.js' });
            const lateFbxPromise = lateFbxClient.parseFBXInWorker(
                new ArrayBuffer(4),
                { embedded: true, orientation: true }
            ).then(
                () => 'resolved',
                (err) => `${err?.name || 'Error'}:${err?.message || err}`,
            );
            await Promise.resolve();
            const lateFbxWorker = workers[2] || null;
            lateFbxWorker?.emit?.({
                id: 1,
                ok: true,
                json: new THREE.Group().toJSON(),
                duration: 1,
            });
            lateFbxClient.dispose();
            const lateFbxResult = await lateFbxPromise;

            let releaseZipArrayBuffer = null;
            const delayedZipFile = {
                name: 'delayed.zip',
                arrayBuffer: () => new Promise((resolve) => {
                    releaseZipArrayBuffer = () => resolve(new ArrayBuffer(8));
                }),
            };
            const zipRaceEvents = [];
            const zipRaceClient = createZIPWorkerClient({ workerUrl: '/fake-zip-worker-race.js' });
            const zipRacePromise = zipRaceClient.unpackZIPInWorker(delayedZipFile, {
                onError: (err) => zipRaceEvents.push(err?.message || String(err)),
            }).then(
                () => 'resolved',
                (err) => `${err?.name || 'Error'}:${err?.message || err}`,
            );
            await Promise.resolve();
            const zipRaceWorker = workers[3] || null;
            zipRaceClient.dispose();
            releaseZipArrayBuffer?.();
            await new Promise((resolve) => setTimeout(resolve, 0));
            const zipRaceResult = await zipRacePromise;
            const zipRacePostedAfterDispose = zipRaceWorker?.messages?.length || 0;

            const fbxConcurrentStartIndex = workers.length;
            const fbxConcurrentClient = createFBXWorkerClient({ workerUrl: '/fake-fbx-worker-concurrent.js' });
            const fbxConcurrentAbort = new AbortController();
            const fbxConcurrentFirstPromise = fbxConcurrentClient.parseFBXInWorker(
                new ArrayBuffer(4),
                { embedded: true, orientation: true },
                { signal: fbxConcurrentAbort.signal },
            ).then(
                () => 'resolved',
                (err) => `${err?.name || 'Error'}:${err?.message || err}`,
            );
            const fbxConcurrentSecondPromise = fbxConcurrentClient.parseFBXInWorker(
                new ArrayBuffer(4),
                { embedded: true, orientation: true },
            ).then(
                (value) => (value?.obj ? 'resolved' : 'empty'),
                (err) => `${err?.name || 'Error'}:${err?.message || err}`,
            );
            const fbxConcurrentWorker = await waitForWorkerMessage(fbxConcurrentStartIndex, 2);
            const fbxConcurrentFirstId = fbxConcurrentWorker?.messages?.[0]?.id || 1;
            const fbxConcurrentSecondId = fbxConcurrentWorker?.messages?.[1]?.id || 2;
            fbxConcurrentAbort.abort();
            const fbxConcurrentFirstResult = await fbxConcurrentFirstPromise;
            const fbxConcurrentTerminatedBeforeSecond = fbxConcurrentWorker?.terminated || 0;
            const fbxConcurrentCancelCount = fbxConcurrentWorker?.messages
                ?.filter((message) => message?.type === 'cancel' && message?.id === fbxConcurrentFirstId)
                .length || 0;
            fbxConcurrentWorker?.emit?.({
                id: fbxConcurrentFirstId,
                ok: true,
                json: new THREE.Group().toJSON(),
                duration: 1,
            });
            fbxConcurrentWorker?.emit?.({
                id: fbxConcurrentSecondId,
                ok: true,
                json: new THREE.Group().toJSON(),
                duration: 1,
            });
            const fbxConcurrentSecondResult = await fbxConcurrentSecondPromise;
            fbxConcurrentClient.dispose();

            const zipConcurrentStartIndex = workers.length;
            const zipConcurrentClient = createZIPWorkerClient({ workerUrl: '/fake-zip-worker-concurrent.js' });
            const zipConcurrentAbort = new AbortController();
            const zipConcurrentMeta = [];
            const zipConcurrentFirstPromise = zipConcurrentClient.unpackZIPInWorker(
                new File([new Uint8Array([1])], 'first.zip', { type: 'application/zip' }),
                {
                    onMeta: () => zipConcurrentMeta.push('first'),
                    onFBX: () => zipConcurrentMeta.push('first-fbx'),
                },
                { signal: zipConcurrentAbort.signal },
            ).then(
                () => 'resolved',
                (err) => `${err?.name || 'Error'}:${err?.message || err}`,
            );
            const zipConcurrentSecondPromise = zipConcurrentClient.unpackZIPInWorker(
                new File([new Uint8Array([2])], 'second.zip', { type: 'application/zip' }),
                {
                    onMeta: () => zipConcurrentMeta.push('second'),
                },
            ).then(
                (msg) => msg?.type || 'resolved',
                (err) => `${err?.name || 'Error'}:${err?.message || err}`,
            );
            const zipConcurrentWorker = await waitForWorkerMessage(zipConcurrentStartIndex, 2);
            const zipConcurrentFirstId = zipConcurrentWorker?.messages?.[0]?.id || 1;
            const zipConcurrentSecondId = zipConcurrentWorker?.messages?.[1]?.id || 2;
            zipConcurrentAbort.abort();
            const zipConcurrentFirstResult = await zipConcurrentFirstPromise;
            await Promise.resolve();
            const zipConcurrentTerminatedBeforeSecond = zipConcurrentWorker?.terminated || 0;
            const zipConcurrentCancelCount = zipConcurrentWorker?.messages
                ?.filter((message) => message?.type === 'cancel' && message?.id === zipConcurrentFirstId)
                .length || 0;
            zipConcurrentWorker?.emit?.({ id: zipConcurrentFirstId, type: 'meta', counts: { fbx: 1, images: 0, geojson: 0 } });
            zipConcurrentWorker?.emit?.({ id: zipConcurrentFirstId, type: 'done' });
            zipConcurrentWorker?.emit?.({ id: zipConcurrentSecondId, type: 'meta', counts: { fbx: 0, images: 0, geojson: 0 } });
            zipConcurrentWorker?.emit?.({ id: zipConcurrentSecondId, type: 'done' });
            const zipConcurrentSecondResult = await zipConcurrentSecondPromise;
            zipConcurrentClient.dispose();

            let fbxParseFailureResult = '';
            let fbxParseFailureGeometryDisposed = 0;
            let fbxParseFailureMaterialDisposed = 0;
            let fbxParseFailureSkeletonDisposed = 0;
            {
                const nativeGeometryDispose = THREE.BufferGeometry.prototype.dispose;
                const nativeMaterialDispose = THREE.Material.prototype.dispose;
                const nativeSkeletonDispose = THREE.Skeleton.prototype.dispose;
                const nativeObjectLoaderParse = THREE.ObjectLoader.prototype.parse;
                const failureRoot = new THREE.Group();
                const failureGeometry = new THREE.BufferGeometry();
                failureGeometry.name = 'fbxParseFailureGeometry';
                failureGeometry.setAttribute('position', new THREE.Float32BufferAttribute([
                    0, 0, 0,
                    1, 0, 0,
                    0, 1, 0,
                ], 3));
                const failureMaterial = new THREE.MeshBasicMaterial({ name: 'fbxParseFailureMaterial' });
                const failureBone = new THREE.Bone();
                const failureSkeleton = new THREE.Skeleton([failureBone]);
                const failureMesh = new THREE.SkinnedMesh(failureGeometry, failureMaterial);
                failureMesh.add(failureBone);
                failureMesh.bind(failureSkeleton);
                failureRoot.add(failureMesh);
                THREE.BufferGeometry.prototype.dispose = function smokeFBXParseFailureGeometryDispose(...args) {
                    if (this.name === 'fbxParseFailureGeometry') {
                        fbxParseFailureGeometryDisposed += 1;
                    }
                    return nativeGeometryDispose.apply(this, args);
                };
                THREE.Material.prototype.dispose = function smokeFBXParseFailureMaterialDispose(...args) {
                    if (this.name === 'fbxParseFailureMaterial') {
                        fbxParseFailureMaterialDisposed += 1;
                    }
                    return nativeMaterialDispose.apply(this, args);
                };
                THREE.Skeleton.prototype.dispose = function smokeFBXParseFailureSkeletonDispose(...args) {
                    if (this === failureSkeleton) {
                        fbxParseFailureSkeletonDisposed += 1;
                    }
                    return nativeSkeletonDispose?.apply(this, args);
                };
                THREE.ObjectLoader.prototype.parse = function smokeFBXParseFailureObjectParse() {
                    return failureRoot;
                };
                try {
                    const fbxParseFailureStartIndex = workers.length;
                    const fbxParseFailureClient = createFBXWorkerClient({ workerUrl: '/fake-fbx-worker-parse-failure.js' });
                    const fbxParseFailurePromise = fbxParseFailureClient.parseFBXInWorker(
                        new ArrayBuffer(4),
                        { embedded: true, orientation: true }
                    ).then(
                        () => 'resolved',
                        (err) => `${err?.name || 'Error'}:${err?.message || err}`,
                    );
                    await Promise.resolve();
                    const fbxParseFailureWorker = workers[fbxParseFailureStartIndex] || null;
                    const fbxParseFailureJobId = fbxParseFailureWorker?.messages?.[0]?.id || 1;
                    fbxParseFailureWorker?.emit?.({
                        id: fbxParseFailureJobId,
                        ok: true,
                        json: {
                            animations: {
                                length: 1,
                                map() {
                                    throw new Error('clip rebuild failed');
                                },
                            },
                        },
                        duration: 1,
                        embedded: [],
                        orientation: null,
                    });
                    fbxParseFailureResult = await fbxParseFailurePromise;
                    fbxParseFailureClient.dispose();
                } finally {
                    THREE.BufferGeometry.prototype.dispose = nativeGeometryDispose;
                    THREE.Material.prototype.dispose = nativeMaterialDispose;
                    THREE.Skeleton.prototype.dispose = nativeSkeletonDispose;
                    THREE.ObjectLoader.prototype.parse = nativeObjectLoaderParse;
                }
            }

            const zipHandlerErrorStartIndex = workers.length;
            const zipHandlerErrorClient = createZIPWorkerClient({ workerUrl: '/fake-zip-worker-handler-error.js' });
            const zipHandlerErrorEvents = [];
            const zipHandlerErrorFile = new File([new Uint8Array([9, 8, 7])], 'handler-error.zip', { type: 'application/zip' });
            const zipHandlerErrorPromise = zipHandlerErrorClient.unpackZIPInWorker(zipHandlerErrorFile, {
                onFBX: async () => {
                    zipHandlerErrorEvents.push('fbx');
                    throw new Error('handler import failed');
                },
                onImage: () => zipHandlerErrorEvents.push('image'),
                onMeta: () => zipHandlerErrorEvents.push('meta'),
            }).then(
                () => 'resolved',
                (err) => `${err?.name || 'Error'}:${err?.message || err}`,
            );
            const zipHandlerErrorWorker = await waitForWorkerMessage(zipHandlerErrorStartIndex, 1);
            const zipHandlerErrorJobId = zipHandlerErrorWorker?.messages?.[0]?.id || 1;
            zipHandlerErrorWorker?.emit?.({
                id: zipHandlerErrorJobId,
                type: 'fbx',
                seq: 1,
                name: 'bad.fbx',
                fileName: 'bad.fbx',
                blob: new Blob([new Uint8Array([1])], { type: 'model/fbx' }),
            });
            const zipHandlerErrorResult = await zipHandlerErrorPromise;
            const zipHandlerErrorTerminated = zipHandlerErrorWorker?.terminated || 0;
            const zipHandlerErrorAckCount = zipHandlerErrorWorker?.messages
                ?.filter((message) => message?.type === 'ack')
                .length || 0;
            zipHandlerErrorWorker?.emit?.({ id: zipHandlerErrorJobId, type: 'done' });
            await Promise.resolve();
            await Promise.resolve();
            const zipHandlerErrorEventsAfterStale = zipHandlerErrorEvents.slice();

            const zipHandlerRecoveryPreviousPostCount = zipHandlerErrorWorker?.messages?.length || 0;
            const zipHandlerRecoveryMeta = [];
            const zipHandlerRecoveryPromise = zipHandlerErrorClient.unpackZIPInWorker(zipHandlerErrorFile, {
                onMeta: (msg) => zipHandlerRecoveryMeta.push(msg.counts?.fbx ?? -1),
            }).then(
                (msg) => msg?.type || 'resolved',
                (err) => `${err?.name || 'Error'}:${err?.message || err}`,
            );
            const zipHandlerRecoveryIndex = zipHandlerErrorTerminated
                ? zipHandlerErrorStartIndex + 1
                : zipHandlerErrorStartIndex;
            const zipHandlerRecoveryPostCount = zipHandlerErrorTerminated
                ? 1
                : zipHandlerRecoveryPreviousPostCount + 1;
            const zipHandlerRecoveryWorker = await waitForWorkerMessage(zipHandlerRecoveryIndex, zipHandlerRecoveryPostCount);
            const zipHandlerRecoveryMessage = zipHandlerRecoveryWorker?.messages?.at?.(-1) || null;
            const zipHandlerRecoveryJobId = zipHandlerRecoveryMessage?.id || (zipHandlerErrorJobId + 1);
            zipHandlerRecoveryWorker?.emit?.({
                id: zipHandlerRecoveryJobId,
                type: 'meta',
                counts: { fbx: 0, images: 0, geojson: 0 },
            });
            zipHandlerRecoveryWorker?.emit?.({ id: zipHandlerRecoveryJobId, type: 'done' });
            const zipHandlerRecoveryResult = await zipHandlerRecoveryPromise;
            const zipHandlerRecoveryWorkerCount = workers.length - zipHandlerErrorStartIndex;
            const zipHandlerRecoveryReusedWorker = zipHandlerRecoveryWorker === zipHandlerErrorWorker;

            workers.length = 0;
            const assetLoaders = createAssetLoaders({ THREE });
            const assetFbxPromise = assetLoaders.parseFBXInWorker(new ArrayBuffer(2)).then(
                () => 'resolved',
                (err) => `${err?.name || 'Error'}:${err?.message || err}`,
            );
            const assetZipPromise = assetLoaders.unpackZIPInWorker(zipFile).then(
                () => 'resolved',
                (err) => `${err?.name || 'Error'}:${err?.message || err}`,
            );
            await waitForWorkerMessage(0, 1);
            await waitForWorkerMessage(1, 1);
            const assetWorkerCount = workers.length;
            assetLoaders.dispose();
            assetLoaders.dispose();
            const assetResults = await Promise.all([assetFbxPromise, assetZipPromise]);
            const assetTerminated = workers.map((worker) => worker.terminated);

            return {
                fbxPostedBeforeDispose,
                fbxSupportedBeforeDispose,
                fbxResult,
                fbxTerminated: fbxWorker?.terminated || 0,
                fbxSupportedAfterDispose: fbxClient.isSupported(),
                fbxAfterDispose,
                zipPostedBeforeDispose,
                zipSupportedBeforeDispose,
                zipResult,
                zipTerminated: zipWorker?.terminated || 0,
                zipSupportedAfterDispose: zipClient.isSupported(),
                zipAfterDispose,
                zipEvents,
                lateFbxResult,
                lateFbxTerminated: lateFbxWorker?.terminated || 0,
                zipRaceResult,
                zipRacePostedAfterDispose,
                zipRaceTerminated: zipRaceWorker?.terminated || 0,
                zipRaceEvents,
                fbxConcurrentFirstResult,
                fbxConcurrentSecondResult,
                fbxConcurrentTerminatedBeforeSecond,
                fbxConcurrentCancelCount,
                zipConcurrentFirstResult,
                zipConcurrentSecondResult,
                zipConcurrentTerminatedBeforeSecond,
                zipConcurrentCancelCount,
                zipConcurrentMeta,
                fbxParseFailureResult,
                fbxParseFailureGeometryDisposed,
                fbxParseFailureMaterialDisposed,
                fbxParseFailureSkeletonDisposed,
                zipHandlerErrorResult,
                zipHandlerErrorTerminated,
                zipHandlerErrorAckCount,
                zipHandlerErrorEventsAfterStale,
                zipHandlerRecoveryResult,
                zipHandlerRecoveryMeta,
                zipHandlerRecoveryWorkerCount,
                zipHandlerRecoveryReusedWorker,
                assetWorkerCount,
                assetResults,
                assetTerminated,
            };
        } finally {
            globalThis.Worker = nativeWorker;
        }
    });

    assert.equal(result.fbxSupportedBeforeDispose, true, 'Worker client dispose smoke: FBX worker was not supported before dispose');
    assert.equal(result.fbxPostedBeforeDispose, 1, 'Worker client dispose smoke: FBX job was not posted');
    assert.match(result.fbxResult, /^AbortError:/, 'Worker client dispose smoke: pending FBX job was not aborted on dispose');
    assert.equal(result.fbxTerminated, 1, 'Worker client dispose smoke: FBX worker was not terminated exactly once');
    assert.equal(result.fbxSupportedAfterDispose, false, 'Worker client dispose smoke: FBX client stayed supported after dispose');
    assert.match(result.fbxAfterDispose, /^AbortError:/, 'Worker client dispose smoke: disposed FBX client accepted a new job');
    assert.equal(result.zipSupportedBeforeDispose, true, 'Worker client dispose smoke: ZIP worker was not supported before dispose');
    assert.equal(result.zipPostedBeforeDispose, 1, 'Worker client dispose smoke: ZIP job was not posted');
    assert.match(result.zipResult, /^AbortError:/, 'Worker client dispose smoke: pending ZIP job was not aborted on dispose');
    assert.equal(result.zipTerminated, 1, 'Worker client dispose smoke: ZIP worker was not terminated exactly once');
    assert.equal(result.zipSupportedAfterDispose, false, 'Worker client dispose smoke: ZIP client stayed supported after dispose');
    assert.match(result.zipAfterDispose, /^AbortError:/, 'Worker client dispose smoke: disposed ZIP client accepted a new job');
    assert.deepEqual(result.zipEvents, [], 'Worker client dispose smoke: stale ZIP worker messages reached handlers after dispose');
    assert.match(result.lateFbxResult, /^AbortError:/, 'Worker client dispose smoke: FBX resolved response survived dispose');
    assert.equal(result.lateFbxTerminated, 1, 'Worker client dispose smoke: late FBX worker was not terminated');
    assert.match(result.zipRaceResult, /^AbortError:/, 'Worker client dispose smoke: ZIP arrayBuffer race did not abort on dispose');
    assert.equal(result.zipRacePostedAfterDispose, 0, 'Worker client dispose smoke: ZIP posted to worker after dispose');
    assert.equal(result.zipRaceTerminated, 1, 'Worker client dispose smoke: ZIP arrayBuffer race worker was not terminated');
    assert.deepEqual(result.zipRaceEvents, [], 'Worker client dispose smoke: ZIP arrayBuffer race fired onError after dispose');
    assert.match(result.fbxConcurrentFirstResult, /^AbortError:/, 'Worker client dispose smoke: aborted FBX job did not reject');
    assert.equal(result.fbxConcurrentSecondResult, 'resolved', 'Worker client dispose smoke: aborting one FBX job rejected a sibling job');
    assert.equal(result.fbxConcurrentTerminatedBeforeSecond, 0, 'Worker client dispose smoke: aborting one FBX job terminated a worker with pending siblings');
    assert.equal(result.fbxConcurrentCancelCount, 1, 'Worker client dispose smoke: FBX job abort did not send a scoped cancel');
    assert.match(result.zipConcurrentFirstResult, /^AbortError:/, 'Worker client dispose smoke: aborted ZIP job did not reject');
    assert.equal(result.zipConcurrentSecondResult, 'done', 'Worker client dispose smoke: aborting one ZIP job rejected a sibling job');
    assert.equal(result.zipConcurrentTerminatedBeforeSecond, 0, 'Worker client dispose smoke: aborting one ZIP job terminated a worker with pending siblings');
    assert.equal(result.zipConcurrentCancelCount, 1, 'Worker client dispose smoke: ZIP job abort did not send a scoped cancel');
    assert.deepEqual(result.zipConcurrentMeta, ['second'], 'Worker client dispose smoke: stale ZIP messages reached aborted job handlers');
    assert.equal(result.fbxParseFailureResult, 'Error:clip rebuild failed', 'Worker client dispose smoke: FBX parse failure was not propagated');
    assert.equal(result.fbxParseFailureGeometryDisposed, 1, 'Worker client dispose smoke: FBX parse failure leaked restored geometry');
    assert.equal(result.fbxParseFailureMaterialDisposed, 1, 'Worker client dispose smoke: FBX parse failure leaked restored material');
    assert.equal(result.fbxParseFailureSkeletonDisposed, 1, 'Worker client dispose smoke: FBX parse failure leaked restored skeleton');
    assert.equal(result.zipHandlerErrorResult, 'Error:handler import failed', 'Worker client dispose smoke: ZIP handler failure did not reject import');
    assert.equal(result.zipHandlerErrorTerminated, 1, 'Worker client dispose smoke: ZIP handler failure left worker alive');
    assert.equal(result.zipHandlerErrorAckCount, 0, 'Worker client dispose smoke: ZIP handler failure still acked the failed chunk');
    assert.deepEqual(result.zipHandlerErrorEventsAfterStale, ['fbx'], 'Worker client dispose smoke: stale ZIP messages reached handlers after handler failure');
    assert.equal(result.zipHandlerRecoveryResult, 'done', 'Worker client dispose smoke: ZIP client did not recover after handler failure');
    assert.deepEqual(result.zipHandlerRecoveryMeta, [0], 'Worker client dispose smoke: ZIP recovery job missed worker messages');
    assert.equal(result.zipHandlerRecoveryWorkerCount, 2, 'Worker client dispose smoke: ZIP handler failure did not recreate worker');
    assert.equal(result.zipHandlerRecoveryReusedWorker, false, 'Worker client dispose smoke: ZIP recovery reused failed worker');
    assert.equal(result.assetWorkerCount, 2, 'Worker client dispose smoke: asset loaders did not create both workers');
    assert.equal(result.assetResults.length, 2, 'Worker client dispose smoke: asset loader jobs did not settle');
    result.assetResults.forEach((entry) => {
        assert.match(entry, /^AbortError:/, 'Worker client dispose smoke: asset loader dispose did not abort a worker job');
    });
    assert.deepEqual(result.assetTerminated, [1, 1], 'Worker client dispose smoke: asset loader dispose did not terminate both workers');
    diagnostics.assertNoErrors('Worker client dispose smoke');
    await page.close();
}

async function runZIPFallbackCleanupSmoke(browser, baseUrl) {
    const page = await browser.newPage();
    const diagnostics = attachPageDiagnostics(page);
    await page.goto(`${baseUrl}/__smoke_blank`, { waitUntil: 'domcontentloaded', timeout: 15000 });

    const result = await page.evaluate(async () => {
        const { createZIPFileHandler } = await import('/scripts/modules/io/zip-file.js');
        const loadedModels = [];
        const allEmbedded = [];
        const cleanupCalls = [];
        const fallbackLogs = [];

        const handleZIPFile = createZIPFileHandler({
            loadedModels,
            allEmbedded,
            basename: (path) => String(path || '').split(/[\\/]/).pop(),
            unpackZIPInWorker: async (_file, handlers) => {
                await handlers.onFBX?.({
                    blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'model/fbx' }),
                    fileName: 'partial.fbx',
                    name: 'partial.fbx',
                });
                await handlers.onImage?.({
                    blob: new Blob([new Uint8Array([4, 5, 6])], { type: 'image/png' }),
                    name: 'textures/partial.png',
                    mime: 'image/png',
                });
                throw new Error('simulated ZIP worker failure');
            },
            handleFBXFile: async (file, groupName) => {
                loadedModels.push({
                    obj: { name: file.name },
                    name: file.name,
                    group: groupName || null,
                });
            },
            cleanupImportedRange: ({ modelStart = 0, embeddedStart = 0 } = {}) => {
                cleanupCalls.push({
                    modelStart,
                    embeddedStart,
                    modelCountBefore: loadedModels.length,
                    embeddedCountBefore: allEmbedded.length,
                });
                loadedModels.splice(modelStart);
                allEmbedded.splice(embeddedStart).forEach((entry) => {
                    const url = String(entry?.url || '');
                    if (url.startsWith('blob:')) URL.revokeObjectURL(url);
                });
            },
            JSZip: {
                loadAsync: async () => ({ files: {} }),
            },
            logBind: (message, level) => {
                fallbackLogs.push({ message: String(message || ''), level: String(level || '') });
            },
        });

        await handleZIPFile(new File([new Uint8Array([1])], 'fallback.zip', { type: 'application/zip' }));

        const handleFailingFallbackZIPFile = createZIPFileHandler({
            loadedModels,
            allEmbedded,
            basename: (path) => String(path || '').split(/[\\/]/).pop(),
            handleFBXFile: async (file, groupName) => {
                loadedModels.push({
                    obj: { name: file.name },
                    name: file.name,
                    group: groupName || null,
                });
            },
            cleanupImportedRange: ({ modelStart = 0, embeddedStart = 0 } = {}) => {
                cleanupCalls.push({
                    modelStart,
                    embeddedStart,
                    modelCountBefore: loadedModels.length,
                    embeddedCountBefore: allEmbedded.length,
                });
                loadedModels.splice(modelStart);
                allEmbedded.splice(embeddedStart).forEach((entry) => {
                    const url = String(entry?.url || '');
                    if (url.startsWith('blob:')) URL.revokeObjectURL(url);
                });
            },
            JSZip: {
                loadAsync: async () => ({
                    files: {
                        'model.fbx': {
                            dir: false,
                            name: 'model.fbx',
                            async: async () => new ArrayBuffer(3),
                        },
                        'textures/ok.png': {
                            dir: false,
                            name: 'textures/ok.png',
                            async: async () => new Blob([new Uint8Array([7, 8, 9])], { type: 'image/png' }),
                        },
                        'textures/broken.png': {
                            dir: false,
                            name: 'textures/broken.png',
                            async: async () => {
                                throw new Error('broken fallback image');
                            },
                        },
                    },
                }),
            },
        });
        const fallbackFailureResult = await handleFailingFallbackZIPFile(
            new File([new Uint8Array([2])], 'main-fallback.zip', { type: 'application/zip' })
        ).then(
            () => 'resolved',
            (err) => err?.message || String(err),
        );

        return {
            cleanupCalls,
            fallbackFailureResult,
            loadedCount: loadedModels.length,
            embeddedCount: allEmbedded.length,
            fallbackLogged: fallbackLogs.some((entry) => entry.level === 'warn' && entry.message.includes('fallback')),
        };
    });

    assert.equal(result.cleanupCalls.length, 2, 'ZIP fallback cleanup smoke: partial imports were not cleaned consistently');
    assert.deepEqual(result.cleanupCalls[0], {
        modelStart: 0,
        embeddedStart: 0,
        modelCountBefore: 1,
        embeddedCountBefore: 1,
    }, 'ZIP fallback cleanup smoke: cleanup range did not match partial worker import');
    assert.deepEqual(result.cleanupCalls[1], {
        modelStart: 0,
        embeddedStart: 0,
        modelCountBefore: 1,
        embeddedCountBefore: 1,
    }, 'ZIP fallback cleanup smoke: cleanup range did not match partial main-thread fallback import');
    assert.equal(result.fallbackFailureResult, 'broken fallback image', 'ZIP fallback cleanup smoke: fallback failure was not propagated');
    assert.equal(result.loadedCount, 0, 'ZIP fallback cleanup smoke: partial worker model survived fallback cleanup');
    assert.equal(result.embeddedCount, 0, 'ZIP fallback cleanup smoke: partial worker texture survived fallback cleanup');
    assert.equal(result.fallbackLogged, true, 'ZIP fallback cleanup smoke: fallback path was not exercised');
    diagnostics.assertNoErrors('ZIP fallback cleanup smoke');
    await page.close();
}

async function runGeoJsonMetaLifecycleSmoke(browser, baseUrl) {
    const page = await browser.newPage();
    const diagnostics = attachPageDiagnostics(page);
    await page.goto(`${baseUrl}/__smoke_blank`, { waitUntil: 'domcontentloaded', timeout: 15000 });

    const result = await page.evaluate(async () => {
        const { makeGeoJsonMeta, revokeGeoJsonMetaUrl } = await import('/scripts/modules/geo/geojson-meta.js');
        const { createZIPFileHandler } = await import('/scripts/modules/io/zip-file.js');
        const nativeCreateObjectURL = URL.createObjectURL;
        const nativeRevokeObjectURL = URL.revokeObjectURL;
        const revoked = [];
        let nextUrlId = 0;

        URL.createObjectURL = () => `blob:geo-${++nextUrlId}`;
        URL.revokeObjectURL = (url) => {
            revoked.push(String(url || ''));
        };

        try {
            const directMeta = makeGeoJsonMeta('SM_direct.zip', 'direct.geojson', '{"type":"FeatureCollection","features":[]}');
            const directUrl = directMeta.url;
            const directFirst = revokeGeoJsonMetaUrl(directMeta);
            const directSecond = revokeGeoJsonMetaUrl(directMeta);

            const workerFallbackHandler = createZIPFileHandler({
                basename: (path) => String(path || '').split(/[\\/]/).pop(),
                makeGeoJsonMeta,
                unpackZIPInWorker: async (_file, handlers) => {
                    await handlers.onGeoJSON?.({
                        name: 'worker.geojson',
                        text: '{"type":"FeatureCollection","features":[]}',
                    });
                    throw new Error('simulated worker failure');
                },
                JSZip: {
                    loadAsync: async () => {
                        throw new Error('simulated fallback failure');
                    },
                },
            });
            const workerFallbackResult = await workerFallbackHandler(
                new File([new Uint8Array([1])], 'SM_worker_fail.zip', { type: 'application/zip' })
            ).then(
                () => 'resolved',
                (err) => err?.message || String(err),
            );

            let workerAbortFallbackCalled = false;
            const workerAbortHandler = createZIPFileHandler({
                basename: (path) => String(path || '').split(/[\\/]/).pop(),
                makeGeoJsonMeta,
                unpackZIPInWorker: async (_file, handlers) => {
                    await handlers.onGeoJSON?.({
                        name: 'worker-abort.geojson',
                        text: '{"type":"FeatureCollection","features":[]}',
                    });
                    throw new DOMException('simulated worker abort', 'AbortError');
                },
                JSZip: {
                    loadAsync: async () => {
                        workerAbortFallbackCalled = true;
                        return { files: {} };
                    },
                },
            });
            const workerAbortResult = await workerAbortHandler(
                new File([new Uint8Array([3])], 'SM_worker_abort.zip', { type: 'application/zip' })
            ).then(
                () => 'resolved',
                (err) => `${err?.name || 'Error'}:${err?.message || String(err)}`,
            );

            const emptyZipHandler = createZIPFileHandler({
                basename: (path) => String(path || '').split(/[\\/]/).pop(),
                makeGeoJsonMeta,
                unpackZIPInWorker: null,
                JSZip: {
                    loadAsync: async () => ({
                        files: {
                            'meta.geojson': {
                                dir: false,
                                name: 'meta.geojson',
                                async: async () => new TextEncoder().encode('{"type":"FeatureCollection","features":[]}'),
                            },
                        },
                    }),
                },
            });
            const emptyZipResult = await emptyZipHandler(
                new File([new Uint8Array([2])], 'SM_empty.zip', { type: 'application/zip' })
            ).then(
                () => 'resolved',
                (err) => err?.message || String(err),
            );

            return {
                directUrl,
                directFirst,
                directSecond,
                directMetaUrlAfterRevoke: directMeta.url,
                workerFallbackResult,
                workerAbortResult,
                workerAbortFallbackCalled,
                emptyZipResult,
                revoked,
            };
        } finally {
            URL.createObjectURL = nativeCreateObjectURL;
            URL.revokeObjectURL = nativeRevokeObjectURL;
        }
    });

    assert.equal(result.directUrl, 'blob:geo-1', 'GeoJSON meta smoke: direct meta did not receive a blob URL');
    assert.equal(result.directFirst, true, 'GeoJSON meta smoke: direct meta URL was not revoked');
    assert.equal(result.directSecond, false, 'GeoJSON meta smoke: direct revoke was not idempotent');
    assert.equal(result.directMetaUrlAfterRevoke, '', 'GeoJSON meta smoke: revoked direct meta kept stale URL');
    assert.equal(result.workerFallbackResult, 'simulated fallback failure', 'GeoJSON meta smoke: worker fallback path was not exercised');
    assert.equal(result.workerAbortResult, 'AbortError:simulated worker abort', 'GeoJSON meta smoke: worker abort was not propagated as abort');
    assert.equal(result.workerAbortFallbackCalled, false, 'GeoJSON meta smoke: worker abort incorrectly started main-thread fallback');
    assert.equal(result.emptyZipResult, 'resolved', 'GeoJSON meta smoke: empty ZIP fallback did not complete');
    assert.deepEqual(
        result.revoked,
        ['blob:geo-1', 'blob:geo-2', 'blob:geo-3', 'blob:geo-4'],
        'GeoJSON meta smoke: leaked or double-revoked GeoJSON blob URLs',
    );
    diagnostics.assertNoErrors('GeoJSON meta lifecycle smoke');
    await page.close();
}

async function runFBXCleanupLifecycleSmoke(browser, baseUrl) {
    const page = await browser.newPage();
    const diagnostics = attachPageDiagnostics(page);
    await page.goto(`${baseUrl}/__smoke_blank`, { waitUntil: 'domcontentloaded', timeout: 15000 });

    const result = await page.evaluate(async () => {
        const THREE = await import('three');
        const { splitMeshByUDIM } = await import('/scripts/modules/fbx/udim-split.js');
        const { createFBXFileHandler } = await import('/scripts/modules/io/fbx-file.js');
        const { createEmbeddedImageEntriesFromBuffers } = await import('/scripts/modules/fbx/embedded-images.js');

        const disposedGeometries = [];
        const disposedMaterials = [];
        const revokedUrls = [];
        let skeletonDisposed = 0;
        const nativeDispose = THREE.BufferGeometry.prototype.dispose;
        const nativeMaterialDispose = THREE.Material.prototype.dispose;
        const nativeCreateObjectURL = URL.createObjectURL;
        const nativeRevokeObjectURL = URL.revokeObjectURL;
        const debugGlobalDescriptors = {
            loader: Object.getOwnPropertyDescriptor(globalThis, '__fbxLoader'),
            last: Object.getOwnPropertyDescriptor(globalThis, '__lastFBXLoaded'),
            parsed: Object.getOwnPropertyDescriptor(globalThis, '__fbxParsedInWorker'),
        };
        THREE.BufferGeometry.prototype.dispose = function patchedDispose(...args) {
            disposedGeometries.push(this.name || this.uuid || 'geometry');
            return nativeDispose.apply(this, args);
        };
        THREE.Material.prototype.dispose = function patchedMaterialDispose(...args) {
            disposedMaterials.push(this.name || this.uuid || 'material');
            return nativeMaterialDispose.apply(this, args);
        };
        URL.revokeObjectURL = (url) => {
            revokedUrls.push(String(url || ''));
            return nativeRevokeObjectURL.call(URL, url);
        };

        function makeGeometry({ split = false } = {}) {
            const geometry = new THREE.BufferGeometry();
            geometry.name = split ? 'splitSource' : 'singleSource';
            geometry.setAttribute('position', new THREE.Float32BufferAttribute([
                0, 0, 0,
                1, 0, 0,
                0, 1, 0,
                0, 0, 1,
                1, 0, 1,
                0, 1, 1,
            ], 3));
            geometry.setAttribute('uv', new THREE.Float32BufferAttribute(split ? [
                0.1, 0.1,
                0.2, 0.1,
                0.1, 0.2,
                1.1, 0.1,
                1.2, 0.1,
                1.1, 0.2,
            ] : [
                0.1, 0.1,
                0.2, 0.1,
                0.1, 0.2,
                0.3, 0.1,
                0.4, 0.1,
                0.3, 0.2,
            ], 2));
            return geometry;
        }

        try {
            const singleParent = new THREE.Group();
            const singleMesh = new THREE.Mesh(makeGeometry(), new THREE.MeshBasicMaterial({ name: 'singleMaterial' }));
            singleParent.add(singleMesh);
            const beforeSingle = disposedGeometries.length;
            const singleResult = splitMeshByUDIM(singleMesh);
            const singleDisposed = disposedGeometries.length - beforeSingle;

            const splitParent = new THREE.Group();
            const sourceMaterial = new THREE.MeshBasicMaterial({ name: 'sourceMaterial' });
            const customDepth = new THREE.MeshDepthMaterial();
            const customDistance = new THREE.MeshDistanceMaterial();
            const splitMesh = new THREE.Mesh(makeGeometry({ split: true }), sourceMaterial);
            splitMesh.customDepthMaterial = customDepth;
            splitMesh.customDistanceMaterial = customDistance;
            splitParent.add(splitMesh);

            const beforeSplit = disposedGeometries.length;
            const splitResult = splitMeshByUDIM(splitMesh);
            const splitDisposed = disposedGeometries.length - beforeSplit;
            const holder = splitParent.children[0] || null;

            const failingParent = new THREE.Group();
            const failingSourceGeometry = makeGeometry({ split: true });
            failingSourceGeometry.name = 'failingSplitSource';
            const failingSourceMaterial = new THREE.MeshBasicMaterial({ name: 'failingSourceMaterial' });
            let failingSourceGeometryDisposed = 0;
            let failingCloneMaterialDisposed = 0;
            failingSourceGeometry.addEventListener('dispose', () => {
                failingSourceGeometryDisposed += 1;
            });
            let cloneCount = 0;
            failingSourceMaterial.clone = function cloneWithFailure() {
                cloneCount += 1;
                if (cloneCount > 1) throw new Error('clone failure');
                const material = new THREE.MeshBasicMaterial({ name: 'failingCloneMaterial' });
                material.addEventListener('dispose', () => {
                    failingCloneMaterialDisposed += 1;
                });
                return material;
            };
            const failingMesh = new THREE.Mesh(failingSourceGeometry, failingSourceMaterial);
            failingParent.add(failingMesh);
            const beforeFailingSplitGeometries = disposedGeometries.length;
            const beforeFailingSplitMaterials = disposedMaterials.length;
            const failingSplitResult = (() => {
                try {
                    splitMeshByUDIM(failingMesh);
                    return 'resolved';
                } catch (err) {
                    return err?.message || String(err);
                }
            })();
            const failingSplitDisposedGeometries = disposedGeometries.length - beforeFailingSplitGeometries;
            const failingSplitDisposedMaterials = disposedMaterials.length - beforeFailingSplitMaterials;

            const abortWorld = new THREE.Group();
            const abortLoadedModels = [];
            const abortRoot = new THREE.Group();
            const abortGeometry = makeGeometry();
            abortGeometry.name = 'abortGeometry';
            const abortMaterial = new THREE.MeshBasicMaterial({ name: 'abortMaterial' });
            const abortMesh = new THREE.Mesh(abortGeometry, abortMaterial);
            abortMesh.skeleton = {
                dispose: () => {
                    skeletonDisposed += 1;
                },
            };
            abortRoot.add(abortMesh);

            let releaseParse = null;
            let markParseStarted = null;
            const parseStarted = new Promise((resolve) => {
                markParseStarted = resolve;
            });
            const abortController = new AbortController();
            const handleFBXFile = createFBXFileHandler({
                THREE,
                world: abortWorld,
                loadedModels: abortLoadedModels,
                parseFBXOnMainThread: async () => {
                    markParseStarted();
                    await new Promise((resolve) => {
                        releaseParse = resolve;
                    });
                    return { obj: abortRoot, duration: 1 };
                },
            });
            const abortPromise = handleFBXFile(
                new File([new Uint8Array([1, 2, 3])], 'abort.fbx', { type: 'application/octet-stream' }),
                null,
                null,
                null,
                { signal: abortController.signal },
            ).then(
                () => 'resolved',
                (err) => err?.name || String(err),
            );
            await parseStarted;
            abortController.abort();
            releaseParse();
            const abortResult = await abortPromise;

            const workerEmbeddedWorld = new THREE.Group();
            const workerEmbeddedLoadedModels = [];
            const workerRoot = new THREE.Group();
            const workerGeometry = makeGeometry();
            workerGeometry.name = 'workerEmbeddedGeometry';
            const workerMaterial = new THREE.MeshBasicMaterial({ name: 'workerEmbeddedMaterial' });
            workerRoot.add(new THREE.Mesh(workerGeometry, workerMaterial));
            const workerFallbackRoot = new THREE.Group();
            const workerFallbackGeometry = makeGeometry();
            workerFallbackGeometry.name = 'workerEmbeddedFallbackGeometry';
            const workerFallbackMaterial = new THREE.MeshBasicMaterial({ name: 'workerEmbeddedFallbackMaterial' });
            workerFallbackRoot.add(new THREE.Mesh(workerFallbackGeometry, workerFallbackMaterial));
            const workerEmbeddedSetSupported = [];
            let workerEmbeddedDisableCalls = 0;
            let workerEmbeddedCreateCount = 0;
            URL.createObjectURL = () => {
                workerEmbeddedCreateCount += 1;
                if (workerEmbeddedCreateCount === 1) return 'blob:worker-embedded-1';
                throw new Error('worker embedded url failed');
            };
            const workerEmbeddedHandleFBXFile = createFBXFileHandler({
                THREE,
                world: workerEmbeddedWorld,
                loadedModels: workerEmbeddedLoadedModels,
                parseFBXInWorker: async () => ({
                    obj: workerRoot,
                    duration: 1,
                    orientationInfo: { source: 'worker-smoke' },
                    embedded: [
                        { short: 'first.png', full: 'textures/first.png', mime: 'image/png', buffer: new ArrayBuffer(4) },
                        { short: 'second.png', full: 'textures/second.png', mime: 'image/png', buffer: new ArrayBuffer(4) },
                    ],
                }),
                parseFBXOnMainThread: () => ({ obj: workerFallbackRoot, duration: 2 }),
                isWorkerSupported: () => true,
                setWorkerSupported: (value) => workerEmbeddedSetSupported.push(!!value),
                disableWorker: () => {
                    workerEmbeddedDisableCalls += 1;
                },
            });
            const workerEmbeddedResult = await workerEmbeddedHandleFBXFile(
                new File([new Uint8Array([20, 21, 22])], 'worker-embedded.fbx', { type: 'application/octet-stream' }),
            ).then(
                () => 'resolved',
                (err) => err?.message || String(err),
            );
            URL.createObjectURL = nativeCreateObjectURL;

            let extractCreateCount = 0;
            URL.createObjectURL = () => {
                extractCreateCount += 1;
                if (extractCreateCount === 1) return 'blob:extract-embedded-1';
                throw new Error('extract url failed');
            };
            let extractRollbackResult = '';
            try {
                createEmbeddedImageEntriesFromBuffers([
                    { short: 'a.png', full: 'a.png', mime: 'image/png', buffer: new ArrayBuffer(4) },
                    { short: 'b.png', full: 'b.png', mime: 'image/png', buffer: new ArrayBuffer(4) },
                ]);
                extractRollbackResult = 'resolved';
            } catch (err) {
                extractRollbackResult = err?.message || String(err);
            }
            await Promise.resolve();
            URL.createObjectURL = nativeCreateObjectURL;

            const mainEmbeddedFailureWorld = new THREE.Group();
            const mainEmbeddedFailureLoadedModels = [];
            const mainEmbeddedFailureRoot = new THREE.Group();
            const mainEmbeddedFailureGeometry = makeGeometry();
            mainEmbeddedFailureGeometry.name = 'mainEmbeddedFailureGeometry';
            const mainEmbeddedFailureMaterial = new THREE.MeshBasicMaterial({ name: 'mainEmbeddedFailureMaterial' });
            mainEmbeddedFailureRoot.add(new THREE.Mesh(mainEmbeddedFailureGeometry, mainEmbeddedFailureMaterial));
            const mainEmbeddedFailureHandleFBXFile = createFBXFileHandler({
                THREE,
                world: mainEmbeddedFailureWorld,
                loadedModels: mainEmbeddedFailureLoadedModels,
                parseFBXOnMainThread: () => ({ obj: mainEmbeddedFailureRoot, duration: 1 }),
                extractImagesFromFBX: async () => {
                    throw new Error('main embedded extraction failed');
                },
            });
            const mainEmbeddedFailureResult = await mainEmbeddedFailureHandleFBXFile(
                new File([new Uint8Array([23, 24, 25])], 'main-embedded-failure.fbx', { type: 'application/octet-stream' }),
            ).then(
                () => 'resolved',
                (err) => err?.message || String(err),
            );

            const emptyParserWorld = new THREE.Group();
            const emptyParserLoadedModels = [];
            const emptyParserEmbedded = [];
            const emptyParserUrl = URL.createObjectURL(new Blob(['png'], { type: 'image/png' }));
            const emptyParserHandleFBXFile = createFBXFileHandler({
                THREE,
                world: emptyParserWorld,
                loadedModels: emptyParserLoadedModels,
                allEmbedded: emptyParserEmbedded,
                parseFBXOnMainThread: () => ({ obj: null, duration: 1 }),
                extractImagesFromFBX: async () => [{
                    short: 'empty-parser.png',
                    full: 'empty-parser.png',
                    url: emptyParserUrl,
                    mime: 'image/png',
                    source: 'embedded',
                }],
            });
            const emptyParserResult = await emptyParserHandleFBXFile(
                new File([new Uint8Array([26, 27, 28])], 'empty-parser.fbx', { type: 'application/octet-stream' }),
            ).then(
                () => 'resolved',
                (err) => err?.message || String(err),
            );

            const workerReplaceWorld = new THREE.Group();
            const workerReplaceLoadedModels = [];
            const workerReplaceEmbedded = [];
            const workerReplaceRoot = new THREE.Group();
            const workerReplaceGeometry = makeGeometry();
            workerReplaceGeometry.name = 'workerReplaceGeometry';
            const workerReplaceMaterial = new THREE.MeshBasicMaterial({ name: 'workerReplaceMaterial' });
            workerReplaceRoot.add(new THREE.Mesh(workerReplaceGeometry, workerReplaceMaterial));
            const workerReplaceMainUrl = URL.createObjectURL(new Blob(['png'], { type: 'image/png' }));
            let workerReplaceCreateCount = 0;
            URL.createObjectURL = (blob) => {
                workerReplaceCreateCount += 1;
                if (workerReplaceCreateCount === 1) return 'blob:worker-replaced-embedded';
                return nativeCreateObjectURL.call(URL, blob);
            };
            const workerReplaceHandleFBXFile = createFBXFileHandler({
                THREE,
                world: workerReplaceWorld,
                loadedModels: workerReplaceLoadedModels,
                allEmbedded: workerReplaceEmbedded,
                parseFBXInWorker: async () => ({
                    obj: null,
                    duration: 1,
                    embedded: [
                        { short: 'worker.png', full: 'textures/worker.png', mime: 'image/png', buffer: new ArrayBuffer(4) },
                    ],
                }),
                parseFBXOnMainThread: () => ({ obj: workerReplaceRoot, duration: 2 }),
                extractImagesFromFBX: async () => [{
                    short: 'main.png',
                    full: 'textures/main.png',
                    url: workerReplaceMainUrl,
                    mime: 'image/png',
                    source: 'embedded',
                }],
                isWorkerSupported: () => true,
            });
            const workerReplaceResult = await workerReplaceHandleFBXFile(
                new File([new Uint8Array([29, 30, 31])], 'worker-replace.fbx', { type: 'application/octet-stream' }),
            ).then(
                () => 'resolved',
                (err) => err?.message || String(err),
            );
            URL.createObjectURL = nativeCreateObjectURL;

            const normalizeWorld = new THREE.Group();
            const normalizeLoadedModels = [];
            const normalizeEmbedded = [];
            const normalizeRoot = new THREE.Group();
            const normalizeGeometry = makeGeometry();
            normalizeGeometry.name = 'normalizeGeometry';
            const normalizeMaterial = new THREE.MeshBasicMaterial({ name: 'normalizeMaterial' });
            normalizeRoot.add(new THREE.Mesh(normalizeGeometry, normalizeMaterial));
            const normalizeUrl = URL.createObjectURL(new Blob(['png'], { type: 'image/png' }));
            const normalizeHandleFBXFile = createFBXFileHandler({
                THREE,
                world: normalizeWorld,
                loadedModels: normalizeLoadedModels,
                allEmbedded: normalizeEmbedded,
                parseFBXOnMainThread: () => ({ obj: normalizeRoot, duration: 1 }),
                extractImagesFromFBX: async () => [{
                    short: 'normalize.png',
                    full: 'normalize.png',
                    url: normalizeUrl,
                    mime: 'image/png',
                    source: 'embedded',
                }],
                normalizeObjectOrientation: () => {
                    throw new Error('normalize failure');
                },
            });
            const normalizeResult = await normalizeHandleFBXFile(
                new File([new Uint8Array([7, 8, 9])], 'normalize.fbx', { type: 'application/octet-stream' }),
            ).then(
                () => 'resolved',
                (err) => err?.message || String(err),
            );

            const rollbackWorld = new THREE.Group();
            const rollbackLoadedModels = [];
            const rollbackEmbedded = [];
            const rollbackRoot = new THREE.Group();
            const rollbackGeometry = makeGeometry();
            rollbackGeometry.name = 'rollbackGeometry';
            const rollbackMaterial = new THREE.MeshBasicMaterial({ name: 'rollbackMaterial' });
            rollbackRoot.add(new THREE.Mesh(rollbackGeometry, rollbackMaterial));
            const rollbackUrl = URL.createObjectURL(new Blob(['png'], { type: 'image/png' }));
            const rollbackHandleFBXFile = createFBXFileHandler({
                THREE,
                world: rollbackWorld,
                loadedModels: rollbackLoadedModels,
                allEmbedded: rollbackEmbedded,
                parseFBXOnMainThread: () => ({ obj: rollbackRoot, duration: 1 }),
                extractImagesFromFBX: async () => [{
                    short: 'rollback.png',
                    full: 'rollback.png',
                    url: rollbackUrl,
                    mime: 'image/png',
                    source: 'embedded',
                }],
                renameMaterialsByFBXObject: () => {
                    throw new Error('post-add failure');
                },
            });
            const rollbackResult = await rollbackHandleFBXFile(
                new File([new Uint8Array([4, 5, 6])], 'rollback.fbx', { type: 'application/octet-stream' }),
            ).then(
                () => 'resolved',
                (err) => err?.message || String(err),
            );

            const envRollbackWorld = new THREE.Group();
            const envRollbackLoadedModels = [];
            const envRollbackRoot = new THREE.Group();
            const envRollbackGeometry = makeGeometry();
            envRollbackGeometry.name = 'envRollbackGeometry';
            const envRollbackMaterial = new THREE.MeshBasicMaterial({ name: 'envRollbackMaterial' });
            const envRollbackMesh = new THREE.Mesh(envRollbackGeometry, envRollbackMaterial);
            envRollbackRoot.add(envRollbackMesh);
            const sharedEnvMap = new THREE.Texture();
            sharedEnvMap.name = 'sharedEnvMap';
            const ownedAutoTexture = new THREE.Texture();
            ownedAutoTexture.name = 'ownedAutoTexture';
            const ownedUniformTexture = new THREE.Texture();
            ownedUniformTexture.name = 'ownedUniformTexture';
            const ownedUniformArrayTexture = new THREE.Texture();
            ownedUniformArrayTexture.name = 'ownedUniformArrayTexture';
            let sharedEnvDisposed = 0;
            let ownedAutoTextureDisposed = 0;
            let ownedUniformTextureDisposed = 0;
            let ownedUniformArrayTextureDisposed = 0;
            sharedEnvMap.addEventListener('dispose', () => {
                sharedEnvDisposed += 1;
            });
            ownedAutoTexture.addEventListener('dispose', () => {
                ownedAutoTextureDisposed += 1;
            });
            ownedUniformTexture.addEventListener('dispose', () => {
                ownedUniformTextureDisposed += 1;
            });
            ownedUniformArrayTexture.addEventListener('dispose', () => {
                ownedUniformArrayTextureDisposed += 1;
            });
            const envRollbackHandleFBXFile = createFBXFileHandler({
                THREE,
                world: envRollbackWorld,
                loadedModels: envRollbackLoadedModels,
                parseFBXOnMainThread: () => ({ obj: envRollbackRoot, duration: 1 }),
                autoBindByNamesForModel: (obj) => {
                    const mesh = obj.children[0];
                    mesh.material.map = ownedAutoTexture;
                    mesh.material.envMap = sharedEnvMap;
                    mesh.material.uniforms = {
                        smokeMap: { value: ownedUniformTexture },
                        smokeArray: { value: [ownedUniformArrayTexture] },
                    };
                },
                setImportedLightsEnabled: () => {
                    throw new Error('post-autobind failure');
                },
            });
            const envRollbackResult = await envRollbackHandleFBXFile(
                new File([new Uint8Array([5, 6, 7])], 'env-rollback.fbx', { type: 'application/octet-stream' }),
            ).then(
                () => 'resolved',
                (err) => err?.message || String(err),
            );

            const debugSentinel = { sentinel: true };
            globalThis.__lastFBXLoaded = debugSentinel;
            const debugWorld = new THREE.Group();
            const debugLoadedModels = [];
            const debugRoot = new THREE.Group();
            const debugGeometry = makeGeometry();
            debugGeometry.name = 'debugGeometry';
            const debugMaterial = new THREE.MeshBasicMaterial({ name: 'debugMaterial' });
            debugRoot.add(new THREE.Mesh(debugGeometry, debugMaterial));
            const debugHandleFBXFile = createFBXFileHandler({
                THREE,
                world: debugWorld,
                loadedModels: debugLoadedModels,
                parseFBXOnMainThread: () => ({ obj: debugRoot, duration: 1 }),
            });
            const debugDefaultResult = await debugHandleFBXFile(
                new File([new Uint8Array([10, 11, 12])], 'debug.fbx', { type: 'application/octet-stream' }),
            ).then(
                () => 'resolved',
                (err) => err?.message || String(err),
            );
            const debugGlobalUnchanged = globalThis.__lastFBXLoaded === debugSentinel;

            const debugFailureWorld = new THREE.Group();
            const debugFailureRoot = new THREE.Group();
            const debugFailureGeometry = makeGeometry();
            debugFailureGeometry.name = 'debugFailureGeometry';
            const debugFailureMaterial = new THREE.MeshBasicMaterial({ name: 'debugFailureMaterial' });
            debugFailureRoot.add(new THREE.Mesh(debugFailureGeometry, debugFailureMaterial));
            const debugFailureHandleFBXFile = createFBXFileHandler({
                THREE,
                world: debugFailureWorld,
                loadedModels: [],
                enableDebugGlobals: true,
                parseFBXOnMainThread: () => ({ obj: debugFailureRoot, duration: 1 }),
                normalizeObjectOrientation: () => {
                    throw new Error('debug cleanup failure');
                },
            });
            const debugFailureResult = await debugFailureHandleFBXFile(
                new File([new Uint8Array([13, 14, 15])], 'debug-failure.fbx', { type: 'application/octet-stream' }),
            ).then(
                () => 'resolved',
                (err) => err?.message || String(err),
            );
            const debugFailureGlobalCleared = globalThis.__lastFBXLoaded == null;

            return {
                singleResult,
                singleDisposed,
                singleStillInParent: singleParent.children[0] === singleMesh,
                splitResult,
                splitDisposed,
                holderIsUDIM: !!holder?.userData?.udimHolder,
                holderMaterialTracked: holder?.userData?._removedMaterials === sourceMaterial,
                holderDepthTracked: holder?.userData?._removedCustomDepthMaterial === customDepth,
                holderDistanceTracked: holder?.userData?._removedCustomDistanceMaterial === customDistance,
                childTileCount: holder?.children?.length || 0,
                oldMeshDetached: splitMesh.parent == null,
                oldMeshCleared: splitMesh.geometry == null && splitMesh.material == null,
                failingSplitResult,
                failingSplitOriginalKept: failingParent.children[0] === failingMesh
                    && failingMesh.geometry === failingSourceGeometry
                    && failingMesh.material === failingSourceMaterial,
                failingSplitSourceGeometryDisposed: failingSourceGeometryDisposed > 0,
                failingSplitSourceMaterialDisposed: disposedMaterials.includes('failingSourceMaterial'),
                failingSplitCloneDisposed: failingCloneMaterialDisposed > 0,
                failingSplitDisposedGeometries,
                failingSplitDisposedMaterials,
                abortResult,
                abortWorldChildren: abortWorld.children.length,
                abortLoadedCount: abortLoadedModels.length,
                abortGeometryDisposed: disposedGeometries.includes('abortGeometry'),
                abortMaterialDisposed: disposedMaterials.includes('abortMaterial'),
                skeletonDisposed,
                workerEmbeddedResult,
                workerEmbeddedWorldChildren: workerEmbeddedWorld.children.length,
                workerEmbeddedLoadedCount: workerEmbeddedLoadedModels.length,
                workerEmbeddedUrlRevoked: revokedUrls.includes('blob:worker-embedded-1'),
                workerEmbeddedGeometryDisposed: disposedGeometries.includes('workerEmbeddedGeometry'),
                workerEmbeddedMaterialDisposed: disposedMaterials.includes('workerEmbeddedMaterial'),
                workerEmbeddedFallbackGeometryDisposed: disposedGeometries.includes('workerEmbeddedFallbackGeometry'),
                workerEmbeddedSetSupported,
                workerEmbeddedDisableCalls,
                extractRollbackResult,
                extractRollbackUrlRevoked: revokedUrls.includes('blob:extract-embedded-1'),
                mainEmbeddedFailureResult,
                mainEmbeddedFailureWorldChildren: mainEmbeddedFailureWorld.children.length,
                mainEmbeddedFailureLoadedCount: mainEmbeddedFailureLoadedModels.length,
                mainEmbeddedFailureGeometryDisposed: disposedGeometries.includes('mainEmbeddedFailureGeometry'),
                mainEmbeddedFailureMaterialDisposed: disposedMaterials.includes('mainEmbeddedFailureMaterial'),
                emptyParserResult,
                emptyParserWorldChildren: emptyParserWorld.children.length,
                emptyParserLoadedCount: emptyParserLoadedModels.length,
                emptyParserEmbeddedCount: emptyParserEmbedded.length,
                emptyParserUrlRevoked: revokedUrls.includes(emptyParserUrl),
                workerReplaceResult,
                workerReplaceWorldChildren: workerReplaceWorld.children.length,
                workerReplaceLoadedCount: workerReplaceLoadedModels.length,
                workerReplaceEmbeddedCount: workerReplaceEmbedded.length,
                workerReplaceEmbeddedUrl: workerReplaceEmbedded[0]?.url || '',
                workerReplaceWorkerUrlRevoked: revokedUrls.includes('blob:worker-replaced-embedded'),
                workerReplaceMainUrlRevoked: revokedUrls.includes(workerReplaceMainUrl),
                normalizeResult,
                normalizeWorldChildren: normalizeWorld.children.length,
                normalizeLoadedCount: normalizeLoadedModels.length,
                normalizeEmbeddedCount: normalizeEmbedded.length,
                normalizeGeometryDisposed: disposedGeometries.includes('normalizeGeometry'),
                normalizeMaterialDisposed: disposedMaterials.includes('normalizeMaterial'),
                normalizeUrlRevoked: revokedUrls.includes(normalizeUrl),
                rollbackResult,
                rollbackWorldChildren: rollbackWorld.children.length,
                rollbackLoadedCount: rollbackLoadedModels.length,
                rollbackEmbeddedCount: rollbackEmbedded.length,
                rollbackGeometryDisposed: disposedGeometries.includes('rollbackGeometry'),
                rollbackMaterialDisposed: disposedMaterials.includes('rollbackMaterial'),
                rollbackUrlRevoked: revokedUrls.includes(rollbackUrl),
                envRollbackResult,
                envRollbackWorldChildren: envRollbackWorld.children.length,
                envRollbackLoadedCount: envRollbackLoadedModels.length,
                envRollbackGeometryDisposed: disposedGeometries.includes('envRollbackGeometry'),
                envRollbackMaterialDisposed: disposedMaterials.includes('envRollbackMaterial'),
                envRollbackOwnedTextureDisposed: ownedAutoTextureDisposed,
                envRollbackOwnedUniformTextureDisposed: ownedUniformTextureDisposed,
                envRollbackOwnedUniformArrayTextureDisposed: ownedUniformArrayTextureDisposed,
                envRollbackSharedEnvDisposed: sharedEnvDisposed,
                debugDefaultResult,
                debugGlobalUnchanged,
                debugFailureResult,
                debugFailureGlobalCleared,
                debugFailureGeometryDisposed: disposedGeometries.includes('debugFailureGeometry'),
                debugFailureMaterialDisposed: disposedMaterials.includes('debugFailureMaterial'),
            };
        } finally {
            THREE.BufferGeometry.prototype.dispose = nativeDispose;
            THREE.Material.prototype.dispose = nativeMaterialDispose;
            URL.createObjectURL = nativeCreateObjectURL;
            URL.revokeObjectURL = nativeRevokeObjectURL;
            const restoreDebugGlobal = (name, descriptor) => {
                if (descriptor) Object.defineProperty(globalThis, name, descriptor);
                else delete globalThis[name];
            };
            restoreDebugGlobal('__fbxLoader', debugGlobalDescriptors.loader);
            restoreDebugGlobal('__lastFBXLoaded', debugGlobalDescriptors.last);
            restoreDebugGlobal('__fbxParsedInWorker', debugGlobalDescriptors.parsed);
        }
    });

    assert.equal(result.singleResult, false, 'FBX cleanup smoke: single-UDIM mesh should not be split');
    assert.equal(result.singleDisposed, 1, 'FBX cleanup smoke: no-op UDIM temp geometry was not disposed');
    assert.equal(result.singleStillInParent, true, 'FBX cleanup smoke: no-op UDIM changed scene tree');
    assert.equal(result.splitResult, true, 'FBX cleanup smoke: multi-UDIM mesh was not split');
    assert.equal(result.splitDisposed, 2, 'FBX cleanup smoke: split source/temp geometries were not disposed');
    assert.equal(result.holderIsUDIM, true, 'FBX cleanup smoke: split holder missing');
    assert.equal(result.holderMaterialTracked, true, 'FBX cleanup smoke: removed source material is not tracked for later dispose');
    assert.equal(result.holderDepthTracked, true, 'FBX cleanup smoke: removed custom depth material is not tracked for later dispose');
    assert.equal(result.holderDistanceTracked, true, 'FBX cleanup smoke: removed custom distance material is not tracked for later dispose');
    assert.equal(result.childTileCount, 2, 'FBX cleanup smoke: expected two UDIM tile groups');
    assert.equal(result.oldMeshDetached, true, 'FBX cleanup smoke: original split mesh stayed attached');
    assert.equal(result.oldMeshCleared, true, 'FBX cleanup smoke: original split mesh retained disposed resources');
    assert.equal(result.failingSplitResult, 'clone failure', 'FBX cleanup smoke: UDIM split clone failure did not propagate');
    assert.equal(result.failingSplitOriginalKept, true, 'FBX cleanup smoke: failed UDIM split detached or mutated original mesh');
    assert.equal(result.failingSplitSourceGeometryDisposed, false, 'FBX cleanup smoke: failed UDIM split disposed live source geometry');
    assert.equal(result.failingSplitSourceMaterialDisposed, false, 'FBX cleanup smoke: failed UDIM split disposed live source material');
    assert.equal(result.failingSplitCloneDisposed, true, 'FBX cleanup smoke: failed UDIM split leaked cloned material');
    assert.equal(result.failingSplitDisposedGeometries, 3, 'FBX cleanup smoke: failed UDIM split leaked temp/generated geometry');
    assert.equal(result.failingSplitDisposedMaterials, 1, 'FBX cleanup smoke: failed UDIM split disposed wrong number of materials');
    assert.equal(result.abortResult, 'AbortError', 'FBX cleanup smoke: aborted post-parse FBX did not reject with AbortError');
    assert.equal(result.abortWorldChildren, 0, 'FBX cleanup smoke: aborted post-parse FBX was added to world');
    assert.equal(result.abortLoadedCount, 0, 'FBX cleanup smoke: aborted post-parse FBX was registered as loaded');
    assert.equal(result.abortGeometryDisposed, true, 'FBX cleanup smoke: aborted post-parse geometry was not disposed');
    assert.equal(result.abortMaterialDisposed, true, 'FBX cleanup smoke: aborted post-parse material was not disposed');
    assert.equal(result.skeletonDisposed, 1, 'FBX cleanup smoke: aborted post-parse skeleton was not disposed exactly once');
    assert.equal(result.workerEmbeddedResult, 'resolved', 'FBX cleanup smoke: worker embedded URL failure did not fall back');
    assert.equal(result.workerEmbeddedWorldChildren, 1, 'FBX cleanup smoke: fallback object was not added after worker embedded URL failure');
    assert.equal(result.workerEmbeddedLoadedCount, 1, 'FBX cleanup smoke: fallback model was not registered after worker embedded URL failure');
    assert.equal(result.workerEmbeddedUrlRevoked, true, 'FBX cleanup smoke: worker embedded URL failure leaked a blob URL');
    assert.equal(result.workerEmbeddedGeometryDisposed, true, 'FBX cleanup smoke: worker embedded URL failure leaked parsed geometry');
    assert.equal(result.workerEmbeddedMaterialDisposed, true, 'FBX cleanup smoke: worker embedded URL failure leaked parsed material');
    assert.equal(result.workerEmbeddedFallbackGeometryDisposed, false, 'FBX cleanup smoke: fallback geometry was disposed after successful fallback');
    assert.deepEqual(result.workerEmbeddedSetSupported, [false], 'FBX cleanup smoke: worker embedded URL failure did not disable worker fallback');
    assert.equal(result.workerEmbeddedDisableCalls, 1, 'FBX cleanup smoke: worker embedded URL failure did not disable worker client');
    assert.equal(result.extractRollbackResult, 'extract url failed', 'FBX cleanup smoke: embedded extractor failure did not propagate');
    assert.equal(result.extractRollbackUrlRevoked, true, 'FBX cleanup smoke: embedded extractor failure leaked a blob URL');
    assert.equal(result.mainEmbeddedFailureResult, 'main embedded extraction failed', 'FBX cleanup smoke: main embedded extraction failure did not propagate');
    assert.equal(result.mainEmbeddedFailureWorldChildren, 0, 'FBX cleanup smoke: failed main embedded extraction was added to world');
    assert.equal(result.mainEmbeddedFailureLoadedCount, 0, 'FBX cleanup smoke: failed main embedded extraction was registered as loaded');
    assert.equal(result.mainEmbeddedFailureGeometryDisposed, true, 'FBX cleanup smoke: failed main embedded extraction leaked geometry');
    assert.equal(result.mainEmbeddedFailureMaterialDisposed, true, 'FBX cleanup smoke: failed main embedded extraction leaked material');
    assert.equal(result.emptyParserResult, 'FBX parser returned empty object for empty-parser.fbx', 'FBX cleanup smoke: empty parser result did not propagate');
    assert.equal(result.emptyParserWorldChildren, 0, 'FBX cleanup smoke: empty parser object changed world');
    assert.equal(result.emptyParserLoadedCount, 0, 'FBX cleanup smoke: empty parser object was registered as loaded');
    assert.equal(result.emptyParserEmbeddedCount, 0, 'FBX cleanup smoke: empty parser embedded entry leaked');
    assert.equal(result.emptyParserUrlRevoked, true, 'FBX cleanup smoke: empty parser embedded blob URL was not revoked');
    assert.equal(result.workerReplaceResult, 'resolved', 'FBX cleanup smoke: worker-empty fallback did not resolve');
    assert.equal(result.workerReplaceWorldChildren, 1, 'FBX cleanup smoke: worker-empty fallback object was not added');
    assert.equal(result.workerReplaceLoadedCount, 1, 'FBX cleanup smoke: worker-empty fallback model was not registered');
    assert.equal(result.workerReplaceEmbeddedCount, 1, 'FBX cleanup smoke: worker-empty fallback did not keep main embedded texture');
    assert.ok(result.workerReplaceEmbeddedUrl.includes('blob:'), 'FBX cleanup smoke: worker-empty fallback embedded texture missing blob URL');
    assert.equal(result.workerReplaceWorkerUrlRevoked, true, 'FBX cleanup smoke: replaced worker embedded blob URL leaked');
    assert.equal(result.workerReplaceMainUrlRevoked, false, 'FBX cleanup smoke: current main embedded blob URL was revoked');
    assert.equal(result.normalizeResult, 'normalize failure', 'FBX cleanup smoke: normalize failure did not propagate');
    assert.equal(result.normalizeWorldChildren, 0, 'FBX cleanup smoke: failed normalize FBX was added to world');
    assert.equal(result.normalizeLoadedCount, 0, 'FBX cleanup smoke: failed normalize FBX was registered as loaded');
    assert.equal(result.normalizeEmbeddedCount, 0, 'FBX cleanup smoke: failed normalize embedded entries leaked');
    assert.equal(result.normalizeGeometryDisposed, true, 'FBX cleanup smoke: failed normalize geometry was not disposed');
    assert.equal(result.normalizeMaterialDisposed, true, 'FBX cleanup smoke: failed normalize material was not disposed');
    assert.equal(result.normalizeUrlRevoked, true, 'FBX cleanup smoke: failed normalize embedded blob URL was not revoked');
    assert.equal(result.rollbackResult, 'post-add failure', 'FBX cleanup smoke: post-add failure did not propagate');
    assert.equal(result.rollbackWorldChildren, 0, 'FBX cleanup smoke: failed post-add FBX stayed in world');
    assert.equal(result.rollbackLoadedCount, 0, 'FBX cleanup smoke: failed post-add FBX stayed in loaded models');
    assert.equal(result.rollbackEmbeddedCount, 0, 'FBX cleanup smoke: failed post-add embedded entries leaked');
    assert.equal(result.rollbackGeometryDisposed, true, 'FBX cleanup smoke: failed post-add geometry was not disposed');
    assert.equal(result.rollbackMaterialDisposed, true, 'FBX cleanup smoke: failed post-add material was not disposed');
    assert.equal(result.rollbackUrlRevoked, true, 'FBX cleanup smoke: failed post-add embedded blob URL was not revoked');
    assert.equal(result.envRollbackResult, 'post-autobind failure', 'FBX cleanup smoke: post-autobind failure did not propagate');
    assert.equal(result.envRollbackWorldChildren, 0, 'FBX cleanup smoke: failed post-autobind FBX stayed in world');
    assert.equal(result.envRollbackLoadedCount, 0, 'FBX cleanup smoke: failed post-autobind FBX stayed in loaded models');
    assert.equal(result.envRollbackGeometryDisposed, true, 'FBX cleanup smoke: failed post-autobind geometry was not disposed');
    assert.equal(result.envRollbackMaterialDisposed, true, 'FBX cleanup smoke: failed post-autobind material was not disposed');
    assert.equal(result.envRollbackOwnedTextureDisposed, 1, 'FBX cleanup smoke: failed post-autobind owned texture was not disposed');
    assert.equal(result.envRollbackOwnedUniformTextureDisposed, 1, 'FBX cleanup smoke: failed post-autobind uniform texture was not disposed');
    assert.equal(result.envRollbackOwnedUniformArrayTextureDisposed, 1, 'FBX cleanup smoke: failed post-autobind uniform texture array was not disposed');
    assert.equal(result.envRollbackSharedEnvDisposed, 0, 'FBX cleanup smoke: failed post-autobind disposed shared envMap');
    assert.equal(result.debugDefaultResult, 'resolved', 'FBX cleanup smoke: debug-global default import failed');
    assert.equal(result.debugGlobalUnchanged, true, 'FBX cleanup smoke: production import retained Object3D in debug global');
    assert.equal(result.debugFailureResult, 'debug cleanup failure', 'FBX cleanup smoke: debug-global failure did not propagate');
    assert.equal(result.debugFailureGlobalCleared, true, 'FBX cleanup smoke: failed debug import retained Object3D in global');
    assert.equal(result.debugFailureGeometryDisposed, true, 'FBX cleanup smoke: failed debug import geometry was not disposed');
    assert.equal(result.debugFailureMaterialDisposed, true, 'FBX cleanup smoke: failed debug import material was not disposed');
    diagnostics.assertNoErrors('FBX cleanup lifecycle smoke');
    await page.close();
}

async function runGLTFExportCleanupSmoke(browser, baseUrl) {
    const page = await browser.newPage();
    const diagnostics = attachPageDiagnostics(page);
    await page.goto(`${baseUrl}/__smoke_blank`, { waitUntil: 'domcontentloaded', timeout: 15000 });

    const result = await page.evaluate(async () => {
        const THREE = await import('three');
        const { exportWorldAsGLTF } = await import('/scripts/modules/io/gltf-export.js');
        const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');

        const disposedMaterials = [];
        const nativeMaterialDispose = THREE.Material.prototype.dispose;
        THREE.Material.prototype.dispose = function patchedMaterialDispose(...args) {
            disposedMaterials.push({
                name: this.name || '',
                isOriginal: !!this.userData?.smokeOriginalMaterial,
            });
            return nativeMaterialDispose.apply(this, args);
        };

        const world = new THREE.Group();
        const geometry = new THREE.BoxGeometry(1, 1, 1);
        const material = new THREE.MeshStandardMaterial({ name: 'export-material' });
        material.userData.smokeOriginalMaterial = true;
        material.userData.viewerTransient = { shouldNotExport: true };
        const mesh = new THREE.Mesh(geometry, material);
        mesh.name = 'export-source-mesh';
        world.add(mesh);

        const displayOriginal = new THREE.MeshStandardMaterial({ name: 'export-display-original' });
        displayOriginal.userData.smokeOriginalMaterial = true;
        const displayGenerated = new THREE.MeshBasicMaterial({ name: 'export-display-generated' });
        displayGenerated.userData.viewerGeneratedMaterial = 'shading-variant';
        const displayMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), displayGenerated);
        displayMesh.name = 'export-display-mesh';
        displayMesh.userData._origMaterial = displayOriginal;
        world.add(displayMesh);

        const nativeParse = GLTFExporter.prototype.parse;

        try {
            const exportDisplayMaterialNames = [];
            GLTFExporter.prototype.parse = function patchedDisplayParse(rootArg, onDone, onError, options) {
                rootArg?.traverse?.((obj) => {
                    if (obj?.name !== 'export-display-mesh') return;
                    const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
                    materials.filter(Boolean).forEach((mat) => {
                        exportDisplayMaterialNames.push(mat.name || '');
                    });
                });
                return nativeParse.call(this, rootArg, onDone, onError, options);
            };
            const exportResult = await exportWorldAsGLTF({
                world,
                format: 'glb',
                coords: 'rebased',
                returnBlob: true,
            });
            GLTFExporter.prototype.parse = nativeParse;

            let lateAbortResult = 'not-run';
            let lateAbortDownloadCount = 0;
            const lateAbortController = new AbortController();
            const fakeDocument = {
                body: {
                    appendChild() {},
                },
                createElement() {
                    return {
                        style: {},
                        click() {
                            lateAbortDownloadCount += 1;
                        },
                        remove() {},
                    };
                },
            };
            GLTFExporter.prototype.parse = function patchedParse(rootArg, onDone, onError, options) {
                return nativeParse.call(
                    this,
                    rootArg,
                    (value) => {
                        lateAbortController.abort();
                        onDone(value);
                    },
                    onError,
                    options,
                );
            };
            try {
                await exportWorldAsGLTF({
                    world,
                    format: 'glb',
                    coords: 'rebased',
                    document: fakeDocument,
                    signal: lateAbortController.signal,
                });
                lateAbortResult = 'resolved';
            } catch (err) {
                lateAbortResult = err?.name || String(err);
            } finally {
                GLTFExporter.prototype.parse = nativeParse;
            }

            return {
                disposedMaterials,
                materialStillAttached: mesh.material === material,
                originalUserDataPreserved: material.userData.viewerTransient?.shouldNotExport === true,
                blobType: exportResult?.blob?.type || '',
                format: exportResult?.format || '',
                exportDisplayMaterialNames,
                lateAbortResult,
                lateAbortDownloadCount,
            };
        } finally {
            THREE.Material.prototype.dispose = nativeMaterialDispose;
            GLTFExporter.prototype.parse = nativeParse;
            geometry.dispose();
            material.dispose();
            displayMesh.geometry.dispose();
            displayOriginal.dispose();
            displayGenerated.dispose();
        }
    });

    assert.equal(result.format, 'glb', 'GLTF export cleanup smoke: export did not return GLB metadata');
    assert.equal(result.blobType, 'model/gltf-binary', 'GLTF export cleanup smoke: export did not produce a GLB blob');
    assert.equal(result.materialStillAttached, true, 'GLTF export cleanup smoke: export detached original material');
    assert.equal(result.originalUserDataPreserved, true, 'GLTF export cleanup smoke: export mutated original material userData');
    assert.deepEqual(
        result.exportDisplayMaterialNames,
        ['export-display-original'],
        'GLTF export cleanup smoke: display-mode export used generated material instead of original material',
    );
    assert.equal(
        result.disposedMaterials.some((entry) => entry.name === 'export-material' && !entry.isOriginal),
        true,
        'GLTF export cleanup smoke: prepared clone material was not disposed',
    );
    assert.equal(
        result.disposedMaterials.some((entry) => entry.isOriginal),
        false,
        'GLTF export cleanup smoke: export disposed the original scene material',
    );
    assert.equal(result.lateAbortResult, 'AbortError', 'GLTF export cleanup smoke: stale export did not abort');
    assert.equal(result.lateAbortDownloadCount, 0, 'GLTF export cleanup smoke: stale export still triggered download');
    diagnostics.assertNoErrors('GLTF export cleanup smoke');
    await page.close();
}

async function runVPMAutobindLifecycleSmoke(browser, baseUrl) {
    const page = await browser.newPage();
    const diagnostics = attachPageDiagnostics(page);
    await page.goto(`${baseUrl}/__smoke_blank`, { waitUntil: 'domcontentloaded', timeout: 15000 });

    const result = await page.evaluate(async () => {
        const { createVPMBinder } = await import('/scripts/modules/material/vpm-autobind.js');

        const disposed = [];
        const labels = new Map();
        let bitmapClosed = 0;
        let releaseBitmap = null;
        const nativeCreateImageBitmap = globalThis.createImageBitmap;
        const nativeClose = globalThis.ImageBitmap?.prototype?.close || null;

        if (nativeClose) {
            globalThis.ImageBitmap.prototype.close = function patchedClose(...args) {
                bitmapClosed += 1;
                return nativeClose.apply(this, args);
            };
        }
        globalThis.createImageBitmap = async (...args) => {
            await new Promise((resolve) => {
                releaseBitmap = resolve;
            });
            return nativeCreateImageBitmap(...args);
        };

        class FakeTexture {
            constructor(label = '') {
                this.label = label;
                this.name = label;
                this.isTexture = true;
                this.userData = {};
            }
            dispose() {
                disposed.push(`texture:${this.label || this.name || 'unnamed'}`);
            }
        }

        class FakeMaterial {
            constructor(name = 'mat') {
                this.name = name;
                this.userData = {};
                this.alphaTest = 0;
                this.transparent = false;
            }
            clone() {
                const clone = new FakeMaterial(`${this.name}:clone`);
                clone.map = this.map || null;
                clone.normalMap = this.normalMap || null;
                clone.alphaMap = this.alphaMap || null;
                clone.envMap = this.envMap || null;
                return clone;
            }
            dispose() {
                disposed.push(`material:${this.name}`);
            }
        }

	        class FakeShadowMaterial {
	            constructor(params = {}) {
	                Object.assign(this, params);
	                this.disposed = false;
	            }
	            dispose() {
	                this.disposed = true;
	                disposed.push('shadow');
	            }
	        }

        const THREE = {
            CanvasTexture: class FakeCanvasTexture extends FakeTexture {
                constructor() {
                    super('canvas');
                }
            },
            MeshDepthMaterial: FakeShadowMaterial,
            MeshDistanceMaterial: FakeShadowMaterial,
            LinearSRGBColorSpace: 'linear',
            SRGBColorSpace: 'srgb',
            FrontSide: 0,
            RGBADepthPacking: 1,
            Vector2: class FakeVector2 {
                constructor(x, y) {
                    this.x = x;
                    this.y = y;
                }
            },
            Color: class FakeColor {
                constructor(r, g, b) {
                    this.r = r;
                    this.g = g;
                    this.b = b;
                }
            },
        };

        const canvas = document.createElement('canvas');
        canvas.width = 1;
        canvas.height = 1;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = 'rgb(128, 64, 32)';
        ctx.fillRect(0, 0, 1, 1);
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
	        const urls = [URL.createObjectURL(blob), URL.createObjectURL(blob), URL.createObjectURL(blob)];
	        const raceUrls = [];
	        labels.set(urls[0], 'T_foo_bar_Diffuse_1.1001.png');
	        labels.set(urls[1], 'T_foo_bar_Normal_1.1001.png');
	        labels.set(urls[2], 'T_foo_bar_ERM_1.1001.png');

        const baseMaterial = new FakeMaterial('base');
        const mesh = {
            isMesh: true,
            name: 'Mesh',
            userData: {},
            geometry: { getAttribute: () => null },
            material: baseMaterial,
        };
        const root = {
            userData: { _fbxFileName: 'SM_foo_bar.fbx' },
            traverse: (callback) => callback(mesh),
        };
        const loadedModels = [{ obj: root, name: 'SM_foo_bar.fbx', zipKind: 'SM' }];
        const binder = createVPMBinder({
            THREE,
            loadedModels,
            labelFromURL: (url) => labels.get(url) || '',
            toStandard: (material) => material,
            textureLoader: { load: (url) => new FakeTexture(labels.get(url) || url) },
            detectSlotFromMatOrObj: () => 1,
            requestRender: () => disposed.push('requestRender'),
            schedulePanelRefresh: () => disposed.push('panelRefresh'),
            materialsPanel: { markNeedsFullRefresh: () => disposed.push('materialsRefresh') },
        });

        try {
            const vpmIndex = binder.buildVPMIndex([
                { url: urls[0] },
                { url: urls[1] },
                { url: urls[2] },
            ]);
            const bindPromise = binder.autoBindVPMForModel(root, vpmIndex);

            for (let i = 0; i < 50 && !releaseBitmap; i += 1) {
                await new Promise((resolve) => setTimeout(resolve, 0));
            }
            if (!releaseBitmap) throw new Error('VPM smoke: createImageBitmap was not reached');

	            loadedModels.length = 0;
	            releaseBitmap();
	            await bindPromise;
	            const firstResult = {
	                materialStillOriginal: mesh.material === baseMaterial,
	                customDepthCleared: mesh.customDepthMaterial == null,
	                customDistanceCleared: mesh.customDistanceMaterial == null,
	                disposed: disposed.slice(),
	                bitmapClosed,
	            };

	            disposed.length = 0;
	            releaseBitmap = null;

	            raceUrls.push(
	                URL.createObjectURL(blob),
	                URL.createObjectURL(blob),
	                URL.createObjectURL(blob),
	            );
	            labels.set(raceUrls[0], 'T_race_case_Diffuse_1.1001.png');
	            labels.set(raceUrls[1], 'T_race_case_ERM_1.1001.png');
	            labels.set(raceUrls[2], 'T_race_case_Diffuse_1.1001.png');
	            const raceBaseMaterial = new FakeMaterial('race-base');
	            raceBaseMaterial.normalMap = new FakeTexture('race-shared-normal');
	            raceBaseMaterial.envMap = new FakeTexture('race-shared-env');
	            const raceMesh = {
	                isMesh: true,
	                name: 'RaceMesh',
	                userData: {},
	                geometry: { getAttribute: () => null },
	                material: raceBaseMaterial,
	            };
	            const raceRoot = {
	                userData: { _fbxFileName: 'SM_race_case.fbx' },
	                traverse: (callback) => callback(raceMesh),
	            };
	            loadedModels.push({ obj: raceRoot, name: 'SM_race_case.fbx', zipKind: 'SM' });
	            const staleIndex = binder.buildVPMIndex([
	                { url: raceUrls[0] },
	                { url: raceUrls[1] },
	            ]);
	            const currentIndex = binder.buildVPMIndex([
	                { url: raceUrls[2] },
	            ]);
	            const stalePromise = binder.autoBindVPMForModel(raceRoot, staleIndex);
	            for (let i = 0; i < 50 && !releaseBitmap; i += 1) {
	                await new Promise((resolve) => setTimeout(resolve, 0));
	            }
	            if (!releaseBitmap) throw new Error('VPM smoke: race createImageBitmap was not reached');
	            await binder.autoBindVPMForModel(raceRoot, currentIndex);
	            const raceCurrentMaterial = raceMesh.material;
	            const raceCurrentDepth = raceMesh.customDepthMaterial;
	            const raceRenderCountAfterCurrent = disposed.filter((entry) => entry === 'requestRender').length;
	            releaseBitmap();
	            await stalePromise;

	            return {
	                ...firstResult,
	                raceMaterialPreserved: raceMesh.material === raceCurrentMaterial,
	                raceShadowPreserved: raceMesh.customDepthMaterial === raceCurrentDepth && !raceCurrentDepth?.disposed,
	                raceSharedNormalDisposed: disposed.includes('texture:race-shared-normal'),
	                raceSharedEnvDisposed: disposed.includes('texture:race-shared-env'),
	                raceRenderCountAfterCurrent,
	                raceRenderCountAfterStale: disposed.filter((entry) => entry === 'requestRender').length,
	            };
	        } finally {
	            globalThis.createImageBitmap = nativeCreateImageBitmap;
	            if (nativeClose) globalThis.ImageBitmap.prototype.close = nativeClose;
	            [...urls, ...raceUrls].forEach((url) => URL.revokeObjectURL(url));
	        }
	    });

    assert.equal(result.materialStillOriginal, true, 'VPM smoke: stale async bind replaced material after model removal');
    assert.equal(result.customDepthCleared, true, 'VPM smoke: stale async bind leaked custom depth material');
    assert.equal(result.customDistanceCleared, true, 'VPM smoke: stale async bind leaked custom distance material');
    assert.equal(result.bitmapClosed, 1, 'VPM smoke: ERM ImageBitmap was not closed');
    assert.ok(result.disposed.includes('texture:T_foo_bar_Diffuse_1.1001.png'), 'VPM smoke: stale diffuse texture was not disposed');
    assert.ok(result.disposed.includes('texture:T_foo_bar_Normal_1.1001.png'), 'VPM smoke: stale normal texture was not disposed');
    assert.equal(result.disposed.filter((entry) => entry === 'texture:canvas').length, 3, 'VPM smoke: stale ERM channel textures were not disposed');
	    assert.equal(result.disposed.filter((entry) => entry === 'shadow').length, 2, 'VPM smoke: stale custom shadow materials were not disposed');
	    assert.equal(result.disposed.includes('requestRender'), false, 'VPM smoke: stale async bind requested render after model removal');
	    assert.equal(result.raceMaterialPreserved, true, 'VPM smoke: stale async bind overwrote a newer material');
	    assert.equal(result.raceShadowPreserved, true, 'VPM smoke: stale async bind disposed or overwrote newer custom shadow material');
	    assert.equal(result.raceSharedNormalDisposed, false, 'VPM smoke: stale async bind disposed a shared source normal map');
	    assert.equal(result.raceSharedEnvDisposed, false, 'VPM smoke: stale async bind disposed a shared source env map');
	    assert.equal(result.raceRenderCountAfterStale, result.raceRenderCountAfterCurrent, 'VPM smoke: stale async bind requested render after a newer bind');
    diagnostics.assertNoErrors('VPM autobind lifecycle smoke');
    await page.close();
}

async function runEnvironmentLifecycleSmoke(browser, baseUrl) {
    const page = await browser.newPage();
    const diagnostics = attachPageDiagnostics(page);
    await page.goto(`${baseUrl}/__smoke_blank`, { waitUntil: 'domcontentloaded', timeout: 15000 });

    const result = await page.evaluate(async () => {
        const THREE = await import('three');
        const { createBackgroundController } = await import('/scripts/modules/render/background-controller.js');
        const { createEnvironmentManager, loadEnvironmentEquirectTexture } = await import('/scripts/modules/render/environment-manager.js');
        const { createGlassController } = await import('/scripts/modules/material/glass-controller.js');

        const data = new Float32Array([1, 1, 1, 1]);
        const sourceTex = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat, THREE.FloatType);
        sourceTex.mapping = THREE.EquirectangularReflectionMapping;
        sourceTex.needsUpdate = true;

        let sourceDisposed = 0;
        sourceTex.addEventListener('dispose', () => {
            sourceDisposed += 1;
        });

        let releaseLoad = null;
        let loadCount = 0;
        const loadStarted = new Promise((resolve) => {
            const resolveStarted = resolve;
            const loader = async () => {
                loadCount += 1;
                resolveStarted();
                await new Promise((loadResolve) => {
                    releaseLoad = loadResolve;
                });
                return sourceTex;
            };
            globalThis.__smokeLoadEnvironmentTexture = loader;
        });

        const scene = new THREE.Scene();
        const events = [];
        const manager = createEnvironmentManager({
            scene,
            useWebGPU: true,
            enabled: true,
            rendererInitPromise: Promise.resolve(),
            loadEquirectTexture: (...args) => globalThis.__smokeLoadEnvironmentTexture(...args),
            requestRender: () => events.push('render'),
            onEnvironmentUpdated: (event) => events.push(`updated:${event?.type || 'unknown'}`),
        });

        const rebuildPromise = manager.rebuild({ force: true });
        await loadStarted;
        manager.dispose();
        releaseLoad();
        await rebuildPromise;

        let releaseConcurrentLoad = null;
        let concurrentLoadCount = 0;
        let concurrentBaseDisposed = 0;
        const concurrentManager = createEnvironmentManager({
            loadEquirectTexture: async () => {
                concurrentLoadCount += 1;
                await new Promise((resolve) => {
                    releaseConcurrentLoad = resolve;
                });
                const tex = new THREE.DataTexture(new Float32Array([0.5, 0.5, 0.5, 1]), 1, 1, THREE.RGBAFormat, THREE.FloatType);
                tex.addEventListener('dispose', () => {
                    concurrentBaseDisposed += 1;
                });
                return tex;
            },
        });
        const concurrentBaseA = concurrentManager.loadHDRBase();
        const concurrentBaseB = concurrentManager.loadHDRBase();
        await Promise.resolve();
        releaseConcurrentLoad?.();
        const [baseA, baseB] = await Promise.all([concurrentBaseA, concurrentBaseB]);
        const concurrentBaseSame = baseA === baseB;
        concurrentManager.dispose();

        const webgpuToggleScene = new THREE.Scene();
        const webgpuToggleMaterial = new THREE.MeshStandardMaterial();
        const webgpuToggleMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), webgpuToggleMaterial);
        const webgpuToggleBase = new THREE.DataTexture(new Float32Array([0.75, 0.75, 0.75, 1]), 1, 1, THREE.RGBAFormat, THREE.FloatType);
        webgpuToggleBase.mapping = THREE.EquirectangularReflectionMapping;
        webgpuToggleBase.needsUpdate = true;
        const webgpuToggleManager = createEnvironmentManager({
            scene: webgpuToggleScene,
            loadedModels: [{ obj: webgpuToggleMesh }],
            enabled: true,
            useWebGPU: true,
            rendererInitPromise: Promise.resolve(),
            loadEquirectTexture: async () => webgpuToggleBase,
        });
        await webgpuToggleManager.rebuild({ force: true });
        const webgpuEnabledEnvMap = webgpuToggleMaterial.envMap;
        const webgpuEnabledSceneEnv = webgpuToggleScene.environment;
        await webgpuToggleManager.setEnabled(false);
        const webgpuToggleState = {
            enabledEnvWasTexture: webgpuEnabledEnvMap?.isTexture === true,
            materialEnvPreserved: webgpuToggleMaterial.envMap === webgpuEnabledEnvMap,
            materialIntensityDisabled: webgpuToggleMaterial.envMapIntensity === 0,
            sceneEnvPreserved: webgpuToggleScene.environment === webgpuEnabledSceneEnv,
            sceneIntensityDisabled: webgpuToggleScene.environmentIntensity === 0,
        };
        webgpuToggleManager.dispose();
        const webgpuMaterialEnvClearedOnDispose = webgpuToggleMaterial.envMap == null;
        webgpuToggleMesh.geometry.dispose();
        webgpuToggleMaterial.dispose();

        const webgpuGlassScene = new THREE.Scene();
        webgpuGlassScene.environment = new THREE.DataTexture(new Float32Array([0.9, 0.9, 0.9, 1]), 1, 1, THREE.RGBAFormat, THREE.FloatType);
        webgpuGlassScene.environment.mapping = THREE.EquirectangularReflectionMapping;
        webgpuGlassScene.environmentIntensity = 0;
        const webgpuGlassWorld = new THREE.Group();
        const webgpuGlassMaterial = new THREE.MeshPhysicalMaterial({ name: 'MainGlass' });
        webgpuGlassMaterial.envMapIntensity = 3;
        const webgpuGlassMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), webgpuGlassMaterial);
        webgpuGlassMesh.name = 'MainGlass';
        webgpuGlassWorld.add(webgpuGlassMesh);
        const webgpuGlassController = createGlassController({
            THREE,
            world: webgpuGlassWorld,
            scene: webgpuGlassScene,
            toStandard: (material) => material,
            isEnvironmentEnabled: () => false,
        });
        webgpuGlassController.applyToScene();
        const webgpuGlassDisabledState = {
            envMapPreserved: webgpuGlassMaterial.envMap === webgpuGlassScene.environment,
            envIntensityDisabled: webgpuGlassMaterial.envMapIntensity === 0,
            storedOriginalReflect: webgpuGlassMaterial.userData?.glassOriginal?.envIntensity === 3,
        };
        webgpuGlassController.dispose();
        webgpuGlassMesh.geometry.dispose();
        webgpuGlassMaterial.dispose();
        webgpuGlassScene.environment.dispose();

        const environmentUnhandled = [];
        const onEnvironmentUnhandled = (event) => {
            event.preventDefault();
            environmentUnhandled.push(String(event.reason?.message || event.reason || 'unknown'));
        };
        window.addEventListener('unhandledrejection', onEnvironmentUnhandled);

        let failingLoadCount = 0;
        const failingManager = createEnvironmentManager({
            enabled: true,
            useWebGPU: true,
            rendererInitPromise: Promise.resolve(),
            loadEquirectTexture: async (url) => {
                failingLoadCount += 1;
                throw new Error(`failed:${url}`);
            },
        });
        const failingRebuildResult = await failingManager.rebuild({ force: true });
        failingManager.requestRebuild({ immediate: true });
        await new Promise((resolve) => setTimeout(resolve, 20));
        const failingPresetResult = await failingManager.selectPresetIndex(0).then(
            (value) => value,
            (err) => `rejected:${err?.message || err}`,
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
        failingManager.dispose();
        window.removeEventListener('unhandledrejection', onEnvironmentUnhandled);

        const pmremFailureBase = new THREE.DataTexture(new Float32Array([0.25, 0.25, 0.25, 1]), 1, 1, THREE.RGBAFormat, THREE.FloatType);
        let pmremFailureCloneDisposed = 0;
        const nativeDataTextureDispose = THREE.DataTexture.prototype.dispose;
        THREE.DataTexture.prototype.dispose = function smokeDataTextureDispose(...args) {
            if (this !== pmremFailureBase && this?.image?.data?.[0] === 0.25) {
                pmremFailureCloneDisposed += 1;
            }
            return nativeDataTextureDispose.apply(this, args);
        };
        let pmremFailureResult = null;
        let pmremFailureManager = null;
        try {
            pmremFailureManager = createEnvironmentManager({
                enabled: true,
                renderer: {},
                useWebGPU: false,
                loadEquirectTexture: async () => pmremFailureBase,
                createPMREMGenerator: () => ({
                    fromEquirectangular() {
                        throw new Error('pmrem failed');
                    },
                    dispose() {},
                }),
            });
            pmremFailureResult = await pmremFailureManager.rebuild({ force: true });
        } finally {
            THREE.DataTexture.prototype.dispose = nativeDataTextureDispose;
            pmremFailureManager?.dispose?.();
        }

        const hdrSourceTex = new THREE.DataTexture(new Float32Array([0.2, 0.3, 0.4, 1]), 1, 1, THREE.RGBAFormat, THREE.FloatType);
        let hdrSourceDisposed = 0;
        hdrSourceTex.addEventListener('dispose', () => {
            hdrSourceDisposed += 1;
        });
        const hdrLoadedTex = await loadEnvironmentEquirectTexture('smoke.hdr', {
            HDRLoaderCtor: class SmokeHDRLoader {
                async loadAsync() {
                    return hdrSourceTex;
                }
            },
        });
        const hdrLoadedIsCopy = hdrLoadedTex !== hdrSourceTex;
        hdrLoadedTex.dispose();

        const bgScene = new THREE.Scene();
        const bgCamera = new THREE.PerspectiveCamera();
        const bgApp = {};
        const bgToggleBtn = document.createElement('button');
        const bgAlphaEl = document.createElement('input');
        bgAlphaEl.value = '0.5';
        document.body.append(bgToggleBtn, bgAlphaEl);
        const bgRendererCalls = [];
        const bgEvents = [];
        const background = createBackgroundController({
            THREE,
            scene: bgScene,
            camera: bgCamera,
            app: bgApp,
            renderer: {
                setClearColor: (...args) => bgRendererCalls.push(args),
            },
            requestRender: () => bgEvents.push('render'),
            isEnvironmentEnabled: () => true,
            getAlpha: () => bgAlphaEl.value,
            bgToggleBtn,
            bgAlphaEl,
            body: document.body,
        });
        const bgMesh = background.ensureBgMesh();
        let bgGeometryDisposed = 0;
        let bgMaterialDisposed = 0;
        bgMesh?.geometry?.addEventListener?.('dispose', () => {
            bgGeometryDisposed += 1;
        });
        bgMesh?.material?.addEventListener?.('dispose', () => {
            bgMaterialDisposed += 1;
        });
        background.updateVisibility();
        const bgEventsBeforeDispose = bgEvents.slice();
        const bgRendererCallsBeforeDispose = bgRendererCalls.length;
        const bgModeBeforeDispose = bgToggleBtn.dataset.mode || '';
        const bgSceneChildrenBeforeDispose = bgScene.children.length;
        background.dispose();
        background.dispose();
        const bgSceneChildrenAfterDispose = bgScene.children.length;
        const bgEventsAfterDispose = bgEvents.slice();
        bgAlphaEl.value = '0.1';
        bgAlphaEl.dispatchEvent(new Event('input', { bubbles: true }));
        bgToggleBtn.click();
        background.setMode('black');
        background.toggleMode();
        background.updateVisibility();
        background.syncToCamera();
        const bgLateEnsure = background.ensureBgMesh();

        delete globalThis.__smokeLoadEnvironmentTexture;
        return {
            sceneEnvironmentCleared: scene.environment == null,
            currentEnvCleared: manager.getCurrentEnv() == null,
            currentBgCleared: manager.getCurrentBg() == null,
            hdrBaseCleared: manager.getHDRBase() == null,
            disabled: manager.isEnabled() === false,
            loadCount,
            sourceDisposed,
            concurrentLoadCount,
            concurrentBaseSame,
            concurrentBaseDisposed,
            webgpuToggleState,
            webgpuMaterialEnvClearedOnDispose,
            webgpuGlassDisabledState,
            failingLoadCount,
            failingRebuildResult,
            failingPresetResult,
            failingEnv: failingManager.getCurrentEnv(),
            failingBg: failingManager.getCurrentBg(),
            environmentUnhandled,
            pmremFailureResult,
            pmremFailureCloneDisposed,
            hdrSourceDisposed,
            hdrLoadedIsCopy,
            events,
            bgMeshCreated: !!bgMesh,
            bgSceneChildrenBeforeDispose,
            bgSceneChildrenAfterDispose,
            bgGeometryDisposed,
            bgMaterialDisposed,
            bgAppCleared: bgApp.bgMesh == null,
            bgGetAfterDispose: background.getBgMesh() == null,
            bgLateEnsureNull: bgLateEnsure == null,
            bgEventsBeforeDispose,
            bgEventsAfterDispose,
            bgEventsAfterLateCalls: bgEvents.slice(),
            bgRendererCallsBeforeDispose,
            bgRendererCallsAfterLateCalls: bgRendererCalls.length,
            bgModeBeforeDispose,
            bgModeAfterLateCalls: bgToggleBtn.dataset.mode || '',
        };
    });

    assert.equal(result.loadCount, 1, 'Environment smoke: HDR loader was not exercised');
    assert.equal(result.sourceDisposed, 1, 'Environment smoke: late HDR texture was not disposed after manager dispose');
    assert.equal(result.concurrentLoadCount, 1, 'Environment smoke: concurrent HDR base requests started duplicate loads');
    assert.equal(result.concurrentBaseSame, true, 'Environment smoke: concurrent HDR base requests did not share the same texture');
    assert.equal(result.concurrentBaseDisposed, 1, 'Environment smoke: shared concurrent HDR base was not disposed exactly once');
    assert.deepEqual(result.webgpuToggleState, {
        enabledEnvWasTexture: true,
        materialEnvPreserved: true,
        materialIntensityDisabled: true,
        sceneEnvPreserved: true,
        sceneIntensityDisabled: true,
    }, 'Environment smoke: WebGPU HDRI disable cleared envMap texture instead of zeroing intensity');
    assert.equal(result.webgpuMaterialEnvClearedOnDispose, true, 'Environment smoke: disposed WebGPU manager retained material envMap');
    assert.deepEqual(result.webgpuGlassDisabledState, {
        envMapPreserved: true,
        envIntensityDisabled: true,
        storedOriginalReflect: true,
    }, 'Environment smoke: WebGPU glass ignored disabled HDRI state');
    assert.equal(result.failingLoadCount, 5, 'Environment smoke: failed environment loads did not exercise default/fallback/preset paths');
    assert.equal(result.failingRebuildResult, true, 'Environment smoke: failed rebuild did not resolve cleanly');
    assert.equal(result.failingPresetResult, false, 'Environment smoke: failed HDRI preset rejected instead of resolving false');
    assert.equal(result.failingEnv, null, 'Environment smoke: failed load produced a current environment');
    assert.equal(result.failingBg, null, 'Environment smoke: failed load produced a current background');
    assert.deepEqual(result.environmentUnhandled, [], 'Environment smoke: failed environment load caused unhandled rejection');
    assert.equal(result.pmremFailureResult, false, 'Environment smoke: PMREM failure did not resolve cleanly');
    assert.equal(result.pmremFailureCloneDisposed, 1, 'Environment smoke: PMREM failure leaked cloned background texture');
    assert.equal(result.hdrSourceDisposed, 1, 'Environment smoke: source HDR texture was not disposed after vertical flip');
    assert.equal(result.hdrLoadedIsCopy, true, 'Environment smoke: HDR loader did not return flipped texture copy');
    assert.equal(result.sceneEnvironmentCleared, true, 'Environment smoke: disposed manager restored scene.environment');
    assert.equal(result.currentEnvCleared, true, 'Environment smoke: disposed manager retained currentEnv');
    assert.equal(result.currentBgCleared, true, 'Environment smoke: disposed manager retained currentBg');
    assert.equal(result.hdrBaseCleared, true, 'Environment smoke: disposed manager retained hdrBaseTex');
    assert.equal(result.disabled, true, 'Environment smoke: disposed manager stayed enabled');
    assert.deepEqual(result.events, [], 'Environment smoke: disposed manager fired render/update callbacks');
    assert.equal(result.bgMeshCreated, true, 'Environment smoke: background mesh was not created');
    assert.equal(result.bgSceneChildrenBeforeDispose, 1, 'Environment smoke: background mesh was not attached to scene');
    assert.equal(result.bgSceneChildrenAfterDispose, 0, 'Environment smoke: disposed background mesh stayed in scene');
    assert.equal(result.bgGeometryDisposed, 1, 'Environment smoke: background geometry was not disposed exactly once');
    assert.equal(result.bgMaterialDisposed, 1, 'Environment smoke: background material was not disposed exactly once');
    assert.equal(result.bgAppCleared, true, 'Environment smoke: disposed background controller left app.bgMesh');
    assert.equal(result.bgGetAfterDispose, true, 'Environment smoke: disposed background controller returned stale mesh');
    assert.equal(result.bgLateEnsureNull, true, 'Environment smoke: disposed background controller recreated mesh');
    assert.deepEqual(result.bgEventsAfterLateCalls, result.bgEventsAfterDispose, 'Environment smoke: disposed background controller requested render');
    assert.equal(result.bgRendererCallsAfterLateCalls, result.bgRendererCallsBeforeDispose, 'Environment smoke: disposed background controller touched renderer');
    assert.equal(result.bgModeAfterLateCalls, result.bgModeBeforeDispose, 'Environment smoke: disposed background controller mutated UI mode');
    diagnostics.assertNoErrors('Environment lifecycle smoke');
    await page.close();
}

async function runMosParcelsLifecycleSmoke(browser, baseUrl) {
    const page = await browser.newPage();
    const diagnostics = attachPageDiagnostics(page);
    await page.goto(`${baseUrl}/__smoke_blank`, { waitUntil: 'domcontentloaded', timeout: 15000 });

    const result = await page.evaluate(async () => {
        const THREE = await import('three');
        const { createMosParcelsController } = await import('/scripts/modules/scene/mos-parcels.js');

        const pending = [];
        const loadEvents = [];
        const statusEvents = [];
        const world = new THREE.Scene();
        const northGrid = {
            groups: [],
            setParcelsGroup: (group) => northGrid.groups.push(group ? `set:${group.children.length}` : 'clear'),
            alignParcelsGroupToNorth: () => northGrid.groups.push('align'),
        };

        function featureAt(x, y) {
            return {
                type: 'Feature',
                properties: {},
                geometry: {
                    type: 'Polygon',
                    coordinates: [[
                        [x, y],
                        [x + 10, y],
                        [x + 10, y + 10],
                        [x, y + 10],
                        [x, y],
                    ]],
                },
            };
        }

        const controller = createMosParcelsController({
            world,
            northGrid,
            config: { apiKey: 'smoke' },
            setStatusMessage: (message) => statusEvents.push(message),
            loadParcels: ({ signal, onProgress }) => {
                const id = pending.length + 1;
                loadEvents.push(`start:${id}`);
                signal?.addEventListener?.('abort', () => loadEvents.push(`abort:${id}`), { once: true });
                onProgress?.({ collectedCount: id, processedCount: id });
                return new Promise((resolve) => {
                    pending.push({ id, resolve });
                });
            },
        });

        const firstLoad = controller.loadMosParcels();
        await Promise.resolve();
        const secondLoad = controller.loadMosParcels();
        await Promise.resolve();
        pending[1].resolve({ features: [featureAt(2000, 2000)] });
        const secondResult = await secondLoad;
        const afterSecond = {
            worldChildren: world.children.length,
            originX: world.children[0]?.userData?.originMeters?.x || 0,
            resultMatchesWorld: secondResult === world.children[0],
        };
        pending[0].resolve({ features: [featureAt(1000, 1000)] });
        const firstResult = await firstLoad;
        const afterLateFirst = {
            worldChildren: world.children.length,
            originX: world.children[0]?.userData?.originMeters?.x || 0,
            firstResult,
        };

        const thirdLoad = controller.loadMosParcels();
        await Promise.resolve();
        controller.dispose();
        pending[2].resolve({ features: [featureAt(3000, 3000)] });
        const thirdResult = await thirdLoad;

        return {
            loadEvents,
            statusEvents,
            afterSecond,
            afterLateFirst,
            thirdResult,
            worldChildrenAfterDispose: world.children.length,
            northGridEvents: northGrid.groups,
        };
    });

    assert.deepEqual(result.loadEvents, ['start:1', 'abort:1', 'start:2', 'start:3', 'abort:3'], 'MOS parcels smoke: stale/dispose abort sequence is wrong');
    assert.equal(result.afterSecond.worldChildren, 1, 'MOS parcels smoke: current load did not add one parcels group');
    assert.equal(result.afterSecond.originX, 2000, 'MOS parcels smoke: current load origin is wrong');
    assert.equal(result.afterSecond.resultMatchesWorld, true, 'MOS parcels smoke: current load did not return the applied group');
    assert.equal(result.afterLateFirst.worldChildren, 1, 'MOS parcels smoke: stale load changed world children');
    assert.equal(result.afterLateFirst.originX, 2000, 'MOS parcels smoke: stale load replaced current parcels group');
    assert.equal(result.afterLateFirst.firstResult, null, 'MOS parcels smoke: stale load returned a group');
    assert.equal(result.thirdResult, null, 'MOS parcels smoke: disposed load returned a group');
    assert.equal(result.worldChildrenAfterDispose, 0, 'MOS parcels smoke: dispose left parcels group in world');
    assert.deepEqual(
        result.northGridEvents,
        ['set:1', 'align', 'clear'],
        'MOS parcels smoke: north grid was updated by stale/disposed loads',
    );
    diagnostics.assertNoErrors('MOS parcels lifecycle smoke');
    await page.close();
}

async function runMaterialsPanelRemovalSmoke(browser, baseUrl) {
    const page = await browser.newPage();
    const diagnostics = attachPageDiagnostics(page);
    await page.goto(`${baseUrl}/__smoke_blank`, { waitUntil: 'domcontentloaded', timeout: 15000 });

    const result = await page.evaluate(async () => {
        const THREE = await import('three');
        const { createMaterialsPanelController } = await import('/scripts/modules/ui/materials-panel.js');

        const world = new THREE.Group();
        const loadedModels = [];
        const outEl = document.createElement('div');
        const matSelect = document.createElement('select');
        document.body.append(outEl, matSelect);

        const panel = createMaterialsPanelController({
            world,
            loadedModels,
            outEl,
            matSelect,
            requestRender: () => {},
        });

        const flushPanel = async () => {
            panel.scheduleRefresh();
            await Promise.resolve();
            await Promise.resolve();
        };

        const createModel = (label) => {
            const root = new THREE.Group();
            root.name = `${label}-root`;
            const mesh = new THREE.Mesh(
                new THREE.BoxGeometry(1, 1, 1),
                new THREE.MeshStandardMaterial({ name: `${label}-material` })
            );
            mesh.name = `${label}-mesh`;
            root.add(mesh);
            world.add(root);
            const record = { obj: root, name: `${label}.fbx` };
            loadedModels.push(record);
            return record;
        };

        const first = createModel('first');
        await flushPanel();
        const firstPanelText = outEl.textContent || '';
        const firstOptions = matSelect.options.length;

        loadedModels.splice(0, loadedModels.length);
        world.remove(first.obj);
        panel.markNeedsFullRefresh();
        await flushPanel();
        const afterRemovalText = outEl.textContent || '';
        const afterRemovalOptions = matSelect.options.length;

        createModel('second');
        await flushPanel();
        const secondPanelText = outEl.textContent || '';
        const secondOptions = matSelect.options.length;

        createModel('late');
        let callbackCount = 0;
        panel.scheduleRefresh(() => {
            callbackCount += 1;
        });
        panel.dispose();
        await Promise.resolve();
        await Promise.resolve();
        panel.scheduleRefresh(() => {
            callbackCount += 1;
        });
        await Promise.resolve();
        const disposedText = outEl.textContent || '';
        const disposedOptions = matSelect.options.length;
        const disposedMap = matSelect.dataset._map || '';

        return {
            firstRendered: firstPanelText.includes('first.fbx') && firstPanelText.includes('first-material'),
            firstOptions,
            stalePanelCleared: !afterRemovalText.includes('first.fbx') && !afterRemovalText.includes('first-material'),
            afterRemovalOptions,
            secondRendered: secondPanelText.includes('second.fbx') && secondPanelText.includes('second-material'),
            oldModelStillAbsent: !secondPanelText.includes('first.fbx') && !secondPanelText.includes('first-material'),
            secondOptions,
            disposedPanelCleared: !disposedText.includes('second.fbx') && !disposedText.includes('late.fbx'),
            disposedOptions,
            disposedMap,
            callbackCount,
        };
    });

    assert.equal(result.firstRendered, true, 'Materials panel removal smoke: first model was not rendered');
    assert.equal(result.firstOptions, 2, 'Materials panel removal smoke: first material dropdown not populated');
    assert.equal(result.stalePanelCleared, true, 'Materials panel removal smoke: removed model stayed in panel DOM');
    assert.equal(result.afterRemovalOptions, 1, 'Materials panel removal smoke: removed model stayed in material dropdown');
    assert.equal(result.secondRendered, true, 'Materials panel removal smoke: second model was not rendered');
    assert.equal(result.oldModelStillAbsent, true, 'Materials panel removal smoke: stale model was mixed with new model');
    assert.equal(result.secondOptions, 2, 'Materials panel removal smoke: second material dropdown not populated');
    assert.equal(result.disposedPanelCleared, true, 'Materials panel removal smoke: dispose left stale panel DOM or rendered pending refresh');
    assert.equal(result.disposedOptions, 1, 'Materials panel removal smoke: dispose did not clear material dropdown');
    assert.equal(result.disposedMap, '', 'Materials panel removal smoke: dispose left stale material map');
    assert.equal(result.callbackCount, 0, 'Materials panel removal smoke: pending refresh callbacks fired after dispose');
    diagnostics.assertNoErrors('Materials panel removal smoke');
    await page.close();
}

async function runStatusUIDisposeSmoke(browser, baseUrl) {
    const page = await browser.newPage();
    const diagnostics = attachPageDiagnostics(page);
    await page.goto(`${baseUrl}/__smoke_blank`, { waitUntil: 'domcontentloaded', timeout: 15000 });

    const result = await page.evaluate(async () => {
        const { createStatusUIController } = await import('/scripts/modules/ui/status-ui.js');

        const statusEl = document.createElement('div');
        const appbarStatusEl = document.createElement('div');
        const emptyHintEl = document.createElement('div');
        document.body.append(statusEl, appbarStatusEl, emptyHintEl);

        const status = createStatusUIController({
            statusEl,
            appbarStatusEl,
            emptyHintEl,
            readyClearDelayMs: 5,
        });

        status.setStatusMessage('Загрузка модели из комнаты…');
        status.setStatusProgress({ visible: true, indeterminate: true });
        const progressVisibleBeforeDispose = !statusEl.querySelector('.status-progress-track')?.hidden;
        const progressIndeterminateBeforeDispose = statusEl.querySelector('.status-progress-track')?.classList?.contains('is-indeterminate') || false;
        const progressTextBeforeDispose = statusEl.textContent;

        status.setStatusMessage('готово: synced');
        status.setStatusProgress({ visible: true, value: 42, indeterminate: false });
        const determinateProgressWidth = statusEl.querySelector('.status-progress-bar')?.style?.width || '';
        status.setEmptyHintVisible(true);
        status.dispose();
        status.setStatusMessage('late status');
        status.setStatusProgress(true);
        status.setEmptyHintVisible(true);
        await new Promise((resolve) => setTimeout(resolve, 20));

        return {
            statusText: statusEl.textContent,
            statusHidden: statusEl.hidden,
            progressVisibleBeforeDispose,
            progressIndeterminateBeforeDispose,
            progressTextBeforeDispose,
            determinateProgressWidth,
            progressHiddenAfterDispose: statusEl.querySelector('.status-progress-track')?.hidden,
            progressClassAfterDispose: statusEl.classList.contains('has-progress'),
            appbarText: appbarStatusEl.textContent,
            emptyHidden: emptyHintEl.hidden,
            emptyOpacity: emptyHintEl.style.opacity,
        };
    });

    assert.equal(result.statusText, '', 'Status UI smoke: disposed status accepted a late message');
    assert.equal(result.statusHidden, true, 'Status UI smoke: disposed status was not hidden');
    assert.equal(result.progressVisibleBeforeDispose, true, 'Status UI smoke: progress was not shown');
    assert.equal(result.progressIndeterminateBeforeDispose, true, 'Status UI smoke: indeterminate progress class was not set');
    assert.equal(result.progressTextBeforeDispose, 'Загрузка модели из комнаты…', 'Status UI smoke: progress changed visible status text');
    assert.equal(result.determinateProgressWidth, '42%', 'Status UI smoke: determinate progress width was wrong');
    assert.equal(result.progressHiddenAfterDispose, true, 'Status UI smoke: dispose did not hide progress');
    assert.equal(result.progressClassAfterDispose, false, 'Status UI smoke: disposed status retained progress class');
    assert.equal(result.appbarText, '', 'Status UI smoke: disposed appbar status retained text');
    assert.equal(result.emptyHidden, true, 'Status UI smoke: disposed empty hint accepted a late update');
    assert.equal(result.emptyOpacity, '0', 'Status UI smoke: disposed empty hint opacity was not cleared');
    diagnostics.assertNoErrors('Status UI dispose smoke');
    await page.close();
}

async function runTransientStatusSmoke(browser, baseUrl) {
    const page = await browser.newPage();
    const diagnostics = attachPageDiagnostics(page);
    await page.goto(`${baseUrl}/__smoke_blank`, { waitUntil: 'domcontentloaded', timeout: 15000 });

    const result = await page.evaluate(async () => {
        const { createStatusUIController } = await import('/scripts/modules/ui/status-ui.js');
        const { createTransientStatusController } = await import('/scripts/modules/ui/transient-status.js');

        const statusEl = document.createElement('div');
        const appbarStatusEl = document.createElement('div');
        document.body.append(statusEl, appbarStatusEl);

        const status = createStatusUIController({
            statusEl,
            appbarStatusEl,
            readyClearDelayMs: 1000,
        });
        const transient = createTransientStatusController({
            setStatusMessage: status.setStatusMessage,
            getStatusMessage: () => statusEl.textContent,
        });

        const first = transient.begin();
        first.set('Синхронизация: загрузка 10%');
        const textAfterFirstSet = statusEl.textContent;

        const second = transient.begin();
        second.set('Загрузка модели из комнаты…');
        const firstClearWhileStale = first.clear();
        const textAfterStaleClear = statusEl.textContent;

        const secondClear = second.clear();
        const textAfterSecondClear = statusEl.textContent;

        const third = transient.begin();
        third.set('Синхронизация: запись модели…');
        status.setStatusMessage('Экспорт…');
        const thirdClearAfterOverride = third.clear();
        const textAfterOverrideClear = statusEl.textContent;

        const fourth = transient.begin();
        fourth.set('Синхронизация: обновление активной модели…');
        fourth.keep();
        status.setStatusMessage('готово: модель синхронизирована');
        const fourthClearAfterKeep = fourth.clear();
        const textAfterKeepClear = statusEl.textContent;

        status.dispose();

        return {
            textAfterFirstSet,
            firstClearWhileStale,
            textAfterStaleClear,
            secondClear,
            textAfterSecondClear,
            thirdClearAfterOverride,
            textAfterOverrideClear,
            fourthClearAfterKeep,
            textAfterKeepClear,
        };
    });

    assert.equal(result.textAfterFirstSet, 'Синхронизация: загрузка 10%', 'Transient status smoke: initial scoped status was not set');
    assert.equal(result.firstClearWhileStale, false, 'Transient status smoke: stale scope cleared newer status');
    assert.equal(result.textAfterStaleClear, 'Загрузка модели из комнаты…', 'Transient status smoke: newer status was overwritten by stale clear');
    assert.equal(result.secondClear, true, 'Transient status smoke: current scope did not clear its own status');
    assert.equal(result.textAfterSecondClear, '', 'Transient status smoke: current scope status stayed visible after clear');
    assert.equal(result.thirdClearAfterOverride, false, 'Transient status smoke: scope cleared externally replaced status');
    assert.equal(result.textAfterOverrideClear, 'Экспорт…', 'Transient status smoke: externally replaced status was cleared');
    assert.equal(result.fourthClearAfterKeep, false, 'Transient status smoke: kept scope cleared retained message');
    assert.equal(result.textAfterKeepClear, 'готово: модель синхронизирована', 'Transient status smoke: kept message was cleared');
    diagnostics.assertNoErrors('Transient status smoke');
    await page.close();
}

async function runModalControllersDisposeSmoke(browser, baseUrl) {
    const page = await browser.newPage();
    const diagnostics = attachPageDiagnostics(page);
    await page.goto(`${baseUrl}/__smoke_blank`, { waitUntil: 'domcontentloaded', timeout: 15000 });

    const result = await page.evaluate(async () => {
        const { createPromptModalController } = await import('/scripts/modules/ui/prompt-modal.js');
        const { createConfirmModalController } = await import('/scripts/modules/ui/confirm-modal.js');
        const { createTransitionModalController } = await import('/scripts/modules/ui/transition-modal.js');
        const { createExportModalController } = await import('/scripts/modules/ui/export-modal.js');
        const { createRectAnnotationModalController } = await import('/scripts/modules/ui/rect-annotation-modal.js');
        const { createPasswordResetModalController } = await import('/scripts/modules/ui/password-reset-modal.js');
        const { createGeoJsonModalController } = await import('/scripts/modules/ui/geojson-modal.js');

        const focusCalls = {
            prompt: 0,
            confirm: 0,
            transition: 0,
            export: 0,
            rectColor: 0,
            rectText: 0,
            reset: 0,
        };

        const makeButton = () => {
            const btn = document.createElement('button');
            btn.type = 'button';
            return btn;
        };

        const makeModal = () => {
            const modal = document.createElement('div');
            modal.className = 'modal';
            document.body.appendChild(modal);
            return modal;
        };

        const promptModal = makeModal();
        const promptInput = document.createElement('input');
        promptInput.focus = () => { focusCalls.prompt += 1; };
        const promptController = createPromptModalController({
            modalEl: promptModal,
            titleEl: document.createElement('b'),
            inputEl: promptInput,
            okBtn: makeButton(),
            cancelBtn: makeButton(),
            closeBtn: makeButton(),
        });
        const promptPending = promptController.open({ value: 'old' });
        const promptShownBeforeDispose = promptModal.classList.contains('show');
        promptController.dispose();
        const promptResult = await promptPending;
        const promptLate = await promptController.open({ value: 'late' });

        const confirmModal = makeModal();
        const confirmOk = makeButton();
        confirmOk.focus = () => { focusCalls.confirm += 1; };
        const confirmController = createConfirmModalController({
            modalEl: confirmModal,
            titleEl: document.createElement('b'),
            messageEl: document.createElement('p'),
            okBtn: confirmOk,
            cancelBtn: makeButton(),
            closeBtn: makeButton(),
        });
        const confirmPending = confirmController.open();
        const confirmShownBeforeDispose = confirmModal.classList.contains('show');
        confirmController.dispose();
        const confirmResult = await confirmPending;
        const confirmLate = await confirmController.open();

        const transitionModal = makeModal();
        const transitionSeconds = document.createElement('input');
        transitionSeconds.focus = () => { focusCalls.transition += 1; };
        const transitionController = createTransitionModalController({
            modalEl: transitionModal,
            titleEl: document.createElement('b'),
            secondsEl: transitionSeconds,
            typeEl: document.createElement('select'),
            trajectoryEl: document.createElement('select'),
            okBtn: makeButton(),
            cancelBtn: makeButton(),
            closeBtn: makeButton(),
        });
        const transitionPending = transitionController.open({ seconds: 1 });
        transitionController.dispose();
        const transitionResult = await transitionPending;
        const transitionLate = await transitionController.open({ seconds: 2 });

        const exportModal = makeModal();
        const exportFormat = document.createElement('select');
        exportFormat.focus = () => { focusCalls.export += 1; };
        const exportController = createExportModalController({
            modalEl: exportModal,
            titleEl: document.createElement('b'),
            formatEl: exportFormat,
            coordsEl: document.createElement('select'),
            okBtn: makeButton(),
            cancelBtn: makeButton(),
            closeBtn: makeButton(),
        });
        const exportPending = exportController.open();
        exportController.dispose();
        const exportResult = await exportPending;
        const exportLate = await exportController.open();

        const rectModal = makeModal();
        const rectColor = document.createElement('input');
        rectColor.focus = () => { focusCalls.rectColor += 1; };
        const rectText = document.createElement('textarea');
        rectText.focus = () => { focusCalls.rectText += 1; };
        const rectController = createRectAnnotationModalController({
            modalEl: rectModal,
            titleEl: document.createElement('b'),
            colorEl: rectColor,
            fillRowEl: document.createElement('div'),
            fillEl: document.createElement('select'),
            infoRowEl: document.createElement('div'),
            infoEl: document.createElement('select'),
            areaEl: document.createElement('div'),
            textEl: rectText,
            textRowEl: document.createElement('div'),
            okBtn: makeButton(),
            cancelBtn: makeButton(),
            closeBtn: makeButton(),
        });
        const rectPending = rectController.open({ mode: 'pin', info: 'text' });
        rectController.dispose();
        const rectResult = await rectPending;
        const rectLate = await rectController.open();

        const resetModal = makeModal();
        const resetPassword = document.createElement('input');
        resetPassword.focus = () => { focusCalls.reset += 1; };
        const resetController = createPasswordResetModalController({
            modalEl: resetModal,
            titleEl: document.createElement('b'),
            messageEl: document.createElement('p'),
            passwordEl: resetPassword,
            repeatEl: document.createElement('input'),
            okBtn: makeButton(),
            cancelBtn: makeButton(),
            closeBtn: makeButton(),
        });
        const resetPending = resetController.open();
        resetController.dispose();
        resetController.setMessage('late message');
        const resetResult = await resetPending;
        const resetLate = await resetController.open();

        const geoController = createGeoJsonModalController({ document });
        geoController.open({ text: '{"a":1}' }, 'Before dispose');
        const geoCreatedBeforeDispose = !!document.getElementById('geoModal');
        geoController.dispose();
        geoController.open({ text: '{"b":2}' }, 'After dispose');

        await Promise.resolve();
        await Promise.resolve();

        return {
            promptShownBeforeDispose,
            promptResult,
            promptLate,
            promptShownAfterLateOpen: promptModal.classList.contains('show'),
            confirmShownBeforeDispose,
            confirmResult,
            confirmLate,
            confirmShownAfterLateOpen: confirmModal.classList.contains('show'),
            transitionResult,
            transitionLate,
            transitionShownAfterLateOpen: transitionModal.classList.contains('show'),
            exportResult,
            exportLate,
            exportShownAfterLateOpen: exportModal.classList.contains('show'),
            rectResult,
            rectLate,
            rectShownAfterLateOpen: rectModal.classList.contains('show'),
            resetResult,
            resetLate,
            resetShownAfterLateOpen: resetModal.classList.contains('show'),
            resetMessageAfterDispose: resetController.isOpen() ? 'open' : '',
            geoCreatedBeforeDispose,
            geoExistsAfterLateOpen: !!document.getElementById('geoModal'),
            focusCalls,
        };
    });

    assert.equal(result.promptShownBeforeDispose, true, 'Modal dispose smoke: prompt did not open before dispose');
    assert.equal(result.promptResult, null, 'Modal dispose smoke: prompt pending promise did not cancel on dispose');
    assert.equal(result.promptLate, null, 'Modal dispose smoke: disposed prompt open did not return null');
    assert.equal(result.promptShownAfterLateOpen, false, 'Modal dispose smoke: disposed prompt reopened DOM');
    assert.equal(result.confirmShownBeforeDispose, true, 'Modal dispose smoke: confirm did not open before dispose');
    assert.equal(result.confirmResult, false, 'Modal dispose smoke: confirm pending promise did not cancel false on dispose');
    assert.equal(result.confirmLate, false, 'Modal dispose smoke: disposed confirm open did not return false');
    assert.equal(result.confirmShownAfterLateOpen, false, 'Modal dispose smoke: disposed confirm reopened DOM');
    assert.equal(result.transitionResult, null, 'Modal dispose smoke: transition pending promise did not cancel on dispose');
    assert.equal(result.transitionLate, null, 'Modal dispose smoke: disposed transition open did not return null');
    assert.equal(result.transitionShownAfterLateOpen, false, 'Modal dispose smoke: disposed transition reopened DOM');
    assert.equal(result.exportResult, null, 'Modal dispose smoke: export pending promise did not cancel on dispose');
    assert.equal(result.exportLate, null, 'Modal dispose smoke: disposed export open did not return null');
    assert.equal(result.exportShownAfterLateOpen, false, 'Modal dispose smoke: disposed export reopened DOM');
    assert.equal(result.rectResult, null, 'Modal dispose smoke: rect pending promise did not cancel on dispose');
    assert.equal(result.rectLate, null, 'Modal dispose smoke: disposed rect open did not return null');
    assert.equal(result.rectShownAfterLateOpen, false, 'Modal dispose smoke: disposed rect reopened DOM');
    assert.equal(result.resetResult, null, 'Modal dispose smoke: reset pending promise did not cancel on dispose');
    assert.equal(result.resetLate, null, 'Modal dispose smoke: disposed reset open did not return null');
    assert.equal(result.resetShownAfterLateOpen, false, 'Modal dispose smoke: disposed reset reopened DOM');
    assert.equal(result.geoCreatedBeforeDispose, true, 'Modal dispose smoke: geo modal was not created before dispose');
    assert.equal(result.geoExistsAfterLateOpen, false, 'Modal dispose smoke: disposed geo modal recreated DOM');
    assert.deepEqual(
        result.focusCalls,
        { prompt: 0, confirm: 0, transition: 0, export: 0, rectColor: 0, rectText: 0, reset: 0 },
        'Modal dispose smoke: queued focus ran after dispose',
    );
    diagnostics.assertNoErrors('Modal controllers dispose smoke');
    await page.close();
}

async function runCustomSelectLifecycleSmoke(browser, baseUrl) {
    const page = await browser.newPage();
    const diagnostics = attachPageDiagnostics(page);
    await page.goto(`${baseUrl}/__smoke_blank`, { waitUntil: 'domcontentloaded', timeout: 15000 });

    const result = await page.evaluate(async () => {
        const { createCustomSelectController } = await import('/scripts/modules/ui/custom-select.js');

        const root = document.createElement('div');
        const select = document.createElement('select');
        select.append(new Option('One', '1'), new Option('Two', '2'));
        root.appendChild(select);
        document.body.appendChild(root);

        const rootAdd = root.addEventListener.bind(root);
        const rootRemove = root.removeEventListener.bind(root);
        const winAdd = window.addEventListener.bind(window);
        const winRemove = window.removeEventListener.bind(window);
        const rootAdds = [];
        const rootRemoves = [];
        const winAdds = [];
        const winRemoves = [];

        root.addEventListener = (...args) => {
            rootAdds.push(args[0]);
            return rootAdd(...args);
        };
        root.removeEventListener = (...args) => {
            rootRemoves.push(args[0]);
            return rootRemove(...args);
        };
        window.addEventListener = (...args) => {
            if (args[0] === 'scroll' || args[0] === 'resize') winAdds.push(args[0]);
            return winAdd(...args);
        };
        window.removeEventListener = (...args) => {
            if (args[0] === 'scroll' || args[0] === 'resize') winRemoves.push(args[0]);
            return winRemove(...args);
        };

        try {
            const controller = createCustomSelectController({ root });
            const trigger = root.querySelector('.custom-select-trigger');
            trigger?.click?.();
            const openListsBeforeDispose = document.body.querySelectorAll('.custom-select-list.is-open').length;

            controller.dispose();
            controller.dispose();
            select.append(new Option('Three', '3'));
            controller.refresh();

            const bodyListsAfterDispose = document.body.querySelectorAll('.custom-select-list').length;
            const wrappersAfterDispose = root.querySelectorAll('.custom-select').length;
            const selectRestored =
                select.parentNode === root &&
                !select.classList.contains('custom-select-native') &&
                select.dataset.customSelectReady === 'false';

            const second = createCustomSelectController({ root });
            const secondTrigger = root.querySelector('.custom-select-trigger');
            secondTrigger?.click?.();
            const openListsAfterReinit = document.body.querySelectorAll('.custom-select-list.is-open').length;
            window.dispatchEvent(new Event('scroll'));
            const openListsAfterScroll = document.body.querySelectorAll('.custom-select-list.is-open').length;
            second.dispose();

            return {
                openListsBeforeDispose,
                bodyListsAfterDispose,
                wrappersAfterDispose,
                selectRestored,
                openListsAfterReinit,
                openListsAfterScroll,
                rootAdds,
                rootRemoves,
                winAdds,
                winRemoves,
                bodyListsAfterSecondDispose: document.body.querySelectorAll('.custom-select-list').length,
            };
        } finally {
            root.addEventListener = rootAdd;
            root.removeEventListener = rootRemove;
            window.addEventListener = winAdd;
            window.removeEventListener = winRemove;
        }
    });

    assert.equal(result.openListsBeforeDispose, 1, 'Custom select smoke: select did not open before dispose');
    assert.equal(result.bodyListsAfterDispose, 0, 'Custom select smoke: disposed controller left dropdown list in body');
    assert.equal(result.wrappersAfterDispose, 0, 'Custom select smoke: disposed controller left wrapper in root');
    assert.equal(result.selectRestored, true, 'Custom select smoke: native select was not restored on dispose');
    assert.equal(result.openListsAfterReinit, 1, 'Custom select smoke: select did not reinitialize after dispose');
    assert.equal(result.openListsAfterScroll, 0, 'Custom select smoke: active dropdown did not close on outside scroll');
    assert.deepEqual(result.rootRemoves, result.rootAdds, 'Custom select smoke: root listeners were not removed exactly once');
    assert.deepEqual(result.winRemoves, result.winAdds, 'Custom select smoke: window listeners were not removed exactly once');
    assert.equal(result.bodyListsAfterSecondDispose, 0, 'Custom select smoke: second dispose left dropdown list in body');
    diagnostics.assertNoErrors('Custom select lifecycle smoke');
    await page.close();
}

async function runAppbarControllersDisposeSmoke(browser, baseUrl) {
    const page = await browser.newPage();
    const diagnostics = attachPageDiagnostics(page);
    await page.goto(`${baseUrl}/__smoke_blank`, { waitUntil: 'domcontentloaded', timeout: 15000 });

    const result = await page.evaluate(async () => {
        const { createAppbarControlsController } = await import('/scripts/modules/ui/appbar-controls.js');
        const { createAppbarVisibilityTogglesController } = await import('/scripts/modules/ui/appbar-visibility-toggles.js');
        const { createLayoutController } = await import('/scripts/modules/ui/layout.js');

        const makeButton = () => {
            const button = document.createElement('button');
            button.type = 'button';
            document.body.appendChild(button);
            return button;
        };

        const statsBtn = makeButton();
        const gridBtn = makeButton();
        const resetBtn = makeButton();
        const resetViewBtn = makeButton();
        const fullscreenBtn = makeButton();
        const controlCalls = {
            stats: 0,
            grid: 0,
            reset: 0,
            resetView: 0,
            fullscreen: 0,
        };
        let statsVisible = false;
        let gridVisible = false;
        const controls = createAppbarControlsController({
            statsBtn,
            gridToggleBtn: gridBtn,
            resetViewerBtn: resetBtn,
            resetViewBtn,
            fullscreenBtn,
            initialStatsVisible: true,
            initialGridVisible: true,
            setStatsVisible: (visible) => {
                controlCalls.stats += 1;
                statsVisible = !!visible;
            },
            isStatsVisible: () => statsVisible,
            setGridVisible: (visible) => {
                controlCalls.grid += 1;
                gridVisible = !!visible;
            },
            isGridVisible: () => gridVisible,
            onReset: () => { controlCalls.reset += 1; },
            onResetView: () => { controlCalls.resetView += 1; },
            onToggleFullscreen: () => { controlCalls.fullscreen += 1; },
        });
        statsBtn.click();
        gridBtn.click();
        resetBtn.click();
        resetViewBtn.click();
        fullscreenBtn.click();
        const controlCallsBeforeDispose = { ...controlCalls };
        controls.dispose();
        controls.dispose();
        statsBtn.click();
        gridBtn.click();
        resetBtn.click();
        resetViewBtn.click();
        fullscreenBtn.click();
        controls.resetViewer();
        controls.resetView();
        controls.toggleFullscreen();

        const solidBtn = makeButton();
        const collBtn = makeButton();
        const vpmBtn = makeButton();
        const npmBtn = makeButton();
        const visibilityCalls = {
            panel: 0,
            eye: 0,
            nonGlass: 0,
            apply: 0,
            collisions: 0,
            vpm: 0,
            npm: 0,
        };
        const visibilityState = {
            nonGlass: { hasAny: true, anyVisible: true, suppressed: false },
            collisions: { hasAny: true, anyVisible: false },
            vpm: { hasAny: true, anyVisible: false },
            npm: { hasAny: true, anyVisible: false },
        };
        const visibility = createAppbarVisibilityTogglesController({
            solidToggleBtn: solidBtn,
            collToggleBtn: collBtn,
            vpmToggleBtn: vpmBtn,
            npmToggleBtn: npmBtn,
            schedulePanelRefresh: () => { visibilityCalls.panel += 1; },
            api: {
                handleEyeToggleRaw: () => { visibilityCalls.eye += 1; },
                getNonGlassState: () => visibilityState.nonGlass,
                toggleNonGlassSuppressed: () => {
                    visibilityCalls.nonGlass += 1;
                    visibilityState.nonGlass.suppressed = !visibilityState.nonGlass.suppressed;
                },
                applyNonGlassSuppression: () => { visibilityCalls.apply += 1; },
                getCollisionsState: () => visibilityState.collisions,
                toggleCollisionsVisible: () => {
                    visibilityCalls.collisions += 1;
                    visibilityState.collisions.anyVisible = !visibilityState.collisions.anyVisible;
                },
                getVPMModelsState: () => visibilityState.vpm,
                toggleVPMModelsVisible: () => {
                    visibilityCalls.vpm += 1;
                    visibilityState.vpm.anyVisible = !visibilityState.vpm.anyVisible;
                },
                getNPMModelsState: () => visibilityState.npm,
                toggleNPMModelsVisible: () => {
                    visibilityCalls.npm += 1;
                    visibilityState.npm.anyVisible = !visibilityState.npm.anyVisible;
                },
            },
        });
        visibility.updateAll();
        solidBtn.click();
        collBtn.click();
        vpmBtn.click();
        npmBtn.click();
        visibility.handleEyeToggle(document.createElement('button'));
        const visibilityCallsBeforeDispose = { ...visibilityCalls };
        visibility.dispose();
        visibility.dispose();
        solidBtn.textContent = 'sentinel';
        visibilityState.nonGlass.suppressed = true;
        solidBtn.click();
        collBtn.click();
        vpmBtn.click();
        npmBtn.click();
        visibility.handleEyeToggle(document.createElement('button'));
        visibility.enforceSuppressionIfNeeded();
        visibility.updateAll();

        const appbar = document.createElement('div');
        appbar.className = 'appbar';
        const camsBar = document.createElement('div');
        camsBar.id = 'camsBar';
        document.body.append(appbar, camsBar);
        const layoutWin = new EventTarget();
        layoutWin.innerWidth = 800;
        layoutWin.innerHeight = 600;
        const layoutBtn = makeButton();
        const layoutCalls = { setSize: 0, projection: 0, render: 0 };
        const layout = createLayoutController({
            root: document,
            window: layoutWin,
            renderer: {
                setSize: () => { layoutCalls.setSize += 1; },
            },
            camera: {
                aspect: 1,
                updateProjectionMatrix: () => { layoutCalls.projection += 1; },
            },
            requestRender: () => { layoutCalls.render += 1; },
            toggleSideBtn: layoutBtn,
        });
        layout.layout();
        const layoutCallsBeforeDispose = { ...layoutCalls };
        layout.dispose();
        layout.dispose();
        layoutWin.innerWidth = 1024;
        layoutWin.innerHeight = 768;
        layoutWin.dispatchEvent(new Event('resize'));
        layoutBtn.click();
        layout.layout();
        layout.hideSidePanel();

        return {
            controlCallsBeforeDispose,
            controlCallsAfterDispose: controlCalls,
            visibilityCallsBeforeDispose,
            visibilityCallsAfterDispose: visibilityCalls,
            solidTextAfterLateUpdate: solidBtn.textContent,
            layoutCallsBeforeDispose,
            layoutCallsAfterDispose: layoutCalls,
        };
    });

    assert.deepEqual(
        result.controlCallsAfterDispose,
        result.controlCallsBeforeDispose,
        'Appbar controls smoke: disposed controls still handled clicks or public methods',
    );
    assert.deepEqual(
        result.visibilityCallsAfterDispose,
        result.visibilityCallsBeforeDispose,
        'Appbar visibility smoke: disposed visibility controller still mutated API state',
    );
    assert.equal(result.solidTextAfterLateUpdate, 'sentinel', 'Appbar visibility smoke: disposed updateAll still changed button UI');
    assert.deepEqual(
        result.layoutCallsAfterDispose,
        result.layoutCallsBeforeDispose,
        'Layout smoke: disposed layout still handled resize/click/public calls',
    );
    diagnostics.assertNoErrors('Appbar/layout dispose smoke');
    await page.close();
}

async function runLightControlsDisposeSmoke(browser, baseUrl) {
    const page = await browser.newPage();
    const diagnostics = attachPageDiagnostics(page);
    await page.goto(`${baseUrl}/__smoke_blank`, { waitUntil: 'domcontentloaded', timeout: 15000 });

    const result = await page.evaluate(async () => {
        const THREE = await import('three');
        const { createShadowController } = await import('/scripts/modules/render/shadow-controller.js');
        const { createImportedLightsController } = await import('/scripts/modules/scene/imported-lights.js');
        const { createEnvironmentControlsController } = await import('/scripts/modules/ui/environment-controls.js');
        const { createHemiLightControlsController } = await import('/scripts/modules/ui/hemi-light-controls.js');
        const { createSunInputsController } = await import('/scripts/modules/ui/sun-inputs.js');
        const { createSunToggleController } = await import('/scripts/modules/ui/sun-toggle.js');
        const { createSliderValueDisplayController } = await import('/scripts/modules/ui/slider-value-displays.js');

        const envCalls = { enabled: 0, rotation: 0, apply: 0, rebuild: 0, sync: 0, preset: 0 };
        const iblChk = document.createElement('input');
        iblChk.type = 'checkbox';
        iblChk.checked = true;
        const hdriPresetSel = document.createElement('select');
        hdriPresetSel.append(new Option('placeholder', ''));
        const iblIntEl = document.createElement('input');
        iblIntEl.value = '2';
        const iblGammaEl = document.createElement('input');
        const iblTintEl = document.createElement('input');
        const iblRotEl = document.createElement('input');
        iblRotEl.value = '45';
        const hdriExposureEl = document.createElement('input');
        const hdriSaturationEl = document.createElement('input');
        const hdriBlurEl = document.createElement('input');
        document.body.append(iblChk, hdriPresetSel, iblIntEl, iblGammaEl, iblTintEl, iblRotEl, hdriExposureEl, hdriSaturationEl, hdriBlurEl);
        const envController = createEnvironmentControlsController({
            scene: { environment: { id: 'env' } },
            iblChk,
            hdriPresetSel,
            presets: [{ name: 'A' }, { name: 'B', isDefault: true }],
            iblIntEl,
            iblGammaEl,
            iblTintEl,
            iblRotEl,
            hdriExposureEl,
            hdriSaturationEl,
            hdriBlurEl,
            setEnvironmentEnabled: () => { envCalls.enabled += 1; },
            setEnvironmentRotation: () => { envCalls.rotation += 1; },
            applyEnvToMaterials: () => { envCalls.apply += 1; },
            requestEnvironmentRebuild: () => { envCalls.rebuild += 1; },
            syncEnvAdjustmentsState: () => { envCalls.sync += 1; },
            selectPresetIndex: async () => { envCalls.preset += 1; },
        });
        const envOptionsBeforeDispose = hdriPresetSel.options.length;
        const envDefaultValueBeforeDispose = hdriPresetSel.value;
        envController.dispose();
        envController.dispose();
        hdriPresetSel.innerHTML = '<option value="sentinel">sentinel</option>';
        envController.populateHdriPresets();
        envController.scheduleEnvRebuildFromUI();
        iblChk.dispatchEvent(new Event('change', { bubbles: true }));
        iblIntEl.dispatchEvent(new Event('input', { bubbles: true }));
        iblRotEl.dispatchEvent(new Event('input', { bubbles: true }));
        hdriPresetSel.value = '1';
        hdriPresetSel.dispatchEvent(new Event('change', { bubbles: true }));
        await Promise.resolve();

        const hemiCalls = { render: 0, lights: 0, sky: 0, ground: 0 };
        const hemiIntEl = document.createElement('input');
        hemiIntEl.value = '1';
        const hemiSkyEl = document.createElement('input');
        hemiSkyEl.value = '#ffffff';
        const hemiGroundEl = document.createElement('input');
        hemiGroundEl.value = '#000000';
        const hemiLight = {
            intensity: 0,
            color: { set: () => { hemiCalls.sky += 1; } },
            groundColor: { set: () => { hemiCalls.ground += 1; } },
        };
        const hemi = createHemiLightControlsController({
            hemiLight,
            hemiIntEl,
            hemiSkyEl,
            hemiGroundEl,
            requestRender: () => { hemiCalls.render += 1; },
            onLightsUpdated: () => { hemiCalls.lights += 1; },
        });
        const hemiBeforeDispose = { ...hemiCalls, intensity: hemiLight.intensity };
        hemi.dispose();
        hemi.dispose();
        hemiIntEl.value = '7';
        hemiIntEl.dispatchEvent(new Event('input', { bubbles: true }));
        hemi.applyFromInputs();

        const sunCalls = { update: 0, render: 0, lights: 0 };
        const sunHourEl = document.createElement('input');
        sunHourEl.value = '12';
        const sunHourInputEl = document.createElement('input');
        const sunDayEl = document.createElement('input');
        const sunMonthEl = document.createElement('input');
        const sunNorthEl = document.createElement('input');
        const sunIntensityEl = document.createElement('input');
        sunIntensityEl.min = '0';
        sunIntensityEl.max = '20';
        const sunIntensityInputEl = document.createElement('input');
        sunIntensityInputEl.min = '0';
        sunIntensityInputEl.max = '20';
        const dirLight = { intensity: 3 };
        const sunInputs = createSunInputsController({
            sunHourEl,
            sunHourInputEl,
            sunDayEl,
            sunMonthEl,
            sunNorthEl,
            sunIntensityEl,
            sunIntensityInputEl,
            dirLight,
            updateSun: () => { sunCalls.update += 1; },
            requestRender: () => { sunCalls.render += 1; },
            onLightsUpdated: () => { sunCalls.lights += 1; },
        });
        const sunBeforeDispose = { ...sunCalls, intensity: dirLight.intensity };
        sunInputs.dispose();
        sunInputs.dispose();
        sunHourEl.value = '15';
        sunHourEl.dispatchEvent(new Event('input', { bubbles: true }));
        sunIntensityInputEl.value = '9';
        sunIntensityInputEl.dispatchEvent(new Event('change', { bubbles: true }));

        const sunToggleCalls = { layout: 0, render: 0, enable: 0, disable: 0 };
        const sunRoot = document;
        const sunHost = document.createElement('div');
        const sunControlsEl = document.createElement('div');
        const sunEnabledEl = document.createElement('input');
        sunEnabledEl.type = 'checkbox';
        sunHost.appendChild(sunControlsEl);
        document.body.append(sunEnabledEl, sunHost);
        const app = { sun: { enabled: true } };
        const renderer = { shadowMap: { enabled: true } };
        const toggleDirLight = { visible: true, castShadow: true };
        const sunToggle = createSunToggleController({
            root: sunRoot,
            app,
            sunEnabledEl,
            sunControlsEl,
            renderer,
            dirLight: toggleDirLight,
            initialEnabled: false,
            layout: () => { sunToggleCalls.layout += 1; },
            requestRender: () => { sunToggleCalls.render += 1; },
            onEnable: () => { sunToggleCalls.enable += 1; },
            onDisable: () => { sunToggleCalls.disable += 1; },
        });
        const sunControlsUnmounted = !sunControlsEl.isConnected;
        sunToggle.dispose();
        sunToggle.dispose();
        const sunControlsRestoredAfterDispose = sunControlsEl.isConnected;
        const sunToggleBeforeLateCalls = {
            ...sunToggleCalls,
            enabled: app.sun.enabled,
            visible: toggleDirLight.visible,
            shadows: renderer.shadowMap.enabled,
        };
        sunToggle.setEnabled(true);
        sunToggle.unmountControls();
        sunEnabledEl.checked = true;
        sunEnabledEl.dispatchEvent(new Event('change', { bubbles: true }));

        const sliderRoot = document.createElement('div');
        const slider = document.createElement('input');
        slider.type = 'range';
        slider.min = '0';
        slider.max = '10';
        slider.step = '0.5';
        slider.value = '2';
        const display = document.createElement('input');
        display.dataset.lightValueFor = 'slider-a';
        sliderRoot.append(slider, display);
        document.body.appendChild(sliderRoot);
        let sliderInputEvents = 0;
        slider.addEventListener('input', () => { sliderInputEvents += 1; });
        const sliderDisplay = createSliderValueDisplayController({ root: sliderRoot });
        sliderDisplay.register('slider-a', slider);
        sliderDisplay.updateAll();
        sliderDisplay.attachInputs();
        const displayBeforeDispose = display.value;
        sliderDisplay.dispose();
        sliderDisplay.dispose();
        display.value = '8';
        display.dispatchEvent(new Event('change', { bubbles: true }));
        slider.value = '9';
        sliderDisplay.updateAll();
        sliderDisplay.register('late', slider);
        sliderDisplay.attachInputs();

        const shadowScene = new THREE.Scene();
        const shadowLight = new THREE.DirectionalLight(0xffffff, 1);
        shadowLight.position.set(4, 5, 6);
        shadowLight.target.position.set(0, 0, 0);
        shadowScene.add(shadowLight, shadowLight.target);
        const shadowRenderer = { shadowMap: { needsUpdate: false } };
        const shadowBounds = new THREE.Box3(
            new THREE.Vector3(-1, -1, -1),
            new THREE.Vector3(1, 1, 1),
        );
        const shadow = createShadowController({
            THREE,
            scene: shadowScene,
            renderer: shadowRenderer,
            dirLight: shadowLight,
            computeSceneBounds: () => shadowBounds,
        });
        shadow.setShadowDebug(true);
        const shadowChildrenAfterDebug = shadowScene.children.length;
        shadow.dispose();
        shadow.dispose();
        const shadowChildrenAfterDispose = shadowScene.children.length;
        const shadowTargetBeforeLateCalls = shadowLight.target.position.clone();
        const shadowPositionBeforeLateCalls = shadowLight.position.clone();
        const shadowCameraLeftBeforeLateCalls = shadowLight.shadow.camera.left;
        shadowRenderer.shadowMap.needsUpdate = false;
        shadow.setShadowDebug(true);
        shadow.fitSunShadowToScene(true);
        shadow.setAutoFrustum(false);
        shadow.setFrustumScale(3);

        const lightRoot = new THREE.Group();
        const importedSpot = new THREE.SpotLight(0xffffff, 5);
        importedSpot.name = 'ImportedSpot';
        importedSpot.position.set(0, 3, 0);
        importedSpot.target.position.set(0, 0, -4);
        lightRoot.add(importedSpot, importedSpot.target);
        const importedLightCalls = { render: 0, updated: 0 };
        const importedLights = createImportedLightsController({
            THREE,
            loadedModels: [{ obj: lightRoot, name: 'lights.fbx' }],
            requestRender: () => { importedLightCalls.render += 1; },
            onLightsUpdated: () => { importedLightCalls.updated += 1; },
        });
        importedLights.disableShadowsOnImportedLights(lightRoot);
        importedLights.ensureLightHelpers(lightRoot);
        const helperBeforeDispose = importedSpot.userData._lightHelper || null;
        let helperGeometryDisposed = 0;
        let helperMaterialDisposed = 0;
        helperBeforeDispose?.traverse?.((node) => {
            node.geometry?.addEventListener?.('dispose', () => { helperGeometryDisposed += 1; });
            const materials = Array.isArray(node.material) ? node.material : [node.material];
            materials.filter(Boolean).forEach((material) => {
                material.addEventListener?.('dispose', () => { helperMaterialDisposed += 1; });
            });
        });
        importedLights.setLightHelpersVisible(true);
        importedLights.setImportedLightsEnabled(true);
        const importedBeforeDispose = {
            helperAttached: !!helperBeforeDispose?.parent,
            helperVisible: helperBeforeDispose?.visible === true,
            intensity: importedSpot.intensity,
            visible: importedSpot.visible,
            calls: { ...importedLightCalls },
        };
        importedLights.dispose();
        importedLights.dispose();
        const importedAfterDispose = {
            helperRemoved: !helperBeforeDispose?.parent,
            helperRefCleared: !importedSpot.userData._lightHelper,
            helperGeometryDisposed,
            helperMaterialDisposed,
            intensity: importedSpot.intensity,
            visible: importedSpot.visible,
            calls: { ...importedLightCalls },
        };
        importedLights.ensureLightHelpers(lightRoot);
        importedLights.setLightHelpersVisible(false);
        importedLights.setImportedLightsEnabled(false);
        const importedAfterLateCalls = {
            helperRecreated: !!importedSpot.userData._lightHelper,
            intensity: importedSpot.intensity,
            visible: importedSpot.visible,
            calls: { ...importedLightCalls },
        };

        return {
            envOptionsBeforeDispose,
            envDefaultValueBeforeDispose,
            envOptionsAfterLatePopulate: hdriPresetSel.options.length,
            envFirstOptionAfterLatePopulate: hdriPresetSel.options[0]?.value || '',
            envCalls,
            hemiBeforeDispose,
            hemiAfterDispose: { ...hemiCalls, intensity: hemiLight.intensity },
            sunBeforeDispose,
            sunAfterDispose: { ...sunCalls, intensity: dirLight.intensity },
            sunControlsUnmounted,
            sunControlsRestoredAfterDispose,
            sunToggleBeforeLateCalls,
            sunToggleAfterLateCalls: {
                ...sunToggleCalls,
                enabled: app.sun.enabled,
                visible: toggleDirLight.visible,
                shadows: renderer.shadowMap.enabled,
                controlsConnected: sunControlsEl.isConnected,
            },
            displayBeforeDispose,
            displayAfterLateCalls: display.value,
            sliderValueAfterLateCalls: slider.value,
            sliderInputEvents,
            shadowChildrenAfterDebug,
            shadowChildrenAfterDispose,
            shadowChildrenAfterLateCalls: shadowScene.children.length,
            shadowTargetStableAfterLateCalls: shadowLight.target.position.distanceTo(shadowTargetBeforeLateCalls) < 1e-9,
            shadowPositionStableAfterLateCalls: shadowLight.position.distanceTo(shadowPositionBeforeLateCalls) < 1e-9,
            shadowCameraStableAfterLateCalls: shadowLight.shadow.camera.left === shadowCameraLeftBeforeLateCalls,
            shadowRendererStableAfterLateCalls: shadowRenderer.shadowMap.needsUpdate === false,
            shadowDebugVisibleAfterLateCalls: shadow.isShadowDebugVisible(),
            shadowAutoFrustumAfterLateCalls: shadow.getAutoFrustum(),
            shadowFrustumScaleAfterLateCalls: shadow.getFrustumScale(),
            importedBeforeDispose,
            importedAfterDispose,
            importedAfterLateCalls,
        };
    });

    assert.equal(result.envOptionsBeforeDispose, 3, 'Light controls smoke: environment presets were not populated before dispose');
    assert.equal(result.envDefaultValueBeforeDispose, '1', 'Light controls smoke: default environment preset was not selected');
    assert.equal(result.envOptionsAfterLatePopulate, 1, 'Light controls smoke: disposed environment repopulated preset options');
    assert.equal(result.envFirstOptionAfterLatePopulate, 'sentinel', 'Light controls smoke: disposed environment changed preset option');
    assert.deepEqual(result.envCalls, { enabled: 0, rotation: 0, apply: 0, rebuild: 0, sync: 1, preset: 0 }, 'Light controls smoke: disposed environment still handled UI updates');
    assert.deepEqual(result.hemiAfterDispose, result.hemiBeforeDispose, 'Light controls smoke: disposed hemi controls still changed light state');
    assert.deepEqual(result.sunAfterDispose, result.sunBeforeDispose, 'Light controls smoke: disposed sun inputs still changed light state');
    assert.equal(result.sunControlsUnmounted, true, 'Light controls smoke: sun controls were not unmounted before dispose');
    assert.equal(result.sunControlsRestoredAfterDispose, true, 'Light controls smoke: sun controls were not restored on dispose');
    assert.deepEqual(result.sunToggleAfterLateCalls, {
        ...result.sunToggleBeforeLateCalls,
        controlsConnected: true,
    }, 'Light controls smoke: disposed sun toggle still changed state');
    assert.equal(result.displayBeforeDispose, '2.0', 'Light controls smoke: slider display was not initialized');
    assert.equal(result.displayAfterLateCalls, '8', 'Light controls smoke: disposed slider display still updated display');
    assert.equal(result.sliderValueAfterLateCalls, '9', 'Light controls smoke: disposed slider display still committed input');
    assert.equal(result.sliderInputEvents, 0, 'Light controls smoke: disposed slider display dispatched input');
    assert.equal(result.shadowChildrenAfterDebug, 4, 'Light controls smoke: shadow debug helpers were not created');
    assert.equal(result.shadowChildrenAfterDispose, 2, 'Light controls smoke: shadow debug helpers were not disposed');
    assert.equal(result.shadowChildrenAfterLateCalls, 2, 'Light controls smoke: disposed shadow controller recreated helpers');
    assert.equal(result.shadowTargetStableAfterLateCalls, true, 'Light controls smoke: disposed shadow controller moved target');
    assert.equal(result.shadowPositionStableAfterLateCalls, true, 'Light controls smoke: disposed shadow controller moved light');
    assert.equal(result.shadowCameraStableAfterLateCalls, true, 'Light controls smoke: disposed shadow controller changed camera frustum');
    assert.equal(result.shadowRendererStableAfterLateCalls, true, 'Light controls smoke: disposed shadow controller flagged renderer shadow map');
    assert.equal(result.shadowDebugVisibleAfterLateCalls, false, 'Light controls smoke: disposed shadow controller reported visible debug helpers');
    assert.equal(result.shadowAutoFrustumAfterLateCalls, true, 'Light controls smoke: disposed shadow controller changed auto-frustum');
    assert.equal(result.shadowFrustumScaleAfterLateCalls, 1, 'Light controls smoke: disposed shadow controller changed frustum scale');
    assert.equal(result.importedBeforeDispose.helperAttached, true, 'Light controls smoke: imported light helper was not attached');
    assert.equal(result.importedBeforeDispose.helperVisible, true, 'Light controls smoke: imported light helper did not become visible');
    assert.equal(result.importedAfterDispose.helperRemoved, true, 'Light controls smoke: imported light helper stayed attached after dispose');
    assert.equal(result.importedAfterDispose.helperRefCleared, true, 'Light controls smoke: imported light helper ref stayed after dispose');
    assert.ok(result.importedAfterDispose.helperGeometryDisposed > 0, 'Light controls smoke: imported light helper geometry was not disposed');
    assert.ok(result.importedAfterDispose.helperMaterialDisposed > 0, 'Light controls smoke: imported light helper material was not disposed');
    assert.deepEqual(result.importedAfterLateCalls, {
        helperRecreated: false,
        intensity: result.importedAfterDispose.intensity,
        visible: result.importedAfterDispose.visible,
        calls: result.importedAfterDispose.calls,
    }, 'Light controls smoke: disposed imported lights controller still mutated state');
    diagnostics.assertNoErrors('Light controls dispose smoke');
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
const browserContext = await browser.newContext();
await installSmokeCdnRoute(browserContext);

try {
    console.log(`Smoke server: ${smokeServer.baseUrl}`);
    await runBootSmoke(browserContext, smokeServer.baseUrl);
    console.log('Boot smoke passed.');
    await runBootRuntimeFailureSmoke(browserContext, smokeServer.baseUrl);
    console.log('Boot runtime failure smoke passed.');
    await runBootJSZipCdnNonBlockingSmoke(browserContext, smokeServer.baseUrl);
    console.log('Boot JSZip CDN non-blocking smoke passed.');
    await runRuntimeDiagnosticsSmoke(browserContext, smokeServer.baseUrl);
    console.log('Runtime diagnostics smoke passed.');
    await runRoomEntrySmoke(browserContext, smokeServer.baseUrl);
    console.log('Room-entry smoke passed.');
    await runRoomInviteModelUploadGuardSmoke(browserContext, smokeServer.baseUrl);
    console.log('Room invite model upload guard smoke passed.');
    await runResetViewerUrlSmoke(browserContext, smokeServer.baseUrl);
    console.log('Reset viewer URL smoke passed.');
    await runAuthAsyncDisposeSmoke(browserContext, smokeServer.baseUrl);
    console.log('Auth async dispose smoke passed.');
    await runBrowserSdkRetrySmoke(browserContext, smokeServer.baseUrl);
    console.log('Browser SDK retry smoke passed.');
    await runCollabCrudStaleSmoke(browserContext, smokeServer.baseUrl);
    console.log('Collab CRUD stale smoke passed.');
    await runCollabAutoResumeKeepsModelsSmoke(browserContext, smokeServer.baseUrl);
    console.log('Collab auto-resume keeps models smoke passed.');
    await runProjectAdminTreeSmoke(browserContext, smokeServer.baseUrl);
    console.log('Project admin permissions and responsive UI smoke passed.');
    await runCollabRegisteredRoomSwitchSmoke(browserContext, smokeServer.baseUrl);
    console.log('Registered room switch smoke passed.');
    await runDisposeReinitSmoke(browserContext, smokeServer.baseUrl);
    console.log('Dispose/reinit smoke passed.');
    await runRendererDisposeLifecycleSmoke(browserContext, smokeServer.baseUrl);
    console.log('Renderer dispose lifecycle smoke passed.');
    await runRendererModeDetectionSmoke(browserContext, smokeServer.baseUrl);
    console.log('Renderer mode detection smoke passed.');
    await runSceneCoreDisposeLifecycleSmoke(browserContext, smokeServer.baseUrl);
    console.log('Scene core dispose lifecycle smoke passed.');
    await runRenderLoopLifecycleSmoke(browserContext, smokeServer.baseUrl);
    console.log('Render loop lifecycle smoke passed.');
    await runWASDFlightLifecycleSmoke(browserContext, smokeServer.baseUrl);
    console.log('WASD flight lifecycle smoke passed.');
    await runShadingControllersLifecycleSmoke(browserContext, smokeServer.baseUrl);
    console.log('Shading controllers lifecycle smoke passed.');
    await runAnnotationsDisposeLifecycleSmoke(browserContext, smokeServer.baseUrl);
    console.log('Annotations dispose lifecycle smoke passed.');
    await runCameraPresetsLifecycleSmoke(browserContext, smokeServer.baseUrl);
    console.log('Camera presets lifecycle smoke passed.');
    await runCameraPickLifecycleSmoke(browserContext, smokeServer.baseUrl);
    console.log('Camera pick lifecycle smoke passed.');
    await runFileFlowFailureSmoke(browserContext, smokeServer.baseUrl);
    console.log('File-flow failure smoke passed.');
    await runFileFlowSerializationSmoke(browserContext, smokeServer.baseUrl);
    console.log('File-flow serialization smoke passed.');
    await runImportPipelineQueueSmoke(browserContext, smokeServer.baseUrl);
    console.log('Import pipeline queue smoke passed.');
    await runFileFlowDisposeLifecycleSmoke(browserContext, smokeServer.baseUrl);
    console.log('File-flow dispose lifecycle smoke passed.');
    await runBatchFinalizerDisposeSmoke(browserContext, smokeServer.baseUrl);
    console.log('Batch finalizer dispose smoke passed.');
    await runTextureGalleryLifecycleSmoke(browserContext, smokeServer.baseUrl);
    console.log('Texture gallery lifecycle smoke passed.');
    await runTextureModalStaleEntrySmoke(browserContext, smokeServer.baseUrl);
    console.log('Texture modal stale entry smoke passed.');
    await runTextureReplacementLifecycleSmoke(browserContext, smokeServer.baseUrl);
    console.log('Texture replacement lifecycle smoke passed.');
    await runGlassGeneratedDisplayMaterialSmoke(browserContext, smokeServer.baseUrl);
    console.log('Glass generated display material smoke passed.');
    await runMaterialVisibilityDisplayModeSmoke(browserContext, smokeServer.baseUrl);
    console.log('Material visibility display-mode smoke passed.');
    await runMaterialUndoStackLifecycleSmoke(browserContext, smokeServer.baseUrl);
    console.log('Material undo stack lifecycle smoke passed.');
    await runVisibilitySuppressionPruneSmoke(browserContext, smokeServer.baseUrl);
    console.log('Visibility suppression prune smoke passed.');
    await runCollabRealtimeDisposeSmoke(browserContext, smokeServer.baseUrl);
    console.log('Collab realtime dispose smoke passed.');
    await runCollabInitFailureCleanupSmoke(browserContext, smokeServer.baseUrl);
    console.log('Collab init-failure cleanup smoke passed.');
    await runCollabDeleteQueueDisposeSmoke(browserContext, smokeServer.baseUrl);
    console.log('Collab delete queue dispose smoke passed.');
    await runCameraSyncLifecycleSmoke(browserContext, smokeServer.baseUrl);
    console.log('Camera sync lifecycle smoke passed.');
    await runVoiceControllerLifecycleSmoke(browserContext, smokeServer.baseUrl);
    console.log('Voice controller lifecycle smoke passed.');
    await runVRDisposeLifecycleSmoke(browserContext, smokeServer.baseUrl);
    console.log('VR dispose lifecycle smoke passed.');
    await runRoomLoadAbortRegistrySmoke(browserContext, smokeServer.baseUrl);
    console.log('Room load abort registry smoke passed.');
    await runRoomModelLoadQueueSmoke(browserContext, smokeServer.baseUrl);
    console.log('Room model load queue smoke passed.');
    await runRoomModelStateSmoke(browserContext, smokeServer.baseUrl);
    console.log('Room model state smoke passed.');
    await runDeferredRealtimeReloadSmoke(browserContext, smokeServer.baseUrl);
    console.log('Deferred realtime reload smoke passed.');
    await runAuxRealtimeChannelRegistrySmoke(browserContext, smokeServer.baseUrl);
    console.log('Aux realtime channel registry smoke passed.');
    await runAbortableTusUploadSmoke(browserContext, smokeServer.baseUrl);
    console.log('Abortable TUS upload smoke passed.');
    await runWorkerLifecycleSmoke(browserContext, smokeServer.baseUrl);
    console.log('Worker lifecycle smoke passed.');
    await runWorkerClientDisposeSmoke(browserContext, smokeServer.baseUrl);
    console.log('Worker client dispose smoke passed.');
    await runZIPFallbackCleanupSmoke(browserContext, smokeServer.baseUrl);
    console.log('ZIP fallback cleanup smoke passed.');
    await runGeoJsonMetaLifecycleSmoke(browserContext, smokeServer.baseUrl);
    console.log('GeoJSON meta lifecycle smoke passed.');
    await runFBXCleanupLifecycleSmoke(browserContext, smokeServer.baseUrl);
    console.log('FBX cleanup lifecycle smoke passed.');
    await runGLTFExportCleanupSmoke(browserContext, smokeServer.baseUrl);
    console.log('GLTF export cleanup smoke passed.');
    await runVPMAutobindLifecycleSmoke(browserContext, smokeServer.baseUrl);
    console.log('VPM autobind lifecycle smoke passed.');
    await runEnvironmentLifecycleSmoke(browserContext, smokeServer.baseUrl);
    console.log('Environment lifecycle smoke passed.');
    await runMosParcelsLifecycleSmoke(browserContext, smokeServer.baseUrl);
    console.log('MOS parcels lifecycle smoke passed.');
    await runMaterialsPanelRemovalSmoke(browserContext, smokeServer.baseUrl);
    console.log('Materials panel removal smoke passed.');
    await runCustomSelectLifecycleSmoke(browserContext, smokeServer.baseUrl);
    console.log('Custom select lifecycle smoke passed.');
    await runAppbarControllersDisposeSmoke(browserContext, smokeServer.baseUrl);
    console.log('Appbar/layout dispose smoke passed.');
    await runLightControlsDisposeSmoke(browserContext, smokeServer.baseUrl);
    console.log('Light controls dispose smoke passed.');
    await runTransientStatusSmoke(browserContext, smokeServer.baseUrl);
    console.log('Transient status smoke passed.');
    await runModalControllersDisposeSmoke(browserContext, smokeServer.baseUrl);
    console.log('Modal controllers dispose smoke passed.');
    await runStatusUIDisposeSmoke(browserContext, smokeServer.baseUrl);
    console.log('Status UI dispose smoke passed.');
} finally {
    await browserContext.close();
    await browser.close();
    await smokeServer.close();
}
