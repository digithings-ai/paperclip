# Building the fork from source (2026.1012.0-fork)

This page explains how to build `digithings-ai/paperclip` from source and run it in place of an
installed 2026.1012.0 build. Every command comes from this repo's `package.json` scripts,
`server/package.json`, `scripts/build-npm.sh`, and `cli/src/commands/run.ts`.

Steps that depend on how the Mac install was set up are marked **unverified**. That covers the
install location, the process supervisor, and whether it runs from a checkout or from npm
packages. They were not checked against a running install.

## Prerequisites

- Node `>=24.11.0`, as set by `engines` in the root and server `package.json`.
- pnpm `9.15.4`, as pinned by `packageManager`. Run `corepack enable` and corepack provides that
  version.
- A checkout of the fork on the commit you want to run, for example a reviewed PR head merged
  to `master`.

## 1. Install dependencies

```sh
pnpm install --frozen-lockfile
```

The lockfile must match every workspace `package.json`. If `--frozen-lockfile` fails, the
lockfile is stale. Fix it in a PR rather than installing without `--frozen-lockfile` on the
machine that runs the install.

## 2. Build

From the repo root:

```sh
pnpm build                       # preflight:workspace-links, then `pnpm -r build` for every package
pnpm --filter @paperclipai/server run prepare:ui-dist   # builds ui/ and copies it to server/ui-dist
```

`pnpm -r build` runs each package's own build. The server build (`server/package.json`
`build`) does the following:

1. builds the vendored runner (`prepare:runner-vendor`, which runs the
   `@paperclipai/paperclip-runner` build);
2. checks the runner vendor dependencies;
3. runs `tsc`;
4. copies the onboarding assets, built-ins, service scripts and the runner into `server/dist/`;
5. writes a build stamp (`server/scripts/write-build-stamp.mjs`).

Optional checks before you switch over:

```sh
pnpm typecheck
pnpm test:run:general            # or target the suites you changed with vitest
```

## 3. Stop the running install

`releases/v2026.1012.0.md` lists a breaking change: workspace-restore locks are now SQLite
file locks. An old process and a new one must never write to the same instance root at the
same time. Drain and stop every server and worker process that uses the instance before you
start the fork build. Never delete or move the `.lock.sqlite` files under
`<instance root>/locks/directory-merge/`.

- **Unverified (Mac):** how the current install is supervised. It could be a terminal, tmux, a
  launchd agent, or something else. Stop it through that same mechanism so it doesn't respawn
  the old build.

## 4. Run the fork build

The CLI (`cli/src/commands/run.ts`) tries two places for the server:

1. the dev entry in the checkout, `server/src/index.ts`, through tsx;
2. if that's missing, the installed `@paperclipai/server` package.

From the checkout:

```sh
pnpm paperclipai run             # bootstrap and doctor (with repair), then start the server
# or, to use the compiled server directly:
pnpm --filter @paperclipai/server start   # node server/dist/index.js
```

To keep using the same data, point the build at the same instance. Use the same
`PAPERCLIP_HOME` / `PAPERCLIP_INSTANCE_ID` and the same environment the old install used, as
described in `docs/deploy/local-development.md` and `docs/deploy/environment-variables.md`.

- **Unverified (Mac):** where the existing instance root and its environment live, for example
  `~/.paperclip/...` or a custom `PAPERCLIP_HOME`. Read them from the running install's config
  before you start the fork build. Don't start the fork build against a fresh instance by
  accident.
- **Unverified (Mac):** if the install is a global npm install (`npm i -g paperclipai`), you
  can replace it from the packed build instead of running from the checkout. Run
  `./scripts/build-npm.sh`, then `npm pack` in `cli/` and in `server/`, then
  `npm i -g ./paperclipai-*.tgz ./paperclipai-server-*.tgz`. This route was not tried.
  Running from the checkout is the path these scripts support directly.

## 5. Verify

```sh
curl -s http://127.0.0.1:3100/api/health    # expect {"status":"ok"}; use your configured host/port
```

Then check the startup log:

- No "startup heartbeat recovery failed" exit.
- Any skipped seats show up as `... skipped wake for non-invokable agent` WARN lines.
- Any failed step shows up as one `startup heartbeat recovery finished with failed steps` WARN.

## Rolling back

1. Stop the fork build.
2. Wait until no process from it is left.
3. Start the previous install the same way it was started before.

The no-concurrent-writers rule in step 3 applies here too.
