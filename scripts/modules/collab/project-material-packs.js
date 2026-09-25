import { captureMaterialPack, validateMaterialPack, PACK_ASSET, packAbort } from '../material/material-pack.js';

const BUCKET = 'material-packs';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const storageError = (error) => ['PGRST205', '42P01', 'PGRST202'].includes(error?.code) || /Bucket not found/i.test(error?.message || '')
    ? Error('Библиотека материалов ещё не подключена к базе проекта.') : error;

// Collect before deleting a project; remove through Storage afterward, so a
// failed project deletion never removes assets still referenced by its rooms.
export async function listProjectMaterialPackObjects(client, projectId, isCurrent = () => true) {
    if (!uuid.test(projectId || '')) return [];
    const bucket = client.storage.from(BUCKET), paths = [];
    async function walk(prefix, depth) {
        for (let offset = 0; ; offset += 1000) {
            if (!isCurrent()) throw packAbort();
            const { data, error } = await bucket.list(prefix, { limit: 1000, offset, sortBy: { column: 'name', order: 'asc' } });
            if (error) { if (error.statusCode === '404' || error.message === 'Bucket not found') return; throw error; }
            if (!isCurrent()) throw packAbort();
            for (const item of data || []) {
                if (!item.name || item.name.includes('/') || item.name === '..') continue;
                const path = `${prefix}/${item.name}`;
                if (item.id) paths.push(path);
                else if (depth < 2) await walk(path, depth + 1);
            }
            if (!data || data.length < 1000) break;
        }
    }
    await walk(projectId, 0); return paths;
}

export async function removeProjectMaterialPackObjects(client, paths) {
    const bucket = client.storage.from(BUCKET);
    for (let i = 0; i < paths.length; i += 100) { const { error } = await bucket.remove(paths.slice(i, i + 100)); if (error) throw error; }
}

export function createProjectMaterialPacks({ getContext }) {
    let disposed = false;
    function scope(isCurrent = () => true) {
        const context = getContext(), controller = context?.controller;
        const projectId = controller?.project?.id, roomId = controller?.room?.id;
        if (disposed || !controller?.supabase || !uuid.test(projectId || '')) throw Error('Откройте комнату проекта.');
        const current = () => !disposed && isCurrent() && getContext()?.controller === controller && controller.project?.id === projectId && controller.room?.id === roomId;
        const check = () => { if (!current()) throw packAbort(); };
        return { controller, projectId, check, current, canManage: context.canManage === true };
    }
    function state() { const c = getContext(); return { projectId: c?.controller?.project?.id || '', name: c?.controller?.project?.name || '', canManage: c?.canManage === true }; }
    async function list() {
        const s = scope(); if (!s.canManage) return [];
        const { data, error } = await s.controller.supabase.from('project_material_packs').select('id,name,source_model,material_count,texture_count,created_at').eq('project_id', s.projectId).order('created_at', { ascending: false });
        s.check(); if (error) throw storageError(error); return data || [];
    }
    async function save({ name, sourceModel, entries, isCurrent, onProgress }) {
        const s = scope(isCurrent); if (!s.canManage) throw Error('Сохранять наборы может владелец проекта.');
        name = String(name || '').trim(); if (!name || name.length > 120) throw Error('Введите название набора, до 120 символов.');
        const id = crypto.randomUUID(), prefix = `${s.projectId}/${id}/`, bucket = s.controller.supabase.storage.from(BUCKET), uploaded = [];
        let publishing = false, pack;
        try {
            const writeAsset = async (path, blob) => {
                s.check(); const key = prefix + path;
                // Record before the request: a lost response may still have stored the object.
                uploaded.push(key);
                const { error } = await bucket.upload(key, blob, { contentType: blob.type, upsert: false });
                if (error) throw storageError(error); s.check();
            };
            pack = await captureMaterialPack(entries, { writeAsset, isCurrent: s.current, onProgress });
            pack.name = name; pack.sourceModel = String(sourceModel || '').slice(0, 512);
            const manifest = new Blob([JSON.stringify(pack)], { type: 'application/json' });
            if (manifest.size > 8 * 1024 * 1024) throw Error('Описание набора превышает 8 МБ.');
            await writeAsset('materials.json', manifest); s.check(); publishing = true;
            const { error } = await s.controller.supabase.rpc('publish_project_material_pack', { p_id: id, p_project_id: s.projectId, p_name: name, p_source_model: pack.sourceModel, p_material_count: pack.materials.length, p_texture_count: pack.textureCount });
            if (error) throw storageError(error);
            return { id, name, pack, current: s.current() };
        } catch (error) {
            // Never remove assets of a publication whose server response was lost.
            let mayClean = !publishing;
            if (publishing) {
                const result = await s.controller.supabase.from('project_material_packs').select('id').eq('id', id).maybeSingle().catch(() => ({ error: true }));
                if (result.data?.id) return { id, name, pack, current: s.current() };
                mayClean = !result.error;
            }
            if (mayClean) for (let i = 0; i < uploaded.length; i += 50) await bucket.remove(uploaded.slice(i, i + 50)).catch(() => {});
            throw error;
        }
    }
    async function open(id, { isCurrent } = {}) {
        if (!uuid.test(id || '')) throw Error('Недопустимый набор материалов.');
        const s = scope(isCurrent), client = s.controller.supabase;
        const { data: row, error } = await client.from('project_material_packs').select('id,project_id,name').eq('id', id).eq('project_id', s.projectId).maybeSingle();
        s.check(); if (error) throw storageError(error); if (!row) throw Error('Набор не найден или недоступен в этом проекте.');
        const prefix = `${s.projectId}/${id}/`, bucket = client.storage.from(BUCKET);
        async function download(path, limit) {
            s.check(); const { data, error: failure } = await bucket.download(prefix + path);
            s.check(); if (failure) throw storageError(failure);
            if (!data || data.size > limit) throw Error('Файл набора слишком большой.'); return data;
        }
        const pack = validateMaterialPack(JSON.parse(await (await download('materials.json', 8 * 1024 * 1024)).text()));
        s.check(); const blobs = new Map(); let bytes = 0;
        return { id, name: row.name, pack, loadAsset: async (path) => {
            if (!PACK_ASSET.test(path || '')) throw Error('Недопустимый путь карты материала.');
            if (!blobs.has(path)) blobs.set(path, download(path, 32 * 1024 * 1024).then((blob) => { bytes += blob.size; if (bytes > 512 * 1024 * 1024) throw Error('Набор превышает 512 МБ.'); return blob; }));
            const blob = await blobs.get(path); s.check(); return blob;
        } };
    }
    return { state, list, save, open, dispose() { disposed = true; } };
}
