// Batches & expiry: production/expiry date and lot number for each received batch of frozen stock.
import * as UI from '../core/ui.js';
import { esc, fmtNum, fmtQty, fmtDate, today, debounce } from '../core/utils.js';
import { pager } from '../core/views.js';
import * as Auth from '../services/auth.js';
import * as Catalog from '../services/catalog.js';
import * as Frozen from '../services/frozen.js';

const $ = window.jQuery;

const STATUS_BADGE = {
  expired: ['text-bg-danger', 'Expired', 'x-octagon'],
  soon: ['text-bg-warning', 'Expires soon', 'exclamation-triangle'],
  ok: ['text-bg-success', 'Good', 'check2-circle'],
  closed: ['text-bg-secondary', 'Closed', 'archive'],
};

// Add or edit a batch. The product list shows active products; shelf life pre-fills the expiry date.
export async function editBatch(batch = null) {
  const b = { qty: '', ...(batch || {}) };
  const products = Catalog.allProducts().filter((p) => p.active).sort((x, y) => x.name.localeCompare(y.name));
  return UI.formModal({
    title: batch ? 'Edit batch' : 'New batch', size: 'lg', submitLabel: 'Save batch',
    body: `<div class="row g-2">
      <div class="col-12"><label class="form-label">Product *</label><select name="productId" class="form-select" required>
        <option value="">Choose product…</option>${products.map((p) => `<option value="${esc(p.id)}" data-shelf="${p.shelfLifeDays || 0}" ${p.id === b.productId ? 'selected' : ''}>${esc(p.name)}${p.brand ? ' · ' + esc(p.brand) : ''}</option>`).join('')}
      </select></div>
      <div class="col-6"><label class="form-label">Lot / batch no. *</label><input name="lotNo" class="form-control" maxlength="60" value="${esc(b.lotNo)}" placeholder="As printed on the packet"></div>
      <div class="col-6"><label class="form-label">Quantity received</label><input name="qty" class="form-control" inputmode="decimal" value="${b.qty ?? ''}"></div>
      <div class="col-6"><label class="form-label">Production date</label><input type="date" name="mfgDate" class="form-control" value="${esc(b.mfgDate)}" max="${today()}"></div>
      <div class="col-6"><label class="form-label">Expiry date *</label><input type="date" name="expiryDate" class="form-control" value="${esc(b.expiryDate)}"></div>
      <div class="col-12"><label class="form-label">Note</label><input name="note" class="form-control" maxlength="300" value="${esc(b.note)}" placeholder="Supplier, cold-chain remarks…"></div>
      <div class="col-12 small text-body-secondary"><i class="bi bi-info-circle me-1"></i>Batches are for food safety tracking. Stock quantities still come from purchases, sales and adjustments.</div>
    </div>`,
    onShown: ($m) => {
      const fill = () => {
        const shelf = Number($m.find('[name=productId] option:selected').data('shelf')) || 0;
        const mfg = $m.find('[name=mfgDate]').val();
        const $exp = $m.find('[name=expiryDate]');
        if (!$exp.val() && shelf && mfg) {
          const d = new Date(mfg + 'T00:00:00'); d.setDate(d.getDate() + shelf);
          $exp.val(new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10));
        }
      };
      $m.find('[name=productId], [name=mfgDate]').on('change', fill);
      $m.find('[name=lotNo]').trigger('focus');
    },
    onSubmit: async (v) => {
      const saved = await Frozen.saveBatch({ ...v, id: batch?.id });
      UI.toast(batch ? 'Batch updated' : 'Batch saved');
      return saved;
    },
  });
}

async function batchActions(b, redraw) {
  const canEdit = Auth.can('stock.adjust');
  const closed = b.status === 'closed';
  const m = UI.modal({ title: b.productName, fullscreenMobile: false,
    body: `<div class="row small mb-3">
        <div class="col-6">Lot: <b>${esc(b.lotNo)}</b></div><div class="col-6">Qty: <b>${fmtQty(b.qty)}</b></div>
        <div class="col-6">Produced: <b>${b.mfgDate ? esc(fmtDate(b.mfgDate)) : '—'}</b></div><div class="col-6">Expires: <b>${esc(fmtDate(b.expiryDate))}</b></div>
        ${b.note ? `<div class="col-12 mt-2 text-body-secondary">${esc(b.note)}</div>` : ''}</div>
      ${canEdit ? `<div class="d-grid gap-2">
        <button class="btn btn-primary btn-edit"><i class="bi bi-pencil me-1"></i>Edit batch</button>
        <button class="btn btn-outline-secondary btn-status"><i class="bi bi-${closed ? 'arrow-counterclockwise' : 'archive'} me-1"></i>${closed ? 'Reopen batch' : 'Mark as sold out / disposed'}</button>
        <button class="btn btn-outline-danger btn-del"><i class="bi bi-trash me-1"></i>Delete</button></div>` : ''}` });
  m.$el.find('.btn-edit').on('click', async () => { m.close(); await m.closed; if (await editBatch(b)) redraw(); });
  m.$el.find('.btn-status').on('click', async () => {
    try { await Frozen.setBatchStatus(b.id, closed ? 'open' : 'closed'); UI.toast(closed ? 'Batch reopened' : 'Batch closed'); m.close(); redraw(); } catch (e) { UI.toastError(e); }
  });
  m.$el.find('.btn-del').on('click', async () => {
    if (!await UI.confirmDialog(`Delete batch ${b.lotNo}?`, { okLabel: 'Delete', okClass: 'btn-danger' })) return;
    try { await Frozen.deleteBatch(b.id); UI.toast('Batch deleted'); m.close(); redraw(); } catch (e) { UI.toastError(e); }
  });
}

