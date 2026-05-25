/**
 * anonymtalks-bot-v3.js
 * AnonymTalks — Anonymous 1:1 Chat Telegram Bot
 * V3: Admin Dashboard (admin-only), Add/Manage Bots Section,
 *     Premium via Telegram Stars Payment, Fixed Layout, Real Stats
 */

require('dotenv').config();

const { Telegraf, Markup, session } = require('telegraf');
const fs = require('fs');
const crypto = require('crypto');
const initSqlJs = require('sql.js');
const express = require('express');

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const BOT_TOKEN    = process.env.BOT_TOKEN;
const ADMIN_IDS    = (process.env.ADMIN_IDS || '').split(',').map(x => parseInt(x)).filter(Boolean);
const DB_FILE      = process.env.DB_FILE || './anonymtalks.db';
const BOT_USERNAME = process.env.BOT_USERNAME || 'AnonymTalksBot';

if (!BOT_TOKEN) { console.error('❌ Set BOT_TOKEN env var'); process.exit(1); }

// ─── PREMIUM PLANS ───────────────────────────────────────────────────────────
const PREMIUM_PLANS = {
  vip: {
    label:       'VIP',
    stars:       50,        // 50 Telegram Stars ≈ ₹49
    days:        30,
    tier:        1,
    description: '⭐ Priority matching\n⭐ Interest & Mood matching\n⭐ 3 queue jumps/day',
  },
  premium: {
    label:       'Premium',
    stars:       100,       // 100 Telegram Stars ≈ ₹99
    days:        30,
    tier:        2,
    description: '💎 Everything in VIP\n💎 Language filter\n💎 Extended idle (30 min)\n💎 See partner mood before connecting',
  }
};

// ─── DATABASE ─────────────────────────────────────────────────────────────────
class Database {
  constructor(filename) { this.filename = filename; this.db = null; }

  async init() {
    const SQL = await initSqlJs();
    this.db = fs.existsSync(this.filename)
      ? new SQL.Database(fs.readFileSync(this.filename))
      : new SQL.Database();
  }

  save() {
    if (this.db) fs.writeFileSync(this.filename, Buffer.from(this.db.export()));
  }

  prepare(sql) {
    const { db } = this;
    const save = () => this.save();
    return {
      run: (...p) => {
        try { db.run(sql, p); save(); }
        catch(e) { console.error('SQL run:', e.message, sql); }
      },
      get: (...p) => {
        try {
          const s = db.prepare(sql); s.bind(p);
          const r = s.step() ? s.getAsObject() : null; s.free(); return r;
        } catch(e) { console.error('SQL get:', e.message); return null; }
      },
      all: (...p) => {
        try {
          const s = db.prepare(sql); s.bind(p);
          const r = []; while(s.step()) r.push(s.getAsObject()); s.free(); return r;
        } catch(e) { console.error('SQL all:', e.message); return []; }
      }
    };
  }

  close() { this.save(); if (this.db) this.db.close(); }
}

let db = null;

// ─── DB SCHEMA ────────────────────────────────────────────────────────────────
async function initDB() {
  db = new Database(DB_FILE);
  await db.init();

  const exec = sql => db.prepare(sql).run();

  exec(`CREATE TABLE IF NOT EXISTS users (
    anon_id          TEXT PRIMARY KEY,
    tg_id            INTEGER DEFAULT NULL,
    rating_sum       INTEGER DEFAULT 0,
    rating_count     INTEGER DEFAULT 0,
    interests        TEXT    DEFAULT NULL,
    mood             TEXT    DEFAULT NULL,
    language         TEXT    DEFAULT 'any',
    gender           TEXT    DEFAULT NULL,
    premium          INTEGER DEFAULT 0,
    vip_tier         INTEGER DEFAULT 0,
    premium_expires  TEXT    DEFAULT NULL,
    last_bonus_date  TEXT    DEFAULT NULL,
    chat_count       INTEGER DEFAULT 0,
    streak_days      INTEGER DEFAULT 0,
    last_chat_date   TEXT    DEFAULT NULL,
    total_messages   INTEGER DEFAULT 0,
    referral_code    TEXT    DEFAULT NULL,
    referred_by      TEXT    DEFAULT NULL,
    referral_count   INTEGER DEFAULT 0,
    banned           INTEGER DEFAULT 0,
    ban_reason       TEXT    DEFAULT NULL,
    created_at       TEXT    DEFAULT (datetime('now')),
    country          TEXT    DEFAULT NULL
  )`);

  exec(`CREATE TABLE IF NOT EXISTS complaints (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp     TEXT,
    reporter_anon TEXT,
    accused_anon  TEXT,
    reason        TEXT,
    excerpt       TEXT,
    severity      INTEGER DEFAULT 0,
    resolved      INTEGER DEFAULT 0
  )`);

  exec(`CREATE TABLE IF NOT EXISTS chat_logs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id    TEXT,
    anon_a     TEXT,
    anon_b     TEXT,
    started_at TEXT,
    ended_at   TEXT,
    msg_count  INTEGER DEFAULT 0,
    end_reason TEXT
  )`);

  exec(`CREATE TABLE IF NOT EXISTS referrals (
    code       TEXT PRIMARY KEY,
    owner_anon TEXT,
    used_count INTEGER DEFAULT 0
  )`);

  exec(`CREATE TABLE IF NOT EXISTS bot_stats (
    key   TEXT PRIMARY KEY,
    value INTEGER DEFAULT 0
  )`);

  // ── NEW: managed bots table ──────────────────────────────────────────────
  exec(`CREATE TABLE IF NOT EXISTS managed_bots (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    username    TEXT NOT NULL,
    description TEXT DEFAULT '',
    category    TEXT DEFAULT 'General',
    link        TEXT NOT NULL,
    active      INTEGER DEFAULT 1,
    added_at    TEXT DEFAULT (datetime('now'))
  )`);

  // ── NEW: payments table ──────────────────────────────────────────────────
  exec(`CREATE TABLE IF NOT EXISTS payments (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    tg_id        INTEGER,
    anon_id      TEXT,
    plan         TEXT,
    stars        INTEGER,
    payload      TEXT,
    status       TEXT DEFAULT 'pending',
    created_at   TEXT DEFAULT (datetime('now')),
    completed_at TEXT DEFAULT NULL
  )`);

  // seed stats keys
  ['total_users','total_chats','total_messages','active_today'].forEach(k => {
    if (!db.prepare('SELECT key FROM bot_stats WHERE key=?').get(k))
      db.prepare('INSERT INTO bot_stats(key,value) VALUES(?,0)').run(k);
  });
}

// ─── DB HELPERS ───────────────────────────────────────────────────────────────
const makeAnonId      = () => crypto.randomBytes(9).toString('hex');
const makeReferralCode = () => crypto.randomBytes(4).toString('hex').toUpperCase();

function ensureUserRow(anon_id, tg_id = null) {
  const r = db.prepare('SELECT anon_id FROM users WHERE anon_id=?').get(anon_id);
  if (!r) {
    const code = makeReferralCode();
    db.prepare('INSERT INTO users(anon_id,tg_id,referral_code) VALUES(?,?,?)').run(anon_id, tg_id, code);
    db.prepare('INSERT OR IGNORE INTO referrals(code,owner_anon,used_count) VALUES(?,?,0)').run(code, anon_id);
    db.prepare("UPDATE bot_stats SET value=value+1 WHERE key='total_users'").run();
  } else if (tg_id) {
    db.prepare('UPDATE users SET tg_id=? WHERE anon_id=?').run(tg_id, anon_id);
  }
}

function getUser(anon_id, tg_id = null) {
  ensureUserRow(anon_id, tg_id);
  return db.prepare('SELECT * FROM users WHERE anon_id=?').get(anon_id);
}

function getRating(anon_id) {
  const r = getUser(anon_id);
  if (!r || !r.rating_count) return 0;
  return Number((r.rating_sum / r.rating_count).toFixed(1));
}

function saveRating(anon_id, value) {
  ensureUserRow(anon_id);
  db.prepare('UPDATE users SET rating_sum=rating_sum+?,rating_count=rating_count+1 WHERE anon_id=?').run(value, anon_id);
}

function saveComplaint(reporter, accused, reason, excerpt, severity = 0) {
  db.prepare(
    'INSERT INTO complaints(timestamp,reporter_anon,accused_anon,reason,excerpt,severity) VALUES(?,?,?,?,?,?)'
  ).run(new Date().toISOString(), reporter, accused, reason, excerpt, severity);
}

function updateStreak(anon_id) {
  const u = getUser(anon_id);
  const today     = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  let newStreak = 1;
  if (u.last_chat_date === yesterday) newStreak = (u.streak_days || 0) + 1;
  else if (u.last_chat_date === today) newStreak = u.streak_days || 1;
  db.prepare(
    'UPDATE users SET streak_days=?,last_chat_date=?,chat_count=chat_count+1 WHERE anon_id=?'
  ).run(newStreak, today, anon_id);
  return newStreak;
}

