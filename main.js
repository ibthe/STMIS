const { app, BrowserWindow, ipcMain, desktopCapturer, screen, globalShortcut, Tray, Menu, nativeImage,
        systemPreferences, shell, dialog, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile, spawn } = require('child_process');
try { os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch (e) {}

const HEADER = 44, BORDER = 14; // должны совпадать с index.html
const VISION = { en: 'en-US', ru: 'ru-RU', de: 'de-DE', fr: 'fr-FR', es: 'es-ES', zh: 'zh-Hans', ja: 'ja-JP' };
const WINOCR = { en: 'en-US', ru: 'ru-RU', de: 'de-DE', fr: 'fr-FR', es: 'es-ES', zh: 'zh-Hans-CN', ja: 'ja-JP' };
const FRANC = { eng: 'en', rus: 'ru', deu: 'de', fra: 'fr', spa: 'es', cmn: 'zh', jpn: 'ja' };
const S = { auto: true, engine: 'google', src: 'en', tgt: 'ru', llmModel: process.platform === 'win32' ? 'translategemma:12b' : 'translategemma:4b', legacyCapture: false, bounds: null };
let win, tray, paused = false, busy = false, prev = null, lastSig = null, movingSince = 0, idle = 0;
let start = null, lastItems = 0, lastTexts = [], gen = 0, forceOnce = false, moveWait = 4000;
const stat = { grab: 0, ocr: 0, tr: 0, runs: 0, polls: 0, engine: '', err: '' };
const send = (ch, d) => win && !win.isDestroyed() && win.webContents.send(ch, d);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- помощники ----------
// macOS: capture (Swift): снимок без окна приложения + Apple Vision OCR
const helperPath = path.join(process.resourcesPath || '', 'capture');
let helperBroken = false, helperFails = 0, helperErr = '';
const useHelper = () => process.platform === 'darwin' && !helperBroken && fs.existsSync(helperPath);
// Windows: встроенный Windows OCR через постоянный процесс PowerShell (native/ocr.ps1)
const psScript = () => [path.join(process.resourcesPath || '', 'ocr.ps1'), path.join(__dirname, 'native', 'ocr.ps1')].find((p) => fs.existsSync(p));
let ps = null, psBuf = '', psWait = [];
const useWinOcr = () => process.platform === 'win32' && !!psScript();

// Определяется самотестом при запуске: видит ли захват экрана само окно приложения
const hideMode = () => useHelper() ? false : S.capturesSelf !== undefined
  ? !!S.capturesSelf
  : process.platform === 'darwin' && parseInt(os.release(), 10) >= 24 && !S.legacyCapture;

// ---------- настройки ----------
const SF = () => path.join(app.getPath('userData'), 'settings.json');
function load() { try { Object.assign(S, JSON.parse(fs.readFileSync(SF(), 'utf8'))); } catch (e) {} }
function save() { try { if (win) S.bounds = win.getBounds(); fs.writeFileSync(SF(), JSON.stringify(S)); } catch (e) {} }

// ---------- окно ----------
function createWindow() {
  const bb = S.bounds;
  const ok = bb && screen.getAllDisplays().some((d) => {
    const cx = bb.x + bb.width / 2, cy = bb.y + bb.height / 2;
    return cx >= d.bounds.x && cx < d.bounds.x + d.bounds.width && cy >= d.bounds.y && cy < d.bounds.y + d.bounds.height;
  });
  win = new BrowserWindow({
    width: 760, height: 260, ...(ok ? bb : {}), minWidth: 360, minHeight: 140,
    transparent: true, frame: false, hasShadow: false, alwaysOnTop: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setContentProtection(true);
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile('index.html');
  win.webContents.once('did-finish-load', async () => {
    send('init', { engine: S.engine, src: S.src, tgt: S.tgt, paused });
    send('status', `Screen Translator v${app.getVersion()}`);
    await Promise.race([selfTest(), sleep(8000)]);
    tick();
  });
}

function setPaused(p) {
  paused = p; prev = null;
  send('paused', p);
  if (p) { send('result', []); lastItems = 0; }
  refreshMenu();
}
function toggleVisible() { if (win.isVisible()) win.hide(); else win.showInactive(); prev = null; refreshMenu(); }
function setLlm(m) { S.llmModel = m; llmReady = ''; save(); gen++; prev = null; abortDownloads(); send('progress', null); send('status', ''); refreshMenu(); }
function setAuto(v) { S.auto = v; save(); prev = null; refreshMenu(); }
function force() { forceOnce = true; prev = null; }
function copyAll() {
  if (!lastTexts.length) return send('status', 'Нечего копировать');
  clipboard.writeText(lastTexts.join('\n\n')); send('status', 'Весь перевод скопирован');
}

// Самотест: окно на миг заливается пурпуром; если пурпур виден на снимке, окно попадает в захват
async function selfTest() {
  try {
    await sleep(800);
    const b = win.getBounds(), d = screen.getDisplayMatching(b);
    send('selftest', true); await sleep(300);
    const img = await grab(d, b, 0.33, true);
    send('selftest', false);
    if (!img) return;
    const { width, height } = img.getSize();
    const bm = img.toBitmap(), i = ((height >> 1) * width + (width >> 1)) * 4;
    S.capturesSelf = bm[i] > 200 && bm[i + 1] < 90 && bm[i + 2] > 200;
    save();
    if (S.capturesSelf && process.platform === 'darwin' && !S.legacyCapture && !S.legacyTried && !useHelper()) {
      S.legacyTried = true; S.legacyCapture = true; save(); app.relaunch(); app.exit(0);
    }
  } catch (e) { send('selftest', false); }
}

async function diag() {
  app.getAppMetrics(); await sleep(1500);
  const cpu = app.getAppMetrics().map((m) => `  ${m.type}: ${m.cpu.percentCPUUsage.toFixed(1)}%`).join('\n');
  const n = Math.max(1, stat.polls), r = Math.max(1, stat.runs);
  dialog.showMessageBox({
    type: 'info', title: 'Диагностика', message: 'Screen Translator ' + app.getVersion(),
    detail: [
      `ОС: ${process.platform} ${os.release()}, Electron ${process.versions.electron}`,
      `Захват: ${useHelper() ? 'помощник ScreenCaptureKit (без окна приложения)' : 'стандартный'}; окно попадает в захват: ${S.capturesSelf === undefined ? 'не проверено' : S.capturesSelf ? 'да' : 'нет'}`,
      `Распознавание: ${stat.engine || 'ещё не запускалось'}${stat.err ? '\nПоследняя ошибка OCR: ' + stat.err : ''}`,
      `Режим: ${S.auto === false ? 'по горячей клавише' : 'авто'}, движок: ${S.engine}, язык: ${S.src} → ${S.tgt}, AI: ${S.llmModel} (Ollama: ${ollamaProc ? 'запущена приложением' : 'внешняя/не запущена'})`,
      `Проверок экрана: ${stat.polls}, среднее ${Math.round(stat.grab / n)} мс`,
      `Распознаваний: ${stat.runs}, OCR в среднем ${Math.round(stat.ocr / r)} мс, перевод ${Math.round(stat.tr / r)} мс`,
      `Нагрузка процессов:`, cpu,
      process.platform === 'win32' ? '\nЕсли Windows OCR пишет «no-ocr-language»: Параметры → Время и язык → Язык и регион → добавить язык (English) → «Распознавание текста».' : '',
    ].join('\n'),
  });
}

function buildTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'tray.png')).resize({ width: 18, height: 18 });
  tray = new Tray(icon);
  tray.setToolTip('Screen Translator v' + app.getVersion());
  tray.on('click', toggleVisible);
  refreshMenu();
}
function refreshMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: win.isVisible() ? 'Скрыть окно' : 'Показать окно', click: toggleVisible },
    { label: paused ? 'Продолжить перевод' : 'Пауза', click: () => setPaused(!paused) },
    { label: 'Автоперевод (иначе — по Ctrl/Cmd+Shift+Y)', type: 'checkbox', checked: S.auto !== false, click: () => setAuto(S.auto === false) },
    { label: 'Перевести сейчас', click: force },
    { label: 'Копировать весь перевод (Ctrl/Cmd+Alt+C)', click: copyAll },
    { label: 'AI-модель (Ollama, кнопка AI)', submenu: [
      { label: 'TranslateGemma 4B (3.3 ГБ, быстрее)', type: 'radio', checked: S.llmModel === 'translategemma:4b', click: () => setLlm('translategemma:4b') },
      { label: 'TranslateGemma 12B (8.1 ГБ, качественнее)', type: 'radio', checked: S.llmModel === 'translategemma:12b', click: () => setLlm('translategemma:12b') },
    ] },
    ...(process.platform === 'darwin' ? [{
      label: 'Настройки записи экрана…',
      click: () => shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'),
    }, {
      label: 'Совместимый захват экрана (перезапуск)', type: 'checkbox', checked: !!S.legacyCapture,
      click: () => { S.legacyCapture = !S.legacyCapture; save(); app.relaunch(); app.exit(0); },
    }] : []),
    { label: 'Диагностика…', click: diag },
    { type: 'separator' },
    { label: 'Выход', click: () => app.quit() },
  ]));
}

