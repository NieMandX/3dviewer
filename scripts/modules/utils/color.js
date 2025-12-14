import * as THREE from 'three';
import { clamp01 } from './math.js';

const tmpColor = new THREE.Color();

export function normalizeHexColor(value, fallback = null) {
    if (typeof value !== 'string') return fallback;
    let hex = value.trim();
    if (!hex) return fallback;
    if (!hex.startsWith('#')) hex = `#${hex}`;
    if (/^#[0-9a-fA-F]{3}$/.test(hex)) {
        hex = `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`;
    }
    if (/^#[0-9a-fA-F]{8}$/.test(hex)) {
        hex = hex.slice(0, 7);
    }
    if (/^#[0-9a-fA-F]{6}$/.test(hex)) {
        return hex.toUpperCase();
    }
    return fallback;
}

export function geoColorToHex(colorObj) {
    if (!colorObj) return null;
    try {
        if (Array.isArray(colorObj) && colorObj.length >= 3) {
            tmpColor.setRGB(clamp01(colorObj[0]), clamp01(colorObj[1]), clamp01(colorObj[2]));
        } else if (typeof colorObj === 'object' && colorObj !== null && 'r' in colorObj) {
            tmpColor.setRGB(clamp01(colorObj.r ?? 0), clamp01(colorObj.g ?? 0), clamp01(colorObj.b ?? 0));
        } else if (typeof colorObj === 'string') {
            tmpColor.set(colorObj);
        } else {
            return null;
        }
        return `#${tmpColor.getHexString().toUpperCase()}`;
    } catch (_) {
        return null;
    }
}

