import type { Server } from 'socket.io';
import type { Transform } from '../shared/types';
import { snap, validTransform } from '../src/lib/game/PuzzleState';
import type { RoomManager } from './RoomManager';
export function attachAuthority(io: Server, manager: RoomManager) {
  io.on('connection', (socket) => {
    let roomId = '';
    let lastMove = 0;
    let lastCursor = 0;
    const room = () => manager.rooms.get(roomId);
    const broadcast = () => {
      const p = room();
      if (p) io.to(roomId).emit('state', p);
    };
    const save = () => {
      void manager
        .save()
        .catch((e) => console.error('Save failed:', e.message));
    };
    socket.on('join', (data, ack) => {
      if (typeof ack !== 'function') return;
      if (roomId) return ack({ error: 'Already in a room.' });
      const p = manager.rooms.get(data?.id);
      if (!p) return ack({ error: 'Room not found.' });
      if (p.players.length >= 2)
        return ack({ error: 'This room already has two players.' });
      roomId = p.id;
      socket.join(roomId);
      const color = p.players.some((p) => p.color === '#e9ac73')
        ? '#9ecdb7'
        : '#e9ac73';
      p.players.push({
        id: socket.id,
        name: String(data.name || 'Guest').slice(0, 24),
        color,
      });
      ack({ ok: true });
      broadcast();
    });
    socket.on('pickup', (id, ack) => {
      if (typeof ack !== 'function') return;
      const p = room(),
        g = p?.groups.find((g) => g.id === id);
      if (
        !g ||
        g.placed ||
        g.lockedBy ||
        p!.groups.some((g) => g.lockedBy === socket.id)
      )
        return ack({ ok: false });
      g.lockedBy = socket.id;
      ack({ ok: true, group: g });
      broadcast();
    });
    socket.on('move', (t: Transform) => {
      const p = room();
      if (!p || !validTransform(t, p) || Date.now() - lastMove < 24) return;
      const g = p.groups.find((g) => g.id === t.id);
      if (!g || g.lockedBy !== socket.id) return;
      lastMove = Date.now();
      Object.assign(g, { x: t.x, y: t.y, rotation: t.rotation });
      socket.to(roomId).volatile.emit('transform', t);
    });
    socket.on('drop', (t: Transform, ack) => {
      const p = room();
      if (!p || !validTransform(t, p)) return;
      const g = p.groups.find((g) => g.id === t.id);
      if (!g || g.lockedBy !== socket.id) return;
      Object.assign(g, {
        x: t.x,
        y: t.y,
        rotation: t.rotation,
        lockedBy: null,
      });
      const joined = snap(p, g);
      broadcast();
      save();
      if (typeof ack === 'function')
        ack({ ok: true, joined, placed: g.placed });
    });
    socket.on('cursor', (v) => {
      if (
        !room() ||
        !v ||
        !Number.isFinite(v.x) ||
        !Number.isFinite(v.y) ||
        Math.abs(v.x) > 100 ||
        Math.abs(v.y) > 100 ||
        Date.now() - lastCursor < 32
      )
        return;
      lastCursor = Date.now();
      socket
        .to(roomId)
        .volatile.emit('cursor', { id: socket.id, x: v.x, y: v.y });
    });
    socket.on('disconnect', () => {
      const p = room();
      if (!p) return;
      p.players = p.players.filter((p) => p.id !== socket.id);
      p.groups.forEach((g) => {
        if (g.lockedBy === socket.id) {
          g.lockedBy = null;
          snap(p, g);
        }
      });
      broadcast();
      save();
    });
  });
}
