/**
 * anonymtalks-bot-v2.js
 * AnonymTalks — Anonymous 1:1 Chat Telegram Bot
 * Enhanced Version with: Interest Matching, Moods, Mini-Games, Media Forwarding,
 * Streaks, Referral System, Language Filter, Admin Dashboard, Anti-spam, VIP Tiers
 *
 * Install:
 *   npm install telegraf sql.js dotenv
 * Run:
 *   BOT_TOKEN="..." ADMIN_IDS="123456,789012" node anonymtalks-bot-v2.js
 */

require('dotenv').config();

const { Telegraf, Markup, session } = require('telegraf');
const fs   = require('fs');
const crypto = require('crypto');
const initSqlJs = require('sql.js');

// ─── CONFIG ────────────────────────────────────────────────────────────────────
const BOT_TOKEN  = process.env.BOT_TOKEN;
const ADMIN_IDS  = (process.env.ADMIN_IDS || '').split(',').map(x => parseInt(x)).filter(Boolean);
const DB_FILE    = process.env.DB_FILE || './anonymtalks.db';
const BOT_USERNAME = process.env.BOT_USERNAME || 'AnonymTalksBot'; // set this!

if (!BOT_TOKEN) { console.error('Set BOT_TOKEN env var'); process.exit(1); }

// ─── DATABASE ──────────────────────────────────────────────────────────────────
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
      run: (...p) => { try { db.run(sql, p); save(); } catch(e) { console.error('SQL run:', e.message, sql); } },
      get:  (...p) => { try { const s = db.prepare(sql); s.bind(p); const r = s.step() ? s.getAsObject() : null; s.free(); return r; } catch(e) { console.error('SQL get:', e.message); return null; } },
      all:  (...p) => { try { const s = db.prepare(sql); s.bind(p); const r=[]; while(s.step()) r.push(s.getAsObject()); s.free(); return r; } catch(e) { console.error('SQL all:', e.message); return []; } }
    };
  }

  close() { this.save(); if (this.db) this.db.close(); }
}

let db = null;

// ─── INIT DB SCHEMA ────────────────────────────────────────────────────────────
async function initDB() {
  db = new Database(DB_FILE);
  await db.init();

  const exec = (sql) => db.prepare(sql).run();

  exec(`CREATE TABLE IF NOT EXISTS users (
    anon_id        TEXT PRIMARY KEY,
    rating_sum     INTEGER DEFAULT 0,
    rating_count   INTEGER DEFAULT 0,
    interests      TEXT DEFAULT NULL,
    mood           TEXT DEFAULT NULL,
    language       TEXT DEFAULT 'any',
    gender         TEXT DEFAULT NULL,
    premium        INTEGER DEFAULT 0,
    vip_tier       INTEGER DEFAULT 0,
    last_bonus_date TEXT DEFAULT NULL,
    chat_count     INTEGER DEFAULT 0,
    streak_days    INTEGER DEFAULT 0,
    last_chat_date TEXT DEFAULT NULL,
    total_messages INTEGER DEFAULT 0,
    referral_code  TEXT DEFAULT NULL,
    referred_by    TEXT DEFAULT NULL,
    referral_count INTEGER DEFAULT 0,
    banned         INTEGER DEFAULT 0,
    ban_reason     TEXT DEFAULT NULL,
    created_at     TEXT DEFAULT (datetime('now')),
    country        TEXT DEFAULT NULL
  )`);

  exec(`CREATE TABLE IF NOT EXISTS complaints (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp      TEXT,
    reporter_anon  TEXT,
    accused_anon   TEXT,
    reason         TEXT,
    excerpt        TEXT,
    severity       INTEGER DEFAULT 0,
    resolved       INTEGER DEFAULT 0
  )`);

  exec(`CREATE TABLE IF NOT EXISTS chat_logs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id     TEXT,
    anon_a      TEXT,
    anon_b      TEXT,
    started_at  TEXT,
    ended_at    TEXT,
    msg_count   INTEGER DEFAULT 0,
    end_reason  TEXT
  )`);

  exec(`CREATE TABLE IF NOT EXISTS referrals (
    code        TEXT PRIMARY KEY,
    owner_anon  TEXT,
    used_count  INTEGER DEFAULT 0
  )`);

  exec(`CREATE TABLE IF NOT EXISTS bot_stats (
    key   TEXT PRIMARY KEY,
    value INTEGER DEFAULT 0
  )`);

  // seed stats
  ['total_users','total_chats','active_users_today'].forEach(k => {
    const r = db.prepare('SELECT key FROM bot_stats WHERE key = ?').get(k);
    if (!r) db.prepare('INSERT INTO bot_stats(key,value) VALUES(?,0)').run(k);
  });
}

// ─── DB HELPERS ────────────────────────────────────────────────────────────────
const makeAnonId = () => crypto.randomBytes(9).toString('hex');
const makeReferralCode = () => crypto.randomBytes(4).toString('hex').toUpperCase();

function ensureUserRow(anon_id) {
  const r = db.prepare('SELECT anon_id FROM users WHERE anon_id = ?').get(anon_id);
  if (!r) {
    const code = makeReferralCode();
    db.prepare('INSERT INTO users(anon_id, referral_code) VALUES(?,?)').run(anon_id, code);
    db.prepare('INSERT OR IGNORE INTO referrals(code, owner_anon, used_count) VALUES(?,?,0)').run(code, anon_id);
    db.prepare("UPDATE bot_stats SET value = value + 1 WHERE key = 'total_users'").run();
  }
}

function getUser(anon_id) {
  ensureUserRow(anon_id);
  return db.prepare('SELECT * FROM users WHERE anon_id = ?').get(anon_id);
}

function getRating(anon_id) {
  const r = getUser(anon_id);
  if (!r || !r.rating_count) return 0;
  return Number((r.rating_sum / r.rating_count).toFixed(1));
}

function saveRating(anon_id, value) {
  ensureUserRow(anon_id);
  db.prepare('UPDATE users SET rating_sum = rating_sum + ?, rating_count = rating_count + 1 WHERE anon_id = ?').run(value, anon_id);
}

function saveComplaint(reporter, accused, reason, excerpt, severity = 0) {
  db.prepare('INSERT INTO complaints(timestamp, reporter_anon, accused_anon, reason, excerpt, severity) VALUES(?,?,?,?,?,?)')
    .run(new Date().toISOString(), reporter, accused, reason, excerpt, severity);
}

