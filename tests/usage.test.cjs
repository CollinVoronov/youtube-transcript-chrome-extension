const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(setImmediate); };
function event() {
  const listeners = [];
  return { addListener: fn => listeners.push(fn), emit: (...args) => listeners.forEach(fn => fn(...args)) };
}
function worker(data = {}) {
  data = { autoSummarize: false, ...data };
  const calls = { transcript: 0, summary: 0, queries: 0 };
  const summaryRequests = [];
  let tab = { id: 1, windowId: 1, active: true, url: 'https://www.youtube.com/watch?v=one', title: 'Video - YouTube' };
  const chrome = {
    storage: { local: {
      get: async keys => Object.fromEntries(keys.filter(k => k in data).map(k => [k, structuredClone(data[k])])),
      set: async value => Object.assign(data, structuredClone(value))
    } },
    sidePanel: { setPanelBehavior: async () => {} },
    runtime: { onInstalled: event(), onStartup: event(), onMessage: event(), sendMessage: async () => {} },
    tabs: { onUpdated: event(), onActivated: event(), onRemoved: event(), get: async () => tab,
      query: async () => { calls.queries++; return [tab]; } },
    windows: { getCurrent: async () => ({ id: 1 }) }
  };
  const context = vm.createContext({ chrome, URL, console: { log() {} }, setTimeout, clearTimeout,
    importScripts() {}, PARTS: ['summary', 'sections'],
    CURSOR_API_KEY: 'test', SUPADATA_API_KEY: 'test',
    getInsights: async (transcript, title, options) => {
      calls.summary++; summaryRequests.push({ transcript, title, options });
      return { summary: 'Saved summary', sections: [] };
    },
    fetch: async () => { calls.transcript++; return { ok: true, status: 200, json: async () => ({ content: [{ text: 'Hello', offset: 0 }] }) }; }
  });
  const stubInsights = context.getInsights;
  vm.runInContext(source('lib/claude-api.js'), context);
  context.getInsights = stubInsights;
  vm.runInContext(source('background/service-worker.js'), context);
  const request = message => new Promise(resolve => chrome.runtime.onMessage.emit(message, {}, resolve));
  return { context, chrome, calls, data, request, summaryRequests, navigate: id => {
    tab = { ...tab, url: `https://www.youtube.com/watch?v=${id}` };
    chrome.tabs.onUpdated.emit(1, { url: tab.url }, tab);
    chrome.runtime.onMessage.emit({ type: 'VIDEO_CHANGED', videoId: id }, { tab }, () => {});
  } };
}
function panel(w, visibilityState = 'visible') {
  const elements = new Map();
  const element = () => ({ style: {}, textContent: '', innerHTML: '', value: '', scrollTop: 0,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, setAttribute() {}, appendChild() {}, querySelectorAll: () => [] });
  const visibility = event();
  const document = { visibilityState, getElementById: id => {
    if (!elements.has(id)) elements.set(id, element()); return elements.get(id);
  }, addEventListener: (name, fn) => { if (name === 'visibilitychange') visibility.addListener(fn); },
    createElement: element, scrollingElement: element() };
  const messages = [];
  const chrome = { ...w.chrome, runtime: { onMessage: event(), sendMessage: async msg => {
    messages.push(msg); return w.request(msg);
  } } };
  const context = vm.createContext({ chrome, document, window: { addEventListener() {} }, URL,
    prepareEnglishInsights: w.context.prepareEnglishInsights,
    openrouterModelSetting: w.context.openrouterModelSetting,
    setTimeout, clearTimeout, CURSOR_API_KEY: 'test', requestAnimationFrame: fn => fn() });
  // Rendering is outside these usage tests; execute the real initialization,
  // navigation, cache, visibility, and request paths against the worker.
  vm.runInContext(source('sidepanel/sidepanel.js').replace(/init\(\);\s*$/, '') + '\n' +
    ['renderTranscript', 'renderInsights', 'restoreScroll'].map(name => `${name} = () => {};`).join('\n'), context);
  vm.runInContext('init()', context);
  return { context, messages, document, visibility };
}
test('disabling automatic preparation prevents closed-panel requests', async () => {
  const w = worker({ autoSummarize: false });
  w.chrome.runtime.onInstalled.emit();
  w.chrome.runtime.onStartup.emit();
  w.navigate('one'); w.navigate('two');
  await flush();
  assert.deepEqual(w.calls, { transcript: 0, summary: 0, queries: 0 });
});
test('opening panel automatically loads transcript and summary; reopening reuses both', async () => {
  const w = worker();
  const p = panel(w);
  await flush();
  assert.equal(w.calls.transcript, 1);
  assert.equal(w.calls.summary, 1);
  assert.ok(p.messages.some(m => m.type === 'GENERATE_INSIGHTS' && m.force === false));
  panel(w);
  await flush();
  assert.equal(w.calls.transcript, 1);
  assert.equal(w.calls.summary, 1);
});

