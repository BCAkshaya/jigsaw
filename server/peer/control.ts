import express from 'express';
import { createServer } from 'node:http';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import { UdpLink } from './UdpLink';
import { RtcLink } from './RtcLink';
import { RacingLink } from './RacingLink';
import { TcpTunnel } from './TcpTunnel';

type Config = {
  role: 'host' | 'guest';
  mode: 'udp' | 'webrtc' | 'auto';
  secret: string;
  localPort: number;
  peerHost: string;
  peerPort: number;
  forwardPort: number;
  signalUrl: string;
  iceServers: { urls: string; username?: string; credential?: string }[];
};
const portNumber = (value: unknown, fallback: number) => {
  const n = Number(value ?? fallback);
  if (!Number.isInteger(n) || n < 1024 || n > 65535)
    throw Error('Ports must be between 1024 and 65535.');
  return n;
};
export async function startPeerControl(gamePort: number, controlPort = 3002) {
  const app = express(),
    http = createServer(app);
  const allowedHosts = new Set([
    `localhost:${controlPort}`,
    `127.0.0.1:${controlPort}`,
  ]);
  const sameOrigin = (origin: string | undefined) =>
    !origin || [...allowedHosts].some((host) => origin === `http://${host}`);
  app.use((req, res, next) => {
    if (
      !allowedHosts.has(req.headers.host || '') ||
      !sameOrigin(req.headers.origin)
    ) {
      res
        .status(403)
        .json({ error: 'Open Connection options on this computer.' });
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });
  app.use(express.json({ limit: '8kb' }));
  const io = new Server(http, {
    maxHttpBufferSize: 64 * 1024,
    allowRequest: (req, done) =>
      done(
        null,
        allowedHosts.has(req.headers.host || '') &&
          sameOrigin(req.headers.origin),
      ),
  });
  let config: Config | undefined,
    udp: UdpLink | undefined,
    rtc: RtcLink | undefined,
    race: RacingLink | undefined,
    tunnel: TcpTunnel | undefined;
  let changing = false;
  let detail = 'Choose a connection method.',
    routes: Record<string, string> = {};
  const stop = async () => {
    config = undefined;
    await tunnel?.close();
    tunnel = undefined;
    race?.close();
    race = undefined;
    udp = undefined;
    rtc = undefined;
    routes = {};
    detail = 'Stopped';
  };
  app.get('/', (_req, res) =>
    res.sendFile(fileURLToPath(new URL('./control.html', import.meta.url))),
  );
  app.get('/control.js', (_req, res) =>
    res.sendFile(fileURLToPath(new URL('./control.js', import.meta.url))),
  );
  app.get('/api/status', (_req, res) =>
    res.json({
      running: !!config,
      connected: race?.connected || false,
      route: race?.connected ? race.label : null,
      detail,
      routes,
      role: config?.role,
      gamePort,
      forwardPort: config?.forwardPort,
      udpPort: udp ? config?.localPort : undefined,
      rtt: udp?.rtt,
      retries: udp?.retries,
    }),
  );
  app.post('/api/stop', async (_req, res) => {
    if (changing) {
      res
        .status(409)
        .json({ error: 'A connection change is already in progress.' });
      return;
    }
    changing = true;
    try {
      await stop();
      res.json({ ok: true });
    } finally {
      changing = false;
    }
  });
  app.post('/api/start', async (req, res) => {
    if (changing) {
      res
        .status(409)
        .json({ error: 'A connection change is already in progress.' });
      return;
    }
    changing = true;
    try {
      const b = req.body;
      if (
        !b ||
        !['host', 'guest'].includes(b.role) ||
        !['udp', 'webrtc', 'auto'].includes(b.mode)
      )
        throw Error('Choose a role and connection method.');
      if (
        typeof b.secret !== 'string' ||
        b.secret.length < 24 ||
        b.secret.length > 256
      )
        throw Error(
          'Use the same connection key on both computers (at least 24 characters).',
        );
      const c: Config = {
        role: b.role,
        mode: b.mode,
        secret: b.secret,
        localPort: portNumber(b.localPort, b.role === 'host' ? 5000 : 5001),
        peerHost: String(b.peerHost || '').replace(/^\[|\]$/g, ''),
        peerPort: portNumber(b.peerPort, b.role === 'host' ? 5001 : 5000),
        forwardPort: portNumber(b.forwardPort, 3001),
        signalUrl: String(b.signalUrl || ''),
        iceServers: [],
      };
      if (c.forwardPort === controlPort || c.forwardPort === gamePort)
        throw Error(
          'The forwarded game port must differ from the app and Connection options ports.',
        );
      if (c.mode === 'udp' && !isIP(c.peerHost))
        throw Error('Enter the other player’s public IPv4 or IPv6 address.');
      if (c.peerHost && !isIP(c.peerHost))
        throw Error('The peer address must be a literal IPv4 or IPv6 address.');
      if (c.mode !== 'udp') {
        const url = new URL(c.signalUrl);
        if (
          !['http:', 'https:'].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.pathname !== '/' ||
          url.search ||
          url.hash
        )
          throw Error(
            'Use the rendezvous server origin, such as https://signal.example.com.',
          );
        if (!Array.isArray(b.iceServers) || b.iceServers.length > 8)
          throw Error('Invalid ICE server list.');
        c.iceServers = b.iceServers.map((s: any) => {
          if (
            typeof s.urls !== 'string' ||
            !/^stuns?:|^turns?:/.test(s.urls) ||
            s.urls.length > 256
          )
            throw Error('Invalid STUN/TURN URL.');
          return {
            urls: s.urls,
            username: String(s.username || '').slice(0, 256),
            credential: String(s.credential || '').slice(0, 256),
          };
        });
      }
      await stop();
      config = c;
      detail = 'Starting connection…';
      if (c.mode !== 'webrtc' && c.peerHost) udp = new UdpLink(c);
      if (c.mode !== 'udp') rtc = new RtcLink();
      race = new RacingLink(
        [...(udp ? [udp] : []), ...(rtc ? [rtc] : [])],
        c.role,
      );
      race.on('status', (s) => (detail = s));
      race.on('route-status', (s) => {
        routes[s.route] = s.detail;
      });
      tunnel = new TcpTunnel(race, c.role, gamePort);
      if (c.role === 'guest') await tunnel.listen(c.forwardPort);
      if (udp) await udp.start();
      res.json({ ok: true, webrtc: !!rtc });
    } catch (e: any) {
      await stop();
      res.status(400).json({ error: e.message });
    } finally {
      changing = false;
    }
  });
  io.on('connection', (socket) => {
    socket.on('rtc:attach', (ack) => {
      if (typeof ack !== 'function') return;
      if (!config || !rtc)
        return ack({ error: 'Start a WebRTC connection first.' });
      rtc.attach(socket);
      ack({
        role: config.role,
        secret: config.secret,
        signalUrl: config.signalUrl,
        iceServers: config.iceServers,
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(controlPort, '127.0.0.1', () => {
      http.off('error', reject);
      resolve();
    });
  });
  return {
    port: controlPort,
    close: async () => {
      await stop();
      await new Promise<void>((resolve) => io.close(() => resolve()));
    },
  };
}
