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
  dial.addEventListener('dial:auto', (e) => {
    if (!e.detail.manual) dial.setPercent(progress() * 100, { silent: true });
  });

  syncProgress();

  /* ---------- 首屏先藏着（原来的脾气） ---------- */
  const masthead = document.querySelector('.masthead');
  const updateVisible = () => {
    const show = !masthead || masthead.getBoundingClientRect().bottom < 60;
    root.classList.toggle('on', show);
  };
  window.addEventListener('scroll', updateVisible, { passive: true });
  updateVisible();

  /* ---------- 手势（按需加载，不拖累首屏） ---------- */
  const btn = root.querySelector('.astro-btn');
  const video = root.querySelector('.astro-video');
  const note = root.querySelector('.astro-note');

  const overlay = document.createElement('canvas');
  overlay.className = 'astro-cursor';
  document.body.appendChild(overlay);

  let hand = null;
  let starting = false;

  const setNote = (state, text) => {
    if (note) note.textContent = text || '';
    root.classList.toggle('cam', state === 'loading' || state === 'ready');
    if (btn) btn.setAttribute('aria-pressed', state === 'loading' || state === 'ready' ? 'true' : 'false');
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
