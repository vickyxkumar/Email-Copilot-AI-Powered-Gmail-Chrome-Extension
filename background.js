// Background service worker.
// Content scripts run in the mail.google.com origin, so direct fetches to your
// backend are subject to CORS. The service worker is not, as long as the target
// host is in host_permissions. So all API traffic is routed through here.

const DEFAULTS = {
  apiBaseUrl: "http://localhost:8000",
  askPath: "/ask/stream",
  replyPath: "/reply",
  analyzePath: "/analyze",
};

const LOGIN_PATH = "/auth/login";
const CALLBACK_PATH = "/auth/callback";
const TOKEN_KEY = "mrag_access_token";
const USER_KEY = "mrag_user";
const AUTH_ERROR_KEY = "mrag_auth_error";
const LOGIN_TAB_KEY = "mrag_login_tab_id";
const CALLBACK_PENDING_KEY = "mrag_callback_pending";

async function getConfig() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  // Trim trailing slash from base so path joins are clean.
  stored.apiBaseUrl = (stored.apiBaseUrl || DEFAULTS.apiBaseUrl).replace(/\/+$/, "");
  return stored;
}

function joinUrl(base, path) {
  if (!path.startsWith("/")) path = "/" + path;
  return base + path;
}

// ---------- auth/session (chrome.storage.local) ----------
async function getToken() {
  const stored = await chrome.storage.local.get(TOKEN_KEY);
  return stored[TOKEN_KEY] || null;
}

async function getSession() {
  const stored = await chrome.storage.local.get([TOKEN_KEY, USER_KEY]);
  return { token: stored[TOKEN_KEY] || null, user: stored[USER_KEY] || null };
}

async function setSession(data) {
  await chrome.storage.local.set({
    [TOKEN_KEY]: data.access_token,
    [USER_KEY]: {
      id: data.user_id,
      email: data.email,
      name: data.name,
      picture_url: data.picture_url || "",
    },
  });
}

async function clearSession() {
  await chrome.storage.local.remove([TOKEN_KEY, USER_KEY]);
}

async function setAuthError(message) {
  await chrome.storage.local.set({ [AUTH_ERROR_KEY]: message });
}

// The service worker can be evicted mid-flow (a Google login can take longer
// than MV3's idle timeout), so the pending login tab id lives in session
// storage rather than a module variable — it has to survive a restart.
async function setLoginTabId(id) {
  if (id == null) await chrome.storage.session.remove(LOGIN_TAB_KEY);
  else await chrome.storage.session.set({ [LOGIN_TAB_KEY]: id });
}
async function getLoginTabId() {
  const stored = await chrome.storage.session.get(LOGIN_TAB_KEY);
  return stored[LOGIN_TAB_KEY] ?? null;
}

// Guards against injecting twice into the same tab if onUpdated fires more
// than once at status "complete" for the same URL.
async function setCallbackPending(v) {
  if (!v) await chrome.storage.session.remove(CALLBACK_PENDING_KEY);
  else await chrome.storage.session.set({ [CALLBACK_PENDING_KEY]: true });
}
async function isCallbackPending() {
  const stored = await chrome.storage.session.get(CALLBACK_PENDING_KEY);
  return !!stored[CALLBACK_PENDING_KEY];
}

async function startLogin() {
  await chrome.storage.local.remove(AUTH_ERROR_KEY);
  const cfg = await getConfig();
  const tab = await chrome.tabs.create({ url: joinUrl(cfg.apiBaseUrl, LOGIN_PATH) });
  await setLoginTabId(tab.id);
  await setCallbackPending(false);
  return { success: true };
}

// Runs inside the callback tab (isolated world, same as a normal content
// script) once the browser has navigated there and rendered the backend's
// JSON response. Reading it straight from the DOM means the callback route
// is only ever hit once — no second fetch, no re-using a one-time OAuth code.
function relayAuthCallback() {
  let payload;
  try {
    // Chrome renders JSON responses inside a <pre> (newer versions add a
    // pretty-print control next to it), so prefer the <pre>'s text.
    const pre = document.querySelector("body > pre");
    const raw = (pre || document.body).textContent.trim();
    payload = { data: JSON.parse(raw) };
  } catch (err) {
    payload = { error: "Couldn't parse the sign-in response as JSON." };
  }
  chrome.runtime.sendMessage({ type: "authCallback", ...payload });
}