ipcMain.on('ignore', (_, v) => win.setIgnoreMouseEvents(v, { forward: true }));
ipcMain.on('drag', (_, m) => {
  if (m.phase === 'start') { start = win.getBounds(); return; }
  if (m.phase === 'end') { start = null; prev = null; save(); return; }
  if (!start) return;
  if (m.mode === 'move') win.setBounds({ ...start, x: start.x + m.dx, y: start.y + m.dy });
  else win.setBounds({ ...start, width: Math.max(360, start.width + m.dx), height: Math.max(140, start.height + m.dy) });
});
ipcMain.on('set', (_, s) => { Object.assign(S, s); prev = null; save(); gen++; abortDownloads(); send('progress', null); send('status', ''); });
ipcMain.on('pause', (_, p) => setPaused(p));
ipcMain.on('copy', (_, t) => { clipboard.writeText(String(t)); send('status', 'Скопировано'); });
ipcMain.on('copyAll', copyAll);
ipcMain.on('close', () => app.quit());

// доля заметно изменившихся пикселей (ловит и смену одной строки текста)
function differs(a, b) {
  if (!a || !b || a.length !== b.length) return true;
  let n = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 48) n++;
  }
  return n > (a.length / 4) * 0.003;
}

// ---------- OCR ----------
// 1) macOS: Apple Vision через помощник (снимок и распознавание — двумя отдельными вызовами)
let helperOcrDone = false;
function whyFailed(err, stderr, timeout) {
  const last = String(stderr || '').trim().split('\n').filter(Boolean).pop() || 'нет сообщения';
  if (err.killed) return `таймаут ${Math.round(timeout / 1000)} с, последний шаг: ${last}`;
  return `код ${err.code}${err.signal ? ', сигнал ' + err.signal : ''}: ${last}`;
}
function helperOcr(file) {
  const langs = S.src === 'auto' ? '' : VISION[S.src];
  const timeout = helperOcrDone ? 30000 : 150000;
  if (!helperOcrDone) send('progress', { text: 'Первый запуск Apple Vision: готовится модель (до 2 минут)…', pct: null });
  return new Promise((resolve) => execFile(helperPath, ['ocr', file, langs], { timeout, maxBuffer: 16 << 20 }, (err, stdout, stderr) => {
    send('progress', null);
    if (err) { helperErr = 'Vision: ' + whyFailed(err, stderr, timeout); return resolve(null); }
    try { const j = JSON.parse(stdout); helperOcrDone = true; resolve(j); } catch (e) { helperErr = 'Vision: некорректный ответ'; resolve(null); }
  }));
}
function helperShot(d, b, scale) {
  const out = path.join(os.tmpdir(), `st-${process.pid}-${scale > 0.5 ? 'f' : 's'}.png`);
  const w = b.width - 2 * BORDER, h = b.height - HEADER - BORDER;
  const args = ['shot', d.id, b.x - d.bounds.x + BORDER, b.y - d.bounds.y + HEADER, w, h,
    Math.max(8, Math.round(w * scale)), Math.max(8, Math.round(h * scale)), process.pid, out].map(String);
  return new Promise((resolve) => execFile(helperPath, args, { timeout: 15000 }, (err, stdout, stderr) => {
    if (err) { helperErr = 'Снимок: ' + whyFailed(err, stderr, 15000); return resolve(null); }
    const img = nativeImage.createFromPath(out);
    resolve(img.isEmpty() ? null : img);
  }));
}