test('opening an old Arabic result automatically repairs only that part using the cached transcript', async () => {
  const saved = { summary: 'Keep the existing English summary.', sections: [
    { title: 'طريقتان لدمج الألعاب', description: 'تشغيل اللعبتين معاً بتمرير بيانات الفيزياء بينهما.', timestamp: 0, isAd: false }
  ], notableQuotes: [] };
  const w = worker({ 'insights:one': saved, 'transcript:one': { transcript: [{ text: 'Hello', startTime: 0 }] } });
  panel(w);
  await flush();
  assert.equal(w.calls.transcript, 0);
  assert.equal(w.calls.summary, 1);
  assert.deepEqual(Array.from(w.summaryRequests[0].options.parts), ['sections']);
  assert.equal(w.summaryRequests[0].options.initialInsights.summary, saved.summary);
  assert.equal(w.summaryRequests[0].options.initialInsights.sections, undefined);
  assert.ok(w.summaryRequests[0].options.initialInsights.sectionsError);
  panel(w);
  await flush();
  assert.equal(w.calls.summary, 1);
});

test('failed English repair saves an error without restoring Arabic or retrying on every reopen', async () => {
  const w = worker({ 'insights:one': { summary: 'الذكاء الاصطناعي يحتاج إلى فهم وتفسير.', sections: [], notableQuotes: [] },
    'transcript:one': { transcript: [{ text: 'Hello', startTime: 0 }] } });
  let attempts = 0;
  w.context.getInsights = async (_text, _title, options) => {
    attempts++;
    return { ...options.initialInsights, summaryError: 'English generation failed. Retry this part.' };
  };
  panel(w);
  await flush();
  assert.equal(attempts, 1);
  assert.equal(w.data['insights:one'].summary, undefined);
  assert.match(w.data['insights:one'].summaryError, /English generation failed/);
  panel(w);
  await flush();
  assert.equal(attempts, 1);
});

