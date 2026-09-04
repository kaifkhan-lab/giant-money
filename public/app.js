/* Giant Money app — renders live API data only. No mock values anywhere. */

const $ = sel => document.querySelector(sel);
const state = { tab: 'dashboard', stock: null };

// ── helpers ────────────────────────────────────────────────────────────────
const fmt = {
  num(v, d = 2) {
    if (v == null || !isFinite(v)) return '—';
    return Number(v).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d > 0 ? Math.min(d, 2) : 0 });
  },
  int(v) { return v == null ? '—' : Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 }); },
  usd(v) {
    if (v == null || !isFinite(v)) return '—';
    const a = Math.abs(v), s = v < 0 ? '−' : '';
    if (a >= 1e12) return s + '$' + (a / 1e12).toFixed(2) + 'T';
    if (a >= 1e9) return s + '$' + (a / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return s + '$' + (a / 1e6).toFixed(2) + 'M';
    if (a >= 1e3) return s + '$' + (a / 1e3).toFixed(1) + 'K';
    return s + '$' + a.toFixed(2);
  },
  pct(v, signed = true) {
    if (v == null || !isFinite(v)) return '—';
    return (signed && v > 0 ? '+' : '') + v.toFixed(2) + '%';
  },
  date(d) { return d ? String(d).slice(0, 10) : '—'; },
  time(ts) {
    if (!ts) return '—';
    const diff = Date.now() - ts;
    if (diff < 60e3) return Math.max(1, Math.round(diff / 1e3)) + 's ago';
    if (diff < 3600e3) return Math.round(diff / 60e3) + 'm ago';
    if (diff < 86400e3) return Math.round(diff / 3600e3) + 'h ago';
    return new Date(ts).toLocaleDateString();
  },
};
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// decode stray HTML entities that arrived inside feed text (old stored rows)
const deent = s => String(s ?? '')
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&rsquo;|&apos;/g, "'").replace(/&ldquo;|&rdquo;/g, '"').replace(/&amp;/g, '&');
const cls = v => (v > 0 ? 'up' : v < 0 ? 'down' : '');
const titleCase = s => String(s ?? '').toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase());
const safe = (s, d) => { try { return JSON.parse(s) ?? d; } catch { return d; } };

const tk = t => t ? `<span class="tk" onclick="go('stock/${esc(t)}')">${esc(t)}</span>` : '';
const badge = s => s ? `<span class="badge ${String(s).toLowerCase().replace(/\s/g, '')}">${esc(s)}</span>` : '';
const scoreEl = v => `<span class="score-ring ${v >= 60 ? 'score-hi' : v <= 40 ? 'score-lo' : 'score-mid'}" title="Giant Money Score">${v}</span>`;
const pill = (label, up) => `<span class="pill ${up ? 'up' : 'down'}">${esc(label)}</span>`;
const party = p => p ? `<span class="party ${p[0] === 'D' ? 'D' : p[0] === 'R' ? 'R' : 'I'}">${esc(p[0])}</span>` : '';
const empty = msg => `<div class="empty">${esc(msg)}</div>`;

function avatar(photo, name, size = 32) {
  const initials = esc(String(name ?? '?').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase());
  const img = photo ? `<img src="${esc(photo)}" alt="" loading="lazy" onerror="this.remove()">` : '';
  return `<div class="avatar" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.34)}px"><span>${initials}</span>${img}</div>`;
}
function logoChip(ticker) {
  if (!ticker) return '<div class="logo-chip blank">—</div>';
  return `<div class="logo-chip"><img src="https://images.financialmodelingprep.com/symbol/${esc(ticker)}.png" alt="" loading="lazy" onerror="this.parentElement.classList.add('blank'); this.parentElement.textContent='${esc(ticker).slice(0, 3)}'"></div>`;
}
function person(photo, name, sub, size = 32) {
  return `<div class="person">${avatar(photo, name, size)}<div class="who"><div class="nm2">${esc(name)}</div>${sub ? `<div class="sub2">${sub}</div>` : ''}</div></div>`;
}
// big profile image — banks show their logo on white (contain), people show a portrait (cover)
function profilePic(photo, name, category, size = 84, ticker = null, country = null) {
  // banks: real company logo on a white tile (never the HQ building photo)
  if (category === 'investment_bank' && ticker) {
    return `<div class="prof-logo" style="width:${size}px;height:${size}px;background:#fff"><img src="https://images.financialmodelingprep.com/symbol/${esc(ticker)}.png" alt="${esc(name)}" style="width:${Math.round(size * 0.66)}px;height:${Math.round(size * 0.66)}px;object-fit:contain" onerror="this.parentElement.classList.add('blank'); this.parentElement.textContent='${esc(String(ticker).slice(0, 3))}'"></div>`;
  }
  // sovereign wealth funds: official emblem/logo on a white tile (from Wikipedia),
  // else the country flag — never a fake portrait
  if (category === 'sovereign_wealth' && photo) {
    return `<div class="prof-logo" style="width:${size}px;height:${size}px;background:#fff"><img src="${esc(photo)}" alt="${esc(name)}" style="width:${Math.round(size * 0.74)}px;height:${Math.round(size * 0.74)}px;object-fit:contain" onerror="this.parentElement.classList.add('blank'); this.parentElement.textContent='${esc(name.slice(0, 2))}'"></div>`;
  }
  if (category === 'sovereign_wealth') {
    return `<div class="prof-logo blank" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.42)}px">${esc(flagOf(country) || name.slice(0, 2))}</div>`;
  }
  return avatar(photo, name, size);
}

async function api(path, opts) {
  const init = opts ? {
    method: opts.method || 'GET',
    headers: opts.body ? { 'content-type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  } : undefined;
  const res = await fetch(path, init);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.json();
}

function listCard(title, rows, renderRow, note) {
  return `<div class="card tight">
    <h3 class="block-title">${esc(title)}</h3>
    ${rows?.length
      ? `<div class="rlist">${rows.map((r, i) => `<div class="rrow"><span class="rank">${i + 1}</span>${renderRow(r)}</div>`).join('')}</div>`
      : empty(note || 'No data in this window yet — the backend loop is still collecting.')}
  </div>`;
}

// ── routing ────────────────────────────────────────────────────────────────
window.go = hash => { location.hash = hash; };

function dispatch({ scroll = false } = {}) {
  let hash = (location.hash || '#dashboard').slice(1);
  // Battles disabled for now — send any battle route back to the dashboard
  if (hash === 'battles' || hash.startsWith('battles/') || hash === 'battle' || hash.startsWith('battle/')) {
    location.hash = '#dashboard'; return;
  }
  const [page, arg, arg2] = hash.split('/');
  const tab = ['dashboard', 'top1', 'politicians', 'insiders', 'stocks', 'news', 'watchlist', 'portfolio', 'profile', 'pricing'].includes(page)
    ? page
    : page === 'stock' || page === 'index' ? 'stocks' : page === 'fund' ? 'top1' : page === 'pol' ? 'politicians' : 'dashboard';
  state.tab = tab;
  document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('active', a.dataset.tab === tab));
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.id === `tab-${tab}`));
  if (scroll) window.scrollTo({ top: 0 });

  if (page === 'stock' && arg) { state.stock = decodeURIComponent(arg).toUpperCase(); state.index = null; loadStock(state.stock); }
  else if (page === 'index' && arg) { state.index = decodeURIComponent(arg).toUpperCase(); state.stock = null; loadIndex(state.index); }
  else if (page === 'fund' && arg) loadFund(arg);
  else if (page === 'pol' && arg) loadPolitician(arg);
  else {
    if (page === 'stocks') { state.stock = null; state.index = null; } // plain Stocks tab → trending
    loadTab(tab);
  }
}
const route = () => dispatch({ scroll: true });
window.addEventListener('hashchange', route);

// ── dashboard: markets ─────────────────────────────────────────────────────
async function loadOverview() {
  loadMacro();  // rates + crypto load alongside, never blocking the indexes
  const { indexes } = await api('/api/overview');
  if (!indexes.length) {
    $('#indexGrid').innerHTML = `<div class="loading">Waiting for the first market data cycle…</div>`;
    return;
  }
  const arrow = v => (v > 0 ? '▲' : v < 0 ? '▼' : '·');
  $('#indexGrid').innerHTML = indexes.map(ix => `
    <div class="card tight idx-card clickable" onclick="go('index/${encodeURIComponent(ix.symbol)}')" title="Open ${esc(ix.name)} chart">
      <div class="index-name">${esc(ix.name)} <span class="idx-open">›</span></div>
      <div class="idx-row">
        <div class="index-price">${fmt.num(ix.price)}</div>
        <div class="idx-change ${cls(ix.change_1d)}">${arrow(ix.change_1d)} ${fmt.pct(ix.change_1d)} <span class="idx-td">today</span></div>
      </div>
      ${(ix.change_1w != null || ix.change_1m != null) ? `<div class="idx-sub">
        ${ix.change_1w != null ? `<span>Week <b class="${cls(ix.change_1w)}">${fmt.pct(ix.change_1w)}</b></span>` : ''}
        ${ix.change_1m != null ? `<span>Month <b class="${cls(ix.change_1m)}">${fmt.pct(ix.change_1m)}</b></span>` : ''}
      </div>` : ''}
      <div class="index-meta">
        <span class="${ix.market_state === 'Open' ? 'mkt-open' : 'mkt-closed'}">● ${ix.market_state === 'Open' ? 'Market open' : 'Market closed'}</span>
        <span>${fmt.time(ix.updated_at)}</span>
      </div>
    </div>`).join('');
  $('#marketMeta').textContent = 'the 5 biggest US market gauges — green means up today, red means down';
}

// ── Institutional picks (one box, 1 Day / Weekly / Monthly) ─────────────────
let pickRange = '1d';
async function loadPicks() {
  const el = $('#pickList');
  el.innerHTML = `<div class="loading">Loading…</div>`;
  let d;
  try { d = await api(`/api/smart-picks?range=${pickRange}`); } catch (err) { el.innerHTML = empty(err.message); return; }
  const label = { '1d': 'the last 24 hours', '1w': 'the last 7 days', '1m': 'the last 30 days' }[d.range];
  if (!d.picks.length) {
    el.innerHTML = empty('No smart-money activity captured in this window yet — try Weekly or Monthly.');
    return;
  }

  const ICON = { fund: '🏦', insider: '💼', politician: '🏛' };
  const WHO = { fund: 'Big fund', insider: 'Company insider', politician: 'Politician' };
  const money = v => v == null ? '' : (v < 0 ? '−$' : '+$') + Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 0 });

  el.innerHTML = `
    <p class="pick-lead">Every stock below has had <b>real money move into it</b> in ${label} — a big fund
       filing a position change, a company executive buying their own shares, or a member of Congress
       disclosing a trade. The score just ranks how strong that activity is.</p>

    <div class="pick-grid">
      ${d.picks.map((r, i) => `
        <div class="pick-card clickable" onclick="go('stock/${esc(r.ticker)}')">
          <div class="pk-top">
            <span class="pk-rank">${i + 1}</span>
            ${tk(r.ticker)}
            <span class="pk-name">${esc(titleCase(r.company || r.name || ''))}</span>
            <span class="pk-score" title="Giant Money Score — how strong the smart-money activity is">${r.score == null ? '—' : Math.round(r.score)}</span>
          </div>

          <div class="pk-price">
            ${r.price != null ? `<b>$${fmt.num(r.price)}</b>` : '<b>—</b>'}
            ${r.change_pct != null ? `<span class="${cls(r.change_pct)}">${fmt.pct(r.change_pct)} today</span>` : ''}
          </div>

          ${r.reasons?.length ? `
            <div class="pk-why">
              <div class="pk-why-k">Who's behind it</div>
              ${r.reasons.slice(0, 3).map(x => `
                <div class="pk-reason">
                  <span class="pk-ic" title="${esc(WHO[x.kind])}">${ICON[x.kind]}</span>
                  <span class="pk-text">${esc(x.text)}</span>
                  <span class="pk-amt ${x.amount == null ? '' : x.amount >= 0 ? 'up' : 'down'}">${
                    x.amount != null ? money(x.amount) : esc(x.note || '')}</span>
                </div>`).join('')}
            </div>`
            : `<div class="pk-why"><div class="pk-reason muted">Ranked on news flow — no filed trade in this window.</div></div>`}
        </div>`).join('')}
    </div>

    <details class="pick-explain">
      <summary>What is the score?</summary>
      <p>The <b>Giant Money Score</b> (0–100) combines four real signals: how much company insiders
         bought versus sold, how big institutions changed their 13F positions, what politicians disclosed,
         and the tone of the news. A high score means several of those pointed the same way — it is a
         measure of <b>activity and agreement</b>, not a prediction, and never a recommendation.</p>
    </details>`;
}
$('#pickTabs')?.addEventListener('click', e => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  pickRange = chip.dataset.r;
  document.querySelectorAll('#pickTabs .chip').forEach(c => c.classList.toggle('active', c === chip));
  loadPicks();
});

// ── "Who Bought Before the News?" — detective cards ─────────────────────────
async function loadDetective() {
  const el = $('#detectiveGrid');
  let d;
  try { d = await api('/api/detective'); } catch (err) { el.innerHTML = empty(err.message); return; }
  if (!d.cases.length) {
    el.innerHTML = empty(`Checked ${d.checkedMovers} big movers today — no smart-money buys found in the ${d.windowDays} days before. Honest answer: nobody we track front-ran these moves.`);
    return;
  }
  el.innerHTML = d.cases.map(c => {
    const up = c.change_pct >= 0;
    const buyers = [
      ...c.insiders.map(i => `<div class="dt-buyer"><span class="dt-who">👤 ${esc(titleCase(i.insider_name))}</span>
        <span class="dt-role">${esc(String(i.insider_title ?? 'insider').slice(0, 22))}</span>
        <span class="dt-when">${fmt.date(i.trade_date)}</span>
        <span class="dt-amt">${i.value ? fmt.usd(i.value) : fmt.int(i.shares) + ' sh'}</span></div>`),
      ...c.funds.map(fu => `<div class="dt-buyer"><span class="dt-who">🏛 ${esc(fu.manager !== '—' ? fu.manager : fu.fund_name)}</span>
        <span class="dt-role">${fu.change_type === 'new' ? 'new position' : 'added'}</span>
        <span class="dt-when">${fmt.date(fu.filed_at)}</span>
        <span class="dt-amt">${fmt.usd(fu.delta)}</span></div>`),
      ...c.pols.map(po => `<div class="dt-buyer"><span class="dt-who">🏛 ${esc(po.name)}</span>
        <span class="dt-role">politician buy</span>
        <span class="dt-when">${fmt.date(po.trade_date)}</span>
        <span class="dt-amt">${esc(po.amount ?? '')}</span></div>`),
    ].join('');
    return `<div class="card dt-card clickable" onclick="go('stock/${esc(c.ticker)}')">
      <div class="dt-head">
        <span style="display:inline-flex;align-items:center;gap:9px">${logoChip(c.ticker)}<b class="dt-tk">${esc(c.ticker)}</b></span>
        <span class="dt-move ${up ? 'up' : 'down'}">${up ? '▲' : '▼'} ${fmt.pct(c.change_pct)} today</span>
      </div>
      <div class="dt-name">${esc(titleCase(c.name ?? c.ticker))}</div>
      ${c.news ? `<div class="dt-news">📰 ${esc(deent(c.news.title).slice(0, 90))}${c.news.title.length > 90 ? '…' : ''}<span class="dt-src">${esc(c.news.source ?? '')}</span></div>` : ''}
      <div class="dt-q">🕵️ Who bought in the ${d.windowDays} days before?</div>
      <div class="dt-list">${buyers}</div>
    </div>`;
  }).join('');
}

// ── insiders (shared by dashboard + insiders tab) ──────────────────────────
function insiderTable(title, rows) {
  return `<div class="card tight">
    <h3 class="block-title">${esc(title)}</h3>
    ${rows?.length ? `<div class="tbl-wrap"><table>
      <tr><th>Company</th><th>Insider</th><th>Role</th><th>Side</th>
          <th class="num">Shares</th><th class="num">Value</th><th>Date</th>
          <th class="num">@Trade</th><th class="num">Now</th><th class="num">Gain</th></tr>
      ${rows.slice(0, 12).map(t => `<tr>
        <td><span style="display:inline-flex;align-items:center;gap:8px">${logoChip(t.ticker)}${tk(t.ticker)}</span></td>
        <td>${esc(titleCase(t.insider_name).slice(0, 20))}</td>
        <td>${esc(String(t.insider_title).slice(0, 16))}</td>
        <td class="side-${t.side.toLowerCase()}">${t.side}</td>
        <td class="num">${fmt.int(t.shares)}</td>
        <td class="num">${fmt.usd(t.value)}</td>
        <td>${fmt.date(t.trade_date)}</td>
        <td class="num">${t.price ? '$' + fmt.num(t.price) : '—'}</td>
        <td class="num">${t.current_price ? '$' + fmt.num(t.current_price) : '—'}</td>
        <td class="num ${cls(t.gain_pct)}">${fmt.pct(t.gain_pct)}</td>
      </tr>`).join('')}
    </table></div>` : empty('No filings parsed in this window yet.')}
  </div>`;
}

function insiderTiles(d) {
  const buys = d.totals?.Buy ?? { total: 0, n: 0 };
  const sells = d.totals?.Sell ?? { total: 0, n: 0 };
  const share = buys.total + sells.total > 0 ? Math.max(4, Math.round((buys.total / (buys.total + sells.total)) * 100)) : 50;
  return `
    <div class="card tile"><div class="k">Insider Buys · 7d</div><div class="v up">${fmt.usd(buys.total)}</div><div class="n">${buys.n ?? 0} open-market purchases</div></div>
    <div class="card tile"><div class="k">Insider Sells · 7d</div><div class="v down">${fmt.usd(sells.total)}</div><div class="n">${sells.n ?? 0} open-market sales</div></div>
    <div class="card tile"><div class="k">Buy / Sell Balance</div><div class="bar" style="margin-top:22px"><div style="width:${share}%"></div></div>
      <div style="display:flex;justify-content:space-between;font-family:var(--mono);font-size:10.5px;color:var(--muted-2);margin-top:8px"><span>BUYS ${share}%</span><span>SELLS ${100 - share}%</span></div></div>
    <div class="card tile"><div class="k">Cluster Alerts · 48h</div><div class="v">${d.clusters?.length ?? 0}</div><div class="n">stocks with 3+ insiders trading</div></div>`;
}

function renderInsiders(d, ids) {
  $(ids.tiles).innerHTML = insiderTiles(d);
  $(ids.tables).innerHTML =
    insiderTable('Latest Insider Buys', d.latestBuys) +
    insiderTable('Latest Insider Sells', d.latestSells);

  if (ids.roles) {
    const roleRow = t => `${tk(t.ticker)}<span class="nm">${esc(titleCase(t.insider_name))} · ${esc(titleCase(t.company).slice(0, 18))}</span><span class="val">${fmt.usd(t.value)}</span>`;
    $(ids.roles).innerHTML =
      listCard('CEO Purchases', d.ceoBuys, roleRow) +
      listCard('CFO Purchases', d.cfoBuys, roleRow) +
      listCard('Director Purchases', d.directorBuys, roleRow);
  }
  if (ids.largeActive) {
    $(ids.largeActive).innerHTML =
      insiderTable('Large Insider Transactions (≥ $1M)', d.largeTransactions) +
      listCard('Most Active Insider Stocks (7d)', d.mostActive,
        r => `${tk(r.ticker)}<span class="nm">${esc(titleCase(r.company))}</span><span class="val"><b class="up">${r.buys}B</b> / <b class="down">${r.sells}S</b></span>`);
  }
  const rankRow = r => `${tk(r.ticker)}<span class="nm">${esc(titleCase(r.company).slice(0, 20))}</span><span class="val">${fmt.usd(r.total)}</span>`;
  $(ids.rankings).innerHTML =
    listCard('Top Insider Buying — Today', d.topBuyingToday, rankRow) +
    listCard('Top Insider Buying — This Week', d.topBuyingWeek, rankRow) +
    listCard('Top Insider Selling — Today', d.topSellingToday, rankRow) +
    listCard('Top Insider Selling — This Week', d.topSellingWeek, rankRow);

  if (ids.sentiment) {
    $(ids.sentiment).innerHTML = d.sentiment?.length
      ? `<div style="display:flex; flex-wrap:wrap; gap:10px">${d.sentiment.map(s =>
          `<div style="display:flex; align-items:center; gap:8px; padding:6px 10px; background:var(--panel-2); border-radius:10px">
             ${tk(s.ticker)} ${badge(s.insider_sentiment)} ${scoreEl(s.score)}</div>`).join('')}</div>`
      : empty('Sentiment appears once insider filings accumulate.');
  }
  if (ids.clusters) {
    $(ids.clusters).innerHTML = `<h3 class="block-title">Cluster Alerts — 3+ insiders in the same stock within 48h</h3>` +
      (d.clusters?.length
        ? `<div style="display:flex;flex-wrap:wrap;gap:10px">${d.clusters.map(c =>
            `<div style="display:flex;align-items:center;gap:9px;padding:8px 12px;background:var(--panel-2);border-radius:10px">
              ${logoChip(c.ticker)}${tk(c.ticker)}
              <span style="font-size:12px;color:var(--muted)">${c.insiders} insiders</span>
              <span class="pill sm ${c.buys >= c.sells ? 'up' : 'down'}">${c.buys}B / ${c.sells}S</span>
            </div>`).join('')}</div>`
        : empty('No insider clusters in the last 48 hours.'));
  }
}

async function loadInsidersTab() {
  const d = await api('/api/insiders');
  renderInsiders(d, {
    tiles: '#insTiles2', clusters: '#insClusters', tables: '#insTables2', roles: '#insRoles2',
    largeActive: '#insLargeActive2', rankings: '#insRankings2', sentiment: '#insSentiment2',
  });
}

// ── top 1% ─────────────────────────────────────────────────────────────────
const moveLabel = { new: 'New:', increased: 'Added', reduced: 'Trimmed', closed: 'Exited' };
const catLabel = { billionaire: 'Billionaire', hedge_fund: 'Hedge Fund', investment_bank: 'Investment Bank', sovereign_wealth: 'Sovereign Wealth Fund' };
// country flags for sovereign wealth funds (only countries we track)
const FLAG = {
  Norway: '🇳🇴', 'Saudi Arabia': '🇸🇦', 'United Arab Emirates': '🇦🇪', Singapore: '🇸🇬',
  'South Korea': '🇰🇷', 'United States': '🇺🇸', China: '🇨🇳', Qatar: '🇶🇦',
};
const flagOf = c => FLAG[c] ?? '';
let top1Funds = [];
let top1Filter = 'all';

// banks show their real company logo (white tile); people show their portrait;
// sovereign wealth funds show their official emblem/logo (from Wikipedia) on a white tile
function fundFace(f, size = 46) {
  if (f.category === 'investment_bank' && f.ticker) {
    return `<div class="logo-chip" style="width:${size}px;height:${size}px;border-radius:${Math.round(size * 0.26)}px;flex:none">
      <img src="https://images.financialmodelingprep.com/symbol/${esc(f.ticker)}.png" alt="" style="width:${Math.round(size * 0.7)}px;height:${Math.round(size * 0.7)}px"
        onerror="this.parentElement.classList.add('blank'); this.parentElement.textContent='${esc(f.ticker).slice(0, 3)}'"></div>`;
  }
  if (f.category === 'sovereign_wealth' && f.photo) {
    return `<div class="logo-chip" style="width:${size}px;height:${size}px;border-radius:${Math.round(size * 0.26)}px;flex:none">
      <img src="${esc(f.photo)}" alt="" style="width:${Math.round(size * 0.78)}px;height:${Math.round(size * 0.78)}px;object-fit:contain"
        onerror="this.parentElement.classList.add('blank'); this.parentElement.textContent='${esc(flagOf(f.country) || f.name.slice(0, 2))}'"></div>`;
  }
  if (f.category === 'sovereign_wealth') {
    return `<div class="logo-chip blank" style="width:${size}px;height:${size}px;border-radius:${Math.round(size * 0.26)}px;flex:none;font-size:${Math.round(size * 0.44)}px">${esc(flagOf(f.country) || f.name.slice(0, 2))}</div>`;
  }
  return avatar(f.photo, f.manager !== '—' ? f.manager : f.name, size);
}

