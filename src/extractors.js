import { load } from 'cheerio';

/**
 * Google Search Ultimate Scraper - Extractors & Parsers
 * Cheerio DOM extraction for Organic SERP Results, Featured Snippets, PAA, and Related Searches.
 */

const DEFAULT_REGION_BY_LANG = {
    en: 'US',
    ar: 'SA',
    fr: 'FR',
    de: 'DE',
    es: 'ES',
    it: 'IT',
    nl: 'NL',
    pt: 'BR',
    ja: 'JP',
    hi: 'IN',
    tr: 'TR',
    zh: 'CN',
    ko: 'KR',
    ru: 'RU',
};

/**
 * Clean user input strings (strip whitespace and accidental surrounding quotes)
 */
export function cleanCode(raw, fallback = '') {
    if (!raw || typeof raw !== 'string') return fallback;
    const cleaned = raw.trim().replace(/^['"`]+|['"`]+$/g, '').trim();
    return cleaned || fallback;
}

/**
 * Build valid BCP-47 Chromium locale (e.g. "en-US") from hl/gl
 */
export function normalizeLocale(languageCode = 'en', countryCode = 'us') {
    const rawLang = cleanCode(languageCode, 'en').replace('_', '-');
    const rawCountry = cleanCode(countryCode, 'us').toUpperCase();

    if (/^[a-z]{2}-[A-Z]{2}$/.test(rawLang)) {
        return rawLang;
    }

    const lang = rawLang.split('-')[0].toLowerCase();
    if (!/^[a-z]{2}$/.test(lang)) return 'en-US';

    const region = /^[A-Z]{2}$/.test(rawCountry)
        ? rawCountry
        : (DEFAULT_REGION_BY_LANG[lang] || 'US');

    return `${lang}-${region}`;
}

/**
 * Parse Playwright proxy configuration into { server, username, password }
 */
export function parsePlaywrightProxy(proxyUrl) {
    if (!proxyUrl) return undefined;
    try {
        const u = new URL(proxyUrl);
        const proxy = {
            server: `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ''}`,
        };
        if (u.username) proxy.username = decodeURIComponent(u.username);
        if (u.password) proxy.password = decodeURIComponent(u.password);
        return proxy;
    } catch {
        return { server: proxyUrl };
    }
}

/**
 * Detect Google HTTP blocks, SearchGuard JS challenge, EU consent redirect, or /sorry/ CAPTCHA
 */
export function detectGoogleBlock(html = '', finalUrl = '', statusCode = 200) {
    if (statusCode === 429 || statusCode === 403 || statusCode >= 500) {
        return {
            blocked: true,
            reason: 'HTTP_ERROR',
            message: `Google returned HTTP ${statusCode}`,
        };
    }

    const urlLower = String(finalUrl || '').toLowerCase();
    const htmlStr = String(html || '');

    if (
        urlLower.includes('/sorry/')
        || htmlStr.includes('/sorry/index')
        || htmlStr.includes('id="captcha-form"')
        || /unusual traffic from your computer/i.test(htmlStr)
    ) {
        return {
            blocked: true,
            reason: 'CAPTCHA',
            message: 'Google gated this IP with a /sorry/ CAPTCHA ("unusual traffic")',
        };
    }

    if (
        urlLower.includes('consent.google.')
        || htmlStr.includes('action="https://consent.google.')
    ) {
        return {
            blocked: true,
            reason: 'CONSENT',
            message: 'Google redirected to a consent gate',
        };
    }

    if (
        htmlStr.includes('/httpservice/retry/enablejs')
        || htmlStr.includes('Please click here if you are not redirected')
    ) {
        return {
            blocked: true,
            reason: 'JS_CHALLENGE',
            message: 'Google SearchGuard returned /httpservice/retry/enablejs challenge (JavaScript required)',
        };
    }

    if (htmlStr.length < 1500 && !htmlStr.includes('id="search"') && !htmlStr.includes('id="rso"')) {
        return {
            blocked: true,
            reason: 'EMPTY_RESPONSE',
            message: `Unexpectedly short Google response (${htmlStr.length} bytes)`,
        };
    }

    return { blocked: false };
}

// Helper to clean HTML entities and tags
export function decodeHtml(html) {
    if (!html || typeof html !== 'string') return '';
    return html
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/<[^>]+>/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

// Clean and validate destination URLs
export function cleanGoogleUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return null;
    let url = rawUrl.trim();

    // Handle relative Google redirect URLs: /url?q=https://example.com&... or https://www.google.com/url?q=...
    if (url.startsWith('/url?') || url.startsWith('https://www.google.com/url?')) {
        try {
            const parsed = new URL(url, 'https://www.google.com');
            const target = parsed.searchParams.get('q') || parsed.searchParams.get('url');
            if (target) url = target;
        } catch {
            const match = url.match(/[?&](?:q|url)=([^&]+)/);
            if (match) url = decodeURIComponent(match[1]);
        }
    }

    if (!/^https?:\/\//i.test(url)) return null;

    try {
        const parsed = new URL(url);
        const host = parsed.hostname.toLowerCase();
        if (
            host === 'accounts.google.com'
            || host === 'support.google.com'
            || host === 'policies.google.com'
            || host === 'consent.google.com'
            || (host.endsWith('google.com') && parsed.pathname.startsWith('/search'))
            || (host.endsWith('google.com') && parsed.pathname.startsWith('/sorry'))
        ) {
            return null;
        }
        return parsed.toString();
    } catch {
        return null;
    }
}

// Extract domain from URL
export function getDomain(url) {
    try {
        const parsed = new URL(url);
        return parsed.hostname.replace(/^www\./, '');
    } catch {
        return null;
    }
}

function splitDatePrefix(description) {
    if (!description) return { description: '', date: null };
    const dateMatch = description.match(
        /^([A-Za-z]{3,9}\s+\d{1,2},\s+\d{4}|\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}|\d+\s+(?:minutes?|hours?|days?|weeks?|months?|years?)\s+ago)\s*[—–\-·|]+\s*/i
    );
    if (dateMatch) {
        return {
            date: dateMatch[1].trim(),
            description: description.slice(dateMatch[0].length).trim(),
        };
    }
    return { description: description.trim(), date: null };
}

// Parse Organic Search Results using Cheerio DOM
export function parseOrganicResults(html, query, startPosition = 1, pageNumber = 1) {
    if (!html || typeof html !== 'string') return [];

    const $ = load(html);
    const results = [];
    const seenUrls = new Set();
    let currentPosition = startPosition;

    const scope = $('#rso').length ? $('#rso') : ($('#search').length ? $('#search') : ($('#main').length ? $('#main') : $.root()));

    const isInsideExcludedSection = (el) => {
        return el.closest('#tads, #tadsb, #bottomads, .uEierd, [data-text-ad], [data-q], .related-question-pair, [jsname="Cpkphb"], #bres').length > 0;
    };

    // 1. Standard Google SERP headings: <a href="..."><h3 ...>...</h3></a> or <h3><a href="...">...</a></h3>
    scope.find('h3').each((_, h3Node) => {
        const $h3 = $(h3Node);
        if (isInsideExcludedSection($h3)) return;

        let $anchor = $h3.closest('a[href]');
        if (!$anchor.length) {
            $anchor = $h3.find('a[href]').first();
        }
        if (!$anchor.length) {
            const $parentLink = $h3.parent().closest('div').find('a[href]').first();
            if ($parentLink.length) $anchor = $parentLink;
        }
        if (!$anchor.length) return;

        const url = cleanGoogleUrl($anchor.attr('href'));
        if (!url || seenUrls.has(url)) return;

        const title = $h3.text().replace(/\s+/g, ' ').trim();
        if (!title) return;

        const $card = $h3.closest('div.tF2Cxc, div.MjjYud, div.g, div[data-rpos], div.N54PNb, div.kvH3mc, div[data-hveid], div.Gx5Zad');

        // Displayed breadcrumb URL
        const displayedUrl = $card.find('cite').first().text().replace(/\s+/g, ' ').trim() || url;

        // Description / Snippet (avoid capturing card title/cite text)
        let rawDescription = '';
        const snippetSelectors = ['.VwiC3b', '[data-sncf="1"]', '[data-sncf]', '.IsZvec', '.lEBKkf', '.kb0PBd.cvP2Ce', '.BNeawe.s3v9rd'];
        for (const sel of snippetSelectors) {
            const candidate = $card.find(sel).filter((__, el) => {
                const $el = $(el);
                return $el.find('h3').length === 0 && $el.find('cite').length === 0;
            }).first().text().replace(/\s+/g, ' ').trim();
            if (candidate && candidate !== title && candidate.length > 15) {
                rawDescription = candidate;
                break;
            }
        }

        const { description, date } = splitDatePrefix(rawDescription);

        // Sitelinks
        const sitelinks = [];
        $card.find('a.usJjCc, .HiHjCd a, table.jmjoTe a').each((__, slEl) => {
            const $sl = $(slEl);
            const slUrl = cleanGoogleUrl($sl.attr('href'));
            const slTitle = $sl.text().replace(/\s+/g, ' ').trim();
            if (slUrl && slTitle && slUrl !== url && !sitelinks.some((s) => s.url === slUrl)) {
                sitelinks.push({ title: slTitle, url: slUrl });
            }
        });

        seenUrls.add(url);
        results.push({
            type: 'ORGANIC',
            searchQuery: query,
            position: currentPosition++,
            title,
            url,
            domain: getDomain(url),
            displayedUrl,
            description,
            date,
            ...(sitelinks.length > 0 ? { sitelinks } : {}),
            pageNumber,
            scrapedAt: new Date().toISOString(),
        });
    });

    // 2. Fallback for light / mobile SERP HTML (e.g., BNeawe vvjwJb cards) if no <h3> links found
    if (results.length === 0) {
        scope.find('div.Gx5Zad, div.ZINbbc').each((_, cardNode) => {
            const $card = $(cardNode);
            if (isInsideExcludedSection($card)) return;

            const $anchor = $card.find('a[href^="/url?"], a[href^="http"]').first();
            if (!$anchor.length) return;

            const url = cleanGoogleUrl($anchor.attr('href'));
            if (!url || seenUrls.has(url)) return;

            const title = $anchor.find('.vvjwJb, .BNeawe.vvjwJb').first().text().replace(/\s+/g, ' ').trim()
                || $anchor.text().replace(/\s+/g, ' ').trim();
            if (!title) return;

            const rawDescription = $card.find('.BNeawe.s3v9rd').not(':has(a)').first().text().replace(/\s+/g, ' ').trim();
            const { description, date } = splitDatePrefix(rawDescription);

            seenUrls.add(url);
            results.push({
                type: 'ORGANIC',
                searchQuery: query,
                position: currentPosition++,
                title,
                url,
                domain: getDomain(url),
                displayedUrl: url,
                description,
                date,
                pageNumber,
                scrapedAt: new Date().toISOString(),
            });
        });
    }

    return results;
}

// Parse "People Also Ask" (PAA) Questions
export function parsePeopleAlsoAsk(html, query) {
    if (!html || typeof html !== 'string') return [];
    const $ = load(html);
    const questions = [];
    const seen = new Set();

    $('[data-q]').each((_, el) => {
        const q = ($(el).attr('data-q') || '').replace(/\s+/g, ' ').trim();
        if (q && q.length > 5 && !seen.has(q.toLowerCase())) {
            seen.add(q.toLowerCase());
            questions.push({
                type: 'PEOPLE_ALSO_ASK',
                searchQuery: query,
                question: q,
                scrapedAt: new Date().toISOString(),
            });
        }
    });

    if (questions.length === 0) {
        $('.related-question-pair, [jsname="yEVEwb"]').each((_, el) => {
            const q = $(el).find('span, div[role="button"]').first().text().replace(/\s+/g, ' ').trim();
            if (q && q.endsWith('?') && !seen.has(q.toLowerCase())) {
                seen.add(q.toLowerCase());
                questions.push({
                    type: 'PEOPLE_ALSO_ASK',
                    searchQuery: query,
                    question: q,
                    scrapedAt: new Date().toISOString(),
                });
            }
        });
    }

    return questions;
}

// Parse Featured Snippet (Answer Box)
export function parseFeaturedSnippet(html, query) {
    if (!html || typeof html !== 'string') return null;
    const $ = load(html);
    const scope = $('#rso').length ? $('#rso') : ($('#search').length ? $('#search') : $.root());

    const snippetEl = scope.find('.hgKElc, .ILfuVd, .IZ6rdc, .wDYxhc[data-md="61"] .LGOjhe')
        .filter((_, el) => $(el).closest('[data-q], .related-question-pair').length === 0)
        .first();

    if (!snippetEl.length) return null;

    const answer = snippetEl.text().replace(/\s+/g, ' ').trim();
    if (!answer) return null;

    const $container = snippetEl.closest('.xpdopen, .cUnQKe, .MjjYud, .kp-blk, [data-attrid]');
    const title = $container.find('h3').first().text().replace(/\s+/g, ' ').trim();
    const rawHref = $container.find('a[href]').filter((_, a) => Boolean(cleanGoogleUrl($(a).attr('href')))).first().attr('href');
    const url = cleanGoogleUrl(rawHref);

    return {
        type: 'FEATURED_SNIPPET',
        searchQuery: query,
        answer,
        ...(title ? { title } : {}),
        ...(url ? { url, domain: getDomain(url) } : {}),
        scrapedAt: new Date().toISOString(),
    };
}

// Parse Related Searches Keywords (scoped to bottom SERP suggestion containers)
export function parseRelatedSearches(html, query) {
    if (!html || typeof html !== 'string') return [];
    const $ = load(html);
    const related = [];
    const seen = new Set();
    const normalizedQuery = String(query || '').trim().toLowerCase();

    const selectors = [
        '#bres a[href*="/search?"]',
        '#botstuff a[href*="/search?"]',
        'a.k8XOCe[href*="/search?"]',
        '.AJLUJb a[href*="/search?"]',
        'a.F3dFMc[href*="/search?"]',
        '.BNeawe a[href*="/search?"]',
    ].join(', ');

    $(selectors).each((_, el) => {
        const $a = $(el);
        if ($a.closest('#hdtb, #top_nav, [role="navigation"]').length > 0) return;

        const href = $a.attr('href') || '';
        if (/[?&](?:tbm|udm|start|tbs)=/i.test(href)) return;

        let term = $a.find('.s75CSd, .AB4Wff').first().text().replace(/\s+/g, ' ').trim()
            || $a.text().replace(/\s+/g, ' ').trim();

        if (!term) {
            const match = href.match(/[?&]q=([^&]+)/);
            if (match) {
                try {
                    term = decodeURIComponent(match[1].replace(/\+/g, ' ')).trim();
                } catch {}
            }
        }

        const lower = term.toLowerCase();
        if (
            term
            && term.length > 1
            && lower !== normalizedQuery
            && !/^\d+$/.test(term)
            && !['next', 'previous', 'more'].includes(lower)
            && !seen.has(lower)
        ) {
            seen.add(lower);
            related.push({
                type: 'RELATED_SEARCH',
                searchQuery: query,
                title: term,
                scrapedAt: new Date().toISOString(),
            });
        }
    });

    return related;
}
