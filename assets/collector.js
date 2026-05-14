/* ============================================================
 * 售后周报数据采集器 (collector.js)
 * 用法：通过 tools.html 生成的书签加载，自动检测当前平台并采集数据
 * ============================================================ */
(function () {
  'use strict';

  if (window.__DR_COLLECTOR_RUNNING) return;
  window.__DR_COLLECTOR_RUNNING = true;

  const PAT = window.__DR_PAT || '';
  const REPO_OWNER = 'yywu-rich';
  const REPO_NAME = 'data-report-v2';
  const PAGES_URL = 'https://yywu-rich.github.io/data-report-v2/';

  // ============== 时间窗口 ==============
  // 上周五 00:00 - 本周四 23:59:59，同期 -364 天
  function getCurrentWindow() {
    const end = new Date();
    do { end.setDate(end.getDate() - 1); } while (end.getDay() !== 4);
    end.setHours(23, 59, 59, 999);
    const start = new Date(end);
    start.setDate(start.getDate() - 6);
    start.setHours(0, 0, 0, 0);
    return { start, end };
  }
  function getYoYWindow(cur) {
    const start = new Date(cur.start); start.setDate(start.getDate() - 364);
    const end   = new Date(cur.end);   end.setDate(end.getDate() - 364);
    return { start, end };
  }
  const pad = (n) => String(n).padStart(2, '0');
  const fmtJqlDate = (d) =>
    `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const fmtIsoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  const fmtPeriod = (d1, d2) =>
    `${String(d1.getFullYear()).slice(-2)}年(${pad(d1.getMonth()+1)}.${pad(d1.getDate())}-${pad(d2.getMonth()+1)}.${pad(d2.getDate())})`;
  function isoWeek(d) {
    const x = new Date(d); x.setHours(0,0,0,0);
    x.setDate(x.getDate() + 3 - (x.getDay() + 6) % 7);
    const w1 = new Date(x.getFullYear(), 0, 4);
    return 1 + Math.round(((x - w1) / 86400000 - 3 + (w1.getDay() + 6) % 7) / 7);
  }

  // ============== Jira ==============
  const JIRA_QUERIES = [
    { key: 'p1Orders',       name: 'P1工单数',
      jql: 'project = CS AND issuetype = "客户服务请求" AND "故障等级" = "P1-严重" AND created >= "{{s}}" AND created < "{{eExc}}"' },
    { key: 'securityIssues', name: '安全问题',
      jql: 'project = CS AND issuetype = "客户服务请求" AND "故障等级" = "安全问题" AND created >= "{{s}}" AND created < "{{eExc}}"' },
    { key: 'wechatOrders',   name: '企微来源工单',
      jql: 'project = CS AND issuetype = "客户服务请求" AND 来源 = "微信小助手" AND created >= "{{s}}" AND created < "{{eExc}}"' },
    { key: 'wechatP4Orders', name: 'P4工单（企微）',
      jql: 'project = CS AND issuetype = "客户服务请求" AND "故障等级" = "P4-咨询" AND 来源 = "微信小助手" AND created >= "{{s}}" AND created < "{{eExc}}"' }
  ];

  async function jiraCount(jql) {
    const url = '/rest/api/2/search?jql=' + encodeURIComponent(jql) + '&maxResults=0';
    const res = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('Jira API ' + res.status + '：' + (await res.text()).slice(0, 200));
    const data = await res.json();
    return data.total;
  }
  async function fetchJiraWindow(win) {
    const eExc = new Date(win.end);
    eExc.setHours(0, 0, 0, 0);
    eExc.setDate(eExc.getDate() + 1);
    const params = { s: fmtJqlDate(win.start), eExc: fmtJqlDate(eExc) };
    const result = {};
    for (const q of JIRA_QUERIES) {
      let jql = q.jql;
      Object.entries(params).forEach(([k, v]) => { jql = jql.split(`{{${k}}}`).join(v); });
      result[q.key] = await jiraCount(jql);
    }
    return result;
  }

  // ============== GitHub data.json 写回 ==============
  async function updateDataJson(weekEntry) {
    const apiUrl = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/data.json`;
    const headers = { Authorization: 'token ' + PAT, Accept: 'application/vnd.github+json' };

    const getRes = await fetch(apiUrl, { headers });
    if (!getRes.ok) throw new Error('GitHub GET ' + getRes.status + '（PAT 是否正确？仓库名是否正确？）');
    const fileInfo = await getRes.json();
    const currentText = decodeURIComponent(escape(atob(fileInfo.content.replace(/\n/g, ''))));
    const data = JSON.parse(currentText);

    const idx = data.weeks.findIndex((w) => w.id === weekEntry.id);
    if (idx >= 0) {
      const ex = data.weeks[idx];
      data.weeks[idx] = {
        ...ex, ...weekEntry,
        current: { ...(ex.current || {}), ...weekEntry.current },
        yoy:     { ...(ex.yoy || {}),     ...weekEntry.yoy }
      };
    } else {
      data.weeks.unshift(weekEntry);
    }
    data.meta.lastUpdated = new Date().toISOString();

    const newText = JSON.stringify(data, null, 2);
    const putRes = await fetch(apiUrl, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `chore: auto-update ${weekEntry.label} via collector`,
        content: btoa(unescape(encodeURIComponent(newText))),
        sha: fileInfo.sha
      })
    });
    if (!putRes.ok) throw new Error('GitHub PUT ' + putRes.status + '：' + (await putRes.text()).slice(0, 200));
  }

  // ============== 浮动面板 ==============
  function createPanel() {
    const old = document.getElementById('dr-collector-host');
    if (old) old.remove();
    const host = document.createElement('div');
    host.id = 'dr-collector-host';
    host.style.cssText = 'all:initial;position:fixed;top:20px;right:20px;z-index:2147483647;font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;';
    const sh = host.attachShadow({ mode: 'closed' });
    sh.innerHTML = `
      <style>
        :host { all: initial; }
        .panel { width: 380px; background: #fff; border: 1px solid #d9d9d9; border-radius: 10px;
                 box-shadow: 0 8px 24px rgba(0,0,0,0.15); font-size: 13px; color: #333; overflow: hidden; }
        .header { padding: 12px 16px; background: #1890ff; color: #fff;
                  display: flex; justify-content: space-between; align-items: center; font-weight: 600; }
        .close { cursor: pointer; font-size: 20px; opacity: 0.85; line-height: 1; }
        .close:hover { opacity: 1; }
        .body { padding: 14px 16px; line-height: 1.6; }
        .meta { font-size: 12px; color: #888; margin-bottom: 10px; word-break: break-all; }
        .status { margin: 8px 0; padding: 8px 12px; border-radius: 6px; }
        .status.info { background: #e6f7ff; color: #096dd9; }
        .status.success { background: #f6ffed; color: #389e0d; }
        .status.error { background: #fff1f0; color: #cf1322; }
        .row { display: flex; justify-content: space-between; padding: 4px 0; border-bottom: 1px dashed #f0f0f0; }
        .row:last-child { border-bottom: none; }
        .name { color: #666; }
        .value { font-weight: 600; }
        .delta-up { color: #f5222d; margin-left: 6px; font-weight: 400; font-size: 12px; }
        .delta-down { color: #52c41a; margin-left: 6px; font-weight: 400; font-size: 12px; }
        .delta-flat { color: #999; margin-left: 6px; font-weight: 400; font-size: 12px; }
        .btn { display: inline-block; padding: 6px 14px; background: #1890ff; color: #fff !important;
               border-radius: 4px; text-decoration: none !important; font-size: 13px; margin-top: 10px; cursor: pointer; }
        .btn:hover { background: #40a9ff; }
        ul { margin: 4px 0 0 0; padding-left: 20px; }
        li { color: #666; }
      </style>
      <div class="panel">
        <div class="header">
          <span>售后周报数据采集器</span>
          <span class="close" id="closeBtn">×</span>
        </div>
        <div class="body">
          <div class="meta" id="meta">初始化…</div>
          <div class="status info" id="status">正在准备…</div>
          <div id="details"></div>
        </div>
      </div>`;
    document.body.appendChild(host);
    sh.getElementById('closeBtn').onclick = () => host.remove();
    return {
      setMeta:    (t) => { sh.getElementById('meta').textContent = t; },
      setStatus:  (t, type='info') => {
        const el = sh.getElementById('status'); el.textContent = t; el.className = 'status ' + type;
      },
      setHTML:    (h) => { sh.getElementById('details').innerHTML = h; },
      close:      () => host.remove()
    };
  }

  // ============== 主流程 ==============
  async function main() {
    const panel = createPanel();
    if (!PAT) {
      panel.setStatus('未检测到 GitHub Token。请到 tools.html 重新生成你的书签。', 'error');
      return;
    }
    const host = location.hostname;
    const cur = getCurrentWindow();
    const yoy = getYoYWindow(cur);
    const weekId = `${cur.end.getFullYear()}-w${pad(isoWeek(cur.end))}`;
    const label = fmtPeriod(cur.start, cur.end);
    const yoyLabel = fmtPeriod(yoy.start, yoy.end);
    panel.setMeta(`本期：${label} · 同期：${yoyLabel} · 当前页面：${host}`);

    // —— 平台路由 ——
    if (host.indexOf('jira.mailtech.cn') >= 0 || host.indexOf('jira') >= 0) {
      try {
        panel.setStatus('正在抓取 Jira 数据（4 个查询 × 2 个周期 = 8 次）...', 'info');
        const curData = await fetchJiraWindow(cur);
        const yoyData = await fetchJiraWindow(yoy);

        const detailsHtml = JIRA_QUERIES.map((q) => {
          const c = curData[q.key], y = yoyData[q.key];
          let delta = '';
          if (c != null && y != null && y !== 0) {
            const sign = c > y ? '↑' : c < y ? '↓' : '→';
            const cls = c > y ? 'up' : c < y ? 'down' : 'flat';
            delta = `<span class="delta-${cls}">${sign}${Math.abs(((c-y)/y*100)).toFixed(1)}%</span>`;
          }
          return `<div class="row"><span class="name">${q.name}</span><span class="value">${c} <span style="color:#999;font-size:12px;">(同期 ${y})</span>${delta}</span></div>`;
        }).join('');
        panel.setHTML(detailsHtml);
        panel.setStatus('✅ Jira 数据已抓取，正在写入 GitHub…', 'info');

        const weekEntry = {
          id: weekId, label,
          startDate: fmtIsoDate(cur.start), endDate: fmtIsoDate(cur.end),
          tags: [],
          current: curData,
          yoy: { label: yoyLabel, ...yoyData }
        };
        await updateDataJson(weekEntry);

        panel.setStatus(`✅ 已成功写入 GitHub！30 秒后报表生效。`, 'success');
        panel.setHTML(detailsHtml +
          `<a class="btn" href="${PAGES_URL}" target="_blank">查看报表</a>` +
          `<a class="btn" style="background:#666;margin-left:8px" href="https://github.com/${REPO_OWNER}/${REPO_NAME}/commits/main" target="_blank">查看提交记录</a>`);
      } catch (err) {
        panel.setStatus('❌ ' + err.message, 'error');
      }
    } else if (host.indexOf('qiyukf') >= 0 || host.indexOf('163yun') >= 0) {
      panel.setStatus('七鱼平台采集尚未接入。先用旧书签抓取后发给 AI。', 'info');
    } else if (host.indexOf('work.weixin') >= 0 || host.indexOf('qq.com') >= 0) {
      panel.setStatus('企微平台采集尚未接入。先用旧书签抓取后发给 AI。', 'info');
    } else {
      panel.setStatus(`暂未支持当前域名（${host}）。当前已支持：jira.mailtech.cn`, 'info');
    }
  }

  main()
    .catch((err) => alert('采集器错误：' + err.message))
    .finally(() => { window.__DR_COLLECTOR_RUNNING = false; });
})();
