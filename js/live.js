// ─── LIVE SWING METER ────────────────────────────────────────────────────────
// For the featured game (the live game, else the next kickoff) app.js runs a
// second, live-aware Monte Carlo: the featured game is simulated FROM its
// current scoreline with the Poisson rate scaled to the minutes remaining
// (λ × remFrac); everything downstream — group tables, bracket, tiebreakers —
// is the normal engine. Each sim is tagged with the featured game's outcome
// (H/D/A; knockout ties resolve via the engine's strength-weighted shootout
// rule s1/(s1+s2), so "pens" is a probability, not a coin toss). The two
// fantasy teams whose conditional ADP swings most between outcomes each get a
// full 16-pick probability line rendered under the Match Center.

const WC_TEAM_SET = new Set(Object.values(FANTASY_TEAMS).flat());

// The single game to feature: a live game if one exists (league assumption:
// only one at a time), else the next not-yet-started fixture.
function pickFeaturedFixture(state) {
  const fx = (state?.fixtures || []).filter(f => WC_TEAM_SET.has(f.home) && WC_TEAM_SET.has(f.away));
  const live = fx.filter(f => f.state === 'in').sort((a, b) => a.kickoff - b.kickoff);
  if (live.length) return live[0];
  const now = Date.now();
  return fx.filter(f => !f.done && f.state === 'pre' && f.kickoff > now)
    .sort((a, b) => a.kickoff - b.kickoff)[0] || null;
}

// Elapsed minute from ESPN clock fields ("63'", "45'+2'", "HT", displayClock).
// Only meaningful while the game is in progress.
function fixtureMinute(f) {
  for (const src of [f.displayClock, f.clock]) {
    const m = /(\d+)/.exec(src || '');
    if (m) return parseInt(m[1]);
  }
  if (/HT/i.test(f.clock || '')) return 45;
  return (f.period || 1) >= 2 ? 45 : 0;
}

// ── Shootout win probability, kick by kick ──────────────────────────────────
// Exact best-of-5 recursion: alternating kicks (order from the play-by-play),
// each converted with probability PEN_CONVERT; a side wins early once its lead
// exceeds the opponent's remaining kicks. Level after 5 each → sudden death,
// resolved with the engine's strength weighting so the model stays consistent.
const PEN_CONVERT = 0.75; // ~World Cup historical conversion rate
function shootoutWinProb(pso, sHome, sAway) {
  const p = PEN_CONVERT;
  function rec(hT, hS, aT, aS) {
    if (hT >= 5 && aT >= 5) {
      if (hS !== aS) return hS > aS ? 1 : 0;
      return sHome / (sHome + sAway); // sudden death
    }
    if (hS > aS + (5 - aT)) return 1; // away can no longer catch up
    if (aS > hS + (5 - hT)) return 0; // home can no longer catch up
    const homeTurn = pso.homeFirst ? hT === aT : hT < aT;
    return homeTurn
      ? p * rec(hT + 1, hS + 1, aT, aS) + (1 - p) * rec(hT + 1, hS, aT, aS)
      : p * rec(hT, hS, aT + 1, aS + 1) + (1 - p) * rec(hT, hS, aT + 1, aS);
  }
  return rec(pso.hTaken, pso.hScored, pso.aTaken, pso.aScored);
}

// Build the `live` spec runMonteCarlo expects. remFrac is "remaining minutes /
// 90" so a full match integrates to the engine's normal λ; extra time (periods
// 3+) extends the same scoring rate out to 120'. A shootout in progress pins
// remFrac to 0 and carries the kick-by-kick win probability instead.
function buildLiveSpec(f) {
  const isKO = !!f.round && f.round !== 'GROUP';
  if (f.state !== 'in') {
    return { home: f.home, away: f.away, hg: 0, ag: 0, remFrac: 1, isKO, inPlay: false };
  }
  const base = {
    home: f.home, away: f.away,
    hg: parseInt(f.hs) || 0, ag: parseInt(f.as) || 0,
    isKO, inPlay: true,
  };
  if (isKO && f.pso && (f.period >= 5 || f.pso.hTaken + f.pso.aTaken > 0)) {
    return { ...base, remFrac: 0, pso: f.pso,
             pensP: shootoutWinProb(f.pso, getStrength(f.home), getStrength(f.away)) };
  }
  const min = fixtureMinute(f);
  const total = isKO && ((f.period || 0) >= 3 || min > 90) ? 120 : 90;
  const remFrac = Math.max(0, (total - Math.min(min, total)) / 90);
  return { ...base, remFrac };
}

