#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { db } from "./db-tools.js";

// Create MCP server
const server = new McpServer({
  name: "ai-workflow-mcp-server",
  version: "1.0.0",
});

// Tool 1: Find properties by name
server.tool(
  "find_property",
  "Find properties by name or partial name",
  {
    query: z.string().describe("Property name or partial name to search for"),
  },
  async (args) => {
    try {
      const [rows] = await db.query(
        "SELECT OBJ, Objektname, ObjekttypID FROM properties WHERE Objektname LIKE ? LIMIT 10",
        [`%${args.query}%`]
      );
      const resultRows = Array.isArray(rows) ? rows : [];
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ properties: resultRows }, null, 2),
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: "text",
            text: `Error: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// Tool 2: Get property by ID
server.tool(
  "get_property_by_id",
  "Get full property details by OBJ ID",
  {
    obj: z.string().describe("Property OBJ ID"),
  },
  async (args) => {
    try {
      const [rows] = await db.query(
        "SELECT * FROM properties WHERE OBJ = ? LIMIT 1",
        [args.obj]
      );
      const resultRows = Array.isArray(rows) ? rows : [];
      const property = resultRows.length ? resultRows[0] : null;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ property }, null, 2),
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: "text",
            text: `Error: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// Start MCP server with stdio transport
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.log(
    `[${new Date().toISOString()}] AI Workflow MCP server running on stdio`
  );
}

main().catch((error) => {
  console.error("Failed to start MCP server:", error);
  process.exit(1);
});
