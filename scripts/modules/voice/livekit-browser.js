const LIVEKIT_CLIENT_CDN = 'https://cdn.jsdelivr.net/npm/livekit-client@2.17.2/dist/livekit-client.umd.min.js';

let cachedModule = null;
let cachedPromise = null;

function cleanupScript(script, { remove = false } = {}) {
    try {
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
        script.src = LIVEKIT_CLIENT_CDN;
        script.async = true;
        script.onload = () => {
            if (window.LivekitClient) {
                cachedModule = window.LivekitClient;
                cleanupScript(script);
                resolve(cachedModule);
            } else {
                cleanupScript(script, { remove: true });
                reject(new Error('LiveKit browser SDK failed to initialize.'));
            }
        };
        script.onerror = () => {
            cleanupScript(script, { remove: true });
            reject(new Error('LiveKit browser SDK failed to load.'));
        };
        document.head.appendChild(script);
    }).catch((err) => {
        cachedPromise = null;
        throw err;
    });

    return cachedPromise;
}
