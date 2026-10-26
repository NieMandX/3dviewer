import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';

// Run only inside the private voice-api container, under the migration lock.
// Tokens/passwords stay in memory. Cleanup deletes only this run's fixture IDs.
const require = createRequire('/app/package.json');
const { RoomServiceClient, TokenVerifier } = require('livekit-server-sdk');
const backend = process.env.SUPABASE_URL;
assert.equal(process.env.LPM_STAGING_PROBE, '1');
assert.equal(backend, 'https://10.0.0.5:8443');
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
assert.ok(serviceKey);
const runId = randomUUID();
const projectId = randomUUID();
const roomId = randomUUID();
const otherRoomId = randomUUID();
const userIds = [];
const api = 'http://127.0.0.1:8080';
const client = new RoomServiceClient('http://livekit:7880',
    process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET);
let phase = 'init';
let socket;
let livekitRoomCreated = false;
let projectCreated = false;
let succeeded = false;
let lastStatus = null;

async function backendRequest(path, { token = serviceKey, method = 'GET', body } = {}) {
    const response = await fetch(backend + path, {
        method, headers: { apikey: serviceKey, Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json', Prefer: 'return=representation' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15000), redirect: 'error',
    });
    assert.ok(response.ok, `${phase}: backend HTTP ${response.status}`);
    return response.status === 204 ? null : response.json();
}

async function registeredUser(label) {
    const email = `voice-probe-${runId}-${label}@example.invalid`;
    const password = randomBytes(32).toString('base64url');
    const user = await backendRequest('/auth/v1/admin/users', {
        method: 'POST', body: { email, password, email_confirm: true },
    });
    assert.ok(user.id);
    userIds.push(user.id);
    console.log(JSON.stringify({ fixtureUser: user.id, label }));
    const session = await backendRequest('/auth/v1/token?grant_type=password', {
        method: 'POST', body: { email, password },
    });
    assert.ok(session.access_token);
    assert.equal(session.user.id, user.id);
    return session;
}

async function tokenRequest(session, expected, body = {}, origin = 'http://127.0.0.1:8090') {
    const response = await fetch(api + '/v1/token', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin,
            ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}) },
        body: JSON.stringify({ room: `room:${roomId}`, name: 'Staging probe', ...body }),
        signal: AbortSignal.timeout(15000),
    });
    lastStatus = { expected, actual: response.status };
    assert.equal(response.status, expected, `${phase}: token HTTP ${response.status}`);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const payload = await response.json();
    if (expected !== 200) assert.equal('token' in payload, false);
    return payload;
}

