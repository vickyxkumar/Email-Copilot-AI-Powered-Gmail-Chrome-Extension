# Mail RAG Assistant — Chrome extension

A side panel injected into Gmail (web) that talks to **your** RAG backend. Three modes:

- **Ask** — chat with your indexed mail. `POST /ask` → `{question, thread_id}`. Optionally scopes to the open thread.
- **Summarize** — summarize the open thread. `POST /analyze` → `{thread_id}`, renders `summary` + `action_items`.
- **Reply** — draft a reply from the open message. `POST /reply` → `{raw_text, thread_id, instructions, sender_name}`, renders `draft` with copy / insert-into-Gmail.

Auth is intentionally left out for now — the backend handles Google auth, per your setup.

## Install (unpacked)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this `gmail-rag-extension/` folder.
4. Open `https://mail.google.com`. Click **Ask your mail** (bottom-right) to open the panel.

## Configure

Click the extension's toolbar icon for settings:

- **API base URL** — default `http://localhost:8000`.
- **Ask / Reply / Analyze endpoints** — default `/ask`, `/reply`, `/analyze`.

> Your spec listed the reply route as `/ask` too — that's almost certainly a typo, so the default is `/reply`. Change it in settings if your route differs. No code edits needed.

Reload the Gmail tab after changing the base URL.

### Moving off localhost

Requests are made from the background service worker, so CORS isn't an issue — but the
target host must be in `host_permissions`. `manifest.json` currently allows only
localhost. When you point at a real domain, add it there, e.g.:

```json
"host_permissions": ["http://localhost/*", "http://127.0.0.1/*", "https://api.yourdomain.com/*"]
```

Then reload the extension.

## Test without your backend

A mock server matching all three schemas is included:

```bash
pip install fastapi uvicorn
python mock_backend.py   # http://localhost:8000
```

Open any Gmail thread and try each tab — you'll get canned-but-shaped responses.

## How it reads the open thread

- **thread_id** — from `data-legacy-thread-id` on the open conversation (Gmail's API/hex id), falling back to the URL hash. This is what's sent to your backend.
- **Subject / body** — the open thread's subject (`h2.hP`) and visible message bodies (`div.a3s`). The newest message's text is sent as `raw_text` for replies.

Gmail's DOM is unofficial and changes over time. If extraction ever breaks, the selectors
to update live in `readContext()` in `content.js`.

## Files

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest, permissions, content-script registration |
| `background.js` | Service worker; proxies API calls, formats 422 / network errors |
| `content.js` | Injects the panel, extracts thread context, drives the 3 modes |
| `content.css` | Scoped panel styling (all selectors under `#mrag-root`) |
| `popup.html` / `popup.js` | Settings (base URL + endpoint paths) |
| `mock_backend.py` | Optional local test server |
| `icons/` | Toolbar / store icons |
