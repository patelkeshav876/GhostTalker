/**
 * anonymtalks-bot.js
 * GhostTalk — Anonymous 1:1 Chat Telegram Bot v2
 */

require('dotenv').config();

// START EXPRESS IMMEDIATELY so Render detects port right away
const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('👻 GhostTalk Bot is running!'));
app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.listen(PORT, '0.0.0.0', () => console.log('🌐 Web server on port ' + PORT));

const { Telegraf, Markup, session } = require('telegraf');
const fs     = require('fs');
const crypto = require('crypto');
const initSqlJs = require('sql.js');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const BOT_TOKEN    = process.env.BOT_TOKEN;
const ADMIN_IDS    = (process.env.ADMIN_IDS || '').split(',').map(x => parseInt(x)).filter(Boolean);
const DB_FILE      = process.env.DB_FILE      || './anonymtalks.db';
const BOT_USERNAME = process.env.BOT_USERNAME || 'GhostTalkBot';
const WEBAPP_URL   = process.env.WEBAPP_URL   || '';
const OPENAI_KEY   = process.env.OPENAI_API_KEY || '';

if (!BOT_TOKEN) { console.error('Set BOT_TOKEN env var'); process.exit(1); }

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
      run: (...p) => { try { db.run(sql, p); save(); } catch(e) { console.error('SQL run:', e.message, sql); } },
      get:  (...p) => { try { const s = db.prepare(sql); s.bind(p); const r = s.step() ? s.getAsObject() : null; s.free(); return r; } catch(e) { console.error('SQL get:', e.message); return null; } },
      all:  (...p) => { try { const s = db.prepare(sql); s.bind(p); const r=[]; while(s.step()) r.push(s.getAsObject()); s.free(); return r; } catch(e) { console.error('SQL all:', e.message); return []; } }
    };
  }

  close() { this.save(); if (this.db) this.db.close(); }
}

let db = null;

