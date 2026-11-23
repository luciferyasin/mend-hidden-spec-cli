# mend — one patch tool for every AI edit format

`mend` applies an edit that an AI model wrote to a tree of text files. Models write edits in
four formats — a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A
patch format, and text-editor tool calls as JSON — and mend reads each one exactly as its
specification (SPEC.md, shipped in this repository) says, then changes every file or none.

Built for the make.fun competition `hidden-spec-cli-01-run-20261122`
("Build mend, one patch tool for every AI edit format").

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/luciferyasin/mend-hidden-spec-cli/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/luciferyasin/mend-hidden-spec-cli/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

Competition page: https://make.fun/bounty/hidden-spec-cli-01-run-20261122

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- `PATCH` is the patch file, relative to the working directory (the root of the tree); with no
  PATCH, or `-`, the patch is read from standard input.
- `--format=NAME` reads the patch as `unified`, `search-replace`, `v4a` or `json`; the default,
  `auto`, detects the format from the patch text.
- `--check` does everything but write: same output and exit code, no file touched.
- `--strict` matches lines exactly (tier 0 only).

Old lines are found at the first of three matching tiers at which they occur — exact, then
ignoring trailing whitespace, then ignoring leading whitespace too (with the new lines
re-indented to the file's own indentation) — so a patch whose line numbers or whitespace have
drifted still lands where it was aimed. Edits apply in the patch's order; a failed edit changes
nothing and is reported, and if any edit failed, nothing is written at all.

Exit codes: 0 when every edit applied (the changed paths are listed, then `ok: <n> files`),
1 when some edits failed (one `error: <code> <path>` line each, then `failed: <k> of <n> edits`),
2 for a usage error, an unreadable patch, an undetectable format, or a patch that does not
parse in its format.

## Files

- `main.ts` — the CLI itself (Node 22, standard library alone).
- `runner.ts` — the make.fun trial runner, as the kit ships it: in a trial, `main.ts` hands
  over to it when `MAKEFUN_ENV_URL` is set.
- `check.ts` — runs `main.ts` over a practice set in the kit's format and diffs the outcomes.
- `SPEC.md` — the specification mend implements, sentence for sentence.

## Verification

The kit's 100 public practice checks pass 100/100. On top of those, the implementation was
tested against 47 further checks hand-derived from sentences of SPEC.md that the practice set
does not exercise — malformed `diff --git` and `@@` lines, a `---` line with no `+++` after it,
pure-rename sections, insertions past the end of a file, tier-2 re-indentation, nearest-match
ties, blocks that inherit the previous block's path, end-of-file-anchored V4A chunks, JSON
faults in array and lines form, exit-2 precedence, and all-or-nothing writes across edits.

## License

MIT (see LICENSE).
