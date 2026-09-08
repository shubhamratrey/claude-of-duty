// LAN session: decides what this machine sends and what it does with what
// arrives. This is where the damage invariant from the design lives.
//
//   Damage is shooter-reported. Death is victim-confirmed. Scoring is
//   host-recorded.
//
// So: you raycast locally and announce the hit; the machine that owns the body
// decides whether it died; the host is the only machine that writes the
// scoreboard. Every rule below follows from that sentence, and changing one
// without the others will desync a match in a way that is painful to debug.
//
// The session never imports game internals. It reaches the game through the
// `game` adapter passed to the constructor, which keeps this file testable in
// Node with a plain object and keeps the game free to reorganise.

import { NetClient } from './net-client.js';
import { RemotePlayers } from './remote-players.js';
import { MSG, packVec3, roundAngle, isBotId, sanitizeName } from './protocol.js';

/** Outbound state rate. 20 Hz is invisible on a LAN and cheap to buffer. */
const SEND_HZ = 20;
const SEND_INTERVAL = 1 / SEND_HZ;

/** The host resends the scoreboard this often even when nothing changed. */
const MATCH_KEEPALIVE_SECONDS = 1;

export class NetSession {
  constructor({ url, name = 'PLAYER', game, clientFactory = null, now = () => performance.now() } = {}) {
    if (!game) throw new Error('NetSession requires a game adapter');
    this.game = game;
    this.now = now;
    this.client = clientFactory
      ? clientFactory({ url, name })
      : new NetClient({ url, name });

    this.remotePlayers = null;
    this.enabled = false;
    this.seq = 0;
    this.sendTimer = 0;
    this.matchTimer = 0;
    this.lastMatchJson = '';
    this.rejectedHits = 0;
    this.wasHost = false;

    this.bindClient();
  }

  get peerId() {
    return this.client.peerId;
  }

  get isHost() {
    return this.client.isHost;
  }

  get connected() {
    return this.client.getState().connected;
  }

  /**
   * Combatant key for this machine's player.
   *
   * Offline it stays 'player', which is what the single-player code already
   * registers. Online it becomes the peer id, because the host writes one
   * scoreboard for everyone and every combatant needs a globally unique key.
   */
  get localCombatantId() {
    return this.peerId ?? 'player';
  }

  /** Called once the enemy rig exists, since remote bodies are built from it. */
  attach(enemies) {
    this.remotePlayers = new RemotePlayers({
      enemies,
      onJoin: (id, peerName) => this.game.onPeerBodyCreated?.(id, peerName),
      onLeave: (id) => this.game.onPeerBodyRemoved?.(id),
    });
    this.enabled = true;
  }

  connect() {
    this.client.connect();
  }

  /**
   * Publish a new display name.
   *
   * The server re-announces the peer so every lobby and scoreboard updates,
   * and the local combatant is re-registered under the same id so this
   * machine's own row renames without waiting for the round trip.
   */
  setName(name) {
    const clean = sanitizeName(name, 'PLAYER');
    this.client.name = clean;
    this.send(MSG.HELLO, { name: clean });
    this.game.onIdentity?.(this.peerId, this.isHost);
    return clean;
  }

  close() {
    this.enabled = false;
    this.remotePlayers?.clear();
    this.client.close();
  }

  bindClient() {
    const client = this.client;

    client.on('welcome', () => {
      this.game.onIdentity?.(this.peerId, this.isHost);
      this.syncRole();
    });
    client.on(MSG.HOST_CHANGED, () => this.syncRole());
    client.on(MSG.PEER_JOINED, (data) => {
      this.remotePlayers?.ensure(data.peer.id, data.peer.name);
      if (this.isHost) this.game.registerCombatant?.(data.peer.id, data.peer.name);
    });
    client.on(MSG.PEER_LEFT, (data) => {
      this.remotePlayers?.remove(data.peerId);
      // Every client drops the combatant, not just the host.
      //
      // The server announces the departure before it announces the new host,
      // so when the HOST is the one who left, this arrives while the peer
      // about to be promoted is still a guest. Gating on isHost here meant the
      // promoted client republished a scoreboard that still contained the
      // player who had just quit, and that row then survived the rest of the
      // match. A guest's scoreboard is overwritten by the next matchState
      // anyway, so doing this unconditionally costs nothing.
      this.game.unregisterCombatant?.(data.peerId);
    });

    client.on(MSG.PLAYER_STATE, (data, from) => {
      if (!from || from === this.peerId) return;
      this.remotePlayers?.applyPlayerState(from, data, this.client.hostTimeSeconds());
    });

    client.on(MSG.WEAPON_FIRE, (data, from) => {
      if (!from || from === this.peerId) return;
      this.game.onRemoteFire?.(from, data.origin, data.dir);
    });

    client.on(MSG.BOT_STATE, (data, from) => {
      // Only the host authors bot state; the server already drops it from
      // anyone else, but a stale host's last frame can still be in flight.
      if (this.isHost || from !== this.client.hostId) return;
      this.game.applyBotState?.(data);
    });

    client.on(MSG.MATCH_STATE, (data, from) => {
      if (this.isHost || from !== this.client.hostId) return;
      this.game.applyMatchState?.(data);
    });

    client.on(MSG.SPAWN, (data, from) => {
      if (from !== this.client.hostId) return;
      if (data.peerId !== this.peerId) return;
      this.game.applyAssignedSpawn?.(data.pos, data.yaw);
    });

    client.on(MSG.HIT, (data, from) => this.onHit(data, from));
    client.on(MSG.DIED, (data, from) => this.onDied(data, from));
  }

