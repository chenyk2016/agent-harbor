/** V4独立交互稿。只操作示例内存，不读取凭证、不访问V3、不调用模型。 */
const $ = selector => document.querySelector(selector);
const icon = name => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const active = status => ['accepted', 'running', 'stopping', 'finalizing'].includes(status);
const labels = { ready: '环境可用', closed: '环境已关闭', starting: '准备环境中', stopping: '正在关闭', reconciling: '状态待确认' };
const statuses = { succeeded: '本轮已完成', running: '正在执行', accepted: '已接收', stopping: '正在停止', finalizing: '正在收尾', cancelled: '本轮已停止', failed: '执行失败', interrupted: '执行已中断', reconciling: '状态待确认', empty: '等待开始' };
const time = () => new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
const newId = () => crypto.randomUUID();
const sampleResult = `<p>已完成参数校验检查，并补充了对应的测试用例。</p><h3>本轮处理</h3><ul><li>补充订单数量的边界检查，拒绝零值和负数。</li><li>统一缺失参数时的错误返回，保持现有接口格式。</li><li>新增正常输入、边界输入和缺失字段的回归用例。</li></ul><div class="code-block">检查结果（示例）\n  12 个测试用例通过\n  0 个失败\n  原有接口行为保持兼容</div><p>建议下一步核对业务侧的数量上限。如果需要，我可以继续补充这一部分的校验。</p>`;
function seed() {
  return [
    { id: 'ah-demo-order', title: '订单服务参数校验', preview: '补充边界检查与回归测试', status: 'succeeded', env: 'ready', updated: '刚刚', created: '今天 10:24', events: ['本轮执行结束', '发起 Bash 调用', '发起 Edit 调用', '消息已接收'], messages: [
      { role: 'user', text: '检查订单服务的参数校验，补充必要的测试，并给出本轮修改说明。请先阅读项目约定，保持现有接口格式。', at: '10:24' },
      { role: 'assistant', html: sampleResult, tools: ['Read', 'Edit', 'Bash'], at: '10:26', finished: true },
    ] },
    { id: 'ah-demo-report', title: '季度经营数据核对', preview: '正在核对字段与统计口径', status: 'running', env: 'ready', updated: '2分钟前', created: '今天 10:18', events: ['发起 Read 调用', '本轮开始执行', '消息已接收'], messages: [
      { role: 'user', text: '核对当前工作区里季度报表的字段与统计口径，列出需要人工确认的差异。', at: '10:18' },
      { role: 'assistant', text: '我会先阅读数据说明与已有汇总，再区分可以核实的差异和需要你确认的口径。', tools: ['Read'], at: '10:19', streaming: true },
    ] },
    { id: 'ah-demo-knowledge', title: '知识库接入方案', preview: '对话已保存，工作环境已关闭', status: 'succeeded', env: 'closed', updated: '昨天', created: '昨天 16:40', events: ['工作环境已关闭', '本轮执行结束', '消息已接收'], messages: [
      { role: 'user', text: '整理一个内部知识库接入方案，先说明数据来源、更新方式和检索流程。', at: '16:40' },
      { role: 'assistant', text: '方案已按数据接入、索引更新、检索与验证四个部分整理。\n\n接下来需要确认资料来源及访问权限，再开展实际接入。', at: '16:43', finished: true },
    ] },
    { id: 'ah-demo-login', title: '登录流程回归检查', preview: '本轮失败，可查看已保存进度', status: 'failed', env: 'closed', updated: '昨天', created: '昨天 15:12', events: ['本轮执行失败', '工作环境已关闭', '消息已接收'], messages: [
      { role: 'user', text: '阅读登录模块的测试说明，检查回归测试需要哪些配置。', at: '15:12' },
      { role: 'assistant', text: '已阅读测试说明。后续执行出现异常，本轮未完成。\n\n已保存的回答仍可查看；请检查运行记录和所需配置后，再发送新的明确任务。', at: '15:13', failed: true },
    ] },
  ];
}
let sessions = seed();
let selected = sessions[0].id;
let view = 'chat';
let connected = true;
let reconnecting = false;
let offlineSnapshot;
let pendingClose;
let toastTimer;
const drafts = new Map();
const jobs = new Map();
const current = () => sessions.find(session => session.id === selected);
const visible = () => (connected ? sessions : offlineSnapshot).find(session => session.id === selected) ?? current();

