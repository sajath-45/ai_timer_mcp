"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.db = exports.getPropertyByIdTool = exports.findPropertyTool = void 0;
const promise_1 = __importDefault(require("mysql2/promise"));
const dotenv_1 = __importDefault(require("dotenv"));
const agents_1 = require("@openai/agents");
const zod_1 = require("zod");
dotenv_1.default.config();
// Configure DB connection pool
const db = promise_1.default.createPool({
    port: parseInt(process.env.MYSQL_PORT || "3306"),
    host: process.env.MYSQL_HOST || "localhost",
    user: process.env.MYSQL_USER || "root",
    password: process.env.MYSQL_PASSWORD || "",
    database: process.env.MYSQL_DATABASE || "propertydb",
    waitForConnections: true,
    connectionLimit: 10,
});
exports.db = db;
// Test database connection on module load
db.getConnection()
    .then((connection) => {
    console.log(`[${new Date().toISOString()}] Database connected: ${process.env.MYSQL_HOST}/${process.env.MYSQL_DATABASE}`);
    connection.release();
})
    .catch((error) => {
    console.error(`[${new Date().toISOString()}] Database connection failed:`, error.message);
});
// Tool 1: Find properties by name (for OpenAI Agents SDK)
exports.findPropertyTool = (0, agents_1.tool)({
    name: "find_property",
    description: "Find properties by name or partial name. Returns OBJ, objektname, and objekttypid for matching properties. Use this to search for properties when you have a property name or partial name.",
    parameters: zod_1.z.object({
        query: zod_1.z
            .string()
            .describe("Property name or partial name to search for (e.g., 'ABC123' or 'ABC')"),
    }),
    execute: async (input) => {
        console.log("findPropertyTool input:", input);
        try {
            const [rows] = await db.query(`
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
        `, [input.query, input.query, input.query]);
            const resultRows = Array.isArray(rows) ? rows : [];
            return JSON.stringify({ properties: resultRows }, null, 2);
        }
        catch (error) {
            throw new Error(`Database query failed: ${error.message}`);
        }
    },
});
// Tool 2: Get property by ID (for OpenAI Agents SDK)
exports.getPropertyByIdTool = (0, agents_1.tool)({
    name: "get_property_by_id",
    description: "Get full property details by OBJ ID. Returns all columns for the property. Use this when you have the exact OBJ ID from a previous search.",
    parameters: zod_1.z.object({
        obj: zod_1.z.string().describe("Property OBJ ID (e.g., '12345')"),
    }),
    execute: async (input) => {
        try {
            const [rows] = await db.query("SELECT * FROM properties WHERE OBJ = ? LIMIT 1", [input.obj]);
            const resultRows = Array.isArray(rows) ? rows : [];
            const property = resultRows.length ? resultRows[0] : null;
            if (!property) {
                return JSON.stringify({ property: null, message: "Property not found" }, null, 2);
            }
            return JSON.stringify({ property }, null, 2);
        }
        catch (error) {
            throw new Error(`Database query failed: ${error.message}`);
        }
    },
});
