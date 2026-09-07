/**
 * pi-agent-canvas — canvas drawing layer.
 * A quiet generative sketch: a faint dot grid with drifting particles
 * connected by hairlines. Palette stays within the surface tones.
 */
'use strict';

const c = document.getElementById('draw');
const ctx = c.getContext('2d');

let W = 0, H = 0, dpr = 1;

function resize() {
  dpr = window.devicePixelRatio || 1;
  W = window.innerWidth;
  H = window.innerHeight;
  c.width = W * dpr;
  c.height = H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resize);
resize();

// ---- dot grid (static, drawn each frame under the particles) ----
const GRID = 42;
function drawGrid() {
  ctx.fillStyle = 'rgba(255,255,255,0.035)';
  for (let x = GRID / 2; x < W; x += GRID) {
    for (let y = GRID / 2; y < H; y += GRID) {
      ctx.fillRect(x, y, 1, 1);
    }
  }
}

// ---- particles ----
const N = Math.min(70, Math.max(28, Math.floor((W * H) / 38000)));
const pts = [];
for (let i = 0; i < N; i++) {
  pts.push({
    x: Math.random() * W,
    y: Math.random() * H,
    vx: (Math.random() - 0.5) * 0.35,
    vy: (Math.random() - 0.5) * 0.35,
    r: 1 + Math.random() * 1.6,
  });
}

const LINK = 150; // px distance at which two particles connect

function step() {
  for (const p of pts) {
    p.x += p.vx;
    p.y += p.vy;
    if (p.x < -10) p.x = W + 10; else if (p.x > W + 10) p.x = -10;
    if (p.y < -10) p.y = H + 10; else if (p.y > H + 10) p.y = -10;
  }
}

function draw() {
  ctx.clearRect(0, 0, W, H);
  drawGrid();

  // links
  ctx.lineWidth = 1;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const dx = pts[i].x - pts[j].x;
      const dy = pts[i].y - pts[j].y;
      const d2 = dx * dx + dy * dy;
      if (d2 < LINK * LINK) {
        const a = 0.10 * (1 - Math.sqrt(d2) / LINK);
        ctx.strokeStyle = `rgba(120,140,190,${a.toFixed(3)})`;
        ctx.beginPath();
        ctx.moveTo(pts[i].x, pts[i].y);
        ctx.lineTo(pts[j].x, pts[j].y);
        ctx.stroke();
      }
    }
  }

  // particles
  for (const p of pts) {
    ctx.fillStyle = 'rgba(150,170,220,0.55)';
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function loop() {
  step();
  draw();
  requestAnimationFrame(loop);
}
loop();

// ---- host bridge (unchanged) ----
const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : undefined;
if (vscode) vscode.postMessage({ type: 'ready' });