test('closed-panel automatic preparation repairs saved foreign sections', async () => {
  const w = worker({ autoSummarize: true, 'insights:one': { summary: 'Saved English summary.',
    sections: [{ title: 'طريقتان لدمج الألعاب', timestamp: 0 }], notableQuotes: [] },
    'transcript:one': { transcript: [{ text: 'Hello', startTime: 0 }] } });
  w.navigate('one');
  await flush();
  assert.equal(w.calls.summary, 1);
  assert.equal(w.calls.transcript, 0);
  assert.deepEqual(Array.from(w.summaryRequests[0].options.parts), ['sections']);
});
test('hidden panel does no work; showing it starts automatically', async () => {
  const w = worker();
  const p = panel(w, 'hidden');
  w.navigate('two');
  await flush();
  assert.equal(w.calls.transcript, 0);
  assert.equal(w.calls.summary, 0);
  p.document.visibilityState = 'visible'; p.visibility.emit();
  await flush();
  assert.equal(w.calls.transcript, 1);
  assert.equal(w.calls.summary, 1);
});
test('simultaneous transcript requests share one fetch, saved even without panel caching', async () => {
  const w = worker();
  const message = { type: 'GET_TRANSCRIPT', tabId: 1, videoId: 'one' };
  const [a, b] = await Promise.all([w.request(message), w.request(message)]);
  assert.deepEqual(a, b);
  assert.equal(w.calls.transcript, 1);
  assert.ok(w.data['transcript:one'].transcript.length);
  await w.request(message);
  assert.equal(w.calls.transcript, 1);
  const restarted = worker(w.data);
  await restarted.request(message);
  assert.equal(restarted.calls.transcript, 0);
});
test('stale tab request costs no transcript credit', async () => {
  const w = worker();
  const result = await w.request({ type: 'GET_TRANSCRIPT', tabId: 1, videoId: 'other' });
  assert.equal(result.stale, true);
  assert.equal(w.calls.transcript, 0);
});
test('closing during transcript fetch caches it without starting AI; reopening finishes automatically', async () => {
  const w = worker();
  let finishFetch;
  w.context.fetch = () => {
    w.calls.transcript++;
    return new Promise(resolve => { finishFetch = () => resolve({ ok: true, status: 200,
      json: async () => ({ content: [{ text: 'Hello', offset: 0 }] }) }); });
  };
  const p = panel(w);
  await flush();
  assert.equal(w.calls.transcript, 1);
  p.document.visibilityState = 'hidden'; p.visibility.emit();
  finishFetch();
  await flush();
  assert.ok(w.data['transcript:one']);
  assert.equal(w.calls.summary, 0);
  p.document.visibilityState = 'visible'; p.visibility.emit();
  await flush();
  assert.equal(w.calls.transcript, 1);
  assert.equal(w.calls.summary, 1);
});
test('open panel follows videos, but navigation after hiding it does no new work', async () => {
  const w = worker();
  const p = panel(w);
  await flush();
  w.navigate('two');
  await flush();
  assert.equal(w.calls.transcript, 2);
  assert.equal(w.calls.summary, 2);
  p.document.visibilityState = 'hidden'; p.visibility.emit();
  w.navigate('three');
  await flush();
  assert.equal(w.calls.transcript, 2);
  assert.equal(w.calls.summary, 2);
});
test('unavailable transcript is remembered across panel and worker restarts until explicitly retried', async () => {
  const w = worker();
  w.context.fetch = async () => {
    w.calls.transcript++;
    return { ok: true, status: 206, text: async () => JSON.stringify({ details: 'No transcript available' }) };
  };
  panel(w); await flush();
  panel(w); await flush();
  assert.equal(w.calls.transcript, 1);
  assert.equal(w.calls.summary, 0);
  const restarted = worker(w.data);
  const message = { type: 'GET_TRANSCRIPT', tabId: 1, videoId: 'one' };
  assert.match((await restarted.request(message)).error, /one hour/);
  assert.equal(restarted.calls.transcript, 0);
  const result = await restarted.request({ ...message, retryUnavailable: true });
  assert.ok(result.transcript.length);
  assert.equal(restarted.calls.transcript, 1);
  assert.equal(restarted.data['transcript:one'].unavailable, undefined);
});
test('expired unavailable result permits a fresh request', async () => {
  const w = worker({ 'transcript:one': { unavailable: { error: 'Unavailable', until: Date.now() - 1 } } });
  const result = await w.request({ type: 'GET_TRANSCRIPT', tabId: 1, videoId: 'one' });
  assert.ok(result.transcript.length);
  assert.equal(w.calls.transcript, 1);
});
test('temporary server failures do not get cached as unavailable', async () => {
  const w = worker();
  w.context.fetch = async () => {
    w.calls.transcript++;
    return { ok: false, status: 500, text: async () => 'Temporary failure' };
  };
  const message = { type: 'GET_TRANSCRIPT', tabId: 1, videoId: 'one' };
  await w.request(message); await w.request(message);
  assert.equal(w.calls.transcript, 2);
  assert.equal(w.data['transcript:one'], undefined);
});
test('automatic preparation starts on video navigation with no panel and reuses completed results', async () => {
  const w = worker({ autoSummarize: true });
  w.navigate('one'); // tab event, content event, and startup scan overlap
  await flush();
  assert.equal(w.calls.transcript, 1);
  assert.equal(w.calls.summary, 1);
  w.navigate('two'); await flush();
  assert.equal(w.calls.transcript, 2);
  assert.equal(w.calls.summary, 2);
  w.navigate('one'); await flush();
  const restarted = worker(w.data); await flush();
  assert.equal(w.calls.transcript, 2);
  assert.equal(w.calls.summary, 2);
  assert.equal(restarted.calls.transcript, 0);
  assert.equal(restarted.calls.summary, 0);
});
test('automatic unavailable checks wait a full hour across repeated events and worker restarts', async () => {
  const w = worker({ autoSummarize: true });
  let now = Date.now();
  const started = now;
  w.context.Date = { now: () => now };
  w.context.fetch = async () => {
    w.calls.transcript++;
    return { ok: true, status: 206, text: async () => JSON.stringify({ details: 'No transcript available' }) };
  };
  w.navigate('one'); await flush();
  assert.equal(w.calls.transcript, 1);
  assert.equal(w.data['transcript:one'].unavailable.until, started + 3600000);
  now += 3599999;
  for (let i = 0; i < 5; i++) { w.navigate('one'); await flush(); }
  const restarted = worker(w.data);
  restarted.context.Date = { now: () => now };
  await flush();
  panel(restarted); await flush();
  assert.equal(w.calls.transcript, 1);
  assert.equal(restarted.calls.transcript, 0);
  assert.equal(w.calls.summary, 0);
  assert.equal(w.data['transcript:one'].unavailable.until, started + 3600000);
  now++;
  restarted.navigate('one'); await flush();
  assert.equal(restarted.calls.transcript, 1);
  assert.equal(restarted.calls.summary, 1);
});
test('empty successful responses also pause automatic retries for an hour', async () => {
  const w = worker({ autoSummarize: true });
  w.context.fetch = async () => {
    w.calls.transcript++;
    return { ok: true, status: 200, json: async () => ({ content: [] }) };
  };
  w.navigate('one'); await flush();
  w.navigate('one'); await flush();
  assert.equal(w.calls.transcript, 1);
  assert.equal(w.calls.summary, 0);
  assert.ok(w.data['transcript:one'].unavailable);
});
test('one unavailable video does not pause automatic fetching or summaries for other videos', async () => {
  const w = worker({ autoSummarize: true });
  const requestsByVideo = {};
  w.context.fetch = async url => {
    const id = new URL(url).searchParams.get('videoId');
    requestsByVideo[id] = (requestsByVideo[id] || 0) + 1;
    w.calls.transcript++;
    if (id === 'one') {
      return { ok: true, status: 206, text: async () => JSON.stringify({ details: 'No transcript available' }) };
    }
    return { ok: true, status: 200, json: async () => ({ content: [{ text: 'Available transcript', offset: 0 }] }) };
  };

  w.navigate('one'); await flush();
  const cooldownUntil = w.data['transcript:one'].unavailable.until;
  assert.ok(cooldownUntil > Date.now());
  assert.equal(w.calls.summary, 0);

  w.navigate('two'); await flush();
  assert.deepEqual(requestsByVideo, { one: 1, two: 1 });
  assert.ok(w.data['transcript:two'].transcript.length);
  assert.ok(w.data['insights:two']);
  assert.equal(w.calls.summary, 1);

  w.navigate('one'); await flush();
  w.navigate('three'); await flush();
  assert.deepEqual(requestsByVideo, { one: 1, two: 1, three: 1 });
  assert.ok(w.data['insights:three']);
  assert.equal(w.calls.summary, 2);
  assert.equal(w.data['transcript:one'].unavailable.until, cooldownUntil);
});

