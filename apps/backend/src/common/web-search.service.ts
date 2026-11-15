import { Injectable, Logger } from '@nestjs/common';

export interface WebSearchResult {
  title: string;
  snippet: string;
  source: string;
  url?: string;
}

@Injectable()
export class WebSearchService {
  private readonly logger = new Logger(WebSearchService.name);

  async search(query: string, optionsList?: { id: string; text: string }[]): Promise<string[]> {
    if (!query || query.trim().length === 0) return [];

    const snippets: string[] = [];
    const cleanQuery = this.cleanQuery(query);

    this.logger.log(`Searching web for question: "${cleanQuery.slice(0, 70)}..."`);

    // 1. Check if user configured a Tavily / Serper API key in env or database
    const tavilyKey = process.env.TAVILY_API_KEY;
    const serperKey = process.env.SERPER_API_KEY;

    if (tavilyKey) {
      try {
        const res = await fetch('https://api.tavily.com/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ api_key: tavilyKey, query: cleanQuery, max_results: 3 }),
          signal: AbortSignal.timeout(4000),
        });
        if (res.ok) {
          const data = await res.json();
          if (data.results) {
            for (const r of data.results) {
              snippets.push(`[Web Search: ${r.title}] ${r.content}`);
            }
          }
        }
      } catch (e: any) {
        this.logger.warn(`Tavily search error: ${e.message}`);
      }
    } else if (serperKey) {
      try {
        const res = await fetch('https://google.serper.dev/search', {
          method: 'POST',
          headers: { 'X-API-KEY': serperKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ q: cleanQuery, num: 3 }),
          signal: AbortSignal.timeout(4000),
        });
        if (res.ok) {
          const data = await res.json();
          if (data.organic) {
            for (const r of data.organic.slice(0, 3)) {
              snippets.push(`[Google: ${r.title}] ${r.snippet}`);
            }
          }
        }
      } catch (e: any) {
        this.logger.warn(`Serper search error: ${e.message}`);
      }
    }

    // 2. Free DuckDuckGo Instant Answer API (No API key needed)
    try {
      const ddgRes = await fetch(
        `https://api.duckduckgo.com/?q=${encodeURIComponent(cleanQuery)}&format=json`,
        { signal: AbortSignal.timeout(3000) },
      );
      if (ddgRes.ok) {
        const ddgData = await ddgRes.json();
        if (ddgData.AbstractText && ddgData.AbstractText.length > 20) {
          snippets.push(`[DuckDuckGo: ${ddgData.Heading || 'Summary'}] ${ddgData.AbstractText}`);
        }
        if (ddgData.RelatedTopics && Array.isArray(ddgData.RelatedTopics)) {
          for (const item of ddgData.RelatedTopics.slice(0, 2)) {
            if (item.Text) {
              snippets.push(`[DuckDuckGo Topic] ${item.Text}`);
            }
          }
        }
      }
    } catch (e: any) {
      // ignore
    }

    // 3. Free Wikipedia Search API (Definitions, CS concepts, protocols, formulas)
    try {
      const wikiQuery = cleanQuery.split(' ').slice(0, 8).join(' ');
      const wikiRes = await fetch(
        `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(wikiQuery)}&utf8=&format=json`,
        {
          headers: {
            'User-Agent': 'AIMCQAssistant/1.0 (educational-tutor@local.dev)',
          },
          signal: AbortSignal.timeout(3500),
        },
      );
      if (wikiRes.ok) {
        const wikiData = await wikiRes.json();
        if (wikiData.query?.search && Array.isArray(wikiData.query.search)) {
          for (const item of wikiData.query.search.slice(0, 2)) {
            const cleanSnippet = item.snippet
              .replace(/<[^>]+>/g, '')
              .replace(/&quot;/g, '"')
              .replace(/&#39;/g, "'")
              .replace(/&amp;/g, '&')
              .trim();
            if (cleanSnippet.length > 30) {
              snippets.push(`[Wikipedia: ${item.title}] ${cleanSnippet}`);
            }
          }
        }
      }
    } catch (e: any) {
      // ignore
    }

    // 4. Free StackExchange API for programming & technical queries
    const isTech =
      query.toLowerCase().includes('node') ||
      query.toLowerCase().includes('python') ||
      query.toLowerCase().includes('sql') ||
      query.toLowerCase().includes('function') ||
      query.toLowerCase().includes('react') ||
      query.toLowerCase().includes('stream') ||
      query.toLowerCase().includes('array') ||
      query.toLowerCase().includes('class');

    if (isTech && snippets.length < 3) {
      try {
        const soQuery = cleanQuery.split(' ').slice(0, 7).join(' ');
        const soRes = await fetch(
          `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=${encodeURIComponent(soQuery)}&site=stackoverflow&filter=withbody`,
          {
            headers: { 'User-Agent': 'AIMCQAssistant/1.0' },
            signal: AbortSignal.timeout(3500),
          },
        );
        if (soRes.ok) {
          const soData = await soRes.json();
          if (soData.items && Array.isArray(soData.items)) {
            for (const item of soData.items.slice(0, 2)) {
              const bodySnippet = (item.body || '')
                .replace(/<[^>]+>/g, ' ')
                .replace(/\s+/g, ' ')
                .slice(0, 250)
                .trim();
              if (bodySnippet.length > 40) {
                snippets.push(`[StackOverflow: ${item.title}] ${bodySnippet}`);
              }
            }
          }
        }
      } catch (e: any) {
        // ignore
      }
    }

    this.logger.log(`Retrieved ${snippets.length} web search snippets for question.`);
    return snippets;
  }

  private cleanQuery(text: string): string {
    return text
      .replace(/[^\w\s\-\.\,\?]/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .split(' ')
      .slice(0, 16)
      .join(' ');
  }
}

