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
// 🆕 YENİ MODÜL 1: SPA / SSR HYDRATION VERİSİ ÇIKARMA
// ═══════════════════════════════════════════════════════════
// Next.js, Nuxt.js, React SSR gibi frameworkler sayfa HTML'ine
// tüm ürün verisini gömülü JSON olarak ekler. Bu fonksiyon
// o veriyi bulup parse eder.

function extractSPAData(html) {
  const spaData = [];

  // ── Next.js (__NEXT_DATA__) ──
  const nextMatch = html.match(
    /<script\s+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i
  );
  if (nextMatch) {
    try {
      const data = JSON.parse(nextMatch[1]);
      spaData.push({ source: "Next.js (__NEXT_DATA__)", data });
    } catch {}
  }

  // ── Nuxt.js (__NUXT__ / __NUXT_DATA__) ──
  const nuxtMatch = html.match(
    /window\.__NUXT__\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/i
  );
  if (nuxtMatch) {
    try {
      // Nuxt bazen JS fonksiyonları içerir, güvenli parse
      const cleaned = nuxtMatch[1]
        .replace(/undefined/g, "null")
        .replace(/new Date\([^)]*\)/g, "null");
      const data = JSON.parse(cleaned);
      spaData.push({ source: "Nuxt.js (__NUXT__)", data });
    } catch {}
  }

  // ── Generic window.__INITIAL_STATE__ (Vuex, Redux SSR) ──
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

  // ── Inline JSON veri blokları (genel) ──
  // Bazı siteler <script> içinde büyük JSON dizileri gömer
  const scriptBlocks = html.matchAll(
    /<script[^>]*>([\s\S]*?)<\/script>/gi
  );
  for (const block of scriptBlocks) {
    const content = block[1].trim();

    // Büyük JSON array veya object içeren script blokları
    const jsonPatterns = [
      // var products = [...] veya var items = [...]
      /(?:var|let|const)\s+(\w*(?:product|item|data|catalog|listing|result)s?\w*)\s*=\s*(\[[\s\S]*?\]);/gi,
      // dataLayer.push({ecommerce: ...})
      /dataLayer\.push\((\{[\s\S]*?"ecommerce"[\s\S]*?\})\);?/gi,
      // Google Tag Manager ecommerce
      /(?:ecommerce|impressions|products)\s*:\s*(\[[\s\S]*?\])/gi,
    ];

    for (const pattern of jsonPatterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const jsonStr = match[match.length - 1]; // Son yakalama grubu
        try {
          const data = JSON.parse(jsonStr);
          if (Array.isArray(data) && data.length > 0) {
            spaData.push({
              source: `Inline JS (${match[1] || "ecommerce"})`,
              data,
            });
          } else if (typeof data === "object") {
            spaData.push({
              source: `Inline JS (${match[1] || "ecommerce"})`,
              data,
            });
          }
        } catch {}
      }
    }
  }

  // ── GTM dataLayer ──
  const dataLayerMatch = html.match(
    /var\s+dataLayer\s*=\s*(\[[\s\S]*?\]);/i
  );
  if (dataLayerMatch) {
    try {
      const data = JSON.parse(dataLayerMatch[1]);
      spaData.push({ source: "GTM dataLayer", data });
    } catch {}
  }

  return spaData;
}

// ═══════════════════════════════════════════════════════════
// 🆕 YENİ MODÜL 2: API ENDPOINT KEŞFİ
// ═══════════════════════════════════════════════════════════
// Sayfa HTML/JS içindeki API URL'lerini bulur ve otomatik çağırır.