test('OpenRouter settings reach the worker without needing a Cursor key', async () => {
  const w = worker({ provider: 'openrouter', openrouterApiKey: 'openrouter-test' });
  w.context.CURSOR_API_KEY = '';
  const p = panel(w);
  await flush();
  assert.equal(w.calls.summary, 1);
  assert.ok(p.messages.some(m => m.type === 'GENERATE_INSIGHTS'));
  assert.equal(w.summaryRequests[0].options.provider, 'openrouter');
  assert.equal(w.summaryRequests[0].options.openrouterApiKey, 'openrouter-test');
  assert.equal(w.summaryRequests[0].options.model, 'z-ai/glm-5.3-flash');
});

test('a saved FlashX model from the old default is sent as Flash', async () => {
  const w = worker({ provider: 'openrouter', openrouterApiKey: 'openrouter-test', openrouterModel: 'z-ai/glm-5.3-flashx' });
  w.context.CURSOR_API_KEY = '';
  panel(w);
  await flush();
  assert.equal(w.summaryRequests[0].options.model, 'z-ai/glm-5.3-flash');
});

test('missing OpenRouter key never falls back to a paid Cursor run', async () => {
  const w = worker({ provider: 'openrouter' });
  const result = await w.request({ type: 'GENERATE_INSIGHTS', videoId: 'one', transcript: [{startTime:0,text:'Example'}] });
  assert.equal(result.error, 'NO_OPENROUTER_KEY');
  assert.equal(w.calls.summary, 0);
});

