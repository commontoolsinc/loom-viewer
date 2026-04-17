// loom-viewer client — canvas renderer + SSE state + interactions.
// Tapestry is the hero: glowing with everything taken care of. Machinery is
// supporting cast. Every moving pixel is backed by real work — per-thread
// breathing, thickness, and weave all derive from wish substance.
// Threads have affinity to each other (shared agent/tag/keyword/target); a
// glimmer on one calls answering glimmers from its neighbors.

import { buildAffinity } from "/affinity.js";
import { buildDemoState } from "/demo-data.js";

const TARGET_COLORS = {
  capture: [40, 45, 64], // warm yellow [hue, sat, lightness]
  system: [210, 38, 60], // cool blue
  review: [140, 34, 55], // green
  "pattern-dev": [280, 38, 62], // violet
  "gtd-ops": [180, 38, 55], // teal
  other: [30, 10, 54], // warm grey
};

const MACHINERY_RATIO = 0.14; // top strip
const HEADER_PAD = 52; // room for HUD text
const FOOTER_PAD = 52; // room for micro-summary
const THREAD_PITCH = 7; // vertical space per tapestry thread (px)
const FELL_HEIGHT = 10; // heated band where the cloth is being woven
const ARRIVAL_DURATION = 1600;
const SPARKLE_COUNT = 5;

// Per-thread breathing — two-frequency shimmer so every thread feels
// restless even when static. Slow base (wish-seeded period) + fast
// sparkle layer. Amplitude scales with wish energy; hash-seeded clock
// means every thread has its own rhythm. Never synchronized.
const BREATH_PERIOD_MIN = 8000; // ms, slow base
const BREATH_PERIOD_MAX = 22000;
const BREATH_AMP_BASE = 0.034;
const BREATH_AMP_ENERGY = 0.09;
const SHIMMER_FAST_PERIOD_MIN = 1400; // slower fast layer — less restless
const SHIMMER_FAST_PERIOD_MAX = 2800;
const SHIMMER_FAST_AMP_RATIO = 0.8;

// Glimmers: small localized flashes on a thread. Every 1.5-3s one fires
// on an energy-weighted random thread and cascades into echo-glimmers on
// its affinity neighbors — like related work "answering" each other.
// Perpetuum Mobile tuning: constant steady-state motion, never eventful.
// Density stays roughly flat, individual events are small and quick,
// cascades blend into the texture rather than standing out as events.
const GLIMMER_SPAWN_INTERVAL_MIN = 110;
const GLIMMER_SPAWN_INTERVAL_MAX = 290;
const GLIMMER_DURATION = 980; // a touch longer so each event is gentler
const GLIMMER_MAX_POOL = 220;
const GLIMMER_RADIUS_MIN = 5;
const GLIMMER_RADIUS_MAX = 12;
const ECHO_DELAY_MIN = 320;
const ECHO_DELAY_MAX = 950;
const ECHO_COUNT_MIN = 1;
const ECHO_COUNT_MAX = 4;
const ECHO_DECAY = 0.7; // brightness multiplier per hop
const SECOND_ORDER_P = 0.42;
const THIRD_ORDER_P = 0.18;

// Memory pulses: disabled for Perpetuum Mobile. Big traveling sweeps
// broke the steady-state calm. Glimmer cascades now carry the entire
// "the loom is alive and remembering" load. Constants retained in case
// we ever want a very-sparse ceremonial pulse back.
const PULSE_INTERVAL_MIN = 999_999_999;
const PULSE_INTERVAL_MAX = 999_999_999;
const PULSE_DURATION = 2400;
const PULSE_MAX_CONCURRENT = 0;

// Token motes: rare upward particles rising off heavy threads.
const MOTE_POOL_MAX = 36;
const MOTE_LIFE_MIN = 3000;
const MOTE_LIFE_MAX = 5200;

// ---- State ----
let state = null;
let prevState = null;
let connected = false;

// Sorted lists derived once per snapshot
let sortedDone = [];
let activeRoles = [];
let roleIndex = new Map();
let substanceCache = new Map(); // wishId -> { thickness, energy, crossings, weaveSeeds, period }
let affinity = new Map(); // wishId -> [neighborId, ...]

// ---- Animation state ----
const arrivals = []; // { wishId, t0, color }
const memoryPulses = []; // { wishId, t0 }
const tokenMotes = []; // { x, y, vy, life, born, hue, sat }
// Glimmers: small localized flashes on specific threads, spawned as a
// cascade from a seed + echoes on affinity neighbors.
const glimmers = []; // { wishId, x01, t0, radius, intensity, hop }
const pendingEchoes = []; // { wishId, x01, fireAt, intensity, hop }
let nextPulseAt = performance.now() + randRange(PULSE_INTERVAL_MIN, PULSE_INTERVAL_MAX);
let nextGlimmerAt = performance.now() +
  randRange(GLIMMER_SPAWN_INTERVAL_MIN, GLIMMER_SPAWN_INTERVAL_MAX);

// ---- Canvas ----
const canvas = document.getElementById("loom");
const ctx = canvas.getContext("2d");
let W = 0, H = 0, DPR = 1;

function resize() {
  DPR = Math.max(1, window.devicePixelRatio || 1);
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = Math.floor(W * DPR);
  canvas.height = Math.floor(H * DPR);
  canvas.style.width = W + "px";
  canvas.style.height = H + "px";
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
}
window.addEventListener("resize", resize);
resize();

// ---- SSE / demo mode ----
// Demo mode: ?demo in URL forces it; otherwise fall back to demo if SSE
// hasn't delivered a snapshot within 1.5s (no daemon, file:// open, etc).
let demoMode = false;
let demoTimer = null;

