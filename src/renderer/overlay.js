// Janela transparente de quem transmite: desenha o que os amigos apontam, desenham e reagem.
const marks = new window.TelaoMarks(document.getElementById('c'));
window.telao.overlay.onEvent((ev) => marks.handle(ev));