// The N fantasy teams whose conditional ADP moves most across the game's outcomes.
function swingTeams(cond, n = 2) {
  const outcomes = Object.values(cond);
  if (outcomes.length < 2) return [];
  return Object.keys(FANTASY_TEAMS)
    .map(team => {
      const adps = outcomes.map(o => o.adp[team]);
      return { team, swing: Math.max(...adps) - Math.min(...adps) };
    })
    .sort((a, b) => b.swing - a.swing)
    .slice(0, n);
}

function swingOutcomeMeta(spec) {
  return {
    H: { flag: spec.home, label: spec.isKO ? `${spec.home} advance` : `${spec.home} win` },
    D: { flag: null,      label: 'Draw' },
    A: { flag: spec.away, label: spec.isKO ? `${spec.away} advance` : `${spec.away} win` },
  };
}

// Featured-match strip: score/clock (live) or kickoff (upcoming) + outcome odds.
// Shared by the mini meter (under the Match Center) and the full-table view.
function swingMatchHtml(fixture, spec, cond) {
  const meta = swingOutcomeMeta(spec);
  const psoBit = spec.pso ? ` <em class="sw-pso">pens ${spec.pso.hScored}–${spec.pso.aScored}</em>` : '';
  const scoreBit = spec.inPlay
    ? `${fixture.home} <strong>${fixture.hs}–${fixture.as}</strong>${psoBit} ${fixture.away}
       <span class="sw-clock">${fixture.clock || 'LIVE'}</span>`
    : `${fixture.home} v ${fixture.away}
       <span class="sw-kick">${new Date(fixture.kickoff).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}</span>`;
  // Knockout advance odds already include shootout wins (a level finish resolves
  // via the engine's strength-weighted pens rule, P = s1/(s1+s2)) — no separate chip.
  const oddsBits = ['H', 'D', 'A']
    .filter(o => cond[o])
    .map(o => `<span class="sw-odd">${flagImg(meta[o].flag) || ''}${meta[o].label} <em>${cond[o].share.toFixed(0)}%</em></span>`);
  return `
    <div class="sw-match">
      <span class="sw-fixture ${spec.inPlay ? 'sw-inplay' : ''}">${flagImg(fixture.home)}<span>${scoreBit}</span>${flagImg(fixture.away)}</span>
      <span class="sw-odds">${spec.inPlay ? 'FROM HERE:' : 'PRE-MATCH:'} ${oddsBits.join('')}</span>
    </div>`;
}

