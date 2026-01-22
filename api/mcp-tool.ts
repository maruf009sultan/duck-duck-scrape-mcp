// @ts-check
import * as DDG from "duck-duck-scrape";

// In-memory cookie & session store (resets on cold start)
const SESSION_STORE = new Map<string, { cookies: string; timestamp: number }>();

// Realistic browser-like headers
const BASE_HEADERS = {
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
  'Accept-Encoding': 'gzip, deflate, br',
  'DNT': '1',
  'Sec-GPC': '1',
  'Connection': 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
};

function getRealisticHeaders(cookies?: string) {
  const headers: Record<string, string> = {
    ...BASE_HEADERS,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:134.0) Gecko/20100101 Firefox/134.0',
  };
  if (cookies) {
    headers['Cookie'] = cookies;
  }
  return headers;
}

async function getInitialCookies() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const res = await fetch('https://duckduckgo.com', {
      method: 'GET',
      headers: getRealisticHeaders(),
      redirect: 'follow',
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const cookieHeader = res.headers.get('set-cookie');
    if (!cookieHeader) return '';

    // Extract cookies (simplified)
    const cookies = cookieHeader
      .split(',')
      .map(c => c.split(';')[0])
      .join('; ');

    return cookies;
  } catch (e) {
    console.warn('Failed to fetch initial cookies:', e.message);
    return '';
  }
}

async function performSearchWithSession(query: string, count: number, clientIP: string) {
  // Try to reuse session
  let session = SESSION_STORE.get(clientIP);
  const now = Date.now();

  // Expire sessions after 10 minutes
  if (session && now - session.timestamp > 10 * 60 * 1000) {
    SESSION_STORE.delete(clientIP);
    session = undefined;
  }

  let cookies = session?.cookies || '';

  // If no cookies, fetch new ones
  if (!cookies) {
    cookies = await getInitialCookies();
    if (cookies) {
      SESSION_STORE.set(clientIP, { cookies, timestamp: now });
    }
  }

  // Add small delay to mimic human
  await new Promise(r => setTimeout(r, Math.random() * 1000 + 500));

  try {
    const results = await DDG.search(query, {
      safeSearch: DDG.SafeSearchType.OFF,
      headers: getRealisticHeaders(cookies),
      // Note: duck-duck-scrape internally uses its own fetch — we can't fully control it
      // So we also patch global fetch (see below)
    });

    return results;
  } catch (e) {
    // Fallback: try without cookies
    if (cookies) {
      try {
        const results = await DDG.search(query, {
          safeSearch: DDG.SafeSearchType.OFF,
          headers: getRealisticHeaders(),
        });
        return results;
      } catch (e2) {
        throw e; // original error
      }
    }
    throw e;
  }
}

// Patch global fetch to include realistic headers (for duck-duck-scrape internals)
const originalFetch = global.fetch;
global.fetch = async (url, options = {}) => {
  const isDDG = typeof url === 'string' && url.includes('duckduckgo.com');
  if (isDDG && !options.headers) {
    options.headers = getRealisticHeaders();
  }
  return originalFetch(url, options);
};

// Rate limiter (per IP)
const RATE_LIMITS = new Map<string, { count: number; reset: number }>();
const MAX_REQ_PER_MIN = 5;

function checkRateLimit(ip: string) {
  const now = Date.now();
  const record = RATE_LIMITS.get(ip);
  if (record && now > record.reset) {
    RATE_LIMITS.delete(ip);
  }

  const current = RATE_LIMITS.get(ip) || { count: 0, reset: now + 60_000 };
  if (current.count >= MAX_REQ_PER_MIN) {
    throw new Error(`Rate limit exceeded. Try again in 1 minute.`);
  }

  RATE_LIMITS.set(ip, { count: current.count + 1, reset: current.reset });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Get client IP (Vercel provides this)
  const clientIP = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';

  try {
    checkRateLimit(clientIP);

    const body = req.body;
    const { name, arguments: args } = body;

    if (name !== 'duckduckgo_web_search') {
      return res.status(400).json({
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true,
      });
    }

    if (!args?.query || typeof args.query !== 'string') {
      return res.status(400).json({
        content: [{ type: 'text', text: 'Missing or invalid "query" argument' }],
        isError: true,
      });
    }

    const count = Math.min(Math.max(Number(args.count) || 10, 1), 20);

    let searchResults;
    try {
      searchResults = await performSearchWithSession(args.query, count, clientIP);
    } catch (e) {
      // Final fallback: try public CORS proxy (risky, slow, but may work)
      // Only for non-sensitive queries
      if (e.message.includes('VQD') || e.message.includes('blocked')) {
        try {
          const proxyUrl = `https://corsproxy.io/?https://duckduckgo.com/html/?q=${encodeURIComponent(args.query)}`;
          const htmlRes = await fetch(proxyUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36' }
          });
          const html = await htmlRes.text();
          // Very basic parsing (not full replacement!)
          const matches = [...html.matchAll(/<a class="result__a" href="([^"]+)">([^<]+)<\/a>/g)];
          if (matches.length > 0) {
            const limited = matches.slice(0, count);
            const markdown = `# DuckDuckGo (via proxy) Results\nQuery: ${args.query}\n\n---\n\n` +
              limited.map(([, url, title]) =>
                `### ${title.trim()}\n🔗 [Read more](${url})`
              ).join('\n\n');
            return res.status(200).json({
              content: [{ type: 'text', text: markdown }],
              isError: false,
            });
          }
        } catch (proxyErr) {
          console.warn('Proxy fallback failed:', proxyErr.message);
        }
      }
      throw e;
    }

    if (!searchResults?.results?.length) {
      return res.status(200).json({
        content: [{ type: 'text', text: `# DuckDuckGo Search Results\nNo results found for "${args.query}".` }],
        isError: false,
      });
    }

    const limited = searchResults.results.slice(0, count);
    const markdown = `# DuckDuckGo Search Results\n${args.query} (${limited.length} found)\n\n---\n\n` +
      limited.map(r => `### ${r.title}\n${r.description || ''}\n🔗 [Read more](${r.url})`).join('\n\n');

    return res.status(200).json({
      content: [{ type: 'text', text: markdown }],
      isError: false,
    });

  } catch (error) {
    console.error('Search error:', error.message);
    return res.status(200).json({
      content: [{
        type: 'text',
        text: `⚠️ Search failed: ${error.message}\n\n💡 Tip: Try a simpler query, or wait and retry. Cloud scrapers are often blocked by DuckDuckGo.`
      }],
      isError: true,
    });
  }
}
