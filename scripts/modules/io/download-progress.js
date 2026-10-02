function abortError(signal) {
    return signal?.reason || new DOMException('Model download aborted', 'AbortError');
}

function positiveSize(value) {
    const size = Number(value);
    return Number.isFinite(size) && size > 0 ? size : 0;
}

// Fetch exposes decoded bytes. Content-Length is usable only for an unencoded
// response; stored file metadata can also supply the original file size.
export async function fetchModelBlob(url, { signal, expectedBytes = 0, onProgress = () => {} } = {}) {
    if (signal?.aborted) throw abortError(signal);
    const response = await fetch(url, { cache: 'no-cache', signal: signal || undefined });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const encoding = response.headers.get('content-encoding');
    let total = positiveSize(expectedBytes) || ((!encoding || encoding === 'identity')
        ? positiveSize(response.headers.get('content-length')) : 0);
    let loaded = 0;
    let lastReport = -Infinity;
    const report = (done = false) => {
        if (signal?.aborted) throw abortError(signal);
        if (loaded > total && total) total = 0; // stale metadata must not fake 100%
        const now = performance.now();
        if (!done && now - lastReport < 100) return;
        lastReport = now;
        onProgress({ loaded, total, done, percent: total ? Math.min(done ? 100 : 99, Math.floor(100 * loaded / total)) : null });
    };
    report();
    if (!response.body?.getReader) {
        const blob = await response.blob();
        loaded = blob.size;
        total = loaded;
        report(true);
        return blob;
    }
    const reader = response.body.getReader();
    const chunks = [];
    const cancel = () => { reader.cancel(abortError(signal)).catch(() => {}); };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
        if (signal?.aborted) throw abortError(signal);
        while (true) {
            const { done, value } = await reader.read();
            if (signal?.aborted) throw abortError(signal);
            if (done) break;
            chunks.push(value);
            loaded += value.byteLength;
            report();
        }
        const blob = new Blob(chunks, { type: response.headers.get('content-type') || 'application/octet-stream' });
        total = loaded;
        report(true);
        return blob;
    } catch (error) {
        try { await reader.cancel(error); } catch (_) {}
        throw error;
    } finally {
        chunks.length = 0;
        signal?.removeEventListener('abort', cancel);
        reader.releaseLock();
    }
}

export function formatDownloadProgress({ loaded = 0, total = 0, percent = null } = {}) {
    const units = ['Б', 'КБ', 'МБ', 'ГБ'];
    const scale = Math.min(3, Math.max(0, Math.floor(Math.log10(Math.max(1, total || loaded)) / 3)));
    const format = value => (value / (1000 ** scale)).toLocaleString('ru-RU', { maximumFractionDigits: scale ? 1 : 0 });
    const bytes = total ? `${format(loaded)} из ${format(total)} ${units[scale]}` : `${format(loaded)} ${units[scale]}`;
    return percent == null ? bytes : `${percent}% · ${bytes}`;
}
