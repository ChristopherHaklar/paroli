import { getSelectionText } from './selection.js';

const DEFAULTS = { server: 'http://localhost:8000/v1', voice: 'af_heart', speed: 1.5, follow: true };
const FALLBACK_VOICES = [
  { voice: 'af_heart', lang: 'en-US' },
  { voice: 'jf_alpha', lang: 'ja-JP' },
  { voice: 'mix', lang: 'en-US', description: 'Auto-detect EN/JA' },
];
const AHEAD = 3;          // sentences to prefetch past the current one
const KEEP_BEHIND = 2;    // decoded sentences kept for quick "previous"
const SENTENCE_GAP = 0.15;
const PARAGRAPH_GAP = 0.4;
const MAX_CHUNK = 300;    // long sentences are split at clause boundaries to keep latency low
const JA_RE = /[　-ヿ一-鿿＀-￯]/;
const EN_RE = /[A-Za-z]/;

const $ = (id) => document.getElementById(id);
const el = {
  play: $('play'), prev: $('prev'), next: $('next'), stop: $('stop'),
  status: $('status'), lang: $('lang'), seek: $('seek'), count: $('count'), error: $('error'), errorText: $('error-text'), errorSettings: $('error-settings'),
  empty: $('empty'), doc: $('doc'), paste: $('paste'),
  voice: $('voice'), speed: $('speed'), speedValue: $('speed-value'), follow: $('follow'),
  settings: $('settings'), server: $('server'), serverResult: $('server-result'),
};

let settings = { ...DEFAULTS };
let sentences = [];       // { text, display, para, lang }
let spans = [];
let current = -1;
let playingIndex = -1;    // sentence whose audio is actually playing (vs. still loading)
let running = false;      // a playback chain is active (playing, loading or paused)
let paused = false;
let gen = 0;              // bumped on every jump/stop; stale async work checks it and bails
let source = null;
let ctx = null;
const cache = new Map();  // index -> { promise, controller, done, failed }

// ---------- text splitting ----------

const segmenter = new Intl.Segmenter(undefined, { granularity: 'sentence' });

function splitLong(sentence) {
  if (sentence.length <= MAX_CHUNK) return [sentence];
  const parts = [];
  let rest = sentence;
  while (rest.length > MAX_CHUNK) {
    const window = rest.slice(0, MAX_CHUNK);
    const cut = Math.max(...[', ', '; ', ': ', '、', ' — ', ' '].map((d) => {
      const at = window.lastIndexOf(d);
      return at > MAX_CHUNK / 3 ? at + d.length : -1;
    }));
    const at = cut > 0 ? cut : MAX_CHUNK;
    parts.push(rest.slice(0, at));
    rest = rest.slice(at);
  }
  if (rest) parts.push(rest);
  return parts;
}

function langOf(text) {
  const ja = JA_RE.test(text);
  const en = EN_RE.test(text);
  return ja && en ? 'EN+JA' : ja ? 'JA' : 'EN';
}

function splitText(text) {
  const out = [];
  text.split(/\n+/).map((p) => p.trim()).filter(Boolean).forEach((paragraph, para) => {
    for (const { segment } of segmenter.segment(paragraph)) {
      for (const display of splitLong(segment)) {
        const text = display.trim();
        if (text) out.push({ text, display, para, lang: langOf(text) });
      }
    }
  });
  return out;
}

// ---------- audio fetching ----------

function ensureCtx() {
  ctx ??= new AudioContext();
  return ctx;
}

function decodeWav(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  let sampleRate = 24000;
  let offset = 12;
  let dataStart = 44;
  while (offset + 8 <= view.byteLength) {
    const id = String.fromCharCode(...new Uint8Array(arrayBuffer, offset, 4));
    const size = view.getUint32(offset + 4, true);
    if (id === 'fmt ') sampleRate = view.getUint32(offset + 12, true);
    if (id === 'data') { dataStart = offset + 8; break; }
    offset += 8 + size;
  }
  const count = Math.floor((arrayBuffer.byteLength - dataStart) / 2);
  if (count <= 0) return null;
  const pcm = new Int16Array(arrayBuffer, dataStart, count);
  const buffer = ensureCtx().createBuffer(1, count, sampleRate);
  const channel = buffer.getChannelData(0);
  for (let i = 0; i < count; i++) channel[i] = pcm[i] / 32768;
  return buffer;
}

