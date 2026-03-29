---
id: web-search
teaches: "WebSearch and WebFetch for information gathering and URL content"
tools: [web_search, web_fetch]
complexity: beginner
depends_on: []
---

## Web Search & Fetch

Agents can search the web and fetch URL content.

### Searching the web

Use the `web_search` MCP tool to find current information:

```
Use web_search with:
- query: "search terms here"
```

Returns a list of results with titles, URLs, and snippets. Pick the most relevant 2-3 items per topic.

### Fetching URL content

Use the `web_fetch` MCP tool to retrieve page content:

```
Use web_fetch with:
- url: "https://example.com/page"
```

Returns the page content as text. Useful for:
- Summarizing articles or blog posts
- Checking if page content has changed
- Extracting specific data from known URLs

### Demo pattern

When setting up a search-based agent, do a live search immediately to show the user what it looks like:

> Let me show you what this looks like. I'll search right now.

Search for something related to the user's interests, then format results as cards:

:::blocks
[{"type":"card","title":"Search Results","icon":"search","body":"**[Result Title](url)**\nBrief summary of what was found.\n\n**[Another Result](url)**\nAnother summary.","footer":"via web_search"}]
:::

This builds trust — the user sees real results before committing to a schedule.
