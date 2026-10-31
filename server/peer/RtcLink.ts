import type { Socket } from 'socket.io';
import { PeerLink } from './Link';

/** Browser WebRTC is exposed as a local transport to the fixed-port TCP tunnel. */
export class RtcLink extends PeerLink {
  label = 'WebRTC / ICE';
  private socket?: Socket;
  private pending = 0;
  attach(socket: Socket) {
    this.socket?.disconnect(true);
    this.socket = socket;
    socket.on('rtc:state', (state: string) => {
      if (state === 'connected')
        this.state(true, 'WebRTC data channel connected.');
      else this.state(false, String(state).slice(0, 160));
    });
    socket.on('rtc:data', (data: unknown) => {
      if (this.connected && Buffer.isBuffer(data) && data.length <= 600)
        this.emit('data', data);
    });
    socket.on('disconnect', () => {
      if (this.socket === socket) {
        this.socket = undefined;
        this.pending = 0;
        this.state(false, 'Keep Connection options open for WebRTC.');
      }
    });
  }
  send(data: Buffer) {
    if (!this.socket || !this.connected)
      throw Error('WebRTC is not connected.');
    this.pending += data.length;
    if (this.pending > 4 * 1024 * 1024) {
      this.socket.disconnect(true);
      throw Error('WebRTC queue limit exceeded.');
    }
    const owner = this.socket;
    owner
      .timeout(15000)
      .emit('rtc:send', data, (err: unknown, result: boolean) => {
        if (owner !== this.socket) return;
        this.pending = Math.max(0, this.pending - data.length);
        if (err || !result) {
          this.state(false, 'WebRTC interrupted. Reconnecting.');
          owner.emit('rtc:restart');
        } else if (this.pending < 64 * 1024) this.emit('drain');
      });
    return this.pending < 128 * 1024;
  }
  close() {
    this.state(false, 'Stopped');
    this.socket?.emit('rtc:stop');
    this.socket?.disconnect(true);
    this.socket = undefined;
    this.pending = 0;
  }
}
