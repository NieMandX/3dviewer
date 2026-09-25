import { captureMaterialPack, validateMaterialPack, PACK_ASSET, packAbort } from './material-pack.js';

// An uncompressed Blob container: small JSON index followed by PNG blobs.
// No base64 duplication, ZIP expansion or network/CDN dependency is needed.
const MAGIC = 'LPMAT001', HEADER = 12, MAX_JSON = 8 * 1024 * 1024, MAX_ASSETS = 512 * 1024 * 1024;
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
const sha256 = async (blob) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].map((n) => n.toString(16).padStart(2, '0')).join('');

export async function saveMaterialPackFile(entries, options = {}) {
    const assets = [], blobs = []; let offset = 0;
    const pack = await captureMaterialPack(entries, { ...options, writeAsset: async (path, blob) => {
        assets.push({ path, offset, size: blob.size }); blobs.push(blob); offset += blob.size;
    } });
    const json = encoder.encode(JSON.stringify({ pack, assets }));
    if (json.length > MAX_JSON) throw Error('Описание набора превышает 8 МБ.');
    const header = new Uint8Array(HEADER); header.set(encoder.encode(MAGIC));
    new DataView(header.buffer).setUint32(8, json.length, true);
    if (options.isCurrent && !options.isCurrent()) throw packAbort();
    return new Blob([header, json, ...blobs], { type: 'application/octet-stream' });
}

export async function openMaterialPackFile(file, { isCurrent = () => true } = {}) {
    const check = () => { if (!isCurrent()) throw packAbort(); };
    if (!(file instanceof Blob) || file.size < HEADER || file.size > HEADER + MAX_JSON + MAX_ASSETS) throw Error('Недопустимый размер файла набора.');
    const header = await file.slice(0, HEADER).arrayBuffer(); check();
    if (decoder.decode(new Uint8Array(header, 0, 8)) !== MAGIC) throw Error('Выберите файл набора материалов .lpmat.');
    const size = new DataView(header).getUint32(8, true), start = HEADER + size;
    if (!size || size > MAX_JSON || start > file.size) throw Error('Повреждён заголовок набора.');
    const { pack, assets } = JSON.parse(decoder.decode(await file.slice(HEADER, start).arrayBuffer())); check();
    validateMaterialPack(pack);
    if (!Array.isArray(assets) || assets.length > 4096 * 23) throw Error('Повреждён список текстур.');
    const index = new Map(); let end = 0;
    for (const asset of assets) {
        if (!PACK_ASSET.test(asset?.path || '') || index.has(asset.path) || asset.offset !== end || !Number.isSafeInteger(asset.size) || asset.size < 24 || asset.size > 32 * 1024 * 1024) throw Error('Повреждена запись текстуры.');
        end += asset.size; index.set(asset.path, asset);
    }
    if (start + end !== file.size || end > MAX_ASSETS || pack.textureCount !== assets.length || pack.textureBytes !== end) throw Error('Набор неполный или повреждён.');
    for (const m of pack.materials) {
        const paths = Object.values(m.maps || {}).filter(Boolean).map((v) => v.asset);
        if (m.water) paths.push(m.water.flowAsset);
        if (paths.some((path) => !index.has(path))) throw Error('В наборе отсутствует текстура.');
    }
    const checked = new Set();
    return { pack, async loadAsset(path) {
        check(); const asset = index.get(path); if (!asset) throw Error('Текстура не найдена в файле.');
        const blob = file.slice(start + asset.offset, start + asset.offset + asset.size, 'image/png');
        if (!checked.has(path)) {
            const bytes = new Uint8Array(await blob.slice(0, 24).arrayBuffer()), view = new DataView(bytes.buffer);
            if (view.getUint32(0) !== 0x89504e47 || view.getUint32(4) !== 0x0d0a1a0a || view.getUint32(12) !== 0x49484452 || !view.getUint32(16) || !view.getUint32(20) || view.getUint32(16) > 8192 || view.getUint32(20) > 8192 || `textures/${await sha256(blob)}.png` !== path) throw Error('Текстура повреждена или слишком велика.');
            checked.add(path);
        }
        check(); return blob;
    } };
}
