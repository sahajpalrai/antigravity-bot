// Reactive Web Dashboard controller for V1 Antigravity Smart Bot

let apiState = null;

// Fetch and update dashboard state
async function updateDashboard() {
  try {
    const res = await fetch('/api/state');
    if (!res.ok) throw new Error('API failure');
    const data = await res.json();
    
    apiState = data;
    renderKPIs(data);
    renderAccounts(data.accounts);
    renderPositions(data.accounts);
    renderNews(data.news);
    renderYahooNews(data.yahooNews);
    renderTradeHistory(data.history);
    renderRegime(data.regime, data.schedule);
    
    // Update config inputs if values exist
    if (data.tastytradeId) {
      document.getElementById('tt-client-id').value = data.tastytradeId;
    }

    // Dynamic synchronization of the universal slider switch and label state
    const anyPropMode = Object.values(data.accounts).some(acc => acc.mode !== 'Standard');
    const toggleInput = document.getElementById('global-account-type-toggle');
    const labelStandard = document.getElementById('label-switch-standard');
    const labelProp = document.getElementById('label-switch-prop');
    const sectionTitle = document.getElementById('accounts-section-title');

    if (toggleInput) {
      toggleInput.checked = anyPropMode;
    }
    if (anyPropMode) {
      if (labelStandard) labelStandard.classList.remove('active');
      if (labelProp) labelProp.classList.add('active');
      if (sectionTitle) sectionTitle.textContent = 'Futures Funded Accounts (Prop trailing drawdown active)';
    } else {
      if (labelStandard) labelStandard.classList.add('active');
      if (labelProp) labelProp.classList.remove('active');
      if (sectionTitle) sectionTitle.textContent = 'Futures Personal Accounts (Universal Broker Mode)';
    }
  } catch (err) {
    console.error('[Dashboard] State fetch error:', err.message);
  }
}

// Render Master KPIs
function renderKPIs(data) {
  const equityElement = document.getElementById('kpi-equity');
  const balanceElement = document.getElementById('kpi-balance');
  const openPnLElement = document.getElementById('kpi-open-pnl');
  const activeTradesElement = document.getElementById('kpi-active-trades');
  const progressElement = document.getElementById('kpi-progress');

  equityElement.textContent = formatCurrency(data.totalEquity);
  balanceElement.textContent = formatCurrency(data.totalBalance);
  
  // Format Open P&L with positive/negative colors
  openPnLElement.textContent = (data.totalOpenPnL >= 0 ? '+' : '') + formatCurrency(data.totalOpenPnL);
  openPnLElement.className = 'value ' + (data.totalOpenPnL > 0 ? 'profit' : (data.totalOpenPnL < 0 ? 'loss' : 'neutral'));

  // Count active open positions
  let activeCount = 0;
  for (const sym of Object.keys(data.accounts)) {
    if (data.accounts[sym].activePosition) activeCount++;
  }
  activeTradesElement.textContent = activeCount;

  // Calculate Progress toward $53,000 APX target (on a $50,000 base)
  // Target profit is $3,000
  const profitMade = Math.max(0, data.totalBalance - 200000); // base for 4 accounts is $200k
  const totalTarget = 12000; // 4 accounts * $3000 = $12k total profit target
  const percent = Math.min(100, (profitMade / totalTarget) * 100);
  progressElement.style.width = `${percent}%`;
}

