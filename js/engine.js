// ─── SIMULATION ENGINE ──────────────────────────────────────────────────────
// NOTE (dual-engine sync): this engine is duplicated in generate-history.js
// (Node, used by CI to build history-data.js). Any model change here MUST be
// mirrored there and `node generate-history.js --force` re-run, or the history
// chart will disagree with the live grid. See memory/dual-engine-sync.md.

// ─── SEEDED PRNG (mulberry32) ────────────────────────────────────────────────
let _rngState = 1;
function seedRng(seed) {
  _rngState = seed >>> 0 || 1;
}
function rng() {
  _rngState |= 0;
  _rngState = _rngState + 0x6D2B79F5 | 0;
  let t = Math.imul(_rngState ^ _rngState >>> 15, 1 | _rngState);
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
  return ((t ^ t >>> 14) >>> 0) / 4294967296;
}

// ─── STAGE ENUM ─────────────────────────────────────────────────────────────
const STAGE = {
  GROUP_ELIMINATED: 0,
  R32_ELIMINATED:   1,
  R16_ELIMINATED:   2,
  QF_ELIMINATED:    3,
  SF_LOST_3RD:      4,
  SF_WON_3RD:       5,
  RUNNER_UP:        6,
  WINNER:           7,
};

const STAGE_LABEL = {
  0: 'Group Out',
  1: 'R32 Out',
  2: 'R16 Out',
  3: 'QF Out',
  4: '4th Place',
  5: '3rd Place',
  6: 'Runner-up',
  7: 'Winner',
};

// ─── ROUND DETECTION ────────────────────────────────────────────────────────
function parseRound(event) {
  const note = (event.competitions[0]?.altGameNote || '').toLowerCase();
  const date = event.date.substring(0, 10);

  if (note.includes('group'))                                     return 'GROUP';
  if (note.includes('round of 32'))                              return 'R32';
  if (note.includes('round of 16') || note.includes('rd of 16')) return 'R16';
  if (note.includes('quarterfinal') || note.includes('quarter')) return 'QF';
  if (note.includes('third') || note.includes('3rd'))            return 'THIRD';
  if (note.includes('semifinal') || note.includes('semi'))       return 'SF';
  if (note.includes('final'))                                     return 'FINAL';

  // Date-based fallback
  if (date >= '2026-07-19') return 'FINAL';
  if (date >= '2026-07-18') return 'THIRD';
  if (date >= '2026-07-14') return 'SF';
  if (date >= '2026-07-09') return 'QF';
  if (date >= '2026-07-04') return 'R16';
  if (date >= '2026-06-28') return 'R32';
  return 'GROUP';
}