test('saved provider wins over the local OpenRouter default', async () => {
  const w = worker({ provider: 'cursor' });
  w.context.DEFAULT_INSIGHTS_PROVIDER = 'openrouter';
  w.context.OPENROUTER_API_KEY = 'private-test';
  await w.request({ type: 'GENERATE_INSIGHTS', videoId: 'one', transcript: [{startTime:0,text:'Example'}] });
  await flush();
  assert.equal(w.summaryRequests[0].options.provider, 'cursor');
});

test('new configuration can use the gitignored OpenRouter key and default', async () => {
  const w = worker();
  w.context.DEFAULT_INSIGHTS_PROVIDER = 'openrouter';
  w.context.OPENROUTER_API_KEY = 'private-test';
  await w.request({ type: 'GENERATE_INSIGHTS', videoId: 'one', transcript: [{startTime:0,text:'Example'}] });
  await flush();
  assert.equal(w.summaryRequests[0].options.provider, 'openrouter');
  assert.equal(w.summaryRequests[0].options.openrouterApiKey, 'private-test');
});

test('successful parts are checkpointed before the remaining requests finish', async () => {
  const w = worker();
  let finish;
  w.context.getInsights = async (_text, _title, options) => {
    options.onPartial({ sections: [{ title: 'Saved', timestamp: 0 }], summaryPending: true, sectionsPending: false });
    return new Promise(resolve => { finish = resolve; });
  };
  await w.request({ type: 'GENERATE_INSIGHTS', videoId: 'one', transcript: [{ text: 'Hello', startTime: 0 }] });
  await flush();
  const saved = w.data['insights:one'];
  assert.equal(saved.sections[0].title, 'Saved');
  assert.match(saved.summaryError, /interrupted/);
  assert.equal(saved.summaryPending, undefined);
  const status = await w.request({ type: 'INSIGHTS_STATUS', videoId: 'one' });
  assert.equal(status.partial.summaryPending, true);
  finish({ summary: 'Final', sections: saved.sections, notableQuotes: [] });
  await flush();
  assert.equal(w.data['insights:one'].summaryError, undefined);
  assert.equal(w.data['insights:one']._pendingParts, undefined);
});

test('Summarize retries only failed parts in an incomplete cache', async () => {
  const initial = { sections: [], notableQuotes: [], summaryError: 'Failed' };
  const w = worker({ 'insights:one': initial });
  await w.request({ type: 'GENERATE_INSIGHTS', videoId: 'one', force: true, transcript: [{ text: 'Hello', startTime: 0 }] });
  await flush();
  assert.deepEqual(Array.from(w.summaryRequests[0].options.parts), ['summary']);
  assert.deepEqual(w.summaryRequests[0].options.initialInsights, initial);
});

test('concurrent part cache writes preserve both results and clear replaced stars', async () => {
  const w = worker({ 'insights:one': { summary: 'Old summary', sectionsError: 'Old failure' },
    'starred:one': { 'action:0': true, 'section:0': true, 'insight:0': true } });
  await Promise.all([
    vm.runInContext(`mergePartIntoCache('one','sections',{sections:[{title:'New sections'}]})`, w.context),
    vm.runInContext(`mergePartIntoCache('one','summary',{summary:'New summary',actionItems:[]})`, w.context)
  ]);
  assert.equal(w.data['insights:one'].summary, 'New summary');
  assert.equal(w.data['insights:one'].sections[0].title, 'New sections');
  assert.equal(w.data['insights:one'].sectionsError, undefined);
  assert.deepEqual(w.data['starred:one'], { 'insight:0': true });
});

