// Content script injected into Instagram pages
// Handles DM sending + logged-in username detection

let currentItem = null;
let sendAttempts = 0;
const MAX_ATTEMPTS = 3;

// ── Username Detection ──────────────────────────────────────

function detectInstagramUsername() {
  // Method 1: window._sharedData (works on many Instagram pages)
  try {
    if (window._sharedData?.config?.viewer?.username) {
      return window._sharedData.config.viewer.username;
    }
  } catch (e) {}

  // Method 2: Embedded JSON in <script> tags
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

  // Method 3: Profile nav link with avatar image
  const EXCLUDE = /^\/(explore|reels|messages|direct|notifications|accounts|p\/|reel\/|tv\/|stories\/|inbox\/)/;
  const allLinks = document.querySelectorAll('a[href]');
  for (const a of allLinks) {
    const href = a.getAttribute('href') || '';
    if (/^\/[a-zA-Z0-9_.]{1,30}\/$/.test(href) && !EXCLUDE.test(href)) {
      if (a.querySelector('img')) return href.slice(1, -1);
    }
  }

  // Method 4: aria-label / title containing "profile"
  for (const a of allLinks) {
    const href = a.getAttribute('href') || '';
    const label = (a.getAttribute('aria-label') || a.title || '').toLowerCase();
    if (/^\/[a-zA-Z0-9_.]{1,30}\/$/.test(href) && !EXCLUDE.test(href) &&
        (label.includes('profile') || label.includes('профил'))) {
      return href.slice(1, -1);
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

// Run on load and whenever Instagram's SPA navigates
reportUsername();

// Watch for SPA route changes (Instagram is a React SPA)
let _prevHref = location.href;
const _navObserver = new MutationObserver(() => {
  if (location.href !== _prevHref) {
    _prevHref = location.href;
    setTimeout(reportUsername, 1500);
  }
});
_navObserver.observe(document.body, { childList: true, subtree: true });

// Retry after DOM settles in case nav renders after initial load
setTimeout(reportUsername, 2000);
setTimeout(reportUsername, 5000);

// ── DM Sending ─────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'SEND_DM') {
    currentItem = msg.item;
    sendAttempts = 0;
    showOverlay(`Отправляем сообщение @${msg.item.username}...`);
    setTimeout(() => startDMFlow(), 2000);
    sendResponse({ ok: true });
  }
});

async function startDMFlow() {
  try {
    const url = window.location.href;
    if (url.includes('/direct/new') || url.includes('/direct/inbox')) {
      await findUserAndSend();
    } else {
      window.location.href = `https://www.instagram.com/direct/new/?username=${currentItem.username}`;
    }
  } catch (e) {
    console.error('[IW Content] startDMFlow error:', e);
    handleError(e.message);
  }
}

async function findUserAndSend() {
  showOverlay(`Ищем пользователя @${currentItem.username}...`);

  try {
    const searchInput = await waitForElement(
      'input[placeholder*="Поиск"], input[placeholder*="Search"], input[name="queryBox"]',
      8000
    );

    if (!searchInput) throw new Error('Поле поиска не найдено');

    searchInput.focus();
    await sleep(500);
    simulateInput(searchInput, currentItem.username);
    await sleep(2000);

    const userSuggestion = await waitForElement(
      `[role="option"], [data-testid="user-suggestion"], button[tabindex="0"]`,
      6000
    );

    if (!userSuggestion) throw new Error(`Пользователь @${currentItem.username} не найден`);

    userSuggestion.click();
    await sleep(1500);

    const nextBtn = findButtonByText(['Next', 'Далее', 'Чат', 'Chat']);
    if (nextBtn) {
      nextBtn.click();
      await sleep(2000);
    }

    await sendMessage();
  } catch (e) {
    throw e;
  }
}

