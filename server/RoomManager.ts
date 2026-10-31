import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { Puzzle } from '../shared/types';
import { createGroups } from '../src/lib/game/PuzzleState';
export class RoomManager {
  rooms = new Map<string, Puzzle>();
  constructor(private directory = 'data') {}
  async load() {
    await mkdir(join(this.directory, 'uploads'), { recursive: true });
    try {
      const saved = JSON.parse(
        await readFile(join(this.directory, 'rooms.json'), 'utf8'),
      );
      for (const p of saved) {
        p.players = [];
        p.groups.forEach((g: any) => (g.lockedBy = null));
        this.rooms.set(p.id, p);
      }
    } catch (e: any) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
  create(title: string, image: string, size: number, rotation: boolean) {
    const id = randomBytes(12).toString('hex');
    const seed = randomBytes(4).readUInt32LE();
    const p: Puzzle = {
      id,
      title,
      image,
      rows: size,
      cols: size,
      seed,
      rotation,
      groups: createGroups(size, size, seed, rotation),
      players: [],
      created: Date.now(),
      completed: false,
    };
    this.rooms.set(id, p);
    return p;
  }
  private pending: Promise<void> = Promise.resolve();
  save() {
    const json = JSON.stringify([...this.rooms.values()]);
    this.pending = this.pending
      .catch(() => {})
      .then(async () => {
        await writeFile(join(this.directory, 'rooms.tmp'), json);
        await rename(
          join(this.directory, 'rooms.tmp'),
          join(this.directory, 'rooms.json'),
        );
      });
    return this.pending;
  }
}
