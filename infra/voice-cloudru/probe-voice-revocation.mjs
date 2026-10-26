import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

// Run in a separate private API-image container, never in the production stack.
const require = createRequire('/app/package.json');
const { RoomServiceClient } = require('livekit-server-sdk');
const { SignalRequest, SignalResponse, DisconnectReason } = require('@livekit/protocol');
assert.equal(process.env.LPM_STAGING_PROBE, '1');
assert.equal(process.env.SUPABASE_URL, 'https://10.0.0.5:8443');
const backend = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const api = 'http://voice-api:8080', proxy = 'http://proxy:8090';
const client = new RoomServiceClient('http://livekit:7880', process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, { requestTimeout: 5 });
const projectId = randomUUID(), roomId = randomUUID(), runId = randomUUID(), users = [], sockets = [], checks = [];
const room = `room:${roomId}`;
let phase = 'setup', projectCreated = false, succeeded = false;
async function request(path, { token = key, method = 'GET', body } = {}) {
    const r = await fetch(backend + path, { method, redirect: 'error',
        headers: { apikey: key, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    assert.ok(r.ok, `${phase}: backend HTTP ${r.status}`);
    return r.status === 204 ? null : r.json();
}
async function user(label) {
    const email = `voice-revoke-${runId}-${label}@example.invalid`, password = randomBytes(32).toString('base64url');
    const account = await request('/auth/v1/admin/users', { method: 'POST', body: { email, password, email_confirm: true } });
    users.push(account.id); console.log(JSON.stringify({ fixtureUser: account.id }));
    return request('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password } });
}
async function token(session, expected = 200) {
    const r = await fetch(api + '/v1/token', { method: 'POST', headers: {
        Origin: 'http://127.0.0.1:8090', Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json',
    }, body: JSON.stringify({ room, name: 'Revocation probe' }), signal: AbortSignal.timeout(15000) });
    assert.equal(r.status, expected, `${phase}: token HTTP ${r.status}`);
    return (await r.json()).token;
}
async function until(check, timeout = 20000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { if (await check()) return; await delay(100); }
    throw new Error('Probe deadline exceeded');
}
async function admission(value, expected, path = '/rtc/validate') {
    const r = await fetch(`${proxy}${path}?protocol=15&access_token=${encodeURIComponent(value)}`, {
        redirect: 'error', signal: AbortSignal.timeout(10000),
    });
    await r.body?.cancel(); assert.equal(r.status, expected, `${phase}: admission HTTP ${r.status}`);
}
async function connect(value) {
    const socket = new WebSocket(`ws://proxy:8090/rtc?protocol=15&auto_subscribe=1&access_token=${encodeURIComponent(value)}`);
    socket.binaryType = 'arraybuffer';
    const state = { socket, joined: false, leave: null, refreshed: [], error: false, closed: false, messages: [] };
    // Keep signaling alive like the SDK; a ping timeout must not mimic eviction.
    const ping = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) socket.send(new SignalRequest({
            message: { case: 'pingReq', value: { timestamp: BigInt(Date.now()), rtt: 0n } },
        }).toBinary());
    }, 3000);
    state.stopPing = () => clearInterval(ping);
    socket.onclose = () => { state.closed = true; clearInterval(ping); };
    sockets.push(state);
    socket.onmessage = event => {
        try {
            const message = SignalResponse.fromBinary(new Uint8Array(event.data)).message;
            if (!state.messages.includes(message.case)) state.messages.push(message.case);
            if (message.case === 'join') state.joined = true;
            if (message.case === 'leave') state.leave = message.value.reason;
            if (message.case === 'refreshToken') state.refreshed.push(message.value);
        } catch (_) { state.error = true; }
    };
    socket.onerror = () => { state.error = true; };
    await until(() => state.joined || state.error, 10000);
    assert.ok(state.joined && !state.error);
    return state;
}
async function removed(state, identity) {
    await until(() => state.closed, 20000);
    if (state.leave !== null) assert.equal(state.leave, DisconnectReason.PARTICIPANT_REMOVED);
    // Raw signaling may close without a Leave frame. Require LiveKit's own
    // administrative-removal reason, not a socket timeout or our API counter.
    await until(async () => {
        try {
            const evidence = JSON.parse(await readFile('/probe-control/evictions.json', 'utf8'));
            return evidence.some(e => e.room === room && e.participant === identity
                && e.reason === 'SERVICE_REQUEST_REMOVE_PARTICIPANT');
        } catch (_) { return false; }
    }, 5000);
    await until(async () => !(await client.listParticipants(room)).some(p => p.identity === identity), 5000);
}
try {
    console.log(JSON.stringify({ fixtureProject: projectId, fixtureRoom: roomId, fixtureRun: runId }));
    const health = await fetch(api + '/healthz').then(r => r.json());
    assert.equal(health.voiceGuard.ready, true);
    const owner = await user('owner'), admin = await user('admin');
    const guest = await request('/auth/v1/signup', { method: 'POST', body: {} });
    users.push(guest.user.id); console.log(JSON.stringify({ fixtureUser: guest.user.id }));
    await request('/rest/v1/projects', { token: owner.access_token, method: 'POST', body: { id: projectId, slug: `voice-revoke-${runId}`, name: 'Voice revocation probe', owner_id: owner.user.id } });
    projectCreated = true;
    await request('/rest/v1/rooms', { token: owner.access_token, method: 'POST', body: { id: roomId, project_id: projectId, slug: 'revocation', owner_id: owner.user.id } });
    const invite = await request('/rest/v1/rpc/ensure_room_invite', { token: owner.access_token, method: 'POST', body: { room_id: roomId } });
    const join = () => request('/rest/v1/rpc/join_room_by_invite', { token: guest.access_token, method: 'POST', body: { invite_token: invite[0].token } });
    await join();
    phase = 'live-guest-and-api-restart';
    const guestToken = await token(guest);
    await admission(guestToken, 200);
    const active = await connect(guestToken);
    assert.ok((await client.listParticipants(room)).some(p => p.identity === guest.user.id));
    await client.updateParticipant(room, guest.user.id, { metadata: JSON.stringify({ source: 'lpmview', roomId, projectId, registered: false, probe: true }) });
    await until(() => active.refreshed.length > 0, 5000);
    console.log(JSON.stringify({ phase: 'restart-api-now' }));
    await until(async () => { try { return (await readFile('/probe-control/restarted', 'utf8')).trim() === 'ready'; } catch (_) { return false; } }, 30000);
    assert.equal(active.leave, null);
    assert.ok((await client.listParticipants(room)).some(p => p.identity === guest.user.id));
    checks.push('active-connection-survived-api-restart');
    phase = 'guest-revocation';
    await request(`/rest/v1/room_members?room_id=eq.${roomId}&user_id=eq.${guest.user.id}`, { method: 'DELETE' });
    phase = 'guest-old-token';
    await admission(guestToken, 403);
    phase = 'guest-refreshed-token';
    for (const value of active.refreshed) await admission(value, 403);
    phase = 'guest-rtc-entrypoints';
    for (const path of ['/rtc', '/rtc/v1', '/rtc/v1/validate']) await admission(guestToken, 403, path);
    phase = 'guest-new-token';
    await token(guest, 403);
    phase = 'guest-eviction';
    await removed(active, guest.user.id);
    checks.push('guest-evicted-after-restart', 'old-and-refreshed-token-denied', 'all-rtc-entrypoints-guarded');
    phase = 'restored-invite';
    await join();
    const fresh = await token(guest); await admission(fresh, 200);
    checks.push('restored-access-can-rejoin');
    phase = 'proxy-header-spoofing';
    const spoof = await fetch(`${proxy}/rtc/validate?access_token=invalid-token`, { headers: {
        'X-Forwarded-Uri': `/rtc/validate?access_token=${encodeURIComponent(fresh)}`,
        'X-Forwarded-Method': 'GET',
    }, signal: AbortSignal.timeout(10000) });
    await spoof.body?.cancel(); assert.equal(spoof.status, 401);
    const duplicate = await fetch(`${proxy}/rtc/validate?access_token=${encodeURIComponent(fresh)}&access_token=invalid-token`, {
        signal: AbortSignal.timeout(10000),
    });
    await duplicate.body?.cancel(); assert.equal(duplicate.status, 403);
    checks.push('spoofed-forwarded-uri-and-duplicate-token-denied');
    phase = 'superuser-revocation';
    await request('/rest/v1/user_roles', { method: 'POST', body: { user_id: admin.user.id, role: 'superuser' } });
    const adminToken = await token(admin), activeAdmin = await connect(adminToken);
    await request(`/rest/v1/user_roles?user_id=eq.${admin.user.id}&role=eq.superuser`, { method: 'DELETE' });
    await admission(adminToken, 403); await removed(activeAdmin, admin.user.id);
    checks.push('revoked-superuser-evicted');
    phase = 'room-deletion';
    const ownerToken = await token(owner), activeOwner = await connect(ownerToken);
    await request(`/rest/v1/rooms?id=eq.${roomId}`, { method: 'DELETE' });
    await admission(ownerToken, 403); await token(owner, 403); await removed(activeOwner, owner.user.id);
    checks.push('deleted-room-evicts-owner');
    phase = 'private-routes';
    for (const path of ['/internal/voice/admit', '/twirp/livekit.RoomService/ListRooms']) {
        assert.equal((await fetch(proxy + path)).status, 404);
    }
    assert.equal((await fetch(proxy + '/v1/token', { method: 'POST' })).status, 503);
    assert.equal((await fetch(proxy + '/model-check/health')).status, 503);
    checks.push('control-routes-private', 'public-token-and-checker-still-blocked');
    succeeded = true;
} catch (error) {
    process.exitCode = 1;
    console.error(JSON.stringify({ ok: false, failedPhase: phase,
        assertion: error.code === 'ERR_ASSERTION' ? { actual: typeof error.actual === 'number' ? error.actual : null,
            expected: typeof error.expected === 'number' ? error.expected : null } : null,
        deadline: error.message === 'Probe deadline exceeded',
        signaling: sockets.map(({ joined, leave, error, closed, messages }) => ({ joined, leave, error, closed, messages })) }));
}
finally {
    for (const state of sockets) { state.stopPing(); state.socket.close(); }
    const cleanupErrors = [];
    async function cleanup(name, action) { try { await action(); } catch (_) { cleanupErrors.push(name); } }
    await cleanup('livekit-room', async () => { if ((await client.listRooms([room])).length) await client.deleteRoom(room); });
    if (projectCreated) await cleanup('project', () => request(`/rest/v1/projects?id=eq.${projectId}`, { method: 'DELETE' }));
    for (const id of users) await cleanup(`user:${id}`, () => request(`/auth/v1/admin/users/${id}`, { method: 'DELETE' }));
    if (cleanupErrors.length) process.exitCode = 1;
    console.log(JSON.stringify({ ok: succeeded && !cleanupErrors.length, checks, cleanupErrors,
        failedPhase: succeeded ? null : phase, projectId, roomId, users, mediaCallTested: false }));
}
