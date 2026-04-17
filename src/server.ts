// HTTP server: serves the viewer's static assets and streams state updates
// over Server-Sent Events. One process, one port. Read-only — never writes
// to the fabric or to /tmp.

import { FabricWatcher } from "./watcher.ts";
import { type FabricState } from "./parser.ts";

const loomFilesDir = resolvePath(Deno.env.get("LOOM_FILES_DIR") ?? "../loom-files");
const tmpDir = Deno.env.get("LOOM_TMP_DIR") ?? "/tmp";
const port = Number(Deno.env.get("LOOM_VIEWER_PORT") ?? "7733");

const webDir = new URL("../web/", import.meta.url);

const watcher = new FabricWatcher({ loomFilesDir, tmpDir });
await watcher.start();

const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
const encoder = new TextEncoder();

watcher.onChange((state) => {
  broadcast({ type: "snapshot", state });
});

function broadcast(msg: unknown) {
  const payload = encoder.encode(`data: ${JSON.stringify(msg)}\n\n`);
  for (const ctrl of clients) {
    try {
      ctrl.enqueue(payload);
    } catch {
      clients.delete(ctrl);
    }
  }
}

function resolvePath(p: string): string {
  if (p.startsWith("/")) return p;
  // Resolve relative to CWD
  return `${Deno.cwd()}/${p}`.replaceAll(/\/+/g, "/");
}

async function serveStatic(path: string, contentType: string): Promise<Response> {
  try {
    const url = new URL(path, webDir);
    const data = await Deno.readFile(url);
    return new Response(data, {
      headers: {
        "content-type": contentType,
        "cache-control": "no-cache",
      },
    });
  } catch {
    return new Response("Not Found", { status: 404 });
  }
}

function sseResponse(initial: FabricState | null): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      clients.add(controller);
      // Send the current snapshot immediately on connect
      if (initial) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ type: "snapshot", state: initial })}\n\n`),
        );
      }
      // Heartbeat comment every 20s to keep the connection alive
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: heartbeat\n\n`));
        } catch {
          clearInterval(heartbeat);
          clients.delete(controller);
        }
      }, 20000);
      const cleanup = () => {
        clearInterval(heartbeat);
        clients.delete(controller);
      };
      // Close on abort via the stream's cancel
      (controller as unknown as { _cleanup?: () => void })._cleanup = cleanup;
    },
    cancel(this: ReadableStreamDefaultController<Uint8Array>) {
      clients.delete(this);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      "connection": "keep-alive",
    },
  });
}

const handler = async (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  switch (url.pathname) {
    case "/":
      return serveStatic("index.html", "text/html; charset=utf-8");
    case "/client.js":
      return serveStatic("client.js", "text/javascript; charset=utf-8");
    case "/whisper.js":
      return serveStatic("whisper.js", "text/javascript; charset=utf-8");
    case "/events":
      return sseResponse(watcher.getState());
    case "/state.json":
      return new Response(JSON.stringify(watcher.getState(), null, 2), {
        headers: { "content-type": "application/json" },
      });
    default:
      return new Response("Not Found", { status: 404 });
  }
};

console.log(`loom-viewer listening on http://localhost:${port}`);
console.log(`  watching ${loomFilesDir}/.Fabric/ + ${tmpDir}/fabric-loom-*.json`);

Deno.serve({ port, onListen: () => {} }, handler);