function logChat(chatId, anonA, anonB, startedAt, endedAt, msgCount, endReason) {
  db.prepare(
    'INSERT INTO chat_logs(chat_id,anon_a,anon_b,started_at,ended_at,msg_count,end_reason) VALUES(?,?,?,?,?,?,?)'
  ).run(chatId, anonA, anonB, startedAt, endedAt, msgCount, endReason);
  db.prepare("UPDATE bot_stats SET value=value+1 WHERE key='total_chats'").run();
}

// Check + fix expired premium
function checkPremiumExpiry(anon_id) {
  const u = getUser(anon_id);
  if (u.vip_tier > 0 && u.premium_expires) {
    if (new Date(u.premium_expires) < new Date()) {
      db.prepare('UPDATE users SET vip_tier=0,premium=0,premium_expires=NULL WHERE anon_id=?').run(anon_id);
      return false;
    }
  }
  return u.vip_tier > 0;
}

function getTotalUsers() {
  const r = db.prepare("SELECT value FROM bot_stats WHERE key='total_users'").get();
  return r ? r.value : 0;
}

function getTotalChats() {
  const r = db.prepare("SELECT value FROM bot_stats WHERE key='total_chats'").get();
  return r ? r.value : 0;
}

function getActiveUsersToday() {
  const today = new Date().toISOString().slice(0, 10);
  const r = db.prepare("SELECT COUNT(*) as cnt FROM users WHERE last_chat_date=?").get(today);
  return r ? r.cnt : 0;
}

// ─── IN-MEMORY STATE ──────────────────────────────────────────────────────────
const waitingPool  = { random: [], female: [], male: [], other: [] };
const activeChats  = new Map();  // chatId → chat obj
const tgToAnon     = {};         // tg_id  → { anon, chatId, partnerAnon, partnerTg, startedAt }
const spamTracker  = {};
const gameStates   = new Map();

// ─── BOT SETUP ────────────────────────────────────────────────────────────────
const bot = new Telegraf(BOT_TOKEN);
bot.use(session());

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const MOODS = [
  '😊 Happy','😔 Sad','🤔 Philosophical',
  '🔥 Flirty','😂 Funny','💪 Motivational','😴 Chill'
];

const INTEREST_TAGS = [
  '🎵 Music','🎮 Gaming','📚 Books','🏋️ Fitness',
  '🎨 Art','💻 Tech','🍕 Food','✈️ Travel',
  '💰 Crypto','🎬 Movies','🌿 Nature','🧠 Philosophy'
];

const LANGUAGES = ['Any','English','Hindi','Spanish','Arabic','Russian','French'];

// ─── KEYBOARDS ────────────────────────────────────────────────────────────────
const lobbyKb = () => Markup.keyboard([
  ['🚀 Random Chat', '😍 Flirt Chat'],
  ['🔍 Match by Interest', '🎭 Match by Mood'],
  ['👤 Profile', '🎁 Daily Bonus'],
  ['📊 Leaderboard', '🎮 Mini Games'],
  ['💎 Go Premium', '🔗 Refer & Earn'],
  ['🤖 Our Bots']
]).resize();

const searchKb = () => Markup.keyboard([['❌ Cancel Search']]).resize();

const chatKb = () => Markup.inlineKeyboard([
  [
    Markup.button.callback('👍 Rate Up',  'rate_5'),
    Markup.button.callback('👎 Rate Down','rate_1')
  ],
  [
    Markup.button.callback('⛔ Report',   'complain'),
    Markup.button.callback('⏭ Next Chat','btn_next')
  ]
]);

const endChatKb = () => Markup.inlineKeyboard([
  [Markup.button.callback('⭐ Rate Partner',    'show_rating')],
  [
    Markup.button.callback('🔄 Find New Partner','btn_next'),
    Markup.button.callback('🏠 Lobby',           'go_lobby')
  ]
]);

// ─── SESSION INIT ─────────────────────────────────────────────────────────────
function ensureSession(ctx) {
  if (!ctx.session) ctx.session = {};
  if (!ctx.session.anon) {
    ctx.session.anon = {
      anon_id:           makeAnonId(),
      inChat:            false,
      chatId:            null,
      searchingSince:    null,
      awaitingComplaint: null,
      awaitingBotField:  null,   // for admin bot-add flow
      pendingBot:        {},     // bot being added
      premium:           false,
      vip_tier:          0,
      queueJump:         0,
    };
    ensureUserRow(ctx.session.anon.anon_id, ctx.from?.id);
  }
  return ctx.session.anon;
}

// ─── MODERATION ───────────────────────────────────────────────────────────────
const MOD = {
  critical: /(?:minor|underage|age\s*\d{1,2}|kid|child|teen|13|14|15|16|17)[\s\S]{0,30}(?:sex|nude|porn|touch|naked)/i,
  threats:  /\b(i will kill|i will rape|i will hurt|shoot you|bomb|stab you|murder)\b/i,
  doxx:     /\b(your address|phone number|your location|your school|doxx)\b/i,
  hate:     /\b(nigger|faggot|kike|chink|wetback|spic)\b/i,
  spam:     /(.)\1{15,}|http[s]?:\/\/\S+/i
};

function checkModeration(text) {
  if (!text) return null;
  if (MOD.critical.test(text)) return { severity: 3, reason: 'sexual_with_minors' };
  if (MOD.threats.test(text))  return { severity: 3, reason: 'threats'             };
  if (MOD.doxx.test(text))     return { severity: 2, reason: 'possible_doxx'       };
  if (MOD.hate.test(text))     return { severity: 2, reason: 'hate_speech'         };
  if (MOD.spam.test(text))     return { severity: 1, reason: 'spam_or_link'        };
  return null;
}

function isSpamming(tg_id) {
  const now = Date.now();
  if (!spamTracker[tg_id] || spamTracker[tg_id].resetAt < now) {
    spamTracker[tg_id] = { count: 1, resetAt: now + 3000 };
    return false;
  }
  spamTracker[tg_id].count++;
  return spamTracker[tg_id].count > 5;
}

// ─── POOL HELPERS ─────────────────────────────────────────────────────────────
function removeFromPools(anon_id) {
  ['random','male','female','other'].forEach(k => {
    waitingPool[k] = waitingPool[k].filter(u => u.anon_id !== anon_id);
  });
}

function interestScore(a, b) {
  if (!a || !b) return 0;
  const sA = new Set(a.split(','));
  let n = 0;
  b.split(',').forEach(x => { if (sA.has(x)) n++; });
  return n;
}

function tryMatch(item, genderPref) {
  const pools = [];
  if (genderPref) pools.push(waitingPool[genderPref]);
  pools.push(waitingPool.random, waitingPool.male, waitingPool.female, waitingPool.other);

  let bestScore = -1, bestPool = null, bestIdx = -1;

  for (const pool of pools) {
    if (!pool) continue;
    for (let i = 0; i < pool.length; i++) {
      const c = pool[i];
      if (c.anon_id === item.anon_id) continue;
      let score = 0;
      if (item.mood && c.mood === item.mood) score += 3;
      score += interestScore(item.interests, c.interests) * 2;
      score += (c.premium || 0);
      if (score > bestScore) { bestScore = score; bestPool = pool; bestIdx = i; }
    }
  }

  if (bestIdx >= 0) return bestPool.splice(bestIdx, 1)[0];
  return null;
}

// ─── CONNECT PAIR ─────────────────────────────────────────────────────────────
async function connectPair(a, b) {
  const chatId    = crypto.randomBytes(6).toString('hex');
  const startedAt = Date.now();

  removeFromPools(a.anon_id);
  removeFromPools(b.anon_id);

  activeChats.set(chatId, {
    a_anon: a.anon_id, b_anon: b.anon_id,
    a_tg:   a.tg_id,   b_tg:   b.tg_id,
    startedAt, a_msgs: 0, b_msgs: 0, idleTimer: null
  });

  tgToAnon[a.tg_id] = { anon: a.anon_id, chatId, partnerAnon: b.anon_id, partnerTg: b.tg_id, startedAt };
  tgToAnon[b.tg_id] = { anon: b.anon_id, chatId, partnerAnon: a.anon_id, partnerTg: a.tg_id, startedAt };

  const uA = getUser(a.anon_id), uB = getUser(b.anon_id);
  const streakA = updateStreak(a.anon_id);
  const streakB = updateStreak(b.anon_id);

  try { await bot.telegram.sendMessage(a.tg_id, buildFoundMessage(uB, streakA), { parse_mode: 'Markdown', protect_content: true, ...chatKb() }); } catch(e) {}
  try { await bot.telegram.sendMessage(b.tg_id, buildFoundMessage(uA, streakB), { parse_mode: 'Markdown', protect_content: true, ...chatKb() }); } catch(e) {}

  const chat = activeChats.get(chatId);
  if (chat) chat.idleTimer = setTimeout(() => endChat(chatId, 'idle_timeout'), 15 * 60 * 1000);
}