// ─── INIT DB SCHEMA ───────────────────────────────────────────────────────────
async function initDB() {
  db = new Database(DB_FILE);
  await db.init();

  const exec = (sql) => db.prepare(sql).run();

  exec(`CREATE TABLE IF NOT EXISTS users (
    anon_id         TEXT PRIMARY KEY,
    rating_sum      INTEGER DEFAULT 0,
    rating_count    INTEGER DEFAULT 0,
    interests       TEXT DEFAULT NULL,
    mood            TEXT DEFAULT NULL,
    language        TEXT DEFAULT 'any',
    gender          TEXT DEFAULT NULL,
    premium         INTEGER DEFAULT 0,
    vip_tier        INTEGER DEFAULT 0,
    last_bonus_date TEXT DEFAULT NULL,
    chat_count      INTEGER DEFAULT 0,
    streak_days     INTEGER DEFAULT 0,
    last_chat_date  TEXT DEFAULT NULL,
    total_messages  INTEGER DEFAULT 0,
    referral_code   TEXT DEFAULT NULL,
    referred_by     TEXT DEFAULT NULL,
    referral_count  INTEGER DEFAULT 0,
    banned          INTEGER DEFAULT 0,
    ban_reason      TEXT DEFAULT NULL,
    created_at      TEXT DEFAULT (datetime('now')),
    country         TEXT DEFAULT NULL,
    nickname        TEXT DEFAULT NULL,
    age             INTEGER DEFAULT NULL,
    bio             TEXT DEFAULT NULL,
    ai_enabled      INTEGER DEFAULT 1
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

  ['total_users','total_chats','active_users_today'].forEach(k => {
    const r = db.prepare('SELECT key FROM bot_stats WHERE key = ?').get(k);
    if (!r) db.prepare('INSERT INTO bot_stats(key,value) VALUES(?,0)').run(k);
  });
}

// ─── DB HELPERS ───────────────────────────────────────────────────────────────
const makeAnonId      = () => crypto.randomBytes(9).toString('hex');
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
  const today     = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  let newStreak = 1;
  if (u.last_chat_date === yesterday) newStreak = (u.streak_days || 0) + 1;
  else if (u.last_chat_date === today) newStreak = u.streak_days || 1;
  db.prepare('UPDATE users SET streak_days = ?, last_chat_date = ?, chat_count = chat_count + 1 WHERE anon_id = ?')
    .run(newStreak, today, anon_id);
  return newStreak;
}

function logChat(chatId, anonA, anonB, startedAt, endedAt, msgCount, endReason) {
  db.prepare('INSERT INTO chat_logs(chat_id,anon_a,anon_b,started_at,ended_at,msg_count,end_reason) VALUES(?,?,?,?,?,?,?)')
    .run(chatId, anonA, anonB, startedAt, endedAt, msgCount, endReason);
  db.prepare("UPDATE bot_stats SET value = value + 1 WHERE key = 'total_chats'").run();
}

// ─── IN-MEMORY STATE ──────────────────────────────────────────────────────────
const waitingPool  = { random: [], female: [], male: [], other: [] };
const activeChats  = new Map();   // chatId → chat object
const tgToAnon     = {};          // tg_id  → { anon, chatId, partnerAnon, partnerTg, startedAt }
const spamTracker  = {};          // tg_id  → { count, resetAt }
const gameStates   = new Map();   // chatId → game state
const aiSessions   = new Map();   // anon_id → OpenAI history[]
const aiChats      = new Map();   // tg_id  → { anon_id, active }

// ─── BOT SETUP ────────────────────────────────────────────────────────────────
const bot = new Telegraf(BOT_TOKEN);
bot.use(session());

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const MOODS = ['😊 Happy','😔 Sad','🤔 Philosophical','🔥 Flirty','😂 Funny','💪 Motivational','😴 Chill'];
const INTEREST_TAGS = ['🎵 Music','🎮 Gaming','📚 Books','🏋️ Fitness','🎨 Art','💻 Tech','🍕 Food','✈️ Travel','💰 Crypto','🎬 Movies','🌿 Nature','🧠 Philosophy'];
const LANGUAGES = ['Any','English','Hindi','Spanish','Arabic','Russian','French'];

const LOBBY_BUTTONS = [
  ['🚀 Random Chat',      '😍 Flirt Chat'],
  ['🔍 Match by Interest','🎭 Match by Mood'],
  ['👤 Profile',          '🎁 Daily Bonus'],
  ['📊 Leaderboard',      '🎮 Mini Games'],
  ['💎 Premium',          '🔗 Refer & Earn']
];

const WORDS = {
  searching: '🔍 Searching for a partner...',
  widening:  '⏳ Still searching — widening filters...',
  found:     '🦋 Partner found! Say hi 👋',
  help:      '/next — skip to next chat\n/stop — end chat\n/game — play a mini-game\n/report — report partner',
  lobby:     "You're in the lobby. Choose an option:",
  err_chat:  '⚠️ End your current chat first (/stop).',
  no_chat:   '🤷 You\'re not in a chat right now.',
};

// ─── MODERATION ───────────────────────────────────────────────────────────────
const MOD = {
  critical: /(?:minor|underage|age\s*\d{1,2}|kid|child|teen|13|14|15|16|17)[\s\S]{0,30}(?:sex|nude|porn|touch|naked)/i,
  threats:  /\b(i will kill|i will rape|i will hurt|shoot you|bomb|stab you|murder)\b/i,
  doxx:     /\b(your address|phone number|your location|your school|doxx)\b/i,
  hate:     /\b(nigger|faggot|kike|chink|wetback|spic)\b/i,
  spam:     /(.)\1{15,}|https?:\/\/\S+/i
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
const lobbyKb   = () => Markup.keyboard(LOBBY_BUTTONS).resize();
const searchKb  = () => Markup.keyboard([['❌ Cancel Search']]).resize();
const chatKb    = () => Markup.inlineKeyboard([
  [Markup.button.callback('👍 Thumbs Up','rate_5'), Markup.button.callback('👎 Thumbs Down','rate_1')],
  [Markup.button.callback('⛔ Report','complain'),  Markup.button.callback('⏭ Next Chat','btn_next')]
]);
const endChatKb = () => Markup.inlineKeyboard([
  [Markup.button.callback('⭐ Rate Partner','show_rating')],
  [Markup.button.callback('🔄 Find New Partner','btn_next'), Markup.button.callback('🏠 Lobby','go_lobby')]
]);

// ─── SESSION ──────────────────────────────────────────────────────────────────
function ensureSession(ctx) {
  if (!ctx.session) ctx.session = {};
  if (!ctx.session.anon) {
    ctx.session.anon = {
      anon_id: makeAnonId(),
      inChat: false,
      chatId: null,
      searchingSince: null,
      awaitingComplaint: null,
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
  let common = 0;
  b.split(',').forEach(x => { if (setA.has(x)) common++; });
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
      const c = pool[i];
      if (c.anon_id === item.anon_id) continue;
      let score = 0;
      if (mood && c.mood === mood) score += 3;
      score += interestScore(interests, c.interests) * 2;
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
    a_tg: a.tg_id,    b_tg: b.tg_id,
    startedAt, a_msgs: 0, b_msgs: 0,
    idleTimer: null
  });

  tgToAnon[a.tg_id] = { anon: a.anon_id, chatId, partnerAnon: b.anon_id, partnerTg: b.tg_id, startedAt };
  tgToAnon[b.tg_id] = { anon: b.anon_id, chatId, partnerAnon: a.anon_id, partnerTg: a.tg_id, startedAt };

  const uA = getUser(a.anon_id), uB = getUser(b.anon_id);
  const streakA = updateStreak(a.anon_id);
  const streakB = updateStreak(b.anon_id);

  try { await bot.telegram.sendMessage(a.tg_id, buildFoundMessage(uB, streakA), { parse_mode: 'Markdown', protect_content: true, ...chatKb() }); } catch(e) {}
  try { await bot.telegram.sendMessage(b.tg_id, buildFoundMessage(uA, streakB), { parse_mode: 'Markdown', protect_content: true, ...chatKb() }); } catch(e) {}

  const timer = setTimeout(() => endChat(chatId, 'idle_timeout'), 15 * 60 * 1000);
  const chat = activeChats.get(chatId);
  if (chat) chat.idleTimer = timer;
}

function buildFoundMessage(partnerUser, myStreak) {
  const pRating   = partnerUser ? getRating(partnerUser.anon_id) : 0;
  const stars     = pRating > 0 ? '⭐'.repeat(Math.round(pRating)) : 'no rating yet';
  const nick      = partnerUser?.nickname ? `👤 ${partnerUser.nickname}` : '👤 Anonymous';
  const age       = partnerUser?.age      ? ` • ${partnerUser.age}y`     : '';
  const bio       = partnerUser?.bio      ? `\n💬 "${partnerUser.bio}"`   : '';
  const interests = partnerUser?.interests ? `\n🏷 ${partnerUser.interests}` : '';
  const mood      = partnerUser?.mood     ? `\n🎭 Mood: ${partnerUser.mood}` : '';
  return [
    WORDS.found, '',
    `*Partner:*`,
    `${nick}${age}${bio}${interests}${mood}`,
    `🏆 Rating: ${pRating} ${stars}`,
    '', `🔥 Your streak: ${myStreak} day(s)`, '',
    WORDS.help
  ].filter(Boolean).join('\n');
}

// ─── END CHAT ─────────────────────────────────────────────────────────────────
async function endChat(chatId, reason = 'ended') {
  const chat = activeChats.get(chatId);
  if (!chat) return;

  const seconds   = Math.floor((Date.now() - chat.startedAt) / 1000);
  const mins      = Math.floor(seconds / 60);
  const secs      = seconds % 60;
  const totalMsgs = (chat.a_msgs || 0) + (chat.b_msgs || 0);

  if (chat.idleTimer) clearTimeout(chat.idleTimer);
  activeChats.delete(chatId);

  const summaryText = [
    `💬 *Chat ended!*`,
    `⏱ Duration: ${mins}m ${secs}s`,
    `📨 Messages exchanged: ${totalMsgs}`,
    reason === 'idle_timeout' ? '😴 Chat ended due to inactivity.' : '',
    ``, `Rate your partner or find a new one:`
  ].filter(Boolean).join('\n');

  for (const tgId of [chat.a_tg, chat.b_tg]) {
    try { await bot.telegram.sendMessage(tgId, summaryText, { parse_mode: 'Markdown', ...endChatKb() }); } catch(e) {}
    delete tgToAnon[tgId];
  }

  logChat(chatId, chat.a_anon, chat.b_anon,
    new Date(chat.startedAt).toISOString(), new Date().toISOString(), totalMsgs, reason);

  db.prepare('UPDATE users SET total_messages = total_messages + ? WHERE anon_id = ?').run(chat.a_msgs, chat.a_anon);
  db.prepare('UPDATE users SET total_messages = total_messages + ? WHERE anon_id = ?').run(chat.b_msgs, chat.b_anon);

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
  else waitingPool.random.push(item);

  await ctx.reply(WORDS.searching, searchKb());

  const mood      = opts.mood || u.mood;
  const interests = u.interests;

  let elapsed = 0;
  let wideningNotified = false;

  const poll = setInterval(async () => {
    elapsed += 1000;

    // Stop if cancelled or already matched
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

    if (elapsed === 20000 && !wideningNotified && s.searchingSince) {
      wideningNotified = true;
      await ctx.reply(WORDS.widening).catch(() => {});
    }

    if (elapsed >= 60000) {
      clearInterval(poll);
      removeFromPools(s.anon_id);
      s.searchingSince = null;

      const uu = getUser(s.anon_id);
      if (uu.ai_enabled !== 0 && OPENAI_KEY) {
        await ctx.reply(
          `😔 *No humans found right now...*\n\nWant to chat with an AI partner while you wait?`,
          { parse_mode: 'Markdown', ...Markup.inlineKeyboard([
            [Markup.button.callback('🤖 Chat with AI', 'start_ai_chat')],
            [Markup.button.callback('🔄 Try Again', 'btn_next'), Markup.button.callback('🏠 Lobby', 'go_lobby')]
          ])}
        );
      } else {
        await ctx.reply(
          `🌱 *We're still a growing community!*\n\nNo one is searching right now. Try again in a few minutes or invite a friend!\n\n🔗 /refer`,
          { parse_mode: 'Markdown', ...lobbyKb() }
        );
      }
    }
  }, 1000);
}

