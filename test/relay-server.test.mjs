import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRelayServer } from '../server/relay-server.mjs';

// Integration, no browser: a real relay on a random port, driven by Node 22's
// built-in WebSocket client.

const settle = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));

async function open(relay) {
  const frames = [];
  const socket = new WebSocket(relay.wsUrl);
  socket.addEventListener('message', (event) => frames.push(JSON.parse(event.data)));
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  return {
    socket,
    frames,
    of: (type) => frames.filter((frame) => frame.t === type),
    send: (t, d) => socket.send(JSON.stringify({ v: 1, t, d })),
  };
}

async function withRelay(options, body) {
  const relay = await createRelayServer({
    port: 0, host: '127.0.0.1', log: () => {}, ...options,
  });
  try {
    await body(relay);
  } finally {
    await relay.close();
  }
}

test('the first client opens the room and is given the code', async () => {
  await withRelay({}, async (relay) => {
    const a = await open(relay);
    await settle();
    const welcome = a.of('welcome');
    assert.equal(welcome.length, 1);
    assert.match(welcome[0].d.roomCode, /^[A-Z2-9]{4}$/);
    assert.equal(welcome[0].d.hostId, welcome[0].d.peerId);
    a.socket.close();
  });
});

test('everyone after the first is told a room exists', async () => {
  await withRelay({}, async (relay) => {
    const a = await open(relay);
    await settle();
    const b = await open(relay);
    await settle();
    assert.equal(b.of('roomRequired').length, 1);
    assert.equal(b.of('welcome').length, 0, 'no code, no admission');
    a.socket.close();
    b.socket.close();
  });
});

test('a wrong code is refused and the socket stays open to retype', async () => {
  await withRelay({}, async (relay) => {
    const a = await open(relay);
    await settle();
    const code = a.of('welcome')[0].d.roomCode;
    const b = await open(relay);
    await settle();

    b.send('joinRoom', { code: code === 'ZZZZ' ? 'YYYY' : 'ZZZZ', name: 'bob' });
    await settle();
    assert.equal(b.of('error')[0].d.reason, 'bad-code');
    assert.equal(b.socket.readyState, WebSocket.OPEN, 'a typo must not cost the connection');

    b.send('joinRoom', { code, name: 'bob' });
    await settle();
    assert.equal(b.of('welcome').length, 1);
    assert.equal(b.of('welcome')[0].d.roomCode, code);
    a.socket.close();
    b.socket.close();
  });
});

test('an unadmitted socket cannot use the relay', async () => {
  await withRelay({}, async (relay) => {
    const a = await open(relay);
    await settle();
    const b = await open(relay);
    await settle();

    // b never joined. Nothing it sends may reach anybody.
    b.send('playerState', {
      seq: 1, t: 1, pos: [0, 0, 0], yaw: 0, pitch: 0, flags: 0, health: 100, alive: true,
    });
    await settle();
    assert.equal(a.of('playerState').length, 0);
    assert.ok(relay.stats.unadmittedDropped >= 1);
    a.socket.close();
    b.socket.close();
  });
});

test('frames reach the other member, stamped by the server, never echoed back', async () => {
  await withRelay({}, async (relay) => {
    const a = await open(relay);
    await settle();
    const code = a.of('welcome')[0].d.roomCode;
    const b = await open(relay);
    await settle();
    b.send('joinRoom', { code, name: 'bob' });
    await settle();

    a.send('weaponFire', { origin: [1, 2, 3], dir: [0, 0, 1] });
    await settle();
    const got = b.of('weaponFire');
    assert.equal(got.length, 1);
    assert.equal(got[0].from, 'peer-1', 'the server stamps identity; clients cannot claim it');
    assert.equal(a.of('weaponFire').length, 0, 'no self-echo');
    a.socket.close();
    b.socket.close();
  });
});

test('a client cannot forge who a frame came from', async () => {
  await withRelay({}, async (relay) => {
    const a = await open(relay);
    await settle();
    const code = a.of('welcome')[0].d.roomCode;
    const b = await open(relay);
    await settle();
    b.send('joinRoom', { code, name: 'bob' });
    await settle();

    b.socket.send(JSON.stringify({
      v: 1, t: 'weaponFire', from: 'peer-1', d: { origin: [0, 0, 0], dir: [1, 0, 0] },
    }));
    await settle();
    assert.equal(a.of('weaponFire')[0].from, 'peer-2', 'the forged sender is overwritten');
    a.socket.close();
    b.socket.close();
  });
});

