import fetch from "node-fetch";
import { JSDOM } from "jsdom";
import sharp from "sharp";
import Tesseract from "tesseract.js";

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
// 🆕 YENİ MODÜL 0: GÖRSEL FETCH & OCR ANALİZ
// ═══════════════════════════════════════════════════════════
// Broşür/katalog görsellerini indirir, sharp ile ön-işler,
// Tesseract.js ile OCR uygular ve metin çıkarır.

/**
 * Tek bir görseli fetch edip OCR ile metin çıkarır.
 */
async function fetchAndOCRImage(imageUrl, referer = "") {
  const result = { url: imageUrl, text: "", width: 0, height: 0 };

  try {
    // 1) Görseli indir
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);

    const res = await fetch(imageUrl, {
      headers: {
        ...BROWSER_HEADERS,
        Accept: "image/webp,image/apng,image/*,*/*;q=0.8",
        Referer: referer,
      },
      signal: controller.signal,
      redirect: "follow",
    });
    clearTimeout(timeout);

    if (!res.ok) {
      result.error = `HTTP ${res.status}`;
      return result;
    }

    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("image")) {
      result.error = "Not an image: " + contentType;
      return result;
    }

    const buffer = Buffer.from(await res.arrayBuffer());

    // 2) sharp ile ön-işleme (OCR doğruluğunu artırır)
    const metadata = await sharp(buffer).metadata();
    result.width = metadata.width || 0;
    result.height = metadata.height || 0;

    // Çok küçük görselleri atla (ikon, logo vs.)
    if (result.width < 200 || result.height < 200) {
      result.error = "Image too small for OCR (" + result.width + "x" + result.height + ")";
      return result;
    }

    // OCR için optimize et:
    //  - Gri tonlamaya çevir
    //  - Kontrastı artır
    //  - Küçükse 2x büyüt
    //  - Keskinleştir
    const scaleFactor = result.width < 1000 ? 2 : 1;

    const processedBuffer = await sharp(buffer)
      .resize({
        width: result.width * scaleFactor,
        height: result.height * scaleFactor,
        fit: "fill",
      })
      .greyscale()
      .normalize()
      .sharpen()
      .png()
      .toBuffer();

    // 3) Tesseract OCR uygula
    const { data } = await Tesseract.recognize(processedBuffer, "tur+eng", {
      logger: () => {},
    });

    result.text = cleanOCRText(data.text.trim());
  } catch (err) {
    result.error = err.message;
  }

  return result;
}

/**
 * OCR metnini temizler ve okunabilir hale getirir.
 */
function cleanOCRText(text) {
  if (!text) return "";

  return text
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[|]\s*$/gm, "")
    .replace(/^[|]\s*/gm, "")
    // Yaygın OCR hatalarını düzelt
    .replace(/\bTI\b/g, "TL")
    .replace(/\bIL\b/g, "TL")
    .replace(/(\d)[.,](\d{3})[.,](\d{2})\s*T[LlIi]/g, "$1.$2,$3 TL")
    .replace(/(\d+)[.,](\d{2})\s*T[LlIi]/g, "$1,$2 TL")
    .replace(/(\d+)\s*T[LlIi]/g, "$1 TL")
    .replace(/[{}\[\]<>]/g, "")
    .trim();
}

/**
 * OCR metninden fiyat bilgilerini çıkarır.
 */
function extractPricesFromOCR(text) {
  const prices = [];
  const patterns = [
    /(\d{1,3}(?:[.]\d{3})*(?:,\d{1,2})?)\s*(?:TL|₺)/gi,
    /(?:TL|₺)\s*(\d{1,3}(?:[.]\d{3})*(?:,\d{1,2})?)/gi,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      prices.push(match[0].trim());
    }
  }

  return [...new Set(prices)];
}

/**
 * OCR metninden ürün bilgilerini yapılandırılmış olarak çıkarır.
 */
function extractProductsFromOCR(text) {
  const products = [];
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const priceMatch = line.match(
      /(\d{1,3}(?:[.]\d{3})*(?:,\d{1,2})?)\s*(?:TL|₺)/i
    );

    if (priceMatch) {
      const price = priceMatch[0].trim();
      let name = line.substring(0, priceMatch.index).trim();

      if (!name || name.length < 3) {
        // Önceki satır(lar)dan ürün adı bul
        for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
          const prevLine = lines[j];
          if (
            !prevLine.match(/(\d{1,3}(?:[.]\d{3})*(?:,\d{1,2})?)\s*(?:TL|₺)/i) &&
            prevLine.length > 3 &&
            prevLine.length < 150
          ) {
            name = prevLine;
            break;
          }
        }
      }

      if (name && name.length > 2) {
        products.push({ name, price });
      }
    }
  }

  return products;
}

/**
 * Birden fazla broşür görselini paralel olarak OCR'dan geçirir.
 */
async function batchOCRImages(images, referer, maxImages = 10) {
  const prioritized = images.sort((a, b) => {
    return imagePriorityScore(b.src) - imagePriorityScore(a.src);
  });

  const selected = prioritized.slice(0, maxImages);
  const results = [];

  // Paralel ama throttled (aynı anda max 3)
  const batchSize = 3;
  for (let i = 0; i < selected.length; i += batchSize) {
    const batch = selected.slice(i, i + batchSize);
    const batchResults = await Promise.allSettled(
      batch.map((img) => fetchAndOCRImage(img.src, referer))
    );

    for (const r of batchResults) {
      if (r.status === "fulfilled" && r.value.text) {
        results.push(r.value);
      }
    }
  }

  return results;
}

function imagePriorityScore(url) {
  let score = 0;
  const lower = url.toLowerCase();
  if (lower.includes("brosur")) score += 10;
  if (lower.includes("katalog")) score += 10;
  if (lower.includes("afis")) score += 9;
  if (lower.includes("insert")) score += 9;
  if (lower.includes("campaign")) score += 8;
  if (lower.includes("aktuel")) score += 8;
  if (lower.includes("kampanya")) score += 7;
  if (lower.includes("flyer")) score += 7;
  if (lower.includes("page")) score += 5;
  if (lower.includes("sayfa")) score += 5;
  if (lower.match(/\d+\.jpg/)) score += 3;
  if (lower.includes("thumb") || lower.includes("small")) score -= 5;
  if (lower.includes("logo") || lower.includes("icon")) score -= 10;
  return score;
}

