function downloadBlob(documentRef, blob, filename) {
    const doc = documentRef || (typeof document !== 'undefined' ? document : null);
    if (!doc) return;

    const url = URL.createObjectURL(blob);
    const a = doc.createElement('a');
    a.href = url;
    a.download = filename || 'scene.glb';
    a.style.display = 'none';
    doc.body?.appendChild?.(a);
    a.click();
    a.remove();
    setTimeout(() => {
        try { URL.revokeObjectURL(url); } catch (_) {}
    }, 1000);
}

function normalizeFormat(format) {
    const v = String(format || '').trim().toLowerCase();
    return v === 'gltf' ? 'gltf' : 'glb';
}

function normalizeCoords(coords) {
    const v = String(coords || '').trim().toLowerCase();
    return v === 'msk' ? 'msk' : 'rebased';
}

function makeBaseName({ coords }) {
    const suffix = coords === 'msk' ? 'msk' : 'rebased';
    return `scene_${suffix}`;
}

function makeFilename({ format, coords }) {
    const base = makeBaseName({ coords });
    if (format === 'gltf') return `${base}.gltf.zip`;
    return `${base}.glb`;
}

function cloneWorldForExport(world, coords) {
    const src = world;
    if (!src?.clone) return null;
    const cloned = src.clone(true);
    if (coords === 'msk') {
        cloned.position.set(0, 0, 0);
    }
    cloned.updateMatrixWorld?.(true);
    return cloned;
}

function splitGLB(arrayBuffer) {
    const buf = arrayBuffer;
    const dv = new DataView(buf);

    // GLB header: magic 'glTF' (0x46546C67), version 2, total length
    const magic = dv.getUint32(0, true);
    if (magic !== 0x46546C67) throw new Error('GLB: invalid magic');
    const version = dv.getUint32(4, true);
    if (version !== 2) throw new Error('GLB: unsupported version ' + version);
    const totalLength = dv.getUint32(8, true);

    let offset = 12;
    let jsonChunk = null;
    let binChunk = null;

    while (offset + 8 <= totalLength) {
        const chunkLength = dv.getUint32(offset, true);
        const chunkType = dv.getUint32(offset + 4, true);
        offset += 8;

        const end = offset + chunkLength;
        if (end > buf.byteLength) break;

        const chunkData = buf.slice(offset, end);
        offset = end;

        // chunkType: JSON = 0x4E4F534A, BIN = 0x004E4942
        if (chunkType === 0x4E4F534A) {
            jsonChunk = chunkData;
        } else if (chunkType === 0x004E4942) {
            binChunk = chunkData;
        }
    }

    if (!jsonChunk) throw new Error('GLB: missing JSON chunk');
    if (!binChunk) throw new Error('GLB: missing BIN chunk');

    const jsonText = new TextDecoder().decode(new Uint8Array(jsonChunk));
    const json = JSON.parse(jsonText);
    return { json, binChunk };
}

async function buildGLTFZip({ glbArrayBuffer, baseName, JSZipCtor }) {
    if (!JSZipCtor) throw new Error('GLTF export requires JSZip (missing)');
    const { json, binChunk } = splitGLB(glbArrayBuffer);

    if (!json.buffers || !json.buffers.length) {
        json.buffers = [{ byteLength: binChunk.byteLength }];
    }
    json.buffers[0].uri = `${baseName}.bin`;
    json.buffers[0].byteLength = binChunk.byteLength;

    const zip = new JSZipCtor();
    zip.file(`${baseName}.gltf`, JSON.stringify(json));
    zip.file(`${baseName}.bin`, binChunk);

    return zip.generateAsync({
        type: 'blob',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 },
    });
}

export async function exportWorldAsGLTF(options = {}) {
    const world = options.world || null;
    const documentRef = options.document || (typeof document !== 'undefined' ? document : null);
    const JSZipCtor =
        options.JSZip ||
        (typeof globalThis !== 'undefined' ? globalThis.JSZip : null) ||
        null;

    const format = normalizeFormat(options.format);
    const coords = normalizeCoords(options.coords);
    const baseName = options.baseName || makeBaseName({ coords });
    const filename = options.filename || makeFilename({ format, coords });

    if (!world) throw new Error('exportWorldAsGLTF: world is required');

    const exportRoot = cloneWorldForExport(world, coords);
    if (!exportRoot) throw new Error('exportWorldAsGLTF: failed to clone scene');

    const [{ GLTFExporter }] = await Promise.all([
        import('three/addons/exporters/GLTFExporter.js'),
    ]);

    const exporter = new GLTFExporter();
    const glbArrayBuffer = await new Promise((resolve, reject) => {
        exporter.parse(
            exportRoot,
            resolve,
            reject,
            {
                binary: true,
                onlyVisible: false,
            },
        );
    });

    if (format === 'glb') {
        downloadBlob(documentRef, new Blob([glbArrayBuffer], { type: 'model/gltf-binary' }), filename);
        return { filename, format, coords };
    }

    const zipBlob = await buildGLTFZip({ glbArrayBuffer, baseName, JSZipCtor });
    downloadBlob(documentRef, zipBlob, filename);
    return { filename, format, coords };
}
