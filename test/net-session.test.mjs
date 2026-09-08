import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NetSession } from '../export/web/net/net-session.js';
import { MSG } from '../export/web/net/protocol.js';

// A stand-in for NetClient that records what was sent and lets a test push
// frames inbound. The session is written against the client's interface rather
// than a socket precisely so this is possible without a server.
class FakeClient {
  constructor({ peerId = 'peer-1', hostId = 'peer-1' } = {}) {
    this.peerId = peerId;
    this.hostId = hostId;
    this.sent = [];
    this.handlers = new Map();
    this.closed = false;
    this.time = 100;
  }

  get isHost() {
    return this.peerId === this.hostId;
  }

  on(type, handler) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(handler);
  }

  send(type, data) {
    this.sent.push({ type, data });
  }

  connect() {}

  close() {
    this.closed = true;
  }

  hostTimeSeconds() {
    return this.time;
  }

  getState() {
    return { connected: true, peerId: this.peerId, hostId: this.hostId, rttMs: 2, peers: [] };
  }

  /** Deliver an inbound frame the way NetClient would. */
  emit(type, data, from = null) {
    for (const handler of this.handlers.get(type) ?? []) handler(data, from);
  }

  ofType(type) {
    return this.sent.filter((frame) => frame.type === type);
  }
}

// The enemy rig is a browser-only object, so remote bodies are stubbed. The
// session only ever calls the actor factory and applyNetworkState.
const fakeEnemies = () => ({
  actors: new Map(),
  createNetworkActor(id) {
    const actor = { id, applied: [], visualFrames: { idle: [0], run: new Array(20), death: new Array(6) },
      applyNetworkState(state) { this.applied.push(state); } };
    this.actors.set(id, actor);
    return actor;
  },
  destroyNetworkActor(actor) {
    this.actors.delete(typeof actor === 'string' ? actor : actor.id);
  },
});

function makeSession({ peerId = 'peer-1', hostId = 'peer-1', game = {} } = {}) {
  const client = new FakeClient({ peerId, hostId });
  const calls = [];
  const record = (name) => (...args) => { calls.push({ name, args }); return true; };
  const adapter = {
    getLocalPlayerState: () => ({
      pos: [1, 2, 3], yaw: 0.5, pitch: 0.1, flags: 0, health: 100, alive: true, weaponId: 'm27',
    }),
    getBotSnapshot: () => [{ i: 0, pos: [0, 0, 0], yaw: 0, state: 'idle', frame: 0, dead: false }],
    getMatchState: () => ({ phase: 'playing', standings: [] }),
    applyLocalDamage: record('applyLocalDamage'),
    applyBotDamage: record('applyBotDamage'),
    applyBotState: record('applyBotState'),
    applyMatchState: record('applyMatchState'),
    applyAssignedSpawn: record('applyAssignedSpawn'),
    recordKill: record('recordKill'),
    onRemoteFire: record('onRemoteFire'),
    onRoleChanged: record('onRoleChanged'),
    registerCombatant: record('registerCombatant'),
    unregisterCombatant: record('unregisterCombatant'),
    reconcileCombatants: record('reconcileCombatants'),
    chooseSpawnFor: () => ({ position: { x: 5, y: 0, z: 5 }, yaw: 1 }),
    ...game,
  };
  const session = new NetSession({ url: 'ws://x/net', game: adapter, clientFactory: () => client });
  session.attach(fakeEnemies());
  return { session, client, calls, named: (n) => calls.filter((c) => c.name === n) };
}

test('local combatant id is the peer id online and player offline', () => {
  const { session } = makeSession({ peerId: 'peer-4', hostId: 'peer-1' });
  assert.equal(session.localCombatantId, 'peer-4');
  session.client.peerId = null;
  assert.equal(session.localCombatantId, 'player');
});

test('a hit naming this machine is applied locally, whoever fired it', () => {
  const { session, client, named } = makeSession({ peerId: 'peer-2', hostId: 'peer-1' });
  client.emit(MSG.HIT, { target: 'peer-2', damage: 33, box: 'head', t: 1 }, 'peer-9');
  const applied = named('applyLocalDamage');
  assert.equal(applied.length, 1);
  assert.deepEqual(applied[0].args, [33, 'peer-9', 'head']);
  assert.equal(session.rejectedHits, 0);
});

test('a guest ignores a hit on a bot; only the host applies it', () => {
  const guest = makeSession({ peerId: 'peer-2', hostId: 'peer-1' });
  guest.client.emit(MSG.HIT, { target: 'bot-3', damage: 33, box: 'torso', t: 1 }, 'peer-9');
  assert.equal(guest.named('applyBotDamage').length, 0);

  const host = makeSession({ peerId: 'peer-1', hostId: 'peer-1' });
  host.client.emit(MSG.HIT, { target: 'bot-3', damage: 33, box: 'torso', t: 1 }, 'peer-9');
  assert.equal(host.named('applyBotDamage').length, 1);
  assert.deepEqual(host.named('applyBotDamage')[0].args, ['bot-3', 33, 'torso', 'peer-9']);
});

