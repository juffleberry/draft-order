#!/usr/bin/env node
// generate-history.js — produce history-data.js for the line chart.
// Usage: node generate-history.js [--force]
// Incremental: reuses snapshots already in history-data.js and only simulates
// match counts that don't exist yet. Pass --force to recompute everything.
// Requires Node 18+ (built-in fetch) and write access to the working directory.

const { writeFileSync, existsSync, readFileSync } = require('fs');

const FORCE = process.argv.includes('--force');

// Load existing snapshots (keyed by matchesCompleted) so we can skip re-running them.
function loadExistingSnapshots() {
  if (FORCE || !existsSync('history-data.js')) return new Map();
  try {
    const raw = readFileSync('history-data.js', 'utf8');
    const json = raw.replace(/^\s*window\.HISTORY_DATA\s*=\s*/, '').replace(/;\s*$/, '');
    const data = JSON.parse(json);
    const map = new Map();
    for (const snap of data.snapshots || []) map.set(snap.matchesCompleted, snap);
    return map;
  } catch (err) {
    console.warn('Could not parse existing history-data.js, recomputing all:', err.message);
    return new Map();
  }
}

// ─── FANTASY TEAM ALLOCATIONS ────────────────────────────────────────────────
const FANTASY_TEAMS = {
  'Kurlewis':      ['Iran', 'Egypt', 'Saudi Arabia'],
  'Seamen':        ['Colombia', 'New Zealand', 'Norway'],
  'A&T':           ['Canada', 'Sweden', 'England'],
  'Barons':        ['Spain', 'Türkiye', 'Haiti'],
  'SDs':           ['Portugal', 'Ghana', 'Germany'],
  'Dirty Birds':   ['Ivory Coast', 'Netherlands', 'USA'],
  'Aligators':     ['South Korea', 'Iraq', 'Tunisia'],
  'Dynamics':      ['Qatar', 'Senegal', 'Austria'],
  'SERPION':       ['Jordan', 'Switzerland', 'Australia'],
  'Fishies':       ['Belgium', 'Czechia', 'DR Congo'],
  'Piggies':       ['Uzbekistan', 'Bosnia & Herzegovina', 'France'],
  'Puffins':       ['South Africa', 'Scotland', 'Curaçao'],
  'Ester':         ['Ecuador', 'Mexico', 'Uruguay'],
  'Puddings':      ['Argentina', 'Algeria', 'Brazil'],
  'Leeanacondas':  ['Panama', 'Cabo Verde', 'Japan'],
  'Pat':           ['Morocco', 'Croatia', 'Paraguay'],
};

// ─── TEAM STRENGTHS ──────────────────────────────────────────────────────────
const TEAM_STRENGTH = {
  'Argentina': 1877, 'Spain': 1875, 'France': 1871, 'England': 1828,
  'Portugal': 1768, 'Brazil': 1766, 'Netherlands': 1740, 'Belgium': 1725,
  'Germany': 1715, 'Croatia': 1700, 'Italy': 1685, 'Uruguay': 1670,
  'Colombia': 1655, 'Morocco': 1640, 'USA': 1625, 'Mexico': 1610,
  'Japan': 1600, 'Switzerland': 1590, 'Senegal': 1580, 'Iran': 1570,
  'South Korea': 1560, 'Ecuador': 1550, 'Australia': 1535, 'Austria': 1525,
  'Türkiye': 1515, 'Denmark': 1505, 'Norway': 1500, 'Canada': 1490,
  'Sweden': 1515, 'Ivory Coast': 1533, 'Ghana': 1485, 'Paraguay': 1503,
  'Algeria': 1470, 'Tunisia': 1483, 'Panama': 1541, 'Qatar': 1450,
  'Egypt': 1460, 'Saudi Arabia': 1445, 'Scotland': 1498, 'South Africa': 1430,
  'DR Congo': 1478, 'Bosnia & Herzegovina': 1465, 'Czechia': 1501,
  'Uzbekistan': 1440, 'Jordan': 1430, 'Iraq': 1420, 'New Zealand': 1410,
  'Cabo Verde': 1395, 'Curaçao': 1350, 'Haiti': 1340,
};

const AVG_STRENGTH = Object.values(TEAM_STRENGTH).reduce((a, b) => a + b, 0) / Object.values(TEAM_STRENGTH).length;

