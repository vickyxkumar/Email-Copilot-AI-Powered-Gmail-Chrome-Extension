const DEFAULTS = {
  apiBaseUrl: "http://localhost:8000",
  askPath: "/ask/stream",
  replyPath: "/reply",
  analyzePath: "/analyze",
};

const els = {
  base: document.getElementById("base"),
  ask: document.getElementById("ask"),
  reply: document.getElementById("reply"),
  analyze: document.getElementById("analyze"),
  save: document.getElementById("save"),
  saved: document.getElementById("saved"),
};

chrome.storage.sync.get(DEFAULTS, (cfg) => {
  els.base.value = cfg.apiBaseUrl;
  els.ask.value = cfg.askPath;
  els.reply.value = cfg.replyPath;
  els.analyze.value = cfg.analyzePath;
});

function normPath(p, fallback) {
  p = (p || "").trim();
  if (!p) return fallback;
  return p.startsWith("/") ? p : "/" + p;
}

function flash(text, color) {
  els.saved.textContent = text;
  els.saved.style.color = color || "";
  els.saved.classList.add("show");
  setTimeout(() => els.saved.classList.remove("show"), 1400);
}

els.save.addEventListener("click", () => {
  const base = (els.base.value.trim() || DEFAULTS.apiBaseUrl).replace(/\/+$/, "");
  // Without a scheme, fetch() and the sign-in tab would both resolve the URL
  // against the extension's own origin and fail with confusing errors.
  if (!/^https?:\/\/[^/]+/i.test(base)) {
    flash("Base URL must start with http:// or https://", "var(--danger)");
    return;
  }
  const cfg = {
    apiBaseUrl: base,
    askPath: normPath(els.ask.value, DEFAULTS.askPath),
    replyPath: normPath(els.reply.value, DEFAULTS.replyPath),
    analyzePath: normPath(els.analyze.value, DEFAULTS.analyzePath),
  };
  chrome.storage.sync.set(cfg, () => {
    els.base.value = cfg.apiBaseUrl;
    els.ask.value = cfg.askPath;
    els.reply.value = cfg.replyPath;
    els.analyze.value = cfg.analyzePath;
    flash("Saved");
  });
});