test('duplicate simultaneous part retries launch one provider request', async () => {
  const w = worker();
  let calls = 0, finish;
  w.context.getInsightsPart = () => { calls++; return new Promise(resolve => { finish = resolve; }); };
  const request = { type: 'REGENERATE_PART', videoId: 'one', part: 'summary', transcript: [{ text: 'Hello', startTime: 0 }] };
  await Promise.all([w.request(request), w.request(request)]);
  assert.equal(calls, 1);
  finish({ summary: 'Saved' });
  await flush();
});

// English-only transcripts. Supadata falls back to the video's first caption
// track when it has no English one, which once showed an English talk's
// Arabic caption track.
const ARABIC_CUES = [
  { text: 'حسناً، أم، مجدداً اسمي هو بوتيتو. أعمل على غروك بوت في سبيس إكس.', startTime: 12 },
  { text: 'هل يمكنني الحصول على رفع سريع للأيدي؟ كم منكم نظر يوماً إلى كود كتبه شخص آخر', startTime: 17 }
];
function supadataReply(w, body) {
  const urls = [];
  w.context.fetch = async url => {
    w.calls.transcript++; urls.push(url);
    return { ok: true, status: 200, json: async () => body };
  };
  return urls;
}
const GET_ONE = { type: 'GET_TRANSCRIPT', tabId: 1, videoId: 'one' };

test('transcripts are requested in English and saved as English', async () => {
  const w = worker();
  const urls = supadataReply(w, { lang: 'en', availableLangs: ['ar', 'en'], content: [{ text: 'Hello', offset: 0 }] });
  const result = await w.request(GET_ONE);
  assert.equal(result.transcript[0].text, 'Hello');
  assert.match(urls[0], /[?&]lang=en(&|$)/);
  assert.equal(w.data['transcript:one'].lang, 'en');
});

test('a non-English reply is refused, not shown, and remembered as unavailable', async () => {
  const w = worker();
  supadataReply(w, { lang: 'ar', availableLangs: ['ar'], content: ARABIC_CUES.map(c => ({ text: c.text, offset: c.startTime * 1000 })) });
  const p = panel(w);
  await flush();
  assert.equal(w.calls.transcript, 1);
  assert.equal(w.calls.summary, 0);
  assert.match(p.document.getElementById('errorMessage').textContent, /no English transcript/);
  assert.equal(w.data['transcript:one'].transcript, undefined);
  assert.ok(w.data['transcript:one'].unavailable.until > Date.now());
  assert.match((await w.request(GET_ONE)).error, /no English transcript/);
  assert.equal(w.calls.transcript, 1);
});

test('no English transcript is remembered for a week', async () => {
  const w = worker();
  supadataReply(w, { lang: 'ar', content: ARABIC_CUES.map(c => ({ text: c.text, offset: 0 })) });
  await w.request(GET_ONE);
  const saved = w.data['transcript:one'].unavailable;
  assert.equal(saved.noEnglish, true);
  assert.ok(saved.until > Date.now() + 6 * 24 * 60 * 60 * 1000);
  const restarted = worker({ 'transcript:one': { unavailable: { ...saved, until: Date.now() + 2 * 60 * 60 * 1000 } } });
  assert.match((await restarted.request(GET_ONE)).error, /saved for a week/);
  assert.equal(restarted.calls.transcript, 0);
});

test('regional English tags are accepted', async () => {
  const w = worker();
  supadataReply(w, { lang: 'en-US', content: [{ text: 'Hello there', offset: 0 }] });
  assert.equal((await w.request(GET_ONE)).transcript[0].text, 'Hello there');
});

test('a reply with no language tag is judged by its text', async () => {
  const w = worker();
  supadataReply(w, { content: ARABIC_CUES.map(c => ({ text: c.text, offset: 0 })) });
  assert.match((await w.request(GET_ONE)).error, /no English transcript/);
});