async function fetchAudio(sentence, signal) {
  const res = await fetch(`${settings.server}/audio/speech`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: sentence.text, voice: settings.voice, speed: settings.speed }),
    signal,
  });
  if (!res.ok) throw new Error(`Server returned ${res.status}: ${await res.text()}`);
  return decodeWav(await res.arrayBuffer());
}

function startFetch(i) {
  const controller = new AbortController();
  const entry = { controller, done: false, failed: false };
  entry.promise = fetchAudio(sentences[i], controller.signal);
  entry.promise
    .catch(() => { entry.failed = true; })
    .finally(() => { entry.done = true; pump(); });
  cache.set(i, entry);
  return entry;
}

function getBuffer(i) {
  let entry = cache.get(i);
  if (!entry || entry.failed) entry = startFetch(i);
  return entry.promise;
}

// Keeps one background request in flight for the nearest sentence that isn't fetched yet.
// The server serializes synthesis, so more parallelism would only delay the current sentence.
function pump() {
  if (current < 0) return;
  const lo = current - KEEP_BEHIND;
  const hi = Math.min(current + AHEAD, sentences.length - 1);
  for (const [i, entry] of cache) {
    if (i < lo || i > hi) {
      entry.controller.abort();
      cache.delete(i);
    }
  }
  if (!running) return;
  if ([...cache.values()].some((e) => !e.done)) return;
  for (let i = playingIndex === current ? current + 1 : current; i <= hi; i++) {
    if (!cache.has(i)) {
      startFetch(i);
      return;
    }
  }
}

function invalidateAudio() {
  for (const entry of cache.values()) entry.controller.abort();
  cache.clear();
  // The current sentence keeps playing at the old settings; restart it only if it was still loading
  if (running && playingIndex !== current) playIndex(current);
  else pump();
}

// ---------- playback ----------

function stopSource() {
  if (!source) return;
  source.onended = null;
  try { source.stop(); } catch {}
  source.disconnect();
  source = null;
}

function gapAfter(i) {
  if (i + 1 >= sentences.length) return 0;
  return sentences[i + 1].para !== sentences[i].para ? PARAGRAPH_GAP : SENTENCE_GAP;
}

async function playIndex(i, delay = 0) {
  const token = ++gen;
  stopSource();
  playingIndex = -1;
  if (i >= sentences.length) {
    running = false;
    setCurrent(sentences.length, false);
    updateUI('Finished');
    return;
  }
  running = true;
  setCurrent(i);
  setLoading(true);
  pump();

  let buffer;
  try {
    buffer = await getBuffer(i);
  } catch (err) {
    if (token !== gen) return;
    stop();
    if (err.name === 'TypeError') unreachable();
    else showError(err.message);
    return;
  }
  if (token !== gen) return;
  setLoading(false);
  if (!buffer) {
    playIndex(i + 1);
    return;
  }

  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  src.onended = () => {
    if (token === gen) playIndex(i + 1, gapAfter(i));
  };
  source = src;
  playingIndex = i;
  src.start(ctx.currentTime + delay);
  updateUI();
  pump();
}

async function start(i) {
  if (!sentences.length) return;
  hideError();
  ensureCtx();
  await ctx.resume();
  // Autoplay can be refused when no user gesture reached the panel; wait for the play button
  paused = ctx.state !== 'running';
  playIndex(i);
}

function togglePlay() {
  if (!sentences.length) {
    readSelection();
  } else if (!running) {
    start(current >= 0 && current < sentences.length ? current : 0);
  } else if (paused) {
    paused = false;
    ctx.resume();
    updateUI();
  } else {
    paused = true;
    ctx.suspend();
    updateUI();
  }
}

function stop() {
  gen++;
  stopSource();
  running = false;
  playingIndex = -1;
  if (paused && ctx) ctx.resume();
  paused = false;
  setLoading(false);
  pump();
  updateUI('Stopped');
}

function jump(i) {
  if (!sentences.length) return;
  i = Math.max(0, Math.min(i, sentences.length - 1));
  if (paused) {
    paused = false;
    ctx.resume();
  }
  if (running) playIndex(i);
  else start(i);
}

