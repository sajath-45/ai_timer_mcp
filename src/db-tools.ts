import mysql from "mysql2/promise";
import dotenv from "dotenv";
import { tool } from "@openai/agents";
import { z } from "zod";
import { compareTwoStrings } from "string-similarity";
import { normalizeText } from "./helper";

dotenv.config();

// Cache all properties for string similarity matching
let cachedProperties: Array<{
  obj: string;
  objektname: string;
  objekttypid: number;
  normalized: string; // Pre-normalized for faster matching
}> = [];
let lastCacheTime = 0;
const CACHE_TTL = 3600000; // 1 hour

// Configure DB connection pool
const db = mysql.createPool({
  port: parseInt(process.env.MYSQL_PORT || "3306"),
  host: process.env.MYSQL_HOST || "localhost",
  user: process.env.MYSQL_USER || "root",
  password: process.env.MYSQL_PASSWORD || "",
  database: process.env.MYSQL_DATABASE || "propertydb",
  waitForConnections: true,
  connectionLimit: 10,
});

// Test database connection on module load
db.getConnection()
  .then((connection) => {
    console.log(
      `[${new Date().toISOString()}] Database connected: ${
        process.env.MYSQL_HOST
      }/${process.env.MYSQL_DATABASE}`
    );
    connection.release();
  })
  .catch((error) => {
    console.error(
      `[${new Date().toISOString()}] Database connection failed:`,
      error.message
    );
  });

async function loadAllProperties() {
  const now = Date.now();

  if (cachedProperties.length > 0 && now - lastCacheTime < CACHE_TTL) {
    return cachedProperties;
  }

  console.log(`[${new Date().toISOString()}] Loading properties cache...`);

  const [rows] = await db.query(
    "SELECT obj, objektname, objekttypid FROM properties ORDER BY objektname"
  );

  cachedProperties = (Array.isArray(rows) ? rows : []).map((row: any) => ({
    obj: row.obj,
    objektname: row.objektname,
    objekttypid: row.objekttypid,
    normalized: normalizeText(row.objektname),
  }));

  lastCacheTime = now;
  console.log(
    `[${new Date().toISOString()}] Cached ${cachedProperties.length} properties`
  );

  return cachedProperties;
}

export async function warmPropertyCache(): Promise<void> {
  try {
    await loadAllProperties();
  } catch (e: any) {
    // Non-fatal: cache warmup is best-effort
    console.warn(
      `[${new Date().toISOString()}] Property cache warmup failed:`,
      e?.message ?? e
    );
  }
}

