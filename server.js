'use strict';

const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 4000);
const TARGET_URL = String(process.env.TARGET_URL || '').trim().replace(/\/$/, '');
const SIMULATOR_PASSWORD = String(process.env.SIMULATOR_PASSWORD || '');
const MAX_TEST_PARTICIPANTS = 500;

let activeJob = null;

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function html(res, body) {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 200_000) {
        reject(new Error('Payload muito grande.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch (error) { reject(error); }
    });
    req.on('error', reject);
  });
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function post(path, payload, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const response = await fetch(`${TARGET_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || `HTTP ${response.status}`);
    return { data, latencyMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function updateLatency(job, kind, ms) {
  job.latencies[kind].push(ms);
  if (job.latencies[kind].length > 5000) job.latencies[kind].shift();
}

function snapshot(job) {
  return {
    id: job.id,
    phase: job.phase,
    message: job.message,
    requested: job.requested,
    joined: job.joined,
    ready: job.ready,
    sseConnected: job.sseConnected,
    answersSent: job.answersSent,
    answerErrors: job.answerErrors,
    joinErrors: job.joinErrors,
    readyErrors: job.readyErrors,
    currentQuestion: job.currentQuestion,
    finished: job.finished,
    stopped: job.stopped,
    startedAt: job.startedAt,
    elapsedSeconds: Math.round((Date.now() - job.startedAtMs) / 1000),
    target: TARGET_URL,
    metrics: {
      joinAvgMs: job.latencies.join.length ? Math.round(job.latencies.join.reduce((a,b)=>a+b,0) / job.latencies.join.length) : 0,
      joinP95Ms: percentile(job.latencies.join, 95),
      readyAvgMs: job.latencies.ready.length ? Math.round(job.latencies.ready.reduce((a,b)=>a+b,0) / job.latencies.ready.length) : 0,
      answerAvgMs: job.latencies.answer.length ? Math.round(job.latencies.answer.reduce((a,b)=>a+b,0) / job.latencies.answer.length) : 0,
      answerP95Ms: percentile(job.latencies.answer, 95),
    },
    recentErrors: job.errors.slice(-8),
  };
}

async function pacedMap(count, intervalMs, concurrency, worker, job) {
  const inFlight = new Set();
  for (let i = 1; i <= count; i += 1) {
    if (job.stopped) break;
    while (inFlight.size >= concurrency && !job.stopped) await Promise.race(inFlight);
    const task = Promise.resolve().then(() => worker(i)).catch(() => {}).finally(() => inFlight.delete(task));
    inFlight.add(task);
    if (intervalMs > 0) await sleep(intervalMs);
  }
  await Promise.allSettled([...inFlight]);
}

async function openPlayerSse(job, player) {
  const controller = new AbortController();
  player.controller = controller;
  const query = new URLSearchParams({
    room: job.roomCode,
    role: 'player',
    token: player.playerToken,
    playerId: player.playerId,
  });
  try {
    const response = await fetch(`${TARGET_URL}/events?${query}`, {
      headers: { Accept: 'text/event-stream' },
      signal: controller.signal,
    });
    if (!response.ok || !response.body) throw new Error(`SSE HTTP ${response.status}`);
    job.sseConnected += 1;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (!job.stopped) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let cut;
      while ((cut = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        if (!block || block.startsWith(':')) continue;
        let eventName = 'message';
        let dataText = '';
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) eventName = line.slice(6).trim();
          else if (line.startsWith('data:')) dataText += line.slice(5).trim();
        }
        if (eventName === 'state' && dataText) {
          try {
            const payload = JSON.parse(dataText);
            const room = payload.room || payload;
            if (room.phase === 'question' && room.question) {
              const questionKey = `${room.currentQuestionIndex}:${room.question.id || room.question.text}`;
              job.currentQuestion = room.currentQuestionIndex + 1;
              if (!player.answeredQuestions.has(questionKey)) {
                player.answeredQuestions.add(questionKey);
                const maxDelay = Math.max(100, job.answerJitterMs);
                const wait = 80 + Math.floor(Math.random() * maxDelay);
                setTimeout(() => sendAnswer(job, player, room, questionKey).catch(() => {}), wait);
              }
            }
            if (room.phase === 'finished' && !job.finished) {
              job.finished = true;
              job.phase = 'finalizado';
              job.message = 'Quiz finalizado. Relatório do teste pronto.';
              setTimeout(() => stopJob(job, false), 1800);
            }
          } catch (_) {}
        }
      }
    }
  } catch (error) {
    if (!job.stopped && error.name !== 'AbortError') {
      job.errors.push(`SSE ${player.name}: ${error.message}`);
    }
  }
}

async function sendAnswer(job, player, room) {
  if (job.stopped || room.phase !== 'question') return;
  const optionCount = Array.isArray(room.question.options) ? room.question.options.length : 4;
  const answerIndex = Math.floor(Math.random() * Math.max(1, optionCount));
  try {
    const { latencyMs } = await post('/api/player/answer', {
      roomCode: job.roomCode,
      playerId: player.playerId,
      playerToken: player.playerToken,
      answerIndex,
    });
    job.answersSent += 1;
    updateLatency(job, 'answer', latencyMs);
  } catch (error) {
    job.answerErrors += 1;
    job.errors.push(`Resposta ${player.name}: ${error.message}`);
  }
}

async function runTest(job) {
  try {
    job.phase = 'configurando';
    job.message = 'Validando o NZN e carregando avatares...';
    const configResponse = await fetch(`${TARGET_URL}/api/public/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', cache: 'no-store' });
    if (!configResponse.ok) throw new Error(`Não consegui acessar ${TARGET_URL}/api/public/config`);
    const config = await configResponse.json();
    const avatars = Array.isArray(config.avatars) && config.avatars.length ? config.avatars : [{ id: 'astro-neon' }];

    job.phase = 'entrando';
    job.message = `Criando ${job.requested} participantes virtuais...`;
    await pacedMap(job.requested, job.joinIntervalMs, 35, async (index) => {
      if (job.stopped) return;
      const name = `Teste ${String(index).padStart(3, '0')}`;
      try {
        const avatar = avatars[(index - 1) % avatars.length];
        const { data, latencyMs } = await post('/api/player/join', {
          roomCode: job.roomCode,
          fullName: name,
          avatarId: avatar.id,
        }, 20000);
        const player = {
          name,
          playerId: data.playerId,
          playerToken: data.playerToken,
          answeredQuestions: new Set(),
          controller: null,
        };
        job.players.push(player);
        job.joined += 1;
        updateLatency(job, 'join', latencyMs);
        openPlayerSse(job, player);
      } catch (error) {
        job.joinErrors += 1;
        job.errors.push(`Entrada ${name}: ${error.message}`);
      }
    }, job);

    if (job.stopped) return;
    job.phase = 'preparando';
    job.message = `${job.joined} participantes entraram. Marcando todos como prontos...`;
    await pacedMap(job.players.length, Math.max(0, Math.floor(job.joinIntervalMs / 2)), 45, async (index) => {
      const player = job.players[index - 1];
      if (!player || job.stopped) return;
      try {
        const { latencyMs } = await post('/api/player/ready', {
          roomCode: job.roomCode,
          playerId: player.playerId,
          playerToken: player.playerToken,
          ready: true,
        }, 20000);
        job.ready += 1;
        updateLatency(job, 'ready', latencyMs);
      } catch (error) {
        job.readyErrors += 1;
        job.errors.push(`Pronto ${player.name}: ${error.message}`);
      }
    }, job);

    if (job.stopped) return;
    job.phase = 'aguardando';
    job.message = `${job.ready}/${job.joined} participantes prontos. Agora inicie o quiz normalmente na tela do apresentador.`;
  } catch (error) {
    job.phase = 'erro';
    job.message = error.message;
    job.errors.push(error.message);
  }
}

