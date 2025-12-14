const FBX_LOADER_MODULE = 'https://cdn.jsdelivr.net/npm/three@0.180.0/examples/jsm/loaders/FBXLoader.js?module';

let FBXLoaderCtor = null;

async function ensureLoader() {
    if (!FBXLoaderCtor) {
        FBXLoaderCtor = (await import(FBX_LOADER_MODULE)).FBXLoader;
    }
}

function basename(path) {
    const s = String(path || '');
    const parts = s.split(/[\\/]/);
    return parts[parts.length - 1] || '';
}

function sniffImage(u8) {
    let mime = 'application/octet-stream';
    if (u8 && u8.length >= 12) {
        if (u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47) mime = 'image/png';
        else if (u8[0] === 0xff && u8[1] === 0xd8) mime = 'image/jpeg';
        else if (u8[0] === 0x47 && u8[1] === 0x49 && u8[2] === 0x46) mime = 'image/gif';
        else if (u8[0] === 0x52 && u8[1] === 0x49 && u8[2] === 0x46 && u8[8] === 0x57 && u8[9] === 0x45) mime = 'image/webp';
    }
    return { mime };
}

function isBinaryFBX(arrayBuffer) {
    const sig = new Uint8Array(arrayBuffer, 0, 23);
    const magic = 'Kaydara FBX Binary  \0';
    for (let i = 0; i < magic.length; i++) {
        if (sig[i] !== magic.charCodeAt(i)) return false;
    }
    return true;
}

async function extractImagesFromFBX(arrayBuffer) {
    return isBinaryFBX(arrayBuffer)
        ? extractEmbeddedImagesFromFBX_binary(arrayBuffer)
        : extractEmbeddedImagesFromFBX_ascii(arrayBuffer);
}

