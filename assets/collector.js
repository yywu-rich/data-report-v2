/* ============================================================
 * 售后周报数据采集器 (collector.js)
 * 支持平台：jira.mailtech.cn / coremail.qiyukf.com / Polaris / 售后工单数据分析平台
 * 模式：普通(1周) / 补抓(N周)
 * ============================================================ */
(function () {
  'use strict';
  if (window.__DR_COLLECTOR_RUNNING) return;
  window.__DR_COLLECTOR_RUNNING = true;

  const PAT = window.__DR_PAT || '';
  const BACKFILL = window.__DR_BACKFILL ? parseInt(window.__DR_BACKFILL) : 1;
  const REPO_OWNER = 'yywu-rich';
  const REPO_NAME = 'data-report-v2';
  const PAGES_URL = 'https://yywu-rich.github.io/data-report-v2/';
  // 临时暂停未确认的 Jira 二线指标；一线提单量/自行处理率已按新口径恢复自动取数。
  const PAUSE_JIRA_LINE_METRICS = true;
  const PAUSED_JIRA_LINE_METRIC_KEYS = [
    'secondLineOrders',
    'secondLineResolveRate'
  ];

  // ============== 时间工具 ==============
  function getCurrentWindow() {
    const end = new Date();
    do { end.setDate(end.getDate() - 1); } while (end.getDay() !== 4);
    end.setHours(23, 59, 59, 999);
    const start = new Date(end);
    start.setDate(start.getDate() - 6);
    start.setHours(0, 0, 0, 0);
    return { start, end };
  }
  function shiftWindow(win, weeksBack) {
    const start = new Date(win.start); start.setDate(start.getDate() - 7 * weeksBack);
    const end = new Date(win.end); end.setDate(end.getDate() - 7 * weeksBack);
    return { start, end };
  }
  function getYoYWindow(cur) {
    const start = new Date(cur.start); start.setDate(start.getDate() - 364);
    const end = new Date(cur.end); end.setDate(end.getDate() - 364);
    return { start, end };
  }
  const pad = (n) => String(n).padStart(2, '0');
  const fmtJqlDate = (d) => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const fmtIsoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  const fmtPeriod = (d1, d2) => `${String(d1.getFullYear()).slice(-2)}年(${pad(d1.getMonth()+1)}.${pad(d1.getDate())}-${pad(d2.getMonth()+1)}.${pad(d2.getDate())})`;
  function parseIsoDate(value, endOfDay) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return null;
    const d = new Date(value + (endOfDay ? 'T23:59:59' : 'T00:00:00'));
    if (Number.isNaN(d.getTime())) return null;
    return d;
  }
  function isoWeek(d) {
    const x = new Date(d); x.setHours(0,0,0,0);
    x.setDate(x.getDate() + 3 - (x.getDay() + 6) % 7);
    const w1 = new Date(x.getFullYear(), 0, 4);
    return 1 + Math.round(((x - w1) / 86400000 - 3 + (w1.getDay() + 6) % 7) / 7);
  }
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ============== Jira ==============
  // 简单计数指标：每个 JQL 取 total
  const JIRA_QUERIES = [
    { key: 'p1Orders', name: 'P1工单数', jql: 'project = CS AND issuetype = "客户服务请求" AND "故障等级" = "P1-严重" AND created >= "{{s}}" AND created < "{{eExc}}"' },
    { key: 'securityIssues', name: '安全问题', jql: 'project = CS AND issuetype = "客户服务请求" AND "故障等级" = "安全问题" AND created >= "{{s}}" AND created < "{{eExc}}"' },
    { key: 'wechatOrders', name: '企微来源工单', jql: 'project = CS AND issuetype = "客户服务请求" AND 来源 = "微信小助手" AND created >= "{{s}}" AND created < "{{eExc}}"' },
    { key: 'wechatP4Orders', name: 'P4工单（企微）', jql: 'project = CS AND issuetype = "客户服务请求" AND "故障等级" = "P4-咨询" AND 来源 = "微信小助手" AND created >= "{{s}}" AND created < "{{eExc}}"' }
  ];

  // 一线提单量 = CS 请求单总量 - CS 无效单 + SA/CMSA 单
  // 一线自行处理率 = CS 自行处理量 / 一线提单量
  // 日期口径使用业务确认的 created >= 开始日期 AND created <= 结束日期次日。
  const FIRST_LINE_JQL = {
    csTotal:   'project = CS AND issuetype = "客户服务请求" AND created >= "{{sDate}}" AND created <= "{{eBoundaryDate}}" AND reporter in (membersOf("jira-售后服务部"), support)',
    csInvalid: 'project = CS AND issuetype = "客户服务请求" AND labels = "无效单" AND created >= "{{sDate}}" AND created <= "{{eBoundaryDate}}" AND reporter in (membersOf("jira-售后服务部"), support)',
    cmsa:      'project = CMSA AND created >= "{{sDate}}" AND created <= "{{eBoundaryDate}}" AND reporter in (membersOf("jira-售后服务部"), support)',
    selfDone:  'project = CS AND issuetype = "客户服务请求" AND labels = "自行处理" AND created >= "{{sDate}}" AND created <= "{{eBoundaryDate}}" AND reporter in (membersOf("jira-售后服务部"), support)'
  };

  // 二线指标
  //   二线接单量 = 在窗口期内被分配给「技术服务部-TS」成员、且有工时投入的工单
  //   二线周解决率 = 上述工单中「解决时间 - 首次分配给二线时间 <= 7 天」的占比
  const SECOND_LINE_GROUP = '技术服务部-TS';
  const SECOND_LINE_INTAKE_JQL = 'project = CS AND issuetype = "客户服务请求" AND assignee changed to membersOf("' + SECOND_LINE_GROUP + '") DURING ("{{s}}", "{{e}}") AND timespent > 0';
  const SECOND_LINE_SLA_MS = 7 * 24 * 60 * 60 * 1000; // 7 天

  // 面板展示用：键 -> 中文名 + 是否百分比（顺序即展示顺序）
  const JIRA_DISPLAY = [
    ...JIRA_QUERIES.map((q) => ({ key: q.key, name: q.name, percent: false })),
    { key: 'firstLineOrders', name: '一线提单量', percent: false },
    { key: 'firstLineResolveRate', name: '一线自行处理率', percent: true },
    { key: 'secondLineOrders', name: '二线接单量', percent: false },
    { key: 'secondLineResolveRate', name: '二线周解决率', percent: true }
  ];
  const fmtMetric = (v, percent) => (v == null ? '-' : percent ? (v * 100).toFixed(2) + '%' : v);

  function markPausedJiraLineMetrics(result) {
    // 暂停的指标不写入本次结果，避免 Jira 更新覆盖其他平台已采集的二线数据。
    PAUSED_JIRA_LINE_METRIC_KEYS.forEach((key) => { delete result[key]; });
  }

  // 把模板里的 {{x}} 占位符替换为实际值
  function fillJql(tpl, params) {
    let jql = tpl;
    Object.entries(params).forEach(([k, v]) => { jql = jql.split('{{' + k + '}}').join(v); });
    return jql;
  }

  async function jiraCount(jql) {
    const url = '/rest/api/2/search?jql=' + encodeURIComponent(jql) + '&maxResults=0';
    const res = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('Jira API ' + res.status);
    return (await res.json()).total;
  }

  async function computeFirstLineMetrics(params) {
    const csTotal = await jiraCount(fillJql(FIRST_LINE_JQL.csTotal, params));
    const csInvalid = await jiraCount(fillJql(FIRST_LINE_JQL.csInvalid, params));
    const cmsa = await jiraCount(fillJql(FIRST_LINE_JQL.cmsa, params));
    const selfResolved = await jiraCount(fillJql(FIRST_LINE_JQL.selfDone, params));
    const firstLineOrders = csTotal - csInvalid + cmsa;
    return {
      firstLineOrders,
      firstLineResolveRate: firstLineOrders > 0 ? +(selfResolved / firstLineOrders).toFixed(4) : null,
      firstLineBreakdown: { csTotal, csInvalid, cmsa, selfResolved }
    };
  }

  // 分页搜索工单，并展开 changelog（用于二线解决率）
  async function jiraSearchWithChangelog(jql) {
    const issues = [];
    const pageSize = 50;
    let startAt = 0;
    while (true) {
      const url = '/rest/api/2/search?jql=' + encodeURIComponent(jql) +
        '&maxResults=' + pageSize + '&startAt=' + startAt +
        '&fields=resolutiondate&expand=changelog';
      const res = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error('Jira API ' + res.status);
      const json = await res.json();
      const batch = json.issues || [];
      issues.push(...batch);
      startAt += pageSize;
      if (batch.length === 0 || startAt >= (json.total || 0)) break;
    }
    return issues;
  }

  // 当 search 展开的 changelog 被截断时，单独拉取该工单的完整 changelog
  async function jiraFetchChangelog(key) {
    const url = '/rest/api/2/issue/' + encodeURIComponent(key) + '?expand=changelog&fields=resolutiondate';
    const res = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('Jira API ' + res.status);
    const json = await res.json();
    return (json.changelog && json.changelog.histories) || [];
  }

  // 读取「技术服务部-TS」组成员（用户名/Key/displayName 全部收集，便于和 changelog 比对）
  // 结果缓存到模块级变量，避免每个窗口重复请求
  let _tsMembersCache = null;
  async function getSecondLineMembers() {
    if (_tsMembersCache) return _tsMembersCache;
    const names = new Set();
    let startAt = 0;
    const pageSize = 50;
    try {
      while (true) {
        const url = '/rest/api/2/group/member?groupname=' + encodeURIComponent(SECOND_LINE_GROUP) +
          '&includeInactiveUsers=true&maxResults=' + pageSize + '&startAt=' + startAt;
        const res = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } });
        if (!res.ok) break; // 无权限/接口不可用时降级：tsMembers 为空 -> 用「首次任意分配」兜底
        const json = await res.json();
        const values = json.values || [];
        values.forEach((u) => {
          if (u.name) names.add(u.name);
          if (u.key) names.add(u.key);
          if (u.accountId) names.add(u.accountId);
          if (u.displayName) names.add(u.displayName);
        });
        startAt += pageSize;
        if (json.isLast || values.length === 0) break;
        if (startAt > 5000) break; // 安全上限
      }
    } catch (e) { /* 降级 */ }
    _tsMembersCache = names;
    return names;
  }

  // 从 changelog 找到「首次分配给二线」的时间
  //   tsMembers 非空：取第一条 assignee 变更且新负责人属于 TS 组的时间
  //   tsMembers 为空（拿不到组成员）：兜底取第一条「分配给某人」的时间
  function findFirstSecondLineAssignTime(histories, tsMembers) {
    const sorted = (histories || []).slice().sort((a, b) => new Date(a.created) - new Date(b.created));
    for (const h of sorted) {
      for (const item of (h.items || [])) {
        if (item.field !== 'assignee') continue;
        const toKey = item.to;
        const toName = item.toString;
        if (!toKey && !toName) continue; // 取消分配，跳过
        if (tsMembers && tsMembers.size > 0) {
          if (tsMembers.has(toKey) || tsMembers.has(toName)) return new Date(h.created);
        } else {
          return new Date(h.created); // 降级：首次任意分配
        }
      }
    }
    return null;
  }

  // 二线接单量 + 周解决率（逐个工单查 changelog）
  async function computeSecondLine(intakeJql, tsMembers) {
    const issues = await jiraSearchWithChangelog(intakeJql);
    const total = issues.length;
    if (total === 0) return { orders: 0, rate: null };
    let resolvedWithinWeek = 0;
    for (const issue of issues) {
      let histories = (issue.changelog && issue.changelog.histories) || [];
      // changelog 被截断时，补拉完整版
      if (issue.changelog && issue.changelog.total > histories.length) {
        try { histories = await jiraFetchChangelog(issue.key); } catch (e) { /* 用已有的 */ }
      }
      const firstAssign = findFirstSecondLineAssignTime(histories, tsMembers);
      const resoStr = issue.fields && issue.fields.resolutiondate;
      if (!firstAssign || !resoStr) continue; // 未分配二线或未解决 -> 不计入分子
      const diff = new Date(resoStr) - firstAssign;
      if (diff >= 0 && diff <= SECOND_LINE_SLA_MS) resolvedWithinWeek++;
    }
    return { orders: total, rate: +(resolvedWithinWeek / total).toFixed(4) };
  }

  async function fetchJiraWindow(win) {
    const eExc = new Date(win.end); eExc.setHours(0, 0, 0, 0); eExc.setDate(eExc.getDate() + 1);
    const params = {
      s: fmtJqlDate(win.start),
      e: fmtJqlDate(win.end),
      eExc: fmtJqlDate(eExc),
      sDate: fmtIsoDate(win.start),
      eBoundaryDate: fmtIsoDate(eExc)
    };
    const result = {};

    // 1) 简单计数指标
    for (const q of JIRA_QUERIES) {
      result[q.key] = await jiraCount(fillJql(q.jql, params));
    }

    const firstLine = await computeFirstLineMetrics(params);
    result.firstLineOrders = firstLine.firstLineOrders;
    result.firstLineResolveRate = firstLine.firstLineResolveRate;
    result.firstLineBreakdown = firstLine.firstLineBreakdown;

    if (PAUSE_JIRA_LINE_METRICS) {
      markPausedJiraLineMetrics(result);
      return result;
    }

    // 4) 二线接单量 + 5) 二线周解决率
    const tsMembers = await getSecondLineMembers();
    const secondLine = await computeSecondLine(fillJql(SECOND_LINE_INTAKE_JQL, params), tsMembers);
    result.secondLineOrders = secondLine.orders;
    result.secondLineResolveRate = secondLine.rate;

    return result;
  }


  // ============== 七鱼：呼叫中心团队报表 ==============
  // qiyuSetDate 已移除：改为读取页面当前日期，不再自动设日期

  function qiyuCheckGroup() {
    const rendered = document.querySelectorAll('.fishd-treeselect-selection__rendered');
    for (const el of rendered) {
      if (el.innerText.indexOf('售后服务') >= 0) return true;
    }
    return false;
  }

  function qiyuParseCallData() {
    // 从表格"总计"行抓"总量"(第1列)和"接通率"(第5列)
    const text = document.body.innerText;
    const lines = text.split('\n');
    // 找到表头行 -> 然后下一行是总计
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.indexOf('总量') >= 0 && line.indexOf('接通率') >= 0 && line.indexOf('队列接通率') >= 0) {
        // 下一行就是总计数据行
        const dataLine = lines[i + 1];
        if (!dataLine) continue;
        const cells = dataLine.trim().split(/\t+/);
        // cells[0]=总量, cells[1]=峰值通话量, cells[2]=振铃量, cells[3]=接通量, cells[4]=接通率
        const phoneCalls = parseInt(cells[0]) || 0;
        const connectRateStr = cells[4] || '0%';
        const connectRate = parseFloat(connectRateStr) / 100;
        return { phoneCalls, phoneConnectRate: connectRate };
      }
    }
    // 备用方案：从"团队业务指标"区域找呼入量
    const callsMatch = text.match(/呼入量\n(\d+)/);
    const rateMatch = text.match(/队列接通率\n([\d.]+%)/);
    if (callsMatch) {
      const phoneCalls = parseInt(callsMatch[1]);
      const phoneConnectRate = rateMatch ? parseFloat(rateMatch[1]) / 100 : null;
      return { phoneCalls, phoneConnectRate };
    }
    throw new Error('无法从页面解析呼入量/接通率。请确认在"呼叫中心→团队报表→售后服务"页面。');
  }

  // ============== 七鱼：在线客服总览（企微会话量） ==============
  function qiyuParseWechatSessions() {
    const text = document.body.innerText;
    // 找"企业微信"关键字后面的数字
    const match = text.match(/企业微信[^\n]*?\n\s*(\d[\d,]*)个/);
    if (match) return parseInt(match[1].replace(/,/g, ''));
    // 备用：找"企业微信-" 开头那行
    const match2 = text.match(/企业微信[^]*?(\d[\d,]*)个/);
    if (match2) return parseInt(match2[1].replace(/,/g, ''));
    throw new Error('无法解析企微会话量。请确认在"在线客服→总览"页面，且能看到"客户来源"区域。');
  }

  // 从页面输入框读取当前日期（兼容 "2026-05-08" 和 "2026-05-08 00:00" 两种格式）
  function qiyuReadDate() {
    const inputs = document.querySelectorAll('input.fishd-input');
    if (inputs.length < 2) throw new Error('找不到日期输入框');
    return { start: inputs[0].value.substring(0, 10), end: inputs[1].value.substring(0, 10) };
  }

  // 读取当前客服组名称
  function qiyuReadGroup() {
    const rendered = document.querySelectorAll('.fishd-treeselect-selection__rendered');
    for (const el of rendered) {
      const txt = el.innerText.trim();
      if (txt && txt !== '请选择') return txt;
    }
    // 备用：ant-select
    const items = document.querySelectorAll('.ant-select-selection-item');
    for (const el of items) {
      if (el.innerText.indexOf('客服组') >= 0) continue;
      const txt = el.innerText.trim();
      if (txt) return txt;
    }
    return '未知';
  }

  // 等待用户确认的 Promise
  // 使用独立的浮动 div（不在 shadow DOM 内），确保按钮可点击
  function waitForConfirm(panel, message) {
    return new Promise((resolve) => {
      const wrapper = document.createElement('div');
      wrapper.id = 'dr-confirm-wrapper';
      wrapper.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:2147483647;background:#fff;border:2px solid #1890ff;border-radius:12px;padding:24px;box-shadow:0 8px 32px rgba(0,0,0,0.25);font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;font-size:14px;color:#333;max-width:420px;width:90%;';
      const msgDiv = document.createElement('div');
      msgDiv.style.cssText = 'margin-bottom:16px;white-space:pre-wrap;line-height:1.8;';
      msgDiv.textContent = message;
      const btnRow = document.createElement('div');
      btnRow.style.cssText = 'display:flex;gap:12px;justify-content:center;';
      const confirmBtn = document.createElement('button');
      confirmBtn.textContent = '✓ 确认抓取';
      confirmBtn.style.cssText = 'padding:10px 28px;background:#1890ff;color:#fff;border:none;border-radius:6px;font-size:14px;cursor:pointer;font-weight:600;';
      const cancelBtn = document.createElement('button');
      cancelBtn.textContent = '✗ 取消';
      cancelBtn.style.cssText = 'padding:10px 28px;background:#f5f5f5;color:#666;border:1px solid #d9d9d9;border-radius:6px;font-size:14px;cursor:pointer;';
      confirmBtn.onclick = () => { wrapper.remove(); resolve(true); };
      cancelBtn.onclick = () => { wrapper.remove(); resolve(false); };
      btnRow.appendChild(confirmBtn);
      btnRow.appendChild(cancelBtn);
      wrapper.appendChild(msgDiv);
      wrapper.appendChild(btnRow);
      // 直接插入 body（完全独立于 shadow DOM 和 host 元素）
      document.body.appendChild(wrapper);
    });
  }

  function waitForDateRange(defaultWin) {
    return new Promise((resolve) => {
      const wrapper = document.createElement('div');
      wrapper.id = 'dr-date-wrapper';
      wrapper.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:2147483647;background:#fff;border:2px solid #1890ff;border-radius:12px;padding:24px;box-shadow:0 8px 32px rgba(0,0,0,0.25);font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;font-size:14px;color:#333;max-width:440px;width:90%;';
      wrapper.innerHTML = `
        <div style="font-weight:600;font-size:16px;margin-bottom:12px;color:#0050b3;">选择 Jira 取数日期</div>
        <div style="line-height:1.7;margin-bottom:14px;color:#555;">默认是本期；如需补别的日期，直接修改后确认。</div>
        <label style="display:block;margin-bottom:10px;color:#333;">开始日期
          <input id="drStartDate" type="date" value="${fmtIsoDate(defaultWin.start)}" style="display:block;width:100%;box-sizing:border-box;margin-top:6px;padding:9px 10px;border:1px solid #d9d9d9;border-radius:6px;font-size:14px;">
        </label>
        <label style="display:block;margin-bottom:14px;color:#333;">结束日期
          <input id="drEndDate" type="date" value="${fmtIsoDate(defaultWin.end)}" style="display:block;width:100%;box-sizing:border-box;margin-top:6px;padding:9px 10px;border:1px solid #d9d9d9;border-radius:6px;font-size:14px;">
        </label>
        <div id="drDateError" style="display:none;margin-bottom:12px;color:#cf1322;"></div>
        <div style="display:flex;gap:12px;justify-content:center;">
          <button id="drDateConfirm" style="padding:10px 28px;background:#1890ff;color:#fff;border:none;border-radius:6px;font-size:14px;cursor:pointer;font-weight:600;">确认抓取</button>
          <button id="drDateCancel" style="padding:10px 28px;background:#f5f5f5;color:#666;border:1px solid #d9d9d9;border-radius:6px;font-size:14px;cursor:pointer;">取消</button>
        </div>`;
      document.body.appendChild(wrapper);
      const startInput = wrapper.querySelector('#drStartDate');
      const endInput = wrapper.querySelector('#drEndDate');
      const errorEl = wrapper.querySelector('#drDateError');
      wrapper.querySelector('#drDateConfirm').onclick = () => {
        const start = parseIsoDate(startInput.value, false);
        const end = parseIsoDate(endInput.value, true);
        if (!start || !end) {
          errorEl.textContent = '请输入有效日期。';
          errorEl.style.display = 'block';
          return;
        }
        if (start > end) {
          errorEl.textContent = '开始日期不能晚于结束日期。';
          errorEl.style.display = 'block';
          return;
        }
        wrapper.remove();
        resolve({ start, end });
      };
      wrapper.querySelector('#drDateCancel').onclick = () => { wrapper.remove(); resolve(null); };
    });
  }

  async function runQiyuCollection(panel) {
    const bodyText = document.body.innerText;
    const isCallCenter = (bodyText.indexOf('团队报表') >= 0 && bodyText.indexOf('呼入量') >= 0);
    const isOnlineOverview = (bodyText.indexOf('总会话量') >= 0 && bodyText.indexOf('客户来源') >= 0);

    if (!isCallCenter && !isOnlineOverview) {
      panel.setStatus('无法识别当前七鱼页面。请在以下页面点击书签：\n1. 呼叫中心→团队报表（抓呼入量/接通率）\n2. 在线客服→总览（抓企微会话量）', 'error');
      return;
    }

    // 读取页面上当前的日期和客服组
    const dates = qiyuReadDate();
    const group = isCallCenter ? qiyuReadGroup() : '—';
    const startStr = dates.start;
    const endStr = dates.end;

    if (!startStr || !endStr) {
      panel.setStatus('⚠️ 无法读取页面上的日期，请确认页面已加载完成。', 'error');
      return;
    }

    // 计算周期 ID 和 label（基于页面实际日期）
    const startDate = new Date(startStr + 'T00:00:00');
    const endDate = new Date(endStr + 'T23:59:59');
    const weekId = `${endDate.getFullYear()}-w${pad(isoWeek(endDate))}`;
    const label = fmtPeriod(startDate, endDate);
    const pageType = isCallCenter ? '呼叫中心 · 团队报表' : '在线客服 · 总览';

    // 先读数据再确认（让用户核对数字是否正确）
    panel.setMeta(`七鱼 · ${pageType}`);
    panel.setStatus('正在读取页面数据...', 'info');

    let previewData, previewMsg;
    if (isCallCenter) {
      if (!qiyuCheckGroup()) {
        panel.setStatus('⚠️ 当前客服组不是"售后服务"！请先手动选择后重新点击书签。', 'error');
        return;
      }
      previewData = qiyuParseCallData();
      previewMsg = `📅 日期范围：${startStr} 至 ${endStr}\n👥 客服组：${group}\n📊 页面类型：${pageType}\n🏷️ 将写入周期：${label}\n\n📈 读取到的数据：\n   呼入量：${previewData.phoneCalls}\n   接通率：${(previewData.phoneConnectRate * 100).toFixed(1)}%\n\n⚠️ 请核对以上数字跟页面显示一致，再点确认`;
    } else {
      const sessions = qiyuParseWechatSessions();
      previewData = { wechatSessions: sessions };
      previewMsg = `📅 日期范围：${startStr} 至 ${endStr}\n📊 页面类型：${pageType}\n🏷️ 将写入周期：${label}\n\n📈 读取到的数据：\n   企微会话量：${sessions}\n\n⚠️ 请核对以上数字跟页面显示一致，再点确认`;
    }

    panel.setStatus('等待确认...', 'info');
    const confirmed = await waitForConfirm(panel, previewMsg);

    if (!confirmed) {
      panel.setStatus('已取消。请等页面数据刷新后重新点击书签。', 'info');
      return;
    }

    if (isCallCenter) {
      const data = previewData;
      panel.appendDetail(`<div class="week-block">
        <div class="week-title">${label} · ${group}</div>
        <div class="row"><span class="name">呼入量</span><span class="value">${data.phoneCalls}</span></div>
        <div class="row"><span class="name">接通率</span><span class="value">${(data.phoneConnectRate * 100).toFixed(1)}%</span></div>
      </div>`);

      // 写入 GitHub
      panel.setStatus('正在写入 GitHub...', 'info');
      const { data: json, sha } = await readDataJson();
      const weekEntry = { id: weekId, label, startDate: startStr, endDate: endStr, tags: [], current: data, yoy: {} };
      mergeWeekEntry(json, weekEntry);
      json.weeks.sort((a, b) => (b.startDate || '').localeCompare(a.startDate || ''));
      json.meta.lastUpdated = new Date().toISOString();
      await writeDataJson(json, sha, `chore: qiyu call data ${label}`);
      panel.setStatus('✅ 呼入量 + 接通率已写入 GitHub！', 'success');
      panel.appendDetail(`<a class="btn" href="${PAGES_URL}" target="_blank">查看报表</a>`);
      showNextWeekHint(panel, startDate, endDate, 'qiyu-call');

    } else if (isOnlineOverview) {
      const wechatSessions = previewData.wechatSessions;
      panel.appendDetail(`<div class="week-block">
        <div class="week-title">${label} · 在线客服总览</div>
        <div class="row"><span class="name">企微会话量</span><span class="value">${wechatSessions}</span></div>
      </div>`);

      // 写入 GitHub
      panel.setStatus('正在写入 GitHub...', 'info');
      const { data: json, sha } = await readDataJson();
      const weekEntry = { id: weekId, label, startDate: startStr, endDate: endStr, tags: [], current: { wechatSessions }, yoy: {} };
      mergeWeekEntry(json, weekEntry);
      json.weeks.sort((a, b) => (b.startDate || '').localeCompare(a.startDate || ''));
      json.meta.lastUpdated = new Date().toISOString();
      await writeDataJson(json, sha, `chore: qiyu wechat sessions ${label}`);
      panel.setStatus('✅ 企微会话量已写入 GitHub！', 'success');
      panel.appendDetail(`<a class="btn" href="${PAGES_URL}" target="_blank">查看报表</a>`);
      showNextWeekHint(panel, startDate, endDate, 'qiyu-online');
    }
  }


  async function copyTextWithFallback(value) {
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(value);
        return true;
      } catch (e) { /* 继续使用兼容旧浏览器/HTTP 页面的方式 */ }
    }
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.setAttribute('readonly', '');
    textarea.style.cssText = 'position:fixed;left:-9999px;top:0;';
    document.body.appendChild(textarea);
    textarea.select();
    let copied = false;
    try { copied = document.execCommand('copy'); } catch (e) { /* 使用 prompt 兜底 */ }
    textarea.remove();
    if (!copied) window.prompt('请手动复制日期：', value);
    return copied;
  }

  // 显示"下一周"提示，方便补抓历史数据
  function showNextWeekHint(panel, curStart, curEnd, mode) {
    // 上一周 = 当前周往前推 7 天
    const prevStart = new Date(curStart); prevStart.setDate(prevStart.getDate() - 7);
    const prevEnd = new Date(curEnd); prevEnd.setDate(prevEnd.getDate() - 7);
    const prevStartStr = fmtIsoDate(prevStart);
    const prevEndStr = fmtIsoDate(prevEnd);
    const prevLabel = fmtPeriod(prevStart, prevEnd);

    let hintText, copyText;
    if (mode === 'polaris') {
      // Polaris 结束日期不含当天，需要 +1 天
      const polarisEnd = new Date(prevEnd); polarisEnd.setDate(polarisEnd.getDate() + 1);
      copyText = `${prevStartStr} / ${fmtIsoDate(polarisEnd)}`;
      hintText = `📋 下一周（${prevLabel}）请选：\n${copyText}\n\n选好后等页面刷新，再点书签`;
    } else if (mode === 'ts-analytics') {
      copyText = `${prevStartStr} 至 ${prevEndStr}`;
      hintText = `📋 下一周（${prevLabel}）请选：\n开始：${prevStartStr}\n结束：${prevEndStr}\n\n点击下方按钮可自动填入，之后点击页面“刷新数据”，再点书签`;
    } else {
      copyText = `${prevStartStr} 至 ${prevEndStr}`;
      hintText = `📋 下一周（${prevLabel}）请选：\n开始：${prevStartStr}\n结束：${prevEndStr}\n\n选好后等页面刷新，再点书签`;
    }

    const wrapper = document.createElement('div');
    wrapper.id = 'dr-next-hint';
    wrapper.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:2147483647;background:#e6f7ff;border:2px solid #1890ff;border-radius:12px;padding:24px;box-shadow:0 8px 32px rgba(0,0,0,0.25);font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;font-size:14px;color:#333;max-width:480px;width:90%;';
    const titleDiv = document.createElement('div');
    titleDiv.style.cssText = 'font-size:15px;font-weight:600;margin-bottom:12px;color:#0050b3;';
    titleDiv.textContent = `✅ 已写入 ${fmtPeriod(curStart, curEnd)}`;
    const msgDiv = document.createElement('div');
    msgDiv.style.cssText = 'margin-bottom:14px;white-space:pre-wrap;line-height:1.8;background:#fff;padding:12px;border-radius:6px;border:1px dashed #91d5ff;';
    msgDiv.textContent = hintText;
    const copyBtn = document.createElement('button');
    copyBtn.textContent = mode === 'ts-analytics' ? '自动填入上一周' : '📋 复制日期';
    copyBtn.style.cssText = 'padding:10px 24px;background:#1890ff;color:#fff;border:none;border-radius:6px;font-size:14px;cursor:pointer;font-weight:600;margin-right:8px;';
    copyBtn.onclick = async () => {
      if (mode === 'ts-analytics') {
        if (tsAnalyticsSetDateRange(prevStartStr, prevEndStr)) {
          copyBtn.textContent = '✓ 已填入，请点刷新数据';
          setTimeout(() => wrapper.remove(), 1200);
          return;
        }
      }
      const copied = await copyTextWithFallback(copyText);
      if (copied) {
        copyBtn.textContent = '✓ 已复制';
        setTimeout(() => { copyBtn.textContent = '📋 复制日期'; }, 1500);
      }
    };
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✗ 关闭';
    closeBtn.style.cssText = 'padding:10px 24px;background:#f5f5f5;color:#666;border:1px solid #d9d9d9;border-radius:6px;font-size:14px;cursor:pointer;';
    closeBtn.onclick = () => wrapper.remove();
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'text-align:center;';
    btnRow.appendChild(copyBtn);
    btnRow.appendChild(closeBtn);
    wrapper.appendChild(titleDiv);
    wrapper.appendChild(msgDiv);
    wrapper.appendChild(btnRow);
    document.body.appendChild(wrapper);
  }


  // ============== GitHub 读写 ==============
  async function readDataJson() {
    const apiUrl = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/data.json`;
    const headers = { Authorization: 'token ' + PAT, Accept: 'application/vnd.github+json' };
    const res = await fetch(apiUrl, { headers });
    if (!res.ok) throw new Error('GitHub GET ' + res.status + '（PAT 是否正确？）');
    const fileInfo = await res.json();
    const text = decodeURIComponent(escape(atob(fileInfo.content.replace(/\n/g, ''))));
    return { data: JSON.parse(text), sha: fileInfo.sha };
  }
  async function writeDataJson(data, sha, message) {
    const apiUrl = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/data.json`;
    const headers = { Authorization: 'token ' + PAT, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' };
    const newText = JSON.stringify(data, null, 2);
    const res = await fetch(apiUrl, { method: 'PUT', headers, body: JSON.stringify({ message, content: btoa(unescape(encodeURIComponent(newText))), sha }) });
    if (!res.ok) throw new Error('GitHub PUT ' + res.status + '：' + (await res.text()).slice(0, 200));
  }
  function mergeWeekEntry(data, weekEntry) {
    const idx = data.weeks.findIndex((w) => w.id === weekEntry.id);
    if (idx >= 0) {
      const ex = data.weeks[idx];
      data.weeks[idx] = { ...ex, ...weekEntry, current: { ...(ex.current || {}), ...weekEntry.current }, yoy: { ...(ex.yoy || {}), ...weekEntry.yoy } };
    } else { data.weeks.push(weekEntry); }
  }
  function recomputeAccumulatedP1(data, targetYears) {
    const years = targetYears ? new Set(targetYears) : null;
    const byYear = {};
    (data.weeks || []).forEach((w) => {
      const startYear = (w.startDate || '').slice(0, 4);
      if (!/^\d{4}$/.test(startYear)) return;
      if (years && !years.has(startYear)) return;
      if (!byYear[startYear]) byYear[startYear] = [];
      byYear[startYear].push(w);
    });
    Object.values(byYear).forEach((weeks) => {
      let total = 0;
      weeks
        .slice()
        .sort((a, b) => (a.startDate || '').localeCompare(b.startDate || ''))
        .forEach((w) => {
          const cur = w.current || {};
          if (typeof cur.p1Orders !== 'number') return;
          total += cur.p1Orders;
          w.current = { ...cur, accumulatedP1: total };
        });
    });
  }

  // ============== 浮动面板 ==============
  function createPanel() {
    const old = document.getElementById('dr-collector-host');
    if (old) old.remove();
    const host = document.createElement('div');
    host.id = 'dr-collector-host';
    host.style.cssText = 'all:initial;position:fixed;top:20px;right:20px;z-index:2147483647;font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;';
    const sh = host.attachShadow({ mode: 'closed' });
    sh.innerHTML = `<style>
      :host{all:initial}.panel{width:460px;max-height:80vh;overflow-y:auto;background:#fff;border:1px solid #d9d9d9;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.15);font-size:13px;color:#333}
      .header{padding:12px 16px;background:#1890ff;color:#fff;display:flex;justify-content:space-between;align-items:center;font-weight:600;position:sticky;top:0;z-index:1}
      .close{cursor:pointer;font-size:20px;opacity:.85;line-height:1}.close:hover{opacity:1}
      .body{padding:14px 16px;line-height:1.6}.meta{font-size:12px;color:#888;margin-bottom:10px;white-space:pre-wrap}
      .status{margin:8px 0;padding:8px 12px;border-radius:6px}.status.info{background:#e6f7ff;color:#096dd9}.status.success{background:#f6ffed;color:#389e0d}.status.error{background:#fff1f0;color:#cf1322}
      .week-block{margin:10px 0;padding:10px 12px;background:#fafafa;border-radius:6px;border:1px solid #f0f0f0}
      .week-block .week-title{font-weight:600;margin-bottom:6px}.row{display:flex;justify-content:space-between;padding:3px 0;font-size:12px}
      .name{color:#666}.value{font-weight:600}
      .delta-up{color:#f5222d;margin-left:6px;font-size:11px}.delta-down{color:#52c41a;margin-left:6px;font-size:11px}.delta-flat{color:#999;margin-left:6px;font-size:11px}
      .btn{display:inline-block;padding:6px 14px;background:#1890ff;color:#fff!important;border-radius:4px;text-decoration:none!important;font-size:13px;margin-top:10px;cursor:pointer}.btn:hover{background:#40a9ff}
      .progress{height:4px;background:#e8e8e8;border-radius:2px;margin:8px 0;overflow:hidden}.progress-bar{height:100%;background:#1890ff;transition:width .3s;width:0%}
    </style>
    <div class="panel"><div class="header"><span>售后周报数据采集器</span><span class="close" id="closeBtn">×</span></div>
    <div class="body"><div class="meta" id="meta">初始化…</div><div class="status info" id="status">正在准备…</div><div class="progress"><div class="progress-bar" id="progressBar"></div></div><div id="details"></div></div></div>`;
    document.body.appendChild(host);
    sh.getElementById('closeBtn').onclick = () => host.remove();
    return {
      setMeta: (t) => { sh.getElementById('meta').textContent = t; },
      setStatus: (t, type='info') => { const el = sh.getElementById('status'); el.textContent = t; el.className = 'status ' + type; },
      setProgress: (pct) => { const el = sh.getElementById('progressBar'); if (el) el.style.width = pct + '%'; },
      appendDetail: (h) => { sh.getElementById('details').insertAdjacentHTML('beforeend', h); },
      setHTML: (h) => { sh.getElementById('details').innerHTML = h; },
      close: () => host.remove()
    };
  }

  // ============== Jira 批量 ==============
  async function runJiraCollection(panel) {
    let baseWin = getCurrentWindow();
    if (BACKFILL <= 1) {
      panel.setMeta('Jira · 选择取数日期');
      panel.setStatus('等待确认取数日期...', 'info');
      const selectedWin = await waitForDateRange(baseWin);
      if (!selectedWin) {
        panel.setStatus('已取消。', 'info');
        return;
      }
      baseWin = selectedWin;
    }
    const tasks = [];
    for (let i = 0; i < BACKFILL; i++) { tasks.push({ cur: shiftWindow(baseWin, i), yoy: getYoYWindow(shiftWindow(baseWin, i)) }); }
    panel.setMeta(BACKFILL > 1 ? `Jira · 将抓取 ${BACKFILL} 周` : `Jira · ${fmtIsoDate(baseWin.start)} 至 ${fmtIsoDate(baseWin.end)}`);
    const totalSteps = tasks.length * 2; let done = 0; const weekEntries = [];
    for (let i = 0; i < tasks.length; i++) {
      const { cur, yoy } = tasks[i];
      const label = fmtPeriod(cur.start, cur.end), yoyLabel = fmtPeriod(yoy.start, yoy.end);
      panel.setStatus(`[${i+1}/${tasks.length}] 抓取 ${label}...`, 'info');
      const curData = await fetchJiraWindow(cur); done++; panel.setProgress((done/totalSteps)*100);
      panel.setStatus(`[${i+1}/${tasks.length}] 抓取同期 ${yoyLabel}...`, 'info');
      const yoyData = await fetchJiraWindow(yoy); done++; panel.setProgress((done/totalSteps)*100);
      const rows = JIRA_DISPLAY.map(m => {
        const c = curData[m.key], y = yoyData[m.key];
        const cTxt = fmtMetric(c, m.percent), yTxt = fmtMetric(y, m.percent);
        let d = '';
        if (c != null && y != null && y !== 0) { const s = c > y ? '↑' : c < y ? '↓' : '→'; const cls = c > y ? 'up' : c < y ? 'down' : 'flat'; d = `<span class="delta-${cls}">${s}${Math.abs((c - y) / y * 100).toFixed(1)}%</span>`; }
        return `<div class="row"><span class="name">${m.name}</span><span class="value">${cTxt} <span style="color:#999;font-size:11px">(${yTxt})</span>${d}</span></div>`;
      }).join('');
      panel.appendDetail(`<div class="week-block"><div class="week-title">${label} vs ${yoyLabel}</div>${rows}</div>`);
      weekEntries.push({ id: `${cur.end.getFullYear()}-w${pad(isoWeek(cur.end))}`, label, startDate: fmtIsoDate(cur.start), endDate: fmtIsoDate(cur.end), tags: [], current: curData, yoy: { label: yoyLabel, ...yoyData } });
    }
    panel.setStatus('写入 GitHub...', 'info');
    const { data, sha } = await readDataJson();
    weekEntries.forEach(e => mergeWeekEntry(data, e));
    recomputeAccumulatedP1(data, weekEntries.map((e) => (e.startDate || '').slice(0, 4)));
    data.weeks.sort((a, b) => (b.startDate||'').localeCompare(a.startDate||''));
    data.meta.lastUpdated = new Date().toISOString();
    await writeDataJson(data, sha, `chore: jira ${weekEntries.length} weeks`);
    panel.setStatus(`✅ ${weekEntries.length} 周 Jira 数据已写入！`, 'success');
    panel.appendDetail(`<a class="btn" href="${PAGES_URL}" target="_blank">查看报表</a>`);
  }

  // ============== Polaris（内网数据平台）==============
  function polarisReadDate() {
    // 日期格式: "2026-05-08 / 2026-05-15" 在一个 input 里
    const inputs = document.querySelectorAll('input');
    for (const el of inputs) {
      if (el.value && el.value.indexOf(' / ') >= 0) {
        const parts = el.value.split(' / ');
        if (parts.length === 2 && parts[0].length === 10) {
          return { start: parts[0].trim(), end: parts[1].trim() };
        }
      }
    }
    throw new Error('找不到日期输入框（格式应为 YYYY-MM-DD / YYYY-MM-DD）');
  }

  function polarisParseData() {
    const text = document.body.innerText;
    const lines = text.split('\n');
    // 找"合计"行，它后面的数字依次是：提单量、自行解决量、自行解决率、...
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === '合计') {
        // 合计后面的几行是 tab 分隔或换行分隔的数字
        // 从后续行中提取数字
        const nums = [];
        for (let j = i + 1; j < Math.min(i + 20, lines.length); j++) {
          const val = lines[j].trim();
          if (val === '') continue;
          if (/^\d+$/.test(val) || /^[\d.]+$/.test(val)) {
            nums.push(val);
          } else if (val.match(/^[\d\s\t.]+$/)) {
            // 可能一行里有多个数字用 tab 分隔
            val.split(/\s+/).forEach(v => { if (v) nums.push(v); });
          } else {
            break; // 遇到非数字行停止
          }
          if (nums.length >= 8) break;
        }
        // nums[0]=提单量, nums[1]=自行解决量, nums[2]=自行解决率, ...
        if (nums.length >= 3) {
          const firstLineOrders = parseInt(nums[0]) || 0;
          const firstLineResolveRate = parseFloat(nums[2]) || 0;
          return { firstLineOrders, firstLineResolveRate };
        }
      }
    }
    throw new Error('无法解析一线提单量/自行解决率。请确认在"JIRA工单解决率 → CS工单量及解决量"页面，且能看到"合计"行。');
  }

  async function runPolarisCollection(panel) {
    panel.setMeta('Polaris · JIRA工单解决率');

    // 读取日期（结束日期不包含当天，实际范围 = start ~ end-1天）
    const dates = polarisReadDate();
    const startStr = dates.start;
    const endRaw = dates.end;
    // 实际数据结束日 = endRaw 前一天
    const endDate = new Date(endRaw + 'T00:00:00');
    endDate.setDate(endDate.getDate() - 1);
    const endStr = fmtIsoDate(endDate);

    const startDate = new Date(startStr + 'T00:00:00');
    const weekId = `${endDate.getFullYear()}-w${pad(isoWeek(endDate))}`;
    const label = fmtPeriod(startDate, endDate);

    // 确认
    const confirmMsg = `请确认以下信息：\n\n📅 页面日期：${dates.start} / ${dates.end}\n📅 实际数据范围：${startStr} 至 ${endStr}（结束日不含当天）\n📊 页面：JIRA工单解决率 · CS工单量\n🏷️ 将写入周期：${label}\n\n确认无误后点击"确认抓取"`;
    panel.setStatus('等待确认...', 'info');
    const confirmed = await waitForConfirm(panel, confirmMsg);

    if (!confirmed) {
      panel.setStatus('已取消。', 'info');
      return;
    }

    panel.setStatus('正在解析页面数据...', 'info');
    const data = polarisParseData();
    panel.appendDetail(`<div class="week-block">
      <div class="week-title">${label} · CS工单</div>
      <div class="row"><span class="name">一线提单量</span><span class="value">${data.firstLineOrders}</span></div>
      <div class="row"><span class="name">一线自行处理率</span><span class="value">${(data.firstLineResolveRate * 100).toFixed(2)}%</span></div>
    </div>`);

    // 写入 GitHub
    panel.setStatus('正在写入 GitHub...', 'info');
    const { data: json, sha } = await readDataJson();
    const weekEntry = { id: weekId, label, startDate: startStr, endDate: endStr, tags: [], current: data, yoy: {} };
    mergeWeekEntry(json, weekEntry);
    json.weeks.sort((a, b) => (b.startDate || '').localeCompare(a.startDate || ''));
    json.meta.lastUpdated = new Date().toISOString();
    await writeDataJson(json, sha, `chore: polaris firstLine data ${label}`);
    panel.setStatus('✅ 一线提单量 + 自行处理率已写入 GitHub！', 'success');
    panel.appendDetail(`<a class="btn" href="${PAGES_URL}" target="_blank">查看报表</a>`);
    showNextWeekHint(panel, startDate, endDate, 'polaris');
  }

  // ============== 售后工单数据分析平台（TS 数据）==============
  function tsAnalyticsDateInputs() {
    return Array.from(document.querySelectorAll('input'))
      .filter((el) => /^\d{4}[-/]\d{2}[-/]\d{2}$/.test((el.value || '').trim()));
  }

  function tsAnalyticsReadDate() {
    const inputs = tsAnalyticsDateInputs();
    if (inputs.length < 2) {
      throw new Error('找不到时间范围。请确认页面顶部已选择开始和结束日期。');
    }
    return {
      start: inputs[0].value.trim().replace(/\//g, '-'),
      end: inputs[1].value.trim().replace(/\//g, '-')
    };
  }

  function tsAnalyticsSetDateRange(start, end) {
    const inputs = tsAnalyticsDateInputs();
    if (inputs.length < 2) return false;
    [start, end].forEach((isoValue, index) => {
      const input = inputs[index];
      const value = input.type === 'date' ? isoValue : isoValue.replace(/-/g, input.value.indexOf('/') >= 0 ? '/' : '-');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
      if (setter && setter.set) setter.set.call(input, value);
      else input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new Event('blur', { bubbles: true }));
    });
    return true;
  }

  function tsAnalyticsParseData() {
    const text = document.body.innerText.replace(/\r/g, '');
    const ordersMatch = text.match(/TS\s*接单量\s*\n\s*([\d,]+)/i);
    const rateMatch = text.match(/周解决率\s*\n\s*([\d.]+)\s*%/);
    if (!ordersMatch || !rateMatch) {
      throw new Error('无法解析 TS 接单量/周解决率。请打开“TS 数据”页签并等待页面刷新完成。');
    }
    return {
      secondLineOrders: parseInt(ordersMatch[1].replace(/,/g, ''), 10),
      secondLineResolveRate: +(parseFloat(rateMatch[1]) / 100).toFixed(4)
    };
  }

  async function runTsAnalyticsCollection(panel) {
    panel.setMeta('售后工单数据分析平台 · TS 数据');
    const bodyText = document.body.innerText;
    if (bodyText.indexOf('TS 接单量') < 0 || bodyText.indexOf('周解决率') < 0) {
      panel.setStatus('请先打开“TS 数据”页签，并点击页面上的“刷新数据”。', 'error');
      return;
    }

    const dates = tsAnalyticsReadDate();
    const startDate = new Date(dates.start + 'T00:00:00');
    const endDate = new Date(dates.end + 'T23:59:59');
    if (startDate > endDate) throw new Error('开始日期不能晚于结束日期。');

    const data = tsAnalyticsParseData();
    const weekId = `${endDate.getFullYear()}-w${pad(isoWeek(endDate))}`;
    const label = fmtPeriod(startDate, endDate);
    const confirmMsg = `请确认以下信息：\n\n📅 页面日期：${dates.start} 至 ${dates.end}\n📊 页面：售后工单数据分析平台 · TS 数据\n🏷️ 将写入周期：${label}\n\n📈 读取到的数据：\n   二线接单量：${data.secondLineOrders}\n   二线周解决率：${(data.secondLineResolveRate * 100).toFixed(1)}%\n\n请核对与页面卡片一致后确认。`;

    panel.setStatus('等待确认...', 'info');
    const confirmed = await waitForConfirm(panel, confirmMsg);
    if (!confirmed) {
      panel.setStatus('已取消。', 'info');
      return;
    }

    panel.appendDetail(`<div class="week-block">
      <div class="week-title">${label} · TS 数据</div>
      <div class="row"><span class="name">二线接单量</span><span class="value">${data.secondLineOrders}</span></div>
      <div class="row"><span class="name">二线周解决率</span><span class="value">${(data.secondLineResolveRate * 100).toFixed(1)}%</span></div>
    </div>`);

    panel.setStatus('正在写入 GitHub...', 'info');
    const { data: json, sha } = await readDataJson();
    const weekEntry = {
      id: weekId,
      label,
      startDate: dates.start,
      endDate: dates.end,
      tags: [],
      current: data,
      yoy: {}
    };
    mergeWeekEntry(json, weekEntry);
    json.weeks.sort((a, b) => (b.startDate || '').localeCompare(a.startDate || ''));
    json.meta.lastUpdated = new Date().toISOString();
    await writeDataJson(json, sha, `chore: ts analytics data ${label}`);
    panel.setStatus('✅ 二线接单量 + 二线周解决率已写入 GitHub！', 'success');
    panel.appendDetail(`<a class="btn" href="${PAGES_URL}" target="_blank">查看报表</a>`);
    showNextWeekHint(panel, startDate, endDate, 'ts-analytics');
  }

  // ============== 主入口 ==============
  async function main() {
    const panel = createPanel();
    if (!PAT) { panel.setStatus('未检测到 GitHub Token。请到 tools.html 配置。', 'error'); return; }
    const host = location.hostname;
    panel.setMeta(`当前：${host}${BACKFILL > 1 ? ' · 补抓 ' + BACKFILL + ' 周' : ''}`);
    try {
      if (host.indexOf('jira') >= 0) { await runJiraCollection(panel); }
      else if (host.indexOf('qiyukf') >= 0 || host.indexOf('163yun') >= 0) { await runQiyuCollection(panel); }
      else if (host.indexOf('polaris') >= 0 || host.indexOf('icoremail') >= 0) { await runPolarisCollection(panel); }
      else if (
        host === '192.168.212.151' ||
        document.body.innerText.indexOf('售后工单数据分析平台') >= 0
      ) { await runTsAnalyticsCollection(panel); }
      else { panel.setStatus('暂未支持当前域名（' + host + '）。\n支持：Jira / 七鱼 / Polaris / 售后工单数据分析平台', 'info'); }
    } catch (err) { panel.setStatus('❌ ' + err.message, 'error'); }
  }

  main().catch(err => alert('采集器错误：' + err.message)).finally(() => { window.__DR_COLLECTOR_RUNNING = false; });
})();
