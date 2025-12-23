const SUPABASE_CDN = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

let cachedModule = null;

async function loadSupabaseModule() {
    if (!cachedModule) {
        cachedModule = import(SUPABASE_CDN);
    }
    return cachedModule;
}

export async function createSupabaseClient({ url, anonKey }) {
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
        },
    });
}