function renderTop1Grid() {
  const funds = top1Filter === 'all' ? top1Funds : top1Funds.filter(f => f.category === top1Filter);
  $('#fundGrid').innerHTML = funds.length ? funds.map(f => {
    const mv = f.latestMove;
    const mvUp = mv && (mv.change_type === 'new' || mv.change_type === 'increased');
    return `
    <div class="card clickable fund-card" onclick="go('fund/${f.cik}')">
      <div style="display:flex; gap:12px; align-items:center">
        ${fundFace(f, 46)}
        <div style="min-width:0">
          <div style="font-family:var(--serif); font-size:17px; line-height:1.2">${esc(f.manager !== '—' ? f.manager : f.name)}</div>
          <div style="font-size:11.5px; color:var(--muted-2); overflow:hidden; text-overflow:ellipsis; white-space:nowrap">${f.category === 'sovereign_wealth' && f.country ? `<span class="swf-flag">${flagOf(f.country)}</span>${esc(f.country)} · state fund` : esc(f.name)}</div>
        </div>
      </div>
      <div style="display:flex; align-items:center; gap:8px; margin-top:14px; flex-wrap:wrap">
        <span class="aum">${fmt.usd(f.total_value)}</span>
        <span style="font-size:11px; color:var(--muted-3)">· ${f.holdings_count ?? '—'} stocks</span>
        <span class="cat ${f.category}" style="margin-left:auto">${esc(catLabel[f.category] ?? f.category)}</span>
      </div>
      ${mv ? `<div style="margin-top:12px">${pill(`${moveLabel[mv.change_type]} ${mv.ticker ?? titleCase(mv.issuer).slice(0, 12)}`, mvUp)}
        <span style="font-size:10.5px; color:var(--muted-3); margin-left:6px">filed ${esc(mv.filed_at ?? '')}</span></div>` : ''}
    </div>`;
  }).join('') : empty('No investors in this group yet.');
}

// filter chip clicks
$('#top1Filters')?.addEventListener('click', e => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  top1Filter = chip.dataset.cat;
  document.querySelectorAll('#top1Filters .chip').forEach(c => c.classList.toggle('active', c === chip));
  renderTop1Grid();
});

async function loadTop1() {
  const d = await api('/api/top1');
  $('#top1Main').style.display = '';
  $('#top1Detail').style.display = 'none';
  top1Funds = d.funds;
  renderTop1Grid();

  const chRow = c => `${tk(c.ticker)}<span class="nm">${esc(titleCase(c.issuer).slice(0, 18))} · ${esc(c.fund_name)}</span><span class="val ${c.new_value - c.old_value >= 0 ? 'up' : 'down'}">${fmt.usd(c.new_value - c.old_value)}</span>`;
  $('#fundChanges').innerHTML =
    listCard('New Positions', d.newPositions, chRow) +
    listCard('Closed Positions', d.closedPositions, chRow) +
    listCard('Position Increases', d.increasedPositions, chRow) +
    listCard('Position Reductions', d.reducedPositions, chRow);

  $('#fundFilings').innerHTML = d.recentFilings.length ? `<table>
    <tr><th>Fund</th><th>Form</th><th>Period</th><th>Filed</th><th class="num">Positions</th><th class="num">Total Value</th></tr>
    ${d.recentFilings.map(f => `<tr>
      <td>${esc(f.fund_name)}</td><td>${esc(f.form)}</td><td>${esc(f.period)}</td>
      <td>${esc(f.filed_at)}</td><td class="num">${fmt.int(f.holdings_count)}</td>
      <td class="num">${fmt.usd(f.total_value)}</td></tr>`).join('')}
  </table>` : empty('13F ingestion in progress — filings appear here as they are parsed from EDGAR.');
}

// ── Shadow Portfolio — "if you'd copied them a year ago" (paper backtest) ────
// 100% real: weights from official disclosures × real historical prices. A
// virtual/paper what-if, never a real trade — the note says so on every card.
const shadowMoney = v => (v < 0 ? '−$' : '$') + Math.round(Math.abs(v)).toLocaleString('en-US');

function shadowSpark(curve, uid) {
  if (!curve || curve.length < 2) return '';
  const vals = curve.map(p => p.value);
  const min = Math.min(...vals), max = Math.max(...vals);
  const w = 320, h = 56;
  const x = i => (i / (curve.length - 1)) * w;
  const y = v => h - 3 - ((v - min) / (max - min || 1)) * (h - 6);
  const pts = vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const up = vals.at(-1) >= vals[0];
  const color = up ? '#4fae86' : '#e0566a';
  return `<svg class="shadow-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
    <defs><linearGradient id="${uid}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${color}" stop-opacity=".24"/><stop offset="100%" stop-color="${color}" stop-opacity="0"/>
    </linearGradient></defs>
    <polygon points="${pts} ${w},${h} 0,${h}" fill="url(#${uid})"/>
    <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>
  </svg>`;
}

function shadowCard(payload) {
  const r = payload && payload.result;
  const subject = payload?.subject ?? 'them';
  if (!r) return `<div class="card shadow-card">
    <div class="shadow-eyebrow">◆ SHADOW PORTFOLIO · PAPER BACKTEST</div>
    <div class="shadow-empty">Not enough tradable price history to backtest ${esc(subject)} yet.</div>
  </div>`;
  const up = r.returnPct >= 0, col = up ? 'up' : 'down';
  const uid = 'sp' + Math.random().toString(36).slice(2, 8);
  const beat = r.benchmark ? r.returnPct > r.benchmark.returnPct : null;
  const contribs = (r.contributors || []).slice(0, 3).map(c =>
    `<span class="shadow-chip ${cls(c.contribution)}">${esc(c.ticker)} ${c.contribution >= 0 ? '+' : ''}${c.contribution}</span>`).join('');
  return `<div class="card shadow-card">
    <div class="shadow-eyebrow">◆ SHADOW PORTFOLIO · PAPER BACKTEST</div>
    <div class="shadow-lead">If you'd copied <b>${esc(subject)}</b> a year ago…</div>
    <div class="shadow-hero">
      <span class="shadow-base">${shadowMoney(r.base)}</span>
      <span class="shadow-arrow">→</span>
      <span class="shadow-end ${col}">${shadowMoney(r.endValue)}</span>
      <span class="shadow-ret ${col}">${up ? '+' : ''}${r.returnPct}%</span>
    </div>
    ${shadowSpark(r.curve, uid)}
    ${r.benchmark ? `<div class="shadow-bench">
      <span>S&amp;P 500, same window <b class="${cls(r.benchmark.returnPct)}">${r.benchmark.returnPct >= 0 ? '+' : ''}${r.benchmark.returnPct}%</b></span>
      <span class="shadow-badge ${beat ? 'win' : 'lose'}">${beat ? '▲ Beat the market' : '▼ Lagged the market'}</span>
    </div>` : ''}
    ${contribs ? `<div class="shadow-contribs"><span class="shadow-cl">Top drivers (pts)</span>${contribs}</div>` : ''}
    <div class="shadow-note">Virtual/paper backtest · ${r.holdingsUsed} holdings · ${esc(r.from)} → ${esc(r.to)}. Real disclosed holdings at real prices — not investment advice.</div>
  </div>`;
}

// additive & non-blocking: loads into a mount, silently no-ops on error
async function loadShadow(kind, id, mountSel, subjectHint) {
  const mount = $(mountSel);
  if (!mount) return;
  mount.innerHTML = `<div class="card shadow-card shadow-loading">
    <div class="shadow-eyebrow">◆ SHADOW PORTFOLIO · PAPER BACKTEST</div>
    <div class="shadow-empty">Running the backtest…${subjectHint ? ` <b>${esc(subjectHint)}</b>` : ''}</div></div>`;
  try {
    const d = await api(`/api/shadow/${kind}/${id}`);
    mount.innerHTML = shadowCard(d);
  } catch { mount.innerHTML = ''; }
}

async function loadFund(cik) {
  const d = await api(`/api/top1/${cik}`);
  $('#top1Main').style.display = 'none';
  const el = $('#top1Detail');
  el.style.display = '';
  const typeBadge = t => `<span class="badge ${t === 'new' || t === 'increased' ? 'bullish' : 'bearish'}">${t}</span>`;
  const mgrOrName = d.fund.manager && d.fund.manager !== '—' ? d.fund.manager : d.fund.name;
  const s = d.summary || {};
  const buyName = d.topBuy ? (d.topBuy.ticker || titleCase(d.topBuy.issuer).slice(0, 12)) : null;
  const sellName = d.topSell ? (d.topSell.ticker || titleCase(d.topSell.issuer).slice(0, 12)) : null;
  el.innerHTML = `
    <button class="back-btn" onclick="go('top1')">← All investors</button>
    <div class="card prof-card">
      <div class="prof-head">
        ${profilePic(d.fund.photo, mgrOrName, d.fund.category, 84, d.fund.ticker, d.fund.country)}
        <div class="prof-info">
          <h1 class="prof-name">${esc(mgrOrName)}</h1>
          <div class="prof-sub">${d.fund.country ? `<span class="swf-flag">${flagOf(d.fund.country)}</span>${esc(d.fund.country)} &nbsp;·&nbsp; ` : ''}${esc(d.fund.name)} &nbsp;·&nbsp; <span class="cat ${d.fund.category}">${esc(catLabel[d.fund.category] ?? d.fund.category)}</span></div>
        </div>
      </div>
      ${d.person?.bio ? `<div class="about-card" style="margin:16px 0 0">
        <div class="ab-k">About</div>
        <div class="ab-t">${esc(d.person.bio)}</div>
      </div>` : ''}
    </div>
    ${d.filing ? `<div class="grid cols-4" style="margin-top:14px">
      <div class="card tile"><div class="k">Portfolio Value</div><div class="v">${fmt.usd(d.filing.total_value)}</div><div class="n">13F for ${esc(d.filing.period)} · filed ${esc(d.filing.filed_at)}</div></div>
      <div class="card tile"><div class="k">Stocks Held</div><div class="v">${fmt.int(d.filing.holdings_count)}</div><div class="n">${s.new ?? 0} new · ${s.closed ?? 0} exited this quarter</div></div>
      <div class="card tile"><div class="k">Bought (this quarter)</div><div class="v up">${fmt.usd(s.bought)}</div><div class="n">${s.new ?? 0} new + ${s.increased ?? 0} added${buyName ? ` · top ${esc(buyName)}` : ''}</div></div>
      <div class="card tile"><div class="k">Sold (this quarter)</div><div class="v down">${fmt.usd(s.sold)}</div><div class="n">${s.reduced ?? 0} trimmed + ${s.closed ?? 0} exited${sellName ? ` · top ${esc(sellName)}` : ''}</div></div>
    </div>` : ''}
    <div id="fundShadow" style="margin-top:14px"></div>
    <h2 class="section">Portfolio &amp; Trades <span class="sub">every stock they hold and every buy/sell last quarter</span></h2>
    <div class="grid cols-2">
      <div class="card tight tbl-wrap">
        <h3 class="block-title">Portfolio Allocation — Latest Holdings</h3>
        ${d.holdings.length ? `<table>
          <tr><th>#</th><th>Issuer</th><th>Ticker</th><th class="num">Value</th><th class="num">Shares</th><th class="num">% Portfolio</th></tr>
          ${d.holdings.map((h, i) => `<tr>
            <td>${i + 1}</td><td>${esc(titleCase(h.issuer).slice(0, 28))}</td>
            <td><span style="display:inline-flex;align-items:center;gap:8px">${logoChip(h.ticker)}${tk(h.ticker) || `<span class="val">${esc(h.cusip)}</span>`}</span></td>
            <td class="num">${fmt.usd(h.value)}</td><td class="num">${fmt.int(h.shares)}</td>
            <td class="num">${h.pct != null ? h.pct.toFixed(1) + '%' : '—'}</td></tr>`).join('')}
        </table>` : empty('Holdings appear after the next 13F ingestion cycle.')}
      </div>
      <div class="card tight tbl-wrap">
        <h3 class="block-title">Recent Trades — vs Prior Quarter</h3>
        ${d.changes.length ? `<table>
          <tr><th>Issuer</th><th>Ticker</th><th>Change</th><th class="num">Δ Shares</th><th class="num">Δ Value</th></tr>
          ${d.changes.slice(0, 25).map(c => `<tr>
            <td>${esc(titleCase(c.issuer).slice(0, 26))}</td><td>${tk(c.ticker)}</td>
            <td>${typeBadge(c.change_type)}</td>
            <td class="num">${fmt.int(c.new_shares - c.old_shares)}</td>
            <td class="num ${cls(c.new_value - c.old_value)}">${fmt.usd(c.new_value - c.old_value)}</td></tr>`).join('')}
        </table>` : empty('Changes require two ingested quarters — pending.')}
      </div>
    </div>`;
  // decoupled so the page paints instantly; the backtest fetches prices
  loadShadow('fund', cik, '#fundShadow', mgrOrName);
}

// ── politicians ────────────────────────────────────────────────────────────
function polRow(t, { withName = true, withSector = false } = {}) {
  const nameCell = withName
    ? `<td>${t.bioguide
        ? `<a href="#pol/${esc(t.bioguide)}" style="display:inline-block">${person(t.photo, t.name, `${t.chamber}${t.state ? ' · ' + esc(t.state) : ''}`)}</a>`
        : person(null, t.name, t.chamber)}</td>
       <td>${party(t.party)}</td>`
    : '';
  const isFiling = t.side === 'Filing';
  return `<tr>
    ${nameCell}
    <td title="${esc(t.asset)}">${esc(String(t.asset).slice(0, 34))}</td>
    <td>${t.ticker ? `<span style="display:inline-flex;align-items:center;gap:7px">${logoChip(t.ticker)}${tk(t.ticker)}</span>` : '—'}</td>
    ${withSector ? `<td style="font-size:11.5px;color:var(--muted)">${esc(t.sector ?? '—')}</td>` : ''}
    <td class="side-${(t.side || '').toLowerCase()}">${isFiling ? 'PTR' : esc(t.side)}</td>
    <td>${fmt.date(t.trade_date)}</td>
    <td>${fmt.date(t.disclosure_date)}${t.filed_late_days ? ` <span class="pill sm gold" title="disclosed later than the 45 days the STOCK Act allows">${t.filed_late_days}d late</span>` : ''}</td>
    <td class="num">${esc(t.amount || '—')}</td>
    <td class="num">${t.price_at_trade ? '$' + fmt.num(t.price_at_trade) : '—'}</td>
    <td class="num ${cls(t.perf_pct)}">${fmt.pct(t.perf_pct)}</td>
    <td>${t.link ? `<a href="${esc(t.link)}" target="_blank" rel="noopener" style="color:var(--muted); text-decoration:underline; font-size:11.5px">filing</a>` : ''}</td>
  </tr>`;
}
const POL_HEAD = `<tr><th>Politician</th><th></th><th>Asset</th><th>Ticker</th><th>Action</th>
  <th>Trade Date</th><th>Disclosed</th><th class="num">Amount</th>
  <th class="num">@Trade</th><th class="num">Perf Since</th><th></th></tr>`;

async function loadPoliticians() {
  $('#polMain').style.display = '';
  $('#polDetail').style.display = 'none';
  const params = new URLSearchParams();
  if ($('#polChamber').value) params.set('chamber', $('#polChamber').value);
  if ($('#polSide').value) params.set('side', $('#polSide').value);
  if ($('#polSearch').value.trim()) params.set('q', $('#polSearch').value.trim());
  const d = await api('/api/politicians?' + params);
  $('#polTable').innerHTML = d.trades.length
    ? `<table>${POL_HEAD}${d.trades.map(t => polRow(t)).join('')}</table>`
    : empty('No disclosed trades match — or the disclosure feed is still loading.');
}
$('#polChamber').addEventListener('change', loadPoliticians);
$('#polSide').addEventListener('change', loadPoliticians);
let polTimer;
$('#polSearch').addEventListener('input', () => { clearTimeout(polTimer); polTimer = setTimeout(loadPoliticians, 300); });

// ── Politicians sub-views: Trades / Rankings / Signals / Portfolios ─────────
let polView = 'trades';
$('#polTabs')?.addEventListener('click', e => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  polView = chip.dataset.pv;
  document.querySelectorAll('#polTabs .chip').forEach(c => c.classList.toggle('active', c === chip));
  for (const v of ['Trades', 'Rankings', 'Signals', 'Portfolios']) {
    $('#polView' + v).style.display = v.toLowerCase() === polView ? '' : 'none';
  }
  loadPolView();
});
function loadPolView() {
  if (polView === 'rankings') return loadPolRankings();
  if (polView === 'signals') return loadPolSignals();
  if (polView === 'portfolios') return loadPolPortfolios();
  return loadPoliticians();
}

const polRankRow = (r, valHTML) => `
  ${r.bioguide ? `<a href="#pol/${esc(r.bioguide)}" style="display:flex;min-width:0;flex:1">${person(r.photo, r.name, `${r.party ? esc(r.party[0]) + ' · ' : ''}${esc(r.state ?? r.chamber ?? '')}`)}</a>`
    : person(null, r.name, r.chamber ?? '')}
  <span class="val">${valHTML}</span>`;

async function loadPolRankings() {
  const el = $('#polViewRankings');
  el.innerHTML = `<div class="loading">Loading rankings…</div>`;
  let d;
  try { d = await api('/api/pol-rankings'); } catch (err) { el.innerHTML = empty(err.message); return; }
  const note = `<div class="trend-hint" style="margin:6px 0 0">Computed only from official STOCK Act disclosures. Returns are since each trade date; amounts use the midpoint of the reported range. Latest trade-level data: ${esc(d.anchor ?? '—')}.</div>`;
  el.innerHTML = note + `<div class="grid cols-3">` +
    listCard('🏆 Best Performers (avg return per buy)', d.bestPerformers, r => polRankRow(r, `<b class="${cls(r.avgReturn)}">${fmt.pct(r.avgReturn)}</b>`)) +
    listCard('💰 Most Profitable (est. total gain)', d.mostProfitable, r => polRankRow(r, `<b class="${cls(r.estProfit)}">${fmt.usd(r.estProfit)}</b>`)) +
    listCard('⚡ Most Active (disclosed trades)', d.mostActive, r => polRankRow(r, `${fmt.int(r.trades)} trades`)) +
    listCard('🎯 Highest Conviction (avg buy size)', d.highestConviction, r => polRankRow(r, fmt.usd(r.avgBuySize))) +
    listCard('🏛 Largest Est. Portfolios', d.largestPortfolios, r => polRankRow(r, fmt.usd(r.estPortfolio))) +
    listCard('🟢 Biggest Recent Buyers (last 6mo of data)', d.biggestRecentBuyers, r => polRankRow(r, `<b class="up">${fmt.usd(r.recentBuys)}</b>`)) +
    listCard('🔴 Biggest Recent Sellers (last 6mo of data)', d.biggestRecentSellers, r => polRankRow(r, `<b class="down">${fmt.usd(r.recentSells)}</b>`)) +
    `</div>`;
}

const SIG_LABEL = {
  'co-buy': '👥 Politicians buying together', 'co-sell': '👥 Politicians selling together',
  'pol+insider': '🧑‍💼 Politicians + insiders', 'pol+billionaire': '💰 Politicians + billionaire',
  'pol+hedge-fund': '📊 Politicians + hedge funds', 'unusual-activity': '⚡ Unusual activity',
};
async function loadPolSignals() {
  const el = $('#polViewSignals');
  el.innerHTML = `<div class="loading">Scanning disclosures for signals…</div>`;
  let d;
  try { d = await api('/api/pol-signals'); } catch (err) { el.innerHTML = empty(err.message); return; }
  if (!d.signals?.length) { el.innerHTML = empty('No cross-source signals in the current disclosure window.'); return; }
  el.innerHTML = `<div class="trend-hint" style="margin:6px 0 0">A signal fires when several smart-money sources act on the same stock — politicians together, or politicians + insiders + tracked funds. Everything below comes from official filings.</div>
  <div class="grid cols-2">` + d.signals.map(s => `
    <div class="card sig-card">
      <div class="sig-head">
        ${logoChip(s.ticker)}
        <div style="min-width:0;flex:1">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">${tk(s.ticker)}<span class="nm" style="font-weight:600">${esc(titleCase(s.name).slice(0, 26))}</span></div>
          <div style="font-size:11px;color:var(--muted-2)">${s.sector ? esc(s.sector) + ' · ' : ''}${s.price ? '$' + fmt.num(s.price) : ''} <span class="${cls(s.change_pct)}">${fmt.pct(s.change_pct)}</span></div>
        </div>
        ${scoreEl(s.score)}
      </div>
      <div class="sig-kinds">${s.kinds.map(k => `<span class="pill sm gold">${esc(SIG_LABEL[k] ?? k)}</span>`).join('')}</div>
      <div class="sig-who">${s.politicians.map(p => avatar(p.photo, p.name, 26)).join('')}
        <span style="font-size:11.5px;color:var(--muted)">${s.politicians.map(p => esc(p.name.split(' ').at(-1))).join(', ')}${s.funds.length ? ' + ' + esc(s.funds[0]) : ''}${s.insider ? ' + insiders' : ''}</span></div>
      <div class="sig-why">${esc(s.why)}</div>
      <div class="sig-conf"><span>confidence</span><span class="conf-bar" style="width:90px"><i style="width:${s.confidence}%"></i></span><b>${s.confidence}%</b></div>
    </div>`).join('') + `</div>`;
}

async function loadPolPortfolios() {
  const el = $('#polViewPortfolios');
  el.innerHTML = `<div class="loading">Building portfolios from disclosures…</div>`;
  let d;
  try { d = await api('/api/pol-portfolios'); } catch (err) { el.innerHTML = empty(err.message); return; }
  el.innerHTML = `
  <h3 class="block-title" style="margin:2px 0 10px">Copy the Congress — a $10,000 what-if</h3>
  <div class="grid cols-3" style="margin-bottom:20px">
    <div id="shadowSenate"></div><div id="shadowHouse"></div><div id="shadowCongress"></div>
  </div>
  <div class="trend-hint" style="margin:6px 0 0">Virtual portfolios built by adding up every disclosed buy and subtracting every sell (midpoints of reported ranges) — an <b>estimate</b>, since exact amounts aren't disclosed. "Avg return" is the average gain of priced buys since their trade dates.</div>
  <div class="grid cols-3">` + d.portfolios.map(p => `
    <div class="card">
      <h3 class="block-title">${esc(p.label)}</h3>
      ${p.trades ? `
        <div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap">
          <span style="font-family:var(--serif);font-size:30px">${fmt.usd(p.estValue)}</span>
          ${p.avgReturn != null ? `<span class="pill ${p.avgReturn >= 0 ? 'up' : 'down'}">${fmt.pct(p.avgReturn)} avg since trade</span>` : ''}
        </div>
        <div style="font-size:11.5px;color:var(--muted-2);margin:4px 0 12px">${p.traders} politicians · ${fmt.int(p.trades)} disclosed trades</div>
        <div class="rlist">${p.positions.map((h, i) => {
          const maxV = p.positions[0].estValue || 1;
          return `<div class="rrow"><span class="rank">${i + 1}</span>${tk(h.ticker)}
            <span class="nm">${esc(titleCase(h.name).slice(0, 18))}</span>
            <span class="hbar"><i style="width:${Math.max(6, (h.estValue / maxV) * 100)}%"></i></span>
            <span class="val">${fmt.usd(h.estValue)}</span></div>`;
        }).join('')}</div>`
        : empty('House PTRs are filing records (trade detail lives in scanned PDFs), so no trade-level portfolio can be built honestly yet.')}
    </div>`).join('') + `</div>`;
  loadShadow('congress', 'senate', '#shadowSenate', 'the Senate');
  loadShadow('congress', 'house', '#shadowHouse', 'the House');
  loadShadow('congress', 'congress', '#shadowCongress', 'Congress');
}

