# Relay rooms design

Date: 2026-09-09
Status: approved, not yet implemented

## Goal

Play with friends who are not on the same WiFi. One person runs a small relay
somewhere reachable, pastes its URL into the game, and is given a four-character
code. Everyone else pastes the same URL, is told a game is already in progress,
and types the code to join.

LAN play is unchanged and is not touched by this work.

Non-goals: room browsing, passwords, multiple simultaneous rooms per relay,
persistence across an empty room, reconnecting into a previous slot, and any
change to who is trusted about damage.

## Two modes, deliberately separate

| | LAN | Relay |
| --- | --- | --- |
| Address | same origin, auto-probed | pasted `wss://…` |
| Setup | none | run a relay, share a code |
| Rooms | one implicit match | one room per relay, code-gated |
| Serves the game | yes | no, sockets only |

The obvious economy here is to make LAN "a relay with one implicit room" and
share one implementation. That was considered and rejected: the LAN path works
and is covered by browser tests, and reworking it buys no user-visible
behaviour. The relay instead *imports* what already exists — `LanRoster` for
membership and host election, `frameDisposition` and `DROPPABLE_TYPES` for
backpressure, and `protocol.js` for the wire format. What it duplicates is
roughly sixty lines of socket wiring. That duplication is the accepted price of
leaving a working path alone.

## The code is a secret, not an address

Because a relay holds exactly one room, the code does not identify which room to
enter — there is only ever one. It exists so that someone who merely discovers
the relay URL cannot walk into the game.

The first client to connect to an empty relay creates the room, becomes host,
and receives the code. Every later client is told a room exists and must supply
the code. When the last member leaves, the room is destroyed and its code is
discarded; the next client to connect creates a fresh room with a new code.

### Accepted consequence: the relay is squattable

Whoever connects first owns the relay. A stranger who finds the URL cannot enter
an existing game, but can occupy an empty relay and prevent the intended host
from creating one. A shared token was considered and deliberately declined. The
mitigation is therefore the URL itself: a random hostname from a tunnel
(`odd-brook-1234.trycloudflare.com`) is unguessable, while a stable custom
domain is not. The README must say this plainly rather than imply a privacy
guarantee that does not exist.

## Transport

The relay speaks plain HTTP/WebSocket and terminates nothing. It is correct
behind cloudflared, Caddy, nginx, or nothing at all. Documentation leads with a
tunnel, because it produces a `wss://` URL with no domain, certificate, or
port-forwarding.

The browser rule that shapes this: **a page served over HTTPS cannot open a
`ws://` socket** — it is blocked as mixed content, silently. So a player loading
the game from the public HTTPS site needs a `wss://` relay. The reverse is
allowed, so a player serving the page locally over `http://` with `npm run lan`
may point at either.

The relay serves no game assets. Players get the page from the public site, from
their own static host, or from a local `npm run lan`.

### The pasted URL accepts any of four schemes

Tunnels print `https://odd-brook-1234.trycloudflare.com`. Requiring the player
to rewrite that as `wss://` is friction that buys nothing and invites a silent
failure, so the field accepts `https`, `http`, `wss` and `ws` and normalises:

```
https://relay.example.com    ->  wss://relay.example.com/net
http://192.168.1.50:8787     ->  ws://192.168.1.50:8787/net
wss:// or ws://              ->  taken as given
```

Whitespace is trimmed, a trailing slash is tolerated, and a URL that already
ends in `/net` is not given a second one. A URL that does not parse is reported
in the panel before anything is opened.

### The relay is probed over HTTP first

`GET /relay/health` returns `{ relay: true, room: <boolean>, peers: <number> }`.
The client fetches this before opening the socket, exactly as the LAN path
already probes its own origin.

Two reasons, both about diagnosis rather than function. Pasting something that
is not a relay -- the game's own URL, a typo, a dead tunnel -- then reports
"that is not a relay" rather than sitting on "connecting". And a blocked
mixed-content `fetch` **throws and is catchable**, whereas a blocked
mixed-content WebSocket simply never opens and raises nothing to script; the
probe therefore converts the worst diagnostic in this design into a plain
message. The `ws://`-on-HTTPS check still runs first, since it needs no network
round trip to be certain.

## Protocol

Three additions. Everything after `welcome` — `playerState`, `botState`, hits,
deaths, host migration — is unchanged and simply scoped to the room's members.

```
server → welcome      { peerId, roomCode, hostId, roster, serverTime }
server → roomRequired { }
client → joinRoom     { code, name }
server → error        { message, reason }
```

`reason` is one of `bad-code`, `room-full`, or `no-room`. `welcome` gains an
optional `roomCode`; the LAN server omits it, so its validator must accept its
absence and the LAN path must not change shape.

Sequence for the first client:

```
connect  →  server: welcome { roomCode: 'K7M2', … }
```

Sequence for every later client:

```
connect  →  server: roomRequired { }
         →  client: joinRoom { code: 'K7M2', name: 'ALEX' }
         →  server: welcome { roomCode: 'K7M2', … }   or   error { reason: 'bad-code' }
```

A wrong code leaves the socket open so the player can retype it. A socket that
connects and does not join within thirty seconds is closed, so nobody can hold
a connection open indefinitely without being in the game.

`hello` keeps its current meaning and may arrive at any time; the relay records
the name whether or not the sender has been admitted yet.

## Codes

