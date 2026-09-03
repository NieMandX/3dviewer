const CACHE_KEY = 'lpmview:building-height-order:v1';

function normalize(value) {
    return String(value || '').normalize('NFKC').toLowerCase().replaceAll('\u0451', '\u0435').replace(/\s+/gu, ' ').trim();
}

export function buildingAddressKey(city, street, number) {
    if (!city || !street || !number) return null;
    const road = normalize(street).replace(/(^| )ул\.(?= |$)/gu, '$1улица').replace(/(^| )пер\.(?= |$)/gu, '$1переулок');
    const words = road.split(' ');
    const type = ['улица', 'проезд', 'проспект', 'переулок', 'набережная', 'площадь', 'шоссе', 'бульвар'].find((word) => words.includes(word));
    const house = normalize(number).replace(/^(дом|д\.)\s*/u, '').match(/^(\d+[а-яa-z]?(?:\/\d+[а-яa-z]?)?)(?:\s*(?:корпус|корп\.?|к)\s*(\d+[а-яa-z]?))?(?:\s*(?:строение|стр\.?|ст|с)\s*(\d+[а-яa-z]?))?$/u);
    if (!house) return null;
    return JSON.stringify([normalize(city), type || '', type ? words.filter((word) => word !== type).join(' ') : road,
        house[1], house[2] || '', house[3] || '']);
}

function metres(value) {
    const match = String(value ?? '').trim().match(/^(\d+(?:\.\d+)?)\s*(m|ft)?$/);
    if (!match) return null;
    const result = Number(match[1]) * (match[2] === 'ft' ? 0.3048 : 1);
    return Number.isFinite(result) && result >= 0 && result <= 1500 ? result : null;
}

function levels(value) {
    return /^\d+$/.test(String(value ?? '')) && Number(value) <= 250 ? Number(value) : null;
}

export function readBuildingHeight(tags = {}) {
    const height = metres(tags.height);
    const floors = levels(tags['building:levels']);
    const top = height ?? (floors == null ? null : floors * 3);
    const bottom = metres(tags.min_height) ?? ((levels(tags['building:min_level']) || 0) * 3);
    if (top == null || top <= bottom) return null;
    return { top, bottom, source: height == null ? 'levels' : 'height', floors,
        estimated: height == null, disused: tags.disused === 'yes' };
}

// The cache stores identities, not heights, keys, provider responses or geometry.
export function loadHeightBindings() {
    try {
        const entries = JSON.parse(globalThis.localStorage?.getItem(CACHE_KEY) || '[]');
        return new Map(Array.isArray(entries) ? entries.slice(-1000).filter((entry) =>
            Array.isArray(entry) && entry.length === 2 && entry.every((value) => typeof value === 'string' && value.length < 1000)) : []);
    } catch (_) { return new Map(); }
}

export function saveHeightBindings(bindings) {
    try { globalThis.localStorage?.setItem(CACHE_KEY, JSON.stringify([...bindings].slice(-1000))); } catch (_) {}
}

export function assignBuildingHeights(contours, elements, previous = new Map(), city = 'Москва') {
    const source = new Map(), groups = new Map(), bindings = new Map(previous);
    const seen = new Set();
    for (const element of elements) {
        const tags = element.tags || {};
        if (!['way', 'relation'].includes(element.type) || !(tags.building || (tags['building:part'] && tags['building:part'] !== 'no'))
            || ['no', 'demolished', 'razed', 'collapsed', 'construction'].includes(tags.building)) continue;
        const address = buildingAddressKey(tags['addr:city'] || city, tags['addr:street'], tags['addr:housenumber']);
        const id = `${element.type}/${element.id}`;
        if (!address || seen.has(id)) continue;
        seen.add(id);
        if (!source.has(address)) source.set(address, []);
        source.get(address).push({ id, height: readBuildingHeight(tags) });
    }
    const result = contours.map((contour) => ({ ...contour, height: null, osmId: null, byOrder: false }));
    for (const contour of result) {
        const matches = [...new Set(contour.addresses)].filter((address) => source.has(address));
        if (matches.length !== 1) continue;
        const address = matches[0];
        if (!groups.has(address)) groups.set(address, []);
        groups.get(address).push(contour);
    }
    for (const [address, targets] of groups) {
        const candidates = source.get(address);
        // Do not shift the remaining assignments when an object or height is missing.
        if (targets.length !== candidates.length) continue;
        const unused = new Map(candidates.map((candidate) => [candidate.id, candidate]));
        const assigned = new Map();
        for (const target of targets) {
            const candidate = unused.get(bindings.get(`${address}|${target.id}`));
            if (candidate) { assigned.set(target.id, candidate); unused.delete(candidate.id); }
        }
        for (const target of targets) {
            let candidate = assigned.get(target.id);
            if (!candidate) {
                candidate = unused.values().next().value;
                unused.delete(candidate.id);
            }
            const bindingKey = `${address}|${target.id}`;
            bindings.delete(bindingKey);
            bindings.set(bindingKey, candidate.id);
            target.height = candidate.height;
            target.osmId = candidate.id;
            target.byOrder = candidates.length > 1;
        }
    }
    return { contours: result, bindings: new Map([...bindings].slice(-1000)) };
}
