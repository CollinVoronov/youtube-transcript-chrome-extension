// State
let currentTranscript = null;
let currentTabId = null;
let currentVideoId = null;
let myWindowId = null;        // the browser window this panel instance belongs to
let loadSeq = 0;              // bumped on every (re)load so stale async results can be dropped
let showTimestamps = true;
let apiKey = '';
let currentModel = 'claude-sonnet-4-6';
let provider = 'cursor';      // 'cursor' (direct API) | 'webhook' (Cursor automation) | 'anthropic'
let cursorModel = '';         // a Cursor model spec; the list is fetched live
let cursorKeyOverride = '';   // optional; blank means use CURSOR_API_KEY from lib/config.js
let currentInsights = null;   // parsed summary object for the current video
let starred = {};             // { "<kind>:<index>": true } for the current video
let showStarredOnly = false;
// True from the moment a run is started or attached to until it finishes. A
// regenerate leaves the PREVIOUS summary in currentInsights while the new run
// is in flight, so "is a summary on screen?" is not the same question as "is a
// run still going?" — the incoming partial must not be discarded as stale.
let awaitingSummary = false;
// The summary that was on screen before the current run started. A run replaces
// the panel's contents, but the previous result is still in the cache and still
// correct — if the run fails, the reader should get it back rather than being
// left with an error where their summary used to be.
let lastGoodInsights = null;
let lastGoodStarred = null;
// Whether the header is showing a real video title yet. During a playlist
// navigation YouTube reports "Watch later" first and the real title a moment
// later, so a late title for the video we are already on must still be taken.
let hasRealTitle = false;

// DOM Elements
const videoTitle = document.getElementById('videoTitle');
const loadingState = document.getElementById('loadingState');
const errorState = document.getElementById('errorState');
const errorMessage = document.getElementById('errorMessage');
const emptyState = document.getElementById('emptyState');
const transcriptContainer = document.getElementById('transcriptContainer');
const transcriptContent = document.getElementById('transcriptContent');
const insightsContainer = document.getElementById('insightsContainer');
const insightsContent = document.getElementById('insightsContent');
const insightsLoading = document.getElementById('insightsLoading');
const settingsModal = document.getElementById('settingsModal');
const apiKeyInput = document.getElementById('apiKeyInput');
const insightsLoadingText = document.getElementById('insightsLoadingText');

// The Cursor key is hard-coded in lib/config.js so the extension works with
// nothing typed in. A key saved in Settings overrides it; clearing that field
// falls back to the built-in one.
function activeCursorKey() {
  return cursorKeyOverride || (typeof CURSOR_API_KEY === 'string' ? CURSOR_API_KEY : '');
}

// The baseline Cursor model, also from lib/config.js.
function defaultCursorModel() {
  return (typeof CURSOR_DEFAULT_MODEL === 'string' && CURSOR_DEFAULT_MODEL) || 'auto';
}

// Initialize
async function init() {
  // Load API keys and preferences
  const stored = await chrome.storage.local.get([
    'apiKey', 'supadataKey', 'model', 'provider', 'cursorModel', 'cursorApiKey'
  ]);
  apiKey = stored.apiKey || '';
  currentModel = stored.model || 'claude-sonnet-4-6';
  provider = ['anthropic', 'webhook'].includes(stored.provider) ? stored.provider : 'cursor';
  cursorModel = stored.cursorModel || defaultCursorModel();
  cursorKeyOverride = stored.cursorApiKey || '';

  // Seed the built-in Supadata key on first run. The value lives in the
  // gitignored lib/config.js rather than inline here — the same seeding also
  // runs in the service worker, so a background prep works before this panel has
  // ever been opened.
  if (!stored.supadataKey && typeof SUPADATA_API_KEY === 'string' && SUPADATA_API_KEY) {
    await chrome.storage.local.set({ supadataKey: SUPADATA_API_KEY });
  }

  // Pin this panel to the window it lives in. A side panel is per-window, and
  // every panel instance receives the same broadcast messages, so we must know
  // our own window/tab to avoid showing another window's video.
  try {
    const win = await chrome.windows.getCurrent();
    myWindowId = win?.id ?? null;
  } catch (e) {
    myWindowId = null;
  }

  await syncToActiveTab();
}

// Point the panel at whatever YouTube video is in THIS window's active tab.
// This is the single source of truth for which video the panel shows; tab
// switches, navigations, and video changes all funnel through here.
async function syncToActiveTab() {
  let tab = null;
  try {
    const query = myWindowId != null
      ? { active: true, windowId: myWindowId }
      : { active: true, currentWindow: true };
    const tabs = await chrome.tabs.query(query);
    tab = tabs[0] || null;
  } catch (e) {
    tab = null;
  }

  const url = tab?.url || '';
  const isWatch = url.includes('youtube.com/watch');
  let videoId = null;
  if (isWatch) {
    try { videoId = new URL(url).searchParams.get('v'); } catch (e) { videoId = null; }
  }

  if (isWatch && videoId) {
    // Only (re)load when the tab or the video actually changed, so focusing the
    // window or re-activating the same tab doesn't trigger a needless refetch.
    if (tab.id !== currentTabId || videoId !== currentVideoId) {
      currentTabId = tab.id;
      loadTranscript(videoId, cleanTitle(tab.title));
    }
  } else {
    // Active tab in this window isn't a YouTube watch page — clear the panel.
    currentTabId = tab?.id ?? null;
    resetToEmpty();
  }
}

// Titles YouTube shows transiently while a playlist navigates. Taking one of
// these as the video title puts "Watch later" in the header — and caches it
// alongside the transcript, so it sticks.
const PLACEHOLDER_TITLES = ['youtube', 'watch later', 'watch', ''];

function setVideoTitle(title) {
  videoTitle.textContent = title;
  hasRealTitle = true;
}

// Strip YouTube's " - YouTube" suffix from a tab/page title, and reject the
// placeholders above so the previous (or cached) title stands until the real
// one arrives.
function cleanTitle(title) {
  const cleaned = (title || '').replace(' - YouTube', '').trim();
  // "(3) Some Video" — the unread-count prefix YouTube adds to the tab title.
  const bare = cleaned.replace(/^\(\d+\)\s*/, '').trim();
  if (PLACEHOLDER_TITLES.includes(bare.toLowerCase())) return '';
  return bare;
}

