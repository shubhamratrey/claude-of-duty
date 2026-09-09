import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import protocol from '../export/web/net/protocol.js';
import { bonjourHostname, createLanServer, lanAddresses, resolveStaticPath } from '../server/lan-server.mjs';

const WEB_ROOT = fileURLToPath(new URL('../export/web', import.meta.url));
const TIMEOUT_MS = 5000;

const PLAYER_STATE = {
  seq: 7, t: 12.5, pos: [1, 2, 3], yaw: 0.5, pitch: -0.25,
  flags: protocol.FLAG.MOVING, health: 100, alive: true,
};

const BOT_STATE = {
  t: 12.5,
  bots: [{ i: 0, pos: [4, 5, 6], yaw: 1, state: 'run', frame: 3, dead: false }],
};

/**
 * A LAN peer driven from Node, using the platform WebSocket rather than `ws`.
 * Testing against the same client the browser has is the point: if the built-in
 * client cannot talk to this server, neither can the game.
 */
class TestClient {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.frames = [];
    this.consumed = new Set();
    this.listeners = new Set();
    this.welcome = null;
    this.opened = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', () => resolve(this), { once: true });
      this.socket.addEventListener('error', () => reject(new Error(`connect failed: ${url}`)),
        { once: true });
    });
    this.socket.addEventListener('message', (event) => {
      const frame = protocol.decode(String(event.data));
      if (!frame) return;
      this.frames.push(frame);
      for (const listener of [...this.listeners]) listener();
    });
  }

  get peerId() {
    return this.welcome?.peerId ?? null;
  }

  send(type, data, from = null) {
    this.socket.send(protocol.encode(type, data, from));
  }

  /** First unclaimed frame matching `match`, marked claimed so a later wait for
   * the same type sees the next one instead of re-reading this one. */
  take(match) {
    for (let index = 0; index < this.frames.length; index += 1) {
      if (this.consumed.has(index)) continue;
      if (!match(this.frames[index])) continue;
      this.consumed.add(index);
      return this.frames[index];
    }
    return null;
  }

  waitFor(match, label = 'frame') {
    const already = this.take(match);
    if (already) return Promise.resolve(already);
    return new Promise((resolve, reject) => {
      const listener = () => {
        const hit = this.take(match);
        if (!hit) return;
        clearTimeout(timer);
        this.listeners.delete(listener);
        resolve(hit);
      };
      const timer = setTimeout(() => {
        this.listeners.delete(listener);
        reject(new Error(`timed out waiting for ${label}`));
      }, TIMEOUT_MS);
      this.listeners.add(listener);
    });
  }

  ofType(type) {
    return this.frames.filter((frame) => frame.type === type);
  }

  /**
   * A barrier for negative assertions. The server answers ping on the same
   * socket, in order, so once the pong is back everything this client sent
   * before the ping has already been handled — no arbitrary sleep required.
   */
  async roundTrip() {
    const clientTime = this.frames.length + 1;
    this.send(protocol.MSG.PING, { clientTime });
    return this.waitFor(
      (frame) => frame.type === protocol.MSG.PONG && frame.data.clientTime === clientTime,
      'pong',
    );
  }

  close() {
    try {
      this.socket.close();
    } catch {
      // Already gone; nothing to unwind.
    }
  }
}

async function boot(t) {
  const lan = await createLanServer({ port: 0, host: '127.0.0.1', log: () => {} });
  const clients = [];
  t.after(async () => {
    for (const client of clients) client.close();
    await lan.close();
  });
  lan.connect = async (count) => {
    // Sequentially, so join order — and therefore host election — is fixed.
    for (let index = 0; index < count; index += 1) {
      const client = new TestClient(lan.wsUrl);
      await client.opened;
      client.welcome = (await client.waitFor((f) => f.type === protocol.MSG.WELCOME,
        'welcome')).data;
      clients.push(client);
    }
    return clients;
  };
  return lan;
}

/** Raw GET, bypassing the URL parser so `..` reaches the server unnormalised. */
function rawGet(port, rawPath) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: '127.0.0.1', port, path: rawPath, method: 'GET', agent: false },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => resolve({
          status: response.statusCode,
          type: response.headers['content-type'] ?? '',
          body,
        }));
      },
    );
    request.on('error', reject);
    request.end();
  });
}

