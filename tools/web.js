import fetch from "node-fetch";
import { JSDOM } from "jsdom";

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9,tr;q=0.8",
  "Accept-Encoding": "gzip, deflate, br",
  Connection: "keep-alive",
  "Upgrade-Insecure-Requests": "1",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Cache-Control": "max-age=0",
};

// ═══════════════════════════════════════════════════════════
// 1. STRUCTURED DATA — JSON-LD, OpenGraph, Meta
// ═══════════════════════════════════════════════════════════

function extractStructuredData(doc) {
  const results = [];

  // JSON-LD (Schema.org) — en değerli veri kaynağı
  doc.querySelectorAll('script[type="application/ld+json"]').forEach((el) => {
    try {
      const data = JSON.parse(el.textContent);
      results.push({ type: "json-ld", data });
    } catch {}
  });

  // Open Graph meta tags
  const og = {};
  doc.querySelectorAll('meta[property^="og:"]').forEach((el) => {
    const key = el.getAttribute("property");
    const val = el.getAttribute("content");
    if (key && val) og[key] = val;
  });
  if (Object.keys(og).length > 0)
    results.push({ type: "opengraph", data: og });

  // Standard meta tags
  const meta = {};
  ["description", "keywords", "author", "robots"].forEach((name) => {
    const el = doc.querySelector(`meta[name="${name}"]`);
    if (el) meta[name] = el.getAttribute("content");
  });
  if (Object.keys(meta).length > 0) results.push({ type: "meta", data: meta });

  // Title
  const title = doc.querySelector("title");
  if (title) results.push({ type: "title", data: title.textContent.trim() });

  // Canonical
  const canonical = doc.querySelector('link[rel="canonical"]');
  if (canonical)
    results.push({ type: "canonical", data: canonical.getAttribute("href") });

  return results;
}

// ═══════════════════════════════════════════════════════════
// 2. PRODUCT CARD EXTRACTION — E-Ticaret siteleri için
// ═══════════════════════════════════════════════════════════

