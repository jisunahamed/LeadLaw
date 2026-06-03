const FIELD_OPTIONS = [
  { key: "name", label: "Business Name" },
  { key: "phone", label: "Phone Number" },
  { key: "website", label: "Website" },
  { key: "email", label: "Email" },
  { key: "address", label: "Address" },
  { key: "rating", label: "Rating" },
  { key: "reviews", label: "Reviews" },
  { key: "category", label: "Category" },
  { key: "mapsUrl", label: "Google Maps URL" }
];

const REQUIRED_FIELD_OPTIONS = [
  { key: "phone", label: "Phone" },
  { key: "email", label: "Email" },
  { key: "website", label: "Website" },
  { key: "address", label: "Address" }
];

const EMPTY_SESSION = {
  status: "idle",
  config: null,
  leads: [],
  mapsCount: 0,
  csvFileName: "",
  searchPlan: null,
  mapsTabId: null
};

const ESSENTIAL_FIELD_KEYS = ["name", "phone", "website", "email", "address", "category", "mapsUrl"];

const $ = (id) => document.getElementById(id);
const screens = {
  config: $("screen-config"),
  scraping: $("screen-scraping"),
  writing: $("screen-writing"),
  complete: $("screen-complete")
};

let paused = false;
let currentSession = null;
let uiState = "idle";
let requiredMode = "any";

document.addEventListener("DOMContentLoaded", async () => {
  renderFieldToggles();
  renderRequiredToggles();
  wireInputSync();
  wireActions();
  await restoreSession();
  updateConfigPreview();
  console.log("[Lead Law] Popup initialized");
});

function renderFieldToggles() {
  const host = $("field-toggles");
  host.innerHTML = "";
  FIELD_OPTIONS.forEach((field) => {
    const wrap = document.createElement("label");
    wrap.className = "field-toggle";
    wrap.innerHTML = `<span>${field.label}</span><input type="checkbox" data-key="${field.key}" checked />`;
    host.appendChild(wrap);
  });
}

function renderRequiredToggles() {
  const host = $("required-toggles");
  host.innerHTML = "";
  REQUIRED_FIELD_OPTIONS.forEach((field) => {
    const wrap = document.createElement("label");
    wrap.className = "require-toggle";
    const label = document.createElement("span");
    label.textContent = field.label;
    const input = document.createElement("input");
    input.type = "checkbox";
    input.dataset.key = field.key;
    input.checked = field.key === "phone";
    wrap.append(label, input);
    host.appendChild(wrap);
  });
}

function wireInputSync() {
  const slider = $("lead-limit-slider");
  const number = $("lead-limit-number");
  slider.addEventListener("input", () => {
    number.value = slider.value;
    updateConfigPreview();
  });
  number.addEventListener("input", () => {
    const value = clampLimit(Number(number.value || 1));
    number.value = String(value);
    slider.value = String(value);
    updateConfigPreview();
  });
}

function wireActions() {
  $("start-btn").addEventListener("click", startScraping);
  $("pause-btn").addEventListener("click", togglePause);
  $("stop-btn").addEventListener("click", stopProcess);
  $("new-search-btn").addEventListener("click", resetToConfig);
  $("download-csv-btn").addEventListener("click", exportCsv);
  $("quality-any").addEventListener("click", () => setRequiredMode("any"));
  $("quality-all").addEventListener("click", () => setRequiredMode("all"));
  $("select-essential-btn").addEventListener("click", () => setSelectedFieldKeys(ESSENTIAL_FIELD_KEYS));
  $("select-all-fields-btn").addEventListener("click", () => setSelectedFieldKeys(FIELD_OPTIONS.map((field) => field.key)));

  document.querySelectorAll(".chip[data-location]").forEach((button) => {
    button.addEventListener("click", () => {
      $("location").value = button.dataset.location || "";
    });
  });

  document.querySelectorAll('#field-toggles input[type="checkbox"], #required-toggles input[type="checkbox"]').forEach((input) => {
    input.addEventListener("change", updateConfigPreview);
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg?.action) return;
    if (msg.action === "PROGRESS_UPDATE") updateProgress(msg);
    if (msg.action === "PHASE_CHANGE") applyPhase(msg.phase);
    if (msg.action === "SCRAPING_COMPLETE") handleComplete(msg);
    if (msg.action === "ERROR") {
      showError(msg.message || "Unknown error");
      if (msg.message?.toLowerCase().includes("stopped")) setGlobalState("stopped");
    }
  });
}

async function restoreSession() {
  const { session } = await chrome.storage.local.get("session");
  if (!session) return applyPhase("config");
  currentSession = session;
  if (session.config) hydrateConfig(session.config);

  if (session.status === "scraping_maps" || session.status === "paused") {
    applyPhase("maps");
    updateMapsProgress(session.mapsCount || 0, session.config?.limit || 0, "Session restored");
    paused = session.status === "paused";
    $("pause-btn").textContent = paused ? "Resume" : "Pause";
    setGlobalState(paused ? "paused" : "running");
    return;
  }

  if (session.status === "complete") {
    handleComplete({
      totalLeads: session.mapsCount || 0,
      rowsWritten: session.mapsCount || 0,
      state: session.state || "completed"
    });
    return;
  }

  applyPhase("config");
}