// ═══════════════════════════════════════════════════════════
// MODÜL 1: SPA / SSR HYDRATION VERİSİ ÇIKARMA
// ═══════════════════════════════════════════════════════════

function extractSPAData(html) {
  const spaData = [];

  const nextMatch = html.match(
    /<script\s+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i
  );
  if (nextMatch) {
    try {
      const data = JSON.parse(nextMatch[1]);
      spaData.push({ source: "Next.js (__NEXT_DATA__)", data });
    } catch {}
  }

  const nuxtMatch = html.match(
    /window\.__NUXT__\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/i
  );
  if (nuxtMatch) {
    try {
      const cleaned = nuxtMatch[1]
        .replace(/undefined/g, "null")
        .replace(/new Date\([^)]*\)/g, "null");
      const data = JSON.parse(cleaned);
      spaData.push({ source: "Nuxt.js (__NUXT__)", data });
    } catch {}
  }

  const statePatterns = [
    /window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/i,
    /window\.__PRELOADED_STATE__\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/i,
    /window\.__APP_STATE__\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/i,
    /window\.__STORE__\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/i,
    /window\.__DATA__\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/i,
  ];

  for (const pattern of statePatterns) {
    const match = html.match(pattern);
    if (match) {
      try {
        const data = JSON.parse(match[1]);
        spaData.push({ source: "Window State", data });
      } catch {}
    }
  }

  const scriptBlocks = html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi);
  for (const block of scriptBlocks) {
    const content = block[1].trim();
    const jsonPatterns = [
      /(?:var|let|const)\s+(\w*(?:product|item|data|catalog|listing|result)s?\w*)\s*=\s*(\[[\s\S]*?\]);/gi,
      /dataLayer\.push\((\{[\s\S]*?"ecommerce"[\s\S]*?\})\);?/gi,
      /(?:ecommerce|impressions|products)\s*:\s*(\[[\s\S]*?\])/gi,
    ];

    for (const pattern of jsonPatterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const jsonStr = match[match.length - 1];
        try {
          const data = JSON.parse(jsonStr);
          if (Array.isArray(data) && data.length > 0) {
            spaData.push({ source: `Inline JS (${match[1] || "ecommerce"})`, data });
          } else if (typeof data === "object") {
            spaData.push({ source: `Inline JS (${match[1] || "ecommerce"})`, data });
          }
        } catch {}
      }
    }
  }

  const dataLayerMatch = html.match(/var\s+dataLayer\s*=\s*(\[[\s\S]*?\]);/i);
  if (dataLayerMatch) {
    try {
      const data = JSON.parse(dataLayerMatch[1]);
      spaData.push({ source: "GTM dataLayer", data });
    } catch {}
  }

  return spaData;
}

// ═══════════════════════════════════════════════════════════
// MODÜL 2: API ENDPOINT KEŞFİ
// ═══════════════════════════════════════════════════════════

