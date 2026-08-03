'use strict';

const app = document.getElementById('app');
const toastEl = document.getElementById('toast');
const AUTH_KEY = 'quiz_credsystem_auth';
const PRESENTER_KEY = (room) => `quiz_credsystem_presenter_${room}`;
const PLAYER_KEY = (room) => `quiz_credsystem_player_${room}`;

const state = {
  config: null,
  auth: null,
  quizzes: [],
  admins: [],
  dashboardTab: 'overview',
  editor: null,
  startQuizId: null,
  eventSource: null,
  room: null,
  self: null,
  playerCreds: null,
  presenterCreds: null,
  timerInterval: null,
  lastRankingKey: null,
  audio: {
    context: null,
    timer: null,
    activeTheme: null,
    enabled: true,
    step: 0,
  },
};

const params = new URLSearchParams(location.search);

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function randomId(prefix = 'id') {
  if (crypto.randomUUID) return `${prefix}_${crypto.randomUUID()}`;
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function showToast(message) {
  toastEl.textContent = message;
  toastEl.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toastEl.classList.remove('show'), 2800);
}

async function api(path, body = {}) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({ ok: false, message: 'Resposta inválida do servidor.' }));
  if (!response.ok || data.ok === false) throw new Error(data.message || 'Não foi possível concluir a ação.');
  return data;
}

function brandMarkup(light = false) {
  return `
    <a class="brand" href="/" aria-label="Quiz Credsystem">
      <span class="brand-symbol" aria-hidden="true"></span>
      <span class="brand-copy">
        <strong style="color:${light ? 'white' : 'var(--ink)'}">Quiz Credsystem</strong>
        <small style="color:${light ? 'rgba(255,255,255,.68)' : ''}">Educação corporativa ao vivo</small>
      </span>
    </a>`;
}

function topbar(actions = '') {
  return `<header class="topbar">${brandMarkup()}<div class="top-actions">${actions}</div></header>`;
}

function clearTimer() {
  if (state.timerInterval) clearInterval(state.timerInterval);
  state.timerInterval = null;
}

function startCountdown(room) {
  clearTimer();
  const el = document.getElementById('timer');
  if (!el || !room.questionStartedAt || !room.question) return;
  const tick = () => {
    const elapsed = (Date.now() - room.questionStartedAt) / 1000;
    const remaining = Math.max(0, Math.ceil(room.question.timeLimit - elapsed));
    el.textContent = remaining;
  };
  tick();
  state.timerInterval = setInterval(tick, 250);
}

function avatarVisual(avatar, small = false) {
  const sizeClass = small ? 'mini-avatar' : 'avatar-visual';
  return `<span class="${sizeClass}" style="background:linear-gradient(135deg,${avatar.colors[0]},${avatar.colors[1]})">${avatar.emoji}</span>`;
}

function phaseLabel(phase) {
  return ({ lobby: 'Sala de espera', question: 'Pergunta aberta', answer: 'Resposta revelada', ranking: 'Ranking', finished: 'Encerrado' })[phase] || phase;
}

function renderQr(elementId, text, size = 240) {
  requestAnimationFrame(() => {
    const element = document.getElementById(elementId);
    if (!element || !window.QRCode) return;
    element.innerHTML = '';
    new QRCode(element, {
      text,
      width: size,
      height: size,
      colorDark: '#171820',
      colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.H,
    });
  });
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    showToast('Link copiado.');
  } catch (error) {
    const temp = document.createElement('textarea');
    temp.value = text;
    document.body.appendChild(temp);
    temp.select();
    document.execCommand('copy');
    temp.remove();
    showToast('Link copiado.');
  }
}

// Música gerada no próprio navegador, sem arquivos externos ou direitos autorais.
function ensureAudio() {
  if (!state.audio.enabled) return null;
  if (!state.audio.context) {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return null;
    state.audio.context = new AudioContext();
  }
  if (state.audio.context.state === 'suspended') state.audio.context.resume().catch(() => {});
  return state.audio.context;
}

function playNote(frequency, duration = .12, type = 'sine', volume = .045, delay = 0) {
  const context = ensureAudio();
  if (!context) return;
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = type;
  oscillator.frequency.value = frequency;
  gain.gain.setValueAtTime(0.0001, context.currentTime + delay);
  gain.gain.exponentialRampToValueAtTime(volume, context.currentTime + delay + .012);
  gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + delay + duration);
  oscillator.connect(gain).connect(context.destination);
  oscillator.start(context.currentTime + delay);
  oscillator.stop(context.currentTime + delay + duration + .02);
}

function stopMusic() {
  if (state.audio.timer) clearInterval(state.audio.timer);
  state.audio.timer = null;
  state.audio.activeTheme = null;
  state.audio.step = 0;
}

function startMusic(theme) {
  if (!state.audio.enabled || theme === 'none') {
    stopMusic();
    return;
  }
  if (state.audio.activeTheme === theme && state.audio.timer) return;
  stopMusic();
  ensureAudio();
  state.audio.activeTheme = theme;
  const patterns = {
    pulse: [261.63, 329.63, 392.00, 329.63, 293.66, 369.99, 440.00, 369.99],
    upbeat: [329.63, 392.00, 493.88, 587.33, 493.88, 392.00, 349.23, 440.00],
    focus: [220.00, 277.18, 329.63, 277.18, 196.00, 246.94, 293.66, 246.94],
  };
  const pattern = patterns[theme] || patterns.pulse;
  const interval = theme === 'focus' ? 620 : 360;
  const tick = () => {
    const note = pattern[state.audio.step % pattern.length];
    playNote(note, theme === 'focus' ? .44 : .18, theme === 'pulse' ? 'triangle' : 'sine', theme === 'focus' ? .025 : .035);
    if (state.audio.step % 4 === 0) playNote(theme === 'upbeat' ? 98 : 82.41, .1, 'sine', .05);
    state.audio.step += 1;
  };
  tick();
  state.audio.timer = setInterval(tick, interval);
}

function playSuspense() {
  stopMusic();
  ensureAudio();
  const notes = [110, 123.47, 138.59, 155.56, 174.61, 196, 220, 246.94];
  notes.forEach((note, index) => {
    playNote(note, .32, 'sawtooth', .035 + index * .003, index * .38);
    playNote(55, .08, 'sine', .06, index * .38);
  });
  playNote(523.25, .7, 'triangle', .09, notes.length * .38 + .1);
}

function syncMusic(room) {
  if (!room) return;
  if (room.phase === 'ranking') return;
  if (room.phase === 'finished' || room.phase === 'answer') stopMusic();
  else if (room.phase === 'question' || room.phase === 'lobby') startMusic(room.musicTheme);
}

function toggleAudio() {
  state.audio.enabled = !state.audio.enabled;
  if (!state.audio.enabled) stopMusic();
  else if (state.room) syncMusic(state.room);
  showToast(state.audio.enabled ? 'Som ativado.' : 'Som desativado.');
  const button = document.getElementById('audio-toggle');
  if (button) button.textContent = state.audio.enabled ? '🔊 Som' : '🔇 Som';
}

