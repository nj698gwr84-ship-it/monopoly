// Представление не меняет правила, деньги и очередь ходов.
export const BOARD_SIZE = 1200;

export function tileBounds(index) {
  let row, col;
  if (index <= 10) [row, col] = [10, 10 - index];
  else if (index <= 20) [row, col] = [20 - index, 0];
  else if (index <= 30) [row, col] = [0, index - 20];
  else [row, col] = [index - 30, 10];
  const offset = n => 15 + (n === 0 ? 0 : 180 + (n - 1) * 90);
  return {
    row: row + 1, col: col + 1,
    x: offset(col), y: offset(row),
    width: col === 0 || col === 10 ? 180 : 90,
    height: row === 0 || row === 10 ? 180 : 90
  };
}

export function cameraPose(index, view, width, height, zoom = 1) {
  const b = tileBounds(index);
  const follow = view === 'follow';
  const yaw = follow ? [90, 0, -90, 180][Math.floor(index / 10)] : 0;
  return {
    yaw, tilt: follow ? 38 : 0,
    scale: (follow ? Math.max(0.88, Math.min(width / 610, height / 520))
      : Math.max(1, Math.min(width, height) - 28) / BOARD_SIZE) * zoom,
    x: (follow || zoom > 1) ? BOARD_SIZE / 2 - b.x - b.width / 2 : 0,
    y: (follow || zoom > 1) ? BOARD_SIZE / 2 - b.y - b.height / 2 : 0
  };
}

const districtScenes = [
  [0, 1, 3], [4, 5, 6], [7, 4, 5], [2, 8, 9],
  [10, 11, 9], [3, 6, 14], [12, 13, 11], [14, 15]
];

export function propertyScene(cell, index) {
  if (cell.type === 'street') {
    const district = districtScenes[cell.group];
    return district[index % district.length];
  }
  if (cell.type === 'rail') return [12, 5, 9, 13][Math.floor(index / 10)];
  if (cell.type === 'utility') return index === 28 ? 5 : 3;
  return null;
}

export function newLogLines(before, after) {
  const old = before?.log || [], next = after?.log || [];
  // Журнал движка ограничен 150 строками: сравниваем перекрытие,
  // а не только длину, чтобы события не терялись в длинной партии.
  for (let size = Math.min(old.length, next.length); size > 0; size--) {
    if (old.slice(-size).every((line, i) => line === next[i])) return next.slice(size);
  }
  return next.slice();
}

export function decisionKey(state) {
  if (state?.status !== 'playing' || (state.phase === 'roll' && !state.trade)) return null;
  const p = state.players[state.turn];
  return JSON.stringify({
    phase: state.phase, turn: p?.id, position: p?.position,
    round: state.round, paused: state.paused, extra: state.extra,
    card: state.card, auction: state.auction, debt: state.debt, trade: state.trade,
    owner: state.properties[p?.position]?.owner,
    // В тюрьме позиция и кубики могут совпасть в двух соседних ходах.
    jailTurns: p?.jailTurns, jailed: p?.jailed
  });
}

export function transitionInfo(before, after) {
  const lines = newLogLines(before, after);
  const rolled = !!before && before.status === 'playing' &&
    lines.some(line => /: выпало \d \+ \d\./.test(line));
  const moved = !!before && after.players.some(p => {
    const old = before.players.find(item => item.id === p.id);
    return old && old.position !== p.position;
  });
  return { rolled, moved, lines };
}

