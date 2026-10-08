// Products & categories.
import * as UI from '../core/ui.js';
import { esc, fmtNum, fmtQty, debounce, compressImage, AppError } from '../core/utils.js';
import { money, pager } from '../core/views.js';
import * as Auth from '../services/auth.js';
import * as Catalog from '../services/catalog.js';
import * as Posting from '../services/posting.js';
import * as Frozen from '../services/frozen.js';
import * as Scanner from '../scanner/scanner.js';

const $ = window.jQuery;
const UNITS = ['pcs', 'kg', 'g', 'ltr', 'ml', 'box', 'pack', 'dozen', 'm', 'ft', 'pair', 'set'];

// Internal EAN-13 barcode in the "in-store" 20-29 prefix range.
function generateBarcode() {
  let tries = 0; let code;
  do {
    const digits = '2' + String(Math.floor(Math.random() * 10)) + Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => b % 10).join('');
    const sum = [...digits].reduce((s, d, i) => s + Number(d) * (i % 2 ? 3 : 1), 0);
    code = digits + ((10 - (sum % 10)) % 10);
  } while (Catalog.findByCode(code) && ++tries < 20);
  return code;
}

export async function editProduct(product = null, prefill = {}) {
  const p = { unit: 'pcs', trackStock: true, active: 1, ...prefill, ...(product || {}) };
  let image = p.image || '';
  const cats = Catalog.allCategories();
  return UI.formModal({
    title: product ? 'Edit product' : 'New product', size: 'lg',
    body: `<div class="row g-2">
      <div class="col-12"><label class="form-label">Product name *</label><input name="name" class="form-control" required maxlength="150" value="${esc(p.name)}"></div>
      <div class="col-6 col-md-4"><label class="form-label">SKU / code</label><input name="sku" class="form-control" value="${esc(p.sku)}"></div>
      <div class="col-6 col-md-4"><label class="form-label">Barcode</label><div class="input-group">
        <input name="barcode" class="form-control" value="${esc(p.barcode)}" inputmode="numeric">
        <button type="button" class="btn btn-outline-secondary btn-scan-bc" title="Scan" aria-label="Scan barcode"><i class="bi bi-upc-scan"></i></button>
        <button type="button" class="btn btn-outline-secondary btn-gen-bc" title="Generate" aria-label="Generate barcode"><i class="bi bi-magic"></i></button></div></div>
      <div class="col-6 col-md-2"><label class="form-label">Category</label><select name="categoryId" class="form-select"><option value="">—</option>${UI.options(cats, p.categoryId)}</select></div>
      <div class="col-6 col-md-2"><label class="form-label">Unit</label><input name="unit" class="form-control" list="unit-list" value="${esc(p.unit)}"><datalist id="unit-list">${UNITS.map((u) => `<option value="${u}">`).join('')}</datalist></div>
      <div class="col-4"><label class="form-label">Purchase price</label><input name="purchasePrice" class="form-control" inputmode="decimal" value="${p.purchasePrice ?? ''}"></div>
      <div class="col-4"><label class="form-label">Sale price</label><input name="salePrice" class="form-control" inputmode="decimal" value="${p.salePrice ?? ''}"></div>
      <div class="col-4"><label class="form-label">Wholesale</label><input name="wholesalePrice" class="form-control" inputmode="decimal" value="${p.wholesalePrice ?? ''}"></div>
      <div class="col-12"><hr class="my-1"><div class="small fw-semibold text-body-secondary"><i class="bi bi-snow me-1"></i>Frozen food details</div></div>
      <div class="col-6 col-md-4"><label class="form-label">Brand</label><input name="brand" class="form-control" maxlength="60" value="${esc(p.brand)}" placeholder="e.g. Dawn, Quick Foods"></div>
      <div class="col-6 col-md-4"><label class="form-label">Pack size</label><input name="packSize" class="form-control" maxlength="40" value="${esc(p.packSize)}" placeholder="e.g. 1 kg, 20 pcs"></div>
      <div class="col-6 col-md-2"><label class="form-label">Store at (°C)</label><input name="storageTemp" class="form-control" inputmode="decimal" value="${p.storageTemp ?? -18}"></div>
      <div class="col-6 col-md-2"><label class="form-label">Shelf life (days)</label><input name="shelfLifeDays" class="form-control" inputmode="numeric" value="${p.shelfLifeDays ?? ''}"></div>
      <div class="col-12"><div class="form-check form-switch"><input class="form-check-input" type="checkbox" name="halal" id="pr-halal" ${p.halal ? 'checked' : ''}><label class="form-check-label" for="pr-halal">Halal certified</label></div></div>
      <div class="col-12"><div class="form-check form-switch"><input class="form-check-input" type="checkbox" name="trackStock" id="pr-track" ${p.trackStock !== false ? 'checked' : ''}><label class="form-check-label" for="pr-track">Track stock (turn off for services)</label></div></div>
      <div class="col-4 stock-f"><label class="form-label">Opening stock</label><input name="openingStock" class="form-control" inputmode="decimal" value="${p.openingStock ?? ''}"></div>
      <div class="col-4 stock-f"><label class="form-label">Minimum stock</label><input name="minStock" class="form-control" inputmode="decimal" value="${p.minStock ?? ''}"></div>
      <div class="col-4 stock-f"><label class="form-label">Current stock</label><input class="form-control" value="${fmtQty(p.stock || 0)}" disabled></div>
      <div class="col-12"><label class="form-label">Image</label><div class="d-flex align-items-center gap-2">
        <div class="thumb img-prev">${image ? `<img src="${image}" alt="" class="thumb">` : '<i class="bi bi-image"></i>'}</div>
        <input type="file" accept="image/*" class="form-control img-file"><button type="button" class="btn btn-outline-danger btn-img-rm ${image ? '' : 'd-none'}" aria-label="Remove image"><i class="bi bi-x"></i></button></div></div>
      ${product ? `<div class="col-12"><div class="form-check form-switch"><input class="form-check-input" type="checkbox" name="active" id="pr-active" ${p.active ? 'checked' : ''}><label class="form-check-label" for="pr-active">Active (available for sale)</label></div></div>` : ''}
    </div>`,
    onShown: ($m) => {
      const sync = () => $m.find('.stock-f').toggleClass('d-none', !$m.find('#pr-track').prop('checked'));
      $m.on('change', '#pr-track', sync); sync();
      $m.find('.btn-gen-bc').on('click', () => $m.find('[name=barcode]').val(generateBarcode()));
      $m.find('.btn-scan-bc').on('click', async () => {
        $m.addClass('d-none'); $('.modal-backdrop').last().addClass('d-none');
        const code = await Scanner.scan();
        $m.removeClass('d-none'); $('.modal-backdrop').first().removeClass('d-none');
        if (code) $m.find('[name=barcode]').val(code);
      });
      $m.find('.img-file').on('change', async function () {
        const f = this.files[0]; if (!f) return;
        try { image = await compressImage(f); $m.find('.img-prev').html(`<img src="${image}" alt="" class="thumb">`); $m.find('.btn-img-rm').removeClass('d-none'); } catch (e) { UI.toastError(e); }
      });
      $m.find('.btn-img-rm').on('click', function () { image = ''; $m.find('.img-prev').html('<i class="bi bi-image"></i>'); $(this).addClass('d-none'); $m.find('.img-file').val(''); });
      $m.find('[name=name]').trigger('focus');
    },
    onSubmit: async (v) => {
      if (v.salePrice === '' && !product) throw new AppError('Enter a sale price.');
      const saved = await Posting.saveProduct({ ...v, id: product?.id, image, active: product ? v.active : true });
      UI.toast(product ? 'Product updated' : 'Product added');
      return saved;
    },
  });
}