async function loadPolitician(bioguide) {
  const d = await api(`/api/politician/${bioguide}`);
  $('#polMain').style.display = 'none';
  const el = $('#polDetail');
  el.style.display = '';
  const m = d.member;
  const s = d.stats ?? {};
  const a = d.analytics ?? {};
  const followed = getFollowedPols().includes(m.name_full);

  const monthlyChart = (() => {
    const mm = d.monthly ?? [];
    if (mm.length < 2) return '';
    const w = 560, h = 110, bw = Math.max(4, Math.floor(w / mm.length / 2.4));
    const maxV = Math.max(...mm.map(r => Math.max(r.buys, r.sells)), 1);
    const bars = mm.map((r, i) => {
      const x = 8 + (i / mm.length) * (w - 16);
      const bh = (r.buys / maxV) * (h - 30), sh = (r.sells / maxV) * (h - 30);
      return `<rect x="${x.toFixed(1)}" y="${(h - 20 - bh).toFixed(1)}" width="${bw}" height="${Math.max(1, bh).toFixed(1)}" fill="var(--up)" opacity=".85"/>
              <rect x="${(x + bw + 1).toFixed(1)}" y="${(h - 20 - sh).toFixed(1)}" width="${bw}" height="${Math.max(1, sh).toFixed(1)}" fill="var(--down)" opacity=".85"/>`;
    }).join('');
    return `<div class="card tight"><h3 class="block-title">Monthly Activity <span style="color:var(--muted-3);text-transform:none;letter-spacing:0">— <b class="up">buys</b> vs <b class="down">sells</b> per month</span></h3>
      <svg viewBox="0 0 ${w} ${h}" style="width:100%;height:${h}px">${bars}
        <text x="8" y="${h - 5}" font-family="IBM Plex Mono" font-size="9" fill="#6b7288">${esc(mm[0].ym)}</text>
        <text x="${w - 8}" y="${h - 5}" font-family="IBM Plex Mono" font-size="9" fill="#6b7288" text-anchor="end">${esc(mm.at(-1).ym)}</text>
      </svg></div>`;
  })();

  const posBars = (d.positions ?? []).length ? (() => {
    const maxV = d.positions[0].estValue || 1;
    return `<div class="card tight"><h3 class="block-title">Estimated Portfolio — Top Holdings</h3>
      <div class="rlist">${d.positions.map((p, i) => `
        <div class="rrow"><span class="rank">${i + 1}</span>${tk(p.ticker)}
          <span class="nm">${esc(titleCase(p.name).slice(0, 18))}</span>
          <span class="hbar"><i style="width:${Math.max(6, (p.estValue / maxV) * 100)}%"></i></span>
          <span class="val">${fmt.usd(p.estValue)}</span></div>`).join('')}</div>
      <div class="own-note">Estimated by summing disclosed buys minus sells (midpoints of reported ranges).</div></div>`;
  })() : '';

  const secBars = (d.sectorAllocation ?? []).length ? `
    <div class="card tight"><h3 class="block-title">Sector Allocation (est.)</h3>
      <div class="rlist">${d.sectorAllocation.map(x => `
        <div class="rrow"><span class="nm">${esc(x.sector)}</span>
          <span class="hbar"><i style="width:${Math.max(4, x.pct)}%"></i></span>
          <span class="val">${x.pct.toFixed(1)}%</span></div>`).join('')}</div></div>` : '';

  el.innerHTML = `
    <button class="back-btn" onclick="go('politicians')">← All politicians</button>
    <div class="card prof-card">
      <div class="prof-head">
        ${avatar(m.photo, m.name_full, 84)}
        <div class="prof-info">
          <h1 class="prof-name">${esc(m.name_full)}</h1>
          <div class="prof-sub">${party(m.party)} <span>${esc(m.party)}</span> &nbsp;·&nbsp; ${m.chamber === 'Senate' ? 'US Senator' : 'US Representative'}, ${esc(m.state)}
            &nbsp;·&nbsp; <span style="color:var(--muted-2)">${s.firstTrade ? `trading disclosed ${esc(s.firstTrade)} → ${esc(s.lastTrade)}` : 'filing records only'}</span></div>
          ${(d.committees ?? []).length ? `<div class="cmt-row">${d.committees.slice(0, 5).map(c =>
            `<span class="cmt" title="${esc(c.role ?? '')}">${esc(c.name.replace(/^(Senate|House) Committee on /, ''))}${c.role ? ` · ${esc(c.role)}` : ''}</span>`).join('')}</div>` : ''}
          ${d.styleBrief ? `<p class="prof-bio"><b style="color:var(--gold)">Auto profile</b> — ${esc(d.styleBrief)}</p>` : ''}
        </div>
        <button class="watch-btn ${followed ? 'on' : ''}" onclick="toggleFollowPol('${esc(m.name_full)}'); this.classList.toggle('on'); this.textContent = this.classList.contains('on') ? '★ Following' : '☆ Follow';">${followed ? '★ Following' : '☆ Follow'}</button>
      </div>
    </div>
    <div class="grid cols-4" style="margin-top:14px">
      <div class="card tile"><div class="k">Win Rate</div><div class="v ${s.winRate >= 50 ? 'up' : ''}">${s.winRate != null ? Math.round(s.winRate) + '%' : '—'}</div><div class="n">of priced buys are up since trade</div></div>
      <div class="card tile"><div class="k">Avg Return / Buy</div><div class="v ${cls(s.avgReturn)}">${fmt.pct(s.avgReturn)}</div><div class="n">since each trade date</div></div>
      <div class="card tile"><div class="k">Best Trade</div><div class="v up">${s.bestTrade ? esc(s.bestTrade.ticker) : '—'}</div><div class="n">${s.bestTrade ? fmt.pct(s.bestTrade.perf) + ' since ' + esc(s.bestTrade.date) : 'needs priced trades'}</div></div>
      <div class="card tile"><div class="k">Worst Trade</div><div class="v down">${s.worstTrade ? esc(s.worstTrade.ticker) : '—'}</div><div class="n">${s.worstTrade ? fmt.pct(s.worstTrade.perf) + ' since ' + esc(s.worstTrade.date) : '—'}</div></div>
    </div>
    <div class="grid cols-4">
      <div class="card tile"><div class="k">Est. Portfolio</div><div class="v">${fmt.usd(s.estPortfolioValue)}</div><div class="n">disclosed buys − sells (midpoints)</div></div>
      <div class="card tile"><div class="k">Trades</div><div class="v">${fmt.int(s.totalTrades)}</div><div class="n"><b class="up">${s.buys}</b> buys · <b class="down">${s.sells}</b> sells · ${s.filings} filings</div></div>
      <div class="card tile"><div class="k">Diversification</div><div class="v">${a.diversification != null ? a.diversification + '/100' : '—'}</div><div class="n">spread across est. holdings</div></div>
      <div class="card tile"><div class="k">Conviction</div><div class="v">${fmt.usd(a.conviction)}</div><div class="n">average buy size (midpoint)</div></div>
    </div>
    <div id="polShadow" style="margin-top:4px"></div>
    <div class="grid cols-2">${posBars}${secBars}</div>
    ${monthlyChart}
    <h2 class="section">Full Trade History <span class="sub">every disclosed trade, newest first — with sector</span></h2>
    <div class="card tight tbl-wrap">
      ${d.trades.length ? `<table>
        <tr><th>Asset</th><th>Ticker</th><th>Sector</th><th>Action</th><th>Trade Date</th><th>Disclosed</th><th class="num">Amount</th><th class="num">@Trade</th><th class="num">Perf Since</th><th></th></tr>
        ${d.trades.map(t => polRow(t, { withName: false, withSector: true })).join('')}
      </table>` : empty('No disclosed trades on record for this member.')}
    </div>`;
  loadShadow('politician', bioguide, '#polShadow', m.name_full);
}

// follow politicians (local, powers alert highlighting)
const FOLLOW_KEY = 'gm_follow_pols';
function getFollowedPols() { return safe(localStorage.getItem(FOLLOW_KEY), []) || []; }
window.toggleFollowPol = name => {
  let list = getFollowedPols();
  list = list.includes(name) ? list.filter(n => n !== name) : [...list, name];
  localStorage.setItem(FOLLOW_KEY, JSON.stringify(list.slice(0, 30)));
};

// ── stocks ─────────────────────────────────────────────────────────────────
let suggestTimer;
function closeStockSuggest() {
  clearTimeout(suggestTimer);
  const el = $('#stockSuggest');
  if (el) { el.style.display = 'none'; el.innerHTML = ''; }
}
window.pickStock = t => {
  const sym = String(t).toUpperCase().trim();
  closeStockSuggest();
  if ($('#stockSearch')) { $('#stockSearch').value = sym; $('#stockSearch').blur(); }
  go('stock/' + sym);
};
$('#stockSearch').addEventListener('input', () => {
  clearTimeout(suggestTimer);
  const q = $('#stockSearch').value.trim();
  if (!q) { closeStockSuggest(); return; }
  suggestTimer = setTimeout(async () => {
    let rows;
    try { rows = await api('/api/search?q=' + encodeURIComponent(q)); } catch { return; }
    // race guard: user may have picked/cleared while the request was in flight
    const el = $('#stockSuggest');
    if (!el || $('#stockSearch').value.trim() !== q || document.activeElement !== $('#stockSearch')) return;
    el.innerHTML = rows.map(r =>
      `<div onclick="pickStock('${esc(r.ticker)}')">${logoChip(r.ticker)}<b style="font-family:var(--mono)">${esc(r.ticker)}</b><span style="color:var(--muted)">${esc(r.name)}</span></div>`).join('');
    el.style.display = rows.length ? '' : 'none';
  }, 250);
});
$('#stockSearch').addEventListener('keydown', e => {
  if (e.key === 'Enter' && $('#stockSearch').value.trim()) pickStock($('#stockSearch').value.trim());
  else if (e.key === 'Escape') closeStockSuggest();
});
// close the dropdown on any click outside the search row
document.addEventListener('click', e => {
  if (!e.target.closest('.search-row')) closeStockSuggest();
});

const CH = { w: 900, h: 220, pad: 8, bottom: 18 };
let curHist = [], curMode = 'line', curRange = '1y';

function lineChart(history) {
  const { w, h, pad, bottom } = CH;
  const vals = history.map(r => r.close);
  const min = Math.min(...vals), max = Math.max(...vals);
  const x = i => pad + (i / (history.length - 1)) * (w - pad * 2);
  const y = v => h - pad - bottom - ((v - min) / (max - min || 1)) * (h - pad * 2 - bottom);
  const pts = vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const up = vals.at(-1) >= vals[0];
  const color = up ? '#4fae86' : '#e0566a';
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <defs><linearGradient id="cg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${color}" stop-opacity=".22"/><stop offset="100%" stop-color="${color}" stop-opacity="0"/>
    </linearGradient></defs>
    <polygon points="${pts} ${w - pad},${h - pad - bottom} ${pad},${h - pad - bottom}" fill="url(#cg)"/>
    <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.6"/>
    <text x="${pad}" y="${h - 6}" font-family="IBM Plex Mono" font-size="10" fill="#6b7288">${esc(chartTipLabel(history[0]))}</text>
    <text x="${w - pad}" y="${h - 6}" font-family="IBM Plex Mono" font-size="10" fill="#6b7288" text-anchor="end">${esc(chartTipLabel(history.at(-1)))} · ${curRange.toUpperCase()}</text>
  </svg>`;
}

function candleChart(history) {
  const { w, h, pad, bottom } = CH;
  // rows without real OHLC fall back to close for all four (honest flat tick)
  const rows = history.map(r => ({
    o: r.open ?? r.close, hi: r.high ?? r.close, lo: r.low ?? r.close, c: r.close,
  }));
  const min = Math.min(...rows.map(r => r.lo)), max = Math.max(...rows.map(r => r.hi));
  const n = rows.length;
  const slot = (w - pad * 2) / n;
  const cw = Math.max(1, Math.min(7, slot * 0.65));
  const y = v => h - pad - bottom - ((v - min) / (max - min || 1)) * (h - pad * 2 - bottom);
  const bars = rows.map((r, i) => {
    const cx = pad + slot * (i + 0.5);
    const up = r.c >= r.o;
    const col = up ? '#4fae86' : '#e0566a';
    const yO = y(r.o), yC = y(r.c);
    const top = Math.min(yO, yC), bh = Math.max(1, Math.abs(yC - yO));
    return `<line x1="${cx.toFixed(1)}" y1="${y(r.hi).toFixed(1)}" x2="${cx.toFixed(1)}" y2="${y(r.lo).toFixed(1)}" stroke="${col}" stroke-width="1"/>`
      + `<rect x="${(cx - cw / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${cw.toFixed(1)}" height="${bh.toFixed(1)}" fill="${col}"/>`;
  }).join('');
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${bars}
    <text x="${pad}" y="${h - 6}" font-family="IBM Plex Mono" font-size="10" fill="#6b7288">${esc(chartTipLabel(history[0]))}</text>
    <text x="${w - pad}" y="${h - 6}" font-family="IBM Plex Mono" font-size="10" fill="#6b7288" text-anchor="end">${esc(chartTipLabel(history.at(-1)))} · ${curRange.toUpperCase()}</text>
  </svg>`;
}

function renderChart() {
  const box = $('#chartBox');
  if (!box) return;
  if (!curHist || curHist.length < 2) { box.innerHTML = empty('Price history builds up as the loop runs.'); return; }
  box.innerHTML = curMode === 'candle' ? candleChart(curHist) : lineChart(curHist);
  attachChartHover(box);
}

