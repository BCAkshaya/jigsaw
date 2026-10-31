import * as THREE from 'three';
import { center, random } from './PuzzleState';
import type { Puzzle } from '../../../shared/types';
export function pieceGeometry(id: number, p: Puzzle) {
  const row = Math.floor(id / p.cols),
    col = id % p.cols,
    c = center(id, p);
  const sign = (key: number) => (random(p.seed + key * 137)() > 0.5 ? 1 : -1);
  const edges = [
    row === 0 ? 0 : sign(row * p.cols + col),
    col === p.cols - 1 ? 0 : sign(10000 + row * (p.cols + 1) + col + 1),
    row === p.rows - 1 ? 0 : -sign((row + 1) * p.cols + col),
    col === 0 ? 0 : -sign(10000 + row * (p.cols + 1) + col),
  ];
  const corners = [
    [-0.5, 0.5],
    [0.5, 0.5],
    [0.5, -0.5],
    [-0.5, -0.5],
  ];
  const s = new THREE.Shape();
  s.moveTo(c.x - 0.5, c.y + 0.5);
  for (let i = 0; i < 4; i++) {
    const a = corners[i],
      b = corners[(i + 1) % 4],
      dx = b[0] - a[0],
      dy = b[1] - a[1],
      tab = edges[i];
    const pt = (t: number, h: number) => [
      c.x + a[0] + dx * t - dy * h,
      c.y + a[1] + dy * t + dx * h,
    ];
    const line = (t: number, h: number) => {
      const v = pt(t, h);
      s.lineTo(v[0], v[1]);
    };
    const curve = (
      t1: number,
      h1: number,
      t2: number,
      h2: number,
      t3: number,
      h3: number,
    ) => {
      const a = pt(t1, h1),
        b = pt(t2, h2),
        c = pt(t3, h3);
      s.bezierCurveTo(a[0], a[1], b[0], b[1], c[0], c[1]);
    };
    if (tab) {
      line(0.36, 0);
      curve(0.46, 0, 0.3, 0.2 * tab, 0.5, 0.2 * tab);
      curve(0.7, 0.2 * tab, 0.54, 0, 0.64, 0);
    }
    line(1, 0);
  }
  const g = new THREE.ExtrudeGeometry(s, {
    depth: 0.055,
    bevelEnabled: true,
    bevelSegments: 2,
    steps: 1,
    bevelSize: 0.012,
    bevelThickness: 0.012,
    curveSegments: 10,
  });
  const pos = g.getAttribute('position'),
    uv = g.getAttribute('uv');
  for (let i = 0; i < pos.count; i++)
    uv.setXY(
      i,
      (pos.getX(i) + p.cols / 2) / p.cols,
      (pos.getY(i) + p.rows / 2) / p.rows,
    );
  return g;
}
