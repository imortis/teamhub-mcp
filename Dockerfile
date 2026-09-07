# For Glama's MCP server listing check (glama.ai/mcp/servers) - not used by
# npm installs, which get the prebuilt dist/ via `npx -y teamhub-mcp`
# instead. This exists only so an external scanner can build from source and
# confirm the server starts and answers MCP introspection.

FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
RUN npm ci && npm run build

FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY hooks ./hooks

# stdio MCP server, no network port. `initialize` and `tools/list` never
# resolve a repo (that only happens inside a tool call), so this answers
# introspection correctly even when run outside a git repository.
ENTRYPOINT ["node", "dist/index.js"]
