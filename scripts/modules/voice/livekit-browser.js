const LIVEKIT_CLIENT_CDN = 'https://cdn.jsdelivr.net/npm/livekit-client@2.17.2/dist/livekit-client.umd.min.js';
const DEFAULT_LIVEKIT_CLIENT_CDN_TIMEOUT_MS = 15000;

let cachedModule = null;
let cachedPromise = null;

function getLiveKitClientCdnTimeoutMs() {
    const override = Number(globalThis.__LPMVIEW_LIVEKIT_CDN_TIMEOUT_MS);
    if (Number.isFinite(override) && override > 0) {
        return Math.min(60000, Math.max(10, override));
    }
    return DEFAULT_LIVEKIT_CLIENT_CDN_TIMEOUT_MS;
}

function cleanupScript(script, { remove = false, timeoutId = 0 } = {}) {
    try {
        if (timeoutId) globalThis.clearTimeout(timeoutId);
        script.onload = null;
        script.onerror = null;
        if (remove) script.remove();
    } catch (_) {}
}

export async function loadLiveKitClient() {
    if (cachedModule) return cachedModule;
    if (cachedPromise) return cachedPromise;

    if (typeof window === 'undefined' || typeof document === 'undefined') {
        throw new Error('LiveKit browser SDK is only available in browser environments.');
    }

    if (window.LivekitClient) {
        cachedModule = window.LivekitClient;
        return cachedModule;
    }

    cachedPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        let timeoutId = 0;
        script.src = LIVEKIT_CLIENT_CDN;
        script.async = true;
        script.onload = () => {
            if (window.LivekitClient) {
                cachedModule = window.LivekitClient;
                cleanupScript(script, { timeoutId });
                resolve(cachedModule);
            } else {
                cleanupScript(script, { remove: true, timeoutId });
                reject(new Error('LiveKit browser SDK failed to initialize.'));
            }
        };
        script.onerror = () => {
            cleanupScript(script, { remove: true, timeoutId });
            reject(new Error('LiveKit browser SDK failed to load.'));
        };
        timeoutId = globalThis.setTimeout(() => {
            cleanupScript(script, { remove: true });
            reject(new Error('LiveKit browser SDK load timed out.'));
        }, getLiveKitClientCdnTimeoutMs());
        document.head.appendChild(script);
    }).catch((err) => {
        cachedPromise = null;
        throw err;
    });

    return cachedPromise;
}
