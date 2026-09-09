import assert from 'node:assert/strict';
import { test } from 'node:test';
import protocol from '../export/web/net/protocol.js';
import {
  BEACON_INTERVAL_MS,
  BEACON_TTL_MS,
  DISCOVERY_PORT,
  DiscoveryTable,
  MAX_BEACON_BYTES,
  broadcastAddressFor,
  broadcastAddresses,
  decodeBeacon,
  encodeBeacon,
  prettyHostName,
  startDiscovery,
} from '../server/lan-discovery.mjs';

const FIELDS = {
  v: protocol.PROTOCOL_VERSION,
  id: 'a1b2c3d4',
  name: 'Shubhams MacBook',
  port: 8000,
  players: 3,
  version: '1.0.0',
};

/**
 * A dgram stand-in.
 *
 * `startDiscovery` is the only impure part of discovery, so this is the whole
 * point of injecting the module: the beacon interval, the received-datagram
 * path and `close()` are all provable without a socket, a port, or a network.
 */
function fakeDgram() {
  const sockets = [];
  return {
    sockets,
    get socket() {
      return sockets.at(-1);
    },
    createSocket(options) {
      const handlers = new Map();
      const socket = {
        options,
        sent: [],
        closed: false,
        broadcast: false,
        bound: null,
        unrefs: 0,
        on(type, handler) {
          handlers.set(type, handler);
          return socket;
        },
        bind(bindOptions, callback) {
          socket.bound = bindOptions;
          callback?.();
          return socket;
        },
        setBroadcast(value) {
          socket.broadcast = Boolean(value);
        },
        send(payload, offset, length, port, address, callback) {
          socket.sent.push({ text: String(payload), port, address });
          callback?.(null);
        },
        close() {
          socket.closed = true;
        },
        unref() {
          socket.unrefs += 1;
        },
        /** Deliver a datagram the way the kernel would. */
        emit(type, ...args) {
          handlers.get(type)?.(...args);
          return handlers.has(type);
        },
      };
      sockets.push(socket);
      return socket;
    },
  };
}

/** A single-slot interval, driven by hand, so "on the interval" is observable. */
function fakeTimers() {
  let entry = null;
  return {
    api: {
      setInterval: (fn, ms) => {
        entry = { fn, ms, unref() { entry.unreffed = true; } };
        return entry;
      },
      clearInterval: (handle) => {
        if (handle === entry) entry = null;
      },
    },
    tick(times = 1) {
      for (let index = 0; index < times; index += 1) entry?.fn?.();
    },
    get running() {
      return entry !== null;
    },
    get interval() {
      return entry?.ms ?? null;
    },
  };
}

test('a beacon survives the round trip unchanged', () => {
  const payload = encodeBeacon(FIELDS);
  assert.ok(Buffer.isBuffer(payload));
  assert.ok(payload.length < MAX_BEACON_BYTES, `${payload.length} bytes`);
  assert.deepEqual(decodeBeacon(payload), { app: 'playops', ...FIELDS });
  // Decoding what a real socket hands over -- a Buffer -- and what a test
  // hands over -- a string -- must agree.
  assert.deepEqual(decodeBeacon(payload.toString('utf8')), decodeBeacon(payload));
});

test('the beacon carries the protocol version, not the human one', () => {
  const beacon = decodeBeacon(encodeBeacon({ ...FIELDS, v: 7, version: '2.3.4' }));
  assert.equal(beacon.v, 7);
  assert.equal(beacon.version, '2.3.4');
});

test('encodeBeacon refuses fields that cannot become a usable address', () => {
  assert.throws(() => encodeBeacon({ ...FIELDS, id: '' }), /id/);
  assert.throws(() => encodeBeacon({ ...FIELDS, port: 0 }), /port/);
  assert.throws(() => encodeBeacon({ ...FIELDS, port: 70000 }), /port/);
  assert.throws(() => encodeBeacon({ ...FIELDS, v: 'one' }), /v/);
  // A name long enough to push the datagram over the limit is trimmed rather
  // than sent: a chatty hostname must not be able to silence the beacon.
  const payload = encodeBeacon({ ...FIELDS, name: 'M'.repeat(4000) });
  assert.ok(payload.length < MAX_BEACON_BYTES, `${payload.length} bytes`);
});