// ─── AI FALLBACK ──────────────────────────────────────────────────────────────
async function askAI(anon_id, userMessage) {
  if (!OPENAI_KEY) return null;

  if (!aiSessions.has(anon_id)) {
    aiSessions.set(anon_id, [{
      role: 'system',
      content: `You are a friendly anonymous chat partner on GhostTalk — a Telegram anonymous chat app.
Keep responses short (1-3 sentences), conversational, warm and engaging.
Never reveal you are an AI unless directly asked. If asked, say "I might be AI, I might be human — that's the mystery of GhostTalk 😄".
Match the user's energy — funny, thoughtful, casual as needed.`
    }]);
  }

  const history = aiSessions.get(anon_id);
  history.push({ role: 'user', content: userMessage });
  if (history.length > 21) history.splice(1, history.length - 21);

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${OPENAI_KEY}`
      },
      body: JSON.stringify({ model: 'gpt-3.5-turbo', messages: history, max_tokens: 150, temperature: 0.85 })
    });

    const data = await response.json();
    if (data.error) { console.error('OpenAI error:', data.error.message); return null; }

    const reply = data.choices?.[0]?.message?.content?.trim();
    if (reply) history.push({ role: 'assistant', content: reply });
    return reply;

  } catch(e) {
    console.error('AI fetch error:', e.message);
    return null;
  }
}

function clearAISession(anon_id) { aiSessions.delete(anon_id); }

async function startAIChat(ctx) {
  const s = ensureSession(ctx);
  aiChats.set(ctx.from.id, { anon_id: s.anon_id, active: true });

  await ctx.reply(
    `🤖 *No humans available right now...*\n\nBut I found someone interesting to talk to 👀\n\n_Human or AI? That's the mystery of GhostTalk._`,
    { parse_mode: 'Markdown' }
  );

  const intro = await askAI(s.anon_id, '[SYSTEM: User just connected. Greet them warmly and ask something fun to start.]');
  if (intro) {
    setTimeout(async () => {
      await ctx.reply(intro, {
        protect_content: true,
        ...Markup.inlineKeyboard([[
          Markup.button.callback('⏹ End AI Chat', 'end_ai_chat'),
          Markup.button.callback('🔄 Find Human', 'btn_next')
        ]])
      });
    }, 1500);
  }
}

async function handleAIMessage(ctx, text) {
  const s = ensureSession(ctx);
  await ctx.sendChatAction('typing');
  await new Promise(r => setTimeout(r, 800 + Math.random() * 1200));
  const reply = await askAI(s.anon_id, text);
  if (reply) {
    await ctx.reply(reply, {
      protect_content: true,
      ...Markup.inlineKeyboard([[
        Markup.button.callback('⏹ End Chat', 'end_ai_chat'),
        Markup.button.callback('🔄 Find Human', 'btn_next')
      ]])
    });
  } else {
    await ctx.reply("Hmm, lost my train of thought 😅 Say that again?", { protect_content: true });
  }
}

