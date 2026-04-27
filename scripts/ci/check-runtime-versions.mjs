import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));

async function readProjectFile(path) {
    return readFile(join(projectRoot, path), 'utf8');
}

const [indexHtml, fbxWorker, supabaseClient] = await Promise.all([
    readProjectFile('index.html'),
    readProjectFile('scripts/fbx-worker.js'),
    readProjectFile('scripts/modules/collab/supabase-client.js'),
]);

const importMapThreeVersion = indexHtml.match(/"three"\s*:\s*"https:\/\/cdn\.jsdelivr\.net\/npm\/three@([^/]+)\/build\/three\.module\.js"/)?.[1] || '';
assert.match(importMapThreeVersion, /^\d+\.\d+\.\d+$/, 'Three import-map version must be exact semver.');
assert.ok(!indexHtml.includes('"three/src/"'), 'Import map must not expose three/src/ alongside build modules.');

const threeVersions = [
    ...indexHtml.matchAll(/three@([^/"']+)/g),
    ...fbxWorker.matchAll(/three@([^/"']+)/g),
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

console.log(`Runtime CDN versions OK: three@${importMapThreeVersion}, @supabase/supabase-js@${supabaseVersion}`);
