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

## 3. Back up the database (before you switch)

Take a one-off backup while the **old** install is still running. The backup connects to the
configured database, and the embedded Postgres only runs while the server runs
(`scripts/backup-db.sh`):

```sh
paperclipai db:backup            # the installed CLI; from a checkout: pnpm db:backup
# options (cli/src/index.ts): --dir <path>, --retention-days <n>, --filename-prefix <prefix>, --json
```

With no `--dir`, it writes to `database.backup.dir` from the config, or
`~/.paperclip/instances/<instance-id>/data/backups` by default. Note the backup file it prints
before you go on. `paperclipai update` takes the same backup automatically, but the
`install --ref` route in step 5b doesn't, so run it by hand.

## 4. Stop the running install

`releases/v2026.1012.0.md` lists a breaking change: workspace-restore locks are now SQLite
file locks. An old process and a new one must never write to the same instance root at the
same time. Drain and stop every server and worker process that uses the instance before you
start the fork build. Never delete or move the `.lock.sqlite` files under
`<instance root>/locks/directory-merge/`.

- If it runs as the CLI's background service on macOS, the launchd label comes from
  `launchdServiceName` in `cli/src/services/service-manager.ts`:
  `ing.paperclip.paperclipai` for the `default` instance, or
  `ing.paperclip.paperclipai.<instance-id>` for any other. The plist is
  `~/Library/LaunchAgents/<label>.plist` and the service logs are
  `<PAPERCLIP_HOME>/instances/<instance-id>/logs/service.log` and `service.err.log`. The plist
  sets `KeepAlive`, so a plain `kill` respawns the old build. Stop it through the CLI instead:

  ```sh
  paperclipai service status       # supervisor, pid and health
  paperclipai service stop         # launchctl bootout gui/<uid>/<label>
  ```

- **Unverified (Mac):** that the current install actually runs as that service, and which
  instance id it uses. It could also run in a terminal or tmux. Check with
  `paperclipai service status` and `launchctl print gui/$(id -u)/ing.paperclip.paperclipai`
  before you stop anything. If it isn't the service, stop it through whatever started it.

## 5. Run the fork build

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

### 5b. Managed install from a commit (`paperclipai install --ref`)

If the install is the CLI's managed install (the `paperclipai install` store and shim, the one
the background service runs), you can install the fork at an exact commit instead of running
from a checkout. From `cli/src/commands/install.ts`:

```sh
paperclipai install --repo digithings-ai/paperclip --ref <full-commit-sha> --yes
paperclipai --version            # the shim now points at the new payload
```

- `--repo` requires `--ref`, and `--ref` can't be combined with `--canary` or `--version`.
- Use the full 40-character merge commit SHA, so the install is pinned (`channel: "pinned"`)
  and can't drift with a branch.
- The ref is resolved through the GitHub API. The repo is public, so no token is needed; an
  ambient `GH_TOKEN` / `GITHUB_TOKEN` is used if set, to avoid anonymous rate limits.
- `--yes` consents to downloading and running repository code. Without it, the command asks
  in a TTY and fails in a non-interactive shell.
- It flips the managed `current` payload atomically and keeps the previous one. It doesn't
  back up the database (step 3) and doesn't restart the service. Start the service afterwards
  with `paperclipai service start`.
- **Unverified (Mac):** this route wasn't run against the Mac install.

## 6. Verify

```sh
curl -s http://127.0.0.1:3100/api/health    # expect {"status":"ok"}; use your configured host/port
paperclipai service status                  # if it runs as the background service
```

Then check the startup log (for the service: `paperclipai service logs`, or the `service.log`
and `service.err.log` files from step 4). These are the exact messages.

The process must still be running. These must **not** appear:

- `startup heartbeat recovery failed` (only the fail-closed native runner recovery can still
  reach it; if it does, the message before it is
  `startup native runner restart recovery failed closed`);
- `startup decision expiry sweep failed - continuing startup; the scheduler tick retries it`
  (logged instead of exiting, but it means a decision sweep error escaped; report it).

Expected for paused, terminated or pending_approval seats (WARN, one per skipped item, then
a per-pass summary):

- `heartbeat recovery skipped wake for non-invokable agent` with `agentId`, `agentStatus`,
  `reason` and `pass` (`session_goal_recovery` or `session_goal_action_recovery`), then
  `heartbeat recovery pass skipped non-invokable agents`;
- `issue graph liveness backstop skipped dependency wake for non-invokable agent`;
- `task watchdog skipped wake for non-invokable agent`, then
  `task watchdog pass skipped non-invokable agents`;
- `decision continuation skipped for non-invokable origin agent - continuation stays pending`
  with `decisionId`, `agentId` and `reason`, then
  `decision expiry sweep left continuations pending`.

Possible and worth reporting, but not a startup failure:

- `startup heartbeat recovery finished with failed steps` with `failedSteps`, after one
  `startup heartbeat recovery step failed - continuing with the next step` ERROR per step;
- `heartbeat recovery wake failed - continuing with the next item` (for example, a budget
  block) and `heartbeat recovery pass finished with failed items`;
- `decision continuation delivery failed - continuation stays pending`.

The skip lines repeat on each scheduler tick while the seats stay paused. That's expected:
the work stays pending and is delivered once the seat is unpaused.

## Rolling back

1. Stop the fork build.
2. Wait until no process from it is left.
3. Start the previous install the same way it was started before. For the managed install,
   `paperclipai update --rollback` flips back to the retained previous payload and restarts an
   active service. Database migrations aren't reversed; restore the step 3 backup if needed.

The no-concurrent-writers rule in step 4 applies here too.
