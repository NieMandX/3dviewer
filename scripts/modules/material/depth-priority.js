// Session-only overrides. Weak keys do not retain materials after model removal.
const overrides = new WeakMap();

export function getDepthPriority(material) {
    return overrides.get(material)?.priority || 0;
}

export function setDepthPriority(material, value) {
    if (!material?.isMaterial || !Number.isFinite(Number(value))) return getDepthPriority(material);
    const priority = Math.max(-8, Math.min(8, Math.round(Number(value))));
    const previous = overrides.get(material);
    if (priority === (previous?.priority || 0)) return priority;
    const baseline = previous?.baseline || {
        polygonOffset: material.polygonOffset,
        polygonOffsetFactor: material.polygonOffsetFactor,
        polygonOffsetUnits: material.polygonOffsetUnits,
    };
    if (priority === 0) {
        Object.assign(material, baseline);
        overrides.delete(material);
    } else {
        overrides.set(material, { priority, baseline });
        // Both viewer backends use conventional depth. A negative bias brings
        // the material forward without changing vertices, depthTest or depthWrite.
        material.polygonOffset = true;
        material.polygonOffsetFactor = -priority;
        material.polygonOffsetUnits = -priority * 4;
    }
    material.needsUpdate = true;
    return priority;
}