// Render Futures Sub-Accounts
function renderAccounts(accounts) {
  const container = document.getElementById('accounts-container');
  container.innerHTML = '';

  const symbols = ['NQ=F', 'ES=F', 'CL=F', 'GC=F'];
  
  symbols.forEach(sym => {
    const acc = accounts[sym];
    if (!acc) return;

    const cleanSymbol = sym.replace('=F', '');
    const activePosText = acc.activePosition ? `${acc.activePosition.direction} @ ${acc.activePosition.entryPrice.toFixed(2)} (${acc.activePosition.strategyUsed})` : 'None';
    
    // Determine active trading strategies primed under current session regime
    const isRTH = apiState && apiState.regime && apiState.regime.code === 'RTH';
    let strategiesHTML = '';
    if (isRTH) {
      strategiesHTML = `
        <div style="margin-top: 12px; padding-top: 10px; border-top: 1px dashed rgba(255,255,255,0.08);">
          <span style="font-size: 11px; color: var(--text-secondary); display: block; margin-bottom: 6px;">⚡ Primed Strategies (RTH Trend):</span>
          <div style="display: flex; flex-wrap: wrap; gap: 4px;">
            <span class="strategy-badge trend" title="Opening Range Breakout">ORB Breakout</span>
            <span class="strategy-badge trend" title="VWAP Pullback & Trend Continuation">VWAP Pullback</span>
            <span class="strategy-badge trend" title="Fair Value Gap / Silver Bullet">FVG Breakout</span>
            <span class="strategy-badge trend" title="EMA Crossover Trend Following">EMA Crossover</span>
            <span class="strategy-badge trend" title="Supertrend & Momentum">Supertrend</span>
          </div>
        </div>
      `;
    } else {
      strategiesHTML = `
        <div style="margin-top: 12px; padding-top: 10px; border-top: 1px dashed rgba(255,255,255,0.08);">
          <span style="font-size: 11px; color: var(--text-secondary); display: block; margin-bottom: 6px;">⚡ Primed Strategies (ETH Reversion):</span>
          <div style="display: flex; flex-wrap: wrap; gap: 4px;">
            <span class="strategy-badge reversion" title="Bollinger Bands Mean Reversion">BB Reversion</span>
            <span class="strategy-badge reversion" title="Stochastic & RSI Confluence">Stoch & RSI</span>
          </div>
        </div>
      `;
    }
    
    // Determine status badge
    let statusClass = 'badge active';
    let statusText = acc.status;
    
    if (acc.status === 'FAILED') {
      statusClass = 'badge failed';
      statusText = 'LIQUIDATED';
    } else if (acc.mode === 'Standard') {
      statusClass = 'badge regular';
      statusText = 'REGULAR ACTIVE';
    } else if (acc.passed) {
      statusClass = 'badge passed';
      statusText = `${acc.mode} PASSED`;
    } else {
      statusText = `${acc.mode} ACTIVE`;
    }

    // Custom layout blocks based on regular vs prop mode
    let drawdownHTML = '';
    let visualMeterHTML = '';
    
    if (acc.mode !== 'Standard') {
      const drawdownFloorText = formatCurrency(acc.drawdownFloor);
      const drawdownStyle = 'color: var(--neon-red);';
      drawdownHTML = `<p>Drawdown Floor: <strong style="${drawdownStyle}">${drawdownFloorText}</strong></p>`;
      
      // APX Trailing drawdown buffer calculations
      const totalRiskWindow = 2500; // DRAWDOWN_LIMIT is $2500
      const currentRiskRoom = Math.max(0, acc.balance - acc.drawdownFloor);
      const safetyPercent = Math.min(100, (currentRiskRoom / totalRiskWindow) * 100);
      const barColor = safetyPercent > 60 ? 'linear-gradient(to right, var(--neon-orange), var(--neon-green))' : 'linear-gradient(to right, var(--neon-red), var(--neon-orange))';
      const safetyText = safetyPercent > 60 ? 'Healthy' : (safetyPercent > 20 ? 'Warning' : 'CRITICAL');
      const safetyTextColor = safetyPercent > 60 ? 'var(--neon-green)' : (safetyPercent > 20 ? 'var(--neon-orange)' : 'var(--neon-red)');
      
      visualMeterHTML = `
        <div style="margin-top: 14px; margin-bottom: 14px; padding-top: 10px; border-top: 1px dashed rgba(255,255,255,0.08);">
          <div style="display:flex; justify-content:space-between; font-size: 11px; color: var(--text-secondary); margin-bottom: 6px;">
            <span>Drawdown safety buffer:</span>
            <span style="color: ${safetyTextColor}; font-weight:800;">${safetyPercent.toFixed(0)}% (${safetyText})</span>
          </div>
          <div class="progress-container" style="background: rgba(255,255,255,0.05); height: 6px; border-radius: 3px; overflow: hidden;">
            <div class="progress-bar" style="width: ${safetyPercent}%; background: ${barColor}; height: 100%; border-radius: 3px; transition: width 0.4s ease;"></div>
          </div>
        </div>
      `;
    } else {
      drawdownHTML = `<p>Account Type: <strong style="color: var(--secondary-glow); font-weight:600;">Personal Broker</strong></p>`;
      
      // Standard personal account balance safety meter
      visualMeterHTML = `
        <div style="margin-top: 14px; margin-bottom: 14px; padding-top: 10px; border-top: 1px dashed rgba(255,255,255,0.08);">
          <div style="display:flex; justify-content:space-between; font-size: 11px; color: var(--text-secondary); margin-bottom: 6px;">
            <span>Daily Loss Limit:</span>
            <span style="color: var(--neon-green); font-weight:800;">Bypassed</span>
          </div>
          <div class="progress-container" style="background: rgba(57, 255, 20, 0.05); height: 6px; border-radius: 3px; overflow: hidden;">
            <div class="progress-bar" style="width: 100%; background: linear-gradient(to right, #00c6ff, #0072ff); height: 100%; border-radius: 3px;"></div>
          </div>
        </div>
      `;
    }

    const realizedPnL = acc.realizedPnL !== undefined ? acc.realizedPnL : 0;
    const unrealizedPnL = acc.unrealizedPnL !== undefined ? acc.unrealizedPnL : 0;
    const totalPnL = acc.totalPnL !== undefined ? acc.totalPnL : 0;

    const realizedStyle = realizedPnL > 0 ? 'color: var(--neon-green); font-weight:600;' : (realizedPnL < 0 ? 'color: var(--neon-red); font-weight:600;' : 'color: var(--text-secondary);');
    const openStyle = unrealizedPnL > 0 ? 'color: var(--neon-green); font-weight:600;' : (unrealizedPnL < 0 ? 'color: var(--neon-red); font-weight:600;' : 'color: var(--text-secondary);');
    const totalStyle = totalPnL > 0 ? 'color: var(--neon-green); font-weight:800;' : (totalPnL < 0 ? 'color: var(--neon-red); font-weight:800;' : 'color: var(--text-secondary);');

    const realizedSign = realizedPnL > 0 ? '+' : '';
    const openSign = unrealizedPnL > 0 ? '+' : '';
    const totalSign = totalPnL > 0 ? '+' : '';

    const card = document.createElement('div');
    card.className = 'glass-card account-card glow-on-hover';
    card.innerHTML = `
      <div class="account-card-header" style="flex-direction: column; align-items: flex-start; gap: 6px;">
        <div style="display:flex; justify-content:space-between; width: 100%; align-items:center;">
          <h4 style="margin: 0; font-size: 15px; font-weight:800;">${cleanSymbol} Account</h4>
          <span class="${statusClass}">${statusText}</span>
        </div>
        <div style="font-size: 11px; color: var(--text-secondary); display:flex; align-items:center; gap: 6px; margin-top: 4px;">
          <span style="display: inline-flex; align-items: center; gap: 4px;">🔗 Attached Account:</span>
          <span contenteditable="true" 
                class="editable-account-id" 
                style="color: var(--secondary-glow); font-weight:800; border-bottom: 1px dashed rgba(33, 150, 243, 0.4); cursor: pointer; outline: none; padding: 0 4px; border-radius: 3px; transition: all 0.2s;" 
                onblur="submitAccountNumberChange('${sym}', this.textContent)"
                onkeydown="handleAccountIdKey(event, this)">${acc.accountNumber || 'APX-NQ-50K-01'}</span>
        </div>
      </div>
      <div class="account-details">
        <p>Current Balance: <strong>${formatCurrency(acc.balance)}</strong></p>
        <p>Peak Equity: <strong>${formatCurrency(acc.peakEquity)}</strong></p>
        ${drawdownHTML}
        
        <!-- Live Trading Performance Rows -->
        <p>Realized P&L: <strong style="${realizedStyle}">${realizedSign}${formatCurrency(realizedPnL)}</strong></p>
        <p>Open Trade P&L: <strong style="${openStyle}">${openSign}${formatCurrency(unrealizedPnL)}</strong></p>
        <p style="border-bottom: 1px solid rgba(255,255,255,0.06); padding-bottom: 8px;">Total Net P&L: <strong style="${totalStyle}">${totalSign}${formatCurrency(totalPnL)}</strong></p>
        
        <p style="margin-top: 8px;">Open Position: <strong style="color: ${acc.activePosition ? 'var(--neon-green)' : 'var(--text-secondary)'};">${activePosText}</strong></p>
        ${visualMeterHTML}
        ${strategiesHTML}
        
        <!-- Premium Custom Segmented Control for Broker Account Mode -->
        <div style="margin-top: 14px; padding-top: 10px; border-top: 1px solid var(--border-light);">
          <label style="font-size: 11px; color: var(--text-secondary); display: block; margin-bottom: 6px;">Broker Mode Selection:</label>
          <div class="broker-mode-segmented">
            <button class="mode-pill-btn ${acc.mode === 'Standard' ? 'active-standard' : ''}" onclick="setAccountMode('${sym}', 'Standard')">Personal</button>
            <button class="mode-pill-btn ${acc.mode === 'Evaluation' ? 'active-evaluation' : ''}" onclick="setAccountMode('${sym}', 'Evaluation')">APX Eval</button>
            <button class="mode-pill-btn ${acc.mode === 'PA' ? 'active-pa' : ''}" onclick="setAccountMode('${sym}', 'PA')">APX PA</button>
          </div>
        </div>
      </div>
    `;

    // Add Transition to PA button if passed and still in Evaluation
    if (acc.passed && acc.mode === 'Evaluation') {
      const button = document.createElement('button');
      button.className = 'btn btn-primary';
      button.style.width = '100%';
      button.style.marginTop = '12px';
      button.style.padding = '8px';
      button.style.fontSize = '11px';
      button.textContent = '🚀 Transition to PA Account';
      button.onclick = () => transitionToPA(sym);
      card.appendChild(button);
    }

    container.appendChild(card);
  });
}

