import {
    disposeUnusedMaterialTree,
    loadedModelsUseTexture,
    objectTreeUsesTexture,
} from '../material/texture-utils.js';

export function createTextureModalController(options = {}) {
    const texModalEl = options.texModalEl || null;
    const closeBtnEl = options.closeBtnEl || null;
    const imgEl = options.imgEl || null;
    const titleEl = options.titleEl || null;
    const fileEl = options.fileEl || null;
    const kindEl = options.kindEl || null;
    const mimeEl = options.mimeEl || null;
    const downloadLinkEl = options.downloadLinkEl || null;
    const bindBtnEl = options.bindBtnEl || null;
    const slotSelectEl = options.slotSelectEl || null;
    const matSelectEl = options.matSelectEl || null;

    const basename = typeof options.basename === 'function' ? options.basename : (p) => (p || '').split(/[\\/]/).pop();
    const guessKindFromName = typeof options.guessKindFromName === 'function' ? options.guessKindFromName : () => 'other';

    const getSelectedMaterialLink = typeof options.getSelectedMaterialLink === 'function' ? options.getSelectedMaterialLink : () => null;
    const loadedModels = Array.isArray(options.loadedModels) ? options.loadedModels : null;
    const world = options.world || null;
    const textureLoader = options.textureLoader || null;
    const toStandard = typeof options.toStandard === 'function' ? options.toStandard : (m) => m;
    const copyTextureSettings = typeof options.copyTextureSettings === 'function' ? options.copyTextureSettings : () => {};

    const getEnvironment = typeof options.getEnvironment === 'function' ? options.getEnvironment : () => null;
    const getEnvMapIntensity = typeof options.getEnvMapIntensity === 'function' ? options.getEnvMapIntensity : () => 1;

    const cacheOriginalMaterialFor = typeof options.cacheOriginalMaterialFor === 'function' ? options.cacheOriginalMaterialFor : () => {};
    const applyGlassControlsToScene = typeof options.applyGlassControlsToScene === 'function' ? options.applyGlassControlsToScene : () => {};
    const schedulePanelRefresh = typeof options.schedulePanelRefresh === 'function' ? options.schedulePanelRefresh : () => {};
    const logBind = typeof options.logBind === 'function' ? options.logBind : () => {};

    const notify = typeof options.alert === 'function'
        ? options.alert
        : (typeof globalThis !== 'undefined' && typeof globalThis.alert === 'function' ? globalThis.alert.bind(globalThis) : null);

    const colorSpaces = options.colorSpaces || null;
    const linearColorSpace = colorSpaces?.linear;
    const srgbColorSpace = colorSpaces?.srgb;

    let modalTex = null;
    let disposed = false;

    function isTextureStillUsed(texture) {
        if (!texture?.isTexture) return false;
        if (loadedModels && loadedModelsUseTexture(loadedModels, texture)) return true;
        return objectTreeUsesTexture(world, texture);
    }

    function clearModalEntry() {
        modalTex = null;
        if (imgEl) imgEl.removeAttribute('src');
        if (titleEl) titleEl.textContent = '';
        if (fileEl) fileEl.textContent = '';
        if (kindEl) kindEl.textContent = '';
        if (mimeEl) mimeEl.textContent = '';
        if (downloadLinkEl) {
            downloadLinkEl.removeAttribute('href');
            downloadLinkEl.removeAttribute('download');
        }
    }

    function close() {
        texModalEl?.classList?.remove?.('show');
    }

    function open(entry) {
        if (disposed) return;
        if (!entry) return;
        modalTex = entry;

        if (imgEl) imgEl.src = entry.url || '';
        if (titleEl) titleEl.textContent = (entry.full || entry.short || '') + (entry.fileName ? ` — ${entry.fileName}` : '');
        if (fileEl) fileEl.textContent = entry.short || '';
        if (kindEl) kindEl.textContent = guessKindFromName(entry.short);
        if (mimeEl) mimeEl.textContent = entry.mime || '';
        if (downloadLinkEl) {
            downloadLinkEl.href = entry.url || '';
            downloadLinkEl.download = basename(entry.short);
        }

        texModalEl?.classList?.add?.('show');

        if (matSelectEl && (matSelectEl.value === '' || matSelectEl.selectedIndex <= 0) && matSelectEl.options.length > 1) {
            matSelectEl.selectedIndex = 1;
        }

        const k = guessKindFromName(entry.short);
        if (slotSelectEl) {
            slotSelectEl.value = k === 'base'
                ? 'map'
                : k === 'alpha'
                    ? 'alphaMap'
                    : k === 'normal'
                        ? 'normalMap'
                        : k === 'ao'
                            ? 'aoMap'
                            : (k === 'roughness' || k === 'gloss')
                                ? 'roughnessMap'
                                : k === 'metalness'
                                    ? 'metalnessMap'
                                    : 'map';
        }
    }

    function bindSelected() {
        if (disposed) return;
        if (!modalTex) return;
        if (!modalTex.url) {
            notify?.('Текстура больше недоступна');
            return;
        }

        const link = getSelectedMaterialLink();
        if (!link || !link.mat) {
            notify?.('Выберите материал в списке');
            return;
        }

        if (!textureLoader) return;
        const slot = slotSelectEl?.value || 'map';
        const linear = !(slot === 'map' || slot === 'emissiveMap');
        const humanName = basename(modalTex.full || modalTex.short);

        // делаем PBR-эквивалент и назначаем карту на НОВЫЙ материал
        const previousMaterial = link.mat;
        let std = toStandard(previousMaterial);

        let prevTex = null;
        if (slot === 'roughnessMap') prevTex = std.roughnessMap || null;
        else if (slot === 'metalnessMap') prevTex = std.metalnessMap || null;
        else if (slot === 'alphaMap') prevTex = std.alphaMap || null;
        else prevTex = std[slot] || null;

        const existingName = prevTex && (prevTex.userData?.origName || prevTex.name || '').toLowerCase();
        const newName = humanName.toLowerCase();
        if (existingName && existingName === newName) {
            if (std !== previousMaterial) {
                disposeUnusedMaterialTree(std, { world, loadedModels });
            }
            logBind(`${modalTex.short} → ${std.name || 'материал'}.${slot} уже назначена`, 'info');
            return;
        }

        const t = textureLoader.load(modalTex.url);
        t.name = humanName;
        (t.userData ||= {}).origName = humanName;
        if (linearColorSpace && srgbColorSpace) {
            t.colorSpace = linear ? linearColorSpace : srgbColorSpace;
        }

        if (slot === 'roughnessMap') { std.roughnessMap = t; std.roughness = 0.6; }
        else if (slot === 'metalnessMap') { std.metalnessMap = t; std.metalness = 1.0; }
        else if (slot === 'alphaMap') { std.alphaMap = t; std.alphaTest = 0.5; std.transparent = false; std.depthWrite = true; }
        else { std[slot] = t; }

        copyTextureSettings(prevTex, t);

        const env = getEnvironment();
        if (env) {
            std.envMap = env;
            std.envMapIntensity = parseFloat(getEnvMapIntensity());
        }
        std.needsUpdate = true;

        // ВАЖНО: подменяем материал у меша
        const { obj, index } = link;
        if (Array.isArray(obj.material)) {
            obj.material[index] = std;
        } else {
            obj.material = std;
        }
        cacheOriginalMaterialFor(obj, true);
        let disposedPrevTex = false;
        if (prevTex && !isTextureStillUsed(prevTex)) {
            prevTex.dispose?.();
            disposedPrevTex = true;
        }
        if (std !== previousMaterial) {
            disposeUnusedMaterialTree(previousMaterial, {
                world,
                loadedModels,
                sharedTextures: disposedPrevTex ? [prevTex] : [],
            });
        }

        applyGlassControlsToScene();  // опционально
        schedulePanelRefresh();
        logBind(`${modalTex.short} → ${std.name || 'материал'}.${slot}`, 'ok');
    }

    function isSameTextureEntry(left, right) {
        if (!left || !right) return false;
        if (left === right) return true;
        const leftUrl = String(left.url || '');
        const rightUrl = String(right.url || '');
        if (leftUrl && rightUrl && leftUrl === rightUrl) return true;
        const leftFull = String(left.full || '');
        const rightFull = String(right.full || '');
        const leftShort = String(left.short || '');
        const rightShort = String(right.short || '');
        return !!leftFull && leftFull === rightFull && leftShort === rightShort;
    }

    function reconcileEntries(entries = []) {
        if (disposed) return;
        if (!modalTex) return;
        const list = Array.isArray(entries) ? entries : [];
        if (list.some((entry) => isSameTextureEntry(modalTex, entry))) return;
        close();
        clearModalEntry();
    }

    const handleModalClick = (e) => {
        if (e.target === texModalEl) close();
    };

    if (closeBtnEl) closeBtnEl.addEventListener('click', close);
    if (texModalEl) {
        texModalEl.addEventListener('click', handleModalClick);
    }
    if (bindBtnEl) bindBtnEl.addEventListener('click', bindSelected);

    function dispose() {
        if (disposed) return;
        disposed = true;
        if (closeBtnEl) closeBtnEl.removeEventListener('click', close);
        if (texModalEl) texModalEl.removeEventListener('click', handleModalClick);
        if (bindBtnEl) bindBtnEl.removeEventListener('click', bindSelected);
        close();
        clearModalEntry();
    }

    return Object.freeze({
        open,
        close,
        bindSelected,
        reconcileEntries,
        dispose,
        getEntry: () => modalTex,
    });
}
