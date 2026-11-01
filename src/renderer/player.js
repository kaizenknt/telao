// Player WHEP: assiste uma transmissão do MediaMTX via WebRTC, com reconexão automática.
const SMOOTH_MS = 120; // buffer de suavização do player (ms)
class WhepPlayer {
  constructor(video, { onStatus, onStats } = {}) {
    this.video = video;
    this.onStatus = onStatus || (() => {});
    this.onStats = onStats || (() => {});
    this.pc = null;
    this.session = null;
    this.target = null;
    this.retryTimer = null;
    this.statsTimer = null;
    this.lastBytes = 0;
    this.lastTs = 0;
    this.gen = 0; // invalida tentativas antigas quando troca de stream
  }

  async play(url, authHeader) {
    this.stop();
    this.target = { url, authHeader };
    this.gen++;
    this._connect(this.gen);
  }

  stop() {
    this.target = null;
    this.gen++;
    clearTimeout(this.retryTimer);
    clearInterval(this.statsTimer);
    this._teardown();
    this.video.srcObject = null;
  }

  _teardown() {
    if (this.session) {
      fetch(this.session.url, { method: 'DELETE', headers: { Authorization: this.session.auth } }).catch(() => {});
      this.session = null;
    }
    if (this.pc) { try { this.pc.close(); } catch {} this.pc = null; }
  }

  _retry(gen, why) {
    if (gen !== this.gen || !this.target) return;
    this._teardown();
    this.onStatus({ state: 'reconnecting', why });
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this._connect(gen), 2000);
  }

  async _connect(gen) {
    if (gen !== this.gen || !this.target) return;
    const { url, authHeader } = this.target;
    this.onStatus({ state: 'connecting' });

    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    this.pc = pc;
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });

    const stream = new MediaStream();
    pc.ontrack = (ev) => {
      // Buffer de suavização (como o Discord): segura ~120 ms para absorver a oscilação da internet.
      // Troca um pouquinho de atraso por imagem lisa, sem engasgos.
      try { ev.receiver.jitterBufferTarget = SMOOTH_MS; } catch {}
      try { ev.receiver.playoutDelayHint = SMOOTH_MS / 1000; } catch {}
      stream.addTrack(ev.track);
      if (this.video.srcObject !== stream) this.video.srcObject = stream;
      this.video.play().catch(() => {});
    };
    pc.onconnectionstatechange = () => {
      if (gen !== this.gen) return;
      const s = pc.connectionState;
      if (s === 'connected') { this.onStatus({ state: 'playing' }); this._startStats(gen); }
      if (s === 'failed' || s === 'closed') this._retry(gen, 'conexão perdida');
      if (s === 'disconnected') {
        // às vezes volta sozinho; espera um pouco antes de refazer
        setTimeout(() => { if (gen === this.gen && pc.connectionState === 'disconnected') this._retry(gen, 'conexão instável'); }, 4000);
      }
    };

    try {
      await pc.setLocalDescription(await pc.createOffer());
      await waitIce(pc, 1500);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/sdp', Authorization: authHeader },
        body: pc.localDescription.sdp,
      });
      if (gen !== this.gen) { pc.close(); return; }
      if (res.status === 401) { this.onStatus({ state: 'error', why: 'Senha da sala incorreta.' }); return; }
      if (res.status === 404) return this._retry(gen, 'transmissão ainda não começou');
      if (res.status !== 201) return this._retry(gen, `servidor respondeu ${res.status}`);
      const loc = res.headers.get('Location');
      if (loc) this.session = { url: new URL(loc, url).toString(), auth: authHeader };
      await pc.setRemoteDescription({ type: 'answer', sdp: await res.text() });
    } catch (e) {
      this._retry(gen, 'servidor fora do ar');
    }
  }

  _startStats(gen) {
    clearInterval(this.statsTimer);
    this.lastBytes = 0; this.lastTs = 0;
    this.prev = null;
    this.history = []; // últimos ~10 s, para dizer de onde vem a queda de FPS
    this.statsTimer = setInterval(async () => {
      if (gen !== this.gen || !this.pc) return clearInterval(this.statsTimer);
      const r = await this.pc.getStats().catch(() => null);
      if (!r) return;
      const out = {};
      r.forEach((s) => {
        if (s.type === 'inbound-rtp' && s.kind === 'video') {
          out.fps = s.framesPerSecond || 0;
          out.w = s.frameWidth; out.h = s.frameHeight;
          out.codec = s.codecId && r.get(s.codecId)?.mimeType?.split('/')[1];
          if (this.lastTs) out.mbps = ((s.bytesReceived - this.lastBytes) * 8) / ((s.timestamp - this.lastTs) * 1000);
          this.lastBytes = s.bytesReceived; this.lastTs = s.timestamp;
          // diferenças de 1 s: pacotes perdidos, quadros que chegaram, descartados e travadas
          const cur = {
            lost: s.packetsLost || 0, recv: s.packetsReceived || 0, frames: s.framesReceived || 0,
            dropped: s.framesDropped || 0, freezes: s.freezeCount || 0, freezeDur: s.totalFreezesDuration || 0,
          };
          if (this.prev) {
            const dl = Math.max(0, cur.lost - this.prev.lost), dr = Math.max(0, cur.recv - this.prev.recv);
            out.lossPct = dl + dr ? (dl / (dl + dr)) * 100 : 0;
            out.arrivingFps = cur.frames - this.prev.frames;          // quadros que o streamer mandou e chegaram
            out.droppedFps = Math.max(0, cur.dropped - this.prev.dropped);
            out.freezeMs = Math.max(0, (cur.freezeDur - this.prev.freezeDur) * 1000);
          }
          this.prev = cur;
        }
        if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') out.rtt = s.currentRoundTripTime;
      });
      if (out.arrivingFps != null) {
        this.history.push(out); if (this.history.length > 10) this.history.shift();
        out.verdict = verdict(this.history);
      }
      this.onStats(out);
    }, 1000);
  }
}

// Diz de onde vem a queda de FPS olhando os últimos segundos:
// - pacotes perdidos / travadas → a internet (upload de quem hospeda/transmite, ou a de quem assiste)
// - nada perdido, mas chegam poucos quadros → o PC de quem transmite não está gerando 60 (jogo pesando)
// - chegam 60, mas o vídeo trava aqui → o PC de quem assiste não está dando conta
function verdict(h) {
  if (h.length < 4) return null;
  const avg = (k) => h.reduce((a, x) => a + (x[k] || 0), 0) / h.length;
  const loss = avg('lossPct'), arriving = avg('arrivingFps'), dropped = avg('droppedFps'), freeze = avg('freezeMs');
  if (loss > 1) return { kind: 'rede', text: `Rede: ${loss.toFixed(1)}% dos pacotes se perdendo no caminho` };
  if (freeze > 150) return { kind: 'rede', text: `Rede instável: o vídeo está travando ~${Math.round(freeze)} ms por segundo (a internet oscilando)` };
  if (arriving < 50 && loss <= 1) return { kind: 'origem', text: `O PC de quem transmite está mandando só ${Math.round(arriving)} quadros/s (jogo pesando no PC dele)` };
  if (dropped > 3) return { kind: 'local', text: `Seu PC está descartando ${Math.round(dropped)} quadros/s ao mostrar o vídeo` };
  return { kind: 'ok', text: 'Tudo certo: chegando liso' };
}

function waitIce(pc, maxMs) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, maxMs);
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') { clearTimeout(t); resolve(); }
    });
  });
}

window.WhepPlayer = WhepPlayer;
