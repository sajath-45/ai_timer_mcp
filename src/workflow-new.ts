import {
  Agent,
  AgentInputItem,
  Runner,
  withTrace,
  fileSearchTool,
} from "@openai/agents";
import { WorkflowInput, WorkflowResponse } from "./types";
import {
  advancedPropertySearch,
  findPropertyTool,
  getPropertyByIdTool,
  searchPropertyFuzzyNew,
} from "./db-tools";
import { parseDurationSeconds } from "./helper";

// Agent for extracting property from database based on location address
const propertyExtractionDbAgent = new Agent({
  name: "PropertyExtractorDb",
  instructions: `You are a property database lookup agent.
You will be given either:
1) The JSON output from PropertyIdentifierExtractor:
   {"type":"object_id","value":"10006"} OR {"type":"property_name","value":"Aidenbacher Str. 2"}
   (optionally along with the original transcript), OR
2) A raw transcript string (fallback mode).

Your job:
- If type == "object_id": call get_property_by_id with that OBJ and return the property details.
- If type == "property_name": call search_property_fuzzy ONCE with that address/name and pick the best match.
- If type/value is missing: try best-effort extraction from the transcript and then search.

Matching guidance (for property_name):
- Prefer the highest-scoring match (combined_score/db_score) and best match_type.
- Addresses can be abbreviated: "Str.", "Strasse/straﬂe", "weg", "allee", etc.
- House numbers like "Str. 2" are part of the property name.

OUTPUT (strict JSON only):
{
  "obj": "<id or null>",
  "objektname": "<name or null>",
  "objekttypid": <number or null>
}

If you used get_property_by_id and it returned a full property object, map it into obj/objektname/objekttypid.`,

  model: "gpt-4o-mini",
  tools: [advancedPropertySearch, findPropertyTool, getPropertyByIdTool],
  modelSettings: {
    temperature: 0.1,
    maxTokens: 300,
  },
});

// Agent for extracting a property identifier (object id OR property name/address) from transcript
const propertyIdentifierAgent = new Agent({
  name: "PropertyIdentifierExtractor",
  instructions: `You are a property identifier extraction specialist.
Your ONLY job is to extract either:
1) the property OBJECT ID (e.g. 10006), OR
2) the property NAME/ADDRESS (German-style address like "Aidenbacher Str. 2")
from a free-form employee transcript.

CRITICAL RULES:
- Output MUST be strict JSON only (no extra text).
- Return exactly ONE best identifier.
- If BOTH an object id and an address appear, prefer the OBJECT ID.
- Do NOT confuse duration/time values with object ids or house numbers.
  - "40 mins", "4 hours", "08:00", "11:45" are NOT object ids.
  - House numbers like "Str. 2" are part of an ADDRESS, not an object id.

HOW TO RECOGNIZE OBJECT ID:
- Usually a standalone numeric token (often 4-7 digits; commonly 5 digits here, e.g. 10006).
- Often appears with phrases like "in 10006", "at 10006", or alone in the sentence.

HOW TO RECOGNIZE PROPERTY NAME / ADDRESS:
- German addresses often contain tokens like:
  "str", "str.", "straﬂe/strasse", "weg", "allee", "platz", "ring", "gasse", "hof",
  plus a house number (e.g. "2", "11", "38") which is PART of the name.
- Examples: "Aidenbacher Str. 2", "Gabelsbergerstr. 11", "Christinastraﬂe 38".
- Keep the address as spoken/written (preserve abbreviations like "Str.").
- If only street is given and no number, still return the best address phrase.

OUTPUT FORMAT (strict JSON only):
{
  "type": "object_id" | "property_name" | null,
  "value": "<string or null>"
}

EXAMPLES:
Input: "i worked in Aidenbacher Str. 2 for 4 hours in cleaning"
Output: {"type":"property_name","value":"Aidenbacher Str. 2"}

Input: "40mins cleaning work in 10006"
Output: {"type":"object_id","value":"10006"}

Input: "worked at Frauenhoferstr. 2-4, St. Josef Stift from six in the morning until noon"
Output: {"type":"property_name","value":"Frauenhoferstr. 2-4, St. Josef Stift"}

If nothing can be inferred:
Output: {"type":null,"value":null}`,
  model: "gpt-4o-mini",
  modelSettings: {
    temperature: 0.1,
    maxTokens: 200,
    store: true,
  },
});

