// Summaries are generated in this worker, not in the side panel, so pull in the
// provider code and the baked-in Cursor key. Root-absolute so the paths don't
// depend on this file staying in background/.
importScripts('/lib/config.js', '/lib/claude-api.js');

// Clicking the toolbar icon opens the side panel (the extension's single UI).
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => {});
});
chrome.runtime.onStartup?.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => {});
});
// Also set it eagerly on worker spin-up in case the events above were missed.
chrome.sidePanel
  ?.setPanelBehavior({ openPanelOnActionClick: true })
  .catch(() => {});

// Message routing
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_TRANSCRIPT') {
    handleGetTranscript(message.tabId || sender.tab?.id, message.videoId).then(sendResponse);
    return true; // async response
  }

  if (message.type === 'SEEK_VIDEO') {
    // Respond so the panel can tell the user when a jump fails instead of
    // looking like a dead click.
    seekVideo(message.tabId, message.time).then(sendResponse);
    return true; // async response
  }

  if (message.type === 'VIDEO_CHANGED') {
    // Broadcast to all side panels; each panel decides whether the update is
    // for the tab it's showing (it carries the originating tabId for that).
    chrome.runtime.sendMessage({
      type: 'VIDEO_UPDATED',
      videoId: message.videoId,
      title: message.title,
      tabId: sender.tab?.id
    }).catch(() => {});

    // Start the transcript + summary now, while the user is still watching,
    // instead of when they eventually open the panel. content.js sends this on
    // every video whether or not the panel is open, so this is what makes the
    // work happen without the extension being open at all.
    prepareVideo(message.videoId, message.title).catch(() => {});
  }

  // The panel asking for a summary. Attaches to a background run if one is
  // already going for this video, so no video is ever summarized twice.
  if (message.type === 'GENERATE_INSIGHTS') {
    handleGenerateInsights(message).then(sendResponse);
    return true;
  }

  // Redo one part (summary / sections / quotes) of an existing summary,
  // leaving the other two exactly as they are.
  if (message.type === 'REGENERATE_PART') {
    handleRegeneratePart(message).then(sendResponse);
    return true;
  }

  // "Is a summary already being generated for this video?" — how a panel that
  // opens mid-run rejoins instead of kicking off its own.
  if (message.type === 'INSIGHTS_STATUS') {
    const entry = inFlightInsights.get(message.videoId);
    sendResponse({
      running: !!entry,
      progress: entry?.progress || '',
      // If any part already landed, hand it over now — the panel can show the
      // summary immediately instead of waiting out the other runs.
      partial: entry?.partial || null,
      // Single-part reruns live in their own map. Without this a panel that
      // reopened mid-rerun showed the stale part with no sign anything was
      // happening to it.
      parts: PARTS.filter(part => inFlightParts.has(`${message.videoId}:${part}`))
    });
    return false;
  }
});

// ---------------------------------------------------- Background summarization
//
// Generation lives here rather than in the side panel for two reasons:
//
//  1. The panel is a per-window document. Switching tabs re-points it at
//     whatever the new active tab shows, and closing it destroys the document
//     outright — so work started there was abandoned, and on return the panel
//     found nothing cached and started a *second* paid run for the same video.
//  2. A Cursor cloud agent provisions a VM before it emits a token, so a run
//     takes minutes. Starting when the panel opens means the user watches a
//     spinner for all of it. Starting when the video opens means it elapses
//     while they watch the video, and the summary is usually already cached by
//     the time they look at the panel.
//
// Everything is keyed by videoId and deduped through inFlightInsights, so the
// panel and a background prep can never both be paying for the same summary.

const STORE_PREFIX_INSIGHTS = 'insights:';
const STORE_PREFIX_STARRED = 'starred:';
const STORE_PREFIX_TRANSCRIPT = 'transcript:';

// Cursor runs outlive this worker, so their ids are persisted. Anything older
// than this is treated as dead rather than polled — past the run timeout there
// is nothing left to rejoin.
const PENDING_CURSOR_RUNS_KEY = 'pendingCursorRuns';
// Must stay comfortably above CURSOR_RUN_TIMEOUT_MS (10 min), or a run still
// legitimately in progress gets written off as dead before it can be rejoined.
const ORPHAN_MAX_AGE_MS = 20 * 60 * 1000;

// videoId -> { progress, startedAt, promise }
const inFlightInsights = new Map();

function broadcast(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
}

// Timings printed to the worker console (chrome://extensions → this extension →
// "service worker"). This is how you tell the two failure modes apart: whether a
// summary felt slow because pre-generation never started, or because the run
// itself genuinely takes minutes. Guessing between those wastes a lot of time.
function logPrep(...args) {
  console.log('[yt-insights]', ...args);
}

