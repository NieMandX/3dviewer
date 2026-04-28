import { createTextureGalleryController } from './texture-gallery.js';
import { createTextureModalController } from './texture-modal.js';

export function createTexturesUI(options = {}) {
    const THREE = options.THREE;
    if (!THREE) throw new Error('createTexturesUI: THREE is required');

    const dom = options.dom || {};

    const matSelectEl = options.matSelectEl || null;

    const basename = typeof options.basename === 'function'
        ? options.basename
        : (p) => (p || '').split(/[\\/]/).pop();

    const guessKindFromName = typeof options.guessKindFromName === 'function'
        ? options.guessKindFromName
        : () => '';

    const getSelectedMaterialLink = typeof options.getSelectedMaterialLink === 'function'
        ? options.getSelectedMaterialLink
        : () => null;

    const textureLoader = options.textureLoader || null;
    const toStandard = typeof options.toStandard === 'function' ? options.toStandard : null;

    const copyTextureSettings = typeof options.copyTextureSettings === 'function'
        ? options.copyTextureSettings
        : () => {};

    const getEnvironment = typeof options.getEnvironment === 'function' ? options.getEnvironment : () => null;
    const getEnvMapIntensity = typeof options.getEnvMapIntensity === 'function' ? options.getEnvMapIntensity : () => 1;

    const cacheOriginalMaterialFor = typeof options.cacheOriginalMaterialFor === 'function'
        ? options.cacheOriginalMaterialFor
        : () => {};

    const applyGlassControlsToScene = typeof options.applyGlassControlsToScene === 'function'
        ? options.applyGlassControlsToScene
        : () => {};

    const schedulePanelRefresh = typeof options.schedulePanelRefresh === 'function'
        ? options.schedulePanelRefresh
        : () => {};

    const logBind = typeof options.logBind === 'function' ? options.logBind : () => {};

    const markGalleryRendered = typeof options.markGalleryRendered === 'function'
        ? options.markGalleryRendered
        : () => {};

    const textureModal = createTextureModalController({
        texModalEl: dom.texModal,
        closeBtnEl: dom.mClose,
        imgEl: dom.mImg,
        titleEl: dom.mTitle,
        fileEl: dom.mFile,
        kindEl: dom.mKind,
        mimeEl: dom.mMime,
        downloadLinkEl: dom.dlLink,
        bindBtnEl: dom.bindBtn,
        slotSelectEl: dom.slotSelect,
        matSelectEl,
        basename,
        guessKindFromName,
        getSelectedMaterialLink,
        textureLoader,
        toStandard,
        copyTextureSettings,
        getEnvironment,
        getEnvMapIntensity,
        cacheOriginalMaterialFor,
        applyGlassControlsToScene,
        schedulePanelRefresh,
        logBind,
        colorSpaces: {
            linear: THREE.LinearSRGBColorSpace,
            srgb: THREE.SRGBColorSpace,
        },
    });

    const textureGallery = createTextureGalleryController({
        galleryEl: dom.galleryEl,
        texCountEl: dom.texCountEl,
        basename,
        guessKindFromName,
        onOpen: textureModal.open,
    });

    function renderGallery(listAll) {
        textureGallery.render(listAll);
        markGalleryRendered();
    }

    return {
        textureModal,
        textureGallery,
        renderGallery,
        dispose: () => textureModal?.dispose?.(),
    };
}
