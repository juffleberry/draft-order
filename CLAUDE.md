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

## UI Spec
- 16x16 grid: fantasy teams on Y axis, draft picks 1–16 on X axis
- Each cell = % chance that fantasy team receives that pick
- Probabilities calculated via Monte Carlo simulation
- Live data pulled from World Cup API, updates dynamically as tournament progresses

## Stack
- TBD by Claude Code — propose before building