// Render Positions Table
function renderPositions(accounts) {
  const tbody = document.getElementById('positions-table-body');
  tbody.innerHTML = '';

  let hasPositions = false;

  for (const sym of Object.keys(accounts)) {
    const acc = accounts[sym];
    const pos = acc.activePosition;
    if (!pos) continue;

    hasPositions = true;
    const cleanSym = sym.replace('=F', '');
    const tr = document.createElement('tr');
    
    const pnlClass = pos.unrealizedPnL > 0 ? 'profit' : (pos.unrealizedPnL < 0 ? 'loss' : 'neutral');
    const pnlSign = pos.unrealizedPnL >= 0 ? '+' : '';
    
    tr.innerHTML = `
      <td>
        <strong>${cleanSym}</strong>
        <span class="position-account-badge" title="Attached Account">${acc.accountNumber || 'APX-NQ-50K-01'}</span>
      </td>
      <td style="color: ${pos.direction === 'Long' ? 'var(--neon-green)' : 'var(--neon-red)'}; font-weight: 600;">${pos.direction}</td>
      <td>${pos.qty}</td>
      <td>${pos.entryPrice.toFixed(2)}</td>
      <td id="price-${cleanSym}">-</td>
      <td>
        <span style="font-size: 11px; display:block;">SL: ${pos.stopLoss.toFixed(2)}</span>
        <span style="font-size: 11px; display:block; color: var(--text-secondary);">TP: ${pos.takeProfit.toFixed(2)}</span>
      </td>
      <td class="${pnlClass}" style="font-weight:600;">${pnlSign}${formatCurrency(pos.unrealizedPnL)}</td>
      <td>
        <button class="btn btn-secondary" style="padding: 6px 12px; font-size: 11px;" onclick="forceClosePosition('${sym}')">Close</button>
      </td>
    `;
    tbody.appendChild(tr);
  }

  if (!hasPositions) {
    tbody.innerHTML = `<tr><td colspan="8" class="text-center text-muted py-4">No active positions. Monitoring strategies...</td></tr>`;
  }
}

