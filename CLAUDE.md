# Draft Order Project

## Fantasy League Rules
16 fantasy teams, each allocated 3 FIFA World Cup 2026 teams.

Draft order is determined by:
1. Furthest team progressed

If tied between two fantasy teams, then tiebreakers are:
2. 2nd best team's progression
3. 3rd best team's progression
4. Most cumulative goals scored across all 3 teams
5. Least cumulative goals conceded across all 3 teams
6. Coin flip

## Files
- `team-allocation.md` — maps each fantasy team to their 3 World Cup teams
- `index.html` — page shell (header, tickers, stage, timeline, matrix sections)
- `styles.css` — broadcast-studio theme (Lions blue #0076B6 accent)
- `js/data.js` — fantasy allocations, FIFA strengths, flag codes, name normalization
- `js/engine.js` — seeded PRNG, ESPN fetch, tournament parsing, real FIFA 2026
  knockout bracket, Monte Carlo simulation. ⚠ DUPLICATED in `generate-history.js`
  (Node/CI) — any model change must be mirrored there and history force-regenerated;
  see `memory/dual-engine-sync.md`
- `js/ui.js` — chip stage + scorecards, tickers, match center, heat grid, top-10 panel
- `js/live.js` — live swing meter: featured-fixture pick, in-game model (goals kept,
  λ × minutes-remaining/90 for the rest), kick-by-kick shootout win prob
  (best-of-5 recursion, 75% conversion, strength-weighted sudden death), mini
  strip renderer + full 16-team ADP-delta table ("Swing Meter" tab, `?hview=swing`)
- `js/surface.js` — 3D probability surface (CSS-3D bar field, drag/zoom)
- `js/history.js` — probability-over-time section, three views (seg-toggle):
  Timeline (ADP bump chart + per-pick P1–16 lines, match-swing annotation chips,
  replay scrubber), Team Flow (per-team stacked P(pick) area), Form Guide (ADP
  sparkline cards). Match metadata comes from HISTORY_DATA.matches with a live
  ESPN fallback via setLiveHistoryMatches()
- `js/app.js` — state, refresh loop, snapshot reconciliation, view/tab wiring
- `generate-history.js` + `history-data.js` + `.github/workflows/update-history.yml`
  — CI pipeline that regenerates the timeline data every 15 min
- `assets/teams/*.png` — fantasy team logos

## UI Spec
- ESPN-broadcast-style "3D sports studio" look: the draft chips are 3D domino
  slabs (front face + edge faces) in a drag/swipe coverflow carousel — click a
  chip, use the arrows, or mouse-wheel/trackpad-scroll over the stage (snaps to
  the nearest chip when idle); default focus is the middle of the order.
  Each chip carries a per-country scorecard (stage rows, pulsing flags for live
  teams, GF/GA)
- Studio set: video-wall triptych looping real international-match GIFs (Tenor
  CDN, playlists rotate per screen — see REEL_PLAYLISTS in js/ui.js), full-width
  lighting truss whose cones are anchored to their fixture cans via a shared
  --x variable, decision desk, podium ring, floor grid, haze
- Scrolling Draft Wire ticker + Match Center strip (live / last-24h results /
  next-24h fixtures)
- Swing Meter strip (gold tag, under Match Center): featured game = live game
  else next kickoff, simulated FROM its current scoreline via `runMonteCarlo`'s
  `live` param (each sim tagged with the game's outcome → conditional pick
  distributions). Shows live advance/win-draw odds and the 2 fantasy teams with
  the biggest conditional-ADP swing, each as a 16-cell probability line. A
  4th history-section tab shows all 16 teams as ADP-now + per-outcome deltas.
  Shootouts react per kick (ESPN play-by-play `details[].shootout`)
- "Draft Pick Probability Over Time" fed by committed history snapshots, three
  views: Timeline (default tab ADP RACE = bump chart of projected draft slot,
  hover dims other ribbons; tabs P1–16 = probability lines) with gold
  match-swing annotation chips (top-6 biggest deltas, flags + score) and a
  play/scrub replay bar that reveals the series up to match K; Team Flow =
  stacked P(pick 1–16) area per fantasy team; Form Guide = 16 ADP sparkline
  cards (click-through to Team Flow)
- Probability matrix has two views: classic 16x16 heat grid (fantasy teams on
  Y, picks 1–16 on X, sort cycles desc→asc→default, expandable team detail rows)
  and a drag-to-rotate 3D surface showing the joint distribution P(team, pick)
  (`?view=grid|surface` overrides the default). In BOTH views, locked picks
  (≥ LOCK_THRESHOLD for one team, via computeLockedPicks in js/ui.js) leave the
  matrix: their row AND pick column are dropped so it only spans still-uncertain
  slots (labels keep real slot numbers), and they're listed in a horizontal
  "Locked Picks" badge strip above each view (shared renderLockStrip in
  js/ui.js). While a game is live the surface
  bars are STACKED vs the at-kickoff baseline: blue = pre-kickoff level, solid
  green extension = probability gained, translucent red ghost = probability lost
  (tooltips show the ±pp delta; baseline = snapshot else one cached plain run)
- Dev/testing: `?mock=H-A@MIN` (e.g. `?mock=2-0@40`) fakes the featured game
  in-play at that score/minute — exercises the whole live pipeline offline
- Monte Carlo: 10,000 runs, FIXED seed 20260611 (must match generate-history.js);
  knockout uses the real FIFA bracket tree, not random pairing
- refresh() source priority: featured game IN PLAY → live-aware run feeds the
  whole page (grid, surface, chips, ticker; footer says so); else committed
  snapshot matching the completed-game count (grid reconciles with the chart
  exactly); else plain run. The live run is cached on score⊕clock⊕pens state
- Live data pulled from ESPN World Cup API, auto-refreshes every 5 min

## Stack
- Vanilla HTML/CSS/JS, no build step, no runtime dependencies — works on
  GitHub Pages or opened directly from disk
- All 3D is CSS 3D transforms (no WebGL), so team logos and text render crisp
  and there are no CORS/texture issues from file://
- Dev preview: `python -m http.server 8347` (see `.claude/launch.json`)
