"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const dotenv_1 = __importDefault(require("dotenv"));
const https_1 = __importDefault(require("https"));
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
/**
 * Proxy endpoint: client uploads audio to this server, server forwards to OpenAI
 * POST /openai/audio/transcriptions
 *
 * This streams the multipart body directly (no multer needed) and injects the server API key.
 * Client should send multipart/form-data with:
 * - file: <audio file>
 * - model: gpt-4o-transcribe (or other supported)
 */
app.post("/openai/audio/transcriptions", (req, res) => {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        return res.status(500).json({ error: "OPENAI_API_KEY is not set" });
    }
    const contentType = req.headers["content-type"];
    if (!contentType || !String(contentType).includes("multipart/form-data")) {
        return res.status(400).json({
            error: "Expected multipart/form-data. Send fields like { model: 'gpt-4o-transcribe' } and file field named 'file'.",
        });
    }
    const upstreamHeaders = {
        authorization: `Bearer ${apiKey}`,
        "content-type": String(contentType),
    };
    // Preserve Content-Length if the client provided it (helps OpenAI + avoids chunking issues in some proxies)
    const contentLength = req.headers["content-length"];
    if (contentLength) {
        upstreamHeaders["content-length"] = String(contentLength);
    }
    const upstreamReq = https_1.default.request({
        method: "POST",
        hostname: "api.openai.com",
        path: "/v1/audio/transcriptions",
        headers: upstreamHeaders,
        timeout: 30000,
    }, (upstreamRes) => {
        res.status(upstreamRes.statusCode || 502);
        // Forward a minimal set of headers
        const upstreamContentType = upstreamRes.headers["content-type"];
        if (upstreamContentType) {
            res.setHeader("content-type", upstreamContentType);
        }
        upstreamRes.pipe(res);
    });
    upstreamReq.on("timeout", () => {
        upstreamReq.destroy(new Error("Upstream OpenAI request timed out"));
    });
    upstreamReq.on("error", (err) => {
        console.error(`[${new Date().toISOString()}] OpenAI transcription proxy error:`, err.message);
        if (!res.headersSent) {
            res.status(502).json({ error: "Upstream request failed" });
        }
        else {
            res.end();
        }
    });
    // If client disconnects, stop upstream
    req.on("close", () => {
        upstreamReq.destroy();
    });
    // Stream request body to OpenAI
    req.pipe(upstreamReq);
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
