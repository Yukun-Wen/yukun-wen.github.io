/**
 * 星盘组件（零依赖）
 *
 * 设计要点：
 * 1. 输入抽象 —— 鼠标 / 触摸 / 手势统统变成 pointerDown(id, x, y, src)。
 *    组件内部只认「指针」，不认来源，所以摄像头永远是可选的增强层。
 * 2. 命中判定自己做 —— 根节点 pointer-events:none，在 window 捕获阶段判断
 *    是否落在圆内，只有落进来才 preventDefault，页面其余部分完全不受影响。
 * 3. 三层结构 —— 网盘（星图，可缩放旋转）/ 母盘（刻度环，固定）/ 指针（百分比）。
 *    刻度环不转，指针角度 = pct × 3.6°，永远可逆。
 */

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const wrapPi = (a) => (((a + Math.PI) % TAU) + TAU) % TAU - Math.PI;

const SERIF = '"Iowan Old Style", "Palatino Linotype", "Songti SC", Georgia, serif';

/** 几何比例：全部相对于组件边长 S */
const GEO = {
  art: 0.330,      // 星图圆盘半径
  ringIn: 0.374,   // 刻度环内沿
  ringOut: 0.420,  // 刻度环外沿
  labelR: 0.4625,  // 数字半径
  labelFont: 0.0405,
  badgeR: 0.142,   // 中央读数底盘
  badgeFont: 0.09,
};

const DEFAULTS = {
  /** 原图里星盘的圆心与半径（占图宽的比例），已按实际素材拟合 */
  crop: { cx: 0.4891, cy: 0.4983, r: 0.512 },
  minZoom: 1,
  maxZoom: 2.6,
  /** 点击盘面时的三档缩放 */
  clickZooms: [1.75, 2.35],
  /** 百分比吸附步长，0 = 连续 */
  percentSnap: 1,
  /** 复位时是否把百分比也归零 */
  resetPercent: true,
  /** 点空白是否复位 */
  resetOnOutside: true,
  /** light = 奶油纸版；dark = 黑金线稿版 */
  theme: 'light',
  /** 把原图按彩度抠成透明底的金色墨线（dark 主题用） */
  ink: false,
  /** 边长小于这个值就不画数字刻度 */
  labelMin: 148,
  /** 内外两环反向自转（弧度/秒）；spin:false 关掉 */
  spin: true,
  spinInner: 0.16, // 顺时针（9.2°/s，约 39 秒一圈）
  spinOuter: 0.08, // 逆时针（4.6°/s，约 78 秒一圈）
  /** 分界半径：占星图半径的比例（落在星图那圈空白带上） */
  split: 0.71,
  /** 这些元素上的指针事件不归组件管 */
  ignore: '[data-dial-ignore]',
  palette: null,
};

export const THEMES = {
  light: {
    plate: '#edede4',
    band: 'rgba(27,23,18,0.035)',
    bandActive: 'rgba(184,145,47,0.10)',
    tickMajor: 'rgba(168,130,40,0.95)',
    tickMinor: 'rgba(184,145,47,0.40)',
    label: 'rgba(122,95,36,0.88)',
    notch: 'rgba(168,130,40,0.9)',
    arc: 'rgba(184,145,47,0.92)',
    needle: 'rgba(122,92,32,0.9)',
    needleHead: '#b8912f',
    needleGlow: 'rgba(184,145,47,0.5)',
    badgeFill: 'rgba(237,237,228,0.9)',
    badgeStroke: 'rgba(184,145,47,0.32)',
    badgeText: '#8a6a2f',
    halo: null,
  },
  dark: {
    plate: '#0a0908',
    band: 'rgba(242,215,154,0.045)',
    bandActive: 'rgba(242,215,154,0.10)',
    tickMajor: 'rgba(226,198,132,0.95)',
    tickMinor: 'rgba(201,163,74,0.44)',
    label: 'rgba(226,198,132,0.82)',
    notch: 'rgba(226,198,132,0.9)',
    arc: 'rgba(242,215,154,0.95)',
    needle: 'rgba(246,214,150,0.92)',
    needleHead: '#fbe6b4',
    needleGlow: 'rgba(255,226,150,0.85)',
    badgeFill: 'rgba(6,5,4,0.88)',
    badgeStroke: 'rgba(201,163,74,0.28)',
    badgeText: '#f6e0b0',
    halo: 'rgba(201,163,74,0.09)',
  },
};

