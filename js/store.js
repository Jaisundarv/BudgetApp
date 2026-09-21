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
    // Fixed monthly bills (rent, electricity, insurance...). These are
    // deliberately NOT categories — they're a small fixed list that
    // shows up automatically every month with a paid/not-paid state,
    // separate from the ad-hoc transactions you log and categorize
    // yourself. A category assignment is optional, only so a paid bill
    // can still show up correctly in the category breakdown chart.
    standardExpenses: []
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
  if (data.schemaVersion < 3) {
    // Early "recurring" concept (dropped before real use) becomes the
    // standing bills list, minus the day-of-month/apply-button model.
    data.standardExpenses = (data.recurring || []).map(r => ({
      id: r.id, name: r.name, amount: r.amount, categoryId: r.categoryId ?? null
    }));
    delete data.recurring;
    data.schemaVersion = 3;
  }
  if (!data.standardExpenses) data.standardExpenses = [];
  if (data.schemaVersion < 4) {
    // Paid status used to be tracked by creating a real transaction,
    // which meant unpaid bills silently didn't count toward the
    // month's totals. Now it's tracked separately and always counts.
    data.standardPayments = [];
    const keep = [];
    for (const t of data.transactions) {
      if (t.standardExpenseId) {
        data.standardPayments.push({
          id: uid(), standardExpenseId: t.standardExpenseId, yearMonth: t.date.slice(0, 7)
        });
      } else {
        keep.push(t);
      }
    }
    data.transactions = keep;
    data.schemaVersion = 4;
  }
  if (!data.standardPayments) data.standardPayments = [];
  if (data.schemaVersion < 5) {
    for (const item of data.standardExpenses) {
      if (item.createdMonth === undefined) item.createdMonth = null;
    }
    data.schemaVersion = 5;
  }
  if (data.schemaVersion < 6) {
    if (!data.settings) data.settings = { currency: CONFIG.CURRENCY };
    data.schemaVersion = 6;
  }
  if (data.schemaVersion < 7) {
    // Rolled back to the simpler model: "paid" is just whether a
    // transaction has been added for that bill this month, via the
    // checkbox. Convert any standalone paid-markers from the
    // carry-forward experiment into real transactions so nothing is
    // lost, then drop the now-unused fields' effects.
    for (const p of data.standardPayments || []) {
      const item = data.standardExpenses.find(s => s.id === p.standardExpenseId);
      if (!item) continue;
      const already = data.transactions.some(t => t.standardExpenseId === item.id && t.date.startsWith(p.yearMonth));
      if (!already) {
        data.transactions.push({
          id: uid(), date: `${p.yearMonth}-01`, amount: item.amount, categoryId: item.categoryId,
          type: "expense", note: item.name, standardExpenseId: item.id, dueDate: null
        });
      }
    }
    data.standardPayments = [];
    data.schemaVersion = 7;
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
      state = migrate(cached);
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

export function addTransaction({ date, amount, categoryId, type, note, dueDate, standardExpenseId }) {
  state.transactions.push({
    id: uid(), date, amount: Number(amount), categoryId, type,
    note: note || "", dueDate: dueDate || null, standardExpenseId: standardExpenseId || null
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

// ---- Standard (fixed monthly) expenses ----
// A standard expense is a bill whose amount doesn't change month to
// month — rent, electricity, water, insurance. The list itself
// (name + amount + optional category) is managed once, in the
// Standard Expenses dialog. Every month it shows up automatically
// with a checkbox; checking it adds that amount as a transaction for
// the current month (so it counts toward totals), unchecking removes
// that transaction again.

export function addStandardExpense({ name, amount, categoryId, dueDay }) {
  state.standardExpenses.push({
    id: uid(), name, amount: Number(amount), categoryId: categoryId || null,
    dueDay: dueDay ? Math.min(31, Math.max(1, Number(dueDay))) : null
  });
  scheduleSync();
}

export function updateStandardExpense(id, patch) {
  const item = state.standardExpenses.find(s => s.id === id);
  if (!item) return;
  Object.assign(item, patch);
  scheduleSync();
}

export function removeStandardExpense(id) {
  state.standardExpenses = state.standardExpenses.filter(s => s.id !== id);
  scheduleSync();
}

// Every standard expense, annotated with whether it's already been
// added (checked) for this specific month.
export function standardExpensesForMonth(yearMonth) {
  return state.standardExpenses.map(item => {
    const tx = state.transactions.find(t => t.standardExpenseId === item.id && t.date.startsWith(yearMonth));
    return { ...item, paid: !!tx, transactionId: tx ? tx.id : null };
  });
}

export function setStandardExpensePaid(id, yearMonth, paid) {
  const item = state.standardExpenses.find(s => s.id === id);
  if (!item) return;
  const existing = state.transactions.find(t => t.standardExpenseId === id && t.date.startsWith(yearMonth));

  if (paid && !existing) {
    const today = new Date().toISOString().slice(0, 10);
    const date = today.startsWith(yearMonth) ? today : `${yearMonth}-01`;
    addTransaction({
      date, amount: item.amount, categoryId: item.categoryId, type: "expense",
      note: item.name, standardExpenseId: item.id
    });
  } else if (!paid && existing) {
    removeTransaction(existing.id);
  }
}

export function standardExpenseTotals(yearMonth) {
  const items = standardExpensesForMonth(yearMonth);
  const total = items.reduce((s, i) => s + i.amount, 0);
  const paid = items.filter(i => i.paid).reduce((s, i) => s + i.amount, 0);
  return { total, paid, unpaid: total - paid };
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
