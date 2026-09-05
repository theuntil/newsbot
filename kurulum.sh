#!/usr/bin/env bash
# =============================================================
#  HABER BOT — KURULUM
#  Kullanım:  bash kurulum.sh
# =============================================================
set -euo pipefail

C_OK="\033[0;32m"; C_ERR="\033[0;31m"; C_WARN="\033[1;33m"; C_OFF="\033[0m"
ok()   { echo -e "${C_OK}✓${C_OFF} $1"; }
err()  { echo -e "${C_ERR}✗${C_OFF} $1"; }
warn() { echo -e "${C_WARN}!${C_OFF} $1"; }

echo ""
echo "════════════════════════════════════════"
echo "  HABER BOT KURULUM"
echo "════════════════════════════════════════"
echo ""

# ---- 1. Node sürümü -----------------------------------------
if ! command -v node >/dev/null 2>&1; then
  err "Node.js bulunamadı. Node 20+ kur: https://nodejs.org"
  exit 1
fi
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" -lt 20 ]; then
  err "Node $NODE_MAJOR bulundu, en az 20 gerekli."
  exit 1
fi
ok "Node.js v$(node -p 'process.versions.node')"

# ---- 2. ffmpeg ----------------------------------------------
if command -v ffmpeg >/dev/null 2>&1 && command -v ffprobe >/dev/null 2>&1; then
  ok "ffmpeg hazır"
else
  warn "ffmpeg yok — video testleri atlanacak"
  case "$(uname -s)" in
    Darwin) echo "    Kurmak için:  brew install ffmpeg" ;;
    Linux)  echo "    Kurmak için:  sudo apt install ffmpeg" ;;
    *)      echo "    https://ffmpeg.org/download.html" ;;
  esac
  echo "    (Docker imajında ffmpeg zaten var — üretimi etkilemez)"
fi

# ---- 3. Bağımlılıklar ---------------------------------------
echo ""
echo "Bağımlılıklar kuruluyor..."
npm install --silent
ok "Paketler kuruldu"

# ---- 4. .env ------------------------------------------------
echo ""
if [ ! -f .env ]; then
  cp .env.example .env
  warn ".env oluşturuldu — DOLDURMAN GEREKİYOR"
  echo ""
  echo "   Doldurulacaklar:"
  echo "     IHA_USER_CODE / IHA_USER_NAME / IHA_USER_PASSWORD"
  echo "     SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY"
  echo "     S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY"
  echo "     SMTP_USER / SMTP_PASS"
  echo ""
  NEEDS_ENV=1
else
  ok ".env mevcut"
  MISSING=""
  for k in IHA_USER_CODE SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY \
           S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY CDN_BASE; do
    if ! grep -qE "^${k}=.+" .env 2>/dev/null; then
      MISSING="$MISSING $k"
    fi
  done
  if [ -n "$MISSING" ]; then
    warn "Eksik/boş değişkenler:$MISSING"
    NEEDS_ENV=1
  else
    ok "Zorunlu değişkenler dolu"
    NEEDS_ENV=0
  fi
fi

# ---- 5. Testler ---------------------------------------------
echo ""
echo "Testler çalışıyor..."
if npm test >/tmp/bot-test.log 2>&1; then
  TOTAL=$(grep -oE 'GEÇTİ: [0-9]+' /tmp/bot-test.log | grep -oE '[0-9]+' | awk '{s+=$1} END {print s}')
  ok "Tüm testler geçti (${TOTAL:-?} test)"
  if ! command -v ffmpeg >/dev/null 2>&1; then
    warn "Video testleri atlandı (ffmpeg yok)"
  fi
else
  err "Testler başarısız"
  echo ""
  grep -E "FAIL|Error:" /tmp/bot-test.log | head -10
  echo ""
  echo "  Tam çıktı: /tmp/bot-test.log"
  exit 1
fi

# ---- 6. Derleme ---------------------------------------------
echo ""
if npm run build >/dev/null 2>&1; then
  ok "TypeScript derlendi (dist/)"
else
  err "Derleme başarısız"
  exit 1
fi

# ---- 7. Özet ------------------------------------------------
echo ""
echo "════════════════════════════════════════"
if [ "${NEEDS_ENV:-1}" = "1" ]; then
  echo -e "  ${C_WARN}KURULUM TAMAM — .env DOLDUR${C_OFF}"
else
  echo -e "  ${C_OK}KURULUM TAMAM${C_OFF}"
fi
echo "════════════════════════════════════════"
echo ""
echo "  Sıradaki adımlar:"
echo ""
if [ "${NEEDS_ENV:-1}" = "1" ]; then
  echo "   1. .env dosyasını doldur"
  echo "   2. watchdog.sql'i Supabase SQL Editor'de çalıştır"
  echo "   3. Dokploy'a deploy et"
  echo "   4. Supabase'de botu aç:"
else
  echo "   1. watchdog.sql'i Supabase SQL Editor'de çalıştır"
  echo "   2. Dokploy'a deploy et"
  echo "   3. Supabase'de botu aç:"
fi
echo ""
echo "      update public.bot_settings set"
echo "        is_enabled  = true,"
echo "        alert_email = 'senin@mail.com'"
echo "      where id;"
echo ""
echo "   Yerelde denemek için:  npm start"
echo "   İzleme:  select * from public.bot_health;"
echo ""
