const DEFAULTS = {
  apiBaseUrl: "http://localhost:8000",
  askPath: "/ask",
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

els.save.addEventListener("click", () => {
  const cfg = {
    apiBaseUrl: (els.base.value.trim() || DEFAULTS.apiBaseUrl).replace(/\/+$/, ""),
    askPath: normPath(els.ask.value, DEFAULTS.askPath),
    replyPath: normPath(els.reply.value, DEFAULTS.replyPath),
    analyzePath: normPath(els.analyze.value, DEFAULTS.analyzePath),
  };
  chrome.storage.sync.set(cfg, () => {
    els.base.value = cfg.apiBaseUrl;
    els.ask.value = cfg.askPath;
    els.reply.value = cfg.replyPath;
    els.analyze.value = cfg.analyzePath;
    els.saved.classList.add("show");
    setTimeout(() => els.saved.classList.remove("show"), 1400);
  });
});
