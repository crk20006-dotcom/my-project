import crypto from 'node:crypto';
import net from 'node:net';

export interface WorldSourceRecord {
  id: string;
  provider: 'wikipedia' | 'arxiv' | 'rss' | 'webpage';
  title: string;
  url: string;
  published_at: string | null;
  retrieved_at: string;
  snippet: string;
  content_type: string;
  attribution: string;
}

export interface WorldSearchResponse {
  ok: boolean;
  provider: string;
  query: string;
  retrieved_at: string;
  network_available: boolean;
  results: WorldSourceRecord[];
  error?: string;
}

export interface WorldUrlFetchResponse {
  ok: boolean;
  url: string;
  final_url: string;
  source_kind: 'rss' | 'atom' | 'html' | 'text';
  retrieved_at: string;
  network_available: boolean;
  title: string;
  published_at: string | null;
  items: WorldSourceRecord[];
  text_excerpt: string;
  error?: string;
}

export interface WorldProviderDescriptor {
  id: 'wikipedia' | 'arxiv';
  name: string;
  description: string;
  requires_api_key: false;
  endpoint_base: string;
  source_category: 'encyclopedia' | 'scientific_preprints';
}

export interface WorldSearchProviderAdapter {
  readonly descriptor: WorldProviderDescriptor;
  search(query: string, limit: number): Promise<WorldSearchResponse>;
}

const MAX_RESPONSE_BYTES = 1_500_000;
const FETCH_TIMEOUT_MS = 8_000;
const MAX_REDIRECTS = 3;
const WORLD_RATE_WINDOW_MS = 60_000;
const WORLD_RATE_MAX_REQUESTS = 20;

const requestTimestampsByClient = new Map<string, number[]>();

export function checkWorldRateLimit(clientKey: string): { allowed: boolean; retryAfterSec: number } {
  const now = Date.now();
  const recent = (requestTimestampsByClient.get(clientKey) || []).filter(
    (ts) => now - ts < WORLD_RATE_WINDOW_MS
  );
  if (recent.length > 0) {
    requestTimestampsByClient.set(clientKey, recent);
  } else {
    requestTimestampsByClient.delete(clientKey);
  }
  if (recent.length >= WORLD_RATE_MAX_REQUESTS) {
    const retryAfterSec = Math.max(1, Math.ceil((WORLD_RATE_WINDOW_MS - (now - recent[0])) / 1000));
    return { allowed: false, retryAfterSec };
  }
  recent.push(now);
  requestTimestampsByClient.set(clientKey, recent);
  return { allowed: true, retryAfterSec: 0 };
}

function isPrivateOrDisallowedIpv4(ip: string): boolean {
  const parts = ip.split('.').map((n) => Number(n));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // Link-local & cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // Multicast & reserved
  return false;
}

function isPrivateOrDisallowedIp(ip: string): boolean {
  const stripped = ip.replace(/^\[|\]$/g, '').toLowerCase();
  const ver = net.isIP(stripped);
  if (ver === 4) {
    return isPrivateOrDisallowedIpv4(stripped);
  }
  if (ver === 6) {
    if (stripped === '::' || stripped === '::1') return true;
    if (stripped.startsWith('fe80:') || stripped.startsWith('fc') || stripped.startsWith('fd')) {
      return true;
    }
    if (stripped.startsWith('::ffff:')) {
      return isPrivateOrDisallowedIpv4(stripped.slice(7));
    }
    return false;
  }
  return false;
}