function buildFoundMessage(partnerUser, myStreak) {
  const pRating    = partnerUser ? getRating(partnerUser.anon_id) : 0;
  const pInterests = partnerUser?.interests ? `🏷 *Interests:* ${partnerUser.interests}` : '🏷 *Interests:* not set';
  const pMood      = partnerUser?.mood ? `🎭 *Mood:* ${partnerUser.mood}` : '';
  const stars      = pRating > 0 ? '⭐'.repeat(Math.round(pRating)) : 'no rating yet';

  return [
    `🦋 *Partner found! Say hi 👋*`,
    ``,
    `*─── Partner Info ───*`,
    pInterests,
    pMood,
    `🏆 *Rating:* ${pRating} ${stars}`,
    ``,
    `🔥 *Your streak:* ${myStreak} day(s)`,
    ``,
    `*Commands:*`,
    `/next — skip  •  /stop — leave`,
    `/game — play  •  /report — report`
  ].filter(Boolean).join('\n');
}

// ─── END CHAT ─────────────────────────────────────────────────────────────────
async function endChat(chatId, reason = 'ended') {
  const chat = activeChats.get(chatId);
  if (!chat) return;

  const secs    = Math.floor((Date.now() - chat.startedAt) / 1000);
  const mins    = Math.floor(secs / 60);
  const remSecs = secs % 60;
  const total   = (chat.a_msgs || 0) + (chat.b_msgs || 0);

  if (chat.idleTimer) clearTimeout(chat.idleTimer);
  activeChats.delete(chatId);

  const txt = [
    `💬 *Chat ended!*`,
    `⏱ Duration: ${mins}m ${remSecs}s`,
    `📨 Messages: ${total}`,
    reason === 'idle_timeout' ? '😴 Ended due to inactivity.' : '',
    ``,
    `What would you like to do?`
  ].filter(Boolean).join('\n');

  for (const tgId of [chat.a_tg, chat.b_tg]) {
    try { await bot.telegram.sendMessage(tgId, txt, { parse_mode: 'Markdown', ...endChatKb() }); } catch(e) {}
    delete tgToAnon[tgId];
  }

  logChat(chatId, chat.a_anon, chat.b_anon,
    new Date(chat.startedAt).toISOString(), new Date().toISOString(), total, reason);

  db.prepare('UPDATE users SET total_messages=total_messages+? WHERE anon_id=?').run(chat.a_msgs, chat.a_anon);
  db.prepare('UPDATE users SET total_messages=total_messages+? WHERE anon_id=?').run(chat.b_msgs, chat.b_anon);
  db.prepare("UPDATE bot_stats SET value=value+? WHERE key='total_messages'").run(total);

  gameStates.delete(chatId);
}

async function endChatForUser(anon_id, reason = 'ended') {
  for (const [chatId, chat] of activeChats.entries()) {
    if (chat.a_anon === anon_id || chat.b_anon === anon_id) {
      await endChat(chatId, reason);
      return;
    }
  }
}

// ─── SEARCH FLOW ──────────────────────────────────────────────────────────────
async function startSearch(ctx, opts = {}) {
  const s  = ensureSession(ctx);
  if (s.inChat) return ctx.reply('⚠️ End your current chat first (/stop).');

  checkPremiumExpiry(s.anon_id);
  const u = getUser(s.anon_id);
  if (u.banned) return ctx.reply(`🚫 You are banned. Reason: ${u.ban_reason || 'rule violation'}`);

  s.searchingSince = Date.now();
  removeFromPools(s.anon_id);

  const item = {
    anon_id:   s.anon_id,
    tg_id:     ctx.from.id,
    gender:    u.gender,
    premium:   (s.queueJump > 0) ? 2 : (u.premium || 0),
    joinedAt:  Date.now(),
    mood:      u.mood,
    interests: u.interests,
    language:  u.language || 'any'
  };
  if (s.queueJump > 0) s.queueJump--;

  const genderPref = opts.genderPref || null;
  if (genderPref) waitingPool[genderPref].push(item);
  else            waitingPool.random.push(item);

  await ctx.reply('🔍 Searching for a partner...', searchKb());

  let elapsed = 0, wideNotified = false;

  const poll = setInterval(async () => {
    elapsed += 1000;
    if (!s.searchingSince || tgToAnon[ctx.from.id]?.chatId) { clearInterval(poll); return; }

    const match = tryMatch(item, genderPref);
    if (match) {
      clearInterval(poll);
      s.searchingSince = null;
      removeFromPools(s.anon_id);
      s.inChat = true;
      await connectPair(item, match);
      return;
    }

    if (elapsed === 20000 && !wideNotified && s.searchingSince) {
      wideNotified = true;
      await ctx.reply('⏳ Still searching — widening filters...').catch(() => {});
    }

    if (elapsed >= 60000) {
      clearInterval(poll);
      removeFromPools(s.anon_id);
      s.searchingSince = null;
      await ctx.reply(
        `🌱 *Nobody searching right now!*\n\nWe're growing every day.\n💡 Try again in a few minutes.\n\n🔗 Invite friends: /refer`,
        { parse_mode: 'Markdown', ...lobbyKb() }
      ).catch(() => {});
    }
  }, 1000);
}

// ─── MINI GAMES ───────────────────────────────────────────────────────────────
const TRIVIA_QUESTIONS = [
  { q: 'What planet is closest to the sun?',  a: 'mercury', hint: 'Starts with M' },
  { q: 'How many continents are there?',      a: '7',       hint: 'Single digit'  },
  { q: 'What gas do plants absorb?',          a: 'co2',     hint: 'Carbon...'     },
  { q: 'Who painted the Mona Lisa?',          a: 'da vinci',hint: 'Italian artist'},
  { q: 'What is the largest ocean?',          a: 'pacific', hint: 'Starts with P' },
  { q: 'Capital of Japan?',                   a: 'tokyo',   hint: 'Modern megacity'},
  { q: 'Fastest land animal?',                a: 'cheetah', hint: 'Big cat'        },
];

const WOULD_YOU_RATHER = [
  'Would you rather have the ability to fly OR be invisible?',
  'Would you rather live in the future OR the past?',
  'Would you rather be famous OR be rich in private?',
  'Would you rather never use social media OR never watch movies/TV?',
  'Would you rather speak all languages OR play all instruments?',
];

