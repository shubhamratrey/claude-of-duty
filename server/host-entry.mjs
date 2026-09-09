// The packaged Mac host: everything the LAN server needs to be double-clickable.
//
// This file is bundled into `PlayOps.app/Contents/MacOS/playops-server` by
// `.tools/package_mac.mjs` using Node's Single Executable Application feature.
// Two consequences shape the whole file:
//
//   * Inside a SEA there is no `__dirname` and no meaningful `import.meta.url`
//     — the script is a resource inside the executable, not a file on disk. The
//     only reliable anchor is `process.execPath`, so the game directory is
//     resolved from that and from nothing else.
//   * The host double-clicks an icon. There is no terminal to read an error
//     out of unless we put one there, and no chance to pass a flag. So the
//     defaults have to be right: port 8000 with a fallback, a banner with a QR
//     code, LAN discovery announcing the game, and the browser opened
//     automatically.
//
// Everything that can be decided without touching the network or the disk is
// an exported pure function, because that is the part worth unit testing; the
// build takes minutes and cannot be part of `npm run test:unit`.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import qrcode from 'qrcode-terminal';
import { bonjourHostname, createLanServer, lanAddresses } from './lan-server.mjs';

// Re-exported so the host's whole vocabulary is importable from one place.
export { bonjourHostname };

/** Port 8000 is what every note, screenshot and README in this repo says. */
export const DEFAULT_PORT = 8000;

/**
 * How many ports to try before giving up. Ten is enough to step over a stray
 * `npm run lan`, a Python server and a couple of dev servers; past that the
 * machine has a problem the host should be told about rather than worked around.
 */
export const PORT_ATTEMPTS = 10;

/** True when the game lives in this directory. */
const hasGame = (dir) => {
  try {
    return fs.statSync(path.join(dir, 'index.html')).isFile();
  } catch {
    return false;
  }
};

/**
 * Where `web/` could be, relative to the executable, most specific first.
 *
 * The first entry is the app bundle: `Contents/MacOS/playops-server` puts the
 * game at `Contents/Resources/web`. The second covers a bare binary with the
 * game beside it, which is what a local build or an unzipped folder looks like.
 */
export function webDirCandidates(execPath) {
  const dir = path.dirname(path.resolve(execPath));
  return [
    path.resolve(dir, '..', 'Resources', 'web'),
    path.resolve(dir, 'web'),
  ];
}

/**
 * Resolve the game directory, or null.
 *
 * `exists` is called with each candidate directory and decides whether the game
 * is there; the default asks for an `index.html` inside it, so a leftover empty
 * `web/` does not win over a real one. `extra` candidates are tried last, which
 * is how a run from a checkout finds `export/web` without the packaged layout
 * ever preferring it.
 */
export function locateWebDir(execPath, { exists = hasGame, extra = [] } = {}) {
  for (const candidate of [...webDirCandidates(execPath), ...extra]) {
    if (exists(candidate)) return candidate;
  }
  return null;
}

/** The ports to try, in order. */
export function portSequence(start = DEFAULT_PORT, attempts = PORT_ATTEMPTS) {
  return Array.from({ length: attempts }, (_, index) => start + index);
}

/**
 * The URL the QR code should encode: the first LAN address, never localhost.
 *
 * A phone scanning `http://localhost:8000` reaches its own phone. Returning
 * null when there is no LAN interface is what lets the caller say "you are not
 * on a network" instead of printing a code that cannot work.
 */
export function qrTarget({ port, addresses = [] }) {
  return addresses.length > 0 ? `http://${addresses[0]}:${port}` : null;
}

/** Draw a QR code as terminal text, two cells per module so it scans. */
export function renderQr(text) {
  let drawn = '';
  // qrcode-terminal's callback is synchronous; it takes one only because the
  // API predates that being obvious.
  qrcode.generate(text, { small: false }, (code) => { drawn = code; });
  return drawn.replace(/\n+$/, '');
}

/**
 * The block of text the host reads off the screen.
 *
 * Every LAN address is listed rather than just the first: a Mac with both WiFi
 * and a dock is on two networks, and only the host can tell which one their
 * friends are on.
 */
