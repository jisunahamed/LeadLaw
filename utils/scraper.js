function sanitizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizePhone(raw) {
  return sanitizeText(raw).replace(/[^\d+()\-.\s]/g, "");
}

function normalizeWebsite(url) {
  const cleaned = sanitizeText(url);
  if (!cleaned) return "";
  if (/^https?:\/\//i.test(cleaned)) return cleaned;
  return `https://${cleaned}`;
}

function uniqueLeadKey(lead) {
  return [sanitizeText(lead.name), sanitizeText(lead.address), normalizePhone(lead.phone)].join("|");
}

if (typeof module !== "undefined") {
  module.exports = {
    sanitizeText,
    normalizePhone,
    normalizeWebsite,
    uniqueLeadKey
  };
}
