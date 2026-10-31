import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createGroups,
  snap,
  validTransform,
  neighbors,
} from '../src/lib/game/PuzzleState';
import { RoomManager } from '../server/RoomManager';
import { pieceGeometry } from '../src/lib/game/PieceGeometry';
const puzzle = () => new RoomManager().create('test', '/sample.svg', 4, true);

test('queued disk saves recover latest transforms and clear stale player locks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jigsaw-test-'));
  try {
    const manager = new RoomManager(directory);
    await manager.load();
    const p = manager.create('Saved puzzle', '/sample.svg', 4, true);
    p.players.push({ id: 'disconnected', name: 'A', color: '#fff' });
    p.groups[0].lockedBy = 'disconnected';
    const first = manager.save();
    p.groups[0].x = 3.25;
    const second = manager.save();
    await Promise.all([first, second]);
    const restored = new RoomManager(directory);
    await restored.load();
    const recovered = restored.rooms.get(p.id)!;
    assert.equal(recovered.groups[0].x, 3.25);
    assert.equal(recovered.groups[0].lockedBy, null);
    assert.deepEqual(recovered.players, []);
    assert.equal(recovered.seed, p.seed);
  } finally {
    await rm(join(directory, 'rooms.json'), { force: true });
    await rmdir(join(directory, 'uploads'));
    await rmdir(directory);
  }
});
test('same seed generates identical piece transforms', () => {
  assert.deepEqual(
    createGroups(10, 10, 123, true),
    createGroups(10, 10, 123, true),
  );
  assert.notDeepEqual(
    createGroups(10, 10, 123, true),
    createGroups(10, 10, 124, true),
  );
});
test('neighbors never wrap across row boundaries', () => {
  assert.equal(neighbors(3, 4, 4), false);
  assert.equal(neighbors(3, 7, 4), true);
});
test('adjacent groups join and move as one cluster', () => {
  const p = puzzle(),
    a = p.groups[0],
    b = p.groups[1];
  p.groups.forEach((g, i) => {
    g.x = 20 + i;
    g.y = 20;
  });
  Object.assign(a, { x: 3, y: 3, rotation: 1 });
  Object.assign(b, { x: 3.1, y: 3, rotation: 1 });
  assert.equal(snap(p, a), 1);
  assert.deepEqual(a.pieces, [0, 1]);
  assert.equal(p.groups.length, 15);
  assert.equal(a.x, 3.1);
});
test('locked groups and wrong rotations cannot merge', () => {
  const p = puzzle(),
    a = p.groups[0],
    b = p.groups[1];
  p.groups.forEach((g, i) => {
    g.x = 20 + i;
    g.y = 20;
  });
  Object.assign(a, { x: 3, y: 3, rotation: 0 });
  Object.assign(b, { x: 3, y: 3, rotation: 0, lockedBy: 'other' });
  assert.equal(snap(p, a), 0);
  b.lockedBy = null;
  b.rotation = 1;
  assert.equal(snap(p, a), 0);
});
test('a dropped group snaps to the board and completion cascades', () => {
  const p = puzzle();
  p.groups.forEach((g) => Object.assign(g, { x: 0.05, y: 0.05, rotation: 0 }));
  assert.equal(snap(p, p.groups[0]), 15);
  assert.equal(p.completed, true);
  assert.equal(p.groups[0].pieces.length, 16);
  assert.equal(p.groups[0].placed, true);
});
test('rotation and distance prevent incorrect board placement', () => {
  const p = puzzle(),
    g = p.groups[0];
  Object.assign(g, { x: 0, y: 0, rotation: 1 });
  snap(p, g);
  assert.equal(g.placed, false);
  Object.assign(g, { x: 2, y: 2, rotation: 0 });
  snap(p, g);
  assert.equal(g.placed, false);
});
test('reject malformed and forbidden transforms', () => {
  const p = puzzle();
  assert.equal(validTransform({ id: 0, x: NaN, y: 0, rotation: 0 }, p), false);
  assert.equal(validTransform({ id: 0, x: 0, y: 0, rotation: 0.2 }, p), false);
  p.rotation = false;
  assert.equal(validTransform({ id: 0, x: 0, y: 0, rotation: 1 }, p), false);
  assert.equal(validTransform({ id: 0, x: 0, y: 0, rotation: 0 }, p), true);
});
test('all generated pieces have finite vertices and UVs', () => {
  const p = puzzle();
  for (let id = 0; id < 16; id++) {
    const g = pieceGeometry(id, p);
    for (const name of ['position', 'uv'])
      assert.ok(Array.from(g.getAttribute(name).array).every(Number.isFinite));
    g.dispose();
  }
});
