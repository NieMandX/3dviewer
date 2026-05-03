export function createFileFlowController(options = {}) {
    const fileInput = options.fileInput || null;
    const openBtn = options.openBtn || null;
    const emptyHintEl = options.emptyHintEl || null;
    const rootEl = options.rootEl || null;
    const dropEl = options.dropEl || null;
    const sampleSelect = options.sampleSelect || null;
    const sampleModels = Array.isArray(options.sampleModels) ? options.sampleModels : [];

    const handleFBXFile = typeof options.handleFBXFile === 'function' ? options.handleFBXFile : async () => {};
    const handleZIPFile = typeof options.handleZIPFile === 'function' ? options.handleZIPFile : async () => {};
    const finalizeBatchAfterAllFiles =
        typeof options.finalizeBatchAfterAllFiles === 'function' ? options.finalizeBatchAfterAllFiles : async () => {};
    const loadSampleModel = typeof options.loadSampleModel === 'function' ? options.loadSampleModel : async () => {};
    const onSampleChosen = typeof options.onSampleChosen === 'function' ? options.onSampleChosen : () => {};

    const setEmptyHintVisible = typeof options.setEmptyHintVisible === 'function' ? options.setEmptyHintVisible : () => {};
    const getLoadedModelCount = typeof options.getLoadedModelCount === 'function' ? options.getLoadedModelCount : () => 0;

    const cleanupFns = [];
    const activeBatchControllers = new Set();
    let operationQueue = Promise.resolve();
    let disposed = false;

    function makeAbortError(message = 'File import aborted') {
        try {
            return new DOMException(message, 'AbortError');
        } catch (_) {
            const err = new Error(message);
            err.name = 'AbortError';
            return err;
        }
    }

    function isAbortError(error) {
        return error?.name === 'AbortError';
    }

    function createBatchController() {
        if (typeof AbortController !== 'function') return null;
        const controller = new AbortController();
        activeBatchControllers.add(controller);
        return controller;
    }

    function abortActiveBatches() {
        const reason = makeAbortError();
        activeBatchControllers.forEach((controller) => {
            try {
                if (!controller.signal?.aborted) controller.abort(reason);
            } catch (_) {}
        });
        activeBatchControllers.clear();
    }

    function registerFileOpenTrigger(el) {
        if (!el || !fileInput) return;
        const handler = () => fileInput.click();
        el.addEventListener('click', handler);
        cleanupFns.push(() => el.removeEventListener('click', handler));
    }

    function enqueueOperation(operation) {
        const queued = operationQueue
            .catch(() => {})
            .then(() => {
                if (disposed) return false;
                return operation();
            });
        operationQueue = queued.catch(() => {});
        return queued;
    }

    async function handleFiles(files, callOptions = null) {
        const errors = [];
        const signal = callOptions?.signal || null;
        for (const f of files) {
            if (disposed || signal?.aborted) break;
            try {
                if (/\.fbx$/i.test(f.name)) {
                    await handleFBXFile(f, callOptions);
                } else if (/\.zip$/i.test(f.name)) {
                    await handleZIPFile(f, callOptions);
                }
            } catch (err) {
                if (disposed || signal?.aborted || isAbortError(err)) break;
                errors.push({ file: f, error: err });
                console.error(`File import failed: ${f?.name || 'unknown'}`, err);
            }
        }
        return errors;
    }

    async function runFileBatchNow(files, { resetInput = false } = {}) {
        if (disposed || !files.length) return [];
        const controller = createBatchController();
        const signal = controller?.signal || null;
        const callOptions = signal ? { signal } : null;
        setEmptyHintVisible(false);
        try {
            return await handleFiles(files, callOptions);
        } finally {
            if (controller) activeBatchControllers.delete(controller);
            if (disposed || signal?.aborted) return;
            if (resetInput && fileInput) fileInput.value = '';
            setEmptyHintVisible(getLoadedModelCount() === 0);
            await finalizeBatchAfterAllFiles();
        }
    }

    async function runFileBatch(files, { resetInput = false } = {}) {
        const list = Array.from(files || []);
        if (disposed || !list.length) return [];
        return enqueueOperation(() => runFileBatchNow(list, { resetInput }));
    }

    function populateSampleSelect() {
        if (disposed) return;
        if (!sampleSelect) return;
        sampleSelect.innerHTML = '';
        sampleModels.forEach(sample => {
            const opt = document.createElement('option');
            opt.value = (sample.files && sample.files[0]) || '';
            opt.textContent = sample.label;
            sampleSelect.appendChild(opt);
        });
    }

    registerFileOpenTrigger(openBtn);
    registerFileOpenTrigger(emptyHintEl);

    if (fileInput) {
        const handleFileInputChange = async (e) => {
            if (disposed) return;
            const files = [...(e.target.files || [])];
            await runFileBatch(files, { resetInput: true });
        };
        fileInput.addEventListener('change', handleFileInputChange);
        cleanupFns.push(() => fileInput.removeEventListener('change', handleFileInputChange));
    }

    populateSampleSelect();
    if (sampleSelect) {
        const handleSampleChange = async () => {
            if (disposed) return;
            const idx = sampleSelect.selectedIndex;
            const sample = sampleModels[idx];
            if (!sample || !sample.files || !sample.files.length) return;
            await enqueueOperation(async () => {
                if (disposed) return false;
                onSampleChosen(sample);
                return loadSampleModel(sample);
            });
        };
        sampleSelect.addEventListener('change', handleSampleChange);
        cleanupFns.push(() => sampleSelect.removeEventListener('change', handleSampleChange));
    }

    const dragTargets = [window, document, document?.body, rootEl, dropEl].filter(Boolean);
    let dragHoverCount = 0;
    const addDragListener = (type, handler) => {
        dragTargets.forEach((target) => {
            target.addEventListener(type, handler, { passive: false });
            cleanupFns.push(() => target.removeEventListener(type, handler));
        });
    };

    const isFileDrag = (e) => {
        const dt = e?.dataTransfer;
        if (!dt) return false;
        try {
            const types = Array.from(dt.types || []);
            if (types.includes('Files')) return true;
            const items = Array.from(dt.items || []);
            return items.some((it) => it && it.kind === 'file');
        } catch (_) {
            return false;
        }
    };

    const handleDragEnter = (e) => {
        if (disposed) return;
        if (!isFileDrag(e)) return;
        e.preventDefault();
        e.stopPropagation();
        dragHoverCount++;
        if (dropEl) dropEl.classList.add('show');
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const handleDragOver = (e) => {
        if (disposed) return;
        if (!isFileDrag(e) && dragHoverCount === 0) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const handleDragLeave = (e) => {
        if (disposed) return;
        if (dragHoverCount === 0) return;
        e.preventDefault();
        e.stopPropagation();
        dragHoverCount = Math.max(0, dragHoverCount - 1);
        if (dragHoverCount === 0 && dropEl) dropEl.classList.remove('show');
    };
    const handleDrop = async (e) => {
        if (disposed) return;
        const files = [...(e.dataTransfer?.files || [])];
        if (!files.length) return;
        e.preventDefault();
        e.stopPropagation();
        dragHoverCount = 0;
        if (dropEl) dropEl.classList.remove('show');
        await runFileBatch(files);
    };

    addDragListener('dragenter', handleDragEnter);
    addDragListener('dragover', handleDragOver);
    addDragListener('dragleave', handleDragLeave);
    addDragListener('drop', handleDrop);

    function dispose() {
        if (disposed) return;
        disposed = true;
        abortActiveBatches();
        cleanupFns.splice(0).forEach((cleanup) => {
            try {
                cleanup();
            } catch (_) {}
        });
        dragHoverCount = 0;
        if (dropEl) dropEl.classList.remove('show');
    }

    return {
        populateSampleSelect,
        dispose,
    };
}
