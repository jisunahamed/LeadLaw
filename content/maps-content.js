let isPaused = false;
let isStopped = false;
let isRunning = false;
let activeRunId = null;
let scrapeGeneration = 0;

let sessionSearchUrl = "";
let activeRequiredFields = ["phone"];
let activeRequiredMode = "any";

const processedPlaceLinks = new Set();
const seenPhones = new Set();
const seenEmails = new Set();
const seenWebsites = new Set();

let lastPlaceAnchorClickAt = 0;
const MAX_STAGNANT_ROUNDS = 78;

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg?.action) return;

  if (msg.action === "START_MAPS_SCRAPE") {
    if (isRunning && msg.runId && activeRunId === msg.runId) {
      console.log("[Lead লও][Maps] Skip duplicate START_MAPS_SCRAPE for same run");
      return;
    }
    scrapeGeneration += 1;
    const myGen = scrapeGeneration;
    const limit = msg.limit || 100;
    activeRunId = msg.runId || null;
    isStopped = false;
    isPaused = false;
    sessionSearchUrl = msg.searchUrl || sessionSearchUrl || "";
    activeRequiredFields = Array.isArray(msg.requiredFields) && msg.requiredFields.length ? msg.requiredFields : ["phone"];
    activeRequiredMode = msg.requiredMode === "all" ? "all" : "any";
    processedPlaceLinks.clear();
    seenPhones.clear();
    seenEmails.clear();
    seenWebsites.clear();

    console.log("[Lead লও][Maps] Starting scrape run:", activeRunId, "limit:", limit);
    (async () => {
      try {
        const { session } = await chrome.storage.local.get("session");
        activeRequiredFields =
          Array.isArray(session?.config?.requiredFields) && session.config.requiredFields.length
            ? session.config.requiredFields
            : activeRequiredFields;
        activeRequiredMode = session?.config?.requiredMode === "all" ? "all" : activeRequiredMode;
        for (const L of session?.leads || []) {
          const p = normalizePhoneKey(L.phone);
          const e = normalizeEmailKey(L.email);
          const w = normalizeWebsiteKey(L.website);
          if (p) seenPhones.add(p);
          if (e) seenEmails.add(e);
          if (w) seenWebsites.add(w);
          const placeKey = normalizePlaceIdentity(L.mapsUrl || "");
          if (placeKey) processedPlaceLinks.add(placeKey);
        }
      } catch (_) {}
      scrapeLeads(limit, myGen).catch((err) => {
        console.error("[Lead লও][Maps] Fatal scrape error:", err);
        chrome.runtime.sendMessage({ action: "MAPS_DONE", localExhausted: true, totalCollected: 0 });
      });
    })();
  }

  if (msg.action === "PAUSE_SCRAPE") isPaused = true;
  if (msg.action === "RESUME_SCRAPE") isPaused = false;
  if (msg.action === "STOP_SCRAPE" && (!msg.runId || !activeRunId || msg.runId === activeRunId)) {
    isStopped = true;
    if (window.lhUI) window.lhUI.destroy();
  }
  if (msg.action === "HIDE_FLOATING_UI" && window.lhUI) window.lhUI.destroy();
});