async function extractEmbeddedImagesFromFBX_ascii(arrayBuffer) {
    const text = new TextDecoder('latin1').decode(new Uint8Array(arrayBuffer));
    const videos = [];
    const rxVideo = /Video::([^,\"\s]+)[^{]*?(?:FileName|RelativeFilename)\s*:\s*\"([^\"]+)\"/gi;
    let mv;
    while ((mv = rxVideo.exec(text))) videos.push({ nameInFbx: mv[1], filePath: mv[2] });

    const out = [];
    const rxContent = /Content\s*:\s*,/g;
    let mc;
    let idx = 0;
    while ((mc = rxContent.exec(text))) {
        const start = mc.index + mc[0].length;
        const chunk = text.slice(start, start + 8_000_000);
        const b64m = chunk.match(/([A-Za-z0-9+\/=\r\n]{800,})/);
        if (!b64m) continue;
        const b64 = b64m[1].replace(/\s+/g, '');
        try {
            const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
            const { mime } = sniffImage(bin);
            const vid = videos[idx++] || {};
            const filePath = vid.filePath || `embedded_${out.length}.${mime.split('/')[1] || 'img'}`;
            const short = basename(filePath).toLowerCase();
            out.push({
                short,
                full: filePath,
                mime,
                buffer: bin.buffer,
            });
        } catch {
            // ignore decode errors
        }
    }
    return out;
}

function extractEmbeddedImagesFromFBX_binary(arrayBuffer) {
    const view = new DataView(arrayBuffer);
    const version = view.getUint32(23, true);
    const is64 = version >= 7500;
    const u8 = new Uint8Array(arrayBuffer);
    const td = new TextDecoder('utf-8');

    const u32 = (o) => view.getUint32(o, true);
    const u64 = (o) => {
        const low = view.getUint32(o, true);
        const high = view.getUint32(o + 4, true);
        return high * 0x100000000 + low;
    };
    const readLen = (o) => (is64 ? u64(o) : u32(o));

    function readNode(offset) {
        const endOffset = readLen(offset);
        offset += is64 ? 8 : 4;
        const numProps = readLen(offset);
        offset += is64 ? 8 : 4;
        offset += is64 ? 8 : 4; // propsLen
        const nameLen = view.getUint8(offset);
        offset += 1;
        if (endOffset === 0) return { nextOffset: endOffset, nullRecord: true };

        const name = td.decode(u8.subarray(offset, offset + nameLen));
        offset += nameLen;
        const props = [];

        for (let i = 0; i < numProps; i++) {
            const t = String.fromCharCode(view.getUint8(offset));
            offset += 1;
            if (t === 'S' || t === 'R') {
                const len = u32(offset);
                offset += 4;
                const data = u8.subarray(offset, offset + len);
                offset += len;
                props.push({ type: t, data });
            } else if (t === 'Y') {
                offset += 2;
                props.push({ type: t });
            } else if (t === 'C') {
                offset += 1;
                props.push({ type: t });
            } else if (t === 'I') {
                offset += 4;
                props.push({ type: t });
            } else if (t === 'F') {
                offset += 4;
                props.push({ type: t });
            } else if (t === 'D') {
                offset += 8;
                props.push({ type: t });
            } else if (t === 'L') {
                offset += 8;
                props.push({ type: t });
            } else if ('bcdfil'.includes(t)) {
                const arrayLen = u32(offset);
                offset += 4;
                const encoding = u32(offset);
                offset += 4;
                const compLen = u32(offset);
                offset += 4;
                if (encoding === 0) {
                    const elemSize =
                        t === 'd' || t === 'D'
                            ? 8
                            : t === 'l' || t === 'L' || t === 'i' || t === 'I'
                              ? 4
                              : t === 'f' || t === 'F'
                                ? 4
                                : 1;
                    offset += arrayLen * elemSize;
                } else {
                    offset += compLen;
                }
                props.push({ type: t, array: true });
            } else {
                return { name, props, children: [], nextOffset: endOffset };
            }
        }

        const children = [];
        while (offset < endOffset) {
            const child = readNode(offset);
            if (child.nullRecord) {
                offset = is64 ? offset + 25 : offset + 13;
                break;
            }
            children.push(child);
            offset = child.nextOffset;
        }
        return { name, props, children, nextOffset: endOffset };
    }

    let offset = 27;
    const top = [];
    while (offset < arrayBuffer.byteLength) {
        const node = readNode(offset);
        if (!node || node.nullRecord) break;
        top.push(node);
        offset = node.nextOffset || offset + 1;
    }

    const videos = [];
    (function visit(n) {
        if (!n) return;
        if (Array.isArray(n)) return n.forEach(visit);
        if (n.name === 'Video') videos.push(n);
        if (n.children) n.children.forEach(visit);
    })(top);

    const out = [];
    for (const vid of videos) {
        let filePath = null;
        let content = null;
        const stack = [...(vid.children || [])];
        while (stack.length) {
            const c = stack.shift();
            if (!c) continue;
            if (c.name === 'FileName' || c.name === 'RelativeFilename') {
                const p = c.props?.[0];
                if (p && p.type === 'S') filePath = new TextDecoder('utf-8').decode(p.data).replace(/\0/g, '');
            }
            if (c.name === 'Content') {
                const p = c.props?.[0];
                if (p && p.type === 'R') content = p.data;
            }
            if (c.children) stack.push(...c.children);
        }

        if (!content) continue;

        const { mime } = sniffImage(content);
        const short = basename(filePath || `embedded_${out.length}.${mime.split('/')[1] || 'img'}`).toLowerCase();
        const copied = content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength);
        out.push({
            short,
            full: filePath || short,
            mime,
            buffer: copied,
        });
    }
    return out;
}

function readFBXOrientationFromTree(tree) {
    if (!tree) return null;
    const targetKeys = ['UpAxis', 'UpAxisSign', 'FrontAxis', 'FrontAxisSign', 'CoordAxis', 'CoordAxisSign'];
    const found = {};

    const extractNumeric = (value) => {
        if (value == null) return null;
        if (typeof value === 'number') return value;
        if (typeof value === 'string') {
            const parsed = parseInt(value, 10);
            return Number.isFinite(parsed) ? parsed : null;
        }
        if (Array.isArray(value)) {
            for (const item of value) {
                const extracted = extractNumeric(item);
                if (extracted != null) return extracted;
            }
            return null;
        }
        if (typeof value === 'object') {
            if ('value' in value) return extractNumeric(value.value);
            for (const k of Object.keys(value)) {
                if (k === 'type' || k === 'name') continue;
                const extracted = extractNumeric(value[k]);
                if (extracted != null) return extracted;
            }
        }
        return null;
    };

    const visit = (node) => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) {
            node.forEach(visit);
            return;
        }
        for (const key of targetKeys) {
            if (found[key] == null && key in node) {
                const value = extractNumeric(node[key]);
                if (value != null) found[key] = value;
            }
        }
        for (const value of Object.values(node)) {
            visit(value);
        }
    };

    visit(tree);

    if (targetKeys.every((key) => found[key] == null)) return null;

    const axisNames = ['X', 'Y', 'Z'];
    const makePart = (index, sign) => {
        if (index == null) return null;
        const axis = axisNames[index] ?? `Axis${index}`;
        const signValue = Number.isFinite(sign) ? sign : 1;
        const signSymbol = signValue >= 0 ? '+' : '-';
        return { index, axis, sign: signValue, symbol: signSymbol };
    };

    return {
        up: makePart(found.UpAxis, found.UpAxisSign),
        front: makePart(found.FrontAxis, found.FrontAxisSign),
        coord: makePart(found.CoordAxis, found.CoordAxisSign),
        raw: found,
        source: 'tree',
    };
}

self.onmessage = async (event) => {
    const { id, buffer, features } = event.data || {};
    if (id == null || !buffer) return;

    try {
        await ensureLoader();
        const loader = new FBXLoaderCtor();
        const start = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        let obj = loader.parse(buffer, '');
        const end = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        const json = obj.toJSON();
        obj = null;
        const duration = end - start;

        const wantEmbedded = features?.embedded !== false;
        const wantOrientation = features?.orientation !== false;

        const orientation = wantOrientation ? readFBXOrientationFromTree(loader?.fbxTree) : null;
        const embedded = wantEmbedded ? await extractImagesFromFBX(buffer) : [];

        const transfer = [];
        for (const entry of embedded) {
            if (entry?.buffer instanceof ArrayBuffer) transfer.push(entry.buffer);
        }

        self.postMessage({ id, ok: true, json, duration, embedded, orientation }, transfer);
    } catch (err) {
        self.postMessage({ id, ok: false, error: err?.message || String(err) });
    }
};