chrome.tabs.onUpdated.addListener(async (tabId, _changeInfo, tab) => {
  const loginTabId = await getLoginTabId();
  if (loginTabId == null || tabId !== loginTabId) return;
  if (!tab.url || tab.status !== "complete") return;
  if (await isCallbackPending()) return;

  const cfg = await getConfig();
  let base, url;
  try {
    base = new URL(cfg.apiBaseUrl);
    url = new URL(tab.url);
  } catch {
    return;
  }
  if (url.origin !== base.origin || !url.pathname.startsWith(CALLBACK_PATH)) return;

  await setCallbackPending(true);
  try {
    await chrome.scripting.executeScript({ target: { tabId }, func: relayAuthCallback });
  } catch (err) {
    await setAuthError(`Couldn't read the sign-in response: ${err.message}`);
    await setLoginTabId(null);
    await setCallbackPending(false);
    chrome.tabs.remove(tabId).catch(() => {});
  }
});

async function handleAuthCallback(tabId, msg) {
  if (tabId == null) return;
  const loginTabId = await getLoginTabId();
  if (loginTabId !== tabId) return; // stale or unrelated message

  await setLoginTabId(null);
  await setCallbackPending(false);
  try {
    if (msg.data && msg.data.status === "success" && msg.data.access_token) {
      await setSession(msg.data);
    } else {
      await setAuthError((msg.data && (msg.data.error || msg.data.message)) || msg.error || "Sign-in failed: unexpected response.");
    }
  } finally {
    chrome.tabs.remove(tabId).catch(() => {});
  }
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const loginTabId = await getLoginTabId();
  if (tabId === loginTabId) {
    await setLoginTabId(null);
    await setCallbackPending(false);
  }
});

// Turn a FastAPI 422 body into a single readable string.
function formatValidationError(detail) {
  if (!Array.isArray(detail)) return "Validation error.";
  return detail
    .map((d) => {
      const loc = Array.isArray(d.loc) ? d.loc.filter((p) => p !== "body").join(".") : "";
      return loc ? `${loc}: ${d.msg}` : d.msg;
    })
    .filter(Boolean)
    .join("\n");
}

async function callApi(pathKey, body) {
  const cfg = await getConfig();
  const path = cfg[pathKey];
  const url = joinUrl(cfg.apiBaseUrl, path);

  const token = await getToken();
  if (!token) {
    return { ok: false, error: "You're not signed in. Sign in with Google to use this." };
  }

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    // Almost always: backend not running, wrong URL, or host not permitted.
    return {
      ok: false,
      error:
        `Couldn't reach the backend at ${url}. ` +
        `Check that it's running and that the URL in settings is correct. (${err.message})`,
    };
  }

  // Checked before parsing: a 401 from a proxy or gateway may not be JSON.
  if (res.status === 401) {
    await clearSession();
    return { ok: false, error: "Your session expired. Please sign in again." };
  }

  let data = null;
  const text = await res.text();
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    return { ok: false, error: `Backend returned a non-JSON response (HTTP ${res.status}).` };
  }

  if (res.status === 422) {
    return { ok: false, error: formatValidationError(data && data.detail) };
  }

  if (!res.ok) {
    const msg = (data && (data.error || data.message)) || `Request failed (HTTP ${res.status}).`;
    return { ok: false, error: msg };
  }

  // App-level failure flag from your schema.
  if (data && data.success === false) {
    return { ok: false, error: data.error || "The backend reported an error." };
  }

  return { ok: true, data };
}

