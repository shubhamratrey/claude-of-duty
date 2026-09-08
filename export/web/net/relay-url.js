// Turning what someone pasted into a socket URL.
//
// Tunnels print `https://odd-brook-1234.trycloudflare.com`, so that is what
// people will paste. Requiring them to rewrite it as `wss://` is friction that
// buys nothing and invites a failure with no symptom, so all four schemes are
// accepted and normalised here.
//
// The mixed-content rule is the reason this file checks anything at all: a page
// served over HTTPS cannot open a `ws://` socket, and the browser's refusal is
// silent -- the socket never opens and nothing is raised to script. Catching it
// before opening turns a permanent "connecting..." into a sentence.

/** Where the relay answers its liveness probe. */
export const RELAY_HEALTH_PATH = '/relay/health';

/** Where the relay accepts sockets. */
export const RELAY_SOCKET_PATH = '/net';

const SOCKET_SCHEME = { 'https:': 'wss:', 'http:': 'ws:', 'wss:': 'wss:', 'ws:': 'ws:' };
const HTTP_SCHEME = { 'https:': 'https:', 'http:': 'http:', 'wss:': 'https:', 'ws:': 'http:' };

const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?)$/i;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * A scheme for input that has none.
 *
 * A bare hostname is almost always a tunnel or a domain, which means TLS. A
 * bare IP or localhost is almost always a machine on the desk, which means it
 * has no certificate. Guessing wrong is recoverable -- the health probe fails
 * and says so -- but guessing well means most people never think about it.
 */
function assumeScheme(input) {
  const host = input.split('/')[0].split(':')[0];
  return LOOPBACK.test(host) || IPV4.test(host) ? 'http://' : 'https://';
}

/**
 * Normalise a pasted relay address.
 *
 * @param {string} input whatever was typed
 * @param {string} pageProtocol `location.protocol` of the page doing the connecting
 * @returns {{ok: true, socketUrl: string, healthUrl: string, origin: string}
 *          | {ok: false, error: string}}
 */
export function parseRelayUrl(input, pageProtocol = 'http:') {
  const text = String(input ?? '').trim();
  if (!text) return { ok: false, error: 'Enter a relay address.' };

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : assumeScheme(text) + text;

  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, error: `Could not read "${text}" as an address.` };
  }

  const socketScheme = SOCKET_SCHEME[url.protocol];
  if (!socketScheme) {
    return { ok: false, error: `${url.protocol}// is not a relay address. Use https, http, wss or ws.` };
  }
  if (!url.hostname) return { ok: false, error: 'That address has no host.' };

  if (pageProtocol === 'https:' && socketScheme === 'ws:') {
    return {
      ok: false,
      error: 'This page is served over HTTPS, so it can only reach a secure relay. ' +
        'Use a wss:// or https:// address, or open the game over http://.',
    };
  }

  // A path is kept if the relay sits under one (a reverse proxy may mount it at
  // /relay), but the socket and probe paths are appended rather than assumed --
  // and not appended twice if the pasted URL already carries them.
  const base = url.pathname.replace(/\/+$/, '');
  const stem = base.endsWith(RELAY_SOCKET_PATH)
    ? base.slice(0, -RELAY_SOCKET_PATH.length)
    : base;

  const httpScheme = HTTP_SCHEME[url.protocol];
  const authority = `${url.hostname}${url.port ? `:${url.port}` : ''}`;

  return {
    ok: true,
    origin: `${httpScheme}//${authority}${stem}`,
    socketUrl: `${socketScheme}//${authority}${stem}${RELAY_SOCKET_PATH}`,
    healthUrl: `${httpScheme}//${authority}${stem}${RELAY_HEALTH_PATH}`,
  };
}

export default parseRelayUrl;