async function scrapeLeads(limit, gen) {
  isRunning = true;
  let collected = 0;
  let stagnantRounds = 0;

  if (isPlaceDetailRoute() || !getSearchResultsFeed()?.querySelector(feedPlaceLinkSelector())) {
    sendStatus("Returning to your search list...");
    await waitForResultsListOrRecover(14000);
    if (isPlaceDetailRoute() && sessionSearchUrl) {
      try {
        window.location.assign(sessionSearchUrl);
        isRunning = false;
        return;
      } catch (_) {}
    }
  }

  try {
    await waitForElement('[role="feed"]', 12000);
  } catch {
    if (gen !== scrapeGeneration) return;
    requestReloadSearch("Results list not found — reloading search...");
    isRunning = false;
    return;
  }
  await sleep(250);

  while (collected < limit && !isStopped) {
    if (gen !== scrapeGeneration) {
      isRunning = false;
      return;
    }
    await waitIfPaused();

    if (!isOnGoogleMaps()) {
      requestReloadSearch("Left Google Maps — reloading search...");
      isRunning = false;
      return;
    }

    const candidates = getUnprocessedPlaceCards();
    if (!candidates.length) {
      stagnantRounds += 1;
      if (stagnantRounds % 4 === 0) {
        sendStatus("Loading... internet may be slow. Waiting for more leads.");
      }
      if (stagnantRounds >= 10 && !document.querySelectorAll('[role="feed"]').length) {
        requestReloadSearch("Results panel missing — reloading search...");
        isRunning = false;
        return;
      }
      await scrollFeedFast();
      await sleep(850);

      if (hasFeedEndMarker() || stagnantRounds >= MAX_STAGNANT_ROUNDS) {
    console.log("[Lead লও][Maps] Local list exhausted (end marker or stagnant).");
        break;
      }
      continue;
    }

    stagnantRounds = 0;

    for (const item of candidates) {
      if (gen !== scrapeGeneration) {
        isRunning = false;
        return;
      }
      if (collected >= limit || isStopped) break;
      await waitIfPaused();

      processedPlaceLinks.add(item.link);
      const lead = await extractLeadWithDetailClick(item);
      if (!lead || !lead.name) continue;
      if (isNonBusinessLead(lead)) {
        sendStatus(`Skipped non-business result: ${lead.name}`);
        continue;
      }

      if (!passesContactRule(lead)) continue;
      if (isDuplicateContact(lead)) continue;

      registerContactKeys(lead);
      collected += 1;
      chrome.runtime.sendMessage({ action: "LEAD_COLLECTED", lead });
      await sleep(180);
      
      // Safety check: after collecting a lead, if we are somehow stuck in a detail view, try to get back
      if (isPlaceDetailRoute()) {
        await backToList();
        if (!resultsListRestored()) {
          requestReloadSearch("Stuck on detail page — reloading...");
          isRunning = false;
          return;
        }
      }
    }

    await scrollFeedFast();
    await sleep(620);
  }

  if (gen !== scrapeGeneration) {
    isRunning = false;
    return;
  }
  const localExhausted = collected < limit && !isStopped;
  isRunning = false;
  if (!localExhausted) await sleep(450);
  chrome.runtime.sendMessage({
    action: "MAPS_DONE",
    localExhausted,
    batchCollected: collected,
    totalCollected: collected
  });
}


function requestReloadSearch(reason) {
  if (reason) sendStatus(reason);
  scrapeGeneration += 1;
  chrome.runtime.sendMessage({ action: "MAPS_NEED_RELOAD" });
}

function isOnGoogleMaps() {
  const h = window.location.href;
  return h.includes("google.com/maps") || h.includes("maps.google.com");
}

function passesContactRule(lead) {
  const check = (field) => hasLeadValue(lead, field);
  return activeRequiredMode === "all" ? activeRequiredFields.every(check) : activeRequiredFields.some(check);
}

function hasLeadValue(lead, field) {
  if (field === "phone") return Boolean(normalizePhoneKey(lead.phone));
  if (field === "email") return Boolean(normalizeEmailKey(lead.email));
  return Boolean(String(lead?.[field] || "").trim());
}

function isDuplicateContact(lead) {
  const p = normalizePhoneKey(lead.phone);
  const e = normalizeEmailKey(lead.email);
  const w = normalizeWebsiteKey(lead.website);
  if (p && seenPhones.has(p)) return true;
  if (e && seenEmails.has(e)) return true;
  if (w && seenWebsites.has(w)) return true;
  return false;
}

