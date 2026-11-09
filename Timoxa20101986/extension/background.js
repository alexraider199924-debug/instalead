const API_BASE_LOCAL = 'http://localhost:5173/api';
const API_BASE_BACKEND = 'http://localhost:3002/api';
const API_BASE_PROD = 'https://instalead.ru/api';
let BASE_URL = API_BASE_LOCAL;
let currentWorkspace = 'default';
let extensionDeviceToken = '';
let keepAliveInterval = null;
const DEVICE_TOKEN_KEY = 'iwDeviceToken';
const CONTENT_SCRIPT_VERSION = 'profile-scrape-v2';

async function loadDeviceToken() {
  const data = await chrome.storage.local.get(DEVICE_TOKEN_KEY);
  extensionDeviceToken = data[DEVICE_TOKEN_KEY] || '';
}

function deviceHeaders(extra = {}) {
  return extensionDeviceToken ? { ...extra, 'X-Extension-Token': extensionDeviceToken } : extra;
}

function getApiBase() {
  return BASE_URL;
}

async function loadApiBase() {
  try {
    const data = await chrome.storage.local.get('iwApiBase');
    const saved = [API_BASE_LOCAL, API_BASE_BACKEND, API_BASE_PROD].includes(data.iwApiBase)
      ? data.iwApiBase
      : null;

    // Prefer the local development backend when it is actually running. This
    // prevents an old production value left in extension storage from sending
    // local campaigns to a dead Cloudflare origin (HTTP 522).
    const candidates = [API_BASE_LOCAL, API_BASE_BACKEND];
    for (const candidate of candidates) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1500);
      try {
        const res = await fetch(`${candidate}/health`, { signal: controller.signal });
        // /api/health is supported by the local backend. If an older backend
        // only exposes /health, the direct backend candidate is still useful.
        if (res.ok) {
          BASE_URL = candidate;
          await chrome.storage.local.set({ iwApiBase: BASE_URL });
          console.log('[BG] Local API detected:', BASE_URL);
          return;
        }
      } catch {} finally {
        clearTimeout(timer);
      }
    }

    BASE_URL = saved || API_BASE_LOCAL;
  } catch (e) {
    BASE_URL = API_BASE_LOCAL;
    console.warn('[BG] Could not detect API base, using local:', e.message);
  }
  console.log('[BG] API base:', BASE_URL);
}

function wsHeaders() {
  return deviceHeaders({ 'Content-Type': 'application/json', 'X-Workspace': currentWorkspace });
}

// An offscreen document is not a tab, so its timers are never throttled.
// Keeping one open holds the service worker awake for the whole campaign.
async function ensureOffscreen() {
  try {
    if (!chrome.offscreen) return;
    if (await chrome.offscreen.hasDocument()) return;
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['BLOBS'],
      justification: 'Keeps the service worker alive so campaign sending is not suspended.'
    });
    console.log('[BG] Offscreen keep-alive document created');
  } catch (e) {
    console.log('[BG] Offscreen unavailable:', e.message);
  }
}

async function closeOffscreen() {
  try {
    if (chrome.offscreen && await chrome.offscreen.hasDocument()) {
      await chrome.offscreen.closeDocument();
    }
  } catch (e) {}
}

function startKeepAlive() {
  if (!keepAliveInterval) {
    keepAliveInterval = setInterval(() => {
      chrome.runtime.getPlatformInfo(() => {});
    }, 25000);
  }
  // Without this, turning the monitor off lets the machine sleep and every
  // timer in the send flow stops with it.
  try {
    if (chrome.power) {
      chrome.power.requestKeepAwake('system');
      console.log('[BG] Power keep-awake requested');
    }
  } catch (e) {}
  ensureOffscreen();
  console.log('[BG] Keep-alive started');
}

function stopKeepAlive() {
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }
  try {
    if (chrome.power) chrome.power.releaseKeepAwake();
  } catch (e) {}
  closeOffscreen();
  console.log('[BG] Keep-alive stopped');
}

async function syncWorkspaceCookie() {
  // Workspace is owned by the signed-in platform account. Never write an
  // Instagram-derived tenant cookie from the extension.
}

async function loadWorkspace() {
  const data = await chrome.storage.local.get('iwWorkspace');
  currentWorkspace = data.iwWorkspace || 'default';
  await syncWorkspaceCookie();
}

loadWorkspace();
loadDeviceToken();
loadApiBase();

let state = {
  running: false,
  paused: false,
  currentItem: null,
  igUsername: null,
  igDetectedAt: null,
  nextMessageAt: null,
  stats: { sent: 0, failed: 0, total: 0 },
  // Consecutive-failure streaks, counted separately per action type
  // ({ dm: 2, follow: 0, like: 5 }). Instagram never announces a limit — it
  // just starts failing one kind of action while the others keep working, so a
  // global counter both trips on the wrong signal and masks the real one.
  // A success of a given type resets that type's streak.
  actionStreaks: {}
};

// Five rather than three: a limited account produces long unbroken streaks of
// the limited action, whereas transient DOM drift produces short ones. Three
// is inside the noise band and stops healthy campaigns.
const ACTION_STREAK_LIMIT = 5;

function recordActionOutcomes(outcomes) {
  if (!outcomes || typeof outcomes !== 'object') return null;
  if (!state.actionStreaks) state.actionStreaks = {};
  let tripped = null;
  for (const [type, outcome] of Object.entries(outcomes)) {
    if (outcome === 'succeeded') {
      state.actionStreaks[type] = 0;
    } else if (outcome === 'failed') {
      const streak = (state.actionStreaks[type] || 0) + 1;
      state.actionStreaks[type] = streak;
      if (streak >= ACTION_STREAK_LIMIT && !tripped) {
        tripped = { type, streak };
      }
    }
    // Anything else (skipped, nothing to do) is neutral and leaves the
    // streak untouched.
  }
  return tripped;
}

let igRateLimitUntil = 0;

async function saveState() {
  await chrome.storage.local.set({ iwState: state });
}

async function loadState() {
  const data = await chrome.storage.local.get('iwState');
  if (data.iwState) state = { ...state, ...data.iwState };
  if (state.running) {
    startKeepAlive();
    console.log('[BG] Restored running state, keep-alive re-enabled');
  }
}

loadState();

// Only the heartbeat runs on a timer, and it only talks to our own backend.
// Instagram is contacted exclusively when the user presses refresh in the web
// UI or an outgoing message is queued — see handleServerSignals().
chrome.alarms.create('heartbeat', { periodInMinutes: 0.5 });
chrome.alarms.clear('inboxSync');
chrome.alarms.clear('inboxOutbox');


chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_STATE') {
    sendResponse({ ...state, workspace: currentWorkspace, authenticated: !!extensionDeviceToken });
    return;
  }

  if (msg.type === 'SET_DEVICE_TOKEN') {
    extensionDeviceToken = msg.token || '';
    enrichmentMethodCache = { value: null, expiresAt: 0 };
    if (extensionDeviceToken) {
      chrome.storage.local.set({ iwDeviceToken: extensionDeviceToken, iwExtensionToken: extensionDeviceToken }).then(() => {
        if (state.igUsername) {
          return fetch(`${getApiBase()}/extension/account`, {
            method: 'POST',
            headers: wsHeaders(),
            body: JSON.stringify({ username: state.igUsername })
          });
        }
      }).catch(() => {});
    }
    sendResponse({ ok: true, authenticated: !!extensionDeviceToken });
    return;
  }

  if (msg.type === 'SET_API_BASE') {
    if ([API_BASE_LOCAL, API_BASE_BACKEND, API_BASE_PROD].includes(msg.apiBase)) {
      BASE_URL = msg.apiBase;
      chrome.storage.local.set({ iwApiBase: BASE_URL }).catch(() => {});
      console.log('[BG] API base switched to:', BASE_URL);
      sendResponse({ ok: true, apiBase: BASE_URL });
    } else {
      sendResponse({ ok: false, error: 'Unsupported API base' });
    }
    return;
  }

  if (msg.type === 'KEEP_ALIVE_PING') {
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === 'IG_ACCOUNT') {
    const username = msg.username;
    if (username) {
      // The platform account owns the workspace. Instagram username is identity metadata only.
      // Never put it in the platform URL or switch tenant based on a client-side username.
      if (username !== state.igUsername) {
        state.igUsername = username;
        state.igDetectedAt = Date.now();
        saveState();
      }
      if (extensionDeviceToken) {
        fetch(`${getApiBase()}/extension/account`, {
          method: 'POST',
          headers: wsHeaders(),
          body: JSON.stringify({ username })
        }).catch(() => {});
      }
    }
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === 'START') {
    state.running = true;
    state.paused = false;
    state.nextMessageAt = null;
    saveState();
    startKeepAlive();
    chrome.alarms.create('processQueue', { when: Date.now() + 1000 });
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === 'PAUSE') {
    state.running = false;
    state.paused = true;
    state.nextMessageAt = null;
    chrome.alarms.clear('processQueue');
    stopKeepAlive();
    saveState();
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === 'RESET') {
    state = {
      running: false, paused: false, currentItem: null,
      igUsername: state.igUsername, igDetectedAt: state.igDetectedAt,
      nextMessageAt: null,
      stats: { sent: 0, failed: 0, total: 0 }
    };
    chrome.alarms.clear('processQueue');
    stopKeepAlive();
    saveState();
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === 'LOGOUT') {
    // A different account may sign in next, so unlike RESET nothing is kept:
    // the detected Instagram handle, the workspace and every pending queue item
    // belong to the session that just ended.
    //
    // The storage removal must be awaited. Answering before it lands lets the
    // user close the popup, which tears down the service worker mid-write, and
    // the next launch finds the old token still in storage and signs them back in.
    (async () => {
      state = {
        running: false,
        paused: false,
        currentItem: null,
        igUsername: null,
        igDetectedAt: null,
        nextMessageAt: null,
        stats: { sent: 0, failed: 0, total: 0 },
        actionStreaks: {}
      };
      extensionDeviceToken = '';
      currentWorkspace = 'default';
      chrome.alarms.clear('processQueue');
      stopKeepAlive();
      await closeOffscreen();
      await chrome.storage.local.remove([
        'iwDeviceToken', 'iwExtensionToken', 'iwWorkspace',
        'iwState', 'iwConfirmOutbox'
      ]);
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.type === 'PERSONALIZE') {
    (async () => {
      try {
        const res = await fetch(`${getApiBase()}/extension/personalize/${msg.cl_id}`, {
          method: 'POST',
          headers: wsHeaders(),
          body: JSON.stringify({ profileData: msg.profileData })
        });
        if (!res.ok) {
          const errText = await res.text();
          sendResponse({ error: errText });
          return;
        }
        const data = await res.json();
        sendResponse({ message: data.message || null });
      } catch (e) {
        console.error('[BG] personalize error:', e);
        sendResponse({ error: e.message });
      }
    })();
    return true;
  }

  if (msg.type === 'ACTION_BLOCKED') {
    handleActionBlocked(msg);
    return;
  }

  if (msg.type === 'ITEM_SENT') {
    markSent(msg.cl_id, msg.message, msg.actions);
    return;
  }

  if (msg.type === 'ITEM_FOLLOWED') {
    markFollowed(msg.cl_id, msg.actions);
    return;
  }

  if (msg.type === 'ITEM_FAILED') {
    markFailed(msg.cl_id, msg.error, msg.actions);
    return;
  }

  if (msg.type === 'SEND_INBOX_MESSAGE') {
    (async () => {
      await processInboxOutbox();
      sendResponse({ ok: true });
    })();
    return true;
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'heartbeat') {
    await sendHeartbeat();
    return;
  }

  if (alarm.name !== 'processQueue') return;
  if (!state.running) return;
  state.nextMessageAt = null;
  await saveState();
  await processNext();
});

