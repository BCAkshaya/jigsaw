import { EventEmitter } from 'node:events';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from 'node:crypto';

export abstract class PeerLink extends EventEmitter {
  connected = false;
  abstract label: string;
  abstract send(data: Buffer): boolean;
  abstract close(): void;
  protected state(connected: boolean, detail: string) {
    const changed = this.connected !== connected;
    this.connected = connected;
    this.emit('status', detail);
    if (changed) this.emit(connected ? 'up' : 'down');
  }
}

// Both the raw datagrams and broker-carried signaling are authenticated.
export class Cipher {
  private key: Buffer;
  constructor(secret: string) {
    if (secret.length < 24 || secret.length > 256)
      throw Error('Use a shared connection key of 24–256 characters.');
    this.key = scryptSync(secret, 'jigsaw-peer-v1', 32);
  }
  seal(data: Buffer): Buffer {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    return Buffer.concat([
      nonce,
      cipher.update(data),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
  }
  open(packet: Buffer): Buffer {
    if (packet.length < 28) throw Error('Short packet');
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.key,
      packet.subarray(0, 12),
    );
    decipher.setAuthTag(packet.subarray(-16));
    return Buffer.concat([
      decipher.update(packet.subarray(12, -16)),
      decipher.final(),
    ]);
  }
}
