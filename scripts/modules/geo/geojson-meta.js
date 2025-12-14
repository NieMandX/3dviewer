import { basename } from '../utils/path.js';

export function makeGeoJsonMeta(zipName, entryName, text) {
    let parsed = null;
    let featureCount = null;
    try {
        parsed = JSON.parse(text);
        if (parsed?.type === 'FeatureCollection' && Array.isArray(parsed.features)) {
            featureCount = parsed.features.length;
        }
    } catch (_) {}

    const blob = new Blob([text], { type: 'application/geo+json' });
    const url = URL.createObjectURL(blob);

    return {
        zipName,
        entryName: basename(entryName),
        text,
        parsed,
        featureCount,
        url,
    };
}

