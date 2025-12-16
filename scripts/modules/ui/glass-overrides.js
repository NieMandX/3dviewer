import { clamp01 } from '../utils/math.js';
import { normalizeHexColor } from '../utils/color.js';

export function createGlassOverridesController(options = {}) {
    const requestRender = typeof options.requestRender === 'function' ? options.requestRender : () => {};
    const applyGlassControlsToScene =
        typeof options.applyGlassControlsToScene === 'function' ? options.applyGlassControlsToScene : () => {};
    const resolveGlassMaterial =
        typeof options.resolveGlassMaterial === 'function' ? options.resolveGlassMaterial : () => null;

    function updateGlassSourceLabel(container, mat) {
        if (!container || !mat) return;
        const label = container.querySelector('.glass-source');
        if (!label) return;
        const info = mat.userData?.glassInfo;
        let text = 'UI';
        if (info?.source === 'geojson') text = 'GeoJSON';
        else if (info?.source === 'override') text = 'Custom';
        label.textContent = text;
    }

    function formatColorForDisplay(color) {
        if (!color || !color.isColor) return '—';
        const to255 = (v) => Math.round(clamp01(v) * 255);
        return `${to255(color.r)}/${to255(color.g)}/${to255(color.b)}`;
    }

    function handleGlassSliderInput(ev) {
        const input = ev.currentTarget;
        if (!input) return;
        const prop = input.dataset.prop;
        const uuid = input.dataset.uuid;
        const matIndex = Number.parseInt(input.dataset.matIndex ?? '0', 10) || 0;
        const resolved = resolveGlassMaterial(uuid, matIndex);
        if (!resolved) return;
        const { mat } = resolved;

        let rawValue = parseFloat(input.value);
        if (!Number.isFinite(rawValue)) rawValue = 0;
        const minAttr = Number.parseFloat(input.min ?? '');
        const maxAttr = Number.parseFloat(input.max ?? '');
        if (Number.isFinite(minAttr)) rawValue = Math.max(minAttr, rawValue);
        if (Number.isFinite(maxAttr)) rawValue = Math.min(maxAttr, rawValue);
        input.value = String(rawValue);

        let storedValue;
        if (prop === 'opacity' || prop === 'roughness' || prop === 'metalness' || prop === 'transmission') {
            storedValue = clamp01(rawValue);
        } else {
            storedValue = rawValue;
        }

        const overrides = (mat.userData ||= {}).glassOverrides ||= {};
        overrides[prop] = storedValue;
        if (prop === 'envIntensity') overrides.envIntensity = storedValue;
        if (prop === 'transmission') {
            (mat.userData.glassOriginal ||= {}).transmission = storedValue;
        }

        applyGlassControlsToScene();

        const container = input.closest('.glass-controls');
        if (container) {
            const span = container.querySelector(`.glass-value[data-prop="${prop}"]`);
            if (span) span.textContent = Number.isFinite(storedValue) ? storedValue.toFixed(2) : '—';
            updateGlassSourceLabel(container, mat);
            if (
                prop === 'color' ||
                prop === 'opacity' ||
                prop === 'roughness' ||
                prop === 'metalness' ||
                prop === 'transmission' ||
                prop === 'envIntensity' ||
                prop === 'refraction'
            ) {
                const colorSpan = container.querySelector('.glass-value[data-prop="color-rgb"]');
                if (colorSpan) colorSpan.textContent = formatColorForDisplay(mat?.color);
            }
        }
        requestRender();
    }

    function handleGlassColorInput(ev) {
        const input = ev.currentTarget;
        if (!input) return;
        const uuid = input.dataset.uuid;
        const matIndex = Number.parseInt(input.dataset.matIndex ?? '0', 10) || 0;
        const resolved = resolveGlassMaterial(uuid, matIndex);
        if (!resolved) return;
        const { mat } = resolved;

        const hex = normalizeHexColor(input.value, '#FFFFFF') || '#FFFFFF';
        input.value = hex;

        const overrides = (mat.userData ||= {}).glassOverrides ||= {};
        overrides.color = hex;

        applyGlassControlsToScene();

        const container = input.closest('.glass-controls');
        if (container) {
            updateGlassSourceLabel(container, mat);
            const colorSpan = container.querySelector('.glass-value[data-prop="color-rgb"]');
            if (colorSpan) colorSpan.textContent = formatColorForDisplay(mat?.color);
        }
        requestRender();
    }

    return {
        handleGlassSliderInput,
        handleGlassColorInput,
        formatColorForDisplay,
    };
}

