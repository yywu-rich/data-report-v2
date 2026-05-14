#!/usr/bin/env node
// scripts/validate.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataPath = resolve(__dirname, "..", "data.json");

let data;
try {
  data = JSON.parse(readFileSync(dataPath, "utf-8"));
} catch (e) {
  console.error("data.json 读取失败：" + e.message);
  process.exit(1);
}

const errors = [];
const warnings = [];

if (!data.meta) errors.push("缺少 meta");
if (!Array.isArray(data.weeks)) errors.push("weeks 必须是数组");

const REQ_FIELDS = ["phoneCalls", "phoneConnectRate", "firstLineOrders", "firstLineResolveRate", "p1Orders"];
const PCT_FIELDS = new Set(["phoneConnectRate", "firstLineResolveRate", "secondLineResolveRate"]);
const idSeen = new Set();

(data.weeks || []).forEach((w, i) => {
  const tag = `weeks[${i}] (${w.id || "?"})`;
  if (!w.id) errors.push(`${tag}: 缺少 id`);
  else if (idSeen.has(w.id)) errors.push(`${tag}: id 重复`);
  else idSeen.add(w.id);

  if (!w.label) errors.push(`${tag}: 缺少 label`);
  if (!w.startDate || !w.endDate) warnings.push(`${tag}: 建议补全 startDate/endDate`);

  const cur = w.current || {};
  REQ_FIELDS.forEach((f) => {
    if (cur[f] == null) warnings.push(`${tag}: current.${f} 为空`);
  });
  Object.entries(cur).forEach(([k, v]) => {
    if (PCT_FIELDS.has(k) && typeof v === "number" && (v < 0 || v > 1)) {
      errors.push(`${tag}: ${k}=${v} 不在 0-1 之间（应使用小数，例如 0.92 表示 92%）`);
    }
  });
});

if (data.weeks?.length >= 2) {
  const a = data.weeks[0].startDate, b = data.weeks[1].startDate;
  if (a && b && a < b) warnings.push("weeks[0] 不是最新，建议按时间倒序排列（最新在前）");
}

if (warnings.length) {
  console.warn("[warn]");
  warnings.forEach((w) => console.warn("   - " + w));
}
if (errors.length) {
  console.error("[fail]");
  errors.forEach((e) => console.error("   - " + e));
  process.exit(1);
}
console.log(`OK: data.json 校验通过（共 ${data.weeks.length} 周数据）`);
