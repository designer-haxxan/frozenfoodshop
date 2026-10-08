// Dashboard: business hub + today's figures and trends, all computed from transaction records.
import * as idb from '../db/idb.js';
import * as UI from '../core/ui.js';
import { esc, fmtNum, fmtQty, fmtTime, fmtDate, today, localDate, round2, debounce } from '../core/utils.js';
import { cur } from '../core/views.js';
import { pref } from '../core/settings.js';
import * as Auth from '../services/auth.js';
import * as Catalog from '../services/catalog.js';
import * as Posting from '../services/posting.js';
import * as Backup from '../services/backup.js';
import * as Frozen from '../services/frozen.js';

const $ = window.jQuery;

export async function todayFigures(date = today()) {
  const r = IDBKeyRange.only(date);
  const [sales, purchases, sret, pret, vouchers, entries, accounts] = await idb.read(['sales', 'purchases', 'saleReturns', 'purchaseReturns', 'vouchers', 'entries', 'accounts'], (t) => Promise.all([
    t.getAllByIndex('sales', 'date', r), t.getAllByIndex('purchases', 'date', r), t.getAllByIndex('saleReturns', 'date', r),
    t.getAllByIndex('purchaseReturns', 'date', r), t.getAllByIndex('vouchers', 'date', r), t.getAllByIndex('entries', 'date', r), t.getAll('accounts'),
  ]));
  const live = (x) => x.filter((d) => d.status !== 'void');
  const cashIds = new Set(accounts.filter((a) => ['cash', 'bank'].includes(a.type)).map((a) => a.id));
  const cashEntries = entries.filter((e) => cashIds.has(e.accountId) && e.refType !== 'opening' && e.refType !== 'transfer');
  const s = live(sales); const p = live(purchases);
  return {
    sales: round2(s.reduce((a, d) => a + d.total, 0)), salesCount: s.length,
    purchases: round2(p.reduce((a, d) => a + d.total, 0)), purchasesCount: p.length,
    saleReturns: round2(live(sret).reduce((a, d) => a + d.total, 0)),
    purchaseReturns: round2(live(pret).reduce((a, d) => a + d.total, 0)),
    cashIn: round2(cashEntries.reduce((a, e) => a + e.debit, 0)),
    cashOut: round2(cashEntries.reduce((a, e) => a + e.credit, 0)),
    txCount: s.length + p.length + live(sret).length + live(pret).length + live(vouchers).length,
    recent: s.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 6),
    cashIds,
  };
}

// Sales per day for the last 7 days + top products by amount (from sale lines).
async function weekFigures() {
  const days = [];
  for (let i = 6; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); days.push(localDate(d)); }
  const range = IDBKeyRange.bound(days[0], days[6]);
  const [sales, items] = await idb.read(['sales', 'saleItems'], (t) => Promise.all([t.getAllByIndex('sales', 'date', range), t.getAllByIndex('saleItems', 'date', range)]));
  const byDay = Object.fromEntries(days.map((d) => [d, { date: d, total: 0, count: 0 }]));
  for (const s of sales) if (s.status !== 'void' && byDay[s.date]) { byDay[s.date].total += s.total; byDay[s.date].count++; }
  const prod = new Map();
  for (const i of items) { const x = prod.get(i.productId) || { name: i.name, amount: 0, qty: 0 }; x.amount += i.amount; x.qty += i.qty; prod.set(i.productId, x); }
  return { days: days.map((d) => ({ ...byDay[d], total: round2(byDay[d].total) })), top: [...prod.values()].sort((a, b) => b.amount - a.amount).slice(0, 5) };
}