async function init() {
  try {
    const config = await api('/api/public/config');
    state.config = config;
  } catch (error) {
    app.innerHTML = `<div class="wait-screen"><div class="wait-card"><h1>Sistema iniciando</h1><p>${escapeHtml(error.message)}</p><button class="btn btn-light" onclick="location.reload()">Tentar novamente</button></div></div>`;
    return;
  }

  const presenter = params.get('presenter');
  const screen = params.get('screen');
  const room = params.get('room');
  if (presenter) return openPresenter(presenter);
  if (screen) return openScreen(screen);
  if (room) return openPlayer(room, params.get('key') || '');
  renderHome();
}

function renderHome() {
  clearTimer();
  stopMusic();
  app.innerHTML = `
    ${topbar(`<button id="admin-open" class="btn btn-dark">Área administrativa</button>`)}
    <main class="container">
      <section class="hero">
        <div>
          <div class="hero-badge">● treinamento em tempo real</div>
          <h1>Aprender ficou mais <span class="gradient-text">vivo.</span></h1>
          <p>Quizzes corporativos com sala ao vivo, pódio, premiações, música, relatórios e até 100 participantes.</p>
          <div class="row" style="margin-top:26px">
            <button id="join-home" class="btn btn-primary btn-large">Entrar em uma sala</button>
            <button id="admin-home" class="btn btn-light btn-large">Criar e apresentar quiz</button>
          </div>
        </div>
        <div class="hero-card">
          <div class="eyebrow" style="background:rgba(255,255,255,.13);color:white">Pergunta 3 de 10</div>
          <div class="mock-question">Qual atitude cria mais valor para o cliente?</div>
          <div class="mock-grid">
            <div class="mock-option">◇ Ouvir e personalizar</div>
            <div class="mock-option">○ Repetir o roteiro</div>
            <div class="mock-option">◇ Ignorar objeções</div>
            <div class="mock-option">○ Falar sem pausas</div>
          </div>
        </div>
      </section>
      <section class="grid-3">
        <article class="card"><h3>⚡ Ao vivo</h3><p class="muted">O apresentador controla pergunta, resposta, ranking e próxima rodada.</p></article>
        <article class="card"><h3>🏆 Premiação</h3><p class="muted">Pódio animado para primeiro, segundo e terceiro lugares.</p></article>
        <article class="card"><h3>📊 Relatório Excel</h3><p class="muted">Presença, data, horário e todas as respostas por participante.</p></article>
      </section>
    </main>`;
  document.getElementById('admin-open').addEventListener('click', openAdmin);
  document.getElementById('admin-home').addEventListener('click', openAdmin);
  document.getElementById('join-home').addEventListener('click', renderCodeEntry);
}

function renderCodeEntry() {
  app.innerHTML = `
    ${topbar(`<button id="back-home" class="btn btn-light">Voltar</button>`)}
    <main class="container narrow">
      <div class="card text-center" style="margin-top:50px">
        <div class="eyebrow">Entrada do participante</div>
        <h1>Digite o código da sala</h1>
        <p class="muted">O código de seis números aparece na tela do apresentador.</p>
        <div class="field"><input id="room-code" class="input code-input" inputmode="numeric" maxlength="6" placeholder="000000"></div>
        <button id="continue-room" class="btn btn-primary btn-large btn-block">Continuar</button>
      </div>
    </main>`;
  document.getElementById('back-home').addEventListener('click', renderHome);
  const input = document.getElementById('room-code');
  input.addEventListener('input', () => input.value = input.value.replace(/\D/g, '').slice(0, 6));
  const proceed = () => {
    if (input.value.length !== 6) return showToast('Digite os seis números da sala.');
    location.href = `/?room=${encodeURIComponent(input.value)}`;
  };
  document.getElementById('continue-room').addEventListener('click', proceed);
  input.addEventListener('keydown', (event) => { if (event.key === 'Enter') proceed(); });
}

async function openAdmin() {
  params.delete('room'); params.delete('presenter'); params.delete('screen');
  history.replaceState({}, '', '/?admin=1');
  const stored = sessionStorage.getItem(AUTH_KEY);
  if (stored) {
    try {
      state.auth = JSON.parse(stored);
      const result = await api('/api/admin/session', { authToken: state.auth.authToken });
      state.auth.admin = result.admin;
      state.auth.persistenceMode = result.persistenceMode;
      return loadDashboard();
    } catch (error) {
      sessionStorage.removeItem(AUTH_KEY);
      state.auth = null;
    }
  }
  if (state.config.setupRequired) renderSetup();
  else renderLogin();
}

function renderSetup() {
  app.innerHTML = `
    ${topbar(`<button id="setup-home" class="btn btn-light">Voltar</button>`)}
    <main class="container narrow">
      <div class="card" style="margin-top:42px">
        <div class="eyebrow">Primeiro acesso</div>
        <h1>Crie o administrador principal</h1>
        <p class="muted">Essa tela será bloqueada automaticamente depois da criação.</p>
        <div class="field"><label for="setup-name">Nome</label><input id="setup-name" class="input" autocomplete="name"></div>
        <div class="field"><label for="setup-email">E-mail</label><input id="setup-email" class="input" type="email" autocomplete="email"></div>
        <div class="field"><label for="setup-password">Senha</label><input id="setup-password" class="input" type="password" minlength="8" autocomplete="new-password"><small>Mínimo de oito caracteres.</small></div>
        <button id="setup-create" class="btn btn-primary btn-large btn-block">Criar administrador</button>
      </div>
    </main>`;
  document.getElementById('setup-home').addEventListener('click', renderHome);
  document.getElementById('setup-create').addEventListener('click', async () => {
    try {
      ensureAudio();
      const result = await api('/api/setup/create-admin', {
        name: document.getElementById('setup-name').value,
        email: document.getElementById('setup-email').value,
        password: document.getElementById('setup-password').value,
      });
      state.auth = result;
      sessionStorage.setItem(AUTH_KEY, JSON.stringify(result));
      state.config.setupRequired = false;
      await loadDashboard();
    } catch (error) { showToast(error.message); }
  });
}

function renderLogin() {
  app.innerHTML = `
    ${topbar(`<button id="login-home" class="btn btn-light">Voltar</button>`)}
    <main class="container narrow">
      <div class="card" style="margin-top:42px">
        <div class="eyebrow">Área administrativa</div>
        <h1>Entrar no painel</h1>
        <div class="field"><label for="login-email">E-mail</label><input id="login-email" class="input" type="email" autocomplete="email"></div>
        <div class="field"><label for="login-password">Senha</label><input id="login-password" class="input" type="password" autocomplete="current-password"></div>
        <button id="login-submit" class="btn btn-primary btn-large btn-block">Entrar</button>
      </div>
    </main>`;
  document.getElementById('login-home').addEventListener('click', renderHome);
  const submit = async () => {
    try {
      ensureAudio();
      const result = await api('/api/admin/login', {
        email: document.getElementById('login-email').value,
        password: document.getElementById('login-password').value,
      });
      state.auth = result;
      sessionStorage.setItem(AUTH_KEY, JSON.stringify(result));
      await loadDashboard();
    } catch (error) { showToast(error.message); }
  };
  document.getElementById('login-submit').addEventListener('click', submit);
  document.getElementById('login-password').addEventListener('keydown', (event) => { if (event.key === 'Enter') submit(); });
}

