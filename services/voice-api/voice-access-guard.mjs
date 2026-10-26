import { VoiceServiceError } from './voice-service.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const roomIdOf = name => typeof name === 'string' && name.startsWith('room:') && UUID.test(name.slice(5)) ? name.slice(5) : null;
const unavailable = () => new VoiceServiceError(503, 'Voice access verification is unavailable.');
const denied = () => new VoiceServiceError(403, 'Voice room access denied.');

export function extractVoiceToken(uri, authorization = '', method = 'GET') {
    if (method !== 'GET' || typeof uri !== 'string' || uri.length > 65536 || !uri.startsWith('/rtc')) throw denied();
    const url = new URL(uri, 'http://voice.invalid');
    if (!['/rtc', '/rtc/validate', '/rtc/v1', '/rtc/v1/validate'].includes(url.pathname)) throw denied();
    const values = url.searchParams.getAll('access_token');
    const header = /^Bearer ([^\s]+)$/i.exec(authorization)?.[1];
    if (values.length > 1 || (authorization && !header) || (header && values.length && values[0] !== header)) throw denied();
    const token = header || values[0];
    if (!token || token.length > 16384 || /\s/.test(token)) throw new VoiceServiceError(401, 'Voice token is required.');
    return token;
}

export function createVoiceAccessGuard({
    supabaseUrl, serviceRoleKey, roomClient, verifyToken, fetchImpl = globalThis.fetch,
    intervalMs = 10000, timeoutMs = 3000, now = Date.now,
} = {}) {
    const base = new URL(supabaseUrl);
    if (!serviceRoleKey || !['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw unavailable();
    let stopped = false, timer, pending, started = false, lastSweepAt = null, lastSweepOk = false, inFlight = 0, removed = 0;
    const controller = new AbortController();

    async function checkAccess(roomId, userId) {
        if (stopped) throw unavailable();
        if (!UUID.test(roomId || '') || !UUID.test(userId || '')) return false;
        if (inFlight >= 32) throw unavailable();
        inFlight++;
        try {
            const response = await fetchImpl(new URL('/rest/v1/rpc/check_voice_room_access', base), {
                method: 'POST', redirect: 'error', cache: 'no-store',
                headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ check_room_id: roomId, check_user_id: userId }),
                signal: AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]),
            });
            if (!response.ok) throw unavailable();
            const allowed = await response.json();
            if (typeof allowed !== 'boolean') throw unavailable();
            return allowed;
        } catch (_) { throw unavailable(); }
        finally { inFlight--; }
    }
    function state() {
        return { ready: !stopped && lastSweepOk && lastSweepAt !== null && now() - lastSweepAt < 60000,
            lastSweepAt, removed };
    }
    async function authorizeJoin(roomId, userId) {
        if (!state().ready) throw unavailable();
        if (!await checkAccess(roomId, userId)) throw denied();
    }
    async function admit(token) {
        let claims;
        try { claims = await verifyToken(token); } catch (_) { throw new VoiceServiceError(401, 'Invalid voice token.'); }
        const roomId = roomIdOf(claims?.video?.room);
        let metadata;
        try { metadata = JSON.parse(claims?.metadata); } catch (_) { throw denied(); }
        if (!roomId || !UUID.test(claims.sub || '') || !Number.isFinite(claims.exp) || claims.exp <= Math.floor(now() / 1000)
            || claims.video.roomJoin !== true || claims.video.roomAdmin || claims.video.canUpdateOwnMetadata
            || metadata?.source !== 'lpmview' || metadata.roomId !== roomId) throw denied();
        await authorizeJoin(roomId, claims.sub);
    }
    async function inspectParticipant(roomName, participant) {
        if (stopped) return;
        let allowed = false, verified = true;
        try { allowed = await checkAccess(roomIdOf(roomName), participant.identity); }
        catch (_) { verified = false; }
        if (stopped) return;
        if (!allowed) {
            try { await roomClient.removeParticipant(roomName, participant.identity); removed++; }
            catch (error) { if (error?.code !== 'not_found') throw unavailable(); }
        }
        if (!verified) throw unavailable();
    }
    function sweep() {
        if (stopped) return Promise.resolve();
        if (pending) return pending;
        pending = (async () => {
            let ok = true;
            try {
                const rooms = await roomClient.listRooms();
                for (const room of rooms) {
                    if (stopped) return;
                    if (!roomIdOf(room.name)) continue;
                    let participants;
                    try { participants = await roomClient.listParticipants(room.name); }
                    catch (error) { if (error?.code !== 'not_found') ok = false; continue; }
                    // Bounded concurrency; await every check before the next sweep.
                    for (let i = 0; i < participants.length && !stopped; i += 4) {
                        const results = await Promise.allSettled(participants.slice(i, i + 4).map(p => inspectParticipant(room.name, p)));
                        if (results.some(result => result.status === 'rejected')) ok = false;
                    }
                }
            } catch (_) { ok = false; }
            finally {
                lastSweepOk = ok && !stopped; lastSweepAt = now(); pending = undefined;
            }
        })();
        return pending;
    }
    function start() {
        if (started || stopped) return;
        started = true;
        const tick = async () => {
            await sweep();
            if (!stopped) { timer = setTimeout(tick, intervalMs); timer.unref?.(); }
        };
        void tick();
    }
    async function dispose() {
        stopped = true; clearTimeout(timer); controller.abort();
        await pending;
    }
    return { checkAccess, authorizeJoin, admit, sweep, start, dispose, state };
}
