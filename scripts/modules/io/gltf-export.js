import { resolveEditableMaterialState } from '../material/texture-utils.js';

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

function createExportAbortError(signal) {
    const reason = signal?.reason;
    if (reason instanceof Error) return reason;
    if (typeof DOMException === 'function') {
        return new DOMException(reason || 'Export aborted', 'AbortError');
    }
    const err = new Error(reason || 'Export aborted');
    err.name = 'AbortError';
    return err;
}

function isExportAbortError(err) {
    return err?.name === 'AbortError';
}

function assertExportNotAborted(signal) {
    if (signal?.aborted) throw createExportAbortError(signal);
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

function shouldSkipObjectForExport(obj) {
    if (!obj || typeof obj !== 'object') return true;
    const ud = obj.userData || null;
    if (ud?.excludeFromExport) return true;
    if (ud?._isBackfaceOverlay) return true;
    if (ud?.lightHelper) return true;
    if (ud?._geoId !== undefined) return true; // wireframe overlay
    if (ud?._angle !== undefined) return true; // beauty wire overlay

    const type = String(obj.type || obj.constructor?.name || '');
    if (type.endsWith('Helper')) return true;

    const name = String(obj.name || '');
    if (name.includes('(wireframe)') || name.includes('(beautywire)')) return true;

    // Line overlays attached to meshes (wireframe / backface debug, etc)
    if ((obj.isLine || obj.isLineSegments) && ud?.excludeFromBounds && obj.parent?.isMesh) return true;

    return (
        !!obj.isHelper ||
        !!obj.isAxesHelper ||
        !!obj.isGridHelper ||
        !!obj.isPolarGridHelper
    );
}

function getExportMaterialForSource(src) {
    if (!src?.material) return null;
    const editableState = resolveEditableMaterialState(src);
    if (editableState.source === 'original' && editableState.originalValue) {
        return editableState.originalValue;
    }
    return src.material;
}

function cloneObject3DFiltered(root, shouldSkipFn) {
    if (!root || typeof root !== 'object') return null;
    if (shouldSkipFn && shouldSkipFn(root)) return null;

    const stack = [{ src: root, parentClone: null }];
    let rootClone = null;

    while (stack.length) {
        const { src, parentClone } = stack.pop();
        if (!src || typeof src !== 'object') continue;
        if (shouldSkipFn && shouldSkipFn(src)) continue;

        let cloned = null;
        try {
            const exportMaterial = getExportMaterialForSource(src);
            // Avoid copying viewer-internal userData into the export clone.
            // (Object3D.copy() deep-copies userData via JSON.stringify, which can be huge/cyclic.)
            const prevUserData = src.userData;
            let didClear = false;
            try {
                if (prevUserData && typeof prevUserData === 'object' && Object.keys(prevUserData).length > 0) {
                    src.userData = {};
                    didClear = true;
                }
                cloned = src.clone(false);
                if (exportMaterial && cloned && 'material' in cloned) {
                    cloned.material = exportMaterial;
                }
                if (cloned && typeof cloned === 'object' && cloned.userData && Object.keys(cloned.userData).length > 0) {
                    cloned.userData = {};
                }
            } finally {
                if (didClear) src.userData = prevUserData;
            }
        } catch (err) {
            console.warn('GLTF export: skipping uncloneable object', src?.type || src?.name || src, err);
            continue;
        }

        if (!rootClone) rootClone = cloned;
        if (parentClone) parentClone.add(cloned);

        const children = Array.isArray(src.children) ? src.children : [];
        for (let i = children.length - 1; i >= 0; i--) {
            stack.push({ src: children[i], parentClone: cloned });
        }
    }

    return rootClone;
}

function cloneWorldForExport(world, coords) {
    const src = world;
    if (!src) return null;

    const cloned = cloneObject3DFiltered(src, shouldSkipObjectForExport);
    if (!cloned) return null;
    if (coords === 'msk') {
        cloned.position.set(0, 0, 0);
    }
    cloned.updateMatrixWorld?.(true);
    return cloned;
}

function sanitizeObject3DTree(root) {
    const start = root;
    if (!start || typeof start !== 'object') return;

    const stack = [start];
    while (stack.length) {
        const obj = stack.pop();
        if (!obj || typeof obj !== 'object') continue;

        if (obj.parent === undefined) obj.parent = null;

        const children = Array.isArray(obj.children) ? obj.children : null;
        if (!children || !children.length) continue;

        for (let i = children.length - 1; i >= 0; i--) {
            const child = children[i];
            if (!child) {
                children.splice(i, 1);
                continue;
            }
            if (child.parent === undefined) child.parent = obj;
            stack.push(child);
        }
    }
}

function bakeLightTargetsForExport(root) {
    const changes = [];
    if (!root || typeof root.traverse !== 'function') return changes;

    root.traverse((obj) => {
        if (!obj || (!obj.isSpotLight && !obj.isDirectionalLight)) return;
        const target = obj.target;
        if (!target) return;

        const lightState = {
            light: obj,
            quaternion: obj.quaternion?.clone?.() || null,
            rotation: obj.rotation?.clone?.() || null,
        };
        const parent = target.parent || null;
        const targetState = {
            target,
            parent,
            index: Array.isArray(parent?.children) ? parent.children.indexOf(target) : -1,
            position: target.position
                ? { x: target.position.x, y: target.position.y, z: target.position.z }
                : null,
        };
        changes.push({ lightState, targetState });

        target.updateWorldMatrix?.(true, false);
        const elements = target.matrixWorld?.elements;
        if (elements && elements.length >= 16) {
            obj.lookAt(elements[12], elements[13], elements[14]);
        } else if (target.position) {
            obj.lookAt(target.position.x, target.position.y, target.position.z);
        }
        obj.updateMatrixWorld?.(true);

        if (target.parent !== obj && typeof obj.add === 'function') {
            obj.add(target);
        }
        if (target.position?.set) target.position.set(0, 0, -1);
        target.updateMatrixWorld?.(true);
    });

    return changes;
}

function restoreBakedLightTargets(changes) {
    const list = Array.isArray(changes) ? changes : [];
    for (const item of list) {
        const light = item?.lightState?.light;
        const quat = item?.lightState?.quaternion;
        const rot = item?.lightState?.rotation;
        if (light && quat && light.quaternion?.copy) light.quaternion.copy(quat);
        if (light && rot && light.rotation?.copy) light.rotation.copy(rot);

        const target = item?.targetState?.target;
        if (!target) continue;

        if (target.parent && target.parent !== item?.targetState?.parent) {
            target.parent.remove?.(target);
        }
        const parent = item?.targetState?.parent;
        if (parent) {
            const index = Number.isFinite(item?.targetState?.index) ? item.targetState.index : -1;
            if (index >= 0 && Array.isArray(parent.children) && index <= parent.children.length) {
                parent.children.splice(index, 0, target);
                target.parent = parent;
            } else {
                parent.add?.(target);
            }
        }

        const pos = item?.targetState?.position;
        if (pos && target.position?.set) {
            target.position.set(pos.x, pos.y, pos.z);
        }
    }
}

async function exportAsGLB(exporter, root) {
    return await new Promise((resolve, reject) => {
        exporter.parse(
            root,
            resolve,
            reject,
            {
                binary: true,
                onlyVisible: false,
                trs: true,
            },
        );
    });
}

function prepareMaterialsForExport(root) {
    if (!root || typeof root.traverse !== 'function') return [];

    const cache = new Map();

    const getPrepared = (mat) => {
        if (!mat || typeof mat !== 'object' || !mat.isMaterial) return mat;

        const userData = mat.userData || null;
        const hasUserData = userData && typeof userData === 'object' && Object.keys(userData).length > 0;
        if (!hasUserData) return mat;

        if (cache.has(mat)) return cache.get(mat);

        const cloned = mat.clone();
        cloned.userData = {};
        cache.set(mat, cloned);
        return cloned;
    };

    root.traverse((obj) => {
        if (!obj || !obj.material) return;
        const mat = obj.material;
        if (Array.isArray(mat)) {
            obj.material = mat.map(getPrepared);
        } else {
            obj.material = getPrepared(mat);
        }
    });

    return Array.from(cache.values());
}

function disposePreparedExportMaterials(materials) {
    const seen = new Set();
    (Array.isArray(materials) ? materials : []).forEach((material) => {
        if (!material || seen.has(material)) return;
        seen.add(material);
        try {
            material.dispose?.();
        } catch (_) {}
    });
}

function temporarilyClearObjectUserData(root) {
    const saved = [];
    if (!root || typeof root.traverse !== 'function') return saved;
    root.traverse((obj) => {
        if (!obj || typeof obj !== 'object') return;
        const ud = obj.userData;
        if (!ud || typeof ud !== 'object') return;
        if (Object.keys(ud).length === 0) return;
        saved.push({ obj, userData: ud });
        obj.userData = {};
    });
    return saved;
}

function restoreObjectUserData(saved) {
    const list = Array.isArray(saved) ? saved : [];
    for (const item of list) {
        if (!item?.obj) continue;
        item.obj.userData = item.userData || {};
    }
}

function temporarilyClearMaterialUserData(root) {
    const saved = [];
    if (!root || typeof root.traverse !== 'function') return saved;

    const seen = new Set();
    const collect = (mat) => {
        if (!mat || typeof mat !== 'object' || !mat.isMaterial) return;
        if (seen.has(mat)) return;
        seen.add(mat);

        const ud = mat.userData;
        if (!ud || typeof ud !== 'object') return;
        if (Object.keys(ud).length === 0) return;
        saved.push({ mat, userData: ud });
        mat.userData = {};
    };

    root.traverse((obj) => {
        const mat = obj?.material;
        if (!mat) return;
        if (Array.isArray(mat)) mat.forEach(collect);
        else collect(mat);
    });

    return saved;
}

function restoreMaterialUserData(saved) {
    const list = Array.isArray(saved) ? saved : [];
    for (const item of list) {
        if (!item?.mat) continue;
        item.mat.userData = item.userData || {};
    }
}

function detachObjectsForExport(root) {
    const removed = [];
    if (!root || typeof root.traverse !== 'function') return removed;

    const candidates = [];
    root.traverse((obj) => {
        if (!obj || obj === root) return;
        if (!shouldSkipObjectForExport(obj)) return;
        if (!obj.parent) return;
        candidates.push(obj);
    });

    for (const obj of candidates) {
        const parent = obj.parent;
        const index = Array.isArray(parent?.children) ? parent.children.indexOf(obj) : -1;
        if (typeof parent?.remove !== 'function') continue;
        try {
            parent.remove(obj);
            removed.push({ obj, parent, index });
        } catch (_) {
            // ignore
        }
    }

    return removed;
}

function restoreDetachedObjects(removed) {
    const list = Array.isArray(removed) ? removed : [];
    for (const item of list) {
        const obj = item?.obj;
        const parent = item?.parent;
        if (!obj || !parent || !Array.isArray(parent.children)) continue;
        if (obj.parent === parent) continue;

        const index = Number.isFinite(item.index) ? item.index : -1;
        if (index >= 0 && index <= parent.children.length) {
            parent.children.splice(index, 0, obj);
            obj.parent = parent;
        } else {
            parent.add(obj);
        }
    }
}

function temporarilyUseOriginalDisplayMaterials(root) {
    const saved = [];
    if (!root || typeof root.traverse !== 'function') return saved;

    root.traverse((obj) => {
        if (!obj?.material) return;
        const editableState = resolveEditableMaterialState(obj);
        if (editableState.source !== 'original' || !editableState.originalValue) return;
        saved.push({ obj, material: obj.material });
        obj.material = editableState.originalValue;
    });

    return saved;
}

function restoreDisplayMaterials(saved) {
    const list = Array.isArray(saved) ? saved : [];
    for (const item of list) {
        if (!item?.obj) continue;
        item.obj.material = item.material;
    }
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
    const renderer = options.renderer || null;
    const signal = options.signal || null;
    const getJSZip = typeof options.getJSZip === 'function'
        ? options.getJSZip
        : async () => {
            if (options.JSZip) return options.JSZip;
            if (typeof globalThis !== 'undefined') {
                if (globalThis.JSZip) return globalThis.JSZip;
                if (typeof globalThis.__LPMVIEW_LOAD_JSZIP === 'function') {
                    return globalThis.__LPMVIEW_LOAD_JSZIP();
                }
            }
            return null;
        };

    const format = normalizeFormat(options.format);
    const coords = normalizeCoords(options.coords);
    const baseName = options.baseName || makeBaseName({ coords });
    const filename = options.filename || makeFilename({ format, coords });
    const returnBlob = !!options.returnBlob;

    if (!world) throw new Error('exportWorldAsGLTF: world is required');
    assertExportNotAborted(signal);

    let exportRoot = null;
    let cloneError = null;
    try {
        exportRoot = cloneWorldForExport(world, coords);
    } catch (err) {
        cloneError = err;
        exportRoot = null;
    }

    const [{ GLTFExporter }] = await Promise.all([
        import('three/addons/exporters/GLTFExporter.js'),
    ]);
    assertExportNotAborted(signal);

    const exporter = new GLTFExporter();
    if (renderer?.textureUtils && typeof exporter.setTextureUtils === 'function') {
        try {
            exporter.setTextureUtils(renderer.textureUtils);
        } catch (_) {
            // ignore
        }
    }

    let glbArrayBuffer;
    if (exportRoot) {
        sanitizeObject3DTree(exportRoot);
        const preparedMaterials = prepareMaterialsForExport(exportRoot);
        bakeLightTargetsForExport(exportRoot);
        try {
            assertExportNotAborted(signal);
            glbArrayBuffer = await exportAsGLB(exporter, exportRoot);
            assertExportNotAborted(signal);
        } catch (err) {
            if (isExportAbortError(err)) throw err;
            console.warn('GLTF export: cloned root export failed, retrying with live world', err);
        } finally {
            disposePreparedExportMaterials(preparedMaterials);
        }
    }

    if (!glbArrayBuffer) {
        assertExportNotAborted(signal);
        if (cloneError) {
            console.warn('GLTF export: clone failed, exporting live world', cloneError);
        }

        const canMutateWorldPos =
            !!world?.position?.clone &&
            typeof world?.position?.set === 'function' &&
            typeof world?.position?.copy === 'function' &&
            typeof world?.updateMatrixWorld === 'function';

        if (!canMutateWorldPos) throw cloneError || new Error('GLTF export: cannot mutate world for export');

        const removed = detachObjectsForExport(world);
        const savedDisplayMaterials = temporarilyUseOriginalDisplayMaterials(world);
        const savedObjUserData = temporarilyClearObjectUserData(world);
        const savedMatUserData = temporarilyClearMaterialUserData(world);
        const bakedLights = bakeLightTargetsForExport(world);
        const prevPos = world.position.clone();
        const changed = coords === 'msk';
        try {
            assertExportNotAborted(signal);
            if (changed) world.position.set(0, 0, 0);
            world.updateMatrixWorld(true);
            glbArrayBuffer = await exportAsGLB(exporter, world);
            assertExportNotAborted(signal);
        } finally {
            if (changed) world.position.copy(prevPos);
            restoreBakedLightTargets(bakedLights);
            restoreMaterialUserData(savedMatUserData);
            restoreObjectUserData(savedObjUserData);
            restoreDisplayMaterials(savedDisplayMaterials);
            restoreDetachedObjects(removed);
            world.updateMatrixWorld(true);
        }
    }

    if (!(glbArrayBuffer instanceof ArrayBuffer)) {
        throw new Error('GLTF export: expected ArrayBuffer result');
    }
    assertExportNotAborted(signal);

    if (format === 'glb') {
        const blob = new Blob([glbArrayBuffer], { type: 'model/gltf-binary' });
        assertExportNotAborted(signal);
        if (returnBlob) return { filename, format, coords, blob, arrayBuffer: glbArrayBuffer };
        downloadBlob(documentRef, blob, filename);
        return { filename, format, coords };
    }

    assertExportNotAborted(signal);
    const JSZipCtor = await getJSZip();
    assertExportNotAborted(signal);
    const zipBlob = await buildGLTFZip({ glbArrayBuffer, baseName, JSZipCtor });
    assertExportNotAborted(signal);
    if (returnBlob) return { filename, format, coords, blob: zipBlob, arrayBuffer: glbArrayBuffer };
    downloadBlob(documentRef, zipBlob, filename);
    return { filename, format, coords };
}