async function loadDashboard() {
  try {
    const [quizData, adminData] = await Promise.all([
      api('/api/admin/quizzes', { authToken: state.auth.authToken }),
      api('/api/admin/admins', { authToken: state.auth.authToken }),
    ]);
    state.quizzes = quizData.quizzes;
    state.admins = adminData.admins;
    state.auth.persistenceMode = adminData.persistenceMode;
    renderDashboard();
  } catch (error) {
    showToast(error.message);
    sessionStorage.removeItem(AUTH_KEY);
    state.auth = null;
    renderLogin();
  }
}

function dashboardSidebar() {
  const admin = state.auth.admin;
  return `
    <aside class="sidebar card">
      <div class="admin-user">
        <div class="admin-avatar">${escapeHtml(admin.name.slice(0,2).toUpperCase())}</div>
        <div><strong>${escapeHtml(admin.name)}</strong><small>${escapeHtml(admin.email)}</small></div>
      </div>
      <div class="sidebar-menu">
        <button data-tab="overview" class="btn ${state.dashboardTab === 'overview' ? 'btn-dark' : 'btn-light'}">◫ Visão geral</button>
        <button data-tab="quizzes" class="btn ${state.dashboardTab === 'quizzes' ? 'btn-dark' : 'btn-light'}">✦ Quizzes</button>
        <button data-tab="admins" class="btn ${state.dashboardTab === 'admins' ? 'btn-dark' : 'btn-light'}">♙ Administradores</button>
      </div>
    </aside>`;
}

function renderDashboard() {
  clearTimer();
  stopMusic();
  const modeNotice = state.auth.persistenceMode === 'memory'
    ? `<div class="notice">⚠️ Modo temporário: novos administradores e quizzes serão perdidos se o Render reiniciar. Conecte um PostgreSQL usando DATABASE_URL para salvar permanentemente.</div>`
    : `<div class="notice success">✓ Banco de dados conectado. Administradores, quizzes e resultados são persistentes.</div>`;

  app.innerHTML = `
    ${topbar(`<button id="logout" class="btn btn-light">Sair</button>`)}
    <main class="container">
      ${modeNotice}
      <div class="dashboard">
        ${dashboardSidebar()}
        <section id="dashboard-content">${dashboardContent()}</section>
      </div>
    </main>`;

  document.getElementById('logout').addEventListener('click', () => {
    sessionStorage.removeItem(AUTH_KEY);
    state.auth = null;
    renderHome();
  });
  document.querySelectorAll('[data-tab]').forEach((button) => button.addEventListener('click', () => {
    state.dashboardTab = button.dataset.tab;
    state.editor = null;
    state.startQuizId = null;
    renderDashboard();
  }));
  bindDashboardContent();
}

function dashboardContent() {
  if (state.dashboardTab === 'quizzes') return renderQuizzesTab();
  if (state.dashboardTab === 'admins') return renderAdminsTab();
  return renderOverviewTab();
}

function renderOverviewTab() {
  const startPanel = state.startQuizId ? renderStartPanel() : '';
  return `
    <div class="section-title"><div><div class="eyebrow">Painel ao vivo</div><h1>Olá, ${escapeHtml(state.auth.admin.name.split(' ')[0])}</h1></div><button id="new-quiz-overview" class="btn btn-primary">+ Criar quiz</button></div>
    <div class="grid-4" style="margin-bottom:22px">
      <div class="metric"><span>Quizzes</span><strong>${state.quizzes.length}</strong></div>
      <div class="metric"><span>Administradores</span><strong>${state.admins.filter((a) => a.active).length}</strong></div>
      <div class="metric"><span>Limite por sala</span><strong>${state.config.maxParticipants}</strong></div>
      <div class="metric"><span>Banco</span><strong style="font-size:20px">${state.auth.persistenceMode === 'postgres' ? 'Conectado' : 'Temporário'}</strong></div>
    </div>
    ${startPanel}
    <div class="section-title"><h2>Escolha um quiz para apresentar</h2></div>
    <div class="grid-3">${state.quizzes.map(quizCard).join('') || '<div class="empty">Nenhum quiz cadastrado.</div>'}</div>`;
}

function quizCard(quiz) {
  const music = state.config.musicThemes.find((item) => item.id === quiz.musicTheme)?.name || 'Sem música';
  return `<article class="card interactive quiz-card">
    <div><div class="eyebrow">${escapeHtml(quiz.ownerName || 'Sistema')}</div><h3>${escapeHtml(quiz.title)}</h3><p class="muted">${escapeHtml(quiz.description || 'Sem descrição')}</p></div>
    <div class="quiz-meta"><span class="chip">❓ ${quiz.questions.length} questões</span><span class="chip">♫ ${escapeHtml(music)}</span></div>
    <div class="quiz-actions">
      <button class="btn btn-primary" data-start-quiz="${escapeHtml(quiz.id)}">▶ Iniciar ao vivo</button>
      <button class="btn btn-light" data-edit-quiz="${escapeHtml(quiz.id)}">Editar</button>
    </div>
  </article>`;
}

function renderStartPanel() {
  const quiz = state.quizzes.find((item) => item.id === state.startQuizId);
  if (!quiz) return '';
  return `<div class="card gradient" style="margin-bottom:22px">
    <div class="section-title"><div><div class="eyebrow" style="background:rgba(255,255,255,.16);color:white">Preparar sala</div><h2>${escapeHtml(quiz.title)}</h2></div><button id="close-start-panel" class="btn btn-light">Cancelar</button></div>
    <div class="grid-2">
      <div>
        <div class="field"><label>Prêmio do 1º lugar</label><input id="prize-first" class="input" value="Vale-presente de R$ 200"></div>
        <div class="field"><label>Prêmio do 2º lugar</label><input id="prize-second" class="input" value="Vale-presente de R$ 100"></div>
        <div class="field"><label>Prêmio do 3º lugar</label><input id="prize-third" class="input" value="Vale-presente de R$ 50"></div>
      </div>
      <div>
        <div class="field"><label>Música do quiz</label><select id="room-music" class="select">${state.config.musicThemes.map((theme) => `<option value="${theme.id}" ${theme.id === quiz.musicTheme ? 'selected' : ''}>${escapeHtml(theme.name)} — ${escapeHtml(theme.description)}</option>`).join('')}</select></div>
        <div class="notice info">Ao clicar em iniciar, você será direcionado para a tela de apresentação, onde controlará todas as etapas.</div>
        <button id="create-live-room" class="btn btn-dark btn-large btn-block">Criar sala e abrir apresentação</button>
      </div>
    </div>
  </div>`;
}