// ─── DATA FETCHING ───────────────────────────────────────────────────────────
async function fetchAllGames() {
  const url = 'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=20260611-20260719&limit=200';
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ESPN API ${res.status}`);
  const data = await res.json();
  return data.events || [];
}

// ─── STATE PARSING ───────────────────────────────────────────────────────────
function parseTournamentState(events) {
  const groupStandings = {};   // group → { team → { pts, gf, ga, gp } }
  const groupTeams = {};       // group → Set of team names
  const groupGames = [];       // all group-stage game objects
  const allTeamStats = {};     // team → { gf, ga } (real stats from completed games)
  const knockoutEliminated = {};  // team → STAGE value (for completed knockout)
  const knockoutAlive = new Set(); // teams known to have won a knockout game
  const r32Actual = [], koResults = []; // real R32 matchups + completed KO results
  const fixtures = []; // { home, away, kickoff (ms epoch), done } for every scheduled game

  function statsOf(name) {
    if (!allTeamStats[name]) allTeamStats[name] = { gf: 0, ga: 0 };
    return allTeamStats[name];
  }

  for (const event of events) {
    const round = parseRound(event);
    const comp = event.competitions[0];
    if (!comp || comp.competitors.length < 2) continue;

    const c0 = comp.competitors[0], c1 = comp.competitors[1];
    const home = normalize(c0.team.displayName);
    const away = normalize(c1.team.displayName);
    // Live shootout state from the play-by-play: every kick is a details entry
    // with shootout:true; scoringPlay marks conversions. Order gives first kicker.
    let pso = null;
    const psoKicks = (comp.details || []).filter(d => d.shootout);
    if (psoKicks.length || comp.status.period >= 5) {
      const isHome = d => `${d.team?.id}` === `${c0.team.id}`;
      pso = {
        hTaken: psoKicks.filter(isHome).length,
        hScored: psoKicks.filter(d => isHome(d) && d.scoringPlay).length,
        aTaken: psoKicks.filter(d => !isHome(d)).length,
        aScored: psoKicks.filter(d => !isHome(d) && d.scoringPlay).length,
        homeFirst: psoKicks.length ? isHome(psoKicks[0]) : true,
      };
    }
    const done = comp.status.type.completed;
    const hg = done ? parseInt(c0.score || '0') : null;
    const ag = done ? parseInt(c1.score || '0') : null;
    const homeWin = done ? !!c0.winner : null;
    const awayWin = done ? !!c1.winner : null;
    fixtures.push({
      home, away, kickoff: Date.parse(event.date), done,
      state: comp.status.type.state,                 // 'pre' | 'in' | 'post'
      hs: c0.score, as: c1.score,                    // current score (live or final)
      clock: comp.status.type.shortDetail,           // e.g. "45'", "HT", "Scheduled"
      round,                                         // 'GROUP' | 'R32' | … (parseRound)
      displayClock: comp.status.displayClock || '',  // elapsed clock while in progress
      period: comp.status.period || 0,               // 1/2 = halves, 3+ = ET, 5 = pens
      pso,                                           // shootout kick state (or null)
    });

    if (round === 'GROUP') {
      const m = (comp.altGameNote || '').match(/Group ([A-L])/i);
      const group = m ? m[1].toUpperCase() : null;

      if (group) {
        if (!groupTeams[group]) groupTeams[group] = new Set();
        groupTeams[group].add(home);
        groupTeams[group].add(away);

        if (!groupStandings[group]) groupStandings[group] = {};
        const gs = groupStandings[group];
        if (!gs[home]) gs[home] = { pts: 0, gf: 0, ga: 0, gp: 0 };
        if (!gs[away]) gs[away] = { pts: 0, gf: 0, ga: 0, gp: 0 };

        if (done && hg !== null) {
          gs[home].gp++; gs[away].gp++;
          gs[home].gf += hg; gs[home].ga += ag;
          gs[away].gf += ag; gs[away].ga += hg;
          if (homeWin)       { gs[home].pts += 3; }
          else if (awayWin)  { gs[away].pts += 3; }
          else               { gs[home].pts += 1; gs[away].pts += 1; }

          statsOf(home).gf += hg; statsOf(home).ga += ag;
          statsOf(away).gf += ag; statsOf(away).ga += hg;
        }
      }
      groupGames.push({ home, away, hg, ag, homeWin, awayWin, done, group });

    } else {
      // Knockout
      // Capture real R32 matchups (resolved once groups finish) for true seeding.
      if (round === 'R32' && TEAM_STRENGTH[home] && TEAM_STRENGTH[away]) r32Actual.push([home, away]);
      if (done && hg !== null) {
        statsOf(home).gf += hg; statsOf(home).ga += ag;
        statsOf(away).gf += ag; statsOf(away).ga += hg;

        const loser  = homeWin ? away : (awayWin ? home : null);
        const winner = homeWin ? home : (awayWin ? away : null);
        if (winner) koResults.push({ a: home, b: away, winner, round });

        if (round === 'FINAL') {
          if (loser)  knockoutEliminated[loser]  = STAGE.RUNNER_UP;
          if (winner) knockoutEliminated[winner] = STAGE.WINNER;
        } else if (round === 'THIRD') {
          if (loser)  knockoutEliminated[loser]  = STAGE.SF_LOST_3RD;
          if (winner) knockoutEliminated[winner] = STAGE.SF_WON_3RD;
        } else {
          const stageMap = { R32: STAGE.R32_ELIMINATED, R16: STAGE.R16_ELIMINATED, QF: STAGE.QF_ELIMINATED, SF: STAGE.SF_LOST_3RD };
          if (loser) knockoutEliminated[loser] = stageMap[round] ?? STAGE.R32_ELIMINATED;
          if (winner && round !== 'SF') knockoutAlive.add(winner);
        }
      }
    }
  }

  const completedCount = events.filter(e => e.competitions[0]?.status?.type?.completed).length;
  const groupsComplete = Object.keys(groupTeams).length === 12 &&
    Object.entries(groupTeams).every(([g, set]) =>
      set.size === 4 && [...set].every(t => (groupStandings[g]?.[t]?.gp ?? 0) >= 3));
  return { groupStandings, groupTeams, groupGames, allTeamStats, knockoutEliminated, knockoutAlive,
           completedCount, r32Actual, koResults, groupsComplete, fixtures };
}

// ─── SIMULATION PRIMITIVES ───────────────────────────────────────────────────
function poisson(lambda) {
  const L = Math.exp(-lambda);
  let k = 0, p = 1;
  do { k++; p *= rng(); } while (p > L);
  return k - 1;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function sortGroup(teams, standings) {
  return [...teams].sort((a, b) => {
    const sa = standings[a] || { pts: 0, gf: 0, ga: 0, gp: 0 };
    const sb = standings[b] || { pts: 0, gf: 0, ga: 0, gp: 0 };
    if (sb.pts !== sa.pts) return sb.pts - sa.pts;
    const gdB = sb.gf - sb.ga, gdA = sa.gf - sa.ga;
    if (gdB !== gdA) return gdB - gdA;
    if (sb.gf !== sa.gf) return sb.gf - sa.gf;
    return rng() - 0.5;
  });
}

// ─── KNOCKOUT BRACKET (FIFA 2026, canonical match numbers 73–104) ───────────────
// Verified against ESPN matchNumber + the official bracket. Each R32 slot is either
// a group position [groupLetter, pos] (pos 0 = winner, 1 = runner-up) or a
// third-place berth { t: [eligible group letters] }. Later rounds reference the
// two feeder match numbers whose winners advance. This is the path-dependency core:
// teams flow through a FIXED tree instead of being re-shuffled each round.
const GROUP_LETTERS = ['A','B','C','D','E','F','G','H','I','J','K','L'];
const R32_SLOTS = {
  73: [['A',1],['B',1]],            74: [['E',0],{t:['A','B','C','D','F']}],
  75: [['F',0],['C',1]],            76: [['C',0],['F',1]],
  77: [['I',0],{t:['C','D','F','G','H']}], 78: [['E',1],['I',1]],
  79: [['A',0],{t:['C','E','F','H','I']}], 80: [['L',0],{t:['E','H','I','J','K']}],
  81: [['D',0],{t:['B','E','F','I','J']}], 82: [['G',0],{t:['A','E','H','I','J']}],
  83: [['K',1],['L',1]],            84: [['H',0],['J',1]],
  85: [['B',0],{t:['E','F','G','I','J']}], 86: [['J',0],['H',1]],
  87: [['K',0],{t:['D','E','I','J','L']}], 88: [['D',1],['G',1]],
};
const THIRD_BERTHS = [74,77,79,80,81,82,85,87]; // R32 matches hosting a third-placed team
const FEEDERS = {
  89:[74,77], 90:[73,75], 91:[76,78], 92:[79,80], 93:[83,84], 94:[81,82], 95:[86,88], 96:[85,87],
  97:[89,90], 98:[93,94], 99:[91,92], 100:[95,96], 101:[97,98], 102:[99,100],
};
const SF_MATCHES = [101,102], FINAL_MATCH = 104, THIRD_PLACE_MATCH = 103;
function range(a, b) { const r = []; for (let i = a; i <= b; i++) r.push(i); return r; }

// Assign the 8 qualifying third-placed teams to the 8 berths, respecting each
// berth's eligible-group set (no group-stage rematch). Bipartite matching with
// randomized order via augmenting paths; any valid perfect matching is fine.
function matchThirds(thirds) {
  const berths = THIRD_BERTHS.map(m => ({ m, set: R32_SLOTS[m][1].t }));
  const order = shuffle(berths.map((_, i) => i));
  const berthThird = new Array(berths.length).fill(-1); // berth idx -> third idx
  function augment(bi, seen) {
    for (let ti = 0; ti < thirds.length; ti++) {
      if (seen[ti] || !berths[bi].set.includes(thirds[ti].group)) continue;
      seen[ti] = true;
      const cur = berthThird.indexOf(ti);
      if (cur === -1 || augment(cur, seen)) { berthThird[bi] = ti; return true; }
    }
    return false;
  }
  for (const bi of order) augment(bi, new Array(thirds.length).fill(false));
  const assign = {};
  berths.forEach((b, i) => { if (berthThird[i] !== -1) assign[b.m] = thirds[berthThird[i]].team; });
  const usedThirds = new Set(berthThird.filter(x => x !== -1).map(i => thirds[i].team));
  const openBerths = berths.filter(b => !assign[b.m]).map(b => b.m);
  thirds.filter(t => !usedThirds.has(t.team)).forEach((t, i) => { if (openBerths[i]) assign[openBerths[i]] = t.team; });
  return assign;
}

// Walk the fixed bracket. `seeded` maps each R32 match (73–88) to [team0, team1].
// `knownWinner` maps a sorted "teamA::teamB" key to the actual winner for already
// completed knockout games (those goals are already in base stats, so we don't
// re-add them). Returns stage assignments for every knockout team, plus the
// outcome of the live-watched game when `live` is set (see runMonteCarlo).
function simulateBracket(seeded, statsOf, knownWinner, live = null) {
  const stage = {}, winner = {}, loser = {};
  let watched = null;
  const key = (a, b) => [a, b].sort().join('::');
  function play(m, t1, t2) {
    const known = knownWinner[key(t1, t2)];
    if (known) { winner[m] = known; loser[m] = known === t1 ? t2 : t1; return; }
    // Live-watched game: keep the goals already on the board and Poisson-simulate
    // only the remaining minutes (λ × remFrac). A level finish falls through to
    // the engine's shootout rule below, same as any other knockout tie.
    const isWatched = live && live.isKO &&
      ((t1 === live.home && t2 === live.away) || (t1 === live.away && t2 === live.home));
    let hg, ag;
    if (isWatched) {
      hg = (t1 === live.home ? live.hg : live.ag) + poisson(goalLambda(t1) * live.remFrac);
      ag = (t2 === live.home ? live.hg : live.ag) + poisson(goalLambda(t2) * live.remFrac);
    } else {
      hg = poisson(goalLambda(t1)); ag = poisson(goalLambda(t2));
    }
    const s1 = getStrength(t1), s2 = getStrength(t2);
    const pens = hg === ag;
    // Tie rule: strength-weighted shootout — unless the watched game's shootout is
    // actually underway, in which case live.pensP is the kick-by-kick win prob.
    const pTie = isWatched && live.pensP != null
      ? (t1 === live.home ? live.pensP : 1 - live.pensP)
      : s1 / (s1 + s2);
    const t1wins = hg > ag || (pens && rng() < pTie);
    winner[m] = t1wins ? t1 : t2; loser[m] = t1wins ? t2 : t1;
    if (isWatched) watched = { outcome: winner[m] === live.home ? 'H' : 'A', pens };
    statsOf(t1).gf += hg; statsOf(t1).ga += ag;
    statsOf(t2).gf += ag; statsOf(t2).ga += hg;
  }
  const ROUND_STAGE = [
    { matches: range(73, 88), elim: STAGE.R32_ELIMINATED },
    { matches: range(89, 96), elim: STAGE.R16_ELIMINATED },
    { matches: range(97, 100), elim: STAGE.QF_ELIMINATED },
  ];
  for (const m of range(73, 88)) play(m, seeded[m][0], seeded[m][1]);
  for (const m of range(89, 100)) play(m, winner[FEEDERS[m][0]], winner[FEEDERS[m][1]]);
  for (const { matches, elim } of ROUND_STAGE) for (const m of matches) stage[loser[m]] = elim;
  for (const m of SF_MATCHES) play(m, winner[FEEDERS[m][0]], winner[FEEDERS[m][1]]);
  play(THIRD_PLACE_MATCH, loser[SF_MATCHES[0]], loser[SF_MATCHES[1]]);
  stage[winner[THIRD_PLACE_MATCH]] = STAGE.SF_WON_3RD;
  stage[loser[THIRD_PLACE_MATCH]] = STAGE.SF_LOST_3RD;
  play(FINAL_MATCH, winner[SF_MATCHES[0]], winner[SF_MATCHES[1]]);
  stage[winner[FINAL_MATCH]] = STAGE.WINNER;
  stage[loser[FINAL_MATCH]] = STAGE.RUNNER_UP;
  return { stage, watched };
}

function runOneSimulation(state, live = null) {
  const { groupStandings: baseSt, groupTeams, groupGames, allTeamStats, knockoutEliminated, knockoutAlive } = state;
  let watched = null; // outcome of the live-watched game in THIS sim ('H'/'D'/'A')

  // Clone group standings
  const st = {};
  for (const [g, teams] of Object.entries(baseSt)) {
    st[g] = {};
    for (const [t, s] of Object.entries(teams)) st[g][t] = { ...s };
  }

  // Clone team stats
  const stats = {};
  for (const [t, s] of Object.entries(allTeamStats)) stats[t] = { ...s };
  function statsOf(t) { if (!stats[t]) stats[t] = { gf: 0, ga: 0 }; return stats[t]; }

  // Simulate remaining group games (a live-watched game keeps its current score
  // and only plays out the remaining minutes — see simulateBracket for knockout)
  for (const g of groupGames) {
    if (g.done || !g.group) continue;
    const isWatched = live && !live.isKO && g.home === live.home && g.away === live.away;
    const hg = isWatched ? live.hg + poisson(goalLambda(g.home) * live.remFrac) : poisson(goalLambda(g.home));
    const ag = isWatched ? live.ag + poisson(goalLambda(g.away) * live.remFrac) : poisson(goalLambda(g.away));
    if (isWatched) watched = { outcome: hg > ag ? 'H' : ag > hg ? 'A' : 'D', pens: false };
    if (!st[g.group]) st[g.group] = {};
    const gs = st[g.group];
    if (!gs[g.home]) gs[g.home] = { pts: 0, gf: 0, ga: 0, gp: 0 };
    if (!gs[g.away]) gs[g.away] = { pts: 0, gf: 0, ga: 0, gp: 0 };
    gs[g.home].gp++; gs[g.away].gp++;
    gs[g.home].gf += hg; gs[g.home].ga += ag;
    gs[g.away].gf += ag; gs[g.away].ga += hg;
    if (hg > ag)      { gs[g.home].pts += 3; }
    else if (ag > hg) { gs[g.away].pts += 3; }
    else              { gs[g.home].pts += 1; gs[g.away].pts += 1; }
    statsOf(g.home).gf += hg; statsOf(g.home).ga += ag;
    statsOf(g.away).gf += ag; statsOf(g.away).ga += hg;
  }

  // ── Final group standings, qualifiers, and eliminated teams ──
  const stage = {};
  const sorted = {};   // group letter -> [1st, 2nd, 3rd, 4th]
  const thirds = [];   // { team, group, pts, gd, gf }
  for (const g of GROUP_LETTERS) {
    const teamSet = groupTeams[g];
    if (!teamSet) continue;
    const ranked = sortGroup([...teamSet], st[g] || {});
    sorted[g] = ranked;
    if (ranked[3]) stage[ranked[3]] = STAGE.GROUP_ELIMINATED;
    if (ranked[2]) {
      const s = (st[g] || {})[ranked[2]] || { pts: 0, gf: 0, ga: 0 };
      thirds.push({ team: ranked[2], group: g, pts: s.pts, gd: s.gf - s.ga, gf: s.gf });
    }
  }
  thirds.sort((a, b) => b.pts - a.pts || b.gd - a.gd || b.gf - a.gf || rng() - 0.5);
  const top8 = thirds.slice(0, 8);
  for (const t of thirds.slice(8)) stage[t.team] = STAGE.GROUP_ELIMINATED; // non-qualifying thirds

  // ── Seed the Round of 32 into the fixed bracket ──
  const seeded = {};
  for (const m of range(73, 88)) {
    seeded[m] = R32_SLOTS[m].map(slot => Array.isArray(slot) ? sorted[slot[0]]?.[slot[1]] : null);
  }
  let thirdAssign = null;
  if (state.groupsComplete && state.r32Actual?.length) {
    // Regime 2: groups final — use the real third-place allocation from ESPN.
    const host = {};
    for (const m of THIRD_BERTHS) { const [g, pos] = R32_SLOTS[m][0]; host[sorted[g]?.[pos]] = m; }
    const a = {};
    for (const [x, y] of state.r32Actual) {
      if (host[x] !== undefined) a[host[x]] = y; else if (host[y] !== undefined) a[host[y]] = x;
    }
    if (THIRD_BERTHS.every(m => a[m])) thirdAssign = a;
  }
  if (!thirdAssign) thirdAssign = matchThirds(top8); // Regime 1: constrained matching
  for (const m of THIRD_BERTHS) seeded[m][1] = thirdAssign[m];

  // ── Already-played knockout games override simulation (goals already in stats) ──
  const knownWinner = {};
  for (const r of (state.koResults || [])) knownWinner[[r.a, r.b].sort().join('::')] = r.winner;

  // ── Walk the fixed bracket (path-dependent) ──
  const bracket = simulateBracket(seeded, statsOf, knownWinner, live);
  Object.assign(stage, bracket.stage);
  if (bracket.watched) watched = bracket.watched;

  return { stage, stats, watched };
}

function rankFantasyTeams(stage, stats) {
  return Object.keys(FANTASY_TEAMS)
    .map(team => {
      const wcTeams = FANTASY_TEAMS[team];
      const stages = wcTeams.map(t => stage[t] ?? STAGE.GROUP_ELIMINATED).sort((a, b) => b - a);
      const totalGF = wcTeams.reduce((s, t) => s + (stats[t]?.gf || 0), 0);
      const totalGA = wcTeams.reduce((s, t) => s + (stats[t]?.ga || 0), 0);
      return { team, stages, totalGF, totalGA };
    })
    .sort((a, b) => {
      for (let i = 0; i < 3; i++) {
        const diff = (b.stages[i] ?? 0) - (a.stages[i] ?? 0);
        if (diff !== 0) return diff;
      }
      if (b.totalGF !== a.totalGF) return b.totalGF - a.totalGF;
      if (a.totalGA !== b.totalGA) return a.totalGA - b.totalGA;
      return rng() - 0.5; // coin flip
    })
    .map(s => s.team);
}

// `live` (optional) marks ONE not-yet-finished game to simulate from its current
// scoreline: { home, away, hg, ag, remFrac, isKO }. Goals already scored stay on
// the board; only λ × remFrac of the match is simulated. Every sim is tagged with
// that game's outcome so the result carries conditional distributions per outcome
// ('H'/'D'/'A', knockout pens resolve to H or A) — this powers the swing meter.
function runMonteCarlo(state, N = 10000, live = null) {
  // Fixed seed (NOT tied to results): the only thing that should move the numbers
  // between snapshots is new match results, never Monte Carlo resampling noise.
  // Must match the constant in generate-history.js so the grid reconciles with the chart.
  seedRng(20260611);
  const teams = Object.keys(FANTASY_TEAMS);
  const counts = {};
  for (const t of teams) counts[t] = new Array(16).fill(0);
  const orderCounts = {};
  const newCond = () => {
    const c = { n: 0, pens: 0, counts: {} };
    for (const t of teams) c.counts[t] = new Array(16).fill(0);
    return c;
  };
  const condTally = live ? { H: newCond(), D: newCond(), A: newCond() } : null;

  for (let i = 0; i < N; i++) {
    const { stage, stats, watched } = runOneSimulation(state, live);
    const ranked = rankFantasyTeams(stage, stats);
    ranked.forEach((team, idx) => counts[team][idx]++);
    if (condTally && watched) {
      const c = condTally[watched.outcome];
      c.n++;
      if (watched.pens) c.pens++;
      ranked.forEach((team, idx) => c.counts[team][idx]++);
    }
    const key = ranked.join('|');
    orderCounts[key] = (orderCounts[key] || 0) + 1;
  }

  const probs = {};
  const adp = {};
  for (const t of teams) {
    probs[t] = counts[t].map(c => (c / N) * 100);
    adp[t] = counts[t].reduce((sum, c, i) => sum + c * (i + 1), 0) / N;
  }

  // Conditional pick distributions per watched-game outcome (share = P(outcome))
  let cond = null;
  if (condTally) {
    cond = {};
    for (const [o, c] of Object.entries(condTally)) {
      if (!c.n) continue;
      const oProbs = {}, oAdp = {};
      for (const t of teams) {
        oProbs[t] = c.counts[t].map(x => (x / c.n) * 100);
        oAdp[t] = c.counts[t].reduce((sum, x, i) => sum + x * (i + 1), 0) / c.n;
      }
      cond[o] = { probs: oProbs, adp: oAdp, share: (c.n / N) * 100, pens: (c.pens / N) * 100 };
    }
  }

  // Most common full draft orders. Ties (equal frequency) are broken by smallest
  // total absolute deviation from ADP — the ordering closest to expectation ranks first.
  const deviation = order => order.reduce((sum, t, i) => sum + Math.abs((i + 1) - adp[t]), 0);
  const topOrders = Object.entries(orderCounts)
    .map(([key, cnt]) => ({ order: key.split('|'), cnt }))
    .sort((a, b) => b.cnt - a.cnt || deviation(a.order) - deviation(b.order))
    .slice(0, 10)
    .map(({ order, cnt }) => ({ order, pct: (cnt / N) * 100 }));

  return { probs, topOrders, adp, cond };
}

// Std deviation of a team's pick distribution, derived from probs (percentages)
// so it works identically for live sims and committed history snapshots.
function pickStdDev(probRow, adpVal) {
  const variance = probRow.reduce((sum, p, i) => sum + (p / 100) * (i + 1) ** 2, 0) - adpVal ** 2;
  return Math.sqrt(Math.max(0, variance));
}

// ─── CURRENT BEST ESTIMATE (deterministic) ──────────────────────────────────
function getBestEstimate(state) {
  // Use current known results, treat all unknowns as "alive" at group level
  const { groupStandings, groupTeams, allTeamStats, knockoutEliminated } = state;
  const stage = { ...knockoutEliminated };

  // For group stage, mark clearly eliminated teams (mathematically out)
  for (const [group, teamSet] of Object.entries(groupTeams)) {
    const sorted = sortGroup([...teamSet], groupStandings[group] || {});
    // Only mark 4th place if all games in group are played
    const gs = groupStandings[group] || {};
    const allPlayed = [...teamSet].every(t => (gs[t]?.gp ?? 0) >= 3);
    if (allPlayed) {
      if (sorted[3] && !stage[sorted[3]]) stage[sorted[3]] = STAGE.GROUP_ELIMINATED;
    }
  }

  // Score fantasy teams on current known results
  return Object.keys(FANTASY_TEAMS).map(team => {
    const wcTeams = FANTASY_TEAMS[team];
    const stages = wcTeams.map(t => stage[t] ?? STAGE.GROUP_ELIMINATED).sort((a, b) => b - a);
    const totalGF = wcTeams.reduce((s, t) => s + (allTeamStats[t]?.gf || 0), 0);
    const totalGA = wcTeams.reduce((s, t) => s + (allTeamStats[t]?.ga || 0), 0);
    return { team, stages, totalGF, totalGA };
  });
}

// ─── CURRENT-STATE DERIVATION (display helpers, no simulation) ───────────────

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// Per-WC-team SETTLED stage from current results: knockout exits plus group-stage
// teams that are mathematically out — 4th in a completed group, or a 3rd-place team
// out of contention for the 8 best-third berths. A team with no entry here is still
// alive (its final placement isn't decided yet).
function computeWcTeamStage(state) {
  const wcTeamStage = { ...state.knockoutEliminated };
  const completedThirds = []; // { team, pts, gd, gf } from fully-played groups
  for (const [group, teamSet] of Object.entries(state.groupTeams)) {
    const gs = state.groupStandings[group] || {};
    const allPlayed = [...teamSet].every(t => (gs[t]?.gp ?? 0) >= 3);
    if (!allPlayed) continue;
    const sorted = sortGroup([...teamSet], gs);
    if (sorted[3] && wcTeamStage[sorted[3]] === undefined) wcTeamStage[sorted[3]] = STAGE.GROUP_ELIMINATED;
    if (sorted[2]) {
      const s = gs[sorted[2]] || { pts: 0, gf: 0, ga: 0 };
      completedThirds.push({ team: sorted[2], pts: s.pts, gd: s.gf - s.ga, gf: s.gf });
    }
  }
  // A 3rd-place team is out of contention once 8+ completed-group thirds rank
  // strictly above it (only 8 thirds advance), regardless of unfinished groups.
  const thirdBetter = (a, b) =>
    a.pts !== b.pts ? a.pts > b.pts : a.gd !== b.gd ? a.gd > b.gd : a.gf > b.gf;
  for (const t of completedThirds) {
    const better = completedThirds.filter(o => o.team !== t.team && thirdBetter(o, t)).length;
    if (better >= 8 && wcTeamStage[t.team] === undefined) wcTeamStage[t.team] = STAGE.GROUP_ELIMINATED;
  }
  return wcTeamStage;
}

// Overall finish-rank (1 = best) for every WC team given the current results.
// Knockout/finished teams rank above all group-stage teams; within the group tier
// teams are ordered by points, then goal difference, then goals scored. Eliminated
// teams read their rank off this table; it refines as more results come in.
function computeFinalRanks(state, wcTeamStage) {
  const teams = new Set();
  for (const set of Object.values(state.groupTeams)) for (const t of set) teams.add(t);
  const gpts = {};
  for (const st of Object.values(state.groupStandings)) for (const [t, s] of Object.entries(st)) gpts[t] = s.pts;
  // Finishing position within the group (0 = 1st … 3 = 4th). Within the group tier
  // this is the primary key, so every 3rd-place team outranks every 4th-place team.
  const groupPos = {};
  for (const [g, teamSet] of Object.entries(state.groupTeams)) {
    sortGroup([...teamSet], state.groupStandings[g] || {}).forEach((t, i) => { groupPos[t] = i; });
  }
  // Only eliminated (settled) teams ever display a rank, so the relative order of
  // still-alive teams doesn't matter — they just all need to outrank every eliminated
  // team. Lumping them at a single high tier means a team knocked out at, say, the R32
  // ranks immediately below the block of teams still in the tournament, even if most of
  // those teams haven't played their next game yet (which would otherwise leave them at
  // group tier and let the eliminated team leapfrog them).
  const ALIVE = 100;
  const tierOf = t => wcTeamStage[t] !== undefined ? wcTeamStage[t] : ALIVE;
  const arr = [...teams].map(t => {
    const s = state.allTeamStats[t] || { gf: 0, ga: 0 };
    return { t, tier: tierOf(t), pos: groupPos[t] ?? 3, pts: gpts[t] ?? 0, gd: s.gf - s.ga, gf: s.gf, ga: s.ga };
  });
  arr.sort((a, b) => {
    if (a.tier !== b.tier) return b.tier - a.tier;
    if (a.tier === 0) {                                        // group tier: position first…
      if (a.pos !== b.pos) return a.pos - b.pos;
      if (a.pts !== b.pts) return b.pts - a.pts;               // …then points
    }
    if (a.gd !== b.gd) return b.gd - a.gd;
    if (a.gf !== b.gf) return b.gf - a.gf;
    if (a.ga !== b.ga) return a.ga - b.ga;
    return a.t < b.t ? -1 : 1;
  });
  const rank = {};
  arr.forEach((x, i) => { rank[x.t] = i + 1; });
  return rank;
}

// A live team is placed in the guaranteed-floor stage of the round it's currently
// playing: the worst finish it can still have. Keyed by the furthest round it has
// WON (winning round R advances it to round R+1, whose loser-floor is the value).
const KO_ROUND_FLOOR = {
  R32: STAGE.R16_ELIMINATED,   // won R32 → in R16, floor = R16 out
  R16: STAGE.QF_ELIMINATED,    // won R16 → in QF,  floor = QF out
  QF:  STAGE.SF_LOST_3RD,      // won QF  → in SF,  floor = 4th
  SF:  STAGE.RUNNER_UP,        // won SF  → in Final, floor = runner-up
};
const KO_ROUND_RANK = { GROUP: 0, R32: 1, R16: 2, QF: 3, SF: 4, THIRD: 4, FINAL: 5 };

// Teams mathematically guaranteed an R32 berth even though the bracket isn't seeded
// yet (their own group is fully played, but other groups aren't — so ESPN hasn't
// published their actual R32 opponent). A team that finished TOP TWO of a completed
// group always advances, regardless of how the rest of the tournament shakes out.
// (Third place only qualifies as one of the 8 best thirds — not knowable until more
// groups finish — so thirds aren't promoted here.)
function computeGuaranteedR32(state) {
  const out = new Set();
  for (const [g, set] of Object.entries(state.groupTeams)) {
    const gs = state.groupStandings[g] || {};
    const teams = [...set];
    if (!teams.every(t => (gs[t]?.gp ?? 0) >= 3)) continue; // group not fully played
    const tup = t => { const s = gs[t] || { pts: 0, gf: 0, ga: 0 }; return [s.pts, s.gf - s.ga, s.gf]; };
    // >0 ⇒ a strictly better than b on pts, then GD, then GF (the deterministic keys).
    const cmp = (a, b) => (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]);
    for (const t of teams) {
      const tt = tup(t);
      // Guaranteed top-2 ⇔ at most one other team is equal-or-better (ties count
      // against, so a genuine lot-drawing tie for 2nd/3rd is NOT treated as locked).
      const notWorse = teams.filter(o => o !== t && cmp(tup(o), tt) >= 0).length;
      if (notWorse <= 1) out.add(t);
    }
  }
  return out;
}

// Per-WC-team display stage: { stage, live }. Settled teams use their finalised
// stage; live teams use the floor of their current round (see KO_ROUND_FLOOR).
function computeWcCurrentStages(state, wcTeamStage) {
  const maxWon = {}; // team → furthest KO round won
  for (const r of (state.koResults || [])) {
    if (!r.winner) continue;
    if (!(r.winner in maxWon) || KO_ROUND_RANK[r.round] > KO_ROUND_RANK[maxWon[r.winner]]) {
      maxWon[r.winner] = r.round;
    }
  }
  const inR32 = new Set();
  for (const [a, b] of (state.r32Actual || [])) { inR32.add(a); inR32.add(b); }
  const guaranteedR32 = computeGuaranteedR32(state);

  const out = {};
  for (const wc of new Set(Object.values(FANTASY_TEAMS).flat())) {
    if (wcTeamStage[wc] !== undefined) { out[wc] = { stage: wcTeamStage[wc], live: false }; continue; }
    const won = maxWon[wc];
    let stage;
    if (won && KO_ROUND_FLOOR[won] !== undefined) stage = KO_ROUND_FLOOR[won];
    else if (inR32.has(wc) || guaranteedR32.has(wc)) stage = STAGE.R32_ELIMINATED; // qualified, awaiting/in R32
    else stage = STAGE.GROUP_ELIMINATED;                  // still in the group stage
    out[wc] = { stage, live: true };
  }
  return out;
}

// WC teams with a not-yet-played fixture kicking off within the next `hours` hours.
function teamsPlayingSoon(state, hours = 24) {
  const soon = new Set();
  const now = Date.now();
  const limit = now + hours * 3600 * 1000;
  for (const f of state?.fixtures || []) {
    if (f.done || !f.kickoff) continue;
    if (f.kickoff >= now && f.kickoff <= limit) { soon.add(f.home); soon.add(f.away); }
  }
  return soon;
}
