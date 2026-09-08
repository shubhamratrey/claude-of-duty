// WebSocket transport for LAN multiplayer: connection, identity, clock sync,
// and reconnection. It holds no game rules — routing messages into the game is
// net-session's job.
//
// The socket class is injectable so this file can be exercised in Node against
// a stub. Everything that touches the network goes through `WebSocketImpl` and
// `now`, which is what makes the reconnect and clock-sync logic testable
// without a browser or a server.
//
// Clock unit on the wire is MILLISECONDS — `welcome.serverTime`,
// `ping.clientTime`, and `pong.serverTime` all match `performance.now()`'s
// unit. `hostTimeSeconds()` converts once, at the edge, because
// SnapshotBuffer works in seconds.

import { MSG, decode, encode, sanitizeName } from './protocol.js';

const SOCKET_OPEN = 1;
const PING_INTERVAL_MS = 2000;
const RECONNECT_BASE_MS = 250;
const RECONNECT_CAP_MS = 5000;
const CLOCK_SAMPLES = 5;
const MS_PER_SECOND = 1000;

/** Events that are not protocol messages but can still be subscribed to. */
export const LIFECYCLE_EVENTS = Object.freeze([
  'open', 'close', 'error', 'statechange',
]);

// Node timers keep the process alive; browser ones return a bare number. An
// unreffed ping loop means a test that forgets to close still exits.
const unref = (timer) => {
  if (timer && typeof timer.unref === 'function') timer.unref();
  return timer;
};

