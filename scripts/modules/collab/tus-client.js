const TUS_CLIENT_CDN = 'https://cdn.jsdelivr.net/npm/tus-js-client@3.1.3/dist/tus.min.js';
const DEFAULT_TUS_CLIENT_CDN_TIMEOUT_MS = 15000;

let cachedModule = null;
let cachedPromise = null;

function getTusClientCdnTimeoutMs() {
    const override = Number(globalThis.__LPMVIEW_TUS_CDN_TIMEOUT_MS);
    if (Number.isFinite(override) && override > 0) {
        return Math.min(60000, Math.max(10, override));
    }
    return DEFAULT_TUS_CLIENT_CDN_TIMEOUT_MS;
}

function cleanupScript(script, { remove = false, timeoutId = 0 } = {}) {
    try {
        if (timeoutId) globalThis.clearTimeout(timeoutId);
        script.onload = null;
        script.onerror = null;
        if (remove) script.remove();
    } catch (_) {}
}

export async function loadTusClient() {
    if (cachedModule?.Upload) return cachedModule;
    if (cachedPromise) return cachedPromise;

    if (typeof window === 'undefined' || typeof document === 'undefined') {
        throw new Error('TUS loader is unavailable outside browser.');
    }

    const existing = globalThis.tus;
    if (existing?.Upload) {
        cachedModule = existing;
        return cachedModule;
    }

    cachedPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        let timeoutId = 0;
        script.src = TUS_CLIENT_CDN;
        script.async = true;
        script.onload = () => {
            const tus = globalThis.tus;
            if (tus?.Upload) {
                cachedModule = tus;
                cleanupScript(script, { timeoutId });
                resolve(cachedModule);
            } else {
                cleanupScript(script, { remove: true, timeoutId });
                reject(new Error('tus-js-client loaded without Upload API.'));
            }
        };
        script.onerror = () => {
            cleanupScript(script, { remove: true, timeoutId });
            reject(new Error('Failed to load tus-js-client from CDN.'));
        };
        timeoutId = globalThis.setTimeout(() => {
            cleanupScript(script, { remove: true });
            reject(new Error('tus-js-client CDN load timed out.'));
        }, getTusClientCdnTimeoutMs());
        document.head.appendChild(script);
    }).catch((err) => {
        cachedPromise = null;
        throw err;
    });

    return cachedPromise;
}