// 2) Windows: Windows OCR через постоянный PowerShell
function startPs() {
  ps = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', psScript()], { windowsHide: true });
  ps.stdout.setEncoding('utf8');
  ps.stdout.on('data', (chunk) => {
    psBuf += chunk;
    let i;
    while ((i = psBuf.indexOf('\n')) >= 0) {
      const line = psBuf.slice(0, i).trim(); psBuf = psBuf.slice(i + 1);
      if (!line.startsWith('{')) continue;
      const w = psWait.shift();
      if (w) { clearTimeout(w.t); try { w.resolve(JSON.parse(line)); } catch (e) { w.resolve({ error: 'bad json' }); } }
    }
  });
  ps.stderr.on('data', () => {});
  const dead = () => { ps = null; psBuf = ''; for (const w of psWait.splice(0)) { clearTimeout(w.t); w.resolve({ error: 'PowerShell завершился' }); } };
  ps.on('exit', dead); ps.on('error', dead);
}
function psRequest(tag, file) {
  return new Promise((resolve) => {
    try {
      if (!ps) startPs();
      const w = { resolve, t: setTimeout(() => {
        const i = psWait.indexOf(w); if (i >= 0) psWait.splice(i, 1);
        try { ps.kill(); } catch (e) {}
        resolve({ error: 'таймаут Windows OCR' });
      }, 25000) };
      psWait.push(w);
      ps.stdin.write(`${tag}|${file}\n`);
    } catch (e) { resolve({ error: String(e.message || e) }); }
  });
}

