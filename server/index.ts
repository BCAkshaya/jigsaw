import express from 'express';
import multer from 'multer';
import { createServer } from 'node:http';
import { readFile, unlink, rename } from 'node:fs/promises';
import { Server } from 'socket.io';
import { RoomManager } from './RoomManager';
import { attachAuthority } from './GameAuthority';
import { startPeerControl } from './peer/control';
const app = express(),
  http = createServer(app),
  manager = new RoomManager();
await manager.load();
const io = new Server(http, { maxHttpBufferSize: 16_384 });
attachAuthority(io, manager);
app.disable('x-powered-by');
app.use(express.json({ limit: '4kb' }));
app.use(
  '/uploads',
  express.static('data/uploads', {
    dotfiles: 'deny',
    setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff'),
  }),
);
app.get('/api/rooms', (_req, res) =>
  res.json(
    [...manager.rooms.values()]
      .map((p) => ({
        id: p.id,
        title: p.title,
        image: p.image,
        count: p.rows * p.cols,
        completed: p.completed,
        players: p.players.length,
        created: p.created,
      }))
      .reverse(),
  ),
);
const upload = multer({
  dest: 'data/uploads',
  limits: { fileSize: 12 * 1024 * 1024, files: 1 },
});
app.post('/api/rooms', upload.single('image'), async (req, res, next) => {
  try {
    const size = Number(req.body.size);
    if (![4, 6, 10].includes(size)) {
      if (req.file) await unlink(req.file.path);
      res.status(400).json({ error: 'Choose 16, 36, or 100 pieces.' });
      return;
    }
    let image = '/sample.svg';
    if (req.file) {
      const b = await readFile(req.file.path);
      let mime = '';
      if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) mime = 'jpeg';
      if (
        b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      )
        mime = 'png';
      if (
        b.toString('ascii', 0, 4) === 'RIFF' &&
        b.toString('ascii', 8, 12) === 'WEBP'
      )
        mime = 'webp';
      if (!mime) {
        await unlink(req.file.path);
        res
          .status(400)
          .json({ error: 'Please upload a JPEG, PNG, or WebP image.' });
        return;
      }
      await rename(req.file.path, req.file.path + '.' + mime);
      image = '/uploads/' + req.file.filename + '.' + mime;
    }
    const p = manager.create(
      String(req.body.title || 'A little escape').slice(0, 60),
      image,
      size,
      req.body.rotation === 'true',
    );
    await manager.save();
    res.json({ id: p.id });
  } catch (e) {
    next(e);
  }
});
app.use((err: any, _req: any, res: any, _next: any) =>
  res.status(400).json({
    error:
      err.code === 'LIMIT_FILE_SIZE'
        ? 'Images must be under 12 MB.'
        : 'Could not save this puzzle.',
  }),
);
app.get('/connection-options', (_req, res) => {
  if (!peerControl) {
    res
      .status(503)
      .send(
        'Connection options is unavailable on this instance. Check PEER_CONTROL_PORT and the server log.',
      );
    return;
  }
  res.redirect(
    `http://localhost:${Number(process.env.PEER_CONTROL_PORT || 3002) || 3002}`,
  );
});
if (process.argv.includes('--dev')) {
  const { createServer } = await import('vite');
  const vite = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
  });
  app.use(vite.middlewares);
} else {
  const { handler } = await import('../build/handler.js' as string);
  app.use(handler);
}
const port = Number(process.env.PORT || 3000);
const controlPort = Number(process.env.PEER_CONTROL_PORT || 3002);
let peerControl: Awaited<ReturnType<typeof startPeerControl>> | undefined;
if (controlPort) {
  try {
    if (controlPort === port)
      throw Error('Connection options needs a separate port.');
    peerControl = await startPeerControl(port, controlPort);
    console.log(
      `Connection options: http://localhost:${controlPort} (this computer only)`,
    );
  } catch (e: any) {
    console.error('Peer connection options unavailable:', e.message);
  }
}
http.listen(port, process.env.HOST || '0.0.0.0', () =>
  console.log(`Jigsaw Together: http://localhost:${port}`),
);
async function shutdown() {
  await peerControl?.close();
  await manager.save();
  io.close();
  http.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
