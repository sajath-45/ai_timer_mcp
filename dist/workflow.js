"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runWorkflowOptimized = void 0;
exports.runWorkflowFast = runWorkflowFast;
exports.runWorkflowFastV2 = runWorkflowFastV2;
exports.runWorkflowHybrid = runWorkflowHybrid;
exports.runWorkSmart = runWorkSmart;
exports.runWorkflowAccurate = runWorkflowAccurate;
const agents_1 = require("@openai/agents");
const db_tools_1 = require("./db-tools");
const helper_1 = require("./helper");
const workflow_new_1 = require("./workflow-new");
// Tool definitions - using MCP database tools instead of file search
const propertyTools = [db_tools_1.findPropertyTool, db_tools_1.getPropertyByIdTool];
const propertyAgent = new agents_1.Agent({
    name: "PropertyAgent",
    instructions: `You are a property search agent. Use the find_property tool to search for properties by name. 
If you find a matching property, you can use find_property to get full details.
Return the OBJ, Objektname, and ObjekttypID for the best matching property.
{{ nodes.ExtractPropertyName.output.query }}

 
Return ONLY JSON in exactly this structure:
{
  "obj": "<value or null>",
  "objektname": "<value or null>",
  "objekttypid": <number or null>,
  duration:  <duration passed in system message>,
}

When using the find_property tool, evaluate the returned list and pick 
the most semantically correct property based on the user's transcript 
and extracted keyword. Prefer matches where partial_match = 1 or phonetic_match = 1.

If no reasonable match, return null values.

`,
    model: "gpt-4o-mini",
    tools: propertyTools,
    modelSettings: {
        temperature: 0.7,
        maxTokens: 2048,
        store: true,
    },
});
const unifiedPropertyAgent = new agents_1.Agent({
    name: "PropertyTimeLogger",
    instructions: `You are a property time logging assistant. Given a transcript, extract:
1. Property name/keyword
2. Duration worked (in seconds)
3. Search database for matching property

EXTRACTION RULES:
- Property: Extract the most specific property identifier mentioned
  Examples: "worked at Trend property" ? "Trend"
           "fixed AC at Blue Tower" ? "Blue Tower"
- Duration: Convert to seconds
  - Time ranges: "2:30 to 3:15" = 45 minutes = 2700 seconds
  - Direct: "30 minutes" = 1800 seconds
  - Hours: "2 hours" = 7200 seconds

IMPORTANT: most of thr properties have a number after name for example Lusenweg 17 here 17 is the number and lusenweg is the name. so this is the final name do not be confused as 17 is the duration.

GERMAN TIME RANGE SUPPORT (CRITICAL):
- Handle German phrasing such as "von ... bis ..." and convert to seconds.
- Examples:
  - "von acht Uhr morgens bis halb eins" = 08:00 ? 12:30 = 4h30m = 16200 seconds
  - "von 8 Uhr bis 12:30" = 4h30m = 16200 seconds
  - "von 8:15 bis 10:00" = 6300 seconds
  - "von halb neun bis viertel nach zehn" = 08:30 ? 10:15 = 6300 seconds
  - "von viertel vor neun bis elf Uhr" = 08:45 ? 11:00 = 8100 seconds
- German clock rules:
  - "halb X" means 30 minutes BEFORE X (e.g. "halb zwei" = 01:30, "halb eins" = 12:30 in daytime context)
  - "viertel nach X" = X:15
  - "viertel vor X" = (X-1):45
  - "morgens" implies AM; "nachmittags/abends" implies PM

WORKFLOW:
1. Extract property keyword and duration from transcript
2. Use find_property tool to search database with the keyword
3. Pick the best match from results (prefer partial_match=1 or phonetic_match=1)
4. Return final JSON

OUTPUT FORMAT (strict JSON only):
{
  "obj": "<property_id or null>",
  "objektname": "<property_name or null>",
  "objekttypid": <type_id or null>,
  "duration": <seconds as number>
}

If no property match found, return null for obj/objektname/objekttypid but always include duration.`,
    model: "gpt-4o-mini",
    tools: [db_tools_1.findPropertyTool, db_tools_1.getPropertyByIdTool],
    modelSettings: {
        temperature: 0.3, // Lower for more consistent extraction
        maxTokens: 1024, // Reduced since we just need JSON
        store: true,
    },
});
// Single agent that does everything with advanced tools
const intelligentPropertyAgent = new agents_1.Agent({
    name: "AccuratePropertyLogger",
    instructions: `You are an expert at extracting property information from voice transcripts.

IMPORTANT: Voice transcripts may have errors due to:
- Accents and pronunciation differences
- Background noise  
- Speech-to-text mistakes
- Mumbling or unclear speech

Your job:
1. Extract the property name/keyword mentioned (be flexible with spelling)
2. Extract duration worked (in seconds)
3. Use search_property_fuzzy tool to find matching properties
4. **CRITICAL**: Make EXACTLY ONE call to search_property_fuzzy. Do NOT call it multiple times.
5. **CRITICAL**: Return ALL matches from that single tool call as alternatives (the tool result is already limited).

EXTRACTION RULES:
- Property: Look for any building/property identifier
  - "worked at trend" ? search "trend"
  - "rathald" ? search "rathald" (will find "Ratoldweg" via fuzzy match)
  - "blue tauer apartment" ? search "blue tower"
  
- Duration: Convert everything to seconds
  - "45 minutes" = 2700 seconds
  - "2:30 to 3:15" = 2700 seconds
  - "from 4.30 to 5.30" = 3600 seconds

MATCHING STRATEGY:
1. Call search_property_fuzzy once with:
   - query: your best extracted keyword
   - limit: 5
2. **ALWAYS include all returned matches in the alternatives array**
3. Pick the TOP match as the primary result
4. If top match has combined_score < 50, set confidence to "low"
5. If combined_score >= 75, set confidence to "high"
6. If combined_score 50-74, set confidence to "medium"

**CRITICAL OUTPUT RULES:**
- ALWAYS populate the "alternatives" array with ALL matches from the tool
- Even if you pick one as the best match, include the others
- Include match scores and match types in alternatives
- Never return empty alternatives if the tool returned matches

OUTPUT FORMAT (strict JSON):
{
  "obj": "<property_id or null>",
  "objektname": "<property_name or null>",
  "objekttypid": <type_id or null>,
  "duration": <seconds>,
  "confidence": "high|medium|low",
  "reasoning": "<short: why you picked this property; mention match score>",
  "alternatives": [
    {
      "obj": "<id>",
      "objektname": "<name>",
      "objekttypid": <type>,
      "match_score": <number>,
      "match_type": "<type>",
      "confidence": "<level>"
    }
  ]
}

EXAMPLE:
If tool returns 3 matches with scores [65, 45, 30], you should:
1. Pick the 65-score match as primary (confidence: "medium")
2. Include ALL 3 matches in alternatives array
3. Explain in reasoning: "Picked 'Property X' with match score of 65..."`,
    model: "gpt-4o-mini",
    tools: [db_tools_1.advancedPropertySearch],
    modelSettings: {
        temperature: 0.1, // Very low for consistency
        maxTokens: 700, // Keep output small for latency
    },
});
// OPTION 2: LLM-assisted (for complex/ambiguous cases) - ~2-5s
const smartAgent = new agents_1.Agent({
    name: "PropertyExtractor",
    instructions: `Extract property name and duration from transcript.

RULES:
1. Property name: Look for building/location identifiers
   - "working on Lucerneweg" ? search "Lucerneweg"
   - "at Blue Tower" ? search "Blue Tower"
   - Ignore generic words like "property", "building"

2. Duration: Convert to seconds
   - "87 minutes and 3 seconds" ? 5223
   - "from 4:30 to 5:30" ? 3600
   - "2 hours" ? 7200

3. Call search_property_fuzzy ONCE with extracted keyword

4. Pick best match from results based on:
   - combined_score (prefer 70+)
   - If all scores < 50, mark as low confidence

OUTPUT (strict JSON):
{
  "obj": "<id or null>",
  "objektname": "<name or null>",
  "objekttypid": <number or null>,
  "duration": <seconds>,
  "confidence": "high|medium|low",
  "reasoning": "<1 sentence: why this match, mention score>",
  "alternatives": [<all other matches from tool>]
}

CRITICAL: Include ALL matches from search tool in alternatives array.`,
    model: "gpt-4o-mini",
    tools: [db_tools_1.advancedPropertySearch],
    modelSettings: {
        temperature: 0.2,
        maxTokens: 800,
    },
});
function parseGermanHourWordToNumber(raw) {
    const w = raw
        .toLowerCase()
        .trim()
        .replace(/[.,;:!?"'()]/g, "")
        .replace(/�/g, "ae")
        .replace(/�/g, "oe")
        .replace(/�/g, "ue")
        .replace(/�/g, "ss");
    const map = {
        ein: 1,
        eins: 1,
        eine: 1,
        zwei: 2,
        drei: 3,
        vier: 4,
        fuenf: 5,
        funf: 5,
        sechs: 6,
        sieben: 7,
        acht: 8,
        neun: 9,
        zehn: 10,
        elf: 11,
        zwoelf: 12,
        zwolf: 12,
    };
    return map[w] ?? null;
}
function parseGermanTimeToMinutes(raw) {
    const s = (raw || "")
        .toLowerCase()
        .trim()
        .replace(/\s+/g, " ")
        .replace(/�/g, "ae")
        .replace(/�/g, "oe")
        .replace(/�/g, "ue")
        .replace(/�/g, "ss");
    // 8:15 / 8.15
    const hm = s.match(/\b(\d{1,2})\s*[.:]\s*(\d{2})\b/);
    if (hm) {
        const h = Number(hm[1]);
        const m = Number(hm[2]);
        if (Number.isFinite(h) && Number.isFinite(m))
            return h * 60 + m;
    }
    // "halb neun" => 08:30 (30 minutes before 9)
    const halb = s.match(/\bhalb\s+([a-z]+|\d{1,2})\b/);
    if (halb) {
        const hour = /^\d{1,2}$/.test(halb[1])
            ? Number(halb[1])
            : parseGermanHourWordToNumber(halb[1]);
        if (hour) {
            const prevHour = hour === 1 ? 12 : hour - 1;
            return prevHour * 60 + 30;
        }
    }
    // "viertel nach zehn" => 10:15
    const vNach = s.match(/\bviertel\s+nach\s+([a-z]+|\d{1,2})\b/);
    if (vNach) {
        const hour = /^\d{1,2}$/.test(vNach[1])
            ? Number(vNach[1])
            : parseGermanHourWordToNumber(vNach[1]);
        if (hour)
            return hour * 60 + 15;
    }
    // "viertel vor zwoelf" => 11:45
    const vVor = s.match(/\bviertel\s+vor\s+([a-z]+|\d{1,2})\b/);
    if (vVor) {
        const hour = /^\d{1,2}$/.test(vVor[1])
            ? Number(vVor[1])
            : parseGermanHourWordToNumber(vVor[1]);
        if (hour) {
            const prevHour = hour === 1 ? 12 : hour - 1;
            return prevHour * 60 + 45;
        }
    }
    // Approx phrases: "kurz nach eins" => 13:05-ish handled later with wrap logic; here we use +5 min
    const kurzNach = s.match(/\bkurz\s+nach\s+([a-z]+|\d{1,2})\b/);
    if (kurzNach) {
        const hour = /^\d{1,2}$/.test(kurzNach[1])
            ? Number(kurzNach[1])
            : parseGermanHourWordToNumber(kurzNach[1]);
        if (hour)
            return hour * 60 + 5;
    }
    const kurzVor = s.match(/\bkurz\s+vor\s+([a-z]+|\d{1,2})\b/);
    if (kurzVor) {
        const hour = /^\d{1,2}$/.test(kurzVor[1])
            ? Number(kurzVor[1])
            : parseGermanHourWordToNumber(kurzVor[1]);
        if (hour) {
            const prevHour = hour === 1 ? 12 : hour - 1;
            return prevHour * 60 + 55; // ~5 minutes before the hour
        }
    }
    // "acht uhr" / "8 uhr" / just "acht"
    const uhr = s.match(/\b([a-z]+|\d{1,2})\s*uhr\b/);
    const bare = s.match(/^\s*([a-z]+|\d{1,2})\s*$/);
    const token = (uhr?.[1] ?? bare?.[1]) || null;
    if (token) {
        const hour = /^\d{1,2}$/.test(token)
            ? Number(token)
            : parseGermanHourWordToNumber(token);
        if (hour != null)
            return hour * 60;
    }
    return null;
}
function computeRangeSecondsFromMinutes(startMin, endMin) {
    let end = endMin;
    if (end < startMin) {
        // Most common ambiguity is 12h wrap: "von zehn bis zwei" => 10:00?14:00
        if (end + 12 * 60 >= startMin)
            end += 12 * 60;
        else
            end += 24 * 60;
    }
    return (end - startMin) * 60;
}
function parseDurationSeconds(text) {
    const t = (text || "").toLowerCase();
    const normalized = t.replace(/[??]/g, "-");
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
    // German time range: "von acht bis viertel vor zw�lf"
    const vonBis = t.match(/\bvon\s+(.+?)\s+bis\s+(.+?)(?:$|[.,;])/);
    if (vonBis) {
        const startMin = parseGermanTimeToMinutes(vonBis[1]);
        const endMin = parseGermanTimeToMinutes(vonBis[2]);
        if (startMin != null && endMin != null) {
            const seconds = computeRangeSecondsFromMinutes(startMin, endMin);
            if (seconds >= 0)
                return seconds;
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
/**
 * Extract duration using the dedicated duration extraction agent.
 * Falls back to parseDurationSeconds if agent fails.
 */
//others
function extractKeywordHeuristic(text) {
    const raw = (text || "").trim();
    if (!raw)
        return null;
    const t = raw.replace(/\s+/g, " ");
    // Prefer "in X", "at X", "property X"
    const m = t.match(/\b(?:in|at)\s+([A-Za-z�-��-��-�0-9.\- ]{3,40})/i) ||
        t.match(/\bproperty\s+([A-Za-z�-��-��-�0-9.\- ]{3,40})/i);
    if (m?.[1]) {
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
async function runWorkflowFast(workflow) {
    if (!workflow.input_as_text) {
        throw new Error("input_as_text is required");
    }
    const startedAt = Date.now();
    const transcript = workflow.input_as_text;
    let duration = parseDurationSeconds(transcript) ?? 0;
    const keyword = extractKeywordHeuristic(transcript);
    if (duration <= 0) {
        duration = (0, helper_1.parseDuration)(transcript);
    }
    if (duration <= 0) {
        duration = await (0, workflow_new_1.extractDurationWithAgent)(transcript);
    }
    if (keyword && duration > 0) {
        const search = await (0, db_tools_1.searchPropertyFuzzy)(keyword, 5);
        const top = search.matches?.[0];
        const topScore = Number(top?.combined_score ?? top?.db_score ?? 0);
        // If we have a strong match, return immediately (no LLM)
        if (top && topScore >= 65) {
            const output = {
                obj: top.obj ?? null,
                objektname: top.objektname ?? null,
                objekttypid: top.objekttypid ?? null,
                duration,
                confidence: topScore >= 75 ? "high" : "medium",
                reasoning: `Fast match on '${keyword}' (score ${topScore})`,
                alternatives: (search.matches || []).map((m) => ({
                    obj: m.obj,
                    objektname: m.objektname,
                    objekttypid: m.objekttypid,
                    match_score: m.combined_score ?? m.db_score ?? 0,
                    match_type: m.match_type ?? "unknown",
                    confidence: m.confidence ?? "low",
                })),
            };
            console.log(`[${new Date().toISOString()}] Fast workflow completed in ${Date.now() - startedAt}ms`);
            return { output_text: JSON.stringify(output, null, 2) };
        }
    }
    // Fallback to accurate agent when heuristic match isn't strong
    return await runWorkflowAccurate(workflow);
}
//use runworkflow accurate v2
//uses one agent
async function runWorkflowFastV2(workflow) {
    if (!workflow.input_as_text) {
        throw new Error("input_as_text is required");
    }
    const startedAt = Date.now();
    const transcript = workflow.input_as_text;
    const duration = parseDurationSeconds(transcript) ?? 0;
    const keyword = extractKeywordHeuristic(transcript);
    // Always return a structured response quickly (no LLM) for consistent latency.
    // If you need maximum accuracy, call /process/accurate instead.
    if (!keyword) {
        const output = {
            obj: null,
            objektname: null,
            objekttypid: null,
            duration,
            confidence: "low",
            reasoning: "Could not confidently extract a property keyword from transcript",
            alternatives: [],
        };
        console.log(`[${new Date().toISOString()}] Fast workflow completed in ${Date.now() - startedAt}ms (no keyword)`);
        return { output_text: JSON.stringify(output, null, 2) };
    }
    const search = await (0, db_tools_1.searchPropertyFuzzyNew)(keyword, 5);
    const top = search.matches?.[0];
    const topScore = Number(top?.combined_score ?? top?.db_score ?? 0);
    const confidence = topScore >= 75 ? "high" : topScore >= 50 ? "medium" : "low";
    const output = {
        obj: top?.obj ?? null,
        objektname: top?.objektname ?? null,
        objekttypid: top?.objekttypid ?? null,
        duration,
        confidence,
        reasoning: top
            ? `Fast match on '${keyword}' (score ${topScore}, method ${search.search_method})`
            : `No matches found for '${keyword}'`,
        alternatives: (search.matches || []).map((m) => ({
            obj: m.obj,
            objektname: m.objektname,
            objekttypid: m.objekttypid,
            match_score: m.combined_score ?? m.db_score ?? 0,
            match_type: m.match_type ?? "unknown",
            confidence: m.confidence ?? "low",
        })),
    };
    console.log(`[${new Date().toISOString()}] Fast workflow completed in ${Date.now() - startedAt}ms (keyword='${keyword}', topScore=${topScore})`);
    return { output_text: JSON.stringify(output, null, 2) };
}
//use runworkflow smart
async function runWorkflowHybrid(input) {
    const start = Date.now();
    const transcript = input.input_as_text;
    // Quick extraction
    const duration = (0, helper_1.parseDuration)(transcript);
    const keyword = (0, helper_1.extractKeyword)(transcript);
    if (!keyword) {
        // Fall back to LLM for complex cases
        console.log(`[${new Date().toISOString()}] No keyword found, using LLM...`);
        return runWorkflowAccurate(input);
    }
    const search = await (0, db_tools_1.searchPropertyFuzzyNew)(keyword, 5);
    const topScore = search.matches[0]?.combined_score || 0;
    // If high confidence, skip LLM
    if (topScore >= 70) {
        const top = search.matches[0];
        const output = {
            obj: top.obj,
            objektname: top.objektname,
            objekttypid: top.objekttypid,
            duration,
            confidence: "high",
            reasoning: `Direct match for '${keyword}' (score: ${topScore})`,
            alternatives: search.matches.slice(1, 5).map((m) => ({
                obj: m.obj,
                objektname: m.objektname,
                objekttypid: m.objekttypid,
                match_score: m.combined_score,
                match_type: m.match_type,
                confidence: m.confidence,
            })),
        };
        console.log(`[${new Date().toISOString()}] Hybrid (fast path): ${Date.now() - start}ms`);
        return { output_text: JSON.stringify(output, null, 2) };
    }
    // Medium/low confidence: use LLM to decide
    console.log(`[${new Date().toISOString()}] Low confidence (${topScore}), using LLM...`);
    return runWorkSmart(input);
}
async function runWorkSmart(input) {
    const start = Date.now();
    const runner = new agents_1.Runner();
    const result = await runner.run(smartAgent, [
        {
            role: "user",
            content: [{ type: "input_text", text: input.input_as_text }],
        },
    ]);
    if (!result.finalOutput) {
        throw new Error("Agent returned no output");
    }
    console.log(`[${new Date().toISOString()}] Accurate workflow: ${Date.now() - start}ms`);
    return { output_text: result.finalOutput };
}
//uses one agent
const runWorkflowOptimized = async (workflow) => {
    if (!workflow.input_as_text) {
        throw new Error("input_as_text is required");
    }
    console.log(`[${new Date().toISOString()}] Workflow start:`, workflow.input_as_text);
    return await (0, agents_1.withTrace)("PropertyTimeLog", async () => {
        const runner = new agents_1.Runner();
        // Single agent call instead of two
        const result = await runner.run(unifiedPropertyAgent, [
            {
                role: "user",
                content: [{ type: "input_text", text: workflow.input_as_text }],
            },
        ]);
        if (!result.finalOutput) {
            throw new Error("Agent returned no output");
        }
        console.log(`[${new Date().toISOString()}] Result:`, result.finalOutput);
        return {
            output_text: result.finalOutput,
        };
    });
};
exports.runWorkflowOptimized = runWorkflowOptimized;
async function runWorkflowAccurate(workflow) {
    if (!workflow.input_as_text) {
        throw new Error("input_as_text is required");
    }
    console.log(`[${new Date().toISOString()}] Accurate workflow:`, workflow.input_as_text);
    const startTime = Date.now();
    const runner = new agents_1.Runner();
    const result = await runner.run(intelligentPropertyAgent, [
        {
            role: "user",
            content: [
                {
                    type: "input_text",
                    text: workflow.input_as_text,
                },
            ],
        },
    ]);
    if (!result.finalOutput) {
        throw new Error("Agent returned no output");
    }
    const duration = Date.now() - startTime;
    // DEBUG: Log the raw agent output
    console.log(`[${new Date().toISOString()}] Raw agent output:`, result.finalOutput);
    // DEBUG: Log tool calls
    if (result.newItems) {
        result.newItems.forEach((item, index) => {
            console.log(`[${new Date().toISOString()}] Item ${index}:`, JSON.stringify(item, null, 2));
        });
    }
    console.log(`[${new Date().toISOString()}] Completed in ${duration}ms`);
    return {
        output_text: result.finalOutput,
    };
}