const TRUTH_OR_DARE = [
  ['What's your most embarrassing memory?',     'Send a voice message saying "I am the champion!"'],
  ['What's one lie you've told recently?',     'Type with your eyes closed'],
  ['What's your guilty pleasure?',              'Share your most used emoji'],
];

async function startGame(chatId, gameName, tgA, tgB) {
  let msg = '', state = {};

  if (gameName === 'trivia') {
    const q = TRIVIA_QUESTIONS[Math.floor(Math.random() * TRIVIA_QUESTIONS.length)];
    state = { type: 'trivia', question: q, answered: false };
    msg   = `🎯 *Trivia!*\n\n❓ ${q.q}\n💡 Hint: ${q.hint}\n\nFirst correct answer wins!`;
  } else if (gameName === 'wyr') {
    const q = WOULD_YOU_RATHER[Math.floor(Math.random() * WOULD_YOU_RATHER.length)];
    state = { type: 'wyr', question: q };
    msg   = `🤔 *Would You Rather?*\n\n${q}\n\nBoth reply with your choice!`;
  } else if (gameName === 'tod') {
    const pair = TRUTH_OR_DARE[Math.floor(Math.random() * TRUTH_OR_DARE.length)];
    state = { type: 'tod', truth: pair[0], dare: pair[1] };
    msg   = `🎲 *Truth or Dare?*\n\n🔍 Truth: ${pair[0]}\n💥 Dare: ${pair[1]}\n\nPick one!`;
  } else if (gameName === 'wordchain') {
    state = { type: 'wordchain', lastWord: null, usedWords: [], turn: tgA };
    msg   = `🔤 *Word Chain!*\nEach word must start with the last letter of the previous.\nNo repeats! You start:`;
  }

  gameStates.set(chatId, state);
  for (const id of [tgA, tgB])
    try { await bot.telegram.sendMessage(id, msg, { parse_mode: 'Markdown' }); } catch(e) {}
}

async function handleGameInput(chatId, tg_id, text) {
  const game = gameStates.get(chatId);
  if (!game) return false;
  const chat = activeChats.get(chatId);
  if (!chat) return false;
  const partnerTg = chat.a_tg === tg_id ? chat.b_tg : chat.a_tg;

  if (game.type === 'trivia' && !game.answered) {
    if (text.toLowerCase().trim() === game.question.a) {
      game.answered = true;
      gameStates.delete(chatId);
      try { await bot.telegram.sendMessage(tg_id, `✅ *Correct!* 🎉 You win!\n\nPlay again: /game`, { parse_mode: 'Markdown' }); } catch(e) {}
      try { await bot.telegram.sendMessage(partnerTg, `❌ Partner got it first! Answer: *${game.question.a}*`, { parse_mode: 'Markdown' }); } catch(e) {}
      return true;
    }
  }

  if (game.type === 'wordchain') {
    if (game.turn !== tg_id) return true;
    const word = text.toLowerCase().trim();
    if (game.lastWord && word[0] !== game.lastWord[game.lastWord.length - 1]) {
      try { await bot.telegram.sendMessage(tg_id, `❌ Must start with "${game.lastWord[game.lastWord.length-1].toUpperCase()}"!`); } catch(e) {}
      return true;
    }
    if (game.usedWords.includes(word)) {
      try { await bot.telegram.sendMessage(tg_id, `❌ Already used!`); } catch(e) {}
      return true;
    }
    game.lastWord = word;
    game.usedWords.push(word);
    game.turn = partnerTg;
    try { await bot.telegram.sendMessage(partnerTg, `🔤 Partner: *${word}*\nYour turn → start with *${word[word.length-1].toUpperCase()}*`, { parse_mode: 'Markdown' }); } catch(e) {}
    return true;
  }

  return false;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ──────────────── ADMIN DASHBOARD ─────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function isAdmin(ctx) { return ADMIN_IDS.includes(ctx.from?.id); }

async function showAdminDashboard(ctx) {
  if (!isAdmin(ctx)) return ctx.reply('🚫 Unauthorized.');

  const totalUsers   = getTotalUsers();
  const totalChats   = getTotalChats();
  const activeToday  = getActiveUsersToday();
  const activeNow    = activeChats.size;
  const searchingNow = Object.values(waitingPool).reduce((a, b) => a + b.length, 0);
  const totalMsgs    = db.prepare("SELECT value FROM bot_stats WHERE key='total_messages'").get()?.value || 0;
  const bannedCount  = db.prepare('SELECT COUNT(*) as cnt FROM users WHERE banned=1').get()?.cnt || 0;
  const openComps    = db.prepare('SELECT COUNT(*) as cnt FROM complaints WHERE resolved=0').get()?.cnt || 0;
  const totalBots    = db.prepare('SELECT COUNT(*) as cnt FROM managed_bots WHERE active=1').get()?.cnt || 0;
  const premiumUsers = db.prepare('SELECT COUNT(*) as cnt FROM users WHERE vip_tier>0').get()?.cnt || 0;
  const pendingPay   = db.prepare("SELECT COUNT(*) as cnt FROM payments WHERE status='pending'").get()?.cnt || 0;

  const text = [
    `🛠 *Admin Dashboard*`,
    ``,
    `📊 *Stats*`,
    `├ 👥 Total Users: ${totalUsers}`,
    `├ 💬 Total Chats: ${totalChats}`,
    `├ 📨 Total Messages: ${totalMsgs}`,
    `├ 🟢 Active Now: ${activeNow} chats`,
    `├ 🔍 Searching Now: ${searchingNow}`,
    `└ 📅 Active Today: ${activeToday}`,
    ``,
    `💎 *Premium*`,
    `├ Premium Users: ${premiumUsers}`,
    `└ Pending Payments: ${pendingPay}`,
    ``,
    `🔧 *Moderation*`,
    `├ 🚫 Banned Users: ${bannedCount}`,
    `└ 📋 Open Complaints: ${openComps}`,
    ``,
    `🤖 *Bots*`,
    `└ Managed Bots: ${totalBots}`,
  ].join('\n');

  await ctx.reply(text, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback('📋 Complaints',  'adm_complaints'),
        Markup.button.callback('🚫 Banned Users','adm_banned')
      ],
      [
        Markup.button.callback('🤖 Manage Bots', 'adm_bots'),
        Markup.button.callback('💰 Payments',    'adm_payments')
      ],
      [
        Markup.button.callback('📊 Top Users',   'adm_topusers'),
        Markup.button.callback('🔄 Refresh',     'adm_refresh')
      ]
    ])
  });
}

// ── Admin: bot management ─────────────────────────────────────────────────────
async function showAdminBots(ctx) {
  if (!isAdmin(ctx)) return;
  const bots = db.prepare('SELECT * FROM managed_bots ORDER BY added_at DESC').all();

  if (!bots.length) {
    return ctx.reply(
      `🤖 *Manage Bots*\n\nNo bots added yet.`,
      { parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('➕ Add New Bot', 'adm_addbot')],
          [Markup.button.callback('« Back',         'adm_back')]
        ])
      }
    );
  }

  const lines = bots.map((b, i) =>
    `${i + 1}. ${b.active ? '🟢' : '🔴'} *${b.name}* (@${b.username})\n   📁 ${b.category} | ${b.description.slice(0, 40)}`
  ).join('\n\n');

  const botButtons = bots.map(b => [
    Markup.button.callback(`${b.active ? '🔴 Disable' : '🟢 Enable'} ${b.name}`, `adm_togglebot_${b.id}`),
    Markup.button.callback(`🗑 Delete`, `adm_delbot_${b.id}`)
  ]);

  await ctx.reply(
    `🤖 *Managed Bots (${bots.length})*\n\n${lines}`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        ...botButtons,
        [Markup.button.callback('➕ Add New Bot', 'adm_addbot')],
        [Markup.button.callback('« Back to Dashboard', 'adm_back')]
      ])
    }
  );
}

// ── Admin: payments ───────────────────────────────────────────────────────────
async function showAdminPayments(ctx) {
  if (!isAdmin(ctx)) return;
  const pays = db.prepare(
    "SELECT * FROM payments ORDER BY created_at DESC LIMIT 20"
  ).all();

  if (!pays.length) return ctx.reply('No payments yet.');

  const lines = pays.map(p =>
    `• ${p.status === 'completed' ? '✅' : '⏳'} ${p.plan} | ⭐${p.stars} | tg:${p.tg_id} | ${p.created_at.slice(0,10)}`
  ).join('\n');

  await ctx.reply(
    `💰 *Recent Payments*\n\n${lines}`,
    { parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('« Back', 'adm_back')]])
    }
  );
}

// ─── ADMIN COMMANDS ───────────────────────────────────────────────────────────
bot.command('admin', showAdminDashboard);

bot.command('ban', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const args = ctx.message.text.split(' ');
  if (args.length < 2) return ctx.reply('Usage: /ban <anon_id> [reason]');
  const anon_id = args[1];
  const reason  = args.slice(2).join(' ') || 'Rule violation';
  db.prepare('UPDATE users SET banned=1,ban_reason=? WHERE anon_id=?').run(reason, anon_id);
  await ctx.reply(`✅ Banned \`${anon_id.slice(0,8)}...\` — Reason: ${reason}`, { parse_mode: 'Markdown' });
});

bot.command('unban', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const args = ctx.message.text.split(' ');
  if (args.length < 2) return ctx.reply('Usage: /unban ');
  db.prepare('UPDATE users SET banned=0,ban_reason=NULL WHERE anon_id=?').run(args[1]);
  await ctx.reply(`✅ User \`${args[1].slice(0,8)}...\` unbanned.`, { parse_mode: 'Markdown' });
});

bot.command('broadcast', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const msg = ctx.message.text.replace('/broadcast', '').trim();
  if (!msg) return ctx.reply('Usage: /broadcast ');
  const users = db.prepare('SELECT tg_id FROM users WHERE tg_id IS NOT NULL AND banned=0').all();
  let sent = 0, failed = 0;
  for (const u of users) {
    try { await bot.telegram.sendMessage(u.tg_id, `📢 *Announcement*\n\n${msg}`, { parse_mode: 'Markdown' }); sent++; }
    catch(e) { failed++; }
    await new Promise(r => setTimeout(r, 50)); // rate limit
  }
  await ctx.reply(`📢 Broadcast done!\n✅ Sent: ${sent}\n❌ Failed: ${failed}`);
});

// ─── ADMIN CALLBACKS ──────────────────────────────────────────────────────────
bot.action('adm_refresh', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('Unauthorized');
  await ctx.answerCbQuery('Refreshed!');
  await ctx.deleteMessage().catch(() => {});
  await showAdminDashboard(ctx);
});

bot.action('adm_back', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('Unauthorized');
  await ctx.answerCbQuery();
  await ctx.deleteMessage().catch(() => {});
  await showAdminDashboard(ctx);
});

bot.action('adm_bots', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('Unauthorized');
  await ctx.answerCbQuery();
  await showAdminBots(ctx);
});

bot.action('adm_payments', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('Unauthorized');
  await ctx.answerCbQuery();
  await showAdminPayments(ctx);
});

bot.action('adm_complaints', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('Unauthorized');
  await ctx.answerCbQuery();
  const rows = db.prepare('SELECT * FROM complaints WHERE resolved=0 ORDER BY timestamp DESC LIMIT 10').all();
  if (!rows.length) return ctx.reply('✅ No open complaints!');
  const txt = rows.map(r =>
    `#${r.id} | Sev:${r.severity} | ${r.reason}\n📝 "${(r.excerpt||'').slice(0,60)}"`
  ).join('\n\n');
  await ctx.reply(
    `📋 *Open Complaints:*\n\n${txt}`,
    { parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('« Back', 'adm_back')]])
    }
  );
});

bot.action('adm_banned', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('Unauthorized');
  await ctx.answerCbQuery();
  const rows = db.prepare('SELECT * FROM users WHERE banned=1 LIMIT 10').all();
  if (!rows.length) return ctx.reply('No banned users.');
  const txt = rows.map(r =>
    `• \`${r.anon_id.slice(0,8)}...\` — ${r.ban_reason || 'no reason'}`
  ).join('\n');
  await ctx.reply(`🚫 *Banned Users:*\n\n${txt}`, { parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.callback('« Back', 'adm_back')]])
  });
});

