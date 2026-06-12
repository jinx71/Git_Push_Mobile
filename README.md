# git push mobile

Mobile-friendly web app to commit & push to GitHub repos — single-file edits,
whole-folder pushes (one commit per file OR a target commit count spread over a
date range), commit backdating via the Git Data API, and AI-generated commit
messages.

## Run locally
    npm install
    npm run dev

## Deploy on Vercel
1. Push this project to a GitHub repo.
2. On vercel.com → Add New → Project → import the repo → Deploy. Vite is
   auto-detected; no build settings to change.

## Enable AI commit messages (optional)
The ✨ button calls a serverless function at `api/messages.js` that talks to the
Anthropic API. For it to work on your deployment:

1. Get an API key from console.anthropic.com.
2. In Vercel → your project → Settings → Environment Variables, add:
   `ANTHROPIC_API_KEY = sk-ant-...`
3. Redeploy.

Without the key the app still works — it falls back to auto-generated messages
derived from your file paths.

## Notes
- Your GitHub token is entered at runtime and kept only in browser memory.
- The Anthropic key lives only in Vercel's server env, never in the browser.