// Provider config, resolved the same way the panel resolves it: a key saved in
// Settings wins, and clearing it falls back to the one baked into lib/config.js.
async function readSummarySettings() {
  const stored = await chrome.storage.local.get([
    'apiKey', 'model', 'provider', 'cursorModel', 'cursorApiKey', 'autoSummarize'
  ]);

  const provider = ['anthropic', 'webhook'].includes(stored.provider) ? stored.provider : 'cursor';
  const cursorApiKey = stored.cursorApiKey
    || (typeof CURSOR_API_KEY === 'string' ? CURSOR_API_KEY : '');
  const cursorDefault = typeof CURSOR_DEFAULT_MODEL === 'string' ? CURSOR_DEFAULT_MODEL : 'auto';
  const webhookUrl = typeof CURSOR_WEBHOOK_URL === 'string' ? CURSOR_WEBHOOK_URL : '';
  const webhookAuth = typeof CURSOR_WEBHOOK_AUTH === 'string' ? CURSOR_WEBHOOK_AUTH : '';

  return {
    provider,
    apiKey: stored.apiKey || '',
    cursorApiKey,
    webhookUrl,
    webhookAuth,
    model: provider === 'cursor' ? (stored.cursorModel || cursorDefault) : stored.model,
    // Defaults on — pre-generating is the entire point. Settings can turn it off
    // for anyone who'd rather not spend a run on every video they open.
    autoSummarize: stored.autoSummarize !== false,
    // The webhook path needs BOTH credentials: the webhook token fires the
    // automation, and a normal API key polls the run it creates.
    ready: provider === 'anthropic' ? !!stored.apiKey
      : provider === 'webhook' ? !!(webhookUrl && webhookAuth && cursorApiKey)
      : !!cursorApiKey
  };
}

// One line per cue, prefixed with integer seconds, so the model can copy
// timestamps straight into its output. Must stay in step with the panel's
// buildModelTranscript() — same text in means the same cache is reusable.
function buildModelTranscript(transcript) {
  return transcript.map(e => `[${Math.round(e.startTime)}] ${e.text}`).join('\n');
}

/**
 * Start generating a summary for `videoId`, or return the run already in flight.
 * Never starts a second run for a video — that's the whole contract here.
 */
function startInsights(videoId, transcript, title, settings) {
  const existing = inFlightInsights.get(videoId);
  if (existing) return existing;

  const entry = { progress: 'Starting…', startedAt: Date.now(), promise: null, partial: null };
  inFlightInsights.set(videoId, entry);
  // Any part rerun already in flight is now superseded by this whole-summary run.
  bumpEpoch(videoId);
  logPrep(`run START  video=${videoId} provider=${settings.provider} model=${settings.model || 'auto'}`);

  entry.promise = (async () => {
    try {
      const insights = await getInsights(buildModelTranscript(transcript), title || 'this video', {
        provider: settings.provider,
        model: settings.model,
        apiKey: settings.apiKey,
        cursorApiKey: settings.cursorApiKey,
        webhookUrl: settings.webhookUrl,
        webhookAuth: settings.webhookAuth,
        onProgress: progressMessage => {
          entry.progress = progressMessage;
          broadcast({ type: 'INSIGHTS_PROGRESS', videoId, message: progressMessage });
        },
        // The summary half is done while the section list is still generating.
        // Hold it on the entry as well as broadcasting it, so a panel opened
        // later in the run gets it from INSIGHTS_STATUS instead of a spinner.
        onPartial: partial => {
          entry.partial = partial;
          logPrep(`run PART   video=${videoId} parts=${Object.keys(partial).filter(k => !k.endsWith('Pending')).join(',')} at=${Math.round((Date.now() - entry.startedAt) / 1000)}s`);
          broadcast({ type: 'INSIGHTS_PARTIAL', videoId, insights: partial });
        },
        // Persist the Cursor ids the moment the agent exists, so a worker that
        // gets killed mid-poll can rejoin the paid run instead of starting over.
        onRunStarted: ids => { rememberCursorRun(videoId, ids).catch(() => {}); }
      });

      await cacheInsights(videoId, insights);
      logPrep(`run DONE   video=${videoId} took=${Math.round((Date.now() - entry.startedAt) / 1000)}s`);
      broadcast({ type: 'INSIGHTS_DONE', videoId, insights });
      return { insights };
    } catch (err) {
      const error = err?.message || 'Something went wrong generating the summary.';
      logPrep(`run FAILED video=${videoId} after=${Math.round((Date.now() - entry.startedAt) / 1000)}s — ${error}`);
      broadcast({ type: 'INSIGHTS_ERROR', videoId, error });
      return { error };
    } finally {
      inFlightInsights.delete(videoId);
      await forgetCursorRun(videoId, 'full');
    }
  })();

  return entry;
}

// A fresh summary invalidates the old star map — the indices it keyed no longer
// point at the same items.
async function cacheInsights(videoId, insights) {
  try {
    await chrome.storage.local.set({
      [STORE_PREFIX_INSIGHTS + videoId]: insights,
      [STORE_PREFIX_STARRED + videoId]: {}
    });
  } catch (e) {
    // Storage full or unavailable — the summary still gets broadcast, it just
    // won't be there on the next visit.
  }
}

