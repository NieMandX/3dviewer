import { asMaterialArray, isGeneratedDisplayMaterial } from '../material/texture-utils.js';

export function guessKindFromName(name) {
    const n = (name || '').toLowerCase();
    if (/(rough|rgh|_rough|\br_)/.test(n)) return 'roughness';
    if (/gloss/.test(n)) return 'gloss';
    if (/(metal|mtl|\b_m\b)/.test(n)) return 'metalness';
    if (/(normal|_nrm|_nor)\b/.test(n)) return 'normal';
    if (/ao|ambient[_-]?occ/i.test(n)) return 'ao';
    if (/opacity|alpha|transp/i.test(n)) return 'alpha';
    if (/basecolor|albedo|diff(use)?/i.test(n)) return 'base';
    if (/spec(ular)?/i.test(n)) return 'spec';
    return 'other';
}

export function createTextureInfoFormatter(options = {}) {
    const THREE = options.THREE || null;
    const basename = typeof options.basename === 'function' ? options.basename : (p) => (p || '').split(/[\\/]/).pop();
    const emptyHtml = options.emptyHtml ?? '<span class="muted">—</span>';

    return function texInfo(tex) {
        if (!tex) return emptyHtml;
        const human = tex.name || tex.userData?.origName || null;
        let rawSrc = '';
        const img = tex.image;
        if (img) rawSrc = img.currentSrc || img.src || img.url || '';
        const fallback = basename(decodeURIComponent(String(rawSrc || '')).split('?')[0] || '');
        const pretty = human || fallback || '(texture)';

        const srgb = THREE?.SRGBColorSpace;
        const linear = THREE?.LinearSRGBColorSpace;
        const cs =
            tex?.colorSpace === srgb
                ? 'srgb'
                : tex?.colorSpace === linear
                    ? 'srgb-linear'
                    : (tex?.colorSpace ?? '—');

        return `${pretty}  ·  ${cs}`;
    };
}

export function createSelectedMaterialLinkResolver(options = {}) {
    const matSelectEl = options.matSelectEl || null;
    const world = options.world || null;

    return function getSelectedMaterialLink() {
        if (!matSelectEl) return null;
        const val = matSelectEl.value;
        if (val === '' || val == null) return null;

        let map = [];
        try {
            map = JSON.parse(matSelectEl.dataset._map || '[]');
        } catch {}

        const entry = map.find(e => String(e.idx) === String(val));
        if (!entry) return null;

        const [uuid, idxStr] = String(entry.path).split(':');
        const targetIndex = parseInt(idxStr, 10) || 0;

        let link = null;
        world?.traverse?.(o => {
            if (link || !o?.isMesh) return;
            if (o.uuid !== uuid) return;
            const mats = Array.isArray(o.material) ? o.material : [o.material];
            const originalMats = asMaterialArray(o.userData?._origMaterial);
            const currentMat = mats[targetIndex] || null;
            const shouldEditOriginal = originalMats.length > 0 && (
                !currentMat ||
                isGeneratedDisplayMaterial(o, currentMat)
            );
            if (shouldEditOriginal) {
                link = {
                    obj: o,
                    index: targetIndex,
                    mat: originalMats[targetIndex] || originalMats[0] || null,
                    source: 'original',
                };
                return;
            }
            link = { obj: o, index: targetIndex, mat: currentMat, source: 'current' };
        });
        return link;
    };
}
