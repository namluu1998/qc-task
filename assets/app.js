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
  taskViewMode: 'list',   // 'list' | 'kanban'
};
let kdragId = null;        // id thẻ đang kéo trên Kanban

/* ---------- Bảng màu ---------- */
const PRI_STYLE = {
  'Thấp':       { bg: '#f1f5f9', c: '#475569' },
  'Trung bình': { bg: '#e0f2fe', c: '#0369a1' },
  'Cao':        { bg: '#fff7ed', c: '#c2410c' },
  'Khẩn cấp':   { bg: '#fef2f2', c: '#b91c1c' },
};
const PRI_ORDER = { 'Khẩn cấp': 0, 'Cao': 1, 'Trung bình': 2, 'Thấp': 3 };

// Trạng thái nạp động từ cấu hình (meta.statusDefs) — xem applyStatusDefs()
let STATUS_DOT = {}, ST_COLOR = {}, ST_ORDER = {}, GROUP_ORDER = [];
let DONE_STATUS = 'Đạt', FIRST_STATUS = 'Chưa test';
function applyStatusDefs(defs) {
  if (!defs || !defs.length) return;
  STATUS_DOT = {}; ST_COLOR = {}; ST_ORDER = {}; GROUP_ORDER = [];
  defs.forEach((d, i) => { STATUS_DOT[d.name] = d.color; ST_COLOR[d.name] = d.color; ST_ORDER[d.name] = i; GROUP_ORDER.push(d.name); });
  const done = defs.find((d) => d.is_done);
  DONE_STATUS = done ? done.name : defs[defs.length - 1].name;
  FIRST_STATUS = defs[0].name;
}

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
  if (d.meta) { state.meta = d.meta; applyStatusDefs(d.meta.statusDefs); }
  $('login-screen').classList.add('hidden');
  $('app').classList.remove('hidden');
  $('user-name').textContent = d.user.full_name || d.user.username;
  $('user-avatar').innerHTML = avatarHtml(d.user.full_name || d.user.username, d.user.id, d.user.avatar);
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

/* ---------- Hồ sơ cá nhân (đổi tên + đổi mật khẩu) ---------- */
function openProfileModal() {
  const u = state.user; if (!u) return;
  openModal('👤 Hồ sơ của tôi', `
    <div class="muted" style="margin:0 0 14px">@${esc(u.username)} · ${u.role === 'manager' ? 'Quản lý' : 'Nhân viên QC'}</div>
    <label>Ảnh đại diện</label>
    <div class="pf-avatar-row">
      <div id="pf-avatar" class="pf-avatar">${avatarHtml(u.full_name || u.username, u.id, u.avatar)}</div>
      <div class="pf-avatar-actions">
        <input type="file" id="pf-avatar-file" accept="image/png,image/jpeg,image/gif,image/webp" hidden>
        <button class="btn tiny" id="pf-avatar-btn">✎ Đổi ảnh</button>
        <button class="btn tiny danger ${u.avatar ? '' : 'hidden'}" id="pf-avatar-remove">Xóa ảnh</button>
        <div class="muted" style="margin-top:5px">Ảnh vuông (1:1), tối đa 5MB.</div>
      </div>
    </div>
    <label style="margin-top:14px">Họ và tên</label>
    <input id="pf-name" value="${esc(u.full_name || '')}">
    <div style="border-top:1px solid var(--border); margin-top:18px; padding-top:14px">
      <div class="rep-title" style="margin-bottom:10px">🔒 Đổi mật khẩu</div>
      <label>Mật khẩu hiện tại</label>
      <input id="pf-cur" type="password" autocomplete="current-password">
      <div class="form-row">
        <div><label>Mật khẩu mới</label><input id="pf-new" type="password" autocomplete="new-password"></div>
        <div><label>Nhập lại</label><input id="pf-new2" type="password" autocomplete="new-password"></div>
      </div>
      <button class="btn" id="pf-changepw" style="margin-top:10px">Đổi mật khẩu</button>
    </div>
  `, `<button class="btn ghost" id="pf-cancel">Đóng</button><button class="btn primary" id="pf-save">Lưu tên</button>`);
  $('pf-cancel').addEventListener('click', closeModal);
  const refreshAvatar = () => {
    const html = avatarHtml(state.user.full_name || state.user.username, state.user.id, state.user.avatar);
    $('pf-avatar').innerHTML = html; $('user-avatar').innerHTML = html;
    $('pf-avatar-remove').classList.toggle('hidden', !state.user.avatar);
  };
  $('pf-avatar-btn').addEventListener('click', () => $('pf-avatar-file').click());
  $('pf-avatar-file').addEventListener('change', async () => {
    const f = $('pf-avatar-file').files[0]; if (!f) return;
    if (f.size > 5 * 1024 * 1024) { toast('Ảnh tối đa 5MB.', true); return; }
    const fd = new FormData(); fd.append('file', f);
    try {
      const res = await fetch('api.php?action=avatar_upload', { method: 'POST', credentials: 'include', headers: { 'X-CSRF-Token': state.csrf }, body: fd });
      const d = await res.json();
      if (!res.ok || d.ok === false) throw new Error(d.error || 'Tải ảnh thất bại.');
      state.user.avatar = d.avatar; refreshAvatar(); toast('Đã cập nhật ảnh.');
    } catch (e) { toast(e.message, true); }
  });
  $('pf-avatar-remove').addEventListener('click', async () => {
    try { await api('avatar_remove', { method: 'POST', body: {} }); state.user.avatar = null; refreshAvatar(); toast('Đã xóa ảnh.'); }
    catch (e) { toast(e.message, true); }
  });
  $('pf-save').addEventListener('click', async () => {
    const name = $('pf-name').value.trim();
    if (!name) { toast('Nhập họ tên.', true); return; }
    try {
      await api('profile_save', { method: 'POST', body: { full_name: name } });
      state.user.full_name = name; $('user-name').textContent = name;
      closeModal(); toast('Đã lưu hồ sơ.');
    } catch (e) { toast(e.message, true); }
  });
  $('pf-changepw').addEventListener('click', async () => {
    const cur = $('pf-cur').value, nw = $('pf-new').value, nw2 = $('pf-new2').value;
    if (nw.length < 6) { toast('Mật khẩu mới tối thiểu 6 ký tự.', true); return; }
    if (nw !== nw2) { toast('Mật khẩu nhập lại không khớp.', true); return; }
    try {
      await api('change_password', { method: 'POST', body: { current_password: cur, new_password: nw } });
      $('pf-cur').value = ''; $('pf-new').value = ''; $('pf-new2').value = '';
      toast('Đã đổi mật khẩu.');
    } catch (e) { toast(e.message, true); }
  });
}
document.querySelector('.user-chip').addEventListener('click', openProfileModal);

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
  $('task-view-toggle').classList.remove('hidden');
  $('edit-project-btn').classList.toggle('hidden', state.user.role !== 'manager');
  $('task-toolbar').classList.remove('hidden');
  closeSidebarMobile();
  await loadTasks();
}

async function loadTasks() {
  const d = await api('tasks', { query: { project_id: state.currentProjectId } });
  state.tasks = d.tasks;
  renderCurrentTaskView();
}

