// three.js r184 WebGPUBackend omits polygonOffset from both its pipeline cache
// key and needsRenderUpdate check, although WebGPUPipelineUtils uses these values
// in depthStencil. Without this, materials can share a pipeline with the wrong
// depth bias. Keep this instance-local shim until the pinned release fixes it.
// https://github.com/mrdoob/three.js/blob/r184/src/renderers/webgpu/WebGPUBackend.js
export function installDepthBiasCacheFix(renderer) {
    const backend = renderer?.backend;
    if (!backend?.isWebGPUBackend || typeof backend.getRenderCacheKey !== 'function'
        || typeof backend.needsRenderUpdate !== 'function') return () => {};

    const originalKey = backend.getRenderCacheKey;
    const originalUpdate = backend.needsRenderUpdate;
    const previousBias = new WeakMap();
    const biasKey = ({ material }) => material.polygonOffset
        ? `${material.polygonOffsetFactor},${material.polygonOffsetUnits}` : 'off';

    function getRenderCacheKey(renderObject) {
        return `${originalKey.call(this, renderObject)}|depthBias:${biasKey(renderObject)}`;
    }
    function needsRenderUpdate(renderObject) {
        const needsUpdate = originalUpdate.call(this, renderObject);
        const key = biasKey(renderObject);
        const changed = previousBias.get(renderObject) !== key;
        previousBias.set(renderObject, key);
        return needsUpdate || changed;
    }
    backend.getRenderCacheKey = getRenderCacheKey;
    backend.needsRenderUpdate = needsRenderUpdate;
    return () => {
        if (backend.getRenderCacheKey === getRenderCacheKey) backend.getRenderCacheKey = originalKey;
        if (backend.needsRenderUpdate === needsRenderUpdate) backend.needsRenderUpdate = originalUpdate;
    };
}
