import * as THREE from 'three';
import type { Socket } from 'socket.io-client';
import type { Puzzle, Transform } from '../../../shared/types';
import { pieceGeometry } from '../game/PieceGeometry';
import { rotated } from '../game/PuzzleState';
export class Tabletop {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera = new THREE.OrthographicCamera();
  ray = new THREE.Raycaster();
  plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  meshes = new Map<number, THREE.Mesh>();
  p!: Puzzle;
  frame = 0;
  resize: ResizeObserver;
  texture?: THREE.Texture;
  drag: number | null = null;
  pending = false;
  offset = { x: 0, y: 0 };
  last = 0;
  zoom = 1;
  edgesOnly = false;
  disposed = false;
  onError: (s: string) => void;
  cursors = new Map<string, { mesh: THREE.Mesh; target: THREE.Vector3 }>();
  constructor(
    public el: HTMLElement,
    public socket: Socket,
    onError: (s: string) => void,
    public onSnap: () => void,
  ) {
    this.onError = onError;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    el.append(this.renderer.domElement);
    this.camera.position.set(0, 0, 35);
    this.scene.add(new THREE.AmbientLight(0xffffff, 2));
    const light = new THREE.DirectionalLight(0xffedda, 3);
    light.position.set(-8, 12, 20);
    light.castShadow = true;
    light.shadow.mapSize.set(2048, 2048);
    Object.assign(light.shadow.camera, {
      left: -25,
      right: 25,
      top: 25,
      bottom: -25,
      near: 1,
      far: 60,
    });
    light.shadow.bias = -0.0002;
    this.scene.add(light);
    const table = new THREE.Mesh(
      new THREE.PlaneGeometry(200, 200),
      new THREE.ShadowMaterial({ opacity: 0.2 }),
    );
    table.position.z = -0.08;
    table.receiveShadow = true;
    this.scene.add(table);
    this.resize = new ResizeObserver(() => this.fit());
    this.resize.observe(el);
    el.addEventListener('pointerdown', this.down);
    el.addEventListener('pointermove', this.move);
    el.addEventListener('pointerup', this.up);
    el.addEventListener('pointercancel', this.up);
    el.addEventListener('wheel', this.wheel, { passive: false });
    window.addEventListener('keydown', this.key);
    this.loop();
  }
  fit() {
    const w = this.el.clientWidth,
      h = this.el.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    const span =
      (this.p
        ? Math.max(this.p.rows * 2.9, (this.p.cols * 2.9) / (w / h))
        : 26) / this.zoom;
    this.camera.left = (-span * w) / h / 2;
    this.camera.right = (span * w) / h / 2;
    this.camera.top = span / 2;
    this.camera.bottom = -span / 2;
    this.camera.updateProjectionMatrix();
  }
  async load(p: Puzzle) {
    this.p = p;
    this.fit();
    try {
      this.texture = await new THREE.TextureLoader().loadAsync(p.image);
      if (this.disposed) {
        this.texture.dispose();
        return;
      }
      this.texture.colorSpace = THREE.SRGBColorSpace;
      const image = this.texture.image as HTMLImageElement;
      const ratio = image.width / image.height;
      if (ratio > 1) {
        this.texture.repeat.x = 1 / ratio;
        this.texture.offset.x = (1 - 1 / ratio) / 2;
      } else {
        this.texture.repeat.y = ratio;
        this.texture.offset.y = (1 - ratio) / 2;
      }
      this.texture.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
      const face = new THREE.MeshStandardMaterial({
          map: this.texture,
          roughness: 0.75,
        }),
        side = new THREE.MeshStandardMaterial({
          color: 0xbaa788,
          roughness: 1,
        });
      for (let id = 0; id < p.rows * p.cols; id++) {
        const mesh = new THREE.Mesh(pieceGeometry(id, p), [face, side]);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.userData.id = id;
        this.meshes.set(id, mesh);
        this.scene.add(mesh);
      }
      const board = new THREE.Mesh(
        new THREE.PlaneGeometry(p.cols + 0.12, p.rows + 0.12),
        new THREE.MeshBasicMaterial({
          color: 0xd5d5c5,
          transparent: true,
          opacity: 0.16,
        }),
      );
      board.position.z = -0.06;
      this.scene.add(board);
      this.apply(this.p);
    } catch {
      this.onError('Could not load the puzzle image.');
    }
  }
  apply(p: Puzzle) {
    this.p = p;
    if (
      this.drag !== null &&
      !p.groups.some((g) => g.id === this.drag && g.lockedBy === this.socket.id)
    )
      this.drag = null;
    for (const [id, c] of this.cursors)
      if (!p.players.some((p) => p.id === id)) {
        this.scene.remove(c.mesh);
        c.mesh.geometry.dispose();
        (c.mesh.material as THREE.Material).dispose();
        this.cursors.delete(id);
      }
    for (const g of p.groups)
      for (const id of g.pieces) {
        const m = this.meshes.get(id);
        if (!m) continue;
        m.userData.group = g.id;
        const edge =
          id < p.cols ||
          id >= p.cols * (p.rows - 1) ||
          id % p.cols === 0 ||
          id % p.cols === p.cols - 1;
        m.visible = !this.edgesOnly || edge || g.pieces.length > 1 || g.placed;
        m.userData.target = {
          x: g.x,
          y: g.y,
          r: (g.rotation * Math.PI) / 2,
          z: g.lockedBy ? 0.25 : g.placed ? 0 : g.id * 0.0015,
        };
        if (g.lockedBy === this.socket.id) {
          m.position.set(g.x, g.y, 0.25);
          m.rotation.z = (g.rotation * Math.PI) / 2;
        }
      }
  }
  transform(t: Transform) {
    const g = this.p?.groups.find((g) => g.id === t.id);
    if (g) {
      Object.assign(g, t);
      this.apply(this.p);
    }
  }
  cursor(v: { id: string; x: number; y: number }) {
    let c = this.cursors.get(v.id);
    if (!c) {
      const player = this.p?.players.find((p) => p.id === v.id);
      if (!player) return;
      const mesh = new THREE.Mesh(
        new THREE.ConeGeometry(0.12, 0.35, 3),
        new THREE.MeshBasicMaterial({ color: player.color }),
      );
      mesh.rotation.z = 0.5;
      mesh.position.z = 1;
      this.scene.add(mesh);
      c = { mesh, target: new THREE.Vector3() };
      this.cursors.set(v.id, c);
    }
    c.target.set(v.x, v.y, 1);
  }
  point(e: PointerEvent) {
    const r = this.el.getBoundingClientRect();
    this.ray.setFromCamera(
      new THREE.Vector2(
        ((e.clientX - r.left) / r.width) * 2 - 1,
        (-(e.clientY - r.top) / r.height) * 2 + 1,
      ),
      this.camera,
    );
    return this.ray.ray.intersectPlane(this.plane, new THREE.Vector3());
  }
  down = (e: PointerEvent) => {
    if (e.button !== 0 || !this.p || this.pending || this.drag !== null) return;
    const pt = this.point(e);
    if (!pt) return;
    const hit = this.ray.intersectObjects(
      [...this.meshes.values()].filter((m) => m.visible),
    )[0];
    if (!hit) return;
    const g = this.p.groups.find((g) => g.id === hit.object.userData.group);
    if (!g || g.placed) return;
    this.pending = true;
    this.el.setPointerCapture(e.pointerId);
    const pointerId = e.pointerId;
    this.socket.timeout(3000).emit('pickup', g.id, (err: any, res: any) => {
      this.pending = false;
      if (err || !res?.ok) {
        this.onError('That piece is busy. Try another one.');
        return;
      }
      if (!this.el.hasPointerCapture(pointerId)) {
        this.socket.emit('drop', {
          id: g.id,
          x: g.x,
          y: g.y,
          rotation: g.rotation,
        });
        return;
      }
      this.drag = g.id;
      Object.assign(g, res.group);
      this.offset = { x: pt.x - g.x, y: pt.y - g.y };
      this.apply(this.p);
    });
  };
  move = (e: PointerEvent) => {
    const pt = this.point(e);
    if (!pt) return;
    const now = performance.now();
    if (this.drag !== null) {
      const g = this.p.groups.find((g) => g.id === this.drag);
      if (g) {
        g.x = Math.max(
          -this.p.cols * 3,
          Math.min(this.p.cols * 3, pt.x - this.offset.x),
        );
        g.y = Math.max(
          -this.p.rows * 3,
          Math.min(this.p.rows * 3, pt.y - this.offset.y),
        );
        this.apply(this.p);
        if (now - this.last > 36)
          this.socket.volatile.emit('move', {
            id: g.id,
            x: g.x,
            y: g.y,
            rotation: g.rotation,
          });
      }
    }
    if (now - this.last > 36) {
      this.socket.volatile.emit('cursor', { x: pt.x, y: pt.y });
      this.last = now;
    }
  };
  up = (e: PointerEvent) => {
    if (this.el.hasPointerCapture(e.pointerId))
      this.el.releasePointerCapture(e.pointerId);
    if (this.drag === null) return;
    const g = this.p.groups.find((g) => g.id === this.drag);
    this.drag = null;
    if (g)
      this.socket
        .timeout(4000)
        .emit(
          'drop',
          { id: g.id, x: g.x, y: g.y, rotation: g.rotation },
          (err: any, r: any) => {
            if (err)
              this.onError(
                'Connection interrupted. Reconnecting will restore the room.',
              );
            if (r?.joined || r?.placed) this.onSnap();
          },
        );
  };
  key = (e: KeyboardEvent) => {
    if (e.key.toLowerCase() !== 'r' || this.drag === null || !this.p.rotation)
      return;
    const g = this.p.groups.find((g) => g.id === this.drag)!;
    const c = rotated(this.offset.x, this.offset.y, 1);
    g.x += this.offset.x - c.x;
    g.y += this.offset.y - c.y;
    this.offset = c;
    g.rotation = (g.rotation + 1) % 4;
    this.apply(this.p);
    this.socket.emit('move', {
      id: g.id,
      x: g.x,
      y: g.y,
      rotation: g.rotation,
    });
  };
  wheel = (e: WheelEvent) => {
    e.preventDefault();
    this.zoom = Math.max(
      0.55,
      Math.min(2.8, this.zoom * (e.deltaY < 0 ? 1.08 : 0.92)),
    );
    this.fit();
  };
  loop = () => {
    if (this.disposed) return;
    this.frame = requestAnimationFrame(this.loop);
    for (const m of this.meshes.values()) {
      const t = m.userData.target;
      if (t) {
        m.position.lerp(new THREE.Vector3(t.x, t.y, t.z), 0.35);
        let delta =
          ((t.r - m.rotation.z + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
        m.rotation.z += delta * 0.35;
      }
    }
    for (const c of this.cursors.values()) c.mesh.position.lerp(c.target, 0.25);
    this.renderer.render(this.scene, this.camera);
  };
  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.resize.disconnect();
    this.el.removeEventListener('pointerdown', this.down);
    this.el.removeEventListener('pointermove', this.move);
    this.el.removeEventListener('pointerup', this.up);
    this.el.removeEventListener('pointercancel', this.up);
    this.el.removeEventListener('wheel', this.wheel);
    window.removeEventListener('keydown', this.key);
    this.scene.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach((m) => m.dispose());
      }
    });
    this.texture?.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
