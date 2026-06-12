// Vercel serverless function — proxies commit-message generation to Anthropic.
// The API key stays server-side; the browser never sees it.
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    res.status(500).json({ error: "ANTHROPIC_API_KEY not set in Vercel env vars" });
    return;
  }
  try {
    const { groups } = req.body || {};
    if (!Array.isArray(groups) || groups.length === 0) {
      res.status(400).json({ error: "groups[] required" });
      return;
    }
    const prompt =
      `Write a concise, meaningful git commit message for each of the ${groups.length} file groups below. ` +
      `Use conventional-commit style (e.g. "feat: add login form", "docs: update readme", "chore: add config"). ` +
      `Infer intent from the file paths. Respond with ONLY a JSON array of exactly ${groups.length} strings — no markdown, no preamble.\n\n` +
      groups.map((g, i) => `Group ${i + 1}: ${g.join(", ")}`).join("\n");

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1000,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const data = await r.json();
    if (!r.ok) {
      res.status(r.status).json({ error: data.error?.message || "Anthropic API error" });
      return;
    }
    const text = (data.content || []).map((i) => (i.type === "text" ? i.text : "")).join("");
    const clean = text.replace(/```json|```/g, "").trim();
    const messages = JSON.parse(clean);
    res.status(200).json({ messages });
  } catch (e) {
    res.status(500).json({ error: e.message || "Server error" });
  }
}
