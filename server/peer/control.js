/* global io */
const $ = (id) => document.getElementById(id);
let local,
  broker,
  pc,
  channel,
  key,
  role,
  attempt = '',
  generation = 0,
  pendingCandidates = [],
  incoming = Promise.resolve(),
  outgoing = Promise.resolve(),
  sending = Promise.resolve(),
  keepalive,
  retry,
  lastSeen = 0,
  negotiating = false,
  closed = true;
const log = (text) => {
  $('log').textContent = text;
};
const fail = (error) => {
  $('error').textContent = error.message || String(error);
};
const state = (text) => local?.emit('rtc:state', text);
function generate() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  $('secret').value = Array.from(bytes, (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}
$('generate').onclick = generate;
$('copy').onclick = async () => {
  try {
    await navigator.clipboard.writeText($('secret').value);
    log('Connection key copied. Share it privately with your friend.');
  } catch {
    fail(Error('Select and copy the key manually.'));
  }
};
function fields() {
  const mode = $('mode').value;
  $('udp-fields').hidden = mode === 'webrtc';
  $('rtc-fields').hidden = mode === 'udp';
  $('guest-fields').hidden = $('role').value !== 'guest';
  $('signalUrl').required = mode !== 'udp';
  $('peerHost').required = mode === 'udp';
}
$('mode').onchange = fields;
$('role').onchange = () => {
  const host = $('role').value === 'host';
  $('localPort').value = host ? '5000' : '5001';
  $('peerPort').value = host ? '5001' : '5000';
  fields();
};
fields();
generate();
async function request(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const result = await res.json();
  if (!res.ok) throw Error(result.error);
  return result;
}
function closePeer() {
  clearInterval(keepalive);
  clearTimeout(retry);
  if (channel) {
    channel.onclose = null;
    channel.onerror = null;
    channel.close();
  }
  channel = undefined;
  if (pc) {
    pc.onconnectionstatechange = null;
    pc.close();
  }
  pc = undefined;
  pendingCandidates = [];
}
function stopRtc() {
  closed = true;
  generation++;
  closePeer();
  broker?.disconnect();
  broker = undefined;
  local?.disconnect();
  local = undefined;
}
function retryPeer(message) {
  if (closed) return;
  state(message);
  closePeer();
  retry = setTimeout(() => {
    if (closed) return;
    if (role === 'host') void offer();
    else sendSignal({ kind: 'retry' });
  }, 3000);
}
function bindChannel(dc) {
  channel = dc;
  dc.binaryType = 'arraybuffer';
  dc.bufferedAmountLowThreshold = 64 * 1024;
  dc.onopen = () => {
    lastSeen = Date.now();
    state('connected');
    log(
      'WebRTC is ready. ICE selected the candidate pair automatically.',
    );
    keepalive = setInterval(() => {
      if (dc.readyState !== 'open') return;
      if (Date.now() - lastSeen > 12000) {
        retryPeer('WebRTC timed out. Retrying ICE.');
        return;
      }
      dc.send('ping');
    }, 2000);
  };
  dc.onmessage = (event) => {
    lastSeen = Date.now();
    if (event.data === 'ping') {
      dc.send('pong');
      return;
    }
    if (event.data === 'pong') return;
    if (event.data instanceof ArrayBuffer && event.data.byteLength <= 600)
      local?.emit('rtc:data', event.data);
  };
  dc.onclose = () => retryPeer('WebRTC closed. Retrying.');
  dc.onerror = () => retryPeer('WebRTC interrupted. Retrying.');
}
function makePeer(config, id) {
  closePeer();
  attempt = id;
  pc = new RTCPeerConnection({ iceServers: config.iceServers });
  const current = pc;
  current.onicecandidate = (event) => {
    if (event.candidate)
      sendSignal({
        kind: 'candidate',
        attempt: id,
        candidate: event.candidate.toJSON(),
      });
  };
  current.ondatachannel = (event) => bindChannel(event.channel);
  current.onconnectionstatechange = () => {
    if (current !== pc) return;
    if (current.connectionState === 'failed')
      retryPeer(
        'No ICE route yet. Retrying; add TURN if direct paths keep failing.',
      );
  };
  retry = setTimeout(() => {
    if (current === pc && channel?.readyState !== 'open')
      retryPeer(
        'ICE is still searching. Retrying; check the rendezvous and TURN settings.',
      );
  }, 30000);
  return current;
}
let rtcConfig;
async function offer() {
  if (
    closed ||
    negotiating ||
    !broker?.connected ||
    channel?.readyState === 'open'
  )
    return;
  negotiating = true;
  try {
    const id = crypto.randomUUID();
    const current = makePeer(rtcConfig, id);
    bindChannel(current.createDataChannel('jigsaw-tunnel', { ordered: true }));
    await current.setLocalDescription(await current.createOffer());
    if (pc === current)
      sendSignal({
        kind: 'offer',
        attempt: id,
        sdp: current.localDescription.toJSON(),
      });
  } catch (e) {
    log(e.message);
    retryPeer('Negotiation interrupted. Retrying.');
  } finally {
    negotiating = false;
  }
}
async function sendSignal(payload) {
  const currentGeneration = generation;
  outgoing = outgoing
    .catch(() => {})
    .then(async () => {
      if (closed || currentGeneration !== generation) return;
      const nonce = crypto.getRandomValues(new Uint8Array(12));
      const bytes = new TextEncoder().encode(JSON.stringify(payload));
      const encrypted = new Uint8Array(
        await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, bytes),
      );
      const packet = new Uint8Array(12 + encrypted.length);
      packet.set(nonce);
      packet.set(encrypted, 12);
      broker?.emit('signal', btoa(String.fromCharCode(...packet)));
    })
    .catch((e) => log(e.message));
}
async function receiveSignal(packet) {
  const raw = Uint8Array.from(atob(packet), (c) => c.charCodeAt(0));
  const bytes = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: raw.slice(0, 12) },
    key,
    raw.slice(12),
  );
  const msg = JSON.parse(new TextDecoder().decode(bytes));
  if (msg.kind === 'retry') {
    if (role === 'host') await offer();
    return;
  }
  if (msg.kind === 'offer' && role === 'guest') {
    const savedCandidates = pendingCandidates.filter(
      (c) => c.attempt === msg.attempt,
    );
    const current = makePeer(rtcConfig, msg.attempt);
    await current.setRemoteDescription(msg.sdp);
    for (const c of savedCandidates) await current.addIceCandidate(c.candidate);
    await current.setLocalDescription(await current.createAnswer());
    if (current === pc)
      sendSignal({
        kind: 'answer',
        attempt: msg.attempt,
        sdp: current.localDescription.toJSON(),
      });
  } else if (
    msg.kind === 'answer' &&
    role === 'host' &&
    msg.attempt === attempt &&
    pc
  ) {
    await pc.setRemoteDescription(msg.sdp);
    for (const c of pendingCandidates.filter((c) => c.attempt === attempt))
      await pc.addIceCandidate(c.candidate);
    pendingCandidates = [];
  } else if (msg.kind === 'candidate') {
    if (msg.attempt === attempt && pc?.remoteDescription)
      await pc.addIceCandidate(msg.candidate);
    else if (pendingCandidates.length < 128) pendingCandidates.push(msg);
  }
}
async function startRtc() {
  stopRtc();
  closed = false;
  const currentGeneration = generation;
  local = io({ transports: ['websocket'], forceNew: true });
  local.on('connect', () => {
    local.timeout(5000).emit('rtc:attach', async (err, config) => {
      if (closed || generation !== currentGeneration) return;
      if (err || config.error) {
        fail(Error(config?.error || 'Could not attach WebRTC.'));
        return;
      }
      rtcConfig = config;
      role = config.role;
      const keyBytes = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode('jigsaw-signal:' + config.secret),
      );
      key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, [
        'encrypt',
        'decrypt',
      ]);
      const roomBytes = new Uint8Array(
        await crypto.subtle.digest(
          'SHA-256',
          new TextEncoder().encode('jigsaw-rendezvous:' + config.secret),
        ),
      );
      const room = Array.from(roomBytes, (b) =>
        b.toString(16).padStart(2, '0'),
      ).join('');
      if (closed || generation !== currentGeneration) return;
      broker = io(config.signalUrl, {
        transports: ['websocket'],
        forceNew: true,
      });
      broker.on('connect', () => {
        broker.timeout(5000).emit('register', { role, room }, (err, r) => {
          if (err || r?.error) {
            state('Rendezvous pairing failed.');
            fail(Error(r?.error || 'Rendezvous registration timed out.'));
          } else if (channel?.readyState !== 'open')
            state('Waiting for the other player on the rendezvous server.');
        });
      });
      broker.on('paired', () => {
        if (role === 'host') void offer();
      });
      broker.on('signal', (packet) => {
        incoming = incoming
          .catch(() => {})
          .then(() => receiveSignal(packet))
          .catch(() =>
            log(
              'Ignored invalid or unauthenticated signaling data. Check that the keys match.',
            ),
          );
      });
      broker.on('connect_error', () => {
        if (channel?.readyState !== 'open')
          state('Cannot reach rendezvous server. Retrying.');
      });
      broker.on('peer-left', () => {
        if (channel?.readyState !== 'open')
          state('Waiting for the other player to return.');
      });
    });
  });
  local.on('rtc:send', (data, ack) => {
    sending = sending
      .catch(() => {})
      .then(async () => {
        const dc = channel;
        if (!dc || dc.readyState !== 'open') {
          ack(false);
          return;
        }
        const started = Date.now();
        while (
          dc.readyState === 'open' &&
          dc.bufferedAmount > 256 * 1024 &&
          Date.now() - started < 12000
        )
          await new Promise((r) => setTimeout(r, 20));
        try {
          if (dc.readyState !== 'open' || dc.bufferedAmount > 1024 * 1024) {
            ack(false);
            return;
          }
          dc.send(data);
          ack(true);
        } catch {
          ack(false);
        }
      });
  });
  local.on('rtc:restart', () =>
    retryPeer('Tunnel interrupted. Retrying WebRTC.'),
  );
  local.on('rtc:stop', stopRtc);
  local.on('disconnect', () => {
    if (!closed) {
      log('Local bridge interrupted. Start the connection again.');
      stopRtc();
    }
  });
}
$('form').onsubmit = async (event) => {
  event.preventDefault();
  $('error').textContent = '';
  $('start').disabled = true;
  stopRtc();
  try {
    const iceServers = $('stun')
      .value.split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((urls) => ({ urls }));
    if ($('turn').value.trim())
      iceServers.push({
        urls: $('turn').value.trim(),
        username: $('turnUser').value,
        credential: $('turnPassword').value,
      });
    const result = await request('/api/start', {
      role: $('role').value,
      mode: $('mode').value,
      secret: $('secret').value,
      localPort: Number($('localPort').value),
      peerHost: $('peerHost').value.trim(),
      peerPort: Number($('peerPort').value),
      forwardPort: Number($('forwardPort').value),
      signalUrl: $('signalUrl').value.trim(),
      iceServers,
    });
    if (result.webrtc) await startRtc();
    log('Start the other computer with the same key and opposite role.');
  } catch (e) {
    fail(e);
  } finally {
    $('start').disabled = false;
  }
};
$('stop').onclick = async () => {
  stopRtc();
  try {
    await request('/api/stop');
    log('Connection stopped.');
  } catch (e) {
    fail(e);
  }
};
async function refresh() {
  try {
    const s = await (await fetch('/api/status')).json();
    $('status').textContent = s.connected
      ? `Connected · ${s.route}`
      : s.running
        ? 'Connecting'
        : 'Not connected';
    $('status').classList.toggle('up', s.connected);
    $('detail').textContent = s.detail;
    $('routes').replaceChildren(
      ...Object.entries(s.routes).map(([route, detail]) => {
        const p = document.createElement('div');
        p.textContent = `${route}: ${detail}`;
        return p;
      }),
    );
    $('metrics').textContent = s.udpPort
      ? `UDP port ${s.udpPort} · RTT ${s.rtt || '—'} ms · ${s.retries || 0} retransmissions`
      : '';
    $('back').href = `http://localhost:${s.gamePort}`;
    $('open-game').style.display = s.connected ? 'inline-block' : 'none';
    $('open-game').href =
      `http://localhost:${s.role === 'guest' ? s.forwardPort : s.gamePort}`;
  } catch {
    log('The local app is offline. Start it, then reload this page.');
  }
}
setInterval(refresh, 1000);
void refresh();