test('a hit on someone else is ignored by everyone but its owner', () => {
  const { client, named } = makeSession({ peerId: 'peer-2', hostId: 'peer-2' });
  client.emit(MSG.HIT, { target: 'peer-5', damage: 33, box: 'torso', t: 1 }, 'peer-9');
  assert.equal(named('applyLocalDamage').length, 0);
  assert.equal(named('applyBotDamage').length, 0);
});

test('a client never applies a hit it reported itself', () => {
  const { client, named } = makeSession({ peerId: 'peer-2', hostId: 'peer-1' });
  client.emit(MSG.HIT, { target: 'peer-2', damage: 33, box: 'head', t: 1 }, 'peer-2');
  assert.equal(named('applyLocalDamage').length, 0);
});

test('only the host scores a death, and it answers with a spawn', () => {
  const host = makeSession({ peerId: 'peer-1', hostId: 'peer-1' });
  host.client.emit(MSG.DIED, { by: 'peer-3', at: 12 }, 'peer-2');
  assert.deepEqual(host.named('recordKill')[0].args, ['peer-3', 'peer-2']);
  const spawns = host.client.ofType(MSG.SPAWN);
  assert.equal(spawns.length, 1);
  assert.deepEqual(spawns[0].data.pos, [5, 0, 5]);
  assert.equal(spawns[0].data.peerId, 'peer-2');

  const guest = makeSession({ peerId: 'peer-2', hostId: 'peer-1' });
  guest.client.emit(MSG.DIED, { by: 'peer-3', at: 12 }, 'peer-4');
  assert.equal(guest.named('recordKill').length, 0);
  assert.equal(guest.client.ofType(MSG.SPAWN).length, 0);
});

test('the host scores its own death without a round trip', () => {
  const host = makeSession({ peerId: 'peer-1', hostId: 'peer-1' });
  host.session.reportDeath('peer-6');
  assert.deepEqual(host.named('recordKill')[0].args, ['peer-6', 'peer-1']);
  assert.equal(host.client.ofType(MSG.DIED).length, 1);
});

test('a guest reports its death and does not score it', () => {
  const guest = makeSession({ peerId: 'peer-2', hostId: 'peer-1' });
  guest.session.reportDeath('peer-6');
  assert.equal(guest.named('recordKill').length, 0);
  const died = guest.client.ofType(MSG.DIED);
  assert.equal(died.length, 1);
  assert.equal(died[0].data.by, 'peer-6');
});

test('bot and match state are accepted only from the current host', () => {
  const { client, named } = makeSession({ peerId: 'peer-2', hostId: 'peer-1' });
  const bots = { t: 1, bots: [] };
  client.emit(MSG.BOT_STATE, bots, 'peer-7');
  client.emit(MSG.MATCH_STATE, { phase: 'playing', standings: [] }, 'peer-7');
  assert.equal(named('applyBotState').length, 0);
  assert.equal(named('applyMatchState').length, 0);

  client.emit(MSG.BOT_STATE, bots, 'peer-1');
  client.emit(MSG.MATCH_STATE, { phase: 'playing', standings: [] }, 'peer-1');
  assert.equal(named('applyBotState').length, 1);
  assert.equal(named('applyMatchState').length, 1);
});

test('the host ignores bot state entirely, even from a stale former host', () => {
  const { client, named } = makeSession({ peerId: 'peer-1', hostId: 'peer-1' });
  client.emit(MSG.BOT_STATE, { t: 1, bots: [] }, 'peer-2');
  assert.equal(named('applyBotState').length, 0);
});

test('an assigned spawn is applied only when it names this peer', () => {
  const { client, named } = makeSession({ peerId: 'peer-2', hostId: 'peer-1' });
  client.emit(MSG.SPAWN, { peerId: 'peer-3', pos: [1, 1, 1], yaw: 0 }, 'peer-1');
  assert.equal(named('applyAssignedSpawn').length, 0);
  client.emit(MSG.SPAWN, { peerId: 'peer-2', pos: [1, 1, 1], yaw: 0 }, 'peer-1');
  assert.equal(named('applyAssignedSpawn').length, 1);
});

test('update sends player state at the wire rate, and bot state only as host', () => {
  const guest = makeSession({ peerId: 'peer-2', hostId: 'peer-1' });
  guest.session.update(1);
  assert.equal(guest.client.ofType(MSG.PLAYER_STATE).length, 1);
  assert.equal(guest.client.ofType(MSG.BOT_STATE).length, 0);

  const host = makeSession({ peerId: 'peer-1', hostId: 'peer-1' });
  host.session.update(1);
  assert.equal(host.client.ofType(MSG.BOT_STATE).length, 1);
});