function extractProductCards(doc) {
  const products = [];

  // Yaygın e-ticaret ürün kartı seçicileri
  const cardSelectors = [
    "[data-product]",
    "[data-product-id]",
    "[data-productid]",
    ".product-card",
    ".product-item",
    ".product",
    ".urun",
    ".card-product",
    '[itemtype*="Product"]',
    '[data-testid*="product"]',
    ".product-box",
    ".prd",
    ".item-card",
    "li[data-sku]",
    ".catalog-product",
    ".p-card",
    ".product-list-item",
  ];

  let cards = [];
  for (const sel of cardSelectors) {
    cards = doc.querySelectorAll(sel);
    if (cards.length > 0) break;
  }

  // Eğer hiç kart bulunamazsa, fiyat elementleri etrafından çıkarmayı dene
  if (cards.length === 0) {
    // Fiyat içeren en yakın parent container'ı bul
    const priceEls = doc.querySelectorAll(
      '[class*="price"], [class*="fiyat"], [data-price]'
    );
    const parentSet = new Set();
    priceEls.forEach((el) => {
      let parent = el.parentElement;
      // 3 seviye yukarı çık, anlamlı bir container bul
      for (let i = 0; i < 4 && parent; i++) {
        if (
          parent.querySelector("a") &&
          parent.textContent.trim().length < 500
        ) {
          parentSet.add(parent);
          break;
        }
        parent = parent.parentElement;
      }
    });
    cards = Array.from(parentSet);
  }

  cards.forEach((card) => {
    const product = {};

    // Ürün adı — birçok farklı yöntemle dene
    const nameEl =
      card.querySelector("[data-product-name]") ||
      card.querySelector("[data-name]") ||
      card.querySelector(".product-name") ||
      card.querySelector(".product-title") ||
      card.querySelector(".prd-name") ||
      card.querySelector(".name") ||
      card.querySelector("h2") ||
      card.querySelector("h3") ||
      card.querySelector("h4") ||
      card.querySelector("a[title]");

    if (nameEl) {
      product.name =
        nameEl.getAttribute("data-product-name") ||
        nameEl.getAttribute("data-name") ||
        nameEl.getAttribute("title") ||
        nameEl.textContent.trim();
    }

    // Tüm fiyat metinlerini topla (TL, ₺ içeren)
    const allText = card.textContent;
    const priceRegex = /[₺€$]?\s*[\d.,]+\s*(?:₺|TL|€|\$)/g;
    const allPrices = allText.match(priceRegex) || [];

    // Yapısal fiyat seçicileri
    const priceSelectors = [
      ".price",
      ".product-price",
      ".prd-price",
      ".current-price",
      ".sale-price",
      ".discounted-price",
      "[data-price]",
      ".price-new",
      ".price-current",
      ".amount",
      ".final-price",
    ];
    const oldPriceSelectors = [
      ".old-price",
      ".original-price",
      ".price-old",
      ".list-price",
      ".line-through",
      "del",
      "s",
      ".price-regular",
      ".strikethrough",
      ".retail-price",
    ];
    const discountSelectors = [
      ".discount",
      ".badge-discount",
      ".discount-rate",
      ".discount-badge",
      ".campaign-badge",
      ".prd-discount",
      ".sale-badge",
    ];

    for (const sel of priceSelectors) {
      const el = card.querySelector(sel);
      if (el) {
        product.price = el.getAttribute("data-price") || el.textContent.trim();
        break;
      }
    }

    for (const sel of oldPriceSelectors) {
      const el = card.querySelector(sel);
      if (el) {
        product.oldPrice = el.textContent.trim();
        break;
      }
    }

    for (const sel of discountSelectors) {
      const el = card.querySelector(sel);
      if (el) {
        product.discount = el.textContent.trim();
        break;
      }
    }

    // Regex fallback: fiyat bulunamadıysa regex'ten al
    if (!product.price && allPrices.length > 0) {
      if (allPrices.length >= 2) {
        product.oldPrice = allPrices[0].trim();
        product.price = allPrices[allPrices.length - 1].trim();
      } else {
        product.price = allPrices[0].trim();
      }
    }

    // Link
    const linkEl = card.querySelector("a[href]");
    if (linkEl) product.url = linkEl.getAttribute("href");

    // Görsel
    const imgEl = card.querySelector("img");
    if (imgEl) {
      product.image =
        imgEl.getAttribute("data-src") ||
        imgEl.getAttribute("data-lazy-src") ||
        imgEl.getAttribute("src") ||
        imgEl.getAttribute("data-lazy");
    }

    // Alt bilgi: stok, renk, beden vb.
    const badges = card.querySelectorAll(
      ".badge, .tag, .label, .stock, .variant"
    );
    const badgeTexts = [];
    badges.forEach((b) => {
      const t = b.textContent.trim();
      if (t.length > 0 && t.length < 50) badgeTexts.push(t);
    });
    if (badgeTexts.length > 0) product.badges = badgeTexts.join(", ");

    // Data attribute'lar
    [
      "data-product-id",
      "data-sku",
      "data-brand",
      "data-category",
      "data-variant",
      "data-stock",
      "data-rating",
    ].forEach((attr) => {
      const val = card.getAttribute(attr);
      if (val) product[attr.replace("data-", "")] = val;
    });

    if (product.name || product.price) {
      products.push(product);
    }
  });

  return products;
}

// ═══════════════════════════════════════════════════════════
// 3. TABLE EXTRACTION
// ═══════════════════════════════════════════════════════════

function extractTables(doc) {
  const tables = [];
  doc.querySelectorAll("table").forEach((table) => {
    const rows = [];
    table.querySelectorAll("tr").forEach((tr) => {
      const cells = [];
      tr.querySelectorAll("th, td").forEach((cell) => {
        cells.push(cell.textContent.trim());
      });
      if (cells.length > 0) rows.push(cells);
    });
    if (rows.length > 0 && rows.length < 200) tables.push(rows);
  });
  return tables;
}

// ═══════════════════════════════════════════════════════════
// 4. NAVIGATION & LINK EXTRACTION
// ═══════════════════════════════════════════════════════════