// Chọn kiểu hiển thị công việc: Danh sách hoặc Kanban
function renderCurrentTaskView() {
  const kanban = state.taskViewMode === 'kanban';
  $('filter-status').classList.toggle('hidden', kanban);   // Kanban đã nhóm sẵn theo cột
  $('sort-by').classList.toggle('hidden', kanban);
  document.querySelectorAll('#task-view-toggle .seg-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.mode === state.taskViewMode));
  kanban ? renderKanban() : renderTasks();
}

document.querySelectorAll('#task-view-toggle .seg-btn').forEach((b) =>
  b.addEventListener('click', () => { state.taskViewMode = b.dataset.mode; renderCurrentTaskView(); }));

/* ---------- Kanban ---------- */
function renderKanban() {
  const wrap = $('task-list');
  const search = $('task-search').value.trim().toLowerCase();
  const children = {};
  state.tasks.forEach((t) => { if (t.parent_id) (children[t.parent_id] ??= []).push(t); });

  let tops = state.tasks.filter((t) => !t.parent_id);
  if (search) tops = tops.filter((t) =>
    (t.title + ' ' + (t.description || '')).toLowerCase().includes(search) ||
    (children[t.id] || []).some((c) => c.title.toLowerCase().includes(search)));

  const groups = GROUP_ORDER.filter((s) => state.meta.statuses.includes(s));
  let html = '<div class="kanban">';
  groups.forEach((status) => {
    const rows = tops.filter((t) => t.status === status).sort((a, b) => a.sort_order - b.sort_order);
    html += `<div class="kcol">
      <div class="kcol-head">
        <span class="tg-dot" style="background:${STATUS_DOT[status]}"></span>
        <span class="kcol-name">${esc(status)}</span>
        <span class="tg-count">${rows.length}</span>
      </div>
      <div class="kcol-body" data-status="${esc(status)}">
        ${rows.map((t) => kanbanCard(t, children[t.id] || [])).join('') || '<div class="kcol-empty">Chưa có task</div>'}
      </div>
    </div>`;
  });
  html += '</div>';
  wrap.innerHTML = html;
  $('task-empty').classList.add('hidden');
  bindKanbanEvents();
}

function kanbanCard(t, kids) {
  const done = t.status === DONE_STATUS;
  const pri = PRI_ICON[t.priority] || PRI_ICON['Trung bình'];
  const today = new Date().toISOString().slice(0, 10);
  const overdue = t.due_date && t.due_date < today && !done;
  const doneKids = kids.filter((k) => k.status === DONE_STATUS).length;
  return `<div class="kcard ${done ? 'done' : ''}" draggable="true" data-id="${t.id}">
    <div class="kcard-top">
      <span class="pri-ind" style="color:${pri.c}" title="${esc(t.priority)}">${pri.icon}</span>
      <span class="kcard-title">${esc(t.title)}</span>
    </div>
    <div class="kcard-meta">
      ${avatarHtml(t.assignee_name, t.assignee_id, t.assignee_avatar)}
      ${kids.length ? `<span class="subprog">${doneKids}/${kids.length}</span>` : ''}
      ${t.due_date ? `<span class="due-pill ${overdue ? 'overdue' : ''}">📅 ${esc(t.due_date.slice(5))}</span>` : ''}
    </div>
  </div>`;
}

function bindKanbanEvents() {
  document.querySelectorAll('.kcard').forEach((c) => {
    c.addEventListener('click', () => openTaskModal(state.tasks.find((t) => t.id === +c.dataset.id)));
    c.addEventListener('dragstart', (e) => {
      kdragId = +c.dataset.id; c.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', String(kdragId)); } catch (_) {}
    });
    c.addEventListener('dragend', () => {
      document.querySelectorAll('.kcard.dragging').forEach((x) => x.classList.remove('dragging'));
      document.querySelectorAll('.kcol-body.over').forEach((x) => x.classList.remove('over'));
      kdragId = null;
    });
  });
  document.querySelectorAll('.kcol-body').forEach((col) => {
    col.addEventListener('dragover', (e) => { if (kdragId == null) return; e.preventDefault(); col.classList.add('over'); });
    col.addEventListener('dragleave', () => col.classList.remove('over'));
    col.addEventListener('drop', async (e) => {
      if (kdragId == null) return;
      e.preventDefault(); col.classList.remove('over');
      const status = col.dataset.status, id = kdragId;
      const t = state.tasks.find((x) => x.id === id);
      if (t && t.status !== status) {
        try { await api('task_status', { method: 'POST', body: { id, status } }); await loadTasks(); loadProjects(); refreshReminderCount(); }
        catch (err) { toast(err.message, true); }
      }
    });
  });
}

/* ---------- Hiển thị công việc (bảng nhóm theo trạng thái) ---------- */
const PRI_ICON = {
  'Khẩn cấp': { icon: '⇈', c: '#e5484d' }, 'Cao': { icon: '↑', c: '#f76808' },
  'Trung bình': { icon: '—', c: '#98a2b3' }, 'Thấp': { icon: '↓', c: '#98a2b3' },
};
let dragId = null;   // id việc đang kéo (kéo-thả sắp xếp)

// Avatar chữ cái đầu, màu suy ra từ tên (ổn định).
function avatarHtml(name, uid, avatarFile) {
  if (uid && avatarFile) {
    return `<img class="avatar-mini avatar-img" src="api.php?action=avatar&id=${uid}&v=${encodeURIComponent(avatarFile)}" alt="${esc(name || '')}" title="${esc(name || '')}">`;
  }
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
    <div class="tc-act">Hành động</div>
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
          kids.forEach((c) => { html += taskRow(c, true, [], manual); });
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
  const done = t.status === DONE_STATUS;
  const today = new Date().toISOString().slice(0, 10);
  const overdue = t.due_date && t.due_date < today && !done;
  const pri = PRI_ICON[t.priority] || PRI_ICON['Trung bình'];
  const hasKids = kids && kids.length;
  const doneKids = hasKids ? kids.filter((k) => k.status === DONE_STATUS).length : 0;
  const expanded = hasKids && !state.collapsedParents.has(t.id);
  const canDrag = manual && !isSub;
  const stOpts = state.meta.statuses.map((s) =>
    `<option value="${esc(s)}" ${s === t.status ? 'selected' : ''}>${esc(s)}</option>`).join('');

  const caret = !isSub && hasKids
    ? `<button class="tw-caret ${expanded ? 'open' : ''}" data-exp="${t.id}" title="Hiện/ẩn nhiệm vụ con">▸</button>`
    : `<span class="caret-spacer"></span>`;

  const actions = `
    ${manual ? `<span class="drag-grip" draggable="true" data-id="${t.id}" title="Kéo để sắp xếp">⠿</span>` : ''}
    ${!isSub ? `<button class="ta-btn add-sub" data-id="${t.id}" title="Thêm nhiệm vụ con">＋</button>` : ''}
    <button class="ta-btn edit-task" data-id="${t.id}" title="Sửa">✎</button>
    <button class="ta-btn del-task" data-id="${t.id}" title="Xóa">🗑</button>`;

  return `
  <div class="trow ${isSub ? 'sub' : ''} ${done ? 'done' : ''}" data-id="${t.id}" data-parent="${t.parent_id || 0}">
    <div class="tc-check">
      ${caret}
      <button class="tcheck ${done ? 'checked' : ''}" data-check="${t.id}" title="Đánh dấu hoàn thành"></button>
    </div>
    <div class="tc-title">
      <span class="trow-title edit-task" data-id="${t.id}">${esc(t.title)}</span>
      ${hasKids ? `<span class="subprog" title="Nhiệm vụ con đã hoàn thành">${doneKids}/${kids.length}</span>` : ''}
      ${overdue ? `<span class="overdue-flag" title="Quá hạn">Quá hạn</span>` : ''}
    </div>
    <div class="tc-assignee">${avatarHtml(t.assignee_name, t.assignee_id, t.assignee_avatar)}</div>
    <div class="tc-due">${t.due_date ? `<span class="due-pill ${overdue ? 'overdue' : ''}">${esc(t.due_date.slice(5))}</span>` : '<span class="due-empty">+ Hạn</span>'}</div>
    <div class="tc-status"><select class="status-select st-change" style="color:${ST_COLOR[t.status]}" data-id="${t.id}">${stOpts}</select></div>
    <div class="tc-pri"><span class="pri-ind" style="color:${pri.c}">${pri.icon} ${esc(t.priority)}</span></div>
    <div class="tc-act"><span class="trow-actions">${actions}</span></div>
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
      const next = t.status === DONE_STATUS ? FIRST_STATUS : DONE_STATUS;
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

  // ---- Kéo-thả sắp xếp (việc cha & nhiệm vụ con) ----
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
  // Thả lên một dòng khác → chèn trước/sau (việc cha đổi nhóm = đổi trạng thái; task con xếp trong cùng cha)
  document.querySelectorAll('.trow:not(.thead)').forEach((row) => {
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
  const dragParent = dragT.parent_id || 0;
  const targParent = targT.parent_id || 0;
  try {
    if (dragParent === 0 && targParent === 0) {
      // Việc cha: sắp xếp giữa các việc cha; kéo sang nhóm khác = đổi trạng thái
      if (dragT.status !== targT.status) {
        await api('task_status', { method: 'POST', body: { id: dragId, status: targT.status } });
        dragT.status = targT.status;
      }
      let ids = topLevelInDisplayOrder().map((t) => t.id).filter((id) => id !== dragId);
      let idx = ids.indexOf(targetId); if (idx < 0) idx = ids.length - 1;
      ids.splice(pos === 'after' ? idx + 1 : idx, 0, dragId);
      await saveOrder(ids);
    } else if (dragParent !== 0 && dragParent === targParent) {
      // Nhiệm vụ con: chỉ sắp xếp trong cùng việc cha
      let sibs = state.tasks.filter((t) => t.parent_id === dragParent).sort((a, b) => a.sort_order - b.sort_order)
        .map((t) => t.id).filter((id) => id !== dragId);
      let idx = sibs.indexOf(targetId); if (idx < 0) idx = sibs.length - 1;
      sibs.splice(pos === 'after' ? idx + 1 : idx, 0, dragId);
      const childrenMap = {};
      state.tasks.forEach((t) => { if (t.parent_id) (childrenMap[t.parent_id] ??= []).push(t.id); });
      childrenMap[dragParent] = sibs; // thứ tự mới cho việc cha này
      const ordered = [];
      topLevelInDisplayOrder().forEach((t) => { ordered.push(t.id); (childrenMap[t.id] || []).forEach((c) => ordered.push(c)); });
      await api('task_reorder', { method: 'POST', body: { project_id: state.currentProjectId, ordered_ids: ordered } });
      await loadTasks(); loadProjects(); refreshReminderCount();
    }
    // Kéo lẫn giữa cha/con hoặc khác cha: bỏ qua
  } catch (e) { toast(e.message, true); }
}
async function performMoveToGroup(dragId, status) {
  const dragT = state.tasks.find((t) => t.id === dragId);
  if (!dragT || dragT.parent_id) return; // chỉ việc cha mới đổi nhóm/trạng thái
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
  $('modal').classList.remove('wide');
  $('modal').innerHTML = `
    <div class="modal-head"><h3>${esc(title)}</h3><button class="icon-btn" id="modal-x">✕</button></div>
    <div class="modal-body">${bodyHtml}</div>
    <div class="modal-foot">${footHtml}</div>`;
  $('modal-backdrop').classList.remove('hidden');
  $('modal-x').addEventListener('click', closeModal);
}
function closeModal() { $('modal-backdrop').classList.add('hidden'); $('modal').innerHTML = ''; $('modal').classList.remove('wide'); }
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
      <div><label>Ngày bắt đầu</label><input id="t-start" type="date" value="${task && task.start_date ? esc(task.start_date.slice(0,10)) : ''}"></div>
      <div><label>Hạn chót</label><input id="t-due" type="date" value="${task && task.due_date ? esc(task.due_date.slice(0,10)) : ''}"></div>
    </div>
    <label>Nhắc lúc</label>
    <input id="t-remind" type="datetime-local" value="${task && task.remind_at ? esc(task.remind_at.replace(' ','T').slice(0,16)) : ''}">
    ${task && !task.parent_id ? '<div class="task-subs" id="task-subtasks"></div>' : ''}
    ${task ? `
    <div class="task-collab" id="task-collab">
      <div class="tc-follow" id="tc-follow"></div>
      <div class="tc-tabs">
        <button type="button" class="tc-tab active" data-tab="comments">💬 Bình luận</button>
        <button type="button" class="tc-tab" data-tab="activity">📜 Hoạt động</button>
        <button type="button" class="tc-tab" data-tab="files">📎 Tệp</button>
      </div>
      <div class="tc-pane" id="tc-comments"><div class="muted">Đang tải…</div></div>
      <div class="tc-pane hidden" id="tc-activity"></div>
      <div class="tc-pane hidden" id="tc-files"></div>
    </div>` : ''}
  `, `
    <button class="btn ghost" id="t-cancel">Hủy</button>
    <button class="btn primary" id="t-save">Lưu</button>
  `);
  $('t-cancel').addEventListener('click', closeModal);
  if (task) {
    $('modal').classList.add('wide');
    document.querySelectorAll('#task-collab .tc-tab').forEach((b) => b.addEventListener('click', () => {
      document.querySelectorAll('#task-collab .tc-tab').forEach((x) => x.classList.toggle('active', x === b));
      ['comments', 'activity', 'files'].forEach((k) => $('tc-' + k).classList.toggle('hidden', k !== b.dataset.tab));
    }));
    loadTaskFeed(task.id, task.project_id != null ? task.project_id : state.currentProjectId);
    if (!task.parent_id) renderSubtasksSection(task.id);
  }
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
      start_date: $('t-start').value || '', due_date: $('t-due').value || '', remind_at: remind,
    };
    try { await api('task_save', { method: 'POST', body }); closeModal(); await loadTasks(); loadProjects(); refreshReminderCount(); toast('Đã lưu.'); }
    catch (e) { toast(e.message, true); }
  });
  setTimeout(() => $('t-title').focus(), 50);
}
$('add-task-btn').addEventListener('click', () => openTaskModal(null));

