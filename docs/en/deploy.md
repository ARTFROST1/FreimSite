# Deploy

This template is built to deploy to **Freim Deploy**, a self-hosted deploy
platform — a "Vercel on your own VPS": Node 22, SQLite, Caddy, and systemd,
no Docker. You point the platform's panel at your git repository, and it
builds and serves the site on your own server. The platform's code lives at
[github.com/ARTFROST1/FreimDeploy](https://github.com/ARTFROST1/FreimDeploy).

Deploying to Freim Deploy isn't required — anything that can run
`npm run build` and serve a static folder (or a Node process) works. But the
repository ships one file specifically for it.

## `frostdeploy.json`

```json
{
  "kind": "static",
  "build": {
    "command": "npm run build",
    "output": "dist",
    "install": "auto"
  },
  "nodeVersion": "22"
}
```

This is the contract the deploy panel reads to know how to build and run
your site:

| Field | Meaning |
| --- | --- |
| `kind` | `"static"` — build once, serve the `dist/` folder. `"node"` — after building, keep a Node process running (needed once you turn on server-side rendering or the API routes for lead forms). |
| `build.command` | Always `npm run build`, not a bare `astro build` — the npm script also runs a `prebuild` step (regenerates `content.schema.json`) and a `postbuild` step (pings IndexNow). Skip the npm script and both silently don't happen. |
| `build.output` | Where the built site ends up (`dist`). |
| `build.install` | How to install dependencies before building. |
| `nodeVersion` | Node version the panel provisions to run the build (matches `.nvmrc`). |

Switch `kind` to `"node"` if you uncomment the Node adapter in
`astro.config.mjs` (needed for the hybrid SSR routes used by the lead-form
pipeline). The rule from the platform's own spec: if a process needs to keep
running after the build finishes, it's `kind: "node"`.

The platform installs dependencies with `npm ci`, the same as CI — this is
one of the reasons the project is built with npm rather than pnpm or yarn:
pnpm doesn't run `postbuild` scripts by default, and a build that skips
`postbuild` never tells search engines it changed.

## Why the filename says "frostdeploy", not "freim-deploy"

You will notice the platform is called **Freim Deploy**, but the manifest
file is `frostdeploy.json`. That's not a leftover from an incomplete rename
— it's deliberate, and permanent.

Freim Deploy used to be called **FrostDeploy**. The rebrand covers
everything a person reads: the panel's interface, its documentation, its
README. It does not cover anything a machine parses: the CLI command
(`frostdeploy`), server paths (`/opt/frostdeploy`, `/etc/frostdeploy`), the
unix account and group, systemd units — and this manifest filename. Servers
already running in the field, installed under the old name, read this exact
filename to check for and apply their own self-updates. Renaming it would
break every one of those deployments silently, with no way to fix it after
the fact.

So `frostdeploy.json` stays `frostdeploy.json`. This is not a bug and not
something to "clean up" in a pull request — it's a compatibility boundary,
and it's permanent by design.

## Environment variables

Everything in `.env.example` — analytics IDs, form endpoints, bot tokens —
is optional for the build itself; the site works with all of it empty. Don't
commit a filled-in `.env`: it isn't tracked by git (see `.gitignore`), and
production values belong wherever your deploy target injects environment
variables at build/run time, not in the repository. `PUBLIC_`-prefixed
variables end up in the browser bundle; everything else stays server-side
and only matters once `kind` is `"node"`.

## What deploying actually does

Push to the branch the panel is watching. The panel pulls the repository,
reads `frostdeploy.json`, installs dependencies, runs `npm run build`, and
serves the result — as a static file tree behind Caddy for `kind: "static"`,
or as a managed, atomically-restarted process for `kind: "node"`. Domains,
HTTPS, and releases are the panel's job; this template only needs to keep
producing a working `npm run build`.

Deeper material lives in Russian: [docs/CONTENT.md](../CONTENT.md).
