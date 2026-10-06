// Icone a tratto in stile SF Symbols (24×24, colore del testo). Al posto delle emoji, che su Android
// cambiano aspetto da un telefono all'altro e stonano con lo stile "Vetro".
const PATHS = {
  target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3.2"/><path d="M12 1.8v4M12 18.2v4M1.8 12h4M18.2 12h4"/>',
  warn: '<path d="M12 3.5 2.6 19.8c-.4.7.1 1.6.9 1.6h17c.8 0 1.3-.9.9-1.6L12 3.5Z"/><path d="M12 9.5v5"/><circle cx="12" cy="17.6" r=".6" fill="currentColor"/>',
  bolt: '<path d="M13.2 2.5 4.8 13.4h6.4l-1.4 8.1 8.4-10.9h-6.4l1.4-8.1Z"/>',
  move: '<circle cx="12" cy="4.6" r="1.9"/><path d="M8.6 21.5l2-6.2-2.5-2.2 1.3-4.3 2.9-.7 2.6 2.4 2.8.8M10.6 15.3l3.1 1.8.9 4.4M9.4 8.8 6.6 11"/>',
  shield: '<path d="M12 2.8 4.6 5.6v5.6c0 4.8 3.1 8.6 7.4 10 4.3-1.4 7.4-5.2 7.4-10V5.6L12 2.8Z"/><path d="m8.8 12 2.2 2.2 4.3-4.4"/>',
  map: '<path d="m3.2 6.3 5.6-2.4 6.4 2.6 5.6-2.4v14.1l-5.6 2.4-6.4-2.6-5.6 2.4V6.3Z"/><path d="M8.8 3.9v13.9M15.2 6.5v13.9"/>',
  search: '<circle cx="10.6" cy="10.6" r="6.6"/><path d="m15.6 15.6 5.2 5.2"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  person: '<circle cx="12" cy="8.2" r="3.9"/><path d="M4.6 20.4c.9-3.6 3.8-5.6 7.4-5.6s6.5 2 7.4 5.6"/>',
  game: '<path d="M7.3 7.4h9.4c2.6 0 4.4 2 4.8 4.6l.8 5.1c.3 1.9-1.7 3.2-3.2 2l-2.9-2.4H7.8l-2.9 2.4c-1.5 1.2-3.5-.1-3.2-2l.8-5.1c.4-2.6 2.2-4.6 4.8-4.6Z"/><path d="M7.8 10.6v3.6M6 12.4h3.6"/><circle cx="16.4" cy="11.2" r=".7" fill="currentColor"/><circle cx="18.2" cy="13.4" r=".7" fill="currentColor"/>',
  restart: '<path d="M4.5 12a7.5 7.5 0 1 0 2.4-5.5"/><path d="M4.2 3.6v4.2h4.2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  xmark: '<path d="m6.5 6.5 11 11M17.5 6.5l-11 11"/>',
  check: '<path d="m5.5 12.5 4.2 4.2 8.8-9.4"/>',
  swap: '<path d="M4 8.5h13.5l-3.6-3.6M20 15.5H6.5l3.6 3.6"/>',
  chart: '<path d="M4.5 19.5V10M10 19.5V4.5M15.5 19.5v-7M21 19.5H3"/>',
  grid: '<rect x="4" y="4" width="6.6" height="6.6" rx="1.6"/><rect x="13.4" y="4" width="6.6" height="6.6" rx="1.6"/><rect x="4" y="13.4" width="6.6" height="6.6" rx="1.6"/><rect x="13.4" y="13.4" width="6.6" height="6.6" rx="1.6"/>',
  list: '<path d="M9 6.5h11M9 12h11M9 17.5h11"/><circle cx="4.5" cy="6.5" r="1" fill="currentColor"/><circle cx="4.5" cy="12" r="1" fill="currentColor"/><circle cx="4.5" cy="17.5" r="1" fill="currentColor"/>',
};

export function icon(name, cls = "ic") {
  const t = document.createElement("template");
  t.innerHTML = `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" `
    + `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${PATHS[name] ?? ""}</svg>`;
  return t.content.firstChild;
}

// segnaposto nell'HTML: <span data-ic="search"></span>
export function fillIcons(root = document) {
  for (const s of root.querySelectorAll("[data-ic]")) if (!s.firstChild) s.append(icon(s.dataset.ic));
}
