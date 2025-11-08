/*
Minimal Cloudflare Worker search proxy
- Accepts POST { q } (recommended) or GET ?q=...
- Prefers SERPAPI if env.SERPAPI_KEY is provided, otherwise uses Bing if env.BING_KEY is provided.
- Returns JSON: { results: [ { title, snippet, url }, ... ] }

Deployment notes:
- Bind your search provider API key in the worker's environment variables (SERPAPI_KEY or BING_KEY).
- Configure CORS as needed; this template allows any origin.

Security note: keep API keys in the worker environment (do NOT embed them in client-side JS).
*/

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    try {
      let q = "";
      if (request.method === "POST") {
        const ct = request.headers.get("content-type") || "";
        if (ct.includes("application/json")) {
          const body = await request.json();
          q = body.q || body.query || "";
        } else {
          const form = await request.formData();
          q = form.get("q") || "";
        }
      } else {
        const url = new URL(request.url);
        q = url.searchParams.get("q") || "";
      }

      q = (q || "").toString().trim();
      if (!q) {
        return new Response(JSON.stringify({ results: [] }), {
          headers: CORS_HEADERS,
        });
      }

      const serpKey = env.SERPAPI_KEY;
      // Use Google Programmable Search as the fallback when SerpAPI is not configured.
      const googleKey = env.GOOGLE_API_KEY;
      const googleCx = env.GOOGLE_CX; // Programmable Search Engine ID (cx)
      let results = [];

      if (serpKey) {
        // SerpAPI example: https://serpapi.com/search.json?engine=google&q={query}&api_key={API_KEY}
        const url = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(
          q
        )}&api_key=${encodeURIComponent(serpKey)}`;
        const r = await fetch(url);
        if (r.ok) {
          const j = await r.json();
          const items =
            j.organic_results || j.organic || j["organic_results"] || [];
          results = (items || []).slice(0, 6).map((i) => ({
            title: i.title || "",
            snippet: i.snippet || i.description || "",
            url: i.link || i.url || i.source || "",
          }));
        }
      } else if (googleKey && googleCx) {
        // Google Programmable Search (Custom Search JSON API)
        // Docs: https://developers.google.com/custom-search/v1/using_rest
        const url = `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(
          googleKey
        )}&cx=${encodeURIComponent(googleCx)}&q=${encodeURIComponent(q)}&num=6`;
        const r = await fetch(url);
        if (r.ok) {
          const j = await r.json();
          const items = j.items || [];
          results = (items || []).slice(0, 6).map((i) => ({
            title: i.title || "",
            snippet: i.snippet || i.snippet || "",
            url: i.link || i.formattedUrl || "",
          }));
        }
      } else {
        return new Response(
          JSON.stringify({
            error:
              "No search API key configured (SERPAPI_KEY or GOOGLE_API_KEY+GOOGLE_CX).",
          }),
          { status: 400, headers: CORS_HEADERS }
        );
      }

      return new Response(JSON.stringify({ results }), {
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    } catch (err) {
      return new Response(
        JSON.stringify({ error: err.message || String(err) }),
        { status: 500, headers: CORS_HEADERS }
      );
    }
  },
};
