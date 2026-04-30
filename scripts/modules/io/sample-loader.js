export function createSampleLoader(options = {}) {
    const statusEl = options.statusEl || null;
    const sampleSelect = options.sampleSelect || null;
    const setStatusMessage = typeof options.setStatusMessage === 'function' ? options.setStatusMessage : () => {};
    const setEmptyHintVisible = typeof options.setEmptyHintVisible === 'function' ? options.setEmptyHintVisible : () => {};
    const hideSidePanel = typeof options.hideSidePanel === 'function' ? options.hideSidePanel : () => {};

    const handleZIPFile = typeof options.handleZIPFile === 'function' ? options.handleZIPFile : async () => {};
    const finalizeBatchAfterAllFiles =
        typeof options.finalizeBatchAfterAllFiles === 'function' ? options.finalizeBatchAfterAllFiles : async () => {};

    const getLoadedModelCount = typeof options.getLoadedModelCount === 'function' ? options.getLoadedModelCount : () => 0;

    const activeControllers = new Set();
    let disposed = false;
    let loadGeneration = 0;

    function makeAbortError(message = 'Sample load aborted') {
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

    function abortActiveLoads() {
        const reason = makeAbortError();
        activeControllers.forEach((controller) => {
            try {
                if (!controller.signal?.aborted) controller.abort(reason);
            } catch (_) {}
        });
        activeControllers.clear();
    }

    async function loadSampleModel(sample) {
        if (disposed || !sample || !sample.files || !sample.files.length) return false;
        if (!statusEl) return false;
        abortActiveLoads();
        const generation = ++loadGeneration;
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        const signal = controller?.signal || null;
        if (controller) activeControllers.add(controller);
        const isCurrent = () => !disposed && generation === loadGeneration && !signal?.aborted;
        try {
            if (sampleSelect) sampleSelect.disabled = true;
            setStatusMessage(`Загрузка примера: ${sample.label}`);
            setEmptyHintVisible(false);
            hideSidePanel();

            const downloadedFiles = [];
            for (const url of sample.files) {
                if (!isCurrent()) return false;
                const response = await fetch(url, { cache: 'no-cache', signal: signal || undefined });
                if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
                const blob = await response.blob();
                if (!isCurrent()) return false;
                const base = url.split('?')[0];
                const name = decodeURIComponent(base.split('/').pop() || 'sample.zip');
                downloadedFiles.push(new File([blob], name, { type: blob.type || 'application/zip' }));
            }
            for (const file of downloadedFiles) {
                if (!isCurrent()) return false;
                await handleZIPFile(file, signal ? { signal } : null);
            }
            if (!isCurrent()) return false;
            await finalizeBatchAfterAllFiles();
            if (!isCurrent()) return false;

            setStatusMessage('');
            setEmptyHintVisible(getLoadedModelCount() === 0);
            return true;
        } catch (err) {
            if (isAbortError(err) || !isCurrent()) return false;
            console.error(err);
            setStatusMessage(`Ошибка загрузки примера: ${err?.message || err}`);
            setEmptyHintVisible(getLoadedModelCount() === 0);
            return false;
        } finally {
            if (controller) activeControllers.delete(controller);
            if (isCurrent() && sampleSelect) {
                sampleSelect.disabled = false;
                sampleSelect.value = '';
            }
        }
    }

    function dispose() {
        if (disposed) return;
        disposed = true;
        loadGeneration += 1;
        abortActiveLoads();
        if (sampleSelect) {
            sampleSelect.disabled = false;
            sampleSelect.value = '';
        }
    }

    return { loadSampleModel, dispose };
}
