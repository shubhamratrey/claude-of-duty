# LAN multiplayer design

Date: 2026-09-08
Status: approved, not yet implemented

## Goal

Anyone on the same WiFi can open a URL and join a free-for-all deathmatch
together. The six existing bots stay in the match as extra combatants, so a
two-player game still feels populated.

Non-goals: internet play, matchmaking, more than one concurrent match per
server, teams, and anti-cheat beyond sanity checks.

## Why a listen server

Three models were considered.

A **headless Node authority** is feasible — `.tools/bake_navmesh.mjs` already
proves Recast and three-mesh-bvh run under Node — but `Enemy` is welded to GLB
pose templates and materials, so a dedicated server needs the 1289-line
`enemy-system.js` split into brain and body. That buys fairness properties
that do not matter when every player is in the same room.

A **WebRTC peer mesh** saves the relay hop, which on a LAN costs under a
millisecond, in exchange for ICE and SDP plumbing. Someone would still have to
own the bots.

A **browser listen server** with a thin Node relay reuses three seams the
codebase already has, adds one npm dependency, and requires no porting. It is
the chosen approach. Its cost is that the host holds bot authority and a host
departure causes a brief hitch.

## Seams this design relies on

The single-player code already generalises in the three places that matter.

`FreeForAllMatch` is an abstract combatant registry keyed by id, carrying a
`human` flag. It does not know what a combatant is.

`EnemyManager` has a target abstraction — `targetDead()`, `targetId()`,
`targetPosition()`, `targetFeet()`, and `selectTarget()` over
`[player, ...enemies]`. Bots already shoot each other, so a fourth kind of
target is an extension rather than a new concept.

`Enemy` is a baked-pose avatar with `hitboxes[]` (torso 1x, head 2x, legs
0.75x) and `takeDamage()`. Its entire visual vocabulary is three pose states —
`idle`, `run`, `death` (enemy-system.js:918) — which is exactly what a remote
player needs. A remote player is an `Enemy` whose brain is a socket, and
headshots on other humans come for free.

## Architecture

One Node process replaces `python -m http.server`:

```
npm run lan   ->  server/lan-server.mjs
                  |- static files from export/web
                  |- WebSocket endpoint at /net
                  '- prints  Join on this WiFi ->  http://192.168.1.42:8000
```

The server is a relay and a roster with **zero game rules**. It assigns peer
ids, keeps join order, names the oldest peer host, and forwards messages. It
never simulates. Keeping rules out of the server is what keeps it small.

Roles, all running the same `index.html`:

| Role | Owns | Does not run |
| --- | --- | --- |
| Every client | its own player: position, aim, health, death | — |
| Host (one) | the six bots and the `FreeForAllMatch` scoreboard | — |
| Guest | nothing shared | bot AI, `navigation.update()` |

The host is an ordinary player that additionally ticks the bot brain.

Every client still loads everything — navmesh, collision, bot rigs — exactly
as it does today. Guests skip `navigation.update()` and `enemy.decide()`.
This keeps the guest load path byte-identical to single-player and makes host
migration cheap, because a promoted guest already holds the navmesh.

## The damage invariant

> Damage is shooter-reported. Death is victim-confirmed. Scoring is
> host-recorded.

When a player shoots another player:

1. The shooter raycasts locally through the unchanged `weaponEffects.fire()`
   path and shows its own hitmarker immediately.
2. The shooter sends `hit { target, damage, box }`.
3. The victim's client applies the damage to its own `PlayerHealth`. Spawn
   protection, regeneration, and death timing are therefore always judged by
   the machine that owns the body, so a player's death never feels stolen.
4. On death the victim sends `died { by }`. The host records the kill in
   `FreeForAllMatch` and broadcasts the scoreboard.

Bots follow the same rule with the host holding their health. Hitmarkers are
optimistic; kill confirmations are authoritative. On a LAN the gap between the
two is a few milliseconds.

Sanity checks on the receiving side: per-weapon maximum damage, shot rate
limit, and maximum range. These catch honest bugs, not adversaries.