function renderQuizzesTab() {
  if (state.editor) return renderQuizEditor();
  return `
    <div class="section-title"><div><div class="eyebrow">Biblioteca</div><h1>Meus quizzes</h1></div><button id="new-quiz" class="btn btn-primary">+ Novo quiz</button></div>
    <div class="grid-3">${state.quizzes.map((quiz) => `${quizCard(quiz)}<div class="hidden"><button data-delete-quiz="${escapeHtml(quiz.id)}"></button></div>`).join('')}</div>`;
}

function blankQuestion() {
  return { id: randomId('question'), text: '', options: ['', '', '', ''], correctIndex: 0, timeLimit: 20, explanation: '' };
}

function renderQuizEditor() {
  const quiz = state.editor;
  return `
    <div class="section-title"><div><div class="eyebrow">Editor de quiz</div><h1>${quiz.isNew ? 'Novo quiz' : 'Editar quiz'}</h1></div><button id="cancel-editor" class="btn btn-light">Cancelar</button></div>
    <div class="card">
      <div class="grid-2">
        <div class="field"><label>Título do quiz</label><input id="quiz-title" class="input" value="${escapeHtml(quiz.title)}" maxlength="140"></div>
        <div class="field"><label>Música principal</label><select id="quiz-music" class="select">${state.config.musicThemes.map((theme) => `<option value="${theme.id}" ${theme.id === quiz.musicTheme ? 'selected' : ''}>${escapeHtml(theme.name)}</option>`).join('')}</select></div>
      </div>
      <div class="field"><label>Descrição</label><textarea id="quiz-description" class="textarea">${escapeHtml(quiz.description)}</textarea></div>
      <div class="section-title"><h2>Questões</h2><span class="chip">Alternativas vazias não serão exibidas</span></div>
      <div id="questions-editor">${quiz.questions.map((question, index) => renderQuestionEditor(question, index)).join('')}</div>
      <div class="builder-actions"><button id="add-question" class="btn btn-light">+ Adicionar questão</button><button id="save-quiz" class="btn btn-primary btn-large">Salvar quiz</button></div>
    </div>`;
}

function renderQuestionEditor(question, index) {
  const options = [...question.options];
  while (options.length < 6) options.push('');
  return `<div class="builder-question" data-question="${index}">
    <div class="builder-head"><h3>Questão ${index + 1}</h3><button class="btn btn-danger" data-remove-question="${index}" ${state.editor.questions.length <= 1 ? 'disabled' : ''}>Excluir</button></div>
    <div class="field"><label>Enunciado</label><textarea class="textarea question-text" data-index="${index}">${escapeHtml(question.text)}</textarea></div>
    <div class="grid-2"><div class="field"><label>Tempo</label><select class="select question-time" data-index="${index}">${[10,15,20,30,45,60,90,120].map((time) => `<option value="${time}" ${time === Number(question.timeLimit) ? 'selected' : ''}>${time} segundos</option>`).join('')}</select></div><div class="field"><label>Explicação da resposta</label><input class="input question-explanation" data-index="${index}" value="${escapeHtml(question.explanation || '')}"></div></div>
    <label style="font-weight:800;display:block;margin-bottom:10px">Alternativas — marque a correta</label>
    ${options.map((option, optionIndex) => `<div class="option-row"><input type="radio" name="correct-${index}" class="correct-option" data-question-index="${index}" value="${optionIndex}" ${Number(question.correctIndex) === optionIndex ? 'checked' : ''}><input class="input option-input" data-question-index="${index}" data-option-index="${optionIndex}" value="${escapeHtml(option)}" placeholder="Alternativa ${optionIndex + 1} ${optionIndex > 1 ? '(opcional)' : ''}"></div>`).join('')}
  </div>`;
}

function renderAdminsTab() {
  return `
    <div class="section-title"><div><div class="eyebrow">Acessos</div><h1>Administradores</h1></div></div>
    <div class="grid-2">
      <div class="card">
        <h2>Criar novo administrador</h2>
        <p class="muted">O novo usuário poderá entrar no painel e criar os próprios quizzes.</p>
        <div class="field"><label>Nome</label><input id="new-admin-name" class="input"></div>
        <div class="field"><label>E-mail</label><input id="new-admin-email" class="input" type="email"></div>
        <div class="field"><label>Senha inicial</label><input id="new-admin-password" class="input" type="password" minlength="8"><small>Mínimo de oito caracteres.</small></div>
        <button id="create-admin" class="btn btn-primary btn-block">Criar acesso</button>
      </div>
      <div class="card">
        <h2>Acessos cadastrados</h2>
        <div style="display:grid;gap:10px">${state.admins.map((admin) => `<div class="card soft" style="padding:14px"><div class="row space-between"><div><strong>${escapeHtml(admin.name)}</strong><div class="muted">${escapeHtml(admin.email)} · ${admin.role === 'owner' ? 'Principal' : 'Administrador'}</div></div>${state.auth.admin.role === 'owner' && admin.id !== state.auth.admin.id ? `<button class="btn ${admin.active ? 'btn-danger' : 'btn-success'}" data-toggle-admin="${admin.id}" data-active="${admin.active ? '0' : '1'}">${admin.active ? 'Bloquear' : 'Ativar'}</button>` : `<span class="chip">${admin.active ? 'Ativo' : 'Bloqueado'}</span>`}</div></div>`).join('')}</div>
      </div>
    </div>`;
}

function bindDashboardContent() {
  const newQuizButtons = [document.getElementById('new-quiz'), document.getElementById('new-quiz-overview')].filter(Boolean);
  newQuizButtons.forEach((button) => button.addEventListener('click', () => {
    state.dashboardTab = 'quizzes';
    state.editor = { id: randomId('quiz'), title: '', description: '', musicTheme: 'pulse', questions: [blankQuestion()], isNew: true };
    renderDashboard();
  }));

  document.querySelectorAll('[data-start-quiz]').forEach((button) => button.addEventListener('click', () => {
    state.startQuizId = button.dataset.startQuiz;
    state.dashboardTab = 'overview';
    renderDashboard();
  }));
  document.querySelectorAll('[data-edit-quiz]').forEach((button) => button.addEventListener('click', () => {
    const quiz = state.quizzes.find((item) => item.id === button.dataset.editQuiz);
    state.dashboardTab = 'quizzes';
    state.editor = { ...JSON.parse(JSON.stringify(quiz)), isNew: false };
    renderDashboard();
  }));

  const closeStart = document.getElementById('close-start-panel');
  if (closeStart) closeStart.addEventListener('click', () => { state.startQuizId = null; renderDashboard(); });
  const createRoom = document.getElementById('create-live-room');
  if (createRoom) createRoom.addEventListener('click', async () => {
    try {
      ensureAudio();
      createRoom.disabled = true;
      const result = await api('/api/admin/create-room', {
        authToken: state.auth.authToken,
        quizId: state.startQuizId,
        musicTheme: document.getElementById('room-music').value,
        prizes: {
          first: document.getElementById('prize-first').value,
          second: document.getElementById('prize-second').value,
          third: document.getElementById('prize-third').value,
        },
      });
      const creds = { roomCode: result.roomCode, adminToken: result.adminToken };
      sessionStorage.setItem(PRESENTER_KEY(result.roomCode), JSON.stringify(creds));
      location.href = `/?presenter=${encodeURIComponent(result.roomCode)}`;
    } catch (error) {
      createRoom.disabled = false;
      showToast(error.message);
    }
  });

  if (state.editor) bindQuizEditor();

  const createAdmin = document.getElementById('create-admin');
  if (createAdmin) createAdmin.addEventListener('click', async () => {
    try {
      createAdmin.disabled = true;
      await api('/api/admin/create-admin', {
        authToken: state.auth.authToken,
        name: document.getElementById('new-admin-name').value,
        email: document.getElementById('new-admin-email').value,
        password: document.getElementById('new-admin-password').value,
      });
      showToast('Administrador criado.');
      await loadDashboard();
    } catch (error) {
      createAdmin.disabled = false;
      showToast(error.message);
    }
  });
  document.querySelectorAll('[data-toggle-admin]').forEach((button) => button.addEventListener('click', async () => {
    try {
      await api('/api/admin/toggle-admin', { authToken: state.auth.authToken, adminId: button.dataset.toggleAdmin, active: button.dataset.active === '1' });
      await loadDashboard();
    } catch (error) { showToast(error.message); }
  }));
}