function getStrength(team) { return TEAM_STRENGTH[team] || AVG_STRENGTH; }
function goalLambda(team) {
  const ratio = getStrength(team) / AVG_STRENGTH;
  return Math.max(0.3, Math.min(4.0, 1.3 * ratio * ratio * ratio * ratio));
}

// ─── ESPN NAME NORMALIZATION ──────────────────────────────────────────────────
const ESPN_NORMALIZE = {
  'United States': 'USA', 'Bosnia-Herzegovina': 'Bosnia & Herzegovina',
  "Côte d'Ivoire": 'Ivory Coast', 'Korea Republic': 'South Korea',
  'Republic of Korea': 'South Korea', 'Congo DR': 'DR Congo',
  'Cape Verde': 'Cabo Verde', 'Curacao': 'Curaçao', 'Turkey': 'Türkiye',
  'Czech Republic': 'Czechia', 'DR Congo': 'DR Congo',
};
function normalize(name) { return ESPN_NORMALIZE[name] || name; }

// ─── SEEDED PRNG (mulberry32) ─────────────────────────────────────────────────
let _rngState = 1;
function seedRng(seed) { _rngState = seed >>> 0 || 1; }
function rng() {
  _rngState |= 0;
  _rngState = _rngState + 0x6D2B79F5 | 0;
  let t = Math.imul(_rngState ^ _rngState >>> 15, 1 | _rngState);
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
  return ((t ^ t >>> 14) >>> 0) / 4294967296;
}

// ─── STAGE ENUM ───────────────────────────────────────────────────────────────
const STAGE = {
  GROUP_ELIMINATED: 0, R32_ELIMINATED: 1, R16_ELIMINATED: 2,
  QF_ELIMINATED: 3, SF_LOST_3RD: 4, SF_WON_3RD: 5, RUNNER_UP: 6, WINNER: 7,
};

// ─── ROUND DETECTION ─────────────────────────────────────────────────────────
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
  if (date >= '2026-07-19') return 'FINAL';
  if (date >= '2026-07-18') return 'THIRD';
  if (date >= '2026-07-14') return 'SF';
  if (date >= '2026-07-09') return 'QF';
  if (date >= '2026-07-04') return 'R16';
  if (date >= '2026-06-28') return 'R32';
  return 'GROUP';
}

// ─── STATE PARSING ────────────────────────────────────────────────────────────
function parseTournamentState(events) {
  const groupStandings = {}, groupTeams = {}, groupGames = [];
  const allTeamStats = {}, knockoutEliminated = {}, knockoutAlive = new Set();
  const r32Actual = [], koResults = []; // real R32 matchups + completed KO results

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
    const done = comp.status.type.completed;
    const hg = done ? parseInt(c0.score || '0') : null;
    const ag = done ? parseInt(c1.score || '0') : null;
    const homeWin = done ? !!c0.winner : null;
    const awayWin = done ? !!c1.winner : null;

    if (round === 'GROUP') {
      const m = (comp.altGameNote || '').match(/Group ([A-L])/i);
      const group = m ? m[1].toUpperCase() : null;
      if (group) {
        if (!groupTeams[group]) groupTeams[group] = new Set();
        groupTeams[group].add(home); groupTeams[group].add(away);
        if (!groupStandings[group]) groupStandings[group] = {};
        const gs = groupStandings[group];
        if (!gs[home]) gs[home] = { pts: 0, gf: 0, ga: 0, gp: 0 };
        if (!gs[away]) gs[away] = { pts: 0, gf: 0, ga: 0, gp: 0 };
        if (done && hg !== null) {
          gs[home].gp++; gs[away].gp++;
          gs[home].gf += hg; gs[home].ga += ag;
          gs[away].gf += ag; gs[away].ga += hg;
          if (homeWin) { gs[home].pts += 3; }
          else if (awayWin) { gs[away].pts += 3; }
          else { gs[home].pts += 1; gs[away].pts += 1; }
          statsOf(home).gf += hg; statsOf(home).ga += ag;
          statsOf(away).gf += ag; statsOf(away).ga += hg;
        }
      }
      groupGames.push({ home, away, hg, ag, homeWin, awayWin, done, group });
    } else {
      // Capture real R32 matchups (resolved once groups finish) for true seeding.
      if (round === 'R32' && TEAM_STRENGTH[home] && TEAM_STRENGTH[away]) r32Actual.push([home, away]);
      if (done && hg !== null) {
        statsOf(home).gf += hg; statsOf(home).ga += ag;
        statsOf(away).gf += ag; statsOf(away).ga += hg;
        const loser  = homeWin ? away : (awayWin ? home : null);
        const winner = homeWin ? home : (awayWin ? away : null);
        if (winner) koResults.push({ a: home, b: away, winner });
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
           completedCount, r32Actual, koResults, groupsComplete };
}

// ─── SIMULATION ENGINE ────────────────────────────────────────────────────────
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
    const sa = standings[a] || { pts: 0, gf: 0, ga: 0 };
    const sb = standings[b] || { pts: 0, gf: 0, ga: 0 };
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
  // Defensive: if matching was imperfect, drop leftover thirds into any open berth.
  const usedThirds = new Set(berthThird.filter(x => x !== -1).map(i => thirds[i].team));
  const openBerths = berths.filter(b => !assign[b.m]).map(b => b.m);
  thirds.filter(t => !usedThirds.has(t.team)).forEach((t, i) => { if (openBerths[i]) assign[openBerths[i]] = t.team; });
  return assign;
}

