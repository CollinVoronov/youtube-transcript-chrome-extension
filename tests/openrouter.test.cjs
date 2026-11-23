const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../lib/claude-api.js'), 'utf8');

function setup(fetch) {
  const timers = new Set();
  const intervals = new Map();
  const context = vm.createContext({ fetch, AbortController, TextDecoder, Date,
    chrome: { storage: { local: { get: async () => ({}) } } },
    setTimeout: (fn, ms) => {
      timers.add(fn);
      if (ms < 600000) queueMicrotask(() => { if (timers.delete(fn)) fn(); });
      return fn;
    },
    clearTimeout: fn => timers.delete(fn),
    setInterval: (fn, ms) => { timers.add(fn); intervals.set(fn, ms); return fn; },
    clearInterval: fn => { timers.delete(fn); intervals.delete(fn); }
  });
  vm.runInContext(source, context);
  vm.runInContext(`openrouterModelLimits = {at:Date.now(), limits:new Map([
    ['z-ai/glm-5.3-flash',131072],['another/model',64000]
  ]),pending:null}`, context);
  return { timers, intervals, context, run: expression => vm.runInContext(expression, context) };
}
function event(chunk) { return `data: ${JSON.stringify(chunk)}\r\n\r\n`; }
function stream(text, finish = 'stop', done = true) {
  return ': OPENROUTER PROCESSING\r\n\r\n'
    + event({ choices: [{ delta: { content: text.slice(0, 20) } }] })
    + event({ choices: [{ delta: { content: text.slice(20) }, finish_reason: finish }] })
    + (done ? 'data: [DONE]\r\n\r\n' : '');
}
function response(body, fragment = 7) {
  const bytes = new TextEncoder().encode(body);
  return new Response(new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += fragment) controller.enqueue(bytes.slice(i, i + fragment));
    controller.close();
  } }), { headers: { 'Content-Type': 'text/event-stream' } });
}
const summary = { contentType: 'tutorial', tldr: 'Keep headers visible.', summary: 'Freeze headers.',
  actionItems: [] };
const sections = { sections: [{ title: 'Freeze headers', description: 'Keep headers visible.', timestamp: 0, isAd: false }] };
const opts = `{provider:'openrouter',openrouterApiKey:'test-key',model:'z-ai/glm-5.3-flash'}`;
const transcript = '[0] Example transcript\n[12] Keep café headers visible.\n[30] Closing.';

test('two parallel requests preserve the exact model and merge validated parts', async () => {
  const calls = [];
  const s = setup(async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({url, options, body});
    const schema = JSON.parse(body.messages[0].content.split('schema: ')[1]);
    const value = schema.properties.summary ? summary : sections;
    return response(stream(JSON.stringify(value)), 1); // includes a split multibyte character
  });
  const result = await s.run(`getInsights(${JSON.stringify(transcript)},'Example',${opts})`);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {...summary,...sections});
  assert.equal(calls.length, 2);
  assert.equal(new Set(calls.map(call => call.body.messages[1].content)).size, 2);
  assert.match(calls[0].body.messages[1].content, /Produce ONLY these fields/);
  assert.match(calls[1].body.messages[1].content, /Produce ONLY the "sections" field/);
  assert.deepEqual(calls.map(call => JSON.parse(call.body.messages[0].content.split('schema: ')[1]).required),
    [['contentType','tldr','summary','actionItems'], ['sections']]);
  for (const {url, options, body} of calls) {
    assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer test-key');
    assert.equal(body.model, 'z-ai/glm-5.3-flash');
    assert.equal(body.response_format.type, 'json_object');
    assert.equal(body.provider.require_parameters, true);
    assert.equal(body.stream, true);
    assert.match(body.messages[0].content, /Write all generated prose in English/);
    assert.match(body.messages[1].content, /Use English even when the title or transcript is in another language/);
    assert.equal(body.max_tokens, 131072);
    assert.ok(options.signal);
  }
  assert.deepEqual(calls.map(call => call.body.reasoning.effort), ['high', 'low']);
  assert.equal(s.timers.size, 0);
});