export function validateExternalPublicUrl(rawUrl: string): { valid: boolean; reason: string; parsed?: URL } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return { valid: false, reason: 'Invalid URL format.' };
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { valid: false, reason: 'Only public http:// or https:// URLs are permitted.' };
  }

  if (parsed.username || parsed.password) {
    return { valid: false, reason: 'Embedded URL credentials are not permitted.' };
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    !hostname ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.arpa')
  ) {
    return {
      valid: false,
      reason: `Host "${hostname}" is blocked by SSRF protection (loopback/internal hostnames disallowed).`,
    };
  }

  if (net.isIP(hostname) && isPrivateOrDisallowedIp(hostname)) {
    return {
      valid: false,
      reason: `IP address "${hostname}" is blocked by SSRF protection (private/loopback/metadata range).`,
    };
  }

  return { valid: true, reason: 'Valid public URL', parsed };
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_m, dec) => String.fromCharCode(Number(dec) || 32));
}

function stripTags(input: string): string {
  return decodeHtmlEntities(
    input
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

function extractXmlTag(block: string, tagName: string): string | null {
  const regex = new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, 'i');
  const match = block.match(regex);
  return match ? stripTags(match[1]) : null;
}

function normalizeIsoDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const ms = Date.parse(raw.trim());
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

export function parseRssOrAtomFeed(
  xmlText: string,
  feedUrl: string,
  retrievedAt: string
): { title: string; sourceKind: 'rss' | 'atom'; items: WorldSourceRecord[] } {
  const isAtom = /<feed[\s>]/i.test(xmlText) && /<entry[\s>]/i.test(xmlText);
  const channelTitle = extractXmlTag(xmlText, 'title') || new URL(feedUrl).hostname;
  const items: WorldSourceRecord[] = [];

  if (isAtom) {
    const entryMatches = xmlText.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
    for (const entry of entryMatches.slice(0, 12)) {
      const title = extractXmlTag(entry, 'title') || 'Untitled Feed Entry';
      const linkHref =
        entry.match(/<link[^>]*href=["']([^"']+)["'][^>]*>/i)?.[1] ||
        extractXmlTag(entry, 'id') ||
        feedUrl;
      const published =
        normalizeIsoDate(extractXmlTag(entry, 'published')) ||
        normalizeIsoDate(extractXmlTag(entry, 'updated'));
      const summary =
        extractXmlTag(entry, 'summary') || extractXmlTag(entry, 'content') || '';

      items.push({
        id: `world-${crypto.randomUUID()}`,
        provider: feedUrl.includes('arxiv.org') ? 'arxiv' : 'rss',
        title: title.slice(0, 220),
        url: linkHref.trim(),
        published_at: published,
        retrieved_at: retrievedAt,
        snippet: summary.slice(0, 500),
        content_type: 'application/atom+xml',
        attribution: channelTitle,
      });
    }
    return { title: channelTitle, sourceKind: 'atom', items };
  }

  const itemMatches = xmlText.match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
  for (const item of itemMatches.slice(0, 12)) {
    const title = extractXmlTag(item, 'title') || 'Untitled RSS Item';
    const link = extractXmlTag(item, 'link') || extractXmlTag(item, 'guid') || feedUrl;
    const published =
      normalizeIsoDate(extractXmlTag(item, 'pubDate')) ||
      normalizeIsoDate(extractXmlTag(item, 'dc:date')) ||
      normalizeIsoDate(extractXmlTag(item, 'published'));
    const desc = extractXmlTag(item, 'description') || extractXmlTag(item, 'content:encoded') || '';

    items.push({
      id: `world-${crypto.randomUUID()}`,
      provider: 'rss',
      title: title.slice(0, 220),
      url: link.trim(),
      published_at: published,
      retrieved_at: retrievedAt,
      snippet: desc.slice(0, 500),
      content_type: 'application/rss+xml',
      attribution: channelTitle,
    });
  }

  return { title: channelTitle, sourceKind: 'rss', items };
}

export function parseHtmlDocument(
  htmlText: string,
  pageUrl: string,
  retrievedAt: string
): { title: string; publishedAt: string | null; description: string; excerpt: string } {
  const title =
    extractXmlTag(htmlText, 'title') ||
    htmlText.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
    new URL(pageUrl).hostname;

  const metaDescription =
    htmlText.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
    htmlText.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
    '';

  const rawPublished =
    htmlText.match(/<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
    htmlText.match(/<meta[^>]+name=["'](?:date|pubdate|DC\.date\.issued)["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
    htmlText.match(/<time[^>]+datetime=["']([^"']+)["']/i)?.[1] ||
    null;

  const bodyMatch = htmlText.match(/<main[\s>][\s\S]*?<\/main>|<article[\s>][\s\S]*?<\/article>|<body[\s>][\s\S]*?<\/body>/i);
  const excerpt = stripTags(bodyMatch ? bodyMatch[0] : htmlText).slice(0, 2400);

  return {
    title: decodeHtmlEntities(title).slice(0, 220),
    publishedAt: normalizeIsoDate(rawPublished),
    description: decodeHtmlEntities(metaDescription).slice(0, 500),
    excerpt,
  };
}

async function safeFetchPublicResponse(
  rawUrl: string,
  fetcher: typeof fetch,
  options?: { bypassSsrfForTest?: boolean }
): Promise<{ response: Response; finalUrl: string; bodyText: string }> {
  let currentUrl = rawUrl.trim();
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (!options?.bypassSsrfForTest) {
      const check = validateExternalPublicUrl(currentUrl);
      if (!check.valid) {
        throw new Error(check.reason);
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Upstream retrieval timed out.')), FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetcher(currentUrl, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'User-Agent': 'ProjectGenesis-WorldIntelligence/1.0 (Local Research Connector)',
          Accept: 'application/json, application/atom+xml, application/rss+xml, text/html, text/plain;q=0.9',
        },
      });
    } finally {
      clearTimeout(timer);
    }

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) {
        throw new Error(`HTTP ${res.status} redirect without Location header.`);
      }
      currentUrl = new URL(loc, currentUrl).toString();
      continue;
    }

    if (!res.ok) {
      throw new Error(`Upstream returned HTTP ${res.status}`);
    }

    const reader = res.body?.getReader();
    if (!reader) {
      return { response: res, finalUrl: currentUrl, bodyText: await res.text() };
    }

    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > MAX_RESPONSE_BYTES) {
          await reader.cancel().catch(() => {});
          break;
        }
        chunks.push(value);
      }
    }
    const merged = new Uint8Array(total > MAX_RESPONSE_BYTES ? MAX_RESPONSE_BYTES : total);
    let offset = 0;
    for (const c of chunks) {
      const slice = offset + c.byteLength > merged.byteLength ? c.subarray(0, merged.byteLength - offset) : c;
      merged.set(slice, offset);
      offset += slice.byteLength;
    }
    const bodyText = new TextDecoder('utf-8', { fatal: false }).decode(merged);
    return { response: res, finalUrl: currentUrl, bodyText };
  }
  throw new Error('Too many HTTP redirects while retrieving public source.');
}