// Возвращает { lines: [{text,x,y,w,h}] в пикселях OCR-картинки, k: пикселей на CSS-пиксель, engine } или null
async function ocrFrame(d, b, sf) {
  stat.err = '';
  if (process.platform === 'darwin') {
    if (!useHelper()) { stat.err = 'Нет помощника распознавания (Apple Vision) в сборке'; return null; }
    const shot = await helperShot(d, b, sf);
    if (!shot) { stat.err = helperErr || 'Снимок экрана не получен'; return null; }
    const r = await helperOcr(path.join(os.tmpdir(), `st-${process.pid}-${sf > 0.5 ? 'f' : 's'}.png`));
    if (r && r.lines) return { lines: r.lines, k: sf, engine: 'Apple Vision' };
    stat.err = helperErr || 'Vision: нет ответа';
    return null;
  }
  if (!useWinOcr()) { stat.err = 'Нет файла Windows OCR в сборке'; return null; }
  const img = await grab(d, b, sf);
  if (!img) return null;
  const cssW = img.getSize().width / sf;
  const up = sf >= 2 ? 1 : 2; // Windows OCR лучше читает крупный текст
  const big = up > 1 ? img.resize({ width: Math.round(img.getSize().width * up), quality: 'best' }) : img;
  const file = path.join(os.tmpdir(), `st-ocr-${process.pid}.png`);
  fs.writeFileSync(file, big.toPNG());
  const tag = S.src === 'auto' ? 'auto' : WINOCR[S.src];
  const r = await psRequest(tag, file);
  if (r.lines) return { lines: r.lines, k: big.getSize().width / cssW, engine: 'Windows OCR' };
  const e = String(r.error || '');
  if (e.startsWith('no-ocr-language')) stat.err = `Нет языка OCR ${tag}: Параметры → Время и язык → Язык и регион → добавить язык → «Распознавание текста»`;
  else { stat.err = 'Windows OCR: ' + e; try { ps && ps.kill(); } catch (x) {} } // перезапустим PowerShell
  return null;
}

