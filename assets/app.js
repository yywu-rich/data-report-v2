// ===== app.js: 渲染逻辑 =====
const FIELD_META = [
  { key: "phoneCalls",            name: "呼入量",         percent: false, positive: false },
  { key: "phoneConnectRate",      name: "接通率",         percent: true,  positive: true  },
  { key: "firstLineOrders",       name: "一线提单量",     percent: false, positive: false },
  { key: "firstLineResolveRate",  name: "一线自行处理率", percent: true,  positive: true  },
  { key: "secondLineOrders",      name: "二线工单量",     percent: false, positive: false },
  { key: "secondLineResolveRate", name: "二线解决率",     percent: true,  positive: true  },
  { key: "p1Orders",              name: "P1工单数",       percent: false, positive: false },
  { key: "securityIssues",        name: "安全事件",       percent: false, positive: false },
  { key: "accumulatedP1",         name: "P1累计",         percent: false, positive: false },
  { key: "wechatSessions",        name: "企微会话量",     percent: false, positive: false },
  { key: "wechatOrders",          name: "企微派单工",     percent: false, positive: false },
  { key: "wechatP4Orders",        name: "企微P4工",       percent: false, positive: false }
];

let DATA = null;
let CHARTS = {};

init();

async function init() {
  try {
    const res = await fetch("./data.json", { cache: "no-store" });
    DATA = await res.json();
  } catch (err) {
    document.body.innerHTML = `<div style="padding:40px;text-align:center;color:#f5222d">
      加载 data.json 失败：${err.message}</div>`;
    return;
  }

  document.getElementById("lastUpdated").textContent =
    `最后更新：${formatDateTime(DATA.meta?.lastUpdated)} · 周期定义：${DATA.meta?.weekDefinition || "-"}`;

  bindControls();
  renderAll(DATA.weeks[0]?.id);
}

function bindControls() {
  const sel = document.getElementById("weekSelect");
  const search = document.getElementById("searchInput");

  const renderOptions = (filter = "") => {
    sel.innerHTML = "";
    DATA.weeks
      .filter((w) => !filter || (w.label + (w.tags || []).join("")).includes(filter))
      .forEach((w) => {
        const opt = document.createElement("option");
        opt.value = w.id;
        opt.textContent = w.label + (w.tags?.length ? ` [${w.tags.join("/")}]` : "");
        sel.appendChild(opt);
      });
  };

  renderOptions();
  sel.addEventListener("change", (e) => renderAll(e.target.value));
  search.addEventListener("input", (e) => {
    renderOptions(e.target.value.trim());
    if (sel.options.length) renderAll(sel.value);
  });
}

function renderAll(weekId) {
  const week = DATA.weeks.find((w) => w.id === weekId);
  if (!week) return;
  renderSummary(week);
  renderKPI(week);
  renderCharts();
  renderHistory();
}

function renderSummary(week) {
  const el = document.getElementById("summary");
  const tagHtml = (week.tags || []).map((t) => `<span class="tag">${t}</span>`).join("");
  const cur = week.current || {};
  const yoy = week.yoy || {};

  const callsDelta = computeDelta(cur.phoneCalls, yoy.phoneCalls);
  const connectDelta = computeDelta(cur.phoneConnectRate, yoy.phoneConnectRate);
  el.innerHTML = [
    `本期 ${week.label}${tagHtml}`,
    `呼入量 <b>${cur.phoneCalls ?? "-"}</b>（同比 <span class="delta ${callsDelta.cls}">${callsDelta.text}</span>）`,
    `接通率 <b>${formatPercent(cur.phoneConnectRate)}</b>（同比 <span class="delta ${connectDelta.cls}">${connectDelta.text}</span>）`,
    `P1工单 <b>${cur.p1Orders ?? "-"}</b>`
  ].join(" · ");
}

