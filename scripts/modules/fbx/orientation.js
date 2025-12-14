import * as THREE from 'three';

const AXIS_VECTORS = Object.freeze({
    X: new THREE.Vector3(1, 0, 0),
    Y: new THREE.Vector3(0, 1, 0),
    Z: new THREE.Vector3(0, 0, 1),
});

function vectorFromPart(part) {
    if (!part || !part.axis) return null;
    const base = AXIS_VECTORS[part.axis];
    if (!base) return null;
    return base.clone().multiplyScalar(part.sign >= 0 ? 1 : -1);
}

export function readFBXOrientationFromBuffer(arrayBuffer) {
    if (!arrayBuffer) return null;
    try {
        const view = new Uint8Array(arrayBuffer);
        const encoder = new TextEncoder();
        const cache = new Map();
        const getBytes = (prop) => {
            if (!cache.has(prop)) cache.set(prop, encoder.encode(prop));
            return cache.get(prop);
        };

        const readIntProperty = (prop) => {
            const bytes = getBytes(prop);
            const end = view.length - bytes.length;
            let base = -1;
            outer: for (let i = 0; i <= end; i++) {
                for (let j = 0; j < bytes.length; j++) {
                    if (view[i + j] !== bytes[j]) continue outer;
                }
                base = i + bytes.length;
                break;
            }
            if (base === -1) return null;

            let pos = base;
            const dv = new DataView(arrayBuffer);

            while (pos < view.length && view[pos] <= 0x20) pos++;

            const nextString = () => {
                if (pos >= view.length || view[pos] !== 0x53) return false; // 'S'
                const len = dv.getUint32(pos + 1, true);
                pos += 5 + len;
                return true;
            };

            for (let i = 0; i < 4; i++) {
                if (!nextString()) break;
            }

            if (pos >= view.length) return null;
            const typeCode = view[pos];
            pos += 1;

            switch (typeCode) {
                case 0x49:
                    return dv.getInt32(pos, true); // 'I'
                case 0x4c:
                    return Number(dv.getBigInt64(pos, true)); // 'L'
                case 0x44:
                    return dv.getFloat64(pos, true); // 'D'
                case 0x46:
                    return dv.getFloat32(pos, true); // 'F'
                default:
                    return null;
            }
        };

        const axisNames = ['X', 'Y', 'Z'];
        const makePart = (index, sign) => {
            if (index == null) return null;
            const axis = axisNames[index] ?? `Axis${index}`;
            const signValue = Number.isFinite(sign) ? Number(sign) : 1;
            const normalizedSign = signValue >= 0 ? 1 : -1;
            return { index, axis, sign: normalizedSign, symbol: normalizedSign >= 0 ? '+' : '-' };
        };

        const upAxis = readIntProperty('UpAxis');
        const upSign = readIntProperty('UpAxisSign');
        const frontAxis = readIntProperty('FrontAxis');
        const frontSign = readIntProperty('FrontAxisSign');
        const coordAxis = readIntProperty('CoordAxis');
        const coordSign = readIntProperty('CoordAxisSign');

        if ([upAxis, frontAxis, coordAxis].every((v) => !Number.isFinite(v))) return null;

        return {
            up: makePart(upAxis, upSign),
            front: makePart(frontAxis, frontSign),
            coord: makePart(coordAxis, coordSign),
            raw: {
                UpAxis: upAxis,
                UpAxisSign: upSign,
                FrontAxis: frontAxis,
                FrontAxisSign: frontSign,
                CoordAxis: coordAxis,
                CoordAxisSign: coordSign,
            },
            source: 'binary',
        };
    } catch {
        return null;
    }
}

