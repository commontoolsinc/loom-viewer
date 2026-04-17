// Parses the fabric's raw files into a normalized FabricState.
// All reads are best-effort: missing files become empty structures, never throw.

export type WishStatus =
  | "pending"
  | "queued"
  | "assigned"
  | "running"
  | "done"
  | "needs_human"
  | "blocked"
  | "dismissed"
  | string;

export interface Wish {
  id: string;
  target: string;
  status: WishStatus;
  statusSince?: string;
  createdAt?: string;
  assignedTo?: string;
  text: string;
  response?: string;
  log?: string;
  sourceFile?: string;
  dismissed?: boolean;
  section: "pending" | "processed";
}

export interface ActiveAgent {
  role: string;
  startedAt?: string;
  activity?: string;
}

export interface AgentLastSeen {
  role: string;
  lastActive?: string;
  status?: string;
}

export interface Postmortem {
  wishId: string;
  outcome: "done" | "failed" | "needs_human" | string;
  classification?: string;
  summary?: string;
  rootCause?: string[];
  qualityScore?: number;
  tags?: string[];
  durationMs?: number;
  totalTokens?: number;
}

export interface DaemonHealth {
  pid?: number;
  uptimeS?: number;
  lastPoll?: string;
  pendingActions?: number;
  alive: boolean;
  ageS: number;
}

export interface DispatchLaneStatus {
  lane: string;
  wishes: Record<
    string,
    { status: string; started?: string; completed?: string; response?: string }
  >;
}

export interface NeedsYouReport {
  filename: string;
  wishId?: string;
  createdAt?: string;
  summary?: string;
}

export interface FabricState {
  wishes: Wish[];
  active: ActiveAgent[];
  lastSeen: AgentLastSeen[];
  postmortems: Record<string, Postmortem>;
  needsYou: NeedsYouReport[];
  daemon: DaemonHealth | null;
  dispatch: DispatchLaneStatus | null;
  generatedAt: string;
}

const KNOWN_WISH_FIELDS = new Set([
  "target",
  "text",
  "source",
  "sourceFile",
  "createdAt",
  "status",
  "statusSince",
  "assignedTo",
  "response",
  "log",
  "parentWishId",
  "targetStep",
  "humanInput",
  "humanInputAt",
  "dismissed",
]);

async function readText(path: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(path);
  } catch {
    return null;
  }
}

export async function parseFabric(
  loomFilesDir: string,
  tmpDir: string,
): Promise<FabricState> {
  const fabricDir = `${loomFilesDir}/.Fabric`;
  const [wishesSrc, statusSrc, postmortemsSrc, healthSrc, dispatchSrc] = await Promise.all([
    readText(`${fabricDir}/wishes.md`),
    readText(`${fabricDir}/status.md`),
    readText(`${fabricDir}/wish-postmortems.jsonl`),
    readText(`${tmpDir}/fabric-loom-daemon-health.json`),
    readText(`${tmpDir}/fabric-loom-dispatch-status.json`),
  ]);

  const needsYou = await readNeedsYouReports(`${fabricDir}/needs-you-reports`);

  return {
    wishes: parseWishes(wishesSrc ?? ""),
    active: parseActiveSessions(statusSrc ?? ""),
    lastSeen: parseLastSeen(statusSrc ?? ""),
    postmortems: parsePostmortems(postmortemsSrc ?? ""),
    needsYou,
    daemon: parseDaemonHealth(healthSrc),
    dispatch: parseDispatchStatus(dispatchSrc),
    generatedAt: new Date().toISOString(),
  };
}

