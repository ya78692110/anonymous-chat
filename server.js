/**
 * Anonymous ID-based real-time chat — backend (private contacts version)
 * Express (REST auth + data) + Socket.io (live delivery) + SQLite (storage)
 *
 * Privacy model (WhatsApp-like):
 *  - There is NO public user directory. Nobody can list other users.
 *  - You only see people you have chatted with ("contacts").
 *  - To start a chat you must know the other person's exact Unique ID.
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
const TTL_MS = 24 * 60 * 60 * 1000; // messages disappear after 24 hours
const UID_RE = /^[A-Za-z0-9_]{3,20}$/;
const MAX_MSG = 1000;

/* ------------------------------ Database ------------------------------ */
const db = new DatabaseSync(path.join(__dirname, 'chat.db'));
db.exec('PRAGMA journal_mode = WAL');

// One-time fresh start: when DB_VERSION changes, all old data is wiped on the next boot.
// Bump this number any time you want to reset every user / message again.
const DB_VERSION = '2';
db.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
const dbVer = db.prepare("SELECT v FROM meta WHERE k = 'version'").get();
if (!dbVer || dbVer.v !== DB_VERSION) {
  db.exec(`
    DROP TABLE IF EXISTS contacts;
    DROP TABLE IF EXISTS blocks;
    DROP TABLE IF EXISTS messages;
    DROP TABLE IF EXISTS sessions;
    DROP TABLE IF EXISTS users;
  `);
  db.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('version', ?)").run(DB_VERSION);
  console.log('Database reset: starting fresh (version ' + DB_VERSION + ')');
}

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uid TEXT NOT NULL UNIQUE COLLATE NOCASE,
    hash TEXT NOT NULL,
    bio TEXT NOT NULL DEFAULT '',
    color INTEGER,
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
  const row = db.prepare(`SELECT u.id, u.uid, u.bio, u.color FROM sessions s JOIN users u ON u.id = s.user_id
                          WHERE s.token_hash = ?`).get(sha(token));
  return row ? { id: Number(row.id), uid: row.uid, bio: row.bio, color: row.color == null ? null : Number(row.color) } : null;
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
const io = new Server(server);

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
  res.json({ token: createSession(Number(info.lastInsertRowid)), me: { uid, bio, color: null } });
});

app.post('/api/login', (req, res) => {
  if (limited('auth:' + req.ip)) return res.status(429).json({ error: 'Too many attempts. Try later.' });
  const uid = String(req.body.uid || '').trim().toUpperCase();
  const password = String(req.body.password || '');
  const u = db.prepare('SELECT * FROM users WHERE uid = ?').get(uid);
  if (!u || !bcrypt.compareSync(password, u.hash))
    return res.status(401).json({ error: 'Wrong ID or password' });
  res.json({ token: createSession(Number(u.id)), me: { uid: u.uid, bio: u.bio, color: u.color == null ? null : Number(u.color) } });
});

app.post('/api/logout', auth, (req, res) => {
  const h = req.headers.authorization.slice(7);
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(h));
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => res.json({ uid: req.user.uid, bio: req.user.bio, color: req.user.color }));

// Dashboard list: ONLY people you have chatted with (your contacts)
app.get('/api/chats', auth, (req, res) => {
  const cut = now() - TTL_MS;
  const pair = `((m.from_id=@me AND m.to_id=u.id) OR (m.from_id=u.id AND m.to_id=@me)) AND m.created_at>@cut`;
  const rows = db.prepare(`
    SELECT u.uid, u.bio, u.color,
      (SELECT text FROM messages m WHERE ${pair} ORDER BY m.id DESC LIMIT 1) AS last_text,
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
  const other = db.prepare('SELECT id, uid, bio, color FROM users WHERE uid = ?').get(String(req.params.uid).trim().toUpperCase());
  if (!other || isBlocked(req.user.id, Number(other.id))) return res.status(404).json({ error: 'User not found' });
  if (Number(other.id) === req.user.id) return res.status(400).json({ error: 'That is your own ID' });

  const contact = isContact(req.user.id, Number(other.id));
  // Throttle ID guessing: looking up people who are not yet your contacts is limited
  if (!contact && limited('find:' + req.user.id, 60))
    return res.status(429).json({ error: 'Too many lookups. Try later.' });

  const rows = db.prepare(`
    SELECT m.id, fu.uid AS "from", tu.uid AS "to", m.text, m.created_at AS at
    FROM messages m JOIN users fu ON fu.id=m.from_id JOIN users tu ON tu.id=m.to_id
    WHERE ((m.from_id=@me AND m.to_id=@o) OR (m.from_id=@o AND m.to_id=@me)) AND m.created_at>@cut
    ORDER BY m.id ASC`).all({ me: req.user.id, o: other.id, cut: now() - TTL_MS });
  db.prepare('UPDATE messages SET read_at=? WHERE from_id=? AND to_id=? AND read_at IS NULL')
    .run(now(), other.id, req.user.id);
  res.json({
    // online status is revealed only for contacts
    user: { uid: other.uid, bio: other.bio, color: other.color == null ? null : Number(other.color), contact, online: contact ? isOnline(other.uid) : false },
    messages: rows.map((r) => ({ ...r })),
  });
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

// Update my profile: ID (username), tagline and avatar colour
app.put('/api/profile', auth, (req, res) => {
  if (limited('profile:' + req.user.id, 10)) return res.status(429).json({ error: 'Too many changes. Try later.' });
  const b = req.body || {};
  let uid = req.user.uid;
  let bio = req.user.bio;
  let color = req.user.color;

  if (b.uid !== undefined) {
    uid = String(b.uid).trim().toUpperCase();
    if (!UID_RE.test(uid)) return res.status(400).json({ error: 'ID: 3–20 letters, numbers or _' });
    const taken = db.prepare('SELECT id FROM users WHERE uid = ?').get(uid);
    if (taken && Number(taken.id) !== req.user.id) return res.status(409).json({ error: 'That ID is taken' });
  }
  if (b.bio !== undefined) bio = String(b.bio).trim().slice(0, 60);
  if (b.color !== undefined) {
    if (b.color === null) color = null;
    else {
      const c = Number(b.color);
      if (!Number.isInteger(c) || c < 0 || c > 359) return res.status(400).json({ error: 'Invalid colour' });
      color = c;
    }
  }

  const oldUid = req.user.uid;
  db.prepare('UPDATE users SET uid=?, bio=?, color=? WHERE id=?').run(uid, bio, color, req.user.id);

  if (uid !== oldUid) {
    // Tell contacts about the new ID, then drop my live connections so they reconnect under it
    contactUids(req.user.id).forEach((c) => io.to(`u:${c}`).emit('contact:renamed', { from: oldUid, to: uid }));
    io.in(`u:${oldUid}`).disconnectSockets(true);
  }
  res.json({ uid, bio, color });
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
