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
const wrapPi = (a) => (((a + Math.PI) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2) - Math.PI;

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
  constructor({ video, dial, overlay, onStatus, onOpen, onTurn, onFlip }) {
    this.video = video;
    this.dial = dial;
    this.overlay = overlay;
    this.octx = overlay.getContext('2d');
    this.onStatus = onStatus || (() => {});
    /** 手张开程度 0..1（0 = 握拳，1 = 五指全开） */
    this.onOpen = onOpen || (() => {});
    /** 手掌转动（弧度/帧），放大状态下用来拖进度条 + 加速自转 */
    this.onTurn = onTurn || (() => {});
    /** 翻掌：0 = 阳面，1 = 阴面 */
    this.onFlip = onFlip || (() => {});
    this._faceRef = undefined;
    this._faceShown = 0;
    this._facePending = -1;
    this._faceCount = 0;
    this._openSmooth = 0;
    this._openSent = -1;

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
      this.onStatus('ready', '捏住不动 → 蓄能');
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
    this._openSmooth = 0;
    this._openSent = -1;
    this._rMin = undefined;
    this._rMax = undefined;
    this.onOpen(0);
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
        if (this.slots.size === 0) this.onStatus('ready', '捏住不动 → 蓄能');
      }
    }

    this._publishOpen();
    this._publishTurn();
  }

  /**
   * 把所有手的最大张开值发出去：0 = 握拳，1 = 全开。
   * 手掌大小、镜头距离、机型差得很远，绝对阈值一定不准，
   * 所以用"见过的最低/最高"做自适应标定，一次开合就能标满。
   */
  _publishOpen() {
    let raw = 0;
    for (const slot of this.slots.values()) {
      if (slot.pos && typeof slot.ratio === 'number') raw = Math.max(raw, slot.ratio);
    }

    if (raw > 0) {
      if (this._rMin === undefined) {
        // 第一眼如果手已经是张开的（比值偏高），按"张开"起；否则按"握着"起。
        // 两种情况都保证：一次开合就能把量程标满。
        if (raw >= 1.5) {
          this._rMin = raw - 0.55;
          this._rMax = raw;
        } else {
          this._rMin = raw;
          this._rMax = raw + 0.35;
        }
      }
      // 上限立即跟上，下限只在新低时立刻下移；另一端缓慢回缩
      this._rMax = raw > this._rMax ? raw : this._rMax + (raw - this._rMax) * 0.0015;
      this._rMin = raw < this._rMin ? raw : this._rMin + (raw - this._rMin) * 0.0015;
      if (this._rMax - this._rMin < 0.22) this._rMax = this._rMin + 0.22;
    }

    let open = 0;
    if (raw > 0 && this._rMin !== undefined) {
      open = clamp((raw - this._rMin) / Math.max(0.22, this._rMax - this._rMin), 0, 1);
    }

    // 张开时跟得紧一点，收拢时慢一点，避免抖动
    const k = open > this._openSmooth ? 0.35 : 0.18;
    this._openSmooth += (open - this._openSmooth) * k;
    if (Math.abs(this._openSmooth - this._openSent) > 0.006) {
      this._openSent = this._openSmooth;
      this.onOpen(this._openSmooth, raw);
    }
  }

  /** 把这一帧手掌转动的角度发出去（取绝对量最大的那只手） */
  _publishTurn() {
    let turn = 0;
    for (const slot of this.slots.values()) {
      if (!slot.pos || !slot.turn) continue;
      if (Math.abs(slot.turn) > Math.abs(turn)) turn = slot.turn;
    }
    if (turn !== 0) this.onTurn(turn);
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

    // 张开度原始值：五个指尖到手腕的平均距离 / 掌长（与离镜头远近无关）
    // 只存比值，归一化交给 _publishOpen 自适应标定
    let reach = 0;
    for (const i of [4, 8, 12, 16, 20]) {
      reach += Math.hypot(lm[i].x - wrist.x, lm[i].y - wrist.y);
    }
    slot.ratio = reach / 5 / palm;

    // 手掌朝向：腕→中指根这条线的角度。x 取反，让"顺时针"和镜子里看到的一致
    const roll = -Math.atan2(mcp.y - wrist.y, mcp.x - wrist.x);
    if (typeof slot.roll === 'number') {
      const d = wrapPi(roll - slot.roll);
      slot.turn = Math.abs(d) < 0.5 ? d : 0; // 跳变（手重新摆位）不算
    } else {
      slot.turn = 0;
    }
    slot.roll = roll;

    // 掌面朝向：翻掌时这个二维叉积会变号，正反两面据此区分。
    // 第一次见到的手当作阳面，之后翻转才算阴面 —— 不受左右手影响。
    const ax = lm[5].x - wrist.x;
    const ay = lm[5].y - wrist.y;
    const bx = lm[17].x - wrist.x;
    const by = lm[17].y - wrist.y;
    const cross = ax * by - ay * bx;
    if (Math.abs(cross) > 0.002) {
      const sign = cross >= 0 ? 1 : -1;
      if (this._faceRef === undefined) this._faceRef = sign;
      const want = sign === this._faceRef ? 0 : 1;
      if (want !== this._facePending) {
        this._facePending = want;
        this._faceCount = 1;
      } else if (++this._faceCount === 6 && want !== this._faceShown) {
        this._faceShown = want;
        this.onFlip(want);
      }
    }

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
