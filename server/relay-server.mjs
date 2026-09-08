// Standalone relay for playing with people who are not on this WiFi.
//
// Sockets only: it serves no game assets and knows no game rules. Players load
// the page from wherever they like -- the public site, their own host, or a
// local `npm run lan` -- and point it at this.
//
// It terminates nothing. Run it behind cloudflared, Caddy, nginx, or nothing at
// all; the TLS story belongs to whatever is in front. That matters because a
// page served over HTTPS cannot open a plain ws:// socket, so anyone joining
// from the public site needs a wss:// URL, which a tunnel provides for free.
//
// It holds exactly one room. The first client to arrive creates it and is told
// the code; everyone after that has to produce the code. That is the whole
// access model, so be aware of what it does not do: a stranger who finds this
// URL while the relay is empty can occupy it and keep the intended host from
// creating a game. An unguessable hostname is the mitigation.

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { WebSocketServer } from 'ws';
import * as protocol from '../export/web/net/protocol.js';
import { RoomSlot } from './relay-room.mjs';
import {
  frameDisposition, lanAddresses,
} from './lan-server.mjs';

const HEALTH_PATH = '/relay/health';

/**
 * Evict sockets that stopped answering.
 *
 * A closed laptop or a phone that lost signal leaves its TCP connection
 * ESTABLISHED -- especially through a tunnel, which has its own keepalives to
 * the edge and cannot tell the browser behind it has gone. The relay would
 * never see a close event, and because it holds exactly one room, that zombie
 * does not merely occupy a slot: it keeps the room alive forever and nobody
 * else can open one.
 *
 * So every sweep asks each socket to prove it is there. A socket that has not
 * answered the previous ping is gone, whatever the kernel believes.
 *
 * @param {Iterable} clients live sockets
 * @param {(socket: any) => void} terminate
 * @param {(socket: any) => void} ping
 * @returns {{pinged: number, terminated: number}}
 */
export function sweepHeartbeat(clients, { terminate, ping } = {}) {
  let pinged = 0;
  let terminated = 0;
  for (const socket of clients ?? []) {
    if (socket.awaitingPong) {
      terminated += 1;
      terminate?.(socket);
      continue;
    }
    socket.awaitingPong = true;
    pinged += 1;
    ping?.(socket);
  }
  return { pinged, terminated };
}

