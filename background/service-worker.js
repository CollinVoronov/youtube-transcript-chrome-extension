// Message routing
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_TRANSCRIPT') {
    handleGetTranscript(message.tabId || sender.tab?.id).then(sendResponse);
    return true; // async response
  }

  if (message.type === 'SEEK_VIDEO') {
    chrome.tabs.sendMessage(message.tabId, {
      type: 'SEEK_TO',
      time: message.time
    });
  }

  if (message.type === 'VIDEO_CHANGED') {
    chrome.runtime.sendMessage({
      type: 'VIDEO_UPDATED',
      videoId: message.videoId,
      title: message.title
    }).catch(() => {});
  }

  if (message.type === 'GET_ACTIVE_TAB') {
    chrome.tabs.query({ active: true, currentWindow: true }).then(tabs => {
      sendResponse({ tabId: tabs[0]?.id, url: tabs[0]?.url });
    });
    return true;
  }
});

async function handleGetTranscript(tabId) {
  if (!tabId) return { error: 'No active tab' };

  try {
    // Get video ID and title from tab
    const tab = await chrome.tabs.get(tabId);
    const tabUrl = new URL(tab.url);
    const videoId = tabUrl.searchParams.get('v');
    if (!videoId) return { error: 'No video ID found in URL' };

    // Get Supadata API key from storage
    const stored = await chrome.storage.local.get(['supadataKey']);
    const supadataKey = stored.supadataKey;
    if (!supadataKey) {
      return { error: 'Please set your Supadata API key in Settings (gear icon). Get a free key at supadata.ai' };
    }

    // Fetch transcript via Supadata API
    const resp = await fetch(
      'https://api.supadata.ai/v1/youtube/transcript?videoId=' + videoId,
      { headers: { 'x-api-key': supadataKey } }
    );

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      if (resp.status === 401 || resp.status === 403) {
        return { error: 'Invalid Supadata API key. Check Settings.' };
      }
      if (resp.status === 429) {
        return { error: 'RATE_LIMIT: You\'ve reached your monthly transcript limit. Upgrade your plan at supadata.ai to continue.' };
      }
      return { error: 'Supadata API error (HTTP ' + resp.status + '): ' + errText.substring(0, 200) };
    }

    const data = await resp.json();

    // Supadata returns { content: [{ text, offset, duration, lang }] } or similar
    let items = Array.isArray(data) ? data : data.content || data.transcript || data.results || [];

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

    // Get title from the tab
    const title = tab.title?.replace(' - YouTube', '').trim() || 'YouTube Video';

    return { transcript, title };
  } catch (err) {
    return { error: err.message || 'Unknown error fetching transcript' };
  }
}
