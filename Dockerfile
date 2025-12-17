#
# Multi-stage Docker build for ai-workflow-server (Express API)
#
# Build:
#   docker build -t ai-workflow-server:latest .
#
# Run:
#   docker run --rm -p 3000:3000 \
#     -e OPENAI_API_KEY=... \
#     -e MYSQL_HOST=... -e MYSQL_USER=... -e MYSQL_PASSWORD=... -e MYSQL_DATABASE=... \
#     ai-workflow-server:latest
#

FROM node:20-slim AS build

WORKDIR /app

# Install deps first for better layer caching
COPY package.json package-lock.json ./
RUN npm ci

# Copy source and build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build


FROM node:20-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production

# Install production deps only
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy compiled output
COPY --from=build /app/dist ./dist

# Optional: keep this file in the image if you rely on it for tooling/debug
COPY properties.json ./properties.json

EXPOSE 3000

# Express server (POST /process)
CMD ["node", "dist/server.js"]


