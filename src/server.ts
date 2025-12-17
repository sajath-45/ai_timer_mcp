import express, { Request, Response } from "express";
import dotenv from "dotenv";
import {
  runWorkflowOptimized,
  runWorkflowAccurate,
  runWorkflowFast,
} from "./workflow"; // <-- IMPORTANT
import { WorkflowInput } from "./types";
import { warmPropertyCache } from "./db-tools";

dotenv.config();
const app = express();
app.use(express.json());

// Basic request logging
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

app.post("/process", async (req: Request, res: Response) => {
  try {
    const body: WorkflowInput = req.body;

    if (!body.input_as_text) {
      return res.status(400).json({ error: "input_as_text field is required" });
    }

    // Default: fast path (no LLM when confidence is strong)
    const result = await runWorkflowFast(body);

    console.log(`[${new Date().toISOString()}] /process success:`, result);

    res.status(200).json({
      success: true,
      result,
    });
  } catch (err: any) {
    console.error("Workflow execution failed:", err);
    res.status(500).json({ error: err.message });
  }
});

// Explicit endpoints if you want to compare latency/accuracy
app.post("/process/accurate", async (req: Request, res: Response) => {
  try {
    const body: WorkflowInput = req.body;
    if (!body.input_as_text) {
      return res.status(400).json({ error: "input_as_text field is required" });
    }
    const result = await runWorkflowAccurate(body);
    res.status(200).json({ success: true, result });
  } catch (err: any) {
    console.error("Workflow execution failed:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/process/optimized", async (req: Request, res: Response) => {
  try {
    const body: WorkflowInput = req.body;
    if (!body.input_as_text) {
      return res.status(400).json({ error: "input_as_text field is required" });
    }
    const result = await runWorkflowOptimized(body);
    res.status(200).json({ success: true, result });
  } catch (err: any) {
    console.error("Workflow execution failed:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/", (_req, res) => {
  console.log(`[${new Date().toISOString()}] GET /`);
  res.send("AI Workflow backend running... (Express + MCP support)");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running at port: ${PORT}`);
});

// Best-effort warmup so first fuzzy fallback is fast
warmPropertyCache();
