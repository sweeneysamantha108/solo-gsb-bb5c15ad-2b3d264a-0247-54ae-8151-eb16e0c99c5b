# ---------- 1. Build the React client ----------
FROM node:20-alpine AS client-build
WORKDIR /build/client
COPY client/package.json client/package-lock.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

# ---------- 2. Install server production dependencies ----------
FROM node:20-alpine AS server-deps
WORKDIR /build/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

# ---------- 3. Runtime image ----------
FROM node:20-alpine
ENV NODE_ENV=production \
    PORT=8080
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app
COPY --from=server-deps /build/server/node_modules ./server/node_modules
COPY server/ ./server/
COPY --from=client-build /build/client/dist ./client/dist
USER app
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1
CMD ["node", "server/index.js"]
