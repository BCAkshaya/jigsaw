<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { io, type Socket } from 'socket.io-client';
  import type { Puzzle } from '../../../../shared/types';
  import { Tabletop } from '$lib/renderer/Scene';
  let el: HTMLDivElement;
  let game: Tabletop;
  let socket = $state<Socket>()!;
  let puzzle = $state<Puzzle | null>(null),
    status = $state('Connecting to your table…'),
    notice = $state(''),
    connected = $state(false),
    reference = $state(false),
    edges = $state(false),
    sound = $state(true),
    copied = $state(false);
  let noticeTimer: ReturnType<typeof setTimeout>;
  let audio: AudioContext | undefined;
  const placed = $derived(
    puzzle?.groups
      .filter((g) => g.placed)
      .reduce((n, g) => n + g.pieces.length, 0) || 0,
  );
  const total = $derived(puzzle ? puzzle.rows * puzzle.cols : 100);
  const joined = $derived(puzzle ? total - puzzle.groups.length : 0);
  function toast(s: string) {
    notice = s;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => (notice = ''), 4500);
  }
  function chime() {
    if (!sound) return;
    try {
      audio ||= new AudioContext();
      const o = audio.createOscillator(),
        gain = audio.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(660, audio.currentTime);
      o.frequency.exponentialRampToValueAtTime(990, audio.currentTime + 0.12);
      gain.gain.setValueAtTime(0.08, audio.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.3);
      o.connect(gain).connect(audio.destination);
      o.start();
      o.stop(audio.currentTime + 0.3);
    } catch {}
  }
  async function invite() {
    try {
      await navigator.clipboard.writeText(location.href);
      copied = true;
      setTimeout(() => (copied = false), 2000);
    } catch {
      toast('Copy this page’s address to invite your friend.');
    }
  }
  onMount(() => {
    socket = io();
    try {
      game = new Tabletop(el, socket, toast, chime);
    } catch {
      status = 'This puzzle needs a browser with WebGL enabled.';
      socket.disconnect();
      return;
    }
    socket.on('connect', () => {
      socket
        .timeout(5000)
        .emit(
          'join',
          {
            id: page.params.id,
            name: localStorage.getItem('jigsaw-name') || 'Guest',
          },
          (err: any, r: any) => {
            if (err || r?.error) {
              status =
                r?.error || 'Could not join. Please refresh to try again.';
              connected = false;
            } else {
              connected = true;
              status = '';
            }
          },
        );
    });
    socket.on('state', (p: Puzzle) => {
      const first = !puzzle;
      puzzle = p;
      if (first) void game.load(p);
      else game.apply(p);
    });
    socket.on('transform', (t) => game.transform(t));
    socket.on('cursor', (v) => game.cursor(v));
    socket.on('disconnect', () => {
      connected = false;
      status = 'Connection lost. Reconnecting…';
      game.drag = null;
    });
    socket.on('connect_error', () => {
      status = 'Waiting for the server…';
    });
    return () => {
      clearTimeout(noticeTimer);
      socket.disconnect();
      game?.dispose();
      void audio?.close();
    };
  });
</script>

<svelte:head
  ><title>{puzzle?.title || 'Your puzzle'} — Jigsaw Together</title
  ></svelte:head
>
<div class="room-shell">
  <header class="room-header">
    <a class="brand" href="/"
      ><span class="brand-icon">✣</span> jigsaw<span class="brand-light"
        >together</span
      ></a
    >
    <div class="room-title">
      <span class="eyebrow">ON THE TABLE</span><strong
        >{puzzle?.title || 'A little escape'}</strong
      >
    </div>
    <button class="invite" onclick={invite}
      >{copied ? 'Link copied ✓' : 'Invite a friend ↗'}</button
    >
  </header>
  <main class="table-wrap">
    <div
      bind:this={el}
      class="tabletop"
      role="application"
      aria-label="Puzzle tabletop. Drag pieces to connect them. Scroll to zoom. Press R while dragging to rotate."
    ></div>
    <div class="table-topline">
      <span class="table-badge"
        ><i class:online={connected}></i>{connected
          ? 'Your quiet corner'
          : 'Connecting…'}</span
      >
      <div class="players">
        {#each puzzle?.players || [] as player}<span
            class="player"
            style={`--player-color:${player.color}`}
            ><b>{player.name[0].toUpperCase()}</b>{player.name}{player.id ===
            socket?.id
              ? ' (you)'
              : ''}</span
          >{/each}{#if puzzle?.players.length === 1}<span class="waiting"
            >A seat for a friend</span
          >{/if}
      </div>
    </div>
    {#if status}<div class="connection-message" role="status">
        <span>✣</span>
        <p>{status}</p>
        <a href="/">Back to the lobby</a>
      </div>{/if}
    {#if puzzle?.completed}<div class="completion">
        <span>✣</span>
        <h1>A lovely little accomplishment.</h1>
        <p>All {total} pieces, right where they belong.</p>
        <a class="primary" href="/">Make another moment ↗</a>
      </div>{/if}
    {#if reference && puzzle}<aside class="reference">
        <button onclick={() => (reference = false)} aria-label="Close reference"
          >×</button
        ><img src={puzzle.image} alt="Completed puzzle reference" /><span
          >The bigger picture</span
        >
      </aside>{/if}
    <div class="table-toolbar">
      <button class:active={reference} onclick={() => (reference = !reference)}
        >▧ <span>Reference</span></button
      ><button
        class:active={edges}
        onclick={() => {
          edges = !edges;
          game.edgesOnly = edges;
          if (puzzle) game.apply(puzzle);
        }}>⌗ <span>Edges only</span></button
      >
      <div class="toolbar-divider"></div>
      <button
        onclick={() => {
          game.zoom = Math.max(0.55, game.zoom / 1.2);
          game.fit();
        }}
        aria-label="Zoom out">−</button
      ><button
        onclick={() => {
          game.zoom = 1;
          game.fit();
        }}>Fit</button
      ><button
        onclick={() => {
          game.zoom = Math.min(2.8, game.zoom * 1.2);
          game.fit();
        }}
        aria-label="Zoom in">+</button
      >
      <div class="toolbar-divider"></div>
      <button
        class:active={sound}
        onclick={() => (sound = !sound)}
        aria-label={sound ? 'Mute snap sounds' : 'Enable snap sounds'}
        >{sound ? '♪' : '♩'}</button
      >
    </div>
    {#if notice}<div class="toast" role="status">{notice}</div>{/if}
  </main>
  <footer class="room-footer">
    <div>
      <strong>{placed} <span>/ {total} pieces placed</span></strong>
      <div class="progress-track">
        <div style={`width:${(placed / total) * 100}%`}></div>
      </div>
    </div>
    <span class="drag-hint"
      >Drag to move · Scroll to zoom {puzzle?.rotation
        ? '· R to rotate'
        : ''}</span
    ><span class="save-status"
      >{joined} connections <span>·</span> Saved on every drop ✓</span
    >
  </footer>
</div>
