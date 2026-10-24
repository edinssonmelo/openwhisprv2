#!/usr/bin/env bash
#
# Openwhispr — instalador para macOS.
#
# Uso:
#   curl -fsSL https://openwhispr.com/install.sh | bash
#
# Qué hace:
#   1. Detecta arquitectura (Apple Silicon arm64 / Intel x64).
#   2. Descarga el último .dmg estable desde GitHub Releases.
#   3. Monta el .dmg y copia Openwhispr.app a /Applications.
#   4. Explica qué hacer si macOS bloquea la app (Gatekeeper).
#
# No hace nada con privilegios de root. No borra archivos del usuario.
# Cambia OWNER/REPO si tu repositorio de releases es distinto (o exporta OPENWHISPR_REPO).

set -euo pipefail

REPO="${OPENWHISPR_REPO:-openwhispr/openwhispr}"
APP_NAME="Openwhispr"
API_URL="https://api.github.com/repos/${REPO}/releases/latest"

info()  { printf '\033[1;34m›\033[0m %s\n' "$1"; }
ok()    { printf '\033[1;32m✓\033[0m %s\n' "$1"; }
warn()  { printf '\033[1;33m!\033[0m %s\n' "$1"; }
err()   { printf '\033[1;31m✗\033[0m %s\n' "$1" >&2; }

cleanup() {
  if [[ -n "${MOUNT_POINT:-}" && -d "${MOUNT_POINT:-}" ]]; then
    hdiutil detach "$MOUNT_POINT" -quiet >/dev/null 2>&1 || true
  fi
  if [[ -n "${TMP_DIR:-}" && -d "${TMP_DIR:-}" ]]; then
    rm -rf "$TMP_DIR"
  fi
}
trap cleanup EXIT

if [[ "$(uname -s)" != "Darwin" ]]; then
  err "Este instalador es solo para macOS."
  exit 1
fi

# 1) Arquitectura
ARCH="$(uname -m)"
if [[ "$ARCH" == "arm64" ]]; then
  ARCH_TAG="arm64"
  info "Detectado Apple Silicon (arm64)."
else
  ARCH_TAG="x64"
  info "Detectado Intel (x64)."
fi

for bin in curl hdiutil; do
  command -v "$bin" >/dev/null 2>&1 || { err "Falta '$bin' en el sistema."; exit 1; }
done

# 2) Buscar el .dmg del último release para la arquitectura
info "Buscando la última versión estable en ${REPO}…"
RELEASE_JSON="$(curl -fsSL "$API_URL")"

# Preferimos el asset que coincide con la arquitectura; si no, cualquier .dmg.
DMG_URL="$(printf '%s' "$RELEASE_JSON" \
  | grep -o '"browser_download_url": *"[^"]*\.dmg"' \
  | sed 's/.*"browser_download_url": *"//; s/"$//' \
  | grep -i "$ARCH_TAG" | head -n 1 || true)"

if [[ -z "$DMG_URL" ]]; then
  DMG_URL="$(printf '%s' "$RELEASE_JSON" \
    | grep -o '"browser_download_url": *"[^"]*\.dmg"' \
    | sed 's/.*"browser_download_url": *"//; s/"$//' | head -n 1 || true)"
fi

if [[ -z "$DMG_URL" ]]; then
  err "No se encontró un .dmg en el último release de ${REPO}."
  warn "Descárgalo manualmente desde: https://github.com/${REPO}/releases/latest"
  exit 1
fi

ok "Encontrado: $DMG_URL"

# 3) Descargar
TMP_DIR="$(mktemp -d)"
DMG_PATH="${TMP_DIR}/${APP_NAME}.dmg"
info "Descargando…"
curl -fL# "$DMG_URL" -o "$DMG_PATH"
ok "Descarga completa."

# 4) Montar y copiar
info "Montando imagen de disco…"
MOUNT_POINT="$(mktemp -d)"
hdiutil attach "$DMG_PATH" -nobrowse -quiet -mountpoint "$MOUNT_POINT"

SRC_APP="$(/usr/bin/find "$MOUNT_POINT" -maxdepth 1 -name '*.app' -print -quit)"
if [[ -z "$SRC_APP" ]]; then
  err "No se encontró la app dentro del .dmg."
  exit 1
fi

DEST="/Applications/$(basename "$SRC_APP")"
if [[ -d "$DEST" ]]; then
  info "Eliminando versión anterior en ${DEST}…"
  rm -rf "$DEST"
fi

info "Instalando en /Applications…"
cp -R "$SRC_APP" /Applications/
ok "Instalado: $DEST"

# Quita la cuarentena para reducir el bloqueo de Gatekeeper (app sin firmar).
xattr -dr com.apple.quarantine "$DEST" >/dev/null 2>&1 || true

cat <<EOF

$(ok "Openwhispr se instaló correctamente.")

Ábrelo desde Launchpad o con:  open "$DEST"

Si macOS bloquea la app por seguridad (app en beta, sin firmar):
  1. Ve a Ajustes del Sistema › Privacidad y seguridad.
  2. Busca el aviso sobre Openwhispr y pulsa "Abrir de todos modos".
  3. O ejecuta:  xattr -dr com.apple.quarantine "$DEST"

La primera vez, Openwhispr pedirá permisos de micrófono y captura de sistema.
EOF