export async function searchPropertyFuzzy(
  query: string,
  limit: number = 3
): Promise<{
  query: string;
  matches: any[];
  total_found: number;
  search_method: "database_with_similarity" | "full_scan";
}> {
  const startedAt = Date.now();
  const safeLimit = Math.max(1, Math.min(50, Number(limit) || 3));
  const searchTerm = String(query ?? "")
    .toLowerCase()
    .trim();

  if (!searchTerm) {
    return {
      query: String(query ?? ""),
      matches: [],
      total_found: 0,
      search_method: "database_with_similarity",
    };
  }

  // Step 1: Database candidates (fast when it hits; still useful even without indexes)
  const [dbRows] = await db.query(
    `
    SELECT 
      obj,
      objektname,
      objekttypid,
      CASE 
        WHEN LOWER(objektname) = ? THEN 100
        WHEN LOWER(objektname) LIKE CONCAT(?, '%') THEN 90
        WHEN LOWER(objektname) LIKE CONCAT('%', ?, '%') THEN 80
        WHEN SOUNDEX(objektname) = SOUNDEX(?) THEN 70
        WHEN LOWER(objektname) REGEXP CONCAT('[[:<:]]', ?, '[[:>:]]') THEN 60
        ELSE 50
      END AS db_score,
      CASE 
        WHEN LOWER(objektname) = ? THEN 'exact'
        WHEN LOWER(objektname) LIKE CONCAT(?, '%') THEN 'starts_with'
        WHEN LOWER(objektname) LIKE CONCAT('%', ?, '%') THEN 'contains'
        WHEN SOUNDEX(objektname) = SOUNDEX(?) THEN 'phonetic'
        ELSE 'partial'
      END AS match_type
    FROM properties
    WHERE 
      LOWER(objektname) LIKE CONCAT('%', ?, '%')
      OR SOUNDEX(objektname) = SOUNDEX(?)
      OR LOWER(objektname) REGEXP CONCAT('[[:<:]]', ?, '[[:>:]]')
    ORDER BY db_score DESC
    LIMIT ?
    `,
    [
      searchTerm,
      searchTerm,
      searchTerm,
      searchTerm,
      searchTerm, // db_score checks
      searchTerm,
      searchTerm,
      searchTerm,
      searchTerm, // match_type checks
      searchTerm,
      searchTerm,
      searchTerm, // WHERE clause
      safeLimit * 1,
    ]
  );

  const dbMatches = Array.isArray(dbRows) ? (dbRows as any[]) : [];

  // Step 2: similarity enrichment
  const enrichedDbMatches = dbMatches.map((match) => {
    const similarity = compareTwoStrings(
      searchTerm,
      match.objektname.toLowerCase()
    );

    const queryWords = searchTerm.split(/\s+/).filter((w) => w.length >= 2);
    const nameWords = match.objektname.toLowerCase().split(/\s+/);
    const wordMatches = queryWords.filter((qw) =>
      nameWords.some((nw) => nw.includes(qw) || qw.includes(nw))
    ).length;
    const wordMatchRatio =
      queryWords.length > 0 ? wordMatches / queryWords.length : 0;

    const combinedScore =
      match.db_score * 0.5 +
      similarity * 100 * 0.3 +
      wordMatchRatio * 100 * 0.2;

    return {
      obj: match.obj,
      objektname: match.objektname,
      objekttypid: match.objekttypid,
      db_score: match.db_score,
      similarity_score: Math.round(similarity * 100),
      word_match_ratio: Math.round(wordMatchRatio * 100),
      combined_score: Math.round(combinedScore),
      match_type: match.match_type,
      confidence:
        combinedScore >= 75 ? "high" : combinedScore >= 50 ? "medium" : "low",
    };
  });

  enrichedDbMatches.sort((a, b) => b.combined_score - a.combined_score);

  // Step 3: fallback full scan (cached)
  const bestScore = enrichedDbMatches[0]?.combined_score || 0;

  if (bestScore < 40 || enrichedDbMatches.length === 0) {
    const allProperties = await loadAllProperties();
    const allSimilarities = allProperties.map((prop) => {
      const similarity = compareTwoStrings(
        searchTerm,
        prop.objektname.toLowerCase()
      );

      const queryWords = searchTerm.split(/\s+/).filter((w) => w.length >= 2);
      const nameWords = prop.objektname.toLowerCase().split(/\s+/);
      const wordMatches = queryWords.filter((qw) =>
        nameWords.some(
          (nw) =>
            nw.includes(qw) ||
            qw.includes(nw) ||
            compareTwoStrings(qw, nw) > 0.6
        )
      ).length;
      const wordMatchRatio =
        queryWords.length > 0 ? wordMatches / queryWords.length : 0;

      const combinedScore = similarity * 70 + wordMatchRatio * 30;

      return {
        obj: prop.obj,
        objektname: prop.objektname,
        objekttypid: prop.objekttypid,
        similarity_score: Math.round(similarity * 100),
        word_match_ratio: Math.round(wordMatchRatio * 100),
        combined_score: Math.round(combinedScore),
        match_type:
          similarity > 0.8
            ? "high_similarity"
            : similarity > 0.6
            ? "medium_similarity"
            : wordMatchRatio > 0.6
            ? "word_match"
            : "weak_match",
        confidence:
          combinedScore >= 60
            ? "medium"
            : combinedScore >= 40
            ? "low"
            : "very_low",
      };
    });

    allSimilarities.sort((a, b) => b.combined_score - a.combined_score);
    const topMatches = allSimilarities
      .filter((m) => m.combined_score >= 25)
      .slice(0, safeLimit);

    const tookMs = Date.now() - startedAt;
    if (tookMs > 500) {
      console.log(
        `[${new Date().toISOString()}] searchPropertyFuzzy(full_scan) took ${tookMs}ms`
      );
    }

    return {
      query,
      matches: topMatches,
      total_found: topMatches.length,
      search_method: "full_scan",
    };
  }

  const tookMs = Date.now() - startedAt;
  if (tookMs > 500) {
    console.log(
      `[${new Date().toISOString()}] searchPropertyFuzzy(db) took ${tookMs}ms`
    );
  }

  return {
    query,
    matches: enrichedDbMatches.slice(0, safeLimit),
    total_found: Math.min(enrichedDbMatches.length, safeLimit),
    search_method: "database_with_similarity",
  };
}