// ---------- rendering ----------

function loadText(text, autoplay) {
  stop();
  for (const entry of cache.values()) entry.controller.abort();
  cache.clear();
  sentences = splitText(text);
  current = sentences.length ? 0 : -1;
  renderDoc();
  if (autoplay) start(0);
  else updateUI('Ready');
}

function renderDoc() {
  el.doc.replaceChildren();
  spans = [];
  let p = null;
  sentences.forEach((s, i) => {
    if (!p || s.para !== sentences[i - 1].para) {
      p = document.createElement('p');
      el.doc.append(p);
    }
    const span = document.createElement('span');
    span.className = 'sentence';
    span.textContent = s.display;
    span.dataset.i = i;
    p.append(span);
    spans.push(span);
  });
  el.empty.hidden = sentences.length > 0;
  el.doc.hidden = sentences.length === 0;
  el.seek.max = Math.max(sentences.length - 1, 0);
  el.seek.disabled = sentences.length === 0;
}

function setCurrent(i, scroll = true) {
  const prev = current;
  current = i;
  const [lo, hi] = prev < i ? [prev, i] : [i, prev];
  for (let k = Math.max(lo, 0); k <= Math.min(hi, spans.length - 1); k++) {
    spans[k].classList.toggle('read', k < i);
    spans[k].classList.toggle('current', k === i);
  }
  if (scroll && settings.follow && spans[i]) {
    spans[i].scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  updateUI();
}

function setLoading(on) {
  document.body.classList.toggle('loading', on);
}

let statusOverride = 'Ready';
function updateUI(status) {
  if (status) statusOverride = status;
  const total = sentences.length;
  const playing = running && !paused;
  document.body.classList.toggle('playing', playing);
  el.play.setAttribute('aria-label', playing ? 'Pause' : 'Play');

  if (running) {
    const loading = document.body.classList.contains('loading');
    el.status.textContent = paused ? 'Paused' : loading ? 'Generating' : 'Playing';
  } else {
    el.status.textContent = total ? statusOverride : 'Ready';
  }

  const shown = Math.min(Math.max(current, 0), Math.max(total - 1, 0));
  el.seek.value = shown;
  const done = current >= total ? total : current;
  el.count.textContent = total ? `${shown + 1} / ${total} · ${Math.round((done / total) * 100)}%` : '';

  const s = sentences[current];
  el.lang.hidden = !(settings.voice === 'mix' && s);
  if (s) el.lang.textContent = s.lang;

  for (const b of [el.prev, el.next, el.stop]) b.disabled = !total;
}

function showError(message, { offerSettings = false } = {}) {
  el.errorText.textContent = message;
  el.errorSettings.hidden = !offerSettings;
  el.error.hidden = false;
}

function unreachable() {
  showError(`Can't reach the server at ${settings.server}.`, { offerSettings: true });
}

function hideError() {
  el.error.hidden = true;
}

// ---------- settings ----------

async function loadSettings() {
  settings = { ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) };
  el.speed.value = settings.speed;
  el.speedValue.textContent = `${Number(settings.speed).toFixed(1)}×`;
  el.follow.setAttribute('aria-pressed', settings.follow);
  el.server.value = settings.server;
}

function saveSetting(key, value) {
  settings[key] = value;
  chrome.storage.local.set({ [key]: value });
}

async function fetchVoices(server = settings.server) {
  const res = await fetch(`${server}/voices`);
  if (!res.ok) throw new Error(`Server returned ${res.status}`);
  return (await res.json()).voices;
}

async function loadVoices() {
  let voices;
  try {
    voices = await fetchVoices();
    hideError();
  } catch {
    voices = FALLBACK_VOICES;
    unreachable();
  }
  el.voice.replaceChildren(...voices.map((v) => {
    const label = v.description ? `${v.voice} — ${v.description}` : `${v.voice} (${v.lang})`;
    return new Option(label, v.voice, false, v.voice === settings.voice);
  }));
  if (!voices.some((v) => v.voice === settings.voice)) saveSetting('voice', el.voice.value);
}

