# =============================================================
#  HABER BOT — Dockerfile (üretim)
#
#  Çok aşamalı: derleme ağır (TypeScript + devDeps),
#  çalışma imajı yalın (sadece dist + prod bağımlılıkları).
# =============================================================

# ---- Aşama 1: derleme ---------------------------------------
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# Bağımlılıklar önce — kaynak değişince npm ci tekrar çalışmasın.
# Katman önbelleği sayesinde yeniden deploy çok daha hızlı olur.
COPY package.json package-lock.json ./

# sharp linux-x64 ikili dosyalarını indirir; ağ gerektirir.
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Üretim bağımlılıklarını temiz kur (devDeps çıkar)
RUN rm -rf node_modules && npm ci --omit=dev --no-audit --no-fund


# ---- Aşama 2: çalışma ---------------------------------------
FROM node:22-bookworm-slim AS runtime

# ffmpeg + ffprobe : video transcode ve poster üretimi
# ca-certificates  : HTTPS doğrulaması (R2, Supabase, SMTP) — ŞART
# tini             : PID 1 sinyal iletimi, zombi süreç temizliği
# curl             : healthcheck
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      ca-certificates \
      tini \
      curl \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

ENV NODE_ENV=production \
    TMP_DIR=/tmp/haberbot \
    HEALTH_PORT=8080 \
    NODE_OPTIONS="--max-old-space-size=2048" \
    UV_THREADPOOL_SIZE=6

WORKDIR /app

COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/package.json ./

RUN mkdir -p /tmp/haberbot && chown -R node:node /tmp/haberbot /app

# Derleme sırasında araçları doğrula. Yoksa imaj sessizce
# videosuz üretime gider ve bunu canlıda fark edersin.
RUN node -e "const {execFileSync}=require('child_process');\
execFileSync('ffmpeg',['-version'],{stdio:'ignore'});\
execFileSync('ffprobe',['-version'],{stdio:'ignore'});\
console.log('ffmpeg + ffprobe OK');\
const s=require('sharp');console.log('sharp OK vips',s.versions.vips)"

# Root olarak çalıştırma. Bir açık bulunsa bile yetki sınırlı kalsın.
USER node

EXPOSE 8080

# start-period uzun: ilk açılışta R2/SMTP/Supabase doğrulaması yapılıyor
HEALTHCHECK --interval=60s --timeout=10s --start-period=90s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/health || exit 1

# tini SIGTERM'i Node'a iletir → graceful shutdown çalışır
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
