// @ts-check
import * as DDG from "duck-duck-scrape";

// Simple in-memory rate limiter (resets per instance; fine for low usage)
let requestCount = 0;
let lastReset = Date.now();

const RATE_LIMIT_PER_MINUTE = 10; // adjust as needed

function checkRateLimit() {
  const now = Date.now();
  if (now - lastReset > 60_000) {
    requestCount = 0;
    lastReset = now;
  }
  if (requestCount >= RATE_LIMIT_PER_MINUTE) {
    throw new Error("Rate limit exceeded: max 10 requests per minute");
  }
  requestCount++;
}

export default async function handler(req, res) {
  // Only allow POST
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const body = req.body;
    const { name, arguments: args } = body;

    if (name !== "duckduckgo_web_search") {
      return res.status(400).json({
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      });
    }

    if (!args?.query || typeof args.query !== "string") {
      return res.status(400).json({
        content: [{ type: "text", text: "Missing or invalid 'query' argument" }],
        isError: true,
      });
    }

    const count = Math.min(Math.max(args.count || 10, 1), 20);

    checkRateLimit();

    const searchResults = await DDG.search(args.query, {
      safeSearch: DDG.SafeSearchType.OFF,
    });

    if (!searchResults?.results?.length) {
      return res.status(200).json({
        content: [{ type: "text", text: `# DuckDuckGo Search Results\nNo results found for "${args.query}".` }],
        isError: false,
      });
    }

    const limitedResults = searchResults.results.slice(0, count);
    const formattedResults = limitedResults.map(r => 
      `### ${r.title}\n${r.description || ''}\n🔗 [Read more](${r.url})`
    ).join('\n\n');

    const markdown = `# DuckDuckGo Search Results\n${args.query} search results (${limitedResults.length} found)\n\n---\n\n${formattedResults}`;

    return res.status(200).json({
      content: [{ type: "text", text: markdown }],
      isError: false,
    });

  } catch (error) {
    console.error("Tool execution error:", error);
    return res.status(500).json({
      content: [{ type: "text", text: `Error: ${error.message}` }],
      isError: true,
    });
  }
}