test('Arabic section prose gets corrected without rerunning valid sibling parts', async () => {
  const calls = [];
  const arabic = { sections: [{ ...sections.sections[0], title: 'طريقتان لدمج الألعاب',
    description: 'تشغيل اللعبتين معاً بتمرير بيانات الفيزياء بينهما.' }] };
  const s = setup(async (_url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    const schema = JSON.parse(body.messages[0].content.split('schema: ')[1]);
    const value = schema.properties.summary ? summary : schema.properties.sections
      ? (body.messages.length === 2 ? arabic : sections) : summary;
    return response(stream(JSON.stringify(value)));
  });
  const result = await s.run(`getInsights(${JSON.stringify(transcript)},'Example',${opts})`);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { ...summary, ...sections });
  assert.equal(calls.length, 3);
  assert.match(calls.at(-1).messages[3].content, /sections\[0\].title must be written in English/);
  assert.match(calls.at(-1).messages[3].content, /sections\[0\].description must be written in English/);
  assert.equal(s.timers.size, 0);
});

test('persistent Arabic summary becomes a retryable part error, not a successful result', async () => {
  const arabic = { ...summary, summary: 'الذكاء الاصطناعي والتفكيك الممل يحتاج إلى فهم وتفسير.' };
  let calls = 0;
  const s = setup(async (_url, options) => {
    const schema = JSON.parse(JSON.parse(options.body).messages[0].content.split('schema: ')[1]);
    if (schema.properties.summary) calls++;
    return response(stream(JSON.stringify(schema.properties.summary ? arabic : sections)));
  });
  const result = await s.run(`getInsights(${JSON.stringify(transcript)},'Example',${opts})`);
  assert.equal(calls, 4);
  assert.equal(result.summary, undefined);
  assert.match(result.summaryError, /summary must be written in English/);
  assert.deepEqual(JSON.parse(JSON.stringify(result.sections)), sections.sections);
  assert.equal(s.timers.size, 0);
});

test('English prose allows accented text and foreign names', () => {
  const s = setup(() => { throw new Error('Unexpected request'); });
  const english = { sections: [{ ...sections.sections[0], title: 'Pokémon and 日本語',
    description: 'Compare café menus with menus labeled 日本語.' }] };
  assert.equal(s.run(`englishOutputIssues(${JSON.stringify(english)}, 'sections')`).length, 0);
});

test('native language detection retries Latin-script foreign prose and accepts the English correction', async () => {
  const spanish = { ...summary, summary: 'La inteligencia artificial necesita comprender las instrucciones y explicar sus resultados con claridad.' };
  let count = 0;
  const s = setup(async () => response(stream(JSON.stringify(++count === 1 ? spanish : summary))));
  s.context.chrome.i18n = { detectLanguage(text, done) {
    done({ isReliable: true, languages: [{ language: text.includes('La inteligencia') ? 'es' : 'en', percentage: 95 }] });
  } };
  const result = await s.run(`getInsightsPart('summary',${JSON.stringify(transcript)},'Example',${opts})`);
  assert.equal(count, 2);
  assert.equal(result.summary, summary.summary);
});

test('unreliable native detection does not reject English names or technical vocabulary', async () => {
  const s = setup(() => { throw new Error('Unexpected request'); });
  s.context.chrome.i18n = { detectLanguage(_text, done) {
    done({ isReliable: false, languages: [{ language: 'fr', percentage: 70 }] });
  } };
  assert.equal((await s.run(`detectEnglishOutputIssues(${JSON.stringify(summary)},'summary')`)).length, 0);
});

test('shared prompts and non-OpenRouter results enforce the English prose policy', async () => {
  const s = setup(() => { throw new Error('Unexpected network request'); });
  for (const part of ['summary', 'sections']) {
    assert.match(s.run(`PART_PROMPTS['${part}']('text', 'title')`), /Write all generated prose in English/);
  }
  s.run(`getInsightsViaAnthropic = async () => (${JSON.stringify({ ...summary, summary: 'الذكاء الاصطناعي يحتاج إلى فهم وتفسير.' })})`);
  await assert.rejects(s.run("getInsightsPart('summary','text','title',{provider:'anthropic',apiKey:'test'})"), /must be written in English/);
});