async function manageCategories() {
  const render = () => Catalog.allCategories().map((c) => {
    const n = Catalog.allProducts().filter((p) => p.categoryId === c.id).length;
    return `<div class="list-row"><div class="main"><div class="title">${esc(c.name)}</div><div class="sub">${n} product(s)</div></div>
      <button class="btn btn-sm btn-light btn-cat-edit" data-id="${esc(c.id)}" aria-label="Rename"><i class="bi bi-pencil"></i></button>
      <button class="btn btn-sm btn-light btn-cat-del" data-id="${esc(c.id)}" aria-label="Delete"><i class="bi bi-trash"></i></button></div>`;
  }).join('') || UI.emptyState('No categories yet', 'tags', '<button class="btn btn-primary btn-sm mt-3 btn-add-frozen"><i class="bi bi-snow me-1"></i>Add frozen food categories</button>');
  const m = UI.modal({ title: 'Categories', body: `<form class="input-group mb-3 cat-add"><input class="form-control" placeholder="New category name" required><button class="btn btn-primary">Add</button></form><div class="list-card cat-list">${render()}</div>` });
  const refresh = () => m.$el.find('.cat-list').html(render());
  m.$el.on('click', '.btn-add-frozen', async () => {
    try {
      const n = await Frozen.addFrozenCategories();
      UI.toast(n ? `${n} categories added` : 'Frozen food categories already exist');
      refresh();
    } catch (err) { UI.toastError(err); }
  });
  m.$el.find('.cat-add').on('submit', async (e) => {
    e.preventDefault();
    const $i = $(e.target).find('input');
    try { await Posting.saveCategory({ name: $i.val() }); $i.val(''); refresh(); } catch (err) { UI.toastError(err); }
  });
  m.$el.on('click', '.btn-cat-edit', async function () {
    const c = Catalog.category(this.dataset.id);
    const name = prompt('Category name', c.name);
    if (name === null) return;
    try { await Posting.saveCategory({ id: c.id, name }); refresh(); } catch (err) { UI.toastError(err); }
  });
  m.$el.on('click', '.btn-cat-del', async function () {
    try { await Posting.deleteCategory(this.dataset.id); refresh(); } catch (err) { UI.toastError(err); }
  });
  await m.closed;
}