// hover crosshair: exact time + price in USD (plus O/H/L on candles)
function chartTipLabel(r) {
  const s = String(r.date);
  if (s.includes('T')) {
    const dt = new Date(s);
    return dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' })
      + ' ET · ' + dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
  return s;
}

function attachChartHover(box) {
  const tip = document.createElement('div'); tip.className = 'chart-tip';
  const guide = document.createElement('div'); guide.className = 'chart-guide';
  box.appendChild(guide); box.appendChild(tip);
  const fracPad = CH.pad / CH.w;

  box.onpointermove = e => {
    if (!curHist?.length) return;
    const rect = box.getBoundingClientRect();
    const fx = (e.clientX - rect.left) / rect.width;
    const fi = ((fx - fracPad) / (1 - 2 * fracPad)) * (curHist.length - 1);
    const i = Math.max(0, Math.min(curHist.length - 1, Math.round(fi)));
    const r = curHist[i];
    if (!r) return;
    const prev = i > 0 ? curHist[i - 1] : null;
    const chg = prev?.close ? ((r.close - prev.close) / prev.close) * 100 : null;
    const showOHLC = curMode === 'candle' && r.open != null;
    tip.innerHTML =
      `<div class="ct-d">${esc(chartTipLabel(r))}</div>` +
      `<b>$${fmt.num(r.close)}</b>${chg != null ? ` <span class="${cls(chg)}">${fmt.pct(chg)}</span>` : ''} <span class="ct-d">USD</span>` +
      (showOHLC ? `<div class="ct-d">O $${fmt.num(r.open)} · H $${fmt.num(r.high)} · L $${fmt.num(r.low)}</div>` : '');
    const gx = (fracPad + (i / (curHist.length - 1)) * (1 - 2 * fracPad)) * rect.width;
    guide.style.left = `${gx}px`;
    guide.style.display = 'block';
    tip.style.display = 'block';
    const tw = tip.offsetWidth || 120;
    tip.style.left = `${Math.min(Math.max(6, gx - tw / 2), rect.width - tw - 6)}px`;
    tip.style.top = '6px';
  };
  box.onpointerleave = () => { tip.style.display = 'none'; guide.style.display = 'none'; };
}

// "who owns this stock" — real 13F holder values vs live market cap
function ownershipCard(d) {
  const holders = d.fundHolders ?? [];
  if (!holders.length) return '';
  const sum = cat => holders.filter(h => h.category === cat).reduce((s, h) => s + (h.value ?? 0), 0);
  const bil = sum('billionaire'), hf = sum('hedge_fund'), bank = sum('investment_bank'), swf = sum('sovereign_wealth');
  const tracked = bil + hf + bank + swf;
  if (tracked <= 0) return '';
  const mc = d.marketCap && d.marketCap > tracked ? d.marketCap : null;
  const total = mc ?? tracked;
  const slices = [
    ['Billionaire investors', bil, 'var(--gold)'],
    ['Hedge funds', hf, '#7da7e0'],
    ['Investment banks', bank, '#b4bac9'],
    ['Sovereign wealth funds', swf, '#9a7de0'],
    ...(mc ? [['Everyone else — incl. retail investors', mc - tracked, 'var(--up)']] : []),
  ].filter(s => s[1] > 0);

  const R = 70, C = 2 * Math.PI * R;
  let off = 0;
  const rings = slices.map(([, v, color]) => {
    const frac = v / total;
    const seg = `<circle cx="84" cy="84" r="${R}" fill="none" stroke="${color}" stroke-width="22"
      stroke-dasharray="${(frac * C).toFixed(1)} ${C.toFixed(1)}" stroke-dashoffset="${(-off * C).toFixed(1)}"/>`;
    off += frac;
    return seg;
  }).join('');

  const ps = d.politicianStats ?? {};
  const pBuys = ps.buys ?? 0;
  const pSells = ps.sells ?? 0;
  const pSent = ps.sentiment != null
    ? (ps.sentiment >= 60 ? 'Bullish' : ps.sentiment <= 40 ? 'Bearish' : 'Neutral') : null;

  return `<div class="card" style="margin-top:14px">
    <h3 class="block-title">Who owns ${esc(d.symbol)}? · smart money vs everyone else</h3>
    <div class="own-wrap">
      <div class="own-donut">
        <svg viewBox="0 0 168 168">${rings}</svg>
        <div class="own-center"><div>
          <div class="oc-v">${mc ? ((tracked / mc) * 100).toFixed(1) + '%' : fmt.usd(tracked)}</div>
          <div class="oc-l">${mc ? 'held by tracked smart money' : 'tracked smart money holds'}</div>
        </div></div>
      </div>
      <div class="own-legend">
        ${slices.map(([label, v, color]) => `
          <div class="own-row"><span class="sw" style="background:${color}"></span>${esc(label)}
            <span class="ol-v">${fmt.usd(v)} <span class="ol-s">· ${((v / total) * 100).toFixed(1)}%</span></span></div>`).join('')}
        ${(pBuys + pSells) ? `<div class="own-note">🏛️ Politicians: <b>${ps.holders}</b> member${ps.holders === 1 ? '' : 's'} traded this stock — <b class="up">${pBuys} buy${pBuys === 1 ? '' : 's'}</b> · <b class="down">${pSells} sell${pSells === 1 ? '' : 's'}</b>${pSent ? ` · sentiment ${badge(pSent)} <span style="font-family:var(--mono);font-size:11px">${ps.sentiment}% buys</span>` : ''} (amounts are ranges, so they can't go in the circle).</div>` : ''}
        <div class="own-note">From the latest official 13F filings of the ${holders.length} tracked funds holding this stock${mc ? ' + live market cap' : ''}. All values in USD.</div>
      </div>
    </div>
  </div>`;
}

// chart mode toggle (delegated)
document.addEventListener('click', e => {
  const tab = e.target.closest('.ctab');
  if (!tab) return;
  curMode = tab.dataset.mode;
  document.querySelectorAll('.ctab').forEach(t => t.classList.toggle('active', t === tab));
  renderChart();
});

// Stocks landing (no stock chosen yet) — real trending lists so it's never empty
function trendTile(s, tag) {
  return `<div class="rel-card" onclick="go('stock/${esc(s.ticker)}')">
    ${logoChip(s.ticker)}
    <div class="rc-b">
      <div class="rc-t">${esc(s.ticker)}</div>
      <div class="rc-n">${esc(titleCase(s.name).slice(0, 22))}</div>
    </div>
    <div>
      <div class="rc-p ${cls(s.change_pct)}">${s.price ? '$' + fmt.num(s.price) : '—'}</div>
      <div class="rc-h">${tag(s)}</div>
    </div>
  </div>`;
}

// ── Stocks sub-views: Search · Screener · Sector heatmap ───────────────────
let stkView = 'search';
$('#stkTabs')?.addEventListener('click', e => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  stkView = chip.dataset.sv;
  document.querySelectorAll('#stkTabs .chip').forEach(c => c.classList.toggle('active', c === chip));
  for (const v of ['Search', 'Screener', 'Sectors', 'Earnings', 'Dark', 'Squeeze']) {
    $('#stkView' + v).style.display = v.toLowerCase() === stkView ? '' : 'none';
  }
  if (stkView === 'screener') loadScreener();
  if (stkView === 'sectors') loadSectors();
  if (stkView === 'earnings') loadEarnings();
  if (stkView === 'dark' || stkView === 'squeeze') loadPressure(stkView);
});

// ── Macro strip: what interest rates and crypto are doing ──────────────────
// Small time-boxed cache. A plain `cache = cache || await fetch()` never
// expires, so a tab left open all day would keep showing the prices it loaded
// at breakfast while the page still says "live".
const ttlCache = new Map();
async function cached(key, ttlMs, loader) {
  const hit = ttlCache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = await loader();
  ttlCache.set(key, { at: Date.now(), value });
  return value;
}

let macroCache = null;
async function loadMacro() {
  const el = $('#macroStrip');
  if (!el) return;
  // crypto moves constantly and yields update daily — 3 minutes is plenty
  try { macroCache = await cached('macro', 180e3, () => api('/api/macro')); } catch { return; }
  const y = macroCache.yields, c = macroCache.crypto;
  if (!y && !c) return;

  el.innerHTML = `
    <div class="macro-row">
      ${y ? `
        <div class="macro-card">
          <div class="mc-k">US interest rates <span class="mc-date">${esc(y.date)}</span></div>
          <div class="mc-yields">
            ${['3M', '2Y', '10Y', '30Y'].filter(k => y.curve[k] != null).map(k =>
              `<div class="mc-y"><span>${k}</span><b>${y.curve[k]}%</b></div>`).join('')}
          </div>
          <div class="mc-note ${y.inverted ? 'warn' : ''}">
            ${y.inverted
              ? '⚠️ The curve is <b>inverted</b> — short-term rates are higher than long-term ones, which markets read as a recession warning.'
              : `Normal shape — long-term rates sit <b>${y.spread}%</b> above short-term. Rising rates usually pressure stocks; falling rates usually help.`}
          </div>
        </div>` : ''}
      ${c ? `
        <div class="macro-card">
          <div class="mc-k">Crypto <span class="mc-date">24-hour move</span></div>
          <div class="mc-crypto">
            ${c.rows.map(r => `<div class="mc-c">
              <span>${esc(r.name)}</span>
              <b>$${Number(r.price).toLocaleString('en-US')}</b>
              <i class="${cls(r.change_24h)}">${fmt.pct(r.change_24h)}</i>
            </div>`).join('')}
          </div>
          <div class="mc-note">Shown for context — crypto often moves with the same risk appetite that drives tech stocks.</div>
        </div>` : ''}
    </div>`;
}

// ── Dark pools + squeeze radar (FINRA, published on a lag) ─────────────────
async function loadPressure(which) {
  const el = $(which === 'dark' ? '#stkViewDark' : '#stkViewSqueeze');
  let d;
  // FINRA publishes weekly/bi-monthly, but the live quotes joined onto it move
  // all day, so re-pull every 5 minutes rather than once per page load
  try { d = await cached('pressure', 300e3, () => api('/api/pressure?limit=30')); }
  catch (err) { el.innerHTML = empty('Could not load FINRA data: ' + err.message); return; }
  const bigMoney = v => v == null ? '—' : v >= 1e9 ? '$' + (v / 1e9).toFixed(2) + 'B'
    : v >= 1e6 ? '$' + (v / 1e6).toFixed(0) + 'M' : '$' + fmt.int(v);
  const niceDate = s => s ? new Date(s + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : '—';

  if (which === 'dark') {
    el.innerHTML = `
      <p class="trend-hint">Roughly <b>40% of all US trading</b> happens away from the public exchanges, inside private venues called
        <b>dark pools</b>. Big institutions use them to buy or sell enormous amounts without moving the price against themselves.
        A stock suddenly showing huge dark-pool volume often means someone very large is quietly building — or unloading — a position.</p>
      <div class="lag-note">📅 FINRA publishes this weekly, about three weeks after the fact.
        These are the totals for the week starting <b>${esc(niceDate(d.meta.darkAsOf))}</b> — not today's trading.</div>
      ${d.dark.length ? `<div class="card tight tbl-wrap" style="margin-top:14px"><table>
        <tr><th>Stock</th><th class="num">Traded in dark pools</th><th class="num">Shares</th>
            <th class="num">Trades</th><th class="num">Venues</th><th class="num">Price now</th></tr>
        ${d.dark.map(r => `<tr class="clickable" onclick="go('stock/${esc(r.symbol)}')">
          <td>${tk(r.symbol)} <span class="scr-nm">${esc((r.name || '').slice(0, 28))}</span></td>
          <td class="num dp-big">${bigMoney(r.notional)}</td>
          <td class="num">${fmt.int(r.shares)}</td>
          <td class="num">${fmt.int(r.trades)}</td>
          <td class="num">${r.venues}</td>
          <td class="num">${r.price == null ? '—' : '$' + fmt.num(r.price)}
            <span class="pf-day ${cls(r.today)}">${fmt.pct(r.today)}</span></td>
        </tr>`).join('')}
      </table></div>` : `<div class="card" style="margin-top:14px">${empty('Dark-pool data has not loaded yet.')}</div>`}
      <p class="pf-note">Source: FINRA ATS Transparency Data (official, free). Dark-pool volume shows size and intent — it does not say which direction the buyer expects the stock to go.</p>`;
    return;
  }

  el.innerHTML = `
    <p class="trend-hint">When someone bets <b>against</b> a stock they borrow shares and sell them, hoping to buy back cheaper — that is
      <b>shorting</b>. They must eventually buy those shares back. <b>Days to cover</b> tells you how many normal trading days it would take
      for every short seller to exit. If that number is high and good news arrives, they all have to buy at once and the price can rocket —
      a <b>short squeeze</b>.</p>
    <div class="lag-note">📅 FINRA publishes short interest twice a month, about eight business days later.
      These figures are as of <b>${esc(niceDate(d.meta.shortAsOf))}</b>.</div>
    ${d.squeeze.length ? `<div class="sq-grid">
      ${d.squeeze.map(r => `<div class="sq-card clickable lvl-${r.level.toLowerCase()}" onclick="go('stock/${esc(r.symbol)}')">
        <div class="sq-top">${tk(r.symbol)}
          <span class="sq-badge lvl-${r.level.toLowerCase()}">${r.level === 'High' ? '🔥 High' : r.level === 'Elevated' ? '⚡ Elevated' : '· Normal'} squeeze risk</span>
          <span class="sq-score">${r.squeezeScore}</span></div>
        <div class="sq-name">${esc((r.name || '').slice(0, 34))}</div>
        <div class="sq-metrics">
          <div><span>Days to buy back</span><b>${r.days_to_cover?.toFixed(1) ?? '—'}</b></div>
          <div><span>Shorted shares</span><b>${fmt.int(r.short_shares)}</b></div>
          <div><span>Change vs last</span><b class="${cls(r.change_pct)}">${fmt.pct(r.change_pct)}</b></div>
          <div><span>Price</span><b>${r.price == null ? '—' : '$' + fmt.num(r.price)}</b></div>
        </div>
      </div>`).join('')}
    </div>` : `<div class="card" style="margin-top:14px">${empty('Short-interest data has not loaded yet.')}</div>`}
    <p class="pf-note">Source: FINRA Consolidated Short Interest (official, free). Only liquid, actively-quoted US stocks are shown — thinly-traded listings are excluded because their figures are not meaningful. A high score means crowded shorts, not a prediction. Not investment advice.</p>`;
}

// ── Portfolio: real holdings, live profit and loss ─────────────────────────
// Kept on this device like the watchlist — the app has no accounts, and a
// list of what someone owns is the last thing that should leave their machine.
const PF_KEY = 'gm_portfolio';
let holdings = safe(localStorage.getItem(PF_KEY), []) || [];
const savePortfolio = () => localStorage.setItem(PF_KEY, JSON.stringify(holdings));

window.addHolding = () => {
  const sym = String($('#pfSym')?.value || '').toUpperCase().trim();
  const qty = Number($('#pfQty')?.value);
  const cost = Number($('#pfCost')?.value);
  if (!/^[A-Z.\-]{1,8}$/.test(sym)) return toast('Enter a ticker like AAPL', 'err');
  if (!isFinite(qty) || qty <= 0) return toast('How many shares?', 'err');
  if (!isFinite(cost) || cost <= 0) return toast('What price did you pay?', 'err');

  const existing = holdings.find(h => h.sym === sym);
  if (existing) {
    // average the cost basis instead of creating a duplicate row
    const totalQty = existing.qty + qty;
    existing.cost = (existing.cost * existing.qty + cost * qty) / totalQty;
    existing.qty = totalQty;
  } else {
    holdings.unshift({ sym, qty, cost, added: Date.now() });
  }
  holdings = holdings.slice(0, 50);
  savePortfolio();
  $('#pfQty').value = ''; $('#pfCost').value = ''; $('#pfSym').value = '';
  loadPortfolio();
  toast(existing ? `${sym} updated — cost averaged` : `${sym} added`);
};

window.removeHolding = sym => {
  holdings = holdings.filter(h => h.sym !== sym);
  savePortfolio(); loadPortfolio();
};

// the add form: prominent when empty, tucked away once there are holdings
const pfAddForm = (compact) => `
  ${compact ? '' : `<p class="ar-intro">Add what you own and the app works out your profit or loss using live prices.
      <b>You do not need to be exact — the average price you paid is fine.</b></p>`}
  <div class="pf-form">
    <label class="pf-f"><span>Stock</span><input id="pfSym" class="ar-in" placeholder="AAPL" maxlength="8"></label>
    <label class="pf-f"><span>How many shares</span><input id="pfQty" class="ar-in ar-num" inputmode="decimal" placeholder="10"></label>
    <label class="pf-f"><span>Price you paid</span><input id="pfCost" class="ar-in ar-num" inputmode="decimal" placeholder="180"></label>
    <button class="btn-primary ar-add" onclick="addHolding()">Add to portfolio</button>
  </div>`;

async function loadPortfolio() {
  const body = $('#pfBody');
  if (!body) return;

  if (!holdings.length) {
    body.innerHTML = `
      <div class="card pf-start">
        <div class="pf-start-ic">💼</div>
        <h3>Track what you actually own</h3>
        <p>Add a stock and Giant Money keeps your profit and loss up to date with live prices.
           Everything stays on this device — nothing is uploaded.</p>
        ${pfAddForm(false)}
      </div>`;
    return;
  }

  body.innerHTML = `<div class="card"><div class="loading">Loading live prices…</div></div>`;
  let d;
  try { d = await api('/api/watch?symbols=' + holdings.map(h => h.sym).join(',')); }
  catch (err) { body.innerHTML = `<div class="card">${empty('Could not load prices: ' + err.message)}</div>`; return; }

  const quoteOf = s => d.quotes.find(q => q.symbol === s);
  const rows = holdings.map(h => {
    const q = quoteOf(h.sym);
    const price = q?.price ?? null;
    const invested = h.qty * h.cost;
    const value = price == null ? null : h.qty * price;
    const pl = value == null ? null : value - invested;
    const plPct = value == null ? null : (pl / invested) * 100;
    return { ...h, name: q?.name, price, change_pct: q?.change_pct, score: q?.score, invested, value, pl, plPct };
  });

  const priced = rows.filter(r => r.value != null);
  const invested = priced.reduce((a, r) => a + r.invested, 0);
  const value = priced.reduce((a, r) => a + r.value, 0);
  const pl = value - invested;
  const plPct = invested ? (pl / invested) * 100 : 0;
  // today's move in money terms, from each holding's own daily change
  const todayPL = priced.reduce((a, r) =>
    a + (r.change_pct == null ? 0 : r.value - r.value / (1 + r.change_pct / 100)), 0);

  const money = v => (v < 0 ? '−$' : '$') + Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
  const best = priced.length ? priced.reduce((a, b) => (a.plPct ?? -1e9) > (b.plPct ?? -1e9) ? a : b) : null;
  const worst = priced.length ? priced.reduce((a, b) => (a.plPct ?? 1e9) < (b.plPct ?? 1e9) ? a : b) : null;

  // allocation: how much of the pot sits in each holding
  const MIX = ['#c9a75a', '#4fae86', '#7a98d6', '#c88ee0', '#e0b085', '#85c8e0', '#e0566a', '#96a2b4'];
  const alloc = priced.slice().sort((a, b) => b.value - a.value)
    .map((r, i) => ({ ...r, weight: (r.value / value) * 100, color: MIX[i % MIX.length] }));

  body.innerHTML = `
    <div class="card pf-hero">
      <div class="pfh-main">
        <div class="pfh-k">Your portfolio is worth</div>
        <div class="pfh-v">${money(value)}</div>
        <div class="pfh-sub ${cls(pl)}">
          ${pl >= 0 ? '▲' : '▼'} ${money(Math.abs(pl))} (${fmt.pct(plPct)}) ${pl >= 0 ? 'profit' : 'loss'} overall
        </div>
      </div>
      <div class="pfh-side">
        <div class="pfh-stat"><span>You put in</span><b>${money(invested)}</b></div>
        <div class="pfh-stat"><span>Today</span><b class="${cls(todayPL)}">${money(todayPL)}</b></div>
        <div class="pfh-stat"><span>Holdings</span><b>${rows.length}</b></div>
      </div>
    </div>

    ${alloc.length > 1 ? `
    <div class="card pf-alloc">
      <div class="pfa-k">Where your money sits</div>
      <div class="pfa-bar">
        ${alloc.map(a => `<span style="width:${a.weight.toFixed(1)}%;background:${a.color}" title="${esc(a.sym)} ${a.weight.toFixed(1)}%"></span>`).join('')}
      </div>
      <div class="pfa-legend">
        ${alloc.map(a => `<span class="pfa-item"><i style="background:${a.color}"></i>${esc(a.sym)} <b>${a.weight.toFixed(1)}%</b></span>`).join('')}
      </div>
    </div>` : ''}

    ${best && worst && priced.length > 1 ? `<div class="pf-bw">
      <div class="pf-bw-item up">🏆 Doing best — <b>${esc(best.sym)}</b> ${fmt.pct(best.plPct)}</div>
      <div class="pf-bw-item down">💀 Doing worst — <b>${esc(worst.sym)}</b> ${fmt.pct(worst.plPct)}</div>
    </div>` : ''}

    <div class="card tight tbl-wrap" style="margin-top:14px"><table>
      <tr><th>Stock</th><th class="num">Shares</th><th class="num">You paid</th><th class="num">Now</th>
          <th class="num">Value</th><th class="num">Profit / Loss</th><th></th></tr>
      ${rows.map(r => `<tr>
        <td class="clickable" onclick="go('stock/${esc(r.sym)}')">${tk(r.sym)}
          <span class="scr-nm">${esc((r.name || '').slice(0, 26))}</span></td>
        <td class="num">${fmt.num(r.qty, 0)}</td>
        <td class="num">$${fmt.num(r.cost)}</td>
        <td class="num">${r.price == null ? '—' : '$' + fmt.num(r.price)}
          ${r.change_pct != null ? `<span class="pf-day ${cls(r.change_pct)}">${fmt.pct(r.change_pct)}</span>` : ''}</td>
        <td class="num">${r.value == null ? '—' : money(r.value)}</td>
        <td class="num ${cls(r.pl)}">${r.pl == null ? '—' : `${money(r.pl)}<span class="pf-plp">${fmt.pct(r.plPct)}</span>`}</td>
        <td><button class="ar-x" onclick="removeHolding('${esc(r.sym)}')" title="Remove">×</button></td>
      </tr>`).join('')}
    </table></div>

    <details class="card pf-more">
      <summary>＋ Add another holding</summary>
      ${pfAddForm(true)}
    </details>
    <p class="pf-note">Prices are live from the same feed as the rest of the app. Adding a stock you already hold averages the price you paid. This is a record of what you own — Giant Money never places trades and this is not investment advice.</p>`;
}

// ── Earnings calendar: the one screen that looks forward ───────────────────
let earnMineOnly = false;
async function loadEarnings() {
  const el = $('#stkViewEarnings');
  const wl = getWatchlist();
  let d;
  try { d = await api(`/api/earnings?days=7&symbols=${wl.join(',')}${earnMineOnly ? '&mine=1' : ''}`); }
  catch (err) { el.innerHTML = empty('Could not load the calendar: ' + err.message); return; }

  const dayName = iso => {
    const dt = new Date(iso + 'T12:00:00');
    const today = new Date(); today.setHours(12, 0, 0, 0);
    const diff = Math.round((dt - today) / 86400e3);
    const nice = dt.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
    return diff === 0 ? `Today · ${nice}` : diff === 1 ? `Tomorrow · ${nice}` : nice;
  };
  const when = s => s === 'Before open' ? '🌅 Before the market opens'
    : s === 'After close' ? '🌙 After the market closes' : '☀️ During the day';

  el.innerHTML = `
    <p class="trend-hint">Every three months a company has to tell the world how much money it made — that's <b>earnings</b>.
      The stock often moves sharply that day, so traders plan around these dates.</p>
    <div class="earn-bar">
      <button class="aif ${earnMineOnly ? 'on' : ''} aif-big" id="earnMine">⭐ Only my watchlist</button>
      <span class="scr-count">${fmt.int(d.total)} companies report in the next 7 days</span>
    </div>
    ${d.days.length ? d.days.map(day => `
      <div class="news-sep"><span class="ns-label">${esc(dayName(day.date))}</span>
        <span class="ns-note">${day.count} compan${day.count === 1 ? 'y' : 'ies'}</span>
        <span class="ns-line"></span></div>
      <div class="earn-grid">
        ${(day.notable.length ? day.notable : day.all.slice(0, 8)).map(r => `
          <div class="earn-card clickable ${r.watched ? 'mine' : ''}" onclick="go('stock/${esc(r.symbol)}')">
            <div class="ec-top">
              ${tk(r.symbol)}
              ${r.watched ? '<span class="ec-mine">⭐ yours</span>' : ''}
              ${r.score != null ? `<span class="score-ring" style="margin-left:auto">${r.score}</span>` : ''}
            </div>
            <div class="ec-name">${esc((r.company || '').slice(0, 40))}</div>
            <div class="ec-when">${when(r.session)}</div>
            <div class="ec-row">
              <span>Expected profit <b>${esc(r.eps_forecast || '—')}</b> per share</span>
              ${r.price != null ? `<span class="${cls(r.change_pct)}">$${fmt.num(r.price)} ${fmt.pct(r.change_pct)}</span>` : ''}
            </div>
            ${r.insiderBuys > 0 ? `<div class="ec-insider">🔥 ${r.insiderBuys} insider buy${r.insiderBuys > 1 ? 's' : ''} in the last 30 days</div>` : ''}
          </div>`).join('')}
      </div>`).join('')
      : `<div class="card" style="margin-top:12px">${empty(earnMineOnly ? 'None of your watchlist stocks report this week.' : 'No earnings dates loaded yet — the calendar refreshes a few times a day.')}</div>`}`;

  $('#earnMine').onclick = () => { earnMineOnly = !earnMineOnly; loadEarnings(); };
  loadCalendarExtras();   // IPOs + dividends live under the earnings list
}

// The IPO and dividend feeds were being fetched every few hours and never
// shown. They belong here, with the rest of the forward-looking calendar.
async function loadCalendarExtras() {
  const host = $('#stkViewEarnings');
  if (!host) return;
  // reuse the mount if it is already there, so this re-renders with fresh data
  // instead of bailing out and leaving the first load frozen on screen
  let mount = host.querySelector('#calExtras');
  if (!mount) {
    mount = document.createElement('div');
    mount.id = 'calExtras';
    host.appendChild(mount);
  }

  let d;
  try { d = macroCache = await cached('macro', 180e3, () => api('/api/macro')); } catch { return; }
  const ipos = d.ipos, divs = d.dividends;
  const usDate = s => {
    if (!s) return '';
    const t = new Date(s.includes('/') ? s : s + 'T12:00:00');
    return isNaN(t) ? s : t.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  mount.innerHTML = `
    ${ipos && (ipos.priced.length || ipos.filed.length) ? `
      <h2 class="section" style="margin-top:26px">New Companies Listing
        <span class="sub">a company selling shares to the public for the first time — an IPO</span></h2>
      <div class="earn-grid">
        ${ipos.priced.slice(0, 6).map(r => `
          <div class="earn-card">
            <div class="ec-top">${r.symbol ? tk(r.symbol) : ''}<span class="ec-mine">✅ priced</span></div>
            <div class="ec-name">${esc((r.company || '').slice(0, 40))}</div>
            <div class="ec-when">Listing on ${esc(r.exchange || 'a US exchange')}</div>
            <div class="ec-row"><span>Share price <b>$${esc(String(r.price ?? '—'))}</b></span></div>
          </div>`).join('')}
        ${ipos.filed.slice(0, 6).map(r => `
          <div class="earn-card">
            <div class="ec-top">${r.symbol ? tk(r.symbol) : ''}<span class="ec-filed">📄 just filed</span></div>
            <div class="ec-name">${esc((r.company || '').slice(0, 40))}</div>
            <div class="ec-when">Filed paperwork ${esc(usDate(r.date))} — not trading yet</div>
            <div class="ec-row"><span>Raising <b>${esc(r.value || '—')}</b></span></div>
          </div>`).join('')}
      </div>` : ''}

    ${divs && divs.rows.length ? `
      <h2 class="section" style="margin-top:26px">Dividend Pay Dates
        <span class="sub">cash a company pays you just for holding the stock — buy before the "ex-date" to get it</span></h2>
      <div class="card tight tbl-wrap"><table>
        <tr><th>Stock</th><th>Company</th><th class="num">Cash per share</th><th>Buy before</th><th>You get paid</th></tr>
        ${divs.rows.slice(0, 12).map(r => `<tr class="clickable" onclick="go('stock/${esc(r.symbol)}')">
          <td>${tk(r.symbol)}</td>
          <td class="scr-nm">${esc((r.company || '').slice(0, 34))}</td>
          <td class="num"><b style="font-family:var(--mono);color:var(--up)">$${esc(String(r.amount ?? '—'))}</b></td>
          <td>${esc(usDate(r.exDate))}</td>
          <td>${esc(usDate(r.payDate))}</td>
        </tr>`).join('')}
      </table></div>` : ''}`;
}

// screener filter state
const scr = { sector: 'all', dir: 'all', minScore: 0, sort: 'score' };

async function loadScreener() {
  const el = $('#stkViewScreener');
  let d;
  try { d = await api(`/api/screener?sector=${encodeURIComponent(scr.sector)}&dir=${scr.dir}&minScore=${scr.minScore}&sort=${scr.sort}&limit=60`); }
  catch (err) { el.innerHTML = empty('Could not load the screener: ' + err.message); return; }

  const opt = (v, label, cur) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(label)}</option>`;
  el.innerHTML = `
    <div class="scr-bar">
      <select class="aif-sel" data-scr="sector">
        ${opt('all', 'All sectors', scr.sector)}
        ${d.sectors.map(s => opt(s, s, scr.sector)).join('')}
      </select>
      <select class="aif-sel" data-scr="dir">
        ${opt('all', 'Up or down', scr.dir)}${opt('up', '▲ Up today', scr.dir)}${opt('down', '▼ Down today', scr.dir)}
      </select>
      <select class="aif-sel" data-scr="minScore">
        ${opt('0', 'Any score', String(scr.minScore))}${opt('50', 'Score 50+', String(scr.minScore))}
        ${opt('60', 'Score 60+', String(scr.minScore))}${opt('70', 'Score 70+', String(scr.minScore))}
        ${opt('80', 'Score 80+', String(scr.minScore))}
      </select>
      <select class="aif-sel" data-scr="sort">
        ${opt('score', 'Sort: best score', scr.sort)}${opt('change', 'Sort: top gainers', scr.sort)}
        ${opt('loser', 'Sort: top losers', scr.sort)}${opt('volume', 'Sort: most traded', scr.sort)}
      </select>
      <span class="scr-count">${fmt.int(d.matched)} match${d.matched === 1 ? '' : 'es'}</span>
    </div>
    ${d.rows.length ? `<div class="card tight tbl-wrap" style="margin-top:12px"><table>
      <tr><th>Stock</th><th>Sector</th><th class="num">Price</th><th class="num">Today</th><th class="num">Score</th><th>Insiders</th></tr>
      ${d.rows.map(r => `<tr class="clickable" onclick="go('stock/${esc(r.symbol)}')">
        <td>${tk(r.symbol)} <span class="scr-nm">${esc((r.name || '').slice(0, 34))}</span></td>
        <td class="scr-sec">${esc(r.sector || '—')}</td>
        <td class="num">${r.price == null ? '—' : '$' + fmt.num(r.price)}</td>
        <td class="num ${cls(r.change_pct)}">${fmt.pct(r.change_pct)}</td>
        <td class="num">${r.score == null ? '—' : `<span class="score-ring">${r.score}</span>`}</td>
        <td>${r.insider_sentiment ? badge(r.insider_sentiment) : '—'}</td>
      </tr>`).join('')}
    </table></div>` : `<div class="card" style="margin-top:12px">${empty('No stocks match these filters.')}</div>`}`;
}

document.addEventListener('change', e => {
  const sel = e.target.closest('[data-scr]');
  if (!sel) return;
  const k = sel.dataset.scr;
  scr[k] = k === 'minScore' ? Number(sel.value) : sel.value;
  loadScreener();
});

async function loadSectors() {
  const el = $('#stkViewSectors');
  let d;
  try { d = await api('/api/sectors'); }
  catch (err) { el.innerHTML = empty('Could not load sectors: ' + err.message); return; }
  if (!d.sectors.length) { el.innerHTML = empty('Not enough sector data yet.'); return; }

  // tile shade scales with the size of the move, so hot spots pop visually
  const peak = Math.max(...d.sectors.map(s => Math.abs(s.avgChange)), 1);
  el.innerHTML = `
    <p class="trend-hint">Average move of every tracked stock in each sector today — the quickest read on where money is going.</p>
    <div class="heat">
      ${d.sectors.map(s => {
        const up = s.avgChange >= 0;
        const strength = Math.min(1, Math.abs(s.avgChange) / peak);
        const bg = up ? `rgba(79,174,134,${(0.10 + strength * 0.34).toFixed(2)})`
                      : `rgba(224,86,106,${(0.10 + strength * 0.34).toFixed(2)})`;
        return `<div class="heat-tile" style="background:${bg}">
          <div class="ht-name">${esc(s.sector)}</div>
          <div class="ht-move ${up ? 'up' : 'down'}">${up ? '▲' : '▼'} ${Math.abs(s.avgChange).toFixed(2)}%</div>
          <div class="ht-breadth">${s.up} up · ${s.down} down · ${s.count} stocks</div>
          ${s.leader ? `<div class="ht-edge">Best <b>${esc(s.leader.symbol)}</b> ${fmt.pct(s.leader.change_pct)}</div>` : ''}
        </div>`;
      }).join('')}
    </div>`;
}

async function loadTrendingStocks() {
  const el = $('#stockDetail');
  el.innerHTML = `<div class="loading">Loading trending stocks…</div>`;
  let d;
  try { d = await api('/api/stocks-trending'); }
  catch (err) { el.innerHTML = empty('Could not load trending stocks: ' + err.message); return; }

  const section = (title, sub, rows, tag) => rows?.length ? `
    <h2 class="section">${esc(title)} <span class="sub">${esc(sub)}</span></h2>
    <div class="rel-grid">${rows.map(s => trendTile(s, tag)).join('')}</div>` : '';

  el.innerHTML =
    `<div class="trend-hint">Search any US stock above, or tap a trending one below. Every pick here is ranked from live filings and market data.</div>` +
    section('Trending on Giant Money', 'highest smart-money score right now', d.topScore,
      s => s.score != null ? `score ${s.score}` : '') +
    section('Biggest movers today', 'largest price change in the live session', d.movers,
      s => s.change_pct != null ? fmt.pct(s.change_pct) : '') +
    section('Where smart money is buying', 'heaviest insider buying this week', d.smartBuys,
      s => s.total ? fmt.usd(s.total) + ' bought' : '') +
    section('Most in the news', 'most mentioned in the last 24 hours', d.buzzing,
      s => s.mentions ? s.mentions + ' stories' : '');
}

async function loadStock(symbol) {
  state.stock = symbol;
  closeStockSuggest();
  const el = $('#stockDetail');
  el.innerHTML = `<div class="loading">Fetching live data for ${esc(symbol)}…</div>`;
  let d;
  try { d = await api('/api/stock/' + encodeURIComponent(symbol)); }
  catch (err) { el.innerHTML = empty(`Could not load ${symbol}: ${err.message}`); return; }
  const q = d.quote, f = d.fundamentals;
  const stat = (k, v, n) => `<div class="card inner stat"><div class="k">${k}</div><div class="v">${v}</div>${n ? `<div class="n">${esc(n)}</div>` : ''}</div>`;
  const newsAI = d.news.find(n => n.ai_summary);
  const capTier = d.marketCap >= 10e9 ? 'Large Cap' : d.marketCap >= 2e9 ? 'Mid Cap' : d.marketCap > 0 ? 'Small Cap' : null;
  const metaTags = [esc(symbol), 'US Stock', capTier].filter(Boolean).join(' &nbsp;·&nbsp; ');
  const chArrow = (q?.change_pct ?? 0) > 0 ? '▲' : (q?.change_pct ?? 0) < 0 ? '▼' : '·';
  const watching = getWatchlist().includes(symbol);
  const rangeTabs = ['1D', '1W', '1M', '6M', '1Y', '3Y', '5Y'].map(r =>
    `<button class="rtab ${r.toLowerCase() === curRange ? 'active' : ''}" data-range="${r.toLowerCase()}">${r}</button>`).join('');
  el.innerHTML = `
    <div class="card detail-card" style="margin-top:22px">
      <div class="dc-top">
        <div class="dc-logo"><img src="https://images.financialmodelingprep.com/symbol/${esc(symbol)}.png" alt="" onerror="this.parentElement.classList.add('blank'); this.parentElement.textContent='${esc(symbol).slice(0, 3)}'"></div>
        <div class="dc-title">
          <div class="dc-name">${esc(q?.name ?? d.info?.name ?? symbol)}</div>
          <div class="dc-meta">${metaTags}</div>
        </div>
        <div class="dc-actions">
          ${d.score ? scoreEl(d.score.score) + badge(d.score.insider_sentiment) : ''}
          <button class="watch-btn ${watching ? 'on' : ''}" onclick="addToWatchlist('${esc(symbol)}'); this.classList.add('on'); this.textContent='★ Watching'">${watching ? '★ Watching' : '☆ Add to Watchlist'}</button>
        </div>
      </div>
      <div class="dc-metric">
        <span class="dc-price">$${fmt.num(q?.price)}</span>
        <span class="dc-plabel">current price</span>
      </div>
      <div class="dc-secondary ${cls(q?.change_pct)}">${chArrow} ${fmt.pct(q?.change_pct)} <span class="dc-td">today</span> <span class="dc-live">· live · ${fmt.time(q?.updated_at)}</span></div>
      <div class="dc-chartbar">
        <div class="dc-ranges" id="rangeTabs">${rangeTabs}</div>
        <div class="chart-toggle">
          <button class="ctab ${curMode === 'line' ? 'active' : ''}" data-mode="line">Line</button>
          <button class="ctab ${curMode === 'candle' ? 'active' : ''}" data-mode="candle">Candle</button>
        </div>
      </div>
      <div class="chart-wrap" id="chartBox"></div>
    </div>
    <div class="grid cols-5">
      ${stat('Market Cap', fmt.usd(d.marketCap), f?.sharesOutstanding ? 'shares × live price (SEC XBRL)' : 'needs SEC shares data')}
      ${stat('Volume', fmt.int(q?.volume))}
      ${stat('Revenue', fmt.usd(f?.revenue?.value), f?.revenue ? `${f.revenue.form} · period end ${f.revenue.end}` : 'from SEC filings')}
      ${stat('Net Income', fmt.usd(f?.netIncome?.value), f?.netIncome ? `${f.netIncome.form} · period end ${f.netIncome.end}` : 'from SEC filings')}
      ${stat('Shares Outstanding', fmt.int(f?.sharesOutstanding?.value), f?.sharesOutstanding ? `as of ${f.sharesOutstanding.end}` : '')}
    </div>
    ${ownershipCard(d)}
    ${newsAI ? `<div class="card" style="margin-top:14px">
      <h3 class="block-title">AI Context — latest analyzed news</h3>
      <div class="news-meta"><span>${esc(newsAI.source)}</span><span>${fmt.time(newsAI.published_at)}</span>${badge(newsAI.sentiment)}</div>
      <div class="news-title" style="font-size:14.5px">${esc(deent(newsAI.title))}</div>
      <div class="news-summary"><b>AI summary —</b> ${esc(deent(newsAI.ai_summary))}</div>
      ${newsAI.ai_why ? `<div class="news-why"><b>Why it matters —</b> ${esc(deent(newsAI.ai_why))}</div>` : ''}
    </div>` : ''}
    ${d.score ? `<div class="card" style="margin-top:14px">
      <h3 class="block-title">Giant Money Score Components</h3>
      <div style="display:flex; gap:18px; flex-wrap:wrap; font-family:var(--mono); font-size:12px">
        ${Object.entries(safe(d.score.components, {})).filter(([k]) => k !== 'raw').map(([k, v]) =>
          `<span>${k}: <b class="${cls(v)}">${(v * 100).toFixed(0)}</b></span>`).join('')}
      </div></div>` : ''}
    <div class="grid cols-2">
      <div class="card tight tbl-wrap"><h3 class="block-title">Insider Activity (SEC Form 4)</h3>
        ${d.insiderTrades.length ? `<table><tr><th>Insider</th><th>Role</th><th>Side</th><th class="num">Shares</th><th class="num">Value</th><th>Date</th><th class="num">Gain</th></tr>
        ${d.insiderTrades.map(t => `<tr><td>${esc(titleCase(t.insider_name))}</td><td>${esc(String(t.insider_title).slice(0, 18))}</td>
          <td class="side-${t.side.toLowerCase()}">${t.side}</td><td class="num">${fmt.int(t.shares)}</td>
          <td class="num">${fmt.usd(t.value)}</td><td>${fmt.date(t.trade_date)}</td>
          <td class="num ${cls(t.gain_pct)}">${fmt.pct(t.gain_pct)}</td></tr>`).join('')}</table>` : empty('No recent Form 4 open-market trades captured for this stock.')}
      </div>
      <div class="card tight tbl-wrap"><h3 class="block-title">Politician Activity</h3>
        ${d.politicianTrades.length ? `<table><tr><th>Name</th><th>Chamber</th><th>Action</th><th class="num">Amount</th><th>Date</th></tr>
        ${d.politicianTrades.map(t => `<tr><td>${esc(t.name)}</td><td>${t.chamber}</td>
          <td class="side-${(t.side || '').toLowerCase()}">${esc(t.side)}</td><td class="num">${esc(t.amount || '—')}</td>
          <td>${fmt.date(t.trade_date)}</td></tr>`).join('')}</table>` : empty('No disclosed politician trades captured for this stock.')}
      </div>
      <div class="card tight tbl-wrap"><h3 class="block-title">Smart Money Activity (13F funds)</h3>
        ${(d.fundActivity.length || d.fundHolders.length) ? `<table><tr><th>Fund</th><th>Event</th><th class="num">Δ Value / Value</th><th>Filed</th></tr>
        ${d.fundActivity.map(c => `<tr><td>${esc(c.fund_name)}</td><td><span class="badge ${['new', 'increased'].includes(c.change_type) ? 'bullish' : 'bearish'}">${c.change_type}</span></td>
          <td class="num ${cls(c.new_value - c.old_value)}">${fmt.usd(c.new_value - c.old_value)}</td><td>${esc(c.filed_at)}</td></tr>`).join('')}
        ${d.fundHolders.map(h => `<tr><td>${esc(h.fund_name)}</td><td><span class="badge neutral">holding</span></td>
          <td class="num">${fmt.usd(h.value)}</td><td>—</td></tr>`).join('')}</table>` : empty('None of the tracked Top 1% funds currently report this position.')}
      </div>
      <div class="card tight"><h3 class="block-title">Recent News</h3>
        ${d.news.length ? d.news.slice(0, 8).map(n => `<div class="news-item">
          <div class="news-meta"><span>${esc(n.source)}</span><span>${fmt.time(n.published_at)}</span>${badge(n.sentiment)}</div>
          <a class="news-title" style="font-size:13.5px" href="${esc(n.link)}" target="_blank" rel="noopener">${esc(deent(n.title))}</a>
          ${n.ai_summary ? `<div class="news-summary" style="font-size:12.5px">${esc(deent(n.ai_summary))}</div>` : ''}
        </div>`).join('') : empty('No captured news mentions this ticker yet.')}
      </div>
    </div>
    <div id="govBox"></div>
    ${d.relatedStocks?.length ? `
    <h2 class="section">Related Stocks <span class="sub">what the same Top 1% investors also hold — real 13F data</span></h2>
    <div class="rel-grid">
      ${d.relatedStocks.map(r => `
        <div class="rel-card" onclick="go('stock/${esc(r.ticker)}')">
          ${logoChip(r.ticker)}
          <div class="rc-b">
            <div class="rc-t">${esc(r.ticker)}</div>
            <div class="rc-n">${esc(titleCase(r.name).slice(0, 22))}</div>
          </div>
          <div>
            <div class="rc-p ${cls(r.quote?.change_pct)}">${r.quote?.price ? '$' + fmt.num(r.quote.price) : '—'}</div>
            <div class="rc-h">${r.holders} of the same funds</div>
          </div>
        </div>`).join('')}
    </div>` : ''}`;
  // show whatever's cached instantly, then refresh the 1Y chart in the background
  curRange = '1y';
  curHist = d.history || [];
  renderChart();
  fetchAndRenderRange('1y', false);
  loadGovContracts(symbol); // async — official USAspending data
}

async function loadGovContracts(symbol) {
  const box = $('#govBox');
  if (!box) return;
  let g;
  try { g = await api('/api/gov/' + encodeURIComponent(symbol)); } catch { return; }
  if (state.stock !== symbol || !$('#govBox')) return; // user moved on
  if (!g.awards?.length) { $('#govBox').innerHTML = ''; return; }
  $('#govBox').innerHTML = `<div class="card" style="margin-top:14px">
    <h3 class="block-title">Government Contracts — ${esc(symbol)} <span style="color:var(--muted-3);text-transform:none;letter-spacing:0">· USAspending.gov (official, last 3 years)</span></h3>
    <div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:6px">
      <span style="font-family:var(--serif);font-size:26px">${fmt.usd(g.total)}</span>
      <span style="font-size:12px;color:var(--muted-2)">across top ${g.awards.length} federal awards matching "${esc(g.company)}"</span>
    </div>
    <div class="rlist">${g.awards.map(a => `
      <div class="rrow">
        <span class="pill sm gray">${esc(String(a.agency ?? '').slice(0, 26))}</span>
        <span class="nm" title="${esc(a.description ?? '')}">${esc((a.description || a.id || '').slice(0, 60))}</span>
        <span class="val" style="color:var(--muted-3)">${esc(a.start ?? '')}</span>
        <span class="val up">${fmt.usd(a.amount)}</span>
      </div>`).join('')}</div>
  </div>`;
}

// fetch real history for a range and render (shared by initial load + tabs)
const chartSymbol = () => state.index || state.stock;
async function fetchAndRenderRange(range, showLoading) {
  const sym = chartSymbol();
  if (!sym) return;
  curRange = range;
  document.querySelectorAll('.rtab').forEach(t => t.classList.toggle('active', t.dataset.range === range));
  const box = $('#chartBox');
  if (showLoading && box) box.innerHTML = `<div class="loading" style="padding:78px 0">Loading ${range.toUpperCase()} chart…</div>`;
  try {
    const h = await api('/api/history/' + encodeURIComponent(sym) + '?range=' + range);
    if (curRange === range) curHist = h.history || []; // ignore stale responses
  } catch { /* keep whatever we have */ }
  if (curRange === range) renderChart();
}

// chart time-range tabs (delegated)
document.addEventListener('click', e => {
  const rt = e.target.closest('.rtab');
  if (!rt || !chartSymbol() || rt.dataset.range === curRange) return;
  fetchAndRenderRange(rt.dataset.range, true);
});

// ── market index chart view (opened from the dashboard index cards) ─────────
async function loadIndex(symbol) {
  state.index = symbol;
  const el = $('#stockDetail');
  el.innerHTML = `<div class="loading">Loading ${esc(symbol)} chart…</div>`;
  let d;
  try { d = await api('/api/index/' + encodeURIComponent(symbol)); }
  catch (err) { el.innerHTML = empty(`Could not load index: ${err.message}`); return; }
  const ix = d.index;
  const chArrow = (ix.change_1d ?? 0) > 0 ? '▲' : (ix.change_1d ?? 0) < 0 ? '▼' : '·';
  const rangeTabs = ['1D', '1W', '1M', '6M', '1Y', '3Y', '5Y'].map(r =>
    `<button class="rtab ${r.toLowerCase() === '1y' ? 'active' : ''}" data-range="${r.toLowerCase()}">${r}</button>`).join('');
  el.innerHTML = `
    <button class="back-btn" onclick="go('dashboard')">← Dashboard</button>
    <div class="card detail-card">
      <div class="dc-top">
        <div class="dc-logo" style="background:var(--gold-bg);color:var(--gold);font-family:var(--serif);font-size:22px">📈</div>
        <div class="dc-title">
          <div class="dc-name">${esc(ix.name)}</div>
          <div class="dc-meta">${esc(symbol)} &nbsp;·&nbsp; US Market Index &nbsp;·&nbsp; Market ${esc(ix.market_state)}</div>
        </div>
      </div>
      <div class="dc-metric"><span class="dc-price">${fmt.num(ix.price)}</span><span class="dc-plabel">index level</span></div>
      <div class="dc-secondary ${cls(ix.change_1d)}">${chArrow} ${fmt.pct(ix.change_1d)} <span class="dc-td">today</span>
        <span class="dc-live">· ${ix.change_1w != null ? 'week ' + fmt.pct(ix.change_1w) + ' · ' : ''}${ix.change_1m != null ? 'month ' + fmt.pct(ix.change_1m) + ' · ' : ''}updated ${fmt.time(ix.updated_at)}</span></div>
      <div class="dc-chartbar">
        <div class="dc-ranges" id="rangeTabs">${rangeTabs}</div>
        <div class="chart-toggle">
          <button class="ctab ${curMode === 'line' ? 'active' : ''}" data-mode="line">Line</button>
          <button class="ctab ${curMode === 'candle' ? 'active' : ''}" data-mode="candle">Candle</button>
        </div>
      </div>
      <div class="chart-wrap" id="chartBox"></div>
    </div>
    <div class="trend-hint">Live US market index. Daily bars are real Yahoo Finance history; today's level updates every 60 seconds from the backend loop.</div>`;
  curRange = '1y';
  curHist = d.history || [];
  renderChart();
  fetchAndRenderRange('1y', false);
}

// ── watchlist ──────────────────────────────────────────────────────────────
const WL_KEY = 'giantmoney_watchlist';
function getWatchlist() {
  try { return JSON.parse(localStorage.getItem(WL_KEY)) ?? []; } catch { return []; }
}
function setWatchlist(list) {
  localStorage.setItem(WL_KEY, JSON.stringify(list));
}
window.removeFromWatchlist = symbol => {
  setWatchlist(getWatchlist().filter(s => s !== symbol));
  loadWatchlist();
};
window.addToWatchlist = symbol => {
  symbol = symbol.toUpperCase();
  const list = getWatchlist();
  if (!list.includes(symbol)) { list.unshift(symbol); setWatchlist(list.slice(0, 20)); }
  $('#wlSearch').value = '';
  $('#wlSuggest').style.display = 'none';
  loadWatchlist();
};

const WL_CAPS = [
  { icon: '⭐', title: 'Save any stock', sub: 'Add tickers from search, or straight from any stock, politician or investor page across the app.' },
  { icon: '🔔', title: 'Live price & score', sub: 'Every saved stock shows its live price, daily change and Giant Money Score, refreshed on the same 60-second loop as the dashboard.' },
  { icon: '🧵', title: 'Smart-money alerts', sub: 'See the latest Form 4 insider trades, 13F fund moves and politician disclosures for only the stocks you\'re watching.' },
];

let wlTimer;
$('#wlSearch').addEventListener('input', () => {
  clearTimeout(wlTimer);
  const q = $('#wlSearch').value.trim();
  if (!q) { $('#wlSuggest').style.display = 'none'; return; }
  wlTimer = setTimeout(async () => {
    const rows = await api('/api/search?q=' + encodeURIComponent(q));
    const el = $('#wlSuggest');
    el.innerHTML = rows.map(r =>
      `<div onclick="addToWatchlist('${esc(r.ticker)}')">${logoChip(r.ticker)}<b style="font-family:var(--mono)">${esc(r.ticker)}</b><span style="color:var(--muted)">${esc(r.name)}</span></div>`).join('');
    el.style.display = rows.length ? '' : 'none';
  }, 250);
});
$('#wlSearch').addEventListener('keydown', e => {
  if (e.key === 'Enter' && $('#wlSearch').value.trim()) addToWatchlist($('#wlSearch').value.trim());
});

async function loadWatchlist() {
  const symbols = getWatchlist();
  // rules are evaluated against the alert feed, which is independent of the
  // watchlist — render them even when the watchlist itself is empty
  refreshAlertData().then(() => { renderRules(); renderNotifs(); });
  renderRules();
  $('#wlCaps').innerHTML = WL_CAPS.map(c => `
    <div class="card tile">
      <div style="font-size:22px">${c.icon}</div>
      <div style="font-family:var(--serif); font-size:17px; margin-top:8px">${esc(c.title)}</div>
      <div class="n" style="font-size:12px; line-height:1.6; margin-top:4px">${esc(c.sub)}</div>
    </div>`).join('');

  if (!symbols.length) {
    $('#wlQuotes').innerHTML = empty('Your watchlist is empty — search a ticker above to add your first stock.');
    $('#wlEvents').innerHTML = empty('Add a stock to see its smart-money activity here.');
    return;
  }
  $('#wlQuotes').innerHTML = `<div class="loading">Loading live quotes…</div>`;
  let d;
  try { d = await api('/api/watch?symbols=' + symbols.join(',')); }
  catch (err) { $('#wlQuotes').innerHTML = empty('Could not load watchlist quotes: ' + err.message); return; }

  $('#wlQuotes').innerHTML = d.quotes.length ? `<table>
    <tr><th></th><th>Symbol</th><th>Name</th><th class="num">Price</th><th class="num">Change</th><th class="num">Score</th><th></th></tr>
    ${d.quotes.map(q => `<tr>
      <td>${logoChip(q.symbol)}</td>
      <td><a href="#stock/${esc(q.symbol)}" class="tk">${esc(q.symbol)}</a></td>
      <td>${esc(q.name ?? '—')}</td>
      <td class="num">${q.price ? '$' + fmt.num(q.price) : '—'}</td>
      <td class="num ${cls(q.change_pct)}">${fmt.pct(q.change_pct)}</td>
      <td class="num">${q.score != null ? scoreEl(q.score) : '—'}</td>
      <td><button class="back-btn" style="margin:0" onclick="removeFromWatchlist('${esc(q.symbol)}')">Remove</button></td>
    </tr>`).join('')}
  </table>` : empty('No live quotes yet for these symbols.');

  $('#wlEvents').innerHTML = d.events.length ? `<div class="rlist">${d.events.map(e => {
    const isFund = e.kind === '13F';
    const label = isFund
      ? `${{ new: 'opened', increased: 'added to', reduced: 'trimmed', closed: 'exited' }[e.side] ?? e.side} ${esc(e.ticker)}`
      : `${e.side === 'Buy' ? 'bought' : e.side === 'Sell' ? 'sold' : e.side} ${esc(e.ticker)}`;
    const up = isFund ? ['new', 'increased'].includes(e.side) : e.side === 'Buy';
    return `<div class="rrow">
      <span class="pill sm gray">${esc(e.kind)}</span>
      <span class="nm">${esc(titleCase(e.who))} ${label}</span>
      <span class="val" style="color:var(--muted-3)">${fmt.date(e.date)}</span>
      ${e.amt != null ? `<span class="val ${up ? 'up' : 'down'}">${fmt.usd(e.amt)}</span>` : ''}
    </div>`;
  }).join('')}</div>` : empty('No insider, fund or politician activity captured yet for your watchlist.');
}

// ── profile (local account — real counts + live watchlist avg, editable info) ─
function getProfile() { return safe(localStorage.getItem('gm_profile'), {}) || {}; }
function saveProfile(p) { localStorage.setItem('gm_profile', JSON.stringify(p)); }
function memberSince() {
  let t = Number(localStorage.getItem('gm_member_since') || 0);
  if (!t) { t = Date.now(); localStorage.setItem('gm_member_since', String(t)); }
  return t;
}
function initialsOf(name) {
  const s = String(name || '').trim();
  if (!s) return 'GM';
  return s.split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
}
function refreshSideProfile() {
  const p = getProfile();
  if ($('#sidePn')) $('#sidePn').textContent = p.name || 'Guest';
  if ($('#sidePp')) $('#sidePp').textContent = p.email || 'Free plan';
  const pfp = $('#sidePfp');
  if (pfp) {
    // a saved display picture replaces the initials, WhatsApp-style
    if (p.photo) pfp.innerHTML = `<img src="${esc(p.photo)}" alt="">`;
    else pfp.textContent = initialsOf(p.name);
  }
}

// ── Display picture ────────────────────────────────────────────────────────
// The photo never leaves the device: it is downscaled in the browser and kept
// in localStorage next to the rest of the local profile.
const DP_SIZE = 512;          // big enough to stay crisp in the full-size viewer
const DP_MAX_BYTES = 8e6;     // reject absurd files before decoding them

// Decode honouring EXIF rotation. Phone photos carry an orientation flag; an
// <img> ignores it in some engines and the DP ends up sideways.
async function decodeUpright(file) {
  if ('createImageBitmap' in window) {
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); }
    catch { /* fall through to the <img> path */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = () => rej(new Error('That image could not be opened.'));
      img.src = url;
    });
    return img;
  } finally { URL.revokeObjectURL(url); }
}