// ------------------------------------------------- Regenerating ONE part
//
// Redoing a single part is a normal thing to want: the summary reads thin, or
// the section list came back coarse. Rerunning that part alone costs one small
// run, where the Summarize button re-pays for all three and discards two good
// ones.

// videoId:part -> { progress, startedAt, promise }
const inFlightParts = new Map();

// videoId -> counter, bumped every time a whole-summary run starts.
//
// A part rerun and a full run CAN overlap (the user reruns Sections, then
// presses Summarize). Both write the same cache entry, and the part rerun
// finishing second would fold its older part into the brand-new summary. So a
// part run captures the epoch when it starts and drops its result if a full run
// has begun since — the newer, complete answer wins.
const summaryEpochs = new Map();

function currentEpoch(videoId) {
  return summaryEpochs.get(videoId) || 0;
}

function bumpEpoch(videoId) {
  const next = currentEpoch(videoId) + 1;
  summaryEpochs.set(videoId, next);
  return next;
}

// Which star ids a regenerated part invalidates. The summary run also produces
// the takeaways and the action list, so rerunning it retires those stars too.
const STAR_KIND_BY_PART = { sections: ['section'], quotes: ['quote'], summary: ['takeaway', 'action'] };

const PART_LABELS = { summary: 'Summary', sections: 'Sections', quotes: 'Quotes' };

/**
 * Fold one freshly generated part into the cached summary.
 *
 * Reads the cache rather than trusting anything the panel sends, so a rerun
 * started from a stale panel can't overwrite parts it wasn't regenerating.
 */
async function mergePartIntoCache(videoId, part, value) {
  const insightsKey = STORE_PREFIX_INSIGHTS + videoId;
  const starKey = STORE_PREFIX_STARRED + videoId;
  const stored = await chrome.storage.local.get([insightsKey, starKey]);

  const merged = { ...(stored[insightsKey] || {}), ...value };
  // A part that just succeeded is no longer failing.
  delete merged[`${part}Error`];

  // The new items are not the old items, so stars keyed to that part's indices
  // no longer point where the reader put them. Stars on the OTHER parts stand.
  const kinds = STAR_KIND_BY_PART[part] || [];
  const stars = stored[starKey] || {};
  const keptStars = Object.fromEntries(
    Object.entries(stars).filter(([id]) => !kinds.some(kind => id.startsWith(`${kind}:`)))
  );

  try {
    await chrome.storage.local.set({ [insightsKey]: merged, [starKey]: keptStars });
  } catch (e) {
    // Storage full — the merged result still gets broadcast to the panel.
  }
  return merged;
}

async function handleRegeneratePart({ videoId, part, transcript, title }) {
  if (!videoId || !PARTS.includes(part)) return { error: 'Nothing to regenerate.' };

  // A full run is already producing this part; a second one would just race it
  // and lose (see the epoch check below).
  if (inFlightInsights.has(videoId)) {
    return { error: 'This video is already being summarized.' };
  }

  const key = `${videoId}:${part}`;
  const existing = inFlightParts.get(key);
  if (existing) return { running: true, progress: existing.progress };

  const settings = await readSummarySettings();
  if (!settings.ready) {
    return {
      error: settings.provider === 'anthropic' ? 'NO_API_KEY'
        : settings.provider === 'webhook' ? 'NO_WEBHOOK'
        : 'NO_CURSOR_KEY'
    };
  }

  let cues = Array.isArray(transcript) && transcript.length ? transcript : null;
  if (!cues) {
    // The transcript was cached when this video was first summarized, and a
    // rerun is by definition a video we already have. Refetching would spend a
    // Supadata credit to get back the exact same cues.
    const txKey = STORE_PREFIX_TRANSCRIPT + videoId;
    const stored = await chrome.storage.local.get([txKey]);
    const cached = stored[txKey]?.transcript;
    if (Array.isArray(cached) && cached.length) {
      cues = cached;
    } else {
      const result = await fetchTranscript(videoId);
      if (result.error) return { error: result.error };
      cues = result.transcript;
    }
  }
  if (!cues?.length) return { error: 'No transcript to summarize.' };

  const entry = { progress: 'Starting…', startedAt: Date.now(), promise: null };
  inFlightParts.set(key, entry);
  // If a whole-summary run starts after this point, its answer supersedes ours.
  const epoch = currentEpoch(videoId);
  logPrep(`part START video=${videoId} part=${part} provider=${settings.provider}`);

  entry.promise = (async () => {
    try {
      const value = await getInsightsPart(part, buildModelTranscript(cues), title || 'this video', {
        provider: settings.provider,
        model: settings.model,
        apiKey: settings.apiKey,
        cursorApiKey: settings.cursorApiKey,
        webhookUrl: settings.webhookUrl,
        webhookAuth: settings.webhookAuth,
        onProgress: progressMessage => {
          entry.progress = progressMessage;
          broadcast({ type: 'PART_PROGRESS', videoId, part, message: progressMessage });
        },
        // MV3 can kill this worker mid-poll. The Cursor run keeps going and is
        // already paid for, so its ids are persisted the same way a full run's
        // are — without this, a rerun that outlived the worker was simply lost.
        onRunStarted: ids => { rememberCursorRun(videoId, ids, 'part').catch(() => {}); }
      });

      // A full run started while this was generating, so the cache now holds a
      // newer, coherent summary. Folding this older part into it would give the
      // reader a fresh summary with one stale part in it.
      if (currentEpoch(videoId) !== epoch) {
        logPrep(`part DROPPED video=${videoId} part=${part} — superseded by a full run`);
        return { superseded: true };
      }

      const insights = await mergePartIntoCache(videoId, part, value);
      logPrep(`part DONE   video=${videoId} part=${part} took=${Math.round((Date.now() - entry.startedAt) / 1000)}s`);
      broadcast({ type: 'PART_DONE', videoId, part, insights });
      return { insights };
    } catch (err) {
      const error = err?.message || `Could not regenerate the ${PART_LABELS[part].toLowerCase()}.`;
      logPrep(`part FAILED video=${videoId} part=${part} — ${error}`);
      // A superseding full run already owns the panel; don't flash an error for
      // a run whose result nobody wants any more.
      if (currentEpoch(videoId) === epoch) {
        broadcast({ type: 'PART_ERROR', videoId, part, error });
      }
      return { error };
    } finally {
      inFlightParts.delete(key);
      // Only this part's ids — a sibling rerun, or a full run, may still need
      // theirs to survive a worker restart.
      await forgetCursorRun(videoId, 'part', part);
    }
  })();

  return { running: true, progress: entry.progress };
}

