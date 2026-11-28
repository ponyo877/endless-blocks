import type { Board } from './api';
import type { GameState } from './sim';
import { SIDE_DOWN, SIDE_LEFT, SIDE_RIGHT, SIDE_UP } from './sim';

// DOM heads-up display and the game's screens (title, pause, result).

export interface ResultInfo {
  score: number;
  best: number;
  newBest: boolean;
  cause: 'crash' | 'stall';
  hitClass: number;
  distance: number;
  time: number;
  bestChain: number;
  counts: Record<string, number>;
}

export interface HudHandlers {
  play(): void;
  retry(): void;
  resume(): void;
  menu(): void;
  share(): void;
  newWorld(): void;
  daily(): void;
  toggleSound(): void;
  setInvert(on: boolean): void;
  submit(name: string): void;
}

export type SubmitView =
  | { kind: 'hidden' }
  | { kind: 'form'; name: string; msg?: string }
  | { kind: 'busy'; msg: string }
  | { kind: 'done'; msg: string; error?: boolean };

const LABELS: Record<string, string> = {
  close: 'CLOSE CALL',
  thread: 'THREAD THE NEEDLE',
  skim: 'WATER SKIM',
  canopy: 'UNDER THE CANOPY',
  tube: 'TUBE RUN',
};

const fmt = (n: number) => Math.floor(n).toLocaleString('en-US');

function el<T extends HTMLElement = HTMLElement>(root: HTMLElement, sel: string): T {
  return root.querySelector(sel) as T;
}

export class Hud {
  readonly root: HTMLElement;
  readonly boostButton: HTMLElement;
  private readonly score: HTMLElement;
  private readonly chain: HTMLElement;
  private readonly chainPts: HTMLElement;
  private readonly chainMult: HTMLElement;
  private readonly enc: HTMLElement;
  private readonly best: HTMLElement;
  private readonly liftFill: HTMLElement;
  private readonly liftBox: HTMLElement;
  private readonly speed: HTMLElement;
  private readonly pops: HTMLElement;
  private readonly center: HTMLElement;
  private readonly edges: HTMLElement[];
  private readonly flash: HTMLElement;
  private readonly aim: HTMLElement;
  private readonly stick: HTMLElement;
  private readonly knob: HTMLElement;
  private readonly loading: HTMLElement;
  private readonly loadingBar: HTMLElement;
  private readonly lines: HTMLElement;
  private lastScore = -1;
  private lastChain = -1;
  private lastMult = -1;
  private lastEnc = '';