function registerContactKeys(lead) {
  const p = normalizePhoneKey(lead.phone);
  const e = normalizeEmailKey(lead.email);
  const w = normalizeWebsiteKey(lead.website);
  if (p) seenPhones.add(p);
  if (e) seenEmails.add(e);
  if (w) seenWebsites.add(w);
}

function normalizePhoneKey(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.length < 8) return "";
  return digits;
}

function normalizeEmailKey(email) {
  const e = String(email || "")
    .trim()
    .toLowerCase();
  if (!e || !e.includes("@")) return "";
  return e;
}

function normalizeWebsiteKey(website) {
  const raw = String(website || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    let path = parsed.pathname.replace(/\/+$/, "").toLowerCase();
    if (path === "/" || path === "/home" || path === "/index.html") path = "";
    if (host === "facebook.com" || host.endsWith(".facebook.com")) {
      const parts = path.split("/").filter(Boolean);
      path = parts.length ? `/${parts[0]}` : "";
    }
    return `${host}${path}`;
  } catch {
    return raw
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .replace(/\/+$/, "");
  }
}

function feedPlaceLinkSelector() {
  return 'a[href*="/maps/place"]';
}

function getSearchResultsFeed() {
  const feeds = Array.from(document.querySelectorAll('[role="feed"]'));
  if (!feeds.length) return null;
  let best = null;
  let bestN = 0;
  for (const f of feeds) {
    const n = f.querySelectorAll(feedPlaceLinkSelector()).length;
    if (n > bestN) {
      bestN = n;
      best = f;
    }
  }
  if (best) return best;
  let fb = feeds[0];
  let hn = 0;
  for (const f of feeds) {
    const n = f.querySelectorAll("a[href]").length;
    if (n > hn) {
      hn = n;
      fb = f;
    }
  }
  return fb;
}

function getUnprocessedPlaceCards() {
  const feed = getSearchResultsFeed();
  if (!feed) return [];

  const anchors = Array.from(feed.querySelectorAll(feedPlaceLinkSelector()));
  const items = [];

  for (const anchor of anchors) {
    const link = normalizePlaceIdentity(anchor.href);
    if (!link || processedPlaceLinks.has(link)) continue;
    const card = anchor.closest(".Nv2PK") || anchor;
    items.push({ card, anchor, link });
  }

  return items;
}

function isJunkBusinessName(name) {
  const t = String(name || "").trim();
  if (t.length < 2) return true;
  if (/^results?$/i.test(t)) return true;
  if (/^result$/i.test(t)) return true;
  if (/^showing\b/i.test(t)) return true;
  if (/^maps$/i.test(t)) return true;
  if (/^search\b/i.test(t) && t.length < 28) return true;
  if (/^your location\b/i.test(t)) return true;
  if (/^directions$/i.test(t)) return true;
  if (/^\d+\s+results?$/i.test(t)) return true;
  if (isCurrentSearchAreaName(t)) return true;
  return false;
}

function isCurrentSearchAreaName(name) {
  const current = getCurrentSearchQueryParts();
  const normalizedName = normalizeLooseText(name);
  if (!normalizedName) return false;
  return current.some((part) => part && normalizedName === part);
}

function getCurrentSearchQueryParts() {
  const values = [];
  try {
    const path = decodeURIComponent(new URL(sessionSearchUrl || window.location.href).pathname);
    const match = path.match(/\/maps\/search\/([^/]+)/i);
    if (match) values.push(match[1]);
  } catch (_) {}
  try {
    const box = document.querySelector("#searchboxinput")?.value || "";
    if (box) values.push(box);
  } catch (_) {}
  return values
    .flatMap((value) => String(value).split(/\s+/))
    .concat(values)
    .map((value) => normalizeLooseText(value))
    .filter(Boolean);
}