function updateStreak(anon_id) {
  const u = getUser(anon_id);
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  let newStreak = 1;
  if (u.last_chat_date === yesterday) newStreak = (u.streak_days || 0) + 1;
  else if (u.last_chat_date === today) newStreak = u.streak_days || 1;
  db.prepare('UPDATE users SET streak_days = ?, last_chat_date = ?, chat_count = chat_count + 1 WHERE anon_id = ?')
    .run(newStreak, today, anon_id);
  return newStreak;
}

function logChat(chatId, anonA, anonB, startedAt, endedAt, msgCount, endReason) {
  db.prepare('INSERT INTO chat_logs(chat_id, anon_a, anon_b, started_at, ended_at, msg_count, end_reason) VALUES(?,?,?,?,?,?,?)')
    .run(chatId, anonA, anonB, startedAt, endedAt, msgCount, endReason);
  db.prepare("UPDATE bot_stats SET value = value + 1 WHERE key = 'total_chats'").run();
}

// ─── IN-MEMORY STATE ───────────────────────────────────────────────────────────
// waitingPool: keyed by category → array of poolItems
const waitingPool = { random: [], female: [], male: [], other: [] };

// activeChats: chatId → { a_anon, b_anon, a_tg, b_tg, startedAt, a_msgs, b_msgs, idleTimer, mood, interests }
const activeChats = new Map();

// tgToAnon: tg_id → { anon, chatId, partnerAnon, partnerTg, startedAt }
const tgToAnon = {};

// anti-spam: tg_id → { count, resetAt }
const spamTracker = {};

// pending game states: chatId → { game, state }
const gameStates = new Map();

// ─── BOT SETUP ────────────────────────────────────────────────────────────────
const bot = new Telegraf(BOT_TOKEN);
bot.use(session());

// ─── CONSTANTS / STRINGS ──────────────────────────────────────────────────────
const MOODS = ['😊 Happy', '😔 Sad', '🤔 Philosophical', '🔥 Flirty', '😂 Funny', '💪 Motivational', '😴 Chill'];
const INTEREST_TAGS = ['🎵 Music', '🎮 Gaming', '📚 Books', '🏋️ Fitness', '🎨 Art', '💻 Tech', '🍕 Food', '✈️ Travel', '💰 Crypto', '🎬 Movies', '🌿 Nature', '🧠 Philosophy'];
const LANGUAGES = ['Any', 'English', 'Hindi', 'Spanish', 'Arabic', 'Russian', 'French'];

const LOBBY_BUTTONS = [
  ['🚀 Random Chat', '😍 Flirt Chat'],
  ['🔍 Match by Interest', '🎭 Match by Mood'],
  ['👤 Profile', '🎁 Daily Bonus'],
  ['📊 Leaderboard', '🎮 Mini Games'],
  ['💎 Premium', '🔗 Refer & Earn']
];

const WORDS = {
  searching: '🔍 Searching for a partner...',
  widening:  '⏳ Still searching — widening filters...',
  found:     '🦋 Partner found! Say hi 👋',
  help:      '/next — skip to next chat\n/stop — end chat\n/game — play a mini-game\n/report — report partner',
  lobby:     'You\'re in the lobby. Choose an option:',
  err_chat:  '⚠️ End your current chat first (/stop).',
  no_chat:   '🤷 You\'re not in a chat right now.',
};

// ─── MODERATION ───────────────────────────────────────────────────────────────
const MOD = {
  critical: /(?:minor|underage|age\s*\d{1,2}|kid|child|teen|13|14|15|16|17)[\s\S]{0,30}(?:sex|nude|porn|touch|naked)/i,
  threats:  /\b(i will kill|i will rape|i will hurt|shoot you|bomb|stab you|murder)\b/i,
  doxx:     /\b(your address|phone number|your location|your school|doxx)\b/i,
  hate:     /\b(nigger|faggot|kike|chink|wetback|spic)\b/i,
  spam:     /(.)\1{15,}|http[s]?:\/\/\S+/i  // repeated chars or links
};

function checkModeration(text) {
  if (!text) return null;
  if (MOD.critical.test(text)) return { severity: 3, reason: 'sexual_with_minors' };
  if (MOD.threats.test(text))  return { severity: 3, reason: 'threats' };
  if (MOD.doxx.test(text))     return { severity: 2, reason: 'possible_doxx' };
  if (MOD.hate.test(text))     return { severity: 2, reason: 'hate_speech' };
  if (MOD.spam.test(text))     return { severity: 1, reason: 'spam_or_link' };
  return null;
}

// Anti-spam rate limiter (max 5 msgs/3s)
function isSpamming(tg_id) {
  const now = Date.now();
  if (!spamTracker[tg_id] || spamTracker[tg_id].resetAt < now) {
    spamTracker[tg_id] = { count: 1, resetAt: now + 3000 };
    return false;
  }
  spamTracker[tg_id].count++;
  return spamTracker[tg_id].count > 5;
}

// ─── KEYBOARDS ────────────────────────────────────────────────────────────────
const lobbyKb    = () => Markup.keyboard(LOBBY_BUTTONS).resize();
const searchKb   = () => Markup.keyboard([['❌ Cancel Search']]).resize();
const chatKb     = () => Markup.inlineKeyboard([
  [Markup.button.callback('👍 Thumbs Up', 'rate_5'), Markup.button.callback('👎 Thumbs Down', 'rate_1')],
  [Markup.button.callback('⛔ Report', 'complain'), Markup.button.callback('⏭ Next Chat', 'btn_next')]
]);
const endChatKb  = () => Markup.inlineKeyboard([
  [Markup.button.callback('⭐ Rate Partner', 'show_rating')],
  [Markup.button.callback('🔄 Find New Partner', 'btn_next'), Markup.button.callback('🏠 Lobby', 'go_lobby')]
]);

// ─── SESSION INIT ─────────────────────────────────────────────────────────────
function ensureSession(ctx) {
  if (!ctx.session) ctx.session = {};
  if (!ctx.session.anon) {
    ctx.session.anon = {
      anon_id: makeAnonId(),
      inChat: false,
      chatId: null,
      searchingSince: null,
      awaitingComplaint: null,
      awaitingInterests: false,
      awaitingMood: false,
      awaitingLanguage: false,
      premium: false,
      vip_tier: 0,
      queueJump: 0,
    };
    ensureUserRow(ctx.session.anon.anon_id);
  }
  return ctx.session.anon;
}

