import * as THREE from 'three';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { createLoadedModelSceneIndex } from '../scene/loaded-model-scene-index.js';

export const DEFAULT_ENV_URL = 'exr/forest-01-1024.exr';
export const FALLBACK_HDR_URL = 'hdr/royal_esplanade_1k.hdr';

export const HDRI_LIBRARY = [
    { name: "Forest EXR (local)", url: DEFAULT_ENV_URL },
    { name: "Royal Esplanade",    url: "hdr/royal_esplanade_1k.hdr" },
    { name: "Venice Sunset",      url: "hdr/venice_sunset_1k.hdr" },
    // { name: "Blouberg Sunrise",   url: "https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/blouberg_sunrise_1k.hdr" },
    // { name: "Tropical Beach",     url: "https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/tropical_beach_1k.hdr" },
    // { name: "Country Field",      url: "https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/country_field_1k.hdr" },
    // { name: "Construction Site",  url: "https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/construction_1k.hdr" },
    { name: "Skyline Rooftop",    url: "hdr/roof_garden_1k.hdr" },
    // { name: "City Overpass",      url: "https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/urban_overpass_1k.hdr" },
    // { name: "Forest Trail",       url: "https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/forest_trail_1k.hdr" },
    { name: "Rocky Ridge",        url: "hdr/rocky_ridge_1k.hdr" },
    { name: "Mountain Sunset",    url: "hdr/mountain_sunset_1k.hdr" },
    // { name: "Industrial Yard",    url: "https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/industrial_pipe_1k.hdr" },
    // { name: "Tokyo Night",        url: "https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/tokyo_neon_1k.hdr" },
    // { name: "Small Hangar",       url: "https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/hangar_1k.hdr" },
    { name: "Studio Small",       url: "hdr/studio_small_09_1k.hdr" }
];

