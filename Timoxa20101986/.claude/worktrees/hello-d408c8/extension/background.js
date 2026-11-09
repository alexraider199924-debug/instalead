const API_BASE = 'http://localhost:3001/api';

let state = {
  running: false,
  paused: false,
  currentItem: null,
  igUsername: null,
  igDetectedAt: null,
  stats: { sent: 0, failed: 0, total: 0 }
};

async function saveState() {
  await chrome.storage.local.set({ iwState: state });
}

async function loadState() {
  const data = await chrome.storage.local.get('iwState');
  if (data.iwState) state = { ...state, ...data.iwState };
}

loadState();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_STATE') {
    sendResponse(state);
    return;
  }

  if (msg.type === 'IG_ACCOUNT') {
    const username = msg.username;
    if (username && username !== state.igUsername) {
      state.igUsername = username;
      state.igDetectedAt = Date.now();
      saveState();
      // Report to backend
      fetch(`${API_BASE}/extension/account`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username })
      }).catch(() => {});
    }
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === 'START') {
    state.running = true;
    state.paused = false;
    saveState();
    chrome.alarms.create('processQueue', { when: Date.now() + 1000 });
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === 'PAUSE') {
    state.running = false;
    state.paused = true;
    chrome.alarms.clear('processQueue');
    saveState();
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === 'RESET') {
    state = {
      running: false, paused: false, currentItem: null,
      igUsername: state.igUsername, igDetectedAt: state.igDetectedAt,
      stats: { sent: 0, failed: 0, total: 0 }
    };
    chrome.alarms.clear('processQueue');
    saveState();
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === 'ITEM_SENT') {
    markSent(msg.cl_id, msg.message);
    return;
  }

  if (msg.type === 'ITEM_FAILED') {
    markFailed(msg.cl_id, msg.error);
    return;
  }
});

// When Instagram tab loads/updates, inject content script to detect username
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url?.includes('instagram.com')) {
    chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js']
    }).catch(() => {});
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'processQueue') return;
  if (!state.running) return;
  await processNext();
});

async function processNext() {
  try {
    const res = await fetch(`${API_BASE}/extension/queue`);
    const data = await res.json();

    if (!data.item) {
      state.currentItem = null;
      await saveState();
      notifyPopup({ type: 'IDLE', message: data.message });
      chrome.alarms.create('processQueue', { when: Date.now() + 10000 });
      return;
    }

    state.currentItem = data.item;
    state.stats.total++;
    await saveState();

    const igUrl = `https://www.instagram.com/direct/new/?username=${data.item.username}`;
    const tabs = await chrome.tabs.query({ url: 'https://www.instagram.com/*' });
    let tab;

    if (tabs.length > 0) {
      tab = tabs[0];
      await chrome.tabs.update(tab.id, { url: igUrl, active: true });
    } else {
      tab = await chrome.tabs.create({ url: igUrl, active: true });
    }

    await waitForTabLoad(tab.id);

    await chrome.tabs.sendMessage(tab.id, {
      type: 'SEND_DM',
      item: data.item
    });

  } catch (e) {
    console.error('[BG] processNext error:', e);
    if (state.currentItem) {
      await markFailed(state.currentItem.cl_id, e.message);
    }
    if (state.running) {
      chrome.alarms.create('processQueue', { when: Date.now() + 5000 });
    }
  }
}

function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    const listener = (updatedTabId, info) => {
      if (updatedTabId === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(resolve, 3000);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 15000);
  });
}

async function markSent(cl_id, message) {
  try {
    await fetch(`${API_BASE}/extension/confirm/${cl_id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message })
    });
    state.stats.sent++;
    const delay = (state.currentItem?.delay_seconds || 30) * 1000;
    state.currentItem = null;
    await saveState();
    notifyPopup({ type: 'SENT', cl_id });
    if (state.running) {
      chrome.alarms.create('processQueue', { when: Date.now() + delay });
    }
  } catch (e) {
    console.error('[BG] markSent error:', e);
  }
}

async function markFailed(cl_id, error_message) {
  try {
    await fetch(`${API_BASE}/extension/fail/${cl_id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error_message })
    });
    state.stats.failed++;
    state.currentItem = null;
    await saveState();
    notifyPopup({ type: 'FAILED', cl_id, error: error_message });
    if (state.running) {
      chrome.alarms.create('processQueue', { when: Date.now() + 5000 });
    }
  } catch (e) {
    console.error('[BG] markFailed error:', e);
  }
}

function notifyPopup(data) {
  chrome.runtime.sendMessage({ ...data, source: 'background' }).catch(() => {});
}
