import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSocket, type Socket as DatagramSocket } from 'node:dgram';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { io as client, type Socket } from 'socket.io-client';
import { Server } from 'socket.io';
import { Cipher, PeerLink } from '../server/peer/Link';
import { UdpLink } from '../server/peer/UdpLink';
import { RacingLink } from '../server/peer/RacingLink';
import { TcpTunnel } from '../server/peer/TcpTunnel';
import { attachSignaling } from '../server/peer/signaling';
import { RoomManager } from '../server/RoomManager';
import { attachAuthority } from '../server/GameAuthority';

const secret = 'test-shared-key-at-least-24-characters';
class FakeLink extends PeerLink {
  label = 'Test route';
  other!: FakeLink;
  sent: Buffer[] = [];
  send(data: Buffer) {
    this.sent.push(Buffer.from(data));
    setImmediate(() => {
      if (this.connected && this.other.connected) this.other.emit('data', data);
    });
    return true;
  }
  up() {
    this.state(true, 'up');
  }
  close() {
    this.state(false, 'down');
  }
}
test('route election agrees across peers, fails over and ignores delayed old selections', async () => {
  const ha = new FakeLink(),
    ga = new FakeLink(),
    hb = new FakeLink(),
    gb = new FakeLink();
  ha.other = ga;
  ga.other = ha;
  hb.other = gb;
  gb.other = hb;
  ha.label = ga.label = 'UDP';
  hb.label = gb.label = 'WebRTC';
  const host = new RacingLink([ha, hb], 'host'),
    guest = new RacingLink([ga, gb], 'guest');
  try {
    ga.up();
    gb.up();
    ha.up();
    hb.up();
    await until(() => host.connected && guest.connected);
    assert.equal(host.label, guest.label);
    assert.equal(host.label, 'UDP');
    const stale = ha.sent.find((d) => d[0] === 240)!;
    ha.close();
    await until(
      () => host.connected && guest.connected && host.label === 'WebRTC',
    );
    assert.equal(guest.label, 'WebRTC');
    ga.emit('data', stale);
    await delay(30);
    assert.equal(guest.label, 'WebRTC');
  } finally {
    host.close();
    guest.close();
  }
});
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 10000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw Error('Timed out');
    await delay(20);
  }
}
async function bind(socket: DatagramSocket) {
  await new Promise<void>((r) => socket.bind(0, '127.0.0.1', r));
  return socket.address().port;
}
const ack = (socket: Socket, event: string, data: any) =>
  new Promise<any>((resolve, reject) =>
    socket
      .timeout(3000)
      .emit(event, data, (err: any, result: any) =>
        err ? reject(err) : resolve(result),
      ),
  );