export class WikipediaSearchAdapter implements WorldSearchProviderAdapter {
  readonly descriptor: WorldProviderDescriptor = {
    id: 'wikipedia',
    name: 'Wikipedia Public Encyclopedia API',
    description: 'Free public MediaWiki search returning article titles, canonical URLs, timestamps, and excerpts.',
    requires_api_key: false,
    endpoint_base: 'https://en.wikipedia.org/w/api.php',
    source_category: 'encyclopedia',
  };

  private readonly fetcher: typeof fetch;
  private readonly baseUrl: string;
  private readonly bypassSsrfForTest: boolean;

  constructor(options?: { fetcher?: typeof fetch; baseUrl?: string; bypassSsrfForTest?: boolean }) {
    this.fetcher = options?.fetcher || fetch;
    this.baseUrl = options?.baseUrl || 'https://en.wikipedia.org/w/api.php';
    this.bypassSsrfForTest = Boolean(options?.bypassSsrfForTest);
  }

  async search(query: string, limit: number): Promise<WorldSearchResponse> {
    const retrievedAt = new Date().toISOString();
    const safeLimit = Math.min(10, Math.max(1, limit));
    const url = `${this.baseUrl}?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=${safeLimit}&format=json&utf8=1`;
    try {
      const { bodyText } = await safeFetchPublicResponse(url, this.fetcher, {
        bypassSsrfForTest: this.bypassSsrfForTest,
      });
      const parsed = JSON.parse(bodyText) as {
        query?: {
          search?: Array<{ title?: string; pageid?: number; snippet?: string; timestamp?: string }>;
        };
      };
      const items = parsed?.query?.search || [];
      const results: WorldSourceRecord[] = items.map((item) => {
        const title = String(item.title || 'Wikipedia Article');
        return {
          id: `world-${crypto.randomUUID()}`,
          provider: 'wikipedia',
          title,
          url: `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/\s+/g, '_'))}`,
          published_at: normalizeIsoDate(item.timestamp),
          retrieved_at: retrievedAt,
          snippet: stripTags(String(item.snippet || '')).slice(0, 420),
          content_type: 'application/json',
          attribution: 'Wikipedia (MediaWiki Public API)',
        };
      });
      return {
        ok: true,
        provider: this.descriptor.id,
        query,
        retrieved_at: retrievedAt,
        network_available: true,
        results,
      };
    } catch (err) {
      return {
        ok: false,
        provider: this.descriptor.id,
        query,
        retrieved_at: retrievedAt,
        network_available: false,
        results: [],
        error: err instanceof Error ? err.message : 'Wikipedia retrieval failed.',
      };
    }
  }
}