// ─── MINI GAMES ───────────────────────────────────────────────────────────────
const TRIVIA_QUESTIONS = [
  { q: 'What planet is closest to the sun?',      a: 'mercury',  hint: 'Starts with M' },
  { q: 'How many continents are there?',           a: '7',        hint: 'Single digit' },
  { q: 'What gas do plants absorb?',               a: 'co2',      hint: 'Carbon something' },
  { q: 'Who painted the Mona Lisa?',               a: 'da vinci', hint: 'Italian artist' },
  { q: 'What is the largest ocean?',               a: 'pacific',  hint: 'Starts with P' },
  { q: 'How many sides does a hexagon have?',      a: '6',        hint: 'Less than 7' },
  { q: 'What is the capital of Japan?',            a: 'tokyo',    hint: 'Modern megacity' },
  { q: 'What animal is the fastest on land?',      a: 'cheetah',  hint: 'Big cat' },
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
  ["What's your most embarrassing memory?",  'Send a voice message saying "I am the champion!"'],
  ["What's one lie you've told recently?",    'Type with your eyes closed'],
  ["What's your guilty pleasure?",            'Share your most used emoji'],
  ["What's something you've never told anyone?", 'Send a funny meme'],
];

async function startGame(chatId, gameName, tgA, tgB) {
  let gameMsg = '';
  let state   = {};

  if (gameName === 'trivia') {
    const q = TRIVIA_QUESTIONS[Math.floor(Math.random() * TRIVIA_QUESTIONS.length)];
    state   = { type: 'trivia', question: q, answered: false };
    gameMsg = `🎯 *Trivia Time!*\n\n❓ ${q.q}\n\n💡 Hint: ${q.hint}\n\nFirst to answer correctly wins!`;
  } else if (gameName === 'wyr') {
    const q = WOULD_YOU_RATHER[Math.floor(Math.random() * WOULD_YOU_RATHER.length)];
    state   = { type: 'wyr', question: q };
    gameMsg = `🤔 *Would You Rather?*\n\n${q}\n\nBoth reply with your choice and reason!`;
  } else if (gameName === 'tod') {
    const pair = TRUTH_OR_DARE[Math.floor(Math.random() * TRUTH_OR_DARE.length)];
    state   = { type: 'tod', truth: pair[0], dare: pair[1] };
    gameMsg = `🎲 *Truth or Dare?*\n\n🔍 Truth: ${pair[0]}\n💥 Dare: ${pair[1]}\n\nPick one and do it!`;
  } else if (gameName === 'wordchain') {
    state   = { type: 'wordchain', lastWord: null, usedWords: [], turn: tgA };
    gameMsg = `🔤 *Word Chain!*\nEach word must start with the last letter of the previous word. No repeats!\n\nPlayer A, start with any word:`;
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
      try { await bot.telegram.sendMessage(tg_id, `✅ *Correct!* 🎉\n\nYou win this round! Play again with /game`, { parse_mode: 'Markdown' }); } catch(e) {}
      try { await bot.telegram.sendMessage(partnerTg, `❌ Partner answered first! Answer was: *${game.question.a}*`, { parse_mode: 'Markdown' }); } catch(e) {}
      return true;
    }
  }

  if (game.type === 'wordchain') {
    if (game.turn !== tg_id) return true;
    const word = text.toLowerCase().trim();
    if (game.lastWord && word[0] !== game.lastWord[game.lastWord.length - 1]) {
      try { await bot.telegram.sendMessage(tg_id, `❌ Word must start with "${game.lastWord[game.lastWord.length-1].toUpperCase()}"!`); } catch(e) {}
      return true;
    }
    if (game.usedWords.includes(word)) {
      try { await bot.telegram.sendMessage(tg_id, `❌ "${word}" was already used!`); } catch(e) {}
      return true;
    }
    game.lastWord = word;
    game.usedWords.push(word);
    game.turn = partnerTg;
    try { await bot.telegram.sendMessage(partnerTg, `🔤 Partner said: *${word}*\nYour turn! Start with: *${word[word.length-1].toUpperCase()}*`, { parse_mode: 'Markdown' }); } catch(e) {}
    return true;
  }

  return false;
}

// ─── COMMANDS ─────────────────────────────────────────────────────────────────

bot.start(async (ctx) => {
  const s = ensureSession(ctx);
  ensureUserRow(s.anon_id);

  const payload = ctx.startPayload;
  if (payload && payload.startsWith('ref_')) {
    const code   = payload.replace('ref_', '');
    const refRow = db.prepare('SELECT * FROM referrals WHERE code = ?').get(code);
    if (refRow && refRow.owner_anon !== s.anon_id) {
      const u = getUser(s.anon_id);
      if (!u.referred_by) {
        db.prepare('UPDATE users SET referred_by = ? WHERE anon_id = ?').run(refRow.owner_anon, s.anon_id);
        db.prepare('UPDATE referrals SET used_count = used_count + 1 WHERE code = ?').run(code);
        db.prepare('UPDATE users SET referral_count = referral_count + 1 WHERE anon_id = ?').run(refRow.owner_anon);
        await ctx.reply('🎉 You joined via a referral link! Your friend gets a bonus.');
      }
    }
  }

  await ctx.reply(
    `👻 *Welcome to GhostTalk!*\n\nChat anonymously with strangers worldwide.\n\nNo name. No number. Just talk.\n\n💡 Tap *🚀 Random Chat* to start!`,
    { parse_mode: 'Markdown', ...lobbyKb() }
  );
});

bot.command(['menu','settings'], async (ctx) => {
  const s = ensureSession(ctx);
  if (s.inChat) return ctx.reply(WORDS.err_chat);
  await ctx.reply(WORDS.lobby, lobbyKb());
});

bot.command('stop', async (ctx) => {
  const s = ensureSession(ctx);
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
    `📜 *GhostTalk Rules*\n\n1. No sexual content involving minors — *instant permanent ban*\n2. No threats or violence\n3. No doxxing\n4. No spam or links\n5. No hate speech\n\n_Be kind — there's a real human on the other side._`,
    { parse_mode: 'Markdown' }
  );
});