// Render News Events
function renderNews(news) {
  const container = document.getElementById('news-events-container');
  if (!news || !news.events || news.events.length === 0) {
    container.innerHTML = `<div class="text-muted text-center py-4">No high-impact economic news scheduled.</div>`;
    return;
  }

  container.innerHTML = '';

  // Add suspension banner if news block is active
  if (news.suspensionActive) {
    const banner = document.createElement('div');
    banner.style.background = 'rgba(255, 56, 56, 0.15)';
    banner.style.border = '1px solid var(--neon-red)';
    banner.style.borderRadius = '8px';
    banner.style.padding = '10px';
    banner.style.fontSize = '12px';
    banner.style.fontWeight = '600';
    banner.style.color = 'var(--neon-red)';
    banner.style.marginBottom = '12px';
    banner.style.textAlign = 'center';
    banner.textContent = `🛑 Trading Suspended: ${news.reason}`;
    container.appendChild(banner);
  } else if (news.nextNewsEvent) {
    const banner = document.createElement('div');
    banner.style.background = 'rgba(255, 152, 0, 0.1)';
    banner.style.border = '1px solid var(--neon-orange)';
    banner.style.borderRadius = '8px';
    banner.style.padding = '8px';
    banner.style.fontSize = '12px';
    banner.style.color = 'var(--neon-orange)';
    banner.style.marginBottom = '12px';
    banner.style.textAlign = 'center';
    banner.textContent = `⏳ High Impact ${news.nextNewsEvent.title} in ${news.nextNewsEvent.timeRemainingMins} mins`;
    container.appendChild(banner);
  }

  // Define impact order hierarchy
  const impactWeights = { 'High': 3, 'Medium': 2, 'Low': 1 };

  // Sort events: 1. High Impact First, 2. Closest time proximity
  const sortedEvents = [...news.events].sort((a, b) => {
    const weightA = impactWeights[a.impact] || 0;
    const weightB = impactWeights[b.impact] || 0;
    
    if (weightA !== weightB) {
      return weightB - weightA; // Higher weight on top
    }
    
    // If same weight, sort by time difference (closest to now on top)
    const timeA = new Date(a.dateTime).getTime();
    const timeB = new Date(b.dateTime).getTime();
    const now = Date.now();
    return Math.abs(timeA - now) - Math.abs(timeB - now);
  });

  sortedEvents.forEach(event => {
    const cleanTime = new Date(event.dateTime).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    
    // Calculate elapsed/remaining time indicators
    const now = new Date();
    const eventTime = new Date(event.dateTime);
    const diffMs = eventTime.getTime() - now.getTime();
    const diffMins = Math.round(diffMs / (60 * 1000));
    
    let timeLabel = '';
    let timeColorClass = 'text-muted';

    if (diffMins === 0) {
      timeLabel = 'JUST NOW';
      timeColorClass = 'color: var(--neon-green); font-weight: 800;';
    } else if (diffMins > 0) {
      // Future event
      timeColorClass = 'color: var(--text-secondary);';
      if (diffMins < 60) {
        timeLabel = `in ${diffMins}m`;
      } else {
        timeLabel = `in ${(diffMins / 60).toFixed(1)}h`;
      }
    } else {
      // Past event
      const absMins = Math.abs(diffMins);
      if (absMins < 60) {
        timeLabel = `${absMins}m ago`;
        // High impact news that is recent (under 30m) gets highlighted
        if (event.impact === 'High' && absMins <= 30) {
          timeColorClass = 'color: var(--neon-red); font-weight: 600;';
        } else {
          timeColorClass = 'color: var(--neon-orange);';
        }
      } else {
        timeLabel = `${(absMins / 60).toFixed(1)}h ago`;
        timeColorClass = 'color: var(--text-secondary);';
      }
    }

    const item = document.createElement('div');
    item.className = 'news-item';
    item.style.display = 'flex';
    item.style.justifyContent = 'space-between';
    item.style.alignItems = 'center';
    item.innerHTML = `
      <div class="news-item-left">
        <span class="news-item-title">${event.title}</span>
        <span class="news-item-sub">${event.country} • Today @ ${cleanTime}</span>
      </div>
      <div style="display: flex; align-items: center; gap: 12px;">
        <span style="font-size: 11px; ${timeColorClass}">${timeLabel}</span>
        <span class="news-impact-tag ${event.impact.toLowerCase()}">${event.impact}</span>
      </div>
    `;
    container.appendChild(item);
  });
}

