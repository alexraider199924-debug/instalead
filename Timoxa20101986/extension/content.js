// Wrapped in an IIFE with a load guard so background.js can re-inject this
// file into tabs that predate an extension reload. Without the wrapper, a
// second injection would hit "Identifier 'API_BASE' has already been declared"
// and fail; without the guard it would double-register the message listener.
(function () {
if (window.__instaleadContentLoaded) {
  console.log('[Instalead] content script already active in this tab');
  return;
}
window.__instaleadContentLoaded = true;


let currentItem = null;
let sendAttempts = 0;
const MAX_ATTEMPTS = 3;
const CONTENT_SCRIPT_VERSION = 'profile-scrape-v2';

// Per-item record of how each Instagram action went, reported to background so
// the circuit breaker can count failure streaks separately per action type.
// A run of failed likes must not trip the DM breaker: on a limited account the
// failing action type is the one being limited, while others keep working.
let actionOutcomes = {};


// The logged-in account's numeric id, straight from the auth cookie. This is
// the ground truth of "who am I" — it can never be a DM contact, unlike
// anything scraped from the DOM.
function getLoggedInUserId() {
  const m = document.cookie.match(/(?:^|;\s*)ds_user_id=(\d+)/);
  return m ? m[1] : null;
}

function detectInstagramUsername() {
  const myId = getLoggedInUserId();

  // 1) Strongest signal: find the username that sits next to OUR own id
  //    (ds_user_id) in the page's JSON. Because the id comes from the auth
  //    cookie, this can only ever resolve to the account owner — never a
  //    person from the Direct inbox. The {0,300} window with no braces keeps
  //    the username and id inside the same small JSON object.
  if (myId) {
    try {
      const idRe = new RegExp(
        '"username"\\s*:\\s*"([^"]+)"[^{}]{0,300}?"(?:pk|pk_id|id|user_id|USER_ID)"\\s*:\\s*"?' + myId + '\\b' +
        '|"(?:pk|pk_id|id|user_id|USER_ID)"\\s*:\\s*"?' + myId + '\\b[^{}]{0,300}?"username"\\s*:\\s*"([^"]+)"'
      );
      const scripts = document.querySelectorAll('script:not([src])');
      for (const s of scripts) {
        const text = s.textContent || '';
        if (!text.includes(myId)) continue;
        const m = text.match(idRe);
        if (m) return m[1] || m[2];
      }
    } catch (e) {}
  }

  // 2) CurrentUserInitialData — Instagram's own bootstrap blob for the logged-in
  //    user. Always the owner.
  try {
    const scripts = document.querySelectorAll('script:not([src])');
    for (const s of scripts) {
      const text = s.textContent || '';
      const m = text.match(/"CurrentUserInitialData"\s*:\s*\{[^{}]*"username"\s*:\s*"([^"]+)"/);
      if (m) return m[1];
    }
  } catch (e) {}

  // 3) Legacy _sharedData viewer.
  try {
    if (window._sharedData?.config?.viewer?.username) {
      return window._sharedData.config.viewer.username;
    }
  } catch (e) {}

  // 4) "viewer":{...,"username":...} in inline JSON.
  try {
    const scripts = document.querySelectorAll('script:not([src])');
    for (const s of scripts) {
      const text = s.textContent || '';
      if (text.includes('"viewer"') && text.includes('"username"')) {
        const m = text.match(/"viewer"\s*:\s*\{[^}]*"username"\s*:\s*"([^"]+)"/);
        if (m) return m[1];
      }
    }
  } catch (e) {}

  // 5) Last resort: the own-profile link, but ONLY inside the main navigation.
  //    The nav's profile link always points at the account owner. The old code
  //    scanned the WHOLE page and grabbed the first avatar link — on a /direct/
  //    page that is a chat partner, which is exactly how someone else's handle
  //    ended up connected. Restricting to <nav>/[role=navigation] avoids that.
  const EXCLUDE = /^\/(explore|reels|messages|direct|notifications|accounts|p\/|reel\/|tv\/|stories\/|inbox\/)/;
  const navs = document.querySelectorAll('nav, [role="navigation"]');
  for (const nav of navs) {
    for (const a of nav.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href') || '';
      if (/^\/[a-zA-Z0-9_.]{1,30}\/$/.test(href) && !EXCLUDE.test(href) && a.querySelector('img')) {
        return href.slice(1, -1);
      }
    }
    for (const a of nav.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href') || '';
      const label = (a.getAttribute('aria-label') || a.title || '').toLowerCase();
      if (/^\/[a-zA-Z0-9_.]{1,30}\/$/.test(href) && !EXCLUDE.test(href) &&
          (label.includes('profile') || label.includes('профил'))) {
        return href.slice(1, -1);
      }
    }
  }

  // 6) Broad fallback (the original behaviour): scan every avatar profile link
  //    on the page. Instagram's layout doesn't always put the own-profile link
  //    inside a <nav>, so without this the detector comes up empty and the
  //    account reads as "not connected". This is SKIPPED on the Direct inbox,
  //    where these links point at chat partners — the one place the old global
  //    scan grabbed the wrong username. Everywhere else the own nav avatar is
  //    the reliable first hit.
  const onDirect = /^\/direct(\/|$)/.test(location.pathname);
  if (!onDirect) {
    const allLinks = document.querySelectorAll('a[href]');
    for (const a of allLinks) {
      const href = a.getAttribute('href') || '';
      if (/^\/[a-zA-Z0-9_.]{1,30}\/$/.test(href) && !EXCLUDE.test(href) && a.querySelector('img')) {
        return href.slice(1, -1);
      }
    }
    for (const a of allLinks) {
      const href = a.getAttribute('href') || '';
      const label = (a.getAttribute('aria-label') || a.title || '').toLowerCase();
      if (/^\/[a-zA-Z0-9_.]{1,30}\/$/.test(href) && !EXCLUDE.test(href) &&
          (label.includes('profile') || label.includes('профил'))) {
        return href.slice(1, -1);
      }
    }
  }

  return null;
}

let _lastReportedUsername = null;

function reportUsername() {
  const username = detectInstagramUsername();
  if (username && username !== _lastReportedUsername) {
    _lastReportedUsername = username;
    chrome.runtime.sendMessage({ type: 'IG_ACCOUNT', username }).catch(() => {});
  }
}

reportUsername();

let _prevHref = location.href;
const _navObserver = new MutationObserver(() => {
  if (location.href !== _prevHref) {
    _prevHref = location.href;
    setTimeout(reportUsername, 1500);
  }
});
_navObserver.observe(document.body, { childList: true, subtree: true });

setTimeout(reportUsername, 2000);
setTimeout(reportUsername, 5000);

function detectActionBlock() {
  const bodyText = document.body?.innerText || '';
  // Hard-block phrases — Instagram explicitly telling the user their
  // actions are being restricted. Continuing is a fast path to a full ban.
  const hardBlockPhrases = [
    'action blocked', 'try again later', 'we restrict certain activity',
    'действие заблокировано', 'повторите попытку позже', 'мы ограничиваем',
    'temporarily blocked', 'temporarily restricted',
    'your account has been temporarily',
    'we limit how often', 'to protect our community',
    // The exact wording Instagram shows when its automation classifier trips.
    // Seeing this means the account is already flagged; every further action
    // deepens it, so it's a hard stop.
    'suspect automated behavior', 'suspected automated behavior',
    'подозрительн', 'автоматизированн',
    // The "We suspect your account is managed automatically" modal — a distinct,
    // stronger warning whose wording ("управляется автоматически" / "managed
    // automatically") the phrases above did NOT match, so the extension kept
    // sending straight through it. Match it explicitly, in both languages.
    'управляется автоматически', 'подозреваем, что ваша',
    'учетная запись управляется', 'учётная запись управляется',
    'managed automatically', 'account is being managed', 'we suspect your account'
  ];
  // Soft-block phrases — the profile grid is failing to render, tab title
  // shows "Page couldn't load". Instagram hasn't shown an explicit modal
  // but the session is clearly flagged. Continuing to send in this state
  // is what escalates a soft block to a permanent one, so we stop the
  // campaign the same way we would on a hard block.
  const softBlockPhrases = [
    "something went wrong",
    "there's an issue and the page could not be loaded",
    'page could not be loaded',
    "page couldn't load",
    "something's not right",
    'что-то пошло не так',
    'не удалось загрузить страницу',
    'страницу не удалось загрузить',
  ];
  const lower = bodyText.toLowerCase();
  for (const phrase of hardBlockPhrases) {
    if (lower.includes(phrase)) return phrase;
  }
  // Soft-block phrases are broader and could theoretically appear inside a
  // user's own bio or a comment. Require the accompanying "Reload page"
  // button (Instagram's error-UI signature) before treating it as a block.
  const hasReloadButton = lower.includes('reload page') || lower.includes('перезагрузить страницу');
  if (hasReloadButton) {
    for (const phrase of softBlockPhrases) {
      if (lower.includes(phrase)) return 'soft-block: ' + phrase;
    }
  }
  // Tab title / document title is another strong signal — Instagram sets it
  // to "Page couldn't load" when the API behind the page fails. That title
  // isn't user content, so no false-positive risk.
  const title = (document.title || '').toLowerCase();
  if (title.includes("page couldn't load") || title.includes('page couldn’t load')) {
    return 'soft-block: page title says couldn\'t load';
  }

  const dialogs = document.querySelectorAll('div[role="dialog"], div[role="alertdialog"]');
  for (const dialog of dialogs) {
    const text = (dialog.innerText || '').toLowerCase();
    for (const phrase of hardBlockPhrases) {
      if (text.includes(phrase)) return phrase;
    }
  }

  return null;
}

function checkForActionBlock() {
  const blocked = detectActionBlock();
  if (blocked) {
    console.error('[Instalead] ACTION BLOCKED detected:', blocked);
    chrome.runtime.sendMessage({
      type: 'ACTION_BLOCKED',
      reason: blocked,
      cl_id: currentItem?.cl_id,
      campaign_id: currentItem?.campaign_id
    }).catch(() => {});
    showOverlay('Instagram blocked actions! Campaign paused.', 'error');
    currentItem = null;
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Inbox scraping from the page context.
//
// This runs inside an open instagram.com tab, so its fetch inherits the real
// page's cookies, referer and same-origin context — which Instagram trusts
// more than a bare service-worker request. It tries the private inbox API
// first and falls back to reading the rendered thread list from the DOM when
// the API returns nothing. The service worker keeps a header-rich API path of
// its own as a last resort when no Instagram tab is open.
// ---------------------------------------------------------------------------
function findInboxScrollContainer() {
  const threadLinks = document.querySelectorAll('a[href*="/direct/t/"]');

  if (threadLinks.length > 0) {
    let el = threadLinks[0].parentElement;
    while (el && el !== document.body) {
      const style = window.getComputedStyle(el);
      const ov = style.overflowY || style.overflow;
      if ((ov === 'auto' || ov === 'scroll') && el.scrollHeight > el.clientHeight + 20) {
        return el;
      }
      el = el.parentElement;
    }

    el = threadLinks[0].parentElement;
    while (el && el !== document.body) {
      if (el.scrollHeight > el.clientHeight + 20 && el.clientHeight > 200) {
        return el;
      }
      el = el.parentElement;
    }
  }

  const items = document.querySelectorAll('[role="listitem"], [role="row"], [role="option"]');
  if (items.length > 5) {
    let el = items[0].parentElement;
    while (el && el !== document.body) {
      if (el.scrollHeight > el.clientHeight + 20 && el.clientHeight > 100) {
        return el;
      }
      el = el.parentElement;
    }
  }

  const allDivs = document.querySelectorAll('div[role="main"] div, section div');
  for (const div of allDivs) {
    if (div.scrollHeight > div.clientHeight + 100 && div.clientHeight > 200) {
      const its = div.querySelectorAll('[role="listitem"], [role="row"]');
      if (its.length >= 3) return div;
    }
  }

  return null;
}

function collectVisibleThreads(conversations, seen) {
  let threadItems = document.querySelectorAll('a[href*="/direct/t/"]');

  if (threadItems.length === 0) {
    threadItems = document.querySelectorAll('[role="listitem"]');
  }

  for (const item of threadItems) {
    let container = item;
    let href = '';

    if (item.tagName === 'A') {
      href = item.getAttribute('href') || '';
      container = item.closest('[role="listitem"]') || item.closest('[role="row"]') || item;
    } else {
      const link = item.querySelector('a[href*="/direct/"]');
      if (link) href = link.getAttribute('href') || '';
      container = item;
    }

    const dedupeKey = href || container.textContent.slice(0, 50);
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const threadMatch = href.match(/\/direct\/t\/(\d+)/);
    const threadId = threadMatch ? threadMatch[1] : null;

    let displayName = '';
    let username = '';
    let avatarUrl = '';
    let lastMessage = '';
    let isUnread = false;

    const imgs = container.querySelectorAll('img');
    for (const img of imgs) {
      const src = img.getAttribute('src') || '';
      const alt = (img.getAttribute('alt') || '').trim();

      if (src && src.startsWith('http') && !avatarUrl) {
        avatarUrl = src;
      }

      if (alt) {
        let profileMatch = alt.match(/^(.+?)['’]s profile/i);
        if (!profileMatch) profileMatch = alt.match(/^фото профиля\s+(.+)$/i);
        if (!profileMatch) profileMatch = alt.match(/^(.+?)['’]s? profil/i);

        if (profileMatch) {
          const extracted = profileMatch[1].trim();
          if (extracted) {
            if (/^[a-zA-Z0-9_.]{2,30}$/.test(extracted) && !username) {
              username = extracted;
            }
            if (!displayName) displayName = extracted;
          }
        } else if (alt.length > 0 && alt.length < 80) {
          const altLower = alt.toLowerCase();
          if (!altLower.includes('profile') && !altLower.includes('профил') && !altLower.includes('avatar')) {
            if (!displayName) displayName = alt;
          }
        }
      }
    }

    const spans = container.querySelectorAll('span');
    const spanTexts = [];
    for (const span of spans) {
      const text = (span.textContent || '').trim();
      if (!text || text.length === 0 || text.length > 100) continue;
      if (/^\d+\s*(m|h|d|w|s|min|hr|sec|мин|ч|д|н|с)\b/.test(text)) continue;
      if (/^(Active|Активн|Online|В сети|Typing|Печатает|Seen|Просмотр)/i.test(text)) continue;
      if (text === '·' || text === '•' || text === 'You:' || text === 'Вы:') continue;
      if (/^\d{1,3}$/.test(text)) continue;
      spanTexts.push({ el: span, text });
    }

    for (const { text } of spanTexts) {
      if (/^[a-zA-Z0-9_.]{2,30}$/.test(text) && !username) {
        username = text;
        if (!displayName) displayName = text;
        continue;
      }
      if (text.startsWith('@') && text.length > 2) {
        username = text.slice(1);
        continue;
      }
    }

    if (!displayName && spanTexts.length > 0) {
      displayName = spanTexts[0].text;
    }

    const autoSpans = container.querySelectorAll('span[dir="auto"]');
    const msgCandidates = [];
    for (const span of autoSpans) {
      const text = (span.textContent || '').trim();
      if (!text || text.length < 2 || text.length >= 200) continue;
      if (text === displayName || text === username) continue;
      if (/^\d{1,3}$/.test(text)) continue;

      const parentText = (span.parentElement?.textContent || '').trim();
      if (parentText.startsWith('You:') || parentText.startsWith('Вы:')) {
        msgCandidates.push('You: ' + text);
      } else {
        msgCandidates.push(text);
      }
    }
    if (msgCandidates.length > 0) {
      lastMessage = msgCandidates[msgCandidates.length - 1];
    }

    for (const { el } of spanTexts) {
      try {
        const weight = window.getComputedStyle(el).fontWeight;
        if (Number(weight) >= 600 || weight === 'bold') {
          isUnread = true;
          break;
        }
      } catch (e) {}
    }

    if (!isUnread) {
      const dots = container.querySelectorAll('div, span');
      for (const dot of dots) {
        try {
          const s = window.getComputedStyle(dot);
          const bg = s.backgroundColor;
          if ((bg === 'rgb(0, 149, 246)' || bg === 'rgb(0, 100, 224)') &&
              dot.offsetWidth >= 4 && dot.offsetWidth <= 14 &&
              dot.offsetHeight >= 4 && dot.offsetHeight <= 14) {
            isUnread = true;
            break;
          }
        } catch (e) {}
      }
    }

    if (displayName || username) {
      conversations.push({
        thread_id: threadId,
        username: username || '',
        display_name: displayName || username || '',
        avatar_url: avatarUrl || '',
        last_message: lastMessage,
        is_unread: isUnread,
        thread_url: href
      });
    }
  }
}

function extractItemText(item) {
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

async function scrapeDirectInboxViaAPI(maxPages) {
  const conversations = [];

  try {
    let cursor = null;
    let hasMore = true;
    let pageNum = 0;
    const MAX_PAGES = Math.max(1, Math.min(Number(maxPages) || 5, 10));

    while (hasMore && pageNum < MAX_PAGES) {
      let url = '/api/v1/direct_v2/inbox/?thread_message_limit=50&persistentBadging=true&limit=50';
      if (cursor) url += '&cursor=' + encodeURIComponent(cursor);

      let res;
      try {
        res = await fetch(url, { method: 'GET', headers: igApiHeaders(), credentials: 'include' });
      } catch (e) {
        console.error('[Instalead] Inbox API fetch failed:', e.message);
        return conversations.length > 0 ? conversations : [];
      }

      if (res.status === 429) {
        console.warn('[Instalead] Instagram rate limited (429)');
        return conversations.length > 0 ? conversations : { rateLimited: true };
      }
      if (!res.ok) {
        console.error('[Instalead] Inbox API HTTP', res.status);
        return conversations.length > 0 ? conversations : [];
      }

      const data = await res.json();
      const viewerId = String(data.viewer?.pk || data.viewer?.pk_id || '');
      const threads = data.inbox?.threads || [];
      hasMore = !!data.inbox?.has_older;
      cursor = data.inbox?.oldest_cursor || null;
      pageNum++;

      for (const t of threads) {
        const users = t.users || [];
        if (users.length === 0) continue;
        const myId = viewerId || String(t.viewer_id || '');
        // In group threads Instagram includes the viewer in users. Choose the
        // first real participant, never the signed-in account itself.
        const user = users.find(u => String(u?.pk || u?.pk_id || u?.id || '') !== myId) || users[0];

        const items = (t.items || []).filter(it =>
          it && it.item_type !== 'action_log' && it.item_type !== 'placeholder'
        );

        const messages = items.map(it => ({
          item_id: it.item_id,
          sender: myId && String(it.user_id) === myId ? 'me' : 'them',
          text: extractItemText(it),
          timestamp: it.timestamp
        })).filter(m => m.text);
        messages.reverse();

        const lastItem = items[0];
        let lastMessage = '';
        let sentByMe = false;
        if (lastItem) {
          lastMessage = extractItemText(lastItem);
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

        conversations.push({
          thread_id: t.thread_id,
          username: user.username || '',
          display_name: user.full_name || user.username || '',
          avatar_url: user.profile_pic_url || '',
          last_message: lastMessage,
          is_unread: isUnread,
          last_activity_at: t.last_activity_at || null,
          thread_url: '/direct/t/' + t.thread_id + '/',
          messages,
          viewer_id: myId
        });
      }

      if (hasMore && cursor) {
        await new Promise(r => setTimeout(r, 2000 + Math.random() * 1500));
      }
    }

    console.log('[Instalead] Inbox scraped:', conversations.length, 'conversations in', pageNum, 'pages');
    return conversations;
  } catch (e) {
    console.error('[Instalead] scrapeDirectInboxViaAPI error:', e);
    return conversations.length > 0 ? conversations : [];
  }
}

async function scrapeDirectInbox(maxPages) {
  const apiResults = await scrapeDirectInboxViaAPI(maxPages);

  if (apiResults?.rateLimited) return apiResults;
  if (apiResults && apiResults.length > 0) return apiResults;

  console.log('[Instalead] Inbox API returned 0, falling back to DOM scraping');
  const conversations = [];
  const seen = new Set();

  try {
    let waitAttempts = 0;
    while (waitAttempts < 15) {
      const links = document.querySelectorAll('a[href*="/direct/t/"]');
      if (links.length > 0) break;
      await sleep(600);
      waitAttempts++;
    }

    const scrollContainer = findInboxScrollContainer();
    if (scrollContainer) {
      scrollContainer.scrollTop = 0;
      await sleep(500);
    }

    collectVisibleThreads(conversations, seen);

    if (scrollContainer && scrollContainer.scrollHeight > scrollContainer.clientHeight + 20) {
      let noNewCount = 0;
      let scrollAttempts = 0;
      while (noNewCount < 5 && scrollAttempts < 100) {
        const before = conversations.length;
        scrollContainer.scrollTop += scrollContainer.clientHeight * 0.8;
        await sleep(900);
        collectVisibleThreads(conversations, seen);
        scrollAttempts++;
        if (conversations.length === before) noNewCount++;
        else noNewCount = 0;
      }
      scrollContainer.scrollTop = 0;
    }
  } catch (e) {
    console.error('[Instalead] DOM fallback error:', e);
  }

  return conversations;
}

const IG_APP_ID = '936619743392459';

function getCsrfToken() {
  return document.cookie.split(';')
    .find(c => c.trim().startsWith('csrftoken='))
    ?.split('=')[1] || '';
}

// Keep this minimal. Adding X-ASBD-ID / X-Instagram-AJAX made Instagram
// reject sends with {"message":"useragent mismatch"} — these are the only
// headers the web client actually needs.
function igApiHeaders(extra) {
  const h = {
    'X-IG-App-ID': IG_APP_ID,
    'X-CSRFToken': getCsrfToken(),
    'X-Requested-With': 'XMLHttpRequest',
    'Accept': '*/*'
  };
  return Object.assign(h, extra || {});
}

function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

async function resolveUserId(username) {
  const res = await fetch(
    '/api/v1/users/web_profile_info/?username=' + encodeURIComponent(username),
    { headers: igApiHeaders(), credentials: 'include' }
  );
  if (res.redirected && res.url.includes('/accounts/login')) {
    throw new Error('Instagram требует вход — откройте instagram.com и залогиньтесь');
  }
  if (!res.ok) throw new Error('Не удалось найти @' + username + ' (HTTP ' + res.status + ')');
  const data = await res.json();
  const id = data?.data?.user?.id;
  if (!id) throw new Error('Не найден user id для @' + username);
  return String(id);
}

async function sendMessageViaAPI(threadId, text, username, knownUserId) {
  if (!text) throw new Error('Missing text');

  const clientContext = generateUUID();
  const body = new URLSearchParams();
  body.append('action', 'send_item');

  if (threadId) {
    body.append('thread_ids', JSON.stringify([String(threadId)]));
  } else if (knownUserId || username) {
    // Conversations created by a campaign have no thread id yet — address the
    // recipient directly and let Instagram open/reuse the thread.
    const userId = knownUserId || await resolveUserId(username);
    body.append('recipient_users', JSON.stringify([[String(userId)]]));
  } else {
    throw new Error('Missing thread_id and username');
  }

  body.append('text', text);
  body.append('client_context', clientContext);
  body.append('mutation_token', clientContext);
  body.append('offline_threading_id', clientContext);

  console.log('[Instalead] Sending via API', threadId ? 'thread ' + threadId : 'user @' + username);

  const res = await fetch('/api/v1/direct_v2/threads/broadcast/text/', {
    method: 'POST',
    headers: {
      ...igApiHeaders(),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: body.toString(),
    credentials: 'include'
  });

  // A rate-limited or unauthenticated call gets bounced to the login page,
  // which then answers 429 — report that plainly instead of "HTTP 429".
  if (res.redirected && res.url.includes('/accounts/login')) {
    throw new Error('Instagram отклонил отправку (лимит запросов или сессия). Подождите и попробуйте снова.');
  }

  const raw = await res.text();
  if (res.status === 429) {
    throw new Error('429: Instagram временно ограничил запросы. Подождите 10-15 минут.');
  }
  if (!res.ok) {
    throw new Error('HTTP ' + res.status + ': ' + raw.slice(0, 200));
  }

  let data;
  try { data = JSON.parse(raw); } catch { data = {}; }
  if (data.status && data.status !== 'ok') {
    throw new Error('IG status: ' + data.status + ' ' + (data.message || ''));
  }

  const newThreadId =
    data?.payload?.thread_id ||
    data?.payload?.item?.thread_id ||
    (Array.isArray(data?.payload?.threads) ? data.payload.threads[0]?.thread_id : null) ||
    threadId ||
    null;

  console.log('[Instalead] Message sent via API successfully, thread', newThreadId);
  return { data, thread_id: newThreadId };
}

// Profile data without loading the profile page, so personalization still
// works when the DOM flow is unavailable.
async function fetchProfileViaAPI(username) {
  const empty = { bio: '', posts: [], followers: '', fullName: '', userId: null };
  try {
    const res = await fetch(
      '/api/v1/users/web_profile_info/?username=' + encodeURIComponent(username),
      { headers: igApiHeaders(), credentials: 'include' }
    );
    if (res.redirected && res.url.includes('/accounts/login')) {
      throw new Error('Instagram требует вход — откройте instagram.com и залогиньтесь');
    }
    if (!res.ok) {
      // Returning `empty` keeps the send flow alive, but log the real reason:
      // a silent 400 here means personalization runs with no profile data,
      // which quietly degrades every AI-generated message.
      const body = await res.text().catch(() => '');
      console.error('[Instalead] web_profile_info HTTP ' + res.status + ' for @' + username +
        ' — personalization will have no profile data. Body: ' + body.slice(0, 200));
      return empty;
    }

    const data = await res.json();
    const u = data?.data?.user;
    if (!u) return empty;

    const posts = (u.edge_owner_to_timeline_media?.edges || [])
      .slice(0, 5)
      .map(e => e.node?.edge_media_to_caption?.edges?.[0]?.node?.text || '')
      .filter(Boolean);

    return {
      bio: u.biography || '',
      posts,
      followers: String(u.edge_followed_by?.count || ''),
      fullName: u.full_name || '',
      userId: u.id ? String(u.id) : null
    };
  } catch (e) {
    console.error('[Instalead] fetchProfileViaAPI error:', e.message);
    return empty;
  }
}

// Timer-free send path used when the browser window is minimized. The DOM flow
// types character by character, which Chrome throttles to a crawl in a hidden
// tab; this is a single request instead.
async function sendDMViaAPI(item) {
  if (!item?.username) throw new Error('Missing username');

  const profile = await fetchProfileViaAPI(item.username);
  let message = item.message;

  if (item.needs_personalization) {
    try {
      const result = await new Promise((resolve) => {
        chrome.runtime.sendMessage(
          { type: 'PERSONALIZE', cl_id: item.cl_id, profileData: profile },
          (response) => resolve(response || {})
        );
      });
      if (result.message) {
        message = result.message;
      } else if (result.error) {
        throw new Error('Персонализация не выполнена: ' + result.error);
      } else {
        throw new Error('Персонализация не вернула сообщение');
      }
    } catch (e) {
      console.error('[Instalead] personalization error:', e);
      throw e;
    }
  }

  if (!message) throw new Error('Empty message');

  await sendMessageViaAPI(null, message, item.username, profile.userId);
  chrome.runtime.sendMessage({ type: 'ITEM_SENT', cl_id: item.cl_id, message });
  console.log('[Instalead] DM sent via API to @' + item.username);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'SEND_DM') {
    currentItem = msg.item;
    sendAttempts = 0;
    actionOutcomes = {};
    showOverlay('Preparing @' + msg.item.username + '...');
    setTimeout(() => startDMFlow(), 2000 + Math.random() * 1500);
    sendResponse({ ok: true });
  }

  if (msg.type === 'SCRAPE_INBOX') {
    (async () => {
      try {
        const result = await scrapeDirectInbox(msg.maxPages);
        if (result?.rateLimited) {
          sendResponse({ conversations: [], rateLimited: true });
          return;
        }
        const conversations = result || [];
        console.log('[Instalead] SCRAPE_INBOX done:', conversations.length, 'conversations');
        sendResponse({ conversations });
      } catch (e) {
        console.error('[Instalead] SCRAPE_INBOX error:', e);
        sendResponse({ conversations: [], error: e.message });
      }
    })();
    return true;
  }

  if (msg.type === 'SEND_VIA_API') {
    console.log('[Instalead] SEND_VIA_API received, thread_id:', msg.thread_id, 'user:', msg.username);
    (async () => {
      try {
        const result = await sendMessageViaAPI(msg.thread_id, msg.text, msg.username);
        sendResponse({ ok: true, thread_id: result.thread_id });
      } catch (e) {
        console.error('[Instalead] SEND_VIA_API error:', e);
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  if (msg.type === 'PING') {
    sendResponse({ ok: true, url: window.location.href, version: CONTENT_SCRIPT_VERSION });
    return;
  }

  if (msg.type === 'SCRAPE_PROFILE') {
    (async () => {
      try {
        const waitMs = Math.max(0, Math.min(Number(msg.waitMs || 1200), 5000));
        if (waitMs) await new Promise(resolve => setTimeout(resolve, waitMs));
        const profileData = await scrapeProfileDataAsync();
        console.log('[Instalead] SCRAPE_PROFILE:', profileData);
        sendResponse({ ok: true, data: profileData, url: location.href });
      } catch (e) {
        console.error('[Instalead] SCRAPE_PROFILE error:', e);
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }
});

function parseCount(value) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  const normalized = text.replace(/,/g, '');
  const m = normalized.match(/([0-9.]+)\s*([KMB])?/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const suffix = (m[2] || '').toUpperCase();
  const mult = suffix === 'K' ? 1e3 : suffix === 'M' ? 1e6 : suffix === 'B' ? 1e9 : 1;
  return Math.round(n * mult);
}

function decodeInstagramJsonString(value) {
  try { return JSON.parse('"' + String(value || '').replace(/"/g, '\\"') + '"'); } catch { return String(value || ''); }
}

function collectEmbeddedCaptions(html, limit = 12) {
  const out = [];
  const seen = new Set();
  const source = String(html || '');
  const patterns = [
    /"edge_media_to_caption"\s*:\s*\{\s*"edges"\s*:\s*\[\s*\{\s*"node"\s*:\s*\{\s*"text"\s*:\s*"((?:\\.|[^"\\])*)"/g,
    /"caption"\s*:\s*\{\s*"text"\s*:\s*"((?:\\.|[^"\\])*)"/g,
    /"caption"\s*:\s*"((?:\\.|[^"\\])*)"/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(source)) && out.length < limit) {
      let text = m[1] || '';
      try { text = JSON.parse('"' + text + '"'); } catch {}
      text = text.replace(/\\n/g, ' ').replace(/\\r/g, ' ').replace(/\s+/g, ' ').trim();
      if (text.length < 12) continue;
      const key = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '').slice(0, 80);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(text.slice(0, 600));
    }
  }
  return out;
}


async function waitForPostDialog(timeoutMs = 4500) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const dialog = document.querySelector('div[role="dialog"]');
    if (dialog) return dialog;
    await sleep(350);
  }
  return null;
}

function extractDialogCaption(dialog) {
  if (!dialog) return '';
  const candidates = [
    ...dialog.querySelectorAll('h1, h2, article, div[dir="auto"]'),
  ];
  const blocked = /^(like|comment|share|follow|following|more|ещё|нравится|комментировать|поделиться|подписаться|подписки|message|написать|save|сохранить)$/i;
  const values = [];
  for (const el of candidates) {
    const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    if (text.length < 20 || text.length > 1400 || blocked.test(text)) continue;
    if (/^photo by .* on instagram/i.test(text)) continue;
    // Prefer text that contains more than UI boilerplate.
    const words = text.split(/\s+/).filter(Boolean);
    if (words.length < 4) continue;
    if (!values.some(v => v.toLowerCase() === text.toLowerCase())) values.push(text);
  }
  values.sort((a,b) => b.length - a.length);
  return values[0] || '';
}

async function collectPostCaptionsFromRenderedPosts(existingPosts, limit = 8) {
  const out = [...existingPosts];
  const seen = new Set(out.map(p => p.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '').slice(0, 100)));
  const links = [...document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]')]
    .filter(a => a.getAttribute('href'))
    .filter((a, i, arr) => arr.findIndex(x => x.getAttribute('href') === a.getAttribute('href')) === i)
    .slice(0, Math.max(10, limit * 2));

  for (const link of links) {
    if (out.length >= limit) break;
    try {
      link.scrollIntoView({ block: 'center' });
      link.click();
      const dialog = await waitForPostDialog();
      if (!dialog) { await sleep(500); continue; }
      await sleep(450);
      const caption = extractDialogCaption(dialog);
      if (caption) {
        const clean = caption.replace(/\s+/g, ' ').trim().slice(0, 1000);
        const key = clean.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '').slice(0, 100);
        if (key && !seen.has(key)) {
          seen.add(key);
          out.push(clean);
        }
      }
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
      await sleep(650);
    } catch (_) {
      try { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true })); } catch {}
      await sleep(500);
    }
  }
  return out.slice(0, limit);
}

// Compatibility wrapper for older campaign code paths. Keep this name available
// because older injected content scripts/callers may still request it.
async function scrapeProfileData() {
  return scrapeProfileDataAsync();
}

async function scrapeProfileDataAsync() {
  const data = scrapeProfileDataBase();
  if (data.isPrivate) return data;
  // Instagram often renders captions only after a post is opened. Embedded HTML
  // is therefore a seed, not the complete source. Open a small number of visible
  // posts and read the rendered dialog, then return to the profile.
  try {
    data.posts = await collectPostCaptionsFromRenderedPosts(data.posts || [], 8);
  } catch (e) {
    console.warn('[Instalead] rendered post caption pass failed:', e.message);
  }
  return data;
}

function scrapeProfileDataBase() {
  const data = {
    userId: null,
    username: '',
    bio: '',
    posts: [],
    followers: null,
    following: null,
    postCount: null,
    fullName: '',
    externalUrl: '',
    isPrivate: false,
  };

  try {
    const pathMatch = location.pathname.match(/^\/([^/]+)\/?$/);
    if (pathMatch) data.username = decodeURIComponent(pathMatch[1]);

    const header = document.querySelector('header');
    const headerText = header?.innerText || '';
    const meta = document.querySelector('meta[name="description"]')?.getAttribute('content') || '';

    const h1 = header?.querySelector('h1, h2');
    if (h1?.textContent?.trim()) data.fullName = h1.textContent.trim();
    if (!data.fullName) {
      const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute('content') || '';
      const m = ogTitle.match(/^(.+?)\s*\(@[^)]+\)/);
      if (m) data.fullName = m[1].trim();
    }

    // Instagram changes the exact wrapper around the biography frequently.
    // Prefer a group of meaningful header lines over the first div[dir=auto],
    // which can be a button label or a single fragment of the bio.
    const blockedLine = /followers?|following|posts?|подписчик|подписки|публикац|follow|message|edit profile|подписаться|написать|поделиться|more|ещё|•••|\.\.\./i;
    const headerLines = headerText.split(/\n+/).map(v => v.trim()).filter(Boolean);
    const bioLines = [];
    for (const line of headerLines) {
      if (line === data.username || line === data.fullName) continue;
      if (blockedLine.test(line)) continue;
      if (/^\d[\d,.]*\s*[KMB]?$/i.test(line)) continue;
      if (line.length < 3 || line.length > 500) continue;
      if (/^(instagram|home|search|explore|reels|threads|notifications|messages)$/i.test(line)) continue;
      if (!bioLines.some(v => v.toLowerCase() === line.toLowerCase())) bioLines.push(line);
      if (bioLines.join(' ').length >= 900) break;
    }

    const bioCandidates = [
      ...Array.from(header?.querySelectorAll('[dir="auto"]') || []),
      ...Array.from(header?.querySelectorAll('span') || []),
    ];
    for (const el of bioCandidates) {
      const text = (el.textContent || '').trim();
      if (text.length >= 3 && text.length <= 500 && text !== data.fullName &&
          !blockedLine.test(text) && !bioLines.some(v => v.toLowerCase() === text.toLowerCase())) {
        bioLines.push(text);
      }
      if (bioLines.join(' ').length >= 900) break;
    }
    if (bioLines.length) data.bio = bioLines.slice(0, 8).join(' | ').slice(0, 1200);

    if (!data.bio && meta) {
      const quoted = meta.match(/(?:^|["“”])(.{2,700})(?:["“”]|$)/);
      if (quoted) data.bio = quoted[1].trim();
      else {
        const parts = meta.split(' - ');
        if (parts.length > 1) data.bio = parts.slice(1).join(' - ').trim().slice(0, 700);
      }
    }

    const links = Array.from(header?.querySelectorAll('a') || []);
    for (const a of links) {
      const text = (a.innerText || '').trim();
      const label = (a.getAttribute('aria-label') || '').trim();
      const title = (a.getAttribute('title') || '').trim();
      const blob = `${text} ${label} ${title}`;
      const count = parseCount(title || text);
      if (count != null) {
        if (/follower|подписчик/i.test(blob) && data.followers == null) data.followers = count;
        else if (/following|подписк/i.test(blob) && data.following == null) data.following = count;
        else if (/post|публикац/i.test(blob) && data.postCount == null) data.postCount = count;
      }
    }

    const counterNodes = Array.from(header?.querySelectorAll('li, span, a') || []);
    for (const el of counterNodes) {
      const text = (el.innerText || '').trim();
      const m = text.match(/^([0-9][0-9,.]*\s*[KMB]?)\s*(followers?|following|posts?|подписчиков?|подписки|публикац)/i);
      if (!m) continue;
      const count = parseCount(m[1]);
      if (count == null) continue;
      if (/follower|подписчик/i.test(m[2])) data.followers ??= count;
      else if (/following|подписки/i.test(m[2])) data.following ??= count;
      else if (/post|публикац/i.test(m[2])) data.postCount ??= count;
    }

    data.isPrivate = /this account is private|этот аккаунт закрыт/i.test(headerText);

    const external = Array.from(header?.querySelectorAll('a[href]') || [])
      .map(a => a.href)
      .find(href => href && !href.includes('instagram.com/'));
    if (external) data.externalUrl = external;

    const html = document.documentElement?.innerHTML || '';
    const embeddedCaptions = collectEmbeddedCaptions(html, 12);
    const postLinks = document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]');
    const seen = new Set();
    for (const link of postLinks) {
      if (seen.size >= 12) break;
      const href = link.getAttribute('href');
      if (!href || seen.has(href)) continue;
      seen.add(href);
      const img = link.querySelector('img');
      const alt = img?.getAttribute('alt') || '';
      if (alt.trim() && !/^photo by .* on instagram/i.test(alt.trim())) data.posts.push(alt.trim().slice(0, 600));
    }
    for (const caption of embeddedCaptions) {
      if (data.posts.length >= 12) break;
      const key = caption.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '').slice(0, 80);
      if (!key || data.posts.some(p => p.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '').slice(0, 80) === key)) continue;
      data.posts.push(caption);
    }

    const idMatch = html.match(/"(?:profilePage_)?(?:id|pk)"\s*:\s*"(\d+)"/);
    if (idMatch) data.userId = idMatch[1];
  } catch (e) {
    console.error('[Instalead] scrapeProfileData error:', e);
  }

  return data;
}

async function startDMFlow() {
  try {
    if (checkForActionBlock()) return;

    const url = window.location.href;
    const username = currentItem.username;

    if (url.includes('/direct/t/') || url.includes('/direct/inbox/')) {
      await sendMessage();
      return;
    }

    const profileRegex = new RegExp('instagram\\.com\\/' + username + '\\/?($|\\?|#)');
    if (profileRegex.test(url)) {
      await openMessageFromProfile();
      return;
    }

    window.location.href = 'https://www.instagram.com/' + username + '/';

  } catch (e) {
    console.error('[Instalead] startDMFlow error:', e);
    handleError(e.message);
  }
}

async function openMessageFromProfile() {
  showOverlay('Analyzing profile @' + currentItem.username + '...');
  await humanDelay(2500, 4000);

  if (checkForActionBlock()) return;

  if (currentItem.needs_personalization) {
    try {
      const profileData = await scrapeProfileDataAsync();
      showOverlay('AI personalizing message for @' + currentItem.username + '...');

      const result = await new Promise((resolve) => {
        chrome.runtime.sendMessage(
          { type: 'PERSONALIZE', cl_id: currentItem.cl_id, profileData },
          (response) => resolve(response || {})
        );
      });

      if (result.message) {
        currentItem.message = result.message;
        showOverlay('Message personalized!');
        await humanDelay(800, 1500);
      } else {
        throw new Error(result.error || 'Персонализация не вернула сообщение');
      }
    } catch (e) {
      console.error('[Instalead] personalization error:', e);
      handleError(e.message);
      return;
    }
  }

  if (currentItem.like_last_post) {
    const liked = await tryLikeLastPost();
    // null means there was nothing to like (no posts / private) — neutral,
    // not a failure, so it must not feed the like streak.
    if (liked !== null) actionOutcomes.like = liked ? 'succeeded' : 'failed';
    if (checkForActionBlock()) return;
  }

  if (currentItem.follow_profile) {
    const followed = await tryFollow();
    // In prewarm follow-only mode a missing Follow button almost always means
    // we already follow this lead — that's success, not a failure, so it must
    // not feed the circuit-breaker streak or block the later DM phase.
    if (currentItem.follow_only && !followed) {
      actionOutcomes.follow = 'succeeded';
    } else {
      actionOutcomes.follow = followed ? 'succeeded' : 'failed';
    }
    if (checkForActionBlock()) return;
  }

  // Prewarm first touch: stop after the follow (+like). The DM goes out on a
  // later pass, once the backend's prewarm delay has elapsed.
  if (currentItem.follow_only) {
    showOverlay('Подписались на @' + currentItem.username + ' — DM позже (прогрев)');
    chrome.runtime.sendMessage({
      type: 'ITEM_FOLLOWED', cl_id: currentItem.cl_id, actions: actionOutcomes
    });
    return;
  }

  showOverlay('Looking for Message button...');

  let messageBtn = null;
  const deadline = Date.now() + 12000;

  while (!messageBtn && Date.now() < deadline) {
    const candidates = document.querySelectorAll('div[role="button"], button, a[role="button"]');
    for (const el of candidates) {
      const text = (el.textContent || '').trim().toLowerCase();
      const label = (el.getAttribute('aria-label') || '').toLowerCase();
      // Match by substring, not exact equality: Instagram labels the button
      // "Отправить сообщение" / "Send message" on many profiles, which the old
      // exact checks ("сообщение" / "message") missed entirely. "сообщение"
      // (singular) matches the send button but not "Сообщения" (the inbox nav).
      if (
        text.includes('сообщение') || text.includes('написать') ||
        text.includes('send message') || text === 'message' ||
        label.includes('message') || label.includes('написать')
      ) {
        messageBtn = el;
        break;
      }
    }
    if (!messageBtn) await sleep(600);
  }

  if (!messageBtn) {
    throw new Error('Message button not found for @' + currentItem.username);
  }

  showOverlay('Opening chat with @' + currentItem.username + '...');
  messageBtn.click();
  await humanDelay(2500, 4000);

  if (checkForActionBlock()) return;

  const confirmBtn = findButtonByText([
    'Send Message', 'Отправить сообщение', 'Запросить', 'Request', 'OK', 'Ок'
  ]);
  if (confirmBtn) {
    confirmBtn.click();
    await humanDelay(1500, 2500);
  }

  await sendMessage();
}

async function tryLikeLastPost() {
  showOverlay('Liking latest post @' + currentItem.username + '...');
  await humanDelay(1500, 2500);

  try {
    let postLinks = [];
    const gridDeadline = Date.now() + 10000;
    while (postLinks.length === 0 && Date.now() < gridDeadline) {
      postLinks = [...document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]')];
      if (postLinks.length === 0) {
        const gridImages = document.querySelectorAll('article img, main img[style*="object-fit"]');
        for (const img of gridImages) {
          const link = img.closest('a[href]');
          if (link) postLinks.push(link);
        }
      }
      if (postLinks.length === 0) await sleep(800);
    }

    if (postLinks.length === 0) {
      // Profile grid didn't render in time — either the account has no
      // posts, it's private, or Instagram is loading slowly. This isn't
      // a send failure; the flow just continues without the like and
      // proceeds to the DM step.
      console.log('[Instalead] No posts visible for @' + currentItem.username + ' (private/empty/slow) — skipping like step, DM will still send');
      return null;
    }

    const firstPost = postLinks[0];
    showOverlay('Opening post...');
    firstPost.click();
    await humanDelay(2500, 4000);

    let liked = false;
    const deadline = Date.now() + 12000;

    while (!liked && Date.now() < deadline) {
      const allSvgs = document.querySelectorAll('svg[aria-label]');
      for (const svg of allSvgs) {
        const label = (svg.getAttribute('aria-label') || '').toLowerCase();
        const likeLabels = ['like', 'нравится', 'gefällt mir', 'j\'aime', 'me gusta', 'curtir'];
        if (likeLabels.some(l => label === l)) {
          const clickTarget = svg.closest('button') || svg.closest('div[role="button"]') || svg.closest('span[role="button"]') || svg.parentElement;
          if (clickTarget) {
            clickTarget.click();
            liked = true;
            await humanDelay(800, 1500);
            showOverlay('Post liked!');
            break;
          }
        }
      }

      if (!liked) {
        const allBtns = document.querySelectorAll('section button, section div[role="button"], section span[role="button"]');
        for (const btn of allBtns) {
          const svg = btn.querySelector('svg');
          if (!svg) continue;
          const title = svg.querySelector('title');
          const titleText = (title?.textContent || '').toLowerCase();
          if (titleText === 'like' || titleText === 'нравится') {
            btn.click();
            liked = true;
            await humanDelay(800, 1500);
            showOverlay('Post liked!');
            break;
          }
          const ariaLabel = (svg.getAttribute('aria-label') || '').toLowerCase();
          if (ariaLabel && ['like', 'нравится', 'gefällt mir', 'j\'aime'].includes(ariaLabel)) {
            btn.click();
            liked = true;
            await humanDelay(800, 1500);
            showOverlay('Post liked!');
            break;
          }
        }
      }

      if (!liked) {
        const heartBtns = document.querySelectorAll('span.x1lliihq svg, section svg');
        for (const svg of heartBtns) {
          const path = svg.querySelector('path');
          if (!path) continue;
          const d = path.getAttribute('d') || '';
          if (d.includes('M16.792') || d.includes('M34.6') || d.includes('20.205')) {
            const parent = svg.closest('button') || svg.closest('div[role="button"]') || svg.closest('span[role="button"]');
            if (parent) {
              parent.click();
              liked = true;
              await humanDelay(800, 1500);
              showOverlay('Post liked!');
              break;
            }
          }
        }
      }

      if (!liked) {
        try {
          const article = document.querySelector('article, div[role="dialog"] article');
          if (article) {
            const sections = article.querySelectorAll('section');
            if (sections.length > 0) {
              const likeSection = sections[0];
              const firstBtn = likeSection.querySelector('button, div[role="button"], span[role="button"]');
              if (firstBtn) {
                const svg = firstBtn.querySelector('svg');
                if (svg) {
                  const fill = svg.getAttribute('fill') || '';
                  if (fill !== '#ed4956' && fill !== 'red' && fill !== '#ff3040') {
                    firstBtn.click();
                    liked = true;
                    await humanDelay(800, 1500);
                    showOverlay('Post liked!');
                  }
                }
              }
            }
          }
        } catch (_) {}
      }

      if (!liked) await sleep(600);
    }

    if (!liked) {
      console.log('[Instalead] Like button not found after all strategies, skipping');
    }

    await humanDelay(500, 1000);

    await closePostOverlay();
    await humanDelay(1000, 2000);
    return liked;
  } catch (e) {
    console.error('[Instalead] tryLikeLastPost error:', e);
    await closePostOverlay();
    return false;
  }
}

async function closePostOverlay() {
  let closed = false;
  const closeDeadline = Date.now() + 6000;

  while (!closed && Date.now() < closeDeadline) {
    const closeButtons = document.querySelectorAll('svg[aria-label], button[aria-label]');
    for (const el of closeButtons) {
      const label = (el.getAttribute('aria-label') || '').toLowerCase();
      if (label === 'close' || label === 'закрыть' || label === 'schließen' || label === 'fermer' || label === 'cerrar') {
        const btn = el.closest('button') || el.closest('div[role="button"]') || el;
        btn.click();
        closed = true;
        break;
      }
    }

    if (!closed) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, code: 'Escape', bubbles: true }));
      await sleep(600);
      const dialog = document.querySelector('div[role="dialog"]');
      if (!dialog) closed = true;
    }

    if (!closed) {
      window.history.back();
      await sleep(800);
      const dialog2 = document.querySelector('div[role="dialog"]');
      if (!dialog2) closed = true;
    }

    if (!closed) await sleep(500);
  }
}