test('garbage, oversize and foreign payloads are dropped, not trusted', () => {
  assert.equal(decodeBeacon(Buffer.alloc(0)), null);
  assert.equal(decodeBeacon(Buffer.from('not json at all')), null);
  assert.equal(decodeBeacon(Buffer.from('[1,2,3]')), null, 'an array is not a beacon');
  assert.equal(decodeBeacon(Buffer.from('null')), null);
  assert.equal(decodeBeacon(Buffer.from('"playops"')), null);
  assert.equal(decodeBeacon(JSON.stringify({ ...FIELDS, app: 'minecraft' })), null);
  assert.equal(decodeBeacon(JSON.stringify({ ...FIELDS, app: undefined })), null);
  assert.equal(decodeBeacon(JSON.stringify({ app: 'playops', id: 'x', v: 1 })), null,
    'no port means no way to reach it');
  assert.equal(decodeBeacon(JSON.stringify({ app: 'playops', port: 8000, v: 1 })), null,
    'no id means it cannot be told apart from anyone else');

  // Valid JSON, valid app, but past the size cap: a receiver must not be made
  // to parse whatever someone chooses to send to an open UDP port.
  const oversize = JSON.stringify({ app: 'playops', v: 1, id: 'x', port: 8000, pad: 'p'.repeat(600) });
  assert.ok(Buffer.byteLength(oversize) > MAX_BEACON_BYTES);
  assert.equal(decodeBeacon(Buffer.from(oversize)), null);
});

test('nothing in the payload is trusted as an address', () => {
  const beacon = decodeBeacon(JSON.stringify({
    app: 'playops', ...FIELDS,
    address: '10.0.0.1', url: 'http://evil.example.com', host: 'evil',
  }));
  assert.deepEqual(Object.keys(beacon).sort(),
    ['app', 'id', 'name', 'players', 'port', 'v', 'version']);
});

test('prettyHostName turns a Mac name into something a person would say', () => {
  assert.equal(prettyHostName('Shubhams-MacBook.local'), 'Shubhams MacBook');
  assert.equal(prettyHostName('Priyas-MacBook-Air'), 'Priyas MacBook Air');
  assert.equal(prettyHostName('rahul_mac.local.'), 'rahul mac');
  assert.equal(prettyHostName('Rahuls Mac'), 'Rahuls Mac', 'already pretty is left alone');
  assert.equal(prettyHostName('  spaced-out  '), 'spaced out');
  assert.equal(prettyHostName(''), '');
  assert.equal(prettyHostName(null), '');
  assert.equal(prettyHostName('a--b'), 'a b', 'runs of separators collapse');
});

test('the table reports games with a reachable URL built from the sender address', () => {
  let clock = 1000;
  const table = new DiscoveryTable({ now: () => clock, selfId: 'me' });

  assert.equal(table.observe(decodeBeacon(encodeBeacon(FIELDS)), '192.168.1.42'), true);
  assert.deepEqual(table.games(), [{
    id: 'a1b2c3d4',
    name: 'Shubhams MacBook',
    address: '192.168.1.42',
    port: 8000,
    url: 'http://192.168.1.42:8000',
    players: 3,
    version: '1.0.0',
    compatible: true,
    ageMs: 0,
  }]);

  clock += 1500;
  assert.equal(table.games()[0].ageMs, 1500);
});

test('the table ignores its own beacon, and beacons with no sender', () => {
  const table = new DiscoveryTable({ selfId: 'a1b2c3d4' });
  assert.equal(table.observe(decodeBeacon(encodeBeacon(FIELDS)), '192.168.1.42'), false);
  assert.deepEqual(table.games(), [], 'your own game is the one you are already in');

  const other = decodeBeacon(encodeBeacon({ ...FIELDS, id: 'other' }));
  assert.equal(table.observe(other, ''), false);
  assert.equal(table.observe(other, null), false);
  assert.equal(table.observe(null, '192.168.1.42'), false);
  assert.deepEqual(table.games(), []);
});

test('a repeat beacon refreshes a row rather than adding one', () => {
  let clock = 0;
  const table = new DiscoveryTable({ now: () => clock, ttlMs: 6000 });
  const beacon = (players) => decodeBeacon(encodeBeacon({ ...FIELDS, players }));

  table.observe(beacon(1), '192.168.1.42');
  clock = 5000;
  table.observe(beacon(4), '192.168.1.42');
  clock = 8000;

  const games = table.games();
  assert.equal(games.length, 1);
  assert.equal(games[0].players, 4);
  assert.equal(games[0].ageMs, 3000, 'age is measured from the latest beacon');
});

