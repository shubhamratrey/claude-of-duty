// LAN game discovery: a UDP beacon, and a table of who else is on the WiFi.
//
// With one PlayOps app per Mac, the only way to reach a friend used to be
// typing or scanning their address. Every app is already on the same WiFi, so
// the lobby should simply list the games it can see.
//
// The mechanism is a 512-byte JSON beacon on UDP 8010 every two seconds. No
// mDNS and no dependency: broadcast is a few dozen lines, it is testable with
// no network at all, and a WiFi that isolates clients from each other blocks
// the game's own TCP connections too, so mDNS would buy nothing there.
//
// Two rules are worth stating out loud:
//   * Nothing in a beacon is trusted as an address. The datagram's own sender
//     address is the host; the payload only completes the URL with a port. A
//     payload that could name someone else's machine would be a redirect
//     anybody on the WiFi could hand out.
//   * The protocol version in the beacon decides compatibility, and an
//     incompatible game is listed without a Join button rather than hidden.
//     Two builds that cannot talk must never be allowed to try.
//
// Everything here is pure except `startDiscovery`, which takes `dgram`
// injected so the beacon interval, the receive path and `close()` are all
// provable without opening a port.

import nodeDgram from 'node:dgram';
import os from 'node:os';
import protocol from '../export/web/net/protocol.js';

/** The one port every PlayOps app listens on, whatever HTTP port it serves. */
export const DISCOVERY_PORT = 8010;

/** A row appears within about one beacon of a game opening. */
export const BEACON_INTERVAL_MS = 2000;

/** Three missed beacons. Long enough to ride out a dropped datagram. */
export const BEACON_TTL_MS = 6000;

/**
 * The size cap, enforced on both sides.
 *
 * Sending: a beacon must fit one datagram with room to spare, so it can never
 * be fragmented or silently dropped. Receiving: an open UDP port will be sent
 * whatever anyone feels like sending, and this is the cheapest way to refuse
 * to parse it.
 */
export const MAX_BEACON_BYTES = 512;

export const BEACON_APP = 'playops';

/** Names and versions get read aloud, not stored, so they stay short. */
const MAX_NAME_LENGTH = 40;
const MAX_VERSION_LENGTH = 24;
const MAX_ID_LENGTH = 32;

/** The limited broadcast address, which is the one every setup understands. */
export const LIMITED_BROADCAST = '255.255.255.255';

// Control characters would corrupt a terminal banner and a DOM text node
// alike, and a beacon is drawn straight into someone else's lobby.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]+/g;

const clean = (value, limit) => String(value ?? '')
  .replace(CONTROL_CHARACTERS, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, limit);

const isPort = (value) => Number.isInteger(value) && value >= 1 && value <= 65535;

/**
 * A beacon as bytes.
 *
 * Throws on fields that could not produce a joinable game -- a missing id, an
 * impossible port, a non-numeric protocol version -- because those are bugs in
 * the caller, not traffic from the network. A long hostname is trimmed instead:
 * a chatty Mac name must not be able to silence its own beacon.
 */
export function encodeBeacon(fields = {}) {
  const id = clean(fields.id, MAX_ID_LENGTH);
  if (!id) throw new TypeError('beacon needs an id');
  const port = Number(fields.port);
  if (!isPort(port)) throw new TypeError(`beacon needs a port, got ${fields.port}`);
  const v = Number(fields.v);
  if (!Number.isInteger(v)) throw new TypeError(`beacon needs an integer v, got ${fields.v}`);

  const beacon = {
    app: BEACON_APP,
    v,
    id,
    name: clean(fields.name, MAX_NAME_LENGTH),
    port,
    players: Math.max(0, Math.trunc(Number(fields.players) || 0)),
    version: clean(fields.version, MAX_VERSION_LENGTH),
  };
  const payload = Buffer.from(JSON.stringify(beacon), 'utf8');
  if (payload.length <= MAX_BEACON_BYTES) return payload;
  // Only the free-text fields can grow, so trimming the name is enough.
  const overflow = payload.length - MAX_BEACON_BYTES;
  beacon.name = beacon.name.slice(0, Math.max(0, beacon.name.length - overflow));
  return Buffer.from(JSON.stringify(beacon), 'utf8');
}

/**
 * A datagram as a beacon, or null.
 *
 * Null for anything that is not compact, valid JSON naming this app with an id
 * and a port. Null rather than a throw: an open UDP port receives whatever is
 * on the wire, and one stray datagram must not be able to end a match.
 */
