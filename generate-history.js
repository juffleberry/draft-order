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
      if (done && hg !== null) {
        statsOf(home).gf += hg; statsOf(home).ga += ag;
        statsOf(away).gf += ag; statsOf(away).ga += hg;
        const loser  = homeWin ? away : (awayWin ? home : null);
        const winner = homeWin ? home : (awayWin ? away : null);
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
  return { groupStandings, groupTeams, groupGames, allTeamStats, knockoutEliminated, knockoutAlive, completedCount };
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

  const qualifiers = new Set();
  const stage = {};
  const thirdCandidates = [];

  for (const [group, teamSet] of Object.entries(groupTeams)) {
    const sorted = sortGroup([...teamSet], st[group] || {});
    if (sorted[0]) qualifiers.add(sorted[0]);
    if (sorted[1]) qualifiers.add(sorted[1]);
    if (sorted[2]) {
      const s = (st[group] || {})[sorted[2]] || { pts: 0, gf: 0, ga: 0 };
      thirdCandidates.push({ team: sorted[2], pts: s.pts, gd: s.gf - s.ga, gf: s.gf });
    }
    if (sorted[3]) stage[sorted[3]] = STAGE.GROUP_ELIMINATED;
  }

  thirdCandidates.sort((a, b) => {
    if (b.pts !== a.pts) return b.pts - a.pts;
    if (b.gd  !== a.gd)  return b.gd  - a.gd;
    if (b.gf  !== a.gf)  return b.gf  - a.gf;
    return rng() - 0.5;
  });
  for (let i = 0; i < thirdCandidates.length; i++) {
    if (i < 8) qualifiers.add(thirdCandidates[i].team);
    else stage[thirdCandidates[i].team] = STAGE.GROUP_ELIMINATED;
  }

  for (const [team, s] of Object.entries(knockoutEliminated)) stage[team] = s;

  const alreadyElim = new Set(Object.keys(knockoutEliminated));
  let alive = [...new Set([...qualifiers, ...knockoutAlive].filter(t => !alreadyElim.has(t)))];

  let sfLosers = [];
  for (const round of ['R32', 'R16', 'QF', 'SF']) {
    if (alive.length < 2) break;
    const pairs = shuffle(alive);
    const winners = [], losers = [];
    for (let i = 0; i + 1 < pairs.length; i += 2) {
      const [t1, t2] = [pairs[i], pairs[i + 1]];
      const hg = poisson(goalLambda(t1)), ag = poisson(goalLambda(t2));
      const s1 = getStrength(t1), s2 = getStrength(t2);
      const t1wins = hg > ag || (hg === ag && rng() < s1 / (s1 + s2));
      winners.push(t1wins ? t1 : t2);
      const loser = t1wins ? t2 : t1;
      losers.push(loser);
      if (!stage[loser]) {
        stage[loser] = { R32: STAGE.R32_ELIMINATED, R16: STAGE.R16_ELIMINATED, QF: STAGE.QF_ELIMINATED, SF: STAGE.SF_LOST_3RD }[round];
      }
      statsOf(t1).gf += hg; statsOf(t1).ga += ag;
      statsOf(t2).gf += ag; statsOf(t2).ga += hg;
    }
    if (round === 'SF') sfLosers = losers;
    alive = winners;
  }

  if (sfLosers.length >= 2) {
    const [l1, l2] = sfLosers;
    const sl1 = getStrength(l1), sl2 = getStrength(l2);
    if (rng() < sl1 / (sl1 + sl2)) { stage[l1] = STAGE.SF_WON_3RD; stage[l2] = STAGE.SF_LOST_3RD; }
    else                             { stage[l2] = STAGE.SF_WON_3RD; stage[l1] = STAGE.SF_LOST_3RD; }
  } else if (sfLosers.length === 1) {
    stage[sfLosers[0]] = STAGE.SF_LOST_3RD;
  }

  if (alive.length >= 2) {
    const [f1, f2] = alive;
    const hg = poisson(goalLambda(f1)), ag = poisson(goalLambda(f2));
    const sf1 = getStrength(f1), sf2 = getStrength(f2);
    const f1wins = hg > ag || (hg === ag && rng() < sf1 / (sf1 + sf2));
    stage[f1wins ? f1 : f2] = STAGE.WINNER;
    stage[f1wins ? f2 : f1] = STAGE.RUNNER_UP;
  } else if (alive.length === 1) {
    stage[alive[0]] = STAGE.WINNER;
  }

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
  seedRng(state.completedCount * 31337);
  const teams = Object.keys(FANTASY_TEAMS);
  const counts = {};
  for (const t of teams) counts[t] = new Array(16).fill(0);

  for (let i = 0; i < N; i++) {
    const { stage, stats } = runOneSimulation(state);
    const ranked = rankFantasyTeams(stage, stats);
    ranked.forEach((team, idx) => counts[team][idx]++);
  }

  const probs = {}, adp = {};
  for (const t of teams) {
    probs[t] = counts[t].map(c => parseFloat(((c / N) * 100).toFixed(2)));
    adp[t] = parseFloat((counts[t].reduce((sum, c, i) => sum + c * (i + 1), 0) / N).toFixed(3));
  }
  return { probs, adp };
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
    const { probs, adp } = runMonteCarlo(state, 10000);
    snapshots.push({ matchesCompleted: k, probs, adp });

    process.stdout.write(`\r  computed snapshot ${k}/${completedEvents.length}`);
  }

  console.log('\n\nWriting history-data.js…');
  const output = {
    generated: new Date().toISOString(),
    totalMatches: completedEvents.length,
    snapshots,
  };
  writeFileSync('history-data.js', `window.HISTORY_DATA = ${JSON.stringify(output)};`);
  console.log(`Done. ${snapshots.length} snapshots written.`);
}

main().catch(err => { console.error(err); process.exit(1); });
