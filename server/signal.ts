import { createServer } from 'node:http';
import { attachSignaling } from './peer/signaling';
const http = createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Jigsaw rendezvous ready. No game data is stored here.\n');
});
const io = attachSignaling(http);
const port = Number(process.env.SIGNAL_PORT || 8787);
http.listen(port, process.env.SIGNAL_HOST || '0.0.0.0', () =>
  console.log(`Jigsaw rendezvous listening on ${port}`),
);
const close = () => io.close(() => process.exit(0));
process.on('SIGINT', close);
process.on('SIGTERM', close);
