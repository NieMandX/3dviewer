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

async function createRoom(supabase, slug, ownerId) {
    const payload = {
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

async function ensureRoom(supabase, slug, ownerId) {
    const safeSlug = String(slug || '').trim();
    if (safeSlug) {
        const existing = await fetchRoomBySlug(supabase, safeSlug);
        if (existing) return { room: existing, slug: safeSlug, created: false };
        const created = await createRoom(supabase, safeSlug, ownerId);
        return { room: created, slug: safeSlug, created: true };
    }
    let attempts = 0;
    while (attempts < 5) {
        attempts += 1;
        const nextSlug = makeSlug(8);
        const existing = await fetchRoomBySlug(supabase, nextSlug);
        if (existing) continue;
        const created = await createRoom(supabase, nextSlug, ownerId);
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
        roomSlug,
        displayName,
        onStatus,
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

    const supabase = await createSupabaseClient({
        url: supabaseUrl,
        anonKey: supabaseAnonKey,
    });

    const user = await ensureAuth(supabase);
    let currentName = normalizeName(displayName);

    const { room, slug, created } = await ensureRoom(supabase, roomSlug, user.id);

    if (currentName) {
        await supabase.from('profiles').upsert({
            id: user.id,
            display_name: currentName,
        });
    }

    if (typeof onRoomReady === 'function') {
        onRoomReady({ room, slug, created });
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
        return data;
    }

    async function deleteAnnotation(id) {
        if (!id) return false;
        const { error } = await supabase.from('annotations').delete().eq('id', id);
        if (error) throw error;
        return true;
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
        for (const ch of channels) {
            await supabase.removeChannel(ch);
        }
    }

    return Object.freeze({
        supabase,
        user,
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
