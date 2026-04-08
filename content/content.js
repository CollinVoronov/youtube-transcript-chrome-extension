// Detect YouTube SPA navigations and notify background worker

let currentVideoId = null;

function getVideoId() {
  const params = new URLSearchParams(window.location.search);
  return params.get('v');
}

function getVideoTitle() {
  return document.title.replace(' - YouTube', '');
}

function notifyVideoChanged() {
  const videoId = getVideoId();
  if (videoId && videoId !== currentVideoId) {
    currentVideoId = videoId;
    chrome.runtime.sendMessage({
      type: 'VIDEO_CHANGED',
      videoId: videoId,
      title: getVideoTitle()
    }).catch(() => {});
  }
}

// Listen for YouTube's SPA navigation event
document.addEventListener('yt-navigate-finish', () => {
  notifyVideoChanged();
});

// Backup: MutationObserver on title
const titleObserver = new MutationObserver(() => {
  if (window.location.pathname === '/watch') {
    notifyVideoChanged();
  }
});

const titleEl = document.querySelector('title');
if (titleEl) {
  titleObserver.observe(titleEl, { childList: true });
}

// Listen for messages from background/sidepanel
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'SEEK_TO') {
    const video = document.querySelector('video');
    if (video) {
      video.currentTime = message.time;
      video.play();
    }
  }

  if (message.type === 'GET_VIDEO_INFO') {
    sendResponse({
      videoId: getVideoId(),
      title: getVideoTitle()
    });
    return true;
  }
});

// Initial check
if (window.location.pathname === '/watch') {
  setTimeout(notifyVideoChanged, 1000);
}
