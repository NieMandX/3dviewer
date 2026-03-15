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

function attachPageDiagnostics(page) {
    const consoleErrors = [];
    const pageErrors = [];

    page.on('console', (message) => {
        if (message.type() !== 'error') return;
        consoleErrors.push(message.text());
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

    assert.equal(state.appReady, true, 'Boot smoke: viewerApp not initialized');
    assert.equal(state.loading, false, 'Boot smoke: body still in app-loading state');
    assert.equal(state.activeRenderer, 'webgl', 'Boot smoke: unexpected renderer mode');
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
} finally {
    await browser.close();
    await smokeServer.close();
}