function normalizeLooseText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function isNonBusinessLead(lead) {
  const name = String(lead?.name || "").trim();
  const category = String(lead?.category || "").trim();
  if (!name) return true;
  if (isCurrentSearchAreaName(name)) return true;
  if (isNonBusinessCategory(category)) return true;
  if (!normalizePhoneKey(lead.phone) && !normalizeWebsiteKey(lead.website) && !normalizeEmailKey(lead.email)) {
    return isNonBusinessCategory(category) || isCurrentSearchAreaName(name);
  }
  return false;
}

function isNonBusinessCategory(category) {
  const value = String(category || "").trim().toLowerCase();
  if (!value) return false;
  return /^(building|neighborhood|neighbourhood|locality|sublocality|route|street|road|intersection|bus stop|transit station|landmark|tourist attraction|administrative area|premise)$/i.test(value);
}

function pickNameFromListCard(anchor, card, lines) {
  const aria = ((anchor && anchor.getAttribute("aria-label")) || "").split(/[·,•\n]/)[0].trim();
  if (aria && !isJunkBusinessName(aria)) return aria;
  const sel =
    card.querySelector(".qBF1Pd, .fontHeadlineSmall .qBF1Pd, .fontHeadlineSmall")?.textContent?.trim() || "";
  if (sel && !isJunkBusinessName(sel)) return sel;
  for (const line of lines) {
    if (line && !isJunkBusinessName(line)) return line;
  }
  return "";
}

function extractLeadFromCard(item) {
  const card = item.card;
  const anchor = item.anchor;
  try {
    const rawText = card.innerText || "";
    const lines = rawText
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean);

    const name = pickNameFromListCard(anchor, card, lines);

    const rating =
      card.querySelector(".MW4etd")?.textContent?.trim() ||
      extractPattern(rawText, /(\d\.\d)/) ||
      "";

    const reviews =
      card.querySelector(".UY7F9")?.textContent?.replace(/[()]/g, "").trim() ||
      extractPattern(rawText, /\(([\d,]+)\)/) ||
      "";

    const category =
      card.querySelector(".W4Efsd span:first-child")?.textContent?.trim() ||
      lines.find((x) => /restaurant|shop|hospital|school|hotel|gym|service|agency|travel/i.test(x)) ||
      "";

    const address = lines.find((x) => /\d|road|street|ave|block|house|area|city|dhaka|bangladesh/i.test(x)) || "";
    const phone = extractPattern(rawText, /(\+?\d[\d\s\-()]{7,}\d)/) || "";
    const website = "";
    const email = "";

    return {
      name,
      phone,
      website,
      email,
      address,
      rating,
      reviews,
      category,
      mapsUrl: item.link || "",
      scrapedAt: new Date().toISOString()
    };
  } catch (err) {
    console.warn("[Lead লও][Maps] Card text extraction failed:", err);
    return null;
  }
}

function detailBusinessName() {
  const du = document.querySelector(".DUwDvf")?.textContent?.trim() || "";
  if (du && !isJunkBusinessName(du)) return du;
  const h = document.querySelector("h1.fontHeadlineLarge, h1.DUwDvf")?.textContent?.trim() || "";
  if (h && !isJunkBusinessName(h)) return h;
  const h1 = document.querySelector('[role="main"] h1')?.textContent?.trim() || "";
  if (h1 && !isJunkBusinessName(h1)) return h1;
  return "";
}

async function waitForDetailPanelTitle(timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const n = detailBusinessName();
    if (n) return;
    await sleep(160);
  }
  throw new Error("detail title not found");
}

function guardedListAnchorClick(anchor) {
  const now = Date.now();
  if (now - lastPlaceAnchorClickAt < 550) return;
  lastPlaceAnchorClickAt = now;
  anchor.click();
}