async function renderList(el) {
  const $el = $(el).off();
  const canEdit = Auth.can('product.edit');
  $el.html(UI.pageHeader('Products', canEdit ? `<button class="btn btn-light btn-sm btn-cats"><i class="bi bi-tags"></i><span class="d-none d-sm-inline"> Categories</span></button><button class="btn btn-primary btn-sm btn-add"><i class="bi bi-plus-lg"></i> Add</button>` : '') + `
    <div class="filters">
      <div class="input-group flex-grow-2"><input type="search" class="form-control q" placeholder="Search name, SKU, barcode…"><button class="btn btn-outline-secondary btn-scan" aria-label="Scan"><i class="bi bi-upc-scan"></i></button></div>
      <select class="form-select f-cat"><option value="">All categories</option>${UI.options(Catalog.allCategories(), '')}</select>
      <select class="form-select f-status"><option value="active">Active</option><option value="low">Low stock</option><option value="out">Out of stock</option><option value="inactive">Inactive</option><option value="all">All</option></select>
    </div>
    <div class="small text-body-secondary mb-2 summary"></div>
    <div class="list-card list"></div>`);
  const draw = () => {
    const q = $el.find('.q').val();
    const cat = $el.find('.f-cat').val() || null;
    const f = $el.find('.f-status').val();
    const list = Catalog.searchProducts(q, { limit: Infinity, categoryId: cat, includeInactive: true }).filter((p) => {
      if (f === 'all') return true;
      if (f === 'inactive') return !p.active;
      if (!p.active) return false;
      if (f === 'low') return p.trackStock !== false && p.stock <= (p.minStock || 0);
      if (f === 'out') return p.trackStock !== false && p.stock <= 0;
      return true;
    });
    $el.find('.summary').text(`${list.length} product(s)`);
    pager($el.find('.list'), list, (p) => {
      const low = p.trackStock !== false && p.stock <= (p.minStock || 0);
      return `<button class="list-row" data-id="${esc(p.id)}">
        ${p.image ? `<img class="thumb" src="${p.image}" alt="" loading="lazy">` : UI.avatar(p.name)}
        <div class="main"><div class="title">${esc(p.name)} ${p.active ? '' : '<span class="badge text-bg-secondary">Inactive</span>'}</div>
          <div class="sub">${esc([p.sku, p.barcode, Catalog.category(p.categoryId)?.name].filter(Boolean).join(' · ') || '—')}</div></div>
        <div class="end"><div class="fw-semibold money">${money(p.salePrice)}</div>
          <div class="sub ${low ? 'text-danger fw-semibold' : ''}">${p.trackStock === false ? 'service' : `${fmtQty(p.stock)} ${esc(p.unit)}`}</div></div></button>`;
    }, 60, UI.emptyState('No products found', 'box-seam', canEdit ? '<button class="btn btn-primary btn-sm mt-3 btn-add">Add product</button>' : ''));
  };
  draw();
  $el.on('input', '.q', debounce(draw, 150));
  $el.on('change', '.f-cat, .f-status', draw);
  $el.on('click', '.btn-add', async () => { if (await editProduct()) draw(); });
  $el.on('click', '.btn-cats', async () => { await manageCategories(); renderList(el); });
  $el.on('click', '.btn-scan', async () => {
    const code = await Scanner.scan(); if (!code) return;
    const p = Catalog.findByCode(code);
    if (p) { $el.find('.q').val(code); draw(); } else if (canEdit && await UI.confirmDialog(`No product with barcode ${code}. Add a new product?`)) { if (await editProduct(null, { barcode: code })) draw(); }
    else UI.toast('No product found', 'warning');
  });
  $el.on('click', '.list-row[data-id]', async function () {
    const p = Catalog.product(this.dataset.id);
    if (!canEdit) { location.hash = `#/stock/${encodeURIComponent(p.id)}`; return; }
    productActions(p, draw);
  });
}

