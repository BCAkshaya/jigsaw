export type Group = {
  id: number;
  pieces: number[];
  x: number;
  y: number;
  rotation: number;
  lockedBy: string | null;
  placed: boolean;
};
export type Player = { id: string; name: string; color: string };
export type Puzzle = {
  id: string;
  title: string;
  image: string;
  rows: number;
  cols: number;
  seed: number;
  rotation: boolean;
  groups: Group[];
  players: Player[];
  created: number;
  completed: boolean;
};
export type Transform = { id: number; x: number; y: number; rotation: number };