test('a row expires at exactly the TTL and is forgotten', () => {
  let clock = 0;
  const table = new DiscoveryTable({ now: () => clock, ttlMs: 6000 });
  table.observe(decodeBeacon(encodeBeacon(FIELDS)), '192.168.1.42');

  clock = 5999;
  assert.equal(table.games().length, 1, 'still inside the window');
  clock = 6000;
  assert.equal(table.games().length, 0, 'the TTL is the moment it drops off');
  assert.equal(table.size, 0, 'and the row is gone, not merely hidden');

  clock = 6001;
  assert.deepEqual(table.games(), []);
});

test('a protocol mismatch is listed but never joinable', () => {
  const table = new DiscoveryTable({ protocolVersion: 1 });
  table.observe(decodeBeacon(encodeBeacon({ ...FIELDS, id: 'same', v: 1 })), '10.0.0.1');
  table.observe(decodeBeacon(encodeBeacon({ ...FIELDS, id: 'older', v: 0, name: 'Old Mac' })), '10.0.0.2');
  table.observe(decodeBeacon(encodeBeacon({ ...FIELDS, id: 'newer', v: 2, name: 'New Mac' })), '10.0.0.3');

  assert.deepEqual(table.games().map((game) => [game.id, game.compatible]), [
    ['newer', false],
    ['older', false],
    ['same', true],
  ]);
});

test('games come back sorted by name, so the list does not shuffle', () => {
  const table = new DiscoveryTable();
  for (const [id, name] of [['c', 'Zoya Mac'], ['a', 'Ada Mac'], ['b', 'Bo Mac']]) {
    table.observe(decodeBeacon(encodeBeacon({ ...FIELDS, id, name })), '10.0.0.1');
  }
  assert.deepEqual(table.games().map((game) => game.name), ['Ada Mac', 'Bo Mac', 'Zoya Mac']);
});

test('a nameless beacon falls back to its address rather than an empty row', () => {
  const table = new DiscoveryTable();
  table.observe(decodeBeacon(encodeBeacon({ ...FIELDS, name: '' })), '10.0.0.7');
  assert.equal(table.games()[0].name, '10.0.0.7');
});

test('broadcast addresses come from address and netmask', () => {
  assert.equal(broadcastAddressFor('192.168.1.42', '255.255.255.0'), '192.168.1.255');
  assert.equal(broadcastAddressFor('10.1.2.3', '255.255.0.0'), '10.1.255.255');
  assert.equal(broadcastAddressFor('172.16.5.9', '255.255.255.240'), '172.16.5.15');
  assert.equal(broadcastAddressFor('192.168.1.42', ''), null);
  assert.equal(broadcastAddressFor('not-an-ip', '255.255.255.0'), null);

  assert.deepEqual(broadcastAddresses({
    lo0: [{ family: 'IPv4', internal: true, address: '127.0.0.1', netmask: '255.0.0.0' }],
    en0: [
      { family: 'IPv4', internal: false, address: '192.168.1.42', netmask: '255.255.255.0' },
      { family: 'IPv6', internal: false, address: 'fe80::1', netmask: 'ffff::' },
    ],
    en1: [{ family: 'IPv4', internal: false, address: '192.168.1.9', netmask: '255.255.255.0' }],
  }), ['192.168.1.255'], 'internal interfaces are skipped and duplicates collapse');
});

test('startDiscovery listens on the shared port and can be closed', () => {
  const dgram = fakeDgram();
  const timers = fakeTimers();
  const discovery = startDiscovery({ dgram, timers: timers.api, announce: () => null });

  assert.deepEqual(dgram.socket.options, { type: 'udp4', reuseAddr: true },
    'several servers on one Mac all have to be able to listen');
  assert.deepEqual(dgram.socket.bound, { port: DISCOVERY_PORT, exclusive: false });
  assert.equal(dgram.socket.broadcast, true);
  assert.equal(timers.interval, BEACON_INTERVAL_MS);
  assert.equal(discovery.port, DISCOVERY_PORT);

  discovery.close();
  assert.equal(timers.running, false, 'close() stops the beacon');
  assert.equal(dgram.socket.closed, true);
  discovery.close();
  assert.equal(dgram.socket.closed, true, 'closing twice is not an error');
});