// Load transcript for a specific video in the current tab. `expectedVideoId`
// is the video we believe the active tab is showing; `titleHint` is the tab's
// title, set immediately so the header never lags behind the active video.
// Results that arrive after the user has moved on (different tab or newer
// load) are discarded.
async function loadTranscript(expectedVideoId, titleHint) {
  if (!currentTabId) {
    resetToEmpty();
    return;
  }

  const reqTabId = currentTabId;
  const seq = ++loadSeq;
  // Set optimistically so overlapping triggers for the same video de-dupe.
  if (expectedVideoId) currentVideoId = expectedVideoId;
  const videoId = currentVideoId;

  // Drop the previous video's cues immediately. Otherwise a failed/slow load of
  // the new video would leave them in place, and Copy/Summarize would act on
  // (and cache a summary of) the wrong video.
  currentTranscript = null;

  // Update the header right away so the panel never shows the previous video's
  // title while the new one is still loading. An empty hint means the tab is
  // reporting a placeholder; leave the header alone and wait for the real one.
  hasRealTitle = false;
  if (titleHint) setVideoTitle(titleHint);

  showState('loading');
  // Hide any summary from the previous video while the new one loads.
  resetInsightsUI();
  // And re-collapse the transcript: opening it was a choice about the last
  // video, not a standing preference.
  transcriptContainer.classList.add('transcript-collapsed');
  document.getElementById('toggleTranscript')?.setAttribute('aria-expanded', 'false');

  // True only while this load is still the one the panel cares about.
  const isCurrent = () => seq === loadSeq && reqTabId === currentTabId;

  try {
    // 1) One fast local read for everything we cache about this video. This
    //    runs before any network call, so a previously-seen video appears
    //    almost instantly instead of waiting on the transcript fetch.
    let cached = {};
    if (videoId) {
      cached = await chrome.storage.local.get([
        STORE_PREFIX_TRANSCRIPT + videoId,
        STORE_PREFIX_INSIGHTS + videoId,
        STORE_PREFIX_STARRED + videoId
      ]);
      if (!isCurrent()) return;
    }

    // 2) Transcript: serve from cache (no Supadata request → no extra credits)
    //    or fetch it once and cache it for next time.
    const cachedTx = videoId ? cached[STORE_PREFIX_TRANSCRIPT + videoId] : null;
    if (cachedTx && Array.isArray(cachedTx.transcript) && cachedTx.transcript.length) {
      currentTranscript = cachedTx.transcript;
      // Run the cached title through the same filter: a video cached while the
      // tab said "Watch later" would otherwise keep that name forever.
      const cachedTitle = cleanTitle(cachedTx.title);
      if (cachedTitle) setVideoTitle(cachedTitle);
    } else {
      const response = await chrome.runtime.sendMessage({
        type: 'GET_TRANSCRIPT',
        tabId: reqTabId,
        videoId
      });
      if (!isCurrent()) return;

      // The tab navigated to a different video mid-fetch. Drop this result and
      // re-resolve the active tab so the new video actually loads — the SPA-nav
      // event that should have queued it may have been missed (e.g. on Retry
      // after a stale navigation). syncToActiveTab only reloads on a real
      // change, so this is safe and converges.
      if (response?.stale) { syncToActiveTab(); return; }
      if (response?.error) {
        showError(response.error);
        return;
      }
      if (!response?.transcript) {
        showError('No transcript data received');
        return;
      }
      // Defense in depth: never apply or cache a transcript that isn't for the
      // video this load is pinned to.
      if (videoId && response.videoId && response.videoId !== videoId) return;

      currentTranscript = response.transcript;
      if (!videoId && response.videoId) currentVideoId = response.videoId;
      const fetchedTitle = cleanTitle(response.title);
      if (fetchedTitle) setVideoTitle(fetchedTitle);

      // Cache the transcript so revisiting this video never re-hits Supadata.
      // Key off the id this load is pinned to, never the mutable currentVideoId.
      // Best-effort: a write failure (e.g. quota) just means we fetch again.
      const cacheId = videoId || currentVideoId;
      if (cacheId) {
        chrome.storage.local
          .set({ [STORE_PREFIX_TRANSCRIPT + cacheId]: { transcript: response.transcript, title: response.title || null } })
          .catch(() => {});
      }
    }

    renderTranscript();
    showState('transcript');

    // 3) Summary: render the cached one (no model request → no extra credits),
    //    else attach to a run the worker already has going for this video, else
    //    start one. Asking the worker first is what stops a panel opened during
    //    a background prep from kicking off a second paid run for the same video.
    const hadCachedSummary = applyCachedInsights(cached, videoId);
    if (!isCurrent()) return;

    // Ask the worker what it has going for this video even when a summary is
    // cached: a single-part rerun leaves the cache in place while replacing one
    // part of it, and without this the panel showed that stale part with an
    // active ↻ and no sign a replacement was on its way.
    const status = await chrome.runtime
      .sendMessage({ type: 'INSIGHTS_STATUS', videoId })
      .catch(() => null);
    if (!isCurrent()) return;

    if (status?.running) {
      showInsightsPending(status.progress);
      // A run that already produced a part hands it over here, so a panel
      // opened late shows the summary instead of a spinner.
      if (status.partial) applyPartialInsights(normalizeInsights(status.partial));
    } else if (status?.parts?.length && currentInsights) {
      // Reruns in flight: mark those parts pending on top of the cached summary.
      const pending = {};
      for (const part of status.parts) pending[`${part}Pending`] = true;
      currentInsights = { ...currentInsights, ...pending };
      renderInsights();
    } else if (!hadCachedSummary && canSummarize()) {
      generateInsights();
    }
  } catch (err) {
    if (!isCurrent()) return;
    showError(`Failed to load transcript: ${err.message}`);
  }
}

// Clear the panel back to the empty state (no video / non-YouTube tab).
function resetToEmpty() {
  ++loadSeq; // cancel any in-flight load
  currentTranscript = null;
  currentVideoId = null;
  videoTitle.textContent = 'Open a YouTube video';
  transcriptContent.innerHTML = '';
  resetInsightsUI();
  showState('empty');
}

// Forget the summary/stars currently on screen and hide the insights panel.
function resetInsightsUI() {
  currentInsights = null;
  awaitingSummary = false;
  // A new video starts collapsed, like a fresh panel.
  openGroups.clear();
  summaryExpanded = false;
  starred = {};
  showStarredOnly = false;
  const filterBtn = document.getElementById('starFilterBtn');
  if (filterBtn) filterBtn.classList.remove('active');
  insightsContainer.style.display = 'none';
  insightsContent.innerHTML = '';
}

// Render transcript
function renderTranscript() {
  if (!currentTranscript) return;

  const count = document.getElementById('transcriptCount');
  if (count) count.textContent = `${currentTranscript.length} lines`;

  transcriptContent.innerHTML = '';

  if (showTimestamps) {
    // Timestamped view
    currentTranscript.forEach(entry => {
      const line = document.createElement('div');
      line.className = 'transcript-line';
      line.addEventListener('click', () => seekTo(entry.startTime));

      const timestamp = document.createElement('span');
      timestamp.className = 'transcript-timestamp';
      timestamp.textContent = formatTime(entry.startTime);

      const text = document.createElement('span');
      text.className = 'transcript-text';
      text.textContent = entry.text;

      line.appendChild(timestamp);
      line.appendChild(text);
      transcriptContent.appendChild(line);
    });
  } else {
    // Plain text view
    const plainDiv = document.createElement('div');
    plainDiv.className = 'transcript-plain';
    plainDiv.textContent = currentTranscript.map(e => e.text).join(' ');
    transcriptContent.appendChild(plainDiv);
  }
}