async function sendHeartbeat() {
  // Delivery of pending confirm/fail entries is the top priority — if we skip
  // this, the backend keeps recycling 'sending' leads back to 'pending' and
  // eventually double-sends them.
  flushOutbox().catch(() => {});

  try {
    const res = await fetch(`${getApiBase()}/extension/heartbeat`, {
      method: 'POST',
      headers: wsHeaders(),
      body: JSON.stringify({
        running: state.running,
        paused: state.paused,
        ig_username: state.igUsername,
        has_current_item: !!state.currentItem,
        stats: state.stats,
        next_message_at: state.nextMessageAt
      })
    });
    const data = await res.json();

    // Respect a manual pause. Without this check the popup's Pause button
    // is undone by the next heartbeat 30s later.
    if (data.should_run && !state.running && !state.currentItem && !state.paused) {
      console.log('[BG] Auto-starting: backend has running campaigns');
      state.running = true;
      state.paused = false;
      state.nextMessageAt = null;
      await saveState();
      startKeepAlive();
      chrome.alarms.create('processQueue', { when: Date.now() + 1000 });
      notifyPopup({ type: 'AUTO_STARTED' });
    }

    if (data.should_stop && state.running) {
      console.log('[BG] Auto-stopping: no running campaigns on backend');
      state.running = false;
      state.paused = false;
      state.nextMessageAt = null;
      chrome.alarms.clear('processQueue');
      stopKeepAlive();
      await saveState();
      notifyPopup({ type: 'AUTO_STOPPED' });
    }

    await handleServerSignals(data);
  } catch (e) {}

  // Kick the Instagram job loops if there's queued Lead Finder or AI search
  // work. Self-guards against double-entry, campaign sends, and rate-limit
  // backoff.
  runIgJobLoops().catch(e => console.error('[Scrape] loop error:', e));
}

// Hard floor between any two Instagram inbox operations, regardless of what
// the server asks for. Getting the account flagged is far worse than a slow
// refresh.
const IG_MIN_INTERVAL_MS = 60 * 1000;
let lastIgTouch = 0;
let igBusy = false;

// Backoff after Instagram answers 429. A 429 is the account being told to slow
// down, and coming back in a few minutes tends to earn another one — each
// re-trip digs the hole deeper. Randomised so repeated backoffs don't form a
// recognisable fixed interval.
function igRateLimitBackoffMs() {
  const MIN = 30 * 60 * 1000;
  const MAX = 60 * 60 * 1000;
  return Math.round(MIN + Math.random() * (MAX - MIN));
}

function beginIgRateLimitBackoff(context) {
  const ms = igRateLimitBackoffMs();
  igRateLimitUntil = Date.now() + ms;
  console.warn(`[BG] ${context}: Instagram 429 — pausing Instagram requests for ${Math.round(ms / 60000)} min`);
}

function igCooldownLeft() {
  return Math.max(0, IG_MIN_INTERVAL_MS - (Date.now() - lastIgTouch));
}

// The only path that reaches Instagram outside of an active campaign.
// Runs when the user pressed refresh in the web UI, or a message is waiting
// to go out — never on a bare timer.
async function handleServerSignals(data) {
  if (!data) return;
  if (igBusy) return;

  if (data.sync_requested) {
    // Take the request before touching Instagram. If this returns false the
    // work was already claimed, so we must not scrape again.
    let claimed = false;
    try {
      const res = await fetch(`${getApiBase()}/extension/claim-sync`, {
        method: 'POST',
        headers: wsHeaders(),
        body: JSON.stringify({})
      });
      claimed = (await res.json())?.claimed === true;
    } catch (e) {
      return;
    }

    if (claimed) {
      const wait = igCooldownLeft();
      if (wait > 0) {
        console.log('[BG] Sync claimed but cooling down,', Math.round(wait / 1000), 's left — skipping');
      } else {
        igBusy = true;
        lastIgTouch = Date.now();
        try {
          console.log('[BG] Sync requested by user, scraping Instagram inbox');
          await syncInbox();
        } finally {
          igBusy = false;
          lastIgTouch = Date.now();
        }
      }
    }
  }

  if (data.outbox_pending > 0 && !igBusy && igCooldownLeft() === 0) {
    igBusy = true;
    lastIgTouch = Date.now();
    try {
      console.log('[BG]', data.outbox_pending, 'message(s) queued for Instagram');
      await processInboxOutbox();
    } finally {
      igBusy = false;
      lastIgTouch = Date.now();
    }
  }
}

async function handleActionBlocked(msg) {
  state.running = false;
  state.paused = true;
  state.currentItem = null;
  state.nextMessageAt = null;
  chrome.alarms.clear('processQueue');
  await saveState();

  try {
    await fetch(`${getApiBase()}/extension/action-blocked`, {
      method: 'POST',
      headers: wsHeaders(),
      body: JSON.stringify({
        reason: msg.reason,
        cl_id: msg.cl_id,
        campaign_id: msg.campaign_id
      })
    });
  } catch (e) {
    console.error('[BG] action-blocked report error:', e);
  }

  notifyPopup({ type: 'ACTION_BLOCKED', reason: msg.reason });
}

// Clears the queued sync flag so a failed attempt does not retry forever.
// Passes the reason along so the Inbox UI can explain an empty result instead
// of silently showing "Обновлено" with no new data.
async function clearSyncRequest(error) {
  try {
    await fetch(`${getApiBase()}/extension/inbox-sync`, {
      method: 'POST',
      headers: wsHeaders(),
      body: JSON.stringify({ conversations: [], error: error || null })
    });
  } catch (e) {}
}

const INBOX_SYNC_MAX_PAGES = 10;
const INBOX_SYNC_PAGE_DELAY_MS = { min: 2000, max: 3500 };

// Ask an open Instagram tab's content script to scrape the inbox from the page
// context. Returns null when no tab is open (so the caller falls back to the
// service-worker fetch), or { conversations, rateLimited, error } otherwise.
async function scrapeInboxViaTab() {
  let tabs;
  try {
    tabs = await chrome.tabs.query({ url: 'https://www.instagram.com/*' });
  } catch (e) {
    return null;
  }
  if (!tabs || tabs.length === 0) return null;

  try {
    // Deliberately not focusing the tab: stealing focus made Instagram's own
    // page code fire a burst of requests and trip its rate limiter.
    const resp = await sendMessageToTab(
      tabs[0].id, { type: 'SCRAPE_INBOX', maxPages: INBOX_SYNC_MAX_PAGES }, 3, false
    );
    if (resp?.rateLimited) return { rateLimited: true };
    return { conversations: resp?.conversations || [], error: resp?.error || null };
  } catch (e) {
    console.error('[BG] SCRAPE_INBOX via tab failed:', e.message);
    // Treat a dead/again-injecting tab as "no data" and let the SW path try.
    return { conversations: [], error: null };
  }
}

async function syncInbox() {
  if (Date.now() < igRateLimitUntil) {
    const mins = Math.ceil((igRateLimitUntil - Date.now()) / 60000);
    console.log('[BG] Instagram rate limited, skipping sync until', new Date(igRateLimitUntil).toLocaleTimeString());
    await clearSyncRequest(`Instagram ограничил запросы (429). Подождите ~${mins} мин и попробуйте снова.`);
    return;
  }

  try {
    let conversations = [];
    let syncError = null;

    // Preferred path (this is how the inbox worked before): scrape from an open
    // Instagram tab. The request runs in the page context with the real cookies
    // and referer, which Instagram trusts far more than a bare service-worker
    // call — and it carries a DOM fallback when the private API returns nothing.
    const viaTab = await scrapeInboxViaTab();
    if (viaTab) {
      if (viaTab.rateLimited) {
        beginIgRateLimitBackoff('inbox sync');
        await clearSyncRequest('Instagram ограничил запросы (429). Подождите и повторите.');
        return;
      }
      conversations = viaTab.conversations || [];
      if (viaTab.error) syncError = viaTab.error;
      if (conversations.length > 0) {
        console.log('[BG] Inbox scraped via tab:', conversations.length, 'threads');
      }
    }

    // Fallback: no Instagram tab open (or the tab returned nothing) — fetch
    // straight from the service worker with the header-rich request.
    if (conversations.length === 0) {
      let cursor = null;
      for (let page = 0; page < INBOX_SYNC_MAX_PAGES; page++) {
        const r = await igFetchInboxPage(cursor, 20);

        if (!r.ok) {
          if (r.rateLimited) beginIgRateLimitBackoff('inbox sync');
          else console.error('[BG] Inbox fetch failed:', r.message);
          // Remember why we stopped so the UI can show it. Whatever was
          // collected before the failure is still worth saving.
          syncError = r.message || syncError || 'Не удалось получить диалоги из Instagram';
          break;
        }

        conversations.push(...r.threads);
        console.log('[BG] Inbox page', page + 1, ':', r.threads.length, 'threads, has_older:', r.has_older);

        cursor = r.next_cursor;
        if (!cursor || !r.has_older || r.threads.length === 0) break;

        await offscreenDelayBg(
          INBOX_SYNC_PAGE_DELAY_MS.min +
          Math.random() * (INBOX_SYNC_PAGE_DELAY_MS.max - INBOX_SYNC_PAGE_DELAY_MS.min)
        );
      }
    }

    if (conversations.length === 0) {
      // Nothing came back: report the failure reason (or, if the fetch
      // genuinely succeeded with an empty inbox, no error at all).
      await clearSyncRequest(syncError);
      return;
    }

    try {
      const syncRes = await fetch(`${getApiBase()}/extension/inbox-sync`, {
        method: 'POST',
        headers: wsHeaders(),
        body: JSON.stringify({ conversations, error: syncError })
      });
      const syncData = await syncRes.json();
      console.log('[BG] Inbox synced:', conversations.length, 'threads,', syncData.synced, 'new/updated');
    } catch (e) {
      console.error('[BG] Failed to sync with backend:', e.message);
    }
  } catch (e) {
    console.error('[BG] syncInbox error:', e.message);
    await clearSyncRequest('Ошибка синхронизации: ' + (e.message || 'неизвестно'));
  }
}

