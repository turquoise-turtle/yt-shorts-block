# Maintenance harness

Tests Shorts Block against the live YouTube site, works out what broke when YouTube changes its markup or behaviour, proposes the edit, re-tests and commits. It is built so an LLM agent can run the whole loop from a few short commands, reading only a compact summary instead of YouTube's HTML.

Requires Node 22 or later and network access. Dependencies install on first run (`npm ci` in this folder). Every run looks up the latest stable Chrome for Testing and downloads it into `~/.cache/puppeteer` if it is not there yet, so tests always use current Chrome rather than the version puppeteer pins. Set `CHROME_PATH` to test a specific Chrome instead. Offline, the newest cached build is used and the summary says so.

## Agents

The procedure for coding agents lives in one place, the CLI: `node maintain/cli.mjs guide` prints it, so any agent that can run a shell command can follow it. The root `AGENTS.md`, read by Claude Code, Codex, Cursor, pi and most other agents, only tells them to run that command. `GEMINI.md` imports `AGENTS.md` for Gemini CLI, which reads `GEMINI.md` by default.

For an agent that reads neither file, tell it to run `node maintain/cli.mjs guide`. If an agent's shell tool cannot wait for a full check, it can run the check in the background and then `node maintain/cli.mjs summary`. `--json` on `check` and `summary` gives a one-line JSON summary for agents that prefer it.

## Commands

Run from the repository root.

| Command | What it does |
| --- | --- |
| `node maintain/cli.mjs guide` | Prints the step-by-step procedure for agents. |
| `node maintain/cli.mjs summary` | Reprints the last check's summary (also saved as `maintain/out/summary.txt`). |
| `node maintain/cli.mjs check` | Runs all 14 scenarios (about 80 seconds), diagnoses failures, writes `maintain/out/report.md` and prints a short summary that ends with `NEXT:`. Exit code 0 is a pass (warnings allowed), 1 means problems were found, 2 is an environment or harness error. |
| `node maintain/cli.mjs fix auto` | Applies the fixes marked `[auto]`, then re-runs the check. `fix F1,F3` or `fix all` (auto and review) select others. |
| `node maintain/cli.mjs try <scenario> '<selector>'` | Counts what a selector matches on a live page, and says if it would hide the block screen or ordinary videos. |
| `node maintain/cli.mjs outline <scenario> [root]` | Writes a readable one-line-per-element outline of a page region to `maintain/out/`. |
| `node maintain/cli.mjs finish` | After a passing full check: records the baseline, bumps the patch version if extension files changed, updates the README "last checked" date and commits. Never pushes. `--co-author "Name <email>"` adds a trailer; `--dry-run` shows the plan. |
| `node maintain/cli.mjs selftest` | Rewrites the live page the way a YouTube change would (renamed IDs and tags, a new shelf element, renamed navigation events, a new Shorts URL) and checks the diagnosis is right. Run it after changing the harness. |
| `node maintain/cli.mjs record` | Saves the last check's selector counts as the baseline without committing. |

`check --quick` skips the policy variants; `check --only a,b` runs named scenarios. A partial check cannot be finished.

## What is checked

Scenarios open desktop (`www`) and mobile (`m.`, Pixel 5 emulation) pages with a staged copy of the extension: a Short, search results with an in-app click into a Short and Back out, the home page at full and narrow sidebar widths, and a channel page. Policy variants run with a shim in front of `content.js` that stands in for managed policy (`redirect` on; `hide_shorts_in_feeds` off as a positive control for the leak detector).

On each page the harness checks that the content script ran, that the Shorts URL pattern still matches, that the block screen is drawn, that video stays paused, that wheel, keys and swipes do not move to another Short, and that nothing is visible inside the blocked Short or as a Shorts shelf, tab or sidebar entry elsewhere. It also counts every selector in `block.css` and `content.js`.

## How problems are diagnosed

- **Renamed elements.** `baseline.json` records, for each selector, where it matched and a fingerprint of the elements it matched (tag, ID, classes, attributes, parent, text). When a selector stops matching, the harness finds which part of it broke, ranks the elements now on the page by similarity to the fingerprint, and proposes a rewrite that it has verified matches. A broken plain token (a tag, `#id` or `.class`) becomes one rename across the files.
- **New visible elements.** Anything visible inside the blocked Short other than the block screen, and any visible Shorts link or "Shorts" label elsewhere, is a leak. The harness proposes the outermost element that can be hidden safely: never the block screen or its ancestors, and never a box that also holds ordinary videos.
- **Behaviour changes.** A dispatch hook records YouTube's own events, so a failed in-app navigation is reported with the events the site fires now, next to the ones `content.js` listens for. URL, host, pause and input failures are reported with the observed values and a hint naming the code to change.

Fixes are labelled `[auto]` (verified, high similarity), `[review]` (plausible) or `[llm]` (needs reasoning, with an outline file to read). When a page has a rename fix, its other findings wait for the re-check, because a renamed element can make whole containers look like leaks.

## Files

| File | Purpose |
| --- | --- |
| `cli.mjs` | Commands. |
| `lib/inventory.mjs` | Lists what the extension depends on: selectors, URL pattern, events, host matches. |
| `lib/browser.mjs` | Finds the latest Chrome, stages the extension, launches it, hooks events. |
| `lib/scenarios.mjs` | The pages and checks. |
| `lib/probe.js` | Runs inside the page: counts, leaks, fingerprints, similarity, outlines. |
| `lib/analyse.mjs` | Turns results into fixes and issues. |
| `config.json` | Search term, channel, leak-search roots, allowed "Shorts" labels (the search filter chip), timings. |
| `baseline.json` | Selector counts and fingerprints from the last passing check. Committed, so renames can be detected on any machine. |
| `selftest/` | Simulated YouTube changes for `selftest`. |
| `out/` | Reports, screenshots and outlines. Git-ignored. |

Limits: a fresh browser profile has an empty home feed, so the home-page shelf selectors are never exercised; the summary counts selectors that matched nothing anywhere. Real managed policy delivery is not tested, only the shim.
