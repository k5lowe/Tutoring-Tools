# Hosted image for Tutoring Tools.
#
# Deliberately has no TeX installation. Templates are user-editable LaTeX, and
# compiling them server-side would let a visitor read files off the host with
# \input{/etc/passwd}. Without an engine the app serves the printable HTML page
# and the .tex download instead, which is the whole workflow minus one button.
#
# Node 22 provides SQLite in the standard library, so the optional
# better-sqlite3 fallback is skipped and the image needs no build toolchain.

FROM node:22-slim

ENV NODE_ENV=production \
    MULTI_USER=1 \
    PORT=4675 \
    TUTORING_TOOLS_DB=/data/tutoring-tools.db

WORKDIR /app

# Dependencies first, so a source-only change reuses this layer.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional && npm cache clean --force

COPY server ./server
COPY public ./public
COPY scripts ./scripts
COPY data/seed ./data/seed

# The database lives on a mounted volume; the container filesystem is not
# durable across deploys.
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]

EXPOSE 4675

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4675)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--no-warnings=ExperimentalWarning", "server/index.js"]