async function ensureTabActive(tabId) {
  try {
    await chrome.tabs.update(tabId, { active: true });
    const tab = await chrome.tabs.get(tabId);
    if (tab.windowId) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
  } catch (e) {
    console.log('[BG] Could not focus tab:', e.message);
  }
}

// Content scripts declared in the manifest are only injected when a page
// loads. Any Instagram tab that was already open when the extension was
// installed, reloaded or updated therefore has no content script, and every
// sendMessage to it fails with "Receiving end does not exist" — which breaks
// campaign sends and scraping alike until the user manually reloads the tab.
//
// This pings the tab and injects content.js when nothing answers. content.js
// carries its own load guard, so an injection into a tab that does have it is
// harmless.
async function ensureContentScript(tabId) {
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
    if (pong?.ok && pong.version === CONTENT_SCRIPT_VERSION) return true;
    if (pong?.ok) {
      console.warn('[BG] Stale content.js detected; expected', CONTENT_SCRIPT_VERSION, 'got', pong.version || 'unknown');
      return false;
    }
  } catch (e) {
    // No listener — fall through to injection.
  }

  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    console.log('[BG] Injected content.js into tab', tabId);
    await new Promise(r => setTimeout(r, 600));
    const pong = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
    return Boolean(pong?.ok && pong.version === CONTENT_SCRIPT_VERSION);
  } catch (e) {
    console.error('[BG] Could not inject/verify content.js into tab', tabId, ':', e.message);
    return false;
  }
}

// A content script injected before an extension update can keep its old message
// listener alive. A successful PING alone is not enough: verify the version and
// reload the Instagram tab once so Chrome installs the current packaged script.
async function ensureCurrentContentScript(tabId) {
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
    if (pong?.ok && pong.version === CONTENT_SCRIPT_VERSION) return true;
    if (pong?.ok) {
      console.warn('[Enrich] Reloading Instagram tab to replace stale content.js');
      await chrome.tabs.reload(tabId);
      await waitForTabLoad(tabId);
      const refreshed = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
      if (refreshed?.ok && refreshed.version === CONTENT_SCRIPT_VERSION) return true;
    }
  } catch (e) {
    // Missing listener — try a direct injection below.
  }
  return await ensureContentScript(tabId);
}

// allowFocus is off for inbox work: pulling the tab to the front makes
// Instagram's own page code fire a burst of requests and trip its rate limiter.
async function sendMessageToTab(tabId, message, retries = 3, allowFocus = true) {
  let lastError = null;
  for (let i = 0; i < retries; i++) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, message);
      // A stale content script can receive the message but not recognize its
      // type; Chrome then resolves sendMessage with undefined instead of
      // throwing. Treat that as a failed delivery and repair/reload the script.
      if (response !== undefined && response !== null) return response;
      lastError = new Error('Content script получил сообщение, но не вернул ответ');
      console.warn('[BG] sendMessage attempt', i + 1, 'returned no response for', message?.type);
    } catch (e) {
      lastError = e;
      console.warn('[BG] sendMessage attempt', i + 1, 'failed:', e.message);
    }
    if (i < retries - 1) {
      if (allowFocus) await ensureTabActive(tabId);
      await new Promise(r => setTimeout(r, 1000 + i * 1000));
      const current = await ensureCurrentContentScript(tabId);
      if (!current) {
        console.warn('[BG] content.js version could not be verified after retry', i + 1);
      }
    }
  }
  throw lastError || new Error('Content script не ответил после повторных попыток');
}

async function processNext() {
  try {
    const res = await fetch(`${getApiBase()}/extension/queue`, { headers: deviceHeaders({ 'X-Workspace': currentWorkspace }) });
    const data = await res.json();

    if (!data.item) {
      state.currentItem = null;
      state.nextMessageAt = null;
      await saveState();
      notifyPopup({ type: 'IDLE', message: data.message });
      chrome.alarms.create('processQueue', { when: Date.now() + 10000 });
      return;
    }

    state.currentItem = data.item;
    state.stats.total++;
    state.nextMessageAt = null;
    await saveState();

    const igUrl = `https://www.instagram.com/${data.item.username}/`;
    const tabs = await chrome.tabs.query({ url: 'https://www.instagram.com/*' });

    let tab;
    if (tabs.length > 0) {
      tab = tabs[0];
      await chrome.tabs.update(tab.id, { url: igUrl, active: true });
    } else {
      tab = await chrome.tabs.create({ url: igUrl, active: true });
    }

    await ensureTabActive(tab.id);
    await waitForTabLoad(tab.id);

    await sendMessageToTab(tab.id, {
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
  return new Promise((resolve, reject) => {
    let done = false;
    let poller = null;
    const finish = (ok, err) => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      if (poller) clearInterval(poller);
      if (ok) setTimeout(resolve, 3000); else reject(err || new Error('Tab load timeout'));
    };
    const listener = (updatedTabId, info) => {
      if (updatedTabId === tabId && info.status === 'complete') finish(true);
    };
    chrome.tabs.onUpdated.addListener(listener);

    // The onUpdated event is missed entirely when the page finishes loading
    // before this listener attaches — a fast cached load would then burn the
    // full timeout. Polling the tab's status closes that race.
    poller = setInterval(async () => {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.status === 'complete') finish(true);
      } catch (e) {
        finish(false, new Error('Tab closed while loading'));
      }
    }, 400);

    // 25s covers slow Instagram loads without giving up in the middle of a real
    // page render. If it still isn't complete, we treat the send as failed
    // instead of firing DOM actions on a partially-loaded page.
    setTimeout(() => finish(false), 25000);
  });
}

// Local retry queue for /confirm and /fail. If the backend call fails (transient
// network error, backend restart), the message stays here and is retried on
// every heartbeat. Without this, a confirmed send whose /confirm request
// failed would leave the lead in 'sending' — the backend's 10-min timeout
// reclaims it to 'pending' and dispatches it AGAIN. Duplicate DMs to the
// same lead is the fastest way to get an Instagram account flagged.
async function loadOutbox() {
  const data = await chrome.storage.local.get('iwConfirmOutbox');
  return Array.isArray(data.iwConfirmOutbox) ? data.iwConfirmOutbox : [];
}

async function saveOutbox(list) {
  await chrome.storage.local.set({ iwConfirmOutbox: list });
}

async function enqueueOutbox(entry) {
  const list = await loadOutbox();
  list.push({ ...entry, ts: Date.now(), attempts: 0 });
  await saveOutbox(list);
}

async function postConfirmOrFail(entry) {
  const url = entry.kind === 'confirm'
    ? `${getApiBase()}/extension/confirm/${entry.cl_id}`
    : entry.kind === 'followed'
      ? `${getApiBase()}/extension/followed/${entry.cl_id}`
      : `${getApiBase()}/extension/fail/${entry.cl_id}`;
  const body = entry.kind === 'confirm'
    ? { message: entry.message }
    : entry.kind === 'followed'
      ? {}
      : { error_message: entry.error_message };
  const res = await fetch(url, {
    method: 'POST',
    headers: deviceHeaders({ 'Content-Type': 'application/json', 'X-Workspace': entry.workspace || currentWorkspace }),
    body: JSON.stringify(body)
  });
  // 404 = lead was deleted; treat as done rather than retrying forever.
  if (res.status === 404) return { ok: true, data: {} };
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { ok: true, data: await res.json().catch(() => ({})) };
}

let flushingOutbox = false;
async function flushOutbox() {
  if (flushingOutbox) return;
  flushingOutbox = true;
  try {
    let list = await loadOutbox();
    if (list.length === 0) return;
    console.log('[BG] Flushing', list.length, 'pending confirm/fail entries');
    const remaining = [];
    for (const entry of list) {
      try {
        await postConfirmOrFail(entry);
        console.log('[BG] Delivered', entry.kind, 'for cl_id', entry.cl_id, 'after', entry.attempts, 'attempts');
      } catch (e) {
        entry.attempts = (entry.attempts || 0) + 1;
        // Give up after ~24h of retries to avoid a permanent-poison entry
        // pinning the queue. 30-second heartbeats ⇒ 2880 attempts.
        if (entry.attempts < 2880) remaining.push(entry);
        else console.warn('[BG] Dropping poison outbox entry after 24h:', entry.cl_id);
      }
    }
    await saveOutbox(remaining);
  } finally {
    flushingOutbox = false;
  }
}

