importScripts("bd-search-segments.js");

const DEFAULT_SESSION = {
  status: "idle",
  config: null,
  leads: [],
  mapsCount: 0,
  csvFileName: "",
  searchPlan: null,
  mapsTabId: null
};

/** Reloads since last saved lead — resets on each lead; only blocks if Maps is clearly stuck. */
const MAX_MAPS_RELOAD_WITHOUT_NEW_LEAD = 120;

const runtimeState = {
  mapsTabId: null,
  isPaused: false,
  isStopped: false,
  runId: null,
  mapsReloadSinceLead: 0,
  lastLeadCollectedAt: 0,
  shiftCheckInterval: null
};

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.storage.local.set({ session: { ...DEFAULT_SESSION } });
  console.log("[Lead লও] Installed");
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg?.action) return;
  console.log("[Lead লও] Message:", msg.action);
  const senderTabId = sender?.tab?.id || null;

  if (msg.action === "START_SCRAPING") startScraping(msg.config).catch(handleError);
  if (msg.action === "PAUSE") handlePause().catch(handleError);
  if (msg.action === "RESUME") handleResume().catch(handleError);
  if (msg.action === "STOP") {
    if (runtimeState.isStopped) return;
    stopAndExportPartial().catch(handleError);
  }
  if (msg.action === "LEAD_COLLECTED") handleLeadCollected(msg.lead, senderTabId).catch(handleError);
  if (msg.action === "MAPS_DONE") handleMapsDone(msg, senderTabId).catch(handleError);
  if (msg.action === "MAPS_STATUS") handleMapsStatus(msg.status).catch(handleError);
  if (msg.action === "MAPS_NEED_RELOAD") handleMapsNeedReload(senderTabId).catch(handleError);
  if (msg.action === "MAPS_TAB_BOOTSTRAP") handleMapsTabBootstrap(msg, senderTabId).catch(handleError);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { session } = await chrome.storage.local.get("session");
  if (!session) return;
  if (tabId === runtimeState.mapsTabId && (session.status === "scraping_maps" || session.status === "paused")) {
    runtimeState.mapsTabId = null;
    await chrome.storage.local.set({ session: { ...session, status: "paused" } });
    broadcast({ action: "ERROR", message: "Maps tab closed. Session paused." });
  }
});

async function startScraping(config) {
  validateConfig(config);
  runtimeState.runId = createRunId();
  runtimeState.isPaused = false;
  runtimeState.isStopped = false;
  runtimeState.mapsReloadSinceLead = 0;
  runtimeState.lastLeadCollectedAt = Date.now();
  startShiftMonitor();

  const plan = self.LH_buildSearchPlan(config.keyword, config.location);
  const firstQuery = plan.segments[0] || `${config.keyword} ${config.location}`.trim();
  const mapsUrl = self.LH_mapsSearchUrlForQuery(firstQuery);
  const session = {
    ...DEFAULT_SESSION,
    status: "scraping_maps",
    config,
    runId: runtimeState.runId,
    mapsSearchUrl: mapsUrl,
    searchPlan: {
      mode: plan.mode,
      segments: plan.segments,
      index: 0,
      currentQuery: firstQuery
    }
  };
  await chrome.storage.local.set({ session });
  broadcast({ action: "PHASE_CHANGE", phase: "maps", state: "running" });
  const mapsTab = await getOrCreateMapsTab(mapsUrl);
  runtimeState.mapsTabId = mapsTab.id;
  await chrome.storage.local.set({ session: { ...session, mapsTabId: mapsTab.id } });
  await waitForTabComplete(runtimeState.mapsTabId);
  await sleep(600);

  await sendMessageToTabWithRetry(
    runtimeState.mapsTabId,
    {
      action: "START_MAPS_SCRAPE",
      limit: config.limit,
      runId: runtimeState.runId,
      searchUrl: mapsUrl,
      requiredFields: config.requiredFields || ["phone"],
      requiredMode: config.requiredMode || "any"
    },
    "content/maps-content.js"
  );
}

async function handlePause() {
  runtimeState.isPaused = true;
  const { session } = await chrome.storage.local.get("session");
  const tabId = await resolveMapsTabId(session);
  if (session) await chrome.storage.local.set({ session: { ...session, status: "paused", mapsTabId: tabId || session.mapsTabId || null } });
  safeSendToTab(tabId, { action: "PAUSE_SCRAPE", runId: session?.runId || runtimeState.runId });
  broadcast({ action: "PROGRESS_UPDATE", state: "paused", status: "Paused" });
}

