// Build a single self-contained HTML file that runs the loom-viewer
// in demo mode with zero server. Usable from a static file (gist, S3,
// pages, or just file://). Inlines client.js, affinity.js, demo-data.js
// directly into a <script type="module"> block so there are no fetches
// and no CORS issues.
//
// Output: dist/loom-viewer-demo.html

const ROOT = new URL("../", import.meta.url);
const webDir = new URL("web/", ROOT);

async function read(name: string): Promise<string> {
  return await Deno.readTextFile(new URL(name, webDir));
}

const indexHtml = await read("index.html");
const clientJs = await read("client.js");
const affinityJs = await read("affinity.js");
const demoDataJs = await read("demo-data.js");

// Strip module imports from client.js — we'll inline the dependencies
// in the same module scope, so the named imports are already in scope.
const clientNoImports = clientJs
  .replace(/^\s*import\s+\{[^}]*\}\s+from\s+["']\/affinity\.js["'];?\s*$/m, "")
  .replace(/^\s*import\s+\{[^}]*\}\s+from\s+["']\/demo-data\.js["'];?\s*$/m, "");

// Strip the `export` keyword from the helper modules — once inlined
// they're just local declarations in the same module.
const affinityInlined = affinityJs.replace(/^export\s+/gm, "");
const demoDataInlined = demoDataJs.replace(/^export\s+/gm, "");

// Force demo mode by injecting a query-param shim before client code
// runs. This way even file:// loads (no URLSearchParams support for
// host-relative search) and no-server contexts still trigger demo.
const demoForceShim = `
// Forced demo mode for the standalone bundle.
if (typeof globalThis.location !== "undefined") {
  const sep = (globalThis.location.search || "").includes("?") ? "&" : "?";
  if (!(globalThis.location.search || "").includes("demo")) {
    // Don't actually navigate (would loop); just patch the URLSearchParams
    // call site indirectly via a flag the client checks.
  }
}
window.__LOOM_FORCE_DEMO__ = true;
`;

const bundledScript = [
  demoForceShim,
  affinityInlined,
  demoDataInlined,
  clientNoImports,
].join("\n\n// ---- inlined module boundary ----\n\n");

// Replace the external <script type="module" src="/client.js"></script>
// with the inlined module.
const out = indexHtml.replace(
  /<script\s+type="module"\s+src="\/client\.js"><\/script>/,
  `<script type="module">\n${bundledScript}\n</script>`,
);

// Sanity check
if (!out.includes('type="module"')) {
  console.error("Failed to inject inline module — script tag not found");
  Deno.exit(1);
}

const distDir = new URL("dist/", ROOT);
try {
  await Deno.mkdir(distDir, { recursive: true });
} catch { /* exists */ }

const outPath = new URL("loom-viewer-demo.html", distDir);
await Deno.writeTextFile(outPath, out);
const stat = await Deno.stat(outPath);
console.log(`Wrote ${outPath.pathname} (${(stat.size / 1024).toFixed(1)} KB)`);