function isDemoForced() {
  try {
    const params = new URLSearchParams(globalThis.location?.search ?? "");
    return params.has("demo");
  } catch {
    return false;
  }
}

function startDemo() {
  if (demoMode) return;
  demoMode = true;
  applySnapshot(buildDemoState());
  // Periodically nudge state so the "1 today" counters and recency feel current
  setInterval(() => applySnapshot(buildDemoState()), 60_000);
}

function connectSSE() {
  if (isDemoForced()) {
    startDemo();
    return;
  }

  // Fall back to demo if SSE doesn't deliver within 1.5s
  demoTimer = setTimeout(() => {
    if (!state) startDemo();
  }, 1500);

  let es;
  try {
    es = new EventSource("/events");
  } catch {
    startDemo();
    return;
  }
  es.addEventListener("open", () => {
    connected = true;
  });
  es.addEventListener("error", () => {
    connected = false;
    if (!state) startDemo();
  });
  es.addEventListener("message", (e) => {
    if (demoMode) return; // ignore real data once demo is active
    if (demoTimer) {
      clearTimeout(demoTimer);
      demoTimer = null;
    }
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === "snapshot") applySnapshot(msg.state);
    } catch (err) {
      console.error("bad SSE payload", err);
    }
  });
}

function applySnapshot(next) {
  prevState = state;
  state = next;
  deriveSorted();
  detectArrivals();
  updateHUD();
  updateMicroSummary();
}

function deriveSorted() {
  sortedDone = state.wishes
    .filter((w) => w.status === "done" || w.status === "dismissed")
    .sort((a, b) => (b.statusSince ?? "").localeCompare(a.statusSince ?? ""));

  const roleSet = new Set();
  (state.active ?? []).forEach((a) => roleSet.add(a.role));
  (state.lastSeen ?? []).forEach((a) => roleSet.add(a.role));
  state.wishes.forEach((w) => {
    if (w.assignedTo) roleSet.add(w.assignedTo);
  });
  activeRoles = [...roleSet].sort();
  roleIndex = new Map(activeRoles.map((r, i) => [r, i]));

  // Precompute per-wish substance (pure function, cheap, ~100 threads).
  const nextCache = new Map();
  for (const w of sortedDone) {
    nextCache.set(w.id, computeSubstance(w, state.postmortems?.[w.id]));
  }
  substanceCache = nextCache;

  // Precompute affinity graph. Only over done wishes (the visible set).
  affinity = buildAffinity(sortedDone, state.postmortems ?? {});
}

function detectArrivals() {
  if (!prevState) return;
  const prevById = new Map(prevState.wishes.map((w) => [w.id, w]));
  for (const w of state.wishes) {
    const prev = prevById.get(w.id);
    const wasDone = prev && (prev.status === "done" || prev.status === "dismissed");
    const isDone = w.status === "done" || w.status === "dismissed";
    if (isDone && !wasDone) fireArrival(w);
  }
}

function fireArrival(wish) {
  arrivals.push({
    wishId: wish.id,
    t0: performance.now(),
    color: colorForTarget(wish.target),
  });
  enqueueWhisper(wish);
}

// ---- Substance (what each thread is "made of") ----
function computeSubstance(w, pm) {
  const h0 = hash(w.id);
  const logSteps = w.log ? w.log.split(" | ").filter(Boolean).length : 1;
  const tokens = pm?.totalTokens ?? 0;
  const quality = pm?.qualityScore ?? 3;

  // Effort proxy: log steps (always present) + tokens (when available).
  const effortBase = Math.log2(1 + logSteps) / Math.log2(11); // ~0..1 at 10 steps
  const tokenBonus = tokens > 0 ? clamp(Math.log2(tokens / 50_000) / Math.log2(32), 0, 1) : 0;
  const effort = clamp(0.55 * effortBase + 0.45 * tokenBonus, 0, 1);

  // Energy = effort + quality contribution. Used for breathing amplitude
  // and mote spawn probability. A stub = 0.1, a big quality-5 wish ≈ 1.
  const energy = clamp(effort * 0.7 + (quality / 5) * 0.3, 0, 1);

  // Thread thickness: 1.0..3.2 px.
  const thickness = 1.0 + effort * 2.2;

  // Weave density: micro-crossings along the thread.
  const crossings = clamp(Math.round(1.5 * logSteps), 3, 13);

  // Stable-seeded x-offsets (0..1) for each crossing, so the weave pattern
  // never jumps between frames or reorders.
  const weaveSeeds = new Array(crossings);
  for (let i = 0; i < crossings; i++) {
    weaveSeeds[i] = ((h0 * (i + 7) * 2654435761) >>> 0) / 4294967296;
  }

  // Per-thread breathing period (hash-seeded, never synchronized).
  const period = BREATH_PERIOD_MIN +
    (h0 % 1000) / 1000 * (BREATH_PERIOD_MAX - BREATH_PERIOD_MIN);
  const breathPhase = ((h0 >> 10) % 1000) / 1000 * Math.PI * 2;
  // Fast shimmer layer — restless sparkle on top of slow breath.
  const shimmerPeriod = SHIMMER_FAST_PERIOD_MIN +
    ((h0 >> 3) % 1000) / 1000 * (SHIMMER_FAST_PERIOD_MAX - SHIMMER_FAST_PERIOD_MIN);
  const shimmerPhase = ((h0 >> 20) % 1000) / 1000 * Math.PI * 2;

  return {
    thickness,
    energy,
    crossings,
    weaveSeeds,
    period,
    breathPhase,
    shimmerPeriod,
    shimmerPhase,
    h0,
  };
}

// ---- Color / math helpers ----
function colorForTarget(target) {
  return TARGET_COLORS[target] ?? TARGET_COLORS.other;
}

