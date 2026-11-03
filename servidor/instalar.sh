#!/usr/bin/env bash
# Telão — sala num servidor alugado (VPS Ubuntu/Debian), para não depender do seu PC nem do roteador.
#
# No servidor, como root:
#   curl -fsSL https://raw.githubusercontent.com/kaizenknt/telao/main/servidor/instalar.sh | bash
# (ou, para escolher a senha:  ... | SENHA=minha-senha bash)
#
# No fim ele mostra o link de convite. Quem transmite continua sendo o PC de cada um: o servidor só repassa.
set -euo pipefail

MTX_VER="v1.21.3"
REPO_RAW="https://raw.githubusercontent.com/kaizenknt/telao/main"
DIR=/opt/telao

[ "$(id -u)" = 0 ] || { echo "Rode como root (sudo -i)."; exit 1; }
command -v apt-get >/dev/null || { echo "Este instalador é para Ubuntu/Debian."; exit 1; }

echo "==> Instalando o necessário"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates tar nodejs >/dev/null

mkdir -p "$DIR"
cd "$DIR"

# senha: a que você passou, a que já existia, ou uma nova
if [ -z "${SENHA:-}" ] && [ -f "$DIR/senha" ]; then SENHA="$(cat "$DIR/senha")"; fi
if [ -z "${SENHA:-}" ]; then SENHA="$(tr -dc 'abcdefghjkmnpqrstuvwxyz23456789' </dev/urandom | head -c 12 | sed 's/\(....\)/\1-/g; s/-$//')"; fi
printf '%s' "$SENHA" > "$DIR/senha"; chmod 600 "$DIR/senha"

echo "==> Baixando o servidor de vídeo (MediaMTX $MTX_VER)"
case "$(uname -m)" in
  x86_64) ARCH=amd64 ;; aarch64|arm64) ARCH=arm64 ;; *) echo "Processador não suportado: $(uname -m)"; exit 1 ;;
esac
curl -fsSL "https://github.com/bluenviron/mediamtx/releases/download/${MTX_VER}/mediamtx_${MTX_VER}_linux_${ARCH}.tar.gz" | tar xz -C "$DIR" mediamtx
curl -fsSL "$REPO_RAW/src/roomproxy.js" -o "$DIR/roomproxy.js"
curl -fsSL "$REPO_RAW/src/invite.js" -o "$DIR/invite.js"

IP="$(curl -fsS https://api.ipify.org || curl -fsS https://ifconfig.me/ip)"
[ -n "$IP" ] || { echo "Não consegui descobrir o IP público do servidor."; exit 1; }

echo "==> Configurando a sala (IP $IP)"
SENHA_JSON="$(node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$SENHA")"
cat > "$DIR/mediamtx.yml" <<EOF
# Gerado pelo instalador do Telão.
logLevel: info
logDestinations: [stdout]
authMethod: internal
authInternalUsers:
  - user: sala
    pass: $SENHA_JSON
    ips: []
    permissions:
      - action: publish
      - action: read
      - action: api
api: true
apiAddress: 127.0.0.1:9996
apiAllowOrigins: ["*"]
rtsp: false
rtmp: false
hls: false
srt: false
moq: false
webrtc: true
webrtcAddress: :8889
webrtcAllowOrigins: ["*"]
webrtcLocalUDPAddress: :8189
webrtcLocalTCPAddress: :8189
webrtcIPsFromInterfaces: true
webrtcAdditionalHosts: ["$IP"]
webrtcICEServers2:
  - url: stun:stun.l.google.com:19302
paths:
  all_others:
EOF

cat > /etc/systemd/system/telao-video.service <<EOF
[Unit]
Description=Telão - servidor de vídeo
After=network-online.target
[Service]
WorkingDirectory=$DIR
ExecStart=$DIR/mediamtx $DIR/mediamtx.yml
Restart=always
RestartSec=2
[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/telao-porteiro.service <<EOF
[Unit]
Description=Telão - porteiro da sala (API e relatos de quem assiste)
After=telao-video.service
[Service]
WorkingDirectory=$DIR
Environment=SENHA_ARQUIVO=$DIR/senha
ExecStart=/bin/sh -c 'SENHA="\$(cat $DIR/senha)" exec /usr/bin/node $DIR/roomproxy.js'
Restart=always
RestartSec=2
[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now telao-video.service telao-porteiro.service >/dev/null
systemctl restart telao-video.service telao-porteiro.service

# firewall do servidor (se estiver ligado)
if command -v ufw >/dev/null && ufw status | grep -q active; then
  ufw allow 8889/tcp >/dev/null; ufw allow 9997/tcp >/dev/null; ufw allow 8189/tcp >/dev/null; ufw allow 8189/udp >/dev/null
fi

sleep 2
CODE="$(node "$DIR/invite.js" "$IP" "$SENHA")"
echo
echo "================================================================"
echo " Sala pronta no servidor $IP"
echo
echo " Link de convite (mande no grupo):"
echo "   https://kaizenknt.github.io/telao/#$CODE"
echo
echo " Código (para colar no Telão):"
echo "   $CODE"
echo
echo " No Telão do seu PC: engrenagem > 'Entrar na sala de um amigo' e cole"
echo " o código (ou só clique no link). Seu PC não precisa mais abrir a sala."
echo "================================================================"
systemctl --no-pager --lines=0 status telao-video.service telao-porteiro.service | grep -E "Active:" || true
echo " Se a empresa do servidor tiver firewall no painel, libere: TCP 8889, 9997, 8189 e UDP 8189."