function discoverAPIEndpoints(html, baseUrl) {
  const endpoints = [];
  const seen = new Set();

  // Yaygın API URL pattern'leri
  const apiPatterns = [
    // REST API endpoints
    /["'](\/api\/[^"'\s]+)["']/g,
    /["'](\/v[1-9]\/[^"'\s]+)["']/g,
    /["'](https?:\/\/[^"'\s]*\/api\/[^"'\s]+)["']/g,

    // GraphQL endpoints
    /["'](\/graphql[^"'\s]*)["']/g,

    // Ürün/Kategori API'leri (Türk e-ticaret siteleri)
    /["'](\/[^"'\s]*(?:products?|urunler?|items?|catalog|kategori|category|search|listing)[^"'\s]*)["']/gi,

    // CDN / Media API'leri
    /["'](https?:\/\/[^"'\s]*(?:cdn|media|static|assets)[^"'\s]*\.json[^"'\s]*)["']/gi,

    // A101 spesifik
    /["'](\/[^"'\s]*(?:brosur|afis|campaign|kampanya|aktuel)[^"'\s]*)["']/gi,

    // Fetch/XHR çağrıları
    /fetch\(["']([^"']+)["']/g,
    /axios\.(?:get|post)\(["']([^"']+)["']/g,
    /\.ajax\(\{[^}]*url\s*:\s*["']([^"']+)["']/g,
    /XMLHttpRequest[^]*?\.open\(["'][^"']*["']\s*,\s*["']([^"']+)["']/g,
  ];

  for (const pattern of apiPatterns) {
    let match;
    while ((match = pattern.exec(html)) !== null) {
      let url = match[1];

      // Göreceli URL'yi mutlak yap
      if (url.startsWith("/")) {
        try {
          const base = new URL(baseUrl);
          url = base.origin + url;
        } catch {}
      }

      // Filtreleme
      if (
        url.includes(".js") ||
        url.includes(".css") ||
        url.includes(".png") ||
        url.includes(".jpg") ||
        url.includes(".svg") ||
        url.includes(".woff") ||
        url.includes("favicon")
      )
        continue;

      if (!seen.has(url)) {
        seen.add(url);
        endpoints.push(url);
      }
    }
  }

  return endpoints;
}

// ═══════════════════════════════════════════════════════════
// 🆕 YENİ MODÜL 3: API ÇAĞIRICI
// ═══════════════════════════════════════════════════════════
// Keşfedilen API endpoint'lerini çağırıp JSON veri çeker.

async function fetchAPIEndpoints(endpoints, baseUrl) {
  const results = [];
  const maxCalls = 5; // Çok fazla çağrı yapmayı önle

  // Ürün/kategori API'lerine öncelik ver
  const prioritized = endpoints.sort((a, b) => {
    const scoreA = apiRelevanceScore(a);
    const scoreB = apiRelevanceScore(b);
    return scoreB - scoreA;
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
// 🆕 YENİ MODÜL 4: GÖRSEL / BROŞÜR ÇIKARMA
// ═══════════════════════════════════════════════════════════
// Broşür sayfalarındaki görselleri meta verileriyle birlikte çıkarır.
// Alt text, title, data attribute'lar ve dosya adından bilgi çeker.

function extractImages(doc, baseUrl) {
  const images = [];
  const seen = new Set();

  // Tüm img elementleri
  doc.querySelectorAll("img").forEach((img) => {
    const src =
      img.getAttribute("data-src") ||
      img.getAttribute("data-lazy-src") ||
      img.getAttribute("data-original") ||
      img.getAttribute("data-lazy") ||
      img.getAttribute("data-srcset")?.split(",")[0]?.trim()?.split(" ")[0] ||
      img.getAttribute("srcset")?.split(",")[0]?.trim()?.split(" ")[0] ||
      img.getAttribute("src");

    if (!src || seen.has(src)) return;

    // Çok küçük görselleri, ikonları, tracking pixelleri atla
    const width = parseInt(img.getAttribute("width")) || 0;
    const height = parseInt(img.getAttribute("height")) || 0;
    if ((width > 0 && width < 50) || (height > 0 && height < 50)) return;
    if (src.includes("pixel") || src.includes("tracking") || src.includes("spacer")) return;
    if (src.startsWith("data:image/gif")) return; // 1px placeholder

    seen.add(src);

    let fullSrc = src;
    try {
      fullSrc = new URL(src, baseUrl).href;
    } catch {}

    const alt = img.getAttribute("alt") || "";
    const title = img.getAttribute("title") || "";

    // Parent element'ten ek bilgi çıkar
    let parentText = "";
    let parentLink = "";
    let parent = img.parentElement;
    for (let i = 0; i < 3 && parent; i++) {
      if (!parentText) {
        const text = parent.textContent?.trim().replace(/\s+/g, " ");
        if (text && text.length > 3 && text.length < 300) {
          parentText = text;
        }
      }
      if (!parentLink) {
        const link = parent.closest("a");
        if (link) parentLink = link.getAttribute("href") || "";
      }
      parent = parent.parentElement;
    }

    // Data attribute'lardan ek bilgi
    const dataAttrs = {};
    for (const attr of img.attributes) {
      if (attr.name.startsWith("data-") && attr.value) {
        dataAttrs[attr.name] = attr.value;
      }
    }

    // Dosya adından bilgi çıkarma
    let fileInfo = "";
    try {
      const pathname = new URL(fullSrc).pathname;
      const filename = pathname.split("/").pop();
      fileInfo = decodeURIComponent(filename);
    } catch {}

    images.push({
      src: fullSrc,
      alt,
      title,
      fileInfo,
      parentText: parentText.substring(0, 200),
      parentLink,
      dataAttrs,
      dimensions: width && height ? `${width}x${height}` : "",
    });
  });

  // CSS background-image'ler (broşür görselleri bazen böyle yüklenir)
  doc.querySelectorAll("[style]").forEach((el) => {
    const style = el.getAttribute("style") || "";
    const bgMatch = style.match(/background-image\s*:\s*url\(["']?([^"')]+)["']?\)/i);
    if (bgMatch && !seen.has(bgMatch[1])) {
      seen.add(bgMatch[1]);
      let fullSrc = bgMatch[1];
      try {
        fullSrc = new URL(bgMatch[1], baseUrl).href;
      } catch {}

      images.push({
        src: fullSrc,
        alt: "",
        title: "",
        fileInfo: "",
        parentText: el.textContent?.trim().substring(0, 200) || "",
        parentLink: "",
        dataAttrs: {},
        dimensions: "",
        type: "background-image",
      });
    }
  });

  // <picture> / <source> elementleri
  doc.querySelectorAll("picture source").forEach((source) => {
    const srcset = source.getAttribute("srcset");
    if (srcset) {
      const firstSrc = srcset.split(",")[0]?.trim()?.split(" ")[0];
      if (firstSrc && !seen.has(firstSrc)) {
        seen.add(firstSrc);
        let fullSrc = firstSrc;
        try {
          fullSrc = new URL(firstSrc, baseUrl).href;
        } catch {}
        images.push({
          src: fullSrc,
          alt: "",
          title: "",
          fileInfo: "",
          parentText: "",
          parentLink: "",
          dataAttrs: {},
          dimensions: "",
          type: "picture-source",
        });
      }
    }
  });

  return images;
}

// ═══════════════════════════════════════════════════════════
// 🆕 YENİ MODÜL 5: BROŞÜR/KAMPANYA SAYFASI ANALİZCİ
// ═══════════════════════════════════════════════════════════
// Broşür sayfalarını tanır ve görsellerden ürün bilgisi çıkarmaya çalışır.

function analyzeBrochurePage(doc, html, images, baseUrl) {
  const brochure = {
    isBrochure: false,
    images: [],
    campaigns: [],
    dateRanges: [],
  };

  // Broşür sayfası mı?
  const pageText = (doc.title || "") + " " + (html.substring(0, 5000));
  const brochureKeywords = [
    "broşür", "brosur", "afiş", "afis", "aktüel", "aktuel",
    "aldın aldın", "aldin aldin", "kampanya", "insert",
    "haftalık", "haftalik", "katalog", "flyer",
  ];

  brochure.isBrochure = brochureKeywords.some((kw) =>
    pageText.toLowerCase().includes(kw)
  );

  if (!brochure.isBrochure) return brochure;

  // Broşür görsellerini filtrele (büyük görseller = broşür sayfaları)
  brochure.images = images.filter((img) => {
    const src = img.src.toLowerCase();
    return (
      src.includes("brosur") ||
      src.includes("afis") ||
      src.includes("insert") ||
      src.includes("campaign") ||
      src.includes("katalog") ||
      src.includes("aktuel") ||
      src.includes("flyer") ||
      (img.alt &&
        brochureKeywords.some((kw) =>
          img.alt.toLowerCase().includes(kw)
        )) ||
      // Büyük CDN görselleri muhtemelen broşür sayfası
      (src.includes("cdn") && (src.includes(".jpg") || src.includes(".webp")) &&
        !src.includes("logo") && !src.includes("icon"))
    );
  });

  // Tarih aralıklarını çıkar
  const datePatterns = [
    /(\d{1,2})\s*[-–]\s*(\d{1,2})\s+(Ocak|Şubat|Mart|Nisan|Mayıs|Haziran|Temmuz|Ağustos|Eylül|Ekim|Kasım|Aralık)/gi,
    /(\d{1,2})\s+(Ocak|Şubat|Mart|Nisan|Mayıs|Haziran|Temmuz|Ağustos|Eylül|Ekim|Kasım|Aralık)[^]*?(?:itibaren|arası|tarihleri)/gi,
    /(\d{1,2}\.\d{1,2}\.\d{2,4})\s*[-–]\s*(\d{1,2}\.\d{1,2}\.\d{2,4})/g,
  ];

  const bodyText = doc.body?.textContent || "";
  for (const pattern of datePatterns) {
    let match;
    while ((match = pattern.exec(bodyText)) !== null) {
      brochure.dateRanges.push(match[0].trim());
    }
  }

  // Kampanya/broşür linkleri
  doc.querySelectorAll("a[href]").forEach((a) => {
    const href = a.getAttribute("href") || "";
    const text = a.textContent.trim();
    if (
      brochureKeywords.some(
        (kw) =>
          href.toLowerCase().includes(kw) ||
          text.toLowerCase().includes(kw)
      )
    ) {
      let fullUrl = href;
      try {
        fullUrl = new URL(href, baseUrl).href;
      } catch {}
      brochure.campaigns.push({ text, url: fullUrl });
    }
  });

  return brochure;
}

// ═══════════════════════════════════════════════════════════
// 🆕 YENİ MODÜL 6: DERİN ÜRÜN VERİSİ ÇIKARMA (SPA verilerinden)
// ═══════════════════════════════════════════════════════════
// SPA hydration verisinden veya API yanıtlarından ürün bilgilerini
// normalize ederek çıkarır.

function extractProductsFromJSON(data, depth = 0) {
  if (depth > 8) return [];
  const products = [];

  if (Array.isArray(data)) {
    for (const item of data) {
      if (typeof item === "object" && item !== null) {
        // Bu bir ürün objesi mi?
        if (isProductObject(item)) {
          products.push(normalizeProduct(item));
        } else {
          // İç içe ara
          products.push(...extractProductsFromJSON(item, depth + 1));
        }
      }
    }
  } else if (typeof data === "object" && data !== null) {
    // Ürün objesi mi?
    if (isProductObject(data)) {
      products.push(normalizeProduct(data));
    }

    // Tüm value'ları tara
    for (const [key, value] of Object.entries(data)) {
      if (typeof value === "object" && value !== null) {
        products.push(...extractProductsFromJSON(value, depth + 1));
      }
    }
  }

  // Duplikasyonu önle
  const seen = new Set();
  return products.filter((p) => {
    const key = (p.name || "") + (p.sku || "") + (p.price || "");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isProductObject(obj) {
  // Ürün objesi olma olasılığını kontrol et
  const keys = Object.keys(obj).map((k) => k.toLowerCase());
  const productKeys = [
    "name", "title", "productname", "product_name", "urun_adi",
    "price", "fiyat", "salePrice", "listPrice",
    "sku", "productId", "product_id", "barcode",
    "brand", "marka",
    "image", "imageUrl", "img", "gorsel",
    "category", "kategori",
  ];

  let matchCount = 0;
  for (const pk of productKeys) {
    if (keys.includes(pk.toLowerCase())) matchCount++;
  }

  // En az 2 ürün alanı varsa ürün objesidir
  return matchCount >= 2;
}

function normalizeProduct(obj) {
  // Farklı field isimlerini standartlaştır
  const get = (...keys) => {
    for (const key of keys) {
      // Case-insensitive arama
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
// 🆕 YENİ MODÜL 7: SİTE-SPESİFİK ADAPTÖRLER
// ═══════════════════════════════════════════════════════════
// Bilinen Türk e-ticaret siteleri için özel veri çıkarma kuralları.

function getSiteAdapter(url) {
  const hostname = new URL(url).hostname;

  const adapters = {
    // ── A101 ──
    "www.a101.com.tr": {
      name: "A101",
      productCardSelector: ".product-card, .product-item, .js-product-card, [data-product-card]",
      priceSelector: ".current-price, .product-price-new, .price-new, .js-price",
      oldPriceSelector: ".old-price, .product-price-old, .price-old, .js-old-price",
      discountSelector: ".discount-badge, .discount-rate, .badge-discount, .js-discount",
      nameSelector: ".product-name, .product-title, .name a, h3 a, h2 a",
      apiEndpoints: [
        "/api/products",
        "/api/category",
        "/api/campaign",
      ],
      // A101 broşür görselleri genelde bu CDN'den gelir
      brochureImagePattern: /cdn[^"]*(?:brosur|afis|insert|campaign)/i,
    },

    // ── Trendyol ──
    "www.trendyol.com": {
      name: "Trendyol",
      productCardSelector: ".p-card-wrppr, .product-card",
      priceSelector: ".prc-box-dscntd, .prc-box-sllng",
      oldPriceSelector: ".prc-box-orgnl",
      discountSelector: ".prc-box-dscntd-prcntg",
      nameSelector: ".prd-name, .product-name",
    },

    // ── Hepsiburada ──
    "www.hepsiburada.com": {
      name: "Hepsiburada",
      productCardSelector: "[data-test-id='product-card'], .product-card",
      priceSelector: "[data-test-id='price-current-price']",
      oldPriceSelector: "[data-test-id='price-old-price']",
      discountSelector: "[data-test-id='discount']",
      nameSelector: "[data-test-id='product-card-name'], h3",
    },

    // ── BİM ──
    "www.bim.com.tr": {
      name: "BİM",
      productCardSelector: ".product-card, .product-item",
      priceSelector: ".product-price, .price",
      oldPriceSelector: ".old-price",
      discountSelector: ".discount",
      nameSelector: ".product-name, .product-title",
    },

    // ── ŞOK Market ──
    "www.sokmarket.com.tr": {
      name: "ŞOK",
      productCardSelector: ".product-card, .product-item",
      priceSelector: ".product-price, .price-new",
      oldPriceSelector: ".price-old",
      discountSelector: ".discount-badge",
      nameSelector: ".product-name",
    },

    // ── Migros ──
    "www.migros.com.tr": {
      name: "Migros",
      productCardSelector: ".product-card, [data-monitor-product]",
      priceSelector: ".product-price, .price",
      oldPriceSelector: ".old-price, .strike-price",
      discountSelector: ".discount-badge, .campaign-badge",
      nameSelector: ".product-name, .product-title",
    },

    // ── n11 ──
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

// Site adaptörü ile ürün çıkarma
function extractWithAdapter(doc, adapter) {
  const products = [];

  const cards = doc.querySelectorAll(adapter.productCardSelector);
  cards.forEach((card) => {
    const product = {};

    // İsim
    const nameEl = card.querySelector(adapter.nameSelector);
    if (nameEl) {
      product.name =
        nameEl.getAttribute("title") || nameEl.textContent.trim();
    }

    // Fiyat
    const priceEl = card.querySelector(adapter.priceSelector);
    if (priceEl) {
      product.price =
        priceEl.getAttribute("data-price") ||
        priceEl.getAttribute("content") ||
        priceEl.textContent.trim();
    }

    // Eski fiyat
    const oldPriceEl = card.querySelector(adapter.oldPriceSelector);
    if (oldPriceEl) {
      product.oldPrice = oldPriceEl.textContent.trim();
    }

    // İndirim
    const discountEl = card.querySelector(adapter.discountSelector);
    if (discountEl) {
      product.discount = discountEl.textContent.trim();
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
        imgEl.getAttribute("src");
    }

    if (product.name || product.price) {
      products.push(product);
    }
  });

  return products;
}

// ═══════════════════════════════════════════════════════════
// 1. STRUCTURED DATA — JSON-LD, OpenGraph, Meta
//    (DEĞİŞİKLİK YOK — Aynı kalıyor)
// ═══════════════════════════════════════════════════════════

function extractStructuredData(doc) {
  const results = [];

  doc.querySelectorAll('script[type="application/ld+json"]').forEach((el) => {
    try {
      const data = JSON.parse(el.textContent);
      results.push({ type: "json-ld", data });
    } catch {}
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

// ═══════════════════════════════════════════════════════════
// 2. PRODUCT CARD EXTRACTION
//    🔄 GÜNCELLENDİ: Adaptör desteği + daha fazla seçici eklendi
// ═══════════════════════════════════════════════════════════

function extractProductCards(doc, adapter = null) {
  // Önce site adaptörünü dene
  if (adapter) {
    const adapterProducts = extractWithAdapter(doc, adapter);
    if (adapterProducts.length > 0) return adapterProducts;
  }

  const products = [];

  const cardSelectors = [
    // Orijinal seçiciler
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
    // 🆕 Eklenen yeni seçiciler
    "[data-product-card]",
    ".js-product-card",
    ".product-wrapper",
    ".product-container",
    ".product-tile",
    ".product-grid-item",
    ".plp-product",
    ".search-result-item",
    ".listing-item",
    ".category-product",
    "[data-component='product']",
    "[data-qa='product-card']",
    ".col-product",
    ".grid-product",
  ];

  let cards = [];
  for (const sel of cardSelectors) {
    cards = doc.querySelectorAll(sel);
    if (cards.length > 0) break;
  }

  if (cards.length === 0) {
    const priceEls = doc.querySelectorAll(
      '[class*="price"], [class*="fiyat"], [data-price]'
    );
    const parentSet = new Set();
    priceEls.forEach((el) => {
      let parent = el.parentElement;
      for (let i = 0; i < 4 && parent; i++) {
        if (parent.querySelector("a") && parent.textContent.trim().length < 500) {
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

    const allText = card.textContent;
    const priceRegex = /[₺€$]?\s*[\d.,]+\s*(?:₺|TL|€|\$)/g;
    const allPrices = allText.match(priceRegex) || [];

    const priceSelectors = [
      ".price", ".product-price", ".prd-price", ".current-price",
      ".sale-price", ".discounted-price", "[data-price]", ".price-new",
      ".price-current", ".amount", ".final-price",
      // 🆕 Eklenen
      ".price-new", ".price-sale", ".special-price", ".promo-price",
      ".js-price", "[data-sale-price]", "[data-current-price]",
    ];
    const oldPriceSelectors = [
      ".old-price", ".original-price", ".price-old", ".list-price",
      ".line-through", "del", "s", ".price-regular", ".strikethrough",
      ".retail-price",
      // 🆕 Eklenen
      ".was-price", ".price-was", ".crossed-price", ".market-price",
      "[data-old-price]", "[data-list-price]", ".js-old-price",
    ];
    const discountSelectors = [
      ".discount", ".badge-discount", ".discount-rate", ".discount-badge",
      ".campaign-badge", ".prd-discount", ".sale-badge",
      // 🆕 Eklenen
      ".discount-percentage", ".save-percent", ".promo-badge",
      ".campaign-discount", "[data-discount]", ".js-discount",
      ".percent-off", ".savings",
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
      product.image =
        imgEl.getAttribute("data-src") ||
        imgEl.getAttribute("data-lazy-src") ||
        imgEl.getAttribute("src") ||
        imgEl.getAttribute("data-lazy");
    }

    const badges = card.querySelectorAll(".badge, .tag, .label, .stock, .variant");
    const badgeTexts = [];
    badges.forEach((b) => {
      const t = b.textContent.trim();
      if (t.length > 0 && t.length < 50) badgeTexts.push(t);
    });
    if (badgeTexts.length > 0) product.badges = badgeTexts.join(", ");

    [
      "data-product-id", "data-sku", "data-brand", "data-category",
      "data-variant", "data-stock", "data-rating",
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
// 3. TABLE EXTRACTION (DEĞİŞİKLİK YOK)
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
// 4. NAVIGATION & LINK EXTRACTION (DEĞİŞİKLİK YOK)
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
// 5. HEADING STRUCTURE (DEĞİŞİKLİK YOK)
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
// 6. LIST EXTRACTION (DEĞİŞİKLİK YOK)
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
// 7. FILTER / FACET EXTRACTION (DEĞİŞİKLİK YOK)
// ═══════════════════════════════════════════════════════════

function extractFilters(doc) {
  const filters = [];

  doc.querySelectorAll("select").forEach((select) => {
    const name =
      select.getAttribute("name") ||
      select.getAttribute("id") ||
      select.getAttribute("aria-label") || "";
    const options = [];
    select.querySelectorAll("option").forEach((opt) => {
      const text = opt.textContent.trim();
      const value = opt.getAttribute("value");
      if (text && value && value !== "") options.push(text);
    });
    if (options.length > 0) filters.push({ name, options });
  });

  doc.querySelectorAll(
    ".filter-group, .facet, [data-filter], .filter-section, .refinement"
  ).forEach((group) => {
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

// ═══════════════════════════════════════════════════════════
// 8. CLEAN TEXT (DEĞİŞİKLİK YOK)
// ═══════════════════════════════════════════════════════════

function extractCleanText(doc) {
  const clone = doc.cloneNode(true);

  const removeSelectors = [
    "script", "style", "nav", "footer", "header", "aside",
    "iframe", "noscript", "svg", "video", "audio",
    ".cookie-banner", ".popup", ".modal", ".overlay",
    '[aria-hidden="true"]', ".advertisement", ".ad-container",
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
// 9. MASTER EXTRACTOR
//    🔄 BÜYÜK GÜNCELLEME: Tüm yeni modüller entegre edildi
// ═══════════════════════════════════════════════════════════

async function extractAllData(html, url) {
  const dom = new JSDOM(html, { url });
  const doc = dom.window.document;

  // Site adaptörünü belirle
  const adapter = getSiteAdapter(url);

  // Temel çıkarımlar
  const structured = extractStructuredData(doc);
  const tables = extractTables(doc);
  const headings = extractHeadings(doc);
  const links = extractLinks(doc, url);
  const lists = extractLists(doc);
  const filters = extractFilters(doc);
  const cleanText = extractCleanText(doc);

  // 🆕 Yeni çıkarımlar
  const spaData = extractSPAData(html);
  const images = extractImages(doc, url);
  const brochure = analyzeBrochurePage(doc, html, images, url);
  const apiEndpoints = discoverAPIEndpoints(html, url);

  // Ürün çıkarma — çoklu strateji
  let products = extractProductCards(doc, adapter);

  // Strateji 2: SPA verisinden ürün çıkar
  let spaProducts = [];
  if (spaData.length > 0) {
    for (const spa of spaData) {
      const found = extractProductsFromJSON(spa.data);
      spaProducts.push(...found);
    }
  }

  // Strateji 3: JSON-LD'den ürün çıkar
  let jsonLdProducts = [];
  const jsonLdData = structured.filter((s) => s.type === "json-ld");
  for (const jld of jsonLdData) {
    const found = extractProductsFromJSON(jld.data);
    jsonLdProducts.push(...found);
  }

  // Strateji 4: API endpoint'lerini çağır
  let apiProducts = [];
  let apiResults = [];
  if (products.length === 0 && spaProducts.length === 0 && apiEndpoints.length > 0) {
    try {
      apiResults = await fetchAPIEndpoints(apiEndpoints, url);
      for (const result of apiResults) {
        const found = extractProductsFromJSON(result.data);
        apiProducts.push(...found);
      }
    } catch {}
  }

  // En iyi ürün listesini seç
  const allProductSources = [
    { name: "HTML Cards", products },
    { name: "SPA Hydration", products: spaProducts },
    { name: "JSON-LD", products: jsonLdProducts },
    { name: "API", products: apiProducts },
  ];

  // En çok ürün bulan kaynağı kullan
  const bestSource = allProductSources.reduce((best, current) =>
    current.products.length > best.products.length ? current : best
  );

  // ═══════════════════════════════════════════════════════
  // Çıktı oluşturma
  // ═══════════════════════════════════════════════════════

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

  if (adapter) {
    sections.push("🏪 TANINAN SİTE: " + adapter.name);
  }

  // ── 🆕 Broşür Analizi ──
  if (brochure.isBrochure) {
    sections.push("\n📰 BROŞÜR SAYFASI TESPİT EDİLDİ");
    sections.push("─".repeat(60));

    if (brochure.dateRanges.length > 0) {
      sections.push("📅 Tarih Aralıkları:");
      brochure.dateRanges.forEach((d) => sections.push("  • " + d));
    }

    if (brochure.campaigns.length > 0) {
      sections.push("📋 Kampanya Linkleri:");
      brochure.campaigns.forEach((c) =>
        sections.push("  • " + c.text + " → " + c.url)
      );
    }

    if (brochure.images.length > 0) {
      sections.push("🖼️ Broşür Görselleri (" + brochure.images.length + " adet):");
      brochure.images.forEach((img, i) => {
        sections.push("  " + (i + 1) + ". " + img.src);
        if (img.alt) sections.push("     Alt: " + img.alt);
        if (img.parentText) sections.push("     Bağlam: " + img.parentText);
      });
    }

    sections.push("");
    sections.push("⚠️ NOT: Broşür içeriği görsel formatındadır.");
    sections.push("   Ürün detayları için broşür görsellerinin OCR ile");
    sections.push("   analiz edilmesi veya kampanya linklerinin ziyaret edilmesi gerekir.");
  }

  // ── JSON-LD ──
  if (jsonLdData.length > 0) {
    sections.push("\n📊 YAPISAL VERİ (JSON-LD):");
    jsonLdData.forEach((jld) => {
      sections.push(JSON.stringify(jld.data, null, 2).substring(0, 5000));
    });
  }

  // ── 🆕 SPA Verisi ──
  if (spaData.length > 0) {
    sections.push("\n⚡ SPA/SSR VERİSİ BULUNDU:");
    spaData.forEach((spa) => {
      sections.push("  Kaynak: " + spa.source);
      const preview = JSON.stringify(spa.data).substring(0, 1000);
      sections.push("  Önizleme: " + preview + "...");
    });
  }

  // ── Ürün Listesi (en iyi kaynak) ──
  if (bestSource.products.length > 0) {
    sections.push(
      "\n🛒 ÜRÜNLER (" +
        bestSource.products.length +
        " adet — Kaynak: " +
        bestSource.name +
        "):"
    );
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

  // ── 🆕 API Keşfi ──
  if (apiEndpoints.length > 0) {
    sections.push(
      "\n🔌 KEŞFEDİLEN API ENDPOINT'LERİ (" + apiEndpoints.length + " adet):"
    );
    apiEndpoints.slice(0, 20).forEach((ep) => {
      sections.push("  • " + ep);
    });
  }

  if (apiResults.length > 0) {
    sections.push("\n📡 API YANITLARI:");
    apiResults.forEach((r) => {
      sections.push("  URL: " + r.url);
      sections.push(
        "  Veri: " + JSON.stringify(r.data).substring(0, 2000)
      );
    });
  }

  // ── 🆕 Görseller ──
  const meaningfulImages = images.filter(
    (img) =>
      img.alt ||
      img.parentText ||
      Object.keys(img.dataAttrs).length > 0
  );
  if (meaningfulImages.length > 0) {
    sections.push(
      "\n🖼️ GÖRSELLER (" + meaningfulImages.length + " anlamlı görsel):"
    );
    meaningfulImages.slice(0, 30).forEach((img, i) => {
      let line = "  " + (i + 1) + ". " + img.src;
      if (img.alt) line += "\n     Alt: " + img.alt;
      if (img.title) line += " | Title: " + img.title;
      if (img.parentText && img.parentText !== img.alt) {
        line += "\n     Bağlam: " + img.parentText;
      }
      if (img.parentLink) line += "\n     Link: " + img.parentLink;
      if (Object.keys(img.dataAttrs).length > 0) {
        line +=
          "\n     Data: " + JSON.stringify(img.dataAttrs);
      }
      sections.push(line);
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
        h.level === "H1" ? "# " :
        h.level === "H2" ? "## " :
        h.level === "H3" ? "### " : "#### ";
      sections.push(prefix + h.text);
    });
  }

  // ── Filtreler ──
  if (filters.length > 0) {
    sections.push("\n🔍 FİLTRELER / KATEGORİLER:");
    filters.forEach((f) => {
      sections.push("  " + f.name + ": " + f.options.join(", "));
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

  // ── Linkler ──
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
    bestSource.products.length === 0 &&
    tables.length === 0 &&
    jsonLdData.length === 0 &&
    spaData.length === 0 &&
    !brochure.isBrochure
  ) {
    sections.push("\n📄 SAYFA İÇERİĞİ:");
    sections.push(cleanText.substring(0, 12000));
  }

  // ── 🆕 Veri Kalitesi Özeti ──
  sections.push("\n" + "═".repeat(60));
  sections.push("📊 VERİ KALİTESİ ÖZETİ:");
  sections.push("═".repeat(60));
  sections.push("  Ürün (HTML kartları): " + products.length);
  sections.push("  Ürün (SPA/SSR verisi): " + spaProducts.length);
  sections.push("  Ürün (JSON-LD): " + jsonLdProducts.length);
  sections.push("  Ürün (API): " + apiProducts.length);
  sections.push("  En iyi kaynak: " + bestSource.name + " (" + bestSource.products.length + " ürün)");
  sections.push("  Görseller: " + images.length + " (anlamlı: " + meaningfulImages.length + ")");
  sections.push("  API endpoint: " + apiEndpoints.length);
  sections.push("  SPA veri kaynağı: " + spaData.length);
  sections.push("  Broşür sayfası: " + (brochure.isBrochure ? "EVET" : "HAYIR"));
  if (adapter) sections.push("  Site adaptörü: " + adapter.name);

  return sections.join("\n");
}

// ═══════════════════════════════════════════════════════════
// CLOUDFLARE DETECTION (DEĞİŞİKLİK YOK)
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
// FETCH STRATEGIES (DEĞİŞİKLİK YOK)
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
//    🔄 GÜNCELLENDİ: extractAllData artık async
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
        // 🔄 extractAllData artık async (API çağrıları için)
        const extracted = await extractAllData(result.html, url);
        const note = result.note || "";
        const finalText = extracted.substring(0, 30000); // 🔄 25K → 30K

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
