# The board service: the sync server plus the built frontend, on one port.
FROM node:22-slim
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build
# rooms (SQLite) and uploads live here; mount a volume so they survive container restarts
ENV PORT=5858 DATA_DIR=/data
EXPOSE 5858
CMD ["node", "server/server.ts"]
