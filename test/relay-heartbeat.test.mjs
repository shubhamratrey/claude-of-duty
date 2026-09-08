import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sweepHeartbeat, createRelayServer } from '../server/relay-server.mjs';

// A closed laptop leaves its TCP connection ESTABLISHED, and through a tunnel
// the relay cannot tell the browser behind it has gone. Because a relay holds
// exactly one room, that zombie does not just take a slot -- it keeps the room
// alive forever and nobody else can open one.

const fakeSocket = () => ({ awaitingPong: false, pinged: 0, terminated: false });

function runSweep(sockets) {
  return sweepHeartbeat(sockets, {
    ping: (s) => { s.pinged += 1; },
    terminate: (s) => { s.terminated = true; },
  });
}

test('the first sweep pings rather than judging', () => {
  const a = fakeSocket();
  const result = runSweep([a]);
  assert.deepEqual(result, { pinged: 1, terminated: 0 });
  assert.equal(a.pinged, 1);
  assert.equal(a.terminated, false);
  assert.equal(a.awaitingPong, true, 'and remembers it is waiting');
});

test('a socket that answered survives indefinitely', () => {
  const a = fakeSocket();
  for (let i = 0; i < 10; i += 1) {
    runSweep([a]);
    a.awaitingPong = false; // the pong handler does this on a real socket
  }
  assert.equal(a.terminated, false);
  assert.equal(a.pinged, 10);
});

test('a socket that never answers is terminated on the next sweep', () => {
  const a = fakeSocket();
  runSweep([a]);
  assert.equal(a.terminated, false, 'one missed pong is not yet proof');
  const second = runSweep([a]);
  assert.equal(a.terminated, true);
  assert.deepEqual(second, { pinged: 0, terminated: 1 });
});

test('one zombie does not stop the others being pinged', () => {
  const live = fakeSocket();
  const zombie = fakeSocket();
  runSweep([live, zombie]);
  live.awaitingPong = false;
  const result = runSweep([live, zombie]);
  assert.equal(zombie.terminated, true);
  assert.equal(live.terminated, false);
  assert.deepEqual(result, { pinged: 1, terminated: 1 });
});

test('an empty relay sweeps cleanly', () => {
  assert.deepEqual(runSweep([]), { pinged: 0, terminated: 0 });
  assert.deepEqual(sweepHeartbeat(undefined, {}), { pinged: 0, terminated: 0 });
});

test('evicting a zombie frees the room for the next player', async () => {
  // The whole point: with one room per relay, a dead client blocks everybody.
  const relay = await createRelayServer({
    port: 0, host: '127.0.0.1', log: () => {}, heartbeatMs: 3600000,
  });
  try {
    const socket = new WebSocket(relay.wsUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(relay.slot.occupied, true, 'the client opened a room');

    // Pretend it went away without closing: mark every socket as already
    // owing a pong, then sweep. This is what a real second sweep sees.
    for (const client of relay.wss.clients) client.awaitingPong = true;
    const swept = relay.runHeartbeat();
    assert.equal(swept.terminated, 1);
    assert.equal(relay.stats.zombiesEvicted, 1);

    await new Promise((r) => setTimeout(r, 200));
    assert.equal(relay.slot.occupied, false, 'the room is freed for the next player');
  } finally {
    await relay.close();
  }
});
