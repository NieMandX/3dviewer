import { extractImagesFromFBXToBuffers, sniffImage } from './embedded-images-core.js';

export { sniffImage };

export async function extractImagesFromFBX(arrayBuffer) {
    const entries = await extractImagesFromFBXToBuffers(arrayBuffer);
    const out = [];
    for (const entry of entries) {
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
    return out;
}
