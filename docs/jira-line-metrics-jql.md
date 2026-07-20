# Jira 一线指标 JQL 口径备忘

状态：一线提单量已写入“一键获取报表”书签；一线自行解决率待部门确认后再接入。

统计周期示例：2026-07-10 至 2026-07-17。

## 一线提单量

口径：

```text
一线提单量 = CS 请求单总量 - CS 无效单 + SA/CMSA 单
```

### 1. CS 请求单总量

结果示例：789

```jql
project = CS
AND issuetype = "客户服务请求"
AND created >= "2026-07-10"
AND created <= "2026-07-17"
AND reporter in (membersOf("jira-售后服务部"), support)
ORDER BY created DESC, cf[16512] DESC
```

### 2. CS 无效单

结果示例：7

```jql
project = CS
AND issuetype = "客户服务请求"
AND labels = "无效单"
AND created >= "2026-07-10"
AND created <= "2026-07-17"
AND reporter in (membersOf("jira-售后服务部"), support)
ORDER BY created DESC, cf[16512] DESC
```

### 3. SA/CMSA 单

结果示例：63

```jql
project = CMSA
AND created >= "2026-07-10"
AND created <= "2026-07-17"
AND reporter in (membersOf("jira-售后服务部"), support)
ORDER BY created DESC, cf[16512] DESC
```

### 示例计算

```text
一线提单量 = 789 - 7 + 63 = 845
```

## 一线自行解决率

口径：SA/CMSA 单只进入一线提单量分母，不进入一线自行解决量分子。

```text
一线自行解决率 = 一线自行解决量 / 一线提单量
一线自行解决量 = 有效 CS 请求单 - 转给 TS 的有效 CS 请求单
```

### 1. 有效 CS 请求单

结果示例：782

```jql
project = CS
AND issuetype = "客户服务请求"
AND created >= "2026-07-10"
AND created <= "2026-07-17"
AND reporter in (membersOf("jira-售后服务部"), support)
AND (labels IS EMPTY OR labels NOT IN ("无效单"))
ORDER BY created DESC, cf[16512] DESC
```

### 2. 有效 CS 请求单中转给 TS 的单

结果示例：347

```jql
project = CS
AND issuetype = "客户服务请求"
AND created >= "2026-07-10"
AND created <= "2026-07-17"
AND reporter in (membersOf("jira-售后服务部"), support)
AND (labels IS EMPTY OR labels NOT IN ("无效单"))
AND assignee CHANGED TO membersOf("技术服务部-TS")
ORDER BY created DESC, cf[16512] DESC
```

### 示例计算

```text
一线自行解决量 = 782 - 347 = 435
一线自行解决率 = 435 / 845 = 51.48%
```

## 待确认

- 统计周期是否固定使用 `created >= "开始日期"` 与 `created <= "结束日期"`。
- `created <= "结束日期"` 在当前 Jira 中是否符合业务想要的截止范围。
- `assignee CHANGED TO membersOf("技术服务部-TS")` 是否作为“转给 TS”的最终判定条件。
