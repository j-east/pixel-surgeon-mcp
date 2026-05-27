FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -m -u 1987 mcp

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY dist/ dist/

RUN npm install -g mcp-proxy@3.0.3

USER mcp

CMD ["mcp-proxy", "node", "dist/index.js"]