// Interactive cropper. Auto-cropping guesses where the face is and gets it
// wrong; letting the user drag and zoom is the only way to always get it right.
const DP_STAGE = 300; // on-screen crop stage, in CSS px

async function openDpCropper(file) {
  if (!/^image\//.test(file.type)) throw new Error('That file is not an image.');
  if (file.size > DP_MAX_BYTES) throw new Error('That photo is too large — try one under 8 MB.');
  const src = await decodeUpright(file);

  const host = document.createElement('div');
  host.className = 'dp-modal';
  host.innerHTML = `
    <div class="dp-card" role="dialog" aria-label="Position your photo">
      <div class="dp-title">Position your photo</div>
      <div class="dp-hint">Drag to move · pinch or use the slider to zoom</div>
      <div class="dp-stage" style="width:${DP_STAGE}px;height:${DP_STAGE}px">
        <canvas class="dp-canvas" width="${DP_STAGE}" height="${DP_STAGE}"></canvas>
        <div class="dp-ring"></div>
      </div>
      <div class="dp-zoom">
        <span>−</span>
        <input type="range" class="dp-range" min="100" max="300" value="100">
        <span>+</span>
      </div>
      <div class="dp-actions">
        <button class="dp-btn dp-cancel">Cancel</button>
        <button class="dp-btn dp-save">Set as photo</button>
      </div>
    </div>`;
  document.body.appendChild(host);

  const canvas = host.querySelector('.dp-canvas');
  const ctx = canvas.getContext('2d');
  const range = host.querySelector('.dp-range');

  const w = src.width, h = src.height;
  const base = DP_STAGE / Math.min(w, h); // "cover" the stage at zoom 1
  let zoom = 1;
  // start centred; the user nudges from here
  let ox = (DP_STAGE - w * base) / 2;
  let oy = (DP_STAGE - h * base) / 2;

  const draw = () => {
    const dw = w * base * zoom, dh = h * base * zoom;
    // never let the photo pull away from the circle's edges
    ox = Math.min(0, Math.max(DP_STAGE - dw, ox));
    oy = Math.min(0, Math.max(DP_STAGE - dh, oy));
    ctx.clearRect(0, 0, DP_STAGE, DP_STAGE);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, ox, oy, dw, dh);
  };
  draw();

  // drag to reposition
  let dragging = false, lastX = 0, lastY = 0;
  canvas.addEventListener('pointerdown', e => {
    dragging = true; lastX = e.clientX; lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', e => {
    if (!dragging) return;
    ox += e.clientX - lastX; oy += e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    draw();
  });
  const endDrag = () => { dragging = false; };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  // zoom keeps the centre of the circle fixed
  const setZoom = next => {
    const prev = zoom;
    zoom = Math.min(3, Math.max(1, next));
    const c = DP_STAGE / 2;
    ox = c - (c - ox) * (zoom / prev);
    oy = c - (c - oy) * (zoom / prev);
    range.value = String(Math.round(zoom * 100));
    draw();
  };
  range.addEventListener('input', () => setZoom(Number(range.value) / 100));
  canvas.addEventListener('wheel', e => { e.preventDefault(); setZoom(zoom * (e.deltaY < 0 ? 1.06 : 0.94)); }, { passive: false });

  return new Promise(resolve => {
    const close = val => { host.remove(); src.close?.(); resolve(val); };
    host.querySelector('.dp-cancel').onclick = () => close(null);
    host.addEventListener('click', e => { if (e.target === host) close(null); });
    host.querySelector('.dp-save').onclick = () => {
      // re-render the exact same framing at full DP resolution
      const out = document.createElement('canvas');
      out.width = out.height = DP_SIZE;
      const k = DP_SIZE / DP_STAGE;
      const octx = out.getContext('2d');
      octx.imageSmoothingEnabled = true;
      octx.imageSmoothingQuality = 'high';
      octx.drawImage(src, ox * k, oy * k, w * base * zoom * k, h * base * zoom * k);
      close(out.toDataURL('image/jpeg', 0.92));
    };
  });
}