async function markSent(cl_id, message, actions) {
  recordActionOutcomes(actions || { dm: 'succeeded' });
  const entry = { kind: 'confirm', cl_id, message, workspace: currentWorkspace };
  let data = {};
  try {
    const res = await postConfirmOrFail(entry);
    data = res.data || {};
  } catch (e) {
    console.error('[BG] markSent network error, queuing for retry:', e.message);
    await enqueueOutbox(entry);
  }

  state.stats.sent++;

  const delaySec = state.currentItem?.delay_seconds || 600;
  const nextTime = Date.now() + delaySec * 1000;

  state.currentItem = null;
  state.nextMessageAt = nextTime;
  await saveState();
  notifyPopup({ type: 'SENT', cl_id });

  if (data.should_continue === false) {
    console.log('[BG] Backend says campaign stopped, halting queue');
    state.running = false;
    state.paused = false;
    state.nextMessageAt = null;
    chrome.alarms.clear('processQueue');
    stopKeepAlive();
    await saveState();
    notifyPopup({ type: 'AUTO_STOPPED' });
    return;
  }

  if (state.running) {
    chrome.alarms.create('processQueue', { when: nextTime });
  }
}

// Prewarm follow phase completed. Like markSent but the lead is parked as
// 'followed' on the backend (no DM yet); we still pace the next item by the
// normal delay so follows don't cluster.
async function markFollowed(cl_id, actions) {
  recordActionOutcomes(actions || { follow: 'succeeded' });
  const entry = { kind: 'followed', cl_id, workspace: currentWorkspace };
  let data = {};
  try {
    const res = await postConfirmOrFail(entry);
    data = res.data || {};
  } catch (e) {
    console.error('[BG] markFollowed network error, queuing for retry:', e.message);
    await enqueueOutbox(entry);
  }

  const delaySec = state.currentItem?.delay_seconds || 600;
  const nextTime = Date.now() + delaySec * 1000;

  state.currentItem = null;
  state.nextMessageAt = nextTime;
  await saveState();
  notifyPopup({ type: 'FOLLOWED', cl_id });

  if (data.should_continue === false) {
    console.log('[BG] Backend says campaign stopped, halting queue');
    state.running = false;
    state.paused = false;
    state.nextMessageAt = null;
    chrome.alarms.clear('processQueue');
    stopKeepAlive();
    await saveState();
    notifyPopup({ type: 'AUTO_STOPPED' });
    return;
  }

  if (state.running) {
    chrome.alarms.create('processQueue', { when: nextTime });
  }
}

async function markFailed(cl_id, error_message, actions) {
  const tripped = recordActionOutcomes(actions || { dm: 'failed' });
  const entry = { kind: 'fail', cl_id, error_message, workspace: currentWorkspace };
  try {
    await postConfirmOrFail(entry);
  } catch (e) {
    console.error('[BG] markFailed network error, queuing for retry:', e.message);
    await enqueueOutbox(entry);
  }
  state.stats.failed++;

  // Wait the full human-like delay before touching the next lead, exactly as a
  // successful send does. A failed lead has usually already been followed and
  // liked; jumping to the next profile 5s later meant follow+like+follow+like
  // in seconds — a glaring bot burst. Pace failures like sends so a bad DM
  // doesn't accelerate everything after it.
  const cooldownSec = state.currentItem?.delay_seconds || 600;
  const nextTime = Date.now() + cooldownSec * 1000;
  const failedCampaignId = state.currentItem?.campaign_id;

  state.currentItem = null;
  state.nextMessageAt = tripped ? null : nextTime;
  await saveState();
  notifyPopup({ type: 'FAILED', cl_id, error: error_message });

  // Circuit breaker: N failures in a row usually mean Instagram has flagged
  // the account (soft-block, spam classification) or the DOM has drifted
  // enough that our selectors don't find anything. Either way, continuing
  // to grind through the queue only makes it worse — stop the whole flow
  // and tell the backend to auto-pause the campaigns.
  if (tripped) {
    console.warn('[BG] Circuit breaker: ' + tripped.streak + ' consecutive "' + tripped.type +
      '" failures — halting and asking backend to pause campaigns');
    state.running = false;
    state.paused = true;
    state.nextMessageAt = null;
    chrome.alarms.clear('processQueue');
    stopKeepAlive();
    await saveState();
    try {
      await fetch(`${getApiBase()}/extension/action-blocked`, {
        method: 'POST',
        headers: wsHeaders(),
        body: JSON.stringify({
          reason: `circuit-breaker: ${tripped.streak} consecutive ${tripped.type} failures. Last error: ${error_message}`,
          cl_id,
          campaign_id: failedCampaignId
        })
      });
    } catch (e) {
      console.error('[BG] Failed to notify backend of circuit-breaker trip:', e);
    }
    notifyPopup({
      type: 'ACTION_BLOCKED',
      reason: `Подряд не проходит действие "${tripped.type}" (${tripped.streak} раз). Кампании остановлены.`
    });
    return;
  }

  if (state.running) {
    chrome.alarms.create('processQueue', { when: nextTime });
  }
}

let outboxProcessing = false;

async function processInboxOutbox() {
  if (outboxProcessing) return;
  if (state.currentItem) return;
  if (Date.now() < igRateLimitUntil) {
    console.log('[BG] Instagram rate limited, skipping outbox');
    return;
  }

  outboxProcessing = true;
  try {
    const res = await fetch(`${getApiBase()}/extension/inbox-outbox`, { headers: deviceHeaders({ 'X-Workspace': currentWorkspace }) });
    if (!res.ok) return;

    const data = await res.json();
    const messages = data.messages || [];

    if (messages.length === 0) return;

    console.log('[BG] Processing', messages.length, 'outbox messages');

    for (const msg of messages) {
      if (Date.now() < igRateLimitUntil) {
        console.log('[BG] Rate limited mid-outbox, stopping');
        break;
      }

      try {
        const threadId = await sendOutboxMessage(msg);

        await fetch(`${getApiBase()}/extension/inbox-outbox/${msg.id}/sent`, {
          method: 'POST',
          headers: wsHeaders(),
          body: JSON.stringify({ thread_id: threadId || null })
        });
        console.log('[BG] Marked outbox msg', msg.id, 'as sent');
      } catch (e) {
        console.error('[BG] Failed to send outbox msg', msg.id, ':', e.message);
        if (e.message && e.message.includes('429')) {
          beginIgRateLimitBackoff('outbox send');
          break;
        }
        try {
          await fetch(`${getApiBase()}/extension/inbox-outbox/${msg.id}/failed`, {
            method: 'POST',
            headers: wsHeaders(),
            body: JSON.stringify({ error_message: e.message })
          });
        } catch (_) {}
      }

      await new Promise(resolve => setTimeout(resolve, 10000));
    }
  } catch (e) {
    console.error('[BG] processInboxOutbox error:', e.message);
  } finally {
    outboxProcessing = false;
  }
}

async function sendOutboxMessage(msg) {
  const { id, text, contact_username, thread_id } = msg;
  if (!text) throw new Error('Missing text');
  if (!thread_id && !contact_username) throw new Error('Missing thread_id and username');

  console.log('[BG] sendOutboxMessage id=' + id, contact_username, 'thread', thread_id || '(resolve by username)');

  let tabs = await chrome.tabs.query({ url: 'https://www.instagram.com/*' });
  let tab = tabs[0];

  if (!tab) {
    console.log('[BG] No Instagram tab, opening one in background');
    tab = await chrome.tabs.create({ url: 'https://www.instagram.com/direct/inbox/', active: false });
    await waitForTabLoad(tab.id);
    await new Promise(resolve => setTimeout(resolve, 3500));
  }

  console.log('[BG] Sending SEND_VIA_API to tab', tab.id);
  // No focus stealing here either — the send is a plain API call from the page.
  const response = await sendMessageToTab(tab.id, {
    type: 'SEND_VIA_API',
    text,
    thread_id: thread_id || null,
    username: contact_username || null
  }, 3, false);

  if (!response?.ok) {
    throw new Error(response?.error || 'Extension send failed');
  }
  console.log('[BG] SEND_VIA_API completed for msg', id, 'thread', response.thread_id);
  return response.thread_id || thread_id || null;
}

// ---------------------------------------------------------------------------
// Instagram read API, called from the service worker.
//
// Runs here rather than in the content script for two reasons: the page
// context imposes referer/origin expectations that made /api/v1 reads answer
// 400, and a background fetch needs no content script to be present in a tab.
//
// The header set matters and is endpoint-specific:
//   X-IG-App-ID     — identifies the web client (required everywhere)
//   X-ASBD-ID       — expected on /api/v1 READ endpoints. Note it must NOT be
//                     sent on the DM broadcast endpoint, where it triggers
//                     "useragent mismatch" — see the comment in content.js.
//   X-IG-WWW-Claim  — echoed back from the www-claim-v2 cookie. Instagram
//                     issues this per session and rejects reads without it,
//                     which is the most likely cause of a blanket 400.
//   Accept-Language — plain reads are refused without a language preference.
// ---------------------------------------------------------------------------
const IG_APP_ID = '936619743392459';
const IG_ASBD_ID = '129477';

// A cold-started MV3 service worker can read the cookie store before it has
// finished attaching, returning an empty set once even though the user is
// logged in and the Instagram tab is open. Retry a few times with growing
// delays before treating the session as genuinely missing.
async function getIgCookiesReady() {
  let cookies = await getIgCookies();
  for (let i = 0; i < 4 && !cookies.sessionid; i++) {
    await new Promise((r) => setTimeout(r, 300 + i * 300));
    cookies = await getIgCookies();
  }
  return cookies;
}

function getIgCookies() {
  // chrome.cookies.getAll() has been observed returning an empty list in some
  // Edge setups (extension conflicts, privacy features) even though the
  // cookies exist and chrome.cookies.get() for the same names succeeds. Fetch
  // each cookie individually to sidestep whatever breaks the bulk query.
  const names = ['sessionid', 'csrftoken', 'ds_user_id', 'mid', 'rur', 'www-claim-v2'];
  const url = 'https://www.instagram.com/';
  return Promise.all(
    names.map(
      (name) =>
        new Promise((resolve) => {
          try {
            chrome.cookies.get({ url, name }, (cookie) => resolve(cookie?.value || ''));
          } catch (e) {
            resolve('');
          }
        })
    )
  ).then(([sessionid, csrftoken, dsUserId, mid, rur, wwwClaim]) => ({
    sessionid,
    csrftoken,
    dsUserId,
    mid,
    rur,
    wwwClaim,
  }));
}

