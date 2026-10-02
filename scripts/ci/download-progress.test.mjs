import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { fetchModelBlob, formatDownloadProgress } from '../modules/io/download-progress.js';

test('model download reports real bytes, unknown lengths, decoding, cancellation and errors', async () => {
    const payload = Buffer.alloc(16000, 42);
    const server = createServer((req, res) => {
        if (req.url === '/denied') { res.writeHead(403).end(); return; }
        if (req.url === '/gzip') {
            const compressed = gzipSync(payload);
            res.writeHead(200, { 'content-encoding': 'gzip', 'content-length': compressed.length });
            res.end(compressed);
            return;
        }
        res.setHeader('content-type', 'model/gltf-binary');
        if (req.url === '/known') res.setHeader('content-length', payload.length);
        let offset = 0;
        const timer = setInterval(() => {
            res.write(payload.subarray(offset, offset + 4000));
            offset += 4000;
            if (offset >= payload.length) { clearInterval(timer); res.end(); }
        }, 60);
        res.on('close', () => clearInterval(timer));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        const events = [];
        const blob = await fetchModelBlob(`${base}/known`, { onProgress: value => events.push(value) });
        assert.deepEqual(Buffer.from(await blob.arrayBuffer()), payload);
        assert.equal(blob.type, 'model/gltf-binary');
        assert(events.some(e => e.loaded > 0 && e.loaded < payload.length && e.percent > 0 && e.percent < 100));
        assert.equal(events.at(-1).percent, 100);
        assert.equal(events.at(-1).loaded, payload.length);
        for (const [path, size] of [['/unknown', 0], ['/unknown', 16000], ['/unknown', 1000], ['/gzip', 0]]) {
            const progress = [];
            const file = await fetchModelBlob(base + path, { expectedBytes: size, onProgress: e => progress.push(e) });
            assert.equal(file.size, payload.length);
            if (!size) assert.equal(progress[0].percent, null, 'Unknown/compressed length must not invent a percentage');
            if (size === 16000) assert.equal(progress[0].total, size);
            if (size === 1000) assert(progress.some(e => !e.done && e.loaded > size && e.percent === null));
        }
        const controller = new AbortController();
        const aborted = [];
        await assert.rejects(fetchModelBlob(`${base}/known`, {
            signal: controller.signal,
            onProgress: e => { aborted.push(e); if (e.loaded > 0) controller.abort(); },
        }), { name: 'AbortError' });
        assert.equal(aborted.at(-1).done, false, 'Aborted download must not report completion');
        await assert.rejects(fetchModelBlob(`${base}/known`, { signal: controller.signal }), { name: 'AbortError' });
        await assert.rejects(fetchModelBlob(`${base}/denied`), /403/);
        assert.match(formatDownloadProgress({ loaded: 84000000, total: 200000000, percent: 42 }), /42% · 84 из 200 МБ/);
        assert.match(formatDownloadProgress({ loaded: 84000000 }), /^84 МБ$/);
    } finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
});