function hydrateConfig(config) {
  $("keyword").value = config.keyword || "";
  $("location").value = config.location || "";
  $("lead-limit-number").value = String(config.limit || 100);
  $("lead-limit-slider").value = String(config.limit || 100);
  const selected = new Set((config.selectedFields || []).map((f) => f.key));
  document.querySelectorAll('#field-toggles input[type="checkbox"]').forEach((cb) => {
    cb.checked = selected.size ? selected.has(cb.dataset.key) : true;
  });
  const required = new Set(config.requiredFields || ["phone"]);
  document.querySelectorAll('#required-toggles input[type="checkbox"]').forEach((cb) => {
    cb.checked = required.has(cb.dataset.key);
  });
  setRequiredMode(config.requiredMode || "any");
  updateConfigPreview();
}

async function startScraping() {
  if (["running", "loading", "paused", "stopping", "stopping_flush"].includes(uiState)) return;
  clearError();
  const keyword = $("keyword").value.trim();
  const location = $("location").value.trim();
  const limit = clampLimit(Number($("lead-limit-number").value));
  const selectedFields = Array.from(document.querySelectorAll('#field-toggles input[type="checkbox"]'))
    .filter((cb) => cb.checked)
    .map((cb) => FIELD_OPTIONS.find((field) => field.key === cb.dataset.key))
    .filter(Boolean);
  const requiredFields = Array.from(document.querySelectorAll('#required-toggles input[type="checkbox"]'))
    .filter((cb) => cb.checked)
    .map((cb) => cb.dataset.key)
    .filter(Boolean);

  if (!keyword || !location) return showError("Keyword and location are required.");
  if (!requiredFields.length) return showError("Select at least one required lead info field.");
  if (!selectedFields.length) return showError("Select at least one data field.");
  const exportFields = ensureRequiredFieldsSelected(selectedFields, requiredFields);

  applyPhase("maps");
  setGlobalState("running");
  updateMapsProgress(0, limit, "Starting...");
  try {
    chrome.runtime.sendMessage({
      action: "START_SCRAPING",
      config: { keyword, location, limit, selectedFields: exportFields, requiredFields, requiredMode }
    });
  } catch (err) {
    showError(err?.message || "Could not start scraping.");
    setGlobalState("error");
  }
}

function togglePause() {
  if (uiState === "stopping" || uiState === "stopping_flush") return;
  paused = !paused;
  chrome.runtime.sendMessage({ action: paused ? "PAUSE" : "RESUME" });
  $("pause-btn").textContent = paused ? "Resume" : "Pause";
  setGlobalState(paused ? "paused" : "running");
  setMapsStateLabel(paused ? "Paused" : "Running");
}

function stopProcess() {
  setGlobalState("stopping");
  setMapsStateLabel("Stopping and exporting collected leads...");
  pushLog("Stop requested. Exporting collected leads...");
  chrome.runtime.sendMessage({ action: "STOP" });
}

async function resetToConfig() {
  paused = false;
  currentSession = null;
  $("pause-btn").textContent = "Pause";
  clearError();
  await chrome.storage.local.set({ session: { ...EMPTY_SESSION } });
  setGlobalState("idle");
  applyPhase("config");
}

function applyPhase(phase) {
  Object.values(screens).forEach((screen) => screen.classList.remove("active"));
  if (phase === "maps") screens.scraping.classList.add("active");
  else if (phase === "sheets") screens.writing.classList.add("active");
  else if (phase === "complete") screens.complete.classList.add("active");
  else screens.config.classList.add("active");
}

function updateProgress(msg) {
  if (msg.state) setGlobalState(msg.state);
  if (msg.phase === "maps") {
    updateMapsProgress(msg.count || 0, msg.total || 0, msg.currentBusiness || msg.status || "Working...");
    setMapsStateLabel(labelFromState(msg.state));
    pushLog(msg.status || `Scraping: ${msg.currentBusiness || "..."}`);
  }
  if (msg.phase === "sheets") {
    applyPhase("sheets");
    updateWritingProgress(msg.count || 0, msg.total || 0);
    setSheetsStateLabel(msg.status || labelFromState(msg.state));
  }
}

function updateMapsProgress(count, total, currentBusiness) {
  $("maps-counter").textContent = `${count} / ${total}`;
  $("maps-progress").style.width = `${total ? Math.min(100, Math.round((count / total) * 100)) : 0}%`;
  $("ticker").textContent = currentBusiness;
}

function updateWritingProgress(row, total) {
  $("sheets-counter").textContent = `Preparing CSV ${row} / ${total}...`;
  $("sheets-progress").style.width = `${total ? Math.min(100, Math.round((row / total) * 100)) : 0}%`;
}