// ─── POOL HELPERS ─────────────────────────────────────────────────────────────
function removeFromPools(anon_id) {
  ['random','male','female','other'].forEach(k => {
    waitingPool[k] = waitingPool[k].filter(u => u.anon_id !== anon_id);
  });
}

function interestScore(a, b) {
  if (!a || !b) return 0;
  const setA = new Set(a.split(','));
  const setB = new Set(b.split(','));
  let common = 0;
  setA.forEach(x => { if (setB.has(x)) common++; });
  return common;
}

function tryMatch(item, genderPref, mood, interests) {
  const pools = [];
  if (genderPref === 'female') pools.push(waitingPool.female);
  if (genderPref === 'male')   pools.push(waitingPool.male);
  if (genderPref === 'other')  pools.push(waitingPool.other);
  pools.push(waitingPool.random, waitingPool.male, waitingPool.female, waitingPool.other);

  let bestScore = -1, bestPool = null, bestIdx = -1;

  for (const pool of pools) {
    for (let i = 0; i < pool.length; i++) {
      const candidate = pool[i];
      if (candidate.anon_id === item.anon_id) continue;
      let score = 0;
      if (mood && candidate.mood === mood) score += 3;
      score += interestScore(interests, candidate.interests) * 2;
      score += (candidate.premium || 0);
      if (score > bestScore) { bestScore = score; bestPool = pool; bestIdx = i; }
    }
  }

  if (bestIdx >= 0) {
    const pick = bestPool.splice(bestIdx, 1)[0];
    return pick;
  }
  return null;
}

// ─── CONNECT PAIR ─────────────────────────────────────────────────────────────
async function connectPair(a, b) {
  const chatId = crypto.randomBytes(6).toString('hex');
  const startedAt = Date.now();

  removeFromPools(a.anon_id);
  removeFromPools(b.anon_id);

  activeChats.set(chatId, {
    a_anon: a.anon_id, b_anon: b.anon_id,
    a_tg: a.tg_id,    b_tg: b.tg_id,
    startedAt,         a_msgs: 0, b_msgs: 0,
    idleTimer: null,   mood: a.mood || null
  });

  tgToAnon[a.tg_id] = { anon: a.anon_id, chatId, partnerAnon: b.anon_id, partnerTg: b.tg_id, startedAt };
  tgToAnon[b.tg_id] = { anon: b.anon_id, chatId, partnerAnon: a.anon_id, partnerTg: a.tg_id, startedAt };

  const uA = getUser(a.anon_id), uB = getUser(b.anon_id);
  const streakA = updateStreak(a.anon_id);
  const streakB = updateStreak(b.anon_id);

  const msgForA = buildFoundMessage(uB, streakA);
  const msgForB = buildFoundMessage(uA, streakB);

  try {
    await bot.telegram.sendMessage(a.tg_id, msgForA, {
      parse_mode: 'Markdown',
      protect_content: true,
      ...chatKb()
    });
  } catch(e) {}
  try {
    await bot.telegram.sendMessage(b.tg_id, msgForB, {
      parse_mode: 'Markdown',
      protect_content: true,
      ...chatKb()
    });
  } catch(e) {}

  // idle auto-end after 15 min
  const timer = setTimeout(() => endChat(chatId, 'idle_timeout'), 15 * 60 * 1000);
  const chat = activeChats.get(chatId);
  if (chat) chat.idleTimer = timer;
}

function buildFoundMessage(partnerUser, myStreak) {
  const pRating = partnerUser ? getRating(partnerUser.anon_id) : 0;
  const pInterests = partnerUser?.interests ? `🏷 Interests: ${partnerUser.interests}` : '🏷 Interests: not set';
  const pMood = partnerUser?.mood ? `🎭 Mood: ${partnerUser.mood}` : '';
  const stars = '⭐'.repeat(Math.round(pRating)) || 'no rating yet';
  return [
    `${WORDS.found}`,
    ``,
    `*Partner info:*`,
    pInterests,
    pMood,
    `🏆 Rating: ${pRating} ${stars}`,
    ``,
    `🔥 Your streak: ${myStreak} day(s)`,
    ``,
    WORDS.help
  ].filter(Boolean).join('\n');
}

// ─── END CHAT ─────────────────────────────────────────────────────────────────
async function endChat(chatId, reason = 'ended') {
  const chat = activeChats.get(chatId);
  if (!chat) return;

  const seconds = Math.floor((Date.now() - chat.startedAt) / 1000);
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  const totalMsgs = (chat.a_msgs || 0) + (chat.b_msgs || 0);

  if (chat.idleTimer) clearTimeout(chat.idleTimer);
  activeChats.delete(chatId);

  const summaryText = [
    `💬 *Chat ended!*`,
    `⏱ Duration: ${mins}m ${secs}s`,
    `📨 Messages exchanged: ${totalMsgs}`,
    reason === 'idle_timeout' ? '😴 Chat ended due to inactivity.' : '',
    ``,
    `Rate your partner or find a new one:`
  ].filter(Boolean).join('\n');

  for (const tgId of [chat.a_tg, chat.b_tg]) {
    try {
      await bot.telegram.sendMessage(tgId, summaryText, { parse_mode: 'Markdown', ...endChatKb() });
    } catch(e) {}
    delete tgToAnon[tgId];
  }

  // persist log
  logChat(chatId, chat.a_anon, chat.b_anon,
    new Date(chat.startedAt).toISOString(),
    new Date().toISOString(),
    totalMsgs, reason);

  // update total messages for both users
  db.prepare('UPDATE users SET total_messages = total_messages + ? WHERE anon_id = ?').run(chat.a_msgs, chat.a_anon);
  db.prepare('UPDATE users SET total_messages = total_messages + ? WHERE anon_id = ?').run(chat.b_msgs, chat.b_anon);

  // cleanup game state if any
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
  const s = ensureSession(ctx);
  if (s.inChat) return ctx.reply(WORDS.err_chat);

  const u = getUser(s.anon_id);
  if (u.banned) return ctx.reply(`🚫 You are banned. Reason: ${u.ban_reason || 'rule violation'}`);

  s.searchingSince = Date.now();
  removeFromPools(s.anon_id);

  const item = {
    anon_id: s.anon_id,
    tg_id: ctx.from.id,
    gender: u.gender,
    premium: (s.queueJump > 0) ? 2 : (u.premium || 0),
    joinedAt: Date.now(),
    mood: u.mood,
    interests: u.interests,
    language: u.language || 'any'
  };
  if (s.queueJump > 0) s.queueJump--;

  const genderPref = opts.genderPref || null;
  if (genderPref) waitingPool[genderPref].push(item);
  else waitingPool.random.push(item);

  await ctx.reply(WORDS.searching, searchKb());

  const mood = opts.mood || u.mood;
  const interests = u.interests;

  // Poll for match
  let elapsed = 0;
  let wideningNotified = false;
  const poll = setInterval(async () => {
    elapsed += 1000;

    // Stop if user cancelled or is already in a chat
    if (!s.searchingSince || tgToAnon[ctx.from.id]?.chatId) {
      clearInterval(poll);
      return;
    }

    const match = tryMatch(item, genderPref, mood, interests);
    if (match) {
      clearInterval(poll);
      s.searchingSince = null;
      removeFromPools(s.anon_id);
      s.inChat = true;
      await connectPair(item, match);
      return;
    }

    // 20s — widening notification (only once, only if still searching)
    if (elapsed === 20000 && !wideningNotified && s.searchingSince) {
      wideningNotified = true;
      await ctx.reply(WORDS.widening).catch(() => {});
    }

    // 60s — give up with warm message
    if (elapsed >= 60000) {
      clearInterval(poll);
      removeFromPools(s.anon_id);
      s.searchingSince = null;
      await ctx.reply(
        `🌱 *We're still a growing community!*\n\nNo one is searching right now, but people join every day.\n\n💡 Try again in a few minutes — or share the bot with a friend to bring more people in!\n\n🔗 /refer — get your invite link`,
        { parse_mode: 'Markdown', ...lobbyKb() }
      ).catch(() => {});
    }
  }, 1000);
}