/**
 * Called when a YouTube video opens, panel or no panel. Fetches and caches the
 * transcript, then starts the summary so the wait overlaps with watching.
 */
async function prepareVideo(videoId, title) {
  if (!videoId) return;
  if (inFlightInsights.has(videoId)) return; // already running; not worth logging

  const insightsKey = STORE_PREFIX_INSIGHTS + videoId;
  const cached = await chrome.storage.local.get([insightsKey]);
  if (cached[insightsKey]) {
    logPrep(`prep skip  video=${videoId} — already summarized (cached)`);
    return;
  }

  const settings = await readSummarySettings();
  if (!settings.autoSummarize) {
    logPrep(`prep skip  video=${videoId} — "summarize on open" is off in Settings`);
    return;
  }
  if (!settings.ready) {
    logPrep(`prep skip  video=${videoId} — no ${settings.provider} API key configured`);
    return;
  }

  logPrep(`prep BEGIN video=${videoId} — fetching transcript`);

  // Shares the in-flight map with the panel's own request, so opening the panel
  // during prep doesn't spend a second Supadata credit.
  const result = await fetchTranscript(videoId);
  if (result.error || !Array.isArray(result.transcript) || !result.transcript.length) {
    logPrep(`prep ABORT video=${videoId} — transcript unavailable: ${result.error || 'empty'}`);
    return;
  }

  chrome.storage.local
    .set({ [STORE_PREFIX_TRANSCRIPT + videoId]: { transcript: result.transcript, title: title || null } })
    .catch(() => {});

  startInsights(videoId, result.transcript, title, settings);
}

// Panel-initiated request. The panel already holds the transcript, so it passes
// it through rather than making the worker re-fetch.
//
// `force` separates the two callers. The Summarize button is an explicit
// regenerate and must always run. The panel's automatic path must not: a
// background prep can finish in the gap between the panel reading the cache and
// sending this, and without the cache check below that race silently paid for a
// second identical run.
async function handleGenerateInsights({ videoId, transcript, title, force }) {
  if (!videoId) return { error: 'No video to summarize.' };

  const existing = inFlightInsights.get(videoId);
  if (existing) return { running: true, progress: existing.progress, partial: existing.partial || null };

  if (!force) {
    const insightsKey = STORE_PREFIX_INSIGHTS + videoId;
    const cached = await chrome.storage.local.get([insightsKey]);
    if (cached[insightsKey]) return { insights: cached[insightsKey] };
  }

  const settings = await readSummarySettings();
  if (!settings.ready) {
    return {
      error: settings.provider === 'anthropic' ? 'NO_API_KEY'
        : settings.provider === 'webhook' ? 'NO_WEBHOOK'
        : 'NO_CURSOR_KEY'
    };
  }

  let cues = Array.isArray(transcript) && transcript.length ? transcript : null;
  if (!cues) {
    const result = await fetchTranscript(videoId);
    if (result.error) return { error: result.error };
    cues = result.transcript;
  }
  if (!cues?.length) return { error: 'No transcript to summarize.' };

  const entry = startInsights(videoId, cues, title, settings);
  return { running: true, progress: entry.progress, partial: entry.partial || null };
}