export class Astrolabe extends EventTarget {
  constructor(root, options = {}) {
    super();
    this.root = root;
    this.canvas = root.querySelector('canvas') || root.appendChild(document.createElement('canvas'));
    this.ctx = this.canvas.getContext('2d');
    this.o = { ...DEFAULTS, ...options };
    this.pal = { ...(THEMES[this.o.theme] || THEMES.light), ...(this.o.palette || {}) };

    this.plate = this.pal.plate;
    this.img = null;
    this.inkCanvas = null;
    /** false = 百分比交给外部驱动（滚动进度），true = 用户接管 */
    this.manual = false;

    this.zoom = 1;
    this.rot = 0;   // 弧度
    this.pct = 0;   // 0..100

    this.size = 0;
    this.dpr = 1;
    this.geo = { rArt: 0, rIn: 0, rOut: 0 };

    this.pointers = new Map();   // id -> { x, y, src }
    this.gesture = null;
    this.hadPinch = false;

    this.anim = null;
    this._raf = 0;
    this._suppressClickUntil = 0;
    this._cursor = '';

    this._bind();
    this._resize();

    this._ro = new ResizeObserver(() => this._resize());
    this._ro.observe(root);

    // 从别的标签页回来时，自转循环得重新接上
    this._onVis = () => {
      if (document.visibilityState === 'visible') this._mark();
    };
    document.addEventListener('visibilitychange', this._onVis);
  }

  /* ================= 对外 API ================= */

  setImage(img) {
    this.img = img;
    if (this.o.ink) {
      this._inkN = 0;
      this._rebuildInk();
    } else {
      this.plate = samplePlate(img, this.o.crop);
    }
    this.root.dispatchEvent(new CustomEvent('dial:ready', { detail: { plate: this.plate } }));
    this._mark();
  }

  /**
   * 线稿必须按「显示尺寸」重建：先在目标分辨率下缩小，再抠彩度。
   * 反过来（先抠再缩小）会把只有一像素宽的金线平均成一片灰。
   */
  _rebuildInk() {
    if (!this.o.ink || !this.img) return;
    const N = Math.min(1024, Math.max(160, Math.round(this.size * this.dpr)));
    this.inkCanvas = buildInk(this.img, this.o.crop, N);
    this._inkN = N;
  }

  get value() {
    return { pct: this.pct, zoom: this.zoom, rot: this.rot };
  }

  isModified() {
    return (
      this.zoom > 1.002 ||
      Math.abs(wrapPi(this.rot)) > 0.002 ||
      (this.manual && this.pct > 0.001)
    );
  }

  /** 在「外部驱动」和「用户接管」之间切换 */
  setManual(on) {
    on = !!on;
    if (this.manual === on) return;
    this.manual = on;
    this.root.dispatchEvent(new CustomEvent('dial:auto', { detail: { manual: on } }));
  }

  setPercent(v, { silent = false } = {}) {
    v = clamp(v, 0, 100);
    const snap = this.o.percentSnap;
    if (snap > 0) v = Math.round(v / snap) * snap;
    v = clamp(v, 0, 100);
    if (Math.abs(v - this.pct) < 1e-6) return;
    this.pct = v;
    this._mark();
    if (!silent) this._emit();
  }

  setZoom(v) {
    this.zoom = clamp(v, this.o.minZoom, this.o.maxZoom);
    this._mark();
    this._emit();
  }

  reset({ animate = true } = {}) {
    const to = { zoom: 1, rot: 0 };
    // 只把「用户拨过」的百分比归零；否则交回外部驱动
    if (this.o.resetPercent && this.manual) to.pct = 0;
    this.setManual(false);
    if (!animate) {
      this.zoom = to.zoom;
      this.rot = to.rot;
      if ('pct' in to) this.pct = to.pct;
      this._mark();
      this._emit();
      return;
    }
    this._animateTo(to, 520);
  }

  /** 手势层调用：把虚拟指针注入同一条管线 */
  pointerDown(id, clientX, clientY, src = 'hand') {
    const p = this._local(clientX, clientY);
    const zone = this._zone(p.x, p.y);
    if (zone === 'out') {
      // 手势没有"点空白"的机会，所以在盘外捏一下就等于点了空白
      if (src === 'hand') this._outsideDown();
      return false;
    }
    if (this.pointers.size >= 3) return false;
    this.anim = null;
    this.setManual(true);
    this._suppressClickUntil = performance.now() + 400;
    this.pointers.set(id, { x: p.x, y: p.y, src });
    this._begin();
    return true;
  }

