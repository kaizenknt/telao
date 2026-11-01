# Telão

Compartilhamento de tela entre amigos, feito para jogo: captura e compressão pela placa de vídeo
(NVIDIA NVENC, AMD AMF, Intel Quick Sync), som do PC ou só do jogo, e baixa latência via WebRTC.

## Baixar

Pegue o `Telao-x.y.z-Windows.zip` na página de **[Releases](https://github.com/kaizenknt/telao/releases/latest)**,
extraia e abra o `Telao.exe`. Depois disso o app se atualiza sozinho.

## Como funciona

- Um da turma é o **host**: o PC dele roda a sala (servidor [MediaMTX](https://github.com/bluenviron/mediamtx), embutido).
- Os outros entram com o **código de convite** (`TELAO-…`). Funciona pelo Hamachi, Radmin, Tailscale, ZeroTier ou com portas abertas.
- Quem transmite usa o motor embutido ([GStreamer](https://gstreamer.freedesktop.org/)): captura D3D11 → H.264 na GPU → WHIP.
- Quem assiste recebe pelo WebRTC (WHEP) dentro do app.

Portas (só se não usar VPN): 8889/TCP, 9997/TCP, 8189/TCP+UDP.

## Desenvolver

```sh
npm install
# binários (não ficam no git): resources/bin/mediamtx.exe e resources/gst/ (GStreamer 1.28 para Windows)
npm run dist
```

Atualizações pequenas (só código) saem como `telao-update-x.y.z.zip` na release; o app baixa e aplica sozinho.
Se a release precisar do pacote completo, escreva `[completa]` no texto da release.
