import { Actor } from 'apify';
import { gotScraping } from 'got-scraping';
import { log } from 'crawlee';
import { chromium } from 'playwright';
import {
    cleanCode,
    normalizeLocale,
    parsePlaywrightProxy,
    detectGoogleBlock,
    parseOrganicResults,
    parsePeopleAlsoAsk,
    parseFeaturedSnippet,
    parseRelatedSearches,
} from './extractors.js';

await Actor.init();

let hasFailed = false;

try {
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
        proxyConfiguration,
    } = input;

    const cleanCountry = cleanCode(countryCode, 'us').toLowerCase();
    const cleanLanguage = cleanCode(languageCode, 'en').toLowerCase();
    const cleanTimeFilter = cleanCode(timeFilter, 'all');
    const playwrightLocale = normalizeLocale(cleanLanguage, cleanCountry);
    const acceptLanguage = `${cleanLanguage}-${cleanCountry.toUpperCase()},${cleanLanguage};q=0.9,en;q=0.8`;

    const isGoogleSerpProxy = Array.isArray(proxyConfiguration?.apifyProxyGroups)
        && proxyConfiguration.apifyProxyGroups.includes('GOOGLE_SERP');

    const safeQueries = Array.isArray(queries) ? queries : [queries];

    log.info('🚀 Starting Google Search Ultimate Scraper...', {
        queriesCount: safeQueries.length,
        countryCode: cleanCountry,
        languageCode: cleanLanguage,
        maxResults,
        resultsPerPage,
        timeFilter: cleanTimeFilter,
        isGoogleSerpProxy,
    });

    const proxyConfig = proxyConfiguration ? await Actor.createProxyConfiguration(proxyConfiguration) : undefined;
    if (proxyConfig) {
        log.info('Configured Apify Proxy successfully');
    }

    async function fetchHtml(url) {
        const proxyUrl = proxyConfig ? await proxyConfig.newUrl() : undefined;
        const response = await gotScraping({
            url,
            headers: {
                'accept-language': acceptLanguage,
            },
            headerGeneratorOptions: {
                browsers: [{ name: 'chrome' }],
                operatingSystems: ['windows', 'linux'],
            },
            sessionToken: {},
            proxyUrl,
            timeout: { request: 30000 },
            retry: { limit: 1 },
            throwHttpErrors: false,
        });

        const blockCheck = detectGoogleBlock(response.body, response.url, response.statusCode);
        if (blockCheck.blocked) {
            const err = new Error(blockCheck.message);
            err.reason = blockCheck.reason;
            throw err;
        }

        return response.body;
    }

    async function fetchWithPlaywright(url, attemptProxyUrl = undefined) {
        const launchOptions = {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-webgl',
                '--disable-3d-apis',
                '--disable-software-rasterizer',
                '--disable-extensions',
                '--no-first-run',
                '--mute-audio',
                '--disable-blink-features=AutomationControlled',
            ],
        };
        if (attemptProxyUrl) {
            launchOptions.proxy = parsePlaywrightProxy(attemptProxyUrl);
        }

        const browser = await chromium.launch(launchOptions);
        try {
            const context = await browser.newContext({
                locale: playwrightLocale,
                viewport: { width: 1366, height: 768 },
                extraHTTPHeaders: {
                    'Accept-Language': acceptLanguage,
                },
            });
            const page = await context.newPage();

            await page.route('**/*', (route) => {
                const type = route.request().resourceType();
                if (['image', 'media', 'font'].includes(type)) {
                    return route.abort();
                }
                return route.continue();
            });

            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });

            // Dismiss Google EU consent popup if present
            try {
                const acceptBtn = page.locator('#L2AGLb, button:has-text("Accept all"), button:has-text("Tout accepter"), button:has-text("I agree"), form[action*="consent"] button[type="submit"]');
                if (await acceptBtn.first().isVisible({ timeout: 2500 })) {
                    await acceptBtn.first().click();
                    await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
                }
            } catch {}

            await page.waitForSelector('div#rso h3, div#search h3, div.Gx5Zad, form#captcha-form', { timeout: 12000 }).catch(() => {});
            await page.waitForTimeout(1200);

            const html = await page.content();
            const finalUrl = page.url();
            const blockCheck = detectGoogleBlock(html, finalUrl, 200);
            if (blockCheck.blocked) {
                const err = new Error(
                    blockCheck.reason === 'CAPTCHA'
                        ? 'Google blocked this IP with a /sorry/ CAPTCHA. In Apify Console, set Proxy Configuration to Apify Proxy group "GOOGLE_SERP" or "RESIDENTIAL" (default Datacenter IPs are commonly challenged by Google Search).'
                        : blockCheck.message
                );
                err.reason = blockCheck.reason;
                throw err;
            }

            return html;
        } finally {
            await browser.close().catch(() => {});
        }
    }

    const stats = {
        totalQueries: safeQueries.length,
        organicResults: 0,
        featuredSnippets: 0,
        paaQuestions: 0,
        relatedSearches: 0,
        failed: 0,
    };

    for (const rawQuery of safeQueries) {
        const query = String(rawQuery || '').trim();
        if (!query) continue;

        log.info(`🔍 Searching Google for: "${query}" (gl: ${cleanCountry}, hl: ${cleanLanguage})...`);

        let start = 0;
        let pageNumber = 1;
        let collectedForQuery = 0;
        let hasMore = true;

        while (collectedForQuery < maxResults && hasMore) {
            let searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&gl=${encodeURIComponent(cleanCountry)}&hl=${encodeURIComponent(cleanLanguage)}&num=${resultsPerPage}&start=${start}`;
            if (cleanTimeFilter && cleanTimeFilter !== 'all') {
                searchUrl += `&tbs=${encodeURIComponent(cleanTimeFilter)}`;
            }

            log.info(`📜 Scraping SERP page ${pageNumber} (start=${start}) for query: "${query}"...`);

            try {
                let html = '';

                if (isGoogleSerpProxy) {
                    // GOOGLE_SERP proxy must execute directly over HTTP without Playwright subresources
                    let lastErr = null;
                    for (let attempt = 1; attempt <= 3; attempt++) {
                        try {
                            html = await fetchHtml(searchUrl);
                            break;
                        } catch (err) {
                            lastErr = err;
                            log.warning(`⚠️ GOOGLE_SERP HTTP attempt ${attempt}/3 failed: ${err.message}`);
                            if (attempt < 3) await new Promise((r) => setTimeout(r, 1000 * attempt));
                        }
                    }
                    if (!html && lastErr) throw lastErr;
                } else {
                    try {
                        html = await fetchHtml(searchUrl);
                    } catch (httpErr) {
                        log.warning(`⚠️ Fast HTTP blocked/challenged (${httpErr.message}). Trying Playwright browser fallback...`);
                        const pwProxyUrl = proxyConfig ? await proxyConfig.newUrl() : undefined;
                        html = await fetchWithPlaywright(searchUrl, pwProxyUrl);
                    }
                }

                // 1. Featured Snippet (First page only)
                if (pageNumber === 1) {
                    const snippet = parseFeaturedSnippet(html, query);
                    if (snippet) {
                        snippet.countryCode = cleanCountry;
                        snippet.languageCode = cleanLanguage;
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
                    item.countryCode = cleanCountry;
                    item.languageCode = cleanLanguage;
                    await Actor.pushData(item);
                    collectedForQuery++;
                    stats.organicResults++;
                    log.info(`✅ [Pos #${item.position}] ${item.title.slice(0, 50)}... (${item.domain})`);
                }

                // 3. People Also Ask (PAA)
                if (extractPaa && pageNumber === 1) {
                    const paaList = parsePeopleAlsoAsk(html, query);
                    for (const p of paaList) {
                        p.countryCode = cleanCountry;
                        p.languageCode = cleanLanguage;
                        await Actor.pushData(p);
                    }
                    stats.paaQuestions += paaList.length;
                    if (paaList.length > 0) {
                        log.info(`❓ Extracted ${paaList.length} "People Also Ask" questions for "${query}".`);
                    }
                }

                // 4. Related Searches
                if (extractRelated) {
                    const relatedList = parseRelatedSearches(html, query);
                    for (const r of relatedList) {
                        r.countryCode = cleanCountry;
                        r.languageCode = cleanLanguage;
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
                } else {
                    await new Promise((r) => setTimeout(r, 1200));
                }
            } catch (err) {
                log.error(`❌ Error scraping query "${query}": ${err.message}`);
                stats.failed++;
                break;
            }
        }

        log.info(`🏁 Completed query "${query}". Total organic extracted: ${collectedForQuery}`);
    }

    const summary = {
        status: stats.failed === stats.totalQueries && stats.organicResults === 0 ? 'BLOCKED_BY_CAPTCHA' : 'COMPLETED',
        timestamp: new Date().toISOString(),
        metrics: {
            totalQueries: stats.totalQueries,
            totalOrganicResults: stats.organicResults,
            totalFeaturedSnippets: stats.featuredSnippets,
            totalPaaQuestions: stats.paaQuestions,
            totalRelatedSearches: stats.relatedSearches,
            totalRecordsExtracted: stats.organicResults + stats.featuredSnippets + stats.paaQuestions + stats.relatedSearches,
            failedQueries: stats.failed,
        },
        message: stats.failed > 0 && stats.organicResults === 0
            ? 'Requests were challenged/blocked by Google Search. Use Apify Proxy group "GOOGLE_SERP" or "RESIDENTIAL" in proxyConfiguration.'
            : 'Google Search Ultimate Scraper completed successfully.',
    };

    await Actor.setValue('OUTPUT', summary);
    log.info('🏁 Execution Finished. Executive Summary:', summary);
} catch (err) {
    hasFailed = true;
    log.error(`Fatal execution error: ${err.message}`, { stack: err.stack });
    await Actor.setValue('OUTPUT', { status: 'FAILED', error: err.message }).catch(() => {});
    await Actor.fail(err.message);
} finally {
    if (!hasFailed) {
        await Actor.exit();
    }
}
