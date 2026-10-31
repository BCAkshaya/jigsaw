import { Server } from 'socket.io';
import type { Server as HttpServer } from 'node:http';

/** Deployable rendezvous service. Only encrypted SDP/ICE crosses this service. */
export function attachSignaling(http: HttpServer) {
  const io = new Server(http, {
    cors: { origin: '*' },
    maxHttpBufferSize: 128 * 1024,
  });
  const rooms = new Map<string, { host?: string; guest?: string }>();
  io.on('connection', (socket) => {
    let roomId = '',
      role: 'host' | 'guest';
    let count = 0,
      start = Date.now();
    socket.on('register', (data, ack) => {
      if (typeof ack !== 'function') return;
      if (
        roomId ||
        !/^[a-f0-9]{64}$/.test(data?.room) ||
        !['host', 'guest'].includes(data?.role)
      )
        return ack({ error: 'Invalid pairing request.' });
      if (rooms.size >= 1024 && !rooms.has(data.room))
        return ack({ error: 'Rendezvous server is full.' });
      const room = rooms.get(data.room) || {};
      role = data.role;
      if (room[role])
        return ack({
          error: `A ${role} is already using this connection key.`,
        });
      roomId = data.room;
      room[role] = socket.id;
      rooms.set(roomId, room);
      socket.join(roomId);
      ack({ ok: true });
      if (room.host && room.guest) io.to(roomId).emit('paired');
    });
    socket.on('signal', (packet) => {
      if (!roomId || typeof packet !== 'string' || packet.length > 100000)
        return;
      if (Date.now() - start > 10000) {
        count = 0;
        start = Date.now();
      }
      if (++count > 256) {
        socket.disconnect(true);
        return;
      }
      socket.to(roomId).emit('signal', packet);
    });
    socket.on('disconnect', () => {
      const room = rooms.get(roomId);
      if (!room) return;
      if (room[role] === socket.id) delete room[role];
      socket.to(roomId).emit('peer-left');
      if (!room.host && !room.guest) rooms.delete(roomId);
    });
  });
  return io;
}
