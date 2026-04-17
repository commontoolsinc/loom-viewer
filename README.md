# loom-viewer

An optional, alive-feeling viewer for your [Loom](https://github.com/commontoolsinc/loom) fabric.

> *Look at all of this that's happening for me, automatically, while I'm doing other things.*

Run it in a browser tab and leave it open. Threads of warm color accumulate as your agents quietly take care of things. Each completion is a tiny arrival moment — a warm pulse, a few sparkles, a whisper in the corner — *that just happened for you*.

It reads your fabric's files; it never writes to them. Real loom doesn't know it exists.

## Run

```sh
# from this directory
deno task viewer

# or from anywhere
./viewer.sh
```

Opens on `http://localhost:7733`.

## Demo mode

Don't have a Loom fabric to point this at? Open `http://localhost:7733/?demo`
to see the viewer running on a synthetic fabric — ~80 plausible wishes
across all targets, affinity cascades and arrival animations included.
Demo mode also kicks in automatically if the SSE connection fails or no
data arrives within 1.5s, so opening `index.html` directly works too.

## Configure

All optional:

| env var | default | what |
| ------- | ------- | ---- |
| `LOOM_FILES_DIR`   | `../loom-files` | root containing `.Fabric/` |
| `LOOM_VIEWER_PORT` | `7733`          | local port |
| `LOOM_TMP_DIR`     | `/tmp`          | where dispatch sidecars + daemon health live |

## What it reads

- `<LOOM_FILES_DIR>/.Fabric/wishes.md` — the wish ledger
- `<LOOM_FILES_DIR>/.Fabric/status.md` — agent heartbeat
- `<LOOM_FILES_DIR>/.Fabric/wish-postmortems.jsonl` — completion diagnostics
- `<LOOM_FILES_DIR>/.Fabric/needs-you-reports/` — blockers
- `<LOOM_TMP_DIR>/fabric-loom-daemon-health.json` — daemon pulse
- `<LOOM_TMP_DIR>/fabric-loom-dispatch-status.json` — overseer lane state

Missing any of those → the viewer degrades gracefully, still renders what it has.

## What it isn't

- Not a replacement for the Loom UI. That's where you act; this is where you see.
- Not writable. No editing, no dispatching, no triggering.
- Not live-coupled. Files in, pixels out — real loom has no dependency on it.

## Requires

- Deno 1.40+