const defaultUrl = () => {
  const location = globalThis.location;
  if (!location?.host) return 'ws://localhost:8000/net';
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${location.host}/net`;
};

/** Snapshots may be skipped while this socket is congested; events may not. */
const DROPPABLE_TYPES = new Set([
  MSG.PLAYER_STATE, MSG.BOT_STATE, MSG.MATCH_STATE, MSG.WEAPON_FIRE,
]);

/** About a second of outbound snapshots. Mirrors the relay's own threshold. */
const DROP_ABOVE_BYTES = 64 * 1024;

export class NetClient {
  constructor({
    url = defaultUrl(),
    name = 'PLAYER',
    WebSocketImpl = globalThis.WebSocket,
    now = () => performance.now(),
    reconnect = true,
  } = {}) {
    this.url = url;
    this.name = sanitizeName(name);
    this.WebSocketImpl = WebSocketImpl;
    this.now = now;
    this.reconnect = Boolean(reconnect);

    this.socket = null;
    this.handlers = new Map();
    this.peerId = null;
    this.hostId = null;
    this.roster = new Map();
    this.droppedFrames = 0;
    this.droppedOutbound = 0;

    this.clockSamples = [];
    this.offsetMs = 0;
    this.bestRttMs = null;

    this.pingTimer = null;
    this.reconnectTimer = null;
    this.reconnectDelayMs = RECONNECT_BASE_MS;
  }

  get connected() {
    return this.socket?.readyState === SOCKET_OPEN;
  }

  get isHost() {
    return Boolean(this.peerId) && this.peerId === this.hostId;
  }

  get role() {
    if (!this.peerId || !this.hostId) return null;
    return this.isHost ? 'host' : 'guest';
  }

  get rttMs() {
    return this.bestRttMs;
  }

  on(type, handler) {
    if (typeof handler !== 'function') return this;
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type).add(handler);
    return this;
  }

  off(type, handler) {
    this.handlers.get(type)?.delete(handler);
    return this;
  }

  emit(type, data = null, from = null) {
    for (const handler of this.handlers.get(type) ?? []) {
      // One listener throwing must not stop the others or kill the socket.
      try {
        handler(data, from);
      } catch (error) {
        console.error(`net-client handler for ${type} threw`, error);
      }
    }
  }

  connect() {
    if (!this.WebSocketImpl) throw new Error('net-client: no WebSocket implementation');
    if (this.socket && this.socket.readyState <= SOCKET_OPEN) return this;
    this.clearReconnect();

    const socket = new this.WebSocketImpl(this.url);
    this.socket = socket;
    socket.onopen = () => this.handleOpen(socket);
    socket.onmessage = (event) => this.handleMessage(event);
    socket.onclose = (event) => this.handleClose(socket, event);
    socket.onerror = (event) => this.emit('error', event);
    return this;
  }

  /** Stop reconnecting and drop the socket. The counterpart to `connect()`. */
  close() {
    this.reconnect = false;
    this.clearReconnect();
    this.stopPing();
    const socket = this.socket;
    this.socket = null;
    try {
      socket?.close();
    } catch {
      // A socket that is already closing throws on some implementations.
    }
    this.forgetIdentity();
    this.emit('close', { code: null, reason: 'closed by client' });
    this.emit('statechange', this.getState());
  }

  /**
   * Encode and send. A dropped frame is a normal outcome — at 20 Hz the next
   * snapshot is 50 ms away — so a closed socket is a silent no-op rather than
   * an exception every tick.
   *
   * Outbound congestion is handled the same way the relay handles it. If this
   * machine stalls — a GC pause, a backgrounded tab, weak hardware — the socket
   * stops draining and every snapshot piles into memory behind it. Since a
   * newer snapshot completely supersedes an older one, queueing them is worse
   * than useless: on recovery the peer would replay a backlog of stale
   * positions before reaching the present. So snapshots are dropped while
   * congested and events are always queued.
   */
  send(type, data = {}) {
    if (!this.connected) return false;
    if (DROPPABLE_TYPES.has(type) && (this.socket.bufferedAmount ?? 0) > DROP_ABOVE_BYTES) {
      this.droppedOutbound += 1;
      return false;
    }
    try {
      this.socket.send(encode(type, data));
      return true;
    } catch (error) {
      this.emit('error', error);
      return false;
    }
  }

  handleOpen(socket) {
    if (socket !== this.socket) return;
    this.reconnectDelayMs = RECONNECT_BASE_MS;
    this.send(MSG.HELLO, { name: this.name });
    this.sendPing();
    this.startPing();
    this.emit('open');
    this.emit('statechange', this.getState());
  }

  handleClose(socket, event = {}) {
    if (socket !== this.socket) return;
    this.socket = null;
    this.stopPing();
    this.forgetIdentity();
    this.emit('close', { code: event.code ?? null, reason: event.reason ?? '' });
    this.emit('statechange', this.getState());
    this.scheduleReconnect();
  }

  handleMessage(event) {
    const message = decode(typeof event?.data === 'string' ? event.data : event);
    if (!message) {
      // A peer on a stale build must not be able to end anyone else's match.
      this.droppedFrames += 1;
      return;
    }
    const { type, data, from } = message;
    const identityChanged = this.applyIdentity(type, data);
    this.emit(type, data, from);
    if (identityChanged) this.emit('statechange', this.getState());
  }

  /** Track who we are, who is host, and who else is here. Returns true on change. */
  applyIdentity(type, data) {
    switch (type) {
      case MSG.WELCOME:
        this.peerId = data.peerId;
        this.hostId = data.hostId;
        this.roster = new Map(data.roster
          .filter((peer) => peer && typeof peer.id === 'string')
          .map((peer) => [peer.id, { id: peer.id, name: sanitizeName(peer.name) }]));
        // A rough offset immediately, so hostTimeSeconds() is usable before
        // the first pong. It assumes zero latency, which on a LAN is wrong by
        // under a millisecond and is replaced by the first real sample.
        this.offsetMs = data.serverTime - this.now();
        break;
      case MSG.PEER_JOINED:
        this.roster.set(data.peer.id, {
          id: data.peer.id,
          name: sanitizeName(data.peer.name),
        });
        break;
      case MSG.PEER_LEFT:
        this.roster.delete(data.peerId);
        break;
      case MSG.HOST_CHANGED:
        this.hostId = data.hostId;
        break;
      case MSG.PONG:
        this.applyPong(data);
        return false;
      default:
        return false;
    }
    return true;
  }

  forgetIdentity() {
    // A reconnect is a new peer with a new id, so nothing here survives a
    // close — in particular a disconnected guest must never still read as host.
    this.peerId = null;
    this.hostId = null;
    this.roster.clear();
    this.clockSamples.length = 0;
    this.bestRttMs = null;
  }

  startPing() {
    this.stopPing();
    this.pingTimer = unref(setInterval(() => this.sendPing(), PING_INTERVAL_MS));
  }

  stopPing() {
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  sendPing() {
    this.send(MSG.PING, { clientTime: this.now() });
  }

  /**
   * Standard NTP-style estimate: the reply is assumed to have taken half the
   * round trip, so the server clock read `serverTime + rtt / 2` at the moment
   * it arrived here.
   *
   * The kept estimate is the one from the lowest-RTT sample of the last few
   * rather than an average. A slow reply is late by an unknown, asymmetric
   * amount, so averaging folds that error in; the fastest sample is the one
   * whose symmetry assumption is most nearly true, and on a LAN a good sample
   * turns up within a couple of pings.
   */
  applyPong({ clientTime, serverTime }) {
    const received = this.now();
    const rtt = Math.max(0, received - clientTime);
    this.clockSamples.push({ rtt, offset: serverTime + rtt / 2 - received });
    if (this.clockSamples.length > CLOCK_SAMPLES) this.clockSamples.shift();

    let best = this.clockSamples[0];
    for (const sample of this.clockSamples) if (sample.rtt < best.rtt) best = sample;
    this.offsetMs = best.offset;
    this.bestRttMs = best.rtt;
  }

  /** Current estimate of the server clock, in seconds — SnapshotBuffer's unit. */
  hostTimeSeconds() {
    return (this.now() + this.offsetMs) / MS_PER_SECOND;
  }

  scheduleReconnect() {
    if (!this.reconnect || this.reconnectTimer !== null) return;
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(delay * 2, RECONNECT_CAP_MS);
    this.reconnectTimer = unref(setTimeout(() => {
      this.reconnectTimer = null;
      if (this.reconnect) this.connect();
    }, delay));
  }

  clearReconnect() {
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  /** Compact and serialisable, for `hijacked.debug.getState().net`. */
  getState() {
    return {
      connected: this.connected,
      peerId: this.peerId,
      hostId: this.hostId,
      role: this.role,
      rttMs: this.bestRttMs === null ? null : Math.round(this.bestRttMs),
      peers: [...this.roster.values()].map(({ id, name }) => ({ id, name })),
      droppedFrames: this.droppedFrames,
      droppedOutbound: this.droppedOutbound,
    };
  }
}

export default NetClient;