function tag(session) {
  const status = session.status;
  const tint = active(status) ? 'running' : status === 'failed' ? 'failed' : status === 'reconciling' ? 'unknown' : '';
  const dot = active(status) ? 'blue pulse' : status === 'failed' ? 'red' : status === 'reconciling' ? 'amber' : '';
  return `<span class="status-tag ${tint}"><span class="dot ${dot}"></span>${escape(statuses[status] ?? status)}</span>`;
}
function notify(text) {
  $('#toast').textContent = text;
  $('#toast').classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 2600);
}
function renderSidebar() {
  const query = $('#search').value.trim().toLowerCase();
  const source = connected ? sessions : offlineSnapshot;
  const filtered = source.filter(session => (session.title + session.preview).toLowerCase().includes(query));
  $('#session-count').textContent = source.length;
  $('#recent-count').textContent = `${filtered.length} 个`;
  $('#session-list').innerHTML = filtered.map(session => `<button class="session-item ${session.id === selected && view === 'chat' ? 'selected' : ''}" data-session="${session.id}" ${session.id === selected ? 'aria-current="page"' : ''}><span class="dot ${active(session.status) ? 'blue pulse' : session.status === 'failed' ? 'red' : session.status === 'reconciling' ? 'amber' : ''}"></span><span class="session-copy"><span class="session-title">${escape(session.title)}</span><span class="session-preview">${escape(session.preview)}</span></span><span class="session-time">${escape(session.updated)}</span></button>`).join('') || '<div class="empty-list">没有匹配的会话<br><button class="text-button" data-action="clear-search">清除搜索</button></div>';
  document.querySelectorAll('[data-view]').forEach(button => {
    button.classList.toggle('active', button.dataset.view === view);
    button.setAttribute('aria-current', button.dataset.view === view ? 'page' : 'false');
  });
  $('#service-dot').className = `dot ${connected ? 'green' : 'amber'}`;
  $('#service-label').textContent = reconnecting ? '正在核对连接' : connected ? '服务已连接' : '查看连接已断开';
  $('#connection-button').textContent = connected ? '断开演示' : '重新连接';
}
function messageMarkup(message, index, session) {
  const user = message.role === 'user';
  const tools = message.tools?.length ? `<details class="tool-group"><summary>${icon('terminal')}已发起 ${message.tools.length} 次工具调用<span>查看记录</span>${icon('chevron')}</summary>${message.tools.map(tool => `<div class="tool-row"><code>${escape(tool)}</code><span>工具调用</span><span>已发起</span></div>`).join('')}</details>` : '';
  return `<article class="message ${user ? 'user' : 'assistant'}"><div class="message-avatar">${user ? '林' : 'H'}</div><div class="message-body"><div class="message-byline">${user ? '林亦' : 'Agent Harbor'}${user ? '' : '<span class="role">Claude Code</span>'}<time>${escape(message.at)}</time></div><div class="message-content">${tools}${message.html ?? escape(message.text ?? '')}${message.streaming && !message.stopped && connected && active(session.status) ? '<span class="cursor" aria-label="本轮执行中"></span>' : ''}</div>${message.finished ? `<div class="result-note">${icon('check')}本轮已结束 · 工作记录已保存</div>` : message.stopped ? `<div class="result-note">${icon('stop')}本轮已停止 · ${session.env === 'closed' ? '环境已关闭' : '当前环境保留'}</div>` : message.failed ? '<div class="result-note">本轮执行失败 · 已保存的内容保留</div>' : ''}${!user ? `<div class="message-actions"><button data-copy-message="${index}">${icon('copy')}复制回答</button></div>` : ''}</div></article>`;
}
function renderThread(scroll = false) {
  const session = visible();
  const previousScroll = $('#thread').scrollTop;
  if (!session.messages.length) {
    $('#thread').innerHTML = `<div class="thread-inner empty-state"><div class="empty-mark">${icon('chat')}</div><h2>从一个明确的任务开始</h2><p>描述目标、已有资料和完成标准。Agent 会在这个会话的独立环境里持续工作。</p><div class="suggestions"><button data-prompt="先阅读当前项目的 README，向我解释它的目录结构。">阅读项目，解释目录结构${icon('chevron')}</button><button data-prompt="检查当前项目的测试说明，列出验证步骤，暂时不要修改文件。">梳理项目的验证步骤${icon('chevron')}</button></div></div>`;
  } else {
    $('#thread').innerHTML = `<div class="thread-inner"><div class="date-separator">${escape(session.created)}</div>${session.messages.map((message, index) => messageMarkup(message, index, session)).join('')}</div>`;
  }
  $('#thread').scrollTop = scroll ? $('#thread').scrollHeight : previousScroll;
}
function renderDetails() {
  const session = visible();
  const working = active(session.status);
  const taskTitle = session.status === 'empty' ? '尚未开始' : session.status === 'stopping' ? '正在停止当前任务' : working ? '当前任务正在处理' : statuses[session.status];
  $('#details').innerHTML = `<div class="details-title">会话详情<span>仅自己可见</span></div><section class="detail-section"><div class="detail-label">当前任务</div><div class="detail-heading"><span class="dot ${working ? 'blue pulse' : session.status === 'reconciling' ? 'amber' : ''}"></span>${escape(taskTitle)}</div><p class="detail-description">${!connected ? '当前为断开前的记录，任务状态需要重新确认。' : session.status === 'stopping' ? '停止请求已发出，正在等待执行端确认。' : working ? '可以切换会话或关闭页面，任务会继续执行。' : session.status === 'reconciling' ? '停止状态尚未确认，核实后才能开始新的执行。' : '发送下一条消息，继续这段工作。'}</p><div class="detail-row"><span>创建时间</span><span>${escape(session.created)}</span></div><div class="detail-row"><span>对话消息</span><span>${session.messages.filter(message => message.role === 'user').length} 条用户输入</span></div></section><section class="detail-section"><div class="detail-label">工作环境</div><div class="environment-card"><div class="detail-heading">${icon('terminal')}${escape(labels[session.env])}</div><p>${session.env === 'closed' ? '对话与文件保留。下次发送消息时重新准备环境。' : session.env === 'reconciling' ? '当前环境不可继续使用，请先确认停止状态。' : '本轮结束后空闲15分钟自动回收。对话记录和工作文件保留。'}</p><button data-action="close" ${!connected || session.env === 'closed' || session.env === 'stopping' ? 'disabled' : ''}>${icon('power')}关闭工作环境</button></div></section><section class="detail-section"><div class="detail-label">最近进度</div><div class="activity-list">${session.events.slice(0, 4).map((event, index) => `<div class="activity-row"><span class="dot ${index === 0 && working ? 'blue' : ''}"></span><div>${escape(event)}${index === 0 ? '<small>最近一条已保存记录</small>' : ''}</div></div>`).join('') || '<p class="detail-description">发送消息后，在这里查看执行记录。</p>'}</div></section><div class="detail-row"><span>会话编号</span><span class="mono">${escape(session.id)}</span></div><div class="details-footer" style="margin-top:22px">${icon('info')}停止本轮不撤销已经发生的修改。关闭环境会停止其中的全部进程。</div>`;
}
function renderControls() {
  const session = visible();
  const working = active(session.status);
  const blocked = !connected || session.env === 'stopping' || session.env === 'reconciling';
  $('#header-status').innerHTML = connected ? tag(session) : '<span class="status-tag unknown"><span class="dot amber"></span>状态待同步</span>';
  $('#message-input').disabled = false; // 运行/断线时仍允许写草稿，但不能误提交。
  $('#message-input').placeholder = working ? '可以先写下下一条消息，本轮结束后再发送…' : '描述你希望 Agent 完成的工作…';
  $('#send-button').hidden = working;
  $('#send-button').disabled = blocked || !drafts.get(selected)?.trim();
  $('#stop-button').hidden = !working;
  $('#stop-button').disabled = !connected || session.status === 'stopping' || session.env === 'stopping';
  $('#stop-button').innerHTML = `${icon('stop')}${session.status === 'stopping' ? '正在停止…' : '停止本轮'}`;
  $('#close-environment').disabled = !connected || session.env === 'closed' || session.env === 'stopping';
  $('#composer-env').textContent = labels[session.env];
  $('#composer-notice').textContent = !connected ? '可以继续编辑草稿，连接恢复并核对状态后再发送。' : session.env === 'reconciling' ? '环境状态待确认，暂时不能发送新消息。' : session.status === 'stopping' ? '停止请求已发出，确认结束前暂不能发送下一条。' : working ? '本轮执行中，新的内容会保留为草稿，不会自动排队发送。' : session.env === 'closed' ? '下一条消息会重新准备环境，并恢复已保存的对话。' : '';
  $('#connection-banner').innerHTML = !connected ? `<div class="banner">${icon('info')}<div><strong>${reconnecting ? '正在重新连接并核对状态…' : '查看连接已断开'}</strong>已显示的进度保留；任务可能仍在执行，状态待同步。</div><button data-action="reconnect" ${reconnecting ? 'disabled' : ''}>重新连接</button></div>` : session.env === 'reconciling' ? `<div class="banner">${icon('info')}<div><strong>环境停止状态尚未确认</strong>为避免重复执行，暂时不能发送新任务。</div><button data-action="recheck">重新查询</button></div>` : '';
}
function renderList() {
  const source = connected ? sessions : offlineSnapshot;
  const query = $('#search').value.trim().toLowerCase();
  const filtered = source.filter(session => (session.title + session.preview).toLowerCase().includes(query));
  $('#all-sessions').innerHTML = `<div class="list-intro"><p>找到一项工作，然后从上次的进度继续。</p><button class="primary-button" data-action="new">${icon('plus')}新建会话</button></div><table class="list-table"><thead><tr><th>会话名称</th><th>当前任务</th><th class="desktop-cell">工作环境</th><th class="desktop-cell">最近更新</th></tr></thead><tbody>${filtered.map(session => `<tr data-session="${session.id}" tabindex="0" aria-label="打开${escape(session.title)}"><td>${escape(session.title)}</td><td>${tag(session)}</td><td class="desktop-cell">${escape(labels[session.env])}</td><td class="desktop-cell">${escape(session.updated)}</td></tr>`).join('')}</tbody></table>${filtered.length ? '' : '<div class="empty-list">没有匹配的会话。<button data-action="clear-search">清除搜索</button></div>'}`;
}
function render(scroll = false) {
  renderSidebar();
  $('#page-title').textContent = view === 'list' ? '全部会话' : visible().title;
  $('#workspace-body').hidden = view !== 'chat';
  $('#all-sessions').hidden = view !== 'list';
  $('#header-status').hidden = view !== 'chat';
  $('#close-environment').hidden = view !== 'chat';
  $('#details-toggle').hidden = view !== 'chat';
  if (view === 'list') renderList();
  else { renderThread(scroll); renderDetails(); renderControls(); }
}
function choose(id) {
  selected = id;
  view = 'chat';
  $('#message-input').value = drafts.get(id) ?? '';
  $('.app-shell').classList.remove('mobile-nav');
  render(true);
}
function createSession(title, template) {
  const session = { id: newId(), title, template, preview: '尚未发送消息', status: 'empty', env: 'closed', created: `今天 ${time()}`, updated: '刚刚', messages: [], events: [] };
  sessions.unshift(session);
  choose(session.id);
  $('#message-input').focus();
  notify('示例会话已创建，发送首条消息后准备环境');
}
// Another session's update should change its sidebar row, not reset the current reading position.
function refreshJob(id, follow = false) {
  if (!connected) return;
  if (id === selected && view === 'chat') {
    const thread = $('#thread');
    const nearBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 100;
    render(follow && nearBottom);
  } else {
    renderSidebar();
    if (view === 'list') renderList();
  }
}
function finishJob(id) {
  const session = sessions.find(session => session.id === id);
  if (!session || !active(session.status)) return;
  session.status = 'succeeded'; session.env = 'ready';
  session.preview = '本轮已结束，可以继续对话';
  const answer = session.messages.at(-1);
  answer.text += '\n\n本轮演示已结束。你可以继续补充要求，或者切换到另一段工作。';
  answer.streaming = false; answer.finished = true;
  session.events.unshift('本轮执行结束');
  jobs.delete(id);
  refreshJob(id, true);
}
function send() {
  const session = current();
  const text = drafts.get(session.id) ?? '';
  if (!connected || active(session.status) || ['stopping', 'reconciling'].includes(session.env) || !text.trim()) return;
  session.messages.push({ role: 'user', text, at: time() });
  session.messages.push({ role: 'assistant', text: '', at: time(), streaming: true });
  session.status = 'accepted'; session.env = session.env === 'closed' ? 'starting' : 'ready';
  session.preview = '新消息已接收，正在准备执行'; session.updated = '刚刚';
  session.events.unshift('消息已接收');
  drafts.delete(session.id); $('#message-input').value = '';
  const id = session.id;
  // 模拟任务独立于页面选中的会话，切换或断开不会取消它，也不会污染新会话。
  let step = 0;
  const timer = setInterval(() => {
    const target = sessions.find(item => item.id === id);
    if (!target || !active(target.status)) { clearInterval(timer); jobs.delete(id); return; }
    step++;
    target.env = 'ready'; target.status = 'running';
    const answer = target.messages.at(-1);
    if (step === 1) { answer.text = '收到。我会先阅读已有信息，明确本轮需要完成的工作。'; target.events.unshift('本轮开始执行'); }
    if (step === 2) { answer.tools = ['Read']; target.events.unshift('发起 Read 调用'); answer.text += '\n\n当前正在整理检查步骤，并区分可以直接核实的内容与需要你确认的事项。'; }
    if (step === 3) answer.text += '\n\n执行过程会保存在这个会话中。关闭页面或切换会话不会停止任务。';
    if (step === 5) { clearInterval(timer); finishJob(id); return; }
    refreshJob(id, true);
  }, 1800);
  jobs.set(id, timer);
  render(true);
}
function stopTurn() {
  const session = current();
  if (!connected || !active(session.status) || session.status === 'stopping') return;
  const id = session.id;
  clearInterval(jobs.get(id)); jobs.delete(id);
  session.status = 'stopping'; session.events.unshift('已请求停止本轮');
  render();
  setTimeout(() => {
    const target = sessions.find(item => item.id === id);
    if (!target || target.env === 'stopping' || target.env === 'closed') return;
    target.status = 'cancelled'; target.env = 'ready'; target.preview = '本轮已停止，环境保留';
    const answer = target.messages.at(-1);
    if (answer?.role === 'assistant') { answer.streaming = false; answer.stopped = true; if (!answer.text && !answer.html) answer.text = '本轮已停止。'; }
    target.events.unshift('本轮已停止，环境保留');
    refreshJob(id);
    if (connected) notify('本轮已停止；环境保留，独立后台任务可能仍在运行');
  }, 900);
}
function requestClose() {
  if (!connected || current().env === 'closed' || current().env === 'stopping') return;
  pendingClose = { id: selected, messageCount: current().messages.length };
  $('#close-description').textContent = `「${current().title}」中的全部进程将停止。对话记录和工作文件保留，下次发送消息时重新准备环境。`;
  $('#close-dialog').showModal();
}
function confirmClose() {
  const target = sessions.find(session => session.id === pendingClose.id);
  $('#close-dialog').close();
  if (!connected || !target || target.messages.length !== pendingClose.messageCount) { notify('会话状态已变化，请重新确认后关闭'); return; }
  const id = target.id;
  clearInterval(jobs.get(id)); jobs.delete(id);
  target.env = 'stopping';
  if (active(target.status)) target.status = 'stopping';
  target.events.unshift('正在关闭工作环境');
  render();
  setTimeout(() => {
    target.env = 'closed';
    if (active(target.status)) { target.status = 'cancelled'; const answer = target.messages.at(-1); if (answer?.role === 'assistant') { answer.streaming = false; answer.stopped = true; } }
    target.preview = '工作环境已关闭，对话与文件保留'; target.events.unshift('工作环境已关闭');
    refreshJob(id);
    if (connected) notify('示例环境已关闭，对话记录和工作文件保留');
  }, 1100);
}
function disconnect() {
  if (!connected) return;
  offlineSnapshot = structuredClone(sessions);
  connected = false;
  render();
}
function reconnect() {
  if (connected || reconnecting) return;
  reconnecting = true; render();
  setTimeout(() => { connected = true; reconnecting = false; offlineSnapshot = undefined; render(true); notify('模拟连接已恢复，已补齐当前进度'); }, 950);
}
function scenario(name) {
  $('#demo-popover').hidden = true;
  if (name === 'offline') { disconnect(); return; }
  if (name === 'normal') { if (!connected) reconnect(); else notify('当前处于正常连接状态'); return; }
  if (!connected) { connected = true; reconnecting = false; offlineSnapshot = undefined; }
  if (name === 'reset') { for (const timer of jobs.values()) clearInterval(timer); jobs.clear(); drafts.clear(); sessions = seed(); selected = sessions[0].id; $('#message-input').value = ''; view = 'chat'; }
  else {
    const session = current(); clearInterval(jobs.get(session.id)); jobs.delete(session.id);
    if (name === 'unknown') { session.status = 'reconciling'; session.env = 'reconciling'; session.preview = '环境停止状态尚未确认'; session.events.unshift('环境状态待确认'); }
    if (name === 'failure') { session.status = 'failed'; session.env = 'closed'; session.preview = '本轮失败，记录保留'; session.events.unshift('本轮执行失败，环境已关闭'); const answer = session.messages.at(-1); if (answer?.role === 'assistant') { answer.streaming = false; answer.finished = false; answer.failed = true; } }
  }
  render();
}