export class ArxivSearchAdapter implements WorldSearchProviderAdapter {
  readonly descriptor: WorldProviderDescriptor = {
    id: 'arxiv',
    name: 'arXiv Scientific Preprint API',
    description: 'Open-access scientific paper search across physics, CS, engineering, and mathematics.',
    requires_api_key: false,
    endpoint_base: 'https://export.arxiv.org/api/query',
    source_category: 'scientific_preprints',
  };

  private readonly fetcher: typeof fetch;
  private readonly baseUrl: string;
  private readonly bypassSsrfForTest: boolean;

  constructor(options?: { fetcher?: typeof fetch; baseUrl?: string; bypassSsrfForTest?: boolean }) {
    this.fetcher = options?.fetcher || fetch;
    this.baseUrl = options?.baseUrl || 'https://export.arxiv.org/api/query';
    this.bypassSsrfForTest = Boolean(options?.bypassSsrfForTest);
  }

  async search(query: string, limit: number): Promise<WorldSearchResponse> {
    const retrievedAt = new Date().toISOString();
    const safeLimit = Math.min(10, Math.max(1, limit));
    const url = `${this.baseUrl}?search_query=all:${encodeURIComponent(query)}&start=0&max_results=${safeLimit}`;
    try {
      const { bodyText } = await safeFetchPublicResponse(url, this.fetcher, {
        bypassSsrfForTest: this.bypassSsrfForTest,
      });
      const parsed = parseRssOrAtomFeed(bodyText, 'https://export.arxiv.org/api/query', retrievedAt);
      const results = parsed.items.map((item) => ({
        ...item,
        provider: 'arxiv' as const,
        attribution: 'arXiv.org Open Access Archive',
      }));
      return {
        ok: true,
        provider: this.descriptor.id,
        query,
        retrieved_at: retrievedAt,
        network_available: true,
        results,
      };
    } catch (err) {
      return {
        ok: false,
        provider: this.descriptor.id,
        query,
        retrieved_at: retrievedAt,
        network_available: false,
        results: [],
        error: err instanceof Error ? err.message : 'arXiv retrieval failed.',
      };
    }
  }
}