// ---------- streaming /ask (Server-Sent Events over a long-lived port) ----------
// Splits an SSE buffer on blank-line event boundaries and pulls out
// "event:"/"data:" fields per the SSE spec (event defaults to "message").
function parseSseEvent(rawEvent) {
  let eventName = "message";
  const dataLines = [];
  for (const line of rawEvent.split("\n")) {
    if (line.startsWith("event:")) eventName = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (!dataLines.length) return null;
  try {
    return { eventName, data: JSON.parse(dataLines.join("\n")) };
  } catch {
    return null;
  }
}

async function streamAsk(port, { question, thread_id }, isCancelled) {
  const safePost = (m) => {
    if (isCancelled()) return;
    try {
      port.postMessage(m);
    } catch {
      // port already disconnected
    }
  };

  const cfg = await getConfig();
  const url = joinUrl(cfg.apiBaseUrl, cfg.askPath);
  const token = await getToken();
  if (!token) {
    safePost({ type: "error", error: "You're not signed in. Sign in with Google to use this." });
    return;
  }

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        Accept: "text/event-stream",
      },
      body: JSON.stringify({ question, thread_id }),
    });
  } catch (err) {
    safePost({
      type: "error",
      error:
        `Couldn't reach the backend at ${url}. ` +
        `Check that it's running and that the URL in settings is correct. (${err.message})`,
    });
    return;
  }

  if (res.status === 401) {
    await clearSession();
    safePost({ type: "error", error: "Your session expired. Please sign in again." });
    return;
  }

  if (!res.ok || !res.body) {
    // Not a stream — likely an error response in the same shape callApi handles.
    let data = null;
    try {
      const text = await res.text();
      data = text ? JSON.parse(text) : null;
    } catch {
      // ignore — fall through to generic message below
    }
    if (res.status === 422) {
      safePost({ type: "error", error: formatValidationError(data && data.detail) });
    } else {
      safePost({ type: "error", error: (data && (data.error || data.message)) || `Request failed (HTTP ${res.status}).` });
    }
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const handleEvent = (rawEvent) => {
    const parsed = parseSseEvent(rawEvent);
    if (!parsed) return;
    if (parsed.eventName === "done" || parsed.data.done === true) {
      safePost({ type: "done", data: parsed.data });
    } else if (typeof parsed.data.token === "string") {
      safePost({ type: "token", token: parsed.data.token });
    }
  };

  try {
    while (true) {
      if (isCancelled()) {
        reader.cancel().catch(() => {});
        return;
      }
      const { done, value } = await reader.read();
      if (done) break;
      // SSE allows CRLF/CR line endings (sse-starlette sends CRLF by default).
      // Normalize to LF, but hold back a trailing CR in case its LF is in the
      // next chunk.
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n|\r(?!$)/g, "\n");

      let idx;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        handleEvent(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 2);
      }
    }
    // Some servers close the stream without a final blank line.
    buffer = (buffer + decoder.decode()).replace(/\r\n?/g, "\n");
    if (buffer.trim()) handleEvent(buffer);
  } catch (err) {
    safePost({ type: "error", error: `Stream interrupted: ${err.message}` });
    return;
  }

  safePost({ type: "end" });
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "ask-stream") return;
  let cancelled = false;
  port.onDisconnect.addListener(() => {
    cancelled = true;
  });
  port.onMessage.addListener((msg) => {
    streamAsk(port, msg, () => cancelled).catch((err) => {
      if (!cancelled) {
        try {
          port.postMessage({ type: "error", error: err.message });
        } catch {
          // port already disconnected
        }
      }
    });
  });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg) return false;

  if (msg.type === "api") {
    callApi(msg.pathKey, msg.body).then(sendResponse);
    return true; // keep the channel open for the async response
  }
  if (msg.type === "login") {
    startLogin().then(sendResponse).catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }
  if (msg.type === "logout") {
    clearSession().then(() => sendResponse({ success: true }));
    return true;
  }
  if (msg.type === "getSession") {
    getSession().then((session) => sendResponse({ success: true, session }));
    return true;
  }
  if (msg.type === "authCallback") {
    handleAuthCallback(_sender.tab && _sender.tab.id, msg);
    return false; // fire-and-forget relay from the injected callback-tab script
  }
  return false;
});