function bindQuizEditor() {
  document.getElementById('cancel-editor').addEventListener('click', () => { state.editor = null; renderDashboard(); });
  document.getElementById('quiz-title').addEventListener('input', (event) => state.editor.title = event.target.value);
  document.getElementById('quiz-description').addEventListener('input', (event) => state.editor.description = event.target.value);
  document.getElementById('quiz-music').addEventListener('change', (event) => state.editor.musicTheme = event.target.value);
  document.querySelectorAll('.question-text').forEach((input) => input.addEventListener('input', () => state.editor.questions[Number(input.dataset.index)].text = input.value));
  document.querySelectorAll('.question-time').forEach((input) => input.addEventListener('change', () => state.editor.questions[Number(input.dataset.index)].timeLimit = Number(input.value)));
  document.querySelectorAll('.question-explanation').forEach((input) => input.addEventListener('input', () => state.editor.questions[Number(input.dataset.index)].explanation = input.value));
  document.querySelectorAll('.option-input').forEach((input) => input.addEventListener('input', () => {
    const question = state.editor.questions[Number(input.dataset.questionIndex)];
    while (question.options.length < 6) question.options.push('');
    question.options[Number(input.dataset.optionIndex)] = input.value;
  }));
  document.querySelectorAll('.correct-option').forEach((input) => input.addEventListener('change', () => state.editor.questions[Number(input.dataset.questionIndex)].correctIndex = Number(input.value)));
  document.querySelectorAll('[data-remove-question]').forEach((button) => button.addEventListener('click', () => {
    state.editor.questions.splice(Number(button.dataset.removeQuestion), 1);
    renderDashboard();
  }));
  document.getElementById('add-question').addEventListener('click', () => {
    if (state.editor.questions.length >= 60) return showToast('O limite é de 60 questões por quiz.');
    state.editor.questions.push(blankQuestion());
    renderDashboard();
  });
  document.getElementById('save-quiz').addEventListener('click', saveQuizEditor);
}

async function saveQuizEditor() {
  const quiz = state.editor;
  if (!quiz.title.trim()) return showToast('Informe o título do quiz.');
  for (let i = 0; i < quiz.questions.length; i += 1) {
    const question = quiz.questions[i];
    const filled = question.options.map((text, index) => ({ text: String(text || '').trim(), index })).filter((item) => item.text);
    if (!question.text.trim() || filled.length < 2) return showToast(`Preencha a questão ${i + 1} e pelo menos duas alternativas.`);
    if (!String(question.options[question.correctIndex] || '').trim()) return showToast(`Marque uma alternativa preenchida como correta na questão ${i + 1}.`);
  }
  try {
    const button = document.getElementById('save-quiz');
    button.disabled = true;
    await api('/api/admin/save-quiz', { authToken: state.auth.authToken, quiz });
    state.editor = null;
    showToast('Quiz salvo.');
    await loadDashboard();
  } catch (error) { showToast(error.message); }
}

async function openPlayer(roomCode, accessKey) {
  const stored = sessionStorage.getItem(PLAYER_KEY(roomCode));
  if (stored) {
    try {
      state.playerCreds = JSON.parse(stored);
      const result = await api('/api/player/resume', { roomCode, ...state.playerCreds });
      state.room = result.state;
      state.self = result.self;
      openRoomEvents('player', roomCode, state.playerCreds.playerToken, state.playerCreds.playerId);
      renderPlayerState();
      return;
    } catch (error) {
      sessionStorage.removeItem(PLAYER_KEY(roomCode));
      state.playerCreds = null;
    }
  }
  renderJoin(roomCode, accessKey);
}

function renderJoin(roomCode, accessKey) {
  let selectedAvatar = state.config.avatars[0].id;
  app.innerHTML = `
    ${topbar(`<button id="join-home-back" class="btn btn-light">Sair</button>`)}
    <main class="container narrow">
      <div class="card" style="margin-top:30px">
        <div class="eyebrow">Sala ${escapeHtml(roomCode)}</div>
        <h1>Como você quer aparecer?</h1>
        <div class="grid-2">
          <div class="field"><label>Nome completo</label><input id="full-name" class="input" autocomplete="name" placeholder="Usado no relatório de presença"></div>
          <div class="field"><label>Apelido</label><input id="nickname" class="input" maxlength="24" placeholder="Exibido durante o jogo"></div>
        </div>
        <label style="font-weight:850;display:block;margin-bottom:10px">Escolha um avatar</label>
        <div class="avatar-grid">${state.config.avatars.map((avatar, index) => `<button class="avatar-choice ${index === 0 ? 'selected' : ''}" data-avatar="${avatar.id}">${avatarVisual(avatar)}<small>${escapeHtml(avatar.name)}</small></button>`).join('')}</div>
        <button id="join-room" class="btn btn-primary btn-large btn-block" style="margin-top:20px">Entrar na sala</button>
      </div>
    </main>`;
  document.getElementById('join-home-back').addEventListener('click', () => location.href = '/');
  document.querySelectorAll('[data-avatar]').forEach((button) => button.addEventListener('click', () => {
    selectedAvatar = button.dataset.avatar;
    document.querySelectorAll('[data-avatar]').forEach((item) => item.classList.toggle('selected', item === button));
  }));
  document.getElementById('join-room').addEventListener('click', async () => {
    const button = document.getElementById('join-room');
    try {
      ensureAudio();
      button.disabled = true;
      const result = await api('/api/player/join', {
        roomCode,
        accessKey,
        fullName: document.getElementById('full-name').value,
        nickname: document.getElementById('nickname').value,
        avatarId: selectedAvatar,
      });
      state.playerCreds = { playerId: result.playerId, playerToken: result.playerToken };
      sessionStorage.setItem(PLAYER_KEY(roomCode), JSON.stringify(state.playerCreds));
      state.room = result.state;
      state.self = result.self;
      openRoomEvents('player', roomCode, result.playerToken, result.playerId);
      renderPlayerState();
    } catch (error) {
      button.disabled = false;
      showToast(error.message);
    }
  });
}

