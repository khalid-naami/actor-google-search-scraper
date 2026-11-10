/**
 * Google Search Ultimate Scraper - Extractors & Parsers
 * High-precision parsing for Organic SERP Results, Featured Snippets, PAA, and Related Searches.
 */

// Helper to clean HTML entities
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
        .trim();
}

// Clean and validate destination URLs
export function cleanGoogleUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return null;
    let url = rawUrl;

    // Handle Google redirect URLs: /url?q=https://example.com&...
    if (url.startsWith('/url?')) {
        const match = url.match(/[?&]q=([^&]+)/);
        if (match) url = decodeURIComponent(match[1]);
    }

    if (!url.startsWith('http')) return null;
    if (url.includes('google.com/search') || url.includes('accounts.google.com') || url.includes('support.google.com')) {
        return null;
    }

    return url;
}

// Extract domain from URL
export function getDomain(url) {
    try {
        const parsed = new URL(url);
        return parsed.hostname.replace(/^www\./, '');
    } catch (_) {
        return null;
    }
}

// Parse Organic Search Results
export function parseOrganicResults(html, query, startPosition = 1, pageNumber = 1) {
    if (!html) return [];
    const results = [];
    let currentPosition = startPosition;

    // Find result blocks: Google wraps them in div.MjjYud, div.g, or div.tF2Cxc
    const blocks = html.split(/<div[^>]+class="[^"]*(?:MjjYud|g\s|tF2Cxc)[^"]*"[^>]*>/gi);

    for (let i = 1; i < blocks.length; i++) {
        const block = blocks[i];

        // 1. Title
        const titleMatch = block.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
        const title = titleMatch ? decodeHtml(titleMatch[1]) : '';
        if (!title) continue;

        // 2. Link / URL
        const linkMatch = block.match(/<a[^>]+href="([^"]+)"[^>]*>/i);
        const rawUrl = linkMatch ? linkMatch[1] : null;
        const url = cleanGoogleUrl(rawUrl);
        if (!url) continue;

        // Avoid duplicate links in the same SERP page
        if (results.some(r => r.url === url)) continue;

        // 3. Displayed / Breadcrumb URL
        const citeMatch = block.match(/<cite[^>]*>([\s\S]*?)<\/cite>/i);
        const displayedUrl = citeMatch ? decodeHtml(citeMatch[1]) : url;

        // 4. Description / Snippet
        let description = '';
        const descMatch = block.match(/class="[^"]*VwiC3b[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
            || block.match(/style="-webkit-line-clamp:[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
            || block.match(/class="[^"]*IsZvec[^"]*"[^>]*>([\s\S]*?)<\/div>/i);

        if (descMatch) {
            description = decodeHtml(descMatch[1]);
        }

        // 5. Date in snippet
        let date = null;
        const dateMatch = description.match(/^([A-Za-z]{3,9}\s+\d{1,2},\s+\d{4}|\d+\s+(?:days?|hours?|weeks?|months?|years?)\s+ago)\s*[—–-]\s*/i);
        if (dateMatch) {
            date = dateMatch[1].trim();
            description = description.replace(dateMatch[0], '').trim();
        }

        // 6. Sitelinks (if present)
        const sitelinks = [];
        const sitelinkRegex = /<a[^>]+class="[^"]*(?:usJjCc|l\s)[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
        let slMatch;
        while ((slMatch = sitelinkRegex.exec(block)) !== null) {
            const slUrl = cleanGoogleUrl(slMatch[1]);
            const slTitle = decodeHtml(slMatch[2]);
            if (slUrl && slTitle) {
                sitelinks.push({ title: slTitle, url: slUrl });
            }
        }

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
            sitelinks: sitelinks.length > 0 ? sitelinks : undefined,
            pageNumber,
            scrapedAt: new Date().toISOString()
        });
    }

    return results;
}

// Parse "People Also Ask" (PAA) Questions
export function parsePeopleAlsoAsk(html, query) {
    if (!html) return [];
    const questions = [];

    // 1. Data-q attribute matches
    const dataQRegex = /data-q="([^"]+)"/gi;
    let match;
    while ((match = dataQRegex.exec(html)) !== null) {
        const q = decodeHtml(match[1]);
        if (q && q.length > 5 && !questions.some(item => item.question === q)) {
            questions.push({
                type: 'PEOPLE_ALSO_ASK',
                searchQuery: query,
                question: q,
                scrapedAt: new Date().toISOString()
            });
        }
    }

    // 2. Fallback class match
    if (questions.length === 0) {
        const classRegex = /class="[^"]*(?:related-question-pair|match-mod-horizontal)[^"]*"[^>]*>[\s\S]*?<div[^>]*>([^<]+)<\/div>/gi;
        let cMatch;
        while ((cMatch = classRegex.exec(html)) !== null) {
            const q = decodeHtml(cMatch[1]);
            if (q && q.endsWith('?') && !questions.some(item => item.question === q)) {
                questions.push({
                    type: 'PEOPLE_ALSO_ASK',
                    searchQuery: query,
                    question: q,
                    scrapedAt: new Date().toISOString()
                });
            }
        }
    }

    return questions;
}

// Parse Featured Snippet (Answer Box)
export function parseFeaturedSnippet(html, query) {
    if (!html) return null;

    const answerMatch = html.match(/class="[^"]*(?:hgKElc|ILfuVd)[^"]*"[^>]*>([\s\S]*?)<\/(?:span|div)>/i);
    if (!answerMatch) return null;

    const answer = decodeHtml(answerMatch[1]);
    if (!answer) return null;

    // Find source URL and title inside featured snippet block
    const blockMatch = html.match(/class="[^"]*(?:cUnQKe|xpdopen)[^"]*"[\s\S]*?<\/div>\s*<\/div>/i);
    let title = '';
    let url = null;

    if (blockMatch) {
        const tMatch = blockMatch[0].match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
        if (tMatch) title = decodeHtml(tMatch[1]);

        const lMatch = blockMatch[0].match(/<a[^>]+href="([^"]+)"[^>]*>/i);
        if (lMatch) url = cleanGoogleUrl(lMatch[1]);
    }

    return {
        type: 'FEATURED_SNIPPET',
        searchQuery: query,
        answer,
        title: title || undefined,
        url: url || undefined,
        domain: url ? getDomain(url) : undefined,
        scrapedAt: new Date().toISOString()
    };
}

// Parse Related Searches Keywords
export function parseRelatedSearches(html, query) {
    if (!html) return [];
    const related = [];

    // Match links with /search?q= in the bottom section
    const regex = /<a[^>]+href="\/search\?[^"]*q=([^"&]+)[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
    let match;

    while ((match = regex.exec(html)) !== null) {
        const keyword = decodeURIComponent(match[1].replace(/\+/g, ' ')).trim();
        const text = decodeHtml(match[2]);

        const term = text || keyword;
        if (term && term.toLowerCase() !== query.toLowerCase() && !related.some(r => r.title.toLowerCase() === term.toLowerCase())) {
            related.push({
                type: 'RELATED_SEARCH',
                searchQuery: query,
                title: term,
                scrapedAt: new Date().toISOString()
            });
        }
    }

    return related;
}