function igReadHeaders(cookies) {
  const h = {
    'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
    'X-IG-App-ID': IG_APP_ID,
    'X-ASBD-ID': IG_ASBD_ID,
    'X-CSRFToken': cookies.csrftoken || '',
    'X-Requested-With': 'XMLHttpRequest',
  };
  if (cookies.wwwClaim) h['X-IG-WWW-Claim'] = cookies.wwwClaim;
  if (cookies.dsUserId) {
    h['IG-U-DS-USER-ID'] = cookies.dsUserId;
    h['IG-INTENDED-USER-ID'] = cookies.dsUserId;
  }
  if (cookies.mid) h['X-MID'] = cookies.mid;
  if (cookies.rur) h['IG-U-RUR'] = cookies.rur;
  return h;
}

function classifyIgFailure(status, body) {
  let parsed = null;
  try { parsed = JSON.parse(body); } catch (e) {}

  if (parsed?.spam === true) {
    return { fatal: true, message: 'Instagram отметил активность как спам (spam=true)' };
  }
  if (parsed?.require_login || parsed?.checkpoint_url || parsed?.error_type === 'checkpoint_challenge_required') {
    return { fatal: true, message: 'Instagram требует подтверждение личности (checkpoint)' };
  }
  if (status === 429) {
    return { rateLimited: true, message: 'Instagram ограничил запросы (429)' };
  }
  if (status === 401 || status === 403) {
    return { fatal: true, message: `Instagram отклонил запрос (HTTP ${status}) — сессия или аккаунт помечены` };
  }
  const detail = parsed?.message || (body || '').slice(0, 160).replace(/\s+/g, ' ');
  return { message: `HTTP ${status}${detail ? ': ' + detail : ''}` };
}

// Tries www first, then the i.instagram.com host. The two are served by
// different frontends and one frequently answers when the other refuses.
async function igApiGet(pathWithQuery, cookies) {
  const headers = igReadHeaders(cookies);
  const hosts = ['https://www.instagram.com', 'https://i.instagram.com'];
  let last = { message: 'Запрос не выполнен' };

  for (const host of hosts) {
    let res;
    try {
      res = await fetch(host + pathWithQuery, { method: 'GET', credentials: 'include', headers });
    } catch (e) {
      last = { message: 'Сеть недоступна: ' + e.message };
      continue;
    }

    if (res.redirected && res.url.includes('/accounts/login')) {
      return { ok: false, fatal: true, message: 'Instagram требует повторный вход — сессия сброшена' };
    }

    const body = await res.text();
    if (res.ok) {
      try {
        const data = JSON.parse(body);
        if (data?.spam === true) {
          return { ok: false, fatal: true, message: 'Instagram отметил активность как спам (spam=true)' };
        }
        if (data?.status === 'fail') {
          return { ok: false, fatal: true, message: 'Instagram отклонил запрос: ' + (data.message || 'status=fail') };
        }
        return { ok: true, data };
      } catch (e) {
        return { ok: false, fatal: true, message: 'Instagram вернул HTML вместо данных — сессия помечена' };
      }
    }

    last = classifyIgFailure(res.status, body);
    console.log('[IG] ' + host + pathWithQuery.split('?')[0] + ' → ' + res.status);
    // A hard block or rate limit is the account's state, not the host's —
    // retrying the other host would only add another flagged request.
    if (last.fatal || last.rateLimited) break;
  }

  return { ok: false, ...last };
}

let enrichmentMethodCache = { value: null, expiresAt: 0 };

async function getEnrichmentMethod(force = false) {
  const now = Date.now();
  if (!force && enrichmentMethodCache.value && enrichmentMethodCache.expiresAt > now) {
    return enrichmentMethodCache.value;
  }

  const res = await fetch(`${getApiBase()}/extension/enrichment-method`, {
    headers: deviceHeaders({ 'X-Workspace': currentWorkspace })
  });
  if (!res.ok) {
    throw new Error(`Не удалось получить метод чтения профиля с сервера (HTTP ${res.status})`);
  }
  const data = await res.json();
  if (data?.enrichment_method !== 'api' && data?.enrichment_method !== 'dom') {
    throw new Error('Сервер вернул неизвестный метод чтения профиля');
  }
  enrichmentMethodCache = { value: data.enrichment_method, expiresAt: now + 15000 };
  console.log(`[Enrich] profile reading method = ${data.enrichment_method}`);
  return data.enrichment_method;
}

async function fetchProfileViaApi(username, options = {}) {
  const cookies = await getIgCookiesReady();
  const r = await igApiGet('/api/v1/users/web_profile_info/?username=' + encodeURIComponent(username), cookies);
  if (!r.ok) return r;

  const u = r.data?.data?.user;
  if (!u) return { ok: false, message: 'Профиль @' + username + ' не найден' };

  let posts = [];
  if (options.withPosts) {
    const edges = u.edge_owner_to_timeline_media?.edges || [];
    for (const edge of edges) {
      const text = edge?.node?.edge_media_to_caption?.edges?.[0]?.node?.text;
      if (text && text.trim()) posts.push(String(text).trim().slice(0, 400));
      if (posts.length >= (options.maxPosts || 10)) break;
    }
  }

  return {
    ok: true,
    user: {
      id: u.id ? String(u.id) : null,
      username: u.username || username,
      full_name: u.full_name || '',
      bio: u.biography || '',
      is_private: !!u.is_private,
      follower_count: u.edge_followed_by?.count ?? null,
      following_count: u.edge_follow?.count ?? null,
      post_count: u.edge_owner_to_timeline_media?.count ?? null,
      external_url: u.external_url || '',
      posts
    }
  };
}

async function findReusableInstagramTab(username) {
  const tabs = await chrome.tabs.query({ url: 'https://www.instagram.com/*' });
  if (!tabs.length) return null;

  const wanted = String(username || '').replace(/^@/, '').toLowerCase();
  // Prefer an already-open exact profile so we do not navigate or create a tab.
  const exact = tabs.find(tab => {
    try {
      const url = new URL(tab.url || '');
      const pathUser = decodeURIComponent(url.pathname.replace(/^\/+|\/+$/g, '')).toLowerCase();
      return url.hostname === 'www.instagram.com' && pathUser === wanted;
    } catch (e) {
      return false;
    }
  });
  if (exact) return exact;

  // Otherwise prefer the currently active Instagram tab, then any reusable tab.
  const active = tabs.find(tab => tab.active);
  return active || tabs[0];
}

async function waitForInstagramProfile(tabId, username, timeoutMs = 20000) {
  const wanted = String(username || '').replace(/^@/, '').toLowerCase();
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const tab = await chrome.tabs.get(tabId);
      const url = new URL(tab.url || '');
      const pathUser = decodeURIComponent(url.pathname.replace(/^\/+|\/+$/g, '')).toLowerCase();
      if (url.hostname === 'www.instagram.com' && pathUser === wanted && tab.status === 'complete') return true;
    } catch (e) {}
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

async function fetchDOMProfile(username, options = {}) {
  let tab = null;
  try {
    console.log(`[Enrich] DOM parser started for @${username}`);

    // Dolphin may reject chrome.tabs.create() while its onboarding/startup
    // page is active. More importantly, we already expect the user to have a
    // logged-in Instagram session open in the browser. Reuse that tab instead
    // of creating a new one. chrome.tabs.query() returns existing tabs and
    // tabs.update() can navigate one without opening a new tab.
    tab = await findReusableInstagramTab(username);
    if (!tab?.id) {
      throw new Error(
        'Не найдена открытая вкладка Instagram. Откройте Instagram в отдельной вкладке и повторите обогащение.'
      );
    }

    const currentUrl = tab.url || '';
    const targetUrl = `https://www.instagram.com/${encodeURIComponent(String(username).replace(/^@/, ''))}/`;
    const sameProfile = currentUrl.toLowerCase().replace(/\/$/, '') === targetUrl.toLowerCase().replace(/\/$/, '');

    if (!sameProfile) {
      console.log(`[Enrich] Reusing Instagram tab ${tab.id}: ${currentUrl} -> ${targetUrl}`);
      await chrome.tabs.update(tab.id, { url: targetUrl, active: false });
      await waitForTabLoad(tab.id);
    } else {
      console.log(`[Enrich] Reusing existing Instagram profile tab ${tab.id}`);
    }

    if (!(await waitForInstagramProfile(tab.id, username, 20000))) {
      throw new Error(`Instagram не открыл профиль @${String(username).replace(/^@/, '')}`);
    }

    // The content script may have been loaded before the extension was
    // reloaded. Ensure it exists without creating another tab.
    const ready = await ensureCurrentContentScript(tab.id);
    if (!ready) {
      throw new Error('Не удалось подключить content.js к открытой вкладке Instagram');
    }

    // Give Instagram's React UI a moment to render after navigation.
    await new Promise(resolve => setTimeout(resolve, 1200));

    const response = await sendMessageToTab(tab.id, {
      type: 'SCRAPE_PROFILE',
      waitMs: 1200
    }, 4, false);

    if (!response?.ok) {
      throw new Error(response?.error || 'content.js не вернул данные профиля');
    }

    const d = response.data || {};
    const user = {
      id: d.userId ? String(d.userId) : null,
      username: d.username || username,
      full_name: d.fullName || '',
      bio: d.bio || '',
      is_private: !!d.isPrivate,
      follower_count: d.followers ?? null,
      following_count: d.following ?? null,
      post_count: d.postCount ?? null,
      external_url: d.externalUrl || '',
      posts: Array.isArray(d.posts) ? d.posts.slice(0, options.maxPosts || 10) : []
    };

    const hasUsefulData = user.full_name || user.bio || user.follower_count != null || user.post_count != null || user.is_private;
    if (!hasUsefulData) {
      throw new Error('DOM загружен, но Instagram не отдал данные профиля');
    }

    console.log(`[Enrich] DOM parser finished for @${username}`);
    return { ok: true, user };
  } catch (e) {
    console.error(`[Enrich] DOM parsing failed for @${username}:`, e.message);
    return { ok: false, fatal: false, message: 'Не удалось прочитать профиль из DOM: ' + e.message };
  }
}
async function igFetchProfile(username, options = {}) {
  // DOM-only enrichment. Keep the function signature for compatibility with
  // older callers, but never route a contact through the private Instagram API.
  const method = 'dom';
  console.log(`[Enrich] @${username}: method=${method}`);
  return await fetchDOMProfile(username, options);
}