test('the host repeats the scoreboard as a keepalive but not every frame', () => {
  const host = makeSession({ peerId: 'peer-1', hostId: 'peer-1' });
  host.session.update(0.05);
  host.session.update(0.05);
  host.session.update(0.05);
  // Unchanged state must not be resent each frame; the keepalive is the floor.
  assert.equal(host.client.ofType(MSG.MATCH_STATE).length, 1);
  host.session.update(1);
  assert.equal(host.client.ofType(MSG.MATCH_STATE).length, 2);
});

test('a role change is announced once per transition', () => {
  const { session, client, named } = makeSession({ peerId: 'peer-2', hostId: 'peer-1' });
  client.emit(MSG.HOST_CHANGED, { hostId: 'peer-1' });
  assert.equal(named('onRoleChanged').length, 0, 'no transition, no announcement');

  client.hostId = 'peer-2';
  client.emit(MSG.HOST_CHANGED, { hostId: 'peer-2' });
  assert.deepEqual(named('onRoleChanged')[0].args, ['host']);
  assert.equal(session.isHost, true);

  client.hostId = 'peer-9';
  client.emit(MSG.HOST_CHANGED, { hostId: 'peer-9' });
  assert.deepEqual(named('onRoleChanged')[1].args, ['guest']);
});

test('a departing peer loses its body, and the host drops its score', () => {
  const host = makeSession({ peerId: 'peer-1', hostId: 'peer-1' });
  host.client.emit(MSG.PEER_JOINED, { peer: { id: 'peer-2', name: 'ALEX' } });
  assert.ok(host.session.remotePlayers.has('peer-2'));
  host.client.emit(MSG.PEER_LEFT, { peerId: 'peer-2' });
  assert.ok(!host.session.remotePlayers.has('peer-2'));
  assert.deepEqual(host.named('unregisterCombatant')[0].args, ['peer-2']);
});

test('a departing peer is dropped by every client, not only the host', () => {
  // The server announces the departure before the new host, so a peer about to
  // be promoted sees this while still a guest. Gating on isHost here left the
  // departed host on the scoreboard for the rest of the match.
  const guest = makeSession({ peerId: 'peer-2', hostId: 'peer-1' });
  guest.client.emit(MSG.PEER_LEFT, { peerId: 'peer-1' });
  assert.deepEqual(guest.named('unregisterCombatant')[0].args, ['peer-1']);
});

test('promotion reconciles the scoreboard against who is actually connected', () => {
  const { session, client, named } = makeSession({ peerId: 'peer-2', hostId: 'peer-1' });
  client.getState = () => ({
    connected: true, peerId: 'peer-2', hostId: 'peer-2', rttMs: 1,
    peers: [{ id: 'peer-2', name: 'B' }, { id: 'peer-3', name: 'C' }],
  });
  client.hostId = 'peer-2';
  client.emit(MSG.HOST_CHANGED, { hostId: 'peer-2' });

  const reconciled = named('reconcileCombatants');
  assert.equal(reconciled.length, 1, 'reconciles exactly once on promotion');
  const present = reconciled[0].args[0];
  assert.ok(present.includes('peer-2'));
  assert.ok(present.includes('peer-3'));
  assert.ok(!present.includes('peer-1'), 'the host that left is not present');
  assert.equal(session.isHost, true);
});

test('a guest is never asked to reconcile the scoreboard it does not own', () => {
  const { client, named } = makeSession({ peerId: 'peer-3', hostId: 'peer-1' });
  client.hostId = 'peer-2';
  client.emit(MSG.HOST_CHANGED, { hostId: 'peer-2' });
  assert.equal(named('reconcileCombatants').length, 0);
});

test('remote fire is forwarded for effects but never self-echoed', () => {
  const { client, named } = makeSession({ peerId: 'peer-2', hostId: 'peer-1' });
  client.emit(MSG.WEAPON_FIRE, { origin: [0, 0, 0], dir: [1, 0, 0] }, 'peer-2');
  assert.equal(named('onRemoteFire').length, 0);
  client.emit(MSG.WEAPON_FIRE, { origin: [0, 0, 0], dir: [1, 0, 0] }, 'peer-5');
  assert.equal(named('onRemoteFire').length, 1);
});

test('debug state stays serialisable, as the debug API contract requires', () => {
  const { session } = makeSession();
  const state = session.getState();
  assert.deepEqual(JSON.parse(JSON.stringify(state)), state);
  assert.equal(state.localCombatantId, 'peer-1');
  assert.ok(Array.isArray(state.remoteBodies));
});