// ------------------------------------------- Surviving a worker restart

async function readPendingCursorRuns() {
  const stored = await chrome.storage.local.get([PENDING_CURSOR_RUNS_KEY]);
  return stored[PENDING_CURSOR_RUNS_KEY] || {};
}

// A summary is two runs, and both announce themselves at roughly the same
// moment. Writes are chained so the second read-modify-write cannot land on a
// stale copy and drop the first run's ids — losing one means a killed worker
// silently abandons a half of the summary it already paid for.
let cursorRunWrites = Promise.resolve();

// The record for a video is { at, modes: { full: {part: ids}, part: {part: ids} } }.
//
// Two levels, because a full run and one or more part reruns can genuinely be
// in flight at the same time, and each must be able to record and clear ITS ids
// without touching anyone else's. A flat map lost runs: the first finisher
// deleted the record and every other run in it became unrecoverable.
function readRunModes(record) {
  if (record?.modes) return record.modes;
  // Written by an earlier build: { mode, parts } for one kind of run...
  if (record?.parts) return { [record.mode === 'part' ? 'part' : 'full']: record.parts };
  // ...or, older still, bare ids for a single whole-summary run.
  if (record?.agentId && record?.runId) {
    return { full: { full: { agentId: record.agentId, runId: record.runId } } };
  }
  return {};
}

function rememberCursorRun(videoId, { agentId, runId, part }, mode = 'full') {
  cursorRunWrites = cursorRunWrites.then(async () => {
    const runs = await readPendingCursorRuns();
    const modes = readRunModes(runs[videoId]);
    modes[mode] = { ...(modes[mode] || {}), [part || 'full']: { agentId, runId } };
    runs[videoId] = { at: Date.now(), modes };
    await chrome.storage.local.set({ [PENDING_CURSOR_RUNS_KEY]: runs });
  }).catch(() => {});
  return cursorRunWrites;
}

// Back-compat shim for callers that just want "the parts of this record".
function runPartsOf(record, mode) {
  const modes = readRunModes(record);
  if (mode) return modes[mode] || {};
  return Object.assign({}, ...Object.values(modes));
}

/**
 * Clear run ids, on the same write chain as rememberCursorRun so a forget can't
 * land on a stale copy and resurrect or destroy someone else's ids.
 *
 * Scope it as narrowly as the caller knows: a single part of a single mode when
 * that is all it owns. A part rerun clearing the whole video's record is how a
 * concurrent rerun (or a full run) lost its only route to recovery.
 */
function forgetCursorRun(videoId, mode, part) {
  cursorRunWrites = cursorRunWrites.then(async () => {
    const runs = await readPendingCursorRuns();
    if (!(videoId in runs)) return;

    if (!mode) {
      delete runs[videoId];
    } else {
      const modes = readRunModes(runs[videoId]);
      if (part && modes[mode]) {
        delete modes[mode][part];
        if (!Object.keys(modes[mode]).length) delete modes[mode];
      } else {
        delete modes[mode];
      }
      if (Object.keys(modes).length) runs[videoId] = { at: runs[videoId].at || Date.now(), modes };
      else delete runs[videoId];
    }

    await chrome.storage.local.set({ [PENDING_CURSOR_RUNS_KEY]: runs });
  }).catch(() => {});
  return cursorRunWrites;
}

/**
 * MV3 can terminate this worker between polls. A Cursor agent keeps running on
 * Cursor's side regardless and is already paid for, so on startup rejoin any run
 * whose result never landed rather than abandoning it and billing a new one.
 */
async function resumeOrphanedCursorRuns() {
  const runs = await readPendingCursorRuns();
  const videoIds = Object.keys(runs);
  if (!videoIds.length) return;

  const settings = await readSummarySettings();

  for (const videoId of videoIds) {
    const run = runs[videoId];

    if (!Object.keys(runPartsOf(run)).length || Date.now() - (run.at || 0) > ORPHAN_MAX_AGE_MS) {
      await forgetCursorRun(videoId);
      continue;
    }
    if (inFlightInsights.has(videoId)) continue;
    // A webhook run IS a Cursor agent run — the automation just starts it — so
    // it is pollable with the same API key and must be recovered the same way.
    // Excluding it here abandoned finished runs the user had already paid for:
    // Cursor produced the summary and nothing ever collected it.
    if (!['cursor', 'webhook'].includes(settings.provider) || !settings.cursorApiKey) continue;

    // A full run and part reruns can both have been in flight; rejoin each on
    // its own terms.
    const modes = readRunModes(run);

    if (modes.part) resumePartRun(videoId, modes.part, settings);

    if (modes.full) {
      // A cached summary means a FULL run has nothing left to deliver. A part
      // rerun is the opposite: the cache is exactly what it is replacing.
      const insightsKey = STORE_PREFIX_INSIGHTS + videoId;
      const cached = await chrome.storage.local.get([insightsKey]);
      if (cached[insightsKey]) await forgetCursorRun(videoId, 'full');
      else resumeInsights(videoId, modes.full, settings);
    }
  }
}

