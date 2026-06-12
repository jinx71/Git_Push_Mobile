// Vercel serverless function — generates commit messages via the Gemini API.
// The API key stays server-side; the browser never sees it.
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    res.status(500).json({ error: "GEMINI_API_KEY not set in Vercel env vars" });
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
      `Infer intent from the file paths. Return a JSON array of exactly ${groups.length} strings, in order.\n\n` +
      groups.map((g, i) => `Group ${i + 1}: ${g.join(", ")}`).join("\n");

    const MODEL = "gemini-2.5-flash";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": key,
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        // Ask Gemini to return strict JSON so parsing is reliable.
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: {
            type: "ARRAY",
            items: { type: "STRING" },
          },
        },
      }),
    });

    const data = await r.json();
    if (!r.ok) {
      res.status(r.status).json({ error: data.error?.message || "Gemini API error" });
      return;
    }

    const text =
      data.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
    let messages;
    try {
      messages = JSON.parse(text);
    } catch {
      // fallback: pull the first JSON array out of the text
      const m = text.match(/\[[\s\S]*\]/);
      messages = m ? JSON.parse(m[0]) : null;
    }
    if (!Array.isArray(messages)) {
      res.status(502).json({ error: "Could not parse Gemini response" });
      return;
    }
    res.status(200).json({ messages: messages.map(String) });
  } catch (e) {
    res.status(500).json({ error: e.message || "Server error" });
  }
}