// Format seconds to MM:SS or HH:MM:SS
function formatTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);

  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// Seek video to time. We pass our best-known tab id, but the background will
// resolve the active YouTube tab on its own if this one is stale or missing.
async function seekTo(time) {
  try {
    const result = await chrome.runtime.sendMessage({
      type: 'SEEK_VIDEO',
      tabId: currentTabId || undefined,
      time: time
    });
    // A dead click is worse than an error message — say why nothing moved.
    if (result && result.ok === false) {
      showToast(result.error || 'Could not jump to that moment', 'error');
    }
  } catch (e) {
    showToast('Could not jump to that moment', 'error');
  }
}

// Show/hide UI states
function showState(state) {
  loadingState.style.display = state === 'loading' ? 'flex' : 'none';
  errorState.style.display = state === 'error' ? 'flex' : 'none';
  emptyState.style.display = state === 'empty' ? 'flex' : 'none';
  transcriptContainer.style.display = state === 'transcript' ? 'block' : 'none';

  // Keep insights visible if they exist
  if (state !== 'transcript' && state !== 'loading') {
    insightsContainer.style.display = 'none';
  }
}

function showError(msg) {
  errorMessage.textContent = msg;
  showState('error');
}

// Copy transcript to clipboard
async function copyTranscript() {
  if (!currentTranscript) return;

  let text;
  if (showTimestamps) {
    text = currentTranscript
      .map(e => `[${formatTime(e.startTime)}] ${e.text}`)
      .join('\n');
  } else {
    text = currentTranscript.map(e => e.text).join(' ');
  }

  try {
    await navigator.clipboard.writeText(text);
    showToast('Transcript copied to clipboard!');
  } catch (err) {
    showToast('Failed to copy transcript');
  }
}

// ---- AI Summary: generated in-panel, rendered as interactive cards ----

const STORE_PREFIX_INSIGHTS = 'insights:';
const STORE_PREFIX_STARRED = 'starred:';
const STORE_PREFIX_TRANSCRIPT = 'transcript:';

// Sort sections and insights into a stable chronological order so item indices
// (used as star keys) line up with what's rendered. Idempotent.
function normalizeInsights(data) {
  if (!data) return data;
  const byTime = (a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0);
  // `sections` is the new field name; `keySections` is kept for older caches.
  if (Array.isArray(data.sections)) data.sections.sort(byTime);
  if (Array.isArray(data.keySections)) data.keySections.sort(byTime);
  if (Array.isArray(data.keyInsights)) data.keyInsights.sort(byTime);
  return data;
}

// Apply a cached summary + stars (already read alongside the transcript in
// loadTranscript) for `videoId`. Returns true if a cached summary was rendered.
function applyCachedInsights(cached, videoId) {
  resetInsightsUI();

  if (!videoId) {
    insightsContainer.style.display = 'none';
    return false;
  }

  const insights = normalizeInsights(cached[STORE_PREFIX_INSIGHTS + videoId] || null);
  if (insights) {
    currentInsights = insights;
    starred = cached[STORE_PREFIX_STARRED + videoId] || {};
    renderInsights();
    return true;
  }

  insightsContainer.style.display = 'none';
  return false;
}

function canSummarize() {
  if (provider === 'anthropic') return !!apiKey;
  // Webhook mode needs the automation credentials AND a Cursor key, because the
  // webhook token can only trigger the run — reading it back needs the API key.
  if (provider === 'webhook') {
    return !!activeCursorKey()
      && typeof CURSOR_WEBHOOK_URL === 'string' && !!CURSOR_WEBHOOK_URL
      && typeof CURSOR_WEBHOOK_AUTH === 'string' && !!CURSOR_WEBHOOK_AUTH;
  }
  return !!activeCursorKey();
}

// Model selection now happens in the service worker (it reads the same stored
// provider/model settings), so the panel no longer resolves a model itself.

// Open the insights card with a spinner and a status line. Used both when this
// panel starts a run and when it attaches to one already running in the worker.
function showInsightsPending(message) {
  awaitingSummary = true;
  // Stash before clearing, so a failure can restore it.
  if (currentInsights && !currentInsights.partialRun) {
    lastGoodInsights = currentInsights;
    lastGoodStarred = { ...starred };
  }
  // Drop whatever the last run produced. A new run replaces all three parts, so
  // leaving the old ones on screen showed a previous run's sections and
  // takeaways sitting under a "Writing the summary…" row — stale content
  // wearing a fresh run's clothes, with no way to tell which was which.
  // (A single-part rerun does NOT come through here: it keeps the other parts
  // deliberately, and marks only its own as pending.)
  currentInsights = null;
  starred = {};
  summaryExpanded = false;
  insightsContainer.style.display = 'block';
  insightsContainer.classList.remove('insights-collapsed');
  insightsLoading.style.display = 'flex';
  if (insightsLoadingText) {
    insightsLoadingText.textContent = message || 'Analyzing the video…';
  }
  const btn = document.getElementById('insightsBtn');
  if (btn) btn.disabled = true;
  // Draw the three group headers straight away, each saying it hasn't loaded
  // yet. The parts finish at very different times, and groups appearing one by
  // one made the panel jump under the reader — now the shape is fixed from the
  // first second and only the contents fill in.
  renderInsights();
}

function showInsightsError(message) {
  awaitingSummary = false;
  insightsLoading.style.display = 'none';
  const btn = document.getElementById('insightsBtn');
  if (btn) btn.disabled = false;

  const text = message === 'NO_API_KEY'
    ? 'No Anthropic API key. Add one in Settings, then press Summarize again.'
    : message === 'NO_CURSOR_KEY'
      ? 'No Cursor API key. Paste one into CURSOR_API_KEY in lib/config.js, then reload the extension.'
      : message === 'NO_WEBHOOK'
        ? 'The automation webhook is not configured. Set CURSOR_WEBHOOK_URL and CURSOR_WEBHOOK_AUTH in lib/config.js, then reload the extension.'
        : (message || 'Something went wrong generating the summary.');

  // The run that just failed had cleared the panel. Put the previous summary
  // back — it is still in the cache and still correct — and report the failure
  // as a toast rather than as a replacement for it.
  if (lastGoodInsights) {
    currentInsights = lastGoodInsights;
    starred = lastGoodStarred || {};
    lastGoodInsights = null;
    lastGoodStarred = null;
    renderInsights();
    showToast(text, 'error');
    if (message === 'NO_API_KEY') document.getElementById('settingsBtn').click();
    return;
  }

  // Nothing to fall back to: replace the pending placeholders with the reason.
  // (This clear is also what stops NO_API_KEY leaving three groups saying they
  // are still generating when no run exists at all.)
  currentInsights = null;
  insightsContent.innerHTML = '';
  const p = document.createElement('p');
  p.className = 'empty-note';
  p.textContent = text;
  insightsContent.appendChild(p);

  if (message === 'NO_API_KEY') {
    showToast('Add your Anthropic API key in Settings', 'error');
    document.getElementById('settingsBtn').click();
    return;
  }
  showToast(
    message === 'NO_CURSOR_KEY' ? 'No Cursor API key configured'
      : message === 'NO_WEBHOOK' ? 'Automation webhook not configured'
      : 'Could not generate summary',
    'error'
  );
}

