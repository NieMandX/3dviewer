const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class VoiceServiceError extends Error {
    constructor(status, message) {
        super(message);
        this.name = 'VoiceServiceError';
        this.status = status;
    }
}

export function createVoiceService({
    supabaseUrl = '', serviceRoleKey = '', wsUrl = '', signToken,
    fetchImpl = globalThis.fetch, timeoutMs = 10000, authorizeJoin,
} = {}) {
    const base = String(supabaseUrl).replace(/\/+$/, '');

    async function createJoinToken(authorization, body) {
        const match = /^Bearer ([^\s]+)$/i.exec(String(authorization || ''));
        if (!match || match[1].length > 16384) {
            throw new VoiceServiceError(401, 'Voice session is required.');
        }
        if (!base || !serviceRoleKey || typeof signToken !== 'function') {
            throw new VoiceServiceError(503, 'Voice authorization is unavailable.');
        }
        const roomId = typeof body?.room === 'string' && body.room.startsWith('room:')
            ? body.room.slice(5).toLowerCase() : '';
        if (!UUID.test(roomId)) throw new VoiceServiceError(400, 'Invalid voice room.');

        // Use the verified user's JWT for both requests, never service-role RLS bypass.
        const headers = { apikey: serviceRoleKey, Authorization: `Bearer ${match[1]}` };
        const signal = AbortSignal.timeout(timeoutMs);
        async function getJson(path, authenticating = false) {
            try {
                const response = await fetchImpl(`${base}${path}`, {
                    headers, signal, cache: 'no-store', redirect: 'error',
                });
                if (response.status === 401 || (authenticating && response.status === 403)) {
                    throw new VoiceServiceError(401, 'Voice session has expired.');
                }
                if (response.status === 403) throw new VoiceServiceError(403, 'Voice room access denied.');
                if (!response.ok) throw new Error('Backend unavailable');
                return await response.json();
            } catch (error) {
                if (error instanceof VoiceServiceError) throw error;
                // Do not expose backend responses, URLs or credentials to clients/logs.
                throw new VoiceServiceError(503, 'Voice authorization is unavailable.');
            }
        }

        const user = await getJson('/auth/v1/user', true);
        if (!UUID.test(user?.id || '')) throw new VoiceServiceError(401, 'Invalid voice session.');
        const rooms = await getJson(`/rest/v1/rooms?select=id,project_id&id=eq.${roomId}&limit=1`);
        const room = Array.isArray(rooms) && rooms.length === 1 ? rooms[0] : null;
        if (room?.id !== roomId || !UUID.test(room?.project_id || '')) {
            throw new VoiceServiceError(403, 'Voice room access denied.');
        }
        const identity = user.id;
        const name = typeof body.name === 'string' ? body.name.trim().slice(0, 128) || 'Guest' : 'Guest';
        const permissions = {
            canPublish: body?.permissions?.canPublish !== false,
            canSubscribe: body?.permissions?.canSubscribe !== false,
            canPublishData: body?.permissions?.canPublishData !== false,
        };
        const roomName = `room:${roomId}`;
        const metadata = JSON.stringify({
            source: 'lpmview', roomId, projectId: room.project_id,
            registered: user.is_anonymous === false && !!user.email,
        });
        await authorizeJoin?.(roomId, identity);
        const token = await signToken({ identity, name, metadata }, {
            roomJoin: true, room: roomName, ...permissions, canUpdateOwnMetadata: false,
        });
        return { token, wsUrl, room: roomName, identity, name, permissions };
    }

    return { createJoinToken };
}