async function productActions(p, redraw) {
  const m = UI.modal({ title: p.name, fullscreenMobile: false,
    body: `<div class="row small mb-3">
        <div class="col-6">Sale: <b>${money(p.salePrice)}</b></div><div class="col-6">Wholesale: <b>${money(p.wholesalePrice)}</b></div>
        <div class="col-6">Cost: <b>${money(p.purchasePrice)}</b></div><div class="col-6">Stock: <b>${p.trackStock === false ? 'n/a' : fmtQty(p.stock) + ' ' + esc(p.unit)}</b></div>
        <div class="col-6">Margin: <b>${p.salePrice ? fmtNum(((p.salePrice - p.purchasePrice) / p.salePrice) * 100) + '%' : '—'}</b></div><div class="col-6">Min stock: <b>${fmtQty(p.minStock || 0)}</b></div>
        <div class="col-6">Brand: <b>${esc(p.brand || '—')}</b></div><div class="col-6">Pack: <b>${esc(p.packSize || '—')}</b></div>
        <div class="col-6">Store at: <b>${p.storageTemp ?? -18} °C</b></div><div class="col-6">Shelf life: <b>${p.shelfLifeDays ? p.shelfLifeDays + ' days' : '—'}</b></div>
        <div class="col-12">${p.halal ? '<span class="badge text-bg-success"><i class="bi bi-patch-check me-1"></i>Halal certified</span>' : '<span class="badge text-bg-secondary">Halal not marked</span>'}</div></div>
      <div class="d-grid gap-2">
        <button class="btn btn-primary btn-edit"><i class="bi bi-pencil me-1"></i>Edit product</button>
        <a class="btn btn-outline-secondary" href="#/stock/${encodeURIComponent(p.id)}"><i class="bi bi-clock-history me-1"></i>Stock ledger</a>
        ${Auth.can('stock.adjust') && p.trackStock !== false ? `<a class="btn btn-outline-secondary" href="#/stock/adjust/${encodeURIComponent(p.id)}"><i class="bi bi-sliders me-1"></i>Adjust stock</a>` : ''}
        ${Auth.can('product.delete') ? '<button class="btn btn-outline-danger btn-del"><i class="bi bi-trash me-1"></i>Delete</button>' : ''}
      </div>` });
  m.$el.find('a').on('click', () => m.close());
  m.$el.find('.btn-edit').on('click', async () => { m.close(); await m.closed; if (await editProduct(p)) redraw(); });
  m.$el.find('.btn-del').on('click', async () => {
    m.close(); await m.closed;
    if (!await UI.confirmDialog(`Delete "${p.name}"? Products with transactions are deactivated instead.`, { okLabel: 'Delete', okClass: 'btn-danger' })) return;
    try { const r = await Posting.deleteProduct(p.id); UI.toast(r === 'deleted' ? 'Product deleted' : 'Product deactivated (has transactions)'); redraw(); } catch (e) { UI.toastError(e); }
  });
}

export default {
  async render(el) { await renderList(el); },
};