// Собираем строки в абзацы: подряд идущие строки одного размера и выравнивания переводятся вместе
function groupLines(lines, regionW) {
  const L = lines.map((l) => ({ text: String(l.text).replace(/\s+/g, ' ').trim(), x: l.x, y: l.y, w: l.w, h: l.h }))
    .filter((l) => l.text && l.h > 2).sort((a, b) => a.y - b.y || a.x - b.x);
  const used = new Array(L.length).fill(false), out = [];
  for (let i = 0; i < L.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    const grp = [L[i]];
    for (;;) {
      const last = grp[grp.length - 1];
      const wrapped = last.w >= 0.45 * regionW || last.text.length >= 40; // строка похожа на часть абзаца, а не на пункт меню
      let best = -1, bestGap = Infinity;
      if (wrapped) for (let j = i + 1; j < L.length; j++) {
        if (used[j]) continue;
        const c = L[j], gap = c.y - (last.y + last.h);
        if (gap > last.h * 0.6) { if (c.y > last.y + last.h * 3) break; continue; }
        if (gap < -last.h * 0.4) continue; // на той же высоте — другая колонка
        const hr = c.h / last.h;
        if (hr < 0.7 || hr > 1.4 || Math.abs(c.x - last.x) > last.h * 2) continue;
        if (gap < bestGap) { best = j; bestGap = gap; }
      }
      if (best < 0) break;
      used[best] = true; grp.push(L[best]);
    }
    const x = Math.min(...grp.map((g) => g.x)), y = Math.min(...grp.map((g) => g.y));
    const r = Math.max(...grp.map((g) => g.x + g.w)), bt = Math.max(...grp.map((g) => g.y + g.h));
    const text = grp.map((g) => g.text).reduce((a, t) => (/\p{L}-$/u.test(a) && /^\p{Ll}/u.test(t) ? a.slice(0, -1) + t : a + ' ' + t));
    out.push({ text, x, y, w: r - x, h: bt - y, lh: grp.reduce((s, g) => s + g.h, 0) / grp.length });
  }
  return out;
}
function clean(t) {
  return t.replace(/\s{2,}/g, ' ').replace(/^[^\p{L}\p{N}«"'(\[]+/u, '').replace(/[^\p{L}\p{N}.,!?:;»"')\]%…]+$/u, '').trim();
}
const letterRatio = (t) => (t.match(/\p{L}/gu) || []).length / Math.max(1, t.replace(/\s/g, '').length);

// ---------- перевод ----------
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
async function fetchT(url, opts = {}, ms = 10000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try { return await fetch(url, { ...opts, signal: c.signal }); } finally { clearTimeout(t); }
}
// не больше `limit` запросов одновременно (иначе Google отвечает 429)
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const run = async () => {
    while (i < items.length) {
      const k = i++;
      try { out[k] = { status: 'fulfilled', value: await fn(items[k]) }; } catch (e) { out[k] = { status: 'rejected', reason: e }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return out;
}
async function google(text) {
  const sl = S.src === 'auto' ? 'auto' : (S.src === 'zh' ? 'zh-CN' : S.src);
  const tl = S.tgt === 'zh' ? 'zh-CN' : S.tgt;
  let lastErr = new Error('Google: нет ответа');
  for (const host of ['translate.googleapis.com', 'translate.google.com']) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetchT(`https://${host}/translate_a/single?client=gtx&sl=${sl}&tl=${tl}&dt=t&q=${encodeURIComponent(text)}`, { headers: { 'User-Agent': UA } });
        if (r.ok) { const j = await r.json(); return j[0].map((x) => x[0]).filter(Boolean).join(''); }
        lastErr = new Error('Google: HTTP ' + r.status);
        if (r.status === 429) await sleep(800 * (attempt + 1)); else break;
      } catch (e) {
        lastErr = new Error(e.name === 'AbortError' ? 'Google: нет ответа (10 с)' : 'Google: ' + ((e.cause && e.cause.code) || e.message));
        break;
      }
    }
  }
  throw lastErr;
}

// ---- Локальная нейросеть для перевода: TranslateGemma через Ollama (работает на видеокарте) ----
const OLLAMA = 'http://127.0.0.1:11434';
const LNAME = { en: ['English', 'en'], ru: ['Russian', 'ru'], de: ['German', 'de'], fr: ['French', 'fr'], es: ['Spanish', 'es'], zh: ['Chinese', 'zh-Hans'], ja: ['Japanese', 'ja'] };
let llmReady = '', pullCtl = null;
async function pullModel() {
  pullCtl = new AbortController();
  const r = await fetch(OLLAMA + '/api/pull', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: S.llmModel, name: S.llmModel, stream: true }), signal: pullCtl.signal,
  });
  if (!r.ok || !r.body) throw new Error('Ollama: не удалось начать загрузку модели');
  const reader = r.body.getReader(), dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      const m = JSON.parse(line);
      if (m.error) throw new Error('Ollama: ' + m.error);
      if (m.total) send('progress', { text: `Загрузка ${S.llmModel}: ${mb(m.completed || 0)} / ${mb(m.total)} МБ`, pct: (m.completed || 0) / m.total });
      else send('progress', { text: `Ollama: ${m.status}`, pct: null });
    }
  }
  send('progress', null);
}
// ---- Ollama встроена: если её нет, приложение само скачает, распакует и запустит её ----
const OLLAMA_URL = process.platform === 'darwin'
  ? 'https://github.com/ollama/ollama/releases/latest/download/ollama-darwin.tgz'
  : `https://github.com/ollama/ollama/releases/latest/download/ollama-windows-${process.arch === 'arm64' ? 'arm64' : 'amd64'}.zip`;
const OLLAMA_EXE = process.platform === 'win32' ? 'ollama.exe' : 'ollama';
const ollamaDir = () => path.join(app.getPath('userData'), 'ollama');
let ollamaProc = null, dlCtl = null, userAbort = false;