## Interpolation

Remote bodies — players and, on guests, bots — render at `hostNow - 100 ms`
from a timestamped snapshot buffer. There is no prediction and no rollback.
At 1-5 ms LAN round-trip they would add complexity and jitter for no gain.

Clock offset is estimated with `ping`/`pong`. Snapshots carry host time.

## Protocol

JSON over WebSocket. At 20 Hz by 8 players by roughly 200 bytes this is about
32 KB/s, which is negligible on a LAN and readable in devtools during
debugging. Binary packing is a later optimisation, not a launch requirement.

Server-authored messages, the only ones the server originates:

```
welcome     { peerId, hostId, roster[], serverTime }
peerJoined  { peer }
peerLeft    { peerId }
hostChanged { hostId }
pong        { clientTime, serverTime }
```

Relayed messages, which the server forwards without inspecting:

| Sender | Rate | Message |
| --- | --- | --- |
| every client | 20 Hz | `playerState { seq, t, pos, yaw, pitch, flags, weaponId, health, alive }` |
| host | 20 Hz | `botState { t, bots: [ { i, pos, yaw, state, frame, dead } ] }` |
| host | on change | `matchState { ...FreeForAllMatch.getState() }` |
| host | on demand | `spawn { peerId, pos, yaw }` |
| shooter | per shot | `weaponFire { peerId, origin, dir }` |
| shooter | per hit | `hit { target, damage, box, t }` |
| victim | per death | `died { by, at }` |

`flags` is a bitfield carrying crouched, sprinting, moving, and firing.

`weaponFire` exists so remote muzzle flashes, tracers, and positional audio
replay on every client without each client re-deriving them from `playerState`.

Spawns are host-assigned. `safeSpawnFor()` already avoids placing an actor on
top of another, and only the host knows where everyone is. This costs one
round trip on respawn, which is about two milliseconds here.

`matchState` is also sent at 1 Hz as a keepalive even when unchanged, so a
guest that missed an update converges within a second.

## New files

| File | Purpose | Pure logic |
| --- | --- | --- |
| `server/lan-server.mjs` | static files, `/net` socket, prints join URL | no |
| `server/lan-roster.mjs` | join order, host election, migration | yes |
| `export/web/net/protocol.js` | encode, decode, validate | yes |
| `export/web/net/snapshot-buffer.js` | timestamped buffer, interpolated sampling | yes |
| `export/web/net/net-client.js` | socket, reconnect, clock sync | no |
| `export/web/net/net-session.js` | role logic: what to send, what to apply | no |
| `export/web/net/remote-players.js` | remote avatars from the bot pose templates | no |

Four are pure logic with no socket and no Three.js, so they are testable the
way the rest of the repository is tested.

`server/lan-server.mjs` reuses the MIME map already written in
`.tools/ai-game.mjs`, which is extracted to a shared module rather than
duplicated.

## Modified files

**`export/web/enemy-system.js`** — the highest-risk edit.

- `EnemyManager` gains an `externalActors` set. `selectTarget()` candidates
  become `[player, ...enemies, ...externalActors]`, and the four `target*()`
  helpers learn the new kind.
- The hitbox list extends to external actors so a local ray hits a remote
  player.
- `handlePlayerHit()` returns which combatant was hit instead of only applying
  damage, so the net layer can route it.
- `update(dt, { active, simulate })`. With `simulate: false` the manager skips
  `decide()` and the crowd.
- New `Enemy.applyNetworkState({ pos, yaw, state, frame, dead })`.

**`export/web/free-for-all-match.js`** — additive only: `unregister(id)` for
disconnects, and `applyState(state)` so guests mirror the host verbatim.

**`export/web/frontend.js`** — a LAN panel showing a name field and the live
roster, mirroring the existing `openClass()` / `setWeapons()` pattern.

**`export/web/index.html`** — instantiate the session, route fire, damage, and
death through it, and gate `navigation.update()` and bot AI on `isHost`.