// Dedicated agent for duration extraction only
const durationExtractionAgent = new Agent({
  name: "DurationExtractor",
  instructions: `You are a duration extraction specialist. Your ONLY job is to extract the duration worked (in seconds) from a free-form transcript.

GENERAL RULES:
- The transcript can be in ANY language, accent, speed, or order (German, English, mixed, dialect, etc.).
- People may speak casually, skip words, or mix property info and time info.
- Your output must always be a single JSON object with a numeric "duration" field in SECONDS.
- Ignore addresses, house numbers and property IDs except to make sure you do NOT treat them as durations (e.g. "Luzernweg 17" ? 17 is NOT duration).

TIME RANGE PATTERNS:
- Compute end - start in seconds whenever you detect a clear start and end.
- Examples (all must be converted to seconds):
  - "from 4:30 to 5:30" ? 3600
  - "4.30 to 5.30" ? 3600
  - "2:15 to 3:45" ? 5400
  - "at 15:00?17:20" ? 8400

DIRECT DURATION EXPRESSIONS:
- Understand explicit durations and convert to seconds:
  - "for 30 minutes" ? 1800
  - "45 minutes" ? 2700
  - "2 hours" ? 7200
  - "87 minutes and 3 seconds" ? 5223
  - "one and a half hours" / "1.5 hours" ? 5400
  - Word numbers: "five minutes" ? 300, "two hours" ? 7200, "thirty minutes" ? 1800

GERMAN / NATURAL LANGUAGE TIME (CRITICAL):
- Support colloquial German time phrases and similar structures:
  - "von 8 Uhr bis 12:30" ? 08:00?12:30 = 16200
  - "von acht Uhr morgens bis halb eins" ? 08:00?12:30 = 16200
  - "von halb neun bis viertel nach zehn" ? 08:30?10:15 = 6300
  - "von viertel vor neun bis elf Uhr" ? 08:45?11:00 = 8100
- German clock rules:
  - "halb X" = 30 minutes BEFORE X (e.g. "halb zwei" = 01:30, "halb eins" = 12:30)
  - "viertel nach X" = X:15
  - "viertel vor X" = (X-1):45
  - "morgens" ? morning (AM), "nachmittags"/"abends" ? afternoon/evening (PM context)

ABSOLUTE MUST-PASS EXAMPLE (DO NOT GET THIS WRONG):
- "von acht bis viertel vor zwˆlf" means 08:00?11:45 = 3h45m = 13500 seconds.

REAL EMPLOYEE EXAMPLES (YOU MUST HANDLE CASES LIKE THESE):
- Employee 1: "Worked today at Gabelsbergerstraﬂe eleven from eight in the morning until twelve thirty."
  ? duration = 4.5 hours = 16200 seconds
- Employee 2: "I was at Martinweg six fixing the hallway lights, started around nine fifteen and finished close to eleven."
  ? duration ? 1 hour 45 minutes (9:15?11:00) = 6300 seconds (choose the most reasonable interpretation)
- Employee 3: "Did inspections at Max-Kˆhler-Straﬂe thirteen, Maxhˆhe, from ten to about two."
  ? duration ? 4 hours (10:00?14:00) = 14400 seconds
- Employee 4: "Cleaning job on Aidenbacher Straﬂe, number two, from seven thirty till ten."
  ? duration = 2.5 hours (07:30?10:00) = 9000 seconds
- Employee 5: "Garden maintenance at Aidenbacher Straﬂe four, worked from eight to eleven forty-five."
  ? duration = 3 hours 45 minutes (08:00?11:45) = 13500 seconds
- Employee 6: "War heute in der Christinastraﬂe achtunddreiﬂig, von halb neun bis kurz nach eins."
  ? treat "halb neun" ? 08:30, "kurz nach eins" ? 13:05 (or similar). Use a reasonable approximation and return seconds.
- Employee 7: "Maintenance shift at Frauenhoferstraﬂe two to four, St. Josef Stift, from six in the morning until noon."
  ? duration = 6 hours (06:00?12:00) = 21600 seconds

EDGE CASES:
- If you clearly detect a duration, always return it as an integer number of seconds.
- If timing is vague (e.g. "around", "about"), choose the most reasonable clear interpretation and still return a numeric duration.
- If you cannot find ANY duration information, return 0.

OUTPUT FORMAT (STRICT, NO EXTRA TEXT):
{
  "duration": <number in seconds>
}
`,
  model: "gpt-4o-mini",
  modelSettings: {
    temperature: 0.1, // Low temperature for consistent extraction
    maxTokens: 400, // Still small, but enough for complex reasoning
    store: true,
  },
});

