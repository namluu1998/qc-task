/* =====================================================================
   QC Task - Frontend logic (vanilla JS, gọi API qua fetch)
   ===================================================================== */
'use strict';

const API = 'api.php';
const state = {
  user: null, csrf: '', meta: { priorities: [], statuses: [] },
  projects: [], users: [], tasks: [],
  currentProjectId: null, currentView: 'tasks',
  collapsedGroups: new Set(), collapsedParents: new Set(),
  calMonth: null,
};

/* ---------- Bảng màu ---------- */
const PRI_STYLE = {
  'Thấp':       { bg: '#f1f5f9', c: '#475569' },
  'Trung bình': { bg: '#e0f2fe', c: '#0369a1' },
  'Cao':        { bg: '#fff7ed', c: '#c2410c' },
  'Khẩn cấp':   { bg: '#fef2f2', c: '#b91c1c' },
};
const PRI_ORDER = { 'Khẩn cấp': 0, 'Cao': 1, 'Trung bình': 2, 'Thấp': 3 };
const ST_COLOR = {
  'Chưa test': '#64748b', 'Đang test': '#0369a1', 'Đạt': '#16a34a', 'Lỗi': '#ef4444', 'Chờ xử lý': '#f59e0b',
};
const ST_ORDER = { 'Lỗi': 0, 'Chờ xử lý': 1, 'Đang test': 2, 'Chưa test': 3, 'Đạt': 4 };

/* ---------- Tiện ích ---------- */
const $  = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(msg, isErr = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast' + (isErr ? ' err' : '');
  setTimeout(() => t.classList.add('hidden'), 2600);
}

