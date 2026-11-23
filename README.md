[![make.fun](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![make.fun rank](https://make.fun/badge/site-generator-speed-01-run-20261122/Kikuk00/makefun-site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![make.fun reward](https://make.fun/badge/site-generator-speed-01-run-20261122/Kikuk00/makefun-site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

# Swift Site Builder

A faster drop-in for make.fun's own makefun-site 1.0.0: it builds the exact
same static site — the same output tree, byte for byte — in about 2.5x less
CPU time on the kit's practice set (median 240 ms vs the house baseline's
600 ms of solve time over the 3 practice cases).

It is a from-scratch reimplementation of makefun-site's build (front matter,
Markdown subset, template dialect, slug rule, report) in one
dependency-free `solve.js`, written for speed:

- Markdown is lexed and rendered in a single fused pass over the lines (no
  token objects, no second render pass), and the reading-time word count is
  taken in the same pass.
- Inline rendering scans runs of plain text and only touches markup
  characters; HTML escaping is done inline, never one regex call per
  character.
- `slugify` takes an ASCII fast path (no NFKD normalise, no regex) and
  results are cached per run; each tag's slug is computed once.
- Front matter is parsed by hand over the already-split lines, and the body
  is never re-joined and re-split for Markdown.
- Template rendering writes into an output array joined once; each post's
  card is built once and reused by its page.

`main.ts` is the kit's driver (unchanged): it reads every case from
`/input/cases.json`, answers each with `run` from `solve.js`, and writes
`/output/answers.json`. Run: `node main.ts`
(`MAKEFUN_INPUT_DIR` / `MAKEFUN_OUTPUT_DIR` override `/input` / `/output`).
Node 22, built-ins only, deterministic — two runs on the same input produce
byte-identical output.

Verified on the kit's practice set with the kit's own scorer:
`passed: 1, cases_passed: 3/3`. A 180-case differential fuzz run against
makefun-site 1.0.0 (mutated practice cases plus synthetic edge cases:
CRLF, unicode titles, bad front matter, broken templates, self-includes,
duplicate paths, missing layouts) also matched byte for byte.
