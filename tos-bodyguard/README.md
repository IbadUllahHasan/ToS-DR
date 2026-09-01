# 🛡️ TOS Bodyguard

A Manifest V3 Chrome extension that automatically reads Terms of Service, Privacy
Policies, and cookie banners, then analyzes them **100% on-device** with Chrome's
built-in AI (Gemini Nano via the Prompt API) to surface user-hostile clauses.

## Features

- **Automatic policy discovery** — finds "Privacy Policy" / "Terms of Service" links
  (footer-first heuristics), fetches and extracts their text, truncated to 8,000 chars.
- **Local AI risk analysis** — flags 5 categories of hostile clauses:
  `DATA_RESALE`, `INFINITE_RETENTION`, `AGGRESSIVE_TRACKING`, `LEGAL_TRAPS`,
  `SHADOW_PROFILING` — each with a severity, plain-English summary, and verbatim quote.
- **Badge risk indicator** — red badge with the risk count, green when clean.
- **Cookie-banner auto-reject** — clicks "Reject All" using per-domain rules (`rules.json`).
- **Manual scan** — analyze any page directly from the popup.
- **Live queue + progress bar** — see which site the on-device AI is reading,
  which sites are waiting, and real generation progress (via promptStreaming).
- **Optional cloud providers** — bring your own Gemini / Groq / OpenAI / MiniMax
  API key (gear icon in the popup) for fast, full-document analysis: the policy
  is split into overlapping chunks, analyzed in parallel, and merged with dedupe
  — the whole document is checked, not just the first 8,000 chars. Cloud
  summaries use a stricter, plain-English prompt. Keys are stored locally and
  read only by the service worker; with a cloud provider, policy text leaves
  your device for analysis.
- **Filterable, expandable risk list** — severity chips + category filter;
  cards stay collapsed until clicked.
- **Light & dark mode** — follows your OS by default, toggle in the header.
- **First-run setup guide** — one-time onboarding for Nano flags or cloud keys.
- **Privacy by design** — no network calls with page content unless you
  configure a cloud provider; everything else runs locally.

## Install

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select this folder.

## Enable Chrome's built-in AI

The Prompt API requires Chrome 127+ (recommended: latest stable) and Gemini Nano:

1. Go to `chrome://flags` and enable:
   - **#prompt-api-for-gemini-nano**
   - **#optimization-guide-on-device-model** (set to *Enabled BypassPerfRequirement*)
2. Restart Chrome. The model downloads on first use (can take a few minutes).
3. Sanity check in any page's DevTools console: `await window.ai.languageModel.capabilities()`

If the API is missing, the popup shows: *"Chrome Built-in AI is not enabled.
Please enable it in chrome://flags."*

## Architecture

| File | Role |
| --- | --- |
| `manifest.json` | MV3 manifest (storage, scripting, tabs + `<all_urls>` host access) |
| `content.js` | Link discovery, text extraction, AI analysis, cookie-banner rejection |
| `background.js` | Badge management, cross-origin fetch relay, MAIN-world AI bridge |
| `popup.html` / `popup.js` / `popup.css` | Popup UI (risk score + risk cards) |
| `rules.json` | Cookie-banner reject-button selectors (per-domain + global CMP rules) |

### Design notes

- **Prompt API access.** Content scripts run in an isolated JS world. `content.js`
  tries `window.ai.languageModel` → `window.LanguageModel` → `chrome.aiOriginTrial`
  in order; if none exist, the service worker runs the prompt in the page's MAIN
  world via `chrome.scripting.executeScript({ world: 'MAIN' })`.
- **CORS.** Same-origin policy pages are fetched by the content script; cross-origin
  policy hubs are fetched by the service worker (host permissions bypass CORS).
- **Tailwind.** The Tailwind Play CDN is remote code, which MV3 forbids in extension
  pages. `popup.css` ships the Tailwind-compatible utilities used by the markup;
  swap in a compiled Tailwind build if you want the full framework.
- **Security.** All model/page-derived strings render via `textContent` (no
  `innerHTML`), AI output is schema-validated and length-capped, and results are
  cached per-hostname for 30 minutes to avoid re-analysis on every pageview.

## Dev

```bash
node tests/run_tests.js   # unit tests (mocked Chrome APIs)
```