// ─── MINI GAMES ───────────────────────────────────────────────────────────────
const TRIVIA_QUESTIONS = [
  { q: 'What planet is closest to the sun?', a: 'mercury', hint: 'Starts with M' },
  { q: 'How many continents are there?', a: '7', hint: 'Single digit' },
  { q: 'What gas do plants absorb?', a: 'co2', hint: 'Carbon something' },
  { q: 'Who painted the Mona Lisa?', a: 'da vinci', hint: 'Italian artist' },
  { q: 'What is the largest ocean?', a: 'pacific', hint: 'Starts with P' },
  { q: 'How many sides does a hexagon have?', a: '6', hint: 'Less than 7' },
  { q: 'What is the capital of Japan?', a: 'tokyo', hint: 'Modern megacity' },
  { q: 'What animal is the fastest on land?', a: 'cheetah', hint: 'Big cat' },
];

const WOULD_YOU_RATHER = [
  'Would you rather have the ability to fly OR be invisible?',
  'Would you rather live in the future OR the past?',
  'Would you rather be famous OR be rich in private?',
  'Would you rather never use social media again OR never watch movies/TV again?',
  'Would you rather always be 10 minutes late OR always be 20 minutes early?',
  'Would you rather speak all languages OR play all instruments?',
  'Would you rather explore space OR explore the deep ocean?',
];

const TRUTH_OR_DARE = [
  ['What\'s your most embarrassing memory?', 'Send a voice message saying "I am the champion!"'],
  ['What\'s one lie you\'ve told recently?', 'Type with your eyes closed'],
  ['What\'s your guilty pleasure?', 'Share your most used emoji'],
  ['What\'s something you\'ve never told anyone?', 'Send a funny meme'],
];

async function startGame(chatId, gameName, tgA, tgB) {
  let gameMsg = '';
  let state = {};

  if (gameName === 'trivia') {
    const q = TRIVIA_QUESTIONS[Math.floor(Math.random() * TRIVIA_QUESTIONS.length)];
    state = { type: 'trivia', question: q, scores: { [tgA]: 0, [tgB]: 0 }, answered: false };
    gameMsg = `🎯 *Trivia Time!*\n\n❓ ${q.q}\n\n💡 Hint: ${q.hint}\n\nFirst to reply the correct answer wins! Type your answer:`;
  } else if (gameName === 'wyr') {
    const q = WOULD_YOU_RATHER[Math.floor(Math.random() * WOULD_YOU_RATHER.length)];
    state = { type: 'wyr', question: q };
    gameMsg = `🤔 *Would You Rather?*\n\n${q}\n\nBoth reply with your choice and reason!`;
  } else if (gameName === 'tod') {
    const pair = TRUTH_OR_DARE[Math.floor(Math.random() * TRUTH_OR_DARE.length)];
    state = { type: 'tod', truth: pair[0], dare: pair[1] };
    gameMsg = `🎲 *Truth or Dare?*\n\n🔍 Truth: ${pair[0]}\n💥 Dare: ${pair[1]}\n\nPick one and do it!`;
  } else if (gameName === 'wordchain') {
    state = { type: 'wordchain', lastWord: null, usedWords: [], turn: tgA };
    gameMsg = `🔤 *Word Chain!*\nStart a word. Next player must start a new word with the last letter.\n\nRules: No repeats! @A, you start:`;
  }

  gameStates.set(chatId, state);

  for (const tgId of [tgA, tgB]) {
    try { await bot.telegram.sendMessage(tgId, gameMsg, { parse_mode: 'Markdown' }); } catch(e) {}
  }
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
      const msg = `✅ *Correct!* 🎉 You answered: "${text}"\n\nYou win this round! Play again with /game`;
      try { await bot.telegram.sendMessage(tg_id, msg, { parse_mode: 'Markdown' }); } catch(e) {}
      try { await bot.telegram.sendMessage(partnerTg, `❌ Your partner answered first! The answer was: *${game.question.a}*`, { parse_mode: 'Markdown' }); } catch(e) {}
      return true;
    }
  }

  if (game.type === 'wordchain') {
    if (game.turn !== tg_id) return true; // not your turn, don't block forwarding
    const word = text.toLowerCase().trim();
    if (game.lastWord && word[0] !== game.lastWord[game.lastWord.length - 1]) {
      try { await bot.telegram.sendMessage(tg_id, `❌ Word must start with "${game.lastWord[game.lastWord.length - 1].toUpperCase()}"!`); } catch(e) {}
      return true;
    }
    if (game.usedWords.includes(word)) {
      try { await bot.telegram.sendMessage(tg_id, `❌ "${word}" was already used!`); } catch(e) {}
      return true;
    }
    game.lastWord = word;
    game.usedWords.push(word);
    game.turn = partnerTg;
    try { await bot.telegram.sendMessage(partnerTg, `🔤 Partner said: *${word}*\nYour turn! Start with: *${word[word.length - 1].toUpperCase()}*`, { parse_mode: 'Markdown' }); } catch(e) {}
    return true; // consumed
  }

  return false; // not consumed, forward normally
}

