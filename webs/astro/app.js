/**
 * 左下角星盘（本站接入层）
 *
 * 接替原来的 .dial 阅读进度盘：
 *   - 默认跟滚动进度走（等于原来的功能）
 *   - 用户一旦上手拨它，就由用户接管，指针不再被滚动覆盖
 *   - 点页面空白处 / 按 Home，回到"跟滚动"
 *   - 右上角小圆点可以打开摄像头，用手隔空拨
 */

import { Astrolabe } from './astrolabe.js';

const root = document.getElementById('astro');
if (root) {
  boot(root);
}

function boot(root) {
  const dial = new Astrolabe(root, {
    theme: 'dark',
    ink: true,
    labelMin: 152,
    percentSnap: 1,
    resetOnOutside: true,
    clickZooms: [1.8, 2.4],
  });

  /* ---------- 素材 ---------- */
  const img = new Image();
  img.decoding = 'async';
  img.onload = () => dial.setImage(img);
  img.src = new URL('./astrolabe.jpg', import.meta.url).href;

  /* ---------- 滚动进度 ---------- */
  const progress = () => {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    return max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
  };

  let queued = 0;
  const syncProgress = () => {
    queued = 0;
    if (!dial.manual) dial.setPercent(progress() * 100);
  };
  const onScroll = () => {
    if (!queued) queued = requestAnimationFrame(syncProgress);
  };

  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);

  // 复位之后立刻接回当前进度
  root.addEventListener('dial:auto', (e) => {
    if (!e.detail.manual) dial.setPercent(progress() * 100, { silent: true });
  });

  /* ---------- 反方向：拨罗盘 = 滚页面 ---------- */
  const maxScroll = () => Math.max(0, document.documentElement.scrollHeight - window.innerHeight);

  root.addEventListener('dial:scrub', (e) => {
    const max = maxScroll();
    if (max <= 0) return;
    const y = Math.round((e.detail.pct / 100) * max);
    if (Math.abs(window.scrollY - y) < 1) return;
    window.scrollTo(0, y);
  });

  // 松手后交回滚动驱动：页面这时正停在同一百分比上，所以不会跳
  let scrubTimer = 0;
  root.addEventListener('dial:scrubend', () => {
    clearTimeout(scrubTimer);
    scrubTimer = setTimeout(() => dial.setManual(false), 300);
  });

  syncProgress();

  /* ---------- 罗盘一直在，不再等滚过首屏 ---------- */
  const showDial = () => {
    root.classList.add('on');
    dial.kick(); // 自转循环靠这一下接上
  };
  showDial();
  window.addEventListener('scroll', showDial, { passive: true });

  /* 手势模式：页面虚掉，只留手和罗盘 */
  const setFocus = (on) => {
    document.documentElement.classList.toggle('astro-focus', on);
    showDial();
  };

  /* ---------- 手势（按需加载，不拖累首屏） ---------- */
  const btn = root.querySelector('.astro-btn');
  const video = root.querySelector('.astro-video');
  const note = root.querySelector('.astro-note');

  const overlay = document.createElement('canvas');
  overlay.className = 'astro-cursor';
  document.body.appendChild(overlay);

  const scrim = document.createElement('div');
  scrim.className = 'astro-scrim';
  document.body.appendChild(scrim);

  let hand = null;
  let starting = false;

  const setNote = (state, text) => {
    const live = state === 'loading' || state === 'ready';
    if (note) note.textContent = text || '';
    root.classList.toggle('cam', live);
    setFocus(live);
    if (btn) btn.setAttribute('aria-pressed', live ? 'true' : 'false');
  };

  if (btn) {
    btn.addEventListener('click', async () => {
      if (hand && hand.running) {
        hand.stop();
        return;
      }
      if (starting) return;
      starting = true;
      btn.disabled = true;
      try {
        if (!hand) {
          const mod = await import('./hand.js');
          hand = new mod.HandController({
            video,
            dial,
            overlay,
            onStatus: (state, text) => setNote(state, text),
          });
        }
        await hand.start();
      } catch (err) {
        setNote('error', '手势不可用');
        console.warn('[astro] hand', err);
        setTimeout(() => setNote('idle', ''), 2600);
      } finally {
        starting = false;
        btn.disabled = false;
      }
    });
  }
}