test('three clients get distinct peer ids and agree on one host', async (t) => {
  const lan = await boot(t);
  const [a, b, c] = await lan.connect(3);

  assert.deepEqual([a.peerId, b.peerId, c.peerId], ['peer-1', 'peer-2', 'peer-3']);
  assert.equal(new Set([a.peerId, b.peerId, c.peerId]).size, 3);
  for (const client of [a, b, c]) assert.equal(client.welcome.hostId, 'peer-1');

  // The last welcome is a full snapshot: a late joiner never has to ask twice.
  assert.deepEqual(c.welcome.roster, [
    { id: 'peer-1', name: 'PLAYER 1', host: true },
    { id: 'peer-2', name: 'PLAYER 2', host: false },
    { id: 'peer-3', name: 'PLAYER 3', host: false },
  ]);
  assert.ok(c.welcome.serverTime >= a.welcome.serverTime);

  const joined = await a.waitFor(
    (frame) => frame.type === protocol.MSG.PEER_JOINED && frame.data.peer.id === 'peer-3',
    'peerJoined peer-3',
  );
  assert.equal(joined.data.peer.host, false);
  // Nobody is told they joined; their own welcome already said so.
  assert.equal(c.ofType(protocol.MSG.PEER_JOINED).length, 0);
});

test('hello renames a peer and re-announces it to everyone', async (t) => {
  const lan = await boot(t);
  const [a, b] = await lan.connect(2);

  b.send(protocol.MSG.HELLO, { name: 'nova' });
  const seenByHost = await a.waitFor(
    (frame) => frame.type === protocol.MSG.PEER_JOINED && frame.data.peer.id === b.peerId &&
      frame.data.peer.name === 'NOVA',
    'renamed peerJoined',
  );
  assert.equal(seenByHost.data.peer.host, false);
  assert.equal(lan.roster.get('peer-2').name, 'NOVA');
});

test('ping is answered only to the asking socket', async (t) => {
  const lan = await boot(t);
  const [a, b] = await lan.connect(2);

  const pong = await a.roundTrip();
  // net-client.js derives its clock offset from this field, so the unit is part
  // of the contract: monotonic milliseconds since server start, never an epoch
  // value. A freshly booted server is therefore nowhere near 1e6.
  assert.equal(typeof pong.data.serverTime, 'number');
  assert.ok(pong.data.serverTime >= a.welcome.serverTime);
  assert.ok(pong.data.serverTime < 1e6);
  await b.roundTrip();
  assert.equal(a.ofType(protocol.MSG.PONG).length, 1);
});

test('a relayed frame reaches every other peer with from stamped by the server', async (t) => {
  const lan = await boot(t);
  const [a, b, c] = await lan.connect(3);

  // A forged `from`. The server must overwrite it rather than pass it along.
  a.send(protocol.MSG.PLAYER_STATE, PLAYER_STATE, 'peer-9');

  const atB = await b.waitFor((frame) => frame.type === protocol.MSG.PLAYER_STATE, 'state at B');
  const atC = await c.waitFor((frame) => frame.type === protocol.MSG.PLAYER_STATE, 'state at C');
  assert.equal(atB.from, a.peerId);
  assert.equal(atC.from, a.peerId);
  assert.deepEqual(atB.data.pos, PLAYER_STATE.pos);
  assert.equal(atB.data.seq, PLAYER_STATE.seq);

  // The sender never hears its own frame back; it already has that state.
  await a.roundTrip();
  assert.equal(a.ofType(protocol.MSG.PLAYER_STATE).length, 0);
});

test('host-only frames are dropped from a guest and relayed from the host', async (t) => {
  const lan = await boot(t);
  const [host, guest, watcher] = await lan.connect(3);

  guest.send(protocol.MSG.BOT_STATE, BOT_STATE);
  // Ordering barrier: this playerState was sent after the botState on the same
  // socket, so its arrival proves the botState was already handled and dropped.
  guest.send(protocol.MSG.PLAYER_STATE, PLAYER_STATE);
  await watcher.waitFor((frame) => frame.type === protocol.MSG.PLAYER_STATE, 'guest state');

  assert.equal(watcher.ofType(protocol.MSG.BOT_STATE).length, 0);
  assert.equal(host.ofType(protocol.MSG.BOT_STATE).length, 0);
  assert.equal(lan.stats.hostOnlyDropped, 1);

  host.send(protocol.MSG.BOT_STATE, BOT_STATE);
  const relayed = await watcher.waitFor((frame) => frame.type === protocol.MSG.BOT_STATE,
    'host botState');
  assert.equal(relayed.from, host.peerId);
  assert.equal(relayed.data.bots[0].i, 0);
  assert.equal(lan.stats.hostOnlyDropped, 1);
});

test('server-authored types from a client are never relayed', async (t) => {
  const lan = await boot(t);
  const [, guest, watcher] = await lan.connect(3);

  guest.send(protocol.MSG.HOST_CHANGED, { hostId: guest.peerId });
  guest.send(protocol.MSG.PLAYER_STATE, PLAYER_STATE);
  await watcher.waitFor((frame) => frame.type === protocol.MSG.PLAYER_STATE, 'barrier');

  assert.equal(watcher.ofType(protocol.MSG.HOST_CHANGED).length, 0);
  assert.equal(lan.stats.spoofedServerDropped, 1);
});

