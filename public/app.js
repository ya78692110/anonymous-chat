/* Anonymous chat — frontend logic (no framework, no page reloads) */
(() => {
  const $ = (id) => document.getElementById(id);
  const TOKEN_KEY = 'anon_token';

  const state = {
    token: localStorage.getItem(TOKEN_KEY),
    me: null,
    socket: null,
    online: new Set(),   // online status of MY contacts only (server never sends anyone else)
    chats: [],
    current: null,       // uid of open conversation
    currentIsContact: false,
    mode: 'login',
    typingTimer: null,
  };

  /* ------------------------------ helpers ------------------------------ */
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text; // textContent => no XSS from user content
    return n;
  }
  // Avatar: a unique, symmetric pixel glyph generated from the ID (no photos, no names)
  function hashStr(s) {
    let h = 2166136261;
    for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function fillAvatar(node, uid) {
    const NS = 'http://www.w3.org/2000/svg';
    const seed = hashStr(uid + '#glyph');
    node.textContent = '';
    node.style.setProperty('--h', String(hashStr(uid) % 360));
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 5 5');
    svg.setAttribute('aria-hidden', 'true');
    let any = false;
    const cell = (x, y) => {
      const r = document.createElementNS(NS, 'rect');
      r.setAttribute('x', x); r.setAttribute('y', y);
      r.setAttribute('width', 1); r.setAttribute('height', 1);
      r.setAttribute('fill', 'currentColor');
      svg.append(r); any = true;
    };
    for (let row = 0; row < 5; row++) {
      for (let col = 0; col < 3; col++) {
        if ((seed >> (row * 3 + col)) & 1) { cell(col, row); if (col < 2) cell(4 - col, row); }
      }
    }
    if (!any) cell(2, 2);
    node.append(svg);
    return node;
  }
  const pad = (n) => String(n).padStart(2, '0');
  const hhmm = (t) => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const startOfDay = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  function listTime(t) {
    if (!t) return '';
    const diff = (startOfDay(Date.now()) - startOfDay(t)) / 86400000;
    if (diff < 1) return hhmm(t);
    if (diff < 2) return 'yday';
    return new Date(t).toLocaleDateString('en', { weekday: 'short' });
  }
  function dayLabel(t) {
    const diff = (startOfDay(Date.now()) - startOfDay(t)) / 86400000;
    return diff < 1 ? 'Today' : diff < 2 ? 'Yesterday' : new Date(t).toLocaleDateString('en', { month: 'short', day: 'numeric' });
  }
  let toastTimer;
  function toast(msg) {
    const t = $('toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 2400);
  }
  async function api(path, opts = {}) {
    const res = await fetch(path, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json', ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && state.token) { signOut(true); throw new Error('Session expired'); }
    if (!res.ok) throw new Error(data.error || 'Something went wrong');
    return data;
  }
  function show(view) {
    ['auth', 'list', 'chat'].forEach((v) => ($(`view-${v}`).hidden = v !== view));
  }

  /* -------------------------------- auth -------------------------------- */
  document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => {
    state.mode = tab.dataset.mode;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    $('bio-field').hidden = state.mode !== 'register';
    $('auth-submit').textContent = state.mode === 'login' ? 'Log in' : 'Create ID';
    $('auth-error').textContent = '';
  }));

  $('auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('auth-submit'); btn.disabled = true; $('auth-error').textContent = '';
    try {
      const data = await api(`/api/${state.mode}`, {
        method: 'POST',
        body: { uid: $('auth-uid').value, password: $('auth-pass').value, bio: $('auth-bio').value },
      });
      state.token = data.token; state.me = data.me;
      localStorage.setItem(TOKEN_KEY, data.token);
      $('auth-pass').value = '';
      start();
    } catch (err) {
      $('auth-error').textContent = err.message;
    } finally { btn.disabled = false; }
  });

  async function signOut(silent) {
    try { if (!silent && state.token) await api('/api/logout', { method: 'POST' }); } catch (_) {}
    localStorage.removeItem(TOKEN_KEY);
    state.token = null; state.me = null; state.current = null;
    state.online = new Set(); state.chats = [];
    if (state.socket) { state.socket.disconnect(); state.socket = null; }
    show('auth');
  }
  $('logout').addEventListener('click', () => signOut(false));

  /* ------------------------------- socket ------------------------------- */
  function connectSocket() {
    if (state.socket) state.socket.disconnect();
    const s = io({ auth: { token: state.token } });
    state.socket = s;

    s.on('connect_error', (err) => { if (err.message === 'unauthorized') signOut(true); });

    // Initial list: which of MY contacts are online right now
    s.on('presence', ({ online }) => {
      state.online = new Set(online);
      renderOnlineCount();
      if (!$('view-list').hidden) renderList();
      if (state.current) renderChatStatus();
    });

    // A single contact came online / went offline (server only sends this for contacts)
    s.on('presence:update', ({ uid, online }) => {
      if (online) state.online.add(uid); else state.online.delete(uid);
      if (uid === state.current) state.currentIsContact = true;
      renderOnlineCount();
      if (!$('view-list').hidden) renderList();
      if (state.current) renderChatStatus();
    });

    s.on('message:new', (m) => {
      const other = m.from === state.me.uid ? m.to : m.from;
      if (state.current === other) {
        // Avoid duplicating our own message that was already appended from the ack
        if (!document.querySelector(`[data-mid="${m.id}"]`)) appendMessage(m);
        if (m.from !== state.me.uid) s.emit('message:read', { from: m.from });
      } else if (m.from !== state.me.uid) {
        toast(`New message from ${m.from}`);
      }
      if (!$('view-list').hidden) loadChats();
    });

    s.on('typing', ({ from }) => {
      if (from !== state.current) return;
      $('chat-status').textContent = 'typing…';
      clearTimeout(state.typingTimer);
      state.typingTimer = setTimeout(renderChatStatus, 1600);
    });
  }

  /* ----------------------------- dashboard ------------------------------ */
  function renderOnlineCount() {
    $('online-count').textContent = `${state.online.size} online`;
  }
  async function loadChats() {
    try { state.chats = await api('/api/chats'); renderList(); } catch (_) {}
  }
  function renderList() {
    const ul = $('chat-list'); ul.textContent = '';
    $('empty-list').hidden = state.chats.length > 0;
    state.chats.forEach((c) => {
      const li = el('li');
      const btn = el('button', 'chat-item');
      const av = fillAvatar(el('div', 'avatar'), c.uid);
      av.append(el('i', 'dot' + (state.online.has(c.uid) ? ' on' : '')));
      const body = el('div', 'item-body');
      body.append(el('div', 'item-name', c.uid), el('div', 'item-sub', c.last_text || c.bio || 'Say hello'));
      const side = el('div', 'item-side');
      side.append(el('span', 'item-time', listTime(c.last_at)));
      if (c.unread > 0) side.append(el('span', 'unread', String(c.unread)));
      btn.append(av, body, side);
      btn.addEventListener('click', () => openChat(c.uid));
      li.append(btn); ul.append(li);
    });
  }

  // Start a chat by typing someone's exact ID (there is no public user list)
  $('find-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('find-uid');
    const uid = input.value.trim().toUpperCase();
    if (!uid) return;
    openChat(uid).then((ok) => { if (ok) input.value = ''; });
  });

  $('random-chat').addEventListener('click', async () => {
    try { const { uid } = await api('/api/random'); openChat(uid); }
    catch (err) { toast(err.message); }
  });

  /* ------------------------------ chat room ------------------------------ */
  let lastDay = null;
  function renderChatStatus() {
    // Online status is shown only for contacts; strangers stay fully anonymous
    const on = state.currentIsContact && state.online.has(state.current);
    $('chat-dot').classList.toggle('on', on);
    $('chat-status').textContent = state.currentIsContact
      ? `Anonymous · ${on ? 'Online' : 'Offline'}`
      : 'Anonymous';
  }
  function appendMessage(m) {
    const thread = $('thread');
    const label = dayLabel(m.at);
    if (label !== lastDay) { thread.append(el('div', 'day', label)); lastDay = label; }
    const mine = m.from === state.me.uid;
    const wrap = el('div', `msg ${mine ? 'out' : 'in'}`);
    wrap.dataset.mid = m.id;
    wrap.append(el('div', 'bubble', m.text), el('div', 'time', hhmm(m.at)));
    thread.append(wrap);
    thread.scrollTop = thread.scrollHeight;
  }
  async function openChat(uid) {
    try {
      const data = await api(`/api/messages/${encodeURIComponent(uid)}`);
      state.current = data.user.uid;
      state.currentIsContact = !!data.user.contact;
      if (state.currentIsContact) {
        if (data.user.online) state.online.add(state.current); else state.online.delete(state.current);
      }
      $('chat-name').textContent = data.user.uid;
      fillAvatar($('chat-avatar'), data.user.uid);
      $('thread').textContent = ''; lastDay = null;
      data.messages.forEach(appendMessage);
      renderChatStatus();
      show('chat');
      $('msg-input').focus({ preventScroll: true });
      return true;
    } catch (err) { toast(err.message); return false; }
  }
  function closeChat() {
    state.current = null; state.currentIsContact = false;
    show('list'); loadChats();
  }
  $('back').addEventListener('click', closeChat);
  $('all-chats').addEventListener('click', closeChat);

  $('composer').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('msg-input');
    const text = input.value.trim();
    if (!text || !state.current) return;
    input.value = '';
    state.socket.emit('message:send', { to: state.current, text }, (res) => {
      if (res?.error) { toast(res.error); input.value = text; return; }
      // The server also broadcasts message:new to us; the data-mid check prevents duplicates.
      if (!document.querySelector(`[data-mid="${res.msg.id}"]`)) appendMessage(res.msg);
    });
  });
  let lastTyping = 0;
  $('msg-input').addEventListener('input', () => {
    const t = Date.now();
    if (state.current && state.currentIsContact && t - lastTyping > 1200) {
      lastTyping = t; state.socket.emit('typing', { to: state.current });
    }
  });

  /* --------------------------- options sheet ---------------------------- */
  const sheet = $('sheet');
  $('menu-btn').addEventListener('click', () => (sheet.hidden = false));
  $('act-cancel').addEventListener('click', () => (sheet.hidden = true));
  sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.hidden = true; });
  $('act-clear').addEventListener('click', async () => {
    sheet.hidden = true;
    try { await api(`/api/messages/${encodeURIComponent(state.current)}`, { method: 'DELETE' }); $('thread').textContent = ''; lastDay = null; toast('Chat cleared'); }
    catch (err) { toast(err.message); }
  });
  $('act-block').addEventListener('click', async () => {
    sheet.hidden = true;
    try { await api(`/api/block/${encodeURIComponent(state.current)}`, { method: 'POST' }); toast('ID blocked'); closeChat(); }
    catch (err) { toast(err.message); }
  });

  /* -------------------------------- boot -------------------------------- */
  async function start() {
    if (!state.me) {
      try { state.me = await api('/api/me'); } catch (_) { return show('auth'); }
    }
    connectSocket();
    show('list');
    await loadChats();
  }

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  state.token ? start() : show('auth');
})();