// Rejoin a single-part rerun that outlived the worker. The run is already paid
// for and its result is the thing the reader asked for, so it is merged into
// the cached summary exactly as the original rerun would have done.
function resumePartRun(videoId, parts, settings) {
  for (const [part, ids] of Object.entries(parts)) {
    if (!PARTS.includes(part)) continue;
    const key = `${videoId}:${part}`;
    if (inFlightParts.has(key)) continue;

    const entry = { progress: 'Reconnecting to the Cursor agent…', startedAt: Date.now(), promise: null };
    inFlightParts.set(key, entry);

    entry.promise = (async () => {
      try {
        const value = await resumeCursorInsights(
          ids.agentId, ids.runId, settings.cursorApiKey,
          progressMessage => {
            entry.progress = progressMessage;
            broadcast({ type: 'PART_PROGRESS', videoId, part, message: progressMessage });
          }
        );
        const insights = await mergePartIntoCache(videoId, part, pickPartKeys(part, value));
        logPrep(`part RESUMED video=${videoId} part=${part}`);
        broadcast({ type: 'PART_DONE', videoId, part, insights });
        return { insights };
      } catch (err) {
        const error = err?.message || `Could not recover the ${PART_LABELS[part]} run.`;
        broadcast({ type: 'PART_ERROR', videoId, part, error });
        return { error };
      } finally {
        inFlightParts.delete(key);
        await forgetCursorRun(videoId, 'part', part);
      }
    })();
  }
}

// Rejoin an existing Cursor run. Mirrors startInsights' bookkeeping so the panel
// sees a resumed run as indistinguishable from a fresh one.
function resumeInsights(videoId, parts, settings) {
  const entry = {
    progress: 'Reconnecting to the Cursor agent…', startedAt: Date.now(), promise: null, partial: null
  };
  inFlightInsights.set(videoId, entry);
  bumpEpoch(videoId);

  entry.promise = (async () => {
    try {
      const report = progressMessage => {
        entry.progress = progressMessage;
        broadcast({ type: 'INSIGHTS_PROGRESS', videoId, message: progressMessage });
      };

      // Rejoin every half that was in flight and merge them back into one
      // object. A half that cannot be recovered is dropped rather than failing
      // the whole thing — half a summary beats none, and the panel renders
      // whichever fields it gets.
      const settled = await Promise.allSettled(
        Object.entries(parts).map(([part, p]) =>
          resumeCursorInsights(p.agentId, p.runId, settings.cursorApiKey, report)
            // Same filter the live path applies: a provider that answers a
            // partial request with the whole object must not let one part's
            // fields overwrite another's, which is decided purely by which
            // promise settles last.
            .then(value => (PARTS.includes(part) ? pickPartKeys(part, value) : value))
        )
      );
      const recovered = settled.filter(r => r.status === 'fulfilled').map(r => r.value);
      if (!recovered.length) {
        throw settled[0]?.reason || new Error('Could not recover the Cursor run.');
      }
      const insights = Object.assign({}, ...recovered);

      await cacheInsights(videoId, insights);
      broadcast({ type: 'INSIGHTS_DONE', videoId, insights });
      return { insights };
    } catch (err) {
      const error = err?.message || 'Could not recover the Cursor run.';
      broadcast({ type: 'INSIGHTS_ERROR', videoId, error });
      return { error };
    } finally {
      inFlightInsights.delete(videoId);
      await forgetCursorRun(videoId, 'full');
    }
  })();

  return entry;
}

// ------------------------------------------------- Detecting videos to prep
//
// content.js sending VIDEO_CHANGED is NOT a sufficient trigger on its own:
// reloading an unpacked extension orphans the content script in every already-
// open tab, so those tabs never report anything until they're reloaded. That is
// silent — you just never get a pre-generated summary and can't tell why.
//
// These two listeners watch tabs from the worker instead, which needs no
// injected script. `tab.url` is readable here because the manifest already holds
// host permissions for youtube.com, so this adds no new permission prompt.

// Same rule as the panel's cleanTitle: while a playlist navigates, the tab
// title is briefly the playlist ("Watch later") or bare "YouTube". Caching one
// of those as the video title makes it stick for that video.
const PLACEHOLDER_TITLES = ['youtube', 'watch later', 'watch', ''];

function cleanTabTitle(title) {
  const bare = (title || '').replace(' - YouTube', '').replace(/^\(\d+\)\s*/, '').trim();
  return PLACEHOLDER_TITLES.includes(bare.toLowerCase()) ? null : bare;
}

function watchVideoId(url) {
  if (!url || !url.includes('youtube.com/watch')) return null;
  try {
    return new URL(url).searchParams.get('v');
  } catch (e) {
    return null;
  }
}

