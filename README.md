# AI Workflow Server

A hybrid server that supports both Express HTTP API and MCP (Model Context Protocol) server functionality.

## Features

- **Express HTTP API**: Traditional REST endpoints for workflow processing
- **MCP Server**: Model Context Protocol server for AI tool integration
- **Workflow Processing**: Extract property information and duration from text transcripts

## Installation

```bash
npm install
```

## Configuration

Copy `env.sample` to `.env` and fill in your secrets:

```bash
cp env.sample .env
```

Required environment variables:

- `OPENAI_API_KEY`: Your OpenAI API key
- `PORT`: Server port (default: 3000)
- `ENABLE_MCP_HTTP`: Set to "true" to enable MCP HTTP support in Express server (optional)

## Usage

### Express Server (HTTP API)

Start the Express server:

```bash
npm run dev        # Development mode
npm run build      # Build for production
npm start          # Production mode
```

The server will run on `http://localhost:3000` (or your configured PORT).

## Deploy as a Docker image (Docker registry)

### 1) Build the image locally

Run in Terminal (from `ai-workflow-server/`):

```bash
docker build -t ai-workflow-server:latest .
```

### 2) Run the container locally

The server expects environment variables (see `env.sample`). At minimum you?ll usually need:

- `OPENAI_API_KEY`
- `PORT` (optional; defaults to 3000)
- `MYSQL_HOST`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE` (needed for property search tools)

Run in Terminal:

```bash
docker run --rm -p 3000:3000 \
  -e OPENAI_API_KEY=YOUR_OPENAI_KEY \
  -e PORT=3000 \
  -e MYSQL_HOST=YOUR_DB_HOST \
  -e MYSQL_USER=YOUR_DB_USER \
  -e MYSQL_PASSWORD=YOUR_DB_PASSWORD \
  -e MYSQL_DATABASE=YOUR_DB_NAME \
  ai-workflow-server:latest
```

### 3) Tag + push to a registry

#### Docker Hub

```bash
docker login
docker tag ai-workflow-server:latest <dockerhub-username>/ai-workflow-server:latest
docker push <dockerhub-username>/ai-workflow-server:latest
```

#### GitHub Container Registry (GHCR)

```bash
docker login ghcr.io
docker tag ai-workflow-server:latest ghcr.io/<github-username-or-org>/ai-workflow-server:latest
docker push ghcr.io/<github-username-or-org>/ai-workflow-server:latest
```

#### AWS ECR (high level)

Create an ECR repo, login, then tag + push:

```bash
# login command varies by region/account; AWS CLI typically provides it:
# aws ecr get-login-password --region <region> | docker login --username AWS --password-stdin <account>.dkr.ecr.<region>.amazonaws.com

docker tag ai-workflow-server:latest <account>.dkr.ecr.<region>.amazonaws.com/ai-workflow-server:latest
docker push <account>.dkr.ecr.<region>.amazonaws.com/ai-workflow-server:latest
```

#### Endpoints

- `GET /` - Health check
- `POST /process` - Process workflow with text input
  ```json
  {
    "input_as_text": "Today I worked on property ABC123 from 2:30 to 3:15 fixing issues"
  }
  ```

### MCP Server (stdio transport)

Start the standalone MCP server:

```bash
npm run dev:mcp    # Development mode
npm run build      # Build first
npm run start:mcp  # Production mode
```

The MCP server communicates via stdio (stdin/stdout), which is the standard way MCP servers work.

#### MCP Tools

1. **run_workflow**: Process text input through the AI workflow

   - Input: `input_as_text` (string) - The transcript or text describing work done at a property
   - Output: JSON with extracted property information and duration

2. **extract_property_info**: Extract property name and duration from a text transcript
   - Input: `transcript` (string) - Text transcript describing work at a property
   - Output: Extracted property information

### Using MCP Server with MCP Clients

To use this MCP server with an MCP client (like Claude Desktop), add it to your MCP configuration:

```json
{
  "mcpServers": {
    "ai-workflow": {
      "command": "node",
      "args": ["/path/to/ai-workflow-server/dist/mcp-server.js"]
    }
  }
}
```

## Architecture

- `src/server.ts` - Express HTTP server with optional MCP HTTP support
- `src/mcp-server.ts` - Standalone MCP server using stdio transport
- `src/workflow.ts` - Core workflow logic for processing text
- `src/types.ts` - TypeScript type definitions

## Development

```bash
# Install dependencies
npm install

# Run Express server in development
npm run dev

# Run MCP server in development
npm run dev:mcp

# Build for production
npm run build
```

## Notes

- The MCP server uses stdio transport, which is the standard for MCP protocol
- The Express server can optionally enable MCP HTTP support, but stdio is recommended for MCP
- Both servers share the same workflow processing logic
- Tools are registered using Zod schemas for type safety