test('an old saved Arabic transcript is replaced with the English one on open', async () => {
  const w = worker({ 'transcript:one': { transcript: ARABIC_CUES, title: 'Talk' },
    'insights:one': { summary: 'Saved English summary.', sections: [], notableQuotes: [] } });
  supadataReply(w, { lang: 'en', content: [{ text: 'Okay, um, again my name is Lauren.', offset: 12000 }] });
  const p = panel(w);
  await flush();
  assert.equal(w.calls.transcript, 1);
  assert.equal(vm.runInContext('currentTranscript', p.context)[0].text, 'Okay, um, again my name is Lauren.');
  assert.equal(w.data['transcript:one'].lang, 'en');
  assert.equal(w.data['transcript:one'].transcript[0].text, 'Okay, um, again my name is Lauren.');
  // The saved English summary is kept; no new summary is paid for.
  assert.equal(w.calls.summary, 0);
});

test('an old saved English transcript is kept and tagged without a new fetch', async () => {
  const cues = [{ text: 'Welcome back to the channel. Today we are going to talk about reviewing code written by agents.', startTime: 0 }];
  const w = worker({ 'transcript:one': { transcript: cues, title: 'Talk' } });
  assert.equal((await w.request(GET_ONE)).transcript[0].text, cues[0].text);
  assert.equal(w.calls.transcript, 0);
  assert.equal(w.data['transcript:one'].lang, 'en');
  assert.equal(w.data['transcript:one'].title, 'Talk');
});

test('a full rerun never summarizes a saved Arabic transcript', async () => {
  const w = worker({ 'transcript:one': { transcript: ARABIC_CUES, title: 'Talk' },
    'insights:one': { summary: 'Saved English summary.', sections: [], notableQuotes: [] } });
  supadataReply(w, { lang: 'en', content: [{ text: 'Okay, um, again my name is Lauren.', offset: 12000 }] });
  await w.request({ type: 'GENERATE_INSIGHTS', videoId: 'one', title: 'Talk', force: true });
  await flush();
  assert.equal(w.calls.transcript, 1);
  assert.match(w.summaryRequests[0].transcript, /Lauren/);
  assert.doesNotMatch(w.summaryRequests[0].transcript, /\p{Script=Arabic}/u);
  assert.equal(w.data['transcript:one'].title, 'Talk');
});

test('a part rerun never summarizes a saved Arabic transcript', async () => {
  const w = worker({ 'transcript:one': { transcript: ARABIC_CUES },
    'insights:one': { summary: 'Saved English summary.', sections: [], notableQuotes: [] } });
  const urls = supadataReply(w, { lang: 'en', content: [{ text: 'Okay, um, again my name is Lauren.', offset: 12000 }] });
  const sent = [];
  w.context.getInsightsPart = async (part, transcriptText) => { sent.push({ transcriptText, part }); return { sections: [] }; };
  await w.request({ type: 'REGENERATE_PART', videoId: 'one', part: 'sections', title: 'Talk' });
  await flush();
  assert.equal(urls.filter(url => url.includes('supadata')).length, 1);
  assert.equal(sent.length, 1);
  assert.match(sent[0].transcriptText, /Lauren/);
  assert.doesNotMatch(sent[0].transcriptText, /\p{Script=Arabic}/u);
});

test('Chrome language detection catches an untagged Latin-script transcript', async () => {
  const cues = [{ text: 'Hola a todos, bienvenidos de nuevo al canal. Hoy vamos a hablar de revisar código escrito por agentes.', startTime: 0 }];
  const w = worker({ 'transcript:one': { transcript: cues } });
  w.chrome.i18n = { detectLanguage: (text, done) => done({ isReliable: true, languages: [{ language: 'es', percentage: 97 }] }) };
  supadataReply(w, { lang: 'es', content: cues.map(c => ({ text: c.text, offset: 0 })) });
  assert.match((await w.request(GET_ONE)).error, /no English transcript/);
  assert.equal(w.calls.transcript, 1);
});

test('an unreliable language guess keeps an untagged transcript', async () => {
  const cues = [{ text: 'Welcome back everyone, today we review agent written code and talk about slop in big codebases.', startTime: 0 }];
  const w = worker({ 'transcript:one': { transcript: cues } });
  w.chrome.i18n = { detectLanguage: (text, done) => done({ isReliable: false, languages: [{ language: 'nl', percentage: 70 }] }) };
  assert.equal((await w.request(GET_ONE)).transcript[0].text, cues[0].text);
  assert.equal(w.calls.transcript, 0);
});
