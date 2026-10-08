// Cold chain: freezer / cold-room temperature log. Frozen food must stay at -18 °C or colder.
import * as UI from '../core/ui.js';
import { esc, fmtDateTime, debounce } from '../core/utils.js';
import * as Auth from '../services/auth.js';
import * as Frozen from '../services/frozen.js';

const $ = window.jQuery;
const DAY_MS = 86400000;
const LIMIT = Frozen.FREEZER_LIMIT_C;

// Each unit's latest reading, with a warning when it is too warm or has not been logged for a day.
function unitCards(logs) {
  const latest = Frozen.latestByUnit(logs);
  if (!latest.length) return UI.emptyState('No readings yet. Log your first freezer temperature below.', 'thermometer-snow');
  return latest.map((l) => {
    const stale = Date.now() - Date.parse(l.at) > DAY_MS;
    const warm = Frozen.tempStatus(l.tempC) === 'warn';
    const cls = warm ? 'text-bg-danger' : stale ? 'text-bg-warning' : 'text-bg-success';
    const msg = warm ? `Too warm. Keep at ${LIMIT} °C or colder.` : stale ? 'No reading in the last 24 hours.' : 'Within safe range.';
    return `<div class="col-12 col-sm-6 col-lg-4"><div class="stat-card card-body p-3 h-100 cold-card ${warm ? 'is-warm' : ''}">
      <div class="kpi"><div class="icon-chip tint-${warm ? 'red' : stale ? 'amber' : 'cyan'}"><i class="bi bi-thermometer-snow"></i></div>
        <div class="min-w-0"><div class="l text-truncate">${esc(l.unit)}</div><div class="v">${l.tempC} °C</div></div></div>
      <div class="d-flex justify-content-between align-items-center gap-2 mt-2">
        <span class="badge ${cls}">${warm ? 'Warm' : stale ? 'Check' : 'OK'}</span>
        <span class="small text-body-secondary text-end">${esc(fmtDateTime(l.at))}</span></div>
      <div class="small mt-1 ${warm ? 'text-danger fw-semibold' : 'text-body-secondary'}">${esc(msg)}</div></div></div>`;
  }).join('');
}

async function renderPage(el) {
  const $el = $(el).off();
  const canEdit = Auth.can('stock.adjust');
  const logs = await Frozen.listColdLogs();
  const units = [...new Set(logs.map((l) => l.unit))];
  $el.html(UI.pageHeader('Cold chain log') + `
    <div class="alert alert-info small py-2 mb-3"><i class="bi bi-info-circle me-1"></i>Keep frozen food at <b>${LIMIT} °C or colder</b>. Read the freezer display at least twice a day and log it here.</div>
    <div class="section-title mt-0"><h2>Current status</h2></div>
    <div class="row g-2 mb-3 unit-cards">${unitCards(logs)}</div>
    ${canEdit ? `<div class="section-title mt-0"><h2>Log a reading</h2></div>
    <form class="card card-body mb-3 reading-form">
      <div class="row g-2">
        <div class="col-12 col-md-4"><label class="form-label">Freezer / cold room *</label>
          <input name="unit" class="form-control" list="unit-list" maxlength="60" required value="${esc(units[0] || '')}" placeholder="e.g. Freezer 1">
          <datalist id="unit-list">${units.map((u) => `<option value="${esc(u)}">`).join('')}</datalist></div>
        <div class="col-6 col-md-3"><label class="form-label">Temperature (°C) *</label>
          <input name="tempC" class="form-control" inputmode="decimal" required placeholder="-18"></div>
        <div class="col-6 col-md-5"><label class="form-label">Note</label>
          <input name="note" class="form-control" maxlength="200" placeholder="Door opened, power cut…"></div>
        <div class="col-12 d-grid d-md-flex justify-content-md-end"><button class="btn btn-primary"><i class="bi bi-save me-1"></i>Save reading</button></div>
      </div></form>` : ''}
    <div class="section-title mt-0"><h2>Recent readings</h2></div>
    <div class="list-card reading-list">${logs.slice(0, 50).map((l) => {
      const st = Frozen.tempStatus(l.tempC);
      return `<div class="list-row"><div class="avatar tint-${st === 'ok' ? 'cyan' : 'red'}" aria-hidden="true"><i class="bi bi-thermometer-half"></i></div>
        <div class="main"><div class="title">${esc(l.unit)} · ${l.tempC} °C</div>
          <div class="sub">${esc(fmtDateTime(l.at))}${l.userName ? ' · ' + esc(l.userName) : ''}${l.note ? ' · ' + esc(l.note) : ''}</div></div>
        <div class="end">${st === 'ok' ? '<span class="badge bg-success-subtle text-success-emphasis">OK</span>' : '<span class="badge text-bg-danger">Too warm</span>'}
          ${canEdit ? `<button class="btn btn-sm btn-link text-danger p-0 mt-1 btn-del" data-id="${esc(l.id)}" aria-label="Delete reading"><i class="bi bi-trash"></i></button>` : ''}</div></div>`;
    }).join('') || UI.emptyState('No readings logged yet', 'thermometer')}</div>`);

  $el.on('submit', '.reading-form', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget).entries());
    try {
      const rec = await Frozen.saveColdReading(f);
      UI.toast(Frozen.tempStatus(rec.tempC) === 'ok' ? 'Reading saved' : 'Reading saved. Freezer is too warm, check it now.', Frozen.tempStatus(rec.tempC) === 'ok' ? 'success' : 'warning', 5000);
      renderPage(el);
    } catch (err) { UI.toastError(err); }
  });
  $el.on('click', '.btn-del', async function () {
    if (!await UI.confirmDialog('Delete this temperature reading?', { okLabel: 'Delete', okClass: 'btn-danger' })) return;
    try { await Frozen.deleteColdReading(this.dataset.id); renderPage(el); } catch (err) { UI.toastError(err); }
  });
}

export default {
  async render(el) {
    this.destroy();
    await renderPage(el);
    this._h = debounce(() => { if (el.isConnected) renderPage(el); }, 150);
    document.addEventListener('data:changed', this._h);
  },
  destroy() {
    if (this._h) document.removeEventListener('data:changed', this._h);
    this._h = null;
  },
};