async function tryFollow() {
  const candidates = document.querySelectorAll('div[role="button"], button');
  let followBtn = null;

  for (const el of candidates) {
    const text = (el.textContent || '').trim().toLowerCase();
    if (text === 'follow' || text === 'подписаться') {
      followBtn = el;
      break;
    }
  }

  if (!followBtn) return false;

  showOverlay('Following @' + currentItem.username + '...');
  followBtn.click();
  await humanDelay(2000, 3500);
  return true;
}

async function sendMessage() {
  showOverlay('Typing message for @' + currentItem.username + '...');

  if (checkForActionBlock()) return;

  const inputSelectors = [
    'div[aria-label="Сообщение"][contenteditable="true"]',
    'div[aria-label="Message"][contenteditable="true"]',
    'div[aria-label*="ообщени"][contenteditable="true"]',
    'div[aria-label*="essage"][contenteditable="true"]',
    'div[contenteditable="true"][role="textbox"]',
    'textarea[placeholder*="ообщени"]',
    'textarea[placeholder*="essage"]',
    '[data-testid="message-input"]',
    'div[contenteditable="true"]'
  ];

  // Clicking "Message" opens the DM thread, whose composer can take several
  // seconds to mount on a slow Instagram load. The old code gave up after 3
  // quick tries (~6-10s) and threw "Message input not found" while the input
  // was simply still rendering — wasting the follow+like already spent on this
  // lead. Poll for a *visible* composer over a longer window instead.
  let msgInput = null;
  const inputDeadline = Date.now() + 20000;
  while (!msgInput && Date.now() < inputDeadline) {
    if (checkForActionBlock()) return;
    for (const sel of inputSelectors) {
      const el = document.querySelector(sel);
      // Instagram leaves stale/hidden contenteditables in the DOM; require one
      // that is actually laid out (has a box) so we don't type into a ghost.
      if (el && el.getClientRects().length > 0) { msgInput = el; break; }
    }
    if (!msgInput) await sleep(700);
  }

  if (!msgInput) {
    throw new Error('Message input not found');
  }

  const message = String(currentItem.message || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  msgInput.focus();
  await humanDelay(400, 700);

  if (msgInput.tagName === 'DIV') {
    msgInput.click();
    await humanDelay(200, 400);
    document.execCommand('selectAll');
    document.execCommand('delete');
    await humanDelay(100, 200);

    // Instagram now sets Permissions-Policy: clipboard-write=none on their
    // pages, so navigator.clipboard.writeText fails every time and produces
    // console spam. Go straight to character-by-character typing — it also
    // reads more human to the anti-bot heuristics (variable delays, longer
    // pauses on punctuation, occasional "thinking" pauses) than an instant
    // paste of the full string would.
    //
    // A bare Enter sends the DM. Newlines must go in as line breaks
    // (insertLineBreak / Shift+Enter), otherwise a multi-paragraph offer
    // lands as one run-on block.
    for (let i = 0; i < message.length; i++) {
      const char = message[i];
      if (char === '\n') {
        insertComposerNewline(msgInput);
        await sleep(120 + Math.random() * 220);
        continue;
      }
      document.execCommand('insertText', false, char);
      let charDelay;
      if (char === ' ') {
        charDelay = 30 + Math.random() * 80;
      } else if ('.!?,;:'.includes(char)) {
        charDelay = 80 + Math.random() * 200;
      } else {
        charDelay = 25 + Math.random() * 65;
      }
      if (Math.random() < 0.03 && i > 5) {
        await sleep(300 + Math.random() * 700);
      }
      await sleep(charDelay);
    }
  } else {
    simulateInput(msgInput, message);
  }

  await humanDelay(600, 1200);

  const sendSelectors = [
    'button[aria-label*="Отправить"]',
    'button[aria-label*="Send"]',
    '[data-testid="send-button"]',
    'button[type="submit"]'
  ];

  let sendBtn = null;
  for (const sel of sendSelectors) {
    sendBtn = document.querySelector(sel);
    if (sendBtn) break;
  }

  if (!sendBtn) {
    const btns = document.querySelectorAll('button, div[role="button"]');
    for (const btn of btns) {
      const t = (btn.textContent || '').trim().toLowerCase();
      if (t === 'send' || t === 'отправить') { sendBtn = btn; break; }
    }
  }

  if (sendBtn) {
    sendBtn.click();
  } else {
    msgInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
    msgInput.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', keyCode: 13, bubbles: true }));
  }

  await humanDelay(1500, 2500);

  if (checkForActionBlock()) return;

  // Verify the send actually went through instead of assuming the click worked.
  // Instagram clears the composer the instant a message is accepted, so a
  // still-populated input after the send means it did NOT send — the classic
  // false-positive this replaces. This is a plain DOM check: no dependency on
  // Instagram's internal React state (which changes with every IG release) and
  // no extra network request.
  if (!(await verifyComposerCleared(msgInput, message))) {
    throw new Error('Отправка не подтверждена — поле ввода не очистилось');
  }

  showOverlay('Sent to @' + currentItem.username + '!', 'success');
  actionOutcomes.dm = 'succeeded';
  chrome.runtime.sendMessage({
    type: 'ITEM_SENT', cl_id: currentItem.cl_id, message, actions: actionOutcomes
  });
  setTimeout(() => removeOverlay(), 3000);
  currentItem = null;
}

// Instagram's composer treats Enter as "send". A real paragraph needs a line
// break (Shift+Enter / insertLineBreak), not insertText('\n').
function insertComposerNewline(el) {
  if (!el) return;
  try {
    el.dispatchEvent(new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertLineBreak',
      data: null
    }));
  } catch (e) {}
  if (document.execCommand('insertLineBreak')) return;
  el.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
    shiftKey: true, bubbles: true, cancelable: true
  }));
  el.dispatchEvent(new KeyboardEvent('keyup', {
    key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
    shiftKey: true, bubbles: true, cancelable: true
  }));
}