bot.command('profile', async (ctx) => {
  const s = ensureSession(ctx);
  const u      = getUser(s.anon_id);
  const rating = getRating(s.anon_id);
  const stars  = rating > 0 ? '⭐'.repeat(Math.round(rating)) : 'no rating yet';

  await ctx.reply(
    `👤 *Your Anonymous Profile*\n\n` +
    `🆔 ID: \`${s.anon_id.slice(0,8)}...\`\n` +
    (u.nickname ? `👤 Name: ${u.nickname}\n` : '') +
    (u.age      ? `🎂 Age: ${u.age}\n`        : '') +
    (u.bio      ? `💬 Bio: ${u.bio}\n`        : '') +
    `\n🏆 Rating: ${rating} ${stars}\n` +
    `💬 Chats: ${u.chat_count || 0}\n` +
    `📨 Messages: ${u.total_messages || 0}\n` +
    `🔥 Streak: ${u.streak_days || 0} day(s)\n` +
    `🏷 Interests: ${u.interests || 'not set'}\n` +
    `🎭 Mood: ${u.mood || 'not set'}\n` +
    `🌐 Language: ${u.language || 'any'}\n` +
    `💎 Tier: ${['Free','VIP','Premium'][u.vip_tier || 0]}\n` +
    `👥 Referrals: ${u.referral_count || 0}\n\n` +
    `_Edit with /setname /setage /setbio /setgender_`,
    { parse_mode: 'Markdown' }
  );
});

bot.command('bonus', async (ctx) => {
  const s     = ensureSession(ctx);
  const today = new Date().toISOString().slice(0,10);
  const u     = getUser(s.anon_id);
  if (u.last_bonus_date === today) return ctx.reply('⏰ Daily bonus already claimed today! Come back tomorrow.');
  db.prepare('UPDATE users SET last_bonus_date = ? WHERE anon_id = ?').run(today, s.anon_id);
  s.queueJump = (s.queueJump || 0) + 1;
  await ctx.reply(`🎁 *Daily Bonus Claimed!*\n\n✅ +1 Queue Jump Token added.\n🔥 Keep chatting daily to build your streak!`, { parse_mode: 'Markdown' });
});

bot.command('game', async (ctx) => {
  const mapping = tgToAnon[ctx.from.id];
  if (!mapping?.chatId) return ctx.reply('Start a chat first, then use /game! 🎮');
  const chat = activeChats.get(mapping.chatId);
  if (!chat) return ctx.reply('No active chat found.');

  if (gameStates.has(mapping.chatId)) {
    return ctx.reply('🎮 A game is already running!', Markup.inlineKeyboard([
      [Markup.button.callback('🛑 Stop Current Game', `stop_game_${mapping.chatId}`)]
    ]));
  }

  await ctx.reply('🎮 *Choose a Mini Game:*', {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('🧠 Trivia', `game_trivia_${mapping.chatId}`),   Markup.button.callback('🤔 Would You Rather', `game_wyr_${mapping.chatId}`)],
      [Markup.button.callback('🎲 Truth or Dare', `game_tod_${mapping.chatId}`), Markup.button.callback('🔤 Word Chain', `game_wordchain_${mapping.chatId}`)],
      [Markup.button.callback('❌ Cancel', 'game_cancel')]
    ])
  });
});

bot.command('report', async (ctx) => {
  const s       = ensureSession(ctx);
  const mapping = tgToAnon[ctx.from.id];
  if (!mapping) return ctx.reply('No active chat to report.');
  s.awaitingComplaint = { accusedAnon: mapping.partnerAnon };
  await ctx.reply('📝 Briefly describe the violation:');
});

bot.command('leaderboard', async (ctx) => { await showLeaderboard(ctx); });
bot.command('refer',       async (ctx) => { await showReferral(ctx); });
bot.command('interests',   async (ctx) => { await showInterestPicker(ctx); });
bot.command('mood',        async (ctx) => { await showMoodPicker(ctx); });
bot.command('language',    async (ctx) => { await showLanguagePicker(ctx); });

bot.command('setname', async (ctx) => {
  const s    = ensureSession(ctx);
  const args = ctx.message.text.split(' ').slice(1).join(' ').trim();
  if (!args) return ctx.reply('Usage: /setname YourNickname');
  if (args.length > 24) return ctx.reply('Max 24 characters.');
  db.prepare('UPDATE users SET nickname = ? WHERE anon_id = ?').run(args, s.anon_id);
  await ctx.reply(`✅ Nickname set to: *${args}*`, { parse_mode: 'Markdown' });
});

bot.command('setage', async (ctx) => {
  const s   = ensureSession(ctx);
  const age = parseInt(ctx.message.text.split(' ')[1]);
  if (!age || age < 13 || age > 99) return ctx.reply('Usage: /setage 21  (must be 13–99)');
  db.prepare('UPDATE users SET age = ? WHERE anon_id = ?').run(age, s.anon_id);
  await ctx.reply(`✅ Age set to: *${age}*`, { parse_mode: 'Markdown' });
});

bot.command('setbio', async (ctx) => {
  const s   = ensureSession(ctx);
  const bio = ctx.message.text.split(' ').slice(1).join(' ').trim();
  if (!bio) return ctx.reply('Usage: /setbio I love music and late night chats');
  if (bio.length > 120) return ctx.reply('Bio too long — max 120 characters.');
  db.prepare('UPDATE users SET bio = ? WHERE anon_id = ?').run(bio, s.anon_id);
  await ctx.reply(`✅ Bio saved: "${bio}"`);
});

bot.command('setgender', async (ctx) => {
  await ctx.reply('Select your gender:', Markup.inlineKeyboard([
    [Markup.button.callback('♂ Male','sg_male'),   Markup.button.callback('♀ Female','sg_female')],
    [Markup.button.callback('⚧ Other','sg_other'), Markup.button.callback('— Private','sg_none')]
  ]));
});

bot.command('app', async (ctx) => {
  if (!WEBAPP_URL) return ctx.reply('WebApp coming soon!');
  await ctx.reply('👻 Open GhostTalk App:', Markup.inlineKeyboard([
    [Markup.button.webApp('Open GhostTalk App', WEBAPP_URL)]
  ]));
});

