import {
  createServer,
  createConnection,
  type Server,
  type Socket,
} from 'node:net';
import type { PeerLink } from './Link';

// A fixed-destination TCP tunnel: only the host's game port can be reached.
// The management port is never a tunnel destination.
export class TcpTunnel {
  private streams = new Map<number, Socket>();
  private server?: Server;
  private next = 0;
  private closed = false;
  private blocked = new Set<Socket>();
  private remotePaused = new Set<Socket>();
  constructor(
    private link: PeerLink,
    private role: 'host' | 'guest',
    private gamePort: number,
  ) {
    link.on('data', this.receive);
    link.on('down', this.reset);
    link.on('drain', this.drain);
  }
  async listen(port: number) {
    if (this.role !== 'guest') return;
    this.server = createServer({ allowHalfOpen: true }, (socket) => {
      if (!this.link.connected || this.streams.size >= 32) {
        socket.destroy();
        return;
      }
      const id = ++this.next;
      this.attach(id, socket);
      this.frame(1, id);
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(port, '127.0.0.1', () => {
        this.server!.off('error', reject);
        resolve();
      });
    });
    return (this.server.address() as { port: number }).port;
  }
  private frame(type: number, id: number, data = Buffer.alloc(0)) {
    if (!this.link.connected) return false;
    const header = Buffer.alloc(5);
    header[0] = type;
    header.writeUInt32BE(id, 1);
    try {
      return this.link.send(Buffer.concat([header, data]));
    } catch {
      this.reset();
      return false;
    }
  }
  private attach(id: number, socket: Socket) {
    this.streams.set(id, socket);
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 5000);
    socket.on('data', (data) => {
      for (let i = 0; i < data.length; i += 590) {
        if (!this.frame(2, id, data.subarray(i, i + 590))) {
          socket.pause();
          this.blocked.add(socket);
        }
      }
    });
    socket.on('end', () => this.frame(3, id));
    socket.on('error', () => {});
    socket.on('close', () => {
      this.remotePaused.delete(socket);
      if (this.streams.get(id) !== socket) return;
      this.streams.delete(id);
      this.blocked.delete(socket);
      this.frame(4, id);
    });
    socket.on('drain', () => this.frame(6, id));
  }
  private receive = (data: Buffer) => {
    if (data.length < 5 || this.closed) return;
    const type = data[0],
      id = data.readUInt32BE(1);
    let socket = this.streams.get(id);
    if (type === 1) {
      if (this.role !== 'host' || socket || this.streams.size >= 32) return;
      socket = createConnection({
        host: '127.0.0.1',
        port: this.gamePort,
        allowHalfOpen: true,
      });
      this.attach(id, socket);
      return;
    }
    if (!socket) return;
    if (type === 2) {
      if (socket.writableLength > 2 * 1024 * 1024) {
        socket.destroy();
        return;
      }
      if (!socket.write(data.subarray(5))) this.frame(5, id);
    } else if (type === 3) socket.end();
    else if (type === 4) {
      this.streams.delete(id);
      this.blocked.delete(socket);
      socket.destroy();
    } else if (type === 5) {
      this.remotePaused.add(socket);
      socket.pause();
      socket.setTimeout(30000, () => socket?.destroy());
    } else if (type === 6) {
      this.remotePaused.delete(socket);
      socket.setTimeout(0);
      if (!this.blocked.has(socket)) socket.resume();
    }
  };
  private drain = () => {
    for (const socket of this.blocked)
      if (!this.remotePaused.has(socket)) socket.resume();
    this.blocked.clear();
  };
  private reset = () => {
    const sockets = [...this.streams.values()];
    this.streams.clear();
    this.blocked.clear();
    this.remotePaused.clear();
    for (const socket of sockets) socket.destroy();
  };
  async close() {
    this.closed = true;
    this.reset();
    this.link.off('data', this.receive);
    this.link.off('down', this.reset);
    this.link.off('drain', this.drain);
    if (this.server?.listening)
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }
}
