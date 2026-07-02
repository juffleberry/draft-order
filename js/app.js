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
// 'grid' | 'surface' — default by screen size, overridable via ?view=grid|surface
let matrixView = new URLSearchParams(location.search).get('view')
  || (window.innerWidth <= 760 ? 'grid' : 'surface');
if (matrixView !== 'grid' && matrixView !== 'surface') matrixView = 'surface';

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
    document.getElementById('status').innerHTML = '<span class="spinner"></span>Running Monte Carlo simulation (10,000 runs)…';

    const state = parseTournamentState(events);

    // Run simulation asynchronously so browser can update the status text
    await new Promise(resolve => setTimeout(resolve, 30));

    // Prefer the committed snapshot when it covers exactly the current number of
    // completed games — then the grid is identical to the chart's right-most point
    // BY CONSTRUCTION (same data, not a re-simulation). Only fall back to a live
    // simulation when the live read is AHEAD of the latest snapshot (a game finished
    // since the last regen), in which case it legitimately has newer information.
    const snap = (window.HISTORY_DATA?.snapshots || []).find(
      s => s.matchesCompleted === state.completedCount);
    let probs, topOrders, adp, usedSnapshot = false;
    if (snap) {
      ({ probs, adp } = snap);
      // topOrders is optional on older snapshots — degrade to the ADP-expected order
      // rather than triggering a full re-simulation just because the field is absent.
      topOrders = snap.topOrders || [{ order: Object.keys(adp).sort((a, b) => adp[a] - adp[b]), pct: 0 }];
      lastSimCO2ug = 0;
      usedSnapshot = true;
    } else {
      const t0 = performance.now();
      ({ probs, topOrders, adp } = runMonteCarlo(state, 10000));
      lastSimCO2ug = calcSimCO2(performance.now() - t0);
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
    let infoText = usedSnapshot
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
