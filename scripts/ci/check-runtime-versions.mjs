import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));

async function readProjectFile(path) {
    return readFile(join(projectRoot, path), 'utf8');
}

const [indexHtml, fbxWorker, supabaseClient, smokeViewer, viewerAppMain] = await Promise.all([
    readProjectFile('index.html'),
    readProjectFile('scripts/fbx-worker.js'),
    readProjectFile('scripts/modules/collab/supabase-client.js'),
    readProjectFile('scripts/ci/smoke-viewer.mjs'),
    readProjectFile('scripts/modules/app/viewer-app-main.js'),
]);

const importMapThreeVersion = indexHtml.match(/"three"\s*:\s*"https:\/\/cdn\.jsdelivr\.net\/npm\/three@([^/]+)\/build\/three\.module\.js"/)?.[1] || '';
assert.match(importMapThreeVersion, /^\d+\.\d+\.\d+$/, 'Three import-map version must be exact semver.');
assert.ok(!indexHtml.includes('"three/src/"'), 'Import map must not expose three/src/ alongside build modules.');

const expectedThreeImportMapEntries = new Map([
    ['three', `https://cdn.jsdelivr.net/npm/three@${importMapThreeVersion}/build/three.module.js`],
    ['three/webgpu', `https://cdn.jsdelivr.net/npm/three@${importMapThreeVersion}/build/three.webgpu.js`],
    ['three/tsl', `https://cdn.jsdelivr.net/npm/three@${importMapThreeVersion}/build/three.tsl.js`],
    ['three/addons/', `https://cdn.jsdelivr.net/npm/three@${importMapThreeVersion}/examples/jsm/`],
]);

for (const [specifier, url] of expectedThreeImportMapEntries.entries()) {
    assert.ok(
        indexHtml.includes(`"${specifier}": "${url}"`),
        `Index import map missing exact ${specifier} -> ${url}`
    );
}

for (const specifier of ['three', 'three/addons/']) {
    const url = expectedThreeImportMapEntries.get(specifier);
    assert.ok(
        smokeViewer.includes(`"${specifier}": "${url}"`),
        `Smoke blank import map missing exact ${specifier} -> ${url}`
    );
}

const threeVersions = [
    ...indexHtml.matchAll(/three@([^/"']+)/g),
    ...fbxWorker.matchAll(/three@([^/"']+)/g),
    ...smokeViewer.matchAll(/three@([^/"']+)/g),
].map((match) => match[1]);

assert.ok(threeVersions.length > 0, 'No Three.js CDN versions found.');
const uniqueThreeVersions = [...new Set(threeVersions)];
assert.deepEqual(
    uniqueThreeVersions,
    [importMapThreeVersion],
    `Three.js CDN version drift: ${uniqueThreeVersions.join(', ')}`
);

const supabaseVersion = supabaseClient.match(/@supabase\/supabase-js@([^/]+)\//)?.[1] || '';
assert.match(supabaseVersion, /^\d+\.\d+\.\d+$/, 'Supabase CDN version must be exact semver, not a floating tag.');

const tusVersions = [...viewerAppMain.matchAll(/tus-js-client@([^/]+)\//g)].map((match) => match[1]);
assert.ok(tusVersions.length > 0, 'No tus-js-client CDN version found.');
const uniqueTusVersions = [...new Set(tusVersions)];
assert.equal(uniqueTusVersions.length, 1, `tus-js-client CDN version drift: ${uniqueTusVersions.join(', ')}`);
assert.match(uniqueTusVersions[0], /^\d+\.\d+\.\d+$/, 'tus-js-client CDN version must be exact semver, not a floating tag.');

console.log(`Runtime CDN versions OK: three@${importMapThreeVersion}, @supabase/supabase-js@${supabaseVersion}, tus-js-client@${uniqueTusVersions[0]}`);
