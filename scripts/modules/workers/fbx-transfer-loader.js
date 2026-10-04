import * as THREE from 'three';

function aborted(signal) {
    if (signal?.aborted) throw new DOMException('FBX image loading aborted', 'AbortError');
}

function loadImage(descriptor, signal) {
    aborted(signal);
    if (!descriptor.blob && !descriptor.url) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
        const image = new Image();
        const objectUrl = descriptor.blob ? URL.createObjectURL(descriptor.blob) : null;
        const clear = () => {
            image.onload = image.onerror = null;
            signal?.removeEventListener('abort', cancel);
            if (objectUrl) URL.revokeObjectURL(objectUrl);
        };
        const cancel = () => { clear(); image.removeAttribute('src'); reject(new DOMException('FBX image loading aborted', 'AbortError')); };
        image.crossOrigin = 'anonymous';
        image.onload = () => { clear(); resolve(image); };
        // A missing external image must not prevent a valid FBX from loading.
        image.onerror = () => { clear(); image.removeAttribute('src'); resolve(null); };
        signal?.addEventListener('abort', cancel, { once: true });
        image.src = objectUrl || descriptor.url;
    });
}

export async function parseFBXTransfer(json, { signal } = {}) {
    const images = {};
    const geometries = {};
    let textures = {}, materials = {}, object = null;
    const loader = new THREE.ObjectLoader();
    const attribute = data => {
        if (!ArrayBuffer.isView(data.array)) throw new Error('Invalid FBX transfer attribute');
        const result = new THREE.BufferAttribute(data.array, data.itemSize, data.normalized);
        result.name = data.name || '';
        if (data.usage !== undefined) result.setUsage(data.usage);
        if (data.gpuType !== undefined) result.gpuType = data.gpuType;
        return result;
    };
    try {
        // Image objects stay on the main thread; decoding is sequential and
        // abortable. Workers send compressed Blobs, never decoded pixel copies.
        for (const descriptor of json.images || []) {
            images[descriptor.uuid] = new THREE.Source(await loadImage(descriptor, signal));
            aborted(signal);
        }
        for (const record of json.geometries || []) {
            const geometry = new THREE.BufferGeometry();
            geometries[record.uuid] = geometry;
            geometry.uuid = record.uuid; geometry.name = record.name || ''; geometry.userData = record.userData || {};
            const data = record.data;
            for (const [name, value] of Object.entries(data.attributes)) geometry.setAttribute(name, attribute(value));
            if (data.index) geometry.setIndex(attribute(data.index));
            for (const [name, values] of Object.entries(data.morphAttributes || {})) geometry.morphAttributes[name] = values.map(attribute);
            geometry.morphTargetsRelative = !!data.morphTargetsRelative;
            for (const group of data.groups || []) geometry.addGroup(group.start, group.count, group.materialIndex);
            if (data.drawRange) geometry.setDrawRange(data.drawRange.start, data.drawRange.count);
            if (data.boundingBox) geometry.boundingBox = new THREE.Box3(new THREE.Vector3().fromArray(data.boundingBox[0]), new THREE.Vector3().fromArray(data.boundingBox[1]));
            if (data.boundingSphere) geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3().fromArray(data.boundingSphere[0]), data.boundingSphere[1]);
        }
        loader.parseGeometries = () => geometries;
        loader.parseImages = () => images;
        const parseTextures = loader.parseTextures.bind(loader), parseMaterials = loader.parseMaterials.bind(loader);
        loader.parseTextures = (...args) => (textures = parseTextures(...args));
        loader.parseMaterials = (...args) => (materials = parseMaterials(...args));
        object = loader.parse(json);
        aborted(signal);
        // Several textures may share one Source. Release its decoded image only
        // when the last original texture is disposed (material clones share it).
        for (const source of Object.values(images)) {
            const owners = Object.values(textures).filter(texture => texture.source === source);
            const release = () => { source.data?.removeAttribute?.('src'); source.data = null; };
            let remaining = owners.length;
            if (!remaining) release();
            for (const texture of owners) {
                const dispose = () => { texture.removeEventListener('dispose', dispose); if (--remaining === 0) release(); };
                texture.addEventListener('dispose', dispose);
            }
        }
        return object;
    } catch (error) {
        const skeletons = new Set(); object?.traverse(node => { if (node.skeleton) skeletons.add(node.skeleton); });
        for (const skeleton of skeletons) skeleton.dispose();
        for (const geometry of Object.values(geometries)) geometry.dispose();
        for (const texture of Object.values(textures)) texture.dispose();
        for (const material of Object.values(materials)) material.dispose();
        for (const source of Object.values(images)) { source.data?.removeAttribute?.('src'); source.data = null; }
        throw error;
    }
}