// Reads whatever text the composer currently holds, across the contenteditable
// div and textarea variants Instagram has used.
function readComposerText(input) {
  if (!input) return '';
  if (input.tagName === 'DIV') return (input.innerText || input.textContent || '').trim();
  return (input.value || '').trim();
}

// A sent message leaves an empty composer. Polls briefly because the clear can
// lag the click by a frame or two. Treats "input element vanished" as sent
// (Instagram sometimes swaps the composer node on send) and only reports a
// failure when the exact text we typed is still sitting there.
async function verifyComposerCleared(input, sentText) {
  const needle = (sentText || '').trim().slice(0, 40);
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const live = document.contains(input) ? input : (() => {
      for (const sel of ['div[contenteditable="true"][role="textbox"]', 'textarea']) {
        const el = document.querySelector(sel);
        if (el) return el;
      }
      return null;
    })();
    if (!live) return true;
    const current = readComposerText(live);
    if (!current || (needle && !current.includes(needle))) return true;
    await sleep(400);
  }
  return false;
}

function simulateInput(el, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
  if (setter) { setter.call(el, value); } else { el.value = value; }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function findButtonByText(texts) {
  const buttons = document.querySelectorAll('button, div[role="button"], a[role="button"]');
  for (const btn of buttons) {
    const t = (btn.textContent || '').trim();
    if (texts.some(text => t.toLowerCase().includes(text.toLowerCase()))) return btn;
  }
  return null;
}

// Route ALL delays through the offscreen document. Chrome throttles setTimeout
// in background/hidden tabs to ~1 fire per minute, which turns 600ms polls into
// 60s waits — every "find button in 12s" loop then fails deterministically when
// the user's monitor is off or the window is minimized. Offscreen documents are
// not tabs, so their timers are never throttled.
function sleep(ms) { return offscreenDelay(ms); }

function humanDelay(min, max) {
  const delay = min + Math.random() * (max - min);
  return offscreenDelay(delay);
}

async function offscreenDelay(ms) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: 'DELAY_REQUEST', ms }, () => {
        if (chrome.runtime.lastError) {
          setTimeout(resolve, ms);
          return;
        }
        resolve();
      });
    } catch (e) {
      setTimeout(resolve, ms);
    }
  });
}

