// @ts-check

// Session store: IP → { cookies, timestamp, userAgent }
const SESSION_STORE = new Map<string, { cookies: string; userAgent: string; timestamp: number }>();

// Common real user agents (rotate per session)
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:134.0) Gecko/20100101 Firefox/134.0',
];

// Get realistic headers for a session
function buildHeaders(cookies: string, userAgent: string, referer?: string) {
  return {
    'User-Agent': userAgent,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'DNT': '1',
    'Sec-GPC': '1',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': referer ? 'same-origin' : 'none',
    'Sec-Fetch-User': '?1',
    'Cache-Control': 'max-age=0',
    ...(referer ? { Referer: referer } : {}),
    ...(cookies ? { Cookie: cookies } : {}),
  };
}

// Parse Set-Cookie safely
function extractCookies(setCookie: string | null): string {
  if (!setCookie) return '';
  return setCookie
    .split(',')
    .map(c => c.split(';')[0].trim())
    .filter(c => c && !c.startsWith('path') && !c.startsWith('expires') && !c.startsWith('HttpOnly'))
    .join('; ');
}

// Simulate human visiting homepage first
async function establishSession(): Promise<{ cookies: string; userAgent: string }> {
  const userAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  
  // Visit homepage
  const homeRes = await fetch('https://duckduckgo.com', {
    method: 'GET',
    headers: buildHeaders('', userAgent),
    redirect: 'follow',
  });

  const cookies = extractCookies(homeRes.headers.get('set-cookie'));
  return { cookies, userAgent };
}

// Parse results from /html
function parseResults(html: string, max: number) {
  const results = [];
  const blocks = html.split('<div class="result__body">').slice(1);

  for (const block of blocks) {
    if (results.length >= max) break;

    const urlMatch = block.match(/<a class="result__a" href="([^"]+)"[^>]*>/);
    if (!urlMatch || !urlMatch[1].startsWith('http')) continue;

    const url = urlMatch[1];
    if (url.includes('duckduckgo.com')) continue; // skip special pages

    const titleMatch = block.match(/<a class="result__a"[^>]*>(.*?)<\/a>/);
    const descMatch = block.match(/<div class="result__snippet">(.*?)<\/div>/);

    let title = titleMatch?.[1] || 'No title';
    let desc = descMatch?.[1] || '';

    // Clean HTML entities
    const clean = (s: string) =>
      s.replace(/<b>|<\/b>/gi, '')
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .trim();

    title = clean(title);
    desc = clean(desc);

    results.push({ title, url, description: desc });
  }

  return results;
}

// Perform search with full human simulation
async function humanLikeSearch(query: string, count: number, clientIP: string) {
  const now = Date.now();

  // Reuse or create session
  let session = SESSION_STORE.get(clientIP);
  if (session && now - session.timestamp > 12 * 60 * 1000) {
    SESSION_STORE.delete(clientIP);
    session = undefined;
  }

  let cookies = '', userAgent = '';
  if (session) {
    ({ cookies, userAgent } = session);
  } else {
    // Simulate new human user
    await new Promise(r => setTimeout(r, Math.random() * 1000 + 300)); // landing delay
    const fresh = await establishSession();
    cookies = fresh.cookies;
    userAgent = fresh.userAgent;
    SESSION_STORE.set(clientIP, { cookies, userAgent, timestamp: now });
  }

  // Simulate typing + thinking delay
  await new Promise(r => setTimeout(r, Math.random() * 1200 + 400));

  // Perform search
  const searchUrl = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=wt-wt`;
  const searchRes = await fetch(searchUrl, {
    method: 'GET',
    headers: buildHeaders(cookies, userAgent, 'https://duckduckgo.com/'),
  });

  if (!searchRes.ok) {
    throw new Error(`HTTP ${searchRes.status}`);
  }

  const html = await searchRes.text();

  if (html.includes('blocked your request') || html.includes('captcha')) {
    throw new Error('Blocked by anti-bot system');
  }

  return parseResults(html, count);
}

// Rate limiting
const RATE_LIMITS = new Map<string, { count: number; reset: number }>();
const MAX_PER_MIN = 3; // conservative

function enforceRateLimit(ip: string) {
  const now = Date.now();
  const rec = RATE_LIMITS.get(ip);
  if (rec && now > rec.reset) RATE_LIMITS.delete(ip);

  const current = RATE_LIMITS.get(ip) || { count: 0, reset: now + 60_000 };
  if (current.count >= MAX_PER_MIN) {
    throw new Error('Rate limit: 3 requests/minute/IP');
  }
  RATE_LIMITS.set(ip, { count: current.count + 1, reset: current.reset });
}

// Main handler
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).end();
  }

  const clientIP = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || '127.0.0.1';

  try {
    enforceRateLimit(clientIP);

    const { name, arguments: args } = req.body || {};

    if (name !== 'duckduckgo_web_search' || !args?.query || typeof args.query !== 'string') {
      return res.status(400).json({
        content: [{ type: 'text', text: 'Invalid request format' }],
        isError: true,
      });
    }

    const count = Math.min(Math.max(Number(args.count) || 10, 1), 20);

    const results = await humanLikeSearch(args.query, count, clientIP);

    const markdown = results.length === 0
      ? `# DuckDuckGo Search Results\nNo results for "${args.query}".`
      : `# DuckDuckGo Search Results\nQuery: ${args.query} (${results.length} found)\n\n---\n\n` +
        results.map(r => `### ${r.title}\n${r.description}\n🔗 [Read more](${r.url})`).join('\n\n');

    return res.status(200).json({
      content: [{ type: 'text', text: markdown }],
      isError: false,
    });

  } catch (error) {
    console.error(`[DDG-SCRAPER] IP=${clientIP} ERROR:`, error.message);
    return res.status(200).json({
      content: [{
        type: 'text',
        text: `⚠️ Search unavailable.\nReason: ${error.message}\n\n💡 DDG blocks cloud scrapers aggressively. Try simpler queries or local hosting.`
      }],
      isError: true,
    });
  }
}
