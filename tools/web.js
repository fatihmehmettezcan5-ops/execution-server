import fetch from "node-fetch";
import { JSDOM } from "jsdom";

const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9,tr;q=0.8",
  "Accept-Encoding": "gzip, deflate, br",
  "Connection": "keep-alive",
  "Upgrade-Insecure-Requests": "1",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Cache-Control": "max-age=0"
};

function extractCleanText(html) {
  try {
    const dom = new JSDOM(html);
    const doc = dom.window.document;

    const removeSelectors = ["script", "style", "nav", "footer", "header", "aside", "iframe", "noscript", "svg", "img", "video", "audio"];
    removeSelectors.forEach(sel => {
      doc.querySelectorAll(sel).forEach(el => el.remove());
    });

    const main = doc.querySelector("article") || doc.querySelector("main") || doc.querySelector('[role="main"]');
    const target = main || doc.body;

    if (!target) return html.slice(0, 8000);

    let text = target.textContent || "";
    text = text.replace(/\s+/g, " ").replace(/\n\s*\n/g, "\n").trim();
    return text;
  } catch {
    return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  }
}

function isCloudflareBlock(text, status) {
  if (status === 403 || status === 503) return true;
  const cfSignals = ["cf-browser-verification", "cloudflare", "cf_clearance", "challenge-platform", "Just a moment", "Checking your browser"];
  return cfSignals.some(s => text.toLowerCase().includes(s.toLowerCase()));
}

async function directFetch(url) {
  const res = await fetch(url, {
    headers: BROWSER_HEADERS,
    redirect: "follow",
    timeout: 15000
  });
  const html = await res.text();
  if (isCloudflareBlock(html, res.status)) return null;
  return { html, status: res.status };
}

async function googleCacheFetch(url) {
  const cacheUrl = `https://webcache.googleusercontent.com/search?q=cache:${encodeURIComponent(url)}`;
  const res = await fetch(cacheUrl, {
    headers: BROWSER_HEADERS,
    redirect: "follow",
    timeout: 15000
  });
  if (res.status !== 200) return null;
  const html = await res.text();
  if (isCloudflareBlock(html, res.status)) return null;
  return { html, status: res.status };
}

async function archiveFetch(url) {
  const checkUrl = `https://archive.org/wayback/available?url=${encodeURIComponent(url)}`;
  const checkRes = await fetch(checkUrl, { timeout: 10000 });
  const data = await checkRes.json();

  if (!data.archived_snapshots?.closest?.url) return null;

  const snapshotUrl = data.archived_snapshots.closest.url;
  const res = await fetch(snapshotUrl, {
    headers: BROWSER_HEADERS,
    redirect: "follow",
    timeout: 15000
  });
  const html = await res.text();
  return { html, status: res.status, note: `(Archive.org snapshot: ${data.archived_snapshots.closest.timestamp})` };
}

async function proxyFetch(url) {
  const proxyUrl = `https://12ft.io/api/proxy?q=${encodeURIComponent(url)}`;
  const res = await fetch(proxyUrl, {
    headers: BROWSER_HEADERS,
    redirect: "follow",
    timeout: 15000
  });
  if (res.status !== 200) return null;
  const html = await res.text();
  if (isCloudflareBlock(html, res.status)) return null;
  return { html, status: res.status };
}

export async function webFetch(url) {
  const strategies = [
    { name: "Direct", fn: () => directFetch(url) },
    { name: "Google Cache", fn: () => googleCacheFetch(url) },
    { name: "12ft Proxy", fn: () => proxyFetch(url) },
    { name: "Archive.org", fn: () => archiveFetch(url) }
  ];

  for (const strategy of strategies) {
    try {
      console.log(`🌐 Trying: ${strategy.name} → ${url}`);
      const result = await strategy.fn();

      if (result && result.html) {
        const cleanText = extractCleanText(result.html);
        const note = result.note || "";
        const finalText = cleanText.slice(0, 15000);

        console.log(`✅ Success via ${strategy.name} (${finalText.length} chars)`);

        return {
          content: [{
            type: "text",
            text: `[Source: ${strategy.name}] ${note}\n\n${finalText}`
          }]
        };
      }
    } catch (err) {
      console.log(`❌ ${strategy.name} failed: ${err.message}`);
      continue;
    }
  }

  return {
    content: [{
      type: "text",
      text: `⚠️ Siteye erişilemedi (Cloudflare/WAF koruması). Denenen yöntemler: Direct, Google Cache, 12ft Proxy, Archive.org. URL: ${url}`
    }]
  };
}
