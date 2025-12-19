"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runWorkflowOptimized = void 0;
exports.extractDurationWithAgent = extractDurationWithAgent;
exports.runWorkflowFast = runWorkflowFast;
exports.runWorkflowFastV2 = runWorkflowFastV2;
exports.runWorkflowHybrid = runWorkflowHybrid;
exports.runWorkSmart = runWorkSmart;
exports.runWorkflowAccurate = runWorkflowAccurate;
const agents_1 = require("@openai/agents");
const db_tools_1 = require("./db-tools");
const zod_1 = require("zod");
const helper_1 = require("./helper");
// Tool definitions - using MCP database tools instead of file search
const propertyTools = [db_tools_1.findPropertyTool, db_tools_1.getPropertyByIdTool];
const fileSearch = (0, agents_1.fileSearchTool)(["vs_693419a3ede081919076f91a5989958d"]);
// Agents
const extractpropertyname = new agents_1.Agent({
    name: "ExtractPropertyName",
    instructions: `You will be given a transcript string describing work done at a property.
Your tasks:
1. Extract the property name or ID mentioned in the transcript.
    Extract the most likely property name keyword.  
    If the transcript uses generic words like "property", "building", "office", "apartment", "premises", etc., infer the keyword next to those words.

    Examples:
    "worked in trend property" -> "Trend"
     "trend 40mins" -> "trend"
    "fixed issue at the harmony building" -> "Harmony"
    "checked the ac in blue tower apartment" -> "Blue Tower"
    "visit to garden residence" -> "Garden Residence"

    If multiple words seem like part of the property name, keep the full phrase.
2. Extract the duration worked, in seconds.
Duration may appear in different formats:
- "120 seconds"
- "for 30 minutes"
- "for 2 hours"
- "from 4:30 to 5:30"
- "4.30 to 5.30"
- "at 15:00?17:20"
Rules for time range:
- If a start and end time are provided, compute duration in seconds.
- Time formats may vary (e.g., 4.30 = 4:30, 5.30 = 5:30).
- When no meridian is provided (am/pm), assume same period.
Return ONLY JSON in exactly this structure:
{
  "property": "<value or null>",
  "duration": <number or null>,
  "query": "Search the property list and return the record where Objektname best matches '<property>'. Return OBJ, Objektname, and ObjekttypID for that record."
}
Time calculation rules:
- Hours ? seconds (1h = 3600s)
- Minutes ? seconds (1m = 60s)
- If either start or end time missing ? return null
- If human-readable units are missing ? infer based on context
Example transcript:
"Today I worked on property ABC123 from 2:30 to 3:15 fixing issues"
Expected:
{
  "property": "ABC123",
  "duration": 2700,
  "query": "Search the property list and return the record where Objektname best matches 'ABC123'. Return OBJ, Objektname, and ObjekttypID for that record."
}`,
    model: "gpt-4o-mini",
    modelSettings: {
        temperature: 1,
        topP: 1,
        maxTokens: 2048,
        store: true,
    },
});
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
const jsonSchema = zod_1.z.object({
    obj: zod_1.z.string(),
    objektname: zod_1.z.string(),
    objekttypid: zod_1.z.number(),
    duration: zod_1.z.number(),
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
// Dedicated agent for duration extraction only
const durationExtractionAgent = new agents_1.Agent({
    name: "DurationExtractor",
    instructions: `You are a duration extraction specialist. Your ONLY job is to extract the duration worked (in seconds) from a transcript.

EXTRACTION RULES:
1. Time ranges: Calculate the difference
   - "from 4:30 to 5:30" = 1 hour = 3600 seconds
   - "4.30 to 5.30" = 3600 seconds
   - "2:15 to 3:45" = 1.5 hours = 5400 seconds
   - "at 15:00?17:20" = 2h20m = 8400 seconds

2. Direct duration expressions:
   - "for 30 minutes" = 1800 seconds
   - "45 minutes" = 2700 seconds
   - "2 hours" = 7200 seconds
   - "87 minutes and 3 seconds" = 5223 seconds
   - "1.5 hours" = 5400 seconds

3. Word numbers:
   - "five minutes" = 300 seconds
   - "two hours" = 7200 seconds
   - "thirty minutes" = 1800 seconds

4. German time expressions (CRITICAL):
   - "von 8 Uhr bis 12:30" = 08:00 to 12:30 = 4h30m = 16200 seconds
   - "von acht Uhr morgens bis halb eins" = 08:00 to 12:30 = 16200 seconds
   - "von halb neun bis viertel nach zehn" = 08:30 to 10:15 = 6300 seconds
   - "von viertel vor neun bis elf Uhr" = 08:45 to 11:00 = 8100 seconds
   
   German clock rules:
   - "halb X" = 30 minutes before X (e.g., "halb zwei" = 01:30, "halb eins" = 12:30)
   - "viertel nach X" = X:15
   - "viertel vor X" = (X-1):45
   - "morgens" = AM, "nachmittags/abends" = PM

5. Edge cases:
   - If no duration found, return 0
   - If ambiguous, pick the most reasonable interpretation
   - Ignore property names that might look like times (e.g., "Luzernweg 17" - 17 is part of property name, not duration)

OUTPUT FORMAT (strict JSON only, no other text):
{
  "duration": <number in seconds>
}

Examples:
Input: "worked at Trend property from 2:30 to 3:15"
Output: {"duration": 2700}

Input: "fixed AC for 45 minutes"
Output: {"duration": 2700}

Input: "von 8 Uhr bis 12:30"
Output: {"duration": 16200}

Input: "no time mentioned"
Output: {"duration": 0}`,
    model: "gpt-4o-mini",
    modelSettings: {
        temperature: 0.1, // Low temperature for consistent extraction
        maxTokens: 200, // Small output, just a number
        store: true,
    },
});
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
async function extractDurationWithAgent(transcript) {
    try {
        const runner = new agents_1.Runner();
        const result = await runner.run(durationExtractionAgent, [
            {
                role: "user",
                content: [{ type: "input_text", text: transcript }],
            },
        ]);
        if (result.finalOutput) {
            // Parse JSON response
            const parsed = JSON.parse(result.finalOutput);
            if (typeof parsed.duration === "number" && parsed.duration >= 0) {
                return parsed.duration;
            }
        }
    }
    catch (error) {
        console.warn(`[${new Date().toISOString()}] Duration agent failed, falling back to regex:`, error);
    }
    // Fallback to regex-based parsing
    return parseDurationSeconds(transcript) ?? 0;
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