// Paint a finished summary. Stars from a previous summary no longer line up with
// the new item indices, so they're cleared.
function applyInsights(insights) {
  awaitingSummary = false;
  lastGoodInsights = null;
  lastGoodStarred = null;
  insightsLoading.style.display = 'none';
  currentInsights = insights;
  starred = {};
  showStarredOnly = false;
  document.getElementById('starFilterBtn').classList.remove('active');
  renderInsights();

  const btn = document.getElementById('insightsBtn');
  if (btn) btn.disabled = false;
}

/**
 * Paint what has arrived so far while the remaining parts are still generating.
 *
 * Summary, sections and quotes are three separate runs and finish at very
 * different times, so this is called once per part that lands early. Showing
 * each as it arrives is the whole reason for the split — the reader gets the
 * summary at the point they used to still be watching a spinner. Groups that
 * have not landed show a pending row, and the Summarize button stays disabled
 * until the run is finished.
 */
function applyPartialInsights(partial) {
  if (!partial) return;

  // The spinner sits directly above the content, so while the summary itself is
  // still out it stays put — it keeps the live status and elapsed clock on
  // screen — and the parts that HAVE arrived render underneath it. Once the
  // summary lands it is replaced by the summary block.
  insightsLoading.style.display = partial.summaryPending ? 'flex' : 'none';

  // Only the FIRST partial of a run clears the stars. Later parts arrive while
  // the reader is already looking at the panel, and item ids are per-group, so
  // a star placed on an early part must survive the next part landing.
  const continuing = !!currentInsights?.partialRun;
  currentInsights = { ...partial, partialRun: true };
  if (!continuing) {
    starred = {};
    showStarredOnly = false;
    document.getElementById('starFilterBtn').classList.remove('active');
  }
  renderInsights();
}

/**
 * Ask the worker to summarize. The run itself lives in the service worker, so it
 * survives this panel being closed and the user switching tabs or windows — and
 * because the worker dedups by videoId, clicking this while a background prep is
 * already running attaches to that run instead of paying for a second one.
 *
 * Results arrive via the INSIGHTS_* broadcast below, not as the reply here.
 */
async function generateInsights({ force = false } = {}) {
  if (!currentTranscript) return;

  if (!canSummarize()) {
    showToast(
      provider === 'anthropic'
        ? 'Add your Anthropic API key in Settings to summarize'
        : provider === 'webhook'
          ? 'Set CURSOR_WEBHOOK_URL, CURSOR_WEBHOOK_AUTH and CURSOR_API_KEY in lib/config.js'
          : 'No Cursor API key — paste one into lib/config.js',
      'error'
    );
    document.getElementById('settingsBtn').click();
    return;
  }

  const reqVideoId = currentVideoId;
  showInsightsPending('Starting…');

  try {
    const res = await chrome.runtime.sendMessage({
      type: 'GENERATE_INSIGHTS',
      videoId: reqVideoId,
      transcript: currentTranscript,
      title: videoTitle.textContent || 'this video',
      // Only an explicit press regenerates; the automatic path takes whatever a
      // background prep already produced.
      force
    });

    if (reqVideoId !== currentVideoId) return;
    if (res?.error) {
      showInsightsError(res.error);
    } else if (res?.insights) {
      // A background prep finished between our cache read and this call.
      applyInsights(normalizeInsights(res.insights));
    } else {
      if (res?.progress && insightsLoadingText) insightsLoadingText.textContent = res.progress;
      if (res?.partial) applyPartialInsights(normalizeInsights(res.partial));
    }
  } catch (err) {
    if (reqVideoId !== currentVideoId) return;
    showInsightsError(err?.message);
  }
}

/**
 * Regenerate ONE part of the summary already on screen, leaving the others
 * alone. The run lives in the worker like any other, so closing the panel or
 * switching tabs doesn't abandon it.
 */
async function regeneratePart(part) {
  if (!currentVideoId || !currentInsights) return;
  if (!canSummarize()) {
    showToast('Add an API key in Settings to regenerate', 'error');
    document.getElementById('settingsBtn').click();
    return;
  }

  // Show the part as pending straight away. For the summary that means the
  // spinner returns to the top of the card; for the others, a pending row in
  // place of the group.
  currentInsights = { ...currentInsights, [`${part}Pending`]: true };
  delete currentInsights[`${part}Error`];
  delete currentInsights[`${part}Progress`];
  // Open the group being rerun: pressing ↻ on a collapsed group and seeing
  // nothing happen is indistinguishable from the button not working.
  openGroups.add(part === 'summary' ? 'summary' : part);
  if (part === 'summary' && insightsLoadingText) {
    insightsLoadingText.textContent = 'Rewriting the summary…';
  }
  renderInsights();

  const reqVideoId = currentVideoId;
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'REGENERATE_PART',
      videoId: reqVideoId,
      part,
      transcript: currentTranscript,
      title: videoTitle.textContent || 'this video'
    });
    if (reqVideoId !== currentVideoId) return;
    if (res?.error) applyPartFailure(part, res.error);
  } catch (err) {
    if (reqVideoId !== currentVideoId) return;
    applyPartFailure(part, err?.message);
  }
}

// A part run failed: stop showing it as pending and say why, in its own slot.
function applyPartFailure(part, error) {
  if (!currentInsights) return;
  const message = error === 'NO_API_KEY' ? 'No API key configured.'
    : error === 'NO_CURSOR_KEY' ? 'No Cursor API key configured.'
    : error === 'NO_WEBHOOK' ? 'The automation webhook is not configured.'
    : (error || `Could not regenerate the ${PART_LABELS[part]}.`);

  currentInsights = { ...currentInsights, [`${part}Error`]: message };
  delete currentInsights[`${part}Pending`];
  delete currentInsights[`${part}Progress`];
  renderInsights();
  showToast(`Could not regenerate the ${PART_LABELS[part]}`, 'error');
}

