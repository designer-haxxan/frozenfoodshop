// Frozen-food records: production/expiry batches and freezer temperature readings.
// These are informational records for food safety. They do not change stock quantities or accounts,
// which stay in the posting engine (stock moves and ledger entries).
import * as idb from '../db/idb.js';
import { uuid, nowISO, today, clean, lc, num, round2, AppError } from '../core/utils.js';
import * as Auth from './auth.js';
import * as Catalog from './catalog.js';

export const FREEZER_LIMIT_C = -18;   // Frozen food is kept at -18 °C or colder.
export const EXPIRY_WARN_DAYS = 7;

// Starter categories for a frozen-food shop (added on request; existing names are skipped).
export const FROZEN_CATEGORIES = [
  'Chicken', 'Nuggets & Fingers', 'Kababs & Patties', 'Samosas & Rolls', 'Parathas & Rotis',
  'Fries & Potato', 'Seafood', 'Vegetables', 'Ice Cream & Desserts', 'Ready Meals', 'Packaging & Supplies',
];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const daysBetween = (from, to) => Math.round((Date.parse(to + 'T00:00:00') - Date.parse(from + 'T00:00:00')) / 86400000);

// 'expired' | 'soon' | 'ok' | 'closed' for a batch, relative to a date (defaults to today).
export function expiryStatus(batch, on = today()) {
  if (batch.status === 'closed') return 'closed';
  const left = daysBetween(on, batch.expiryDate);
  if (left < 0) return 'expired';
  if (left <= EXPIRY_WARN_DAYS) return 'soon';
  return 'ok';
}

// 'ok' when at or below the limit, otherwise 'warn'.
export const tempStatus = (tempC, limit = FREEZER_LIMIT_C) => (tempC <= limit ? 'ok' : 'warn');

// Batches and readings, newest first.
export async function listBatches() {
  const rows = await idb.getAll('batches');
  return rows.sort((a, b) => (a.expiryDate || '').localeCompare(b.expiryDate || ''));
}
export async function listColdLogs() {
  const rows = await idb.getAll('coldLogs');
  return rows.sort((a, b) => b.at.localeCompare(a.at));
}

export async function saveBatch(data) {
  Auth.require('stock.adjust');
  const product = Catalog.product(data.productId);
  if (!product) throw new AppError('Choose a product for this batch.');
  const lotNo = clean(data.lotNo, 60);
  if (!lotNo) throw new AppError('Enter the lot / batch number from the packet or supplier.');
  const mfgDate = data.mfgDate || '';
  const expiryDate = data.expiryDate || '';
  if (!DATE_RE.test(expiryDate)) throw new AppError('Enter the expiry date.');
  if (mfgDate && !DATE_RE.test(mfgDate)) throw new AppError('Production date is not a valid date.');
  if (mfgDate && mfgDate > expiryDate) throw new AppError('Expiry date must be after the production date.');
  const qty = round2(num(data.qty));
  if (qty < 0) throw new AppError('Quantity cannot be negative.');
  const id = data.id || uuid();
  const now = nowISO();
  return idb.write(['batches', 'auditLog'], async (t) => {
    const old = data.id ? await t.get('batches', id) : null;
    if (data.id && !old) throw new AppError('Batch not found.');
    const rec = {
      ...(old || { createdAt: now, status: 'open' }), id, productId: product.id, productName: product.name,
      lotNo, mfgDate, expiryDate, qty, note: clean(data.note, 300), updatedAt: now,
    };
    await t.put('batches', rec);
    await audit(t, old ? 'update_batch' : 'create_batch', { product: product.name, lotNo });
    notify();
    return rec;
  });
}

// Mark a batch as sold out / disposed (status 'closed') or open it again.
export async function setBatchStatus(id, status) {
  Auth.require('stock.adjust');
  return idb.write(['batches', 'auditLog'], async (t) => {
    const b = await t.get('batches', id);
    if (!b) throw new AppError('Batch not found.');
    b.status = status === 'closed' ? 'closed' : 'open';
    b.updatedAt = nowISO();
    await t.put('batches', b);
    await audit(t, status === 'closed' ? 'close_batch' : 'reopen_batch', { product: b.productName, lotNo: b.lotNo });
    notify();
    return b;
  });
}

export async function deleteBatch(id) {
  Auth.require('stock.adjust');
  return idb.write(['batches', 'auditLog'], async (t) => {
    const b = await t.get('batches', id);
    if (!b) return;
    await t.delete('batches', id);
    await audit(t, 'delete_batch', { product: b.productName, lotNo: b.lotNo });
    notify();
  });
}

export async function saveColdReading(data) {
  Auth.require('stock.adjust');
  const unit = clean(data.unit, 60);
  if (!unit) throw new AppError('Name the freezer or cold room (for example "Freezer 1").');
  if (data.tempC === '' || data.tempC === null || data.tempC === undefined || !Number.isFinite(Number(data.tempC))) {
    throw new AppError('Enter the temperature in °C.');
  }
  const tempC = Number(data.tempC);
  if (tempC < -60 || tempC > 20) throw new AppError('Temperature must be between -60 and 20 °C. Check the reading.');
  const rec = { id: uuid(), at: nowISO(), unit, tempC: round2(tempC), note: clean(data.note, 200), userName: Auth.user()?.name || '' };
  return idb.write(['coldLogs', 'auditLog'], async (t) => {
    await t.add('coldLogs', rec);
    await audit(t, 'cold_reading', { unit, tempC: rec.tempC });
    notify();
    return rec;
  });
}

export async function deleteColdReading(id) {
  Auth.require('stock.adjust');
  return idb.write(['coldLogs', 'auditLog'], async (t) => {
    await t.delete('coldLogs', id);
    await audit(t, 'delete_cold_reading', { id });
    notify();
  });
}

// Latest reading per freezer unit (the newest log entry for each unit).
export function latestByUnit(logs) {
  const map = new Map();
  for (const l of logs) if (!map.has(l.unit)) map.set(l.unit, l);
  return [...map.values()];
}

// Adds the starter frozen-food categories. Returns how many were created.
export async function addFrozenCategories() {
  Auth.require('product.edit');
  const existing = new Set(Catalog.allCategories().map((c) => lc(c.name)));
  const now = nowISO();
  const fresh = FROZEN_CATEGORIES.filter((n) => !existing.has(lc(n)));
  if (!fresh.length) return 0;
  await idb.write(['categories'], async (t) => {
    for (const name of fresh) await t.add('categories', { id: uuid(), name, nameLc: lc(name), createdAt: now, updatedAt: now });
  });
  await Catalog.refreshCategories();
  notify();
  return fresh.length;
}

async function audit(t, action, details = {}) {
  const u = Auth.user();
  await t.add('auditLog', { id: uuid(), at: nowISO(), userId: u?.id || null, userName: u?.name || '', action, details });
}

const notify = () => document.dispatchEvent(new CustomEvent('data:changed'));