window.pickProfilePhoto = () => {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const dataUrl = await openDpCropper(file);
      if (!dataUrl) return; // cancelled
      const p = getProfile();
      p.photo = dataUrl;
      saveProfile(p);
      refreshSideProfile();
      loadProfile();
      toast?.('Display picture updated');
    } catch (err) {
      toast?.(String(err.message || err));
    }
  };
  input.click();
};

window.removeProfilePhoto = () => {
  const p = getProfile();
  delete p.photo;
  saveProfile(p);
  refreshSideProfile();
  loadProfile();
  toast?.('Display picture removed');
};

// Tapping the picture shows it full size, the way a social profile does —
// changing it stays on the explicit "Change photo" button.
window.viewProfilePhoto = () => {
  const p = getProfile();
  if (!p.photo) return pickProfilePhoto();

  const host = document.createElement('div');
  host.className = 'dp-view';
  host.innerHTML = `
    <button class="dpv-close" aria-label="Close">✕</button>
    <figure class="dpv-fig">
      <img src="${esc(p.photo)}" alt="Profile photo">
      <figcaption>${esc(getProfile().name || 'Your photo')}</figcaption>
    </figure>
    <div class="dpv-actions">
      <button class="dp-btn dpv-change">Change photo</button>
      <button class="dp-btn dpv-remove">Remove</button>
    </div>`;
  document.body.appendChild(host);

  const close = () => { host.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  host.addEventListener('click', e => { if (e.target === host) close(); });
  host.querySelector('.dpv-close').onclick = close;
  host.querySelector('.dpv-change').onclick = () => { close(); pickProfilePhoto(); };
  host.querySelector('.dpv-remove').onclick = () => { close(); removeProfilePhoto(); };
};

window.saveProfileForm = () => {
  saveProfile({ name: $('#pfName').value.trim(), email: $('#pfEmail').value.trim() });
  refreshSideProfile();
  loadProfile();
};
window.toggleProfileEdit = show => {
  const f = $('#pfEdit'); if (f) f.style.display = show ? '' : 'none';
};

async function loadProfile() {
  memberSince();
  const p = getProfile();
  const wl = getWatchlist();
  let avg = null;
  if (wl.length) {
    try {
      const d = await api('/api/watch?symbols=' + wl.join(','));
      const ch = (d.quotes || []).map(q => q.change_pct).filter(x => x != null && isFinite(x));
      if (ch.length) avg = ch.reduce((a, b) => a + b, 0) / ch.length;
    } catch { /* keep null */ }
  }
  let investors = 24;
  try { investors = (await api('/api/top1')).funds?.length ?? 24; } catch { /* default */ }
  const since = new Date(memberSince()).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const name = p.name || 'Guest';
  const email = p.email || 'Add your email';

  const action = (icon, label, val, href) => `
    <a class="qa" href="${href}">
      <div class="qa-ic">${icon}</div>
      <div><div class="qa-l">${esc(label)}</div><div class="qa-v">${esc(val)}</div></div>
    </a>`;

  // handle: derived from the name, shown like a social profile
  const handle = '@' + (p.name || 'guest').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 18);
  const stat = (n, label, href) => `
    <a class="ig-stat" href="${href}"><b>${n}</b><span>${esc(label)}</span></a>`;

  $('#profileBody').innerHTML = `
    <div class="card ig-head">
      <button class="ig-av ${p.photo ? 'has-dp' : ''}"
              onclick="${p.photo ? 'viewProfilePhoto()' : 'pickProfilePhoto()'}"
              title="${p.photo ? 'View photo' : 'Add a photo'}">
        ${p.photo ? `<img src="${esc(p.photo)}" alt="">` : `<span class="ig-init">${initialsOf(p.name)}</span>`}
        <span class="pf-cam">${p.photo ? '🔍' : '📷'}</span>
      </button>

      <div class="ig-main">
        <div class="ig-top">
          <div class="ig-handle">${esc(handle)}</div>
          <button class="pf-edit" onclick="toggleProfileEdit(true)">Edit profile</button>
          <button class="pf-edit" onclick="pickProfilePhoto()">${p.photo ? 'Change photo' : 'Add photo'}</button>
          ${p.photo ? `<button class="pf-edit ghost" onclick="removeProfilePhoto()">Remove</button>` : ''}
        </div>

        <div class="ig-stats">
          ${stat(wl.length, 'watching', '#watchlist')}
          ${stat(alertTickers.length, 'alerts', '#watchlist')}
          ${stat(investors, 'giants tracked', '#top1')}
        </div>

        <div class="ig-bio">
          <div class="ig-name">${esc(name)} <span class="pill gray sm">Free Plan</span></div>
          <div class="ig-line">${esc(email)}</div>
          <div class="ig-line muted">Member since ${esc(since)} · profile stored on this device</div>
          <div class="ig-line">
            Watchlist today
            <b class="${cls(avg)}">${avg == null ? '—' : (avg >= 0 ? '▲ ' : '▼ ') + fmt.pct(avg, false)}</b>
            ${wl.length ? `<span class="muted">avg across ${wl.length} stock${wl.length > 1 ? 's' : ''}</span>` : `<span class="muted">add stocks to see this</span>`}
          </div>
        </div>
      </div>

      <div class="pf-editform" id="pfEdit" style="display:none">
        <input id="pfName" placeholder="Your name" value="${esc(p.name || '')}" maxlength="40">
        <input id="pfEmail" placeholder="Email (optional)" value="${esc(p.email || '')}" maxlength="60">
        <button class="btn-primary" style="width:auto;padding:9px 16px" onclick="saveProfileForm()">Save</button>
        <button class="pf-edit" onclick="toggleProfileEdit(false)">Cancel</button>
      </div>
    </div>

    <h2 class="section">Quick Actions</h2>
    <div class="grid cols-4">
      ${action('⭐', 'Watchlist', wl.length + ' stock' + (wl.length === 1 ? '' : 's'), '#watchlist')}
      ${action('🔔', 'Alerts', alertTickers.length + ' saved', '#watchlist')}
      ${action('👑', 'Top 1% Investors', investors + ' tracked', '#top1')}
      ${action('🔎', 'Research a Stock', 'search any ticker', '#stocks')}
    </div>`;
  refreshSideProfile();
}

// ── news ───────────────────────────────────────────────────────────────────
// beginner-friendly news buckets (labels shown in the one-line chip bar)
const NEWS_CAT_META = [
  ['all', '🗞 All'],
  ['us', '🇺🇸 US Markets'],
  ['earnings', '📊 Earnings'],
  ['ipo', '🚀 IPOs'],
  ['deals', '🤝 Deals & M&A'],
  ['crypto', '🪙 Crypto'],
  ['economy', '🏦 Economy'],
  ['world', '🌍 World'],
];
const NEWS_CAT_LABEL = { us: 'US Markets', earnings: 'Earnings', ipo: 'IPO', deals: 'Deals', crypto: 'Crypto', economy: 'Economy', world: 'World' };
let newsCat = 'all';
// AI triage filters: market direction, subject, and "only what actually matters"
let newsMood = 'all';        // all | Bullish | Bearish | Neutral
let newsTopic = 'all';       // AI subject tag
let newsBigOnly = false;     // hide Low-importance noise
const NEWS_MOODS = [['all', 'All'], ['Bullish', '▲ Bullish'], ['Bearish', '▼ Bearish'], ['Neutral', '• Neutral']];
const NEWS_TOPICS = ['all', 'Earnings', 'M&A', 'Fed & Economy', 'Regulation', 'Crypto', 'IPO', 'Guidance', 'Legal', 'Product', 'Markets'];

// how loud a story is, per the AI's own impact rating
function impBadge(a) {
  if (a.importance === 'High') return `<span class="imp imp-high" title="Impact ${a.impact_score ?? ''}/100">🔥 Major</span>`;
  if (a.importance === 'Medium') return `<span class="imp imp-mid" title="Impact ${a.impact_score ?? ''}/100">Notable</span>`;
  return '';
}
const topicPill = t => t ? `<span class="topic-pill">${esc(t)}</span>` : '';
// a "summary" that just repeats the headline tells the reader nothing
const usefulSummary = n => {
  const s = String(n.ai_summary ?? '').trim();
  return s && s.toLowerCase() !== String(n.title ?? '').trim().toLowerCase() ? s : '';
};

// ── recency ────────────────────────────────────────────────────────────────
// A flat list of "9h ago" labels makes everything look equally old. Bucketing
// by calendar day (not raw elapsed hours) matches how people actually read a
// feed: what just landed, what came earlier today, what is yesterday's news.
const DAY = 86400e3;
const isFresh = ts => ts && Date.now() - ts < 3600e3;   // under an hour
function newsBucket(ts) {
  if (!ts) return { key: 'older', label: 'Earlier' };
  const age = Date.now() - ts;
  if (age < 3600e3) return { key: 'now', label: 'Just in', note: 'in the last hour' };
  const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
  if (ts >= startOfToday.getTime()) return { key: 'today', label: 'Earlier today' };
  if (ts >= startOfToday.getTime() - DAY) return { key: 'yest', label: 'Yesterday' };
  if (age < 7 * DAY) return { key: 'week', label: 'This week' };
  return { key: 'older', label: 'Earlier' };
}
// exact timestamp for the title attribute, so hovering gives the real time
const exactTime = ts => ts
  ? new Date(ts).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' })
  : '';

function catPill(c) {
  return c && c !== 'all' ? `<span class="cat-pill cat-${esc(c)}">${esc(NEWS_CAT_LABEL[c] ?? c)}</span>` : '';
}

const CAT_EMOJI = { us: '🇺🇸', earnings: '📊', ipo: '🚀', deals: '🤝', crypto: '🪙', economy: '🏦', world: '🌍' };

function newsThumb(n, cls2) {
  if (n.image) {
    return `<div class="${cls2}"><img src="${esc(n.image)}" alt="" loading="lazy"
      onerror="this.parentElement.classList.add('nt-fall'); this.remove(); this.parentElement.textContent='${CAT_EMOJI[n.category] ?? '🗞'}'"></div>`;
  }
  return `<div class="${cls2} nt-fall">${CAT_EMOJI[n.category] ?? '🗞'}</div>`;
}

async function loadNews() {
  const q = new URLSearchParams({ limit: 80, cat: newsCat, mood: newsMood, topic: newsTopic });
  if (newsBigOnly) q.set('important', '1');
  const d = await api('/api/news?' + q);
  $('#newsMeta').innerHTML = d.aiEngine === 'claude'
    ? 'Every story is read by Claude — summarized, rated Bullish or Bearish, and scored for how much it matters.'
    : 'Every story is auto-analyzed — rated Bullish or Bearish and scored for how much it matters. '
      + '<span style="color:var(--muted-3)">Full written summaries need an Anthropic API key.</span>';
  $('#newsCats').innerHTML = NEWS_CAT_META.map(([c, label]) =>
    `<button class="ncat ${c === newsCat ? 'active' : ''}" data-cat="${c}">${label}<span class="nc-n">${d.counts?.[c] ?? 0}</span></button>`).join('');

  // ── AI filter bar: direction · subject · importance ──
  $('#newsAI').innerHTML = `
    <div class="aif-row">
      <span class="aif-label">AI FILTER</span>
      <div class="aif-group">
        ${NEWS_MOODS.map(([m, label]) => `<button class="aif ${m === newsMood ? 'on' : ''} mood-${m}" data-mood="${m}">${label}${
          m !== 'all' && d.moodCounts?.[m] != null ? `<span class="aif-n">${d.moodCounts[m]}</span>` : ''}</button>`).join('')}
      </div>
      <button class="aif aif-big ${newsBigOnly ? 'on' : ''}" data-big="1">🔥 Important only${
        d.importantCount != null ? `<span class="aif-n">${d.importantCount}</span>` : ''}</button>
      <select class="aif-sel" id="newsTopicSel">
        ${NEWS_TOPICS.map(t => `<option value="${esc(t)}" ${t === newsTopic ? 'selected' : ''}>${
          t === 'all' ? 'Any subject' : esc(t)}${t !== 'all' && d.topicCounts?.[t] ? ` (${d.topicCounts[t]})` : ''}</option>`).join('')}
      </select>
      ${(newsMood !== 'all' || newsTopic !== 'all' || newsBigOnly)
        ? `<button class="aif aif-clear" data-clear="1">✕ Clear</button><span class="aif-count">${d.matched ?? 0} match${(d.matched ?? 0) === 1 ? '' : 'es'}</span>`
        : ''}
    </div>`;

  if (!d.articles.length) {
    $('#newsList').innerHTML = `<div class="card">${empty('No stories match these filters — try clearing one.')}</div>`;
    return;
  }
  // Strictly newest-first, and the hero really is the newest story. It used to
  // be "newest one that happens to have a photo", which quietly buried fresher
  // headlines behind older illustrated ones.
  const list = [...d.articles].sort((a, b) => (b.published_at ?? 0) - (a.published_at ?? 0));
  const hero = list[0];
  const rest = list.slice(1);
  const freshCount = list.filter(a => isFresh(a.published_at)).length;

  const liveStrip = `
    <div class="news-live">
      <span class="nl-dot"></span>
      <span class="nl-lead">LATEST FIRST</span>
      <span class="nl-time">newest story ${fmt.time(hero.published_at)}</span>
      ${freshCount ? `<span class="nl-new">${freshCount} in the last hour</span>` : ''}
      <span class="nl-total">${list.length} stories</span>
    </div>`;

  const heroHTML = `
    <a class="nh-card" href="${esc(hero.link)}" target="_blank" rel="noopener">
      ${newsThumb(hero, 'nh-img')}
      <div class="nh-body">
        <div class="news-meta">
          <span class="nh-flag">${isFresh(hero.published_at) ? '● JUST IN' : '★ TOP STORY'}</span>
          <span class="nh-when" title="${esc(exactTime(hero.published_at))}">${fmt.time(hero.published_at)}</span>
          <span class="nh-src">${esc(hero.source)}</span>
          ${badge(hero.sentiment)}
        </div>
        <div class="nh-title">${esc(deent(hero.title))}</div>
        ${usefulSummary(hero) ? `<div class="news-summary"><b>AI summary —</b> ${esc(deent(hero.ai_summary))}</div>` : ''}
        ${hero.ai_why ? `<div class="news-why"><b>Why it matters —</b> ${esc(deent(hero.ai_why))}</div>` : ''}
        ${hero.tickers?.length ? `<div class="news-foot">${hero.tickers.slice(0, 4).map(tk).join('')}</div>` : ''}
      </div>
    </a>`;

  // Every card carries the full AI read — summary, why it matters and the
  // direction call — so the feed answers the question without opening anything.
  const card = n => `
    <a class="nc-card ${isFresh(n.published_at) ? 'is-new' : ''}" href="${esc(n.link)}" target="_blank" rel="noopener">
      <div class="nc-head">
        ${newsThumb(n, 'nc-img')}
        <div class="nc-htext">
          <div class="nc-title">${esc(deent(n.title))}</div>
          <div class="nc-src">
            ${isFresh(n.published_at) ? '<span class="nc-new">NEW</span>' : ''}
            <span class="nc-ago" title="${esc(exactTime(n.published_at))}">${fmt.time(n.published_at)}</span>
            <span class="nc-src-name">${esc(n.source)}</span>
          </div>
        </div>
        <span class="nc-dir ${String(n.sentiment || '').toLowerCase()}">${
          n.sentiment === 'Bullish' ? '▲ Bullish'
          : n.sentiment === 'Bearish' ? '▼ Bearish'
          : n.sentiment ? '• Neutral' : ''}</span>
      </div>
      ${usefulSummary(n) ? `<div class="nc-sum"><b>AI summary</b> ${esc(deent(n.ai_summary))}</div>` : ''}
      ${n.ai_why ? `<div class="nc-why"><b>Why it matters</b> ${esc(deent(n.ai_why))}</div>` : ''}
      <div class="nc-meta">
        ${n.importance === 'High' ? '<span class="imp imp-high">🔥 Major</span>' : ''}
        ${topicPill(n.topic)}
        ${n.tickers?.length ? `<span class="nc-tks">${n.tickers.slice(0, 3).map(tk).join('')}</span>` : ''}
      </div>
    </a>`;

  // Walk the sorted list and open a new section each time the day bucket
  // changes, so the reader always knows how old what they're looking at is.
  let html = '', current = null;
  for (const n of rest) {
    const b = newsBucket(n.published_at);
    if (b.key !== current) {
      if (current !== null) html += '</div>';
      html += `<div class="news-sep ${b.key === 'now' ? 'hot' : ''}">
          <span class="ns-label">${esc(b.label)}</span>
          ${b.note ? `<span class="ns-note">${esc(b.note)}</span>` : ''}
          <span class="ns-line"></span>
        </div><div class="news-grid">`;
      current = b.key;
    }
    html += card(n);
  }
  if (current !== null) html += '</div>';

  $('#newsList').innerHTML = liveStrip + heroHTML + html;
}
// news category chips (delegated)
document.addEventListener('click', e => {
  const chip = e.target.closest('.ncat');
  if (!chip) return;
  newsCat = chip.dataset.cat;
  loadNews();
});
// AI filter bar: mood chips, importance toggle, clear (delegated)
document.addEventListener('click', e => {
  const btn = e.target.closest('.aif');
  if (!btn) return;
  if (btn.dataset.clear) { newsMood = 'all'; newsTopic = 'all'; newsBigOnly = false; }
  else if (btn.dataset.big) newsBigOnly = !newsBigOnly;
  else if (btn.dataset.mood) newsMood = btn.dataset.mood;
  else return;
  loadNews();
});
document.addEventListener('change', e => {
  if (e.target.id !== 'newsTopicSel') return;
  newsTopic = e.target.value;
  loadNews();
});

// ── Battle Room — 1v1/group paper-portfolio contests, scored on real prices ─
// Server-backed room codes + polling "realtime". All data access lives in the
// battleRoom module so it can be swapped for a real socket layer untouched.
const MYB_KEY = 'gm_my_battles';
const getMyBattles = () => safe(localStorage.getItem(MYB_KEY), []) || [];
const setMyBattles = l => { localStorage.setItem(MYB_KEY, JSON.stringify(l.slice(0, 60))); updateBattleBadge(); };
const addMyBattle = (id, role) => { const l = getMyBattles().filter(x => x.id !== id); l.unshift({ id, role, status: 'waiting' }); setMyBattles(l); };
const markMyBattle = (id, patch) => setMyBattles(getMyBattles().map(x => x.id === id ? { ...x, ...patch } : x));
const myRoleIn = code => getMyBattles().find(x => x.id === code)?.role ?? null;

function updateBattleBadge() {
  const n = getMyBattles().filter(b => b.status !== 'finished').length;
  const el = $('#battleBadge');
  if (el) { el.textContent = n; el.style.display = n ? '' : 'none'; }
}

const myName = () => { const n = (getProfile().name || '').trim(); return (!n || n.toLowerCase() === 'guest') ? '' : n; };
const setMyName = n => { const p = getProfile(); p.name = String(n).trim().slice(0, 24); saveProfile(p); try { refreshSideProfile(); } catch { /* noop */ } };

const pctTxt = v => (v == null ? '—' : (v > 0 ? '+' : '') + Number(v).toFixed(2) + '%');
const usd0 = v => (v == null ? '—' : '$' + Math.round(v).toLocaleString('en-US'));
const roomLink = code => `${location.origin}/app#battle/join/${code}`;
const waInvite = (code, days = 7) => `https://wa.me/?text=${encodeURIComponent(`⚔️ I challenge you to a ${days}-day stock battle on Giant Money! Join my room: ${roomLink(code)} — loser buys chai ☕`)}`;
function countdown(endAt) {
  const ms = (endAt ?? 0) - Date.now();
  if (ms <= 0) return 'Ended';
  const d = Math.floor(ms / 864e5), h = Math.floor((ms % 864e5) / 36e5);
  return `Ends in ${d}d ${h}h`;
}
const battlesChrome = home => { const h = $('#battlesHead'); if (h) h.style.display = home ? '' : 'none'; };

// toast (copied / joined / ready / invalid)
function toast(msg, kind = 'ok') {
  let t = $('#gmToast');
  if (!t) { t = document.createElement('div'); t.id = 'gmToast'; document.body.appendChild(t); }
  t.textContent = msg; t.className = 'gm-toast show ' + kind;
  clearTimeout(toast._t); toast._t = setTimeout(() => { t.className = 'gm-toast ' + kind; }, 2100);
}

// ── data layer (swap for sockets later without touching the UI) ─────────────
const battleRoom = {
  demoMode: true,
  _poll: null,
  create(settings) { return api('/api/battles', { method: 'POST', body: { player: myName() || 'You', settings } }); },
  get(code) { return api('/api/battles/' + encodeURIComponent(code)); },
  join(code, name) { return api('/api/battles/' + encodeURIComponent(code) + '/join', { method: 'POST', body: { player: name } }); },
  pick(code, role, picks) { return api('/api/battles/' + encodeURIComponent(code) + '/pick', { method: 'POST', body: { role, picks } }); },
  trash(code, role, text) { return api('/api/battles/' + encodeURIComponent(code) + '/trash', { method: 'POST', body: { role, text } }); },
  start(code) { return api('/api/battles/' + encodeURIComponent(code) + '/start', { method: 'POST', body: {} }); },
  watch(code, cb) { this.unwatch(); this._code = code; const tick = async () => { try { cb(await this.get(code)); } catch { /* transient */ } }; this._poll = setInterval(tick, 2500); },
  unwatch() { if (this._poll) clearInterval(this._poll); this._poll = null; },
};

// demoMode: a real second player (Rahul_Trades) auto-joins + picks real stocks
async function demoOpponent(code) {
  if (!battleRoom.demoMode) return;
  await new Promise(r => setTimeout(r, 3800));
  let room; try { room = await battleRoom.get(code); } catch { return; }
  if (!room || room.status !== 'waiting' || room.players.length >= 2) return;
  try { await battleRoom.join(code, 'Rahul_Trades'); } catch { return; }
  battleRoom.trash(code, 'b', "You're going down 😎").catch(() => {});
  await new Promise(r => setTimeout(r, 3200));
  try {
    const d = await api('/api/pick-stocks');
    const picks = d.stocks.slice(1, 1 + room.settings.maxPicks).map(s => s.ticker);
    if (picks.length) await battleRoom.pick(code, 'b', picks);
  } catch { /* opponent will show as still picking */ }
}