// Walk the fixed bracket. `seeded` maps each R32 match (73–88) to [team0, team1].
// `knownWinner` maps a sorted "teamA::teamB" key to the actual winner for already
// completed knockout games (those goals are already in base stats, so we don't
// re-add them). Returns stage assignments for every knockout team.
function simulateBracket(seeded, statsOf, knownWinner) {
  const stage = {}, winner = {}, loser = {};
  const key = (a, b) => [a, b].sort().join('::');
  function play(m, t1, t2) {
    const known = knownWinner[key(t1, t2)];
    if (known) { winner[m] = known; loser[m] = known === t1 ? t2 : t1; return; }
    const hg = poisson(goalLambda(t1)), ag = poisson(goalLambda(t2));
    const s1 = getStrength(t1), s2 = getStrength(t2);
    const t1wins = hg > ag || (hg === ag && rng() < s1 / (s1 + s2));
    winner[m] = t1wins ? t1 : t2; loser[m] = t1wins ? t2 : t1;
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
  return stage;
}
function range(a, b) { const r = []; for (let i = a; i <= b; i++) r.push(i); return r; }

function runOneSimulation(state) {
  const { groupStandings: baseSt, groupTeams, groupGames, allTeamStats, knockoutEliminated, knockoutAlive } = state;
  const st = {};
  for (const [g, teams] of Object.entries(baseSt)) {
    st[g] = {};
    for (const [t, s] of Object.entries(teams)) st[g][t] = { ...s };
  }
  const stats = {};
  for (const [t, s] of Object.entries(allTeamStats)) stats[t] = { ...s };
  function statsOf(t) { if (!stats[t]) stats[t] = { gf: 0, ga: 0 }; return stats[t]; }

  for (const g of groupGames) {
    if (g.done || !g.group) continue;
    const hg = poisson(goalLambda(g.home)), ag = poisson(goalLambda(g.away));
    if (!st[g.group]) st[g.group] = {};
    const gs = st[g.group];
    if (!gs[g.home]) gs[g.home] = { pts: 0, gf: 0, ga: 0, gp: 0 };
    if (!gs[g.away]) gs[g.away] = { pts: 0, gf: 0, ga: 0, gp: 0 };
    gs[g.home].gp++; gs[g.away].gp++;
    gs[g.home].gf += hg; gs[g.home].ga += ag;
    gs[g.away].gf += ag; gs[g.away].ga += hg;
    if (hg > ag) { gs[g.home].pts += 3; }
    else if (ag > hg) { gs[g.away].pts += 3; }
    else { gs[g.home].pts += 1; gs[g.away].pts += 1; }
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
  Object.assign(stage, simulateBracket(seeded, statsOf, knownWinner));

  return { stage, stats };
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
      return rng() - 0.5;
    })
    .map(s => s.team);
}