function findFile(dir, name, depth = 3) {
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isFile() && e.name === name) return p;
      if (e.isDirectory() && depth > 0) { const f = findFile(p, name, depth - 1); if (f) return f; }
    }
  } catch (e) {}
  return null;
}
function ollamaBin() {
  const own = findFile(ollamaDir(), OLLAMA_EXE);
  if (own) return own;
  const cands = [];
  if (process.platform === 'win32') cands.push(path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama.exe'));
  if (process.platform === 'darwin') cands.push('/Applications/Ollama.app/Contents/Resources/ollama');
  return cands.find((p) => fs.existsSync(p)) || null;
}
const ollamaAlive = async () => { try { return (await fetchT(OLLAMA + '/api/tags', {}, 2500)).ok; } catch (e) { return false; } };
function abortDownloads() {
  userAbort = true;
  for (const c of [pullCtl, dlCtl]) if (c) c.abort();
  pullCtl = dlCtl = null;
}
function killOllama() {
  if (!ollamaProc) return;
  const p = ollamaProc; ollamaProc = null;
  try { if (process.platform === 'win32') spawn('taskkill', ['/pid', String(p.pid), '/T', '/F'], { windowsHide: true }); else p.kill(); } catch (e) {}
}

// Скачивание с докачкой (Range) и контролем зависания
async function downloadTo(url, dest, label) {
  const part = dest + '.part';
  let have = fs.existsSync(part) ? fs.statSync(part).size : 0;
  userAbort = false;
  dlCtl = new AbortController();
  let stall;
  const kick = () => { clearTimeout(stall); stall = setTimeout(() => dlCtl && dlCtl.abort(), 60000); };
  kick();
  try {
    const r = await fetch(url, { headers: have ? { Range: `bytes=${have}-` } : {}, signal: dlCtl.signal, redirect: 'follow' });
    if (r.status === 416) { fs.renameSync(part, dest); return; } // уже докачано
    if (!r.ok && r.status !== 206) throw new Error(`Загрузка Ollama: HTTP ${r.status}`);
    if (r.status === 200) have = 0; // сервер не поддержал докачку
    const total = have + Number(r.headers.get('content-length') || 0);
    const out = fs.createWriteStream(part, { flags: have ? 'a' : 'w' });
    const reader = r.body.getReader();
    let got = have, last = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        kick();
        if (!out.write(value)) await new Promise((res) => out.once('drain', res));
        got += value.length;
        if (Date.now() - last > 300) { last = Date.now(); send('progress', { text: `${label}: ${mb(got)} / ${mb(total)} МБ`, pct: total ? got / total : null }); }
      }
    } finally { await new Promise((res) => out.end(res)); }
    fs.renameSync(part, dest);
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(userAbort ? 'cancelled' : 'Нет данных 60 с — загрузка прервана, повторите (она докачается)');
    throw e;
  } finally { clearTimeout(stall); dlCtl = null; }
}
function extract(archive, dir) {
  return new Promise((resolve, reject) => {
    const args = process.platform === 'win32' ? ['-xf', archive, '-C', dir] : ['-xzf', archive, '-C', dir];
    execFile('tar', args, { timeout: 900000 }, (err) => (err ? reject(new Error('Не удалось распаковать Ollama: ' + err.message)) : resolve()));
  });
}

async function ensureOllama() {
  if (await ollamaAlive()) return; // уже запущена (своя или установленная)
  let bin = ollamaBin();
  if (!bin) {
    if (!S.llmConsent) {
      const big = S.llmModel.endsWith('12b') ? '8,1' : '3,3';
      const r = await dialog.showMessageBox({
        type: 'question', buttons: ['Скачать', 'Отмена'], defaultId: 0, cancelId: 1, title: 'Локальный AI-перевод',
        message: `Для режима AI нужно скачать Ollama (${process.platform === 'win32' ? '≈1,4 ГБ' : '≈150 МБ'}) и модель ${S.llmModel} (≈${big} ГБ).`,
        detail: 'Скачивание однократное, потом перевод работает без интернета. Ollama хранится в папке приложения и запускается автоматически. Загрузку можно прервать — она продолжится с того же места.',
      });
      if (r.response !== 0) throw new Error('AI: загрузка отменена (кнопка G — вернуться к Google)');
      S.llmConsent = true; save();
    }
    fs.mkdirSync(ollamaDir(), { recursive: true });
    const archive = path.join(ollamaDir(), path.basename(OLLAMA_URL));
    await downloadTo(OLLAMA_URL, archive, 'Загрузка Ollama');
    send('progress', { text: 'Распаковка Ollama…', pct: null });
    await extract(archive, ollamaDir());
    try { fs.unlinkSync(archive); } catch (e) {}
    bin = findFile(ollamaDir(), OLLAMA_EXE);
    if (!bin) throw new Error('В архиве Ollama не найден ' + OLLAMA_EXE);
    if (process.platform !== 'win32') fs.chmodSync(bin, 0o755);
  }
  send('progress', { text: 'Запускаю Ollama…', pct: null });
  ollamaProc = spawn(bin, ['serve'], { env: { ...process.env, OLLAMA_HOST: '127.0.0.1:11434', OLLAMA_KEEP_ALIVE: '30m' }, windowsHide: true, stdio: 'ignore' });
  ollamaProc.on('exit', () => { ollamaProc = null; });
  ollamaProc.on('error', () => { ollamaProc = null; });
  for (let t0 = Date.now(); Date.now() - t0 < 45000; await sleep(700)) if (await ollamaAlive()) { send('progress', null); return; }
  throw new Error('Ollama не запустилась (проверьте драйвер видеокарты)');
}

