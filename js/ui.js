// Rendering. Reads from store.js, never writes to Dropbox directly —
// user actions call store.js functions, which handle syncing.
import { CONFIG } from "./config.js";
import * as store from "./store.js";
import { renderDonut } from "./charts.js";

const fmt = new Intl.NumberFormat(CONFIG.LOCALE, { style: "currency", currency: CONFIG.CURRENCY });
const dfmt = new Intl.DateTimeFormat(CONFIG.LOCALE, { day: "numeric", month: "short" });

let currentMonth = new Date().toISOString().slice(0, 7); // "YYYY-MM"

const el = sel => document.querySelector(sel);
const monthLabel = ym => new Date(ym + "-02").toLocaleDateString(CONFIG.LOCALE, { month: "long", year: "numeric" });

export function initUI() {
  el("#prevMonth").addEventListener("click", () => shiftMonth(-1));
  el("#nextMonth").addEventListener("click", () => shiftMonth(1));
  el("#txForm").addEventListener("submit", onAddTransaction);
  el("#txType").addEventListener("change", populateCategoryOptions);
  el("#manageCategoriesBtn").addEventListener("click", () => el("#categoriesDialog").showModal());
  el("#categoryForm").addEventListener("submit", onAddCategory);
  el("#closeCategoriesBtn").addEventListener("click", () => el("#categoriesDialog").close());

  el("#manageRecurringBtn").addEventListener("click", () => {
    populateRecurringCategoryOptions();
    el("#recurringDialog").showModal();
  });
  el("#recurringType").addEventListener("change", populateRecurringCategoryOptions);
  el("#recurringForm").addEventListener("submit", onAddRecurring);
  el("#closeRecurringBtn").addEventListener("click", () => el("#recurringDialog").close());

  store.subscribe(render);
  render();
}

function shiftMonth(delta) {
  const [y, m] = currentMonth.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  currentMonth = d.toISOString().slice(0, 7);
  render();
}

function populateCategoryOptions() {
  const state = store.getState();
  if (!state) return;
  const type = el("#txType").value;
  const select = el("#txCategory");
  select.innerHTML = state.categories
    .filter(c => c.type === type)
    .map(c => `<option value="${c.id}">${c.name}</option>`)
    .join("");
}

function onAddTransaction(e) {
  e.preventDefault();
  const date = el("#txDate").value || new Date().toISOString().slice(0, 10);
  const amount = parseFloat(el("#txAmount").value);
  const categoryId = el("#txCategory").value;
  const type = el("#txType").value;
  const note = el("#txNote").value.trim();
  if (!amount || amount <= 0 || !categoryId) return;

  store.addTransaction({ date, amount, categoryId, type, note });
  e.target.reset();
  el("#txDate").value = new Date().toISOString().slice(0, 10);
  populateCategoryOptions();
}

function onAddCategory(e) {
  e.preventDefault();
  const name = el("#catName").value.trim();
  const type = el("#catType").value;
  const color = el("#catColor").value;
  if (!name) return;
  store.addCategory({ name, type, color });
  e.target.reset();
  renderCategoryList();
  populateCategoryOptions();
}

function populateRecurringCategoryOptions() {
  const state = store.getState();
  if (!state) return;
  const type = el("#recurringType").value;
  const select = el("#recurringCategory");
  select.innerHTML = state.categories
    .filter(c => c.type === type)
    .map(c => `<option value="${c.id}">${c.name}</option>`)
    .join("");
}

function onAddRecurring(e) {
  e.preventDefault();
  const name = el("#recurringName").value.trim();
  const type = el("#recurringType").value;
  const categoryId = el("#recurringCategory").value;
  const amount = parseFloat(el("#recurringAmount").value);
  const dayOfMonth = parseInt(el("#recurringDay").value, 10);
  if (!name || !amount || amount <= 0 || !categoryId) return;

  store.addRecurring({ name, type, categoryId, amount, dayOfMonth });
  e.target.reset();
  el("#recurringDay").value = "1";
  populateRecurringCategoryOptions();
  renderRecurringList();
}

function renderRecurringList() {
  const state = store.getState();
  el("#recurringList").innerHTML = state.recurring.map(r => {
    const cat = state.categories.find(c => c.id === r.categoryId);
    return `
      <li class="category-row">
        <span class="swatch" style="background:${cat ? cat.color : "#888"}"></span>
        <span class="cat-name">${r.name} — ${fmt.format(r.amount)} <span class="cat-type">day ${r.dayOfMonth}</span></span>
        <button data-remove-recurring="${r.id}" class="icon-btn" aria-label="Remove ${r.name}">×</button>
      </li>`;
  }).join("") || `<li class="empty">No recurring items yet</li>`;

  el("#recurringList").querySelectorAll("[data-remove-recurring]").forEach(btn => {
    btn.addEventListener("click", () => {
      store.removeRecurring(btn.dataset.removeRecurring);
      renderRecurringList();
    });
  });
}

