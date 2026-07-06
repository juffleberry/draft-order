// ─── APP STATE ──────────────────────────────────────────────────────────────
let refreshTimer = null;
let isRunning = false;
let lastProbs = null;
let lastTopOrders = null;
let lastAdp = null;
let orderBannerMode = 'adp'; // 'adp' | 'likely'
let lastEstimate = null;
let lastState = null;
let lastWcTeamStage = null; // settled per-WC-team stages for the current state (scorecards)
let currentSortCol = null;  // 0-15 = sort by that pick, null = unsorted (banner order)
let currentSortDir = null;  // 'desc' = high→low, 'asc' = low→high, null = unsorted
let lastSimCO2ug = null;    // micrograms
let lastSwingKey = null;    // cache key for the swing-meter MC (score/clock/state)
let lastSwingRes = null;    // cached { probs, adp, cond } from the live-aware run
let lastSwingSpec = null;   // live spec of the featured game (renderSwingFull)
let lastSwingFixture = null;// the featured fixture itself (renderSwingFull)
let lastBaselineProbs = null; // at-kickoff distribution (no in-game info)
let lastBaselineKey = null;   // completedCount the baseline was computed for
let lastProbsDelta = null;    // live − baseline, per team per pick (pp); null unless live
// 'grid' | 'surface' — default by screen size, overridable via ?view=grid|surface
let matrixView = new URLSearchParams(location.search).get('view')
  || (window.innerWidth <= 760 ? 'grid' : 'surface');
if (matrixView !== 'grid' && matrixView !== 'surface') matrixView = 'surface';

// ─── DEV MOCK (?mock=H-A@MIN) ───────────────────────────────────────────────
// Simulates the featured (live/next) game at a given score and minute without
// waiting for a real game, e.g. ?mock=2-0@40 or ?mock=2-2@119. Home/away follow
// the real fixture. Shootout states still need console-level mocks.
const mockParam = new URLSearchParams(location.search).get('mock');
if (mockParam && /^\d+-\d+@\d+$/.test(mockParam)) {
  const [, mh, ma, mmin] = mockParam.match(/^(\d+)-(\d+)@(\d+)$/).map(Number);
  const realFetchAllGames = fetchAllGames;
  fetchAllGames = async () => {
    const events = await realFetchAllGames();
    const target = events
      .filter(e => !e.competitions[0]?.status?.type?.completed)
      .sort((x, y) => Date.parse(x.date) - Date.parse(y.date))[0];
    const comp = target?.competitions[0];
    if (comp) {
      comp.status.type.state = 'in';
      comp.status.type.completed = false;
      comp.status.type.shortDetail = `${mmin}'`;
      comp.status.displayClock = `${mmin}'`;
      comp.status.period = mmin > 105 ? 4 : mmin > 90 ? 3 : mmin > 45 ? 2 : 1;
      comp.competitors[0].score = String(mh);
      comp.competitors[1].score = String(ma);
      comp.details = [];
    }
    return events;
  };
}

// ─── VIEW SWITCHING ─────────────────────────────────────────────────────────
function setMatrixView(view) {
  matrixView = view;
  const isSurface = view === 'surface';
  document.getElementById('grid-wrapper').classList.toggle('hidden', isSurface);
  document.getElementById('surface-wrapper').classList.toggle('hidden', !isSurface);
  document.getElementById('reset-view-btn').classList.toggle('hidden', !isSurface);
  document.getElementById('surface-hint').classList.toggle('hidden', !isSurface);
  document.getElementById('tab-surface').classList.toggle('seg-active', isSurface);
  document.getElementById('tab-grid').classList.toggle('seg-active', !isSurface);
  if (isSurface && surfaceDirty && lastProbs) renderSurface(lastProbs, currentSortCol);
}

function setBannerMode(mode) {
  orderBannerMode = mode;
  // Default (unsorted) row order follows the banner mode, so reset any column sort.
  currentSortCol = null;
  currentSortDir = null;
  renderTopOrders(lastTopOrders, lastProbs, lastAdp);
  if (lastProbs) renderGrid(lastProbs, lastEstimate, lastState, currentSortCol);
  markSurfaceDirty();
}