export function decodeBeacon(payload) {
  const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload ?? ''), 'utf8');
  if (bytes.length === 0 || bytes.length > MAX_BEACON_BYTES) return null;

  let parsed;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (parsed.app !== BEACON_APP) return null;

  const id = clean(parsed.id, MAX_ID_LENGTH);
  const port = Number(parsed.port);
  const v = Number(parsed.v);
  if (!id || !isPort(port) || !Number.isInteger(v)) return null;

  // Rebuilt field by field: whatever else the sender put in the payload -- an
  // address, a URL, a hostname -- is dropped here and never reaches the table.
  return Object.freeze({
    app: BEACON_APP,
    v,
    id,
    name: clean(parsed.name, MAX_NAME_LENGTH),
    port,
    players: Math.max(0, Math.trunc(Number(parsed.players) || 0)),
    version: clean(parsed.version, MAX_VERSION_LENGTH),
  });
}

/**
 * A Mac's hostname, made readable.
 *
 * macOS turns "Shubham's MacBook" into `Shubhams-MacBook.local`, which is not
 * how anybody says it. This is only the fallback: a player who set a callsign
 * is announced by that instead.
 */
export function prettyHostName(hostname) {
  const bare = String(hostname ?? '').replace(/\.local\.?$/i, '').replace(/[-_]+/g, ' ');
  return clean(bare, MAX_NAME_LENGTH);
}

/** The broadcast address of one interface, or null if it has no usable pair. */
export function broadcastAddressFor(address, netmask) {
  const host = String(address ?? '').split('.').map(Number);
  const mask = String(netmask ?? '').split('.').map(Number);
  if (host.length !== 4 || mask.length !== 4) return null;
  const octet = (value) => Number.isInteger(value) && value >= 0 && value <= 255;
  if (!host.every(octet) || !mask.every(octet)) return null;
  return host.map((part, index) => (part | (~mask[index] & 255))).join('.');
}

/**
 * Every non-internal IPv4 interface's own broadcast address.
 *
 * Sent to alongside 255.255.255.255, because some macOS setups drop the
 * limited broadcast and pass the directed one.
 */
export function broadcastAddresses(interfaces = os.networkInterfaces()) {
  const found = new Set();
  for (const entries of Object.values(interfaces ?? {})) {
    for (const entry of entries ?? []) {
      if (!entry || entry.family !== 'IPv4' || entry.internal) continue;
      const broadcast = broadcastAddressFor(entry.address, entry.netmask);
      if (broadcast && broadcast !== LIMITED_BROADCAST) found.add(broadcast);
    }
  }
  return [...found];
}

/**
 * Who else is on the WiFi.
 *
 * Pure, with `now` injected: expiry is the one part of discovery where a
 * mistake shows up as a game that stays in the list after the laptop closed,
 * and that has to be provable without waiting six seconds.
 */
export class DiscoveryTable {
  /**
   * @param {object} [options]
   * @param {() => number} [options.now] Injected clock, so tests own time.
   * @param {number} [options.ttlMs] How long a row survives its last beacon.
   * @param {string|null} [options.selfId] This process's own beacon id.
   * @param {number} [options.protocolVersion] What this build can talk to.
   */
  constructor({
    now = () => Date.now(),
    ttlMs = BEACON_TTL_MS,
    selfId = null,
    protocolVersion = protocol.PROTOCOL_VERSION,
  } = {}) {
    this.now = now;
    this.ttlMs = ttlMs;
    this.selfId = selfId == null ? null : String(selfId);
    this.protocolVersion = protocolVersion;
    this.rows = new Map();
  }

  /**
   * Record a beacon seen from `fromAddress`. Returns whether it was kept.
   *
   * The address is the datagram's, never the payload's. A beacon with no
   * sender address is unreachable, so there is nothing to list.
   */
  observe(beacon, fromAddress) {
    if (!beacon || typeof beacon !== 'object') return false;
    const address = typeof fromAddress === 'string' ? fromAddress.trim() : '';
    if (!address) return false;
    // Your own game is not in the list; it is the thing you are already in.
    if (this.selfId !== null && beacon.id === this.selfId) return false;
    this.rows.set(beacon.id, {
      id: beacon.id,
      name: beacon.name,
      address,
      port: beacon.port,
      players: beacon.players,
      version: beacon.version,
      v: beacon.v,
      seenAt: this.now(),
    });
    return true;
  }

  get size() {
    return this.rows.size;
  }

