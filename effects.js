/* Ambient light particles + mouse-following light rays for the Codex web UI.
   Self-contained: creates its own fixed canvas, follows the app theme via CSS
   variables, respects prefers-reduced-motion, and pauses when the tab is hidden. */
(() => {
  'use strict';

  let running = false;
  let canvas = null;
  let ctx = null;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const DPR_CAP = 2;
  const TRAIL_MS = 520;
  const MAX_TRAIL_POINTS = 44;
  const MOUSE_IDLE_MS = 2600;

  let width = 0;
  let height = 0;
  let dpr = 1;
  let particles = [];
  let sprites = new Map();
  let palette = readPalette();
  let raf = 0;
  let resizeRaf = 0;
  let last = performance.now();

  const pointer = { x: -9999, y: -9999, lastMove: -Infinity, history: [] };

  function parseColor(value) {
    const text = String(value || '').trim();
    const rgb = text.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)$/i);
    if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
    const hex = text.match(/^#([0-9a-f]{6})$/i);
    if (hex) {
      const n = parseInt(hex[1], 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
    return null;
  }

  function readPalette() {
    const styles = getComputedStyle(document.documentElement);
    return {
      primary: parseColor(styles.getPropertyValue('--primary')) || [91, 140, 255],
      info: parseColor(styles.getPropertyValue('--info')) || [80, 184, 216],
      thinking: parseColor(styles.getPropertyValue('--thinking')) || [167, 139, 250],
      isLight: document.body.dataset.theme === 'light',
    };
  }

  function colorKey(rgb) {
    return rgb.join(',');
  }

  function makeSprite(rgb) {
    const size = 64;
    const sprite = document.createElement('canvas');
    sprite.width = size;
    sprite.height = size;
    const sctx = sprite.getContext('2d');
    const gradient = sctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},1)`);
    gradient.addColorStop(0.35, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.5)`);
    gradient.addColorStop(1, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0)`);
    sctx.fillStyle = gradient;
    sctx.fillRect(0, 0, size, size);
    return sprite;
  }

  function rebuildSprites() {
    palette = readPalette();
    sprites = new Map();
    for (const color of [palette.primary, palette.info, palette.thinking]) {
      sprites.set(colorKey(color), makeSprite(color));
    }
  }

  function random(lo, hi) {
    return lo + Math.random() * (hi - lo);
  }

  function spawnParticles() {
    const target = Math.max(28, Math.min(110, Math.round((width * height) / 18000)));
    const colors = [palette.primary, palette.info, palette.thinking];
    particles = Array.from({ length: target }, (_, i) => {
      const color = colors[i % colors.length];
      return {
        x: Math.random() * width,
        y: Math.random() * height,
        size: palette.isLight ? random(9, 26) : random(13, 36),
        speed: random(4, 18),
        angle: random(0, Math.PI * 2),
        phase: random(0, Math.PI * 2),
        twinkle: random(0.8, 2.1),
        colorKey: colorKey(color),
        alpha: palette.isLight ? random(0.35, 0.7) : random(0.55, 1),
      };
    });
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    spawnParticles();
  }

  function pruneTrail(now) {
    const history = pointer.history;
    while (history.length > 1 && now - history[0].t > TRAIL_MS) history.shift();
  }

  function onPointerMove(event) {
    if (!running) return;
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    pointer.lastMove = performance.now();
    const history = pointer.history;
    if (history.length === 0 || pointer.lastMove - history[history.length - 1].t > 12) {
      history.push({ x: pointer.x, y: pointer.y, t: pointer.lastMove });
      if (history.length > MAX_TRAIL_POINTS) history.shift();
    }
    pruneTrail(pointer.lastMove);
  }

  function drawTrail(now) {
    const history = pointer.history;
    if (history.length < 2) return;
    const [r, g, b] = palette.primary;
    ctx.save();
    ctx.globalCompositeOperation = palette.isLight ? 'source-over' : 'lighter';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (let i = 1; i < history.length; i += 1) {
      const prev = history[i - 1];
      const cur = history[i];
      const life = Math.max(0, 1 - (now - cur.t) / TRAIL_MS);
      if (life <= 0) continue;
      ctx.beginPath();
      ctx.moveTo(prev.x, prev.y);
      ctx.lineTo(cur.x, cur.y);
      ctx.strokeStyle = `rgba(${r},${g},${b},${(0.52 * life * life).toFixed(3)})`;
      ctx.lineWidth = 1.5 + 4.4 * life;
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawCursorGlow(now) {
    const idle = now - pointer.lastMove;
    if (idle > MOUSE_IDLE_MS) return;
    const sprite = sprites.get(colorKey(palette.primary));
    if (!sprite) return;
    const fade = Math.max(0, 1 - (idle - MOUSE_IDLE_MS * 0.55) / (MOUSE_IDLE_MS * 0.45));
    const size = 110 + 14 * Math.sin(now / 800);
    ctx.save();
    ctx.globalCompositeOperation = palette.isLight ? 'source-over' : 'lighter';
    ctx.globalAlpha = (palette.isLight ? 0.3 : 0.6) * fade;
    ctx.drawImage(sprite, pointer.x - size / 2, pointer.y - size / 2, size, size);
    ctx.restore();
  }

  function drawParticles(now, dt) {
    const t = now / 1000;
    ctx.save();
    ctx.globalCompositeOperation = palette.isLight ? 'source-over' : 'lighter';
    for (const p of particles) {
      if (dt > 0) {
        p.x += Math.cos(p.angle) * p.speed * dt;
        p.y += Math.sin(p.angle) * p.speed * dt + Math.sin(t * 0.4 + p.phase) * 0.14 * dt * 60;
        const dx = pointer.x - p.x;
        const dy = pointer.y - p.y;
        const dist2 = dx * dx + dy * dy;
        if (now - pointer.lastMove < MOUSE_IDLE_MS && dist2 > 1 && dist2 < 160 * 160) {
          const dist = Math.sqrt(dist2);
          const pull = 0.05 * (160 - dist) * dt;
          p.x += (dx / dist) * pull;
          p.y += (dy / dist) * pull;
        }
        if (p.x < -30) p.x = width + 30;
        else if (p.x > width + 30) p.x = -30;
        if (p.y < -30) p.y = height + 30;
        else if (p.y > height + 30) p.y = -30;
      }
      const sprite = sprites.get(p.colorKey);
      if (!sprite) continue;
      const twinkle = 0.55 + 0.45 * Math.sin(t * p.twinkle + p.phase);
      ctx.globalAlpha = p.alpha * twinkle;
      ctx.drawImage(sprite, p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    }
    ctx.restore();
  }

  function render(now, dt) {
    if (pointer.history.length) pruneTrail(now);
    ctx.clearRect(0, 0, width, height);
    drawTrail(now);
    drawCursorGlow(now);
    drawParticles(now, dt);
  }

  function frame(now) {
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
    last = now;
    render(now, dt);
    raf = requestAnimationFrame(frame);
  }

  window.addEventListener('resize', () => {
    if (!running) return;
    cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(resize);
  });

  window.addEventListener('pointermove', onPointerMove, { passive: true });

  document.addEventListener('visibilitychange', () => {
    if (!running) return;
    if (document.hidden) {
      cancelAnimationFrame(raf);
    } else if (!reducedMotion) {
      last = performance.now();
      raf = requestAnimationFrame(frame);
    }
  });

  const bodyObserver = new MutationObserver(() => {
    const fxOn = document.body.dataset.fx === 'on';
    if (fxOn && !running) startFx();
    else if (!fxOn && running) stopFx();
    if (!running) return;
    const next = readPalette();
    const colorsChanged =
      colorKey(next.primary) !== colorKey(palette.primary) ||
      colorKey(next.info) !== colorKey(palette.info) ||
      colorKey(next.thinking) !== colorKey(palette.thinking) ||
      next.isLight !== palette.isLight;
    palette = next;
    if (colorsChanged) {
      rebuildSprites();
      spawnParticles();
    }
  });
  bodyObserver.observe(document.body, {
    attributes: true,
    attributeFilter: ['data-theme', 'data-chat-bg', 'data-skin-concept', 'data-fx'],
  });

  function startFx() {
    if (running) return;
    running = true;
    canvas = document.createElement('canvas');
    canvas.id = 'fxCanvas';
    canvas.setAttribute('aria-hidden', 'true');
    document.body.insertBefore(canvas, document.body.firstChild);
    ctx = canvas.getContext('2d');
    rebuildSprites();
    resize();
    last = performance.now();
    if (reducedMotion) {
      render(performance.now(), 0);
    } else {
      raf = requestAnimationFrame(frame);
    }
  }

  function stopFx() {
    if (!running) return;
    running = false;
    cancelAnimationFrame(raf);
    raf = 0;
    pointer.history.length = 0;
    pointer.lastMove = -Infinity;
    if (canvas) {
      canvas.remove();
      canvas = null;
    }
    ctx = null;
  }

  if (document.body.dataset.fx === 'on') startFx();
})();
