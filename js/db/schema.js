// IndexedDB schema definition and migrations.
import { CONFIG } from '../config.js';

export const DB_NAME = `${CONFIG.APP_ID}_pos`;
// Database name used by older builds (shared with other apps on the same origin). Never modified; only read on import.
export const LEGACY_DB_NAME = 'saleapp_pos';
// Version 2 has the same stores as version 1. It exists because a build of another project was briefly deployed
// here and upgraded phones' databases to v2; opening with v1 would then fail with a VersionError.
// Version 3 adds the frozen-food stores: production/expiry batches and freezer temperature logs.
// Never lower this number: phones that opened a newer build keep the higher version.
export const DB_VERSION = 3;

// Stores that make up the business data (included in backups).
export const DATA_STORES = [
  'categories', 'products', 'customers', 'suppliers', 'accounts',
  'sales', 'saleItems', 'purchases', 'purchaseItems', 'saleReturns', 'purchaseReturns',
  'vouchers', 'entries', 'stockMoves', 'adjustments', 'holds', 'auditLog', 'meta',
  'batches', 'coldLogs',
];

const STORES = {
  meta: { keyPath: 'key', indexes: {} },
  categories: { indexes: { nameLc: 'nameLc' } },
  products: { indexes: { nameLc: 'nameLc', barcode: 'barcode', sku: 'sku', categoryId: 'categoryId' } },
  customers: { indexes: { nameLc: 'nameLc', phone: 'phone' } },
  suppliers: { indexes: { nameLc: 'nameLc', phone: 'phone' } },
  accounts: { indexes: { type: 'type' } },
  sales: { indexes: { number: ['number', true], date: 'date', customerId: 'customerId' } },
  saleItems: { indexes: { saleId: 'saleId', productId: 'productId', date: 'date' } },
  purchases: { indexes: { number: ['number', true], date: 'date', supplierId: 'supplierId' } },
  purchaseItems: { indexes: { purchaseId: 'purchaseId', productId: 'productId', date: 'date' } },
  saleReturns: { indexes: { number: ['number', true], date: 'date', saleId: 'saleId', customerId: 'customerId' } },
  purchaseReturns: { indexes: { number: ['number', true], date: 'date', purchaseId: 'purchaseId', supplierId: 'supplierId' } },
  vouchers: { indexes: { number: ['number', true], date: 'date', type: 'type' } },
  entries: { indexes: { accountId: 'accountId', txnId: 'txnId', date: 'date', acctDate: [['accountId', 'date'], false] } },
  stockMoves: { indexes: { productId: 'productId', refId: 'refId', date: 'date', prodDate: [['productId', 'date'], false] } },
  adjustments: { indexes: { number: ['number', true], date: 'date' } },
  holds: { indexes: { createdAt: 'createdAt' } },
  auditLog: { indexes: { at: 'at' } },
};

export const SYSTEM_ACCOUNTS = [
  { id: 'cash', name: 'Cash in Hand', type: 'cash' },
  { id: 'sales', name: 'Sales', type: 'income' },
  { id: 'sales_returns', name: 'Sales Returns', type: 'income' },
  { id: 'purchases', name: 'Purchases', type: 'expense' },
  { id: 'purchase_returns', name: 'Purchase Returns', type: 'expense' },
  { id: 'tax', name: 'Sales Tax Payable', type: 'liability' },
  { id: 'equity', name: 'Opening Balance Equity', type: 'equity' },
  { id: 'income', name: 'Other Income', type: 'income' },
  { id: 'expense', name: 'General Expenses', type: 'expense' },
];

// Stores added in version 3. Created only if missing, so a fresh install and an upgrade end up identical.
const STORES_V3 = {
  batches: { indexes: { productId: 'productId', expiryDate: 'expiryDate', status: 'status' } },
  coldLogs: { indexes: { at: 'at', unit: 'unit' } },
};

export function upgrade(db, oldVersion, t) {
  if (oldVersion < 1) {
    for (const [name, def] of Object.entries(STORES)) {
      const os = db.createObjectStore(name, { keyPath: def.keyPath || 'id' });
      for (const [idx, spec] of Object.entries(def.indexes)) {
        const [keyPath, unique] = Array.isArray(spec) ? spec : [spec, false];
        os.createIndex(idx, keyPath, { unique: !!unique });
      }
    }
    const now = new Date().toISOString();
    const acc = t.objectStore('accounts');
    for (const a of SYSTEM_ACCOUNTS) acc.put({ ...a, system: true, active: 1, createdAt: now, updatedAt: now });
    t.objectStore('meta').put({ key: 'schemaVersion', value: 1 });
    t.objectStore('meta').put({ key: 'createdAt', value: now });
  }
  // v2: no structural change (see DB_VERSION). Extra stores left by that other build are ignored.
  if (oldVersion < 3) {
    for (const [name, def] of Object.entries(STORES_V3)) {
      if (db.objectStoreNames.contains(name)) continue;
      const os = db.createObjectStore(name, { keyPath: 'id' });
      for (const [idx, keyPath] of Object.entries(def.indexes)) os.createIndex(idx, keyPath);
    }
  }
  // Future migrations: if (oldVersion < 4) { ... }
}
