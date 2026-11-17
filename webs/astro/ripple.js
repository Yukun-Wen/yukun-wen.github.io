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
      if (this.waves.length) this._schedule();
    });
  }

  _draw(now) {
    const c = this.ctx;
    const w = window.innerWidth;
    const h = window.innerHeight;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.clearRect(0, 0, w, h);

    // 淘汰跑完的波
    this.waves = this.waves.filter((v) => now - v.t0 < v.dur);
    if (!this.waves.length) return;

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
        // 已经扫过的区域留一点余辉
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
  }
}
