// The LAN listen server: static files plus a dumb relay on /net.
//
// This process replaces `python -m http.server` for multiplayer. It holds no
// game rules at all — it hands out peer ids, keeps join order, names the oldest
// peer host, and forwards frames. Every rule about damage, death and scoring
// lives in the browser, which is what keeps this file small enough to trust.
//
// Two invariants are worth stating out loud:
//   * `from` on a relayed frame is always stamped here from the socket's own
//     peer id. A client's own `from` is discarded, so nobody can speak as
//     someone else even by accident after a reconnect.
//   * A throw while handling one socket is caught at the socket boundary. One
//     peer on a stale build must never be able to end everyone else's match.

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import protocol from '../export/web/net/protocol.js';
import { LanRoster } from './lan-roster.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(here, '..', 'export', 'web');

// Extends the map in .tools/ai-game.mjs. The design calls for that map to be
// extracted into a shared module; doing so means editing the harness, so the
// superset lives here until that refactor lands. Anything missing serves as
// application/octet-stream, which browsers refuse to execute as a module — so
// a missing script type shows up as a hard console error rather than silently
// wrong behaviour.
export const MIME_TYPES = new Map([
  ['.bin', 'application/octet-stream'],
  ['.css', 'text/css; charset=utf-8'],
  ['.glb', 'model/gltf-binary'],
  ['.gltf', 'model/gltf+json'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.ktx2', 'image/ktx2'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.mp3', 'audio/mpeg'],
  ['.mp4', 'video/mp4'],
  ['.ogg', 'audio/ogg'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.wasm', 'application/wasm'],
  ['.wav', 'audio/wav'],
  ['.webm', 'video/webm'],
  ['.webmanifest', 'application/manifest+json'],
  ['.webp', 'image/webp'],
]);

export const contentTypeFor = (filename) =>
  MIME_TYPES.get(path.extname(filename).toLowerCase()) ?? 'application/octet-stream';

/**
 * Resolve a URL path to a file inside `root`, or null if it escapes.
 *
 * `path.resolve` collapses `..` before the prefix check, so `/../package.json`
 * and its encoded spellings resolve outside the root and are rejected here
 * rather than being read and served.
 */
export function resolveStaticPath(root, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  const relative = decoded === '/' || decoded.endsWith('/') ? `${decoded}index.html` : decoded;
  const filename = path.resolve(root, `.${relative}`);
  if (filename !== root && !filename.startsWith(`${root}${path.sep}`)) return null;
  return filename;
}

/**
 * `<hostname>.local`, the Bonjour name macOS already publishes for this Mac.
 *
 * Friendlier to read out than four numbers and a colon, and every Mac, iPhone
 * and iPad on the WiFi resolves it with no setup. Returns null when there is no
 * name to publish, so callers can fall back to the numeric address rather than
 * printing `http://.local:8000`.
 */
export function bonjourHostname(hostname = os.hostname()) {
  const trimmed = String(hostname ?? '').trim().replace(/\.+$/, '');
  const base = trimmed.replace(/\.local$/i, '');
  if (base.length === 0) return null;
  return `${base.toLowerCase()}.local`;
}

/** Non-internal IPv4 addresses, which are the ones worth reading aloud. */
export function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((entry) => entry && entry.family === 'IPv4' && !entry.internal)
    .map((entry) => entry.address);
}

function serveStatic(root, request, response) {
  const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
  const filename = resolveStaticPath(root, requestUrl.pathname);
  if (filename === null) {
    response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Forbidden');
    return;
  }
  fs.stat(filename, (error, stat) => {
    if (error || !stat.isFile()) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }
    response.writeHead(200, {
      'Content-Type': contentTypeFor(filename),
      'Content-Length': stat.size,
      // A LAN match is usually someone iterating on the game with friends
      // watching, so a stale cached bundle costs more than the bytes do.
      'Cache-Control': 'no-store',
    });
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    const stream = fs.createReadStream(filename);
    stream.on('error', () => response.destroy());
    stream.pipe(response);
  });
}

