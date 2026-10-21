const paths = {
  mail:'<rect x="3" y="5" width="18" height="14" rx="3"/><path d="m4 7 8 6 8-6"/>',
  settings:'<path d="m9 3-.6 2.5-2.3 1-2.2-.7-2 3.4 1.7 1.8v2l-1.7 1.8 2 3.4 2.2-.7 2.3 1L9 21h6l.6-2.5 2.3-1 2.2.7 2-3.4-1.7-1.8v-2l1.7-1.8-2-3.4-2.2.7-2.3-1L15 3Z"/><circle cx="12" cy="12" r="3"/>',
  user:'<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
  back:'<path d="M19 12H5m6-6-6 6 6 6"/>',
  close:'<path d="m6 6 12 12M18 6 6 18"/>',
  up:'<path d="M12 19V5m-6 6 6-6 6 6"/>',
  down:'<path d="M12 5v14m-6-6 6 6 6-6"/>',
  external:'<path d="M7 17 18 6H8m10 0v10"/>',
  refresh:'<path d="M20 8a8 8 0 1 0 0 8M20 3v5h-5"/>',
  undo:'<path d="M4 10h10a6 6 0 0 1 0 12M4 10l5-5m-5 5 5 5"/>',
  play:'<path d="m8 4 12 8-12 8Z"/>',
  pause:'<path d="M8 5v14M16 5v14"/>',
  shield:'<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z"/><path d="m8 12 3 3 5-6"/>',
  help:'<circle cx="12" cy="12" r="9"/><path d="M9 9a3 3 0 1 1 5 2c-2 1-2 2-2 3m0 3h.01"/>',
  trash:'<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
  lock:'<rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/>',
  locate:'<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3"/>',
  dining:'<path d="M5 3v7m3-7v7m3-7v7M5 7h6m-3 3v11M19 21V3c-4 2-4 9 0 9"/>',
  stay:'<path d="M3 21V5m18 16V9a2 2 0 0 0-2-2h-8v8M3 15h18M3 18h18"/><rect x="5" y="7" width="4" height="5" rx="1"/>',
  like:'<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/>',
  save:'<path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1Z"/>',
  recommend:'<path d="m12 2 2.8 6.2 6.7.8-5 4.6 1.4 6.7-5.9-3.4-5.9 3.4 1.4-6.7-5-4.6 6.7-.8Z"/>',
  share:'<path d="M12 15V3m-5 5 5-5 5 5M5 13v7a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-7"/>',
  edit:'<path d="m15 4 5 5M4 20l5-1L21 7l-5-5L4 14v6Z"/>',
  search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  plus:'<path d="M12 5v14M5 12h14"/>',
  check:'<path d="m5 12 4 4L19 6"/>',
  pin:'<path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 0 1 14 0Z"/><circle cx="12" cy="10" r="2"/>',
  arrow:'<path d="M5 12h14m-6-6 6 6-6 6"/>',
  spark:'<path d="m12 3 2.3 6.7L21 12l-6.7 2.3L12 21l-2.3-6.7L3 12l6.7-2.3ZM20 2v4m-2-2h4"/>'
};
export const icon = name => `<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths[name] || paths.spark}</svg>`;
export function setIconLabel(element, label, name, first = false) {
  element.textContent = label;
  if (name) element.insertAdjacentHTML(first ? 'afterbegin' : 'beforeend', icon(name));
}
export function mountStaticIcons(root = document) {
  for (const el of root.querySelectorAll('[data-ui-icon]')) el.innerHTML = icon(el.dataset.uiIcon);
}