export function parseWishes(src: string): Wish[] {
  if (!src) return [];
  const wishes: Wish[] = [];
  let section: "pending" | "processed" = "processed";
  const lines = src.split("\n");

  // Find wish block starts: lines beginning with "### W-<number>"
  const blockStarts: { idx: number; id: string; section: "pending" | "processed" }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^## Pending\b/.test(line)) section = "pending";
    else if (/^## Processed\b/.test(line)) section = "processed";
    const m = line.match(/^### (W-\d+)\b/);
    if (m) blockStarts.push({ idx: i, id: m[1], section });
  }

  for (let b = 0; b < blockStarts.length; b++) {
    const start = blockStarts[b];
    const end = b + 1 < blockStarts.length ? blockStarts[b + 1].idx : lines.length;
    const blockLines = lines.slice(start.idx + 1, end);
    const fields = parseWishFields(blockLines);

    const wish: Wish = {
      id: start.id,
      target: fields.get("target") ?? "other",
      status: normalizeStatus(fields.get("status"), fields.get("dismissed")),
      statusSince: fields.get("statusSince"),
      createdAt: fields.get("createdAt"),
      assignedTo: fields.get("assignedTo"),
      text: cleanWishText(fields.get("text") ?? ""),
      response: fields.get("response"),
      log: fields.get("log"),
      sourceFile: fields.get("sourceFile"),
      dismissed: fields.get("dismissed") === "true",
      section: start.section,
    };
    wishes.push(wish);
  }
  return wishes;
}

// Tolerant field parser. Known-field bullets start a new field; unknown bullets
// (e.g. auto-attached "Related context" items) are kept as continuation of the
// current field's value. Raw markers like "---" are discarded.
function parseWishFields(blockLines: string[]): Map<string, string> {
  const fields = new Map<string, string>();
  let currentKey: string | null = null;
  let buffer: string[] = [];
  const flush = () => {
    if (currentKey) {
      const joined = buffer.join("\n").replace(/\s+$/, "");
      fields.set(currentKey, joined);
    }
    buffer = [];
  };
  for (const rawLine of blockLines) {
    const line = rawLine;
    const fieldMatch = line.match(/^-\s+\*\*(\w+)\*\*:\s?(.*)$/);
    if (fieldMatch && KNOWN_WISH_FIELDS.has(fieldMatch[1])) {
      flush();
      currentKey = fieldMatch[1];
      buffer = [fieldMatch[2]];
    } else if (/^---\s*$/.test(line)) {
      // divider between text and auto-attached context — drop
      continue;
    } else if (currentKey) {
      buffer.push(line);
    }
  }
  flush();
  return fields;
}

function cleanWishText(raw: string): string {
  // Strip auto-attached context blocks that bleed into text
  const stopPatterns = [
    /\n+Related context \(auto-attached\):/i,
    /\n+\*\*Related context/i,
  ];
  let text = raw;
  for (const pat of stopPatterns) {
    const m = text.match(pat);
    if (m && m.index !== undefined) text = text.slice(0, m.index);
  }
  return text.trim();
}

function normalizeStatus(raw: string | undefined, dismissed: string | undefined): WishStatus {
  if (dismissed === "true") return "dismissed";
  if (!raw) return "queued";
  return raw.trim().toLowerCase();
}

export function parseActiveSessions(src: string): ActiveAgent[] {
  return parseMarkdownTableSection(src, "Active Sessions").map((row) => ({
    role: row[0] ?? "",
    startedAt: row[1],
    activity: row[2],
  })).filter((a) => a.role);
}

export function parseLastSeen(src: string): AgentLastSeen[] {
  return parseMarkdownTableSection(src, "Last Seen").map((row) => ({
    role: row[0] ?? "",
    lastActive: row[1],
    status: row[2],
  })).filter((a) => a.role);
}

function parseMarkdownTableSection(src: string, heading: string): string[][] {
  if (!src) return [];
  const lines = src.split("\n");
  const idx = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (idx < 0) return [];
  const rows: string[][] = [];
  let inTable = false;
  for (let i = idx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s/.test(line)) break;
    if (/^\s*\|/.test(line)) {
      // skip header and separator rows
      if (/^\s*\|\s*-+/.test(line)) {
        inTable = true;
        continue;
      }
      if (!inTable) continue; // header
      const cells = line.split("|").slice(1, -1).map((c) => c.trim());
      rows.push(cells);
    } else if (inTable && line.trim() !== "") {
      break;
    }
  }
  return rows;
}

export function parsePostmortems(src: string): Record<string, Postmortem> {
  const out: Record<string, Postmortem> = {};
  if (!src) return out;
  const lines = src.split("\n");
  // Read tail: last ~500 valid entries is plenty for our needs.
  const startIdx = Math.max(0, lines.length - 600);
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const entry = JSON.parse(line);
      if (typeof entry?.wishId !== "string") continue;
      // Later entries win (in case of duplicates).
      out[entry.wishId] = {
        wishId: entry.wishId,
        outcome: entry.outcome ?? "done",
        classification: entry.classification,
        summary: entry.summary,
        rootCause: entry.rootCause,
        qualityScore: entry.qualityScore,
        tags: entry.tags,
        durationMs: entry.durationMs,
        totalTokens: entry.totalTokens,
      };
    } catch {
      // skip malformed line
    }
  }
  return out;
}

function parseDaemonHealth(src: string | null): DaemonHealth | null {
  if (!src) return null;
  try {
    const j = JSON.parse(src);
    const lastPoll = typeof j.last_poll === "string" ? j.last_poll : undefined;
    const ageS = lastPoll ? (Date.now() - new Date(lastPoll).getTime()) / 1000 : Infinity;
    return {
      pid: j.pid,
      uptimeS: j.uptime_s,
      lastPoll,
      pendingActions: j.pending_actions,
      alive: isFinite(ageS) && ageS < 180,
      ageS: isFinite(ageS) ? ageS : -1,
    };
  } catch {
    return null;
  }
}

function parseDispatchStatus(src: string | null): DispatchLaneStatus | null {
  if (!src) return null;
  try {
    const j = JSON.parse(src);
    return {
      lane: j.lane ?? "unknown",
      wishes: j.wishes ?? {},
    };
  } catch {
    return null;
  }
}

async function readNeedsYouReports(dir: string): Promise<NeedsYouReport[]> {
  const out: NeedsYouReport[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (!entry.isFile || !entry.name.endsWith(".md")) continue;
      const m = entry.name.match(/^(\d{4}-\d{2}-\d{2}-\d{6})-wish-ticket-(w-\d+)/i);
      out.push({
        filename: entry.name,
        wishId: m ? m[2].toUpperCase() : undefined,
        createdAt: m ? m[1].replace(/-/g, ":") : undefined,
      });
    }
  } catch {
    // dir missing — leave empty
  }
  return out;
}

// CLI: dump parsed state as JSON for debugging.
if (import.meta.main) {
  const loomFilesDir = Deno.env.get("LOOM_FILES_DIR") ?? "../loom-files";
  const tmpDir = Deno.env.get("LOOM_TMP_DIR") ?? "/tmp";
  const state = await parseFabric(loomFilesDir, tmpDir);
  console.log(JSON.stringify(
    {
      wishCount: state.wishes.length,
      byStatus: countBy(state.wishes, (w) => w.status),
      byTarget: countBy(state.wishes, (w) => w.target),
      bySection: countBy(state.wishes, (w) => w.section),
      active: state.active,
      lastSeen: state.lastSeen,
      postmortemCount: Object.keys(state.postmortems).length,
      needsYouCount: state.needsYou.length,
      daemon: state.daemon,
      dispatchWishes: state.dispatch ? Object.keys(state.dispatch.wishes) : [],
      sampleWish: state.wishes[0],
    },
    null,
    2,
  ));
}

function countBy<T>(arr: T[], key: (x: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of arr) {
    const k = key(item);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}