function renderSwingMeter(fixture, spec, result) {
  const wrap = document.querySelector('.swing-meter');
  if (!wrap) return;
  const el = document.getElementById('sw-body');
  const { probs, adp, cond } = result;
  // Needs ≥2 possible outcomes to say anything (e.g. hide once a game is decided)
  if (!cond || Object.keys(cond).length < 2) { wrap.classList.add('hidden'); return; }

  const OUTCOME_META = swingOutcomeMeta(spec);
  const matchHtml = swingMatchHtml(fixture, spec, cond);

  // ── Top-2 swing teams, each with a full 16-pick live probability line ──
  const top = swingTeams(cond, 2);
  const pickHeader = `
    <div class="sw-row sw-head">
      <span class="sw-name"><span class="sw-name-label">PICK →</span></span>
      ${Array.from({ length: 16 }, (_, i) => `<span class="sw-cell sw-cell-head">${i + 1}</span>`).join('')}
      <span class="sw-adp sw-adp-head">ADP</span>
    </div>`;
  const rows = top.map(({ team, swing }) => {
    const cells = probs[team].map((p, i) => {
      const { bg, text } = heatColor(p);
      const condBits = ['H', 'D', 'A'].filter(o => cond[o])
        .map(o => `if ${OUTCOME_META[o].label}: ${cond[o].probs[team][i].toFixed(1)}%`)
        .join(' · ');
      return `<span class="sw-cell" style="background:${bg};color:${text}"
        title="${team} → Pick ${i + 1}: ${p.toFixed(1)}% live (${condBits})">${p >= 0.5 ? p.toFixed(0) : ''}</span>`;
    }).join('');
    return `
      <div class="sw-row">
        <span class="sw-name">${teamLogoImg(team)}<b>${team}</b><span class="sw-swing" title="ADP gap between best and worst outcome of this game">±${swing.toFixed(1)}</span></span>
        ${cells}
        <span class="sw-adp">${adp[team].toFixed(1)}</span>
      </div>`;
  }).join('');

  el.innerHTML = matchHtml + `<div class="sw-grid">${pickHeader}${rows}</div>`;
  wrap.classList.remove('hidden');
}

function hideSwingMeter() {
  document.querySelector('.swing-meter')?.classList.add('hidden');
}

// ─── FULL SWING TABLE (history-section tab: all 16 teams) ────────────────────
// One row per fantasy team: current (live) ADP plus the ADP delta under each
// outcome of the featured game. Negative delta = moves UP the draft order.
// Reads the cached run from app.js (lastSwingRes / lastSwingSpec / lastSwingFixture).
function renderSwingFull() {
  const el = document.getElementById('history-swing');
  if (!el) return;
  const res = lastSwingRes, spec = lastSwingSpec, fixture = lastSwingFixture;
  if (!res?.cond || Object.keys(res.cond).length < 2 || !spec || !fixture) {
    el.innerHTML = '<div class="swf-empty">No live or upcoming game to simulate — the swing meter returns with the next fixture.</div>';
    return;
  }
  const { adp, cond } = res;
  const meta = swingOutcomeMeta(spec);
  const outcomes = ['H', 'D', 'A'].filter(o => cond[o]);

  const ranked = Object.keys(FANTASY_TEAMS)
    .map(team => {
      const adps = outcomes.map(o => cond[o].adp[team]);
      return { team, swing: Math.max(...adps) - Math.min(...adps) };
    })
    .sort((a, b) => b.swing - a.swing);

  const head = `
    <div class="swf-row swf-head">
      <span class="swf-name">TEAM</span>
      <span class="swf-adp">ADP NOW</span>
      ${outcomes.map(o => `<span class="swf-delta">${flagImg(meta[o].flag) || ''}IF ${meta[o].label.toUpperCase()}</span>`).join('')}
      <span class="swf-swing">SWING</span>
    </div>`;

  const deltaCell = (team, o) => {
    const d = cond[o].adp[team] - adp[team];
    const cls = d <= -0.05 ? 'swf-up' : d >= 0.05 ? 'swf-down' : 'swf-flat';
    const arrow = d <= -0.05 ? '▲' : d >= 0.05 ? '▼' : '·';
    return `<span class="swf-delta ${cls}"
      title="${team} if ${meta[o].label}: ADP ${cond[o].adp[team].toFixed(1)} (now ${adp[team].toFixed(1)})">${arrow} ${d > 0 ? '+' : ''}${d.toFixed(1)}</span>`;
  };

  const rows = ranked.map(({ team, swing }, i) => `
    <div class="swf-row ${i < 2 ? 'swf-top' : ''}">
      <span class="swf-name">${teamLogoImg(team)}<b>${team}</b></span>
      <span class="swf-adp">${adp[team].toFixed(1)}</span>
      ${outcomes.map(o => deltaCell(team, o)).join('')}
      <span class="swf-swing">±${swing.toFixed(1)}</span>
    </div>`).join('');

  el.innerHTML = swingMatchHtml(fixture, spec, cond) + `<div class="swf-table">${head}${rows}</div>`;
}