function discoverAPIEndpoints(html, baseUrl) {
  const endpoints = [];
  const seen = new Set();

  const apiPatterns = [
    /["'](\/api\/[^"'\s]+)["']/g,
    /["'](\/v[1-9]\/[^"'\s]+)["']/g,
    /["'](https?:\/\/[^"'\s]*\/api\/[^"'\s]+)["']/g,
    /["'](\/graphql[^"'\s]*)["']/g,
    /["'](\/[^"'\s]*(?:products?|urunler?|items?|catalog|kategori|category|search|listing)[^"'\s]*)["']/gi,
    /["'](https?:\/\/[^"'\s]*(?:cdn|media|static|assets)[^"'\s]*\.json[^"'\s]*)["']/gi,
    /["'](\/[^"'\s]*(?:brosur|afis|campaign|kampanya|aktuel)[^"'\s]*)["']/gi,
    /fetch\(["']([^"']+)["']/g,
    /axios\.(?:get|post)\(["']([^"']+)["']/g,
    /\.ajax\(\{[^}]*url\s*:\s*["']([^"']+)["']/g,
    /XMLHttpRequest[^]*?\.open\(["'][^"']*["']\s*,\s*["']([^"']+)["']/g,
  ];

  for (const pattern of apiPatterns) {
    let match;
    while ((match = pattern.exec(html)) !== null) {
      let url = match[1];
      if (url.startsWith("/")) {
        try {
          const base = new URL(baseUrl);
          url = base.origin + url;
        } catch {}
      }
      if (
        url.includes(".js") || url.includes(".css") ||
        url.includes(".png") || url.includes(".jpg") ||
        url.includes(".svg") || url.includes(".woff") ||
        url.includes("favicon")
      ) continue;
      if (!seen.has(url)) {
        seen.add(url);
        endpoints.push(url);
      }
    }
  }

  return endpoints;
}

// ═══════════════════════════════════════════════════════════
// MODÜL 3: API ÇAĞIRICI
// ═══════════════════════════════════════════════════════════

async function fetchAPIEndpoints(endpoints, baseUrl) {
  const results = [];
  const maxCalls = 5;

  const prioritized = endpoints.sort((a, b) => {
    return apiRelevanceScore(b) - apiRelevanceScore(a);
  });

  for (const endpoint of prioritized.slice(0, maxCalls)) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(endpoint, {
        headers: {
          ...BROWSER_HEADERS,
          Accept: "application/json, text/plain, */*",
          "X-Requested-With": "XMLHttpRequest",
          Referer: baseUrl,
        },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (res.status === 200) {
        const contentType = res.headers.get("content-type") || "";
        if (contentType.includes("json")) {
          const data = await res.json();
          results.push({ url: endpoint, data });
        }
      }
    } catch {}
  }

  return results;
}

function apiRelevanceScore(url) {
  let score = 0;
  const lower = url.toLowerCase();
  if (lower.includes("product")) score += 10;
  if (lower.includes("urun")) score += 10;
  if (lower.includes("catalog")) score += 8;
  if (lower.includes("category")) score += 7;
  if (lower.includes("kategori")) score += 7;
  if (lower.includes("listing")) score += 7;
  if (lower.includes("search")) score += 6;
  if (lower.includes("campaign")) score += 5;
  if (lower.includes("kampanya")) score += 5;
  if (lower.includes("brosur")) score += 9;
  if (lower.includes("afis")) score += 9;
  if (lower.includes("price")) score += 8;
  if (lower.includes("fiyat")) score += 8;
  if (lower.includes("discount")) score += 8;
  if (lower.includes("indirim")) score += 8;
  if (lower.includes(".json")) score += 3;
  if (lower.includes("/api/")) score += 4;
  return score;
}

// ═══════════════════════════════════════════════════════════
// MODÜL 4: GÖRSEL / BROŞÜR ÇIKARMA
// ═══════════════════════════════════════════════════════════

function extractImages(doc, baseUrl) {
  const images = [];
  const seen = new Set();

  doc.querySelectorAll("img").forEach((img) => {
    const src =
      img.getAttribute("data-src") ||
      img.getAttribute("data-lazy-src") ||
      img.getAttribute("data-original") ||
      img.getAttribute("data-lazy") ||
      img.getAttribute("data-echo") ||
      img.getAttribute("data-srcset")?.split(",")[0]?.trim()?.split(" ")[0] ||
      img.getAttribute("srcset")?.split(",")[0]?.trim()?.split(" ")[0] ||
      img.getAttribute("src");

    if (!src || seen.has(src)) return;

    const width = parseInt(img.getAttribute("width")) || 0;
    const height = parseInt(img.getAttribute("height")) || 0;
    if ((width > 0 && width < 50) || (height > 0 && height < 50)) return;
    if (src.includes("pixel") || src.includes("tracking") || src.includes("spacer")) return;
    if (src.startsWith("data:image/gif")) return;

    seen.add(src);

    let fullSrc = src;
    try { fullSrc = new URL(src, baseUrl).href; } catch {}

    const alt = img.getAttribute("alt") || "";
    const title = img.getAttribute("title") || "";

    let parentText = "";
    let parentLink = "";
    let parent = img.parentElement;
    for (let i = 0; i < 3 && parent; i++) {
      if (!parentText) {
        const text = parent.textContent?.trim().replace(/\s+/g, " ");
        if (text && text.length > 3 && text.length < 300) parentText = text;
      }
      if (!parentLink) {
        const link = parent.closest("a");
        if (link) parentLink = link.getAttribute("href") || "";
      }
      parent = parent.parentElement;
    }

    const dataAttrs = {};
    for (const attr of img.attributes) {
      if (attr.name.startsWith("data-") && attr.value) {
        dataAttrs[attr.name] = attr.value;
      }
    }

    images.push({
      src: fullSrc, alt, title,
      parentText: parentText.substring(0, 200),
      parentLink, dataAttrs,
      dimensions: width && height ? `${width}x${height}` : "",
    });
  });

  doc.querySelectorAll("[style]").forEach((el) => {
    const style = el.getAttribute("style") || "";
    const bgMatch = style.match(/background-image\s*:\s*url\(["']?([^"')]+)["']?\)/i);
    if (bgMatch && !seen.has(bgMatch[1])) {
      seen.add(bgMatch[1]);
      let fullSrc = bgMatch[1];
      try { fullSrc = new URL(bgMatch[1], baseUrl).href; } catch {}
      images.push({
        src: fullSrc, alt: "", title: "",
        parentText: el.textContent?.trim().substring(0, 200) || "",
        parentLink: "", dataAttrs: {}, dimensions: "", type: "background-image",
      });
    }
  });

  doc.querySelectorAll("picture source").forEach((source) => {
    const srcset = source.getAttribute("srcset");
    if (srcset) {
      const firstSrc = srcset.split(",")[0]?.trim()?.split(" ")[0];
      if (firstSrc && !seen.has(firstSrc)) {
        seen.add(firstSrc);
        let fullSrc = firstSrc;
        try { fullSrc = new URL(firstSrc, baseUrl).href; } catch {}
        images.push({
          src: fullSrc, alt: "", title: "", parentText: "",
          parentLink: "", dataAttrs: {}, dimensions: "", type: "picture-source",
        });
      }
    }
  });

  return images;
}

// ═══════════════════════════════════════════════════════════
// MODÜL 5: BROŞÜR/KAMPANYA SAYFASI ANALİZCİ
// ═══════════════════════════════════════════════════════════

function analyzeBrochurePage(doc, html, images, baseUrl) {
  const brochure = {
    isBrochure: false,
    images: [],
    campaigns: [],
    dateRanges: [],
  };

  const pageText = (doc.title || "") + " " + html.substring(0, 5000);
  const brochureKeywords = [
    "broşür", "brosur", "afiş", "afis", "aktüel", "aktuel",
    "aldın aldın", "aldin aldin", "kampanya", "insert",
    "haftalık", "haftalik", "katalog", "flyer",
  ];

  brochure.isBrochure = brochureKeywords.some((kw) =>
    pageText.toLowerCase().includes(kw)
  );

  if (!brochure.isBrochure) return brochure;

  brochure.images = images.filter((img) => {
    const src = img.src.toLowerCase();
    return (
      src.includes("brosur") || src.includes("afis") ||
      src.includes("insert") || src.includes("campaign") ||
      src.includes("katalog") || src.includes("aktuel") ||
      src.includes("flyer") ||
      (img.alt && brochureKeywords.some((kw) => img.alt.toLowerCase().includes(kw))) ||
      (src.includes("cdn") && (src.includes(".jpg") || src.includes(".webp")) &&
        !src.includes("logo") && !src.includes("icon"))
    );
  });

  const bodyText = doc.body?.textContent || "";
  const datePatterns = [
    /(\d{1,2})\s*[-–]\s*(\d{1,2})\s+(Ocak|Şubat|Mart|Nisan|Mayıs|Haziran|Temmuz|Ağustos|Eylül|Ekim|Kasım|Aralık)/gi,
    /(\d{1,2})\s+(Ocak|Şubat|Mart|Nisan|Mayıs|Haziran|Temmuz|Ağustos|Eylül|Ekim|Kasım|Aralık)[^]*?(?:itibaren|arası|tarihleri)/gi,
    /(\d{1,2}\.\d{1,2}\.\d{2,4})\s*[-–]\s*(\d{1,2}\.\d{1,2}\.\d{2,4})/g,
  ];

  for (const pattern of datePatterns) {
    let match;
    while ((match = pattern.exec(bodyText)) !== null) {
      brochure.dateRanges.push(match[0].trim());
    }
  }

  doc.querySelectorAll("a[href]").forEach((a) => {
    const href = a.getAttribute("href") || "";
    const text = a.textContent.trim();
    if (brochureKeywords.some((kw) =>
      href.toLowerCase().includes(kw) || text.toLowerCase().includes(kw)
    )) {
      let fullUrl = href;
      try { fullUrl = new URL(href, baseUrl).href; } catch {}
      brochure.campaigns.push({ text, url: fullUrl });
    }
  });

  return brochure;
}

// ═══════════════════════════════════════════════════════════
// MODÜL 6: DERİN ÜRÜN VERİSİ ÇIKARMA
// ═══════════════════════════════════════════════════════════

function extractProductsFromJSON(data, depth = 0) {
  if (depth > 8) return [];
  const products = [];

  if (Array.isArray(data)) {
    for (const item of data) {
      if (typeof item === "object" && item !== null) {
        if (isProductObject(item)) {
          products.push(normalizeProduct(item));
        } else {
          products.push(...extractProductsFromJSON(item, depth + 1));
        }
      }
    }
  } else if (typeof data === "object" && data !== null) {
    if (isProductObject(data)) products.push(normalizeProduct(data));
    for (const [, value] of Object.entries(data)) {
      if (typeof value === "object" && value !== null) {
        products.push(...extractProductsFromJSON(value, depth + 1));
      }
    }
  }

  const seen = new Set();
  return products.filter((p) => {
    const key = (p.name || "") + (p.sku || "") + (p.price || "");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isProductObject(obj) {
  const keys = Object.keys(obj).map((k) => k.toLowerCase());
  const productKeys = [
    "name", "title", "productname", "product_name", "urun_adi",
    "price", "fiyat", "saleprice", "listprice",
    "sku", "productid", "product_id", "barcode",
    "brand", "marka", "image", "imageurl", "img", "gorsel",
    "category", "kategori",
  ];
  let matchCount = 0;
  for (const pk of productKeys) {
    if (keys.includes(pk)) matchCount++;
  }
  return matchCount >= 2;
}

function normalizeProduct(obj) {
  const get = (...keys) => {
    for (const key of keys) {
      for (const [k, v] of Object.entries(obj)) {
        if (k.toLowerCase() === key.toLowerCase() && v != null && v !== "") {
          return typeof v === "object" ? JSON.stringify(v) : String(v);
        }
      }
    }
    return "";
  };

  return {
    name: get("name", "title", "productName", "product_name", "urun_adi", "urunAdi", "productTitle"),
    price: get("price", "salePrice", "sale_price", "fiyat", "currentPrice", "finalPrice", "discountedPrice"),
    oldPrice: get("oldPrice", "listPrice", "list_price", "originalPrice", "original_price", "retailPrice", "eskiFiyat", "marketPrice", "regularPrice"),
    discount: get("discount", "discountRate", "discount_rate", "discountPercentage", "indirim", "indirimOrani", "campaignDiscount"),
    brand: get("brand", "brandName", "brand_name", "marka"),
    sku: get("sku", "productId", "product_id", "id", "barcode", "itemCode"),
    category: get("category", "categoryName", "category_name", "kategori"),
    image: get("image", "imageUrl", "image_url", "img", "pictureUrl", "gorsel", "mainImage"),
    url: get("url", "link", "productUrl", "product_url", "slug", "seoUrl"),
    stock: get("stock", "inStock", "stockStatus", "availability", "stokDurumu"),
    rating: get("rating", "score", "puan"),
    color: get("color", "renk", "variant"),
  };
}

// ═══════════════════════════════════════════════════════════
// MODÜL 7: SİTE-SPESİFİK ADAPTÖRLER
// ═══════════════════════════════════════════════════════════

function getSiteAdapter(url) {
  const hostname = new URL(url).hostname;
  const adapters = {
    "www.a101.com.tr": {
      name: "A101",
      productCardSelector: ".product-card, .product-item, .js-product-card, [data-product-card]",
      priceSelector: ".current-price, .product-price-new, .price-new, .js-price",
      oldPriceSelector: ".old-price, .product-price-old, .price-old, .js-old-price",
      discountSelector: ".discount-badge, .discount-rate, .badge-discount, .js-discount",
      nameSelector: ".product-name, .product-title, .name a, h3 a, h2 a",
    },
    "www.trendyol.com": {
      name: "Trendyol",
      productCardSelector: ".p-card-wrppr, .product-card",
      priceSelector: ".prc-box-dscntd, .prc-box-sllng",
      oldPriceSelector: ".prc-box-orgnl",
      discountSelector: ".prc-box-dscntd-prcntg",
      nameSelector: ".prd-name, .product-name",
    },
    "www.hepsiburada.com": {
      name: "Hepsiburada",
      productCardSelector: "[data-test-id='product-card'], .product-card",
      priceSelector: "[data-test-id='price-current-price']",
      oldPriceSelector: "[data-test-id='price-old-price']",
      discountSelector: "[data-test-id='discount']",
      nameSelector: "[data-test-id='product-card-name'], h3",
    },
    "www.bim.com.tr": {
      name: "BİM",
      productCardSelector: ".product-card, .product-item",
      priceSelector: ".product-price, .price",
      oldPriceSelector: ".old-price",
      discountSelector: ".discount",
      nameSelector: ".product-name, .product-title",
    },
    "www.sokmarket.com.tr": {
      name: "ŞOK",
      productCardSelector: ".product-card, .product-item",
      priceSelector: ".product-price, .price-new",
      oldPriceSelector: ".price-old",
      discountSelector: ".discount-badge",
      nameSelector: ".product-name",
    },
    "www.migros.com.tr": {
      name: "Migros",
      productCardSelector: ".product-card, [data-monitor-product]",
      priceSelector: ".product-price, .price",
      oldPriceSelector: ".old-price, .strike-price",
      discountSelector: ".discount-badge, .campaign-badge",
      nameSelector: ".product-name, .product-title",
    },
    "www.n11.com": {
      name: "n11",
      productCardSelector: ".columnContent, .product-card",
      priceSelector: ".newPrice, .price ins",
      oldPriceSelector: ".oldPrice, .price del",
      discountSelector: ".discountPercentage",
      nameSelector: ".productName, h3 a",
    },
  };
  return adapters[hostname] || null;
}

function extractWithAdapter(doc, adapter) {
  const products = [];
  const cards = doc.querySelectorAll(adapter.productCardSelector);
  cards.forEach((card) => {
    const product = {};
    const nameEl = card.querySelector(adapter.nameSelector);
    if (nameEl) product.name = nameEl.getAttribute("title") || nameEl.textContent.trim();
    const priceEl = card.querySelector(adapter.priceSelector);
    if (priceEl) product.price = priceEl.getAttribute("data-price") || priceEl.getAttribute("content") || priceEl.textContent.trim();
    const oldPriceEl = card.querySelector(adapter.oldPriceSelector);
    if (oldPriceEl) product.oldPrice = oldPriceEl.textContent.trim();
    const discountEl = card.querySelector(adapter.discountSelector);
    if (discountEl) product.discount = discountEl.textContent.trim();
    const linkEl = card.querySelector("a[href]");
    if (linkEl) product.url = linkEl.getAttribute("href");
    const imgEl = card.querySelector("img");
    if (imgEl) product.image = imgEl.getAttribute("data-src") || imgEl.getAttribute("data-lazy-src") || imgEl.getAttribute("src");
    if (product.name || product.price) products.push(product);
  });
  return products;
}

// ═══════════════════════════════════════════════════════════
// STRUCTURED DATA, PRODUCT CARDS, TABLES, LINKS, HEADINGS,
// LISTS, FILTERS, CLEAN TEXT
// ═══════════════════════════════════════════════════════════

function extractStructuredData(doc) {
  const results = [];
  doc.querySelectorAll('script[type="application/ld+json"]').forEach((el) => {
    try { results.push({ type: "json-ld", data: JSON.parse(el.textContent) }); } catch {}
  });
  const og = {};
  doc.querySelectorAll('meta[property^="og:"]').forEach((el) => {
    const key = el.getAttribute("property");
    const val = el.getAttribute("content");
    if (key && val) og[key] = val;
  });
  if (Object.keys(og).length > 0) results.push({ type: "opengraph", data: og });
  const meta = {};
  ["description", "keywords", "author", "robots"].forEach((name) => {
    const el = doc.querySelector(`meta[name="${name}"]`);
    if (el) meta[name] = el.getAttribute("content");
  });
  if (Object.keys(meta).length > 0) results.push({ type: "meta", data: meta });
  const title = doc.querySelector("title");
  if (title) results.push({ type: "title", data: title.textContent.trim() });
  const canonical = doc.querySelector('link[rel="canonical"]');
  if (canonical) results.push({ type: "canonical", data: canonical.getAttribute("href") });
  return results;
}

function extractProductCards(doc, adapter = null) {
  if (adapter) {
    const adapterProducts = extractWithAdapter(doc, adapter);
    if (adapterProducts.length > 0) return adapterProducts;
  }

  const products = [];
  const cardSelectors = [
    "[data-product]", "[data-product-id]", "[data-productid]",
    ".product-card", ".product-item", ".product", ".urun",
    ".card-product", '[itemtype*="Product"]', '[data-testid*="product"]',
    ".product-box", ".prd", ".item-card", "li[data-sku]",
    ".catalog-product", ".p-card", ".product-list-item",
    "[data-product-card]", ".js-product-card", ".product-wrapper",
    ".product-container", ".product-tile", ".product-grid-item",
    ".plp-product", ".search-result-item", ".listing-item",
    ".category-product", "[data-component='product']",
    "[data-qa='product-card']", ".col-product", ".grid-product",
  ];

  let cards = [];
  for (const sel of cardSelectors) {
    cards = doc.querySelectorAll(sel);
    if (cards.length > 0) break;
  }

  if (cards.length === 0) {
    const priceEls = doc.querySelectorAll('[class*="price"], [class*="fiyat"], [data-price]');
    const parentSet = new Set();
    priceEls.forEach((el) => {
      let parent = el.parentElement;
      for (let i = 0; i < 4 && parent; i++) {
        if (parent.querySelector("a") && parent.textContent.trim().length < 500) {
          parentSet.add(parent); break;
        }
        parent = parent.parentElement;
      }
    });
    cards = Array.from(parentSet);
  }

  cards.forEach((card) => {
    const product = {};
    const nameEl =
      card.querySelector("[data-product-name]") || card.querySelector("[data-name]") ||
      card.querySelector(".product-name") || card.querySelector(".product-title") ||
      card.querySelector(".prd-name") || card.querySelector(".name") ||
      card.querySelector("h2") || card.querySelector("h3") ||
      card.querySelector("h4") || card.querySelector("a[title]");
    if (nameEl) {
      product.name = nameEl.getAttribute("data-product-name") || nameEl.getAttribute("data-name") ||
        nameEl.getAttribute("title") || nameEl.textContent.trim();
    }

    const allText = card.textContent;
    const priceRegex = /[₺€$]?\s*[\d.,]+\s*(?:₺|TL|€|\$)/g;
    const allPrices = allText.match(priceRegex) || [];

    const priceSelectors = [
      ".price", ".product-price", ".prd-price", ".current-price",
      ".sale-price", ".discounted-price", "[data-price]", ".price-new",
      ".price-current", ".amount", ".final-price", ".price-sale",
      ".special-price", ".promo-price", ".js-price",
      "[data-sale-price]", "[data-current-price]",
    ];
    const oldPriceSelectors = [
      ".old-price", ".original-price", ".price-old", ".list-price",
      ".line-through", "del", "s", ".price-regular", ".strikethrough",
      ".retail-price", ".was-price", ".price-was", ".crossed-price",
      ".market-price", "[data-old-price]", "[data-list-price]", ".js-old-price",
    ];
    const discountSelectors = [
      ".discount", ".badge-discount", ".discount-rate", ".discount-badge",
      ".campaign-badge", ".prd-discount", ".sale-badge", ".discount-percentage",
      ".save-percent", ".promo-badge", ".campaign-discount", "[data-discount]",
      ".js-discount", ".percent-off", ".savings",
    ];

    for (const sel of priceSelectors) {
      const el = card.querySelector(sel);
      if (el) { product.price = el.getAttribute("data-price") || el.textContent.trim(); break; }
    }
    for (const sel of oldPriceSelectors) {
      const el = card.querySelector(sel);
      if (el) { product.oldPrice = el.textContent.trim(); break; }
    }
    for (const sel of discountSelectors) {
      const el = card.querySelector(sel);
      if (el) { product.discount = el.textContent.trim(); break; }
    }

    if (!product.price && allPrices.length > 0) {
      if (allPrices.length >= 2) {
        product.oldPrice = allPrices[0].trim();
        product.price = allPrices[allPrices.length - 1].trim();
      } else {
        product.price = allPrices[0].trim();
      }
    }

    const linkEl = card.querySelector("a[href]");
    if (linkEl) product.url = linkEl.getAttribute("href");
    const imgEl = card.querySelector("img");
    if (imgEl) {
      product.image = imgEl.getAttribute("data-src") || imgEl.getAttribute("data-lazy-src") ||
        imgEl.getAttribute("src") || imgEl.getAttribute("data-lazy");
    }

    const badges = card.querySelectorAll(".badge, .tag, .label, .stock, .variant");
    const badgeTexts = [];
    badges.forEach((b) => { const t = b.textContent.trim(); if (t.length > 0 && t.length < 50) badgeTexts.push(t); });
    if (badgeTexts.length > 0) product.badges = badgeTexts.join(", ");

    ["data-product-id", "data-sku", "data-brand", "data-category", "data-variant", "data-stock", "data-rating"].forEach((attr) => {
      const val = card.getAttribute(attr);
      if (val) product[attr.replace("data-", "")] = val;
    });

    if (product.name || product.price) products.push(product);
  });

  return products;
}

function extractTables(doc) {
  const tables = [];
  doc.querySelectorAll("table").forEach((table) => {
    const rows = [];
    table.querySelectorAll("tr").forEach((tr) => {
      const cells = [];
      tr.querySelectorAll("th, td").forEach((cell) => cells.push(cell.textContent.trim()));
      if (cells.length > 0) rows.push(cells);
    });
    if (rows.length > 0 && rows.length < 200) tables.push(rows);
  });
  return tables;
}

function extractLinks(doc, baseUrl) {
  const links = [];
  const seen = new Set();
  doc.querySelectorAll("a[href]").forEach((a) => {
    const href = a.getAttribute("href");
    const text = a.textContent.trim().substring(0, 120);
    if (!href || href === "#" || href.startsWith("javascript:")) return;
    if (text.length < 2) return;
    let fullUrl = href;
    try { fullUrl = new URL(href, baseUrl).href; } catch {}
    if (!seen.has(fullUrl)) { seen.add(fullUrl); links.push({ text, url: fullUrl }); }
  });
  return links;
}

function extractHeadings(doc) {
  const headings = [];
  doc.querySelectorAll("h1, h2, h3, h4").forEach((h) => {
    const text = h.textContent.trim().replace(/\s+/g, " ");
    if (text.length > 0 && text.length < 200) headings.push({ level: h.tagName, text });
  });
  return headings;
}

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

function extractFilters(doc) {
  const filters = [];
  doc.querySelectorAll("select").forEach((select) => {
    const name = select.getAttribute("name") || select.getAttribute("id") || select.getAttribute("aria-label") || "";
    const options = [];
    select.querySelectorAll("option").forEach((opt) => {
      const text = opt.textContent.trim();
      const value = opt.getAttribute("value");
      if (text && value && value !== "") options.push(text);
    });
    if (options.length > 0) filters.push({ name, options });
  });
  doc.querySelectorAll(".filter-group, .facet, [data-filter], .filter-section, .refinement").forEach((group) => {
    const title = group.querySelector("h3, h4, .title, .filter-title, legend");
    const name = title ? title.textContent.trim() : "";
    const options = [];
    group.querySelectorAll("label, .filter-option, .facet-value").forEach((opt) => {
      const text = opt.textContent.trim().replace(/\s+/g, " ");
      if (text.length > 0 && text.length < 100) options.push(text);
    });
    if (options.length > 0 && name) filters.push({ name, options });
  });
  return filters;
}

function extractCleanText(doc) {
  const clone = doc.cloneNode(true);
  ["script", "style", "nav", "footer", "header", "aside", "iframe", "noscript", "svg", "video", "audio",
    ".cookie-banner", ".popup", ".modal", ".overlay", '[aria-hidden="true"]', ".advertisement", ".ad-container"
  ].forEach((sel) => { clone.querySelectorAll(sel).forEach((el) => el.remove()); });

  const main = clone.querySelector("article") || clone.querySelector("main") ||
    clone.querySelector('[role="main"]') || clone.querySelector("#content") ||
    clone.querySelector(".content") || clone.querySelector(".main-content") || clone.body;
  if (!main) return "";
  let text = main.textContent || "";
  text = text.replace(/\s+/g, " ").replace(/\n\s*\n/g, "\n").trim();
  return text;
}

// ═══════════════════════════════════════════════════════════
// MASTER EXTRACTOR — OCR ENTEGRELİ
// ═══════════════════════════════════════════════════════════

async function extractAllData(html, url) {
  const dom = new JSDOM(html, { url });
  const doc = dom.window.document;

  const adapter = getSiteAdapter(url);
  const structured = extractStructuredData(doc);
  const tables = extractTables(doc);
  const headings = extractHeadings(doc);
  const links = extractLinks(doc, url);
  const lists = extractLists(doc);
  const filters = extractFilters(doc);
  const cleanText = extractCleanText(doc);

  const spaData = extractSPAData(html);
  const images = extractImages(doc, url);
  const brochure = analyzeBrochurePage(doc, html, images, url);
  const apiEndpoints = discoverAPIEndpoints(html, url);

  // Ürün çıkarma — çoklu strateji
  let products = extractProductCards(doc, adapter);

  let spaProducts = [];
  if (spaData.length > 0) {
    for (const spa of spaData) {
      spaProducts.push(...extractProductsFromJSON(spa.data));
    }
  }

  let jsonLdProducts = [];
  const jsonLdData = structured.filter((s) => s.type === "json-ld");
  for (const jld of jsonLdData) {
    jsonLdProducts.push(...extractProductsFromJSON(jld.data));
  }

  let apiProducts = [];
  let apiResults = [];
  if (products.length === 0 && spaProducts.length === 0 && apiEndpoints.length > 0) {
    try {
      apiResults = await fetchAPIEndpoints(apiEndpoints, url);
      for (const result of apiResults) {
        apiProducts.push(...extractProductsFromJSON(result.data));
      }
    } catch {}
  }

  // ═══════════════════════════════════════════════════════
  // 🆕 STRATEJİ 5: GÖRSEL OCR
  // ═══════════════════════════════════════════════════════
  let ocrProducts = [];
  let ocrResults = [];

  const totalProductsFound = products.length + spaProducts.length + jsonLdProducts.length + apiProducts.length;

  if (brochure.isBrochure && totalProductsFound === 0 && brochure.images.length > 0) {
    console.log("🔍 Broşür görselleri OCR ile taranıyor... (" + brochure.images.length + " görsel)");
    try {
      ocrResults = await batchOCRImages(brochure.images, url, 10);
      for (const ocr of ocrResults) {
        if (ocr.text) {
          ocrProducts.push(...extractProductsFromOCR(ocr.text));
        }
      }
    } catch (err) {
      console.log("⚠️ OCR hatası: " + err.message);
    }
  }

  // En iyi ürün listesini seç
  const allProductSources = [
    { name: "HTML Cards", products },
    { name: "SPA Hydration", products: spaProducts },
    { name: "JSON-LD", products: jsonLdProducts },
    { name: "API", products: apiProducts },
    { name: "Görsel OCR", products: ocrProducts },
  ];

  const bestSource = allProductSources.reduce((best, current) =>
    current.products.length > best.products.length ? current : best
  );

  // ═══════════════════════════════════════════════════════
  // Çıktı oluşturma
  // ═══════════════════════════════════════════════════════

  const sections = [];

  const titleData = structured.find((s) => s.type === "title");
  if (titleData) sections.push("📄 SAYFA: " + titleData.data);
  const canonicalData = structured.find((s) => s.type === "canonical");
  if (canonicalData) sections.push("🔗 URL: " + canonicalData.data);
  const metaData = structured.find((s) => s.type === "meta");
  if (metaData?.data?.description) sections.push("📝 AÇIKLAMA: " + metaData.data.description);
  if (adapter) sections.push("🏪 TANINAN SİTE: " + adapter.name);

  // ── Broşür Analizi ──
  if (brochure.isBrochure) {
    sections.push("\n📰 BROŞÜR SAYFASI TESPİT EDİLDİ");
    sections.push("─".repeat(60));

    if (brochure.dateRanges.length > 0) {
      sections.push("📅 Tarih Aralıkları:");
      brochure.dateRanges.forEach((d) => sections.push("  • " + d));
    }

    if (brochure.campaigns.length > 0) {
      sections.push("📋 Kampanya Linkleri:");
      brochure.campaigns.forEach((c) => sections.push("  • " + c.text + " → " + c.url));
    }

    if (brochure.images.length > 0) {
      sections.push("🖼️ Broşür Görselleri (" + brochure.images.length + " adet):");
      brochure.images.forEach((img, i) => {
        sections.push("  " + (i + 1) + ". " + img.src);
        if (img.alt) sections.push("     Alt: " + img.alt);
        if (img.parentText) sections.push("     Bağlam: " + img.parentText);
      });
    }

    // 🆕 OCR Sonuçları
    if (ocrResults.length > 0) {
      sections.push("\n🔤 GÖRSEL OCR SONUÇLARI (" + ocrResults.length + " görsel tarandı):");
      sections.push("─".repeat(60));

      ocrResults.forEach((ocr, i) => {
        sections.push("\n📷 Görsel " + (i + 1) + ": " + ocr.url);
        sections.push("   Boyut: " + ocr.width + "x" + ocr.height);
        if (ocr.error) {
          sections.push("   ⚠️ Hata: " + ocr.error);
        } else if (ocr.text) {
          sections.push("   📝 OCR Metni:");
          const ocrLines = ocr.text.substring(0, 2000).split("\n");
          ocrLines.forEach((line) => {
            if (line.trim()) sections.push("   │ " + line.trim());
          });

          const prices = extractPricesFromOCR(ocr.text);
          if (prices.length > 0) {
            sections.push("   💰 Tespit Edilen Fiyatlar: " + prices.join(", "));
          }
        }
      });
    } else if (brochure.images.length > 0 && totalProductsFound === 0) {
      sections.push("\n⚠️ NOT: Broşür içeriği görsel formatındadır.");
      sections.push("   OCR modülü görselleri taradı ancak metin çıkaramadı.");
    }
  }

  // ── JSON-LD ──
  if (jsonLdData.length > 0) {
    sections.push("\n📊 YAPISAL VERİ (JSON-LD):");
    jsonLdData.forEach((jld) => {
      sections.push(JSON.stringify(jld.data, null, 2).substring(0, 5000));
    });
  }

  // ── SPA Verisi ──
  if (spaData.length > 0) {
    sections.push("\n⚡ SPA/SSR VERİSİ BULUNDU:");
    spaData.forEach((spa) => {
      sections.push("  Kaynak: " + spa.source);
      sections.push("  Önizleme: " + JSON.stringify(spa.data).substring(0, 1000) + "...");
    });
  }

  // ── Ürün Listesi ──
  if (bestSource.products.length > 0) {
    sections.push("\n🛒 ÜRÜNLER (" + bestSource.products.length + " adet — Kaynak: " + bestSource.name + "):");
    sections.push("─".repeat(60));
    bestSource.products.forEach((p, i) => {
      let line = (i + 1) + ". ";
      if (p.name) line += "📦 " + p.name;
      if (p.brand) line += "\n   🏷️ Marka: " + p.brand;
      if (p.oldPrice) line += "\n   💰 Eski Fiyat: " + p.oldPrice;
      if (p.price) line += "\n   🏷️ Fiyat: " + p.price;
      if (p.discount) line += "\n   🔥 İndirim: " + p.discount;
      if (p.category) line += "\n   📁 Kategori: " + p.category;
      if (p.stock) line += "\n   📦 Stok: " + p.stock;
      if (p.badges) line += "\n   🏅 Etiketler: " + p.badges;
      if (p.url) line += "\n   🔗 Link: " + p.url;
      if (p.image) line += "\n   🖼️ Görsel: " + p.image;
      sections.push(line);
      sections.push("─".repeat(60));
    });
  }

  // ── API Keşfi ──
  if (apiEndpoints.length > 0) {
    sections.push("\n🔌 KEŞFEDİLEN API ENDPOINT'LERİ (" + apiEndpoints.length + " adet):");
    apiEndpoints.slice(0, 20).forEach((ep) => sections.push("  • " + ep));
  }
  if (apiResults.length > 0) {
    sections.push("\n📡 API YANITLARI:");
    apiResults.forEach((r) => {
      sections.push("  URL: " + r.url);
      sections.push("  Veri: " + JSON.stringify(r.data).substring(0, 2000));
    });
  }

  // ── Görseller ──
  const meaningfulImages = images.filter((img) =>
    img.alt || img.parentText || Object.keys(img.dataAttrs).length > 0
  );
  if (meaningfulImages.length > 0) {
    sections.push("\n🖼️ GÖRSELLER (" + meaningfulImages.length + " anlamlı görsel):");
    meaningfulImages.slice(0, 30).forEach((img, i) => {
      let line = "  " + (i + 1) + ". " + img.src;
      if (img.alt) line += "\n     Alt: " + img.alt;
      if (img.title) line += " | Title: " + img.title;
      if (img.parentText && img.parentText !== img.alt) line += "\n     Bağlam: " + img.parentText;
      if (img.parentLink) line += "\n     Link: " + img.parentLink;
      if (Object.keys(img.dataAttrs).length > 0) line += "\n     Data: " + JSON.stringify(img.dataAttrs);
      sections.push(line);
    });
  }

  // ── Tablolar ──
  if (tables.length > 0) {
    sections.push("\n📋 TABLOLAR:");
    tables.forEach((table, ti) => {
      sections.push("Tablo " + (ti + 1) + ":");
      table.forEach((row) => sections.push("  | " + row.join(" | ") + " |"));
    });
  }

  // ── Başlıklar ──
  if (headings.length > 0) {
    sections.push("\n📌 BAŞLIKLAR:");
    headings.forEach((h) => {
      const prefix = h.level === "H1" ? "# " : h.level === "H2" ? "## " : h.level === "H3" ? "### " : "#### ";
      sections.push(prefix + h.text);
    });
  }

  // ── Filtreler ──
  if (filters.length > 0) {
    sections.push("\n🔍 FİLTRELER / KATEGORİLER:");
    filters.forEach((f) => sections.push("  " + f.name + ": " + f.options.join(", ")));
  }

  // ── Listeler ──
  if (lists.length > 0 && lists.length <= 15) {
    sections.push("\n📃 LİSTELER:");
    lists.slice(0, 10).forEach((list) => {
      list.forEach((item) => sections.push("  • " + item));
      sections.push("");
    });
  }

  // ── Linkler ──
  const contentLinks = links.filter((l) =>
    l.text.length > 3 && !l.url.includes("login") &&
    !l.url.includes("register") && !l.url.includes("javascript") && !l.url.endsWith("#")
  );
  if (contentLinks.length > 0) {
    sections.push("\n🔗 LİNKLER (" + Math.min(contentLinks.length, 50) + " adet):");
    contentLinks.slice(0, 50).forEach((l) => sections.push("  " + l.text + " → " + l.url));
  }

  // ── Clean Text (fallback) ──
  if (
    bestSource.products.length === 0 && tables.length === 0 &&
    jsonLdData.length === 0 && spaData.length === 0 &&
    !brochure.isBrochure && ocrResults.length === 0
  ) {
    sections.push("\n📄 SAYFA İÇERİĞİ:");
    sections.push(cleanText.substring(0, 12000));
  }

  // ── Veri Kalitesi Özeti ──
  sections.push("\n" + "═".repeat(60));
  sections.push("📊 VERİ KALİTESİ ÖZETİ:");
  sections.push("═".repeat(60));
  sections.push("  Ürün (HTML kartları): " + products.length);
  sections.push("  Ürün (SPA/SSR verisi): " + spaProducts.length);
  sections.push("  Ürün (JSON-LD): " + jsonLdProducts.length);
  sections.push("  Ürün (API): " + apiProducts.length);
  sections.push("  Ürün (Görsel OCR): " + ocrProducts.length);
  sections.push("  En iyi kaynak: " + bestSource.name + " (" + bestSource.products.length + " ürün)");
  sections.push("  Görseller: " + images.length + " (anlamlı: " + meaningfulImages.length + ")");
  sections.push("  OCR taranan: " + ocrResults.length + " görsel");
  sections.push("  API endpoint: " + apiEndpoints.length);
  sections.push("  SPA veri kaynağı: " + spaData.length);
  sections.push("  Broşür sayfası: " + (brochure.isBrochure ? "EVET" : "HAYIR"));
  if (adapter) sections.push("  Site adaptörü: " + adapter.name);

  return sections.join("\n");
}

// ═══════════════════════════════════════════════════════════
// CLOUDFLARE DETECTION
// ═══════════════════════════════════════════════════════════

function isCloudflareBlock(text, status) {
  if (status === 403 || status === 503) return true;
  const cfSignals = [
    "cf-browser-verification", "cloudflare", "cf_clearance",
    "challenge-platform", "Just a moment", "Checking your browser",
    "Enable JavaScript and cookies",
  ];
  return cfSignals.some((s) => text.toLowerCase().includes(s.toLowerCase()));
}

// ═══════════════════════════════════════════════════════════
// FETCH STRATEGIES
// ═══════════════════════════════════════════════════════════

async function directFetch(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, { headers: BROWSER_HEADERS, redirect: "follow", signal: controller.signal });
    const html = await res.text();
    clearTimeout(timeout);
    if (isCloudflareBlock(html, res.status)) return null;
    return { html, status: res.status };
  } catch (err) { clearTimeout(timeout); throw err; }
}

async function googleCacheFetch(url) {
  const cacheUrl = `https://webcache.googleusercontent.com/search?q=cache:${encodeURIComponent(url)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(cacheUrl, { headers: BROWSER_HEADERS, redirect: "follow", signal: controller.signal });
    clearTimeout(timeout);
    if (res.status !== 200) return null;
    const html = await res.text();
    if (isCloudflareBlock(html, res.status)) return null;
    return { html, status: res.status };
  } catch (err) { clearTimeout(timeout); throw err; }
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
    const res = await fetch(snapshotUrl, { headers: BROWSER_HEADERS, redirect: "follow" });
    const html = await res.text();
    return { html, status: res.status, note: `(Archive.org: ${data.archived_snapshots.closest.timestamp})` };
  } catch (err) { clearTimeout(timeout); throw err; }
}

async function proxyFetch(url) {
  const proxyUrl = `https://12ft.io/api/proxy?q=${encodeURIComponent(url)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(proxyUrl, { headers: BROWSER_HEADERS, redirect: "follow", signal: controller.signal });
    clearTimeout(timeout);
    if (res.status !== 200) return null;
    const html = await res.text();
    if (isCloudflareBlock(html, res.status)) return null;
    return { html, status: res.status };
  } catch (err) { clearTimeout(timeout); throw err; }
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
        const extracted = await extractAllData(result.html, url);
        const note = result.note || "";
        const finalText = extracted.substring(0, 35000);

        console.log(`✅ Success via ${strategy.name} (${finalText.length} chars)`);

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