test('a malformed frame is dropped without disturbing the connection', async (t) => {
  const lan = await boot(t);
  const [a, b] = await lan.connect(2);

  a.socket.send('this is not json');
  a.socket.send(JSON.stringify({ v: 99, t: 'ping', d: { clientTime: 1 } }));
  a.socket.send(JSON.stringify({ v: 1, t: 'hit', d: { target: 'peer-2', damage: -5 } }));

  await a.roundTrip();
  assert.ok(lan.stats.malformedDropped >= 3);
  assert.equal(lan.roster.size, 2);
  assert.equal(b.socket.readyState, WebSocket.OPEN);
});

test('the host leaving promotes the next-oldest peer', async (t) => {
  const lan = await boot(t);
  const [host, next, last] = await lan.connect(3);

  host.close();

  const leftAtNext = await next.waitFor((frame) => frame.type === protocol.MSG.PEER_LEFT,
    'peerLeft');
  assert.equal(leftAtNext.data.peerId, 'peer-1');

  for (const client of [next, last]) {
    const changed = await client.waitFor((frame) => frame.type === protocol.MSG.HOST_CHANGED,
      'hostChanged');
    assert.equal(changed.data.hostId, 'peer-2');
  }
  assert.equal(lan.roster.hostId, 'peer-2');

  // The promoted host can now author what it could not a moment ago.
  next.send(protocol.MSG.BOT_STATE, BOT_STATE);
  const relayed = await last.waitFor((frame) => frame.type === protocol.MSG.BOT_STATE,
    'promoted botState');
  assert.equal(relayed.from, 'peer-2');
});

test('a guest leaving moves nobody', async (t) => {
  const lan = await boot(t);
  const [host, , guest] = await lan.connect(3);

  guest.close();
  const left = await host.waitFor((frame) => frame.type === protocol.MSG.PEER_LEFT, 'peerLeft');
  assert.equal(left.data.peerId, 'peer-3');

  await host.roundTrip();
  assert.equal(host.ofType(protocol.MSG.HOST_CHANGED).length, 0);
  assert.equal(lan.roster.hostId, 'peer-1');
});

test('static files are served with usable types and traversal is refused', async (t) => {
  const lan = await boot(t);

  const index = await rawGet(lan.port, '/');
  assert.equal(index.status, 200);
  assert.match(index.type, /text\/html/);
  assert.match(index.body, /<html/i);

  const script = await rawGet(lan.port, '/frontend.js');
  assert.equal(script.status, 200);
  assert.match(script.type, /javascript/);

  // Sent raw, without the URL parser a browser would apply. A plain `..` is
  // still collapsed by the parser inside the server, so this lands on a missing
  // file rather than a refusal — either way package.json does not leave the box.
  const climb = await rawGet(lan.port, '/../package.json');
  assert.notEqual(climb.status, 200);
  assert.doesNotMatch(climb.body, /claude-of-duty/);

  // This one the URL parser waves through: `%2f` is not a segment separator to
  // it, so the escape only becomes `../` at decode time. It is the case the
  // explicit root check in resolveStaticPath exists for.
  const encodedClimb = await rawGet(lan.port, '/%2e%2e%2fpackage.json');
  assert.equal(encodedClimb.status, 403);
  assert.doesNotMatch(encodedClimb.body, /claude-of-duty/);

  const nestedClimb = await rawGet(lan.port, '/enemies%2f..%2f..%2fpackage.json');
  assert.equal(nestedClimb.status, 403);
  assert.doesNotMatch(nestedClimb.body, /claude-of-duty/);

  const missing = await rawGet(lan.port, '/no-such-file.js');
  assert.equal(missing.status, 404);

  assert.equal(resolveStaticPath(WEB_ROOT, '/../package.json'), null);
  assert.equal(resolveStaticPath(WEB_ROOT, '/'), path.join(WEB_ROOT, 'index.html'));
  assert.equal(resolveStaticPath(WEB_ROOT, '/frontend.js'), path.join(WEB_ROOT, 'frontend.js'));
});

test('/net/health advertises every numeric join URL and the .local name', async (t) => {
  const lan = await boot(t);
  const health = await rawGet(lan.port, '/net/health');
  assert.equal(health.status, 200);
  assert.match(health.type, /application\/json/);
  const info = JSON.parse(health.body);
  assert.equal(info.lan, true);

  const addresses = lanAddresses();
  for (const address of addresses) {
    assert.ok(info.joinUrls.includes(`http://${address}:${lan.port}`),
      `${address} missing from ${JSON.stringify(info.joinUrls)}`);
  }
  // joinUrl is what the game reads out, so it stays a numeric address that
  // needs no name resolution to work.
  if (addresses.length > 0) {
    assert.equal(info.joinUrl, `http://${addresses[0]}:${lan.port}`);
    assert.equal(info.joinUrls.at(-1), `http://${bonjourHostname()}:${lan.port}`);
  } else {
    assert.equal(info.joinUrl, null);
    assert.deepEqual(info.joinUrls, []);
  }
});
