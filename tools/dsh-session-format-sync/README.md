# dsh-session-format-sync

DSH (DeepSeek Harness) plugin that keeps the standalone
[`dsh-session-format`](https://github.com/Chinesezjc/dsh-session-format) repo in
sync with the `session-format` package in the deepseek-harness source tree.

## Why

The session-format work lives as stack #3200 in deepseek-harness (7 PRs:
core, operations, persistence, blob segments, file store, repository,
projection). While that stack waits for review and merge, the standalone repo
mirrors the package content so development can continue freely. This plugin
automates the mirror.

## Tools

- `sf_extract` — copy the latest package content (`src`, `tests`, READMEs)
  from the deepseek-harness tree into the standalone repo, and re-apply the
  standalone adaptation layer (see below).
- `sf_verify` — run the standalone gates: `tsc -b` and `vitest run`.
- `sf_sync` — full loop: extract → adapt → verify → commit → push.

Both `sf_extract` and `sf_sync` accept `source` (deepseek-harness checkout
root, default `~/deepseek-harness`) and `target` (standalone repo checkout
root, default `~/dsh-session-format`). `sf_sync` also accepts `message` for
the commit.

## Standalone adaptation

The npm releases of `@deepseek-ai/dsh-session` and
`@deepseek-ai/dsh-atomic-write` do not carry two APIs the stack added:
`EventId` (a brand living in the session spine) and
`writeFileAtomicDurable`. The standalone repo owns both locally:

- `src/event-id.ts` — `EventId` brand type and constructor.
- `src/atomic-write.ts` — `writeFileAtomicDurable` (temp file + fsync +
  atomic rename + directory fsync).

`sf_extract`/`sf_sync` re-apply the import rewrites after every copy
(`src/index.ts` and `src/file-store.ts` point at the local files), so a sync
never leaves the tree importing the npm packages that lack these APIs.

## Install

The plugin is a Cordis plugin mounted through `cordis.patch.yml`
(`dsh.bundle.patch`). From the plugin directory:

```sh
dsh plugin --profile web add dsh-session-format-sync
```

or mount the bundle patch in a profile overlay.