function handleError(message) {
  showOverlay('Error: ' + message, 'error');
  if (currentItem) {
    actionOutcomes.dm = 'failed';
    chrome.runtime.sendMessage({
      type: 'ITEM_FAILED', cl_id: currentItem.cl_id, error: message, actions: actionOutcomes
    });
    currentItem = null;
  }
  setTimeout(() => removeOverlay(), 5000);
}

function showOverlay(text, type = 'info') {
  removeOverlay();
  const colors = {
    info: 'linear-gradient(135deg, #f97316, #ea580c)',
    success: 'linear-gradient(135deg, #16a34a, #15803d)',
    error: 'linear-gradient(135deg, #dc2626, #b91c1c)'
  };
  const div = document.createElement('div');
  div.id = 'instalead-overlay';
  div.style.cssText =
    'position:fixed;bottom:20px;right:20px;' +
    'background:' + colors[type] + ';color:white;' +
    'padding:12px 18px;border-radius:12px;' +
    'font-size:13px;font-family:-apple-system,BlinkMacSystemFont,sans-serif;' +
    'font-weight:500;z-index:999999;' +
    'box-shadow:0 8px 24px rgba(0,0,0,0.3);max-width:min(620px,calc(100vw - 40px));white-space:normal;overflow-wrap:anywhere;' +
    'display:flex;align-items:center;gap:8px;' +
    'animation:ilSlideIn 0.3s ease;';
  const style = document.createElement('style');
  style.textContent = '@keyframes ilSlideIn { from { transform: translateY(20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }';
  div.appendChild(style);
  const logo = document.createElement('span');
  logo.textContent = 'iL';
  logo.style.cssText = 'font-weight:800;font-size:11px;background:rgba(255,255,255,0.25);padding:2px 5px;border-radius:4px;';
  div.appendChild(logo);
  const msg = document.createElement('span');
  msg.textContent = text;
  div.appendChild(msg);
  document.body.appendChild(div);
}

function removeOverlay() {
  const el = document.getElementById('instalead-overlay');
  if (el) el.remove();
}

})();