  pointerMove(id, clientX, clientY) {
    const prev = this.pointers.get(id);
    if (!prev) return false;
    const p = this._local(clientX, clientY);
    this.pointers.set(id, { x: p.x, y: p.y, src: prev.src });
    this._update(p, prev);
    return true;
  }

  pointerUp(id) {
    if (!this.pointers.has(id)) return false;
    this.pointers.delete(id);
    this._end();
    return true;
  }

  destroy() {
    window.removeEventListener('pointerdown', this._h.down, true);
    window.removeEventListener('pointermove', this._h.move, true);
    window.removeEventListener('pointerup', this._h.up, true);
    window.removeEventListener('pointercancel', this._h.up, true);
    window.removeEventListener('wheel', this._h.wheel, true);
    window.removeEventListener('touchmove', this._h.touch, true);
    window.removeEventListener('click', this._h.click, true);
    this.root.removeEventListener('keydown', this._h.key);
    document.removeEventListener('visibilitychange', this._onVis);
    this._ro.disconnect();
    if (this._raf) cancelAnimationFrame(this._raf);
  }

  /* ================= 事件 ================= */

  _bind() {
    this._h = {
      down: (e) => this._onDown(e),
      move: (e) => this._onMove(e),
      up: (e) => this._onUp(e),
      wheel: (e) => this._onWheel(e),
      click: (e) => {
        if (performance.now() < this._suppressClickUntil) {
          e.preventDefault();
          e.stopPropagation();
        }
      },
      key: (e) => this._onKey(e),
    };
    window.addEventListener('pointerdown', this._h.down, true);
    window.addEventListener('pointermove', this._h.move, true);
    window.addEventListener('pointerup', this._h.up, true);
    window.addEventListener('pointercancel', this._h.up, true);
    window.addEventListener('wheel', this._h.wheel, { capture: true, passive: false });
    // 手指在盘上拖的时候别把页面滚走（pointer-events:none 挡不住 touchmove）
    this._h.touch = (e) => {
      if (this.gesture) e.preventDefault();
    };
    window.addEventListener('touchmove', this._h.touch, { capture: true, passive: false });
    window.addEventListener('click', this._h.click, true);
    this.root.addEventListener('keydown', this._h.key);
  }

  _onDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // 组件自带的按钮不参与指针逻辑
    const t = e.target;
    if (this.o.ignore && t && t.closest && t.closest(this.o.ignore)) return;
    const p = this._local(e.clientX, e.clientY);
    const zone = this._zone(p.x, p.y);

    if (zone === 'out') {
      this._outsideDown();
      return;
    }

