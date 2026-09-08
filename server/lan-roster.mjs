// Who is in the match, in what order they arrived, and which one is host.
//
// This file is deliberately free of sockets, timers and I/O. Host election is
// the one piece of LAN logic where a mistake is invisible until someone's
// connection drops mid-match, so it lives where `node --test` can hammer it
// without a browser or a port.
//
// Host election rule: the surviving peer with the lowest join order. That is
// the oldest connection, which on a LAN is very likely the machine that
// started the server and is sitting next to the router.

import protocol from '../export/web/net/protocol.js';

/** Eight is the ceiling the protocol's bandwidth estimate was written against. */
export const MAX_PEERS = 8;

export class LanRoster {
  /**
   * @param {object} [options]
   * @param {() => number} [options.now] Injected clock, so tests own time.
   * @param {number} [options.maxPeers]
   */
  constructor({ now = () => Date.now(), maxPeers = MAX_PEERS } = {}) {
    this.now = now;
    this.maxPeers = maxPeers;
    // Monotonic for the life of the process. Ids are never recycled, because a
    // frame still in flight from a departed peer must not land on its
    // replacement's avatar.
    this.nextOrder = 1;
    this.byId = new Map();
  }

  /**
   * Admit a peer.
   *
   * Returns the peer record `{ id, name, joinedAt, order }`, or `null` when the
   * roster is already full. Null rather than a throw: a ninth person opening
   * the URL is an ordinary Tuesday, not an exceptional condition, and the
   * server's job is to answer them politely and close the socket.
   *
   * Callers that need to know whether this changed the host read `hostId`
   * before and after; a join only ever changes it from null to the new peer.
   */
  join(name) {
    if (this.byId.size >= this.maxPeers) return null;
    const order = this.nextOrder;
    this.nextOrder += 1;
    const peer = {
      id: `peer-${order}`,
      // The fallback carries the order so an unnamed lobby still reads as
      // distinct people rather than eight rows of PLAYER.
      name: protocol.sanitizeName(name, `PLAYER ${order}`),
      joinedAt: this.now(),
      order,
    };
    this.byId.set(peer.id, peer);
    return peer;
  }

  /** Remove a peer. Returns true when it was present. Compare `hostId` across
   * the call to detect a migration. */
  leave(peerId) {
    return this.byId.delete(peerId);
  }

  /** Apply a late `hello`. Returns the updated record, or null for a stranger. */
  rename(peerId, name) {
    const peer = this.byId.get(peerId);
    if (!peer) return null;
    peer.name = protocol.sanitizeName(name, peer.name);
    return peer;
  }

  get(peerId) {
    return this.byId.get(peerId) ?? null;
  }

  has(peerId) {
    return this.byId.has(peerId);
  }

  get size() {
    return this.byId.size;
  }

  get full() {
    return this.byId.size >= this.maxPeers;
  }

  /** Peers in join order, oldest first. */
  get peers() {
    return [...this.byId.values()].sort((a, b) => a.order - b.order);
  }

  /** The oldest surviving peer, or null when nobody is connected. */
  get hostId() {
    let host = null;
    for (const peer of this.byId.values()) {
      if (host === null || peer.order < host.order) host = peer;
    }
    return host ? host.id : null;
  }

  /** The `welcome` payload's roster: serialisable, ordered, host flagged. */
  roster() {
    const hostId = this.hostId;
    return this.peers.map((peer) => ({
      id: peer.id,
      name: peer.name,
      host: peer.id === hostId,
    }));
  }

  /** One roster entry, shaped exactly as `roster()` shapes it, for `peerJoined`. */
  entry(peerId) {
    const peer = this.byId.get(peerId);
    if (!peer) return null;
    return { id: peer.id, name: peer.name, host: peer.id === this.hostId };
  }
}

export default LanRoster;