// Render Yahoo Finance Live News
function renderYahooNews(yahooNews) {
  const container = document.getElementById('yahoo-news-container');
  if (!yahooNews || yahooNews.length === 0) {
    container.innerHTML = `<div class="text-muted text-center py-4">No live financial news available.</div>`;
    return;
  }

  container.innerHTML = '';
  
  // Sort by calculated impact hierarchy first, then recency
  const impactWeights = { 'High': 3, 'Medium': 2, 'Low': 1 };
  const sortedNews = [...yahooNews].sort((a, b) => {
    const weightA = impactWeights[a.impact] || 1;
    const weightB = impactWeights[b.impact] || 1;
    
    if (weightA !== weightB) {
      return weightB - weightA; // Float higher impact to top
    }
    
    // Sort by publication timestamp
    return new Date(b.pubDate) - new Date(a.pubDate);
  });

  sortedNews.forEach(item => {
    const now = new Date();
    const pubDate = new Date(item.pubDate);
    const diffMs = now.getTime() - pubDate.getTime();
    const diffMins = Math.round(diffMs / (60 * 1000));
    
    let timeLabel = '';
    let timeColorClass = 'color: var(--text-secondary);';
    
    if (diffMins <= 0) {
      timeLabel = 'JUST NOW';
      timeColorClass = 'color: var(--neon-green); font-weight: 800;';
    } else if (diffMins < 60) {
      timeLabel = `${diffMins}m ago`;
      if (diffMins <= 15) {
        timeColorClass = 'color: var(--neon-green); font-weight: 600;';
      } else {
        timeColorClass = 'color: var(--neon-orange);';
      }
    } else {
      const hours = Math.round(diffMins / 60);
      timeLabel = `${hours}h ago`;
    }

    const cleanTime = pubDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    
    const div = document.createElement('div');
    div.className = 'news-item';
    div.style.display = 'flex';
    div.style.flexDirection = 'column';
    div.style.gap = '6px';
    div.style.cursor = 'pointer';
    div.onclick = () => window.open(item.link || 'https://finance.yahoo.com', '_blank');
    
    // Custom label classes for news impact
    const impactClass = item.impact ? item.impact.toLowerCase() : 'low';
    
    div.innerHTML = `
      <div style="font-size: 13px; font-weight: 600; line-height: 1.4; color: var(--text-primary);">${item.title}</div>
      <div style="display: flex; justify-content: space-between; align-items: center; font-size: 11px;">
        <span style="color: var(--text-secondary);">Yahoo Finance • Today @ ${cleanTime}</span>
        <div style="display: flex; align-items: center; gap: 8px;">
          <span style="${timeColorClass}">${timeLabel}</span>
          <span class="news-impact-tag ${impactClass}" style="font-size: 9px; padding: 2px 6px;">${item.impact || 'Low'}</span>
        </div>
      </div>
    `;
    container.appendChild(div);
  });
}