function extractLinks(doc, baseUrl) {
  const links = [];
  const seen = new Set();
  doc.querySelectorAll("a[href]").forEach((a) => {
    const href = a.getAttribute("href");
    const text = a.textContent.trim().substring(0, 120);
    if (!href || href === "#" || href.startsWith("javascript:")) return;
    if (text.length < 2) return;

    let fullUrl = href;
    try {
      fullUrl = new URL(href, baseUrl).href;
    } catch {}

    if (!seen.has(fullUrl)) {
      seen.add(fullUrl);
      links.push({ text, url: fullUrl });
    }
  });
  return links;
}

// ═══════════════════════════════════════════════════════════
// 5. HEADING STRUCTURE
// ═══════════════════════════════════════════════════════════

function extractHeadings(doc) {
  const headings = [];
  doc.querySelectorAll("h1, h2, h3, h4").forEach((h) => {
    const text = h.textContent.trim().replace(/\s+/g, " ");
    if (text.length > 0 && text.length < 200) {
      headings.push({ level: h.tagName, text });
    }
  });
  return headings;
}

// ═══════════════════════════════════════════════════════════
// 6. LIST EXTRACTION
// ═══════════════════════════════════════════════════════════

function extractLists(doc) {
  const lists = [];
  doc.querySelectorAll("ul, ol").forEach((list) => {
    const items = [];
    list.querySelectorAll(":scope > li").forEach((li) => {
      const text = li.textContent.trim().replace(/\s+/g, " ");
      if (text.length > 0 && text.length < 300) items.push(text);
    });
    if (items.length > 1 && items.length < 50) lists.push(items);
  });
  return lists;
}

// ═══════════════════════════════════════════════════════════
// 7. FILTER / FACET EXTRACTION (E-ticaret filtreleri)
// ═══════════════════════════════════════════════════════════

function extractFilters(doc) {
  const filters = [];

  // Select elementleri
  doc.querySelectorAll("select").forEach((select) => {
    const name =
      select.getAttribute("name") ||
      select.getAttribute("id") ||
      select.getAttribute("aria-label") ||
      "";
    const options = [];
    select.querySelectorAll("option").forEach((opt) => {
      const text = opt.textContent.trim();
      const value = opt.getAttribute("value");
      if (text && value && value !== "") options.push(text);
    });
    if (options.length > 0) filters.push({ name, options });
  });

  // Checkbox/radio filter grupları
  doc
    .querySelectorAll(
      ".filter-group, .facet, [data-filter], .filter-section, .refinement"
    )
    .forEach((group) => {
      const title =
        group.querySelector("h3, h4, .title, .filter-title, legend");
      const name = title ? title.textContent.trim() : "";
      const options = [];
      group
        .querySelectorAll("label, .filter-option, .facet-value")
        .forEach((opt) => {
          const text = opt.textContent.trim().replace(/\s+/g, " ");
          if (text.length > 0 && text.length < 100) options.push(text);
        });
      if (options.length > 0 && name) filters.push({ name, options });
    });

  return filters;
}

// ═══════════════════════════════════════════════════════════
// 8. CLEAN TEXT (Fallback — yapısal veri yoksa)
// ═══════════════════════════════════════════════════════════

function extractCleanText(doc) {
  // Klonla ki orijinal DOM bozulmasın
  const clone = doc.cloneNode(true);

  const removeSelectors = [
    "script",
    "style",
    "nav",
    "footer",
    "header",
    "aside",
    "iframe",
    "noscript",
    "svg",
    "video",
    "audio",
    ".cookie-banner",
    ".popup",
    ".modal",
    ".overlay",
    '[aria-hidden="true"]',
    ".advertisement",
    ".ad-container",
  ];
  removeSelectors.forEach((sel) => {
    clone.querySelectorAll(sel).forEach((el) => el.remove());
  });

  const main =
    clone.querySelector("article") ||
    clone.querySelector("main") ||
    clone.querySelector('[role="main"]') ||
    clone.querySelector("#content") ||
    clone.querySelector(".content") ||
    clone.querySelector(".main-content") ||
    clone.body;

  if (!main) return "";

  let text = main.textContent || "";
  text = text.replace(/\s+/g, " ").replace(/\n\s*\n/g, "\n").trim();
  return text;
}