async function pair(loss = false, timeoutMs = 12000) {
  const left = createSocket('udp4'),
    right = createSocket('udp4');
  const lp = await bind(left),
    rp = await bind(right);
  const a = new UdpLink({
    localPort: 0,
    peerHost: '127.0.0.1',
    peerPort: lp,
    secret,
    timeoutMs,
  });
  const b = new UdpLink({
    localPort: 0,
    peerHost: '127.0.0.1',
    peerPort: rp,
    secret,
    timeoutMs,
  });
  let blocked = false,
    count = 0;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  function forward(data: Buffer, socket: DatagramSocket, port: number) {
    if (blocked) return;
    const n = ++count;
    if (loss && n % 7 === 0) return;
    const timer = setTimeout(
      () => {
        timers.delete(timer);
        socket.send(data, port, '127.0.0.1');
        if (loss && n % 11 === 0) socket.send(data, port, '127.0.0.1');
      },
      loss ? (n % 3) * 10 : 0,
    );
    timers.add(timer);
  }
  await a.start();
  await b.start();
  left.on('message', (data) => forward(data, right, b.socket.address().port));
  right.on('message', (data) => forward(data, left, a.socket.address().port));
  return {
    a,
    b,
    block: (v: boolean) => (blocked = v),
    close: () => {
      a.close();
      b.close();
      for (const t of timers) clearTimeout(t);
      left.close();
      right.close();
    },
  };
}
test('encrypted datagrams reject tampering and a wrong key', () => {
  const cipher = new Cipher(secret),
    packet = cipher.seal(Buffer.from('private game'));
  assert.equal(cipher.open(packet).toString(), 'private game');
  packet[15] ^= 1;
  assert.throws(() => cipher.open(packet));
  assert.throws(() =>
    new Cipher('another-key-long-enough-to-be-valid').open(
      cipher.seal(Buffer.from('hello')),
    ),
  );
});
test(
  'TCP backpressure preserves a large binary transfer without unbounded resume loops',
  { timeout: 15000 },
  async () => {
    const bytes = randomBytes(1024 * 1024),
      http = createServer((_req, res) => res.end(bytes));
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
    const p = await pair(false),
      host = new RacingLink([p.a], 'host'),
      guest = new RacingLink([p.b], 'guest');
    const hostTunnel = new TcpTunnel(
        host,
        'host',
        (http.address() as any).port,
      ),
      guestTunnel = new TcpTunnel(guest, 'guest', 0);
    try {
      const port = await guestTunnel.listen(0);
      await until(() => host.connected && guest.connected);
      const response = await fetch(`http://127.0.0.1:${port}`, {
        signal: AbortSignal.timeout(10000),
      });
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    } finally {
      await guestTunnel.close();
      await hostTunnel.close();
      host.close();
      guest.close();
      p.close();
      http.closeAllConnections();
      await new Promise<void>((r) => http.close(() => r()));
    }
  },
);
test(
  'UDP recovers packet loss, duplicates and reordering without corrupting data',
  { timeout: 15000 },
  async () => {
    const p = await pair(true);
    try {
      await until(() => p.a.connected && p.b.connected);
      const received: string[] = [];
      p.b.on('data', (d) => received.push(d.toString()));
      const expected = Array.from(
        { length: 180 },
        (_, i) => `${i}:` + 'x'.repeat(300),
      );
      for (const data of expected) p.a.send(Buffer.from(data));
      await until(() => received.length === expected.length, 12000);
      assert.deepEqual(received, expected);
      assert.ok(p.a.retries > 0);
    } finally {
      p.close();
    }
  },
);
test(
  'UDP detects silence, re-punches and starts a fresh ordered session',
  { timeout: 10000 },
  async () => {
    const p = await pair(false, 700);
    try {
      await until(() => p.a.connected && p.b.connected);
      p.block(true);
      await until(() => !p.a.connected && !p.b.connected);
      p.block(false);
      await until(() => p.a.connected && p.b.connected);
      let received = '';
      p.b.on('data', (d) => (received = d.toString()));
      p.a.send(Buffer.from('after reconnect'));
      await until(() => !!received);
      assert.equal(received, 'after reconnect');
    } finally {
      p.close();
    }
  },
);
test('a wrong shared key never establishes a UDP connection', async () => {
  const a = new UdpLink({
    localPort: 0,
    peerHost: '127.0.0.1',
    peerPort: 9,
    secret,
  });
  await a.start();
  const b = new UdpLink({
    localPort: 0,
    peerHost: '127.0.0.1',
    peerPort: a.socket.address().port,
    secret: 'different-key-of-at-least-24-chars',
  });
  try {
    await b.start();
    await delay(450);
    assert.equal(a.connected, false);
    assert.equal(b.connected, false);
  } finally {
    a.close();
    b.close();
  }
});
test(
  'HTTP images and authoritative Socket.IO gameplay traverse the UDP TCP tunnel',
  { timeout: 20000 },
  async () => {
    const image = randomBytes(80000),
      http = createServer((_req, res) => res.end(image)),
      authority = new Server(http),
      manager = new RoomManager();
    manager.save = async () => {};
    const puzzle = manager.create('tunnel', '/sample.svg', 4, false);
    attachAuthority(authority, manager);
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
    const gamePort = (http.address() as any).port;
    const p = await pair(true),
      hostLink = new RacingLink([p.a], 'host'),
      guestLink = new RacingLink([p.b], 'guest');
    const hostTunnel = new TcpTunnel(hostLink, 'host', gamePort),
      guestTunnel = new TcpTunnel(guestLink, 'guest', gamePort);
    let guest: Socket | undefined;
    try {
      const forwarded = await guestTunnel.listen(0);
      await until(() => hostLink.connected && guestLink.connected);
      const response = await fetch(`http://127.0.0.1:${forwarded}/image`, {
        signal: AbortSignal.timeout(12000),
      });
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), image);
      guest = client(`http://127.0.0.1:${forwarded}`, {
        transports: ['websocket'],
        forceNew: true,
      });
      await until(() => guest!.connected);
      assert.equal(
        (await ack(guest, 'join', { id: puzzle.id, name: 'Over UDP' })).ok,
        true,
      );
      assert.equal((await ack(guest, 'pickup', 0)).ok, true);
      assert.equal(
        (await ack(guest, 'drop', { id: 0, x: 0, y: 0, rotation: 0 })).ok,
        true,
      );
      assert.equal(puzzle.groups[0].placed, true);
    } finally {
      guest?.disconnect();
      await guestTunnel.close();
      await hostTunnel.close();
      hostLink.close();
      guestLink.close();
      p.close();
      await new Promise<void>((r) => authority.close(() => r()));
    }
  },
);
test('rendezvous pairs two roles, rejects a third, relays opaque signaling and frees a departed seat', async () => {
  const http = createServer(),
    server = attachSignaling(http);
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(http.address() as any).port}`;
  const sockets = [0, 1, 2].map(() =>
    client(url, { forceNew: true, transports: ['websocket'] }),
  );
  try {
    await until(() => sockets.every((s) => s.connected));
    const [a, b, c] = sockets,
      room = 'a'.repeat(64);
    let paired = 0;
    a.on('paired', () => paired++);
    assert.equal((await ack(a, 'register', { room, role: 'host' })).ok, true);
    assert.equal((await ack(b, 'register', { room, role: 'guest' })).ok, true);
    await until(() => paired === 1);
    assert.ok((await ack(c, 'register', { room, role: 'guest' })).error);
    let signal = '';
    b.on('signal', (v) => (signal = v));
    a.emit('signal', 'opaque-encrypted-offer');
    await until(() => !!signal);
    assert.equal(signal, 'opaque-encrypted-offer');
    b.disconnect();
    await delay(50);
    assert.equal((await ack(c, 'register', { room, role: 'guest' })).ok, true);
  } finally {
    sockets.forEach((s) => s.disconnect());
    await new Promise<void>((r) => server.close(() => r()));
  }
});