async function extractLeadWithDetailClick(item) {
  const fromCard = extractLeadFromCard(item);
  const card = item.card;
  try {
    card.scrollIntoView({ behavior: "auto", block: "center" });
    await sleep(90);
    sendStatus(`Opening details: ${fromCard?.name || "lead"}`);
    guardedListAnchorClick(item.anchor);
    await waitForDetailPanelTitle(12000);
    await sleep(240);

    const rawDetailName = detailBusinessName() || firstText([".DUwDvf"]);
    const fromDetail = {
      name: rawDetailName && !isJunkBusinessName(rawDetailName) ? rawDetailName : "",
      phone: firstText(['button[data-item-id*="phone"] .Io6YTe', '[data-tooltip="Copy phone number"]']),
      website: normalizeWebsiteUrl(
        firstHref(['a[data-item-id="authority"]', 'a[data-value="Website"]', 'a[data-item-id*="authority"]'])
      ),
      email: firstEmailFromDetail(),
      address: firstText(['button[data-item-id*="address"] .Io6YTe', '[data-item-id="address"] .Io6YTe']),
      rating: firstText([".MW4etd", '[role="img"][aria-label*="stars"]']),
      reviews: firstText([".UY7F9", ".F7nice span:last-child"]).replace(/[()]/g, "").trim(),
      category: firstText([".DkEaL", ".R8CAtd", '.fontBodyMedium span button']),
      mapsUrl: window.location.href,
      scrapedAt: new Date().toISOString()
    };

    await backToList();
    if (!resultsListRestored()) {
      sendStatus("Getting back to the results list...");
      const ok = await waitForResultsListOrRecover(20000);
      if (!ok && sessionSearchUrl) {
        requestReloadSearch("Could not return to search list — restoring...");
        return null;
      }
    }
    return mergeLead(fromCard, fromDetail, item.link);
  } catch (err) {
    console.warn("[Lead লও][Maps] Detail click extraction failed, fallback to card:", err);
    sendStatus("Detail loading slow. Using visible card data.");
    await backToList();
    if (!isOnGoogleMaps()) {
      requestReloadSearch("Unexpected page after detail — reloading search...");
      return null;
    }
    if (!resultsListRestored()) {
      await waitForResultsListOrRecover(16000);
    }
    if (!resultsListRestored() && sessionSearchUrl) {
      requestReloadSearch("Could not return to search list — restoring...");
      isStopped = true; // Stop current loop to wait for reload
      return null;
    }
    return mergeLead(fromCard, null, item.link);
  }
}

function isPlaceDetailRoute() {
  try {
    return new URL(window.location.href).pathname.includes("/maps/place/");
  } catch {
    return window.location.href.includes("/maps/place/");
  }
}

function resultsListRestored() {
  if (isPlaceDetailRoute()) return false;
  const u = window.location.href;
  if (u.includes("/maps/search")) return true;
  const feed = getSearchResultsFeed();
  return Boolean(feed?.querySelector(feedPlaceLinkSelector()));
}

async function waitForResultsListOrRecover(maxMs) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (resultsListRestored()) return true;
    await backToList();
    await sleep(450);
  }
  return resultsListRestored();
}

function isVisibleEl(el) {
  if (!el || !(el instanceof Element)) return false;
  const r = el.getBoundingClientRect();
  return r.width > 2 && r.height > 2;
}

async function backToList() {
  if (resultsListRestored()) return;

  const backLabelRe =
    /back|ফিরে|return|zurück|atrás|retour|indietro|terug|voltar|назад|返回|戻る|뒤로/iu;

  const tryBackClick = () => {
    const candidates = Array.from(
      document.querySelectorAll(
        'button[aria-label], [role="button"][aria-label], a[aria-label], button[data-tooltip], [role="button"][data-tooltip], button.hYBOP'
      )
    );
    for (const el of candidates) {
      if (!isVisibleEl(el)) continue;
      const label =
        (el.getAttribute("aria-label") ||
          el.getAttribute("data-tooltip") ||
          el.getAttribute("title") ||
          "").trim();
      if (label && (backLabelRe.test(label) || label.toLowerCase() === 'back')) {
        el.click();
        return true;
      }
    }
    // Specific selector found in research
    const specificBack = document.querySelector('button[aria-label="Back"], button[aria-label^="Back to"]');
    if (specificBack && isVisibleEl(specificBack)) {
      specificBack.click();
      return true;
    }
    const legacy = document.querySelector(
      'button[jsaction*="back"], button[data-value="Back"], [jsaction*="pane.back"]'
    );
    if (legacy && isVisibleEl(legacy)) {
      legacy.click();
      return true;
    }
    return false;
  };

  for (let i = 0; i < 6; i++) {
    tryBackClick();
    await sleep(380);
    if (resultsListRestored()) return;
  }

  document.body.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true })
  );
  document.body.dispatchEvent(
    new KeyboardEvent("keyup", { key: "Escape", code: "Escape", bubbles: true })
  );
  await sleep(320);
  if (resultsListRestored()) return;

  try {
    history.back();
    await sleep(550);
  } catch (_) {}
}

