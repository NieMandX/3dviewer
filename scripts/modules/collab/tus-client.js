const TUS_CLIENT_CDN = 'https://cdn.jsdelivr.net/npm/tus-js-client@3.1.3/dist/tus.min.js';

let cachedModule = null;
let cachedPromise = null;

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
        script.src = TUS_CLIENT_CDN;
        script.async = true;
        script.onload = () => {
            const tus = globalThis.tus;
            if (tus?.Upload) {
                cachedModule = tus;
                resolve(cachedModule);
            } else {
                try { script.remove(); } catch (_) {}
                reject(new Error('tus-js-client loaded without Upload API.'));
            }
        };
        script.onerror = () => {
            try { script.remove(); } catch (_) {}
            reject(new Error('Failed to load tus-js-client from CDN.'));
        };
        document.head.appendChild(script);
    }).catch((err) => {
        cachedPromise = null;
        throw err;
    });

    return cachedPromise;
}