    e.preventDefault();
    e.stopPropagation();
    this.anim = null;
    this.setManual(true);
    this._suppressClickUntil = performance.now() + 400;
    if (this.pointers.size >= 3) return;
    this.pointers.set(e.pointerId, { x: p.x, y: p.y, src: 'pointer' });
    this._begin();
  }

  _onMove(e) {
    const p = this._local(e.clientX, e.clientY);
    const prev = this.pointers.get(e.pointerId);

    if (!prev) {
      if (e.pointerType === 'mouse') this._hover(p);
      return;
    }
    e.preventDefault();
    this.pointers.set(e.pointerId, { x: p.x, y: p.y, src: prev.src });
    this._update(p, prev);
  }

  _onUp(e) {
    if (!this.pointers.has(e.pointerId)) return;
    e.preventDefault();
    this.pointers.delete(e.pointerId);
    this._end();
  }

  _onWheel(e) {
    const p = this._local(e.clientX, e.clientY);
    if (this._zone(p.x, p.y) === 'out') return;
    e.preventDefault();
    e.stopPropagation();
    this.anim = null;
    this.setManual(true);
    const f = Math.exp(-e.deltaY * 0.0015);
    this.setZoom(this.zoom * f);
  }

  _onKey(e) {
    const step = e.shiftKey ? 5 : 1;
    let handled = true;
    if (e.key.indexOf('Arrow') === 0) this.setManual(true);
    switch (e.key) {
      case 'ArrowLeft':  this.setPercent(this.pct - step); break;
      case 'ArrowRight': this.setPercent(this.pct + step); break;
      case 'ArrowUp':    this.setZoom(this.zoom * 1.12); break;
      case 'ArrowDown':  this.setZoom(this.zoom / 1.12); break;
      case 'Home':
      case 'Escape':     this.reset(); break;
      case ' ':
        e.preventDefault();
        this._zoomCycle();
        return;
      default: handled = false;
    }
    if (handled) e.preventDefault();
  }

  /** 点空白：复位，但不拦截事件，页面照常工作 */
  _outsideDown() {
    if (!this.o.resetOnOutside) return;
    if (!this.isModified()) return;
    this.reset();
  }

  /* ================= 手势状态机 ================= */

  _begin() {
    const entries = [...this.pointers.entries()];
    this.anim = null;

    if (entries.length >= 2) {
      const a = entries[0][1];
      const b = entries[1][1];
      this.gesture = {
        mode: 'pinch',
        d0: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
        a0: Math.atan2(b.y - a.y, b.x - a.x),
        z0: this.zoom,
        r0: this.rot,
        t0: performance.now(),
        sx: (a.x + b.x) / 2,
        sy: (a.y + b.y) / 2,
        moved: 0,
        src: a.src,
      };
      this.hadPinch = true;
      return;
    }

    const p = entries[0][1];
    const zone = this._zone(p.x, p.y);
    const scrub = zone === 'ring' || zone === 'needle';
    this.gesture = {
      mode: scrub ? 'scrub' : 'rotate',
      zone,
      lastAngle: Math.atan2(p.y, p.x),
      t0: performance.now(),
      sx: p.x,
      sy: p.y,
      moved: 0,
      src: p.src,
    };
    if (scrub) this._applyPercent(this._pctAt(p.x, p.y));
  }

  _update(p, prev) {
    const g = this.gesture;
    if (!g) return;

    g.moved += Math.hypot(p.x - prev.x, p.y - prev.y);

    if (g.mode === 'scrub') {
      this._applyPercent(this._pctAt(p.x, p.y));
    } else if (g.mode === 'rotate') {
      const a = Math.atan2(p.y, p.x);
      this.rot += wrapPi(a - g.lastAngle);
      g.lastAngle = a;
      this._mark();
    } else if (g.mode === 'pinch') {
      const ps = [...this.pointers.values()];
      if (ps.length < 2) return;
      const [a, b] = ps;
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      this.zoom = clamp((g.z0 * d) / g.d0, this.o.minZoom, this.o.maxZoom);
      this.rot = g.r0 + wrapPi(ang - g.a0);
      this._mark();
    }
  }

  _end() {
    const g = this.gesture;

    if (this.pointers.size === 0) {
      const dt = g ? performance.now() - g.t0 : 1e9;
      const limit = g && g.src === 'hand' ? 26 : 10;
      if (g && g.mode !== 'scrub' && !this.hadPinch && g.moved < limit && dt < 700) {
        this._click(g.sx, g.sy);
      }
      if (g && g.mode === 'scrub') {
        this.root.dispatchEvent(new CustomEvent('dial:scrubend'));
      }
      this.gesture = null;
      this.hadPinch = false;
      return;
    }

    // 松开一根手指 / 一只手之后，用剩下的那个重新定基线
    this.hadPinch = this.hadPinch || this.pointers.size > 1;
    this._begin();
  }

  _click(x, y) {
    this._zoomCycle();
  }

  _zoomCycle() {
    const [z1, z2] = this.o.clickZooms;
    let target;
    if (this.zoom < 1.05) target = z1;
    else if (this.zoom < z1 * 1.1) target = z2;
    else target = this.o.minZoom;
    this._animateTo({ zoom: target }, 460);
  }

  _applyPercent(v) {
    const snap = this.o.percentSnap;
    v = clamp(v, 0, 100);
    if (snap > 0) v = clamp(Math.round(v / snap) * snap, 0, 100);
    if (Math.abs(v - this.pct) < 1e-6) return;
    this.pct = v;
    this._mark();
    this._emit();
    // 用户亲手拨的，不是外部同步进来的 —— 外部据此把页面滚过去
    this.root.dispatchEvent(new CustomEvent('dial:scrub', { detail: { pct: this.pct } }));
  }

  _pctAt(x, y) {
    const a = Math.atan2(y, x);                       // 0 = 3 点方向
    const deg = (a * 180 / Math.PI + 90 + 360) % 360;  // 12 点 = 0°，顺时针
    return deg / 3.6;
  }

  /* ================= 命中判定 ================= */

  _local(clientX, clientY) {
    const r = this.root.getBoundingClientRect();
    return {
      x: clientX - (r.left + r.width / 2),
      y: clientY - (r.top + r.height / 2),
    };
  }

  _zone(x, y) {
    const r = Math.hypot(x, y);
    if (r > this.geo.rOut * 1.10) return 'out';
    if (r >= this.geo.rIn) return 'ring';
    // 指针本身就是个把手：抓住它也能读百分比
    if (this._nearNeedle(x, y)) return 'needle';
    return 'art';
  }

  /** 点到指针这根线的垂距（只在针尖那一侧、读数盘之外算） */
  _nearNeedle(x, y) {
    const S = this.size;
    const a = -Math.PI / 2 + (this.pct / 100) * TAU;
    const cx = Math.cos(a);
    const cy = Math.sin(a);
    const proj = x * cx + y * cy;      // 沿针方向
    if (proj < S * GEO.badgeR * 0.95) return false;
    const perp = Math.abs(-x * cy + y * cx);
    // 手指/手都不精细，给得比鼠标宽一点
    return perp <= Math.max(14, S * 0.065);
  }

  _hover(p) {
    const zone = this._zone(p.x, p.y);
    const want = zone === 'ring' || zone === 'needle' ? 'grab' : zone === 'art' ? 'pointer' : '';
    if (want !== this._cursor) {
      this._cursor = want;
      document.documentElement.style.cursor = want;
    }
  }

  /* ================= 渲染 ================= */

  _resize() {
    const w = Math.round(this.root.clientWidth || 240);
    if (Math.abs(w - this.size) < 0.5 && this.canvas.width) return;
    this.size = w;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(w * this.dpr);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = w + 'px';

    const S = w;
    this.geo = { rArt: S * GEO.art, rIn: S * GEO.ringIn, rOut: S * GEO.ringOut };

    if (this.o.ink && this.img) {
      const N = Math.min(1024, Math.max(160, Math.round(S * this.dpr)));
      if (N !== this._inkN) this._rebuildInk();
    }
    this._mark();
  }

  _mark() {
    this._schedule();
  }

  _schedule() {
    if (this._raf) return;
    this._raf = requestAnimationFrame((t) => {
      this._raf = 0;
      this._frame(t);
    });
  }

  _frame(now) {
    const a = this.anim;
    if (a) {
      const k = clamp((now - a.t0) / a.dur, 0, 1);
      const e = easeOutCubic(k);
      this.zoom = lerp(a.from.zoom, a.to.zoom, e);
      this.rot = lerp(a.from.rot, a.to.rot, e);
      this.pct = lerp(a.from.pct, a.to.pct, e);
      if (k >= 1) {
        this.anim = null;
        this.zoom = a.to.zoom;
        this.rot = a.to.rot;
        this.pct = a.to.pct;
      }
    }
    this._draw();
    this._emit();
    if (this.anim || this._spinning()) this._schedule();
  }

  /** 只有真正看得见、且用户没要求减少动效时才转 */
  /** 外部把组件从隐藏切成可见时叫一声，自转循环才会接上 */
  kick() {
    this._mark();
  }

  _spinning() {
    if (!this.o.spin) return false;
    if (this._reduceMotion()) return false;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return false;
    return this.root.classList.contains('on');
  }

  _reduceMotion() {
    return (
      typeof window !== 'undefined' &&
      window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    );
  }

  /** 只累积"可见时"的时间，藏起来再出现不会跳一下 */
  _spinSeconds(now) {
    if (this._spinLast === undefined) {
      this._spinLast = now;
      this._spinAcc = 0;
      return 0;
    }
    const dt = Math.max(0, Math.min(0.12, (now - this._spinLast) / 1000));
    this._spinLast = now;
    if (this._spinning()) this._spinAcc += dt;
    return this._spinAcc;
  }

  _animateTo(to, dur) {
    const from = { zoom: this.zoom, rot: this.rot, pct: this.pct };
    const target = { ...from, ...to };
    target.rot = this.rot + wrapPi((to.rot ?? this.rot) - this.rot);
    this.anim = { from, to: target, t0: performance.now(), dur };
    this._schedule();
  }

  _emit() {
    // 自转是 60fps 的，读数没变就别反复写 DOM
    const sig =
      Math.round(this.pct * 10) +
      '|' +
      Math.round(this.zoom * 1000) +
      '|' +
      Math.round(wrapPi(this.rot) * 1000);
    if (sig === this._emitSig) return;
    this._emitSig = sig;

    const detail = { pct: this.pct, zoom: this.zoom, rot: this.rot };
    this.root.setAttribute('aria-valuenow', String(Math.round(this.pct)));
    this.root.dispatchEvent(new CustomEvent('dial:change', { detail }));
  }

  _draw() {
    const c = this.ctx;
    const S = this.size;
    const C = S / 2;
    const { rArt, rIn, rOut } = this.geo;

    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.clearRect(0, 0, S, S);
    c.save();
    c.translate(C, C);

    /* --- 0. 底光（深色主题才有） --- */
    if (this.pal.halo) {
      const halo = c.createRadialGradient(0, 0, rArt * 0.15, 0, 0, rArt * 1.5);
      halo.addColorStop(0, this.pal.halo);
      halo.addColorStop(1, 'rgba(0,0,0,0)');
      c.beginPath();
      c.arc(0, 0, rArt * 1.5, 0, TAU);
      c.fillStyle = halo;
      c.fill();
    }

    /* --- 1. 星图（网盘） --- */
    c.save();
    c.beginPath();
    c.arc(0, 0, rArt, 0, TAU);
    c.clip();

    if (this.o.ink) {
      // 线稿版：纸已经抠掉了，直接在黑底上画金色墨线
      if (this.inkCanvas) {
        const t = this._spinSeconds(performance.now());
        // 拖动整体转；静止时内外两环反向走
        const inner = this.rot + t * this.o.spinInner;
        const outer = this.rot - t * this.o.spinOuter;
        const rSplit = rArt * this.o.split;

        const paint = (clipPath, angle) => {
          c.save();
          clipPath();
          c.clip();
          c.rotate(angle);
          c.scale(this.zoom, this.zoom);
          c.imageSmoothingQuality = 'high';
          c.globalAlpha = 0.92;
          c.drawImage(this.inkCanvas, -rArt, -rArt, rArt * 2, rArt * 2);
          c.restore();
        };

        // 内盘：顺时针
        paint(() => c.arc(0, 0, rSplit, 0, TAU), inner);
        // 外环：逆时针
        paint(() => {
          c.arc(0, 0, rArt, 0, TAU);
          c.arc(0, 0, rSplit, 0, TAU, true);
        }, outer);

        // 分界的细圈，把接缝收干净
        c.beginPath();
        c.arc(0, 0, rSplit, 0, TAU);
        c.strokeStyle = 'rgba(201,163,74,0.32)';
        c.lineWidth = Math.max(0.7, S * 0.003);
        c.stroke();
      }
    } else {
      c.fillStyle = this.plate;
      c.fill();

      if (this.img) {
        const W = this.img.naturalWidth || this.img.width;
        const H = this.img.naturalHeight || this.img.height;
        const side = 2 * this.o.crop.r * W;
        c.save();
        c.rotate(this.rot);
        c.scale(this.zoom, this.zoom);
        c.drawImage(
          this.img,
          this.o.crop.cx * W - side / 2,
          this.o.crop.cy * H - side / 2,
          side,
          side,
          -rArt, -rArt, rArt * 2, rArt * 2,
        );
        c.restore();
      }

      // 边缘羽化：把盘子外围淡淡融进纸色，避免出现一刀切的硬边
      const fade = c.createRadialGradient(0, 0, rArt * 0.975, 0, 0, rArt);
      fade.addColorStop(0, alpha(this.plate, 0));
      fade.addColorStop(1, alpha(this.plate, 1));
      c.beginPath();
      c.arc(0, 0, rArt, 0, TAU);
      c.fillStyle = fade;
      c.fill();
    }
    c.restore();

    /* --- 2. 指针（读数角） --- */
    this._drawNeedle(c, S, rOut);

    /* --- 3. 刻度环（母盘，固定不转） --- */
    this._drawRing(c, S, rIn, rOut);

    /* --- 4. 中央读数 --- */
    this._drawBadge(c, S);

    c.restore();
  }

  _drawNeedle(c, S, rOut) {
    const a = -Math.PI / 2 + (this.pct / 100) * TAU;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    const start = S * GEO.badgeR * 0.92;
    const tip = rOut - S * 0.004;

    c.save();
    c.lineCap = 'round';

    // 进度弧：从 12 点顺时针到指针
    if (this.pct > 0.4) {
      c.beginPath();
      c.arc(0, 0, (this.geo.rIn + rOut) / 2, -Math.PI / 2, a);
      c.strokeStyle = this.pal.arc;
      c.lineWidth = Math.max(1.6, S * 0.011);
      c.shadowColor = this.pal.needleGlow;
      c.shadowBlur = S * 0.022;
      c.stroke();
      c.shadowBlur = 0;
    }

    // 细针
    c.beginPath();
    c.moveTo(dx * start, dy * start);
    c.lineTo(dx * tip, dy * tip);
    c.strokeStyle = this.pal.needle;
    c.lineWidth = Math.max(1.2, S * 0.0042);
    c.stroke();

    // 针尖菱形
    const px = -dy;
    const py = dx;
    const w = S * 0.0125;
    const len = S * 0.032;
    c.beginPath();
    c.moveTo(dx * (tip + S * 0.004), dy * (tip + S * 0.004));
    c.lineTo(dx * (tip - len) + px * w, dy * (tip - len) + py * w);
    c.lineTo(dx * (tip - len * 1.5), dy * (tip - len * 1.5));
    c.lineTo(dx * (tip - len) - px * w, dy * (tip - len) - py * w);
    c.closePath();
    c.fillStyle = this.pal.needleHead;
    c.shadowColor = this.pal.needleGlow;
    c.shadowBlur = S * 0.02;
    c.fill();
    c.restore();
  }

  _drawRing(c, S, rIn, rOut) {
    const active = this.gesture && this.gesture.mode === 'scrub';

    // 底带
    c.save();
    c.beginPath();
    c.arc(0, 0, (rIn + rOut) / 2, 0, TAU);
    c.lineWidth = rOut - rIn;
    c.strokeStyle = active ? this.pal.bandActive : this.pal.band;
    c.stroke();
    c.restore();

    // 100 格刻度（组件小时隔一格画，不然糊成一片）
    c.save();
    c.lineCap = 'round';
    const step = S < 140 ? 2 : 1;
    for (let i = 0; i < 100; i += step) {
      const a = -Math.PI / 2 + (i / 100) * TAU;
      const major = i % 10 === 0;
      const mid = i % 5 === 0;
      const len = major ? S * 0.026 : mid ? S * 0.017 : S * 0.0095;
      c.beginPath();
      c.moveTo(Math.cos(a) * rOut, Math.sin(a) * rOut);
      c.lineTo(Math.cos(a) * (rOut - len), Math.sin(a) * (rOut - len));
      c.lineWidth = major ? Math.max(1.3, S * 0.005) : Math.max(0.75, S * 0.0021);
      c.strokeStyle = major ? this.pal.tickMajor : this.pal.tickMinor;
      c.stroke();
    }
    c.restore();

    // 数字（组件缩得太小时不画，画了也是糊的）
    if (S >= this.o.labelMin) {
      c.save();
      c.font = `500 ${S * GEO.labelFont}px ${SERIF}`;
      c.fillStyle = this.pal.label;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      for (let i = 0; i < 100; i += 10) {
        const a = -Math.PI / 2 + (i / 100) * TAU;
        const r = S * GEO.labelR;
        c.fillText(String(i), Math.cos(a) * r, Math.sin(a) * r);
      }
      c.restore();
    }

    // 12 点缺口
    c.save();
    const top = -Math.PI / 2;
    c.beginPath();
    c.moveTo(Math.cos(top) * (rOut + S * 0.004), Math.sin(top) * (rOut + S * 0.004));
    c.lineTo(Math.cos(top) * (rOut + S * 0.016), Math.sin(top) * (rOut + S * 0.016));
    c.strokeStyle = this.pal.notch;
    c.lineWidth = Math.max(1.2, S * 0.0042);
    c.lineCap = 'round';
    c.stroke();
    c.restore();
  }

  _drawBadge(c, S) {
    const r = S * GEO.badgeR;

    c.save();
    c.beginPath();
    c.arc(0, 0, r, 0, TAU);
    c.fillStyle = this.pal.badgeFill;
    c.fill();
    c.lineWidth = 1;
    c.strokeStyle = this.pal.badgeStroke;
    c.stroke();
    c.restore();

    const num = String(Math.round(this.pct));
    const fs = S * GEO.badgeFont;
    c.save();
    c.fillStyle = this.pal.badgeText;
    c.shadowColor = 'rgba(0,0,0,0.65)';
    c.shadowBlur = S * 0.014;
    c.textBaseline = 'middle';

    c.font = `500 ${fs}px ${SERIF}`;
    const wNum = c.measureText(num).width;
    c.font = `500 ${fs * 0.52}px ${SERIF}`;
    const wPct = c.measureText('%').width;
    const gap = fs * 0.05;
    const x0 = -(wNum + gap + wPct) / 2;

    c.textAlign = 'left';
    c.font = `500 ${fs}px ${SERIF}`;
    c.fillText(num, x0, 0);
    c.font = `500 ${fs * 0.52}px ${SERIF}`;
    c.fillText('%', x0 + wNum + gap, fs * 0.14);
    c.restore();
  }
}