function openRoomEvents(role, roomCode, token = '', playerId = '') {
  if (state.eventSource) state.eventSource.close();
  const query = new URLSearchParams({ room: roomCode, role, token, playerId });
  state.eventSource = new EventSource(`/events?${query}`);
  state.eventSource.addEventListener('state', (event) => {
    const data = JSON.parse(event.data);
    if (role === 'player') {
      state.room = data.room;
      state.self = data.self;
      renderPlayerState();
    } else {
      state.room = data;
      if (role === 'admin') renderPresenterState();
      else renderScreenState();
    }
  });
  state.eventSource.addEventListener('kicked', (event) => {
    const data = JSON.parse(event.data);
    sessionStorage.removeItem(PLAYER_KEY(roomCode));
    state.eventSource.close();
    app.innerHTML = `<div class="wait-screen"><div class="wait-card"><h1>Acesso encerrado</h1><p>${escapeHtml(data.message)}</p><a href="/" class="btn btn-light">Voltar ao início</a></div></div>`;
  });
}

function renderPlayerState() {
  const room = state.room;
  syncMusic(room);
  if (room.phase === 'lobby') return renderPlayerLobby(room);
  if (room.phase === 'question') return renderPlayerQuestion(room);
  if (room.phase === 'answer') return renderPlayerAnswer(room);
  if (room.phase === 'ranking') return renderPlayerRanking(room);
  if (room.phase === 'finished') return renderPlayerFinished(room);
}

function renderPlayerLobby(room) {
  clearTimer();
  app.innerHTML = `<div class="wait-screen"><div class="wait-card">${avatarVisual(state.self.avatar)}<h1>Você entrou!</h1><p>${escapeHtml(state.self.nickname)}, aguarde o apresentador iniciar.</p><div class="chip" style="background:rgba(255,255,255,.18);color:white">${room.participantCount}/${room.maxParticipants} participantes</div><div class="spinner" style="margin-top:26px"></div></div></div>`;
}

function renderPlayerQuestion(room) {
  const answered = state.self.answerIndex !== null;
  app.innerHTML = `<div class="game-shell">
    <header class="game-header"><div>${escapeHtml(state.self.nickname)} · ${state.self.score} pontos</div><div class="row"><span>Pergunta ${room.currentQuestionIndex + 1}/${room.totalQuestions}</span><div id="timer" class="timer">${room.question.timeLimit}</div></div></header>
    <main class="game-stage"><h1 class="question-title">${escapeHtml(room.question.text)}</h1><div class="answers-grid">${room.question.options.map((option, index) => `<button class="answer-btn ${answered && state.self.answerIndex === index ? 'selected' : ''}" data-answer="${index}" ${answered ? 'disabled' : ''}><span class="shape"></span><span>${escapeHtml(option)}</span></button>`).join('')}</div>${answered ? '<div class="notice success text-center">Resposta enviada. Aguarde o encerramento.</div>' : ''}</main>
  </div>`;
  startCountdown(room);
  document.querySelectorAll('[data-answer]').forEach((button) => button.addEventListener('click', async () => {
    try {
      ensureAudio();
      document.querySelectorAll('[data-answer]').forEach((item) => item.disabled = true);
      button.classList.add('selected');
      await api('/api/player/answer', { roomCode: room.roomCode, ...state.playerCreds, answerIndex: Number(button.dataset.answer) });
      state.self.answerIndex = Number(button.dataset.answer);
      showToast('Resposta enviada.');
    } catch (error) {
      document.querySelectorAll('[data-answer]').forEach((item) => item.disabled = false);
      showToast(error.message);
    }
  }));
}

function renderPlayerAnswer(room) {
  clearTimer();
  const correct = state.self.lastCorrect;
  app.innerHTML = `<div class="game-shell">
    <header class="game-header"><div>${escapeHtml(state.self.nickname)}</div><div><strong>${state.self.score}</strong> pontos</div></header>
    <main class="game-stage text-center"><div style="font-size:74px">${correct === true ? '✅' : correct === false ? '💡' : '⏱️'}</div><h1 class="question-title">${correct === true ? `Acertou! +${state.self.lastPoints} pontos` : correct === false ? 'Não foi dessa vez' : 'Tempo encerrado'}</h1><div class="answers-grid">${room.question.options.map((option, index) => `<div class="answer-card ${index === room.question.correctIndex ? 'correct' : 'dimmed'}"><span class="shape"></span><span>${escapeHtml(option)}</span></div>`).join('')}</div>${room.question.explanation ? `<div class="card" style="color:var(--ink)"><strong>Por que?</strong><p>${escapeHtml(room.question.explanation)}</p></div>` : ''}<p class="white-muted">O ranking será revelado pelo apresentador.</p></main>
  </div>`;
}

function renderPlayerRanking(room) {
  clearTimer();
  app.innerHTML = `<div class="game-shell"><header class="game-header">${brandMarkup(true)}<span>Ranking atualizado</span></header><main class="game-stage"><h1 class="question-title">Quem está no topo?</h1>${leaderboardMarkup(room.leaderboard)}</main></div>`;
  startRankingAnimation(room);
}

function renderPlayerFinished(room) {
  clearTimer(); stopMusic();
  app.innerHTML = `<div class="game-shell"><header class="game-header">${brandMarkup(true)}<span>Quiz encerrado</span></header><main class="game-stage text-center"><div class="eyebrow" style="margin:auto;background:rgba(255,255,255,.14);color:white">Pódio final</div><h1 class="question-title">Parabéns aos vencedores!</h1>${podiumMarkup(room)}<div class="card" style="color:var(--ink);max-width:520px;margin:20px auto"><h2>Sua colocação</h2><p style="font-size:38px;font-weight:950;margin:8px">${state.self.position || '-'}º</p><p>${state.self.score} pontos · ${state.self.correctAnswers} acertos</p></div><a class="btn btn-light" href="/">Sair</a></main></div>`;
}

async function openPresenter(roomCode) {
  const stored = sessionStorage.getItem(PRESENTER_KEY(roomCode));
  if (!stored) {
    app.innerHTML = `<div class="wait-screen"><div class="wait-card"><h1>Apresentação não encontrada</h1><p>Abra esta sala pelo painel administrativo.</p><button id="go-admin" class="btn btn-light">Ir ao painel</button></div></div>`;
    document.getElementById('go-admin').addEventListener('click', openAdmin);
    return;
  }
  state.presenterCreds = JSON.parse(stored);
  try {
    const result = await api('/api/admin/resume', state.presenterCreds);
    state.room = result.state;
    openRoomEvents('admin', roomCode, state.presenterCreds.adminToken);
    renderPresenterState();
  } catch (error) {
    showToast(error.message);
    sessionStorage.removeItem(PRESENTER_KEY(roomCode));
    openAdmin();
  }
}