**`package.json`** — add the `ws` dependency, a `"lan"` script, and the new
unit tests in `test:unit`.

## Lifecycle

**Join.** Open the URL, load normally, enter a name in the LAN panel, deploy.
Late joiners receive a full state dump and then deltas. They spawn
immediately; free-for-all has no round to wait for.

**Leave.** The avatar is removed and the combatant is dropped from the
scoreboard.

**Host departure.** The server promotes the next-oldest peer and broadcasts
`hostChanged`. The new host already has bot bodies and their last known
transforms, so it re-seeds the crowd agents at those positions and continues.
Scores survive because guests were mirroring them. A visible hitch while the
crowd re-initialises is expected and accepted.

**Reconnect.** `net-client.js` retries with backoff. A client that reconnects
is a new peer with a new id; its old combatant is dropped. Preserving score
across a reconnect is out of scope.

## Error handling

| Condition | Behaviour |
| --- | --- |
| Malformed frame | `protocol.js` rejects and the frame is dropped; the connection survives |
| Unknown message type | ignored, logged once per type |
| `hit` naming an unknown target | dropped |
| `hit` failing a sanity check | dropped, counted in `getState().net` |
| Snapshot older than the buffer | dropped |
| Snapshot newer than any sample | clamped to the newest, body holds position |
| Server unreachable at boot | the game starts in single-player with the LAN panel showing the error |
| Socket closes mid-match | reconnect with backoff; remote bodies freeze then are removed after 5 s |

A failure to reach the server must never prevent the game from starting.
Single-player behaviour is the fallback in every case.

## Testing

**Unit** (`node --test`, no browser): host election and migration ordering;
protocol round-trip and rejection of malformed frames; snapshot interpolation
including clamping at both ends of the buffer; match `unregister()` and
`applyState()`.

**Integration** (Node, no browser): boot the real server, connect three
clients with Node 22's built-in `WebSocket`, and assert roster convergence,
relay fan-out, and that disconnecting the host promotes the correct peer.

**Browser** — a new `npm run ai:lan` launching the server and two Chrome
pages. It joins both, teleports them face to face through `hijacked.debug`,
fires, and asserts that each page sees the other's avatar, that damage lands,
and that both scoreboards agree. Screenshots from both pages are written to
`artifacts/ai-lan/`.

Two tabs on one machine cannot both hold pointer lock, so the second page is
driven through the debug API rather than synthetic mouse input.

Following the AGENTS.md rule that the debug surface stays compact and
serialisable, `getState()` gains:

```js
net: { connected, peerId, hostId, role, rttMs, peers: [{ id, name, kills }], remoteBodies }
```

## Build order

Each phase ends somewhere playable.

1. Server, roster, protocol, connection. The lobby lists who is present.
2. Player replication. Players run around the map together. First genuinely
   fun milestone.
3. Host broadcasts bots; guests replicate them.
4. Combat: hits, deaths, scoring, kill feed.
5. Host migration, disconnect handling, polish.
6. Optional: vendor Three.js into `export/web/vendor/` and rewrite the
   importmap, so the WiFi does not need internet access. Today the importmap
   pulls Three.js from jsdelivr, so guests currently need more than WiFi.

## Risks

`enemy-system.js` is 1289 dense lines. Its target abstraction is already
generic, which is fortunate, but replica mode touches `Enemy.update()`'s agent
path, where `agent.interpolatedPosition` currently drives position. That is
the exact line where a guest must read the network instead, and it is the most
likely place for this work to go wrong.

Shooter-authoritative damage lets a lagging client land implausible hits. On a
LAN, among friends, this is the correct trade. Sanity checks only.

The host carries the bot simulation on top of its own rendering, so the host
should be the strongest machine in the room. The lobby does not enforce this.

## Notes on the environment

The game uses no secure-context APIs — no `randomUUID`, no `SharedArrayBuffer`,
no workers — so plain HTTP from a LAN address works, pointer lock included.
No HTTPS or certificate work is required.
