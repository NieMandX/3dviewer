export const GEOM_SUFFIXES = Object.freeze([
    'mainglass',
    'main',
    'groundglass',
    'groundelglass',
    'groundel',
    'ground',
    'flora',
]);

export function findGeomSuffix(label) {
    const s = (label || '').toLowerCase();
    for (const g of GEOM_SUFFIXES) {
        const re = new RegExp(`(?:^|[^a-z0-9])${g}(?:[^a-z0-9]|$)`, 'i');
        if (re.test(s)) return g;
    }
    return null;
}

export function detectSlotFromMaterialName(name) {
    if (!name) return null;
    const s = String(name);

    const rx = new RegExp(`_(?:${GEOM_SUFFIXES.join('|')})_(\\d{1,3})(?!\\d)\\s*$`, 'i');
    const m1 = s.match(rx);
    if (m1) return parseInt(m1[1], 10);

    if (/UDIM\\s*\\d{4}\\s*$/i.test(s)) return null;

    const m2 = s.match(/_(\\d{1,3})\\s*$/);
    if (m2) return parseInt(m2[1], 10);

    return null;
}

export function detectSlotFromMatOrObj(obj, mat) {
    const byMat = detectSlotFromMaterialName(mat?.name);
    if (byMat != null) return byMat;
    const byObj = detectSlotFromMaterialName(obj?.name);
    if (byObj != null) return byObj;
    return 1;
}

export function isGlassGeomSuffix(geomSuffix) {
    return /^(mainglass|groundglass|groundelglass)$/.test((geomSuffix || '').toLowerCase());
}

export function isGlassByName(name) {
    return /\\b(mainglass|groundglass|groundelglass)\\b/.test((name || '').toLowerCase());
}

