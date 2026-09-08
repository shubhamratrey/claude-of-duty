// One relay room.
//
// A relay holds exactly one room at a time, which is what makes the code a
// secret rather than an address: there is nothing to address. The first client
// to reach an empty relay creates the room and is told the code; everybody else
// is told a room exists and has to produce that code. When the last member
// leaves, the room is destroyed and its code goes with it, so the next arrival
// starts a fresh game rather than walking into a stale one.
//
// Membership and host election are LanRoster's job, unchanged. This file owns
// the code and the lifecycle around it.

import { randomInt } from 'node:crypto';
import { LanRoster } from './lan-roster.mjs';
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH, normalizeRoomCode } from '../export/web/net/protocol.js';

/**
 * A fresh room code.
 *
 * `randomInt` rather than `Math.random` because this is the only thing standing
 * between a stranger who found the relay URL and the game -- guessable is the
 * one property it must not have. `avoid` keeps a new room from reusing the code
 * the previous one just released, which would be confusing rather than unsafe.
 */
export function generateRoomCode(avoid = null) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    let code = '';
    for (let i = 0; i < ROOM_CODE_LENGTH; i += 1) {
      code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
    }
    if (code !== avoid) return code;
  }
  // Eight collisions against a single value is not reachable in practice; if it
  // somehow happens, a repeated code is better than no room.
  return normalizeRoomCode(avoid) || ROOM_CODE_ALPHABET.slice(0, ROOM_CODE_LENGTH);
}

export class RelayRoom {
  constructor({ code, maxPeers = 8, now = () => Date.now() } = {}) {
    this.code = code ?? generateRoomCode();
    this.roster = new LanRoster({ maxPeers, now });
    this.createdAt = now();
  }

  get size() {
    return this.roster.size;
  }

  get full() {
    return this.roster.full;
  }

  get empty() {
    return this.roster.size === 0;
  }

  get hostId() {
    return this.roster.hostId;
  }

  /** True when `candidate` is this room's code, however it was typed. */
  accepts(candidate) {
    return normalizeRoomCode(candidate) === this.code;
  }

  join(name) {
    return this.roster.join(name);
  }

  leave(peerId) {
    return this.roster.leave(peerId);
  }
}

/**
 * The relay's single-room slot.
 *
 * Deliberately not a registry. Multiple concurrent rooms were considered and
 * dropped: with one room the code is a join secret and the server stays small,
 * and nothing in the client needs to choose between rooms.
 */
export class RoomSlot {
  constructor({ maxPeers = 8, now = () => Date.now() } = {}) {
    this.maxPeers = maxPeers;
    this.now = now;
    this.room = null;
    this.lastCode = null;
  }

  get occupied() {
    return this.room !== null;
  }

  /** Create the room. Returns it, or the existing one if there already is one. */
  create() {
    if (this.room) return this.room;
    this.room = new RelayRoom({
      code: generateRoomCode(this.lastCode),
      maxPeers: this.maxPeers,
      now: this.now,
    });
    return this.room;
  }

  /**
   * Admit a client.
   *
   * With no room, any caller creates one and becomes host -- this is what makes
   * pasting the URL enough, with no button to press. With a room, the code is
   * required and wrong codes are refused rather than quietly ignored.
   *
   * Returns `{ ok: true, room, peer, created }` or `{ ok: false, reason }`.
   */
  admit({ code = null, name = '' } = {}) {
    if (!this.room) {
      if (code !== null && code !== undefined && code !== '') {
        // Somebody typed a code for a room that has since emptied. Telling them
        // so is kinder than silently making them the host of a different game.
        return { ok: false, reason: 'no-room' };
      }
      const room = this.create();
      const peer = room.join(name);
      if (!peer) return { ok: false, reason: 'room-full' };
      return { ok: true, room, peer, created: true };
    }

    if (!this.room.accepts(code)) return { ok: false, reason: 'bad-code' };
    if (this.room.full) return { ok: false, reason: 'room-full' };
    const peer = this.room.join(name);
    if (!peer) return { ok: false, reason: 'room-full' };
    return { ok: true, room: this.room, peer, created: false };
  }

  /** Remove a member, destroying the room once it is empty. */
  remove(peerId) {
    if (!this.room) return false;
    const removed = this.room.leave(peerId);
    if (this.room.empty) this.destroy();
    return removed;
  }

  destroy() {
    if (!this.room) return;
    this.lastCode = this.room.code;
    this.room = null;
  }

  /** Compact view for the HTTP health probe. */
  describe() {
    return {
      relay: true,
      room: this.occupied,
      peers: this.room?.size ?? 0,
    };
  }
}

export default RoomSlot;
