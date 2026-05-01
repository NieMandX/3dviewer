const LIVEKIT_CLIENT_CDN = 'https://cdn.jsdelivr.net/npm/livekit-client@2.17.2/dist/livekit-client.umd.min.js';

let cachedModule = null;
let cachedPromise = null;

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
                resolve(cachedModule);
            } else {
                reject(new Error('LiveKit browser SDK failed to initialize.'));
            }
        };
        script.onerror = () => reject(new Error('LiveKit browser SDK failed to load.'));
        document.head.appendChild(script);
    }).catch((err) => {
        cachedPromise = null;
        throw err;
    });

    return cachedPromise;
}