// Summary lifecycle from the worker. Every message carries the videoId it's for,
// so a panel showing a different video ignores it rather than painting the wrong
// summary — which is what makes background runs safe to broadcast to every panel.
chrome.runtime.onMessage.addListener((message) => {
  if (!message || !message.videoId || message.videoId !== currentVideoId) return;

  if (message.type === 'INSIGHTS_PROGRESS') {
    // Only move the spinner text if we're actually showing the spinner; a
    // rendered summary shouldn't be replaced by a stale progress line.
    if (insightsLoadingText && insightsLoading.style.display !== 'none') {
      insightsLoadingText.textContent = message.message;
    }
    return;
  }

  if (message.type === 'INSIGHTS_PARTIAL') {
    // Ignore a partial once the finished summary is already on screen — the
    // two runs can settle in either order from the panel's point of view.
    if (!awaitingSummary && currentInsights && !currentInsights.partialRun) return;
    applyPartialInsights(normalizeInsights(message.insights));
    return;
  }

  if (message.type === 'INSIGHTS_DONE') {
    applyInsights(normalizeInsights(message.insights));
    showToast('Summary ready', 'success');
    return;
  }

  if (message.type === 'INSIGHTS_ERROR') {
    showInsightsError(message.error);
    return;
  }

  // --- single-part reruns ---

  if (message.type === 'PART_PROGRESS') {
    // The whole-run spinner, when one is up (a resumed full run reports here).
    if (insightsLoadingText && insightsLoading.style.display !== 'none') {
      insightsLoadingText.textContent = message.message;
    }
    if (!currentInsights) return;

    // Live status in that part's pending row, so a slow rerun doesn't look
    // hung. This fires every poll, so update the one line in place rather than
    // rebuilding every group — a full re-render dropped the reader's text
    // selection and re-measured the summary clamp once or twice a second.
    currentInsights = { ...currentInsights, [`${message.part}Progress`]: message.message };
    const groupKey = message.part;
    const note = insightsContent
      .querySelector(`.insight-group[data-group="${groupKey}"] .pending-note`);
    if (note) note.textContent = message.message;
    else renderInsights();
    return;
  }

  if (message.type === 'PART_DONE') {
    // The worker already dropped the stars belonging to the regenerated part;
    // mirror that here so the panel doesn't keep stars pointing at gone items.
    const kinds = { sections: ['section'], quotes: ['quote'], summary: ['takeaway', 'action'] }[message.part] || [];
    for (const id of Object.keys(starred)) {
      if (kinds.some(kind => id.startsWith(`${kind}:`))) delete starred[id];
    }
    currentInsights = normalizeInsights(message.insights);
    renderInsights();
    showToast(`${PART_LABELS[message.part]} regenerated`, 'success');
    return;
  }

  if (message.type === 'PART_ERROR') {
    applyPartFailure(message.part, message.error);
  }
});

// Persist the star map for the current video.
async function saveStarred() {
  if (!currentVideoId) return;
  await chrome.storage.local.set({ [STORE_PREFIX_STARRED + currentVideoId]: starred });
}

function itemId(kind, index) {
  return `${kind}:${index}`;
}

function toggleStar(id) {
  if (starred[id]) {
    delete starred[id];
  } else {
    starred[id] = true;
  }
  saveStarred();
  renderInsights();
}

// A section counts as an ad if the model flagged it. Older caches predate the
// flag and simply come back false, which is the right default.
function isAdSection(s) {
  return s.isAd === true || s.kind === 'ad' || s.type === 'ad';
}

// Build one interactive card (section, insight, or quote).
//
// `ad` renders the row as a skippable sponsor read; `skipTo` is the next
// section's start time, i.e. where the ad ends, so the skip button lands the
// viewer on the first frame of real content again.
function buildCard({ id, timestamp, badge, title, desc, quote, ad, skipTo }) {
  const hasTs = typeof timestamp === 'number' && !isNaN(timestamp);

  const card = document.createElement('div');
  card.className = 'item-card' + (hasTs ? ' clickable' : '') + (ad ? ' is-ad' : '');
  if (hasTs) {
    card.title = 'Jump to this moment';
    // The whole row seeks; the star button stops propagation so it won't.
    card.addEventListener('click', () => seekTo(timestamp));
  }

  const main = document.createElement('div');
  main.className = 'item-main';

  const titleRow = document.createElement('div');
  titleRow.className = 'item-title-row';

  if (hasTs) {
    const ts = document.createElement('span');
    ts.className = 'ts-pill';
    ts.textContent = formatTime(timestamp);
    titleRow.appendChild(ts);
  }

  if (ad) {
    const b = document.createElement('span');
    b.className = 'badge badge-ad';
    b.textContent = 'AD';
    titleRow.appendChild(b);
  }

  if (badge) {
    const b = document.createElement('span');
    b.className = `badge importance-${badge}`;
    b.textContent = badge;
    titleRow.appendChild(b);
  }

  if (title) {
    const t = document.createElement('span');
    t.className = 'item-title';
    t.textContent = title;
    titleRow.appendChild(t);
  }

  main.appendChild(titleRow);

  if (quote) {
    const q = document.createElement('div');
    q.className = 'item-quote';
    q.textContent = `“${quote}”`;
    main.appendChild(q);
  } else if (desc) {
    const d = document.createElement('div');
    d.className = 'item-desc';
    d.textContent = desc;
    main.appendChild(d);
  }

  const star = document.createElement('button');
  star.className = 'star-btn' + (starred[id] ? ' starred' : '');
  star.textContent = starred[id] ? '★' : '☆';
  star.title = starred[id] ? 'Unstar' : 'Star';
  star.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleStar(id);
  });

  card.appendChild(main);

  // Skip lives in the right-hand control column rather than in the title row:
  // the panel is narrow, and inside the wrapping title row the button dropped
  // onto a line of its own on almost every ad.
  if (ad && typeof skipTo === 'number' && !isNaN(skipTo)) {
    const skip = document.createElement('button');
    skip.className = 'skip-btn';
    skip.textContent = `Skip ›`;
    skip.title = `Jump past this ad, to ${formatTime(skipTo)}`;
    skip.addEventListener('click', (e) => {
      e.stopPropagation();
      seekTo(skipTo);
      showToast(`Skipped the ad — jumped to ${formatTime(skipTo)}`);
    });
    card.appendChild(skip);
  }

  card.appendChild(star);
  return card;
}

const PART_LABELS = { summary: 'summary', sections: 'sections', quotes: 'quotes' };

// Which groups are open. Everything starts collapsed — the panel is a set of
// answers you go to, not a wall you scroll past — and this survives the
// re-renders that a part landing or a star toggle triggers.
const openGroups = new Set();

// Whether the reader asked to see the full summary text. The prompt caps the
// summary's length, but a model that overshoots must not be able to turn the
// panel into a wall of scrolling — the clamp below is the guarantee, and this
// remembers the choice across re-renders.
let summaryExpanded = false;

function toggleGroup(key) {
  if (openGroups.has(key)) openGroups.delete(key);
  else openGroups.add(key);
  renderInsights();
}

// The ↻ next to a group heading. Rerunning one part is cheap — one small run —
// where the Summarize button re-pays for all three and throws two good ones
// away, so each part gets its own control.
function buildRerunButton(part) {
  const btn = document.createElement('button');
  btn.className = 'rerun-btn';
  btn.textContent = '\u21bb';
  btn.title = `Regenerate the ${PART_LABELS[part]} only`;
  btn.setAttribute('aria-label', `Regenerate the ${PART_LABELS[part]}`);
  btn.addEventListener('click', (e) => {
    // The heading row toggles the group; the button must not do both.
    e.stopPropagation();
    regeneratePart(part);
  });
  return btn;
}