async function handleResume() {
  runtimeState.isPaused = false;
  const { session } = await chrome.storage.local.get("session");
  const tabId = await resolveMapsTabId(session);
  if (session) await chrome.storage.local.set({ session: { ...session, status: "scraping_maps", mapsTabId: tabId || session.mapsTabId || null } });
  safeSendToTab(tabId, { action: "RESUME_SCRAPE", runId: session?.runId || runtimeState.runId });
  broadcast({ action: "PROGRESS_UPDATE", state: "running", status: "Resuming..." });
  kickMapsScrapeAfterResume().catch(handleError);
}

async function kickMapsScrapeAfterResume() {
  await sleep(400);
  const { session } = await chrome.storage.local.get("session");
  const tabId = await resolveMapsTabId(session);
  if (!tabId || runtimeState.isStopped) return;
  if (!session?.config || session.status !== "scraping_maps") return;
  const remaining = Math.max(0, (session.config.limit || 0) - (session.leads?.length || 0));
  if (remaining <= 0) return;
  const url =
    session.mapsSearchUrl ||
    `https://www.google.com/maps/search/${encodeURIComponent(`${session.config.keyword || ""} ${session.config.location || ""}`)}`;
  await sendMessageToTabWithRetry(
    tabId,
    {
      action: "START_MAPS_SCRAPE",
      limit: remaining,
      runId: session.runId || runtimeState.runId,
      searchUrl: url,
      requiredFields: session.config.requiredFields || ["phone"],
      requiredMode: session.config.requiredMode || "any"
    },
    "content/maps-content.js"
  );
}

async function handleMapsTabBootstrap(_msg, tabId) {
  if (!tabId) return;
  if (runtimeState.isStopped) return;
  const { session } = await chrome.storage.local.get("session");
  if (!session?.config || session.status !== "scraping_maps") return;
  if (runtimeState.mapsTabId && tabId !== runtimeState.mapsTabId) return;
  if (session.mapsTabId && tabId !== session.mapsTabId) return;
  runtimeState.mapsTabId = tabId;
  await chrome.storage.local.set({ session: { ...session, mapsTabId: tabId } });
  const remaining = Math.max(0, (session.config.limit || 0) - (session.leads?.length || 0));
  if (remaining <= 0) return;
  const url =
    session.mapsSearchUrl ||
    `https://www.google.com/maps/search/${encodeURIComponent(`${session.config.keyword || ""} ${session.config.location || ""}`)}`;
  await sendMessageToTabWithRetry(
    tabId,
    {
      action: "START_MAPS_SCRAPE",
      limit: remaining,
      runId: session.runId || runtimeState.runId,
      searchUrl: url,
      requiredFields: session.config.requiredFields || ["phone"],
      requiredMode: session.config.requiredMode || "any"
    },
    "content/maps-content.js"
  );
}

async function handleLeadCollected(lead, senderTabId) {
  if (runtimeState.isStopped) return;
  const { session } = await chrome.storage.local.get("session");
  if (!session?.config) return;
  if (senderTabId) runtimeState.mapsTabId = senderTabId;
  if (session.leads.length >= session.config.limit) return;

  const normalized = normalizeLead(lead);
  const phoneKey = normalizePhoneKey(normalized.phone);
  const emailKey = normalizeEmailKey(normalized.email);
  const websiteKey = normalizeWebsiteKey(normalized.website);
  const placeKey = normalizePlaceKey(normalized);
  if (!passesRequiredFields(normalized, session.config.requiredFields, session.config.requiredMode)) return;

  for (const existing of session.leads || []) {
    const ep = normalizePhoneKey(existing.phone);
    const ee = normalizeEmailKey(existing.email);
    const ew = normalizeWebsiteKey(existing.website);
    const place = normalizePlaceKey(existing);
    if (phoneKey && ep && phoneKey === ep) return;
    if (emailKey && ee && emailKey === ee) return;
    if (websiteKey && ew && websiteKey === ew) return;
    if (placeKey && place && placeKey === place) return;
  }

  const leads = [...session.leads, normalized];
  const mapsCount = leads.length;
  await chrome.storage.local.set({ session: { ...session, leads, mapsCount, mapsTabId: senderTabId || session.mapsTabId || runtimeState.mapsTabId } });

  runtimeState.mapsReloadSinceLead = 0;
  runtimeState.lastLeadCollectedAt = Date.now();

  broadcast({
    action: "PROGRESS_UPDATE",
    phase: "maps",
    count: mapsCount,
    total: session.config.limit,
    currentBusiness: lead?.name || "Unknown business",
    status: `Collected: ${lead?.name || "Unknown business"}`
  });
}

