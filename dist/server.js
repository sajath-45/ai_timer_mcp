"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const dotenv_1 = __importDefault(require("dotenv"));
const workflow_1 = require("./workflow"); // <-- IMPORTANT
const db_tools_1 = require("./db-tools");
dotenv_1.default.config();
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
