// The data layer. Everything the UI needs about categories and
// transactions goes through here — the UI never touches Dropbox or
// localStorage directly. This is the seam to extend later: new record
// types (e.g. budget goals, recurring transactions) get their own
// section in defaultData() plus get/add/update/remove functions here,
// following the same pattern as categories/transactions.
import { CONFIG } from "./config.js";
import { downloadData, uploadData } from "./dropboxApi.js";

const LOCAL_CACHE_KEY = "budget_local_cache";

let state = null;
let dirty = false;
let syncTimer = null;
const listeners = new Set();

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function defaultData() {
  return {
    schemaVersion: CONFIG.SCHEMA_VERSION,
    settings: { currency: CONFIG.CURRENCY },
    categories: [
      { id: uid(), name: "Salary", type: "income", color: "#4fb286" },
      { id: uid(), name: "Groceries", type: "expense", color: "#e0a458", monthlyLimit: null },
      { id: uid(), name: "Rent", type: "expense", color: "#c96a5a", monthlyLimit: null },
      { id: uid(), name: "Transport", type: "expense", color: "#6a93c9", monthlyLimit: null },
      { id: uid(), name: "Other", type: "expense", color: "#9a8fc9", monthlyLimit: null }
    ],
    transactions: [],
    recurring: []
  };
}

// Migrates older saved data forward. Add a new `if (data.schemaVersion < N)`
// block here whenever CONFIG.SCHEMA_VERSION is bumped, instead of
// changing what old data means.
function migrate(data) {
  if (!data.schemaVersion) data.schemaVersion = 1;
  if (data.schemaVersion < 2) {
    data.recurring = data.recurring || [];
    data.schemaVersion = 2;
  }
  return data;
}

function notify() {
  for (const fn of listeners) fn(state);
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getState() {
  return state;
}

function loadLocalCache() {
  try {
    const raw = localStorage.getItem(LOCAL_CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveLocalCache() {
  try {
    localStorage.setItem(LOCAL_CACHE_KEY, JSON.stringify(state));
  } catch {
    // ignore quota errors; Dropbox is the source of truth anyway
  }
}

// Loads from Dropbox (falling back to local cache if offline), merges
// with local cache is intentionally NOT attempted — Dropbox always wins
// on load, since last-writer-wins is simplest for a single-user app.
export async function loadFromDropbox() {
  try {
    const remote = await downloadData();
    if (remote) {
      state = migrate(remote);
    } else {
      state = defaultData();
      await uploadData(state); // seed the file so it exists next time
    }
  } catch (err) {
    const cached = loadLocalCache();
    if (cached) {
      state = cached;
      notify();
      throw new Error("Offline — showing your last synced data. " + err.message);
    }
    throw err;
  }
  saveLocalCache();
  notify();
}

function scheduleSync() {
  dirty = true;
  saveLocalCache();
  notify();
  clearTimeout(syncTimer);
  syncTimer = setTimeout(async () => {
    if (!dirty) return;
    try {
      await uploadData(state);
      dirty = false;
      notify();
    } catch {
      // stays dirty; next edit or manual retry will try again
    }
  }, 1200);
}

export function isDirty() {
  return dirty;
}

export async function forceSyncNow() {
  clearTimeout(syncTimer);
  await uploadData(state);
  dirty = false;
  notify();
}

// ---- Categories ----

export function addCategory({ name, type, color, monthlyLimit }) {
  state.categories.push({ id: uid(), name, type, color, monthlyLimit: monthlyLimit ?? null });
  scheduleSync();
}

export function updateCategory(id, patch) {
  const cat = state.categories.find(c => c.id === id);
  if (!cat) return;
  Object.assign(cat, patch);
  scheduleSync();
}

export function removeCategory(id) {
  state.categories = state.categories.filter(c => c.id !== id);
  state.transactions = state.transactions.filter(t => t.categoryId !== id);
  scheduleSync();
}

// ---- Transactions ----

export function addTransaction({ date, amount, categoryId, type, note, recurringId }) {
  state.transactions.push({
    id: uid(), date, amount: Number(amount), categoryId, type,
    note: note || "", recurringId: recurringId || null
  });
  scheduleSync();
}

export function updateTransaction(id, patch) {
  const tx = state.transactions.find(t => t.id === id);
  if (!tx) return;
  Object.assign(tx, patch);
  scheduleSync();
}

export function removeTransaction(id) {
  state.transactions = state.transactions.filter(t => t.id !== id);
  scheduleSync();
}

// ---- Recurring expenses/income ----
// A recurring item is a template ("Rent, €1350, day 1 of month"). It
// doesn't itself appear in totals — applying it for a given month
// creates a normal transaction (tagged with recurringId) that does.

export function addRecurring({ name, type, categoryId, amount, dayOfMonth }) {
  state.recurring.push({
    id: uid(), name, type, categoryId, amount: Number(amount),
    dayOfMonth: Math.min(31, Math.max(1, Number(dayOfMonth) || 1)),
    active: true
  });
  scheduleSync();
}

export function updateRecurring(id, patch) {
  const r = state.recurring.find(r => r.id === id);
  if (!r) return;
  Object.assign(r, patch);
  scheduleSync();
}

export function removeRecurring(id) {
  state.recurring = state.recurring.filter(r => r.id !== id);
  scheduleSync();
}

function dateForRecurring(item, yearMonth) {
  const [y, m] = yearMonth.split("-").map(Number);
  const lastDay = new Date(y, m, 0).getDate(); // clamp e.g. day 31 in a 30-day month
  const day = Math.min(item.dayOfMonth, lastDay);
  return `${yearMonth}-${String(day).padStart(2, "0")}`;
}

// Active recurring items that don't yet have a generated transaction
// for this month.
export function pendingRecurringForMonth(yearMonth) {
  const applied = new Set(
    state.transactions.filter(t => t.recurringId && t.date.startsWith(yearMonth)).map(t => t.recurringId)
  );
  return state.recurring.filter(r => r.active !== false && !applied.has(r.id));
}

export function applyRecurring(id, yearMonth) {
  const item = state.recurring.find(r => r.id === id);
  if (!item) return;
  addTransaction({
    date: dateForRecurring(item, yearMonth),
    amount: item.amount,
    categoryId: item.categoryId,
    type: item.type,
    note: item.name,
    recurringId: item.id
  });
}

export function applyAllRecurring(yearMonth) {
  for (const item of pendingRecurringForMonth(yearMonth)) {
    applyRecurring(item.id, yearMonth);
  }
}

// ---- Derived helpers ----

export function transactionsForMonth(yearMonth) {
  return state.transactions.filter(t => t.date.startsWith(yearMonth));
}

export function monthlyTotals(yearMonth) {
  const txs = transactionsForMonth(yearMonth);
  const income = txs.filter(t => t.type === "income").reduce((s, t) => s + t.amount, 0);
  const expense = txs.filter(t => t.type === "expense").reduce((s, t) => s + t.amount, 0);
  return { income, expense, balance: income - expense };
}

export function categoryBreakdown(yearMonth, type = "expense") {
  const txs = transactionsForMonth(yearMonth).filter(t => t.type === type);
  const byCategory = new Map();
  for (const t of txs) {
    byCategory.set(t.categoryId, (byCategory.get(t.categoryId) || 0) + t.amount);
  }
  return [...byCategory.entries()]
    .map(([categoryId, total]) => ({
      category: state.categories.find(c => c.id === categoryId) || { name: "Uncategorized", color: "#888" },
      total
    }))
    .sort((a, b) => b.total - a.total);
}
