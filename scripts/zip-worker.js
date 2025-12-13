import JSZip from 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm';

function basename(path) {
    const s = String(path || '');
    const parts = s.split(/[\\/]/);
    return parts[parts.length - 1] || '';
}

function mimeFromName(name) {
    const n = String(name || '').toLowerCase();
    if (n.endsWith('.png')) return 'image/png';
    if (n.endsWith('.jpg') || n.endsWith('.jpeg')) return 'image/jpeg';
    if (n.endsWith('.webp')) return 'image/webp';
    if (n.endsWith('.gif')) return 'image/gif';
    return 'application/octet-stream';
}

const ackWaiters = new Map();

function ackKey(id, seq) {
    return `${id}:${seq}`;
}

function waitForAck(id, seq) {
    const key = ackKey(id, seq);
    const pending = ackWaiters.get(key);
    if (pending) return pending.promise;
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    const entry = { promise, resolve, reject };
    ackWaiters.set(key, entry);
    return promise;
}

function resolveAck(id, seq) {
    const key = ackKey(id, seq);
    const entry = ackWaiters.get(key);
    if (!entry) return false;
    ackWaiters.delete(key);
    entry.resolve();
    return true;
}

self.onmessage = async (event) => {
    const msg = event.data || {};

    if (msg.type === 'ack') {
        resolveAck(msg.id, msg.seq);
        return;
    }

    const { id, buffer, zipName } = msg;
    if (id == null || !buffer) return;

    let seq = 0;

    try {
        const zip = await JSZip.loadAsync(buffer);
        const entries = Object.values(zip.files || {}).filter((e) => e && !e.dir);

        const fbxEntries = entries.filter((e) => /\.fbx$/i.test(e.name));
        const imageEntries = entries.filter((e) => /\.(png|jpe?g|webp)$/i.test(e.name));
        const geoEntries = entries.filter((e) => /\.geojson$/i.test(e.name));

        self.postMessage({
            id,
            type: 'meta',
            zipName: zipName || '',
            counts: { fbx: fbxEntries.length, images: imageEntries.length, geojson: geoEntries.length },
        });

        if (geoEntries.length) {
            const geoEntry = geoEntries[0];
            const bytes = await geoEntry.async('uint8array');
            let geoText = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
            geoText = geoText.replace(/^\uFEFF/, '');
            self.postMessage({
                id,
                type: 'geojson',
                name: geoEntry.name,
                text: geoText,
            });
        }

        for (let i = 0; i < fbxEntries.length; i++) {
            const entry = fbxEntries[i];
            self.postMessage({
                id,
                type: 'progress',
                phase: 'fbx',
                index: i + 1,
                total: fbxEntries.length,
                name: entry.name,
            });
            const blob = await entry.async('blob');
            const typed = blob.slice(0, blob.size, 'model/fbx');
            seq++;
            const waitAck = waitForAck(id, seq);
            self.postMessage(
                {
                    id,
                    type: 'fbx',
                    seq,
                    index: i + 1,
                    total: fbxEntries.length,
                    name: entry.name,
                    fileName: basename(entry.name),
                    blob: typed,
                },
            );
            await waitAck;
        }

        for (let i = 0; i < imageEntries.length; i++) {
            const entry = imageEntries[i];
            self.postMessage({
                id,
                type: 'progress',
                phase: 'image',
                index: i + 1,
                total: imageEntries.length,
                name: entry.name,
            });
            const blob = await entry.async('blob');
            const mime = mimeFromName(entry.name);
            const typed = blob.slice(0, blob.size, mime);
            seq++;
            const waitAck = waitForAck(id, seq);
            self.postMessage(
                {
                    id,
                    type: 'image',
                    seq,
                    index: i + 1,
                    total: imageEntries.length,
                    name: entry.name,
                    fileName: basename(entry.name),
                    mime,
                    blob: typed,
                },
            );
            await waitAck;
        }

        self.postMessage({ id, type: 'done' });
    } catch (err) {
        self.postMessage({ id, type: 'error', error: err?.message || String(err) });
    } finally {
        // cleanup: prevent leaks if main never acks
        if (seq > 0) {
            for (let s = 1; s <= seq; s++) {
                const key = ackKey(id, s);
                ackWaiters.delete(key);
            }
        }
    }
};