function runMonteCarlo(state, N = 10000) {
  // Fixed seed (NOT tied to results): the only thing that should move the numbers
  // between snapshots is new match results, never Monte Carlo resampling noise.
  // index.html must use this SAME constant so the live grid reconciles with the chart.
  seedRng(20260611);
  const teams = Object.keys(FANTASY_TEAMS);
  const counts = {};
  for (const t of teams) counts[t] = new Array(16).fill(0);
  const orderCounts = {};

  for (let i = 0; i < N; i++) {
    const { stage, stats } = runOneSimulation(state);
    const ranked = rankFantasyTeams(stage, stats);
    ranked.forEach((team, idx) => counts[team][idx]++);
    const key = ranked.join('|');
    orderCounts[key] = (orderCounts[key] || 0) + 1;
  }

  const probs = {}, adp = {};
  for (const t of teams) {
    probs[t] = counts[t].map(c => parseFloat(((c / N) * 100).toFixed(2)));
    adp[t] = parseFloat((counts[t].reduce((sum, c, i) => sum + c * (i + 1), 0) / N).toFixed(3));
  }

  // Most common full draft orders. Ties (equal frequency) are broken by smallest
  // total absolute deviation from ADP — the ordering closest to expectation ranks first.
  const deviation = order => order.reduce((sum, t, i) => sum + Math.abs((i + 1) - adp[t]), 0);
  const topOrders = Object.entries(orderCounts)
    .map(([key, cnt]) => ({ order: key.split('|'), cnt }))
    .sort((a, b) => b.cnt - a.cnt || deviation(a.order) - deviation(b.order))
    .slice(0, 10)
    .map(({ order, cnt }) => ({ order, pct: parseFloat(((cnt / N) * 100).toFixed(2)) }));

  return { probs, adp, topOrders };
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('Fetching match data from ESPN…');
  const url = 'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=20260611-20260719&limit=200';
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ESPN API ${res.status}`);
  const data = await res.json();
  const events = data.events || [];

  // Sort completed events by date to establish canonical match order
  const completedEvents = events
    .filter(e => e.competitions[0]?.status?.type?.completed)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const existing = loadExistingSnapshots();
  console.log(`Total events: ${events.length}, completed: ${completedEvents.length}`);
  const toRun = [];
  for (let k = 0; k <= completedEvents.length; k++) {
    if (!existing.has(k)) toRun.push(k);
  }
  console.log(`Existing snapshots: ${existing.size}, to compute: ${toRun.length} (${toRun.join(', ') || 'none'})\n`);

  const completedIds = new Set();
  const snapshots = [];

  for (let k = 0; k <= completedEvents.length; k++) {
    if (k > 0) completedIds.add(completedEvents[k - 1].id);

    // Reuse an already-computed snapshot for this match count
    if (existing.has(k)) {
      snapshots.push(existing.get(k));
      continue;
    }

    // Build modified events: only the first k completed ones are marked done
    const modifiedEvents = events.map(e => {
      const comp = e.competitions[0];
      if (!comp) return e;
      const wasDone = comp.status.type.completed;
      const shouldBeDone = wasDone && completedIds.has(e.id);
      if (wasDone === shouldBeDone) return e;
      return {
        ...e,
        competitions: [{
          ...comp,
          status: {
            ...comp.status,
            type: { ...comp.status.type, completed: shouldBeDone },
          },
        }],
      };
    });

    const state = parseTournamentState(modifiedEvents);
    const { probs, adp, topOrders } = runMonteCarlo(state, 10000);
    snapshots.push({ matchesCompleted: k, probs, adp, topOrders });

    process.stdout.write(`\r  computed snapshot ${k}/${completedEvents.length}`);
  }

  console.log('\n\nWriting history-data.js…');
  // Match metadata for the UI's annotation chips/tooltips: matches[k-1] is the
  // result that moved snapshot k-1 → k. Presentation-only — does not affect the
  // model, so existing snapshots stay valid (no --force needed).
  const matches = completedEvents.map(e => {
    const comp = e.competitions[0];
    const home = comp.competitors.find(c => c.homeAway === 'home') || comp.competitors[0];
    const away = comp.competitors.find(c => c.homeAway === 'away') || comp.competitors[1];
    return {
      home: normalize(home?.team?.displayName || '?'),
      away: normalize(away?.team?.displayName || '?'),
      hs: parseInt(home?.score, 10) || 0,
      as: parseInt(away?.score, 10) || 0,
    };
  });
  const output = {
    generated: new Date().toISOString(),
    totalMatches: completedEvents.length,
    matches,
    snapshots,
  };
  writeFileSync('history-data.js', `window.HISTORY_DATA = ${JSON.stringify(output)};`);
  console.log(`Done. ${snapshots.length} snapshots written.`);
}

if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1); });
}

module.exports = { parseTournamentState, runOneSimulation, runMonteCarlo, rankFantasyTeams,
                   matchThirds, simulateBracket, R32_SLOTS, THIRD_BERTHS, FEEDERS, GROUP_LETTERS, STAGE };