// Accounts whose name or bio matches the phrase. One shot — Instagram's
// blended search does not page, it just returns its top hits.
async function igSearchKeyword(query) {
  const s = await igSearchSession();
  if (!s.ok) return s;

  const params = new URLSearchParams({ context: 'blended', query, include_reel: 'false' });
  const r = await igApiGet('/api/v1/fbsearch/topsearch/?' + params.toString(), s.cookies);
  if (!r.ok) return r;
  return searchResult(r, true);
}

// Authors posting under a hashtag.
async function igSearchHashtag(tag, cursor) {
  const s = await igSearchSession();
  if (!s.ok) return s;

  const params = new URLSearchParams({ tag_name: tag });
  if (cursor) params.set('max_id', cursor);
  const r = await igApiGet('/api/v1/tags/web_info/?' + params.toString(), s.cookies);
  if (!r.ok) return r;
  return searchResult(r, false);
}

// Resolve a place name to the numeric location id the feed endpoint wants.
async function igResolvePlace(query) {
  const s = await igSearchSession();
  if (!s.ok) return s;

  const r = await igApiGet('/api/v1/fbsearch/places/?query=' + encodeURIComponent(query), s.cookies);
  if (!r.ok) return r;

  const first = (r.data?.items || [])[0]?.place;
  const pk = first?.location?.pk ?? first?.location?.facebook_places_id ?? null;
  if (!pk) return { ok: true, ig_id: null, name: null };
  return { ok: true, ig_id: String(pk), name: first?.title || first?.location?.name || null };
}

// Authors posting from a place. The only source that yields geo Instagram
// itself confirmed, rather than geo inferred from a bio.
async function igSearchPlace(locationId, cursor) {
  const s = await igSearchSession();
  if (!s.ok) return s;

  const params = new URLSearchParams({ location_id: String(locationId), show_nearby: 'false' });
  if (cursor) params.set('max_id', cursor);
  const r = await igApiGet('/api/v1/locations/web_info/?' + params.toString(), s.cookies);
  if (!r.ok) return r;
  return searchResult(r, false);
}

// Instagram encodes message content differently per item type; anything we
// can't render as text becomes a short placeholder so the thread still reads
// sensibly in the inbox.
function igItemText(item) {
  if (!item) return '';
  switch (item.item_type) {
    case 'text': return item.text || '';
    case 'link': return item.link?.text || '[Ссылка]';
    case 'media': return '[Фото/Видео]';
    case 'raven_media': return '[Исчезающее фото]';
    case 'voice_media': return '[Голосовое]';
    case 'animated_media': return '[GIF]';
    case 'reel_share': return item.reel_share?.text || '[Reels]';
    case 'story_share': return '[Сторис]';
    case 'clip': return '[Клип]';
    case 'felix_share': return '[Видео]';
    case 'media_share': return '[Публикация]';
    case 'like': return '❤️';
    case 'action_log': return '';
    case 'placeholder': return '';
    default: return item.text || '';
  }
}

function normalizeIgThread(t, viewerId) {
  const users = t.users || [];
  if (users.length === 0) return null;
  const user = users[0];
  const myId = viewerId || String(t.viewer_id || '');

  const items = (t.items || []).filter(it =>
    it && it.item_type !== 'action_log' && it.item_type !== 'placeholder'
  );

  const messages = items.map(it => ({
    item_id: it.item_id,
    sender: myId && String(it.user_id) === myId ? 'me' : 'them',
    text: igItemText(it),
    timestamp: it.timestamp,
  })).filter(m => m.text);
  // Instagram returns newest-first; the inbox stores oldest-first.
  messages.reverse();

  const lastItem = items[0];
  let lastMessage = '';
  let sentByMe = false;
  if (lastItem) {
    lastMessage = igItemText(lastItem);
    if (myId && String(lastItem.user_id) === myId) {
      sentByMe = true;
      lastMessage = 'You: ' + lastMessage;
    }
  }

  let isUnread = false;
  if (!sentByMe) {
    if (t.read_state === 1) isUnread = true;
    const seenTs = t.last_seen_at?.[myId]?.timestamp;
    if (t.last_activity_at && seenTs && Number(t.last_activity_at) > Number(seenTs)) {
      isUnread = true;
    }
  }

  return {
    thread_id: t.thread_id,
    username: user.username || '',
    display_name: user.full_name || user.username || '',
    avatar_url: user.profile_pic_url || '',
    last_message: lastMessage,
    is_unread: isUnread,
    last_activity_at: t.last_activity_at || null,
    thread_url: '/direct/t/' + t.thread_id + '/',
    messages,
    viewer_id: myId,
  };
}

// Query parameters mirror what the real inbox UI sends. fetch_reason in
// particular distinguishes the first load from a scroll, and Instagram is
// noticeably happier with paginated requests that say which they are.
async function igFetchInboxPage(cursor, threadMessageLimit) {
  const cookies = await getIgCookiesReady();

  const params = new URLSearchParams({
    visual_message_return_type: 'unseen',
    thread_message_limit: String(threadMessageLimit || 20),
    persistentBadging: 'true',
    limit: '20',
    is_prefetching: 'false',
    fetch_reason: cursor ? 'page_scroll' : 'initial_snapshot',
    no_pending_badge: 'true',
  });
  if (cursor) {
    params.set('cursor', cursor);
    params.set('direction', 'older');
  }

  const r = await igApiGet('/api/v1/direct_v2/inbox/?' + params.toString(), cookies);
  if (!r.ok) return r;

  const viewerId = String(r.data?.viewer?.pk || r.data?.viewer?.pk_id || '');
  const threads = (r.data?.inbox?.threads || [])
    .map(t => normalizeIgThread(t, viewerId))
    .filter(Boolean);

  return {
    ok: true,
    threads,
    next_cursor: r.data?.inbox?.oldest_cursor || null,
    has_older: !!r.data?.inbox?.has_older,
  };
}

// ---------------------------------------------------------------------------
// Follower scraper loop (Lead Finder)
//
// Driven entirely by the backend: each /task response says what to do and how
// long to wait first, so pacing can't drift by editing this file. Waits go
// through the offscreen document so they aren't throttled when the browser is
// minimized or the monitor is off.
//
// Hard rules enforced here:
//   - never scrape while a campaign send is in flight (one IG action at a time)
//   - never scrape during an active rate-limit backoff
//   - any 429 or block signal stops the loop and pauses the job server-side
// ---------------------------------------------------------------------------
let scrapeLoopRunning = false;

// Scraping no longer needs an Instagram tab at all — requests go straight from
// the service worker with the session cookies. The tab-navigation helpers this
// file used to carry (open a tab, steer it onto the target profile so the
// page-context fetch had the right referer) are gone with them.

async function reportScrapeError(jobId, payload) {
  try {
    await fetch(`${getApiBase()}/lead-finder/task/${jobId}/error`, {
      method: 'POST',
      headers: wsHeaders(),
      body: JSON.stringify(payload),
    });
  } catch (e) {
    console.error('[Scrape] Could not report error:', e.message);
  }
}

async function maybeRunScrapeLoop() {
  if (scrapeLoopRunning) return;
  // Campaign sending owns Instagram while it's mid-send. Scraping waits.
  if (state.currentItem) return;
  if (igBusy) return;
  if (Date.now() < igRateLimitUntil) return;

  scrapeLoopRunning = true;
  let startedKeepAlive = false;

  try {
    while (true) {
      if (state.currentItem) {
        console.log('[Scrape] Campaign send started — yielding Instagram');
        break;
      }
      if (Date.now() < igRateLimitUntil) {
        console.log('[Scrape] Rate-limit backoff active — stopping loop');
        break;
      }

      let task = null;
      try {
        const res = await fetch(`${getApiBase()}/lead-finder/task`, {
          headers: deviceHeaders({ 'X-Workspace': currentWorkspace }),
        });
        if (!res.ok) break;
        const data = await res.json();
        task = data.task;
        if (!task) {
          if (data.message) console.log('[Scrape]', data.message);
          break;
        }
      } catch (e) {
        // Backend unreachable — try again on the next heartbeat.
        break;
      }

      if (!startedKeepAlive) {
        startKeepAlive();
        startedKeepAlive = true;
      }

      if (task.delay_ms > 0) {
        await offscreenDelayBg(task.delay_ms);
      }

      // Re-check after the wait: a campaign may have claimed Instagram, or
      // the user may have paused things while we slept.
      if (state.currentItem || Date.now() < igRateLimitUntil) break;

      igBusy = true;
      let response;
      try {
        if (task.type === 'resolve_target') {
          const r = await igFetchProfile(task.username);
          if (!r.ok) {
            response = { ok: false, error: r.message, rateLimited: r.rateLimited, fatal: r.fatal };
          } else if (r.user.is_private) {
            response = { ok: false, fatal: true, error: 'Профиль @' + task.username + ' закрытый — список подписчиков недоступен' };
          } else if (!r.user.id) {
            response = { ok: false, error: 'Не удалось получить ID профиля @' + task.username };
          } else {
            response = { ok: true, user_id: r.user.id, follower_total: r.user.follower_count };
          }
        } else if (task.type === 'fetch_followers') {
          const r = await igFetchFollowersPage(task.user_id, task.cursor, task.page_size);
          response = r.ok
            ? { ok: true, users: r.users, next_cursor: r.next_cursor, exhausted: r.exhausted }
            : { ok: false, error: r.message, rateLimited: r.rateLimited, fatal: r.fatal };
        } else if (task.type === 'enrich_profiles') {
          // Sequential with a pause before each lookup, including the first,
          // so consecutive batches don't run together.
          const profiles = [];
          let aborted = null;
          for (const uname of task.usernames) {
            const wait = (task.delay_min_ms || 3000) +
              Math.random() * ((task.delay_max_ms || 7000) - (task.delay_min_ms || 3000));
            await offscreenDelayBg(wait);

            const r = await igFetchProfile(uname);
            if (r.ok) {
              profiles.push({
                username: uname,
                user_id: r.user.id,
                full_name: r.user.full_name,
                bio: r.user.bio,
                follower_count: r.user.follower_count,
                following_count: r.user.following_count,
                post_count: r.user.post_count,
                external_url: r.user.external_url,
              });
              continue;
            }
            // A block or rate limit ends the batch; a per-profile failure
            // (deleted, renamed) is recorded and the batch continues.
            if (r.fatal || r.rateLimited) {
              aborted = { error: r.message, rateLimited: r.rateLimited, fatal: r.fatal };
              break;
            }
            profiles.push({ username: uname, error: r.message });
          }
          response = aborted
            ? { ok: false, ...aborted, profiles }
            : { ok: true, profiles };
        } else {
          console.warn('[Scrape] Unknown task type:', task.type);
          break;
        }
      } catch (e) {
        igBusy = false;
        lastIgTouch = Date.now();
        await reportScrapeError(task.job_id, { error_message: 'Ошибка запроса: ' + e.message });
        break;
      }
      igBusy = false;
      lastIgTouch = Date.now();

      if (!response?.ok) {
        const rateLimited = !!response?.rateLimited;
        const fatal = !!response?.fatal;
        if (rateLimited) {
          beginIgRateLimitBackoff('scrape');
        }
        if (fatal) {
          console.error('[Scrape] Block signal from Instagram:', response?.error);
        }
        // Salvage any profiles gathered before the batch aborted.
        if (task.type === 'enrich_profiles' && response?.profiles?.length) {
          try {
            await fetch(`${getApiBase()}/lead-finder/task/${task.job_id}/enriched`, {
              method: 'POST',
              headers: wsHeaders(),
              body: JSON.stringify({ profiles: response.profiles }),
            });
          } catch (e) {}
        }
        await reportScrapeError(task.job_id, {
          error_message: response?.error || 'Неизвестная ошибка',
          rate_limited: rateLimited,
          fatal,
        });
        break;
      }

      try {
        if (task.type === 'resolve_target') {
          await fetch(`${getApiBase()}/lead-finder/task/${task.job_id}/resolved`, {
            method: 'POST',
            headers: wsHeaders(),
            body: JSON.stringify({ user_id: response.user_id, follower_total: response.follower_total }),
          });
          console.log('[Scrape] Resolved @' + task.username + ' →', response.user_id,
            '(' + (response.follower_total ?? '?') + ' followers)');
        } else if (task.type === 'fetch_followers') {
          const r = await fetch(`${getApiBase()}/lead-finder/task/${task.job_id}/followers`, {
            method: 'POST',
            headers: wsHeaders(),
            body: JSON.stringify({
              users: response.users,
              next_cursor: response.next_cursor,
              exhausted: response.exhausted,
            }),
          });
          const d = await r.json().catch(() => ({}));
          console.log('[Scrape] Page: +' + (d.added ?? '?') + ' new, total ' + (d.total ?? '?'));
        } else if (task.type === 'enrich_profiles') {
          const r = await fetch(`${getApiBase()}/lead-finder/task/${task.job_id}/enriched`, {
            method: 'POST',
            headers: wsHeaders(),
            body: JSON.stringify({ profiles: response.profiles }),
          });
          const d = await r.json().catch(() => ({}));
          console.log('[Scrape] Enriched batch: ' + (d.ok ?? '?') + ' ok, ' + (d.failed ?? '?') + ' failed');
        }
      } catch (e) {
        // Result couldn't be saved. Stop rather than re-fetch the same page,
        // which would spend budget for nothing.
        console.error('[Scrape] Failed to save result:', e.message);
        break;
      }
    }
  } finally {
    scrapeLoopRunning = false;
    igBusy = false;
    // Only release keep-alive if a campaign isn't relying on it.
    if (startedKeepAlive && !state.running) {
      stopKeepAlive();
    }
  }
}