test('elapsed time advances while waiting for headers and a silent stream, then stops', async () => {
  let deliverHeaders;
  const s = setup(() => new Promise(resolve => { deliverHeaders = resolve; }));
  let now = 1000;
  const progress = [];
  s.context.Date = { now: () => now };
  s.context.reportTest = message => progress.push(message);
  const pending = s.run(`getInsightsPart('sections','','',{...${opts},onProgress:reportTest})`);
  const tick = () => { for (const [fn, ms] of s.intervals) if (ms === 1000) fn(); };
  assert.match(progress.at(-1), /Sending sections.*0s$/);
  now += 35000; tick();
  assert.match(progress.at(-1), /Sending sections.*35s$/);
  let controller;
  deliverHeaders(new Response(new ReadableStream({ start(c) { controller = c; } })));
  await new Promise(setImmediate);
  now += 30000; tick();
  assert.match(progress.at(-1), /analyzing.*sections.*1m 5s$/);
  controller.enqueue(new TextEncoder().encode(stream(JSON.stringify(sections))));
  controller.close();
  await pending;
  const count = progress.length;
  now += 10000; tick();
  assert.equal(progress.length,count);
  assert.equal(s.timers.size,0);
});

test('progress follows sections when summary finishes first', async () => {
  const requests = [];
  const s = setup(() => new Promise(resolve => requests.push(resolve)));
  const progress = [];
  let now = 1000;
  s.context.Date = {now: () => now};
  s.context.reportTest = message => progress.push(message);
  const pending = s.run(`getInsights('Example','Title',{...${opts},onProgress:reportTest})`);
  assert.equal(requests.length,2); // all start before any response arrives
  requests[0](response(stream(JSON.stringify(summary))));
  await new Promise(setImmediate);
  now += 90000;
  for (const [fn,ms] of s.intervals) if (ms === 1000) fn();
  assert.match(progress.at(-1), /sections.*1m 30s$/);
  requests[1](response(stream(JSON.stringify(sections))));
  await pending;
  assert.equal(s.timers.size,0);
});

test('single-part rerun submits one request and returns only that part', async () => {
  let calls = 0;
  const s = setup(async () => { calls++; return response(stream(JSON.stringify(sections))); });
  const result = await s.run(`getInsightsPart('sections','[0] Example','Example',${opts})`);
  assert.deepEqual(JSON.parse(JSON.stringify(result)),sections);
  assert.equal(calls,1);
});

test('absent key fails before spending anything', async () => {
  const s = setup(() => assert.fail('Should not send a request'));
  await assert.rejects(s.run(`getInsightsPart('sections','','',{provider:'openrouter'})`),/NO_OPENROUTER_KEY/);
  assert.equal(s.timers.size,0);
});

for (const [status, message] of [[401,/rejected/],[402,/credits/],[429,/rate limiting/],[503,/availability/]]) {
  test(`HTTP ${status} is actionable and does not leak response bodies`, async () => {
    const s = setup(async () => new Response('secret upstream body', {status}));
    await assert.rejects(s.run(`getInsightsPart('sections','','',${opts})`),message);
    assert.equal(s.timers.size,0);
  });
}

for (const [label, body, message] of [
  ['midstream error', event({error:{code:502,message:'private diagnostic'}}), /^(?![\s\S]*private diagnostic)[\s\S]*failed/],
  ['truncation',stream(JSON.stringify(sections),'length'),/output limit/],
  ['disconnect',stream(JSON.stringify(sections),null,false),/did not finish/],
  ['malformed JSON',stream('{'),/valid JSON/],
  ['missing field',stream('{}'),/missing/],
  ['wrong timestamp type',stream('{"sections":[{"title":"Test","description":"Test","isAd":false,"timestamp":"12"}]}'),/nonnegative number/],
  ['negative timestamp',stream('{"sections":[{"title":"Test","description":"Test","isAd":false,"timestamp":-12}]}'),/nonnegative number/],
  ['extra field',stream('{"sections":[],"summary":"Wrong part"}'),/unexpected/],
  ['refusal',event({choices:[{delta:{refusal:'No'}}]}),/declined/]
]) {
  test(`${label} is rejected before caching and clears active timers`, async () => {
    const s=setup(async()=>response(body));
    await assert.rejects(s.run(`getInsightsPart('sections','','',${opts})`),message);
    assert.equal(s.timers.size,0);
  });
}

