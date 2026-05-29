// ═════════════════════════════════════════════════════════════════════════
// ANTIGRAVITY v2 — DASHBOARD (E2 layout)
// D-style cards on left (1-column stack with sparklines + gauge rings + price
// + change%) and live event stream on right (sticky sidebar, 40%).
// Hooks into existing /api/state polling via window.terminalOnState.
// Maintains its own /api/events + /api/paper + /api/models pollers.
// ═════════════════════════════════════════════════════════════════════════
(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────────────────
  let lastEventSeq = 0;
  let streamFilter = 'ALL';   // 'ALL' | 'NQ' | 'ES' | 'CL' | 'GC' | 'ERRORS'
  let streamPaused = false;
  let eventBuffer = [];
  const MAX_EVENT_RENDER = 220;

  // Sparkline price history (rolling buffer of last 30 closes per family)
  const sparkBuffers = { NQ: [], ES: [], CL: [], GC: [] };
  const SPARK_LEN = 30;

  // Loaded model thresholds keyed by family. Populated from /api/models.
  // Each family entry: { RTH_TREND_UP_long: 0.68, ETH_VOL_EXPANSION_short: 0.62, ... }
  // Cards use this to display "primed specialists" before any decision fires.
  const modelThresholdsByFamily = { NQ: {}, ES: {}, CL: {}, GC: {} };
  // Quality status per bundle key: 'OK' | 'DISABLED' | undefined (untrained)
  const bundleStatusByFamily   = { NQ: {}, ES: {}, CL: {}, GC: {} };
  // Aggregate WR per bundle for display
  const bundleAggregateByFamily = { NQ: {}, ES: {}, CL: {}, GC: {} };

  // ── Public hooks (called from app.js) ──────────────────────────────────
  window.terminalOnState = function (data) {
    if (!data) return;
    renderKpiStrip(data);
    renderE2Cards(data);
    renderContractToggle(data);
    renderGateToggle(data);
    renderNt8Badge(data);
  };

  // ── NT8 connection badge ─────────────────────────────────────────────────
  function renderNt8Badge(data) {
    const badge = document.getElementById('nt8ConnBadge');
    if (!badge) return;
    const connected = !!data.nt8Connected;
    if (connected) {
      badge.textContent = '● NT8 ON';
      badge.style.borderColor  = 'rgba(57,255,20,0.55)';
      badge.style.background   = 'rgba(57,255,20,0.12)';
      badge.style.color        = 'var(--neon-green, #39ff14)';
      badge.title = 'NT8 bridge connected — signals will reach NinjaTrader';
    } else {
      badge.textContent = '● NT8 OFF';
      badge.style.borderColor  = 'rgba(255,56,56,0.5)';
      badge.style.background   = 'rgba(255,56,56,0.12)';
      badge.style.color        = '#ff3838';
      badge.title = 'NT8 not connected — open AntigravityBotBridge in NinjaTrader to enable live trading';
    }
  }

  window.setStreamFilter = function (filter) {
    streamFilter = filter;
    document.querySelectorAll('.stream-filter-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.filter === filter);
    });
    renderEventStream();
  };

  window.toggleStreamPause = function () {
    streamPaused = !streamPaused;
    const btn = document.getElementById('stream-pause-btn');
    if (btn) {
      btn.classList.toggle('paused', streamPaused);
      btn.textContent = streamPaused ? '▶' : '⏸';
      btn.title = streamPaused ? 'Resume live stream' : 'Pause live stream';
    }
  };

  // ── KPI strip ──────────────────────────────────────────────────────────
  function renderKpiStrip(data) {
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('kpi-equity', formatCurrency(data.totalEquity));
    const openPnl = data.totalOpenPnL || 0;
    const openEl = document.getElementById('kpi-open-pnl');
    if (openEl) {
      openEl.textContent = (openPnl >= 0 ? '+' : '') + formatCurrency(openPnl);
      openEl.className = 'tk-value ' + (openPnl > 0 ? 'profit' : (openPnl < 0 ? 'loss' : 'neutral'));
    }
    const accounts = data.accounts || {};
    const activeSyms = (data.contractMode === 'MICRO') ? (data.microSymbols || []) : (data.miniSymbols || []);
    let active = 0;
    for (const s of activeSyms) if (accounts[s] && accounts[s].activePosition) active++;
    set('kpi-active-trades', String(active));
    const profitMade = Math.max(0, (data.totalBalance || 0) - 200000);
    const pct = Math.min(100, (profitMade / 12000) * 100);
    const bar = document.getElementById('kpi-progress');
    if (bar) bar.style.width = pct.toFixed(1) + '%';
  }

  // ── MINI/MICRO toggle wiring ──────────────────────────────────────────
  function renderContractToggle(data) {
    const mode = data.contractMode || 'MINI';
    document.querySelectorAll('#contractToggle button').forEach(b => {
      b.classList.toggle('active', b.dataset.c === mode);
    });
    const title = document.getElementById('opsContractTitle');
    if (title) title.textContent = `⚙️ OPERATIONS · ${mode}`;
  }
  // Click handler on the MINI/MICRO buttons (delegated, attached once on first render)
  let _toggleWired = false;
  function wireContractToggle() {
    if (_toggleWired) return;
    const tg = document.getElementById('contractToggle');
    if (tg) {
      tg.querySelectorAll('button').forEach(b => {
        b.addEventListener('click', async () => {
          const mode = b.dataset.c;
          try {
            await fetch('/api/contract-mode', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ mode })
            });
            tg.querySelectorAll('button').forEach(x => x.classList.remove('active'));
            b.classList.add('active');
            const title = document.getElementById('opsContractTitle');
            if (title) title.textContent = `⚙️ OPERATIONS · ${mode}`;
          } catch (e) { console.warn('contract-mode toggle failed', e); }
        });
      });
    }

    _toggleWired = true;
  }

  // ── Gate 1 / Gate 2 toggle wiring ────────────────────────────────────
  // Renders the active gate button state + shadow badge.
  // Called on every /api/state poll so it stays in sync with server state.
  function renderGateToggle(data) {
    const gate   = data.activeGate  || 'gate1';
    const shadow = !!data.shadowGate2;
    document.querySelectorAll('#gateToggle button').forEach(b => {
      b.classList.toggle('active', b.dataset.g === gate);
    });
    const badge = document.getElementById('shadowBadge');
    // Show SHADOW badge when Gate 1 is live and Gate 2 is recording in background
    if (badge) badge.style.display = (gate === 'gate1' && shadow) ? 'inline-block' : 'none';
  }

  let _gateToggleWired = false;
  function wireGateToggle() {
    if (_gateToggleWired) return;
    const tg = document.getElementById('gateToggle');
    if (!tg) return;
    tg.querySelectorAll('button').forEach(b => {
      b.addEventListener('click', async () => {
        const newGate = b.dataset.g;
        // Optimistic UI
        tg.querySelectorAll('button').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        try {
          const res = await fetch('/api/gate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ activeGate: newGate })
          });
          const data = await res.json();
          if (data.status !== 'success') {
            // Revert on failure
            tg.querySelectorAll('button').forEach(x =>
              x.classList.toggle('active', x.dataset.g !== newGate)
            );
            console.warn('[GateToggle] switch failed:', data);
          }
          const badge = document.getElementById('shadowBadge');
          if (badge) badge.style.display = (data.activeGate === 'gate1' && data.shadowGate2) ? 'inline-block' : 'none';
        } catch (e) {
          console.warn('[GateToggle] fetch error:', e);
          // Revert
          tg.querySelectorAll('button').forEach(x =>
            x.classList.toggle('active', x.dataset.g !== newGate)
          );
        }
      });
    });
    _gateToggleWired = true;
  }

  // ── E2 symbol cards (left pane) ───────────────────────────────────────
  function renderE2Cards(data) {
    wireContractToggle();
    wireGateToggle();
    const container = document.getElementById('e2-cards');
    if (!container) return;

    // Per-family active symbol — respects each family's MINI/MICRO toggle
    // on the account card. Falls back to global contractMode for unset families.
    const globalMode = data.contractMode || 'MINI';
    const familyContracts = data.familyContracts || {};
    const families = ['NQ', 'ES', 'CL', 'GC'];
    const symbols = families.map(f => {
      const t = familyContracts[f] || globalMode;
      return (t === 'MICRO' ? 'M' : '') + f + '=F';
    });
    const decisions = data.lastDecisions || {};
    const livePrices = data.livePrices || {};
    const accounts = data.accounts || {};
    const specs = data.contractSpecs || {};

    // Update sparkline buffers from current prices (one snapshot per state refresh)
    for (const sym of symbols) {
      const fam = sym.replace(/^M/, '').replace('=F', '');
      if (!sparkBuffers[fam]) sparkBuffers[fam] = [];
      const px = livePrices[sym] || 0;
      if (px > 0 && (sparkBuffers[fam].length === 0 || sparkBuffers[fam][sparkBuffers[fam].length - 1] !== px)) {
        sparkBuffers[fam].push(px);
        if (sparkBuffers[fam].length > SPARK_LEN) sparkBuffers[fam].shift();
      }
    }

    // Per-session WR floors — surfaced on each card so the user sees at a
    // glance what the quality bar is for their current session.
    const floors = data.qualityFloors || { rth: 0.65, eth: 0.55 };

    container.innerHTML = symbols.map(sym => buildE2Card(sym, decisions[sym], accounts[sym], livePrices[sym], specs[sym], floors, data)).join('');
  }

  // ── V6-style symbol card ─────────────────────────────────────────────────
  function buildE2Card(sym, decision, acc, px, spec, floors, data) {
    floors = floors || { rth: 0.65, eth: 0.55 };
    data = data || {};
    const family    = (spec && spec.family) || sym.replace(/^M/, '').replace('=F', '');
    const isMicro   = spec && spec.isMicro;
    const displaySym = sym.replace('=F', '');
    const enabled   = acc ? acc.enabled !== false : true;

    // ── Decision state ──────────────────────────────────────────────────
    const action      = decision ? decision.action      : null;
    const regime      = decision ? decision.regime      : null;
    const session     = decision ? decision.session     : '—';
    const isChop      = regime === 'CHOP';
    const probs       = (decision && decision.probabilities) || {};
    const longP       = probs.long;
    const shortP      = probs.short;
    const longTh      = probs.longTh;
    const shortTh     = probs.shortTh;
    const longBundle  = (decision && decision.longBundle)  || 'OK';
    const shortBundle = (decision && decision.shortBundle) || 'OK';
    const retrain     = data && data.retrainInProgress;

    // ── Fire class ──────────────────────────────────────────────────────
    let fireClass = '';
    if (action === 'BUY')       fireClass = 'fire-long';
    else if (action === 'SELL') fireClass = 'fire-short';
    else if (isChop)            fireClass = 'chop';
    if (!enabled)               fireClass = 'off';

    // ── Regime pill ─────────────────────────────────────────────────────
    const rClass = regime === 'TREND_UP'      ? 'up'
                 : regime === 'TREND_DOWN'    ? 'down'
                 : regime === 'VOL_EXPANSION' ? 'vol'
                 : 'chop';
    const regimeText = regime === 'TREND_UP'      ? 'TREND ↑'
                     : regime === 'TREND_DOWN'    ? 'TREND ↓'
                     : regime === 'VOL_EXPANSION' ? 'VOL EXP'
                     : regime === 'CHOP'          ? 'CHOP'
                     : '—';

    // ── Verdict badge ───────────────────────────────────────────────────
    let verdictBadge;
    if (action === 'BUY')        verdictBadge = `<span class="v6c-verdict long">▲ FIRE LONG</span>`;
    else if (action === 'SELL')  verdictBadge = `<span class="v6c-verdict short">▼ FIRE SHORT</span>`;
    else if (isChop)             verdictBadge = `<span class="v6c-verdict wait">CHOP</span>`;
    else                         verdictBadge = `<span class="v6c-verdict wait">WAIT</span>`;

    // ── Retrain banner ──────────────────────────────────────────────────
    const retrainTag = retrain
      ? `<span style="display:inline-block; padding:2px 7px; border-radius:4px; background:rgba(0,240,255,0.15); border:1px solid rgba(0,240,255,0.4); color:var(--cyan-glow); font-weight:700; font-size:9px; letter-spacing:0.4px; margin-right:6px;">🔧 RETRAIN ${retrain.bundlesStarted}/${retrain.totalExpected}</span>`
      : '';

    // ── Specialist line ─────────────────────────────────────────────────
    let specLine;
    if (longBundle === 'DISABLED' && shortBundle === 'DISABLED') {
      specLine = '<span style="color:var(--neon-red);">all bundles gated off (low quality)</span>';
    } else if (longBundle === 'MISSING' && shortBundle === 'MISSING') {
      specLine = '<span style="color:var(--neon-orange,#ff9800);">no model trained for this regime</span>';
    } else if (action === 'BUY' || action === 'SELL') {
      const dir = action === 'BUY' ? 'long' : 'short';
      specLine = `${retrainTag}active: <strong>${family}_${session}_${regime}_${dir}</strong>`;
    } else {
      const primedLong  = longBundle  !== 'MISSING' && longBundle  !== 'DISABLED';
      const primedShort = shortBundle !== 'MISSING' && shortBundle !== 'DISABLED';
      const dirs = (primedLong && primedShort) ? '↑↓' : primedLong ? '↑' : primedShort ? '↓' : '';
      const armed = deployedBundlesFor(family).length;
      if (armed === 0) {
        specLine = `${retrainTag}<span style="opacity:0.55;">no deployed bundles · waiting for retrain</span>`;
      } else {
        specLine = `${retrainTag}watching: <strong>${family}_${session}_${regime || '…'}${dirs ? ' ' + dirs : ''}</strong>`;
      }
    }

    // ── Probability bars ─────────────────────────────────────────────────
    // Best-threshold fallback from deployed bundles when decision hasn't fired
    let displayLongTh = longTh, displayShortTh = shortTh;
    if (displayLongTh === undefined || displayLongTh === null) {
      const dl = deployedBundlesFor(family).filter(b => b.key.endsWith('_long'));
      displayLongTh = dl.length > 0 ? Math.min(...dl.map(b => b.threshold)) : null;
    }
    if (displayShortTh === undefined || displayShortTh === null) {
      const ds = deployedBundlesFor(family).filter(b => b.key.endsWith('_short'));
      displayShortTh = ds.length > 0 ? Math.min(...ds.map(b => b.threshold)) : null;
    }

    function probBar(side, prob, th) {
      const cls    = side === 'long' ? 'long' : 'short';
      const lbl    = side === 'long' ? 'L' : 'S';
      const lblCls = side === 'long' ? 'opa-prob-l' : 'opa-prob-s';
      const hasProb = prob != null;
      const pct     = hasProb ? Math.round(Math.max(0, Math.min(1, prob)) * 100) : 0;
      const thPct   = th  != null ? Math.round(Math.max(0, Math.min(1, th))  * 100) : null;
      const hit     = hasProb && th != null && prob >= th;
      const isNearZero = hasProb && pct === 0 && prob > 0;
      const fillPct    = isNearZero ? 1.5 : pct;
      const valText    = !hasProb ? '0%' : isNearZero ? '< 1%' : `${pct}%`;
      const valColor   = hit      ? (side === 'long' ? 'var(--neon-green)' : 'var(--neon-red)')
                       : hasProb  ? 'var(--text-primary)'
                       :            'rgba(255,255,255,0.3)';
      const tickHtml = thPct != null
        ? `<span class="opa-prob-th" style="left:${thPct}%;"></span>` : '';
      return `<div class="opa-prob">
                <span class="${lblCls}">${lbl}</span>
                <div class="opa-prob-track">
                  <span class="opa-prob-fill ${cls}" style="width:${fillPct}%;"></span>
                  ${tickHtml}
                </div>
                <span class="opa-prob-val" style="color:${valColor};">${valText}</span>
              </div>`;
    }
    const probL = probBar('long',  longP,  displayLongTh);
    const probS = probBar('short', shortP, displayShortTh);

    // ── Open position line ───────────────────────────────────────────────
    const pos = acc && acc.activePosition;
    // Compute per-position P&L from live price — NT8's unrealizedPnL is
    // account-wide: all charts on the same sim account share one number
    // (e.g., NQ+ES+CL+GC all show -$9170.50).
    // Fix: derive from (livePrice − entryPrice) × direction × qty × pointVal.
    const posPnl = (() => {
      if (!pos) return 0;
      if (px && spec && pos.entryPrice > 0) {
        const diff = (px - pos.entryPrice) * (pos.direction === 'Long' ? 1 : -1);
        return Math.round(diff * (spec.pointVal || 1) * (pos.qty || 1) * 100) / 100;
      }
      return pos.unrealizedPnL || 0;  // fallback when live price unavailable
    })();

    const posLine = pos
      ? `<div style="font-family:'Consolas',monospace; font-size:10px; color:var(--text-secondary); padding:3px 0;">
           📌 ${pos.direction} ×${pos.qty || 1} @${pos.entryPrice ? pos.entryPrice.toFixed(2) : '—'}
           &nbsp;·&nbsp;<span style="color:${posPnl >= 0 ? 'var(--neon-green)' : 'var(--neon-red)'}; font-weight:800;">${posPnl >= 0 ? '+' : ''}${formatCurrency(posPnl)}</span>
         </div>`
      : '';

    // ── Account stats (REALIZED / FLOAT / NET LIQ / TRADES) ─────────────
    const netLiq   = acc ? (acc.nt8Balance   || acc.balance || 0)     : 0;
    const realized = acc ? (acc.nt8RealizedPnL || 0)                  : 0;
    // float_ = open P&L for this instrument only (0 when flat)
    const float_   = pos ? posPnl : 0;

    // Today's closed-trade count for this family
    const todayStr   = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
    const allHistory = Array.isArray(data.history) ? data.history : [];
    const todayCount = allHistory.filter(t => {
      if (!t.exitTime) return false;
      const tFam = (t.symbol || '').replace(/^M/, '').replace('=F', '');
      return tFam === family && String(t.exitTime).slice(0, 10) === todayStr;
    }).length;

    function fmtStat(v) {
      if (v === 0) return `<span class="v6c-stat-val dim">$0</span>`;
      return `<span class="v6c-stat-val ${v > 0 ? 'pos' : 'neg'}">${v > 0 ? '+' : ''}${formatCurrency(v)}</span>`;
    }
    const statsHtml = `<div class="v6c-stats">
      <div class="v6c-stat"><span class="v6c-stat-lbl">REALIZED</span>${fmtStat(realized)}</div>
      <div class="v6c-stat"><span class="v6c-stat-lbl">FLOAT</span>${fmtStat(float_)}</div>
      <div class="v6c-stat">
        <span class="v6c-stat-lbl">NET LIQ</span>
        <span class="v6c-stat-val">${netLiq > 0 ? formatCurrency(netLiq) : '—'}</span>
      </div>
      <div class="v6c-stat">
        <span class="v6c-stat-lbl">TRADES</span>
        <span class="v6c-stat-val">${todayCount}</span>
      </div>
    </div>`;

    // ── Gates row ────────────────────────────────────────────────────────
    // EMA: regime direction (up/down = green, vol = warn, chop/none = dim)
    // ML:  any fired signal this bar (green) or probabilities rising (dim)
    // LQ:  at least one direction has a deployed bundle (green vs off)
    // SESSION: current session tag with RTH=green, ETH=amber
    const emaClass = regime === 'TREND_UP' || regime === 'TREND_DOWN' ? 'on'
                   : regime === 'VOL_EXPANSION' ? 'warn' : 'dim';
    const emaLabel = regime === 'TREND_UP'   ? 'EMA ↑'
                   : regime === 'TREND_DOWN' ? 'EMA ↓' : 'EMA';

    const mlClass  = (action === 'BUY' || action === 'SELL') ? 'on' : 'dim';
    const mlLabel  = (action === 'BUY' || action === 'SELL') ? 'ML ✓' : 'ML ○';

    const lqOk    = !((longBundle === 'DISABLED' || longBundle === 'MISSING') &&
                      (shortBundle === 'DISABLED' || shortBundle === 'MISSING'));
    const lqClass = lqOk ? 'on' : 'off';
    const lqLabel = lqOk ? 'LQ OK' : 'LQ OFF';

    const sessClass = session === 'RTH' ? 'on' : session === 'ETH' ? 'warn' : 'dim';

    const gatesHtml = `<div class="v6c-gates">
      <span class="v6c-gate ${emaClass}">${emaLabel}</span>
      <span class="v6c-gate ${mlClass}">${mlLabel}</span>
      <span class="v6c-gate ${lqClass}">${lqLabel}</span>
      <span class="v6c-gate ${sessClass}">${session !== '—' ? session : 'OFFLINE'}</span>
    </div>`;

    // ── NT8 symbol-mismatch detection ────────────────────────────────────
    const linked    = data && data.nt8LinkedSymbols ? data.nt8LinkedSymbols : {};
    const chartSym  = linked[family];
    const isMismatch = chartSym && chartSym !== sym;
    let mismatchBanner = '';
    if (isMismatch) {
      const cleanChart = chartSym.replace('=F', '');
      mismatchBanner = `
        <div style="padding:6px 8px; border-radius:6px; background:rgba(255,152,0,0.12);
                    border:1px solid rgba(255,152,0,0.45); color:#ff9800; font-size:10px; line-height:1.4;">
          🚫 <strong>SYMBOL MISMATCH</strong> — NT8 chart on <strong>${cleanChart}</strong>,
          bot wants <strong>${displaySym}</strong>.
          Switch chart to ${displaySym} or toggle bot contract mode.
        </div>`;
    }

    // ── Assemble ─────────────────────────────────────────────────────────
    return `
      <div class="v6card ${fireClass}"${isMismatch ? ' style="border-color:rgba(255,152,0,0.6);"' : ''}>
        <div class="v6c-head">
          <div class="v6c-sym-row">
            <span class="v6c-sym">${displaySym}</span>
            <span class="v6c-tier ${isMicro ? 'micro' : 'mini'}">${isMicro ? 'MICRO' : 'MINI'}</span>
            <span class="v6c-regime ${rClass}">${regimeText}</span>
          </div>
          <span class="v6c-onoff ${enabled ? 'on' : 'off'}"
                onclick="toggleSymbolState('${sym}', ${!enabled})">${enabled ? '● ON' : '○ OFF'}</span>
        </div>
        <div class="v6c-row2">
          <span class="v6c-sess">${session} · ${px != null ? px.toFixed(2) : '—'}</span>
          ${verdictBadge}
        </div>
        <div class="v6c-spec">${specLine}</div>
        ${probL}
        ${probS}
        ${posLine}
        <div class="v6c-maxqty">
          <span class="v6c-maxqty-lbl">MAX QTY</span>
          ${[1,2,3,5,10].map(n => {
            const cur = acc && typeof acc.userMaxContracts === 'number' ? acc.userMaxContracts : 3;
            const active = cur === n ? ' active' : '';
            return `<button class="v6c-qbtn${active}" onclick="setMaxQty('${sym}',${n},this)">${n}</button>`;
          }).join('')}
        </div>
        <div class="v6c-btns">
          <button class="v6c-btn buy"
                  onclick="ctrl('${sym}','BUY',this)"
                  ${pos ? 'disabled title="Already in position — use FLAT first"' : ''}>▲ BUY</button>
          <button class="v6c-btn sell"
                  onclick="ctrl('${sym}','SELL',this)"
                  ${pos ? 'disabled title="Already in position — use FLAT first"' : ''}>▼ SELL</button>
          <button class="v6c-btn flat"
                  onclick="ctrl('${sym}','FLAT',this)"
                  ${!pos ? 'disabled title="No open position to close"' : ''}>■ FLAT</button>
        </div>
        ${mismatchBanner}
      </div>`;
  }

  // ── Manual override buttons — unified V6-style ctrl() ────────────────────
  // No confirm dialogs. Button is locked while the fetch is in-flight (prevents
  // double-fire). Re-enables 1.5 s later (matches next WS state refresh).
  // cmd: 'BUY' | 'SELL' | 'FLAT'
  window.ctrl = async function (sym, cmd, el) {
    if (el) el.disabled = true;
    try {
      const hdrs = { 'Content-Type': 'application/json' };
      let res;
      if (cmd === 'BUY' || cmd === 'SELL') {
        res = await fetch('/api/fire', { method: 'POST', headers: hdrs,
          body: JSON.stringify({ symbol: sym, action: cmd }) });
      } else if (cmd === 'FLAT') {
        res = await fetch('/api/close', { method: 'POST', headers: hdrs,
          body: JSON.stringify({ symbol: sym }) });
      }
      if (res) {
        const d = await res.json();
        if (!res.ok || d.error) {
          alert(`⚠ ${cmd} failed on ${sym.replace('=F','')}\n\n${d.error || 'Unknown server error'}`);
        } else if (cmd === 'FLAT' && d.nt8Sent === false) {
          alert(`⚠ Paper position closed — NT8 not connected.\nClose the position manually in NinjaTrader.`);
        }
      }
    } catch (e) { console.warn('ctrl error', e); alert(`Network error: ${e.message}`); }
    setTimeout(() => { if (el) el.disabled = false; }, 1500);
  };

  // ── Max contracts selector ────────────────────────────────────────────────
  window.setMaxQty = async function (sym, qty, el) {
    // Optimistically mark the button active immediately so there's no flicker
    const card = el && el.closest('.v6card');
    if (card) {
      card.querySelectorAll('.v6c-qbtn').forEach(b => b.classList.remove('active'));
      el.classList.add('active');
    }
    try {
      const res = await fetch('/api/max-contracts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: sym, qty })
      });
      const d = await res.json();
      if (!res.ok || !d.ok) {
        alert(`⚠ Could not set max qty for ${sym.replace('=F','')}\n${d.error || 'Unknown error'}`);
        // Revert optimistic UI on failure — next state poll will redraw correctly
        if (card) card.querySelectorAll('.v6c-qbtn').forEach(b => b.classList.remove('active'));
      }
    } catch (e) { console.warn('setMaxQty error', e); }
  };

  function buildGauge(side, prob, threshold, status, decision) {
    const cls = side === 'long' ? 'l' : 's';
    const fillCls = side === 'long' ? 'long' : 'short';
    const cap = side === 'long' ? 'LONG' : 'SHORT';
    // Status-based dead states
    if (status === 'DISABLED') {
      return `<div class="e2-gauge" style="opacity:0.45;">
        <svg viewBox="0 0 100 55"><path class="g-bg" d="M 10 50 A 40 40 0 0 1 90 50"/></svg>
        <div class="e2-gauge-num muted">—</div>
        <div class="e2-gauge-cap">${cap} prob</div>
        <div class="e2-gauge-th gated">⊘ GATED</div>
      </div>`;
    }
    if (status === 'MISSING') {
      return `<div class="e2-gauge" style="opacity:0.45;">
        <svg viewBox="0 0 100 55"><path class="g-bg" d="M 10 50 A 40 40 0 0 1 90 50"/></svg>
        <div class="e2-gauge-num muted">—</div>
        <div class="e2-gauge-cap">${cap} prob</div>
        <div class="e2-gauge-th">no model</div>
      </div>`;
    }
    // No prob yet (waiting for first bar) but threshold IS known → show it
    if (prob === null || prob === undefined) {
      const thLabel = threshold !== null && threshold !== undefined
        ? `th ${threshold.toFixed(2)} (primed)`
        : 'awaiting bar';
      return `<div class="e2-gauge" style="opacity:0.7;">
        <svg viewBox="0 0 100 55"><path class="g-bg" d="M 10 50 A 40 40 0 0 1 90 50"/></svg>
        <div class="e2-gauge-num muted">—</div>
        <div class="e2-gauge-cap">${cap} prob</div>
        <div class="e2-gauge-th">${thLabel}</div>
      </div>`;
    }
    const pct = Math.max(0, Math.min(1, prob));
    const arcLen = 125.7; // half-circle perimeter at r=40
    const dashOffset = arcLen * (1 - pct);
    const hit = threshold !== undefined && prob >= threshold;
    const thLabel = threshold !== undefined ? `th ${threshold.toFixed(2)}${hit ? ' ✓ HIT' : ''}` : '—';
    const thCls = hit ? (side === 'long' ? 'hit' : 'hit-s') : '';
    return `<div class="e2-gauge">
      <svg viewBox="0 0 100 55">
        <path class="g-bg" d="M 10 50 A 40 40 0 0 1 90 50"/>
        <path class="g-fg ${fillCls}" d="M 10 50 A 40 40 0 0 1 90 50" stroke-dasharray="${arcLen}" stroke-dashoffset="${dashOffset.toFixed(1)}"/>
      </svg>
      <div class="e2-gauge-num ${cls}">${(pct * 100).toFixed(0)}%</div>
      <div class="e2-gauge-cap">${cap} prob</div>
      <div class="e2-gauge-th ${thCls}">${thLabel}</div>
    </div>`;
  }

  function buildSparkline(points, todayPnl) {
    if (!points || points.length < 2) {
      return `<svg class="e2-spark" viewBox="0 0 200 50" preserveAspectRatio="none">
        <line x1="0" y1="25" x2="200" y2="25" stroke="rgba(255,255,255,0.08)" stroke-width="1" stroke-dasharray="3,3"/>
      </svg>`;
    }
    const min = Math.min(...points);
    const max = Math.max(...points);
    const range = max - min || 1;
    const w = 200, h = 50, pad = 4;
    const step = (w - 2 * pad) / (points.length - 1);
    const ptsStr = points.map((v, i) => {
      const x = pad + i * step;
      const y = h - pad - ((v - min) / range) * (h - 2 * pad);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    const color = todayPnl >= 0 ? '#39ff14' : '#ff3838';
    const fillId = 'sf_' + Math.random().toString(36).slice(2, 8);
    return `<svg class="e2-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
      <defs><linearGradient id="${fillId}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${color}" stop-opacity="0.3"/>
        <stop offset="1" stop-color="${color}" stop-opacity="0"/>
      </linearGradient></defs>
      <polygon points="${ptsStr} ${w - pad},${h} ${pad},${h}" fill="url(#${fillId})"/>
      <polyline points="${ptsStr}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;
  }

  // ── Event stream (right sidebar) ──────────────────────────────────────
  async function pollEvents() {
    if (streamPaused) return;
    try {
      const res = await fetch(`/api/events?after=${lastEventSeq}&limit=120`);
      if (!res.ok) return;
      const data = await res.json();
      if (!data.events || data.events.length === 0) return;
      lastEventSeq = data.currentSeq || lastEventSeq;
      for (const ev of data.events) eventBuffer.push(ev);
      if (eventBuffer.length > MAX_EVENT_RENDER) eventBuffer = eventBuffer.slice(-MAX_EVENT_RENDER);
      renderEventStream();
    } catch (e) {}
  }

  function renderEventStream() {
    const container = document.getElementById('event-stream');
    if (!container) return;

    const filtered = eventBuffer.filter(ev => {
      if (streamFilter === 'ALL') return true;
      if (streamFilter === 'ERRORS') return ev.type === 'ERROR';
      // Filter by family (NQ matches both NQ=F and MNQ=F)
      if (!ev.symbol) return false;
      const fam = ev.symbol.replace(/^M/, '').replace('=F', '');
      return fam === streamFilter;
    });

    if (filtered.length === 0) {
      container.innerHTML = `<div style="text-align:center; color:var(--text-secondary); padding:30px 12px; font-family: var(--font-family); font-size:12px;">No events match filter <strong>${streamFilter}</strong>${streamPaused ? ' · ⏸ paused' : ''}.</div>`;
      return;
    }

    const rows = filtered.slice().reverse().map(ev => {
      const t = new Date(ev.ts);
      const hh = String(t.getHours()).padStart(2, '0');
      const mm = String(t.getMinutes()).padStart(2, '0');
      const ss = String(t.getSeconds()).padStart(2, '0');
      const sym = ev.symbol ? ev.symbol.replace('=F', '') : '·';
      const typeShort = (ev.type || '').substring(0, 3);
      const msg = escapeHtml(ev.message || '');
      return `<div class="event-row type-${ev.type}">
        <span class="event-time">${hh}:${mm}:${ss}</span>
        <span class="event-symbol">${sym}</span>
        <span class="event-type">${typeShort}</span>
        <span class="event-msg">${msg}</span>
      </div>`;
    }).join('');
    container.innerHTML = rows;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatCurrency(v) {
    if (v === null || v === undefined || isNaN(v)) return '$0.00';
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v);
  }

  // ── Exits tab (TP/SL/BE/Trail override per RTH/ETH) ────────────────────
  async function pollExitsConfig() {
    try {
      const res = await fetch('/api/exits');
      if (!res.ok) return;
      const data = await res.json();
      renderExitsTab(data.config, data.fixedActive);
    } catch (e) {}
  }

  // 8 symbols: 4 mini + 4 micro. Each gets its own card with RTH + ETH columns.
  const EXITS_SYMBOLS = [
    { sym: 'NQ=F',  label: 'NQ',  family: 'Nasdaq-100 E-mini',     tier: 'mini'  },
    { sym: 'ES=F',  label: 'ES',  family: 'S&P 500 E-mini',         tier: 'mini'  },
    { sym: 'CL=F',  label: 'CL',  family: 'Crude Oil',              tier: 'mini'  },
    { sym: 'GC=F',  label: 'GC',  family: 'Gold',                   tier: 'mini'  },
    { sym: 'MNQ=F', label: 'MNQ', family: 'Nasdaq-100 Micro',       tier: 'micro' },
    { sym: 'MES=F', label: 'MES', family: 'S&P 500 Micro',          tier: 'micro' },
    { sym: 'MCL=F', label: 'MCL', family: 'Crude Oil Micro',        tier: 'micro' },
    { sym: 'MGC=F', label: 'MGC', family: 'Gold Micro',             tier: 'micro' }
  ];

  function renderExitsTab(cfg, fixedActive) {
    const warn = document.getElementById('exits-warning');
    if (warn) warn.style.display = fixedActive ? '' : 'none';
    const wrap = document.getElementById('exits-cards');
    if (!wrap) return;
    wrap.innerHTML = EXITS_SYMBOLS.map(meta => buildExitsCardForSymbol(meta, cfg[meta.sym] || {})).join('');
    wireExitsHandlers();
  }

  function buildExitsCardForSymbol(meta, symCfg) {
    const rth = symCfg.RTH || {};
    const eth = symCfg.ETH || {};
    const anyActive = !!(rth.enabled || eth.enabled);
    const tierBadge = meta.tier === 'micro'
      ? `<span style="font-size:9px; padding: 2px 6px; border-radius: 4px; background: rgba(167,139,250,0.15); color: #a78bfa; border: 1px solid rgba(167,139,250,0.4); font-weight: 800; letter-spacing: 0.5px;">MICRO</span>`
      : `<span style="font-size:9px; padding: 2px 6px; border-radius: 4px; background: rgba(0,240,255,0.12); color: var(--cyan-glow, #00F0FF); border: 1px solid rgba(0,240,255,0.4); font-weight: 800; letter-spacing: 0.5px;">MINI</span>`;
    return `
      <div class="exits-symbol-card glass-card" style="padding: 18px 20px; border: 1px solid ${anyActive ? 'rgba(255,152,0,0.4)' : 'var(--border-light)'}; box-shadow: ${anyActive ? '0 0 16px rgba(255,152,0,0.12)' : 'none'};">
        <div style="display:flex; align-items:center; gap: 10px; margin-bottom: 14px; padding-bottom: 10px; border-bottom: 1px solid rgba(255,255,255,0.06);">
          <h3 style="margin:0; font-size: 18px; font-weight: 800; color: var(--text-primary); letter-spacing: 1px;">${meta.label}</h3>
          ${tierBadge}
          <span style="font-size: 11px; color: var(--text-secondary); margin-left: 4px;">${meta.family}</span>
          ${anyActive ? `<span style="margin-left: auto; font-size: 10px; font-weight: 800; color: var(--neon-orange); letter-spacing: 0.5px;">● FIXED ACTIVE</span>` : ''}
        </div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 14px;">
          ${buildSessionBlock(meta.sym, 'RTH', rth)}
          ${buildSessionBlock(meta.sym, 'ETH', eth)}
        </div>
      </div>
    `;
  }

  function buildSessionBlock(symbol, session, s) {
    const sessLabel = session === 'RTH' ? '☀️ RTH' : '🌙 ETH';
    const accentColor = session === 'RTH' ? 'var(--neon-green)' : 'var(--neon-orange)';
    const accentGlow  = session === 'RTH' ? 'rgba(57,255,20,0.12)' : 'rgba(255,152,0,0.10)';
    const enabled = !!s.enabled;
    return `
      <div style="background: rgba(5,7,12,${enabled ? '0.45' : '0.25'}); border: 1px solid ${enabled ? accentColor : 'rgba(255,255,255,0.05)'}; border-radius: 8px; padding: 12px; ${enabled ? `box-shadow: inset 0 0 12px ${accentGlow};` : ''}">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 10px;">
          <span style="font-size: 12px; font-weight: 800; color: ${accentColor}; letter-spacing: 0.5px;">${sessLabel}</span>
          <label style="display:flex; align-items:center; gap:6px; cursor:pointer; user-select:none;">
            <input type="checkbox" data-exits-symbol="${symbol}" data-exits-session="${session}" data-exits-field="enabled" ${enabled ? 'checked' : ''} style="width:14px; height:14px; cursor:pointer; accent-color: ${accentColor};">
            <span style="font-size:9.5px; font-weight: 800; letter-spacing: 0.4px; color: ${enabled ? accentColor : 'var(--text-secondary)'};">USE FIXED ${enabled ? '✓' : ''}</span>
          </label>
        </div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; ${enabled ? '' : 'opacity:0.45; pointer-events:none;'}">
          ${exitsField('Profit',     symbol, session, 'profitPoints',     s.profitPoints,     'pts')}
          ${exitsField('Stop',       symbol, session, 'stopPoints',       s.stopPoints,       'pts')}
          ${exitsField('Break-Even', symbol, session, 'breakevenAtPoints', s.breakevenAtPoints, 'pts')}
          ${exitsField('Trail @',    symbol, session, 'trailStartPoints', s.trailStartPoints, 'pts')}
          <div style="grid-column: 1 / -1;">
            ${exitsField('Trail Step', symbol, session, 'trailStepPoints',  s.trailStepPoints,  'pts behind')}
          </div>
        </div>
      </div>
    `;
  }

  function exitsField(label, symbol, session, field, value, suffix) {
    return `
      <div class="input-group" style="display:flex; flex-direction:column; gap:3px;">
        <label style="font-size: 9px; color: var(--text-secondary); font-weight: 700; letter-spacing: 0.4px; text-transform: uppercase;">${label}</label>
        <div style="display:flex; align-items:center; gap:4px;">
          <input type="number" min="0.05" step="0.05" value="${value}"
                 data-exits-symbol="${symbol}" data-exits-session="${session}" data-exits-field="${field}"
                 style="flex:1; min-width: 0; padding: 6px 8px; background: rgba(5,7,12,0.6); border: 1px solid var(--border-light); border-radius: 5px; color: var(--text-primary); font-family: 'Consolas', monospace; font-size: 12px; font-weight: 600;">
          <span style="font-size: 9px; color: var(--text-secondary); white-space: nowrap;">${suffix}</span>
        </div>
      </div>
    `;
  }

  let _exitsHandlersWired = new WeakSet();
  function wireExitsHandlers() {
    document.querySelectorAll('[data-exits-symbol]').forEach(el => {
      if (_exitsHandlersWired.has(el)) return;
      _exitsHandlersWired.add(el);
      el.addEventListener('change', async () => {
        const symbol  = el.dataset.exitsSymbol;
        const session = el.dataset.exitsSession;
        const field   = el.dataset.exitsField;
        const val     = el.type === 'checkbox' ? el.checked : parseFloat(el.value);
        try {
          const res = await fetch('/api/exits', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ symbol, session, values: { [field]: val } })
          });
          if (res.ok) pollExitsConfig();  // re-render with fresh state
        } catch (e) { console.warn('exits save failed', e); }
      });
    });
  }

  // ── Today WR/PF KPI — derived from /api/state.history ──────────────────
  // History is unified: in LIVE mode it's NT8-mirror trades; in PAPER mode
  // it's paperHarness trades. Either way the tile shows what the bot has
  // actually done today.
  async function pollPaperStats() {
    try {
      const res = await fetch('/api/state');
      if (!res.ok) return;
      const data = await res.json();
      const wrEl = document.getElementById('kpi-paper-wr');
      const pfEl = document.getElementById('kpi-paper-pf');
      const wrLabel = document.getElementById('kpi-wr-label');
      const pfLabel = document.getElementById('kpi-pf-label');
      // Relabel based on mode so user knows what they're looking at
      const isLive = (data.tradingMode || '').toLowerCase() === 'live';
      if (wrLabel) wrLabel.textContent = isLive ? 'Live WR (today)' : 'Paper WR (today)';
      if (pfLabel) pfLabel.textContent = isLive ? 'Live R (today)'   : 'Paper R (today)';

      // Filter history to today only (PT)
      const todayPT = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
      const all = Array.isArray(data.history) ? data.history : [];
      const today = all.filter(t => {
        if (!t.exitTime) return false;
        return String(t.exitTime).slice(0, 10) === todayPT;
      });
      if (today.length === 0) {
        if (wrEl) wrEl.textContent = '— (0)';
        if (pfEl) pfEl.textContent = '0.0 R';
        return;
      }
      const wins = today.filter(t => (t.profit || t.pnl || 0) > 0).length;
      const wr = wins / today.length;
      const netR = today.reduce((s, t) => s + (t.pnlR != null ? t.pnlR : 0), 0);
      if (wrEl) wrEl.textContent = (wr * 100).toFixed(1) + '% (' + today.length + ')';
      if (pfEl) pfEl.textContent = (netR >= 0 ? '+' : '') + netR.toFixed(1) + ' R';
    } catch (e) {}
  }

  async function pollModelStatus() {
    try {
      const res = await fetch('/api/models');
      if (!res.ok) return;
      const data = await res.json();
      if (!data.models) return;
      // Top-line KPI: deployed / total
      const enabled = data.models.filter(m => m.enabled).length;
      const total = data.models.length;
      const el = document.getElementById('kpi-models-on');
      if (el) el.textContent = `${enabled} / ${total}`;
      // Global cache so app.js (Futures Funded Accounts cards) can show
      // the same per-family bundle list without re-fetching.
      window._v2ModelStatus = data.models;
      // Populate the Settings → "v2 Engine" info panel
      renderSettingsModelsInfo(data.models);
      // Per-family bundle tables (used by the ops cards to show "primed
      // specialists" with thresholds BEFORE any decision fires).
      for (const fam of Object.keys(modelThresholdsByFamily)) {
        modelThresholdsByFamily[fam]   = {};
        bundleStatusByFamily[fam]      = {};
        bundleAggregateByFamily[fam]   = {};
      }
      for (const m of data.models) {
        const fam = (m.symbol || '').replace('=F', '');
        if (!modelThresholdsByFamily[fam]) continue;
        const key = `${m.session}_${m.regime}_${m.direction}`;
        modelThresholdsByFamily[fam][key] = m.threshold;
        bundleStatusByFamily[fam][key]    = m.enabled ? 'OK' : 'DISABLED';
        bundleAggregateByFamily[fam][key] = m.aggregate || null;
      }
    } catch (e) {}
  }

  // Populates the Settings tab's "v2 Engine" panel with live model stats.
  function renderSettingsModelsInfo(models) {
    if (!Array.isArray(models)) return;
    const deployed = models.filter(m => m.enabled);
    const gated = models.filter(m => !m.enabled);
    const setText = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    setText('settings-deployed-count', deployed.length + ' deployed');
    setText('settings-gated-count',    gated.length    + ' gated off');
    // Latest train timestamp — pick max trainedAt across models
    let latest = null;
    for (const m of models) {
      if (!m.trainedAt) continue;
      const t = new Date(m.trainedAt);
      if (!latest || t > latest) latest = t;
    }
    setText('settings-last-trained', latest ? latest.toLocaleString() : '—');

    const list = document.getElementById('settings-deployed-list');
    if (!list) return;
    if (deployed.length === 0) {
      list.innerHTML = '<span style="color:var(--neon-orange);">No bundles pass the quality gate. Run a retrain or relax MIN_WR / MIN_PF / MIN_TRADES env vars.</span>';
      return;
    }
    // Sort by WR descending and render as a tidy table
    const sorted = deployed.slice().sort((a, b) => (b.aggregate?.winRate || 0) - (a.aggregate?.winRate || 0));
    const rows = sorted.map(m => {
      const a = m.aggregate || {};
      const wr = ((a.winRate || 0) * 100).toFixed(1).padStart(5) + '%';
      const pf = (a.profitFactor || 0).toFixed(2).padStart(5);
      const sh = (a.sharpe || 0).toFixed(2).padStart(6);
      const tr = String(a.totalTestTrades || 0).padStart(5);
      const sym = m.symbol.replace('=F', '').padEnd(3);
      const sess = m.session.padEnd(4);
      const reg  = m.regime.padEnd(14);
      const dir  = m.direction.padEnd(6);
      const th   = (m.threshold || 0).toFixed(2);
      return `  ✓ ${sym} ${sess} ${reg} ${dir}  WR=${wr}  PF=${pf}  Sharpe=${sh}  trades=${tr}  th=${th}`;
    }).join('\n');
    list.textContent = rows;
  }

  // Returns the deployed (gate-passing) bundles for a family, summarized
  // for the "primed specialists" line on each card.
  function deployedBundlesFor(family) {
    const status = bundleStatusByFamily[family] || {};
    const ths = modelThresholdsByFamily[family] || {};
    const aggs = bundleAggregateByFamily[family] || {};
    const out = [];
    for (const key of Object.keys(status)) {
      if (status[key] !== 'OK') continue;
      const a = aggs[key] || {};
      out.push({
        key,
        threshold: ths[key] || 0.65,
        winRate:   a.winRate || 0,
        pf:        a.profitFactor || 0,
        trades:    a.totalTestTrades || 0
      });
    }
    return out;
  }

  // ── Gate 2 Shadow Log Reader ─────────────────────────────────────────
  async function pollShadowLog() {
    const el = document.getElementById('shadow-log-body');
    if (!el) return;
    try {
      const res = await fetch('/api/shadow-log');
      if (!res.ok) { el.innerHTML = '<div style="color:var(--neon-red);padding:10px;">Shadow log unavailable</div>'; return; }
      const d = await res.json();
      if (!d.rows || d.rows.length === 0) {
        el.innerHTML = '<div style="color:var(--text-muted,#888);padding:10px;font-size:12px;">No shadow log entries yet. Start the server and wait for NT8 bar pushes.</div>';
        return;
      }
      // Header stats
      const hdr = document.getElementById('shadow-log-stats');
      if (hdr) {
        const agr = d.summary.agreementRate != null ? (d.summary.agreementRate * 100).toFixed(1) + '%' : '—';
        const fires = d.summary.gate2Fires || 0;
        const total = d.summary.total || 0;
        hdr.textContent = `${total} bars · ${fires} G2 fires · ${agr} agree w/ G1`;
      }
      // Table rows (newest first)
      el.innerHTML = d.rows.map(r => {
        const ts = r.ts ? new Date(r.ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'America/Los_Angeles' }) : '—';
        const sym = (r.symbol || '').replace('=F', '');
        const g1 = r.gate1Signal || 'FLAT';
        const g2 = r.gate2Signal || 'FLAT';
        const pat = r.gate2Pattern || '—';
        const g1Color = g1 === 'BUY' ? 'var(--neon-green)' : g1 === 'SELL' ? 'var(--neon-red)' : 'rgba(255,255,255,0.35)';
        const g2Color = g2 === 'BUY' ? 'var(--neon-green)' : g2 === 'SELL' ? 'var(--neon-red)' : 'rgba(255,255,255,0.35)';
        const agree = r.agrees;
        const agreeHtml = agree === true ? '<span style="color:var(--neon-green)">✓</span>'
                        : agree === false ? '<span style="color:var(--neon-red)">✗</span>'
                        : '<span style="color:rgba(255,255,255,0.3)">—</span>';
        const px = r.close ? r.close.toFixed(2) : '—';
        return `<tr style="font-size:11px; font-family:'Consolas',monospace;">
          <td style="color:rgba(255,255,255,0.5);white-space:nowrap;">${ts}</td>
          <td style="font-weight:700;">${sym}</td>
          <td style="color:${g1Color};">${g1}</td>
          <td style="color:${g2Color};">${g2}</td>
          <td style="color:var(--cyan-glow,#0ff);">${pat}</td>
          <td>${agreeHtml}</td>
          <td style="color:rgba(255,255,255,0.6);">${px}</td>
        </tr>`;
      }).join('');
    } catch (e) {
      const el2 = document.getElementById('shadow-log-body');
      if (el2) el2.innerHTML = '<tr><td colspan="7" style="color:var(--neon-red);padding:10px;">Error loading shadow log</td></tr>';
    }
  }

  // ── Boot ───────────────────────────────────────────────────────────────
  setInterval(pollEvents, 1500);
  setInterval(pollPaperStats, 10000);
  setInterval(pollModelStatus, 15000);
  setInterval(pollExitsConfig, 30000);
  setInterval(pollShadowLog, 30000);
  pollEvents();
  pollPaperStats();
  pollModelStatus();
  pollExitsConfig();
  pollShadowLog();

  // Refresh Exits tab whenever it becomes the active view
  const _origSwitchTab = window.switchTab;
  if (typeof _origSwitchTab === 'function') {
    window.switchTab = function (tabName) {
      _origSwitchTab(tabName);
      if (tabName === 'exits') pollExitsConfig();
    };
  }
})();