function canRerunPart(part) {
  if (!part || !currentInsights || showStarredOnly) return false;
  if (awaitingSummary) return false;                       // a full run owns it
  return !currentInsights[`${part}Pending`];
}

/**
 * One collapsible group: a heading row that toggles it, and a body that only
 * exists in the DOM when open.
 *
 * `key` identifies the group for open/closed state; `part` is the summary part
 * it belongs to, which decides whose ↻ appears on the row.
 */
function buildCollapsibleGroup({ key, heading, part, count, body, open, pending }) {
  // The starred-only view is already a filter down to a handful of items, so
  // leaving them behind a collapsed header would just be a second click.
  const isOpen = open ?? (showStarredOnly || openGroups.has(key));

  const group = document.createElement('div');
  group.className = 'insight-group' + (isOpen ? ' is-open' : '');
  group.dataset.group = key;

  const head = document.createElement('div');
  head.className = 'group-head';
  head.setAttribute('role', 'button');
  head.setAttribute('tabindex', '0');
  head.setAttribute('aria-expanded', String(isOpen));
  head.title = isOpen ? 'Collapse' : 'Expand';

  const chevron = document.createElement('span');
  chevron.className = 'group-chevron';
  chevron.textContent = '\u203a';
  head.appendChild(chevron);

  const h = document.createElement('h3');
  h.textContent = heading;
  head.appendChild(h);

  if (count != null) {
    const badge = document.createElement('span');
    badge.className = 'group-count';
    badge.textContent = count;
    head.appendChild(badge);
  } else if (pending) {
    // Stands where the count will be, so the header doesn't reflow when the
    // part lands — and says at a glance that this one is still coming.
    const dots = document.createElement('span');
    dots.className = 'group-count is-pending';
    dots.textContent = '···';
    head.appendChild(dots);
  }

  const spacer = document.createElement('span');
  spacer.className = 'group-spacer';
  head.appendChild(spacer);

  if (canRerunPart(part)) head.appendChild(buildRerunButton(part));

  const toggle = () => toggleGroup(key);
  head.addEventListener('click', toggle);
  head.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
  });

  group.appendChild(head);
  if (isOpen && body) {
    const bodyEl = document.createElement('div');
    bodyEl.className = 'group-body';
    body.forEach(node => bodyEl.appendChild(node));
    group.appendChild(bodyEl);
  }
  return group;
}

// A row that stands in for a part while it generates, or explains why it is
// missing. Lives INSIDE its group so a rerun never leaves the old content
// sitting above a "building this now" line.
function emptyRow(text) {
  const note = document.createElement('p');
  note.className = 'empty-note';
  note.textContent = text;
  return note;
}

function partStatusRow({ pending, pendingText, error }) {
  if (!pending && !error) return null;
  const note = document.createElement('p');
  note.className = pending ? 'pending-note' : 'empty-note';
  note.textContent = pending ? pendingText : error;
  return note;
}