async function sendMessage() {
  showOverlay(`Отправляем сообщение...`);

  const inputSelectors = [
    'div[aria-label="Сообщение"][contenteditable="true"]',
    'div[aria-label="Message"][contenteditable="true"]',
    'div[contenteditable="true"][role="textbox"]',
    'textarea[placeholder*="ообщени"]',
    'textarea[placeholder*="essage"]',
    '[data-testid="message-input"]',
    'div[contenteditable="true"]'
  ];

  let msgInput = null;
  for (const sel of inputSelectors) {
    msgInput = document.querySelector(sel);
    if (msgInput) break;
  }

  if (!msgInput) {
    sendAttempts++;
    if (sendAttempts < MAX_ATTEMPTS) {
      await sleep(2000);
      return sendMessage();
    }
    throw new Error('Поле для сообщения не найдено');
  }

  const message = currentItem.message;

  msgInput.focus();
  await sleep(300);

  if (msgInput.tagName === 'DIV') {
    msgInput.click();
    await sleep(200);
    document.execCommand('selectAll');
    document.execCommand('delete');
    await sleep(100);
    for (const char of message) {
      document.execCommand('insertText', false, char);
      await sleep(20 + Math.random() * 30);
    }
  } else {
    simulateInput(msgInput, message);
  }

  await sleep(500);

  const sendSelectors = [
    'button[type="submit"]',
    'div[role="button"][tabindex="0"]:last-of-type',
    'button[aria-label*="Отправить"]',
    'button[aria-label*="Send"]',
    '[data-testid="send-button"]'
  ];

  let sendBtn = null;
  for (const sel of sendSelectors) {
    const btns = document.querySelectorAll(sel);
    for (const btn of btns) {
      const text = btn.textContent.trim().toLowerCase();
      if (text === 'send' || text === 'отправить' || btn.querySelector('svg') || btn.type === 'submit') {
        sendBtn = btn;
        break;
      }
    }
    if (sendBtn) break;
  }

  if (!sendBtn) {
    msgInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    msgInput.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
  } else {
    sendBtn.click();
  }

  await sleep(1500);

  showOverlay(`✅ Отправлено @${currentItem.username}!`, 'success');
  chrome.runtime.sendMessage({ type: 'ITEM_SENT', cl_id: currentItem.cl_id, message });
  setTimeout(() => removeOverlay(), 3000);
  currentItem = null;
}

// ── Utilities ──────────────────────────────────────────────

function waitForElement(selector, timeout = 5000) {
  return new Promise((resolve) => {
    const el = document.querySelector(selector);
    if (el) return resolve(el);
    const observer = new MutationObserver(() => {
      const el = document.querySelector(selector);
      if (el) { observer.disconnect(); resolve(el); }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => { observer.disconnect(); resolve(null); }, timeout);
  });
}

function simulateInput(el, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
  if (setter) { setter.call(el, value); } else { el.value = value; }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function findButtonByText(texts) {
  const buttons = document.querySelectorAll('button, div[role="button"]');
  for (const btn of buttons) {
    const t = btn.textContent.trim();
    if (texts.some(text => t.toLowerCase().includes(text.toLowerCase()))) return btn;
  }
  return null;
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function handleError(message) {
  showOverlay(`❌ Ошибка: ${message}`, 'error');
  if (currentItem) {
    chrome.runtime.sendMessage({ type: 'ITEM_FAILED', cl_id: currentItem.cl_id, error: message });
    currentItem = null;
  }
  setTimeout(() => removeOverlay(), 4000);
}

function showOverlay(text, type = 'info') {
  removeOverlay();
  const colors = {
    info: 'linear-gradient(135deg, #7c3aed, #a21caf)',
    success: 'linear-gradient(135deg, #065f46, #047857)',
    error: 'linear-gradient(135deg, #7f1d1d, #991b1b)'
  };
  const div = document.createElement('div');
  div.id = 'instaworm-overlay';
  div.style.cssText = `
    position: fixed; bottom: 20px; right: 20px;
    background: ${colors[type]}; color: white;
    padding: 12px 18px; border-radius: 12px;
    font-size: 13px; font-family: -apple-system, BlinkMacSystemFont, sans-serif;
    font-weight: 500; z-index: 999999;
    box-shadow: 0 8px 24px rgba(0,0,0,0.4); max-width: 300px;
    display: flex; align-items: center; gap: 8px;
    animation: iwSlideIn 0.3s ease;
  `;
  const style = document.createElement('style');
  style.textContent = `@keyframes iwSlideIn { from { transform: translateY(20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }`;
  div.appendChild(style);
  const logo = document.createElement('span');
  logo.textContent = '🐛';
  div.appendChild(logo);
  const msg = document.createElement('span');
  msg.textContent = text;
  div.appendChild(msg);
  document.body.appendChild(div);
}

function removeOverlay() {
  const el = document.getElementById('instaworm-overlay');
  if (el) el.remove();
}
