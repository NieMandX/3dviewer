import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const RELEASE_ASSET_BASE_MARKER = '<!-- RELEASE_ASSET_BASE -->';

export function buildReleaseHtml(html, buildId) {
    assert.match(buildId, /^\d+\.\d+(?:\.\d+)?-[a-f0-9]{7,40}$/, 'Use <version>-<Git SHA> as the build ID.');
    assert.equal(html.split(RELEASE_ASSET_BASE_MARKER).length, 2, 'Expected one release asset base marker.');
    assert.ok(!/<base\b/i.test(html), 'Release HTML must not already have a base URL.');
    const markerIndex = html.indexOf(RELEASE_ASSET_BASE_MARKER);
    const firstResource = html.search(/<(?:link|script)\b/i);
    assert.ok(firstResource === -1 || markerIndex < firstResource, 'Release base must precede every resource.');
    return html.replace(RELEASE_ASSET_BASE_MARKER,
        `<base href="/_viewer/${buildId}/" />\n    <meta name="application-build" content="${buildId}" />`);
}

export async function prepareViewerRelease(directory, buildId) {
    const indexPath = join(directory, 'index.html');
    const versionPath = join(directory, 'version.json');
    const release = JSON.parse(await readFile(versionPath, 'utf8'));
    assert.ok(buildId.startsWith(`${release.version}-`), 'Build ID must match the viewer version.');
    const html = buildReleaseHtml(await readFile(indexPath, 'utf8'), buildId);
    await writeFile(indexPath, html);
    await writeFile(versionPath, `${JSON.stringify({ ...release, buildId }, null, 2)}\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
    const [, , directory, buildId] = process.argv;
    assert.ok(directory && buildId, 'Usage: node prepare-viewer-release.mjs <extracted-release-dir> <version>-<Git SHA>');
    await prepareViewerRelease(resolve(directory), buildId);
    console.log(`Prepared immutable viewer asset URLs: /_viewer/${buildId}/`);
}