bot.action('adm_topusers', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('Unauthorized');
  await ctx.answerCbQuery();
  const rows = db.prepare(
    `SELECT anon_id, chat_count, total_messages, streak_days, vip_tier
     FROM users ORDER BY chat_count DESC LIMIT 10`
  ).all();
  const txt = rows.map((r, i) =>
    `${i+1}. \`${r.anon_id.slice(0,8)}...\` | 💬${r.chat_count} | 📨${r.total_messages} | 🔥${r.streak_days}d | ${r.vip_tier > 0 ? '💎' : '🆓'}`
  ).join('\n');
  await ctx.reply(`📊 *Top Users*\n\n${txt}`, { parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.callback('« Back', 'adm_back')]])
  });
});

// ── Admin add bot flow ─────────────────────────────────────────────────────────
bot.action('adm_addbot', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('Unauthorized');
  await ctx.answerCbQuery();
  const s = ensureSession(ctx);
  s.awaitingBotField = 'name';
  s.pendingBot = {};
  await ctx.reply(
    `➕ *Add New Bot*\n\nStep 1/5 — Enter the *bot name* (e.g. "News Bot"):`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'adm_canceladdbot')]]) }
  );
});

bot.action('adm_canceladdbot', async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery('Cancelled');
  const s = ensureSession(ctx);
  s.awaitingBotField = null;
  s.pendingBot = {};
  await ctx.reply('❌ Bot addition cancelled.', Markup.removeKeyboard());
  await showAdminDashboard(ctx);
});

bot.action(/adm_togglebot_(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('Unauthorized');
  await ctx.answerCbQuery();
  const id  = parseInt(ctx.match[1]);
  const bot_ = db.prepare('SELECT * FROM managed_bots WHERE id=?').get(id);
  if (!bot_) return ctx.reply('Bot not found.');
  const newState = bot_.active ? 0 : 1;
  db.prepare('UPDATE managed_bots SET active=? WHERE id=?').run(newState, id);
  await ctx.reply(`${newState ? '🟢 Enabled' : '🔴 Disabled'}: *${bot_.name}*`, { parse_mode: 'Markdown' });
  await showAdminBots(ctx);
});

bot.action(/adm_delbot_(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('Unauthorized');
  await ctx.answerCbQuery();
  const id   = parseInt(ctx.match[1]);
  const bot_ = db.prepare('SELECT * FROM managed_bots WHERE id=?').get(id);
  if (!bot_) return ctx.reply('Bot not found.');
  db.prepare('DELETE FROM managed_bots WHERE id=?').run(id);
  await ctx.reply(`🗑 Deleted: *${bot_.name}*`, { parse_mode: 'Markdown' });
  await showAdminBots(ctx);
});

// ═══════════════════════════════════════════════════════════════════════════════
// ──────────────── PREMIUM PAYMENTS (Telegram Stars) ───────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

async function showPremiumPage(ctx) {
  const s = ensureSession(ctx);
  const u = getUser(s.anon_id);
  checkPremiumExpiry(s.anon_id);

  const currentTier = u.vip_tier || 0;
  const expiresText = u.premium_expires
    ? `\n⏳ *Expires:* ${u.premium_expires.slice(0,10)}`
    : '';

  const statusText = currentTier > 0
    ? `\n✅ *Current plan:* ${['','VIP','Premium'][currentTier]}${expiresText}\n`
    : '\n🆓 *Current plan:* Free\n';

  const txt = [
    `💎 *AnonymTalks Premium*`,
    statusText,
    `*🌟 VIP — 50 Telegram Stars/month*`,
    `├ ⚡ Priority matching`,
    `├ 🏷 Interest-based matching`,
    `├ 🎭 Mood-based matching`,
    `└ 🎫 3 queue jumps/day`,
    ``,
    `*👑 Premium — 100 Telegram Stars/month*`,
    `├ Everything in VIP`,
    `├ 🌐 Language filter`,
    `├ 👁 See partner mood before connecting`,
    `└ ⏰ Extended idle time (30 min)`,
    ``,
    `💡 *Telegram Stars* are the native Telegram payment method.`,
    `You can buy Stars in Telegram → Settings → My Stars.`,
  ].join('\n');

  await ctx.reply(txt, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback('⭐ Get VIP — 50 Stars',     'buy_vip'),
        Markup.button.callback('👑 Get Premium — 100 Stars','buy_premium')
      ],
      currentTier > 0
        ? [Markup.button.callback('❌ Cancel Subscription', 'cancel_premium')]
        : [Markup.button.callback('ℹ️ What are Stars?',      'stars_info')]
    ])
  });
}

async function sendInvoice(ctx, plan) {
  const s     = ensureSession(ctx);
  const planData = PREMIUM_PLANS[plan];
  if (!planData) return;

  const payload = `${plan}_${s.anon_id}_${Date.now()}`;

  // Save pending payment
  db.prepare(
    'INSERT INTO payments(tg_id,anon_id,plan,stars,payload,status) VALUES(?,?,?,?,?,?)'
  ).run(ctx.from.id, s.anon_id, plan, planData.stars, payload, 'pending');

  try {
    await ctx.replyWithInvoice({
      title:          `${planData.label} — AnonymTalks`,
      description:    `${planData.description}\n\nValid for ${planData.days} days.`,
      payload,
      currency:       'XTR',             // XTR = Telegram Stars
      prices:         [{ label: planData.label, amount: planData.stars }],
      provider_token: '',                // empty for Stars
    });
  } catch(e) {
    console.error('Invoice error:', e.message);
    await ctx.reply(
      `⚠️ Could not create invoice.\n\nError: ${e.message}\n\nMake sure your bot supports Telegram Stars payments.`
    );
  }
}

bot.action('buy_vip', async (ctx) => {
  await ctx.answerCbQuery();
  await sendInvoice(ctx, 'vip');
});

bot.action('buy_premium', async (ctx) => {
  await ctx.answerCbQuery();
  await sendInvoice(ctx, 'premium');
});

bot.action('cancel_premium', async (ctx) => {
  await ctx.answerCbQuery();
  const s = ensureSession(ctx);
  db.prepare('UPDATE users SET vip_tier=0,premium=0,premium_expires=NULL WHERE anon_id=?').run(s.anon_id);
  s.vip_tier = 0;
  await ctx.reply('❌ *Subscription cancelled.*\n\nYou have been downgraded to Free tier.', { parse_mode: 'Markdown' });
});

bot.action('stars_info', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(
    `⭐ *What are Telegram Stars?*\n\n` +
    `Telegram Stars (XTR) are Telegram's built-in digital currency.\n\n` +
    `*How to get Stars:*\n` +
    `1. Open Telegram\n` +
    `2. Go to Settings → My Stars\n` +
    `3. Tap "Get Stars"\n` +
    `4. Purchase via the App Store / Google Play\n\n` +
    `*Pricing (approx):*\n` +
    `• 50 Stars ≈ $1 / ₹85\n` +
    `• 100 Stars ≈ $2 / ₹170\n\n` +
    `Stars are safe, instant, and private!`,
    { parse_mode: 'Markdown' }
  );
});

// ── Pre-checkout query (must answer within 10s) ────────────────────────────────
bot.on('pre_checkout_query', async (ctx) => {
  try {
    await ctx.answerPreCheckoutQuery(true);
  } catch(e) {
    console.error('Pre-checkout error:', e.message);
  }
});

// ── Successful payment handler ─────────────────────────────────────────────────
bot.on('message', async (ctx, next) => {
  if (ctx.message?.successful_payment) {
    const payment = ctx.message.successful_payment;
    const payload = payment.invoice_payload;

    // Find pending payment row
    const row = db.prepare("SELECT * FROM payments WHERE payload=? AND status='pending'").get(payload);
    if (!row) return;

    const planData = PREMIUM_PLANS[row.plan];
    if (!planData) return;

    // Mark payment complete
    db.prepare(
      "UPDATE payments SET status='completed',completed_at=datetime('now') WHERE payload=?"
    ).run(payload);

    // Activate premium
    const expiresAt = new Date(Date.now() + planData.days * 86400000).toISOString().slice(0, 10);
    db.prepare(
      'UPDATE users SET vip_tier=?,premium=1,premium_expires=? WHERE anon_id=?'
    ).run(planData.tier, expiresAt, row.anon_id);

    // Sync session
    const s = ensureSession(ctx);
    s.vip_tier = planData.tier;

    await ctx.reply(
      `🎉 *Payment Successful!*\n\n` +
      `✅ You are now *${planData.label}*!\n` +
      `📅 Expires: ${expiresAt}\n\n` +
      `${planData.description}\n\n` +
      `Enjoy your premium features! 🚀`,
      { parse_mode: 'Markdown', ...lobbyKb() }
    );

    // Notify admin
    for (const adminId of ADMIN_IDS) {
      try {
        await bot.telegram.sendMessage(
          adminId,
          `💰 *New Payment*\n\nPlan: ${planData.label}\nStars: ${planData.stars}\nUser: tg_id ${ctx.from.id}\nDate: ${new Date().toISOString().slice(0,10)}`,
          { parse_mode: 'Markdown' }
        );
      } catch(e) {}
    }
    return; // don't process further
  }
  return next();
});

