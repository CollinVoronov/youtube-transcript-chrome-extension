// State
let currentTranscript = null;
let currentTabId = null;
let showTimestamps = true;

// DOM Elements
const videoTitle = document.getElementById('videoTitle');
const loadingState = document.getElementById('loadingState');
const errorState = document.getElementById('errorState');
const errorMessage = document.getElementById('errorMessage');
const emptyState = document.getElementById('emptyState');
const transcriptContainer = document.getElementById('transcriptContainer');
const transcriptContent = document.getElementById('transcriptContent');
const settingsModal = document.getElementById('settingsModal');
const apiKeyInput = document.getElementById('apiKeyInput');

// Initialize
async function init() {
  const stored = await chrome.storage.local.get(['apiKey', 'supadataKey']);

  // Auto-save Supadata key if not set
  if (!stored.supadataKey) {
    await chrome.storage.local.set({ supadataKey: 'sd_da181bddc28a1c9344b415a11169e55e' });
  }

  // Get active tab
  const response = await chrome.runtime.sendMessage({ type: 'GET_ACTIVE_TAB' });
  if (response?.tabId && response?.url?.includes('youtube.com/watch')) {
    currentTabId = response.tabId;
    loadTranscript();
  }
}

// Load transcript for current video
async function loadTranscript() {
  if (!currentTabId) return;

  showState('loading');

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'GET_TRANSCRIPT',
      tabId: currentTabId
    });

    if (response?.error) {
      showError(response.error);
      return;
    }

    if (response?.transcript) {
      currentTranscript = response.transcript;
      videoTitle.textContent = response.title || 'YouTube Video';
      renderTranscript();
      showState('transcript');
    } else {
      showError('No transcript data received');
    }
  } catch (err) {
    showError(`Failed to load transcript: ${err.message}`);
  }
}

