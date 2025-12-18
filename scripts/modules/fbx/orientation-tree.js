export function readFBXOrientationFromTree(tree) {
    if (!tree) return null;
    const targetKeys = ['UpAxis', 'UpAxisSign', 'FrontAxis', 'FrontAxisSign', 'CoordAxis', 'CoordAxisSign'];
    const found = {};

    const extractNumeric = (value) => {
        if (value == null) return null;
        if (typeof value === 'number') return value;
        if (typeof value === 'string') {
            const parsed = parseInt(value, 10);
            return Number.isFinite(parsed) ? parsed : null;
        }
        if (Array.isArray(value)) {
            for (const item of value) {
                const extracted = extractNumeric(item);
                if (extracted != null) return extracted;
            }
            return null;
        }
        if (typeof value === 'object') {
            if ('value' in value) return extractNumeric(value.value);
            for (const k of Object.keys(value)) {
                if (k === 'type' || k === 'name') continue;
                const extracted = extractNumeric(value[k]);
                if (extracted != null) return extracted;
            }
        }
        return null;
    };

    const visit = (node) => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) {
            node.forEach(visit);
            return;
        }
        for (const key of targetKeys) {
            if (found[key] == null && key in node) {
                const value = extractNumeric(node[key]);
                if (value != null) found[key] = value;
            }
        }
        for (const value of Object.values(node)) {
            visit(value);
        }
    };

    visit(tree);

    if (targetKeys.every((key) => found[key] == null)) return null;

    const axisNames = ['X', 'Y', 'Z'];
    const makePart = (index, sign) => {
        if (index == null) return null;
        const axis = axisNames[index] ?? `Axis${index}`;
        const signValue = Number.isFinite(sign) ? sign : 1;
        const signSymbol = signValue >= 0 ? '+' : '-';
        return { index, axis, sign: signValue, symbol: signSymbol };
    };

    return {
        up: makePart(found.UpAxis, found.UpAxisSign),
        front: makePart(found.FrontAxis, found.FrontAxisSign),
        coord: makePart(found.CoordAxis, found.CoordAxisSign),
        raw: found,
        source: 'tree',
    };
}

