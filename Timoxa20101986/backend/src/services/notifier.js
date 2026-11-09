import { chatIdsForWorkspace } from './telegramLinkService.js';

// ---------------------------------------------------------------------------
// Event notifications → Telegram.
//
// This module does NOT import telegramBot.js. The bot imports routes and
// services that in turn want to notify, so a direct import would close a
// cycle. Instead the bot pushes its send function in here at startup with
// setNotifySender(). With no bot configured `sender` stays null and every
// notify() call is a cheap no-op — an install without Telegram behaves
// exactly as it did before.
//
// Every failure is swallowed. A notification is a side effect of a business
// event; it must never be able to fail the event itself.
// ---------------------------------------------------------------------------

let sender = null;
let fileSender = null;

// Messages go out with parse_mode HTML, so anything interpolated from the
// database or from Instagram has to be escaped or Telegram rejects the whole
// message as malformed entities.
export function escHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function setNotifySender(fn) {
  sender = typeof fn === 'function' ? fn : null;
}

export function setNotifyFileSender(fn) {
  fileSender = typeof fn === 'function' ? fn : null;
}

export function isNotifyEnabled() {
  return sender !== null;
}

// Repeated identical alerts are the fastest way to make a user mute the bot.
// A block detected on ten sends in a row is one piece of news, not ten.
const lastSent = new Map();
const DEFAULT_THROTTLE_MS = 5 * 60 * 1000;

function throttled(workspace, key, throttleMs) {
  if (!key) return false;
  const mapKey = `${workspace}::${key}`;
  const prev = lastSent.get(mapKey) || 0;
  const now = Date.now();
  if (now - prev < throttleMs) return true;
  lastSent.set(mapKey, now);
  return false;
}

/**
 * @param {string} workspace  which tenant this event belongs to
 * @param {string} text       HTML-formatted message body
 * @param {{key?: string, throttleMs?: number}} [options]
 *        key — collapse repeats of the same kind of event
 */
export async function notify(workspace, text, options = {}) {
  if (!sender || !workspace || !text) return 0;

  const { key = null, throttleMs = DEFAULT_THROTTLE_MS } = options;
  if (throttled(workspace, key, throttleMs)) return 0;

  try {
    const chatIds = await chatIdsForWorkspace(workspace);
    if (!chatIds.length) return 0;
    let delivered = 0;
    for (const chatId of chatIds) {
      try {
        await sender(chatId, text);
        delivered++;
      } catch (e) {
        // A single dead chat (user blocked the bot) must not stop the rest.
        console.warn(`[Notifier] chat ${chatId} unreachable: ${e.message}`);
      }
    }
    return delivered;
  } catch (e) {
    console.error('[Notifier] failed:', e.message);
    return 0;
  }
}

/**
 * Deliver a file to every chat bound to a workspace.
 *
 * `build` is a function, not a buffer, so nothing is serialised when no chat
 * is listening — an install without Telegram pays nothing for this call.
 *
 * @param {string} workspace
 * @param {() => Buffer | Promise<Buffer>} build
 * @param {{filename: string, caption?: string}} meta
 */
export async function notifyDocument(workspace, build, meta) {
  if (!fileSender || !workspace) return 0;

  try {
    const chatIds = await chatIdsForWorkspace(workspace);
    if (!chatIds.length) return 0;

    const buffer = await build();
    if (!buffer) return 0;

    let delivered = 0;
    for (const chatId of chatIds) {
      try {
        await fileSender(chatId, buffer, meta);
        delivered++;
      } catch (e) {
        console.warn(`[Notifier] file to chat ${chatId} failed: ${e.message}`);
      }
    }
    return delivered;
  } catch (e) {
    console.error('[Notifier] document failed:', e.message);
    return 0;
  }
}