// ─── COMMANDS ────────────────────────────────────────────────────────────────

bot.start(async (ctx) => {
  const s = ensureSession(ctx);
  ensureUserRow(s.anon_id);

  // Handle referral links: /start ref_CODE
  const payload = ctx.startPayload;
  if (payload && payload.startsWith('ref_')) {
    const code = payload.replace('ref_', '');
    const refRow = db.prepare('SELECT * FROM referrals WHERE code = ?').get(code);
    if (refRow && refRow.owner_anon !== s.anon_id) {
      const u = getUser(s.anon_id);
      if (!u.referred_by) {
        db.prepare('UPDATE users SET referred_by = ? WHERE anon_id = ?').run(refRow.owner_anon, s.anon_id);
        db.prepare('UPDATE referrals SET used_count = used_count + 1 WHERE code = ?').run(code);
        db.prepare('UPDATE users SET referral_count = referral_count + 1 WHERE anon_id = ?').run(refRow.owner_anon);
        // give referrer a bonus
        try { await bot.telegram.sendMessage(ctx.from.id - 1, ''); } catch(e) {} // placeholder
        await ctx.reply('🎉 You joined via a referral link! Your friend gets a bonus.');
      }
    }
  }

  await ctx.reply(
    `👋 *Welcome to AnonymTalks!*\n\nChat anonymously with strangers worldwide.\n\nYour anonymous ID is set. No personal info is stored.\n\n💡 Quick start: tap *🚀 Random Chat*`,
    { parse_mode: 'Markdown', ...lobbyKb() }
  );
});

bot.command(['menu', 'settings'], async (ctx) => {
  const s = ensureSession(ctx);
  if (s.inChat) return ctx.reply(WORDS.err_chat);
  await ctx.reply(WORDS.lobby, lobbyKb());
});

bot.command('stop', async (ctx) => {
  const s = ensureSession(ctx);
  // cancel search
  if (s.searchingSince) {
    removeFromPools(s.anon_id);
    s.searchingSince = null;
    return ctx.reply('🛑 Search canceled.', lobbyKb());
  }
  if (!tgToAnon[ctx.from.id]?.chatId) return ctx.reply(WORDS.no_chat);
  await endChatForUser(s.anon_id, 'user_stop');
  s.inChat = false;
  await ctx.reply('👋 Chat ended.', lobbyKb());
});

bot.command('next', async (ctx) => {
  const s = ensureSession(ctx);
  if (tgToAnon[ctx.from.id]?.chatId) {
    await endChatForUser(s.anon_id, 'user_next');
    s.inChat = false;
  }
  await startSearch(ctx, { mode: 'random' });
});

bot.command('rules', async (ctx) => {
  await ctx.reply(
    `📜 *AnonymTalks Rules*\n\n1. No sexual content involving minors — *instant permanent ban*\n2. No threats or violence\n3. No doxxing (sharing personal info)\n4. No spam or flood\n5. No hate speech\n\nViolations are automatically detected and escalated.\nRepeated reports = ban.\n\n_Be kind — people on the other side are real humans._`,
    { parse_mode: 'Markdown' }
  );
});

bot.command('profile', async (ctx) => {
  const s = ensureSession(ctx);
  const u = getUser(s.anon_id);
  const rating = getRating(s.anon_id);
  const stars = rating > 0 ? '⭐'.repeat(Math.round(rating)) : 'no rating yet';
  const interests = u.interests || 'not set';
  const mood = u.mood || 'not set';

  await ctx.reply(
    `👤 *Your Anonymous Profile*\n\n` +
    `🆔 ID: \`${s.anon_id.slice(0, 8)}...\`\n` +
    `🏆 Rating: ${rating} ${stars}\n` +
    `💬 Chats: ${u.chat_count || 0}\n` +
    `📨 Messages: ${u.total_messages || 0}\n` +
    `🔥 Streak: ${u.streak_days || 0} day(s)\n` +
    `🏷 Interests: ${interests}\n` +
    `🎭 Mood: ${mood}\n` +
    `🌐 Language: ${u.language || 'any'}\n` +
    `💎 Tier: ${['Free','VIP','Premium'][u.vip_tier || 0]}\n` +
    `👥 Referrals: ${u.referral_count || 0}`,
    { parse_mode: 'Markdown' }
  );
});

bot.command('bonus', async (ctx) => {
  const s = ensureSession(ctx);
  const today = new Date().toISOString().slice(0, 10);
  const u = getUser(s.anon_id);
  if (u.last_bonus_date === today) return ctx.reply('⏰ Daily bonus already claimed today! Come back tomorrow.');
  db.prepare('UPDATE users SET last_bonus_date = ? WHERE anon_id = ?').run(today, s.anon_id);
  s.queueJump = (s.queueJump || 0) + 1;
  await ctx.reply(`🎁 *Daily Bonus Claimed!*\n\n✅ +1 Queue Jump Token — you'll be prioritized in the next search.\n🔥 Keep chatting daily to maintain your streak!`, { parse_mode: 'Markdown' });
});

bot.command('game', async (ctx) => {
  const mapping = tgToAnon[ctx.from.id];
  if (!mapping) return ctx.reply('Start a chat first to play games!');
  const chat = activeChats.get(mapping.chatId);
  if (!chat) return ctx.reply('No active chat found.');

  // If game already running, show stop option
  if (gameStates.has(mapping.chatId)) {
    return ctx.reply('🎮 A game is already running!', Markup.inlineKeyboard([
      [Markup.button.callback('🛑 Stop Current Game', `stop_game_${mapping.chatId}`)]
    ]));
  }

  await ctx.reply('🎮 *Choose a Mini Game:*', {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('🧠 Trivia', `game_trivia_${mapping.chatId}`), Markup.button.callback('🤔 Would You Rather', `game_wyr_${mapping.chatId}`)],
      [Markup.button.callback('🎲 Truth or Dare', `game_tod_${mapping.chatId}`), Markup.button.callback('🔤 Word Chain', `game_wordchain_${mapping.chatId}`)],
      [Markup.button.callback('❌ Cancel', 'game_cancel')]
    ])
  });
});