test('the beacon is sent on the interval, and only while there is a game to join', () => {
  const dgram = fakeDgram();
  const timers = fakeTimers();
  let players = 0;
  const discovery = startDiscovery({
    dgram,
    timers: timers.api,
    port: 9010,
    interval: 500,
    address: '127.0.0.1',
    announce: () => (players === 0 ? null : { ...FIELDS, players }),
  });

  assert.equal(timers.interval, 500);
  timers.tick(3);
  assert.deepEqual(dgram.socket.sent, [], 'an empty roster is a game nobody should be offered');

  players = 2;
  timers.tick();
  assert.equal(dgram.socket.sent.length, 1);
  assert.deepEqual(
    { port: dgram.socket.sent[0].port, address: dgram.socket.sent[0].address },
    { port: 9010, address: '127.0.0.1' },
    'an explicit address unicasts there instead of broadcasting',
  );
  assert.equal(decodeBeacon(dgram.socket.sent[0].text).players, 2);

  timers.tick(2);
  assert.equal(dgram.socket.sent.length, 3);

  players = 0;
  timers.tick(5);
  assert.equal(dgram.socket.sent.length, 3, 'joining someone else silences your own beacon');

  discovery.close();
  players = 3;
  timers.tick(3);
  assert.equal(dgram.socket.sent.length, 3, 'a closed discovery sends nothing');
});

test('with no address override the beacon goes to every broadcast address', () => {
  const dgram = fakeDgram();
  const timers = fakeTimers();
  startDiscovery({
    dgram,
    timers: timers.api,
    announce: () => FIELDS,
    interfaces: () => ({
      en0: [{ family: 'IPv4', internal: false, address: '192.168.1.42', netmask: '255.255.255.0' }],
      lo0: [{ family: 'IPv4', internal: true, address: '127.0.0.1', netmask: '255.0.0.0' }],
    }),
  });
  timers.tick();
  assert.deepEqual(dgram.socket.sent.map((entry) => entry.address),
    ['255.255.255.255', '192.168.1.255'],
    'some macOS setups drop the limited broadcast and pass the directed one');
});

test('received datagrams reach the table, and rubbish does not', () => {
  const dgram = fakeDgram();
  const timers = fakeTimers();
  const table = new DiscoveryTable({ selfId: 'me' });
  startDiscovery({ dgram, timers: timers.api, table, announce: () => null });

  dgram.socket.emit('message', encodeBeacon(FIELDS), { address: '192.168.1.42', port: 8010 });
  dgram.socket.emit('message', Buffer.from('}{'), { address: '192.168.1.9', port: 8010 });
  dgram.socket.emit('message', encodeBeacon({ ...FIELDS, id: 'me' }), { address: '192.168.1.7' });
  dgram.socket.emit('message', encodeBeacon(FIELDS), undefined);

  assert.deepEqual(table.games().map((game) => game.url), ['http://192.168.1.42:8000']);
});

test('a socket error degrades discovery to no list, and is logged once', () => {
  const dgram = fakeDgram();
  const timers = fakeTimers();
  const lines = [];
  const discovery = startDiscovery({
    dgram, timers: timers.api, announce: () => FIELDS, log: (line) => lines.push(line),
  });

  dgram.socket.emit('error', new Error('EADDRINUSE'));
  dgram.socket.emit('error', new Error('EADDRINUSE'));
  assert.equal(lines.length, 1, 'one line, not one per beacon, forever');
  assert.match(lines[0], /EADDRINUSE/);
  assert.equal(dgram.socket.closed, true);

  // The game server must still be standing.
  assert.doesNotThrow(() => timers.tick(3));
  discovery.close();
});

test('the defaults are the ones the design settled on', () => {
  assert.equal(DISCOVERY_PORT, 8010);
  assert.equal(BEACON_INTERVAL_MS, 2000);
  assert.equal(BEACON_TTL_MS, 6000);
  assert.equal(MAX_BEACON_BYTES, 512);
  assert.equal(new DiscoveryTable().ttlMs, BEACON_TTL_MS);
});
