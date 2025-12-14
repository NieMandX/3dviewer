function defaultLog(message) {
    try {
        console.log(message);
    } catch (_) {}
}

export function getSMOffset(meta, options = {}) {
    const log = typeof options.log === 'function' ? options.log : (message) => defaultLog(message);
    const setVPMReferenceHeight = typeof options.setVPMReferenceHeight === 'function' ? options.setVPMReferenceHeight : null;

    const src = meta?.parsed ?? meta?.json ?? meta?.text ?? meta;
    let data = null;
    try {
        data = typeof src === 'string' ? JSON.parse(src) : src;
    } catch (e) {
        log(`GeoJSON parse error: ${e?.message || e} → Δ=0`, 'warn');
        return { x: 0, y: 0, z: 0 };
    }
    if (!data || typeof data !== 'object') {
        log('GeoJSON: empty → Δ=0', 'warn');
        return { x: 0, y: 0, z: 0 };
    }

    let node = null;
    (function find(o) {
        if (node || !o || typeof o !== 'object') return;
        if (o.geometry && o.geometry.type === 'Point' && Array.isArray(o.geometry.coordinates)) {
            node = o;
            return;
        }
        for (const k in o) {
            const v = o[k];
            if (v && typeof v === 'object') find(v);
            if (node) break;
        }
    })(data);

    if (!node) {
        log('GeoJSON: Point not found → Δ=0', 'warn');
        return { x: 0, y: 0, z: 0 };
    }

    const c = node.geometry.coordinates;
    const toNum = (v) => {
        if (typeof v === 'number' && isFinite(v)) return v;
        if (typeof v === 'string') return parseFloat(v.replace(/\s+/g, '').replace(',', '.'));
        return NaN;
    };
    const X = toNum(c[0]) || 0;
    const Y = toNum(c[1]) || 0;
    let Z = 0;

    if (node.properties && node.properties.h_relief != null) {
        const hr = toNum(node.properties.h_relief);
        if (isFinite(hr)) Z = hr;
    }

    log(`VPM: GeoJSON offset → Δx=${X} Δy=${Y} Δz=${Z}`, 'ok');
    if (Number.isFinite(Z) && setVPMReferenceHeight) setVPMReferenceHeight(Z);
    return { x: X, y: Y, z: Z };
}