test('timeout aborts a hanging request and clears the worker keepalive', async () => {
  const s=setup((_url, options)=>new Promise((_resolve,reject)=>{
    options.signal.addEventListener('abort',()=>reject(new Error('Aborted')));
  }));
  const pending = s.run(`getInsightsPart('sections','','',${opts})`);
  [...s.timers][0]();
  await assert.rejects(pending,/10 minutes/);
  assert.equal(s.timers.size,0);
});

test('sections failure preserves a valid summary', async () => {
  const s=setup(async (_url, options)=>{
    const schema=JSON.parse(JSON.parse(options.body).messages[0].content.split('schema: ')[1]);
    return response(stream(JSON.stringify(schema.properties.summary ? summary : {})));
  });
  const result=await s.run(`getInsights(${JSON.stringify(transcript)},'Example',${opts})`);
  assert.equal(result.summary,summary.summary);
  assert.match(result.sectionsError,/missing/);
  assert.equal(result.sections.length,0);
});

test('overlong content is corrected once without rerunning sections', async () => {
  const calls = [];
  const invalid = {...summary, summary:Array(151).fill('word').join(' ')};
  const s = setup(async(_url,options)=>{
    const body = JSON.parse(options.body);
    calls.push(body);
    const schema = JSON.parse(body.messages[0].content.split('schema: ')[1]);
    const value = schema.properties.summary ? (body.messages.length === 2 ? invalid : summary)
      : sections;
    return response(stream(JSON.stringify(value)));
  });
  const result = await s.run(`getInsights(${JSON.stringify(transcript)},'Example',${opts})`);
  assert.equal(result.summary,summary.summary);
  assert.equal(calls.length,3);
  assert.equal(calls.at(-1).messages[2].role,'assistant');
  assert.match(calls.at(-1).messages[3].content,/150 words/);
  assert.equal(s.timers.size,0);
});

test('repeated editorial failure stops after four attempts and is not returned as valid', async () => {
  let count=0;
  const invalid={...summary,actionItems:Array(7).fill({action:'Freeze headers',detail:'Freeze the first row.',timestamp:0})};
  const s=setup(async()=>{count++;return response(stream(JSON.stringify(invalid)));});
  await assert.rejects(s.run(`getInsightsPart('summary',${JSON.stringify(transcript)},'Example',${opts})`),/quality checks.*at most 6/);
  assert.equal(count,4);
  assert.equal(s.timers.size,0);
});

test('long section descriptions survive initial generation and a sections-only retry without extra requests', async () => {
  // Reproduce the screenshot failure: one long description must not discard
  // the navigation index, its ad skip boundaries, or the sentence's caveat.
  const description = 'The guest describes how investors evaluate expected returns, fees, time horizons, diversification, and access to cash before choosing an investment, while emphasizing that future returns are never guaranteed.';
  assert.ok(description.split(/\s+/).length > 20);
  const value = { sections: [
    { title: 'Closing caveat', timestamp: 30, description, isAd: false },
    { title: 'Opening argument', timestamp: 0, description: 'Introduce the investment framework.', isAd: false },
    { title: 'Sponsor read', timestamp: 12, description: 'Advertiser.', isAd: true }
  ] };
  for (const fullRun of [true, false]) {
    const calls = [];
    const partials = [];
    const s = setup(async (_url, options) => {
      const body = JSON.parse(options.body);
      calls.push(body);
      const schema = JSON.parse(body.messages[0].content.split('schema: ')[1]);
      // Leave the summary pending so sections publish progressively.
      if (schema.properties.summary) await new Promise(setImmediate);
      return response(stream(JSON.stringify(schema.properties.summary ? summary : value)));
    });
    s.context.capturePartial = data => partials.push(JSON.parse(JSON.stringify(data)));
    const result = await s.run(fullRun
      ? `getInsights(${JSON.stringify(transcript)},'Example',{...${opts},onPartial:capturePartial})`
      : `getInsightsPart('sections',${JSON.stringify(transcript)},'Example',${opts})`);
    const expected = [...value.sections].sort((a, b) => a.timestamp - b.timestamp);
    assert.deepEqual(JSON.parse(JSON.stringify(result.sections)), expected);
    assert.equal(result.sectionsError, undefined);
    assert.equal(calls.length, fullRun ? 2 : 1);
    assert.ok(calls.every(call => call.messages.length === 2));
    if (fullRun) {
      assert.equal(result.summary, summary.summary);
      assert.ok(partials.some(partial => partial.sections?.[2]?.description === description && !partial.sectionsPending));
    }
    assert.equal(s.timers.size, 0);
  }
});