const paths = {
  start: '<path d="M9 35h29V20h-8l14-13 14 13h-8v25H9z" fill="currentColor"/><path d="M12 53h40"/>',
  chance: '<path d="M23 20c0-14 24-14 24 0 0 10-15 10-15 21"/><circle cx="32" cy="51" r="3" fill="currentColor" stroke="none"/>',
  chest: '<path d="M10 27h44v28H10z" fill="currentColor" opacity=".18"/><path d="M10 27c0-23 44-23 44 0v28H10V27zm0 8h44M26 11v44m12-44v44"/><path d="M27 31h10v12H27z" fill="#eec86c"/>',
  rail: '<rect x="17" y="9" width="30" height="38" rx="8" fill="currentColor" opacity=".17"/><path d="M17 40V17q0-8 15-8t15 8v23q0 8-15 8t-15-8zm0-13h30M24 49l-8 10m24-10 8 10M20 55h24"/><circle cx="24" cy="38" r="3" fill="currentColor"/><circle cx="40" cy="38" r="3" fill="currentColor"/>',
  utility: '<path d="M37 5 14 36h17l-4 23 23-32H33z" fill="#eec86c" stroke-linejoin="round"/>',
  water: '<path d="M32 6S13 30 13 40a19 19 0 0 0 38 0C51 30 32 6 32 6z" fill="#6acbd4"/><path d="M22 40q0 10 10 10" stroke="white"/>',
  tax: '<path d="M15 7h34v50l-8-5-9 5-9-5-8 5z" fill="currentColor" opacity=".14"/><path d="M15 7h34v50l-8-5-9 5-9-5-8 5V7zm8 12h18m-18 8h18m-18 8h9m-9 8h18"/>',
  parking: '<rect x="8" y="8" width="48" height="48" rx="13" fill="currentColor" opacity=".16"/><path d="M25 47V19h10c16 0 16 17 0 17H25" stroke-width="5"/>',
  jail: '<path d="M11 55V12h42v43M7 55h50M22 12v43m10-43v43m10-43v43M11 26h42"/><circle cx="31" cy="38" r="5" fill="#efbb62"/>',
  gotojail: '<path d="M15 28v-9h35v31H35M8 39h22m-8-9 9 9-9 9M40 19v31"/><path d="m29 5 20 7"/>',
  street: '<path d="M9 56V27h17v29m0 0V10h20v46m0 0V34h11v22H9" fill="currentColor" opacity=".22"/><path d="M9 56V27h17m0 29V10h20v46m0-22h11v22H9M32 19h8m-8 10h8m-8 10h8m-25-3h5m-5 9h5"/>',
  crown: '<path d="m7 21 12 9L32 12l13 18 12-9-6 29H13z" fill="currentColor"/><path d="M14 56h36"/>',
  knight: '<path d="M16 53h34L43 39l6-15L35 8 20 14l-9 17 11 6 9-11v14z" fill="currentColor"/>',
  rook: '<path d="M16 9v15l6 5-3 22h26l-3-22 6-5V9h-8v9h-5V9h-7v9h-5V9zm-1 48h34" fill="currentColor"/>',
  pawn: '<circle cx="32" cy="16" r="10" fill="currentColor"/><path d="M22 31h20l-5 10 9 13H18l9-13z" fill="currentColor"/>',
  diamond: '<path d="m7 23 12-13h26l12 13-25 34z" fill="currentColor"/><path d="m7 23 50 0M19 10l13 47 13-47" stroke="white" opacity=".65"/>',
  star: '<path d="m32 5 8 17 19 3-14 14 3 19-16-9-17 9 3-19L4 25l20-3z" fill="currentColor"/>',
  rocket: '<path d="M32 7c-16 10-16 28-12 36h24c4-8 4-26-12-36zM20 30 10 43v9l13-9m21-13 10 13v9l-13-9" fill="currentColor"/><circle cx="32" cy="27" r="5" fill="white"/><path d="m26 49 6 11 6-11"/>',
  planet: '<circle cx="32" cy="32" r="19" fill="currentColor"/><ellipse cx="32" cy="32" rx="30" ry="8" transform="rotate(-28 32 32)" stroke="white"/>',
  shield: '<path d="m32 6 23 8v19c0 14-23 25-23 25S9 47 9 33V14z" fill="currentColor"/><path d="m21 31 8 8 15-17" stroke="white" stroke-width="5"/>',
  flower: '<path d="M32 26c-22-31-35 6-8 8-36 4-9 33 6 10 3 36 33 12 13-7 35-8 6-35-7-12C34-8 8 7 32 26z" fill="currentColor"/><circle cx="32" cy="33" r="7" fill="white"/>'
};

export function icon(name, className = '') {
  return `<svg class="game-icon ${className}" viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.street}</svg>`;
}

export const pieceIcon = index => icon([
  'rook', 'knight', 'crown', 'pawn', 'diamond', 'star', 'rocket', 'planet', 'shield', 'flower'
][index], 'piece-icon');