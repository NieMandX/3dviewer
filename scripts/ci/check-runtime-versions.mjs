import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));

async function readProjectFile(path) {
    return readFile(join(projectRoot, path), 'utf8');
}

const [indexHtml, fbxWorker, zipWorker, supabaseClient, smokeViewer, tusClient, livekitBrowser] = await Promise.all([
    readProjectFile('index.html'),
    readProjectFile('scripts/fbx-worker.js'),
    readProjectFile('scripts/zip-worker.js'),
    readProjectFile('scripts/modules/collab/supabase-client.js'),
    readProjectFile('scripts/ci/smoke-viewer.mjs'),
    readProjectFile('scripts/modules/collab/tus-client.js'),
    readProjectFile('scripts/modules/voice/livekit-browser.js'),
]);

const importMapThreeVersion = indexHtml.match(/"three"\s*:\s*"https:\/\/cdn\.jsdelivr\.net\/npm\/three@([^/]+)\/build\/three\.module\.js"/)?.[1] || '';
assert.match(importMapThreeVersion, /^\d+\.\d+\.\d+$/, 'Three import-map version must be exact semver.');
assert.ok(!indexHtml.includes('"three/src/"'), 'Import map must not expose three/src/ alongside build modules.');

const expectedThreeImportMapEntries = new Map([
    ['three', `https://cdn.jsdelivr.net/npm/three@${importMapThreeVersion}/build/three.module.js`],
    ['three/webgpu', `https://cdn.jsdelivr.net/npm/three@${importMapThreeVersion}/build/three.webgpu.js`],
    ['three/tsl', `https://cdn.jsdelivr.net/npm/three@${importMapThreeVersion}/build/three.tsl.js`],
    ['three/addons/', `https://cdn.jsdelivr.net/npm/three@${importMapThreeVersion}/examples/jsm/`],
    ['three/examples/', `https://cdn.jsdelivr.net/npm/three@${importMapThreeVersion}/examples/`],
]);

for (const [specifier, url] of expectedThreeImportMapEntries.entries()) {
    assert.ok(
        indexHtml.includes(`"${specifier}": "${url}"`),
        `Index import map missing exact ${specifier} -> ${url}`
    );
}

for (const specifier of expectedThreeImportMapEntries.keys()) {
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

const meshBvhVersion = indexHtml.match(/"three-mesh-bvh"\s*:\s*"https:\/\/cdn\.jsdelivr\.net\/npm\/three-mesh-bvh@([^/]+)\/build\/index\.module\.js"/)?.[1] || '';
assert.match(meshBvhVersion, /^\d+\.\d+\.\d+$/, 'three-mesh-bvh import-map version must be exact semver.');
const expectedMeshBvhUrl = `https://cdn.jsdelivr.net/npm/three-mesh-bvh@${meshBvhVersion}/build/index.module.js`;
assert.ok(
    smokeViewer.includes(`"three-mesh-bvh": "${expectedMeshBvhUrl}"`),
    `Smoke blank import map missing exact three-mesh-bvh -> ${expectedMeshBvhUrl}`
);
const meshBvhVersions = [
    ...indexHtml.matchAll(/three-mesh-bvh@([^/"']+)/g),
    ...smokeViewer.matchAll(/three-mesh-bvh@([^/"']+)/g),
].map((match) => match[1]);
assert.ok(meshBvhVersions.length > 0, 'No three-mesh-bvh CDN versions found.');
const uniqueMeshBvhVersions = [...new Set(meshBvhVersions)];
assert.deepEqual(
    uniqueMeshBvhVersions,
    [meshBvhVersion],
    `three-mesh-bvh CDN version drift: ${uniqueMeshBvhVersions.join(', ')}`
);

const supabaseVersion = supabaseClient.match(/@supabase\/supabase-js@([^/]+)\//)?.[1] || '';
assert.match(supabaseVersion, /^\d+\.\d+\.\d+$/, 'Supabase CDN version must be exact semver, not a floating tag.');

const jszipVersions = [
    indexHtml.match(/cdnjs\.cloudflare\.com\/ajax\/libs\/jszip\/([^/]+)\/jszip\.min\.js/)?.[1] || '',
    zipWorker.match(/jszip@([^/]+)\/\+esm/)?.[1] || '',
].filter(Boolean);
assert.equal(jszipVersions.length, 2, 'JSZip CDN versions must be present in index.html and zip-worker.js.');
const uniqueJszipVersions = [...new Set(jszipVersions)];
assert.equal(uniqueJszipVersions.length, 1, `JSZip CDN version drift: ${uniqueJszipVersions.join(', ')}`);
assert.match(uniqueJszipVersions[0], /^\d+\.\d+\.\d+$/, 'JSZip CDN version must be exact semver, not a floating tag.');

const tusVersions = [...tusClient.matchAll(/tus-js-client@([^/]+)\//g)].map((match) => match[1]);
assert.ok(tusVersions.length > 0, 'No tus-js-client CDN version found.');
const uniqueTusVersions = [...new Set(tusVersions)];
assert.equal(uniqueTusVersions.length, 1, `tus-js-client CDN version drift: ${uniqueTusVersions.join(', ')}`);
assert.match(uniqueTusVersions[0], /^\d+\.\d+\.\d+$/, 'tus-js-client CDN version must be exact semver, not a floating tag.');

const livekitVersion = livekitBrowser.match(/livekit-client@([^/]+)\//)?.[1] || '';
assert.match(livekitVersion, /^\d+\.\d+\.\d+$/, 'livekit-client CDN version must be exact semver, not a floating tag.');

console.log(`Runtime CDN versions OK: three@${importMapThreeVersion}, three-mesh-bvh@${meshBvhVersion}, @supabase/supabase-js@${supabaseVersion}, jszip@${uniqueJszipVersions[0]}, tus-js-client@${uniqueTusVersions[0]}, livekit-client@${livekitVersion}`);