  /** The list as the lobby draws it: sorted by name, expired rows dropped. */
  games() {
    const at = this.now();
    const games = [];
    for (const [id, row] of this.rows) {
      const ageMs = Math.max(0, Math.round(at - row.seenAt));
      if (ageMs >= this.ttlMs) {
        this.rows.delete(id);
        continue;
      }
      games.push({
        id,
        // A beacon with no name still has to be pickable out of a list.
        name: row.name || row.address,
        address: row.address,
        port: row.port,
        url: `http://${row.address}:${row.port}`,
        players: row.players,
        version: row.version,
        compatible: row.v === this.protocolVersion,
        ageMs,
      });
    }
    // Sorted by name so the list does not reshuffle under a cursor reaching
    // for a Join button; the id breaks ties between two identical Macs.
    games.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    return games;
  }
}

/**
 * Listen for beacons, and send one every `interval` while there is a game.
 *
 * The only impure part of discovery. `announce()` returns the beacon fields or
 * null -- null meaning an empty roster, so nobody is offered a ghost game --
 * and `dgram` and `timers` are injected so tests need no socket.
 *
 * A socket error is logged once and discovery degrades to "no list". It must
 * never take the game server with it: a denied local-network prompt or an
 * occupied port is a missing feature, not a crash.
 *
 * @returns {{ close(): void, announceOnce(): number, port: number, socket: object }}
 */
export function startDiscovery({
  port = DISCOVERY_PORT,
  interval = BEACON_INTERVAL_MS,
  announce = () => null,
  table = null,
  dgram = nodeDgram,
  address = null,
  // Normally the same port beacons are heard on: one shared port is what
  // makes discovery zero-config. Separable only for a loopback harness,
  // because macOS hands a unicast datagram on a shared port to exactly one
  // of the sockets bound to it -- a broadcast is what fans out.
  sendPort = port,
  interfaces = () => os.networkInterfaces(),
  log = () => {},
  timers = { setInterval, clearInterval },
} = {}) {
  let closed = false;
  let complained = false;

  // Once. A broken socket would otherwise log on every beacon, forever, which
  // is exactly the noise this project treats as a test failure.
  const degrade = (error, closeSocket = true) => {
    if (!complained) {
      complained = true;
      log(`[lan] discovery unavailable: ${error?.message ?? error}`);
    }
    if (!closeSocket) return;
    try {
      socket.close();
    } catch {
      // Already gone.
    }
  };

  // `reuseAddr` is what lets several servers on one Mac -- a test harness, a
  // stray second launch -- all listen on the shared port.
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  socket.on('error', (error) => degrade(error));
  socket.on('message', (payload, rinfo) => {
    try {
      table?.observe(decodeBeacon(payload), rinfo?.address);
    } catch (error) {
      degrade(error, false);
    }
  });

  // An explicit address unicasts there instead of broadcasting, which is how
  // a loopback harness runs several servers with no network involved.
  const targets = () => (address
    ? [String(address)]
    : [LIMITED_BROADCAST, ...broadcastAddresses(interfaces())]);

  const announceOnce = () => {
    if (closed) return 0;
    let fields;
    try {
      fields = announce();
    } catch (error) {
      degrade(error, false);
      return 0;
    }
    // Null is the empty roster: your beacon stops the moment you have no game
    // to offer, so nobody is invited into a ghost.
    if (!fields) return 0;

    let payload;
    try {
      payload = encodeBeacon(fields);
    } catch (error) {
      degrade(error, false);
      return 0;
    }

    let sent = 0;
    for (const target of new Set(targets())) {
      try {
        socket.send(payload, 0, payload.length, sendPort, target, (error) => {
          if (error) degrade(error, false);
        });
        sent += 1;
      } catch (error) {
        degrade(error, false);
      }
    }
    return sent;
  };

  try {
    socket.bind({ port, exclusive: false }, () => {
      if (closed) return;
      try {
        socket.setBroadcast?.(true);
      } catch (error) {
        degrade(error, false);
      }
    });
  } catch (error) {
    degrade(error);
  }

  const timer = timers.setInterval(announceOnce, interval);
  // Discovery is not a reason for the process to stay alive; the HTTP server is.
  timer?.unref?.();

  return {
    socket,
    port,
    sendPort,
    announceOnce,
    get targets() {
      return targets();
    },
    close() {
      if (closed) return;
      closed = true;
      timers.clearInterval(timer);
      try {
        socket.close();
      } catch {
        // Never bound, or already closed by an error.
      }
    },
  };
}

export default startDiscovery;
