/**
 * Anonymous ID-based real-time chat — backend (private contacts version)
 * Express (REST auth + data) + Socket.io (live delivery) + SQLite (storage)
 *
 * Privacy model (WhatsApp-like):
 *  - There is NO public user directory. Nobody can list other users.
 *  - You only see people you have chatted with ("contacts").
 *  - To start a chat you must know the other person's exact Unique ID,
 *    or share your ID so someone can start a chat with you.
 *  - Online status / typing is only shared between contacts.
 */
const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { DatabaseSync } = require('node:sqlite');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const MOBILE_APP_ORIGINS = new Set([
  'https://localhost',
  'http://localhost',
  'capacitor://localhost',
]);
const TTL_MS = 24 * 60 * 60 * 1000; // messages disappear after 24 hours
const UID_RE = /^[A-Za-z0-9_]{3,20}$/;
const MAX_MSG = 1000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

/* ------------------------------ Database ------------------------------ */
const db = new DatabaseSync(path.join(__dirname, 'chat.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uid TEXT NOT NULL UNIQUE COLLATE NOCASE,
    hash TEXT NOT NULL,
    bio TEXT NOT NULL DEFAULT '',
    avatar_color TEXT NOT NULL DEFAULT 'jade',
    created_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id INTEGER NOT NULL,
    to_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'text',
    mime_type TEXT,
    image BLOB,
    created_at INTEGER NOT NULL,
    read_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_msg_pair ON messages(from_id, to_id, created_at);
  CREATE TABLE IF NOT EXISTS blocks (
    blocker_id INTEGER NOT NULL,
    blocked_id INTEGER NOT NULL,
    PRIMARY KEY (blocker_id, blocked_id)
  );
  -- People each user has chatted with. Only these appear in a user's chat list.
  CREATE TABLE IF NOT EXISTS contacts (
    owner_id INTEGER NOT NULL,
    contact_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (owner_id, contact_id)
  );
`);

if (!db.prepare('PRAGMA table_info(users)').all().some((column) => column.name === 'avatar_color')) {
  db.exec("ALTER TABLE users ADD COLUMN avatar_color TEXT NOT NULL DEFAULT 'jade'");
}
const messageColumns = new Set(db.prepare('PRAGMA table_info(messages)').all().map((column) => column.name));
if (!messageColumns.has('type')) db.exec("ALTER TABLE messages ADD COLUMN type TEXT NOT NULL DEFAULT 'text'");
if (!messageColumns.has('mime_type')) db.exec('ALTER TABLE messages ADD COLUMN mime_type TEXT');
if (!messageColumns.has('image')) db.exec('ALTER TABLE messages ADD COLUMN image BLOB');

// Backfill contacts for conversations that existed before this update
db.exec(`
  INSERT OR IGNORE INTO contacts (owner_id, contact_id, created_at)
    SELECT DISTINCT from_id, to_id, strftime('%s','now')*1000 FROM messages;
  INSERT OR IGNORE INTO contacts (owner_id, contact_id, created_at)
    SELECT DISTINCT to_id, from_id, strftime('%s','now')*1000 FROM messages;
`);

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const now = () => Date.now();

// Purge expired messages every 5 minutes (and once at boot)
const purge = () => db.prepare('DELETE FROM messages WHERE created_at < ?').run(now() - TTL_MS);
purge();
setInterval(purge, 5 * 60 * 1000).unref();

/* ----------------------------- Auth helpers ---------------------------- */
function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at) VALUES (?,?,?)')
    .run(sha(token), userId, now());
  return token;
}
function userFromToken(token) {
  if (!token) return null;
  const row = db.prepare(`SELECT u.id, u.uid, u.bio, u.avatar_color FROM sessions s JOIN users u ON u.id = s.user_id
                          WHERE s.token_hash = ?`).get(sha(token));
  return row ? { id: Number(row.id), uid: row.uid, bio: row.bio, avatarColor: row.avatar_color } : null;
}
const isBlocked = (a, b) =>
  !!db.prepare(`SELECT 1 FROM blocks WHERE (blocker_id=@a AND blocked_id=@b) OR (blocker_id=@b AND blocked_id=@a)`)
    .get({ a, b });

/* ---------------------------- Contact helpers --------------------------- */
const isContact = (a, b) =>
  !!db.prepare('SELECT 1 FROM contacts WHERE owner_id=? AND contact_id=?').get(a, b);

// UIDs of people this user has chatted with (and not blocked either way)
const contactUids = (id) =>
  db.prepare(`
    SELECT u.uid FROM contacts c JOIN users u ON u.id = c.contact_id
    WHERE c.owner_id = @me
      AND u.id NOT IN (SELECT blocked_id FROM blocks WHERE blocker_id=@me)
      AND u.id NOT IN (SELECT blocker_id FROM blocks WHERE blocked_id=@me)`)
    .all({ me: id }).map((r) => r.uid);

// Make two users contacts of each other. Returns true if something new was added.
function addContacts(a, b) {
  const t = now();
  const st = db.prepare('INSERT OR IGNORE INTO contacts (owner_id, contact_id, created_at) VALUES (?,?,?)');
  const r1 = st.run(a, b, t);
  const r2 = st.run(b, a, t);
  return Number(r1.changes) > 0 || Number(r2.changes) > 0;
}

// Tiny in-memory rate limiter (per key)
const attempts = new Map();
function limited(key, max = 30) {
  const rec = attempts.get(key) || { n: 0, t: now() };
  if (now() - rec.t > 15 * 60 * 1000) { rec.n = 0; rec.t = now(); }
  rec.n++; attempts.set(key, rec);
  return rec.n > max;
}

/* ------------------------------ Express app ---------------------------- */
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: [...MOBILE_APP_ORIGINS], methods: ['GET', 'POST'] },
});

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (MOBILE_APP_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
  }
  next();
});
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const user = userFromToken(h.startsWith('Bearer ') ? h.slice(7) : '');
  if (!user) return res.status(401).json({ error: 'Not signed in' });
  req.user = user;
  next();
}

app.post('/api/register', (req, res) => {
  if (limited('auth:' + req.ip)) return res.status(429).json({ error: 'Too many attempts. Try later.' });
  const uid = String(req.body.uid || '').trim().toUpperCase();
  const password = String(req.body.password || '');
  const bio = String(req.body.bio || '').trim().slice(0, 60);
  if (!UID_RE.test(uid)) return res.status(400).json({ error: 'ID: 3–20 letters, numbers or _' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be 6+ characters' });
  if (db.prepare('SELECT 1 FROM users WHERE uid = ?').get(uid))
    return res.status(409).json({ error: 'That ID is taken' });

  const hash = bcrypt.hashSync(password, 12);
  const info = db.prepare('INSERT INTO users (uid, hash, bio, created_at, last_seen) VALUES (?,?,?,?,?)')
    .run(uid, hash, bio, now(), now());
  res.json({ token: createSession(Number(info.lastInsertRowid)), me: { uid, bio, avatarColor: 'jade' } });
});

app.post('/api/login', (req, res) => {
  if (limited('auth:' + req.ip)) return res.status(429).json({ error: 'Too many attempts. Try later.' });
  const uid = String(req.body.uid || '').trim().toUpperCase();
  const password = String(req.body.password || '');
  const u = db.prepare('SELECT * FROM users WHERE uid = ?').get(uid);
  if (!u || !bcrypt.compareSync(password, u.hash))
    return res.status(401).json({ error: 'Wrong ID or password' });
  res.json({ token: createSession(Number(u.id)), me: { uid: u.uid, bio: u.bio, avatarColor: u.avatar_color } });
});

app.post('/api/logout', auth, (req, res) => {
  const h = req.headers.authorization.slice(7);
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(h));
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => res.json({ uid: req.user.uid, bio: req.user.bio, avatarColor: req.user.avatarColor }));

app.post('/api/profile', auth, (req, res) => {
  const bio = String(req.body.bio || '').trim().slice(0, 60);
  const allowedColors = new Set(['jade', 'gold', 'coral', 'sky', 'violet', 'mint']);
  const avatarColor = String(req.body.avatarColor || 'jade');
  if (!allowedColors.has(avatarColor)) return res.status(400).json({ error: 'Choose a valid avatar color' });
  db.prepare('UPDATE users SET bio=?, avatar_color=? WHERE id=?').run(bio, avatarColor, req.user.id);
  res.json({ uid: req.user.uid, bio, avatarColor });
});

// Dashboard list: ONLY people you have chatted with (your contacts)
app.get('/api/chats', auth, (req, res) => {
  const cut = now() - TTL_MS;
  const pair = `((m.from_id=@me AND m.to_id=u.id) OR (m.from_id=u.id AND m.to_id=@me)) AND m.created_at>@cut`;
  const rows = db.prepare(`
    SELECT u.uid, u.bio, u.avatar_color AS avatarColor,
      (SELECT CASE WHEN m.type='image' THEN 'Photo' ELSE m.text END FROM messages m WHERE ${pair} ORDER BY m.id DESC LIMIT 1) AS last_text,
      (SELECT created_at FROM messages m WHERE ${pair} ORDER BY m.id DESC LIMIT 1) AS last_at,
      (SELECT COUNT(*) FROM messages m WHERE m.from_id=u.id AND m.to_id=@me
         AND m.read_at IS NULL AND m.created_at>@cut) AS unread
    FROM contacts c JOIN users u ON u.id = c.contact_id
    WHERE c.owner_id = @me
      AND u.id NOT IN (SELECT blocked_id FROM blocks WHERE blocker_id=@me)
      AND u.id NOT IN (SELECT blocker_id FROM blocks WHERE blocked_id=@me)
    ORDER BY (last_at IS NULL), last_at DESC, c.created_at DESC
    LIMIT 200`).all({ me: req.user.id, cut });
  res.json(rows.map((r) => ({ ...r, online: isOnline(r.uid) })));
});

// Message history for one conversation (last 24h only).
// Works for a contact, or for a brand-new person whose exact ID you typed.
app.get('/api/messages/:uid', auth, (req, res) => {
  const other = db.prepare('SELECT id, uid, bio, avatar_color FROM users WHERE uid = ?').get(String(req.params.uid).trim().toUpperCase());
  if (!other || isBlocked(req.user.id, Number(other.id))) return res.status(404).json({ error: 'User not found' });
  if (Number(other.id) === req.user.id) return res.status(400).json({ error: 'That is your own ID' });

  const contact = isContact(req.user.id, Number(other.id));
  // Throttle ID guessing: looking up people who are not yet your contacts is limited
  if (!contact && limited('find:' + req.user.id, 60))
    return res.status(429).json({ error: 'Too many lookups. Try later.' });

  const rows = db.prepare(`
    SELECT m.id, fu.uid AS "from", tu.uid AS "to", m.text, m.type, m.created_at AS at
    FROM messages m JOIN users fu ON fu.id=m.from_id JOIN users tu ON tu.id=m.to_id
    WHERE ((m.from_id=@me AND m.to_id=@o) OR (m.from_id=@o AND m.to_id=@me)) AND m.created_at>@cut
    ORDER BY m.id ASC`).all({ me: req.user.id, o: other.id, cut: now() - TTL_MS });
  db.prepare('UPDATE messages SET read_at=? WHERE from_id=? AND to_id=? AND read_at IS NULL')
    .run(now(), other.id, req.user.id);
  res.json({
    // online status is revealed only for contacts
    user: { uid: other.uid, bio: other.bio, avatarColor: other.avatar_color, contact, online: contact ? isOnline(other.uid) : false },
    messages: rows.map((r) => ({ ...r })),
  });
});

app.post('/api/messages/:uid/image', auth,
  express.raw({ type: [...IMAGE_TYPES], limit: MAX_IMAGE_BYTES }), (req, res) => {
    const mimeType = String(req.headers['content-type'] || '').split(';')[0].toLowerCase();
    if (!IMAGE_TYPES.has(mimeType)) return res.status(415).json({ error: 'Choose a JPG, PNG, WebP or GIF image' });
    if (!req.body?.length) return res.status(400).json({ error: 'Image is empty' });

    const to = db.prepare('SELECT id, uid FROM users WHERE uid = ?').get(String(req.params.uid).trim().toUpperCase());
    if (!to || Number(to.id) === req.user.id) return res.status(404).json({ error: 'User not found' });
    if (isBlocked(req.user.id, Number(to.id))) return res.status(403).json({ error: 'You cannot message this user' });

    const sentAt = now();
    addContacts(req.user.id, Number(to.id));
    const info = db.prepare(`INSERT INTO messages (from_id, to_id, text, type, mime_type, image, created_at)
      VALUES (?, ?, '', 'image', ?, ?, ?)`)
      .run(req.user.id, Number(to.id), mimeType, req.body, sentAt);
    const msg = { id: Number(info.lastInsertRowid), from: req.user.uid, to: to.uid, text: '', type: 'image', at: sentAt };
    io.to(`u:${to.uid}`).to(`u:${req.user.uid}`).emit('message:new', msg);
    res.status(201).json({ msg });
  });

app.get('/api/media/:id', auth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(404).json({ error: 'Image not found' });
  const media = db.prepare(`SELECT from_id, to_id, mime_type, image FROM messages
    WHERE id=? AND type='image'`).get(id);
  if (!media || (media.from_id !== req.user.id && media.to_id !== req.user.id)
      || isBlocked(req.user.id, media.from_id === req.user.id ? media.to_id : media.from_id)) {
    return res.status(404).json({ error: 'Image not found' });
  }
  res.setHeader('Content-Type', media.mime_type);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.send(Buffer.from(media.image));
});

app.delete('/api/messages/:uid', auth, (req, res) => {
  const other = db.prepare('SELECT id FROM users WHERE uid = ?').get(String(req.params.uid).toUpperCase());
  if (!other) return res.status(404).json({ error: 'User not found' });
  db.prepare(`DELETE FROM messages WHERE (from_id=@a AND to_id=@b) OR (from_id=@b AND to_id=@a)`)
    .run({ a: req.user.id, b: other.id });
  res.json({ ok: true });
});

app.post('/api/block/:uid', auth, (req, res) => {
  const other = db.prepare('SELECT id FROM users WHERE uid = ?').get(String(req.params.uid).toUpperCase());
  if (!other || Number(other.id) === req.user.id) return res.status(404).json({ error: 'User not found' });
  db.prepare('INSERT OR IGNORE INTO blocks (blocker_id, blocked_id) VALUES (?,?)').run(req.user.id, other.id);
  res.json({ ok: true });
});

/* ------------------------------- Socket.io ------------------------------ */
const sockets = new Map(); // uid -> Set(socket.id)
const isOnline = (uid) => (sockets.get(uid)?.size || 0) > 0;

// Tell only this user's contacts that their status changed (no global broadcast)
function announcePresence(uid, userId, online) {
  contactUids(userId).forEach((c) => io.to(`u:${c}`).emit('presence:update', { uid, online }));
}

io.use((socket, next) => {
  const user = userFromToken(socket.handshake.auth?.token);
  if (!user) return next(new Error('unauthorized'));
  socket.user = user;
  next();
});

io.on('connection', (socket) => {
  const me = socket.user;
  socket.join(`u:${me.uid}`); // personal room: every device of this ID joins it
  const wasOnline = isOnline(me.uid);
  if (!sockets.has(me.uid)) sockets.set(me.uid, new Set());
  sockets.get(me.uid).add(socket.id);

  // This socket learns which of ITS OWN contacts are online; contacts learn about me.
  socket.emit('presence', { online: contactUids(me.id).filter(isOnline) });
  if (!wasOnline) announcePresence(me.uid, me.id, true);

  let sentTimes = [];
  socket.on('message:send', (payload, ack) => {
    ack = typeof ack === 'function' ? ack : () => {};
    const text = String(payload?.text || '').trim().slice(0, MAX_MSG);
    const to = db.prepare('SELECT id, uid FROM users WHERE uid = ?').get(String(payload?.to || '').toUpperCase());
    if (!text || !to || Number(to.id) === me.id) return ack({ error: 'Invalid message' });
    if (isBlocked(me.id, Number(to.id))) return ack({ error: 'You cannot message this user' });

    // flood control: max 15 messages / 10 s
    const t = now();
    sentTimes = sentTimes.filter((x) => t - x < 10000);
    if (sentTimes.length >= 15) return ack({ error: 'Slow down' });
    sentTimes.push(t);

    // First message creates the contact for BOTH sides (so the receiver sees you in their list)
    const isNew = addContacts(me.id, Number(to.id));

    const info = db.prepare('INSERT INTO messages (from_id, to_id, text, created_at) VALUES (?,?,?,?)')
      .run(me.id, to.id, text, t);
    const msg = { id: Number(info.lastInsertRowid), from: me.uid, to: to.uid, text, at: t };
    io.to(`u:${to.uid}`).to(`u:${me.uid}`).emit('message:new', msg); // recipient + sender's other devices

    if (isNew) { // exchange online status now that they are contacts
      io.to(`u:${to.uid}`).emit('presence:update', { uid: me.uid, online: true });
      io.to(`u:${me.uid}`).emit('presence:update', { uid: to.uid, online: isOnline(to.uid) });
    }
    ack({ ok: true, msg });
  });

  socket.on('message:read', ({ from } = {}) => {
    const other = db.prepare('SELECT id FROM users WHERE uid = ?').get(String(from || '').toUpperCase());
    if (!other) return;
    db.prepare('UPDATE messages SET read_at=? WHERE from_id=? AND to_id=? AND read_at IS NULL')
      .run(now(), other.id, me.id);
  });

  // Typing indicator: only between contacts who have not blocked each other
  socket.on('typing', ({ to } = {}) => {
    if (typeof to !== 'string') return;
    const other = db.prepare('SELECT id, uid FROM users WHERE uid = ?').get(to.toUpperCase());
    if (!other || !isContact(me.id, Number(other.id)) || isBlocked(me.id, Number(other.id))) return;
    io.to(`u:${other.uid}`).emit('typing', { from: me.uid });
  });

  socket.on('disconnect', () => {
    const set = sockets.get(me.uid);
    if (set) { set.delete(socket.id); if (!set.size) sockets.delete(me.uid); }
    db.prepare('UPDATE users SET last_seen=? WHERE id=?').run(now(), me.id);
    if (!isOnline(me.uid)) announcePresence(me.uid, me.id, false);
  });
});

server.listen(PORT, () => console.log(`Anonymous chat running on http://localhost:${PORT}`));
