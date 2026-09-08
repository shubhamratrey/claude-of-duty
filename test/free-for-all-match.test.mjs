import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FreeForAllMatch } from '../export/web/free-for-all-match.js';

test('FFA records kills, deaths, streaks, placement, and feed events', () => {
  const match = new FreeForAllMatch({ scoreLimit: 3, timeLimitSeconds: 60 });
  match.register('player', 'You', { human: true });
  match.register('bot-0', 'Admiral');
  match.recordKill('player', 'bot-0');
  match.recordKill('player', 'bot-0');

  const state = match.getState();
  assert.equal(state.standings[0].id, 'player');
  assert.equal(state.standings[0].kills, 2);
  assert.equal(state.standings[1].deaths, 2);
  assert.equal(state.feed[0].killer, 'You');
});

test('FFA ends at the score limit or when time expires', () => {
  const scoreMatch = new FreeForAllMatch({ scoreLimit: 1 });
  scoreMatch.register('a', 'A');
  scoreMatch.register('b', 'B');
  scoreMatch.recordKill('a', 'b');
  assert.equal(scoreMatch.phase, 'ended');
  assert.equal(scoreMatch.winnerId, 'a');

  const timed = new FreeForAllMatch({ timeLimitSeconds: 1 });
  timed.register('a', 'A');
  timed.register('b', 'B');
  timed.recordKill('b', 'a');
  for (let i = 0; i < 4; i += 1) timed.update(0.25);
  assert.equal(timed.phase, 'ended');
  assert.equal(timed.winnerId, 'b');
});

test('suicides count as a death without awarding a kill', () => {
  const match = new FreeForAllMatch();
  match.register('player', 'You');
  match.recordKill('player', 'player');
  const player = match.getState().standings[0];
  assert.equal(player.kills, 0);
  assert.equal(player.deaths, 1);
});

test('unregister drops a leaver from the standings but not from history', () => {
  const match = new FreeForAllMatch({ scoreLimit: 2, timeLimitSeconds: 60 });
  match.register('player', 'You', { human: true });
  match.register('quitter', 'Quitter', { human: true });
  match.recordKill('quitter', 'player');
  match.recordKill('quitter', 'player');
  assert.equal(match.phase, 'ended');
  assert.equal(match.winnerId, 'quitter');

  assert.equal(match.unregister('quitter'), true);
  assert.equal(match.unregister('quitter'), false, 'a second disconnect is a no-op');
  assert.equal(match.unregister('never-here'), false);

  const state = match.getState();
  assert.deepEqual(state.standings.map((entry) => entry.id), ['player']);
  assert.equal(state.feed.length, 2, 'the kill feed is a record of what happened');
  assert.equal(state.feed[0].killer, 'Quitter');
  assert.equal(state.winnerId, 'quitter', 'a match that ended on their score still ended that way');
});

test('applyState round-trips a host payload exactly', () => {
  const host = new FreeForAllMatch({ scoreLimit: 30, timeLimitSeconds: 300, feedLimit: 5 });
  host.register('peer-a', 'Ada', { human: true });
  host.register('peer-b', 'Bo', { human: true });
  host.register('bot-0', 'Admiral');
  host.recordKill('peer-a', 'bot-0');
  host.recordKill('bot-0', 'peer-b');
  host.update(0.25);
  // A clock that rounds up across a whole second is the case where deriving
  // the countdown from the unrounded elapsed time would break equality.
  host.elapsedSeconds = 99.9996;

  const state = host.getState();
  assert.equal(state.elapsedSeconds, 100);
  assert.equal(state.remainingSeconds, 200);

  const guest = new FreeForAllMatch({ scoreLimit: 5, timeLimitSeconds: 60, feedLimit: 1 });
  guest.register('stale', 'Stale');
  assert.equal(guest.applyState(state), true);
  assert.deepEqual(guest.getState(), state, 'a guest mirrors the host verbatim');

  // Applying the same payload twice must not drift, and neither must a
  // payload that came back out of a guest.
  guest.applyState(guest.getState());
  assert.deepEqual(guest.getState(), state);
  assert.equal(host.getState().feed.length, 2);
});

test('applyState adds unseen combatants, removes vanished ones, and keeps order', () => {
  const guest = new FreeForAllMatch();
  guest.register('player', 'You', { human: true });
  guest.register('bot-0', 'Admiral');

  guest.applyState({
    phase: 'playing',
    scoreLimit: 30,
    timeLimitSeconds: 300,
    elapsedSeconds: 12.5,
    remainingSeconds: 288,
    winnerId: null,
    standings: [
      { id: 'peer-x', name: 'Newcomer', human: true, kills: 4, deaths: 0, streak: 4, place: 1 },
      { id: 'player', name: 'You', human: true, kills: 1, deaths: 2, streak: 0, place: 2 },
    ],
    feed: [{ killerId: 'peer-x', killer: 'Newcomer', victimId: 'player', victim: 'You', at: 9 }],
  });

  const state = guest.getState();
  assert.deepEqual(state.standings.map((entry) => entry.id), ['peer-x', 'player']);
  assert.equal(state.standings[0].kills, 4);
  assert.equal(state.remainingSeconds, 288);
  assert.equal(guest.combatants.has('bot-0'), false, 'a combatant the host dropped is gone');
  assert.equal(state.feed[0].killer, 'Newcomer');

  // The scoreboard still works locally after a mirror, using the host's ids.
  guest.recordKill('player', 'peer-x');
  assert.equal(guest.getState().standings.find((entry) => entry.id === 'player').kills, 2);
});

test('applyState ignores garbage rather than corrupting the match', () => {
  const match = new FreeForAllMatch();
  match.register('player', 'You', { human: true });
  match.recordKill('player', 'player');
  const before = match.getState();

  for (const bad of [null, undefined, 42, 'playing', [], {}, { standings: [] },
    { standings: {}, feed: [] }, { standings: [], feed: null }]) {
    assert.equal(match.applyState(bad), false, JSON.stringify(bad ?? null));
  }
  assert.deepEqual(match.getState(), before);

  // A payload that is shaped right but carries nonsense rows is applied with
  // the rows it can read and the rest skipped.
  assert.equal(match.applyState({
    phase: 'nonsense', scoreLimit: -3, timeLimitSeconds: 0, elapsedSeconds: -5,
    winnerId: 7, standings: [null, { id: '' }, { id: 'a', name: 'A', kills: -2, deaths: 1.7 }],
    feed: [null, 'nope', { killer: 'A' }],
  }), true);
  const state = match.getState();
  assert.equal(state.phase, 'playing', 'an unknown phase falls back to playing');
  assert.equal(state.scoreLimit, before.scoreLimit, 'a nonsense limit keeps the local one');
  assert.equal(state.elapsedSeconds, 0);
  assert.equal(state.winnerId, null);
  assert.deepEqual(state.standings.map((entry) => entry.id), ['a']);
  assert.equal(state.standings[0].kills, 0);
  assert.equal(state.standings[0].deaths, 1);
  assert.deepEqual(state.feed, [{ killer: 'A' }]);
});