/* ================= 工具 ================= */

function alpha(rgb, a) {
  const m = /rgba?\(([^)]+)\)/.exec(rgb);
  if (!m) return rgb;
  const [r, g, b] = m[1].split(',').map((v) => parseFloat(v));
  return `rgba(${r},${g},${b},${a})`;
}

/** 从原图采样纸色：取星盘外一圈的环形中位数，抗噪 */
function samplePlate(img, crop) {
  const N = 320;
  const cv = document.createElement('canvas');
  cv.width = N;
  cv.height = Math.round((N * img.naturalHeight) / img.naturalWidth);
  const g = cv.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0, cv.width, cv.height);
  const data = g.getImageData(0, 0, cv.width, cv.height).data;

  const cx = crop.cx * cv.width;
  const cy = crop.cy * cv.height;
  const R = 0.4979 * cv.width;
  const rs = [];
  const gs = [];
  const bs = [];
  for (let y = 0; y < cv.height; y++) {
    for (let x = 0; x < cv.width; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d < R * 1.03 || d > R * 1.09) continue;
      const i = (y * cv.width + x) * 4;
      rs.push(data[i]);
      gs.push(data[i + 1]);
      bs.push(data[i + 2]);
    }
  }
  if (!rs.length) return '#edede4';
  const med = (arr) => {
    arr.sort((a, b) => a - b);
    return arr[arr.length >> 1];
  };
  return `rgb(${med(rs)},${med(gs)},${med(bs)})`;
}

