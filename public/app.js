/* Anonymous chat — frontend logic (no framework, no page reloads) */
(() => {
  const $ = (id) => document.getElementById(id);
  const TOKEN_KEY = 'anon_token';
  const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
  const AVATAR_COLORS = ['jade', 'gold', 'coral', 'sky', 'violet', 'mint'];
  const SERVER_URL = (window.ANONYMOUS_CHAT_SERVER_URL || '').replace(/\/+$/, '');
  const serverPath = (path) => SERVER_URL ? new URL(path, SERVER_URL).toString() : path;

  const state = {
    token: localStorage.getItem(TOKEN_KEY),
    me: null,
    preview: false,
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
  function fillAvatar(node, uid, color) {
    const NS = 'http://www.w3.org/2000/svg';
    const seed = hashStr(uid + '#glyph');
    node.textContent = '';
    node.style.setProperty('--h', String(hashStr(uid) % 360));
    node.dataset.color = AVATAR_COLORS.includes(color) ? color : 'jade';
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
    const res = await fetch(serverPath(path), {
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
    clearMediaUrls();
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
    const s = io(SERVER_URL || undefined, { auth: { token: state.token } });
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
      const av = fillAvatar(el('div', 'avatar'), c.uid, c.avatarColor);
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

  /* ------------------------------ chat room ------------------------------ */
  let lastDay = null;
  let mediaUrls = [];
  function clearMediaUrls() {
    mediaUrls.forEach(URL.revokeObjectURL);
    mediaUrls = [];
  }
  async function loadMessageImage(id, image) {
    try {
      const res = await fetch(serverPath(`/api/media/${encodeURIComponent(id)}`), {
        headers: { Authorization: `Bearer ${state.token}` },
      });
      if (res.status === 401) { signOut(true); return; }
      if (!res.ok) throw new Error('Image unavailable');
      const url = URL.createObjectURL(await res.blob());
      if (!image.isConnected) { URL.revokeObjectURL(url); return; }
      mediaUrls.push(url);
      image.src = url;
    } catch (_) {
      image.alt = 'Image unavailable';
    }
  }
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
    const isImage = m.type === 'image';
    const wrap = el('div', `msg ${mine ? 'out' : 'in'}${isImage ? ' image' : ''}`);
    wrap.dataset.mid = m.id;
    if (isImage) {
      const image = el('img', 'message-image');
      image.alt = 'Shared image';
      wrap.append(image);
      if (m.previewUrl) image.src = m.previewUrl;
      else loadMessageImage(m.id, image);
    } else {
      wrap.append(el('div', 'bubble', m.text));
    }
    wrap.append(el('div', 'time', hhmm(m.at)));
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
      $('chat-bio').textContent = data.user.bio || '';
      fillAvatar($('chat-avatar'), data.user.uid, data.user.avatarColor);
      clearMediaUrls();
      $('thread').textContent = ''; lastDay = null;
      data.messages.forEach(appendMessage);
      renderChatStatus();
      show('chat');
      $('msg-input').focus({ preventScroll: true });
      return true;
    } catch (err) { toast(err.message); return false; }
  }
  function closeChat() {
    clearMediaUrls();
    state.current = null; state.currentIsContact = false;
    show('list'); loadChats();
  }
  $('back').addEventListener('click', () => state.preview ? exitChatPreview() : closeChat());
  $('all-chats').addEventListener('click', () => state.preview ? exitChatPreview() : closeChat());

  $('image-btn').addEventListener('click', () => $('image-input').click());
  $('image-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file || !state.current) return;
    if (file.size > MAX_IMAGE_BYTES) { toast('Image must be 5MB or smaller'); return; }
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type)) {
      toast('Choose a JPG, PNG, WebP or GIF image'); return;
    }

    const to = state.current;
    if (state.preview) {
      const previewUrl = URL.createObjectURL(file);
      mediaUrls.push(previewUrl);
      appendMessage({
        id: `preview-${Date.now()}`, from: state.me.uid, to,
        text: '', type: 'image', at: Date.now(), previewUrl,
      });
      return;
    }
    const button = $('image-btn');
    button.disabled = true;
    toast('Sending image…');
    try {
      const res = await fetch(serverPath(`/api/messages/${encodeURIComponent(to)}/image`), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${state.token}`,
          'Content-Type': file.type,
        },
        body: file,
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) { signOut(true); return; }
      if (!res.ok) throw new Error(data.error || (res.status === 413 ? 'Image must be 5MB or smaller' : 'Image could not be sent'));
      if (state.current === to && !document.querySelector(`[data-mid="${data.msg.id}"]`)) appendMessage(data.msg);
      toast('Image sent');
    } catch (err) {
      toast(err.message);
    } finally {
      button.disabled = false;
    }
  });

  $('composer').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('msg-input');
    const text = input.value.trim();
    if (!text || !state.current) return;
    input.value = '';
    if (state.preview) {
      appendMessage({
        id: `preview-${Date.now()}`, from: state.me.uid, to: state.current,
        text, type: 'text', at: Date.now(),
      });
      return;
    }
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
    try { await api(`/api/messages/${encodeURIComponent(state.current)}`, { method: 'DELETE' }); clearMediaUrls(); $('thread').textContent = ''; lastDay = null; toast('Chat cleared'); }
    catch (err) { toast(err.message); }
  });
  $('act-block').addEventListener('click', async () => {
    sheet.hidden = true;
    try { await api(`/api/block/${encodeURIComponent(state.current)}`, { method: 'POST' }); toast('ID blocked'); closeChat(); }
    catch (err) { toast(err.message); }
  });

  /* ---------------------------- own profile ----------------------------- */
  const profileSheet = $('profile-sheet');
  let selectedColor = 'jade';
  function renderOwnProfile() {
    if (!state.me) return;
    $('my-uid').textContent = state.me.uid;
    $('my-bio').textContent = state.me.bio || 'Add a tagline';
    fillAvatar($('my-avatar'), state.me.uid, state.me.avatarColor);
  }
  function chooseAvatarColor(color) {
    selectedColor = color;
    fillAvatar($('profile-avatar'), state.me.uid, color);
    document.querySelectorAll('.color-swatch').forEach((swatch) => {
      swatch.setAttribute('aria-pressed', String(swatch.dataset.color === color));
    });
  }
  $('edit-profile').addEventListener('click', () => {
    $('profile-error').textContent = '';
    $('profile-bio').value = state.me.bio || '';
    $('profile-preview-uid').textContent = state.me.uid;
    chooseAvatarColor(state.me.avatarColor || 'jade');
    profileSheet.hidden = false;
  });
  document.querySelectorAll('.color-swatch').forEach((swatch) => {
    swatch.addEventListener('click', () => chooseAvatarColor(swatch.dataset.color));
  });
  $('profile-cancel').addEventListener('click', () => { profileSheet.hidden = true; });
  profileSheet.addEventListener('click', (event) => {
    if (event.target === profileSheet) profileSheet.hidden = true;
  });
  $('profile-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = $('profile-save');
    button.disabled = true;
    $('profile-error').textContent = '';
    try {
      state.me = await api('/api/profile', {
        method: 'POST',
        body: { bio: $('profile-bio').value, avatarColor: selectedColor },
      });
      renderOwnProfile();
      profileSheet.hidden = true;
      toast('Profile updated');
    } catch (error) {
      $('profile-error').textContent = error.message;
    } finally { button.disabled = false; }
  });
  $('share-id').addEventListener('click', async () => {
    const shareData = { title: 'Anonymous chat', text: `Chat with me on Anonymous. My ID is ${state.me.uid}.` };
    try {
      if (navigator.share) await navigator.share(shareData);
      else { await navigator.clipboard.writeText(shareData.text); toast('Your ID is ready to share'); }
    } catch (error) {
      if (error.name !== 'AbortError') toast('Could not share your ID');
    }
  });

  /* -------------------------------- boot -------------------------------- */
  async function start() {
    if (!state.me) {
      try { state.me = await api('/api/me'); } catch (_) { return show('auth'); }
    }
    renderOwnProfile();
    connectSocket();
    show('list');
    await loadChats();
  }

  function startChatPreview() {
    state.preview = true;
    state.me = { uid: 'YOU' };
    state.current = 'ANON_407';
    $('chat-name').textContent = state.current;
    fillAvatar($('chat-avatar'), state.current);
    $('chat-dot').classList.remove('on');
    $('chat-status').textContent = 'Local preview';
    document.querySelector('.badge').textContent = 'Preview';
    document.querySelector('.sub-text').textContent = 'Messages stay on this device';
    $('all-chats').textContent = 'Log in / Create ID';
    $('thread').textContent = '';
    lastDay = null;
    appendMessage({
      id: 'preview-in-1', from: state.current, to: state.me.uid,
      text: 'This is a local chat preview.', type: 'text', at: Date.now() - 60000,
    });
    appendMessage({
      id: 'preview-out-1', from: state.me.uid, to: state.current,
      text: 'Use the image button to try sending a photo.', type: 'text', at: Date.now() - 30000,
    });
    show('chat');
  }

  function exitChatPreview() {
    const url = new URL(location.href);
    url.searchParams.delete('preview');
    location.replace(url);
  }

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  const localPreview = new URLSearchParams(location.search).get('preview') === 'chat'
    && (location.protocol === 'file:' || ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname));
  if (localPreview) startChatPreview();
  else state.token ? start() : show('auth');
})();
