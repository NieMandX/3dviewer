import { createSupabaseClient } from './supabase-client.js';
import { createRealtimeChannelStatusHandler } from './realtime-channel-status.js';
import { makeAbortError, runAbortableOperation } from './abortable-tus-upload.js';

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
            lastSeenAt: meta?.lastSeenAt || null,
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
        onConnectionState,
        signal,
    } = options;

    const status = typeof onStatus === 'function' ? onStatus : () => {};
    const connectionStateCallback = typeof onConnectionState === 'function' ? onConnectionState : null;
    status('Connecting…');
    const abortMessage = 'Collab controller init aborted';

    function throwIfAborted() {
        if (signal?.aborted) throw signal.reason || makeAbortError(abortMessage);
    }

    async function awaitCurrent(operation) {
        const result = await runAbortableOperation(operation, { signal, abortMessage });
        throwIfAborted();
        return result;
    }

    let lastConnectionState = null;
    let lastConnectionReason = '';
    function emitConnectionState(connected, reason = '') {
        if (!connectionStateCallback) return;
        const nextConnected = !!connected;
        const nextReason = String(reason || '');
        if (lastConnectionState === nextConnected && lastConnectionReason === nextReason) return;
        lastConnectionState = nextConnected;
        lastConnectionReason = nextReason;
        try {
            connectionStateCallback({ connected: nextConnected, reason: nextReason });
        } catch (_) {}
    }

    throwIfAborted();
    const supabase = injectedSupabase || await awaitCurrent(() => createSupabaseClient({
        url: supabaseUrl,
        anonKey: supabaseAnonKey,
    }));

    const user = injectedUser || await awaitCurrent(() => ensureAuth(supabase));
    let currentName = normalizeName(displayName);

    let project = injectedProject || null;
    if (!project) {
        if (projectId) {
            project = await awaitCurrent(() => fetchProjectById(supabase, projectId));
        } else if (projectSlug) {
            project = await awaitCurrent(() => joinProjectBySlug(supabase, projectSlug));
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
            room = await awaitCurrent(() => fetchRoomById(supabase, roomId));
        } else {
            const result = await awaitCurrent(() => ensureRoom(supabase, project.id, roomSlug, user.id));
            room = result.room;
            slug = result.slug;
            created = result.created;
        }
    }
    if (!room) {
        throw new Error('Room not found.');
    }

    let disposed = false;
    const deleteQueue = [];
    const deletePending = new Map();
    let deleteProcessing = false;
    let onlineWaitHandler = null;
    let onlineWaitPromise = null;
    let onlineWaitResolve = null;
    const delayWaits = new Set();

    const DELETE_RETRY_LIMIT = 6;
    const DELETE_RETRY_BASE_MS = 300;
    const DELETE_BETWEEN_MS = 120;

    if (currentName) {
        await awaitCurrent(() => supabase.from('profiles').upsert({
            id: user.id,
            display_name: currentName,
        }));
    }

    if (typeof onRoomReady === 'function') {
        onRoomReady({ project, room, slug, created });
    }

    const channels = [];
    let presenceHeartbeat = null;
    const deliveredAnnotationIds = new Set();
    const deletedAnnotationIds = new Set();
    const deliveredMessageIds = new Set();

    function getRecordId(record) {
        return String(record?.id || record?.message_id || '').trim();
    }

    function deliverAnnotation(record, meta) {
        if (disposed) return;
        if (typeof onAnnotation !== 'function') return;
        const id = getRecordId(record);
        if (id) {
            if (deletedAnnotationIds.has(id) || deliveredAnnotationIds.has(id)) return;
            deliveredAnnotationIds.add(id);
        }
        onAnnotation(record, meta);
    }

    function deliverAnnotationDelete(record, meta) {
        if (disposed) return;
        if (typeof onAnnotationDelete !== 'function') return;
        const id = getRecordId(record);
        if (id) {
            if (deletedAnnotationIds.has(id)) return;
            deletedAnnotationIds.add(id);
            deliveredAnnotationIds.delete(id);
        }
        onAnnotationDelete(record, meta);
    }

    function deliverMessage(record, meta) {
        if (disposed) return;
        if (typeof onMessage !== 'function') return;
        const id = getRecordId(record);
        if (id) {
            if (deliveredMessageIds.has(id)) return;
            deliveredMessageIds.add(id);
        }
        onMessage(record, meta);
    }

    function stopPresenceHeartbeat() {
        if (!presenceHeartbeat) return;
        clearInterval(presenceHeartbeat);
        presenceHeartbeat = null;
    }

    async function removeRealtimeChannels() {
        for (const ch of channels) {
            try {
                await supabase.removeChannel(ch);
            } catch (_) {}
        }
    }

    async function cleanupInitFailure(err) {
        disposed = true;
        stopPresenceHeartbeat();
        await removeRealtimeChannels();
        throw err;
    }

    function subscribeTrackedChannel(channel, label) {
        return new Promise((resolve, reject) => {
            let settled = false;
            const finishResolve = () => {
                if (settled) return;
                settled = true;
                resolve();
            };
            const finishReject = (err, reason) => {
                if (settled) return;
                settled = true;
                reject(err || new Error(`${label} realtime subscribe ${reason || 'failed'}`));
            };
            const handleStatus = createRealtimeChannelStatusHandler({
                label,
                isCurrent: () => !disposed,
                onSubscribed: finishResolve,
                onFailure: ({ error, reason }) => {
                    emitConnectionState(false, reason);
                    finishReject(error, reason);
                },
            });

            let result = null;
            try {
                result = channel.subscribe(handleStatus);
            } catch (err) {
                emitConnectionState(false, `${label}:SUBSCRIBE_ERROR`);
                finishReject(err, 'SUBSCRIBE_ERROR');
                return;
            }

            if (result && typeof result.then === 'function') {
                result.then((statusValue) => {
                    if (statusValue) handleStatus(statusValue);
                }).catch((err) => {
                    emitConnectionState(false, `${label}:SUBSCRIBE_ERROR`);
                    finishReject(err, 'SUBSCRIBE_ERROR');
                });
            }
        });
    }

    const roomChannel = supabase.channel(`room:${room.id}`, {
        config: { presence: { key: user.id } },
    });
    channels.push(roomChannel);

    const presenceMeta = {
        userId: user.id,
        name: currentName,
        joinedAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
    };

    function handlePresenceTrackFailure(err) {
        if (disposed) return;
        try {
            console.warn('Presence track failed', err);
        } catch (_) {}
    }

    function trackPresenceMeta() {
        if (disposed) return Promise.resolve(null);
        try {
            return Promise.resolve(roomChannel.track(presenceMeta)).catch((err) => {
                handlePresenceTrackFailure(err);
                return null;
            });
        } catch (err) {
            handlePresenceTrackFailure(err);
            return Promise.resolve(null);
        }
    }

    const syncPresence = () => {
        if (disposed) return;
        if (typeof onParticipants !== 'function') return;
        const state = roomChannel.presenceState();
        onParticipants(parsePresence(state));
    };

    roomChannel.on('presence', { event: 'sync' }, syncPresence);
    roomChannel.on('presence', { event: 'join' }, syncPresence);
    roomChannel.on('presence', { event: 'leave' }, syncPresence);

    roomChannel.on('broadcast', { event: 'camera' }, ({ payload }) => {
        if (disposed) return;
        if (!payload || payload.sender === user.id) return;
        if (typeof onCameraState === 'function') onCameraState(payload);
    });

    roomChannel.on('broadcast', { event: 'camera-lock' }, ({ payload }) => {
        if (disposed) return;
        if (!payload || payload.sender === user.id) return;
        if (typeof onCameraOwner === 'function') onCameraOwner(payload.ownerId || null);
    });

    roomChannel.on('broadcast', { event: 'annotation' }, ({ payload }) => {
        if (disposed) return;
        if (!payload || payload.sender === user.id) return;
        deliverAnnotation(payload, { source: 'broadcast' });
    });

    roomChannel.on('broadcast', { event: 'annotation-delete' }, ({ payload }) => {
        if (disposed) return;
        if (!payload || payload.sender === user.id) return;
        deliverAnnotationDelete(payload, { source: 'broadcast' });
    });

    roomChannel.on('broadcast', { event: 'message' }, ({ payload }) => {
        if (disposed) return;
        if (!payload || payload.sender === user.id) return;
        deliverMessage(payload, { source: 'broadcast' });
    });

    try {
        await awaitCurrent(() => new Promise((resolve, reject) => {
            let settled = false;
            const rejectInitialSubscribe = (reason, fallbackMessage) => {
                if (settled) return;
                settled = true;
                reject(reason || new Error(fallbackMessage));
            };
            roomChannel.subscribe((statusValue, err) => {
                const nextStatus = String(statusValue || '');
                if (disposed) return;
                if (err) {
                    emitConnectionState(false, 'SUBSCRIBE_ERROR');
                    rejectInitialSubscribe(err, 'Room realtime subscribe failed');
                    return;
                }
                if (nextStatus === 'SUBSCRIBED') {
                    if (settled) return;
                    settled = true;
                    emitConnectionState(true, nextStatus);
                    void trackPresenceMeta();
                    resolve();
                    return;
                }
                if (nextStatus === 'CLOSED' || nextStatus === 'CHANNEL_ERROR' || nextStatus === 'TIMED_OUT') {
                    emitConnectionState(false, nextStatus);
                    rejectInitialSubscribe(null, `Room realtime subscribe ${nextStatus}`);
                }
            });
        }));
    } catch (err) {
        await cleanupInitFailure(err);
    }

    const PRESENCE_HEARTBEAT_MS = 8000;
    const startPresenceHeartbeat = () => {
        if (presenceHeartbeat) return;
        presenceHeartbeat = setInterval(async () => {
            try {
                presenceMeta.lastSeenAt = new Date().toISOString();
                await trackPresenceMeta();
            } catch (_) {}
        }, PRESENCE_HEARTBEAT_MS);
    };
    startPresenceHeartbeat();

    try {
        const roomUpdates = supabase.channel(`room:${room.id}:updates`);
        roomUpdates.on(
            'postgres_changes',
            { event: 'UPDATE', schema: 'public', table: 'rooms', filter: `id=eq.${room.id}` },
            (payload) => {
                if (disposed) return;
                const next = payload.new || {};
                if (next && typeof next === 'object') {
                    try {
                        Object.assign(room, next);
                    } catch (_) {}
                }
                if (typeof onRoomUpdate === 'function') onRoomUpdate(room);
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
        await awaitCurrent(() => subscribeTrackedChannel(roomUpdates, 'room_updates'));

        const annotationsChannel = supabase.channel(`room:${room.id}:annotations`);
        annotationsChannel.on(
            'postgres_changes',
            { event: 'INSERT', schema: 'public', table: 'annotations', filter: `room_id=eq.${room.id}` },
            (payload) => {
                if (disposed) return;
                deliverAnnotation(payload.new, { source: 'realtime' });
            }
        );
        annotationsChannel.on(
            'postgres_changes',
            { event: 'DELETE', schema: 'public', table: 'annotations', filter: `room_id=eq.${room.id}` },
            (payload) => {
                if (disposed) return;
                deliverAnnotationDelete(payload.old, { source: 'realtime' });
            }
        );
        channels.push(annotationsChannel);
        await awaitCurrent(() => subscribeTrackedChannel(annotationsChannel, 'annotations'));

        const messagesChannel = supabase.channel(`room:${room.id}:messages`);
        messagesChannel.on(
            'postgres_changes',
            { event: 'INSERT', schema: 'public', table: 'messages', filter: `room_id=eq.${room.id}` },
            (payload) => {
                if (disposed) return;
                deliverMessage(payload.new, { source: 'realtime' });
            }
        );
        channels.push(messagesChannel);
        await awaitCurrent(() => subscribeTrackedChannel(messagesChannel, 'messages'));

        const historyAnnotations = await awaitCurrent(() => (
            supabase
                .from('annotations')
                .select('*')
                .eq('room_id', room.id)
                .order('created_at', { ascending: true })
        ));
        if (!historyAnnotations.error && Array.isArray(historyAnnotations.data)) {
            historyAnnotations.data.forEach((row) => {
                if (disposed) return;
                deliverAnnotation(row, { source: 'history' });
            });
        }

        const historyMessages = await awaitCurrent(() => (
            supabase
                .from('messages')
                .select('*')
                .eq('room_id', room.id)
                .order('created_at', { ascending: true })
        ));
        if (!historyMessages.error && Array.isArray(historyMessages.data)) {
            historyMessages.data.forEach((row) => {
                if (disposed) return;
                deliverMessage(row, { source: 'history' });
            });
        }

        if (!disposed && room.camera_state && typeof onCameraState === 'function') {
            onCameraState({ ...room.camera_state, source: 'db' });
        }
        if (!disposed && typeof onCameraOwner === 'function') {
            onCameraOwner(room.camera_owner_id || null);
        }

        status('');
    } catch (err) {
        await cleanupInitFailure(err);
    }

    function canRealtimeSend(channel) {
        if (!channel) return false;
        const socket = channel.socket || null;
        const connected = typeof socket?.isConnected === 'function' ? socket.isConnected() : false;
        const state = String(channel.state || '').toLowerCase();
        return connected && state === 'joined';
    }

    function getBroadcastSender(channel) {
        if (!channel) return null;
        const sendFn = typeof channel.send === 'function' ? channel.send.bind(channel) : null;
        const httpSendFn = typeof channel.httpSend === 'function' ? channel.httpSend.bind(channel) : null;
        if (sendFn && canRealtimeSend(channel)) {
            return { mode: 'realtime', fn: sendFn };
        }
        if (httpSendFn) {
            return { mode: 'http', fn: httpSendFn };
        }
        if (sendFn) {
            return { mode: 'realtime', fn: sendFn };
        }
        return null;
    }

    async function sendBroadcast(event, payload) {
        if (disposed) return false;
        const sender = getBroadcastSender(roomChannel);
        if (!sender) return false;
        const safePayload = payload ?? {};
        try {
            if (sender.mode === 'http') {
                await sender.fn(event, safePayload);
            } else {
                await sender.fn({ type: 'broadcast', event, payload: safePayload });
            }
            return true;
        } catch (err) {
            // Broadcast is an optimization; DB realtime still keeps peers in sync.
            if (!disposed) console.warn('Broadcast send failed', err);
            return false;
        }
    }

    async function setDisplayName(name) {
        if (disposed) return currentName;
        currentName = normalizeName(name);
        presenceMeta.name = currentName;
        try {
            const { error } = await supabase.from('profiles').upsert({
                id: user.id,
                display_name: currentName,
            }) || {};
            if (disposed) return currentName;
            if (error) throw error;
        } catch (err) {
            if (disposed) return currentName;
            throw err;
        }
        if (disposed) return currentName;
        await trackPresenceMeta();
        if (disposed) return currentName;
        syncPresence();
        return currentName;
    }

    async function sendMessage(body) {
        if (disposed) return null;
        const text = String(body || '').trim();
        if (!text) return null;
        let data = null;
        let error = null;
        try {
            ({ data, error } = await supabase
                .from('messages')
                .insert({
                    room_id: room.id,
                    author_id: user.id,
                    author_name: currentName,
                    body: text,
                })
                .select('*')
                .single() || {});
        } catch (err) {
            if (disposed) return null;
            throw err;
        }
        if (disposed) return null;
        if (error) throw error;
        await sendBroadcast('message', { ...data, sender: user.id });
        if (disposed) return null;
        return data;
    }

    async function sendAnnotation(record) {
        if (disposed) return null;
        if (!record) return null;
        const payload = {
            room_id: room.id,
            author_id: user.id,
            author_name: currentName,
            kind: record.kind,
            payload: record.payload,
        };
        if (record.id) payload.id = record.id;
        let data = null;
        let error = null;
        try {
            ({ data, error } = await supabase
                .from('annotations')
                .insert(payload)
                .select('*')
                .single() || {});
        } catch (err) {
            if (disposed) return null;
            throw err;
        }
        if (disposed) return null;
        if (error) throw error;
        await sendBroadcast('annotation', { ...data, sender: user.id });
        if (disposed) return null;
        return data;
    }

    function delay(ms) {
        if (disposed) return Promise.resolve();
        let entry = null;
        return new Promise((resolve) => {
            entry = {
                timer: null,
                resolve: () => {
                    if (entry) delayWaits.delete(entry);
                    resolve();
                },
            };
            entry.timer = setTimeout(entry.resolve, ms);
            delayWaits.add(entry);
        });
    }

    function clearDelayWaits() {
        delayWaits.forEach((entry) => {
            try {
                clearTimeout(entry.timer);
            } catch (_) {}
            try {
                entry.resolve?.();
            } catch (_) {}
        });
        delayWaits.clear();
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
            onlineWaitResolve = resolve;
            onlineWaitHandler = () => {
                clearOnlineWait();
            };
            window.addEventListener('online', onlineWaitHandler, { once: true });
        });
        return onlineWaitPromise;
    }

    function clearOnlineWait() {
        const handler = onlineWaitHandler;
        if (handler && typeof window !== 'undefined') {
            window.removeEventListener('online', handler);
        }
        const resolve = onlineWaitResolve;
        onlineWaitHandler = null;
        onlineWaitPromise = null;
        onlineWaitResolve = null;
        try {
            resolve?.();
        } catch (_) {}
    }

    async function processDeleteQueue() {
        if (deleteProcessing) return;
        deleteProcessing = true;
        while (!disposed && deleteQueue.length) {
            const entry = deleteQueue.shift();
            if (!entry) continue;
            let done = false;
            while (!done) {
                await waitForOnline();
                if (disposed) break;
                try {
                    const { error } = await supabase.from('annotations').delete().eq('id', entry.id);
                    if (error) throw error;
                    await sendBroadcast('annotation-delete', { id: entry.id, sender: user.id });
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
                    if (disposed) break;
                }
            }
            if (disposed) break;
            if (DELETE_BETWEEN_MS > 0) {
                await delay(DELETE_BETWEEN_MS);
            }
        }
        deleteProcessing = false;
    }

    function enqueueDelete(id) {
        if (disposed) return Promise.reject(new Error('Collab controller disposed'));
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
        if (disposed) return false;
        let rpcError = null;
        let error = null;
        try {
            ({ error } = await supabase.rpc('claim_camera', { room_id: room.id }) || {});
        } catch (err) {
            if (disposed) return false;
            throw err;
        }
        if (disposed) return false;
        if (error) {
            rpcError = error;
            let updateError = null;
            try {
                ({ error: updateError } = await supabase
                    .from('rooms')
                    .update({ camera_owner_id: user.id })
                    .eq('id', room.id) || {});
            } catch (err) {
                if (disposed) return false;
                throw err;
            }
            if (disposed) return false;
            if (updateError) throw rpcError || updateError;
        }
        await sendBroadcast('camera-lock', { ownerId: user.id, sender: user.id });
        return !disposed;
    }

    async function releaseCamera() {
        if (disposed) return false;
        let rpcError = null;
        let error = null;
        try {
            ({ error } = await supabase.rpc('release_camera', { room_id: room.id }) || {});
        } catch (err) {
            if (disposed) return false;
            throw err;
        }
        if (disposed) return false;
        if (error) {
            rpcError = error;
            let updateError = null;
            try {
                ({ error: updateError } = await supabase
                    .from('rooms')
                    .update({ camera_owner_id: null })
                    .eq('id', room.id) || {});
            } catch (err) {
                if (disposed) return false;
                throw err;
            }
            if (disposed) return false;
            if (updateError) throw rpcError || updateError;
        }
        await sendBroadcast('camera-lock', { ownerId: null, sender: user.id });
        return !disposed;
    }

    async function broadcastCameraState(state) {
        if (disposed) return;
        if (!state) return;
        await sendBroadcast('camera', { ...state, sender: user.id });
    }

    async function persistCameraState(state) {
        if (disposed) return;
        if (!state) return;
        const payload = { camera_state: state };
        let error = null;
        try {
            ({ error } = await supabase.from('rooms').update(payload).eq('id', room.id) || {});
        } catch (err) {
            if (disposed) return;
            throw err;
        }
        if (disposed) return;
        if (error) throw error;
    }

    async function updatePresence(meta) {
        if (disposed) return;
        Object.assign(presenceMeta, meta || {});
        if (!presenceMeta.lastSeenAt) {
            presenceMeta.lastSeenAt = new Date().toISOString();
        }
        await trackPresenceMeta();
        if (disposed) return;
        syncPresence();
    }

    async function dispose() {
        if (disposed) return;
        disposed = true;
        emitConnectionState(false, 'DISPOSED');
        deleteQueue.length = 0;
        deletePending.forEach((entry) => {
            try {
                entry.reject?.(new Error('Collab controller disposed'));
            } catch (_) {}
        });
        deletePending.clear();
        clearDelayWaits();
        clearOnlineWait();
        stopPresenceHeartbeat();
        await removeRealtimeChannels();
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
