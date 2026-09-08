// Remote human players, drawn with the bot rig.
//
// A remote player is an EnemyManager network actor: the same baked pose
// bodies, the same three hitboxes, the same death blend. That is why shooting
// a friend in the head already works — it runs the identical raycast path the
// bots have always used.
//
// Bodies are drawn in the past. Each peer's states land in a SnapshotBuffer
// and are sampled at `hostTime - INTERPOLATION_DELAY`, so a body always has
// two real samples to sit between instead of being extrapolated forward into
// a guess. On a LAN the delay costs a tenth of a second of freshness and buys
// motion with no rubber-banding.

import { SnapshotBuffer } from './snapshot-buffer.js';
import { unpackFlags } from './protocol.js';

const round2 = (value) => Math.round(value * 100) / 100;

/** Seconds behind the host clock that remote bodies are rendered. */
export const INTERPOLATION_DELAY = 0.1;

/** A peer whose snapshots stop arriving for this long is presumed gone. */
const STALE_SECONDS = 5;

// Run-cycle playback. The wire carries movement flags, not pose frames: a frame
// index is meaningless across machines whose animations started at different
// times, and interpolating one would blend a walk into a crouch. Each client
// therefore runs the cycle itself.
//
// EnemyManager.update() already ticks every registered actor, which advances
// its pose. So this file must NOT advance it a second time -- it only names the
// pose, and hands applyNetworkState the frame the actor is already on so the
// re-seed is a no-op. Computing a frame here instead would run the animation at
// double speed, which is subtle enough to ship by accident.

export class RemotePlayers {
  /**
   * @param {object} options
   * @param {object} options.enemies EnemyManager providing the actor factory.
   * @param {(id: string, name: string) => void} [options.onJoin]
   * @param {(id: string) => void} [options.onLeave]
   */
  constructor({ enemies, onJoin = null, onLeave = null } = {}) {
    if (!enemies) throw new Error('RemotePlayers requires the EnemyManager');
    this.enemies = enemies;
    this.onJoin = onJoin;
    this.onLeave = onLeave;
    this.players = new Map();
  }

  get count() {
    return this.players.size;
  }

  has(peerId) {
    return this.players.has(peerId);
  }

  get(peerId) {
    return this.players.get(peerId) ?? null;
  }

  /**
   * Create the body for a peer, or return the existing one.
   *
   * Returns null when the enemy rig has not finished loading. That is a normal
   * race on a fast join, not an error: the peer's next snapshot creates the
   * body a frame later.
   */
  ensure(peerId, name = peerId) {
    const existing = this.players.get(peerId);
    if (existing) {
      existing.name = name;
      return existing;
    }
    const actor = this.enemies.createNetworkActor?.(peerId) ?? null;
    if (!actor) return null;

    const player = {
      id: peerId,
      name,
      actor,
      buffer: new SnapshotBuffer({ maxSamples: 32, maxAgeSeconds: 2 }),
      pose: null,
      health: 100,
      alive: true,
      lastSeen: 0,
      weaponId: null,
    };
    this.players.set(peerId, player);
    this.onJoin?.(peerId, name);
    return player;
  }

  /** Buffer one `playerState` payload. Unknown peers get a body on arrival. */
  applyPlayerState(peerId, data, receivedAt) {
    const player = this.ensure(peerId);
    if (!player) return;
    player.lastSeen = receivedAt;
    player.health = data.health;
    player.alive = data.alive;
    if (data.weaponId !== undefined) player.weaponId = data.weaponId;
    player.buffer.push(data.t, {
      pos: data.pos,
      yaw: data.yaw,
      pitch: data.pitch,
      flags: data.flags,
      health: data.health,
      alive: data.alive,
    });
  }

  remove(peerId) {
    const player = this.players.get(peerId);
    if (!player) return false;
    this.enemies.destroyNetworkActor?.(player.actor ?? peerId);
    this.players.delete(peerId);
    this.onLeave?.(peerId);
    return true;
  }

