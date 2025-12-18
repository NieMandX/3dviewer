import { createTextureLabelResolver } from '../utils/texture-labels.js';
import { createVPMBinder } from './vpm-autobind.js';
import { createFilenameBinder } from './filename-autobind.js';

export function createAutobindPipeline(options = {}) {
    const THREE = options.THREE;
    if (!THREE) throw new Error('createAutobindPipeline: THREE is required');

    const basename = typeof options.basename === 'function' ? options.basename : (p) => (p || '').split(/[\\/]/).pop();
    const toStandard = typeof options.toStandard === 'function' ? options.toStandard : null;
    const textureLoader = options.textureLoader || null;
    const copyTextureSettings = typeof options.copyTextureSettings === 'function' ? options.copyTextureSettings : () => {};
    const cacheOriginalMaterialFor =
        typeof options.cacheOriginalMaterialFor === 'function' ? options.cacheOriginalMaterialFor : () => {};
    const requestRender = typeof options.requestRender === 'function' ? options.requestRender : () => {};
    const materialsPanel = options.materialsPanel || null;
    const schedulePanelRefresh = typeof options.schedulePanelRefresh === 'function' ? options.schedulePanelRefresh : () => {};
    const logBind = typeof options.logBind === 'function' ? options.logBind : () => {};

    const loadedModels = Array.isArray(options.loadedModels) ? options.loadedModels : [];

    const detectSlotFromMatOrObj =
        typeof options.detectSlotFromMatOrObj === 'function' ? options.detectSlotFromMatOrObj : () => null;
    const findGeomSuffix = typeof options.findGeomSuffix === 'function' ? options.findGeomSuffix : () => null;
    const geomSuffixes = Array.isArray(options.geomSuffixes) ? options.geomSuffixes : [];
    const guessKindFromName = typeof options.guessKindFromName === 'function' ? options.guessKindFromName : () => '';
    const isGlassByName = typeof options.isGlassByName === 'function' ? options.isGlassByName : () => false;
    const isGlassGeomSuffix = typeof options.isGlassGeomSuffix === 'function' ? options.isGlassGeomSuffix : () => false;

    const undoStack = Array.isArray(options.undoStack) ? options.undoStack : [];

    const getEnvironment = typeof options.getEnvironment === 'function' ? options.getEnvironment : () => null;
    const getEnvMapIntensity = typeof options.getEnvMapIntensity === 'function' ? options.getEnvMapIntensity : () => 1;
    const isWebGL2 = typeof options.isWebGL2 === 'function' ? options.isWebGL2 : () => false;

    const getEntries = typeof options.getEntries === 'function'
        ? options.getEntries
        : () => (Array.isArray(options.allEmbedded) ? options.allEmbedded : []);

    const { labelFromURL } = createTextureLabelResolver({ getEntries });

    const vpmBinder = createVPMBinder({
        THREE,
        basename,
        labelFromURL,
        toStandard,
        textureLoader,
        copyTextureSettings,
        cacheOriginalMaterialFor,
        requestRender,
        materialsPanel,
        schedulePanelRefresh,
        logBind,
        loadedModels,
        detectSlotFromMatOrObj,
        findGeomSuffix,
        isGlassByName,
        isGlassGeomSuffix,
        getEnvironment,
        getEnvMapIntensity,
        isWebGL2,
    });

    function buildVPMIndex(allImages) {
        return vpmBinder.buildVPMIndex(allImages);
    }

    async function autoBindVPMForModel(root, vpmIndex) {
        return vpmBinder.autoBindVPMForModel(root, vpmIndex);
    }

    const filenameBinder = createFilenameBinder({
        THREE,
        basename,
        geomSuffixes,
        guessKindFromName,
        findGeomSuffix,
        toStandard,
        textureLoader,
        copyTextureSettings,
        cacheOriginalMaterialFor,
        logBind,
        undoStack,
        getEnvironment,
        getEnvMapIntensity,
    });

    function autoBindByNamesForModel(root, fileName, embeddedList) {
        return filenameBinder.autoBindByNamesForModel(root, fileName, embeddedList);
    }

    return {
        labelFromURL,
        buildVPMIndex,
        autoBindVPMForModel,
        autoBindByNamesForModel,
    };
}

