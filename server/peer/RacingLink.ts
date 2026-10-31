import { PeerLink } from './Link';
import { randomBytes } from 'node:crypto';

// Pin TCP streams to one route. Route changes close streams so HTTP/Socket.IO
// reconnect cleanly instead of mixing sequence spaces or silently losing bytes.
export class RacingLink extends PeerLink {
  label = 'Waiting';
  private active?: PeerLink;
  private timer: ReturnType<typeof setInterval>;
  private epoch = randomBytes(8).toString('hex');
  private election = 0;
  private hostEpoch = '';
  private hostElection = 0;
  private retired = new Set<string>();
  constructor(
    public links: PeerLink[],
    private role: 'host' | 'guest',
  ) {
    super();
    for (const link of links) {
      link.on('up', () => {
        if (!this.active && role === 'host') this.choose(link);
      });
      link.on('down', () => {
        if (this.active !== link) return;
        this.active = undefined;
        this.state(false, 'Route interrupted. Looking for another connection.');
        const backup = links.find((l) => l.connected);
        if (backup && role === 'host') this.choose(backup);
      });
      link.on('data', (data: Buffer) => {
        if (data.length === 13 && data[0] === 240 && role === 'guest') {
          const epoch = data.subarray(1, 9).toString('hex'),
            election = data.readUInt32BE(9);
          if (
            this.retired.has(epoch) ||
            (epoch === this.hostEpoch && election < this.hostElection)
          )
            return;
          if (this.hostEpoch && epoch !== this.hostEpoch) {
            this.retired.add(this.hostEpoch);
            if (this.retired.size > 128)
              this.retired.delete(this.retired.values().next().value!);
          }
          this.hostEpoch = epoch;
          this.hostElection = election;
          if (this.active !== link) {
            if (this.active) this.state(false, 'Switching route');
            this.active = link;
            this.label = link.label;
            this.state(true, `${link.label} selected`);
          }
          const ack = Buffer.from(data);
          ack[0] = 241;
          link.send(ack);
          return;
        }
        if (
          data.length === 13 &&
          data[0] === 241 &&
          role === 'host' &&
          this.active === link &&
          data.subarray(1, 9).toString('hex') === this.epoch &&
          data.readUInt32BE(9) === this.election
        ) {
          this.state(true, `${link.label} selected`);
          return;
        }
        if (this.connected && this.active === link) this.emit('data', data);
      });
      link.on('drain', () => {
        if (this.active === link) this.emit('drain');
      });
      link.on('status', (detail) =>
        this.emit('route-status', { route: link.label, detail }),
      );
    }
    this.timer = setInterval(() => {
      if (role === 'host' && this.active?.connected && !this.connected)
        this.active.send(this.marker());
    }, 1000);
  }
  private choose(link: PeerLink) {
    this.active = link;
    this.label = link.label;
    this.election++;
    link.send(this.marker());
  }
  private marker() {
    const data = Buffer.alloc(13);
    data[0] = 240;
    Buffer.from(this.epoch, 'hex').copy(data, 1);
    data.writeUInt32BE(this.election, 9);
    return data;
  }
  send(data: Buffer) {
    if (!this.active) throw Error('No peer route available.');
    return this.active.send(data);
  }
  close() {
    clearInterval(this.timer);
    this.active = undefined;
    this.state(false, 'Stopped');
    for (const link of this.links) link.close();
  }
}
