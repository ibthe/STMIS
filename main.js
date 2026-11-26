const { app, BrowserWindow, ipcMain, desktopCapturer, screen } = require('electron');
const path = require('path');

const HEADER = 44, BORDER = 14; // должны совпадать с index.html
const OCR = { en: 'eng', ru: 'rus', de: 'deu', fr: 'fra', es: 'spa', zh: 'chi_sim', ja: 'jpn' };
const S = { engine: 'google', src: 'en', tgt: 'ru' };
let win, paused = false, busy = false, prev = null, start = null;
const send = (ch, d) => win && !win.isDestroyed() && win.webContents.send(ch, d);

function createWindow() {
  win = new BrowserWindow({
    width: 760, height: 260, minWidth: 360, minHeight: 140,
    transparent: true, frame: false, hasShadow: false, alwaysOnTop: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setContentProtection(true); // окно не попадает в собственный захват экрана
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile('index.html');
  win.webContents.once('did-finish-load', tick);
}

ipcMain.on('ignore', (_, v) => win.setIgnoreMouseEvents(v, { forward: true }));
ipcMain.on('drag', (_, m) => {
  if (m.phase === 'start') { start = win.getBounds(); return; }
  if (m.phase === 'end') { start = null; prev = null; return; }
  if (!start) return;
  if (m.mode === 'move') win.setBounds({ ...start, x: start.x + m.dx, y: start.y + m.dy });
  else win.setBounds({ ...start, width: Math.max(360, start.width + m.dx), height: Math.max(140, start.height + m.dy) });
});
ipcMain.on('set', (_, s) => { Object.assign(S, s); prev = null; });
ipcMain.on('pause', (_, p) => { paused = p; prev = null; });
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
  const langs = [...new Set([OCR[S.src], 'eng'])];
  const key = langs.join('+');
  if (worker && workerLang === key) return worker;
  if (worker) await worker.terminate();
  send('status', 'Загрузка языка OCR…');
  const { createWorker } = require('tesseract.js');
  worker = await createWorker(langs, 1, { cachePath: app.getPath('userData') });
  workerLang = key;
  return worker;
}

// ---------- Перевод ----------
async function google(text) {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${S.tgt}&dt=t&q=${encodeURIComponent(text)}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('Google: HTTP ' + r.status);
  const j = await r.json();
  return j[0].map((x) => x[0]).join('');
}

const pipes = new Map();
function getPipe(s, t) {
  const key = `${s}-${t}`;
  if (!pipes.has(key)) {
    send('status', `Загрузка модели ${key}…`);
    const p = import('@xenova/transformers').then(({ pipeline, env }) => {
      env.cacheDir = path.join(app.getPath('userData'), 'models');
      return pipeline('translation', `Xenova/opus-mt-${s}-${t}`);
    });
    p.catch(() => pipes.delete(key));
    pipes.set(key, p);
  }
  return pipes.get(key);
}
async function step(text, s, t) {
  const p = await getPipe(s, t);
  const out = await p(text, { max_new_tokens: 256 });
  return out[0].translation_text;
}
async function offline(text) {
  const { src: s, tgt: t } = S;
  if (s === 'en' || t === 'en') return step(text, s, t);
  return step(await step(text, s, 'en'), 'en', t); // через английский
}

// ---------- Основной цикл ----------
async function cycle() {
  const b = win.getBounds();
  const d = screen.getDisplayMatching(b), sf = d.scaleFactor;
  const srcs = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.round(d.size.width * sf), height: Math.round(d.size.height * sf) },
  });
  const s = srcs.find((x) => x.display_id === String(d.id)) || srcs[0];
  if (!s) return;
  const full = s.thumbnail, fs = full.getSize();
  const r = {
    x: Math.max(0, Math.round((b.x - d.bounds.x + BORDER) * sf)),
    y: Math.max(0, Math.round((b.y - d.bounds.y + HEADER) * sf)),
    width: Math.round((b.width - 2 * BORDER) * sf),
    height: Math.round((b.height - HEADER - BORDER) * sf),
  };
  r.width = Math.min(r.width, fs.width - r.x);
  r.height = Math.min(r.height, fs.height - r.y);
  if (r.width < 20 || r.height < 20) return;

  const img = full.crop(r);
  const sig = img.resize({ width: 64 }).toBitmap();
  if (prev && !differs(prev, sig)) return;
  prev = sig;
  if (S.src === S.tgt) return send('result', []);

  const w = await getWorker();
  send('status', 'Распознаю…');
  const { data } = await w.recognize(img.toPNG(), {}, { blocks: true });
  const paras = (data.paragraphs || (data.blocks || []).flatMap((x) => x.paragraphs || []))
    .filter((p) => p.confidence > 50 && p.text.trim().length > 1);

  send('status', 'Перевожу…');
  const k = r.width / (b.width - 2 * BORDER); // пиксели картинки -> CSS-пиксели
  const texts = paras.map((p) => p.text.replace(/\s*\n\s*/g, ' ').trim());
  let out;
  if (S.engine === 'google') out = await Promise.all(texts.map(google));
  else { out = []; for (const t of texts) out.push(await offline(t)); }

  send('result', paras.map((p, i) => ({
    x: p.bbox.x0 / k, y: p.bbox.y0 / k, w: (p.bbox.x1 - p.bbox.x0) / k, h: (p.bbox.y1 - p.bbox.y0) / k,
    lh: (p.bbox.y1 - p.bbox.y0) / k / Math.max(1, (p.lines || []).length || 1),
    text: out[i],
  })));
  send('status', '');
}

async function tick() {
  if (!paused && !busy && !start && win && !win.isDestroyed()) {
    busy = true;
    try { await cycle(); } catch (e) { prev = null; send('status', String(e.message || e).slice(0, 80)); }
    busy = false;
  }
  setTimeout(tick, 700);
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
