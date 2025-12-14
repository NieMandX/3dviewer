import { parseGeoNumber } from '../parcels.js';
import { clamp01 } from '../utils/math.js';

/** Приводит имя стеклянного материала к нормализованному ключу (lowercase). */
function normalizeGlassKey(name) {
    if (!name) return null;
    return String(name).trim().toLowerCase();
}

/**
 * Извлекает массив `Glasses` из GeoJSON и кеширует результат: Map<matName, params>.
 * params → { color, transparency, roughness, metalness, refraction } в нормализованном виде.
 */
function ensureGeoGlassIndex(meta) {
    if (!meta) return null;
    if (meta._glassIndex) return meta._glassIndex;
    const index = new Map();
    const parsed = meta.parsed;
    const features = parsed?.type === 'FeatureCollection' && Array.isArray(parsed.features)
        ? parsed.features
        : Array.isArray(parsed?.features) ? parsed.features : [];

    features.forEach(feature => {
        const glasses = feature?.Glasses;
        if (!Array.isArray(glasses)) return;
        glasses.forEach(entry => {
            if (!entry || typeof entry !== 'object') return;
            Object.entries(entry).forEach(([matName, params]) => {
                const key = normalizeGlassKey(matName);
                if (!key || index.has(key) || !params || typeof params !== 'object') return;

                const color = params.color_RGB || params.color_rgb || params.color || null;
                let colorData = null;
                if (color && typeof color === 'object') {
                    const toChan = v => {
                        const val = parseGeoNumber(v);
                        return Number.isFinite(val) ? clamp01(val / 255) : null;
                    };
                    const r = toChan(color.Red ?? color.red ?? color.R ?? color.r);
                    const g = toChan(color.Green ?? color.green ?? color.G ?? color.g);
                    const b = toChan(color.Blue ?? color.blue ?? color.B ?? color.b);
                    if (r != null || g != null || b != null) {
                        colorData = {
                            r: r ?? 0,
                            g: g ?? 0,
                            b: b ?? 0,
                        };
                    }
                }

                const transparency = parseGeoNumber(params.transparency);
                const refraction = parseGeoNumber(params.refraction ?? params.ior ?? params.n);
                const roughness = parseGeoNumber(params.roughness);
                const metallicity = parseGeoNumber(params.metallicity ?? params.metalness);

                const transparencyClamped = transparency != null ? clamp01(transparency) : null;
                index.set(key, {
                    color: colorData,
                    transparency: transparencyClamped,
                    opacity: transparencyClamped,
                    refraction,
                    roughness: roughness != null ? clamp01(roughness) : null,
                    metalness: metallicity != null ? clamp01(metallicity) : null,
                });
            });
        });
    });

    meta._glassIndex = index;
    return index;
}

/** Возвращает параметры стекла для указанных имён (материал/объект), либо null. */
export function findGeoGlassParams(meta, nameCandidates) {
    if (!meta) return null;
    const index = ensureGeoGlassIndex(meta);
    if (!index || !index.size) return null;
    for (const candidate of nameCandidates) {
        const key = normalizeGlassKey(candidate);
        if (!key) continue;
        const hit = index.get(key);
        if (hit) return hit;
    }
    return null;
}

