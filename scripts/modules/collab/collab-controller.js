import { createSupabaseClient } from './supabase-client.js';

function makeSlug(length = 8) {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    for (let i = 0; i < length; i += 1) {
        out += chars[Math.floor(Math.random() * chars.length)];
    }
    return out;
}

function normalizeName(name) {
    const trimmed = String(name || '').trim();
    return trimmed || 'Guest';
}

async function ensureAuth(supabase) {
    const { data: userData } = await supabase.auth.getUser();
    if (userData?.user) return userData.user;
    const { data, error } = await supabase.auth.signInAnonymously();
    if (error) throw error;
    return data.user;
}

async function fetchRoomBySlug(supabase, slug) {
    if (!slug) return null;
    const { data, error } = await supabase
        .from('rooms')
        .select('*')
        .eq('slug', slug)
        .limit(1)
        .maybeSingle();
    if (error) throw error;
    return data || null;
}

async function fetchRoomByProjectAndSlug(supabase, projectId, slug) {
    if (!projectId || !slug) return null;
    const { data, error } = await supabase
        .from('rooms')
        .select('*')
        .eq('project_id', projectId)
        .eq('slug', slug)
        .limit(1)
        .maybeSingle();
    if (error) throw error;
    return data || null;
}

async function fetchRoomById(supabase, roomId) {
    if (!roomId) return null;
    const { data, error } = await supabase
        .from('rooms')
        .select('*')
        .eq('id', roomId)
        .limit(1)
        .maybeSingle();
    if (error) throw error;
    return data || null;
}

async function createRoom(supabase, projectId, slug, ownerId) {
    const payload = {
        project_id: projectId,
        slug,
        owner_id: ownerId,
    };
    const { data, error } = await supabase
        .from('rooms')
        .insert(payload)
        .select('*')
        .single();
    if (error) throw error;
    return data;
}

async function fetchProjectById(supabase, projectId) {
    if (!projectId) return null;
    const { data, error } = await supabase
        .from('projects')
        .select('*')
        .eq('id', projectId)
        .limit(1)
        .maybeSingle();
    if (error) throw error;
    return data || null;
}

async function joinProjectBySlug(supabase, slug) {
    if (!slug) return null;
    const { data, error } = await supabase.rpc('join_project_by_slug', { project_slug: slug });
    if (error) throw error;
    return data || null;
}

async function ensureRoom(supabase, projectId, slug, ownerId) {
    const safeSlug = String(slug || '').trim();
    if (safeSlug) {
        const existing = await fetchRoomByProjectAndSlug(supabase, projectId, safeSlug);
        if (existing) return { room: existing, slug: safeSlug, created: false };
        const created = await createRoom(supabase, projectId, safeSlug, ownerId);
        return { room: created, slug: safeSlug, created: true };
    }
    let attempts = 0;
    while (attempts < 5) {
        attempts += 1;
        const nextSlug = makeSlug(8);
        const existing = await fetchRoomByProjectAndSlug(supabase, projectId, nextSlug);
        if (existing) continue;
        const created = await createRoom(supabase, projectId, nextSlug, ownerId);
        return { room: created, slug: nextSlug, created: true };
    }
    throw new Error('Failed to allocate a room slug.');
}

function parsePresence(state) {
    const result = [];
    Object.entries(state || {}).forEach(([id, metas]) => {
        const meta = Array.isArray(metas) ? metas[0] : null;
        result.push({
            id,
            name: meta?.name || 'Guest',
            joinedAt: meta?.joinedAt || null,
        });
    });
    result.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return result;
}

