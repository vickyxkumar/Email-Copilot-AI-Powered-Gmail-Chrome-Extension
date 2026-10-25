/* Mail RAG Assistant — content script injected into mail.google.com.
 *
 * Responsibilities:
 *   1. Inject a side panel + launcher.
 *   2. Detect the currently open Gmail thread (id, subject, body text, account name).
 *   3. Drive three modes against the backend (via the background service worker):
 *        - Ask      -> POST {question, thread_id}
 *        - Summarize -> POST {thread_id}
 *        - Reply     -> POST {raw_text, thread_id, instructions, sender_name}
 */

(() => {
  if (window.__mailRagInjected) return; // guard against double injection
  window.__mailRagInjected = true;

  const SPARK_SVG = `<svg class="mrag-spark" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M4 6.5C4 5.67 4.67 5 5.5 5h13c.83 0 1.5.67 1.5 1.5v8c0 .83-.67 1.5-1.5 1.5H12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M4.5 6l7.5 5.2L19.5 6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M6 18.5l1.1-2.4L9.5 15l-2.4-1.1L6 11.5l-1.1 2.4L2.5 15l2.4 1.1L6 18.5Z" fill="currentColor"/>
  </svg>`;

  const ICON_CLOSE = `<svg viewBox="0 0 20 20" width="18" height="18" fill="none"><path d="M5 5l10 10M15 5L5 15" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>`;
  const ICON_SEND = `<svg viewBox="0 0 20 20" width="18" height="18" fill="none"><path d="M3 10l13-6-5 13-2.3-5.2L3 10Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/></svg>`;

  // ---------- small helpers ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const el = (tag, cls, html) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  };
  const esc = (s) =>
    String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

  // After the extension is updated or reloaded, this script stays alive in
  // already-open Gmail tabs but chrome.runtime calls throw synchronously.
  const STALE_MSG = "The extension was updated or reloaded. Refresh this Gmail tab to keep using it.";

  function callApi(pathKey, body) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: "api", pathKey, body }, (resp) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
          } else {
            resolve(resp || { ok: false, error: "No response from background." });
          }
        });
      } catch {
        resolve({ ok: false, error: STALE_MSG });
      }
    });
  }

  function sendMsg(type) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type }, (resp) => {
          if (chrome.runtime.lastError) {
            resolve({ success: false, error: chrome.runtime.lastError.message });
          } else {
            resolve(resp || { success: false, error: "No response from background." });
          }
        });
      } catch {
        resolve({ success: false, error: STALE_MSG });
      }
    });
  }

  // Keys must match background.js's chrome.storage.local keys.
  const TOKEN_KEY = "mrag_access_token";
  const USER_KEY = "mrag_user";
  const AUTH_ERROR_KEY = "mrag_auth_error";

  function fmtCost(data) {
    if (!data) return "";
    const bits = [];
    if (typeof data.tokens_used === "number" && data.tokens_used > 0)
      bits.push(`${data.tokens_used.toLocaleString()} tokens`);
    if (typeof data.cost_usd === "number" && data.cost_usd > 0)
      bits.push(`$${data.cost_usd.toFixed(4)}`);
    return bits.join("  ·  ");
  }

  // ---------- Gmail context extraction ----------
  // Gmail is a single-page app; the open conversation lives inside [role="main"].
  function readContext() {
    const main = $('div[role="main"]');
    const ctx = { threadId: "", subject: "", bodyText: "", latestText: "", account: "" };
    if (!main) return ctx;

    // A thread is only "open" when message bodies are actually rendered.
    // Gmail draws each message body as div.a3s; these don't exist in list view,
    // which keeps us from latching onto a list row's id in reading-pane layouts.
    const bodies = Array.from(main.querySelectorAll("div.a3s"))
      .filter((b) => b.offsetParent !== null); // visible only
    if (!bodies.length) return ctx; // no open conversation -> no context

    ctx.bodyText = bodies.map((b) => b.innerText.trim()).join("\n\n———\n\n");
    ctx.latestText = bodies[bodies.length - 1].innerText.trim();

    // Thread id (Gmail API / hex). Tie it to the open message so we don't pick up
    // a list row: walk up from a body to the nearest element carrying the id.
    const owner = bodies[bodies.length - 1].closest("[data-legacy-thread-id]");
    if (owner) ctx.threadId = owner.getAttribute("data-legacy-thread-id") || "";
    if (!ctx.threadId) {
      const any = main.querySelector("[data-legacy-thread-id]");
      if (any) ctx.threadId = any.getAttribute("data-legacy-thread-id") || "";
    }
    if (!ctx.threadId) {
      const m = location.hash.match(/[#/]([A-Za-z0-9_-]{12,})$/);
      if (m) ctx.threadId = m[1];
    }

    // Subject (the open thread heading).
    const h2 = main.querySelector("h2.hP") || main.querySelector('h2[data-thread-perm-id]') || main.querySelector("h2");
    if (h2) ctx.subject = h2.textContent.trim();

    // Account display name (best effort) — used to prefill "your name" on replies.
    const acct = $('a[aria-label*="Google Account"], a[href*="SignOutOptions"]');
    if (acct) {
      const lbl = acct.getAttribute("aria-label") || "";
      const nm = lbl.match(/Account:\s*([^\(]+?)\s*\(/) || lbl.match(/Google Account:\s*([^\(]+?)\s*\(/);
      if (nm) ctx.account = nm[1].trim();
    }
    return ctx;
  }

  // ---------- build UI ----------
  const root = el("div");
  root.id = "mrag-root";

  root.innerHTML = `
    <button id="mrag-launcher" title="Open Mail RAG Assistant">
      ${SPARK_SVG}<span>Ask your mail</span>
    </button>
    <section id="mrag-panel" aria-label="Mail RAG Assistant">
      <header class="mrag-header">
        <div class="mrag-header-row">
          <div class="mrag-brand">
            ${SPARK_SVG}
            <div>
              <div class="mrag-eyebrow">Mail RAG</div>
              <div class="mrag-title">Assistant</div>
            </div>
          </div>
          <button class="mrag-iconbtn" id="mrag-close" title="Close">${ICON_CLOSE}</button>
        </div>
        <div class="mrag-account-row" id="mrag-account-row" style="display:none">
          <img class="mrag-account-pic" id="mrag-account-pic" alt="">
          <span class="mrag-account-name" id="mrag-account-name"></span>
          <button class="mrag-signout-btn" id="mrag-signout" title="Sign out">Sign out</button>
        </div>
        <div class="mrag-context" id="mrag-context-row">
          <span class="mrag-dot"></span>
          <div class="mrag-context-text">
            <div class="mrag-context-label" id="mrag-ctx-label">No thread open</div>
            <div class="mrag-context-subject" id="mrag-ctx-subject">Open an email to give the assistant context</div>
            <div class="mrag-context-id" id="mrag-ctx-id"></div>
          </div>
        </div>
      </header>

      <div class="mrag-authgate" id="mrag-authgate">
        <div class="mrag-empty-spark">${SPARK_SVG}</div>
        <h3 class="mrag-authgate-title">Sign in to get started</h3>
        <p class="mrag-authgate-text">Connect your Google account so the assistant can read and answer questions about your mail.</p>
        <button class="mrag-btn mrag-btn-block" id="mrag-signin">Sign in with Google</button>
        <div class="mrag-notice mrag-notice-err" id="mrag-auth-error" style="display:none"></div>
      </div>

      <nav class="mrag-tabs" id="mrag-tabs">
        <button class="mrag-tab is-active" data-tab="ask">Ask</button>
        <button class="mrag-tab" data-tab="analyze">Summarize</button>
        <button class="mrag-tab" data-tab="reply">Reply</button>
      </nav>

      <div class="mrag-body" id="mrag-body">
        <!-- ASK -->
        <div class="mrag-pane is-active" data-pane="ask">
          <div class="mrag-scroll" id="mrag-chat">
            <div class="mrag-empty">
              <div class="mrag-empty-spark">${SPARK_SVG}</div>
              Ask anything about your indexed mail — “What did Priya say about the Q3 budget?”
            </div>
          </div>
          <div class="mrag-composer">
            <label class="mrag-scope" id="mrag-scope-wrap" style="display:none">
              <input type="checkbox" id="mrag-scope" checked>
              <span id="mrag-scope-text">Scope answers to the open thread</span>
            </label>
            <div class="mrag-input-row">
              <textarea class="mrag-input" id="mrag-question" rows="1" placeholder="Ask your mail…"></textarea>
              <button class="mrag-btn mrag-btn-send" id="mrag-send" title="Send">${ICON_SEND}</button>
            </div>
          </div>
        </div>

        <!-- ANALYZE -->
        <div class="mrag-pane" data-pane="analyze">
          <div class="mrag-scroll">
            <div id="mrag-analyze-needs" class="mrag-notice mrag-notice-warn" style="display:none">
              Open an email thread first — summaries are generated from the thread you’re viewing.
            </div>
            <button class="mrag-btn mrag-btn-block" id="mrag-analyze-btn">Summarize this thread</button>
            <div id="mrag-analyze-out" style="margin-top:14px"></div>
          </div>
        </div>

        <!-- REPLY -->
        <div class="mrag-pane" data-pane="reply">
          <div class="mrag-scroll">
            <div id="mrag-reply-needs" class="mrag-notice mrag-notice-warn" style="display:none">
              Open an email thread first — drafts are written from the message you’re replying to.
            </div>
            <div class="mrag-field">
              <label class="mrag-label" for="mrag-instructions">Instructions <span style="font-weight:500;text-transform:none;letter-spacing:0">(optional)</span></label>
              <textarea class="mrag-control" id="mrag-instructions" placeholder="e.g. Keep it short and warm; propose Thursday 3pm; decline politely."></textarea>
            </div>
            <div class="mrag-field">
              <label class="mrag-label" for="mrag-sender">Sign as</label>
              <input class="mrag-control" id="mrag-sender" placeholder="Your name">
            </div>
            <button class="mrag-btn mrag-btn-block" id="mrag-reply-btn">Draft a reply</button>
            <div id="mrag-reply-out" style="margin-top:14px"></div>
          </div>
        </div>
      </div>
    </section>
    <div id="mrag-toast"></div>
  `;
  document.documentElement.appendChild(root);

  // ---------- element refs ----------
  const launcher = $("#mrag-launcher", root);
  const closeBtn = $("#mrag-close", root);
  const tabs = Array.from(root.querySelectorAll(".mrag-tab"));
  const panes = Array.from(root.querySelectorAll(".mrag-pane"));

  const ctxLabel = $("#mrag-ctx-label", root);
  const ctxSubject = $("#mrag-ctx-subject", root);
  const ctxId = $("#mrag-ctx-id", root);

  const chat = $("#mrag-chat", root);
  const question = $("#mrag-question", root);
  const sendBtn = $("#mrag-send", root);
  const scopeWrap = $("#mrag-scope-wrap", root);
  const scopeBox = $("#mrag-scope", root);

  const analyzeBtn = $("#mrag-analyze-btn", root);
  const analyzeOut = $("#mrag-analyze-out", root);
  const analyzeNeeds = $("#mrag-analyze-needs", root);

  const replyBtn = $("#mrag-reply-btn", root);
  const replyOut = $("#mrag-reply-out", root);
  const replyNeeds = $("#mrag-reply-needs", root);
  const instructions = $("#mrag-instructions", root);
  const sender = $("#mrag-sender", root);

  const toast = $("#mrag-toast", root);

  const accountRow = $("#mrag-account-row", root);
  const accountPic = $("#mrag-account-pic", root);
  const accountName = $("#mrag-account-name", root);
  const signoutBtn = $("#mrag-signout", root);
  const signinBtn = $("#mrag-signin", root);
  const authError = $("#mrag-auth-error", root);

  let context = { threadId: "", subject: "", bodyText: "", latestText: "", account: "" };
  let senderTouched = false;

  // ---------- auth ----------
  function applyAuthState(session) {
    const loggedIn = !!(session && session.token);
    root.classList.toggle("mrag-authed", loggedIn);
    if (loggedIn && session.user) {
      accountName.textContent = session.user.name || session.user.email || "Signed in";
      if (session.user.picture_url) {
        accountPic.src = session.user.picture_url;
        accountPic.style.visibility = "visible";
      } else {
        accountPic.style.visibility = "hidden";
      }
      accountRow.style.display = "flex";
    } else {
      accountRow.style.display = "none";
    }
  }

  async function loadSession() {
    const resp = await sendMsg("getSession");
    applyAuthState(resp.success ? resp.session : null);
  }

  signinBtn.addEventListener("click", async () => {
    signinBtn.disabled = true;
    authError.style.display = "none";
    const resp = await sendMsg("login");
    signinBtn.disabled = false;
    if (!resp.success) {
      authError.textContent = resp.error || "Couldn't start sign-in.";
      authError.style.display = "block";
    }
  });

  signoutBtn.addEventListener("click", async () => {
    await sendMsg("logout");
    applyAuthState(null);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[TOKEN_KEY] || changes[USER_KEY]) loadSession();
    if (changes[AUTH_ERROR_KEY] && changes[AUTH_ERROR_KEY].newValue) {
      authError.textContent = changes[AUTH_ERROR_KEY].newValue;
      authError.style.display = "block";
      chrome.storage.local.remove(AUTH_ERROR_KEY);
    }
  });

  // ---------- open / close ----------
  function openPanel() { root.classList.add("mrag-open"); refreshContext(); question.focus(); }
  function closePanel() { root.classList.remove("mrag-open"); }
  launcher.addEventListener("click", openPanel);
  closeBtn.addEventListener("click", closePanel);

  // ---------- tabs ----------
  tabs.forEach((t) => t.addEventListener("click", () => {
    tabs.forEach((x) => x.classList.toggle("is-active", x === t));
    const name = t.dataset.tab;
    panes.forEach((p) => p.classList.toggle("is-active", p.dataset.pane === name));
  }));

  // ---------- toast ----------
  let toastTimer;
  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add("is-shown");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("is-shown"), 1800);
  }

  // ---------- context refresh ----------
  function refreshContext() {
    context = readContext();
    const has = !!context.threadId;
    root.classList.toggle("mrag-has-thread", has);

    if (has) {
      ctxLabel.textContent = "Thread in view";
      ctxSubject.textContent = context.subject || "(no subject)";
      ctxId.textContent = context.threadId;
    } else {
      ctxLabel.textContent = "No thread open";
      ctxSubject.textContent = "Open an email to give the assistant context";
      ctxId.textContent = "";
    }

    scopeWrap.style.display = has ? "flex" : "none";
    analyzeNeeds.style.display = has ? "none" : "block";
    analyzeBtn.disabled = !has;
    replyNeeds.style.display = has ? "none" : "block";
    replyBtn.disabled = !has;

    if (!senderTouched && context.account && !sender.value) sender.value = context.account;
  }

  // Watch the SPA for navigation + DOM swaps, debounced.
  let debounce;
  const scheduleRefresh = () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => { if (root.classList.contains("mrag-open")) refreshContext(); }, 250);
  };
  window.addEventListener("hashchange", scheduleRefresh);
  const mo = new MutationObserver(scheduleRefresh);
  mo.observe(document.body, { childList: true, subtree: true });

  // ---------- ASK ----------
  function autoGrow() {
    question.style.height = "auto";
    question.style.height = Math.min(question.scrollHeight, 140) + "px";
  }
  question.addEventListener("input", autoGrow);
  question.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendQuestion(); }
  });
  sendBtn.addEventListener("click", sendQuestion);

  function clearEmpty() {
    const empty = chat.querySelector(".mrag-empty");
    if (empty) empty.remove();
  }
  function addUserMsg(text) {
    clearEmpty();
    const n = el("div", "mrag-msg");
    n.appendChild(el("div", "mrag-msg-user", esc(text)));
    chat.appendChild(n);
    chat.scrollTop = chat.scrollHeight;
  }
  function addThinking() {
    const n = el("div", "mrag-msg");
    n.innerHTML = `<div class="mrag-thinking"><span class="mrag-spinner"></span> Searching your mail…</div>`;
    chat.appendChild(n);
    chat.scrollTop = chat.scrollHeight;
    return n;
  }

  function renderSources(sources) {
    if (!Array.isArray(sources) || !sources.length) return "";
    const items = sources.map((s) => {
      if (s == null) return "";
      if (typeof s === "string") return `<div class="mrag-source">${esc(s)}</div>`;
      // object: pull common fields defensively
      const subject = s.subject || s.title || "";
      const from = s.from || s.sender || s.author || "";
      const date = s.date || s.received || s.timestamp || "";
      const snippet = s.snippet || s.text || s.content || s.excerpt || "";
      const link = s.link || s.url || s.permalink || "";
      let html = "";
      if (subject) html += `<b>${esc(subject)}</b>`;
      const sub = [from, date].filter(Boolean).map(esc).join(" · ");
      if (sub) html += `<div style="color:var(--muted);margin-top:2px">${sub}</div>`;
      if (snippet) html += `<div style="margin-top:4px">${esc(String(snippet).slice(0, 260))}</div>`;
      // Only http(s) links: a javascript: URL here would run inside Gmail.
      if (/^https?:\/\//i.test(link)) html += `<div style="margin-top:4px"><a href="${esc(link)}" target="_blank" rel="noopener">Open</a></div>`;
      if (!html) html = esc(JSON.stringify(s));
      return `<div class="mrag-source">${html}</div>`;
    }).join("");
    return `<div class="mrag-sources"><div class="mrag-sources-title">Sources</div>${items}</div>`;
  }

  function addStreamingBotMsg() {
    const n = el("div", "mrag-msg");
    const bubble = el("div", "mrag-msg-bot");
    const textSpan = document.createElement("span");
    textSpan.className = "mrag-stream-text mrag-streaming";
    bubble.appendChild(textSpan);
    n.appendChild(bubble);
    chat.appendChild(n);
    chat.scrollTop = chat.scrollHeight;
    return { bubble, textSpan };
  }
  function addBotError(msg) {
    const n = el("div", "mrag-msg");
    n.innerHTML = `<div class="mrag-msg-bot"><div class="mrag-notice mrag-notice-err" style="margin:0">${esc(msg)}</div></div>`;
    chat.appendChild(n);
    chat.scrollTop = chat.scrollHeight;
  }

  // Streams tokens from background.js over a long-lived port (the backend
  // sends Server-Sent Events: repeated {token} data lines, then an "event:
  // done" line carrying the full answer + sources).
  function streamQuestion(q, threadId, thinking) {
    return new Promise((resolve) => {
      let port;
      try {
        port = chrome.runtime.connect({ name: "ask-stream" });
      } catch (err) {
        thinking.remove();
        addBotError(`Couldn't reach the assistant: ${err.message}`);
        resolve();
        return;
      }

      let stream = null;
      let accumulated = "";

      const ensureStarted = () => {
        if (stream) return;
        thinking.remove();
        stream = addStreamingBotMsg();
      };

      port.onMessage.addListener((msg) => {
        if (msg.type === "token") {
          ensureStarted();
          accumulated += msg.token;
          stream.textSpan.textContent = accumulated;
          chat.scrollTop = chat.scrollHeight;
        } else if (msg.type === "done") {
          ensureStarted();
          const d = msg.data || {};
          stream.textSpan.textContent = typeof d.answer === "string" ? d.answer : accumulated;
          stream.textSpan.classList.remove("mrag-streaming");
          let extra = renderSources(d.sources);
          const cost = fmtCost(d);
          if (cost) extra += `<div class="mrag-meta">${cost}</div>`;
          if (extra) stream.bubble.insertAdjacentHTML("beforeend", extra);
        } else if (msg.type === "error") {
          if (stream) {
            stream.textSpan.classList.remove("mrag-streaming");
            stream.bubble.insertAdjacentHTML(
              "beforeend",
              `<div class="mrag-notice mrag-notice-err" style="margin-top:8px">${esc(msg.error)}</div>`
            );
          } else {
            thinking.remove();
            addBotError(msg.error);
          }
          // Errors are terminal; background sends no "end" after one.
          port.disconnect();
          resolve();
        } else if (msg.type === "end") {
          port.disconnect();
          resolve();
        }
      });

      port.onDisconnect.addListener(() => {
        if (stream) stream.textSpan.classList.remove("mrag-streaming");
        else thinking.remove();
        resolve();
      });

      port.postMessage({ question: q, thread_id: threadId });
    });
  }

  let asking = false;
  async function sendQuestion() {
    const q = question.value.trim();
    if (!q || asking) return;
    asking = true;
    addUserMsg(q);
    question.value = "";
    autoGrow();
    sendBtn.disabled = true;
    const thinking = addThinking();

    const useThread = context.threadId && scopeBox.checked;
    await streamQuestion(q, useThread ? context.threadId : "", thinking);

    asking = false;
    sendBtn.disabled = false;
    question.focus();
  }

  // ---------- ANALYZE ----------
  analyzeBtn.addEventListener("click", async () => {
    if (!context.threadId) return;
    analyzeBtn.disabled = true;
    analyzeBtn.innerHTML = `<span class="mrag-spinner"></span> Summarizing…`;
    analyzeOut.innerHTML = "";

    const resp = await callApi("analyzePath", { thread_id: context.threadId });

    analyzeBtn.disabled = false;
    analyzeBtn.textContent = "Summarize this thread";

    if (!resp.ok) {
      analyzeOut.innerHTML = `<div class="mrag-notice mrag-notice-err">${esc(resp.error)}</div>`;
      return;
    }
    const d = resp.data || {};
    let html = `<div class="mrag-result">`;
    html += `<h4>Summary</h4><p>${esc(d.summary || "(no summary returned)")}</p>`;
    if (Array.isArray(d.action_items) && d.action_items.length) {
      html += `<h4>Action items</h4><ul class="mrag-actions-list">`;
      html += d.action_items.map((a) => `<li>${esc(typeof a === "string" ? a : (a.text || JSON.stringify(a)))}</li>`).join("");
      html += `</ul>`;
    }
    const cost = fmtCost(d);
    html += `<div class="mrag-result-foot"><button class="mrag-btn-ghost" id="mrag-copy-summary">Copy summary</button></div>`;
    if (cost) html += `<div class="mrag-meta">${cost}</div>`;
    html += `</div>`;
    analyzeOut.innerHTML = html;

    const copyBtn = $("#mrag-copy-summary", analyzeOut);
    if (copyBtn) copyBtn.addEventListener("click", () => {
      const text = [d.summary, "", ...(d.action_items || []).map((a) => "• " + (typeof a === "string" ? a : (a.text || "")))].join("\n");
      navigator.clipboard.writeText(text.trim()).then(() => showToast("Summary copied"));
    });
  });

  // ---------- REPLY ----------
  sender.addEventListener("input", () => { senderTouched = true; });

  function insertIntoCompose(text) {
    // Try to drop the draft into an open Gmail reply box.
    const box = document.querySelector('div[aria-label="Message Body"][role="textbox"], div[g_editable="true"][role="textbox"]');
    if (!box) return false;
    box.focus();
    // Replace contents with the draft, one <div> per line the way Gmail's own
    // editor does, so single line breaks (e.g. "Best,\nName") survive.
    box.innerHTML = "";
    text.split(/\r?\n/).forEach((line) => {
      const div = document.createElement("div");
      if (line.trim()) div.textContent = line;
      else div.appendChild(document.createElement("br"));
      box.appendChild(div);
    });
    box.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }

  replyBtn.addEventListener("click", async () => {
    if (!context.threadId) return;
    const raw = context.latestText || context.bodyText;
    if (!raw) { showToast("Couldn't read the message text"); return; }

    replyBtn.disabled = true;
    replyBtn.innerHTML = `<span class="mrag-spinner"></span> Drafting…`;
    replyOut.innerHTML = "";

    const resp = await callApi("replyPath", {
      raw_text: raw,
      thread_id: context.threadId,
      instructions: instructions.value.trim(),
      sender_name: sender.value.trim(),
    });

    replyBtn.disabled = false;
    replyBtn.textContent = "Draft a reply";

    if (!resp.ok) {
      replyOut.innerHTML = `<div class="mrag-notice mrag-notice-err">${esc(resp.error)}</div>`;
      return;
    }
    const d = resp.data || {};
    const draft = d.draft || "(no draft returned)";
    let html = `<div class="mrag-result"><h4>Draft</h4><p id="mrag-draft-text">${esc(draft)}</p>`;
    html += `<div class="mrag-result-foot">
      <button class="mrag-btn-ghost" id="mrag-copy-draft">Copy</button>
      <button class="mrag-btn-ghost" id="mrag-insert-draft">Insert into reply</button>
    </div>`;
    const cost = fmtCost(d);
    if (cost) html += `<div class="mrag-meta">${cost}</div>`;
    html += `</div>`;
    replyOut.innerHTML = html;

    $("#mrag-copy-draft", replyOut).addEventListener("click", () => {
      navigator.clipboard.writeText(draft).then(() => showToast("Draft copied"));
    });
    $("#mrag-insert-draft", replyOut).addEventListener("click", () => {
      if (insertIntoCompose(draft)) showToast("Inserted into reply");
      else showToast("Open a reply box in Gmail first");
    });
  });

  // initial state
  refreshContext();
  loadSession();
})();