function stopJob(job, manual = true) {
  if (!job || job.stopped) return;
  job.stopped = true;
  if (manual && !job.finished) {
    job.phase = 'interrompido';
    job.message = 'Teste interrompido.';
  }
  for (const player of job.players) {
    try { player.controller?.abort(); } catch (_) {}
  }
}

function page() {
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>NZN — Simulador de Carga</title>
<style>
:root{font-family:Inter,system-ui,Arial,sans-serif;color:#172033;background:#eef4fb}*{box-sizing:border-box}body{margin:0}.wrap{max-width:1040px;margin:auto;padding:32px 18px}.hero{background:linear-gradient(135deg,#0f172a,#183662);color:#fff;padding:30px;border-radius:28px;margin-bottom:18px;box-shadow:0 20px 40px #10213c25}.hero h1{margin:0 0 8px;font-size:36px}.hero p{margin:0;color:#d5e2f6}.grid{display:grid;grid-template-columns:380px 1fr;gap:18px}.card{background:#fff;border:1px solid #d9e3ef;border-radius:24px;padding:22px;box-shadow:0 14px 34px #14213d12}.field{display:grid;gap:7px;margin:14px 0}.field label{font-weight:800;font-size:13px}.field input,.field select{height:48px;border:1px solid #cbd8e6;border-radius:14px;padding:0 14px;font-size:16px}.btn{border:0;border-radius:14px;padding:14px 18px;font-weight:800;cursor:pointer}.primary{background:#0f274b;color:#fff;width:100%}.danger{background:#fee2e2;color:#991b1b;width:100%;margin-top:9px}.muted{color:#64748b;font-size:14px;line-height:1.5}.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:16px 0}.stat{padding:14px;background:#f6f9fc;border:1px solid #e0e8f1;border-radius:16px}.stat strong{display:block;font-size:25px}.stat span{font-size:12px;color:#64748b}.status{padding:14px;border-radius:16px;background:#eff6ff;border:1px solid #bfdbfe;margin-bottom:14px}.errors{font-size:12px;color:#991b1b;max-height:150px;overflow:auto;white-space:pre-wrap}.tag{display:inline-block;padding:6px 10px;background:#e8eef8;border-radius:999px;font-size:12px;font-weight:800;margin-bottom:10px}@media(max-width:800px){.grid{grid-template-columns:1fr}.stats{grid-template-columns:repeat(2,1fr)}}
</style></head><body><div class="wrap">
<section class="hero"><div class="tag">Ferramenta de teste</div><h1>NZN — Simulador de Carga</h1><p>Crie até 500 participantes virtuais, marque todos como prontos e deixe-os responder automaticamente durante o quiz.</p></section>
<div class="grid"><section class="card"><h2>Configurar teste</h2><p class="muted">Use somente na sua própria plataforma NZN. O endereço de destino é definido no Render pela variável TARGET_URL.</p>
<div class="field"><label>Destino</label><input value="${TARGET_URL || 'TARGET_URL não configurada'}" disabled></div>
<div class="field"><label>Código da sala</label><input id="room" inputmode="numeric" maxlength="6" placeholder="000000"></div>
<div class="field"><label>Participantes virtuais</label><select id="count"><option>50</option><option>100</option><option>250</option><option selected>500</option></select></div>
<div class="field"><label>Intervalo entre entradas</label><select id="interval"><option value="50">50 ms — leve</option><option value="25" selected>25 ms — recomendado</option><option value="10">10 ms — agressivo</option></select></div>
<div class="field"><label>Senha do simulador</label><input id="password" type="password" placeholder="Definida no Render"></div>
<button class="btn primary" id="start">Iniciar teste</button><button class="btn danger" id="stop">Interromper teste</button></section>
<section class="card"><h2>Acompanhamento</h2><div id="status" class="status">Nenhum teste em execução.</div><div class="stats">
<div class="stat"><strong id="joined">0</strong><span>Entraram</span></div><div class="stat"><strong id="ready">0</strong><span>Prontos</span></div><div class="stat"><strong id="sse">0</strong><span>Conexões ao vivo</span></div><div class="stat"><strong id="answers">0</strong><span>Respostas</span></div><div class="stat"><strong id="join95">0 ms</strong><span>Entrada p95</span></div><div class="stat"><strong id="answer95">0 ms</strong><span>Resposta p95</span></div></div>
<p class="muted">Quando todos estiverem prontos, abra o apresentador do NZN e inicie o quiz normalmente. Os participantes virtuais responderão sozinhos.</p><div id="errors" class="errors"></div></section></div></div>
<script>
let jobId=null,timer=null;
const $=id=>document.getElementById(id);
async function update(){if(!jobId)return;const r=await fetch('/api/status?id='+encodeURIComponent(jobId));const d=await r.json();if(!d.ok)return;$('status').textContent=d.job.message+'  •  '+d.job.phase;$('joined').textContent=d.job.joined+'/'+d.job.requested;$('ready').textContent=d.job.ready;$('sse').textContent=d.job.sseConnected;$('answers').textContent=d.job.answersSent;$('join95').textContent=d.job.metrics.joinP95Ms+' ms';$('answer95').textContent=d.job.metrics.answerP95Ms+' ms';$('errors').textContent=(d.job.recentErrors||[]).join('\n');}
$('start').onclick=async()=>{const body={password:$('password').value,roomCode:$('room').value,participants:Number($('count').value),joinIntervalMs:Number($('interval').value)};const r=await fetch('/api/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const d=await r.json();if(!d.ok){alert(d.message);return}jobId=d.jobId;clearInterval(timer);timer=setInterval(update,1000);update();};
$('stop').onclick=async()=>{if(!jobId)return;await fetch('/api/stop',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:$('password').value,id:jobId})});update();};
</script></body></html>`;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'GET' && url.pathname === '/') return html(res, page());
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true, version: '1.0.0', targetConfigured: Boolean(TARGET_URL), passwordConfigured: Boolean(SIMULATOR_PASSWORD) });
    if (req.method === 'GET' && url.pathname === '/api/status') {
      const id = String(url.searchParams.get('id') || '');
      if (!activeJob || activeJob.id !== id) return json(res, 404, { ok: false, message: 'Teste não encontrado.' });
      return json(res, 200, { ok: true, job: snapshot(activeJob) });
    }
    if (req.method === 'POST' && url.pathname === '/api/start') {
      const body = await readJson(req);
      if (!TARGET_URL) return json(res, 503, { ok: false, message: 'Configure TARGET_URL no Render do simulador.' });
      if (!SIMULATOR_PASSWORD) return json(res, 503, { ok: false, message: 'Configure SIMULATOR_PASSWORD no Render do simulador.' });
      if (String(body.password || '') !== SIMULATOR_PASSWORD) return json(res, 403, { ok: false, message: 'Senha do simulador incorreta.' });
      if (activeJob && !activeJob.stopped && !activeJob.finished) return json(res, 409, { ok: false, message: 'Já existe um teste em andamento. Interrompa-o antes de iniciar outro.' });
      const participants = Math.max(1, Math.min(MAX_TEST_PARTICIPANTS, Number(body.participants) || 50));
      const roomCode = String(body.roomCode || '').replace(/\D/g, '').slice(0, 6);
      if (roomCode.length !== 6) return json(res, 400, { ok: false, message: 'Informe um código de sala com 6 números.' });
      activeJob = {
        id: crypto.randomUUID(), roomCode, requested: participants,
        joinIntervalMs: Math.max(5, Math.min(500, Number(body.joinIntervalMs) || 25)),
        answerJitterMs: 1400,
        players: [], joined: 0, ready: 0, sseConnected: 0, answersSent: 0,
        answerErrors: 0, joinErrors: 0, readyErrors: 0, currentQuestion: 0,
        phase: 'iniciando', message: 'Preparando teste...', finished: false, stopped: false,
        startedAt: new Date().toISOString(), startedAtMs: Date.now(), errors: [],
        latencies: { join: [], ready: [], answer: [] },
      };
      runTest(activeJob);
      return json(res, 202, { ok: true, jobId: activeJob.id });
    }
    if (req.method === 'POST' && url.pathname === '/api/stop') {
      const body = await readJson(req);
      if (String(body.password || '') !== SIMULATOR_PASSWORD) return json(res, 403, { ok: false, message: 'Senha incorreta.' });
      if (!activeJob || activeJob.id !== String(body.id || '')) return json(res, 404, { ok: false, message: 'Teste não encontrado.' });
      stopJob(activeJob, true);
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { ok: false, message: 'Não encontrado.' });
  } catch (error) {
    return json(res, 500, { ok: false, message: error.message });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`NZN Simulador de Carga em http://0.0.0.0:${PORT}`);
  console.log(`Destino: ${TARGET_URL || 'não configurado'}`);
});
