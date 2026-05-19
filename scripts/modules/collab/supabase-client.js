const SUPABASE_CDN = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.104.1/dist/umd/supabase.js';
const DEFAULT_SUPABASE_CDN_TIMEOUT_MS = 15000;

let cachedModule = null;
let cachedPromise = null;

function getSupabaseCdnTimeoutMs() {
    const override = Number(globalThis.__LPMVIEW_SUPABASE_CDN_TIMEOUT_MS);
    if (Number.isFinite(override) && override > 0) {
        return Math.min(60000, Math.max(10, override));
    }
    return DEFAULT_SUPABASE_CDN_TIMEOUT_MS;
}

function cleanupScript(script, { remove = false, timeoutId = 0 } = {}) {
    try {
        if (timeoutId) globalThis.clearTimeout(timeoutId);
        script.onload = null;
        script.onerror = null;
        if (remove) script.remove();
    } catch (_) {}
}

async function loadSupabaseModule() {
    if (cachedModule) return cachedModule;
    if (cachedPromise) return cachedPromise;
    if (typeof window === 'undefined' || typeof document === 'undefined') {
        throw new Error('Supabase UMD is only available in browser environments.');
    }
    if (window.supabase) {
        cachedModule = window.supabase;
        return cachedModule;
    }
    cachedPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        let timeoutId = 0;
        script.src = SUPABASE_CDN;
        script.async = true;
        script.onload = () => {
            if (window.supabase) {
                cachedModule = window.supabase;
                cleanupScript(script, { timeoutId });
                resolve(cachedModule);
            } else {
                cleanupScript(script, { remove: true, timeoutId });
                reject(new Error('Supabase UMD failed to initialize.'));
            }
        };
        script.onerror = () => {
            cleanupScript(script, { remove: true, timeoutId });
            reject(new Error('Supabase UMD failed to load.'));
        };
        timeoutId = globalThis.setTimeout(() => {
            cleanupScript(script, { remove: true });
            reject(new Error('Supabase UMD load timed out.'));
        }, getSupabaseCdnTimeoutMs());
        document.head.appendChild(script);
    }).catch((err) => {
        cachedPromise = null;
        throw err;
    });
    return cachedPromise;
}

export async function createSupabaseClient({ url, anonKey, auth: authOptions } = {}) {
    if (!url || !anonKey) {
        throw new Error('Supabase config is missing (url/anonKey).');
    }
    const mod = await loadSupabaseModule();
    if (!mod?.createClient) {
        throw new Error('Supabase client failed to load.');
    }
    return mod.createClient(url, anonKey, {
        auth: {
            persistSession: true,
            autoRefreshToken: true,
            ...(authOptions || {}),
        },
    });
}