export async function createCollabController(options = {}) {
    const {
        supabaseUrl,
        supabaseAnonKey,
        supabase: injectedSupabase,
        user: injectedUser,
        projectSlug,
        projectId,
        project: injectedProject,
        roomSlug,
        roomId,
        room: injectedRoom,
        displayName,
        onStatus,
        onProjectReady,
        onRoomReady,
        onParticipants,
        onMessage,
        onAnnotation,
        onAnnotationDelete,
        onCameraState,
        onCameraOwner,
        onRoomUpdate,
    } = options;

    const status = typeof onStatus === 'function' ? onStatus : () => {};
    status('Connecting…');

    const supabase = injectedSupabase || await createSupabaseClient({
        url: supabaseUrl,
        anonKey: supabaseAnonKey,
    });

    const user = injectedUser || await ensureAuth(supabase);
    let currentName = normalizeName(displayName);

    let project = injectedProject || null;
    if (!project) {
        if (projectId) {
            project = await fetchProjectById(supabase, projectId);
        } else if (projectSlug) {
            project = await joinProjectBySlug(supabase, projectSlug);
        }
    }
    if (!project) {
        throw new Error('Project not found.');
    }

    if (typeof onProjectReady === 'function') {
        onProjectReady(project);
    }

    let room = injectedRoom || null;
    let slug = roomSlug || room?.slug || '';
    let created = false;
    if (!room) {
        if (roomId) {
            room = await fetchRoomById(supabase, roomId);
        } else {
            const result = await ensureRoom(supabase, project.id, roomSlug, user.id);
            room = result.room;
            slug = result.slug;
            created = result.created;
        }
    }
    if (!room) {
        throw new Error('Room not found.');
    }

    const deleteQueue = [];
    const deletePending = new Map();
    let deleteProcessing = false;
    let onlineWaitHandler = null;
    let onlineWaitPromise = null;

    const DELETE_RETRY_LIMIT = 6;
    const DELETE_RETRY_BASE_MS = 300;
    const DELETE_BETWEEN_MS = 120;

    if (currentName) {
        await supabase.from('profiles').upsert({
            id: user.id,
            display_name: currentName,
        });
    }

    if (typeof onRoomReady === 'function') {
        onRoomReady({ project, room, slug, created });
    }

    const channels = [];
    const roomChannel = supabase.channel(`room:${room.id}`, {
        config: { presence: { key: user.id } },
    });
    channels.push(roomChannel);

    const presenceMeta = {
        userId: user.id,
        name: currentName,
        joinedAt: new Date().toISOString(),
    };

    const syncPresence = () => {
        if (typeof onParticipants !== 'function') return;
        const state = roomChannel.presenceState();
        onParticipants(parsePresence(state));
    };

    roomChannel.on('presence', { event: 'sync' }, syncPresence);
    roomChannel.on('presence', { event: 'join' }, syncPresence);
    roomChannel.on('presence', { event: 'leave' }, syncPresence);

    roomChannel.on('broadcast', { event: 'camera' }, ({ payload }) => {
        if (!payload || payload.sender === user.id) return;
        if (typeof onCameraState === 'function') onCameraState(payload);
    });

    roomChannel.on('broadcast', { event: 'camera-lock' }, ({ payload }) => {
        if (!payload || payload.sender === user.id) return;
        if (typeof onCameraOwner === 'function') onCameraOwner(payload.ownerId || null);
    });

    roomChannel.on('broadcast', { event: 'annotation' }, ({ payload }) => {
        if (!payload || payload.sender === user.id) return;
        if (typeof onAnnotation === 'function') onAnnotation(payload, { source: 'broadcast' });
    });

    await new Promise((resolve, reject) => {
        roomChannel.subscribe((statusValue, err) => {
            if (err) {
                reject(err);
                return;
            }
            if (statusValue === 'SUBSCRIBED') {
                roomChannel.track(presenceMeta);
                resolve();
            }
        });
    });

    const roomUpdates = supabase.channel(`room:${room.id}:updates`);
    roomUpdates.on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'rooms', filter: `id=eq.${room.id}` },
        (payload) => {
            if (typeof onRoomUpdate === 'function') onRoomUpdate(payload.new);
            const next = payload.new || {};
            if (typeof onCameraOwner === 'function') onCameraOwner(next.camera_owner_id || null);
            if (next.camera_state && typeof onCameraState === 'function') {
                onCameraState({
                    ...next.camera_state,
                    source: 'db',
                });
            }
        }
    );
    channels.push(roomUpdates);
    await roomUpdates.subscribe();

    const annotationsChannel = supabase.channel(`room:${room.id}:annotations`);
    annotationsChannel.on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'annotations', filter: `room_id=eq.${room.id}` },
        (payload) => {
            if (typeof onAnnotation === 'function') onAnnotation(payload.new, { source: 'realtime' });
        }
    );
    annotationsChannel.on(
        'postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'annotations', filter: `room_id=eq.${room.id}` },
        (payload) => {
            if (typeof onAnnotationDelete === 'function') onAnnotationDelete(payload.old);
        }
    );
    channels.push(annotationsChannel);
    await annotationsChannel.subscribe();

    const messagesChannel = supabase.channel(`room:${room.id}:messages`);
    messagesChannel.on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages', filter: `room_id=eq.${room.id}` },
        (payload) => {
            if (typeof onMessage === 'function') onMessage(payload.new, { source: 'realtime' });
        }
    );
    channels.push(messagesChannel);
    await messagesChannel.subscribe();

    const historyAnnotations = await supabase
        .from('annotations')
        .select('*')
        .eq('room_id', room.id)
        .order('created_at', { ascending: true });
    if (!historyAnnotations.error && Array.isArray(historyAnnotations.data)) {
        historyAnnotations.data.forEach((row) => {
            if (typeof onAnnotation === 'function') onAnnotation(row, { source: 'history' });
        });
    }

    const historyMessages = await supabase
        .from('messages')
        .select('*')
        .eq('room_id', room.id)
        .order('created_at', { ascending: true });
    if (!historyMessages.error && Array.isArray(historyMessages.data)) {
        historyMessages.data.forEach((row) => {
            if (typeof onMessage === 'function') onMessage(row, { source: 'history' });
        });
    }

    if (room.camera_state && typeof onCameraState === 'function') {
        onCameraState({ ...room.camera_state, source: 'db' });
    }
    if (typeof onCameraOwner === 'function') {
        onCameraOwner(room.camera_owner_id || null);
    }

    status('');

    async function setDisplayName(name) {
        currentName = normalizeName(name);
        presenceMeta.name = currentName;
        await supabase.from('profiles').upsert({
            id: user.id,
            display_name: currentName,
        });
        await roomChannel.track(presenceMeta);
        syncPresence();
        return currentName;
    }

    async function sendMessage(body) {
        const text = String(body || '').trim();
        if (!text) return null;
        const { data, error } = await supabase
            .from('messages')
            .insert({
                room_id: room.id,
                author_id: user.id,
                author_name: currentName,
                body: text,
            })
            .select('*')
            .single();
        if (error) throw error;
        return data;
    }

    async function sendAnnotation(record) {
        if (!record) return null;
        const payload = {
            room_id: room.id,
            author_id: user.id,
            author_name: currentName,
            kind: record.kind,
            payload: record.payload,
        };
        if (record.id) payload.id = record.id;
        const { data, error } = await supabase
            .from('annotations')
            .insert(payload)
            .select('*')
            .single();
        if (error) throw error;
        await roomChannel.send({
            type: 'broadcast',
            event: 'annotation',
            payload: { ...data, sender: user.id },
        });
        return data;
    }

    function delay(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function isRetriableDeleteError(err) {
        const message = String(err?.message || '');
        const details = String(err?.details || '');
        const combined = `${message} ${details}`.toLowerCase();
        if (combined.includes('failed to fetch')) return true;
        if (combined.includes('timeout') || combined.includes('timed out')) return true;
        if (combined.includes('network')) return true;
        const status = Number(err?.status || err?.statusCode || err?.code);
        if (Number.isFinite(status) && status >= 500) return true;
        return false;
    }

    function waitForOnline() {
        if (typeof window === 'undefined' || typeof navigator === 'undefined') return Promise.resolve();
        if (navigator.onLine !== false) return Promise.resolve();
        if (onlineWaitPromise) return onlineWaitPromise;
        onlineWaitPromise = new Promise((resolve) => {
            onlineWaitHandler = () => {
                window.removeEventListener('online', onlineWaitHandler);
                onlineWaitHandler = null;
                onlineWaitPromise = null;
                resolve();
            };
            window.addEventListener('online', onlineWaitHandler, { once: true });
        });
        return onlineWaitPromise;
    }

    async function processDeleteQueue() {
        if (deleteProcessing) return;
        deleteProcessing = true;
        while (deleteQueue.length) {
            const entry = deleteQueue.shift();
            if (!entry) continue;
            let done = false;
            while (!done) {
                await waitForOnline();
                try {
                    const { error } = await supabase.from('annotations').delete().eq('id', entry.id);
                    if (error) throw error;
                    entry.resolve(true);
                    deletePending.delete(entry.id);
                    done = true;
                } catch (err) {
                    entry.attempts += 1;
                    const canRetry = entry.attempts <= DELETE_RETRY_LIMIT && isRetriableDeleteError(err);
                    if (!canRetry) {
                        entry.reject(err);
                        deletePending.delete(entry.id);
                        done = true;
                        break;
                    }
                    const backoff = Math.min(10000, DELETE_RETRY_BASE_MS * (2 ** (entry.attempts - 1)));
                    await delay(backoff);
                }
            }
            if (DELETE_BETWEEN_MS > 0) {
                await delay(DELETE_BETWEEN_MS);
            }
        }
        deleteProcessing = false;
    }

    function enqueueDelete(id) {
        if (deletePending.has(id)) return deletePending.get(id).promise;
        let resolveFn;
        let rejectFn;
        const promise = new Promise((resolve, reject) => {
            resolveFn = resolve;
            rejectFn = reject;
        });
        const entry = {
            id,
            attempts: 0,
            resolve: resolveFn,
            reject: rejectFn,
            promise,
        };
        deletePending.set(id, entry);
        deleteQueue.push(entry);
        processDeleteQueue();
        return promise;
    }

    async function deleteAnnotation(id) {
        if (!id) return false;
        return enqueueDelete(id);
    }

    async function claimCamera() {
        let rpcError = null;
        const { error } = await supabase.rpc('claim_camera', { room_id: room.id });
        if (error) {
            rpcError = error;
            const { error: updateError } = await supabase
                .from('rooms')
                .update({ camera_owner_id: user.id })
                .eq('id', room.id);
            if (updateError) throw rpcError || updateError;
        }
        await roomChannel.send({
            type: 'broadcast',
            event: 'camera-lock',
            payload: { ownerId: user.id, sender: user.id },
        });
        return true;
    }

    async function releaseCamera() {
        let rpcError = null;
        const { error } = await supabase.rpc('release_camera', { room_id: room.id });
        if (error) {
            rpcError = error;
            const { error: updateError } = await supabase
                .from('rooms')
                .update({ camera_owner_id: null })
                .eq('id', room.id);
            if (updateError) throw rpcError || updateError;
        }
        await roomChannel.send({
            type: 'broadcast',
            event: 'camera-lock',
            payload: { ownerId: null, sender: user.id },
        });
        return true;
    }

    async function broadcastCameraState(state) {
        if (!state) return;
        await roomChannel.send({
            type: 'broadcast',
            event: 'camera',
            payload: { ...state, sender: user.id },
        });
    }

    async function persistCameraState(state) {
        if (!state) return;
        const payload = { camera_state: state };
        const { error } = await supabase.from('rooms').update(payload).eq('id', room.id);
        if (error) throw error;
    }

    async function updatePresence(meta) {
        Object.assign(presenceMeta, meta || {});
        await roomChannel.track(presenceMeta);
        syncPresence();
    }

    async function dispose() {
        if (onlineWaitHandler && typeof window !== 'undefined') {
            window.removeEventListener('online', onlineWaitHandler);
            onlineWaitHandler = null;
            onlineWaitPromise = null;
        }
        for (const ch of channels) {
            await supabase.removeChannel(ch);
        }
    }

    return Object.freeze({
        supabase,
        user,
        project,
        room,
        slug,
        getDisplayName: () => currentName,
        setDisplayName,
        sendMessage,
        sendAnnotation,
        deleteAnnotation,
        claimCamera,
        releaseCamera,
        broadcastCameraState,
        persistCameraState,
        updatePresence,
        dispose,
    });
}