export function createEnvironmentManager(options = {}) {
    const renderer = options.renderer || null;
    const scene = options.scene || null;
    const world = options.world || null;
    const app = options.app || null;
    let loadedModels = Array.isArray(options.loadedModels) ? options.loadedModels : [];
    let sceneIndex = options.sceneIndex || (loadedModels.length ? createLoadedModelSceneIndex({ loadedModels }) : null);

    const requestRender = typeof options.requestRender === 'function' ? options.requestRender : () => {};
    const ensureBgMesh = typeof options.ensureBgMesh === 'function' ? options.ensureBgMesh : () => null;
    const getBgMesh = typeof options.getBgMesh === 'function' ? options.getBgMesh : () => null;
    const updateBgVisibility = typeof options.updateBgVisibility === 'function' ? options.updateBgVisibility : () => {};
    const applyGlassControlsToScene = typeof options.applyGlassControlsToScene === 'function' ? options.applyGlassControlsToScene : () => {};
    const onEnvironmentUpdated = typeof options.onEnvironmentUpdated === 'function' ? options.onEnvironmentUpdated : null;

    const useWebGPU = !!options.useWebGPU;
    const rendererInitPromise = options.rendererInitPromise || Promise.resolve();

    const iblGammaEl = options.iblGammaEl || null;
    const iblTintEl = options.iblTintEl || null;
    const hdriExposureEl = options.hdriExposureEl || null;
    const hdriSaturationEl = options.hdriSaturationEl || null;
    const hdriBlurEl = options.hdriBlurEl || null;

    const getIntensity = typeof options.getIntensity === 'function' ? options.getIntensity : () => 1.0;

    const debounceMs = Number.isFinite(options.rebuildDebounceMs) ? options.rebuildDebounceMs : 150;

    let enabled = !!options.enabled;

    let pmremGen = app?.pmremGen || null;
    let hdrBaseTex = app?.hdrBaseTex || null;
    let currentEnv = app?.currentEnv || null;
    let currentBg = app?.currentBg || null;

    let currentRotDeg = Number.isFinite(options.initialRotationDeg) ? options.initialRotationDeg : (Number.isFinite(app?.currentRotDeg) ? app.currentRotDeg : 0);

    let envDirty = true;
    let envRebuildTimer = null;
    let envRebuildPromise = null;
    let envRebuildQueued = false;

    const envMaterials = new Set();
    let envMaterialsDirty = true;
    let envMaterialsKey = '';

    function setMaterialSources(next = {}) {
        loadedModels = Array.isArray(next.loadedModels) ? next.loadedModels : loadedModels;
        sceneIndex = next.sceneIndex || sceneIndex || (loadedModels.length ? createLoadedModelSceneIndex({ loadedModels }) : null);
        invalidateMaterialRegistry();
    }

    function invalidateMaterialRegistry() {
        envMaterialsDirty = true;
        envMaterialsKey = '';
    }

    function buildEnvMaterialsKey() {
        if (!Array.isArray(loadedModels) || !loadedModels.length) return '';
        return loadedModels.map((model) => String(model?.obj?.uuid || '')).join('|');
    }

    function addEnvMaterialCandidate(targetSet, material) {
        if (!material) return;
        if (Array.isArray(material)) {
            material.forEach((entry) => addEnvMaterialCandidate(targetSet, entry));
            return;
        }
        if (material.isMeshStandardMaterial || material.isMeshPhysicalMaterial) {
            targetSet.add(material);
        }
    }

    function rebuildMaterialRegistry() {
        envMaterials.clear();
        if (!sceneIndex || !Array.isArray(loadedModels) || !loadedModels.length) {
            envMaterialsKey = buildEnvMaterialsKey();
            envMaterialsDirty = false;
            return;
        }

        loadedModels.forEach((model) => {
            sceneIndex.getModelRenderables(model).forEach((obj) => {
                if (!obj?.isMesh) return;
                addEnvMaterialCandidate(envMaterials, obj.material);
                addEnvMaterialCandidate(envMaterials, obj.userData?._origMaterial);
            });
        });

        envMaterialsKey = buildEnvMaterialsKey();
        envMaterialsDirty = false;
    }

    function ensureMaterialRegistry() {
        const nextKey = buildEnvMaterialsKey();
        if (envMaterialsDirty || envMaterialsKey !== nextKey) {
            rebuildMaterialRegistry();
        }
    }

    function flipHDRTextureVertically(srcTex) {
        const { data, width, height } = srcTex.image;
        const channels = 4; // RGBA/RGBE
        const flipped = new (data.constructor)(data.length);

        for (let y = 0; y < height; y++) {
            const srcRow = y * width * channels;
            const dstRow = (height - 1 - y) * width * channels;
            flipped.set(data.subarray(srcRow, srcRow + width * channels), dstRow);
        }

        const tex = new THREE.DataTexture(flipped, width, height, srcTex.format, srcTex.type);
        tex.encoding = srcTex.encoding;
        tex.mapping = THREE.EquirectangularReflectionMapping;
        tex.needsUpdate = true;
        return tex;
    }

    async function loadEquirectTexture(url) {
        const lower = String(url || '').toLowerCase();
        let tex;
        if (lower.endsWith('.exr')) {
            tex = await new EXRLoader().loadAsync(url);
        } else {
            tex = await new HDRLoader().loadAsync(url);
            tex = flipHDRTextureVertically(tex);
        }
        tex.mapping = THREE.EquirectangularReflectionMapping;
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.ClampToEdgeWrapping;
        tex.flipY = false;
        if ('flipX' in tex) tex.flipX = false;
        if ('flipZ' in tex) tex.flipZ = false;
        if ('colorSpace' in tex) tex.colorSpace = THREE.LinearSRGBColorSpace;
        tex.needsUpdate = true;
        return tex;
    }

    async function loadHDRBase() {
        if (hdrBaseTex) return hdrBaseTex;
        try {
            hdrBaseTex = await loadEquirectTexture(DEFAULT_ENV_URL);
        } catch (err) {
            console.warn('Default EXR environment failed to load, falling back to HDR.', err);
            hdrBaseTex = await loadEquirectTexture(FALLBACK_HDR_URL);
        }
        if (app) app.hdrBaseTex = hdrBaseTex;
        return hdrBaseTex;
    }

    function cloneEquirectDataTexture(srcTex) {
        if (!srcTex) return null;
        const img = srcTex.image;
        const data = img?.data;
        const width = img?.width;
        const height = img?.height;
        if (!data || !width || !height) {
            const clone = srcTex.clone?.() || srcTex;
            if (clone && clone !== srcTex) clone.needsUpdate = true;
            return clone;
        }

        const copied = data.slice ? data.slice() : new data.constructor(data);
        const tex = new THREE.DataTexture(copied, width, height, srcTex.format, srcTex.type);

        tex.name = srcTex.name || tex.name;
        tex.mapping = srcTex.mapping;
        tex.wrapS = srcTex.wrapS;
        tex.wrapT = srcTex.wrapT;
        tex.magFilter = srcTex.magFilter;
        tex.minFilter = srcTex.minFilter;
        tex.anisotropy = srcTex.anisotropy;
        tex.generateMipmaps = srcTex.generateMipmaps;
        tex.flipY = srcTex.flipY;
        if ('colorSpace' in srcTex && 'colorSpace' in tex) tex.colorSpace = srcTex.colorSpace;
        if ('encoding' in srcTex && 'encoding' in tex) tex.encoding = srcTex.encoding;
        if ('premultiplyAlpha' in srcTex && 'premultiplyAlpha' in tex) tex.premultiplyAlpha = srcTex.premultiplyAlpha;
        if ('unpackAlignment' in srcTex && 'unpackAlignment' in tex) tex.unpackAlignment = srcTex.unpackAlignment;
        tex.needsUpdate = true;
        return tex;
    }

    function setRotation(deg, { silent = false } = {}) {
        const safeDeg = Number.isFinite(deg) ? deg : 0;
        currentRotDeg = safeDeg;
        if (app) app.currentRotDeg = currentRotDeg;
        const rad = THREE.MathUtils.degToRad(currentRotDeg);

        if (scene?.environmentRotation?.isEuler) {
            scene.environmentRotation.set(0, rad, 0);
        }
        if (scene?.backgroundRotation?.isEuler) {
            scene.backgroundRotation.set(0, rad, 0);
        }

        const bgMesh = getBgMesh?.();
        if (bgMesh) {
            bgMesh.rotation.y = rad;
        }

        ensureMaterialRegistry();
        envMaterials.forEach((mat) => {
            if (!mat) return;
            if (mat.envMapRotation?.isEuler) {
                mat.envMapRotation.set(0, rad, 0);
            }
        });

        requestRender();
        if (!silent) {
            onEnvironmentUpdated?.({ type: 'rotation' });
        }
    }

    function applyEnvToMaterials(env, intensity, { silent = false } = {}) {
        if (scene) {
            scene.environmentIntensity = env ? intensity : 0;
        }
        ensureMaterialRegistry();
        envMaterials.forEach((m) => {
            if (!m) return;
            if (m.envMap !== env) {
                m.envMap = env;
                m.needsUpdate = true;
            }
            m.envMapIntensity = intensity;
        });

        requestRender();
        if (!silent) {
            onEnvironmentUpdated?.({ type: 'intensity' });
        }
    }

    function applyBuiltEnvironment() {
        if (!enabled) return;
        if (!currentEnv || !currentBg) return;

        if (scene) scene.environment = currentEnv;
        applyEnvToMaterials(scene?.environment || currentEnv, parseFloat(getIntensity()) || 1.0, { silent: true });

        const bgMesh = ensureBgMesh?.();
        if (bgMesh) {
            bgMesh.material.map = currentBg;
            bgMesh.material.needsUpdate = true;
        }

        setRotation(currentRotDeg, { silent: true });
        updateBgVisibility?.();
        requestRender();
        onEnvironmentUpdated?.({ type: 'rebuild' });
    }

    function requestRebuild({ immediate = false } = {}) {
        envDirty = true;
        if (!enabled) return;
        if (envRebuildTimer) {
            clearTimeout(envRebuildTimer);
            envRebuildTimer = null;
        }
        const delay = immediate ? 0 : debounceMs;
        envRebuildTimer = setTimeout(() => {
            envRebuildTimer = null;
            void rebuild({ force: true });
        }, delay);
    }

    function clampNumericInput(value, min, max) {
        if (!Number.isFinite(value)) return null;
        if (min != null) value = Math.max(min, value);
        if (max != null) value = Math.min(max, value);
        return value;
    }

    function syncAdjustmentsState() {
        const gamma = Math.max(0.01, parseFloat(iblGammaEl?.value) || 1.0);
        const tintHex = (iblTintEl?.value && /^#/u.test(iblTintEl.value)) ? iblTintEl.value : '#ffffff';
        const tintLinear = new THREE.Color(tintHex).convertSRGBToLinear();
        const exposure = clampNumericInput(parseFloat(hdriExposureEl?.value), 0, 2) ?? 1;
        const saturation = clampNumericInput(parseFloat(hdriSaturationEl?.value), 0, 2) ?? 1;
        const blur = clampNumericInput(parseFloat(hdriBlurEl?.value), 0, 1) ?? 0;
        const state = { gamma, tintHex, tintLinear, exposure, saturation, blur };
        if (app) app.envAdjustments = state;
        return state;
    }

    function applySimpleBlurToData(data, width, height, stride, amount) {
        if (!(amount > 1e-3)) return;
        const neighborWeight = amount * 0.5;
        const centerWeight = 1;
        const totalWeight = centerWeight + neighborWeight * 4;
        const tmp = new (data.constructor)(data.length);

        const sampleIndex = (x, y) => {
            const sx = (x % width + width) % width;
            const sy = Math.min(height - 1, Math.max(0, y));
            return (sy * width + sx) * stride;
        };

	        for (let y = 0; y < height; y++) {
	            for (let x = 0; x < width; x++) {
	                let r = 0, g = 0, b = 0;

	                const addSample = (ix, iy, w) => {
	                    const idx = sampleIndex(ix, iy);
	                    r += data[idx] * w;
	                    g += data[idx + 1] * w;
	                    b += data[idx + 2] * w;
	                };

                addSample(x, y, centerWeight);
                addSample(x - 1, y, neighborWeight);
                addSample(x + 1, y, neighborWeight);
                addSample(x, y - 1, neighborWeight);
                addSample(x, y + 1, neighborWeight);

                const outIdx = (y * width + x) * stride;
                tmp[outIdx] = r / totalWeight;
                tmp[outIdx + 1] = g / totalWeight;
                tmp[outIdx + 2] = b / totalWeight;
                if (stride > 3) tmp[outIdx + 3] = data[outIdx + 3];
            }
        }

        data.set(tmp);
    }

    function applyHDRAdjustments(dataTex, {
        gamma = 1.0,
        tintColor = null,
        exposure = 1.0,
        saturation = 1.0,
        blur = 0.0,
    } = {}) {
        if (!dataTex?.image?.data) return dataTex;

        const img = dataTex.image;
        const data = img.data;
        const width = img.width;
        const height = img.height;
        const stride = Math.max(3, Math.round(data.length / Math.max(1, width * height)) || 4);

        const hasTint = tintColor && tintColor.isColor;
        const tr = hasTint ? tintColor.r : 1.0;
        const tg = hasTint ? tintColor.g : 1.0;
        const tb = hasTint ? tintColor.b : 1.0;

        const invGamma = gamma !== 0 ? (1.0 / gamma) : 1.0;
        const exp = Number.isFinite(exposure) ? Math.max(0, exposure) : 1.0;
        const sat = Number.isFinite(saturation) ? Math.max(0, saturation) : 1.0;
        const hasBlur = Number.isFinite(blur) && blur > 1e-3;

        for (let i = 0; i < data.length; i += stride) {
            let r = data[i];
            let g = data[i + 1];
            let b = data[i + 2];

            if (hasTint) {
                r *= tr;
                g *= tg;
                b *= tb;
            }

            if (exp !== 1.0) {
                r *= exp;
                g *= exp;
                b *= exp;
            }

            if (invGamma !== 1.0) {
                r = Math.pow(Math.max(0, r), invGamma);
                g = Math.pow(Math.max(0, g), invGamma);
                b = Math.pow(Math.max(0, b), invGamma);
            }

            if (sat !== 1.0) {
                const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
                r = lum + (r - lum) * sat;
                g = lum + (g - lum) * sat;
                b = lum + (b - lum) * sat;
            }

            data[i] = r;
            data[i + 1] = g;
            data[i + 2] = b;
        }

        if (hasBlur) {
            applySimpleBlurToData(data, width, height, stride, blur);
        }

        dataTex.needsUpdate = true;
        return dataTex;
    }

    async function rebuildOnce() {
        if (!enabled) return;
        if (!envDirty && currentEnv && currentBg) {
            applyBuiltEnvironment();
            return;
        }

        if (useWebGPU) {
            try {
                await rendererInitPromise;
            } catch (err) {
                console.error('WebGPU init failed before env build', err);
                return;
            }
        }

        const base = await loadHDRBase();
        if (!base) return;

        const { gamma, tintLinear, exposure, saturation, blur } = syncAdjustmentsState();

        const nextBg = cloneEquirectDataTexture(base);
        if (!nextBg) return;

        applyHDRAdjustments(nextBg, { gamma, tintColor: tintLinear, exposure, saturation, blur });
        nextBg.mapping = THREE.EquirectangularReflectionMapping;
        if ('colorSpace' in nextBg) {
            nextBg.colorSpace = THREE.LinearSRGBColorSpace;
        }
        nextBg.needsUpdate = true;

        let nextEnv = null;
        if (useWebGPU) {
            nextBg.needsPMREMUpdate = true;
            nextEnv = nextBg;
        } else {
            if (!pmremGen) {
                pmremGen = new THREE.PMREMGenerator(renderer);
                if (app) app.pmremGen = pmremGen;
            }
            const rt = pmremGen.fromEquirectangular(nextBg);
            nextEnv = rt.texture;
        }

        if (!nextEnv) {
            nextBg.dispose?.();
            return;
        }

        const prevEnv = currentEnv;
        const prevBg = currentBg;

        currentEnv = nextEnv;
        currentBg = nextBg;
        if (app) {
            app.currentEnv = currentEnv;
            app.currentBg = currentBg;
        }

        envDirty = false;

        if (prevEnv && prevEnv !== base && prevEnv !== prevBg) prevEnv.dispose?.();
        if (prevBg && prevBg !== base) prevBg.dispose?.();

        applyBuiltEnvironment();
    }

    async function rebuild({ force = false } = {}) {
        if (!enabled) return;
        if (!force && !envDirty && currentEnv && currentBg) {
            applyBuiltEnvironment();
            return;
        }

        envDirty = true;

        if (envRebuildPromise) {
            envRebuildQueued = true;
            return envRebuildPromise;
        }

        envRebuildPromise = (async () => {
            do {
                envRebuildQueued = false;
                await rebuildOnce();
            } while (envRebuildQueued);
        })().finally(() => {
            envRebuildPromise = null;
        });

        return envRebuildPromise;
    }

    async function setEnabled(on) {
        const next = !!on;
        enabled = next;
        if (enabled) {
            if (!currentEnv || !currentBg) envDirty = true;
            await rebuild({ force: false });
        } else {
            if (envRebuildTimer) {
                clearTimeout(envRebuildTimer);
                envRebuildTimer = null;
            }
            envRebuildQueued = false;
            if (scene) scene.environment = null;
            applyEnvToMaterials(null, 1.0, { silent: true });
            const bgMesh = getBgMesh?.();
            if (bgMesh) bgMesh.visible = false;
        }
        updateBgVisibility?.();
        applyGlassControlsToScene?.();
        onEnvironmentUpdated?.({ type: 'toggle', enabled });
    }

    async function buildAndApplyFromRotation(deg) {
        setRotation(deg, { silent: true });
        await rebuild({ force: false });
    }

    async function selectPresetIndex(idx) {
        const entry = HDRI_LIBRARY[idx];
        if (!entry) return;

        const prevBase = hdrBaseTex;
        hdrBaseTex = await loadEquirectTexture(entry.url);
        if (app) app.hdrBaseTex = hdrBaseTex;

        envDirty = true;
        if (prevBase && prevBase !== hdrBaseTex && prevBase !== currentBg) {
            prevBase.dispose?.();
        }

        if (enabled) {
            await rebuild({ force: true });
        }
    }

    function getCurrentEnv() {
        return currentEnv;
    }

    function getCurrentBg() {
        return currentBg;
    }

    function getHDRBase() {
        return hdrBaseTex;
    }

    function isEnabled() {
        return enabled;
    }

    return Object.freeze({
        setEnabled,
        isEnabled,
        setMaterialSources,
        invalidateMaterialRegistry,
        requestRebuild,
        rebuild,
        loadHDRBase,
        selectPresetIndex,
        syncAdjustmentsState,
        applyEnvToMaterials,
        setRotation,
        buildAndApplyFromRotation,
        getCurrentEnv,
        getCurrentBg,
        getHDRBase,
    });
}