// Fires on SPA navigations between videos and on a plain tab reload.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = changeInfo.url || tab?.url;
  const videoId = watchVideoId(url);
  if (!videoId) return;
  prepareVideo(videoId, cleanTabTitle(tab?.title))
    .catch(() => {});
});

// Catch videos that were already open before this worker existed — the exact
// case an extension reload creates, and the one that made testing look broken.
async function prepareOpenVideoTabs() {
  try {
    const tabs = await chrome.tabs.query({ url: '*://*.youtube.com/watch*' });
    for (const tab of tabs) {
      const videoId = watchVideoId(tab.url);
      if (!videoId) continue;
      await prepareVideo(
        videoId,
        cleanTabTitle(tab.title)
      ).catch(() => {});
    }
  } catch (e) {
    // No tab access yet — the onUpdated listener above still covers new loads.
  }
}

// Both run on every worker spin-up: pick up runs a terminated worker abandoned,
// and start prepping anything already on screen.
resumeOrphanedCursorRuns().catch(() => {});
prepareOpenVideoTabs().catch(() => {});

// Runs in the page. Kept tiny and self-contained because it's injected by
// value — it can't reference anything from this worker's scope.
function seekInPage(time) {
  const video = document.querySelector('video');
  if (!video) return { ok: false, error: 'No video element on the page.' };
  try {
    video.currentTime = time;
    const p = video.play();
    if (p && typeof p.catch === 'function') p.catch(() => {});
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Seek a YouTube watch tab to a timestamp (in seconds). Resolves a sensible
// target even if the caller's tabId is stale or missing, so tap-to-seek from
// the side panel never silently no-ops.
//
// This injects into the page rather than messaging the content script on
// purpose: reloading an unpacked extension orphans the content script already
// running in open tabs, and messages to it are dropped until the user happens
// to refresh. Injection works immediately, every time.
async function seekVideo(tabId, time) {
  let targetId = null;

  try {
    if (tabId != null) {
      const tab = await chrome.tabs.get(tabId);
      if (tab?.url && tab.url.includes('youtube.com/watch')) {
        targetId = tab.id;
      }
    }
  } catch (e) {
    // tab no longer exists — fall through to a lookup
  }

  if (targetId == null) {
    try {
      const tabs = await chrome.tabs.query({ url: '*://*.youtube.com/watch*' });
      const target = tabs.find(t => t.active) || tabs[0];
      targetId = target?.id ?? null;
    } catch (e) {
      // no matching tab / no access
    }
  }

  if (targetId == null) {
    return { ok: false, error: 'No YouTube video tab found.' };
  }

  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: targetId },
      func: seekInPage,
      args: [time]
    });
    return result?.result || { ok: false, error: 'Seek did not run.' };
  } catch (e) {
    return { ok: false, error: e.message || 'Could not reach the video tab.' };
  }
}

// Concurrent transcript requests for the same video share one Supadata fetch
// (one credit) instead of each spending their own. Keyed by videoId because a
// transcript is a property of the video, not the requesting tab.
const inFlightTranscripts = new Map();

function fetchTranscript(videoId) {
  let pending = inFlightTranscripts.get(videoId);
  if (!pending) {
    pending = doFetchTranscript(videoId).finally(() => inFlightTranscripts.delete(videoId));
    inFlightTranscripts.set(videoId, pending);
  }
  return pending;
}

// Supadata returns 429 `limit-exceeded` for BOTH a short-window request-rate
// limit and monthly quota exhaustion, and the response body is the only thing
// that distinguishes them. Guessing wrong is worse than saying less: telling
// someone with 17 of 100 credits used that they're out of credits sends them to
// a billing page to fix a burst that would have cleared on its own.
//
// So: only claim the quota is gone when Supadata's own message says so, and
// treat everything else as transient — worth retrying, not worth reporting.
//
// Deliberately excludes bare "plan" and "upgrade": Supadata's own advice for a
// *rate* limit suggests upgrading too, so matching those would recreate the bug
// this is here to fix. This only decides the wording, never whether to retry.
const QUOTA_HINTS = /quota|monthly|credits?\b|exhaust|out of credit/i;

function isQuotaExhausted(body) {
  const text = [body?.error, body?.message, body?.details].filter(Boolean).join(' ');
  return QUOTA_HINTS.test(text);
}

// Bursts clear in seconds — a couple of spaced retries turn the common case
// (several YouTube tabs loading at once) into a slightly slower load instead of
// a scary error. Kept short so a genuinely rate-limited panel still gives up
// well before the user does.
const RATE_LIMIT_RETRIES = 2;
const RATE_LIMIT_BACKOFF_MS = [1200, 3000];

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Pull a human-readable line out of a Supadata error response. Their errors are
// JSON ({ error, message, details }), but fall back to raw text so a proxy or
// gateway returning HTML still produces something the panel can show.
async function readSupadataError(resp) {
  const raw = await resp.text().catch(() => '');
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw);
    return (parsed.details || parsed.message || parsed.error || '').toString().substring(0, 200);
  } catch (e) {
    return raw.substring(0, 200);
  }
}

