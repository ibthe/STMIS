const { app, BrowserWindow, ipcMain, desktopCapturer, screen, globalShortcut, Tray, Menu, nativeImage,
        systemPreferences, utilityProcess, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
try { os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch (e) {} // не мешаем остальным программам

const HEADER = 44, BORDER = 14; // должны совпадать с index.html
const OCR = { en: 'eng', ru: 'rus', de: 'deu', fr: 'fra', es: 'spa', zh: 'chi_sim', ja: 'jpn' };
const AUTO_OCR = ['eng', 'rus']; // «Авто» читает только англ.+рус. (быстро); для других языков выберите язык вручную
const FRANC = { eng: 'en', rus: 'ru', deu: 'de', fra: 'fr', spa: 'es', cmn: 'zh', jpn: 'ja' };
const S = { auto: true, engine: 'google', src: 'en', tgt: 'ru', offlineModel: 'opus', legacyCapture: false, bounds: null };
let win, tray, paused = false, busy = false, prev = null, lastSig = null, movingSince = 0, idle = 0;
let start = null, lastItems = 0, gen = 0;
let forceOnce = false, moveWait = 4000;
const stat = { grab: 0, ocr: 0, tr: 0, runs: 0, polls: 0 };
const send = (ch, d) => win && !win.isDestroyed() && win.webContents.send(ch, d);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// macOS 15+: ScreenCaptureKit игнорирует скрытие окна от захвата -> прячем перевод на момент снимка
// Определяется самотестом при запуске (selfTest): видит ли захват экрана само окно приложения
const hideMode = () => S.capturesSelf !== undefined
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
  win.setContentProtection(true); // окно не попадает в собственный захват экрана
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
function toggleVisible() {
  if (win.isVisible()) win.hide(); else win.showInactive();
  prev = null; refreshMenu();
}
function setModel(m) {
  S.offlineModel = m; save(); gen++; cancelPending(); prev = null;
  send('progress', null); send('status', ''); refreshMenu();
}

function setAuto(v) { S.auto = v; save(); prev = null; refreshMenu(); }
function force() { forceOnce = true; prev = null; }

// Самотест: окно на миг заливается пурпуром; если пурпур виден на снимке, окно попадает в захват
// и перевод нужно прятать на время каждого снимка (иначе приложение читает собственный перевод).
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
      `Окно попадает в захват: ${S.capturesSelf === undefined ? 'не проверено' : S.capturesSelf ? 'да (перевод прячется на момент снимка)' : 'нет'}`,
      `Режим: ${S.auto === false ? 'по горячей клавише' : 'авто'}, движок: ${S.engine}, язык: ${S.src} → ${S.tgt}, модель: ${S.offlineModel}`,
      `Проверок экрана: ${stat.polls}, среднее ${Math.round(stat.grab / n)} мс`,
      `Распознаваний: ${stat.runs}, OCR в среднем ${Math.round(stat.ocr / r)} мс, перевод ${Math.round(stat.tr / r)} мс`,
      `Нагрузка процессов за последние секунды:`, cpu,
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
let worker = null, workerLang = '';
async function getWorker() {
  const langs = S.src === 'auto' ? AUTO_OCR : [...new Set([OCR[S.src], 'eng'])];
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

// чистим типичный мусор OCR: переносы, лишние пробелы, символы по краям
function clean(t) {
  return t.replace(/(\p{L})-\s*\n\s*(\p{Ll})/gu, '$1$2').replace(/\s*\n\s*/g, ' ').replace(/\s{2,}/g, ' ')
    .replace(/^[^\p{L}\p{N}«"'(\[]+/u, '').replace(/[^\p{L}\p{N}.,!?:;»"')\]%…]+$/u, '').trim();
}
const letterRatio = (t) => (t.match(/\p{L}/gu) || []).length / Math.max(1, t.replace(/\s/g, '').length);

// светлый текст на тёмном фоне Tesseract читает хуже -> инвертируем тёмные кадры
function prepare(img) {
  const { width, height } = img.getSize();
  const buf = Buffer.from(img.toBitmap());
  let sum = 0, n = 0;
  for (let i = 0; i < buf.length; i += 64) { sum += (buf[i] + buf[i + 1] + buf[i + 2]) / 3; n++; }
  if (n && sum / n < 110) for (let i = 0; i < buf.length; i += 4) { buf[i] = 255 - buf[i]; buf[i + 1] = 255 - buf[i + 1]; buf[i + 2] = 255 - buf[i + 2]; }
  return nativeImage.createFromBitmap(buf, { width, height });
}

// ---------- перевод ----------
async function google(text) {
  const sl = S.src === 'auto' ? 'auto' : (S.src === 'zh' ? 'zh-CN' : S.src);
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sl}&tl=${S.tgt === 'zh' ? 'zh-CN' : S.tgt}&dt=t&q=${encodeURIComponent(text)}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('Google: HTTP ' + r.status);
  const j = await r.json();
  return j[0].map((x) => x[0]).join('');
}

// Офлайн-модель живёт в отдельном процессе (translator.js), главный процесс не блокируется
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
      for (const p of pending.values()) p.arm(); // признаки жизни — сбрасываем таймер зависания
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
      if (attempt === 0) { // первая попытка не удалась — пробуем другой источник моделей
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
  return step(await step(text, s, 'en'), 'en', t); // Opus-MT: через английский
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
// scale — пикселей на DIP: маленький для дешёвой проверки «изменилось ли», родной (sf) для OCR
async function grab(d, b, scale, noHide) {
  const hide = !noHide && hideMode() && lastItems > 0;
  if (hide) { send('hide', true); await sleep(90); }
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

// возвращает true, если была работа (для адаптивной частоты опроса)
async function cycle() {
  const g = gen;
  if (S.auto === false && !forceOnce) return false; // ручной режим: между нажатиями нагрузки нет
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
  // 2) ждём, пока картинка «устоится»; если меняется постоянно (видео) — обрабатываем не чаще раза в 4 с
  const moving = !forceOnce && lastSig && differs(lastSig, sig);
  lastSig = sig;
  if (moving) {
    movingSince = movingSince || Date.now();
    if (Date.now() - movingSince < moveWait) return true;
    moveWait = Math.min(moveWait * 2, 30000); // всё ещё меняется — обрабатываем реже
  } else moveWait = 4000;
  movingSince = 0;
  prev = sig;
  forceOnce = false;
  if (S.src === S.tgt) { send('result', []); lastItems = 0; return true; }

  // 3) полный снимок + OCR + перевод
  const img = await grab(d, b, sf);
  if (!img) return true;
  const up = sf >= 2 ? 1 : 1.5; // мелкий текст читается лучше после увеличения
  const ocrImg = prepare(up > 1 ? img.resize({ width: Math.round(img.getSize().width * up), quality: 'best' }) : img);
  const k = ocrImg.getSize().width / (img.getSize().width / sf); // px картинки -> CSS-px

  const t1 = Date.now();
  const w = await getWorker();
  send('status', 'Распознаю…');
  const { data } = await w.recognize(ocrImg.toPNG(), {}, { blocks: true });
  const found = (data.paragraphs || (data.blocks || []).flatMap((x) => x.paragraphs || []))
    .map((p) => ({ p, text: clean(p.text) }))
    .filter(({ p, text }) => p.confidence > 50 && (text.match(/\p{L}/gu) || []).length >= 2 && letterRatio(text) > 0.5);
  stat.ocr += Date.now() - t1; stat.runs++;
  if (g !== gen) return true;

  const t2 = Date.now();
  send('status', 'Перевожу…');
  const texts = found.map((x) => x.text);
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
  found.forEach(({ p }, i) => {
    if (res[i].status !== 'fulfilled' || !res[i].value) return;
    items.push({
      x: p.bbox.x0 / k, y: p.bbox.y0 / k, w: (p.bbox.x1 - p.bbox.x0) / k, h: (p.bbox.y1 - p.bbox.y0) / k,
      lh: (p.bbox.y1 - p.bbox.y0) / k / Math.max(1, (p.lines || []).length || 1),
      text: res[i].value,
    });
  });
  send('result', items);
  lastItems = items.length;
  let msg = fail && fail.reason.message !== 'cancelled' ? String(fail.reason.message || fail.reason).slice(0, 80) : '';
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
  const base = hideMode() ? 1200 : 800;
  setTimeout(tick, paused || idle > 8 ? base * 2 : base); // чем дольше ничего не меняется, тем реже опрос
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
});
app.on('before-quit', () => { save(); killChild(); });
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