/**
 * 把奶油纸上的金墨抠成透明底的线稿。
 * 纸和黑墨都是低彩度，只有金线有彩度，所以用彩度做 alpha 就干净了。
 */
function buildInk(img, crop, N) {
  const cv = document.createElement('canvas');
  cv.width = N;
  cv.height = N;
  const g = cv.getContext('2d', { willReadFrequently: true });

  const W = img.naturalWidth || img.width;
  const H = img.naturalHeight || img.height;
  const side = 2 * crop.r * W;
  g.imageSmoothingQuality = 'high';
  g.drawImage(
    img,
    crop.cx * W - side / 2,
    crop.cy * H - side / 2,
    side,
    side,
    0,
    0,
    N,
    N,
  );

  const data = g.getImageData(0, 0, N, N);
  const d = data.data;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i];
    const gg = d[i + 1];
    const b = d[i + 2];
    const mx = r > gg ? (r > b ? r : b) : gg > b ? gg : b;
    const mn = r < gg ? (r < b ? r : b) : gg < b ? gg : b;

    let t = (mx - mn) / 255;
    t = (t - 0.042) / 0.105;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    let a = t * t * (3 - 2 * t);
    a = Math.pow(a, 0.82); // 细线别被压没

    d[i] = Math.min(255, r * 1.16);
    d[i + 1] = Math.min(255, gg * 1.06);
    d[i + 2] = Math.min(255, b * 0.88);
    d[i + 3] = a * 255;
  }
  g.putImageData(data, 0, 0);
  return cv;
}
