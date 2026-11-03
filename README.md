# Telão

Compartilhamento de tela entre amigos, feito para jogo: captura e compressão pela placa de vídeo
(NVIDIA NVENC, AMD AMF, Intel Quick Sync), som do PC ou só do jogo, e baixa latência via WebRTC.

## Baixar

Pegue o **`Telao-Setup-x.y.z.exe`** na página de **[Releases](https://github.com/kaizenknt/telao/releases/latest)** e abra.
Ele instala só para você (sem pedir administrador), cria os atalhos e registra os links de convite. Depois disso o app se atualiza sozinho.

## Como funciona

- Um da turma é o **host**: o PC dele roda a sala (servidor [MediaMTX](https://github.com/bluenviron/mediamtx), embutido).
- Os outros entram pelo **link de convite** (`kaizenknt.github.io/telao/#TELAO-…`, abre o app direto na sala) ou colando o código. Funciona pelo Hamachi, Radmin, Tailscale, ZeroTier ou com portas abertas.
- Quem transmite usa o motor embutido ([GStreamer](https://gstreamer.freedesktop.org/)): captura D3D11 → H.264 ou **AV1** na GPU → WHIP.
  O AV1 entra sozinho quando todos que estão assistindo abrem AV1 por hardware, e volta para H.264 quando entra alguém que não abre.
- Quem assiste recebe pelo WebRTC (WHEP) dentro do app e conta para quem transmite como está chegando (perda, travadas):
  quem transmite vê uma bolinha por pessoa, e a taxa baixa sozinha quando a internet de alguém oscila.
- Som automático: transmitindo uma tela, pega só o som do jogo em tela cheia; sem jogo, o som do PC sem o Discord/WhatsApp.
- Na porta 9997 fica o "porteiro" da sala (`src/roomproxy.js`): repassa a API do MediaMTX (que ouve só por dentro, na 9996) e guarda os relatos de quem assiste.

Sem VPN: o Telão abre as portas do roteador sozinho via **UPnP** (8889/TCP, 9997/TCP, 8189/TCP+UDP), detecta CGNAT e remove as regras ao fechar. Se o roteador não tiver UPnP, abra essas portas manualmente.

## Sala num servidor alugado (opcional)

Para não depender do PC do host nem do roteador: num VPS Ubuntu/Debian, como root,

```sh
curl -fsSL https://raw.githubusercontent.com/kaizenknt/telao/main/servidor/instalar.sh | bash
```

No fim ele mostra o link de convite. O servidor só repassa o vídeo; quem transmite continua sendo o PC de cada um.

## Desenvolver

```sh
npm install
# binários (não ficam no git): resources/bin/mediamtx.exe e resources/gst/ (GStreamer 1.28 para Windows)
npm run dist     # gera dist/Telao-Setup-x.y.z.exe (precisa do makensis; não precisa de Wine)
```

A página do convite fica em `docs/index.html` (GitHub Pages: Settings → Pages → branch `main`, pasta `/docs`).

### Atualização automática

O app lê o `update.json` deste repositório (branch `main`) ao abrir e a cada 3 horas.
Para lançar uma versão só de código: suba o `VERSION` em `src/version.js`, atualize `version` e a lista
`files` no `update.json` e dê push. O app baixa os arquivos de `src/` e mostra o botão **Reiniciar**.
Se a versão mudar o motor/servidor (pasta `resources/`), use `"full": true`: o app só avisa e abre o link de download.