export async function fetchPublicUrlOrFeed(
  rawUrl: string,
  options?: { fetcher?: typeof fetch; bypassSsrfForTest?: boolean }
): Promise<WorldUrlFetchResponse> {
  const retrievedAt = new Date().toISOString();
  if (!options?.bypassSsrfForTest) {
    const check = validateExternalPublicUrl(rawUrl);
    if (!check.valid) {
      return {
        ok: false,
        url: rawUrl,
        final_url: rawUrl,
        source_kind: 'html',
        retrieved_at: retrievedAt,
        network_available: false,
        title: '',
        published_at: null,
        items: [],
        text_excerpt: '',
        error: check.reason,
      };
    }
  }

  try {
    const fetcher = options?.fetcher || fetch;
    const { response, finalUrl, bodyText } = await safeFetchPublicResponse(rawUrl, fetcher, {
      bypassSsrfForTest: options?.bypassSsrfForTest,
    });
    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    const looksXmlFeed =
      contentType.includes('xml') ||
      contentType.includes('rss') ||
      contentType.includes('atom') ||
      /<rss[\s>]|<feed[\s>]/i.test(bodyText.slice(0, 600));

    if (looksXmlFeed) {
      const feed = parseRssOrAtomFeed(bodyText, finalUrl, retrievedAt);
      return {
        ok: true,
        url: rawUrl,
        final_url: finalUrl,
        source_kind: feed.sourceKind,
        retrieved_at: retrievedAt,
        network_available: true,
        title: feed.title,
        published_at: feed.items[0]?.published_at || null,
        items: feed.items,
        text_excerpt: feed.items.map((i) => `${i.title}: ${i.snippet}`).join('\n').slice(0, 1800),
      };
    }

    if (contentType.includes('text/plain')) {
      const excerpt = bodyText.trim().slice(0, 2400);
      return {
        ok: true,
        url: rawUrl,
        final_url: finalUrl,
        source_kind: 'text',
        retrieved_at: retrievedAt,
        network_available: true,
        title: new URL(finalUrl).hostname,
        published_at: null,
        items: [
          {
            id: `world-${crypto.randomUUID()}`,
            provider: 'webpage',
            title: new URL(finalUrl).hostname,
            url: finalUrl,
            published_at: null,
            retrieved_at: retrievedAt,
            snippet: excerpt.slice(0, 420),
            content_type: contentType || 'text/plain',
            attribution: new URL(finalUrl).hostname,
          },
        ],
        text_excerpt: excerpt,
      };
    }

    const html = parseHtmlDocument(bodyText, finalUrl, retrievedAt);
    return {
      ok: true,
      url: rawUrl,
      final_url: finalUrl,
      source_kind: 'html',
      retrieved_at: retrievedAt,
      network_available: true,
      title: html.title,
      published_at: html.publishedAt,
      items: [
        {
          id: `world-${crypto.randomUUID()}`,
          provider: 'webpage',
          title: html.title,
          url: finalUrl,
          published_at: html.publishedAt,
          retrieved_at: retrievedAt,
          snippet: html.description || html.excerpt.slice(0, 420),
          content_type: contentType || 'text/html',
          attribution: new URL(finalUrl).hostname,
        },
      ],
      text_excerpt: html.excerpt,
    };
  } catch (err) {
    return {
      ok: false,
      url: rawUrl,
      final_url: rawUrl,
      source_kind: 'html',
      retrieved_at: retrievedAt,
      network_available: false,
      title: '',
      published_at: null,
      items: [],
      text_excerpt: '',
      error: err instanceof Error ? err.message : 'Failed to retrieve public URL.',
    };
  }
}

export const WORLD_INTELLIGENCE_PROVIDERS: WorldProviderDescriptor[] = [
  new WikipediaSearchAdapter().descriptor,
  new ArxivSearchAdapter().descriptor,
];

export function resolveWorldSearchProvider(providerId: string): WorldSearchProviderAdapter | null {
  if (providerId === 'wikipedia') return new WikipediaSearchAdapter();
  if (providerId === 'arxiv') return new ArxivSearchAdapter();
  return null;
}