export async function createRelayServer({
  port = 8787,
  host = '0.0.0.0',
  log = (line) => process.stdout.write(`${line}\n`),
  maxPeers = 8,
  joinTimeoutMs = 30000,
  hostSilenceMs = 6000,
  hostWatchIntervalMs = 1000,
  maxFramesPerSecond = 200,
  heartbeatMs = 30000,
} = {}) {
  const startedAt = performance.now();
  // Clients derive their clock offset from this, so it must be monotonic and
  // must not jump when the wall clock does.
  const serverTime = () => performance.now() - startedAt;

  const slot = new RoomSlot({ maxPeers });
  const stats = {
    relayed: 0, malformedDropped: 0, spoofedServerDropped: 0, hostOnlyDropped: 0,
    backpressureDropped: 0, slowPeersDropped: 0, rateLimited: 0,
    badCode: 0, joinTimeouts: 0, unadmittedDropped: 0, zombiesEvicted: 0,
  };

  // Admitted members, and sockets that have connected but not yet joined.
  const sockets = new Map(); // peerId -> ws
  const pending = new Set(); // ws (awaiting joinRoom)

  const server = http.createServer((request, response) => {
    const url = (request.url ?? '/').split('?')[0];
    if (url === HEALTH_PATH) {
      // Probed over HTTP before the socket is opened. Its real value is
      // diagnosis: pasting a non-relay URL answers wrong here instead of
      // hanging on "connecting", and a blocked mixed-content fetch throws where
      // a blocked mixed-content WebSocket would raise nothing at all.
      const body = JSON.stringify({ ...slot.describe(), serverTime: serverTime() });
      response.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        // The game is served from another origin, so the probe is cross-origin.
        'Access-Control-Allow-Origin': '*',
      });
      response.end(body);
      return;
    }
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('This is a Claude of Duty relay. It serves sockets, not the game.\n');
  });

  const wss = new WebSocketServer({ server, path: '/net' });

  // Backpressure, host liveness and message gating all behave exactly as they
  // do on the LAN server; the policy itself is imported rather than restated.
  const writeFrame = (peerId, socket, frame, type) => {
    if (!socket || socket.readyState !== socket.OPEN) return false;
    const disposition = frameDisposition(socket.bufferedAmount ?? 0, type);
    if (disposition === 'disconnect') {
      stats.slowPeersDropped += 1;
      log(`[relay] ! ${peerId ?? 'peer'} fell too far behind - disconnecting`);
      if (typeof socket.terminate === 'function') socket.terminate();
      else socket.close();
      return false;
    }
    if (disposition === 'drop') {
      stats.backpressureDropped += 1;
      return false;
    }
    try {
      socket.send(frame);
      return true;
    } catch {
      return false;
    }
  };

  const sendTo = (socket, type, data) =>
    writeFrame(null, socket, protocol.encode(type, data), type);

  const broadcast = (type, data, { exclude = null, from = null } = {}) => {
    const frame = protocol.encode(type, data, from);
    for (const [peerId, socket] of sockets) {
      if (peerId === exclude) continue;
      writeFrame(peerId, socket, frame, type);
    }
  };

  let lastHostFrameAt = null;
  const noteHostActivity = () => { lastHostFrameAt = serverTime(); };

  const checkHostLiveness = () => {
    const room = slot.room;
    if (!room || lastHostFrameAt === null || room.size < 2) return;
    if (serverTime() - lastHostFrameAt <= hostSilenceMs) return;
    const previous = room.hostId;
    const promoted = room.roster.promoteNext();
    if (!promoted || promoted === previous) return;
    lastHostFrameAt = null;
    log(`[relay] * ${previous} went quiet - host is now ${promoted}`);
    broadcast(protocol.MSG.HOST_CHANGED, { hostId: promoted });
  };

  const announceWelcome = (socket, room, peer) => {
    sendTo(socket, protocol.MSG.WELCOME, {
      peerId: peer.id,
      roomCode: room.code,
      hostId: room.hostId,
      roster: room.roster.roster(),
      serverTime: serverTime(),
    });
    broadcast(protocol.MSG.PEER_JOINED, { peer: room.roster.entry(peer.id) },
      { exclude: peer.id });
  };

  const admit = (socket, state, code) => {
    const result = slot.admit({ code, name: state.name });
    if (!result.ok) {
      if (result.reason === 'bad-code') stats.badCode += 1;
      sendTo(socket, protocol.MSG.ERROR, {
        message: describeRefusal(result.reason),
        reason: result.reason,
      });
      // A wrong code leaves the socket open so the player can simply retype it.
      // Anything else is terminal for this connection.
      if (result.reason !== 'bad-code') socket.close(1008, result.reason);
      return false;
    }

    pending.delete(socket);
    clearTimeout(state.joinTimer);
    state.peer = result.peer;
    sockets.set(result.peer.id, socket);
    announceWelcome(socket, result.room, result.peer);
    log(`[relay] + ${result.peer.id} ${result.created
      ? `opened room ${result.room.code}`
      : `joined room ${result.room.code}`} (${result.room.size} in room)`);
    return true;
  };

  const handleMessage = (socket, state, raw) => {
    const text = typeof raw === 'string' ? raw : raw.toString('utf8');

    // Cheap flood guard. A client sends about 21 frames a second; this is an
    // order of magnitude above that, and drops the excess rather than
    // disconnecting someone whose clock briefly ran fast.
    const second = Math.floor(serverTime() / 1000);
    if (state.window !== second) {
      state.window = second;
      state.frames = 0;
    }
    state.frames += 1;
    if (state.frames > maxFramesPerSecond) {
      stats.rateLimited += 1;
      return;
    }

    const frame = protocol.decode(text);
    if (!frame) {
      stats.malformedDropped += 1;
      return;
    }
    const { type, data } = frame;

    // A client claiming to be the server is a bug or a stale build. Relaying it
    // would let a guest fake a host migration.
    if (Object.values(protocol.SERVER_MESSAGES).includes(type)) {
      stats.spoofedServerDropped += 1;
      return;
    }

    if (type === protocol.MSG.HELLO) {
      state.name = protocol.sanitizeName(data.name, state.name);
      if (state.peer) {
        const updated = slot.room?.roster.rename(state.peer.id, state.name);
        if (updated) broadcast(protocol.MSG.PEER_JOINED, { peer: slot.room.roster.entry(state.peer.id) });
      }
      return;
    }

    if (type === protocol.MSG.JOIN_ROOM) {
      if (state.peer) return; // already in; a second joinRoom is meaningless
      state.name = protocol.sanitizeName(data.name, state.name);
      admit(socket, state, data.code);
      return;
    }

    if (!state.peer) {
      // Nothing else means anything before admission, and acting on it would be
      // a way to use the relay without being in the game.
      stats.unadmittedDropped += 1;
      return;
    }

    if (type === protocol.MSG.PING) {
      sendTo(socket, protocol.MSG.PONG, {
        clientTime: data.clientTime,
        serverTime: serverTime(),
      });
      return;
    }

    if (protocol.HOST_ONLY.has(type) && slot.room?.hostId !== state.peer.id) {
      stats.hostOnlyDropped += 1;
      return;
    }
    if (protocol.HOST_ONLY.has(type)) noteHostActivity();

    stats.relayed += 1;
    broadcast(type, data, { exclude: state.peer.id, from: state.peer.id });
  };

  wss.on('connection', (socket) => {
    const state = { peer: null, name: '', frames: 0, window: -1, joinTimer: null };
    pending.add(socket);

    // Pasting the URL is the create action: an empty relay admits the first
    // arrival with no code and no button to press. Otherwise it is told a game
    // is in progress and waits for the code.
    if (!slot.occupied) {
      admit(socket, state, null);
    } else {
      sendTo(socket, protocol.MSG.ROOM_REQUIRED, {});
      state.joinTimer = setTimeout(() => {
        if (state.peer) return;
        stats.joinTimeouts += 1;
        pending.delete(socket);
        socket.close(1008, 'join timeout');
      }, joinTimeoutMs);
      state.joinTimer.unref?.();
    }

    socket.on('message', (raw) => {
      try {
        handleMessage(socket, state, raw);
      } catch (error) {
        // One peer's bad frame is not everyone else's problem.
        stats.malformedDropped += 1;
        log(`[relay] ! message failed: ${error?.message ?? error}`);
      }
    });

    // Answering a ping is the only evidence that anyone is still on the far
    // end of this socket.
    socket.awaitingPong = false;
    socket.on('pong', () => { socket.awaitingPong = false; });

    socket.on('error', () => {
      // 'close' always follows, so cleanup happens there exactly once.
    });

    socket.on('close', () => {
      clearTimeout(state.joinTimer);
      pending.delete(socket);
      if (!state.peer) return;

      const hostWas = slot.room?.hostId ?? null;
      sockets.delete(state.peer.id);
      slot.remove(state.peer.id);
      broadcast(protocol.MSG.PEER_LEFT, { peerId: state.peer.id });
      const remaining = slot.room?.size ?? 0;
      log(`[relay] - ${state.peer.id} left (${remaining} in room)`);

      if (!slot.occupied) {
        // The room emptied, so its code is gone with it and the next arrival
        // starts a fresh game.
        lastHostFrameAt = null;
        log('[relay] * room closed');
        return;
      }
      const hostNow = slot.room.hostId;
      if (hostNow !== hostWas) {
        lastHostFrameAt = null;
        log(`[relay] * host is now ${hostNow}`);
        broadcast(protocol.MSG.HOST_CHANGED, { hostId: hostNow });
      }
    });
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.removeListener('error', onError);
      resolve();
    });
  });

  const watchdog = setInterval(checkHostLiveness, hostWatchIntervalMs);
  watchdog.unref?.();

  const runHeartbeat = () => {
    const result = sweepHeartbeat(wss.clients, {
      ping: (socket) => { try { socket.ping(); } catch { /* close will follow */ } },
      terminate: (socket) => {
        stats.zombiesEvicted += 1;
        log('[relay] ! a client stopped answering - dropping it');
        socket.terminate();
      },
    });
    return result;
  };
  const heartbeat = setInterval(runHeartbeat, heartbeatMs);
  heartbeat.unref?.();

  const address = server.address();
  const boundPort = typeof address === 'object' && address ? address.port : port;
  const reachable = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;

  return {
    server,
    wss,
    slot,
    stats,
    port: boundPort,
    url: `http://${reachable}:${boundPort}`,
    wsUrl: `ws://${reachable}:${boundPort}/net`,
    healthUrl: `http://${reachable}:${boundPort}${HEALTH_PATH}`,
    serverTime,
    checkHostLiveness,
    runHeartbeat,
    async close() {
      clearInterval(watchdog);
      clearInterval(heartbeat);
      for (const socket of wss.clients) socket.terminate();
      await new Promise((resolve) => wss.close(resolve));
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function describeRefusal(reason) {
  if (reason === 'bad-code') return 'That code does not match the room on this relay.';
  if (reason === 'room-full') return 'That room is full.';
  if (reason === 'no-room') return 'That room has closed. Reconnect to start a new one.';
  return 'The relay refused the connection.';
}

function banner(port) {
  const lines = [
    'Claude of Duty — relay',
    '',
    `  Listening on :${port} (sockets only; it does not serve the game)`,
    '',
    '  Share one of these with your players:',
    `    http://localhost:${port}`,
  ];
  for (const address of lanAddresses()) {
    lines.push(`    http://${address}:${port}`);
  }
  lines.push(
    '',
    '  Reachable from the internet? Put a tunnel in front and share its URL:',
    `    cloudflared tunnel --url http://localhost:${port}`,
    '',
    '  Players paste that URL into the game. The first one to arrive opens the',
    '  room and is given a code; everyone else types the code to join.',
    '',
    '  Anyone who reaches this relay while it is empty can take the room, and',
    '  anyone in the room is trusted about the shots they claim. Play with',
    '  people you know.',
  );
  return lines.join('\n');
}

// Direct execution: `node server/relay-server.mjs [port]`.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const port = Number(process.env.PORT ?? process.argv[2] ?? 8787);
  const relay = await createRelayServer({ port });
  process.stdout.write(`${banner(relay.port)}\n\n`);
  const shutdown = () => { relay.close().finally(() => process.exit(0)); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

export default createRelayServer;