// Render the current insights object into the panel.
//
// Order is deliberate: Sections first (the index you navigate with), then
// Summary (the long read, with its takeaways), then Quotes. Each is collapsed
// until opened, so the panel opens as three lines rather than a wall of text.
function renderInsights() {
  // Runs before anything has arrived too, so the groups exist from the start.
  if (!currentInsights && !awaitingSummary) return;

  // The spinner at the top is the whole-run indicator and carries the clock.
  // Individual parts say for themselves whether they have landed.
  insightsLoading.style.display = awaitingSummary ? 'flex' : 'none';
  insightsContainer.style.display = 'block';
  insightsContent.innerHTML = '';

  const data = currentInsights || {};
  const showAll = !showStarredOnly;
  const include = (id) => showAll || starred[id];

  // A part is pending if it is being regenerated, or if a run is going and it
  // simply has not arrived yet.
  const HAS_LANDED = {
    sections: d => Array.isArray(d.sections) || Array.isArray(d.keySections),
    summary: d => typeof d.summary === 'string' && d.summary.length > 0,
    quotes: d => Array.isArray(d.notableQuotes)
  };
  const isPending = part =>
    data[`${part}Pending`] === true || (awaitingSummary && !HAS_LANDED[part](data));

  // ---- Sections: the navigation index ----
  // `sections` is the chapter-by-chapter breakdown; `keySections` is the old
  // field name, kept for summaries cached before the rename.
  const sectionsPending = isPending('sections');
  const sections = data.sections || data.keySections || [];
  const sectionCards = sectionsPending ? [] : sections.map((s, i) => {
    const id = itemId('section', i);
    if (!include(id)) return null;
    const ad = isAdSection(s);
    return buildCard({
      id,
      timestamp: s.timestamp,
      title: s.title,
      desc: s.description,
      ad,
      // Where the ad ends: the next section starts exactly there. A trailing ad
      // has nowhere to skip to, so the button is simply omitted.
      skipTo: ad ? sections[i + 1]?.timestamp : undefined
    });
  }).filter(Boolean);

  // A regenerating part shows ONLY its status row. Leaving the old cards up
  // under a "building this now" line was the glitch: two answers on screen at
  // once, and stars pointing at items that were about to be replaced.
  const sectionStatus = partStatusRow({
    pending: sectionsPending,
    pendingText: data.sectionsProgress || 'Building the section list…',
    error: data.sectionsError
  });
  const sectionBody = sectionStatus ? [sectionStatus, ...sectionCards] : sectionCards;
  // Always drawn, even empty: the reader should see the same three groups from
  // the first second, filling in rather than appearing. The exception is the
  // starred view, where an empty group means "nothing starred here" — saying
  // "No sections were returned" there would be plainly false.
  if (showAll || sectionCards.length) {
    insightsContent.appendChild(buildCollapsibleGroup({
      key: 'sections',
      heading: 'Sections',
      part: 'sections',
      count: sectionsPending ? null : (sectionCards.length || null),
      pending: sectionsPending,
      body: sectionBody.length ? sectionBody : [emptyRow('No sections were returned.')]
    }));
  }

  // ---- Summary: the long read, plus the takeaways from the same run ----
  const summaryPending = isPending('summary');
  const summaryBody = [];
  if (showAll && !summaryPending && (data.tldr || data.summary)) {
    const block = document.createElement('div');
    block.className = 'summary-block';
    if (data.contentType) {
      const ct = document.createElement('span');
      ct.className = 'content-type';
      ct.textContent = data.contentType;
      block.appendChild(ct);
    }
    if (data.tldr) {
      const tldr = document.createElement('div');
      tldr.className = 'tldr';
      tldr.textContent = data.tldr;
      block.appendChild(tldr);
    }
    if (data.summary) {
      const text = document.createElement('div');
      text.className = 'summary-text' + (summaryExpanded ? '' : ' is-clamped');
      text.textContent = data.summary;
      block.appendChild(text);

      // Only offered when the text is actually cut off — measured after the
      // group is in the DOM, further down.
      const more = document.createElement('button');
      more.className = 'show-more-btn';
      more.textContent = summaryExpanded ? 'Show less' : 'Show more';
      more.style.display = 'none';
      more.addEventListener('click', (e) => {
        e.stopPropagation();
        summaryExpanded = !summaryExpanded;
        renderInsights();
      });
      block.appendChild(more);
    }
    summaryBody.push(block);
  }

  // Key takeaways come from the summary run, so they live under it.
  const takeawayCards = summaryPending ? [] : (data.keyTakeaways || []).map((t, i) => {
    const id = itemId('takeaway', i);
    return include(id)
      ? buildCard({ id, timestamp: t.timestamp, title: t.point, desc: t.detail })
      : null;
  }).filter(Boolean);
  if (takeawayCards.length) {
    const label = document.createElement('h4');
    label.className = 'subgroup-label';
    label.textContent = 'Key takeaways';
    summaryBody.push(label, ...takeawayCards);
  }

  // What to actually do about it — the practical residue of the video, from
  // the same run as the summary.
  const actionCards = summaryPending ? [] : (data.actionItems || []).map((a, i) => {
    const id = itemId('action', i);
    return include(id)
      ? buildCard({ id, timestamp: a.timestamp, title: a.action, desc: a.detail })
      : null;
  }).filter(Boolean);
  if (actionCards.length) {
    const label = document.createElement('h4');
    label.className = 'subgroup-label';
    label.textContent = 'What to do';
    summaryBody.push(label, ...actionCards);
  }

  // Legacy field from summaries cached before it was dropped.
  const insightCards = (data.keyInsights || []).map((it, i) => {
    const id = itemId('insight', i);
    return include(id)
      ? buildCard({ id, timestamp: it.timestamp, title: it.insight, desc: it.detail })
      : null;
  }).filter(Boolean);
  if (insightCards.length) summaryBody.push(...insightCards);

  const summaryStatus = partStatusRow({
    pending: summaryPending,
    pendingText: data.summaryProgress || 'Writing the summary…',
    error: data.summaryError
  });
  if (summaryStatus) summaryBody.unshift(summaryStatus);
  if (showAll || summaryBody.length) {
    insightsContent.appendChild(buildCollapsibleGroup({
      key: 'summary',
      heading: 'Summary',
      part: 'summary',
      count: summaryPending ? null : ((takeawayCards.length + actionCards.length) || null),
      pending: summaryPending,
      body: summaryBody.length ? summaryBody : [emptyRow('No summary was returned.')]
    }));
  }

  // Now that it is laid out, show the toggle only if the clamp is hiding
  // something. A summary that already fits gets no button at all.
  const summaryText = insightsContent.querySelector('.summary-text');
  const showMore = insightsContent.querySelector('.show-more-btn');
  if (summaryText && showMore) {
    const clipped = summaryText.scrollHeight > summaryText.clientHeight + 4;
    showMore.style.display = (clipped || summaryExpanded) ? 'inline-block' : 'none';
  }

  // ---- Quotes ----
  const quotesPending = isPending('quotes');
  const quoteCards = quotesPending ? [] : (data.notableQuotes || []).map((q, i) => {
    const id = itemId('quote', i);
    return include(id) ? buildCard({ id, timestamp: q.timestamp, quote: q.quote }) : null;
  }).filter(Boolean);
  const quoteStatus = partStatusRow({
    pending: quotesPending,
    pendingText: data.quotesProgress || 'Pulling the quotes…',
    error: data.quotesError
  });
  const quoteBody = quoteStatus ? [quoteStatus, ...quoteCards] : quoteCards;
  if (showAll || quoteCards.length) {
    insightsContent.appendChild(buildCollapsibleGroup({
      key: 'quotes',
      heading: 'Notable Quotes',
      part: 'quotes',
      count: quotesPending ? null : (quoteCards.length || null),
      pending: quotesPending,
      body: quoteBody.length ? quoteBody : [emptyRow('No quotes were pulled from this transcript.')]
    }));
  }

  if (showStarredOnly && !insightsContent.querySelector('.item-card')) {
    const note = document.createElement('p');
    note.className = 'empty-note';
    note.textContent = 'No starred items yet. Tap the ☆ on any item to save it here.';
    insightsContent.appendChild(note);
  }
}

// Toast notification
function showToast(message, type = '') {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => toast.remove(), 3000);
}

// Event Listeners

// Toggle view
document.getElementById('timestampedBtn').addEventListener('click', () => {
  showTimestamps = true;
  document.getElementById('timestampedBtn').classList.add('active');
  document.getElementById('plainBtn').classList.remove('active');
  renderTranscript();
});

document.getElementById('plainBtn').addEventListener('click', () => {
  showTimestamps = false;
  document.getElementById('plainBtn').classList.add('active');
  document.getElementById('timestampedBtn').classList.remove('active');
  renderTranscript();
});

// Copy
document.getElementById('copyBtn').addEventListener('click', copyTranscript);

// Summarize (generate in-panel)
// Pressing the button is an explicit ask, so it regenerates even when a summary
// is already cached.
document.getElementById('insightsBtn').addEventListener('click', () => generateInsights({ force: true }));

// Toggle insights collapse (ignore clicks on the star-filter chip)
document.getElementById('insightsHeader').addEventListener('click', (e) => {
  if (e.target.closest('#starFilterBtn')) return;
  insightsContainer.classList.toggle('insights-collapsed');
});

// The transcript is collapsed on load and opens from its own header. The raw
// cues are reference material — you go looking for them, they don't greet you.
document.getElementById('transcriptHeader').addEventListener('click', () => {
  const collapsed = transcriptContainer.classList.toggle('transcript-collapsed');
  document.getElementById('toggleTranscript').setAttribute('aria-expanded', String(!collapsed));
});

// Show only starred items
document.getElementById('starFilterBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  showStarredOnly = !showStarredOnly;
  document.getElementById('starFilterBtn').classList.toggle('active', showStarredOnly);
  renderInsights();
});

// Settings
const providerSelect = document.getElementById('providerSelect');
const cursorModelSelect = document.getElementById('cursorModelSelect');
const cursorKeyStatus = document.getElementById('cursorKeyStatus');
const cursorApiKeyInput = document.getElementById('cursorApiKeyInput');

// Show only the fields that matter for the selected provider.
function syncProviderFields() {
  const v = providerSelect.value;
  // Webhook mode still uses the Cursor key (to poll the run it creates), so it
  // shows the Cursor block too — but the model comes from the automation, so the
  // model picker is hidden to avoid implying it has any effect here.
  const usesCursor = v === 'cursor' || v === 'webhook';
  document.getElementById('anthropicSettings').style.display = v === 'anthropic' ? 'block' : 'none';
  document.getElementById('cursorSettings').style.display = usesCursor ? 'block' : 'none';

  const modelRow = document.getElementById('cursorModelRow');
  if (modelRow) modelRow.style.display = v === 'webhook' ? 'none' : 'block';
  const note = document.getElementById('webhookNote');
  if (note) note.style.display = v === 'webhook' ? 'block' : 'none';
}