Four characters drawn from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` — 32 symbols with
`I`, `O`, `0` and `1` removed, because these get read aloud over voice chat.
That is 1,048,576 combinations, which is ample when a relay holds one at a time;
generation retries on the (vanishingly unlikely) collision with the code it just
discarded. Input is case-insensitive and whitespace-trimmed; display is
uppercase and spaced (`K 7 M 2`) so it is easy to read out.

## Files

New:

| File | Purpose | Pure logic |
| --- | --- | --- |
| `server/relay-room.mjs` | code generation, one room's membership and lifecycle | yes |
| `server/relay-server.mjs` | sockets, admission, relaying, `/relay/health` | no |

Modified:

- `export/web/net/protocol.js` — the three new message types and their
  validators; `roomCode` optional on `welcome`.
- `export/web/net/net-client.js` — an optional `room` mode. Absent, behaviour is
  byte-identical to today: connect, `hello`, expect `welcome`. Present, the
  client additionally understands `roomRequired`, can send `joinRoom`, and
  surfaces `error` with its reason.
- `export/web/frontend.js` — the relay panel: a URL field, the code shown large
  once created, a code entry field when a room already exists, and the error
  text for a bad code.
- `export/web/index.html` — choose between the same-origin probe and a pasted
  relay URL, and persist the URL.
- `package.json` — `"relay": "node server/relay-server.mjs"`.

Not modified: `server/lan-server.mjs`, `server/lan-roster.mjs`.

## Client behaviour

The relay URL is stored in `localStorage` under the existing `hijacked.` prefix
and restored on load. An empty field means LAN mode and the same-origin probe
runs exactly as it does now. A filled field means relay mode: the probe is
skipped entirely, and the private-address gate (`lanEligible`) does not apply,
because an explicit relay URL is a deliberate act and the page may well be
served from the public HTTPS site.

Switching modes, or editing the URL, closes the current session and starts a new
one without reloading the page.

A `ws://` URL typed on a page served over HTTPS is rejected before the socket is
opened, with a message naming the problem. This case is singled out because the
browser's own behaviour is a silent failure: the connection never opens and no
error is raised to script, so without this check the panel would sit on
"connecting" forever with nothing in the console to explain it.

The panel has three states after a URL is entered: connecting, hosting (shows
the code), and joining (shows the code entry). A bad code returns to joining
with an error line rather than dropping the connection.

## Caps

Eight peers per room, matching `LanRoster`. Frame size is already bounded by
`protocol.LIMITS.MAX_FRAME_BYTES`. A per-peer message rate limit of 200 frames
per second, generously above the ~21/s a client actually sends, drops the
excess rather than disconnecting. Backpressure is the existing policy, imported
unchanged.

## Error handling

| Condition | Behaviour |
| --- | --- |
| Wrong code | `error { reason: 'bad-code' }`, socket stays open, UI lets them retype |
| `joinRoom` arrives after the room was destroyed | `error { reason: 'no-room' }`; the client reconnects, which makes it the new creator |
| Room full | `error { reason: 'room-full' }`, socket closed |
| `ws://` URL entered on an HTTPS page | rejected in the client before opening the socket, with an explanation; the browser would otherwise block it with no observable error at all |
| URL that does not parse | reported in the panel; nothing is opened |
| URL that parses but is not a relay | the health probe answers wrong or 404s; the panel says so instead of hanging on "connecting" |
| Frame before admission that is not `joinRoom` or `hello` | dropped, counted |
| No join within 30 s | socket closed |
| Relay unreachable or URL malformed | the panel shows the error; the game still starts and plays single-player |
| Host leaves | existing migration, unchanged; the code does not change |
| Last member leaves | room destroyed, code discarded |

A relay that cannot be reached must never prevent the game from starting.

## Testing

**Unit** (`node --test`, no browser, no sockets): code generation — alphabet,
length, no ambiguous characters, fresh code per room; room lifecycle — create,
admit, reject a wrong code, fill to capacity, destroy when empty, new code after
destruction; host election within a room, reusing `LanRoster`'s existing
behaviour.

**Integration** (Node, no browser, real server on port 0, Node 22's built-in
`WebSocket`): the first client is admitted and receives a code; the second gets
`roomRequired`; a wrong code is refused and the socket survives; the right code
admits; relayed frames reach other members with `from` stamped by the server;
the ninth peer is refused; when everyone leaves, the next client gets a *new*
code. Isolation is implied here rather than tested across rooms, since a relay
holds one room — but a second connection attempt while a room exists must never
be silently placed into that room without the code, and that is asserted.

**Browser** — `npm run ai:relay`: boots a relay on a random port and opens two
browsers. The first is given a code; the second joins with it; they see each
other's bodies and agree on the scoreboard. A third browser attempting a wrong
code must be refused and must see no remote bodies.

## Why WebSocket rather than HTTP

Considered and rejected as the transport. Server-sent events are one-directional,
so client messages would each need a POST; every POST carries full headers,
roughly 500 bytes against WebSocket's ~6 bytes of framing, twenty times a second
per player. That is about a fiftyfold overhead increase on the chattiest path,
plus connection churn and added latency in a game where latency is the thing
that matters. Long-polling is worse again.

It remains a legitimate fallback for a network that blocks WebSocket outright,
which is rare and which tunnels handle. Not built speculatively.

HTTP is still used for the health probe described above, where a single
request's overhead is irrelevant and its error reporting is better.

## Risks

The relay is squattable, as described above, and this is accepted rather than
solved.

Internet latency is the substantive gameplay risk. Remote bodies already render
100 ms in the past; over the internet that becomes 100 ms plus half the
round-trip. Because damage is shooter-reported, the shooter's experience stays
accurate — you hit what you see — and the cost lands on the victim as being shot
after reaching cover. This is the familiar trade and needs no code, but the
README should describe it so it is not read as a bug.

Damage remains shooter-reported. On a LAN among friends that is the right trade;
exposed to the internet it means anyone who reaches the relay and knows the code
can claim any hit. Server-authoritative validation would require collision and
the navmesh running in Node and a rebuilt damage model, which is out of scope.
The README must state the limitation instead of implying safety.