$('#composer').addEventListener('submit', event => { event.preventDefault(); send(); });
$('#message-input').addEventListener('input', event => { drafts.set(selected, event.target.value); renderControls(); });
$('#search').addEventListener('input', () => { renderSidebar(); if (view === 'list') renderList(); });
$('#stop-button').addEventListener('click', stopTurn);
$('#close-environment').addEventListener('click', requestClose);
$('#confirm-close').addEventListener('click', confirmClose);
$('#connection-button').addEventListener('click', () => connected ? disconnect() : reconnect());
$('#details-toggle').addEventListener('click', () => {
  if (window.innerWidth <= 1180) $('#workspace-body').classList.toggle('detail-open');
  else $('#workspace-body').classList.toggle('details-hidden');
});
$('#sidebar-toggle').addEventListener('click', () => $('.app-shell').classList.toggle('mobile-nav'));
$('#demo-button').addEventListener('click', () => { $('#demo-popover').hidden = !$('#demo-popover').hidden; });
$('#guide-button').addEventListener('click', () => $('#guide-dialog').showModal());
$('#new-form').addEventListener('submit', event => {
  event.preventDefault();
  const title = $('#new-title').value.trim();
  if (!title) return;
  if (!connected) { notify('请先恢复连接，再创建会话'); return; }
  const template = $('#new-template').value; $('#new-dialog').close(); $('#new-form').reset(); createSession(title, template);
});
document.addEventListener('click', async event => {
  if (!event.target.closest('#demo-popover, #demo-button')) $('#demo-popover').hidden = true;
  const button = event.target.closest('button, tr[data-session]');
  if (!button || button.disabled) return;
  if (button.dataset.session) choose(button.dataset.session);
  if (button.dataset.view) { view = button.dataset.view; $('.app-shell').classList.remove('mobile-nav'); render(); }
  if (button.dataset.scenario) scenario(button.dataset.scenario);
  if (button.hasAttribute('data-dismiss')) button.closest('dialog').close();
  if (button.dataset.action === 'new') { if (!connected) { notify('请先恢复连接，再创建会话'); return; } $('#new-dialog').showModal(); }
  if (button.dataset.action === 'close') requestClose();
  if (button.dataset.action === 'reconnect') reconnect();
  if (button.dataset.action === 'clear-search') { $('#search').value = ''; renderSidebar(); renderList(); }
  if (button.dataset.action === 'recheck') notify('示例状态仍待确认，请联系维护者核实环境后重新查询');
  if (button.dataset.prompt) { drafts.set(selected, button.dataset.prompt); $('#message-input').value = button.dataset.prompt; renderControls(); $('#message-input').focus(); }
  if (button.dataset.copyMessage !== undefined) {
    const message = visible().messages[Number(button.dataset.copyMessage)];
    const text = message.text ?? new DOMParser().parseFromString(message.html, 'text/html').body.textContent;
    try { await navigator.clipboard.writeText(text); notify('回答已复制'); } catch { notify('浏览器未允许复制，请选择回答文字复制'); }
  }
});
document.addEventListener('keydown', event => {
  const command = event.metaKey || event.ctrlKey;
  if (event.target.closest('tr[data-session]') && event.key === 'Enter') choose(event.target.closest('tr').dataset.session);
  if (command && event.key === 'Enter' && event.target === $('#message-input')) { event.preventDefault(); send(); }
  if (command && event.key.toLowerCase() === 'k') { event.preventDefault(); if (window.innerWidth <= 760) $('.app-shell').classList.add('mobile-nav'); $('#search').focus(); }
  if (command && event.key.toLowerCase() === 'n' && !document.querySelector('dialog[open]')) { event.preventDefault(); if (connected) $('#new-dialog').showModal(); }
  if (event.altKey && event.key.toLowerCase() === 'd') { event.preventDefault(); $('#demo-popover').hidden = !$('#demo-popover').hidden; }
  if (event.key === 'Escape') { $('#demo-popover').hidden = true; $('.app-shell').classList.remove('mobile-nav'); $('#workspace-body').classList.remove('detail-open'); }
});
render();
