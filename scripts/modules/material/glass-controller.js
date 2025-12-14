import { clamp01 } from '../utils/math.js';
import { geoColorToHex, normalizeHexColor } from '../utils/color.js';
import { findGeoGlassParams } from '../geo/glass-params.js';
import { findGeomSuffix, isGlassByName, isGlassGeomSuffix } from './naming.js';

export function createGlassController(options = {}) {
    const THREE = options.THREE || null;
    const world = options.world || null;
    const scene = options.scene || null;

    const toStandard = typeof options.toStandard === 'function' ? options.toStandard : (m) => m;
    const cacheOriginalMaterialFor =
        typeof options.cacheOriginalMaterialFor === 'function' ? options.cacheOriginalMaterialFor : () => {};

    const requestRender = typeof options.requestRender === 'function' ? options.requestRender : () => {};
    const schedulePanelRefresh = typeof options.schedulePanelRefresh === 'function' ? options.schedulePanelRefresh : () => {};

    const elements = options.elements || {};
    const glassOpacityEl = elements.glassOpacityEl || null;
    const glassIorEl = elements.glassIorEl || null;
    const glassTransmissionEl = elements.glassTransmissionEl || null;
    const glassReflectEl = elements.glassReflectEl || null;
    const glassRoughEl = elements.glassRoughEl || null;
    const glassMetalEl = elements.glassMetalEl || null;
    const glassAttenDistEl = elements.glassAttenDistEl || null;
    const glassAttenColorEl = elements.glassAttenColorEl || null;
    const glassColorEl = elements.glassColorEl || null;
    const glassResetBtn = elements.glassResetBtn || null;

    const glassValueDisplays = new Map();

    function sliderStepDecimals(input) {
        if (!input) return 2;
        const stepAttr = input.getAttribute?.('step');
        if (!stepAttr || stepAttr === 'any') return 2;
        if (stepAttr.includes('.')) {
            const decimals = stepAttr.split('.')[1]?.length || 0;
            return Math.min(Math.max(decimals, 0), 4);
        }
        return 0;
    }

    function clampValueToSlider(slider, value) {
        let next = value;
        const minAttr = slider.getAttribute('min');
        const maxAttr = slider.getAttribute('max');
        const min = minAttr !== null && minAttr !== '' ? parseFloat(minAttr) : null;
        const max = maxAttr !== null && maxAttr !== '' ? parseFloat(maxAttr) : null;
        if (Number.isFinite(min)) next = Math.max(next, min);
        if (Number.isFinite(max)) next = Math.min(next, max);
        return next;
    }

    function snapValueToStep(slider, value) {
        const stepAttr = slider.getAttribute('step');
        if (!stepAttr || stepAttr === 'any') return value;
        const step = parseFloat(stepAttr);
        if (!Number.isFinite(step) || step <= 0) return value;
        const minAttr = slider.getAttribute('min');
        const origin = minAttr !== null && minAttr !== '' ? parseFloat(minAttr) : 0;
        const steps = Math.round((value - origin) / step);
        return origin + steps * step;
    }

    function registerGlassDisplay(id, input) {
        if (!input) return;
        const display = document.querySelector(`[data-value-for="${id}"]`);
        if (!display) return;
        glassValueDisplays.set(id, { input, display });
    }

    function applyGlassDisplay(entry) {
        if (!entry) return;
        const { input, display } = entry;
        if (!display || !input) return;
        if (input.type === 'color') {
            const val = String(input.value || '').toUpperCase();
            if (display instanceof HTMLInputElement) display.value = val;
            else display.textContent = val;
            return;
        }
        const numeric = parseFloat(input.value);
        if (!Number.isFinite(numeric)) {
            if (display instanceof HTMLInputElement) display.value = input.value || '';
            else display.textContent = input.value || '';
            return;
        }
        const formatted = numeric.toFixed(sliderStepDecimals(input));
        if (display instanceof HTMLInputElement) display.value = formatted;
        else display.textContent = formatted;
    }

    function updateGlassDisplay(id) {
        applyGlassDisplay(glassValueDisplays.get(id));
    }

    function updateAllGlassDisplays() {
        glassValueDisplays.forEach(applyGlassDisplay);
    }

    function applyToScene() {
        if (!world) return;
        const sliderOpacity = parseFloat(glassOpacityEl?.value ?? 0.1);
        const sliderReflect = parseFloat(glassReflectEl?.value ?? 3.0);
        const sliderRough = parseFloat(glassRoughEl?.value ?? 0.05);
        const sliderMetal = parseFloat(glassMetalEl?.value ?? 1.0);
        const sliderTransmission = parseFloat(glassTransmissionEl?.value ?? 1);
        const sliderIor = parseFloat(glassIorEl?.value ?? 1.5);
        const sliderAttenDist = parseFloat(glassAttenDistEl?.value ?? 0.2);
        const useGlobalOpacity = glassOpacityEl?.dataset.userSet === '1';
        const useGlobalIor = glassIorEl?.dataset.userSet === '1';
        const useGlobalTransmission = glassTransmissionEl?.dataset.userSet === '1';
        const useGlobalReflect = glassReflectEl?.dataset.userSet === '1';
        const useGlobalRoughness = glassRoughEl?.dataset.userSet === '1';
        const useGlobalMetalness = glassMetalEl?.dataset.userSet === '1';
        const useGlobalColor = glassColorEl?.dataset.userSet === '1';
        const useGlobalAttenDist = glassAttenDistEl?.dataset.userSet === '1';
        const useGlobalAttenColor = glassAttenColorEl?.dataset.userSet === '1';
        const globalColorHex = useGlobalColor
            ? normalizeHexColor(glassColorEl.value, '#FFFFFF')
            : null;
        const globalAttenColorHex = useGlobalAttenColor
            ? normalizeHexColor(glassAttenColorEl.value, '#FFFFFF')
            : null;

        function findGeoMetaForObject(obj) {
            let node = obj;
            while (node) {
                const meta = node.userData?._geojsonMeta || node.userData?.geojson;
                if (meta) return meta;
                node = node.parent || null;
            }
            return null;
        }

        function findZipKindForObject(obj) {
            let node = obj;
            while (node) {
                const kind = node.userData?.zipKind || node.userData?.zipKindOverride;
                if (kind) return kind;
                node = node.parent || null;
            }
            return null;
        }

        world.traverse(o => {
            if (o.userData?.isCollision) return;
            if (!o.isMesh || !o.material) return;
            const mats = Array.isArray(o.material) ? o.material : [o.material];
            mats.forEach((m, i) => {
                const nameStr = `${m.name || ''} ${o.name || ''}`;
                const geomSuffix = findGeomSuffix(nameStr);
                const glass = isGlassByName(nameStr) || isGlassGeomSuffix(geomSuffix);
                if (!glass) return;

                const std = toStandard(m);
                std.transparent = true;
                std.envMap = scene?.environment || std.envMap;
                std.userData ||= {};

                let overrides = std.userData.glassOverrides || null;
                const geoMeta = findGeoMetaForObject(o);
                const glassParams = geoMeta ? findGeoGlassParams(geoMeta, [m.name, o.name, nameStr]) : null;
                const currentEnvIntensity = Number.isFinite(std.envMapIntensity) ? std.envMapIntensity : sliderReflect;
                const zipKind = (findZipKindForObject(o) || '').toUpperCase();
                const isNPM = zipKind === 'NPM';
                const isSM = zipKind === 'SM';

                if (!std.userData.glassOriginal) {
                    const baseColorFromGeo = glassParams?.color ? geoColorToHex(glassParams.color) : (std.color?.isColor ? `#${std.color.getHexString().toUpperCase()}` : null);
                    const geoTransparency = glassParams?.transparency;
                    const originalOpacity = (geoTransparency != null)
                        ? clamp01(1 - geoTransparency)
                        : (glassParams?.opacity ?? std.opacity ?? sliderOpacity);
                    const originalRoughness = glassParams?.roughness ?? std.roughness ?? sliderRough;
                    const originalMetalness = glassParams?.metalness ?? std.metalness ?? sliderMetal;
                    const originalRefraction = glassParams?.refraction ?? (('ior' in std) ? std.ior : null);
                    const baseAttenuationColor = baseColorFromGeo || (std.attenuationColor?.isColor ? `#${std.attenuationColor.getHexString().toUpperCase()}` : null);
                    const originalData = {
                        opacity: Number.isFinite(originalOpacity) ? clamp01(originalOpacity) : null,
                        roughness: Number.isFinite(originalRoughness) ? clamp01(originalRoughness) : null,
                        metalness: Number.isFinite(originalMetalness) ? clamp01(originalMetalness) : null,
                        envIntensity: Number.isFinite(currentEnvIntensity) ? currentEnvIntensity : sliderReflect,
                        color: baseColorFromGeo,
                        refraction: originalRefraction,
                        transmission: 1,
                        attenuationColor: baseAttenuationColor,
                        attenuationDistance: 0.2,
                    };
                    if (isNPM) {
                        originalData.opacity = 0.30;
                        originalData.roughness = 0.05;
                        originalData.metalness = 0.1;
                        originalData.envIntensity = 3.0;
                        originalData.refraction = 3.0;
                        originalData.transmission = 1;
                        originalData.attenuationColor = baseColorFromGeo || (std.color?.isColor ? `#${std.color.getHexString().toUpperCase()}` : null);
                        originalData.attenuationDistance = 0.1;
                        std.transmission = 1;
                    }
                    if (isSM && !isNPM && glassParams) {
                        if (glassParams.color) std.color?.set?.(originalData.color || glassParams.color);
                        if (glassParams.transparency != null) originalData.opacity = clamp01(1 - glassParams.transparency);
                        if (glassParams.roughness != null) originalData.roughness = clamp01(glassParams.roughness);
                        if (glassParams.metalness != null) originalData.metalness = clamp01(glassParams.metalness);
                        if (glassParams.refraction != null) originalData.refraction = glassParams.refraction;
                        if (glassParams.transparency != null) originalData.transmission = 1;
                    }
                    std.userData.glassOriginal = originalData;
                }

                const original = std.userData.glassOriginal || {};

                let targetOpacity = useGlobalOpacity
                    ? clamp01(sliderOpacity)
                    : clamp01(original.opacity ?? std.opacity ?? sliderOpacity);
                let targetMetalness = useGlobalMetalness
                    ? clamp01(sliderMetal)
                    : clamp01(original.metalness ?? std.metalness ?? sliderMetal);
                let targetRoughness = useGlobalRoughness
                    ? clamp01(sliderRough)
                    : clamp01(original.roughness ?? std.roughness ?? sliderRough);
                let targetRefraction = useGlobalIor
                    ? (Number.isFinite(sliderIor) ? sliderIor : 1.5)
                    : (overrides?.refraction ?? original.refraction ?? (('ior' in std) ? std.ior : null));
                let targetColorHex = globalColorHex ?? normalizeHexColor(original.color, std.color?.isColor ? `#${std.color.getHexString().toUpperCase()}` : null);
                let targetEnvIntensity = useGlobalReflect
                    ? sliderReflect
                    : (Number.isFinite(original.envIntensity) ? original.envIntensity : currentEnvIntensity);
                const hasOverrideTransmission = overrides?.transmission != null;
                let targetTransmission = 1;
                if (useGlobalTransmission) {
                    targetTransmission = clamp01(Number.isFinite(sliderTransmission) ? sliderTransmission : 1);
                } else if (hasOverrideTransmission) {
                    targetTransmission = clamp01(overrides.transmission);
                } else if (original.transmission != null) {
                    targetTransmission = clamp01(original.transmission);
                }
                let targetAttenuationDistance = original.attenuationDistance != null ? original.attenuationDistance : (Number.isFinite(std.attenuationDistance) ? std.attenuationDistance : null);
                let targetAttenuationColorHex = normalizeHexColor(original.attenuationColor, null);
                if (useGlobalAttenDist) {
                    const fallback = Number.isFinite(sliderAttenDist) ? sliderAttenDist : (targetAttenuationDistance != null ? targetAttenuationDistance : 0.2);
                    targetAttenuationDistance = Math.max(0, fallback);
                }
                if (useGlobalAttenColor && globalAttenColorHex) {
                    targetAttenuationColorHex = globalAttenColorHex;
                }

                const hasOverrides = overrides && Object.keys(overrides).length > 0;
                if (hasOverrides) {
                    if (overrides.opacity != null) targetOpacity = clamp01(overrides.opacity);
                    if (overrides.roughness != null) targetRoughness = clamp01(overrides.roughness);
                    if (overrides.metalness != null) targetMetalness = clamp01(overrides.metalness);
                    if (overrides.transmission != null) targetTransmission = clamp01(overrides.transmission);
                    if (overrides.envIntensity != null) targetEnvIntensity = overrides.envIntensity;
                    if (overrides.color) {
                        const overrideHex = normalizeHexColor(overrides.color, targetColorHex);
                        if (overrideHex) {
                            overrides.color = overrideHex;
                            targetColorHex = overrideHex;
                        }
                    }
                    if (overrides.refraction != null && 'ior' in std) {
                        targetRefraction = overrides.refraction;
                        std.ior = overrides.refraction;
                        std.userData.refraction = overrides.refraction;
                    }
                    if (overrides.attenuationDistance != null) {
                        targetAttenuationDistance = Math.max(0, overrides.attenuationDistance);
                    }
                    if (overrides.attenuationColor) {
                        const overrideAttHex = normalizeHexColor(overrides.attenuationColor, targetAttenuationColorHex);
                        if (overrideAttHex) {
                            overrides.attenuationColor = overrideAttHex;
                            targetAttenuationColorHex = overrideAttHex;
                        }
                    }
                }

                if (isNPM && !useGlobalRoughness && !(hasOverrides && overrides?.roughness != null)) {
                    targetRoughness = 0.05;
                }
                if (isNPM && !useGlobalMetalness && !(hasOverrides && overrides?.metalness != null)) {
                    targetMetalness = 0.1;
                }
                if (targetRefraction != null && 'ior' in std) {
                    std.ior = targetRefraction;
                    std.userData.refraction = targetRefraction;
                }

                if (!targetAttenuationColorHex) {
                    targetAttenuationColorHex = normalizeHexColor(targetColorHex, null);
                } else {
                    targetAttenuationColorHex = normalizeHexColor(targetAttenuationColorHex, targetColorHex);
                }
                if (isNPM && !useGlobalTransmission && !(hasOverrides && overrides?.transmission != null)) {
                    targetTransmission = 1;
                    targetAttenuationDistance = 0.1;
                    targetAttenuationColorHex = normalizeHexColor(targetColorHex, targetAttenuationColorHex);
                }

                if (targetColorHex) {
                    try { std.color.set(targetColorHex); } catch (_) {}
                }

                const finalOpacity = clamp01(targetOpacity);
                std.opacity = finalOpacity;
                if (!std.metalnessMap) std.metalness = clamp01(targetMetalness);
                if (!std.roughnessMap) std.roughness = clamp01(targetRoughness);
                std.envMapIntensity = targetEnvIntensity;
                if (std.isMeshPhysicalMaterial) {
                    const transmission = clamp01(targetTransmission ?? 0);
                    std.transmission = transmission;
                    std.transparent = transmission > 0.01 || finalOpacity < 0.999;
                    std.opacity = finalOpacity;
                    std.thickness = Number.isFinite(std.thickness) ? std.thickness : 0.2;
                    std.ior = Number.isFinite(std.ior) ? std.ior : 1.5;
                    if (targetAttenuationColorHex) {
                        try {
                            if (std.attenuationColor?.isColor) std.attenuationColor.set(targetAttenuationColorHex);
                            else if (THREE?.Color) std.attenuationColor = new THREE.Color(targetAttenuationColorHex);
                        } catch (_) {}
                    }
                    if (targetAttenuationDistance != null) {
                        const dist = Math.max(0, targetAttenuationDistance);
                        std.attenuationDistance = dist;
                        if ('thickness' in std) std.thickness = dist;
                    }
                }

                const globalOverrideActive = useGlobalOpacity || useGlobalRoughness || useGlobalMetalness || useGlobalReflect || useGlobalColor || useGlobalTransmission || useGlobalIor || useGlobalAttenDist || useGlobalAttenColor;
                const infoSource = hasOverrides ? 'override' : (globalOverrideActive ? 'ui' : (glassParams ? 'geojson' : 'ui'));
                const infoColorHex = normalizeHexColor(targetColorHex ?? (std.color?.isColor ? `#${std.color.getHexString().toUpperCase()}` : null), null);
                const info = {
                    opacity: finalOpacity,
                    transparency: finalOpacity,
                    roughness: std.roughness,
                    metalness: std.metalness,
                    envIntensity: targetEnvIntensity,
                    source: infoSource,
                    colorHex: infoColorHex,
                    transmission: std.isMeshPhysicalMaterial ? clamp01(std.transmission ?? 0) : 0,
                    attenuationDistance: std.attenuationDistance,
                    attenuationColor: targetAttenuationColorHex,
                };
                if (targetRefraction != null) info.refraction = targetRefraction;
                std.userData.glassInfo = info;

                std.needsUpdate = true;

                if (Array.isArray(o.material)) { o.material[i] = std; } else { o.material = std; }
                cacheOriginalMaterialFor(o, true);
            });
        });
        requestRender();
    }

    function resetToOriginal() {
        if (!world) return;
        let firstOriginal = null;

        world.traverse(o => {
            if (o.userData?.isCollision) return;
            if (!o.isMesh || !o.material) return;
            const mats = Array.isArray(o.material) ? o.material : [o.material];
            mats.forEach((m, i) => {
                const nameStr = `${m.name || ''} ${o.name || ''}`;
                const geomSuffix = findGeomSuffix(nameStr);
                const glass = isGlassByName(nameStr) || isGlassGeomSuffix(geomSuffix);
                if (!glass) return;

                const std = toStandard(m);
                std.userData ||= {};

                const original = std.userData.glassOriginal;
                if (!original) return;
                if (!firstOriginal) firstOriginal = { ...original };

                if (std.userData.glassOverrides) delete std.userData.glassOverrides;

                if (original.opacity != null) std.opacity = clamp01(original.opacity);
                if (!std.metalnessMap && original.metalness != null) std.metalness = clamp01(original.metalness);
                if (!std.roughnessMap && original.roughness != null) std.roughness = clamp01(original.roughness);
                if (original.envIntensity != null) std.envMapIntensity = original.envIntensity;
                if (original.color) {
                    const colorHex = normalizeHexColor(original.color, null);
                    if (colorHex) {
                        try { std.color.set(colorHex); } catch (_) {}
                    }
                }
                if (original.refraction != null && 'ior' in std) {
                    std.ior = original.refraction;
                    std.userData.refraction = original.refraction;
                }
                if (original.transmission != null && 'transmission' in std) {
                    std.transmission = clamp01(original.transmission);
                    std.transparent = std.transmission > 0.01 || std.opacity < 0.999;
                }
                if (original.attenuationDistance != null && 'attenuationDistance' in std) {
                    std.attenuationDistance = original.attenuationDistance;
                }
                if (original.attenuationColor) {
                    const attHex = normalizeHexColor(original.attenuationColor, original.color || null);
                    if (attHex) {
                        try {
                            if (std.attenuationColor?.isColor) std.attenuationColor.set(attHex);
                            else if (THREE?.Color) std.attenuationColor = new THREE.Color(attHex);
                        } catch (_) {}
                    }
                }

                std.needsUpdate = true;

                if (Array.isArray(o.material)) { o.material[i] = std; } else { o.material = std; }
            });
        });

        if (firstOriginal) {
            if (glassOpacityEl && firstOriginal.opacity != null) {
                glassOpacityEl.value = clamp01(firstOriginal.opacity).toFixed(2);
                delete glassOpacityEl.dataset.userSet;
            }
            if (glassReflectEl && firstOriginal.envIntensity != null) {
                const min = Number.isFinite(parseFloat(glassReflectEl.min)) ? parseFloat(glassReflectEl.min) : 0;
                const max = Number.isFinite(parseFloat(glassReflectEl.max)) ? parseFloat(glassReflectEl.max) : 5;
                const val = Number.isFinite(firstOriginal.envIntensity) ? firstOriginal.envIntensity : parseFloat(glassReflectEl.value ?? '1');
                const clamped = Math.min(max, Math.max(min, val));
                glassReflectEl.value = clamped.toFixed(2);
                delete glassReflectEl.dataset.userSet;
            }
            if (glassMetalEl && firstOriginal.metalness != null) {
                glassMetalEl.value = clamp01(firstOriginal.metalness).toFixed(2);
                delete glassMetalEl.dataset.userSet;
            }
            if (glassRoughEl && firstOriginal.roughness != null) {
                glassRoughEl.value = clamp01(firstOriginal.roughness).toFixed(2);
                delete glassRoughEl.dataset.userSet;
            }
            if (glassIorEl && firstOriginal.refraction != null) {
                const safe = Math.min(Math.max(firstOriginal.refraction, 1.0), 2.5);
                glassIorEl.value = safe.toFixed(2);
                delete glassIorEl.dataset.userSet;
            }
            if (glassTransmissionEl && firstOriginal.transmission != null) {
                glassTransmissionEl.value = clamp01(firstOriginal.transmission).toFixed(2);
                delete glassTransmissionEl.dataset.userSet;
            }
            if (glassAttenDistEl && firstOriginal.attenuationDistance != null) {
                glassAttenDistEl.value = Number(firstOriginal.attenuationDistance).toFixed(2);
                delete glassAttenDistEl.dataset.userSet;
            }
            if (glassAttenColorEl) {
                const attHex = normalizeHexColor(firstOriginal.attenuationColor, '#FFFFFF') || '#FFFFFF';
                glassAttenColorEl.value = attHex;
                delete glassAttenColorEl.dataset.userSet;
            }
            if (glassColorEl) {
                const colorHex = normalizeHexColor(firstOriginal.color, '#FFFFFF') || '#FFFFFF';
                glassColorEl.value = colorHex;
                delete glassColorEl.dataset.userSet;
            }
        } else if (glassColorEl) {
            delete glassColorEl.dataset.userSet;
            glassOpacityEl && delete glassOpacityEl.dataset.userSet;
            glassMetalEl && delete glassMetalEl.dataset.userSet;
            glassReflectEl && delete glassReflectEl.dataset.userSet;
            glassRoughEl && delete glassRoughEl.dataset.userSet;
            glassIorEl && delete glassIorEl.dataset.userSet;
            glassTransmissionEl && delete glassTransmissionEl.dataset.userSet;
            glassAttenDistEl && delete glassAttenDistEl.dataset.userSet;
            glassAttenColorEl && delete glassAttenColorEl.dataset.userSet;
        }

        updateAllGlassDisplays();
        applyToScene();
        schedulePanelRefresh();
    }

    const handleGlobalGlassInput = () => {
        applyToScene();
        schedulePanelRefresh();
        requestRender();
    };

    const commitGlassDisplayInput = (id) => {
        const entry = glassValueDisplays.get(id);
        if (!entry) return;
        const { input: slider, display } = entry;
        if (!slider || !(display instanceof HTMLInputElement)) return;

        if (slider.type === 'color') {
            const normalized = normalizeHexColor(display.value, null);
            if (!normalized) {
                updateGlassDisplay(id);
                return;
            }
            if (slider.value === normalized) {
                slider.dataset.userSet = '1';
                updateGlassDisplay(id);
                return;
            }
            slider.value = normalized;
            display.value = normalized;
            slider.dataset.userSet = '1';
            updateGlassDisplay(id);
            handleGlobalGlassInput();
            return;
        }

        const raw = display.value.replace(',', '.').trim();
        const parsed = parseFloat(raw);
        if (!Number.isFinite(parsed)) {
            updateGlassDisplay(id);
            return;
        }

        let next = clampValueToSlider(slider, parsed);
        next = snapValueToStep(slider, next);
        next = clampValueToSlider(slider, next);

        const decimals = sliderStepDecimals(slider);
        const formatted = Number.isFinite(decimals) ? next.toFixed(decimals) : String(next);

        if (slider.value === formatted) {
            slider.dataset.userSet = '1';
            updateGlassDisplay(id);
            return;
        }

        slider.value = formatted;
        display.value = formatted;
        slider.dataset.userSet = '1';
        updateGlassDisplay(id);
        handleGlobalGlassInput();
    };

    function attachGlassDisplayInputs() {
        glassValueDisplays.forEach(({ display }, id) => {
            if (!(display instanceof HTMLInputElement)) return;
            const commit = () => commitGlassDisplayInput(id);
            display.addEventListener('change', commit);
            display.addEventListener('blur', commit);
            display.addEventListener('keydown', (event) => {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    commit();
                } else if (event.key === 'Escape') {
                    updateGlassDisplay(id);
                    display.blur();
                }
            });
        });
    }

    registerGlassDisplay('glassOpacity', glassOpacityEl);
    registerGlassDisplay('glassReflect', glassReflectEl);
    registerGlassDisplay('glassRough', glassRoughEl);
    registerGlassDisplay('glassMetal', glassMetalEl);
    registerGlassDisplay('glassIor', glassIorEl);
    registerGlassDisplay('glassTransmission', glassTransmissionEl);
    registerGlassDisplay('glassAttenDist', glassAttenDistEl);
    registerGlassDisplay('glassAttenColor', glassAttenColorEl);
    registerGlassDisplay('glassColor', glassColorEl);
    updateAllGlassDisplays();
    attachGlassDisplayInputs();

    if (glassOpacityEl) {
        glassOpacityEl.addEventListener('input', () => {
            glassOpacityEl.dataset.userSet = '1';
            updateGlassDisplay('glassOpacity');
            handleGlobalGlassInput();
        });
    }
    if (glassReflectEl) {
        glassReflectEl.addEventListener('input', () => {
            glassReflectEl.dataset.userSet = '1';
            updateGlassDisplay('glassReflect');
            handleGlobalGlassInput();
        });
    }
    if (glassMetalEl) {
        glassMetalEl.addEventListener('input', () => {
            glassMetalEl.dataset.userSet = '1';
            updateGlassDisplay('glassMetal');
            handleGlobalGlassInput();
        });
    }
    if (glassRoughEl) {
        glassRoughEl.addEventListener('input', () => {
            glassRoughEl.dataset.userSet = '1';
            updateGlassDisplay('glassRough');
            handleGlobalGlassInput();
        });
    }
    if (glassIorEl) {
        glassIorEl.addEventListener('input', () => {
            glassIorEl.dataset.userSet = '1';
            updateGlassDisplay('glassIor');
            handleGlobalGlassInput();
        });
    }
    if (glassTransmissionEl) {
        glassTransmissionEl.addEventListener('input', () => {
            glassTransmissionEl.dataset.userSet = '1';
            updateGlassDisplay('glassTransmission');
            handleGlobalGlassInput();
        });
    }
    if (glassAttenDistEl) {
        glassAttenDistEl.addEventListener('input', () => {
            glassAttenDistEl.dataset.userSet = '1';
            updateGlassDisplay('glassAttenDist');
            handleGlobalGlassInput();
        });
    }
    if (glassAttenColorEl) {
        glassAttenColorEl.addEventListener('input', () => {
            glassAttenColorEl.dataset.userSet = '1';
            updateGlassDisplay('glassAttenColor');
            handleGlobalGlassInput();
        });
    }
    if (glassColorEl) {
        glassColorEl.addEventListener('input', () => {
            glassColorEl.dataset.userSet = '1';
            updateGlassDisplay('glassColor');
            handleGlobalGlassInput();
        });
    }

    glassResetBtn?.addEventListener('click', resetToOriginal);

    return Object.freeze({
        applyToScene,
        resetToOriginal,
        updateGlassDisplay,
        updateAllGlassDisplays,
    });
}

