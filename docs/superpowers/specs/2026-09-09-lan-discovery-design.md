# LAN game discovery

**Date:** 2026-09-09 (IST)
**Status:** approved in chat, ready to build
**Builds on:** `2026-09-09-mac-host-package-design.md` (the dmg). Rebase this
branch onto `mac-host-package` once that lands, or onto `main` after merge.

## The problem

With the dmg, every player on the WiFi runs their own PlayOps app. Today the
only way to join a friend is to type or scan their address. If every app
already knows it is on the WiFi, the lobby should list the games it can see
and let you click one.

## What people see

The LAN panel gains a list under the existing status line:

```
Games on this WiFi
  Shubham's MacBook      3 players     [Join]
  Priya's MacBook Air    1 player      [Join]
  Rahul's Mac            different version
```

- A row appears within ~2 s of a game opening and drops off 6 s after its
  last beacon.
- The name is the host's callsign once set, otherwise the Mac's name made
  readable (`Shubhams-MacBook` → `Shubhams MacBook`).
- A version mismatch shows the words `different version` instead of a Join
  button. Two incompatible builds must never be allowed to try.
- Your own game is not in the list. It is the thing you are already in.
- After joining, the panel shows `Playing on Priya's MacBook Air` with a
  `Back to my game` control that returns to the local server.

## How discovery works

### Beacons

Every running PlayOps server broadcasts a UDP beacon every 2 s **while its
roster has at least one peer**, and always listens. One player connected to
your own server is enough, which is the case the moment you open the game.
When you join someone else, your own roster empties and your beacon stops:
nobody is offered a ghost game.

- UDP port **8010**, `reuseAddr: true` so several servers on one Mac (tests,
  a stray second launch) can all listen.
- Sent to `255.255.255.255` and to each non-internal IPv4 interface's own
  broadcast address, computed from address and netmask. Some macOS setups
  drop the limited broadcast but pass the directed one.
- Payload is JSON, under 512 bytes, no spaces wasted:

  ```json
  {"app":"playops","v":1,"id":"<random 8 chars per process>",
   "name":"Shubhams MacBook","port":8000,"players":3,"version":"1.0.0"}
  ```

  `v` is the protocol version from `export/web/net/protocol.js`; that is what
  decides compatibility. `version` is `package.json` version, shown to people.
- A receiver ignores anything that is not valid JSON with `app === 'playops'`,
  anything over 512 bytes, and its own `id`. The sender address of the datagram
  is the host's IP; the beacon's `port` completes the URL. Nothing in the
  payload is trusted as an address.

No mDNS and no dependency. Broadcast is ~60 lines, testable without a
network, and a WiFi that isolates clients from each other blocks the game's
own TCP connections too, so mDNS would buy nothing there.

### Server

New `server/lan-discovery.mjs`:

- `encodeBeacon(fields)`, `decodeBeacon(buffer)` — pure, validated.
- `prettyHostName(hostname)` — strips `.local`, turns `-`/`_` into spaces.
- `class DiscoveryTable({ now, ttlMs = 6000, selfId, protocolVersion })` —
  `observe(beacon, fromAddress)`, `games()` returns
  `[{ id, name, address, port, url, players, version, compatible, ageMs }]`
  sorted by name, expired rows dropped. Pure; `now` injected.
- `startDiscovery({ port = 8010, interval = 2000, announce, table, dgram })` —
  the only impure part. `announce()` is a callback returning the beacon fields
  or `null` (roster empty → no send). `dgram` is injected so tests pass a
  fake. Returns `{ close() }`. Socket errors are logged once and discovery
  degrades to "no list", never to a crash of the game server.

`server/lan-server.mjs`:

- Option `discovery: true|false` (default true; env `PLAYOPS_DISCOVERY=0`
  turns it off). When on, starts discovery with `announce` reading the
  roster: `players = roster.size`, `name` = host peer's callsign if they set
  one, else `prettyHostName(os.hostname())`.
- New route `GET /net/discover` → `{ games: table.games() }`.
- `/net/health` and `/net/discover` gain `Access-Control-Allow-Origin: *`,
  because after Join the page (served from your Mac) probes a friend's Mac.
  The relay already does this.

### Client

`export/web/index.html`:

- While `lanEligible` and mode is `lan`, poll `net/discover` every 2 s and
  push the result into `frontend.setLanState({ games })`. Stop polling while
  joined elsewhere or in relay mode.
- New action `join-game` with value `{ address, port, name }` → set state
  `{ joinedGame: { name, url } }` and `restartLanSession()`.
- `resolveTarget()` when `joinedGame` is set: `{ mode: 'lan',
  socketUrl: 'ws://<address>:<port>/net', healthUrl:
  'http://<address>:<port>/net/health' }`. Plain http page to a plain socket
  on the LAN is allowed by every browser, and Chrome's Local Network Access
  check does not apply from a loopback page to a private address.
- Action `leave-game` clears `joinedGame` and restarts against the local
  server.

`export/web/frontend.js`: render the list from `lanState.games`, the Join
buttons (disabled with the `different version` label when
`compatible === false`), and the joined banner with `Back to my game`. Forward
`join-game` and `leave-game` through the existing `onAction(name, value)`.

## First-launch prompt

macOS Sequoia asks whether an app may find devices on the local network the
first time it broadcasts. Because the dmg launches the server through
Terminal, the prompt names Terminal. Say Allow once. Add this to the dmg's
README.txt alongside the Gatekeeper and firewall notes. If it is denied, the
list stays empty and the QR/typed address still works.

## Testing

- `test/lan-discovery.test.mjs` (`node --test`, `node:assert/strict`, import
  from source): beacon round-trip; garbage, oversize and foreign-app payloads
  rejected; own id ignored; table expiry at exactly `ttlMs`; protocol
  mismatch → `compatible: false`; `prettyHostName` cases (`.local`, hyphens,
  already pretty); `startDiscovery` with a fake `dgram`: sends on the
  interval only when `announce()` is non-null, feeds received datagrams to the
  table, `close()` stops the timer.
- `test/lan-server.test.mjs` additions: `/net/discover` shape and CORS header;
  discovery off when `discovery: false`.
- `test/frontend.test.mjs` / `test/lan-lobby.test.mjs` additions: list
  renders rows, incompatible row has no Join, Join forwards `join-game` with
  the value, `Back to my game` forwards `leave-game`.
- `.tools/lan-discover.mjs` (`npm run ai:discover`): two real lan-servers on
  127.0.0.1 with different HTTP ports and a shared discovery port, using the
  env override `PLAYOPS_DISCOVERY_ADDR=127.0.0.1` so beacons unicast to
  loopback instead of broadcasting. Assert each `/net/discover` lists the
  other within 3 s. Then open a browser on server A, click Join on B's row,
  and assert the browser's peer appears in B's roster and A's beacon stops.
  This is the rendered evidence AGENTS.md asks for.

## Out of scope

- Phones and iPads (no dmg there).
- mDNS / Bonjour service records.
- Discovery across subnets or through the relay.
- Inviting or kicking; the list is read-only apart from Join.