// ═══════════════════════════════════════════════════════════════════════════════
// ──────────────── OUR BOTS PAGE ───────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

async function showOurBots(ctx) {
  const bots = db.prepare(
    'SELECT * FROM managed_bots WHERE active=1 ORDER BY added_at DESC'
  ).all();

  if (!bots.length) {
    return ctx.reply(
      `🤖 *Our Bots*\n\nNo bots available right now.\nCheck back soon!`,
      { parse_mode: 'Markdown', ...lobbyKb() }
    );
  }

  // Group by category
  const byCategory = {};
  for (const b of bots) {
    if (!byCategory[b.category]) byCategory[b.category] = [];
    byCategory[b.category].push(b);
  }

  let txt = `🤖 *Our Official Bots*\n\n_All bots below are made by the AnonymTalks team._\n`;

  for (const [category, items] of Object.entries(byCategory)) {
    txt += `\n*${category}*\n`;
    for (const b of items) {
      txt += `• [${b.name}](${b.link}) — ${b.description || 'No description'}\n`;
    }
  }

  // Build inline buttons (2 per row)
  const buttons = bots.map(b => Markup.button.url(`🔗 ${b.name}`, b.link));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));

  await ctx.reply(txt, {
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
    ...Markup.inlineKeyboard(rows)
  });
}

// ─── MAIN COMMANDS ────────────────────────────────────────────────────────────
bot.start(async (ctx) => {
  const s = ensureSession(ctx);
  ensureUserRow(s.anon_id, ctx.from.id);

  // Referral handling
  const payload = ctx.startPayload;
  if (payload?.startsWith('ref_')) {
    const code   = payload.replace('ref_', '');
    const refRow = db.prepare('SELECT * FROM referrals WHERE code=?').get(code);
    if (refRow && refRow.owner_anon !== s.anon_id) {
      const u = getUser(s.anon_id);
      if (!u.referred_by) {
        db.prepare('UPDATE users SET referred_by=? WHERE anon_id=?').run(refRow.owner_anon, s.anon_id);
        db.prepare('UPDATE referrals SET used_count=used_count+1 WHERE code=?').run(code);
        db.prepare('UPDATE users SET referral_count=referral_count+1 WHERE anon_id=?').run(refRow.owner_anon);
        await ctx.reply('🎉 You joined via a referral link! Your friend earns a bonus.');
      }
    }
  }

  await ctx.reply(
    [
      `👋 *Welcome to AnonymTalks!*`,
      ``,
      `Chat anonymously with people worldwide.`,
      `Your privacy is protected — no personal info stored.`,
      ``,
      `*Get started:*`,
      `• Tap 🚀 *Random Chat* to find a partner`,
      `• Set interests with 🔍 *Match by Interest*`,
      `• Upgrade with 💎 *Go Premium*`,
      ``,
      `_Type /rules to see community guidelines._`,
    ].join('\n'),
    { parse_mode: 'Markdown', ...lobbyKb() }
  );
});

bot.command('stop', async (ctx) => {
  const s = ensureSession(ctx);
  if (s.searchingSince) {
    removeFromPools(s.anon_id);
    s.searchingSince = null;
    return ctx.reply('🛑 Search cancelled.', lobbyKb());
  }
  if (!tgToAnon[ctx.from.id]?.chatId) return ctx.reply('🤷 You're not in a chat.', lobbyKb());
  await endChatForUser(s.anon_id, 'user_stop');
  s.inChat = false;
  await ctx.reply('👋 Chat ended.', lobbyKb());
});

bot.command('next', async (ctx) => {
  const s = ensureSession(ctx);
  if (tgToAnon[ctx.from.id]?.chatId) { await endChatForUser(s.anon_id, 'user_next'); s.inChat = false; }
  await startSearch(ctx, { mode: 'random' });
});

bot.command('rules', async (ctx) => {
  await ctx.reply(
    `📜 *AnonymTalks Rules*\n\n` +
    `1️⃣ No sexual content involving minors — *instant permanent ban*\n` +
    `2️⃣ No threats or violence\n` +
    `3️⃣ No doxxing (sharing personal info)\n` +
    `4️⃣ No spam or flooding\n` +
    `5️⃣ No hate speech\n\n` +
    `_Violations are auto-detected and escalated._\n` +
    `_Repeated reports = ban._\n\n` +
    `Be kind — real humans are on the other side. 💙`,
    { parse_mode: 'Markdown' }
  );
});

bot.command('profile', async (ctx) => {
  const s      = ensureSession(ctx);
  const u      = getUser(s.anon_id);
  const rating = getRating(s.anon_id);
  const stars  = rating > 0 ? '⭐'.repeat(Math.round(rating)) : 'no rating yet';
  checkPremiumExpiry(s.anon_id);

  await ctx.reply(
    [
      `👤 *Your Profile*`,
      ``,
      `🆔 ID: \`${s.anon_id.slice(0, 8)}...\``,
      `🏆 Rating: ${rating} ${stars}`,
      `💬 Chats: ${u.chat_count || 0}`,
      `📨 Messages: ${u.total_messages || 0}`,
      `🔥 Streak: ${u.streak_days || 0} day(s)`,
      `🏷 Interests: ${u.interests || 'not set'}`,
      `🎭 Mood: ${u.mood || 'not set'}`,
      `🌐 Language: ${u.language || 'any'}`,
      `💎 Tier: ${['🆓 Free','⭐ VIP','👑 Premium'][u.vip_tier || 0]}`,
      u.premium_expires ? `⏳ Expires: ${u.premium_expires.slice(0,10)}` : '',
      `👥 Referrals: ${u.referral_count || 0}`,
    ].filter(Boolean).join('\n'),
    { parse_mode: 'Markdown' }
  );
});

bot.command('bonus', async (ctx) => {
  const s     = ensureSession(ctx);
  const today = new Date().toISOString().slice(0, 10);
  const u     = getUser(s.anon_id);
  if (u.last_bonus_date === today)
    return ctx.reply('⏰ Daily bonus already claimed! Come back tomorrow. 🌅');
  db.prepare('UPDATE users SET last_bonus_date=? WHERE anon_id=?').run(today, s.anon_id);
  s.queueJump = (s.queueJump || 0) + 1;
  await ctx.reply(
    `🎁 *Daily Bonus Claimed!*\n\n` +
    `✅ +1 Queue Jump Token\n` +
    `🔥 Keep chatting daily to grow your streak!`,
    { parse_mode: 'Markdown' }
  );
});

bot.command('game', async (ctx) => {
  const mapping = tgToAnon[ctx.from.id];
  if (!mapping) return ctx.reply('Start a chat first to play games! 🎮');
  const chat = activeChats.get(mapping.chatId);
  if (!chat) return ctx.reply('No active chat found.');

  if (gameStates.has(mapping.chatId)) {
    return ctx.reply(
      '🎮 A game is already running!',
      Markup.inlineKeyboard([[Markup.button.callback('🛑 Stop Game', `stopgame_${mapping.chatId}`)]])
    );
  }

  await ctx.reply('🎮 *Choose a Mini Game:*', {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback('🧠 Trivia',         `game_trivia_${mapping.chatId}`),
        Markup.button.callback('🤔 Would You Rather',`game_wyr_${mapping.chatId}`)
      ],
      [
        Markup.button.callback('🎲 Truth or Dare',   `game_tod_${mapping.chatId}`),
        Markup.button.callback('🔤 Word Chain',       `game_wordchain_${mapping.chatId}`)
      ],
      [Markup.button.callback('❌ Cancel', 'game_cancel')]
    ])
  });
});

bot.command('report', async (ctx) => {
  const s       = ensureSession(ctx);
  const mapping = tgToAnon[ctx.from.id];
  if (!mapping) return ctx.reply('No active chat to report.');
  s.awaitingComplaint = { accusedAnon: mapping.partnerAnon };
  await ctx.reply('📝 Describe the violation briefly (e.g. "spam", "abuse", "threats"):');
});

bot.command('leaderboard', showLeaderboard);
bot.command('refer',       showReferral);
bot.command('premium',     showPremiumPage);
bot.command('interests',   showInterestPicker);
bot.command('mood',        showMoodPicker);
bot.command('language',    showLanguagePicker);

