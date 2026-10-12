import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import * as engine from '../src/game/engine.js';

/**
 * test/fixtures/kotlin-traces.json.gz was produced by running the app's Kotlin LudoEngine through 60 seeded random
 * games (2, 3 and 4 players, every colour as host). Each step records the action and the resulting state + events.
 * Replaying the same actions through the JS port must reproduce every state exactly.
 */
const traces = JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/kotlin-traces.json.gz', import.meta.url))).toString());

test('JS engine reproduces the Kotlin engine on 60 full games', () => {
  let steps = 0;
  for (const [g, trace] of traces.entries()) {
    let state = engine.newGame(trace.players);
    for (const [i, step] of trace.steps.entries()) {
      const where = `game ${g} step ${i}`;
      const result = step.roll !== undefined ? engine.roll(state, step.roll) : engine.move(state, step.move);
      state = result.state;
      const e = step.expect;
      assert.equal(state.currentPlayerIndex, e.currentPlayerIndex, where);
      assert.equal(state.phase, e.phase, where);
      assert.equal(state.dice, e.dice, where);
      assert.equal(state.consecutiveSixes, e.consecutiveSixes, where);
      assert.equal(state.turnNumber, e.turnNumber, where);
      assert.deepEqual([...state.tokens].sort((a, b) => a.id - b.id).map((t) => [t.id, t.step]), e.steps, where);
      assert.deepEqual(state.legalMoves, e.legalMoves, where);
      assert.deepEqual(state.finishOrder, e.finishOrder, where);
      assert.deepEqual(result.events.map((ev) => ev.type), e.events, where);
      steps++;
    }
    assert.equal(state.phase, 'GAME_OVER', `game ${g} finished`);
  }
  assert.ok(steps > 10_000, `replayed ${steps} steps`);
});

test('rejects illegal actions', () => {
  const s = engine.newGame([{ color: 'BLUE', name: 'A' }, { color: 'GREEN', name: 'B' }]);
  assert.throws(() => engine.roll(s, 7));
  assert.throws(() => engine.move(s, { tokenId: 0, fromStep: -1, toStep: 0, dice: 6 }));
  const rolled = engine.roll(s, 6).state;
  assert.equal(rolled.phase, 'MOVE');
  assert.throws(() => engine.roll(rolled, 3));
  assert.throws(() => engine.move(rolled, { tokenId: rolled.legalMoves[0].tokenId, fromStep: -1, toStep: 5, dice: 6 }));
});

test('auto-move prefers a capture', () => {
  let s = engine.newGame([{ color: 'BLUE', name: 'A' }, { color: 'GREEN', name: 'B' }]);
  // GREEN token on track index 30 (step 17); BLUE token 4 behind it (index 26 is GREEN start → BLUE step 39).
  s = { ...s, tokens: s.tokens.map((t) => (t.id === engine.tokenId('GREEN', 0) ? { ...t, step: 17 } : t.id === engine.tokenId('BLUE', 0) ? { ...t, step: 39 } : t.id === engine.tokenId('BLUE', 1) ? { ...t, step: 2 } : t)) };
  s = { ...s, currentPlayerIndex: s.players.findIndex((p) => p.color === 'BLUE') };
  const rolled = engine.roll(s, 4).state;
  assert.equal(engine.chooseAutoMove(rolled).tokenId, engine.tokenId('BLUE', 0));
});