// ═══════════════════════════════════════════════════════════
// 9. MASTER EXTRACTOR — Her şeyi birleştir
// ═══════════════════════════════════════════════════════════

function extractAllData(html, url) {
  const dom = new JSDOM(html, { url });
  const doc = dom.window.document;

  const structured = extractStructuredData(doc);
  const products = extractProductCards(doc);
  const tables = extractTables(doc);
  const headings = extractHeadings(doc);
  const links = extractLinks(doc, url);
  const lists = extractLists(doc);
  const filters = extractFilters(doc);
  const cleanText = extractCleanText(doc);

  const sections = [];

  // ── Sayfa Bilgisi ──
  const titleData = structured.find((s) => s.type === "title");
  if (titleData) sections.push("📄 SAYFA: " + titleData.data);

  const canonicalData = structured.find((s) => s.type === "canonical");
  if (canonicalData) sections.push("🔗 URL: " + canonicalData.data);

  const metaData = structured.find((s) => s.type === "meta");
  if (metaData?.data?.description) {
    sections.push("📝 AÇIKLAMA: " + metaData.data.description);
  }

  // ── JSON-LD (Schema.org) ──
  const jsonLdData = structured.filter((s) => s.type === "json-ld");
  if (jsonLdData.length > 0) {
    sections.push("\n📊 YAPISAL VERİ (JSON-LD):");
    jsonLdData.forEach((jld) => {
      sections.push(JSON.stringify(jld.data, null, 2).substring(0, 5000));
    });
  }

  // ── Ürün Kartları ──
  if (products.length > 0) {
    sections.push("\n🛒 ÜRÜNLER (" + products.length + " adet):");
    sections.push("─".repeat(60));
    products.forEach((p, i) => {
      let line = (i + 1) + ". ";
      if (p.name) line += "📦 " + p.name;
      if (p.brand) line += " | Marka: " + p.brand;
      if (p.oldPrice) line += "\n   Eski Fiyat: " + p.oldPrice;
      if (p.price) line += "\n   Fiyat: " + p.price;
      if (p.discount) line += " | İndirim: " + p.discount;
      if (p.badges) line += "\n   Etiketler: " + p.badges;
      if (p.url) line += "\n   Link: " + p.url;
      sections.push(line);
      sections.push("─".repeat(60));
    });
  }

  // ── Tablolar ──
  if (tables.length > 0) {
    sections.push("\n📋 TABLOLAR:");
    tables.forEach((table, ti) => {
      sections.push("Tablo " + (ti + 1) + ":");
      table.forEach((row) => {
        sections.push("  | " + row.join(" | ") + " |");
      });
    });
  }

  // ── Başlıklar ──
  if (headings.length > 0) {
    sections.push("\n📌 BAŞLIKLAR:");
    headings.forEach((h) => {
      const prefix =
        h.level === "H1"
          ? "# "
          : h.level === "H2"
            ? "## "
            : h.level === "H3"
              ? "### "
              : "#### ";
      sections.push(prefix + h.text);
    });
  }

  // ── Filtreler ──
  if (filters.length > 0) {
    sections.push("\n🔍 FİLTRELER / KATEGORİLER:");
    filters.forEach((f) => {
      sections.push(
        "  " + f.name + ": " + f.options.join(", ")
      );
    });
  }

  // ── Listeler ──
  if (lists.length > 0 && lists.length <= 15) {
    sections.push("\n📃 LİSTELER:");
    lists.slice(0, 10).forEach((list) => {
      list.forEach((item) => sections.push("  • " + item));
      sections.push("");
    });
  }

  // ── Önemli Linkler ──
  const contentLinks = links.filter(
    (l) =>
      l.text.length > 3 &&
      !l.url.includes("login") &&
      !l.url.includes("register") &&
      !l.url.includes("javascript") &&
      !l.url.endsWith("#")
  );
  if (contentLinks.length > 0) {
    sections.push(
      "\n🔗 LİNKLER (" + Math.min(contentLinks.length, 50) + " adet):"
    );
    contentLinks.slice(0, 50).forEach((l) => {
      sections.push("  " + l.text + " → " + l.url);
    });
  }

  // ── Clean Text (fallback) ──
  if (
    products.length === 0 &&
    tables.length === 0 &&
    jsonLdData.length === 0
  ) {
    sections.push("\n📄 SAYFA İÇERİĞİ:");
    sections.push(cleanText.substring(0, 12000));
  }

  return sections.join("\n");
}

