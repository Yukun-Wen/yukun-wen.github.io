/**
 * 摄像头手势层
 *
 * 它不做任何「交互逻辑」：只负责把手变成一个虚拟指针，
 * 通过 pointerDown / pointerMove / pointerUp 注入星盘组件。
 * 所以关掉摄像头，组件的行为一模一样。
 */

import { HandLandmarker, FilesetResolver } from './vendor/mediapipe/vision_bundle.mjs';

const WASM_DIR = new URL('./vendor/mediapipe/wasm', import.meta.url).href;
const MODEL_URL = new URL('./vendor/models/hand_landmarker.task', import.meta.url).href;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/* ---------------- One Euro 滤波 ---------------- */

class LowPass {
  constructor() { this.y = null; }
  filter(x, a) {
    this.y = this.y === null ? x : this.y + a * (x - this.y);
    return this.y;
  }
}

class OneEuro {
  constructor({ minCutoff = 1.1, beta = 0.03, dCutoff = 1 } = {}) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.x = new LowPass();
    this.dx = new LowPass();
    this.tPrev = null;
  }
  static alpha(cutoff, dt) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }
  filter(value, t) {
    if (this.tPrev === null) {
      this.tPrev = t;
      this.x.y = value;
      this.dx.y = 0;
      return value;
    }
    const dt = clamp(t - this.tPrev, 1 / 240, 0.2);
    this.tPrev = t;
    const dx = (value - this.x.y) / dt;
    const edx = this.dx.filter(dx, OneEuro.alpha(this.dCutoff, dt));
    const cutoff = this.minCutoff + this.beta * Math.abs(edx);
    return this.x.filter(value, OneEuro.alpha(cutoff, dt));
  }
}

/* ---------------- 主类 ---------------- */

export class HandController {
  constructor({ video, dial, overlay, onStatus }) {
    this.video = video;
    this.dial = dial;
    this.overlay = overlay;
    this.octx = overlay.getContext('2d');
    this.onStatus = onStatus || (() => {});

    this.gain = 1.35;
    this.slots = new Map();
    this.running = false;
    this.landmarker = null;
    this.stream = null;
    this._rvfc = 0;
    this._raf = 0;
    this._dpr = 1;

    this._resizeOverlay();
    window.addEventListener('resize', () => this._resizeOverlay());
  }

  setGain(g) { this.gain = g; }