// Pull the live model list from the key's Cursor account. Keeping the <select>
// populated from GET /v1/models (rather than hardcoded) is what lets new Cursor
// models appear here without an extension update.
async function loadCursorModels({ silent } = {}) {
  // Use whatever is typed in the override box right now, so the user can test a
  // key before saving; blank falls back to the key baked into lib/config.js.
  const key = (cursorApiKeyInput.value || '').trim() || activeCursorKey();

  if (!key) {
    cursorKeyStatus.textContent =
      'No Cursor API key. Paste one into CURSOR_API_KEY in lib/config.js, or enter one below.';
    if (!silent) showToast('No Cursor API key configured', 'error');
    return;
  }

  cursorKeyStatus.textContent = 'Checking your Cursor key…';
  try {
    const [me, models] = await Promise.all([checkCursorKey(key), getCursorModels(key)]);

    // Prefer an in-session pick, but before the list has ever loaded the select
    // only holds 'auto' — fall back to the saved preference so it isn't lost.
    const previous = cursorModelSelect.options.length > 1
      ? (cursorModelSelect.value || cursorModel)
      : cursorModel;
    cursorModelSelect.innerHTML = '';
    const auto = document.createElement('option');
    auto.value = 'auto';
    auto.textContent = 'Auto (Cursor picks)';
    cursorModelSelect.appendChild(auto);

    for (const m of models) {
      if (m.value === 'auto') continue;
      const opt = document.createElement('option');
      opt.value = m.value;
      opt.textContent = m.label && m.label !== m.value ? `${m.label} — ${m.value}` : m.value;
      cursorModelSelect.appendChild(opt);
    }

    // Keep the saved choice if Cursor still offers it. The comparison goes
    // through canonicalCursorModelSpec so a flat id like
    // 'cursor-grok-4.6-low-fast' still matches the variant entry the API lists
    // it under, instead of silently resetting to Auto.
    const target = await canonicalCursorModelSpec(key, previous).catch(() => previous);
    cursorModelSelect.value =
      [...cursorModelSelect.options].some(o => o.value === target) ? target : 'auto';

    const account = me?.account || '';
    cursorKeyStatus.textContent =
      `Key valid — ${models.length} models available${account ? ` (${account})` : ''}.`;
  } catch (err) {
    cursorKeyStatus.textContent =
      err.message === 'NO_CURSOR_KEY'
        ? 'No Cursor API key. Paste one into CURSOR_API_KEY in lib/config.js.'
        : err.message;
    if (!silent) showToast('Could not reach the Cursor API', 'error');
  }
}

document.getElementById('settingsBtn').addEventListener('click', async () => {
  const stored = await chrome.storage.local.get(['supadataKey', 'autoSummarize']);
  document.getElementById('supadataKeyInput').value = stored.supadataKey || '';
  // Absent means on — matches the worker's `!== false` default.
  document.getElementById('autoSummarizeInput').checked = stored.autoSummarize !== false;
  apiKeyInput.value = apiKey;
  cursorApiKeyInput.value = cursorKeyOverride;
  document.getElementById('modelSelect').value = currentModel;
  providerSelect.value = provider;
  syncProviderFields();
  settingsModal.style.display = 'flex';

  if (provider === 'cursor' || provider === 'webhook') loadCursorModels({ silent: true });
});

providerSelect.addEventListener('change', () => {
  syncProviderFields();
  // Fetch the list the first time Cursor mode is opened, so the dropdown isn't
  // just "Auto" while the user is looking at it.
  if (providerSelect.value === 'cursor' && cursorModelSelect.options.length <= 1) {
    loadCursorModels({ silent: true });
  }
});

document.getElementById('refreshCursorModels').addEventListener('click', () => {
  loadCursorModels();
});

document.getElementById('closeSettings').addEventListener('click', () => {
  settingsModal.style.display = 'none';
});

document.getElementById('cancelSettings').addEventListener('click', () => {
  settingsModal.style.display = 'none';
});

document.getElementById('saveSettings').addEventListener('click', async () => {
  apiKey = apiKeyInput.value.trim();
  const supadataKey = document.getElementById('supadataKeyInput').value.trim();
  currentModel = document.getElementById('modelSelect').value;
  provider = ['anthropic', 'webhook'].includes(providerSelect.value) ? providerSelect.value : 'cursor';
  cursorModel = cursorModelSelect.value || defaultCursorModel();
  cursorKeyOverride = cursorApiKeyInput.value.trim();
  const autoSummarize = document.getElementById('autoSummarizeInput').checked;
  await chrome.storage.local.set({
    apiKey, supadataKey, model: currentModel, provider, cursorModel,
    cursorApiKey: cursorKeyOverride, autoSummarize
  });
  settingsModal.style.display = 'none';
  showToast('Settings saved!', 'success');

  // If the provider is now usable and a transcript is loaded with no summary
  // yet, start it now — same auto-generate behavior as a fresh transcript load.
  if (canSummarize() && currentTranscript && !currentInsights) {
    generateInsights();
  }
});

// Close modal on overlay click
settingsModal.addEventListener('click', (e) => {
  if (e.target === settingsModal) {
    settingsModal.style.display = 'none';
  }
});

// Retry — reload the current video's transcript. If the tab has since navigated
// away, loadTranscript's stale path re-resolves the active tab.
document.getElementById('retryBtn').addEventListener('click', () => {
  loadTranscript(currentVideoId);
});

// Listen for in-page (SPA) video changes reported by the content script.
// CRITICAL: this message is broadcast to EVERY open side panel, so we must
// ignore any update that isn't for the tab this panel is currently showing —
// otherwise a video changing in another tab/window would hijack this panel.
chrome.runtime.onMessage.addListener((message) => {
  if (message.type !== 'VIDEO_UPDATED') return;
  if (message.tabId == null || message.tabId !== currentTabId) return;

  const incomingTitle = cleanTitle(message.title);

  if (message.videoId && message.videoId === currentVideoId) {
    // Same video, so nothing to reload — but the title often arrives after the
    // navigation, and this is the only place it turns up.
    if (incomingTitle && !hasRealTitle) setVideoTitle(incomingTitle);
    return;
  }

  loadTranscript(message.videoId || null, incomingTitle || null);
});

// When the user switches tabs within THIS window, follow along.
chrome.tabs.onActivated.addListener((activeInfo) => {
  if (myWindowId != null && activeInfo.windowId !== myWindowId) return;
  syncToActiveTab();
});

// When this panel's active tab navigates (full reload or URL change to a new
// video), re-sync. Ignored for any other tab.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId !== currentTabId) return;
  if (!changeInfo.url && changeInfo.status !== 'complete') return;
  syncToActiveTab();
});

// If our active tab is closed, fall back to whatever is now active here.
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === currentTabId) syncToActiveTab();
});

// Initialize
init();