bot.command('report', async (ctx) => {
  const s = ensureSession(ctx);
  const mapping = tgToAnon[ctx.from.id];
  if (!mapping) return ctx.reply('No active chat to report.');
  s.awaitingComplaint = { accusedAnon: mapping.partnerAnon };
  await ctx.reply('📝 Describe the violation briefly (or type "spam" / "abuse" / "hate"):');
});

bot.command('leaderboard', async (ctx) => {
  await showLeaderboard(ctx);
});

bot.command('refer', async (ctx) => {
  await showReferral(ctx);
});

bot.command('interests', async (ctx) => {
  await showInterestPicker(ctx);
});

bot.command('mood', async (ctx) => {
  await showMoodPicker(ctx);
});

bot.command('language', async (ctx) => {
  await showLanguagePicker(ctx);
});

bot.command('premium', async (ctx) => {
  await ctx.reply(
    `💎 *AnonymTalks Premium*\n\n` +
    `*Free:* Basic matching, 1 queue jump/day\n\n` +
    `*VIP (₹49/mo):*\n` +
    `• Priority matching\n• Interest-based matching\n• Mood-based matching\n• 3 queue jumps/day\n\n` +
    `*Premium (₹99/mo):*\n` +
    `• Everything in VIP\n• Language filter\n• See partner's mood before connecting\n• Extended idle time (30 min)\n• Skip ads\n\n` +
    `Contact @YourAdminHandle to subscribe.`,
    { parse_mode: 'Markdown' }
  );
});

// Admin commands
bot.command('admin', async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return;
  const stats = db.prepare('SELECT * FROM bot_stats').all();
  const activeNow = activeChats.size;
  const waitingNow = Object.values(waitingPool).reduce((a, b) => a + b.length, 0);
  const statsText = stats.map(r => `${r.key}: ${r.value}`).join('\n');
  await ctx.reply(
    `🛠 *Admin Dashboard*\n\n` +
    `🟢 Active chats: ${activeNow}\n` +
    `⏳ Searching: ${waitingNow}\n\n` +
    statsText,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard([
      [Markup.button.callback('📋 Recent Complaints', 'admin_complaints')],
      [Markup.button.callback('🚫 Recent Bans', 'admin_bans')]
    ])}
  );
});

bot.command('ban', async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return;
  const args = ctx.message.text.split(' ');
  if (args.length < 2) return ctx.reply('Usage: /ban <anon_id> [reason]');
  const anon_id = args[1];
  const reason = args.slice(2).join(' ') || 'Rule violation';
  db.prepare('UPDATE users SET banned = 1, ban_reason = ? WHERE anon_id = ?').run(reason, anon_id);
  await ctx.reply(`✅ User ${anon_id.slice(0,8)}... banned. Reason: ${reason}`);
});

bot.command('unban', async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return;
  const args = ctx.message.text.split(' ');
  if (args.length < 2) return ctx.reply('Usage: /unban <anon_id>');
  db.prepare('UPDATE users SET banned = 0, ban_reason = NULL WHERE anon_id = ?').run(args[1]);
  await ctx.reply(`✅ User unbanned.`);
});

// ─── LOBBY BUTTON HANDLERS ───────────────────────────────────────────────────
bot.hears('🚀 Random Chat', (ctx) => startSearch(ctx, { mode: 'random' }));
bot.hears('😍 Flirt Chat',  (ctx) => startSearch(ctx, { mode: 'random', flirt: true }));
bot.hears('❌ Cancel Search', async (ctx) => {
  const s = ensureSession(ctx);
  if (s.searchingSince) {
    removeFromPools(s.anon_id);
    s.searchingSince = null;
    return ctx.reply('🛑 Search canceled.', lobbyKb());
  }
  return ctx.reply('Not searching.', lobbyKb());
});

bot.hears('🔍 Match by Interest', showInterestPicker);
bot.hears('🎭 Match by Mood',     showMoodPicker);
bot.hears('👤 Profile',           (ctx) => bot.handleUpdate({ ...ctx.update, message: { ...ctx.message, text: '/profile' } }));
bot.hears('🎁 Daily Bonus',       (ctx) => bot.handleUpdate({ ...ctx.update, message: { ...ctx.message, text: '/bonus' } }));
bot.hears('📊 Leaderboard',       showLeaderboard);
bot.hears('💎 Premium',           (ctx) => bot.handleUpdate({ ...ctx.update, message: { ...ctx.message, text: '/premium' } }));
bot.hears('🎮 Mini Games',        (ctx) => ctx.reply('Start a chat first, then use /game to play with your partner! 🎮'));
bot.hears('🔗 Refer & Earn',      showReferral);

// ─── INLINE CALLBACKS ────────────────────────────────────────────────────────
bot.action('rate_5', async (ctx) => { await ctx.answerCbQuery(); await doRate(ctx, 5); });
bot.action('rate_1', async (ctx) => { await ctx.answerCbQuery(); await doRate(ctx, 1); });
bot.action('show_rating', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('Rate your recent chat partner:',
    Markup.inlineKeyboard([
      ['⭐', '⭐⭐', '⭐⭐⭐', '⭐⭐⭐⭐', '⭐⭐⭐⭐⭐'].map((s, i) =>
        Markup.button.callback(s, `rate_exact_${i + 1}`)
      )
    ])
  );
});
bot.action(/rate_exact_(\d)/, async (ctx) => {
  await ctx.answerCbQuery();
  const val = parseInt(ctx.match[1]);
  await doRate(ctx, val);
});
bot.action('complain', async (ctx) => {
  await ctx.answerCbQuery();
  const s = ensureSession(ctx);
  const mapping = tgToAnon[ctx.from.id];
  if (!mapping) return ctx.reply('No active chat to report.');
  s.awaitingComplaint = { accusedAnon: mapping.partnerAnon };
  await ctx.reply('📝 Describe the violation briefly:');
});
bot.action('btn_next', async (ctx) => {
  await ctx.answerCbQuery();
  const s = ensureSession(ctx);
  if (tgToAnon[ctx.from.id]?.chatId) {
    await endChatForUser(s.anon_id, 'user_next');
    s.inChat = false;
  }
  await startSearch(ctx, { mode: 'random' });
});
bot.action('go_lobby', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(WORDS.lobby, lobbyKb());
});

