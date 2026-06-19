// Background service worker.
// Content scripts run in the mail.google.com origin, so direct fetches to your
// backend are subject to CORS. The service worker is not, as long as the target
// host is in host_permissions. So all API traffic is routed through here.

const DEFAULTS = {
  apiBaseUrl: "http://localhost:8000",
  askPath: "/ask",
  replyPath: "/reply",
  analyzePath: "/analyze",
};

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

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== "api") return false;
  callApi(msg.pathKey, msg.body).then(sendResponse);
  return true; // keep the channel open for the async response
});