// ─── LOBBY BUTTON HEARS ───────────────────────────────────────────────────────
bot.hears('🚀 Random Chat',       ctx => startSearch(ctx, { mode: 'random' }));
bot.hears('😍 Flirt Chat',        ctx => startSearch(ctx, { mode: 'random', flirt: true }));
bot.hears('🔍 Match by Interest', showInterestPicker);
bot.hears('🎭 Match by Mood',     showMoodPicker);
bot.hears('👤 Profile',           ctx => bot.handleUpdate({ ...ctx.update, message: { ...ctx.message, text: '/profile' } }));
bot.hears('🎁 Daily Bonus',       ctx => bot.handleUpdate({ ...ctx.update, message: { ...ctx.message, text: '/bonus'   } }));
bot.hears('📊 Leaderboard',       showLeaderboard);
bot.hears('🎮 Mini Games',        ctx => ctx.reply('Start a chat first, then use /game! 🎮'));
bot.hears('💎 Go Premium',        showPremiumPage);
bot.hears('🔗 Refer & Earn',      showReferral);
bot.hears('🤖 Our Bots',          showOurBots);
bot.hears('❌ Cancel Search',     async (ctx) => {
  const s = ensureSession(ctx);
  if (s.searchingSince) {
    removeFromPools(s.anon_id);
    s.searchingSince = null;
    return ctx.reply('🛑 Search cancelled.', lobbyKb());
  }
  return ctx.reply('Not searching.', lobbyKb());
});

// ─── INLINE CALLBACKS ─────────────────────────────────────────────────────────
bot.action('rate_5',  async (ctx) => { await ctx.answerCbQuery(); await doRate(ctx, 5); });
bot.action('rate_1',  async (ctx) => { await ctx.answerCbQuery(); await doRate(ctx, 1); });

bot.action('show_rating', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(
    'Rate your recent chat partner:',
    Markup.inlineKeyboard([[
      Markup.button.callback('⭐1',    'rate_exact_1'),
      Markup.button.callback('⭐⭐2',  'rate_exact_2'),
      Markup.button.callback('⭐⭐⭐3','rate_exact_3'),
      Markup.button.callback('⭐×4',   'rate_exact_4'),
      Markup.button.callback('⭐×5',   'rate_exact_5'),
    ]])
  );
});

bot.action(/rate_exact_(\d)/, async (ctx) => {
  await ctx.answerCbQuery();
  await doRate(ctx, parseInt(ctx.match[1]));
});

bot.action('complain', async (ctx) => {
  await ctx.answerCbQuery();
  const s       = ensureSession(ctx);
  const mapping = tgToAnon[ctx.from.id];
  if (!mapping) return ctx.reply('No active chat to report.');
  s.awaitingComplaint = { accusedAnon: mapping.partnerAnon };
  await ctx.reply('📝 Describe the violation briefly:');
});

bot.action('btn_next', async (ctx) => {
  await ctx.answerCbQuery();
  const s = ensureSession(ctx);
  if (tgToAnon[ctx.from.id]?.chatId) { await endChatForUser(s.anon_id, 'user_next'); s.inChat = false; }
  await startSearch(ctx, { mode: 'random' });
});

bot.action('go_lobby', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('🏠 You're in the lobby. Choose an option:', lobbyKb());
});

bot.action(/filter_(.+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const pref = ctx.match[1] === 'any' ? null : ctx.match[1];
  await startSearch(ctx, { mode: 'random', genderPref: pref });
});

bot.action(/interest_(.+)/, async (ctx) => {
  if (ctx.match[1] === 'done') {
    await ctx.answerCbQuery('Interests saved!');
    const s = ensureSession(ctx);
    const u = getUser(s.anon_id);
    await ctx.editMessageText(`✅ Interests saved: ${u.interests || 'none'}`);
    return;
  }
  await ctx.answerCbQuery();
  const s   = ensureSession(ctx);
  const tag = ctx.match[1];
  const u   = getUser(s.anon_id);
  const cur = u.interests ? u.interests.split(',') : [];
  const idx = cur.indexOf(tag);
  if (idx >= 0) cur.splice(idx, 1); else cur.push(tag);
  const newVal = cur.slice(0, 5).join(',');
  db.prepare('UPDATE users SET interests=? WHERE anon_id=?').run(newVal || null, s.anon_id);
  await ctx.editMessageText(
    `🏷 *Select your interests* (max 5):\nSelected: ${newVal || 'none'}`,
    { parse_mode: 'Markdown', ...buildInterestKb(newVal) }
  );
});

bot.action(/mood_(.+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const s    = ensureSession(ctx);
  const mood = ctx.match[1];
  if (mood === 'clear') {
    db.prepare('UPDATE users SET mood=NULL WHERE anon_id=?').run(s.anon_id);
    await ctx.editMessageText('🎭 Mood cleared.');
  } else {
    db.prepare('UPDATE users SET mood=? WHERE anon_id=?').run(mood, s.anon_id);
    await ctx.editMessageText(`🎭 Mood set: ${mood}\n\nWe'll match you with similar vibes!`);
  }
});

bot.action(/lang_(.+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const s    = ensureSession(ctx);
  const lang = ctx.match[1];
  db.prepare('UPDATE users SET language=? WHERE anon_id=?').run(lang, s.anon_id);
  await ctx.editMessageText(`🌐 Language set: ${lang}`);
});

bot.action(/game_(\w+)_(.+)/, async (ctx) => {
  await ctx.answerCbQuery('Game starting!');
  const [, gameName, chatId] = ctx.match;
  const chat = activeChats.get(chatId);
  if (!chat) return;
  await startGame(chatId, gameName, chat.a_tg, chat.b_tg);
  await ctx.deleteMessage().catch(() => {});
});

bot.action(/stopgame_(.+)/, async (ctx) => {
  await ctx.answerCbQuery('Game stopped!');
  const chatId = ctx.match[1];
  gameStates.delete(chatId);
  const chat = activeChats.get(chatId);
  if (chat) {
    for (const id of [chat.a_tg, chat.b_tg])
      try { await bot.telegram.sendMessage(id, '🛑 Game stopped. Back to chatting!'); } catch(e) {}
  }
});

bot.action('game_cancel', async (ctx) => {
  await ctx.answerCbQuery('Cancelled');
  await ctx.editMessageText('Game cancelled. Use /game anytime!');
});

// ─── MAIN MESSAGE HANDLER ─────────────────────────────────────────────────────
bot.on('message', async (ctx) => {
  // Skip successful_payment (handled above)
  if (ctx.message?.successful_payment) return;

  const s      = ensureSession(ctx);
  const tg_id  = ctx.from.id;

  if (isSpamming(tg_id)) return ctx.reply('🐢 Slow down!');

  // ── Admin: add bot flow ──────────────────────────────────────────────────────
  if (isAdmin(ctx) && s.awaitingBotField) {
    const field = s.awaitingBotField;
    const value = ctx.message.text?.trim();
    if (!value) return ctx.reply('Please send a text value.');

    s.pendingBot[field] = value;

    const steps = {
      name:        { next: 'username',    prompt: 'Step 2/5 — Enter the bot *username* (without @):' },
      username:    { next: 'description', prompt: 'Step 3/5 — Enter a short *description*:' },
      description: { next: 'category',   prompt: 'Step 4/5 — Enter a *category* (e.g. Chat, Games, Tools):' },
      category:    { next: 'link',        prompt: 'Step 5/5 — Enter the *Telegram link* (e.g. https://t.me/botname):' },
      link:        { next: null,          prompt: null },
    };

    const current = steps[field];

    if (current.next) {
      s.awaitingBotField = current.next;
      return ctx.reply(current.prompt, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'adm_canceladdbot')]])
      });
    }

    // All fields collected — save
    const bot_ = s.pendingBot;
    db.prepare(
      'INSERT INTO managed_bots(name,username,description,category,link,active) VALUES(?,?,?,?,?,1)'
    ).run(bot_.name, bot_.username, bot_.description, bot_.category, bot_.link);

    s.awaitingBotField = null;
    s.pendingBot = {};

    await ctx.reply(
      `✅ *Bot Added Successfully!*\n\n` +
      `🤖 Name: ${bot_.name}\n` +
      `👤 Username: @${bot_.username}\n` +
      `📁 Category: ${bot_.category}\n` +
      `📝 Description: ${bot_.description}\n` +
      `🔗 Link: ${bot_.link}`,
      { parse_mode: 'Markdown' }
    );
    return showAdminBots(ctx);
  }

  // ── Complaint text ───────────────────────────────────────────────────────────
  if (s.awaitingComplaint) {
    const accused  = s.awaitingComplaint.accusedAnon;
    const excerpt  = ctx.message.text || '[non-text]';
    const severity = checkModeration(excerpt)?.severity || 1;
    saveComplaint(s.anon_id, accused, 'user_report', excerpt, severity);
    s.awaitingComplaint = null;
    if (severity >= 3) {
      await endChatForUser(s.anon_id, 'complaint_high');
      s.inChat = false;
      return ctx.reply('🚨 Severe violation reported. Chat ended and case escalated.', lobbyKb());
    }
    return ctx.reply('✅ Complaint submitted. Our team will review it.');
  }

  // ── Active chat ──────────────────────────────────────────────────────────────
  const mapping = tgToAnon[tg_id];
  if (mapping?.chatId) {
    const chatId = mapping.chatId;
    const chat   = activeChats.get(chatId);
    if (!chat) return ctx.reply('⚠️ Chat not found.', lobbyKb());

    const text = ctx.message.text;

    // Moderation
    if (text) {
      const mod = checkModeration(text);
      if (mod?.severity >= 3) {
        saveComplaint(mapping.anon, mapping.partnerAnon, mod.reason, text, mod.severity);
        await ctx.reply('🚨 Serious violation detected. Chat ended and reported.');
        try { await bot.telegram.sendMessage(mapping.partnerTg, '⚠️ Partner removed for a policy violation.'); } catch(e) {}
        await endChat(chatId, 'auto_moderation');
        s.inChat = false;
        return;
      }
      if (mod?.severity === 2) {
        saveComplaint(mapping.anon, mapping.partnerAnon, mod.reason, text, mod.severity);
        await ctx.reply('⚠️ Warning: This message may violate our rules.');
      }
      if (mod?.severity === 1) {
        await ctx.reply('🔗 Links are not allowed in chats.');
        return;
      }
    }

    // Game input
    if (text) {
      const consumed = await handleGameInput(chatId, tg_id, text);
      if (consumed) return;
    }

    // Forward message
    try {
      if (ctx.message.text) {
        await bot.telegram.sendMessage(mapping.partnerTg, text, { protect_content: true });
      } else if (ctx.message.sticker) {
        await bot.telegram.sendSticker(mapping.partnerTg, ctx.message.sticker.file_id, { protect_content: true });
      } else {
        await ctx.reply('🚫 Only text & stickers are allowed for privacy & safety.');
        return;
      }
    } catch(e) { console.error('Forward error:', e.message); }

    // Update counters
    if (chat.a_tg === tg_id) chat.a_msgs++; else chat.b_msgs++;
    db.prepare('UPDATE users SET total_messages=total_messages+1 WHERE anon_id=?').run(mapping.anon);

    // Reset idle timer
    if (chat.idleTimer) {
      clearTimeout(chat.idleTimer);
      const u     = getUser(mapping.anon);
      const idleMs = u.vip_tier >= 2 ? 30 * 60 * 1000 : 15 * 60 * 1000;
      chat.idleTimer = setTimeout(() => endChat(chatId, 'idle_timeout'), idleMs);
    }
    return;
  }

  // ── Lobby fallback ───────────────────────────────────────────────────────────
  if (ctx.message.text && !ctx.message.text.startsWith('/')) {
    await ctx.reply('🏠 You're in the lobby. Choose an option:', lobbyKb());
  }
});

