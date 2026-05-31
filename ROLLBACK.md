# 回退指南（一线/二线 Jira 指标）

本文档记录如何回退「一线提单量 / 一线自行处理率 / 二线接单量 / 二线周解决率」这套 Jira 采集逻辑。
**所有操作都可以在 github.com 网页上自助完成，不依赖 Kiro。**

## 这次改了什么

- 文件：`assets/collector.js`、`assets/app.js`、`index.html`、`data.json`
- 新增 4 个指标（详见 PR #1）：
  | 字段 | 中文 | 口径 |
  |---|---|---|
  | `firstLineOrders` | 一线提单量 | `count(CS 客户服务请求 AND NOT labels=无效单)` + `count(CMSA)` |
  | `firstLineResolveRate` | 一线自行处理率 | `count(CS AND labels=自行处理 AND NOT labels=无效单)` ÷ `firstLineOrders` |
  | `secondLineOrders` | 二线接单量 | `assignee changed to membersOf("技术服务部-TS") DURING(...) AND timespent > 0` |
  | `secondLineResolveRate` | 二线周解决率 | 逐单查 changelog，`resolutiondate − 首次分配二线时间 ≤ 7 天` 的占比 |
- 引入这套逻辑的合并提交：见 GitHub 上 `main` 分支的「Merge pull request #1」。

> 书签每次加载的是 `main` 上最新的 `collector.js`。任何回退一旦合并进 `main`、Pages 部署完成（约 1 分钟），书签会**自动**使用回退后的逻辑，**无需重新拖书签**。

## 一、整体回退（撤销整个改动）

### 方式 A：用 GitHub 的 Revert 按钮（最简单，推荐）
1. 打开已合并的 PR：`https://github.com/yywu-rich/data-report-v2/pull/1`
2. 页面底部点 **「Revert」** → GitHub 自动生成一个「反向 PR」
3. 合并那个反向 PR 即可恢复到改动前的状态

### 方式 B：在 Commits 历史里回退
1. 仓库首页 → **Commits**
2. 找到「Merge pull request #1 …」这条提交，点进去
3. 右上角 **「Revert」** → 生成反向 PR → 合并

### 方式 C：git 命令行（会用 git 的话）
```bash
# 撤销这次合并（-m 1 表示保留 main 主线）
git revert -m 1 <merge_commit_sha>
git push origin main
```
`<merge_commit_sha>` 即「Merge pull request #1」对应的提交号。

## 二、只想停用「二线」指标，保留「一线」

不需要整体回退，直接在 GitHub 网页编辑 `assets/collector.js`：

1. 仓库 → `assets/collector.js` → 右上角铅笔图标（Edit）
2. 找到 `fetchJiraWindow` 函数里这两行，注释掉或删除：
   ```js
   // const tsMembers = await getSecondLineMembers();
   // const secondLine = await computeSecondLine(fillJql(SECOND_LINE_INTAKE_JQL, params), tsMembers);
   // result.secondLineOrders = secondLine.orders;
   // result.secondLineResolveRate = secondLine.rate;
   ```
3. 直接提交（Commit changes）即可。

## 三、单独修正某一周的数据

历史数据存在 `data.json`，回退**代码**不会动到**已写入的数据**。如需手改：

1. 仓库 → `data.json` → Edit
2. 找到对应周（按 `id` 或 `label`），修改 `current` 里的字段值
   - 百分比字段用小数，例如 `0.45` 表示 45%
3. 提交即可。提交后 `.github/workflows/validate.yml` 会自动校验格式。

## 四、关于「一线」指标的两个来源（重要）

- `firstLineOrders` / `firstLineResolveRate` 现在有**两条采集路径**：
  1. **Jira 书签**（本次新增，直接用 JQL 计算）
  2. **Polaris 书签**（`runPolarisCollection`，旧方式，**代码仍保留未删除**）
- 两者按周合并（`mergeWeekEntry`），**后写的会覆盖先写的**。
- 因此如果只想切回旧口径：**改用 Polaris 书签采集这两项即可**，无需改代码。

## 没有 Kiro 也能回退（小结）

| 想做的事 | 怎么做（纯 GitHub 网页） |
|---|---|
| 撤销整个改动 | PR #1 底部点 Revert → 合并反向 PR |
| 只停用二线 | 网页编辑 `collector.js`，注释二线那几行 |
| 改某周数据 | 网页编辑 `data.json` 对应周字段 |
| 切回一线旧口径 | 改用 Polaris 书签采集（代码已保留） |

> 提示：以上每次提交合并进 `main` 后，等 GitHub Pages 部署完成，报表与书签会自动生效。