/**
 * Boot the LAN server.
 *
 * Resolves to `{ server, wss, roster, url, wsUrl, stats, close }`. Pass
 * `port: 0` to let the OS choose, which is how the tests get isolation.
 */
/**
 * Message types that may be dropped when a peer's socket is congested.
 *
 * These are all snapshots of current state: the next one completely supersedes
 * the last, so a congested peer is better served by skipping to the present
 * than by receiving a faithful queue of history. Events -- a hit, a death, a
 * join -- happened once and cannot be reconstructed from a later frame, so
 * they are never dropped.
 */
export const DROPPABLE_TYPES = Object.freeze(new Set([
  protocol.MSG.PLAYER_STATE,
  protocol.MSG.BOT_STATE,
  protocol.MSG.MATCH_STATE,
  protocol.MSG.WEAPON_FIRE,
]));

/** Roughly a second of snapshots. Past this, stale state is worse than none. */
export const DROP_ABOVE_BYTES = 64 * 1024;

/**
 * Past this a peer is not keeping up with even the reliable traffic. Cutting it
 * loose reclaims the memory and lets its own reconnect give it a clean start,
 * which serves the other players far better than carrying it.
 */
export const DISCONNECT_ABOVE_BYTES = 1024 * 1024;

/** What to do with one outbound frame, given how much is already queued. */
export function frameDisposition(bufferedAmount, type,
  { dropAbove = DROP_ABOVE_BYTES, disconnectAbove = DISCONNECT_ABOVE_BYTES } = {}) {
  const buffered = Number(bufferedAmount) || 0;
  if (buffered > disconnectAbove) return 'disconnect';
  if (buffered > dropAbove && DROPPABLE_TYPES.has(type)) return 'drop';
  return 'send';
}

