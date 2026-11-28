// Minimal overlay in the spirit of the original: title, a few controls, auto-fades when idle.

export interface OverlayHandlers {
  togglePlay(): void;
  setSpeed(v: number): void;
  toggleSound(): void;
  toggleFullscreen(): void;
  newSeed(): void;
  copyLink(): Promise<boolean>;
}

const ICON = {
  play: '<svg viewBox="0 0 16 16"><path d="M4 2.5v11l9-5.5z"/></svg>',
  pause: '<svg viewBox="0 0 16 16"><path d="M3.5 2.5h3v11h-3zM9.5 2.5h3v11h-3z"/></svg>',
  soundOn: '<svg viewBox="0 0 16 16"><path d="M2 6h3l4-3.5v11L5 10H2z"/><path d="M11 5.2a4 4 0 0 1 0 5.6M12.8 3.4a6.5 6.5 0 0 1 0 9.2" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
  soundOff: '<svg viewBox="0 0 16 16"><path d="M2 6h3l4-3.5v11L5 10H2z"/><path d="M11 5.5l4 5M15 5.5l-4 5" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
  full: '<svg viewBox="0 0 16 16"><path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
  seed: '<svg viewBox="0 0 16 16"><path d="M13.5 8A5.5 5.5 0 1 1 11.6 3.8" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10 1.5h3.8v3.8z"/></svg>',
  link: '<svg viewBox="0 0 16 16"><path d="M6.5 9.5l3-3M7 4.5l1.3-1.3a2.6 2.6 0 0 1 3.7 3.7L10.7 8.2M9 11.5l-1.3 1.3a2.6 2.6 0 0 1-3.7-3.7L5.3 7.8" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
};

/** slider position (-1..1) <-> speed (blocks/s); quadratic for fine control near zero */
export const MAX_SPEED = 64;
export function sliderToSpeed(p: number): number {
  return Math.sign(p) * p * p * MAX_SPEED;
}
export function speedToSlider(v: number): number {
  return Math.sign(v) * Math.sqrt(Math.min(1, Math.abs(v) / MAX_SPEED));
}

