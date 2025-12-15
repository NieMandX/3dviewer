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

    async function loadSampleModel(sample) {
        if (!sample || !sample.files || !sample.files.length) return;
        if (!statusEl) return;
        try {
            if (sampleSelect) sampleSelect.disabled = true;
            setStatusMessage(`Загрузка примера: ${sample.label}`);
            setEmptyHintVisible(false);
            hideSidePanel();

            const downloadedFiles = [];
            for (const url of sample.files) {
                const response = await fetch(url, { cache: 'no-cache' });
                if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
                const blob = await response.blob();
                const base = url.split('?')[0];
                const name = decodeURIComponent(base.split('/').pop() || 'sample.zip');
                downloadedFiles.push(new File([blob], name, { type: blob.type || 'application/zip' }));
            }
            for (const file of downloadedFiles) await handleZIPFile(file);
            await finalizeBatchAfterAllFiles();

            setStatusMessage('');
            setEmptyHintVisible(getLoadedModelCount() === 0);
        } catch (err) {
            console.error(err);
            setStatusMessage(`Ошибка загрузки примера: ${err?.message || err}`);
            setEmptyHintVisible(getLoadedModelCount() === 0);
        } finally {
            if (sampleSelect) {
                sampleSelect.disabled = false;
                sampleSelect.value = '';
            }
        }
    }

    return { loadSampleModel };
}