function hsl(h, s, l, a = 1) {
  return `hsla(${h}, ${s}%, ${l}%, ${a})`;
}

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function ageDays(iso) {
  if (!iso) return 30;
  const ms = Date.now() - new Date(iso).getTime();
  return ms / (1000 * 60 * 60 * 24);
}

function ageAlpha(days) {
  if (days < 0.08) return 1.0;
  return Math.max(0.28, 1 - Math.log2(1 + days) * 0.16);
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
function randRange(a, b) {
  return a + Math.random() * (b - a);
}

// ---- Layout ----
function layout() {
  const headerH = HEADER_PAD;
  const machineryH = Math.floor((H - headerH - FOOTER_PAD) * MACHINERY_RATIO);
  const fellY = headerH + machineryH;
  const tapestryY = fellY + FELL_HEIGHT;
  const tapestryH = H - tapestryY - FOOTER_PAD;
  return {
    headerH,
    machineryY: headerH,
    machineryH,
    fellY,
    tapestryY,
    tapestryH,
    tapestryLeft: 64,
    tapestryRight: W - 64,
  };
}

// ---- Render loop ----
let lastFrame = performance.now();
function draw(now) {
  const dt = Math.min(50, now - lastFrame);
  lastFrame = now;
  ctx.clearRect(0, 0, W, H);
  const L = layout();

  updateMemoryPulses(now);
  updateGlimmers(now);
  updateTokenMotes(now, dt, L);

  drawMachinery(L, now);
  drawFellBand(L, now);
  drawTapestry(L, now);
  drawGlimmers(L, now);
  drawTokenMotes(L);
  drawArrivals(L, now);

  requestAnimationFrame(draw);
}

// ---- Machinery strip ----
function drawMachinery(L, now) {
  if (!state) return;
  const t = now / 1000;
  const machineryBottom = L.machineryY + L.machineryH;
  const warpLeft = L.tapestryLeft;
  const warpRight = L.tapestryRight - 80;
  const n = Math.max(1, activeRoles.length);

  ctx.save();
  for (let i = 0; i < n; i++) {
    const x = warpLeft + (warpRight - warpLeft) * ((i + 0.5) / n);
    const breathe = 0.30 + Math.sin(t * 0.8 + i) * 0.06;
    // Warps descend from top of strip THROUGH the fell band INTO the cloth.
    const grad = ctx.createLinearGradient(0, L.machineryY, 0, L.tapestryY + 16);
    grad.addColorStop(0, `hsla(30, 22%, 55%, ${breathe})`);
    grad.addColorStop(0.85, `hsla(30, 30%, 62%, ${breathe + 0.1})`);
    grad.addColorStop(1, `hsla(30, 22%, 55%, 0)`);
    ctx.strokeStyle = grad;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, L.machineryY + 4);
    ctx.lineTo(x, L.tapestryY + 14);
    ctx.stroke();
  }

  // Hank of pending wishes on the right
  const pending = state.wishes.filter((w) => w.status !== "done" && w.status !== "dismissed");
  const hankX = L.tapestryRight - 40;
  for (let i = 0; i < Math.min(pending.length, 14); i++) {
    const y = L.machineryY + 14 + i * 7;
    ctx.strokeStyle = `hsla(40, 50%, 70%, ${0.35 + (i === 0 ? 0.2 : 0)})`;
    ctx.lineWidth = 1.2;
    const wiggle = Math.sin(t * 0.6 + i) * 3;
    ctx.beginPath();
    ctx.moveTo(hankX + wiggle, y);
    ctx.lineTo(hankX + 30, y);
    ctx.stroke();
  }

  // Shuttles — one per active role in state.active
  (state.active ?? []).forEach((a) => {
    const idx = roleIndex.get(a.role);
    if (idx === undefined) return;
    const x = warpLeft + (warpRight - warpLeft) * ((idx + 0.5) / n);
    const yMid = L.machineryY + L.machineryH * 0.55;
    const yOsc = Math.sin(t * 1.4 + idx) * (L.machineryH * 0.25);
    const cy = yMid + yOsc;
    const grd = ctx.createRadialGradient(x, cy, 0, x, cy, 14);
    grd.addColorStop(0, "hsla(40, 80%, 72%, 0.55)");
    grd.addColorStop(1, "hsla(40, 80%, 72%, 0)");
    ctx.fillStyle = grd;
    ctx.beginPath();
    ctx.arc(x, cy, 14, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "hsla(40, 85%, 80%, 0.95)";
    ctx.beginPath();
    ctx.ellipse(x, cy, 5, 3.2, 0, 0, Math.PI * 2);
    ctx.fill();
  });

  // Beacons: needs_human wishes
  const beacons = state.wishes.filter((w) => w.status === "needs_human" || w.status === "blocked");
  beacons.forEach((w, i) => {
    const x = warpLeft + 30 + (i * 28);
    const cy = machineryBottom - 14;
    const pulse = 0.6 + Math.sin(t * 3 + i) * 0.35;
    ctx.fillStyle = `hsla(35, 90%, 60%, ${pulse})`;
    ctx.beginPath();
    ctx.arc(x, cy, 4, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.restore();
}

// ---- Fell band: the warm heated line where the loom is working now ----
function drawFellBand(L, now) {
  const t = now / 1000;
  const y = L.fellY;
  const flicker = 0.85 + Math.sin(t * 1.7) * 0.06 + Math.sin(t * 3.3) * 0.04;
  const bandAlpha = 0.22 * flicker;

  // Heat gradient: vertical, hot at bottom of the band (where cloth meets loom)
  const grad = ctx.createLinearGradient(0, y, 0, y + FELL_HEIGHT + 4);
  grad.addColorStop(0, `hsla(35, 70%, 62%, 0)`);
  grad.addColorStop(0.5, `hsla(35, 75%, 65%, ${bandAlpha * 0.8})`);
  grad.addColorStop(1, `hsla(30, 60%, 58%, ${bandAlpha * 1.3})`);
  ctx.fillStyle = grad;
  ctx.fillRect(L.tapestryLeft - 12, y, (L.tapestryRight - L.tapestryLeft) + 24, FELL_HEIGHT + 4);

  // Embers — small bright points drifting along the fell line
  for (let i = 0; i < 6; i++) {
    const x = L.tapestryLeft +
      (L.tapestryRight - L.tapestryLeft) * (((t * 0.05) + i * 0.17) % 1);
    const ey = y + FELL_HEIGHT - 2 + Math.sin(t * 2 + i) * 1.5;
    const a = 0.3 + Math.sin(t * 2.4 + i * 1.3) * 0.25;
    ctx.fillStyle = `hsla(40, 85%, 78%, ${Math.max(0, a)})`;
    ctx.beginPath();
    ctx.arc(x, ey, 1.2, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ---- Glimmers: localized flashes + cascading echoes across affinity ----
function updateGlimmers(now) {
  // Retire expired
  for (let i = glimmers.length - 1; i >= 0; i--) {
    if (now - glimmers[i].t0 > GLIMMER_DURATION) glimmers.splice(i, 1);
  }
  // Fire due pending echoes
  for (let i = pendingEchoes.length - 1; i >= 0; i--) {
    const e = pendingEchoes[i];
    if (now >= e.fireAt) {
      pendingEchoes.splice(i, 1);
      fireGlimmer(e.wishId, e.x01, now, e.intensity, e.hop);
    }
  }
  // Spawn a new seed glimmer
  if (now >= nextGlimmerAt && sortedDone.length > 0 && glimmers.length < GLIMMER_MAX_POOL) {
    spawnSeedGlimmer(now);
    nextGlimmerAt = now + randRange(GLIMMER_SPAWN_INTERVAL_MIN, GLIMMER_SPAWN_INTERVAL_MAX);
  }
}

function spawnSeedGlimmer(now) {
  // Nearly-flat weighting — every thread has a chance. Slight bias to
  // energy so heavy threads glimmer somewhat more, but old stub threads
  // still speak. Perpetuum Mobile: the whole surface participates.
  let totalW = 0;
  const weights = sortedDone.map((w) => {
    const sub = substanceCache.get(w.id);
    if (!sub) return 0;
    const weight = 0.55 + sub.energy * 0.9; // 0.55 .. 1.45
    totalW += weight;
    return weight;
  });
  if (totalW <= 0) return;
  let r = Math.random() * totalW;
  let picked = 0;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r <= 0) {
      picked = i;
      break;
    }
  }
  const w = sortedDone[picked];
  const x01 = 0.08 + Math.random() * 0.84;
  fireGlimmer(w.id, x01, now, 1.0, 0);
}

function fireGlimmer(wishId, x01, now, intensity, hop) {
  if (glimmers.length >= GLIMMER_MAX_POOL) glimmers.shift();
  const sub = substanceCache.get(wishId);
  const energy = sub?.energy ?? 0.3;
  const radius = GLIMMER_RADIUS_MIN +
    (GLIMMER_RADIUS_MAX - GLIMMER_RADIUS_MIN) * clamp(energy * intensity, 0.1, 1);
  glimmers.push({ wishId, x01, t0: now, radius, intensity, hop });

  // Schedule echoes on affinity neighbors — bounded by hop count.
  if (hop >= 2) return;
  const neighbors = affinity.get(wishId) ?? [];
  if (neighbors.length === 0) return;
  const echoCount = Math.floor(
    ECHO_COUNT_MIN +
      Math.random() * (Math.min(neighbors.length, ECHO_COUNT_MAX) - ECHO_COUNT_MIN + 1),
  );
  for (let i = 0; i < echoCount && i < neighbors.length; i++) {
    // Echo at a nearby x (not identical) suggesting spatial relation.
    const echoX = clamp(x01 + (Math.random() - 0.5) * 0.22, 0.08, 0.92);
    pendingEchoes.push({
      wishId: neighbors[i],
      x01: echoX,
      fireAt: now + randRange(ECHO_DELAY_MIN, ECHO_DELAY_MAX),
      intensity: intensity * ECHO_DECAY,
      hop: hop + 1,
    });
  }
  // Rare second-order cascade gets an extra chance.
  if (hop === 0 && Math.random() < SECOND_ORDER_P) {
    // the first echo will naturally propagate (hop <=1) — nothing extra here.
  }
}

function drawGlimmers(L, now) {
  if (glimmers.length === 0) return;
  // Map wishId → thread index for visible threads.
  const maxThreads = Math.floor(L.tapestryH / THREAD_PITCH);
  const visibleIds = new Map();
  for (let i = 0; i < Math.min(sortedDone.length, maxThreads); i++) {
    visibleIds.set(sortedDone[i].id, i);
  }
  const left = L.tapestryLeft;
  const right = L.tapestryRight;
  const width = right - left;

  for (const g of glimmers) {
    const idx = visibleIds.get(g.wishId);
    if (idx === undefined) continue;
    const w = sortedDone[idx];
    const [hue, sat] = colorForTarget(w.target);
    const y = L.tapestryY + idx * THREAD_PITCH;
    const x = left + width * g.x01;

    const t = (now - g.t0) / GLIMMER_DURATION;
    if (t < 0 || t > 1) continue;
    // envelope: gentle rise, gentle fade — no punctuation
    const env = t < 0.25
      ? Math.sin((t / 0.25) * Math.PI * 0.5)
      : Math.pow(1 - (t - 0.25) / 0.75, 1.3);
    const a = 0.42 * g.intensity * env;
    const r = g.radius * (0.65 + env * 0.55);

    // Soft colored bloom — no hot white core. Every glimmer is the
    // same flavor of "something gentle lit up and settled again."
    const grd = ctx.createRadialGradient(x, y, 0, x, y, r);
    grd.addColorStop(0, `hsla(${hue}, ${sat + 20}%, 80%, ${a})`);
    grd.addColorStop(0.4, `hsla(${hue}, ${sat + 15}%, 74%, ${a * 0.5})`);
    grd.addColorStop(1, `hsla(${hue}, ${sat + 10}%, 68%, 0)`);
    ctx.fillStyle = grd;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);

    // Horizontal flare along the thread — short, suggests "this thread
    // spoke". Intentionally brief and subtle.
    const flareW = r * 1.2;
    const flareGrd = ctx.createLinearGradient(x - flareW, y, x + flareW, y);
    flareGrd.addColorStop(0, `hsla(${hue}, ${sat + 15}%, 78%, 0)`);
    flareGrd.addColorStop(0.5, `hsla(${hue}, ${sat + 20}%, 82%, ${a * 0.6})`);
    flareGrd.addColorStop(1, `hsla(${hue}, ${sat + 15}%, 78%, 0)`);
    ctx.strokeStyle = flareGrd;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(x - flareW, y);
    ctx.lineTo(x + flareW, y);
    ctx.stroke();
  }
}

// ---- Memory pulses: old heavy threads re-illumine as if the loom remembers ----
function updateMemoryPulses(now) {
  // Retire expired
  for (let i = memoryPulses.length - 1; i >= 0; i--) {
    if (now - memoryPulses[i].t0 > PULSE_DURATION) memoryPulses.splice(i, 1);
  }
  // Spawn
  if (now >= nextPulseAt && memoryPulses.length < PULSE_MAX_CONCURRENT) {
    spawnMemoryPulse();
    nextPulseAt = now + randRange(PULSE_INTERVAL_MIN, PULSE_INTERVAL_MAX);
  }
}

function spawnMemoryPulse() {
  if (sortedDone.length < 4) return;
  // Weight: prefer older AND heavier threads — inverse of "today's glow"
  const candidates = sortedDone.slice(2); // skip the freshest few
  let totalW = 0;
  const weights = candidates.map((w) => {
    const sub = substanceCache.get(w.id);
    if (!sub) return 0;
    const days = ageDays(w.statusSince);
    const oldness = clamp(Math.log2(1 + days) / 4, 0, 1); // 0..1 as days grow
    const weight = sub.energy * (0.35 + oldness * 0.65);
    totalW += weight;
    return weight;
  });
  if (totalW <= 0) return;
  let r = Math.random() * totalW;
  let pickedIdx = -1;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r <= 0) {
      pickedIdx = i;
      break;
    }
  }
  if (pickedIdx < 0) pickedIdx = 0;
  const w = candidates[pickedIdx];
  memoryPulses.push({ wishId: w.id, t0: performance.now() });
}

function drawMemoryPulse(L, now, pulse, threadIdx) {
  const dt = now - pulse.t0;
  if (dt < 0 || dt > PULSE_DURATION) return;
  const p = dt / PULSE_DURATION;
  const y = L.tapestryY + threadIdx * THREAD_PITCH;
  const left = L.tapestryLeft;
  const right = L.tapestryRight;
  const width = right - left;
  const sub = substanceCache.get(pulse.wishId);
  if (!sub) return;

  const head = left + width * p;
  const tail = Math.max(left, head - width * 0.22);
  const w = state?.wishes.find((x) => x.id === pulse.wishId);
  const [hue, sat] = w ? colorForTarget(w.target) : [40, 60];

  const grad = ctx.createLinearGradient(tail, 0, head, 0);
  const envelope = Math.sin(p * Math.PI); // rise and fall
  grad.addColorStop(0, `hsla(${hue}, ${sat + 20}%, 72%, 0)`);
  grad.addColorStop(1, `hsla(${hue}, ${sat + 20}%, 78%, ${0.55 * envelope})`);
  ctx.strokeStyle = grad;
  ctx.lineWidth = sub.thickness + 1.5;
  ctx.beginPath();
  ctx.moveTo(tail, y);
  ctx.lineTo(head, y);
  ctx.stroke();
}

// ---- Token motes: rare upward drift off heavy threads ----
function updateTokenMotes(now, dt, L) {
  // Age + rise
  for (let i = tokenMotes.length - 1; i >= 0; i--) {
    const m = tokenMotes[i];
    if (now - m.born > m.life) {
      tokenMotes.splice(i, 1);
      continue;
    }
    m.y += m.vy * (dt / 1000);
    m.x += Math.sin((now - m.born) / 600 + m.seed) * 0.15;
  }
  // Spawn: iterate only top-visible threads, low prob per frame
  if (tokenMotes.length >= MOTE_POOL_MAX || sortedDone.length === 0) return;
  const maxThreads = Math.min(sortedDone.length, Math.floor(L.tapestryH / THREAD_PITCH));
  // Pick one random visible thread per frame with its own spawn probability.
  const idx = Math.floor(Math.random() * maxThreads);
  const w = sortedDone[idx];
  const sub = substanceCache.get(w.id);
  if (!sub) return;
  // Fresher threads spawn more, but old heavy threads still occasionally emit.
  const age = ageDays(w.statusSince);
  const freshness = age < 1 ? 1 : age < 7 ? 0.4 : 0.15;
  const p = sub.energy * freshness * 0.12; // per-frame probability for this thread
  if (Math.random() < p) {
    const [hue, sat] = colorForTarget(w.target);
    const y = L.tapestryY + idx * THREAD_PITCH;
    const x = L.tapestryLeft + 20 + Math.random() * (L.tapestryRight - L.tapestryLeft - 40);
    tokenMotes.push({
      x,
      y,
      vy: -(4 + Math.random() * 6), // px/s upward
      life: MOTE_LIFE_MIN + Math.random() * (MOTE_LIFE_MAX - MOTE_LIFE_MIN),
      born: now,
      hue,
      sat,
      seed: Math.random() * 100,
    });
  }
}

function drawTokenMotes(L) {
  const now = performance.now();
  ctx.save();
  for (const m of tokenMotes) {
    const t = (now - m.born) / m.life;
    if (t < 0 || t > 1) continue;
    const alpha = Math.pow(1 - t, 1.6) * 0.45;
    ctx.fillStyle = `hsla(${m.hue}, ${m.sat + 20}%, 80%, ${alpha})`;
    ctx.beginPath();
    ctx.arc(m.x, m.y, 1.1, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// ---- Tapestry (hero) ----
function drawTapestry(L, now) {
  if (!state) return;
  const left = L.tapestryLeft;
  const right = L.tapestryRight;
  const maxThreads = Math.floor(L.tapestryH / THREAD_PITCH);
  const threads = sortedDone.slice(0, maxThreads);

  ctx.save();
  // Clip so edge fades are clean.
  ctx.beginPath();
  ctx.rect(left - 4, L.tapestryY - 2, (right - left) + 8, L.tapestryH + 2);
  ctx.clip();

  // Build a wish-id → thread-index map for memory pulses
  const indexById = new Map(threads.map((w, i) => [w.id, i]));

  for (let i = 0; i < threads.length; i++) {
    const w = threads[i];
    const sub = substanceCache.get(w.id);
    if (!sub) continue;
    const jitter = ((sub.h0 % 100) / 100 - 0.5) * 1.2;
    const y = L.tapestryY + i * THREAD_PITCH + jitter;
    const [hue, sat, base] = colorForTarget(w.target);
    const age = ageDays(w.statusSince ?? w.createdAt);
    let alpha = ageAlpha(age);

    // Per-thread breathing — the heart of "alive at idle". Two layers:
    // slow base breath + a faster sparkle layer. Different periods per
    // thread, never synchronized.
    const breathT = (now / sub.period) * Math.PI * 2 + sub.breathPhase;
    const shimT = (now / sub.shimmerPeriod) * Math.PI * 2 + sub.shimmerPhase;
    const breathAmp = BREATH_AMP_BASE + sub.energy * BREATH_AMP_ENERGY;
    const shimAmp = breathAmp * SHIMMER_FAST_AMP_RATIO;
    const osc = Math.sin(breathT) * breathAmp + Math.sin(shimT) * shimAmp;
    // Ancient threads breathe more gently (blend with age).
    const ageScale = clamp(ageAlpha(age) * 1.2, 0.4, 1.2);
    const lightness = base * (1 + osc * ageScale);

    // Failed → desaturated red; dismissed → faded.
    const pm = state.postmortems?.[w.id];
    const failed = pm && pm.outcome === "failed";
    const dismissed = w.dismissed;
    let drawH = hue, drawS = sat, drawL = lightness;
    if (failed) {
      drawH = 8;
      drawS = 28;
      drawL = Math.min(55, lightness);
    }
    if (dismissed) {
      drawS = 8;
      alpha *= 0.55;
    }

    // Thread with soft edge taper (gradient keeps ends feathery)
    const grad = ctx.createLinearGradient(left, 0, right, 0);
    grad.addColorStop(0, hsl(drawH, drawS, drawL, 0));
    grad.addColorStop(0.06, hsl(drawH, drawS, drawL, alpha));
    grad.addColorStop(0.94, hsl(drawH, drawS, drawL, alpha));
    grad.addColorStop(1, hsl(drawH, drawS, drawL, 0));
    ctx.strokeStyle = grad;
    ctx.lineWidth = sub.thickness;
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
    ctx.stroke();

    // Weave texture — tiny warp crossings at hash-stable x-positions.
    // Skips the outer 4% where edge fade is heavy.
    if (sub.crossings > 0 && !dismissed) {
      ctx.fillStyle = hsl(drawH, drawS + 5, drawL - 18, alpha * 0.42);
      const tickW = 0.9;
      const tickH = sub.thickness + 1.1;
      for (let c = 0; c < sub.crossings; c++) {
        const u = 0.05 + sub.weaveSeeds[c] * 0.9;
        const tx = left + (right - left) * u;
        ctx.fillRect(tx - tickW / 2, y - tickH / 2, tickW, tickH);
      }
    }

    // Fresh-heat glow — extra bloom on very recent threads (hours-old).
    if (age < 0.5 && !dismissed) {
      const heat = age < 0.04 ? 0.42 : age < 0.2 ? 0.26 : 0.12;
      const bloom = ctx.createLinearGradient(left, 0, right, 0);
      bloom.addColorStop(0, `hsla(${drawH}, ${drawS + 15}%, ${Math.min(85, drawL + 22)}%, 0)`);
      bloom.addColorStop(
        0.5,
        `hsla(${drawH}, ${drawS + 15}%, ${Math.min(85, drawL + 22)}%, ${heat})`,
      );
      bloom.addColorStop(1, `hsla(${drawH}, ${drawS + 15}%, ${Math.min(85, drawL + 22)}%, 0)`);
      ctx.strokeStyle = bloom;
      ctx.lineWidth = sub.thickness + 2.4;
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(right, y);
      ctx.stroke();
    }

    // Failed threads get a small fray at the right end.
    if (failed) {
      ctx.strokeStyle = hsl(10, 28, 45, alpha * 0.9);
      ctx.lineWidth = 1;
      const fx = right - 6;
      [[5, -3], [7, 0], [5, 3]].forEach(([dx, dy]) => {
        ctx.beginPath();
        ctx.moveTo(fx, y);
        ctx.lineTo(fx + dx, y + dy);
        ctx.stroke();
      });
    }
  }

  // Memory pulses — render on their target threads (if visible).
  for (const pulse of memoryPulses) {
    const idx = indexById.get(pulse.wishId);
    if (idx === undefined) continue;
    drawMemoryPulse(L, now, pulse, idx);
  }
  ctx.restore();
}

// ---- Arrival moments ----
function drawArrivals(L, now) {
  for (let i = arrivals.length - 1; i >= 0; i--) {
    const a = arrivals[i];
    const dt = now - a.t0;
    if (dt > ARRIVAL_DURATION) {
      arrivals.splice(i, 1);
      continue;
    }
    const p = dt / ARRIVAL_DURATION;
    const idx = sortedDone.findIndex((w) => w.id === a.wishId);
    if (idx < 0) continue;
    const y = L.tapestryY + idx * THREAD_PITCH;
    const cx = (L.tapestryLeft + L.tapestryRight) / 2;

    const radius = 12 + p * 180;
    const bloomAlpha = (1 - p) * 0.45;
    const grd = ctx.createRadialGradient(cx, y, 0, cx, y, radius);
    grd.addColorStop(0, `hsla(${a.color[0]}, ${a.color[1]}%, 78%, ${bloomAlpha})`);
    grd.addColorStop(1, `hsla(${a.color[0]}, ${a.color[1]}%, 70%, 0)`);
    ctx.fillStyle = grd;
    ctx.fillRect(cx - radius, y - radius, radius * 2, radius * 2);

    const seed = hash(a.wishId);
    for (let s = 0; s < SPARKLE_COUNT; s++) {
      const ph = (seed + s * 71) % 360;
      const ang = (ph / 360) * Math.PI * 2;
      const dist = 20 + p * 90;
      const sx = cx + Math.cos(ang) * dist;
      const sy = y - p * 40 + Math.sin(ang) * 6;
      const sa = (1 - p) * 0.9;
      ctx.fillStyle = `hsla(${a.color[0]}, 80%, 85%, ${sa})`;
      ctx.beginPath();
      ctx.arc(sx, sy, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

// ---- HUD ----
function updateHUD() {
  const doneCount = sortedDone.length;
  const todayCount = sortedDone.filter((w) => ageDays(w.statusSince) < 1).length;
  document.getElementById("taken-count").textContent = String(doneCount);
  document.getElementById("taken-label").textContent = `taken care of · ${todayCount} today`;

  const dot = document.getElementById("health-dot");
  const label = document.getElementById("health-label");
  if (demoMode) {
    dot.classList.remove("alive");
    dot.style.background = "#c896f0";
    label.textContent = "demo · synthetic fabric";
    return;
  }
  const h = state.daemon;
  if (h && h.alive) {
    dot.classList.add("alive");
    label.textContent = `awake · ${formatUptime(h.uptimeS ?? 0)}`;
  } else {
    dot.classList.remove("alive");
    label.textContent = h ? `quiet · ${formatAge(h.ageS)} ago` : "no daemon seen";
  }
}

function formatUptime(s) {
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

function formatAge(s) {
  if (s < 0) return "—";
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

// ---- Micro-summary rotator (bottom strip) ----
const micro = document.getElementById("micro-summary");
let microItems = [];
let microIdx = 0;
let microTimer = null;

function updateMicroSummary() {
  const recent = sortedDone.filter((w) => ageDays(w.statusSince) < 3).slice(0, 8);
  microItems = recent.map((w) => friendlyLine(w));
  microIdx = 0;
  renderMicro();
  if (microTimer) clearInterval(microTimer);
  if (microItems.length > 1) {
    microTimer = setInterval(() => {
      microIdx = (microIdx + 1) % microItems.length;
      renderMicro();
    }, 8000);
  }
}

function renderMicro() {
  if (microItems.length === 0) {
    micro.textContent = state && connected ? "nothing new yet · the loom is quiet" : "listening…";
    return;
  }
  const line = microItems[microIdx];
  micro.innerHTML = `<span style="opacity:0.65">while you were away:</span> ${escapeHtml(line)}`;
}

// ---- Arrival whisper (bottom-left) ----
const whisperEl = document.getElementById("whisper");
const whisperQueue = [];
let whisperShowing = false;

function enqueueWhisper(wish) {
  whisperQueue.push(wish);
  if (!whisperShowing) nextWhisper();
}

function nextWhisper() {
  const w = whisperQueue.shift();
  if (!w) {
    whisperShowing = false;
    return;
  }
  whisperShowing = true;
  whisperEl.textContent = friendlyLine(w);
  whisperEl.classList.add("visible");
  setTimeout(() => {
    whisperEl.classList.remove("visible");
    setTimeout(nextWhisper, 500);
  }, 4200);
}

function friendlyLine(w) {
  const glyph = targetGlyph(w.target);
  const verb = targetVerb(w.target);
  const gist = firstSentence(w.response) || truncate(w.text, 80);
  return `${glyph} ${verb}: ${truncate(gist, 110)}`;
}

function targetGlyph(t) {
  return { capture: "📨", system: "✨", review: "🌿", "pattern-dev": "🪄", "gtd-ops": "✅" }[t] ??
    "·";
}

function targetVerb(t) {
  return {
    capture: "captured",
    system: "took care of",
    review: "reviewed",
    "pattern-dev": "built",
    "gtd-ops": "tended",
  }[t] ?? "done";
}

function firstSentence(s) {
  if (!s) return "";
  const m = s.match(/^[^.!?\n]{10,200}[.!?]/);
  return m ? m[0] : s.slice(0, 140);
}

function truncate(s, n) {
  if (!s) return "";
  return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + "…";
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

// ---- Hover/click (tooltip + drawer) ----
const tooltipEl = document.getElementById("tooltip");
const drawerEl = document.getElementById("drawer");
const drawerBody = document.getElementById("drawer-body");
let hoverTarget = null;

canvas.addEventListener("mousemove", (e) => {
  const target = hitTest(e.clientX, e.clientY);
  if (!target) {
    hoverTarget = null;
    tooltipEl.classList.remove("visible");
    canvas.style.cursor = "default";
    return;
  }
  hoverTarget = target;
  canvas.style.cursor = "pointer";
  tooltipEl.classList.add("visible");
  tooltipEl.style.left = Math.min(W - 360, e.clientX + 14) + "px";
  tooltipEl.style.top = Math.min(H - 120, e.clientY + 14) + "px";
  tooltipEl.innerHTML = renderTooltip(target);
});

canvas.addEventListener("mouseleave", () => {
  hoverTarget = null;
  tooltipEl.classList.remove("visible");
});

canvas.addEventListener("click", () => {
  if (!hoverTarget) return;
  openDrawer(hoverTarget);
});

document.getElementById("drawer-close").addEventListener("click", () => {
  drawerEl.classList.remove("open");
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") drawerEl.classList.remove("open");
});

function hitTest(mx, my) {
  if (!state) return null;
  const L = layout();
  if (
    my >= L.tapestryY && my <= L.tapestryY + L.tapestryH &&
    mx >= L.tapestryLeft && mx <= L.tapestryRight
  ) {
    const idx = Math.floor((my - L.tapestryY) / THREAD_PITCH);
    if (idx >= 0 && idx < sortedDone.length) {
      return { type: "wish", wish: sortedDone[idx] };
    }
  }
  if (my >= L.machineryY && my <= L.machineryY + L.machineryH) {
    const warpLeft = L.tapestryLeft;
    const warpRight = L.tapestryRight - 80;
    const n = Math.max(1, activeRoles.length);
    for (let i = 0; i < n; i++) {
      const x = warpLeft + (warpRight - warpLeft) * ((i + 0.5) / n);
      if (Math.abs(mx - x) < 16) {
        return { type: "role", role: activeRoles[i] };
      }
    }
  }
  return null;
}

function renderTooltip(target) {
  if (target.type === "wish") {
    const w = target.wish;
    const line = friendlyLine(w);
    const ago = relativeTime(w.statusSince ?? w.createdAt);
    const pm = state.postmortems?.[w.id];
    let qmeta = "";
    if (pm?.qualityScore) qmeta = ` · quality ${pm.qualityScore}/5`;
    return `<div class="head">${escapeHtml(line)}</div>
            <div class="meta">${ago} · ${escapeHtml(w.id)}${qmeta}</div>`;
  }
  if (target.type === "role") {
    const active = (state.active ?? []).find((a) => a.role === target.role);
    const last = (state.lastSeen ?? []).find((a) => a.role === target.role);
    const status = active
      ? `working now · ${escapeHtml(active.activity ?? "")}`
      : last
      ? `last active ${escapeHtml(last.lastActive ?? "")} · ${escapeHtml(last.status ?? "")}`
      : "idle";
    return `<div class="head">${escapeHtml(target.role)}</div>
            <div class="meta">${status}</div>`;
  }
  return "";
}

function openDrawer(target) {
  if (target.type === "wish") {
    const w = target.wish;
    const pm = state.postmortems?.[w.id];
    const logEntries = (w.log ?? "").split(" | ").filter(Boolean);
    drawerBody.innerHTML = `
      <h3>${escapeHtml(w.id)} · ${escapeHtml(w.target)}</h3>
      <div class="sub">${escapeHtml(w.status)} · ${relativeTime(w.statusSince ?? w.createdAt)}${
      w.assignedTo ? " · " + escapeHtml(w.assignedTo) : ""
    }</div>
      <section>
        <h4>request</h4>
        <div class="body">${escapeHtml(w.text ?? "")}</div>
      </section>
      ${
      w.response
        ? `<section><h4>response</h4><div class="body">${escapeHtml(w.response)}</div></section>`
        : ""
    }
      ${
      logEntries.length
        ? `<section><h4>trail</h4>${
          logEntries.map((l) => `<div class="log-entry">${escapeHtml(l)}</div>`).join("")
        }</section>`
        : ""
    }
      ${
      pm
        ? `<section><h4>postmortem</h4><div class="body">${
          escapeHtml(pm.summary ?? "")
        }</div></section>`
        : ""
    }
    `;
    drawerEl.classList.add("open");
  } else if (target.type === "role") {
    const role = target.role;
    const recent = state.wishes
      .filter((w) => w.assignedTo === role)
      .sort((a, b) => (b.statusSince ?? "").localeCompare(a.statusSince ?? ""))
      .slice(0, 12);
    const items = recent.map((w) =>
      `<div class="log-entry">${
        escapeHtml(friendlyLine(w))
      } <span style="color:var(--ink-muted)">· ${
        relativeTime(w.statusSince ?? w.createdAt)
      }</span></div>`
    ).join("");
    drawerBody.innerHTML = `
      <h3>${escapeHtml(role)}</h3>
      <div class="sub">recent work</div>
      ${items || '<div class="body">no recent work</div>'}
    `;
    drawerEl.classList.add("open");
  }
}

function relativeTime(iso) {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  if (ms < 7 * 86_400_000) return `${Math.floor(ms / 86_400_000)}d ago`;
  return new Date(iso).toLocaleDateString();
}

// ---- Boot ----
connectSSE();
requestAnimationFrame(draw);
