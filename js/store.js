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
    // trackingStartMonth is a hard floor: nothing before it is ever
    // treated as pending, no matter what a standard expense's own
    // createdMonth says. Defaults to the month you started using this,
    // and you can move it in the Standard Expenses dialog.
    settings: { currency: CONFIG.CURRENCY, trackingStartMonth: new Date().toISOString().slice(0, 7) },
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
    standardExpenses: [],
    // Which standard expenses have been marked paid, per month. Purely
    // a checklist — it does NOT gate whether the amount counts toward
    // the month's totals (it always does); it only tracks whether
    // you've actually paid it yet.
    standardPayments: []
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
    // A global floor for carry-forward, so bills you'd already set up
    // before this feature existed don't suddenly generate years of
    // phantom "pending" months. Anchored to right now, i.e. nothing
    // before today counts as pending — adjustable afterward.
    if (!data.settings) data.settings = { currency: CONFIG.CURRENCY };
    if (!data.settings.trackingStartMonth) {
      data.settings.trackingStartMonth = new Date().toISOString().slice(0, 7);
    }
    data.schemaVersion = 6;
  }
  return data;
}

function effectiveStart(item) {
  const floor = state.settings.trackingStartMonth;
  if (!item.createdMonth) return floor;
  return item.createdMonth > floor ? item.createdMonth : floor;
}

export function getTrackingStartMonth() {
  return state.settings.trackingStartMonth;
}

export function setTrackingStartMonth(yearMonth) {
  state.settings.trackingStartMonth = yearMonth;
  scheduleSync();
}

function monthsBetween(startYM, endYMExclusive) {
  // Every "YYYY-MM" from startYM up to (but not including) endYMExclusive.
  const months = [];
  let [y, m] = startYM.split("-").map(Number);
  const [endY, endM] = endYMExclusive.split("-").map(Number);
  while (y < endY || (y === endY && m < endM)) {
    months.push(`${y}-${String(m).padStart(2, "0")}`);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return months;
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

export function addTransaction({ date, amount, categoryId, type, note, dueDate }) {
  state.transactions.push({
    id: uid(), date, amount: Number(amount), categoryId, type,
    note: note || "", dueDate: dueDate || null
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
// Standard Expenses dialog. Every month it shows up automatically and
// its full amount always counts toward that month's totals — paid/
// not-paid is just a checklist of whether you've actually paid it,
// it doesn't switch the spending on or off.

export function addStandardExpense({ name, amount, categoryId, dueDay }) {
  state.standardExpenses.push({
    id: uid(), name, amount: Number(amount), categoryId: categoryId || null,
    dueDay: dueDay ? Math.min(31, Math.max(1, Number(dueDay))) : null,
    createdMonth: new Date().toISOString().slice(0, 7)
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
  state.standardPayments = state.standardPayments.filter(p => p.standardExpenseId !== id);
  scheduleSync();
}

function isPaidFor(itemId, yearMonth) {
  return state.standardPayments.some(p => p.standardExpenseId === itemId && p.yearMonth === yearMonth);
}

// Every standard expense that exists as of this month (i.e. set up in
// this month or earlier), each annotated with whether it's been
// marked paid FOR THIS MONTH specifically.
export function standardExpensesForMonth(yearMonth) {
  return state.standardExpenses
    .filter(item => effectiveStart(item) <= yearMonth)
    .map(item => ({ ...item, paid: isPaidFor(item.id, yearMonth) }));
}

// Bills that were still unpaid in some earlier month and so follow you
// forward — each tagged with the month they originally came from, e.g.
// "Pending from September". Stays visible, under its original tag,
// every month until it's finally marked paid.
export function pendingCarryForwardForMonth(yearMonth) {
  const rows = [];
  for (const item of state.standardExpenses) {
    const start = effectiveStart(item);
    if (start >= yearMonth) continue;
    for (const m of monthsBetween(start, yearMonth)) {
      if (!isPaidFor(item.id, m)) {
        rows.push({ ...item, originMonth: m, paid: false, key: `${item.id}_${m}` });
      }
    }
  }
  return rows.sort((a, b) => a.originMonth.localeCompare(b.originMonth));
}

export function setStandardExpensePaid(id, yearMonth, paid) {
  const already = state.standardPayments.find(p => p.standardExpenseId === id && p.yearMonth === yearMonth);
  if (paid && !already) {
    state.standardPayments.push({ id: uid(), standardExpenseId: id, yearMonth });
  } else if (!paid && already) {
    state.standardPayments = state.standardPayments.filter(p => p.id !== already.id);
  } else {
    return;
  }
  scheduleSync();
}

// total/paid/unpaid cover only THIS month's own bills (this is what
// counts toward the month's overall Expenses total). outstanding is
// the separate, older backlog carried forward from previous months —
// deliberately not added into total/expense figures, since it was
// already counted in the month it originated, to avoid double-counting.
export function standardExpenseTotals(yearMonth) {
  const items = standardExpensesForMonth(yearMonth);
  const total = items.reduce((s, i) => s + i.amount, 0);
  const paid = items.filter(i => i.paid).reduce((s, i) => s + i.amount, 0);
  const outstanding = pendingCarryForwardForMonth(yearMonth).reduce((s, i) => s + i.amount, 0);
  return { total, paid, unpaid: total - paid, outstanding };
}

// ---- Derived helpers ----

export function transactionsForMonth(yearMonth) {
  return state.transactions.filter(t => t.date.startsWith(yearMonth));
}

// Overall totals combine the standard (fixed) expenses for the month
// with whatever ad-hoc transactions you've logged — a standard expense
// always counts, whether or not it's been marked paid yet.
export function monthlyTotals(yearMonth) {
  const txs = transactionsForMonth(yearMonth);
  const income = txs.filter(t => t.type === "income").reduce((s, t) => s + t.amount, 0);
  const adhocExpense = txs.filter(t => t.type === "expense").reduce((s, t) => s + t.amount, 0);
  const standardExpense = standardExpenseTotals(yearMonth).total;
  const expense = adhocExpense + standardExpense;
  return { income, expense, balance: income - expense };
}

export function categoryBreakdown(yearMonth, type = "expense") {
  const txs = transactionsForMonth(yearMonth).filter(t => t.type === type);
  const byCategory = new Map();
  for (const t of txs) {
    byCategory.set(t.categoryId, (byCategory.get(t.categoryId) || 0) + t.amount);
  }
  if (type === "expense") {
    for (const item of standardExpensesForMonth(yearMonth)) {
      byCategory.set(item.categoryId, (byCategory.get(item.categoryId) || 0) + item.amount);
    }
  }
  return [...byCategory.entries()]
    .map(([categoryId, total]) => ({
      category: state.categories.find(c => c.id === categoryId) || { name: "Uncategorized", color: "#888" },
      total
    }))
    .sort((a, b) => b.total - a.total);
}
