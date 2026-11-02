FROM node:22-alpine AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY *.js *.d.ts ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY logo.png index.html styles.css related-chunk-workspace.css app.js ./
COPY manual-annotations.js bbox-mapping.js chunk-review-links.js context-generation-state.js ./
COPY pdf-render-coordinator.js pdf-surface.js related-chunk-candidates.js ./
COPY review-layout.js user-facing-errors.js batch-refresh.js ./
COPY table-editor-operations.js parent-context.js ./

EXPOSE 4180
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4180/api/health').then(response => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "dist/server.js"]