async function renderPage(el) {
  const $el = $(el).off();
  const canEdit = Auth.can('stock.adjust');
  $el.html(UI.pageHeader('Batches & expiry', canEdit ? '<button class="btn btn-primary btn-sm btn-add"><i class="bi bi-plus-lg"></i> Add batch</button>' : '') + `
    <div class="row g-2 mb-3 batch-summary"></div>
    <div class="filters">
      <div class="input-group flex-grow-2"><input type="search" class="form-control q" placeholder="Search product, lot no., brand…"></div>
      <select class="form-select f-status">
        <option value="active">Active (not closed)</option><option value="soon">Expiring soon</option><option value="expired">Expired</option>
        <option value="closed">Closed</option><option value="all">All</option></select>
    </div>
    <div class="list-card batch-list"></div>`);

  let all = await Frozen.listBatches();
  const draw = () => {
    const q = ($el.find('.q').val() || '').trim().toLowerCase();
    const f = $el.find('.f-status').val();
    const day = today();
    const withStatus = all.map((b) => ({ b, s: Frozen.expiryStatus(b, day) }));
    const counts = { expired: 0, soon: 0 };
    for (const { s } of withStatus) if (s === 'expired' || s === 'soon') counts[s]++;
    $el.find('.batch-summary').html(`
      <div class="col-6"><div class="stat-card card-body p-3"><div class="l">Expired</div><div class="v text-danger">${counts.expired}</div></div></div>
      <div class="col-6"><div class="stat-card card-body p-3"><div class="l">Expiring within ${Frozen.EXPIRY_WARN_DAYS} days</div><div class="v text-warning-emphasis">${counts.soon}</div></div></div>`);
    const list = withStatus.filter(({ b, s }) => {
      if (f === 'active' && s === 'closed') return false;
      if (f === 'soon' && s !== 'soon') return false;
      if (f === 'expired' && s !== 'expired') return false;
      if (f === 'closed' && s !== 'closed') return false;
      if (!q) return true;
      return [b.productName, b.lotNo].some((x) => String(x || '').toLowerCase().includes(q));
    });
    pager($el.find('.batch-list'), list, ({ b, s }) => {
      const [cls, label, icon] = STATUS_BADGE[s];
      return `<button class="list-row" data-id="${esc(b.id)}">
        ${UI.avatar(b.productName)}
        <div class="main"><div class="title">${esc(b.productName)}</div>
          <div class="sub">Lot ${esc(b.lotNo)} · Qty ${fmtQty(b.qty)}${b.mfgDate ? ' · made ' + esc(fmtDate(b.mfgDate)) : ''}</div></div>
        <div class="end"><span class="badge ${cls}"><i class="bi bi-${icon} me-1"></i>${label}</span>
          <div class="sub mt-1">Exp ${esc(fmtDate(b.expiryDate))}</div></div></button>`;
    }, 60, UI.emptyState('No batches here', 'snow2', canEdit ? '<button class="btn btn-primary btn-sm mt-3 btn-add">Add batch</button>' : ''));
  };
  const reload = async () => { all = await Frozen.listBatches(); draw(); };
  draw();
  $el.on('input', '.q', debounce(draw, 150));
  $el.on('change', '.f-status', draw);
  $el.on('click', '.btn-add', async () => { if (await editBatch()) reload(); });
  $el.on('click', '.list-row[data-id]', function () {
    const b = all.find((x) => x.id === this.dataset.id);
    if (b && canEdit) batchActions(b, reload);
  });
  return reload;
}

export default {
  async render(el) {
    this.destroy();
    const reload = await renderPage(el);
    this._h = () => { if (el.isConnected) reload(); };
    document.addEventListener('data:changed', this._h);
  },
  destroy() {
    if (this._h) document.removeEventListener('data:changed', this._h);
    this._h = null;
  },
};