function startShiftMonitor() {
  if (runtimeState.shiftCheckInterval) clearInterval(runtimeState.shiftCheckInterval);
  runtimeState.shiftCheckInterval = setInterval(async () => {
    if (runtimeState.isPaused || runtimeState.isStopped) return;
    const { session } = await chrome.storage.local.get("session");
    if (!session || session.status !== "scraping_maps") return;

    const timeSinceLastLead = Date.now() - runtimeState.lastLeadCollectedAt;
    const timeoutMs = 90000; // 1.5 minutes

    if (timeSinceLastLead > timeoutMs) {
      console.log("[Lead লও] Shift timeout reached. Moving to next area.");
      runtimeState.lastLeadCollectedAt = Date.now(); // Reset to avoid double trigger
      handleMapsDone({ localExhausted: true }).catch(handleError);
    }
  }, 10000); // Check every 10 seconds
}


async function handleMapsDone(msg, senderTabId) {
  if (runtimeState.isStopped) return;

  const { session } = await chrome.storage.local.get("session");
  if (!session?.config) return;
  if (senderTabId) runtimeState.mapsTabId = senderTabId;

  const target = session.config.limit || 0;
  const have = (session.leads || []).length;

  if (have >= target) {
    await exportCsvAndComplete(session, "completed");
    return;
  }

  const localExhausted = Boolean(msg?.localExhausted);
  const plan = session.searchPlan;
  if (localExhausted && plan?.segments?.length) {
    const nextIdx = plan.index + 1;
    if (nextIdx < plan.segments.length) {
      const query = plan.segments[nextIdx];
      const nextUrl = self.LH_mapsSearchUrlForQuery(query);
      const newSession = {
        ...session,
        mapsSearchUrl: nextUrl,
        searchPlan: { ...plan, index: nextIdx, currentQuery: query },
        status: "scraping_maps"
      };
      await chrome.storage.local.set({ session: newSession });
      runtimeState.mapsReloadSinceLead = 0;
      broadcast({
        action: "PROGRESS_UPDATE",
        phase: "maps",
        count: have,
        total: target,
        state: "running",
        status: `Next region (${nextIdx + 1}/${plan.segments.length}): ${query}`
      });
      const tabId = await resolveMapsTabId(newSession);
      if (tabId) {
        await chrome.tabs.update(tabId, { url: nextUrl, active: true });
        await waitForTabComplete(tabId);
        await sleep(900);
        const remaining = Math.max(0, target - have);
        await sendMessageToTabWithRetry(
          tabId,
          {
            action: "START_MAPS_SCRAPE",
            limit: remaining,
            runId: newSession.runId || runtimeState.runId,
            searchUrl: nextUrl,
            requiredFields: newSession.config.requiredFields || ["phone"],
            requiredMode: newSession.config.requiredMode || "any"
          },
          "content/maps-content.js"
        );
      }
      return;
    }
  }

  if (have > 0) {
    await exportCsvAndComplete(session, "partial_completed");
    return;
  }

  await clearShiftMonitor();
  const noResultsSession = { ...session, status: "complete", mapsCount: 0, state: "no_results" };
  await chrome.storage.local.set({ session: noResultsSession });
  broadcast({ action: "PHASE_CHANGE", phase: "complete", state: "no_results" });
  broadcast({
    action: "SCRAPING_COMPLETE",
    totalLeads: 0,
    rowsWritten: 0,
    state: "no_results"
  });
}

async function stopAndExportPartial() {
  runtimeState.isStopped = true;
  runtimeState.isPaused = false;

  const { session } = await chrome.storage.local.get("session");
  const tabId = await resolveMapsTabId(session);
  safeSendToTab(tabId, { action: "HIDE_FLOATING_UI" });
  safeSendToTab(tabId, { action: "STOP_SCRAPE", runId: session?.runId || runtimeState.runId });
  if (!session?.config) {
    await clearShiftMonitor();
    await chrome.storage.local.set({ session: { ...DEFAULT_SESSION } });
    broadcast({ action: "PHASE_CHANGE", phase: "config", state: "stopped" });
    return;
  }

  if ((session.leads || []).length) {
    await exportCsvAndComplete(session, "stopped_saved");
  } else {
    await clearShiftMonitor();
    await chrome.storage.local.set({ session: { ...DEFAULT_SESSION, state: "stopped" } });
    broadcast({ action: "PHASE_CHANGE", phase: "config", state: "stopped" });
  }
}