function mergeLead(fromCard, fromDetail, placeLink) {
  const c = fromCard || {};
  const d = fromDetail || {};
  let name = String(d.name || "").trim();
  if (!name || isJunkBusinessName(name)) name = String(c.name || "").trim();
  if (isJunkBusinessName(name)) name = "";
  return {
    name,
    phone: d.phone || c.phone || "",
    website: d.website || c.website || "",
    email: d.email || c.email || "",
    address: d.address || c.address || "",
    rating: d.rating || c.rating || "",
    reviews: d.reviews || c.reviews || "",
    category: d.category || c.category || "",
    mapsUrl: d.mapsUrl || placeLink || "",
    scrapedAt: new Date().toISOString()
  };
}

function normalizePlaceLink(raw) {
  if (!raw) return "";
  try {
    const url = new URL(raw, window.location.origin);
    url.search = "";
    return url.toString();
  } catch {
    return raw.split("?")[0];
  }
}

/** Same Maps place from list vs detail URL — used to skip already-saved leads after reload. */
function normalizePlaceIdentity(raw) {
  const base = normalizePlaceLink(raw);
  if (!base) return "";
  try {
    const url = new URL(base);
    const m = url.pathname.match(/^(\/maps\/place\/[^/]+)/i);
    if (m) return `${url.origin}${m[1]}/`.toLowerCase();
    return base.toLowerCase();
  } catch {
    return base.toLowerCase();
  }
}

function hasFeedEndMarker() {
  const feed = getSearchResultsFeed();
  const text = feed?.textContent || "";
  return /You've reached the end of the list|You.?ve reached the end/i.test(text);
}

async function scrollFeedFast() {
  const feed = getSearchResultsFeed();
  if (!feed) return;
  const delta = 900 + Math.floor(Math.random() * 1600);
  feed.scrollBy({ top: delta, behavior: "auto" });
}

function firstText(selectors) {
  for (const selector of selectors) {
    const value = document.querySelector(selector)?.textContent?.trim();
    if (value) return value;
  }
  return "";
}

function firstHref(selectors) {
  for (const selector of selectors) {
    const value = document.querySelector(selector)?.href;
    if (value) return value;
  }
  return "";
}

function guessEmailFromPage() {
  const text = document.body.innerText || "";
  const match = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,}/);
  return match ? match[0] : "";
}

function firstEmailFromDetail() {
  const mailto = document.querySelector('a[href^="mailto:"]')?.getAttribute("href") || "";
  if (mailto) return mailto.replace(/^mailto:/i, "").trim();
  return guessEmailFromPage();
}

