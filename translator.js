// Запускается как utilityProcess: загрузка и работа модели не блокируют приложение
const os = require('os');
try { os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch (e) {}
const port = process.parentPort;
const pipes = new Map();
const files = {};
const NLLB = { en: 'eng_Latn', ru: 'rus_Cyrl', de: 'deu_Latn', fr: 'fra_Latn', es: 'spa_Latn', zh: 'zho_Hans', ja: 'jpn_Jpan' };
// не занимаем все ядра: onnxruntime по умолчанию берёт все физические ядра -> 100% загрузки процессора
const THREADS = Math.max(1, Math.min(4, Math.round(os.cpus().length / 3)));

// v3 (@huggingface/transformers) умеет ограничивать потоки; v2 оставлен как запасной вариант
async function loadTransformers() {
  try { return await import('@huggingface/transformers'); }
  catch (e) { return await import('@xenova/transformers'); }
}

function getPipe(key, modelId, host, cacheDir) {
  if (!pipes.has(key)) {
    port.postMessage({ type: 'loading', key });
    const p = loadTransformers().then(({ pipeline, env }) => {
      env.cacheDir = cacheDir;
      env.remoteHost = host;
      env.allowLocalModels = false;
      return pipeline('translation', modelId, {
        dtype: 'q8', // квантованная модель (в v3 по умолчанию fp32 — в разы больше и медленнее)
        session_options: { intra_op_num_threads: THREADS, inter_op_num_threads: 1 },
        progress_callback: (e) => {
          if (e.status === 'progress' && e.total) {
            files[e.file] = { loaded: e.loaded, total: e.total };
            let loaded = 0, total = 0;
            for (const f of Object.values(files)) { loaded += f.loaded; total += f.total; }
            port.postMessage({ type: 'progress', key, loaded, total });
          } else {
            port.postMessage({ type: 'loading', key }); // «пульс»: файл начат/закончен
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
    const nllb = m.model === 'nllb';
    const key = nllb ? 'nllb' : `${m.s}-${m.t}`;
    const id = nllb ? 'Xenova/nllb-200-distilled-600M' : `Xenova/opus-mt-${m.s}-${m.t}`;
    const pipe = await getPipe(key, id, m.host, m.cacheDir);
    // на вход приходит одно предложение; no_repeat_ngram_size гасит «зацикливание» («я я я я…»)
    const gen = { max_new_tokens: 200, no_repeat_ngram_size: 3 };
    const opts = nllb ? { ...gen, src_lang: NLLB[m.s], tgt_lang: NLLB[m.t] } : { ...gen, num_beams: 2 };
    const out = await pipe(m.text, opts);
    port.postMessage({ id: m.id, ok: true, value: out[0].translation_text });
  } catch (err) {
    port.postMessage({ id: m.id, ok: false, error: String((err && err.message) || err) });
  }
});
