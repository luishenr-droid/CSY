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
    maxParticipants: MAX_PARTICIPANTS,
    responseCount: room.answers.size,
    prizes: room.prizes,
    joinUrl: room.joinUrl,
    screenUrl: room.screenUrl,
    presenterName: room.presenter.name,
    questionStartedAt: room.questionStartedAt,
    serverNow: Date.now(),
    joinClosed: room.joinClosed,
    resultId: room.resultId || null,
    players: room.phase === 'lobby'
      ? [...room.participants.values()].map((p) => ({
          playerId: p.id,
          fullName: p.fullName,
          nickname: p.nickname,
          avatar: getAvatar(p.avatarId),
          online: p.online,
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
      startQuestion(room, 0);
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
  ['/index.html', { type: 'text/html; charset=utf-8', data: Buffer.from('PCFET0NUWVBFIGh0bWw+CjxodG1sIGxhbmc9InB0LUJSIj4KPGhlYWQ+CiAgPG1ldGEgY2hhcnNldD0iVVRGLTgiIC8+CiAgPG1ldGEgbmFtZT0idmlld3BvcnQiIGNvbnRlbnQ9IndpZHRoPWRldmljZS13aWR0aCwgaW5pdGlhbC1zY2FsZT0xLCB2aWV3cG9ydC1maXQ9Y292ZXIiIC8+CiAgPG1ldGEgbmFtZT0idGhlbWUtY29sb3IiIGNvbnRlbnQ9IiMxNzE4MjAiIC8+CiAgPHRpdGxlPlF1aXogQ3JlZHN5c3RlbSDigJQgRWR1Y2HDp8OjbyBjb3Jwb3JhdGl2YSBhbyB2aXZvPC90aXRsZT4KICA8bGluayByZWw9InN0eWxlc2hlZXQiIGhyZWY9InN0eWxlcy5jc3MiIC8+CjwvaGVhZD4KPGJvZHk+CiAgPGRpdiBpZD0iYXBwIiBjbGFzcz0iYXBwLXNoZWxsIiBhcmlhLWxpdmU9InBvbGl0ZSI+PC9kaXY+CiAgPGRpdiBpZD0idG9hc3QiIGNsYXNzPSJ0b2FzdCIgcm9sZT0ic3RhdHVzIiBhcmlhLWxpdmU9InBvbGl0ZSI+PC9kaXY+CiAgPHNjcmlwdCBzcmM9InFyY29kZS5taW4uanMiPjwvc2NyaXB0PgogIDxzY3JpcHQgc3JjPSJhcHAuanMiPjwvc2NyaXB0Pgo8L2JvZHk+CjwvaHRtbD4K', 'base64') }],
  ['/styles.css', { type: 'text/css; charset=utf-8', data: Buffer.from('OnJvb3QgewogIC0taW5rOiAjMTcxODIwOwogIC0taW5rLTI6ICMyODJBMzU7CiAgLS1tdXRlZDogIzZCNkY3QzsKICAtLXBhbmVsOiAjRkZGRkZGOwogIC0tcGFnZTogI0Y0RjZGQTsKICAtLWxpbmU6ICNEREUxRUE7CiAgLS1jeWFuOiAjMDBDMkZGOwogIC0tYmx1ZTogIzM2NUNGRjsKICAtLXZpb2xldDogIzY1NDdGRjsKICAtLXBpbms6ICNGRjAwOEE7CiAgLS1ncmVlbjogIzE3QjI2QTsKICAtLXJlZDogI0U1NDg0RDsKICAtLXllbGxvdzogI0ZGQjAwMDsKICAtLWdyYWRpZW50OiBsaW5lYXItZ3JhZGllbnQoMTM1ZGVnLCB2YXIoLS1jeWFuKSAwJSwgdmFyKC0tYmx1ZSkgNDIlLCB2YXIoLS12aW9sZXQpIDY4JSwgdmFyKC0tcGluaykgMTAwJSk7CiAgLS1zaGFkb3c6IDAgMjRweCA3MHB4IHJnYmEoMjAsIDIyLCAzMiwgLjE0KTsKICAtLXJhZGl1czogMjRweDsKfQoKKiB7IGJveC1zaXppbmc6IGJvcmRlci1ib3g7IH0KaHRtbCB7IG1pbi1oZWlnaHQ6IDEwMCU7IGJhY2tncm91bmQ6IHZhcigtLXBhZ2UpOyB9CmJvZHkgewogIG1hcmdpbjogMDsKICBtaW4taGVpZ2h0OiAxMDB2aDsKICBmb250LWZhbWlseTogSW50ZXIsIHVpLXNhbnMtc2VyaWYsIHN5c3RlbS11aSwgLWFwcGxlLXN5c3RlbSwgQmxpbmtNYWNTeXN0ZW1Gb250LCAiU2Vnb2UgVUkiLCBzYW5zLXNlcmlmOwogIGNvbG9yOiB2YXIoLS1pbmspOwogIGJhY2tncm91bmQ6CiAgICByYWRpYWwtZ3JhZGllbnQoY2lyY2xlIGF0IDUlIDAlLCByZ2JhKDAsIDE5NCwgMjU1LCAuMTQpLCB0cmFuc3BhcmVudCAyOHJlbSksCiAgICByYWRpYWwtZ3JhZGllbnQoY2lyY2xlIGF0IDk1JSA1JSwgcmdiYSgyNTUsIDAsIDEzOCwgLjEwKSwgdHJhbnNwYXJlbnQgMzByZW0pLAogICAgdmFyKC0tcGFnZSk7Cn0KYnV0dG9uLCBpbnB1dCwgdGV4dGFyZWEsIHNlbGVjdCB7IGZvbnQ6IGluaGVyaXQ7IH0KYnV0dG9uIHsgY3Vyc29yOiBwb2ludGVyOyB9CmEgeyBjb2xvcjogaW5oZXJpdDsgfQoKLmFwcC1zaGVsbCB7IG1pbi1oZWlnaHQ6IDEwMHZoOyB9Ci5jb250YWluZXIgeyB3aWR0aDogbWluKDExODBweCwgY2FsYygxMDAlIC0gMzJweCkpOyBtYXJnaW46IDAgYXV0bzsgcGFkZGluZzogMzBweCAwIDY0cHg7IH0KLmNvbnRhaW5lci5uYXJyb3cgeyB3aWR0aDogbWluKDc2MHB4LCBjYWxjKDEwMCUgLSAyOHB4KSk7IH0KCi50b3BiYXIgewogIG1pbi1oZWlnaHQ6IDc2cHg7CiAgZGlzcGxheTogZmxleDsKICBhbGlnbi1pdGVtczogY2VudGVyOwogIGp1c3RpZnktY29udGVudDogc3BhY2UtYmV0d2VlbjsKICBnYXA6IDE4cHg7CiAgcGFkZGluZzogMTRweCBjbGFtcCgxOHB4LCA0dncsIDU2cHgpOwogIGJhY2tncm91bmQ6IHJnYmEoMjU1LDI1NSwyNTUsLjg4KTsKICBib3JkZXItYm90dG9tOiAxcHggc29saWQgcmdiYSgyMjAsMjI0LDIzMywuOSk7CiAgYmFja2Ryb3AtZmlsdGVyOiBibHVyKDE4cHgpOwogIHBvc2l0aW9uOiBzdGlja3k7CiAgdG9wOiAwOwogIHotaW5kZXg6IDMwOwp9Ci5icmFuZCB7IGRpc3BsYXk6IGlubGluZS1mbGV4OyBhbGlnbi1pdGVtczogY2VudGVyOyBnYXA6IDEycHg7IHRleHQtZGVjb3JhdGlvbjogbm9uZTsgZm9udC13ZWlnaHQ6IDg1MDsgfQouYnJhbmQtc3ltYm9sIHsKICB3aWR0aDogNDZweDsgaGVpZ2h0OiA0NnB4OyBib3JkZXItcmFkaXVzOiA1MCU7IHBvc2l0aW9uOiByZWxhdGl2ZTsgZmxleDogMCAwIGF1dG87CiAgYmFja2dyb3VuZDogY29uaWMtZ3JhZGllbnQoZnJvbSAwZGVnLCB2YXIoLS1jeWFuKSwgdmFyKC0tYmx1ZSksIHZhcigtLXZpb2xldCksIHZhcigtLXBpbmspLCB2YXIoLS1jeWFuKSk7CiAgYm94LXNoYWRvdzogMCAxMHB4IDI0cHggcmdiYSg3MywgNjQsIDI1NSwgLjI4KTsKfQouYnJhbmQtc3ltYm9sOjpiZWZvcmUgeyBjb250ZW50OiAiIjsgcG9zaXRpb246IGFic29sdXRlOyBpbnNldDogOHB4OyBib3JkZXItcmFkaXVzOiA1MCU7IGJhY2tncm91bmQ6IHdoaXRlOyB9Ci5icmFuZC1zeW1ib2w6OmFmdGVyIHsgY29udGVudDogIiI7IHBvc2l0aW9uOiBhYnNvbHV0ZTsgbGVmdDogMDsgdG9wOiAwOyBib3R0b206IDA7IHdpZHRoOiA1MCU7IGJhY2tncm91bmQ6IHZhcigtLWluayk7IGJvcmRlci1yYWRpdXM6IDk5OXB4IDAgMCA5OTlweDsgfQouYnJhbmQtY29weSB7IGRpc3BsYXk6IGdyaWQ7IGdhcDogMXB4OyB9Ci5icmFuZC1jb3B5IHN0cm9uZyB7IGZvbnQtc2l6ZTogMjBweDsgbGV0dGVyLXNwYWNpbmc6IC0uMDNlbTsgfQouYnJhbmQtY29weSBzbWFsbCB7IGNvbG9yOiB2YXIoLS1tdXRlZCk7IGZvbnQtd2VpZ2h0OiA2NTA7IH0KLnRvcC1hY3Rpb25zIHsgZGlzcGxheTogZmxleDsgZ2FwOiAxMHB4OyBhbGlnbi1pdGVtczogY2VudGVyOyBmbGV4LXdyYXA6IHdyYXA7IGp1c3RpZnktY29udGVudDogZmxleC1lbmQ7IH0KCi5oZXJvIHsgZGlzcGxheTogZ3JpZDsgZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOiAxLjA1ZnIgLjk1ZnI7IGdhcDogY2xhbXAoMjhweCwgNnZ3LCA4MHB4KTsgYWxpZ24taXRlbXM6IGNlbnRlcjsgcGFkZGluZzogY2xhbXAoNDBweCwgOHZ3LCA5NnB4KSAwIDcycHg7IH0KLmhlcm8gaDEgeyBtYXJnaW46IDAgMCAxOHB4OyBmb250LXNpemU6IGNsYW1wKDQycHgsIDd2dywgNzhweCk7IGxpbmUtaGVpZ2h0OiAuOTg7IGxldHRlci1zcGFjaW5nOiAtLjA2ZW07IH0KLmhlcm8gaDEgLmdyYWRpZW50LXRleHQgeyBiYWNrZ3JvdW5kOiB2YXIoLS1ncmFkaWVudCk7IC13ZWJraXQtYmFja2dyb3VuZC1jbGlwOiB0ZXh0OyBiYWNrZ3JvdW5kLWNsaXA6IHRleHQ7IGNvbG9yOiB0cmFuc3BhcmVudDsgfQouaGVybyBwIHsgbWFyZ2luOiAwOyBjb2xvcjogdmFyKC0tbXV0ZWQpOyBmb250LXNpemU6IGNsYW1wKDE4cHgsIDJ2dywgMjNweCk7IGxpbmUtaGVpZ2h0OiAxLjU1OyB9Ci5oZXJvLWJhZGdlLCAuZXllYnJvdyB7IGRpc3BsYXk6IGlubGluZS1mbGV4OyBhbGlnbi1pdGVtczogY2VudGVyOyBnYXA6IDhweDsgY29sb3I6ICMzQjM1QjQ7IGJhY2tncm91bmQ6ICNFQ0VCRkY7IGJvcmRlci1yYWRpdXM6IDk5OXB4OyBwYWRkaW5nOiA4cHggMTJweDsgZm9udC1zaXplOiAxM3B4OyBmb250LXdlaWdodDogODUwOyB0ZXh0LXRyYW5zZm9ybTogdXBwZXJjYXNlOyBsZXR0ZXItc3BhY2luZzogLjA5ZW07IG1hcmdpbi1ib3R0b206IDE4cHg7IH0KLmhlcm8tY2FyZCB7IGJhY2tncm91bmQ6IHZhcigtLWluayk7IGNvbG9yOiB3aGl0ZTsgYm9yZGVyLXJhZGl1czogMzRweDsgcGFkZGluZzogMjhweDsgYm94LXNoYWRvdzogdmFyKC0tc2hhZG93KTsgcG9zaXRpb246IHJlbGF0aXZlOyBvdmVyZmxvdzogaGlkZGVuOyB9Ci5oZXJvLWNhcmQ6OmJlZm9yZSB7IGNvbnRlbnQ6ICIiOyBwb3NpdGlvbjogYWJzb2x1dGU7IGluc2V0OiAtMzAlIDM1JSA0NSUgLTIwJTsgYmFja2dyb3VuZDogdmFyKC0tZ3JhZGllbnQpOyBmaWx0ZXI6IGJsdXIoNjBweCk7IG9wYWNpdHk6IC43NTsgfQouaGVyby1jYXJkID4gKiB7IHBvc2l0aW9uOiByZWxhdGl2ZTsgfQoubW9jay1xdWVzdGlvbiB7IGZvbnQtc2l6ZTogMjZweDsgZm9udC13ZWlnaHQ6IDg1MDsgbGluZS1oZWlnaHQ6IDEuMjU7IG1hcmdpbjogMThweCAwIDI0cHg7IH0KLm1vY2stZ3JpZCB7IGRpc3BsYXk6IGdyaWQ7IGdyaWQtdGVtcGxhdGUtY29sdW1uczogMWZyIDFmcjsgZ2FwOiAxMnB4OyB9Ci5tb2NrLW9wdGlvbiB7IG1pbi1oZWlnaHQ6IDc4cHg7IGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IHBhZGRpbmc6IDE0cHg7IGJvcmRlci1yYWRpdXM6IDE4cHg7IGJhY2tncm91bmQ6IHJnYmEoMjU1LDI1NSwyNTUsLjEyKTsgZm9udC13ZWlnaHQ6IDc1MDsgfQoKLmdyaWQtMiB7IGRpc3BsYXk6IGdyaWQ7IGdyaWQtdGVtcGxhdGUtY29sdW1uczogMWZyIDFmcjsgZ2FwOiAyMnB4OyB9Ci5ncmlkLTMgeyBkaXNwbGF5OiBncmlkOyBncmlkLXRlbXBsYXRlLWNvbHVtbnM6IHJlcGVhdCgzLCAxZnIpOyBnYXA6IDE2cHg7IH0KLmdyaWQtNCB7IGRpc3BsYXk6IGdyaWQ7IGdyaWQtdGVtcGxhdGUtY29sdW1uczogcmVwZWF0KDQsIDFmcik7IGdhcDogMTRweDsgfQouY2FyZCB7IGJhY2tncm91bmQ6IHZhcigtLXBhbmVsKTsgYm9yZGVyOiAxcHggc29saWQgdmFyKC0tbGluZSk7IGJvcmRlci1yYWRpdXM6IHZhcigtLXJhZGl1cyk7IHBhZGRpbmc6IGNsYW1wKDIwcHgsIDN2dywgMzBweCk7IGJveC1zaGFkb3c6IDAgMTJweCAzNHB4IHJnYmEoMjIsMjQsMzIsLjA2KTsgfQouY2FyZCBoMSwgLmNhcmQgaDIsIC5jYXJkIGgzIHsgbWFyZ2luLXRvcDogMDsgfQouY2FyZC5pbnRlcmFjdGl2ZSB7IHRyYW5zaXRpb246IHRyYW5zZm9ybSAuMThzIGVhc2UsIGJveC1zaGFkb3cgLjE4cyBlYXNlOyB9Ci5jYXJkLmludGVyYWN0aXZlOmhvdmVyIHsgdHJhbnNmb3JtOiB0cmFuc2xhdGVZKC0zcHgpOyBib3gtc2hhZG93OiB2YXIoLS1zaGFkb3cpOyB9Ci5jYXJkLmRhcmsgeyBiYWNrZ3JvdW5kOiB2YXIoLS1pbmspOyBjb2xvcjogd2hpdGU7IGJvcmRlci1jb2xvcjogdmFyKC0taW5rKTsgfQouY2FyZC5ncmFkaWVudCB7IGJhY2tncm91bmQ6IHZhcigtLWdyYWRpZW50KTsgY29sb3I6IHdoaXRlOyBib3JkZXI6IDA7IH0KLnNvZnQgeyBiYWNrZ3JvdW5kOiAjRjhGOUZDOyBib3gtc2hhZG93OiBub25lOyB9CgouYnRuIHsgYm9yZGVyOiAwOyBib3JkZXItcmFkaXVzOiAxNHB4OyBtaW4taGVpZ2h0OiA0OHB4OyBwYWRkaW5nOiAxMnB4IDE4cHg7IGZvbnQtd2VpZ2h0OiA4MjA7IGRpc3BsYXk6IGlubGluZS1mbGV4OyBhbGlnbi1pdGVtczogY2VudGVyOyBqdXN0aWZ5LWNvbnRlbnQ6IGNlbnRlcjsgZ2FwOiA5cHg7IHRyYW5zaXRpb246IHRyYW5zZm9ybSAuMTVzIGVhc2UsIGZpbHRlciAuMTVzIGVhc2UsIG9wYWNpdHkgLjE1cyBlYXNlOyB0ZXh0LWRlY29yYXRpb246IG5vbmU7IH0KLmJ0bjpob3Zlcjpub3QoOmRpc2FibGVkKSB7IHRyYW5zZm9ybTogdHJhbnNsYXRlWSgtMXB4KTsgZmlsdGVyOiBicmlnaHRuZXNzKDEuMDMpOyB9Ci5idG46ZGlzYWJsZWQgeyBvcGFjaXR5OiAuNDU7IGN1cnNvcjogbm90LWFsbG93ZWQ7IH0KLmJ0bi1wcmltYXJ5IHsgY29sb3I6IHdoaXRlOyBiYWNrZ3JvdW5kOiB2YXIoLS1ncmFkaWVudCk7IGJveC1zaGFkb3c6IDAgMTJweCAyNnB4IHJnYmEoNjgsIDc0LCAyNTUsIC4yMik7IH0KLmJ0bi1kYXJrIHsgYmFja2dyb3VuZDogdmFyKC0taW5rKTsgY29sb3I6IHdoaXRlOyB9Ci5idG4tbGlnaHQgeyBiYWNrZ3JvdW5kOiB3aGl0ZTsgY29sb3I6IHZhcigtLWluayk7IGJvcmRlcjogMXB4IHNvbGlkIHZhcigtLWxpbmUpOyB9Ci5idG4tc3VjY2VzcyB7IGJhY2tncm91bmQ6ICNFMkY4RUI7IGNvbG9yOiAjMDg3NDNEOyB9Ci5idG4tZGFuZ2VyIHsgYmFja2dyb3VuZDogI0ZERUJFQzsgY29sb3I6ICNCNDIzMkE7IH0KLmJ0bi13YXJuaW5nIHsgYmFja2dyb3VuZDogI0ZGRjNENTsgY29sb3I6ICM3QTUyMDA7IH0KLmJ0bi1sYXJnZSB7IG1pbi1oZWlnaHQ6IDU4cHg7IHBhZGRpbmc6IDE1cHggMjRweDsgZm9udC1zaXplOiAxOHB4OyB9Ci5idG4tYmxvY2sgeyB3aWR0aDogMTAwJTsgfQouYnRuLWljb24geyB3aWR0aDogNDZweDsgaGVpZ2h0OiA0NnB4OyBwYWRkaW5nOiAwOyB9CgouZmllbGQgeyBkaXNwbGF5OiBncmlkOyBnYXA6IDhweDsgbWFyZ2luLWJvdHRvbTogMTZweDsgfQouZmllbGQgbGFiZWwgeyBmb250LXdlaWdodDogODAwOyB9Ci5maWVsZCBzbWFsbCB7IGNvbG9yOiB2YXIoLS1tdXRlZCk7IH0KLmlucHV0LCAudGV4dGFyZWEsIC5zZWxlY3QgeyB3aWR0aDogMTAwJTsgYm9yZGVyOiAxcHggc29saWQgdmFyKC0tbGluZSk7IGJvcmRlci1yYWRpdXM6IDE0cHg7IGJhY2tncm91bmQ6IHdoaXRlOyBjb2xvcjogdmFyKC0taW5rKTsgcGFkZGluZzogMTNweCAxNHB4OyBvdXRsaW5lOiBub25lOyB9Ci5pbnB1dDpmb2N1cywgLnRleHRhcmVhOmZvY3VzLCAuc2VsZWN0OmZvY3VzIHsgYm9yZGVyLWNvbG9yOiB2YXIoLS1ibHVlKTsgYm94LXNoYWRvdzogMCAwIDAgNHB4IHJnYmEoNTQsOTIsMjU1LC4xMik7IH0KLnRleHRhcmVhIHsgbWluLWhlaWdodDogOTZweDsgcmVzaXplOiB2ZXJ0aWNhbDsgfQouY29kZS1pbnB1dCB7IHRleHQtYWxpZ246IGNlbnRlcjsgbGV0dGVyLXNwYWNpbmc6IC4xNmVtOyBmb250LXNpemU6IDI4cHg7IGZvbnQtd2VpZ2h0OiA5MDA7IH0KCi50YWJzIHsgZGlzcGxheTogZmxleDsgZ2FwOiA4cHg7IGZsZXgtd3JhcDogd3JhcDsgbWFyZ2luLWJvdHRvbTogMjJweDsgfQoudGFiIHsgYm9yZGVyOiAxcHggc29saWQgdmFyKC0tbGluZSk7IGJhY2tncm91bmQ6IHdoaXRlOyBib3JkZXItcmFkaXVzOiA5OTlweDsgcGFkZGluZzogMTBweCAxNnB4OyBjb2xvcjogdmFyKC0tbXV0ZWQpOyBmb250LXdlaWdodDogODAwOyB9Ci50YWIuYWN0aXZlIHsgY29sb3I6IHdoaXRlOyBiYWNrZ3JvdW5kOiB2YXIoLS1pbmspOyBib3JkZXItY29sb3I6IHZhcigtLWluayk7IH0KCi5ub3RpY2UgeyBwYWRkaW5nOiAxNHB4IDE2cHg7IGJvcmRlci1yYWRpdXM6IDE0cHg7IGJhY2tncm91bmQ6ICNGRkY0RDk7IGNvbG9yOiAjNzI1MTAwOyBib3JkZXI6IDFweCBzb2xpZCAjRjBEMTg1OyBtYXJnaW4tYm90dG9tOiAxOHB4OyB9Ci5ub3RpY2UuaW5mbyB7IGJhY2tncm91bmQ6ICNFQUY3RkY7IGNvbG9yOiAjMDc1QzdBOyBib3JkZXItY29sb3I6ICNCOUU3RkE7IH0KLm5vdGljZS5zdWNjZXNzIHsgYmFja2dyb3VuZDogI0U3RjhFRTsgY29sb3I6ICMwQjZEM0M7IGJvcmRlci1jb2xvcjogI0I5RThDQjsgfQoKLmRhc2hib2FyZCB7IGRpc3BsYXk6IGdyaWQ7IGdyaWQtdGVtcGxhdGUtY29sdW1uczogMjcwcHggMWZyOyBnYXA6IDI0cHg7IGFsaWduLWl0ZW1zOiBzdGFydDsgfQouc2lkZWJhciB7IHBvc2l0aW9uOiBzdGlja3k7IHRvcDogOThweDsgfQouc2lkZWJhci1tZW51IHsgZGlzcGxheTogZ3JpZDsgZ2FwOiA4cHg7IH0KLnNpZGViYXItbWVudSBidXR0b24geyBqdXN0aWZ5LWNvbnRlbnQ6IGZsZXgtc3RhcnQ7IH0KLmFkbWluLXVzZXIgeyBkaXNwbGF5OiBmbGV4OyBhbGlnbi1pdGVtczogY2VudGVyOyBnYXA6IDEycHg7IG1hcmdpbi1ib3R0b206IDIycHg7IH0KLmFkbWluLWF2YXRhciB7IHdpZHRoOiA0OHB4OyBoZWlnaHQ6IDQ4cHg7IGJvcmRlci1yYWRpdXM6IDE2cHg7IGJhY2tncm91bmQ6IHZhcigtLWdyYWRpZW50KTsgY29sb3I6IHdoaXRlOyBkaXNwbGF5OiBncmlkOyBwbGFjZS1pdGVtczogY2VudGVyOyBmb250LXdlaWdodDogOTAwOyB9Ci5hZG1pbi11c2VyIHNtYWxsIHsgY29sb3I6IHZhcigtLW11dGVkKTsgfQouc2VjdGlvbi10aXRsZSB7IGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGp1c3RpZnktY29udGVudDogc3BhY2UtYmV0d2VlbjsgZ2FwOiAxNHB4OyBtYXJnaW4tYm90dG9tOiAxOHB4OyB9Ci5zZWN0aW9uLXRpdGxlIGgxLCAuc2VjdGlvbi10aXRsZSBoMiB7IG1hcmdpbjogMDsgfQoubWV0cmljIHsgcGFkZGluZzogMThweDsgYm9yZGVyLXJhZGl1czogMThweDsgYmFja2dyb3VuZDogd2hpdGU7IGJvcmRlcjogMXB4IHNvbGlkIHZhcigtLWxpbmUpOyB9Ci5tZXRyaWMgc3BhbiB7IGNvbG9yOiB2YXIoLS1tdXRlZCk7IGZvbnQtd2VpZ2h0OiA3MDA7IH0KLm1ldHJpYyBzdHJvbmcgeyBkaXNwbGF5OiBibG9jazsgZm9udC1zaXplOiAzMHB4OyBtYXJnaW4tdG9wOiA2cHg7IH0KLnF1aXotY2FyZCB7IGRpc3BsYXk6IGdyaWQ7IGdhcDogMTVweDsgfQoucXVpei1jYXJkIGgzIHsgbWFyZ2luOiAwOyB9Ci5xdWl6LW1ldGEgeyBkaXNwbGF5OiBmbGV4OyBmbGV4LXdyYXA6IHdyYXA7IGdhcDogOHB4OyBjb2xvcjogdmFyKC0tbXV0ZWQpOyBmb250LXNpemU6IDE0cHg7IH0KLmNoaXAgeyBkaXNwbGF5OiBpbmxpbmUtZmxleDsgYWxpZ24taXRlbXM6IGNlbnRlcjsgZ2FwOiA2cHg7IHBhZGRpbmc6IDdweCAxMHB4OyBib3JkZXItcmFkaXVzOiA5OTlweDsgYmFja2dyb3VuZDogI0YwRjFGNjsgZm9udC1zaXplOiAxM3B4OyBmb250LXdlaWdodDogNzgwOyB9Ci5xdWl6LWFjdGlvbnMgeyBkaXNwbGF5OiBmbGV4OyBnYXA6IDhweDsgZmxleC13cmFwOiB3cmFwOyB9CgouYnVpbGRlci1xdWVzdGlvbiB7IGJvcmRlcjogMXB4IHNvbGlkIHZhcigtLWxpbmUpOyBib3JkZXItcmFkaXVzOiAyMHB4OyBwYWRkaW5nOiAyMHB4OyBiYWNrZ3JvdW5kOiAjRkFGQkZEOyBtYXJnaW4tYm90dG9tOiAxNnB4OyB9Ci5idWlsZGVyLWhlYWQgeyBkaXNwbGF5OiBmbGV4OyBhbGlnbi1pdGVtczogY2VudGVyOyBqdXN0aWZ5LWNvbnRlbnQ6IHNwYWNlLWJldHdlZW47IGdhcDogMTJweDsgbWFyZ2luLWJvdHRvbTogMTRweDsgfQouYnVpbGRlci1oZWFkIGgzIHsgbWFyZ2luOiAwOyB9Ci5vcHRpb24tcm93IHsgZGlzcGxheTogZ3JpZDsgZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOiAzNHB4IDFmcjsgZ2FwOiAxMHB4OyBhbGlnbi1pdGVtczogY2VudGVyOyBtYXJnaW4tYm90dG9tOiA5cHg7IH0KLm9wdGlvbi1yb3cgaW5wdXRbdHlwZT0icmFkaW8iXSB7IHdpZHRoOiAyMHB4OyBoZWlnaHQ6IDIwcHg7IGFjY2VudC1jb2xvcjogdmFyKC0tZ3JlZW4pOyB9Ci5idWlsZGVyLWFjdGlvbnMgeyBkaXNwbGF5OiBmbGV4OyBnYXA6IDEwcHg7IGZsZXgtd3JhcDogd3JhcDsgbWFyZ2luLXRvcDogMThweDsgfQoKLmF2YXRhci1ncmlkIHsgZGlzcGxheTogZ3JpZDsgZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOiByZXBlYXQoNCwgMWZyKTsgZ2FwOiAxMHB4OyB9Ci5hdmF0YXItY2hvaWNlIHsgYm9yZGVyOiAycHggc29saWQgdHJhbnNwYXJlbnQ7IGJvcmRlci1yYWRpdXM6IDE4cHg7IGJhY2tncm91bmQ6IHdoaXRlOyBwYWRkaW5nOiA4cHg7IHRleHQtYWxpZ246IGNlbnRlcjsgfQouYXZhdGFyLWNob2ljZS5zZWxlY3RlZCB7IGJvcmRlci1jb2xvcjogdmFyKC0tYmx1ZSk7IGJveC1zaGFkb3c6IDAgMCAwIDRweCByZ2JhKDU0LDkyLDI1NSwuMTIpOyB9Ci5hdmF0YXItdmlzdWFsIHsgbWluLWhlaWdodDogNzJweDsgYm9yZGVyLXJhZGl1czogMTRweDsgZGlzcGxheTogZ3JpZDsgcGxhY2UtaXRlbXM6IGNlbnRlcjsgZm9udC1zaXplOiAzOHB4OyBjb2xvcjogd2hpdGU7IH0KLmF2YXRhci1jaG9pY2Ugc21hbGwgeyBkaXNwbGF5OiBibG9jazsgbWFyZ2luLXRvcDogN3B4OyBmb250LXdlaWdodDogODAwOyB9CgoucHJlc2VudGVyLXNoZWxsLCAuZ2FtZS1zaGVsbCB7IG1pbi1oZWlnaHQ6IDEwMHZoOyBiYWNrZ3JvdW5kOiB2YXIoLS1pbmspOyBjb2xvcjogd2hpdGU7IH0KLnByZXNlbnRlci1oZWFkZXIsIC5nYW1lLWhlYWRlciB7IG1pbi1oZWlnaHQ6IDc2cHg7IGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGp1c3RpZnktY29udGVudDogc3BhY2UtYmV0d2VlbjsgZ2FwOiAxOHB4OyBwYWRkaW5nOiAxNHB4IGNsYW1wKDE4cHgsNHZ3LDUycHgpOyBib3JkZXItYm90dG9tOiAxcHggc29saWQgcmdiYSgyNTUsMjU1LDI1NSwuMTIpOyBiYWNrZ3JvdW5kOiByZ2JhKDIzLDI0LDMyLC45NCk7IHBvc2l0aW9uOiBzdGlja3k7IHRvcDogMDsgei1pbmRleDogMjU7IH0KLnByZXNlbnRlci1zdGFnZSwgLmdhbWUtc3RhZ2UgeyB3aWR0aDogbWluKDEyMjBweCwgY2FsYygxMDAlIC0gMjhweCkpOyBtYXJnaW46IDAgYXV0bzsgbWluLWhlaWdodDogY2FsYygxMDB2aCAtIDE2MHB4KTsgcGFkZGluZzogMzBweCAwIDEyMHB4OyBkaXNwbGF5OiBncmlkOyBhbGlnbi1jb250ZW50OiBzdGFydDsgZ2FwOiAyMnB4OyB9Ci5wcmVzZW50ZXItbG9iYnkgeyBkaXNwbGF5OiBncmlkOyBncmlkLXRlbXBsYXRlLWNvbHVtbnM6IC45ZnIgMS4xZnI7IGdhcDogMjRweDsgYWxpZ24taXRlbXM6IHN0cmV0Y2g7IH0KLmxvYmJ5LWNvZGUgeyBmb250LXNpemU6IGNsYW1wKDUycHgsIDh2dywgOTZweCk7IGxldHRlci1zcGFjaW5nOiAuMTJlbTsgZm9udC13ZWlnaHQ6IDk1MDsgbGluZS1oZWlnaHQ6IDE7IGJhY2tncm91bmQ6IHZhcigtLWdyYWRpZW50KTsgLXdlYmtpdC1iYWNrZ3JvdW5kLWNsaXA6IHRleHQ7IGJhY2tncm91bmQtY2xpcDogdGV4dDsgY29sb3I6IHRyYW5zcGFyZW50OyB9Ci5xci13cmFwIHsgZGlzcGxheTogaW5saW5lLWZsZXg7IGJhY2tncm91bmQ6IHdoaXRlOyBwYWRkaW5nOiAxNHB4OyBib3JkZXItcmFkaXVzOiAyMnB4OyB9Ci5xci13cmFwIGNhbnZhcywgLnFyLXdyYXAgaW1nIHsgd2lkdGg6IG1pbigyNjBweCwgNjB2dykgIWltcG9ydGFudDsgaGVpZ2h0OiBhdXRvICFpbXBvcnRhbnQ7IGRpc3BsYXk6IGJsb2NrOyB9Ci5wbGF5ZXItY2xvdWQgeyBkaXNwbGF5OiBmbGV4OyBnYXA6IDEwcHg7IGZsZXgtd3JhcDogd3JhcDsgYWxpZ24tY29udGVudDogc3RhcnQ7IH0KLnBsYXllci1waWxsIHsgZGlzcGxheTogaW5saW5lLWZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGdhcDogOXB4OyBwYWRkaW5nOiA5cHggMTNweCA5cHggOXB4OyBiYWNrZ3JvdW5kOiByZ2JhKDI1NSwyNTUsMjU1LC4xKTsgYm9yZGVyOiAxcHggc29saWQgcmdiYSgyNTUsMjU1LDI1NSwuMTIpOyBib3JkZXItcmFkaXVzOiA5OTlweDsgfQoubWluaS1hdmF0YXIgeyB3aWR0aDogMzhweDsgaGVpZ2h0OiAzOHB4OyBib3JkZXItcmFkaXVzOiA1MCU7IGRpc3BsYXk6IGdyaWQ7IHBsYWNlLWl0ZW1zOiBjZW50ZXI7IGZvbnQtc2l6ZTogMjJweDsgfQoKLnF1ZXN0aW9uLXRvcCB7IGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGp1c3RpZnktY29udGVudDogc3BhY2UtYmV0d2VlbjsgZ2FwOiAxOHB4OyB9Ci5xdWVzdGlvbi10aXRsZSB7IGZvbnQtc2l6ZTogY2xhbXAoMjhweCwgNXZ3LCA1OHB4KTsgbGluZS1oZWlnaHQ6IDEuMDg7IHRleHQtYWxpZ246IGNlbnRlcjsgbWFyZ2luOiA4cHggYXV0bzsgbWF4LXdpZHRoOiAxMDUwcHg7IH0KLnRpbWVyIHsgd2lkdGg6IDc2cHg7IGhlaWdodDogNzZweDsgYm9yZGVyLXJhZGl1czogNTAlOyBkaXNwbGF5OiBncmlkOyBwbGFjZS1pdGVtczogY2VudGVyOyBiYWNrZ3JvdW5kOiB3aGl0ZTsgY29sb3I6IHZhcigtLWluayk7IGZvbnQtc2l6ZTogMjdweDsgZm9udC13ZWlnaHQ6IDk1MDsgZmxleDogMCAwIGF1dG87IH0KLmFuc3dlcnMtZ3JpZCB7IGRpc3BsYXk6IGdyaWQ7IGdyaWQtdGVtcGxhdGUtY29sdW1uczogMWZyIDFmcjsgZ2FwOiAxNXB4OyB9Ci5hbnN3ZXItYnRuLCAuYW5zd2VyLWNhcmQgeyBtaW4taGVpZ2h0OiAxMjJweDsgYm9yZGVyOiAwOyBib3JkZXItcmFkaXVzOiAyMnB4OyBjb2xvcjogd2hpdGU7IHBhZGRpbmc6IDIwcHg7IGZvbnQtc2l6ZTogY2xhbXAoMTdweCwyLjJ2dywyNnB4KTsgZm9udC13ZWlnaHQ6IDkwMDsgdGV4dC1hbGlnbjogbGVmdDsgZGlzcGxheTogZmxleDsgYWxpZ24taXRlbXM6IGNlbnRlcjsgZ2FwOiAxM3B4OyB9Ci5hbnN3ZXItYnRuOm50aC1jaGlsZCg2bisxKSwgLmFuc3dlci1jYXJkOm50aC1jaGlsZCg2bisxKSB7IGJhY2tncm91bmQ6ICNEOTNCNTY7IH0KLmFuc3dlci1idG46bnRoLWNoaWxkKDZuKzIpLCAuYW5zd2VyLWNhcmQ6bnRoLWNoaWxkKDZuKzIpIHsgYmFja2dyb3VuZDogIzJGNzhEMTsgfQouYW5zd2VyLWJ0bjpudGgtY2hpbGQoNm4rMyksIC5hbnN3ZXItY2FyZDpudGgtY2hpbGQoNm4rMykgeyBiYWNrZ3JvdW5kOiAjRDk5QTAwOyB9Ci5hbnN3ZXItYnRuOm50aC1jaGlsZCg2bis0KSwgLmFuc3dlci1jYXJkOm50aC1jaGlsZCg2bis0KSB7IGJhY2tncm91bmQ6ICMyMzlDNjg7IH0KLmFuc3dlci1idG46bnRoLWNoaWxkKDZuKzUpLCAuYW5zd2VyLWNhcmQ6bnRoLWNoaWxkKDZuKzUpIHsgYmFja2dyb3VuZDogIzhENDZDODsgfQouYW5zd2VyLWJ0bjpudGgtY2hpbGQoNm4rNiksIC5hbnN3ZXItY2FyZDpudGgtY2hpbGQoNm4rNikgeyBiYWNrZ3JvdW5kOiAjQzQ1QzI2OyB9Ci5hbnN3ZXItYnRuLnNlbGVjdGVkIHsgb3V0bGluZTogNnB4IHNvbGlkIHdoaXRlOyBvdXRsaW5lLW9mZnNldDogLTEwcHg7IH0KLmFuc3dlci1idG4uZGltbWVkLCAuYW5zd2VyLWNhcmQuZGltbWVkIHsgb3BhY2l0eTogLjM7IH0KLmFuc3dlci1jYXJkLmNvcnJlY3QgeyBvdXRsaW5lOiA3cHggc29saWQgd2hpdGU7IG91dGxpbmUtb2Zmc2V0OiAtMTFweDsgfQouc2hhcGUgeyB3aWR0aDogMzRweDsgaGVpZ2h0OiAzNHB4OyBib3JkZXI6IDRweCBzb2xpZCByZ2JhKDI1NSwyNTUsMjU1LC45NSk7IGZsZXg6IDAgMCBhdXRvOyB0cmFuc2Zvcm06IHJvdGF0ZSg0NWRlZyk7IH0KLmFuc3dlci1idG46bnRoLWNoaWxkKGV2ZW4pIC5zaGFwZSwgLmFuc3dlci1jYXJkOm50aC1jaGlsZChldmVuKSAuc2hhcGUgeyBib3JkZXItcmFkaXVzOiA1MCU7IHRyYW5zZm9ybTogbm9uZTsgfQoKLmNvbnRyb2wtZG9jayB7IHBvc2l0aW9uOiBmaXhlZDsgbGVmdDogNTAlOyBib3R0b206IDE4cHg7IHRyYW5zZm9ybTogdHJhbnNsYXRlWCgtNTAlKTsgd2lkdGg6IG1pbigxMDQwcHgsIGNhbGMoMTAwJSAtIDI0cHgpKTsgZGlzcGxheTogZmxleDsgYWxpZ24taXRlbXM6IGNlbnRlcjsganVzdGlmeS1jb250ZW50OiBzcGFjZS1iZXR3ZWVuOyBnYXA6IDEycHg7IHBhZGRpbmc6IDEycHg7IGJvcmRlci1yYWRpdXM6IDIwcHg7IGJhY2tncm91bmQ6IHJnYmEoMjU1LDI1NSwyNTUsLjk0KTsgY29sb3I6IHZhcigtLWluayk7IGJveC1zaGFkb3c6IHZhcigtLXNoYWRvdyk7IHotaW5kZXg6IDQwOyBiYWNrZHJvcC1maWx0ZXI6IGJsdXIoMThweCk7IH0KLmNvbnRyb2wtYWN0aW9ucyB7IGRpc3BsYXk6IGZsZXg7IGdhcDogOHB4OyBmbGV4LXdyYXA6IHdyYXA7IH0KLmNvbnRyb2wtc3RhdHVzIHsgbWluLXdpZHRoOiAxNzBweDsgfQouY29udHJvbC1zdGF0dXMgc3Ryb25nIHsgZGlzcGxheTogYmxvY2s7IH0KLmNvbnRyb2wtc3RhdHVzIHNtYWxsIHsgY29sb3I6IHZhcigtLW11dGVkKTsgfQoKLmRpc3RyaWJ1dGlvbiB7IGRpc3BsYXk6IGdyaWQ7IGdhcDogMTJweDsgYmFja2dyb3VuZDogd2hpdGU7IGNvbG9yOiB2YXIoLS1pbmspOyBib3JkZXItcmFkaXVzOiAyNHB4OyBwYWRkaW5nOiAyMnB4OyB9Ci5kaXN0cmlidXRpb24tcm93IHsgZGlzcGxheTogZ3JpZDsgZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOiBtaW5tYXgoMTIwcHgsIDFmcikgM2ZyIDUwcHg7IGdhcDogMTJweDsgYWxpZ24taXRlbXM6IGNlbnRlcjsgfQouYmFyLXRyYWNrIHsgaGVpZ2h0OiAxNHB4OyBib3JkZXItcmFkaXVzOiA5OTlweDsgYmFja2dyb3VuZDogI0U5RUNGMzsgb3ZlcmZsb3c6IGhpZGRlbjsgfQouYmFyLWZpbGwgeyBoZWlnaHQ6IDEwMCU7IGJvcmRlci1yYWRpdXM6IGluaGVyaXQ7IGJhY2tncm91bmQ6IHZhcigtLWdyYWRpZW50KTsgdHJhbnNpdGlvbjogd2lkdGggLjQ1cyBlYXNlOyB9Ci5kaXN0cmlidXRpb24tcm93LmNvcnJlY3QgLmJhci1maWxsIHsgYmFja2dyb3VuZDogdmFyKC0tZ3JlZW4pOyB9CgoubGVhZGVyYm9hcmQgeyBkaXNwbGF5OiBncmlkOyBnYXA6IDEwcHg7IHdpZHRoOiBtaW4oOTAwcHgsIDEwMCUpOyBtYXJnaW46IDAgYXV0bzsgfQoucmFuay1yb3cgeyBkaXNwbGF5OiBncmlkOyBncmlkLXRlbXBsYXRlLWNvbHVtbnM6IDU1cHggNTJweCAxZnIgYXV0bzsgYWxpZ24taXRlbXM6IGNlbnRlcjsgZ2FwOiAxMnB4OyBwYWRkaW5nOiAxM3B4IDE2cHg7IGJvcmRlci1yYWRpdXM6IDE4cHg7IGJhY2tncm91bmQ6IHdoaXRlOyBjb2xvcjogdmFyKC0taW5rKTsgb3BhY2l0eTogMDsgdHJhbnNmb3JtOiB0cmFuc2xhdGVZKDI0cHgpIHNjYWxlKC45OCk7IH0KLnJhbmstcm93LnJldmVhbGVkIHsgYW5pbWF0aW9uOiByYW5rSW4gLjY1cyBjdWJpYy1iZXppZXIoLjIsLjgsLjIsMSkgZm9yd2FyZHM7IH0KLnJhbmstcm93LnRvcC0xIHsgYmFja2dyb3VuZDogbGluZWFyLWdyYWRpZW50KDEzNWRlZywjRkZGMEE2LCNGRkQ5NTQpOyB9Ci5yYW5rLXJvdy50b3AtMiB7IGJhY2tncm91bmQ6IGxpbmVhci1ncmFkaWVudCgxMzVkZWcsI0Y1RjdGQSwjQ0JEMkRCKTsgfQoucmFuay1yb3cudG9wLTMgeyBiYWNrZ3JvdW5kOiBsaW5lYXItZ3JhZGllbnQoMTM1ZGVnLCNGRkUwQzEsI0RGQTA2Qik7IH0KLnJhbmstcG9zaXRpb24geyBmb250LXNpemU6IDI1cHg7IGZvbnQtd2VpZ2h0OiA5NTA7IHRleHQtYWxpZ246IGNlbnRlcjsgfQoucmFuay1zY29yZSB7IGZvbnQtc2l6ZTogMjFweDsgZm9udC13ZWlnaHQ6IDk1MDsgfQpAa2V5ZnJhbWVzIHJhbmtJbiB7IHRvIHsgb3BhY2l0eTogMTsgdHJhbnNmb3JtOiB0cmFuc2xhdGVZKDApIHNjYWxlKDEpOyB9IH0KCi5zdXNwZW5zZS1vdmVybGF5IHsgcG9zaXRpb246IGZpeGVkOyBpbnNldDogMDsgei1pbmRleDogODA7IGRpc3BsYXk6IGdyaWQ7IHBsYWNlLWl0ZW1zOiBjZW50ZXI7IGJhY2tncm91bmQ6IHJhZGlhbC1ncmFkaWVudChjaXJjbGUsICMyQjJEM0IgMCUsICMwQzBEMTMgNzAlKTsgY29sb3I6IHdoaXRlOyB9Ci5zdXNwZW5zZS1udW1iZXIgeyBmb250LXNpemU6IG1pbigzNXZ3LCAyODBweCk7IGZvbnQtd2VpZ2h0OiAxMDAwOyBiYWNrZ3JvdW5kOiB2YXIoLS1ncmFkaWVudCk7IC13ZWJraXQtYmFja2dyb3VuZC1jbGlwOiB0ZXh0OyBiYWNrZ3JvdW5kLWNsaXA6IHRleHQ7IGNvbG9yOiB0cmFuc3BhcmVudDsgYW5pbWF0aW9uOiBzdXNwZW5zZVB1bHNlIC45cyBlYXNlIGluZmluaXRlOyB9Ci5zdXNwZW5zZS1sYWJlbCB7IHRleHQtYWxpZ246IGNlbnRlcjsgZm9udC1zaXplOiBjbGFtcCgyMnB4LDR2dyw0MnB4KTsgZm9udC13ZWlnaHQ6IDg1MDsgbGV0dGVyLXNwYWNpbmc6IC4wNGVtOyB9CkBrZXlmcmFtZXMgc3VzcGVuc2VQdWxzZSB7IDUwJSB7IHRyYW5zZm9ybTogc2NhbGUoMS4xMik7IGZpbHRlcjogYnJpZ2h0bmVzcygxLjI1KTsgfSB9CgoucG9kaXVtIHsgZGlzcGxheTogZ3JpZDsgZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOiAxZnIgMWZyIDFmcjsgYWxpZ24taXRlbXM6IGVuZDsgZ2FwOiAxNHB4OyB3aWR0aDogbWluKDkwMHB4LDEwMCUpOyBtYXJnaW46IDMwcHggYXV0byAwOyB9Ci5wb2RpdW0tcGxhY2UgeyBkaXNwbGF5OiBncmlkOyBnYXA6IDEwcHg7IHRleHQtYWxpZ246IGNlbnRlcjsgfQoucG9kaXVtLXBsYWNlLmZpcnN0IHsgb3JkZXI6IDI7IH0KLnBvZGl1bS1wbGFjZS5zZWNvbmQgeyBvcmRlcjogMTsgfQoucG9kaXVtLXBsYWNlLnRoaXJkIHsgb3JkZXI6IDM7IH0KLnBvZGl1bS1zdGVwIHsgZGlzcGxheTogZ3JpZDsgcGxhY2UtaXRlbXM6IGNlbnRlcjsgY29sb3I6IHZhcigtLWluayk7IGZvbnQtc2l6ZTogMzhweDsgZm9udC13ZWlnaHQ6IDk1MDsgYm9yZGVyLXJhZGl1czogMjBweCAyMHB4IDAgMDsgfQouZmlyc3QgLnBvZGl1bS1zdGVwIHsgaGVpZ2h0OiAxOTBweDsgYmFja2dyb3VuZDogbGluZWFyLWdyYWRpZW50KDE4MGRlZywjRkZFNzc1LCNGOUI5MUEpOyB9Ci5zZWNvbmQgLnBvZGl1bS1zdGVwIHsgaGVpZ2h0OiAxNDVweDsgYmFja2dyb3VuZDogbGluZWFyLWdyYWRpZW50KDE4MGRlZywjRjJGNUY4LCNBRUI3QzQpOyB9Ci50aGlyZCAucG9kaXVtLXN0ZXAgeyBoZWlnaHQ6IDExMHB4OyBiYWNrZ3JvdW5kOiBsaW5lYXItZ3JhZGllbnQoMTgwZGVnLCNGRkQ2QjIsI0M0N0EzQSk7IH0KLnBvZGl1bS1uYW1lIHsgZm9udC13ZWlnaHQ6IDkwMDsgZm9udC1zaXplOiAxOHB4OyB9Ci5wb2RpdW0tcHJpemUgeyBjb2xvcjogcmdiYSgyNTUsMjU1LDI1NSwuNzIpOyBmb250LXNpemU6IDE0cHg7IH0KCi53YWl0LXNjcmVlbiB7IG1pbi1oZWlnaHQ6IDEwMHZoOyBkaXNwbGF5OiBncmlkOyBwbGFjZS1pdGVtczogY2VudGVyOyBwYWRkaW5nOiAyNHB4OyBiYWNrZ3JvdW5kOiB2YXIoLS1ncmFkaWVudCk7IGNvbG9yOiB3aGl0ZTsgdGV4dC1hbGlnbjogY2VudGVyOyB9Ci53YWl0LWNhcmQgeyB3aWR0aDogbWluKDc2MHB4LDEwMCUpOyB9Ci53YWl0LWNhcmQgaDEgeyBmb250LXNpemU6IGNsYW1wKDM2cHgsOHZ3LDc0cHgpOyBsaW5lLWhlaWdodDogMTsgbWFyZ2luOiAxNHB4IDAgMThweDsgfQouc3Bpbm5lciB7IHdpZHRoOiA2NnB4OyBoZWlnaHQ6IDY2cHg7IGJvcmRlcjogN3B4IHNvbGlkIHJnYmEoMjU1LDI1NSwyNTUsLjI1KTsgYm9yZGVyLXRvcC1jb2xvcjogd2hpdGU7IGJvcmRlci1yYWRpdXM6IDUwJTsgYW5pbWF0aW9uOiBzcGluIC45cyBsaW5lYXIgaW5maW5pdGU7IG1hcmdpbjogMCBhdXRvIDI0cHg7IH0KQGtleWZyYW1lcyBzcGluIHsgdG8geyB0cmFuc2Zvcm06IHJvdGF0ZSgzNjBkZWcpOyB9IH0KCi50b2FzdCB7IHBvc2l0aW9uOiBmaXhlZDsgbGVmdDogNTAlOyBib3R0b206IDI0cHg7IHRyYW5zZm9ybTogdHJhbnNsYXRlKC01MCUsIDEyMHB4KTsgb3BhY2l0eTogMDsgei1pbmRleDogMTAwOyBwYWRkaW5nOiAxM3B4IDE4cHg7IGJhY2tncm91bmQ6IHZhcigtLWluayk7IGNvbG9yOiB3aGl0ZTsgYm9yZGVyLXJhZGl1czogMTRweDsgZm9udC13ZWlnaHQ6IDgwMDsgYm94LXNoYWRvdzogdmFyKC0tc2hhZG93KTsgdHJhbnNpdGlvbjogLjI1cyBlYXNlOyBwb2ludGVyLWV2ZW50czogbm9uZTsgbWF4LXdpZHRoOiBjYWxjKDEwMCUgLSAyOHB4KTsgdGV4dC1hbGlnbjogY2VudGVyOyB9Ci50b2FzdC5zaG93IHsgdHJhbnNmb3JtOiB0cmFuc2xhdGUoLTUwJSwwKTsgb3BhY2l0eTogMTsgfQouZW1wdHkgeyBwYWRkaW5nOiAyNnB4OyBib3JkZXI6IDFweCBkYXNoZWQgdmFyKC0tbGluZSk7IGJvcmRlci1yYWRpdXM6IDE4cHg7IHRleHQtYWxpZ246IGNlbnRlcjsgY29sb3I6IHZhcigtLW11dGVkKTsgfQouaGlkZGVuIHsgZGlzcGxheTogbm9uZSAhaW1wb3J0YW50OyB9Ci5tdXRlZCB7IGNvbG9yOiB2YXIoLS1tdXRlZCk7IH0KLndoaXRlLW11dGVkIHsgY29sb3I6IHJnYmEoMjU1LDI1NSwyNTUsLjcyKTsgfQoucm93IHsgZGlzcGxheTogZmxleDsgZ2FwOiAxMHB4OyBhbGlnbi1pdGVtczogY2VudGVyOyBmbGV4LXdyYXA6IHdyYXA7IH0KLnNwYWNlLWJldHdlZW4geyBqdXN0aWZ5LWNvbnRlbnQ6IHNwYWNlLWJldHdlZW47IH0KLnRleHQtY2VudGVyIHsgdGV4dC1hbGlnbjogY2VudGVyOyB9Ci5tdC0wIHsgbWFyZ2luLXRvcDogMDsgfQoubWItMCB7IG1hcmdpbi1ib3R0b206IDA7IH0KCkBtZWRpYSAobWF4LXdpZHRoOiA5MjBweCkgewogIC5oZXJvLCAuZGFzaGJvYXJkLCAucHJlc2VudGVyLWxvYmJ5IHsgZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOiAxZnI7IH0KICAuc2lkZWJhciB7IHBvc2l0aW9uOiBzdGF0aWM7IH0KICAuc2lkZWJhci1tZW51IHsgZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOiByZXBlYXQoMywxZnIpOyB9CiAgLnNpZGViYXItbWVudSAuYnRuIHsganVzdGlmeS1jb250ZW50OiBjZW50ZXI7IGZvbnQtc2l6ZTogMTNweDsgcGFkZGluZy1pbmxpbmU6IDhweDsgfQogIC5ncmlkLTMsIC5ncmlkLTQgeyBncmlkLXRlbXBsYXRlLWNvbHVtbnM6IDFmciAxZnI7IH0KfQoKQG1lZGlhIChtYXgtd2lkdGg6IDY1MHB4KSB7CiAgLmJyYW5kLWNvcHkgc21hbGwgeyBkaXNwbGF5OiBub25lOyB9CiAgLnRvcGJhciB7IGFsaWduLWl0ZW1zOiBmbGV4LXN0YXJ0OyB9CiAgLmdyaWQtMiwgLmdyaWQtMywgLmdyaWQtNCwgLmFuc3dlcnMtZ3JpZCB7IGdyaWQtdGVtcGxhdGUtY29sdW1uczogMWZyOyB9CiAgLm1vY2stZ3JpZCB7IGdyaWQtdGVtcGxhdGUtY29sdW1uczogMWZyOyB9CiAgLmF2YXRhci1ncmlkIHsgZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOiByZXBlYXQoMywxZnIpOyB9CiAgLmFuc3dlci1idG4sIC5hbnN3ZXItY2FyZCB7IG1pbi1oZWlnaHQ6IDkwcHg7IH0KICAucHJlc2VudGVyLXN0YWdlLCAuZ2FtZS1zdGFnZSB7IHBhZGRpbmctYm90dG9tOiAxNzBweDsgfQogIC5jb250cm9sLWRvY2sgeyBhbGlnbi1pdGVtczogc3RyZXRjaDsgZmxleC1kaXJlY3Rpb246IGNvbHVtbjsgfQogIC5jb250cm9sLWFjdGlvbnMgeyBkaXNwbGF5OiBncmlkOyBncmlkLXRlbXBsYXRlLWNvbHVtbnM6IDFmciAxZnI7IH0KICAuY29udHJvbC1hY3Rpb25zIC5idG4geyBtaW4td2lkdGg6IDA7IH0KICAuZGlzdHJpYnV0aW9uLXJvdyB7IGdyaWQtdGVtcGxhdGUtY29sdW1uczogMWZyOyBnYXA6IDVweDsgfQogIC5yYW5rLXJvdyB7IGdyaWQtdGVtcGxhdGUtY29sdW1uczogNDJweCA0NHB4IDFmcjsgfQogIC5yYW5rLXNjb3JlIHsgZ3JpZC1jb2x1bW46IDM7IH0KICAucG9kaXVtIHsgZ2FwOiA2cHg7IH0KICAucG9kaXVtLW5hbWUgeyBmb250LXNpemU6IDEzcHg7IH0KICAuZmlyc3QgLnBvZGl1bS1zdGVwIHsgaGVpZ2h0OiAxNTBweDsgfQogIC5zZWNvbmQgLnBvZGl1bS1zdGVwIHsgaGVpZ2h0OiAxMTBweDsgfQogIC50aGlyZCAucG9kaXVtLXN0ZXAgeyBoZWlnaHQ6IDg1cHg7IH0KfQo=', 'base64') }],
  ['/app.js', { type: 'application/javascript; charset=utf-8', data: Buffer.from('J3VzZSBzdHJpY3QnOwoKY29uc3QgYXBwID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2FwcCcpOwpjb25zdCB0b2FzdEVsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3RvYXN0Jyk7CmNvbnN0IEFVVEhfS0VZID0gJ3F1aXpfY3JlZHN5c3RlbV9hdXRoJzsKY29uc3QgUFJFU0VOVEVSX0tFWSA9IChyb29tKSA9PiBgcXVpel9jcmVkc3lzdGVtX3ByZXNlbnRlcl8ke3Jvb219YDsKY29uc3QgUExBWUVSX0tFWSA9IChyb29tKSA9PiBgcXVpel9jcmVkc3lzdGVtX3BsYXllcl8ke3Jvb219YDsKCmNvbnN0IHN0YXRlID0gewogIGNvbmZpZzogbnVsbCwKICBhdXRoOiBudWxsLAogIHF1aXp6ZXM6IFtdLAogIGFkbWluczogW10sCiAgZGFzaGJvYXJkVGFiOiAnb3ZlcnZpZXcnLAogIGVkaXRvcjogbnVsbCwKICBzdGFydFF1aXpJZDogbnVsbCwKICBldmVudFNvdXJjZTogbnVsbCwKICByb29tOiBudWxsLAogIHNlbGY6IG51bGwsCiAgcGxheWVyQ3JlZHM6IG51bGwsCiAgcHJlc2VudGVyQ3JlZHM6IG51bGwsCiAgdGltZXJJbnRlcnZhbDogbnVsbCwKICBsYXN0UmFua2luZ0tleTogbnVsbCwKICBhdWRpbzogewogICAgY29udGV4dDogbnVsbCwKICAgIHRpbWVyOiBudWxsLAogICAgYWN0aXZlVGhlbWU6IG51bGwsCiAgICBlbmFibGVkOiB0cnVlLAogICAgc3RlcDogMCwKICB9LAp9OwoKY29uc3QgcGFyYW1zID0gbmV3IFVSTFNlYXJjaFBhcmFtcyhsb2NhdGlvbi5zZWFyY2gpOwoKZnVuY3Rpb24gZXNjYXBlSHRtbCh2YWx1ZSkgewogIHJldHVybiBTdHJpbmcodmFsdWUgPz8gJycpCiAgICAucmVwbGFjZSgvJi9nLCAnJmFtcDsnKQogICAgLnJlcGxhY2UoLzwvZywgJyZsdDsnKQogICAgLnJlcGxhY2UoLz4vZywgJyZndDsnKQogICAgLnJlcGxhY2UoLyIvZywgJyZxdW90OycpCiAgICAucmVwbGFjZSgvJy9nLCAnJiMwMzk7Jyk7Cn0KCmZ1bmN0aW9uIHJhbmRvbUlkKHByZWZpeCA9ICdpZCcpIHsKICBpZiAoY3J5cHRvLnJhbmRvbVVVSUQpIHJldHVybiBgJHtwcmVmaXh9XyR7Y3J5cHRvLnJhbmRvbVVVSUQoKX1gOwogIHJldHVybiBgJHtwcmVmaXh9XyR7RGF0ZS5ub3coKX1fJHtNYXRoLnJhbmRvbSgpLnRvU3RyaW5nKDE2KS5zbGljZSgyKX1gOwp9CgpmdW5jdGlvbiBzaG93VG9hc3QobWVzc2FnZSkgewogIHRvYXN0RWwudGV4dENvbnRlbnQgPSBtZXNzYWdlOwogIHRvYXN0RWwuY2xhc3NMaXN0LmFkZCgnc2hvdycpOwogIGNsZWFyVGltZW91dChzaG93VG9hc3QudGltZXIpOwogIHNob3dUb2FzdC50aW1lciA9IHNldFRpbWVvdXQoKCkgPT4gdG9hc3RFbC5jbGFzc0xpc3QucmVtb3ZlKCdzaG93JyksIDI4MDApOwp9Cgphc3luYyBmdW5jdGlvbiBhcGkocGF0aCwgYm9keSA9IHt9KSB7CiAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBmZXRjaChwYXRoLCB7CiAgICBtZXRob2Q6ICdQT1NUJywKICAgIGhlYWRlcnM6IHsgJ0NvbnRlbnQtVHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uJyB9LAogICAgYm9keTogSlNPTi5zdHJpbmdpZnkoYm9keSksCiAgfSk7CiAgY29uc3QgZGF0YSA9IGF3YWl0IHJlc3BvbnNlLmpzb24oKS5jYXRjaCgoKSA9PiAoeyBvazogZmFsc2UsIG1lc3NhZ2U6ICdSZXNwb3N0YSBpbnbDoWxpZGEgZG8gc2Vydmlkb3IuJyB9KSk7CiAgaWYgKCFyZXNwb25zZS5vayB8fCBkYXRhLm9rID09PSBmYWxzZSkgdGhyb3cgbmV3IEVycm9yKGRhdGEubWVzc2FnZSB8fCAnTsOjbyBmb2kgcG9zc8OtdmVsIGNvbmNsdWlyIGEgYcOnw6NvLicpOwogIHJldHVybiBkYXRhOwp9CgpmdW5jdGlvbiBicmFuZE1hcmt1cChsaWdodCA9IGZhbHNlKSB7CiAgcmV0dXJuIGAKICAgIDxhIGNsYXNzPSJicmFuZCIgaHJlZj0iLyIgYXJpYS1sYWJlbD0iUXVpeiBDcmVkc3lzdGVtIj4KICAgICAgPHNwYW4gY2xhc3M9ImJyYW5kLXN5bWJvbCIgYXJpYS1oaWRkZW49InRydWUiPjwvc3Bhbj4KICAgICAgPHNwYW4gY2xhc3M9ImJyYW5kLWNvcHkiPgogICAgICAgIDxzdHJvbmcgc3R5bGU9ImNvbG9yOiR7bGlnaHQgPyAnd2hpdGUnIDogJ3ZhcigtLWluayknfSI+UXVpeiBDcmVkc3lzdGVtPC9zdHJvbmc+CiAgICAgICAgPHNtYWxsIHN0eWxlPSJjb2xvcjoke2xpZ2h0ID8gJ3JnYmEoMjU1LDI1NSwyNTUsLjY4KScgOiAnJ30iPkVkdWNhw6fDo28gY29ycG9yYXRpdmEgYW8gdml2bzwvc21hbGw+CiAgICAgIDwvc3Bhbj4KICAgIDwvYT5gOwp9CgpmdW5jdGlvbiB0b3BiYXIoYWN0aW9ucyA9ICcnKSB7CiAgcmV0dXJuIGA8aGVhZGVyIGNsYXNzPSJ0b3BiYXIiPiR7YnJhbmRNYXJrdXAoKX08ZGl2IGNsYXNzPSJ0b3AtYWN0aW9ucyI+JHthY3Rpb25zfTwvZGl2PjwvaGVhZGVyPmA7Cn0KCmZ1bmN0aW9uIGNsZWFyVGltZXIoKSB7CiAgaWYgKHN0YXRlLnRpbWVySW50ZXJ2YWwpIGNsZWFySW50ZXJ2YWwoc3RhdGUudGltZXJJbnRlcnZhbCk7CiAgc3RhdGUudGltZXJJbnRlcnZhbCA9IG51bGw7Cn0KCmZ1bmN0aW9uIHN0YXJ0Q291bnRkb3duKHJvb20pIHsKICBjbGVhclRpbWVyKCk7CiAgY29uc3QgZWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgndGltZXInKTsKICBpZiAoIWVsIHx8ICFyb29tLnF1ZXN0aW9uU3RhcnRlZEF0IHx8ICFyb29tLnF1ZXN0aW9uKSByZXR1cm47CiAgY29uc3QgdGljayA9ICgpID0+IHsKICAgIGNvbnN0IGVsYXBzZWQgPSAoRGF0ZS5ub3coKSAtIHJvb20ucXVlc3Rpb25TdGFydGVkQXQpIC8gMTAwMDsKICAgIGNvbnN0IHJlbWFpbmluZyA9IE1hdGgubWF4KDAsIE1hdGguY2VpbChyb29tLnF1ZXN0aW9uLnRpbWVMaW1pdCAtIGVsYXBzZWQpKTsKICAgIGVsLnRleHRDb250ZW50ID0gcmVtYWluaW5nOwogIH07CiAgdGljaygpOwogIHN0YXRlLnRpbWVySW50ZXJ2YWwgPSBzZXRJbnRlcnZhbCh0aWNrLCAyNTApOwp9CgpmdW5jdGlvbiBhdmF0YXJWaXN1YWwoYXZhdGFyLCBzbWFsbCA9IGZhbHNlKSB7CiAgY29uc3Qgc2l6ZUNsYXNzID0gc21hbGwgPyAnbWluaS1hdmF0YXInIDogJ2F2YXRhci12aXN1YWwnOwogIHJldHVybiBgPHNwYW4gY2xhc3M9IiR7c2l6ZUNsYXNzfSIgc3R5bGU9ImJhY2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDEzNWRlZywke2F2YXRhci5jb2xvcnNbMF19LCR7YXZhdGFyLmNvbG9yc1sxXX0pIj4ke2F2YXRhci5lbW9qaX08L3NwYW4+YDsKfQoKZnVuY3Rpb24gcGhhc2VMYWJlbChwaGFzZSkgewogIHJldHVybiAoeyBsb2JieTogJ1NhbGEgZGUgZXNwZXJhJywgcXVlc3Rpb246ICdQZXJndW50YSBhYmVydGEnLCBhbnN3ZXI6ICdSZXNwb3N0YSByZXZlbGFkYScsIHJhbmtpbmc6ICdSYW5raW5nJywgZmluaXNoZWQ6ICdFbmNlcnJhZG8nIH0pW3BoYXNlXSB8fCBwaGFzZTsKfQoKZnVuY3Rpb24gcmVuZGVyUXIoZWxlbWVudElkLCB0ZXh0LCBzaXplID0gMjQwKSB7CiAgcmVxdWVzdEFuaW1hdGlvbkZyYW1lKCgpID0+IHsKICAgIGNvbnN0IGVsZW1lbnQgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChlbGVtZW50SWQpOwogICAgaWYgKCFlbGVtZW50IHx8ICF3aW5kb3cuUVJDb2RlKSByZXR1cm47CiAgICBlbGVtZW50LmlubmVySFRNTCA9ICcnOwogICAgbmV3IFFSQ29kZShlbGVtZW50LCB7CiAgICAgIHRleHQsCiAgICAgIHdpZHRoOiBzaXplLAogICAgICBoZWlnaHQ6IHNpemUsCiAgICAgIGNvbG9yRGFyazogJyMxNzE4MjAnLAogICAgICBjb2xvckxpZ2h0OiAnI2ZmZmZmZicsCiAgICAgIGNvcnJlY3RMZXZlbDogUVJDb2RlLkNvcnJlY3RMZXZlbC5ILAogICAgfSk7CiAgfSk7Cn0KCmFzeW5jIGZ1bmN0aW9uIGNvcHlUZXh0KHRleHQpIHsKICB0cnkgewogICAgYXdhaXQgbmF2aWdhdG9yLmNsaXBib2FyZC53cml0ZVRleHQodGV4dCk7CiAgICBzaG93VG9hc3QoJ0xpbmsgY29waWFkby4nKTsKICB9IGNhdGNoIChlcnJvcikgewogICAgY29uc3QgdGVtcCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ3RleHRhcmVhJyk7CiAgICB0ZW1wLnZhbHVlID0gdGV4dDsKICAgIGRvY3VtZW50LmJvZHkuYXBwZW5kQ2hpbGQodGVtcCk7CiAgICB0ZW1wLnNlbGVjdCgpOwogICAgZG9jdW1lbnQuZXhlY0NvbW1hbmQoJ2NvcHknKTsKICAgIHRlbXAucmVtb3ZlKCk7CiAgICBzaG93VG9hc3QoJ0xpbmsgY29waWFkby4nKTsKICB9Cn0KCi8vIE3DunNpY2EgZ2VyYWRhIG5vIHByw7NwcmlvIG5hdmVnYWRvciwgc2VtIGFycXVpdm9zIGV4dGVybm9zIG91IGRpcmVpdG9zIGF1dG9yYWlzLgpmdW5jdGlvbiBlbnN1cmVBdWRpbygpIHsKICBpZiAoIXN0YXRlLmF1ZGlvLmVuYWJsZWQpIHJldHVybiBudWxsOwogIGlmICghc3RhdGUuYXVkaW8uY29udGV4dCkgewogICAgY29uc3QgQXVkaW9Db250ZXh0ID0gd2luZG93LkF1ZGlvQ29udGV4dCB8fCB3aW5kb3cud2Via2l0QXVkaW9Db250ZXh0OwogICAgaWYgKCFBdWRpb0NvbnRleHQpIHJldHVybiBudWxsOwogICAgc3RhdGUuYXVkaW8uY29udGV4dCA9IG5ldyBBdWRpb0NvbnRleHQoKTsKICB9CiAgaWYgKHN0YXRlLmF1ZGlvLmNvbnRleHQuc3RhdGUgPT09ICdzdXNwZW5kZWQnKSBzdGF0ZS5hdWRpby5jb250ZXh0LnJlc3VtZSgpLmNhdGNoKCgpID0+IHt9KTsKICByZXR1cm4gc3RhdGUuYXVkaW8uY29udGV4dDsKfQoKZnVuY3Rpb24gcGxheU5vdGUoZnJlcXVlbmN5LCBkdXJhdGlvbiA9IC4xMiwgdHlwZSA9ICdzaW5lJywgdm9sdW1lID0gLjA0NSwgZGVsYXkgPSAwKSB7CiAgY29uc3QgY29udGV4dCA9IGVuc3VyZUF1ZGlvKCk7CiAgaWYgKCFjb250ZXh0KSByZXR1cm47CiAgY29uc3Qgb3NjaWxsYXRvciA9IGNvbnRleHQuY3JlYXRlT3NjaWxsYXRvcigpOwogIGNvbnN0IGdhaW4gPSBjb250ZXh0LmNyZWF0ZUdhaW4oKTsKICBvc2NpbGxhdG9yLnR5cGUgPSB0eXBlOwogIG9zY2lsbGF0b3IuZnJlcXVlbmN5LnZhbHVlID0gZnJlcXVlbmN5OwogIGdhaW4uZ2Fpbi5zZXRWYWx1ZUF0VGltZSgwLjAwMDEsIGNvbnRleHQuY3VycmVudFRpbWUgKyBkZWxheSk7CiAgZ2Fpbi5nYWluLmV4cG9uZW50aWFsUmFtcFRvVmFsdWVBdFRpbWUodm9sdW1lLCBjb250ZXh0LmN1cnJlbnRUaW1lICsgZGVsYXkgKyAuMDEyKTsKICBnYWluLmdhaW4uZXhwb25lbnRpYWxSYW1wVG9WYWx1ZUF0VGltZSgwLjAwMDEsIGNvbnRleHQuY3VycmVudFRpbWUgKyBkZWxheSArIGR1cmF0aW9uKTsKICBvc2NpbGxhdG9yLmNvbm5lY3QoZ2FpbikuY29ubmVjdChjb250ZXh0LmRlc3RpbmF0aW9uKTsKICBvc2NpbGxhdG9yLnN0YXJ0KGNvbnRleHQuY3VycmVudFRpbWUgKyBkZWxheSk7CiAgb3NjaWxsYXRvci5zdG9wKGNvbnRleHQuY3VycmVudFRpbWUgKyBkZWxheSArIGR1cmF0aW9uICsgLjAyKTsKfQoKZnVuY3Rpb24gc3RvcE11c2ljKCkgewogIGlmIChzdGF0ZS5hdWRpby50aW1lcikgY2xlYXJJbnRlcnZhbChzdGF0ZS5hdWRpby50aW1lcik7CiAgc3RhdGUuYXVkaW8udGltZXIgPSBudWxsOwogIHN0YXRlLmF1ZGlvLmFjdGl2ZVRoZW1lID0gbnVsbDsKICBzdGF0ZS5hdWRpby5zdGVwID0gMDsKfQoKZnVuY3Rpb24gc3RhcnRNdXNpYyh0aGVtZSkgewogIGlmICghc3RhdGUuYXVkaW8uZW5hYmxlZCB8fCB0aGVtZSA9PT0gJ25vbmUnKSB7CiAgICBzdG9wTXVzaWMoKTsKICAgIHJldHVybjsKICB9CiAgaWYgKHN0YXRlLmF1ZGlvLmFjdGl2ZVRoZW1lID09PSB0aGVtZSAmJiBzdGF0ZS5hdWRpby50aW1lcikgcmV0dXJuOwogIHN0b3BNdXNpYygpOwogIGVuc3VyZUF1ZGlvKCk7CiAgc3RhdGUuYXVkaW8uYWN0aXZlVGhlbWUgPSB0aGVtZTsKICBjb25zdCBwYXR0ZXJucyA9IHsKICAgIHB1bHNlOiBbMjYxLjYzLCAzMjkuNjMsIDM5Mi4wMCwgMzI5LjYzLCAyOTMuNjYsIDM2OS45OSwgNDQwLjAwLCAzNjkuOTldLAogICAgdXBiZWF0OiBbMzI5LjYzLCAzOTIuMDAsIDQ5My44OCwgNTg3LjMzLCA0OTMuODgsIDM5Mi4wMCwgMzQ5LjIzLCA0NDAuMDBdLAogICAgZm9jdXM6IFsyMjAuMDAsIDI3Ny4xOCwgMzI5LjYzLCAyNzcuMTgsIDE5Ni4wMCwgMjQ2Ljk0LCAyOTMuNjYsIDI0Ni45NF0sCiAgfTsKICBjb25zdCBwYXR0ZXJuID0gcGF0dGVybnNbdGhlbWVdIHx8IHBhdHRlcm5zLnB1bHNlOwogIGNvbnN0IGludGVydmFsID0gdGhlbWUgPT09ICdmb2N1cycgPyA2MjAgOiAzNjA7CiAgY29uc3QgdGljayA9ICgpID0+IHsKICAgIGNvbnN0IG5vdGUgPSBwYXR0ZXJuW3N0YXRlLmF1ZGlvLnN0ZXAgJSBwYXR0ZXJuLmxlbmd0aF07CiAgICBwbGF5Tm90ZShub3RlLCB0aGVtZSA9PT0gJ2ZvY3VzJyA/IC40NCA6IC4xOCwgdGhlbWUgPT09ICdwdWxzZScgPyAndHJpYW5nbGUnIDogJ3NpbmUnLCB0aGVtZSA9PT0gJ2ZvY3VzJyA/IC4wMjUgOiAuMDM1KTsKICAgIGlmIChzdGF0ZS5hdWRpby5zdGVwICUgNCA9PT0gMCkgcGxheU5vdGUodGhlbWUgPT09ICd1cGJlYXQnID8gOTggOiA4Mi40MSwgLjEsICdzaW5lJywgLjA1KTsKICAgIHN0YXRlLmF1ZGlvLnN0ZXAgKz0gMTsKICB9OwogIHRpY2soKTsKICBzdGF0ZS5hdWRpby50aW1lciA9IHNldEludGVydmFsKHRpY2ssIGludGVydmFsKTsKfQoKZnVuY3Rpb24gcGxheVN1c3BlbnNlKCkgewogIHN0b3BNdXNpYygpOwogIGVuc3VyZUF1ZGlvKCk7CiAgY29uc3Qgbm90ZXMgPSBbMTEwLCAxMjMuNDcsIDEzOC41OSwgMTU1LjU2LCAxNzQuNjEsIDE5NiwgMjIwLCAyNDYuOTRdOwogIG5vdGVzLmZvckVhY2goKG5vdGUsIGluZGV4KSA9PiB7CiAgICBwbGF5Tm90ZShub3RlLCAuMzIsICdzYXd0b290aCcsIC4wMzUgKyBpbmRleCAqIC4wMDMsIGluZGV4ICogLjM4KTsKICAgIHBsYXlOb3RlKDU1LCAuMDgsICdzaW5lJywgLjA2LCBpbmRleCAqIC4zOCk7CiAgfSk7CiAgcGxheU5vdGUoNTIzLjI1LCAuNywgJ3RyaWFuZ2xlJywgLjA5LCBub3Rlcy5sZW5ndGggKiAuMzggKyAuMSk7Cn0KCmZ1bmN0aW9uIHN5bmNNdXNpYyhyb29tKSB7CiAgaWYgKCFyb29tKSByZXR1cm47CiAgaWYgKHJvb20ucGhhc2UgPT09ICdyYW5raW5nJykgcmV0dXJuOwogIGlmIChyb29tLnBoYXNlID09PSAnZmluaXNoZWQnIHx8IHJvb20ucGhhc2UgPT09ICdhbnN3ZXInKSBzdG9wTXVzaWMoKTsKICBlbHNlIGlmIChyb29tLnBoYXNlID09PSAncXVlc3Rpb24nIHx8IHJvb20ucGhhc2UgPT09ICdsb2JieScpIHN0YXJ0TXVzaWMocm9vbS5tdXNpY1RoZW1lKTsKfQoKZnVuY3Rpb24gdG9nZ2xlQXVkaW8oKSB7CiAgc3RhdGUuYXVkaW8uZW5hYmxlZCA9ICFzdGF0ZS5hdWRpby5lbmFibGVkOwogIGlmICghc3RhdGUuYXVkaW8uZW5hYmxlZCkgc3RvcE11c2ljKCk7CiAgZWxzZSBpZiAoc3RhdGUucm9vbSkgc3luY011c2ljKHN0YXRlLnJvb20pOwogIHNob3dUb2FzdChzdGF0ZS5hdWRpby5lbmFibGVkID8gJ1NvbSBhdGl2YWRvLicgOiAnU29tIGRlc2F0aXZhZG8uJyk7CiAgY29uc3QgYnV0dG9uID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2F1ZGlvLXRvZ2dsZScpOwogIGlmIChidXR0b24pIGJ1dHRvbi50ZXh0Q29udGVudCA9IHN0YXRlLmF1ZGlvLmVuYWJsZWQgPyAn8J+UiiBTb20nIDogJ/CflIcgU29tJzsKfQoKYXN5bmMgZnVuY3Rpb24gaW5pdCgpIHsKICB0cnkgewogICAgY29uc3QgY29uZmlnID0gYXdhaXQgYXBpKCcvYXBpL3B1YmxpYy9jb25maWcnKTsKICAgIHN0YXRlLmNvbmZpZyA9IGNvbmZpZzsKICB9IGNhdGNoIChlcnJvcikgewogICAgYXBwLmlubmVySFRNTCA9IGA8ZGl2IGNsYXNzPSJ3YWl0LXNjcmVlbiI+PGRpdiBjbGFzcz0id2FpdC1jYXJkIj48aDE+U2lzdGVtYSBpbmljaWFuZG88L2gxPjxwPiR7ZXNjYXBlSHRtbChlcnJvci5tZXNzYWdlKX08L3A+PGJ1dHRvbiBjbGFzcz0iYnRuIGJ0bi1saWdodCIgb25jbGljaz0ibG9jYXRpb24ucmVsb2FkKCkiPlRlbnRhciBub3ZhbWVudGU8L2J1dHRvbj48L2Rpdj48L2Rpdj5gOwogICAgcmV0dXJuOwogIH0KCiAgY29uc3QgcHJlc2VudGVyID0gcGFyYW1zLmdldCgncHJlc2VudGVyJyk7CiAgY29uc3Qgc2NyZWVuID0gcGFyYW1zLmdldCgnc2NyZWVuJyk7CiAgY29uc3Qgcm9vbSA9IHBhcmFtcy5nZXQoJ3Jvb20nKTsKICBpZiAocHJlc2VudGVyKSByZXR1cm4gb3BlblByZXNlbnRlcihwcmVzZW50ZXIpOwogIGlmIChzY3JlZW4pIHJldHVybiBvcGVuU2NyZWVuKHNjcmVlbik7CiAgaWYgKHJvb20pIHJldHVybiBvcGVuUGxheWVyKHJvb20sIHBhcmFtcy5nZXQoJ2tleScpIHx8ICcnKTsKICByZW5kZXJIb21lKCk7Cn0KCmZ1bmN0aW9uIHJlbmRlckhvbWUoKSB7CiAgY2xlYXJUaW1lcigpOwogIHN0b3BNdXNpYygpOwogIGFwcC5pbm5lckhUTUwgPSBgCiAgICAke3RvcGJhcihgPGJ1dHRvbiBpZD0iYWRtaW4tb3BlbiIgY2xhc3M9ImJ0biBidG4tZGFyayI+w4FyZWEgYWRtaW5pc3RyYXRpdmE8L2J1dHRvbj5gKX0KICAgIDxtYWluIGNsYXNzPSJjb250YWluZXIiPgogICAgICA8c2VjdGlvbiBjbGFzcz0iaGVybyI+CiAgICAgICAgPGRpdj4KICAgICAgICAgIDxkaXYgY2xhc3M9Imhlcm8tYmFkZ2UiPuKXjyB0cmVpbmFtZW50byBlbSB0ZW1wbyByZWFsPC9kaXY+CiAgICAgICAgICA8aDE+QXByZW5kZXIgZmljb3UgbWFpcyA8c3BhbiBjbGFzcz0iZ3JhZGllbnQtdGV4dCI+dml2by48L3NwYW4+PC9oMT4KICAgICAgICAgIDxwPlF1aXp6ZXMgY29ycG9yYXRpdm9zIGNvbSBzYWxhIGFvIHZpdm8sIHDDs2RpbywgcHJlbWlhw6fDtWVzLCBtw7pzaWNhLCByZWxhdMOzcmlvcyBlIGF0w6kgMTAwIHBhcnRpY2lwYW50ZXMuPC9wPgogICAgICAgICAgPGRpdiBjbGFzcz0icm93IiBzdHlsZT0ibWFyZ2luLXRvcDoyNnB4Ij4KICAgICAgICAgICAgPGJ1dHRvbiBpZD0iam9pbi1ob21lIiBjbGFzcz0iYnRuIGJ0bi1wcmltYXJ5IGJ0bi1sYXJnZSI+RW50cmFyIGVtIHVtYSBzYWxhPC9idXR0b24+CiAgICAgICAgICAgIDxidXR0b24gaWQ9ImFkbWluLWhvbWUiIGNsYXNzPSJidG4gYnRuLWxpZ2h0IGJ0bi1sYXJnZSI+Q3JpYXIgZSBhcHJlc2VudGFyIHF1aXo8L2J1dHRvbj4KICAgICAgICAgIDwvZGl2PgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9Imhlcm8tY2FyZCI+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJleWVicm93IiBzdHlsZT0iYmFja2dyb3VuZDpyZ2JhKDI1NSwyNTUsMjU1LC4xMyk7Y29sb3I6d2hpdGUiPlBlcmd1bnRhIDMgZGUgMTA8L2Rpdj4KICAgICAgICAgIDxkaXYgY2xhc3M9Im1vY2stcXVlc3Rpb24iPlF1YWwgYXRpdHVkZSBjcmlhIG1haXMgdmFsb3IgcGFyYSBvIGNsaWVudGU/PC9kaXY+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJtb2NrLWdyaWQiPgogICAgICAgICAgICA8ZGl2IGNsYXNzPSJtb2NrLW9wdGlvbiI+4peHIE91dmlyIGUgcGVyc29uYWxpemFyPC9kaXY+CiAgICAgICAgICAgIDxkaXYgY2xhc3M9Im1vY2stb3B0aW9uIj7il4sgUmVwZXRpciBvIHJvdGVpcm88L2Rpdj4KICAgICAgICAgICAgPGRpdiBjbGFzcz0ibW9jay1vcHRpb24iPuKXhyBJZ25vcmFyIG9iamXDp8O1ZXM8L2Rpdj4KICAgICAgICAgICAgPGRpdiBjbGFzcz0ibW9jay1vcHRpb24iPuKXiyBGYWxhciBzZW0gcGF1c2FzPC9kaXY+CiAgICAgICAgICA8L2Rpdj4KICAgICAgICA8L2Rpdj4KICAgICAgPC9zZWN0aW9uPgogICAgICA8c2VjdGlvbiBjbGFzcz0iZ3JpZC0zIj4KICAgICAgICA8YXJ0aWNsZSBjbGFzcz0iY2FyZCI+PGgzPuKaoSBBbyB2aXZvPC9oMz48cCBjbGFzcz0ibXV0ZWQiPk8gYXByZXNlbnRhZG9yIGNvbnRyb2xhIHBlcmd1bnRhLCByZXNwb3N0YSwgcmFua2luZyBlIHByw7N4aW1hIHJvZGFkYS48L3A+PC9hcnRpY2xlPgogICAgICAgIDxhcnRpY2xlIGNsYXNzPSJjYXJkIj48aDM+8J+PhiBQcmVtaWHDp8OjbzwvaDM+PHAgY2xhc3M9Im11dGVkIj5Qw7NkaW8gYW5pbWFkbyBwYXJhIHByaW1laXJvLCBzZWd1bmRvIGUgdGVyY2Vpcm8gbHVnYXJlcy48L3A+PC9hcnRpY2xlPgogICAgICAgIDxhcnRpY2xlIGNsYXNzPSJjYXJkIj48aDM+8J+TiiBSZWxhdMOzcmlvIEV4Y2VsPC9oMz48cCBjbGFzcz0ibXV0ZWQiPlByZXNlbsOnYSwgZGF0YSwgaG9yw6FyaW8gZSB0b2RhcyBhcyByZXNwb3N0YXMgcG9yIHBhcnRpY2lwYW50ZS48L3A+PC9hcnRpY2xlPgogICAgICA8L3NlY3Rpb24+CiAgICA8L21haW4+YDsKICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnYWRtaW4tb3BlbicpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgb3BlbkFkbWluKTsKICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnYWRtaW4taG9tZScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgb3BlbkFkbWluKTsKICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnam9pbi1ob21lJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCByZW5kZXJDb2RlRW50cnkpOwp9CgpmdW5jdGlvbiByZW5kZXJDb2RlRW50cnkoKSB7CiAgYXBwLmlubmVySFRNTCA9IGAKICAgICR7dG9wYmFyKGA8YnV0dG9uIGlkPSJiYWNrLWhvbWUiIGNsYXNzPSJidG4gYnRuLWxpZ2h0Ij5Wb2x0YXI8L2J1dHRvbj5gKX0KICAgIDxtYWluIGNsYXNzPSJjb250YWluZXIgbmFycm93Ij4KICAgICAgPGRpdiBjbGFzcz0iY2FyZCB0ZXh0LWNlbnRlciIgc3R5bGU9Im1hcmdpbi10b3A6NTBweCI+CiAgICAgICAgPGRpdiBjbGFzcz0iZXllYnJvdyI+RW50cmFkYSBkbyBwYXJ0aWNpcGFudGU8L2Rpdj4KICAgICAgICA8aDE+RGlnaXRlIG8gY8OzZGlnbyBkYSBzYWxhPC9oMT4KICAgICAgICA8cCBjbGFzcz0ibXV0ZWQiPk8gY8OzZGlnbyBkZSBzZWlzIG7Dum1lcm9zIGFwYXJlY2UgbmEgdGVsYSBkbyBhcHJlc2VudGFkb3IuPC9wPgogICAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48aW5wdXQgaWQ9InJvb20tY29kZSIgY2xhc3M9ImlucHV0IGNvZGUtaW5wdXQiIGlucHV0bW9kZT0ibnVtZXJpYyIgbWF4bGVuZ3RoPSI2IiBwbGFjZWhvbGRlcj0iMDAwMDAwIj48L2Rpdj4KICAgICAgICA8YnV0dG9uIGlkPSJjb250aW51ZS1yb29tIiBjbGFzcz0iYnRuIGJ0bi1wcmltYXJ5IGJ0bi1sYXJnZSBidG4tYmxvY2siPkNvbnRpbnVhcjwvYnV0dG9uPgogICAgICA8L2Rpdj4KICAgIDwvbWFpbj5gOwogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdiYWNrLWhvbWUnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIHJlbmRlckhvbWUpOwogIGNvbnN0IGlucHV0ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3Jvb20tY29kZScpOwogIGlucHV0LmFkZEV2ZW50TGlzdGVuZXIoJ2lucHV0JywgKCkgPT4gaW5wdXQudmFsdWUgPSBpbnB1dC52YWx1ZS5yZXBsYWNlKC9cRC9nLCAnJykuc2xpY2UoMCwgNikpOwogIGNvbnN0IHByb2NlZWQgPSAoKSA9PiB7CiAgICBpZiAoaW5wdXQudmFsdWUubGVuZ3RoICE9PSA2KSByZXR1cm4gc2hvd1RvYXN0KCdEaWdpdGUgb3Mgc2VpcyBuw7ptZXJvcyBkYSBzYWxhLicpOwogICAgbG9jYXRpb24uaHJlZiA9IGAvP3Jvb209JHtlbmNvZGVVUklDb21wb25lbnQoaW5wdXQudmFsdWUpfWA7CiAgfTsKICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnY29udGludWUtcm9vbScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgcHJvY2VlZCk7CiAgaW5wdXQuYWRkRXZlbnRMaXN0ZW5lcigna2V5ZG93bicsIChldmVudCkgPT4geyBpZiAoZXZlbnQua2V5ID09PSAnRW50ZXInKSBwcm9jZWVkKCk7IH0pOwp9Cgphc3luYyBmdW5jdGlvbiBvcGVuQWRtaW4oKSB7CiAgcGFyYW1zLmRlbGV0ZSgncm9vbScpOyBwYXJhbXMuZGVsZXRlKCdwcmVzZW50ZXInKTsgcGFyYW1zLmRlbGV0ZSgnc2NyZWVuJyk7CiAgaGlzdG9yeS5yZXBsYWNlU3RhdGUoe30sICcnLCAnLz9hZG1pbj0xJyk7CiAgY29uc3Qgc3RvcmVkID0gc2Vzc2lvblN0b3JhZ2UuZ2V0SXRlbShBVVRIX0tFWSk7CiAgaWYgKHN0b3JlZCkgewogICAgdHJ5IHsKICAgICAgc3RhdGUuYXV0aCA9IEpTT04ucGFyc2Uoc3RvcmVkKTsKICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgYXBpKCcvYXBpL2FkbWluL3Nlc3Npb24nLCB7IGF1dGhUb2tlbjogc3RhdGUuYXV0aC5hdXRoVG9rZW4gfSk7CiAgICAgIHN0YXRlLmF1dGguYWRtaW4gPSByZXN1bHQuYWRtaW47CiAgICAgIHN0YXRlLmF1dGgucGVyc2lzdGVuY2VNb2RlID0gcmVzdWx0LnBlcnNpc3RlbmNlTW9kZTsKICAgICAgcmV0dXJuIGxvYWREYXNoYm9hcmQoKTsKICAgIH0gY2F0Y2ggKGVycm9yKSB7CiAgICAgIHNlc3Npb25TdG9yYWdlLnJlbW92ZUl0ZW0oQVVUSF9LRVkpOwogICAgICBzdGF0ZS5hdXRoID0gbnVsbDsKICAgIH0KICB9CiAgaWYgKHN0YXRlLmNvbmZpZy5zZXR1cFJlcXVpcmVkKSByZW5kZXJTZXR1cCgpOwogIGVsc2UgcmVuZGVyTG9naW4oKTsKfQoKZnVuY3Rpb24gcmVuZGVyU2V0dXAoKSB7CiAgYXBwLmlubmVySFRNTCA9IGAKICAgICR7dG9wYmFyKGA8YnV0dG9uIGlkPSJzZXR1cC1ob21lIiBjbGFzcz0iYnRuIGJ0bi1saWdodCI+Vm9sdGFyPC9idXR0b24+YCl9CiAgICA8bWFpbiBjbGFzcz0iY29udGFpbmVyIG5hcnJvdyI+CiAgICAgIDxkaXYgY2xhc3M9ImNhcmQiIHN0eWxlPSJtYXJnaW4tdG9wOjQycHgiPgogICAgICAgIDxkaXYgY2xhc3M9ImV5ZWJyb3ciPlByaW1laXJvIGFjZXNzbzwvZGl2PgogICAgICAgIDxoMT5DcmllIG8gYWRtaW5pc3RyYWRvciBwcmluY2lwYWw8L2gxPgogICAgICAgIDxwIGNsYXNzPSJtdXRlZCI+RXNzYSB0ZWxhIHNlcsOhIGJsb3F1ZWFkYSBhdXRvbWF0aWNhbWVudGUgZGVwb2lzIGRhIGNyaWHDp8Ojby48L3A+CiAgICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbCBmb3I9InNldHVwLW5hbWUiPk5vbWU8L2xhYmVsPjxpbnB1dCBpZD0ic2V0dXAtbmFtZSIgY2xhc3M9ImlucHV0IiBhdXRvY29tcGxldGU9Im5hbWUiPjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWwgZm9yPSJzZXR1cC1lbWFpbCI+RS1tYWlsPC9sYWJlbD48aW5wdXQgaWQ9InNldHVwLWVtYWlsIiBjbGFzcz0iaW5wdXQiIHR5cGU9ImVtYWlsIiBhdXRvY29tcGxldGU9ImVtYWlsIj48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsIGZvcj0ic2V0dXAtcGFzc3dvcmQiPlNlbmhhPC9sYWJlbD48aW5wdXQgaWQ9InNldHVwLXBhc3N3b3JkIiBjbGFzcz0iaW5wdXQiIHR5cGU9InBhc3N3b3JkIiBtaW5sZW5ndGg9IjgiIGF1dG9jb21wbGV0ZT0ibmV3LXBhc3N3b3JkIj48c21hbGw+TcOtbmltbyBkZSBvaXRvIGNhcmFjdGVyZXMuPC9zbWFsbD48L2Rpdj4KICAgICAgICA8YnV0dG9uIGlkPSJzZXR1cC1jcmVhdGUiIGNsYXNzPSJidG4gYnRuLXByaW1hcnkgYnRuLWxhcmdlIGJ0bi1ibG9jayI+Q3JpYXIgYWRtaW5pc3RyYWRvcjwvYnV0dG9uPgogICAgICA8L2Rpdj4KICAgIDwvbWFpbj5gOwogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzZXR1cC1ob21lJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCByZW5kZXJIb21lKTsKICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnc2V0dXAtY3JlYXRlJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBhc3luYyAoKSA9PiB7CiAgICB0cnkgewogICAgICBlbnN1cmVBdWRpbygpOwogICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBhcGkoJy9hcGkvc2V0dXAvY3JlYXRlLWFkbWluJywgewogICAgICAgIG5hbWU6IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzZXR1cC1uYW1lJykudmFsdWUsCiAgICAgICAgZW1haWw6IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzZXR1cC1lbWFpbCcpLnZhbHVlLAogICAgICAgIHBhc3N3b3JkOiBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnc2V0dXAtcGFzc3dvcmQnKS52YWx1ZSwKICAgICAgfSk7CiAgICAgIHN0YXRlLmF1dGggPSByZXN1bHQ7CiAgICAgIHNlc3Npb25TdG9yYWdlLnNldEl0ZW0oQVVUSF9LRVksIEpTT04uc3RyaW5naWZ5KHJlc3VsdCkpOwogICAgICBzdGF0ZS5jb25maWcuc2V0dXBSZXF1aXJlZCA9IGZhbHNlOwogICAgICBhd2FpdCBsb2FkRGFzaGJvYXJkKCk7CiAgICB9IGNhdGNoIChlcnJvcikgeyBzaG93VG9hc3QoZXJyb3IubWVzc2FnZSk7IH0KICB9KTsKfQoKZnVuY3Rpb24gcmVuZGVyTG9naW4oKSB7CiAgYXBwLmlubmVySFRNTCA9IGAKICAgICR7dG9wYmFyKGA8YnV0dG9uIGlkPSJsb2dpbi1ob21lIiBjbGFzcz0iYnRuIGJ0bi1saWdodCI+Vm9sdGFyPC9idXR0b24+YCl9CiAgICA8bWFpbiBjbGFzcz0iY29udGFpbmVyIG5hcnJvdyI+CiAgICAgIDxkaXYgY2xhc3M9ImNhcmQiIHN0eWxlPSJtYXJnaW4tdG9wOjQycHgiPgogICAgICAgIDxkaXYgY2xhc3M9ImV5ZWJyb3ciPsOBcmVhIGFkbWluaXN0cmF0aXZhPC9kaXY+CiAgICAgICAgPGgxPkVudHJhciBubyBwYWluZWw8L2gxPgogICAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWwgZm9yPSJsb2dpbi1lbWFpbCI+RS1tYWlsPC9sYWJlbD48aW5wdXQgaWQ9ImxvZ2luLWVtYWlsIiBjbGFzcz0iaW5wdXQiIHR5cGU9ImVtYWlsIiBhdXRvY29tcGxldGU9ImVtYWlsIj48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsIGZvcj0ibG9naW4tcGFzc3dvcmQiPlNlbmhhPC9sYWJlbD48aW5wdXQgaWQ9ImxvZ2luLXBhc3N3b3JkIiBjbGFzcz0iaW5wdXQiIHR5cGU9InBhc3N3b3JkIiBhdXRvY29tcGxldGU9ImN1cnJlbnQtcGFzc3dvcmQiPjwvZGl2PgogICAgICAgIDxidXR0b24gaWQ9ImxvZ2luLXN1Ym1pdCIgY2xhc3M9ImJ0biBidG4tcHJpbWFyeSBidG4tbGFyZ2UgYnRuLWJsb2NrIj5FbnRyYXI8L2J1dHRvbj4KICAgICAgPC9kaXY+CiAgICA8L21haW4+YDsKICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnbG9naW4taG9tZScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgcmVuZGVySG9tZSk7CiAgY29uc3Qgc3VibWl0ID0gYXN5bmMgKCkgPT4gewogICAgdHJ5IHsKICAgICAgZW5zdXJlQXVkaW8oKTsKICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgYXBpKCcvYXBpL2FkbWluL2xvZ2luJywgewogICAgICAgIGVtYWlsOiBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnbG9naW4tZW1haWwnKS52YWx1ZSwKICAgICAgICBwYXNzd29yZDogZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2xvZ2luLXBhc3N3b3JkJykudmFsdWUsCiAgICAgIH0pOwogICAgICBzdGF0ZS5hdXRoID0gcmVzdWx0OwogICAgICBzZXNzaW9uU3RvcmFnZS5zZXRJdGVtKEFVVEhfS0VZLCBKU09OLnN0cmluZ2lmeShyZXN1bHQpKTsKICAgICAgYXdhaXQgbG9hZERhc2hib2FyZCgpOwogICAgfSBjYXRjaCAoZXJyb3IpIHsgc2hvd1RvYXN0KGVycm9yLm1lc3NhZ2UpOyB9CiAgfTsKICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnbG9naW4tc3VibWl0JykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBzdWJtaXQpOwogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdsb2dpbi1wYXNzd29yZCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2tleWRvd24nLCAoZXZlbnQpID0+IHsgaWYgKGV2ZW50LmtleSA9PT0gJ0VudGVyJykgc3VibWl0KCk7IH0pOwp9Cgphc3luYyBmdW5jdGlvbiBsb2FkRGFzaGJvYXJkKCkgewogIHRyeSB7CiAgICBjb25zdCBbcXVpekRhdGEsIGFkbWluRGF0YV0gPSBhd2FpdCBQcm9taXNlLmFsbChbCiAgICAgIGFwaSgnL2FwaS9hZG1pbi9xdWl6emVzJywgeyBhdXRoVG9rZW46IHN0YXRlLmF1dGguYXV0aFRva2VuIH0pLAogICAgICBhcGkoJy9hcGkvYWRtaW4vYWRtaW5zJywgeyBhdXRoVG9rZW46IHN0YXRlLmF1dGguYXV0aFRva2VuIH0pLAogICAgXSk7CiAgICBzdGF0ZS5xdWl6emVzID0gcXVpekRhdGEucXVpenplczsKICAgIHN0YXRlLmFkbWlucyA9IGFkbWluRGF0YS5hZG1pbnM7CiAgICBzdGF0ZS5hdXRoLnBlcnNpc3RlbmNlTW9kZSA9IGFkbWluRGF0YS5wZXJzaXN0ZW5jZU1vZGU7CiAgICByZW5kZXJEYXNoYm9hcmQoKTsKICB9IGNhdGNoIChlcnJvcikgewogICAgc2hvd1RvYXN0KGVycm9yLm1lc3NhZ2UpOwogICAgc2Vzc2lvblN0b3JhZ2UucmVtb3ZlSXRlbShBVVRIX0tFWSk7CiAgICBzdGF0ZS5hdXRoID0gbnVsbDsKICAgIHJlbmRlckxvZ2luKCk7CiAgfQp9CgpmdW5jdGlvbiBkYXNoYm9hcmRTaWRlYmFyKCkgewogIGNvbnN0IGFkbWluID0gc3RhdGUuYXV0aC5hZG1pbjsKICByZXR1cm4gYAogICAgPGFzaWRlIGNsYXNzPSJzaWRlYmFyIGNhcmQiPgogICAgICA8ZGl2IGNsYXNzPSJhZG1pbi11c2VyIj4KICAgICAgICA8ZGl2IGNsYXNzPSJhZG1pbi1hdmF0YXIiPiR7ZXNjYXBlSHRtbChhZG1pbi5uYW1lLnNsaWNlKDAsMikudG9VcHBlckNhc2UoKSl9PC9kaXY+CiAgICAgICAgPGRpdj48c3Ryb25nPiR7ZXNjYXBlSHRtbChhZG1pbi5uYW1lKX08L3N0cm9uZz48c21hbGw+JHtlc2NhcGVIdG1sKGFkbWluLmVtYWlsKX08L3NtYWxsPjwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0ic2lkZWJhci1tZW51Ij4KICAgICAgICA8YnV0dG9uIGRhdGEtdGFiPSJvdmVydmlldyIgY2xhc3M9ImJ0biAke3N0YXRlLmRhc2hib2FyZFRhYiA9PT0gJ292ZXJ2aWV3JyA/ICdidG4tZGFyaycgOiAnYnRuLWxpZ2h0J30iPuKXqyBWaXPDo28gZ2VyYWw8L2J1dHRvbj4KICAgICAgICA8YnV0dG9uIGRhdGEtdGFiPSJxdWl6emVzIiBjbGFzcz0iYnRuICR7c3RhdGUuZGFzaGJvYXJkVGFiID09PSAncXVpenplcycgPyAnYnRuLWRhcmsnIDogJ2J0bi1saWdodCd9Ij7inKYgUXVpenplczwvYnV0dG9uPgogICAgICAgIDxidXR0b24gZGF0YS10YWI9ImFkbWlucyIgY2xhc3M9ImJ0biAke3N0YXRlLmRhc2hib2FyZFRhYiA9PT0gJ2FkbWlucycgPyAnYnRuLWRhcmsnIDogJ2J0bi1saWdodCd9Ij7imZkgQWRtaW5pc3RyYWRvcmVzPC9idXR0b24+CiAgICAgIDwvZGl2PgogICAgPC9hc2lkZT5gOwp9CgpmdW5jdGlvbiByZW5kZXJEYXNoYm9hcmQoKSB7CiAgY2xlYXJUaW1lcigpOwogIHN0b3BNdXNpYygpOwogIGNvbnN0IG1vZGVOb3RpY2UgPSBzdGF0ZS5hdXRoLnBlcnNpc3RlbmNlTW9kZSA9PT0gJ21lbW9yeScKICAgID8gYDxkaXYgY2xhc3M9Im5vdGljZSI+4pqg77iPIE1vZG8gdGVtcG9yw6FyaW86IG5vdm9zIGFkbWluaXN0cmFkb3JlcyBlIHF1aXp6ZXMgc2Vyw6NvIHBlcmRpZG9zIHNlIG8gUmVuZGVyIHJlaW5pY2lhci4gQ29uZWN0ZSB1bSBQb3N0Z3JlU1FMIHVzYW5kbyBEQVRBQkFTRV9VUkwgcGFyYSBzYWx2YXIgcGVybWFuZW50ZW1lbnRlLjwvZGl2PmAKICAgIDogYDxkaXYgY2xhc3M9Im5vdGljZSBzdWNjZXNzIj7inJMgQmFuY28gZGUgZGFkb3MgY29uZWN0YWRvLiBBZG1pbmlzdHJhZG9yZXMsIHF1aXp6ZXMgZSByZXN1bHRhZG9zIHPDo28gcGVyc2lzdGVudGVzLjwvZGl2PmA7CgogIGFwcC5pbm5lckhUTUwgPSBgCiAgICAke3RvcGJhcihgPGJ1dHRvbiBpZD0ibG9nb3V0IiBjbGFzcz0iYnRuIGJ0bi1saWdodCI+U2FpcjwvYnV0dG9uPmApfQogICAgPG1haW4gY2xhc3M9ImNvbnRhaW5lciI+CiAgICAgICR7bW9kZU5vdGljZX0KICAgICAgPGRpdiBjbGFzcz0iZGFzaGJvYXJkIj4KICAgICAgICAke2Rhc2hib2FyZFNpZGViYXIoKX0KICAgICAgICA8c2VjdGlvbiBpZD0iZGFzaGJvYXJkLWNvbnRlbnQiPiR7ZGFzaGJvYXJkQ29udGVudCgpfTwvc2VjdGlvbj4KICAgICAgPC9kaXY+CiAgICA8L21haW4+YDsKCiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2xvZ291dCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gewogICAgc2Vzc2lvblN0b3JhZ2UucmVtb3ZlSXRlbShBVVRIX0tFWSk7CiAgICBzdGF0ZS5hdXRoID0gbnVsbDsKICAgIHJlbmRlckhvbWUoKTsKICB9KTsKICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS10YWJdJykuZm9yRWFjaCgoYnV0dG9uKSA9PiBidXR0b24uYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7CiAgICBzdGF0ZS5kYXNoYm9hcmRUYWIgPSBidXR0b24uZGF0YXNldC50YWI7CiAgICBzdGF0ZS5lZGl0b3IgPSBudWxsOwogICAgc3RhdGUuc3RhcnRRdWl6SWQgPSBudWxsOwogICAgcmVuZGVyRGFzaGJvYXJkKCk7CiAgfSkpOwogIGJpbmREYXNoYm9hcmRDb250ZW50KCk7Cn0KCmZ1bmN0aW9uIGRhc2hib2FyZENvbnRlbnQoKSB7CiAgaWYgKHN0YXRlLmRhc2hib2FyZFRhYiA9PT0gJ3F1aXp6ZXMnKSByZXR1cm4gcmVuZGVyUXVpenplc1RhYigpOwogIGlmIChzdGF0ZS5kYXNoYm9hcmRUYWIgPT09ICdhZG1pbnMnKSByZXR1cm4gcmVuZGVyQWRtaW5zVGFiKCk7CiAgcmV0dXJuIHJlbmRlck92ZXJ2aWV3VGFiKCk7Cn0KCmZ1bmN0aW9uIHJlbmRlck92ZXJ2aWV3VGFiKCkgewogIGNvbnN0IHN0YXJ0UGFuZWwgPSBzdGF0ZS5zdGFydFF1aXpJZCA/IHJlbmRlclN0YXJ0UGFuZWwoKSA6ICcnOwogIHJldHVybiBgCiAgICA8ZGl2IGNsYXNzPSJzZWN0aW9uLXRpdGxlIj48ZGl2PjxkaXYgY2xhc3M9ImV5ZWJyb3ciPlBhaW5lbCBhbyB2aXZvPC9kaXY+PGgxPk9sw6EsICR7ZXNjYXBlSHRtbChzdGF0ZS5hdXRoLmFkbWluLm5hbWUuc3BsaXQoJyAnKVswXSl9PC9oMT48L2Rpdj48YnV0dG9uIGlkPSJuZXctcXVpei1vdmVydmlldyIgY2xhc3M9ImJ0biBidG4tcHJpbWFyeSI+KyBDcmlhciBxdWl6PC9idXR0b24+PC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJncmlkLTQiIHN0eWxlPSJtYXJnaW4tYm90dG9tOjIycHgiPgogICAgICA8ZGl2IGNsYXNzPSJtZXRyaWMiPjxzcGFuPlF1aXp6ZXM8L3NwYW4+PHN0cm9uZz4ke3N0YXRlLnF1aXp6ZXMubGVuZ3RofTwvc3Ryb25nPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJtZXRyaWMiPjxzcGFuPkFkbWluaXN0cmFkb3Jlczwvc3Bhbj48c3Ryb25nPiR7c3RhdGUuYWRtaW5zLmZpbHRlcigoYSkgPT4gYS5hY3RpdmUpLmxlbmd0aH08L3N0cm9uZz48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0ibWV0cmljIj48c3Bhbj5MaW1pdGUgcG9yIHNhbGE8L3NwYW4+PHN0cm9uZz4ke3N0YXRlLmNvbmZpZy5tYXhQYXJ0aWNpcGFudHN9PC9zdHJvbmc+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9Im1ldHJpYyI+PHNwYW4+QmFuY288L3NwYW4+PHN0cm9uZyBzdHlsZT0iZm9udC1zaXplOjIwcHgiPiR7c3RhdGUuYXV0aC5wZXJzaXN0ZW5jZU1vZGUgPT09ICdwb3N0Z3JlcycgPyAnQ29uZWN0YWRvJyA6ICdUZW1wb3LDoXJpbyd9PC9zdHJvbmc+PC9kaXY+CiAgICA8L2Rpdj4KICAgICR7c3RhcnRQYW5lbH0KICAgIDxkaXYgY2xhc3M9InNlY3Rpb24tdGl0bGUiPjxoMj5Fc2NvbGhhIHVtIHF1aXogcGFyYSBhcHJlc2VudGFyPC9oMj48L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImdyaWQtMyI+JHtzdGF0ZS5xdWl6emVzLm1hcChxdWl6Q2FyZCkuam9pbignJykgfHwgJzxkaXYgY2xhc3M9ImVtcHR5Ij5OZW5odW0gcXVpeiBjYWRhc3RyYWRvLjwvZGl2Pid9PC9kaXY+YDsKfQoKZnVuY3Rpb24gcXVpekNhcmQocXVpeikgewogIGNvbnN0IG11c2ljID0gc3RhdGUuY29uZmlnLm11c2ljVGhlbWVzLmZpbmQoKGl0ZW0pID0+IGl0ZW0uaWQgPT09IHF1aXoubXVzaWNUaGVtZSk/Lm5hbWUgfHwgJ1NlbSBtw7pzaWNhJzsKICByZXR1cm4gYDxhcnRpY2xlIGNsYXNzPSJjYXJkIGludGVyYWN0aXZlIHF1aXotY2FyZCI+CiAgICA8ZGl2PjxkaXYgY2xhc3M9ImV5ZWJyb3ciPiR7ZXNjYXBlSHRtbChxdWl6Lm93bmVyTmFtZSB8fCAnU2lzdGVtYScpfTwvZGl2PjxoMz4ke2VzY2FwZUh0bWwocXVpei50aXRsZSl9PC9oMz48cCBjbGFzcz0ibXV0ZWQiPiR7ZXNjYXBlSHRtbChxdWl6LmRlc2NyaXB0aW9uIHx8ICdTZW0gZGVzY3Jpw6fDo28nKX08L3A+PC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJxdWl6LW1ldGEiPjxzcGFuIGNsYXNzPSJjaGlwIj7inZMgJHtxdWl6LnF1ZXN0aW9ucy5sZW5ndGh9IHF1ZXN0w7Vlczwvc3Bhbj48c3BhbiBjbGFzcz0iY2hpcCI+4pmrICR7ZXNjYXBlSHRtbChtdXNpYyl9PC9zcGFuPjwvZGl2PgogICAgPGRpdiBjbGFzcz0icXVpei1hY3Rpb25zIj4KICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIGJ0bi1wcmltYXJ5IiBkYXRhLXN0YXJ0LXF1aXo9IiR7ZXNjYXBlSHRtbChxdWl6LmlkKX0iPuKWtiBJbmljaWFyIGFvIHZpdm88L2J1dHRvbj4KICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIGJ0bi1saWdodCIgZGF0YS1lZGl0LXF1aXo9IiR7ZXNjYXBlSHRtbChxdWl6LmlkKX0iPkVkaXRhcjwvYnV0dG9uPgogICAgPC9kaXY+CiAgPC9hcnRpY2xlPmA7Cn0KCmZ1bmN0aW9uIHJlbmRlclN0YXJ0UGFuZWwoKSB7CiAgY29uc3QgcXVpeiA9IHN0YXRlLnF1aXp6ZXMuZmluZCgoaXRlbSkgPT4gaXRlbS5pZCA9PT0gc3RhdGUuc3RhcnRRdWl6SWQpOwogIGlmICghcXVpeikgcmV0dXJuICcnOwogIHJldHVybiBgPGRpdiBjbGFzcz0iY2FyZCBncmFkaWVudCIgc3R5bGU9Im1hcmdpbi1ib3R0b206MjJweCI+CiAgICA8ZGl2IGNsYXNzPSJzZWN0aW9uLXRpdGxlIj48ZGl2PjxkaXYgY2xhc3M9ImV5ZWJyb3ciIHN0eWxlPSJiYWNrZ3JvdW5kOnJnYmEoMjU1LDI1NSwyNTUsLjE2KTtjb2xvcjp3aGl0ZSI+UHJlcGFyYXIgc2FsYTwvZGl2PjxoMj4ke2VzY2FwZUh0bWwocXVpei50aXRsZSl9PC9oMj48L2Rpdj48YnV0dG9uIGlkPSJjbG9zZS1zdGFydC1wYW5lbCIgY2xhc3M9ImJ0biBidG4tbGlnaHQiPkNhbmNlbGFyPC9idXR0b24+PC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJncmlkLTIiPgogICAgICA8ZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+UHLDqm1pbyBkbyAxwrogbHVnYXI8L2xhYmVsPjxpbnB1dCBpZD0icHJpemUtZmlyc3QiIGNsYXNzPSJpbnB1dCIgdmFsdWU9IlZhbGUtcHJlc2VudGUgZGUgUiQgMjAwIj48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPlByw6ptaW8gZG8gMsK6IGx1Z2FyPC9sYWJlbD48aW5wdXQgaWQ9InByaXplLXNlY29uZCIgY2xhc3M9ImlucHV0IiB2YWx1ZT0iVmFsZS1wcmVzZW50ZSBkZSBSJCAxMDAiPjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+UHLDqm1pbyBkbyAzwrogbHVnYXI8L2xhYmVsPjxpbnB1dCBpZD0icHJpemUtdGhpcmQiIGNsYXNzPSJpbnB1dCIgdmFsdWU9IlZhbGUtcHJlc2VudGUgZGUgUiQgNTAiPjwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPGRpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPk3DunNpY2EgZG8gcXVpejwvbGFiZWw+PHNlbGVjdCBpZD0icm9vbS1tdXNpYyIgY2xhc3M9InNlbGVjdCI+JHtzdGF0ZS5jb25maWcubXVzaWNUaGVtZXMubWFwKCh0aGVtZSkgPT4gYDxvcHRpb24gdmFsdWU9IiR7dGhlbWUuaWR9IiAke3RoZW1lLmlkID09PSBxdWl6Lm11c2ljVGhlbWUgPyAnc2VsZWN0ZWQnIDogJyd9PiR7ZXNjYXBlSHRtbCh0aGVtZS5uYW1lKX0g4oCUICR7ZXNjYXBlSHRtbCh0aGVtZS5kZXNjcmlwdGlvbil9PC9vcHRpb24+YCkuam9pbignJyl9PC9zZWxlY3Q+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0ibm90aWNlIGluZm8iPkFvIGNsaWNhciBlbSBpbmljaWFyLCB2b2PDqiBzZXLDoSBkaXJlY2lvbmFkbyBwYXJhIGEgdGVsYSBkZSBhcHJlc2VudGHDp8Ojbywgb25kZSBjb250cm9sYXLDoSB0b2RhcyBhcyBldGFwYXMuPC9kaXY+CiAgICAgICAgPGJ1dHRvbiBpZD0iY3JlYXRlLWxpdmUtcm9vbSIgY2xhc3M9ImJ0biBidG4tZGFyayBidG4tbGFyZ2UgYnRuLWJsb2NrIj5DcmlhciBzYWxhIGUgYWJyaXIgYXByZXNlbnRhw6fDo288L2J1dHRvbj4KICAgICAgPC9kaXY+CiAgICA8L2Rpdj4KICA8L2Rpdj5gOwp9CgpmdW5jdGlvbiByZW5kZXJRdWl6emVzVGFiKCkgewogIGlmIChzdGF0ZS5lZGl0b3IpIHJldHVybiByZW5kZXJRdWl6RWRpdG9yKCk7CiAgcmV0dXJuIGAKICAgIDxkaXYgY2xhc3M9InNlY3Rpb24tdGl0bGUiPjxkaXY+PGRpdiBjbGFzcz0iZXllYnJvdyI+QmlibGlvdGVjYTwvZGl2PjxoMT5NZXVzIHF1aXp6ZXM8L2gxPjwvZGl2PjxidXR0b24gaWQ9Im5ldy1xdWl6IiBjbGFzcz0iYnRuIGJ0bi1wcmltYXJ5Ij4rIE5vdm8gcXVpejwvYnV0dG9uPjwvZGl2PgogICAgPGRpdiBjbGFzcz0iZ3JpZC0zIj4ke3N0YXRlLnF1aXp6ZXMubWFwKChxdWl6KSA9PiBgJHtxdWl6Q2FyZChxdWl6KX08ZGl2IGNsYXNzPSJoaWRkZW4iPjxidXR0b24gZGF0YS1kZWxldGUtcXVpej0iJHtlc2NhcGVIdG1sKHF1aXouaWQpfSI+PC9idXR0b24+PC9kaXY+YCkuam9pbignJyl9PC9kaXY+YDsKfQoKZnVuY3Rpb24gYmxhbmtRdWVzdGlvbigpIHsKICByZXR1cm4geyBpZDogcmFuZG9tSWQoJ3F1ZXN0aW9uJyksIHRleHQ6ICcnLCBvcHRpb25zOiBbJycsICcnLCAnJywgJyddLCBjb3JyZWN0SW5kZXg6IDAsIHRpbWVMaW1pdDogMjAsIGV4cGxhbmF0aW9uOiAnJyB9Owp9CgpmdW5jdGlvbiByZW5kZXJRdWl6RWRpdG9yKCkgewogIGNvbnN0IHF1aXogPSBzdGF0ZS5lZGl0b3I7CiAgcmV0dXJuIGAKICAgIDxkaXYgY2xhc3M9InNlY3Rpb24tdGl0bGUiPjxkaXY+PGRpdiBjbGFzcz0iZXllYnJvdyI+RWRpdG9yIGRlIHF1aXo8L2Rpdj48aDE+JHtxdWl6LmlzTmV3ID8gJ05vdm8gcXVpeicgOiAnRWRpdGFyIHF1aXonfTwvaDE+PC9kaXY+PGJ1dHRvbiBpZD0iY2FuY2VsLWVkaXRvciIgY2xhc3M9ImJ0biBidG4tbGlnaHQiPkNhbmNlbGFyPC9idXR0b24+PC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJjYXJkIj4KICAgICAgPGRpdiBjbGFzcz0iZ3JpZC0yIj4KICAgICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPlTDrXR1bG8gZG8gcXVpejwvbGFiZWw+PGlucHV0IGlkPSJxdWl6LXRpdGxlIiBjbGFzcz0iaW5wdXQiIHZhbHVlPSIke2VzY2FwZUh0bWwocXVpei50aXRsZSl9IiBtYXhsZW5ndGg9IjE0MCI+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5Nw7pzaWNhIHByaW5jaXBhbDwvbGFiZWw+PHNlbGVjdCBpZD0icXVpei1tdXNpYyIgY2xhc3M9InNlbGVjdCI+JHtzdGF0ZS5jb25maWcubXVzaWNUaGVtZXMubWFwKCh0aGVtZSkgPT4gYDxvcHRpb24gdmFsdWU9IiR7dGhlbWUuaWR9IiAke3RoZW1lLmlkID09PSBxdWl6Lm11c2ljVGhlbWUgPyAnc2VsZWN0ZWQnIDogJyd9PiR7ZXNjYXBlSHRtbCh0aGVtZS5uYW1lKX08L29wdGlvbj5gKS5qb2luKCcnKX08L3NlbGVjdD48L2Rpdj4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+RGVzY3Jpw6fDo288L2xhYmVsPjx0ZXh0YXJlYSBpZD0icXVpei1kZXNjcmlwdGlvbiIgY2xhc3M9InRleHRhcmVhIj4ke2VzY2FwZUh0bWwocXVpei5kZXNjcmlwdGlvbil9PC90ZXh0YXJlYT48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0ic2VjdGlvbi10aXRsZSI+PGgyPlF1ZXN0w7VlczwvaDI+PHNwYW4gY2xhc3M9ImNoaXAiPkFsdGVybmF0aXZhcyB2YXppYXMgbsOjbyBzZXLDo28gZXhpYmlkYXM8L3NwYW4+PC9kaXY+CiAgICAgIDxkaXYgaWQ9InF1ZXN0aW9ucy1lZGl0b3IiPiR7cXVpei5xdWVzdGlvbnMubWFwKChxdWVzdGlvbiwgaW5kZXgpID0+IHJlbmRlclF1ZXN0aW9uRWRpdG9yKHF1ZXN0aW9uLCBpbmRleCkpLmpvaW4oJycpfTwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJidWlsZGVyLWFjdGlvbnMiPjxidXR0b24gaWQ9ImFkZC1xdWVzdGlvbiIgY2xhc3M9ImJ0biBidG4tbGlnaHQiPisgQWRpY2lvbmFyIHF1ZXN0w6NvPC9idXR0b24+PGJ1dHRvbiBpZD0ic2F2ZS1xdWl6IiBjbGFzcz0iYnRuIGJ0bi1wcmltYXJ5IGJ0bi1sYXJnZSI+U2FsdmFyIHF1aXo8L2J1dHRvbj48L2Rpdj4KICAgIDwvZGl2PmA7Cn0KCmZ1bmN0aW9uIHJlbmRlclF1ZXN0aW9uRWRpdG9yKHF1ZXN0aW9uLCBpbmRleCkgewogIGNvbnN0IG9wdGlvbnMgPSBbLi4ucXVlc3Rpb24ub3B0aW9uc107CiAgd2hpbGUgKG9wdGlvbnMubGVuZ3RoIDwgNikgb3B0aW9ucy5wdXNoKCcnKTsKICByZXR1cm4gYDxkaXYgY2xhc3M9ImJ1aWxkZXItcXVlc3Rpb24iIGRhdGEtcXVlc3Rpb249IiR7aW5kZXh9Ij4KICAgIDxkaXYgY2xhc3M9ImJ1aWxkZXItaGVhZCI+PGgzPlF1ZXN0w6NvICR7aW5kZXggKyAxfTwvaDM+PGJ1dHRvbiBjbGFzcz0iYnRuIGJ0bi1kYW5nZXIiIGRhdGEtcmVtb3ZlLXF1ZXN0aW9uPSIke2luZGV4fSIgJHtzdGF0ZS5lZGl0b3IucXVlc3Rpb25zLmxlbmd0aCA8PSAxID8gJ2Rpc2FibGVkJyA6ICcnfT5FeGNsdWlyPC9idXR0b24+PC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPkVudW5jaWFkbzwvbGFiZWw+PHRleHRhcmVhIGNsYXNzPSJ0ZXh0YXJlYSBxdWVzdGlvbi10ZXh0IiBkYXRhLWluZGV4PSIke2luZGV4fSI+JHtlc2NhcGVIdG1sKHF1ZXN0aW9uLnRleHQpfTwvdGV4dGFyZWE+PC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJncmlkLTIiPjxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+VGVtcG88L2xhYmVsPjxzZWxlY3QgY2xhc3M9InNlbGVjdCBxdWVzdGlvbi10aW1lIiBkYXRhLWluZGV4PSIke2luZGV4fSI+JHtbMTAsMTUsMjAsMzAsNDUsNjAsOTAsMTIwXS5tYXAoKHRpbWUpID0+IGA8b3B0aW9uIHZhbHVlPSIke3RpbWV9IiAke3RpbWUgPT09IE51bWJlcihxdWVzdGlvbi50aW1lTGltaXQpID8gJ3NlbGVjdGVkJyA6ICcnfT4ke3RpbWV9IHNlZ3VuZG9zPC9vcHRpb24+YCkuam9pbignJyl9PC9zZWxlY3Q+PC9kaXY+PGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5FeHBsaWNhw6fDo28gZGEgcmVzcG9zdGE8L2xhYmVsPjxpbnB1dCBjbGFzcz0iaW5wdXQgcXVlc3Rpb24tZXhwbGFuYXRpb24iIGRhdGEtaW5kZXg9IiR7aW5kZXh9IiB2YWx1ZT0iJHtlc2NhcGVIdG1sKHF1ZXN0aW9uLmV4cGxhbmF0aW9uIHx8ICcnKX0iPjwvZGl2PjwvZGl2PgogICAgPGxhYmVsIHN0eWxlPSJmb250LXdlaWdodDo4MDA7ZGlzcGxheTpibG9jazttYXJnaW4tYm90dG9tOjEwcHgiPkFsdGVybmF0aXZhcyDigJQgbWFycXVlIGEgY29ycmV0YTwvbGFiZWw+CiAgICAke29wdGlvbnMubWFwKChvcHRpb24sIG9wdGlvbkluZGV4KSA9PiBgPGRpdiBjbGFzcz0ib3B0aW9uLXJvdyI+PGlucHV0IHR5cGU9InJhZGlvIiBuYW1lPSJjb3JyZWN0LSR7aW5kZXh9IiBjbGFzcz0iY29ycmVjdC1vcHRpb24iIGRhdGEtcXVlc3Rpb24taW5kZXg9IiR7aW5kZXh9IiB2YWx1ZT0iJHtvcHRpb25JbmRleH0iICR7TnVtYmVyKHF1ZXN0aW9uLmNvcnJlY3RJbmRleCkgPT09IG9wdGlvbkluZGV4ID8gJ2NoZWNrZWQnIDogJyd9PjxpbnB1dCBjbGFzcz0iaW5wdXQgb3B0aW9uLWlucHV0IiBkYXRhLXF1ZXN0aW9uLWluZGV4PSIke2luZGV4fSIgZGF0YS1vcHRpb24taW5kZXg9IiR7b3B0aW9uSW5kZXh9IiB2YWx1ZT0iJHtlc2NhcGVIdG1sKG9wdGlvbil9IiBwbGFjZWhvbGRlcj0iQWx0ZXJuYXRpdmEgJHtvcHRpb25JbmRleCArIDF9ICR7b3B0aW9uSW5kZXggPiAxID8gJyhvcGNpb25hbCknIDogJyd9Ij48L2Rpdj5gKS5qb2luKCcnKX0KICA8L2Rpdj5gOwp9CgpmdW5jdGlvbiByZW5kZXJBZG1pbnNUYWIoKSB7CiAgcmV0dXJuIGAKICAgIDxkaXYgY2xhc3M9InNlY3Rpb24tdGl0bGUiPjxkaXY+PGRpdiBjbGFzcz0iZXllYnJvdyI+QWNlc3NvczwvZGl2PjxoMT5BZG1pbmlzdHJhZG9yZXM8L2gxPjwvZGl2PjwvZGl2PgogICAgPGRpdiBjbGFzcz0iZ3JpZC0yIj4KICAgICAgPGRpdiBjbGFzcz0iY2FyZCI+CiAgICAgICAgPGgyPkNyaWFyIG5vdm8gYWRtaW5pc3RyYWRvcjwvaDI+CiAgICAgICAgPHAgY2xhc3M9Im11dGVkIj5PIG5vdm8gdXN1w6FyaW8gcG9kZXLDoSBlbnRyYXIgbm8gcGFpbmVsIGUgY3JpYXIgb3MgcHLDs3ByaW9zIHF1aXp6ZXMuPC9wPgogICAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+Tm9tZTwvbGFiZWw+PGlucHV0IGlkPSJuZXctYWRtaW4tbmFtZSIgY2xhc3M9ImlucHV0Ij48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPkUtbWFpbDwvbGFiZWw+PGlucHV0IGlkPSJuZXctYWRtaW4tZW1haWwiIGNsYXNzPSJpbnB1dCIgdHlwZT0iZW1haWwiPjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+U2VuaGEgaW5pY2lhbDwvbGFiZWw+PGlucHV0IGlkPSJuZXctYWRtaW4tcGFzc3dvcmQiIGNsYXNzPSJpbnB1dCIgdHlwZT0icGFzc3dvcmQiIG1pbmxlbmd0aD0iOCI+PHNtYWxsPk3DrW5pbW8gZGUgb2l0byBjYXJhY3RlcmVzLjwvc21hbGw+PC9kaXY+CiAgICAgICAgPGJ1dHRvbiBpZD0iY3JlYXRlLWFkbWluIiBjbGFzcz0iYnRuIGJ0bi1wcmltYXJ5IGJ0bi1ibG9jayI+Q3JpYXIgYWNlc3NvPC9idXR0b24+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJjYXJkIj4KICAgICAgICA8aDI+QWNlc3NvcyBjYWRhc3RyYWRvczwvaDI+CiAgICAgICAgPGRpdiBzdHlsZT0iZGlzcGxheTpncmlkO2dhcDoxMHB4Ij4ke3N0YXRlLmFkbWlucy5tYXAoKGFkbWluKSA9PiBgPGRpdiBjbGFzcz0iY2FyZCBzb2Z0IiBzdHlsZT0icGFkZGluZzoxNHB4Ij48ZGl2IGNsYXNzPSJyb3cgc3BhY2UtYmV0d2VlbiI+PGRpdj48c3Ryb25nPiR7ZXNjYXBlSHRtbChhZG1pbi5uYW1lKX08L3N0cm9uZz48ZGl2IGNsYXNzPSJtdXRlZCI+JHtlc2NhcGVIdG1sKGFkbWluLmVtYWlsKX0gwrcgJHthZG1pbi5yb2xlID09PSAnb3duZXInID8gJ1ByaW5jaXBhbCcgOiAnQWRtaW5pc3RyYWRvcid9PC9kaXY+PC9kaXY+JHtzdGF0ZS5hdXRoLmFkbWluLnJvbGUgPT09ICdvd25lcicgJiYgYWRtaW4uaWQgIT09IHN0YXRlLmF1dGguYWRtaW4uaWQgPyBgPGJ1dHRvbiBjbGFzcz0iYnRuICR7YWRtaW4uYWN0aXZlID8gJ2J0bi1kYW5nZXInIDogJ2J0bi1zdWNjZXNzJ30iIGRhdGEtdG9nZ2xlLWFkbWluPSIke2FkbWluLmlkfSIgZGF0YS1hY3RpdmU9IiR7YWRtaW4uYWN0aXZlID8gJzAnIDogJzEnfSI+JHthZG1pbi5hY3RpdmUgPyAnQmxvcXVlYXInIDogJ0F0aXZhcid9PC9idXR0b24+YCA6IGA8c3BhbiBjbGFzcz0iY2hpcCI+JHthZG1pbi5hY3RpdmUgPyAnQXRpdm8nIDogJ0Jsb3F1ZWFkbyd9PC9zcGFuPmB9PC9kaXY+PC9kaXY+YCkuam9pbignJyl9PC9kaXY+CiAgICAgIDwvZGl2PgogICAgPC9kaXY+YDsKfQoKZnVuY3Rpb24gYmluZERhc2hib2FyZENvbnRlbnQoKSB7CiAgY29uc3QgbmV3UXVpekJ1dHRvbnMgPSBbZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ25ldy1xdWl6JyksIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCduZXctcXVpei1vdmVydmlldycpXS5maWx0ZXIoQm9vbGVhbik7CiAgbmV3UXVpekJ1dHRvbnMuZm9yRWFjaCgoYnV0dG9uKSA9PiBidXR0b24uYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7CiAgICBzdGF0ZS5kYXNoYm9hcmRUYWIgPSAncXVpenplcyc7CiAgICBzdGF0ZS5lZGl0b3IgPSB7IGlkOiByYW5kb21JZCgncXVpeicpLCB0aXRsZTogJycsIGRlc2NyaXB0aW9uOiAnJywgbXVzaWNUaGVtZTogJ3B1bHNlJywgcXVlc3Rpb25zOiBbYmxhbmtRdWVzdGlvbigpXSwgaXNOZXc6IHRydWUgfTsKICAgIHJlbmRlckRhc2hib2FyZCgpOwogIH0pKTsKCiAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtc3RhcnQtcXVpel0nKS5mb3JFYWNoKChidXR0b24pID0+IGJ1dHRvbi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHsKICAgIHN0YXRlLnN0YXJ0UXVpeklkID0gYnV0dG9uLmRhdGFzZXQuc3RhcnRRdWl6OwogICAgc3RhdGUuZGFzaGJvYXJkVGFiID0gJ292ZXJ2aWV3JzsKICAgIHJlbmRlckRhc2hib2FyZCgpOwogIH0pKTsKICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS1lZGl0LXF1aXpdJykuZm9yRWFjaCgoYnV0dG9uKSA9PiBidXR0b24uYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7CiAgICBjb25zdCBxdWl6ID0gc3RhdGUucXVpenplcy5maW5kKChpdGVtKSA9PiBpdGVtLmlkID09PSBidXR0b24uZGF0YXNldC5lZGl0UXVpeik7CiAgICBzdGF0ZS5kYXNoYm9hcmRUYWIgPSAncXVpenplcyc7CiAgICBzdGF0ZS5lZGl0b3IgPSB7IC4uLkpTT04ucGFyc2UoSlNPTi5zdHJpbmdpZnkocXVpeikpLCBpc05ldzogZmFsc2UgfTsKICAgIHJlbmRlckRhc2hib2FyZCgpOwogIH0pKTsKCiAgY29uc3QgY2xvc2VTdGFydCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdjbG9zZS1zdGFydC1wYW5lbCcpOwogIGlmIChjbG9zZVN0YXJ0KSBjbG9zZVN0YXJ0LmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4geyBzdGF0ZS5zdGFydFF1aXpJZCA9IG51bGw7IHJlbmRlckRhc2hib2FyZCgpOyB9KTsKICBjb25zdCBjcmVhdGVSb29tID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2NyZWF0ZS1saXZlLXJvb20nKTsKICBpZiAoY3JlYXRlUm9vbSkgY3JlYXRlUm9vbS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIGFzeW5jICgpID0+IHsKICAgIHRyeSB7CiAgICAgIGVuc3VyZUF1ZGlvKCk7CiAgICAgIGNyZWF0ZVJvb20uZGlzYWJsZWQgPSB0cnVlOwogICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBhcGkoJy9hcGkvYWRtaW4vY3JlYXRlLXJvb20nLCB7CiAgICAgICAgYXV0aFRva2VuOiBzdGF0ZS5hdXRoLmF1dGhUb2tlbiwKICAgICAgICBxdWl6SWQ6IHN0YXRlLnN0YXJ0UXVpeklkLAogICAgICAgIG11c2ljVGhlbWU6IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdyb29tLW11c2ljJykudmFsdWUsCiAgICAgICAgcHJpemVzOiB7CiAgICAgICAgICBmaXJzdDogZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3ByaXplLWZpcnN0JykudmFsdWUsCiAgICAgICAgICBzZWNvbmQ6IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdwcml6ZS1zZWNvbmQnKS52YWx1ZSwKICAgICAgICAgIHRoaXJkOiBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgncHJpemUtdGhpcmQnKS52YWx1ZSwKICAgICAgICB9LAogICAgICB9KTsKICAgICAgY29uc3QgY3JlZHMgPSB7IHJvb21Db2RlOiByZXN1bHQucm9vbUNvZGUsIGFkbWluVG9rZW46IHJlc3VsdC5hZG1pblRva2VuIH07CiAgICAgIHNlc3Npb25TdG9yYWdlLnNldEl0ZW0oUFJFU0VOVEVSX0tFWShyZXN1bHQucm9vbUNvZGUpLCBKU09OLnN0cmluZ2lmeShjcmVkcykpOwogICAgICBsb2NhdGlvbi5ocmVmID0gYC8/cHJlc2VudGVyPSR7ZW5jb2RlVVJJQ29tcG9uZW50KHJlc3VsdC5yb29tQ29kZSl9YDsKICAgIH0gY2F0Y2ggKGVycm9yKSB7CiAgICAgIGNyZWF0ZVJvb20uZGlzYWJsZWQgPSBmYWxzZTsKICAgICAgc2hvd1RvYXN0KGVycm9yLm1lc3NhZ2UpOwogICAgfQogIH0pOwoKICBpZiAoc3RhdGUuZWRpdG9yKSBiaW5kUXVpekVkaXRvcigpOwoKICBjb25zdCBjcmVhdGVBZG1pbiA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdjcmVhdGUtYWRtaW4nKTsKICBpZiAoY3JlYXRlQWRtaW4pIGNyZWF0ZUFkbWluLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgYXN5bmMgKCkgPT4gewogICAgdHJ5IHsKICAgICAgY3JlYXRlQWRtaW4uZGlzYWJsZWQgPSB0cnVlOwogICAgICBhd2FpdCBhcGkoJy9hcGkvYWRtaW4vY3JlYXRlLWFkbWluJywgewogICAgICAgIGF1dGhUb2tlbjogc3RhdGUuYXV0aC5hdXRoVG9rZW4sCiAgICAgICAgbmFtZTogZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ25ldy1hZG1pbi1uYW1lJykudmFsdWUsCiAgICAgICAgZW1haWw6IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCduZXctYWRtaW4tZW1haWwnKS52YWx1ZSwKICAgICAgICBwYXNzd29yZDogZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ25ldy1hZG1pbi1wYXNzd29yZCcpLnZhbHVlLAogICAgICB9KTsKICAgICAgc2hvd1RvYXN0KCdBZG1pbmlzdHJhZG9yIGNyaWFkby4nKTsKICAgICAgYXdhaXQgbG9hZERhc2hib2FyZCgpOwogICAgfSBjYXRjaCAoZXJyb3IpIHsKICAgICAgY3JlYXRlQWRtaW4uZGlzYWJsZWQgPSBmYWxzZTsKICAgICAgc2hvd1RvYXN0KGVycm9yLm1lc3NhZ2UpOwogICAgfQogIH0pOwogIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLXRvZ2dsZS1hZG1pbl0nKS5mb3JFYWNoKChidXR0b24pID0+IGJ1dHRvbi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIGFzeW5jICgpID0+IHsKICAgIHRyeSB7CiAgICAgIGF3YWl0IGFwaSgnL2FwaS9hZG1pbi90b2dnbGUtYWRtaW4nLCB7IGF1dGhUb2tlbjogc3RhdGUuYXV0aC5hdXRoVG9rZW4sIGFkbWluSWQ6IGJ1dHRvbi5kYXRhc2V0LnRvZ2dsZUFkbWluLCBhY3RpdmU6IGJ1dHRvbi5kYXRhc2V0LmFjdGl2ZSA9PT0gJzEnIH0pOwogICAgICBhd2FpdCBsb2FkRGFzaGJvYXJkKCk7CiAgICB9IGNhdGNoIChlcnJvcikgeyBzaG93VG9hc3QoZXJyb3IubWVzc2FnZSk7IH0KICB9KSk7Cn0KCmZ1bmN0aW9uIGJpbmRRdWl6RWRpdG9yKCkgewogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdjYW5jZWwtZWRpdG9yJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7IHN0YXRlLmVkaXRvciA9IG51bGw7IHJlbmRlckRhc2hib2FyZCgpOyB9KTsKICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgncXVpei10aXRsZScpLmFkZEV2ZW50TGlzdGVuZXIoJ2lucHV0JywgKGV2ZW50KSA9PiBzdGF0ZS5lZGl0b3IudGl0bGUgPSBldmVudC50YXJnZXQudmFsdWUpOwogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdxdWl6LWRlc2NyaXB0aW9uJykuYWRkRXZlbnRMaXN0ZW5lcignaW5wdXQnLCAoZXZlbnQpID0+IHN0YXRlLmVkaXRvci5kZXNjcmlwdGlvbiA9IGV2ZW50LnRhcmdldC52YWx1ZSk7CiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3F1aXotbXVzaWMnKS5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCAoZXZlbnQpID0+IHN0YXRlLmVkaXRvci5tdXNpY1RoZW1lID0gZXZlbnQudGFyZ2V0LnZhbHVlKTsKICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcucXVlc3Rpb24tdGV4dCcpLmZvckVhY2goKGlucHV0KSA9PiBpbnB1dC5hZGRFdmVudExpc3RlbmVyKCdpbnB1dCcsICgpID0+IHN0YXRlLmVkaXRvci5xdWVzdGlvbnNbTnVtYmVyKGlucHV0LmRhdGFzZXQuaW5kZXgpXS50ZXh0ID0gaW5wdXQudmFsdWUpKTsKICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcucXVlc3Rpb24tdGltZScpLmZvckVhY2goKGlucHV0KSA9PiBpbnB1dC5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCAoKSA9PiBzdGF0ZS5lZGl0b3IucXVlc3Rpb25zW051bWJlcihpbnB1dC5kYXRhc2V0LmluZGV4KV0udGltZUxpbWl0ID0gTnVtYmVyKGlucHV0LnZhbHVlKSkpOwogIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5xdWVzdGlvbi1leHBsYW5hdGlvbicpLmZvckVhY2goKGlucHV0KSA9PiBpbnB1dC5hZGRFdmVudExpc3RlbmVyKCdpbnB1dCcsICgpID0+IHN0YXRlLmVkaXRvci5xdWVzdGlvbnNbTnVtYmVyKGlucHV0LmRhdGFzZXQuaW5kZXgpXS5leHBsYW5hdGlvbiA9IGlucHV0LnZhbHVlKSk7CiAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLm9wdGlvbi1pbnB1dCcpLmZvckVhY2goKGlucHV0KSA9PiBpbnB1dC5hZGRFdmVudExpc3RlbmVyKCdpbnB1dCcsICgpID0+IHsKICAgIGNvbnN0IHF1ZXN0aW9uID0gc3RhdGUuZWRpdG9yLnF1ZXN0aW9uc1tOdW1iZXIoaW5wdXQuZGF0YXNldC5xdWVzdGlvbkluZGV4KV07CiAgICB3aGlsZSAocXVlc3Rpb24ub3B0aW9ucy5sZW5ndGggPCA2KSBxdWVzdGlvbi5vcHRpb25zLnB1c2goJycpOwogICAgcXVlc3Rpb24ub3B0aW9uc1tOdW1iZXIoaW5wdXQuZGF0YXNldC5vcHRpb25JbmRleCldID0gaW5wdXQudmFsdWU7CiAgfSkpOwogIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5jb3JyZWN0LW9wdGlvbicpLmZvckVhY2goKGlucHV0KSA9PiBpbnB1dC5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCAoKSA9PiBzdGF0ZS5lZGl0b3IucXVlc3Rpb25zW051bWJlcihpbnB1dC5kYXRhc2V0LnF1ZXN0aW9uSW5kZXgpXS5jb3JyZWN0SW5kZXggPSBOdW1iZXIoaW5wdXQudmFsdWUpKSk7CiAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtcmVtb3ZlLXF1ZXN0aW9uXScpLmZvckVhY2goKGJ1dHRvbikgPT4gYnV0dG9uLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gewogICAgc3RhdGUuZWRpdG9yLnF1ZXN0aW9ucy5zcGxpY2UoTnVtYmVyKGJ1dHRvbi5kYXRhc2V0LnJlbW92ZVF1ZXN0aW9uKSwgMSk7CiAgICByZW5kZXJEYXNoYm9hcmQoKTsKICB9KSk7CiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2FkZC1xdWVzdGlvbicpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gewogICAgaWYgKHN0YXRlLmVkaXRvci5xdWVzdGlvbnMubGVuZ3RoID49IDYwKSByZXR1cm4gc2hvd1RvYXN0KCdPIGxpbWl0ZSDDqSBkZSA2MCBxdWVzdMO1ZXMgcG9yIHF1aXouJyk7CiAgICBzdGF0ZS5lZGl0b3IucXVlc3Rpb25zLnB1c2goYmxhbmtRdWVzdGlvbigpKTsKICAgIHJlbmRlckRhc2hib2FyZCgpOwogIH0pOwogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzYXZlLXF1aXonKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIHNhdmVRdWl6RWRpdG9yKTsKfQoKYXN5bmMgZnVuY3Rpb24gc2F2ZVF1aXpFZGl0b3IoKSB7CiAgY29uc3QgcXVpeiA9IHN0YXRlLmVkaXRvcjsKICBpZiAoIXF1aXoudGl0bGUudHJpbSgpKSByZXR1cm4gc2hvd1RvYXN0KCdJbmZvcm1lIG8gdMOtdHVsbyBkbyBxdWl6LicpOwogIGZvciAobGV0IGkgPSAwOyBpIDwgcXVpei5xdWVzdGlvbnMubGVuZ3RoOyBpICs9IDEpIHsKICAgIGNvbnN0IHF1ZXN0aW9uID0gcXVpei5xdWVzdGlvbnNbaV07CiAgICBjb25zdCBmaWxsZWQgPSBxdWVzdGlvbi5vcHRpb25zLm1hcCgodGV4dCwgaW5kZXgpID0+ICh7IHRleHQ6IFN0cmluZyh0ZXh0IHx8ICcnKS50cmltKCksIGluZGV4IH0pKS5maWx0ZXIoKGl0ZW0pID0+IGl0ZW0udGV4dCk7CiAgICBpZiAoIXF1ZXN0aW9uLnRleHQudHJpbSgpIHx8IGZpbGxlZC5sZW5ndGggPCAyKSByZXR1cm4gc2hvd1RvYXN0KGBQcmVlbmNoYSBhIHF1ZXN0w6NvICR7aSArIDF9IGUgcGVsbyBtZW5vcyBkdWFzIGFsdGVybmF0aXZhcy5gKTsKICAgIGlmICghU3RyaW5nKHF1ZXN0aW9uLm9wdGlvbnNbcXVlc3Rpb24uY29ycmVjdEluZGV4XSB8fCAnJykudHJpbSgpKSByZXR1cm4gc2hvd1RvYXN0KGBNYXJxdWUgdW1hIGFsdGVybmF0aXZhIHByZWVuY2hpZGEgY29tbyBjb3JyZXRhIG5hIHF1ZXN0w6NvICR7aSArIDF9LmApOwogIH0KICB0cnkgewogICAgY29uc3QgYnV0dG9uID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3NhdmUtcXVpeicpOwogICAgYnV0dG9uLmRpc2FibGVkID0gdHJ1ZTsKICAgIGF3YWl0IGFwaSgnL2FwaS9hZG1pbi9zYXZlLXF1aXonLCB7IGF1dGhUb2tlbjogc3RhdGUuYXV0aC5hdXRoVG9rZW4sIHF1aXogfSk7CiAgICBzdGF0ZS5lZGl0b3IgPSBudWxsOwogICAgc2hvd1RvYXN0KCdRdWl6IHNhbHZvLicpOwogICAgYXdhaXQgbG9hZERhc2hib2FyZCgpOwogIH0gY2F0Y2ggKGVycm9yKSB7IHNob3dUb2FzdChlcnJvci5tZXNzYWdlKTsgfQp9Cgphc3luYyBmdW5jdGlvbiBvcGVuUGxheWVyKHJvb21Db2RlLCBhY2Nlc3NLZXkpIHsKICBjb25zdCBzdG9yZWQgPSBzZXNzaW9uU3RvcmFnZS5nZXRJdGVtKFBMQVlFUl9LRVkocm9vbUNvZGUpKTsKICBpZiAoc3RvcmVkKSB7CiAgICB0cnkgewogICAgICBzdGF0ZS5wbGF5ZXJDcmVkcyA9IEpTT04ucGFyc2Uoc3RvcmVkKTsKICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgYXBpKCcvYXBpL3BsYXllci9yZXN1bWUnLCB7IHJvb21Db2RlLCAuLi5zdGF0ZS5wbGF5ZXJDcmVkcyB9KTsKICAgICAgc3RhdGUucm9vbSA9IHJlc3VsdC5zdGF0ZTsKICAgICAgc3RhdGUuc2VsZiA9IHJlc3VsdC5zZWxmOwogICAgICBvcGVuUm9vbUV2ZW50cygncGxheWVyJywgcm9vbUNvZGUsIHN0YXRlLnBsYXllckNyZWRzLnBsYXllclRva2VuLCBzdGF0ZS5wbGF5ZXJDcmVkcy5wbGF5ZXJJZCk7CiAgICAgIHJlbmRlclBsYXllclN0YXRlKCk7CiAgICAgIHJldHVybjsKICAgIH0gY2F0Y2ggKGVycm9yKSB7CiAgICAgIHNlc3Npb25TdG9yYWdlLnJlbW92ZUl0ZW0oUExBWUVSX0tFWShyb29tQ29kZSkpOwogICAgICBzdGF0ZS5wbGF5ZXJDcmVkcyA9IG51bGw7CiAgICB9CiAgfQogIHJlbmRlckpvaW4ocm9vbUNvZGUsIGFjY2Vzc0tleSk7Cn0KCmZ1bmN0aW9uIHJlbmRlckpvaW4ocm9vbUNvZGUsIGFjY2Vzc0tleSkgewogIGxldCBzZWxlY3RlZEF2YXRhciA9IHN0YXRlLmNvbmZpZy5hdmF0YXJzWzBdLmlkOwogIGFwcC5pbm5lckhUTUwgPSBgCiAgICAke3RvcGJhcihgPGJ1dHRvbiBpZD0iam9pbi1ob21lLWJhY2siIGNsYXNzPSJidG4gYnRuLWxpZ2h0Ij5TYWlyPC9idXR0b24+YCl9CiAgICA8bWFpbiBjbGFzcz0iY29udGFpbmVyIG5hcnJvdyI+CiAgICAgIDxkaXYgY2xhc3M9ImNhcmQiIHN0eWxlPSJtYXJnaW4tdG9wOjMwcHgiPgogICAgICAgIDxkaXYgY2xhc3M9ImV5ZWJyb3ciPlNhbGEgJHtlc2NhcGVIdG1sKHJvb21Db2RlKX08L2Rpdj4KICAgICAgICA8aDE+Q29tbyB2b2PDqiBxdWVyIGFwYXJlY2VyPzwvaDE+CiAgICAgICAgPGRpdiBjbGFzcz0iZ3JpZC0yIj4KICAgICAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+Tm9tZSBjb21wbGV0bzwvbGFiZWw+PGlucHV0IGlkPSJmdWxsLW5hbWUiIGNsYXNzPSJpbnB1dCIgYXV0b2NvbXBsZXRlPSJuYW1lIiBwbGFjZWhvbGRlcj0iVXNhZG8gbm8gcmVsYXTDs3JpbyBkZSBwcmVzZW7Dp2EiPjwvZGl2PgogICAgICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5BcGVsaWRvPC9sYWJlbD48aW5wdXQgaWQ9Im5pY2tuYW1lIiBjbGFzcz0iaW5wdXQiIG1heGxlbmd0aD0iMjQiIHBsYWNlaG9sZGVyPSJFeGliaWRvIGR1cmFudGUgbyBqb2dvIj48L2Rpdj4KICAgICAgICA8L2Rpdj4KICAgICAgICA8bGFiZWwgc3R5bGU9ImZvbnQtd2VpZ2h0Ojg1MDtkaXNwbGF5OmJsb2NrO21hcmdpbi1ib3R0b206MTBweCI+RXNjb2xoYSB1bSBhdmF0YXI8L2xhYmVsPgogICAgICAgIDxkaXYgY2xhc3M9ImF2YXRhci1ncmlkIj4ke3N0YXRlLmNvbmZpZy5hdmF0YXJzLm1hcCgoYXZhdGFyLCBpbmRleCkgPT4gYDxidXR0b24gY2xhc3M9ImF2YXRhci1jaG9pY2UgJHtpbmRleCA9PT0gMCA/ICdzZWxlY3RlZCcgOiAnJ30iIGRhdGEtYXZhdGFyPSIke2F2YXRhci5pZH0iPiR7YXZhdGFyVmlzdWFsKGF2YXRhcil9PHNtYWxsPiR7ZXNjYXBlSHRtbChhdmF0YXIubmFtZSl9PC9zbWFsbD48L2J1dHRvbj5gKS5qb2luKCcnKX08L2Rpdj4KICAgICAgICA8YnV0dG9uIGlkPSJqb2luLXJvb20iIGNsYXNzPSJidG4gYnRuLXByaW1hcnkgYnRuLWxhcmdlIGJ0bi1ibG9jayIgc3R5bGU9Im1hcmdpbi10b3A6MjBweCI+RW50cmFyIG5hIHNhbGE8L2J1dHRvbj4KICAgICAgPC9kaXY+CiAgICA8L21haW4+YDsKICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnam9pbi1ob21lLWJhY2snKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IGxvY2F0aW9uLmhyZWYgPSAnLycpOwogIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLWF2YXRhcl0nKS5mb3JFYWNoKChidXR0b24pID0+IGJ1dHRvbi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHsKICAgIHNlbGVjdGVkQXZhdGFyID0gYnV0dG9uLmRhdGFzZXQuYXZhdGFyOwogICAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtYXZhdGFyXScpLmZvckVhY2goKGl0ZW0pID0+IGl0ZW0uY2xhc3NMaXN0LnRvZ2dsZSgnc2VsZWN0ZWQnLCBpdGVtID09PSBidXR0b24pKTsKICB9KSk7CiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2pvaW4tcm9vbScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgYXN5bmMgKCkgPT4gewogICAgY29uc3QgYnV0dG9uID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2pvaW4tcm9vbScpOwogICAgdHJ5IHsKICAgICAgZW5zdXJlQXVkaW8oKTsKICAgICAgYnV0dG9uLmRpc2FibGVkID0gdHJ1ZTsKICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgYXBpKCcvYXBpL3BsYXllci9qb2luJywgewogICAgICAgIHJvb21Db2RlLAogICAgICAgIGFjY2Vzc0tleSwKICAgICAgICBmdWxsTmFtZTogZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2Z1bGwtbmFtZScpLnZhbHVlLAogICAgICAgIG5pY2tuYW1lOiBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnbmlja25hbWUnKS52YWx1ZSwKICAgICAgICBhdmF0YXJJZDogc2VsZWN0ZWRBdmF0YXIsCiAgICAgIH0pOwogICAgICBzdGF0ZS5wbGF5ZXJDcmVkcyA9IHsgcGxheWVySWQ6IHJlc3VsdC5wbGF5ZXJJZCwgcGxheWVyVG9rZW46IHJlc3VsdC5wbGF5ZXJUb2tlbiB9OwogICAgICBzZXNzaW9uU3RvcmFnZS5zZXRJdGVtKFBMQVlFUl9LRVkocm9vbUNvZGUpLCBKU09OLnN0cmluZ2lmeShzdGF0ZS5wbGF5ZXJDcmVkcykpOwogICAgICBzdGF0ZS5yb29tID0gcmVzdWx0LnN0YXRlOwogICAgICBzdGF0ZS5zZWxmID0gcmVzdWx0LnNlbGY7CiAgICAgIG9wZW5Sb29tRXZlbnRzKCdwbGF5ZXInLCByb29tQ29kZSwgcmVzdWx0LnBsYXllclRva2VuLCByZXN1bHQucGxheWVySWQpOwogICAgICByZW5kZXJQbGF5ZXJTdGF0ZSgpOwogICAgfSBjYXRjaCAoZXJyb3IpIHsKICAgICAgYnV0dG9uLmRpc2FibGVkID0gZmFsc2U7CiAgICAgIHNob3dUb2FzdChlcnJvci5tZXNzYWdlKTsKICAgIH0KICB9KTsKfQoKZnVuY3Rpb24gb3BlblJvb21FdmVudHMocm9sZSwgcm9vbUNvZGUsIHRva2VuID0gJycsIHBsYXllcklkID0gJycpIHsKICBpZiAoc3RhdGUuZXZlbnRTb3VyY2UpIHN0YXRlLmV2ZW50U291cmNlLmNsb3NlKCk7CiAgY29uc3QgcXVlcnkgPSBuZXcgVVJMU2VhcmNoUGFyYW1zKHsgcm9vbTogcm9vbUNvZGUsIHJvbGUsIHRva2VuLCBwbGF5ZXJJZCB9KTsKICBzdGF0ZS5ldmVudFNvdXJjZSA9IG5ldyBFdmVudFNvdXJjZShgL2V2ZW50cz8ke3F1ZXJ5fWApOwogIHN0YXRlLmV2ZW50U291cmNlLmFkZEV2ZW50TGlzdGVuZXIoJ3N0YXRlJywgKGV2ZW50KSA9PiB7CiAgICBjb25zdCBkYXRhID0gSlNPTi5wYXJzZShldmVudC5kYXRhKTsKICAgIGlmIChyb2xlID09PSAncGxheWVyJykgewogICAgICBzdGF0ZS5yb29tID0gZGF0YS5yb29tOwogICAgICBzdGF0ZS5zZWxmID0gZGF0YS5zZWxmOwogICAgICByZW5kZXJQbGF5ZXJTdGF0ZSgpOwogICAgfSBlbHNlIHsKICAgICAgc3RhdGUucm9vbSA9IGRhdGE7CiAgICAgIGlmIChyb2xlID09PSAnYWRtaW4nKSByZW5kZXJQcmVzZW50ZXJTdGF0ZSgpOwogICAgICBlbHNlIHJlbmRlclNjcmVlblN0YXRlKCk7CiAgICB9CiAgfSk7CiAgc3RhdGUuZXZlbnRTb3VyY2UuYWRkRXZlbnRMaXN0ZW5lcigna2lja2VkJywgKGV2ZW50KSA9PiB7CiAgICBjb25zdCBkYXRhID0gSlNPTi5wYXJzZShldmVudC5kYXRhKTsKICAgIHNlc3Npb25TdG9yYWdlLnJlbW92ZUl0ZW0oUExBWUVSX0tFWShyb29tQ29kZSkpOwogICAgc3RhdGUuZXZlbnRTb3VyY2UuY2xvc2UoKTsKICAgIGFwcC5pbm5lckhUTUwgPSBgPGRpdiBjbGFzcz0id2FpdC1zY3JlZW4iPjxkaXYgY2xhc3M9IndhaXQtY2FyZCI+PGgxPkFjZXNzbyBlbmNlcnJhZG88L2gxPjxwPiR7ZXNjYXBlSHRtbChkYXRhLm1lc3NhZ2UpfTwvcD48YSBocmVmPSIvIiBjbGFzcz0iYnRuIGJ0bi1saWdodCI+Vm9sdGFyIGFvIGluw61jaW88L2E+PC9kaXY+PC9kaXY+YDsKICB9KTsKfQoKZnVuY3Rpb24gcmVuZGVyUGxheWVyU3RhdGUoKSB7CiAgY29uc3Qgcm9vbSA9IHN0YXRlLnJvb207CiAgc3luY011c2ljKHJvb20pOwogIGlmIChyb29tLnBoYXNlID09PSAnbG9iYnknKSByZXR1cm4gcmVuZGVyUGxheWVyTG9iYnkocm9vbSk7CiAgaWYgKHJvb20ucGhhc2UgPT09ICdxdWVzdGlvbicpIHJldHVybiByZW5kZXJQbGF5ZXJRdWVzdGlvbihyb29tKTsKICBpZiAocm9vbS5waGFzZSA9PT0gJ2Fuc3dlcicpIHJldHVybiByZW5kZXJQbGF5ZXJBbnN3ZXIocm9vbSk7CiAgaWYgKHJvb20ucGhhc2UgPT09ICdyYW5raW5nJykgcmV0dXJuIHJlbmRlclBsYXllclJhbmtpbmcocm9vbSk7CiAgaWYgKHJvb20ucGhhc2UgPT09ICdmaW5pc2hlZCcpIHJldHVybiByZW5kZXJQbGF5ZXJGaW5pc2hlZChyb29tKTsKfQoKZnVuY3Rpb24gcmVuZGVyUGxheWVyTG9iYnkocm9vbSkgewogIGNsZWFyVGltZXIoKTsKICBhcHAuaW5uZXJIVE1MID0gYDxkaXYgY2xhc3M9IndhaXQtc2NyZWVuIj48ZGl2IGNsYXNzPSJ3YWl0LWNhcmQiPiR7YXZhdGFyVmlzdWFsKHN0YXRlLnNlbGYuYXZhdGFyKX08aDE+Vm9jw6ogZW50cm91ITwvaDE+PHA+JHtlc2NhcGVIdG1sKHN0YXRlLnNlbGYubmlja25hbWUpfSwgYWd1YXJkZSBvIGFwcmVzZW50YWRvciBpbmljaWFyLjwvcD48ZGl2IGNsYXNzPSJjaGlwIiBzdHlsZT0iYmFja2dyb3VuZDpyZ2JhKDI1NSwyNTUsMjU1LC4xOCk7Y29sb3I6d2hpdGUiPiR7cm9vbS5wYXJ0aWNpcGFudENvdW50fS8ke3Jvb20ubWF4UGFydGljaXBhbnRzfSBwYXJ0aWNpcGFudGVzPC9kaXY+PGRpdiBjbGFzcz0ic3Bpbm5lciIgc3R5bGU9Im1hcmdpbi10b3A6MjZweCI+PC9kaXY+PC9kaXY+PC9kaXY+YDsKfQoKZnVuY3Rpb24gcmVuZGVyUGxheWVyUXVlc3Rpb24ocm9vbSkgewogIGNvbnN0IGFuc3dlcmVkID0gc3RhdGUuc2VsZi5hbnN3ZXJJbmRleCAhPT0gbnVsbDsKICBhcHAuaW5uZXJIVE1MID0gYDxkaXYgY2xhc3M9ImdhbWUtc2hlbGwiPgogICAgPGhlYWRlciBjbGFzcz0iZ2FtZS1oZWFkZXIiPjxkaXY+JHtlc2NhcGVIdG1sKHN0YXRlLnNlbGYubmlja25hbWUpfSDCtyAke3N0YXRlLnNlbGYuc2NvcmV9IHBvbnRvczwvZGl2PjxkaXYgY2xhc3M9InJvdyI+PHNwYW4+UGVyZ3VudGEgJHtyb29tLmN1cnJlbnRRdWVzdGlvbkluZGV4ICsgMX0vJHtyb29tLnRvdGFsUXVlc3Rpb25zfTwvc3Bhbj48ZGl2IGlkPSJ0aW1lciIgY2xhc3M9InRpbWVyIj4ke3Jvb20ucXVlc3Rpb24udGltZUxpbWl0fTwvZGl2PjwvZGl2PjwvaGVhZGVyPgogICAgPG1haW4gY2xhc3M9ImdhbWUtc3RhZ2UiPjxoMSBjbGFzcz0icXVlc3Rpb24tdGl0bGUiPiR7ZXNjYXBlSHRtbChyb29tLnF1ZXN0aW9uLnRleHQpfTwvaDE+PGRpdiBjbGFzcz0iYW5zd2Vycy1ncmlkIj4ke3Jvb20ucXVlc3Rpb24ub3B0aW9ucy5tYXAoKG9wdGlvbiwgaW5kZXgpID0+IGA8YnV0dG9uIGNsYXNzPSJhbnN3ZXItYnRuICR7YW5zd2VyZWQgJiYgc3RhdGUuc2VsZi5hbnN3ZXJJbmRleCA9PT0gaW5kZXggPyAnc2VsZWN0ZWQnIDogJyd9IiBkYXRhLWFuc3dlcj0iJHtpbmRleH0iICR7YW5zd2VyZWQgPyAnZGlzYWJsZWQnIDogJyd9PjxzcGFuIGNsYXNzPSJzaGFwZSI+PC9zcGFuPjxzcGFuPiR7ZXNjYXBlSHRtbChvcHRpb24pfTwvc3Bhbj48L2J1dHRvbj5gKS5qb2luKCcnKX08L2Rpdj4ke2Fuc3dlcmVkID8gJzxkaXYgY2xhc3M9Im5vdGljZSBzdWNjZXNzIHRleHQtY2VudGVyIj5SZXNwb3N0YSBlbnZpYWRhLiBBZ3VhcmRlIG8gZW5jZXJyYW1lbnRvLjwvZGl2PicgOiAnJ308L21haW4+CiAgPC9kaXY+YDsKICBzdGFydENvdW50ZG93bihyb29tKTsKICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS1hbnN3ZXJdJykuZm9yRWFjaCgoYnV0dG9uKSA9PiBidXR0b24uYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBhc3luYyAoKSA9PiB7CiAgICB0cnkgewogICAgICBlbnN1cmVBdWRpbygpOwogICAgICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS1hbnN3ZXJdJykuZm9yRWFjaCgoaXRlbSkgPT4gaXRlbS5kaXNhYmxlZCA9IHRydWUpOwogICAgICBidXR0b24uY2xhc3NMaXN0LmFkZCgnc2VsZWN0ZWQnKTsKICAgICAgYXdhaXQgYXBpKCcvYXBpL3BsYXllci9hbnN3ZXInLCB7IHJvb21Db2RlOiByb29tLnJvb21Db2RlLCAuLi5zdGF0ZS5wbGF5ZXJDcmVkcywgYW5zd2VySW5kZXg6IE51bWJlcihidXR0b24uZGF0YXNldC5hbnN3ZXIpIH0pOwogICAgICBzdGF0ZS5zZWxmLmFuc3dlckluZGV4ID0gTnVtYmVyKGJ1dHRvbi5kYXRhc2V0LmFuc3dlcik7CiAgICAgIHNob3dUb2FzdCgnUmVzcG9zdGEgZW52aWFkYS4nKTsKICAgIH0gY2F0Y2ggKGVycm9yKSB7CiAgICAgIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLWFuc3dlcl0nKS5mb3JFYWNoKChpdGVtKSA9PiBpdGVtLmRpc2FibGVkID0gZmFsc2UpOwogICAgICBzaG93VG9hc3QoZXJyb3IubWVzc2FnZSk7CiAgICB9CiAgfSkpOwp9CgpmdW5jdGlvbiByZW5kZXJQbGF5ZXJBbnN3ZXIocm9vbSkgewogIGNsZWFyVGltZXIoKTsKICBjb25zdCBjb3JyZWN0ID0gc3RhdGUuc2VsZi5sYXN0Q29ycmVjdDsKICBhcHAuaW5uZXJIVE1MID0gYDxkaXYgY2xhc3M9ImdhbWUtc2hlbGwiPgogICAgPGhlYWRlciBjbGFzcz0iZ2FtZS1oZWFkZXIiPjxkaXY+JHtlc2NhcGVIdG1sKHN0YXRlLnNlbGYubmlja25hbWUpfTwvZGl2PjxkaXY+PHN0cm9uZz4ke3N0YXRlLnNlbGYuc2NvcmV9PC9zdHJvbmc+IHBvbnRvczwvZGl2PjwvaGVhZGVyPgogICAgPG1haW4gY2xhc3M9ImdhbWUtc3RhZ2UgdGV4dC1jZW50ZXIiPjxkaXYgc3R5bGU9ImZvbnQtc2l6ZTo3NHB4Ij4ke2NvcnJlY3QgPT09IHRydWUgPyAn4pyFJyA6IGNvcnJlY3QgPT09IGZhbHNlID8gJ/CfkqEnIDogJ+KPse+4jyd9PC9kaXY+PGgxIGNsYXNzPSJxdWVzdGlvbi10aXRsZSI+JHtjb3JyZWN0ID09PSB0cnVlID8gYEFjZXJ0b3UhICske3N0YXRlLnNlbGYubGFzdFBvaW50c30gcG9udG9zYCA6IGNvcnJlY3QgPT09IGZhbHNlID8gJ07Do28gZm9pIGRlc3NhIHZleicgOiAnVGVtcG8gZW5jZXJyYWRvJ308L2gxPjxkaXYgY2xhc3M9ImFuc3dlcnMtZ3JpZCI+JHtyb29tLnF1ZXN0aW9uLm9wdGlvbnMubWFwKChvcHRpb24sIGluZGV4KSA9PiBgPGRpdiBjbGFzcz0iYW5zd2VyLWNhcmQgJHtpbmRleCA9PT0gcm9vbS5xdWVzdGlvbi5jb3JyZWN0SW5kZXggPyAnY29ycmVjdCcgOiAnZGltbWVkJ30iPjxzcGFuIGNsYXNzPSJzaGFwZSI+PC9zcGFuPjxzcGFuPiR7ZXNjYXBlSHRtbChvcHRpb24pfTwvc3Bhbj48L2Rpdj5gKS5qb2luKCcnKX08L2Rpdj4ke3Jvb20ucXVlc3Rpb24uZXhwbGFuYXRpb24gPyBgPGRpdiBjbGFzcz0iY2FyZCIgc3R5bGU9ImNvbG9yOnZhcigtLWluaykiPjxzdHJvbmc+UG9yIHF1ZT88L3N0cm9uZz48cD4ke2VzY2FwZUh0bWwocm9vbS5xdWVzdGlvbi5leHBsYW5hdGlvbil9PC9wPjwvZGl2PmAgOiAnJ308cCBjbGFzcz0id2hpdGUtbXV0ZWQiPk8gcmFua2luZyBzZXLDoSByZXZlbGFkbyBwZWxvIGFwcmVzZW50YWRvci48L3A+PC9tYWluPgogIDwvZGl2PmA7Cn0KCmZ1bmN0aW9uIHJlbmRlclBsYXllclJhbmtpbmcocm9vbSkgewogIGNsZWFyVGltZXIoKTsKICBhcHAuaW5uZXJIVE1MID0gYDxkaXYgY2xhc3M9ImdhbWUtc2hlbGwiPjxoZWFkZXIgY2xhc3M9ImdhbWUtaGVhZGVyIj4ke2JyYW5kTWFya3VwKHRydWUpfTxzcGFuPlJhbmtpbmcgYXR1YWxpemFkbzwvc3Bhbj48L2hlYWRlcj48bWFpbiBjbGFzcz0iZ2FtZS1zdGFnZSI+PGgxIGNsYXNzPSJxdWVzdGlvbi10aXRsZSI+UXVlbSBlc3TDoSBubyB0b3BvPzwvaDE+JHtsZWFkZXJib2FyZE1hcmt1cChyb29tLmxlYWRlcmJvYXJkKX08L21haW4+PC9kaXY+YDsKICBzdGFydFJhbmtpbmdBbmltYXRpb24ocm9vbSk7Cn0KCmZ1bmN0aW9uIHJlbmRlclBsYXllckZpbmlzaGVkKHJvb20pIHsKICBjbGVhclRpbWVyKCk7IHN0b3BNdXNpYygpOwogIGFwcC5pbm5lckhUTUwgPSBgPGRpdiBjbGFzcz0iZ2FtZS1zaGVsbCI+PGhlYWRlciBjbGFzcz0iZ2FtZS1oZWFkZXIiPiR7YnJhbmRNYXJrdXAodHJ1ZSl9PHNwYW4+UXVpeiBlbmNlcnJhZG88L3NwYW4+PC9oZWFkZXI+PG1haW4gY2xhc3M9ImdhbWUtc3RhZ2UgdGV4dC1jZW50ZXIiPjxkaXYgY2xhc3M9ImV5ZWJyb3ciIHN0eWxlPSJtYXJnaW46YXV0bztiYWNrZ3JvdW5kOnJnYmEoMjU1LDI1NSwyNTUsLjE0KTtjb2xvcjp3aGl0ZSI+UMOzZGlvIGZpbmFsPC9kaXY+PGgxIGNsYXNzPSJxdWVzdGlvbi10aXRsZSI+UGFyYWLDqW5zIGFvcyB2ZW5jZWRvcmVzITwvaDE+JHtwb2RpdW1NYXJrdXAocm9vbSl9PGRpdiBjbGFzcz0iY2FyZCIgc3R5bGU9ImNvbG9yOnZhcigtLWluayk7bWF4LXdpZHRoOjUyMHB4O21hcmdpbjoyMHB4IGF1dG8iPjxoMj5TdWEgY29sb2Nhw6fDo288L2gyPjxwIHN0eWxlPSJmb250LXNpemU6MzhweDtmb250LXdlaWdodDo5NTA7bWFyZ2luOjhweCI+JHtzdGF0ZS5zZWxmLnBvc2l0aW9uIHx8ICctJ33CujwvcD48cD4ke3N0YXRlLnNlbGYuc2NvcmV9IHBvbnRvcyDCtyAke3N0YXRlLnNlbGYuY29ycmVjdEFuc3dlcnN9IGFjZXJ0b3M8L3A+PC9kaXY+PGEgY2xhc3M9ImJ0biBidG4tbGlnaHQiIGhyZWY9Ii8iPlNhaXI8L2E+PC9tYWluPjwvZGl2PmA7Cn0KCmFzeW5jIGZ1bmN0aW9uIG9wZW5QcmVzZW50ZXIocm9vbUNvZGUpIHsKICBjb25zdCBzdG9yZWQgPSBzZXNzaW9uU3RvcmFnZS5nZXRJdGVtKFBSRVNFTlRFUl9LRVkocm9vbUNvZGUpKTsKICBpZiAoIXN0b3JlZCkgewogICAgYXBwLmlubmVySFRNTCA9IGA8ZGl2IGNsYXNzPSJ3YWl0LXNjcmVlbiI+PGRpdiBjbGFzcz0id2FpdC1jYXJkIj48aDE+QXByZXNlbnRhw6fDo28gbsOjbyBlbmNvbnRyYWRhPC9oMT48cD5BYnJhIGVzdGEgc2FsYSBwZWxvIHBhaW5lbCBhZG1pbmlzdHJhdGl2by48L3A+PGJ1dHRvbiBpZD0iZ28tYWRtaW4iIGNsYXNzPSJidG4gYnRuLWxpZ2h0Ij5JciBhbyBwYWluZWw8L2J1dHRvbj48L2Rpdj48L2Rpdj5gOwogICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2dvLWFkbWluJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBvcGVuQWRtaW4pOwogICAgcmV0dXJuOwogIH0KICBzdGF0ZS5wcmVzZW50ZXJDcmVkcyA9IEpTT04ucGFyc2Uoc3RvcmVkKTsKICB0cnkgewogICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgYXBpKCcvYXBpL2FkbWluL3Jlc3VtZScsIHN0YXRlLnByZXNlbnRlckNyZWRzKTsKICAgIHN0YXRlLnJvb20gPSByZXN1bHQuc3RhdGU7CiAgICBvcGVuUm9vbUV2ZW50cygnYWRtaW4nLCByb29tQ29kZSwgc3RhdGUucHJlc2VudGVyQ3JlZHMuYWRtaW5Ub2tlbik7CiAgICByZW5kZXJQcmVzZW50ZXJTdGF0ZSgpOwogIH0gY2F0Y2ggKGVycm9yKSB7CiAgICBzaG93VG9hc3QoZXJyb3IubWVzc2FnZSk7CiAgICBzZXNzaW9uU3RvcmFnZS5yZW1vdmVJdGVtKFBSRVNFTlRFUl9LRVkocm9vbUNvZGUpKTsKICAgIG9wZW5BZG1pbigpOwogIH0KfQoKZnVuY3Rpb24gcmVuZGVyUHJlc2VudGVyU3RhdGUoKSB7CiAgY29uc3Qgcm9vbSA9IHN0YXRlLnJvb207CiAgc3luY011c2ljKHJvb20pOwogIGlmIChyb29tLnBoYXNlID09PSAnbG9iYnknKSByZW5kZXJQcmVzZW50ZXJMb2JieShyb29tKTsKICBlbHNlIGlmIChyb29tLnBoYXNlID09PSAncXVlc3Rpb24nKSByZW5kZXJQcmVzZW50ZXJRdWVzdGlvbihyb29tKTsKICBlbHNlIGlmIChyb29tLnBoYXNlID09PSAnYW5zd2VyJykgcmVuZGVyUHJlc2VudGVyQW5zd2VyKHJvb20pOwogIGVsc2UgaWYgKHJvb20ucGhhc2UgPT09ICdyYW5raW5nJykgcmVuZGVyUHJlc2VudGVyUmFua2luZyhyb29tKTsKICBlbHNlIHJlbmRlclByZXNlbnRlckZpbmlzaGVkKHJvb20pOwogIGJpbmRQcmVzZW50ZXJDb250cm9scyhyb29tKTsKfQoKZnVuY3Rpb24gcHJlc2VudGVySGVhZGVyKHJvb20pIHsKICByZXR1cm4gYDxoZWFkZXIgY2xhc3M9InByZXNlbnRlci1oZWFkZXIiPiR7YnJhbmRNYXJrdXAodHJ1ZSl9PGRpdiBjbGFzcz0icm93Ij48c3BhbiBjbGFzcz0iY2hpcCIgc3R5bGU9ImJhY2tncm91bmQ6cmdiYSgyNTUsMjU1LDI1NSwuMTIpO2NvbG9yOndoaXRlIj4ke2VzY2FwZUh0bWwocGhhc2VMYWJlbChyb29tLnBoYXNlKSl9PC9zcGFuPjxidXR0b24gaWQ9ImF1ZGlvLXRvZ2dsZSIgY2xhc3M9ImJ0biBidG4tbGlnaHQiPiR7c3RhdGUuYXVkaW8uZW5hYmxlZCA/ICfwn5SKIFNvbScgOiAn8J+UhyBTb20nfTwvYnV0dG9uPjwvZGl2PjwvaGVhZGVyPmA7Cn0KCmZ1bmN0aW9uIHJlbmRlclByZXNlbnRlckxvYmJ5KHJvb20pIHsKICBjbGVhclRpbWVyKCk7CiAgYXBwLmlubmVySFRNTCA9IGA8ZGl2IGNsYXNzPSJwcmVzZW50ZXItc2hlbGwiPiR7cHJlc2VudGVySGVhZGVyKHJvb20pfTxtYWluIGNsYXNzPSJwcmVzZW50ZXItc3RhZ2UiPjxkaXYgY2xhc3M9InByZXNlbnRlci1sb2JieSI+PHNlY3Rpb24gY2xhc3M9ImNhcmQgZGFyayI+PGRpdiBjbGFzcz0iZXllYnJvdyIgc3R5bGU9ImJhY2tncm91bmQ6cmdiYSgyNTUsMjU1LDI1NSwuMTIpO2NvbG9yOndoaXRlIj5FbnRyZSBwZWxvIFFSIENvZGUgb3UgY8OzZGlnbzwvZGl2PjxkaXYgY2xhc3M9ImxvYmJ5LWNvZGUiPiR7cm9vbS5yb29tQ29kZX08L2Rpdj48ZGl2IGlkPSJwcmVzZW50ZXItcXIiIGNsYXNzPSJxci13cmFwIiBzdHlsZT0ibWFyZ2luOjI0cHggMCI+PC9kaXY+PGRpdiBjbGFzcz0icm93Ij48aW5wdXQgaWQ9ImpvaW4tbGluayIgY2xhc3M9ImlucHV0IiByZWFkb25seSB2YWx1ZT0iJHtlc2NhcGVIdG1sKHJvb20uam9pblVybCl9Ij48YnV0dG9uIGlkPSJjb3B5LWpvaW4iIGNsYXNzPSJidG4gYnRuLWxpZ2h0Ij5Db3BpYXI8L2J1dHRvbj48L2Rpdj48cCBjbGFzcz0id2hpdGUtbXV0ZWQiPk8gbGluayBlIG8gUVIgQ29kZSBzZXLDo28gc3Vic3RpdHXDrWRvcyBhdXRvbWF0aWNhbWVudGUgYXDDs3MgbyBlbmNlcnJhbWVudG8uPC9wPjwvc2VjdGlvbj48c2VjdGlvbiBjbGFzcz0iY2FyZCBkYXJrIj48ZGl2IGNsYXNzPSJzZWN0aW9uLXRpdGxlIj48aDI+UGFydGljaXBhbnRlczwvaDI+PHNwYW4gY2xhc3M9ImNoaXAiIHN0eWxlPSJiYWNrZ3JvdW5kOnJnYmEoMjU1LDI1NSwyNTUsLjEzKTtjb2xvcjp3aGl0ZSI+JHtyb29tLnBhcnRpY2lwYW50Q291bnR9LyR7cm9vbS5tYXhQYXJ0aWNpcGFudHN9PC9zcGFuPjwvZGl2PjxkaXYgY2xhc3M9InBsYXllci1jbG91ZCI+JHtyb29tLnBsYXllcnMubGVuZ3RoID8gcm9vbS5wbGF5ZXJzLm1hcCgocGxheWVyKSA9PiBgPGRpdiBjbGFzcz0icGxheWVyLXBpbGwiPiR7YXZhdGFyVmlzdWFsKHBsYXllci5hdmF0YXIsdHJ1ZSl9PGRpdj48c3Ryb25nPiR7ZXNjYXBlSHRtbChwbGF5ZXIubmlja25hbWUpfTwvc3Ryb25nPjxkaXYgY2xhc3M9IndoaXRlLW11dGVkIiBzdHlsZT0iZm9udC1zaXplOjEycHgiPiR7ZXNjYXBlSHRtbChwbGF5ZXIuZnVsbE5hbWUpfTwvZGl2PjwvZGl2PjwvZGl2PmApLmpvaW4oJycpIDogJzxkaXYgY2xhc3M9ImVtcHR5IiBzdHlsZT0iY29sb3I6cmdiYSgyNTUsMjU1LDI1NSwuNjUpO2JvcmRlci1jb2xvcjpyZ2JhKDI1NSwyNTUsMjU1LC4yNSkiPkFndWFyZGFuZG8gcGFydGljaXBhbnRlcy4uLjwvZGl2Pid9PC9kaXY+PC9zZWN0aW9uPjwvZGl2PjwvbWFpbj4ke2NvbnRyb2xEb2NrKHJvb20pfTwvZGl2PmA7CiAgcmVuZGVyUXIoJ3ByZXNlbnRlci1xcicsIHJvb20uam9pblVybCwgMjYwKTsKfQoKZnVuY3Rpb24gcmVuZGVyUHJlc2VudGVyUXVlc3Rpb24ocm9vbSkgewogIGFwcC5pbm5lckhUTUwgPSBgPGRpdiBjbGFzcz0icHJlc2VudGVyLXNoZWxsIj4ke3ByZXNlbnRlckhlYWRlcihyb29tKX08bWFpbiBjbGFzcz0icHJlc2VudGVyLXN0YWdlIj48ZGl2IGNsYXNzPSJxdWVzdGlvbi10b3AiPjxzcGFuIGNsYXNzPSJjaGlwIiBzdHlsZT0iYmFja2dyb3VuZDpyZ2JhKDI1NSwyNTUsMjU1LC4xMik7Y29sb3I6d2hpdGUiPlBlcmd1bnRhICR7cm9vbS5jdXJyZW50UXVlc3Rpb25JbmRleCArIDF9IGRlICR7cm9vbS50b3RhbFF1ZXN0aW9uc308L3NwYW4+PGRpdiBpZD0idGltZXIiIGNsYXNzPSJ0aW1lciI+JHtyb29tLnF1ZXN0aW9uLnRpbWVMaW1pdH08L2Rpdj48c3BhbiBjbGFzcz0iY2hpcCIgc3R5bGU9ImJhY2tncm91bmQ6cmdiYSgyNTUsMjU1LDI1NSwuMTIpO2NvbG9yOndoaXRlIj4ke3Jvb20ucmVzcG9uc2VDb3VudH0vJHtyb29tLnBhcnRpY2lwYW50Q291bnR9IHJlc3Bvc3Rhczwvc3Bhbj48L2Rpdj48aDEgY2xhc3M9InF1ZXN0aW9uLXRpdGxlIj4ke2VzY2FwZUh0bWwocm9vbS5xdWVzdGlvbi50ZXh0KX08L2gxPjxkaXYgY2xhc3M9ImFuc3dlcnMtZ3JpZCI+JHtyb29tLnF1ZXN0aW9uLm9wdGlvbnMubWFwKChvcHRpb24pID0+IGA8ZGl2IGNsYXNzPSJhbnN3ZXItY2FyZCI+PHNwYW4gY2xhc3M9InNoYXBlIj48L3NwYW4+PHNwYW4+JHtlc2NhcGVIdG1sKG9wdGlvbil9PC9zcGFuPjwvZGl2PmApLmpvaW4oJycpfTwvZGl2PjwvbWFpbj4ke2NvbnRyb2xEb2NrKHJvb20pfTwvZGl2PmA7CiAgc3RhcnRDb3VudGRvd24ocm9vbSk7Cn0KCmZ1bmN0aW9uIHJlbmRlclByZXNlbnRlckFuc3dlcihyb29tKSB7CiAgY2xlYXJUaW1lcigpOwogIGNvbnN0IG1heENvdW50ID0gTWF0aC5tYXgoMSwgLi4ucm9vbS5kaXN0cmlidXRpb24ubWFwKChpdGVtKSA9PiBpdGVtLmNvdW50KSk7CiAgYXBwLmlubmVySFRNTCA9IGA8ZGl2IGNsYXNzPSJwcmVzZW50ZXItc2hlbGwiPiR7cHJlc2VudGVySGVhZGVyKHJvb20pfTxtYWluIGNsYXNzPSJwcmVzZW50ZXItc3RhZ2UiPjxoMSBjbGFzcz0icXVlc3Rpb24tdGl0bGUiPlJlc3Bvc3RhIGNvcnJldGE8L2gxPjxkaXYgY2xhc3M9ImFuc3dlcnMtZ3JpZCI+JHtyb29tLnF1ZXN0aW9uLm9wdGlvbnMubWFwKChvcHRpb24saW5kZXgpID0+IGA8ZGl2IGNsYXNzPSJhbnN3ZXItY2FyZCAke2luZGV4ID09PSByb29tLnF1ZXN0aW9uLmNvcnJlY3RJbmRleCA/ICdjb3JyZWN0JyA6ICdkaW1tZWQnfSI+PHNwYW4gY2xhc3M9InNoYXBlIj48L3NwYW4+PHNwYW4+JHtlc2NhcGVIdG1sKG9wdGlvbil9PC9zcGFuPjwvZGl2PmApLmpvaW4oJycpfTwvZGl2PjxkaXYgY2xhc3M9ImRpc3RyaWJ1dGlvbiI+JHtyb29tLmRpc3RyaWJ1dGlvbi5tYXAoKGl0ZW0pID0+IGA8ZGl2IGNsYXNzPSJkaXN0cmlidXRpb24tcm93ICR7aXRlbS5jb3JyZWN0ID8gJ2NvcnJlY3QnIDogJyd9Ij48c3Ryb25nPiR7ZXNjYXBlSHRtbChpdGVtLm9wdGlvbil9PC9zdHJvbmc+PGRpdiBjbGFzcz0iYmFyLXRyYWNrIj48ZGl2IGNsYXNzPSJiYXItZmlsbCIgc3R5bGU9IndpZHRoOiR7TWF0aC5yb3VuZChpdGVtLmNvdW50IC8gbWF4Q291bnQgKiAxMDApfSUiPjwvZGl2PjwvZGl2PjxzdHJvbmc+JHtpdGVtLmNvdW50fTwvc3Ryb25nPjwvZGl2PmApLmpvaW4oJycpfTwvZGl2PiR7cm9vbS5xdWVzdGlvbi5leHBsYW5hdGlvbiA/IGA8ZGl2IGNsYXNzPSJjYXJkIiBzdHlsZT0iY29sb3I6dmFyKC0taW5rKSI+PGgzPkV4cGxpY2HDp8OjbzwvaDM+PHA+JHtlc2NhcGVIdG1sKHJvb20ucXVlc3Rpb24uZXhwbGFuYXRpb24pfTwvcD48L2Rpdj5gIDogJyd9PC9tYWluPiR7Y29udHJvbERvY2socm9vbSl9PC9kaXY+YDsKfQoKZnVuY3Rpb24gcmVuZGVyUHJlc2VudGVyUmFua2luZyhyb29tKSB7CiAgY2xlYXJUaW1lcigpOwogIGFwcC5pbm5lckhUTUwgPSBgPGRpdiBjbGFzcz0icHJlc2VudGVyLXNoZWxsIj4ke3ByZXNlbnRlckhlYWRlcihyb29tKX08bWFpbiBjbGFzcz0icHJlc2VudGVyLXN0YWdlIj48aDEgY2xhc3M9InF1ZXN0aW9uLXRpdGxlIj5SYW5raW5nIGRhIHJvZGFkYTwvaDE+JHtsZWFkZXJib2FyZE1hcmt1cChyb29tLmxlYWRlcmJvYXJkKX08L21haW4+JHtjb250cm9sRG9jayhyb29tKX08L2Rpdj5gOwogIHN0YXJ0UmFua2luZ0FuaW1hdGlvbihyb29tKTsKfQoKZnVuY3Rpb24gcmVuZGVyUHJlc2VudGVyRmluaXNoZWQocm9vbSkgewogIGNsZWFyVGltZXIoKTsgc3RvcE11c2ljKCk7CiAgY29uc3QgcmVwbGFjZW1lbnQgPSByb29tLnJlcGxhY2VtZW50OwogIGFwcC5pbm5lckhUTUwgPSBgPGRpdiBjbGFzcz0icHJlc2VudGVyLXNoZWxsIj4ke3ByZXNlbnRlckhlYWRlcihyb29tKX08bWFpbiBjbGFzcz0icHJlc2VudGVyLXN0YWdlIHRleHQtY2VudGVyIj48ZGl2IGNsYXNzPSJleWVicm93IiBzdHlsZT0ibWFyZ2luOmF1dG87YmFja2dyb3VuZDpyZ2JhKDI1NSwyNTUsMjU1LC4xNCk7Y29sb3I6d2hpdGUiPlJlc3VsdGFkbyBmaW5hbDwvZGl2PjxoMSBjbGFzcz0icXVlc3Rpb24tdGl0bGUiPlDDs2RpbyBkbyBxdWl6PC9oMT4ke3BvZGl1bU1hcmt1cChyb29tKX08ZGl2IGNsYXNzPSJncmlkLTIiIHN0eWxlPSJtYXJnaW4tdG9wOjMwcHgiPjxkaXYgY2xhc3M9ImNhcmQiIHN0eWxlPSJjb2xvcjp2YXIoLS1pbmspO3RleHQtYWxpZ246bGVmdCI+PGgyPlJlbGF0w7NyaW8gY29tcGxldG88L2gyPjxwIGNsYXNzPSJtdXRlZCI+RGF0YSwgaG9yw6FyaW8sIHByZXNlbsOnYSwgcG9udHVhw6fDo28gZSByZXNwb3N0YSBkZSBjYWRhIHF1ZXN0w6NvLjwvcD48YSBjbGFzcz0iYnRuIGJ0bi1wcmltYXJ5IGJ0bi1ibG9jayIgaHJlZj0iL2FwaS9hZG1pbi9yZXBvcnQueGxzP3Jvb209JHtlbmNvZGVVUklDb21wb25lbnQocm9vbS5yb29tQ29kZSl9JnRva2VuPSR7ZW5jb2RlVVJJQ29tcG9uZW50KHN0YXRlLnByZXNlbnRlckNyZWRzLmFkbWluVG9rZW4pfSI+QmFpeGFyIHJlbGF0w7NyaW8gRXhjZWw8L2E+PC9kaXY+JHtyZXBsYWNlbWVudCA/IGA8ZGl2IGNsYXNzPSJjYXJkIGRhcmsiPjxoMj5Ob3ZvIGxpbmsgZSBRUiBDb2RlPC9oMj48cCBjbGFzcz0id2hpdGUtbXV0ZWQiPk8gY8OzZGlnbyBhbnRpZ28gZm9pIGVuY2VycmFkby4gQSBwcsOzeGltYSBzYWxhIGrDoSBlc3TDoSBwcm9udGEuPC9wPjxkaXYgY2xhc3M9ImxvYmJ5LWNvZGUiIHN0eWxlPSJmb250LXNpemU6NTJweCI+JHtyZXBsYWNlbWVudC5yb29tQ29kZX08L2Rpdj48ZGl2IGlkPSJyZXBsYWNlbWVudC1xciIgY2xhc3M9InFyLXdyYXAiIHN0eWxlPSJtYXJnaW46MThweCBhdXRvIj48L2Rpdj48YnV0dG9uIGlkPSJvcGVuLXJlcGxhY2VtZW50IiBjbGFzcz0iYnRuIGJ0bi1saWdodCBidG4tYmxvY2siPkFicmlyIG5vdmEgc2FsYTwvYnV0dG9uPjwvZGl2PmAgOiAnJ308L2Rpdj48L21haW4+JHtjb250cm9sRG9jayhyb29tKX08L2Rpdj5gOwogIGlmIChyZXBsYWNlbWVudCkgcmVuZGVyUXIoJ3JlcGxhY2VtZW50LXFyJywgcmVwbGFjZW1lbnQuam9pblVybCwgMjEwKTsKfQoKZnVuY3Rpb24gY29udHJvbERvY2socm9vbSkgewogIGxldCBhY3Rpb25zID0gJyc7CiAgaWYgKHJvb20ucGhhc2UgPT09ICdsb2JieScpIGFjdGlvbnMgPSBgPGJ1dHRvbiBjbGFzcz0iYnRuIGJ0bi1wcmltYXJ5IGJ0bi1sYXJnZSIgZGF0YS1jb21tYW5kPSJzdGFydCI+4pa2IEluaWNpYXIgcXVpejwvYnV0dG9uPjxidXR0b24gY2xhc3M9ImJ0biBidG4tZGFuZ2VyIiBkYXRhLWNvbW1hbmQ9ImZpbmlzaCI+RW5jZXJyYXIgc2FsYTwvYnV0dG9uPmA7CiAgaWYgKHJvb20ucGhhc2UgPT09ICdxdWVzdGlvbicpIGFjdGlvbnMgPSBgPGJ1dHRvbiBjbGFzcz0iYnRuIGJ0bi13YXJuaW5nIGJ0bi1sYXJnZSIgZGF0YS1jb21tYW5kPSJyZXZlYWwiPuKckyBFbmNlcnJhciBlIHJldmVsYXIgcmVzcG9zdGE8L2J1dHRvbj48YnV0dG9uIGNsYXNzPSJidG4gYnRuLWRhbmdlciIgZGF0YS1jb21tYW5kPSJmaW5pc2giPkVuY2VycmFyIHF1aXo8L2J1dHRvbj5gOwogIGlmIChyb29tLnBoYXNlID09PSAnYW5zd2VyJykgYWN0aW9ucyA9IGA8YnV0dG9uIGNsYXNzPSJidG4gYnRuLXByaW1hcnkgYnRuLWxhcmdlIiBkYXRhLWNvbW1hbmQ9InJhbmtpbmciPvCfj4YgTW9zdHJhciByYW5raW5nPC9idXR0b24+PGJ1dHRvbiBjbGFzcz0iYnRuIGJ0bi1kYW5nZXIiIGRhdGEtY29tbWFuZD0iZmluaXNoIj5FbmNlcnJhciBxdWl6PC9idXR0b24+YDsKICBpZiAocm9vbS5waGFzZSA9PT0gJ3JhbmtpbmcnKSBhY3Rpb25zID0gYDxidXR0b24gY2xhc3M9ImJ0biBidG4tcHJpbWFyeSBidG4tbGFyZ2UiIGRhdGEtY29tbWFuZD0ibmV4dCI+JHtyb29tLmN1cnJlbnRRdWVzdGlvbkluZGV4ICsgMSA+PSByb29tLnRvdGFsUXVlc3Rpb25zID8gJ0ZpbmFsaXphciBlIG1vc3RyYXIgcMOzZGlvJyA6ICdQcsOzeGltYSBxdWVzdMOjbyDihpInfTwvYnV0dG9uPjxidXR0b24gY2xhc3M9ImJ0biBidG4tZGFuZ2VyIiBkYXRhLWNvbW1hbmQ9ImZpbmlzaCI+RW5jZXJyYXIgcXVpejwvYnV0dG9uPmA7CiAgaWYgKHJvb20ucGhhc2UgPT09ICdmaW5pc2hlZCcpIGFjdGlvbnMgPSBgPGJ1dHRvbiBjbGFzcz0iYnRuIGJ0bi1saWdodCIgaWQ9ImJhY2stZGFzaGJvYXJkIj5Wb2x0YXIgYW8gcGFpbmVsPC9idXR0b24+YDsKICByZXR1cm4gYDxkaXYgY2xhc3M9ImNvbnRyb2wtZG9jayI+PGRpdiBjbGFzcz0iY29udHJvbC1zdGF0dXMiPjxzdHJvbmc+JHtlc2NhcGVIdG1sKHJvb20ucXVpelRpdGxlKX08L3N0cm9uZz48c21hbGw+JHtyb29tLnBhcnRpY2lwYW50Q291bnR9IHByZXNlbnRlcyDCtyAke3Jvb20ucmVzcG9uc2VDb3VudH0gcmVzcG9zdGFzPC9zbWFsbD48L2Rpdj48ZGl2IGNsYXNzPSJjb250cm9sLWFjdGlvbnMiPiR7YWN0aW9uc308L2Rpdj48L2Rpdj5gOwp9CgpmdW5jdGlvbiBiaW5kUHJlc2VudGVyQ29udHJvbHMocm9vbSkgewogIGNvbnN0IGF1ZGlvQnV0dG9uID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2F1ZGlvLXRvZ2dsZScpOwogIGlmIChhdWRpb0J1dHRvbikgYXVkaW9CdXR0b24uYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCB0b2dnbGVBdWRpbyk7CiAgY29uc3QgY29weUJ1dHRvbiA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdjb3B5LWpvaW4nKTsKICBpZiAoY29weUJ1dHRvbikgY29weUJ1dHRvbi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IGNvcHlUZXh0KHJvb20uam9pblVybCkpOwogIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLWNvbW1hbmRdJykuZm9yRWFjaCgoYnV0dG9uKSA9PiBidXR0b24uYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBhc3luYyAoKSA9PiB7CiAgICB0cnkgewogICAgICBlbnN1cmVBdWRpbygpOwogICAgICBidXR0b24uZGlzYWJsZWQgPSB0cnVlOwogICAgICBhd2FpdCBhcGkoJy9hcGkvYWRtaW4vY29tbWFuZCcsIHsgLi4uc3RhdGUucHJlc2VudGVyQ3JlZHMsIGNvbW1hbmQ6IGJ1dHRvbi5kYXRhc2V0LmNvbW1hbmQgfSk7CiAgICB9IGNhdGNoIChlcnJvcikgewogICAgICBidXR0b24uZGlzYWJsZWQgPSBmYWxzZTsKICAgICAgc2hvd1RvYXN0KGVycm9yLm1lc3NhZ2UpOwogICAgfQogIH0pKTsKICBjb25zdCBiYWNrID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2JhY2stZGFzaGJvYXJkJyk7CiAgaWYgKGJhY2spIGJhY2suYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBvcGVuQWRtaW4pOwogIGNvbnN0IHJlcGxhY2VtZW50QnV0dG9uID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ29wZW4tcmVwbGFjZW1lbnQnKTsKICBpZiAocmVwbGFjZW1lbnRCdXR0b24gJiYgcm9vbS5yZXBsYWNlbWVudCkgcmVwbGFjZW1lbnRCdXR0b24uYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7CiAgICBjb25zdCBjcmVkcyA9IHsgcm9vbUNvZGU6IHJvb20ucmVwbGFjZW1lbnQucm9vbUNvZGUsIGFkbWluVG9rZW46IHJvb20ucmVwbGFjZW1lbnQuYWRtaW5Ub2tlbiB9OwogICAgc2Vzc2lvblN0b3JhZ2Uuc2V0SXRlbShQUkVTRU5URVJfS0VZKHJvb20ucmVwbGFjZW1lbnQucm9vbUNvZGUpLCBKU09OLnN0cmluZ2lmeShjcmVkcykpOwogICAgbG9jYXRpb24uaHJlZiA9IGAvP3ByZXNlbnRlcj0ke2VuY29kZVVSSUNvbXBvbmVudChyb29tLnJlcGxhY2VtZW50LnJvb21Db2RlKX1gOwogIH0pOwp9Cgphc3luYyBmdW5jdGlvbiBvcGVuU2NyZWVuKHJvb21Db2RlKSB7CiAgdHJ5IHsKICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGFwaSgnL2FwaS9zY3JlZW4vam9pbicsIHsgcm9vbUNvZGUgfSk7CiAgICBzdGF0ZS5yb29tID0gcmVzdWx0LnN0YXRlOwogICAgb3BlblJvb21FdmVudHMoJ3NjcmVlbicsIHJvb21Db2RlKTsKICAgIHJlbmRlclNjcmVlblN0YXRlKCk7CiAgfSBjYXRjaCAoZXJyb3IpIHsKICAgIGFwcC5pbm5lckhUTUwgPSBgPGRpdiBjbGFzcz0id2FpdC1zY3JlZW4iPjxkaXYgY2xhc3M9IndhaXQtY2FyZCI+PGgxPlNhbGEgbsOjbyBlbmNvbnRyYWRhPC9oMT48cD4ke2VzY2FwZUh0bWwoZXJyb3IubWVzc2FnZSl9PC9wPjxhIGNsYXNzPSJidG4gYnRuLWxpZ2h0IiBocmVmPSIvIj5Wb2x0YXI8L2E+PC9kaXY+PC9kaXY+YDsKICB9Cn0KCmZ1bmN0aW9uIHJlbmRlclNjcmVlblN0YXRlKCkgewogIC8vIFRlbGEgc2VtIGNvbnRyb2xlcywgw7p0aWwgcXVhbmRvIG8gaW5zdHJ1dG9yIGRlc2VqYSBwcm9qZXRhciBlbSBvdXRybyBlcXVpcGFtZW50by4KICBjb25zdCByb29tID0gc3RhdGUucm9vbTsKICBzeW5jTXVzaWMocm9vbSk7CiAgaWYgKHJvb20ucGhhc2UgPT09ICdsb2JieScpIHsKICAgIGFwcC5pbm5lckhUTUwgPSBgPGRpdiBjbGFzcz0icHJlc2VudGVyLXNoZWxsIj4ke3ByZXNlbnRlckhlYWRlcihyb29tKX08bWFpbiBjbGFzcz0icHJlc2VudGVyLXN0YWdlIHRleHQtY2VudGVyIj48ZGl2IGNsYXNzPSJleWVicm93IiBzdHlsZT0ibWFyZ2luOmF1dG87YmFja2dyb3VuZDpyZ2JhKDI1NSwyNTUsMjU1LC4xNCk7Y29sb3I6d2hpdGUiPkVudHJlIG5hIHNhbGE8L2Rpdj48ZGl2IGNsYXNzPSJsb2JieS1jb2RlIj4ke3Jvb20ucm9vbUNvZGV9PC9kaXY+PGRpdiBpZD0ic2NyZWVuLXFyIiBjbGFzcz0icXItd3JhcCIgc3R5bGU9Im1hcmdpbjoyNHB4IGF1dG8iPjwvZGl2PjxoMj4ke3Jvb20ucGFydGljaXBhbnRDb3VudH0vJHtyb29tLm1heFBhcnRpY2lwYW50c30gcGFydGljaXBhbnRlczwvaDI+PC9tYWluPjwvZGl2PmA7CiAgICByZW5kZXJRcignc2NyZWVuLXFyJywgcm9vbS5qb2luVXJsLCAyODApOwogIH0gZWxzZSBpZiAocm9vbS5waGFzZSA9PT0gJ3F1ZXN0aW9uJykgewogICAgYXBwLmlubmVySFRNTCA9IGA8ZGl2IGNsYXNzPSJwcmVzZW50ZXItc2hlbGwiPiR7cHJlc2VudGVySGVhZGVyKHJvb20pfTxtYWluIGNsYXNzPSJwcmVzZW50ZXItc3RhZ2UiPjxkaXYgY2xhc3M9InF1ZXN0aW9uLXRvcCI+PHNwYW4+UGVyZ3VudGEgJHtyb29tLmN1cnJlbnRRdWVzdGlvbkluZGV4ICsgMX0vJHtyb29tLnRvdGFsUXVlc3Rpb25zfTwvc3Bhbj48ZGl2IGlkPSJ0aW1lciIgY2xhc3M9InRpbWVyIj4ke3Jvb20ucXVlc3Rpb24udGltZUxpbWl0fTwvZGl2PjxzcGFuPiR7cm9vbS5yZXNwb25zZUNvdW50fS8ke3Jvb20ucGFydGljaXBhbnRDb3VudH0gcmVzcG9zdGFzPC9zcGFuPjwvZGl2PjxoMSBjbGFzcz0icXVlc3Rpb24tdGl0bGUiPiR7ZXNjYXBlSHRtbChyb29tLnF1ZXN0aW9uLnRleHQpfTwvaDE+PGRpdiBjbGFzcz0iYW5zd2Vycy1ncmlkIj4ke3Jvb20ucXVlc3Rpb24ub3B0aW9ucy5tYXAoKG9wdGlvbikgPT4gYDxkaXYgY2xhc3M9ImFuc3dlci1jYXJkIj48c3BhbiBjbGFzcz0ic2hhcGUiPjwvc3Bhbj4ke2VzY2FwZUh0bWwob3B0aW9uKX08L2Rpdj5gKS5qb2luKCcnKX08L2Rpdj48L21haW4+PC9kaXY+YDsKICAgIHN0YXJ0Q291bnRkb3duKHJvb20pOwogIH0gZWxzZSBpZiAocm9vbS5waGFzZSA9PT0gJ2Fuc3dlcicpIHsKICAgIHJlbmRlclByZXNlbnRlckFuc3dlcihyb29tKTsKICAgIGNvbnN0IGRvY2sgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuY29udHJvbC1kb2NrJyk7IGlmIChkb2NrKSBkb2NrLnJlbW92ZSgpOwogIH0gZWxzZSBpZiAocm9vbS5waGFzZSA9PT0gJ3JhbmtpbmcnKSB7CiAgICBhcHAuaW5uZXJIVE1MID0gYDxkaXYgY2xhc3M9InByZXNlbnRlci1zaGVsbCI+JHtwcmVzZW50ZXJIZWFkZXIocm9vbSl9PG1haW4gY2xhc3M9InByZXNlbnRlci1zdGFnZSI+PGgxIGNsYXNzPSJxdWVzdGlvbi10aXRsZSI+UmFua2luZzwvaDE+JHtsZWFkZXJib2FyZE1hcmt1cChyb29tLmxlYWRlcmJvYXJkKX08L21haW4+PC9kaXY+YDsKICAgIHN0YXJ0UmFua2luZ0FuaW1hdGlvbihyb29tKTsKICB9IGVsc2UgewogICAgYXBwLmlubmVySFRNTCA9IGA8ZGl2IGNsYXNzPSJwcmVzZW50ZXItc2hlbGwiPiR7cHJlc2VudGVySGVhZGVyKHJvb20pfTxtYWluIGNsYXNzPSJwcmVzZW50ZXItc3RhZ2UgdGV4dC1jZW50ZXIiPjxoMSBjbGFzcz0icXVlc3Rpb24tdGl0bGUiPlDDs2RpbyBmaW5hbDwvaDE+JHtwb2RpdW1NYXJrdXAocm9vbSl9PC9tYWluPjwvZGl2PmA7CiAgfQogIGNvbnN0IGF1ZGlvQnV0dG9uID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2F1ZGlvLXRvZ2dsZScpOyBpZiAoYXVkaW9CdXR0b24pIGF1ZGlvQnV0dG9uLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgdG9nZ2xlQXVkaW8pOwp9CgpmdW5jdGlvbiBsZWFkZXJib2FyZE1hcmt1cChsZWFkZXJib2FyZCkgewogIHJldHVybiBgPGRpdiBjbGFzcz0ibGVhZGVyYm9hcmQiPiR7bGVhZGVyYm9hcmQubWFwKChlbnRyeSwgaW5kZXgpID0+IGA8ZGl2IGNsYXNzPSJyYW5rLXJvdyAke2VudHJ5LnBvc2l0aW9uIDw9IDMgPyBgdG9wLSR7ZW50cnkucG9zaXRpb259YCA6ICcnfSIgZGF0YS1yYW5rLXJvdyBzdHlsZT0iYW5pbWF0aW9uLWRlbGF5OiR7TWF0aC5taW4oaW5kZXgsMTIpICogLjEyfXMiPjxkaXYgY2xhc3M9InJhbmstcG9zaXRpb24iPiR7ZW50cnkucG9zaXRpb259wro8L2Rpdj4ke2F2YXRhclZpc3VhbChlbnRyeS5hdmF0YXIsdHJ1ZSl9PGRpdj48c3Ryb25nPiR7ZXNjYXBlSHRtbChlbnRyeS5uaWNrbmFtZSl9PC9zdHJvbmc+PGRpdiBjbGFzcz0ibXV0ZWQiPiR7ZW50cnkuY29ycmVjdEFuc3dlcnN9IGFjZXJ0b3MgJHtlbnRyeS5sYXN0UG9pbnRzID8gYMK3ICske2VudHJ5Lmxhc3RQb2ludHN9YCA6ICcnfTwvZGl2PjwvZGl2PjxkaXYgY2xhc3M9InJhbmstc2NvcmUiPiR7ZW50cnkuc2NvcmV9PC9kaXY+PC9kaXY+YCkuam9pbignJyl9PC9kaXY+YDsKfQoKZnVuY3Rpb24gc3RhcnRSYW5raW5nQW5pbWF0aW9uKHJvb20pIHsKICBjb25zdCBrZXkgPSBgJHtyb29tLnJvb21Db2RlfS0ke3Jvb20uY3VycmVudFF1ZXN0aW9uSW5kZXh9LSR7cm9vbS5waGFzZX1gOwogIGlmIChzdGF0ZS5sYXN0UmFua2luZ0tleSA9PT0ga2V5KSB7CiAgICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS1yYW5rLXJvd10nKS5mb3JFYWNoKChyb3cpID0+IHJvdy5jbGFzc0xpc3QuYWRkKCdyZXZlYWxlZCcpKTsKICAgIHJldHVybjsKICB9CiAgc3RhdGUubGFzdFJhbmtpbmdLZXkgPSBrZXk7CiAgcGxheVN1c3BlbnNlKCk7CiAgY29uc3Qgb3ZlcmxheSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpOwogIG92ZXJsYXkuY2xhc3NOYW1lID0gJ3N1c3BlbnNlLW92ZXJsYXknOwogIG92ZXJsYXkuaW5uZXJIVE1MID0gYDxkaXY+PGRpdiBpZD0ic3VzcGVuc2UtbnVtYmVyIiBjbGFzcz0ic3VzcGVuc2UtbnVtYmVyIj4zPC9kaXY+PGRpdiBjbGFzcz0ic3VzcGVuc2UtbGFiZWwiPlByZXBhcmFuZG8gbyByYW5raW5nLi4uPC9kaXY+PC9kaXY+YDsKICBkb2N1bWVudC5ib2R5LmFwcGVuZENoaWxkKG92ZXJsYXkpOwogIGNvbnN0IG51bWJlciA9IG92ZXJsYXkucXVlcnlTZWxlY3RvcignI3N1c3BlbnNlLW51bWJlcicpOwogIHNldFRpbWVvdXQoKCkgPT4gbnVtYmVyLnRleHRDb250ZW50ID0gJzInLCA5MDApOwogIHNldFRpbWVvdXQoKCkgPT4gbnVtYmVyLnRleHRDb250ZW50ID0gJzEnLCAxODAwKTsKICBzZXRUaW1lb3V0KCgpID0+IHsKICAgIG92ZXJsYXkucmVtb3ZlKCk7CiAgICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS1yYW5rLXJvd10nKS5mb3JFYWNoKChyb3cpID0+IHJvdy5jbGFzc0xpc3QuYWRkKCdyZXZlYWxlZCcpKTsKICB9LCAyODUwKTsKfQoKZnVuY3Rpb24gcG9kaXVtTWFya3VwKHJvb20pIHsKICBjb25zdCB0b3AgPSByb29tLmxlYWRlcmJvYXJkLnNsaWNlKDAsIDMpOwogIGNvbnN0IGdldCA9IChwb3NpdGlvbikgPT4gdG9wLmZpbmQoKGl0ZW0pID0+IGl0ZW0ucG9zaXRpb24gPT09IHBvc2l0aW9uKTsKICBjb25zdCBwbGFjZXMgPSBbCiAgICB7IHBvc2l0aW9uOiAyLCBjbGFzc05hbWU6ICdzZWNvbmQnLCBtZWRhbDogJ/CfpYgnLCBwcml6ZTogcm9vbS5wcml6ZXMuc2Vjb25kIH0sCiAgICB7IHBvc2l0aW9uOiAxLCBjbGFzc05hbWU6ICdmaXJzdCcsIG1lZGFsOiAn8J+lhycsIHByaXplOiByb29tLnByaXplcy5maXJzdCB9LAogICAgeyBwb3NpdGlvbjogMywgY2xhc3NOYW1lOiAndGhpcmQnLCBtZWRhbDogJ/CfpYknLCBwcml6ZTogcm9vbS5wcml6ZXMudGhpcmQgfSwKICBdOwogIHJldHVybiBgPGRpdiBjbGFzcz0icG9kaXVtIj4ke3BsYWNlcy5tYXAoKHBsYWNlKSA9PiB7CiAgICBjb25zdCBwZXJzb24gPSBnZXQocGxhY2UucG9zaXRpb24pOwogICAgcmV0dXJuIGA8ZGl2IGNsYXNzPSJwb2RpdW0tcGxhY2UgJHtwbGFjZS5jbGFzc05hbWV9Ij48ZGl2PiR7cGVyc29uID8gYXZhdGFyVmlzdWFsKHBlcnNvbi5hdmF0YXIsdHJ1ZSkgOiAnJ308L2Rpdj48ZGl2IGNsYXNzPSJwb2RpdW0tbmFtZSI+JHtwZXJzb24gPyBlc2NhcGVIdG1sKHBlcnNvbi5uaWNrbmFtZSkgOiAn4oCUJ308L2Rpdj48ZGl2IGNsYXNzPSJwb2RpdW0tcHJpemUiPiR7ZXNjYXBlSHRtbChwbGFjZS5wcml6ZSB8fCAnJyl9PC9kaXY+PGRpdiBjbGFzcz0icG9kaXVtLXN0ZXAiPiR7cGxhY2UubWVkYWx9PC9kaXY+PC9kaXY+YDsKICB9KS5qb2luKCcnKX08L2Rpdj5gOwp9Cgp3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcignYmVmb3JldW5sb2FkJywgKCkgPT4gewogIGlmIChzdGF0ZS5ldmVudFNvdXJjZSkgc3RhdGUuZXZlbnRTb3VyY2UuY2xvc2UoKTsKICBzdG9wTXVzaWMoKTsKfSk7Cgppbml0KCk7Cg==', 'base64') }],
  ['/qrcode.min.js', { type: 'application/javascript; charset=utf-8', data: Buffer.from('dmFyIFFSQ29kZTshZnVuY3Rpb24oKXtmdW5jdGlvbiBhKGEpe3RoaXMubW9kZT1jLk1PREVfOEJJVF9CWVRFLHRoaXMuZGF0YT1hLHRoaXMucGFyc2VkRGF0YT1bXTtmb3IodmFyIGI9W10sZD0wLGU9dGhpcy5kYXRhLmxlbmd0aDtlPmQ7ZCsrKXt2YXIgZj10aGlzLmRhdGEuY2hhckNvZGVBdChkKTtmPjY1NTM2PyhiWzBdPTI0MHwoMTgzNTAwOCZmKT4+PjE4LGJbMV09MTI4fCgyNTgwNDgmZik+Pj4xMixiWzJdPTEyOHwoNDAzMiZmKT4+PjYsYlszXT0xMjh8NjMmZik6Zj4yMDQ4PyhiWzBdPTIyNHwoNjE0NDAmZik+Pj4xMixiWzFdPTEyOHwoNDAzMiZmKT4+PjYsYlsyXT0xMjh8NjMmZik6Zj4xMjg/KGJbMF09MTkyfCgxOTg0JmYpPj4+NixiWzFdPTEyOHw2MyZmKTpiWzBdPWYsdGhpcy5wYXJzZWREYXRhPXRoaXMucGFyc2VkRGF0YS5jb25jYXQoYil9dGhpcy5wYXJzZWREYXRhLmxlbmd0aCE9dGhpcy5kYXRhLmxlbmd0aCYmKHRoaXMucGFyc2VkRGF0YS51bnNoaWZ0KDE5MSksdGhpcy5wYXJzZWREYXRhLnVuc2hpZnQoMTg3KSx0aGlzLnBhcnNlZERhdGEudW5zaGlmdCgyMzkpKX1mdW5jdGlvbiBiKGEsYil7dGhpcy50eXBlTnVtYmVyPWEsdGhpcy5lcnJvckNvcnJlY3RMZXZlbD1iLHRoaXMubW9kdWxlcz1udWxsLHRoaXMubW9kdWxlQ291bnQ9MCx0aGlzLmRhdGFDYWNoZT1udWxsLHRoaXMuZGF0YUxpc3Q9W119ZnVuY3Rpb24gaShhLGIpe2lmKHZvaWQgMD09YS5sZW5ndGgpdGhyb3cgbmV3IEVycm9yKGEubGVuZ3RoKyIvIitiKTtmb3IodmFyIGM9MDtjPGEubGVuZ3RoJiYwPT1hW2NdOyljKys7dGhpcy5udW09bmV3IEFycmF5KGEubGVuZ3RoLWMrYik7Zm9yKHZhciBkPTA7ZDxhLmxlbmd0aC1jO2QrKyl0aGlzLm51bVtkXT1hW2QrY119ZnVuY3Rpb24gaihhLGIpe3RoaXMudG90YWxDb3VudD1hLHRoaXMuZGF0YUNvdW50PWJ9ZnVuY3Rpb24gaygpe3RoaXMuYnVmZmVyPVtdLHRoaXMubGVuZ3RoPTB9ZnVuY3Rpb24gbSgpe3JldHVybiJ1bmRlZmluZWQiIT10eXBlb2YgQ2FudmFzUmVuZGVyaW5nQ29udGV4dDJEfWZ1bmN0aW9uIG4oKXt2YXIgYT0hMSxiPW5hdmlnYXRvci51c2VyQWdlbnQ7cmV0dXJuL2FuZHJvaWQvaS50ZXN0KGIpJiYoYT0hMCxhTWF0PWIudG9TdHJpbmcoKS5tYXRjaCgvYW5kcm9pZCAoWzAtOV1cLlswLTldKS9pKSxhTWF0JiZhTWF0WzFdJiYoYT1wYXJzZUZsb2F0KGFNYXRbMV0pKSksYX1mdW5jdGlvbiByKGEsYil7Zm9yKHZhciBjPTEsZT1zKGEpLGY9MCxnPWwubGVuZ3RoO2c+PWY7ZisrKXt2YXIgaD0wO3N3aXRjaChiKXtjYXNlIGQuTDpoPWxbZl1bMF07YnJlYWs7Y2FzZSBkLk06aD1sW2ZdWzFdO2JyZWFrO2Nhc2UgZC5ROmg9bFtmXVsyXTticmVhaztjYXNlIGQuSDpoPWxbZl1bM119aWYoaD49ZSlicmVhaztjKyt9aWYoYz5sLmxlbmd0aCl0aHJvdyBuZXcgRXJyb3IoIlRvbyBsb25nIGRhdGEiKTtyZXR1cm4gY31mdW5jdGlvbiBzKGEpe3ZhciBiPWVuY29kZVVSSShhKS50b1N0cmluZygpLnJlcGxhY2UoL1wlWzAtOWEtZkEtRl17Mn0vZywiYSIpO3JldHVybiBiLmxlbmd0aCsoYi5sZW5ndGghPWE/MzowKX1hLnByb3RvdHlwZT17Z2V0TGVuZ3RoOmZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMucGFyc2VkRGF0YS5sZW5ndGh9LHdyaXRlOmZ1bmN0aW9uKGEpe2Zvcih2YXIgYj0wLGM9dGhpcy5wYXJzZWREYXRhLmxlbmd0aDtjPmI7YisrKWEucHV0KHRoaXMucGFyc2VkRGF0YVtiXSw4KX19LGIucHJvdG90eXBlPXthZGREYXRhOmZ1bmN0aW9uKGIpe3ZhciBjPW5ldyBhKGIpO3RoaXMuZGF0YUxpc3QucHVzaChjKSx0aGlzLmRhdGFDYWNoZT1udWxsfSxpc0Rhcms6ZnVuY3Rpb24oYSxiKXtpZigwPmF8fHRoaXMubW9kdWxlQ291bnQ8PWF8fDA+Ynx8dGhpcy5tb2R1bGVDb3VudDw9Yil0aHJvdyBuZXcgRXJyb3IoYSsiLCIrYik7cmV0dXJuIHRoaXMubW9kdWxlc1thXVtiXX0sZ2V0TW9kdWxlQ291bnQ6ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy5tb2R1bGVDb3VudH0sbWFrZTpmdW5jdGlvbigpe3RoaXMubWFrZUltcGwoITEsdGhpcy5nZXRCZXN0TWFza1BhdHRlcm4oKSl9LG1ha2VJbXBsOmZ1bmN0aW9uKGEsYyl7dGhpcy5tb2R1bGVDb3VudD00KnRoaXMudHlwZU51bWJlcisxNyx0aGlzLm1vZHVsZXM9bmV3IEFycmF5KHRoaXMubW9kdWxlQ291bnQpO2Zvcih2YXIgZD0wO2Q8dGhpcy5tb2R1bGVDb3VudDtkKyspe3RoaXMubW9kdWxlc1tkXT1uZXcgQXJyYXkodGhpcy5tb2R1bGVDb3VudCk7Zm9yKHZhciBlPTA7ZTx0aGlzLm1vZHVsZUNvdW50O2UrKyl0aGlzLm1vZHVsZXNbZF1bZV09bnVsbH10aGlzLnNldHVwUG9zaXRpb25Qcm9iZVBhdHRlcm4oMCwwKSx0aGlzLnNldHVwUG9zaXRpb25Qcm9iZVBhdHRlcm4odGhpcy5tb2R1bGVDb3VudC03LDApLHRoaXMuc2V0dXBQb3NpdGlvblByb2JlUGF0dGVybigwLHRoaXMubW9kdWxlQ291bnQtNyksdGhpcy5zZXR1cFBvc2l0aW9uQWRqdXN0UGF0dGVybigpLHRoaXMuc2V0dXBUaW1pbmdQYXR0ZXJuKCksdGhpcy5zZXR1cFR5cGVJbmZvKGEsYyksdGhpcy50eXBlTnVtYmVyPj03JiZ0aGlzLnNldHVwVHlwZU51bWJlcihhKSxudWxsPT10aGlzLmRhdGFDYWNoZSYmKHRoaXMuZGF0YUNhY2hlPWIuY3JlYXRlRGF0YSh0aGlzLnR5cGVOdW1iZXIsdGhpcy5lcnJvckNvcnJlY3RMZXZlbCx0aGlzLmRhdGFMaXN0KSksdGhpcy5tYXBEYXRhKHRoaXMuZGF0YUNhY2hlLGMpfSxzZXR1cFBvc2l0aW9uUHJvYmVQYXR0ZXJuOmZ1bmN0aW9uKGEsYil7Zm9yKHZhciBjPS0xOzc+PWM7YysrKWlmKCEoLTE+PWErY3x8dGhpcy5tb2R1bGVDb3VudDw9YStjKSlmb3IodmFyIGQ9LTE7Nz49ZDtkKyspLTE+PWIrZHx8dGhpcy5tb2R1bGVDb3VudDw9YitkfHwodGhpcy5tb2R1bGVzW2ErY11bYitkXT1jPj0wJiY2Pj1jJiYoMD09ZHx8Nj09ZCl8fGQ+PTAmJjY+PWQmJigwPT1jfHw2PT1jKXx8Yz49MiYmND49YyYmZD49MiYmND49ZD8hMDohMSl9LGdldEJlc3RNYXNrUGF0dGVybjpmdW5jdGlvbigpe2Zvcih2YXIgYT0wLGI9MCxjPTA7OD5jO2MrKyl7dGhpcy5tYWtlSW1wbCghMCxjKTt2YXIgZD1mLmdldExvc3RQb2ludCh0aGlzKTsoMD09Y3x8YT5kKSYmKGE9ZCxiPWMpfXJldHVybiBifSxjcmVhdGVNb3ZpZUNsaXA6ZnVuY3Rpb24oYSxiLGMpe3ZhciBkPWEuY3JlYXRlRW1wdHlNb3ZpZUNsaXAoYixjKSxlPTE7dGhpcy5tYWtlKCk7Zm9yKHZhciBmPTA7Zjx0aGlzLm1vZHVsZXMubGVuZ3RoO2YrKylmb3IodmFyIGc9ZiplLGg9MDtoPHRoaXMubW9kdWxlc1tmXS5sZW5ndGg7aCsrKXt2YXIgaT1oKmUsaj10aGlzLm1vZHVsZXNbZl1baF07aiYmKGQuYmVnaW5GaWxsKDAsMTAwKSxkLm1vdmVUbyhpLGcpLGQubGluZVRvKGkrZSxnKSxkLmxpbmVUbyhpK2UsZytlKSxkLmxpbmVUbyhpLGcrZSksZC5lbmRGaWxsKCkpfXJldHVybiBkfSxzZXR1cFRpbWluZ1BhdHRlcm46ZnVuY3Rpb24oKXtmb3IodmFyIGE9ODthPHRoaXMubW9kdWxlQ291bnQtODthKyspbnVsbD09dGhpcy5tb2R1bGVzW2FdWzZdJiYodGhpcy5tb2R1bGVzW2FdWzZdPTA9PWElMik7Zm9yKHZhciBiPTg7Yjx0aGlzLm1vZHVsZUNvdW50LTg7YisrKW51bGw9PXRoaXMubW9kdWxlc1s2XVtiXSYmKHRoaXMubW9kdWxlc1s2XVtiXT0wPT1iJTIpfSxzZXR1cFBvc2l0aW9uQWRqdXN0UGF0dGVybjpmdW5jdGlvbigpe2Zvcih2YXIgYT1mLmdldFBhdHRlcm5Qb3NpdGlvbih0aGlzLnR5cGVOdW1iZXIpLGI9MDtiPGEubGVuZ3RoO2IrKylmb3IodmFyIGM9MDtjPGEubGVuZ3RoO2MrKyl7dmFyIGQ9YVtiXSxlPWFbY107aWYobnVsbD09dGhpcy5tb2R1bGVzW2RdW2VdKWZvcih2YXIgZz0tMjsyPj1nO2crKylmb3IodmFyIGg9LTI7Mj49aDtoKyspdGhpcy5tb2R1bGVzW2QrZ11bZStoXT0tMj09Z3x8Mj09Z3x8LTI9PWh8fDI9PWh8fDA9PWcmJjA9PWg/ITA6ITF9fSxzZXR1cFR5cGVOdW1iZXI6ZnVuY3Rpb24oYSl7Zm9yKHZhciBiPWYuZ2V0QkNIVHlwZU51bWJlcih0aGlzLnR5cGVOdW1iZXIpLGM9MDsxOD5jO2MrKyl7dmFyIGQ9IWEmJjE9PSgxJmI+PmMpO3RoaXMubW9kdWxlc1tNYXRoLmZsb29yKGMvMyldW2MlMyt0aGlzLm1vZHVsZUNvdW50LTgtM109ZH1mb3IodmFyIGM9MDsxOD5jO2MrKyl7dmFyIGQ9IWEmJjE9PSgxJmI+PmMpO3RoaXMubW9kdWxlc1tjJTMrdGhpcy5tb2R1bGVDb3VudC04LTNdW01hdGguZmxvb3IoYy8zKV09ZH19LHNldHVwVHlwZUluZm86ZnVuY3Rpb24oYSxiKXtmb3IodmFyIGM9dGhpcy5lcnJvckNvcnJlY3RMZXZlbDw8M3xiLGQ9Zi5nZXRCQ0hUeXBlSW5mbyhjKSxlPTA7MTU+ZTtlKyspe3ZhciBnPSFhJiYxPT0oMSZkPj5lKTs2PmU/dGhpcy5tb2R1bGVzW2VdWzhdPWc6OD5lP3RoaXMubW9kdWxlc1tlKzFdWzhdPWc6dGhpcy5tb2R1bGVzW3RoaXMubW9kdWxlQ291bnQtMTUrZV1bOF09Z31mb3IodmFyIGU9MDsxNT5lO2UrKyl7dmFyIGc9IWEmJjE9PSgxJmQ+PmUpOzg+ZT90aGlzLm1vZHVsZXNbOF1bdGhpcy5tb2R1bGVDb3VudC1lLTFdPWc6OT5lP3RoaXMubW9kdWxlc1s4XVsxNS1lLTErMV09Zzp0aGlzLm1vZHVsZXNbOF1bMTUtZS0xXT1nfXRoaXMubW9kdWxlc1t0aGlzLm1vZHVsZUNvdW50LThdWzhdPSFhfSxtYXBEYXRhOmZ1bmN0aW9uKGEsYil7Zm9yKHZhciBjPS0xLGQ9dGhpcy5tb2R1bGVDb3VudC0xLGU9NyxnPTAsaD10aGlzLm1vZHVsZUNvdW50LTE7aD4wO2gtPTIpZm9yKDY9PWgmJmgtLTs7KXtmb3IodmFyIGk9MDsyPmk7aSsrKWlmKG51bGw9PXRoaXMubW9kdWxlc1tkXVtoLWldKXt2YXIgaj0hMTtnPGEubGVuZ3RoJiYoaj0xPT0oMSZhW2ddPj4+ZSkpO3ZhciBrPWYuZ2V0TWFzayhiLGQsaC1pKTtrJiYoaj0haiksdGhpcy5tb2R1bGVzW2RdW2gtaV09aixlLS0sLTE9PWUmJihnKyssZT03KX1pZihkKz1jLDA+ZHx8dGhpcy5tb2R1bGVDb3VudDw9ZCl7ZC09YyxjPS1jO2JyZWFrfX19fSxiLlBBRDA9MjM2LGIuUEFEMT0xNyxiLmNyZWF0ZURhdGE9ZnVuY3Rpb24oYSxjLGQpe2Zvcih2YXIgZT1qLmdldFJTQmxvY2tzKGEsYyksZz1uZXcgayxoPTA7aDxkLmxlbmd0aDtoKyspe3ZhciBpPWRbaF07Zy5wdXQoaS5tb2RlLDQpLGcucHV0KGkuZ2V0TGVuZ3RoKCksZi5nZXRMZW5ndGhJbkJpdHMoaS5tb2RlLGEpKSxpLndyaXRlKGcpfWZvcih2YXIgbD0wLGg9MDtoPGUubGVuZ3RoO2grKylsKz1lW2hdLmRhdGFDb3VudDtpZihnLmdldExlbmd0aEluQml0cygpPjgqbCl0aHJvdyBuZXcgRXJyb3IoImNvZGUgbGVuZ3RoIG92ZXJmbG93LiAoIitnLmdldExlbmd0aEluQml0cygpKyI+Iis4KmwrIikiKTtmb3IoZy5nZXRMZW5ndGhJbkJpdHMoKSs0PD04KmwmJmcucHV0KDAsNCk7MCE9Zy5nZXRMZW5ndGhJbkJpdHMoKSU4OylnLnB1dEJpdCghMSk7Zm9yKDs7KXtpZihnLmdldExlbmd0aEluQml0cygpPj04KmwpYnJlYWs7aWYoZy5wdXQoYi5QQUQwLDgpLGcuZ2V0TGVuZ3RoSW5CaXRzKCk+PTgqbClicmVhaztnLnB1dChiLlBBRDEsOCl9cmV0dXJuIGIuY3JlYXRlQnl0ZXMoZyxlKX0sYi5jcmVhdGVCeXRlcz1mdW5jdGlvbihhLGIpe2Zvcih2YXIgYz0wLGQ9MCxlPTAsZz1uZXcgQXJyYXkoYi5sZW5ndGgpLGg9bmV3IEFycmF5KGIubGVuZ3RoKSxqPTA7ajxiLmxlbmd0aDtqKyspe3ZhciBrPWJbal0uZGF0YUNvdW50LGw9YltqXS50b3RhbENvdW50LWs7ZD1NYXRoLm1heChkLGspLGU9TWF0aC5tYXgoZSxsKSxnW2pdPW5ldyBBcnJheShrKTtmb3IodmFyIG09MDttPGdbal0ubGVuZ3RoO20rKylnW2pdW21dPTI1NSZhLmJ1ZmZlclttK2NdO2MrPWs7dmFyIG49Zi5nZXRFcnJvckNvcnJlY3RQb2x5bm9taWFsKGwpLG89bmV3IGkoZ1tqXSxuLmdldExlbmd0aCgpLTEpLHA9by5tb2Qobik7aFtqXT1uZXcgQXJyYXkobi5nZXRMZW5ndGgoKS0xKTtmb3IodmFyIG09MDttPGhbal0ubGVuZ3RoO20rKyl7dmFyIHE9bStwLmdldExlbmd0aCgpLWhbal0ubGVuZ3RoO2hbal1bbV09cT49MD9wLmdldChxKTowfX1mb3IodmFyIHI9MCxtPTA7bTxiLmxlbmd0aDttKyspcis9YlttXS50b3RhbENvdW50O2Zvcih2YXIgcz1uZXcgQXJyYXkociksdD0wLG09MDtkPm07bSsrKWZvcih2YXIgaj0wO2o8Yi5sZW5ndGg7aisrKW08Z1tqXS5sZW5ndGgmJihzW3QrK109Z1tqXVttXSk7Zm9yKHZhciBtPTA7ZT5tO20rKylmb3IodmFyIGo9MDtqPGIubGVuZ3RoO2orKyltPGhbal0ubGVuZ3RoJiYoc1t0KytdPWhbal1bbV0pO3JldHVybiBzfTtmb3IodmFyIGM9e01PREVfTlVNQkVSOjEsTU9ERV9BTFBIQV9OVU06MixNT0RFXzhCSVRfQllURTo0LE1PREVfS0FOSkk6OH0sZD17TDoxLE06MCxROjMsSDoyfSxlPXtQQVRURVJOMDAwOjAsUEFUVEVSTjAwMToxLFBBVFRFUk4wMTA6MixQQVRURVJOMDExOjMsUEFUVEVSTjEwMDo0LFBBVFRFUk4xMDE6NSxQQVRURVJOMTEwOjYsUEFUVEVSTjExMTo3fSxmPXtQQVRURVJOX1BPU0lUSU9OX1RBQkxFOltbXSxbNiwxOF0sWzYsMjJdLFs2LDI2XSxbNiwzMF0sWzYsMzRdLFs2LDIyLDM4XSxbNiwyNCw0Ml0sWzYsMjYsNDZdLFs2LDI4LDUwXSxbNiwzMCw1NF0sWzYsMzIsNThdLFs2LDM0LDYyXSxbNiwyNiw0Niw2Nl0sWzYsMjYsNDgsNzBdLFs2LDI2LDUwLDc0XSxbNiwzMCw1NCw3OF0sWzYsMzAsNTYsODJdLFs2LDMwLDU4LDg2XSxbNiwzNCw2Miw5MF0sWzYsMjgsNTAsNzIsOTRdLFs2LDI2LDUwLDc0LDk4XSxbNiwzMCw1NCw3OCwxMDJdLFs2LDI4LDU0LDgwLDEwNl0sWzYsMzIsNTgsODQsMTEwXSxbNiwzMCw1OCw4NiwxMTRdLFs2LDM0LDYyLDkwLDExOF0sWzYsMjYsNTAsNzQsOTgsMTIyXSxbNiwzMCw1NCw3OCwxMDIsMTI2XSxbNiwyNiw1Miw3OCwxMDQsMTMwXSxbNiwzMCw1Niw4MiwxMDgsMTM0XSxbNiwzNCw2MCw4NiwxMTIsMTM4XSxbNiwzMCw1OCw4NiwxMTQsMTQyXSxbNiwzNCw2Miw5MCwxMTgsMTQ2XSxbNiwzMCw1NCw3OCwxMDIsMTI2LDE1MF0sWzYsMjQsNTAsNzYsMTAyLDEyOCwxNTRdLFs2LDI4LDU0LDgwLDEwNiwxMzIsMTU4XSxbNiwzMiw1OCw4NCwxMTAsMTM2LDE2Ml0sWzYsMjYsNTQsODIsMTEwLDEzOCwxNjZdLFs2LDMwLDU4LDg2LDExNCwxNDIsMTcwXV0sRzE1OjEzMzUsRzE4Ojc5NzMsRzE1X01BU0s6MjE1MjIsZ2V0QkNIVHlwZUluZm86ZnVuY3Rpb24oYSl7Zm9yKHZhciBiPWE8PDEwO2YuZ2V0QkNIRGlnaXQoYiktZi5nZXRCQ0hEaWdpdChmLkcxNSk+PTA7KWJePWYuRzE1PDxmLmdldEJDSERpZ2l0KGIpLWYuZ2V0QkNIRGlnaXQoZi5HMTUpO3JldHVybihhPDwxMHxiKV5mLkcxNV9NQVNLfSxnZXRCQ0hUeXBlTnVtYmVyOmZ1bmN0aW9uKGEpe2Zvcih2YXIgYj1hPDwxMjtmLmdldEJDSERpZ2l0KGIpLWYuZ2V0QkNIRGlnaXQoZi5HMTgpPj0wOyliXj1mLkcxODw8Zi5nZXRCQ0hEaWdpdChiKS1mLmdldEJDSERpZ2l0KGYuRzE4KTtyZXR1cm4gYTw8MTJ8Yn0sZ2V0QkNIRGlnaXQ6ZnVuY3Rpb24oYSl7Zm9yKHZhciBiPTA7MCE9YTspYisrLGE+Pj49MTtyZXR1cm4gYn0sZ2V0UGF0dGVyblBvc2l0aW9uOmZ1bmN0aW9uKGEpe3JldHVybiBmLlBBVFRFUk5fUE9TSVRJT05fVEFCTEVbYS0xXX0sZ2V0TWFzazpmdW5jdGlvbihhLGIsYyl7c3dpdGNoKGEpe2Nhc2UgZS5QQVRURVJOMDAwOnJldHVybiAwPT0oYitjKSUyO2Nhc2UgZS5QQVRURVJOMDAxOnJldHVybiAwPT1iJTI7Y2FzZSBlLlBBVFRFUk4wMTA6cmV0dXJuIDA9PWMlMztjYXNlIGUuUEFUVEVSTjAxMTpyZXR1cm4gMD09KGIrYyklMztjYXNlIGUuUEFUVEVSTjEwMDpyZXR1cm4gMD09KE1hdGguZmxvb3IoYi8yKStNYXRoLmZsb29yKGMvMykpJTI7Y2FzZSBlLlBBVFRFUk4xMDE6cmV0dXJuIDA9PWIqYyUyK2IqYyUzO2Nhc2UgZS5QQVRURVJOMTEwOnJldHVybiAwPT0oYipjJTIrYipjJTMpJTI7Y2FzZSBlLlBBVFRFUk4xMTE6cmV0dXJuIDA9PShiKmMlMysoYitjKSUyKSUyO2RlZmF1bHQ6dGhyb3cgbmV3IEVycm9yKCJiYWQgbWFza1BhdHRlcm46IithKX19LGdldEVycm9yQ29ycmVjdFBvbHlub21pYWw6ZnVuY3Rpb24oYSl7Zm9yKHZhciBiPW5ldyBpKFsxXSwwKSxjPTA7YT5jO2MrKyliPWIubXVsdGlwbHkobmV3IGkoWzEsZy5nZXhwKGMpXSwwKSk7cmV0dXJuIGJ9LGdldExlbmd0aEluQml0czpmdW5jdGlvbihhLGIpe2lmKGI+PTEmJjEwPmIpc3dpdGNoKGEpe2Nhc2UgYy5NT0RFX05VTUJFUjpyZXR1cm4gMTA7Y2FzZSBjLk1PREVfQUxQSEFfTlVNOnJldHVybiA5O2Nhc2UgYy5NT0RFXzhCSVRfQllURTpyZXR1cm4gODtjYXNlIGMuTU9ERV9LQU5KSTpyZXR1cm4gODtkZWZhdWx0OnRocm93IG5ldyBFcnJvcigibW9kZToiK2EpfWVsc2UgaWYoMjc+Yilzd2l0Y2goYSl7Y2FzZSBjLk1PREVfTlVNQkVSOnJldHVybiAxMjtjYXNlIGMuTU9ERV9BTFBIQV9OVU06cmV0dXJuIDExO2Nhc2UgYy5NT0RFXzhCSVRfQllURTpyZXR1cm4gMTY7Y2FzZSBjLk1PREVfS0FOSkk6cmV0dXJuIDEwO2RlZmF1bHQ6dGhyb3cgbmV3IEVycm9yKCJtb2RlOiIrYSl9ZWxzZXtpZighKDQxPmIpKXRocm93IG5ldyBFcnJvcigidHlwZToiK2IpO3N3aXRjaChhKXtjYXNlIGMuTU9ERV9OVU1CRVI6cmV0dXJuIDE0O2Nhc2UgYy5NT0RFX0FMUEhBX05VTTpyZXR1cm4gMTM7Y2FzZSBjLk1PREVfOEJJVF9CWVRFOnJldHVybiAxNjtjYXNlIGMuTU9ERV9LQU5KSTpyZXR1cm4gMTI7ZGVmYXVsdDp0aHJvdyBuZXcgRXJyb3IoIm1vZGU6IithKX19fSxnZXRMb3N0UG9pbnQ6ZnVuY3Rpb24oYSl7Zm9yKHZhciBiPWEuZ2V0TW9kdWxlQ291bnQoKSxjPTAsZD0wO2I+ZDtkKyspZm9yKHZhciBlPTA7Yj5lO2UrKyl7Zm9yKHZhciBmPTAsZz1hLmlzRGFyayhkLGUpLGg9LTE7MT49aDtoKyspaWYoISgwPmQraHx8ZCtoPj1iKSlmb3IodmFyIGk9LTE7MT49aTtpKyspMD5lK2l8fGUraT49Ynx8KDAhPWh8fDAhPWkpJiZnPT1hLmlzRGFyayhkK2gsZStpKSYmZisrO2Y+NSYmKGMrPTMrZi01KX1mb3IodmFyIGQ9MDtiLTE+ZDtkKyspZm9yKHZhciBlPTA7Yi0xPmU7ZSsrKXt2YXIgaj0wO2EuaXNEYXJrKGQsZSkmJmorKyxhLmlzRGFyayhkKzEsZSkmJmorKyxhLmlzRGFyayhkLGUrMSkmJmorKyxhLmlzRGFyayhkKzEsZSsxKSYmaisrLCgwPT1qfHw0PT1qKSYmKGMrPTMpfWZvcih2YXIgZD0wO2I+ZDtkKyspZm9yKHZhciBlPTA7Yi02PmU7ZSsrKWEuaXNEYXJrKGQsZSkmJiFhLmlzRGFyayhkLGUrMSkmJmEuaXNEYXJrKGQsZSsyKSYmYS5pc0RhcmsoZCxlKzMpJiZhLmlzRGFyayhkLGUrNCkmJiFhLmlzRGFyayhkLGUrNSkmJmEuaXNEYXJrKGQsZSs2KSYmKGMrPTQwKTtmb3IodmFyIGU9MDtiPmU7ZSsrKWZvcih2YXIgZD0wO2ItNj5kO2QrKylhLmlzRGFyayhkLGUpJiYhYS5pc0RhcmsoZCsxLGUpJiZhLmlzRGFyayhkKzIsZSkmJmEuaXNEYXJrKGQrMyxlKSYmYS5pc0RhcmsoZCs0LGUpJiYhYS5pc0RhcmsoZCs1LGUpJiZhLmlzRGFyayhkKzYsZSkmJihjKz00MCk7Zm9yKHZhciBrPTAsZT0wO2I+ZTtlKyspZm9yKHZhciBkPTA7Yj5kO2QrKylhLmlzRGFyayhkLGUpJiZrKys7dmFyIGw9TWF0aC5hYnMoMTAwKmsvYi9iLTUwKS81O3JldHVybiBjKz0xMCpsfX0sZz17Z2xvZzpmdW5jdGlvbihhKXtpZigxPmEpdGhyb3cgbmV3IEVycm9yKCJnbG9nKCIrYSsiKSIpO3JldHVybiBnLkxPR19UQUJMRVthXX0sZ2V4cDpmdW5jdGlvbihhKXtmb3IoOzA+YTspYSs9MjU1O2Zvcig7YT49MjU2OylhLT0yNTU7cmV0dXJuIGcuRVhQX1RBQkxFW2FdfSxFWFBfVEFCTEU6bmV3IEFycmF5KDI1NiksTE9HX1RBQkxFOm5ldyBBcnJheSgyNTYpfSxoPTA7OD5oO2grKylnLkVYUF9UQUJMRVtoXT0xPDxoO2Zvcih2YXIgaD04OzI1Nj5oO2grKylnLkVYUF9UQUJMRVtoXT1nLkVYUF9UQUJMRVtoLTRdXmcuRVhQX1RBQkxFW2gtNV1eZy5FWFBfVEFCTEVbaC02XV5nLkVYUF9UQUJMRVtoLThdO2Zvcih2YXIgaD0wOzI1NT5oO2grKylnLkxPR19UQUJMRVtnLkVYUF9UQUJMRVtoXV09aDtpLnByb3RvdHlwZT17Z2V0OmZ1bmN0aW9uKGEpe3JldHVybiB0aGlzLm51bVthXX0sZ2V0TGVuZ3RoOmZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMubnVtLmxlbmd0aH0sbXVsdGlwbHk6ZnVuY3Rpb24oYSl7Zm9yKHZhciBiPW5ldyBBcnJheSh0aGlzLmdldExlbmd0aCgpK2EuZ2V0TGVuZ3RoKCktMSksYz0wO2M8dGhpcy5nZXRMZW5ndGgoKTtjKyspZm9yKHZhciBkPTA7ZDxhLmdldExlbmd0aCgpO2QrKyliW2MrZF1ePWcuZ2V4cChnLmdsb2codGhpcy5nZXQoYykpK2cuZ2xvZyhhLmdldChkKSkpO3JldHVybiBuZXcgaShiLDApfSxtb2Q6ZnVuY3Rpb24oYSl7aWYodGhpcy5nZXRMZW5ndGgoKS1hLmdldExlbmd0aCgpPDApcmV0dXJuIHRoaXM7Zm9yKHZhciBiPWcuZ2xvZyh0aGlzLmdldCgwKSktZy5nbG9nKGEuZ2V0KDApKSxjPW5ldyBBcnJheSh0aGlzLmdldExlbmd0aCgpKSxkPTA7ZDx0aGlzLmdldExlbmd0aCgpO2QrKyljW2RdPXRoaXMuZ2V0KGQpO2Zvcih2YXIgZD0wO2Q8YS5nZXRMZW5ndGgoKTtkKyspY1tkXV49Zy5nZXhwKGcuZ2xvZyhhLmdldChkKSkrYik7cmV0dXJuIG5ldyBpKGMsMCkubW9kKGEpfX0sai5SU19CTE9DS19UQUJMRT1bWzEsMjYsMTldLFsxLDI2LDE2XSxbMSwyNiwxM10sWzEsMjYsOV0sWzEsNDQsMzRdLFsxLDQ0LDI4XSxbMSw0NCwyMl0sWzEsNDQsMTZdLFsxLDcwLDU1XSxbMSw3MCw0NF0sWzIsMzUsMTddLFsyLDM1LDEzXSxbMSwxMDAsODBdLFsyLDUwLDMyXSxbMiw1MCwyNF0sWzQsMjUsOV0sWzEsMTM0LDEwOF0sWzIsNjcsNDNdLFsyLDMzLDE1LDIsMzQsMTZdLFsyLDMzLDExLDIsMzQsMTJdLFsyLDg2LDY4XSxbNCw0MywyN10sWzQsNDMsMTldLFs0LDQzLDE1XSxbMiw5OCw3OF0sWzQsNDksMzFdLFsyLDMyLDE0LDQsMzMsMTVdLFs0LDM5LDEzLDEsNDAsMTRdLFsyLDEyMSw5N10sWzIsNjAsMzgsMiw2MSwzOV0sWzQsNDAsMTgsMiw0MSwxOV0sWzQsNDAsMTQsMiw0MSwxNV0sWzIsMTQ2LDExNl0sWzMsNTgsMzYsMiw1OSwzN10sWzQsMzYsMTYsNCwzNywxN10sWzQsMzYsMTIsNCwzNywxM10sWzIsODYsNjgsMiw4Nyw2OV0sWzQsNjksNDMsMSw3MCw0NF0sWzYsNDMsMTksMiw0NCwyMF0sWzYsNDMsMTUsMiw0NCwxNl0sWzQsMTAxLDgxXSxbMSw4MCw1MCw0LDgxLDUxXSxbNCw1MCwyMiw0LDUxLDIzXSxbMywzNiwxMiw4LDM3LDEzXSxbMiwxMTYsOTIsMiwxMTcsOTNdLFs2LDU4LDM2LDIsNTksMzddLFs0LDQ2LDIwLDYsNDcsMjFdLFs3LDQyLDE0LDQsNDMsMTVdLFs0LDEzMywxMDddLFs4LDU5LDM3LDEsNjAsMzhdLFs4LDQ0LDIwLDQsNDUsMjFdLFsxMiwzMywxMSw0LDM0LDEyXSxbMywxNDUsMTE1LDEsMTQ2LDExNl0sWzQsNjQsNDAsNSw2NSw0MV0sWzExLDM2LDE2LDUsMzcsMTddLFsxMSwzNiwxMiw1LDM3LDEzXSxbNSwxMDksODcsMSwxMTAsODhdLFs1LDY1LDQxLDUsNjYsNDJdLFs1LDU0LDI0LDcsNTUsMjVdLFsxMSwzNiwxMl0sWzUsMTIyLDk4LDEsMTIzLDk5XSxbNyw3Myw0NSwzLDc0LDQ2XSxbMTUsNDMsMTksMiw0NCwyMF0sWzMsNDUsMTUsMTMsNDYsMTZdLFsxLDEzNSwxMDcsNSwxMzYsMTA4XSxbMTAsNzQsNDYsMSw3NSw0N10sWzEsNTAsMjIsMTUsNTEsMjNdLFsyLDQyLDE0LDE3LDQzLDE1XSxbNSwxNTAsMTIwLDEsMTUxLDEyMV0sWzksNjksNDMsNCw3MCw0NF0sWzE3LDUwLDIyLDEsNTEsMjNdLFsyLDQyLDE0LDE5LDQzLDE1XSxbMywxNDEsMTEzLDQsMTQyLDExNF0sWzMsNzAsNDQsMTEsNzEsNDVdLFsxNyw0NywyMSw0LDQ4LDIyXSxbOSwzOSwxMywxNiw0MCwxNF0sWzMsMTM1LDEwNyw1LDEzNiwxMDhdLFszLDY3LDQxLDEzLDY4LDQyXSxbMTUsNTQsMjQsNSw1NSwyNV0sWzE1LDQzLDE1LDEwLDQ0LDE2XSxbNCwxNDQsMTE2LDQsMTQ1LDExN10sWzE3LDY4LDQyXSxbMTcsNTAsMjIsNiw1MSwyM10sWzE5LDQ2LDE2LDYsNDcsMTddLFsyLDEzOSwxMTEsNywxNDAsMTEyXSxbMTcsNzQsNDZdLFs3LDU0LDI0LDE2LDU1LDI1XSxbMzQsMzcsMTNdLFs0LDE1MSwxMjEsNSwxNTIsMTIyXSxbNCw3NSw0NywxNCw3Niw0OF0sWzExLDU0LDI0LDE0LDU1LDI1XSxbMTYsNDUsMTUsMTQsNDYsMTZdLFs2LDE0NywxMTcsNCwxNDgsMTE4XSxbNiw3Myw0NSwxNCw3NCw0Nl0sWzExLDU0LDI0LDE2LDU1LDI1XSxbMzAsNDYsMTYsMiw0NywxN10sWzgsMTMyLDEwNiw0LDEzMywxMDddLFs4LDc1LDQ3LDEzLDc2LDQ4XSxbNyw1NCwyNCwyMiw1NSwyNV0sWzIyLDQ1LDE1LDEzLDQ2LDE2XSxbMTAsMTQyLDExNCwyLDE0MywxMTVdLFsxOSw3NCw0Niw0LDc1LDQ3XSxbMjgsNTAsMjIsNiw1MSwyM10sWzMzLDQ2LDE2LDQsNDcsMTddLFs4LDE1MiwxMjIsNCwxNTMsMTIzXSxbMjIsNzMsNDUsMyw3NCw0Nl0sWzgsNTMsMjMsMjYsNTQsMjRdLFsxMiw0NSwxNSwyOCw0NiwxNl0sWzMsMTQ3LDExNywxMCwxNDgsMTE4XSxbMyw3Myw0NSwyMyw3NCw0Nl0sWzQsNTQsMjQsMzEsNTUsMjVdLFsxMSw0NSwxNSwzMSw0NiwxNl0sWzcsMTQ2LDExNiw3LDE0NywxMTddLFsyMSw3Myw0NSw3LDc0LDQ2XSxbMSw1MywyMywzNyw1NCwyNF0sWzE5LDQ1LDE1LDI2LDQ2LDE2XSxbNSwxNDUsMTE1LDEwLDE0NiwxMTZdLFsxOSw3NSw0NywxMCw3Niw0OF0sWzE1LDU0LDI0LDI1LDU1LDI1XSxbMjMsNDUsMTUsMjUsNDYsMTZdLFsxMywxNDUsMTE1LDMsMTQ2LDExNl0sWzIsNzQsNDYsMjksNzUsNDddLFs0Miw1NCwyNCwxLDU1LDI1XSxbMjMsNDUsMTUsMjgsNDYsMTZdLFsxNywxNDUsMTE1XSxbMTAsNzQsNDYsMjMsNzUsNDddLFsxMCw1NCwyNCwzNSw1NSwyNV0sWzE5LDQ1LDE1LDM1LDQ2LDE2XSxbMTcsMTQ1LDExNSwxLDE0NiwxMTZdLFsxNCw3NCw0NiwyMSw3NSw0N10sWzI5LDU0LDI0LDE5LDU1LDI1XSxbMTEsNDUsMTUsNDYsNDYsMTZdLFsxMywxNDUsMTE1LDYsMTQ2LDExNl0sWzE0LDc0LDQ2LDIzLDc1LDQ3XSxbNDQsNTQsMjQsNyw1NSwyNV0sWzU5LDQ2LDE2LDEsNDcsMTddLFsxMiwxNTEsMTIxLDcsMTUyLDEyMl0sWzEyLDc1LDQ3LDI2LDc2LDQ4XSxbMzksNTQsMjQsMTQsNTUsMjVdLFsyMiw0NSwxNSw0MSw0NiwxNl0sWzYsMTUxLDEyMSwxNCwxNTIsMTIyXSxbNiw3NSw0NywzNCw3Niw0OF0sWzQ2LDU0LDI0LDEwLDU1LDI1XSxbMiw0NSwxNSw2NCw0NiwxNl0sWzE3LDE1MiwxMjIsNCwxNTMsMTIzXSxbMjksNzQsNDYsMTQsNzUsNDddLFs0OSw1NCwyNCwxMCw1NSwyNV0sWzI0LDQ1LDE1LDQ2LDQ2LDE2XSxbNCwxNTIsMTIyLDE4LDE1MywxMjNdLFsxMyw3NCw0NiwzMiw3NSw0N10sWzQ4LDU0LDI0LDE0LDU1LDI1XSxbNDIsNDUsMTUsMzIsNDYsMTZdLFsyMCwxNDcsMTE3LDQsMTQ4LDExOF0sWzQwLDc1LDQ3LDcsNzYsNDhdLFs0Myw1NCwyNCwyMiw1NSwyNV0sWzEwLDQ1LDE1LDY3LDQ2LDE2XSxbMTksMTQ4LDExOCw2LDE0OSwxMTldLFsxOCw3NSw0NywzMSw3Niw0OF0sWzM0LDU0LDI0LDM0LDU1LDI1XSxbMjAsNDUsMTUsNjEsNDYsMTZdXSxqLmdldFJTQmxvY2tzPWZ1bmN0aW9uKGEsYil7dmFyIGM9ai5nZXRSc0Jsb2NrVGFibGUoYSxiKTtpZih2b2lkIDA9PWMpdGhyb3cgbmV3IEVycm9yKCJiYWQgcnMgYmxvY2sgQCB0eXBlTnVtYmVyOiIrYSsiL2Vycm9yQ29ycmVjdExldmVsOiIrYik7Zm9yKHZhciBkPWMubGVuZ3RoLzMsZT1bXSxmPTA7ZD5mO2YrKylmb3IodmFyIGc9Y1szKmYrMF0saD1jWzMqZisxXSxpPWNbMypmKzJdLGs9MDtnPms7aysrKWUucHVzaChuZXcgaihoLGkpKTtyZXR1cm4gZX0sai5nZXRSc0Jsb2NrVGFibGU9ZnVuY3Rpb24oYSxiKXtzd2l0Y2goYil7Y2FzZSBkLkw6cmV0dXJuIGouUlNfQkxPQ0tfVEFCTEVbNCooYS0xKSswXTtjYXNlIGQuTTpyZXR1cm4gai5SU19CTE9DS19UQUJMRVs0KihhLTEpKzFdO2Nhc2UgZC5ROnJldHVybiBqLlJTX0JMT0NLX1RBQkxFWzQqKGEtMSkrMl07Y2FzZSBkLkg6cmV0dXJuIGouUlNfQkxPQ0tfVEFCTEVbNCooYS0xKSszXTtkZWZhdWx0OnJldHVybiB2b2lkIDB9fSxrLnByb3RvdHlwZT17Z2V0OmZ1bmN0aW9uKGEpe3ZhciBiPU1hdGguZmxvb3IoYS84KTtyZXR1cm4gMT09KDEmdGhpcy5idWZmZXJbYl0+Pj43LWElOCl9LHB1dDpmdW5jdGlvbihhLGIpe2Zvcih2YXIgYz0wO2I+YztjKyspdGhpcy5wdXRCaXQoMT09KDEmYT4+PmItYy0xKSl9LGdldExlbmd0aEluQml0czpmdW5jdGlvbigpe3JldHVybiB0aGlzLmxlbmd0aH0scHV0Qml0OmZ1bmN0aW9uKGEpe3ZhciBiPU1hdGguZmxvb3IodGhpcy5sZW5ndGgvOCk7dGhpcy5idWZmZXIubGVuZ3RoPD1iJiZ0aGlzLmJ1ZmZlci5wdXNoKDApLGEmJih0aGlzLmJ1ZmZlcltiXXw9MTI4Pj4+dGhpcy5sZW5ndGglOCksdGhpcy5sZW5ndGgrK319O3ZhciBsPVtbMTcsMTQsMTEsN10sWzMyLDI2LDIwLDE0XSxbNTMsNDIsMzIsMjRdLFs3OCw2Miw0NiwzNF0sWzEwNiw4NCw2MCw0NF0sWzEzNCwxMDYsNzQsNThdLFsxNTQsMTIyLDg2LDY0XSxbMTkyLDE1MiwxMDgsODRdLFsyMzAsMTgwLDEzMCw5OF0sWzI3MSwyMTMsMTUxLDExOV0sWzMyMSwyNTEsMTc3LDEzN10sWzM2NywyODcsMjAzLDE1NV0sWzQyNSwzMzEsMjQxLDE3N10sWzQ1OCwzNjIsMjU4LDE5NF0sWzUyMCw0MTIsMjkyLDIyMF0sWzU4Niw0NTAsMzIyLDI1MF0sWzY0NCw1MDQsMzY0LDI4MF0sWzcxOCw1NjAsMzk0LDMxMF0sWzc5Miw2MjQsNDQyLDMzOF0sWzg1OCw2NjYsNDgyLDM4Ml0sWzkyOSw3MTEsNTA5LDQwM10sWzEwMDMsNzc5LDU2NSw0MzldLFsxMDkxLDg1Nyw2MTEsNDYxXSxbMTE3MSw5MTEsNjYxLDUxMV0sWzEyNzMsOTk3LDcxNSw1MzVdLFsxMzY3LDEwNTksNzUxLDU5M10sWzE0NjUsMTEyNSw4MDUsNjI1XSxbMTUyOCwxMTkwLDg2OCw2NThdLFsxNjI4LDEyNjQsOTA4LDY5OF0sWzE3MzIsMTM3MCw5ODIsNzQyXSxbMTg0MCwxNDUyLDEwMzAsNzkwXSxbMTk1MiwxNTM4LDExMTIsODQyXSxbMjA2OCwxNjI4LDExNjgsODk4XSxbMjE4OCwxNzIyLDEyMjgsOTU4XSxbMjMwMywxODA5LDEyODMsOTgzXSxbMjQzMSwxOTExLDEzNTEsMTA1MV0sWzI1NjMsMTk4OSwxNDIzLDEwOTNdLFsyNjk5LDIwOTksMTQ5OSwxMTM5XSxbMjgwOSwyMjEzLDE1NzksMTIxOV0sWzI5NTMsMjMzMSwxNjYzLDEyNzNdXSxvPWZ1bmN0aW9uKCl7dmFyIGE9ZnVuY3Rpb24oYSxiKXt0aGlzLl9lbD1hLHRoaXMuX2h0T3B0aW9uPWJ9O3JldHVybiBhLnByb3RvdHlwZS5kcmF3PWZ1bmN0aW9uKGEpe2Z1bmN0aW9uIGcoYSxiKXt2YXIgYz1kb2N1bWVudC5jcmVhdGVFbGVtZW50TlMoImh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIixhKTtmb3IodmFyIGQgaW4gYiliLmhhc093blByb3BlcnR5KGQpJiZjLnNldEF0dHJpYnV0ZShkLGJbZF0pO3JldHVybiBjfXZhciBiPXRoaXMuX2h0T3B0aW9uLGM9dGhpcy5fZWwsZD1hLmdldE1vZHVsZUNvdW50KCk7TWF0aC5mbG9vcihiLndpZHRoL2QpLE1hdGguZmxvb3IoYi5oZWlnaHQvZCksdGhpcy5jbGVhcigpO3ZhciBoPWcoInN2ZyIse3ZpZXdCb3g6IjAgMCAiK1N0cmluZyhkKSsiICIrU3RyaW5nKGQpLHdpZHRoOiIxMDAlIixoZWlnaHQ6IjEwMCUiLGZpbGw6Yi5jb2xvckxpZ2h0fSk7aC5zZXRBdHRyaWJ1dGVOUygiaHR0cDovL3d3dy53My5vcmcvMjAwMC94bWxucy8iLCJ4bWxuczp4bGluayIsImh0dHA6Ly93d3cudzMub3JnLzE5OTkveGxpbmsiKSxjLmFwcGVuZENoaWxkKGgpLGguYXBwZW5kQ2hpbGQoZygicmVjdCIse2ZpbGw6Yi5jb2xvckRhcmssd2lkdGg6IjEiLGhlaWdodDoiMSIsaWQ6InRlbXBsYXRlIn0pKTtmb3IodmFyIGk9MDtkPmk7aSsrKWZvcih2YXIgaj0wO2Q+ajtqKyspaWYoYS5pc0RhcmsoaSxqKSl7dmFyIGs9ZygidXNlIix7eDpTdHJpbmcoaSkseTpTdHJpbmcoail9KTtrLnNldEF0dHJpYnV0ZU5TKCJodHRwOi8vd3d3LnczLm9yZy8xOTk5L3hsaW5rIiwiaHJlZiIsIiN0ZW1wbGF0ZSIpLGguYXBwZW5kQ2hpbGQoayl9fSxhLnByb3RvdHlwZS5jbGVhcj1mdW5jdGlvbigpe2Zvcig7dGhpcy5fZWwuaGFzQ2hpbGROb2RlcygpOyl0aGlzLl9lbC5yZW1vdmVDaGlsZCh0aGlzLl9lbC5sYXN0Q2hpbGQpfSxhfSgpLHA9InN2ZyI9PT1kb2N1bWVudC5kb2N1bWVudEVsZW1lbnQudGFnTmFtZS50b0xvd2VyQ2FzZSgpLHE9cD9vOm0oKT9mdW5jdGlvbigpe2Z1bmN0aW9uIGEoKXt0aGlzLl9lbEltYWdlLnNyYz10aGlzLl9lbENhbnZhcy50b0RhdGFVUkwoImltYWdlL3BuZyIpLHRoaXMuX2VsSW1hZ2Uuc3R5bGUuZGlzcGxheT0iYmxvY2siLHRoaXMuX2VsQ2FudmFzLnN0eWxlLmRpc3BsYXk9Im5vbmUifWZ1bmN0aW9uIGQoYSxiKXt2YXIgYz10aGlzO2lmKGMuX2ZGYWlsPWIsYy5fZlN1Y2Nlc3M9YSxudWxsPT09Yy5fYlN1cHBvcnREYXRhVVJJKXt2YXIgZD1kb2N1bWVudC5jcmVhdGVFbGVtZW50KCJpbWciKSxlPWZ1bmN0aW9uKCl7Yy5fYlN1cHBvcnREYXRhVVJJPSExLGMuX2ZGYWlsJiZfZkZhaWwuY2FsbChjKX0sZj1mdW5jdGlvbigpe2MuX2JTdXBwb3J0RGF0YVVSST0hMCxjLl9mU3VjY2VzcyYmYy5fZlN1Y2Nlc3MuY2FsbChjKX07cmV0dXJuIGQub25hYm9ydD1lLGQub25lcnJvcj1lLGQub25sb2FkPWYsZC5zcmM9ImRhdGE6aW1hZ2UvZ2lmO2Jhc2U2NCxpVkJPUncwS0dnb0FBQUFOU1VoRVVnQUFBQVVBQUFBRkNBWUFBQUNOYnlibEFBQUFIRWxFUVZRSTEyUDQvLzgvdzM4R0lBWERJQktFMERIeGdsak5CQUFPOVRYTDBZNE9Id0FBQUFCSlJVNUVya0pnZ2c9PSIsdm9pZCAwfWMuX2JTdXBwb3J0RGF0YVVSST09PSEwJiZjLl9mU3VjY2Vzcz9jLl9mU3VjY2Vzcy5jYWxsKGMpOmMuX2JTdXBwb3J0RGF0YVVSST09PSExJiZjLl9mRmFpbCYmYy5fZkZhaWwuY2FsbChjKX1pZih0aGlzLl9hbmRyb2lkJiZ0aGlzLl9hbmRyb2lkPD0yLjEpe3ZhciBiPTEvd2luZG93LmRldmljZVBpeGVsUmF0aW8sYz1DYW52YXNSZW5kZXJpbmdDb250ZXh0MkQucHJvdG90eXBlLmRyYXdJbWFnZTtDYW52YXNSZW5kZXJpbmdDb250ZXh0MkQucHJvdG90eXBlLmRyYXdJbWFnZT1mdW5jdGlvbihhLGQsZSxmLGcsaCxpLGope2lmKCJub2RlTmFtZSJpbiBhJiYvaW1nL2kudGVzdChhLm5vZGVOYW1lKSlmb3IodmFyIGw9YXJndW1lbnRzLmxlbmd0aC0xO2w+PTE7bC0tKWFyZ3VtZW50c1tsXT1hcmd1bWVudHNbbF0qYjtlbHNlInVuZGVmaW5lZCI9PXR5cGVvZiBqJiYoYXJndW1lbnRzWzFdKj1iLGFyZ3VtZW50c1syXSo9Yixhcmd1bWVudHNbM10qPWIsYXJndW1lbnRzWzRdKj1iKTtjLmFwcGx5KHRoaXMsYXJndW1lbnRzKX19dmFyIGU9ZnVuY3Rpb24oYSxiKXt0aGlzLl9iSXNQYWludGVkPSExLHRoaXMuX2FuZHJvaWQ9bigpLHRoaXMuX2h0T3B0aW9uPWIsdGhpcy5fZWxDYW52YXM9ZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgiY2FudmFzIiksdGhpcy5fZWxDYW52YXMud2lkdGg9Yi53aWR0aCx0aGlzLl9lbENhbnZhcy5oZWlnaHQ9Yi5oZWlnaHQsYS5hcHBlbmRDaGlsZCh0aGlzLl9lbENhbnZhcyksdGhpcy5fZWw9YSx0aGlzLl9vQ29udGV4dD10aGlzLl9lbENhbnZhcy5nZXRDb250ZXh0KCIyZCIpLHRoaXMuX2JJc1BhaW50ZWQ9ITEsdGhpcy5fZWxJbWFnZT1kb2N1bWVudC5jcmVhdGVFbGVtZW50KCJpbWciKSx0aGlzLl9lbEltYWdlLnN0eWxlLmRpc3BsYXk9Im5vbmUiLHRoaXMuX2VsLmFwcGVuZENoaWxkKHRoaXMuX2VsSW1hZ2UpLHRoaXMuX2JTdXBwb3J0RGF0YVVSST1udWxsfTtyZXR1cm4gZS5wcm90b3R5cGUuZHJhdz1mdW5jdGlvbihhKXt2YXIgYj10aGlzLl9lbEltYWdlLGM9dGhpcy5fb0NvbnRleHQsZD10aGlzLl9odE9wdGlvbixlPWEuZ2V0TW9kdWxlQ291bnQoKSxmPWQud2lkdGgvZSxnPWQuaGVpZ2h0L2UsaD1NYXRoLnJvdW5kKGYpLGk9TWF0aC5yb3VuZChnKTtiLnN0eWxlLmRpc3BsYXk9Im5vbmUiLHRoaXMuY2xlYXIoKTtmb3IodmFyIGo9MDtlPmo7aisrKWZvcih2YXIgaz0wO2U+aztrKyspe3ZhciBsPWEuaXNEYXJrKGosayksbT1rKmYsbj1qKmc7Yy5zdHJva2VTdHlsZT1sP2QuY29sb3JEYXJrOmQuY29sb3JMaWdodCxjLmxpbmVXaWR0aD0xLGMuZmlsbFN0eWxlPWw/ZC5jb2xvckRhcms6ZC5jb2xvckxpZ2h0LGMuZmlsbFJlY3QobSxuLGYsZyksYy5zdHJva2VSZWN0KE1hdGguZmxvb3IobSkrLjUsTWF0aC5mbG9vcihuKSsuNSxoLGkpLGMuc3Ryb2tlUmVjdChNYXRoLmNlaWwobSktLjUsTWF0aC5jZWlsKG4pLS41LGgsaSl9dGhpcy5fYklzUGFpbnRlZD0hMH0sZS5wcm90b3R5cGUubWFrZUltYWdlPWZ1bmN0aW9uKCl7dGhpcy5fYklzUGFpbnRlZCYmZC5jYWxsKHRoaXMsYSl9LGUucHJvdG90eXBlLmlzUGFpbnRlZD1mdW5jdGlvbigpe3JldHVybiB0aGlzLl9iSXNQYWludGVkfSxlLnByb3RvdHlwZS5jbGVhcj1mdW5jdGlvbigpe3RoaXMuX29Db250ZXh0LmNsZWFyUmVjdCgwLDAsdGhpcy5fZWxDYW52YXMud2lkdGgsdGhpcy5fZWxDYW52YXMuaGVpZ2h0KSx0aGlzLl9iSXNQYWludGVkPSExfSxlLnByb3RvdHlwZS5yb3VuZD1mdW5jdGlvbihhKXtyZXR1cm4gYT9NYXRoLmZsb29yKDFlMyphKS8xZTM6YX0sZX0oKTpmdW5jdGlvbigpe3ZhciBhPWZ1bmN0aW9uKGEsYil7dGhpcy5fZWw9YSx0aGlzLl9odE9wdGlvbj1ifTtyZXR1cm4gYS5wcm90b3R5cGUuZHJhdz1mdW5jdGlvbihhKXtmb3IodmFyIGI9dGhpcy5faHRPcHRpb24sYz10aGlzLl9lbCxkPWEuZ2V0TW9kdWxlQ291bnQoKSxlPU1hdGguZmxvb3IoYi53aWR0aC9kKSxmPU1hdGguZmxvb3IoYi5oZWlnaHQvZCksZz1bJzx0YWJsZSBzdHlsZT0iYm9yZGVyOjA7Ym9yZGVyLWNvbGxhcHNlOmNvbGxhcHNlOyI+J10saD0wO2Q+aDtoKyspe2cucHVzaCgiPHRyPiIpO2Zvcih2YXIgaT0wO2Q+aTtpKyspZy5wdXNoKCc8dGQgc3R5bGU9ImJvcmRlcjowO2JvcmRlci1jb2xsYXBzZTpjb2xsYXBzZTtwYWRkaW5nOjA7bWFyZ2luOjA7d2lkdGg6JytlKyJweDtoZWlnaHQ6IitmKyJweDtiYWNrZ3JvdW5kLWNvbG9yOiIrKGEuaXNEYXJrKGgsaSk/Yi5jb2xvckRhcms6Yi5jb2xvckxpZ2h0KSsnOyI+PC90ZD4nKTtnLnB1c2goIjwvdHI+Iil9Zy5wdXNoKCI8L3RhYmxlPiIpLGMuaW5uZXJIVE1MPWcuam9pbigiIik7dmFyIGo9Yy5jaGlsZE5vZGVzWzBdLGs9KGIud2lkdGgtai5vZmZzZXRXaWR0aCkvMixsPShiLmhlaWdodC1qLm9mZnNldEhlaWdodCkvMjtrPjAmJmw+MCYmKGouc3R5bGUubWFyZ2luPWwrInB4ICIraysicHgiKX0sYS5wcm90b3R5cGUuY2xlYXI9ZnVuY3Rpb24oKXt0aGlzLl9lbC5pbm5lckhUTUw9IiJ9LGF9KCk7UVJDb2RlPWZ1bmN0aW9uKGEsYil7aWYodGhpcy5faHRPcHRpb249e3dpZHRoOjI1NixoZWlnaHQ6MjU2LHR5cGVOdW1iZXI6NCxjb2xvckRhcms6IiMwMDAwMDAiLGNvbG9yTGlnaHQ6IiNmZmZmZmYiLGNvcnJlY3RMZXZlbDpkLkh9LCJzdHJpbmciPT10eXBlb2YgYiYmKGI9e3RleHQ6Yn0pLGIpZm9yKHZhciBjIGluIGIpdGhpcy5faHRPcHRpb25bY109YltjXTsic3RyaW5nIj09dHlwZW9mIGEmJihhPWRvY3VtZW50LmdldEVsZW1lbnRCeUlkKGEpKSx0aGlzLl9hbmRyb2lkPW4oKSx0aGlzLl9lbD1hLHRoaXMuX29RUkNvZGU9bnVsbCx0aGlzLl9vRHJhd2luZz1uZXcgcSh0aGlzLl9lbCx0aGlzLl9odE9wdGlvbiksdGhpcy5faHRPcHRpb24udGV4dCYmdGhpcy5tYWtlQ29kZSh0aGlzLl9odE9wdGlvbi50ZXh0KX0sUVJDb2RlLnByb3RvdHlwZS5tYWtlQ29kZT1mdW5jdGlvbihhKXt0aGlzLl9vUVJDb2RlPW5ldyBiKHIoYSx0aGlzLl9odE9wdGlvbi5jb3JyZWN0TGV2ZWwpLHRoaXMuX2h0T3B0aW9uLmNvcnJlY3RMZXZlbCksdGhpcy5fb1FSQ29kZS5hZGREYXRhKGEpLHRoaXMuX29RUkNvZGUubWFrZSgpLHRoaXMuX2VsLnRpdGxlPWEsdGhpcy5fb0RyYXdpbmcuZHJhdyh0aGlzLl9vUVJDb2RlKSx0aGlzLm1ha2VJbWFnZSgpfSxRUkNvZGUucHJvdG90eXBlLm1ha2VJbWFnZT1mdW5jdGlvbigpeyJmdW5jdGlvbiI9PXR5cGVvZiB0aGlzLl9vRHJhd2luZy5tYWtlSW1hZ2UmJighdGhpcy5fYW5kcm9pZHx8dGhpcy5fYW5kcm9pZD49MykmJnRoaXMuX29EcmF3aW5nLm1ha2VJbWFnZSgpfSxRUkNvZGUucHJvdG90eXBlLmNsZWFyPWZ1bmN0aW9uKCl7dGhpcy5fb0RyYXdpbmcuY2xlYXIoKX0sUVJDb2RlLkNvcnJlY3RMZXZlbD1kfSgpOw==', 'base64') }],
]);

function serveStatic(req, res, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  let file = embeddedFiles.get(requested);
  if (!file && !path.extname(requested)) file = embeddedFiles.get('/index.html');
  if (!file) return json(res, 404, { ok: false, message: 'Arquivo não encontrado.' });
  res.writeHead(200, {
    'Content-Type': file.type,
    'Cache-Control': requested === '/index.html' || !path.extname(requested) ? 'no-cache' : 'public, max-age=3600',
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
      persistenceMode: store.mode,
      storeReady,
      rooms: rooms.size,
      maxParticipantsPerRoom: MAX_PARTICIPANTS,
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