// ── the stock picker (shared; honours the room's max picks) ─────────────────
let pkSel = new Set(), pkTimer = null, pkOnConfirm = null, pkMax = 5;
function renderPicker(mountSel, { onConfirm, confirmLabel, max = 5 }) {
  pkSel = new Set(); pkOnConfirm = onConfirm; pkMax = max;
  $(mountSel).innerHTML = `
    <div class="pk-search"><input id="pkSearch" placeholder="Search a US stock — ticker or name…" autocomplete="off"></div>
    <div id="pkGrid" class="pk-grid"><div class="loading">Loading stocks…</div></div>
    <div class="pk-bar"><span id="pkCount" class="pk-count">0/${max} selected</span>
      <button class="btn-cta" id="pkNext" disabled onclick="pkConfirm()">${esc(confirmLabel)}</button></div>`;
  $('#pkSearch').addEventListener('input', () => {
    clearTimeout(pkTimer); const q = $('#pkSearch').value.trim();
    pkTimer = setTimeout(() => pkLoad(q), 220);
  });
  $('#pkGrid').addEventListener('click', e => {
    const card = e.target.closest('.pk-card'); if (!card) return;
    const t = card.dataset.t;
    if (pkSel.has(t)) pkSel.delete(t);
    else { if (pkSel.size >= pkMax) { toast(`Max ${pkMax} picks`, 'warn'); return; } pkSel.add(t); }
    card.classList.toggle('sel', pkSel.has(t));
    pkSyncBar();
  });
  pkLoad('');
}
async function pkLoad(q) {
  let d; try { d = await api('/api/pick-stocks' + (q ? '?q=' + encodeURIComponent(q) : '')); }
  catch { $('#pkGrid').innerHTML = empty('Could not load stocks.'); return; }
  if (!d.stocks.length) { $('#pkGrid').innerHTML = empty('No US stocks match that search.'); return; }
  $('#pkGrid').innerHTML = d.stocks.map(s => `
    <div class="pk-card ${pkSel.has(s.ticker) ? 'sel' : ''}" data-t="${esc(s.ticker)}">
      <div class="pk-check">✓</div>
      <div class="pk-top">${logoChip(s.ticker)}
        <div class="pk-id"><div class="pk-tk">${esc(s.ticker)}</div><div class="pk-nm">${esc(titleCase(s.name).slice(0, 20))}</div></div>
        <div class="pk-px ${cls(s.change_pct)}">${s.price ? '$' + fmt.num(s.price) : '—'}<span>${s.change_pct != null ? fmt.pct(s.change_pct) : ''}</span></div>
      </div>
      <div class="pk-sig">${s.signal ? esc(s.signal) : '<span class="pk-nosig">No standout smart-money signal</span>'}</div>
    </div>`).join('');
}
function pkSyncBar() {
  const c = $('#pkCount'); if (!c) return;
  c.textContent = `${pkSel.size}/${pkMax} selected`;
  c.classList.toggle('full', pkSel.size >= 3);
  $('#pkNext').disabled = pkSel.size < 3;
}
window.pkConfirm = () => { if (pkSel.size >= 3 && pkOnConfirm) pkOnConfirm([...pkSel]); };

// ── Screen 1: Create Battle Room ────────────────────────────────────────────
let roomCfg = { duration: 7, capital: 100000, market: 'us', maxPlayers: 2, maxPicks: 5 };
function seg(key, opts) {
  return `<div class="seg" data-key="${key}">` + opts.map(([v, label]) =>
    `<button class="seg-pill ${roomCfg[key] === v ? 'on' : ''}" data-v="${v}">${label}</button>`).join('') + `</div>`;
}
function renderBattleCreate() {
  battlesChrome(false);
  $('#battlesBody').innerHTML = `
    <button class="back-btn" onclick="go('battles')">← Battles</button>
    <div class="glass-card room-create">
      <h2 class="room-h">Create Battle Room</h2>
      <div class="room-field"><label>Battle Duration</label>${seg('duration', [[1, '1 Day'], [3, '3 Days'], [7, '7 Days']])}</div>
      <div class="room-field"><label>Starting Capital</label>${seg('capital', [[10000, '$10,000'], [50000, '$50,000'], [100000, '$100,000']])}
        <div class="room-cap">Paper money — no real money involved.</div></div>
      <div class="room-field"><label>Market</label>${seg('market', [['us', 'US Stocks'], ['crypto', 'Crypto'], ['both', 'Both']])}</div>
      <div class="room-field"><label>Players</label>${seg('maxPlayers', [[2, '1v1'], [5, 'Up to 5 Friends']])}</div>
      <div class="room-field"><label>Max stock picks per player</label>
        <div class="stepper"><button class="stp" data-d="-1">−</button><span id="mpVal">${roomCfg.maxPicks}</span><button class="stp" data-d="1">+</button></div>
      </div>
      <button class="btn-shimmer" id="createRoomBtn">Create Battle Room</button>
      <div class="room-note">Both players lock in their picks in the room, then the host starts the clock. Paper portfolio — bragging rights only.</div>
    </div>`;
  $('#battlesBody').querySelectorAll('.seg').forEach(seg => seg.addEventListener('click', e => {
    const b = e.target.closest('.seg-pill'); if (!b) return;
    const key = seg.dataset.key, v = seg.dataset.key === 'market' ? b.dataset.v : Number(b.dataset.v);
    roomCfg[key] = v;
    seg.querySelectorAll('.seg-pill').forEach(p => p.classList.toggle('on', p === b));
  }));
  $('.stepper').addEventListener('click', e => {
    const b = e.target.closest('.stp'); if (!b) return;
    roomCfg.maxPicks = Math.min(10, Math.max(3, roomCfg.maxPicks + Number(b.dataset.d)));
    $('#mpVal').textContent = roomCfg.maxPicks;
  });
  $('#createRoomBtn').addEventListener('click', async () => {
    const btn = $('#createRoomBtn'); btn.disabled = true; btn.textContent = 'Creating…';
    if (!myName()) setMyName('You');
    let res; try { res = await battleRoom.create(roomCfg); }
    catch (err) { toast(err.message, 'err'); btn.disabled = false; btn.textContent = 'Create Battle Room'; return; }
    addMyBattle(res.code, 'a');
    go('battle/room/' + res.code);
  });
}
window.renderBattleCreate = renderBattleCreate;

// ── Screen 2: Waiting Room ──────────────────────────────────────────────────
let wrCode = null, wrDemoFired = false;
async function loadWaitingRoom(code) {
  battlesChrome(false);
  wrCode = code;
  const body = $('#battlesBody');
  body.innerHTML = `<div class="loading">Loading room ${esc(code)}…</div>`;
  let room; try { room = await battleRoom.get(code); } catch { body.innerHTML = roomErrorScreen('Room not found'); return; }
  if (room.status === 'expired') { body.innerHTML = roomErrorScreen('This battle expired'); return; }
  // if I opened a room I'm not in yet (shared room link) send me through join
  if (!myRoleIn(code) && room.status === 'waiting') { go('battle/join/' + code); return; }
  renderWaitingRoom(room);
  battleRoom.watch(code, r => {
    if (!location.hash.includes('battle/room/' + code)) { battleRoom.unwatch(); return; }
    if (r.status === 'live') { battleRoom.unwatch(); runCountdown(code); return; }
    if (r.status === 'expired') { battleRoom.unwatch(); body.innerHTML = roomErrorScreen('This battle expired'); return; }
    renderWaitingRoom(r);
  });
  // demoMode: bring in a real auto-playing opponent for the host, once
  if (myRoleIn(code) === 'a' && room.players.length < 2 && battleRoom.demoMode && !wrDemoFired) { wrDemoFired = true; demoOpponent(code); }
}

function playerSlot(room, role) {
  const p = room.players.find(x => x.role === role);
  const isMe = myRoleIn(room.code) === role;
  if (!p) return `<div class="pslot empty"><div class="pslot-av"><span>+</span></div><div class="pslot-name">Waiting…</div></div>`;
  const status = p.ready ? 'Ready ✓' : 'Picking…';
  return `<div class="pslot ${p.ready ? 'ready' : ''} filled">
    ${p.trash ? `<div class="trash-bubble">${esc(p.trash)}</div>` : ''}
    <div class="pslot-av">${avatar(null, p.name, 66)}</div>
    <div class="pslot-name">${esc(p.name)}${isMe ? ' <span class="you-tag">YOU</span>' : ''}</div>
    <div class="pslot-chip ${p.ready ? 'ok' : 'wait'}">${status}</div>
  </div>`;
}

function renderWaitingRoom(room) {
  const body = $('#battlesBody');
  const role = myRoleIn(room.code);
  const isHost = role === 'a';
  const me = room.players.find(p => p.role === role);
  const opp = room.players.find(p => p.role !== role);
  const slots = room.settings.maxPlayers === 2
    ? `${playerSlot(room, 'a')}<div class="vs-badge"><span>VS</span></div>${playerSlot(room, 'b')}`
    : ['a', 'b'].map(r => playerSlot(room, r)).join('');
  const allReady = room.players.length >= 2 && room.players.every(p => p.ready);
  const myReady = me?.ready;
  let cta = '';
  if (!myReady) cta = `<button class="btn-cta glow" onclick="openRoomPicker('${esc(room.code)}')">Pick My Stocks (${room.settings.maxPicks})</button>`;
  else if (isHost) cta = `<button class="btn-cta ${allReady ? 'glow' : ''}" ${allReady ? '' : 'disabled'} onclick="startBattle('${esc(room.code)}')">${allReady ? 'Start Battle ⚔️' : 'Waiting for opponent…'}</button>`;
  else cta = `<div class="ready-wait">✓ You're ready — waiting for the host to start…</div>`;

  body.innerHTML = `
    <button class="back-btn" onclick="go('battles')">← Battles</button>
    <div class="glass-card code-card">
      <div class="code-label">ROOM CODE</div>
      <div class="room-code" onclick="copyRoomCode('${esc(room.code)}')" title="Tap to copy">${esc(room.code)}</div>
      <div class="code-sub">Share this code with your friend</div>
    </div>
    <div class="share-row">
      <a class="wa-btn" href="${waInvite(room.code, room.settings.duration)}" target="_blank" rel="noopener">Share on WhatsApp</a>
      <button class="glass-btn" onclick="copyRoomLink('${esc(room.code)}', this)">Copy Link</button>
    </div>
    <div class="players-stage ${room.settings.maxPlayers === 2 ? 'duel' : 'group'}">${slots}</div>
    ${me ? `<div class="glass-card trash-card">
      <input id="trashInput" maxlength="80" placeholder="Drop your challenge line... 🔥" value="${esc(me.trash || '')}">
      <button class="glass-btn sm" onclick="sendTrash('${esc(room.code)}')">Say it</button>
    </div>` : ''}
    <div class="room-cta">${cta}</div>
    <div class="room-note">${room.settings.duration}-day battle · ${usd0(room.settings.capital)} paper capital · ${room.settings.maxPicks} picks each · real market prices. No real money.</div>`;
}

window.copyRoomCode = code => { navigator.clipboard?.writeText(code).then(() => toast('Code copied!', 'ok')).catch(() => {}); };
window.copyRoomLink = (code, btn) => { navigator.clipboard?.writeText(roomLink(code)).then(() => { toast('Link copied!', 'ok'); if (btn) { const t = btn.textContent; btn.textContent = 'Copied!'; setTimeout(() => btn.textContent = t, 1400); } }).catch(() => {}); };
window.sendTrash = async code => { const v = $('#trashInput')?.value.trim(); if (!v) return; try { await battleRoom.trash(code, myRoleIn(code), v); toast('Challenge sent 🔥', 'ok'); } catch (e) { toast(e.message, 'err'); } };
window.startBattle = async code => { try { await battleRoom.start(code); } catch (e) { toast(e.message, 'err'); return; } battleRoom.unwatch(); runCountdown(code); };

window.openRoomPicker = code => {
  battleRoom.unwatch();
  battlesChrome(false);
  battleRoom.get(code).then(room => {
    $('#battlesBody').innerHTML = `
      <button class="back-btn" onclick="go('battle/room/${esc(code)}')">← Back to room</button>
      <h2 class="section" style="margin-top:6px">Pick your stocks <span class="sub">choose 3–${room.settings.maxPicks} · locks you in as Ready</span></h2>
      <div id="pickerMount"></div>`;
    renderPicker('#pickerMount', { max: room.settings.maxPicks, confirmLabel: 'Lock In & Ready Up ⚔️', onConfirm: async picks => {
      try { await battleRoom.pick(code, myRoleIn(code), picks); } catch (e) { toast(e.message, 'err'); return; }
      toast("You're ready ✓", 'ok');
      go('battle/room/' + code);
    } });
  });
};

// ── Screen 3: Join (OTP) + deep link + edge screens ─────────────────────────
function roomErrorScreen(msg) {
  return `<div class="bt-empty"><div class="bt-empty-ic">${/full/i.test(msg) ? '🚪' : /expired/i.test(msg) ? '⌛' : '⚔️'}</div>
    <div class="bt-empty-t">${esc(msg)}</div>
    <button class="btn-cta" onclick="go('battle/create')">Create New Battle</button></div>`;
}

function renderJoinEntry() {
  battlesChrome(false);
  $('#battlesBody').innerHTML = `
    <button class="back-btn" onclick="go('battles')">← Battles</button>
    <div class="glass-card join-card">
      <h2 class="room-h">Join a Battle</h2>
      <div class="join-sub">Enter your friend's room code</div>
      <div class="otp-row" id="otpRow"><span class="otp-prefix">GM-</span>
        ${Array.from({ length: 6 }).map((_, i) => `<input class="otp-box" data-i="${i}" maxlength="1" inputmode="latin" autocomplete="off">`).join('')}
      </div>
      <div class="join-err" id="joinErr"></div>
    </div>`;
  const boxes = [...document.querySelectorAll('.otp-box')];
  const clean = c => /[23456789ABCDEFGHJKMNPQRSTUVWXYZ]/.test(c) ? c : '';
  boxes[0].focus();
  boxes.forEach((box, i) => {
    box.addEventListener('input', () => {
      box.value = clean(box.value.toUpperCase());
      if (box.value && i < 5) boxes[i + 1].focus();
      if (boxes.every(b => b.value)) submitOtp(boxes.map(b => b.value).join(''));
    });
    box.addEventListener('keydown', e => { if (e.key === 'Backspace' && !box.value && i > 0) boxes[i - 1].focus(); });
  });
}
async function submitOtp(chars) {
  const code = 'GM-' + chars;
  let room; try { room = await battleRoom.get(code); } catch { room = null; }
  if (!room || room.status === 'expired') {
    const row = $('#otpRow'); row.classList.add('shake'); $('#joinErr').textContent = room ? 'This battle expired' : 'Room not found';
    setTimeout(() => row.classList.remove('shake'), 500);
    document.querySelectorAll('.otp-box').forEach(b => { b.value = ''; b.classList.add('bad'); });
    setTimeout(() => document.querySelectorAll('.otp-box').forEach(b => b.classList.remove('bad')), 700);
    document.querySelector('.otp-box')?.focus();
    toast('Room not found', 'err');
    return;
  }
  go('battle/join/' + code);
}

async function loadBattleJoin(code) {
  battlesChrome(false);
  const body = $('#battlesBody');
  body.innerHTML = `<div class="loading">Loading room ${esc(code)}…</div>`;
  let room; try { room = await battleRoom.get(code); } catch { body.innerHTML = roomErrorScreen('Room not found'); return; }
  if (room.status === 'expired') { body.innerHTML = roomErrorScreen('This battle expired'); return; }
  if (myRoleIn(code)) { go('battle/room/' + code); return; } // already a player
  if (room.status !== 'waiting') { body.innerHTML = roomErrorScreen('This battle has already started'); return; }
  if (room.players.length >= 2 && room.settings.maxPlayers === 2) { body.innerHTML = roomErrorScreen('Room is full'); return; }
  const host = room.players.find(p => p.role === 'a');
  const needName = !myName();
  body.innerHTML = `
    <button class="back-btn" onclick="go('battles')">← Battles</button>
    <div class="glass-card challenge-card">
      <div class="ch-badge">${avatar(null, host?.name || '?', 52)}<div><div class="ch-name">${esc(host?.name || 'A host')}</div><div class="ch-sub">has challenged you ⚔️</div></div></div>
      <p class="ch-p">Join the room and pick your ${room.settings.maxPicks} stocks. ${room.settings.duration}-day paper battle on real prices — no real money.</p>
      ${needName ? `<div class="join-name"><input id="joinName" maxlength="24" placeholder="Your name"><div class="room-cap">Quick sign-up — just a name so ${esc(host?.name || 'the host')} knows who joined.</div></div>` : ''}
      <button class="btn-cta glow" id="joinRoomBtn">Join Battle Room</button>
    </div>`;
  $('#joinRoomBtn').addEventListener('click', async () => {
    const name = myName() || ($('#joinName')?.value.trim() ?? '');
    if (!name) { const el = $('#joinName'); if (el) { el.focus(); el.classList.add('bad'); } toast('Enter your name', 'warn'); return; }
    setMyName(name);
    try { await battleRoom.join(code, name); } catch (e) { body.innerHTML = roomErrorScreen(e.message); return; }
    addMyBattle(code, 'b');
    toast('Joined the battle ⚔️', 'ok');
    go('battle/room/' + code);
  });
}

// ── Screen 4: Start Countdown ───────────────────────────────────────────────
function runCountdown(code) {
  let ov = $('#countdownOv');
  if (!ov) { ov = document.createElement('div'); ov.id = 'countdownOv'; document.body.appendChild(ov); }
  ov.className = 'countdown-ov show';
  const seq = ['3', '2', '1', 'BATTLE BEGINS ⚔️'];
  let i = 0;
  const step = () => {
    if (i >= seq.length) { ov.className = 'countdown-ov'; ov.innerHTML = ''; go('battle/' + code); return; }
    const last = i === seq.length - 1;
    ov.innerHTML = `<div class="cd-num ${last ? 'cd-final' : ''}">${seq[i]}</div>`;
    ov.classList.toggle('shake', !last);
    i++;
    setTimeout(step, last ? 1100 : 850);
  };
  step();
}

// ── Battles home (list my rooms) ────────────────────────────────────────────
async function loadBattles() {
  battlesChrome(true);
  updateBattleBadge();
  const body = $('#battlesBody');
  const mine = getMyBattles();
  if (!mine.length) {
    body.innerHTML = `<div class="bt-empty"><div class="bt-empty-ic">⚔️</div>
      <div class="bt-empty-t">No battles yet. Create a room and challenge a friend.</div>
      <button class="btn-cta" onclick="go('battle/create')">New Battle +</button></div>`;
    return;
  }
  body.innerHTML = `<div class="loading">Loading your battles…</div>`;
  const rows = [];
  for (const m of mine) {
    try {
      const room = await battleRoom.get(m.id);
      const s = (room.status === 'live' || room.status === 'finished') ? await api(`/api/battles/${m.id}/scores`).catch(() => null) : null;
      markMyBattle(m.id, { status: room.status });
      rows.push({ role: m.role, room, s });
    } catch { /* removed */ }
  }
  const waiting = rows.filter(r => r.room.status === 'waiting');
  const live = rows.filter(r => r.room.status === 'live');
  const done = rows.filter(r => r.room.status === 'finished');
  const roomCardV = r => {
    const opp = r.room.players.find(p => p.role !== r.role);
    return `<div class="card bt-card clickable" onclick="go('battle/room/${esc(r.room.code)}')">
      <div class="bt-head"><div class="bt-opp">${avatar(null, opp?.name || '?', 40)}
        <span><b>${opp ? 'vs ' + esc(opp.name) : 'Waiting for opponent'}</b><i>Room ${esc(r.room.code)} · ${r.room.settings.duration}-day</i></span></div>
        <span class="bt-day">${r.room.players.every(p => p.ready) && r.room.players.length >= 2 ? 'Ready' : 'Lobby'}</span></div>
      <div class="bt-actions"><span class="bt-live">● waiting room</span><span class="bt-view">Open →</span></div></div>`;
  };
  const liveCardV = r => {
    const me = r.s?.players[r.role], opp = r.s?.players[r.role === 'a' ? 'b' : 'a'];
    const iLead = (me?.pct ?? -1e9) >= (opp?.pct ?? -1e9);
    return `<div class="card bt-card clickable" onclick="go('battle/${esc(r.room.code)}')">
      <div class="bt-head"><div class="bt-opp">${avatar(null, opp?.name || '?', 40)}
        <span><b>vs ${esc(opp?.name || 'Opponent')}</b><i>${countdown(r.s?.endAt)}</i></span></div>
        <span class="bt-day">${iLead ? '👑 Leading' : 'Behind'}</span></div>
      <div class="bt-scores"><div class="bt-side ${iLead ? 'lead' : ''}"><span class="bt-lbl">You</span><span class="bt-pct ${cls(me?.pct)}">${pctTxt(me?.pct ?? null)}</span></div>
        <div class="bt-bar ${iLead ? '' : 'rev'}"><i style="width:${Math.min(88, Math.max(14, 14 + Math.abs((me?.pct ?? 0) - (opp?.pct ?? 0)) * 6))}%"></i></div>
        <div class="bt-side r ${!iLead ? 'lead' : ''}"><span class="bt-lbl">${esc(opp?.name || 'Them')}</span><span class="bt-pct ${cls(opp?.pct)}">${pctTxt(opp?.pct ?? null)}</span></div></div>
      <div class="bt-actions"><span class="bt-live">● live · real prices</span><span class="bt-view">View →</span></div></div>`;
  };
  const doneRowV = r => {
    const won = r.s?.winner === r.role, draw = r.s?.winner === 'draw';
    const me = r.s?.players[r.role], opp = r.s?.players[r.role === 'a' ? 'b' : 'a'];
    return `<div class="bt-hrow clickable" onclick="go('battle/${esc(r.room.code)}')">
      <span class="bt-hopp">${avatar(null, opp?.name || '—', 26)}<b>vs ${esc(opp?.name || 'Opponent')}</b></span>
      <span class="pill sm ${draw ? 'gray' : won ? 'up' : 'down'}">${draw ? 'DRAW' : won ? 'WON' : 'LOST'}</span>
      <span class="bt-hscore">${pctTxt(me?.pct ?? null)} <i>vs</i> ${pctTxt(opp?.pct ?? null)}</span>
      <span class="bt-hdate">${esc(r.room.code)}</span></div>`;
  };
  body.innerHTML =
    (waiting.length ? `<h2 class="section">Lobbies <span class="sub">rooms waiting to start</span></h2><div class="bt-row">${waiting.map(roomCardV).join('')}</div>` : '') +
    (live.length ? `<h2 class="section">Active Battles <span class="sub">live scores from real market prices</span></h2><div class="bt-row">${live.map(liveCardV).join('')}</div>` : '') +
    (done.length ? `<h2 class="section">History</h2><div class="card tight">${done.map(doneRowV).join('')}</div>` : '') ||
    `<div class="bt-empty"><div class="bt-empty-ic">⚔️</div><div class="bt-empty-t">Loading…</div></div>`;
}

// ── Live battle page ────────────────────────────────────────────────────────
let liveTimer = null;
async function loadBattleLive(id) {
  battlesChrome(false);
  clearInterval(liveTimer);
  const body = $('#battlesBody');
  body.innerHTML = `<div class="loading">Loading battle…</div>`;
  const role = getMyBattles().find(x => x.id === id)?.role ?? 'a';
  const render = async () => {
    let s; try { s = await api(`/api/battles/${id}/scores`); } catch { body.innerHTML = empty('Battle not found.'); return false; }
    markMyBattle(id, { status: s.status });
    body.innerHTML = battleLiveHTML(id, s, role);
    if (s.status === 'finished') { mountVictory(id, s, role); return false; }
    return true;
  };
  const keepGoing = await render();
  if (keepGoing) liveTimer = setInterval(async () => {
    if (!location.hash.includes(`battle/${id}`)) { clearInterval(liveTimer); return; }
    const cont = await render(); if (!cont) clearInterval(liveTimer);
  }, 60000);
}