// Gender filter
bot.action(/filter_(.+)/, async (ctx) => {
  const s = ensureSession(ctx);
  await ctx.answerCbQuery();
  const pref = ctx.match[1] === 'any' ? null : ctx.match[1];
  await startSearch(ctx, { mode: 'random', genderPref: pref });
});

// Interest selection
bot.action(/interest_(.+)/, async (ctx) => {
  const s = ensureSession(ctx);
  await ctx.answerCbQuery();
  const tag = ctx.match[1];
  const u = getUser(s.anon_id);
  const current = u.interests ? u.interests.split(',') : [];
  const idx = current.indexOf(tag);
  if (idx >= 0) current.splice(idx, 1);
  else current.push(tag);
  const newVal = current.slice(0, 5).join(','); // max 5
  db.prepare('UPDATE users SET interests = ? WHERE anon_id = ?').run(newVal || null, s.anon_id);
  await ctx.answerCbQuery(`${idx >= 0 ? 'Removed' : 'Added'}: ${tag}`);
  // re-render picker
  await ctx.editMessageText(
    `🏷 *Select your interests* (max 5, tap to toggle):\nSelected: ${newVal || 'none'}`,
    { parse_mode: 'Markdown', ...buildInterestKb(newVal) }
  );
});

bot.action('interest_done', async (ctx) => {
  await ctx.answerCbQuery('Interests saved!');
  const s = ensureSession(ctx);
  const u = getUser(s.anon_id);
  await ctx.editMessageText(`✅ Interests saved: ${u.interests || 'none'}\n\nUse 🔍 Match by Interest to find someone with similar interests!`);
});

// Mood selection
bot.action(/mood_(.+)/, async (ctx) => {
  const s = ensureSession(ctx);
  await ctx.answerCbQuery();
  const mood = ctx.match[1];
  if (mood === 'clear') {
    db.prepare('UPDATE users SET mood = NULL WHERE anon_id = ?').run(s.anon_id);
    await ctx.editMessageText('🎭 Mood cleared.');
  } else {
    db.prepare('UPDATE users SET mood = ? WHERE anon_id = ?').run(mood, s.anon_id);
    await ctx.editMessageText(`🎭 Mood set to: ${mood}\n\nWe'll try to match you with someone in a similar mood!`);
  }
});

// Language selection
bot.action(/lang_(.+)/, async (ctx) => {
  const s = ensureSession(ctx);
  await ctx.answerCbQuery();
  const lang = ctx.match[1];
  db.prepare('UPDATE users SET language = ? WHERE anon_id = ?').run(lang, s.anon_id);
  await ctx.editMessageText(`🌐 Language preference set to: ${lang}`);
});

// Game start
bot.action(/game_(\w+)_(.+)/, async (ctx) => {
  await ctx.answerCbQuery('Game starting!');
  const [, gameName, chatId] = ctx.match;
  const chat = activeChats.get(chatId);
  if (!chat) return;
  await startGame(chatId, gameName, chat.a_tg, chat.b_tg);
});

// Stop game
bot.action(/stop_game_(.+)/, async (ctx) => {
  await ctx.answerCbQuery('Game stopped!');
  const chatId = ctx.match[1];
  gameStates.delete(chatId);
  const chat = activeChats.get(chatId);
  if (chat) {
    for (const tgId of [chat.a_tg, chat.b_tg]) {
      try { await bot.telegram.sendMessage(tgId, '🛑 Game stopped. Back to chatting!', { protect_content: true }); } catch(e) {}
    }
  }
});

// Cancel game picker
bot.action('game_cancel', async (ctx) => {
  await ctx.answerCbQuery('Cancelled');
  await ctx.editMessageText('Game cancelled. Use /game anytime to play!');
});

// Admin callbacks
bot.action('admin_complaints', async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return ctx.answerCbQuery('Unauthorized');
  await ctx.answerCbQuery();
  const rows = db.prepare('SELECT * FROM complaints WHERE resolved = 0 ORDER BY timestamp DESC LIMIT 10').all();
  if (!rows.length) return ctx.reply('No open complaints.');
  const text = rows.map(r =>
    `#${r.id} | ${r.reason} | Sev:${r.severity}\n📝 ${(r.excerpt || '').slice(0, 60)}`
  ).join('\n\n');
  await ctx.reply(`📋 *Open Complaints:*\n\n${text}`, { parse_mode: 'Markdown' });
});

// ─── SEARCH BY GENDER UI ──────────────────────────────────────────────────────
bot.hears('🙋‍♀🙋‍♂ Search by Gender', async (ctx) => {
  await ctx.reply('Choose preferred gender:', Markup.inlineKeyboard([
    [Markup.button.callback('♀ Female', 'filter_female'), Markup.button.callback('♂ Male', 'filter_male')],
    [Markup.button.callback('🌈 Other', 'filter_other'),   Markup.button.callback('🎲 Any',   'filter_any')]
  ]));
});

