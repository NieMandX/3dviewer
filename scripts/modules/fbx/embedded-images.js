function basename(path) {
    const s = String(path || '');
    const parts = s.split(/[\\/]/);
    return parts[parts.length - 1] || '';
}

function isBinaryFBX(arrayBuffer) {
    const sig = new Uint8Array(arrayBuffer, 0, 23);
    const magic = 'Kaydara FBX Binary  \0';
    for (let i = 0; i < magic.length; i++) {
        if (sig[i] !== magic.charCodeAt(i)) return false;
    }
    return true;
}

export function sniffImage(u8) {
    let mime = 'application/octet-stream';
    if (u8 && u8.length >= 12) {
        if (u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47) mime = 'image/png';
        else if (u8[0] === 0xff && u8[1] === 0xd8) mime = 'image/jpeg';
        else if (u8[0] === 0x47 && u8[1] === 0x49 && u8[2] === 0x46) mime = 'image/gif';
        else if (u8[0] === 0x52 && u8[1] === 0x49 && u8[2] === 0x46 && u8[8] === 0x57 && u8[9] === 0x45) mime = 'image/webp';
    }
    return { mime };
}

export async function extractImagesFromFBX(arrayBuffer) {
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
            const url = URL.createObjectURL(new Blob([bin], { type: mime }));
            const vid = videos[idx++] || {};
            const filePath = vid.filePath || `embedded_${out.length}.${mime.split('/')[1] || 'img'}`;
            const short = basename(filePath).toLowerCase();
            out.push({ short, url, full: filePath, mime, source: 'embedded' });
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
        const propsLen = readLen(offset);
        offset += is64 ? 8 : 4;
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
        const url = URL.createObjectURL(new Blob([content], { type: mime }));
        const short = basename(filePath || `embedded_${out.length}.${mime.split('/')[1] || 'img'}`).toLowerCase();
        out.push({ short, url, full: filePath || short, mime, source: 'embedded' });
    }
    return out;
}

