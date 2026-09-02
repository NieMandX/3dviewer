import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { buildReleaseHtml, RELEASE_ASSET_BASE_MARKER } from '../deploy/prepare-viewer-release.mjs';

const buildIds = ['0.95-aaaaaaa', '0.95-bbbbbbb'];
const sourceHtml = await readFile(new URL('../../index.html', import.meta.url), 'utf8');
assert.ok(buildReleaseHtml(sourceHtml, buildIds[0]).includes(`<base href="/_viewer/${buildIds[0]}/" />`));
assert.throws(() => buildReleaseHtml(sourceHtml, '../unsafe'));
assert.throws(() => buildReleaseHtml(sourceHtml.replace(RELEASE_ASSET_BASE_MARKER, ''), buildIds[0]));
assert.throws(() => buildReleaseHtml(sourceHtml.replace(RELEASE_ASSET_BASE_MARKER, '<base href="/" />'), buildIds[0]));

const texturePath = '/scripts/modules/material/texture-utils.js';
const materialPath = '/scripts/modules/material/base-color-policy.js';
const textureModule = await readFile(new URL(`../..${texturePath}`, import.meta.url));
const materialModule = await readFile(new URL(`../..${materialPath}`, import.meta.url));
const requests = [];
let stage = 'seed';
const shell = `<!doctype html><head>${RELEASE_ASSET_BASE_MARKER}
<link rel="stylesheet" href="./styles/viewer.css"><script src="./config/runtime.js"></script></head>
<body><script type="module" src="./scripts/viewer-app.js"></script></body>`;
const entry = `import { getMaterialSourceBaseColor } from './modules/material/base-color-policy.js';
window.releaseCacheReady = typeof getMaterialSourceBaseColor === 'function';
const worker = new Worker(new URL('./cache-worker.js', import.meta.url), { type: 'module' });
worker.onmessage = event => { window.releaseCacheWorker = event.data; worker.terminate(); };`;

// No Playwright routing: interception disables the real browser HTTP cache.
const server = createServer((request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    requests.push(path);
    const prefix = buildIds.map(id => `/_viewer/${id}`).find(value => path.startsWith(`${value}/`));
    const asset = prefix ? path.slice(prefix.length) : path;
    response.setHeader('Cache-Control', prefix ? 'public, max-age=31536000, immutable' : 'no-cache');
    if (path === '/seed.html') {
        response.setHeader('Content-Type', 'text/html');
        response.end(`<script type="module">import * as legacy from '${texturePath}';window.seedExports=Object.keys(legacy);localStorage.setItem('release-cache-auth-sentinel','preserved');</script>`);
    } else if (path === '/index.html') {
        response.setHeader('Content-Type', 'text/html');
        response.end(stage === 'mixed' ? shell : buildReleaseHtml(shell, stage));
    } else if (asset === texturePath) {
        response.setHeader('Content-Type', 'text/javascript');
        if (stage === 'seed') {
            response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
            response.end('export function copyTextureSettings() {}');
        } else response.end(textureModule);
    } else if (asset === materialPath) {
        response.setHeader('Content-Type', 'text/javascript');
        response.end(materialModule);
    } else if (asset === '/scripts/viewer-app.js') {
        response.setHeader('Content-Type', 'text/javascript');
        response.end(entry);
    } else if (asset === '/scripts/cache-worker.js') {
        response.setHeader('Content-Type', 'text/javascript');
        response.end(`import { resolveEditableMaterialState } from './modules/material/texture-utils.js';postMessage(typeof resolveEditableMaterialState);`);
    } else if (asset === '/config/runtime.js') {
        response.setHeader('Content-Type', 'text/javascript');
        response.end('window.releaseCacheRuntime = document.currentScript.src;');
    } else if (asset === '/styles/viewer.css') {
        response.setHeader('Content-Type', 'text/css');
        response.end('body { color: rgb(12, 34, 56); }');
    } else {
        response.writeHead(404).end();
    }
});

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/seed.html`);
    await page.waitForFunction(() => window.seedExports);
    assert.deepEqual(await page.evaluate(() => window.seedExports), ['copyTextureSettings']);

    stage = 'mixed';
    await page.goto(`${origin}/index.html?project=keep&room=keep`);
    await page.waitForFunction(() => !window.releaseCacheReady);
    assert.ok(errors.some(error => error.includes("does not provide an export named 'resolveEditableMaterialState'")), 'Old cache must reproduce the reported missing-export failure.');
    assert.equal(requests.filter(path => path === texturePath).length, 1, 'Legacy module should be reused from HTTP cache, not fetched again.');
    console.log('Reproduced 0.9 cached-module / 0.95 HTML startup failure.');

    for (const buildId of buildIds) {
        stage = buildId;
        errors.length = 0;
        // Normal navigation, without disabling/clearing cache or removing saved sessions.
        await page.goto(`${origin}/index.html?project=keep&room=keep`);
        await page.waitForFunction(() => window.releaseCacheReady && window.releaseCacheWorker === 'function');
        assert.deepEqual(errors, []);
        assert.equal(page.url(), `${origin}/index.html?project=keep&room=keep`);
        assert.equal(await page.evaluate(() => localStorage.getItem('release-cache-auth-sentinel')), 'preserved');
        assert.equal(await page.evaluate(() => window.releaseCacheRuntime), `${origin}/_viewer/${buildId}/config/runtime.js`);
        assert.equal(await page.evaluate(() => getComputedStyle(document.body).color), 'rgb(12, 34, 56)');
        for (const asset of [texturePath, materialPath, '/scripts/cache-worker.js', '/styles/viewer.css']) {
            assert.ok(requests.includes(`/_viewer/${buildId}${asset}`), `Versioned asset not requested: ${asset}`);
        }
    }
    assert.equal(requests.filter(path => path === texturePath).length, 1);
    console.log('Release cache smoke passed: nested imports, worker, CSS, runtime, session and room URL retained across two releases.');
} finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
}