export class Overlay {
  readonly root: HTMLElement;
  private readonly playBtn: HTMLButtonElement;
  private readonly soundBtn: HTMLButtonElement;
  private readonly slider: HTMLInputElement;
  private readonly speedLabel: HTMLElement;
  private readonly place: HTMLElement;
  private readonly seedLabel: HTMLElement;
  private readonly toast: HTMLElement;
  private readonly loading: HTMLElement;
  private readonly loadingBar: HTMLElement;
  readonly hud: HTMLElement;
  private idleTimer = 0;
  private hidden = false;
  private dragging = false;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(parent: HTMLElement, private readonly h: OverlayHandlers, seed: number) {
    const root = document.createElement('div');
    root.className = 'overlay';
    root.innerHTML = `
      <div class="ov-top">
        <div class="ov-title">ENDLESS BLOCKS</div>
        <div class="ov-place"></div>
      </div>
      <a class="ov-game" href="play/" title="Fly it yourself: skim the terrain for points">Play SKIM <span>▶</span></a>
      <div class="ov-bar">
        <button class="ov-btn" data-a="play" title="Play / pause (Space)"></button>
        <div class="ov-speed">
          <span class="ov-rev">◀</span>
          <input type="range" min="-1" max="1" step="0.001" aria-label="Speed" />
          <span class="ov-fwd">▶</span>
          <span class="ov-speed-label"></span>
        </div>
        <button class="ov-btn" data-a="sound" title="Ambient sound (M)"></button>
        <button class="ov-btn" data-a="full" title="Fullscreen (F)">${ICON.full}</button>
        <span class="ov-sep"></span>
        <span class="ov-seed" title="Seed"></span>
        <button class="ov-btn" data-a="seed" title="New world (N)">${ICON.seed}</button>
        <button class="ov-btn" data-a="link" title="Copy a link to this world">${ICON.link}</button>
      </div>
      <div class="ov-help">Space play/pause · ↑↓ faster/reverse · Wheel fine speed · F fullscreen · M sound · H hide UI · N new world · I info</div>
      <div class="ov-toast"></div>
      <div class="ov-loading"><div class="ov-loading-text">Generating world</div><div class="ov-loading-track"><div class="ov-loading-bar"></div></div></div>
      <pre class="ov-hud"></pre>
    `;
    parent.appendChild(root);
    this.root = root;
    const q = <T extends HTMLElement>(s: string) => root.querySelector(s) as T;
    this.playBtn = q('[data-a=play]');
    this.soundBtn = q('[data-a=sound]');
    this.slider = q('input');
    this.speedLabel = q('.ov-speed-label');
    this.place = q('.ov-place');
    this.seedLabel = q('.ov-seed');
    this.toast = q('.ov-toast');
    this.loading = q('.ov-loading');
    this.loadingBar = q('.ov-loading-bar');
    this.hud = q('.ov-hud');
    this.seedLabel.textContent = `seed ${seed}`;

    this.playBtn.onclick = () => h.togglePlay();
    this.soundBtn.onclick = () => h.toggleSound();
    q<HTMLButtonElement>('[data-a=full]').onclick = () => h.toggleFullscreen();
    q<HTMLButtonElement>('[data-a=seed]').onclick = () => h.newSeed();
    q<HTMLButtonElement>('[data-a=link]').onclick = async () => {
      const ok = await h.copyLink();
      this.showToast(ok ? 'Link copied' : 'Could not copy the link');
    };
    this.slider.addEventListener('input', () => h.setSpeed(sliderToSpeed(Number(this.slider.value))));
    this.slider.addEventListener('pointerdown', () => (this.dragging = true));
    window.addEventListener('pointerup', () => (this.dragging = false));
    this.slider.addEventListener('dblclick', () => h.setSpeed(8));
    // keep keyboard shortcuts working after clicking a control
    for (const el of root.querySelectorAll('button, input')) {
      el.addEventListener('keydown', (e) => {
        const k = (e as KeyboardEvent).key;
        if (k === ' ' || k.startsWith('Arrow')) e.preventDefault();
      });
      el.addEventListener('pointerup', () => (el as HTMLElement).blur());
    }
    const wake = () => this.wake();
    window.addEventListener('pointermove', wake);
    window.addEventListener('pointerdown', wake);
    window.addEventListener('keydown', wake);
    this.wake();
  }

  wake(): void {
    this.idleTimer = 3;
    document.body.classList.remove('idle');
  }

  tick(dt: number): void {
    if (this.dragging || this.root.matches(':hover') && this.isOverBar()) {
      this.idleTimer = 3;
    }
    if (this.idleTimer > 0) {
      this.idleTimer -= dt;
      if (this.idleTimer <= 0) document.body.classList.add('idle');
    }
  }

  private isOverBar(): boolean {
    const bar = this.root.querySelector('.ov-bar');
    return !!bar && bar.matches(':hover');
  }

  toggleHidden(): void {
    this.hidden = !this.hidden;
    document.body.classList.toggle('ui-hidden', this.hidden);
  }

  setPlaying(playing: boolean): void {
    this.playBtn.innerHTML = playing ? ICON.pause : ICON.play;
  }

  setSound(on: boolean): void {
    this.soundBtn.innerHTML = on ? ICON.soundOn : ICON.soundOff;
    this.soundBtn.classList.toggle('on', on);
  }

  setSpeed(v: number, actual: number): void {
    if (!this.dragging) this.slider.value = String(speedToSlider(v));
    const s = Math.abs(v) < 0.05 ? '0' : v.toFixed(Math.abs(v) < 10 ? 1 : 0);
    this.speedLabel.textContent = `${s} m/s`;
    this.speedLabel.classList.toggle('slow', Math.abs(actual) + 0.5 < Math.abs(v));
  }

  setPlace(text: string): void {
    if (this.place.textContent !== text) this.place.textContent = text;
  }

  setLoading(progress: number | null): void {
    if (progress === null) {
      this.loading.classList.add('done');
    } else {
      this.loading.classList.remove('done');
      this.loadingBar.style.width = `${Math.round(Math.min(1, progress) * 100)}%`;
    }
  }

  showToast(text: string): void {
    this.toast.textContent = text;
    this.toast.classList.add('show');
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toast.classList.remove('show'), 1800);
  }
}