// Render Trade History
function renderTradeHistory(history) {
  const container = document.getElementById('trade-history-container');
  if (!history || history.length === 0) {
    container.innerHTML = `<div class="text-muted text-center py-4">No closed trades recorded yet.</div>`;
    return;
  }

  container.innerHTML = '';
  history.slice(0, 10).forEach(trade => {
    const sign = trade.profit >= 0 ? '+' : '';
    const winClass = trade.profit >= 0 ? 'win' : 'loss';
    const cleanSym = trade.symbol.replace('=F', '');
    
    const accountStr = trade.accountNumber ? ` <span class="log-account-badge">${trade.accountNumber}</span>` : '';
    const timeStr = new Date(trade.exitTime).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

    const item = document.createElement('div');
    item.className = 'log-item';
    item.innerHTML = `
      <div class="log-item-details">
        <span style="font-size: 13px; font-weight:600; display: flex; align-items: center; gap: 8px;">
          ${cleanSym} • ${trade.direction} (${trade.qty} Contracts) ${accountStr}
        </span>
        <span style="font-size: 11px; color: var(--text-secondary);">${trade.strategyUsed} • ${trade.reason} @ ${timeStr}</span>
      </div>
      <div class="log-item-profit ${winClass}">${sign}${formatCurrency(trade.profit)}</div>
    `;
    container.appendChild(item);
  });
}

// Render RTH/ETH regimes
function renderRegime(regime, schedule) {
  const textElement = document.getElementById('regime-text');
  const badgeElement = document.getElementById('regime-badge');
  const pulseElement = document.getElementById('regime-pulse');
  
  const scheduleText = document.getElementById('schedule-text');
  const scheduleBadge = document.getElementById('schedule-badge');

  textElement.textContent = regime.name;

  if (regime.code === 'RTH') {
    pulseElement.className = 'pulse-dot active';
    badgeElement.style.border = '1px solid rgba(57, 255, 20, 0.3)';
  } else {
    pulseElement.className = 'pulse-dot warning';
    badgeElement.style.border = '1px solid rgba(255, 152, 0, 0.3)';
  }

  scheduleText.textContent = schedule.reason;
  if (schedule.isClosed) {
    scheduleBadge.style.color = 'var(--neon-red)';
    scheduleBadge.style.border = '1px solid rgba(255, 56, 56, 0.3)';
    scheduleBadge.style.background = 'rgba(255, 56, 56, 0.05)';
  } else {
    scheduleBadge.style.color = 'var(--neon-green)';
    scheduleBadge.style.border = '1px solid rgba(57, 255, 20, 0.3)';
    scheduleBadge.style.background = 'rgba(57, 255, 20, 0.05)';
  }
}

// Actions & API posts
async function transitionToPA(symbol) {
  if (confirm(`Are you sure you want to transition ${symbol} to PA Account? This will reset the PA balance to $50,000 and lock the risk drawdown floor forever at $50,100.`)) {
    try {
      const res = await fetch(`/api/transition`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol })
      });
      if (res.ok) {
        alert('PA transition successful!');
        updateDashboard();
      }
    } catch (e) {
      alert('Transition failed.');
    }
  }
}

async function setAccountMode(symbol, mode) {
  try {
    const res = await fetch(`/api/mode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol, mode })
    });
    if (res.ok) {
      console.log(`[Dashboard] Account ${symbol} mode changed to ${mode}`);
      updateDashboard();
    } else {
      alert('Failed to update broker mode.');
    }
  } catch (e) {
    console.error('[Dashboard] Error changing account mode:', e.message);
  }
}

async function forceClosePosition(symbol) {
  if (confirm(`Force close all active positions for ${symbol}?`)) {
    try {
      const res = await fetch(`/api/close`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol })
      });
      if (res.ok) {
        updateDashboard();
      }
    } catch (e) {
      alert('Close order failed.');
    }
  }
}

async function updateWebhookUrl(val) {
  try {
    await fetch(`/api/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: val })
    });
    console.log('[Dashboard] Webhook URL saved.');
  } catch (e) {}
}

