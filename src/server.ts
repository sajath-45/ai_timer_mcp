import "dotenv/config";
import express, { Request, Response } from "express";
import {
  runWorkflowOptimized,
  runWorkflowAccurate,
  runWorkflowFast,
  runWorkflowHybrid,
  runWorkSmart,
  runWorkflowFastV2,
} from "./workflow"; // <-- IMPORTANT
import { WorkflowInput } from "./types";
import { warmPropertyCache } from "./db-tools";
import {
  extractDurationWithAgent,
  extractPropertyDetails,
  extractPropertyDetailsDirectFromIdentifier,
  extractPropertyDetailsFromIdentifier,
  extractPropertyIdentifier,
  extractRemark,
} from "./workflow-new";

function safeJsonParse<T = any>(text: unknown): T | null {
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

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

app.post("/process/fastv2", async (req: Request, res: Response) => {
  try {
    const body: WorkflowInput = req.body;
    if (!body.input_as_text) {
      return res.status(400).json({ error: "input_as_text field is required" });
    }
    const result = await runWorkflowFastV2(body);
    res.status(200).json({ success: true, result });
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

app.post("/process/hybrid", async (req: Request, res: Response) => {
  try {
    const body: WorkflowInput = req.body;
    if (!body.input_as_text) {
      return res.status(400).json({ error: "input_as_text field is required" });
    }
    const result = await runWorkflowHybrid(body);
    res.status(200).json({ success: true, result });
  } catch (err: any) {
    console.error("Workflow execution failed:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/process/smart", async (req: Request, res: Response) => {
  try {
    const body: WorkflowInput = req.body;
    if (!body.input_as_text) {
      return res.status(400).json({ error: "input_as_text field is required" });
    }
    const result = await runWorkSmart(body);
    res.status(200).json({ success: true, result });
  } catch (err: any) {
    console.error("Workflow execution failed:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/process/duration", async (req: Request, res: Response) => {
  try {
    const body: WorkflowInput = req.body;
    if (!body.input_as_text) {
      return res.status(400).json({ error: "input_as_text field is required" });
    }
    const result = await extractDurationWithAgent(body.input_as_text);
    res.status(200).json({ success: true, result });
  } catch (err: any) {
    console.error("Workflow execution failed:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/process/property", async (req: Request, res: Response) => {
  try {
    const body: WorkflowInput = req.body;
    console.log("Database workflow input:", body);
    if (!body.input_as_text) {
      return res.status(400).json({ error: "input_as_text field is required" });
    }
    // First extract identifier (object_id vs property_name), then fetch details.
    // const identifier = await extractPropertyIdentifier(body);
    const result = await extractPropertyDetailsFromIdentifier(
      body.input_as_text
    );
    res.status(200).json({ success: true, result });
  } catch (err: any) {
    console.error("Database workflow execution failed:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/process/remark", async (req: Request, res: Response) => {
  try {
    const body: WorkflowInput = req.body;
    if (!body.input_as_text) {
      return res.status(400).json({ error: "input_as_text field is required" });
    }
    const result = await extractRemark(body);
    res.status(200).json({ success: true, result });
  } catch (err: any) {
    console.error("Workflow execution failed:", err);
    res.status(500).json({ error: err.message });
  }
});

// Run multiple extraction workflows in parallel and merge results
app.post("/process/combined", async (req: Request, res: Response) => {
  try {
    const body: WorkflowInput = req.body;
    if (!body.input_as_text) {
      return res.status(400).json({ error: "input_as_text field is required" });
    }

    const startedAt = Date.now();

    // Run independent workflows in parallel; property_details depends on identifier.
    const identifierP = extractPropertyIdentifier(body);
    const durationP = extractDurationWithAgent(body.input_as_text);
    const remarkP = extractRemark(body);
    const detailsP = identifierP
      .then((r) => extractPropertyDetailsDirectFromIdentifier(r.output_text))
      .catch(() => extractPropertyDetails(body)); // fallback if identifier fails

    const [identifierR, durationR, remarkR, detailsR] =
      await Promise.allSettled([identifierP, durationP, remarkP, detailsP]);

    const identifier =
      identifierR.status === "fulfilled"
        ? safeJsonParse(identifierR.value.output_text) ??
          identifierR.value.output_text
        : null;
    const duration_seconds =
      durationR.status === "fulfilled" ? durationR.value : null;
    const remark =
      remarkR.status === "fulfilled"
        ? safeJsonParse(remarkR.value.output_text) ?? remarkR.value.output_text
        : null;
    const property_details =
      detailsR.status === "fulfilled"
        ? safeJsonParse(detailsR.value.output_text) ??
          detailsR.value.output_text
        : null;

    const errors = {
      property_identifier:
        identifierR.status === "rejected" ? String(identifierR.reason) : null,
      duration:
        durationR.status === "rejected" ? String(durationR.reason) : null,
      remark: remarkR.status === "rejected" ? String(remarkR.reason) : null,
      property_details:
        detailsR.status === "rejected" ? String(detailsR.reason) : null,
    };

    const tookMs = Date.now() - startedAt;
    console.log(
      `[${new Date().toISOString()}] /process/combined completed in ${tookMs}ms`
    );
    console.log("final result:", {
      property_details,
      duration_seconds,
      alternatives: [],
      remark,
      errors,
    });

    res.status(200).json({
      success: true,
      took_ms: tookMs,
      result: {
        property_details,
        duration_seconds,
        alternatives: [],
        remark,
        errors,
      },
    });
  } catch (err: any) {
    console.error("Combined workflow execution failed:", err);
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
