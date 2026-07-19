# Standalone image for flect deploy. tsup bundles the @baseworks/* workspace deps
# into dist (see tsup.config.ts noExternal), so the runtime is just node + dist.
# Built in the publish flow: the package.json workspace:* deps resolve to their
# published versions (changeset) before `npm install` here — same as the other
# capability services (org-service etc.). Local dev uses the shared plane image.
FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json ./
RUN npm install

COPY tsconfig.json ./
COPY tsup.config.ts ./
COPY src ./src
RUN npm run build


FROM node:22-alpine
WORKDIR /app

# native/CJS externals kept out of the bundle (installed only if imported)
RUN npm install --prefix /app @libsql/client@^0.14.0 ioredis@^5.0.0 --omit=dev

RUN echo '{"type":"module"}' > package.json

COPY --from=builder /app/dist ./dist

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "dist/index.js"]