// ─── HELPER FUNCTIONS ─────────────────────────────────────────────────────────
async function doRate(ctx, value) {
  const mapping = tgToAnon[ctx.from.id];
  if (!mapping?.partnerAnon) return ctx.reply('No recent partner to rate.');
  saveRating(mapping.partnerAnon, value);
  const label = value >= 4 ? '⭐ Great rating!' : value >= 2 ? '👍 Decent.' : '💔 Low rating.';
  await ctx.reply(`${label} (${value}/5) saved.`);
}

function buildInterestKb(selectedStr) {
  const selected = selectedStr ? selectedStr.split(',') : [];
  const buttons  = INTEREST_TAGS.map(tag =>
    Markup.button.callback(`${selected.includes(tag) ? '✅' : '○'} ${tag}`, `interest_${tag}`)
  );
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  rows.push([Markup.button.callback('✅ Done', 'interest_done')]);
  return Markup.inlineKeyboard(rows);
}

async function showInterestPicker(ctx) {
  const s = ensureSession(ctx);
  const u = getUser(s.anon_id);
  await ctx.reply(
    `🏷 *Select interests* (max 5, tap to toggle):\nSelected: ${u.interests || 'none'}`,
    { parse_mode: 'Markdown', ...buildInterestKb(u.interests) }
  );
}

async function showMoodPicker(ctx) {
  const buttons = MOODS.map(m => Markup.button.callback(m, `mood_${m}`));
  const rows    = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  rows.push([Markup.button.callback('🚫 Clear Mood', 'mood_clear')]);
  await ctx.reply(
    '🎭 *Set your mood:*\nWe'll match you with a similar vibe!',
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows) }
  );
}

async function showLanguagePicker(ctx) {
  const buttons = LANGUAGES.map(l => Markup.button.callback(l, `lang_${l.toLowerCase()}`));
  const rows    = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  await ctx.reply('🌐 *Preferred language:*', { parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows) });
}

async function showLeaderboard(ctx) {
  const top = db.prepare(
    `SELECT anon_id, chat_count, streak_days, total_messages,
     CASE WHEN rating_count>0 THEN ROUND(CAST(rating_sum AS FLOAT)/rating_count,1) ELSE 0 END as avg_rating
     FROM users ORDER BY chat_count DESC LIMIT 10`
  ).all();

  if (!top.length) return ctx.reply('No users yet!');

  const medals = ['🥇','🥈','🥉'];
  const lines  = top.map((u, i) =>
    `${medals[i]||`${i+1}.`} \`${u.anon_id.slice(0,6)}...\` | 💬${u.chat_count} | 🔥${u.streak_days}d | ⭐${u.avg_rating}`
  ).join('\n');

  await ctx.reply(`📊 *Top Chatters*\n\n${lines}`, { parse_mode: 'Markdown' });
}

async function showReferral(ctx) {
  const s    = ensureSession(ctx);
  const u    = getUser(s.anon_id);
  const link = `https://t.me/${BOT_USERNAME}?start=ref_${u.referral_code}`;

  await ctx.reply(
    [
      `🔗 *Refer & Earn*`,
      ``,
      `Share your link and earn bonuses for every friend!`,
      ``,
      `Your link:`,
      `\`${link}\``,
      ``,
      `👥 Friends referred: ${u.referral_count || 0}`,
      `🎁 Every 3 referrals = +1 VIP day`,
    ].join('\n'),
    { parse_mode: 'Markdown' }
  );
}

// ─── GRACEFUL SHUTDOWN ────────────────────────────────────────────────────────
process.on('SIGINT', () => {
  console.log('\n⛔ Shutting down...');
  if (db) db.close();
  process.exit(0);
});

// ─── LAUNCH ───────────────────────────────────────────────────────────────────
(async () => {
  await initDB();
  await bot.launch();
  console.log('✅ AnonymTalks v3 running!');
  console.log(`👑 Admin IDs: ${ADMIN_IDS.join(', ') || 'none'}`);
  console.log(`🤖 Bot username: @${BOT_USERNAME}`);
})();

// ─── WEB SERVER ───────────────────────────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  const totalUsers   = getTotalUsers();
  const totalChats   = getTotalChats();
  const activeNow    = activeChats.size;
  const searchingNow = Object.values(waitingPool).reduce((a, b) => a + b.length, 0);

  res.send(`


  
  
  AnonymTalks Bot
  
    *{margin:0;padding:0;box-sizing:border-box}
    body{
      font-family:'Segoe UI',sans-serif;
      background:linear-gradient(135deg,#0f0f1a 0%,#1a1a2e 50%,#16213e 100%);
      min-height:100vh;color:#fff;display:flex;flex-direction:column;align-items:center;
      justify-content:center;padding:20px;
    }
    .card{
      background:rgba(255,255,255,.05);backdrop-filter:blur(10px);
      border:1px solid rgba(255,255,255,.1);border-radius:20px;
      padding:40px;max-width:500px;width:100%;text-align:center;
    }
    .logo{font-size:3rem;margin-bottom:10px}
    h1{font-size:1.8rem;font-weight:700;margin-bottom:6px;
       background:linear-gradient(90deg,#7c3aed,#3b82f6);
       -webkit-background-clip:text;-webkit-text-fill-color:transparent}
    .subtitle{color:#94a3b8;font-size:.95rem;margin-bottom:30px}
    .status-badge{
      display:inline-flex;align-items:center;gap:8px;
      background:rgba(16,185,129,.15);border:1px solid rgba(16,185,129,.3);
      color:#10b981;padding:8px 18px;border-radius:50px;font-size:.85rem;
      margin-bottom:30px;
    }
    .dot{width:8px;height:8px;background:#10b981;border-radius:50%;
         animation:pulse 1.5s infinite}
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
    .stats{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:24px}
    .stat{
      background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);
      border-radius:14px;padding:18px 12px;
    }
    .stat-val{font-size:1.6rem;font-weight:700;color:#7c3aed}
    .stat-lbl{font-size:.75rem;color:#94a3b8;margin-top:4px}
    .btn{
      display:inline-block;background:linear-gradient(135deg,#7c3aed,#3b82f6);
      color:#fff;padding:12px 30px;border-radius:50px;text-decoration:none;
      font-weight:600;font-size:.95rem;transition:opacity .2s;
    }
    .btn:hover{opacity:.85}
    footer{color:#475569;font-size:.75rem;margin-top:16px}
  


  
    👻
    AnonymTalks Bot
    Anonymous 1:1 Chat — Worldwide
     Bot is Online
    
      ${totalUsers}Total Users
      ${totalChats}Total Chats
      ${activeNow}Active Now
      ${searchingNow}Searching Now
    
    💬 Start Chatting
    Powered by Telegram Bot API · AnonymTalks v3
  

`);
});

app.get('/health', (req, res) => res.json({
  status:   'ok',
  active:   activeChats.size,
  users:    getTotalUsers(),
  chats:    getTotalChats(),
  uptime:   process.uptime()
}));

app.listen(PORT, () => console.log(`🌐 Web server on port ${PORT}`));