// ─── MAIN REFRESH LOOP ──────────────────────────────────────────────────────
async function refresh() {
  if (isRunning) return;
  isRunning = true;
  const btn = document.getElementById('refresh-btn');
  btn.disabled = true;

  document.getElementById('status').innerHTML = '<span class="spinner"></span>Fetching live data…';

  try {
    const events = await fetchAllGames();
    // Feed completed matches to the history views (annotation chips + tooltips)
    // in case the committed HISTORY_DATA predates the matches field
    setLiveHistoryMatches(events);
    document.getElementById('status').innerHTML = '<span class="spinner"></span>Running Monte Carlo simulation (10,000 runs)…';

    const state = parseTournamentState(events);

    // Run simulation asynchronously so browser can update the status text
    await new Promise(resolve => setTimeout(resolve, 30));

    // ── Featured game + live-aware instrumented run (feeds the swing meter, and
    // when the game is IN PLAY, the whole page). The featured game is simulated
    // from its current scoreline (λ scaled to minutes left; live shootouts use
    // the kick-by-kick pens model). Cached on (results ⊕ score ⊕ clock ⊕ pens).
    lastSimCO2ug = 0;
    const featured = pickFeaturedFixture(state);
    let spec = null;
    if (featured) {
      spec = buildLiveSpec(featured);
      const swingKey = [state.completedCount, spec.home, spec.away, spec.hg, spec.ag,
                        spec.remFrac.toFixed(3), spec.pensP?.toFixed(4) ?? ''].join('|');
      if (swingKey !== lastSwingKey || !lastSwingRes) {
        const t0 = performance.now();
        lastSwingRes = runMonteCarlo(state, 10000, spec);
        lastSimCO2ug += calcSimCO2(performance.now() - t0);
        lastSwingKey = swingKey;
      }
      lastSwingSpec = spec;
      lastSwingFixture = featured;
    } else {
      lastSwingRes = lastSwingSpec = lastSwingFixture = lastSwingKey = null;
    }

    // ── Pick the source for the page-wide numbers ──
    // 1. Featured game in play → the live-aware run (grid/surface/chips/ticker all
    //    move in realtime with the score, clock, and shootout kicks).
    // 2. Committed snapshot covering the current completed-game count → use it, so
    //    the grid is identical to the chart's right-most point BY CONSTRUCTION.
    // 3. Otherwise the instrumented run (for a not-yet-started featured game it's
    //    bit-identical to a plain run: same seed, same λ), or a plain run.
    const snap = (window.HISTORY_DATA?.snapshots || []).find(
      s => s.matchesCompleted === state.completedCount);
    let probs, topOrders, adp, usedSnapshot = false;
    const liveAdjusted = !!(spec?.inPlay && lastSwingRes);
    if (liveAdjusted) {
      ({ probs, topOrders, adp } = lastSwingRes);
    } else if (snap) {
      ({ probs, adp } = snap);
      // topOrders is optional on older snapshots — degrade to the ADP-expected order
      // rather than triggering a full re-simulation just because the field is absent.
      topOrders = snap.topOrders || [{ order: Object.keys(adp).sort((a, b) => adp[a] - adp[b]), pct: 0 }];
      usedSnapshot = true;
    } else if (lastSwingRes) {
      ({ probs, topOrders, adp } = lastSwingRes);
    } else {
      const t0 = performance.now();
      ({ probs, topOrders, adp } = runMonteCarlo(state, 10000));
      lastSimCO2ug += calcSimCO2(performance.now() - t0);
    }
    // ── Delta vs kickoff (3D surface tint) ──
    // Baseline = the distribution with NO in-game info: the committed snapshot when
    // one matches, else one plain run cached per completed-game count.
    if (liveAdjusted) {
      if (snap) {
        lastBaselineProbs = snap.probs;
        lastBaselineKey = state.completedCount;
      } else if (lastBaselineKey !== state.completedCount || !lastBaselineProbs) {
        const t0 = performance.now();
        lastBaselineProbs = runMonteCarlo(state, 10000).probs;
        lastSimCO2ug += calcSimCO2(performance.now() - t0);
        lastBaselineKey = state.completedCount;
      }
      lastProbsDelta = {};
      for (const [t, row] of Object.entries(probs)) {
        lastProbsDelta[t] = row.map((p, i) => p - (lastBaselineProbs?.[t]?.[i] ?? p));
      }
    } else {
      lastProbsDelta = null;
    }

    const currentEstimate = getBestEstimate(state);

    lastProbs = probs;
    lastTopOrders = topOrders;
    lastAdp = adp;
    lastEstimate = currentEstimate;
    lastState = state;
    lastWcTeamStage = computeWcTeamStage(state);
    renderTopOrders(topOrders, probs, adp);
    renderGrid(probs, currentEstimate, state, currentSortCol);
    renderMatchCenter(state);

    // Swing meter strip (mini) + full table tab, fed by the instrumented run above
    if (featured && lastSwingRes) renderSwingMeter(featured, spec, lastSwingRes);
    else hideSwingMeter();
    if (typeof historyView !== 'undefined' && historyView === 'swing') renderSwingFull();

    renderSimCost();
    markSurfaceDirty();
    if (matrixView === 'surface' && surfaceDirty) renderSurface(probs, currentSortCol);

    const now = new Date();
    const pendingGames = events.length - state.completedCount;
    document.getElementById('status').textContent = `Last updated: ${now.toLocaleTimeString()} · ${state.completedCount} of ${events.length} games`;
    document.getElementById('stat-done').textContent = state.completedCount;
    document.getElementById('stat-left').textContent = pendingGames;

    // Warn about any unrecognized team names
    const knownTeams = new Set(Object.values(FANTASY_TEAMS).flat());
    const seenTeams = new Set();
    for (const e of events) {
      const comp = e.competitions?.[0];
      if (!comp) continue;
      for (const c of comp.competitors) seenTeams.add(normalize(c.team.displayName));
    }
    const missing = [...knownTeams].filter(t => !seenTeams.has(t));
    const simInfoEl = document.getElementById('sim-info');
    let infoText = liveAdjusted
      ? `LIVE in-game simulation: ${spec.home} ${spec.hg}–${spec.ag} ${spec.away}${spec.pso ? ` (pens ${spec.pso.hScored}–${spec.pso.aScored})` : ''} factored into every probability on this page · 10,000 runs`
      : usedSnapshot
      ? `Showing committed snapshot for ${state.completedCount} games (matches the history chart exactly) · 10,000-simulation Monte Carlo`
      : `Live Monte Carlo: 10,000 simulations · FIFA ranking-weighted goal model · Strength-weighted penalty shootouts`;
    if (missing.length > 0) {
      infoText += ` · ⚠ Teams not found in ESPN data: ${missing.join(', ')}`;
    }
    simInfoEl.textContent = infoText;

  } catch (err) {
    document.getElementById('status').innerHTML = `<span style="color:#f87171">Error: ${err.message}</span>`;
    console.error(err);
  }

  isRunning = false;
  btn.disabled = false;

  // Schedule next refresh in 5 minutes
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 5 * 60 * 1000);
}

// ─── WIRING ─────────────────────────────────────────────────────────────────
function initApp() {
  document.getElementById('refresh-btn').addEventListener('click', refresh);
  document.getElementById('tab-adp').addEventListener('click', () => setBannerMode('adp'));
  document.getElementById('tab-likely').addEventListener('click', () => setBannerMode('likely'));
  document.getElementById('top10-btn').addEventListener('click', () =>
    document.getElementById('dd-full').classList.toggle('hidden'));
  document.getElementById('tab-grid').addEventListener('click', () => setMatrixView('grid'));
  document.getElementById('tab-surface').addEventListener('click', () => setMatrixView('surface'));
  document.getElementById('reset-view-btn').addEventListener('click', resetSurfaceView);

  bindStageTooltips();
  initCarousel();
  initHighlightReel();
  initSurfaceInteraction();

  // Carousel spacing depends on viewport width — re-pose the slides on resize.
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(layoutCarousel, 150);
  });

  setMatrixView(matrixView);
  resetSurfaceView();
  buildLegend();
  renderSimCost();
  preloadTeamImages();
  buildHistoryTabs();
  loadHistoryData();
  refresh();
}

initApp();