// Dedicated agent for extracting a summarized work/task remark
const remarkExtractionAgent = new Agent({
  name: "RemarkExtractor",
  instructions: `You are a work-summary extraction specialist.
Your ONLY job is to extract what work/tasks the employee did and return a short summarized remark.

RULES:
- The transcript can be in ANY language/accent/speed and can mix address + time + work details.
- Ignore address/location/house numbers and ignore start/end times; only focus on the WORK performed.
- Output must be strict JSON only.
- Keep the remark concise (3-12 words), action-focused, and lowercase unless proper nouns are required.
- If multiple tasks are mentioned, merge them into a short phrase (e.g. "cleaning and waste management").
- If no task/work can be inferred, return an empty string.

OUTPUT FORMAT (strict JSON only):
{
  "remark": "<string>"
}

EXAMPLE:
Input: "Worked today at Gabelsbergerstraﬂe eleven from eight in the morning until twelve thirty. Routine cleaning and waste management."
Output: {"remark":"cleaning and waste management"}`,
  model: "gpt-4o-mini",
  modelSettings: {
    temperature: 0.2,
    maxTokens: 120,
    store: true,
  },
});

export async function extractDurationWithAgent(
  transcript: string
): Promise<number> {
  const startedAt = Date.now();
  try {
    // Deterministic parsing (fast + fixes common German quarter phrases like "viertel vor zwˆlf").
    const deterministic = parseDurationSeconds(transcript);

    const runner = new Runner();
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
        const tookSec = (Date.now() - startedAt) / 1000;
        // If we have a deterministic result and the agent likely mis-parsed, prefer deterministic.
        if (
          typeof deterministic === "number" &&
          deterministic > 0 &&
          Math.abs(parsed.duration - deterministic) >= 900
        ) {
          console.log(
            `[${new Date().toISOString()}] Duration workflow completed in ${tookSec.toFixed(
              3
            )}s (deterministic override)`
          );
          return deterministic;
        }
        console.log(
          `[${new Date().toISOString()}] Duration workflow completed in ${tookSec.toFixed(
            3
          )}s`
        );
        return parsed.duration;
      }
    }
  } catch (error) {
    console.warn(
      `[${new Date().toISOString()}] Duration agent failed, falling back to regex:`,
      error
    );
  }

  // Fallback to regex-based parsing
  const tookSec = (Date.now() - startedAt) / 1000;
  console.warn(
    `[${new Date().toISOString()}] Duration agent failed, falling back to regex:`,
    transcript
  );
  console.log(
    `[${new Date().toISOString()}] Duration workflow completed in ${tookSec.toFixed(
      3
    )}s (fallback)`
  );
  return parseDurationSeconds(transcript) ?? 0;
}

export async function extractPropertyDetails(
  input: WorkflowInput
): Promise<WorkflowResponse> {
  if (!input.input_as_text) {
    throw new Error("input_as_text is required");
  }

  const startedAt = Date.now();
  const runner = new Runner();
  const result = await runner.run(propertyExtractionDbAgent, [
    {
      role: "user",
      content: [{ type: "input_text", text: input.input_as_text }],
    },
  ]);

  const tookSec = (Date.now() - startedAt) / 1000;
  console.log(
    `[${new Date().toISOString()}] Property workflow completed in ${tookSec.toFixed(
      3
    )}s`
  );
  return { output_text: result.finalOutput };
}