const compact = (n) => (Math.abs(n) >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : Math.abs(n) >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k` : String(Math.round(n)));
function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const m = v / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
}

// Single-series bar chart drawn at the container's real width (so text stays crisp). Hover/tap shows a tooltip.
function drawWeekChart(box, days) {
  const W = Math.max(280, box.clientWidth); const H = 190;
  const m = { t: 22, r: 8, b: 26, l: 40 };
  const iw = W - m.l - m.r; const ih = H - m.t - m.b;
  const max = niceMax(Math.max(...days.map((d) => d.total)));
  const band = iw / days.length; const bw = Math.min(36, band * 0.56);
  const y = (v) => m.t + ih - (v / max) * ih;
  const peak = days.reduce((a, d, i) => (d.total > days[a].total ? i : a), 0);
  const ticks = [0, max / 2, max];
  const barPath = (x, top, w, h) => {
    if (h <= 0) return '';
    const r = Math.min(4, h, w / 2);
    return `M${x},${top + h} V${top + r} Q${x},${top} ${x + r},${top} H${x + w - r} Q${x + w},${top} ${x + w},${top + r} V${top + h} Z`;
  };
  let svg = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Sales for the last 7 days"><g class="grid">`;
  for (const t of ticks) svg += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(t)}" y2="${y(t)}"/>`;
  svg += '</g><g class="axis">';
  for (const t of ticks) svg += `<text x="${m.l - 8}" y="${y(t) + 4}" text-anchor="end">${compact(t)}</text>`;
  days.forEach((d, i) => {
    const cx = m.l + band * i + band / 2;
    const label = i === days.length - 1 ? 'Today' : new Date(d.date + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short' });
    svg += `<text x="${cx}" y="${H - 6}" text-anchor="middle" ${i === days.length - 1 ? 'font-weight="700"' : ''}>${esc(label)}</text>`;
  });
  svg += '</g>';
  days.forEach((d, i) => {
    const x = m.l + band * i + (band - bw) / 2; const top = y(d.total); const h = m.t + ih - top;
    svg += `<path class="bar" d="${barPath(x, top, bw, h)}" style="animation-delay:${i * 0.05}s"/>`;
    if ((i === peak || i === days.length - 1) && d.total > 0) svg += `<text class="val" x="${x + bw / 2}" y="${top - 6}" text-anchor="middle">${compact(d.total)}</text>`;
    svg += `<rect class="bar-hit" data-i="${i}" x="${m.l + band * i}" y="${m.t}" width="${band}" height="${ih}"/>`;
  });
  svg += '</svg><div class="viz-tip"></div>';
  box.innerHTML = svg;
  const tip = box.querySelector('.viz-tip');
  const show = (el) => {
    const d = days[+el.dataset.i];
    tip.innerHTML = `<b>${esc(fmtDate(d.date))}</b><br>${esc(cur())} ${fmtNum(d.total)} · ${d.count} invoice${d.count === 1 ? '' : 's'}`;
    tip.style.left = `${(+el.getAttribute('x') + band / 2)}px`;
    tip.style.top = `${Math.max(14, y(d.total))}px`;
    tip.classList.add('show');
  };
  box.querySelectorAll('.bar-hit').forEach((el) => {
    el.addEventListener('mouseenter', () => show(el));
    el.addEventListener('click', () => show(el));
    el.addEventListener('mouseleave', () => tip.classList.remove('show'));
  });
}