function battleLiveHTML(id, s, role) {
  const opp = role === 'a' ? 'b' : 'a';
  const me = s.players[role], them = s.players[opp];
  const meLeads = (me.pct ?? -1e9) >= (them.pct ?? -1e9);
  const ended = s.status === 'finished';
  const col = (side, isMe, lead) => `
    <div class="vs-p ${isMe ? 'me' : ''}">
      <div class="vs-crown">${lead && !(me.pct == null && them.pct == null) ? '👑' : ''}</div>
      ${avatar(null, side.name || (isMe ? 'You' : 'Opponent'), 58)}
      <div class="vs-name">${esc(side.name || (isMe ? 'You' : 'Opponent'))}${isMe ? ' <span class="vs-you">YOU</span>' : ''}</div>
      <div class="vs-pct ${cls(side.pct)}">${pctTxt(side.pct)}</div>
    </div>`;
  const picksList = side => side.picks.map(p => `
    <div class="vs-pick"><span class="vs-arrow ${cls(p.pct)}">${p.pct == null ? '·' : p.pct >= 0 ? '▲' : '▼'}</span>
      ${tk(p.ticker)}<span class="vs-pick-nm">${esc(titleCase(p.name).slice(0, 18))}</span>
      <span class="vs-pick-pct ${cls(p.pct)}">${pctTxt(p.pct)}</span></div>`).join('');
  return `
    <button class="back-btn" onclick="go('battles')">← Battles</button>
    <div class="card vs-card">
      <div class="vs-top">
        ${col(me, true, meLeads)}
        <div class="vs-mid"><div class="vs-vs">VS</div>${ended ? '<div class="vs-final">FINAL</div>' : `<div class="vs-count">${countdown(s.endAt)}</div>`}</div>
        ${col(them, false, !meLeads)}
      </div>
      ${battleChart(s.curve, role)}
    </div>
    <div id="victoryMount"></div>
    <div class="grid cols-2 vs-cols">
      <div class="card tight"><h3 class="block-title">${esc(me.name || 'You')} · your picks</h3>${picksList(me)}</div>
      <div class="card tight"><h3 class="block-title">${esc(them.name || 'Opponent')} · their picks</h3>${picksList(them)}</div>
    </div>
    <div class="own-note" style="margin-top:12px">Equal-weighted paper portfolios · scored on real closing prices since the battle started · not investment advice.</div>`;
}

function battleChart(curve, meRole) {
  if (!curve || curve.length < 2) return `<div class="vs-chart-empty">📈 The 7-day chart fills in as daily closes arrive — both sides start dead even at 0%.</div>`;
  const w = 680, h = 190, padX = 12, padTop = 16, padBot = 22;
  const vals = curve.flatMap(p => [p.a, p.b]).filter(x => x != null).concat(0);
  const min = Math.min(...vals), max = Math.max(...vals);
  const x = i => padX + (i / (curve.length - 1)) * (w - padX * 2);
  const y = v => padTop + (1 - (v - min) / ((max - min) || 1)) * (h - padTop - padBot);
  const line = (key, color) => { const pts = curve.map((p, i) => p[key] != null ? `${x(i).toFixed(1)},${y(p[key]).toFixed(1)}` : null).filter(Boolean).join(' '); return pts ? `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>` : ''; };
  const opp = meRole === 'a' ? 'b' : 'a', zy = y(0);
  return `<svg class="vs-chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <line x1="${padX}" y1="${zy.toFixed(1)}" x2="${w - padX}" y2="${zy.toFixed(1)}" stroke="rgba(150,158,180,.2)" stroke-dasharray="3 4"/>
    ${line(opp, '#7da7e0')}${line(meRole, '#c9a75a')}
    <text x="${padX}" y="${h - 6}" font-family="IBM Plex Mono" font-size="9" fill="#6b7288">${esc(curve[0].date)}</text>
    <text x="${w - padX}" y="${h - 6}" font-family="IBM Plex Mono" font-size="9" fill="#6b7288" text-anchor="end">${esc(curve.at(-1).date)}</text>
  </svg>
  <div class="vs-legend"><span><i style="background:#c9a75a"></i> You</span><span><i style="background:#7da7e0"></i> Opponent</span></div>`;
}

// ── Victory card (canvas) + share + rematch ─────────────────────────────────
function mountVictory(id, s, role) {
  const mount = $('#victoryMount'); if (!mount) return;
  const url = victoryDataURL(s);
  const iWon = s.winner === role, draw = s.winner === 'draw';
  const title = draw ? "It's a draw!" : iWon ? 'You won! 🎉' : 'You lost this one';
  window._vcCache = window._vcCache || {}; window._vcCache[id] = url;
  mount.innerHTML = `<div class="card vc-wrap">
    <h3 class="vc-title ${iWon ? 'up' : draw ? '' : 'down'}">${esc(title)}</h3>
    <img class="vc-img" src="${url}" alt="Battle result card">
    <div class="vc-btns">
      <button class="btn-cta" onclick="shareVictory('${esc(id)}')">Share</button>
      <button class="watch-btn" onclick="go('battles/new')">Rematch ⚔️</button>
    </div></div>`;
}

const fmtPctPlain = v => (v == null ? '—' : (v > 0 ? '+' : '') + Number(v).toFixed(2) + '%');
function rr(c, x, y, w, h, r) { c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }
function victoryDataURL(s) {
  const cv = document.createElement('canvas'); cv.width = 1200; cv.height = 630; const c = cv.getContext('2d');
  c.fillStyle = '#0a0b0f'; c.fillRect(0, 0, 1200, 630);
  c.fillStyle = 'rgba(201,167,90,0.06)'; c.fillRect(0, 0, 1200, 130);
  c.strokeStyle = 'rgba(201,167,90,0.55)'; c.lineWidth = 3; c.strokeRect(22, 22, 1156, 586);
  c.fillStyle = '#f2f3f6'; rr(c, 58, 52, 52, 52, 12); c.fill();
  c.fillStyle = '#0a0b0f'; c.font = '700 32px Georgia'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('G', 84, 79);
  c.fillStyle = '#f2f3f6'; c.font = '700 26px Arial'; c.textAlign = 'left'; c.textBaseline = 'alphabetic'; c.fillText('Giant Money', 126, 88);
  c.fillStyle = '#c9a75a'; c.font = '700 20px "Courier New"'; c.textAlign = 'right'; c.fillText('⚔ STOCK BATTLE', 1140, 86);
  const a = s.players.a, b = s.players.b, win = s.winner;
  c.textAlign = 'center';
  if (win === 'draw') {
    c.fillStyle = '#c9a75a'; c.font = '700 92px Georgia'; c.fillText('DRAW', 600, 320);
    c.fillStyle = '#c3c8d6'; c.font = '700 40px "Courier New"'; c.fillText(`${fmtPctPlain(a.pct)}  vs  ${fmtPctPlain(b.pct)}`, 600, 410);
  } else {
    const wn = win === 'a' ? a : b, ln = win === 'a' ? b : a;
    c.fillStyle = '#8b92a8'; c.font = '600 26px Arial'; c.fillText('WINNER', 600, 205);
    c.fillStyle = '#4fae86'; c.font = '700 84px Georgia'; c.fillText((wn.name || 'Winner').slice(0, 16), 600, 296);
    c.fillStyle = '#8b92a8'; c.font = '400 28px Arial'; c.fillText('defeated', 600, 348);
    c.fillStyle = '#e0566a'; c.font = '700 46px Georgia'; c.fillText((ln.name || 'Opponent').slice(0, 18), 600, 408);
    c.fillStyle = '#c3c8d6'; c.font = '700 42px "Courier New"'; c.fillText(`${fmtPctPlain(wn.pct)}   vs   ${fmtPctPlain(ln.pct)}`, 600, 486);
  }
  c.fillStyle = '#565d72'; c.font = '400 19px "Courier New"'; c.fillText(`Battle #${s.id} · 7-day paper contest · real market prices`, 600, 566);
  return cv.toDataURL('image/png');
}

window.shareVictory = async id => {
  const url = (window._vcCache || {})[id]; if (!url) return;
  const text = `I just settled my stock battle on Giant Money ⚔️ Room ${id} — ${roomLink(id)}`;
  try {
    const blob = await (await fetch(url)).blob();
    const file = new File([blob], `giant-money-battle-${id}.png`, { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], text }); return; }
  } catch { /* fall through to download + WhatsApp */ }
  const a = document.createElement('a'); a.href = url; a.download = `giant-money-battle-${id}.png`; a.click();
  window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank');
};

// ── notifications (real smart-money events, shown in the Alerts bell) ────────
const NOTIF_ICON = { 'Form 4': '📄', '13F': '📊', 'PTR': '🏛️' };
let notifItems = [];
let notifSeen = Number(localStorage.getItem('gm_notif_seen') || 0);

// personal alert stocks (user adds via the + in the bell)
const ALERTS_KEY = 'gm_alerts';
let alertTickers = safe(localStorage.getItem(ALERTS_KEY), []) || [];
let alertData = { quotes: [], events: [] };

function saveAlerts() { localStorage.setItem(ALERTS_KEY, JSON.stringify(alertTickers)); }

// ── Alert rules ────────────────────────────────────────────────────────────
// The user states a condition; every data refresh re-checks it against real
// quotes and real filings. Rules live on this device, like the watchlist.
const RULES_KEY = 'gm_alert_rules';
const FIRED_KEY = 'gm_alert_fired';
let alertRules = safe(localStorage.getItem(RULES_KEY), []) || [];
let firedIds = new Set(safe(localStorage.getItem(FIRED_KEY), []) || []);

const RULE_KINDS = {
  drop:       { label: 'falls more than', unit: '%', needsValue: true, group: 'price' },
  rise:       { label: 'rises more than', unit: '%', needsValue: true, group: 'price' },
  below:      { label: 'price goes below', unit: '$', needsValue: true, group: 'price' },
  above:      { label: 'price goes above', unit: '$', needsValue: true, group: 'price' },
  politician: { label: 'any politician trades it', needsValue: false, group: 'smart' },
  insider:    { label: 'an insider BUYS it', needsValue: false, group: 'smart' },
  fund:       { label: 'a big fund changes its position', needsValue: false, group: 'smart' },
};

const saveRules = () => localStorage.setItem(RULES_KEY, JSON.stringify(alertRules));
const saveFired = () => localStorage.setItem(FIRED_KEY, JSON.stringify([...firedIds].slice(-300)));

window.addAlertRule = () => {
  const sym = String($('#arSym')?.value || '').toUpperCase().trim();
  const kind = $('#arKind')?.value;
  const raw = $('#arVal')?.value;
  if (!/^[A-Z.\-]{1,8}$/.test(sym)) return toast('Enter a ticker like AAPL', 'err');
  const spec = RULE_KINDS[kind];
  const value = spec.needsValue ? Number(raw) : null;
  if (spec.needsValue && (!isFinite(value) || value <= 0)) return toast('Enter a number', 'err');

  alertRules.unshift({ id: 'r' + Date.now().toString(36), sym, kind, value, created: Date.now() });
  alertRules = alertRules.slice(0, 40);
  saveRules();
  // watch the symbol too, so its quote is fetched on every refresh
  if (!alertTickers.includes(sym)) { alertTickers.unshift(sym); alertTickers = alertTickers.slice(0, 25); saveAlerts(); }
  $('#arVal').value = '';
  renderRules();
  refreshAlertData().then(() => { renderRules(); renderNotifs(); });
  toast('Alert added');
};

window.removeAlertRule = id => {
  alertRules = alertRules.filter(r => r.id !== id);
  saveRules(); renderRules(); renderNotifs();
};

// Evaluate every rule against the latest quotes and filings.
// Returns [{rule, hit, detail}] — `hit` means the condition is true right now.
function evaluateRules() {
  const quoteOf = s => alertData.quotes.find(q => q.symbol === s);
  const recent = (kind, sym, sideRe) => alertData.events.find(e =>
    e.kind === kind && String(e.ticker).toUpperCase() === sym &&
    (!sideRe || sideRe.test(String(e.side || ''))));

  return alertRules.map(r => {
    const q = quoteOf(r.sym);
    let hit = false, detail = '';
    switch (r.kind) {
      case 'drop':
        hit = q?.change_pct != null && q.change_pct <= -r.value;
        detail = q?.change_pct == null ? 'no quote yet' : `now ${fmt.pct(q.change_pct)}`;
        break;
      case 'rise':
        hit = q?.change_pct != null && q.change_pct >= r.value;
        detail = q?.change_pct == null ? 'no quote yet' : `now ${fmt.pct(q.change_pct)}`;
        break;
      case 'below':
        hit = q?.price != null && q.price <= r.value;
        detail = q?.price == null ? 'no quote yet' : `now $${fmt.num(q.price)}`;
        break;
      case 'above':
        hit = q?.price != null && q.price >= r.value;
        detail = q?.price == null ? 'no quote yet' : `now $${fmt.num(q.price)}`;
        break;
      case 'politician': {
        const e = recent('PTR', r.sym);
        hit = !!e; detail = e ? `${e.who} ${String(e.side).toLowerCase()} · ${e.date}` : 'nothing disclosed yet';
        break;
      }
      case 'insider': {
        const e = recent('Form 4', r.sym, /^buy$/i);
        hit = !!e; detail = e ? `${e.who} bought · ${e.date}` : 'no insider buys yet';
        break;
      }
      case 'fund': {
        const e = recent('13F', r.sym);
        hit = !!e; detail = e ? `${e.who} ${e.side} · ${e.date}` : 'no 13F change yet';
        break;
      }
    }
    return { rule: r, hit, detail };
  });
}

function ruleText(r) {
  const s = RULE_KINDS[r.kind];
  return s.needsValue
    ? `${r.sym} ${s.label} ${s.unit === '$' ? '$' + r.value : r.value + '%'}`
    : `${r.sym} — ${s.label}`;
}

function renderRules() {
  const el = $('#wlRules');
  if (!el) return;
  const results = evaluateRules();

  // a freshly-true rule becomes a notification once
  let changed = false;
  for (const { rule, hit } of results) {
    const key = rule.id + (hit ? ':on' : '');
    if (hit && !firedIds.has(key)) { firedIds.add(key); changed = true; }
  }
  if (changed) saveFired();

  const opts = Object.entries(RULE_KINDS)
    .map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('');

  el.innerHTML = `
    <p class="ar-intro">Get a 🔔 when something happens to a stock you care about.
      <b>Type a ticker, then tap one button.</b></p>

    <div class="ar-step">
      <span class="ar-num-badge">1</span>
      <input id="arSym" placeholder="Which stock?  e.g. AAPL" maxlength="8" class="ar-in ar-sym">
    </div>

    <div class="ar-step ar-step-2">
      <span class="ar-num-badge">2</span>
      <div class="ar-presets">
        <button class="ar-preset" data-preset="drop:5">
          <b>📉 It drops 5%</b><i>price falls today</i></button>
        <button class="ar-preset" data-preset="rise:5">
          <b>📈 It jumps 5%</b><i>price rises today</i></button>
        <button class="ar-preset gold" data-preset="politician:">
          <b>🏛 A politician trades it</b><i>Congress disclosure</i></button>
        <button class="ar-preset gold" data-preset="insider:">
          <b>💼 The CEO buys it</b><i>company insider buys</i></button>
      </div>
    </div>

    <details class="ar-adv">
      <summary>Want something else? Build your own</summary>
      <div class="ar-form">
        <span class="ar-lead">Tell me when</span>
        <select id="arKind" class="aif-sel">${opts}</select>
        <input id="arVal" placeholder="5" class="ar-in ar-num" inputmode="decimal">
        <button class="btn-primary ar-add" onclick="addAlertRule()">Add alert</button>
      </div>
    </details>

    ${results.length ? `
      <div class="ar-list-head">My alerts (${results.length})</div>
      <div class="ar-list">${results.map(({ rule, hit, detail }) => `
        <div class="ar-row ${hit ? 'on' : ''}">
          <span class="ar-state">${hit ? '🔔' : '👀'}</span>
          <span class="ar-text">${esc(ruleText(rule))}</span>
          <span class="ar-detail">${esc(detail)}</span>
          <span class="ar-status ${hit ? 'on' : ''}">${hit ? 'This happened!' : 'Watching…'}</span>
          <button class="ar-x" onclick="removeAlertRule('${rule.id}')" title="Delete">×</button>
        </div>`).join('')}</div>`
      : `<div class="ar-empty">No alerts yet — type a ticker above and tap a button.</div>`}`;

  const kindSel = $('#arKind');
  const val = $('#arVal');
  const syncVal = () => { if (val) val.style.display = RULE_KINDS[kindSel.value]?.needsValue ? '' : 'none'; };
  kindSel?.addEventListener('change', syncVal);
  syncVal();
}

// one-tap presets: fill the hidden advanced form, then submit it
document.addEventListener('click', e => {
  const btn = e.target.closest('.ar-preset');
  if (!btn) return;
  const [kind, value] = btn.dataset.preset.split(':');
  const sym = $('#arSym');
  if (!sym?.value.trim()) { sym?.focus(); return toast('Type a ticker first (like AAPL)', 'err'); }
  $('#arKind').value = kind;
  $('#arVal').value = value || '';
  addAlertRule();
});

async function refreshAlertData() {
  if (!alertTickers.length) { alertData = { quotes: [], events: [] }; return; }
  try { alertData = await api('/api/watch?symbols=' + alertTickers.join(',')); }
  catch { /* keep previous */ }
}

window.addAlert = async sym => {
  sym = String(sym || '').toUpperCase().trim();
  if (!/^[A-Z.]{1,6}$/.test(sym)) return;
  if (!alertTickers.includes(sym)) alertTickers.unshift(sym);
  alertTickers = alertTickers.slice(0, 25);
  saveAlerts();
  renderNotifs();
  await refreshAlertData();
  renderNotifs();
};
window.removeAlert = sym => {
  alertTickers = alertTickers.filter(s => s !== sym);
  saveAlerts();
  renderNotifs();
  refreshAlertData().then(renderNotifs);
};

async function loadNotifs() {
  let d;
  try { d = await api('/api/landing'); } catch { return; }
  notifItems = (d.marquee ?? []).slice(0, 20);
  await refreshAlertData();
  renderNotifs();
}

function renderNotifs() {
  // unread = recent smart-money events touching a stock the user is alerting
  const watched = new Set(alertTickers);
  const followedPols = new Set(getFollowedPols().map(n => n.toLowerCase()));
  // a triggered rule is the loudest thing the bell can say, so it counts first
  const triggered = evaluateRules().filter(r => r.hit);
  const unseen = Math.max(0, notifItems.length - notifSeen) + triggered.length;
  document.querySelectorAll('.notif-dot').forEach(dot => {
    dot.textContent = unseen > 9 ? '9+' : String(unseen);
    dot.hidden = unseen === 0;
    dot.classList.toggle('urgent', triggered.length > 0);
  });

  const firedHTML = triggered.length ? `
    <div class="notif-fired">
      <div class="nf-head">🔔 ${triggered.length} alert${triggered.length > 1 ? 's' : ''} triggered</div>
      ${triggered.map(({ rule, detail }) => `
        <a class="nf-row" href="#stock/${esc(rule.sym)}">
          <b>${esc(ruleText(rule))}</b><span>${esc(detail)}</span>
        </a>`).join('')}
    </div>` : '';

  const quoteOf = s => alertData.quotes.find(q => q.symbol === s);
  const myStocks = alertTickers.length
    ? alertTickers.map(s => {
        const q = quoteOf(s);
        return `<div class="notif-stock">
          ${logoChip(s)}
          <a class="tk" href="#stock/${esc(s)}">${esc(s)}</a>
          <span class="ns-px">${q?.price ? '$' + fmt.num(q.price) : '—'}</span>
          <span class="ns-ch ${cls(q?.change_pct)}">${fmt.pct(q?.change_pct)}</span>
          <span class="ns-x" data-rm="${esc(s)}" title="Remove">×</span>
        </div>`;
      }).join('')
    : `<div class="empty" style="padding:6px 12px 12px">No stocks yet. Tap ＋ to get alerts on any stock.</div>`;

  const recent = notifItems.length ? notifItems.map(t => {
    const hot = (t.ticker && watched.has(String(t.ticker).toUpperCase()))
      || (t.who && followedPols.size && [...followedPols].some(n => String(t.who).toLowerCase().includes(n.split(' ').pop())));
    return `<div class="notif-item${hot ? ' hot' : ''}">
      <div class="ni-ic">${NOTIF_ICON[t.kind] ?? '•'}</div>
      <div class="ni-b">
        <div class="ni-t"><b>${esc(titleCase(t.who))}</b> ${esc(t.did)}</div>
        <div class="ni-m ${t.up ? 'up' : 'down'}">${esc(t.amt)} · ${esc(t.kind)}</div>
      </div>
    </div>`;
  }).join('') : `<div class="empty" style="padding:16px">No smart-money activity captured yet.</div>`;

  document.querySelectorAll('.notif-panel').forEach(p => {
    const boxOpen = p.querySelector('.notif-addbox') && !p.querySelector('.notif-addbox').hidden;
    p.innerHTML = `
      <div class="nh"><b>Alerts</b><span class="notif-add" role="button">＋ Add stock</span></div>
      <div class="notif-addbox"${boxOpen ? '' : ' hidden'}>
        <input class="notif-input" placeholder="Ticker (e.g. AAPL)" maxlength="6" autocomplete="off">
        <button class="notif-input-go" type="button">Add</button>
      </div>
      ${firedHTML}
      <div class="notif-sec-label">Your alert stocks</div>
      ${myStocks}
      <div class="notif-sec-label">Recent activity</div>
      ${recent}`;
  });
}

// toggle panels, add/remove alerts (delegated)
document.addEventListener('click', e => {
  const btn = e.target.closest('.notif-btn');
  if (btn) {
    const panel = btn.parentElement.querySelector('.notif-panel');
    const opening = panel.hidden;
    document.querySelectorAll('.notif-panel').forEach(p => { p.hidden = true; });
    if (opening) {
      panel.hidden = false;
      notifSeen = notifItems.length;
      localStorage.setItem('gm_notif_seen', String(notifSeen));
      renderNotifs();
    }
    return;
  }
  const add = e.target.closest('.notif-add');
  if (add) {
    const box = add.closest('.notif-panel').querySelector('.notif-addbox');
    box.hidden = !box.hidden;
    if (!box.hidden) box.querySelector('.notif-input').focus();
    return;
  }
  const go = e.target.closest('.notif-input-go');
  if (go) {
    const input = go.closest('.notif-addbox').querySelector('.notif-input');
    if (input.value.trim()) addAlert(input.value);
    return;
  }
  const rm = e.target.closest('.ns-x');
  if (rm) { removeAlert(rm.dataset.rm); return; }
  if (e.target.closest('.notif-panel')) return; // clicks inside stay open
  document.querySelectorAll('.notif-panel').forEach(p => { p.hidden = true; });
});
// Enter to add
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.classList?.contains('notif-input') && e.target.value.trim()) {
    addAlert(e.target.value);
  }
});

// ── status ─────────────────────────────────────────────────────────────────
async function loadStatus() {
  try {
    const s = await api('/api/status');
    $('#loopStatus').textContent = 'backend loop · ' +
      (s.jobs.map(j => `${j.job}:${j.status}`).join(' · ') || 'starting') +
      ` · ${fmt.int(s.counts.insiderTrades)} insider trades · ${fmt.int(s.counts.politicianTrades)} politician records · ${fmt.int(s.counts.fundHoldings)} fund positions · ${fmt.int(s.counts.summarized)} AI briefs`;
  } catch {
    $('#loopStatus').textContent = 'backend unreachable';
  }
}

// ── orchestration ──────────────────────────────────────────────────────────
const loaders = {
  dashboard: () => Promise.allSettled([loadOverview(), loadPicks(), loadDetective()]),
  top1: loadTop1,
  politicians: loadPolView,
  insiders: loadInsidersTab,
  stocks: () => state.index ? loadIndex(state.index) : state.stock ? loadStock(state.stock) : loadTrendingStocks(),
  news: loadNews,
  watchlist: loadWatchlist,
  portfolio: loadPortfolio,
  profile: loadProfile,
  pricing: () => null,
};
function loadTab(tab) { return loaders[tab]?.(); }

refreshSideProfile();
loadStatus();
loadNotifs();
route();
setInterval(() => {
  loadStatus();
  loadNotifs();
  if (state.tab !== 'pricing') dispatch({ scroll: false }); // refresh whatever view is open
}, 60_000); // mirrors the 60s backend cycle
