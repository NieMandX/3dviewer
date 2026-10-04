// Keep Three's object/material/skeleton schema, but never expand geometry or
// animation typed arrays into JS number arrays. This module also runs in workers.
export function serializeFBXTransfer(root, imageSources = new Map()) {
    // FBXLoader r186 sets its final Z-up correction after computing matrices.
    // Object3D.toJSON serializes matrices, not the pending position/quaternion.
    root.updateMatrixWorld(true);
    const buffers = new Set();
    const restores = [];
    const geometries = new Set();
    const sources = new Set();
    const clips = new Set();
    let geometryBytes = 0;
    const transferArray = array => {
        if (ArrayBuffer.isView(array)) {
            if (!(array.buffer instanceof ArrayBuffer)) throw new Error('Unsupported FBX shared buffer');
            buffers.add(array.buffer);
        }
        return array;
    };
    const override = (value, fn) => {
        const previous = Object.getOwnPropertyDescriptor(value, 'toJSON');
        value.toJSON = fn;
        restores.push(() => previous ? Object.defineProperty(value, 'toJSON', previous) : delete value.toJSON);
    };
    const attribute = value => {
        // FBXLoader emits ordinary Float32/Uint16 attributes. Reject other layouts
        // instead of silently changing geometry; the caller retains its fallback.
        if (value.isInterleavedBufferAttribute || value.isFloat16BufferAttribute || !ArrayBuffer.isView(value.array)) {
            throw new Error('Unsupported FBX attribute layout');
        }
        return { array: transferArray(value.array), itemSize: value.itemSize,
            normalized: value.normalized, name: value.name, usage: value.usage, gpuType: value.gpuType };
    };
    root.traverse(node => {
        if (node.geometry) geometries.add(node.geometry);
        for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
            for (const value of Object.values(material || {})) if (value?.isTexture) sources.add(value.source);
        }
        for (const clip of node.animations || []) clips.add(clip);
    });
    try {
        for (const geometry of geometries) {
            const attributes = Object.fromEntries(Object.entries(geometry.attributes).map(([key, value]) => [key, attribute(value)]));
            const morphAttributes = Object.fromEntries(Object.entries(geometry.morphAttributes).map(([key, values]) => [key, values.map(attribute)]));
            const data = { attributes, morphAttributes, morphTargetsRelative: geometry.morphTargetsRelative,
                index: geometry.index ? attribute(geometry.index) : null,
                groups: geometry.groups, drawRange: geometry.drawRange,
                boundingBox: geometry.boundingBox ? [geometry.boundingBox.min.toArray(), geometry.boundingBox.max.toArray()] : null,
                boundingSphere: geometry.boundingSphere ? [geometry.boundingSphere.center.toArray(), geometry.boundingSphere.radius] : null };
            override(geometry, () => ({ uuid: geometry.uuid, type: 'BufferGeometry', name: geometry.name, userData: geometry.userData, data }));
        }
        geometryBytes = [...buffers].reduce((sum, buffer) => sum + buffer.byteLength, 0);
        for (const source of sources) {
            const descriptor = imageSources.get(source) || { url: null };
            override(source, meta => {
                const result = { uuid: source.uuid, ...descriptor };
                if (meta?.images) meta.images[source.uuid] = result;
                return result;
            });
        }
        for (const clip of clips) {
            override(clip, () => ({ name: clip.name, uuid: clip.uuid, duration: clip.duration, blendMode: clip.blendMode, userData: JSON.stringify(clip.userData),
                tracks: clip.tracks.map(track => ({ name: track.name, type: track.ValueTypeName,
                    times: transferArray(track.times), values: transferArray(track.values), interpolation: track.getInterpolation(),
                    ...(track.settings ? { settings: Object.fromEntries(Object.entries(track.settings).map(([key, value]) => [key, transferArray(value)])) } : {}) })) }));
        }
        const json = root.toJSON();
        const transfer = [...buffers];
        return { json, transfer, stats: { geometryBytes, bufferBytes: transfer.reduce((sum, b) => sum + b.byteLength, 0), bufferCount: transfer.length } };
    } finally {
        for (const restore of restores.reverse()) restore();
    }
}