async function handleMapsNeedReload(senderTabId) {
  if (runtimeState.isStopped) return;
  if (senderTabId) runtimeState.mapsTabId = senderTabId;

  runtimeState.mapsReloadSinceLead += 1;
  if (runtimeState.mapsReloadSinceLead > MAX_MAPS_RELOAD_WITHOUT_NEW_LEAD) {
    broadcast({
      action: "ERROR",
      message:
        "Maps did not return to the results list after many automatic reloads. Stop the run, wait a few seconds, then start again (or try a narrower search)."
    });
    return;
  }

  const { session } = await chrome.storage.local.get("session");
  const url =
    session?.mapsSearchUrl ||
    `https://www.google.com/maps/search/${encodeURIComponent(`${session?.config?.keyword || ""} ${session?.config?.location || ""}`)}`;

  broadcast({
    action: "PROGRESS_UPDATE",
    phase: "maps",
    count: session?.mapsCount || 0,
    total: session?.config?.limit || 0,
    state: "loading",
    status: "Recovering — reopening your search on Maps automatically..."
  });

  const tabId = await resolveMapsTabId(session);
  if (!tabId) return;
  await chrome.tabs.update(tabId, { url, active: true });
  await waitForTabComplete(tabId);
  await sleep(900);

  const latest = await chrome.storage.local.get("session");
  const cfg = latest.session?.config;
  if (!cfg || runtimeState.isStopped) return;
  const remaining = Math.max(0, (cfg.limit || 0) - (latest.session?.leads?.length || 0));
  if (remaining === 0) {
    await handleMapsDone();
    return;
  }

  await sendMessageToTabWithRetry(
    tabId,
    {
      action: "START_MAPS_SCRAPE",
      limit: remaining,
      runId: runtimeState.runId,
      searchUrl: url,
      requiredFields: cfg.requiredFields || ["phone"],
      requiredMode: cfg.requiredMode || "any"
    },
    "content/maps-content.js"
  );
}

async function handleMapsStatus(statusText) {
  const { session } = await chrome.storage.local.get("session");
  if (!session?.config) return;
  broadcast({
    action: "PROGRESS_UPDATE",
    phase: "maps",
    count: session.mapsCount || 0,
    total: session.config.limit || 0,
    currentBusiness: statusText || "Loading...",
    status: statusText || "Loading..."
  });
}

async function exportCsvAndComplete(session, state) {
  await clearShiftMonitor();
  const csv = buildCsv(session.leads, session.config.selectedFields);
  const filename = `lead-low-${Date.now()}.csv`;
  await downloadCsv(csv, filename);

  const doneSession = {
    ...session,
    status: "complete",
    mapsCount: session.leads.length,
    csvFileName: filename,
    state
  };
  await chrome.storage.local.set({ session: doneSession });

  broadcast({ action: "PHASE_CHANGE", phase: "complete", state });
  broadcast({
    action: "SCRAPING_COMPLETE",
    totalLeads: doneSession.mapsCount,
    rowsWritten: doneSession.mapsCount,
    state,
    csvFileName: filename
  });
}

function buildCsv(leads, columns) {
  const headers = ["#", ...columns.map((c) => c.label)];
  const lines = ["sep=,", headers.join(",")];
  for (let i = 0; i < leads.length; i += 1) {
    const lead = leads[i];
    const row = [String(i + 1), ...columns.map((c) => csvCell(lead[c.key]))];
    lines.push(row.join(","));
  }
  return `\uFEFF${lines.join("\n")}`;
}

function csvCell(value) {
  const clean = String(value ?? "").replace(/\r?\n/g, " ");
  return `"${clean.replace(/"/g, '""')}"`;
}

async function downloadCsv(csvText, filename) {
  const url = `data:text/csv;charset=utf-8,${encodeURIComponent(csvText)}`;
  await chrome.downloads.download({ url, filename, saveAs: false });
}

function validateConfig(config) {
  if (!config?.keyword || !config?.location) throw new Error("Keyword and location are required.");
  if (!Array.isArray(config.selectedFields) || !config.selectedFields.length) {
    throw new Error("Select at least one field.");
  }
  if (!Array.isArray(config.requiredFields) || !config.requiredFields.length) {
    throw new Error("Select at least one required lead info field.");
  }
}

