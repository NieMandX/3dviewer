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

    function registerFileOpenTrigger(el) {
        if (!el || !fileInput) return;
        const handler = () => fileInput.click();
        el.addEventListener('click', handler);
        cleanupFns.push(() => el.removeEventListener('click', handler));
    }

    async function handleFiles(files) {
        const errors = [];
        for (const f of files) {
            try {
                if (/\.fbx$/i.test(f.name)) {
                    await handleFBXFile(f);
                } else if (/\.zip$/i.test(f.name)) {
                    await handleZIPFile(f);
                }
            } catch (err) {
                errors.push({ file: f, error: err });
                console.error(`File import failed: ${f?.name || 'unknown'}`, err);
            }
        }
        return errors;
    }

    async function runFileBatch(files, { resetInput = false } = {}) {
        if (!files.length) return [];
        setEmptyHintVisible(false);
        try {
            return await handleFiles(files);
        } finally {
            if (resetInput && fileInput) fileInput.value = '';
            setEmptyHintVisible(getLoadedModelCount() === 0);
            await finalizeBatchAfterAllFiles();
        }
    }

    function populateSampleSelect() {
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
            const files = [...(e.target.files || [])];
            await runFileBatch(files, { resetInput: true });
        };
        fileInput.addEventListener('change', handleFileInputChange);
        cleanupFns.push(() => fileInput.removeEventListener('change', handleFileInputChange));
    }

    populateSampleSelect();
    if (sampleSelect) {
        const handleSampleChange = async () => {
            const idx = sampleSelect.selectedIndex;
            const sample = sampleModels[idx];
            if (!sample || !sample.files || !sample.files.length) return;
            onSampleChosen(sample);
            await loadSampleModel(sample);
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
        if (!isFileDrag(e)) return;
        e.preventDefault();
        e.stopPropagation();
        dragHoverCount++;
        if (dropEl) dropEl.classList.add('show');
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const handleDragOver = (e) => {
        if (!isFileDrag(e) && dragHoverCount === 0) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const handleDragLeave = (e) => {
        if (dragHoverCount === 0) return;
        e.preventDefault();
        e.stopPropagation();
        dragHoverCount = Math.max(0, dragHoverCount - 1);
        if (dragHoverCount === 0 && dropEl) dropEl.classList.remove('show');
    };
    const handleDrop = async (e) => {
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