function normalizeWebsiteUrl(url) {
  if (!url) return "";
  try {
    const parsed = new URL(url, window.location.origin);
    const q = parsed.searchParams.get("q");
    if (q && /^https?:\/\//i.test(q)) return q;
    if (/^https?:\/\//i.test(parsed.href)) return parsed.href;
    return "";
  } catch {
    return url;
  }
}

function extractPattern(text, pattern) {
  const match = (text || "").match(pattern);
  if (!match) return "";
  return (match[1] || match[0] || "").trim();
}

function sendStatus(status) {
  chrome.runtime.sendMessage({ action: "MAPS_STATUS", status });
  if (window.lhUI) window.lhUI.pushLog(status);
}

/** Premium Floating UI Controller */
class LiquidFloatingUI {
  constructor() {
    this.container = null;
    this.shadow = null;
    this.minimized = false;
    this.isDragging = false;
    this.dragStartX = 0;
    this.dragStartY = 0;
    this.initialX = 0;
    this.initialY = 0;
    this.init();
  }

  async init() {
    if (document.getElementById('lh-root')) return;

    this.container = document.createElement('div');
    this.container.id = 'lh-root';
    document.body.appendChild(this.container);

    this.shadow = this.container.attachShadow({ mode: 'open' });

    // Inject CSS
    const cssUrl = chrome.runtime.getURL('content/floating-window.css');
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = cssUrl;
    this.shadow.appendChild(link);

    // HTML Structure
    const ui = document.createElement('div');
    ui.className = 'lh-floating-window';
    ui.innerHTML = `
      <div class="lh-header" id="lh-drag-handle">
        <div class="lh-title">
          <img class="lh-logo" src="${chrome.runtime.getURL('logo.png')}" alt="" />
          Lead লও
        </div>
        <div class="lh-controls">
          <button class="lh-btn-icon lh-toggle-btn" id="lh-minimize-btn" title="Minimize">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/></svg>
          </button>
        </div>
      </div>
      <div class="lh-body">
        <div class="lh-stat-row">
          <span class="lh-stat-label">Progress</span>
          <span class="lh-stat-value" id="lh-counter">0 / 0</span>
        </div>
        <div class="lh-progress-container">
          <div class="lh-progress-bar" id="lh-progress-bar"></div>
        </div>
        <div class="lh-stat-row">
          <span class="lh-stat-label">Status</span>
          <span class="lh-status-pill lh-status-running" id="lh-status-pill">Running</span>
        </div>
        <div class="lh-log-container" id="lh-log">
          <div class="lh-log-item">Initializing Lead লও...</div>
        </div>
      </div>
      <div class="lh-footer">
        <button class="lh-btn lh-btn-secondary" id="lh-pause-btn">Pause</button>
        <button class="lh-btn lh-btn-danger" id="lh-stop-btn">Stop</button>
      </div>
    `;
    this.shadow.appendChild(ui);

    this.setupEvents();
    this.updateFromSession();
  }

  setupEvents() {
    const handle = this.shadow.getElementById('lh-drag-handle');
    const minBtn = this.shadow.getElementById('lh-minimize-btn');
    const pauseBtn = this.shadow.getElementById('lh-pause-btn');
    const stopBtn = this.shadow.getElementById('lh-stop-btn');
    const ui = this.shadow.querySelector('.lh-floating-window');

    // Dragging
    handle.addEventListener('mousedown', (e) => {
      if (e.target.closest('.lh-controls')) return;
      this.isDragging = true;
      this.dragStartX = e.clientX;
      this.dragStartY = e.clientY;
      const rect = this.container.getBoundingClientRect();
      this.initialX = rect.left;
      this.initialY = rect.top;
      this.container.style.transition = 'none';
    });

    window.addEventListener('mousemove', (e) => {
      if (!this.isDragging) return;
      const dx = e.clientX - this.dragStartX;
      const dy = e.clientY - this.dragStartY;
      this.container.style.left = `${this.initialX + dx}px`;
      this.container.style.top = `${this.initialY + dy}px`;
      this.container.style.right = 'auto';
    });

    window.addEventListener('mouseup', () => {
      this.isDragging = false;
    });

    // Toggle minimize
    minBtn.addEventListener('click', () => {
      this.minimized = !this.minimized;
      ui.classList.toggle('lh-minimized', this.minimized);
      minBtn.innerHTML = this.minimized 
        ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>'
        : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/></svg>';
    });

    // Control buttons
    pauseBtn.addEventListener('click', () => {
      const currentlyPaused = pauseBtn.textContent === 'Resume';
      chrome.runtime.sendMessage({ action: currentlyPaused ? "RESUME" : "PAUSE" });
      pauseBtn.textContent = currentlyPaused ? 'Pause' : 'Resume';
    });

    stopBtn.addEventListener('click', () => {
      this.destroy();
      chrome.runtime.sendMessage({ action: "STOP" });
    });
  }

  destroy() {
    try {
      this.container?.remove();
    } catch (_) {}
    if (window.lhUI === this) window.lhUI = null;
  }

  pushLog(text) {
    const log = this.shadow.getElementById('lh-log');
    if (!log) return;
    const item = document.createElement('div');
    item.className = 'lh-log-item';
    item.textContent = `> ${text}`;
    log.prepend(item);
    if (log.children.length > 20) log.removeChild(log.lastChild);
  }

  updateProgress(count, total) {
    const counter = this.shadow.getElementById('lh-counter');
    const bar = this.shadow.getElementById('lh-progress-bar');
    if (counter) counter.textContent = `${count} / ${total}`;
    if (bar) bar.style.width = `${Math.min(100, Math.round((count / (total || 1)) * 100))}%`;
  }

  updateStatus(status, state) {
    const pill = this.shadow.getElementById('lh-status-pill');
    const pauseBtn = this.shadow.getElementById('lh-pause-btn');
    if (!pill) return;
    
    pill.textContent = state.charAt(0).toUpperCase() + state.slice(1);
    pill.className = `lh-status-pill lh-status-${state}`;

    if (pauseBtn) {
      if (state === 'paused') {
        pauseBtn.textContent = 'Resume';
        pauseBtn.className = 'lh-btn lh-btn-primary';
      } else {
        pauseBtn.textContent = 'Pause';
        pauseBtn.className = 'lh-btn lh-btn-secondary';
      }
    }
  }

  async updateFromSession() {
    const { session } = await chrome.storage.local.get("session");
    if (session) {
      this.updateProgress(session.leads?.length || 0, session.config?.limit || 0);
      const state = session.status === 'paused' ? 'paused' : (session.status === 'idle' ? 'stopped' : 'running');
      this.updateStatus('', state);
    }
  }
}

// Instantiate UI
if (!window.lhUI) {
  window.lhUI = new LiquidFloatingUI();
}

// Listen for updates from background
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === "PROGRESS_UPDATE" && window.lhUI) {
    window.lhUI.updateProgress(msg.count, msg.total);
    if (msg.status) window.lhUI.pushLog(msg.status);
    if (msg.state) window.lhUI.updateStatus(msg.status, msg.state);
  }
  if (msg.action === "ERROR" && window.lhUI) {
    window.lhUI.pushLog(`Error: ${msg.message}`);
  }
  if ((msg.action === "SCRAPING_COMPLETE" || msg.action === "HIDE_FLOATING_UI") && window.lhUI) {
    window.lhUI.destroy();
  }
  if (msg.action === "PHASE_CHANGE" && msg.phase !== "maps" && window.lhUI) {
    window.lhUI.destroy();
  }
});

async function waitIfPaused() {
  while (isPaused && !isStopped) {
    await sleep(120);
  }
}

function waitForElement(selector, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(selector);
    if (existing) {
      resolve(existing);
      return;
    }

    const observer = new MutationObserver(() => {
      const el = document.querySelector(selector);
      if (el) {
        observer.disconnect();
        resolve(el);
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => {
      observer.disconnect();
      reject(new Error(`Element not found: ${selector}`));
    }, timeout);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

setTimeout(() => {
  chrome.runtime.sendMessage({ action: "MAPS_TAB_BOOTSTRAP" }).catch(() => {});
}, 1300);
