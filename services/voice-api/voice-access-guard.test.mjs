import assert from 'node:assert/strict';
import test from 'node:test';
import { createVoiceAccessGuard, extractVoiceToken } from './voice-access-guard.mjs';

const roomId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';
const room = `room:${roomId}`;
const claims = () => ({ sub: userId, exp: Math.floor(Date.now() / 1000) + 60,
    video: { room, roomJoin: true, canUpdateOwnMetadata: false }, metadata: JSON.stringify({ source: 'lpmview', roomId }) });
const status = value => error => error.status === value;
function fixture(options = {}) {
    let allowed = true;
    const removed = [], calls = [];
    const client = { listRooms: async () => [{ name: room }], listParticipants: async () => [{ identity: userId }],
        removeParticipant: async (...args) => removed.push(args), ...options.client };
    const guard = createVoiceAccessGuard({ supabaseUrl: 'https://backend.invalid', serviceRoleKey: 'secret',
        roomClient: client, verifyToken: async () => claims(), fetchImpl: async (url, init) => {
            calls.push({ url, init }); return Response.json(allowed);
        }, ...options });
    return { guard, client, removed, calls, setAllowed: value => { allowed = value; } };
}

test('extracts the same query/header token for all supported RTC entrypoints', () => {
    for (const path of ['/rtc', '/rtc/validate', '/rtc/v1', '/rtc/v1/validate']) {
        assert.equal(extractVoiceToken(`${path}?access_token=token`), 'token');
        assert.equal(extractVoiceToken(path, 'Bearer token'), 'token');
        assert.equal(extractVoiceToken(`${path}?access_token=token`, 'Bearer token'), 'token');
    }
    for (const args of [
        ['/rtc?access_token=one&access_token=two'], ['/rtc?access_token=one', 'Bearer two'],
        ['/rtc?access_token=one', 'Basic one'], ['/rtc', '', 'POST'], ['/twirp'],
        ['/rtc/../healthz?access_token=token'], ['/rtc?access_token=' + 'x'.repeat(16385)], ['/rtc'],
    ]) assert.throws(() => extractVoiceToken(...args));
});

test('checks signature, fresh backend rights and private RPC on every admission', async () => {
    const { guard, calls, setAllowed } = fixture();
    await guard.sweep();
    await guard.admit('signed-token');
    assert.equal(calls.at(-1).url.pathname, '/rest/v1/rpc/check_voice_room_access');
    assert.deepEqual(JSON.parse(calls.at(-1).init.body), { check_room_id: roomId, check_user_id: userId });
    setAllowed(false);
    await assert.rejects(guard.admit('same-signed-token'), status(403));
    await guard.dispose();
});

test('invalid signatures, malformed claims and privileged/client-editable tokens are rejected', async () => {
    for (const value of [null, {}, { ...claims(), sub: 'bad' }, { ...claims(), exp: 0 },
        { ...claims(), video: { room, roomJoin: true, roomAdmin: true } },
        { ...claims(), video: { room, roomJoin: true, canUpdateOwnMetadata: true } },
        { ...claims(), metadata: '{}' }, { ...claims(), metadata: 'bad json' },
        { ...claims(), video: { room, roomJoin: false } }]) {
        const { guard } = fixture({ verifyToken: async () => value });
        await guard.sweep();
        await assert.rejects(guard.admit('signed'), status(403));
        await guard.dispose();
    }
    const { guard } = fixture({ verifyToken: async () => { throw new Error('secret'); } });
    await assert.rejects(guard.admit('forged'), error => error.status === 401 && !error.message.includes('secret'));
    await guard.dispose();
});

test('evicts revoked participants without token/session memory, including after guard restart', async () => {
    const { guard, removed, setAllowed } = fixture();
    await guard.sweep(); assert.equal(removed.length, 0);
    setAllowed(false); await guard.sweep();
    assert.deepEqual(removed, [[room, userId]]);
    await guard.dispose();
    const next = fixture(); next.setAllowed(false); await next.guard.sweep();
    assert.deepEqual(next.removed, [[room, userId]]);
    await next.guard.dispose();
});

test('backend failure fails closed, removes active participants and exposes no upstream error', async () => {
    for (const fetchImpl of [async () => { throw new Error('secret url/key'); },
        async () => new Response('private failure', { status: 500 }), async () => Response.json({ allowed: true })]) {
        const { guard, removed } = fixture({ fetchImpl });
        await guard.sweep();
        assert.deepEqual(removed, [[room, userId]]);
        assert.equal(guard.state().ready, false);
        await assert.rejects(guard.admit('token'), error => error.status === 503 && !error.message.includes('secret'));
        await guard.dispose();
    }
});

test('LiveKit control failure and stale sweep deny new admission', async () => {
    let clock = 100000;
    const { guard, client } = fixture({ now: () => clock });
    await assert.rejects(guard.authorizeJoin(roomId, userId), status(503));
    await guard.sweep(); assert.equal(guard.state().ready, true);
    clock += 60001; assert.equal(guard.state().ready, false);
    client.listRooms = async () => { throw new Error('control unavailable'); };
    await guard.sweep(); assert.equal(guard.state().ready, false);
    await guard.dispose();
});

test('sweeps do not overlap, disposal aborts checks without evicting valid users', async () => {
    let release;
    const { guard, removed } = fixture({ fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
        release = () => reject(signal.reason);
        signal.addEventListener('abort', release, { once: true });
    }) });
    const pending = guard.sweep();
    assert.equal(guard.sweep(), pending);
    while (!release) await new Promise(resolve => setImmediate(resolve));
    await guard.dispose(); await pending;
    assert.equal(removed.length, 0);
    assert.equal(guard.state().ready, false);
});

test('ignores unrelated rooms and tolerates participants leaving during eviction', async () => {
    const { guard, calls } = fixture({ client: {
        listRooms: async () => [{ name: 'unrelated' }, { name: room }],
        listParticipants: async () => [{ identity: 'invalid-user' }],
        removeParticipant: async () => { throw Object.assign(new Error(), { code: 'not_found' }); },
    } });
    await guard.sweep();
    assert.equal(calls.length, 0); assert.equal(guard.state().ready, true);
    await guard.dispose();
});