function renderKPI(week) {
  const grid = document.getElementById("kpiGrid");
  grid.innerHTML = "";
  const cur = week.current || {};
  const yoy = week.yoy || {};

  FIELD_META.forEach((f) => {
    const v = cur[f.key];
    const y = yoy[f.key];
    if (v === undefined && y === undefined) return;

    const delta = computeDelta(v, y);
    const valueText = f.percent ? formatPercent(v) : formatNumber(v);
    const yoyLabel = yoy.label || "上年同期";
    const yoyText = f.percent ? formatPercent(y) : formatNumber(y);

    const card = document.createElement("div");
    card.className = "kpi-card";
    card.dataset.positive = String(f.positive);
    card.innerHTML = `
      <div class="name">${f.name}</div>
      <div class="value">${valueText}</div>
      <div class="delta ${delta.cls}">${delta.text}</div>
      <div class="yoy">${yoyLabel}：${yoyText}</div>
    `;
    grid.appendChild(card);
  });
}

function renderCharts() {
  const recent = DATA.weeks.slice(0, 12).reverse();
  const labels = recent.map((w) => w.label.replace(/^\d+年/, ""));

  drawLine("chartCalls", "呼入量趋势", labels,
    recent.map((w) => w.current?.phoneCalls ?? null));
  drawLine("chartConnect", "接通率趋势 (%)", labels,
    recent.map((w) => w.current?.phoneConnectRate != null ? +(w.current.phoneConnectRate * 100).toFixed(2) : null));
  drawLine("chartFirstLine", "一线自行处理率趋势 (%)", labels,
    recent.map((w) => w.current?.firstLineResolveRate != null ? +(w.current.firstLineResolveRate * 100).toFixed(2) : null));
  drawLine("chartP1", "P1工单数趋势", labels,
    recent.map((w) => w.current?.p1Orders ?? null));
}

function drawLine(id, title, labels, data) {
  const ctx = document.getElementById(id);
  if (!ctx || typeof Chart === "undefined") return;
  if (CHARTS[id]) CHARTS[id].destroy();
  CHARTS[id] = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [{
        label: title,
        data,
        borderColor: "#1890ff",
        backgroundColor: "rgba(24,144,255,0.1)",
        fill: true,
        tension: 0.3,
        spanGaps: true
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: true, position: "top" } },
      scales: { y: { beginAtZero: false } }
    }
  });
}

function renderHistory() {
  const thead = document.querySelector("#historyTable thead");
  const tbody = document.querySelector("#historyTable tbody");
  thead.innerHTML = "";
  tbody.innerHTML = "";

  const headRow = document.createElement("tr");
  headRow.innerHTML = `<th class="left">周期</th>` +
    FIELD_META.map((f) => `<th>${f.name}</th>`).join("");
  thead.appendChild(headRow);

  DATA.weeks.forEach((w) => {
    const cur = w.current || {};
    const tagText = w.tags?.length ? ` [${w.tags.join("/")}]` : "";
    const row = document.createElement("tr");
    row.innerHTML = `<td class="left">${w.label}${tagText}</td>` +
      FIELD_META.map((f) => `<td>${f.percent ? formatPercent(cur[f.key]) : formatNumber(cur[f.key])}</td>`).join("");
    tbody.appendChild(row);
  });
}

function computeDelta(cur, prev) {
  if (cur == null || prev == null || prev === 0) {
    return { text: "—", cls: "flat", value: null };
  }
  const diff = cur - prev;
  const pct = (diff / Math.abs(prev)) * 100;
  const sign = diff > 0 ? "↑" : diff < 0 ? "↓" : "→";
  const cls = diff > 0 ? "up" : diff < 0 ? "down" : "flat";
  return { text: `${sign} ${Math.abs(pct).toFixed(1)}%`, cls, value: pct };
}

function formatNumber(v) {
  if (v == null || v === "") return "—";
  return typeof v === "number" ? v.toLocaleString("zh-CN") : v;
}

function formatPercent(v) {
  if (v == null || v === "") return "—";
  if (typeof v === "number") return (v * 100).toFixed(2) + "%";
  return v;
}

function formatDateTime(s) {
  if (!s) return "—";
  try {
    return new Date(s).toLocaleString("zh-CN", { hour12: false });
  } catch { return s; }
}
