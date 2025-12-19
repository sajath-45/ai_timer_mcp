"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseDurationSeconds = parseDurationSeconds;
exports.extractKeywordHeuristic = extractKeywordHeuristic;
exports.normalizeText = normalizeText;
function parseDurationSeconds(text) {
    const t = (text || "").toLowerCase();
    // Normalize common dash characters so time ranges parse reliably
    const normalized = t.replace(/[??]/g, "-");
    const nt = normalizeText(text);
    // "from 4:30 to 5:30" / "4.30 to 5.30"
    const range = normalized.match(/(?:from\s*)?(\d{1,2})[.:](\d{2})\s*(?:to|-)\s*(\d{1,2})[.:](\d{2})/);
    if (range) {
        const sh = Number(range[1]);
        const sm = Number(range[2]);
        const eh = Number(range[3]);
        const em = Number(range[4]);
        if (Number.isFinite(sh) &&
            Number.isFinite(sm) &&
            Number.isFinite(eh) &&
            Number.isFinite(em)) {
            const start = sh * 3600 + sm * 60;
            const end = eh * 3600 + em * 60;
            if (end >= start)
                return end - start;
        }
    }
    // German time ranges: "von acht uhr morgens bis halb eins", "von 8 uhr bis 12 30"
    const deRange = nt.match(/\bvon\s+(.{1,40}?)\s+bis\s+(.{1,40}?)(?:\s+(?:in|bei|auf|an|um|im)\b|$)/);
    if (deRange) {
        const startPhrase = deRange[1].trim();
        const endPhrase = deRange[2].trim();
        const wordToHour = (w) => {
            const map = {
                null: NaN,
                ein: 1,
                eins: 1,
                eine: 1,
                zwei: 2,
                drei: 3,
                vier: 4,
                funf: 5,
                fuenf: 5,
                sechs: 6,
                sieben: 7,
                acht: 8,
                neun: 9,
                zehn: 10,
                elf: 11,
                zwolf: 12,
                zwoelf: 12,
            };
            if (w in map)
                return map[w];
            if (/^\d{1,2}$/.test(w))
                return Number(w);
            return null;
        };
        const parseGermanClock = (phrase) => {
            const p = normalizeText(phrase);
            const meridian = p.match(/\b(morgens|nachmittags|abends|nachts)\b/)?.[1] ?? null;
            // Numeric: "8 uhr", "8 uhr 30", "8 30"
            let m = p.match(/\b(\d{1,2})\s*(?:uhr)?\s*(\d{2})\b/);
            if (m) {
                let hh = Number(m[1]);
                const mm = Number(m[2]);
                if (Number.isFinite(hh) && Number.isFinite(mm) && mm >= 0 && mm <= 59) {
                    if (meridian && (meridian === "nachmittags" || meridian === "abends") && hh < 12) {
                        hh += 12;
                    }
                    if (hh >= 0 && hh <= 23)
                        return hh * 60 + mm;
                }
            }
            // "acht uhr"
            m = p.match(/\b(\d{1,2})\s*uhr\b/);
            if (m) {
                let hh = Number(m[1]);
                if (meridian && (meridian === "nachmittags" || meridian === "abends") && hh < 12) {
                    hh += 12;
                }
                if (hh >= 0 && hh <= 23)
                    return hh * 60;
            }
            // Word hours with optional "uhr": "acht uhr", "elf"
            const firstWord = p.split(/\s+/)[0] || "";
            // "halb X" => (X-1):30
            m = p.match(/\bhalb\s+(\w+)\b/);
            if (m) {
                const h = wordToHour(m[1]);
                if (h != null) {
                    let hh = (h + 23) % 24; // h-1
                    if (meridian && (meridian === "nachmittags" || meridian === "abends") && hh < 12) {
                        hh += 12;
                    }
                    return hh * 60 + 30;
                }
            }
            // "viertel nach X" => X:15
            m = p.match(/\bviertel\s+nach\s+(\w+)\b/);
            if (m) {
                const h = wordToHour(m[1]);
                if (h != null) {
                    let hh = h % 24;
                    if (meridian && (meridian === "nachmittags" || meridian === "abends") && hh < 12) {
                        hh += 12;
                    }
                    return hh * 60 + 15;
                }
            }
            // "viertel vor X" => (X-1):45
            m = p.match(/\bviertel\s+vor\s+(\w+)\b/);
            if (m) {
                const h = wordToHour(m[1]);
                if (h != null) {
                    let hh = (h + 23) % 24;
                    if (meridian && (meridian === "nachmittags" || meridian === "abends") && hh < 12) {
                        hh += 12;
                    }
                    return hh * 60 + 45;
                }
            }
            // "dreiviertel X" or "drei viertel X" => (X-1):45
            m = p.match(/\b(?:dreiviertel|drei\s+viertel)\s+(\w+)\b/);
            if (m) {
                const h = wordToHour(m[1]);
                if (h != null) {
                    let hh = (h + 23) % 24;
                    if (meridian && (meridian === "nachmittags" || meridian === "abends") && hh < 12) {
                        hh += 12;
                    }
                    return hh * 60 + 45;
                }
            }
            // Single word hour like "acht" or "elf" with optional "uhr" omitted
            const h = wordToHour(firstWord);
            if (h != null) {
                let hh = h % 24;
                if (meridian && (meridian === "nachmittags" || meridian === "abends") && hh < 12) {
                    hh += 12;
                }
                return hh * 60;
            }
            return null;
        };
        const startMin = parseGermanClock(startPhrase);
        const endMin = parseGermanClock(endPhrase);
        if (startMin != null && endMin != null) {
            let startSec = startMin * 60;
            let endSec = endMin * 60;
            // If end is before start, assume same-day rollover (common for "halb eins")
            if (endSec < startSec) {
                const endPlus12 = endSec + 12 * 3600;
                endSec =
                    endPlus12 >= startSec && endPlus12 <= 24 * 3600
                        ? endPlus12
                        : endSec + 24 * 3600;
            }
            if (endSec >= startSec)
                return endSec - startSec;
        }
    }
    // "for 5 minutes" / "5 min" / "2 hours"
    const numUnit = t.match(/(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)\b/);
    if (numUnit) {
        const value = Number(numUnit[1]);
        const unit = numUnit[2];
        if (!Number.isFinite(value))
            return null;
        if (unit.startsWith("h"))
            return Math.round(value * 3600);
        if (unit.startsWith("m"))
            return Math.round(value * 60);
        return Math.round(value);
    }
    // German word numbers for units: "sieben minuten", "acht stunden"
    const deWordUnit = nt.match(/\b(ein|eins|eine|zwei|drei|vier|funf|fuenf|sechs|sieben|acht|neun|zehn|elf|zwolf|zwoelf)\s+(sekunden|sekunde|minuten|minute|stunden|stunde)\b/);
    if (deWordUnit) {
        const w = deWordUnit[1];
        const unit = deWordUnit[2];
        const map = {
            ein: 1,
            eins: 1,
            eine: 1,
            zwei: 2,
            drei: 3,
            vier: 4,
            funf: 5,
            fuenf: 5,
            sechs: 6,
            sieben: 7,
            acht: 8,
            neun: 9,
            zehn: 10,
            elf: 11,
            zwolf: 12,
            zwoelf: 12,
        };
        const value = map[w];
        if (unit.startsWith("stund"))
            return value * 3600;
        if (unit.startsWith("minut"))
            return value * 60;
        return value;
    }
    // Basic word numbers: "five minutes"
    const wordNum = t.match(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(seconds?|minutes?|hours?)\b/);
    if (wordNum) {
        const map = {
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
        if (unit.startsWith("hour"))
            return value * 3600;
        if (unit.startsWith("minute"))
            return value * 60;
        return value;
    }
    return null;
}
function extractKeywordHeuristic(text) {
    const raw = (text || "").trim();
    if (!raw)
        return null;
    const t = raw.replace(/\s+/g, " ");
    // Prefer "in X", "at X", "property X"
    const m = t.match(/\b(?:in|at)\s+([A-Za-z�-��-��-�0-9.\- ]{3,40})/i) ||
        t.match(/\bproperty\s+([A-Za-z�-��-��-�0-9.\- ]{3,40})/i);
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
    if (!candidates.length)
        return null;
    candidates.sort((a, b) => b.length - a.length);
    return candidates[0];
}
function normalizeText(text) {
    return text
        .toLowerCase()
        // Replace common German characters with ASCII to make regex parsing easier and deterministic.
        // Use explicit Unicode escapes to avoid editor/encoding issues.
        .replace(/[\u00e4\u00f6\u00fc\u00df]/g, (m) => {
        const map = {
            "\u00e4": "a", // �
            "\u00f6": "o", // �
            "\u00fc": "u", // �
            "\u00df": "ss", // �
        };
        return map[m] ?? m;
    })
        .replace(/[^a-z0-9\s]/g, "")
        .replace(/\s+/g, " ")
        .trim();
}