function changeSpeed(value) {
  value = Math.round(Math.max(0.5, Math.min(3, value)) * 10) / 10;
  el.speed.value = value;
  el.speedValue.textContent = `${value.toFixed(1)}×`;
  if (value === settings.speed) return;
  saveSetting('speed', value);
  invalidateAudio();
}

// ---------- input ----------

async function readSelection() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let text = '';
  try {
    text = tab ? await getSelectionText(tab.id) : '';
  } catch {
    showError("Can't read this page's selection. Use right-click → Read with Paroli, or paste the text.");
    return;
  }
  if (text.trim()) loadText(text, true);
  else showError('Nothing is selected on the current page.');
}

let windowId;
async function takePending() {
  const key = `pending:${windowId}`;
  const { [key]: pending } = await chrome.storage.session.get(key);
  if (!pending) return;
  await chrome.storage.session.remove(key);
  hideError();
  loadText(pending.text, true);
}

el.play.addEventListener('click', togglePlay);
el.stop.addEventListener('click', stop);
el.prev.addEventListener('click', () => jump(current - 1));
el.next.addEventListener('click', () => jump(current + 1));
el.seek.addEventListener('input', () => {
  el.count.textContent = `${Number(el.seek.value) + 1} / ${sentences.length}`;
});
el.seek.addEventListener('change', () => jump(Number(el.seek.value)));
el.doc.addEventListener('click', (e) => {
  const span = e.target.closest('.sentence');
  if (span && !getSelection().toString()) jump(Number(span.dataset.i));
});

$('read-selection').addEventListener('click', readSelection);
$('read-paste').addEventListener('click', () => {
  if (el.paste.value.trim()) loadText(el.paste.value, true);
});
$('new').addEventListener('click', () => {
  loadText('', false);
  el.paste.value = '';
  hideError();
});

el.voice.addEventListener('change', () => {
  saveSetting('voice', el.voice.value);
  updateUI();
  invalidateAudio();
});
el.speed.addEventListener('input', () => {
  el.speedValue.textContent = `${Number(el.speed.value).toFixed(1)}×`;
});
el.speed.addEventListener('change', () => changeSpeed(Number(el.speed.value)));
el.follow.addEventListener('click', () => {
  saveSetting('follow', !settings.follow);
  el.follow.setAttribute('aria-pressed', settings.follow);
  if (settings.follow) spans[current]?.scrollIntoView({ block: 'center', behavior: 'smooth' });
});

function openSettings() {
  el.server.value = settings.server;
  el.serverResult.textContent = '';
  el.settings.returnValue = '';
  el.settings.showModal();
}

$('open-settings').addEventListener('click', openSettings);
el.errorSettings.addEventListener('click', openSettings);
$('close-settings').addEventListener('click', () => el.settings.close());
$('test-server').addEventListener('click', async () => {
  const server = el.server.value.replace(/\/+$/, '');
  el.serverResult.textContent = 'Testing…';
  try {
    const voices = await fetchVoices(server);
    el.serverResult.textContent = `Connected · ${voices.length} voices`;
  } catch (err) {
    el.serverResult.textContent = `Failed: ${err.message}`;
  }
});
el.settings.addEventListener('close', () => {
  if (el.settings.returnValue !== 'save') return;
  const server = el.server.value.trim().replace(/\/+$/, '');
  if (!server || server === settings.server) return;
  saveSetting('server', server);
  loadVoices();
  invalidateAudio();
});

document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea, select, dialog') || e.ctrlKey || e.metaKey || e.altKey) return;
  const actions = {
    ' ': togglePlay,
    ArrowLeft: () => jump(current - 1),
    ArrowRight: () => jump(current + 1),
    Escape: stop,
    '[': () => changeSpeed(settings.speed - 0.1),
    ']': () => changeSpeed(settings.speed + 0.1),
  };
  const action = actions[e.key];
  if (!action) return;
  e.preventDefault();
  action();
});

chrome.storage.session.onChanged.addListener((changes) => {
  if (changes[`pending:${windowId}`]?.newValue) takePending();
});

(async () => {
  windowId = (await chrome.windows.getCurrent()).id;
  await loadSettings();
  updateUI();
  await takePending();
  await loadVoices();
})();
