import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NetClient } from '../export/web/net/net-client.js';
import { MSG, encode } from '../export/web/net/protocol.js';

/**
 * A NetClient with an injected socket. Nothing here touches the network: the
 * fake records what was sent and lets a test push frames in by hand, so the
 * identity, clock, and reconnect logic can be driven frame by frame.
 */
function harness(options = {}) {
  const sockets = [];
  let clock = 1000;

  class FakeSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      this.closed = 0;
      sockets.push(this);
    }

    send(raw) {
      if (this.readyState !== 1) throw new Error('send on a socket that is not open');
      this.sent.push(raw);
    }

    close() {
      this.closed += 1;
      this.readyState = 3;
      this.onclose?.({ code: 1000, reason: 'bye' });
    }

    // Test-side drivers.
    accept() {
      this.readyState = 1;
      this.onopen?.();
    }

    receive(raw) {
      this.onmessage?.({ data: raw });
    }

    deliver(type, data, from = null) {
      this.receive(encode(type, data, from));
    }

    drop(code = 1006) {
      this.readyState = 3;
      this.onclose?.({ code, reason: 'lost' });
    }

    frames() {
      return this.sent.map((raw) => JSON.parse(raw));
    }

    framesOf(type) {
      return this.frames().filter((frame) => frame.t === type);
    }
  }

  const client = new NetClient({
    url: 'ws://test.local/net',
    name: 'alpha',
    WebSocketImpl: FakeSocket,
    now: () => clock,
    reconnect: false,
    ...options,
  });

  return {
    client,
    sockets,
    socket: () => sockets[sockets.length - 1],
    advance: (ms) => { clock += ms; },
    at: (ms) => { clock = ms; },
  };
}

const welcome = (overrides = {}) => ({
  peerId: 'p2',
  hostId: 'p1',
  roster: [{ id: 'p1', name: 'Host' }, { id: 'p2', name: 'alpha' }],
  serverTime: 500000,
  ...overrides,
});

test('connecting sends hello with the sanitised name, then a first ping', () => {
  const net = harness();
  net.client.connect();
  assert.equal(net.sockets.length, 1);
  assert.equal(net.socket().url, 'ws://test.local/net');
  assert.deepEqual(net.socket().frames(), []);

  net.socket().accept();
  const frames = net.socket().frames();
  assert.equal(frames[0].t, MSG.HELLO);
  assert.equal(frames[0].d.name, 'ALPHA');
  assert.equal(frames[1].t, MSG.PING);
  assert.equal(frames[1].d.clientTime, 1000);
  net.client.close();
});

test('welcome populates identity and the roster, and a guest is not host', () => {
  const net = harness();
  const seen = [];
  net.client.on('welcome', (data) => seen.push(data.peerId));
  net.client.connect();
  net.socket().accept();
  net.socket().deliver(MSG.WELCOME, welcome());

  assert.deepEqual(seen, ['p2']);
  assert.equal(net.client.peerId, 'p2');
  assert.equal(net.client.hostId, 'p1');
  assert.equal(net.client.isHost, false);
  assert.equal(net.client.role, 'guest');
  assert.deepEqual(net.client.getState().peers, [
    { id: 'p1', name: 'HOST' },
    { id: 'p2', name: 'ALPHA' },
  ]);
  net.client.close();
});

test('a peer welcomed as its own host reads as host', () => {
  const net = harness();
  net.client.connect();
  net.socket().accept();
  net.socket().deliver(MSG.WELCOME, welcome({ peerId: 'p1', hostId: 'p1' }));
  assert.equal(net.client.isHost, true);
  assert.equal(net.client.role, 'host');
  net.client.close();
});

test('peerJoined, peerLeft, and hostChanged keep the roster and role current', () => {
  const net = harness();
  const states = [];
  net.client.on('statechange', (state) => states.push(state.role));
  net.client.connect();
  net.socket().accept();
  net.socket().deliver(MSG.WELCOME, welcome());

  net.socket().deliver(MSG.PEER_JOINED, { peer: { id: 'p3', name: 'Charlie' } });
  assert.deepEqual(net.client.getState().peers.map((peer) => peer.id), ['p1', 'p2', 'p3']);

  net.socket().deliver(MSG.PEER_LEFT, { peerId: 'p1' });
  assert.deepEqual(net.client.getState().peers.map((peer) => peer.id), ['p2', 'p3']);

  // The host left, so the server promotes us: the same client is now the host.
  assert.equal(net.client.isHost, false);
  net.socket().deliver(MSG.HOST_CHANGED, { hostId: 'p2' });
  assert.equal(net.client.isHost, true);
  assert.equal(net.client.role, 'host');
  net.socket().deliver(MSG.HOST_CHANGED, { hostId: 'p3' });
  assert.equal(net.client.isHost, false);

  assert.ok(states.includes('guest') && states.includes('host'), 'statechange fired both ways');
  net.client.close();
});