function normalizeLead(lead) {
  return {
    name: String(lead?.name || ""),
    phone: String(lead?.phone || ""),
    website: String(lead?.website || ""),
    email: String(lead?.email || ""),
    address: String(lead?.address || ""),
    rating: String(lead?.rating || ""),
    reviews: String(lead?.reviews || ""),
    category: String(lead?.category || ""),
    mapsUrl: String(lead?.mapsUrl || ""),
    scrapedAt: String(lead?.scrapedAt || new Date().toISOString())
  };
}

function passesRequiredFields(lead, requiredFields, requiredMode) {
  const required = Array.isArray(requiredFields) && requiredFields.length ? requiredFields : ["phone"];
  const check = (field) => hasLeadValue(lead, field);
  return requiredMode === "all" ? required.every(check) : required.some(check);
}

function hasLeadValue(lead, field) {
  if (field === "phone") return Boolean(normalizePhoneKey(lead.phone));
  if (field === "email") return Boolean(normalizeEmailKey(lead.email));
  return Boolean(String(lead?.[field] || "").trim());
}

function waitForTabComplete(tabId, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let timeout;
    chrome.tabs.get(tabId).then((tab) => {
      if (tab?.status === "complete") {
        resolve();
        return;
      }
      timeout = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        reject(new Error("Tab load timeout"));
      }, timeoutMs);
      chrome.tabs.onUpdated.addListener(onUpdated);
    }).catch(reject);

    function onUpdated(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    }
  });
}

async function sendMessageToTabWithRetry(tabId, payload, scriptFile) {
  const maxAttempts = 6;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await chrome.tabs.sendMessage(tabId, payload);
    } catch (err) {
      const message = String(err?.message || "");
      if (!message.includes("Receiving end does not exist")) throw err;
      try {
        await chrome.scripting.executeScript({ target: { tabId }, files: [scriptFile] });
      } catch (_) {}
      await sleep(180 * attempt);
    }
  }
  throw new Error("Could not establish connection. Receiving end does not exist.");
}

function safeSendToTab(tabId, payload) {
  if (!tabId) return;
  chrome.tabs.sendMessage(tabId, payload).catch(() => {});
}

async function resolveMapsTabId(session) {
  const candidates = [runtimeState.mapsTabId, session?.mapsTabId].filter(Boolean);
  for (const tabId of candidates) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab?.id && isMapsUrl(tab.url || "")) {
        runtimeState.mapsTabId = tab.id;
        return tab.id;
      }
    } catch (_) {}
  }

  const urls = ["https://www.google.com/maps/*", "https://maps.google.com/*", "https://www.google.com.bd/maps/*"];
  for (const url of urls) {
    const tabs = await chrome.tabs.query({ url });
    const tab = tabs.find((t) => isMapsUrl(t.url || ""));
    if (tab?.id) {
      runtimeState.mapsTabId = tab.id;
      return tab.id;
    }
  }
  return null;
}

function isMapsUrl(url) {
  return /https:\/\/(www\.google\.com\/maps|maps\.google\.com|www\.google\.com\.bd\/maps)/i.test(String(url || ""));
}

async function clearShiftMonitor() {
  if (runtimeState.shiftCheckInterval) {
    clearInterval(runtimeState.shiftCheckInterval);
    runtimeState.shiftCheckInterval = null;
  }
}

async function safeCloseTab(tabId) {
  try {
    await chrome.tabs.remove(tabId);
  } catch (err) {
    console.warn("[Lead লও] Could not close tab", tabId, err);
  }
}

async function getOrCreateMapsTab(mapsUrl) {
  if (runtimeState.mapsTabId) {
    try {
      await chrome.tabs.get(runtimeState.mapsTabId);
      const updated = await chrome.tabs.update(runtimeState.mapsTabId, { url: mapsUrl, active: true });
      return updated;
    } catch (_) {
      runtimeState.mapsTabId = null;
    }
  }
  return chrome.tabs.create({ url: mapsUrl, active: true });
}

function broadcast(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
  if (runtimeState.mapsTabId) {
    chrome.tabs.sendMessage(runtimeState.mapsTabId, message).catch(() => {});
  }
}

function handleError(err) {
  console.error("[Lead লও] Error", err);
  broadcast({ action: "ERROR", message: err?.message || "Unexpected error." });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createRunId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
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
    let host = parsed.hostname.toLowerCase().replace(/^www\./, "");
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

function normalizePlaceKey(lead) {
  const url = String(lead?.mapsUrl || "").split("?")[0].trim().toLowerCase();
  if (url) return url;
  const name = String(lead?.name || "").trim().toLowerCase();
  const address = String(lead?.address || "").trim().toLowerCase();
  if (!name && !address) return "";
  return `${name}|${address}`;
}
