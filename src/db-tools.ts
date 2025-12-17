import mysql from "mysql2/promise";
import dotenv from "dotenv";
import { tool } from "@openai/agents";
import { z } from "zod";

dotenv.config();

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

// Tool 1: Find properties by name (for OpenAI Agents SDK)
export const findPropertyTool = tool({
  name: "find_property",
  description:
    "Find properties by name or partial name. Returns OBJ, objektname, and objekttypid for matching properties. Use this to search for properties when you have a property name or partial name.",
  parameters: z.object({
    query: z
      .string()
      .describe(
        "Property name or partial name to search for (e.g., 'ABC123' or 'ABC')"
      ),
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
          CASE WHEN SOUNDEX(objektname) = SOUNDEX(?) THEN 1 ELSE 0 END AS phonetic_match,
          (1 - (LENGTH(REPLACE(LOWER(objektname), LOWER(?), '')) / LENGTH(objektname))) AS similarity_ratio
        FROM properties
        ORDER BY partial_match DESC, phonetic_match DESC, similarity_ratio DESC
        LIMIT 5;
        `,
        [input.query, input.query, input.query]
      );
      const resultRows = Array.isArray(rows) ? rows : [];
      return JSON.stringify({ properties: resultRows }, null, 2);
    } catch (error: any) {
      throw new Error(`Database query failed: ${error.message}`);
    }
  },
});

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
export const advancedPropertySearch = tool({
  name: "search_property_fuzzy",
  description: `Search properties using multiple matching strategies:
- Exact match
- Partial match (contains)
- Phonetic match (SOUNDEX)
- Levenshtein distance (edit distance)
Returns top candidates with confidence scores.`,
  parameters: z.object({
    query: z.string().describe("Property name or keyword to search"),
    limit: z.number().default(10).describe("Max results to return"),
  }),
  execute: async (input) => {
    console.log(`[${new Date().toISOString()}] Fuzzy search:`, input.query);

    try {
      const searchTerm = input.query.toLowerCase().trim();

      // Multi-strategy SQL query
      const [rows] = await db.query(
        `
        SELECT 
          obj,
          objektname,
          objekttypid,
          -- Scoring system
          CASE 
            -- Exact match (highest score)
            WHEN LOWER(objektname) = ? THEN 100
            
            -- Starts with query (very high)
            WHEN LOWER(objektname) LIKE CONCAT(?, '%') THEN 90
            
            -- Contains query (high)
            WHEN LOWER(objektname) LIKE CONCAT('%', ?, '%') THEN 80
            
            -- Phonetic match (medium-high)
            WHEN SOUNDEX(objektname) = SOUNDEX(?) THEN 70
            
            -- Words match (medium)
            WHEN LOWER(objektname) REGEXP CONCAT('[[:<:]]', ?, '[[:>:]]') THEN 60
            
            ELSE 50
          END AS match_score,
          
          -- Edit distance (lower = better)
          -- Using simple length difference as proxy
          ABS(LENGTH(objektname) - LENGTH(?)) as length_diff,
          
          -- Mark match type for debugging
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
        
        ORDER BY 
          match_score DESC,
          length_diff ASC,
          objektname ASC
        
        LIMIT ?
        `,
        [
          searchTerm, // Exact match check
          searchTerm, // Starts with
          searchTerm, // Contains
          searchTerm, // Phonetic
          searchTerm, // Word boundary
          searchTerm, // Length diff
          searchTerm, // Match type - exact
          searchTerm, // Match type - starts
          searchTerm, // Match type - contains
          searchTerm, // Match type - phonetic
          searchTerm, // WHERE - contains
          searchTerm, // WHERE - soundex
          searchTerm, // WHERE - regexp
          input.limit,
        ]
      );

      const results = Array.isArray(rows) ? rows : [];

      console.log(
        `[${new Date().toISOString()}] Found ${results.length} matches`
      );

      // Add confidence levels
      const enrichedResults = results.map((r: any) => ({
        obj: r.obj,
        objektname: r.objektname,
        objekttypid: r.objekttypid,
        match_score: r.match_score,
        match_type: r.match_type,
        confidence:
          r.match_score >= 90 ? "high" : r.match_score >= 70 ? "medium" : "low",
      }));

      return JSON.stringify(
        {
          query: input.query,
          matches: enrichedResults,
          total_found: enrichedResults.length,
        },
        null,
        2
      );
    } catch (error: any) {
      throw new Error(`Search failed: ${error.message}`);
    }
  },
});

// Export database pool for direct use if needed
export { db };
