# Hongguo Drama 7.3: release source.
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data DOWNLOAD_DIR=/downloads
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
# Built and verified by the Linux release workflow; includes the ByteVC2 helper.
COPY build/ffmpeg/linux-x64/ /usr/local/bin/
COPY src/native/ ./src/native/
COPY server/ ./server/
COPY LICENSE NOTICE THIRD-PARTY-NOTICES.md ./
RUN test "$(uname -m)" = x86_64 && chmod 755 /usr/local/bin/ffmpeg /usr/local/bin/ffprobe /usr/local/bin/librempeg && mkdir /data /downloads && chown node:node /data /downloads
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.cjs"]