async function runBacktester() {
  const box = document.getElementById('backtest-results');
  box.style.display = 'block';
  box.innerHTML = '📥 Loading local NinjaTrader 8 historical exports (falling back to Yahoo Finance if missing) and executing backtest...\n';

  try {
    const res = await fetch('/api/backtest', { method: 'POST' });
    if (!res.ok) throw new Error('Failed to run');
    const data = await res.json();
    box.innerHTML = data.results;
  } catch (err) {
    box.innerHTML = '❌ Backtest run failed. Verify your files are in the data/ folder.';
  }
}

async function runOptimizer() {
  const box = document.getElementById('backtest-results');
  const compContainer = document.getElementById('optimize-comparison');
  
  box.style.display = 'block';
  box.innerHTML = '🧠 Loading local NinjaTrader 8 5-min exports and executing walkforward ML grid search...';
  
  if (compContainer) {
    compContainer.style.display = 'none';
    compContainer.innerHTML = '';
  }

  try {
    const res = await fetch('/api/optimize', { method: 'POST' });
    if (!res.ok) throw new Error('Failed to run');
    const data = await res.json();
    box.innerHTML = data.results;
    
    // Render gorgeous visual transition grid if beforeAfter exists
    if (data.beforeAfter) {
      renderOptimizeComparison(data.beforeAfter);
    }
    
    updateDashboard();
  } catch (err) {
    box.innerHTML = '❌ Optimizer run failed.';
  }
}

// Renders a high-tech "Before & After" parameters threshold grid
function renderOptimizeComparison(beforeAfter) {
  const compContainer = document.getElementById('optimize-comparison');
  if (!compContainer) return;
  
  compContainer.style.display = 'block';
  compContainer.innerHTML = '';
  
  const title = document.createElement('h3');
  title.className = 'panel-title';
  title.style.color = 'var(--neon-orange)';
  title.style.marginTop = '24px';
  title.style.marginBottom = '16px';
  title.style.fontSize = '14px';
  title.style.fontWeight = '800';
  title.style.letterSpacing = '1px';
  title.textContent = '🧠 WALKFORWARD PARAMETER TRANSITIONS (BEFORE ➡️ AFTER)';
  compContainer.appendChild(title);
  
  const grid = document.createElement('div');
  grid.style.display = 'grid';
  grid.style.gridTemplateColumns = 'repeat(auto-fit, minmax(230px, 1fr))';
  grid.style.gap = '16px';
  
  const symbols = ['NQ=F', 'ES=F', 'CL=F', 'GC=F'];
  
  symbols.forEach(sym => {
    const cleanSym = sym.replace('=F', '');
    const beforeParams = beforeAfter.before[sym] || {};
    const afterParams = beforeAfter.after[sym] || {};
    
    const card = document.createElement('div');
    card.className = 'glass-card';
    card.style.padding = '18px';
    card.style.background = 'rgba(18, 22, 33, 0.6)';
    card.style.border = '1px solid var(--border-light)';
    card.style.borderRadius = '12px';
    
    let html = `
      <div style="font-weight: 800; font-size: 14px; color:#fff; border-bottom: 1px solid var(--border-light); padding-bottom: 8px; margin-bottom: 12px; display:flex; justify-content:space-between; align-items:center;">
        <span>${cleanSym} Parameter Tune</span>
        <span style="font-size: 9px; font-weight:800; background: rgba(255, 152, 0, 0.12); color: var(--neon-orange); border: 1px solid rgba(255, 152, 0, 0.25); padding: 2px 8px; border-radius: 4px; text-transform: uppercase;">Primed</span>
      </div>
      
      <div style="margin-bottom: 14px;">
        <span style="font-size: 11px; font-weight: 800; color: var(--neon-green); text-transform: uppercase; display:block; margin-bottom: 8px; letter-spacing: 0.5px;">☀️ RTH Session (Trend)</span>
    `;
    
    // RTH Parameters Crossovers comparison
    const rthBefore = beforeParams.RTH || {};
    const rthAfter = afterParams.RTH || {};
    const rthKeys = [
      { key: 'emaFast', label: 'EMA Fast' },
      { key: 'emaSlow', label: 'EMA Slow' }
    ];
    
    rthKeys.forEach(item => {
      const bVal = rthBefore[item.key] !== undefined ? rthBefore[item.key] : '-';
      const aVal = rthAfter[item.key] !== undefined ? rthAfter[item.key] : '-';
      const isChanged = bVal !== aVal && bVal !== '-';
      
      html += `
        <div style="display:flex; justify-content:space-between; font-size:12px; margin-bottom: 6px; color: var(--text-secondary);">
          <span>${item.label}:</span>
          <span>
            ${isChanged 
              ? `<span style="text-decoration: line-through; opacity: 0.5; margin-right: 6px;">${bVal}</span><span style="color: var(--neon-green); font-weight:800;">➡️ ${aVal}</span>` 
              : `<span style="opacity: 0.5; margin-right: 6px;">${bVal}</span><span style="opacity: 0.4; margin-right: 6px;">➡️</span><span style="color: var(--text-primary); font-weight:600;">${aVal}</span>`
            }
          </span>
        </div>
      `;
    });
    
    html += `
      </div>
      <div>
        <span style="font-size: 11px; font-weight: 800; color: var(--neon-orange); text-transform: uppercase; display:block; margin-bottom: 8px; letter-spacing: 0.5px;">🌙 ETH Session (Reversion)</span>
    `;
    
    // ETH Parameters Mean Reversion comparison
    const ethBefore = beforeParams.ETH || {};
    const ethAfter = afterParams.ETH || {};
    const ethKeys = [
      { key: 'bbStdDev', label: 'BB StdDev' },
      { key: 'rsiOversold', label: 'RSI Oversold' },
      { key: 'rsiOverbought', label: 'RSI Overbought' }
    ];
    
    ethKeys.forEach(item => {
      const bVal = ethBefore[item.key] !== undefined ? ethBefore[item.key] : '-';
      const aVal = ethAfter[item.key] !== undefined ? ethAfter[item.key] : '-';
      const isChanged = bVal !== aVal && bVal !== '-';
      
      html += `
        <div style="display:flex; justify-content:space-between; font-size:12px; margin-bottom: 6px; color: var(--text-secondary);">
          <span>${item.label}:</span>
          <span>
            ${isChanged 
              ? `<span style="text-decoration: line-through; opacity: 0.5; margin-right: 6px;">${bVal}</span><span style="color: var(--neon-orange); font-weight:800;">➡️ ${aVal}</span>` 
              : `<span style="opacity: 0.5; margin-right: 6px;">${bVal}</span><span style="opacity: 0.4; margin-right: 6px;">➡️</span><span style="color: var(--text-primary); font-weight:600;">${aVal}</span>`
            }
          </span>
        </div>
      `;
    });
    
    html += `</div>`;
    
    card.innerHTML = html;
    grid.appendChild(card);
  });
  
  compContainer.appendChild(grid);
}

