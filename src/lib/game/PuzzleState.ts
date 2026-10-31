import type { Puzzle, Group, Transform } from '../../../shared/types';
export function random(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function createGroups(
  rows: number,
  cols: number,
  seed: number,
  rotate: boolean,
): Group[] {
  const rng = random(seed);
  return Array.from({ length: rows * cols }, (_, id) => ({
    id,
    pieces: [id],
    x: (rng() - 0.5) * cols * 1.8,
    y: (rng() - 0.5) * rows * 1.8,
    rotation: rotate ? Math.floor(rng() * 4) : 0,
    lockedBy: null,
    placed: false,
  }));
}
export function center(id: number, p: Pick<Puzzle, 'cols' | 'rows'>) {
  return {
    x: (id % p.cols) - (p.cols - 1) / 2,
    y: (p.rows - 1) / 2 - Math.floor(id / p.cols),
  };
}
export function rotated(x: number, y: number, rotation: number) {
  const a = (rotation * Math.PI) / 2;
  return {
    x: x * Math.cos(a) - y * Math.sin(a),
    y: x * Math.sin(a) + y * Math.cos(a),
  };
}
export function validTransform(t: Transform, p: Puzzle) {
  return (
    t &&
    Number.isInteger(t.id) &&
    Number.isFinite(t.x) &&
    Number.isFinite(t.y) &&
    Math.abs(t.x) < p.cols * 4 &&
    Math.abs(t.y) < p.rows * 4 &&
    Number.isInteger(t.rotation) &&
    t.rotation >= 0 &&
    t.rotation < 4 &&
    (p.rotation || t.rotation === 0)
  );
}
export function neighbors(a: number, b: number, cols: number) {
  return (
    (Math.floor(a / cols) === Math.floor(b / cols) && Math.abs(a - b) === 1) ||
    Math.abs(a - b) === cols
  );
}
// Every group uses a common puzzle-space transform; merging is independent of geometry.
export function snap(p: Puzzle, g: Group): number {
  let joined = 0;
  if (g.rotation === 0 && Math.hypot(g.x, g.y) < 0.28) {
    g.x = 0;
    g.y = 0;
    g.placed = true;
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const other of [...p.groups]) {
      if (
        other === g ||
        other.lockedBy ||
        other.rotation !== g.rotation ||
        Math.hypot(other.x - g.x, other.y - g.y) > 0.28
      )
        continue;
      if (
        !g.pieces.some((a) => other.pieces.some((b) => neighbors(a, b, p.cols)))
      )
        continue;
      g.x = other.x;
      g.y = other.y;
      g.placed ||= other.placed;
      if (g.placed) {
        g.x = 0;
        g.y = 0;
        g.rotation = 0;
      }
      g.pieces.push(...other.pieces);
      p.groups.splice(p.groups.indexOf(other), 1);
      joined++;
      changed = true;
    }
  }
  p.completed = p.groups.length === 1 && p.groups[0].placed;
  return joined;
}