export async function searchPropertyFuzzyNew(
  query: string,
  limit: number = 3
): Promise<{
  query: string;
  matches: any[];
  total_found: number;
  search_method: string;
}> {
  const startedAt = Date.now();
  const safeLimit = Math.max(1, Math.min(50, Number(limit) || 3));
  const searchTerm = normalizeText(query);

  if (!searchTerm) {
    return {
      query: String(query ?? ""),
      matches: [],
      total_found: 0,
      search_method: "empty_query",
    };
  }

  // Step 1: Try database exact/prefix matches first (fastest)
  const [dbRows] = await db.query(
    `
    SELECT 
      obj,
      objektname,
      objekttypid,
      CASE 
        WHEN LOWER(objektname) = ? THEN 100
        WHEN LOWER(objektname) LIKE CONCAT(?, '%') THEN 90
        WHEN LOWER(objektname) LIKE CONCAT('%', ?, '%') THEN 80
        ELSE 50
      END AS db_score
    FROM properties
    WHERE 
      LOWER(objektname) LIKE CONCAT('%', ?, '%')
    ORDER BY db_score DESC
    LIMIT ?
    `,
    [searchTerm, searchTerm, searchTerm, searchTerm, safeLimit]
  );

  const dbMatches = Array.isArray(dbRows) ? (dbRows as any[]) : [];

  // Step 2: Quick similarity scoring on DB results only
  const scoredMatches = dbMatches.map((match) => {
    const normalized = normalizeText(match.objektname);
    const similarity = compareTwoStrings(searchTerm, normalized);

    // Extract base name without numbers for better matching
    const baseName = normalized.replace(/\s*\d+.*$/, "");
    const queryBase = searchTerm.replace(/\s*\d+.*$/, "");
    const baseMatch = compareTwoStrings(queryBase, baseName);

    const combinedScore =
      match.db_score * 0.4 + similarity * 100 * 0.35 + baseMatch * 100 * 0.25;

    return {
      obj: match.obj,
      objektname: match.objektname,
      objekttypid: match.objekttypid,
      similarity_score: Math.round(similarity * 100),
      base_match_score: Math.round(baseMatch * 100),
      combined_score: Math.round(combinedScore),
      match_type:
        similarity > 0.8 ? "exact" : similarity > 0.6 ? "high" : "partial",
      confidence:
        combinedScore >= 75 ? "high" : combinedScore >= 50 ? "medium" : "low",
    };
  });

  scoredMatches.sort((a, b) => b.combined_score - a.combined_score);

  // Step 3: ONLY do full scan if NO good matches found
  const bestScore = scoredMatches[0]?.combined_score || 0;

  if (bestScore < 60 && scoredMatches.length < 3) {
    console.log(
      `[${new Date().toISOString()}] Low confidence (${bestScore}), doing cached scan...`
    );

    const allProperties = await loadAllProperties();

    // Use pre-normalized cache for faster comparison
    const allScored = allProperties.map((prop) => {
      const similarity = compareTwoStrings(searchTerm, prop.normalized);

      const baseName = prop.normalized.replace(/\s*\d+.*$/, "");
      const queryBase = searchTerm.replace(/\s*\d+.*$/, "");
      const baseMatch = compareTwoStrings(queryBase, baseName);

      const combinedScore = similarity * 60 + baseMatch * 40;

      return {
        obj: prop.obj,
        objektname: prop.objektname,
        objekttypid: prop.objekttypid,
        similarity_score: Math.round(similarity * 100),
        base_match_score: Math.round(baseMatch * 100),
        combined_score: Math.round(combinedScore),
        match_type: similarity > 0.7 ? "high_similarity" : "fuzzy_match",
        confidence:
          combinedScore >= 60
            ? "medium"
            : combinedScore >= 40
            ? "low"
            : "very_low",
      };
    });

    allScored.sort((a, b) => b.combined_score - a.combined_score);
    const topMatches = allScored
      .filter((m) => m.combined_score >= 30)
      .slice(0, safeLimit);

    console.log(
      `[${new Date().toISOString()}] Full scan took ${Date.now() - startedAt}ms`
    );

    return {
      query,
      matches: topMatches,
      total_found: topMatches.length,
      search_method: "full_scan",
    };
  }

  console.log(
    `[${new Date().toISOString()}] DB search took ${Date.now() - startedAt}ms`
  );

  return {
    query,
    matches: scoredMatches.slice(0, safeLimit),
    total_found: scoredMatches.length,
    search_method: "database_optimized",
  };
}