export async function createLanServer({
  port = 8000,
  root = DEFAULT_ROOT,
  host = '0.0.0.0',
  log = (line) => process.stdout.write(`${line}\n`),
  hostSilenceMs = 6000,
  hostWatchIntervalMs = 1000,
} = {}) {
  const startedAt = performance.now();
  // Clients derive their clock offset from this, so it must be monotonic and
  // must not jump when the wall clock does.
  const serverTime = () => performance.now() - startedAt;

  const roster = new LanRoster();
  const stats = {
    hostOnlyDropped: 0, malformedDropped: 0, spoofedServerDropped: 0, relayed: 0,
    backpressureDropped: 0, slowPeersDropped: 0,
  };
  const sockets = new Map(); // peerId -> WebSocket

  // Host liveness.
  //
  // The host owns the bots and the match clock, so a host that stops
  // simulating freezes the world for everyone while still holding the role --
  // and nothing else notices, because its socket is fine and the snapshots the
  // relay drops for it are the only pressure it was under. Silence on the
  // host-only channel is the one signal that distinguishes "hosting" from
  // "holding the title". Watching for it is what lets the match survive a
  // laptop that went to sleep with the tab open.
  let lastHostFrameAt = null;
  let watchdog = null;

  const noteHostActivity = () => { lastHostFrameAt = serverTime(); };

  // Only ever measured against a host that has already broadcast at least once.
  // A freshly joined host spends a long time loading 40 MB of map before its
  // first botState, and demoting it mid-load would replace it with someone who
  // is equally not ready.
  const checkHostLiveness = () => {
    if (lastHostFrameAt === null || roster.size < 2) return;
    if (serverTime() - lastHostFrameAt <= hostSilenceMs) return;
    const previous = roster.hostId;
    const promoted = roster.promoteNext();
    if (!promoted || promoted === previous) return;
    const quiet = ((serverTime() - lastHostFrameAt) / 1000).toFixed(1);
    lastHostFrameAt = null;
    log(`[lan] * ${previous} went quiet for ${quiet}s - host is now ${promoted}`);
    broadcast(protocol.MSG.HOST_CHANGED, { hostId: promoted });
  };

  const server = http.createServer((request, response) => {
    try {
      // A cheap "is there a LAN server here?" probe. The game asks before it
      // opens a socket, because a plain static server (python -m http.server,
      // or the test harness) would answer a WebSocket upgrade with a 404 and
      // the client would log a console error every retry, forever.
      if (request.url === '/net/health') {
        // The join URL has to come from the server. A player on the host
        // machine sees location.origin as localhost, which is exactly the one
        // address nobody else can use, so the panel would tell them to read
        // out a link that does not work.
        const addresses = lanAddresses();
        const listenPort = server.address()?.port ?? port;
        const body = JSON.stringify({
          lan: true,
          peers: roster.peers.length,
          hostId: roster.hostId,
          serverTime: serverTime(),
          joinUrl: addresses.length ? `http://${addresses[0]}:${listenPort}` : null,
          // The .local name goes last: it is the nicest one to read out, but
          // it is also the one most likely to be missing or wrong, so a
          // consumer taking the first entry still gets a numeric address.
          joinUrls: [
            ...addresses.map((address) => `http://${address}:${listenPort}`),
            ...(addresses.length > 0 && bonjourHostname()
              ? [`http://${bonjourHostname()}:${listenPort}`] : []),
          ],
        });
        response.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        response.end(body);
        return;
      }
      serveStatic(root, request, response);
    } catch {
      if (!response.headersSent) response.writeHead(500);
      response.end('Server error');
    }
  });

  const wss = new WebSocketServer({ server, path: '/net' });

  // Backpressure.
  //
  // One stalled laptop must not slow the room down. A tab that is mid-GC,
  // backgrounded, or just on weak hardware stops draining its TCP socket; the
  // kernel window closes and every `socket.send()` for it starts piling up in
  // this process's memory. Left alone, that queue grows without bound at 20 Hz
  // per peer, and the relay everyone else depends on ends up spending its time
  // managing one dead client's backlog. The symptom is exactly the one you hit:
  // one slow machine, everybody slow.
  //
  // The fix rests on what these messages mean. A state snapshot is idempotent
  // -- the next one completely supersedes it -- so a slow peer is better served
  // by DROPPING stale frames and sending it the current world 50 ms later than
  // by faithfully delivering a queue of history it no longer cares about.
  // Events are different: a hit or a death happened once and cannot be
  // reconstructed from a later frame, so those are always queued.
  const writeFrame = (peerId, socket, frame, type) => {
    if (!socket || socket.readyState !== socket.OPEN) return false;
    const disposition = frameDisposition(socket.bufferedAmount ?? 0, type);
    if (disposition === 'disconnect') {
      stats.slowPeersDropped += 1;
      const queued = Math.round((socket.bufferedAmount ?? 0) / 1024);
      log(`[lan] ! ${peerId ?? 'peer'} fell too far behind (${queued} KB queued) - disconnecting`);
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
      // A send failing means that socket is going away; its 'close' handler
      // does the roster bookkeeping. Nothing to do here.
      return false;
    }
  };

  const send = (socket, type, data) => {
    writeFrame(socketPeerId(socket), socket, protocol.encode(type, data), type);
  };

  const broadcast = (type, data, { exclude = null, from = null } = {}) => {
    const frame = protocol.encode(type, data, from);
    for (const [peerId, socket] of sockets) {
      if (peerId === exclude) continue;
      writeFrame(peerId, socket, frame, type);
    }
  };

  const socketPeerId = (socket) => {
    for (const [peerId, candidate] of sockets) if (candidate === socket) return peerId;
    return null;
  };

  const handleMessage = (peer, raw) => {
    const text = typeof raw === 'string' ? raw : raw.toString('utf8');
    const frame = protocol.decode(text);
    if (!frame) {
      stats.malformedDropped += 1;
      return;
    }
    const { type, data } = frame;

    // A client claiming to be the server is either a bug or a stale build.
    // Relaying it would let a guest fake a host migration.
    if (Object.values(protocol.SERVER_MESSAGES).includes(type)) {
      stats.spoofedServerDropped += 1;
      return;
    }

    if (type === protocol.MSG.PING) {
      send(sockets.get(peer.id), protocol.MSG.PONG, {
        clientTime: data.clientTime,
        serverTime: serverTime(),
      });
      return;
    }

    if (type === protocol.MSG.HELLO) {
      const updated = roster.rename(peer.id, data.name);
      if (!updated) return;
      log(`[lan] ${peer.id} is ${updated.name}`);
      // peerJoined is upsert-shaped on the client, so the same message that
      // announced this peer also carries its real name once it arrives.
      broadcast(protocol.MSG.PEER_JOINED, { peer: roster.entry(peer.id) });
      return;
    }

    if (protocol.HOST_ONLY.has(type) && roster.hostId !== peer.id) {
      stats.hostOnlyDropped += 1;
      return;
    }
    if (protocol.HOST_ONLY.has(type)) noteHostActivity();

    stats.relayed += 1;
    broadcast(type, data, { exclude: peer.id, from: peer.id });
  };

  wss.on('connection', (socket) => {
    const peer = roster.join('');
    if (!peer) {
      send(socket, protocol.MSG.ERROR, { message: 'match full' });
      socket.close(1013, 'match full');
      return;
    }
    sockets.set(peer.id, socket);

    send(socket, protocol.MSG.WELCOME, {
      peerId: peer.id,
      hostId: roster.hostId,
      roster: roster.roster(),
      serverTime: serverTime(),
    });
    broadcast(protocol.MSG.PEER_JOINED, { peer: roster.entry(peer.id) }, { exclude: peer.id });
    log(`[lan] + ${peer.id} joined as ${peer.name} (${roster.size} in match, ` +
      `host ${roster.hostId})`);

    socket.on('message', (raw) => {
      try {
        handleMessage(peer, raw);
      } catch (error) {
        // One peer's bad frame is not everyone else's problem.
        stats.malformedDropped += 1;
        log(`[lan] ! ${peer.id} message failed: ${error?.message ?? error}`);
      }
    });

    socket.on('error', () => {
      // 'close' always follows, so cleanup happens there exactly once.
    });

    socket.on('close', () => {
      const hostWas = roster.hostId;
      sockets.delete(peer.id);
      roster.leave(peer.id);
      broadcast(protocol.MSG.PEER_LEFT, { peerId: peer.id });
      log(`[lan] - ${peer.id} left (${roster.size} in match)`);
      const hostNow = roster.hostId;
      if (hostNow !== hostWas) {
        // The incoming host must not inherit the outgoing one's silence.
        lastHostFrameAt = null;
        log(`[lan] * host is now ${hostNow ?? 'nobody'}`);
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

  watchdog = setInterval(checkHostLiveness, hostWatchIntervalMs);
  watchdog.unref?.();

  const address = server.address();
  const boundPort = typeof address === 'object' && address ? address.port : port;
  // 0.0.0.0 is a bind address, not something you can type into a browser.
  const reachable = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  const url = `http://${reachable}:${boundPort}`;

  return {
    server,
    wss,
    roster,
    stats,
    port: boundPort,
    url,
    wsUrl: `ws://${reachable}:${boundPort}/net`,
    serverTime,
    checkHostLiveness,
    async close() {
      clearInterval(watchdog);
      for (const socket of wss.clients) socket.terminate();
      await new Promise((resolve) => wss.close(resolve));
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function banner(port) {
  const lines = [
    'Claude of Duty — LAN server',
    `  Local    http://localhost:${port}`,
  ];
  const addresses = lanAddresses();
  for (const address of addresses) {
    lines.push(`  LAN      http://${address}:${port}   <- share this on the WiFi`);
  }
  if (addresses.length === 0) {
    lines.push('  LAN      (no non-internal IPv4 interface found — check the WiFi)');
  }
  return lines.join('\n');
}

// Direct execution: `node server/lan-server.mjs [port]`.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const port = Number(process.env.PORT ?? process.argv[2] ?? 8000);
  const lan = await createLanServer({ port });
  process.stdout.write(`${banner(lan.port)}\n\n`);
  const shutdown = () => {
    lan.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

export default createLanServer;