async function ensureLlm() {
  if (llmReady === S.llmModel) return;
  await ensureOllama();
  let tags;
  try { tags = await (await fetchT(OLLAMA + '/api/tags', {}, 4000)).json(); }
  catch (e) { throw new Error('Ollama не отвечает'); }
  if (!(tags.models || []).some((m) => m.name === S.llmModel || m.model === S.llmModel)) {
    try { await pullModel(); } catch (e) { if (e.name === 'AbortError') throw new Error('cancelled'); throw e; }
  }
  llmReady = S.llmModel;
}
async function llm(text) {
  await ensureLlm();
  const sCode = S.src === 'auto' ? (await detect(text)) || 'en' : S.src;
  if (sCode === S.tgt) return text;
  const [sn, sc] = LNAME[sCode], [tn, tc] = LNAME[S.tgt];
  const prompt = `You are a professional ${sn} (${sc}) to ${tn} (${tc}) translator. Your goal is to accurately convey the meaning and nuances of the original ${sn} text while adhering to ${tn} grammar, vocabulary, and cultural sensitivities.\nProduce only the ${tn} translation, without any additional explanations or commentary. Please translate the following ${sn} text into ${tn}:\n\n\n${text}`;
  const r = await fetchT(OLLAMA + '/api/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: S.llmModel, stream: false, keep_alive: '30m', options: { temperature: 0 }, messages: [{ role: 'user', content: prompt }] }),
  }, 180000);
  const j = await r.json();
  if (j.error) throw new Error('Ollama: ' + j.error);
  return String((j.message && j.message.content) || '').trim();
}

const mb = (n) => (n / 1048576).toFixed(0);
async function detect(text) {
  const { franc } = await import('franc-min');
  return FRANC[franc(text, { minLength: 10 })] || null;
}
const cache = new Map();
async function translate(text) {
  const key = `${S.engine}|${S.llmModel}|${S.src}|${S.tgt}|${text}`;
  if (cache.has(key)) return cache.get(key);
  const out = S.engine === 'llm' ? await llm(text) : await google(text);
  if (cache.size > 500) cache.clear();
  cache.set(key, out);
  return out;
}

// ---------- захват экрана ----------
async function grab(d, b, scale, noHide) {
  if (useHelper()) {
    const img = await helperShot(d, b, scale);
    if (img) { helperFails = 0; return img; }
    if (++helperFails >= 3) { helperBroken = true; S.capturesSelf = true; }
  }
  const hide = !noHide && hideMode() && lastItems > 0;
  if (hide) { send('hide', true); await sleep(140); }
  let srcs;
  try {
    srcs = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: Math.round(d.size.width * scale), height: Math.round(d.size.height * scale) },
    });
  } finally { if (hide) send('hide', false); }
  const s = srcs.find((x) => x.display_id === String(d.id)) || srcs[0];
  if (!s) return null;
  const fs_ = s.thumbnail.getSize();
  const r = {
    x: Math.max(0, Math.round((b.x - d.bounds.x + BORDER) * scale)),
    y: Math.max(0, Math.round((b.y - d.bounds.y + HEADER) * scale)),
    width: Math.round((b.width - 2 * BORDER) * scale),
    height: Math.round((b.height - HEADER - BORDER) * scale),
  };
  r.width = Math.min(r.width, fs_.width - r.x);
  r.height = Math.min(r.height, fs_.height - r.y);
  if (r.width < 10 || r.height < 10) return null;
  return s.thumbnail.crop(r);
}