/* ---------- Nhiệm vụ con trong chi tiết task cha ---------- */
function renderSubtasksSection(taskId) {
  const el = $('task-subtasks'); if (!el) return;
  const subs = state.tasks.filter((t) => t.parent_id === taskId).sort((a, b) => a.sort_order - b.sort_order);
  const doneN = subs.filter((s) => s.status === DONE_STATUS).length;
  const pct = subs.length ? Math.round(doneN / subs.length * 100) : 0;
  el.innerHTML = `
    <div class="subs-head">✅ Nhiệm vụ con <span class="subs-count">${doneN}/${subs.length}</span></div>
    ${subs.length ? `<div class="prog subs-prog"><div class="prog-fill" style="width:${pct}%;background:var(--ok)"></div></div>` : ''}
    <div class="subs-list">
      ${subs.map((s) => `<div class="sub-item ${s.status === DONE_STATUS ? 'done' : ''}">
        <button class="tcheck ${s.status === DONE_STATUS ? 'checked' : ''}" data-subcheck="${s.id}" title="Đánh dấu hoàn thành"></button>
        <span class="sub-item-title" data-subopen="${s.id}">${esc(s.title)}</span>
        <span class="sub-item-status" style="color:${STATUS_DOT[s.status] || 'var(--muted)'}">${esc(s.status)}</span>
        ${avatarHtml(s.assignee_name, s.assignee_id, s.assignee_avatar)}
      </div>`).join('') || '<div class="muted" style="padding:4px 0">Chưa có nhiệm vụ con.</div>'}
    </div>
    <div class="subs-add">
      <input id="subs-new" class="input" placeholder="Thêm nhiệm vụ con…">
      <button class="btn" id="subs-add-btn">＋ Thêm</button>
    </div>`;
  el.querySelectorAll('[data-subcheck]').forEach((b) => b.addEventListener('click', async () => {
    const s = state.tasks.find((x) => x.id === +b.dataset.subcheck);
    const next = s.status === DONE_STATUS ? FIRST_STATUS : DONE_STATUS;
    try { await api('task_status', { method: 'POST', body: { id: s.id, status: next } }); await loadTasks(); renderSubtasksSection(taskId); loadProjects(); }
    catch (e) { toast(e.message, true); }
  }));
  el.querySelectorAll('[data-subopen]').forEach((t) => t.addEventListener('click', () => {
    const s = state.tasks.find((x) => x.id === +t.dataset.subopen); if (s) openTaskModal(s);
  }));
  const addSub = async () => {
    const title = $('subs-new').value.trim(); if (!title) return;
    try {
      await api('task_save', { method: 'POST', body: { project_id: state.currentProjectId, parent_id: taskId, title, status: FIRST_STATUS, priority: 'Trung bình' } });
      await loadTasks(); renderSubtasksSection(taskId); loadProjects(); toast('Đã thêm nhiệm vụ con.');
    } catch (e) { toast(e.message, true); }
  };
  $('subs-add-btn').addEventListener('click', addSub);
  $('subs-new').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addSub(); } });
}