function handleComplete(msg) {
  applyPhase("complete");
  const totalLeads = msg.totalLeads || 0;
  const rowsWritten = msg.rowsWritten ?? totalLeads;
  const doneState = msg.state || "completed";
  if (doneState === "stopped_saved") {
    $("complete-title").textContent = "Stopped Safely & Saved";
  } else if (doneState === "partial_completed") {
    $("complete-title").textContent = "Completed With Available Leads";
  } else if (doneState === "no_results") {
    $("complete-title").textContent = "No Leads Found";
  } else {
    $("complete-title").textContent = "Completed Successfully";
  }
  $("complete-summary").textContent = `${totalLeads} leads collected | ${rowsWritten} CSV rows exported`;
  setGlobalState(doneState);
}

function setGlobalState(state) {
  if (!state) return;
  uiState = state;
  const el = $("global-state");
  el.className = `state-pill ${state}`;
  el.textContent = prettifyState(state);
}

function prettifyState(state) {
  if (state === "running") return "Running";
  if (state === "paused") return "Paused";
  if (state === "stopping") return "Stopping";
  if (state === "stopping_flush") return "Saving";
  if (state === "completed") return "Completed";
  if (state === "partial_completed") return "Partial Saved";
  if (state === "no_results") return "No Results";
  if (state === "stopped_saved") return "Stopped & Saved";
  if (state === "stopped") return "Stopped";
  if (state === "error") return "Error";
  return "Idle";
}

function labelFromState(state) {
  if (state === "paused") return "Paused";
  if (state === "stopping") return "Stopping...";
  if (state === "stopping_flush") return "Saving collected leads...";
  if (state === "loading") return "Loading...";
  return "Running";
}

function setMapsStateLabel(text) {
  $("maps-state-label").textContent = text || "Running";
}

function setSheetsStateLabel(text) {
  $("sheets-state-label").textContent = text || "Generating CSV file";
}

function pushLog(line) {
  const ul = $("live-log");
  const li = document.createElement("li");
  li.textContent = line;
  ul.prepend(li);
  while (ul.children.length > 5) ul.removeChild(ul.lastChild);
}

async function exportCsv() {
  const { session } = await chrome.storage.local.get("session");
  const leads = session?.leads || [];
  if (!leads.length) return showError("No leads available to export.");
  const fields = Array.isArray(session?.config?.selectedFields) && session.config.selectedFields.length
    ? session.config.selectedFields
    : Object.keys(leads[0]).map((key) => ({ key, label: key }));
  const headers = ["#", ...fields.map((field) => csvCell(field.label))];
  const lines = ["sep=,", headers.join(",")];
  leads.forEach((lead, index) => {
    lines.push([String(index + 1), ...fields.map((field) => csvCell(lead[field.key]))].join(","));
  });
  const blob = new Blob([`\uFEFF${lines.join("\n")}`], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `lead-law-${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function csvCell(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function ensureRequiredFieldsSelected(selectedFields, requiredFields) {
  const fieldsByKey = new Map(selectedFields.map((field) => [field.key, field]));
  for (const key of requiredFields) {
    if (!fieldsByKey.has(key)) {
      const field = FIELD_OPTIONS.find((option) => option.key === key);
      if (field) fieldsByKey.set(key, field);
    }
  }
  return Array.from(fieldsByKey.values());
}

function setRequiredMode(mode) {
  requiredMode = mode === "all" ? "all" : "any";
  $("quality-any").classList.toggle("active", requiredMode === "any");
  $("quality-all").classList.toggle("active", requiredMode === "all");
  updateConfigPreview();
}

function setSelectedFieldKeys(keys) {
  const selected = new Set(keys);
  document.querySelectorAll('#field-toggles input[type="checkbox"]').forEach((cb) => {
    cb.checked = selected.has(cb.dataset.key);
  });
  updateConfigPreview();
}

function updateConfigPreview() {
  const limit = clampLimit(Number($("lead-limit-number")?.value || 100));
  const required = Array.from(document.querySelectorAll('#required-toggles input[type="checkbox"]'))
    .filter((cb) => cb.checked)
    .map((cb) => REQUIRED_FIELD_OPTIONS.find((field) => field.key === cb.dataset.key)?.label || cb.dataset.key);
  const selectedCount = Array.from(document.querySelectorAll('#field-toggles input[type="checkbox"]')).filter((cb) => cb.checked).length;

  $("config-limit-preview").textContent = String(limit);
  $("quality-preview").textContent = required.length ? `${requiredMode === "all" ? "All" : "Any"}: ${required.join("/")}` : "None";
  $("columns-count").textContent = `${selectedCount} selected`;
}

function showError(message) {
  const box = $("error-box");
  box.textContent = message;
  box.classList.remove("hidden");
}

function clearError() {
  const box = $("error-box");
  box.textContent = "";
  box.classList.add("hidden");
}

function clampLimit(value) {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.min(1000, Math.floor(value)));
}