// ---------------------------------------------------------------------------
// AI lead search loop.
//
// Same contract as the scraper: the server hands out one task at a time with
// the delay already decided, and any block signal stops the loop and pauses
// the job server-side. It shares scrapeLoopRunning with the Lead Finder loop
// because both drive Instagram from the same session — two loops racing would
// double the request rate the server thinks it is enforcing.
// ---------------------------------------------------------------------------

async function reportSearchError(jobId, payload) {
  try {
    await fetch(`${getApiBase()}/lead-search/task/${jobId}/error`, {
      method: 'POST',
      headers: wsHeaders(),
      body: JSON.stringify(payload),
    });
  } catch (e) {
    console.error('[Search] Could not report error:', e.message);
  }
}

async function maybeRunSearchLoop() {
  if (scrapeLoopRunning) return;
  if (state.currentItem) return;
  if (igBusy) return;
  if (Date.now() < igRateLimitUntil) return;

  scrapeLoopRunning = true;
  let startedKeepAlive = false;

  try {
    while (true) {
      if (state.currentItem) {
        console.log('[Search] Campaign send started — yielding Instagram');
        break;
      }
      if (Date.now() < igRateLimitUntil) {
        console.log('[Search] Rate-limit backoff active — stopping loop');
        break;
      }

      let task = null;
      try {
        const res = await fetch(`${getApiBase()}/lead-search/task`, {
          headers: deviceHeaders({ 'X-Workspace': currentWorkspace }),
        });
        if (!res.ok) break;
        const data = await res.json();
        task = data.task;
        if (!task) {
          if (data.message) console.log('[Search]', data.message);
          // Server-side AI scoring reports progress with no task attached and
          // asks for an immediate re-poll. Everything else — budget spent, job
          // finished, nothing queued — ends the loop.
          if (data.retry) continue;
          break;
        }
      } catch (e) {
        break;
      }

      if (!startedKeepAlive) {
        startKeepAlive();
        startedKeepAlive = true;
      }

      if (task.delay_ms > 0) {
        await offscreenDelayBg(task.delay_ms);
      }
      if (state.currentItem || Date.now() < igRateLimitUntil) break;

      igBusy = true;
      let response;
      try {
        if (task.type === 'search_keyword') {
          const r = await igSearchKeyword(task.query);
          response = r.ok ? { ok: true, ...r } : { ok: false, error: r.message, rateLimited: r.rateLimited, fatal: r.fatal };
        } else if (task.type === 'search_hashtag') {
          const r = await igSearchHashtag(task.tag, task.cursor);
          response = r.ok ? { ok: true, ...r } : { ok: false, error: r.message, rateLimited: r.rateLimited, fatal: r.fatal };
        } else if (task.type === 'resolve_place') {
          const r = await igResolvePlace(task.query);
          response = r.ok ? { ok: true, ig_id: r.ig_id, name: r.name } : { ok: false, error: r.message, rateLimited: r.rateLimited, fatal: r.fatal };
        } else if (task.type === 'search_place') {
          const r = await igSearchPlace(task.location_id, task.cursor);
          response = r.ok ? { ok: true, ...r } : { ok: false, error: r.message, rateLimited: r.rateLimited, fatal: r.fatal };
        } else if (task.type === 'enrich_profiles') {
          const profiles = [];
          let aborted = null;
          for (const uname of task.usernames) {
            const wait = (task.delay_min_ms || 1000) +
              Math.random() * ((task.delay_max_ms || 3000) - (task.delay_min_ms || 1000));
            await offscreenDelayBg(wait);

            const r = await igFetchProfile(uname);
            if (r.ok) {
              profiles.push({
                username: uname,
                user_id: r.user.id,
                full_name: r.user.full_name,
                bio: r.user.bio,
                follower_count: r.user.follower_count,
                following_count: r.user.following_count,
                post_count: r.user.post_count,
                external_url: r.user.external_url,
                is_private: r.user.is_private,
              });
              continue;
            }
            if (r.fatal || r.rateLimited) {
              aborted = { error: r.message, rateLimited: r.rateLimited, fatal: r.fatal };
              break;
            }
            profiles.push({ username: uname, error: r.message });
          }
          response = aborted ? { ok: false, ...aborted, profiles } : { ok: true, profiles };
        } else {
          console.warn('[Search] Unknown task type:', task.type);
          break;
        }
      } catch (e) {
        igBusy = false;
        lastIgTouch = Date.now();
        await reportSearchError(task.job_id, {
          error_message: 'Ошибка запроса: ' + e.message,
          source_id: task.source_id,
        });
        break;
      }
      igBusy = false;
      lastIgTouch = Date.now();

      if (!response?.ok) {
        const rateLimited = !!response?.rateLimited;
        const fatal = !!response?.fatal;
        if (rateLimited) beginIgRateLimitBackoff('search');
        if (fatal) console.error('[Search] Block signal from Instagram:', response?.error);

        if (task.type === 'enrich_profiles' && response?.profiles?.length) {
          try {
            await fetch(`${getApiBase()}/lead-search/task/${task.job_id}/enriched`, {
              method: 'POST',
              headers: wsHeaders(),
              body: JSON.stringify({ profiles: response.profiles }),
            });
          } catch (e) {}
        }
        await reportSearchError(task.job_id, {
          error_message: response?.error || 'Неизвестная ошибка',
          rate_limited: rateLimited,
          fatal,
          source_id: task.source_id,
        });
        // A single dead source is retired server-side and the job carries on
        // with the rest; only an account-level signal ends the loop.
        if (!rateLimited && !fatal && task.source_id) continue;
        break;
      }

      try {
        if (task.type === 'resolve_place') {
          await fetch(`${getApiBase()}/lead-search/task/${task.job_id}/place-resolved`, {
            method: 'POST',
            headers: wsHeaders(),
            body: JSON.stringify({ source_id: task.source_id, ig_id: response.ig_id, name: response.name }),
          });
          console.log('[Search] Place "' + task.query + '" →', response.ig_id || 'не найдено');
        } else if (task.type === 'enrich_profiles') {
          const r = await fetch(`${getApiBase()}/lead-search/task/${task.job_id}/enriched`, {
            method: 'POST',
            headers: wsHeaders(),
            body: JSON.stringify({ profiles: response.profiles }),
          });
          const d = await r.json().catch(() => ({}));
          console.log('[Search] Enriched: ' + (d.ok ?? '?') + ' ok, ' + (d.failed ?? '?') + ' failed, ' + (d.scored ?? 0) + ' scored');
        } else {
          const r = await fetch(`${getApiBase()}/lead-search/task/${task.job_id}/discovered`, {
            method: 'POST',
            headers: wsHeaders(),
            body: JSON.stringify({
              source_id: task.source_id,
              users: response.users,
              next_cursor: response.next_cursor,
              exhausted: response.exhausted,
            }),
          });
          const d = await r.json().catch(() => ({}));
          console.log('[Search] ' + task.type + ': +' + (d.added ?? '?') + ' new, ' +
            (d.filtered_out ?? 0) + ' отсеяно, всего ' + (d.total ?? '?'));
        }
      } catch (e) {
        console.error('[Search] Failed to save result:', e.message);
        break;
      }
    }
  } finally {
    scrapeLoopRunning = false;
    igBusy = false;
    if (startedKeepAlive && !state.running) {
      stopKeepAlive();
    }
  }
}

