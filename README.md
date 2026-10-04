# ABHYNEX JARVIS - Gemini Mobile Edition

Mobile-first JARVIS-style voice assistant (installable Android PWA).
Android Chrome / PWA -> JARVIS UI -> Node.js backend -> Gemini API -> text + voice.
No npm dependencies (Node 18+). Claude/Anthropic is fully removed.

## 1. Local setup
```bash
cp .env.example .env        # fill in values, then load them:
export $(grep -v '^#' .env | xargs)   # or set the variables in your shell
npm install
npm start                   # http://localhost:3000
```
Microphone access requires HTTPS or localhost.

## 2. Environment variables (server-side only)
| Variable | Required | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | yes | Gemini key from Google AI Studio. Never sent to the browser. |
| `APP_PASSCODE` | yes | Passcode shown on the lock screen. Never sent to the browser. |
| `GEMINI_MODEL` | no | Defaults to `gemini-flash-latest` (Google's rolling alias). Set a specific model to pin it. |
| `SEARCH_API_KEY` | no | Enables live search (Brave Search API adapter in `server.js`). Without it JARVIS says live search is unavailable. |

## 3. Render deployment
1. Push this folder to GitHub.
2. Render -> New -> Blueprint (uses `render.yaml`), or New Web Service with: runtime Node, build `npm install`, start `npm start`, health check `/healthz`.
3. Add `GEMINI_API_KEY` and `APP_PASSCODE` (and optionally `GEMINI_MODEL`, `SEARCH_API_KEY`) in the Environment tab.
4. Open your `onrender.com` URL. `/` now serves JARVIS (fixes "Cannot GET /"). Free instances sleep, so the first load can take ~30 seconds.

## 4. Android installation
Open the Render URL in Chrome -> tap **Install JARVIS** in the app. If the native prompt does not appear: Chrome -> ⋮ -> **Add to Home screen**. Allow microphone access when asked.

## 5. How to use
Enter the passcode -> JARVIS ONLINE -> tap the microphone and speak (English, Hindi or Marathi; change in Settings) or type. Replies are spoken if Voice is ON. Each reply has Copy / Speak / Stop.
Commands (start with "JARVIS," if you like): `search ...` (needs SEARCH_API_KEY), `remember this: ...` (saved on your device), `open example.com` (gives a tap-able link), plus explain / summarize / "tell me today's information" (uses your phone's date and time).
Limits: a browser app cannot call, set alarms or change phone settings, and JARVIS will say so. Voice quality and Marathi voices depend on the Android text-to-speech voices installed (Settings -> Voice).

Privacy: chats and notes live only in your browser's localStorage. Secrets are never stored there. The login session token lives in sessionStorage and expires after 12 hours.
