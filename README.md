# 🔍 Google Search Ultimate Scraper (Organic SERP, PAA, Snippets & Ranking)

Extract live Google Search engine results pages (SERP) at scale. Scrape organic listings, Featured Snippets, People Also Ask (PAA) questions, Related Searches, and rich search metadata across any country, language, or geolocation.

---

## 🌟 Key Features

- ⚡ **High Performance & Stealth**: Uses specialized request fingerprinting to bypass bot detection without needing heavy headless browsers for standard queries.
- 🌍 **Localized Search**: Specify any Country Code (`gl`) and Language (`hl`) to extract true localized SERP results.
- 🎯 **Featured Snippets**: Captures position-zero answers, lists, and summary cards.
- ❓ **People Also Ask (PAA)**: Extracts relevant user questions and expanding SERP queries for SEO ideation.
- 🔗 **Rich Organic Details**: Retrieves title, URL, display domain, snippet description, rank position, page number, and site links.
- 🔎 **Related Searches**: Extracts bottom-of-page search term clusters.
- ⏱️ **Time Filters**: Filter results by past hour (`qdr:h`), past 24 hours (`qdr:d`), past week (`qdr:w`), past month (`qdr:m`), or past year (`qdr:y`).
- 🛡️ **Apify Proxy Ready**: Native support for residential and datacenter proxies.

---

## 📥 Input Configuration

| Field | Type | Default | Description |
|---|---|---|---|
| `queries` | Array | `["Apify web scraping"]` | List of search queries or keywords to scrape. |
| `countryCode` | String | `"us"` | Two-letter country code for regional results (e.g. `us`, `gb`, `de`, `fr`, `sa`). |
| `languageCode` | String | `"en"` | Language code for search interface & results (e.g. `en`, `ar`, `es`, `fr`, `de`). |
| `maxResults` | Integer | `100` | Maximum organic search results to extract per query. |
| `resultsPerPage` | Integer | `10` | Results per page (`10` to `100`). |
| `extractPaa` | Boolean | `true` | Extract "People Also Ask" questions and snippets. |
| `extractRelated` | Boolean | `true` | Extract related searches at the bottom of the SERP. |
| `timeFilter` | String | `""` | Optional time filter (e.g., `qdr:d` for last 24h, `qdr:m` for past month). |
| `proxyConfiguration` | Object | `{ "useApifyProxy": true }` | Proxy configuration settings. |

---

## 📤 Output Data Format

Each dataset record represents an individual organic result or SERP item:

```json
{
  "searchQuery": "best hotel in paris",
  "searchUrl": "https://www.google.com/search?q=best+hotel+in+paris&gl=us&hl=en",
  "countryCode": "us",
  "languageCode": "en",
  "resultType": "organic",
  "position": 1,
  "page": 1,
  "title": "The 10 Best Hotels in Paris - Top Places to Stay",
  "url": "https://example.com/paris-hotels",
  "domain": "example.com",
  "snippet": "Discover the finest luxury hotels in Paris with stunning Eiffel Tower views...",
  "sitelinks": [
    {
      "title": "Boutique Hotels",
      "url": "https://example.com/paris-hotels/boutique"
    }
  ],
  "featuredSnippet": null,
  "scrapedAt": "2026-11-09T13:30:00.000Z"
}
```

---

## 💡 Use Cases

1. **SEO & Rank Tracking**: Monitor organic positioning of your website and competitors over time.
2. **Content Strategy & Keyword Discovery**: Leverage "People Also Ask" and "Related Searches" to discover buyer intent and trending queries.
3. **Brand Monitoring & Reputation Management**: Track brand mentions and PR announcements across different geolocations.
4. **Market Intelligence**: Uncover top-ranking domains and niche players in any sector.

---

## ⚖️ License
Apache-2.0