// // Tool 1: Find properties by name (for OpenAI Agents SDK)
// export const findPropertyTool = tool({
//   name: "find_property",
//   description:
//     "Find properties by name or partial name. Returns OBJ, objektname, and objekttypid for matching properties. Use this to search for properties when you have a property name or partial name.",
//   parameters: z.object({
//     query: z
//       .string()
//       .describe(
//         "Property name or partial name to search for (e.g., 'ABC123' or 'ABC')"
//       ),
//   }),
//   execute: async (input) => {
//     console.log("findPropertyTool input:", input);
//     try {
//       const [rows] = await db.query(
//         `
//         SELECT
//           obj,
//           objektname,
//           objekttypid,
//           CASE WHEN LOWER(objektname) LIKE CONCAT('%', LOWER(?), '%') THEN 1 ELSE 0 END AS partial_match,
//           CASE WHEN SOUNDEX(objektname) = SOUNDEX(?) THEN 1 ELSE 0 END AS phonetic_match,
//           (1 - (LENGTH(REPLACE(LOWER(objektname), LOWER(?), '')) / LENGTH(objektname))) AS similarity_ratio
//         FROM properties
//         ORDER BY partial_match DESC, phonetic_match DESC, similarity_ratio DESC
//         LIMIT 5;
//         `,
//         [input.query, input.query, input.query]
//       );
//       const resultRows = Array.isArray(rows) ? rows : [];
//       return JSON.stringify({ properties: resultRows }, null, 2);
//     } catch (error: any) {
//       throw new Error(`Database query failed: ${error.message}`);
//     }
//   },
// });

// Tool 2: Get property by ID (for OpenAI Agents SDK)
export const getPropertyByIdTool = tool({
  name: "get_property_by_id",
  description:
    "Get full property details by OBJ ID. Returns all columns for the property. Use this when you have the exact OBJ ID from a previous search.",
  parameters: z.object({
    obj: z.string().describe("Property OBJ ID (e.g., '12345')"),
  }),
  execute: async (input) => {
    try {
      const [rows] = await db.query(
        "SELECT * FROM properties WHERE OBJ = ? LIMIT 1",
        [input.obj]
      );
      const resultRows = Array.isArray(rows) ? rows : [];
      const property = resultRows.length ? resultRows[0] : null;
      if (!property) {
        return JSON.stringify(
          { property: null, message: "Property not found" },
          null,
          2
        );
      }
      return JSON.stringify({ property }, null, 2);
    } catch (error: any) {
      throw new Error(`Database query failed: ${error.message}`);
    }
  },
});

// Tool 3: Advanced property  enhanced fuzzy search tool with multiple matching strategies
// Enhanced fuzzy search with hybrid approach
export const advancedPropertySearch = tool({
  name: "search_property_fuzzy",
  description: `Advanced property search using multiple fuzzy matching strategies:
- Exact match
- Partial match (contains)
- Phonetic match (SOUNDEX)
- String similarity (Levenshtein distance)
- Word-level matching
Returns top candidates with confidence scores and match details.`,
  parameters: z.object({
    query: z.string().describe("Property name or keyword to search"),
    limit: z.number().default(3).describe("Max results to return"),
  }),
  execute: async (input) => {
    try {
      console.log(
        `[${new Date().toISOString()}] Advanced fuzzy search:`,
        input.query
      );
      const result = await searchPropertyFuzzy(input.query, input.limit);
      return JSON.stringify(result, null, 2);
    } catch (error: any) {
      console.error(`[${new Date().toISOString()}] Search error:`, error);
      throw new Error(`Search failed: ${error.message}`);
    }
  },
});

// Export other tools...
export const findPropertyTool = tool({
  name: "find_property",
  description:
    "Find properties by name or partial name. Returns OBJ, objektname, and objekttypid for matching properties.",
  parameters: z.object({
    query: z.string().describe("Property name or partial name to search for"),
  }),
  execute: async (input) => {
    console.log("findPropertyTool input:", input);
    try {
      const [rows] = await db.query(
        `
        SELECT 
          obj, 
          objektname, 
          objekttypid,
          CASE WHEN LOWER(objektname) LIKE CONCAT('%', LOWER(?), '%') THEN 1 ELSE 0 END AS partial_match,
          CASE WHEN SOUNDEX(objektname) = SOUNDEX(?) THEN 1 ELSE 0 END AS phonetic_match
        FROM properties
        ORDER BY partial_match DESC, phonetic_match DESC
        LIMIT 5
        `,
        [input.query, input.query]
      );
      const resultRows = Array.isArray(rows) ? rows : [];
      return JSON.stringify({ properties: resultRows }, null, 2);
    } catch (error: any) {
      throw new Error(`Database query failed: ${error.message}`);
    }
  },
});

// Export database pool for direct use if needed
export { db };