bot.command('premium', async (ctx) => {
  await ctx.reply(
    `💎 *GhostTalk Premium*\n\n` +
    `*Free:* Basic matching, 1 queue jump/day\n\n` +
    `*VIP (₹49/mo):*\n• Priority matching\n• Interest & mood matching\n• 3 queue jumps/day\n\n` +
    `*Premium (₹99/mo):*\n• Everything in VIP\n• Language filter\n• 30 min idle time\n• AI chat partner\n\n` +
    `Contact @YourAdminHandle to subscribe.`,
    { parse_mode: 'Markdown' }
  );
});

bot.command('admin', async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return;
  const stats      = db.prepare('SELECT * FROM bot_stats').all();
  const activeNow  = activeChats.size;
  const waitingNow = Object.values(waitingPool).reduce((a,b) => a + b.length, 0);
  await ctx.reply(
    `🛠 *Admin Dashboard*\n\n🟢 Active chats: ${activeNow}\n⏳ Searching: ${waitingNow}\n\n` +
    stats.map(r => `${r.key}: ${r.value}`).join('\n'),
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard([
      [Markup.button.callback('📋 Recent Complaints','admin_complaints')]
    ])}
  );
});

bot.command('ban', async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return;
  const args    = ctx.message.text.split(' ');
  if (args.length < 2) return ctx.reply('Usage: /ban <anon_id> [reason]');
  const anon_id = args[1];
  const reason  = args.slice(2).join(' ') || 'Rule violation';
  db.prepare('UPDATE users SET banned = 1, ban_reason = ? WHERE anon_id = ?').run(reason, anon_id);
  await ctx.reply(`✅ Banned: ${anon_id.slice(0,8)}... Reason: ${reason}`);
});

bot.command('unban', async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return;
  const args = ctx.message.text.split(' ');
  if (args.length < 2) return ctx.reply('Usage: /unban <anon_id>');
  db.prepare('UPDATE users SET banned = 0, ban_reason = NULL WHERE anon_id = ?').run(args[1]);
  await ctx.reply('✅ User unbanned.');
});

// ─── LOBBY BUTTON HANDLERS ────────────────────────────────────────────────────
bot.hears('🚀 Random Chat',       (ctx) => startSearch(ctx, { mode: 'random' }));
bot.hears('😍 Flirt Chat',        (ctx) => startSearch(ctx, { mode: 'random', flirt: true }));
bot.hears('🔍 Match by Interest', showInterestPicker);
bot.hears('🎭 Match by Mood',     showMoodPicker);
bot.hears('👤 Profile',           (ctx) => bot.handleUpdate({ ...ctx.update, message: { ...ctx.message, text: '/profile' } }));
bot.hears('🎁 Daily Bonus',       (ctx) => bot.handleUpdate({ ...ctx.update, message: { ...ctx.message, text: '/bonus'   } }));
bot.hears('📊 Leaderboard',       showLeaderboard);
bot.hears('💎 Premium',           (ctx) => bot.handleUpdate({ ...ctx.update, message: { ...ctx.message, text: '/premium' } }));
bot.hears('🎮 Mini Games',        (ctx) => ctx.reply('Start a chat first, then use /game to play with your partner! 🎮'));
bot.hears('🔗 Refer & Earn',      showReferral);
bot.hears('❌ Cancel Search', async (ctx) => {
  const s = ensureSession(ctx);
  if (s.searchingSince) {
    removeFromPools(s.anon_id);
    s.searchingSince = null;
    return ctx.reply('🛑 Search canceled.', lobbyKb());
  }
  return ctx.reply('Not searching right now.', lobbyKb());
});

// ─── INLINE CALLBACKS ─────────────────────────────────────────────────────────
bot.action('rate_5', async (ctx) => { await ctx.answerCbQuery(); await doRate(ctx, 5); });
bot.action('rate_1', async (ctx) => { await ctx.answerCbQuery(); await doRate(ctx, 1); });

