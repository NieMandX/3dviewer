import { extractImagesFromFBXToBuffers, sniffImage } from './embedded-images-core.js';

export { sniffImage };

export function createEmbeddedImageEntriesFromBuffers(entries) {
    const out = [];
    try {
        for (const entry of (Array.isArray(entries) ? entries : [])) {
            if (!entry) continue;
            const buffer = entry.buffer;
            if (!(buffer instanceof ArrayBuffer)) continue;
            const mime = entry.mime || 'application/octet-stream';
            const url = URL.createObjectURL(new Blob([buffer], { type: mime }));
            out.push({
                short: entry.short || '',
                url,
                full: entry.full || entry.short || '',
                mime,
                source: 'embedded',
            });
        }
    } catch (err) {
        out.forEach((entry) => {
            const url = String(entry?.url || '');
            if (!url.startsWith('blob:')) return;
            try {
                URL.revokeObjectURL(url);
            } catch (_) {}
        });
        throw err;
    }
    return out;
}

export async function extractImagesFromFBX(arrayBuffer) {
    const entries = await extractImagesFromFBXToBuffers(arrayBuffer);
    return createEmbeddedImageEntriesFromBuffers(entries);
}
