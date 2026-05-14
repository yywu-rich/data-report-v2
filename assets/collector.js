/* ============================================================
 * 售后周报数据采集器 (collector.js)
 * 支持平台：jira.mailtech.cn / coremail.qiyukf.com
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
  function isoWeek(d) {
    const x = new Date(d); x.setHours(0,0,0,0);
    x.setDate(x.getDate() + 3 - (x.getDay() + 6) % 7);
    const w1 = new Date(x.getFullYear(), 0, 4);
    return 1 + Math.round(((x - w1) / 86400000 - 3 + (w1.getDay() + 6) % 7) / 7);
  }
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ============== Jira ==============
  const JIRA_QUERIES = [
    { key: 'p1Orders', name: 'P1工单数', jql: 'project = CS AND issuetype = "客户服务请求" AND "故障等级" = "P1-严重" AND created >= "{{s}}" AND created < "{{eExc}}"' },
    { key: 'securityIssues', name: '安全问题', jql: 'project = CS AND issuetype = "客户服务请求" AND "故障等级" = "安全问题" AND created >= "{{s}}" AND created < "{{eExc}}"' },
    { key: 'wechatOrders', name: '企微来源工单', jql: 'project = CS AND issuetype = "客户服务请求" AND 来源 = "微信小助手" AND created >= "{{s}}" AND created < "{{eExc}}"' },
    { key: 'wechatP4Orders', name: 'P4工单（企微）', jql: 'project = CS AND issuetype = "客户服务请求" AND "故障等级" = "P4-咨询" AND 来源 = "微信小助手" AND created >= "{{s}}" AND created < "{{eExc}}"' }
  ];
  async function jiraCount(jql) {
    const url = '/rest/api/2/search?jql=' + encodeURIComponent(jql) + '&maxResults=0';
    const res = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('Jira API ' + res.status);
    return (await res.json()).total;
  }
  async function fetchJiraWindow(win) {
    const eExc = new Date(win.end); eExc.setHours(0,0,0,0); eExc.setDate(eExc.getDate() + 1);
    const params = { s: fmtJqlDate(win.start), eExc: fmtJqlDate(eExc) };
    const result = {};
    for (const q of JIRA_QUERIES) {
      let jql = q.jql;
      Object.entries(params).forEach(([k, v]) => { jql = jql.split('{{'+k+'}}').join(v); });
      result[q.key] = await jiraCount(jql);
    }
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

  // 从页面输入框读取当前日期
  function qiyuReadDate() {
    const inputs = document.querySelectorAll('input.fishd-input');
    if (inputs.length < 2) throw new Error('找不到日期输入框');
    return { start: inputs[0].value, end: inputs[1].value };
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

  // 等待用户确认的 Promise（用 DOM 直接创建按钮，避免 shadow DOM 查找问题）
  function waitForConfirm(panel, message) {
    return new Promise((resolve) => {
      const wrapper = document.createElement('div');
      wrapper.style.cssText = 'margin:12px 0;padding:12px;background:#fffbe6;border:1px solid #ffe58f;border-radius:6px;';
      const msgDiv = document.createElement('div');
      msgDiv.style.cssText = 'font-size:13px;margin-bottom:10px;white-space:pre-wrap;';
      msgDiv.textContent = message;
      const confirmBtn = document.createElement('button');
      confirmBtn.textContent = '✓ 确认抓取';
      confirmBtn.style.cssText = 'padding:8px 20px;background:#1890ff;color:#fff;border:none;border-radius:4px;font-size:13px;cursor:pointer;margin-right:8px;';
      const cancelBtn = document.createElement('button');
      cancelBtn.textContent = '✗ 取消';
      cancelBtn.style.cssText = 'padding:8px 20px;background:#f5f5f5;color:#666;border:1px solid #d9d9d9;border-radius:4px;font-size:13px;cursor:pointer;';
      confirmBtn.onclick = () => { wrapper.remove(); resolve(true); };
      cancelBtn.onclick = () => { wrapper.remove(); resolve(false); };
      wrapper.appendChild(msgDiv);
      wrapper.appendChild(confirmBtn);
      wrapper.appendChild(cancelBtn);
      // 直接插入到页面主 DOM（不在 shadow DOM 里）
      const host = document.getElementById('dr-collector-host');
      host.appendChild(wrapper);
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

    // 弹出确认
    panel.setMeta(`七鱼 · ${pageType}`);
    const confirmMsg = `请确认以下信息：\n\n📅 日期范围：${startStr} 至 ${endStr}\n👥 客服组：${group}\n📊 页面类型：${pageType}\n🏷️ 将写入周期：${label}\n\n确认无误后点击"确认抓取"`;
    panel.setStatus('等待确认...', 'info');
    const confirmed = await waitForConfirm(panel, confirmMsg);

    if (!confirmed) {
      panel.setStatus('已取消。请调整日期/客服组后重新点击书签。', 'info');
      return;
    }

    if (isCallCenter) {
      // 检查客服组
      if (!qiyuCheckGroup()) {
        panel.setStatus('⚠️ 当前客服组不是"售后服务"！请先手动选择后重新点击书签。', 'error');
        return;
      }

      // 直接抓取当前页面数据（不改日期）
      panel.setStatus('正在解析页面数据...', 'info');
      const data = qiyuParseCallData();
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

    } else if (isOnlineOverview) {
      // 直接抓取当前页面数据（不改日期）
      panel.setStatus('正在解析企微会话量...', 'info');
      const wechatSessions = qiyuParseWechatSessions();
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
    }
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
    const baseWin = getCurrentWindow();
    const tasks = [];
    for (let i = 0; i < BACKFILL; i++) { tasks.push({ cur: shiftWindow(baseWin, i), yoy: getYoYWindow(shiftWindow(baseWin, i)) }); }
    panel.setMeta(`Jira · 将抓取 ${BACKFILL} 周`);
    const totalSteps = tasks.length * 2; let done = 0; const weekEntries = [];
    for (let i = 0; i < tasks.length; i++) {
      const { cur, yoy } = tasks[i];
      const label = fmtPeriod(cur.start, cur.end), yoyLabel = fmtPeriod(yoy.start, yoy.end);
      panel.setStatus(`[${i+1}/${tasks.length}] 抓取 ${label}...`, 'info');
      const curData = await fetchJiraWindow(cur); done++; panel.setProgress((done/totalSteps)*100);
      panel.setStatus(`[${i+1}/${tasks.length}] 抓取同期 ${yoyLabel}...`, 'info');
      const yoyData = await fetchJiraWindow(yoy); done++; panel.setProgress((done/totalSteps)*100);
      const rows = JIRA_QUERIES.map(q => { const c=curData[q.key],y=yoyData[q.key]; let d=''; if(c!=null&&y!=null&&y!==0){const s=c>y?'↑':c<y?'↓':'→';const cls=c>y?'up':c<y?'down':'flat';d=`<span class="delta-${cls}">${s}${Math.abs((c-y)/y*100).toFixed(1)}%</span>`;} return `<div class="row"><span class="name">${q.name}</span><span class="value">${c} <span style="color:#999;font-size:11px">(${y})</span>${d}</span></div>`; }).join('');
      panel.appendDetail(`<div class="week-block"><div class="week-title">${label} vs ${yoyLabel}</div>${rows}</div>`);
      weekEntries.push({ id: `${cur.end.getFullYear()}-w${pad(isoWeek(cur.end))}`, label, startDate: fmtIsoDate(cur.start), endDate: fmtIsoDate(cur.end), tags: [], current: curData, yoy: { label: yoyLabel, ...yoyData } });
    }
    panel.setStatus('写入 GitHub...', 'info');
    const { data, sha } = await readDataJson();
    weekEntries.forEach(e => mergeWeekEntry(data, e));
    data.weeks.sort((a, b) => (b.startDate||'').localeCompare(a.startDate||''));
    data.meta.lastUpdated = new Date().toISOString();
    await writeDataJson(data, sha, `chore: jira ${weekEntries.length} weeks`);
    panel.setStatus(`✅ ${weekEntries.length} 周 Jira 数据已写入！`, 'success');
    panel.appendDetail(`<a class="btn" href="${PAGES_URL}" target="_blank">查看报表</a>`);
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
      else { panel.setStatus('暂未支持当前域名（' + host + '）。\n支持：jira.mailtech.cn / coremail.qiyukf.com', 'info'); }
    } catch (err) { panel.setStatus('❌ ' + err.message, 'error'); }
  }

  main().catch(err => alert('采集器错误：' + err.message)).finally(() => { window.__DR_COLLECTOR_RUNNING = false; });
})();
