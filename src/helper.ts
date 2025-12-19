export function parseDurationSeconds(text: string): number | null {
  const t = (text || "").toLowerCase();
  // Normalize common dash characters so time ranges parse reliably
  const normalized = t.replace(/[??]/g, "-");

  // "from 4:30 to 5:30" / "4.30 to 5.30"
  const range = normalized.match(
    /(?:from\s*)?(\d{1,2})[.:](\d{2})\s*(?:to|-)\s*(\d{1,2})[.:](\d{2})/
  );
  if (range) {
    const sh = Number(range[1]);
    const sm = Number(range[2]);
    const eh = Number(range[3]);
    const em = Number(range[4]);
    if (
      Number.isFinite(sh) &&
      Number.isFinite(sm) &&
      Number.isFinite(eh) &&
      Number.isFinite(em)
    ) {
      const start = sh * 3600 + sm * 60;
      const end = eh * 3600 + em * 60;
      if (end >= start) return end - start;
    }
  }

  // "for 5 minutes" / "5 min" / "2 hours"
  const numUnit = t.match(
    /(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)\b/
  );
  if (numUnit) {
    const value = Number(numUnit[1]);
    const unit = numUnit[2];
    if (!Number.isFinite(value)) return null;
    if (unit.startsWith("h")) return Math.round(value * 3600);
    if (unit.startsWith("m")) return Math.round(value * 60);
    return Math.round(value);
  }

  // Basic word numbers: "five minutes"
  const wordNum = t.match(
    /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(seconds?|minutes?|hours?)\b/
  );
  if (wordNum) {
    const map: Record<string, number> = {
      one: 1,
      two: 2,
      three: 3,
      four: 4,
      five: 5,
      six: 6,
      seven: 7,
      eight: 8,
      nine: 9,
      ten: 10,
      eleven: 11,
      twelve: 12,
    };
    const value = map[wordNum[1]];
    const unit = wordNum[2];
    if (unit.startsWith("hour")) return value * 3600;
    if (unit.startsWith("minute")) return value * 60;
    return value;
  }

  return null;
}

export function extractKeywordHeuristic(text: string): string | null {
  const raw = (text || "").trim();
  if (!raw) return null;
  const t = raw.replace(/\s+/g, " ");

  // Prefer "in X", "at X", "property X"
  const m =
    t.match(/\b(?:in|at)\s+([A-Za-zÀ-ÖØ-öø-ÿ0-9.\- ]{3,40})/i) ||
    t.match(/\bproperty\s+([A-Za-zÀ-ÖØ-öø-ÿ0-9.\- ]{3,40})/i);

  if (m?.[1]) {
    // IMPORTANT: many properties include a number in the name (e.g. "Luzernweg 17").
    // Treat trailing numbers as part of the property name, not duration.
    return m[1]
      .replace(/\b(for|from|to)\b.*/i, "")
      .replace(/[^\p{L}\p{N}.\- ]/gu, "")
      .trim();
  }

  // Fallback: longest token-ish word
  const candidates = t
    .toLowerCase()
    .replace(/[^\p{L}\p{N}.\- ]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !/^\d+$/.test(w));
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.length - a.length);
  return candidates[0];
}

export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[äöüß]/g, (m) => ({ ä: "a", ö: "o", ü: "u", ß: "ss" }[m] || m))
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseDuration(text: string): number {
  const t = text.toLowerCase().normalize();

  // Time range: "from 4:30 to 5:30"
  const range = t.match(
    /(\d{1,2})[.:](\d{2})\s*(?:to|-|bis)\s*(\d{1,2})[.:](\d{2})/
  );
  if (range) {
    const start = Number(range[1]) * 3600 + Number(range[2]) * 60;
    const end = Number(range[3]) * 3600 + Number(range[4]) * 60;
    return end >= start ? end - start : 0;
  }

  // Direct time: "87 minutes and 3 seconds"
  let total = 0;
  const hours = t.match(/(\d+)\s*(?:hours?|hrs?|h\b)/);
  const minutes = t.match(/(\d+)\s*(?:minutes?|mins?|m\b)/);
  const seconds = t.match(/(\d+)\s*(?:seconds?|secs?|s\b)/);

  if (hours) total += Number(hours[1]) * 3600;
  if (minutes) total += Number(minutes[1]) * 60;
  if (seconds) total += Number(seconds[1]);

  return total;
}

export function extractKeyword(text: string): string | null {
  const cleaned = text.trim().replace(/\s+/g, " ");

  // Pattern: "working on X" or "at X"
  const match = cleaned.match(
    /\b(?:on|at|in)\s+([A-Za-zÀ-ÿ0-9.\-\s]{3,30}?)(?:\s+for|\s+from|$)/i
  );
  if (match?.[1]) {
    return match[1]
      .trim()
      .replace(/\s+\d+\s+(?:minutes?|seconds?|hours?).*$/i, "");
  }

  // Fallback: longest meaningful word
  const words = cleaned
    .replace(/[^\p{L}\p{N}\s.-]/gu, "")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !/^\d+$/.test(w));

  return words.length > 0 ? words.sort((a, b) => b.length - a.length)[0] : null;
}
