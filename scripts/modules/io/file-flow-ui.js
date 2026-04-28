import { createFileFlowController } from './file-flow.js';
import { createSampleLoader } from './sample-loader.js';

export function createFileFlowUIController(options = {}) {
    const statusEl = options.statusEl || null;
    const sampleSelect = options.sampleSelect || null;
    const sampleModels = Array.isArray(options.sampleModels) ? options.sampleModels : [];

    const setStatusMessage = typeof options.setStatusMessage === 'function' ? options.setStatusMessage : () => {};
    const setEmptyHintVisible = typeof options.setEmptyHintVisible === 'function' ? options.setEmptyHintVisible : () => {};
    const hideSidePanel = typeof options.hideSidePanel === 'function' ? options.hideSidePanel : () => {};

    const handleFBXFile = typeof options.handleFBXFile === 'function' ? options.handleFBXFile : async () => {};
    const handleZIPFile = typeof options.handleZIPFile === 'function' ? options.handleZIPFile : async () => {};
    const finalizeBatchAfterAllFiles =
        typeof options.finalizeBatchAfterAllFiles === 'function' ? options.finalizeBatchAfterAllFiles : async () => {};
    const getLoadedModelCount = typeof options.getLoadedModelCount === 'function' ? options.getLoadedModelCount : () => 0;
    const onSampleChosen = typeof options.onSampleChosen === 'function' ? options.onSampleChosen : () => {};

    const sampleLoader = createSampleLoader({
        statusEl,
        sampleSelect,
        setStatusMessage,
        setEmptyHintVisible,
        hideSidePanel,
        handleZIPFile,
        finalizeBatchAfterAllFiles,
        getLoadedModelCount,
    });

    const fileFlow = createFileFlowController({
        fileInput: options.fileInput || null,
        openBtn: options.openBtn || null,
        emptyHintEl: options.emptyHintEl || null,
        rootEl: options.rootEl || null,
        dropEl: options.dropEl || null,
        sampleSelect,
        sampleModels,
        handleFBXFile,
        handleZIPFile,
        finalizeBatchAfterAllFiles,
        loadSampleModel: sampleLoader.loadSampleModel,
        onSampleChosen,
        setEmptyHintVisible,
        getLoadedModelCount,
    });

    return {
        loadSampleModel: sampleLoader.loadSampleModel,
        populateSampleSelect: fileFlow.populateSampleSelect,
        dispose: fileFlow.dispose,
    };
}