  constructor(parent: HTMLElement, private readonly h: HudHandlers, touch: boolean) {
    const root = document.createElement('div');
    root.className = 'g-ui' + (touch ? ' touch' : '');
    root.innerHTML = `
      <div class="g-lines"></div>
      <div class="g-edge g-edge-t"></div><div class="g-edge g-edge-b"></div>
      <div class="g-edge g-edge-l"></div><div class="g-edge g-edge-r"></div>
      <div class="g-flash"></div>
      <div class="g-play">
        <div class="g-tl">
          <div class="g-score">0</div>
          <div class="g-chain"><span class="g-chain-pts"></span><span class="g-chain-mult"></span></div>
          <div class="g-enc"></div>
        </div>
        <div class="g-tr">
          <div class="g-best"></div>
          <button class="g-btn g-pausebtn" data-a="pause" aria-label="Pause">II</button>
        </div>
        <div class="g-pops"></div>
        <div class="g-bottom">
          <div class="g-lift"><div class="g-lift-fill"></div></div>
          <div class="g-meta"><span>LIFT</span><span class="g-speed"></span></div>
        </div>
        <div class="g-hint"></div>
        <div class="g-aim"></div>
        <div class="g-stick"><div class="g-knob"></div></div>
        <button class="g-boost" aria-label="Boost">BOOST</button>
      </div>
      <div class="g-center"></div>

      <div class="g-screen g-title"><div class="g-wrap">
        <div class="g-card">
          <div class="g-kicker">ENDLESS BLOCKS</div>
          <h1 class="g-logo">SKIM</h1>
          <p class="g-tag">Fly low. Skim the world. Don't touch it.</p>
          <div class="g-world"></div>
          <button class="g-big" data-a="play">PLAY</button>
          <div class="g-mybest"></div>
          <ul class="g-how">
            <li><b>Fly close</b> to the ground, trees, cliffs and water to score.</li>
            <li><b>Boxed in</b> on more sides, and <b>faster</b>, scores more.</li>
            <li><b>Lift</b> drains in open air and refills near terrain. Crash or stall and it's over.</li>
          </ul>
          <div class="g-keys g-keys-pc">Mouse or WASD steer · Shift or click boost · Esc pause</div>
          <div class="g-keys g-keys-touch">Drag anywhere to steer · hold BOOST</div>
          <div class="g-links">
            <button class="g-link" data-a="daily">Today's world</button> ·
            <button class="g-link" data-a="newWorld">Random world</button> ·
            <a class="g-link" href="../">Watch mode</a>
          </div>
        </div>
        <div class="g-side"></div>
      </div></div>

      <div class="g-screen g-pause">
        <div class="g-card">
          <h2>PAUSED</h2>
          <button class="g-big" data-a="resume">RESUME</button>
          <div class="g-row">
            <button class="g-btn2" data-a="retry">Retry</button>
            <button class="g-btn2" data-a="menu">Menu</button>
          </div>
          <div class="g-row">
            <button class="g-btn2 g-sound" data-a="sound">Sound: on</button>
            <label class="g-check"><input type="checkbox" class="g-invert"> Invert up/down</label>
          </div>
        </div>
      </div>

      <div class="g-screen g-result"><div class="g-wrap">
        <div class="g-card">
          <div class="g-cause"></div>
          <div class="g-final"></div>
          <div class="g-newbest">NEW BEST</div>
          <div class="g-stats"></div>
          <div class="g-submit">
            <form class="g-submit-form">
              <input class="g-name" maxlength="24" placeholder="Name for the leaderboard" autocomplete="nickname" enterkeyhint="send" spellcheck="false">
              <button class="g-btn2 g-send" type="submit">Submit</button>
            </form>
            <div class="g-submit-msg"></div>
          </div>
          <button class="g-big" data-a="retry">RETRY</button>
          <div class="g-row">
            <button class="g-btn2" data-a="share">Share on X</button>
            <button class="g-btn2" data-a="menu">Menu</button>
          </div>
          <div class="g-keys g-keys-pc">R or Space to retry</div>
        </div>
        <div class="g-side"></div>
      </div></div>

      <div class="g-loading"><div>GENERATING WORLD</div><div class="g-loading-track"><div class="g-loading-bar"></div></div></div>
    `;
    parent.appendChild(root);
    this.root = root;
    this.score = el(root, '.g-score');
    this.chain = el(root, '.g-chain');
    this.chainPts = el(root, '.g-chain-pts');
    this.chainMult = el(root, '.g-chain-mult');
    this.enc = el(root, '.g-enc');
    this.best = el(root, '.g-best');
    this.liftFill = el(root, '.g-lift-fill');
    this.liftBox = el(root, '.g-bottom');
    this.speed = el(root, '.g-speed');
    this.pops = el(root, '.g-pops');
    this.center = el(root, '.g-center');
    this.edges = ['t', 'b', 'l', 'r'].map((k) => el(root, `.g-edge-${k}`));
    this.flash = el(root, '.g-flash');
    this.aim = el(root, '.g-aim');
    this.stick = el(root, '.g-stick');
    this.knob = el(root, '.g-knob');
    this.boostButton = el(root, '.g-boost');
    this.loading = el(root, '.g-loading');
    this.loadingBar = el(root, '.g-loading-bar');
    this.lines = el(root, '.g-lines');

    root.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('[data-a]') as HTMLElement | null;
      if (!b) return;
      e.stopPropagation();
      switch (b.dataset.a) {
        case 'play':
          h.play();
          break;
        case 'retry':
          h.retry();
          break;
        case 'resume':
          h.resume();
          break;
        case 'pause':
          h.resume(); // toggles: the game decides
          break;
        case 'menu':
          h.menu();
          break;
        case 'share':
          h.share();
          break;
        case 'newWorld':
          h.newWorld();
          break;
        case 'daily':
          h.daily();
          break;
        case 'sound':
          h.toggleSound();
          break;
      }
    });
    el<HTMLInputElement>(root, '.g-invert').addEventListener('change', (e) => h.setInvert((e.target as HTMLInputElement).checked));
    el(root, '.g-submit-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const input = el<HTMLInputElement>(root, '.g-name');
      input.blur();
      h.submit(input.value);
    });
  }

  /** the leaderboard panel next to the title or result card; null hides it */
  setBoard(screen: 'title' | 'result', board: Board | null, me: string, footer = '', heading = "TODAY'S TOP"): void {
    const side = el(this.root, `.g-${screen} .g-side`);
    side.replaceChildren();
    side.style.display = board ? 'block' : 'none';
    if (!board) return;
    const head = document.createElement('div');
    head.className = 'g-side-h';
    head.textContent = heading;
    const n = document.createElement('span');
    n.textContent = board.total ? `${fmt(board.total)} pilot${board.total === 1 ? '' : 's'}` : '';
    head.appendChild(n);
    side.appendChild(head);
    if (!board.entries.length) {
      const empty = document.createElement('div');
      empty.className = 'g-side-empty';
      empty.textContent = 'No scores yet. Be the first.';
      side.appendChild(empty);
    } else {
      const list = document.createElement('ol');
      list.className = 'g-list';
      for (const e of board.entries) {
        const li = document.createElement('li');
        if (e.playerId === me) li.className = 'me';
        const r = document.createElement('span');
        r.className = 'g-r';
        r.textContent = String(e.rank);
        const nm = document.createElement('span');
        nm.className = 'g-n';
        nm.textContent = e.name;
        if (e.verified === 1) {
          const v = document.createElement('i');
          v.title = 'Replay verified';
          v.textContent = ' ✓';
          nm.appendChild(v);
        }
        const sc = document.createElement('b');
        sc.textContent = fmt(e.score);
        li.append(r, nm, sc);
        list.appendChild(li);
      }
      side.appendChild(list);
    }
    if (footer) {
      const f = document.createElement('div');
      f.className = 'g-side-f';
      f.textContent = footer;
      side.appendChild(f);
    }
  }

  setSubmit(v: SubmitView): void {
    const box = el(this.root, '.g-submit');
    const form = el(this.root, '.g-submit-form');
    const msg = el(this.root, '.g-submit-msg');
    box.style.display = v.kind === 'hidden' ? 'none' : 'block';
    form.style.display = v.kind === 'form' ? 'flex' : 'none';
    msg.classList.toggle('err', v.kind === 'done' && !!v.error);
    if (v.kind === 'form') {
      const input = el<HTMLInputElement>(this.root, '.g-name');
      if (!input.value) input.value = v.name;
      msg.textContent = v.msg ?? '';
    } else if (v.kind !== 'hidden') msg.textContent = v.msg;
  }

  setScreen(name: 'loading' | 'title' | 'play' | 'pause' | 'result'): void {
    this.root.dataset.screen = name;
  }

  setLoading(p: number): void {
    this.loadingBar.style.width = `${Math.round(Math.min(1, p) * 100)}%`;
  }

  setWorld(text: string, best: string): void {
    el(this.root, '.g-world').textContent = text;
    el(this.root, '.g-mybest').textContent = best;
  }

  setBest(best: number, rank = 0): void {
    this.best.textContent = (best > 0 ? `BEST ${fmt(best)}` : '') + (rank > 0 ? ` · #${rank}` : '');
  }

  setSound(on: boolean): void {
    el(this.root, '.g-sound').textContent = `Sound: ${on ? 'on' : 'off'}`;
  }

  setInvert(on: boolean): void {
    el<HTMLInputElement>(this.root, '.g-invert').checked = on;
  }

  /** a short tip above the lift bar; empty to hide */
  setHint(text: string): void {
    const h = el(this.root, '.g-hint');
    if (h.textContent !== text) h.textContent = text;
    h.classList.toggle('on', text !== '');
  }

  /** big centred text (countdown, STALL); empty to hide */
  setCenter(text: string, cls = ''): void {
    if (this.center.textContent !== text) this.center.textContent = text;
    this.center.className = `g-center ${cls}`;
  }

  pop(kind: string, pts: number): void {
    const label = LABELS[kind];
    if (!label) return;
    const d = document.createElement('div');
    d.className = `g-pop g-pop-${kind}`;
    d.innerHTML = `<b>${label}</b> +${fmt(pts)}`;
    this.pops.prepend(d);
    while (this.pops.children.length > 4) this.pops.lastElementChild!.remove();
    setTimeout(() => d.remove(), 1600);
  }

  bank(pts: number): void {
    if (pts < 1) return;
    const d = document.createElement('div');
    d.className = 'g-banked';
    d.textContent = `+${fmt(pts)}`;
    el(this.root, '.g-tl').appendChild(d);
    setTimeout(() => d.remove(), 1100);
  }

  flashScreen(color: string, strength: number): void {
    this.flash.style.transition = 'none';
    this.flash.style.background = color;
    this.flash.style.opacity = String(strength);
    void this.flash.offsetWidth;
    this.flash.style.transition = 'opacity 0.9s ease-out';
    this.flash.style.opacity = '0';
  }

  /** per-frame update while flying */
  update(s: GameState, speedKmh: number, aim: { x: number; y: number } | null, touch: { active: boolean; x0: number; y0: number; dx: number; dy: number }, boost: boolean): void {
    const total = s.total;
    if (total !== this.lastScore) {
      this.lastScore = total;
      this.score.textContent = fmt(s.score);
    }
    const chain = Math.floor(s.chain);
    if (chain !== this.lastChain || s.chainMult !== this.lastMult) {
      this.lastChain = chain;
      this.lastMult = s.chainMult;
      this.chain.classList.toggle('on', chain > 0);
      this.chainPts.textContent = chain > 0 ? `+${fmt(chain)}` : '';
      this.chainMult.textContent = chain > 0 && s.chainMult > 1 ? ` ×${s.chainMult.toFixed(1)}` : '';
    }
    let enc = '';
    if (s.graze > 0) {
      const sd = s.sides;
      if (sd === 15) enc = 'TUBE ×4';
      else if ((sd & (SIDE_LEFT | SIDE_RIGHT)) === (SIDE_LEFT | SIDE_RIGHT) && s.encMult === 2) enc = 'CANYON ×2';
      else if ((sd & (SIDE_UP | SIDE_DOWN)) === (SIDE_UP | SIDE_DOWN) && s.encMult === 2) enc = 'UNDER ×2';
      else if (s.encMult >= 2) enc = `BOXED IN ×${s.encMult}`;
      else enc = 'SKIM';
    }
    if (enc !== this.lastEnc) {
      this.lastEnc = enc;
      this.enc.textContent = enc;
      this.enc.classList.toggle('on', enc !== '');
    }
    this.liftFill.style.transform = `scaleX(${(s.lift / 100).toFixed(3)})`;
    this.liftBox.classList.toggle('low', s.lift < 20);
    this.liftBox.classList.toggle('stall', s.stalled);
    this.liftBox.classList.toggle('boost', boost);
    this.speed.textContent = `${Math.round(speedKmh)} km/h`;

    // edges glow on the side where terrain is close (up, down, left, right)
    for (let k = 0; k < 4; k++) {
      const near = s.sides & (1 << k) ? 1 - s.sideDist[k] / 3.5 : 0;
      const v = near * near;
      this.edges[k].style.opacity = v.toFixed(3);
      this.edges[k].classList.toggle('hot', s.sideDist[k] < 0.8 && (s.sides & (1 << k)) !== 0);
    }

    if (aim) {
      this.aim.style.display = 'block';
      this.aim.style.transform = `translate(${aim.x.toFixed(1)}px, ${aim.y.toFixed(1)}px)`;
    } else this.aim.style.display = 'none';

    if (touch.active) {
      this.stick.style.display = 'block';
      this.stick.style.left = `${touch.x0}px`;
      this.stick.style.top = `${touch.y0}px`;
      const r = Math.min(window.innerWidth, window.innerHeight) * 0.11 + 20;
      const len = Math.hypot(touch.dx, touch.dy);
      const k = len > r ? r / len : 1;
      this.knob.style.transform = `translate(${(touch.dx * k).toFixed(1)}px, ${(touch.dy * k).toFixed(1)}px)`;
    } else this.stick.style.display = 'none';
  }

  /** speed lines: 0..1 */
  setSpeedLines(v: number): void {
    this.lines.style.opacity = v.toFixed(3);
  }

  clearEdges(): void {
    for (const e of this.edges) e.style.opacity = '0';
  }

  showResult(r: ResultInfo): void {
    el(this.root, '.g-cause').textContent = r.cause === 'stall' ? 'STALLED' : r.hitClass === 3 ? 'SPLASHDOWN' : r.hitClass === 2 ? 'INTO THE TREES' : 'CRASHED';
    el(this.root, '.g-final').textContent = fmt(r.score);
    el(this.root, '.g-newbest').style.display = r.newBest ? 'block' : 'none';
    const c = r.counts;
    const rows: [string, string][] = [
      ['Distance', `${fmt(r.distance)} m`],
      ['Time', `${Math.floor(r.time / 60)}:${String(Math.floor(r.time % 60)).padStart(2, '0')}`],
      ['Best chain', fmt(r.bestChain)],
      ['Close calls', String(c.close ?? 0)],
      ['Threads', String(c.thread ?? 0)],
      ['Tube runs', String(c.tube ?? 0)],
      ['Best', fmt(r.best)],
    ];
    el(this.root, '.g-stats').innerHTML = rows.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('');
  }
}