/* ---------- Chi tiết task: bình luận + hoạt động + tệp ---------- */
async function loadTaskFeed(taskId, projectId) {
  state._feed = { taskId, projectId };
  try {
    const d = await api('task_feed', { query: { task_id: taskId } });
    renderFollow(d.followers || [], d.following);
    renderComments(d.comments, d.me);
    renderActivity(d.activity);
    renderTaskFiles(d.attachments);
    const ft = document.querySelector('#task-collab .tc-tab[data-tab="files"]');
    if (ft) ft.textContent = `📎 Tệp (${d.attachments.length})`;
  } catch (e) { toast(e.message, true); }
}

function renderFollow(followers, following) {
  const el = $('tc-follow'); if (!el) return;
  const avatars = followers.slice(0, 6).map((f) => avatarHtml(f.name, f.id, f.avatar)).join('');
  el.innerHTML = `
    <button class="btn tiny ${following ? 'primary' : ''}" id="follow-btn">${following ? '✓ Đang theo dõi' : '👁 Theo dõi'}</button>
    <span class="follow-avatars">${avatars}</span>
    <span class="muted" style="margin:0">${followers.length ? followers.length + ' người theo dõi' : 'Chưa có người theo dõi'}</span>`;
  $('follow-btn').addEventListener('click', async () => {
    try { await api('follow_toggle', { method: 'POST', body: { task_id: state._feed.taskId } }); loadTaskFeed(state._feed.taskId, state._feed.projectId); }
    catch (e) { toast(e.message, true); }
  });
}

function renderComments(comments, me) {
  const pane = $('tc-comments'); if (!pane) return;
  const list = comments.length ? comments.map((c) => `
    <div class="cmt">${avatarHtml(c.author, c.user_id, c.author_avatar)}
      <div class="cmt-main">
        <div class="cmt-head"><b>${esc(c.author || '—')}</b> <span class="muted" style="margin:0">${esc((c.created_at || '').slice(0, 16))}</span>
          ${(me.role === 'manager' || me.id === c.user_id) ? `<button class="cmt-del" data-id="${c.id}" title="Xóa">✕</button>` : ''}</div>
        <div class="cmt-body">${esc(c.body)}</div>
      </div>
    </div>`).join('') : '<div class="muted">Chưa có bình luận.</div>';
  pane.innerHTML = `<div class="cmt-list">${list}</div>
    <div class="cmt-compose">
      <textarea id="cmt-input" rows="2" placeholder="Viết bình luận…"></textarea>
      <button class="btn primary" id="cmt-send">Gửi</button>
    </div>`;
  $('cmt-send').addEventListener('click', addComment);
  pane.querySelectorAll('.cmt-del').forEach((b) => b.addEventListener('click', () => delComment(+b.dataset.id)));
}
async function addComment() {
  const input = $('cmt-input'); const text = input.value.trim();
  if (!text) return;
  try { await api('comment_add', { method: 'POST', body: { task_id: state._feed.taskId, body: text } }); loadTaskFeed(state._feed.taskId, state._feed.projectId); }
  catch (e) { toast(e.message, true); }
}
async function delComment(id) {
  if (!confirm('Xóa bình luận này?')) return;
  try { await api('comment_delete', { method: 'POST', body: { id } }); loadTaskFeed(state._feed.taskId, state._feed.projectId); }
  catch (e) { toast(e.message, true); }
}

function renderActivity(activity) {
  const pane = $('tc-activity'); if (!pane) return;
  pane.innerHTML = activity.length
    ? `<div class="act-list">${activity.map((a) => `
        <div class="act-item"><span class="act-dot"></span>
          <div><b>${esc(a.author || '—')}</b> ${esc(a.action)} <span class="muted" style="margin:0">· ${esc((a.created_at || '').slice(0, 16))}</span></div>
        </div>`).join('')}</div>`
    : '<div class="muted">Chưa có hoạt động.</div>';
}