test('malformed inbound frames are counted and dropped, never thrown', () => {
  const net = harness();
  net.client.connect();
  net.socket().accept();
  net.socket().deliver(MSG.WELCOME, welcome());

  net.socket().receive('this is not json');
  net.socket().receive(JSON.stringify({ v: 99, t: MSG.WELCOME, d: welcome() }));
  net.socket().receive(JSON.stringify({ v: 1, t: MSG.WELCOME, d: { peerId: 7 } }));
  net.socket().receive(JSON.stringify({ v: 1, t: 'nonsense', d: {} }));
  net.socket().receive(null);

  assert.equal(net.client.droppedFrames, 5);
  assert.equal(net.client.peerId, 'p2', 'a rejected welcome cannot rewrite our identity');
  net.client.close();
});

test('sending before the socket opens is a silent no-op', () => {
  const net = harness();
  const state = {
    seq: 1, t: 0, pos: [0, 0, 0], yaw: 0, pitch: 0, flags: 0, health: 100, alive: true,
  };
  assert.equal(net.client.send(MSG.PLAYER_STATE, state), false, 'no socket at all');

  net.client.connect();
  assert.equal(net.client.send(MSG.PLAYER_STATE, state), false, 'still connecting');
  assert.deepEqual(net.socket().frames(), []);

  net.socket().accept();
  assert.equal(net.client.send(MSG.PLAYER_STATE, state), true);

  net.socket().drop();
  assert.equal(net.client.send(MSG.PLAYER_STATE, state), false, 'dropped mid-match');
});

test('pong yields an rtt and a host clock in seconds, keeping the best sample', () => {
  const net = harness();
  net.client.connect();
  net.socket().accept();
  net.socket().deliver(MSG.WELCOME, welcome({ serverTime: 500000 }));
  // Welcome alone gives a zero-latency estimate, good enough to render with.
  assert.equal(net.client.hostTimeSeconds(), 500);
  assert.equal(net.client.rttMs, null);

  const sentPing = net.socket().framesOf(MSG.PING).at(-1).d.clientTime;
  net.advance(40);
  net.socket().deliver(MSG.PONG, { clientTime: sentPing, serverTime: 500_020 });
  assert.equal(net.client.rttMs, 40);
  // The reply is assumed half a round trip old, so the server clock now reads
  // serverTime + rtt / 2 = 500040 ms, and keeps running with the local clock.
  assert.equal(net.client.hostTimeSeconds(), 500.04);
  net.advance(1000);
  assert.equal(net.client.hostTimeSeconds(), 501.04);

  // A slow reply carrying a worse estimate must not displace the fast one.
  net.client.sendPing();
  const slowPing = net.socket().framesOf(MSG.PING).at(-1).d.clientTime;
  net.advance(400);
  net.socket().deliver(MSG.PONG, { clientTime: slowPing, serverTime: 501_000 });
  assert.equal(net.client.rttMs, 40, 'best-of-N keeps the lowest-rtt sample');
  assert.equal(net.client.hostTimeSeconds(), 501.44);
  net.client.close();
});

test('a lost socket reconnects with exponential backoff until close() stops it', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const net = harness({ reconnect: true });
  net.client.connect();
  net.socket().accept();
  net.socket().drop();

  assert.equal(net.client.connected, false);
  assert.equal(net.client.peerId, null, 'a reconnect is a new peer');
  t.mock.timers.tick(249);
  assert.equal(net.sockets.length, 1, 'still backing off');
  t.mock.timers.tick(1);
  assert.equal(net.sockets.length, 2, 'first retry after 250 ms');

  net.socket().drop();
  t.mock.timers.tick(499);
  assert.equal(net.sockets.length, 2, 'the delay doubled');
  t.mock.timers.tick(1);
  assert.equal(net.sockets.length, 3);

  net.socket().accept();
  net.client.close();
  net.socket().drop();
  t.mock.timers.tick(10_000);
  assert.equal(net.sockets.length, 3, 'close() is deliberate and stops retrying');
});

test('getState is compact and survives a JSON round-trip', () => {
  const net = harness();
  net.client.connect();
  net.socket().accept();
  net.socket().deliver(MSG.WELCOME, welcome());
  net.socket().receive('garbage');
  net.advance(12);
  net.socket().deliver(MSG.PONG, { clientTime: 1000, serverTime: 500_000 });

  const state = net.client.getState();
  assert.deepEqual(JSON.parse(JSON.stringify(state)), state);
  assert.deepEqual(Object.keys(state).sort(), [
    'connected', 'droppedFrames', 'droppedOutbound', 'hostId', 'peerId', 'peers', 'rttMs', 'role',
  ].sort());
  assert.equal(state.connected, true);
  assert.equal(state.role, 'guest');
  assert.equal(state.rttMs, 12);
  assert.equal(state.droppedFrames, 1);
  net.client.close();
});