function safeJsonParse<T = any>(text: unknown): T | null {
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function guessIdentifierFromRawText(raw: string): {
  type: string | null;
  value: string | null;
} {
  const s = String(raw ?? "").trim();
  if (!s) return { type: null, value: null };

  // Prefer obvious object IDs: standalone 4-7 digit token
  const idMatch = s.match(/\b(\d{4,7})\b/);
  if (idMatch) {
    const num = idMatch[1];
    // Avoid treating times like 08:00 as IDs (they won't match this regex due to ':')
    return { type: "object_id", value: num };
  }

  return { type: "property_name", value: s };
}

export async function extractPropertyDetailsFromIdentifier(
  identifierOutputText: string
): Promise<WorkflowResponse> {
  const parsed = safeJsonParse<{ type?: string | null; value?: string | null }>(
    identifierOutputText
  );
  const identifier =
    parsed && (parsed.type || parsed.value)
      ? { type: parsed.type ?? null, value: parsed.value ?? null }
      : guessIdentifierFromRawText(identifierOutputText);

  const startedAt = Date.now();
  const runner = new Runner();
  const result = await runner.run(propertyExtractionDbAgent, [
    {
      role: "user",
      content: [
        {
          type: "input_text",
          text: JSON.stringify({ identifier }),
        },
      ],
    },
  ]);

  const tookMs = Date.now() - startedAt;
  console.log(
    `[${new Date().toISOString()}] PropertyDetailsFromIdentifier workflow completed in ${tookMs}ms`
  );

  return { output_text: result.finalOutput };
}

type PropertyLite = { obj: string; objektname: string; objekttypid: number };
type PropertyAlt = PropertyLite & {
  combined_score?: number;
  db_score?: number;
  match_type?: string;
  confidence?: string;
};

function mapMatchToAlt(m: any): PropertyAlt {
  return {
    obj: String(m?.obj ?? ""),
    objektname: String(m?.objektname ?? ""),
    objekttypid: Number(m?.objekttypid ?? 0),
    combined_score:
      m?.combined_score != null ? Number(m.combined_score) : undefined,
    db_score: m?.db_score != null ? Number(m.db_score) : undefined,
    match_type: m?.match_type != null ? String(m.match_type) : undefined,
    confidence: m?.confidence != null ? String(m.confidence) : undefined,
  };
}

/**
 * Direct DB lookup (no second agent):
 * - If identifier is object_id: fetch by id; also provide alternatives via fuzzy search on objektname.
 * - If identifier is property_name: fuzzy search and pick highest combined_score; return top + 3 alternatives.
 */
export async function extractPropertyDetailsDirectFromIdentifier(
  identifierOutputText: string
): Promise<WorkflowResponse> {
  const startedAt = Date.now();

  const parsed = safeJsonParse<{ type?: string | null; value?: string | null }>(
    identifierOutputText
  );
  const identifier =
    parsed && (parsed.type || parsed.value)
      ? { type: parsed.type ?? null, value: parsed.value ?? null }
      : guessIdentifierFromRawText(identifierOutputText);

  let property_details: PropertyLite | null = null;
  let alternatives: PropertyAlt[] = [];

  if (identifier.type === "object_id" && identifier.value) {
    // 1) Exact lookup
    const raw = await (getPropertyByIdTool as any).execute({
      obj: String(identifier.value),
    });
    const byId = safeJsonParse<{ property?: any }>(raw);
    const p = byId?.property ?? null;
    if (p?.obj != null && p?.objektname != null && p?.objekttypid != null) {
      property_details = {
        obj: String(p.obj),
        objektname: String(p.objektname),
        objekttypid: Number(p.objekttypid),
      };

      // 2) Alternatives via fuzzy search on the found name (best-effort)
      const search = await searchPropertyFuzzyNew(
        property_details.objektname,
        10
      );
      const matches: PropertyAlt[] = (search.matches || []).map(mapMatchToAlt);
      // Remove the selected property itself from alternatives
      alternatives = matches
        .filter((m) => m.obj && m.obj !== property_details!.obj)
        .slice(0, 3);
    }
  } else if (identifier.type === "property_name" && identifier.value) {
    const search = await searchPropertyFuzzyNew(String(identifier.value), 10);
    const matches: PropertyAlt[] = (search.matches || []).map(mapMatchToAlt);
    matches.sort(
      (a, b) =>
        Number(b.combined_score ?? b.db_score ?? 0) -
        Number(a.combined_score ?? a.db_score ?? 0)
    );

    const top = matches[0];
    if (top?.obj) {
      property_details = {
        obj: top.obj,
        objektname: top.objektname,
        objekttypid: top.objekttypid,
      };
      alternatives = matches.slice(1, 4); // at least 3 if available
    }
  }

  const tookMs = Date.now() - startedAt;
  console.log(
    `[${new Date().toISOString()}] PropertyDetailsDirectFromIdentifier completed in ${tookMs}ms`
  );

  return {
    output_text: JSON.stringify(
      {
        property_details,
        alternatives,
      },
      null,
      2
    ),
  };
}

export async function extractPropertyIdentifier(
  input: WorkflowInput
): Promise<WorkflowResponse> {
  if (!input.input_as_text) {
    throw new Error("input_as_text is required");
  }

  const startedAt = Date.now();
  const runner = new Runner();
  const result = await runner.run(propertyIdentifierAgent, [
    {
      role: "user",
      content: [{ type: "input_text", text: input.input_as_text }],
    },
  ]);

  const tookMs = Date.now() - startedAt;
  console.log(
    `[${new Date().toISOString()}] PropertyIdentifier workflow completed in ${
      tookMs / 1000
    }s`
  );

  return { output_text: result.finalOutput };
}

export async function extractRemark(
  input: WorkflowInput
): Promise<WorkflowResponse> {
  if (!input.input_as_text) {
    throw new Error("input_as_text is required");
  }

  const startedAt = Date.now();
  const runner = new Runner();
  const result = await runner.run(remarkExtractionAgent, [
    {
      role: "user",
      content: [{ type: "input_text", text: input.input_as_text }],
    },
  ]);

  const tookSec = (Date.now() - startedAt) / 1000;
  console.log(
    `[${new Date().toISOString()}] Remark workflow completed in ${tookSec.toFixed(
      3
    )}s`
  );

  return { output_text: result.finalOutput };
}