test('invalid section timestamps still require correction despite permissive description length', () => {
  const s=setup();
  s.context.testValue={sections:[
    {title:'Middle',timestamp:12,description:Array(21).fill('word').join(' '),isAd:false},
    {title:'Outside',timestamp:999,description:'Outside transcript',isAd:false},
    {title:'Duplicate',timestamp:12,description:'Duplicate time',isAd:false}
  ]};
  const issues=s.run(`checkOpenrouterContent(testValue,${JSON.stringify(transcript)},'sections')`);
  assert.doesNotMatch(issues.join(';'),/20 words/);
  assert.match(issues.join(';'),/distinct start/);
  assert.match(issues.join(';'),/first section must start at 0/);
  assert.match(issues.join(';'),/inside the transcript/);
});

test('invalid section navigation still fails after four attempts', async () => {
  let calls = 0;
  const invalid = { sections: [sections.sections[0], { ...sections.sections[0], title: 'Duplicate start' }] };
  const s = setup(async () => { calls++; return response(stream(JSON.stringify(invalid))); });
  await assert.rejects(s.run(`getInsightsPart('sections',${JSON.stringify(transcript)},'Example',${opts})`), /quality checks.*distinct start times/);
  assert.equal(calls, 4);
  assert.equal(s.timers.size, 0);
});

test('non-GLM overrides do not inherit unsupported reasoning settings', async () => {
  let body;
  const s=setup(async(_url,options)=>{body=JSON.parse(options.body);return response(stream(JSON.stringify(sections)));});
  await s.run(`getInsightsPart('sections','','',{...${opts},model:'another/model'})`);
  assert.equal(body.model,'another/model');
  assert.equal(body.reasoning,undefined);
  assert.equal(body.max_tokens,64000);
});

test('parallel parts share catalog discovery and use the advertised output maximum', async () => {
  let catalogCalls=0;
  const requests=[];
  const s=setup(async(url,options)=>{
    if (url.endsWith('/models')) {
      catalogCalls++;
      return new Response(JSON.stringify({data:[{id:'z-ai/glm-5.3-flash',context_length:1048576,top_provider:{max_completion_tokens:131072}}]}));
    }
    const body=JSON.parse(options.body);
    requests.push(body);
    const schema=JSON.parse(body.messages[0].content.split('schema: ')[1]);
    return response(stream(JSON.stringify(schema.properties.summary ? summary : sections)));
  });
  s.run('openrouterModelLimits.at = 0');
  await s.run(`getInsights(${JSON.stringify(transcript)},'Example',${opts})`);
  assert.equal(catalogCalls,1);
  assert.equal(requests.length,2);
  assert.ok(requests.every(body=>body.max_tokens===131072));
  await s.run(`getInsightsPart('sections',${JSON.stringify(transcript)},'Example',${opts})`);
  assert.equal(catalogCalls,1);
  assert.equal(s.timers.size,0);
});

