---
name: dual-engine-sync
description: The Monte Carlo engine is duplicated in js/engine.js (browser) and generate-history.js (Node); changes must be mirrored and force-regen run
metadata:
  type: project
---

The draft-order simulation engine exists as TWO near-identical copies: the live
in-browser one in `js/engine.js` (plus team data in `js/data.js`) and the Node
one in `generate-history.js`. Any change to the model (group sim, knockout
bracket, seeding, tiebreakers, STAGE logic) MUST be applied identically to both
or the line chart will disagree with the live grid.

**Why:** there is no build step / shared module — the page runs from `file://`
(classic scripts, no ES modules) and `generate-history.js` runs in CI, so they
can't import shared code.

**How to apply:** after a model change, run `node generate-history.js --force` to
recompute every snapshot (the incremental cache is only valid when the model is
unchanged), then verify both the grid and the "Draft Pick Probability Over Time"
chart render with no NaN.

Knockout bracket is the real FIFA 2026 tree (canonical match numbers 73–104),
hardcoded as `R32_SLOTS` / `FEEDERS` / `THIRD_BERTHS` in both files; third-place
berths are filled by constrained bipartite matching (`matchThirds`). ESPN's
`matchNumber` (core API) is the canonical bracket key — NOT event-id order.
