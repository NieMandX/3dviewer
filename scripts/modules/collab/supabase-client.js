const SUPABASE_CDN = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.104.1/dist/umd/supabase.js';

let cachedModule = null;
let cachedPromise = null;

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
        script.src = SUPABASE_CDN;
        script.async = true;
        script.onload = () => {
            if (window.supabase) {
                cachedModule = window.supabase;
                resolve(cachedModule);
            } else {
                reject(new Error('Supabase UMD failed to initialize.'));
            }
        };
        script.onerror = () => reject(new Error('Supabase UMD failed to load.'));
        document.head.appendChild(script);
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
