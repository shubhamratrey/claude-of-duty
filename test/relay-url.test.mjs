import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRelayUrl } from '../export/web/net/relay-url.js';

const socket = (input, page = 'http:') => parseRelayUrl(input, page).socketUrl;

test('a tunnel URL is accepted exactly as printed', () => {
  // cloudflared and ngrok both print https://. Making the player rewrite that
  // as wss:// is the friction this whole module exists to remove.
  assert.equal(socket('https://odd-brook-1234.trycloudflare.com'),
    'wss://odd-brook-1234.trycloudflare.com/net');
});

test('every scheme maps to the matching socket scheme', () => {
  assert.equal(socket('https://r.example.com'), 'wss://r.example.com/net');
  assert.equal(socket('http://r.example.com'), 'ws://r.example.com/net');
  assert.equal(socket('wss://r.example.com'), 'wss://r.example.com/net');
  assert.equal(socket('ws://r.example.com'), 'ws://r.example.com/net');
});

test('a missing scheme is guessed from the shape of the host', () => {
  // A bare hostname is a tunnel or a domain, so TLS. A bare IP or localhost is
  // a machine on the desk, which has no certificate.
  assert.equal(socket('r.example.com'), 'wss://r.example.com/net');
  assert.equal(socket('192.168.1.50:8787'), 'ws://192.168.1.50:8787/net');
  assert.equal(socket('localhost:8787'), 'ws://localhost:8787/net');
  assert.equal(socket('127.0.0.1:8787'), 'ws://127.0.0.1:8787/net');
});

test('the socket path is appended once, never twice', () => {
  assert.equal(socket('https://r.example.com/net'), 'wss://r.example.com/net');
  assert.equal(socket('https://r.example.com/net/'), 'wss://r.example.com/net');
  assert.equal(socket('https://r.example.com/'), 'wss://r.example.com/net');
});

test('a relay mounted under a path keeps that path', () => {
  const parsed = parseRelayUrl('https://proxy.example.com/relay');
  assert.equal(parsed.socketUrl, 'wss://proxy.example.com/relay/net');
  assert.equal(parsed.healthUrl, 'https://proxy.example.com/relay/relay/health');
});

test('the health probe is derived alongside the socket URL', () => {
  const parsed = parseRelayUrl('https://r.example.com');
  assert.equal(parsed.healthUrl, 'https://r.example.com/relay/health');
  assert.equal(parseRelayUrl('ws://r.example.com:9000').healthUrl,
    'http://r.example.com:9000/relay/health');
});

test('an insecure relay is refused from a secure page, before opening anything', () => {
  // The browser blocks this silently: the socket never opens and nothing is
  // raised to script, so without the check the panel sits on "connecting"
  // forever with an empty console.
  const parsed = parseRelayUrl('ws://192.168.1.50:8787', 'https:');
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /HTTPS/);
  assert.equal(parsed.socketUrl, undefined);

  assert.equal(parseRelayUrl('http://r.example.com', 'https:').ok, false);
  assert.equal(parseRelayUrl('https://r.example.com', 'https:').ok, true);
});

test('a secure relay is fine from an insecure page', () => {
  // Only the downgrade is blocked, which is what lets someone serve the page
  // locally with npm run lan and still reach a remote wss relay.
  assert.equal(parseRelayUrl('wss://r.example.com', 'http:').ok, true);
});

test('unusable input is reported rather than guessed at', () => {
  assert.equal(parseRelayUrl('').ok, false);
  assert.equal(parseRelayUrl('   ').ok, false);
  assert.equal(parseRelayUrl(null).ok, false);
  assert.equal(parseRelayUrl('not a url ::::').ok, false);
  assert.equal(parseRelayUrl('ftp://r.example.com').ok, false);
  assert.match(parseRelayUrl('ftp://r.example.com').error, /https, http, wss or ws/);
});

test('surrounding whitespace is forgiven, since this gets pasted', () => {
  assert.equal(socket('  https://r.example.com  '), 'wss://r.example.com/net');
});
