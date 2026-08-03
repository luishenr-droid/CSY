'use strict';

const http = require('http');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { URL } = require('url');

let PgPool = null;
try {
  ({ Pool: PgPool } = require('pg'));
} catch (error) {
  // O projeto continua funcionando em modo temporário sem PostgreSQL.
}

const PORT = Number(process.env.PORT || 3000);
const IS_PRODUCTION = process.env.NODE_ENV === 'production' || process.env.RENDER === 'true';
const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || '').trim();
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || '');
const DATABASE_URL = String(process.env.DATABASE_URL || '').trim();
const MAX_PARTICIPANTS = 100;
const START_COUNTDOWN_SECONDS = 3;
const ROOM_TTL_MS = 8 * 60 * 60 * 1000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

const rooms = new Map();
const adminSessions = new Map();

const AVATARS = [
  { id: 'astro', name: 'Astronauta', emoji: '🧑‍🚀', colors: ['#00C2FF', '#5547FF'] },
  { id: 'inventor', name: 'Inventor', emoji: '🧑‍🔬', colors: ['#32D7A0', '#00A7E1'] },
  { id: 'hero', name: 'Herói', emoji: '🦸', colors: ['#FF008A', '#6D44FF'] },
  { id: 'ninja', name: 'Ninja', emoji: '🥷', colors: ['#1B1C25', '#5547FF'] },
  { id: 'explorer', name: 'Explorador', emoji: '🧭', colors: ['#FF8A00', '#FF008A'] },
  { id: 'artist', name: 'Artista', emoji: '🎨', colors: ['#FF4D8D', '#FFB000'] },
  { id: 'pilot', name: 'Piloto', emoji: '🧑‍✈️', colors: ['#00A7E1', '#1B1C25'] },
  { id: 'gamer', name: 'Gamer', emoji: '🎮', colors: ['#5547FF', '#FF008A'] },
  { id: 'robot', name: 'Robô', emoji: '🤖', colors: ['#00C2FF', '#A5F3FC'] },
  { id: 'owl', name: 'Coruja', emoji: '🦉', colors: ['#7C3AED', '#FF8A00'] },
  { id: 'fox', name: 'Raposa', emoji: '🦊', colors: ['#FF8A00', '#FF4D8D'] },
  { id: 'lion', name: 'Leão', emoji: '🦁', colors: ['#FFB000', '#FF6A00'] },
  { id: 'panda', name: 'Panda', emoji: '🐼', colors: ['#1B1C25', '#6B7280'] },
  { id: 'unicorn', name: 'Unicórnio', emoji: '🦄', colors: ['#FF008A', '#00C2FF'] },
  { id: 'dragon', name: 'Dragão', emoji: '🐲', colors: ['#17B26A', '#00A7E1'] },
  { id: 'phoenix', name: 'Fênix', emoji: '🔥', colors: ['#FF3B30', '#FFB000'] },
];

const MUSIC_THEMES = [
  { id: 'pulse', name: 'Pulso Cred', description: 'Eletrônica dinâmica e corporativa.' },
  { id: 'upbeat', name: 'Varejo Pop', description: 'Leve, otimista e acelerada.' },
  { id: 'focus', name: 'Foco', description: 'Clima discreto para perguntas difíceis.' },
  { id: 'none', name: 'Sem música', description: 'Somente efeitos de transição.' },
];

const sampleQuiz = {
  id: 'quiz-demo-credsystem',
  title: 'Atendimento que Encanta',
  description: 'Quiz demonstrativo para treinamento corporativo.',
  musicTheme: 'pulse',
  questions: [
    {
      id: crypto.randomUUID(),
      text: 'Qual atitude demonstra escuta ativa no atendimento?',
      options: ['Interromper para acelerar a conversa', 'Ouvir, confirmar o entendimento e responder', 'Repetir o roteiro sem adaptar', 'Evitar perguntas abertas'],
      correctIndex: 1,
      timeLimit: 20,
      explanation: 'Escuta ativa combina atenção, confirmação do entendimento e resposta adequada ao contexto do cliente.',
    },
    {
      id: crypto.randomUUID(),
      text: 'Ao apresentar um benefício, qual abordagem tende a ser mais eficaz?',
      options: ['Falar apenas das características técnicas', 'Relacionar o benefício à necessidade do cliente', 'Usar o mesmo argumento para todos'],
      correctIndex: 1,
      timeLimit: 20,
      explanation: 'O benefício ganha valor quando é conectado a uma necessidade real percebida pelo cliente.',
    },
    {
      id: crypto.randomUUID(),
      text: 'Em uma objeção, o primeiro passo recomendado é:',
      options: ['Discordar imediatamente', 'Encerrar a oferta', 'Investigar o motivo e acolher a dúvida', 'Repetir o preço várias vezes'],
      correctIndex: 2,
      timeLimit: 20,
      explanation: 'Antes de responder, é importante compreender a razão da objeção para oferecer uma solução relevante.',
    },
  ],
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sanitizeText(value, maxLength = 120) {
  return String(value || '').trim().slice(0, maxLength);
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

function makeId(prefix = 'id') {
  return `${prefix}_${crypto.randomUUID()}`;
}

function makeAccessKey() {
  return crypto.randomBytes(8).toString('hex');
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, encoded) {
  const [algorithm, salt, storedHex] = String(encoded || '').split('$');
  if (algorithm !== 'scrypt' || !salt || !storedHex) return false;
  const calculated = crypto.scryptSync(String(password), salt, 64);
  const stored = Buffer.from(storedHex, 'hex');
  return stored.length === calculated.length && crypto.timingSafeEqual(stored, calculated);
}

function normalizeQuiz(rawQuiz) {
  const quiz = rawQuiz && Array.isArray(rawQuiz.questions) ? rawQuiz : sampleQuiz;
  const questions = quiz.questions
    .slice(0, 60)
    .map((question) => {
      const rawOptions = Array.isArray(question.options) ? question.options.slice(0, 6) : [];
      const mappedOptions = rawOptions.map((option, originalIndex) => ({
        text: sanitizeText(option, 220),
        originalIndex,
      })).filter((item) => item.text);
      const originalCorrectIndex = Number(question.correctIndex) || 0;
      let correctIndex = mappedOptions.findIndex((item) => item.originalIndex === originalCorrectIndex);
      if (correctIndex < 0) correctIndex = 0;
      return {
        id: sanitizeText(question.id, 100) || crypto.randomUUID(),
        text: sanitizeText(question.text, 400),
        options: mappedOptions.map((item) => item.text),
        correctIndex,
        timeLimit: Math.max(5, Math.min(Number(question.timeLimit) || 20, 180)),
        explanation: sanitizeText(question.explanation, 800),
      };
    })
    .filter((question) => question.text && question.options.length >= 2);

  return {
    id: sanitizeText(quiz.id, 100) || makeId('quiz'),
    title: sanitizeText(quiz.title, 140) || 'Quiz corporativo',
    description: sanitizeText(quiz.description, 400),
    musicTheme: MUSIC_THEMES.some((item) => item.id === quiz.musicTheme) ? quiz.musicTheme : 'pulse',
    questions: questions.length ? questions : clone(sampleQuiz.questions),
  };
}

class DataStore {
  constructor() {
    this.mode = 'memory';
    this.pool = null;
    this.admins = new Map();
    this.quizzes = new Map();
    this.results = new Map();
  }

  async init() {
    if (DATABASE_URL && PgPool) {
      try {
        this.pool = new PgPool({
          connectionString: DATABASE_URL,
          ssl: IS_PRODUCTION ? { rejectUnauthorized: false } : false,
          max: 5,
          idleTimeoutMillis: 30000,
        });
        await this.pool.query('SELECT 1');
        await this.pool.query(`
          CREATE TABLE IF NOT EXISTS quiz_admins (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            email TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'admin',
            active BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            last_login_at TIMESTAMPTZ
          );
          CREATE TABLE IF NOT EXISTS quizzes (
            id TEXT PRIMARY KEY,
            owner_admin_id TEXT,
            owner_name TEXT,
            title TEXT NOT NULL,
            description TEXT,
            music_theme TEXT NOT NULL DEFAULT 'pulse',
            questions JSONB NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
          CREATE TABLE IF NOT EXISTS quiz_results (
            id TEXT PRIMARY KEY,
            room_code TEXT NOT NULL,
            quiz_id TEXT,
            quiz_title TEXT NOT NULL,
            presenter_name TEXT,
            presenter_email TEXT,
            started_at TIMESTAMPTZ,
            ended_at TIMESTAMPTZ,
            participant_count INTEGER NOT NULL DEFAULT 0,
            payload JSONB NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
        `);
        this.mode = 'postgres';
      } catch (error) {
        console.error('Não foi possível conectar ao PostgreSQL. Usando modo temporário.', error.message);
        this.pool = null;
        this.mode = 'memory';
      }
    }

    if (ADMIN_EMAIL && ADMIN_PASSWORD) {
      const existing = await this.findAdminByEmail(ADMIN_EMAIL);
      if (!existing) {
        await this.createAdmin({
          name: 'Administrador principal',
          email: ADMIN_EMAIL,
          password: ADMIN_PASSWORD,
          role: 'owner',
        });
      }
    }

    const quizzes = await this.listQuizzes();
    if (!quizzes.length) {
      await this.saveQuiz(sampleQuiz, { id: 'system', name: 'Sistema', role: 'owner' });
    }
  }

  async hasAdmins() {
    if (this.mode === 'postgres') {
      const result = await this.pool.query('SELECT COUNT(*)::int AS total FROM quiz_admins WHERE active = TRUE');
      return result.rows[0].total > 0;
    }
    return [...this.admins.values()].some((admin) => admin.active);
  }

  async findAdminByEmail(email) {
    const normalized = String(email || '').trim().toLowerCase();
    if (this.mode === 'postgres') {
      const result = await this.pool.query('SELECT * FROM quiz_admins WHERE LOWER(email) = $1 LIMIT 1', [normalized]);
      return result.rows[0] || null;
    }
    return [...this.admins.values()].find((admin) => admin.email.toLowerCase() === normalized) || null;
  }

  async getAdminById(id) {
    if (this.mode === 'postgres') {
      const result = await this.pool.query('SELECT * FROM quiz_admins WHERE id = $1 LIMIT 1', [id]);
      return result.rows[0] || null;
    }
    return this.admins.get(id) || null;
  }

  async listAdmins() {
    if (this.mode === 'postgres') {
      const result = await this.pool.query('SELECT id, name, email, role, active, created_at, last_login_at FROM quiz_admins ORDER BY created_at ASC');
      return result.rows;
    }
    return [...this.admins.values()].map(({ password_hash, ...admin }) => admin);
  }

  async createAdmin({ name, email, password, role = 'admin' }) {
    const admin = {
      id: makeId('admin'),
      name: sanitizeText(name, 100),
      email: sanitizeText(email, 180).toLowerCase(),
      password_hash: hashPassword(password),
      role: role === 'owner' ? 'owner' : 'admin',
      active: true,
      created_at: new Date().toISOString(),
      last_login_at: null,
    };
    if (this.mode === 'postgres') {
      const result = await this.pool.query(
        `INSERT INTO quiz_admins (id, name, email, password_hash, role, active)
         VALUES ($1,$2,$3,$4,$5,TRUE)
         RETURNING id, name, email, role, active, created_at, last_login_at`,
        [admin.id, admin.name, admin.email, admin.password_hash, admin.role],
      );
      return result.rows[0];
    }
    if ([...this.admins.values()].some((item) => item.email === admin.email)) {
      const error = new Error('Já existe um administrador com este e-mail.');
      error.code = 'DUPLICATE_EMAIL';
      throw error;
    }
    this.admins.set(admin.id, admin);
    const { password_hash, ...publicAdmin } = admin;
    return publicAdmin;
  }

  async updateAdminStatus(id, active) {
    if (this.mode === 'postgres') {
      await this.pool.query('UPDATE quiz_admins SET active = $2 WHERE id = $1', [id, Boolean(active)]);
      return;
    }
    const admin = this.admins.get(id);
    if (admin) admin.active = Boolean(active);
  }

  async updateLastLogin(id) {
    if (this.mode === 'postgres') {
      await this.pool.query('UPDATE quiz_admins SET last_login_at = NOW() WHERE id = $1', [id]);
      return;
    }
    const admin = this.admins.get(id);
    if (admin) admin.last_login_at = new Date().toISOString();
  }

  async listQuizzes() {
    if (this.mode === 'postgres') {
      const result = await this.pool.query('SELECT id, owner_admin_id, owner_name, title, description, music_theme, questions, created_at, updated_at FROM quizzes ORDER BY updated_at DESC');
      return result.rows.map((row) => ({
        id: row.id,
        ownerAdminId: row.owner_admin_id,
        ownerName: row.owner_name,
        title: row.title,
        description: row.description || '',
        musicTheme: row.music_theme,
        questions: row.questions,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
    }
    return [...this.quizzes.values()].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  async getQuiz(id) {
    if (this.mode === 'postgres') {
      const result = await this.pool.query('SELECT * FROM quizzes WHERE id = $1 LIMIT 1', [id]);
      if (!result.rows[0]) return null;
      const row = result.rows[0];
      return {
        id: row.id,
        ownerAdminId: row.owner_admin_id,
        ownerName: row.owner_name,
        title: row.title,
        description: row.description || '',
        musicTheme: row.music_theme,
        questions: row.questions,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    }
    return this.quizzes.get(id) || null;
  }

  async saveQuiz(rawQuiz, admin) {
    const quiz = normalizeQuiz(rawQuiz);
    const existing = await this.getQuiz(quiz.id);
    if (existing && admin.id !== 'system' && admin.role !== 'owner' && existing.ownerAdminId !== admin.id) {
      const error = new Error('Você só pode editar quizzes criados por você.');
      error.code = 'FORBIDDEN';
      throw error;
    }
    const now = new Date().toISOString();
    const record = {
      ...quiz,
      ownerAdminId: existing?.ownerAdminId || admin.id,
      ownerName: existing?.ownerName || admin.name,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    if (this.mode === 'postgres') {
      await this.pool.query(
        `INSERT INTO quizzes (id, owner_admin_id, owner_name, title, description, music_theme, questions, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,NOW(),NOW())
         ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title, description=EXCLUDED.description,
         music_theme=EXCLUDED.music_theme, questions=EXCLUDED.questions, updated_at=NOW()`,
        [record.id, record.ownerAdminId, record.ownerName, record.title, record.description, record.musicTheme, JSON.stringify(record.questions)],
      );
    } else {
      this.quizzes.set(record.id, record);
    }
    return record;
  }

  async deleteQuiz(id, admin) {
    const existing = await this.getQuiz(id);
    if (!existing) return false;
    if (admin.role !== 'owner' && existing.ownerAdminId !== admin.id) {
      const error = new Error('Você só pode excluir quizzes criados por você.');
      error.code = 'FORBIDDEN';
      throw error;
    }
    if (this.mode === 'postgres') {
      await this.pool.query('DELETE FROM quizzes WHERE id = $1', [id]);
    } else {
      this.quizzes.delete(id);
    }
    return true;
  }

  async saveResult(snapshot) {
    const id = snapshot.id || makeId('result');
    snapshot.id = id;
    if (this.mode === 'postgres') {
      await this.pool.query(
        `INSERT INTO quiz_results (id, room_code, quiz_id, quiz_title, presenter_name, presenter_email, started_at, ended_at, participant_count, payload)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
         ON CONFLICT (id) DO UPDATE SET payload=EXCLUDED.payload, ended_at=EXCLUDED.ended_at, participant_count=EXCLUDED.participant_count`,
        [id, snapshot.roomCode, snapshot.quiz.id, snapshot.quiz.title, snapshot.presenter.name, snapshot.presenter.email, snapshot.startedAt, snapshot.endedAt, snapshot.participants.length, JSON.stringify(snapshot)],
      );
    } else {
      this.results.set(id, snapshot);
    }
    return id;
  }

  async getResult(id) {
    if (this.mode === 'postgres') {
      const result = await this.pool.query('SELECT payload FROM quiz_results WHERE id = $1 LIMIT 1', [id]);
      return result.rows[0]?.payload || null;
    }
    return this.results.get(id) || null;
  }
}

const store = new DataStore();
let storeReady = false;
let storeInitError = null;

function isPrivateIpv4(address) {
  if (/^10\./.test(address) || /^192\.168\./.test(address)) return true;
  const match = address.match(/^172\.(\d+)\./);
  return Boolean(match && Number(match[1]) >= 16 && Number(match[1]) <= 31);
}

function getLanIps() {
  const configured = sanitizeText(process.env.HOST_IP, 80);
  const results = [];
  const virtualPattern = /(virtual|vmware|vbox|docker|wsl|hyper-v|vethernet|tailscale|zerotier)/i;
  const preferredPattern = /(wi-?fi|wlan|wireless|ethernet|en0|en1|eth0)/i;
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    for (const entry of entries || []) {
      const family = typeof entry.family === 'string' ? entry.family : String(entry.family);
      if (family !== 'IPv4' && family !== '4') continue;
      if (entry.internal || !entry.address || /^169\.254\./.test(entry.address)) continue;
      let score = 0;
      if (isPrivateIpv4(entry.address)) score += 100;
      if (preferredPattern.test(name)) score += 30;
      if (virtualPattern.test(name)) score -= 80;
      results.push({ name, address: entry.address, score });
    }
  }
  results.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const unique = [...new Map(results.map((item) => [item.address, item])).values()];
  if (configured) return [{ name: 'HOST_IP', address: configured, score: 999 }, ...unique.filter((item) => item.address !== configured)];
  return unique;
}

function getLanIp() {
  return getLanIps()[0]?.address || 'localhost';
}

function getBaseUrl(req) {
  const publicUrl = sanitizeText(process.env.PUBLIC_URL, 300).replace(/\/$/, '');
  if (publicUrl) return publicUrl;
  const protocol = req.headers['x-forwarded-proto'] || 'http';
  const hostHeader = req.headers.host || `localhost:${PORT}`;
  const hostOnly = hostHeader.replace(/^\[/, '').replace(/\].*$/, '').split(':')[0];
  if (['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(hostOnly)) return `http://${getLanIp()}:${PORT}`;
  return `${protocol}://${hostHeader}`;
}

function generateRoomCode() {
  let code;
  do code = String(Math.floor(100000 + Math.random() * 900000));
  while (rooms.has(code));
  return code;
}

function currentQuestion(room) {
  return room.quiz.questions[room.currentQuestionIndex] || null;
}

function getAvatar(id) {
  return AVATARS.find((avatar) => avatar.id === id) || AVATARS[0];
}

function getLeaderboard(room) {
  return [...room.participants.values()]
    .sort((a, b) => b.score - a.score || b.correctAnswers - a.correctAnswers || a.totalResponseMs - b.totalResponseMs || a.joinedAt - b.joinedAt)
    .map((participant, index) => ({
      position: index + 1,
      playerId: participant.id,
      fullName: participant.fullName,
      nickname: participant.nickname,
      avatar: getAvatar(participant.avatarId),
      score: participant.score,
      correctAnswers: participant.correctAnswers,
      online: participant.online,
      lastPoints: participant.lastPoints || 0,
      streak: participant.streak || 0,
    }));
}

function getDistribution(room) {
  const question = currentQuestion(room);
  if (!question) return [];
  return question.options.map((option, index) => ({
    option,
    index,
    count: [...room.answers.values()].filter((answer) => answer.answerIndex === index).length,
    correct: index === question.correctIndex,
  }));
}

function roomSummary(room, includeAdmin = false) {
  const question = currentQuestion(room);
  const summary = {
    roomCode: room.code,
    quizTitle: room.quiz.title,
    quizDescription: room.quiz.description,
    musicTheme: room.musicTheme,
    phase: room.phase,
    currentQuestionIndex: room.currentQuestionIndex,
    totalQuestions: room.quiz.questions.length,
    participantCount: room.participants.size,
    readyCount: [...room.participants.values()].filter((p) => p.ready).length,
    maxParticipants: MAX_PARTICIPANTS,
    responseCount: room.answers.size,
    prizes: room.prizes,
    joinUrl: room.joinUrl,
    screenUrl: room.screenUrl,
    presenterName: room.presenter.name,
    questionStartedAt: room.questionStartedAt,
    countdownStartedAt: room.countdownStartedAt,
    countdownSeconds: START_COUNTDOWN_SECONDS,
    serverNow: Date.now(),
    joinClosed: room.joinClosed,
    resultId: room.resultId || null,
    players: ['lobby', 'countdown'].includes(room.phase)
      ? [...room.participants.values()].map((p) => ({
          playerId: p.id,
          fullName: p.fullName,
          nickname: p.nickname,
          avatar: getAvatar(p.avatarId),
          online: p.online,
          ready: Boolean(p.ready),
        }))
      : [],
    leaderboard: ['ranking', 'finished'].includes(room.phase) ? getLeaderboard(room) : [],
  };

  if (question) {
    summary.question = {
      id: question.id,
      text: question.text,
      options: question.options,
      timeLimit: question.timeLimit,
    };
    if (['answer', 'ranking', 'finished'].includes(room.phase)) {
      summary.question.correctIndex = question.correctIndex;
      summary.question.explanation = question.explanation;
      summary.distribution = getDistribution(room);
    }
  }

  if (room.replacement) {
    summary.replacement = {
      roomCode: room.replacement.code,
      joinUrl: room.replacement.joinUrl,
      screenUrl: room.replacement.screenUrl,
    };
    if (includeAdmin) summary.replacement.adminToken = room.replacement.adminToken;
  }

  if (includeAdmin) {
    summary.question = question ? { ...question } : null;
    summary.participants = [...room.participants.values()].map((p) => ({
      id: p.id,
      fullName: p.fullName,
      nickname: p.nickname,
      avatar: getAvatar(p.avatarId),
      online: p.online,
      ready: Boolean(p.ready),
      joinedAt: p.joinedAt,
      score: p.score,
      correctAnswers: p.correctAnswers,
      totalResponseMs: p.totalResponseMs,
      streak: p.streak,
      lastPoints: p.lastPoints,
      lastCorrect: p.lastCorrect,
    }));
    summary.answers = [...room.answers.values()];
    summary.leaderboard = getLeaderboard(room);
    summary.distribution = getDistribution(room);
  }
  return summary;
}

function playerSelfState(room, participant) {
  const standing = getLeaderboard(room).find((entry) => entry.playerId === participant.id);
  const answer = room.answers.get(participant.id);
  return {
    playerId: participant.id,
    fullName: participant.fullName,
    nickname: participant.nickname,
    avatar: getAvatar(participant.avatarId),
    ready: Boolean(participant.ready),
    score: participant.score,
    correctAnswers: participant.correctAnswers,
    streak: participant.streak,
    lastPoints: participant.lastPoints,
    lastCorrect: participant.lastCorrect,
    position: standing?.position || null,
    answerIndex: answer?.answerIndex ?? null,
    responseMs: answer?.responseMs ?? null,
  };
}

function writeSse(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function sendStateToClient(room, client) {
  if (client.res.writableEnded) return;
  if (client.role === 'admin') {
    if (client.token !== room.adminToken) return;
    writeSse(client.res, 'state', roomSummary(room, true));
  } else if (client.role === 'screen') {
    writeSse(client.res, 'state', roomSummary(room, false));
  } else if (client.role === 'player') {
    const participant = room.participants.get(client.playerId);
    if (!participant || participant.token !== client.token) return;
    writeSse(client.res, 'state', { room: roomSummary(room, false), self: playerSelfState(room, participant) });
  }
}

function broadcastRoom(room, audience = 'all') {
  for (const client of room.clients) {
    if (audience === 'admin-screen' && client.role === 'player') continue;
    sendStateToClient(room, client);
  }
}

function clearQuestionTimer(room) {
  if (room.questionTimer) clearTimeout(room.questionTimer);
  room.questionTimer = null;
}

function revealAnswer(room) {
  if (room.phase !== 'question') return;
  clearQuestionTimer(room);
  room.phase = 'answer';
  broadcastRoom(room);
}

function startQuizCountdown(room) {
  clearQuestionTimer(room);
  room.phase = 'countdown';
  room.joinClosed = true;
  room.countdownStartedAt = Date.now();
  broadcastRoom(room);
  room.questionTimer = setTimeout(() => {
    room.countdownStartedAt = null;
    startQuestion(room, 0);
  }, START_COUNTDOWN_SECONDS * 1000 + 350);
}

function startQuestion(room, index) {
  const question = room.quiz.questions[index];
  if (!question) return false;
  clearQuestionTimer(room);
  room.currentQuestionIndex = index;
  room.phase = 'question';
  room.answers = new Map();
  room.questionStartedAt = Date.now();
  if (!room.startedAt) room.startedAt = new Date().toISOString();
  for (const participant of room.participants.values()) {
    participant.lastPoints = 0;
    participant.lastCorrect = null;
  }
  room.questionTimer = setTimeout(() => revealAnswer(room), question.timeLimit * 1000 + 250);
  broadcastRoom(room);
  return true;
}

function createRoomObject({ baseUrl, quiz, prizes, presenter, musicTheme }) {
  const code = generateRoomCode();
  const accessKey = makeAccessKey();
  const adminToken = crypto.randomUUID();
  return {
    code,
    accessKey,
    adminToken,
    quiz: normalizeQuiz(quiz),
    musicTheme: MUSIC_THEMES.some((item) => item.id === musicTheme) ? musicTheme : (quiz.musicTheme || 'pulse'),
    prizes: {
      first: sanitizeText(prizes?.first, 120) || 'Prêmio do 1º lugar',
      second: sanitizeText(prizes?.second, 120) || 'Prêmio do 2º lugar',
      third: sanitizeText(prizes?.third, 120) || 'Prêmio do 3º lugar',
    },
    presenter: {
      id: presenter.id,
      name: presenter.name,
      email: presenter.email,
    },
    baseUrl,
    joinUrl: `${baseUrl}/?room=${code}&key=${accessKey}`,
    screenUrl: `${baseUrl}/?screen=${code}`,
    phase: 'lobby',
    currentQuestionIndex: -1,
    questionStartedAt: null,
    countdownStartedAt: null,
    questionTimer: null,
    participants: new Map(),
    answers: new Map(),
    clients: new Set(),
    createdAt: Date.now(),
    startedAt: null,
    endedAt: null,
    joinClosed: false,
    replacement: null,
    resultId: null,
  };
}

function buildResultSnapshot(room) {
  return {
    id: room.resultId || makeId('result'),
    roomCode: room.code,
    quiz: clone(room.quiz),
    presenter: clone(room.presenter),
    startedAt: room.startedAt,
    endedAt: room.endedAt,
    prizes: clone(room.prizes),
    musicTheme: room.musicTheme,
    participants: [...room.participants.values()].map((participant) => ({
      id: participant.id,
      fullName: participant.fullName,
      nickname: participant.nickname,
      avatar: getAvatar(participant.avatarId),
      joinedAt: new Date(participant.joinedAt).toISOString(),
      score: participant.score,
      correctAnswers: participant.correctAnswers,
      totalResponseMs: participant.totalResponseMs,
      position: getLeaderboard(room).find((item) => item.playerId === participant.id)?.position || null,
      responses: clone(participant.responses),
    })),
  };
}

async function finishRoom(room) {
  if (room.phase === 'finished') return;
  clearQuestionTimer(room);
  room.phase = 'finished';
  room.joinClosed = true;
  room.endedAt = new Date().toISOString();
  room.accessKey = makeAccessKey();
  const snapshot = buildResultSnapshot(room);
  room.resultId = await store.saveResult(snapshot);

  const replacement = createRoomObject({
    baseUrl: room.baseUrl,
    quiz: room.quiz,
    prizes: room.prizes,
    presenter: room.presenter,
    musicTheme: room.musicTheme,
  });
  rooms.set(replacement.code, replacement);
  room.replacement = {
    code: replacement.code,
    adminToken: replacement.adminToken,
    joinUrl: replacement.joinUrl,
    screenUrl: replacement.screenUrl,
  };
  broadcastRoom(room);
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 3_000_000) {
        reject(new Error('Payload muito grande.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (error) { reject(error); }
    });
    req.on('error', reject);
  });
}

function publicAdmin(admin) {
  return {
    id: admin.id,
    name: admin.name,
    email: admin.email,
    role: admin.role,
    active: admin.active,
    createdAt: admin.created_at || admin.createdAt || null,
    lastLoginAt: admin.last_login_at || admin.lastLoginAt || null,
  };
}

function getAdminSession(token) {
  const session = adminSessions.get(String(token || ''));
  if (!session) return null;
  if (Date.now() - session.createdAt > SESSION_TTL_MS) {
    adminSessions.delete(String(token || ''));
    return null;
  }
  return session;
}

function verifyAdminRoom(room, token) {
  return Boolean(room && token && room.adminToken === token);
}

function makeSession(admin) {
  const authToken = crypto.randomUUID();
  const session = {
    createdAt: Date.now(),
    admin: publicAdmin(admin),
  };
  adminSessions.set(authToken, session);
  return { authToken, admin: session.admin };
}

async function handleApi(req, res, pathname) {
  const body = await readJson(req);

  if (pathname === '/api/public/config') {
    return json(res, 200, {
      ok: true,
      setupRequired: !(await store.hasAdmins()),
      persistenceMode: store.mode,
      maxParticipants: MAX_PARTICIPANTS,
      avatars: AVATARS,
      musicThemes: MUSIC_THEMES,
    });
  }

  if (pathname === '/api/setup/create-admin') {
    if (await store.hasAdmins()) return json(res, 409, { ok: false, message: 'A configuração inicial já foi concluída.' });
    const name = sanitizeText(body.name, 100);
    const email = sanitizeText(body.email, 180).toLowerCase();
    const password = String(body.password || '');
    if (!name || !isValidEmail(email) || password.length < 8) return json(res, 400, { ok: false, message: 'Informe nome, e-mail válido e senha com pelo menos 8 caracteres.' });
    const admin = await store.createAdmin({ name, email, password, role: 'owner' });
    return json(res, 200, { ok: true, ...makeSession(admin), persistenceMode: store.mode });
  }

  if (pathname === '/api/admin/login') {
    const email = sanitizeText(body.email, 180).toLowerCase();
    const admin = await store.findAdminByEmail(email);
    if (!admin || !admin.active || !verifyPassword(body.password, admin.password_hash)) return json(res, 401, { ok: false, message: 'E-mail ou senha inválidos.' });
    await store.updateLastLogin(admin.id);
    return json(res, 200, { ok: true, ...makeSession(admin), persistenceMode: store.mode });
  }

  if (pathname === '/api/admin/session') {
    const session = getAdminSession(body.authToken);
    if (!session) return json(res, 401, { ok: false, message: 'Sessão expirada.' });
    return json(res, 200, { ok: true, admin: session.admin, persistenceMode: store.mode });
  }

  if (pathname === '/api/admin/quizzes') {
    const session = getAdminSession(body.authToken);
    if (!session) return json(res, 401, { ok: false, message: 'Faça login novamente.' });
    return json(res, 200, { ok: true, quizzes: await store.listQuizzes() });
  }

  if (pathname === '/api/admin/save-quiz') {
    const session = getAdminSession(body.authToken);
    if (!session) return json(res, 401, { ok: false, message: 'Faça login novamente.' });
    try {
      const quiz = await store.saveQuiz(body.quiz, session.admin);
      return json(res, 200, { ok: true, quiz });
    } catch (error) {
      return json(res, error.code === 'FORBIDDEN' ? 403 : 400, { ok: false, message: error.message });
    }
  }

  if (pathname === '/api/admin/delete-quiz') {
    const session = getAdminSession(body.authToken);
    if (!session) return json(res, 401, { ok: false, message: 'Faça login novamente.' });
    try {
      await store.deleteQuiz(sanitizeText(body.quizId, 120), session.admin);
      return json(res, 200, { ok: true });
    } catch (error) {
      return json(res, error.code === 'FORBIDDEN' ? 403 : 400, { ok: false, message: error.message });
    }
  }

  if (pathname === '/api/admin/admins') {
    const session = getAdminSession(body.authToken);
    if (!session) return json(res, 401, { ok: false, message: 'Faça login novamente.' });
    return json(res, 200, { ok: true, admins: await store.listAdmins(), persistenceMode: store.mode });
  }

  if (pathname === '/api/admin/create-admin') {
    const session = getAdminSession(body.authToken);
    if (!session) return json(res, 401, { ok: false, message: 'Faça login novamente.' });
    const name = sanitizeText(body.name, 100);
    const email = sanitizeText(body.email, 180).toLowerCase();
    const password = String(body.password || '');
    if (!name || !isValidEmail(email) || password.length < 8) return json(res, 400, { ok: false, message: 'Informe nome, e-mail válido e senha com pelo menos 8 caracteres.' });
    try {
      const admin = await store.createAdmin({ name, email, password, role: 'admin' });
      return json(res, 200, { ok: true, admin });
    } catch (error) {
      return json(res, 409, { ok: false, message: error.code === '23505' || error.code === 'DUPLICATE_EMAIL' ? 'Já existe um administrador com este e-mail.' : error.message });
    }
  }

  if (pathname === '/api/admin/toggle-admin') {
    const session = getAdminSession(body.authToken);
    if (!session || session.admin.role !== 'owner') return json(res, 403, { ok: false, message: 'Somente o administrador principal pode bloquear acessos.' });
    if (body.adminId === session.admin.id) return json(res, 400, { ok: false, message: 'Você não pode bloquear seu próprio acesso.' });
    await store.updateAdminStatus(sanitizeText(body.adminId, 120), Boolean(body.active));
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/admin/create-room') {
    const session = getAdminSession(body.authToken);
    if (!session) return json(res, 401, { ok: false, message: 'Faça login novamente.' });
    const quiz = await store.getQuiz(sanitizeText(body.quizId, 120));
    if (!quiz) return json(res, 404, { ok: false, message: 'Quiz não encontrado.' });
    const room = createRoomObject({
      baseUrl: getBaseUrl(req),
      quiz,
      prizes: body.prizes,
      presenter: session.admin,
      musicTheme: body.musicTheme || quiz.musicTheme,
    });
    rooms.set(room.code, room);
    return json(res, 200, {
      ok: true,
      roomCode: room.code,
      adminToken: room.adminToken,
      joinUrl: room.joinUrl,
      screenUrl: room.screenUrl,
      state: roomSummary(room, true),
    });
  }

  if (pathname === '/api/admin/resume') {
    const room = rooms.get(sanitizeText(body.roomCode, 12));
    if (!verifyAdminRoom(room, body.adminToken)) return json(res, 403, { ok: false, message: 'Sala ou credencial inválida.' });
    return json(res, 200, { ok: true, state: roomSummary(room, true) });
  }

  if (pathname === '/api/admin/command') {
    const room = rooms.get(sanitizeText(body.roomCode, 12));
    if (!verifyAdminRoom(room, body.adminToken)) return json(res, 403, { ok: false, message: 'Acesso negado.' });
    const command = body.command;
    if (command === 'start') {
      if (room.phase !== 'lobby') return json(res, 409, { ok: false, message: 'A sala já foi iniciada.' });
      if (room.participants.size === 0) return json(res, 409, { ok: false, message: 'Aguarde pelo menos um participante entrar.' });
      const notReady = [...room.participants.values()].filter((participant) => !participant.ready);
      if (notReady.length) return json(res, 409, { ok: false, message: `${notReady.length} participante(s) ainda não marcaram que estão prontos.` });
      startQuizCountdown(room);
    } else if (command === 'reveal') {
      if (room.phase !== 'question') return json(res, 409, { ok: false, message: 'Não há pergunta aberta.' });
      revealAnswer(room);
    } else if (command === 'ranking') {
      if (room.phase !== 'answer') return json(res, 409, { ok: false, message: 'Revele a resposta antes do ranking.' });
      room.phase = 'ranking';
      broadcastRoom(room);
    } else if (command === 'next') {
      if (room.phase !== 'ranking') return json(res, 409, { ok: false, message: 'Mostre o ranking antes da próxima pergunta.' });
      const nextIndex = room.currentQuestionIndex + 1;
      if (nextIndex >= room.quiz.questions.length) await finishRoom(room);
      else startQuestion(room, nextIndex);
    } else if (command === 'finish') {
      await finishRoom(room);
    } else if (command === 'reset') {
      clearQuestionTimer(room);
      room.phase = 'lobby';
      room.currentQuestionIndex = -1;
      room.questionStartedAt = null;
      room.countdownStartedAt = null;
      room.answers = new Map();
      room.startedAt = null;
      room.endedAt = null;
      room.joinClosed = false;
      room.replacement = null;
      room.resultId = null;
      for (const p of room.participants.values()) {
        p.score = 0;
        p.correctAnswers = 0;
        p.totalResponseMs = 0;
        p.streak = 0;
        p.lastPoints = 0;
        p.lastCorrect = null;
        p.responses = [];
        p.ready = false;
      }
      broadcastRoom(room);
    } else {
      return json(res, 400, { ok: false, message: 'Comando desconhecido.' });
    }
    return json(res, 200, { ok: true, state: roomSummary(room, true) });
  }

  if (pathname === '/api/admin/kick') {
    const room = rooms.get(sanitizeText(body.roomCode, 12));
    if (!verifyAdminRoom(room, body.adminToken)) return json(res, 403, { ok: false, message: 'Acesso negado.' });
    const participant = room.participants.get(body.playerId);
    if (!participant) return json(res, 404, { ok: false, message: 'Participante não encontrado.' });
    for (const client of [...room.clients]) {
      if (client.role === 'player' && client.playerId === participant.id) {
        writeSse(client.res, 'kicked', { message: 'Removido pelo apresentador.' });
        client.res.end();
        room.clients.delete(client);
      }
    }
    room.participants.delete(participant.id);
    room.answers.delete(participant.id);
    broadcastRoom(room);
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/player/join') {
    const room = rooms.get(sanitizeText(body.roomCode, 12));
    if (!room) return json(res, 404, { ok: false, message: 'Sala não encontrada.' });
    if (room.joinClosed || room.phase !== 'lobby') return json(res, 409, { ok: false, message: 'A entrada nesta sala já foi encerrada.' });
    const providedAccessKey = sanitizeText(body.accessKey, 40);
    if (providedAccessKey && providedAccessKey !== room.accessKey) return json(res, 403, { ok: false, message: 'Link ou QR Code inválido. Solicite o código atualizado ao instrutor.' });
    if (room.participants.size >= MAX_PARTICIPANTS) return json(res, 409, { ok: false, message: `Sala lotada. O limite máximo é de ${MAX_PARTICIPANTS} participantes.` });
    const fullName = sanitizeText(body.fullName, 100);
    const nickname = sanitizeText(body.nickname, 24);
    const avatarId = AVATARS.some((avatar) => avatar.id === body.avatarId) ? body.avatarId : AVATARS[0].id;
    if (!fullName || !nickname) return json(res, 400, { ok: false, message: 'Informe seu nome e apelido.' });
    const duplicated = [...room.participants.values()].some((p) => p.nickname.toLowerCase() === nickname.toLowerCase());
    if (duplicated) return json(res, 409, { ok: false, message: 'Este apelido já está em uso.' });
    const participant = {
      id: crypto.randomUUID(),
      token: crypto.randomUUID(),
      fullName,
      nickname,
      avatarId,
      online: true,
      ready: false,
      joinedAt: Date.now(),
      score: 0,
      correctAnswers: 0,
      totalResponseMs: 0,
      streak: 0,
      lastPoints: 0,
      lastCorrect: null,
      responses: [],
    };
    room.participants.set(participant.id, participant);
    broadcastRoom(room);
    return json(res, 200, {
      ok: true,
      playerId: participant.id,
      playerToken: participant.token,
      state: roomSummary(room, false),
      self: playerSelfState(room, participant),
    });
  }

  if (pathname === '/api/player/resume') {
    const room = rooms.get(sanitizeText(body.roomCode, 12));
    const participant = room?.participants.get(body.playerId);
    if (!room || !participant || participant.token !== body.playerToken) return json(res, 403, { ok: false, message: 'Não foi possível recuperar sua participação.' });
    participant.online = true;
    broadcastRoom(room, 'admin-screen');
    return json(res, 200, { ok: true, state: roomSummary(room, false), self: playerSelfState(room, participant) });
  }


  if (pathname === '/api/player/ready') {
    const room = rooms.get(sanitizeText(body.roomCode, 12));
    const participant = room?.participants.get(body.playerId);
    if (!room || !participant || participant.token !== body.playerToken) return json(res, 403, { ok: false, message: 'Participante inválido.' });
    if (room.phase !== 'lobby') return json(res, 409, { ok: false, message: 'A confirmação de pronto só pode ser alterada antes do início.' });
    participant.ready = Boolean(body.ready);
    broadcastRoom(room);
    return json(res, 200, { ok: true, ready: participant.ready });
  }

  if (pathname === '/api/player/answer') {
    const room = rooms.get(sanitizeText(body.roomCode, 12));
    const participant = room?.participants.get(body.playerId);
    if (!room || !participant || participant.token !== body.playerToken) return json(res, 403, { ok: false, message: 'Participante inválido.' });
    if (room.phase !== 'question') return json(res, 409, { ok: false, message: 'As respostas já foram encerradas.' });
    if (room.answers.has(participant.id)) return json(res, 409, { ok: false, message: 'Você já respondeu.' });
    const question = currentQuestion(room);
    const answerIndex = Number(body.answerIndex);
    if (!Number.isInteger(answerIndex) || answerIndex < 0 || answerIndex >= question.options.length) return json(res, 400, { ok: false, message: 'Resposta inválida.' });
    const responseMs = Math.max(0, Math.min(Date.now() - room.questionStartedAt, question.timeLimit * 1000));
    const correct = answerIndex === question.correctIndex;
    const remainingRatio = Math.max(0, 1 - responseMs / (question.timeLimit * 1000));
    const speedPoints = correct ? Math.round(650 * remainingRatio) : 0;
    const basePoints = correct ? 350 : 0;
    participant.streak = correct ? participant.streak + 1 : 0;
    const streakBonus = correct ? Math.min(participant.streak - 1, 5) * 50 : 0;
    const points = basePoints + speedPoints + streakBonus;
    participant.score += points;
    participant.correctAnswers += correct ? 1 : 0;
    participant.totalResponseMs += responseMs;
    participant.lastPoints = points;
    participant.lastCorrect = correct;
    const response = {
      questionIndex: room.currentQuestionIndex,
      questionId: question.id,
      questionText: question.text,
      answerIndex,
      chosenAnswer: question.options[answerIndex],
      correctIndex: question.correctIndex,
      correctAnswer: question.options[question.correctIndex],
      correct,
      responseMs,
      points,
      answeredAt: new Date().toISOString(),
    };
    participant.responses.push(response);
    room.answers.set(participant.id, {
      playerId: participant.id,
      fullName: participant.fullName,
      nickname: participant.nickname,
      ...response,
    });
    broadcastRoom(room, 'admin-screen');
    return json(res, 200, { ok: true, accepted: true });
  }

  if (pathname === '/api/screen/join') {
    const room = rooms.get(sanitizeText(body.roomCode, 12));
    if (!room) return json(res, 404, { ok: false, message: 'Sala não encontrada.' });
    return json(res, 200, { ok: true, state: roomSummary(room, false) });
  }

  return json(res, 404, { ok: false, message: 'Endpoint não encontrado.' });
}

function handleEvents(req, res, url) {
  const roomCode = sanitizeText(url.searchParams.get('room'), 12);
  const role = sanitizeText(url.searchParams.get('role'), 12);
  const token = sanitizeText(url.searchParams.get('token'), 100);
  const playerId = sanitizeText(url.searchParams.get('playerId'), 100);
  const room = rooms.get(roomCode);
  if (!room) return json(res, 404, { ok: false, message: 'Sala não encontrada.' });
  if (role === 'admin' && token !== room.adminToken) return json(res, 403, { ok: false, message: 'Acesso negado.' });
  if (role === 'player') {
    const participant = room.participants.get(playerId);
    if (!participant || participant.token !== token) return json(res, 403, { ok: false, message: 'Participante inválido.' });
    participant.online = true;
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': conectado\n\n');
  const client = { res, role, token, playerId };
  room.clients.add(client);
  sendStateToClient(room, client);
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => {
    clearInterval(keepAlive);
    room.clients.delete(client);
    if (role === 'player') {
      const participant = room.participants.get(playerId);
      if (participant) {
        participant.online = false;
        setTimeout(() => broadcastRoom(room, 'admin-screen'), 50);
      }
    }
  });
}

function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function excelCell(value, type = 'String', style = '') {
  const styleAttr = style ? ` ss:StyleID="${style}"` : '';
  return `<Cell${styleAttr}><Data ss:Type="${type}">${xmlEscape(value)}</Data></Cell>`;
}

function worksheetXml(name, rows) {
  return `<Worksheet ss:Name="${xmlEscape(name)}"><Table>${rows.map((row) => `<Row>${row.join('')}</Row>`).join('')}</Table><WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel"><FreezePanes/><FrozenNoSplit/><SplitHorizontal>1</SplitHorizontal><TopRowBottomPane>1</TopRowBottomPane></WorksheetOptions></Worksheet>`;
}

function formatDateTime(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(new Date(value));
}

function buildExcelXml(snapshot) {
  const leaderboard = [...snapshot.participants].sort((a, b) => (a.position || 9999) - (b.position || 9999));
  const summaryRows = [
    [excelCell('Campo', 'String', 'Header'), excelCell('Informação', 'String', 'Header')],
    [excelCell('Quiz'), excelCell(snapshot.quiz.title)],
    [excelCell('Código da sala'), excelCell(snapshot.roomCode)],
    [excelCell('Apresentador'), excelCell(snapshot.presenter.name)],
    [excelCell('E-mail do apresentador'), excelCell(snapshot.presenter.email)],
    [excelCell('Data e horário de início'), excelCell(formatDateTime(snapshot.startedAt))],
    [excelCell('Data e horário de término'), excelCell(formatDateTime(snapshot.endedAt))],
    [excelCell('Participantes presentes'), excelCell(snapshot.participants.length, 'Number')],
    [excelCell('Quantidade de questões'), excelCell(snapshot.quiz.questions.length, 'Number')],
  ];

  const participantRows = [[
    excelCell('Posição', 'String', 'Header'),
    excelCell('Nome completo', 'String', 'Header'),
    excelCell('Apelido', 'String', 'Header'),
    excelCell('Avatar', 'String', 'Header'),
    excelCell('Entrada na sala', 'String', 'Header'),
    excelCell('Pontuação', 'String', 'Header'),
    excelCell('Acertos', 'String', 'Header'),
    excelCell('Total de questões', 'String', 'Header'),
    excelCell('Aproveitamento', 'String', 'Header'),
  ]];
  for (const participant of leaderboard) {
    const percentage = snapshot.quiz.questions.length ? Math.round((participant.correctAnswers / snapshot.quiz.questions.length) * 100) : 0;
    participantRows.push([
      excelCell(participant.position || '', participant.position ? 'Number' : 'String'),
      excelCell(participant.fullName),
      excelCell(participant.nickname),
      excelCell(`${participant.avatar.emoji} ${participant.avatar.name}`),
      excelCell(formatDateTime(participant.joinedAt)),
      excelCell(participant.score, 'Number'),
      excelCell(participant.correctAnswers, 'Number'),
      excelCell(snapshot.quiz.questions.length, 'Number'),
      excelCell(`${percentage}%`),
    ]);
  }

  const responseRows = [[
    excelCell('Data e horário', 'String', 'Header'),
    excelCell('Nome completo', 'String', 'Header'),
    excelCell('Apelido', 'String', 'Header'),
    excelCell('Questão nº', 'String', 'Header'),
    excelCell('Pergunta', 'String', 'Header'),
    excelCell('Resposta marcada', 'String', 'Header'),
    excelCell('Resposta correta', 'String', 'Header'),
    excelCell('Resultado', 'String', 'Header'),
    excelCell('Tempo de resposta (s)', 'String', 'Header'),
    excelCell('Pontos', 'String', 'Header'),
  ]];

  for (const participant of leaderboard) {
    const responseMap = new Map(participant.responses.map((response) => [response.questionIndex, response]));
    snapshot.quiz.questions.forEach((question, questionIndex) => {
      const response = responseMap.get(questionIndex);
      responseRows.push([
        excelCell(response ? formatDateTime(response.answeredAt) : ''),
        excelCell(participant.fullName),
        excelCell(participant.nickname),
        excelCell(questionIndex + 1, 'Number'),
        excelCell(question.text),
        excelCell(response?.chosenAnswer || 'Não respondeu'),
        excelCell(question.options[question.correctIndex]),
        excelCell(response ? (response.correct ? 'Correta' : 'Incorreta') : 'Sem resposta'),
        excelCell(response ? (response.responseMs / 1000).toFixed(2) : '', response ? 'Number' : 'String'),
        excelCell(response?.points || 0, 'Number'),
      ]);
    });
  }

  return `<?xml version="1.0"?><?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
<Styles>
<Style ss:ID="Default" ss:Name="Normal"><Alignment ss:Vertical="Bottom"/><Borders/><Font/><Interior/><NumberFormat/><Protection/></Style>
<Style ss:ID="Header"><Font ss:Bold="1" ss:Color="#FFFFFF"/><Interior ss:Color="#1B1C25" ss:Pattern="Solid"/><Alignment ss:Vertical="Center"/></Style>
</Styles>
${worksheetXml('Resumo', summaryRows)}
${worksheetXml('Participantes', participantRows)}
${worksheetXml('Respostas', responseRows)}
</Workbook>`;
}

async function handleReport(req, res, url) {
  const roomCode = sanitizeText(url.searchParams.get('room'), 12);
  const adminToken = sanitizeText(url.searchParams.get('token'), 120);
  const resultId = sanitizeText(url.searchParams.get('result'), 160);
  let snapshot = null;
  if (roomCode) {
    const room = rooms.get(roomCode);
    if (!verifyAdminRoom(room, adminToken)) return json(res, 403, { ok: false, message: 'Acesso negado.' });
    snapshot = room.phase === 'finished' && room.resultId ? await store.getResult(room.resultId) : buildResultSnapshot(room);
  } else if (resultId) {
    const session = getAdminSession(adminToken);
    if (!session) return json(res, 403, { ok: false, message: 'Acesso negado.' });
    snapshot = await store.getResult(resultId);
  }
  if (!snapshot) return json(res, 404, { ok: false, message: 'Relatório não encontrado.' });
  const xml = buildExcelXml(snapshot);
  const safeTitle = snapshot.quiz.title.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'quiz';
  const filename = `${safeTitle}-${snapshot.roomCode}-${new Date().toISOString().slice(0, 10)}.xls`;
  res.writeHead(200, {
    'Content-Type': 'application/vnd.ms-excel; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'no-store',
  });
  res.end(xml);
}

const embeddedFiles = new Map([
  ['/index.html', { type: 'text/html; charset=utf-8', data: Buffer.from('PCFET0NUWVBFIGh0bWw+CjxodG1sIGxhbmc9InB0LUJSIj4KPGhlYWQ+CiAgPG1ldGEgY2hhcnNldD0iVVRGLTgiIC8+CiAgPG1ldGEgbmFtZT0idmlld3BvcnQiIGNvbnRlbnQ9IndpZHRoPWRldmljZS13aWR0aCwgaW5pdGlhbC1zY2FsZT0xLCB2aWV3cG9ydC1maXQ9Y292ZXIiIC8+CiAgPG1ldGEgbmFtZT0idGhlbWUtY29sb3IiIGNvbnRlbnQ9IiMxNzE4MjAiIC8+CiAgPHRpdGxlPlF1aXogQ3JlZHN5c3RlbSDigJQgRWR1Y2HDp8OjbyBjb3Jwb3JhdGl2YSBhbyB2aXZvPC90aXRsZT4KICA8bGluayByZWw9InN0eWxlc2hlZXQiIGhyZWY9InN0eWxlcy5jc3M/dj02LjIuMCIgLz4KPC9oZWFkPgo8Ym9keT4KICA8ZGl2IGlkPSJhcHAiIGNsYXNzPSJhcHAtc2hlbGwiIGFyaWEtbGl2ZT0icG9saXRlIj48L2Rpdj4KICA8ZGl2IGlkPSJ0b2FzdCIgY2xhc3M9InRvYXN0IiByb2xlPSJzdGF0dXMiIGFyaWEtbGl2ZT0icG9saXRlIj48L2Rpdj4KICA8c2NyaXB0IHNyYz0icXJjb2RlLm1pbi5qcz92PTYuMi4wIj48L3NjcmlwdD4KICA8c2NyaXB0IHNyYz0iYXBwLmpzP3Y9Ni4yLjAiPjwvc2NyaXB0Pgo8L2JvZHk+CjwvaHRtbD4K', 'base64') }],
  ['/styles.css', { type: 'text/css; charset=utf-8', data: Buffer.from('OnJvb3QgewogIC0taW5rOiAjMTcxODIwOwogIC0taW5rLTI6ICMyODJBMzU7CiAgLS1tdXRlZDogIzZCNkY3QzsKICAtLXBhbmVsOiAjRkZGRkZGOwogIC0tcGFnZTogI0Y0RjZGQTsKICAtLWxpbmU6ICNEREUxRUE7CiAgLS1jeWFuOiAjMDBDMkZGOwogIC0tYmx1ZTogIzM2NUNGRjsKICAtLXZpb2xldDogIzY1NDdGRjsKICAtLXBpbms6ICNGRjAwOEE7CiAgLS1ncmVlbjogIzE3QjI2QTsKICAtLXJlZDogI0U1NDg0RDsKICAtLXllbGxvdzogI0ZGQjAwMDsKICAtLWdyYWRpZW50OiBsaW5lYXItZ3JhZGllbnQoMTM1ZGVnLCB2YXIoLS1jeWFuKSAwJSwgdmFyKC0tYmx1ZSkgNDIlLCB2YXIoLS12aW9sZXQpIDY4JSwgdmFyKC0tcGluaykgMTAwJSk7CiAgLS1zaGFkb3c6IDAgMjRweCA3MHB4IHJnYmEoMjAsIDIyLCAzMiwgLjE0KTsKICAtLXJhZGl1czogMjRweDsKfQoKKiB7IGJveC1zaXppbmc6IGJvcmRlci1ib3g7IH0KaHRtbCB7IG1pbi1oZWlnaHQ6IDEwMCU7IGJhY2tncm91bmQ6IHZhcigtLXBhZ2UpOyB9CmJvZHkgewogIG1hcmdpbjogMDsKICBtaW4taGVpZ2h0OiAxMDB2aDsKICBmb250LWZhbWlseTogSW50ZXIsIHVpLXNhbnMtc2VyaWYsIHN5c3RlbS11aSwgLWFwcGxlLXN5c3RlbSwgQmxpbmtNYWNTeXN0ZW1Gb250LCAiU2Vnb2UgVUkiLCBzYW5zLXNlcmlmOwogIGNvbG9yOiB2YXIoLS1pbmspOwogIGJhY2tncm91bmQ6CiAgICByYWRpYWwtZ3JhZGllbnQoY2lyY2xlIGF0IDUlIDAlLCByZ2JhKDAsIDE5NCwgMjU1LCAuMTQpLCB0cmFuc3BhcmVudCAyOHJlbSksCiAgICByYWRpYWwtZ3JhZGllbnQoY2lyY2xlIGF0IDk1JSA1JSwgcmdiYSgyNTUsIDAsIDEzOCwgLjEwKSwgdHJhbnNwYXJlbnQgMzByZW0pLAogICAgdmFyKC0tcGFnZSk7Cn0KYnV0dG9uLCBpbnB1dCwgdGV4dGFyZWEsIHNlbGVjdCB7IGZvbnQ6IGluaGVyaXQ7IH0KYnV0dG9uIHsgY3Vyc29yOiBwb2ludGVyOyB9CmEgeyBjb2xvcjogaW5oZXJpdDsgfQoKLmFwcC1zaGVsbCB7IG1pbi1oZWlnaHQ6IDEwMHZoOyB9Ci5jb250YWluZXIgeyB3aWR0aDogbWluKDExODBweCwgY2FsYygxMDAlIC0gMzJweCkpOyBtYXJnaW46IDAgYXV0bzsgcGFkZGluZzogMzBweCAwIDY0cHg7IH0KLmNvbnRhaW5lci5uYXJyb3cgeyB3aWR0aDogbWluKDc2MHB4LCBjYWxjKDEwMCUgLSAyOHB4KSk7IH0KCi50b3BiYXIgewogIG1pbi1oZWlnaHQ6IDc2cHg7CiAgZGlzcGxheTogZmxleDsKICBhbGlnbi1pdGVtczogY2VudGVyOwogIGp1c3RpZnktY29udGVudDogc3BhY2UtYmV0d2VlbjsKICBnYXA6IDE4cHg7CiAgcGFkZGluZzogMTRweCBjbGFtcCgxOHB4LCA0dncsIDU2cHgpOwogIGJhY2tncm91bmQ6IHJnYmEoMjU1LDI1NSwyNTUsLjg4KTsKICBib3JkZXItYm90dG9tOiAxcHggc29saWQgcmdiYSgyMjAsMjI0LDIzMywuOSk7CiAgYmFja2Ryb3AtZmlsdGVyOiBibHVyKDE4cHgpOwogIHBvc2l0aW9uOiBzdGlja3k7CiAgdG9wOiAwOwogIHotaW5kZXg6IDMwOwp9Ci5icmFuZCB7IGRpc3BsYXk6IGlubGluZS1mbGV4OyBhbGlnbi1pdGVtczogY2VudGVyOyBnYXA6IDEycHg7IHRleHQtZGVjb3JhdGlvbjogbm9uZTsgZm9udC13ZWlnaHQ6IDg1MDsgfQouYnJhbmQtc3ltYm9sIHsKICB3aWR0aDogNDZweDsgaGVpZ2h0OiA0NnB4OyBib3JkZXItcmFkaXVzOiA1MCU7IHBvc2l0aW9uOiByZWxhdGl2ZTsgZmxleDogMCAwIGF1dG87CiAgYmFja2dyb3VuZDogY29uaWMtZ3JhZGllbnQoZnJvbSAwZGVnLCB2YXIoLS1jeWFuKSwgdmFyKC0tYmx1ZSksIHZhcigtLXZpb2xldCksIHZhcigtLXBpbmspLCB2YXIoLS1jeWFuKSk7CiAgYm94LXNoYWRvdzogMCAxMHB4IDI0cHggcmdiYSg3MywgNjQsIDI1NSwgLjI4KTsKfQouYnJhbmQtc3ltYm9sOjpiZWZvcmUgeyBjb250ZW50OiAiIjsgcG9zaXRpb246IGFic29sdXRlOyBpbnNldDogOHB4OyBib3JkZXItcmFkaXVzOiA1MCU7IGJhY2tncm91bmQ6IHdoaXRlOyB9Ci5icmFuZC1zeW1ib2w6OmFmdGVyIHsgY29udGVudDogIiI7IHBvc2l0aW9uOiBhYnNvbHV0ZTsgbGVmdDogMDsgdG9wOiAwOyBib3R0b206IDA7IHdpZHRoOiA1MCU7IGJhY2tncm91bmQ6IHZhcigtLWluayk7IGJvcmRlci1yYWRpdXM6IDk5OXB4IDAgMCA5OTlweDsgfQouYnJhbmQtY29weSB7IGRpc3BsYXk6IGdyaWQ7IGdhcDogMXB4OyB9Ci5icmFuZC1jb3B5IHN0cm9uZyB7IGZvbnQtc2l6ZTogMjBweDsgbGV0dGVyLXNwYWNpbmc6IC0uMDNlbTsgfQouYnJhbmQtY29weSBzbWFsbCB7IGNvbG9yOiB2YXIoLS1tdXRlZCk7IGZvbnQtd2VpZ2h0OiA2NTA7IH0KLnRvcC1hY3Rpb25zIHsgZGlzcGxheTogZmxleDsgZ2FwOiAxMHB4OyBhbGlnbi1pdGVtczogY2VudGVyOyBmbGV4LXdyYXA6IHdyYXA7IGp1c3RpZnktY29udGVudDogZmxleC1lbmQ7IH0KCi5oZXJvIHsgZGlzcGxheTogZ3JpZDsgZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOiAxLjA1ZnIgLjk1ZnI7IGdhcDogY2xhbXAoMjhweCwgNnZ3LCA4MHB4KTsgYWxpZ24taXRlbXM6IGNlbnRlcjsgcGFkZGluZzogY2xhbXAoNDBweCwgOHZ3LCA5NnB4KSAwIDcycHg7IH0KLmhlcm8gaDEgeyBtYXJnaW46IDAgMCAxOHB4OyBmb250LXNpemU6IGNsYW1wKDQycHgsIDd2dywgNzhweCk7IGxpbmUtaGVpZ2h0OiAuOTg7IGxldHRlci1zcGFjaW5nOiAtLjA2ZW07IH0KLmhlcm8gaDEgLmdyYWRpZW50LXRleHQgeyBiYWNrZ3JvdW5kOiB2YXIoLS1ncmFkaWVudCk7IC13ZWJraXQtYmFja2dyb3VuZC1jbGlwOiB0ZXh0OyBiYWNrZ3JvdW5kLWNsaXA6IHRleHQ7IGNvbG9yOiB0cmFuc3BhcmVudDsgfQouaGVybyBwIHsgbWFyZ2luOiAwOyBjb2xvcjogdmFyKC0tbXV0ZWQpOyBmb250LXNpemU6IGNsYW1wKDE4cHgsIDJ2dywgMjNweCk7IGxpbmUtaGVpZ2h0OiAxLjU1OyB9Ci5oZXJvLWJhZGdlLCAuZXllYnJvdyB7IGRpc3BsYXk6IGlubGluZS1mbGV4OyBhbGlnbi1pdGVtczogY2VudGVyOyBnYXA6IDhweDsgY29sb3I6ICMzQjM1QjQ7IGJhY2tncm91bmQ6ICNFQ0VCRkY7IGJvcmRlci1yYWRpdXM6IDk5OXB4OyBwYWRkaW5nOiA4cHggMTJweDsgZm9udC1zaXplOiAxM3B4OyBmb250LXdlaWdodDogODUwOyB0ZXh0LXRyYW5zZm9ybTogdXBwZXJjYXNlOyBsZXR0ZXItc3BhY2luZzogLjA5ZW07IG1hcmdpbi1ib3R0b206IDE4cHg7IH0KLmhlcm8tY2FyZCB7IGJhY2tncm91bmQ6IHZhcigtLWluayk7IGNvbG9yOiB3aGl0ZTsgYm9yZGVyLXJhZGl1czogMzRweDsgcGFkZGluZzogMjhweDsgYm94LXNoYWRvdzogdmFyKC0tc2hhZG93KTsgcG9zaXRpb246IHJlbGF0aXZlOyBvdmVyZmxvdzogaGlkZGVuOyB9Ci5oZXJvLWNhcmQ6OmJlZm9yZSB7IGNvbnRlbnQ6ICIiOyBwb3NpdGlvbjogYWJzb2x1dGU7IGluc2V0OiAtMzAlIDM1JSA0NSUgLTIwJTsgYmFja2dyb3VuZDogdmFyKC0tZ3JhZGllbnQpOyBmaWx0ZXI6IGJsdXIoNjBweCk7IG9wYWNpdHk6IC43NTsgfQouaGVyby1jYXJkID4gKiB7IHBvc2l0aW9uOiByZWxhdGl2ZTsgfQoubW9jay1xdWVzdGlvbiB7IGZvbnQtc2l6ZTogMjZweDsgZm9udC13ZWlnaHQ6IDg1MDsgbGluZS1oZWlnaHQ6IDEuMjU7IG1hcmdpbjogMThweCAwIDI0cHg7IH0KLm1vY2stZ3JpZCB7IGRpc3BsYXk6IGdyaWQ7IGdyaWQtdGVtcGxhdGUtY29sdW1uczogMWZyIDFmcjsgZ2FwOiAxMnB4OyB9Ci5tb2NrLW9wdGlvbiB7IG1pbi1oZWlnaHQ6IDc4cHg7IGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IHBhZGRpbmc6IDE0cHg7IGJvcmRlci1yYWRpdXM6IDE4cHg7IGJhY2tncm91bmQ6IHJnYmEoMjU1LDI1NSwyNTUsLjEyKTsgZm9udC13ZWlnaHQ6IDc1MDsgfQoKLmdyaWQtMiB7IGRpc3BsYXk6IGdyaWQ7IGdyaWQtdGVtcGxhdGUtY29sdW1uczogMWZyIDFmcjsgZ2FwOiAyMnB4OyB9Ci5ncmlkLTMgeyBkaXNwbGF5OiBncmlkOyBncmlkLXRlbXBsYXRlLWNvbHVtbnM6IHJlcGVhdCgzLCAxZnIpOyBnYXA6IDE2cHg7IH0KLmdyaWQtNCB7IGRpc3BsYXk6IGdyaWQ7IGdyaWQtdGVtcGxhdGUtY29sdW1uczogcmVwZWF0KDQsIDFmcik7IGdhcDogMTRweDsgfQouY2FyZCB7IGJhY2tncm91bmQ6IHZhcigtLXBhbmVsKTsgYm9yZGVyOiAxcHggc29saWQgdmFyKC0tbGluZSk7IGJvcmRlci1yYWRpdXM6IHZhcigtLXJhZGl1cyk7IHBhZGRpbmc6IGNsYW1wKDIwcHgsIDN2dywgMzBweCk7IGJveC1zaGFkb3c6IDAgMTJweCAzNHB4IHJnYmEoMjIsMjQsMzIsLjA2KTsgfQouY2FyZCBoMSwgLmNhcmQgaDIsIC5jYXJkIGgzIHsgbWFyZ2luLXRvcDogMDsgfQouY2FyZC5pbnRlcmFjdGl2ZSB7IHRyYW5zaXRpb246IHRyYW5zZm9ybSAuMThzIGVhc2UsIGJveC1zaGFkb3cgLjE4cyBlYXNlOyB9Ci5jYXJkLmludGVyYWN0aXZlOmhvdmVyIHsgdHJhbnNmb3JtOiB0cmFuc2xhdGVZKC0zcHgpOyBib3gtc2hhZG93OiB2YXIoLS1zaGFkb3cpOyB9Ci5jYXJkLmRhcmsgeyBiYWNrZ3JvdW5kOiB2YXIoLS1pbmspOyBjb2xvcjogd2hpdGU7IGJvcmRlci1jb2xvcjogdmFyKC0taW5rKTsgfQouY2FyZC5ncmFkaWVudCB7IGJhY2tncm91bmQ6IHZhcigtLWdyYWRpZW50KTsgY29sb3I6IHdoaXRlOyBib3JkZXI6IDA7IH0KLnNvZnQgeyBiYWNrZ3JvdW5kOiAjRjhGOUZDOyBib3gtc2hhZG93OiBub25lOyB9CgouYnRuIHsgYm9yZGVyOiAwOyBib3JkZXItcmFkaXVzOiAxNHB4OyBtaW4taGVpZ2h0OiA0OHB4OyBwYWRkaW5nOiAxMnB4IDE4cHg7IGZvbnQtd2VpZ2h0OiA4MjA7IGRpc3BsYXk6IGlubGluZS1mbGV4OyBhbGlnbi1pdGVtczogY2VudGVyOyBqdXN0aWZ5LWNvbnRlbnQ6IGNlbnRlcjsgZ2FwOiA5cHg7IHRyYW5zaXRpb246IHRyYW5zZm9ybSAuMTVzIGVhc2UsIGZpbHRlciAuMTVzIGVhc2UsIG9wYWNpdHkgLjE1cyBlYXNlOyB0ZXh0LWRlY29yYXRpb246IG5vbmU7IH0KLmJ0bjpob3Zlcjpub3QoOmRpc2FibGVkKSB7IHRyYW5zZm9ybTogdHJhbnNsYXRlWSgtMXB4KTsgZmlsdGVyOiBicmlnaHRuZXNzKDEuMDMpOyB9Ci5idG46ZGlzYWJsZWQgeyBvcGFjaXR5OiAuNDU7IGN1cnNvcjogbm90LWFsbG93ZWQ7IH0KLmJ0bi1wcmltYXJ5IHsgY29sb3I6IHdoaXRlOyBiYWNrZ3JvdW5kOiB2YXIoLS1ncmFkaWVudCk7IGJveC1zaGFkb3c6IDAgMTJweCAyNnB4IHJnYmEoNjgsIDc0LCAyNTUsIC4yMik7IH0KLmJ0bi1kYXJrIHsgYmFja2dyb3VuZDogdmFyKC0taW5rKTsgY29sb3I6IHdoaXRlOyB9Ci5idG4tbGlnaHQgeyBiYWNrZ3JvdW5kOiB3aGl0ZTsgY29sb3I6IHZhcigtLWluayk7IGJvcmRlcjogMXB4IHNvbGlkIHZhcigtLWxpbmUpOyB9Ci5idG4tc3VjY2VzcyB7IGJhY2tncm91bmQ6ICNFMkY4RUI7IGNvbG9yOiAjMDg3NDNEOyB9Ci5idG4tZGFuZ2VyIHsgYmFja2dyb3VuZDogI0ZERUJFQzsgY29sb3I6ICNCNDIzMkE7IH0KLmJ0bi13YXJuaW5nIHsgYmFja2dyb3VuZDogI0ZGRjNENTsgY29sb3I6ICM3QTUyMDA7IH0KLmJ0bi1sYXJnZSB7IG1pbi1oZWlnaHQ6IDU4cHg7IHBhZGRpbmc6IDE1cHggMjRweDsgZm9udC1zaXplOiAxOHB4OyB9Ci5idG4tYmxvY2sgeyB3aWR0aDogMTAwJTsgfQouYnRuLWljb24geyB3aWR0aDogNDZweDsgaGVpZ2h0OiA0NnB4OyBwYWRkaW5nOiAwOyB9CgouZmllbGQgeyBkaXNwbGF5OiBncmlkOyBnYXA6IDhweDsgbWFyZ2luLWJvdHRvbTogMTZweDsgfQouZmllbGQgbGFiZWwgeyBmb250LXdlaWdodDogODAwOyB9Ci5maWVsZCBzbWFsbCB7IGNvbG9yOiB2YXIoLS1tdXRlZCk7IH0KLmlucHV0LCAudGV4dGFyZWEsIC5zZWxlY3QgeyB3aWR0aDogMTAwJTsgYm9yZGVyOiAxcHggc29saWQgdmFyKC0tbGluZSk7IGJvcmRlci1yYWRpdXM6IDE0cHg7IGJhY2tncm91bmQ6IHdoaXRlOyBjb2xvcjogdmFyKC0taW5rKTsgcGFkZGluZzogMTNweCAxNHB4OyBvdXRsaW5lOiBub25lOyB9Ci5pbnB1dDpmb2N1cywgLnRleHRhcmVhOmZvY3VzLCAuc2VsZWN0OmZvY3VzIHsgYm9yZGVyLWNvbG9yOiB2YXIoLS1ibHVlKTsgYm94LXNoYWRvdzogMCAwIDAgNHB4IHJnYmEoNTQsOTIsMjU1LC4xMik7IH0KLnRleHRhcmVhIHsgbWluLWhlaWdodDogOTZweDsgcmVzaXplOiB2ZXJ0aWNhbDsgfQouY29kZS1pbnB1dCB7IHRleHQtYWxpZ246IGNlbnRlcjsgbGV0dGVyLXNwYWNpbmc6IC4xNmVtOyBmb250LXNpemU6IDI4cHg7IGZvbnQtd2VpZ2h0OiA5MDA7IH0KCi50YWJzIHsgZGlzcGxheTogZmxleDsgZ2FwOiA4cHg7IGZsZXgtd3JhcDogd3JhcDsgbWFyZ2luLWJvdHRvbTogMjJweDsgfQoudGFiIHsgYm9yZGVyOiAxcHggc29saWQgdmFyKC0tbGluZSk7IGJhY2tncm91bmQ6IHdoaXRlOyBib3JkZXItcmFkaXVzOiA5OTlweDsgcGFkZGluZzogMTBweCAxNnB4OyBjb2xvcjogdmFyKC0tbXV0ZWQpOyBmb250LXdlaWdodDogODAwOyB9Ci50YWIuYWN0aXZlIHsgY29sb3I6IHdoaXRlOyBiYWNrZ3JvdW5kOiB2YXIoLS1pbmspOyBib3JkZXItY29sb3I6IHZhcigtLWluayk7IH0KCi5ub3RpY2UgeyBwYWRkaW5nOiAxNHB4IDE2cHg7IGJvcmRlci1yYWRpdXM6IDE0cHg7IGJhY2tncm91bmQ6ICNGRkY0RDk7IGNvbG9yOiAjNzI1MTAwOyBib3JkZXI6IDFweCBzb2xpZCAjRjBEMTg1OyBtYXJnaW4tYm90dG9tOiAxOHB4OyB9Ci5ub3RpY2UuaW5mbyB7IGJhY2tncm91bmQ6ICNFQUY3RkY7IGNvbG9yOiAjMDc1QzdBOyBib3JkZXItY29sb3I6ICNCOUU3RkE7IH0KLm5vdGljZS5zdWNjZXNzIHsgYmFja2dyb3VuZDogI0U3RjhFRTsgY29sb3I6ICMwQjZEM0M7IGJvcmRlci1jb2xvcjogI0I5RThDQjsgfQoKLmRhc2hib2FyZCB7IGRpc3BsYXk6IGdyaWQ7IGdyaWQtdGVtcGxhdGUtY29sdW1uczogMjcwcHggMWZyOyBnYXA6IDI0cHg7IGFsaWduLWl0ZW1zOiBzdGFydDsgfQouc2lkZWJhciB7IHBvc2l0aW9uOiBzdGlja3k7IHRvcDogOThweDsgfQouc2lkZWJhci1tZW51IHsgZGlzcGxheTogZ3JpZDsgZ2FwOiA4cHg7IH0KLnNpZGViYXItbWVudSBidXR0b24geyBqdXN0aWZ5LWNvbnRlbnQ6IGZsZXgtc3RhcnQ7IH0KLmFkbWluLXVzZXIgeyBkaXNwbGF5OiBmbGV4OyBhbGlnbi1pdGVtczogY2VudGVyOyBnYXA6IDEycHg7IG1hcmdpbi1ib3R0b206IDIycHg7IH0KLmFkbWluLWF2YXRhciB7IHdpZHRoOiA0OHB4OyBoZWlnaHQ6IDQ4cHg7IGJvcmRlci1yYWRpdXM6IDE2cHg7IGJhY2tncm91bmQ6IHZhcigtLWdyYWRpZW50KTsgY29sb3I6IHdoaXRlOyBkaXNwbGF5OiBncmlkOyBwbGFjZS1pdGVtczogY2VudGVyOyBmb250LXdlaWdodDogOTAwOyB9Ci5hZG1pbi11c2VyIHNtYWxsIHsgY29sb3I6IHZhcigtLW11dGVkKTsgfQouc2VjdGlvbi10aXRsZSB7IGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGp1c3RpZnktY29udGVudDogc3BhY2UtYmV0d2VlbjsgZ2FwOiAxNHB4OyBtYXJnaW4tYm90dG9tOiAxOHB4OyB9Ci5zZWN0aW9uLXRpdGxlIGgxLCAuc2VjdGlvbi10aXRsZSBoMiB7IG1hcmdpbjogMDsgfQoubWV0cmljIHsgcGFkZGluZzogMThweDsgYm9yZGVyLXJhZGl1czogMThweDsgYmFja2dyb3VuZDogd2hpdGU7IGJvcmRlcjogMXB4IHNvbGlkIHZhcigtLWxpbmUpOyB9Ci5tZXRyaWMgc3BhbiB7IGNvbG9yOiB2YXIoLS1tdXRlZCk7IGZvbnQtd2VpZ2h0OiA3MDA7IH0KLm1ldHJpYyBzdHJvbmcgeyBkaXNwbGF5OiBibG9jazsgZm9udC1zaXplOiAzMHB4OyBtYXJnaW4tdG9wOiA2cHg7IH0KLnF1aXotY2FyZCB7IGRpc3BsYXk6IGdyaWQ7IGdhcDogMTVweDsgfQoucXVpei1jYXJkIGgzIHsgbWFyZ2luOiAwOyB9Ci5xdWl6LW1ldGEgeyBkaXNwbGF5OiBmbGV4OyBmbGV4LXdyYXA6IHdyYXA7IGdhcDogOHB4OyBjb2xvcjogdmFyKC0tbXV0ZWQpOyBmb250LXNpemU6IDE0cHg7IH0KLmNoaXAgeyBkaXNwbGF5OiBpbmxpbmUtZmxleDsgYWxpZ24taXRlbXM6IGNlbnRlcjsgZ2FwOiA2cHg7IHBhZGRpbmc6IDdweCAxMHB4OyBib3JkZXItcmFkaXVzOiA5OTlweDsgYmFja2dyb3VuZDogI0YwRjFGNjsgZm9udC1zaXplOiAxM3B4OyBmb250LXdlaWdodDogNzgwOyB9Ci5xdWl6LWFjdGlvbnMgeyBkaXNwbGF5OiBmbGV4OyBnYXA6IDhweDsgZmxleC13cmFwOiB3cmFwOyB9CgouYnVpbGRlci1xdWVzdGlvbiB7IGJvcmRlcjogMXB4IHNvbGlkIHZhcigtLWxpbmUpOyBib3JkZXItcmFkaXVzOiAyMHB4OyBwYWRkaW5nOiAyMHB4OyBiYWNrZ3JvdW5kOiAjRkFGQkZEOyBtYXJnaW4tYm90dG9tOiAxNnB4OyB9Ci5idWlsZGVyLWhlYWQgeyBkaXNwbGF5OiBmbGV4OyBhbGlnbi1pdGVtczogY2VudGVyOyBqdXN0aWZ5LWNvbnRlbnQ6IHNwYWNlLWJldHdlZW47IGdhcDogMTJweDsgbWFyZ2luLWJvdHRvbTogMTRweDsgfQouYnVpbGRlci1oZWFkIGgzIHsgbWFyZ2luOiAwOyB9Ci5vcHRpb24tcm93IHsgZGlzcGxheTogZ3JpZDsgZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOiAzNHB4IDFmcjsgZ2FwOiAxMHB4OyBhbGlnbi1pdGVtczogY2VudGVyOyBtYXJnaW4tYm90dG9tOiA5cHg7IH0KLm9wdGlvbi1yb3cgaW5wdXRbdHlwZT0icmFkaW8iXSB7IHdpZHRoOiAyMHB4OyBoZWlnaHQ6IDIwcHg7IGFjY2VudC1jb2xvcjogdmFyKC0tZ3JlZW4pOyB9Ci5idWlsZGVyLWFjdGlvbnMgeyBkaXNwbGF5OiBmbGV4OyBnYXA6IDEwcHg7IGZsZXgtd3JhcDogd3JhcDsgbWFyZ2luLXRvcDogMThweDsgfQoKLmF2YXRhci1ncmlkIHsgZGlzcGxheTogZ3JpZDsgZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOiByZXBlYXQoNCwgMWZyKTsgZ2FwOiAxMHB4OyB9Ci5hdmF0YXItY2hvaWNlIHsgYm9yZGVyOiAycHggc29saWQgdHJhbnNwYXJlbnQ7IGJvcmRlci1yYWRpdXM6IDE4cHg7IGJhY2tncm91bmQ6IHdoaXRlOyBwYWRkaW5nOiA4cHg7IHRleHQtYWxpZ246IGNlbnRlcjsgfQouYXZhdGFyLWNob2ljZS5zZWxlY3RlZCB7IGJvcmRlci1jb2xvcjogdmFyKC0tYmx1ZSk7IGJveC1zaGFkb3c6IDAgMCAwIDRweCByZ2JhKDU0LDkyLDI1NSwuMTIpOyB9Ci5hdmF0YXItdmlzdWFsIHsgbWluLWhlaWdodDogNzJweDsgYm9yZGVyLXJhZGl1czogMTRweDsgZGlzcGxheTogZ3JpZDsgcGxhY2UtaXRlbXM6IGNlbnRlcjsgZm9udC1zaXplOiAzOHB4OyBjb2xvcjogd2hpdGU7IH0KLmF2YXRhci1jaG9pY2Ugc21hbGwgeyBkaXNwbGF5OiBibG9jazsgbWFyZ2luLXRvcDogN3B4OyBmb250LXdlaWdodDogODAwOyB9CgoucHJlc2VudGVyLXNoZWxsLCAuZ2FtZS1zaGVsbCB7IG1pbi1oZWlnaHQ6IDEwMHZoOyBiYWNrZ3JvdW5kOiB2YXIoLS1pbmspOyBjb2xvcjogd2hpdGU7IH0KLnByZXNlbnRlci1oZWFkZXIsIC5nYW1lLWhlYWRlciB7IG1pbi1oZWlnaHQ6IDc2cHg7IGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGp1c3RpZnktY29udGVudDogc3BhY2UtYmV0d2VlbjsgZ2FwOiAxOHB4OyBwYWRkaW5nOiAxNHB4IGNsYW1wKDE4cHgsNHZ3LDUycHgpOyBib3JkZXItYm90dG9tOiAxcHggc29saWQgcmdiYSgyNTUsMjU1LDI1NSwuMTIpOyBiYWNrZ3JvdW5kOiByZ2JhKDIzLDI0LDMyLC45NCk7IHBvc2l0aW9uOiBzdGlja3k7IHRvcDogMDsgei1pbmRleDogMjU7IH0KLnByZXNlbnRlci1zdGFnZSwgLmdhbWUtc3RhZ2UgeyB3aWR0aDogbWluKDEyMjBweCwgY2FsYygxMDAlIC0gMjhweCkpOyBtYXJnaW46IDAgYXV0bzsgbWluLWhlaWdodDogY2FsYygxMDB2aCAtIDE2MHB4KTsgcGFkZGluZzogMzBweCAwIDEyMHB4OyBkaXNwbGF5OiBncmlkOyBhbGlnbi1jb250ZW50OiBzdGFydDsgZ2FwOiAyMnB4OyB9Ci5wcmVzZW50ZXItbG9iYnkgeyBkaXNwbGF5OiBncmlkOyBncmlkLXRlbXBsYXRlLWNvbHVtbnM6IC45ZnIgMS4xZnI7IGdhcDogMjRweDsgYWxpZ24taXRlbXM6IHN0cmV0Y2g7IH0KLmxvYmJ5LWNvZGUgeyBmb250LXNpemU6IGNsYW1wKDUycHgsIDh2dywgOTZweCk7IGxldHRlci1zcGFjaW5nOiAuMTJlbTsgZm9udC13ZWlnaHQ6IDk1MDsgbGluZS1oZWlnaHQ6IDE7IGJhY2tncm91bmQ6IHZhcigtLWdyYWRpZW50KTsgLXdlYmtpdC1iYWNrZ3JvdW5kLWNsaXA6IHRleHQ7IGJhY2tncm91bmQtY2xpcDogdGV4dDsgY29sb3I6IHRyYW5zcGFyZW50OyB9Ci5xci13cmFwIHsgZGlzcGxheTogaW5saW5lLWZsZXg7IGJhY2tncm91bmQ6IHdoaXRlOyBwYWRkaW5nOiAxNHB4OyBib3JkZXItcmFkaXVzOiAyMnB4OyB9Ci5xci13cmFwIGNhbnZhcywgLnFyLXdyYXAgaW1nIHsgd2lkdGg6IG1pbigyNjBweCwgNjB2dykgIWltcG9ydGFudDsgaGVpZ2h0OiBhdXRvICFpbXBvcnRhbnQ7IGRpc3BsYXk6IGJsb2NrOyB9Ci5wbGF5ZXItY2xvdWQgeyBkaXNwbGF5OiBmbGV4OyBnYXA6IDEwcHg7IGZsZXgtd3JhcDogd3JhcDsgYWxpZ24tY29udGVudDogc3RhcnQ7IH0KLnBsYXllci1waWxsIHsgZGlzcGxheTogaW5saW5lLWZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGdhcDogOXB4OyBwYWRkaW5nOiA5cHggMTNweCA5cHggOXB4OyBiYWNrZ3JvdW5kOiByZ2JhKDI1NSwyNTUsMjU1LC4xKTsgYm9yZGVyOiAxcHggc29saWQgcmdiYSgyNTUsMjU1LDI1NSwuMTIpOyBib3JkZXItcmFkaXVzOiA5OTlweDsgfQoubWluaS1hdmF0YXIgeyB3aWR0aDogMzhweDsgaGVpZ2h0OiAzOHB4OyBib3JkZXItcmFkaXVzOiA1MCU7IGRpc3BsYXk6IGdyaWQ7IHBsYWNlLWl0ZW1zOiBjZW50ZXI7IGZvbnQtc2l6ZTogMjJweDsgfQoKLnF1ZXN0aW9uLXRvcCB7IGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGp1c3RpZnktY29udGVudDogc3BhY2UtYmV0d2VlbjsgZ2FwOiAxOHB4OyB9Ci5xdWVzdGlvbi10aXRsZSB7IGZvbnQtc2l6ZTogY2xhbXAoMjhweCwgNXZ3LCA1OHB4KTsgbGluZS1oZWlnaHQ6IDEuMDg7IHRleHQtYWxpZ246IGNlbnRlcjsgbWFyZ2luOiA4cHggYXV0bzsgbWF4LXdpZHRoOiAxMDUwcHg7IH0KLnRpbWVyIHsgd2lkdGg6IDc2cHg7IGhlaWdodDogNzZweDsgYm9yZGVyLXJhZGl1czogNTAlOyBkaXNwbGF5OiBncmlkOyBwbGFjZS1pdGVtczogY2VudGVyOyBiYWNrZ3JvdW5kOiB3aGl0ZTsgY29sb3I6IHZhcigtLWluayk7IGZvbnQtc2l6ZTogMjdweDsgZm9udC13ZWlnaHQ6IDk1MDsgZmxleDogMCAwIGF1dG87IH0KLmFuc3dlcnMtZ3JpZCB7IGRpc3BsYXk6IGdyaWQ7IGdyaWQtdGVtcGxhdGUtY29sdW1uczogMWZyIDFmcjsgZ2FwOiAxNXB4OyB9Ci5hbnN3ZXItYnRuLCAuYW5zd2VyLWNhcmQgeyBtaW4taGVpZ2h0OiAxMjJweDsgYm9yZGVyOiAwOyBib3JkZXItcmFkaXVzOiAyMnB4OyBjb2xvcjogd2hpdGU7IHBhZGRpbmc6IDIwcHg7IGZvbnQtc2l6ZTogY2xhbXAoMTdweCwyLjJ2dywyNnB4KTsgZm9udC13ZWlnaHQ6IDkwMDsgdGV4dC1hbGlnbjogbGVmdDsgZGlzcGxheTogZmxleDsgYWxpZ24taXRlbXM6IGNlbnRlcjsgZ2FwOiAxM3B4OyB9Ci5hbnN3ZXItYnRuOm50aC1jaGlsZCg2bisxKSwgLmFuc3dlci1jYXJkOm50aC1jaGlsZCg2bisxKSB7IGJhY2tncm91bmQ6ICNEOTNCNTY7IH0KLmFuc3dlci1idG46bnRoLWNoaWxkKDZuKzIpLCAuYW5zd2VyLWNhcmQ6bnRoLWNoaWxkKDZuKzIpIHsgYmFja2dyb3VuZDogIzJGNzhEMTsgfQouYW5zd2VyLWJ0bjpudGgtY2hpbGQoNm4rMyksIC5hbnN3ZXItY2FyZDpudGgtY2hpbGQoNm4rMykgeyBiYWNrZ3JvdW5kOiAjRDk5QTAwOyB9Ci5hbnN3ZXItYnRuOm50aC1jaGlsZCg2bis0KSwgLmFuc3dlci1jYXJkOm50aC1jaGlsZCg2bis0KSB7IGJhY2tncm91bmQ6ICMyMzlDNjg7IH0KLmFuc3dlci1idG46bnRoLWNoaWxkKDZuKzUpLCAuYW5zd2VyLWNhcmQ6bnRoLWNoaWxkKDZuKzUpIHsgYmFja2dyb3VuZDogIzhENDZDODsgfQouYW5zd2VyLWJ0bjpudGgtY2hpbGQoNm4rNiksIC5hbnN3ZXItY2FyZDpudGgtY2hpbGQoNm4rNikgeyBiYWNrZ3JvdW5kOiAjQzQ1QzI2OyB9Ci5hbnN3ZXItYnRuLnNlbGVjdGVkIHsgb3V0bGluZTogNnB4IHNvbGlkIHdoaXRlOyBvdXRsaW5lLW9mZnNldDogLTEwcHg7IH0KLmFuc3dlci1idG4uZGltbWVkLCAuYW5zd2VyLWNhcmQuZGltbWVkIHsgb3BhY2l0eTogLjM7IH0KLmFuc3dlci1jYXJkLmNvcnJlY3QgeyBvdXRsaW5lOiA3cHggc29saWQgd2hpdGU7IG91dGxpbmUtb2Zmc2V0OiAtMTFweDsgfQouc2hhcGUgeyB3aWR0aDogMzRweDsgaGVpZ2h0OiAzNHB4OyBib3JkZXI6IDRweCBzb2xpZCByZ2JhKDI1NSwyNTUsMjU1LC45NSk7IGZsZXg6IDAgMCBhdXRvOyB0cmFuc2Zvcm06IHJvdGF0ZSg0NWRlZyk7IH0KLmFuc3dlci1idG46bnRoLWNoaWxkKGV2ZW4pIC5zaGFwZSwgLmFuc3dlci1jYXJkOm50aC1jaGlsZChldmVuKSAuc2hhcGUgeyBib3JkZXItcmFkaXVzOiA1MCU7IHRyYW5zZm9ybTogbm9uZTsgfQoKLmNvbnRyb2wtZG9jayB7IHBvc2l0aW9uOiBmaXhlZDsgbGVmdDogNTAlOyBib3R0b206IDE4cHg7IHRyYW5zZm9ybTogdHJhbnNsYXRlWCgtNTAlKTsgd2lkdGg6IG1pbigxMDQwcHgsIGNhbGMoMTAwJSAtIDI0cHgpKTsgZGlzcGxheTogZmxleDsgYWxpZ24taXRlbXM6IGNlbnRlcjsganVzdGlmeS1jb250ZW50OiBzcGFjZS1iZXR3ZWVuOyBnYXA6IDEycHg7IHBhZGRpbmc6IDEycHg7IGJvcmRlci1yYWRpdXM6IDIwcHg7IGJhY2tncm91bmQ6IHJnYmEoMjU1LDI1NSwyNTUsLjk0KTsgY29sb3I6IHZhcigtLWluayk7IGJveC1zaGFkb3c6IHZhcigtLXNoYWRvdyk7IHotaW5kZXg6IDQwOyBiYWNrZHJvcC1maWx0ZXI6IGJsdXIoMThweCk7IH0KLmNvbnRyb2wtYWN0aW9ucyB7IGRpc3BsYXk6IGZsZXg7IGdhcDogOHB4OyBmbGV4LXdyYXA6IHdyYXA7IH0KLmNvbnRyb2wtc3RhdHVzIHsgbWluLXdpZHRoOiAxNzBweDsgfQouY29udHJvbC1zdGF0dXMgc3Ryb25nIHsgZGlzcGxheTogYmxvY2s7IH0KLmNvbnRyb2wtc3RhdHVzIHNtYWxsIHsgY29sb3I6IHZhcigtLW11dGVkKTsgfQoKLmRpc3RyaWJ1dGlvbiB7IGRpc3BsYXk6IGdyaWQ7IGdhcDogMTJweDsgYmFja2dyb3VuZDogd2hpdGU7IGNvbG9yOiB2YXIoLS1pbmspOyBib3JkZXItcmFkaXVzOiAyNHB4OyBwYWRkaW5nOiAyMnB4OyB9Ci5kaXN0cmlidXRpb24tcm93IHsgZGlzcGxheTogZ3JpZDsgZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOiBtaW5tYXgoMTIwcHgsIDFmcikgM2ZyIDUwcHg7IGdhcDogMTJweDsgYWxpZ24taXRlbXM6IGNlbnRlcjsgfQouYmFyLXRyYWNrIHsgaGVpZ2h0OiAxNHB4OyBib3JkZXItcmFkaXVzOiA5OTlweDsgYmFja2dyb3VuZDogI0U5RUNGMzsgb3ZlcmZsb3c6IGhpZGRlbjsgfQouYmFyLWZpbGwgeyBoZWlnaHQ6IDEwMCU7IGJvcmRlci1yYWRpdXM6IGluaGVyaXQ7IGJhY2tncm91bmQ6IHZhcigtLWdyYWRpZW50KTsgdHJhbnNpdGlvbjogd2lkdGggLjQ1cyBlYXNlOyB9Ci5kaXN0cmlidXRpb24tcm93LmNvcnJlY3QgLmJhci1maWxsIHsgYmFja2dyb3VuZDogdmFyKC0tZ3JlZW4pOyB9CgoubGVhZGVyYm9hcmQgeyBkaXNwbGF5OiBncmlkOyBnYXA6IDEwcHg7IHdpZHRoOiBtaW4oOTAwcHgsIDEwMCUpOyBtYXJnaW46IDAgYXV0bzsgfQoucmFuay1yb3cgeyBkaXNwbGF5OiBncmlkOyBncmlkLXRlbXBsYXRlLWNvbHVtbnM6IDU1cHggNTJweCAxZnIgYXV0bzsgYWxpZ24taXRlbXM6IGNlbnRlcjsgZ2FwOiAxMnB4OyBwYWRkaW5nOiAxM3B4IDE2cHg7IGJvcmRlci1yYWRpdXM6IDE4cHg7IGJhY2tncm91bmQ6IHdoaXRlOyBjb2xvcjogdmFyKC0taW5rKTsgb3BhY2l0eTogMDsgdHJhbnNmb3JtOiB0cmFuc2xhdGVZKDI0cHgpIHNjYWxlKC45OCk7IH0KLnJhbmstcm93LnJldmVhbGVkIHsgYW5pbWF0aW9uOiByYW5rSW4gLjY1cyBjdWJpYy1iZXppZXIoLjIsLjgsLjIsMSkgZm9yd2FyZHM7IH0KLnJhbmstcm93LnRvcC0xIHsgYmFja2dyb3VuZDogbGluZWFyLWdyYWRpZW50KDEzNWRlZywjRkZGMEE2LCNGRkQ5NTQpOyB9Ci5yYW5rLXJvdy50b3AtMiB7IGJhY2tncm91bmQ6IGxpbmVhci1ncmFkaWVudCgxMzVkZWcsI0Y1RjdGQSwjQ0JEMkRCKTsgfQoucmFuay1yb3cudG9wLTMgeyBiYWNrZ3JvdW5kOiBsaW5lYXItZ3JhZGllbnQoMTM1ZGVnLCNGRkUwQzEsI0RGQTA2Qik7IH0KLnJhbmstcG9zaXRpb24geyBmb250LXNpemU6IDI1cHg7IGZvbnQtd2VpZ2h0OiA5NTA7IHRleHQtYWxpZ246IGNlbnRlcjsgfQoucmFuay1zY29yZSB7IGZvbnQtc2l6ZTogMjFweDsgZm9udC13ZWlnaHQ6IDk1MDsgfQpAa2V5ZnJhbWVzIHJhbmtJbiB7IHRvIHsgb3BhY2l0eTogMTsgdHJhbnNmb3JtOiB0cmFuc2xhdGVZKDApIHNjYWxlKDEpOyB9IH0KCi5zdXNwZW5zZS1vdmVybGF5IHsgcG9zaXRpb246IGZpeGVkOyBpbnNldDogMDsgei1pbmRleDogODA7IGRpc3BsYXk6IGdyaWQ7IHBsYWNlLWl0ZW1zOiBjZW50ZXI7IGJhY2tncm91bmQ6IHJhZGlhbC1ncmFkaWVudChjaXJjbGUsICMyQjJEM0IgMCUsICMwQzBEMTMgNzAlKTsgY29sb3I6IHdoaXRlOyB9Ci5zdXNwZW5zZS1udW1iZXIgeyBmb250LXNpemU6IG1pbigzNXZ3LCAyODBweCk7IGZvbnQtd2VpZ2h0OiAxMDAwOyBiYWNrZ3JvdW5kOiB2YXIoLS1ncmFkaWVudCk7IC13ZWJraXQtYmFja2dyb3VuZC1jbGlwOiB0ZXh0OyBiYWNrZ3JvdW5kLWNsaXA6IHRleHQ7IGNvbG9yOiB0cmFuc3BhcmVudDsgYW5pbWF0aW9uOiBzdXNwZW5zZVB1bHNlIC45cyBlYXNlIGluZmluaXRlOyB9Ci5zdXNwZW5zZS1sYWJlbCB7IHRleHQtYWxpZ246IGNlbnRlcjsgZm9udC1zaXplOiBjbGFtcCgyMnB4LDR2dyw0MnB4KTsgZm9udC13ZWlnaHQ6IDg1MDsgbGV0dGVyLXNwYWNpbmc6IC4wNGVtOyB9CkBrZXlmcmFtZXMgc3VzcGVuc2VQdWxzZSB7IDUwJSB7IHRyYW5zZm9ybTogc2NhbGUoMS4xMik7IGZpbHRlcjogYnJpZ2h0bmVzcygxLjI1KTsgfSB9CgoucG9kaXVtIHsgZGlzcGxheTogZ3JpZDsgZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOiAxZnIgMWZyIDFmcjsgYWxpZ24taXRlbXM6IGVuZDsgZ2FwOiAxNHB4OyB3aWR0aDogbWluKDkwMHB4LDEwMCUpOyBtYXJnaW46IDMwcHggYXV0byAwOyB9Ci5wb2RpdW0tcGxhY2UgeyBkaXNwbGF5OiBncmlkOyBnYXA6IDEwcHg7IHRleHQtYWxpZ246IGNlbnRlcjsgfQoucG9kaXVtLXBsYWNlLmZpcnN0IHsgb3JkZXI6IDI7IH0KLnBvZGl1bS1wbGFjZS5zZWNvbmQgeyBvcmRlcjogMTsgfQoucG9kaXVtLXBsYWNlLnRoaXJkIHsgb3JkZXI6IDM7IH0KLnBvZGl1bS1zdGVwIHsgZGlzcGxheTogZ3JpZDsgcGxhY2UtaXRlbXM6IGNlbnRlcjsgY29sb3I6IHZhcigtLWluayk7IGZvbnQtc2l6ZTogMzhweDsgZm9udC13ZWlnaHQ6IDk1MDsgYm9yZGVyLXJhZGl1czogMjBweCAyMHB4IDAgMDsgfQouZmlyc3QgLnBvZGl1bS1zdGVwIHsgaGVpZ2h0OiAxOTBweDsgYmFja2dyb3VuZDogbGluZWFyLWdyYWRpZW50KDE4MGRlZywjRkZFNzc1LCNGOUI5MUEpOyB9Ci5zZWNvbmQgLnBvZGl1bS1zdGVwIHsgaGVpZ2h0OiAxNDVweDsgYmFja2dyb3VuZDogbGluZWFyLWdyYWRpZW50KDE4MGRlZywjRjJGNUY4LCNBRUI3QzQpOyB9Ci50aGlyZCAucG9kaXVtLXN0ZXAgeyBoZWlnaHQ6IDExMHB4OyBiYWNrZ3JvdW5kOiBsaW5lYXItZ3JhZGllbnQoMTgwZGVnLCNGRkQ2QjIsI0M0N0EzQSk7IH0KLnBvZGl1bS1uYW1lIHsgZm9udC13ZWlnaHQ6IDkwMDsgZm9udC1zaXplOiAxOHB4OyB9Ci5wb2RpdW0tcHJpemUgeyBjb2xvcjogcmdiYSgyNTUsMjU1LDI1NSwuNzIpOyBmb250LXNpemU6IDE0cHg7IH0KCi53YWl0LXNjcmVlbiB7IG1pbi1oZWlnaHQ6IDEwMHZoOyBkaXNwbGF5OiBncmlkOyBwbGFjZS1pdGVtczogY2VudGVyOyBwYWRkaW5nOiAyNHB4OyBiYWNrZ3JvdW5kOiB2YXIoLS1ncmFkaWVudCk7IGNvbG9yOiB3aGl0ZTsgdGV4dC1hbGlnbjogY2VudGVyOyB9Ci53YWl0LWNhcmQgeyB3aWR0aDogbWluKDc2MHB4LDEwMCUpOyB9Ci53YWl0LWNhcmQgaDEgeyBmb250LXNpemU6IGNsYW1wKDM2cHgsOHZ3LDc0cHgpOyBsaW5lLWhlaWdodDogMTsgbWFyZ2luOiAxNHB4IDAgMThweDsgfQouc3Bpbm5lciB7IHdpZHRoOiA2NnB4OyBoZWlnaHQ6IDY2cHg7IGJvcmRlcjogN3B4IHNvbGlkIHJnYmEoMjU1LDI1NSwyNTUsLjI1KTsgYm9yZGVyLXRvcC1jb2xvcjogd2hpdGU7IGJvcmRlci1yYWRpdXM6IDUwJTsgYW5pbWF0aW9uOiBzcGluIC45cyBsaW5lYXIgaW5maW5pdGU7IG1hcmdpbjogMCBhdXRvIDI0cHg7IH0KQGtleWZyYW1lcyBzcGluIHsgdG8geyB0cmFuc2Zvcm06IHJvdGF0ZSgzNjBkZWcpOyB9IH0KCi50b2FzdCB7IHBvc2l0aW9uOiBmaXhlZDsgbGVmdDogNTAlOyBib3R0b206IDI0cHg7IHRyYW5zZm9ybTogdHJhbnNsYXRlKC01MCUsIDEyMHB4KTsgb3BhY2l0eTogMDsgei1pbmRleDogMTAwOyBwYWRkaW5nOiAxM3B4IDE4cHg7IGJhY2tncm91bmQ6IHZhcigtLWluayk7IGNvbG9yOiB3aGl0ZTsgYm9yZGVyLXJhZGl1czogMTRweDsgZm9udC13ZWlnaHQ6IDgwMDsgYm94LXNoYWRvdzogdmFyKC0tc2hhZG93KTsgdHJhbnNpdGlvbjogLjI1cyBlYXNlOyBwb2ludGVyLWV2ZW50czogbm9uZTsgbWF4LXdpZHRoOiBjYWxjKDEwMCUgLSAyOHB4KTsgdGV4dC1hbGlnbjogY2VudGVyOyB9Ci50b2FzdC5zaG93IHsgdHJhbnNmb3JtOiB0cmFuc2xhdGUoLTUwJSwwKTsgb3BhY2l0eTogMTsgfQouZW1wdHkgeyBwYWRkaW5nOiAyNnB4OyBib3JkZXI6IDFweCBkYXNoZWQgdmFyKC0tbGluZSk7IGJvcmRlci1yYWRpdXM6IDE4cHg7IHRleHQtYWxpZ246IGNlbnRlcjsgY29sb3I6IHZhcigtLW11dGVkKTsgfQouaGlkZGVuIHsgZGlzcGxheTogbm9uZSAhaW1wb3J0YW50OyB9Ci5tdXRlZCB7IGNvbG9yOiB2YXIoLS1tdXRlZCk7IH0KLndoaXRlLW11dGVkIHsgY29sb3I6IHJnYmEoMjU1LDI1NSwyNTUsLjcyKTsgfQoucm93IHsgZGlzcGxheTogZmxleDsgZ2FwOiAxMHB4OyBhbGlnbi1pdGVtczogY2VudGVyOyBmbGV4LXdyYXA6IHdyYXA7IH0KLnNwYWNlLWJldHdlZW4geyBqdXN0aWZ5LWNvbnRlbnQ6IHNwYWNlLWJldHdlZW47IH0KLnRleHQtY2VudGVyIHsgdGV4dC1hbGlnbjogY2VudGVyOyB9Ci5tdC0wIHsgbWFyZ2luLXRvcDogMDsgfQoubWItMCB7IG1hcmdpbi1ib3R0b206IDA7IH0KCkBtZWRpYSAobWF4LXdpZHRoOiA5MjBweCkgewogIC5oZXJvLCAuZGFzaGJvYXJkLCAucHJlc2VudGVyLWxvYmJ5IHsgZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOiAxZnI7IH0KICAuc2lkZWJhciB7IHBvc2l0aW9uOiBzdGF0aWM7IH0KICAuc2lkZWJhci1tZW51IHsgZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOiByZXBlYXQoMywxZnIpOyB9CiAgLnNpZGViYXItbWVudSAuYnRuIHsganVzdGlmeS1jb250ZW50OiBjZW50ZXI7IGZvbnQtc2l6ZTogMTNweDsgcGFkZGluZy1pbmxpbmU6IDhweDsgfQogIC5ncmlkLTMsIC5ncmlkLTQgeyBncmlkLXRlbXBsYXRlLWNvbHVtbnM6IDFmciAxZnI7IH0KfQoKQG1lZGlhIChtYXgtd2lkdGg6IDY1MHB4KSB7CiAgLmJyYW5kLWNvcHkgc21hbGwgeyBkaXNwbGF5OiBub25lOyB9CiAgLnRvcGJhciB7IGFsaWduLWl0ZW1zOiBmbGV4LXN0YXJ0OyB9CiAgLmdyaWQtMiwgLmdyaWQtMywgLmdyaWQtNCwgLmFuc3dlcnMtZ3JpZCB7IGdyaWQtdGVtcGxhdGUtY29sdW1uczogMWZyOyB9CiAgLm1vY2stZ3JpZCB7IGdyaWQtdGVtcGxhdGUtY29sdW1uczogMWZyOyB9CiAgLmF2YXRhci1ncmlkIHsgZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOiByZXBlYXQoMywxZnIpOyB9CiAgLmFuc3dlci1idG4sIC5hbnN3ZXItY2FyZCB7IG1pbi1oZWlnaHQ6IDkwcHg7IH0KICAucHJlc2VudGVyLXN0YWdlLCAuZ2FtZS1zdGFnZSB7IHBhZGRpbmctYm90dG9tOiAxNzBweDsgfQogIC5jb250cm9sLWRvY2sgeyBhbGlnbi1pdGVtczogc3RyZXRjaDsgZmxleC1kaXJlY3Rpb246IGNvbHVtbjsgfQogIC5jb250cm9sLWFjdGlvbnMgeyBkaXNwbGF5OiBncmlkOyBncmlkLXRlbXBsYXRlLWNvbHVtbnM6IDFmciAxZnI7IH0KICAuY29udHJvbC1hY3Rpb25zIC5idG4geyBtaW4td2lkdGg6IDA7IH0KICAuZGlzdHJpYnV0aW9uLXJvdyB7IGdyaWQtdGVtcGxhdGUtY29sdW1uczogMWZyOyBnYXA6IDVweDsgfQogIC5yYW5rLXJvdyB7IGdyaWQtdGVtcGxhdGUtY29sdW1uczogNDJweCA0NHB4IDFmcjsgfQogIC5yYW5rLXNjb3JlIHsgZ3JpZC1jb2x1bW46IDM7IH0KICAucG9kaXVtIHsgZ2FwOiA2cHg7IH0KICAucG9kaXVtLW5hbWUgeyBmb250LXNpemU6IDEzcHg7IH0KICAuZmlyc3QgLnBvZGl1bS1zdGVwIHsgaGVpZ2h0OiAxNTBweDsgfQogIC5zZWNvbmQgLnBvZGl1bS1zdGVwIHsgaGVpZ2h0OiAxMTBweDsgfQogIC50aGlyZCAucG9kaXVtLXN0ZXAgeyBoZWlnaHQ6IDg1cHg7IH0KfQoKCi8qID09PT09IEFqdXN0ZXMgNi4xOiBpbsOtY2lvIG3DrW5pbW8sIGFwcmVzZW50YcOnw6NvIGxpbXBhIGUgw6F1ZGlvIGRlc2Jsb3F1ZcOhdmVsID09PT09ICovCi5taW5pbWFsLWhvbWUgewogIG1pbi1oZWlnaHQ6IDEwMHZoOwogIGRpc3BsYXk6IGdyaWQ7CiAgcGxhY2UtaXRlbXM6IGNlbnRlcjsKICBwYWRkaW5nOiAyNHB4OwogIGJhY2tncm91bmQ6CiAgICByYWRpYWwtZ3JhZGllbnQoY2lyY2xlIGF0IDE1JSAxMCUsIHJnYmEoMCwxOTQsMjU1LC4xNCksIHRyYW5zcGFyZW50IDI0cmVtKSwKICAgIHJhZGlhbC1ncmFkaWVudChjaXJjbGUgYXQgOTAlIDUlLCByZ2JhKDI1NSwwLDEzOCwuMTApLCB0cmFuc3BhcmVudCAyNnJlbSksCiAgICB2YXIoLS1wYWdlKTsKfQoubWluaW1hbC1ob21lLWNhcmQgewogIHdpZHRoOiBtaW4oNTIwcHgsIDEwMCUpOwogIGRpc3BsYXk6IGdyaWQ7CiAgZ2FwOiAyNHB4OwogIHBhZGRpbmc6IGNsYW1wKDI0cHgsIDV2dywgNDJweCk7CiAgYm9yZGVyOiAxcHggc29saWQgdmFyKC0tbGluZSk7CiAgYm9yZGVyLXJhZGl1czogMjhweDsKICBiYWNrZ3JvdW5kOiByZ2JhKDI1NSwyNTUsMjU1LC45NCk7CiAgYm94LXNoYWRvdzogMCAyMnB4IDcwcHggcmdiYSgyMCwyMiwzMiwuMTApOwp9Ci5taW5pbWFsLWhvbWUtY2FyZCAuYnJhbmQgeyBqdXN0aWZ5LXNlbGY6IGNlbnRlcjsgfQoubWluaW1hbC1ob21lLWNvcHkgeyB0ZXh0LWFsaWduOiBjZW50ZXI7IH0KLm1pbmltYWwtaG9tZS1jb3B5IGgxIHsgbWFyZ2luOiAwIDAgOHB4OyBmb250LXNpemU6IGNsYW1wKDMycHgsIDd2dywgNTJweCk7IGxldHRlci1zcGFjaW5nOiAtLjA0NWVtOyB9Ci5taW5pbWFsLWhvbWUtY29weSBwIHsgbWFyZ2luOiAwOyBjb2xvcjogdmFyKC0tbXV0ZWQpOyB9Ci5taW5pbWFsLWNvZGUtcm93IHsgZGlzcGxheTogZ3JpZDsgZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOiAxZnIgYXV0bzsgZ2FwOiAxMHB4OyB9Ci5taW5pbWFsLWNvZGUtcm93IC5jb2RlLWlucHV0IHsgbWluLWhlaWdodDogNThweDsgfQoubWluaW1hbC1jb2RlLXJvdyAuYnRuIHsgbWluLXdpZHRoOiAxMjBweDsgfQoubWluaW1hbC1hZG1pbi1saW5rIHsgYm9yZGVyOiAwOyBiYWNrZ3JvdW5kOiB0cmFuc3BhcmVudDsgY29sb3I6IHZhcigtLW11dGVkKTsgZm9udC13ZWlnaHQ6IDgwMDsgdGV4dC1kZWNvcmF0aW9uOiB1bmRlcmxpbmU7IHRleHQtdW5kZXJsaW5lLW9mZnNldDogNHB4OyB9CgoucHJlc2VudGVyLWhlYWRlciB7CiAgbWluLWhlaWdodDogNTJweDsKICBoZWlnaHQ6IDUycHg7CiAgcGFkZGluZzogN3B4IGNsYW1wKDE0cHgsIDIuNHZ3LCAzMHB4KTsKICBwb3NpdGlvbjogcmVsYXRpdmU7Cn0KLnByZXNlbnRlci1icmFuZCB7IGRpc3BsYXk6IGlubGluZS1mbGV4OyBhbGlnbi1pdGVtczogY2VudGVyOyBnYXA6IDlweDsgZm9udC1zaXplOiAxNXB4OyB9Ci5wcmVzZW50ZXItYnJhbmQtbWFyayB7IHdpZHRoOiAyMHB4OyBoZWlnaHQ6IDIwcHg7IGJvcmRlci1yYWRpdXM6IDUwJTsgYmFja2dyb3VuZDogdmFyKC0tZ3JhZGllbnQpOyBib3gtc2hhZG93OiAwIDAgMCA0cHggcmdiYSgyNTUsMjU1LDI1NSwuMDgpOyB9Ci5wcmVzZW50ZXItaGVhZGVyLW1ldGEgeyBkaXNwbGF5OiBmbGV4OyBhbGlnbi1pdGVtczogY2VudGVyOyBnYXA6IDEycHg7IGNvbG9yOiByZ2JhKDI1NSwyNTUsMjU1LC42OCk7IGZvbnQtc2l6ZTogMTNweDsgZm9udC13ZWlnaHQ6IDc1MDsgfQoucHJlc2VudGVyLWF1ZGlvLWJ1dHRvbiB7IG1pbi1oZWlnaHQ6IDM0cHg7IGJvcmRlcjogMXB4IHNvbGlkIHJnYmEoMjU1LDI1NSwyNTUsLjE4KTsgYm9yZGVyLXJhZGl1czogMTBweDsgcGFkZGluZzogNnB4IDEwcHg7IGJhY2tncm91bmQ6IHJnYmEoMjU1LDI1NSwyNTUsLjA4KTsgY29sb3I6IHdoaXRlOyBmb250LXdlaWdodDogODAwOyB9Ci5wcmVzZW50ZXItc3RhZ2UgewogIHdpZHRoOiBtaW4oMTI0MHB4LCBjYWxjKDEwMCUgLSAyNHB4KSk7CiAgbWluLWhlaWdodDogY2FsYygxMDB2aCAtIDExMnB4KTsKICBwYWRkaW5nOiAxNHB4IDAgNzhweDsKICBnYXA6IDEycHg7Cn0KLnByZXNlbnRlci1zdGFnZSAucXVlc3Rpb24tdG9wIHsgbWluLWhlaWdodDogNDhweDsgY29sb3I6IHJnYmEoMjU1LDI1NSwyNTUsLjcyKTsgZm9udC1zaXplOiAxNHB4OyBmb250LXdlaWdodDogODAwOyB9Ci5wcmVzZW50ZXItc3RhZ2UgLnRpbWVyIHsgd2lkdGg6IDUwcHg7IGhlaWdodDogNTBweDsgZm9udC1zaXplOiAyMHB4OyB9Ci5wcmVzZW50ZXItc3RhZ2UgLnF1ZXN0aW9uLXRpdGxlIHsgZm9udC1zaXplOiBjbGFtcCgyNHB4LCAzLjR2dywgNDNweCk7IGxpbmUtaGVpZ2h0OiAxLjA4OyBtYXJnaW46IDAgYXV0byA0cHg7IG1heC13aWR0aDogMTEyMHB4OyB9Ci5wcmVzZW50ZXItYW5zd2VycyB7IGdhcDogMTBweDsgYWxpZ24tY29udGVudDogc3RhcnQ7IH0KLnByZXNlbnRlci1hbnN3ZXJzIC5hbnN3ZXItY2FyZCB7IG1pbi1oZWlnaHQ6IDc2cHg7IGJvcmRlci1yYWRpdXM6IDE1cHg7IHBhZGRpbmc6IDEzcHggMTZweDsgZm9udC1zaXplOiBjbGFtcCgxNXB4LCAxLjY1dncsIDIxcHgpOyBnYXA6IDEwcHg7IH0KLnByZXNlbnRlci1hbnN3ZXJzIC5zaGFwZSB7IHdpZHRoOiAyNHB4OyBoZWlnaHQ6IDI0cHg7IGJvcmRlci13aWR0aDogM3B4OyB9Ci5wcmVzZW50ZXItYW5zd2Vycy5jb3VudC0yIC5hbnN3ZXItY2FyZCB7IG1pbi1oZWlnaHQ6IDEyMHB4OyB9Ci5wcmVzZW50ZXItYW5zd2Vycy5jb3VudC0zIHsgZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOiByZXBlYXQoMywgMWZyKTsgfQoucHJlc2VudGVyLWFuc3dlcnMuY291bnQtMyAuYW5zd2VyLWNhcmQgeyBtaW4taGVpZ2h0OiAxMTVweDsgfQouY29tcGFjdC1zZWN0aW9uLXRpdGxlIHsgZGlzcGxheTogZmxleDsgYWxpZ24taXRlbXM6IGNlbnRlcjsganVzdGlmeS1jb250ZW50OiBzcGFjZS1iZXR3ZWVuOyBnYXA6IDEycHg7IGZvbnQtc2l6ZTogMTVweDsgY29sb3I6IHJnYmEoMjU1LDI1NSwyNTUsLjcpOyB9Ci5jb21wYWN0LXNlY3Rpb24tdGl0bGUgc3BhbiB7IGZvbnQtc2l6ZTogY2xhbXAoMjJweCwgM3Z3LCAzNHB4KTsgZm9udC13ZWlnaHQ6IDkwMDsgY29sb3I6IHdoaXRlOyB9Ci5jb21wYWN0LWRpc3RyaWJ1dGlvbiB7IGdhcDogOHB4OyBib3JkZXItcmFkaXVzOiAxNnB4OyBwYWRkaW5nOiAxNHB4IDE2cHg7IH0KLmNvbXBhY3QtZGlzdHJpYnV0aW9uIC5kaXN0cmlidXRpb24tcm93IHsgZm9udC1zaXplOiAxM3B4OyB9Ci5jb21wYWN0LWRpc3RyaWJ1dGlvbiAuYmFyLXRyYWNrIHsgaGVpZ2h0OiAxMHB4OyB9Ci5wcmVzZW50ZXItZXhwbGFuYXRpb24geyBwYWRkaW5nOiAxMXB4IDE0cHg7IGJvcmRlci1yYWRpdXM6IDEzcHg7IGJhY2tncm91bmQ6IHJnYmEoMjU1LDI1NSwyNTUsLjA5KTsgY29sb3I6IHJnYmEoMjU1LDI1NSwyNTUsLjgyKTsgZm9udC1zaXplOiAxNHB4OyB9Ci5wcmVzZW50ZXItcmFua2luZy1zdGFnZSAubGVhZGVyYm9hcmQgeyBnYXA6IDdweDsgfQoucHJlc2VudGVyLXJhbmtpbmctc3RhZ2UgLnJhbmstcm93IHsgcGFkZGluZzogOXB4IDEzcHg7IGJvcmRlci1yYWRpdXM6IDEzcHg7IH0KLnByZXNlbnRlci1yYW5raW5nLXN0YWdlIC5taW5pLWF2YXRhciB7IHdpZHRoOiAzNHB4OyBoZWlnaHQ6IDM0cHg7IGZvbnQtc2l6ZTogMTlweDsgfQoucHJlc2VudGVyLXJhbmtpbmctc3RhZ2UgLnJhbmstcG9zaXRpb24geyBmb250LXNpemU6IDIwcHg7IH0KLnByZXNlbnRlci1yYW5raW5nLXN0YWdlIC5yYW5rLXNjb3JlIHsgZm9udC1zaXplOiAxOHB4OyB9Ci5jb250cm9sLWRvY2sgewogIGJvdHRvbTogOHB4OwogIHdpZHRoOiBtaW4oMTA2MHB4LCBjYWxjKDEwMCUgLSAxNnB4KSk7CiAgcGFkZGluZzogOHB4IDEwcHg7CiAgYm9yZGVyLXJhZGl1czogMTRweDsKICBib3gtc2hhZG93OiAwIDE0cHggMzhweCByZ2JhKDAsMCwwLC4yNCk7Cn0KLmNvbnRyb2wtZG9jayAuYnRuIHsgbWluLWhlaWdodDogNDBweDsgcGFkZGluZzogOHB4IDEzcHg7IGJvcmRlci1yYWRpdXM6IDEwcHg7IGZvbnQtc2l6ZTogMTNweDsgfQouY29udHJvbC1zdGF0dXMgc3Ryb25nIHsgZm9udC1zaXplOiAxM3B4OyBtYXgtd2lkdGg6IDM2MHB4OyB3aGl0ZS1zcGFjZTogbm93cmFwOyBvdmVyZmxvdzogaGlkZGVuOyB0ZXh0LW92ZXJmbG93OiBlbGxpcHNpczsgfQouY29udHJvbC1zdGF0dXMgc21hbGwgeyBmb250LXNpemU6IDEycHg7IH0KCi5hdWRpby1nYXRlIHsgcG9zaXRpb246IGZpeGVkOyBpbnNldDogMDsgei1pbmRleDogMTIwOyBkaXNwbGF5OiBncmlkOyBwbGFjZS1pdGVtczogY2VudGVyOyBwYWRkaW5nOiAyMnB4OyBiYWNrZ3JvdW5kOiByZ2JhKDgsOSwxNCwuODQpOyBiYWNrZHJvcC1maWx0ZXI6IGJsdXIoMTRweCk7IH0KLmF1ZGlvLWdhdGUtY2FyZCB7IHdpZHRoOiBtaW4oNDMwcHgsIDEwMCUpOyBwYWRkaW5nOiAyOHB4OyBib3JkZXItcmFkaXVzOiAyNHB4OyBiYWNrZ3JvdW5kOiB3aGl0ZTsgY29sb3I6IHZhcigtLWluayk7IHRleHQtYWxpZ246IGNlbnRlcjsgYm94LXNoYWRvdzogMCAzMHB4IDkwcHggcmdiYSgwLDAsMCwuMzUpOyB9Ci5hdWRpby1nYXRlLW1hcmsgeyB3aWR0aDogNThweDsgaGVpZ2h0OiA1OHB4OyBtYXJnaW46IDAgYXV0byAxNnB4OyBkaXNwbGF5OiBncmlkOyBwbGFjZS1pdGVtczogY2VudGVyOyBib3JkZXItcmFkaXVzOiA1MCU7IGJhY2tncm91bmQ6IHZhcigtLWdyYWRpZW50KTsgY29sb3I6IHdoaXRlOyBmb250LXNpemU6IDI4cHg7IGZvbnQtd2VpZ2h0OiA5MDA7IH0KLmF1ZGlvLWdhdGUtY2FyZCBoMiB7IG1hcmdpbjogMCAwIDhweDsgfQouYXVkaW8tZ2F0ZS1jYXJkIHAgeyBtYXJnaW46IDAgMCAyMHB4OyBjb2xvcjogdmFyKC0tbXV0ZWQpOyB9Ci5hdWRpby1nYXRlLWNhcmQgLmJ0biArIC5idG4geyBtYXJnaW4tdG9wOiA5cHg7IH0KCkBtZWRpYSAobWF4LXdpZHRoOiA3NjBweCkgewogIC5taW5pbWFsLWNvZGUtcm93IHsgZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOiAxZnI7IH0KICAubWluaW1hbC1jb2RlLXJvdyAuYnRuIHsgd2lkdGg6IDEwMCU7IH0KICAucHJlc2VudGVyLWhlYWRlci1tZXRhID4gc3BhbiB7IGRpc3BsYXk6IG5vbmU7IH0KICAucHJlc2VudGVyLXN0YWdlIHsgcGFkZGluZy1ib3R0b206IDEyMnB4OyB9CiAgLnByZXNlbnRlci1hbnN3ZXJzLmNvdW50LTMgeyBncmlkLXRlbXBsYXRlLWNvbHVtbnM6IDFmcjsgfQogIC5wcmVzZW50ZXItYW5zd2Vycy5jb3VudC0zIC5hbnN3ZXItY2FyZCB7IG1pbi1oZWlnaHQ6IDc0cHg7IH0KICAuY29udHJvbC1kb2NrIHsgYWxpZ24taXRlbXM6IHN0cmV0Y2g7IGZsZXgtZGlyZWN0aW9uOiBjb2x1bW47IH0KICAuY29udHJvbC1hY3Rpb25zIHsgZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOiAxZnIgMWZyOyBkaXNwbGF5OiBncmlkOyB9Cn0KCkBtZWRpYSAobWF4LWhlaWdodDogNzYwcHgpIGFuZCAobWluLXdpZHRoOiA3NjFweCkgewogIC5wcmVzZW50ZXItc3RhZ2UgeyBwYWRkaW5nLXRvcDogOHB4OyBnYXA6IDhweDsgfQogIC5wcmVzZW50ZXItc3RhZ2UgLnF1ZXN0aW9uLXRpdGxlIHsgZm9udC1zaXplOiBjbGFtcCgyMnB4LCAzdncsIDM2cHgpOyB9CiAgLnByZXNlbnRlci1hbnN3ZXJzIC5hbnN3ZXItY2FyZCB7IG1pbi1oZWlnaHQ6IDY0cHg7IHBhZGRpbmctYmxvY2s6IDEwcHg7IH0KICAucHJlc2VudGVyLWFuc3dlcnMuY291bnQtMiAuYW5zd2VyLWNhcmQgeyBtaW4taGVpZ2h0OiA5NnB4OyB9CiAgLmNvbXBhY3QtZGlzdHJpYnV0aW9uIHsgcGFkZGluZzogMTBweCAxNHB4OyBnYXA6IDZweDsgfQogIC5wcmVzZW50ZXItZXhwbGFuYXRpb24geyBwYWRkaW5nLWJsb2NrOiA4cHg7IH0KfQoKLyogPT09PT0gVmVyc8OjbyA2LjI6IHBhZHLDo28gcmVzcG9uc2l2bywgY29uZmlybWHDp8OjbyBkZSBwcm9udG8gZSBjb250YWdlbSBpbmljaWFsID09PT09ICovCmh0bWwsIGJvZHkgeyBtaW4taGVpZ2h0OiAxMDAlOyB9Ci5nYW1lLXNoZWxsLCAucHJlc2VudGVyLXNoZWxsIHsgbWluLWhlaWdodDogMTAwc3ZoOyB9Ci51bmlmaWVkLWdhbWUtaGVhZGVyIHsKICBtaW4taGVpZ2h0OiA2MHB4OwogIHBhZGRpbmc6IDlweCBjbGFtcCgxNHB4LCAzdncsIDMwcHgpOwogIGJhY2tncm91bmQ6IHJnYmEoMTcsMTgsMjUsLjk2KTsKfQouY29tcGFjdC1nYW1lLWJyYW5kIHsgZGlzcGxheTogaW5saW5lLWZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGdhcDogMTBweDsgZm9udC1zaXplOiAxNXB4OyB9Ci5yb29tLWJhZGdlLCAucXVlc3Rpb24tcHJvZ3Jlc3MgPiBzcGFuIHsKICBkaXNwbGF5OiBpbmxpbmUtZmxleDsgYWxpZ24taXRlbXM6IGNlbnRlcjsgbWluLWhlaWdodDogMzJweDsgcGFkZGluZzogNnB4IDExcHg7CiAgYm9yZGVyOiAxcHggc29saWQgcmdiYSgyNTUsMjU1LDI1NSwuMTUpOyBib3JkZXItcmFkaXVzOiA5OTlweDsKICBiYWNrZ3JvdW5kOiByZ2JhKDI1NSwyNTUsMjU1LC4wNyk7IGNvbG9yOiByZ2JhKDI1NSwyNTUsMjU1LC44Mik7IGZvbnQtc2l6ZTogMTNweDsgZm9udC13ZWlnaHQ6IDg1MDsKfQoucGxheWVyLW1ldGEgeyBkaXNwbGF5OiBmbGV4OyBhbGlnbi1pdGVtczogY2VudGVyOyBnYXA6IDEwcHg7IG1pbi13aWR0aDogMDsgfQoucGxheWVyLW1ldGEgPiBkaXYgeyBtaW4td2lkdGg6IDA7IGRpc3BsYXk6IGdyaWQ7IGdhcDogMXB4OyB9Ci5wbGF5ZXItbWV0YSBzdHJvbmcgeyBvdmVyZmxvdzogaGlkZGVuOyB0ZXh0LW92ZXJmbG93OiBlbGxpcHNpczsgd2hpdGUtc3BhY2U6IG5vd3JhcDsgfQoucGxheWVyLW1ldGEgc21hbGwgeyBjb2xvcjogcmdiYSgyNTUsMjU1LDI1NSwuNjYpOyBmb250LXNpemU6IDEycHg7IH0KLnF1ZXN0aW9uLXByb2dyZXNzIHsgZGlzcGxheTogZmxleDsgYWxpZ24taXRlbXM6IGNlbnRlcjsgZ2FwOiA5cHg7IH0KCi5wYXJ0aWNpcGFudC1zdGFnZSB7CiAgd2lkdGg6IG1pbig3MjBweCwgY2FsYygxMDAlIC0gMjhweCkpOwogIG1pbi1oZWlnaHQ6IGNhbGMoMTAwc3ZoIC0gNjBweCk7CiAgbWFyZ2luOiAwIGF1dG87CiAgZGlzcGxheTogZ3JpZDsKICBwbGFjZS1pdGVtczogY2VudGVyOwogIHBhZGRpbmc6IDI0cHggMDsKfQoucGFydGljaXBhbnQtY2FyZCB7CiAgd2lkdGg6IDEwMCU7CiAgZGlzcGxheTogZ3JpZDsKICBqdXN0aWZ5LWl0ZW1zOiBjZW50ZXI7CiAgZ2FwOiAxOHB4OwogIHBhZGRpbmc6IGNsYW1wKDI0cHgsIDV2dywgNDRweCk7CiAgYm9yZGVyOiAxcHggc29saWQgcmdiYSgyNTUsMjU1LDI1NSwuMTMpOwogIGJvcmRlci1yYWRpdXM6IDI4cHg7CiAgYmFja2dyb3VuZDogbGluZWFyLWdyYWRpZW50KDE2MGRlZywgcmdiYSgyNTUsMjU1LDI1NSwuMTIpLCByZ2JhKDI1NSwyNTUsMjU1LC4wNTUpKTsKICBib3gtc2hhZG93OiAwIDI4cHggNzBweCByZ2JhKDAsMCwwLC4yMik7CiAgdGV4dC1hbGlnbjogY2VudGVyOwp9Ci5wYXJ0aWNpcGFudC1jYXJkIC5hdmF0YXItdmlzdWFsIHsgd2lkdGg6IDg2cHg7IGhlaWdodDogODZweDsgZm9udC1zaXplOiA0NHB4OyB9Ci5wYXJ0aWNpcGFudC1jb3B5IHsgbWF4LXdpZHRoOiA1MjBweDsgfQoucGFydGljaXBhbnQtY29weSAuZXllYnJvdyB7IG1hcmdpbi1ib3R0b206IDEwcHg7IGJhY2tncm91bmQ6IHJnYmEoMjU1LDI1NSwyNTUsLjEwKTsgY29sb3I6IHdoaXRlOyB9Ci5wYXJ0aWNpcGFudC1jb3B5IGgxIHsgbWFyZ2luOiAwIDAgOHB4OyBmb250LXNpemU6IGNsYW1wKDMwcHgsIDd2dywgNTBweCk7IGxldHRlci1zcGFjaW5nOiAtLjA0NWVtOyB9Ci5wYXJ0aWNpcGFudC1jb3B5IHAgeyBtYXJnaW46IDA7IGNvbG9yOiByZ2JhKDI1NSwyNTUsMjU1LC43KTsgZm9udC1zaXplOiAxNnB4OyB9Ci5yZWFkeS1idXR0b24gewogIHdpZHRoOiBtaW4oNDIwcHgsMTAwJSk7IG1pbi1oZWlnaHQ6IDYycHg7IGJvcmRlcjogMXB4IHNvbGlkIHJnYmEoMjU1LDI1NSwyNTUsLjE4KTsgYm9yZGVyLXJhZGl1czogMThweDsKICBkaXNwbGF5OiBmbGV4OyBhbGlnbi1pdGVtczogY2VudGVyOyBqdXN0aWZ5LWNvbnRlbnQ6IGNlbnRlcjsgZ2FwOiAxMnB4OwogIHBhZGRpbmc6IDEycHggMThweDsgYmFja2dyb3VuZDogd2hpdGU7IGNvbG9yOiB2YXIoLS1pbmspOyBmb250LXNpemU6IDE3cHg7IGZvbnQtd2VpZ2h0OiA5NTA7CiAgdHJhbnNpdGlvbjogdHJhbnNmb3JtIC4xOHMgZWFzZSwgYmFja2dyb3VuZCAuMThzIGVhc2UsIGNvbG9yIC4xOHMgZWFzZTsKfQoucmVhZHktYnV0dG9uOmhvdmVyOm5vdCg6ZGlzYWJsZWQpIHsgdHJhbnNmb3JtOiB0cmFuc2xhdGVZKC0ycHgpOyB9Ci5yZWFkeS1idXR0b24uaXMtcmVhZHkgeyBiYWNrZ3JvdW5kOiBsaW5lYXItZ3JhZGllbnQoMTM1ZGVnLCAjMTdCMjZBLCAjMDBBN0UxKTsgY29sb3I6IHdoaXRlOyBib3JkZXItY29sb3I6IHRyYW5zcGFyZW50OyB9Ci5yZWFkeS1pY29uIHsgd2lkdGg6IDMwcHg7IGhlaWdodDogMzBweDsgYm9yZGVyLXJhZGl1czogNTAlOyBkaXNwbGF5OiBncmlkOyBwbGFjZS1pdGVtczogY2VudGVyOyBiYWNrZ3JvdW5kOiByZ2JhKDIzLDI0LDMyLC4wOCk7IGZvbnQtc2l6ZTogMjBweDsgfQoucmVhZHktYnV0dG9uLmlzLXJlYWR5IC5yZWFkeS1pY29uIHsgYmFja2dyb3VuZDogcmdiYSgyNTUsMjU1LDI1NSwuMTgpOyB9Ci5sb2JieS1wcm9ncmVzcyB7IHdpZHRoOiBtaW4oNDIwcHgsMTAwJSk7IGRpc3BsYXk6IGdyaWQ7IGdyaWQtdGVtcGxhdGUtY29sdW1uczogMWZyIDFmcjsgZ2FwOiAxMHB4OyB9Ci5sb2JieS1wcm9ncmVzcyA+IGRpdiB7IHBhZGRpbmc6IDEzcHg7IGJvcmRlci1yYWRpdXM6IDE1cHg7IGJhY2tncm91bmQ6IHJnYmEoMjU1LDI1NSwyNTUsLjA4KTsgZGlzcGxheTogZ3JpZDsgZ2FwOiAycHg7IH0KLmxvYmJ5LXByb2dyZXNzIHN0cm9uZyB7IGZvbnQtc2l6ZTogMjRweDsgfQoubG9iYnktcHJvZ3Jlc3Mgc3BhbiB7IGNvbG9yOiByZ2JhKDI1NSwyNTUsMjU1LC42Mik7IGZvbnQtc2l6ZTogMTJweDsgdGV4dC10cmFuc2Zvcm06IHVwcGVyY2FzZTsgbGV0dGVyLXNwYWNpbmc6IC4wOGVtOyBmb250LXdlaWdodDogODUwOyB9Ci5yZWFkeS1oZWxwZXIgeyBtYXJnaW46IDA7IGNvbG9yOiByZ2JhKDI1NSwyNTUsMjU1LC42Nik7IGZvbnQtc2l6ZTogMTNweDsgfQoKLnVuaWZpZWQtcXVlc3Rpb24tc3RhZ2UgeyB3aWR0aDogbWluKDk4MHB4LCBjYWxjKDEwMCUgLSAyOHB4KSk7IG1pbi1oZWlnaHQ6IGNhbGMoMTAwc3ZoIC0gNjBweCk7IHBhZGRpbmc6IDIwcHggMCAzMHB4OyBnYXA6IDE0cHg7IGFsaWduLWNvbnRlbnQ6IGNlbnRlcjsgfQoucXVlc3Rpb24ta2lja2VyIHsganVzdGlmeS1zZWxmOiBjZW50ZXI7IGNvbG9yOiByZ2JhKDI1NSwyNTUsMjU1LC42Mik7IGZvbnQtc2l6ZTogMTNweDsgZm9udC13ZWlnaHQ6IDkwMDsgdGV4dC10cmFuc2Zvcm06IHVwcGVyY2FzZTsgbGV0dGVyLXNwYWNpbmc6IC4wOWVtOyB9Ci5wYXJ0aWNpcGFudC1hbnN3ZXJzIHsgd2lkdGg6IDEwMCU7IGdhcDogMTJweDsgfQoucGFydGljaXBhbnQtYW5zd2VycyAuYW5zd2VyLWJ0biB7IG1pbi1oZWlnaHQ6IDk2cHg7IGJvcmRlci1yYWRpdXM6IDE4cHg7IHBhZGRpbmc6IDE2cHggMThweDsgZm9udC1zaXplOiBjbGFtcCgxNnB4LCAydncsIDIycHgpOyB9Ci5hbnN3ZXItc2VudCB7IGp1c3RpZnktc2VsZjogY2VudGVyOyBwYWRkaW5nOiAxMHB4IDE1cHg7IGJvcmRlci1yYWRpdXM6IDk5OXB4OyBiYWNrZ3JvdW5kOiByZ2JhKDIzLDE3OCwxMDYsLjE4KTsgY29sb3I6ICNCOEZGRDk7IGZvbnQtd2VpZ2h0OiA4NTA7IGZvbnQtc2l6ZTogMTNweDsgfQoKLnN0YW5kYXJkaXplZC1sb2JieSB7IGdyaWQtdGVtcGxhdGUtY29sdW1uczogLjg4ZnIgMS4xMmZyOyBnYXA6IDE2cHg7IH0KLmxvYmJ5LWFjY2Vzcy1wYW5lbCwgLmxvYmJ5LXJlYWR5LXBhbmVsIHsKICBib3JkZXI6IDFweCBzb2xpZCByZ2JhKDI1NSwyNTUsMjU1LC4xMik7IGJvcmRlci1yYWRpdXM6IDIycHg7IHBhZGRpbmc6IGNsYW1wKDE4cHgsIDN2dywgMjhweCk7CiAgYmFja2dyb3VuZDogcmdiYSgyNTUsMjU1LDI1NSwuMDY1KTsKfQoubG9iYnktYWNjZXNzLXBhbmVsIHsgZGlzcGxheTogZ3JpZDsgZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOiAxZnIgYXV0bzsgYWxpZ24taXRlbXM6IGNlbnRlcjsgZ2FwOiAxOHB4OyB9Ci5sb2JieS1hY2Nlc3MtcGFuZWwgcCB7IG1hcmdpbjogN3B4IDAgMDsgY29sb3I6IHJnYmEoMjU1LDI1NSwyNTUsLjY1KTsgfQoubG9iYnktbGFiZWwgeyBjb2xvcjogcmdiYSgyNTUsMjU1LDI1NSwuNjUpOyBmb250LXNpemU6IDEzcHg7IGZvbnQtd2VpZ2h0OiA4NTA7IHRleHQtdHJhbnNmb3JtOiB1cHBlcmNhc2U7IGxldHRlci1zcGFjaW5nOiAuMDllbTsgfQouY29tcGFjdC1xciB7IHBhZGRpbmc6IDlweDsgYm9yZGVyLXJhZGl1czogMTVweDsgfQouY29tcGFjdC1xciBjYW52YXMsIC5jb21wYWN0LXFyIGltZyB7IG1heC13aWR0aDogMTkwcHggIWltcG9ydGFudDsgd2lkdGg6IG1pbigxOTBweCwgMzB2dykgIWltcG9ydGFudDsgaGVpZ2h0OiBhdXRvICFpbXBvcnRhbnQ7IH0KLmNvcHktbGluay1yb3cgeyBncmlkLWNvbHVtbjogMSAvIC0xOyBkaXNwbGF5OiBncmlkOyBncmlkLXRlbXBsYXRlLWNvbHVtbnM6IDFmciBhdXRvOyBnYXA6IDlweDsgfQoubG9iYnktcmVhZHktcGFuZWwgeyBkaXNwbGF5OiBncmlkOyBncmlkLXRlbXBsYXRlLXJvd3M6IGF1dG8gMWZyOyBnYXA6IDE2cHg7IG1pbi1oZWlnaHQ6IDA7IH0KLnJlYWR5LXN1bW1hcnkgeyBkaXNwbGF5OiBncmlkOyBnYXA6IDEwcHg7IH0KLnJlYWR5LXN1bW1hcnkgPiBkaXY6Zmlyc3QtY2hpbGQgeyBkaXNwbGF5OiBmbGV4OyBhbGlnbi1pdGVtczogZW5kOyBqdXN0aWZ5LWNvbnRlbnQ6IHNwYWNlLWJldHdlZW47IGdhcDogMTJweDsgfQoucmVhZHktc3VtbWFyeSBzcGFuIHsgY29sb3I6IHJnYmEoMjU1LDI1NSwyNTUsLjY1KTsgZm9udC13ZWlnaHQ6IDgwMDsgfQoucmVhZHktc3VtbWFyeSBzdHJvbmcgeyBmb250LXNpemU6IDMwcHg7IH0KLnJlYWR5LXN1bW1hcnkgcCB7IG1hcmdpbjogMDsgY29sb3I6IHJnYmEoMjU1LDI1NSwyNTUsLjY3KTsgZm9udC1zaXplOiAxM3B4OyB9Ci5yZWFkeS1tZXRlciB7IGhlaWdodDogOXB4OyBib3JkZXItcmFkaXVzOiA5OTlweDsgb3ZlcmZsb3c6IGhpZGRlbjsgYmFja2dyb3VuZDogcmdiYSgyNTUsMjU1LDI1NSwuMTEpOyB9Ci5yZWFkeS1tZXRlciA+IHNwYW4geyBkaXNwbGF5OiBibG9jazsgaGVpZ2h0OiAxMDAlOyBib3JkZXItcmFkaXVzOiBpbmhlcml0OyBiYWNrZ3JvdW5kOiBsaW5lYXItZ3JhZGllbnQoOTBkZWcsIzE3QjI2QSwjMDBDMkZGKTsgdHJhbnNpdGlvbjogd2lkdGggLjM1cyBlYXNlOyB9Ci5wbGF5ZXItcmVhZHktbGlzdCB7IG1pbi1oZWlnaHQ6IDA7IG1heC1oZWlnaHQ6IG1pbig0OHZoLCAzOTBweCk7IG92ZXJmbG93OiBhdXRvOyBkaXNwbGF5OiBncmlkOyBncmlkLXRlbXBsYXRlLWNvbHVtbnM6IHJlcGVhdCgyLG1pbm1heCgwLDFmcikpOyBnYXA6IDhweDsgYWxpZ24tY29udGVudDogc3RhcnQ7IHBhZGRpbmctcmlnaHQ6IDNweDsgfQoucmVhZHktcGxheWVyIHsgbWluLXdpZHRoOiAwOyBkaXNwbGF5OiBncmlkOyBncmlkLXRlbXBsYXRlLWNvbHVtbnM6IDM4cHggMWZyIGF1dG87IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGdhcDogOXB4OyBwYWRkaW5nOiA5cHggMTBweDsgYm9yZGVyOiAxcHggc29saWQgcmdiYSgyNTUsMjU1LDI1NSwuMTApOyBib3JkZXItcmFkaXVzOiAxNHB4OyBiYWNrZ3JvdW5kOiByZ2JhKDI1NSwyNTUsMjU1LC4wNTUpOyB9Ci5yZWFkeS1wbGF5ZXIuaXMtcmVhZHkgeyBib3JkZXItY29sb3I6IHJnYmEoMjMsMTc4LDEwNiwuNTUpOyBiYWNrZ3JvdW5kOiByZ2JhKDIzLDE3OCwxMDYsLjExKTsgfQoucmVhZHktcGxheWVyID4gZGl2IHsgbWluLXdpZHRoOiAwOyBkaXNwbGF5OiBncmlkOyBnYXA6IDFweDsgfQoucmVhZHktcGxheWVyIHN0cm9uZyB7IHdoaXRlLXNwYWNlOiBub3dyYXA7IG92ZXJmbG93OiBoaWRkZW47IHRleHQtb3ZlcmZsb3c6IGVsbGlwc2lzOyBmb250LXNpemU6IDEzcHg7IH0KLnJlYWR5LXBsYXllciBzbWFsbCB7IGNvbG9yOiByZ2JhKDI1NSwyNTUsMjU1LC41OCk7IGZvbnQtc2l6ZTogMTFweDsgfQoucmVhZHktY2hlY2sgeyBjb2xvcjogcmdiYSgyNTUsMjU1LDI1NSwuNDUpOyBmb250LXdlaWdodDogOTUwOyB9Ci5yZWFkeS1wbGF5ZXIuaXMtcmVhZHkgLnJlYWR5LWNoZWNrIHsgY29sb3I6ICM2NUU5QTU7IH0KLmRhcmstZW1wdHkgeyBjb2xvcjogcmdiYSgyNTUsMjU1LDI1NSwuNik7IGJvcmRlci1jb2xvcjogcmdiYSgyNTUsMjU1LDI1NSwuMTgpOyBncmlkLWNvbHVtbjogMSAvIC0xOyB9Cgouc3RhcnQtY291bnRkb3duLXNjcmVlbiB7IG1pbi1oZWlnaHQ6IGNhbGMoMTAwc3ZoIC0gNTJweCk7IGRpc3BsYXk6IGdyaWQ7IHBsYWNlLWl0ZW1zOiBjZW50ZXI7IHBhZGRpbmc6IDI0cHg7IGJhY2tncm91bmQ6IHJhZGlhbC1ncmFkaWVudChjaXJjbGUgYXQgY2VudGVyLCByZ2JhKDEwMSw3MSwyNTUsLjIyKSwgdHJhbnNwYXJlbnQgMzRyZW0pOyBjb2xvcjogd2hpdGU7IH0KLnN0YXJ0LWNvdW50ZG93bi1jYXJkIHsgd2lkdGg6IG1pbig2MjBweCwxMDAlKTsgdGV4dC1hbGlnbjogY2VudGVyOyBkaXNwbGF5OiBncmlkOyBqdXN0aWZ5LWl0ZW1zOiBjZW50ZXI7IGdhcDogMTNweDsgfQouY291bnRkb3duLWJyYW5kIHsgZGlzcGxheTogaW5saW5lLWZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGdhcDogMTBweDsgZm9udC1zaXplOiAxNXB4OyB9Ci5zdGFydC1jb3VudGRvd24tY2FyZCBwIHsgbWFyZ2luOiA4cHggMCAwOyBjb2xvcjogcmdiYSgyNTUsMjU1LDI1NSwuNzIpOyBmb250LXNpemU6IGNsYW1wKDE1cHgsMnZ3LDE5cHgpOyB9Ci5zdGFydC1jb3VudGRvd24tY2FyZCA+IHNwYW4geyBjb2xvcjogcmdiYSgyNTUsMjU1LDI1NSwuNjIpOyBmb250LXNpemU6IDEzcHg7IGZvbnQtd2VpZ2h0OiA4NTA7IHRleHQtdHJhbnNmb3JtOiB1cHBlcmNhc2U7IGxldHRlci1zcGFjaW5nOiAuMTJlbTsgfQoub3BlbmluZy1jb3VudGRvd24tbnVtYmVyIHsgZm9udC1zaXplOiBtaW4oNDJ2dywgMjYwcHgpOyBsaW5lLWhlaWdodDogLjk7IGZvbnQtd2VpZ2h0OiAxMDAwOyBsZXR0ZXItc3BhY2luZzogLS4wOGVtOyBiYWNrZ3JvdW5kOiB2YXIoLS1ncmFkaWVudCk7IC13ZWJraXQtYmFja2dyb3VuZC1jbGlwOiB0ZXh0OyBiYWNrZ3JvdW5kLWNsaXA6IHRleHQ7IGNvbG9yOiB0cmFuc3BhcmVudDsgZmlsdGVyOiBkcm9wLXNoYWRvdygwIDIycHggNTBweCByZ2JhKDczLDY0LDI1NSwuMzApKTsgfQouY291bnRkb3duLXBvcCB7IGFuaW1hdGlvbjogY291bnRkb3duUG9wIC40MnMgZWFzZTsgfQpAa2V5ZnJhbWVzIGNvdW50ZG93blBvcCB7IDAlIHsgdHJhbnNmb3JtOiBzY2FsZSguNzIpOyBvcGFjaXR5OiAuMzU7IH0gNjUlIHsgdHJhbnNmb3JtOiBzY2FsZSgxLjA4KTsgfSAxMDAlIHsgdHJhbnNmb3JtOiBzY2FsZSgxKTsgb3BhY2l0eTogMTsgfSB9Cgouc2NyZWVuLWxvYmJ5IHsgZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOiAxZnIgLjhmcjsgYWxpZ24taXRlbXM6IGNlbnRlcjsganVzdGlmeS1pdGVtczogY2VudGVyOyB9Ci5zY3JlZW4tY29kZS1ibG9jaywgLnNjcmVlbi1yZWFkeS1ibG9jayB7IHdpZHRoOiAxMDAlOyBkaXNwbGF5OiBncmlkOyBqdXN0aWZ5LWl0ZW1zOiBjZW50ZXI7IGdhcDogMTRweDsgdGV4dC1hbGlnbjogY2VudGVyOyB9Ci5zY3JlZW4tY29kZS1ibG9jayA+IHNwYW4sIC5zY3JlZW4tcmVhZHktYmxvY2sgPiBzcGFuIHsgY29sb3I6IHJnYmEoMjU1LDI1NSwyNTUsLjY2KTsgZm9udC13ZWlnaHQ6IDgwMDsgfQouc2NyZWVuLXJlYWR5LWJsb2NrIHN0cm9uZyB7IGZvbnQtc2l6ZTogY2xhbXAoNTZweCwgMTB2dywgMTIwcHgpOyBsaW5lLWhlaWdodDogMTsgfQouc2NyZWVuLXJlYWR5LWJsb2NrIC5yZWFkeS1tZXRlciB7IHdpZHRoOiBtaW4oNDIwcHgsIDg1JSk7IH0KCi8qIEZvcm11bMOhcmlvIGRlIGVudHJhZGEgY29tIG8gbWVzbW8gcGFkcsOjbyB2aXN1YWwgZG8gam9nbyAqLwpib2R5Omhhcygjam9pbi1yb29tKSAudG9wYmFyIHsgbWluLWhlaWdodDogNjBweDsgcGFkZGluZy1ibG9jazogOHB4OyB9CmJvZHk6aGFzKCNqb2luLXJvb20pIC5jb250YWluZXIubmFycm93IHsgd2lkdGg6IG1pbig3MjBweCwgY2FsYygxMDAlIC0gMjRweCkpOyBwYWRkaW5nLXRvcDogMTRweDsgfQpib2R5Omhhcygjam9pbi1yb29tKSAuY29udGFpbmVyLm5hcnJvdyA+IC5jYXJkIHsgYm9yZGVyLXJhZGl1czogMjRweDsgcGFkZGluZzogY2xhbXAoMjBweCw0dncsMzRweCk7IH0KYm9keTpoYXMoI2pvaW4tcm9vbSkgLmF2YXRhci1ncmlkIHsgZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOiByZXBlYXQoNCwxZnIpOyB9CgpAbWVkaWEgKG1heC13aWR0aDogNzYwcHgpIHsKICAudW5pZmllZC1nYW1lLWhlYWRlciB7IG1pbi1oZWlnaHQ6IDU2cHg7IHBhZGRpbmc6IDhweCAxMnB4OyB9CiAgLnByZXNlbnRlci1icmFuZC1tYXJrIHsgd2lkdGg6IDE4cHg7IGhlaWdodDogMThweDsgfQogIC5jb21wYWN0LWdhbWUtYnJhbmQgc3Ryb25nIHsgZm9udC1zaXplOiAxM3B4OyB9CiAgLnJvb20tYmFkZ2UgeyBtaW4taGVpZ2h0OiAyOXB4OyBmb250LXNpemU6IDExcHg7IHBhZGRpbmc6IDVweCA5cHg7IH0KICAucGFydGljaXBhbnQtc3RhZ2UgeyB3aWR0aDogY2FsYygxMDAlIC0gMjBweCk7IG1pbi1oZWlnaHQ6IGNhbGMoMTAwc3ZoIC0gNTZweCk7IHBhZGRpbmc6IDEwcHggMDsgfQogIC5wYXJ0aWNpcGFudC1jYXJkIHsgYm9yZGVyLXJhZGl1czogMjFweDsgcGFkZGluZzogMjJweCAxNnB4OyBnYXA6IDE1cHg7IH0KICAucGFydGljaXBhbnQtY2FyZCAuYXZhdGFyLXZpc3VhbCB7IHdpZHRoOiA3MHB4OyBoZWlnaHQ6IDcwcHg7IGZvbnQtc2l6ZTogMzZweDsgfQogIC5wYXJ0aWNpcGFudC1jb3B5IGgxIHsgZm9udC1zaXplOiBjbGFtcCgyOHB4LDl2dyw0MHB4KTsgfQogIC5wYXJ0aWNpcGFudC1jb3B5IHAgeyBmb250LXNpemU6IDE0cHg7IH0KICAucmVhZHktYnV0dG9uIHsgbWluLWhlaWdodDogNTZweDsgYm9yZGVyLXJhZGl1czogMTVweDsgZm9udC1zaXplOiAxNXB4OyB9CiAgLmxvYmJ5LXByb2dyZXNzID4gZGl2IHsgcGFkZGluZzogMTBweDsgfQogIC5sb2JieS1wcm9ncmVzcyBzdHJvbmcgeyBmb250LXNpemU6IDIxcHg7IH0KICAucGxheWVyLW1ldGEgLm1pbmktYXZhdGFyIHsgd2lkdGg6IDM0cHg7IGhlaWdodDogMzRweDsgZm9udC1zaXplOiAxOXB4OyB9CiAgLnBsYXllci1tZXRhIHN0cm9uZyB7IGZvbnQtc2l6ZTogMTNweDsgbWF4LXdpZHRoOiAxMjBweDsgfQogIC5xdWVzdGlvbi1wcm9ncmVzcyB7IGdhcDogNnB4OyB9CiAgLnF1ZXN0aW9uLXByb2dyZXNzID4gc3BhbiB7IGRpc3BsYXk6IG5vbmU7IH0KICAuZ2FtZS1oZWFkZXIgLnRpbWVyIHsgd2lkdGg6IDQwcHg7IGhlaWdodDogNDBweDsgZm9udC1zaXplOiAxN3B4OyB9CiAgLnVuaWZpZWQtcXVlc3Rpb24tc3RhZ2UgeyB3aWR0aDogY2FsYygxMDAlIC0gMjBweCk7IG1pbi1oZWlnaHQ6IGNhbGMoMTAwc3ZoIC0gNTZweCk7IHBhZGRpbmc6IDEycHggMCAxOHB4OyBnYXA6IDEwcHg7IGFsaWduLWNvbnRlbnQ6IHN0YXJ0OyB9CiAgLnVuaWZpZWQtcXVlc3Rpb24tc3RhZ2UgLnF1ZXN0aW9uLXRpdGxlIHsgZm9udC1zaXplOiBjbGFtcCgyMXB4LDd2dywyOXB4KTsgbGluZS1oZWlnaHQ6IDEuMTI7IG1hcmdpbjogMnB4IDAgNHB4OyB9CiAgLnBhcnRpY2lwYW50LWFuc3dlcnMgeyBncmlkLXRlbXBsYXRlLWNvbHVtbnM6IDFmcjsgZ2FwOiA4cHg7IH0KICAucGFydGljaXBhbnQtYW5zd2VycyAuYW5zd2VyLWJ0biB7IG1pbi1oZWlnaHQ6IDY0cHg7IGJvcmRlci1yYWRpdXM6IDE0cHg7IHBhZGRpbmc6IDEycHggMTNweDsgZm9udC1zaXplOiAxNXB4OyBnYXA6IDEwcHg7IH0KICAucGFydGljaXBhbnQtYW5zd2VycyAuc2hhcGUgeyB3aWR0aDogMjRweDsgaGVpZ2h0OiAyNHB4OyBib3JkZXItd2lkdGg6IDNweDsgZmxleDogMCAwIGF1dG87IH0KICAuYW5zd2VyLXNlbnQgeyBmb250LXNpemU6IDEycHg7IHBhZGRpbmc6IDhweCAxMXB4OyB9CiAgLnN0YW5kYXJkaXplZC1sb2JieSB7IGdyaWQtdGVtcGxhdGUtY29sdW1uczogMWZyOyB9CiAgLmxvYmJ5LWFjY2Vzcy1wYW5lbCB7IGdyaWQtdGVtcGxhdGUtY29sdW1uczogMWZyIGF1dG87IHBhZGRpbmc6IDE1cHg7IH0KICAubG9iYnktYWNjZXNzLXBhbmVsIC5sb2JieS1jb2RlIHsgZm9udC1zaXplOiA0MnB4OyB9CiAgLmNvbXBhY3QtcXIgY2FudmFzLCAuY29tcGFjdC1xciBpbWcgeyB3aWR0aDogMTEycHggIWltcG9ydGFudDsgfQogIC5jb3B5LWxpbmstcm93IHsgZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOiAxZnI7IH0KICAuY29weS1saW5rLXJvdyAuaW5wdXQgeyBmb250LXNpemU6IDEycHg7IH0KICAucGxheWVyLXJlYWR5LWxpc3QgeyBncmlkLXRlbXBsYXRlLWNvbHVtbnM6IDFmcjsgbWF4LWhlaWdodDogMzF2aDsgfQogIC5zY3JlZW4tbG9iYnkgeyBncmlkLXRlbXBsYXRlLWNvbHVtbnM6IDFmcjsgYWxpZ24tY29udGVudDogY2VudGVyOyBnYXA6IDIwcHg7IH0KICAuc2NyZWVuLWNvZGUtYmxvY2sgLmNvbXBhY3QtcXIgY2FudmFzLCAuc2NyZWVuLWNvZGUtYmxvY2sgLmNvbXBhY3QtcXIgaW1nIHsgd2lkdGg6IDE1MHB4ICFpbXBvcnRhbnQ7IH0KICBib2R5Omhhcygjam9pbi1yb29tKSAuYXZhdGFyLWdyaWQgeyBncmlkLXRlbXBsYXRlLWNvbHVtbnM6IHJlcGVhdCgzLDFmcik7IH0KICBib2R5Omhhcygjam9pbi1yb29tKSAuZ3JpZC0yIHsgZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOiAxZnI7IH0KICBib2R5Omhhcygjam9pbi1yb29tKSAuYXZhdGFyLWNob2ljZSB7IHBhZGRpbmc6IDZweDsgYm9yZGVyLXJhZGl1czogMTRweDsgfQogIGJvZHk6aGFzKCNqb2luLXJvb20pIC5hdmF0YXItY2hvaWNlIC5hdmF0YXItdmlzdWFsIHsgd2lkdGg6IDUycHg7IGhlaWdodDogNTJweDsgZm9udC1zaXplOiAyOHB4OyB9CiAgYm9keTpoYXMoI2pvaW4tcm9vbSkgLmF2YXRhci1jaG9pY2Ugc21hbGwgeyBmb250LXNpemU6IDEwcHg7IH0KICAuc3RhcnQtY291bnRkb3duLXNjcmVlbiB7IG1pbi1oZWlnaHQ6IGNhbGMoMTAwc3ZoIC0gNTJweCk7IHBhZGRpbmc6IDE2cHg7IH0KICAub3BlbmluZy1jb3VudGRvd24tbnVtYmVyIHsgZm9udC1zaXplOiBtaW4oNTZ2dywgMjEwcHgpOyB9Cn0KCkBtZWRpYSAobWF4LXdpZHRoOiAzODBweCkgewogIGJvZHk6aGFzKCNqb2luLXJvb20pIC5hdmF0YXItZ3JpZCB7IGdyaWQtdGVtcGxhdGUtY29sdW1uczogcmVwZWF0KDIsMWZyKTsgfQogIC5wYXJ0aWNpcGFudC1hbnN3ZXJzIC5hbnN3ZXItYnRuIHsgbWluLWhlaWdodDogNThweDsgZm9udC1zaXplOiAxNHB4OyB9CiAgLnBhcnRpY2lwYW50LWNhcmQgeyBwYWRkaW5nLWlubGluZTogMTNweDsgfQp9Cg==', 'base64') }],
  ['/app.js', { type: 'application/javascript; charset=utf-8', data: Buffer.from('J3VzZSBzdHJpY3QnOwoKY29uc3QgYXBwID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2FwcCcpOwpjb25zdCB0b2FzdEVsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3RvYXN0Jyk7CmNvbnN0IEFVVEhfS0VZID0gJ3F1aXpfY3JlZHN5c3RlbV9hdXRoJzsKY29uc3QgUFJFU0VOVEVSX0tFWSA9IChyb29tKSA9PiBgcXVpel9jcmVkc3lzdGVtX3ByZXNlbnRlcl8ke3Jvb219YDsKY29uc3QgUExBWUVSX0tFWSA9IChyb29tKSA9PiBgcXVpel9jcmVkc3lzdGVtX3BsYXllcl8ke3Jvb219YDsKCmNvbnN0IHN0YXRlID0gewogIGNvbmZpZzogbnVsbCwKICBhdXRoOiBudWxsLAogIHF1aXp6ZXM6IFtdLAogIGFkbWluczogW10sCiAgZGFzaGJvYXJkVGFiOiAnb3ZlcnZpZXcnLAogIGVkaXRvcjogbnVsbCwKICBzdGFydFF1aXpJZDogbnVsbCwKICBldmVudFNvdXJjZTogbnVsbCwKICByb29tOiBudWxsLAogIHNlbGY6IG51bGwsCiAgcGxheWVyQ3JlZHM6IG51bGwsCiAgcHJlc2VudGVyQ3JlZHM6IG51bGwsCiAgcm9vbVJvbGU6IG51bGwsCiAgdGltZXJJbnRlcnZhbDogbnVsbCwKICBsYXN0UmFua2luZ0tleTogbnVsbCwKICBhdWRpbzogewogICAgY29udGV4dDogbnVsbCwKICAgIG1hc3RlckdhaW46IG51bGwsCiAgICB0aW1lcjogbnVsbCwKICAgIGFjdGl2ZVRoZW1lOiBudWxsLAogICAgZW5hYmxlZDogdHJ1ZSwKICAgIHVubG9ja2VkOiBmYWxzZSwKICAgIGdhdGVWaXNpYmxlOiBmYWxzZSwKICAgIHN0ZXA6IDAsCiAgfSwKfTsKCmNvbnN0IHBhcmFtcyA9IG5ldyBVUkxTZWFyY2hQYXJhbXMobG9jYXRpb24uc2VhcmNoKTsKCmZ1bmN0aW9uIGVzY2FwZUh0bWwodmFsdWUpIHsKICByZXR1cm4gU3RyaW5nKHZhbHVlID8/ICcnKQogICAgLnJlcGxhY2UoLyYvZywgJyZhbXA7JykKICAgIC5yZXBsYWNlKC88L2csICcmbHQ7JykKICAgIC5yZXBsYWNlKC8+L2csICcmZ3Q7JykKICAgIC5yZXBsYWNlKC8iL2csICcmcXVvdDsnKQogICAgLnJlcGxhY2UoLycvZywgJyYjMDM5OycpOwp9CgpmdW5jdGlvbiByYW5kb21JZChwcmVmaXggPSAnaWQnKSB7CiAgaWYgKGNyeXB0by5yYW5kb21VVUlEKSByZXR1cm4gYCR7cHJlZml4fV8ke2NyeXB0by5yYW5kb21VVUlEKCl9YDsKICByZXR1cm4gYCR7cHJlZml4fV8ke0RhdGUubm93KCl9XyR7TWF0aC5yYW5kb20oKS50b1N0cmluZygxNikuc2xpY2UoMil9YDsKfQoKZnVuY3Rpb24gc2hvd1RvYXN0KG1lc3NhZ2UpIHsKICB0b2FzdEVsLnRleHRDb250ZW50ID0gbWVzc2FnZTsKICB0b2FzdEVsLmNsYXNzTGlzdC5hZGQoJ3Nob3cnKTsKICBjbGVhclRpbWVvdXQoc2hvd1RvYXN0LnRpbWVyKTsKICBzaG93VG9hc3QudGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHRvYXN0RWwuY2xhc3NMaXN0LnJlbW92ZSgnc2hvdycpLCAyODAwKTsKfQoKYXN5bmMgZnVuY3Rpb24gYXBpKHBhdGgsIGJvZHkgPSB7fSkgewogIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgZmV0Y2gocGF0aCwgewogICAgbWV0aG9kOiAnUE9TVCcsCiAgICBoZWFkZXJzOiB7ICdDb250ZW50LVR5cGUnOiAnYXBwbGljYXRpb24vanNvbicgfSwKICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KGJvZHkpLAogIH0pOwogIGNvbnN0IGRhdGEgPSBhd2FpdCByZXNwb25zZS5qc29uKCkuY2F0Y2goKCkgPT4gKHsgb2s6IGZhbHNlLCBtZXNzYWdlOiAnUmVzcG9zdGEgaW52w6FsaWRhIGRvIHNlcnZpZG9yLicgfSkpOwogIGlmICghcmVzcG9uc2Uub2sgfHwgZGF0YS5vayA9PT0gZmFsc2UpIHRocm93IG5ldyBFcnJvcihkYXRhLm1lc3NhZ2UgfHwgJ07Do28gZm9pIHBvc3PDrXZlbCBjb25jbHVpciBhIGHDp8Ojby4nKTsKICByZXR1cm4gZGF0YTsKfQoKZnVuY3Rpb24gYnJhbmRNYXJrdXAobGlnaHQgPSBmYWxzZSkgewogIHJldHVybiBgCiAgICA8YSBjbGFzcz0iYnJhbmQiIGhyZWY9Ii8iIGFyaWEtbGFiZWw9IlF1aXogQ3JlZHN5c3RlbSI+CiAgICAgIDxzcGFuIGNsYXNzPSJicmFuZC1zeW1ib2wiIGFyaWEtaGlkZGVuPSJ0cnVlIj48L3NwYW4+CiAgICAgIDxzcGFuIGNsYXNzPSJicmFuZC1jb3B5Ij4KICAgICAgICA8c3Ryb25nIHN0eWxlPSJjb2xvcjoke2xpZ2h0ID8gJ3doaXRlJyA6ICd2YXIoLS1pbmspJ30iPlF1aXogQ3JlZHN5c3RlbTwvc3Ryb25nPgogICAgICAgIDxzbWFsbCBzdHlsZT0iY29sb3I6JHtsaWdodCA/ICdyZ2JhKDI1NSwyNTUsMjU1LC42OCknIDogJyd9Ij5FZHVjYcOnw6NvIGNvcnBvcmF0aXZhIGFvIHZpdm88L3NtYWxsPgogICAgICA8L3NwYW4+CiAgICA8L2E+YDsKfQoKZnVuY3Rpb24gdG9wYmFyKGFjdGlvbnMgPSAnJykgewogIHJldHVybiBgPGhlYWRlciBjbGFzcz0idG9wYmFyIj4ke2JyYW5kTWFya3VwKCl9PGRpdiBjbGFzcz0idG9wLWFjdGlvbnMiPiR7YWN0aW9uc308L2Rpdj48L2hlYWRlcj5gOwp9CgpmdW5jdGlvbiBjbGVhclRpbWVyKCkgewogIGlmIChzdGF0ZS50aW1lckludGVydmFsKSBjbGVhckludGVydmFsKHN0YXRlLnRpbWVySW50ZXJ2YWwpOwogIHN0YXRlLnRpbWVySW50ZXJ2YWwgPSBudWxsOwp9CgpmdW5jdGlvbiBzdGFydENvdW50ZG93bihyb29tKSB7CiAgY2xlYXJUaW1lcigpOwogIGNvbnN0IGVsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3RpbWVyJyk7CiAgaWYgKCFlbCB8fCAhcm9vbS5xdWVzdGlvblN0YXJ0ZWRBdCB8fCAhcm9vbS5xdWVzdGlvbikgcmV0dXJuOwogIGNvbnN0IHRpY2sgPSAoKSA9PiB7CiAgICBjb25zdCBlbGFwc2VkID0gKERhdGUubm93KCkgLSByb29tLnF1ZXN0aW9uU3RhcnRlZEF0KSAvIDEwMDA7CiAgICBjb25zdCByZW1haW5pbmcgPSBNYXRoLm1heCgwLCBNYXRoLmNlaWwocm9vbS5xdWVzdGlvbi50aW1lTGltaXQgLSBlbGFwc2VkKSk7CiAgICBlbC50ZXh0Q29udGVudCA9IHJlbWFpbmluZzsKICB9OwogIHRpY2soKTsKICBzdGF0ZS50aW1lckludGVydmFsID0gc2V0SW50ZXJ2YWwodGljaywgMjUwKTsKfQoKZnVuY3Rpb24gc3RhcnRPcGVuaW5nQ291bnRkb3duKHJvb20pIHsKICBjbGVhclRpbWVyKCk7CiAgY29uc3QgZWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnb3BlbmluZy1jb3VudGRvd24tbnVtYmVyJyk7CiAgaWYgKCFlbCB8fCAhcm9vbS5jb3VudGRvd25TdGFydGVkQXQpIHJldHVybjsKICBjb25zdCBzZWNvbmRzID0gTnVtYmVyKHJvb20uY291bnRkb3duU2Vjb25kcyB8fCAzKTsKICBjb25zdCB0aWNrID0gKCkgPT4gewogICAgY29uc3QgZWxhcHNlZCA9IChEYXRlLm5vdygpIC0gcm9vbS5jb3VudGRvd25TdGFydGVkQXQpIC8gMTAwMDsKICAgIGNvbnN0IHJlbWFpbmluZyA9IE1hdGgubWF4KDEsIE1hdGguY2VpbChzZWNvbmRzIC0gZWxhcHNlZCkpOwogICAgZWwudGV4dENvbnRlbnQgPSByZW1haW5pbmc7CiAgICBlbC5jbGFzc0xpc3QucmVtb3ZlKCdjb3VudGRvd24tcG9wJyk7CiAgICB2b2lkIGVsLm9mZnNldFdpZHRoOwogICAgZWwuY2xhc3NMaXN0LmFkZCgnY291bnRkb3duLXBvcCcpOwogIH07CiAgdGljaygpOwogIHN0YXRlLnRpbWVySW50ZXJ2YWwgPSBzZXRJbnRlcnZhbCh0aWNrLCAxODApOwp9CgpmdW5jdGlvbiBvcGVuaW5nQ291bnRkb3duTWFya3VwKHJvb20sIHJvbGUgPSAncGxheWVyJykgewogIGNvbnN0IHN1YnRpdGxlID0gcm9sZSA9PT0gJ3BsYXllcicKICAgID8gJ1ByZXBhcmUtc2UuIEEgcHJpbWVpcmEgcGVyZ3VudGEgdmFpIGFwYXJlY2VyLicKICAgIDogJ1RvZG9zIHByb250b3MuIEEgcHJpbWVpcmEgcGVyZ3VudGEgY29tZcOnYSBlbSBpbnN0YW50ZXMuJzsKICByZXR1cm4gYDxkaXYgY2xhc3M9InN0YXJ0LWNvdW50ZG93bi1zY3JlZW4iPjxkaXYgY2xhc3M9InN0YXJ0LWNvdW50ZG93bi1jYXJkIj48ZGl2IGNsYXNzPSJjb3VudGRvd24tYnJhbmQiPjxzcGFuIGNsYXNzPSJwcmVzZW50ZXItYnJhbmQtbWFyayI+PC9zcGFuPjxzdHJvbmc+UXVpeiBDcmVkc3lzdGVtPC9zdHJvbmc+PC9kaXY+PHA+JHtzdWJ0aXRsZX08L3A+PGRpdiBpZD0ib3BlbmluZy1jb3VudGRvd24tbnVtYmVyIiBjbGFzcz0ib3BlbmluZy1jb3VudGRvd24tbnVtYmVyIj4ke3Jvb20uY291bnRkb3duU2Vjb25kcyB8fCAzfTwvZGl2PjxzcGFuPkNvbWXDp2FuZG8uLi48L3NwYW4+PC9kaXY+PC9kaXY+YDsKfQoKZnVuY3Rpb24gYXZhdGFyVmlzdWFsKGF2YXRhciwgc21hbGwgPSBmYWxzZSkgewogIGNvbnN0IHNpemVDbGFzcyA9IHNtYWxsID8gJ21pbmktYXZhdGFyJyA6ICdhdmF0YXItdmlzdWFsJzsKICByZXR1cm4gYDxzcGFuIGNsYXNzPSIke3NpemVDbGFzc30iIHN0eWxlPSJiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCgxMzVkZWcsJHthdmF0YXIuY29sb3JzWzBdfSwke2F2YXRhci5jb2xvcnNbMV19KSI+JHthdmF0YXIuZW1vaml9PC9zcGFuPmA7Cn0KCmZ1bmN0aW9uIHBoYXNlTGFiZWwocGhhc2UpIHsKICByZXR1cm4gKHsgbG9iYnk6ICdTYWxhIGRlIGVzcGVyYScsIGNvdW50ZG93bjogJ0NvbWXDp2FuZG8nLCBxdWVzdGlvbjogJ1Blcmd1bnRhIGFiZXJ0YScsIGFuc3dlcjogJ1Jlc3Bvc3RhIHJldmVsYWRhJywgcmFua2luZzogJ1JhbmtpbmcnLCBmaW5pc2hlZDogJ0VuY2VycmFkbycgfSlbcGhhc2VdIHx8IHBoYXNlOwp9CgpmdW5jdGlvbiByZW5kZXJRcihlbGVtZW50SWQsIHRleHQsIHNpemUgPSAyNDApIHsKICByZXF1ZXN0QW5pbWF0aW9uRnJhbWUoKCkgPT4gewogICAgY29uc3QgZWxlbWVudCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKGVsZW1lbnRJZCk7CiAgICBpZiAoIWVsZW1lbnQgfHwgIXdpbmRvdy5RUkNvZGUpIHJldHVybjsKICAgIGVsZW1lbnQuaW5uZXJIVE1MID0gJyc7CiAgICBuZXcgUVJDb2RlKGVsZW1lbnQsIHsKICAgICAgdGV4dCwKICAgICAgd2lkdGg6IHNpemUsCiAgICAgIGhlaWdodDogc2l6ZSwKICAgICAgY29sb3JEYXJrOiAnIzE3MTgyMCcsCiAgICAgIGNvbG9yTGlnaHQ6ICcjZmZmZmZmJywKICAgICAgY29ycmVjdExldmVsOiBRUkNvZGUuQ29ycmVjdExldmVsLkgsCiAgICB9KTsKICB9KTsKfQoKYXN5bmMgZnVuY3Rpb24gY29weVRleHQodGV4dCkgewogIHRyeSB7CiAgICBhd2FpdCBuYXZpZ2F0b3IuY2xpcGJvYXJkLndyaXRlVGV4dCh0ZXh0KTsKICAgIHNob3dUb2FzdCgnTGluayBjb3BpYWRvLicpOwogIH0gY2F0Y2ggKGVycm9yKSB7CiAgICBjb25zdCB0ZW1wID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgndGV4dGFyZWEnKTsKICAgIHRlbXAudmFsdWUgPSB0ZXh0OwogICAgZG9jdW1lbnQuYm9keS5hcHBlbmRDaGlsZCh0ZW1wKTsKICAgIHRlbXAuc2VsZWN0KCk7CiAgICBkb2N1bWVudC5leGVjQ29tbWFuZCgnY29weScpOwogICAgdGVtcC5yZW1vdmUoKTsKICAgIHNob3dUb2FzdCgnTGluayBjb3BpYWRvLicpOwogIH0KfQoKLy8gTcO6c2ljYSBnZXJhZGEgbm8gcHLDs3ByaW8gbmF2ZWdhZG9yLCBzZW0gYXJxdWl2b3MgZXh0ZXJub3Mgb3UgZGlyZWl0b3MgYXV0b3JhaXMuCi8vIE9zIG5hdmVnYWRvcmVzIHPDsyBsaWJlcmFtIMOhdWRpbyBkZXBvaXMgZGUgdW0gY2xpcXVlIGRvIHVzdcOhcmlvLiBQb3IgaXNzbywgYQovLyBhcHJlc2VudGHDp8OjbyBleGliZSB1bWEgY29uZmlybWHDp8OjbyBkZSBzb20gYW50ZXMgZGUgY29tZcOnYXIgYSB0cmlsaGEuCmZ1bmN0aW9uIGVuc3VyZUF1ZGlvKCkgewogIGlmICghc3RhdGUuYXVkaW8uZW5hYmxlZCkgcmV0dXJuIG51bGw7CiAgaWYgKCFzdGF0ZS5hdWRpby5jb250ZXh0KSB7CiAgICBjb25zdCBBdWRpb0NvbnRleHRDbGFzcyA9IHdpbmRvdy5BdWRpb0NvbnRleHQgfHwgd2luZG93LndlYmtpdEF1ZGlvQ29udGV4dDsKICAgIGlmICghQXVkaW9Db250ZXh0Q2xhc3MpIHJldHVybiBudWxsOwogICAgc3RhdGUuYXVkaW8uY29udGV4dCA9IG5ldyBBdWRpb0NvbnRleHRDbGFzcygpOwogICAgc3RhdGUuYXVkaW8ubWFzdGVyR2FpbiA9IHN0YXRlLmF1ZGlvLmNvbnRleHQuY3JlYXRlR2FpbigpOwogICAgc3RhdGUuYXVkaW8ubWFzdGVyR2Fpbi5nYWluLnZhbHVlID0gLjk7CiAgICBzdGF0ZS5hdWRpby5tYXN0ZXJHYWluLmNvbm5lY3Qoc3RhdGUuYXVkaW8uY29udGV4dC5kZXN0aW5hdGlvbik7CiAgfQogIHJldHVybiBzdGF0ZS5hdWRpby5jb250ZXh0Owp9Cgphc3luYyBmdW5jdGlvbiB1bmxvY2tBdWRpbygpIHsKICBjb25zdCBjb250ZXh0ID0gZW5zdXJlQXVkaW8oKTsKICBpZiAoIWNvbnRleHQpIHJldHVybiBmYWxzZTsKICB0cnkgewogICAgaWYgKGNvbnRleHQuc3RhdGUgPT09ICdzdXNwZW5kZWQnKSBhd2FpdCBjb250ZXh0LnJlc3VtZSgpOwogICAgLy8gUHVsc28gc2lsZW5jaW9zbyBwYXJhIGNvbmZpcm1hciBhIGxpYmVyYcOnw6NvIGRvIMOhdWRpbyBlbSBTYWZhcmkvQ2hyb21lIG3Ds3ZlbC4KICAgIGNvbnN0IGJ1ZmZlciA9IGNvbnRleHQuY3JlYXRlQnVmZmVyKDEsIDEsIGNvbnRleHQuc2FtcGxlUmF0ZSk7CiAgICBjb25zdCBzb3VyY2UgPSBjb250ZXh0LmNyZWF0ZUJ1ZmZlclNvdXJjZSgpOwogICAgc291cmNlLmJ1ZmZlciA9IGJ1ZmZlcjsKICAgIHNvdXJjZS5jb25uZWN0KHN0YXRlLmF1ZGlvLm1hc3RlckdhaW4gfHwgY29udGV4dC5kZXN0aW5hdGlvbik7CiAgICBzb3VyY2Uuc3RhcnQoMCk7CiAgICBzdGF0ZS5hdWRpby51bmxvY2tlZCA9IGNvbnRleHQuc3RhdGUgPT09ICdydW5uaW5nJzsKICAgIHJldHVybiBzdGF0ZS5hdWRpby51bmxvY2tlZDsKICB9IGNhdGNoIChlcnJvcikgewogICAgc3RhdGUuYXVkaW8udW5sb2NrZWQgPSBmYWxzZTsKICAgIHJldHVybiBmYWxzZTsKICB9Cn0KCmZ1bmN0aW9uIHBsYXlOb3RlKGZyZXF1ZW5jeSwgZHVyYXRpb24gPSAuMTIsIHR5cGUgPSAnc2luZScsIHZvbHVtZSA9IC4wNDUsIGRlbGF5ID0gMCkgewogIGNvbnN0IGNvbnRleHQgPSBlbnN1cmVBdWRpbygpOwogIGlmICghY29udGV4dCB8fCAhc3RhdGUuYXVkaW8udW5sb2NrZWQgfHwgY29udGV4dC5zdGF0ZSAhPT0gJ3J1bm5pbmcnKSByZXR1cm47CiAgY29uc3Qgb3NjaWxsYXRvciA9IGNvbnRleHQuY3JlYXRlT3NjaWxsYXRvcigpOwogIGNvbnN0IGdhaW4gPSBjb250ZXh0LmNyZWF0ZUdhaW4oKTsKICBvc2NpbGxhdG9yLnR5cGUgPSB0eXBlOwogIG9zY2lsbGF0b3IuZnJlcXVlbmN5LnZhbHVlID0gZnJlcXVlbmN5OwogIGdhaW4uZ2Fpbi5zZXRWYWx1ZUF0VGltZSgwLjAwMDEsIGNvbnRleHQuY3VycmVudFRpbWUgKyBkZWxheSk7CiAgZ2Fpbi5nYWluLmV4cG9uZW50aWFsUmFtcFRvVmFsdWVBdFRpbWUodm9sdW1lLCBjb250ZXh0LmN1cnJlbnRUaW1lICsgZGVsYXkgKyAuMDEyKTsKICBnYWluLmdhaW4uZXhwb25lbnRpYWxSYW1wVG9WYWx1ZUF0VGltZSgwLjAwMDEsIGNvbnRleHQuY3VycmVudFRpbWUgKyBkZWxheSArIGR1cmF0aW9uKTsKICBvc2NpbGxhdG9yLmNvbm5lY3QoZ2FpbikuY29ubmVjdChzdGF0ZS5hdWRpby5tYXN0ZXJHYWluIHx8IGNvbnRleHQuZGVzdGluYXRpb24pOwogIG9zY2lsbGF0b3Iuc3RhcnQoY29udGV4dC5jdXJyZW50VGltZSArIGRlbGF5KTsKICBvc2NpbGxhdG9yLnN0b3AoY29udGV4dC5jdXJyZW50VGltZSArIGRlbGF5ICsgZHVyYXRpb24gKyAuMDMpOwp9CgpmdW5jdGlvbiBzdG9wTXVzaWMoKSB7CiAgaWYgKHN0YXRlLmF1ZGlvLnRpbWVyKSBjbGVhckludGVydmFsKHN0YXRlLmF1ZGlvLnRpbWVyKTsKICBzdGF0ZS5hdWRpby50aW1lciA9IG51bGw7CiAgc3RhdGUuYXVkaW8uYWN0aXZlVGhlbWUgPSBudWxsOwogIHN0YXRlLmF1ZGlvLnN0ZXAgPSAwOwp9CgpmdW5jdGlvbiBzdGFydE11c2ljKHRoZW1lKSB7CiAgaWYgKCFzdGF0ZS5hdWRpby5lbmFibGVkIHx8ICFzdGF0ZS5hdWRpby51bmxvY2tlZCB8fCB0aGVtZSA9PT0gJ25vbmUnKSB7CiAgICBzdG9wTXVzaWMoKTsKICAgIHJldHVybjsKICB9CiAgaWYgKHN0YXRlLmF1ZGlvLmFjdGl2ZVRoZW1lID09PSB0aGVtZSAmJiBzdGF0ZS5hdWRpby50aW1lcikgcmV0dXJuOwogIHN0b3BNdXNpYygpOwogIHN0YXRlLmF1ZGlvLmFjdGl2ZVRoZW1lID0gdGhlbWU7CiAgY29uc3QgcGF0dGVybnMgPSB7CiAgICBwdWxzZTogWzI2MS42MywgMzI5LjYzLCAzOTIuMDAsIDMyOS42MywgMjkzLjY2LCAzNjkuOTksIDQ0MC4wMCwgMzY5Ljk5XSwKICAgIHVwYmVhdDogWzMyOS42MywgMzkyLjAwLCA0OTMuODgsIDU4Ny4zMywgNDkzLjg4LCAzOTIuMDAsIDM0OS4yMywgNDQwLjAwXSwKICAgIGZvY3VzOiBbMjIwLjAwLCAyNzcuMTgsIDMyOS42MywgMjc3LjE4LCAxOTYuMDAsIDI0Ni45NCwgMjkzLjY2LCAyNDYuOTRdLAogIH07CiAgY29uc3QgcGF0dGVybiA9IHBhdHRlcm5zW3RoZW1lXSB8fCBwYXR0ZXJucy5wdWxzZTsKICBjb25zdCBpbnRlcnZhbCA9IHRoZW1lID09PSAnZm9jdXMnID8gNjIwIDogMzYwOwogIGNvbnN0IHRpY2sgPSAoKSA9PiB7CiAgICBjb25zdCBub3RlID0gcGF0dGVybltzdGF0ZS5hdWRpby5zdGVwICUgcGF0dGVybi5sZW5ndGhdOwogICAgcGxheU5vdGUobm90ZSwgdGhlbWUgPT09ICdmb2N1cycgPyAuNDQgOiAuMjAsIHRoZW1lID09PSAncHVsc2UnID8gJ3RyaWFuZ2xlJyA6ICdzaW5lJywgdGhlbWUgPT09ICdmb2N1cycgPyAuMDM1IDogLjA1KTsKICAgIGlmIChzdGF0ZS5hdWRpby5zdGVwICUgNCA9PT0gMCkgcGxheU5vdGUodGhlbWUgPT09ICd1cGJlYXQnID8gOTggOiA4Mi40MSwgLjExLCAnc2luZScsIC4wNjUpOwogICAgc3RhdGUuYXVkaW8uc3RlcCArPSAxOwogIH07CiAgdGljaygpOwogIHN0YXRlLmF1ZGlvLnRpbWVyID0gc2V0SW50ZXJ2YWwodGljaywgaW50ZXJ2YWwpOwp9CgpmdW5jdGlvbiBwbGF5U3VzcGVuc2UoKSB7CiAgc3RvcE11c2ljKCk7CiAgaWYgKCFzdGF0ZS5hdWRpby5lbmFibGVkIHx8ICFzdGF0ZS5hdWRpby51bmxvY2tlZCkgcmV0dXJuOwogIGNvbnN0IG5vdGVzID0gWzExMCwgMTIzLjQ3LCAxMzguNTksIDE1NS41NiwgMTc0LjYxLCAxOTYsIDIyMCwgMjQ2Ljk0XTsKICBub3Rlcy5mb3JFYWNoKChub3RlLCBpbmRleCkgPT4gewogICAgcGxheU5vdGUobm90ZSwgLjM0LCAnc2F3dG9vdGgnLCAuMDQ1ICsgaW5kZXggKiAuMDAzLCBpbmRleCAqIC4zOCk7CiAgICBwbGF5Tm90ZSg1NSwgLjA5LCAnc2luZScsIC4wNzUsIGluZGV4ICogLjM4KTsKICB9KTsKICBwbGF5Tm90ZSg1MjMuMjUsIC43NSwgJ3RyaWFuZ2xlJywgLjExLCBub3Rlcy5sZW5ndGggKiAuMzggKyAuMSk7Cn0KCmZ1bmN0aW9uIHN5bmNNdXNpYyhyb29tKSB7CiAgaWYgKCFyb29tIHx8ICFbJ2FkbWluJywgJ3NjcmVlbiddLmluY2x1ZGVzKHN0YXRlLnJvb21Sb2xlKSkgewogICAgc3RvcE11c2ljKCk7CiAgICByZXR1cm47CiAgfQogIGlmICghc3RhdGUuYXVkaW8uZW5hYmxlZCB8fCAhc3RhdGUuYXVkaW8udW5sb2NrZWQpIHJldHVybjsKICBpZiAocm9vbS5waGFzZSA9PT0gJ3JhbmtpbmcnKSByZXR1cm47CiAgaWYgKHJvb20ucGhhc2UgPT09ICdmaW5pc2hlZCcgfHwgcm9vbS5waGFzZSA9PT0gJ2Fuc3dlcicpIHN0b3BNdXNpYygpOwogIGVsc2UgaWYgKHJvb20ucGhhc2UgPT09ICdxdWVzdGlvbicgfHwgcm9vbS5waGFzZSA9PT0gJ2xvYmJ5Jykgc3RhcnRNdXNpYyhyb29tLm11c2ljVGhlbWUpOwp9Cgphc3luYyBmdW5jdGlvbiB0b2dnbGVBdWRpbygpIHsKICBpZiAoc3RhdGUuYXVkaW8uZW5hYmxlZCAmJiBzdGF0ZS5hdWRpby51bmxvY2tlZCkgewogICAgc3RhdGUuYXVkaW8uZW5hYmxlZCA9IGZhbHNlOwogICAgc3RvcE11c2ljKCk7CiAgICBzaG93VG9hc3QoJ1NvbSBkZXNhdGl2YWRvLicpOwogIH0gZWxzZSB7CiAgICBzdGF0ZS5hdWRpby5lbmFibGVkID0gdHJ1ZTsKICAgIGNvbnN0IHVubG9ja2VkID0gYXdhaXQgdW5sb2NrQXVkaW8oKTsKICAgIGlmICghdW5sb2NrZWQpIHsKICAgICAgc2hvd1RvYXN0KCdPIG5hdmVnYWRvciBuw6NvIGxpYmVyb3UgbyDDoXVkaW8uIFRvcXVlIG5vdmFtZW50ZSBlbSBBdGl2YXIgc29tLicpOwogICAgfSBlbHNlIHsKICAgICAgc3luY011c2ljKHN0YXRlLnJvb20pOwogICAgICBzaG93VG9hc3QoJ1NvbSBhdGl2YWRvLicpOwogICAgfQogIH0KICBjb25zdCBidXR0b24gPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnYXVkaW8tdG9nZ2xlJyk7CiAgaWYgKGJ1dHRvbikgYnV0dG9uLnRleHRDb250ZW50ID0gc3RhdGUuYXVkaW8uZW5hYmxlZCAmJiBzdGF0ZS5hdWRpby51bmxvY2tlZCA/ICdTb20gbGlnYWRvJyA6ICdBdGl2YXIgc29tJzsKfQoKZnVuY3Rpb24gc2hvd0F1ZGlvR2F0ZSgpIHsKICBjb25zdCByb29tID0gc3RhdGUucm9vbTsKICBpZiAoIXJvb20gfHwgIVsnYWRtaW4nLCAnc2NyZWVuJ10uaW5jbHVkZXMoc3RhdGUucm9vbVJvbGUpKSByZXR1cm47CiAgaWYgKHJvb20ubXVzaWNUaGVtZSA9PT0gJ25vbmUnIHx8IHN0YXRlLmF1ZGlvLnVubG9ja2VkIHx8IHN0YXRlLmF1ZGlvLmdhdGVWaXNpYmxlKSByZXR1cm47CiAgc3RhdGUuYXVkaW8uZ2F0ZVZpc2libGUgPSB0cnVlOwogIGNvbnN0IG92ZXJsYXkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTsKICBvdmVybGF5LmNsYXNzTmFtZSA9ICdhdWRpby1nYXRlJzsKICBvdmVybGF5LmlubmVySFRNTCA9IGAKICAgIDxkaXYgY2xhc3M9ImF1ZGlvLWdhdGUtY2FyZCI+CiAgICAgIDxkaXYgY2xhc3M9ImF1ZGlvLWdhdGUtbWFyayI+4pmqPC9kaXY+CiAgICAgIDxoMj5BdGl2YXIgbcO6c2ljYSBkYSBhcHJlc2VudGHDp8Ojbz88L2gyPgogICAgICA8cD5BIG3DunNpY2EgcHJlY2lzYSBkZSB1bWEgY29uZmlybWHDp8OjbyBhbnRlcyBkZSB0b2NhciBuZXN0ZSBuYXZlZ2Fkb3IuPC9wPgogICAgICA8YnV0dG9uIGlkPSJhdWRpby1nYXRlLWVuYWJsZSIgY2xhc3M9ImJ0biBidG4tcHJpbWFyeSBidG4tbGFyZ2UgYnRuLWJsb2NrIj5BdGl2YXIgc29tPC9idXR0b24+CiAgICAgIDxidXR0b24gaWQ9ImF1ZGlvLWdhdGUtc2tpcCIgY2xhc3M9ImJ0biBidG4tbGlnaHQgYnRuLWJsb2NrIj5Db250aW51YXIgc2VtIHNvbTwvYnV0dG9uPgogICAgPC9kaXY+YDsKICBkb2N1bWVudC5ib2R5LmFwcGVuZENoaWxkKG92ZXJsYXkpOwogIG92ZXJsYXkucXVlcnlTZWxlY3RvcignI2F1ZGlvLWdhdGUtZW5hYmxlJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBhc3luYyAoKSA9PiB7CiAgICBjb25zdCB1bmxvY2tlZCA9IGF3YWl0IHVubG9ja0F1ZGlvKCk7CiAgICBpZiAoIXVubG9ja2VkKSByZXR1cm4gc2hvd1RvYXN0KCdOw6NvIGZvaSBwb3Nzw612ZWwgYXRpdmFyIG8gc29tLiBUZW50ZSBub3ZhbWVudGUuJyk7CiAgICBzdGF0ZS5hdWRpby5nYXRlVmlzaWJsZSA9IGZhbHNlOwogICAgb3ZlcmxheS5yZW1vdmUoKTsKICAgIHN5bmNNdXNpYyhzdGF0ZS5yb29tKTsKICAgIGNvbnN0IGJ1dHRvbiA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdhdWRpby10b2dnbGUnKTsKICAgIGlmIChidXR0b24pIGJ1dHRvbi50ZXh0Q29udGVudCA9ICdTb20gbGlnYWRvJzsKICB9KTsKICBvdmVybGF5LnF1ZXJ5U2VsZWN0b3IoJyNhdWRpby1nYXRlLXNraXAnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHsKICAgIHN0YXRlLmF1ZGlvLmVuYWJsZWQgPSBmYWxzZTsKICAgIHN0YXRlLmF1ZGlvLnVubG9ja2VkID0gdHJ1ZTsKICAgIHN0YXRlLmF1ZGlvLmdhdGVWaXNpYmxlID0gZmFsc2U7CiAgICBzdG9wTXVzaWMoKTsKICAgIG92ZXJsYXkucmVtb3ZlKCk7CiAgICBjb25zdCBidXR0b24gPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnYXVkaW8tdG9nZ2xlJyk7CiAgICBpZiAoYnV0dG9uKSBidXR0b24udGV4dENvbnRlbnQgPSAnQXRpdmFyIHNvbSc7CiAgfSk7Cn0KCmFzeW5jIGZ1bmN0aW9uIGluaXQoKSB7CiAgdHJ5IHsKICAgIGNvbnN0IGNvbmZpZyA9IGF3YWl0IGFwaSgnL2FwaS9wdWJsaWMvY29uZmlnJyk7CiAgICBzdGF0ZS5jb25maWcgPSBjb25maWc7CiAgfSBjYXRjaCAoZXJyb3IpIHsKICAgIGFwcC5pbm5lckhUTUwgPSBgPGRpdiBjbGFzcz0id2FpdC1zY3JlZW4iPjxkaXYgY2xhc3M9IndhaXQtY2FyZCI+PGgxPlNpc3RlbWEgaW5pY2lhbmRvPC9oMT48cD4ke2VzY2FwZUh0bWwoZXJyb3IubWVzc2FnZSl9PC9wPjxidXR0b24gY2xhc3M9ImJ0biBidG4tbGlnaHQiIG9uY2xpY2s9ImxvY2F0aW9uLnJlbG9hZCgpIj5UZW50YXIgbm92YW1lbnRlPC9idXR0b24+PC9kaXY+PC9kaXY+YDsKICAgIHJldHVybjsKICB9CgogIGNvbnN0IHByZXNlbnRlciA9IHBhcmFtcy5nZXQoJ3ByZXNlbnRlcicpOwogIGNvbnN0IHNjcmVlbiA9IHBhcmFtcy5nZXQoJ3NjcmVlbicpOwogIGNvbnN0IHJvb20gPSBwYXJhbXMuZ2V0KCdyb29tJyk7CiAgaWYgKHByZXNlbnRlcikgcmV0dXJuIG9wZW5QcmVzZW50ZXIocHJlc2VudGVyKTsKICBpZiAoc2NyZWVuKSByZXR1cm4gb3BlblNjcmVlbihzY3JlZW4pOwogIGlmIChyb29tKSByZXR1cm4gb3BlblBsYXllcihyb29tLCBwYXJhbXMuZ2V0KCdrZXknKSB8fCAnJyk7CiAgcmVuZGVySG9tZSgpOwp9CgpmdW5jdGlvbiByZW5kZXJIb21lKCkgewogIGNsZWFyVGltZXIoKTsKICBzdG9wTXVzaWMoKTsKICBzdGF0ZS5yb29tUm9sZSA9ICdob21lJzsKICBhcHAuaW5uZXJIVE1MID0gYAogICAgPG1haW4gY2xhc3M9Im1pbmltYWwtaG9tZSI+CiAgICAgIDxzZWN0aW9uIGNsYXNzPSJtaW5pbWFsLWhvbWUtY2FyZCI+CiAgICAgICAgJHticmFuZE1hcmt1cCgpfQogICAgICAgIDxkaXYgY2xhc3M9Im1pbmltYWwtaG9tZS1jb3B5Ij4KICAgICAgICAgIDxoMT5FbnRyZSBubyBxdWl6PC9oMT4KICAgICAgICAgIDxwPkRpZ2l0ZSBvIGPDs2RpZ28gZXhpYmlkbyBwZWxvIGFwcmVzZW50YWRvci48L3A+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0ibWluaW1hbC1jb2RlLXJvdyI+CiAgICAgICAgICA8aW5wdXQgaWQ9ImhvbWUtcm9vbS1jb2RlIiBjbGFzcz0iaW5wdXQgY29kZS1pbnB1dCIgaW5wdXRtb2RlPSJudW1lcmljIiBtYXhsZW5ndGg9IjYiIGF1dG9jb21wbGV0ZT0ib25lLXRpbWUtY29kZSIgcGxhY2Vob2xkZXI9IjAwMDAwMCIgYXJpYS1sYWJlbD0iQ8OzZGlnbyBkYSBzYWxhIj4KICAgICAgICAgIDxidXR0b24gaWQ9ImpvaW4taG9tZSIgY2xhc3M9ImJ0biBidG4tcHJpbWFyeSBidG4tbGFyZ2UiPkVudHJhcjwvYnV0dG9uPgogICAgICAgIDwvZGl2PgogICAgICAgIDxidXR0b24gaWQ9ImFkbWluLWhvbWUiIGNsYXNzPSJtaW5pbWFsLWFkbWluLWxpbmsiPkFjZXNzYXIgw6FyZWEgYWRtaW5pc3RyYXRpdmE8L2J1dHRvbj4KICAgICAgPC9zZWN0aW9uPgogICAgPC9tYWluPmA7CiAgY29uc3QgaW5wdXQgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnaG9tZS1yb29tLWNvZGUnKTsKICBpbnB1dC5hZGRFdmVudExpc3RlbmVyKCdpbnB1dCcsICgpID0+IGlucHV0LnZhbHVlID0gaW5wdXQudmFsdWUucmVwbGFjZSgvXEQvZywgJycpLnNsaWNlKDAsIDYpKTsKICBjb25zdCBwcm9jZWVkID0gKCkgPT4gewogICAgaWYgKGlucHV0LnZhbHVlLmxlbmd0aCAhPT0gNikgcmV0dXJuIHNob3dUb2FzdCgnRGlnaXRlIG9zIHNlaXMgbsO6bWVyb3MgZGEgc2FsYS4nKTsKICAgIGxvY2F0aW9uLmhyZWYgPSBgLz9yb29tPSR7ZW5jb2RlVVJJQ29tcG9uZW50KGlucHV0LnZhbHVlKX1gOwogIH07CiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2pvaW4taG9tZScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgcHJvY2VlZCk7CiAgaW5wdXQuYWRkRXZlbnRMaXN0ZW5lcigna2V5ZG93bicsIChldmVudCkgPT4geyBpZiAoZXZlbnQua2V5ID09PSAnRW50ZXInKSBwcm9jZWVkKCk7IH0pOwogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdhZG1pbi1ob21lJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBvcGVuQWRtaW4pOwogIHJlcXVlc3RBbmltYXRpb25GcmFtZSgoKSA9PiBpbnB1dC5mb2N1cygpKTsKfQoKZnVuY3Rpb24gcmVuZGVyQ29kZUVudHJ5KCkgewogIGFwcC5pbm5lckhUTUwgPSBgCiAgICAke3RvcGJhcihgPGJ1dHRvbiBpZD0iYmFjay1ob21lIiBjbGFzcz0iYnRuIGJ0bi1saWdodCI+Vm9sdGFyPC9idXR0b24+YCl9CiAgICA8bWFpbiBjbGFzcz0iY29udGFpbmVyIG5hcnJvdyI+CiAgICAgIDxkaXYgY2xhc3M9ImNhcmQgdGV4dC1jZW50ZXIiIHN0eWxlPSJtYXJnaW4tdG9wOjUwcHgiPgogICAgICAgIDxkaXYgY2xhc3M9ImV5ZWJyb3ciPkVudHJhZGEgZG8gcGFydGljaXBhbnRlPC9kaXY+CiAgICAgICAgPGgxPkRpZ2l0ZSBvIGPDs2RpZ28gZGEgc2FsYTwvaDE+CiAgICAgICAgPHAgY2xhc3M9Im11dGVkIj5PIGPDs2RpZ28gZGUgc2VpcyBuw7ptZXJvcyBhcGFyZWNlIG5hIHRlbGEgZG8gYXByZXNlbnRhZG9yLjwvcD4KICAgICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGlucHV0IGlkPSJyb29tLWNvZGUiIGNsYXNzPSJpbnB1dCBjb2RlLWlucHV0IiBpbnB1dG1vZGU9Im51bWVyaWMiIG1heGxlbmd0aD0iNiIgcGxhY2Vob2xkZXI9IjAwMDAwMCI+PC9kaXY+CiAgICAgICAgPGJ1dHRvbiBpZD0iY29udGludWUtcm9vbSIgY2xhc3M9ImJ0biBidG4tcHJpbWFyeSBidG4tbGFyZ2UgYnRuLWJsb2NrIj5Db250aW51YXI8L2J1dHRvbj4KICAgICAgPC9kaXY+CiAgICA8L21haW4+YDsKICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnYmFjay1ob21lJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCByZW5kZXJIb21lKTsKICBjb25zdCBpbnB1dCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdyb29tLWNvZGUnKTsKICBpbnB1dC5hZGRFdmVudExpc3RlbmVyKCdpbnB1dCcsICgpID0+IGlucHV0LnZhbHVlID0gaW5wdXQudmFsdWUucmVwbGFjZSgvXEQvZywgJycpLnNsaWNlKDAsIDYpKTsKICBjb25zdCBwcm9jZWVkID0gKCkgPT4gewogICAgaWYgKGlucHV0LnZhbHVlLmxlbmd0aCAhPT0gNikgcmV0dXJuIHNob3dUb2FzdCgnRGlnaXRlIG9zIHNlaXMgbsO6bWVyb3MgZGEgc2FsYS4nKTsKICAgIGxvY2F0aW9uLmhyZWYgPSBgLz9yb29tPSR7ZW5jb2RlVVJJQ29tcG9uZW50KGlucHV0LnZhbHVlKX1gOwogIH07CiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2NvbnRpbnVlLXJvb20nKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIHByb2NlZWQpOwogIGlucHV0LmFkZEV2ZW50TGlzdGVuZXIoJ2tleWRvd24nLCAoZXZlbnQpID0+IHsgaWYgKGV2ZW50LmtleSA9PT0gJ0VudGVyJykgcHJvY2VlZCgpOyB9KTsKfQoKYXN5bmMgZnVuY3Rpb24gb3BlbkFkbWluKCkgewogIHBhcmFtcy5kZWxldGUoJ3Jvb20nKTsgcGFyYW1zLmRlbGV0ZSgncHJlc2VudGVyJyk7IHBhcmFtcy5kZWxldGUoJ3NjcmVlbicpOwogIGhpc3RvcnkucmVwbGFjZVN0YXRlKHt9LCAnJywgJy8/YWRtaW49MScpOwogIGNvbnN0IHN0b3JlZCA9IHNlc3Npb25TdG9yYWdlLmdldEl0ZW0oQVVUSF9LRVkpOwogIGlmIChzdG9yZWQpIHsKICAgIHRyeSB7CiAgICAgIHN0YXRlLmF1dGggPSBKU09OLnBhcnNlKHN0b3JlZCk7CiAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGFwaSgnL2FwaS9hZG1pbi9zZXNzaW9uJywgeyBhdXRoVG9rZW46IHN0YXRlLmF1dGguYXV0aFRva2VuIH0pOwogICAgICBzdGF0ZS5hdXRoLmFkbWluID0gcmVzdWx0LmFkbWluOwogICAgICBzdGF0ZS5hdXRoLnBlcnNpc3RlbmNlTW9kZSA9IHJlc3VsdC5wZXJzaXN0ZW5jZU1vZGU7CiAgICAgIHJldHVybiBsb2FkRGFzaGJvYXJkKCk7CiAgICB9IGNhdGNoIChlcnJvcikgewogICAgICBzZXNzaW9uU3RvcmFnZS5yZW1vdmVJdGVtKEFVVEhfS0VZKTsKICAgICAgc3RhdGUuYXV0aCA9IG51bGw7CiAgICB9CiAgfQogIGlmIChzdGF0ZS5jb25maWcuc2V0dXBSZXF1aXJlZCkgcmVuZGVyU2V0dXAoKTsKICBlbHNlIHJlbmRlckxvZ2luKCk7Cn0KCmZ1bmN0aW9uIHJlbmRlclNldHVwKCkgewogIGFwcC5pbm5lckhUTUwgPSBgCiAgICAke3RvcGJhcihgPGJ1dHRvbiBpZD0ic2V0dXAtaG9tZSIgY2xhc3M9ImJ0biBidG4tbGlnaHQiPlZvbHRhcjwvYnV0dG9uPmApfQogICAgPG1haW4gY2xhc3M9ImNvbnRhaW5lciBuYXJyb3ciPgogICAgICA8ZGl2IGNsYXNzPSJjYXJkIiBzdHlsZT0ibWFyZ2luLXRvcDo0MnB4Ij4KICAgICAgICA8ZGl2IGNsYXNzPSJleWVicm93Ij5QcmltZWlybyBhY2Vzc288L2Rpdj4KICAgICAgICA8aDE+Q3JpZSBvIGFkbWluaXN0cmFkb3IgcHJpbmNpcGFsPC9oMT4KICAgICAgICA8cCBjbGFzcz0ibXV0ZWQiPkVzc2EgdGVsYSBzZXLDoSBibG9xdWVhZGEgYXV0b21hdGljYW1lbnRlIGRlcG9pcyBkYSBjcmlhw6fDo28uPC9wPgogICAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWwgZm9yPSJzZXR1cC1uYW1lIj5Ob21lPC9sYWJlbD48aW5wdXQgaWQ9InNldHVwLW5hbWUiIGNsYXNzPSJpbnB1dCIgYXV0b2NvbXBsZXRlPSJuYW1lIj48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsIGZvcj0ic2V0dXAtZW1haWwiPkUtbWFpbDwvbGFiZWw+PGlucHV0IGlkPSJzZXR1cC1lbWFpbCIgY2xhc3M9ImlucHV0IiB0eXBlPSJlbWFpbCIgYXV0b2NvbXBsZXRlPSJlbWFpbCI+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbCBmb3I9InNldHVwLXBhc3N3b3JkIj5TZW5oYTwvbGFiZWw+PGlucHV0IGlkPSJzZXR1cC1wYXNzd29yZCIgY2xhc3M9ImlucHV0IiB0eXBlPSJwYXNzd29yZCIgbWlubGVuZ3RoPSI4IiBhdXRvY29tcGxldGU9Im5ldy1wYXNzd29yZCI+PHNtYWxsPk3DrW5pbW8gZGUgb2l0byBjYXJhY3RlcmVzLjwvc21hbGw+PC9kaXY+CiAgICAgICAgPGJ1dHRvbiBpZD0ic2V0dXAtY3JlYXRlIiBjbGFzcz0iYnRuIGJ0bi1wcmltYXJ5IGJ0bi1sYXJnZSBidG4tYmxvY2siPkNyaWFyIGFkbWluaXN0cmFkb3I8L2J1dHRvbj4KICAgICAgPC9kaXY+CiAgICA8L21haW4+YDsKICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnc2V0dXAtaG9tZScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgcmVuZGVySG9tZSk7CiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3NldHVwLWNyZWF0ZScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgYXN5bmMgKCkgPT4gewogICAgdHJ5IHsKICAgICAgZW5zdXJlQXVkaW8oKTsKICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgYXBpKCcvYXBpL3NldHVwL2NyZWF0ZS1hZG1pbicsIHsKICAgICAgICBuYW1lOiBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnc2V0dXAtbmFtZScpLnZhbHVlLAogICAgICAgIGVtYWlsOiBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnc2V0dXAtZW1haWwnKS52YWx1ZSwKICAgICAgICBwYXNzd29yZDogZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3NldHVwLXBhc3N3b3JkJykudmFsdWUsCiAgICAgIH0pOwogICAgICBzdGF0ZS5hdXRoID0gcmVzdWx0OwogICAgICBzZXNzaW9uU3RvcmFnZS5zZXRJdGVtKEFVVEhfS0VZLCBKU09OLnN0cmluZ2lmeShyZXN1bHQpKTsKICAgICAgc3RhdGUuY29uZmlnLnNldHVwUmVxdWlyZWQgPSBmYWxzZTsKICAgICAgYXdhaXQgbG9hZERhc2hib2FyZCgpOwogICAgfSBjYXRjaCAoZXJyb3IpIHsgc2hvd1RvYXN0KGVycm9yLm1lc3NhZ2UpOyB9CiAgfSk7Cn0KCmZ1bmN0aW9uIHJlbmRlckxvZ2luKCkgewogIGFwcC5pbm5lckhUTUwgPSBgCiAgICAke3RvcGJhcihgPGJ1dHRvbiBpZD0ibG9naW4taG9tZSIgY2xhc3M9ImJ0biBidG4tbGlnaHQiPlZvbHRhcjwvYnV0dG9uPmApfQogICAgPG1haW4gY2xhc3M9ImNvbnRhaW5lciBuYXJyb3ciPgogICAgICA8ZGl2IGNsYXNzPSJjYXJkIiBzdHlsZT0ibWFyZ2luLXRvcDo0MnB4Ij4KICAgICAgICA8ZGl2IGNsYXNzPSJleWVicm93Ij7DgXJlYSBhZG1pbmlzdHJhdGl2YTwvZGl2PgogICAgICAgIDxoMT5FbnRyYXIgbm8gcGFpbmVsPC9oMT4KICAgICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsIGZvcj0ibG9naW4tZW1haWwiPkUtbWFpbDwvbGFiZWw+PGlucHV0IGlkPSJsb2dpbi1lbWFpbCIgY2xhc3M9ImlucHV0IiB0eXBlPSJlbWFpbCIgYXV0b2NvbXBsZXRlPSJlbWFpbCI+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbCBmb3I9ImxvZ2luLXBhc3N3b3JkIj5TZW5oYTwvbGFiZWw+PGlucHV0IGlkPSJsb2dpbi1wYXNzd29yZCIgY2xhc3M9ImlucHV0IiB0eXBlPSJwYXNzd29yZCIgYXV0b2NvbXBsZXRlPSJjdXJyZW50LXBhc3N3b3JkIj48L2Rpdj4KICAgICAgICA8YnV0dG9uIGlkPSJsb2dpbi1zdWJtaXQiIGNsYXNzPSJidG4gYnRuLXByaW1hcnkgYnRuLWxhcmdlIGJ0bi1ibG9jayI+RW50cmFyPC9idXR0b24+CiAgICAgIDwvZGl2PgogICAgPC9tYWluPmA7CiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2xvZ2luLWhvbWUnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIHJlbmRlckhvbWUpOwogIGNvbnN0IHN1Ym1pdCA9IGFzeW5jICgpID0+IHsKICAgIHRyeSB7CiAgICAgIGVuc3VyZUF1ZGlvKCk7CiAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGFwaSgnL2FwaS9hZG1pbi9sb2dpbicsIHsKICAgICAgICBlbWFpbDogZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2xvZ2luLWVtYWlsJykudmFsdWUsCiAgICAgICAgcGFzc3dvcmQ6IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdsb2dpbi1wYXNzd29yZCcpLnZhbHVlLAogICAgICB9KTsKICAgICAgc3RhdGUuYXV0aCA9IHJlc3VsdDsKICAgICAgc2Vzc2lvblN0b3JhZ2Uuc2V0SXRlbShBVVRIX0tFWSwgSlNPTi5zdHJpbmdpZnkocmVzdWx0KSk7CiAgICAgIGF3YWl0IGxvYWREYXNoYm9hcmQoKTsKICAgIH0gY2F0Y2ggKGVycm9yKSB7IHNob3dUb2FzdChlcnJvci5tZXNzYWdlKTsgfQogIH07CiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2xvZ2luLXN1Ym1pdCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgc3VibWl0KTsKICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnbG9naW4tcGFzc3dvcmQnKS5hZGRFdmVudExpc3RlbmVyKCdrZXlkb3duJywgKGV2ZW50KSA9PiB7IGlmIChldmVudC5rZXkgPT09ICdFbnRlcicpIHN1Ym1pdCgpOyB9KTsKfQoKYXN5bmMgZnVuY3Rpb24gbG9hZERhc2hib2FyZCgpIHsKICB0cnkgewogICAgY29uc3QgW3F1aXpEYXRhLCBhZG1pbkRhdGFdID0gYXdhaXQgUHJvbWlzZS5hbGwoWwogICAgICBhcGkoJy9hcGkvYWRtaW4vcXVpenplcycsIHsgYXV0aFRva2VuOiBzdGF0ZS5hdXRoLmF1dGhUb2tlbiB9KSwKICAgICAgYXBpKCcvYXBpL2FkbWluL2FkbWlucycsIHsgYXV0aFRva2VuOiBzdGF0ZS5hdXRoLmF1dGhUb2tlbiB9KSwKICAgIF0pOwogICAgc3RhdGUucXVpenplcyA9IHF1aXpEYXRhLnF1aXp6ZXM7CiAgICBzdGF0ZS5hZG1pbnMgPSBhZG1pbkRhdGEuYWRtaW5zOwogICAgc3RhdGUuYXV0aC5wZXJzaXN0ZW5jZU1vZGUgPSBhZG1pbkRhdGEucGVyc2lzdGVuY2VNb2RlOwogICAgcmVuZGVyRGFzaGJvYXJkKCk7CiAgfSBjYXRjaCAoZXJyb3IpIHsKICAgIHNob3dUb2FzdChlcnJvci5tZXNzYWdlKTsKICAgIHNlc3Npb25TdG9yYWdlLnJlbW92ZUl0ZW0oQVVUSF9LRVkpOwogICAgc3RhdGUuYXV0aCA9IG51bGw7CiAgICByZW5kZXJMb2dpbigpOwogIH0KfQoKZnVuY3Rpb24gZGFzaGJvYXJkU2lkZWJhcigpIHsKICBjb25zdCBhZG1pbiA9IHN0YXRlLmF1dGguYWRtaW47CiAgcmV0dXJuIGAKICAgIDxhc2lkZSBjbGFzcz0ic2lkZWJhciBjYXJkIj4KICAgICAgPGRpdiBjbGFzcz0iYWRtaW4tdXNlciI+CiAgICAgICAgPGRpdiBjbGFzcz0iYWRtaW4tYXZhdGFyIj4ke2VzY2FwZUh0bWwoYWRtaW4ubmFtZS5zbGljZSgwLDIpLnRvVXBwZXJDYXNlKCkpfTwvZGl2PgogICAgICAgIDxkaXY+PHN0cm9uZz4ke2VzY2FwZUh0bWwoYWRtaW4ubmFtZSl9PC9zdHJvbmc+PHNtYWxsPiR7ZXNjYXBlSHRtbChhZG1pbi5lbWFpbCl9PC9zbWFsbD48L2Rpdj4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9InNpZGViYXItbWVudSI+CiAgICAgICAgPGJ1dHRvbiBkYXRhLXRhYj0ib3ZlcnZpZXciIGNsYXNzPSJidG4gJHtzdGF0ZS5kYXNoYm9hcmRUYWIgPT09ICdvdmVydmlldycgPyAnYnRuLWRhcmsnIDogJ2J0bi1saWdodCd9Ij7il6sgVmlzw6NvIGdlcmFsPC9idXR0b24+CiAgICAgICAgPGJ1dHRvbiBkYXRhLXRhYj0icXVpenplcyIgY2xhc3M9ImJ0biAke3N0YXRlLmRhc2hib2FyZFRhYiA9PT0gJ3F1aXp6ZXMnID8gJ2J0bi1kYXJrJyA6ICdidG4tbGlnaHQnfSI+4pymIFF1aXp6ZXM8L2J1dHRvbj4KICAgICAgICA8YnV0dG9uIGRhdGEtdGFiPSJhZG1pbnMiIGNsYXNzPSJidG4gJHtzdGF0ZS5kYXNoYm9hcmRUYWIgPT09ICdhZG1pbnMnID8gJ2J0bi1kYXJrJyA6ICdidG4tbGlnaHQnfSI+4pmZIEFkbWluaXN0cmFkb3JlczwvYnV0dG9uPgogICAgICA8L2Rpdj4KICAgIDwvYXNpZGU+YDsKfQoKZnVuY3Rpb24gcmVuZGVyRGFzaGJvYXJkKCkgewogIGNsZWFyVGltZXIoKTsKICBzdG9wTXVzaWMoKTsKICBjb25zdCBtb2RlTm90aWNlID0gc3RhdGUuYXV0aC5wZXJzaXN0ZW5jZU1vZGUgPT09ICdtZW1vcnknCiAgICA/IGA8ZGl2IGNsYXNzPSJub3RpY2UiPuKaoO+4jyBNb2RvIHRlbXBvcsOhcmlvOiBub3ZvcyBhZG1pbmlzdHJhZG9yZXMgZSBxdWl6emVzIHNlcsOjbyBwZXJkaWRvcyBzZSBvIFJlbmRlciByZWluaWNpYXIuIENvbmVjdGUgdW0gUG9zdGdyZVNRTCB1c2FuZG8gREFUQUJBU0VfVVJMIHBhcmEgc2FsdmFyIHBlcm1hbmVudGVtZW50ZS48L2Rpdj5gCiAgICA6IGA8ZGl2IGNsYXNzPSJub3RpY2Ugc3VjY2VzcyI+4pyTIEJhbmNvIGRlIGRhZG9zIGNvbmVjdGFkby4gQWRtaW5pc3RyYWRvcmVzLCBxdWl6emVzIGUgcmVzdWx0YWRvcyBzw6NvIHBlcnNpc3RlbnRlcy48L2Rpdj5gOwoKICBhcHAuaW5uZXJIVE1MID0gYAogICAgJHt0b3BiYXIoYDxidXR0b24gaWQ9ImxvZ291dCIgY2xhc3M9ImJ0biBidG4tbGlnaHQiPlNhaXI8L2J1dHRvbj5gKX0KICAgIDxtYWluIGNsYXNzPSJjb250YWluZXIiPgogICAgICAke21vZGVOb3RpY2V9CiAgICAgIDxkaXYgY2xhc3M9ImRhc2hib2FyZCI+CiAgICAgICAgJHtkYXNoYm9hcmRTaWRlYmFyKCl9CiAgICAgICAgPHNlY3Rpb24gaWQ9ImRhc2hib2FyZC1jb250ZW50Ij4ke2Rhc2hib2FyZENvbnRlbnQoKX08L3NlY3Rpb24+CiAgICAgIDwvZGl2PgogICAgPC9tYWluPmA7CgogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdsb2dvdXQnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHsKICAgIHNlc3Npb25TdG9yYWdlLnJlbW92ZUl0ZW0oQVVUSF9LRVkpOwogICAgc3RhdGUuYXV0aCA9IG51bGw7CiAgICByZW5kZXJIb21lKCk7CiAgfSk7CiAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtdGFiXScpLmZvckVhY2goKGJ1dHRvbikgPT4gYnV0dG9uLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gewogICAgc3RhdGUuZGFzaGJvYXJkVGFiID0gYnV0dG9uLmRhdGFzZXQudGFiOwogICAgc3RhdGUuZWRpdG9yID0gbnVsbDsKICAgIHN0YXRlLnN0YXJ0UXVpeklkID0gbnVsbDsKICAgIHJlbmRlckRhc2hib2FyZCgpOwogIH0pKTsKICBiaW5kRGFzaGJvYXJkQ29udGVudCgpOwp9CgpmdW5jdGlvbiBkYXNoYm9hcmRDb250ZW50KCkgewogIGlmIChzdGF0ZS5kYXNoYm9hcmRUYWIgPT09ICdxdWl6emVzJykgcmV0dXJuIHJlbmRlclF1aXp6ZXNUYWIoKTsKICBpZiAoc3RhdGUuZGFzaGJvYXJkVGFiID09PSAnYWRtaW5zJykgcmV0dXJuIHJlbmRlckFkbWluc1RhYigpOwogIHJldHVybiByZW5kZXJPdmVydmlld1RhYigpOwp9CgpmdW5jdGlvbiByZW5kZXJPdmVydmlld1RhYigpIHsKICBjb25zdCBzdGFydFBhbmVsID0gc3RhdGUuc3RhcnRRdWl6SWQgPyByZW5kZXJTdGFydFBhbmVsKCkgOiAnJzsKICByZXR1cm4gYAogICAgPGRpdiBjbGFzcz0ic2VjdGlvbi10aXRsZSI+PGRpdj48ZGl2IGNsYXNzPSJleWVicm93Ij5QYWluZWwgYW8gdml2bzwvZGl2PjxoMT5PbMOhLCAke2VzY2FwZUh0bWwoc3RhdGUuYXV0aC5hZG1pbi5uYW1lLnNwbGl0KCcgJylbMF0pfTwvaDE+PC9kaXY+PGJ1dHRvbiBpZD0ibmV3LXF1aXotb3ZlcnZpZXciIGNsYXNzPSJidG4gYnRuLXByaW1hcnkiPisgQ3JpYXIgcXVpejwvYnV0dG9uPjwvZGl2PgogICAgPGRpdiBjbGFzcz0iZ3JpZC00IiBzdHlsZT0ibWFyZ2luLWJvdHRvbToyMnB4Ij4KICAgICAgPGRpdiBjbGFzcz0ibWV0cmljIj48c3Bhbj5RdWl6emVzPC9zcGFuPjxzdHJvbmc+JHtzdGF0ZS5xdWl6emVzLmxlbmd0aH08L3N0cm9uZz48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0ibWV0cmljIj48c3Bhbj5BZG1pbmlzdHJhZG9yZXM8L3NwYW4+PHN0cm9uZz4ke3N0YXRlLmFkbWlucy5maWx0ZXIoKGEpID0+IGEuYWN0aXZlKS5sZW5ndGh9PC9zdHJvbmc+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9Im1ldHJpYyI+PHNwYW4+TGltaXRlIHBvciBzYWxhPC9zcGFuPjxzdHJvbmc+JHtzdGF0ZS5jb25maWcubWF4UGFydGljaXBhbnRzfTwvc3Ryb25nPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJtZXRyaWMiPjxzcGFuPkJhbmNvPC9zcGFuPjxzdHJvbmcgc3R5bGU9ImZvbnQtc2l6ZToyMHB4Ij4ke3N0YXRlLmF1dGgucGVyc2lzdGVuY2VNb2RlID09PSAncG9zdGdyZXMnID8gJ0NvbmVjdGFkbycgOiAnVGVtcG9yw6FyaW8nfTwvc3Ryb25nPjwvZGl2PgogICAgPC9kaXY+CiAgICAke3N0YXJ0UGFuZWx9CiAgICA8ZGl2IGNsYXNzPSJzZWN0aW9uLXRpdGxlIj48aDI+RXNjb2xoYSB1bSBxdWl6IHBhcmEgYXByZXNlbnRhcjwvaDI+PC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJncmlkLTMiPiR7c3RhdGUucXVpenplcy5tYXAocXVpekNhcmQpLmpvaW4oJycpIHx8ICc8ZGl2IGNsYXNzPSJlbXB0eSI+TmVuaHVtIHF1aXogY2FkYXN0cmFkby48L2Rpdj4nfTwvZGl2PmA7Cn0KCmZ1bmN0aW9uIHF1aXpDYXJkKHF1aXopIHsKICBjb25zdCBtdXNpYyA9IHN0YXRlLmNvbmZpZy5tdXNpY1RoZW1lcy5maW5kKChpdGVtKSA9PiBpdGVtLmlkID09PSBxdWl6Lm11c2ljVGhlbWUpPy5uYW1lIHx8ICdTZW0gbcO6c2ljYSc7CiAgcmV0dXJuIGA8YXJ0aWNsZSBjbGFzcz0iY2FyZCBpbnRlcmFjdGl2ZSBxdWl6LWNhcmQiPgogICAgPGRpdj48ZGl2IGNsYXNzPSJleWVicm93Ij4ke2VzY2FwZUh0bWwocXVpei5vd25lck5hbWUgfHwgJ1Npc3RlbWEnKX08L2Rpdj48aDM+JHtlc2NhcGVIdG1sKHF1aXoudGl0bGUpfTwvaDM+PHAgY2xhc3M9Im11dGVkIj4ke2VzY2FwZUh0bWwocXVpei5kZXNjcmlwdGlvbiB8fCAnU2VtIGRlc2NyacOnw6NvJyl9PC9wPjwvZGl2PgogICAgPGRpdiBjbGFzcz0icXVpei1tZXRhIj48c3BhbiBjbGFzcz0iY2hpcCI+4p2TICR7cXVpei5xdWVzdGlvbnMubGVuZ3RofSBxdWVzdMO1ZXM8L3NwYW4+PHNwYW4gY2xhc3M9ImNoaXAiPuKZqyAke2VzY2FwZUh0bWwobXVzaWMpfTwvc3Bhbj48L2Rpdj4KICAgIDxkaXYgY2xhc3M9InF1aXotYWN0aW9ucyI+CiAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBidG4tcHJpbWFyeSIgZGF0YS1zdGFydC1xdWl6PSIke2VzY2FwZUh0bWwocXVpei5pZCl9Ij7ilrYgSW5pY2lhciBhbyB2aXZvPC9idXR0b24+CiAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBidG4tbGlnaHQiIGRhdGEtZWRpdC1xdWl6PSIke2VzY2FwZUh0bWwocXVpei5pZCl9Ij5FZGl0YXI8L2J1dHRvbj4KICAgIDwvZGl2PgogIDwvYXJ0aWNsZT5gOwp9CgpmdW5jdGlvbiByZW5kZXJTdGFydFBhbmVsKCkgewogIGNvbnN0IHF1aXogPSBzdGF0ZS5xdWl6emVzLmZpbmQoKGl0ZW0pID0+IGl0ZW0uaWQgPT09IHN0YXRlLnN0YXJ0UXVpeklkKTsKICBpZiAoIXF1aXopIHJldHVybiAnJzsKICByZXR1cm4gYDxkaXYgY2xhc3M9ImNhcmQgZ3JhZGllbnQiIHN0eWxlPSJtYXJnaW4tYm90dG9tOjIycHgiPgogICAgPGRpdiBjbGFzcz0ic2VjdGlvbi10aXRsZSI+PGRpdj48ZGl2IGNsYXNzPSJleWVicm93IiBzdHlsZT0iYmFja2dyb3VuZDpyZ2JhKDI1NSwyNTUsMjU1LC4xNik7Y29sb3I6d2hpdGUiPlByZXBhcmFyIHNhbGE8L2Rpdj48aDI+JHtlc2NhcGVIdG1sKHF1aXoudGl0bGUpfTwvaDI+PC9kaXY+PGJ1dHRvbiBpZD0iY2xvc2Utc3RhcnQtcGFuZWwiIGNsYXNzPSJidG4gYnRuLWxpZ2h0Ij5DYW5jZWxhcjwvYnV0dG9uPjwvZGl2PgogICAgPGRpdiBjbGFzcz0iZ3JpZC0yIj4KICAgICAgPGRpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPlByw6ptaW8gZG8gMcK6IGx1Z2FyPC9sYWJlbD48aW5wdXQgaWQ9InByaXplLWZpcnN0IiBjbGFzcz0iaW5wdXQiIHZhbHVlPSJWYWxlLXByZXNlbnRlIGRlIFIkIDIwMCI+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5QcsOqbWlvIGRvIDLCuiBsdWdhcjwvbGFiZWw+PGlucHV0IGlkPSJwcml6ZS1zZWNvbmQiIGNsYXNzPSJpbnB1dCIgdmFsdWU9IlZhbGUtcHJlc2VudGUgZGUgUiQgMTAwIj48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPlByw6ptaW8gZG8gM8K6IGx1Z2FyPC9sYWJlbD48aW5wdXQgaWQ9InByaXplLXRoaXJkIiBjbGFzcz0iaW5wdXQiIHZhbHVlPSJWYWxlLXByZXNlbnRlIGRlIFIkIDUwIj48L2Rpdj4KICAgICAgPC9kaXY+CiAgICAgIDxkaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5Nw7pzaWNhIGRvIHF1aXo8L2xhYmVsPjxzZWxlY3QgaWQ9InJvb20tbXVzaWMiIGNsYXNzPSJzZWxlY3QiPiR7c3RhdGUuY29uZmlnLm11c2ljVGhlbWVzLm1hcCgodGhlbWUpID0+IGA8b3B0aW9uIHZhbHVlPSIke3RoZW1lLmlkfSIgJHt0aGVtZS5pZCA9PT0gcXVpei5tdXNpY1RoZW1lID8gJ3NlbGVjdGVkJyA6ICcnfT4ke2VzY2FwZUh0bWwodGhlbWUubmFtZSl9IOKAlCAke2VzY2FwZUh0bWwodGhlbWUuZGVzY3JpcHRpb24pfTwvb3B0aW9uPmApLmpvaW4oJycpfTwvc2VsZWN0PjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9Im5vdGljZSBpbmZvIj5BbyBjbGljYXIgZW0gaW5pY2lhciwgdm9jw6ogc2Vyw6EgZGlyZWNpb25hZG8gcGFyYSBhIHRlbGEgZGUgYXByZXNlbnRhw6fDo28sIG9uZGUgY29udHJvbGFyw6EgdG9kYXMgYXMgZXRhcGFzLjwvZGl2PgogICAgICAgIDxidXR0b24gaWQ9ImNyZWF0ZS1saXZlLXJvb20iIGNsYXNzPSJidG4gYnRuLWRhcmsgYnRuLWxhcmdlIGJ0bi1ibG9jayI+Q3JpYXIgc2FsYSBlIGFicmlyIGFwcmVzZW50YcOnw6NvPC9idXR0b24+CiAgICAgIDwvZGl2PgogICAgPC9kaXY+CiAgPC9kaXY+YDsKfQoKZnVuY3Rpb24gcmVuZGVyUXVpenplc1RhYigpIHsKICBpZiAoc3RhdGUuZWRpdG9yKSByZXR1cm4gcmVuZGVyUXVpekVkaXRvcigpOwogIHJldHVybiBgCiAgICA8ZGl2IGNsYXNzPSJzZWN0aW9uLXRpdGxlIj48ZGl2PjxkaXYgY2xhc3M9ImV5ZWJyb3ciPkJpYmxpb3RlY2E8L2Rpdj48aDE+TWV1cyBxdWl6emVzPC9oMT48L2Rpdj48YnV0dG9uIGlkPSJuZXctcXVpeiIgY2xhc3M9ImJ0biBidG4tcHJpbWFyeSI+KyBOb3ZvIHF1aXo8L2J1dHRvbj48L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImdyaWQtMyI+JHtzdGF0ZS5xdWl6emVzLm1hcCgocXVpeikgPT4gYCR7cXVpekNhcmQocXVpeil9PGRpdiBjbGFzcz0iaGlkZGVuIj48YnV0dG9uIGRhdGEtZGVsZXRlLXF1aXo9IiR7ZXNjYXBlSHRtbChxdWl6LmlkKX0iPjwvYnV0dG9uPjwvZGl2PmApLmpvaW4oJycpfTwvZGl2PmA7Cn0KCmZ1bmN0aW9uIGJsYW5rUXVlc3Rpb24oKSB7CiAgcmV0dXJuIHsgaWQ6IHJhbmRvbUlkKCdxdWVzdGlvbicpLCB0ZXh0OiAnJywgb3B0aW9uczogWycnLCAnJywgJycsICcnXSwgY29ycmVjdEluZGV4OiAwLCB0aW1lTGltaXQ6IDIwLCBleHBsYW5hdGlvbjogJycgfTsKfQoKZnVuY3Rpb24gcmVuZGVyUXVpekVkaXRvcigpIHsKICBjb25zdCBxdWl6ID0gc3RhdGUuZWRpdG9yOwogIHJldHVybiBgCiAgICA8ZGl2IGNsYXNzPSJzZWN0aW9uLXRpdGxlIj48ZGl2PjxkaXYgY2xhc3M9ImV5ZWJyb3ciPkVkaXRvciBkZSBxdWl6PC9kaXY+PGgxPiR7cXVpei5pc05ldyA/ICdOb3ZvIHF1aXonIDogJ0VkaXRhciBxdWl6J308L2gxPjwvZGl2PjxidXR0b24gaWQ9ImNhbmNlbC1lZGl0b3IiIGNsYXNzPSJidG4gYnRuLWxpZ2h0Ij5DYW5jZWxhcjwvYnV0dG9uPjwvZGl2PgogICAgPGRpdiBjbGFzcz0iY2FyZCI+CiAgICAgIDxkaXYgY2xhc3M9ImdyaWQtMiI+CiAgICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5Uw610dWxvIGRvIHF1aXo8L2xhYmVsPjxpbnB1dCBpZD0icXVpei10aXRsZSIgY2xhc3M9ImlucHV0IiB2YWx1ZT0iJHtlc2NhcGVIdG1sKHF1aXoudGl0bGUpfSIgbWF4bGVuZ3RoPSIxNDAiPjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+TcO6c2ljYSBwcmluY2lwYWw8L2xhYmVsPjxzZWxlY3QgaWQ9InF1aXotbXVzaWMiIGNsYXNzPSJzZWxlY3QiPiR7c3RhdGUuY29uZmlnLm11c2ljVGhlbWVzLm1hcCgodGhlbWUpID0+IGA8b3B0aW9uIHZhbHVlPSIke3RoZW1lLmlkfSIgJHt0aGVtZS5pZCA9PT0gcXVpei5tdXNpY1RoZW1lID8gJ3NlbGVjdGVkJyA6ICcnfT4ke2VzY2FwZUh0bWwodGhlbWUubmFtZSl9PC9vcHRpb24+YCkuam9pbignJyl9PC9zZWxlY3Q+PC9kaXY+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPkRlc2NyacOnw6NvPC9sYWJlbD48dGV4dGFyZWEgaWQ9InF1aXotZGVzY3JpcHRpb24iIGNsYXNzPSJ0ZXh0YXJlYSI+JHtlc2NhcGVIdG1sKHF1aXouZGVzY3JpcHRpb24pfTwvdGV4dGFyZWE+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9InNlY3Rpb24tdGl0bGUiPjxoMj5RdWVzdMO1ZXM8L2gyPjxzcGFuIGNsYXNzPSJjaGlwIj5BbHRlcm5hdGl2YXMgdmF6aWFzIG7Do28gc2Vyw6NvIGV4aWJpZGFzPC9zcGFuPjwvZGl2PgogICAgICA8ZGl2IGlkPSJxdWVzdGlvbnMtZWRpdG9yIj4ke3F1aXoucXVlc3Rpb25zLm1hcCgocXVlc3Rpb24sIGluZGV4KSA9PiByZW5kZXJRdWVzdGlvbkVkaXRvcihxdWVzdGlvbiwgaW5kZXgpKS5qb2luKCcnKX08L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iYnVpbGRlci1hY3Rpb25zIj48YnV0dG9uIGlkPSJhZGQtcXVlc3Rpb24iIGNsYXNzPSJidG4gYnRuLWxpZ2h0Ij4rIEFkaWNpb25hciBxdWVzdMOjbzwvYnV0dG9uPjxidXR0b24gaWQ9InNhdmUtcXVpeiIgY2xhc3M9ImJ0biBidG4tcHJpbWFyeSBidG4tbGFyZ2UiPlNhbHZhciBxdWl6PC9idXR0b24+PC9kaXY+CiAgICA8L2Rpdj5gOwp9CgpmdW5jdGlvbiByZW5kZXJRdWVzdGlvbkVkaXRvcihxdWVzdGlvbiwgaW5kZXgpIHsKICBjb25zdCBvcHRpb25zID0gWy4uLnF1ZXN0aW9uLm9wdGlvbnNdOwogIHdoaWxlIChvcHRpb25zLmxlbmd0aCA8IDYpIG9wdGlvbnMucHVzaCgnJyk7CiAgcmV0dXJuIGA8ZGl2IGNsYXNzPSJidWlsZGVyLXF1ZXN0aW9uIiBkYXRhLXF1ZXN0aW9uPSIke2luZGV4fSI+CiAgICA8ZGl2IGNsYXNzPSJidWlsZGVyLWhlYWQiPjxoMz5RdWVzdMOjbyAke2luZGV4ICsgMX08L2gzPjxidXR0b24gY2xhc3M9ImJ0biBidG4tZGFuZ2VyIiBkYXRhLXJlbW92ZS1xdWVzdGlvbj0iJHtpbmRleH0iICR7c3RhdGUuZWRpdG9yLnF1ZXN0aW9ucy5sZW5ndGggPD0gMSA/ICdkaXNhYmxlZCcgOiAnJ30+RXhjbHVpcjwvYnV0dG9uPjwvZGl2PgogICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5FbnVuY2lhZG88L2xhYmVsPjx0ZXh0YXJlYSBjbGFzcz0idGV4dGFyZWEgcXVlc3Rpb24tdGV4dCIgZGF0YS1pbmRleD0iJHtpbmRleH0iPiR7ZXNjYXBlSHRtbChxdWVzdGlvbi50ZXh0KX08L3RleHRhcmVhPjwvZGl2PgogICAgPGRpdiBjbGFzcz0iZ3JpZC0yIj48ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPlRlbXBvPC9sYWJlbD48c2VsZWN0IGNsYXNzPSJzZWxlY3QgcXVlc3Rpb24tdGltZSIgZGF0YS1pbmRleD0iJHtpbmRleH0iPiR7WzEwLDE1LDIwLDMwLDQ1LDYwLDkwLDEyMF0ubWFwKCh0aW1lKSA9PiBgPG9wdGlvbiB2YWx1ZT0iJHt0aW1lfSIgJHt0aW1lID09PSBOdW1iZXIocXVlc3Rpb24udGltZUxpbWl0KSA/ICdzZWxlY3RlZCcgOiAnJ30+JHt0aW1lfSBzZWd1bmRvczwvb3B0aW9uPmApLmpvaW4oJycpfTwvc2VsZWN0PjwvZGl2PjxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+RXhwbGljYcOnw6NvIGRhIHJlc3Bvc3RhPC9sYWJlbD48aW5wdXQgY2xhc3M9ImlucHV0IHF1ZXN0aW9uLWV4cGxhbmF0aW9uIiBkYXRhLWluZGV4PSIke2luZGV4fSIgdmFsdWU9IiR7ZXNjYXBlSHRtbChxdWVzdGlvbi5leHBsYW5hdGlvbiB8fCAnJyl9Ij48L2Rpdj48L2Rpdj4KICAgIDxsYWJlbCBzdHlsZT0iZm9udC13ZWlnaHQ6ODAwO2Rpc3BsYXk6YmxvY2s7bWFyZ2luLWJvdHRvbToxMHB4Ij5BbHRlcm5hdGl2YXMg4oCUIG1hcnF1ZSBhIGNvcnJldGE8L2xhYmVsPgogICAgJHtvcHRpb25zLm1hcCgob3B0aW9uLCBvcHRpb25JbmRleCkgPT4gYDxkaXYgY2xhc3M9Im9wdGlvbi1yb3ciPjxpbnB1dCB0eXBlPSJyYWRpbyIgbmFtZT0iY29ycmVjdC0ke2luZGV4fSIgY2xhc3M9ImNvcnJlY3Qtb3B0aW9uIiBkYXRhLXF1ZXN0aW9uLWluZGV4PSIke2luZGV4fSIgdmFsdWU9IiR7b3B0aW9uSW5kZXh9IiAke051bWJlcihxdWVzdGlvbi5jb3JyZWN0SW5kZXgpID09PSBvcHRpb25JbmRleCA/ICdjaGVja2VkJyA6ICcnfT48aW5wdXQgY2xhc3M9ImlucHV0IG9wdGlvbi1pbnB1dCIgZGF0YS1xdWVzdGlvbi1pbmRleD0iJHtpbmRleH0iIGRhdGEtb3B0aW9uLWluZGV4PSIke29wdGlvbkluZGV4fSIgdmFsdWU9IiR7ZXNjYXBlSHRtbChvcHRpb24pfSIgcGxhY2Vob2xkZXI9IkFsdGVybmF0aXZhICR7b3B0aW9uSW5kZXggKyAxfSAke29wdGlvbkluZGV4ID4gMSA/ICcob3BjaW9uYWwpJyA6ICcnfSI+PC9kaXY+YCkuam9pbignJyl9CiAgPC9kaXY+YDsKfQoKZnVuY3Rpb24gcmVuZGVyQWRtaW5zVGFiKCkgewogIHJldHVybiBgCiAgICA8ZGl2IGNsYXNzPSJzZWN0aW9uLXRpdGxlIj48ZGl2PjxkaXYgY2xhc3M9ImV5ZWJyb3ciPkFjZXNzb3M8L2Rpdj48aDE+QWRtaW5pc3RyYWRvcmVzPC9oMT48L2Rpdj48L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImdyaWQtMiI+CiAgICAgIDxkaXYgY2xhc3M9ImNhcmQiPgogICAgICAgIDxoMj5DcmlhciBub3ZvIGFkbWluaXN0cmFkb3I8L2gyPgogICAgICAgIDxwIGNsYXNzPSJtdXRlZCI+TyBub3ZvIHVzdcOhcmlvIHBvZGVyw6EgZW50cmFyIG5vIHBhaW5lbCBlIGNyaWFyIG9zIHByw7NwcmlvcyBxdWl6emVzLjwvcD4KICAgICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPk5vbWU8L2xhYmVsPjxpbnB1dCBpZD0ibmV3LWFkbWluLW5hbWUiIGNsYXNzPSJpbnB1dCI+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5FLW1haWw8L2xhYmVsPjxpbnB1dCBpZD0ibmV3LWFkbWluLWVtYWlsIiBjbGFzcz0iaW5wdXQiIHR5cGU9ImVtYWlsIj48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPlNlbmhhIGluaWNpYWw8L2xhYmVsPjxpbnB1dCBpZD0ibmV3LWFkbWluLXBhc3N3b3JkIiBjbGFzcz0iaW5wdXQiIHR5cGU9InBhc3N3b3JkIiBtaW5sZW5ndGg9IjgiPjxzbWFsbD5Nw61uaW1vIGRlIG9pdG8gY2FyYWN0ZXJlcy48L3NtYWxsPjwvZGl2PgogICAgICAgIDxidXR0b24gaWQ9ImNyZWF0ZS1hZG1pbiIgY2xhc3M9ImJ0biBidG4tcHJpbWFyeSBidG4tYmxvY2siPkNyaWFyIGFjZXNzbzwvYnV0dG9uPgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iY2FyZCI+CiAgICAgICAgPGgyPkFjZXNzb3MgY2FkYXN0cmFkb3M8L2gyPgogICAgICAgIDxkaXYgc3R5bGU9ImRpc3BsYXk6Z3JpZDtnYXA6MTBweCI+JHtzdGF0ZS5hZG1pbnMubWFwKChhZG1pbikgPT4gYDxkaXYgY2xhc3M9ImNhcmQgc29mdCIgc3R5bGU9InBhZGRpbmc6MTRweCI+PGRpdiBjbGFzcz0icm93IHNwYWNlLWJldHdlZW4iPjxkaXY+PHN0cm9uZz4ke2VzY2FwZUh0bWwoYWRtaW4ubmFtZSl9PC9zdHJvbmc+PGRpdiBjbGFzcz0ibXV0ZWQiPiR7ZXNjYXBlSHRtbChhZG1pbi5lbWFpbCl9IMK3ICR7YWRtaW4ucm9sZSA9PT0gJ293bmVyJyA/ICdQcmluY2lwYWwnIDogJ0FkbWluaXN0cmFkb3InfTwvZGl2PjwvZGl2PiR7c3RhdGUuYXV0aC5hZG1pbi5yb2xlID09PSAnb3duZXInICYmIGFkbWluLmlkICE9PSBzdGF0ZS5hdXRoLmFkbWluLmlkID8gYDxidXR0b24gY2xhc3M9ImJ0biAke2FkbWluLmFjdGl2ZSA/ICdidG4tZGFuZ2VyJyA6ICdidG4tc3VjY2Vzcyd9IiBkYXRhLXRvZ2dsZS1hZG1pbj0iJHthZG1pbi5pZH0iIGRhdGEtYWN0aXZlPSIke2FkbWluLmFjdGl2ZSA/ICcwJyA6ICcxJ30iPiR7YWRtaW4uYWN0aXZlID8gJ0Jsb3F1ZWFyJyA6ICdBdGl2YXInfTwvYnV0dG9uPmAgOiBgPHNwYW4gY2xhc3M9ImNoaXAiPiR7YWRtaW4uYWN0aXZlID8gJ0F0aXZvJyA6ICdCbG9xdWVhZG8nfTwvc3Bhbj5gfTwvZGl2PjwvZGl2PmApLmpvaW4oJycpfTwvZGl2PgogICAgICA8L2Rpdj4KICAgIDwvZGl2PmA7Cn0KCmZ1bmN0aW9uIGJpbmREYXNoYm9hcmRDb250ZW50KCkgewogIGNvbnN0IG5ld1F1aXpCdXR0b25zID0gW2RvY3VtZW50LmdldEVsZW1lbnRCeUlkKCduZXctcXVpeicpLCBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnbmV3LXF1aXotb3ZlcnZpZXcnKV0uZmlsdGVyKEJvb2xlYW4pOwogIG5ld1F1aXpCdXR0b25zLmZvckVhY2goKGJ1dHRvbikgPT4gYnV0dG9uLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gewogICAgc3RhdGUuZGFzaGJvYXJkVGFiID0gJ3F1aXp6ZXMnOwogICAgc3RhdGUuZWRpdG9yID0geyBpZDogcmFuZG9tSWQoJ3F1aXonKSwgdGl0bGU6ICcnLCBkZXNjcmlwdGlvbjogJycsIG11c2ljVGhlbWU6ICdwdWxzZScsIHF1ZXN0aW9uczogW2JsYW5rUXVlc3Rpb24oKV0sIGlzTmV3OiB0cnVlIH07CiAgICByZW5kZXJEYXNoYm9hcmQoKTsKICB9KSk7CgogIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLXN0YXJ0LXF1aXpdJykuZm9yRWFjaCgoYnV0dG9uKSA9PiBidXR0b24uYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7CiAgICBzdGF0ZS5zdGFydFF1aXpJZCA9IGJ1dHRvbi5kYXRhc2V0LnN0YXJ0UXVpejsKICAgIHN0YXRlLmRhc2hib2FyZFRhYiA9ICdvdmVydmlldyc7CiAgICByZW5kZXJEYXNoYm9hcmQoKTsKICB9KSk7CiAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtZWRpdC1xdWl6XScpLmZvckVhY2goKGJ1dHRvbikgPT4gYnV0dG9uLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gewogICAgY29uc3QgcXVpeiA9IHN0YXRlLnF1aXp6ZXMuZmluZCgoaXRlbSkgPT4gaXRlbS5pZCA9PT0gYnV0dG9uLmRhdGFzZXQuZWRpdFF1aXopOwogICAgc3RhdGUuZGFzaGJvYXJkVGFiID0gJ3F1aXp6ZXMnOwogICAgc3RhdGUuZWRpdG9yID0geyAuLi5KU09OLnBhcnNlKEpTT04uc3RyaW5naWZ5KHF1aXopKSwgaXNOZXc6IGZhbHNlIH07CiAgICByZW5kZXJEYXNoYm9hcmQoKTsKICB9KSk7CgogIGNvbnN0IGNsb3NlU3RhcnQgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnY2xvc2Utc3RhcnQtcGFuZWwnKTsKICBpZiAoY2xvc2VTdGFydCkgY2xvc2VTdGFydC5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHsgc3RhdGUuc3RhcnRRdWl6SWQgPSBudWxsOyByZW5kZXJEYXNoYm9hcmQoKTsgfSk7CiAgY29uc3QgY3JlYXRlUm9vbSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdjcmVhdGUtbGl2ZS1yb29tJyk7CiAgaWYgKGNyZWF0ZVJvb20pIGNyZWF0ZVJvb20uYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBhc3luYyAoKSA9PiB7CiAgICB0cnkgewogICAgICBlbnN1cmVBdWRpbygpOwogICAgICBjcmVhdGVSb29tLmRpc2FibGVkID0gdHJ1ZTsKICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgYXBpKCcvYXBpL2FkbWluL2NyZWF0ZS1yb29tJywgewogICAgICAgIGF1dGhUb2tlbjogc3RhdGUuYXV0aC5hdXRoVG9rZW4sCiAgICAgICAgcXVpeklkOiBzdGF0ZS5zdGFydFF1aXpJZCwKICAgICAgICBtdXNpY1RoZW1lOiBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgncm9vbS1tdXNpYycpLnZhbHVlLAogICAgICAgIHByaXplczogewogICAgICAgICAgZmlyc3Q6IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdwcml6ZS1maXJzdCcpLnZhbHVlLAogICAgICAgICAgc2Vjb25kOiBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgncHJpemUtc2Vjb25kJykudmFsdWUsCiAgICAgICAgICB0aGlyZDogZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3ByaXplLXRoaXJkJykudmFsdWUsCiAgICAgICAgfSwKICAgICAgfSk7CiAgICAgIGNvbnN0IGNyZWRzID0geyByb29tQ29kZTogcmVzdWx0LnJvb21Db2RlLCBhZG1pblRva2VuOiByZXN1bHQuYWRtaW5Ub2tlbiB9OwogICAgICBzZXNzaW9uU3RvcmFnZS5zZXRJdGVtKFBSRVNFTlRFUl9LRVkocmVzdWx0LnJvb21Db2RlKSwgSlNPTi5zdHJpbmdpZnkoY3JlZHMpKTsKICAgICAgbG9jYXRpb24uaHJlZiA9IGAvP3ByZXNlbnRlcj0ke2VuY29kZVVSSUNvbXBvbmVudChyZXN1bHQucm9vbUNvZGUpfWA7CiAgICB9IGNhdGNoIChlcnJvcikgewogICAgICBjcmVhdGVSb29tLmRpc2FibGVkID0gZmFsc2U7CiAgICAgIHNob3dUb2FzdChlcnJvci5tZXNzYWdlKTsKICAgIH0KICB9KTsKCiAgaWYgKHN0YXRlLmVkaXRvcikgYmluZFF1aXpFZGl0b3IoKTsKCiAgY29uc3QgY3JlYXRlQWRtaW4gPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnY3JlYXRlLWFkbWluJyk7CiAgaWYgKGNyZWF0ZUFkbWluKSBjcmVhdGVBZG1pbi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIGFzeW5jICgpID0+IHsKICAgIHRyeSB7CiAgICAgIGNyZWF0ZUFkbWluLmRpc2FibGVkID0gdHJ1ZTsKICAgICAgYXdhaXQgYXBpKCcvYXBpL2FkbWluL2NyZWF0ZS1hZG1pbicsIHsKICAgICAgICBhdXRoVG9rZW46IHN0YXRlLmF1dGguYXV0aFRva2VuLAogICAgICAgIG5hbWU6IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCduZXctYWRtaW4tbmFtZScpLnZhbHVlLAogICAgICAgIGVtYWlsOiBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnbmV3LWFkbWluLWVtYWlsJykudmFsdWUsCiAgICAgICAgcGFzc3dvcmQ6IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCduZXctYWRtaW4tcGFzc3dvcmQnKS52YWx1ZSwKICAgICAgfSk7CiAgICAgIHNob3dUb2FzdCgnQWRtaW5pc3RyYWRvciBjcmlhZG8uJyk7CiAgICAgIGF3YWl0IGxvYWREYXNoYm9hcmQoKTsKICAgIH0gY2F0Y2ggKGVycm9yKSB7CiAgICAgIGNyZWF0ZUFkbWluLmRpc2FibGVkID0gZmFsc2U7CiAgICAgIHNob3dUb2FzdChlcnJvci5tZXNzYWdlKTsKICAgIH0KICB9KTsKICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS10b2dnbGUtYWRtaW5dJykuZm9yRWFjaCgoYnV0dG9uKSA9PiBidXR0b24uYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBhc3luYyAoKSA9PiB7CiAgICB0cnkgewogICAgICBhd2FpdCBhcGkoJy9hcGkvYWRtaW4vdG9nZ2xlLWFkbWluJywgeyBhdXRoVG9rZW46IHN0YXRlLmF1dGguYXV0aFRva2VuLCBhZG1pbklkOiBidXR0b24uZGF0YXNldC50b2dnbGVBZG1pbiwgYWN0aXZlOiBidXR0b24uZGF0YXNldC5hY3RpdmUgPT09ICcxJyB9KTsKICAgICAgYXdhaXQgbG9hZERhc2hib2FyZCgpOwogICAgfSBjYXRjaCAoZXJyb3IpIHsgc2hvd1RvYXN0KGVycm9yLm1lc3NhZ2UpOyB9CiAgfSkpOwp9CgpmdW5jdGlvbiBiaW5kUXVpekVkaXRvcigpIHsKICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnY2FuY2VsLWVkaXRvcicpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4geyBzdGF0ZS5lZGl0b3IgPSBudWxsOyByZW5kZXJEYXNoYm9hcmQoKTsgfSk7CiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3F1aXotdGl0bGUnKS5hZGRFdmVudExpc3RlbmVyKCdpbnB1dCcsIChldmVudCkgPT4gc3RhdGUuZWRpdG9yLnRpdGxlID0gZXZlbnQudGFyZ2V0LnZhbHVlKTsKICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgncXVpei1kZXNjcmlwdGlvbicpLmFkZEV2ZW50TGlzdGVuZXIoJ2lucHV0JywgKGV2ZW50KSA9PiBzdGF0ZS5lZGl0b3IuZGVzY3JpcHRpb24gPSBldmVudC50YXJnZXQudmFsdWUpOwogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdxdWl6LW11c2ljJykuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgKGV2ZW50KSA9PiBzdGF0ZS5lZGl0b3IubXVzaWNUaGVtZSA9IGV2ZW50LnRhcmdldC52YWx1ZSk7CiAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnF1ZXN0aW9uLXRleHQnKS5mb3JFYWNoKChpbnB1dCkgPT4gaW5wdXQuYWRkRXZlbnRMaXN0ZW5lcignaW5wdXQnLCAoKSA9PiBzdGF0ZS5lZGl0b3IucXVlc3Rpb25zW051bWJlcihpbnB1dC5kYXRhc2V0LmluZGV4KV0udGV4dCA9IGlucHV0LnZhbHVlKSk7CiAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnF1ZXN0aW9uLXRpbWUnKS5mb3JFYWNoKChpbnB1dCkgPT4gaW5wdXQuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgKCkgPT4gc3RhdGUuZWRpdG9yLnF1ZXN0aW9uc1tOdW1iZXIoaW5wdXQuZGF0YXNldC5pbmRleCldLnRpbWVMaW1pdCA9IE51bWJlcihpbnB1dC52YWx1ZSkpKTsKICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcucXVlc3Rpb24tZXhwbGFuYXRpb24nKS5mb3JFYWNoKChpbnB1dCkgPT4gaW5wdXQuYWRkRXZlbnRMaXN0ZW5lcignaW5wdXQnLCAoKSA9PiBzdGF0ZS5lZGl0b3IucXVlc3Rpb25zW051bWJlcihpbnB1dC5kYXRhc2V0LmluZGV4KV0uZXhwbGFuYXRpb24gPSBpbnB1dC52YWx1ZSkpOwogIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5vcHRpb24taW5wdXQnKS5mb3JFYWNoKChpbnB1dCkgPT4gaW5wdXQuYWRkRXZlbnRMaXN0ZW5lcignaW5wdXQnLCAoKSA9PiB7CiAgICBjb25zdCBxdWVzdGlvbiA9IHN0YXRlLmVkaXRvci5xdWVzdGlvbnNbTnVtYmVyKGlucHV0LmRhdGFzZXQucXVlc3Rpb25JbmRleCldOwogICAgd2hpbGUgKHF1ZXN0aW9uLm9wdGlvbnMubGVuZ3RoIDwgNikgcXVlc3Rpb24ub3B0aW9ucy5wdXNoKCcnKTsKICAgIHF1ZXN0aW9uLm9wdGlvbnNbTnVtYmVyKGlucHV0LmRhdGFzZXQub3B0aW9uSW5kZXgpXSA9IGlucHV0LnZhbHVlOwogIH0pKTsKICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuY29ycmVjdC1vcHRpb24nKS5mb3JFYWNoKChpbnB1dCkgPT4gaW5wdXQuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgKCkgPT4gc3RhdGUuZWRpdG9yLnF1ZXN0aW9uc1tOdW1iZXIoaW5wdXQuZGF0YXNldC5xdWVzdGlvbkluZGV4KV0uY29ycmVjdEluZGV4ID0gTnVtYmVyKGlucHV0LnZhbHVlKSkpOwogIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLXJlbW92ZS1xdWVzdGlvbl0nKS5mb3JFYWNoKChidXR0b24pID0+IGJ1dHRvbi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHsKICAgIHN0YXRlLmVkaXRvci5xdWVzdGlvbnMuc3BsaWNlKE51bWJlcihidXR0b24uZGF0YXNldC5yZW1vdmVRdWVzdGlvbiksIDEpOwogICAgcmVuZGVyRGFzaGJvYXJkKCk7CiAgfSkpOwogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdhZGQtcXVlc3Rpb24nKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHsKICAgIGlmIChzdGF0ZS5lZGl0b3IucXVlc3Rpb25zLmxlbmd0aCA+PSA2MCkgcmV0dXJuIHNob3dUb2FzdCgnTyBsaW1pdGUgw6kgZGUgNjAgcXVlc3TDtWVzIHBvciBxdWl6LicpOwogICAgc3RhdGUuZWRpdG9yLnF1ZXN0aW9ucy5wdXNoKGJsYW5rUXVlc3Rpb24oKSk7CiAgICByZW5kZXJEYXNoYm9hcmQoKTsKICB9KTsKICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnc2F2ZS1xdWl6JykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBzYXZlUXVpekVkaXRvcik7Cn0KCmFzeW5jIGZ1bmN0aW9uIHNhdmVRdWl6RWRpdG9yKCkgewogIGNvbnN0IHF1aXogPSBzdGF0ZS5lZGl0b3I7CiAgaWYgKCFxdWl6LnRpdGxlLnRyaW0oKSkgcmV0dXJuIHNob3dUb2FzdCgnSW5mb3JtZSBvIHTDrXR1bG8gZG8gcXVpei4nKTsKICBmb3IgKGxldCBpID0gMDsgaSA8IHF1aXoucXVlc3Rpb25zLmxlbmd0aDsgaSArPSAxKSB7CiAgICBjb25zdCBxdWVzdGlvbiA9IHF1aXoucXVlc3Rpb25zW2ldOwogICAgY29uc3QgZmlsbGVkID0gcXVlc3Rpb24ub3B0aW9ucy5tYXAoKHRleHQsIGluZGV4KSA9PiAoeyB0ZXh0OiBTdHJpbmcodGV4dCB8fCAnJykudHJpbSgpLCBpbmRleCB9KSkuZmlsdGVyKChpdGVtKSA9PiBpdGVtLnRleHQpOwogICAgaWYgKCFxdWVzdGlvbi50ZXh0LnRyaW0oKSB8fCBmaWxsZWQubGVuZ3RoIDwgMikgcmV0dXJuIHNob3dUb2FzdChgUHJlZW5jaGEgYSBxdWVzdMOjbyAke2kgKyAxfSBlIHBlbG8gbWVub3MgZHVhcyBhbHRlcm5hdGl2YXMuYCk7CiAgICBpZiAoIVN0cmluZyhxdWVzdGlvbi5vcHRpb25zW3F1ZXN0aW9uLmNvcnJlY3RJbmRleF0gfHwgJycpLnRyaW0oKSkgcmV0dXJuIHNob3dUb2FzdChgTWFycXVlIHVtYSBhbHRlcm5hdGl2YSBwcmVlbmNoaWRhIGNvbW8gY29ycmV0YSBuYSBxdWVzdMOjbyAke2kgKyAxfS5gKTsKICB9CiAgdHJ5IHsKICAgIGNvbnN0IGJ1dHRvbiA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzYXZlLXF1aXonKTsKICAgIGJ1dHRvbi5kaXNhYmxlZCA9IHRydWU7CiAgICBhd2FpdCBhcGkoJy9hcGkvYWRtaW4vc2F2ZS1xdWl6JywgeyBhdXRoVG9rZW46IHN0YXRlLmF1dGguYXV0aFRva2VuLCBxdWl6IH0pOwogICAgc3RhdGUuZWRpdG9yID0gbnVsbDsKICAgIHNob3dUb2FzdCgnUXVpeiBzYWx2by4nKTsKICAgIGF3YWl0IGxvYWREYXNoYm9hcmQoKTsKICB9IGNhdGNoIChlcnJvcikgeyBzaG93VG9hc3QoZXJyb3IubWVzc2FnZSk7IH0KfQoKYXN5bmMgZnVuY3Rpb24gb3BlblBsYXllcihyb29tQ29kZSwgYWNjZXNzS2V5KSB7CiAgc3RhdGUucm9vbVJvbGUgPSAncGxheWVyJzsKICBjb25zdCBzdG9yZWQgPSBzZXNzaW9uU3RvcmFnZS5nZXRJdGVtKFBMQVlFUl9LRVkocm9vbUNvZGUpKTsKICBpZiAoc3RvcmVkKSB7CiAgICB0cnkgewogICAgICBzdGF0ZS5wbGF5ZXJDcmVkcyA9IEpTT04ucGFyc2Uoc3RvcmVkKTsKICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgYXBpKCcvYXBpL3BsYXllci9yZXN1bWUnLCB7IHJvb21Db2RlLCAuLi5zdGF0ZS5wbGF5ZXJDcmVkcyB9KTsKICAgICAgc3RhdGUucm9vbSA9IHJlc3VsdC5zdGF0ZTsKICAgICAgc3RhdGUuc2VsZiA9IHJlc3VsdC5zZWxmOwogICAgICBvcGVuUm9vbUV2ZW50cygncGxheWVyJywgcm9vbUNvZGUsIHN0YXRlLnBsYXllckNyZWRzLnBsYXllclRva2VuLCBzdGF0ZS5wbGF5ZXJDcmVkcy5wbGF5ZXJJZCk7CiAgICAgIHJlbmRlclBsYXllclN0YXRlKCk7CiAgICAgIHJldHVybjsKICAgIH0gY2F0Y2ggKGVycm9yKSB7CiAgICAgIHNlc3Npb25TdG9yYWdlLnJlbW92ZUl0ZW0oUExBWUVSX0tFWShyb29tQ29kZSkpOwogICAgICBzdGF0ZS5wbGF5ZXJDcmVkcyA9IG51bGw7CiAgICB9CiAgfQogIHJlbmRlckpvaW4ocm9vbUNvZGUsIGFjY2Vzc0tleSk7Cn0KCmZ1bmN0aW9uIHJlbmRlckpvaW4ocm9vbUNvZGUsIGFjY2Vzc0tleSkgewogIGxldCBzZWxlY3RlZEF2YXRhciA9IHN0YXRlLmNvbmZpZy5hdmF0YXJzWzBdLmlkOwogIGFwcC5pbm5lckhUTUwgPSBgCiAgICAke3RvcGJhcihgPGJ1dHRvbiBpZD0iam9pbi1ob21lLWJhY2siIGNsYXNzPSJidG4gYnRuLWxpZ2h0Ij5TYWlyPC9idXR0b24+YCl9CiAgICA8bWFpbiBjbGFzcz0iY29udGFpbmVyIG5hcnJvdyI+CiAgICAgIDxkaXYgY2xhc3M9ImNhcmQiIHN0eWxlPSJtYXJnaW4tdG9wOjMwcHgiPgogICAgICAgIDxkaXYgY2xhc3M9ImV5ZWJyb3ciPlNhbGEgJHtlc2NhcGVIdG1sKHJvb21Db2RlKX08L2Rpdj4KICAgICAgICA8aDE+Q29tbyB2b2PDqiBxdWVyIGFwYXJlY2VyPzwvaDE+CiAgICAgICAgPGRpdiBjbGFzcz0iZ3JpZC0yIj4KICAgICAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+Tm9tZSBjb21wbGV0bzwvbGFiZWw+PGlucHV0IGlkPSJmdWxsLW5hbWUiIGNsYXNzPSJpbnB1dCIgYXV0b2NvbXBsZXRlPSJuYW1lIiBwbGFjZWhvbGRlcj0iVXNhZG8gbm8gcmVsYXTDs3JpbyBkZSBwcmVzZW7Dp2EiPjwvZGl2PgogICAgICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5BcGVsaWRvPC9sYWJlbD48aW5wdXQgaWQ9Im5pY2tuYW1lIiBjbGFzcz0iaW5wdXQiIG1heGxlbmd0aD0iMjQiIHBsYWNlaG9sZGVyPSJFeGliaWRvIGR1cmFudGUgbyBqb2dvIj48L2Rpdj4KICAgICAgICA8L2Rpdj4KICAgICAgICA8bGFiZWwgc3R5bGU9ImZvbnQtd2VpZ2h0Ojg1MDtkaXNwbGF5OmJsb2NrO21hcmdpbi1ib3R0b206MTBweCI+RXNjb2xoYSB1bSBhdmF0YXI8L2xhYmVsPgogICAgICAgIDxkaXYgY2xhc3M9ImF2YXRhci1ncmlkIj4ke3N0YXRlLmNvbmZpZy5hdmF0YXJzLm1hcCgoYXZhdGFyLCBpbmRleCkgPT4gYDxidXR0b24gY2xhc3M9ImF2YXRhci1jaG9pY2UgJHtpbmRleCA9PT0gMCA/ICdzZWxlY3RlZCcgOiAnJ30iIGRhdGEtYXZhdGFyPSIke2F2YXRhci5pZH0iPiR7YXZhdGFyVmlzdWFsKGF2YXRhcil9PHNtYWxsPiR7ZXNjYXBlSHRtbChhdmF0YXIubmFtZSl9PC9zbWFsbD48L2J1dHRvbj5gKS5qb2luKCcnKX08L2Rpdj4KICAgICAgICA8YnV0dG9uIGlkPSJqb2luLXJvb20iIGNsYXNzPSJidG4gYnRuLXByaW1hcnkgYnRuLWxhcmdlIGJ0bi1ibG9jayIgc3R5bGU9Im1hcmdpbi10b3A6MjBweCI+RW50cmFyIG5hIHNhbGE8L2J1dHRvbj4KICAgICAgPC9kaXY+CiAgICA8L21haW4+YDsKICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnam9pbi1ob21lLWJhY2snKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IGxvY2F0aW9uLmhyZWYgPSAnLycpOwogIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLWF2YXRhcl0nKS5mb3JFYWNoKChidXR0b24pID0+IGJ1dHRvbi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHsKICAgIHNlbGVjdGVkQXZhdGFyID0gYnV0dG9uLmRhdGFzZXQuYXZhdGFyOwogICAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtYXZhdGFyXScpLmZvckVhY2goKGl0ZW0pID0+IGl0ZW0uY2xhc3NMaXN0LnRvZ2dsZSgnc2VsZWN0ZWQnLCBpdGVtID09PSBidXR0b24pKTsKICB9KSk7CiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2pvaW4tcm9vbScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgYXN5bmMgKCkgPT4gewogICAgY29uc3QgYnV0dG9uID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2pvaW4tcm9vbScpOwogICAgdHJ5IHsKICAgICAgZW5zdXJlQXVkaW8oKTsKICAgICAgYnV0dG9uLmRpc2FibGVkID0gdHJ1ZTsKICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgYXBpKCcvYXBpL3BsYXllci9qb2luJywgewogICAgICAgIHJvb21Db2RlLAogICAgICAgIGFjY2Vzc0tleSwKICAgICAgICBmdWxsTmFtZTogZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2Z1bGwtbmFtZScpLnZhbHVlLAogICAgICAgIG5pY2tuYW1lOiBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnbmlja25hbWUnKS52YWx1ZSwKICAgICAgICBhdmF0YXJJZDogc2VsZWN0ZWRBdmF0YXIsCiAgICAgIH0pOwogICAgICBzdGF0ZS5wbGF5ZXJDcmVkcyA9IHsgcGxheWVySWQ6IHJlc3VsdC5wbGF5ZXJJZCwgcGxheWVyVG9rZW46IHJlc3VsdC5wbGF5ZXJUb2tlbiB9OwogICAgICBzZXNzaW9uU3RvcmFnZS5zZXRJdGVtKFBMQVlFUl9LRVkocm9vbUNvZGUpLCBKU09OLnN0cmluZ2lmeShzdGF0ZS5wbGF5ZXJDcmVkcykpOwogICAgICBzdGF0ZS5yb29tID0gcmVzdWx0LnN0YXRlOwogICAgICBzdGF0ZS5zZWxmID0gcmVzdWx0LnNlbGY7CiAgICAgIG9wZW5Sb29tRXZlbnRzKCdwbGF5ZXInLCByb29tQ29kZSwgcmVzdWx0LnBsYXllclRva2VuLCByZXN1bHQucGxheWVySWQpOwogICAgICByZW5kZXJQbGF5ZXJTdGF0ZSgpOwogICAgfSBjYXRjaCAoZXJyb3IpIHsKICAgICAgYnV0dG9uLmRpc2FibGVkID0gZmFsc2U7CiAgICAgIHNob3dUb2FzdChlcnJvci5tZXNzYWdlKTsKICAgIH0KICB9KTsKfQoKZnVuY3Rpb24gb3BlblJvb21FdmVudHMocm9sZSwgcm9vbUNvZGUsIHRva2VuID0gJycsIHBsYXllcklkID0gJycpIHsKICBpZiAoc3RhdGUuZXZlbnRTb3VyY2UpIHN0YXRlLmV2ZW50U291cmNlLmNsb3NlKCk7CiAgY29uc3QgcXVlcnkgPSBuZXcgVVJMU2VhcmNoUGFyYW1zKHsgcm9vbTogcm9vbUNvZGUsIHJvbGUsIHRva2VuLCBwbGF5ZXJJZCB9KTsKICBzdGF0ZS5ldmVudFNvdXJjZSA9IG5ldyBFdmVudFNvdXJjZShgL2V2ZW50cz8ke3F1ZXJ5fWApOwogIHN0YXRlLmV2ZW50U291cmNlLmFkZEV2ZW50TGlzdGVuZXIoJ3N0YXRlJywgKGV2ZW50KSA9PiB7CiAgICBjb25zdCBkYXRhID0gSlNPTi5wYXJzZShldmVudC5kYXRhKTsKICAgIGlmIChyb2xlID09PSAncGxheWVyJykgewogICAgICBzdGF0ZS5yb29tID0gZGF0YS5yb29tOwogICAgICBzdGF0ZS5zZWxmID0gZGF0YS5zZWxmOwogICAgICByZW5kZXJQbGF5ZXJTdGF0ZSgpOwogICAgfSBlbHNlIHsKICAgICAgc3RhdGUucm9vbSA9IGRhdGE7CiAgICAgIGlmIChyb2xlID09PSAnYWRtaW4nKSByZW5kZXJQcmVzZW50ZXJTdGF0ZSgpOwogICAgICBlbHNlIHJlbmRlclNjcmVlblN0YXRlKCk7CiAgICB9CiAgfSk7CiAgc3RhdGUuZXZlbnRTb3VyY2UuYWRkRXZlbnRMaXN0ZW5lcigna2lja2VkJywgKGV2ZW50KSA9PiB7CiAgICBjb25zdCBkYXRhID0gSlNPTi5wYXJzZShldmVudC5kYXRhKTsKICAgIHNlc3Npb25TdG9yYWdlLnJlbW92ZUl0ZW0oUExBWUVSX0tFWShyb29tQ29kZSkpOwogICAgc3RhdGUuZXZlbnRTb3VyY2UuY2xvc2UoKTsKICAgIGFwcC5pbm5lckhUTUwgPSBgPGRpdiBjbGFzcz0id2FpdC1zY3JlZW4iPjxkaXYgY2xhc3M9IndhaXQtY2FyZCI+PGgxPkFjZXNzbyBlbmNlcnJhZG88L2gxPjxwPiR7ZXNjYXBlSHRtbChkYXRhLm1lc3NhZ2UpfTwvcD48YSBocmVmPSIvIiBjbGFzcz0iYnRuIGJ0bi1saWdodCI+Vm9sdGFyIGFvIGluw61jaW88L2E+PC9kaXY+PC9kaXY+YDsKICB9KTsKfQoKZnVuY3Rpb24gcmVuZGVyUGxheWVyU3RhdGUoKSB7CiAgY29uc3Qgcm9vbSA9IHN0YXRlLnJvb207CiAgc3luY011c2ljKHJvb20pOwogIGlmIChyb29tLnBoYXNlID09PSAnbG9iYnknKSByZXR1cm4gcmVuZGVyUGxheWVyTG9iYnkocm9vbSk7CiAgaWYgKHJvb20ucGhhc2UgPT09ICdjb3VudGRvd24nKSByZXR1cm4gcmVuZGVyUGxheWVyQ291bnRkb3duKHJvb20pOwogIGlmIChyb29tLnBoYXNlID09PSAncXVlc3Rpb24nKSByZXR1cm4gcmVuZGVyUGxheWVyUXVlc3Rpb24ocm9vbSk7CiAgaWYgKHJvb20ucGhhc2UgPT09ICdhbnN3ZXInKSByZXR1cm4gcmVuZGVyUGxheWVyQW5zd2VyKHJvb20pOwogIGlmIChyb29tLnBoYXNlID09PSAncmFua2luZycpIHJldHVybiByZW5kZXJQbGF5ZXJSYW5raW5nKHJvb20pOwogIGlmIChyb29tLnBoYXNlID09PSAnZmluaXNoZWQnKSByZXR1cm4gcmVuZGVyUGxheWVyRmluaXNoZWQocm9vbSk7Cn0KCmZ1bmN0aW9uIHJlbmRlclBsYXllckxvYmJ5KHJvb20pIHsKICBjbGVhclRpbWVyKCk7CiAgY29uc3QgcmVhZHkgPSBCb29sZWFuKHN0YXRlLnNlbGYucmVhZHkpOwogIGFwcC5pbm5lckhUTUwgPSBgPGRpdiBjbGFzcz0iZ2FtZS1zaGVsbCBwYXJ0aWNpcGFudC1zaGVsbCI+CiAgICA8aGVhZGVyIGNsYXNzPSJnYW1lLWhlYWRlciB1bmlmaWVkLWdhbWUtaGVhZGVyIj48ZGl2IGNsYXNzPSJjb21wYWN0LWdhbWUtYnJhbmQiPjxzcGFuIGNsYXNzPSJwcmVzZW50ZXItYnJhbmQtbWFyayI+PC9zcGFuPjxzdHJvbmc+UXVpeiBDcmVkc3lzdGVtPC9zdHJvbmc+PC9kaXY+PHNwYW4gY2xhc3M9InJvb20tYmFkZ2UiPlNhbGEgJHtlc2NhcGVIdG1sKHJvb20ucm9vbUNvZGUpfTwvc3Bhbj48L2hlYWRlcj4KICAgIDxtYWluIGNsYXNzPSJwYXJ0aWNpcGFudC1zdGFnZSI+CiAgICAgIDxzZWN0aW9uIGNsYXNzPSJwYXJ0aWNpcGFudC1jYXJkIj4KICAgICAgICAke2F2YXRhclZpc3VhbChzdGF0ZS5zZWxmLmF2YXRhcil9CiAgICAgICAgPGRpdiBjbGFzcz0icGFydGljaXBhbnQtY29weSI+PHNwYW4gY2xhc3M9ImV5ZWJyb3ciPlZvY8OqIGVudHJvdTwvc3Bhbj48aDE+T2zDoSwgJHtlc2NhcGVIdG1sKHN0YXRlLnNlbGYubmlja25hbWUpfSE8L2gxPjxwPkNvbmZpcm1lIHF1YW5kbyBlc3RpdmVyIHByb250byBwYXJhIGNvbWXDp2FyLjwvcD48L2Rpdj4KICAgICAgICA8YnV0dG9uIGlkPSJwbGF5ZXItcmVhZHkiIGNsYXNzPSJyZWFkeS1idXR0b24gJHtyZWFkeSA/ICdpcy1yZWFkeScgOiAnJ30iPjxzcGFuIGNsYXNzPSJyZWFkeS1pY29uIj4ke3JlYWR5ID8gJ+KckycgOiAn4peLJ308L3NwYW4+PHNwYW4+JHtyZWFkeSA/ICdFc3RvdSBwcm9udG8nIDogJ01hcmNhciBjb21vIHByb250byd9PC9zcGFuPjwvYnV0dG9uPgogICAgICAgIDxkaXYgY2xhc3M9ImxvYmJ5LXByb2dyZXNzIj48ZGl2PjxzdHJvbmc+JHtyb29tLnJlYWR5Q291bnQgfHwgMH08L3N0cm9uZz48c3Bhbj5wcm9udG9zPC9zcGFuPjwvZGl2PjxkaXY+PHN0cm9uZz4ke3Jvb20ucGFydGljaXBhbnRDb3VudH08L3N0cm9uZz48c3Bhbj5uYSBzYWxhPC9zcGFuPjwvZGl2PjwvZGl2PgogICAgICAgIDxwIGNsYXNzPSJyZWFkeS1oZWxwZXIiPiR7cmVhZHkgPyAnVHVkbyBjZXJ0by4gQWd1YXJkZSBvIGFwcmVzZW50YWRvciBpbmljaWFyLicgOiAnTyBxdWl6IHPDsyBjb21lw6dhIHF1YW5kbyB0b2RvcyBlc3RpdmVyZW0gcHJvbnRvcy4nfTwvcD4KICAgICAgPC9zZWN0aW9uPgogICAgPC9tYWluPgogIDwvZGl2PmA7CiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3BsYXllci1yZWFkeScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgYXN5bmMgKCkgPT4gewogICAgY29uc3QgYnV0dG9uID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3BsYXllci1yZWFkeScpOwogICAgdHJ5IHsKICAgICAgYnV0dG9uLmRpc2FibGVkID0gdHJ1ZTsKICAgICAgYXdhaXQgYXBpKCcvYXBpL3BsYXllci9yZWFkeScsIHsgcm9vbUNvZGU6IHJvb20ucm9vbUNvZGUsIC4uLnN0YXRlLnBsYXllckNyZWRzLCByZWFkeTogIXJlYWR5IH0pOwogICAgfSBjYXRjaCAoZXJyb3IpIHsKICAgICAgYnV0dG9uLmRpc2FibGVkID0gZmFsc2U7CiAgICAgIHNob3dUb2FzdChlcnJvci5tZXNzYWdlKTsKICAgIH0KICB9KTsKfQoKZnVuY3Rpb24gcmVuZGVyUGxheWVyQ291bnRkb3duKHJvb20pIHsKICBjbGVhclRpbWVyKCk7CiAgYXBwLmlubmVySFRNTCA9IG9wZW5pbmdDb3VudGRvd25NYXJrdXAocm9vbSwgJ3BsYXllcicpOwogIHN0YXJ0T3BlbmluZ0NvdW50ZG93bihyb29tKTsKfQoKZnVuY3Rpb24gcmVuZGVyUGxheWVyUXVlc3Rpb24ocm9vbSkgewogIGNvbnN0IGFuc3dlcmVkID0gc3RhdGUuc2VsZi5hbnN3ZXJJbmRleCAhPT0gbnVsbDsKICBhcHAuaW5uZXJIVE1MID0gYDxkaXYgY2xhc3M9ImdhbWUtc2hlbGwgcGFydGljaXBhbnQtc2hlbGwiPgogICAgPGhlYWRlciBjbGFzcz0iZ2FtZS1oZWFkZXIgdW5pZmllZC1nYW1lLWhlYWRlciI+PGRpdiBjbGFzcz0icGxheWVyLW1ldGEiPiR7YXZhdGFyVmlzdWFsKHN0YXRlLnNlbGYuYXZhdGFyLHRydWUpfTxkaXY+PHN0cm9uZz4ke2VzY2FwZUh0bWwoc3RhdGUuc2VsZi5uaWNrbmFtZSl9PC9zdHJvbmc+PHNtYWxsPiR7c3RhdGUuc2VsZi5zY29yZX0gcG9udG9zPC9zbWFsbD48L2Rpdj48L2Rpdj48ZGl2IGNsYXNzPSJxdWVzdGlvbi1wcm9ncmVzcyI+PHNwYW4+JHtyb29tLmN1cnJlbnRRdWVzdGlvbkluZGV4ICsgMX0vJHtyb29tLnRvdGFsUXVlc3Rpb25zfTwvc3Bhbj48ZGl2IGlkPSJ0aW1lciIgY2xhc3M9InRpbWVyIj4ke3Jvb20ucXVlc3Rpb24udGltZUxpbWl0fTwvZGl2PjwvZGl2PjwvaGVhZGVyPgogICAgPG1haW4gY2xhc3M9ImdhbWUtc3RhZ2UgdW5pZmllZC1xdWVzdGlvbi1zdGFnZSI+PGRpdiBjbGFzcz0icXVlc3Rpb24ta2lja2VyIj5QZXJndW50YSAke3Jvb20uY3VycmVudFF1ZXN0aW9uSW5kZXggKyAxfTwvZGl2PjxoMSBjbGFzcz0icXVlc3Rpb24tdGl0bGUiPiR7ZXNjYXBlSHRtbChyb29tLnF1ZXN0aW9uLnRleHQpfTwvaDE+PGRpdiBjbGFzcz0iYW5zd2Vycy1ncmlkIHBhcnRpY2lwYW50LWFuc3dlcnMgY291bnQtJHtyb29tLnF1ZXN0aW9uLm9wdGlvbnMubGVuZ3RofSI+JHtyb29tLnF1ZXN0aW9uLm9wdGlvbnMubWFwKChvcHRpb24sIGluZGV4KSA9PiBgPGJ1dHRvbiBjbGFzcz0iYW5zd2VyLWJ0biAke2Fuc3dlcmVkICYmIHN0YXRlLnNlbGYuYW5zd2VySW5kZXggPT09IGluZGV4ID8gJ3NlbGVjdGVkJyA6ICcnfSIgZGF0YS1hbnN3ZXI9IiR7aW5kZXh9IiAke2Fuc3dlcmVkID8gJ2Rpc2FibGVkJyA6ICcnfT48c3BhbiBjbGFzcz0ic2hhcGUiPjwvc3Bhbj48c3Bhbj4ke2VzY2FwZUh0bWwob3B0aW9uKX08L3NwYW4+PC9idXR0b24+YCkuam9pbignJyl9PC9kaXY+JHthbnN3ZXJlZCA/ICc8ZGl2IGNsYXNzPSJhbnN3ZXItc2VudCI+4pyTIFJlc3Bvc3RhIGVudmlhZGEuIEFndWFyZGUgbyBlbmNlcnJhbWVudG8uPC9kaXY+JyA6ICcnfTwvbWFpbj4KICA8L2Rpdj5gOwogIHN0YXJ0Q291bnRkb3duKHJvb20pOwogIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLWFuc3dlcl0nKS5mb3JFYWNoKChidXR0b24pID0+IGJ1dHRvbi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIGFzeW5jICgpID0+IHsKICAgIHRyeSB7CiAgICAgIGVuc3VyZUF1ZGlvKCk7CiAgICAgIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLWFuc3dlcl0nKS5mb3JFYWNoKChpdGVtKSA9PiBpdGVtLmRpc2FibGVkID0gdHJ1ZSk7CiAgICAgIGJ1dHRvbi5jbGFzc0xpc3QuYWRkKCdzZWxlY3RlZCcpOwogICAgICBhd2FpdCBhcGkoJy9hcGkvcGxheWVyL2Fuc3dlcicsIHsgcm9vbUNvZGU6IHJvb20ucm9vbUNvZGUsIC4uLnN0YXRlLnBsYXllckNyZWRzLCBhbnN3ZXJJbmRleDogTnVtYmVyKGJ1dHRvbi5kYXRhc2V0LmFuc3dlcikgfSk7CiAgICAgIHN0YXRlLnNlbGYuYW5zd2VySW5kZXggPSBOdW1iZXIoYnV0dG9uLmRhdGFzZXQuYW5zd2VyKTsKICAgICAgc2hvd1RvYXN0KCdSZXNwb3N0YSBlbnZpYWRhLicpOwogICAgfSBjYXRjaCAoZXJyb3IpIHsKICAgICAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtYW5zd2VyXScpLmZvckVhY2goKGl0ZW0pID0+IGl0ZW0uZGlzYWJsZWQgPSBmYWxzZSk7CiAgICAgIHNob3dUb2FzdChlcnJvci5tZXNzYWdlKTsKICAgIH0KICB9KSk7Cn0KCmZ1bmN0aW9uIHJlbmRlclBsYXllckFuc3dlcihyb29tKSB7CiAgY2xlYXJUaW1lcigpOwogIGNvbnN0IGNvcnJlY3QgPSBzdGF0ZS5zZWxmLmxhc3RDb3JyZWN0OwogIGFwcC5pbm5lckhUTUwgPSBgPGRpdiBjbGFzcz0iZ2FtZS1zaGVsbCI+CiAgICA8aGVhZGVyIGNsYXNzPSJnYW1lLWhlYWRlciI+PGRpdj4ke2VzY2FwZUh0bWwoc3RhdGUuc2VsZi5uaWNrbmFtZSl9PC9kaXY+PGRpdj48c3Ryb25nPiR7c3RhdGUuc2VsZi5zY29yZX08L3N0cm9uZz4gcG9udG9zPC9kaXY+PC9oZWFkZXI+CiAgICA8bWFpbiBjbGFzcz0iZ2FtZS1zdGFnZSB0ZXh0LWNlbnRlciI+PGRpdiBzdHlsZT0iZm9udC1zaXplOjc0cHgiPiR7Y29ycmVjdCA9PT0gdHJ1ZSA/ICfinIUnIDogY29ycmVjdCA9PT0gZmFsc2UgPyAn8J+SoScgOiAn4o+x77iPJ308L2Rpdj48aDEgY2xhc3M9InF1ZXN0aW9uLXRpdGxlIj4ke2NvcnJlY3QgPT09IHRydWUgPyBgQWNlcnRvdSEgKyR7c3RhdGUuc2VsZi5sYXN0UG9pbnRzfSBwb250b3NgIDogY29ycmVjdCA9PT0gZmFsc2UgPyAnTsOjbyBmb2kgZGVzc2EgdmV6JyA6ICdUZW1wbyBlbmNlcnJhZG8nfTwvaDE+PGRpdiBjbGFzcz0iYW5zd2Vycy1ncmlkIj4ke3Jvb20ucXVlc3Rpb24ub3B0aW9ucy5tYXAoKG9wdGlvbiwgaW5kZXgpID0+IGA8ZGl2IGNsYXNzPSJhbnN3ZXItY2FyZCAke2luZGV4ID09PSByb29tLnF1ZXN0aW9uLmNvcnJlY3RJbmRleCA/ICdjb3JyZWN0JyA6ICdkaW1tZWQnfSI+PHNwYW4gY2xhc3M9InNoYXBlIj48L3NwYW4+PHNwYW4+JHtlc2NhcGVIdG1sKG9wdGlvbil9PC9zcGFuPjwvZGl2PmApLmpvaW4oJycpfTwvZGl2PiR7cm9vbS5xdWVzdGlvbi5leHBsYW5hdGlvbiA/IGA8ZGl2IGNsYXNzPSJjYXJkIiBzdHlsZT0iY29sb3I6dmFyKC0taW5rKSI+PHN0cm9uZz5Qb3IgcXVlPzwvc3Ryb25nPjxwPiR7ZXNjYXBlSHRtbChyb29tLnF1ZXN0aW9uLmV4cGxhbmF0aW9uKX08L3A+PC9kaXY+YCA6ICcnfTxwIGNsYXNzPSJ3aGl0ZS1tdXRlZCI+TyByYW5raW5nIHNlcsOhIHJldmVsYWRvIHBlbG8gYXByZXNlbnRhZG9yLjwvcD48L21haW4+CiAgPC9kaXY+YDsKfQoKZnVuY3Rpb24gcmVuZGVyUGxheWVyUmFua2luZyhyb29tKSB7CiAgY2xlYXJUaW1lcigpOwogIGFwcC5pbm5lckhUTUwgPSBgPGRpdiBjbGFzcz0iZ2FtZS1zaGVsbCI+PGhlYWRlciBjbGFzcz0iZ2FtZS1oZWFkZXIiPiR7YnJhbmRNYXJrdXAodHJ1ZSl9PHNwYW4+UmFua2luZyBhdHVhbGl6YWRvPC9zcGFuPjwvaGVhZGVyPjxtYWluIGNsYXNzPSJnYW1lLXN0YWdlIj48aDEgY2xhc3M9InF1ZXN0aW9uLXRpdGxlIj5RdWVtIGVzdMOhIG5vIHRvcG8/PC9oMT4ke2xlYWRlcmJvYXJkTWFya3VwKHJvb20ubGVhZGVyYm9hcmQpfTwvbWFpbj48L2Rpdj5gOwogIHN0YXJ0UmFua2luZ0FuaW1hdGlvbihyb29tKTsKfQoKZnVuY3Rpb24gcmVuZGVyUGxheWVyRmluaXNoZWQocm9vbSkgewogIGNsZWFyVGltZXIoKTsgc3RvcE11c2ljKCk7CiAgYXBwLmlubmVySFRNTCA9IGA8ZGl2IGNsYXNzPSJnYW1lLXNoZWxsIj48aGVhZGVyIGNsYXNzPSJnYW1lLWhlYWRlciI+JHticmFuZE1hcmt1cCh0cnVlKX08c3Bhbj5RdWl6IGVuY2VycmFkbzwvc3Bhbj48L2hlYWRlcj48bWFpbiBjbGFzcz0iZ2FtZS1zdGFnZSB0ZXh0LWNlbnRlciI+PGRpdiBjbGFzcz0iZXllYnJvdyIgc3R5bGU9Im1hcmdpbjphdXRvO2JhY2tncm91bmQ6cmdiYSgyNTUsMjU1LDI1NSwuMTQpO2NvbG9yOndoaXRlIj5Qw7NkaW8gZmluYWw8L2Rpdj48aDEgY2xhc3M9InF1ZXN0aW9uLXRpdGxlIj5QYXJhYsOpbnMgYW9zIHZlbmNlZG9yZXMhPC9oMT4ke3BvZGl1bU1hcmt1cChyb29tKX08ZGl2IGNsYXNzPSJjYXJkIiBzdHlsZT0iY29sb3I6dmFyKC0taW5rKTttYXgtd2lkdGg6NTIwcHg7bWFyZ2luOjIwcHggYXV0byI+PGgyPlN1YSBjb2xvY2HDp8OjbzwvaDI+PHAgc3R5bGU9ImZvbnQtc2l6ZTozOHB4O2ZvbnQtd2VpZ2h0Ojk1MDttYXJnaW46OHB4Ij4ke3N0YXRlLnNlbGYucG9zaXRpb24gfHwgJy0nfcK6PC9wPjxwPiR7c3RhdGUuc2VsZi5zY29yZX0gcG9udG9zIMK3ICR7c3RhdGUuc2VsZi5jb3JyZWN0QW5zd2Vyc30gYWNlcnRvczwvcD48L2Rpdj48YSBjbGFzcz0iYnRuIGJ0bi1saWdodCIgaHJlZj0iLyI+U2FpcjwvYT48L21haW4+PC9kaXY+YDsKfQoKYXN5bmMgZnVuY3Rpb24gb3BlblByZXNlbnRlcihyb29tQ29kZSkgewogIHN0YXRlLnJvb21Sb2xlID0gJ2FkbWluJzsKICBjb25zdCBzdG9yZWQgPSBzZXNzaW9uU3RvcmFnZS5nZXRJdGVtKFBSRVNFTlRFUl9LRVkocm9vbUNvZGUpKTsKICBpZiAoIXN0b3JlZCkgewogICAgYXBwLmlubmVySFRNTCA9IGA8ZGl2IGNsYXNzPSJ3YWl0LXNjcmVlbiI+PGRpdiBjbGFzcz0id2FpdC1jYXJkIj48aDE+QXByZXNlbnRhw6fDo28gbsOjbyBlbmNvbnRyYWRhPC9oMT48cD5BYnJhIGVzdGEgc2FsYSBwZWxvIHBhaW5lbCBhZG1pbmlzdHJhdGl2by48L3A+PGJ1dHRvbiBpZD0iZ28tYWRtaW4iIGNsYXNzPSJidG4gYnRuLWxpZ2h0Ij5JciBhbyBwYWluZWw8L2J1dHRvbj48L2Rpdj48L2Rpdj5gOwogICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2dvLWFkbWluJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBvcGVuQWRtaW4pOwogICAgcmV0dXJuOwogIH0KICBzdGF0ZS5wcmVzZW50ZXJDcmVkcyA9IEpTT04ucGFyc2Uoc3RvcmVkKTsKICB0cnkgewogICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgYXBpKCcvYXBpL2FkbWluL3Jlc3VtZScsIHN0YXRlLnByZXNlbnRlckNyZWRzKTsKICAgIHN0YXRlLnJvb20gPSByZXN1bHQuc3RhdGU7CiAgICBvcGVuUm9vbUV2ZW50cygnYWRtaW4nLCByb29tQ29kZSwgc3RhdGUucHJlc2VudGVyQ3JlZHMuYWRtaW5Ub2tlbik7CiAgICByZW5kZXJQcmVzZW50ZXJTdGF0ZSgpOwogICAgc2hvd0F1ZGlvR2F0ZSgpOwogIH0gY2F0Y2ggKGVycm9yKSB7CiAgICBzaG93VG9hc3QoZXJyb3IubWVzc2FnZSk7CiAgICBzZXNzaW9uU3RvcmFnZS5yZW1vdmVJdGVtKFBSRVNFTlRFUl9LRVkocm9vbUNvZGUpKTsKICAgIG9wZW5BZG1pbigpOwogIH0KfQoKZnVuY3Rpb24gcmVuZGVyUHJlc2VudGVyU3RhdGUoKSB7CiAgY29uc3Qgcm9vbSA9IHN0YXRlLnJvb207CiAgc3luY011c2ljKHJvb20pOwogIGlmIChyb29tLnBoYXNlID09PSAnbG9iYnknKSByZW5kZXJQcmVzZW50ZXJMb2JieShyb29tKTsKICBlbHNlIGlmIChyb29tLnBoYXNlID09PSAnY291bnRkb3duJykgcmVuZGVyUHJlc2VudGVyQ291bnRkb3duKHJvb20pOwogIGVsc2UgaWYgKHJvb20ucGhhc2UgPT09ICdxdWVzdGlvbicpIHJlbmRlclByZXNlbnRlclF1ZXN0aW9uKHJvb20pOwogIGVsc2UgaWYgKHJvb20ucGhhc2UgPT09ICdhbnN3ZXInKSByZW5kZXJQcmVzZW50ZXJBbnN3ZXIocm9vbSk7CiAgZWxzZSBpZiAocm9vbS5waGFzZSA9PT0gJ3JhbmtpbmcnKSByZW5kZXJQcmVzZW50ZXJSYW5raW5nKHJvb20pOwogIGVsc2UgcmVuZGVyUHJlc2VudGVyRmluaXNoZWQocm9vbSk7CiAgYmluZFByZXNlbnRlckNvbnRyb2xzKHJvb20pOwp9CgpmdW5jdGlvbiBwcmVzZW50ZXJIZWFkZXIocm9vbSkgewogIGNvbnN0IHNvdW5kTGFiZWwgPSBzdGF0ZS5hdWRpby5lbmFibGVkICYmIHN0YXRlLmF1ZGlvLnVubG9ja2VkID8gJ1NvbSBsaWdhZG8nIDogJ0F0aXZhciBzb20nOwogIHJldHVybiBgPGhlYWRlciBjbGFzcz0icHJlc2VudGVyLWhlYWRlciI+PGRpdiBjbGFzcz0icHJlc2VudGVyLWJyYW5kIj48c3BhbiBjbGFzcz0icHJlc2VudGVyLWJyYW5kLW1hcmsiPjwvc3Bhbj48c3Ryb25nPlF1aXogQ3JlZHN5c3RlbTwvc3Ryb25nPjwvZGl2PjxkaXYgY2xhc3M9InByZXNlbnRlci1oZWFkZXItbWV0YSI+PHNwYW4+JHtlc2NhcGVIdG1sKHBoYXNlTGFiZWwocm9vbS5waGFzZSkpfTwvc3Bhbj48YnV0dG9uIGlkPSJhdWRpby10b2dnbGUiIGNsYXNzPSJwcmVzZW50ZXItYXVkaW8tYnV0dG9uIj4ke3NvdW5kTGFiZWx9PC9idXR0b24+PC9kaXY+PC9oZWFkZXI+YDsKfQoKZnVuY3Rpb24gcmVuZGVyUHJlc2VudGVyTG9iYnkocm9vbSkgewogIGNsZWFyVGltZXIoKTsKICBjb25zdCBhbGxSZWFkeSA9IHJvb20ucGFydGljaXBhbnRDb3VudCA+IDAgJiYgcm9vbS5yZWFkeUNvdW50ID09PSByb29tLnBhcnRpY2lwYW50Q291bnQ7CiAgYXBwLmlubmVySFRNTCA9IGA8ZGl2IGNsYXNzPSJwcmVzZW50ZXItc2hlbGwiPiR7cHJlc2VudGVySGVhZGVyKHJvb20pfTxtYWluIGNsYXNzPSJwcmVzZW50ZXItc3RhZ2UiPjxkaXYgY2xhc3M9InByZXNlbnRlci1sb2JieSBzdGFuZGFyZGl6ZWQtbG9iYnkiPjxzZWN0aW9uIGNsYXNzPSJsb2JieS1hY2Nlc3MtcGFuZWwiPjxkaXY+PHNwYW4gY2xhc3M9ImxvYmJ5LWxhYmVsIj5FbnRyZSBwZWxvIGPDs2RpZ288L3NwYW4+PGRpdiBjbGFzcz0ibG9iYnktY29kZSI+JHtyb29tLnJvb21Db2RlfTwvZGl2PjxwPkVzY2FuZWllIG8gUVIgQ29kZSBvdSB1c2UgbyBsaW5rIGRhIHNhbGEuPC9wPjwvZGl2PjxkaXYgaWQ9InByZXNlbnRlci1xciIgY2xhc3M9InFyLXdyYXAgY29tcGFjdC1xciI+PC9kaXY+PGRpdiBjbGFzcz0iY29weS1saW5rLXJvdyI+PGlucHV0IGlkPSJqb2luLWxpbmsiIGNsYXNzPSJpbnB1dCIgcmVhZG9ubHkgdmFsdWU9IiR7ZXNjYXBlSHRtbChyb29tLmpvaW5VcmwpfSI+PGJ1dHRvbiBpZD0iY29weS1qb2luIiBjbGFzcz0iYnRuIGJ0bi1saWdodCI+Q29waWFyPC9idXR0b24+PC9kaXY+PC9zZWN0aW9uPjxzZWN0aW9uIGNsYXNzPSJsb2JieS1yZWFkeS1wYW5lbCI+PGRpdiBjbGFzcz0icmVhZHktc3VtbWFyeSI+PGRpdj48c3Bhbj5Qcm9udG9zPC9zcGFuPjxzdHJvbmc+JHtyb29tLnJlYWR5Q291bnQgfHwgMH0vJHtyb29tLnBhcnRpY2lwYW50Q291bnR9PC9zdHJvbmc+PC9kaXY+PGRpdiBjbGFzcz0icmVhZHktbWV0ZXIiPjxzcGFuIHN0eWxlPSJ3aWR0aDoke3Jvb20ucGFydGljaXBhbnRDb3VudCA/IE1hdGgucm91bmQoKHJvb20ucmVhZHlDb3VudCB8fCAwKSAvIHJvb20ucGFydGljaXBhbnRDb3VudCAqIDEwMCkgOiAwfSUiPjwvc3Bhbj48L2Rpdj48cD4ke2FsbFJlYWR5ID8gJ1RvZG9zIGVzdMOjbyBwcm9udG9zLiBWb2PDqiBqw6EgcG9kZSBpbmljaWFyLicgOiByb29tLnBhcnRpY2lwYW50Q291bnQgPyAnQWd1YXJkYW5kbyB0b2RvcyBjb25maXJtYXJlbSBxdWUgZXN0w6NvIHByb250b3MuJyA6ICdBZ3VhcmRhbmRvIHBhcnRpY2lwYW50ZXMgZW50cmFyZW0uJ308L3A+PC9kaXY+PGRpdiBjbGFzcz0icGxheWVyLXJlYWR5LWxpc3QiPiR7cm9vbS5wbGF5ZXJzLmxlbmd0aCA/IHJvb20ucGxheWVycy5tYXAoKHBsYXllcikgPT4gYDxkaXYgY2xhc3M9InJlYWR5LXBsYXllciAke3BsYXllci5yZWFkeSA/ICdpcy1yZWFkeScgOiAnJ30iPiR7YXZhdGFyVmlzdWFsKHBsYXllci5hdmF0YXIsdHJ1ZSl9PGRpdj48c3Ryb25nPiR7ZXNjYXBlSHRtbChwbGF5ZXIubmlja25hbWUpfTwvc3Ryb25nPjxzbWFsbD4ke3BsYXllci5yZWFkeSA/ICdQcm9udG8nIDogJ0FndWFyZGFuZG8nfTwvc21hbGw+PC9kaXY+PHNwYW4gY2xhc3M9InJlYWR5LWNoZWNrIj4ke3BsYXllci5yZWFkeSA/ICfinJMnIDogJ+KApid9PC9zcGFuPjwvZGl2PmApLmpvaW4oJycpIDogJzxkaXYgY2xhc3M9ImVtcHR5IGRhcmstZW1wdHkiPk5lbmh1bSBwYXJ0aWNpcGFudGUgZW50cm91IGFpbmRhLjwvZGl2Pid9PC9kaXY+PC9zZWN0aW9uPjwvZGl2PjwvbWFpbj4ke2NvbnRyb2xEb2NrKHJvb20pfTwvZGl2PmA7CiAgcmVuZGVyUXIoJ3ByZXNlbnRlci1xcicsIHJvb20uam9pblVybCwgMjIwKTsKfQoKZnVuY3Rpb24gcmVuZGVyUHJlc2VudGVyQ291bnRkb3duKHJvb20pIHsKICBjbGVhclRpbWVyKCk7CiAgYXBwLmlubmVySFRNTCA9IGA8ZGl2IGNsYXNzPSJwcmVzZW50ZXItc2hlbGwiPiR7cHJlc2VudGVySGVhZGVyKHJvb20pfSR7b3BlbmluZ0NvdW50ZG93bk1hcmt1cChyb29tLCAncHJlc2VudGVyJyl9JHtjb250cm9sRG9jayhyb29tKX08L2Rpdj5gOwogIHN0YXJ0T3BlbmluZ0NvdW50ZG93bihyb29tKTsKfQoKZnVuY3Rpb24gcmVuZGVyUHJlc2VudGVyUXVlc3Rpb24ocm9vbSkgewogIGFwcC5pbm5lckhUTUwgPSBgPGRpdiBjbGFzcz0icHJlc2VudGVyLXNoZWxsIj4ke3ByZXNlbnRlckhlYWRlcihyb29tKX08bWFpbiBjbGFzcz0icHJlc2VudGVyLXN0YWdlIHByZXNlbnRlci1xdWVzdGlvbi1zdGFnZSI+PGRpdiBjbGFzcz0icXVlc3Rpb24tdG9wIj48c3Bhbj5QZXJndW50YSAke3Jvb20uY3VycmVudFF1ZXN0aW9uSW5kZXggKyAxfS8ke3Jvb20udG90YWxRdWVzdGlvbnN9PC9zcGFuPjxkaXYgaWQ9InRpbWVyIiBjbGFzcz0idGltZXIiPiR7cm9vbS5xdWVzdGlvbi50aW1lTGltaXR9PC9kaXY+PHNwYW4+JHtyb29tLnJlc3BvbnNlQ291bnR9LyR7cm9vbS5wYXJ0aWNpcGFudENvdW50fSByZXNwb3N0YXM8L3NwYW4+PC9kaXY+PGgxIGNsYXNzPSJxdWVzdGlvbi10aXRsZSI+JHtlc2NhcGVIdG1sKHJvb20ucXVlc3Rpb24udGV4dCl9PC9oMT48ZGl2IGNsYXNzPSJhbnN3ZXJzLWdyaWQgcHJlc2VudGVyLWFuc3dlcnMgY291bnQtJHtyb29tLnF1ZXN0aW9uLm9wdGlvbnMubGVuZ3RofSI+JHtyb29tLnF1ZXN0aW9uLm9wdGlvbnMubWFwKChvcHRpb24pID0+IGA8ZGl2IGNsYXNzPSJhbnN3ZXItY2FyZCI+PHNwYW4gY2xhc3M9InNoYXBlIj48L3NwYW4+PHNwYW4+JHtlc2NhcGVIdG1sKG9wdGlvbil9PC9zcGFuPjwvZGl2PmApLmpvaW4oJycpfTwvZGl2PjwvbWFpbj4ke2NvbnRyb2xEb2NrKHJvb20pfTwvZGl2PmA7CiAgc3RhcnRDb3VudGRvd24ocm9vbSk7Cn0KCmZ1bmN0aW9uIHJlbmRlclByZXNlbnRlckFuc3dlcihyb29tKSB7CiAgY2xlYXJUaW1lcigpOwogIGNvbnN0IG1heENvdW50ID0gTWF0aC5tYXgoMSwgLi4ucm9vbS5kaXN0cmlidXRpb24ubWFwKChpdGVtKSA9PiBpdGVtLmNvdW50KSk7CiAgYXBwLmlubmVySFRNTCA9IGA8ZGl2IGNsYXNzPSJwcmVzZW50ZXItc2hlbGwiPiR7cHJlc2VudGVySGVhZGVyKHJvb20pfTxtYWluIGNsYXNzPSJwcmVzZW50ZXItc3RhZ2UgcHJlc2VudGVyLWFuc3dlci1zdGFnZSI+PGRpdiBjbGFzcz0iY29tcGFjdC1zZWN0aW9uLXRpdGxlIj48c3Bhbj5SZXNwb3N0YSBjb3JyZXRhPC9zcGFuPjxzdHJvbmc+JHtyb29tLnJlc3BvbnNlQ291bnR9LyR7cm9vbS5wYXJ0aWNpcGFudENvdW50fSByZXNwb25kZXJhbTwvc3Ryb25nPjwvZGl2PjxkaXYgY2xhc3M9ImFuc3dlcnMtZ3JpZCBwcmVzZW50ZXItYW5zd2VycyBjb3VudC0ke3Jvb20ucXVlc3Rpb24ub3B0aW9ucy5sZW5ndGh9Ij4ke3Jvb20ucXVlc3Rpb24ub3B0aW9ucy5tYXAoKG9wdGlvbixpbmRleCkgPT4gYDxkaXYgY2xhc3M9ImFuc3dlci1jYXJkICR7aW5kZXggPT09IHJvb20ucXVlc3Rpb24uY29ycmVjdEluZGV4ID8gJ2NvcnJlY3QnIDogJ2RpbW1lZCd9Ij48c3BhbiBjbGFzcz0ic2hhcGUiPjwvc3Bhbj48c3Bhbj4ke2VzY2FwZUh0bWwob3B0aW9uKX08L3NwYW4+PC9kaXY+YCkuam9pbignJyl9PC9kaXY+PGRpdiBjbGFzcz0iZGlzdHJpYnV0aW9uIGNvbXBhY3QtZGlzdHJpYnV0aW9uIj4ke3Jvb20uZGlzdHJpYnV0aW9uLm1hcCgoaXRlbSkgPT4gYDxkaXYgY2xhc3M9ImRpc3RyaWJ1dGlvbi1yb3cgJHtpdGVtLmNvcnJlY3QgPyAnY29ycmVjdCcgOiAnJ30iPjxzdHJvbmc+JHtlc2NhcGVIdG1sKGl0ZW0ub3B0aW9uKX08L3N0cm9uZz48ZGl2IGNsYXNzPSJiYXItdHJhY2siPjxkaXYgY2xhc3M9ImJhci1maWxsIiBzdHlsZT0id2lkdGg6JHtNYXRoLnJvdW5kKGl0ZW0uY291bnQgLyBtYXhDb3VudCAqIDEwMCl9JSI+PC9kaXY+PC9kaXY+PHN0cm9uZz4ke2l0ZW0uY291bnR9PC9zdHJvbmc+PC9kaXY+YCkuam9pbignJyl9PC9kaXY+JHtyb29tLnF1ZXN0aW9uLmV4cGxhbmF0aW9uID8gYDxkaXYgY2xhc3M9InByZXNlbnRlci1leHBsYW5hdGlvbiI+PHN0cm9uZz5FeHBsaWNhw6fDo286PC9zdHJvbmc+ICR7ZXNjYXBlSHRtbChyb29tLnF1ZXN0aW9uLmV4cGxhbmF0aW9uKX08L2Rpdj5gIDogJyd9PC9tYWluPiR7Y29udHJvbERvY2socm9vbSl9PC9kaXY+YDsKfQoKZnVuY3Rpb24gcmVuZGVyUHJlc2VudGVyUmFua2luZyhyb29tKSB7CiAgY2xlYXJUaW1lcigpOwogIGFwcC5pbm5lckhUTUwgPSBgPGRpdiBjbGFzcz0icHJlc2VudGVyLXNoZWxsIj4ke3ByZXNlbnRlckhlYWRlcihyb29tKX08bWFpbiBjbGFzcz0icHJlc2VudGVyLXN0YWdlIHByZXNlbnRlci1yYW5raW5nLXN0YWdlIj48ZGl2IGNsYXNzPSJjb21wYWN0LXNlY3Rpb24tdGl0bGUiPjxzcGFuPlJhbmtpbmcgZGEgcm9kYWRhPC9zcGFuPjxzdHJvbmc+JHtyb29tLmN1cnJlbnRRdWVzdGlvbkluZGV4ICsgMX0vJHtyb29tLnRvdGFsUXVlc3Rpb25zfTwvc3Ryb25nPjwvZGl2PiR7bGVhZGVyYm9hcmRNYXJrdXAocm9vbS5sZWFkZXJib2FyZCl9PC9tYWluPiR7Y29udHJvbERvY2socm9vbSl9PC9kaXY+YDsKICBzdGFydFJhbmtpbmdBbmltYXRpb24ocm9vbSk7Cn0KCmZ1bmN0aW9uIHJlbmRlclByZXNlbnRlckZpbmlzaGVkKHJvb20pIHsKICBjbGVhclRpbWVyKCk7IHN0b3BNdXNpYygpOwogIGNvbnN0IHJlcGxhY2VtZW50ID0gcm9vbS5yZXBsYWNlbWVudDsKICBhcHAuaW5uZXJIVE1MID0gYDxkaXYgY2xhc3M9InByZXNlbnRlci1zaGVsbCI+JHtwcmVzZW50ZXJIZWFkZXIocm9vbSl9PG1haW4gY2xhc3M9InByZXNlbnRlci1zdGFnZSB0ZXh0LWNlbnRlciI+PGRpdiBjbGFzcz0iZXllYnJvdyIgc3R5bGU9Im1hcmdpbjphdXRvO2JhY2tncm91bmQ6cmdiYSgyNTUsMjU1LDI1NSwuMTQpO2NvbG9yOndoaXRlIj5SZXN1bHRhZG8gZmluYWw8L2Rpdj48aDEgY2xhc3M9InF1ZXN0aW9uLXRpdGxlIj5Qw7NkaW8gZG8gcXVpejwvaDE+JHtwb2RpdW1NYXJrdXAocm9vbSl9PGRpdiBjbGFzcz0iZ3JpZC0yIiBzdHlsZT0ibWFyZ2luLXRvcDozMHB4Ij48ZGl2IGNsYXNzPSJjYXJkIiBzdHlsZT0iY29sb3I6dmFyKC0taW5rKTt0ZXh0LWFsaWduOmxlZnQiPjxoMj5SZWxhdMOzcmlvIGNvbXBsZXRvPC9oMj48cCBjbGFzcz0ibXV0ZWQiPkRhdGEsIGhvcsOhcmlvLCBwcmVzZW7Dp2EsIHBvbnR1YcOnw6NvIGUgcmVzcG9zdGEgZGUgY2FkYSBxdWVzdMOjby48L3A+PGEgY2xhc3M9ImJ0biBidG4tcHJpbWFyeSBidG4tYmxvY2siIGhyZWY9Ii9hcGkvYWRtaW4vcmVwb3J0Lnhscz9yb29tPSR7ZW5jb2RlVVJJQ29tcG9uZW50KHJvb20ucm9vbUNvZGUpfSZ0b2tlbj0ke2VuY29kZVVSSUNvbXBvbmVudChzdGF0ZS5wcmVzZW50ZXJDcmVkcy5hZG1pblRva2VuKX0iPkJhaXhhciByZWxhdMOzcmlvIEV4Y2VsPC9hPjwvZGl2PiR7cmVwbGFjZW1lbnQgPyBgPGRpdiBjbGFzcz0iY2FyZCBkYXJrIj48aDI+Tm92byBsaW5rIGUgUVIgQ29kZTwvaDI+PHAgY2xhc3M9IndoaXRlLW11dGVkIj5PIGPDs2RpZ28gYW50aWdvIGZvaSBlbmNlcnJhZG8uIEEgcHLDs3hpbWEgc2FsYSBqw6EgZXN0w6EgcHJvbnRhLjwvcD48ZGl2IGNsYXNzPSJsb2JieS1jb2RlIiBzdHlsZT0iZm9udC1zaXplOjUycHgiPiR7cmVwbGFjZW1lbnQucm9vbUNvZGV9PC9kaXY+PGRpdiBpZD0icmVwbGFjZW1lbnQtcXIiIGNsYXNzPSJxci13cmFwIiBzdHlsZT0ibWFyZ2luOjE4cHggYXV0byI+PC9kaXY+PGJ1dHRvbiBpZD0ib3Blbi1yZXBsYWNlbWVudCIgY2xhc3M9ImJ0biBidG4tbGlnaHQgYnRuLWJsb2NrIj5BYnJpciBub3ZhIHNhbGE8L2J1dHRvbj48L2Rpdj5gIDogJyd9PC9kaXY+PC9tYWluPiR7Y29udHJvbERvY2socm9vbSl9PC9kaXY+YDsKICBpZiAocmVwbGFjZW1lbnQpIHJlbmRlclFyKCdyZXBsYWNlbWVudC1xcicsIHJlcGxhY2VtZW50LmpvaW5VcmwsIDIxMCk7Cn0KCmZ1bmN0aW9uIGNvbnRyb2xEb2NrKHJvb20pIHsKICBsZXQgYWN0aW9ucyA9ICcnOwogIGlmIChyb29tLnBoYXNlID09PSAnbG9iYnknKSB7IGNvbnN0IGNhblN0YXJ0ID0gcm9vbS5wYXJ0aWNpcGFudENvdW50ID4gMCAmJiByb29tLnJlYWR5Q291bnQgPT09IHJvb20ucGFydGljaXBhbnRDb3VudDsgYWN0aW9ucyA9IGA8YnV0dG9uIGNsYXNzPSJidG4gYnRuLXByaW1hcnkiIGRhdGEtY29tbWFuZD0ic3RhcnQiICR7Y2FuU3RhcnQgPyAnJyA6ICdkaXNhYmxlZCd9PiR7Y2FuU3RhcnQgPyAnSW5pY2lhciBxdWl6JyA6IGBBZ3VhcmRhbmRvICR7TWF0aC5tYXgoMCwgcm9vbS5wYXJ0aWNpcGFudENvdW50IC0gKHJvb20ucmVhZHlDb3VudCB8fCAwKSl9IHByb250byhzKWB9PC9idXR0b24+PGJ1dHRvbiBjbGFzcz0iYnRuIGJ0bi1kYW5nZXIiIGRhdGEtY29tbWFuZD0iZmluaXNoIj5FbmNlcnJhciBzYWxhPC9idXR0b24+YDsgfQogIGlmIChyb29tLnBoYXNlID09PSAnY291bnRkb3duJykgYWN0aW9ucyA9IGA8YnV0dG9uIGNsYXNzPSJidG4gYnRuLWRhbmdlciIgZGF0YS1jb21tYW5kPSJmaW5pc2giPkNhbmNlbGFyIGUgZW5jZXJyYXI8L2J1dHRvbj5gOwogIGlmIChyb29tLnBoYXNlID09PSAncXVlc3Rpb24nKSBhY3Rpb25zID0gYDxidXR0b24gY2xhc3M9ImJ0biBidG4td2FybmluZyIgZGF0YS1jb21tYW5kPSJyZXZlYWwiPlJldmVsYXIgcmVzcG9zdGE8L2J1dHRvbj48YnV0dG9uIGNsYXNzPSJidG4gYnRuLWRhbmdlciIgZGF0YS1jb21tYW5kPSJmaW5pc2giPkVuY2VycmFyIHF1aXo8L2J1dHRvbj5gOwogIGlmIChyb29tLnBoYXNlID09PSAnYW5zd2VyJykgYWN0aW9ucyA9IGA8YnV0dG9uIGNsYXNzPSJidG4gYnRuLXByaW1hcnkiIGRhdGEtY29tbWFuZD0icmFua2luZyI+TW9zdHJhciByYW5raW5nPC9idXR0b24+PGJ1dHRvbiBjbGFzcz0iYnRuIGJ0bi1kYW5nZXIiIGRhdGEtY29tbWFuZD0iZmluaXNoIj5FbmNlcnJhciBxdWl6PC9idXR0b24+YDsKICBpZiAocm9vbS5waGFzZSA9PT0gJ3JhbmtpbmcnKSBhY3Rpb25zID0gYDxidXR0b24gY2xhc3M9ImJ0biBidG4tcHJpbWFyeSIgZGF0YS1jb21tYW5kPSJuZXh0Ij4ke3Jvb20uY3VycmVudFF1ZXN0aW9uSW5kZXggKyAxID49IHJvb20udG90YWxRdWVzdGlvbnMgPyAnTW9zdHJhciBww7NkaW8gZmluYWwnIDogJ1Byw7N4aW1hIHF1ZXN0w6NvJ308L2J1dHRvbj48YnV0dG9uIGNsYXNzPSJidG4gYnRuLWRhbmdlciIgZGF0YS1jb21tYW5kPSJmaW5pc2giPkVuY2VycmFyIHF1aXo8L2J1dHRvbj5gOwogIGlmIChyb29tLnBoYXNlID09PSAnZmluaXNoZWQnKSBhY3Rpb25zID0gYDxidXR0b24gY2xhc3M9ImJ0biBidG4tbGlnaHQiIGlkPSJiYWNrLWRhc2hib2FyZCI+Vm9sdGFyIGFvIHBhaW5lbDwvYnV0dG9uPmA7CiAgcmV0dXJuIGA8ZGl2IGNsYXNzPSJjb250cm9sLWRvY2siPjxkaXYgY2xhc3M9ImNvbnRyb2wtc3RhdHVzIj48c3Ryb25nPiR7ZXNjYXBlSHRtbChyb29tLnF1aXpUaXRsZSl9PC9zdHJvbmc+PHNtYWxsPiR7cm9vbS5waGFzZSA9PT0gJ2xvYmJ5JyA/IGAke3Jvb20ucmVhZHlDb3VudCB8fCAwfS8ke3Jvb20ucGFydGljaXBhbnRDb3VudH0gcHJvbnRvc2AgOiBgJHtyb29tLnBhcnRpY2lwYW50Q291bnR9IHByZXNlbnRlcyDCtyAke3Jvb20ucmVzcG9uc2VDb3VudH0gcmVzcG9zdGFzYH08L3NtYWxsPjwvZGl2PjxkaXYgY2xhc3M9ImNvbnRyb2wtYWN0aW9ucyI+JHthY3Rpb25zfTwvZGl2PjwvZGl2PmA7Cn0KCmZ1bmN0aW9uIGJpbmRQcmVzZW50ZXJDb250cm9scyhyb29tKSB7CiAgY29uc3QgYXVkaW9CdXR0b24gPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnYXVkaW8tdG9nZ2xlJyk7CiAgaWYgKGF1ZGlvQnV0dG9uKSBhdWRpb0J1dHRvbi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIHRvZ2dsZUF1ZGlvKTsKICBjb25zdCBjb3B5QnV0dG9uID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2NvcHktam9pbicpOwogIGlmIChjb3B5QnV0dG9uKSBjb3B5QnV0dG9uLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gY29weVRleHQocm9vbS5qb2luVXJsKSk7CiAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtY29tbWFuZF0nKS5mb3JFYWNoKChidXR0b24pID0+IGJ1dHRvbi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIGFzeW5jICgpID0+IHsKICAgIHRyeSB7CiAgICAgIGVuc3VyZUF1ZGlvKCk7CiAgICAgIGJ1dHRvbi5kaXNhYmxlZCA9IHRydWU7CiAgICAgIGF3YWl0IGFwaSgnL2FwaS9hZG1pbi9jb21tYW5kJywgeyAuLi5zdGF0ZS5wcmVzZW50ZXJDcmVkcywgY29tbWFuZDogYnV0dG9uLmRhdGFzZXQuY29tbWFuZCB9KTsKICAgIH0gY2F0Y2ggKGVycm9yKSB7CiAgICAgIGJ1dHRvbi5kaXNhYmxlZCA9IGZhbHNlOwogICAgICBzaG93VG9hc3QoZXJyb3IubWVzc2FnZSk7CiAgICB9CiAgfSkpOwogIGNvbnN0IGJhY2sgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnYmFjay1kYXNoYm9hcmQnKTsKICBpZiAoYmFjaykgYmFjay5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIG9wZW5BZG1pbik7CiAgY29uc3QgcmVwbGFjZW1lbnRCdXR0b24gPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnb3Blbi1yZXBsYWNlbWVudCcpOwogIGlmIChyZXBsYWNlbWVudEJ1dHRvbiAmJiByb29tLnJlcGxhY2VtZW50KSByZXBsYWNlbWVudEJ1dHRvbi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHsKICAgIGNvbnN0IGNyZWRzID0geyByb29tQ29kZTogcm9vbS5yZXBsYWNlbWVudC5yb29tQ29kZSwgYWRtaW5Ub2tlbjogcm9vbS5yZXBsYWNlbWVudC5hZG1pblRva2VuIH07CiAgICBzZXNzaW9uU3RvcmFnZS5zZXRJdGVtKFBSRVNFTlRFUl9LRVkocm9vbS5yZXBsYWNlbWVudC5yb29tQ29kZSksIEpTT04uc3RyaW5naWZ5KGNyZWRzKSk7CiAgICBsb2NhdGlvbi5ocmVmID0gYC8/cHJlc2VudGVyPSR7ZW5jb2RlVVJJQ29tcG9uZW50KHJvb20ucmVwbGFjZW1lbnQucm9vbUNvZGUpfWA7CiAgfSk7Cn0KCmFzeW5jIGZ1bmN0aW9uIG9wZW5TY3JlZW4ocm9vbUNvZGUpIHsKICBzdGF0ZS5yb29tUm9sZSA9ICdzY3JlZW4nOwogIHRyeSB7CiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBhcGkoJy9hcGkvc2NyZWVuL2pvaW4nLCB7IHJvb21Db2RlIH0pOwogICAgc3RhdGUucm9vbSA9IHJlc3VsdC5zdGF0ZTsKICAgIG9wZW5Sb29tRXZlbnRzKCdzY3JlZW4nLCByb29tQ29kZSk7CiAgICByZW5kZXJTY3JlZW5TdGF0ZSgpOwogICAgc2hvd0F1ZGlvR2F0ZSgpOwogIH0gY2F0Y2ggKGVycm9yKSB7CiAgICBhcHAuaW5uZXJIVE1MID0gYDxkaXYgY2xhc3M9IndhaXQtc2NyZWVuIj48ZGl2IGNsYXNzPSJ3YWl0LWNhcmQiPjxoMT5TYWxhIG7Do28gZW5jb250cmFkYTwvaDE+PHA+JHtlc2NhcGVIdG1sKGVycm9yLm1lc3NhZ2UpfTwvcD48YSBjbGFzcz0iYnRuIGJ0bi1saWdodCIgaHJlZj0iLyI+Vm9sdGFyPC9hPjwvZGl2PjwvZGl2PmA7CiAgfQp9CgpmdW5jdGlvbiByZW5kZXJTY3JlZW5TdGF0ZSgpIHsKICAvLyBUZWxhIHNlbSBjb250cm9sZXMsIMO6dGlsIHF1YW5kbyBvIGluc3RydXRvciBkZXNlamEgcHJvamV0YXIgZW0gb3V0cm8gZXF1aXBhbWVudG8uCiAgY29uc3Qgcm9vbSA9IHN0YXRlLnJvb207CiAgc3luY011c2ljKHJvb20pOwogIGlmIChyb29tLnBoYXNlID09PSAnbG9iYnknKSB7CiAgICBhcHAuaW5uZXJIVE1MID0gYDxkaXYgY2xhc3M9InByZXNlbnRlci1zaGVsbCI+JHtwcmVzZW50ZXJIZWFkZXIocm9vbSl9PG1haW4gY2xhc3M9InByZXNlbnRlci1zdGFnZSBzY3JlZW4tbG9iYnkiPjxkaXYgY2xhc3M9InNjcmVlbi1jb2RlLWJsb2NrIj48c3Bhbj5FbnRyZSBuYSBzYWxhPC9zcGFuPjxkaXYgY2xhc3M9ImxvYmJ5LWNvZGUiPiR7cm9vbS5yb29tQ29kZX08L2Rpdj48ZGl2IGlkPSJzY3JlZW4tcXIiIGNsYXNzPSJxci13cmFwIGNvbXBhY3QtcXIiPjwvZGl2PjwvZGl2PjxkaXYgY2xhc3M9InNjcmVlbi1yZWFkeS1ibG9jayI+PHN0cm9uZz4ke3Jvb20ucmVhZHlDb3VudCB8fCAwfS8ke3Jvb20ucGFydGljaXBhbnRDb3VudH08L3N0cm9uZz48c3Bhbj5wYXJ0aWNpcGFudGVzIHByb250b3M8L3NwYW4+PGRpdiBjbGFzcz0icmVhZHktbWV0ZXIiPjxzcGFuIHN0eWxlPSJ3aWR0aDoke3Jvb20ucGFydGljaXBhbnRDb3VudCA/IE1hdGgucm91bmQoKHJvb20ucmVhZHlDb3VudCB8fCAwKSAvIHJvb20ucGFydGljaXBhbnRDb3VudCAqIDEwMCkgOiAwfSUiPjwvc3Bhbj48L2Rpdj48L2Rpdj48L21haW4+PC9kaXY+YDsKICAgIHJlbmRlclFyKCdzY3JlZW4tcXInLCByb29tLmpvaW5VcmwsIDI0MCk7CiAgfSBlbHNlIGlmIChyb29tLnBoYXNlID09PSAnY291bnRkb3duJykgewogICAgYXBwLmlubmVySFRNTCA9IGA8ZGl2IGNsYXNzPSJwcmVzZW50ZXItc2hlbGwiPiR7cHJlc2VudGVySGVhZGVyKHJvb20pfSR7b3BlbmluZ0NvdW50ZG93bk1hcmt1cChyb29tLCAncHJlc2VudGVyJyl9PC9kaXY+YDsKICAgIHN0YXJ0T3BlbmluZ0NvdW50ZG93bihyb29tKTsKICB9IGVsc2UgaWYgKHJvb20ucGhhc2UgPT09ICdxdWVzdGlvbicpIHsKICAgIGFwcC5pbm5lckhUTUwgPSBgPGRpdiBjbGFzcz0icHJlc2VudGVyLXNoZWxsIj4ke3ByZXNlbnRlckhlYWRlcihyb29tKX08bWFpbiBjbGFzcz0icHJlc2VudGVyLXN0YWdlIj48ZGl2IGNsYXNzPSJxdWVzdGlvbi10b3AiPjxzcGFuPlBlcmd1bnRhICR7cm9vbS5jdXJyZW50UXVlc3Rpb25JbmRleCArIDF9LyR7cm9vbS50b3RhbFF1ZXN0aW9uc308L3NwYW4+PGRpdiBpZD0idGltZXIiIGNsYXNzPSJ0aW1lciI+JHtyb29tLnF1ZXN0aW9uLnRpbWVMaW1pdH08L2Rpdj48c3Bhbj4ke3Jvb20ucmVzcG9uc2VDb3VudH0vJHtyb29tLnBhcnRpY2lwYW50Q291bnR9IHJlc3Bvc3Rhczwvc3Bhbj48L2Rpdj48aDEgY2xhc3M9InF1ZXN0aW9uLXRpdGxlIj4ke2VzY2FwZUh0bWwocm9vbS5xdWVzdGlvbi50ZXh0KX08L2gxPjxkaXYgY2xhc3M9ImFuc3dlcnMtZ3JpZCI+JHtyb29tLnF1ZXN0aW9uLm9wdGlvbnMubWFwKChvcHRpb24pID0+IGA8ZGl2IGNsYXNzPSJhbnN3ZXItY2FyZCI+PHNwYW4gY2xhc3M9InNoYXBlIj48L3NwYW4+JHtlc2NhcGVIdG1sKG9wdGlvbil9PC9kaXY+YCkuam9pbignJyl9PC9kaXY+PC9tYWluPjwvZGl2PmA7CiAgICBzdGFydENvdW50ZG93bihyb29tKTsKICB9IGVsc2UgaWYgKHJvb20ucGhhc2UgPT09ICdhbnN3ZXInKSB7CiAgICByZW5kZXJQcmVzZW50ZXJBbnN3ZXIocm9vbSk7CiAgICBjb25zdCBkb2NrID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmNvbnRyb2wtZG9jaycpOyBpZiAoZG9jaykgZG9jay5yZW1vdmUoKTsKICB9IGVsc2UgaWYgKHJvb20ucGhhc2UgPT09ICdyYW5raW5nJykgewogICAgYXBwLmlubmVySFRNTCA9IGA8ZGl2IGNsYXNzPSJwcmVzZW50ZXItc2hlbGwiPiR7cHJlc2VudGVySGVhZGVyKHJvb20pfTxtYWluIGNsYXNzPSJwcmVzZW50ZXItc3RhZ2UiPjxoMSBjbGFzcz0icXVlc3Rpb24tdGl0bGUiPlJhbmtpbmc8L2gxPiR7bGVhZGVyYm9hcmRNYXJrdXAocm9vbS5sZWFkZXJib2FyZCl9PC9tYWluPjwvZGl2PmA7CiAgICBzdGFydFJhbmtpbmdBbmltYXRpb24ocm9vbSk7CiAgfSBlbHNlIHsKICAgIGFwcC5pbm5lckhUTUwgPSBgPGRpdiBjbGFzcz0icHJlc2VudGVyLXNoZWxsIj4ke3ByZXNlbnRlckhlYWRlcihyb29tKX08bWFpbiBjbGFzcz0icHJlc2VudGVyLXN0YWdlIHRleHQtY2VudGVyIj48aDEgY2xhc3M9InF1ZXN0aW9uLXRpdGxlIj5Qw7NkaW8gZmluYWw8L2gxPiR7cG9kaXVtTWFya3VwKHJvb20pfTwvbWFpbj48L2Rpdj5gOwogIH0KICBjb25zdCBhdWRpb0J1dHRvbiA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdhdWRpby10b2dnbGUnKTsgaWYgKGF1ZGlvQnV0dG9uKSBhdWRpb0J1dHRvbi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIHRvZ2dsZUF1ZGlvKTsKfQoKZnVuY3Rpb24gbGVhZGVyYm9hcmRNYXJrdXAobGVhZGVyYm9hcmQpIHsKICByZXR1cm4gYDxkaXYgY2xhc3M9ImxlYWRlcmJvYXJkIj4ke2xlYWRlcmJvYXJkLm1hcCgoZW50cnksIGluZGV4KSA9PiBgPGRpdiBjbGFzcz0icmFuay1yb3cgJHtlbnRyeS5wb3NpdGlvbiA8PSAzID8gYHRvcC0ke2VudHJ5LnBvc2l0aW9ufWAgOiAnJ30iIGRhdGEtcmFuay1yb3cgc3R5bGU9ImFuaW1hdGlvbi1kZWxheToke01hdGgubWluKGluZGV4LDEyKSAqIC4xMn1zIj48ZGl2IGNsYXNzPSJyYW5rLXBvc2l0aW9uIj4ke2VudHJ5LnBvc2l0aW9ufcK6PC9kaXY+JHthdmF0YXJWaXN1YWwoZW50cnkuYXZhdGFyLHRydWUpfTxkaXY+PHN0cm9uZz4ke2VzY2FwZUh0bWwoZW50cnkubmlja25hbWUpfTwvc3Ryb25nPjxkaXYgY2xhc3M9Im11dGVkIj4ke2VudHJ5LmNvcnJlY3RBbnN3ZXJzfSBhY2VydG9zICR7ZW50cnkubGFzdFBvaW50cyA/IGDCtyArJHtlbnRyeS5sYXN0UG9pbnRzfWAgOiAnJ308L2Rpdj48L2Rpdj48ZGl2IGNsYXNzPSJyYW5rLXNjb3JlIj4ke2VudHJ5LnNjb3JlfTwvZGl2PjwvZGl2PmApLmpvaW4oJycpfTwvZGl2PmA7Cn0KCmZ1bmN0aW9uIHN0YXJ0UmFua2luZ0FuaW1hdGlvbihyb29tKSB7CiAgY29uc3Qga2V5ID0gYCR7cm9vbS5yb29tQ29kZX0tJHtyb29tLmN1cnJlbnRRdWVzdGlvbkluZGV4fS0ke3Jvb20ucGhhc2V9YDsKICBpZiAoc3RhdGUubGFzdFJhbmtpbmdLZXkgPT09IGtleSkgewogICAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtcmFuay1yb3ddJykuZm9yRWFjaCgocm93KSA9PiByb3cuY2xhc3NMaXN0LmFkZCgncmV2ZWFsZWQnKSk7CiAgICByZXR1cm47CiAgfQogIHN0YXRlLmxhc3RSYW5raW5nS2V5ID0ga2V5OwogIHBsYXlTdXNwZW5zZSgpOwogIGNvbnN0IG92ZXJsYXkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTsKICBvdmVybGF5LmNsYXNzTmFtZSA9ICdzdXNwZW5zZS1vdmVybGF5JzsKICBvdmVybGF5LmlubmVySFRNTCA9IGA8ZGl2PjxkaXYgaWQ9InN1c3BlbnNlLW51bWJlciIgY2xhc3M9InN1c3BlbnNlLW51bWJlciI+MzwvZGl2PjxkaXYgY2xhc3M9InN1c3BlbnNlLWxhYmVsIj5QcmVwYXJhbmRvIG8gcmFua2luZy4uLjwvZGl2PjwvZGl2PmA7CiAgZG9jdW1lbnQuYm9keS5hcHBlbmRDaGlsZChvdmVybGF5KTsKICBjb25zdCBudW1iZXIgPSBvdmVybGF5LnF1ZXJ5U2VsZWN0b3IoJyNzdXNwZW5zZS1udW1iZXInKTsKICBzZXRUaW1lb3V0KCgpID0+IG51bWJlci50ZXh0Q29udGVudCA9ICcyJywgOTAwKTsKICBzZXRUaW1lb3V0KCgpID0+IG51bWJlci50ZXh0Q29udGVudCA9ICcxJywgMTgwMCk7CiAgc2V0VGltZW91dCgoKSA9PiB7CiAgICBvdmVybGF5LnJlbW92ZSgpOwogICAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtcmFuay1yb3ddJykuZm9yRWFjaCgocm93KSA9PiByb3cuY2xhc3NMaXN0LmFkZCgncmV2ZWFsZWQnKSk7CiAgfSwgMjg1MCk7Cn0KCmZ1bmN0aW9uIHBvZGl1bU1hcmt1cChyb29tKSB7CiAgY29uc3QgdG9wID0gcm9vbS5sZWFkZXJib2FyZC5zbGljZSgwLCAzKTsKICBjb25zdCBnZXQgPSAocG9zaXRpb24pID0+IHRvcC5maW5kKChpdGVtKSA9PiBpdGVtLnBvc2l0aW9uID09PSBwb3NpdGlvbik7CiAgY29uc3QgcGxhY2VzID0gWwogICAgeyBwb3NpdGlvbjogMiwgY2xhc3NOYW1lOiAnc2Vjb25kJywgbWVkYWw6ICfwn6WIJywgcHJpemU6IHJvb20ucHJpemVzLnNlY29uZCB9LAogICAgeyBwb3NpdGlvbjogMSwgY2xhc3NOYW1lOiAnZmlyc3QnLCBtZWRhbDogJ/CfpYcnLCBwcml6ZTogcm9vbS5wcml6ZXMuZmlyc3QgfSwKICAgIHsgcG9zaXRpb246IDMsIGNsYXNzTmFtZTogJ3RoaXJkJywgbWVkYWw6ICfwn6WJJywgcHJpemU6IHJvb20ucHJpemVzLnRoaXJkIH0sCiAgXTsKICByZXR1cm4gYDxkaXYgY2xhc3M9InBvZGl1bSI+JHtwbGFjZXMubWFwKChwbGFjZSkgPT4gewogICAgY29uc3QgcGVyc29uID0gZ2V0KHBsYWNlLnBvc2l0aW9uKTsKICAgIHJldHVybiBgPGRpdiBjbGFzcz0icG9kaXVtLXBsYWNlICR7cGxhY2UuY2xhc3NOYW1lfSI+PGRpdj4ke3BlcnNvbiA/IGF2YXRhclZpc3VhbChwZXJzb24uYXZhdGFyLHRydWUpIDogJyd9PC9kaXY+PGRpdiBjbGFzcz0icG9kaXVtLW5hbWUiPiR7cGVyc29uID8gZXNjYXBlSHRtbChwZXJzb24ubmlja25hbWUpIDogJ+KAlCd9PC9kaXY+PGRpdiBjbGFzcz0icG9kaXVtLXByaXplIj4ke2VzY2FwZUh0bWwocGxhY2UucHJpemUgfHwgJycpfTwvZGl2PjxkaXYgY2xhc3M9InBvZGl1bS1zdGVwIj4ke3BsYWNlLm1lZGFsfTwvZGl2PjwvZGl2PmA7CiAgfSkuam9pbignJyl9PC9kaXY+YDsKfQoKd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoJ2JlZm9yZXVubG9hZCcsICgpID0+IHsKICBpZiAoc3RhdGUuZXZlbnRTb3VyY2UpIHN0YXRlLmV2ZW50U291cmNlLmNsb3NlKCk7CiAgc3RvcE11c2ljKCk7Cn0pOwoKaW5pdCgpOwo=', 'base64') }],
  ['/qrcode.min.js', { type: 'application/javascript; charset=utf-8', data: Buffer.from('dmFyIFFSQ29kZTshZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEpe3RoaXMubW9kZT1jLk1PREVfOEJJVF9CWVRFLHRoaXMuZGF0YT1hLHRoaXMucGFyc2VkRGF0YT1bXTtmb3IodmFyIGI9W10sZD0wLGU9dGhpcy5kYXRhLmxlbmd0aDtlPmQ7ZCsrKXt2YXIgZj10aGlzLmRhdGEuY2hhckNvZGVBdChkKTtmPjY1NTM2PyhiWzBdPTI0MHwoMTgzNTAwOCZmKT4+PjE4LGJbMV09MTI4fCgyNTgwNDgmZik+Pj4xMixiWzJdPTEyOHwoNDAzMiZmKT4+PjYsYlszXT0xMjh8NjMmZik6Zj4yMDQ4PyhiWzBdPTIyNHwoNjE0NDAmZik+Pj4xMixiWzFdPTEyOHwoNDAzMiZmKT4+PjYsYlsyXT0xMjh8NjMmZik6Zj4xMjg/KGJbMF09MTkyfCgxOTg0JmYpPj4+NixiWzFdPTEyOHw2MyZmKTpiWzBdPWYsdGhpcy5wYXJzZWREYXRhPXRoaXMucGFyc2VkRGF0YS5jb25jYXQoYil9dGhpcy5wYXJzZWREYXRhLmxlbmd0aCE9dGhpcy5kYXRhLmxlbmd0aCYmKHRoaXMucGFyc2VkRGF0YS51bnNoaWZ0KDE5MSksdGhpcy5wYXJzZWREYXRhLnVuc2hpZnQoMTg3KSx0aGlzLnBhcnNlZERhdGEudW5zaGlmdCgyMzkpKX1mdW5jdGlvbiBiKGEsYil7dGhpcy50eXBlTnVtYmVyPWEsdGhpcy5lcnJvckNvcnJlY3RMZXZlbD1iLHRoaXMubW9kdWxlcz1udWxsLHRoaXMubW9kdWxlQ291bnQ9MCx0aGlzLmRhdGFDYWNoZT1udWxsLHRoaXMuZGF0YUxpc3Q9W119ZnVuY3Rpb24gaShhLGIpe2lmKHZvaWQgMD09YS5sZW5ndGgpdGhyb3cgbmV3IEVycm9yKGEubGVuZ3RoKyIvIitiKTtmb3IodmFyIGM9MDtjPGEubGVuZ3RoJiYwPT1hW2NdOyljKys7dGhpcy5udW09bmV3IEFycmF5KGEubGVuZ3RoLWMrYik7Zm9yKHZhciBkPTA7ZDxhLmxlbmd0aC1jO2QrKyl0aGlzLm51bVtkXT1hW2QrY119ZnVuY3Rpb24gaihhLGIpe3RoaXMudG90YWxDb3VudD1hLHRoaXMuZGF0YUNvdW50PWJ9ZnVuY3Rpb24gaygpe3RoaXMuYnVmZmVyPVtdLHRoaXMubGVuZ3RoPTB9ZnVuY3Rpb24gbSgpe3JldHVybiJ1bmRlZmluZWQiIT10eXBlb2YgQ2FudmFzUmVuZGVyaW5nQ29udGV4dDJEfWZ1bmN0aW9uIG4oKXt2YXIgYT0hMSxiPW5hdmlnYXRvci51c2VyQWdlbnQ7cmV0dXJuL2FuZHJvaWQvaS50ZXN0KGIpJiYoYT0hMCxhTWF0PWIudG9TdHJpbmcoKS5tYXRjaCgvYW5kcm9pZCAoWzAtOV1cLlswLTldKS9pKSxhTWF0JiZhTWF0WzFdJiYoYT1wYXJzZUZsb2F0KGFNYXRbMV0pKSksYX1mdW5jdGlvbiByKGEsYil7Zm9yKHZhciBjPTEsZT1zKGEpLGY9MCxnPWwubGVuZ3RoO2c+PWY7ZisrKXt2YXIgaD0wO3N3aXRjaChiKXtjYXNlIGQuTDpoPWxbZl1bMF07YnJlYWs7Y2FzZSBkLk06aD1sW2ZdWzFdO2JyZWFrO2Nhc2UgZC5ROmg9bFtmXVsyXTticmVhaztjYXNlIGQuSDpoPWxbZl1bM119aWYoaD49ZSlicmVhaztjKyt9aWYoYz5sLmxlbmd0aCl0aHJvdyBuZXcgRXJyb3IoIlRvbyBsb25nIGRhdGEiKTtyZXR1cm4gY31mdW5jdGlvbiBzKGEpe3ZhciBiPWVuY29kZVVSSShhKS50b1N0cmluZygpLnJlcGxhY2UoL1wlWzAtOWEtZkEtRl17Mn0vZywiYSIpO3JldHVybiBiLmxlbmd0aCsoYi5sZW5ndGghPWE/MzowKX1hLnByb3RvdHlwZT17Z2V0TGVuZ3RoOmZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMucGFyc2VkRGF0YS5sZW5ndGh9LHdyaXRlOmZ1bmN0aW9uKGEpe2Zvcih2YXIgYj0wLGM9dGhpcy5wYXJzZWREYXRhLmxlbmd0aDtjPmI7YisrKWEucHV0KHRoaXMucGFyc2VkRGF0YVtiXSw4KX19LGIucHJvdG90eXBlPXthZGREYXRhOmZ1bmN0aW9uKGIpe3ZhciBjPW5ldyBhKGIpO3RoaXMuZGF0YUxpc3QucHVzaChjKSx0aGlzLmRhdGFDYWNoZT1udWxsfSxpc0Rhcms6ZnVuY3Rpb24oYSxiKXtpZigwPmF8fHRoaXMubW9kdWxlQ291bnQ8PWF8fDA+Ynx8dGhpcy5tb2R1bGVDb3VudDw9Yil0aHJvdyBuZXcgRXJyb3IoYSsiLCIrYik7cmV0dXJuIHRoaXMubW9kdWxlc1thXVtiXX0sZ2V0TW9kdWxlQ291bnQ6ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy5tb2R1bGVDb3VudH0sbWFrZTpmdW5jdGlvbigpe3RoaXMubWFrZUltcGwoITEsdGhpcy5nZXRCZXN0TWFza1BhdHRlcm4oKSl9LG1ha2VJbXBsOmZ1bmN0aW9uKGEsYyl7dGhpcy5tb2R1bGVDb3VudD00KnRoaXMudHlwZU51bWJlcisxNyx0aGlzLm1vZHVsZXM9bmV3IEFycmF5KHRoaXMubW9kdWxlQ291bnQpO2Zvcih2YXIgZD0wO2Q8dGhpcy5tb2R1bGVDb3VudDtkKyspe3RoaXMubW9kdWxlc1tkXT1uZXcgQXJyYXkodGhpcy5tb2R1bGVDb3VudCk7Zm9yKHZhciBlPTA7ZTx0aGlzLm1vZHVsZUNvdW50O2UrKyl0aGlzLm1vZHVsZXNbZF1bZV09bnVsbH10aGlzLnNldHVwUG9zaXRpb25Qcm9iZVBhdHRlcm4oMCwwKSx0aGlzLnNldHVwUG9zaXRpb25Qcm9iZVBhdHRlcm4odGhpcy5tb2R1bGVDb3VudC03LDApLHRoaXMuc2V0dXBQb3NpdGlvblByb2JlUGF0dGVybigwLHRoaXMubW9kdWxlQ291bnQtNyksdGhpcy5zZXR1cFBvc2l0aW9uQWRqdXN0UGF0dGVybigpLHRoaXMuc2V0dXBUaW1pbmdQYXR0ZXJuKCksdGhpcy5zZXR1cFR5cGVJbmZvKGEsYyksdGhpcy50eXBlTnVtYmVyPj03JiZ0aGlzLnNldHVwVHlwZU51bWJlcihhKSxudWxsPT10aGlzLmRhdGFDYWNoZSYmKHRoaXMuZGF0YUNhY2hlPWIuY3JlYXRlRGF0YSh0aGlzLnR5cGVOdW1iZXIsdGhpcy5lcnJvckNvcnJlY3RMZXZlbCx0aGlzLmRhdGFMaXN0KSksdGhpcy5tYXBEYXRhKHRoaXMuZGF0YUNhY2hlLGMpfSxzZXR1cFBvc2l0aW9uUHJvYmVQYXR0ZXJuOmZ1bmN0aW9uKGEsYil7Zm9yKHZhciBjPS0xOzc+PWM7YysrKWlmKCEoLTE+PWErY3x8dGhpcy5tb2R1bGVDb3VudDw9YStjKSlmb3IodmFyIGQ9LTE7Nz49ZDtkKyspLTE+PWIrZHx8dGhpcy5tb2R1bGVDb3VudDw9YitkfHwodGhpcy5tb2R1bGVzW2ErY11bYitkXT1jPj0wJiY2Pj1jJiYoMD09ZHx8Nj09ZCl8fGQ+PTAmJjY+PWQmJigwPT1jfHw2PT1jKXx8Yz49MiYmND49YyYmZD49MiYmND49ZD8hMDohMSl9LGdldEJlc3RNYXNrUGF0dGVybjpmdW5jdGlvbigpe2Zvcih2YXIgYT0wLGI9MCxjPTA7OD5jO2MrKyl7dGhpcy5tYWtlSW1wbCghMCxjKTt2YXIgZD1mLmdldExvc3RQb2ludCh0aGlzKTsoMD09Y3x8YT5kKSYmKGE9ZCxiPWMpfXJldHVybiBifSxjcmVhdGVNb3ZpZUNsaXA6ZnVuY3Rpb24oYSxiLGMpe3ZhciBkPWEuY3JlYXRlRW1wdHlNb3ZpZUNsaXAoYixjKSxlPTE7dGhpcy5tYWtlKCk7Zm9yKHZhciBmPTA7Zjx0aGlzLm1vZHVsZXMubGVuZ3RoO2YrKylmb3IodmFyIGc9ZiplLGg9MDtoPHRoaXMubW9kdWxlc1tmXS5sZW5ndGg7aCsrKXt2YXIgaT1oKmUsaj10aGlzLm1vZHVsZXNbZl1baF07aiYmKGQuYmVnaW5GaWxsKDAsMTAwKSxkLm1vdmVUbyhpLGcpLGQubGluZVRvKGkrZSxnKSxkLmxpbmVUbyhpK2UsZytlKSxkLmxpbmVUbyhpLGcrZSksZC5lbmRGaWxsKCkpfXJldHVybiBkfSxzZXR1cFRpbWluZ1BhdHRlcm46ZnVuY3Rpb24oKXtmb3IodmFyIGE9ODthPHRoaXMubW9kdWxlQ291bnQtODthKyspbnVsbD09dGhpcy5tb2R1bGVzW2FdWzZdJiYodGhpcy5tb2R1bGVzW2FdWzZdPTA9PWElMik7Zm9yKHZhciBiPTg7Yjx0aGlzLm1vZHVsZUNvdW50LTg7YisrKW51bGw9PXRoaXMubW9kdWxlc1s2XVtiXSYmKHRoaXMubW9kdWxlc1s2XVtiXT0wPT1iJTIpfSxzZXR1cFBvc2l0aW9uQWRqdXN0UGF0dGVybjpmdW5jdGlvbigpe2Zvcih2YXIgYT1mLmdldFBhdHRlcm5Qb3NpdGlvbih0aGlzLnR5cGVOdW1iZXIpLGI9MDtiPGEubGVuZ3RoO2IrKylmb3IodmFyIGM9MDtjPGEubGVuZ3RoO2MrKyl7dmFyIGQ9YVtiXSxlPWFbY107aWYobnVsbD09dGhpcy5tb2R1bGVzW2RdW2VdKWZvcih2YXIgZz0tMjsyPj1nO2crKylmb3IodmFyIGg9LTI7Mj49aDtoKyspdGhpcy5tb2R1bGVzW2QrZ11bZStoXT0tMj09Z3x8Mj09Z3x8LTI9PWh8fDI9PWh8fDA9PWcmJjA9PWg/ITA6ITF9fSxzZXR1cFR5cGVOdW1iZXI6ZnVuY3Rpb24oYSl7Zm9yKHZhciBiPWYuZ2V0QkNIVHlwZU51bWJlcih0aGlzLnR5cGVOdW1iZXIpLGM9MDsxOD5jO2MrKyl7dmFyIGQ9IWEmJjE9PSgxJmI+PmMpO3RoaXMubW9kdWxlc1tNYXRoLmZsb29yKGMvMyldW2MlMyt0aGlzLm1vZHVsZUNvdW50LTgtM109ZH1mb3IodmFyIGM9MDsxOD5jO2MrKyl7dmFyIGQ9IWEmJjE9PSgxJmI+PmMpO3RoaXMubW9kdWxlc1tjJTMrdGhpcy5tb2R1bGVDb3VudC04LTNdW01hdGguZmxvb3IoYy8zKV09ZH19LHNldHVwVHlwZUluZm86ZnVuY3Rpb24oYSxiKXtmb3IodmFyIGM9dGhpcy5lcnJvckNvcnJlY3RMZXZlbDw8M3xiLGQ9Zi5nZXRCQ0hUeXBlSW5mbyhjKSxlPTA7MTU+ZTtlKyspe3ZhciBnPSFhJiYxPT0oMSZkPj5lKTs2PmU/dGhpcy5tb2R1bGVzW2VdWzhdPWc6OD5lP3RoaXMubW9kdWxlc1tlKzFdWzhdPWc6dGhpcy5tb2R1bGVzW3RoaXMubW9kdWxlQ291bnQtMTUrZV1bOF09Z31mb3IodmFyIGU9MDsxNT5lO2UrKyl7dmFyIGc9IWEmJjE9PSgxJmQ+PmUpOzg+ZT90aGlzLm1vZHVsZXNbOF1bdGhpcy5tb2R1bGVDb3VudC1lLTFdPWc6OT5lP3RoaXMubW9kdWxlc1s4XVsxNS1lLTErMV09Zzp0aGlzLm1vZHVsZXNbOF1bMTUtZS0xXT1nfXRoaXMubW9kdWxlc1t0aGlzLm1vZHVsZUNvdW50LThdWzhdPSFhfSxtYXBEYXRhOmZ1bmN0aW9uKGEsYil7Zm9yKHZhciBjPS0xLGQ9dGhpcy5tb2R1bGVDb3VudC0xLGU9NyxnPTAsaD10aGlzLm1vZHVsZUNvdW50LTE7aD4wO2gtPTIpZm9yKDY9PWgmJmgtLTs7KXtmb3IodmFyIGk9MDsyPmk7aSsrKWlmKG51bGw9PXRoaXMubW9kdWxlc1tkXVtoLWldKXt2YXIgaj0hMTtnPGEubGVuZ3RoJiYoaj0xPT0oMSZhW2ddPj4+ZSkpO3ZhciBrPWYuZ2V0TWFzayhiLGQsaC1pKTtrJiYoaj0haiksdGhpcy5tb2R1bGVzW2RdW2gtaV09aixlLS0sLTE9PWUmJihnKyssZT03KX1pZihkKz1jLDA+ZHx8dGhpcy5tb2R1bGVDb3VudDw9ZCl7ZC09YyxjPS1jO2JyZWFrfX19fSxiLlBBRDA9MjM2LGIuUEFEMT0xNyxiLmNyZWF0ZURhdGE9ZnVuY3Rpb24oYSxjLGQpe2Zvcih2YXIgZT1qLmdldFJTQmxvY2tzKGEsYyksZz1uZXcgayxoPTA7aDxkLmxlbmd0aDtoKyspe3ZhciBpPWRbaF07Zy5wdXQoaS5tb2RlLDQpLGcucHV0KGkuZ2V0TGVuZ3RoKCksZi5nZXRMZW5ndGhJbkJpdHMoaS5tb2RlLGEpKSxpLndyaXRlKGcpfWZvcih2YXIgbD0wLGg9MDtoPGUubGVuZ3RoO2grKylsKz1lW2hdLmRhdGFDb3VudDtpZihnLmdldExlbmd0aEluQml0cygpPjgqbCl0aHJvdyBuZXcgRXJyb3IoImNvZGUgbGVuZ3RoIG92ZXJmbG93LiAoIitnLmdldExlbmd0aEluQml0cygpKyI+Iis4KmwrIikiKTtmb3IoZy5nZXRMZW5ndGhJbkJpdHMoKSs0PD04KmwmJmcucHV0KDAsNCk7MCE9Zy5nZXRMZW5ndGhJbkJpdHMoKSU4OylnLnB1dEJpdCghMSk7Zm9yKDs7KXtpZihnLmdldExlbmd0aEluQml0cygpPj04KmwpYnJlYWs7aWYoZy5wdXQoYi5QQUQwLDgpLGcuZ2V0TGVuZ3RoSW5CaXRzKCk+PTgqbClicmVhaztnLnB1dChiLlBBRDEsOCl9cmV0dXJuIGIuY3JlYXRlQnl0ZXMoZyxlKX0sYi5jcmVhdGVCeXRlcz1mdW5jdGlvbihhLGIpe2Zvcih2YXIgYz0wLGQ9MCxlPTAsZz1uZXcgQXJyYXkoYi5sZW5ndGgpLGg9bmV3IEFycmF5KGIubGVuZ3RoKSxqPTA7ajxiLmxlbmd0aDtqKyspe3ZhciBrPWJbal0uZGF0YUNvdW50LGw9YltqXS50b3RhbENvdW50LWs7ZD1NYXRoLm1heChkLGspLGU9TWF0aC5tYXgoZSxsKSxnW2pdPW5ldyBBcnJheShrKTtmb3IodmFyIG09MDttPGdbal0ubGVuZ3RoO20rKylnW2pdW21dPTI1NSZhLmJ1ZmZlclttK2NdO2MrPWs7dmFyIG49Zi5nZXRFcnJvckNvcnJlY3RQb2x5bm9taWFsKGwpLG89bmV3IGkoZ1tqXSxuLmdldExlbmd0aCgpLTEpLHA9by5tb2Qobik7aFtqXT1uZXcgQXJyYXkobi5nZXRMZW5ndGgoKS0xKTtmb3IodmFyIG09MDttPGhbal0ubGVuZ3RoO20rKyl7dmFyIHE9bStwLmdldExlbmd0aCgpLWhbal0ubGVuZ3RoO2hbal1bbV09cT49MD9wLmdldChxKTowfX1mb3IodmFyIHI9MCxtPTA7bTxiLmxlbmd0aDttKyspcis9YlttXS50b3RhbENvdW50O2Zvcih2YXIgcz1uZXcgQXJyYXkociksdD0wLG09MDtkPm07bSsrKWZvcih2YXIgaj0wO2o8Yi5sZW5ndGg7aisrKW08Z1tqXS5sZW5ndGgmJihzW3QrK109Z1tqXVttXSk7Zm9yKHZhciBtPTA7ZT5tO20rKylmb3IodmFyIGo9MDtqPGIubGVuZ3RoO2orKyltPGhbal0ubGVuZ3RoJiYoc1t0KytdPWhbal1bbV0pO3JldHVybiBzfTtmb3IodmFyIGM9e01PREVfTlVNQkVSOjEsTU9ERV9BTFBIQV9OVU06MixNT0RFXzhCSVRfQllURTo0LE1PREVfS0FOSkk6OH0sZD17TDoxLE06MCxROjMsSDoyfSxlPXtQQVRURVJOMDAwOjAsUEFUVEVSTjAwMToxLFBBVFRFUk4wMTA6MixQQVRURVJOMDExOjMsUEFUVEVSTjEwMDo0LFBBVFRFUk4xMDE6NSxQQVRURVJOMTEwOjYsUEFUVEVSTjExMTo3fSxmPXtQQVRURVJOX1BPU0lUSU9OX1RBQkxFOltbXSxbNiwxOF0sWzYsMjJdLFs2LDI2XSxbNiwzMF0sWzYsMzRdLFs2LDIyLDM4XSxbNiwyNCw0Ml0sWzYsMjYsNDZdLFs2LDI4LDUwXSxbNiwzMCw1NF0sWzYsMzIsNThdLFs2LDM0LDYyXSxbNiwyNiw0Niw2Nl0sWzYsMjYsNDgsNzBdLFs2LDI2LDUwLDc0XSxbNiwzMCw1NCw3OF0sWzYsMzAsNTYsODJdLFs2LDMwLDU4LDg2XSxbNiwzNCw2Miw5MF0sWzYsMjgsNTAsNzIsOTRdLFs2LDI2LDUwLDc0LDk4XSxbNiwzMCw1NCw3OCwxMDJdLFs2LDI4LDU0LDgwLDEwNl0sWzYsMzIsNTgsODQsMTEwXSxbNiwzMCw1OCw4NiwxMTRdLFs2LDM0LDYyLDkwLDExOF0sWzYsMjYsNTAsNzQsOTgsMTIyXSxbNiwzMCw1NCw3OCwxMDIsMTI2XSxbNiwyNiw1Miw3OCwxMDQsMTMwXSxbNiwzMCw1Niw4MiwxMDgsMTM0XSxbNiwzNCw2MCw4NiwxMTIsMTM4XSxbNiwzMCw1OCw4NiwxMTQsMTQyXSxbNiwzNCw2Miw5MCwxMTgsMTQ2XSxbNiwzMCw1NCw3OCwxMDIsMTI2LDE1MF0sWzYsMjQsNTAsNzYsMTAyLDEyOCwxNTRdLFs2LDI4LDU0LDgwLDEwNiwxMzIsMTU4XSxbNiwzMiw1OCw4NCwxMTAsMTM2LDE2Ml0sWzYsMjYsNTQsODIsMTEwLDEzOCwxNjZdLFs2LDMwLDU4LDg2LDExNCwxNDIsMTcwXV0sRzE1OjEzMzUsRzE4Ojc5NzMsRzE1X01BU0s6MjE1MjIsZ2V0QkNIVHlwZUluZm86ZnVuY3Rpb24oYSl7Zm9yKHZhciBiPWE8PDEwO2YuZ2V0QkNIRGlnaXQoYiktZi5nZXRCQ0hEaWdpdChmLkcxNSk+PTA7KWJePWYuRzE1PDxmLmdldEJDSERpZ2l0KGIpLWYuZ2V0QkNIRGlnaXQoZi5HMTUpO3JldHVybihhPDwxMHxiKV5mLkcxNV9NQVNLfSxnZXRCQ0hUeXBlTnVtYmVyOmZ1bmN0aW9uKGEpe2Zvcih2YXIgYj1hPDwxMjtmLmdldEJDSERpZ2l0KGIpLWYuZ2V0QkNIRGlnaXQoZi5HMTgpPj0wOyliXj1mLkcxODw8Zi5nZXRCQ0hEaWdpdChiKS1mLmdldEJDSERpZ2l0KGYuRzE4KTtyZXR1cm4gYTw8MTJ8Yn0sZ2V0QkNIRGlnaXQ6ZnVuY3Rpb24oYSl7Zm9yKHZhciBiPTA7MCE9YTspYisrLGE+Pj49MTtyZXR1cm4gYn0sZ2V0UGF0dGVyblBvc2l0aW9uOmZ1bmN0aW9uKGEpe3JldHVybiBmLlBBVFRFUk5fUE9TSVRJT05fVEFCTEVbYS0xXX0sZ2V0TWFzazpmdW5jdGlvbihhLGIsYyl7c3dpdGNoKGEpe2Nhc2UgZS5QQVRURVJOMDAwOnJldHVybiAwPT0oYitjKSUyO2Nhc2UgZS5QQVRURVJOMDAxOnJldHVybiAwPT1iJTI7Y2FzZSBlLlBBVFRFUk4wMTA6cmV0dXJuIDA9PWMlMztjYXNlIGUuUEFUVEVSTjAxMTpyZXR1cm4gMD09KGIrYyklMztjYXNlIGUuUEFUVEVSTjEwMDpyZXR1cm4gMD09KE1hdGguZmxvb3IoYi8yKStNYXRoLmZsb29yKGMvMykpJTI7Y2FzZSBlLlBBVFRFUk4xMDE6cmV0dXJuIDA9PWIqYyUyK2IqYyUzO2Nhc2UgZS5QQVRURVJOMTEwOnJldHVybiAwPT0oYipjJTIrYipjJTMpJTI7Y2FzZSBlLlBBVFRFUk4xMTE6cmV0dXJuIDA9PShiKmMlMysoYitjKSUyKSUyO2RlZmF1bHQ6dGhyb3cgbmV3IEVycm9yKCJiYWQgbWFza1BhdHRlcm46IithKX19LGdldEVycm9yQ29ycmVjdFBvbHlub21pYWw6ZnVuY3Rpb24oYSl7Zm9yKHZhciBiPW5ldyBpKFsxXSwwKSxjPTA7YT5jO2MrKyliPWIubXVsdGlwbHkobmV3IGkoWzEsZy5nZXhwKGMpXSwwKSk7cmV0dXJuIGJ9LGdldExlbmd0aEluQml0czpmdW5jdGlvbihhLGIpe2lmKGI+PTEmJjEwPmIpc3dpdGNoKGEpe2Nhc2UgYy5NT0RFX05VTUJFUjpyZXR1cm4gMTA7Y2FzZSBjLk1PREVfQUxQSEFfTlVNOnJldHVybiA5O2Nhc2UgYy5NT0RFXzhCSVRfQllURTpyZXR1cm4gODtjYXNlIGMuTU9ERV9LQU5KSTpyZXR1cm4gODtkZWZhdWx0OnRocm93IG5ldyBFcnJvcigibW9kZToiK2EpfWVsc2UgaWYoMjc+Yilzd2l0Y2goYSl7Y2FzZSBjLk1PREVfTlVNQkVSOnJldHVybiAxMjtjYXNlIGMuTU9ERV9BTFBIQV9OVU06cmV0dXJuIDExO2Nhc2UgYy5NT0RFXzhCSVRfQllURTpyZXR1cm4gMTY7Y2FzZSBjLk1PREVfS0FOSkk6cmV0dXJuIDEwO2RlZmF1bHQ6dGhyb3cgbmV3IEVycm9yKCJtb2RlOiIrYSl9ZWxzZXtpZighKDQxPmIpKXRocm93IG5ldyBFcnJvcigidHlwZToiK2IpO3N3aXRjaChhKXtjYXNlIGMuTU9ERV9OVU1CRVI6cmV0dXJuIDE0O2Nhc2UgYy5NT0RFX0FMUEhBX05VTTpyZXR1cm4gMTM7Y2FzZSBjLk1PREVfOEJJVF9CWVRFOnJldHVybiAxNjtjYXNlIGMuTU9ERV9LQU5KSTpyZXR1cm4gMTI7ZGVmYXVsdDp0aHJvdyBuZXcgRXJyb3IoIm1vZGU6IithKX19fSxnZXRMb3N0UG9pbnQ6ZnVuY3Rpb24oYSl7Zm9yKHZhciBiPWEuZ2V0TW9kdWxlQ291bnQoKSxjPTAsZD0wO2I+ZDtkKyspZm9yKHZhciBlPTA7Yj5lO2UrKyl7Zm9yKHZhciBmPTAsZz1hLmlzRGFyayhkLGUpLGg9LTE7MT49aDtoKyspaWYoISgwPmQraHx8ZCtoPj1iKSlmb3IodmFyIGk9LTE7MT49aTtpKyspMD5lK2l8fGUraT49Ynx8KDAhPWh8fDAhPWkpJiZnPT1hLmlzRGFyayhkK2gsZStpKSYmZisrO2Y+NSYmKGMrPTMrZi01KX1mb3IodmFyIGQ9MDtiLTE+ZDtkKyspZm9yKHZhciBlPTA7Yi0xPmU7ZSsrKXt2YXIgaj0wO2EuaXNEYXJrKGQsZSkmJmorKyxhLmlzRGFyayhkKzEsZSkmJmorKyxhLmlzRGFyayhkLGUrMSkmJmorKyxhLmlzRGFyayhkKzEsZSsxKSYmaisrLCgwPT1qfHw0PT1qKSYmKGMrPTMpfWZvcih2YXIgZD0wO2I+ZDtkKyspZm9yKHZhciBlPTA7Yi02PmU7ZSsrKWEuaXNEYXJrKGQsZSkmJiFhLmlzRGFyayhkLGUrMSkmJmEuaXNEYXJrKGQsZSsyKSYmYS5pc0RhcmsoZCxlKzMpJiZhLmlzRGFyayhkLGUrNCkmJiFhLmlzRGFyayhkLGUrNSkmJmEuaXNEYXJrKGQsZSs2KSYmKGMrPTQwKTtmb3IodmFyIGU9MDtiPmU7ZSsrKWZvcih2YXIgZD0wO2ItNj5kO2QrKylhLmlzRGFyayhkLGUpJiYhYS5pc0RhcmsoZCsxLGUpJiZhLmlzRGFyayhkKzIsZSkmJmEuaXNEYXJrKGQrMyxlKSYmYS5pc0RhcmsoZCs0LGUpJiYhYS5pc0RhcmsoZCs1LGUpJiZhLmlzRGFyayhkKzYsZSkmJihjKz00MCk7Zm9yKHZhciBrPTAsZT0wO2I+ZTtlKyspZm9yKHZhciBkPTA7Yj5kO2QrKylhLmlzRGFyayhkLGUpJiZrKys7dmFyIGw9TWF0aC5hYnMoMTAwKmsvYi9iLTUwKS81O3JldHVybiBjKz0xMCpsfX0sZz17Z2xvZzpmdW5jdGlvbihhKXtpZigxPmEpdGhyb3cgbmV3IEVycm9yKCJnbG9nKCIrYSsiKSIpO3JldHVybiBnLkxPR19UQUJMRVthXX0sZ2V4cDpmdW5jdGlvbihhKXtmb3IoOzA+YTspYSs9MjU1O2Zvcig7YT49MjU2OylhLT0yNTU7cmV0dXJuIGcuRVhQX1RBQkxFW2FdfSxFWFBfVEFCTEU6bmV3IEFycmF5KDI1NiksTE9HX1RBQkxFOm5ldyBBcnJheSgyNTYpfSxoPTA7OD5oO2grKylnLkVYUF9UQUJMRVtoXT0xPDxoO2Zvcih2YXIgaD04OzI1Nj5oO2grKylnLkVYUF9UQUJMRVtoXT1nLkVYUF9UQUJMRVtoLTRdXmcuRVhQX1RBQkxFW2gtNV1eZy5FWFBfVEFCTEVbaC02XV5nLkVYUF9UQUJMRVtoLThdO2Zvcih2YXIgaD0wOzI1NT5oO2grKylnLkxPR19UQUJMRVtnLkVYUF9UQUJMRVtoXV09aDtpLnByb3RvdHlwZT17Z2V0OmZ1bmN0aW9uKGEpe3JldHVybiB0aGlzLm51bVthXX0sZ2V0TGVuZ3RoOmZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMubnVtLmxlbmd0aH0sbXVsdGlwbHk6ZnVuY3Rpb24oYSl7Zm9yKHZhciBiPW5ldyBBcnJheSh0aGlzLmdldExlbmd0aCgpK2EuZ2V0TGVuZ3RoKCktMSksYz0wO2M8dGhpcy5nZXRMZW5ndGgoKTtjKyspZm9yKHZhciBkPTA7ZDxhLmdldExlbmd0aCgpO2QrKyliW2MrZF1ePWcuZ2V4cChnLmdsb2codGhpcy5nZXQoYykpK2cuZ2xvZyhhLmdldChkKSkpO3JldHVybiBuZXcgaShiLDApfSxtb2Q6ZnVuY3Rpb24oYSl7aWYodGhpcy5nZXRMZW5ndGgoKS1hLmdldExlbmd0aCgpPDApcmV0dXJuIHRoaXM7Zm9yKHZhciBiPWcuZ2xvZyh0aGlzLmdldCgwKSktZy5nbG9nKGEuZ2V0KDApKSxjPW5ldyBBcnJheSh0aGlzLmdldExlbmd0aCgpKSxkPTA7ZDx0aGlzLmdldExlbmd0aCgpO2QrKyljW2RdPXRoaXMuZ2V0KGQpO2Zvcih2YXIgZD0wO2Q8YS5nZXRMZW5ndGgoKTtkKyspY1tkXV49Zy5nZXhwKGcuZ2xvZyhhLmdldChkKSkrYik7cmV0dXJuIG5ldyBpKGMsMCkubW9kKGEpfX0sai5SU19CTE9DS19UQUJMRT1bWzEsMjYsMTldLFsxLDI2LDE2XSxbMSwyNiwxM10sWzEsMjYsOV0sWzEsNDQsMzRdLFsxLDQ0LDI4XSxbMSw0NCwyMl0sWzEsNDQsMTZdLFsxLDcwLDU1XSxbMSw3MCw0NF0sWzIsMzUsMTddLFsyLDM1LDEzXSxbMSwxMDAsODBdLFsyLDUwLDMyXSxbMiw1MCwyNF0sWzQsMjUsOV0sWzEsMTM0LDEwOF0sWzIsNjcsNDNdLFsyLDMzLDE1LDIsMzQsMTZdLFsyLDMzLDExLDIsMzQsMTJdLFsyLDg2LDY4XSxbNCw0MywyN10sWzQsNDMsMTldLFs0LDQzLDE1XSxbMiw5OCw3OF0sWzQsNDksMzFdLFsyLDMyLDE0LDQsMzMsMTVdLFs0LDM5LDEzLDEsNDAsMTRdLFsyLDEyMSw5N10sWzIsNjAsMzgsMiw2MSwzOV0sWzQsNDAsMTgsMiw0MSwxOV0sWzQsNDAsMTQsMiw0MSwxNV0sWzIsMTQ2LDExNl0sWzMsNTgsMzYsMiw1OSwzN10sWzQsMzYsMTYsNCwzNywxN10sWzQsMzYsMTIsNCwzNywxM10sWzIsODYsNjgsMiw4Nyw2OV0sWzQsNjksNDMsMSw3MCw0NF0sWzYsNDMsMTksMiw0NCwyMF0sWzYsNDMsMTUsMiw0NCwxNl0sWzQsMTAxLDgxXSxbMSw4MCw1MCw0LDgxLDUxXSxbNCw1MCwyMiw0LDUxLDIzXSxbMywzNiwxMiw4LDM3LDEzXSxbMiwxMTYsOTIsMiwxMTcsOTNdLFs2LDU4LDM2LDIsNTksMzddLFs0LDQ2LDIwLDYsNDcsMjFdLFs3LDQyLDE0LDQsNDMsMTVdLFs0LDEzMywxMDddLFs4LDU5LDM3LDEsNjAsMzhdLFs4LDQ0LDIwLDQsNDUsMjFdLFsxMiwzMywxMSw0LDM0LDEyXSxbMywxNDUsMTE1LDEsMTQ2LDExNl0sWzQsNjQsNDAsNSw2NSw0MV0sWzExLDM2LDE2LDUsMzcsMTddLFsxMSwzNiwxMiw1LDM3LDEzXSxbNSwxMDksODcsMSwxMTAsODhdLFs1LDY1LDQxLDUsNjYsNDJdLFs1LDU0LDI0LDcsNTUsMjVdLFsxMSwzNiwxMl0sWzUsMTIyLDk4LDEsMTIzLDk5XSxbNyw3Myw0NSwzLDc0LDQ2XSxbMTUsNDMsMTksMiw0NCwyMF0sWzMsNDUsMTUsMTMsNDYsMTZdLFsxLDEzNSwxMDcsNSwxMzYsMTA4XSxbMTAsNzQsNDYsMSw3NSw0N10sWzEsNTAsMjIsMTUsNTEsMjNdLFsyLDQyLDE0LDE3LDQzLDE1XSxbNSwxNTAsMTIwLDEsMTUxLDEyMV0sWzksNjksNDMsNCw3MCw0NF0sWzE3LDUwLDIyLDEsNTEsMjNdLFsyLDQyLDE0LDE5LDQzLDE1XSxbMywxNDEsMTEzLDQsMTQyLDExNF0sWzMsNzAsNDQsMTEsNzEsNDVdLFsxNyw0NywyMSw0LDQ4LDIyXSxbOSwzOSwxMywxNiw0MCwxNF0sWzMsMTM1LDEwNyw1LDEzNiwxMDhdLFszLDY3LDQxLDEzLDY4LDQyXSxbMTUsNTQsMjQsNSw1NSwyNV0sWzE1LDQzLDE1LDEwLDQ0LDE2XSxbNCwxNDQsMTE2LDQsMTQ1LDExN10sWzE3LDY4LDQyXSxbMTcsNTAsMjIsNiw1MSwyM10sWzE5LDQ2LDE2LDYsNDcsMTddLFsyLDEzOSwxMTEsNywxNDAsMTEyXSxbMTcsNzQsNDZdLFs3LDU0LDI0LDE2LDU1LDI1XSxbMzQsMzcsMTNdLFs0LDE1MSwxMjEsNSwxNTIsMTIyXSxbNCw3NSw0NywxNCw3Niw0OF0sWzExLDU0LDI0LDE0LDU1LDI1XSxbMTYsNDUsMTUsMTQsNDYsMTZdLFs2LDE0NywxMTcsNCwxNDgsMTE4XSxbNiw3Myw0NSwxNCw3NCw0Nl0sWzExLDU0LDI0LDE2LDU1LDI1XSxbMzAsNDYsMTYsMiw0NywxN10sWzgsMTMyLDEwNiw0LDEzMywxMDddLFs4LDc1LDQ3LDEzLDc2LDQ4XSxbNyw1NCwyNCwyMiw1NSwyNV0sWzIyLDQ1LDE1LDEzLDQ2LDE2XSxbMTAsMTQyLDExNCwyLDE0MywxMTVdLFsxOSw3NCw0Niw0LDc1LDQ3XSxbMjgsNTAsMjIsNiw1MSwyM10sWzMzLDQ2LDE2LDQsNDcsMTddLFs4LDE1MiwxMjIsNCwxNTMsMTIzXSxbMjIsNzMsNDUsMyw3NCw0Nl0sWzgsNTMsMjMsMjYsNTQsMjRdLFsxMiw0NSwxNSwyOCw0NiwxNl0sWzMsMTQ3LDExNywxMCwxNDgsMTE4XSxbMyw3Myw0NSwyMyw3NCw0Nl0sWzQsNTQsMjQsMzEsNTUsMjVdLFsxMSw0NSwxNSwzMSw0NiwxNl0sWzcsMTQ2LDExNiw3LDE0NywxMTddLFsyMSw3Myw0NSw3LDc0LDQ2XSxbMSw1MywyMywzNyw1NCwyNF0sWzE5LDQ1LDE1LDI2LDQ2LDE2XSxbNSwxNDUsMTE1LDEwLDE0NiwxMTZdLFsxOSw3NSw0NywxMCw3Niw0OF0sWzE1LDU0LDI0LDI1LDU1LDI1XSxbMjMsNDUsMTUsMjUsNDYsMTZdLFsxMywxNDUsMTE1LDMsMTQ2LDExNl0sWzIsNzQsNDYsMjksNzUsNDddLFs0Miw1NCwyNCwxLDU1LDI1XSxbMjMsNDUsMTUsMjgsNDYsMTZdLFsxNywxNDUsMTE1XSxbMTAsNzQsNDYsMjMsNzUsNDddLFsxMCw1NCwyNCwzNSw1NSwyNV0sWzE5LDQ1LDE1LDM1LDQ2LDE2XSxbMTcsMTQ1LDExNSwxLDE0NiwxMTZdLFsxNCw3NCw0NiwyMSw3NSw0N10sWzI5LDU0LDI0LDE5LDU1LDI1XSxbMTEsNDUsMTUsNDYsNDYsMTZdLFsxMywxNDUsMTE1LDYsMTQ2LDExNl0sWzE0LDc0LDQ2LDIzLDc1LDQ3XSxbNDQsNTQsMjQsNyw1NSwyNV0sWzU5LDQ2LDE2LDEsNDcsMTddLFsxMiwxNTEsMTIxLDcsMTUyLDEyMl0sWzEyLDc1LDQ3LDI2LDc2LDQ4XSxbMzksNTQsMjQsMTQsNTUsMjVdLFsyMiw0NSwxNSw0MSw0NiwxNl0sWzYsMTUxLDEyMSwxNCwxNTIsMTIyXSxbNiw3NSw0NywzNCw3Niw0OF0sWzQ2LDU0LDI0LDEwLDU1LDI1XSxbMiw0NSwxNSw2NCw0NiwxNl0sWzE3LDE1MiwxMjIsNCwxNTMsMTIzXSxbMjksNzQsNDYsMTQsNzUsNDddLFs0OSw1NCwyNCwxMCw1NSwyNV0sWzI0LDQ1LDE1LDQ2LDQ2LDE2XSxbNCwxNTIsMTIyLDE4LDE1MywxMjNdLFsxMyw3NCw0NiwzMiw3NSw0N10sWzQ4LDU0LDI0LDE0LDU1LDI1XSxbNDIsNDUsMTUsMzIsNDYsMTZdLFsyMCwxNDcsMTE3LDQsMTQ4LDExOF0sWzQwLDc1LDQ3LDcsNzYsNDhdLFs0Myw1NCwyNCwyMiw1NSwyNV0sWzEwLDQ1LDE1LDY3LDQ2LDE2XSxbMTksMTQ4LDExOCw2LDE0OSwxMTldLFsxOCw3NSw0NywzMSw3Niw0OF0sWzM0LDU0LDI0LDM0LDU1LDI1XSxbMjAsNDUsMTUsNjEsNDYsMTZdXSxqLmdldFJTQmxvY2tzPWZ1bmN0aW9uKGEsYil7dmFyIGM9ai5nZXRSc0Jsb2NrVGFibGUoYSxiKTtpZih2b2lkIDA9PWMpdGhyb3cgbmV3IEVycm9yKCJiYWQgcnMgYmxvY2sgQCB0eXBlTnVtYmVyOiIrYSsiL2Vycm9yQ29ycmVjdExldmVsOiIrYik7Zm9yKHZhciBkPWMubGVuZ3RoLzMsZT1bXSxmPTA7ZD5mO2YrKylmb3IodmFyIGc9Y1szKmYrMF0saD1jWzMqZisxXSxpPWNbMypmKzJdLGs9MDtnPms7aysrKWUucHVzaChuZXcgaihoLGkpKTtyZXR1cm4gZX0sai5nZXRSc0Jsb2NrVGFibGU9ZnVuY3Rpb24oYSxiKXtzd2l0Y2goYil7Y2FzZSBkLkw6cmV0dXJuIGouUlNfQkxPQ0tfVEFCTEVbNCooYS0xKSswXTtjYXNlIGQuTTpyZXR1cm4gai5SU19CTE9DS19UQUJMRVs0KihhLTEpKzFdO2Nhc2UgZC5ROnJldHVybiBqLlJTX0JMT0NLX1RBQkxFWzQqKGEtMSkrMl07Y2FzZSBkLkg6cmV0dXJuIGouUlNfQkxPQ0tfVEFCTEVbNCooYS0xKSszXTtkZWZhdWx0OnJldHVybiB2b2lkIDB9fSxrLnByb3RvdHlwZT17Z2V0OmZ1bmN0aW9uKGEpe3ZhciBiPU1hdGguZmxvb3IoYS84KTtyZXR1cm4gMT09KDEmdGhpcy5idWZmZXJbYl0+Pj43LWElOCl9LHB1dDpmdW5jdGlvbihhLGIpe2Zvcih2YXIgYz0wO2I+YztjKyspdGhpcy5wdXRCaXQoMT09KDEmYT4+PmItYy0xKSl9LGdldExlbmd0aEluQml0czpmdW5jdGlvbigpe3JldHVybiB0aGlzLmxlbmd0aH0scHV0Qml0OmZ1bmN0aW9uKGEpe3ZhciBiPU1hdGguZmxvb3IodGhpcy5sZW5ndGgvOCk7dGhpcy5idWZmZXIubGVuZ3RoPD1iJiZ0aGlzLmJ1ZmZlci5wdXNoKDApLGEmJih0aGlzLmJ1ZmZlcltiXXw9MTI4Pj4+dGhpcy5sZW5ndGglOCksdGhpcy5sZW5ndGgrK319O3ZhciBsPVtbMTcsMTQsMTEsN10sWzMyLDI2LDIwLDE0XSxbNTMsNDIsMzIsMjRdLFs3OCw2Miw0NiwzNF0sWzEwNiw4NCw2MCw0NF0sWzEzNCwxMDYsNzQsNThdLFsxNTQsMTIyLDg2LDY0XSxbMTkyLDE1MiwxMDgsODRdLFsyMzAsMTgwLDEzMCw5OF0sWzI3MSwyMTMsMTUxLDExOV0sWzMyMSwyNTEsMTc3LDEzN10sWzM2NywyODcsMjAzLDE1NV0sWzQyNSwzMzEsMjQxLDE3N10sWzQ1OCwzNjIsMjU4LDE5NF0sWzUyMCw0MTIsMjkyLDIyMF0sWzU4Niw0NTAsMzIyLDI1MF0sWzY0NCw1MDQsMzY0LDI4MF0sWzcxOCw1NjAsMzk0LDMxMF0sWzc5Miw2MjQsNDQyLDMzOF0sWzg1OCw2NjYsNDgyLDM4Ml0sWzkyOSw3MTEsNTA5LDQwM10sWzEwMDMsNzc5LDU2NSw0MzldLFsxMDkxLDg1Nyw2MTEsNDYxXSxbMTE3MSw5MTEsNjYxLDUxMV0sWzEyNzMsOTk3LDcxNSw1MzVdLFsxMzY3LDEwNTksNzUxLDU5M10sWzE0NjUsMTEyNSw4MDUsNjI1XSxbMTUyOCwxMTkwLDg2OCw2NThdLFsxNjI4LDEyNjQsOTA4LDY5OF0sWzE3MzIsMTM3MCw5ODIsNzQyXSxbMTg0MCwxNDUyLDEwMzAsNzkwXSxbMTk1MiwxNTM4LDExMTIsODQyXSxbMjA2OCwxNjI4LDExNjgsODk4XSxbMjE4OCwxNzIyLDEyMjgsOTU4XSxbMjMwMywxODA5LDEyODMsOTgzXSxbMjQzMSwxOTExLDEzNTEsMTA1MV0sWzI1NjMsMTk4OSwxNDIzLDEwOTNdLFsyNjk5LDIwOTksMTQ5OSwxMTM5XSxbMjgwOSwyMjEzLDE1NzksMTIxOV0sWzI5NTMsMjMzMSwxNjYzLDEyNzNdXSxvPWZ1bmN0aW9uKCl7dmFyIGE9ZnVuY3Rpb24oYSxiKXt0aGlzLl9lbD1hLHRoaXMuX2h0T3B0aW9uPWJ9O3JldHVybiBhLnByb3RvdHlwZS5kcmF3PWZ1bmN0aW9uKGEpe2Z1bmN0aW9uIGcoYSxiKXt2YXIgYz1kb2N1bWVudC5jcmVhdGVFbGVtZW50TlMoImh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIixhKTtmb3IodmFyIGQgaW4gYiliLmhhc093blByb3BlcnR5KGQpJiZjLnNldEF0dHJpYnV0ZShkLGJbZF0pO3JldHVybiBjfXZhciBiPXRoaXMuX2h0T3B0aW9uLGM9dGhpcy5fZWwsZD1hLmdldE1vZHVsZUNvdW50KCk7TWF0aC5mbG9vcihiLndpZHRoL2QpLE1hdGguZmxvb3IoYi5oZWlnaHQvZCksdGhpcy5jbGVhcigpO3ZhciBoPWcoInN2ZyIse3ZpZXdCb3g6IjAgMCAiK1N0cmluZyhkKSsiICIrU3RyaW5nKGQpLHdpZHRoOiIxMDAlIixoZWlnaHQ6IjEwMCUiLGZpbGw6Yi5jb2xvckxpZ2h0fSk7aC5zZXRBdHRyaWJ1dGVOUygiaHR0cDovL3d3dy53My5vcmcvMjAwMC94bWxucy8iLCJ4bWxuczp4bGluayIsImh0dHA6Ly93d3cudzMub3JnLzE5OTkveGxpbmsiKSxjLmFwcGVuZENoaWxkKGgpLGguYXBwZW5kQ2hpbGQoZygicmVjdCIse2ZpbGw6Yi5jb2xvckRhcmssd2lkdGg6IjEiLGhlaWdodDoiMSIsaWQ6InRlbXBsYXRlIn0pKTtmb3IodmFyIGk9MDtkPmk7aSsrKWZvcih2YXIgaj0wO2Q+ajtqKyspaWYoYS5pc0RhcmsoaSxqKSl7dmFyIGs9ZygidXNlIix7eDpTdHJpbmcoaSkseTpTdHJpbmcoail9KTtrLnNldEF0dHJpYnV0ZU5TKCJodHRwOi8vd3d3LnczLm9yZy8xOTk5L3hsaW5rIiwiaHJlZiIsIiN0ZW1wbGF0ZSIpLGguYXBwZW5kQ2hpbGQoayl9fSxhLnByb3RvdHlwZS5jbGVhcj1mdW5jdGlvbigpe2Zvcig7dGhpcy5fZWwuaGFzQ2hpbGROb2RlcygpOyl0aGlzLl9lbC5yZW1vdmVDaGlsZCh0aGlzLl9lbC5sYXN0Q2hpbGQpfSxhfSgpLHA9InN2ZyI9PT1kb2N1bWVudC5kb2N1bWVudEVsZW1lbnQudGFnTmFtZS50b0xvd2VyQ2FzZSgpLHE9cD9vOm0oKT9mdW5jdGlvbigpe2Z1bmN0aW9uIGEoKXt0aGlzLl9lbEltYWdlLnNyYz10aGlzLl9lbENhbnZhcy50b0RhdGFVUkwoImltYWdlL3BuZyIpLHRoaXMuX2VsSW1hZ2Uuc3R5bGUuZGlzcGxheT0iYmxvY2siLHRoaXMuX2VsQ2FudmFzLnN0eWxlLmRpc3BsYXk9Im5vbmUifWZ1bmN0aW9uIGQoYSxiKXt2YXIgYz10aGlzO2lmKGMuX2ZGYWlsPWIsYy5fZlN1Y2Nlc3M9YSxudWxsPT09Yy5fYlN1cHBvcnREYXRhVVJJKXt2YXIgZD1kb2N1bWVudC5jcmVhdGVFbGVtZW50KCJpbWciKSxlPWZ1bmN0aW9uKCl7Yy5fYlN1cHBvcnREYXRhVVJJPSExLGMuX2ZGYWlsJiZfZkZhaWwuY2FsbChjKX0sZj1mdW5jdGlvbigpe2MuX2JTdXBwb3J0RGF0YVVSST0hMCxjLl9mU3VjY2VzcyYmYy5fZlN1Y2Nlc3MuY2FsbChjKX07cmV0dXJuIGQub25hYm9ydD1lLGQub25lcnJvcj1lLGQub25sb2FkPWYsZC5zcmM9ImRhdGE6aW1hZ2UvZ2lmO2Jhc2U2NCxpVkJPUncwS0dnb0FBQUFOU1VoRVVnQUFBQVVBQUFBRkNBWUFBQUNOYnlibEFBQUFIRWxFUVZRSTEyUDQvLzgvdzM4R0lBWERJQktFMERIeGdsak5CQUFPOVRYTDBZNE9Id0FBQUFCSlJVNUVya0pnZ2c9PSIsdm9pZCAwfWMuX2JTdXBwb3J0RGF0YVVSST09PSEwJiZjLl9mU3VjY2Vzcz9jLl9mU3VjY2Vzcy5jYWxsKGMpOmMuX2JTdXBwb3J0RGF0YVVSST09PSExJiZjLl9mRmFpbCYmYy5fZkZhaWwuY2FsbChjKX1pZih0aGlzLl9hbmRyb2lkJiZ0aGlzLl9hbmRyb2lkPD0yLjEpe3ZhciBiPTEvd2luZG93LmRldmljZVBpeGVsUmF0aW8sYz1DYW52YXNSZW5kZXJpbmdDb250ZXh0MkQucHJvdG90eXBlLmRyYXdJbWFnZTtDYW52YXNSZW5kZXJpbmdDb250ZXh0MkQucHJvdG90eXBlLmRyYXdJbWFnZT1mdW5jdGlvbihhLGQsZSxmLGcsaCxpLGope2lmKCJub2RlTmFtZSJpbiBhJiYvaW1nL2kudGVzdChhLm5vZGVOYW1lKSlmb3IodmFyIGw9YXJndW1lbnRzLmxlbmd0aC0xO2w+PTE7bC0tKWFyZ3VtZW50c1tsXT1hcmd1bWVudHNbbF0qYjtlbHNlInVuZGVmaW5lZCI9PXR5cGVvZiBqJiYoYXJndW1lbnRzWzFdKj1iLGFyZ3VtZW50c1syXSo9Yixhcmd1bWVudHNbM10qPWIsYXJndW1lbnRzWzRdKj1iKTtjLmFwcGx5KHRoaXMsYXJndW1lbnRzKX19dmFyIGU9ZnVuY3Rpb24oYSxiKXt0aGlzLl9iSXNQYWludGVkPSExLHRoaXMuX2FuZHJvaWQ9bigpLHRoaXMuX2h0T3B0aW9uPWIsdGhpcy5fZWxDYW52YXM9ZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgiY2FudmFzIiksdGhpcy5fZWxDYW52YXMud2lkdGg9Yi53aWR0aCx0aGlzLl9lbENhbnZhcy5oZWlnaHQ9Yi5oZWlnaHQsYS5hcHBlbmRDaGlsZCh0aGlzLl9lbENhbnZhcyksdGhpcy5fZWw9YSx0aGlzLl9vQ29udGV4dD10aGlzLl9lbENhbnZhcy5nZXRDb250ZXh0KCIyZCIpLHRoaXMuX2JJc1BhaW50ZWQ9ITEsdGhpcy5fZWxJbWFnZT1kb2N1bWVudC5jcmVhdGVFbGVtZW50KCJpbWciKSx0aGlzLl9lbEltYWdlLnN0eWxlLmRpc3BsYXk9Im5vbmUiLHRoaXMuX2VsLmFwcGVuZENoaWxkKHRoaXMuX2VsSW1hZ2UpLHRoaXMuX2JTdXBwb3J0RGF0YVVSST1udWxsfTtyZXR1cm4gZS5wcm90b3R5cGUuZHJhdz1mdW5jdGlvbihhKXt2YXIgYj10aGlzLl9lbEltYWdlLGM9dGhpcy5fb0NvbnRleHQsZD10aGlzLl9odE9wdGlvbixlPWEuZ2V0TW9kdWxlQ291bnQoKSxmPWQud2lkdGgvZSxnPWQuaGVpZ2h0L2UsaD1NYXRoLnJvdW5kKGYpLGk9TWF0aC5yb3VuZChnKTtiLnN0eWxlLmRpc3BsYXk9Im5vbmUiLHRoaXMuY2xlYXIoKTtmb3IodmFyIGo9MDtlPmo7aisrKWZvcih2YXIgaz0wO2U+aztrKyspe3ZhciBsPWEuaXNEYXJrKGosayksbT1rKmYsbj1qKmc7Yy5zdHJva2VTdHlsZT1sP2QuY29sb3JEYXJrOmQuY29sb3JMaWdodCxjLmxpbmVXaWR0aD0xLGMuZmlsbFN0eWxlPWw/ZC5jb2xvckRhcms6ZC5jb2xvckxpZ2h0LGMuZmlsbFJlY3QobSxuLGYsZyksYy5zdHJva2VSZWN0KE1hdGguZmxvb3IobSkrLjUsTWF0aC5mbG9vcihuKSsuNSxoLGkpLGMuc3Ryb2tlUmVjdChNYXRoLmNlaWwobSktLjUsTWF0aC5jZWlsKG4pLS41LGgsaSl9dGhpcy5fYklzUGFpbnRlZD0hMH0sZS5wcm90b3R5cGUubWFrZUltYWdlPWZ1bmN0aW9uKCl7dGhpcy5fYklzUGFpbnRlZCYmZC5jYWxsKHRoaXMsYSl9LGUucHJvdG90eXBlLmlzUGFpbnRlZD1mdW5jdGlvbigpe3JldHVybiB0aGlzLl9iSXNQYWludGVkfSxlLnByb3RvdHlwZS5jbGVhcj1mdW5jdGlvbigpe3RoaXMuX29Db250ZXh0LmNsZWFyUmVjdCgwLDAsdGhpcy5fZWxDYW52YXMud2lkdGgsdGhpcy5fZWxDYW52YXMuaGVpZ2h0KSx0aGlzLl9iSXNQYWludGVkPSExfSxlLnByb3RvdHlwZS5yb3VuZD1mdW5jdGlvbihhKXtyZXR1cm4gYT9NYXRoLmZsb29yKDFlMyphKS8xZTM6YX0sZX0oKTpmdW5jdGlvbigpe3ZhciBhPWZ1bmN0aW9uKGEsYil7dGhpcy5fZWw9YSx0aGlzLl9odE9wdGlvbj1ifTtyZXR1cm4gYS5wcm90b3R5cGUuZHJhdz1mdW5jdGlvbihhKXtmb3IodmFyIGI9dGhpcy5faHRPcHRpb24sYz10aGlzLl9lbCxkPWEuZ2V0TW9kdWxlQ291bnQoKSxlPU1hdGguZmxvb3IoYi53aWR0aC9kKSxmPU1hdGguZmxvb3IoYi5oZWlnaHQvZCksZz1bJzx0YWJsZSBzdHlsZT0iYm9yZGVyOjA7Ym9yZGVyLWNvbGxhcHNlOmNvbGxhcHNlOyI+J10saD0wO2Q+aDtoKyspe2cucHVzaCgiPHRyPiIpO2Zvcih2YXIgaT0wO2Q+aTtpKyspZy5wdXNoKCc8dGQgc3R5bGU9ImJvcmRlcjowO2JvcmRlci1jb2xsYXBzZTpjb2xsYXBzZTtwYWRkaW5nOjA7bWFyZ2luOjA7d2lkdGg6JytlKyJweDtoZWlnaHQ6IitmKyJweDtiYWNrZ3JvdW5kLWNvbG9yOiIrKGEuaXNEYXJrKGgsaSk/Yi5jb2xvckRhcms6Yi5jb2xvckxpZ2h0KSsnOyI+PC90ZD4nKTtnLnB1c2goIjwvdHI+Iil9Zy5wdXNoKCI8L3RhYmxlPiIpLGMuaW5uZXJIVE1MPWcuam9pbigiIik7dmFyIGo9Yy5jaGlsZE5vZGVzWzBdLGs9KGIud2lkdGgtai5vZmZzZXRXaWR0aCkvMixsPShiLmhlaWdodC1qLm9mZnNldEhlaWdodCkvMjtrPjAmJmw+MCYmKGouc3R5bGUubWFyZ2luPWwrInB4ICIraysicHgiKX0sYS5wcm90b3R5cGUuY2xlYXI9ZnVuY3Rpb24oKXt0aGlzLl9lbC5pbm5lckhUTUw9IiJ9LGF9KCk7UVJDb2RlPWZ1bmN0aW9uKGEsYil7aWYodGhpcy5faHRPcHRpb249e3dpZHRoOjI1NixoZWlnaHQ6MjU2LHR5cGVOdW1iZXI6NCxjb2xvckRhcms6IiMwMDAwMDAiLGNvbG9yTGlnaHQ6IiNmZmZmZmYiLGNvcnJlY3RMZXZlbDpkLkh9LCJzdHJpbmciPT10eXBlb2YgYiYmKGI9e3RleHQ6Yn0pLGIpZm9yKHZhciBjIGluIGIpdGhpcy5faHRPcHRpb25bY109YltjXTsic3RyaW5nIj09dHlwZW9mIGEmJihhPWRvY3VtZW50LmdldEVsZW1lbnRCeUlkKGEpKSx0aGlzLl9hbmRyb2lkPW4oKSx0aGlzLl9lbD1hLHRoaXMuX29RUkNvZGU9bnVsbCx0aGlzLl9vRHJhd2luZz1uZXcgcSh0aGlzLl9lbCx0aGlzLl9odE9wdGlvbiksdGhpcy5faHRPcHRpb24udGV4dCYmdGhpcy5tYWtlQ29kZSh0aGlzLl9odE9wdGlvbi50ZXh0KX0sUVJDb2RlLnByb3RvdHlwZS5tYWtlQ29kZT1mdW5jdGlvbihhKXt0aGlzLl9vUVJDb2RlPW5ldyBiKHIoYSx0aGlzLl9odE9wdGlvbi5jb3JyZWN0TGV2ZWwpLHRoaXMuX2h0T3B0aW9uLmNvcnJlY3RMZXZlbCksdGhpcy5fb1FSQ29kZS5hZGREYXRhKGEpLHRoaXMuX29RUkNvZGUubWFrZSgpLHRoaXMuX2VsLnRpdGxlPWEsdGhpcy5fb0RyYXdpbmcuZHJhdyh0aGlzLl9vUVJDb2RlKSx0aGlzLm1ha2VJbWFnZSgpfSxRUkNvZGUucHJvdG90eXBlLm1ha2VJbWFnZT1mdW5jdGlvbigpeyJmdW5jdGlvbiI9PXR5cGVvZiB0aGlzLl9vRHJhd2luZy5tYWtlSW1hZ2UmJighdGhpcy5fYW5kcm9pZHx8dGhpcy5fYW5kcm9pZD49MykmJnRoaXMuX29EcmF3aW5nLm1ha2VJbWFnZSgpfSxRUkNvZGUucHJvdG90eXBlLmNsZWFyPWZ1bmN0aW9uKCl7dGhpcy5fb0RyYXdpbmcuY2xlYXIoKX0sUVJDb2RlLkNvcnJlY3RMZXZlbD1kfSgpOw==', 'base64') }]
]);

function serveStatic(req, res, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  let file = embeddedFiles.get(requested);
  if (!file && !path.extname(requested)) file = embeddedFiles.get('/index.html');
  if (!file) return json(res, 404, { ok: false, message: 'Arquivo não encontrado.' });
  res.writeHead(200, {
    'Content-Type': file.type,
    'Cache-Control': 'no-store, max-age=0',
    'Pragma': 'no-cache',
    'X-Quiz-Version': '6.2.0',
  });
  res.end(file.data);
}

const cleanupTimer = setInterval(() => {
  const cutoff = Date.now() - ROOM_TTL_MS;
  for (const [code, room] of rooms) {
    if (room.createdAt >= cutoff) continue;
    clearQuestionTimer(room);
    for (const client of room.clients) if (!client.res.writableEnded) client.res.end();
    rooms.delete(code);
  }
  for (const [token, session] of adminSessions) if (Date.now() - session.createdAt > SESSION_TTL_MS) adminSessions.delete(token);
}, 15 * 60 * 1000);
cleanupTimer.unref?.();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (!storeReady && !storeInitError && url.pathname !== '/health') return json(res, 503, { ok: false, message: 'O sistema ainda está iniciando. Tente novamente em alguns segundos.' });
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, {
      ok: !storeInitError,
      app: 'Quiz Credsystem',
      version: '6.2.0',
      persistenceMode: store.mode,
      storeReady,
      rooms: rooms.size,
      maxParticipantsPerRoom: MAX_PARTICIPANTS,
      startCountdownSeconds: START_COUNTDOWN_SECONDS,
      time: new Date().toISOString(),
    });
    if (req.method === 'GET' && url.pathname === '/events') return handleEvents(req, res, url);
    if (req.method === 'GET' && url.pathname === '/api/admin/report.xls') return await handleReport(req, res, url);
    if (req.method === 'POST' && url.pathname.startsWith('/api/')) return await handleApi(req, res, url.pathname);
    if (req.method === 'GET') return serveStatic(req, res, url.pathname);
    return json(res, 405, { ok: false, message: 'Método não permitido.' });
  } catch (error) {
    console.error(error);
    if (!res.headersSent) json(res, 500, { ok: false, message: 'Erro interno do servidor.' });
    else res.end();
  }
});

async function start() {
  try {
    await store.init();
    storeReady = true;
  } catch (error) {
    storeInitError = error;
    console.error('Falha ao iniciar armazenamento:', error);
  }
  server.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('Quiz Credsystem em tempo real iniciado.');
    console.log(`No computador: http://localhost:${PORT}`);
    const addresses = getLanIps();
    if (addresses.length) addresses.forEach((item, index) => console.log(`  ${index + 1}. http://${item.address}:${PORT} (${item.name})`));
    console.log(`Persistência: ${store.mode}`);
    console.log(`Limite por sala: ${MAX_PARTICIPANTS}`);
    console.log('');
  });
}

start();