// true, если была работа (для адаптивной частоты опроса)
async function cycle() {
  const g = gen;
  if (S.auto === false && !forceOnce) return false;
  const b = win.getBounds();
  const d = screen.getDisplayMatching(b), sf = d.scaleFactor;
  const access = process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : 'granted';

  // 1) дешёвый снимок: изменилось ли что-то под окном
  const t0 = Date.now();
  const small = await grab(d, b, 0.33);
  stat.grab += Date.now() - t0; stat.polls++;
  if (!small) return false;
  const sig = Buffer.from(small.toBitmap());
  if (prev && !differs(prev, sig)) { lastSig = sig; return false; }
  // 2) ждём, пока картинка «устоится»; при постоянных изменениях (видео) — всё реже
  const moving = !forceOnce && lastSig && differs(lastSig, sig);
  lastSig = sig;
  if (moving) {
    movingSince = movingSince || Date.now();
    if (Date.now() - movingSince < moveWait) return true;
    moveWait = Math.min(moveWait * 2, 30000);
  } else moveWait = 4000;
  movingSince = 0;
  prev = sig;
  forceOnce = false;
  if (S.src === S.tgt) { send('result', []); lastItems = 0; lastTexts = []; return true; }

  // 3) распознавание
  const t1 = Date.now();
  send('status', 'Распознаю…');
  const o = await ocrFrame(d, b, sf);
  stat.ocr += Date.now() - t1; stat.runs++;
  if (!o) { send('status', (stat.err || 'Распознавание недоступно').slice(0, 120)); return true; }
  stat.engine = o.engine;
  if (g !== gen) return true;
  const paras = groupLines(o.lines, (b.width - 2 * BORDER) * o.k)
    .map((p) => ({ ...p, text: clean(p.text) }))
    .filter((p) => (p.text.match(/\p{L}/gu) || []).length >= 2 && letterRatio(p.text) > 0.5);

  // 4) перевод
  const t2 = Date.now();
  send('status', 'Перевожу…');
  const texts = paras.map((p) => p.text);
  const res = [];
  if (S.engine === 'google') res.push(...(await mapLimit(texts, 2, translate)));
  else for (const t of texts) {
    if (g !== gen) break;
    try { res.push({ status: 'fulfilled', value: await translate(t) }); } catch (e) { res.push({ status: 'rejected', reason: e }); }
  }
  stat.tr += Date.now() - t2;
  if (g !== gen) return true;
  const fail = res.find((x) => x.status === 'rejected');
  const items = [];
  paras.forEach((p, i) => {
    if (res[i].status !== 'fulfilled' || !res[i].value) return;
    items.push({ x: p.x / o.k, y: p.y / o.k, w: p.w / o.k, h: p.h / o.k, lh: p.lh / o.k, text: res[i].value });
  });
  send('result', items);
  lastItems = items.length;
  lastTexts = items.map((x) => x.text);
  let msg = fail && fail.reason.message !== 'cancelled' ? (String(fail.reason.message || fail.reason) + (S.engine === 'google' ? ' → кнопка AI' : '')).slice(0, 90) : '';
  if (!msg && !items.length && access !== 'granted') msg = `Текста нет. Если он есть — проверьте запись экрана (статус: ${access})`;
  send('status', msg);
  return true;
}

async function tick() {
  let worked = false;
  if (!paused && !busy && !start && win && !win.isDestroyed() && win.isVisible()) {
    busy = true;
    try { worked = await cycle(); } catch (e) { prev = null; if (e.message !== 'cancelled') send('status', String(e.message || e).slice(0, 80)); }
    busy = false;
  }
  idle = worked ? 0 : idle + 1;
  const base = hideMode() ? (lastItems > 0 ? 3000 : 1200) : 800;
  setTimeout(tick, paused || idle > 8 ? base * 2 : base);
}

if (!app.requestSingleInstanceLock()) app.quit();
load();
if (S.engine === 'offline') S.engine = 'google'; // офлайн-движок удалён
if (process.platform === 'darwin' && S.legacyCapture) app.commandLine.appendSwitch('disable-features', 'ScreenCaptureKitMac');
app.whenReady().then(() => {
  createWindow();
  buildTray();
  globalShortcut.register('CommandOrControl+Shift+T', () => setPaused(!paused));
  globalShortcut.register('CommandOrControl+Shift+H', toggleVisible);
  globalShortcut.register('CommandOrControl+Shift+Y', force);
  globalShortcut.register('CommandOrControl+Alt+C', copyAll);
});
app.on('before-quit', () => { save(); killOllama(); try { ps && ps.kill(); } catch (e) {} });
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