// Contact enrichment — the last consumer in the chain, deliberately.
//
// It reads profiles to write the "конспект" that personalization later uses, so
// it is the only loop that can always be postponed without hurting a campaign.
// Every guard the search loop has is here too, and the server additionally
// refuses to hand out work while Lead Finder or AI Search are active — so a
// background run genuinely stays in the background, including when the
// browser is closed and only the service worker heartbeat is alive.

// Fallback spacing between two profiles *inside* one batch, used only if the
// server did not send a value. The server owns pacing — it ships this with the
// task so its own time estimate cannot drift from what actually runs.
const ENRICH_PROFILE_GAP_FALLBACK_MS = 15000;

// Told to the backend at most once per cooldown window: a 429 costs half an
// hour of silence, and a job frozen for that long with no explanation reads as
// "the extension is gone" rather than "Instagram said wait".
let enrichBackoffReported = false;

async function reportEnrichBackoff(jobId) {
  if (enrichBackoffReported || !jobId) return;
  enrichBackoffReported = true;
  try {
    await fetch(`${getApiBase()}/contact-enrich/task/${jobId}/error`, {
      method: 'POST',
      headers: wsHeaders(),
      body: JSON.stringify({
        error_message: 'Instagram ограничил запросы к профилям',
        rate_limited: true,
        resume_at: new Date(igRateLimitUntil).toISOString(),
      }),
    });
  } catch (e) {}
}

async function maybeRunEnrichLoop() {
  if (scrapeLoopRunning) return;
  if (state.currentItem) return;
  if (igBusy) return;

  scrapeLoopRunning = true;
  let startedKeepAlive = false;
  let served = 0;

  try {
    while (true) {
      if (state.currentItem) {
        console.log('[Enrich] Campaign send started — yielding Instagram');
        break;
      }

      let task = null;
      let taskData = null;
      try {
        const res = await fetch(`${getApiBase()}/contact-enrich/task`, {
          headers: deviceHeaders({ 'X-Workspace': currentWorkspace }),
        });
        // A silent `break` here is the reason "it just hangs" was unanswerable:
        // a 401 from an expired session or a 500 from a backend restart ended
        // the loop with nothing in the console to explain it.
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          // A 5xx/522 from production is an infrastructure failure, not a
          // campaign failure. If localhost is available, switch the extension
          // to the local backend and retry the same task immediately.
          if (BASE_URL !== API_BASE_BACKEND) {
            for (const fallbackBase of [API_BASE_LOCAL, API_BASE_BACKEND]) {
              try {
                const localRes = await fetch(`${fallbackBase}/contact-enrich/task`, {
                  headers: deviceHeaders({ 'X-Workspace': currentWorkspace }),
                  signal: AbortSignal.timeout(2500),
                });
                if (localRes.ok) {
                  BASE_URL = fallbackBase;
                  await chrome.storage.local.set({ iwApiBase: BASE_URL });
                  console.warn(`[Enrich] API unavailable; switched to local API: ${BASE_URL}`);
                  taskData = await localRes.json();
                  break;
                } else {
                  console.error(`[Enrich] fallback ${fallbackBase} failed: HTTP ${localRes.status}`);
                }
              } catch (fallbackError) {
                console.error(`[Enrich] fallback ${fallbackBase} failed:`, fallbackError.message);
              }
            }
          }
          if (!taskData) {
            console.error(`[Enrich] GET /task failed: HTTP ${res.status} ${body.slice(0, 200)}`);
            break;
          }
        } else {
          taskData = await res.json();
        }
        task = taskData.task;
        if (!task) {
          if (taskData.message) console.log('[Enrich]', taskData.message);
          else if (taskData.error) console.error('[Enrich] server error:', taskData.error);
          else if (!taskData.job_completed) console.log('[Enrich] нет активной задачи');
          break;
        }
      } catch (e) {
        console.error('[Enrich] GET /task network failure:', e.message);
        break;
      }

      served++;

      // Checked here, after the task is in hand, rather than before the loop
      // starts: bailing out any earlier meant the server never learned why the
      // job had stopped moving and went on reporting the extension as offline.
      if (Date.now() < igRateLimitUntil) {
        const mins = Math.ceil((igRateLimitUntil - Date.now()) / 60000);
        console.warn(`[Enrich] Instagram 429 — жду ${mins} мин перед следующей партией`);
        await reportEnrichBackoff(task.job_id);
        break;
      }
      // Past the cooldown: allow the next 429 to be reported again.
      enrichBackoffReported = false;

      console.log(
        `[Enrich] task #${task.job_id}: ${task.usernames?.length || 0} профиль(ей), ` +
        `пауза ${Math.round((task.delay_ms || 0) / 1000)} с${task.resting ? ' (отдых между блоками)' : ''}`
      );

      if (!startedKeepAlive) {
        startKeepAlive();
        startedKeepAlive = true;
      }

      if (task.delay_ms > 0) await offscreenDelayBg(task.delay_ms);
      if (state.currentItem || Date.now() < igRateLimitUntil) break;

      igBusy = true;
      let response;
      try {
        const profiles = [];
        let aborted = null;
        for (const [index, uname] of (task.usernames || []).entries()) {
          // Yield between profiles, not only between batches. Ten profile reads back to
          // back is the shape Instagram's checkpoint looks for, and the cost of
          // tripping it is an account that stops working for days. A campaign
          // that started during the gap wins: enrichment being last in the
          // chain is exactly why it can always stop.
          if (index > 0) {
            if (state.currentItem || Date.now() < igRateLimitUntil) break;
            await offscreenDelayBg(task.profile_gap_ms || ENRICH_PROFILE_GAP_FALLBACK_MS);
          }
          if (state.currentItem) break;

          const r = await igFetchProfile(uname, { withPosts: true, maxPosts: 12 });
          if (r.ok) {
            console.log(`[Enrich] @${uname}: прочитан, постов ${r.user.posts?.length || 0}, био ${r.user.bio ? 'есть' : 'нет'}`);
            profiles.push({
              username: uname,
              user_id: r.user.id,
              full_name: r.user.full_name,
              bio: r.user.bio,
              follower_count: r.user.follower_count,
              post_count: r.user.post_count,
              external_url: r.user.external_url,
              is_private: r.user.is_private,
              posts: r.user.posts,
            });
            continue;
          }
          if (r.fatal || r.rateLimited) {
            console.warn(`[Enrich] @${uname}: прерываю партию — ${r.message}`);
            aborted = { error: r.message, rateLimited: r.rateLimited, fatal: r.fatal };
            break;
          }
          console.warn(`[Enrich] @${uname}: ${r.message}`);
          profiles.push({ username: uname, error: r.message });
        }
        response = aborted ? { ok: false, ...aborted, profiles } : { ok: true, profiles };
      } catch (e) {
        console.error('[Enrich] profile read threw:', e.message);
        response = { ok: false, error: 'Ошибка чтения профиля: ' + e.message };
      }

      igBusy = false;
      lastIgTouch = Date.now();

      // Bank what we got even on a partial batch — the server generates the
      // notes inline from these rows and the loop simply continues.
      try {
        if (response.profiles?.length) {
          const r = await fetch(`${getApiBase()}/contact-enrich/task/${task.job_id}/scraped`, {
            method: 'POST',
            headers: wsHeaders(),
            body: JSON.stringify({ profiles: response.profiles }),
          });
          const d = await r.json().catch(() => ({}));
          if (!r.ok) console.error(`[Enrich] POST /scraped failed: HTTP ${r.status}`);
          console.log('[Enrich] сервер принял: прочитано ' + (d.ok ?? '?') + ', конспектов готово ' + (d.summarized ?? 0) +
            ', без данных ' + (d.failed ?? 0));
        }
      } catch (e) {
        console.error('[Enrich] Failed to save profiles:', e.message);
        break;
      }

      if (!response.ok && (response.rateLimited || response.fatal)) {
        if (response.rateLimited) beginIgRateLimitBackoff('search');
        try {
          await fetch(`${getApiBase()}/contact-enrich/task/${task.job_id}/error`, {
            method: 'POST',
            headers: wsHeaders(),
            body: JSON.stringify({
              error_message: response.error || 'Ограничение Instagram',
              rate_limited: !!response.rateLimited,
              // Sent so the job can say "Instagram is throttling until HH:MM"
              // instead of going quiet for half an hour and looking broken.
              resume_at: response.rateLimited ? new Date(igRateLimitUntil).toISOString() : undefined,
            }),
          });
        } catch (e) {}
        break;
      }
    }
  } finally {
    if (served > 0) {
      console.log(`[Enrich] цикл завершён: обработано партий ${served}`);
    }
    scrapeLoopRunning = false;
    igBusy = false;
    if (startedKeepAlive && !state.running) stopKeepAlive();
  }
}

// Lead Finder first, then AI search, then contact enrichment — one Instagram
// engine at a time, cheapest-to-defer last. The server enforces the same
// ordering, this just avoids a pointless poll.
async function runIgJobLoops() {
  await maybeRunScrapeLoop();
  await maybeRunSearchLoop();
  await maybeRunEnrichLoop();
}

// Background-side unthrottled delay. The offscreen document owns the timer, so
// it keeps correct time while the window is minimized.
function offscreenDelayBg(ms) {
  return new Promise((resolve) => {
    ensureOffscreen().then(() => {
      try {
        chrome.runtime.sendMessage({ type: 'DELAY_REQUEST', ms }, () => {
          if (chrome.runtime.lastError) setTimeout(resolve, ms);
          else resolve();
        });
      } catch (e) {
        setTimeout(resolve, ms);
      }
    }).catch(() => setTimeout(resolve, ms));
  });
}

async function reloadFrontendTabs() {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://instalead.ru/*' });
    for (const tab of tabs) {
      chrome.tabs.reload(tab.id).catch(() => {});
    }
  } catch (e) {}
}

function notifyPopup(data) {
  chrome.runtime.sendMessage({ ...data, source: 'background' }).catch(() => {});
}
