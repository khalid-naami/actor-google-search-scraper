import { Actor } from 'apify';
import { gotScraping } from 'got-scraping';
import { PlaywrightCrawler, log } from 'crawlee';
import {
    parseOrganicResults,
    parsePeopleAlsoAsk,
    parseFeaturedSnippet,
    parseRelatedSearches
} from './extractors.js';

await Actor.init();

const input = (await Actor.getInput()) || {};
const {
    queries = ['artificial intelligence agents'],
    countryCode = 'us',
    languageCode = 'en',
    maxResults = 50,
    resultsPerPage = 50,
    extractPaa = true,
    extractRelated = true,
    timeFilter = 'all',
    proxyConfiguration
} = input;

log.info('🚀 Starting Google Search Ultimate Scraper...', {
    queriesCount: queries.length,
    countryCode,
    languageCode,
    maxResults,
    resultsPerPage,
    timeFilter
});

const proxyConfig = proxyConfiguration ? await Actor.createProxyConfiguration(proxyConfiguration) : undefined;

function buildHeaders() {
    return {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': `${languageCode}-${countryCode.toUpperCase()},${languageCode};q=0.9,en;q=0.8`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        'Sec-Ch-Ua': '"Chromium";v="128", "Not;A=Brand";v="24", "Google Chrome";v="128"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Upgrade-Insecure-Requests': '1'
    };
}

// Fast HTML fetcher with proxy
async function fetchHtml(url) {
    const proxyUrl = proxyConfig ? await proxyConfig.newUrl() : undefined;
    const response = await gotScraping({
        url,
        headers: buildHeaders(),
        proxyUrl,
        timeout: { request: 30000 },
        retry: { limit: 2 }
    });
    return response.body;
}

// Playwright crawler fallback for interactive/consent pages
async function fetchWithPlaywright(url) {
    let content = '';
    const crawler = new PlaywrightCrawler({
        proxyConfiguration: proxyConfig,
        maxRequestsPerCrawl: 1,
        headless: true,
        requestHandlerTimeoutSecs: 40,
        async requestHandler({ page }) {
            // Dismiss Google consent popup if present
            try {
                const acceptBtn = page.locator('button:has-text("Accept all"), button:has-text("Tout accepter"), button:has-text("I agree"), form[action*="consent"] button');
                if (await acceptBtn.isVisible({ timeout: 2500 })) {
                    await acceptBtn.first().click();
                    await page.waitForTimeout(1000);
                }
            } catch (_) {}

            content = await page.content();
        }
    });
    await crawler.run([url]);
    return content;
}

const stats = {
    totalQueries: queries.length,
    organicResults: 0,
    featuredSnippets: 0,
    paaQuestions: 0,
    relatedSearches: 0,
    failed: 0
};

// Process each search query
for (const rawQuery of queries) {
    const query = String(rawQuery).trim();
    if (!query) continue;

    log.info(`🔍 Searching Google for: "${query}" (gl: ${countryCode}, hl: ${languageCode})...`);

    let start = 0;
    let pageNumber = 1;
    let collectedForQuery = 0;
    let hasMore = true;

    while (collectedForQuery < maxResults && hasMore) {
        let searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&gl=${countryCode}&hl=${languageCode}&num=${resultsPerPage}&start=${start}`;
        if (timeFilter && timeFilter !== 'all') {
            searchUrl += `&tbs=${timeFilter}`;
        }

        log.info(`📜 Scraping SERP page ${pageNumber} (start=${start}) for query: "${query}"...`);

        try {
            let html = '';
            try {
                html = await fetchHtml(searchUrl);
            } catch (err) {
                log.warning(`⚠️ Fast HTTP failed (${err.message}). Trying browser crawler fallback...`);
                html = await fetchWithPlaywright(searchUrl);
            }

            // 1. Featured Snippet (First page only)
            if (pageNumber === 1) {
                const snippet = parseFeaturedSnippet(html, query);
                if (snippet) {
                    snippet.countryCode = countryCode;
                    snippet.languageCode = languageCode;
                    await Actor.pushData(snippet);
                    stats.featuredSnippets++;
                    log.info(`⭐ Extracted Featured Snippet for query: "${query}"`);
                }
            }

            // 2. Organic Results
            const organicList = parseOrganicResults(html, query, collectedForQuery + 1, pageNumber);
            if (!organicList || organicList.length === 0) {
                log.info(`ℹ️ No more organic results found for "${query}" at start=${start}.`);
                hasMore = false;
                break;
            }

            for (const item of organicList) {
                if (collectedForQuery >= maxResults) {
                    hasMore = false;
                    break;
                }
                item.countryCode = countryCode;
                item.languageCode = languageCode;
                await Actor.pushData(item);
                collectedForQuery++;
                stats.organicResults++;
                log.info(`✅ [Pos #${item.position}] ${item.title.slice(0, 50)}... (${item.domain})`);
            }

            // 3. People Also Ask (PAA)
            if (extractPaa && pageNumber === 1) {
                const paaList = parsePeopleAlsoAsk(html, query);
                for (const p of paaList) {
                    p.countryCode = countryCode;
                    p.languageCode = languageCode;
                    await Actor.pushData(p);
                }
                stats.paaQuestions += paaList.length;
                if (paaList.length > 0) {
                    log.info(`❓ Extracted ${paaList.length} "People Also Ask" questions for "${query}".`);
                }
            }

            // 4. Related Searches (Last page or page 1)
            if (extractRelated) {
                const relatedList = parseRelatedSearches(html, query);
                for (const r of relatedList) {
                    r.countryCode = countryCode;
                    r.languageCode = languageCode;
                    await Actor.pushData(r);
                }
                stats.relatedSearches += relatedList.length;
                if (relatedList.length > 0) {
                    log.info(`🔗 Extracted ${relatedList.length} Related Searches suggestions.`);
                }
            }

            start += resultsPerPage;
            pageNumber++;

            if (organicList.length < 5) {
                hasMore = false;
            }

        } catch (err) {
            log.error(`❌ Error scraping query "${query}": ${err.message}`);
            stats.failed++;
            break;
        }
    }

    log.info(`🏁 Completed query "${query}". Total organic extracted: ${collectedForQuery}`);
}

// Generate execution overview summary
const summary = {
    status: 'COMPLETED',
    timestamp: new Date().toISOString(),
    metrics: {
        totalQueries: stats.totalQueries,
        totalOrganicResults: stats.organicResults,
        totalFeaturedSnippets: stats.featuredSnippets,
        totalPaaQuestions: stats.paaQuestions,
        totalRelatedSearches: stats.relatedSearches,
        totalRecordsExtracted: stats.organicResults + stats.featuredSnippets + stats.paaQuestions + stats.relatedSearches,
        failedQueries: stats.failed
    },
    message: 'Google Search Ultimate Scraper completed successfully.'
};

await Actor.setValue('OUTPUT', summary);
log.info('🏁 Execution Finished. Executive Summary:', summary);

await Actor.exit();
