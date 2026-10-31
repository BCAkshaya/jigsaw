import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { io, type Socket } from 'socket.io-client';
import { RoomManager } from '../server/RoomManager';
import { attachAuthority } from '../server/GameAuthority';
const ack = (s: Socket, event: string, data: any) =>
  new Promise<any>((resolve, reject) =>
    s
      .timeout(2000)
      .emit(event, data, (err: any, result: any) =>
        err ? reject(err) : resolve(result),
      ),
  );
const until = (
  s: Socket,
  event: string,
  predicate: (p: any) => boolean = () => true,
) =>
  new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => {
      s.off(event, handle);
      reject(Error('Timed out: ' + event));
    }, 3000);
    function handle(p: any) {
      if (predicate(p)) {
        clearTimeout(timer);
        s.off(event, handle);
        resolve(p);
      }
    }
    s.on(event, handle);
  });
test('two clients: lock race, unauthorized moves, drop, disconnect and recovery', async () => {
  const server = createServer(),
    ioServer = new Server(server),
    manager = new RoomManager();
  manager.save = async () => {};
  const p = manager.create('network', '/sample.svg', 4, false);
  p.groups.forEach((g, i) => Object.assign(g, { x: 5 + i, y: 5, rotation: 0 }));
  attachAuthority(ioServer, manager);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as any).port;
  const clients = [0, 1, 2].map(() =>
    io(`http://127.0.0.1:${port}`, {
      transports: ['websocket'],
      forceNew: true,
    }),
  );
  try {
    await Promise.all(clients.map((c) => until(c, 'connect')));
    const [a, b, c] = clients;
    assert.equal((await ack(a, 'join', { id: p.id, name: 'A' })).ok, true);
    assert.equal((await ack(b, 'join', { id: p.id, name: 'B' })).ok, true);
    assert.ok((await ack(c, 'join', { id: p.id })).error);
    const results = await Promise.all([
      ack(a, 'pickup', 0),
      ack(b, 'pickup', 0),
    ]);
    assert.equal(results.filter((r) => r.ok).length, 1);
    const winner = results[0].ok ? a : b,
      loser = winner === a ? b : a;
    loser.emit('move', { id: 0, x: 0, y: 0, rotation: 0 });
    assert.equal((await ack(loser, 'pickup', 0)).ok, false);
    assert.equal(p.groups[0].x, 5);
    const update = until(
      loser,
      'state',
      (p) => p.groups.find((g: any) => g.id === 0)?.placed,
    );
    assert.equal(
      (await ack(winner, 'drop', { id: 0, x: 0.01, y: 0.01, rotation: 0 })).ok,
      true,
    );
    await update;
    assert.equal(p.groups[0].placed, true);
    assert.equal((await ack(winner, 'pickup', 1)).ok, true);
    const unlocked = until(
      loser,
      'state',
      (p) =>
        p.players.length === 1 &&
        p.groups.find((g: any) => g.id === 1)?.lockedBy === null,
    );
    winner.disconnect();
    await unlocked;
    assert.equal((await ack(loser, 'pickup', 1)).ok, true);
    assert.equal(
      (await ack(loser, 'drop', { id: 1, x: 6, y: 5, rotation: 0 })).ok,
      true,
    );
    const snapshot = until(c, 'state');
    assert.equal(
      (await ack(c, 'join', { id: p.id, name: 'Rejoined' })).ok,
      true,
    );
    const recovered = await snapshot;
    assert.equal(recovered.groups.find((g: any) => g.id === 0).placed, true);
  } finally {
    clients.forEach((c) => c.disconnect());
    await new Promise<void>((r) => ioServer.close(() => r()));
  }
});
