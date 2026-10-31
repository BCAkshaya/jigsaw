import { createSocket, type Socket, type RemoteInfo } from 'node:dgram';
import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { Cipher, PeerLink } from './Link';

type Frame = { t: string; e: string; to?: string; n?: number; d?: string };
type Flight = { packet: Buffer; sent: number; attempts: number; first: number };
export type UdpOptions = {
  localPort: number;
  peerHost: string;
  peerPort: number;
  secret: string;
  timeoutMs?: number;
};

/** Selective-repeat, ordered transport. Each datagram stays below 1200 bytes. */
export class UdpLink extends PeerLink {
  label = 'Direct UDP';
  socket: Socket;
  private cipher: Cipher;
  private epoch = randomBytes(12).toString('hex');
  private remoteEpoch = '';
  private retired = new Set<string>();
  private endpoint: { address: string; port: number };
  private sequence = 0;
  private expected = 0;
  private queue: Buffer[] = [];
  private flight = new Map<number, Flight>();
  private received = new Map<number, Buffer>();
  private timer?: ReturnType<typeof setInterval>;
  private lastReceive = 0;
  private lastProbe = 0;
  private lastReflexive = 0;
  private rto = 400;
  private window = 8;
  private closed = false;
  retries = 0;
  rtt = 0;
  constructor(private options: UdpOptions) {
    super();
    if (!isIP(options.peerHost))
      throw Error('Enter a literal public IPv4 or IPv6 address.');
    this.cipher = new Cipher(options.secret);
    this.endpoint = { address: options.peerHost, port: options.peerPort };
    this.socket = createSocket(isIP(options.peerHost) === 6 ? 'udp6' : 'udp4');
    this.socket.on('message', (packet, source) => this.receive(packet, source));
    this.socket.on('error', (e) => {
      this.emit('status', e.message);
      this.reset();
    });
  }
  async start() {
    await new Promise<void>((resolve, reject) => {
      this.socket.once('error', reject);
      this.socket.bind(this.options.localPort, () => {
        this.socket.off('error', reject);
        resolve();
      });
    });
    this.emit('status', 'Punching: sending simultaneous probes every 250 ms.');
    this.timer = setInterval(() => this.tick(), 50);
    this.tick();
  }
  private encode(f: Frame) {
    return this.cipher.seal(Buffer.from(JSON.stringify(f)));
  }
  private datagram(packet: Buffer, target = this.endpoint) {
    if (this.closed) return;
    this.socket.send(packet, target.port, target.address, () => {});
  }
  private control(
    t: string,
    to = this.remoteEpoch,
    extra: Partial<Frame> = {},
    target = this.endpoint,
  ) {
    this.datagram(this.encode({ t, e: this.epoch, to, ...extra }), target);
  }
  private receive(packet: Buffer, source: RemoteInfo) {
    if (packet.length > 1200 || this.closed) return;
    let f: Frame;
    try {
      f = JSON.parse(this.cipher.open(packet).toString());
    } catch {
      return;
    }
    if (
      !f ||
      typeof f.e !== 'string' ||
      !/^[a-f0-9]{24}$/.test(f.e) ||
      f.e === this.epoch ||
      this.retired.has(f.e)
    )
      return;
    const endpoint = { address: source.address, port: source.port };
    if (f.t === 'hello') {
      this.control('welcome', f.e, {}, endpoint);
      if (!this.connected && Date.now() - this.lastReflexive > 100) {
        this.lastReflexive = Date.now();
        this.control('hello', '', {}, endpoint);
      }
      return;
    }
    if (f.to !== this.epoch) return;
    if (f.t === 'welcome') {
      if (this.remoteEpoch && this.remoteEpoch !== f.e) {
        this.retire(this.remoteEpoch);
        this.clear();
        this.state(false, 'Peer restarted. Reopening tunnel.');
      }
      this.remoteEpoch = f.e;
      this.endpoint = endpoint;
      this.lastReceive = Date.now();
      this.state(true, `Connected: ${endpoint.address}:${endpoint.port}`);
      this.flush();
      return;
    }
    if (!this.connected || f.e !== this.remoteEpoch) return;
    this.lastReceive = Date.now();
    this.endpoint = endpoint;
    if (f.t === 'ping') {
      this.control('pong');
      return;
    }
    if (f.t === 'pong') return;
    if (f.t === 'ack' && Number.isSafeInteger(f.n)) {
      const sent = this.flight.get(f.n!);
      if (!sent) return;
      if (sent.attempts === 1) {
        this.rtt = Date.now() - sent.sent;
        this.rto = Math.max(150, Math.min(2000, this.rtt * 2 + 100));
      }
      this.flight.delete(f.n!);
      this.window = Math.min(48, this.window + 1 / this.window);
      this.flush();
      if (this.queue.length < 128) this.emit('drain');
      return;
    }
    if (
      f.t !== 'data' ||
      !Number.isSafeInteger(f.n) ||
      f.n! < 0 ||
      typeof f.d !== 'string' ||
      f.d.length > 804
    )
      return;
    if (f.n! >= this.expected + 128) return;
    this.control('ack', this.remoteEpoch, { n: f.n });
    if (f.n! < this.expected) return;
    this.received.set(f.n!, Buffer.from(f.d, 'base64'));
    while (this.received.has(this.expected)) {
      const data = this.received.get(this.expected)!;
      this.received.delete(this.expected++);
      this.emit('data', data);
    }
  }
  private tick() {
    const now = Date.now();
    if (
      this.connected &&
      now - this.lastReceive > (this.options.timeoutMs || 12000)
    )
      this.reset();
    if (
      now - this.lastProbe >=
      (this.connected
        ? Math.min(2000, (this.options.timeoutMs || 12000) / 3)
        : 250)
    ) {
      this.lastProbe = now;
      if (this.connected) this.control('ping');
      else {
        this.control('hello');
        if (
          this.endpoint.port !== this.options.peerPort ||
          this.endpoint.address !== this.options.peerHost
        )
          this.control(
            'hello',
            '',
            {},
            { address: this.options.peerHost, port: this.options.peerPort },
          );
      }
    }
    let congestion = false;
    for (const f of this.flight.values()) {
      if (now - f.first > 30000) {
        this.reset();
        return;
      }
      if (
        now - f.sent >=
        Math.min(3000, this.rto * 1.5 ** Math.min(f.attempts - 1, 6))
      ) {
        this.datagram(f.packet);
        f.sent = now;
        f.attempts++;
        this.retries++;
        congestion = true;
      }
    }
    if (congestion) this.window = Math.max(2, this.window / 2);
    this.flush();
  }
  private flush() {
    while (
      this.connected &&
      this.queue.length &&
      this.flight.size < Math.floor(this.window)
    ) {
      const n = this.sequence++,
        data = this.queue.shift()!;
      const packet = this.encode({
        t: 'data',
        e: this.epoch,
        to: this.remoteEpoch,
        n,
        d: data.toString('base64'),
      });
      const now = Date.now();
      this.flight.set(n, { packet, sent: now, first: now, attempts: 1 });
      this.datagram(packet);
    }
  }
  send(data: Buffer) {
    if (!this.connected) throw Error('UDP peer is not connected.');
    if (data.length > 600) throw Error('UDP frame exceeds 600-byte payload.');
    if (this.queue.length > 16384) {
      this.reset();
      throw Error('UDP tunnel queue exceeded its limit.');
    }
    this.queue.push(data);
    this.flush();
    return this.queue.length < 256;
  }
  private clear() {
    this.sequence = 0;
    this.expected = 0;
    this.queue = [];
    this.flight.clear();
    this.received.clear();
    this.window = 8;
  }
  private retire(epoch: string) {
    this.retired.add(epoch);
    if (this.retired.size > 128)
      this.retired.delete(this.retired.values().next().value!);
  }
  private reset() {
    if (this.remoteEpoch) this.retire(this.remoteEpoch);
    this.remoteEpoch = '';
    this.epoch = randomBytes(12).toString('hex');
    this.clear();
    this.lastProbe = 0;
    this.state(false, 'Connection timed out. Re-punching automatically.');
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    this.state(false, 'Stopped');
    this.clear();
    try {
      this.socket.close();
    } catch {}
  }
}
