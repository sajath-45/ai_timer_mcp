"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const express_1 = __importDefault(require("express"));
const workflow_1 = require("./workflow"); // <-- IMPORTANT
const db_tools_1 = require("./db-tools");
const workflow_new_1 = require("./workflow-new");
function safeJsonParse(text) {
    if (typeof text !== "string")
        return null;
    try {
        return JSON.parse(text);
    }
    catch {
        return null;
    }
}
const app = (0, express_1.default)();
app.use(express_1.default.json());
// Basic request logging
app.use((req, _res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
});
app.post("/process", async (req, res) => {
    try {
        const body = req.body;
        if (!body.input_as_text) {
            return res.status(400).json({ error: "input_as_text field is required" });
        }
        // Default: fast path (no LLM when confidence is strong)
        const result = await (0, workflow_1.runWorkflowFast)(body);
        console.log(`[${new Date().toISOString()}] /process success:`, result);
        res.status(200).json({
            success: true,
            result,
        });
    }
    catch (err) {
        console.error("Workflow execution failed:", err);
        res.status(500).json({ error: err.message });
    }
});
app.post("/process/fastv2", async (req, res) => {
    try {
        const body = req.body;
        if (!body.input_as_text) {
            return res.status(400).json({ error: "input_as_text field is required" });
        }
        const result = await (0, workflow_1.runWorkflowFastV2)(body);
        res.status(200).json({ success: true, result });
    }
    catch (err) {
        console.error("Workflow execution failed:", err);
        res.status(500).json({ error: err.message });
    }
});
// Explicit endpoints if you want to compare latency/accuracy
app.post("/process/accurate", async (req, res) => {
    try {
        const body = req.body;
        if (!body.input_as_text) {
            return res.status(400).json({ error: "input_as_text field is required" });
        }
        const result = await (0, workflow_1.runWorkflowAccurate)(body);
        res.status(200).json({ success: true, result });
    }
    catch (err) {
        console.error("Workflow execution failed:", err);
        res.status(500).json({ error: err.message });
    }
});
app.post("/process/optimized", async (req, res) => {
    try {
        const body = req.body;
        if (!body.input_as_text) {
            return res.status(400).json({ error: "input_as_text field is required" });
        }
        const result = await (0, workflow_1.runWorkflowOptimized)(body);
        res.status(200).json({ success: true, result });
    }
    catch (err) {
        console.error("Workflow execution failed:", err);
        res.status(500).json({ error: err.message });
    }
});
app.post("/process/hybrid", async (req, res) => {
    try {
        const body = req.body;
        if (!body.input_as_text) {
            return res.status(400).json({ error: "input_as_text field is required" });
        }
        const result = await (0, workflow_1.runWorkflowHybrid)(body);
        res.status(200).json({ success: true, result });
    }
    catch (err) {
        console.error("Workflow execution failed:", err);
        res.status(500).json({ error: err.message });
    }
});
app.post("/process/smart", async (req, res) => {
    try {
        const body = req.body;
        if (!body.input_as_text) {
            return res.status(400).json({ error: "input_as_text field is required" });
        }
        const result = await (0, workflow_1.runWorkSmart)(body);
        res.status(200).json({ success: true, result });
    }
    catch (err) {
        console.error("Workflow execution failed:", err);
        res.status(500).json({ error: err.message });
    }
});
app.post("/process/duration", async (req, res) => {
    try {
        const body = req.body;
        if (!body.input_as_text) {
            return res.status(400).json({ error: "input_as_text field is required" });
        }
        const result = await (0, workflow_new_1.extractDurationWithAgent)(body.input_as_text);
        res.status(200).json({ success: true, result });
    }
    catch (err) {
        console.error("Workflow execution failed:", err);
        res.status(500).json({ error: err.message });
    }
});
app.post("/process/property", async (req, res) => {
    try {
        const body = req.body;
        console.log("Database workflow input:", body);
        if (!body.input_as_text) {
            return res.status(400).json({ error: "input_as_text field is required" });
        }
        // First extract identifier (object_id vs property_name), then fetch details.
        // const identifier = await extractPropertyIdentifier(body);
        const result = await (0, workflow_new_1.extractPropertyDetailsFromIdentifier)(body.input_as_text);
        res.status(200).json({ success: true, result });
    }
    catch (err) {
        console.error("Database workflow execution failed:", err);
        res.status(500).json({ error: err.message });
    }
});
app.post("/process/remark", async (req, res) => {
    try {
        const body = req.body;
        if (!body.input_as_text) {
            return res.status(400).json({ error: "input_as_text field is required" });
        }
        const result = await (0, workflow_new_1.extractRemark)(body);
        res.status(200).json({ success: true, result });
    }
    catch (err) {
        console.error("Workflow execution failed:", err);
        res.status(500).json({ error: err.message });
    }
});
// Run multiple extraction workflows in parallel and merge results
app.post("/process/combined", async (req, res) => {
    try {
        const body = req.body;
        if (!body.input_as_text) {
            return res.status(400).json({ error: "input_as_text field is required" });
        }
        const startedAt = Date.now();
        // Run independent workflows in parallel; property_details depends on identifier.
        const identifierP = (0, workflow_new_1.extractPropertyIdentifier)(body);
        const durationP = (0, workflow_new_1.extractDurationWithAgent)(body.input_as_text);
        const remarkP = (0, workflow_new_1.extractRemark)(body);
        const detailsP = identifierP
            .then((r) => (0, workflow_new_1.extractPropertyDetailsDirectFromIdentifier)(r.output_text))
            .catch(() => (0, workflow_new_1.extractPropertyDetails)(body)); // fallback if identifier fails
        const [identifierR, durationR, remarkR, detailsR] = await Promise.allSettled([identifierP, durationP, remarkP, detailsP]);
        const identifier = identifierR.status === "fulfilled"
            ? safeJsonParse(identifierR.value.output_text) ??
                identifierR.value.output_text
            : null;
        const duration_seconds = durationR.status === "fulfilled" ? durationR.value : null;
        const remark = remarkR.status === "fulfilled"
            ? safeJsonParse(remarkR.value.output_text) ?? remarkR.value.output_text
            : null;
        const property_details = detailsR.status === "fulfilled"
            ? safeJsonParse(detailsR.value.output_text) ??
                detailsR.value.output_text
            : null;
        const errors = {
            property_identifier: identifierR.status === "rejected" ? String(identifierR.reason) : null,
            duration: durationR.status === "rejected" ? String(durationR.reason) : null,
            remark: remarkR.status === "rejected" ? String(remarkR.reason) : null,
            property_details: detailsR.status === "rejected" ? String(detailsR.reason) : null,
        };
        const tookMs = Date.now() - startedAt;
        console.log(`[${new Date().toISOString()}] /process/combined completed in ${tookMs}ms`);
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
    }
    catch (err) {
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
(0, db_tools_1.warmPropertyCache)();