// Tab Switching Controller (Fades and transitions active views)
function switchTab(tabName) {
  // 1. Remove active class from all tabs, add to active one
  document.querySelectorAll('.nav-tab').forEach(tab => {
    tab.classList.remove('active');
  });
  const activeTab = document.getElementById(`tab-${tabName}`);
  if (activeTab) activeTab.classList.add('active');

  // 2. Hide all tab view containers, show active container with fade-in
  document.querySelectorAll('.tab-view').forEach(view => {
    view.classList.remove('active');
    view.style.display = 'none';
  });
  const activeView = document.getElementById(`view-${tabName}`);
  if (activeView) {
    activeView.style.display = 'block';
    // Small timeout ensures transition re-triggers cleanly in browsers
    setTimeout(() => {
      activeView.classList.add('active');
    }, 10);
  }
}

// Helpers
function formatCurrency(val) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(val);
}

// Universal Sliding Switch Global Toggles
async function setAccountModeSilent(symbol, mode) {
  try {
    await fetch(`/api/mode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol, mode })
    });
  } catch (e) {
    console.error('[Dashboard] Error changing account mode:', e.message);
  }
}

async function toggleGlobalAccountType(isProp) {
  const symbols = ['NQ=F', 'ES=F', 'CL=F', 'GC=F'];
  const targetMode = isProp ? 'Evaluation' : 'Standard';
  
  const sectionTitle = document.getElementById('accounts-section-title');
  if (sectionTitle) {
    sectionTitle.textContent = 'Updating Account Modes...';
  }
  
  await Promise.all(symbols.map(sym => setAccountModeSilent(sym, targetMode)));
  await updateDashboard();
}

async function submitAccountNumberChange(symbol, newNumber) {
  if (!newNumber || !newNumber.trim()) return;
  try {
    const res = await fetch(`/api/account-number`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol, accountNumber: newNumber.trim() })
    });
    if (res.ok) {
      console.log(`[Dashboard] Account number for ${symbol} updated to: ${newNumber.trim()}`);
    }
  } catch (e) {
    console.error('[Dashboard] Failed to save account number:', e.message);
  }
}

function handleAccountIdKey(event, element) {
  if (event.key === 'Enter') {
    event.preventDefault();
    element.blur(); // Triggers onblur which saves
  }
}

// Start Update Interval (run every 2 seconds for highly reactive dashboard)
setInterval(updateDashboard, 2000);
updateDashboard();
