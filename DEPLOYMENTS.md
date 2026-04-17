# Deployments

Live, shareable copies of the loom-viewer demo. The bundle is built from
`dist/loom-viewer-demo.html` via `deno task bundle`.

## Current

| Surface | URL | Notes |
| --- | --- | --- |
| Secret gist (raw) | https://gist.github.com/jkomoros/4b1b8ac76f59009c30d7318e1187a113 | Owner: `jkomoros`. Created 2026-04-17. |
| **Shareable preview** | https://htmlpreview.github.io/?https://gist.githubusercontent.com/jkomoros/4b1b8ac76f59009c30d7318e1187a113/raw/loom-viewer-demo.html | This is the link to send to teammates. |

The gist is "secret" (unlisted), so it's only accessible to people who
have the URL. Anyone with the htmlpreview link can view the demo.

## Updating

```sh
deno task bundle
gh gist edit 4b1b8ac76f59009c30d7318e1187a113 dist/loom-viewer-demo.html
```

The htmlpreview URL keeps working unchanged after edits.

## Rebuilding from scratch

```sh
deno task bundle
gh gist create \
  --desc "loom-viewer demo (synthetic fabric, runs entirely client-side)" \
  dist/loom-viewer-demo.html
# Note the new gist URL and update this file.
```
