// loom-viewer client — canvas renderer + SSE state + interactions.
// Tapestry is the hero: ~70% of canvas, glowing with everything taken care of.
// Machinery is the supporting cast: a thin, dim top strip.

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
const THREAD_PITCH = 6; // vertical space per tapestry thread (px)
const THREAD_HEIGHT = 1.6; // drawn thickness
const ARRIVAL_DURATION = 1600; // ms a warm pulse animation runs
const SPARKLE_COUNT = 5;

// ---- State ----
let state = null; // current FabricState from the server
let prevState = null; // the previous snapshot (for arrival-moment detection)
let connected = false;

// Sorted lists derived once per snapshot
let sortedDone = [];
let activeRoles = []; // union of active + lastSeen roles, alphabetized
let roleIndex = new Map();

// ---- Animation state ----
const arrivals = []; // { wishId, t0, y, color }
const dustMotes = Array.from({ length: 14 }, () => ({
  x: Math.random(),
  y: Math.random(),
  phase: Math.random() * Math.PI * 2,
  speed: 0.02 + Math.random() * 0.04,
}));

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

// ---- SSE ----
function connectSSE() {
  const es = new EventSource("/events");
  es.addEventListener("open", () => {
    connected = true;
  });
  es.addEventListener("error", () => {
    connected = false;
  });
  es.addEventListener("message", (e) => {
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

// ---- Color helpers ----
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
  // Today glows strongly. Yesterday solid. Older gently recedes. Min 0.24.
  if (days < 0.08) return 1.0;
  return Math.max(0.24, 1 - Math.log2(1 + days) * 0.18);
}

// Extra additive "glow" for very recent threads — makes today pop.
function freshGlow(days) {
  if (days < 0.04) return 0.45; // ~1hr
  if (days < 0.2) return 0.25; // ~5hr
  if (days < 0.5) return 0.12; // ~12hr
  return 0;
}

// ---- Layout ----
function layout() {
  const headerH = HEADER_PAD;
  const machineryH = Math.floor((H - headerH - FOOTER_PAD) * MACHINERY_RATIO);
  const tapestryY = headerH + machineryH + 2; // sits right under the reed line
  const tapestryH = H - tapestryY - FOOTER_PAD;
  return {
    headerH,
    machineryY: headerH,
    machineryH,
    tapestryY,
    tapestryH,
    tapestryLeft: 64,
    tapestryRight: W - 64,
  };
}

// ---- Render ----
function draw(now) {
  ctx.clearRect(0, 0, W, H);
  const L = layout();

  drawDustMotes(L, now);
  drawMachinery(L, now);
  drawTapestry(L, now);
  drawArrivals(L, now);

  requestAnimationFrame(draw);
}

function drawDustMotes(L, now) {
  ctx.save();
  for (const m of dustMotes) {
    const t = now / 1000;
    const x = (m.x + Math.sin(t * m.speed + m.phase) * 0.08) * W;
    const y = (m.y + Math.cos(t * m.speed * 0.7 + m.phase) * 0.08) * H;
    const alpha = 0.08 + Math.sin(t * 0.5 + m.phase) * 0.04;
    ctx.fillStyle = `rgba(246, 200, 122, ${Math.max(0.02, alpha)})`;
    ctx.beginPath();
    ctx.arc(x, y, 1.1, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawMachinery(L, now) {
  if (!state) return;
  const t = now / 1000;
  const machineryBottom = L.machineryY + L.machineryH;
  const warpLeft = L.tapestryLeft;
  const warpRight = L.tapestryRight - 80; // leave room for "hank" on the right
  const n = Math.max(1, activeRoles.length);

  // Warps
  ctx.save();
  for (let i = 0; i < n; i++) {
    const x = warpLeft + (warpRight - warpLeft) * ((i + 0.5) / n);
    const breathe = 0.30 + Math.sin(t * 0.8 + i) * 0.06;
    ctx.strokeStyle = `hsla(30, 22%, 55%, ${breathe})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, L.machineryY + 4);
    ctx.lineTo(x, machineryBottom - 4);
    ctx.stroke();

    // tiny label dot at top (only text on hover — see HUD handling)
    ctx.fillStyle = "hsla(30, 22%, 70%, 0.25)";
    ctx.fillRect(x - 2, L.machineryY + 2, 4, 2);
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
    // soft glow
    const grd = ctx.createRadialGradient(x, cy, 0, x, cy, 14);
    grd.addColorStop(0, "hsla(40, 80%, 72%, 0.55)");
    grd.addColorStop(1, "hsla(40, 80%, 72%, 0)");
    ctx.fillStyle = grd;
    ctx.beginPath();
    ctx.arc(x, cy, 14, 0, Math.PI * 2);
    ctx.fill();
    // core lozenge
    ctx.fillStyle = "hsla(40, 85%, 80%, 0.95)";
    ctx.beginPath();
    ctx.ellipse(x, cy, 5, 3.2, 0, 0, Math.PI * 2);
    ctx.fill();
  });

  // Beacons: needs_human wishes appear as amber pulsing circles on the machinery strip
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

function drawTapestry(L, now) {
  if (!state) return;
  const t = now / 1000;
  const left = L.tapestryLeft;
  const right = L.tapestryRight;
  const width = right - left;
  const maxThreads = Math.floor(L.tapestryH / THREAD_PITCH);
  const threads = sortedDone.slice(0, maxThreads);

  // Reed line at the top edge — visually connects machinery to cloth.
  ctx.strokeStyle = "hsla(30, 35%, 55%, 0.25)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(left - 12, L.tapestryY - 1);
  ctx.lineTo(right + 12, L.tapestryY - 1);
  ctx.stroke();

  ctx.save();
  // Clip tapestry to its bounds so the edge fade works cleanly.
  ctx.beginPath();
  ctx.rect(left - 4, L.tapestryY - 2, (right - left) + 8, L.tapestryH + 2);
  ctx.clip();

  for (let i = 0; i < threads.length; i++) {
    const w = threads[i];
    const h0 = hash(w.id);
    const jitter = ((h0 % 100) / 100 - 0.5) * 1.4; // ±0.7px
    const y = L.tapestryY + i * THREAD_PITCH + jitter;
    const [hue, sat, base] = colorForTarget(w.target);
    const age = ageDays(w.statusSince ?? w.createdAt);
    let alpha = ageAlpha(age);

    const phase = (h0 % 1000) / 159;
    const shimmer = Math.sin(t * 0.35 + phase) * 0.04 + 1;
    const lightness = base * shimmer;

    // Failed postmortems → desaturated red
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
      alpha *= 0.5;
    }

    // thread with soft edge taper via segmented alpha
    const grad = ctx.createLinearGradient(left, 0, right, 0);
    grad.addColorStop(0, hsl(drawH, drawS, drawL, 0));
    grad.addColorStop(0.06, hsl(drawH, drawS, drawL, alpha));
    grad.addColorStop(0.94, hsl(drawH, drawS, drawL, alpha));
    grad.addColorStop(1, hsl(drawH, drawS, drawL, 0));
    ctx.strokeStyle = grad;
    ctx.lineWidth = THREAD_HEIGHT;

    // slight alternating offset for weave texture
    const off = i % 2 === 0 ? 0 : 1.2;
    ctx.beginPath();
    ctx.moveTo(left + off, y);
    ctx.lineTo(right - (1 - off), y);
    ctx.stroke();

    // recency bloom: additive glow on very fresh threads
    const gl = freshGlow(age);
    if (gl > 0 && !dismissed) {
      const bloom = ctx.createLinearGradient(left, 0, right, 0);
      bloom.addColorStop(0, `hsla(${drawH}, ${drawS + 15}%, ${Math.min(85, drawL + 22)}%, 0)`);
      bloom.addColorStop(
        0.5,
        `hsla(${drawH}, ${drawS + 15}%, ${Math.min(85, drawL + 22)}%, ${gl})`,
      );
      bloom.addColorStop(1, `hsla(${drawH}, ${drawS + 15}%, ${Math.min(85, drawL + 22)}%, 0)`);
      ctx.strokeStyle = bloom;
      ctx.lineWidth = THREAD_HEIGHT + 2;
      ctx.beginPath();
      ctx.moveTo(left + off, y);
      ctx.lineTo(right - (1 - off), y);
      ctx.stroke();
    }

    // fray at the end for failed wishes
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

  // Empty warp continuation below the last thread — "more to come"
  const warpsLastY = L.tapestryY + threads.length * THREAD_PITCH;
  const warpEnd = L.tapestryY + L.tapestryH - 8;
  if (warpEnd > warpsLastY + 10) {
    const n = Math.max(12, Math.floor(width / 48));
    for (let i = 1; i < n; i++) {
      const x = left + (width * i) / n;
      const alpha = 0.10 - (i % 3) * 0.02;
      ctx.strokeStyle = `hsla(30, 20%, 52%, ${Math.max(0.04, alpha)})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, warpsLastY + 4);
      ctx.lineTo(x, warpEnd);
      ctx.stroke();
    }
  }
  ctx.restore();
}

function drawArrivals(L, now) {
  for (let i = arrivals.length - 1; i >= 0; i--) {
    const a = arrivals[i];
    const dt = now - a.t0;
    if (dt > ARRIVAL_DURATION) {
      arrivals.splice(i, 1);
      continue;
    }
    const p = dt / ARRIVAL_DURATION;
    // Find the wish's current y (it's at sortedDone index 0 — freshly added)
    const idx = sortedDone.findIndex((w) => w.id === a.wishId);
    if (idx < 0) continue;
    const y = L.tapestryY + idx * THREAD_PITCH;
    const cx = (L.tapestryLeft + L.tapestryRight) / 2;

    // Warm bloom
    const radius = 12 + p * 180;
    const bloomAlpha = (1 - p) * 0.45;
    const grd = ctx.createRadialGradient(cx, y, 0, cx, y, radius);
    grd.addColorStop(0, `hsla(${a.color[0]}, ${a.color[1]}%, 78%, ${bloomAlpha})`);
    grd.addColorStop(1, `hsla(${a.color[0]}, ${a.color[1]}%, 70%, 0)`);
    ctx.fillStyle = grd;
    ctx.fillRect(cx - radius, y - radius, radius * 2, radius * 2);

    // Sparkles
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
  const recent = sortedDone
    .filter((w) => ageDays(w.statusSince) < 3)
    .slice(0, 8);
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
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
  );
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
  // Tapestry hit
  if (
    my >= L.tapestryY && my <= L.tapestryY + L.tapestryH &&
    mx >= L.tapestryLeft && mx <= L.tapestryRight
  ) {
    const idx = Math.floor((my - L.tapestryY) / THREAD_PITCH);
    if (idx >= 0 && idx < sortedDone.length) {
      return { type: "wish", wish: sortedDone[idx] };
    }
  }
  // Machinery hit — active shuttles
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
