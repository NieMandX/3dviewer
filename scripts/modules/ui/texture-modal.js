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

    function close() {
        texModalEl?.classList?.remove?.('show');
    }

    function open(entry) {
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
        if (!modalTex) return;

        const link = getSelectedMaterialLink();
        if (!link || !link.mat) {
            notify?.('Выберите материал в списке');
            return;
        }

        if (!textureLoader) return;
        const slot = slotSelectEl?.value || 'map';
        const linear = !(slot === 'map' || slot === 'emissiveMap');

        const t = textureLoader.load(modalTex.url);
        const humanName = basename(modalTex.full || modalTex.short);
        t.name = humanName;
        (t.userData ||= {}).origName = humanName;
        if (linearColorSpace && srgbColorSpace) {
            t.colorSpace = linear ? linearColorSpace : srgbColorSpace;
        }

        // делаем PBR-эквивалент и назначаем карту на НОВЫЙ материал
        let std = toStandard(link.mat);

        let prevTex = null;
        if (slot === 'roughnessMap') { prevTex = std.roughnessMap || null; std.roughnessMap = t; std.roughness = 0.6; }
        else if (slot === 'metalnessMap') { prevTex = std.metalnessMap || null; std.metalnessMap = t; std.metalness = 1.0; }
        else if (slot === 'alphaMap') { prevTex = std.alphaMap || null; std.alphaMap = t; std.alphaTest = 0.5; std.transparent = false; std.depthWrite = true; }
        else { prevTex = std[slot] || null; std[slot] = t; }

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

        applyGlassControlsToScene();  // опционально
        schedulePanelRefresh();
        logBind(`${modalTex.short} → ${std.name || 'материал'}.${slot}`, 'ok');
    }

    if (closeBtnEl) closeBtnEl.addEventListener('click', close);
    if (texModalEl) {
        texModalEl.addEventListener('click', (e) => {
            if (e.target === texModalEl) close();
        });
    }
    if (bindBtnEl) bindBtnEl.addEventListener('click', bindSelected);

    return Object.freeze({
        open,
        close,
        bindSelected,
        getEntry: () => modalTex,
    });
}