export function hostBanner({
  port, addresses = [], hostname = os.hostname(), discovery = null,
}) {
  const lines = [
    'PlayOps — Claude of Duty LAN host',
    '',
    `  Local    http://localhost:${port}`,
  ];
  for (const address of addresses) {
    lines.push(`  LAN      http://${address}:${port}   <- share this on the WiFi`);
  }
  // The Bonjour name is easier to say out loud than four numbers, but it is
  // only worth offering when there is actually a network publishing it — with
  // no LAN interface it resolves to nothing and would just be a wrong answer.
  const bonjour = addresses.length > 0 ? bonjourHostname(hostname) : null;
  if (bonjour) {
    lines.push(`  Name     http://${bonjour}:${port}   <- or this, if it resolves`);
  }
  if (addresses.length === 0) {
    lines.push('  LAN      (no non-internal IPv4 address — check the WiFi is on)');
  }
  // Worth a line of its own because it is the one thing on this screen the
  // host does not have to read out: with discovery running, a friend's app
  // lists this game by itself. Naming the port also makes the macOS
  // local-network prompt, which arrives seconds later, make sense.
  if (discovery) {
    lines.push(`  Discover UDP ${discovery.port}   <- games on this WiFi find each other here`);
  }
  lines.push('');
  lines.push('  Stop     close this window or press Ctrl+C');
  return lines.join('\n');
}

/**
 * Whether to open the host's browser.
 *
 * A non-TTY stdout means something is scripting this — a test, a pipe, CI — and
 * a browser window appearing then is at best a surprise and at worst a hung
 * job. `PLAYOPS_NO_OPEN=1` is the explicit opt-out for an interactive run.
 */
export function shouldOpenBrowser({ isTTY = false, env = {} } = {}) {
  if (env.PLAYOPS_NO_OPEN === '1') return false;
  if (env.CI) return false;
  return Boolean(isTTY);
}

/** True when running inside a Single Executable Application. */
export async function isSeaRuntime() {
  try {
    const sea = await import('node:sea');
    return Boolean((sea.default ?? sea).isSea());
  } catch {
    return false;
  }
}

/**
 * Bind the LAN server to the first port in `ports` that is free.
 *
 * Only EADDRINUSE is walked past. Any other listen failure — a permissions
 * problem, a bad interface — is the host's to see, and retrying it nine times
 * would just bury the message.
 */
export async function listenOnFirstFreePort(ports, options = {}) {
  let lastError = null;
  for (const port of ports) {
    try {
      return await createLanServer({ ...options, port });
    } catch (error) {
      if (error?.code !== 'EADDRINUSE') throw error;
      lastError = error;
    }
  }
  throw new Error(
    `ports ${ports[0]}-${ports[ports.length - 1]} are all in use ` +
    `(${lastError?.message ?? 'EADDRINUSE'})`,
  );
}

/**
 * Run the host. Resolves once the server is listening; the process then stays
 * alive on the server's own handles until the window closes or Ctrl+C.
 */
export async function startHost({
  execPath = process.execPath,
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
  extraWebDirs = [],
  port = Number(env.PORT ?? DEFAULT_PORT),
} = {}) {
  const write = (text) => stdout.write(text);
  const root = locateWebDir(execPath, { extra: extraWebDirs });
  if (root === null) {
    stderr.write(
      'PlayOps: could not find the game.\n' +
      `  Looked for index.html in:\n${
        [...webDirCandidates(execPath), ...extraWebDirs].map((c) => `    ${c}\n`).join('')}` +
      '  The app bundle is incomplete — download PlayOps.dmg again.\n',
    );
    process.exitCode = 1;
    return null;
  }

  const lan = await listenOnFirstFreePort(portSequence(port), {
    root,
    // The banner is the only thing worth reading in the first screenful, so
    // the join/leave chatter starts underneath it.
    log: (line) => write(`${line}\n`),
  });

  const addresses = lanAddresses();
  // `lan.discovery` is null only when PLAYOPS_DISCOVERY=0 turned the beacon
  // off; the packaged host otherwise announces itself with no flags at all.
  write(`\n${hostBanner({ port: lan.port, addresses, discovery: lan.discovery })}\n\n`);
  const target = qrTarget({ port: lan.port, addresses });
  if (target) {
    write(`${renderQr(target)}\n`);
    write(`  Scan to join: ${target}\n\n`);
  } else {
    write('  (no QR code: this Mac is not on a network friends can reach)\n\n');
  }
  if (port !== lan.port) {
    write(`  Note: port ${port} was busy, so this match is on ${lan.port}.\n\n`);
  }

  if (shouldOpenBrowser({ isTTY: Boolean(stdout.isTTY), env })) {
    const child = spawn('open', [`http://localhost:${lan.port}`], {
      stdio: 'ignore', detached: true,
    });
    child.on('error', () => write('  (could not open your browser — use the Local URL above)\n'));
    child.unref();
  }

  const shutdown = () => {
    write('\nPlayOps: stopping.\n');
    lan.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return lan;
}

export default startHost;