bot.action('show_rating', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('Rate your recent chat partner:', Markup.inlineKeyboard([
    ['⭐','⭐⭐','⭐⭐⭐','⭐⭐⭐⭐','⭐⭐⭐⭐⭐'].map((s,i) => Markup.button.callback(s, `rate_exact_${i+1}`))
  ]));
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
  // Also end AI chat if active
  if (aiChats.has(ctx.from.id)) {
    aiChats.delete(ctx.from.id);
    clearAISession(s.anon_id);
  }
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

bot.action('start_ai_chat', async (ctx) => {
  await ctx.answerCbQuery();
  await startAIChat(ctx);
});

bot.action('end_ai_chat', async (ctx) => {
  await ctx.answerCbQuery();
  const s = ensureSession(ctx);
  aiChats.delete(ctx.from.id);
  clearAISession(s.anon_id);
  await ctx.reply('👋 Chat ended. Back to lobby!', lobbyKb());
});

bot.action(/^sg_(.+)$/, async (ctx) => {
  const s = ensureSession(ctx);
  await ctx.answerCbQuery();
  const gender = ctx.match[1];
  db.prepare('UPDATE users SET gender = ? WHERE anon_id = ?').run(gender === 'none' ? null : gender, s.anon_id);
  await ctx.editMessageText(`✅ Gender set to: ${gender}`);
});

bot.action(/filter_(.+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const pref = ctx.match[1] === 'any' ? null : ctx.match[1];
  await startSearch(ctx, { mode: 'random', genderPref: pref });
});

bot.action(/interest_(.+)/, async (ctx) => {
  const s   = ensureSession(ctx);
  const tag = ctx.match[1];
  if (tag === 'done') {
    await ctx.answerCbQuery('Interests saved!');
    const u = getUser(s.anon_id);
    return ctx.editMessageText(`✅ Interests saved: ${u.interests || 'none'}`);
  }
  await ctx.answerCbQuery();
  const u       = getUser(s.anon_id);
  const current = u.interests ? u.interests.split(',') : [];
  const idx     = current.indexOf(tag);
  if (idx >= 0) current.splice(idx, 1);
  else if (current.length < 5) current.push(tag);
  else { await ctx.answerCbQuery('Max 5 interests!'); return; }
  const newVal = current.join(',');
  db.prepare('UPDATE users SET interests = ? WHERE anon_id = ?').run(newVal || null, s.anon_id);
  await ctx.editMessageText(
    `🏷 *Select your interests* (max 5):\nSelected: ${newVal || 'none'}`,
    { parse_mode: 'Markdown', ...buildInterestKb(newVal) }
  );
});

bot.action(/mood_(.+)/, async (ctx) => {
  const s    = ensureSession(ctx);
  await ctx.answerCbQuery();
  const mood = ctx.match[1];
  if (mood === 'clear') {
    db.prepare('UPDATE users SET mood = NULL WHERE anon_id = ?').run(s.anon_id);
    return ctx.editMessageText('🎭 Mood cleared.');
  }
  db.prepare('UPDATE users SET mood = ? WHERE anon_id = ?').run(mood, s.anon_id);
  await ctx.editMessageText(`🎭 Mood set to: ${mood}`);
});

bot.action(/lang_(.+)/, async (ctx) => {
  const s = ensureSession(ctx);
  await ctx.answerCbQuery();
  db.prepare('UPDATE users SET language = ? WHERE anon_id = ?').run(ctx.match[1], s.anon_id);
  await ctx.editMessageText(`🌐 Language set to: ${ctx.match[1]}`);
});

bot.action(/game_(\w+)_(.+)/, async (ctx) => {
  await ctx.answerCbQuery('Game starting!');
  const [, gameName, chatId] = ctx.match;
  const chat = activeChats.get(chatId);
  if (!chat) return;
  await startGame(chatId, gameName, chat.a_tg, chat.b_tg);
});

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

bot.action('game_cancel', async (ctx) => {
  await ctx.answerCbQuery('Cancelled');
  await ctx.editMessageText('Game cancelled. Use /game anytime!');
});

bot.action('admin_complaints', async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return ctx.answerCbQuery('Unauthorized');
  await ctx.answerCbQuery();
  const rows = db.prepare('SELECT * FROM complaints WHERE resolved = 0 ORDER BY timestamp DESC LIMIT 10').all();
  if (!rows.length) return ctx.reply('No open complaints.');
  const text = rows.map(r => `#${r.id} | ${r.reason} | Sev:${r.severity}\n📝 ${(r.excerpt||'').slice(0,60)}`).join('\n\n');
  await ctx.reply(`📋 *Open Complaints:*\n\n${text}`, { parse_mode: 'Markdown' });
});

// ─── SEARCH BY GENDER ─────────────────────────────────────────────────────────
bot.hears('🙋‍♀🙋‍♂ Search by Gender', async (ctx) => {
  await ctx.reply('Choose preferred gender:', Markup.inlineKeyboard([
    [Markup.button.callback('♀ Female','filter_female'), Markup.button.callback('♂ Male','filter_male')],
    [Markup.button.callback('🌈 Other','filter_other'),  Markup.button.callback('🎲 Any','filter_any')]
  ]));
});

// ─── WEBAPP DATA ──────────────────────────────────────────────────────────────
bot.on('web_app_data', async (ctx) => {
  const s = ensureSession(ctx);
  try {
    const data = JSON.parse(ctx.webAppData.data);
    if (data.action === 'save_profile') {
      if (data.name)      db.prepare('UPDATE users SET nickname  = ? WHERE anon_id = ?').run(data.name,              s.anon_id);
      if (data.age)       db.prepare('UPDATE users SET age       = ? WHERE anon_id = ?').run(parseInt(data.age),     s.anon_id);
      if (data.bio)       db.prepare('UPDATE users SET bio       = ? WHERE anon_id = ?').run(data.bio,               s.anon_id);
      if (data.mood)      db.prepare('UPDATE users SET mood      = ? WHERE anon_id = ?').run(data.mood,              s.anon_id);
      if (data.interests) db.prepare('UPDATE users SET interests = ? WHERE anon_id = ?').run(data.interests,         s.anon_id);
      if (data.lang)      db.prepare('UPDATE users SET language  = ? WHERE anon_id = ?').run(data.lang,              s.anon_id);
      if (data.gender)    db.prepare('UPDATE users SET gender    = ? WHERE anon_id = ?').run(data.gender,            s.anon_id);
      await ctx.reply('✅ Profile updated!', lobbyKb());
    }
    if (data.action === 'find_partner')  await startSearch(ctx, { mode: 'random' });
    if (data.action === 'toggle_ai')     db.prepare('UPDATE users SET ai_enabled = ? WHERE anon_id = ?').run(data.value ? 1 : 0, s.anon_id);
    if (data.action === 'start_game') {
      const mapping = tgToAnon[ctx.from.id];
      if (!mapping) return ctx.reply('Start a chat first!');
      const chat = activeChats.get(mapping.chatId);
      if (!chat)    return ctx.reply('No active chat found.');
      await startGame(mapping.chatId, data.game, chat.a_tg, chat.b_tg);
    }
  } catch(e) {
    console.error('WebApp data error:', e.message);
  }
});

