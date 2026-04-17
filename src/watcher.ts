// Watches fabric sources for changes and emits parsed state snapshots.
// Uses Deno.watchFs for .Fabric/ and a poll loop for /tmp files (fs watch on
// /tmp is flaky on macOS).

import { type FabricState, parseFabric } from "./parser.ts";

export type StateListener = (state: FabricState, prev: FabricState | null) => void;

export interface WatcherOptions {
  loomFilesDir: string;
  tmpDir: string;
  debounceMs?: number;
  tmpPollMs?: number;
}

export class FabricWatcher {
  private readonly opts: Required<WatcherOptions>;
  private readonly listeners = new Set<StateListener>();
  private lastState: FabricState | null = null;
  private debounceTimer: number | null = null;
  private running = false;
  private abortController: AbortController | null = null;

  constructor(opts: WatcherOptions) {
    this.opts = {
      debounceMs: 250,
      tmpPollMs: 2000,
      ...opts,
    };
  }

  onChange(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getState(): FabricState | null {
    return this.lastState;
  }

  async start() {
    if (this.running) return;
    this.running = true;
    this.abortController = new AbortController();

    // Initial snapshot
    await this.reparseAndEmit();

    // Watch .Fabric/ recursively
    const fabricDir = `${this.opts.loomFilesDir}/.Fabric`;
    this.watchFabricDir(fabricDir).catch((err) => {
      console.error(`[watcher] fabric dir watch failed: ${err.message}`);
    });

    // Poll /tmp files
    this.pollTmp().catch((err) => {
      console.error(`[watcher] tmp poll failed: ${err.message}`);
    });
  }

  stop() {
    this.running = false;
    this.abortController?.abort();
    if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
  }

  private async watchFabricDir(dir: string) {
    try {
      const watcher = Deno.watchFs(dir, { recursive: true });
      for await (const _ of watcher) {
        if (!this.running) break;
        this.scheduleReparse();
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") throw err;
    }
  }

  private async pollTmp() {
    let lastFingerprint = await tmpFingerprint(this.opts.tmpDir);
    while (this.running) {
      await sleep(this.opts.tmpPollMs, this.abortController!.signal);
      if (!this.running) break;
      const fp = await tmpFingerprint(this.opts.tmpDir);
      if (fp !== lastFingerprint) {
        lastFingerprint = fp;
        this.scheduleReparse();
      }
    }
  }

  private scheduleReparse() {
    if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.reparseAndEmit().catch((err) => {
        console.error(`[watcher] reparse failed: ${err.message}`);
      });
    }, this.opts.debounceMs);
  }

  private async reparseAndEmit() {
    const state = await parseFabric(this.opts.loomFilesDir, this.opts.tmpDir);
    const prev = this.lastState;
    this.lastState = state;
    for (const listener of this.listeners) {
      try {
        listener(state, prev);
      } catch (err) {
        console.error(`[watcher] listener error: ${(err as Error).message}`);
      }
    }
  }
}

async function tmpFingerprint(tmpDir: string): Promise<string> {
  // Cheap change-detection over the few /tmp files we care about: concatenate
  // their mtimes. Missing files hash to "0".
  const files = ["fabric-loom-daemon-health.json", "fabric-loom-dispatch-status.json"];
  const parts: string[] = [];
  for (const f of files) {
    try {
      const stat = await Deno.stat(`${tmpDir}/${f}`);
      parts.push(`${f}:${stat.mtime?.getTime() ?? 0}`);
    } catch {
      parts.push(`${f}:0`);
    }
  }
  return parts.join("|");
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(), ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}

// Derive which wish-IDs changed between snapshots. Used by the server to send
// minimal deltas over SSE rather than full snapshots on every tick.
export function diffWishes(prev: FabricState | null, next: FabricState): string[] {
  if (!prev) return next.wishes.map((w) => w.id);
  const prevMap = new Map(prev.wishes.map((w) => [w.id, stableStringify(w)]));
  const changed: string[] = [];
  for (const w of next.wishes) {
    if (prevMap.get(w.id) !== stableStringify(w)) changed.push(w.id);
  }
  // Also include removed IDs so the client can drop them
  const nextIds = new Set(next.wishes.map((w) => w.id));
  for (const w of prev.wishes) {
    if (!nextIds.has(w.id)) changed.push(w.id);
  }
  return changed;
}

function stableStringify(obj: unknown): string {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(stableStringify).join(",")}]`;
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  return `{${
    keys.map((k) => `${JSON.stringify(k)}:${stableStringify((obj as Record<string, unknown>)[k])}`)
      .join(",")
  }}`;
}
