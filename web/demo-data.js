// Synthetic fabric for demo mode. Generates a plausible-looking FabricState
// so people can see the viewer's vibe without running a real loom daemon.
//
// We seed with deterministic-ish values so the cloth looks composed (varied
// targets, varied effort, varied tags, scattered failures + needs-human),
// not random noise.

const TARGETS = ["capture", "system", "review", "pattern-dev", "gtd-ops"];
const AGENTS = [
  "capture-agent",
  "wish-dispatch",
  "sweep-reviewer",
  "sweep-archivist",
  "dispatch-GTD",
  "overseer-CF1",
  "sweep-foreman",
];

const TAG_POOLS = {
  capture: [
    "capture",
    "people-note",
    "company-research",
    "pricing",
    "compliance",
    "browser-history",
    "wishes-ledger",
    "perplexity",
  ],
  system: ["file-cabinet", "about-md", "project-scaffold", "calendar", "wishes-ledger"],
  review: ["gtd", "gtd-review", "inbox-zero", "calendar-cleanup"],
  "pattern-dev": ["pattern", "ui", "react", "fabric"],
  "gtd-ops": ["gtd", "people-note", "calendar", "context-list", "scaffold"],
};

const TEXT_TEMPLATES = {
  capture: [
    "Clip about pricing strategy from a recent article",
    "Update people record after meeting with a network contact",
    "File compliance verification for the SOS statement of information",
    "Capture an idea about positioning vs. competitors",
    "Add this to the adjacent companies notes",
    "Surface a kudos I haven't seen in a while",
    "Note a follow-up about Delaware franchise tax",
  ],
  system: [
    "Auto: New File Cabinet folder(s) detected — populate about.md",
    "Auto: Run full daily GTD review per the weekly checklist",
    "Auto: Fold in continuation capture results into parent wish",
    "Auto: Sweep dispatch log for stale tickets",
    "Auto: New project folder scaffolding",
  ],
  review: [
    "Daily review: process inbox, clean up actions",
    "Weekly review: re-check all threads + waiting-for",
  ],
  "pattern-dev": [
    "Tweak the loom pattern markup for the new field",
    "Update the cf-loom-mobile component",
  ],
  "gtd-ops": [
    "Tend the inbox",
    "Reconcile calendar duplicates",
  ],
};

const RESPONSE_TEMPLATES = {
  capture: [
    "Filed under Work/Companies/, linked into the relevant strategy memo, and marked the capture processed.",
    "Updated the canonical people note with the latest meeting context and availability.",
    "Verified likely already filed; the recent SOS receipt confirms the submission landed.",
  ],
  system: [
    "Populated the requested about.md files for the detected folders, grounded from sibling context.",
    "Inbox cleared to zero, threads/waiting/calendar/someday reviewed, log updated.",
    "Cleared the stale ticket and noted the timeout in the dispatch log.",
  ],
  review: [
    "Inbox zeroed, GTD review logged, calendar duplicate removed.",
  ],
  "pattern-dev": [
    "Pattern updated; rebuilt and verified the field renders.",
  ],
  "gtd-ops": [
    "Tended the inbox; surfaced two new actions and one waiting-for entry.",
  ],
};

function pick(arr, rng) {
  return arr[Math.floor(rng() * arr.length)];
}
function pickN(arr, n, rng) {
  const c = [...arr];
  const out = [];
  for (let i = 0; i < n && c.length; i++) {
    const idx = Math.floor(rng() * c.length);
    out.push(c.splice(idx, 1)[0]);
  }
  return out;
}

// Mulberry32: tiny seeded PRNG so the demo cloth has the same shape each
// load, but slight variations across reseeds.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildDemoState() {
  const seed = Date.now() & 0xffff;
  const rng = mulberry32(seed);
  const now = Date.now();
  const wishes = [];
  const postmortems = {};
  const N = 88;

  for (let i = 0; i < N; i++) {
    const id = `W-${500 + i}`;
    // Younger wishes at the end (higher i = more recent), with realistic
    // log-scaled spacing so today has many, last week has fewer.
    const ageDays = Math.pow(1 - i / N, 2.2) * 14; // 0..14d, weighted recent
    const ts = new Date(now - ageDays * 86400_000).toISOString();
    const target = pick(TARGETS, rng);
    const agent = pick(AGENTS, rng);
    const text = pick(TEXT_TEMPLATES[target] ?? TEXT_TEMPLATES.capture, rng);
    const response = pick(RESPONSE_TEMPLATES[target] ?? RESPONSE_TEMPLATES.capture, rng);

    // Effort signal: vary log step count widely so threads vary in thickness
    const logSteps = Math.max(1, Math.round(1 + Math.pow(rng(), 1.7) * 9));
    const log = Array.from(
      { length: logSteps },
      (_, k) =>
        `step ${k + 1}: ${["read", "modified", "created", "verified", "logged"][k % 5]} something`,
    ).join(" | ");

    // Status: mostly done, sometimes needs_human/blocked, rarely dismissed
    let status = "done";
    const r = rng();
    if (r < 0.04) status = "needs_human";
    else if (r < 0.07) status = "blocked";
    else if (r < 0.12) status = "dismissed";

    wishes.push({
      id,
      target,
      status,
      statusSince: ts,
      createdAt: ts,
      assignedTo: agent,
      text,
      response,
      log,
      sourceFile: `/demo/captures/${id}.md`,
      dismissed: status === "dismissed",
      section: "processed",
    });

    // Postmortem: 60% of done wishes get one
    if ((status === "done" || status === "dismissed") && rng() < 0.6) {
      const tagPool = TAG_POOLS[target] ?? TAG_POOLS.capture;
      const tagCount = 2 + Math.floor(rng() * 3);
      const tags = pickN(tagPool, tagCount, rng);
      const failed = rng() < 0.05;
      const totalTokens = Math.floor(20_000 + Math.pow(rng(), 2.5) * 1_500_000);
      postmortems[id] = {
        wishId: id,
        outcome: failed ? "failed" : "done",
        classification: target,
        summary: response,
        rootCause: [failed ? "empty-response" : "success"],
        qualityScore: failed ? 1 + Math.floor(rng() * 2) : 3 + Math.floor(rng() * 3),
        tags,
        totalTokens,
      };
    }
  }

  // Active session: one currently working
  const active = [{
    role: "sweep-reviewer",
    startedAt: new Date(now - 90_000).toISOString().slice(0, 10),
    activity: "Running reviewer sweep",
  }];
  const lastSeen = AGENTS.slice(0, 4).map((role, i) => ({
    role,
    lastActive: new Date(now - (i + 1) * 600_000).toISOString().slice(0, 10),
    status: `Completed: ${pick(["W-583", "W-572", "W-560", "W-549"], rng)}`,
  }));

  return {
    wishes,
    active,
    lastSeen,
    postmortems,
    needsYou: [],
    daemon: {
      pid: 0,
      uptimeS: 1800,
      lastPoll: new Date(now).toISOString(),
      pendingActions: 4,
      alive: true,
      ageS: 0,
    },
    dispatch: null,
    generatedAt: new Date().toISOString(),
    __demo: true,
  };
}
