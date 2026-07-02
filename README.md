# WC 2026 Fantasy Draft Order

Live draft-order probabilities for a 16-team fantasy league, where each fantasy
team is allocated 3 FIFA World Cup 2026 teams. Draft order is decided by how far
each team's allocation progresses (with goal-based tiebreakers), and the page
estimates every team's chance of landing each pick via Monte Carlo simulation
against live ESPN match data.

## Files

- `index.html` — page shell. Open it directly in a browser; no build step
  (classic scripts only, so `file://` works).
- `styles.css` — broadcast-studio theme.
- `js/data.js` — fantasy allocations, FIFA strengths, flag codes.
- `js/engine.js` — simulation engine (PRNG, ESPN fetch/parsing, real FIFA 2026
  bracket, Monte Carlo). **Duplicated in `generate-history.js` — keep in sync**
  (see `memory/dual-engine-sync.md`).
- `js/ui.js` — chip stage, tickers, heat grid, scorecards, top-10 panel.
- `js/surface.js` — 3D probability surface view.
- `js/history.js` — the "Draft Pick Probability Over Time" Chart.js chart.
- `js/app.js` — state, refresh loop, view wiring.
- `generate-history.js` — Node script that produces `history-data.js` for the
  "Draft Pick Probability Over Time" line chart.
- `history-data.js` — generated data consumed by the chart (sets
  `window.HISTORY_DATA`). Committed to the repo so the page works from `file://`
  and on static hosting without a server.
- `team-allocation.md` — maps each fantasy team to its 3 World Cup teams.
- `assets/teams/` — fantasy team logos.

## The history line chart

The chart shows, for each fantasy team, the probability of receiving a given pick
(tabs Pick 1–16) — or its average draft position (ADP tab) — over time, with the
x-axis being the number of completed matches. Each completed-match count is a
retrospective simulation run (e.g. "as if only the first N matches had been
played"), so the lines trace how the odds evolved across the tournament.

### Regenerating the data

```bash
node generate-history.js          # incremental: only new match counts
node generate-history.js --force  # recompute every snapshot from scratch
```

The script is **incremental**: it loads the existing `history-data.js`, reuses
any snapshot it already has, and only simulates match counts that don't exist
yet. This is valid because completed-match results are final, so the snapshot for
"first N matches played" never changes once those matches are done. Use `--force`
only if you change the simulation model itself.

Requires Node 18+ (built-in `fetch`).

## Deployment & auto-updates (GitHub Pages)

The site is deployed via GitHub Pages. A scheduled GitHub Actions workflow
(`.github/workflows/update-history.yml`) keeps the line-chart data current:

- Runs every 3 hours (and can be triggered manually from the **Actions** tab via
  **Run workflow**).
- Regenerates `history-data.js` incrementally and commits it back to `master`
  **only if new matches have completed** (no empty commits).
- The push triggers the Pages redeploy.

### One-time setup

1. The workflow must live on the **default branch (`master`)** — GitHub only runs
   scheduled workflows from the default branch.
2. In **Settings → Actions → General → Workflow permissions**, ensure
   **Read and write permissions** is enabled so the job can push commits.
3. In **Settings → Pages**, confirm the source. If it's
   **Deploy from a branch: `master`**, the auto-commit redeploys the site
   automatically. If it's **GitHub Actions**, make sure a Pages build workflow
   also runs on push.

### Caveats

- GitHub's cron is best-effort and can be delayed under load; exact timing isn't
  guaranteed (fine during a live tournament).
- Actions disables scheduled workflows after 60 days of repo inactivity.