function renderRecurringBanner() {
  const pending = store.pendingRecurringForMonth(currentMonth);
  const banner = el("#recurringBanner");
  if (pending.length === 0) {
    banner.hidden = true;
    banner.innerHTML = "";
    return;
  }
  banner.hidden = false;
  banner.innerHTML = `
    <div class="recurring-banner-head">
      <span>${pending.length} recurring item${pending.length > 1 ? "s" : ""} not added yet this month</span>
      <button class="btn secondary" id="applyAllRecurringBtn">Add all</button>
    </div>
    <ul class="recurring-chip-list">
      ${pending.map(r => `<li><button class="chip" data-apply-recurring="${r.id}">+ ${r.name} (${fmt.format(r.amount)})</button></li>`).join("")}
    </ul>`;

  el("#applyAllRecurringBtn").addEventListener("click", () => store.applyAllRecurring(currentMonth));
  banner.querySelectorAll("[data-apply-recurring]").forEach(btn => {
    btn.addEventListener("click", () => store.applyRecurring(btn.dataset.applyRecurring, currentMonth));
  });
}

function renderCategoryList() {
  const state = store.getState();
  el("#categoryList").innerHTML = state.categories.map(c => `
    <li class="category-row">
      <span class="swatch" style="background:${c.color}"></span>
      <span class="cat-name">${c.name}</span>
      <span class="cat-type">${c.type}</span>
      <button data-remove-cat="${c.id}" class="icon-btn" aria-label="Remove ${c.name}">×</button>
    </li>`).join("");

  el("#categoryList").querySelectorAll("[data-remove-cat]").forEach(btn => {
    btn.addEventListener("click", () => {
      store.removeCategory(btn.dataset.removeCat);
      renderCategoryList();
    });
  });
}

function render() {
  const state = store.getState();
  if (!state) return;

  el("#monthLabel").textContent = monthLabel(currentMonth);
  renderRecurringBanner();

  const totals = store.monthlyTotals(currentMonth);
  el("#totalIncome").textContent = fmt.format(totals.income);
  el("#totalExpense").textContent = fmt.format(totals.expense);
  el("#totalBalance").textContent = fmt.format(totals.balance);
  el("#totalBalance").classList.toggle("negative", totals.balance < 0);

  const breakdown = store.categoryBreakdown(currentMonth, "expense");
  renderDonut(
    el("#breakdownDonut"),
    breakdown.map(b => ({ label: b.category.name, value: b.total, color: b.category.color })),
    "Spent",
    fmt.format(totals.expense)
  );
  el("#breakdownLegend").innerHTML = breakdown.map(b => `
    <li><span class="swatch" style="background:${b.category.color}"></span>
      <span>${b.category.name}</span><span class="legend-amount">${fmt.format(b.total)}</span></li>
  `).join("") || `<li class="empty">No expenses logged yet this month</li>`;

  const txs = store.transactionsForMonth(currentMonth).slice().sort((a, b) => b.date.localeCompare(a.date));
  el("#txList").innerHTML = txs.map(t => {
    const cat = state.categories.find(c => c.id === t.categoryId);
    const sign = t.type === "income" ? "+" : "−";
    return `
      <li class="tx-row" data-tx="${t.id}">
        <span class="swatch" style="background:${cat ? cat.color : "#888"}"></span>
        <span class="tx-main">
          <span class="tx-cat">${cat ? cat.name : "Uncategorized"}</span>
          <span class="tx-note">${t.note || ""}</span>
        </span>
        <span class="tx-date">${dfmt.format(new Date(t.date))}</span>
        <span class="tx-amount ${t.type}">${sign}${fmt.format(t.amount)}</span>
        <button class="icon-btn" data-remove-tx="${t.id}" aria-label="Delete transaction">×</button>
      </li>`;
  }).join("") || `<li class="empty">No transactions this month yet</li>`;

  el("#txList").querySelectorAll("[data-remove-tx]").forEach(btn => {
    btn.addEventListener("click", () => store.removeTransaction(btn.dataset.removeTx));
  });

  el("#syncStatus").textContent = store.isDirty() ? "Syncing…" : "Synced";
  el("#syncStatus").classList.toggle("dirty", store.isDirty());

  populateCategoryOptions();
  renderCategoryList();
  renderRecurringList();
}