function renderTaskFiles(atts) {
  const pane = $('tc-files'); if (!pane) return;
  const list = atts.length ? atts.map((d) => `<div class="doc-item">
      <span class="doc-ic">${docIcon(d)}</span>
      <div class="doc-main">${docNameHtml(d)}
        <div class="doc-meta">${d.kind === 'file' ? fmtSize(d.size) : 'link'} · ${esc((d.created_at || '').slice(0, 10))}</div></div>
      <button class="ta-btn tf-del" data-id="${d.id}" title="Xóa">🗑</button>
    </div>`).join('') : '<div class="muted">Chưa có tệp đính kèm.</div>';
  pane.innerHTML = `
    <div class="doc-upzone" id="tf-upzone"><input type="file" id="tf-file" hidden>
      <div class="doc-up-inner"><div class="doc-up-ic">⬆️</div>Kéo thả ảnh/file hoặc <span class="doc-pick" id="tf-pick">bấm để chọn</span><div class="muted" style="margin-top:4px">Tối đa 50MB</div></div></div>
    <div class="tf-linkrow"><input id="tf-linkurl" class="input" placeholder="Hoặc dán link (https://…)"><button class="btn" id="tf-addlink">＋ Link</button></div>
    <div class="doc-list" style="margin-top:12px">${list}</div>`;
  const up = $('tf-upzone'), fi = $('tf-file');
  $('tf-pick').addEventListener('click', () => fi.click());
  fi.addEventListener('change', () => { if (fi.files[0]) tfUpload(fi.files[0]); });
  ['dragover', 'dragenter'].forEach((ev) => up.addEventListener(ev, (e) => { e.preventDefault(); up.classList.add('over'); }));
  ['dragleave', 'dragend'].forEach((ev) => up.addEventListener(ev, () => up.classList.remove('over')));
  up.addEventListener('drop', (e) => { e.preventDefault(); up.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) tfUpload(f); });
  $('tf-addlink').addEventListener('click', tfAddLink);
  pane.querySelectorAll('.tf-del').forEach((b) => b.addEventListener('click', () => tfDelete(+b.dataset.id)));
  bindDocPreview(pane);
}
async function tfUpload(file) {
  if (file.size > 52428800) { toast('File vượt quá 50MB.', true); return; }
  const fd = new FormData();
  fd.append('project_id', state._feed.projectId); fd.append('task_id', state._feed.taskId); fd.append('category', 'Tài liệu'); fd.append('file', file);
  try {
    const res = await fetch('api.php?action=doc_upload', { method: 'POST', credentials: 'include', headers: { 'X-CSRF-Token': state.csrf }, body: fd });
    const data = await res.json();
    if (!res.ok || data.ok === false) throw new Error(data.error || 'Tải lên thất bại.');
    toast('Đã đính kèm.'); loadTaskFeed(state._feed.taskId, state._feed.projectId);
  } catch (e) { toast(e.message, true); }
}
async function tfAddLink() {
  const url = $('tf-linkurl').value.trim();
  if (!url) { toast('Nhập link.', true); return; }
  try { await api('doc_link', { method: 'POST', body: { project_id: state._feed.projectId, task_id: state._feed.taskId, url, category: 'Tài liệu' } }); loadTaskFeed(state._feed.taskId, state._feed.projectId); }
  catch (e) { toast(e.message, true); }
}
async function tfDelete(id) {
  if (!confirm('Xóa tệp này?')) return;
  try { await api('doc_delete', { method: 'POST', body: { id } }); loadTaskFeed(state._feed.taskId, state._feed.projectId); }
  catch (e) { toast(e.message, true); }
}

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
    return `<div class="task-card clickable" data-id="${r.id}" data-proj="${r.project_id}">
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
  wrap.querySelectorAll('.task-card.clickable').forEach((el) =>
    el.addEventListener('click', () => openCalTask(+el.dataset.id, +el.dataset.proj)));
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
      const done = t.status === DONE_STATUS;
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
      const meta = [doc.uploader, doc.created_at ? doc.created_at.slice(0, 10) : '', doc.kind === 'file' ? fmtSize(doc.size) : 'link']
        .filter(Boolean).join(' · ');
      return `<div class="doc-item">
        <span class="doc-ic">${docIcon(doc)}</span>
        <div class="doc-main">
          ${docNameHtml(doc)}
          <div class="doc-meta">${esc(meta)}</div>
        </div>
        <span class="doc-cat">${esc(doc.category)}</span>
        <button class="ta-btn doc-del" data-id="${doc.id}" title="Xóa">🗑</button>
      </div>`;
    }).join('');
    wrap.querySelectorAll('.doc-del').forEach((b) =>
      b.addEventListener('click', () => delDoc(pid, +b.dataset.id)));
    bindDocPreview(wrap);
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

/* ---------- Trung tâm quản lý tài liệu (mọi dự án) ---------- */
let _dcTimer = null;
async function openDocsCenter() {
  switchView('docs');
  if (!state.projects.length) { try { const d = await api('projects'); state.projects = d.projects; } catch (e) {} }
  renderDocsCenter();
  loadDocsCenter();
}

function renderDocsCenter() {
  const projOpts = state.projects.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  const catOpts = DOC_CATS.map((c) => `<option>${esc(c)}</option>`).join('');
  $('docs-center').innerHTML = `
    <div class="rep-card">
      <div class="rep-title">Thêm tài liệu</div>
      <div class="dc-addbar">
        <select id="dc-project" class="input">${projOpts || '<option value="">(chưa có dự án)</option>'}</select>
        <select id="dc-cat" class="input">${catOpts}</select>
      </div>
      <div class="doc-upzone" id="dc-upzone">
        <input type="file" id="dc-file" hidden>
        <div class="doc-up-inner"><div class="doc-up-ic">⬆️</div>Kéo thả file vào đây hoặc <span class="doc-pick" id="dc-pick">bấm để chọn</span><div class="muted" style="margin-top:4px">Chọn dự án ở trên · tối đa 50MB</div></div>
      </div>
      <div class="doc-addrow" style="margin-bottom:0">
        <input id="dc-linkurl" class="input" placeholder="Dán link tài liệu (https://…)">
        <input id="dc-linkname" class="input" placeholder="Tên hiển thị (tùy chọn)">
        <button class="btn primary" id="dc-addlink">＋ Link</button>
      </div>
    </div>
    <div class="dc-filters">
      <select id="dc-fproject" class="input"><option value="">Tất cả dự án</option>${projOpts}</select>
      <select id="dc-fcat" class="input"><option value="">Tất cả phân loại</option>${catOpts}</select>
      <select id="dc-fkind" class="input"><option value="">Tất cả loại</option><option value="file">File</option><option value="link">Link</option></select>
      <select id="dc-fsort" class="input"><option value="new">Mới nhất</option><option value="name">Tên A→Z</option><option value="size">Dung lượng</option></select>
      <input id="dc-search" class="input" placeholder="🔍 Tìm theo tên…">
    </div>
    <div id="dc-list" class="doc-list"></div>`;
  bindDocsCenter();
}

function bindDocsCenter() {
  const up = $('dc-upzone'), fileInput = $('dc-file');
  $('dc-pick').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { if (fileInput.files[0]) dcUpload(fileInput.files[0]); });
  ['dragover', 'dragenter'].forEach((ev) => up.addEventListener(ev, (e) => { e.preventDefault(); up.classList.add('over'); }));
  ['dragleave', 'dragend'].forEach((ev) => up.addEventListener(ev, () => up.classList.remove('over')));
  up.addEventListener('drop', (e) => { e.preventDefault(); up.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) dcUpload(f); });
  $('dc-addlink').addEventListener('click', dcAddLink);
  ['dc-fproject', 'dc-fcat', 'dc-fkind', 'dc-fsort'].forEach((id) => $(id).addEventListener('change', loadDocsCenter));
  $('dc-search').addEventListener('input', () => { clearTimeout(_dcTimer); _dcTimer = setTimeout(loadDocsCenter, 300); });
}

async function loadDocsCenter() {
  const list = $('dc-list'); if (!list) return;
  const query = {
    project_id: $('dc-fproject').value || 0,
    category: $('dc-fcat').value || '',
    kind: $('dc-fkind').value || '',
    sort: $('dc-fsort').value || 'new',
    q: $('dc-search').value.trim() || '',
  };
  list.innerHTML = '<div class="muted" style="padding:14px 0">Đang tải…</div>';
  try {
    const d = await api('documents_all', { query });
    if (!d.documents.length) { list.innerHTML = '<div class="doc-empty">Không có tài liệu phù hợp.</div>'; return; }
    list.innerHTML = `<div class="muted" style="margin:2px 0 8px">${d.documents.length} tài liệu</div>` + d.documents.map(dcItem).join('');
    _docsById = {}; d.documents.forEach((x) => { _docsById[x.id] = x; });
    bindDocPreview(list);
    list.querySelectorAll('.doc-edit').forEach((b) => b.addEventListener('click', () => openDocEdit(_docsById[+b.dataset.id])));
    list.querySelectorAll('.doc-del').forEach((b) => b.addEventListener('click', () => dcDelete(+b.dataset.id)));
  } catch (e) { toast(e.message, true); }
}
let _docsById = {};
const VIEWABLE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf'];
const TEXT_EXT = ['txt', 'md', 'csv', 'log', 'json', 'xml'];
function isViewableFile(name) {
  const e = (String(name).split('.').pop() || '').toLowerCase();
  return VIEWABLE_EXT.includes(e) || TEXT_EXT.includes(e);
}

// Tên tài liệu: ảnh/PDF -> bấm xem trước; còn lại -> mở/tải
function docNameHtml(doc) {
  const isFile = doc.kind === 'file';
  if (isFile && isViewableFile(doc.name)) {
    return `<span class="doc-name doc-preview" data-id="${doc.id}" data-name="${esc(doc.name)}" title="Xem trước">${esc(doc.name)}</span>`;
  }
  const href = isFile ? `api.php?action=doc_download&id=${doc.id}` : doc.url;
  return `<a href="${esc(href)}" target="_blank" rel="noopener" class="doc-name">${esc(doc.name)}</a>`;
}
function docIcon(doc) { return doc.kind === 'file' ? (isViewableFile(doc.name) ? '🖼️' : '📄') : '🔗'; }
function bindDocPreview(container) {
  container.querySelectorAll('.doc-preview').forEach((el) => el.addEventListener('click', () => previewDoc(+el.dataset.id, el.dataset.name)));
}

function dcItem(doc) {
  const isFile = doc.kind === 'file';
  const meta = [doc.uploader, doc.created_at ? doc.created_at.slice(0, 10) : '', isFile ? fmtSize(doc.size) : 'link'].filter(Boolean).join(' · ');
  return `<div class="doc-item">
    <span class="doc-ic">${docIcon(doc)}</span>
    <div class="doc-main">
      ${docNameHtml(doc)}
      <div class="doc-meta"><span class="proj-badge" style="background:${esc(doc.project_color)}22;color:${esc(doc.project_color)}">${esc(doc.project_name)}</span> ${esc(meta)}</div>
    </div>
    <span class="doc-cat">${esc(doc.category)}</span>
    <button class="ta-btn doc-edit" data-id="${doc.id}" title="Sửa">✎</button>
    <button class="ta-btn doc-del" data-id="${doc.id}" title="Xóa">🗑</button>
  </div>`;
}

// Xem trước ảnh / PDF ngay trong app
async function previewDoc(id, name) {
  name = name || (_docsById[id] && _docsById[id].name) || 'Tài liệu';
  const ext = (String(name).split('.').pop() || '').toLowerCase();
  const url = `api.php?action=doc_download&id=${id}&disp=inline`;
  openModal(name, `<div class="doc-preview-wrap" id="pv-body"><div class="muted" style="padding:20px">Đang tải…</div></div>`,
    `<a class="btn" href="api.php?action=doc_download&id=${id}" download>⬇ Tải về</a><button class="btn ghost" id="pv-close">Đóng</button>`);
  $('modal').classList.add('wide');
  $('pv-close').addEventListener('click', closeModal);
  const body = $('pv-body'); if (!body) return;
  if (ext === 'pdf') {
    body.innerHTML = `<iframe src="${url}" class="doc-preview-frame"></iframe>`;
  } else if (TEXT_EXT.includes(ext)) {
    try {
      const res = await fetch(url, { credentials: 'include' });
      const txt = await res.text();
      body.innerHTML = `<pre class="doc-preview-text">${esc(txt.slice(0, 100000))}</pre>`;
    } catch (e) { body.innerHTML = '<div class="muted" style="padding:20px">Không tải được nội dung.</div>'; }
  } else {
    body.innerHTML = `<img src="${url}" class="doc-preview-img" alt="${esc(name)}">`;
  }
}

// Sửa tên / phân loại tài liệu
function openDocEdit(doc) {
  if (!doc) return;
  const catOpts = DOC_CATS.map((c) => `<option ${c === doc.category ? 'selected' : ''}>${esc(c)}</option>`).join('');
  openModal('Sửa tài liệu', `
    <label>Tên hiển thị</label>
    <input id="de-name" value="${esc(doc.name)}">
    <label>Phân loại</label>
    <select id="de-cat">${catOpts}</select>
  `, `<button class="btn ghost" id="de-cancel">Hủy</button><button class="btn primary" id="de-save">Lưu</button>`);
  $('de-cancel').addEventListener('click', closeModal);
  $('de-save').addEventListener('click', async () => {
    const name = $('de-name').value.trim();
    if (!name) { toast('Nhập tên tài liệu.', true); return; }
    try { await api('doc_update', { method: 'POST', body: { id: doc.id, name, category: $('de-cat').value } }); closeModal(); loadDocsCenter(); toast('Đã lưu.'); }
    catch (e) { toast(e.message, true); }
  });
}

async function dcUpload(file) {
  const pid = $('dc-project').value;
  if (!pid) { toast('Chọn dự án để tải lên.', true); return; }
  if (file.size > 52428800) { toast('File vượt quá 50MB.', true); return; }
  const fd = new FormData(); fd.append('project_id', pid); fd.append('category', $('dc-cat').value); fd.append('file', file);
  try {
    const res = await fetch('api.php?action=doc_upload', { method: 'POST', credentials: 'include', headers: { 'X-CSRF-Token': state.csrf }, body: fd });
    const data = await res.json();
    if (!res.ok || data.ok === false) throw new Error(data.error || 'Tải lên thất bại.');
    toast('Đã tải lên.'); loadDocsCenter(); loadProjects();
  } catch (e) { toast(e.message, true); }
}
async function dcAddLink() {
  const pid = $('dc-project').value, url = $('dc-linkurl').value.trim();
  if (!pid) { toast('Chọn dự án.', true); return; }
  if (!url) { toast('Nhập link tài liệu.', true); return; }
  try {
    await api('doc_link', { method: 'POST', body: { project_id: +pid, url, name: $('dc-linkname').value.trim(), category: $('dc-cat').value } });
    $('dc-linkurl').value = ''; $('dc-linkname').value = '';
    toast('Đã thêm link.'); loadDocsCenter();
  } catch (e) { toast(e.message, true); }
}
async function dcDelete(id) {
  if (!confirm('Xóa tài liệu này?')) return;
  try { await api('doc_delete', { method: 'POST', body: { id } }); loadDocsCenter(); toast('Đã xóa.'); }
  catch (e) { toast(e.message, true); }
}
$('menu-docs').addEventListener('click', openDocsCenter);

/* ---------- Việc của tôi (xuyên dự án) ---------- */
let _mineScope = 'assigned';
async function openMine() { switchView('mine'); await loadMine(); }
async function loadMine() {
  const body = $('mine-body');
  body.innerHTML = '<div class="muted" style="padding:16px 0">Đang tải…</div>';
  document.querySelectorAll('#mine-toggle .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.scope === _mineScope));
  try { const d = await api('my_tasks', { query: { scope: _mineScope } }); renderMine(d.tasks); }
  catch (e) { toast(e.message, true); }
}
function renderMine(tasks) {
  const body = $('mine-body');
  if (!tasks.length) { body.innerHTML = `<div class="doc-empty">Không có công việc ${_mineScope === 'created' ? 'bạn tạo' : 'được giao cho bạn'}.</div>`; return; }
  const today = new Date().toISOString().slice(0, 10);
  let html = '';
  GROUP_ORDER.filter((s) => tasks.some((t) => t.status === s)).forEach((status) => {
    const rows = tasks.filter((t) => t.status === status);
    html += `<div class="rep-card" style="padding:12px 14px">
      <div class="mine-group"><span class="tg-dot" style="background:${STATUS_DOT[status] || '#98a2b3'}"></span><span class="tg-name">${esc(status)}</span><span class="tg-count">${rows.length}</span></div>
      ${rows.map((t) => mineRow(t, today)).join('')}</div>`;
  });
  body.innerHTML = html;
  body.querySelectorAll('.mine-row').forEach((el) => el.addEventListener('click', () => openCalTask(+el.dataset.id, +el.dataset.proj)));
}
function mineRow(t, today) {
  const done = t.status === DONE_STATUS;
  const overdue = t.due_date && t.due_date < today && !done;
  const pri = PRI_ICON[t.priority] || PRI_ICON['Trung bình'];
  return `<div class="mine-row" data-id="${t.id}" data-proj="${t.project_id}">
    <span class="pri-ind" style="color:${pri.c}" title="${esc(t.priority)}">${pri.icon}</span>
    <div class="mine-main">
      <div class="mine-title ${done ? 'done' : ''}">${esc(t.title)}</div>
      <div class="mine-meta"><span class="proj-badge" style="background:${esc(t.project_color)}22;color:${esc(t.project_color)}">${esc(t.project_name)}</span>${t.due_date ? ` · 📅 ${esc(t.due_date.slice(5))}${overdue ? ' (quá hạn)' : ''}` : ''}</div>
    </div>
    <span class="mine-status" style="color:${STATUS_DOT[t.status] || 'var(--muted)'}">${esc(t.status)}</span>
  </div>`;
}
$('menu-mine').addEventListener('click', openMine);
document.querySelectorAll('#mine-toggle .seg-btn').forEach((b) => b.addEventListener('click', () => { _mineScope = b.dataset.scope; loadMine(); }));

/* ---------- Báo cáo (có bộ lọc thời gian) ---------- */
function reportRangeDates(preset) {
  const d = new Date(), y = d.getFullYear(), m = d.getMonth();
  const fmt = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  const today = fmt(d);
  if (preset === 'today') return { from: today, to: today };
  if (preset === '7days') { const s = new Date(d); s.setDate(d.getDate() - 6); return { from: fmt(s), to: today }; }
  if (preset === 'thisweek' || preset === 'lastweek') {
    // Thứ 2 → Thứ 6 (t2–t6) của tuần này / tuần trước
    const day = d.getDay(); // 0=CN..6=T7
    const mon = new Date(d);
    mon.setDate(d.getDate() + (day === 0 ? -6 : 1 - day) - (preset === 'lastweek' ? 7 : 0));
    const fri = new Date(mon); fri.setDate(mon.getDate() + 4);
    return { from: fmt(mon), to: fmt(fri) };
  }
  if (preset === 'month') return { from: fmt(new Date(y, m, 1)), to: today };
  if (preset === 'lastmonth') return { from: fmt(new Date(y, m - 1, 1)), to: fmt(new Date(y, m, 0)) };
  return { from: '', to: '' }; // all
}

async function openReport() {
  switchView('report');
  if (!state.reportRange) { state.reportRange = { preset: 'month', ...reportRangeDates('month') }; }
  await loadReport();
}

async function loadReport() {
  const body = $('report-body');
  body.innerHTML = reportFilterBar() + '<div class="muted" style="padding:20px 0">Đang tải…</div>';
  bindReportFilter();
  const { from, to } = state.reportRange;
  try {
    const d = await api('report', { query: (from || to) ? { from, to } : {} });
    body.innerHTML = reportFilterBar() + reportContent(d.report);
    bindReportFilter();
    bindReportDetail();
  } catch (e) { toast(e.message, true); }
}

function reportFilterBar() {
  const rr = state.reportRange;
  const presets = [['today', 'Hôm nay'], ['thisweek', 'Tuần này'], ['lastweek', 'Tuần trước'], ['7days', '7 ngày'], ['month', 'Tháng này'], ['lastmonth', 'Tháng trước'], ['all', 'Tất cả']];
  return `<div class="rep-filter">
    <div class="rep-presets">
      ${presets.map(([k, l]) => `<button class="rep-preset ${rr.preset === k ? 'active' : ''}" data-preset="${k}">${l}</button>`).join('')}
    </div>
    <div class="rep-custom">
      <input type="date" id="rep-from" class="input" value="${rr.from || ''}">
      <span class="rep-arrow">→</span>
      <input type="date" id="rep-to" class="input" value="${rr.to || ''}">
      <button class="btn" id="rep-apply">Áp dụng</button>
    </div>
  </div>`;
}

function bindReportFilter() {
  document.querySelectorAll('.rep-preset').forEach((b) =>
    b.addEventListener('click', () => {
      const p = b.dataset.preset;
      state.reportRange = { preset: p, ...reportRangeDates(p) };
      loadReport();
    }));
  const apply = $('rep-apply');
  if (apply) apply.addEventListener('click', () => {
    state.reportRange = { preset: 'custom', from: $('rep-from').value, to: $('rep-to').value };
    loadReport();
  });
}

function barRows(items, getLabel, getVal, color, dataFn) {
  const max = Math.max(1, ...items.map(getVal));
  return items.map((it) => {
    const v = getVal(it);
    const w = v <= 0 ? 0 : Math.max(4, Math.round(v / max * 100)); // 0 -> không hiện vệt màu
    const data = dataFn ? dataFn(it) : '';
    return `<div class="bar-row ${dataFn ? 'clickable' : ''}" ${data}>
      <span class="bar-label">${getLabel(it)}</span>
      <div class="bar"><div class="bar-fill" style="width:${w}%;background:${typeof color === 'function' ? color(it) : color}"></div></div>
      <span class="bar-val">${v}</span>
    </div>`;
  }).join('');
}

function reportContent(r) {
  const periodLabel = (r.from || r.to) ? `Kỳ: ${r.from || '…'} → ${r.to || '…'}` : 'Tất cả thời gian';
  const tiles = [
    { label: 'Tạo mới', val: r.created, c: 'var(--primary)', dtype: 'created' },
    { label: 'Hoàn thành', val: r.completed, c: 'var(--ok)', dtype: 'completed' },
    { label: 'Đang mở', val: r.openNow, c: 'var(--warn)', dtype: 'open' },
    { label: 'Quá hạn', val: r.overdue, c: 'var(--danger)', dtype: 'overdue' },
  ];
  let html = `<div class="rep-period">${esc(periodLabel)} · <span class="muted" style="margin:0">Bấm số liệu / thanh để xem chi tiết công việc</span></div>`;
  html += `<div class="stat-row">${tiles.map((t) => `
    <div class="stat-tile clickable" data-dtype="${t.dtype}" data-dlabel="${esc(t.label)}"><div class="stat-val" style="color:${t.c}">${t.val}</div><div class="stat-label">${t.label}</div></div>`).join('')}</div>`;

  // Biểu đồ hoàn thành theo ngày
  const days = r.completedByDay || [];
  const maxD = Math.max(1, ...days.map((x) => x.count));
  html += `<div class="rep-card"><div class="rep-title">📈 Hoàn thành theo ngày</div>`;
  if (days.length) {
    html += `<div class="daychart">${days.map((x) => `
      <div class="daycol" title="${x.date}: ${x.count} việc">
        <div class="daybar-wrap"><div class="daybar" style="height:${Math.round(x.count / maxD * 100)}%"></div></div>
        <div class="dayval">${x.count}</div>
        <div class="daylbl">${x.date.slice(5)}</div>
      </div>`).join('')}</div>`;
  } else {
    html += `<div class="muted">Chưa có công việc hoàn thành trong kỳ.</div>`;
  }
  html += `</div>`;

  // Trạng thái hiện tại (snapshot)
  const stOrder = GROUP_ORDER;
  html += `<div class="rep-card"><div class="rep-title">Trạng thái hiện tại</div>`;
  html += barRows(stOrder.map((s) => ({ s, v: r.byStatusNow[s] || 0 })),
    (it) => `<span class="tg-dot" style="background:${STATUS_DOT[it.s]}"></span>${esc(it.s)}`,
    (it) => it.v, (it) => STATUS_DOT[it.s],
    (it) => `data-dtype="status" data-dkey="${esc(it.s)}" data-dlabel="Trạng thái: ${esc(it.s)}"`);
  html += `</div>`;

  // Hoàn thành theo dự án (trong kỳ)
  if (r.completedByProject.length) {
    html += `<div class="rep-card"><div class="rep-title">Hoàn thành theo dự án</div>`;
    html += barRows(r.completedByProject,
      (p) => `<span class="tg-dot" style="background:${esc(p.color)}"></span>${esc(p.name)}`,
      (p) => p.count, 'var(--ok)',
      (p) => `data-dtype="project_completed" data-dkey="${esc(p.name)}" data-dlabel="Hoàn thành · ${esc(p.name)}"`);
    html += `</div>`;
  }

  // Hoàn thành theo người (trong kỳ)
  if (r.completedByAssignee.length) {
    html += `<div class="rep-card"><div class="rep-title">Hoàn thành theo người thực hiện</div>`;
    html += barRows(r.completedByAssignee,
      (a) => `${avatarHtml(a.name)} ${esc(a.name || '—')}`,
      (a) => a.count, 'var(--primary)',
      (a) => `data-dtype="assignee_completed" data-dkey="${esc(a.name || '')}" data-dlabel="Hoàn thành · ${esc(a.name || '—')}"`);
    html += `</div>`;
  }

  // Đã hoàn thành gần đây
  html += `<div class="rep-card"><div class="rep-title">✅ Đã hoàn thành gần đây</div>`;
  if (r.recentDone.length) {
    html += r.recentDone.map((t) => `<div class="done-item clickable" data-id="${t.id}" data-proj="${t.project_id}">
      <span class="done-ic">✓</span>
      <div class="done-main"><div class="done-title">${esc(t.title)}</div>
        <div class="done-meta">${esc(t.project_name)}${t.assignee ? ' · ' + esc(t.assignee) : ''} · ${esc((t.completed_at || '').slice(0, 10))}</div></div>
    </div>`).join('');
  } else {
    html += `<div class="muted">Chưa có công việc nào hoàn thành trong kỳ.</div>`;
  }
  html += `</div>`;
  return html;
}

// Bấm số liệu / thanh trong báo cáo -> hiện danh sách task chi tiết (theo kỳ)
function bindReportDetail() {
  document.querySelectorAll('.stat-tile.clickable').forEach((el) =>
    el.addEventListener('click', () => openReportDetail(el.dataset.dtype, '', el.dataset.dlabel)));
  document.querySelectorAll('.bar-row.clickable').forEach((el) =>
    el.addEventListener('click', () => openReportDetail(el.dataset.dtype, el.dataset.dkey || '', el.dataset.dlabel)));
  document.querySelectorAll('.done-item.clickable').forEach((el) =>
    el.addEventListener('click', () => { closeModal(); openCalTask(+el.dataset.id, +el.dataset.proj); }));
}

async function openReportDetail(type, key, label) {
  const { from, to } = state.reportRange || {};
  const query = { type };
  if (key) query.key = key;
  if (from) query.from = from;
  if (to) query.to = to;
  openModal(label || 'Chi tiết công việc', '<div class="muted">Đang tải…</div>', '<button class="btn ghost" id="rd-close">Đóng</button>');
  $('rd-close').addEventListener('click', closeModal);
  try {
    const d = await api('report_detail', { query });
    const body = $('modal').querySelector('.modal-body');
    if (!body) return;
    const periodTxt = (from || to) ? `${from || '…'} → ${to || '…'}` : 'Tất cả thời gian';
    if (!d.tasks.length) {
      body.innerHTML = `<div class="muted" style="margin-bottom:8px">Kỳ: ${esc(periodTxt)}</div><div class="doc-empty">Không có công việc nào.</div>`;
      return;
    }
    body.innerHTML = `<div class="muted" style="margin:0 0 10px">${d.tasks.length} công việc · ${esc(periodTxt)}</div>
      <div class="rd-list">${d.tasks.map(rdItem).join('')}</div>`;
    body.querySelectorAll('.rd-item').forEach((el) =>
      el.addEventListener('click', () => { const id = +el.dataset.id, pj = +el.dataset.proj; closeModal(); openCalTask(id, pj); }));
  } catch (e) { toast(e.message, true); closeModal(); }
}

function rdItem(t) {
  const done = t.status === DONE_STATUS;
  const when = t.completed_at ? '✓ ' + t.completed_at.slice(0, 10)
    : (t.due_date ? '📅 ' + t.due_date.slice(0, 10) : '');
  return `<div class="rd-item" data-id="${t.id}" data-proj="${t.project_id}">
    <span class="tg-dot" style="background:${STATUS_DOT[t.status] || '#98a2b3'}"></span>
    <div class="rd-main">
      <div class="rd-title ${done ? 'done' : ''}">${esc(t.title)}</div>
      <div class="rd-meta">${esc(t.project_name)}${t.assignee ? ' · ' + esc(t.assignee) : ''}${when ? ' · ' + esc(when) : ''}</div>
    </div>
    <span class="rd-status" style="color:${STATUS_DOT[t.status] || 'var(--muted)'}">${esc(t.status)}</span>
  </div>`;
}
$('menu-report').addEventListener('click', openReport);

/* ---------- Cài đặt trạng thái (Quản lý) ---------- */
function applyAndRefresh(defs) {
  if (!defs) return;
  state.meta.statusDefs = defs;
  state.meta.statuses = defs.map((d) => d.name);
  applyStatusDefs(defs);
  // cập nhật lại bộ lọc trạng thái trong thanh công cụ
  const fs = $('filter-status');
  if (fs) fs.innerHTML = '<option value="">Tất cả trạng thái</option>' +
    state.meta.statuses.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
}

function openSettings() { switchView('settings'); renderStatusSettings(); }

function renderStatusSettings() {
  const defs = state.meta.statusDefs || [];
  $('settings-body').innerHTML = `
    <div class="rep-card">
      <div class="rep-title">Danh sách trạng thái công việc</div>
      <p class="muted" style="margin:0 0 14px">Đổi màu / đổi tên (tự cập nhật công việc đang dùng), sắp xếp bằng ▲▼. Chọn <b>Hoàn thành</b> cho trạng thái đánh dấu việc đã xong (dùng cho ô tick, đếm, báo cáo).</p>
      <div class="st-settings">${defs.map((d, i) => statusSettingRow(d, i, defs.length)).join('')}</div>
      <div class="st-add">
        <input type="color" id="st-new-color" value="#2563eb">
        <input class="input" id="st-new-name" placeholder="Tên trạng thái mới…">
        <button class="btn primary" id="st-add-btn">＋ Thêm</button>
      </div>
    </div>`;
  bindStatusSettings();
}

function statusSettingRow(d, i, total) {
  return `<div class="st-row" data-id="${d.id}">
    <input type="color" class="st-color" value="${esc(d.color)}" title="Màu">
    <input class="input st-name" value="${esc(d.name)}" data-old="${esc(d.name)}">
    <label class="st-done"><input type="radio" name="st-done" ${d.is_done ? 'checked' : ''}> Hoàn thành</label>
    <span class="st-reorder">
      <button class="btn tiny st-up" ${i === 0 ? 'disabled' : ''}>▲</button>
      <button class="btn tiny st-down" ${i === total - 1 ? 'disabled' : ''}>▼</button>
    </span>
    <button class="btn tiny danger st-del" ${d.is_done ? 'disabled' : ''} title="${d.is_done ? 'Không thể xóa trạng thái Hoàn thành' : 'Xóa'}">Xóa</button>
  </div>`;
}

function bindStatusSettings() {
  const defs = state.meta.statusDefs || [];
  const rowId = (el) => +el.closest('.st-row').dataset.id;
  const saveRow = async (row) => {
    const body = {
      id: +row.dataset.id,
      name: row.querySelector('.st-name').value.trim(),
      color: row.querySelector('.st-color').value,
      is_done: row.querySelector('.st-done input').checked ? 1 : 0,
    };
    if (!body.name) { toast('Tên trạng thái không được trống.', true); return; }
    try { const d = await api('status_save', { method: 'POST', body }); applyAndRefresh(d.statusDefs); renderStatusSettings(); toast('Đã lưu.'); }
    catch (e) { toast(e.message, true); renderStatusSettings(); }
  };
  document.querySelectorAll('.st-color').forEach((c) => c.addEventListener('change', () => saveRow(c.closest('.st-row'))));
  document.querySelectorAll('.st-name').forEach((n) => n.addEventListener('change', () => { if (n.value.trim() !== n.dataset.old) saveRow(n.closest('.st-row')); }));
  document.querySelectorAll('.st-done input').forEach((r) => r.addEventListener('change', () => saveRow(r.closest('.st-row'))));
  document.querySelectorAll('.st-del').forEach((b) => b.addEventListener('click', async () => {
    if (b.disabled) return;
    if (!confirm('Xóa trạng thái này? Công việc đang dùng sẽ được chuyển sang trạng thái đầu tiên.')) return;
    try { const d = await api('status_delete', { method: 'POST', body: { id: rowId(b) } }); applyAndRefresh(d.statusDefs); renderStatusSettings(); toast('Đã xóa' + (d.reassignedTo ? ` · việc dời sang "${d.reassignedTo}"` : '') + '.'); }
    catch (e) { toast(e.message, true); }
  }));
  const reorder = async (b, dir) => {
    const ids = defs.map((d) => d.id);
    const i = ids.indexOf(rowId(b)), j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    try { const d = await api('status_reorder', { method: 'POST', body: { ordered_ids: ids } }); applyAndRefresh(d.statusDefs); renderStatusSettings(); }
    catch (e) { toast(e.message, true); }
  };
  document.querySelectorAll('.st-up').forEach((b) => b.addEventListener('click', () => reorder(b, -1)));
  document.querySelectorAll('.st-down').forEach((b) => b.addEventListener('click', () => reorder(b, 1)));
  $('st-add-btn').addEventListener('click', async () => {
    const name = $('st-new-name').value.trim();
    if (!name) { toast('Nhập tên trạng thái.', true); return; }
    try { const d = await api('status_save', { method: 'POST', body: { id: 0, name, color: $('st-new-color').value, is_done: 0 } }); applyAndRefresh(d.statusDefs); renderStatusSettings(); toast('Đã thêm trạng thái.'); }
    catch (e) { toast(e.message, true); }
  });
}
$('menu-settings').addEventListener('click', openSettings);

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
      ${u.avatar ? `<img class="avatar avatar-img" src="api.php?action=avatar&id=${u.id}&v=${encodeURIComponent(u.avatar)}" alt="">` : `<div class="avatar">${esc((u.full_name || u.username).slice(0,1).toUpperCase())}</div>`}
      <div class="user-info">
        <b>${esc(u.full_name || u.username)} ${u.active ? '' : '<span class="inactive-tag">(khóa)</span>'}</b>
        <span class="muted" style="margin:0">@${esc(u.username)} · ${u.role === 'manager' ? 'Quản lý' : 'Nhân viên QC'}</span>
      </div>
      <span class="user-workload" title="Việc đang mở được giao">${u.open_tasks || 0} việc</span>
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
  $('view-report').classList.toggle('hidden', view !== 'report');
  $('view-settings').classList.toggle('hidden', view !== 'settings');
  $('view-docs').classList.toggle('hidden', view !== 'docs');
  $('view-mine').classList.toggle('hidden', view !== 'mine');
  $('menu-reminders').classList.toggle('active', view === 'reminders');
  $('menu-users').classList.toggle('active', view === 'users');
  $('menu-calendar').classList.toggle('active', view === 'calendar');
  $('menu-report').classList.toggle('active', view === 'report');
  $('menu-settings').classList.toggle('active', view === 'settings');
  $('menu-docs').classList.toggle('active', view === 'docs');
  $('menu-mine').classList.toggle('active', view === 'mine');
  closeSidebarMobile();
}

/* ---------- Menu điện thoại ---------- */
$('nav-toggle').addEventListener('click', () => $('sidebar').classList.toggle('open'));
function closeSidebarMobile() { if (window.innerWidth <= 760) $('sidebar').classList.remove('open'); }

/* ---------- Sáng / Tối ---------- */
function currentTheme() {
  const attr = document.documentElement.getAttribute('data-theme');
  if (attr) return attr;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
function setThemeIcon() { $('theme-toggle').textContent = currentTheme() === 'dark' ? '☀️' : '🌙'; }
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  try { localStorage.setItem('qc-theme', theme); } catch (e) {}
  setThemeIcon();
}
$('theme-toggle').addEventListener('click', () => applyTheme(currentTheme() === 'dark' ? 'light' : 'dark'));
setThemeIcon();

/* ---------- Chạy ---------- */
boot();