test('missing advertised output limit does not substitute context length or a hidden cap', async () => {
  let calls=0;
  const s=setup(async()=>{
    calls++;
    return new Response(JSON.stringify({data:[{id:'unknown/model',context_length:1048576,top_provider:{max_completion_tokens:null}}]}));
  });
  await assert.rejects(s.run(`getInsightsPart('sections','','',{...${opts},model:'unknown/model'})`),/does not advertise an output maximum/);
  assert.equal(calls,1);
  assert.equal(s.timers.size,0);
});

test('a stray markdown fence after a complete answer does not discard valid JSON', async () => {
  const s=setup(async()=>response(stream(JSON.stringify(summary)+'\n``')));
  const result=await s.run(`getInsightsPart('summary',${JSON.stringify(transcript)},'Example',${opts})`);
  assert.equal(result.summary,summary.summary);
});

test('reasoning-only output exhaustion retries within the attempt budget and never gets accepted', async () => {
  let count=0;
  const s=setup(async()=>{
    count++;
    return response(event({choices:[{delta:{reasoning:'Reasoning content'},finish_reason:null}]})
      +event({choices:[{delta:{},finish_reason:'length'}],usage:{completion_tokens:16000,completion_tokens_details:{reasoning_tokens:15996}}})
      +'data: [DONE]\r\n\r\n');
  });
  await assert.rejects(s.run(`getInsightsPart('sections',${JSON.stringify(transcript)},'Example',${opts})`),/output limit/);
  assert.equal(count,4);
  assert.equal(s.timers.size,0);
});

test('generic summary introductions and contradictory ad labels require correction', () => {
  const s=setup();
  s.context.testValue={...summary,summary:"The episode's spine is a topic list."};
  assert.match(s.run(`checkOpenrouterContent(testValue,'','summary')`).join(';'),/state the argument directly/);
  s.context.testValue={sections:[{...sections.sections[0],title:'Subscribe plug',isAd:false}]};
  assert.match(s.run(`checkOpenrouterContent(testValue,'','sections')`).join(';'),/isAd true/);
});

test('summary failure preserves completed sections and identifies only summary as failed', async () => {
  const calls = { summary: 0, sections: 0 };
  const partials = [];
  const invalid = { ...summary, actionItems: [{ action: Array(13).fill('word').join(' '), detail: 'Freeze the first row.', timestamp: 0 }] };
  const s = setup(async (_url, options) => {
    const body = JSON.parse(options.body);
    const schema = JSON.parse(body.messages[0].content.split('schema: ')[1]);
    const part = schema.properties.summary ? 'summary' : 'sections';
    calls[part]++;
    if (part === 'summary' && calls.summary > 1) {
      assert.match(body.messages[3].content, /actionItems\[0\]\.action \(13 words\).*12 words/);
      assert.match(body.messages[3].content, /Preserve all other valid fields/);
    }
    return response(stream(JSON.stringify(part === 'summary' ? invalid : sections)));
  });
  s.context.capturePartial = value => partials.push(structuredClone(value));
  const result = await s.run(`getInsights(${JSON.stringify(transcript)},'Title',{...${opts},onPartial:capturePartial})`);
  assert.deepEqual(calls, { summary: 4, sections: 1 });
  assert.match(result.summaryError, /Stopped after 4 attempts/);
  assert.deepEqual(structuredClone(result.sections), sections.sections);
  assert.ok(partials.some(p => p.sections && p.summaryPending));
  assert.equal(partials.at(-1).summaryPending, false);
  assert.equal(s.timers.size, 0);
});

test('a heading that fails twice is corrected on the third attempt', async () => {
  let calls = 0;
  const s = setup(async () => response(stream(JSON.stringify(++calls < 3
    ? { ...summary, actionItems: [{ action: Array(13).fill('word').join(' '), detail: 'Freeze the first row.', timestamp: 0 }] }
    : summary))));
  const result = await s.run(`getInsightsPart('summary',${JSON.stringify(transcript)},'Title',${opts})`);
  assert.equal(calls, 3);
  assert.deepEqual(structuredClone(result), summary);
});

