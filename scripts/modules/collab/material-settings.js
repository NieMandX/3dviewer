// A room owns a separate JSON document, never a rewritten source model.
export function createRoomMaterialSettings({ getContext, apply, onStatus = () => {} }) {
    let disposed = false, generation = 0, controller = null, roomId = '', revision = 0, cached = null, appliedRoots = new WeakSet(), busy = false;
    let lastModels = [], retryNeeded = false, fetchFailed = false;
    const clearRetry = () => { if (typeof window !== 'undefined') window.removeEventListener('online', online); };
    const online = () => { if (!disposed && retryNeeded && !busy) { clearRetry(); if (fetchFailed) roomId = ''; void refresh(lastModels); } };
    const retryWhenOnline = () => { retryNeeded = true; if (typeof window !== 'undefined') window.addEventListener('online', online); };
    function current(token, context) { const now = getContext(); return token === generation && now?.controller === context.controller && now?.roomId === context.roomId; }
    async function refresh(models) {
        if (disposed) return;
        lastModels = models;
        const context = { ...getContext() };
        if (!context?.controller || !context.roomId) { clearRetry(); retryNeeded = false; if (roomId) { generation++; roomId = ''; controller = null; cached = null; appliedRoots = new WeakSet(); } return; }
        if (roomId !== context.roomId || controller !== context.controller) {
            generation++; roomId = context.roomId; controller = context.controller; revision = 0; cached = null; appliedRoots = new WeakSet(); busy = false; retryNeeded = fetchFailed = false; clearRetry();
            const token = generation; busy = true;
            try {
                const { data, error } = await controller.supabase.from('room_material_settings').select('document,revision').eq('room_id', roomId).maybeSingle();
                if (!current(token, context)) return;
                if (error) throw error;
                cached = data?.document || null; revision = data?.revision || 0;
            } catch (error) { if (current(token, context)) { fetchFailed = true; retryWhenOnline(); onStatus('Настройки комнаты не загружены: ' + error.message); } }
            finally { if (current(token, context)) busy = false; }
        }
        if (busy || !cached) return;
        const pending = models.filter((m) => m.scope?.roomId === roomId && !appliedRoots.has(m.obj));
        if (!pending.length) return;
        pending.forEach((m) => appliedRoots.add(m.obj));
        const token = generation;
        const ids = new Set(pending.map((m) => String(m.scope?.modelId || m.obj?.userData?.sourceFileName || m.name)));
        busy = true; let succeeded = false;
        try { await apply({ ...cached, materials: cached.materials.filter((m) => ids.has(m.model)) }, { isCurrent: () => current(token, context) }); succeeded = true; if (current(token, context)) { retryNeeded = false; clearRetry(); } }
        catch (error) { if (current(token, context)) { pending.forEach((m) => appliedRoots.delete(m.obj)); retryWhenOnline(); onStatus('Материалы комнаты не восстановлены: ' + error.message); } }
        finally { if (current(token, context)) { busy = false; if (succeeded) queueMicrotask(() => { void refresh(models); }); } }
    }
    async function save(document) {
        const context = { ...getContext() };
        if (!context?.controller || !context.roomId) throw Error('Откройте комнату проекта, чтобы сохранить настройки.');
        if (context.roomId !== roomId || context.controller !== controller) await refresh([]);
        if (getContext()?.roomId !== context.roomId || getContext()?.controller !== context.controller) throw Error('Комната изменилась. Повторите сохранение.');
        if (busy) throw Error('Дождитесь загрузки настроек комнаты.');
        if (JSON.stringify(document).length > 16 * 1024 * 1024) throw Error('Настройки больше 16 МБ. Уменьшите новые текстуры.');
        const merged = new Map((cached?.materials || []).map((m) => [`${m.model}:${m.material}`, m]));
        document.materials.forEach((m) => merged.set(`${m.model}:${m.material}`, m));
        document = { ...document, materials: [...merged.values()] };
        const token = generation;
        const { data, error } = await context.controller.supabase.rpc('save_room_material_settings', {
            p_room_id: context.roomId, p_document: document, p_expected_revision: revision,
        });
        if (error) throw Error(error.code === '40001' ? 'Другой участник уже изменил материалы. Скачайте свои настройки перед повторным открытием комнаты.' : error.message);
        if (!current(token, context)) throw Error('Комната изменилась. Настройки сохранены в прежней комнате.');
        revision = Number(data); cached = document;
    }
    return { refresh, save, dispose() { disposed = true; generation++; controller = null; cached = null; roomId = ''; lastModels = []; if (typeof window !== 'undefined') window.removeEventListener('online', online); } };
}