// ─── MAIN MESSAGE HANDLER ─────────────────────────────────────────────────────
bot.on('message', async (ctx) => {
  const s     = ensureSession(ctx);
  const tg_id = ctx.from.id;
  const text  = ctx.message.text;

  // Anti-spam
  if (isSpamming(tg_id)) return ctx.reply('🐢 Slow down! You\'re sending too fast.');

  // Awaiting complaint
  if (s.awaitingComplaint) {
    const accused  = s.awaitingComplaint.accusedAnon;
    const excerpt  = text || '[non-text]';
    const severity = checkModeration(excerpt)?.severity || 1;
    saveComplaint(s.anon_id, accused, 'user_report', excerpt, severity);
    s.awaitingComplaint = null;
    if (severity >= 3) {
      await endChatForUser(s.anon_id, 'complaint_high');
      s.inChat = false;
      return ctx.reply('🚨 Severe violation reported. Chat ended and case escalated.', lobbyKb());
    }
    return ctx.reply('✅ Complaint submitted. Thank you!');
  }

  // AI chat
  if (aiChats.has(tg_id) && aiChats.get(tg_id).active) {
    if (text) await handleAIMessage(ctx, text);
    return;
  }

  // Human chat
  const mapping = tgToAnon[tg_id];
  if (mapping?.chatId) {
    const chatId = mapping.chatId;
    const chat   = activeChats.get(chatId);
    if (!chat) return ctx.reply('⚠️ Chat not found.', lobbyKb());

    // Moderation
    if (text) {
      const mod = checkModeration(text);
      if (mod?.severity >= 3) {
        saveComplaint(mapping.anon, mapping.partnerAnon, mod.reason, text, mod.severity);
        await ctx.reply('🚨 Your message violated our rules. Chat ended and reported.');
        await bot.telegram.sendMessage(mapping.partnerTg, '⚠️ Partner removed for a policy violation.').catch(() => {});
        await endChat(chatId, 'auto_moderation');
        s.inChat = false;
        return;
      }
      if (mod?.severity === 2) {
        saveComplaint(mapping.anon, mapping.partnerAnon, mod.reason, text, mod.severity);
        await ctx.reply('⚠️ Warning: message may violate rules. Please be respectful.');
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

    // Forward (text + stickers only)
    try {
      if (ctx.message.text) {
        await bot.telegram.sendMessage(mapping.partnerTg, text, { protect_content: true });
      } else if (ctx.message.sticker) {
        await bot.telegram.sendSticker(mapping.partnerTg, ctx.message.sticker.file_id, { protect_content: true });
      } else {
        await ctx.reply('🚫 Only text and stickers are allowed for privacy and safety.');
        return;
      }
    } catch(e) { console.error('Forward error:', e.message); }

    // Counters
    if (chat.a_tg === tg_id) chat.a_msgs++;
    else chat.b_msgs++;
    db.prepare('UPDATE users SET total_messages = total_messages + 1 WHERE anon_id = ?').run(mapping.anon);

    // Reset idle timer
    if (chat.idleTimer) {
      clearTimeout(chat.idleTimer);
      const idleMs = (s.vip_tier >= 2) ? 30 * 60 * 1000 : 15 * 60 * 1000;
      chat.idleTimer = setTimeout(() => endChat(chatId, 'idle_timeout'), idleMs);
    }

  } else {
    // Lobby — ignore commands (handled by bot.command), reply to plain text
    if (text && !text.startsWith('/')) {
      await ctx.reply(WORDS.lobby, lobbyKb());
    }
  }
});

// ─── HELPER FUNCTIONS ─────────────────────────────────────────────────────────
async function doRate(ctx, value) {
  const mapping = tgToAnon[ctx.from.id];
  if (!mapping?.partnerAnon) return ctx.reply('No recent partner to rate.');
  saveRating(mapping.partnerAnon, value);
  const label = value >= 4 ? '⭐ Great rating!' : value >= 2 ? '👍 Decent.' : '💔 Low rating saved.';
  await ctx.reply(`${label} (${value}/5) saved for your partner.`);
}

function buildInterestKb(selectedStr) {
  const selected = selectedStr ? selectedStr.split(',') : [];
  const buttons  = INTEREST_TAGS.map(tag =>
    Markup.button.callback(`${selected.includes(tag) ? '✅' : '○'} ${tag}`, `interest_${tag}`)
  );
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i+2));
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
  const buttons = MOODS.map(m => Markup.button.callback(m, `mood_${m}`));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i+2));
  rows.push([Markup.button.callback('🚫 Clear mood', 'mood_clear')]);
  await ctx.reply('🎭 *Set your mood:*', { parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows) });
}

async function showLanguagePicker(ctx) {
  const buttons = LANGUAGES.map(l => Markup.button.callback(l, `lang_${l.toLowerCase()}`));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i+2));
  await ctx.reply('🌐 *Preferred language:*', { parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows) });
}

async function showLeaderboard(ctx) {
  const top = db.prepare(
    `SELECT anon_id, chat_count, streak_days, total_messages,
     CASE WHEN rating_count > 0 THEN ROUND(CAST(rating_sum AS FLOAT)/rating_count,1) ELSE 0 END as avg_rating
     FROM users ORDER BY chat_count DESC LIMIT 10`
  ).all();
  if (!top.length) return ctx.reply('No users yet!');
  const medals = ['🥇','🥈','🥉'];
  const lines  = top.map((u,i) =>
    `${medals[i] || `${i+1}.`} \`${u.anon_id.slice(0,6)}...\` | 💬 ${u.chat_count} | 🔥 ${u.streak_days}d | ⭐ ${u.avg_rating}`
  ).join('\n');
  await ctx.reply(`📊 *Top Chatters*\n\n${lines}`, { parse_mode: 'Markdown' });
}

async function showReferral(ctx) {
  const s    = ensureSession(ctx);
  const u    = getUser(s.anon_id);
  const link = `https://t.me/${BOT_USERNAME}?start=ref_${u.referral_code}`;
  await ctx.reply(
    `🔗 *Refer & Earn*\n\nShare your link and earn rewards for every friend who joins!\n\n` +
    `Your link:\n\`${link}\`\n\n👥 Friends referred: ${u.referral_count || 0}\n🎁 Every 3 referrals = +1 VIP day`,
    { parse_mode: 'Markdown' }
  );
}

// ─── SHUTDOWN ─────────────────────────────────────────────────────────────────
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  if (db) db.close();
  process.exit(0);
});

// ─── LAUNCH ───────────────────────────────────────────────────────────────────
(async () => {
  await initDB();
  await bot.launch();
  console.log('✅ GhostTalk bot is running!');
  console.log(`Admin IDs: ${ADMIN_IDS.join(', ') || 'none set'}`);
})();
