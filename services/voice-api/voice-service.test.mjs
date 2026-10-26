import assert from 'node:assert/strict';
import test from 'node:test';
import { createVoiceService, VoiceServiceError } from './voice-service.mjs';

const roomId = '11111111-1111-4111-8111-111111111111';
const projectId = '22222222-2222-4222-8222-222222222222';
const userId = '33333333-3333-4333-8333-333333333333';
const body = { room: `room:${roomId}`, name: 'Test User' };
const authorization = 'Bearer user-session';

function fixture({ authStatus = 200, roomStatus = 200, user = {
    id: userId, is_anonymous: false, email: 'test@example.invalid',
}, rooms = [{ id: roomId, project_id: projectId }], fetchImpl, ...options } = {}) {
    const calls = [];
    const signed = [];
    const service = createVoiceService({
        supabaseUrl: 'https://backend.invalid', serviceRoleKey: 'private-api-key',
        wsUrl: 'wss://voice.invalid',
        fetchImpl: fetchImpl || (async (url, request) => {
            calls.push({ url: new URL(url), request });
            return url.includes('/auth/')
                ? Response.json(user, { status: authStatus })
                : Response.json(rooms, { status: roomStatus });
        }),
        signToken: async (participant, grants) => {
            signed.push({ participant, grants });
            return 'signed-livekit-token';
        },
        ...options,
    });
    return { service, calls, signed };
}

const statusIs = (status) => error => error instanceof VoiceServiceError && error.status === status;

test('voice uses a verified user and user-scoped RLS, not client identity or metadata', async () => {
    const { service, calls, signed } = fixture();
    const result = await service.createJoinToken(authorization, {
        ...body, identity: 'admin', metadata: { registered: false, projectId: 'attacker-project' },
        permissions: { canPublish: false, roomAdmin: true },
    });
    assert.equal(result.identity, userId);
    assert.equal(result.room, body.room);
    assert.equal(result.wsUrl, 'wss://voice.invalid');
    assert.equal(signed.length, 1);
    assert.deepEqual(JSON.parse(signed[0].participant.metadata), {
        source: 'lpmview', roomId, projectId, registered: true,
    });
    assert.deepEqual(signed[0].grants, {
        roomJoin: true, room: body.room, canPublish: false, canSubscribe: true,
        canPublishData: true, canUpdateOwnMetadata: false,
    });
    assert.equal(calls[0].url.pathname, '/auth/v1/user');
    assert.equal(calls[1].url.pathname, '/rest/v1/rooms');
    assert.equal(calls[1].url.searchParams.get('id'), `eq.${roomId}`);
    assert.equal(calls[1].url.searchParams.get('select'), 'id,project_id');
    for (const { request } of calls) {
        assert.equal(request.headers.Authorization, authorization);
        assert.equal(request.headers.apikey, 'private-api-key');
        assert.equal(request.cache, 'no-store');
        assert.equal(request.redirect, 'error');
        assert.ok(request.signal);
    }
    assert.equal(calls[0].request.signal, calls[1].request.signal);
    assert.equal(JSON.stringify(result).includes('private-api-key'), false);
});

test('invited anonymous Auth user can join a room visible to their RLS identity', async () => {
    const { service, signed } = fixture({ user: { id: userId, is_anonymous: true } });
    await service.createJoinToken(authorization, body);
    assert.equal(JSON.parse(signed[0].participant.metadata).registered, false);
    assert.equal(signed[0].participant.identity, userId);
});

test('missing, malformed or oversized authorization never calls backend or signer', async () => {
    const { service, calls, signed } = fixture();
    for (const value of ['', 'Basic user-session', 'Bearer ', 'Bearer user token', `Bearer ${'x'.repeat(16385)}`]) {
        await assert.rejects(service.createJoinToken(value, body), statusIs(401));
    }
    assert.equal(calls.length, 0);
    assert.equal(signed.length, 0);
});

test('malformed rooms and query injection are rejected before backend access', async () => {
    const { service, calls } = fixture();
    for (const value of [null, {}, [], { room: roomId }, { room: `room:${roomId}&id=not.is.null` }, { room: 123 }]) {
        await assert.rejects(service.createJoinToken(authorization, value), statusIs(400));
    }
    assert.equal(calls.length, 0);
});

test('expired or forged Auth session cannot reach room lookup', async () => {
    for (const options of [{ authStatus: 401 }, { authStatus: 403 }, { user: {} }]) {
        const { service, calls, signed } = fixture(options);
        await assert.rejects(service.createJoinToken(authorization, body), statusIs(401));
        assert.equal(calls.length, 1);
        assert.equal(signed.length, 0);
    }
});

test('inaccessible, absent, malformed or mismatched room never signs a token', async () => {
    for (const options of [
        { rooms: [] }, { rooms: {} }, { rooms: [{ id: projectId, project_id: projectId }] },
        { rooms: [{ id: roomId }] }, { roomStatus: 403 },
    ]) {
        const { service, signed } = fixture(options);
        await assert.rejects(service.createJoinToken(authorization, body), statusIs(403));
        assert.equal(signed.length, 0);
    }
});

test('backend configuration and failures fail closed without leaking upstream details', async () => {
    for (const options of [
        { serviceRoleKey: '' }, { supabaseUrl: '' }, { authStatus: 500 }, { roomStatus: 500 },
        { fetchImpl: async () => { throw new Error('secret backend diagnostic'); } },
        { fetchImpl: async () => new Response('secret invalid JSON') },
    ]) {
        const { service, signed } = fixture(options);
        await assert.rejects(service.createJoinToken(authorization, body), error => {
            assert.equal(error.message.includes('secret'), false);
            return statusIs(503)(error);
        });
        assert.equal(signed.length, 0);
    }
});

test('hung authorization request times out and never signs a token', async () => {
    const keepAlive = setTimeout(() => {}, 1000);
    try {
        const { service, signed } = fixture({ timeoutMs: 20, fetchImpl: (_url, { signal }) =>
            new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) });
        await assert.rejects(service.createJoinToken(authorization, body), statusIs(503));
        assert.equal(signed.length, 0);
    } finally {
        clearTimeout(keepAlive);
    }
});

test('membership is rechecked on every request, not cached after revocation', async () => {
    const rooms = [{ id: roomId, project_id: projectId }];
    const { service, signed } = fixture({ rooms });
    await service.createJoinToken(authorization, body);
    rooms.length = 0;
    await assert.rejects(service.createJoinToken(authorization, body), statusIs(403));
    assert.equal(signed.length, 1);
});
