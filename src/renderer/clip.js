// Telão — clipe de quem assiste: guarda sempre o último meio minuto do que você está vendo.
// Dois gravadores revezando (um começa 30 s depois do outro e cada um recomeça a cada 60 s): na hora do clipe,
// o que está gravando há mais tempo tem entre 30 e 60 s. Usa H.264 pela placa quando o Windows deixa.
(function () {
  const TYPES = [
    ['video/mp4;codecs=avc1.640028,opus', 'mp4'], ['video/mp4;codecs=avc1,opus', 'mp4'], ['video/mp4', 'mp4'],
    ['video/webm;codecs=h264,opus', 'webm'], ['video/webm;codecs=vp9,opus', 'webm'], ['video/webm', 'webm'],
  ];
  const PERIOD = 60000;

  class Clipper {
    constructor() { this.recs = []; this.stream = null; this.timers = []; this.type = null; }
    static pick() { return TYPES.find(([t]) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || null; }
    get running() { return !!this.stream; }
    start(stream) {
      this.stop();
      const pick = Clipper.pick();
      if (!pick || !stream) return false;
      this.stream = stream; this.type = pick;
      this.recs = [this.newRec(), null];
      // o segundo gravador entra 30 s depois
      this.timers.push(setTimeout(() => { if (this.stream) this.recs[1] = this.newRec(); }, PERIOD / 2));
      this.timers.push(setInterval(() => this.rotate(), 5000));
      return true;
    }
    newRec() {
      const r = { chunks: [], t0: performance.now(), mr: null };
      try {
        r.mr = new MediaRecorder(this.stream, { mimeType: this.type[0], videoBitsPerSecond: 10_000_000, audioBitsPerSecond: 128_000 });
        r.mr.ondataavailable = (e) => { if (e.data && e.data.size) r.chunks.push(e.data); };
        r.mr.start(1000);
      } catch { r.mr = null; }
      return r;
    }
    rotate() {
      const now = performance.now();
      this.recs = this.recs.map((r) => {
        if (r && now - r.t0 >= PERIOD) { try { r.mr && r.mr.stop(); } catch {} return this.newRec(); }
        return r;
      });
    }
    // devolve { blob, ext, seconds } com o gravador que está há mais tempo gravando
    async take() {
      const live = this.recs.filter((r) => r && r.mr && r.mr.state === 'recording');
      if (!live.length) return null;
      const r = live.reduce((a, b) => (a.t0 < b.t0 ? a : b));
      await new Promise((res) => { r.mr.addEventListener('dataavailable', res, { once: true }); try { r.mr.requestData(); } catch { res(); } });
      const seconds = Math.round((performance.now() - r.t0) / 1000);
      return { blob: new Blob(r.chunks, { type: this.type[0].split(';')[0] }), ext: this.type[1], seconds };
    }
    stop() {
      this.timers.forEach((t) => { clearTimeout(t); clearInterval(t); }); this.timers = [];
      for (const r of this.recs) { try { r && r.mr && r.mr.state !== 'inactive' && r.mr.stop(); } catch {} }
      this.recs = []; this.stream = null;
    }
  }
  window.TelaoClipper = Clipper;
})();
