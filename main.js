const { app, BrowserWindow, ipcMain, desktopCapturer, screen, globalShortcut, Tray, Menu, nativeImage,
        systemPreferences, utilityProcess, shell, dialog, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile, spawn } = require('child_process');
try { os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch (e) {}

const HEADER = 44, BORDER = 14; // должны совпадать с index.html
const TESS = { en: 'eng', ru: 'rus', de: 'deu', fr: 'fra', es: 'spa', zh: 'chi_sim', ja: 'jpn' };
const AUTO_TESS = ['eng', 'rus'];
const VISION = { en: 'en-US', ru: 'ru-RU', de: 'de-DE', fr: 'fr-FR', es: 'es-ES', zh: 'zh-Hans', ja: 'ja-JP' };
const WINOCR = { en: 'en-US', ru: 'ru-RU', de: 'de-DE', fr: 'fr-FR', es: 'es-ES', zh: 'zh-Hans-CN', ja: 'ja-JP' };
const FRANC = { eng: 'en', rus: 'ru', deu: 'de', fra: 'fr', spa: 'es', cmn: 'zh', jpn: 'ja' };
const S = { auto: true, engine: 'google', src: 'en', tgt: 'ru', offlineModel: 'opus', legacyCapture: false, bounds: null };
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
let ps = null, psBuf = '', psWait = [], psBroken = false, psFails = 0;
const useWinOcr = () => process.platform === 'win32' && !psBroken && !!psScript();

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
function setModel(m) { S.offlineModel = m; save(); gen++; cancelPending(); prev = null; send('progress', null); send('status', ''); refreshMenu(); }
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
      `Режим: ${S.auto === false ? 'по горячей клавише' : 'авто'}, движок: ${S.engine}, язык: ${S.src} → ${S.tgt}, модель: ${S.offlineModel}`,
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
    { label: 'Офлайн-модель', submenu: [
      { label: 'Быстрая (Opus-MT, ~150 МБ на пару)', type: 'radio', checked: S.offlineModel !== 'nllb', click: () => setModel('opus') },
      { label: 'Точнее (NLLB, ~600 МБ, медленнее)', type: 'radio', checked: S.offlineModel === 'nllb', click: () => setModel('nllb') },
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
ipcMain.on('set', (_, s) => { Object.assign(S, s); prev = null; save(); gen++; cancelPending(); send('progress', null); send('status', ''); });
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
// 1) macOS: Apple Vision через помощник
function helperScan(d, b, sf) {
  const w = b.width - 2 * BORDER, h = b.height - HEADER - BORDER;
  const langs = S.src === 'auto' ? '' : VISION[S.src];
  const args = ['scan', d.id, b.x - d.bounds.x + BORDER, b.y - d.bounds.y + HEADER, w, h,
    Math.round(w * sf), Math.round(h * sf), process.pid, langs].map(String);
  return new Promise((resolve) => execFile(helperPath, args, { timeout: 20000, maxBuffer: 16 << 20 }, (err, stdout, stderr) => {
    if (err) { helperErr = String(stderr || err.message).trim().slice(0, 100); return resolve(null); }
    try { resolve(JSON.parse(stdout)); } catch (e) { helperErr = 'bad json'; resolve(null); }
  }));
}
function helperShot(d, b, scale) {
  const out = path.join(os.tmpdir(), `st-${process.pid}-${scale > 0.5 ? 'f' : 's'}.png`);
  const w = b.width - 2 * BORDER, h = b.height - HEADER - BORDER;
  const args = ['shot', d.id, b.x - d.bounds.x + BORDER, b.y - d.bounds.y + HEADER, w, h,
    Math.max(8, Math.round(w * scale)), Math.max(8, Math.round(h * scale)), process.pid, out].map(String);
  return new Promise((resolve) => execFile(helperPath, args, { timeout: 8000 }, (err) => {
    if (err) return resolve(null);
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

// 3) запасной вариант: Tesseract
let worker = null, workerLang = '';
async function getWorker() {
  const langs = S.src === 'auto' ? AUTO_TESS : [...new Set([TESS[S.src], 'eng'])];
  const key = langs.join('+');
  if (worker && workerLang === key) return worker;
  if (worker) await worker.terminate();
  send('progress', { text: 'Загрузка языка OCR…', pct: null });
  const { createWorker } = require('tesseract.js');
  const make = createWorker(langs, 1, {
    cachePath: app.getPath('userData'),
    logger: (m) => {
      if (String(m.status).startsWith('loading') && typeof m.progress === 'number')
        send('progress', { text: `Загрузка языка OCR: ${Math.round(m.progress * 100)}%`, pct: m.progress });
    },
  });
  let timer;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('Не удалось скачать языковой пакет OCR — проверьте интернет')), 90000); });
  try { worker = await Promise.race([make, timeout]); } finally { clearTimeout(timer); }
  send('progress', null);
  workerLang = key;
  return worker;
}
// светлый текст на тёмном фоне Tesseract читает хуже -> инвертируем тёмные кадры
function prepare(img) {
  const { width, height } = img.getSize();
  const buf = Buffer.from(img.toBitmap());
  let sum = 0, n = 0;
  for (let i = 0; i < buf.length; i += 64) { sum += (buf[i] + buf[i + 1] + buf[i + 2]) / 3; n++; }
  if (n && sum / n < 110) for (let i = 0; i < buf.length; i += 4) { buf[i] = 255 - buf[i]; buf[i + 1] = 255 - buf[i + 1]; buf[i + 2] = 255 - buf[i + 2]; }
  return nativeImage.createFromBitmap(buf, { width, height });
}

// Возвращает { lines: [{text,x,y,w,h}] в пикселях OCR-картинки, k: пикселей на CSS-пиксель, engine }
async function ocrFrame(d, b, sf) {
  if (useHelper()) {
    const r = await helperScan(d, b, sf);
    if (r && r.lines) return { lines: r.lines, k: sf, engine: 'Apple Vision' };
    stat.err = 'Vision: ' + (helperErr || 'нет ответа');
  }
  const img = await grab(d, b, sf);
  if (!img) return null;
  const cssW = img.getSize().width / sf;
  if (useWinOcr()) {
    const up = sf >= 2 ? 1 : 2; // Windows OCR лучше читает крупный текст
    const big = up > 1 ? img.resize({ width: Math.round(img.getSize().width * up), quality: 'best' }) : img;
    const file = path.join(os.tmpdir(), `st-ocr-${process.pid}.png`);
    fs.writeFileSync(file, big.toPNG());
    const r = await psRequest(S.src === 'auto' ? 'auto' : WINOCR[S.src], file);
    if (r.lines) { psFails = 0; return { lines: r.lines, k: big.getSize().width / cssW, engine: 'Windows OCR' }; }
    stat.err = 'Windows OCR: ' + r.error;
    if (!String(r.error).startsWith('no-ocr-language') && ++psFails >= 3) psBroken = true;
  }
  const up = sf >= 2 ? 1 : 1.5;
  const ocrImg = prepare(up > 1 ? img.resize({ width: Math.round(img.getSize().width * up), quality: 'best' }) : img);
  const w = await getWorker();
  send('status', 'Распознаю (Tesseract)…');
  const { data } = await w.recognize(ocrImg.toPNG(), {}, { blocks: true });
  const raw = data.lines || (data.blocks || []).flatMap((x) => (x.paragraphs || []).flatMap((p) => p.lines || []));
  const lines = raw.filter((l) => l.confidence > 50).map((l) => ({ text: l.text, x: l.bbox.x0, y: l.bbox.y0, w: l.bbox.x1 - l.bbox.x0, h: l.bbox.y1 - l.bbox.y0 }));
  return { lines, k: ocrImg.getSize().width / cssW, engine: 'Tesseract (запасной)' };
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
async function google(text, retry = true) {
  const sl = S.src === 'auto' ? 'auto' : (S.src === 'zh' ? 'zh-CN' : S.src);
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sl}&tl=${S.tgt === 'zh' ? 'zh-CN' : S.tgt}&dt=t&q=${encodeURIComponent(text)}`;
  const r = await fetch(url);
  if (!r.ok) {
    if (retry) { await sleep(600); return google(text, false); }
    throw new Error('Google: HTTP ' + r.status);
  }
  const j = await r.json();
  return j[0].map((x) => x[0]).join('');
}

// Офлайн-модель живёт в отдельном процессе (translator.js)
const HOSTS = ['https://huggingface.co/', 'https://hf-mirror.com/'];
let hostIdx = 0, child = null, seq = 0;
const pending = new Map();
const mb = (n) => (n / 1048576).toFixed(0);
function killChild() { if (child) { const c = child; child = null; c.kill(); } }
function cancelPending() {
  for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('cancelled')); }
  pending.clear();
}
function ensureChild() {
  if (child) return child;
  const c = child = utilityProcess.fork(path.join(__dirname, 'translator.js'));
  c.on('message', (m) => {
    if (m.type) {
      for (const p of pending.values()) p.arm();
      if (S.engine !== 'offline') return;
      if (m.type === 'progress') send('progress', { text: `Загрузка модели ${m.key}: ${mb(m.loaded)} / ${mb(m.total)} МБ`, pct: m.loaded / m.total });
      else if (m.type === 'loading') send('progress', { text: `Загрузка модели ${m.key}…`, pct: null });
      else if (m.type === 'ready') send('progress', null);
      return;
    }
    const p = pending.get(m.id);
    if (!p) return;
    clearTimeout(p.timer); pending.delete(m.id);
    if (m.ok) p.resolve(m.value); else p.reject(new Error(m.error));
  });
  c.on('exit', () => {
    if (child === c) child = null;
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('Процесс перевода завершился')); }
    pending.clear();
  });
  return c;
}
function callWorker(text, s, t) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const p = { resolve, reject, timer: null };
    p.arm = () => {
      clearTimeout(p.timer);
      p.timer = setTimeout(() => {
        pending.delete(id); killChild();
        reject(new Error(`Нет ответа от ${new URL(HOSTS[hostIdx]).host} (60 с)`));
      }, 60000);
    };
    pending.set(id, p); p.arm();
    ensureChild().postMessage({ id, text, s, t, model: S.offlineModel, host: HOSTS[hostIdx], cacheDir: path.join(app.getPath('userData'), 'models') });
  });
}
async function step(text, s, t) {
  for (let attempt = 0; ; attempt++) {
    try { return await callWorker(text, s, t); }
    catch (e) {
      if (e.message === 'cancelled') throw e;
      if (attempt === 0) {
        hostIdx = (hostIdx + 1) % HOSTS.length;
        send('progress', { text: `Не вышло, пробую ${new URL(HOSTS[hostIdx]).host}…`, pct: null });
        continue;
      }
      hostIdx = 0; throw e;
    }
  }
}
async function detect(text) {
  const { franc } = await import('franc-min');
  return FRANC[franc(text, { minLength: 10 })] || null;
}
async function offline(text) {
  const t = S.tgt;
  const s = S.src === 'auto' ? (await detect(text)) || 'en' : S.src;
  if (s === t) return text;
  if (S.offlineModel === 'nllb' || s === 'en' || t === 'en') return step(text, s, t);
  return step(await step(text, s, 'en'), 'en', t);
}
const cache = new Map();
async function translate(text) {
  const key = `${S.engine}|${S.offlineModel}|${S.src}|${S.tgt}|${text}`;
  if (cache.has(key)) return cache.get(key);
  const out = S.engine === 'google' ? await google(text) : await offline(text);
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
  if (!o) return true;
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
  if (S.engine === 'google') res.push(...(await Promise.allSettled(texts.map(translate))));
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
  let msg = fail && fail.reason.message !== 'cancelled' ? String(fail.reason.message || fail.reason).slice(0, 80) : '';
  if (!msg && o.engine.startsWith('Tesseract') && stat.err) msg = stat.err.slice(0, 80);
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
if (process.platform === 'darwin' && S.legacyCapture) app.commandLine.appendSwitch('disable-features', 'ScreenCaptureKitMac');
app.whenReady().then(() => {
  createWindow();
  buildTray();
  globalShortcut.register('CommandOrControl+Shift+T', () => setPaused(!paused));
  globalShortcut.register('CommandOrControl+Shift+H', toggleVisible);
  globalShortcut.register('CommandOrControl+Shift+Y', force);
  globalShortcut.register('CommandOrControl+Alt+C', copyAll);
});
app.on('before-quit', () => { save(); killChild(); try { ps && ps.kill(); } catch (e) {} });
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
