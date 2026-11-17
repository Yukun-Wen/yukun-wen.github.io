/**
 * 涟漪：从一点荡开一圈光，路过的"星星"被点亮。
 * 纯 canvas，独立 rAF，只在有波的时候跑。
 */

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Ripple {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.stars = [];
    this.waves = [];
    this.parts = [];
    this.flashes = [];
    this.rainLevel = 0;
    this._rainAcc = 0;
    this._last = 0;
    this.raf = 0;
    this.dpr = 1;
    this._resize();
    window.addEventListener('resize', () => this._resize());
  }

  _resize() {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';

    // 星星位置固定住，波走过时才亮，不闪成一锅粥
    const rnd = mulberry32(20261117);
    const n = Math.min(260, Math.round((w * h) / 12000));
    this.stars = [];
    for (let i = 0; i < n; i++) {
      this.stars.push({
        x: rnd() * w,
        y: rnd() * h,
        r: 0.5 + rnd() * 1.6,
        base: 0.06 + rnd() * 0.16,
      });
    }
  }

  /**
   * 雨：level 0..1 控制密度与速度。
   * 实际是"随机位置 + 随机大小的小涟漪"，看起来才像雨落在水面上。
   */
  setRain(level) {
    this.rainLevel = Math.max(0, Math.min(1, level || 0));
    if (this.rainLevel > 0) this._schedule();
  }

  /**
   * 星盘炸成金粉：
   *   一批炸出去（高速、带重力、横扫屏幕）
   *   一批在整屏铺开、慢慢往下飘（像金色的雪）
   *   外加一下闪光
   */
  shatter(x, y, radius, power = 1, cold = false) {
    const p = Math.min(1, Math.max(0, power));
    const w = window.innerWidth;
    const h = window.innerHeight;

    // 1) 炸开
    const nBurst = Math.round(220 + 520 * p);
    for (let i = 0; i < nBurst; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = radius * Math.sqrt(Math.random());
      const sp = (180 + Math.random() * 520) * (0.55 + p * 0.85);
      this.parts.push({
        kind: 'burst',
        x: x + Math.cos(a) * r,
        y: y + Math.sin(a) * r,
        vx: Math.cos(a) * sp + (Math.random() - 0.5) * 120,
        vy: Math.sin(a) * sp * 0.72 - 60 - Math.random() * 160,
        r: 0.8 + Math.random() * 2.4,
        life: 900 + Math.random() * 1500,
        t: 0,
        alpha: 0.75 + Math.random() * 0.25,
        cold,
      });
    }

    // 2) 满屏飘落
    const nDrift = Math.round(260 + 640 * p);
    for (let i = 0; i < nDrift; i++) {
      this.parts.push({
        kind: 'drift',
        x: Math.random() * w,
        y: Math.random() * h - h * 0.15,
        vx: (Math.random() - 0.5) * 40,
        vy: 28 + Math.random() * 95,
        ph: Math.random() * 6.28,
        r: 0.5 + Math.random() * 1.7,
        life: 2600 + Math.random() * 3000,
        t: 0,
        alpha: 0.45 + Math.random() * 0.5,
        cold,
      });
    }

    if (this.parts.length > 1800) this.parts.splice(0, this.parts.length - 1800);

    this.flashes.push({ x, y, t: 0, life: 300, r: radius * 2.4, cold });
    this._schedule();
  }
  /** 在某点起一圈波 */
  burst(x, y, opts = {}) {
    this.waves.push({
      x,
      y,
      t0: performance.now(),
      dur: opts.dur || 1700,
      max: opts.max || Math.hypot(window.innerWidth, window.innerHeight) * 0.95,
      power: opts.power === undefined ? 1 : opts.power,
    });
    this._schedule();
  }

  _schedule() {
    if (this.raf) return;
    this.raf = requestAnimationFrame((now) => {
      this.raf = 0;
      this._draw(now);
      if (this.waves.length || this.parts.length || this.flashes.length || this.rainLevel > 0) this._schedule();
    });
  }

  _draw(now) {
    const c = this.ctx;
    const w = window.innerWidth;
    const h = window.innerHeight;
    const dt = this._last ? Math.min(0.05, (now - this._last) / 1000) : 0;
    this._last = now;

    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.clearRect(0, 0, w, h);

    // 下雨：随机位置、随机大小、随机寿命的小涟漪
    if (this.rainLevel > 0) {
      this._rainAcc += dt;
      const rate = 2 + this.rainLevel * 12;
      const gap = 1 / rate;
      let guard = 0;
      while (this._rainAcc >= gap && guard++ < 6) {
        this._rainAcc -= gap;
        this.waves.push({
          x: Math.random() * w,
          y: Math.random() * h,
          t0: now,
          dur: 900 - this.rainLevel * 420 + Math.random() * 300,
          max: (40 + Math.random() * 120) * (0.5 + this.rainLevel),
          power: 0.35 + Math.random() * 0.5 * (0.4 + this.rainLevel),
        });
      }
      if (this.waves.length > 20) this.waves.splice(0, this.waves.length - 20);
    }

    this.waves = this.waves.filter((v) => now - v.t0 < v.dur);

    // 金粉：炸出去的一批受重力，飘落的一批左右摆
    if (this.parts.length) {
      const margin = 120;
      for (const p of this.parts) {
        p.t += dt * 1000;
        if (p.kind === 'drift') {
          p.x += Math.sin((p.t + p.ph) * 0.0022) * 30 * dt + p.vx * dt;
          p.y += p.vy * dt;
        } else {
          p.vy += 300 * dt;
          p.vx *= 1 - 1.1 * dt;
          p.vy *= 1 - 0.18 * dt;
          p.x += p.vx * dt;
          p.y += p.vy * dt;
        }
        if (p.y > window.innerHeight + margin) p.t = p.life;
      }
      this.parts = this.parts.filter((p) => p.t < p.life);
    }
    if (this.flashes.length) {
      for (const f of this.flashes) f.t += dt * 1000;
      this.flashes = this.flashes.filter((f) => f.t < f.life);
    }

    if (!this.waves.length && !this.parts.length && !this.flashes.length) return;

    const active = this.waves.map((v) => {
      const k = (now - v.t0) / v.dur;
      const e = 1 - Math.pow(1 - k, 2.2);
      return { ...v, k, radius: e * v.max };
    });

    // 1. 星星：离波前越近越亮
    for (const s of this.stars) {
      let lit = 0;
      for (const v of active) {
        const d = Math.hypot(s.x - v.x, s.y - v.y);
        const band = (d - v.radius) / 70;
        lit += Math.exp(-band * band) * (1 - v.k) * v.power;
        if (d < v.radius) lit += 0.22 * (1 - v.k) * v.power * (1 - d / v.max);
      }
      const a = s.base + Math.min(1.4, lit) * 0.85;
      if (a < 0.02) continue;
      c.beginPath();
      c.arc(s.x, s.y, s.r * (1 + Math.min(1.2, lit) * 0.7), 0, Math.PI * 2);
      c.fillStyle = 'rgba(255,236,186,' + Math.min(1, a).toFixed(3) + ')';
      c.fill();
    }

    // 2. 波本身：一圈很淡的光
    for (const v of active) {
      const a = (1 - v.k) * 0.16 * v.power;
      if (a < 0.01) continue;
      c.beginPath();
      c.arc(v.x, v.y, v.radius, 0, Math.PI * 2);
      c.strokeStyle = 'rgba(255,238,196,' + a.toFixed(3) + ')';
      c.lineWidth = 1.2 + 8 * (1 - v.k);
      c.stroke();
    }

    // 3. 炸开那一下的闪光
    for (const f of this.flashes) {
      const k = f.t / f.life;
      const a = (1 - k) * (1 - k) * 0.55;
      if (a < 0.01) continue;
      const g = c.createRadialGradient(f.x, f.y, 0, f.x, f.y, f.r * (0.6 + k * 1.6));
      g.addColorStop(0, f.cold ? 'rgba(226,244,255,' + a.toFixed(3) + ')' : 'rgba(255,232,170,' + a.toFixed(3) + ')');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = g;
      c.beginPath();
      c.arc(f.x, f.y, f.r * (0.6 + k * 1.6), 0, Math.PI * 2);
      c.fill();
    }

    // 4. 金粉
    for (const p of this.parts) {
      const k = p.t / p.life;
      const fadeIn = Math.min(1, p.t / 120);
      const a = fadeIn * Math.pow(1 - k, 1.6) * p.alpha;
      if (a < 0.02) continue;
      const rr = p.r * (1 - k * 0.35);
      c.fillStyle = p.cold
        ? 'rgba(226,240,255,' + a.toFixed(3) + ')'
        : 'rgba(255,216,140,' + a.toFixed(3) + ')';
      if (rr < 1.1) {
        c.fillRect(p.x - rr, p.y - rr, rr * 2, rr * 2);
      } else {
        c.beginPath();
        c.arc(p.x, p.y, rr, 0, Math.PI * 2);
        c.fill();
      }
    }
  }
}