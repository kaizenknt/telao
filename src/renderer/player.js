// Player WHEP: assiste uma transmissão do MediaMTX via WebRTC, com reconexão automática.
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
    this.statsTimer = setInterval(async () => {
      if (gen !== this.gen || !this.pc) return clearInterval(this.statsTimer);
      const r = await this.pc.getStats().catch(() => null);
      if (!r) return;
      const out = {};
      r.forEach((s) => {
        if (s.type === 'inbound-rtp' && s.kind === 'video') {
          out.fps = s.framesPerSecond || 0;
          out.w = s.frameWidth; out.h = s.frameHeight;
          out.lost = s.packetsLost || 0;
          out.codec = s.codecId && r.get(s.codecId)?.mimeType?.split('/')[1];
          if (this.lastTs) out.mbps = ((s.bytesReceived - this.lastBytes) * 8) / ((s.timestamp - this.lastTs) * 1000);
          this.lastBytes = s.bytesReceived; this.lastTs = s.timestamp;
        }
        if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') out.rtt = s.currentRoundTripTime;
      });
      this.onStats(out);
    }, 1000);
  }
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