try {
    console.log(JSON.stringify({ fixtureRun: runId, fixtureProject: projectId, fixtureRooms: [roomId, otherRoomId] }));
    phase = 'real-password-login';
    const owner = await registeredUser('owner');
    const outsider = await registeredUser('outsider');
    phase = 'anonymous-login';
    const guest = await backendRequest('/auth/v1/signup', { method: 'POST', body: {} });
    assert.ok(guest.user?.id && guest.access_token);
    userIds.push(guest.user.id);
    console.log(JSON.stringify({ fixtureUser: guest.user.id, label: 'anonymous-guest' }));
    assert.equal(guest.user.is_anonymous, true);
    phase = 'owner-room-setup';
    await backendRequest('/rest/v1/projects', { token: owner.access_token, method: 'POST', body: {
        id: projectId, slug: `voice-probe-${runId}`, name: 'Voice staging probe', owner_id: owner.user.id,
    } });
    projectCreated = true;
    await backendRequest('/rest/v1/rooms', { token: owner.access_token, method: 'POST', body: [
        { id: roomId, project_id: projectId, slug: 'voice-a', owner_id: owner.user.id },
        { id: otherRoomId, project_id: projectId, slug: 'voice-b', owner_id: owner.user.id },
    ] });

    phase = 'unauthorized-rejection';
    await tokenRequest(null, 401);
    await tokenRequest({ access_token: 'invalid-session' }, 401);
    await tokenRequest(owner, 400, { room: 'not-a-room' });
    await tokenRequest(owner, 403, {}, 'https://untrusted.invalid');
    await tokenRequest(outsider, 403);
    await tokenRequest(guest, 403);
    phase = 'owner-and-spoofing';
    const ownerToken = await tokenRequest(owner, 200, {
        identity: outsider.user.id, metadata: { projectId: 'forged', registered: false },
    });
    const verify = token => new TokenVerifier(process.env.LIVEKIT_API_KEY,
        process.env.LIVEKIT_API_SECRET).verify(token);
    phase = 'owner-token-signature';
    const claims = await verify(ownerToken.token);
    phase = 'owner-token-identity';
    assert.equal(claims.sub, owner.user.id);
    assert.equal(claims.video.room, `room:${roomId}`);
    phase = 'owner-token-ttl';
    // This SDK uses nbf=0 and omits iat; check remaining lifetime, not exp-nbf.
    const ttlSeconds = claims.exp - Math.floor(Date.now() / 1000);
    assert.ok(Number.isFinite(ttlSeconds) && ttlSeconds > 0 && ttlSeconds <= 600);
    phase = 'owner-token-metadata';
    assert.deepEqual(JSON.parse(claims.metadata), {
        source: 'lpmview', roomId, projectId, registered: true,
    });
    await tokenRequest(owner, 200, { room: `room:${otherRoomId}` });

    phase = 'room-scoped-invite';
    const invite = await backendRequest('/rest/v1/rpc/ensure_room_invite', {
        token: owner.access_token, method: 'POST', body: { room_id: roomId },
    });
    assert.ok(invite[0]?.token);
    await backendRequest('/rest/v1/rpc/join_room_by_invite', {
        token: guest.access_token, method: 'POST', body: { invite_token: invite[0].token },
    });
    const guestToken = await tokenRequest(guest, 200);
    const guestClaims = await verify(guestToken.token);
    assert.equal(guestClaims.sub, guest.user.id);
    assert.equal(JSON.parse(guestClaims.metadata).registered, false);
    await tokenRequest(guest, 403, { room: `room:${otherRoomId}` });

    phase = 'superuser-and-revocation';
    await backendRequest('/rest/v1/user_roles', { method: 'POST', body: { user_id: outsider.user.id, role: 'superuser' } });
    await tokenRequest(outsider, 200);
    await backendRequest(`/rest/v1/user_roles?user_id=eq.${outsider.user.id}&role=eq.superuser`, { method: 'DELETE' });
    await tokenRequest(outsider, 403);
    await backendRequest(`/rest/v1/room_members?room_id=eq.${roomId}&user_id=eq.${guest.user.id}`, { method: 'DELETE' });
    await tokenRequest(guest, 403);

    phase = 'authorized-signaling';
    await client.createRoom({ name: `room:${roomId}`, emptyTimeout: 60, maxParticipants: 2 });
    livekitRoomCreated = true;
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Signaling timeout')), 10000);
        socket = new WebSocket('ws://proxy:8090/rtc?protocol=15&auto_subscribe=1&access_token=' + encodeURIComponent(ownerToken.token));
        socket.onmessage = event => {
            clearTimeout(timer);
            if (event.data?.size || event.data?.byteLength || event.data?.length) resolve();
            else reject(new Error('Empty signaling response'));
        };
        socket.onerror = () => { clearTimeout(timer); reject(new Error('Signaling failed')); };
    });
    assert.equal((await fetch('http://proxy:8090/v1/token', { method: 'POST' })).status, 503);
    succeeded = true;
} catch (_) {
    console.error(JSON.stringify({ ok: false, failedPhase: phase, lastStatus }));
    process.exitCode = 1;
} finally {
    socket?.close();
    const cleanupErrors = [];
    async function cleanup(label, action) {
        try { await action(); } catch (_) { cleanupErrors.push(label); }
    }
    if (livekitRoomCreated) await cleanup('livekit-room', () => client.deleteRoom(`room:${roomId}`));
    if (projectCreated) await cleanup('project', () => backendRequest(`/rest/v1/projects?id=eq.${projectId}`, { method: 'DELETE' }));
    for (const id of userIds) await cleanup(`user:${id}`, () => backendRequest(`/auth/v1/admin/users/${id}`, { method: 'DELETE' }));
    if (cleanupErrors.length) process.exitCode = 1;
    console.log(JSON.stringify({ ok: succeeded && !cleanupErrors.length, cleanupErrors,
        checks: succeeded ? ['password-login', 'anonymous-login', 'owner', 'invited-guest', 'room-isolation',
            'superuser', 'revocation', 'identity-spoofing', 'origin', 'signed-token', 'authorized-signaling'] : [],
        publicTokenBlocked: true, mediaCallTested: false }));
}
