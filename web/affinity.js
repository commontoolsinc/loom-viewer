// Compute a per-wish affinity graph — "which other threads is this one
// in conversation with?" Used to drive echo-glimmer cascades so that a
// flash on one thread is answered a beat later by related threads.
//
// Signals (weighted):
//   * shared postmortem tags (strongest — explicit topical overlap)
//   * shared assignedTo agent role
//   * shared wish target
//   * temporal proximity (completed within a few hours)
//   * shared keywords from text/response (noun-ish tokens)

const AFFINITY_TOP_K = 3;
const WEIGHT_TAG = 3.0;
const WEIGHT_AGENT = 2.0;
const WEIGHT_TARGET = 1.0;
const WEIGHT_TEMPORAL = 1.0;
const WEIGHT_KEYWORD = 0.5;
const TEMPORAL_WINDOW_HOURS = 6;

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "for",
  "to",
  "of",
  "in",
  "on",
  "at",
  "by",
  "with",
  "from",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "this",
  "that",
  "these",
  "those",
  "it",
  "its",
  "as",
  "into",
  "about",
  "over",
  "under",
  "up",
  "down",
  "out",
  "off",
  "i",
  "you",
  "he",
  "she",
  "we",
  "they",
  "me",
  "him",
  "her",
  "us",
  "them",
  "my",
  "your",
  "his",
  "their",
  "our",
  "not",
  "no",
  "yes",
  "but",
  "if",
  "so",
  "than",
  "then",
  "just",
  "auto",
  "new",
  "wish",
  "done",
  "todo",
  "did",
  "do",
  "does",
  "has",
  "have",
  "had",
  "w",
  "w-",
  "capture",
  "system",
  "review",
  "gtd",
  "fabric",
  "loom",
  "file",
  "folder",
  "files",
  "folders",
  "about",
  "md",
  "note",
  "notes",
  "project",
  "projects",
]);

function extractKeywords(text) {
  if (!text) return [];
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 4 && !STOPWORDS.has(t) && !/^\d+$/.test(t));
  // Keep unique. Return up to 6 most-frequent.
  const counts = new Map();
  for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([t]) => t);
}

function jaccard(a, b) {
  if (a.length === 0 || b.length === 0) return 0;
  const sb = new Set(b);
  let overlap = 0;
  for (const x of a) if (sb.has(x)) overlap++;
  return overlap / (a.length + b.length - overlap);
}

function parseTime(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return isFinite(t) ? t : null;
}

// Build affinity graph: for each wish id, an array of up to top-K neighbor ids
// sorted by descending score. Returns Map<string, string[]>.
export function buildAffinity(wishes, postmortems) {
  const meta = wishes.map((w) => {
    const pm = postmortems?.[w.id];
    const tags = new Set(pm?.tags ?? []);
    const keywords = extractKeywords((w.text ?? "") + " " + (w.response ?? ""));
    const t = parseTime(w.statusSince ?? w.createdAt);
    return { w, tags, keywords, t };
  });

  const out = new Map();
  for (let i = 0; i < meta.length; i++) {
    const a = meta[i];
    const scored = [];
    for (let j = 0; j < meta.length; j++) {
      if (i === j) continue;
      const b = meta[j];
      let score = 0;

      // Shared tags — count each shared tag.
      if (a.tags.size && b.tags.size) {
        let shared = 0;
        for (const t of a.tags) if (b.tags.has(t)) shared++;
        if (shared > 0) score += WEIGHT_TAG * shared;
      }

      // Same agent
      if (a.w.assignedTo && a.w.assignedTo === b.w.assignedTo) {
        score += WEIGHT_AGENT;
      }

      // Same target category
      if (a.w.target && a.w.target === b.w.target) {
        score += WEIGHT_TARGET;
      }

      // Temporal proximity — within a window. Linear falloff.
      if (a.t && b.t) {
        const dh = Math.abs(a.t - b.t) / (1000 * 60 * 60);
        if (dh < TEMPORAL_WINDOW_HOURS) {
          score += WEIGHT_TEMPORAL * (1 - dh / TEMPORAL_WINDOW_HOURS);
        }
      }

      // Keyword jaccard
      if (a.keywords.length && b.keywords.length) {
        const j = jaccard(a.keywords, b.keywords);
        if (j > 0) score += WEIGHT_KEYWORD * j * 4; // amplify since jaccard is small
      }

      if (score > 0) scored.push({ id: b.w.id, score });
    }
    scored.sort((x, y) => y.score - x.score);
    out.set(a.w.id, scored.slice(0, AFFINITY_TOP_K).map((s) => s.id));
  }
  return out;
}
