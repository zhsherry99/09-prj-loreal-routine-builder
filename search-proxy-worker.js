/*
  Cloudflare Worker: combined OpenAI chat + Google Web Search proxy

  Routes:
    POST /chat
        - body: { message: string } OR { messages: [...] }
        - The worker will run a Responses-based web search (via OpenAI Responses API)
          using the provided message (or the last user message from messages) as the
          query to gather current web results. The top results are prepended as a
          system message so the model can cite them. Forwards the assembled messages
          to OpenAI Responses API using env.OPENAI_API_KEY and returns
          { reply: <assistant_text>, web_results: [...], openai: <raw_responses_json> }

    POST /search
      - body: { q: "..." }
      - Returns { results: [...] } from Google Custom Search.

  Environment variables required:
    - OPENAI_API_KEY : OpenAI API key
  - OPENAI_API_KEY : OpenAI API key

  Security: keep keys in worker environment. This worker sets permissive CORS by default.
*/

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

/*
  doOpenAISearch(query, env)
  - Uses the OpenAI Responses API to request up-to-date web search results.
  - Note: this implementation asks the Responses model to "search the web" and
    return a JSON array of results. Availability and exact behavior depends on
    your OpenAI account and model (some accounts/models provide browsing/tools).
  - If your account has the official Responses web_search/tool integration,
    you can replace this function with a direct tool invocation.
*/
async function doOpenAISearch(q, env, max = 6) {
  const key = env.OPENAI_API_KEY;
  if (!key) throw new Error("Missing OPENAI_API_KEY in worker environment");

  // Craft a short instruction asking the model to return recent web results in
  // a strict JSON array. This relies on the model's browsing/web-tools being
  // available; if not available the assistant may fallback or hallucinate.
  const prompt = `Perform a live web search for the query below and return up to ${max} results as a JSON array of objects with keys: title, snippet, url.\n\nQuery: ${q}`;

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ model: "gpt-4o", input: prompt, temperature: 0.0 }),
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`OpenAI search error: ${resp.status} - ${txt}`);
  }

  const j = await resp.json();

  // Try to extract plain text from Responses API output
  let txt = "";
  try {
    if (Array.isArray(j.output) && j.output.length) {
      // output elements may contain content arrays with text
      for (const o of j.output) {
        if (o.type === "output_text" && o.content) {
          // some responses place text at o.content[0].text or o.text
          if (typeof o.content === "string") txt += o.content + "\n";
          else if (Array.isArray(o.content)) {
            for (const c of o.content) {
              if (c && c.type === "output_text" && c.text) txt += c.text + "\n";
              else if (typeof c === "string") txt += c + "\n";
            }
          } else if (o.text) txt += o.text + "\n";
        } else if (o.type === "message" && o.content) {
          // older shapes
          const parts = o.content.map((c) => c.text || "").join("\n");
          txt += parts + "\n";
        }
      }
    } else if (j.output_text) {
      txt = j.output_text;
    }
  } catch (e) {
    // ignore and fallback to raw stringify
    txt = JSON.stringify(j);
  }

  // Try to parse JSON from the model's answer
  let results = [];
  try {
    const firstJson = txt.trim().match(/\[\s*{[\s\S]*}\s*\]/);
    const jsonText = firstJson ? firstJson[0] : txt;
    results = JSON.parse(jsonText);
    if (!Array.isArray(results)) results = [];
  } catch (e) {
    // If parsing failed, attempt to extract URLs and create simple snippets
    const lines = txt
      .split(/\n+/)
      .map((l) => l.trim())
      .filter(Boolean);
    for (const ln of lines.slice(0, max)) {
      const urlMatch = ln.match(/https?:\/\/[\w./?&=%-#]+/);
      results.push({
        title: ln.slice(0, 80),
        snippet: ln.slice(0, 200),
        url: urlMatch ? urlMatch[0] : "",
      });
    }
  }

  return results.slice(0, max);
}

async function callOpenAIResponses(messages, env) {
  const key = env.OPENAI_API_KEY;
  if (!key) throw new Error("Missing OPENAI_API_KEY in worker environment");

  // Build a concatenated input so Responses can process system/user context.
  const parts = [];
  for (const m of messages) {
    if (m.role === "system") parts.push(`SYSTEM: ${m.content}`);
    else if (m.role === "user") parts.push(`USER: ${m.content}`);
    else if (m.role === "assistant") parts.push(`ASSISTANT: ${m.content}`);
  }
  const input = parts.join("\n\n");

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ model: "gpt-4o", input, temperature: 0.2 }),
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`OpenAI Responses API error: ${resp.status} - ${txt}`);
  }

  const j = await resp.json();

  // Extract assistant text from Responses output
  let assistantText = "";
  try {
    if (Array.isArray(j.output) && j.output.length) {
      for (const o of j.output) {
        if (o.type === "output_text") {
          if (typeof o.content === "string") assistantText += o.content + "\n";
          else if (Array.isArray(o.content)) {
            for (const c of o.content) {
              if (c && c.type === "output_text" && c.text)
                assistantText += c.text + "\n";
              else if (typeof c === "string") assistantText += c + "\n";
            }
          } else if (o.text) assistantText += o.text + "\n";
        } else if (o.type === "message" && o.content) {
          const parts = o.content.map((c) => c.text || "").join("\n");
          assistantText += parts + "\n";
        }
      }
    } else if (j.output_text) {
      assistantText = j.output_text;
    }
  } catch (e) {
    assistantText = JSON.stringify(j);
  }

  return { raw: j, text: assistantText };
}
export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    try {
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/$/, ""); // trim trailing slash

      if (request.method === "POST" && path.endsWith("/chat")) {
        const ct = request.headers.get("content-type") || "";
        if (!ct.includes("application/json")) {
          return new Response(
            JSON.stringify({ error: "Expected application/json" }),
            {
              status: 400,
              headers: CORS_HEADERS,
            }
          );
        }

        const body = await request.json();
        const messages = Array.isArray(body.messages)
          ? body.messages.slice()
          : [];

        // accept either an array of messages or a single message string
        let messageString = "";
        if (body.message && typeof body.message === "string") {
          messageString = body.message.trim();
        } else if (Array.isArray(body.messages) && body.messages.length) {
          // find last user message
          const lastUser = [...body.messages]
            .reverse()
            .find((m) => m.role === "user");
          if (lastUser) messageString = lastUser.content || "";
        }

        // perform a Responses-driven web search using the message string as the query
        let webResults = [];
        if (messageString) {
          try {
            webResults = await doOpenAISearch(messageString, env, 6);
            const formatted = webResults
              .map((r, i) => `${i + 1}. ${r.title}\n${r.snippet}\n${r.url}`)
              .join("\n\n");
            if (formatted) {
              messages.unshift({
                role: "system",
                content: `Web search results (top):\n\n${formatted}`,
              });
            }
          } catch (err) {
            messages.unshift({
              role: "system",
              content: `Web search failed: ${err.message}`,
            });
          }
        }

        // call the Responses API to generate an assistant reply
        const openaiResp = await callOpenAIResponses(messages, env);

        return new Response(
          JSON.stringify({
            reply: openaiResp.text,
            web_results: webResults,
            openai: openaiResp.raw,
          }),
          { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
        );
      }

      // simple search-only endpoint: POST /search { q }
      if (request.method === "POST" && path.endsWith("/search")) {
        const ct = request.headers.get("content-type") || "";
        if (!ct.includes("application/json")) {
          return new Response(
            JSON.stringify({ error: "Expected application/json" }),
            {
              status: 400,
              headers: CORS_HEADERS,
            }
          );
        }
        const body = await request.json();
        const q = (body.q || body.query || "").toString().trim();
        if (!q)
          return new Response(JSON.stringify({ results: [] }), {
            headers: CORS_HEADERS,
          });

        const results = await doOpenAISearch(q, env, 8);
        return new Response(JSON.stringify({ results }), {
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: CORS_HEADERS,
      });
    } catch (err) {
      return new Response(
        JSON.stringify({ error: err.message || String(err) }),
        {
          status: 500,
          headers: CORS_HEADERS,
        }
      );
    }
  },
};
