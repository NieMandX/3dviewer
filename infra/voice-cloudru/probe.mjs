import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// Execute inside voice-api; the fixture credentials never leave this container.
const require = createRequire('/app/package.json');
const { AccessToken, RoomServiceClient, TokenVerifier } = require('livekit-server-sdk');
const base = 'http://127.0.0.1:8080';
const proxy = 'http://proxy:8090';
const health = await fetch(base + '/healthz').then(r => r.json());
assert.equal(health.ok, true);
assert.equal((await fetch(proxy + '/healthz')).status, 200);
assert.equal((await fetch(proxy + '/v1/token', { method: 'POST' })).status, 503);
assert.equal((await fetch(proxy + '/model-check/health')).status, 503);
assert.equal((await fetch(base + '/v1/token', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);

const client = new RoomServiceClient('http://livekit:7880',
    process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET);
const room = 'migration-probe-' + Date.now();
let socket;
try {
    await client.createRoom({ name: room, emptyTimeout: 60, maxParticipants: 2 });
    assert.ok((await client.listRooms([room])).some(r => r.name === room));
    // Transport-only fixture; application authorization is tested separately.
    const fixtureToken = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, {
        identity: 'migration-probe', ttl: '1m',
    });
    fixtureToken.addGrant({ roomJoin: true, room });
    const token = await fixtureToken.toJwt();
    const claims = await new TokenVerifier(process.env.LIVEKIT_API_KEY,
        process.env.LIVEKIT_API_SECRET).verify(token);
    assert.equal(claims.video.room, room);
    assert.equal(claims.sub, 'migration-probe');
    await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Signaling timed out')), 10000);
        socket = new WebSocket('ws://proxy:8090/rtc?protocol=15&auto_subscribe=1&access_token=' + encodeURIComponent(token));
        socket.onmessage = event => {
            clearTimeout(timeout);
            if (event.data?.size || event.data?.byteLength || event.data?.length) resolve();
            else reject(new Error('Empty signaling response'));
        };
        socket.onerror = () => { clearTimeout(timeout); reject(new Error('Signaling connection failed')); };
    });
    console.log(JSON.stringify({ health: true, roomApi: true, signedToken: true,
        signalingViaProxy: true, publicTokenBlocked: true, mediaCallTested: false,
        applicationAuthorizationTested: false }));
} finally {
    socket?.close();
    await client.deleteRoom(room);
}
