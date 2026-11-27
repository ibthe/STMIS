const { app, BrowserWindow, ipcMain, desktopCapturer, screen, globalShortcut, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { systemPreferences, utilityProcess, shell } = require('electron');

const HEADER = 44, BORDER = 14; // должны совпадать с index.html
const OCR = { en: 'eng', ru: 'rus', de: 'deu', fr: 'fra', es: 'spa', zh: 'chi_sim', ja: 'jpn' };
const AUTO_OCR = ['eng', 'rus', 'deu', 'fra', 'spa'];
const FRANC = { eng: 'en', rus: 'ru', deu: 'de', fra: 'fr', spa: 'es', cmn: 'zh', jpn: 'ja' };
const S = { engine: 'google', src: 'en', tgt: 'ru', bounds: null };
let win, tray, paused = false, busy = false, prev = null, start = null, lastItems = 0, askedPerm = false, gen = 0;
// macOS 15+ (Darwin 24+): ScreenCaptureKit игнорирует скрытие окна от захвата -> прячем перевод на момент снимка
const hideMode = () => process.platform === 'darwin' && parseInt(os.release(), 10) >= 24 && !S.legacyCapture;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const send = (ch, d) => win && !win.isDestroyed() && win.webContents.send(ch, d);

// ---------- настройки ----------
const SF = () => path.join(app.getPath('userData'), 'settings.json');
function load() { try { Object.assign(S, JSON.parse(fs.readFileSync(SF(), 'utf8'))); } catch {} }
function save() { try { if (win) S.bounds = win.getBounds(); fs.writeFileSync(SF(), JSON.stringify(S)); } catch {} }

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
  win.webContents.once('did-finish-load', () => {
    send('init', { engine: S.engine, src: S.src, tgt: S.tgt, paused });
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

function buildTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'tray.png')).resize({ width: 18, height: 18 });
  tray = new Tray(icon);
  tray.setToolTip('Screen Translator');
  tray.on('click', toggleVisible);
  refreshMenu();
}
function refreshMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: win.isVisible() ? 'Скрыть окно' : 'Показать окно', click: toggleVisible },
    { label: paused ? 'Продолжить перевод' : 'Пауза', click: () => setPaused(!paused) },
    ...(process.platform === 'darwin' ? [{
      label: 'Настройки записи экрана…',
      click: () => shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'),
    }, {
      label: 'Совместимый захват экрана (перезапуск)', type: 'checkbox', checked: !!S.legacyCapture,
      click: () => { S.legacyCapture = !S.legacyCapture; save(); app.relaunch(); app.exit(0); },
    }] : []),
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

function differs(a, b) {
  if (a.length !== b.length) return true;
  let d = 0;
  for (let i = 0; i < a.length; i += 4) d += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
  return d / (a.length / 4) > 6;
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

// ---------- перевод ----------
async function google(text) {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${S.tgt}&dt=t&q=${encodeURIComponent(text)}`;
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
      for (const p of pending.values()) p.arm(); // есть признаки жизни — сбрасываем таймер зависания
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
    ensureChild().postMessage({ id, text, s, t, host: HOSTS[hostIdx], cacheDir: path.join(app.getPath('userData'), 'models') });
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
  if (s === 'en' || t === 'en') return step(text, s, t);
  return step(await step(text, s, 'en'), 'en', t); // через английский
}

const cache = new Map();
async function translate(text) {
  const key = `${S.engine}|${S.src}|${S.tgt}|${text}`;
  if (cache.has(key)) return cache.get(key);
  const out = S.engine === 'google' ? await google(text) : await offline(text);
  if (cache.size > 500) cache.clear();
  cache.set(key, out);
  return out;
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

// ---------- основной цикл ----------
async function cycle() {
  const g = gen;
  const b = win.getBounds();
  const d = screen.getDisplayMatching(b), sf = d.scaleFactor;
  const access = process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : 'granted';
  const hide = hideMode() && lastItems > 0;
  if (hide) { send('hide', true); await sleep(90); }
  let srcs;
  try {
    srcs = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: Math.round(d.size.width * sf), height: Math.round(d.size.height * sf) },
    });
  } finally { if (hide) send('hide', false); }
  const s = srcs.find((x) => x.display_id === String(d.id)) || srcs[0];
  if (!s) return;
  const full = s.thumbnail, fs_ = full.getSize();
  const r = {
    x: Math.max(0, Math.round((b.x - d.bounds.x + BORDER) * sf)),
    y: Math.max(0, Math.round((b.y - d.bounds.y + HEADER) * sf)),
    width: Math.round((b.width - 2 * BORDER) * sf),
    height: Math.round((b.height - HEADER - BORDER) * sf),
  };
  r.width = Math.min(r.width, fs_.width - r.x);
  r.height = Math.min(r.height, fs_.height - r.y);
  if (r.width < 20 || r.height < 20) return;

  const img = full.crop(r);
  const sig = img.resize({ width: 64 }).toBitmap();
  if (prev && !differs(prev, sig)) return;
  prev = sig;
  if (S.src === S.tgt) return send('result', []);

  // мелкий текст распознаётся заметно лучше после увеличения
  const ocrImg = prepare(sf < 2 ? img.resize({ width: r.width * 2, quality: 'best' }) : img);
  const k = ocrImg.getSize().width / (b.width - 2 * BORDER); // px картинки -> CSS-px

  const w = await getWorker();
  send('status', 'Распознаю…');
  const { data } = await w.recognize(ocrImg.toPNG(), {}, { blocks: true });
  const paras = (data.paragraphs || (data.blocks || []).flatMap((x) => x.paragraphs || []))
    .filter((p) => p.confidence > 50 && (p.text.match(/\p{L}/gu) || []).length >= 2);

  if (g !== gen) return;
  send('status', 'Перевожу…');
  const texts = paras.map((p) => p.text.replace(/\s*\n\s*/g, ' ').trim());
  const res = [];
  if (S.engine === 'google') res.push(...(await Promise.allSettled(texts.map(translate))));
  else for (const t of texts) {
    if (g !== gen) break;
    try { res.push({ status: 'fulfilled', value: await translate(t) }); } catch (e) { res.push({ status: 'rejected', reason: e }); }
  }
  if (g !== gen) return;
  const fail = res.find((x) => x.status === 'rejected');
  const items = [];
  paras.forEach((p, i) => {
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
}

async function tick() {
  if (!paused && !busy && !start && win && !win.isDestroyed() && win.isVisible()) {
    busy = true;
    try { await cycle(); } catch (e) { prev = null; if (e.message !== 'cancelled') send('status', String(e.message || e).slice(0, 80)); }
    busy = false;
  }
  setTimeout(tick, hideMode() ? 1100 : 700);
}

if (!app.requestSingleInstanceLock()) app.quit();
load();
if (process.platform === 'darwin' && S.legacyCapture) app.commandLine.appendSwitch('disable-features', 'ScreenCaptureKitMac');
app.whenReady().then(() => {
  createWindow();
  buildTray();
  globalShortcut.register('CommandOrControl+Shift+T', () => setPaused(!paused));
  globalShortcut.register('CommandOrControl+Shift+H', toggleVisible);
});
app.on('before-quit', () => { save(); killChild(); });
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
