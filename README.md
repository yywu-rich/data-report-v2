# 售后运营数据周报 v2

一个数据/代码分离、自带趋势图与同比标注的轻量周报站点。

## 在线访问

部署到 GitHub Pages 后访问：

- 报表首页：`https://yywu-rich.github.io/data-report-v2/`
- 抓取工具：`https://yywu-rich.github.io/data-report-v2/tools.html`

## 项目结构

```
.
├── index.html              # 报表首页（壳）
├── tools.html              # 浏览器书签抓取工具
├── data.json               # 单一数据源（每周更新只改这个文件）
├── assets/
│   ├── style.css           # 公共样式（含 dark mode）
│   └── app.js              # 渲染逻辑 + 图表 + 同环比
├── scripts/
│   └── validate.mjs        # 数据校验（push 前自动跑）
└── .github/workflows/
    ├── validate.yml        # CI：自动校验 data.json
    └── auto-fetch.yml.disabled  # 自动抓取（待启用）
```

## 数据 schema

`data.json` 的 `weeks` 数组按**时间倒序**排列（最新在前）。每一项：

```json
{
  "id": "2026-w19",
  "label": "26年(05.01-05.07)",
  "startDate": "2026-05-01",
  "endDate": "2026-05-07",
  "tags": [],
  "current": {
    "phoneCalls": 548,
    "phoneConnectRate": 0.92,
    "firstLineOrders": 1113,
    "firstLineResolveRate": 0.4798
  },
  "yoy": {
    "label": "25年(05.02-05.08)",
    "phoneCalls": 559
  }
}
```

**字段约定：**
- 所有率值（接通率、解决率）使用**小数**（0-1 之间），例如 `0.92` 代表 92%
- 缺数据用 `null`，不要用 `"-"` 或 `""`
- `tags` 用于打节假日等标记，例如 `["春节"]`、`["五一前"]`

## 每周更新流程（手动版）

1. 在企微/七鱼/工单系统后台，使用 `tools.html` 提供的书签抓取数据
2. 把数据发给 AI 助手，AI 会自动更新 `data.json`
3. AI push 到 GitHub，30 秒后页面自动更新

## 每周更新流程（未来自动版）

当你拿到七鱼/企微的开放 API key 后：

1. 在仓库 Settings → Secrets 里添加 `QIYU_API_KEY`、`WECHAT_API_KEY`
2. 把 `.github/workflows/auto-fetch.yml.disabled` 改名为 `auto-fetch.yml`
3. 实现 `scripts/fetch-weekly.mjs`（待办）
4. 之后每周四 22:00 自动抓取，无人值守

## 本地预览

```bash
python3 -m http.server 8000
```

打开 `http://localhost:8000/`。

## 数据校验

```bash
node scripts/validate.mjs
```

GitHub Actions 也会在每次 push 自动校验。

## 部署到 GitHub Pages

1. 推送到 GitHub
2. 仓库 Settings → Pages → Source 选 `main` 分支 `/ (root)`
3. 等 1 分钟，访问 `https://yywu-rich.github.io/data-report-v2/`

## 改进路线图

- [x] 数据/代码分离（`data.json`）
- [x] 自动同比百分比 + 涨跌染色
- [x] 趋势图（Chart.js）
- [x] 移动端适配
- [x] dark mode（跟随系统）
- [x] 数据校验脚本 + CI
- [ ] 一键提交书签（点书签直接 patch 到 GitHub）
- [ ] 七鱼/企微 API 自动抓取
- [ ] CSV/Excel 导出
- [ ] 月度/季度聚合视图