function renderPresenterState() {
  const room = state.room;
  syncMusic(room);
  if (room.phase === 'lobby') renderPresenterLobby(room);
  else if (room.phase === 'question') renderPresenterQuestion(room);
  else if (room.phase === 'answer') renderPresenterAnswer(room);
  else if (room.phase === 'ranking') renderPresenterRanking(room);
  else renderPresenterFinished(room);
  bindPresenterControls(room);
}

function presenterHeader(room) {
  return `<header class="presenter-header">${brandMarkup(true)}<div class="row"><span class="chip" style="background:rgba(255,255,255,.12);color:white">${escapeHtml(phaseLabel(room.phase))}</span><button id="audio-toggle" class="btn btn-light">${state.audio.enabled ? '🔊 Som' : '🔇 Som'}</button></div></header>`;
}

function renderPresenterLobby(room) {
  clearTimer();
  app.innerHTML = `<div class="presenter-shell">${presenterHeader(room)}<main class="presenter-stage"><div class="presenter-lobby"><section class="card dark"><div class="eyebrow" style="background:rgba(255,255,255,.12);color:white">Entre pelo QR Code ou código</div><div class="lobby-code">${room.roomCode}</div><div id="presenter-qr" class="qr-wrap" style="margin:24px 0"></div><div class="row"><input id="join-link" class="input" readonly value="${escapeHtml(room.joinUrl)}"><button id="copy-join" class="btn btn-light">Copiar</button></div><p class="white-muted">O link e o QR Code serão substituídos automaticamente após o encerramento.</p></section><section class="card dark"><div class="section-title"><h2>Participantes</h2><span class="chip" style="background:rgba(255,255,255,.13);color:white">${room.participantCount}/${room.maxParticipants}</span></div><div class="player-cloud">${room.players.length ? room.players.map((player) => `<div class="player-pill">${avatarVisual(player.avatar,true)}<div><strong>${escapeHtml(player.nickname)}</strong><div class="white-muted" style="font-size:12px">${escapeHtml(player.fullName)}</div></div></div>`).join('') : '<div class="empty" style="color:rgba(255,255,255,.65);border-color:rgba(255,255,255,.25)">Aguardando participantes...</div>'}</div></section></div></main>${controlDock(room)}</div>`;
  renderQr('presenter-qr', room.joinUrl, 260);
}

function renderPresenterQuestion(room) {
  app.innerHTML = `<div class="presenter-shell">${presenterHeader(room)}<main class="presenter-stage"><div class="question-top"><span class="chip" style="background:rgba(255,255,255,.12);color:white">Pergunta ${room.currentQuestionIndex + 1} de ${room.totalQuestions}</span><div id="timer" class="timer">${room.question.timeLimit}</div><span class="chip" style="background:rgba(255,255,255,.12);color:white">${room.responseCount}/${room.participantCount} respostas</span></div><h1 class="question-title">${escapeHtml(room.question.text)}</h1><div class="answers-grid">${room.question.options.map((option) => `<div class="answer-card"><span class="shape"></span><span>${escapeHtml(option)}</span></div>`).join('')}</div></main>${controlDock(room)}</div>`;
  startCountdown(room);
}

function renderPresenterAnswer(room) {
  clearTimer();
  const maxCount = Math.max(1, ...room.distribution.map((item) => item.count));
  app.innerHTML = `<div class="presenter-shell">${presenterHeader(room)}<main class="presenter-stage"><h1 class="question-title">Resposta correta</h1><div class="answers-grid">${room.question.options.map((option,index) => `<div class="answer-card ${index === room.question.correctIndex ? 'correct' : 'dimmed'}"><span class="shape"></span><span>${escapeHtml(option)}</span></div>`).join('')}</div><div class="distribution">${room.distribution.map((item) => `<div class="distribution-row ${item.correct ? 'correct' : ''}"><strong>${escapeHtml(item.option)}</strong><div class="bar-track"><div class="bar-fill" style="width:${Math.round(item.count / maxCount * 100)}%"></div></div><strong>${item.count}</strong></div>`).join('')}</div>${room.question.explanation ? `<div class="card" style="color:var(--ink)"><h3>Explicação</h3><p>${escapeHtml(room.question.explanation)}</p></div>` : ''}</main>${controlDock(room)}</div>`;
}

function renderPresenterRanking(room) {
  clearTimer();
  app.innerHTML = `<div class="presenter-shell">${presenterHeader(room)}<main class="presenter-stage"><h1 class="question-title">Ranking da rodada</h1>${leaderboardMarkup(room.leaderboard)}</main>${controlDock(room)}</div>`;
  startRankingAnimation(room);
}

function renderPresenterFinished(room) {
  clearTimer(); stopMusic();
  const replacement = room.replacement;
  app.innerHTML = `<div class="presenter-shell">${presenterHeader(room)}<main class="presenter-stage text-center"><div class="eyebrow" style="margin:auto;background:rgba(255,255,255,.14);color:white">Resultado final</div><h1 class="question-title">Pódio do quiz</h1>${podiumMarkup(room)}<div class="grid-2" style="margin-top:30px"><div class="card" style="color:var(--ink);text-align:left"><h2>Relatório completo</h2><p class="muted">Data, horário, presença, pontuação e resposta de cada questão.</p><a class="btn btn-primary btn-block" href="/api/admin/report.xls?room=${encodeURIComponent(room.roomCode)}&token=${encodeURIComponent(state.presenterCreds.adminToken)}">Baixar relatório Excel</a></div>${replacement ? `<div class="card dark"><h2>Novo link e QR Code</h2><p class="white-muted">O código antigo foi encerrado. A próxima sala já está pronta.</p><div class="lobby-code" style="font-size:52px">${replacement.roomCode}</div><div id="replacement-qr" class="qr-wrap" style="margin:18px auto"></div><button id="open-replacement" class="btn btn-light btn-block">Abrir nova sala</button></div>` : ''}</div></main>${controlDock(room)}</div>`;
  if (replacement) renderQr('replacement-qr', replacement.joinUrl, 210);
}

function controlDock(room) {
  let actions = '';
  if (room.phase === 'lobby') actions = `<button class="btn btn-primary btn-large" data-command="start">▶ Iniciar quiz</button><button class="btn btn-danger" data-command="finish">Encerrar sala</button>`;
  if (room.phase === 'question') actions = `<button class="btn btn-warning btn-large" data-command="reveal">✓ Encerrar e revelar resposta</button><button class="btn btn-danger" data-command="finish">Encerrar quiz</button>`;
  if (room.phase === 'answer') actions = `<button class="btn btn-primary btn-large" data-command="ranking">🏆 Mostrar ranking</button><button class="btn btn-danger" data-command="finish">Encerrar quiz</button>`;
  if (room.phase === 'ranking') actions = `<button class="btn btn-primary btn-large" data-command="next">${room.currentQuestionIndex + 1 >= room.totalQuestions ? 'Finalizar e mostrar pódio' : 'Próxima questão →'}</button><button class="btn btn-danger" data-command="finish">Encerrar quiz</button>`;
  if (room.phase === 'finished') actions = `<button class="btn btn-light" id="back-dashboard">Voltar ao painel</button>`;
  return `<div class="control-dock"><div class="control-status"><strong>${escapeHtml(room.quizTitle)}</strong><small>${room.participantCount} presentes · ${room.responseCount} respostas</small></div><div class="control-actions">${actions}</div></div>`;
}