// ─── MAIN MESSAGE HANDLER ─────────────────────────────────────────────────────
bot.on('message', async (ctx) => {
  const s = ensureSession(ctx);
  const tg_id = ctx.from.id;

  // Anti-spam check
  if (isSpamming(tg_id)) {
    return ctx.reply('🐢 Slow down! You\'re sending too fast.');
  }

  // Awaiting complaint text
  if (s.awaitingComplaint) {
    const accused = s.awaitingComplaint.accusedAnon;
    const excerpt = ctx.message.text || '[non-text]';
    const severity = checkModeration(excerpt)?.severity || 1;
    saveComplaint(s.anon_id, accused, 'user_report', excerpt, severity);
    s.awaitingComplaint = null;
    if (severity >= 3) {
      await endChatForUser(s.anon_id, 'complaint_high');
      s.inChat = false;
      return ctx.reply('🚨 Severe violation reported. Chat ended and case escalated.', lobbyKb());
    }
    return ctx.reply('✅ Complaint submitted. Thank you — our team will review it.');
  }

  // In active chat — forward message
  const mapping = tgToAnon[tg_id];
  if (mapping?.chatId) {
    const chatId = mapping.chatId;
    const chat = activeChats.get(chatId);
    if (!chat) return ctx.reply('⚠️ Chat not found.', lobbyKb());

    const text = ctx.message.text;

    // Moderation on text
    if (text) {
      const mod = checkModeration(text);
      if (mod?.severity >= 3) {
        saveComplaint(mapping.anon, mapping.partnerAnon, mod.reason, text, mod.severity);
        await ctx.reply('🚨 Your message contained a serious violation. Chat ended and case reported.');
        await bot.telegram.sendMessage(mapping.partnerTg, '⚠️ Partner was removed for a policy violation.').catch(() => {});
        await endChat(chatId, 'auto_moderation');
        s.inChat = false;
        return;
      }
      if (mod?.severity === 2) {
        saveComplaint(mapping.anon, mapping.partnerAnon, mod.reason, text, mod.severity);
        await ctx.reply('⚠️ Warning: Your message may violate our rules. Please be respectful.');
      }
      if (mod?.severity === 1) {
        await ctx.reply('🔗 Sharing links is not allowed in chats.');
        return; // don't forward
      }
    }

    // Check game input
    if (text) {
      const consumed = await handleGameInput(chatId, tg_id, text);
      if (consumed) return;
    }

    // Forward all message types — text only, media blocked, protect_content disables screenshot/forward
    try {
      if (ctx.message.text) {
        await bot.telegram.sendMessage(mapping.partnerTg, text, { protect_content: true });
      } else if (ctx.message.sticker) {
        await bot.telegram.sendSticker(mapping.partnerTg, ctx.message.sticker.file_id, { protect_content: true });
      } else if (ctx.message.photo || ctx.message.video || ctx.message.voice ||
                 ctx.message.audio || ctx.message.document || ctx.message.video_note ||
                 ctx.message.animation) {
        await ctx.reply('🚫 Media sharing is disabled for privacy and safety. Only text and stickers are allowed.', { protect_content: true });
        return;
      } else {
        await ctx.reply('⚠️ This message type is not supported.');
        return;
      }
    } catch(e) {
      console.error('Forward error:', e.message);
    }

    // Update message counters
    if (chat.a_tg === tg_id) chat.a_msgs++;
    else chat.b_msgs++;
    db.prepare('UPDATE users SET total_messages = total_messages + 1 WHERE anon_id = ?').run(mapping.anon);

    // Reset idle timer
    if (chat.idleTimer) {
      clearTimeout(chat.idleTimer);
      const idleMs = s.vip_tier >= 2 ? 30 * 60 * 1000 : 15 * 60 * 1000;
      chat.idleTimer = setTimeout(() => endChat(chatId, 'idle_timeout'), idleMs);
    }

  } else {
    // In lobby — show lobby menu for non-command text
    if (ctx.message.text && !ctx.message.text.startsWith('/')) {
      await ctx.reply(WORDS.lobby, lobbyKb());
    }
  }
});

// ─── HELPER FUNCTIONS ─────────────────────────────────────────────────────────
async function doRate(ctx, value) {
  const mapping = tgToAnon[ctx.from.id];
  if (!mapping?.partnerAnon) return ctx.reply('No recent partner to rate.');
  saveRating(mapping.partnerAnon, value);
  const label = value >= 4 ? '⭐ Great rating!' : value >= 2 ? '👍 Decent rating.' : '💔 Low rating saved.';
  await ctx.reply(`${label} Rating (${value}/5) saved for your partner.`);
}

function buildInterestKb(selectedStr) {
  const selected = selectedStr ? selectedStr.split(',') : [];
  const buttons = INTEREST_TAGS.map(tag => {
    const isSelected = selected.includes(tag);
    return Markup.button.callback(`${isSelected ? '✅' : '○'} ${tag}`, `interest_${tag}`);
  });
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  rows.push([Markup.button.callback('✅ Done', 'interest_done')]);
  return Markup.inlineKeyboard(rows);
}

async function showInterestPicker(ctx) {
  const s = ensureSession(ctx);
  const u = getUser(s.anon_id);
  await ctx.reply(
    `🏷 *Select your interests* (max 5, tap to toggle):\nSelected: ${u.interests || 'none'}`,
    { parse_mode: 'Markdown', ...buildInterestKb(u.interests) }
  );
}

async function showMoodPicker(ctx) {
  const s = ensureSession(ctx);
  const buttons = MOODS.map(m => Markup.button.callback(m, `mood_${m}`));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  rows.push([Markup.button.callback('🚫 Clear mood', 'mood_clear')]);
  await ctx.reply(
    '🎭 *Set your current mood:*\nWe\'ll match you with someone in a similar vibe!',
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows) }
  );
}

async function showLanguagePicker(ctx) {
  const buttons = LANGUAGES.map(l => Markup.button.callback(l, `lang_${l.toLowerCase()}`));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  await ctx.reply('🌐 *Preferred language:*', { parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows) });
}

async function showLeaderboard(ctx) {
  const top = db.prepare(
    `SELECT anon_id, chat_count, streak_days, total_messages,
     CASE WHEN rating_count > 0 THEN ROUND(CAST(rating_sum AS FLOAT)/rating_count, 1) ELSE 0 END as avg_rating
     FROM users ORDER BY chat_count DESC LIMIT 10`
  ).all();

  if (!top.length) return ctx.reply('No users yet!');

  const medals = ['🥇', '🥈', '🥉'];
  const lines = top.map((u, i) =>
    `${medals[i] || `${i+1}.`} \`${u.anon_id.slice(0,6)}...\` | 💬 ${u.chat_count} chats | 🔥 ${u.streak_days}d streak | ⭐ ${u.avg_rating}`
  ).join('\n');

  await ctx.reply(`📊 *Top Chatters*\n\n${lines}`, { parse_mode: 'Markdown' });
}

async function showReferral(ctx) {
  const s = ensureSession(ctx);
  const u = getUser(s.anon_id);
  const code = u.referral_code;
  const link = `https://t.me/${BOT_USERNAME}?start=ref_${code}`;

  await ctx.reply(
    `🔗 *Refer & Earn*\n\n` +
    `Share your link and earn queue jump bonuses for every friend who joins!\n\n` +
    `Your link:\n\`${link}\`\n\n` +
    `👥 Friends referred: ${u.referral_count || 0}\n` +
    `🎁 For every 3 referrals: +1 VIP day`,
    { parse_mode: 'Markdown' }
  );
}

// ─── GRACEFUL SHUTDOWN ────────────────────────────────────────────────────────
process.on('SIGINT', () => {
  console.log('\nShutting down gracefully...');
  if (db) db.close();
  process.exit(0);
});

// ─── LAUNCH ───────────────────────────────────────────────────────────────────
(async () => {
  await initDB();
  await bot.launch();
  console.log('✅ AnonymTalks v2 bot is running!');
  console.log(`Admin IDs: ${ADMIN_IDS.join(', ') || 'none set'}`);
})();