export function parseOrientationFromNode(root) {
    if (!root) return null;
    const axes = {
        X: new THREE.Vector3(1, 0, 0),
        Y: new THREE.Vector3(0, 1, 0),
        Z: new THREE.Vector3(0, 0, 1),
    };
    const result = { up: null, front: null, coord: null, source: 'geometry' };
    const tempMatrix = new THREE.Matrix4();
    const tempNormal = new THREE.Vector3();
    const tempTangent = new THREE.Vector3();

    root.traverse((node) => {
        if (!node?.isMesh) return;
        node.updateWorldMatrix(true, false);
        tempMatrix.copy(node.matrixWorld).extractRotation(tempMatrix);
        tempNormal.set(0, 0, 1).applyMatrix4(tempMatrix).normalize();
        tempTangent.set(1, 0, 0).applyMatrix4(tempMatrix).normalize();
        assignFromVector('up', tempNormal);
        assignFromVector('front', tempTangent);
    });

    if (!result.up && root.up) {
        assignFromVector('up', root.up.clone().normalize());
    }

    if (!result.front && root.children?.length) {
        const firstMesh = root.children.find((c) => c?.isMesh);
        if (firstMesh) {
            firstMesh.updateWorldMatrix(true, false);
            tempMatrix.copy(firstMesh.matrixWorld).extractRotation(tempMatrix);
            tempTangent.set(1, 0, 0).applyMatrix4(tempMatrix).normalize();
            assignFromVector('front', tempTangent);
        }
    }

    if (!result.coord && result.up && result.front) {
        const upVec = toVector(result.up);
        const frontVec = toVector(result.front);
        const rightVec = new THREE.Vector3().crossVectors(upVec, frontVec).normalize();
        assignFromVector('coord', rightVec);
    }

    if (!result.up && !result.front) return null;
    return result;

    function assignFromVector(type, vec) {
        if (!vec || !vec.lengthSq() || result[type]) return;
        let bestAxis = null;
        let bestSign = 1;
        let bestDot = -Infinity;
        Object.entries(axes).forEach(([axisName, axisVec]) => {
            const dot = vec.dot(axisVec);
            const absDot = Math.abs(dot);
            if (absDot > bestDot) {
                bestDot = absDot;
                bestAxis = axisName;
                bestSign = dot >= 0 ? 1 : -1;
            }
        });
        if (!bestAxis) return;
        result[type] = { axis: bestAxis, symbol: bestSign >= 0 ? '+' : '-', sign: bestSign };
    }

    function toVector(data) {
        if (!data) return new THREE.Vector3();
        const axis = axes[data.axis];
        if (!axis) return new THREE.Vector3();
        return axis.clone().multiplyScalar(data.sign >= 0 ? 1 : -1);
    }
}

export function describeFBXOrientation(info) {
    if (!info) return 'не найдена';
    const part = (label, data) => {
        if (!data) return `${label}: ?`;
        return `${label}: ${data.symbol}${data.axis}`;
    };
    return [part('Up', info.up), part('Front', info.front), part('Coord', info.coord)].join(' · ');
}

export function determineOrientationType(info) {
    const TYPE_UNKNOWN = 5;
    const result = { type: TYPE_UNKNOWN, handedness: 'unknown', upAxis: null };
    if (!info) return result;

    const upVec = vectorFromPart(info.up);
    const frontVec = vectorFromPart(info.front);
    const coordVec = vectorFromPart(info.coord);

    if (!upVec || !frontVec || !coordVec) return result;

    const handedness = coordVec.clone().cross(upVec).dot(frontVec) >= 0 ? 'right' : 'left';
    result.handedness = handedness;
    result.upAxis = info.up?.axis || null;

    if (info.up?.axis === 'Y') {
        result.type = handedness === 'right' ? 1 : 4;
    } else if (info.up?.axis === 'Z') {
        result.type = handedness === 'right' ? 2 : 3;
    }

    return result;
}

export function describeOrientationType(type) {
    switch (type) {
        case 1:
            return 'Y-up · правосторонняя';
        case 2:
            return 'Z-up · правосторонняя';
        case 3:
            return 'Z-up · левосторонняя';
        case 4:
            return 'Y-up · левосторонняя';
        default:
            return 'неизвестно';
    }
}

export function normalizeObjectOrientation(obj, orientationType) {
    if (!obj) return;
    switch (orientationType) {
        case 1: // Y-up right-handed
            break;
        case 2: // Z-up right-handed
            obj.rotateX(-Math.PI / 2);
            break;
        case 3: // Z-up left-handed
            obj.rotateX(-Math.PI / 2);
            obj.rotateY(Math.PI);
            break;
        case 4: // Y-up left-handed
            obj.rotateY(Math.PI);
            break;
        default:
            obj.rotateX(-Math.PI / 2);
            break;
    }
}

export function applyGeoOffsetByOrientation(obj, orientationType, coords = {}) {
    if (!obj) return;
    const { x = 0, y = 0, z = 0 } = coords;
    obj.position.x = x;
    obj.position.y = z;
    obj.position.z = -y;
}

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