// Fetch + parse a transcript from Supadata. Returns { transcript } or { error }.
async function doFetchTranscript(videoId) {
  const stored = await chrome.storage.local.get(['supadataKey']);
  // Fall back to the built-in key from lib/config.js. This worker fetches
  // transcripts before the side panel has ever run, so it can't rely on the
  // panel's first-run seeding having happened.
  const supadataKey = stored.supadataKey
    || (typeof SUPADATA_API_KEY === 'string' ? SUPADATA_API_KEY : '');
  if (!supadataKey) {
    return { error: 'Please set your Supadata API key in Settings (gear icon). Get a free key at supadata.ai' };
  }

  let resp;
  let body = null;

  for (let attempt = 0; ; attempt++) {
    resp = await fetch(
      'https://api.supadata.ai/v1/youtube/transcript?videoId=' + videoId,
      { headers: { 'x-api-key': supadataKey } }
    );

    // Reset per attempt, so a 429 body from an earlier attempt can never be
    // reported as the detail for a different status on a later one.
    body = null;
    if (resp.status !== 429) break;

    // Read the body so we can tell a burst apart from an exhausted quota.
    // Errors are documented as JSON ({ error, message, details }), but don't
    // let a non-JSON body turn a rate limit into an unhandled throw.
    const raw = await resp.text().catch(() => '');
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch (e) {
      body = { details: raw };
    }

    // Retry every 429, including ones that look like an exhausted quota. A 429
    // means the request never ran, so a retry costs no credits — and retrying
    // an exhausted quota only delays an error, while NOT retrying a
    // misclassified burst breaks a request that would have succeeded.
    if (attempt >= RATE_LIMIT_RETRIES) break;

    await delay(RATE_LIMIT_BACKOFF_MS[attempt]);
  }

  // 206 means Supadata reached the video but no transcript exists for it. It's
  // a success status, so it has to be caught before the `resp.ok` check below
  // or it falls through and gets parsed as a transcript.
  if (resp.status === 206) {
    const detail = await readSupadataError(resp);
    return { error: detail || 'No transcript available for this video' };
  }

  if (!resp.ok) {
    if (resp.status === 401 || resp.status === 403) {
      return { error: 'Invalid Supadata API key. Check Settings.' };
    }

    if (resp.status === 429) {
      // These strings go straight into the panel, so they read as sentences
      // rather than carrying an error code the user has to interpret.
      if (isQuotaExhausted(body)) {
        return {
          error: (body?.details || body?.message ||
            'You\'ve used all your Supadata transcript credits.') +
            ' Check your usage at supadata.ai.'
        };
      }
      // Survived the retries: a real rate limit, not a spent quota. Say that,
      // and don't mention billing — the credits are probably fine.
      return {
        error: 'Supadata is rate limiting requests right now — too many ' +
          'transcripts at once. Wait a few seconds and retry.'
      };
    }

    const detail = body ? (body.details || body.message || '') : await readSupadataError(resp);
    return { error: 'Supadata API error (HTTP ' + resp.status + ')' + (detail ? ': ' + detail : '') };
  }

  const data = await resp.json();

  // Supadata returns { content: [{ text, offset, duration, lang }] } or similar
  const items = Array.isArray(data) ? data : data.content || data.transcript || data.results || [];

  if (!Array.isArray(items) || items.length === 0) {
    return { error: 'No transcript available for this video' };
  }

  // Map to our format { startTime, text }
  const transcript = items
    .filter(item => item.text && item.text.trim())
    .map(item => ({
      startTime: (item.offset || item.start || item.startTime || 0) / 1000,
      text: item.text.trim()
    }));

  if (transcript.length === 0) {
    return { error: 'Transcript data was empty' };
  }

  return { transcript };
}

// `expectedVideoId` is the video the side panel asked for. We derive the video
// from the tab's live URL and refuse to fetch a different one — that prevents a
// mid-fetch SPA navigation from returning (and the panel caching) the wrong
// video's transcript, and avoids spending a credit on a video nobody asked for.
async function handleGetTranscript(tabId, expectedVideoId) {
  if (!tabId) return { error: 'No active tab' };

  try {
    const tab = await chrome.tabs.get(tabId);
    const tabUrl = new URL(tab.url);
    const videoId = tabUrl.searchParams.get('v');
    if (!videoId) return { error: 'No video ID found in URL' };

    // The tab navigated to a different video than the panel asked for — bail
    // without fetching; the navigation will drive a fresh load for the new id.
    if (expectedVideoId && videoId !== expectedVideoId) return { stale: true };

    const result = await fetchTranscript(videoId);
    if (result.error) return { error: result.error };

    // Title comes from THIS request's tab; the transcript array itself is shared.
    const title = cleanTabTitle(tab.title) || 'YouTube Video';
    return { transcript: result.transcript, title, videoId };
  } catch (err) {
    return { error: err.message || 'Unknown error fetching transcript' };
  }
}