test('host-only frames from a guest are dropped', async () => {
  await withRelay({}, async (relay) => {
    const a = await open(relay);
    await settle();
    const code = a.of('welcome')[0].d.roomCode;
    const b = await open(relay);
    await settle();
    b.send('joinRoom', { code, name: 'bob' });
    await settle();

    b.send('botState', { t: 1, bots: [] });
    await settle();
    assert.equal(a.of('botState').length, 0);
    assert.ok(relay.stats.hostOnlyDropped >= 1);

    a.send('botState', { t: 1, bots: [] });
    await settle();
    assert.equal(b.of('botState').length, 1, 'the host may author it');
    a.socket.close();
    b.socket.close();
  });
});

test('the room fills up and then refuses', async () => {
  await withRelay({ maxPeers: 2 }, async (relay) => {
    const a = await open(relay);
    await settle();
    const code = a.of('welcome')[0].d.roomCode;
    const b = await open(relay);
    await settle();
    b.send('joinRoom', { code, name: 'b' });
    await settle();

    const c = await open(relay);
    await settle();
    c.send('joinRoom', { code, name: 'c' });
    await settle();
    assert.equal(c.of('error')[0].d.reason, 'room-full');
    a.socket.close();
    b.socket.close();
    c.socket.close();
  });
});

test('a socket that never joins is closed', async () => {
  await withRelay({ joinTimeoutMs: 200 }, async (relay) => {
    const a = await open(relay);
    await settle();
    const b = await open(relay);
    await settle(400);
    assert.equal(b.socket.readyState, WebSocket.CLOSED);
    assert.equal(relay.stats.joinTimeouts, 1);
    assert.equal(a.socket.readyState, WebSocket.OPEN, 'the member is unaffected');
    a.socket.close();
  });
});

test('the room closes when the last member leaves, and the next game gets a new code', async () => {
  await withRelay({}, async (relay) => {
    const a = await open(relay);
    await settle();
    const firstCode = a.of('welcome')[0].d.roomCode;
    assert.equal((await (await fetch(relay.healthUrl)).json()).room, true);

    a.socket.close();
    await settle(150);
    assert.equal((await (await fetch(relay.healthUrl)).json()).room, false);

    const b = await open(relay);
    await settle();
    assert.notEqual(b.of('welcome')[0].d.roomCode, firstCode);
    b.socket.close();
  });
});

test('the host leaving promotes the next member and keeps the code', async () => {
  await withRelay({}, async (relay) => {
    const a = await open(relay);
    await settle();
    const code = a.of('welcome')[0].d.roomCode;
    const b = await open(relay);
    await settle();
    b.send('joinRoom', { code, name: 'b' });
    await settle();

    a.socket.close();
    await settle(150);
    const changed = b.of('hostChanged');
    assert.equal(changed.at(-1).d.hostId, 'peer-2');
    assert.equal(relay.slot.room.code, code, 'the code everyone was told still works');
    b.socket.close();
  });
});

test('the health probe answers before anyone connects, and allows cross-origin', async () => {
  await withRelay({}, async (relay) => {
    const response = await fetch(relay.healthUrl);
    assert.equal(response.status, 200);
    // The game is served from another origin, so the probe must be readable.
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    const body = await response.json();
    assert.equal(body.relay, true);
    assert.equal(body.room, false);
  });
});

test('the relay refuses to pretend it serves the game', async () => {
  await withRelay({}, async (relay) => {
    const response = await fetch(`${relay.url}/index.html`);
    assert.equal(response.status, 404);
    assert.match(await response.text(), /serves sockets, not the game/);
  });
});

test('a flood is throttled rather than relayed', async () => {
  await withRelay({ maxFramesPerSecond: 20 }, async (relay) => {
    const a = await open(relay);
    await settle();
    const code = a.of('welcome')[0].d.roomCode;
    const b = await open(relay);
    await settle();
    b.send('joinRoom', { code, name: 'b' });
    await settle();

    for (let i = 0; i < 200; i += 1) {
      b.send('weaponFire', { origin: [0, 0, 0], dir: [1, 0, 0] });
    }
    await settle(200);
    assert.ok(relay.stats.rateLimited > 0, 'the excess is dropped');
    assert.ok(a.of('weaponFire').length < 200, 'and does not all reach the other player');
    a.socket.close();
    b.socket.close();
  });
});
