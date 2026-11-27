// Запускается как utilityProcess: загрузка и работа модели не блокируют приложение
const port = process.parentPort;
const pipes = new Map();
const files = {};

function getPipe(s, t, host, cacheDir) {
  const key = `${s}-${t}`;
  if (!pipes.has(key)) {
    port.postMessage({ type: 'loading', key });
    const p = import('@xenova/transformers').then(({ pipeline, env }) => {
      env.cacheDir = cacheDir;
      env.remoteHost = host;
      env.allowLocalModels = false;
      return pipeline('translation', `Xenova/opus-mt-${s}-${t}`, {
        progress_callback: (e) => {
          if (e.status === 'progress' && e.total) {
            files[e.file] = { loaded: e.loaded, total: e.total };
            let loaded = 0, total = 0;
            for (const f of Object.values(files)) { loaded += f.loaded; total += f.total; }
            port.postMessage({ type: 'progress', key, loaded, total });
          } else {
            port.postMessage({ type: 'loading', key }); // событие-«пульс» (файл начат/закончен)
          }
        },
      });
    }).then((pipe) => { port.postMessage({ type: 'ready', key }); return pipe; });
    p.catch(() => { pipes.delete(key); for (const k in files) delete files[k]; });
    pipes.set(key, p);
  }
  return pipes.get(key);
}

port.on('message', async (e) => {
  const m = e.data;
  try {
    const pipe = await getPipe(m.s, m.t, m.host, m.cacheDir);
    const out = await pipe(m.text, { max_new_tokens: 256 });
    port.postMessage({ id: m.id, ok: true, value: out[0].translation_text });
  } catch (err) {
    port.postMessage({ id: m.id, ok: false, error: String((err && err.message) || err) });
  }
});
