export function toFiniteNumber(value) {
    const num = Number(value);
    return Number.isFinite(num) ? num : 0;
}

export function getTriangleCount(geometry) {
    if (!geometry?.attributes?.position) return 0;
    if (geometry.index?.count) {
        return Math.max(0, Math.floor(geometry.index.count / 3));
    }
    return Math.max(0, Math.floor(geometry.attributes.position.count / 3));
}

export function collectMaterialTextures(material) {
    const textures = [];
    if (!material || typeof material !== 'object') return textures;
    Object.values(material).forEach((value) => {
        if (value?.isTexture) textures.push(value);
    });
    return textures;
}

export function formatBounds(size) {
    if (!size) return '0 x 0 x 0';
    return `${size.x.toFixed(1)} x ${size.y.toFixed(1)} x ${size.z.toFixed(1)}`;
}

export function mapSeverityToCheckStatus(value) {
    if (value === 'error') return 'fail';
    if (value === 'warn') return 'warn';
    return 'pass';
}

export function addCheck(checks, status, title, message, details = null) {
    checks.push({
        status,
        title,
        message,
        details: Array.isArray(details) ? details.filter(Boolean) : null,
    });
}

export function isValidCheck(value) {
    if (!value || typeof value !== 'object') return false;
    if (!value.title || !value.message) return false;
    return value.status === 'pass' || value.status === 'warn' || value.status === 'fail';
}
