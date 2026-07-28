import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DB_SOURCES } from '../src/db-sources.js';

test('DB_SOURCES has 8 entries', () => {
  assert.equal(DB_SOURCES.length, 8);
});

test('loopd.entries serializer', () => {
  const source = DB_SOURCES.find((s) => s.schema === 'loopd' && s.table === 'entries')!;
  const row = { id: 'e1', date: '2024-01-15', text: 'Feeling good today.' };
  assert.equal(source.toId(row), 'loopd/entries/e1');
  assert.equal(source.toText(row), 'Journal entry 2024-01-15: Feeling good today.');
});

test('contrl.sessions serializer — passed', () => {
  const source = DB_SOURCES.find((s) => s.table === 'sessions')!;
  const row = { id: 's1', date: '2024-01-15T10:00:00Z', level: 3, category: 'push', notes: 'Hard session.', passed: true };
  assert.equal(source.toId(row), 'contrl/sessions/s1');
  assert.ok(source.toText(row).includes('passed'));
  assert.ok(source.toText(row).includes('Hard session'));
});

test('contrl.sessions serializer — failed, null notes', () => {
  const source = DB_SOURCES.find((s) => s.table === 'sessions')!;
  const row = { id: 's2', date: '2024-01-16T10:00:00Z', level: 2, category: 'pull', notes: null, passed: false };
  assert.ok(source.toText(row).includes('failed'));
  assert.ok(!source.toText(row).includes('null'));
});

test('contrl.exercises serializer — null notes', () => {
  const source = DB_SOURCES.find((s) => s.table === 'exercises')!;
  const row = { id: 'ex1', name: 'Push-up', category: 'push', level: 1, target_sets: 3, target_reps: 10, notes: null };
  assert.ok(source.toText(row).startsWith('Exercise: Push-up'));
  assert.ok(!source.toText(row).includes('null'));
});
