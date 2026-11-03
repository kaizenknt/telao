// Telão — marcas por cima do vídeo: apontar (anel que pulsa), desenhar (traço que some) e reações (emoji que sobe).
// Usado no player de quem assiste e na janela transparente de quem transmite. Coordenadas sempre de 0 a 1
// em relação à imagem transmitida, então batem em qualquer tamanho de tela.
(function () {
  const hueOf = (n) => { let h = 0; for (const c of String(n || '')) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
  const colorOf = (n, a = 1) => `hsla(${hueOf(n)}, 95%, 62%, ${a})`;
  const PING_MS = 2600, STROKE_HOLD = 2200, STROKE_FADE = 900, REACT_MS = 2800;

  class Marks {
    // contentRect(): retângulo (em px CSS, dentro do canvas) onde a imagem aparece
    constructor(canvas, { contentRect } = {}) {
      this.c = canvas; this.ctx = canvas.getContext('2d');
      this.contentRect = contentRect || (() => ({ x: 0, y: 0, w: canvas.clientWidth, h: canvas.clientHeight }));
      this.pings = []; this.strokes = new Map(); this.reacts = [];
      this.raf = null;
      const fit = () => {
        const dpr = window.devicePixelRatio || 1;
        this.c.width = Math.max(1, Math.round(this.c.clientWidth * dpr));
        this.c.height = Math.max(1, Math.round(this.c.clientHeight * dpr));
        this.kick();
      };
      new ResizeObserver(fit).observe(canvas);
      fit();
    }
    handle(ev) {
      const now = performance.now();
      const d = ev.data;
      if (ev.type === 'ping' && d && isFinite(d.x) && isFinite(d.y)) this.pings.push({ x: d.x, y: d.y, who: ev.from, t: now });
      else if (ev.type === 'draw' && d && Array.isArray(d.pts)) {
        const key = ev.from + '#' + d.id;
        let s = this.strokes.get(key);
        if (!s) { s = { who: ev.from, pts: [], last: now }; this.strokes.set(key, s); }
        for (const p of d.pts.slice(0, 400)) if (Array.isArray(p) && isFinite(p[0]) && isFinite(p[1])) s.pts.push(p);
        s.last = now;
      } else if (ev.type === 'react' && typeof d === 'string' && d.length <= 8) {
        this.reacts.push({ e: d, who: ev.from, t: now, x: 0.62 + Math.random() * 0.32, drift: (Math.random() - 0.5) * 0.06 });
        if (this.reacts.length > 40) this.reacts.shift();
      } else if (ev.type === 'clear') { this.pings = []; this.strokes.clear(); }
      this.kick();
    }
    kick() { if (!this.raf) this.raf = requestAnimationFrame(() => this.draw()); }
    draw() {
      this.raf = null;
      const ctx = this.ctx, dpr = window.devicePixelRatio || 1, now = performance.now();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, this.c.width, this.c.height);
      const r = this.contentRect();
      const X = (x) => r.x + x * r.w, Y = (y) => r.y + y * r.h;
      const label = (txt, x, y, col) => {
        ctx.font = '600 12px "Segoe UI", system-ui, sans-serif';
        const w = ctx.measureText(txt).width + 12;
        ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.beginPath(); ctx.roundRect(x, y, w, 20, 6); ctx.fill();
        ctx.fillStyle = col; ctx.fillText(txt, x + 6, y + 14);
      };

      // traços
      for (const [k, s] of this.strokes) {
        const age = now - s.last;
        if (age > STROKE_HOLD + STROKE_FADE) { this.strokes.delete(k); continue; }
        const a = age < STROKE_HOLD ? 1 : 1 - (age - STROKE_HOLD) / STROKE_FADE;
        if (s.pts.length < 2) continue;
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        ctx.strokeStyle = 'rgba(0,0,0,' + 0.45 * a + ')'; ctx.lineWidth = 8;
        ctx.beginPath(); s.pts.forEach((p, i) => (i ? ctx.lineTo(X(p[0]), Y(p[1])) : ctx.moveTo(X(p[0]), Y(p[1])))); ctx.stroke();
        ctx.strokeStyle = colorOf(s.who, a); ctx.lineWidth = 4.5; ctx.stroke();
      }
      // pings
      this.pings = this.pings.filter((p) => now - p.t < PING_MS);
      for (const p of this.pings) {
        const k = (now - p.t) / PING_MS, x = X(p.x), y = Y(p.y), col = colorOf(p.who, 1 - k * 0.6);
        for (let i = 0; i < 2; i++) {
          const kk = ((now - p.t) / 900 + i * 0.5) % 1;
          ctx.strokeStyle = colorOf(p.who, (1 - kk) * (1 - k)); ctx.lineWidth = 3;
          ctx.beginPath(); ctx.arc(x, y, 10 + kk * 34, 0, Math.PI * 2); ctx.stroke();
        }
        ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,.6)'; ctx.lineWidth = 2; ctx.stroke();
        label(p.who, x + 14, y + 8, col);
      }
      // reações
      this.reacts = this.reacts.filter((e) => now - e.t < REACT_MS);
      for (const e of this.reacts) {
        const k = (now - e.t) / REACT_MS;
        const x = X(e.x + e.drift * Math.sin(k * 6)), y = Y(0.92 - k * 0.55);
        ctx.globalAlpha = k < 0.75 ? 1 : 1 - (k - 0.75) / 0.25;
        const size = 34 + Math.sin(Math.min(k * 8, Math.PI)) * 8;
        ctx.font = `${size}px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif`;
        ctx.textAlign = 'center'; ctx.fillText(e.e, x, y); ctx.textAlign = 'start';
        ctx.font = '600 11px "Segoe UI", system-ui, sans-serif';
        ctx.fillStyle = colorOf(e.who); ctx.fillText(e.who, x - 16, y + 16); ctx.fillStyle = '#000';
        ctx.globalAlpha = 1;
      }
      if (this.pings.length || this.strokes.size || this.reacts.length) this.kick();
    }
  }
  window.TelaoMarks = Marks;
  window.TelaoColorOf = colorOf;
})();