export default {
  async render(el) {
    this.destroy();
    const $el = $(el);
    const u = Auth.user();
    const [f, bal, wk, batches, coldLogs] = await Promise.all([todayFigures(), Posting.allBalances(), weekFigures(), Frozen.listBatches(), Frozen.listColdLogs()]);
    const day = today();
    const expired = batches.filter((b) => Frozen.expiryStatus(b, day) === 'expired');
    const expiring = batches.filter((b) => Frozen.expiryStatus(b, day) === 'soon');
    const warmUnits = Frozen.latestByUnit(coldLogs).filter((l) => Frozen.tempStatus(l.tempC) === 'warn');
    const coldAlerts = warmUnits.length + (coldLogs.length ? 0 : 1);
    let rec = 0; let pay = 0; let cash = 0;
    for (const [id, b] of bal) {
      if (id.startsWith('C:') && b.balance > 0) rec += b.balance;
      if (id.startsWith('S:') && b.balance < 0) pay -= b.balance;
      if (f.cashIds.has(id)) cash += b.balance;
    }
    const prods = Catalog.allProducts().filter((p) => p.active);
    const tracked = prods.filter((p) => p.trackStock !== false);
    const stockValue = tracked.reduce((s, p) => s + Math.max(0, p.stock) * (p.purchasePrice || 0), 0);
    const low = tracked.filter((p) => p.stock <= (p.minStock || 0)).sort((a, b) => a.stock - b.stock);
    const customers = Catalog.allParties('customers').filter((c) => c.active).length;
    const suppliers = Catalog.allParties('suppliers').filter((c) => c.active).length;
    const lastBackup = pref.get('lastBackupAt');
    const backupDays = lastBackup ? Math.floor((Date.now() - new Date(lastBackup)) / 86400000) : null;
    const hour = new Date().getHours();
    const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
    const M = (n) => `data-count="${round2(n)}" data-money="1"`;

    const tile = (href, icon, tint, title, sub, perm) => (perm && !Auth.can(perm) ? '' : `<div class="col-6 col-md-4 col-xl-3">
      <a class="hub-tile" href="${href}"><div class="icon-chip tint-${tint}"><i class="bi bi-${icon}"></i></div>
      <div class="min-w-0"><div class="t">${title}</div><div class="s">${sub}</div></div></a></div>`);
    const kpi = (icon, tint, label, valueAttr, href) => `<div class="col-6 col-lg-3"><${href ? `a href="${href}"` : 'div'} class="stat-card card-body d-block text-decoration-none p-3 h-100">
      <div class="kpi"><div class="icon-chip tint-${tint}"><i class="bi bi-${icon}"></i></div><div class="min-w-0"><div class="l">${label}</div><div class="v money" ${valueAttr}>0</div></div></div></${href ? 'a' : 'div'}></div>`;

    $el.html(`
      <div class="hero-card">
        <div class="d-flex justify-content-between align-items-start gap-2 mb-3">
          <div><div class="hello">${greet}, ${esc(u.name.split(' ')[0])}</div><div class="date">${new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</div></div>
          <span class="pill"><i class="bi bi-${navigator.onLine ? 'cloud-check' : 'wifi-off'}"></i>${navigator.onLine ? 'Online' : 'Offline'}</span>
        </div>
        <div class="lbl">Today's sales</div>
        <div class="big money" ${M(f.sales)}>0</div>
        <div class="d-flex flex-wrap gap-2 mt-2 mb-3">
          <span class="pill"><i class="bi bi-receipt"></i>${f.salesCount} invoice${f.salesCount === 1 ? '' : 's'}</span>
          <span class="pill"><i class="bi bi-arrow-down-circle"></i>In ${esc(cur())} ${fmtNum(f.cashIn)}</span>
          <span class="pill"><i class="bi bi-arrow-up-circle"></i>Out ${esc(cur())} ${fmtNum(f.cashOut)}</span>
        </div>
        <div class="d-flex flex-wrap gap-2">
          ${Auth.can('sale.create') ? '<a class="btn hero-cta" href="#/pos"><i class="bi bi-cart-plus me-1"></i>New sale</a>' : ''}
          ${Auth.can('purchase.manage') ? '<a class="btn btn-outline-light" href="#/purchase/new"><i class="bi bi-bag-plus me-1"></i>Purchase</a>' : ''}
          ${Auth.can('voucher.create') ? '<a class="btn btn-outline-light d-none d-sm-inline-block" href="#/vouchers"><i class="bi bi-cash-coin me-1"></i>Cash book</a>' : ''}
        </div>
      </div>
      ${!navigator.onLine ? '<div class="alert alert-secondary py-2 small"><i class="bi bi-wifi-off me-1"></i>You are offline. Everything you do is saved on this device.</div>' : ''}
      <div class="legacy-hint"></div>
      ${expired.length || expiring.length ? `<div class="alert alert-${expired.length ? 'danger' : 'warning'} py-2 small d-flex align-items-center gap-2"><i class="bi bi-calendar-x"></i><div class="flex-grow-1"><b>${expired.length} expired</b> and <b>${expiring.length}</b> expiring within ${Frozen.EXPIRY_WARN_DAYS} days. Check the batches before selling.</div><a class="btn btn-sm ${expired.length ? 'btn-danger' : 'btn-warning'}" href="#/batches">View</a></div>` : ''}
      ${warmUnits.length ? `<div class="alert alert-danger py-2 small d-flex align-items-center gap-2"><i class="bi bi-thermometer-high"></i><div class="flex-grow-1"><b>${warmUnits.map((l) => esc(l.unit)).join(', ')}</b> ${warmUnits.length > 1 ? 'are' : 'is'} above ${Frozen.FREEZER_LIMIT_C} °C. Check the freezer and food safety.</div><a class="btn btn-sm btn-danger" href="#/coldchain">Log</a></div>` : ''}
      ${Auth.can('backup.export') && (backupDays === null || backupDays >= 7) ?`<div class="alert alert-warning py-2 small d-flex align-items-center gap-2"><i class="bi bi-shield-exclamation"></i><div class="flex-grow-1">${backupDays === null ? 'No backup has been made on this device yet.' : `Last backup was ${backupDays} days ago.`} Your data only lives on this device.</div><a class="btn btn-sm btn-warning" href="#/backup">Back up</a></div>` : ''}

      <div class="section-title"><h2>Business hub</h2></div>
      <div class="row g-2 stagger">
        ${tile('#/sales', 'receipt', 'indigo', 'Sales', `${f.salesCount} today · ${esc(cur())} ${fmtNum(f.sales)}`)}
        ${tile('#/purchases', 'bag-check', 'violet', 'Purchases', `${f.purchasesCount} today · ${esc(cur())} ${fmtNum(f.purchases)}`, 'purchase.manage')}
        ${tile('#/products', 'box-seam', 'cyan', 'Products', `${prods.length} active items`)}
        ${tile('#/stock', 'boxes', low.length ? 'red' : 'green', 'Inventory', low.length ? `${low.length} low / out of stock` : 'All stock levels fine')}
        ${tile('#/customers', 'people', 'pink', 'Customers', `${customers} · due ${esc(cur())} ${fmtNum(rec)}`)}
        ${tile('#/suppliers', 'truck', 'slate', 'Suppliers', `${suppliers} · payable ${esc(cur())} ${fmtNum(pay)}`, 'purchase.manage')}
        ${tile('#/accounts', 'bank', 'green', 'Accounts', `Cash & bank ${esc(cur())} ${fmtNum(cash)}`, 'account.manage')}
        ${tile('#/vouchers', 'cash-coin', 'amber', 'Cash book', 'Receipts & payments', 'voucher.create')}
        ${tile('#/batches', 'snow2', expired.length ? 'red' : expiring.length ? 'amber' : 'green', 'Batches & expiry', expired.length ? `${expired.length} expired` : expiring.length ? `${expiring.length} expiring soon` : `${batches.filter((b) => Frozen.expiryStatus(b, day) === 'ok').length} batches good`)}
        ${tile('#/coldchain', 'thermometer-snow', coldAlerts ? 'red' : 'cyan', 'Cold chain', warmUnits.length ? `${warmUnits.length} unit(s) too warm` : coldLogs.length ? `Last reading ${coldLogs[0].tempC} °C` : 'No readings yet')}
        ${tile('#/returns', 'arrow-return-left', 'red', 'Returns', f.saleReturns ? `${esc(cur())} ${fmtNum(f.saleReturns)} today` : 'Sale & purchase returns')}
        ${tile('#/reports', 'bar-chart-line', 'indigo', 'Reports', 'Sales, stock, profit & ledgers', 'reports.view')}
        ${tile('#/backup', 'cloud-arrow-down', 'cyan', 'Backup', backupDays === null ? 'Not backed up yet' : `Last ${backupDays}d ago`, 'backup.export')}
        ${tile('#/settings', 'gear', 'slate', 'Settings', 'Shop, printer, tax')}
      </div>

      <div class="section-title"><h2>Overview</h2></div>
      <div class="row g-2 stagger">
        ${kpi('person-down', 'amber', 'Receivables', M(rec), Auth.can('reports.view') ? '#/reports/receivables' : '#/customers')}
        ${Auth.can('purchase.manage') ? kpi('truck', 'red', 'Payables', M(pay), Auth.can('reports.view') ? '#/reports/payables' : null) : ''}
        ${kpi('boxes', 'indigo', 'Stock value', M(stockValue), '#/stock')}
        ${kpi('activity', 'cyan', 'Transactions today', `data-count="${f.txCount}"`, null)}
      </div>

      <div class="row g-3 mt-1">
        <div class="col-lg-8"><div class="card viz-card h-100">
          <div class="viz-head"><div><div class="ttl">Sales — last 7 days</div><div class="sub">Total ${esc(cur())} ${fmtNum(wk.days.reduce((s, d) => s + d.total, 0))} · ${wk.days.reduce((s, d) => s + d.count, 0)} invoices</div></div>
            <a class="small fw-semibold text-decoration-none" href="#/reports/sales">Report <i class="bi bi-chevron-right"></i></a></div>
          <div class="viz week-chart"></div>
          <details class="viz-table"><summary>Show as table</summary>
            <table class="table table-sm table-report mt-2 mb-0"><thead><tr><th>Date</th><th class="num">Invoices</th><th class="num">Sales</th></tr></thead>
            <tbody>${wk.days.map((d) => `<tr><td>${esc(fmtDate(d.date))}</td><td class="num">${d.count}</td><td class="num">${fmtNum(d.total)}</td></tr>`).join('')}</tbody></table></details>
        </div></div>
        <div class="col-lg-4"><div class="card viz-card h-100">
          <div class="viz-head"><div><div class="ttl">Top products</div><div class="sub">By sales amount, last 7 days</div></div></div>
          ${wk.top.length ? wk.top.map((p) => `<div class="hbar"><div class="name">${esc(p.name)}</div><div class="amt money">${fmtNum(p.amount)}</div>
            <div class="track"><div class="fill" style="width:${Math.max(3, (p.amount / wk.top[0].amount) * 100)}%"></div></div></div>`).join('') : UI.emptyState('No sales in the last 7 days', 'graph-up')}
        </div></div>
      </div>

      <div class="row g-3 mt-1">
        <div class="col-md-6"><div class="section-title mt-0"><h2>Recent sales</h2><a href="#/sales">View all</a></div>
          <div class="list-card">${f.recent.map((s) => `<a class="list-row" href="#/sales/${encodeURIComponent(s.id)}">${UI.avatar(s.customerName, 'round')}<div class="main"><div class="title">${esc(s.customerName)}</div><div class="sub">${esc(s.number)} · ${fmtTime(s.createdAt)}</div></div><div class="end"><div class="fw-bold money">${fmtNum(s.total)}</div>${s.balance > 0.004 ? '<span class="badge text-bg-warning">Credit</span>' : '<span class="badge bg-success-subtle text-success-emphasis">Paid</span>'}</div></a>`).join('') || UI.emptyState('No sales yet today', 'receipt')}</div></div>
        <div class="col-md-6"><div class="section-title mt-0"><h2>Low stock</h2><a href="#/stock">Inventory</a></div>
          <div class="list-card">${low.slice(0, 6).map((p) => `<a class="list-row" href="#/stock/${encodeURIComponent(p.id)}">${UI.avatar(p.name)}<div class="main"><div class="title">${esc(p.name)}</div><div class="sub">Minimum ${fmtQty(p.minStock || 0)} ${esc(p.unit || '')}</div></div><div class="end"><span class="badge ${p.stock <= 0 ? 'text-bg-danger' : 'text-bg-warning'}"><i class="bi bi-${p.stock <= 0 ? 'x-octagon' : 'exclamation-triangle'} me-1"></i>${fmtQty(p.stock)} ${esc(p.unit || '')}</span></div></a>`).join('') || UI.emptyState('All stock levels are fine', 'check2-circle')}</div></div>
      </div>`);

    UI.countUp(el, (v, node) => (node.dataset.money ? `${cur()} ${fmtNum(v)}` : String(Math.round(v))));
    const chartBox = el.querySelector('.week-chart');
    drawWeekChart(chartBox, wk.days);
    this._resize = debounce(() => { if (chartBox.isConnected) drawWeekChart(chartBox, wk.days); }, 200);
    window.addEventListener('resize', this._resize);

    if (Auth.can('backup.restore') && pref.get('legacyHandled') !== true) {
      Backup.legacyDataExists().then((yes) => yes && $el.find('.legacy-hint').html('<div class="alert alert-info py-2 small d-flex align-items-center gap-2"><i class="bi bi-database"></i><div class="flex-grow-1">Data from an older version was found on this device.</div><a class="btn btn-sm btn-info" href="#/backup">Review</a></div>'));
    }
    const refresh = () => { if (location.hash === '' || location.hash.startsWith('#/dashboard')) this.render(el); };
    this._h = refresh;
    document.addEventListener('data:changed', refresh);
  },
  destroy() {
    if (this._h) document.removeEventListener('data:changed', this._h);
    if (this._resize) window.removeEventListener('resize', this._resize);
    this._h = null; this._resize = null;
  },
};