// Render transcript
function renderTranscript() {
  if (!currentTranscript) return;

  transcriptContent.innerHTML = '';

  if (showTimestamps) {
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

// Seek video to time
function seekTo(time) {
  if (!currentTabId) return;
  chrome.runtime.sendMessage({
    type: 'SEEK_VIDEO',
    tabId: currentTabId,
    time: time
  });
}

// Show/hide UI states
function showState(state) {
  loadingState.style.display = state === 'loading' ? 'flex' : 'none';
  errorState.style.display = state === 'error' ? 'flex' : 'none';
  emptyState.style.display = state === 'empty' ? 'flex' : 'none';
  transcriptContainer.style.display = state === 'transcript' ? 'block' : 'none';
}

function showError(msg) {
  if (msg.startsWith('RATE_LIMIT:')) {
    errorMessage.innerHTML = msg.replace('RATE_LIMIT: ', '')
      .replace('supadata.ai', '<a href="https://supadata.ai/pricing" target="_blank" style="color: #3ea6ff; text-decoration: underline;">supadata.ai</a>');
  } else {
    errorMessage.textContent = msg;
  }
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

  let copied = false;
  try {
    await navigator.clipboard.writeText(text);
    copied = true;
  } catch (e) {
    try {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      copied = document.execCommand('copy');
      document.body.removeChild(textarea);
    } catch (e2) { copied = false; }
  }

  showToast(copied ? 'Transcript copied!' : 'Failed to copy', copied ? 'success' : '');
}

// Get AI insights — copies prompt + transcript to clipboard, opens Claude.ai
async function fetchInsights() {
  if (!currentTranscript) return;

  const title = videoTitle.textContent || 'this video';

  let transcriptText;
  if (showTimestamps) {
    transcriptText = currentTranscript
      .map(e => `[${formatTime(e.startTime)}] ${e.text}`)
      .join('\n');
  } else {
    transcriptText = currentTranscript.map(e => e.text).join(' ');
  }

  const hasTimestamps = showTimestamps;
  const timestampNote = hasTimestamps
    ? `The transcript below includes timestamps in [M:SS] or [H:MM:SS] format. Reference specific timestamps when citing moments, claims, or quotes so the viewer can jump directly to them.`
    : `No timestamps are available for this transcript.`;

  const prompt = `You are an expert content analyst. Below is the full transcript of a YouTube video titled "${title}".

${timestampNote}

First, identify what TYPE of content this is (tutorial, interview/podcast, lecture, review, opinion piece, vlog, documentary, etc.) and adapt your analysis accordingly -- a coding tutorial needs different treatment than a philosophical debate.

Then produce ALL of the following sections:

---

## 1. Executive Summary
2-3 sentences: What is this video about at the highest level? What is the speaker's core thesis, argument, or purpose? Write this so someone can decide in 10 seconds whether the full analysis is worth reading.

## 2. Key Insights & Takeaways
Extract the 5-10 most important ideas, ranked by significance. For each:
- **State the insight clearly in one bold sentence**
- Add 1-2 sentences of supporting context, evidence, or nuance from the transcript${hasTimestamps ? '\n- Reference the timestamp range where this is discussed, e.g. [3:22]-[5:10]' : ''}

Prioritize non-obvious insights over surface-level observations. What would someone miss if they only skimmed? What surprised you?

## 3. Actionable Next Steps
What can the viewer actually DO with this information? List 3-7 concrete, specific actions.
- Be specific: not "think about your goals" but "Write down 3 goals using the [specific framework] mentioned"
- If the video is purely informational/entertainment with no actionable content, replace this section with "## Key Arguments" summarizing the main positions taken

## 4. Video Structure & Topic Map
Outline the video's structure showing how it flows:${hasTimestamps ? '\n- Include timestamp ranges for each major section so the viewer can navigate directly' : ''}
- Show how topics build on or connect to each other
- Flag which sections are highest-value (worth watching) vs. skippable

## 5. Notable Quotes & Moments
Surface 3-5 verbatim quotes that are:
- Particularly well-stated, memorable, or shareable
- Surprising, contrarian, or counter-intuitive
- Central to the speaker's core argument${hasTimestamps ? '\n- Include the exact timestamp for each' : ''}

If the transcript quality makes exact quoting unreliable, paraphrase and note it.

## 6. Critical Analysis
Go beyond summarizing -- think critically:
- What assumptions does the speaker make (stated or unstated)?
- What counterarguments, limitations, or caveats are NOT addressed?
- What related ideas or opposing viewpoints would strengthen or challenge this content?
- Rate the overall quality: Is this worth watching, or is the summary sufficient?

## 7. One-Sentence Takeaway
If the viewer remembers only ONE thing from this video, what should it be? Make it punchy and memorable.

---

TRANSCRIPT:
${transcriptText}`;

  let copied = false;
  try {
    await navigator.clipboard.writeText(prompt);
    copied = true;
  } catch (e) {
    try {
      const textarea = document.createElement('textarea');
      textarea.value = prompt;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      copied = document.execCommand('copy');
      document.body.removeChild(textarea);
    } catch (e2) { copied = false; }
  }

  if (copied) {
    showToast('Prompt copied! Paste in Claude (Cmd+V)', 'success');
    setTimeout(() => {
      chrome.tabs.create({ url: 'https://claude.ai/new' });
    }, 500);
  } else {
    showToast('Failed to copy prompt');
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

document.getElementById('copyBtn').addEventListener('click', copyTranscript);
document.getElementById('insightsBtn').addEventListener('click', fetchInsights);

// Settings
document.getElementById('settingsBtn').addEventListener('click', async () => {
  const stored = await chrome.storage.local.get(['supadataKey', 'apiKey']);
  document.getElementById('supadataKeyInput').value = stored.supadataKey || '';
  apiKeyInput.value = stored.apiKey || '';
  settingsModal.style.display = 'flex';
});

document.getElementById('closeSettings').addEventListener('click', () => {
  settingsModal.style.display = 'none';
});

document.getElementById('cancelSettings').addEventListener('click', () => {
  settingsModal.style.display = 'none';
});

document.getElementById('saveSettings').addEventListener('click', async () => {
  const supadataKey = document.getElementById('supadataKeyInput').value.trim();
  const apiKey = apiKeyInput.value.trim();
  await chrome.storage.local.set({ apiKey, supadataKey });
  settingsModal.style.display = 'none';
  showToast('Settings saved!', 'success');
});

settingsModal.addEventListener('click', (e) => {
  if (e.target === settingsModal) settingsModal.style.display = 'none';
});

document.getElementById('retryBtn').addEventListener('click', loadTranscript);

// Initialize
init();