for (const failure of ['rate limit', 'server error', 'network', 'disconnect', 'invalid JSON', 'wrong shape']) {
  test(`${failure} recovers automatically on the next attempt`, async () => {
    let calls = 0;
    const s = setup(async () => {
      if (++calls > 1) return response(stream(JSON.stringify(sections)));
      if (failure === 'rate limit') return new Response('', { status: 429, headers: { 'Retry-After': '2' } });
      if (failure === 'server error') return new Response('', { status: 503 });
      if (failure === 'network') throw new TypeError('fetch failed');
      if (failure === 'disconnect') return response(stream('', null, false));
      return response(stream(failure === 'invalid JSON' ? '{' : '{}'));
    });
    const progress = [];
    s.context.reportTest = message => progress.push(message);
    const result = await s.run(`getInsightsPart('sections','','Title',{...${opts},onProgress:reportTest})`);
    assert.deepEqual(structuredClone(result), sections);
    assert.equal(calls, 2);
    assert.ok(progress.some(message => /attempt 2\/4/.test(message)));
    if (failure === 'rate limit') assert.ok(progress.some(message => /Retrying sections in 2s/.test(message)));
    assert.equal(s.timers.size, 0);
  });
}

for (const status of [400, 401, 402, 403, 404]) {
  test(`HTTP ${status} never spends retry attempts`, async () => {
    let calls = 0;
    const s = setup(async () => { calls++; return new Response('', { status }); });
    await assert.rejects(s.run(`getInsightsPart('sections','','Title',${opts})`));
    assert.equal(calls, 1);
    assert.equal(s.timers.size, 0);
  });
}

test('retrying an incomplete result submits only the failed part and retains successful empty lists', async () => {
  let calls = 0;
  const s = setup(async () => { calls++; return response(stream(JSON.stringify(summary))); });
  s.context.initial = { sections: [], summaryError: 'Previous failure', _pendingParts: ['summary'] };
  const result = await s.run(`getInsights('','Title',{...${opts},initialInsights:initial,parts:['summary']})`);
  assert.deepEqual(structuredClone(result), { ...summary, sections: [] });
  assert.equal(calls, 1);
});

test('a failed replacement preserves the previous valid response for that part', async () => {
  const s = setup(async () => new Response('', { status: 402 }));
  s.context.initial = { ...summary, ...sections };
  const result = await s.run(`getInsights('','Title',{...${opts},initialInsights:initial,parts:['summary']})`);
  assert.equal(result.summary, summary.summary);
  assert.match(result.summaryError, /credits/);
  assert.deepEqual(structuredClone(result.sections), sections.sections);
});

test('a 404 from zero-data-retention routing explains the account setting', async () => {
  let calls = 0;
  const s = setup(async () => {
    calls++;
    return new Response(JSON.stringify({ error: { code: 404, message: '0 endpoints out of 1 requested are available',
      metadata: { ineligibility_reasons: [{ reason: 'zdr-violation-by-account', endpoint_count: 1 }] } } }), { status: 404 });
  });
  await assert.rejects(s.run(`getInsightsPart('sections','','Title',${opts})`),
    error => /zero data retention/.test(error.message) && /Settings/.test(error.message));
  assert.equal(calls, 1);
});

test('free-text OpenRouter error messages stay out of the panel', async () => {
  const s = setup(async () => new Response(JSON.stringify({ error: { code: 400, message: 'private diagnostic' } }), { status: 400 }));
  await assert.rejects(s.run(`getInsightsPart('sections','','Title',${opts})`),
    error => /request failed \(400\)/.test(error.message) && !/private diagnostic/.test(error.message));
});

test('the retired FlashX default and blank values resolve to Flash; custom models are kept', () => {
  const s = setup(async () => { throw new Error('no network'); });
  assert.equal(s.run(`openrouterModelSetting('z-ai/glm-5.3-flashx')`), 'z-ai/glm-5.3-flash');
  assert.equal(s.run(`openrouterModelSetting('  ')`), 'z-ai/glm-5.3-flash');
  assert.equal(s.run(`openrouterModelSetting(undefined)`), 'z-ai/glm-5.3-flash');
  assert.equal(s.run(`openrouterModelSetting(' another/model ')`), 'another/model');
});
