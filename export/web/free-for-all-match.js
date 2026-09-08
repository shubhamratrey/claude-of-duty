const safeName = (value, fallback) => String(value ?? fallback).trim() || fallback;

// Scores arrive from the wire on a guest, so they are clamped to the shape the
// scoreboard can render rather than trusted: a negative or fractional kill
// count would sort and print as nonsense.
const safeCount = (value) => Math.max(0, Math.trunc(Number(value) || 0));

export class FreeForAllMatch {
  constructor({ scoreLimit = 30, timeLimitSeconds = 300, feedLimit = 5 } = {}) {
    this.scoreLimit = Math.max(1, Math.trunc(Number(scoreLimit) || 30));
    this.timeLimitSeconds = Math.max(1, Number(timeLimitSeconds) || 300);
    this.feedLimit = Math.max(1, Math.trunc(Number(feedLimit) || 5));
    this.combatants = new Map();
    this.reset();
  }

  register(id, name = id, { human = false } = {}) {
    const key = String(id);
    const previous = this.combatants.get(key);
    const entry = previous ?? { id: key, kills: 0, deaths: 0, streak: 0 };
    entry.name = safeName(name, key);
    entry.human = Boolean(human);
    this.combatants.set(key, entry);
    return entry;
  }

  /**
   * Drop a combatant who left. Returns true when one was actually removed.
   *
   * Two deliberate choices about history. Kill-feed entries naming the leaver
   * stay: the feed is a record of what happened, and blanking it would make
   * the last few seconds of the match silently disagree with what everyone
   * just watched. `winnerId` also survives, for the same reason -- a match
   * that ended on someone's thirtieth kill still ended that way after they
   * alt-tabbed. Only the standings drop them, because standings are the list
   * of who is still playing.
   */
  unregister(id) {
    return this.combatants.delete(String(id));
  }

  /**
   * Replace every visible field from a host-authored `getState()` payload.
   *
   * A guest owns no scoring, so it mirrors rather than merges: whatever the
   * host says is the match, including combatants this client has never seen
   * and the disappearance of ones it had. The round trip is exact --
   * `applyState(x)` followed by `getState()` deep-equals `x` -- which is what
   * lets the host and every guest draw the same scoreboard from the same
   * bytes, and what makes a desync a bug rather than an expected drift.
   *
   * A malformed payload is ignored whole. Half-applying one would let a single
   * bad frame empty a live scoreboard, and `matchState` repeats at 1 Hz, so
   * dropping one costs at most a second of staleness.
   */
  applyState(state) {
    if (!state || typeof state !== 'object') return false;
    if (!Array.isArray(state.standings) || !Array.isArray(state.feed)) return false;

    // Existing entry objects are reused so anything holding a reference to a
    // combatant keeps seeing live numbers instead of a detached copy.
    const combatants = new Map();
    for (const row of state.standings) {
      if (!row || typeof row !== 'object') continue;
      const key = String(row.id ?? '');
      if (!key || combatants.has(key)) continue;
      const entry = this.combatants.get(key) ?? { id: key };
      entry.name = safeName(row.name, key);
      entry.human = Boolean(row.human);
      entry.kills = safeCount(row.kills);
      entry.deaths = safeCount(row.deaths);
      entry.streak = safeCount(row.streak);
      combatants.set(key, entry);
    }
    this.combatants = combatants;

    this.phase = state.phase === 'ended' ? 'ended' : 'playing';
    if (Number(state.scoreLimit) > 0) this.scoreLimit = Math.trunc(Number(state.scoreLimit));
    if (Number(state.timeLimitSeconds) > 0) this.timeLimitSeconds = Number(state.timeLimitSeconds);
    this.elapsedSeconds = Math.min(this.timeLimitSeconds,
      Math.max(0, Number(state.elapsedSeconds) || 0));
    this.winnerId = typeof state.winnerId === 'string' ? state.winnerId : null;
    // The host's feed length wins over the local `feedLimit`; that limit only
    // governs the feed this client authors for itself.
    this.feed = state.feed
      .filter((event) => event && typeof event === 'object')
      .map((event) => ({ ...event }));
    return true;
  }

  reset() {
    this.phase = 'playing';
    this.elapsedSeconds = 0;
    this.winnerId = null;
    this.feed = [];
    for (const entry of this.combatants?.values?.() ?? []) {
      entry.kills = 0;
      entry.deaths = 0;
      entry.streak = 0;
    }
    return this.getState();
  }

  update(deltaSeconds) {
    if (this.phase !== 'playing') return;
    const dt = Math.max(0, Math.min(Number(deltaSeconds) || 0, 0.25));
    this.elapsedSeconds = Math.min(this.timeLimitSeconds, this.elapsedSeconds + dt);
    if (this.elapsedSeconds >= this.timeLimitSeconds) this.finish();
  }

  recordKill(killerId, victimId) {
    if (this.phase !== 'playing') return null;
    const killer = this.combatants.get(String(killerId));
    const victim = this.combatants.get(String(victimId));
    if (!victim) return null;

    victim.deaths += 1;
    victim.streak = 0;
    const credited = killer && killer !== victim;
    if (credited) {
      killer.kills += 1;
      killer.streak += 1;
    }
    const event = {
      killerId: credited ? killer.id : null,
      killer: credited ? killer.name : 'The environment',
      victimId: victim.id,
      victim: victim.name,
      at: this.elapsedSeconds,
    };
    this.feed.unshift(event);
    this.feed.length = Math.min(this.feed.length, this.feedLimit);
    if (credited && killer.kills >= this.scoreLimit) this.finish(killer.id);
    return event;
  }

  finish(winnerId = null) {
    if (this.phase === 'ended') return this.winnerId;
    this.phase = 'ended';
    this.winnerId = winnerId && this.combatants.has(String(winnerId))
      ? String(winnerId)
      : this.standings[0]?.id ?? null;
    return this.winnerId;
  }

  get standings() {
    return [...this.combatants.values()]
      .sort((a, b) => b.kills - a.kills || a.deaths - b.deaths || Number(b.human) - Number(a.human) ||
        a.name.localeCompare(b.name));
  }

  get remainingSeconds() {
    return Math.max(0, this.timeLimitSeconds - this.elapsedSeconds);
  }

  getState() {
    const standings = this.standings.map((entry, index) => ({
      id: entry.id,
      name: entry.name,
      human: entry.human,
      kills: entry.kills,
      deaths: entry.deaths,
      streak: entry.streak,
      place: index + 1,
    }));
    // The clock is published rounded, and the countdown is derived from the
    // rounded value rather than from `this.elapsedSeconds`. Deriving it from
    // the unrounded clock puts a number on the wire that the receiver cannot
    // reproduce -- 99.9996 s elapsed ships as 100 but its ceil is a second
    // higher -- which would make applyState/getState round-trip inexact.
    const elapsedSeconds = Math.round(this.elapsedSeconds * 1000) / 1000;
    return {
      phase: this.phase,
      scoreLimit: this.scoreLimit,
      timeLimitSeconds: this.timeLimitSeconds,
      elapsedSeconds,
      remainingSeconds: Math.ceil(Math.max(0, this.timeLimitSeconds - elapsedSeconds)),
      winnerId: this.winnerId,
      standings,
      feed: this.feed.map((event) => ({ ...event })),
    };
  }
}

export default FreeForAllMatch;
