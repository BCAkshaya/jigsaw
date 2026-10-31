<script lang="ts">
  import { onMount } from 'svelte';
  let title = $state('A little escape'),
    name = $state(''),
    size = $state('10'),
    rotation = $state(false),
    file = $state<File | null>(null),
    preview = $state('/sample.svg'),
    busy = $state(false),
    error = $state(''),
    rooms = $state<any[]>([]),
    join = $state('');
  onMount(() => {
    name = localStorage.getItem('jigsaw-name') || '';
    fetch('/api/rooms')
      .then((r) => r.json())
      .then((r) => (rooms = r))
      .catch(() => (error = 'Could not load saved rooms.'));
    return () => {
      if (preview.startsWith('blob:')) URL.revokeObjectURL(preview);
    };
  });
  function choose(e: Event) {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    if (f.size > 12 * 1024 * 1024) {
      error = 'Please choose an image under 12 MB.';
      return;
    }
    file = f;
    if (preview.startsWith('blob:')) URL.revokeObjectURL(preview);
    preview = URL.createObjectURL(f);
  }
  async function create() {
    busy = true;
    error = '';
    try {
      localStorage.setItem('jigsaw-name', name.trim() || 'Guest');
      const data = new FormData();
      data.set('title', title);
      data.set('size', size);
      data.set('rotation', String(rotation));
      if (file) data.set('image', file);
      const res = await fetch('/api/rooms', { method: 'POST', body: data });
      const result = await res.json();
      if (!res.ok) throw Error(result.error);
      location.href = '/room/' + result.id;
    } catch (e: any) {
      error = e.message;
      busy = false;
    }
  }
  function enter(id: string) {
    const raw = id.trim().split('/').filter(Boolean).pop() || '';
    if (!/^[a-f0-9]{24}$/.test(raw)) {
      error = 'Paste a room link or a valid room code.';
      return;
    }
    localStorage.setItem('jigsaw-name', name.trim() || 'Guest');
    location.href = '/room/' + raw;
  }
</script>

<svelte:head
  ><title>Piece by piece — Jigsaw Together</title><meta
    name="description"
    content="A quiet place to put the pieces together. Create a puzzle and play with a friend."
  /></svelte:head
>
<div class="lobby">
  <a
    class="connection-options-link"
    href="/connection-options"
    target="_blank"
    rel="noopener">Connection options · Direct UDP / WebRTC ↗</a
  >
  <header class="masthead">
    <a href="/" class="brand"
      ><span class="brand-icon">✣</span> jigsaw<span class="brand-light"
        >together</span
      ></a
    ><span class="small-note"><i></i> A little time, well spent</span>
  </header>
  <main>
    <div class="intro">
      <span class="eyebrow">GOOD COMPANY. SMALL DISCOVERIES.</span>
      <h1>A little escape.<br />One piece at a time.</h1>
      <p>
        Pick a picture, invite your favorite person, and<br class="desktop" /> make
        something whole together.
      </p>
    </div>
    <div class="create-layout">
      <div class="art-card">
        <img src={preview} alt="Preview of your next puzzle" />
        <div class="art-shade"></div>
        <span class="art-tag">YOUR NEXT SLOW MOMENT</span>
        <div class="art-caption">
          <span>Somewhere, away from it all.</span><small
            >{file
              ? 'Your own little masterpiece'
              : 'The quiet lake · included artwork'}</small
          >
        </div>
        <span class="piece-label">{Number(size) ** 2} pieces</span>
      </div>
      <section class="setup">
        <div class="section-kicker">01 / SET THE TABLE</div>
        <h2>Make room for a puzzle.</h2>
        <p class="muted">A solo afternoon or a shared little adventure.</p>
        <form
          onsubmit={(e) => {
            e.preventDefault();
            create();
          }}
        >
          <label class="upload"
            ><span class="upload-symbol">↥</span><span
              ><strong>Bring your own picture</strong><small
                >JPG, PNG or WebP · up to 12 MB</small
              ></span
            ><input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onchange={choose}
            /><span class="upload-plus">+</span></label
          >
          <div class="field-row">
            <label
              >Your name<input
                bind:value={name}
                placeholder="What should we call you?"
                maxlength="24"
              /></label
            ><label
              >Puzzle name<input
                bind:value={title}
                maxlength="60"
                required
              /></label
            >
          </div>
          <label class="field-title" for="pieces">A pace that suits you</label>
          <div class="sizes" id="pieces">
            {#each [['4', 'A quick pause', '16 pieces'], ['6', 'Settle in', '36 pieces'], ['10', 'Stay a while', '100 pieces']] as option}<button
                type="button"
                class:chosen={size === option[0]}
                onclick={() => (size = option[0])}
                ><strong>{option[1]}</strong><small>{option[2]}</small></button
              >{/each}
          </div>
          <label class="toggle"
            ><input type="checkbox" bind:checked={rotation} /><span
              >Let the pieces rotate</span
            ><small>A little extra challenge</small></label
          >
          <button class="primary create-button" disabled={busy}
            >{busy ? 'Setting your table…' : 'Start a new puzzle'}
            <span>↗</span></button
          >
        </form>
        <p class="private-note">
          Just you and a friend. Progress saved as you go.
        </p>
      </section>
    </div>
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    <section class="return-section">
      <div>
        <span class="section-kicker">THE DOOR IS ALWAYS OPEN</span>
        <h2>Pick up where you left off.</h2>
      </div>
      <form
        class="join-form"
        onsubmit={(e) => {
          e.preventDefault();
          enter(join);
        }}
      >
        <input
          aria-label="Room link or code"
          placeholder="Have an invite? Paste the room link"
          bind:value={join}
          required
        /><button type="submit" aria-label="Join puzzle">↗</button>
      </form>
    </section>
    {#if rooms.length}<div class="saved-rooms">
        {#each rooms as room}<button
            class="saved-room"
            onclick={() => enter(room.id)}
            ><img src={room.image} alt="" /><span
              ><strong>{room.title}</strong><small
                >{room.count} pieces · {room.completed
                  ? 'Complete'
                  : room.players
                    ? `${room.players}/2 at the table`
                    : 'Ready when you are'}</small
              ></span
            ><span>↗</span></button
          >{/each}
      </div>{:else}<p class="empty-note">
        Your puzzles will be waiting here. No need to finish in one sitting.
      </p>{/if}
  </main>
  <footer>
    <span>Less scrolling. More connecting.</span><span
      >Made for the moments in between. ✣</span
    >
  </footer>
</div>