// ═══════════════════════════════════════════════════════════
// CLOUDFLARE DETECTION
// ═══════════════════════════════════════════════════════════

function isCloudflareBlock(text, status) {
  if (status === 403 || status === 503) return true;
  const cfSignals = [
    "cf-browser-verification",
    "cloudflare",
    "cf_clearance",
    "challenge-platform",
    "Just a moment",
    "Checking your browser",
    "Enable JavaScript and cookies",
  ];
  return cfSignals.some((s) =>
    text.toLowerCase().includes(s.toLowerCase())
  );
}

// ═══════════════════════════════════════════════════════════
// FETCH STRATEGIES
// ═══════════════════════════════════════════════════════════

async function directFetch(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, {
      headers: BROWSER_HEADERS,
      redirect: "follow",
      signal: controller.signal,
    });
    const html = await res.text();
    clearTimeout(timeout);
    if (isCloudflareBlock(html, res.status)) return null;
    return { html, status: res.status };
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

async function googleCacheFetch(url) {
  const cacheUrl = `https://webcache.googleusercontent.com/search?q=cache:${encodeURIComponent(url)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(cacheUrl, {
      headers: BROWSER_HEADERS,
      redirect: "follow",
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (res.status !== 200) return null;
    const html = await res.text();
    if (isCloudflareBlock(html, res.status)) return null;
    return { html, status: res.status };
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

async function archiveFetch(url) {
  const checkUrl = `https://archive.org/wayback/available?url=${encodeURIComponent(url)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const checkRes = await fetch(checkUrl, { signal: controller.signal });
    const data = await checkRes.json();
    clearTimeout(timeout);

    if (!data.archived_snapshots?.closest?.url) return null;

    const snapshotUrl = data.archived_snapshots.closest.url;
    const res = await fetch(snapshotUrl, {
      headers: BROWSER_HEADERS,
      redirect: "follow",
    });
    const html = await res.text();
    return {
      html,
      status: res.status,
      note: `(Archive.org: ${data.archived_snapshots.closest.timestamp})`,
    };
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

async function proxyFetch(url) {
  const proxyUrl = `https://12ft.io/api/proxy?q=${encodeURIComponent(url)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(proxyUrl, {
      headers: BROWSER_HEADERS,
      redirect: "follow",
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (res.status !== 200) return null;
    const html = await res.text();
    if (isCloudflareBlock(html, res.status)) return null;
    return { html, status: res.status };
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════
// MAIN EXPORT
// ═══════════════════════════════════════════════════════════

export async function webFetch(url) {
  const strategies = [
    { name: "Direct", fn: () => directFetch(url) },
    { name: "Google Cache", fn: () => googleCacheFetch(url) },
    { name: "12ft Proxy", fn: () => proxyFetch(url) },
    { name: "Archive.org", fn: () => archiveFetch(url) },
  ];

  for (const strategy of strategies) {
    try {
      console.log(`🌐 Trying: ${strategy.name} → ${url}`);
      const result = await strategy.fn();

      if (result && result.html) {
        const extracted = extractAllData(result.html, url);
        const note = result.note || "";
        const finalText = extracted.substring(0, 25000);

        console.log(
          `✅ Success via ${strategy.name} (${finalText.length} chars)`
        );

        return {
          content: [
            {
              type: "text",
              text: `[Source: ${strategy.name}] ${note}\n\n${finalText}`,
            },
          ],
        };
      }
    } catch (err) {
      console.log(`❌ ${strategy.name} failed: ${err.message}`);
      continue;
    }
  }

  return {
    content: [
      {
        type: "text",
        text: `⚠️ Siteye erişilemedi (Cloudflare/WAF). Denenen: Direct, Google Cache, 12ft Proxy, Archive.org\nURL: ${url}`,
      },
    ],
  };
}