function bindPresenterControls(room) {
  const audioButton = document.getElementById('audio-toggle');
  if (audioButton) audioButton.addEventListener('click', toggleAudio);
  const copyButton = document.getElementById('copy-join');
  if (copyButton) copyButton.addEventListener('click', () => copyText(room.joinUrl));
  document.querySelectorAll('[data-command]').forEach((button) => button.addEventListener('click', async () => {
    try {
      ensureAudio();
      button.disabled = true;
      await api('/api/admin/command', { ...state.presenterCreds, command: button.dataset.command });
    } catch (error) {
      button.disabled = false;
      showToast(error.message);
    }
  }));
  const back = document.getElementById('back-dashboard');
  if (back) back.addEventListener('click', openAdmin);
  const replacementButton = document.getElementById('open-replacement');
  if (replacementButton && room.replacement) replacementButton.addEventListener('click', () => {
    const creds = { roomCode: room.replacement.roomCode, adminToken: room.replacement.adminToken };
    sessionStorage.setItem(PRESENTER_KEY(room.replacement.roomCode), JSON.stringify(creds));
    location.href = `/?presenter=${encodeURIComponent(room.replacement.roomCode)}`;
  });
}

async function openScreen(roomCode) {
  try {
    const result = await api('/api/screen/join', { roomCode });
    state.room = result.state;
    openRoomEvents('screen', roomCode);
    renderScreenState();
  } catch (error) {
    app.innerHTML = `<div class="wait-screen"><div class="wait-card"><h1>Sala não encontrada</h1><p>${escapeHtml(error.message)}</p><a class="btn btn-light" href="/">Voltar</a></div></div>`;
  }
}

function renderScreenState() {
  // Tela sem controles, útil quando o instrutor deseja projetar em outro equipamento.
  const room = state.room;
  syncMusic(room);
  if (room.phase === 'lobby') {
    app.innerHTML = `<div class="presenter-shell">${presenterHeader(room)}<main class="presenter-stage text-center"><div class="eyebrow" style="margin:auto;background:rgba(255,255,255,.14);color:white">Entre na sala</div><div class="lobby-code">${room.roomCode}</div><div id="screen-qr" class="qr-wrap" style="margin:24px auto"></div><h2>${room.participantCount}/${room.maxParticipants} participantes</h2></main></div>`;
    renderQr('screen-qr', room.joinUrl, 280);
  } else if (room.phase === 'question') {
    app.innerHTML = `<div class="presenter-shell">${presenterHeader(room)}<main class="presenter-stage"><div class="question-top"><span>Pergunta ${room.currentQuestionIndex + 1}/${room.totalQuestions}</span><div id="timer" class="timer">${room.question.timeLimit}</div><span>${room.responseCount}/${room.participantCount} respostas</span></div><h1 class="question-title">${escapeHtml(room.question.text)}</h1><div class="answers-grid">${room.question.options.map((option) => `<div class="answer-card"><span class="shape"></span>${escapeHtml(option)}</div>`).join('')}</div></main></div>`;
    startCountdown(room);
  } else if (room.phase === 'answer') {
    renderPresenterAnswer(room);
    const dock = document.querySelector('.control-dock'); if (dock) dock.remove();
  } else if (room.phase === 'ranking') {
    app.innerHTML = `<div class="presenter-shell">${presenterHeader(room)}<main class="presenter-stage"><h1 class="question-title">Ranking</h1>${leaderboardMarkup(room.leaderboard)}</main></div>`;
    startRankingAnimation(room);
  } else {
    app.innerHTML = `<div class="presenter-shell">${presenterHeader(room)}<main class="presenter-stage text-center"><h1 class="question-title">Pódio final</h1>${podiumMarkup(room)}</main></div>`;
  }
  const audioButton = document.getElementById('audio-toggle'); if (audioButton) audioButton.addEventListener('click', toggleAudio);
}

function leaderboardMarkup(leaderboard) {
  return `<div class="leaderboard">${leaderboard.map((entry, index) => `<div class="rank-row ${entry.position <= 3 ? `top-${entry.position}` : ''}" data-rank-row style="animation-delay:${Math.min(index,12) * .12}s"><div class="rank-position">${entry.position}º</div>${avatarVisual(entry.avatar,true)}<div><strong>${escapeHtml(entry.nickname)}</strong><div class="muted">${entry.correctAnswers} acertos ${entry.lastPoints ? `· +${entry.lastPoints}` : ''}</div></div><div class="rank-score">${entry.score}</div></div>`).join('')}</div>`;
}

function startRankingAnimation(room) {
  const key = `${room.roomCode}-${room.currentQuestionIndex}-${room.phase}`;
  if (state.lastRankingKey === key) {
    document.querySelectorAll('[data-rank-row]').forEach((row) => row.classList.add('revealed'));
    return;
  }
  state.lastRankingKey = key;
  playSuspense();
  const overlay = document.createElement('div');
  overlay.className = 'suspense-overlay';
  overlay.innerHTML = `<div><div id="suspense-number" class="suspense-number">3</div><div class="suspense-label">Preparando o ranking...</div></div>`;
  document.body.appendChild(overlay);
  const number = overlay.querySelector('#suspense-number');
  setTimeout(() => number.textContent = '2', 900);
  setTimeout(() => number.textContent = '1', 1800);
  setTimeout(() => {
    overlay.remove();
    document.querySelectorAll('[data-rank-row]').forEach((row) => row.classList.add('revealed'));
  }, 2850);
}

function podiumMarkup(room) {
  const top = room.leaderboard.slice(0, 3);
  const get = (position) => top.find((item) => item.position === position);
  const places = [
    { position: 2, className: 'second', medal: '🥈', prize: room.prizes.second },
    { position: 1, className: 'first', medal: '🥇', prize: room.prizes.first },
    { position: 3, className: 'third', medal: '🥉', prize: room.prizes.third },
  ];
  return `<div class="podium">${places.map((place) => {
    const person = get(place.position);
    return `<div class="podium-place ${place.className}"><div>${person ? avatarVisual(person.avatar,true) : ''}</div><div class="podium-name">${person ? escapeHtml(person.nickname) : '—'}</div><div class="podium-prize">${escapeHtml(place.prize || '')}</div><div class="podium-step">${place.medal}</div></div>`;
  }).join('')}</div>`;
}

window.addEventListener('beforeunload', () => {
  if (state.eventSource) state.eventSource.close();
  stopMusic();
});

init();
