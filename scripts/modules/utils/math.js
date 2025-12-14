export function clamp01(v) {
    const num = Number.isFinite(v) ? v : 0;
    return Math.min(1, Math.max(0, num));
}