  async start() {
    if (this.running) return;
    try {
      if (!this.landmarker) {
        this.onStatus('loading', '加载手势模型…');
        const fileset = await FilesetResolver.forVisionTasks(WASM_DIR);
        const opts = {
          baseOptions: { modelAssetPath: MODEL_URL },
          runningMode: 'VIDEO',
          numHands: 2,
          minHandDetectionConfidence: 0.5,
          minHandPresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
        };
        try {
          this.landmarker = await HandLandmarker.createFromOptions(fileset, {
            ...opts,
            baseOptions: { ...opts.baseOptions, delegate: 'GPU' },
          });
        } catch {
          this.landmarker = await HandLandmarker.createFromOptions(fileset, opts);
        }
      }

      this.onStatus('loading', '请求摄像头…');
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'user',
          width: { ideal: 640 },
          height: { ideal: 480 },
          frameRate: { ideal: 30 },
        },
        audio: false,
      });
      this.video.srcObject = this.stream;
      await this.video.play();

      this.running = true;
      this.onStatus('ready', '把手放进画面');
      this._loop();
    } catch (err) {
      this.onStatus('error', this._explain(err));
      this.stop();
      throw err;
    }
  }

  stop() {
    this.running = false;
    if (this._rvfc && this.video.cancelVideoFrameCallback) {
      this.video.cancelVideoFrameCallback(this._rvfc);
    }
    this._rvfc = 0;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;

    for (const [key, slot] of this.slots) {
      if (slot.down) this.dial.pointerUp(key);
      slot.down = false;
    }
    this.slots.clear();

    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
      this.stream = null;
    }
    this.video.srcObject = null;
    this._clearOverlay();
    this.onStatus('idle', '摄像头未开启');
  }

  /* ---------------- 每帧 ---------------- */

  _loop() {
    const step = () => {
      if (!this.running) return;
      const now = performance.now();
      try {
        this._tick(now);
      } catch (err) {
        console.warn('[hand] tick failed', err);
      }
      this._drawCursor();
      if (this.video.requestVideoFrameCallback) {
        this._rvfc = this.video.requestVideoFrameCallback(step);
      } else {
        this._raf = requestAnimationFrame(step);
      }
    };
    step();
  }

  _tick(now) {
    if (!this.landmarker || this.video.readyState < 2) return;

    const res = this.landmarker.detectForVideo(this.video, now);
    const hands = res.landmarks || [];
    const handed = res.handednesses || [];

    const seen = new Set();
    for (let i = 0; i < hands.length && i < 2; i++) {
      const lm = hands[i];
      const key = this._keyFor(handed, i, seen);
      seen.add(key);

      let slot = this.slots.get(key);
      if (!slot) {
        slot = {
          fx: new OneEuro({ minCutoff: 1.2, beta: 0.035 }),
          fy: new OneEuro({ minCutoff: 1.2, beta: 0.035 }),
          down: false,
          pos: null,
          miss: 0,
        };
        this.slots.set(key, slot);
      }
      slot.miss = 0;
      this._updateSlot(key, slot, lm, now);
    }

    for (const [key, slot] of this.slots) {
      if (seen.has(key)) continue;
      slot.miss++;
      if (slot.down) {
        // 手突然丢了：先当成松手，避免指针卡在按下状态
        this.dial.pointerUp(key);
        slot.down = false;
      }
      if (slot.miss > 12) {
        this.slots.delete(key);
        if (this.slots.size === 0) this.onStatus('ready', '把手放进画面');
      }
    }
  }

  _keyFor(handed, i, seen) {
    const label = handed?.[i]?.[0]?.categoryName || handed?.[i]?.[0]?.displayName;
    const base = label ? `hand-${label}` : `hand-${i}`;
    return seen.has(base) ? `${base}-${i}` : base;
  }

  _updateSlot(key, slot, lm, now) {
    const wrist = lm[0];
    const mcp = lm[9];
    const palm = Math.hypot(mcp.x - wrist.x, mcp.y - wrist.y);
    if (palm < 0.035) return; // 手太小/太远，忽略

    const tip = lm[8];
    const thumb = lm[4];
    const spread = Math.hypot(tip.x - thumb.x, tip.y - thumb.y) / Math.max(palm, 1e-4);

    const [sx, sy] = this._toScreen(tip.x, tip.y);
    const x = slot.fx.filter(sx, now);
    const y = slot.fy.filter(sy, now);

    // 双阈值：按下难、松开易，避免边界抖动
    const pinching = slot.down ? spread < 0.62 : spread < 0.40;

    if (pinching && !slot.down) {
      slot.down = this.dial.pointerDown(key, x, y, 'hand');
    } else if (pinching && slot.down) {
      this.dial.pointerMove(key, x, y);
    } else if (!pinching && slot.down) {
      slot.down = false;
      this.dial.pointerUp(key);
    }

    slot.pos = { x, y, pinching, lm };
  }

  _toScreen(nx, ny) {
    const g = this.gain;
    const mx = 1 - nx; // 镜像：像照镜子一样左右一致
    return [
      clamp(0.5 + (mx - 0.5) * g, 0, 1) * window.innerWidth,
      clamp(0.5 + (ny - 0.5) * g, 0, 1) * window.innerHeight,
    ];
  }

  /* ---------------- 光标层 ---------------- */

  _resizeOverlay() {
    this._dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.overlay.width = Math.round(w * this._dpr);
    this.overlay.height = Math.round(h * this._dpr);
    this.overlay.style.width = w + 'px';
    this.overlay.style.height = h + 'px';
  }

  _clearOverlay() {
    const c = this.octx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, this.overlay.width, this.overlay.height);
  }

  _drawCursor() {
    const c = this.octx;
    const w = window.innerWidth;
    const h = window.innerHeight;
    c.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
    c.clearRect(0, 0, w, h);

    for (const slot of this.slots.values()) {
      const p = slot.pos;
      if (!p) continue;
      const r = p.pinching ? 8.5 : 14;

      c.beginPath();
      c.arc(p.x, p.y, r, 0, Math.PI * 2);
      c.strokeStyle = p.pinching ? 'rgba(184,145,47,0.95)' : 'rgba(184,145,47,0.5)';
      c.lineWidth = p.pinching ? 2 : 1.2;
      c.stroke();

      c.beginPath();
      c.arc(p.x, p.y, 2.4, 0, Math.PI * 2);
      c.fillStyle = 'rgba(184,145,47,0.9)';
      c.fill();

      if (p.pinching) {
        c.beginPath();
        c.moveTo(p.x - 15, p.y);
        c.lineTo(p.x - 10, p.y);
        c.moveTo(p.x + 10, p.y);
        c.lineTo(p.x + 15, p.y);
        c.moveTo(p.x, p.y - 15);
        c.lineTo(p.x, p.y - 10);
        c.moveTo(p.x, p.y + 10);
        c.lineTo(p.x, p.y + 15);
        c.strokeStyle = 'rgba(184,145,47,0.55)';
        c.lineWidth = 1;
        c.stroke();
      }
    }
  }

  _explain(err) {
    const n = err?.name || '';
    if (n === 'NotAllowedError') return '摄像头被拒绝，请在地址栏放行';
    if (n === 'NotFoundError') return '没找到摄像头';
    if (n === 'NotReadableError') return '摄像头被其它程序占用';
    if (n === 'SecurityError') return '需要 https 或 localhost';
    return '启动失败：' + (err?.message || n || '未知错误');
  }
}