  clear() {
    for (const peerId of [...this.players.keys()]) this.remove(peerId);
  }

  /**
   * Advance every remote body.
   *
   * @param {number} deltaSeconds real frame time, for the local run cycle
   * @param {number} hostTimeSeconds current estimate of the host clock
   */
  update(deltaSeconds, hostTimeSeconds) {
    const sampleAt = hostTimeSeconds - INTERPOLATION_DELAY;
    for (const player of this.players.values()) {
      if (hostTimeSeconds - player.lastSeen > STALE_SECONDS) {
        this.remove(player.id);
        continue;
      }
      const state = player.buffer.sample(sampleAt);
      if (!state) continue;

      const flags = unpackFlags(state.flags);
      const dead = state.alive === false;
      const pose = dead ? 'death' : (flags.moving ? 'run' : 'idle');

      player.actor.applyNetworkState?.({
        pos: state.pos,
        yaw: state.yaw,
        state: pose,
        frame: this.frameIndex(player, pose),
        dead,
        // Host time of this sample: the actor derives movement speed from the
        // step between calls, which bots read to widen their spread against a
        // moving human.
        t: sampleAt,
      });
      player.pose = pose;
    }
  }

  /**
   * Which frame to hand applyNetworkState.
   *
   * Entering a new pose starts at zero; staying in one hands back the frame the
   * actor's own tick has already reached, so the re-seed does not restart the
   * cycle every snapshot.
   */
  frameIndex(player, pose) {
    if (pose !== player.pose) return 0;
    const frames = player.actor?.visualFrames?.[pose]?.length ?? 1;
    const current = player.actor?.visualFrameIndex ?? 0;
    return Math.max(0, Math.min(current, frames - 1));
  }

  /** Compact, serialisable view for the game's debug API. */
  getState() {
    return [...this.players.values()].map((player) => {
      const p = player.actor?.root?.position;
      return {
        id: player.id,
        name: player.name,
        health: Math.round(player.health),
        alive: player.alive,
        samples: player.buffer.length,
        // Where THIS machine is drawing them, which is what its own bullets
        // will hit. Reporting the peer's self-declared position instead would
        // hide exactly the interpolation bugs worth catching.
        pos: p ? [round2(p.x), round2(p.y), round2(p.z)] : null,
      };
    });
  }
}

export default RemotePlayers;

/**
 * Bots as seen by a guest.
 *
 * Only the host runs bot AI and the navmesh crowd. A guest holds the same six
 * bodies but drives them from `botState`, and buffers them exactly the way it
 * buffers people -- applying 20 Hz snapshots straight to a transform reads as
 * a visible stutter, which is the one thing replication must not look like.
 *
 * Pose frames DO come off the wire here, unlike for players: the host owns the
 * bot's animation state, so a guest showing a different frame would show a bot
 * firing while the host has it reloading.
 */
export class RemoteBots {
  constructor({ enemies } = {}) {
    if (!enemies) throw new Error('RemoteBots requires the EnemyManager');
    this.enemies = enemies;
    this.buffers = new Map();
  }

  applyBotState(data) {
    for (const bot of data.bots ?? []) {
      let buffer = this.buffers.get(bot.i);
      if (!buffer) {
        buffer = new SnapshotBuffer({ maxSamples: 16, maxAgeSeconds: 2 });
        this.buffers.set(bot.i, buffer);
      }
      buffer.push(data.t, {
        pos: bot.pos, yaw: bot.yaw, state: bot.state, frame: bot.frame, dead: bot.dead,
      });
    }
  }

  update(hostTimeSeconds) {
    const sampleAt = hostTimeSeconds - INTERPOLATION_DELAY;
    for (const [index, buffer] of this.buffers) {
      const sample = buffer.sample(sampleAt);
      const enemy = this.enemies.enemies?.[index];
      if (!sample || !enemy) continue;
      enemy.applyNetworkState?.(sample);
    }
  }

  clear() {
    this.buffers.clear();
  }

  get count() {
    return this.buffers.size;
  }
}
