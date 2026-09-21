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
function ordinal(n) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export function initUI() {
  el("#prevMonth").addEventListener("click", () => shiftMonth(-1));
  el("#nextMonth").addEventListener("click", () => shiftMonth(1));
  el("#txForm").addEventListener("submit", onAddTransaction);
  el("#txType").addEventListener("change", populateCategoryOptions);
  el("#manageCategoriesBtn").addEventListener("click", () => el("#categoriesDialog").showModal());
  el("#categoryForm").addEventListener("submit", onAddCategory);
  el("#closeCategoriesBtn").addEventListener("click", () => el("#categoriesDialog").close());

  el("#manageStandardBtn").addEventListener("click", () => {
    populateStandardCategoryOptions();
    el("#standardDialog").showModal();
  });
  el("#standardForm").addEventListener("submit", onAddStandardExpense);
  el("#cancelStandardEditBtn").addEventListener("click", cancelStandardEdit);
  el("#closeStandardBtn").addEventListener("click", () => el("#standardDialog").close());

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
  const dueDate = el("#txDueDate").value || null;
  if (!amount || amount <= 0 || !categoryId) return;

  store.addTransaction({ date, amount, categoryId, type, note, dueDate });
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

function populateStandardCategoryOptions() {
  const state = store.getState();
  if (!state) return;
  const select = el("#standardCategory");
  select.innerHTML = `<option value="">No category</option>` + state.categories
    .filter(c => c.type === "expense")
    .map(c => `<option value="${c.id}">${c.name}</option>`)
    .join("");
}

let editingStandardId = null;

function onAddStandardExpense(e) {
  e.preventDefault();
  const name = el("#standardName").value.trim();
  const amount = parseFloat(el("#standardAmount").value);
  const categoryId = el("#standardCategory").value || null;
  const dueDayRaw = el("#standardDueDay").value;
  const dueDay = dueDayRaw ? parseInt(dueDayRaw, 10) : null;
  if (!name || !amount || amount <= 0) return;

  if (editingStandardId) {
    store.updateStandardExpense(editingStandardId, { name, amount, categoryId, dueDay });
  } else {
    store.addStandardExpense({ name, amount, categoryId, dueDay });
  }
  cancelStandardEdit();
  renderStandardManageList();
}

function startStandardEdit(item) {
  editingStandardId = item.id;
  el("#standardName").value = item.name;
  el("#standardAmount").value = item.amount;
  el("#standardCategory").value = item.categoryId || "";
  el("#standardDueDay").value = item.dueDay || "";
  el("#standardSubmitBtn").textContent = "Save changes";
  el("#cancelStandardEditBtn").hidden = false;
  el("#standardName").focus();
}

function cancelStandardEdit() {
  editingStandardId = null;
  el("#standardForm").reset();
  el("#standardSubmitBtn").textContent = "Add standard expense";
  el("#cancelStandardEditBtn").hidden = true;
}

function renderStandardManageList() {
  const state = store.getState();
  el("#standardManageList").innerHTML = state.standardExpenses.map(s => {
    const cat = state.categories.find(c => c.id === s.categoryId);
    return `
      <li class="category-row">
        <span class="swatch" style="background:${cat ? cat.color : "#888"}"></span>
        <span class="cat-name">${s.name} — ${fmt.format(s.amount)}${s.dueDay ? ` <span class="cat-type">due ${ordinal(s.dueDay)}</span>` : ""}</span>
        <button data-edit-standard="${s.id}" class="icon-btn" aria-label="Edit ${s.name}">✎</button>
        <button data-remove-standard="${s.id}" class="icon-btn" aria-label="Remove ${s.name}">×</button>
      </li>`;
  }).join("") || `<li class="empty">No standard expenses set up yet</li>`;

  el("#standardManageList").querySelectorAll("[data-edit-standard]").forEach(btn => {
    btn.addEventListener("click", () => {
      const item = state.standardExpenses.find(s => s.id === btn.dataset.editStandard);
      if (item) startStandardEdit(item);
    });
  });
  el("#standardManageList").querySelectorAll("[data-remove-standard]").forEach(btn => {
    btn.addEventListener("click", () => {
      if (editingStandardId === btn.dataset.removeStandard) cancelStandardEdit();
      store.removeStandardExpense(btn.dataset.removeStandard);
      renderStandardManageList();
    });
  });
}

function renderStandardSection() {
  const state = store.getState();
  const items = store.standardExpensesForMonth(currentMonth);
  const totals = store.standardExpenseTotals(currentMonth);

  el("#standardTotal").textContent = fmt.format(totals.total);
  el("#standardPaidTotal").textContent = fmt.format(totals.paid);
  el("#standardUnpaidTotal").textContent = fmt.format(totals.unpaid);

  const rowHtml = item => {
    const cat = state.categories.find(c => c.id === item.categoryId);
    const tag = item.dueDay ? `<span class="due-tag">Due the ${ordinal(item.dueDay)}</span>` : "";
    return `
      <li class="standard-row ${item.paid ? "is-paid" : ""}">
        <input type="checkbox" class="standard-check" ${item.paid ? "checked" : ""} data-standard-id="${item.id}" aria-label="Add ${item.name} to this month" />
        <span class="swatch" style="background:${cat ? cat.color : "#888"}"></span>
        <span class="standard-name">${item.name}${tag}</span>
        <span class="standard-amount">${fmt.format(item.amount)}</span>
      </li>`;
  };

  el("#standardExpenseList").innerHTML = items.map(rowHtml).join("") ||
    `<li class="empty">No standard expenses set up yet — add some via the "Standard expenses" button above</li>`;

  el("#standardExpenseList").querySelectorAll("[data-standard-id]").forEach(cb => {
    cb.addEventListener("change", () => {
      store.setStandardExpensePaid(cb.dataset.standardId, currentMonth, cb.checked);
    });
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
  renderStandardSection();

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
          <span class="tx-note">${t.note || ""}${t.dueDate ? ` <span class="due-tag">Due ${dfmt.format(new Date(t.dueDate))}</span>` : ""}</span>
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
  populateStandardCategoryOptions();
  renderStandardManageList();
}