  /**
   * A hit reported by whoever fired the shot.
   *
   * Only the machine that owns the target acts on it: the victim for a person,
   * the host for a bot. Everyone else ignores it, which is why this can be a
   * plain broadcast instead of addressed delivery.
   */
  onHit(data, from) {
    if (!from || from === this.peerId) return;
    if (data.target === this.localCombatantId) {
      this.game.applyLocalDamage?.(data.damage, from, data.box);
      return;
    }
    if (this.isHost && isBotId(data.target)) {
      const applied = this.game.applyBotDamage?.(data.target, data.damage, data.box, from);
      if (applied === false) this.rejectedHits += 1;
    }
  }

  /** Only the host writes the scoreboard, and it answers a death with a spawn. */
  onDied(data, from) {
    if (!this.isHost || !from) return;
    this.game.recordKill?.(data.by, from);
    const spawn = this.game.chooseSpawnFor?.(from);
    if (spawn) {
      this.send(MSG.SPAWN, {
        peerId: from,
        pos: packVec3(spawn.position),
        yaw: roundAngle(spawn.yaw ?? 0),
      });
    }
    this.broadcastMatch(true);
  }

  syncRole() {
    const host = this.isHost;
    if (host !== this.wasHost) {
      this.wasHost = host;
      if (host) this.reconcileRoster();
      this.game.onRoleChanged?.(host ? 'host' : 'guest');
    }
  }

  /**
   * Make the scoreboard match who is actually connected.
   *
   * Run on promotion, because the new host inherits a mirrored scoreboard that
   * may name people who have already gone -- including, always, the host it is
   * replacing. From this moment it is the one publishing that scoreboard to
   * everyone, so it has to be right. Bots are left alone: they are not peers,
   * and the host owns them regardless of who is connected.
   */
  reconcileRoster() {
    const present = new Set((this.client.getState().peers ?? []).map((peer) => peer.id));
    present.add(this.localCombatantId);
    this.game.reconcileCombatants?.([...present]);
    this.broadcastMatch(true);
  }

  send(type, data) {
    this.client.send(type, data);
  }

  /** Announce a shot so remote muzzle flash, tracer, and audio replay. */
  reportFire(origin, dir) {
    if (!this.enabled) return;
    this.send(MSG.WEAPON_FIRE, { origin: packVec3(origin), dir: packVec3(dir) });
  }

  /** Announce a resolved local hit. The owner of the target decides the rest. */
  reportHit(targetId, damage, box) {
    if (!this.enabled || !targetId) return;
    this.send(MSG.HIT, {
      target: targetId,
      damage: Math.round(damage),
      box,
      t: this.client.hostTimeSeconds(),
    });
  }

  /** Announce that this machine's player died, and to whom. */
  reportDeath(killerId) {
    if (!this.enabled) return;
    const at = this.client.hostTimeSeconds();
    this.send(MSG.DIED, { by: killerId ?? null, at });
    // The host does not receive its own broadcast, so it scores itself here.
    if (this.isHost) {
      this.game.recordKill?.(killerId ?? null, this.localCombatantId);
      this.broadcastMatch(true);
    }
  }

  broadcastMatch(force = false) {
    if (!this.isHost) return;
    const state = this.game.getMatchState?.();
    if (!state) return;
    const json = JSON.stringify(state);
    if (!force && json === this.lastMatchJson) return;
    this.lastMatchJson = json;
    this.send(MSG.MATCH_STATE, state);
  }

  /** Drive from the game's frame loop. */
  update(deltaSeconds) {
    if (!this.enabled) return;
    const hostTime = this.client.hostTimeSeconds();
    this.remotePlayers?.update(deltaSeconds, hostTime);

    this.sendTimer -= deltaSeconds;
    if (this.sendTimer <= 0) {
      this.sendTimer += SEND_INTERVAL;
      this.sendPlayerState(hostTime);
      if (this.isHost) this.sendBotState(hostTime);
    }

    if (this.isHost) {
      this.matchTimer -= deltaSeconds;
      if (this.matchTimer <= 0) {
        this.matchTimer += MATCH_KEEPALIVE_SECONDS;
        this.broadcastMatch(true);
      } else {
        this.broadcastMatch(false);
      }
    }
  }

  sendPlayerState(hostTime) {
    const local = this.game.getLocalPlayerState?.();
    if (!local) return;
    this.seq += 1;
    this.send(MSG.PLAYER_STATE, {
      seq: this.seq,
      t: hostTime,
      pos: local.pos,
      yaw: roundAngle(local.yaw),
      pitch: roundAngle(local.pitch),
      flags: local.flags,
      weaponId: local.weaponId ?? null,
      health: Math.round(local.health),
      alive: local.alive,
    });
  }

  sendBotState(hostTime) {
    const bots = this.game.getBotSnapshot?.();
    if (!bots?.length) return;
    this.send(MSG.BOT_STATE, { t: hostTime, bots });
  }

  /** Compact, serialisable view for the game's debug API. */
  getState() {
    const client = this.client.getState();
    return {
      ...client,
      enabled: this.enabled,
      localCombatantId: this.localCombatantId,
      rejectedHits: this.rejectedHits,
      remoteBodies: this.remotePlayers?.getState() ?? [],
    };
  }
}

export default NetSession;
