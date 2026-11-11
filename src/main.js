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
        && proxyConfiguration.apifyProxyGroups.some((g) => /GOOGLE_?SERP/i.test(String(g)));

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
    const resolvedSerpProxy = isGoogleSerpProxy
        || (Array.isArray(proxyConfig?.groups) && proxyConfig.groups.some((g) => /GOOGLE_?SERP/i.test(String(g))));

    if (proxyConfig) {
        log.info('Configured Apify Proxy successfully', {
            groups: proxyConfig.groups || [],
            countryCode: proxyConfig.countryCode || null,
            isManInTheMiddle: Boolean(proxyConfig.isManInTheMiddle),
            isGoogleSerpProxy: resolvedSerpProxy,
        });
    }

    function formatDiagnostics(diag) {
        if (!diag) return '';
        const parts = [`status=${diag.statusCode}`, `len=${diag.htmlLength}`];
        if (diag.location) parts.push(`location=${diag.location}`);
        if (diag.title) parts.push(`title="${diag.title.slice(0, 80)}"`);
        return ` [${parts.join(', ')}]`;
    }

    async function fetchHtml(url) {
        const proxyUrl = proxyConfig ? await proxyConfig.newUrl() : undefined;
        const proxyIsSerp = resolvedSerpProxy || /GOOGLE_?SERP/i.test(proxyUrl || '');
        // Apify GOOGLE_SERP proxy strictly requires plain http://www.google.com/search?...
        const requestUrl = proxyIsSerp ? url.replace(/^https:\/\//i, 'http://') : url;

        const response = await gotScraping({
            url: requestUrl,
            headers: {
                'accept-language': acceptLanguage,
                'accept-encoding': 'gzip, deflate, br',
                'sec-fetch-site': 'none',
            },
            headerGeneratorOptions: {
                browsers: [{ name: 'chrome' }],
                operatingSystems: ['windows', 'linux'],
            },
            sessionToken: {},
            proxyUrl,
            http2: !proxyIsSerp,
            followRedirect: !proxyIsSerp,
            timeout: { request: 30000 },
            retry: { limit: 1 },
            throwHttpErrors: false,
        });

        const blockCheck = detectGoogleBlock(
            response.body,
            response.url || requestUrl,
            response.statusCode,
            response.headers,
        );
        if (blockCheck.blocked) {
            const err = new Error(`${blockCheck.message}${formatDiagnostics(blockCheck.diagnostics)}`);
            err.reason = blockCheck.reason;
            err.diagnostics = blockCheck.diagnostics;
            err.isSerpProxy = proxyIsSerp;
            throw err;
        }

        return response.body;
    }

    async function safePageContent(page) {
        for (let i = 0; i < 3; i++) {
            try {
                return await page.content();
            } catch (err) {
                if (i === 2) throw err;
                await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
                await page.waitForTimeout(500);
            }
        }
        return '';
    }

    async function fetchWithPlaywright(url, attemptProxyUrl = undefined) {
        // Inside Apify's xvfb-run container, DISPLAY is set so Chromium can run non-headless (avoiding HeadlessChrome UA)
        const hasXvfbDisplay = process.platform === 'linux' && Boolean(process.env.DISPLAY);
        const launchOptions = {
            headless: !hasXvfbDisplay,
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
                '--ignore-certificate-errors',
                '--ignore-certificate-errors-spki-list',
                '--disable-blink-features=AutomationControlled',
            ],
        };
        if (attemptProxyUrl) {
            launchOptions.proxy = parsePlaywrightProxy(attemptProxyUrl);
        }

        const browser = await chromium.launch(launchOptions);
        try {
            const browserVersion = browser.version() || '147.0.0.0';
            const cleanUserAgent = `Mozilla/5.0 (${process.platform === 'linux' ? 'X11; Linux x86_64' : 'Windows NT 10.0; Win64; x64'}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browserVersion} Safari/537.36`;

            const context = await browser.newContext({
                ignoreHTTPSErrors: true,
                userAgent: cleanUserAgent,
                locale: playwrightLocale,
                viewport: { width: 1366, height: 768 },
                extraHTTPHeaders: {
                    'Accept-Language': acceptLanguage,
                },
            });

            await context.addInitScript((langList) => {
                Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
                Object.defineProperty(navigator, 'languages', { get: () => langList });
            }, [playwrightLocale, cleanLanguage, 'en']);

            const page = await context.newPage();

            await page.route('**/*', (route) => {
                const type = route.request().resourceType();
                if (['image', 'media', 'font'].includes(type)) {
                    return route.abort();
                }
                return route.continue();
            });

            const navResponse = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });

            // Wait briefly if Google SearchGuard /enablejs triggers a client-side JS redirect
            if (page.url().includes('/enablejs')) {
                await page.waitForURL((u) => !u.href.includes('/enablejs'), { timeout: 10000 }).catch(() => {});
            }

            // Dismiss Google EU consent popup if present
            try {
                const acceptBtn = page.locator('#L2AGLb, button:has-text("Accept all"), button:has-text("Tout accepter"), button:has-text("I agree"), form[action*="consent"] button[type="submit"]');
                if (await acceptBtn.first().isVisible({ timeout: 2500 })) {
                    await acceptBtn.first().click();
                    await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
                }
            } catch {}

            await page.waitForSelector('div#rso h3, div#search h3, div.Gx5Zad, form#captcha-form', { timeout: 15000 }).catch(() => {});
            await page.waitForTimeout(1000);

            const html = await safePageContent(page);
            const finalUrl = page.url();
            const navStatus = navResponse ? navResponse.status() : 200;
            const blockCheck = detectGoogleBlock(html, finalUrl, navStatus, {});
            if (blockCheck.blocked) {
                const diagSuffix = formatDiagnostics(blockCheck.diagnostics);
                const err = new Error(
                    blockCheck.reason === 'CAPTCHA'
                        ? `Google blocked this IP with a /sorry/ CAPTCHA${diagSuffix}. Try Apify Proxy group "RESIDENTIAL" or "UNBLOCKER" (or "GOOGLE_SERP").`
                        : `${blockCheck.message}${diagSuffix}`
                );
                err.reason = blockCheck.reason;
                err.diagnostics = blockCheck.diagnostics;
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
            let searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&gl=${encodeURIComponent(cleanCountry)}&hl=${encodeURIComponent(cleanLanguage)}`;
            if (resultsPerPage > 10) {
                searchUrl += `&num=${resultsPerPage}`;
            }
            searchUrl += `&start=${start}`;
            if (cleanTimeFilter && cleanTimeFilter !== 'all') {
                searchUrl += `&tbs=${encodeURIComponent(cleanTimeFilter)}`;
            }

            log.info(`📜 Scraping SERP page ${pageNumber} (start=${start}) for query: "${query}"...`);

            try {
                let html = '';

                if (resolvedSerpProxy) {
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
                        if (httpErr.isSerpProxy) throw httpErr;
                        log.warning(`⚠️ Fast HTTP blocked/challenged (${httpErr.message}). Trying Playwright browser fallback...`);
                        const maxPwAttempts = proxyConfig ? 2 : 1;
                        let lastPwErr = null;
                        for (let pwAttempt = 1; pwAttempt <= maxPwAttempts; pwAttempt++) {
                            const pwProxyUrl = proxyConfig ? await proxyConfig.newUrl() : undefined;
                            try {
                                html = await fetchWithPlaywright(searchUrl, pwProxyUrl);
                                break;
                            } catch (pwErr) {
                                lastPwErr = pwErr;
                                if (pwAttempt < maxPwAttempts) {
                                    log.warning(`⚠️ Playwright attempt ${pwAttempt}/${maxPwAttempts} failed (${pwErr.message}). Retrying with a fresh proxy IP...`);
                                    await new Promise((r) => setTimeout(r, 1200));
                                }
                            }
                        }
                        if (!html && lastPwErr) throw lastPwErr;
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
                    const pageTitle = html.match(/<title>([^<]*)<\/title>/i)?.[1] || '';
                    const h3Count = (html.match(/<h3[\s>]/gi) || []).length;
                    log.info(`ℹ️ No more organic results found for "${query}" at start=${start}.`, {
                        htmlLength: html.length,
                        pageTitle,
                        h3Count,
                    });
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

                const pageStep = (resultsPerPage > 10 && organicList.length >= 15) ? resultsPerPage : 10;
                start += pageStep;
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
            ? 'Requests were challenged/blocked by Google Search. Use Apify Proxy group "GOOGLE_SERP", "RESIDENTIAL", or "UNBLOCKER" in proxyConfiguration.'
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