async function api(action, { method = 'GET', body = null, query = {} } = {}) {
  const qs = new URLSearchParams({ action, ...query }).toString();
  const opts = { method, headers: {} };
  if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.headers['X-CSRF-Token'] = state.csrf;
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${API}?${qs}`, opts);
  let data;
  try { data = await res.json(); } catch (e) { throw new Error('Máy chủ trả về dữ liệu không hợp lệ.'); }
  if (!res.ok || data.ok === false) throw new Error(data.error || 'Có lỗi xảy ra.');
  return data;
}

/* ---------- Khởi động ---------- */
async function boot() {
  try {
    const d = await api('me');
    if (d.user) { onLoggedIn(d); }
    else { showLogin(); }
  } catch (e) { showLogin(); }
}

function showLogin() {
  $('app').classList.add('hidden');
  $('login-screen').classList.remove('hidden');
}

function onLoggedIn(d) {
  state.user = d.user;
  state.csrf = d.csrf;
  if (d.meta) state.meta = d.meta;
  $('login-screen').classList.add('hidden');
  $('app').classList.remove('hidden');
  $('user-name').textContent = d.user.full_name || d.user.username;
  $('user-role').textContent = d.user.role === 'manager' ? 'Quản lý' : 'QC';
  document.body.classList.toggle('is-manager', d.user.role === 'manager');
  document.querySelectorAll('.manager-only').forEach((el) =>
    el.classList.toggle('hidden', d.user.role !== 'manager'));
  // nạp bộ lọc trạng thái
  const fs = $('filter-status');
  fs.innerHTML = '<option value="">Tất cả trạng thái</option>' +
    state.meta.statuses.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
  loadProjects();
  loadUsers();
  refreshReminderCount();
}

/* ---------- Đăng nhập / đăng xuất ---------- */
$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('login-error');
  err.classList.add('hidden');
  try {
    const d = await api('login', {
      method: 'POST',
      body: { username: $('login-username').value.trim(), password: $('login-password').value },
    });
    // sau login cần lấy meta -> gọi me
    const me = await api('me');
    onLoggedIn(me);
    $('login-password').value = '';
  } catch (ex) {
    err.textContent = ex.message;
    err.classList.remove('hidden');
  }
});

$('logout-btn').addEventListener('click', async () => {
  try { await api('logout', { method: 'POST', body: {} }); } catch (e) {}
  state.user = null;
  location.reload();
});

/* ---------- Dự án ---------- */
async function loadProjects() {
  const d = await api('projects');
  state.projects = d.projects;
  renderProjectList();
  if (!state.currentProjectId && state.projects.length) {
    selectProject(state.projects[0].id);
  } else if (!state.projects.length) {
    $('project-title').textContent = 'Chưa có dự án';
    $('project-desc').textContent = state.user.role === 'manager'
      ? 'Bấm ＋ để tạo dự án đầu tiên.' : 'Bạn chưa được thêm vào dự án nào.';
    $('add-task-btn').classList.add('hidden');
    $('task-toolbar').classList.add('hidden');
    $('task-list').innerHTML = '';
  }
}

function renderProjectList() {
  const ul = $('project-list');
  ul.innerHTML = state.projects.map((p) => `
    <li data-id="${p.id}" class="${p.id === state.currentProjectId ? 'active' : ''}">
      <span class="proj-dot" style="background:${esc(p.color)}"></span>
      <span class="proj-name">${esc(p.name)}</span>
      <span class="proj-count">${p.open_tasks}/${p.total_tasks}</span>
    </li>`).join('');
  ul.querySelectorAll('li').forEach((li) =>
    li.addEventListener('click', () => selectProject(+li.dataset.id)));
}

async function selectProject(id) {
  state.currentProjectId = id;
  state.currentView = 'tasks';
  switchView('tasks');
  renderProjectList();
  const p = state.projects.find((x) => x.id === id);
  if (!p) return;
  $('project-title').textContent = p.name;
  $('project-desc').textContent = p.description || '';
  $('add-task-btn').classList.remove('hidden');
  $('docs-btn').classList.remove('hidden');
  $('edit-project-btn').classList.toggle('hidden', state.user.role !== 'manager');
  $('task-toolbar').classList.remove('hidden');
  closeSidebarMobile();
  await loadTasks();
}

async function loadTasks() {
  const d = await api('tasks', { query: { project_id: state.currentProjectId } });
  state.tasks = d.tasks;
  renderTasks();
}

/* ---------- Hiển thị công việc (bảng nhóm theo trạng thái) ---------- */
const STATUS_DOT = {
  'Chưa test': '#98a2b3', 'Đang test': '#2563eb', 'Chờ xử lý': '#f5a623', 'Lỗi': '#e5484d', 'Đạt': '#12a150',
};
const PRI_ICON = {
  'Khẩn cấp': { icon: '⇈', c: '#e5484d' }, 'Cao': { icon: '↑', c: '#f76808' },
  'Trung bình': { icon: '—', c: '#98a2b3' }, 'Thấp': { icon: '↓', c: '#98a2b3' },
};
const GROUP_ORDER = ['Chưa test', 'Đang test', 'Chờ xử lý', 'Lỗi', 'Đạt'];
let dragId = null;   // id việc đang kéo (kéo-thả sắp xếp)

// Avatar chữ cái đầu, màu suy ra từ tên (ổn định).
function avatarHtml(name) {
  if (!name) return `<span class="avatar-mini none" title="Chưa giao">?</span>`;
  const colors = ['#2563eb', '#7c3aed', '#0891b2', '#059669', '#d97706', '#dc2626', '#db2777', '#4f46e5'];
  let h = 0; for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const initial = name.trim().slice(0, 1).toUpperCase();
  return `<span class="avatar-mini" style="background:${colors[h % colors.length]}" title="${esc(name)}">${esc(initial)}</span>`;
}

function tableHeader() {
  return `<div class="trow thead">
    <div class="tc-check"></div>
    <div class="tc-title">Tiêu đề</div>
    <div class="tc-assignee">Người thực hiện</div>
    <div class="tc-due">Hạn</div>
    <div class="tc-status">Trạng thái</div>
    <div class="tc-pri">Mức độ</div>
  </div>`;
}

function renderTasks() {
  const wrap = $('task-list');
  const search = $('task-search').value.trim().toLowerCase();
  const fStatus = $('filter-status').value;
  const sortBy = $('sort-by').value;

  const children = {};
  state.tasks.forEach((t) => { if (t.parent_id) (children[t.parent_id] ??= []).push(t); });

  const matches = (t) => !search || (t.title + ' ' + (t.description || '')).toLowerCase().includes(search);
  let tops = state.tasks.filter((t) => !t.parent_id);
  if (search) tops = tops.filter((t) => matches(t) || (children[t.id] || []).some(matches));

  const sortFn = sortBy === 'priority' ? (a, b) => PRI_ORDER[a.priority] - PRI_ORDER[b.priority]
    : sortBy === 'due' ? (a, b) => ((a.due_date || '9999') > (b.due_date || '9999') ? 1 : -1)
    : sortBy === 'status' ? (a, b) => ST_ORDER[a.status] - ST_ORDER[b.status]
    : (a, b) => a.sort_order - b.sort_order;

  const manual = sortBy === 'manual';   // chỉ cho kéo-thả khi sắp xếp Thủ công
  const groups = GROUP_ORDER.filter((s) => state.meta.statuses.includes(s));
  let html = tableHeader();
  let anyRow = false;

  groups.forEach((status) => {
    if (fStatus && fStatus !== status) return;
    const rows = tops.filter((t) => t.status === status).sort(sortFn);
    if (!rows.length) return;
    anyRow = true;
    const collapsed = state.collapsedGroups.has(status);
    html += `<div class="tgroup">
      <div class="tgroup-head" data-group="${esc(status)}">
        <span class="tg-caret ${collapsed ? 'collapsed' : ''}">▾</span>
        <span class="tg-dot" style="background:${STATUS_DOT[status]}"></span>
        <span class="tg-name">${esc(status)}</span>
        <span class="tg-count">${rows.length}</span>
      </div>`;
    if (!collapsed) {
      rows.forEach((t) => {
        const kids = children[t.id] || [];
        html += taskRow(t, false, kids, manual);
        if (kids.length && !state.collapsedParents.has(t.id)) {
          kids.forEach((c) => { html += taskRow(c, true, [], false); });
        }
      });
    }
    html += `</div>`;
  });

  wrap.innerHTML = html;
  $('task-empty').classList.toggle('hidden', anyRow);
  bindTaskEvents();
}

function taskRow(t, isSub, kids, manual) {
  const done = t.status === 'Đạt';
  const today = new Date().toISOString().slice(0, 10);
  const overdue = t.due_date && t.due_date < today && !done;
  const pri = PRI_ICON[t.priority] || PRI_ICON['Trung bình'];
  const hasKids = kids && kids.length;
  const doneKids = hasKids ? kids.filter((k) => k.status === 'Đạt').length : 0;
  const expanded = hasKids && !state.collapsedParents.has(t.id);
  const canDrag = manual && !isSub;
  const stOpts = state.meta.statuses.map((s) =>
    `<option value="${esc(s)}" ${s === t.status ? 'selected' : ''}>${esc(s)}</option>`).join('');

  const caret = !isSub && hasKids
    ? `<button class="tw-caret ${expanded ? 'open' : ''}" data-exp="${t.id}" title="Nhiệm vụ con">▸</button>`
    : `<span class="caret-spacer"></span>`;

  const moveBtns = canDrag
    ? `<button class="ta-btn move-up" data-id="${t.id}" title="Lên">▲</button>
       <button class="ta-btn move-down" data-id="${t.id}" title="Xuống">▼</button>`
    : '';
  const actions = isSub
    ? `<button class="ta-btn edit-task" data-id="${t.id}" title="Sửa">✎</button>
       <button class="ta-btn del-task" data-id="${t.id}" title="Xóa">🗑</button>`
    : `${moveBtns}
       <button class="ta-btn add-sub" data-id="${t.id}" title="Thêm nhiệm vụ con">＋</button>
       <button class="ta-btn edit-task" data-id="${t.id}" title="Sửa">✎</button>
       <button class="ta-btn del-task" data-id="${t.id}" title="Xóa">🗑</button>`;

  return `
  <div class="trow ${isSub ? 'sub' : ''} ${done ? 'done' : ''}" data-id="${t.id}">
    <div class="tc-check">
      ${canDrag ? `<span class="drag-grip" draggable="true" data-id="${t.id}" title="Kéo để sắp xếp">⠿</span>` : ''}
      ${caret}
      <button class="tcheck ${done ? 'checked' : ''}" data-check="${t.id}" title="Đánh dấu Đạt / bỏ đánh dấu"></button>
    </div>
    <div class="tc-title">
      <span class="trow-title edit-task" data-id="${t.id}">${esc(t.title)}</span>
      ${hasKids ? `<span class="subprog" title="Nhiệm vụ con đã Đạt">${doneKids}/${kids.length}</span>` : ''}
      ${overdue ? `<span class="overdue-flag" title="Quá hạn">Quá hạn</span>` : ''}
      <span class="trow-actions">${actions}</span>
    </div>
    <div class="tc-assignee">${avatarHtml(t.assignee_name)}</div>
    <div class="tc-due">${t.due_date ? `<span class="due-pill ${overdue ? 'overdue' : ''}">${esc(t.due_date.slice(5))}</span>` : '<span class="due-empty">+ Hạn</span>'}</div>
    <div class="tc-status"><select class="status-select st-change" style="color:${ST_COLOR[t.status]}" data-id="${t.id}">${stOpts}</select></div>
    <div class="tc-pri"><span class="pri-ind" style="color:${pri.c}">${pri.icon} ${esc(t.priority)}</span></div>
  </div>`;
}

function bindTaskEvents() {
  const reloadAll = async () => { await loadTasks(); refreshReminderCount(); loadProjects(); };

  document.querySelectorAll('.st-change').forEach((s) =>
    s.addEventListener('change', async () => {
      try { await api('task_status', { method: 'POST', body: { id: +s.dataset.id, status: s.value } }); await reloadAll(); }
      catch (e) { toast(e.message, true); }
    }));
  // Ô tròn: bật/tắt "Đạt"
  document.querySelectorAll('.tcheck').forEach((b) =>
    b.addEventListener('click', async () => {
      const t = state.tasks.find((x) => x.id === +b.dataset.check);
      const next = t.status === 'Đạt' ? 'Chưa test' : 'Đạt';
      try { await api('task_status', { method: 'POST', body: { id: t.id, status: next } }); await reloadAll(); }
      catch (e) { toast(e.message, true); }
    }));
  // Mở/đóng nhiệm vụ con
  document.querySelectorAll('[data-exp]').forEach((b) =>
    b.addEventListener('click', () => {
      const id = +b.dataset.exp;
      state.collapsedParents.has(id) ? state.collapsedParents.delete(id) : state.collapsedParents.add(id);
      renderTasks();
    }));
  // Thu/mở nhóm trạng thái
  document.querySelectorAll('.tgroup-head').forEach((h) =>
    h.addEventListener('click', () => {
      const g = h.dataset.group;
      state.collapsedGroups.has(g) ? state.collapsedGroups.delete(g) : state.collapsedGroups.add(g);
      renderTasks();
    }));
  document.querySelectorAll('.edit-task').forEach((b) =>
    b.addEventListener('click', () => openTaskModal(state.tasks.find((t) => t.id === +b.dataset.id))));
  document.querySelectorAll('.add-sub').forEach((b) =>
    b.addEventListener('click', () => openTaskModal(null, +b.dataset.id)));
  document.querySelectorAll('.del-task').forEach((b) =>
    b.addEventListener('click', () => delTask(+b.dataset.id)));
  // Nút ▲▼ (di chuyển trong cùng nhóm) — dùng cho điện thoại
  document.querySelectorAll('.move-up').forEach((b) =>
    b.addEventListener('click', () => moveArrow(+b.dataset.id, -1)));
  document.querySelectorAll('.move-down').forEach((b) =>
    b.addEventListener('click', () => moveArrow(+b.dataset.id, 1)));

  // ---- Kéo-thả sắp xếp ----
  const clearDrop = () => document.querySelectorAll('.drop-before,.drop-after,.drop-target')
    .forEach((el) => el.classList.remove('drop-before', 'drop-after', 'drop-target'));

  document.querySelectorAll('.drag-grip').forEach((g) => {
    g.addEventListener('dragstart', (e) => {
      dragId = +g.dataset.id;
      g.closest('.trow').classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', String(dragId)); } catch (_) {}
    });
    g.addEventListener('dragend', () => {
      document.querySelectorAll('.trow.dragging').forEach((r) => r.classList.remove('dragging'));
      clearDrop(); dragId = null;
    });
  });
  // Thả lên một dòng khác → chèn trước/sau; khác nhóm → đổi trạng thái theo nhóm đích
  document.querySelectorAll('.trow:not(.thead):not(.sub)').forEach((row) => {
    row.addEventListener('dragover', (e) => {
      if (dragId == null || +row.dataset.id === dragId) return;
      e.preventDefault();
      const r = row.getBoundingClientRect();
      const after = (e.clientY - r.top) > r.height / 2;
      clearDrop(); row.classList.add(after ? 'drop-after' : 'drop-before');
    });
    row.addEventListener('drop', (e) => {
      if (dragId == null) return;
      e.preventDefault();
      const r = row.getBoundingClientRect();
      const after = (e.clientY - r.top) > r.height / 2;
      const targetId = +row.dataset.id; const d = dragId;
      clearDrop(); performMove(d, targetId, after ? 'after' : 'before');
    });
  });
  // Thả lên tiêu đề nhóm → chuyển sang trạng thái đó
  document.querySelectorAll('.tgroup-head').forEach((h) => {
    h.addEventListener('dragover', (e) => { if (dragId == null) return; e.preventDefault(); h.classList.add('drop-target'); });
    h.addEventListener('dragleave', () => h.classList.remove('drop-target'));
    h.addEventListener('drop', (e) => {
      if (dragId == null) return;
      e.preventDefault(); const d = dragId; h.classList.remove('drop-target');
      performMoveToGroup(d, h.dataset.group);
    });
  });
}

/* ---------- Sắp xếp thủ công (kéo-thả + ▲▼) ---------- */
// Thứ tự hiển thị các việc cha: theo nhóm trạng thái, trong nhóm theo sort_order
function topLevelInDisplayOrder() {
  const tops = state.tasks.filter((t) => !t.parent_id);
  const out = [];
  GROUP_ORDER.forEach((st) =>
    tops.filter((t) => t.status === st).sort((a, b) => a.sort_order - b.sort_order).forEach((t) => out.push(t)));
  tops.filter((t) => !GROUP_ORDER.includes(t.status)).sort((a, b) => a.sort_order - b.sort_order).forEach((t) => out.push(t));
  return out;
}
// Ghép ordered_ids: mỗi việc cha kèm nhiệm vụ con
function buildOrderedIds(topIds) {
  const children = {};
  state.tasks.forEach((t) => { if (t.parent_id) (children[t.parent_id] ??= []).push(t); });
  const ordered = [];
  topIds.forEach((id) => { ordered.push(id); (children[id] || []).forEach((c) => ordered.push(c.id)); });
  return ordered;
}
async function saveOrder(topIds) {
  await api('task_reorder', { method: 'POST', body: { project_id: state.currentProjectId, ordered_ids: buildOrderedIds(topIds) } });
  await loadTasks(); loadProjects(); refreshReminderCount();
}
async function performMove(dragId, targetId, pos) {
  if (dragId === targetId) return;
  const dragT = state.tasks.find((t) => t.id === dragId);
  const targT = state.tasks.find((t) => t.id === targetId);
  if (!dragT || !targT) return;
  try {
    if (dragT.status !== targT.status) {
      await api('task_status', { method: 'POST', body: { id: dragId, status: targT.status } });
      dragT.status = targT.status;
    }
    let ids = topLevelInDisplayOrder().map((t) => t.id).filter((id) => id !== dragId);
    let idx = ids.indexOf(targetId); if (idx < 0) idx = ids.length - 1;
    ids.splice(pos === 'after' ? idx + 1 : idx, 0, dragId);
    await saveOrder(ids);
  } catch (e) { toast(e.message, true); }
}
async function performMoveToGroup(dragId, status) {
  const dragT = state.tasks.find((t) => t.id === dragId);
  if (!dragT) return;
  try {
    if (dragT.status !== status) { await api('task_status', { method: 'POST', body: { id: dragId, status } }); dragT.status = status; }
    let ids = topLevelInDisplayOrder().map((t) => t.id).filter((id) => id !== dragId);
    const groupIds = state.tasks.filter((t) => !t.parent_id && t.status === status && t.id !== dragId).map((t) => t.id);
    let at = groupIds.length ? ids.indexOf(groupIds[groupIds.length - 1]) + 1 : ids.length;
    ids.splice(at, 0, dragId);
    await saveOrder(ids);
  } catch (e) { toast(e.message, true); }
}
async function moveArrow(id, dir) {
  const t = state.tasks.find((x) => x.id === id);
  const group = state.tasks.filter((x) => !x.parent_id && x.status === t.status).sort((a, b) => a.sort_order - b.sort_order);
  const i = group.findIndex((x) => x.id === id), j = i + dir;
  if (j < 0 || j >= group.length) return;
  const ids = topLevelInDisplayOrder().map((x) => x.id);
  const gi = ids.indexOf(group[i].id), gj = ids.indexOf(group[j].id);
  [ids[gi], ids[gj]] = [ids[gj], ids[gi]];
  try { await saveOrder(ids); } catch (e) { toast(e.message, true); }
}

['task-search', 'filter-status', 'sort-by'].forEach((id) => {
  const ev = id === 'task-search' ? 'input' : 'change';
  $(id).addEventListener(ev, renderTasks);
});

async function delTask(id) {
  const t = state.tasks.find((x) => x.id === id);
  if (!confirm(`Xóa công việc "${t.title}"${!t.parent_id ? ' và tất cả nhiệm vụ con' : ''}?`)) return;
  try { await api('task_delete', { method: 'POST', body: { id } }); await loadTasks(); loadProjects(); toast('Đã xóa.'); }
  catch (e) { toast(e.message, true); }
}

async function moveTask(id, dir) {
  const tops = state.tasks.filter((t) => !t.parent_id).sort((a, b) => a.sort_order - b.sort_order);
  const i = tops.findIndex((t) => t.id === id);
  const j = i + dir;
  if (j < 0 || j >= tops.length) return;
  [tops[i], tops[j]] = [tops[j], tops[i]];
  // Tạo thứ tự phẳng: mỗi việc cha kèm nhiệm vụ con của nó.
  const children = {};
  state.tasks.forEach((t) => { if (t.parent_id) (children[t.parent_id] ??= []).push(t); });
  const ordered = [];
  tops.forEach((t) => { ordered.push(t.id); (children[t.id] || []).forEach((c) => ordered.push(c.id)); });
  try {
    await api('task_reorder', { method: 'POST', body: { project_id: state.currentProjectId, ordered_ids: ordered } });
    await loadTasks();
  } catch (e) { toast(e.message, true); }
}

/* ---------- Modal helpers ---------- */
function openModal(title, bodyHtml, footHtml) {
  $('modal').innerHTML = `
    <div class="modal-head"><h3>${esc(title)}</h3><button class="icon-btn" id="modal-x">✕</button></div>
    <div class="modal-body">${bodyHtml}</div>
    <div class="modal-foot">${footHtml}</div>`;
  $('modal-backdrop').classList.remove('hidden');
  $('modal-x').addEventListener('click', closeModal);
}
function closeModal() { $('modal-backdrop').classList.add('hidden'); $('modal').innerHTML = ''; }
$('modal-backdrop').addEventListener('click', (e) => { if (e.target === $('modal-backdrop')) closeModal(); });

/* ---------- Modal Công việc ---------- */
function openTaskModal(task, parentId = null) {
  const isEdit = !!task;
  const priOpts = state.meta.priorities.map((p) =>
    `<option ${task && task.priority === p ? 'selected' : ''}>${esc(p)}</option>`).join('');
  const stOpts = state.meta.statuses.map((s) =>
    `<option ${task && task.status === s ? 'selected' : ''}>${esc(s)}</option>`).join('');
  const userOpts = '<option value="">— Chưa giao —</option>' + state.users.filter(u=>u.active).map((u) =>
    `<option value="${u.id}" ${task && task.assignee_id === u.id ? 'selected' : ''}>${esc(u.full_name || u.username)}</option>`).join('');

  openModal(isEdit ? 'Sửa công việc' : (parentId ? 'Thêm nhiệm vụ con' : 'Thêm công việc'), `
    <label>Tên công việc *</label>
    <input id="t-title" value="${task ? esc(task.title) : ''}">
    <label>Mô tả</label>
    <textarea id="t-desc" rows="3">${task ? esc(task.description || '') : ''}</textarea>
    <div class="form-row">
      <div><label>Ưu tiên</label><select id="t-pri">${priOpts}</select></div>
      <div><label>Trạng thái</label><select id="t-status">${stOpts}</select></div>
    </div>
    <label>Người thực hiện</label>
    <select id="t-assignee">${userOpts}</select>
    <div class="form-row">
      <div><label>Hạn chót</label><input id="t-due" type="date" value="${task && task.due_date ? esc(task.due_date.slice(0,10)) : ''}"></div>
      <div><label>Nhắc lúc</label><input id="t-remind" type="datetime-local" value="${task && task.remind_at ? esc(task.remind_at.replace(' ','T').slice(0,16)) : ''}"></div>
    </div>
  `, `
    <button class="btn ghost" id="t-cancel">Hủy</button>
    <button class="btn primary" id="t-save">Lưu</button>
  `);
  $('t-cancel').addEventListener('click', closeModal);
  $('t-save').addEventListener('click', async () => {
    const title = $('t-title').value.trim();
    if (!title) { toast('Nhập tên công việc.', true); return; }
    const remind = $('t-remind').value ? $('t-remind').value.replace('T', ' ') + ':00' : '';
    const body = {
      id: task ? task.id : 0,
      project_id: state.currentProjectId,
      parent_id: parentId || (task ? task.parent_id : null),
      title, description: $('t-desc').value.trim(),
      priority: $('t-pri').value, status: $('t-status').value,
      assignee_id: $('t-assignee').value || null,
      due_date: $('t-due').value || '', remind_at: remind,
    };
    try { await api('task_save', { method: 'POST', body }); closeModal(); await loadTasks(); loadProjects(); refreshReminderCount(); toast('Đã lưu.'); }
    catch (e) { toast(e.message, true); }
  });
  setTimeout(() => $('t-title').focus(), 50);
}
$('add-task-btn').addEventListener('click', () => openTaskModal(null));

/* ---------- Modal Dự án ---------- */
function openProjectModal(project) {
  const members = new Set();
  const doOpen = () => {
    const memberBoxes = state.users.filter(u=>u.active).map((u) =>
      `<label><input type="checkbox" class="mem" value="${u.id}" ${members.has(u.id) ? 'checked' : ''}> ${esc(u.full_name || u.username)} <span class="muted" style="margin:0">(${u.role === 'manager' ? 'QL' : 'QC'})</span></label>`).join('');
    openModal(project ? 'Sửa dự án' : 'Thêm dự án', `
      <label>Tên dự án *</label>
      <input id="p-name" value="${project ? esc(project.name) : ''}">
      <label>Mô tả</label>
      <textarea id="p-desc" rows="2">${project ? esc(project.description || '') : ''}</textarea>
      <label>Màu nhãn</label>
      <input id="p-color" type="color" value="${project ? esc(project.color) : '#2d7ff9'}" style="height:44px">
      <label>Thành viên tham gia</label>
      <div class="checkbox-list">${memberBoxes || '<span class="muted">Chưa có người dùng.</span>'}</div>
    `, `
      ${project ? '<button class="btn danger" id="p-del">Xóa dự án</button>' : ''}
      <div style="flex:1"></div>
      <button class="btn ghost" id="p-cancel">Hủy</button>
      <button class="btn primary" id="p-save">Lưu</button>
    `);
    $('p-cancel').addEventListener('click', closeModal);
    if (project) $('p-del').addEventListener('click', () => delProject(project.id));
    $('p-save').addEventListener('click', async () => {
      const name = $('p-name').value.trim();
      if (!name) { toast('Nhập tên dự án.', true); return; }
      const member_ids = [...document.querySelectorAll('.mem:checked')].map((c) => +c.value);
      try {
        const d = await api('project_save', { method: 'POST', body: {
          id: project ? project.id : 0, name, description: $('p-desc').value.trim(),
          color: $('p-color').value, member_ids } });
        closeModal(); await loadProjects();
        selectProject(project ? project.id : d.id);
        toast('Đã lưu dự án.');
      } catch (e) { toast(e.message, true); }
    });
  };
  if (project) {
    api('project_members', { query: { project_id: project.id } })
      .then((d) => { d.member_ids.forEach((id) => members.add(id)); doOpen(); })
      .catch(() => doOpen());
  } else { doOpen(); }
}
$('add-project-btn').addEventListener('click', () => openProjectModal(null));
$('edit-project-btn').addEventListener('click', () =>
  openProjectModal(state.projects.find((p) => p.id === state.currentProjectId)));

async function delProject(id) {
  if (!confirm('Xóa dự án này cùng toàn bộ công việc bên trong?')) return;
  try {
    await api('project_delete', { method: 'POST', body: { id } });
    closeModal(); state.currentProjectId = null; await loadProjects(); toast('Đã xóa dự án.');
  } catch (e) { toast(e.message, true); }
}

/* ---------- Nhắc nhở ---------- */
async function refreshReminderCount() {
  try {
    const d = await api('reminders');
    const n = d.reminders.length;
    const b = $('reminder-count');
    b.textContent = n; b.classList.toggle('hidden', n === 0);
  } catch (e) {}
}
async function openReminders() {
  switchView('reminders');
  const d = await api('reminders');
  const wrap = $('reminder-list');
  wrap.innerHTML = d.reminders.map((r) => {
    const pri = PRI_STYLE[r.priority] || PRI_STYLE['Trung bình'];
    return `<div class="task-card">
      <div class="task-main">
        <div class="task-title">${esc(r.title)}</div>
        <div class="task-meta">
          <span class="chip" style="background:${pri.bg};color:${pri.c}">${esc(r.priority)}</span>
          <span class="chip assignee">📁 ${esc(r.project_name)}</span>
          ${r.assignee_name ? `<span class="chip assignee">👤 ${esc(r.assignee_name)}</span>` : ''}
          ${r.due_date ? `<span class="chip due ${r.overdue ? 'overdue' : ''}">📅 ${esc(r.due_date)} ${r.overdue ? '(quá hạn)' : ''}</span>` : ''}
          <span class="chip" style="color:${ST_COLOR[r.status]}">${esc(r.status)}</span>
        </div>
      </div></div>`;
  }).join('');
  $('reminder-empty').classList.toggle('hidden', d.reminders.length > 0);
}
$('menu-reminders').addEventListener('click', openReminders);
$('reminder-bell').addEventListener('click', openReminders);

/* ---------- Lịch công việc ---------- */
const MONTH_NAMES = ['Tháng 1','Tháng 2','Tháng 3','Tháng 4','Tháng 5','Tháng 6','Tháng 7','Tháng 8','Tháng 9','Tháng 10','Tháng 11','Tháng 12'];
const fmtDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

async function openCalendar() {
  switchView('calendar');
  if (!state.calMonth) { const n = new Date(); state.calMonth = new Date(n.getFullYear(), n.getMonth(), 1); }
  await renderCalendar();
}

async function renderCalendar() {
  const first = state.calMonth;
  const year = first.getFullYear(), month = first.getMonth();
  $('cal-label').textContent = `${MONTH_NAMES[month]} / ${year}`;

  // Ô đầu tiên lùi về Thứ 2 của tuần chứa ngày 1
  const dow = new Date(year, month, 1).getDay();          // 0=CN..6=T7
  const back = (dow === 0 ? 6 : dow - 1);
  const gridStart = new Date(year, month, 1 - back);
  const cells = [];
  for (let i = 0; i < 42; i++) { const d = new Date(gridStart); d.setDate(gridStart.getDate() + i); cells.push(d); }

  let tasks = [];
  try {
    const d = await api('calendar', { query: { from: fmtDate(cells[0]), to: fmtDate(cells[41]) } });
    tasks = d.tasks;
  } catch (e) { toast(e.message, true); }

  const byDay = {};
  tasks.forEach((t) => { (byDay[t.due_date] ??= []).push(t); });
  const today = fmtDate(new Date());
  const weekdays = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'];

  let html = `<div class="cal-week-head">${weekdays.map((w) => `<div>${w}</div>`).join('')}</div><div class="cal-body">`;
  cells.forEach((cell) => {
    const ds = fmtDate(cell);
    const other = cell.getMonth() !== month;
    const isToday = ds === today;
    const items = byDay[ds] || [];
    html += `<div class="cal-cell ${other ? 'other' : ''} ${isToday ? 'today' : ''}">
      <div class="cal-daynum">${cell.getDate()}</div>
      <div class="cal-items">`;
    items.slice(0, 4).forEach((t) => {
      const done = t.status === 'Đạt';
      const overdue = !done && ds < today;
      html += `<button class="cal-chip ${done ? 'done' : ''} ${overdue ? 'overdue' : ''}" data-id="${t.id}" data-proj="${t.project_id}" title="${esc(t.title)} · ${esc(t.project_name)}">
        <span class="cal-dot" style="background:${STATUS_DOT[t.status] || '#98a2b3'}"></span>
        <span class="cal-chip-t">${esc(t.title)}</span></button>`;
    });
    if (items.length > 4) html += `<div class="cal-more">+${items.length - 4} nữa</div>`;
    html += `</div></div>`;
  });
  html += `</div>`;
  $('cal-grid').innerHTML = html;

  document.querySelectorAll('.cal-chip').forEach((b) =>
    b.addEventListener('click', () => openCalTask(+b.dataset.id, +b.dataset.proj)));
}

// Click task trên lịch: mở dự án của task rồi mở form sửa
async function openCalTask(id, projectId) {
  await selectProject(projectId);
  const full = state.tasks.find((t) => t.id === id);
  if (full) openTaskModal(full);
}

$('menu-calendar').addEventListener('click', openCalendar);
$('cal-today').addEventListener('click', () => { const n = new Date(); state.calMonth = new Date(n.getFullYear(), n.getMonth(), 1); renderCalendar(); });
$('cal-prev').addEventListener('click', () => { state.calMonth = new Date(state.calMonth.getFullYear(), state.calMonth.getMonth() - 1, 1); renderCalendar(); });
$('cal-next').addEventListener('click', () => { state.calMonth = new Date(state.calMonth.getFullYear(), state.calMonth.getMonth() + 1, 1); renderCalendar(); });

/* ---------- Tài liệu dự án (file + link) ---------- */
const DOC_CATS = ['Tài liệu', 'Test case', 'Kết quả test', 'Yêu cầu', 'Khác'];
function fmtSize(b) {
  if (!b) return '';
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(0) + ' KB';
  return (b / 1048576).toFixed(1) + ' MB';
}

function openDocsModal(pid) {
  const proj = state.projects.find((p) => p.id === pid);
  const catOpts = DOC_CATS.map((c) => `<option>${esc(c)}</option>`).join('');
  openModal('📎 Tài liệu · ' + (proj ? proj.name : ''), `
    <div class="doc-upzone" id="doc-upzone">
      <input type="file" id="doc-file" hidden>
      <div class="doc-up-inner">
        <div class="doc-up-ic">⬆️</div>
        Kéo thả file vào đây hoặc <span class="doc-pick" id="doc-pick">bấm để chọn</span>
        <div class="muted" style="margin-top:4px">Tối đa 50MB · pdf, ảnh, office, zip, csv…</div>
      </div>
    </div>
    <div class="doc-addrow">
      <select id="doc-cat" class="input">${catOpts}</select>
      <input id="doc-linkurl" class="input" placeholder="Dán link tài liệu (https://…)">
      <input id="doc-linkname" class="input" placeholder="Tên hiển thị (tùy chọn)">
      <button class="btn primary" id="doc-addlink">＋ Link</button>
    </div>
    <div id="doc-list" class="doc-list"><div class="muted">Đang tải…</div></div>
  `, `<button class="btn ghost" id="doc-close">Đóng</button>`);

  $('doc-close').addEventListener('click', closeModal);
  const fileInput = $('doc-file');
  $('doc-pick').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { if (fileInput.files[0]) uploadDoc(pid, fileInput.files[0]); });

  const zone = $('doc-upzone');
  ['dragover', 'dragenter'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add('over'); }));
  ['dragleave', 'dragend'].forEach((ev) => zone.addEventListener(ev, () => zone.classList.remove('over')));
  zone.addEventListener('drop', (e) => {
    e.preventDefault(); zone.classList.remove('over');
    const f = e.dataTransfer.files[0]; if (f) uploadDoc(pid, f);
  });
  $('doc-addlink').addEventListener('click', () => addDocLink(pid));
  renderDocs(pid);
}

async function renderDocs(pid) {
  try {
    const d = await api('documents', { query: { project_id: pid } });
    const wrap = $('doc-list');
    if (!wrap) return;
    if (!d.documents.length) {
      wrap.innerHTML = '<div class="doc-empty">Chưa có tài liệu. Tải file hoặc thêm link ở trên.</div>';
      return;
    }
    wrap.innerHTML = d.documents.map((doc) => {
      const isFile = doc.kind === 'file';
      const href = isFile ? `api.php?action=doc_download&id=${doc.id}` : doc.url;
      const meta = [doc.uploader, doc.created_at ? doc.created_at.slice(0, 10) : '', isFile ? fmtSize(doc.size) : 'link']
        .filter(Boolean).join(' · ');
      return `<div class="doc-item">
        <span class="doc-ic">${isFile ? '📄' : '🔗'}</span>
        <div class="doc-main">
          <a href="${esc(href)}" target="_blank" rel="noopener" class="doc-name">${esc(doc.name)}</a>
          <div class="doc-meta">${esc(meta)}</div>
        </div>
        <span class="doc-cat">${esc(doc.category)}</span>
        <button class="ta-btn doc-del" data-id="${doc.id}" title="Xóa">🗑</button>
      </div>`;
    }).join('');
    wrap.querySelectorAll('.doc-del').forEach((b) =>
      b.addEventListener('click', () => delDoc(pid, +b.dataset.id)));
  } catch (e) { toast(e.message, true); }
}

async function uploadDoc(pid, file) {
  if (file.size > 52428800) { toast('File vượt quá 50MB.', true); return; }
  const fd = new FormData();
  fd.append('project_id', pid);
  fd.append('category', $('doc-cat') ? $('doc-cat').value : 'Tài liệu');
  fd.append('file', file);
  const list = $('doc-list'); if (list) list.insertAdjacentHTML('afterbegin', '<div class="muted" id="doc-uploading">Đang tải lên…</div>');
  try {
    const res = await fetch('api.php?action=doc_upload', {
      method: 'POST', credentials: 'include', headers: { 'X-CSRF-Token': state.csrf }, body: fd,
    });
    const data = await res.json();
    if (!res.ok || data.ok === false) throw new Error(data.error || 'Tải lên thất bại.');
    toast('Đã tải lên.'); await renderDocs(pid);
  } catch (e) { toast(e.message, true); const el = $('doc-uploading'); if (el) el.remove(); }
}

async function addDocLink(pid) {
  const url = $('doc-linkurl').value.trim();
  if (!url) { toast('Nhập link tài liệu.', true); return; }
  try {
    await api('doc_link', { method: 'POST', body: { project_id: pid, url, name: $('doc-linkname').value.trim(), category: $('doc-cat').value } });
    $('doc-linkurl').value = ''; $('doc-linkname').value = '';
    toast('Đã thêm link.'); await renderDocs(pid);
  } catch (e) { toast(e.message, true); }
}

async function delDoc(pid, id) {
  if (!confirm('Xóa tài liệu này?')) return;
  try { await api('doc_delete', { method: 'POST', body: { id } }); await renderDocs(pid); toast('Đã xóa.'); }
  catch (e) { toast(e.message, true); }
}

$('docs-btn').addEventListener('click', () => { if (state.currentProjectId) openDocsModal(state.currentProjectId); });

/* ---------- Người dùng (Quản lý) ---------- */
async function loadUsers() {
  try { const d = await api('users'); state.users = d.users; } catch (e) {}
}
async function openUsersView() {
  switchView('users');
  await loadUsers();
  const wrap = $('user-list');
  wrap.innerHTML = state.users.map((u) => `
    <div class="user-row">
      <div class="avatar">${esc((u.full_name || u.username).slice(0,1).toUpperCase())}</div>
      <div class="user-info">
        <b>${esc(u.full_name || u.username)} ${u.active ? '' : '<span class="inactive-tag">(khóa)</span>'}</b>
        <span class="muted" style="margin:0">@${esc(u.username)} · ${u.role === 'manager' ? 'Quản lý' : 'Nhân viên QC'}</span>
      </div>
      <button class="btn tiny edit-user" data-id="${u.id}">Sửa</button>
      ${u.id !== state.user.id ? `<button class="btn tiny danger del-user" data-id="${u.id}">Xóa</button>` : ''}
    </div>`).join('');
  wrap.querySelectorAll('.edit-user').forEach((b) =>
    b.addEventListener('click', () => openUserModal(state.users.find((u) => u.id === +b.dataset.id))));
  wrap.querySelectorAll('.del-user').forEach((b) =>
    b.addEventListener('click', () => delUser(+b.dataset.id)));
}
$('menu-users').addEventListener('click', openUsersView);
$('add-user-btn').addEventListener('click', () => openUserModal(null));

function openUserModal(u) {
  openModal(u ? 'Sửa người dùng' : 'Thêm người dùng', `
    <label>Tên đăng nhập *</label>
    <input id="u-username" value="${u ? esc(u.username) : ''}">
    <label>Họ và tên</label>
    <input id="u-fullname" value="${u ? esc(u.full_name) : ''}">
    <div class="form-row">
      <div><label>Vai trò</label>
        <select id="u-role">
          <option value="qc" ${u && u.role === 'qc' ? 'selected' : ''}>Nhân viên QC</option>
          <option value="manager" ${u && u.role === 'manager' ? 'selected' : ''}>Quản lý</option>
        </select></div>
      <div><label>Trạng thái</label>
        <select id="u-active">
          <option value="1" ${!u || u.active ? 'selected' : ''}>Hoạt động</option>
          <option value="0" ${u && !u.active ? 'selected' : ''}>Khóa</option>
        </select></div>
    </div>
    <label>Mật khẩu ${u ? '(để trống nếu không đổi)' : '*'}</label>
    <input id="u-password" type="password" autocomplete="new-password">
  `, `
    <button class="btn ghost" id="u-cancel">Hủy</button>
    <button class="btn primary" id="u-save">Lưu</button>
  `);
  $('u-cancel').addEventListener('click', closeModal);
  $('u-save').addEventListener('click', async () => {
    const body = {
      id: u ? u.id : 0,
      username: $('u-username').value.trim(),
      full_name: $('u-fullname').value.trim(),
      role: $('u-role').value, active: +$('u-active').value,
      password: $('u-password').value,
    };
    try { await api('user_save', { method: 'POST', body }); closeModal(); await openUsersView(); toast('Đã lưu người dùng.'); }
    catch (e) { toast(e.message, true); }
  });
}
async function delUser(id) {
  if (!confirm('Xóa người dùng này?')) return;
  try { await api('user_delete', { method: 'POST', body: { id } }); await openUsersView(); toast('Đã xóa.'); }
  catch (e) { toast(e.message, true); }
}

/* ---------- Chuyển khung nhìn ---------- */
function switchView(view) {
  state.currentView = view;
  $('view-tasks').classList.toggle('hidden', view !== 'tasks');
  $('view-reminders').classList.toggle('hidden', view !== 'reminders');
  $('view-users').classList.toggle('hidden', view !== 'users');
  $('view-calendar').classList.toggle('hidden', view !== 'calendar');
  $('menu-reminders').classList.toggle('active', view === 'reminders');
  $('menu-users').classList.toggle('active', view === 'users');
  $('menu-calendar').classList.toggle('active', view === 'calendar');
  closeSidebarMobile();
}

/* ---------- Menu điện thoại ---------- */
$('nav-toggle').addEventListener('click', () => $('sidebar').classList.toggle('open'));
function closeSidebarMobile() { if (window.innerWidth <= 760) $('sidebar').classList.remove('open'); }

/* ---------- Chạy ---------- */
boot();
