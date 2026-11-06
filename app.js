import {
  BOARD, COLORS, TOKENS, GROUP_COLORS
} from './shared/data.js';

import {
  newGame, addPlayer, applyCommand,
  current, actor, bankStock, invariant
} from './shared/engine.js';

import { CONFIG } from './config.js';

const $ = selector => document.querySelector(selector);
const app = $('#app');

const esc = value => String(value ?? '').replace(
  /[&<>"']/g,
  character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[character])
);

const money = value =>
  new Intl.NumberFormat('ru-RU').format(value);

const read = (key, fallback = null) => {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
};

const store = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    toast('Браузер не разрешает сохранение. Не закрывайте страницу.');
  }
};

let s = null;
let mode = 'home';
let session = null;
let ws = null;
let online = [];
let busy = false;
let retry = null;
let manualClose = false;
let camera = read('mtv-camera', 'angle');
let selected = null;
let modalKind = null;
let sound = read('mtv-sound', false);
let toastTimer;
let audio = null;

let endpoint = CONFIG.serverURL.replace(/\/$/, '');

const params = new URLSearchParams(location.hash.slice(1));

if (params.has('server')) {
  try {
    const url = new URL(params.get('server'));

    if (
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && location.protocol === 'http:')
    ) {
      endpoint = url.origin;
    }
  } catch {}
}

const apiBase = () => endpoint || location.origin;

function toast(text) {
  $('#toast').textContent = text;
  $('#toast').classList.add('visible');
  clearTimeout(toastTimer);

  toastTimer = setTimeout(() => {
    $('#toast').classList.remove('visible');
  }, 4500);
}

function beep() {
  if (!sound) return;

  try {
    audio ??= new (
      window.AudioContext || window.webkitAudioContext
    )();

    const oscillator = audio.createOscillator();
    const gain = audio.createGain();

    oscillator.connect(gain);
    gain.connect(audio.destination);

    oscillator.frequency.value = 520;
    gain.gain.setValueAtTime(0.035, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(
      0.001,
      audio.currentTime + 0.15
    );

    oscillator.start();
    oscillator.stop(audio.currentTime + 0.15);
  } catch {}
}

function uid() {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function rand() {
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);
  return values[0] / 2 ** 32;
}

function isHost() {
  return mode === 'local' || session?.role === 'host';
}

function controls(id) {
  const p = s?.players.find(item => item.id === id);

  return mode === 'local' || (
    session?.role === 'host'
      ? p?.controller === 'host'
      : session?.playerId === id
  );
}

function me() {
  return session?.role === 'player'
    ? s.players.find(p => p.id === session.playerId)
    : actor(s);
}

function cmdBtn(
  label,
  type,
  attrs = '',
  className = 'primary',
  disabled = false
) {
  return `
    <button
      class="${className}"
      data-command="${type}"
      ${attrs}
      ${disabled ? 'disabled' : ''}
    >${label}</button>
  `;
}

function openModal(title, html, kind = 'custom') {
  modalKind = kind;
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = html;

  if (!$('#modal').open) {
    $('#modal').showModal();
  }
}

function closeModal() {
  if ($('#modal').open) {
    $('#modal').close();
  }

  modalKind = null;
  selected = null;
}

$('#close-modal').onclick = closeModal;

$('#modal').addEventListener('click', event => {
  if (event.target !== $('#modal')) return;

  const rect = $('#modal').getBoundingClientRect();

  if (
    event.clientX < rect.left ||
    event.clientX > rect.right ||
    event.clientY < rect.top ||
    event.clientY > rect.bottom
  ) {
    closeModal();
  }
});

$('#modal').addEventListener('close', () => {
  modalKind = null;
  selected = null;
});

$('#sound').onclick = () => {
  sound = !sound;
  store('mtv-sound', sound);
  $('#sound').style.background = sound ? '#dce6d3' : '';
  toast(sound ? 'Звук включён' : 'Звук выключен');
  beep();
};

$('#help').onclick = showRules;

$('#menu').onclick = () => {
  openModal('Меню партии', `
    <div class="stack">
      ${s?.status === 'playing' && isHost() ? `
        <button class="secondary" data-action="pause">
          ${s.paused ? 'Продолжить игру' : 'Пауза'}
        </button>
      ` : ''}

      ${session ? `
        <button class="secondary" data-action="room">
          QR-код и приглашение
        </button>
      ` : ''}

      ${s?.log.length ? `
        <button class="secondary" data-action="log">
          История партии
        </button>
      ` : ''}

      <button class="secondary" data-action="rules">
        Правила
      </button>

      <button class="secondary" data-action="home">
        На главную · партия сохранится
      </button>

      ${mode === 'local' && s ? `
        <button class="danger" data-action="new-confirm">
          Начать новую локальную партию
        </button>
      ` : ''}
    </div>
  `);
};

function coords(index) {
  if (index <= 10) return [11, 11 - index];
  if (index <= 20) return [21 - index, 1];
  if (index <= 30) return [1, index - 19];
  return [index - 29, 11];
}

const symbols = {
  start: '↗',
  jail: '▦',
  parking: 'P',
  gotojail: '↪',
  chance: '?',
  chest: '▣',
  rail: '♜',
  utility: '⚙',
  tax: '◇'
};

function board(state, hero = false) {
  const active = current(state);
  const p = actor(state) || active;
  const xy = p ? coords(p.position) : [11, 11];

  const tiles = BOARD.map((cell, index) => {
    const [row, col] = coords(index);
    const property = state.properties[index];

    const owner = state.players.find(
      item => item.id === property.owner
    );

    const here = state.players.filter(
      item => !item.bankrupt && item.position === index
    );

    const tokens = here.map((item, number) => `
      <span
        class="token ${
          item.id === active?.id && !hero ? 'active' : ''
        }"
        data-token="${esc(item.id)}"
        title="${esc(item.name)}"
        style="
          --token-color:${COLORS[item.token]};
          --dx:${here.length > 1 ? (number % 3 - 1) * 11 : 0}px;
          --dy:${Math.floor(number / 3) * 10}px
        "
      >${TOKENS[item.token]}</span>
    `).join('');

    const buildings = property.houses ? `
      <span class="buildings">
        ${property.houses === 5
          ? '<i class="house hotel"></i>'
          : '<i class="house"></i>'.repeat(property.houses)}
      </span>
    ` : '';

    return `
      <button
        class="
          tile ${cell.type}
          ${index % 10 === 0 ? 'corner' : ''}
          ${property.owner ? 'owned' : ''}
          ${property.mortgaged ? 'mortgaged' : ''}
          ${selected === index ? 'selected' : ''}
        "
        style="
          grid-row:${row};
          grid-column:${col};
          --group:${GROUP_COLORS[cell.group] || '#9eae8c'};
          --owner:${owner ? COLORS[owner.token] : 'transparent'}
        "
        data-action="property"
        data-index="${index}"
        aria-label="${
          esc(cell.name)
        }${cell.price ? ', цена ' + cell.price : ''}${
          owner ? ', владелец ' + esc(owner.name) : ''
        }"
      >
        ${cell.type === 'street'
          ? '<span class="stripe"></span>'
          : `<span class="tile-icon">${
              symbols[cell.type] || '◆'
            }</span>`}

        <span class="tile-name">${esc(cell.name)}</span>

        ${cell.price
          ? `<span class="tile-price">${money(cell.price)}</span>`
          : ''}

        ${buildings}
        ${tokens}
      </button>
    `;
  }).join('');

  return `
    <div
      class="stage
        ${!hero && camera === 'flat' ? 'flat' : ''}
        ${!hero && camera === 'follow' ? 'follow' : ''}
      "
      style="--cx:${(6 - xy[1]) * 2}%;--cy:${(6 - xy[0]) * 2}%"
    >
      <div class="board-wrap">
        <div class="board">
          <div class="board-center">
            <div class="center-city">
              ${[35, 60, 48, 80, 50, 32].map(height => `
                <i class="skyline" style="height:${height}px"></i>
              `).join('')}
            </div>

            <div class="center-title">
              МОНОПОЛИЯ
              <small>ЗА ОДНИМ СТОЛОМ</small>
            </div>

            <div class="center-caption">
              БОЛЬШИЕ ПЛАНЫ. ВАШ ХОД.
            </div>
          </div>

          ${tiles}
        </div>
      </div>
    </div>
  `;
}

function demo() {
  let state = newGame();

  state = addPlayer(state, {
    id: 'a',
    name: 'Артём',
    token: 0
  });

  state = addPlayer(state, {
    id: 'b',
    name: 'Настя',
    token: 1
  });

  state.players[0].position = 6;
  state.players[1].position = 24;

  for (const index of [
    1, 3, 6, 8, 9, 21, 23, 24, 31, 32, 34
  ]) {
    state.properties[index].owner = index < 10 ? 'a' : 'b';
  }

  for (const index of [6, 8, 9]) {
    state.properties[index].houses = 2;
  }

  for (const index of [21, 23, 24]) {
    state.properties[index].houses = 3;
  }

  return state;
}

function home() {
  mode = 'home';
  s = null;

  app.innerHTML = `
    <section class="home">
      <div class="hero-copy">
        <div class="eyebrow">
          ВЕЧЕР, КОТОРЫЙ СОБИРАЕТ ВСЕХ
        </div>

        <h1>
          Большие планы.<br>
          За одним<br>
          <em>столом.</em>
        </h1>

        <p>
          Покупайте улицы, стройте отели и договаривайтесь.
          Любимая настольная игра — теперь на вашем экране.
        </p>

        <div class="row">
          <button class="primary" data-action="local">
            Играть за одним экраном <span>↗</span>
          </button>

          <button class="secondary" data-action="host">
            Создать комнату
          </button>
        </div>

        ${read('mtv-local') ? `
          <button class="secondary" data-action="resume">
            Продолжить локальную партию
          </button>
        ` : ''}

        ${read('mtv-session') ? `
          <button
            class="secondary"
            data-action="reconnect"
            style="margin-top:8px"
          >Вернуться в онлайн-комнату</button>
        ` : ''}

        <form id="join-code" class="join-line">
          <input
            name="code"
            aria-label="Код комнаты"
            placeholder="Код комнаты"
            maxlength="8"
            pattern="[a-fA-F0-9]{8}"
            required
            autocomplete="off"
          >
          <button class="secondary" type="submit">
            Присоединиться →
          </button>
        </form>

        <div class="hero-foot">
          <span>2–10 игроков</span>
          <span>Без установки</span>
          <span>ПК · ТВ · телефон</span>
        </div>
      </div>

      <div class="hero-board">
        ${board(demo(), true)}
      </div>
    </section>

    <p class="home-note">
      Классические механики · Свои названия улиц ·
      Для уютных вечеров в компании
    </p>
  `;

  connection();
}

function newLocal() {
  closeConnection();
  mode = 'local';
  s = newGame();

  s = addPlayer(s, {
    id: uid(),
    name: 'Артём',
    token: 0
  });

  s = addPlayer(s, {
    id: uid(),
    name: 'Настя',
    token: 1
  });

  saveLocal();
  render();
}

function saveLocal() {
  if (mode === 'local') {
    store('mtv-local', s);
  }
}

function connection() {
  const indicator = $('#connection');

  indicator.textContent = mode === 'online'
    ? (
        ws?.readyState === 1
          ? 'Комната ' + session.code
          : 'Переподключение…'
      )
    : 'Локальная игра';

  indicator.classList.toggle(
    'offline',
    mode === 'online' && ws?.readyState !== 1
  );
}

function lobby() {
  const free = TOKENS.map((token, index) =>
    !s.players.some(p => p.token === index)
      ? `<option value="${index}">${token}</option>`
      : ''
  ).join('');

  const players = s.players.map(p => `
    <div class="lobby-person">
      <span
        class="mini-token"
        style="--c:${COLORS[p.token]}"
      >${TOKENS[p.token]}</span>

      <div>
        <strong>${esc(p.name)}</strong>
        <div class="player-detail">
          ${p.controller === 'phone'
            ? 'Личный телефон'
            : 'Общее устройство'}
        </div>
      </div>

      ${isHost() ? `
        <button
          class="icon-btn"
          data-action="remove"
          data-id="${esc(p.id)}"
          aria-label="Удалить ${esc(p.name)}"
        >×</button>
      ` : ''}
    </div>
  `).join('');

  return `
    <div class="lobby-layout">
      <section>
        <div class="eyebrow">
          ${mode === 'local'
            ? 'ОДИН ЭКРАН · ОДНА КОМПАНИЯ'
            : 'ИГРОВАЯ КОМНАТА'}
        </div>

        <h1>Все за столом?</h1>

        <p class="muted">
          ${mode === 'local'
            ? 'Добавьте имена и выберите фигурки. Управление передаётся по очереди.'
            : 'Пригласите друзей по QR-коду. Можно добавить игроков, которые будут пользоваться общим устройством.'}
        </p>

        <div class="lobby-players">${players}</div>

        ${isHost() && s.players.length < 10 ? `
          <form id="add-player" class="add-form">
            <input
              name="name"
              placeholder="Имя игрока"
              maxlength="20"
              aria-label="Имя игрока"
              required
            >

            <select name="token" aria-label="Фигурка">
              ${free}
            </select>

            <button class="secondary" type="submit">
              + Добавить
            </button>
          </form>
        ` : ''}

        ${isHost()
          ? cmdBtn(
              'Начать партию →',
              'START',
              '',
              'primary wide',
              s.players.length < 2
            )
          : `
              <div class="notice">
                Вы в игре. Организатор скоро начнёт партию.
              </div>
            `}

        <p class="muted small">
          ${s.players.length} из 10 игроков ·
          Начальный капитал: 1 500
        </p>
      </section>

      <aside>
        ${mode === 'online' ? inviteHTML() : `
          <div class="card">
            <div class="eyebrow">КАК ИГРАТЬ</div>
            <h2>Передавайте ход</h2>

            <ul class="info-list">
              <li>На ПК — пользуйтесь мышью по очереди.</li>
              <li>На телефоне — передавайте устройство.</li>
              <li>
                На ТВ — переключайте кнопки стрелками пульта
                и нажимайте OK.
              </li>
            </ul>

            <div class="notice">
              Партия сохраняется автоматически в этом браузере.
              Вернуться можно с главного экрана.
            </div>

            <div class="divider"></div>

            <button
              class="secondary wide"
              data-action="rules"
            >Открыть правила</button>
          </div>
        `}
      </aside>
    </div>
  `;
}

function joinURL() {
  const url = new URL(location.href);

  url.hash = new URLSearchParams({
    room: session.code,
    server: apiBase()
  }).toString();

  return url.href;
}

function inviteHTML() {
  return `
    <div class="card qr-card">
      <div class="eyebrow">
        ПРИСОЕДИНИТЬСЯ С ТЕЛЕФОНА
      </div>

      <h2>Отсканируйте QR</h2>
      <div class="qr" id="qr-target"></div>
      <div class="room-code">${session.code}</div>

      <button
        class="secondary wide"
        data-action="copy-invite"
      >Скопировать приглашение</button>

      <div class="notice">
        Откройте ссылку, введите имя и выберите свободную фигурку.
        Ссылку можно отправить и другу в другом месте.
      </div>
    </div>
  `;
}

function fillQR() {
  const target = $('#qr-target');

  if (!target || !session) return;

  try {
    const qr = window.qrcode(0, 'M');
    qr.addData(joinURL());
    qr.make();

    target.innerHTML = qr.createSvgTag({
      cellSize: 3,
      margin: 3,
      scalable: true
    });
  } catch {
    target.textContent = 'Используйте ссылку-приглашение';
  }
}

const pipPositions = {
  1: [4],
  2: [0, 8],
  3: [0, 4, 8],
  4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8],
  6: [0, 2, 3, 5, 6, 8]
};

function diceHTML() {
  return `
    <div class="dice-row">
      ${s.dice.map(number => `
        <div class="die" aria-label="Кубик ${number}">
          ${Array.from({ length: 9 }, (_, index) => `
            <i ${
              pipPositions[number].includes(index)
                ? 'class="pip"'
                : ''
            }></i>
          `).join('')}
        </div>
      `).join('')}

      <span class="dice-total">
        ${s.dice[0] + s.dice[1]}
      </span>
    </div>
  `;
}

function tradeDescription(trade) {
  const from = s.players.find(p => p.id === trade.from);
  const to = s.players.find(p => p.id === trade.to);

  return `
    <div class="trade-summary">
      <b>${esc(from.name)} отдаёт:</b>
      ${money(trade.pay)}
      ${trade.give.map(index =>
        ' · ' + esc(BOARD[index].name)
      ).join('')}
      ${trade.giveCards
        ? ' · карточек освобождения: ' + trade.giveCards
        : ''}

      <br>

      <b>${esc(to.name)} отдаёт:</b>
      ${money(trade.receive)}
      ${trade.take.map(index =>
        ' · ' + esc(BOARD[index].name)
      ).join('')}
      ${trade.takeCards
        ? ' · карточек освобождения: ' + trade.takeCards
        : ''}

      <br>

      <small>
        За полученные залоги банк сразу берёт
        10% залоговой стоимости.
      </small>
    </div>
  `;
}

function turnCard() {
  const p = actor(s) || current(s);
  const mine = controls(p.id);
  const trade = s.trade;

  let content = '';

  if (s.paused) {
    content = `
      <p class="action-info">Партия на паузе.</p>

      ${isHost()
        ? `
            <button class="primary wide" data-action="pause">
              Продолжить
            </button>
          `
        : '<p class="muted">Ожидаем организатора.</p>'}
    `;
  } else if (trade) {
    content = `
      <p class="action-info">Предложение обмена</p>
      ${tradeDescription(trade)}

      <div class="turn-actions" style="margin-top:14px">
        ${controls(trade.to)
          ? cmdBtn(
              'Принять обмен',
              'TRADE_REPLY',
              `data-accept="true" data-actor="${esc(trade.to)}"`
            ) + cmdBtn(
              'Отклонить',
              'TRADE_REPLY',
              `data-accept="false" data-actor="${esc(trade.to)}"`,
              'secondary'
            )
          : ''}

        ${controls(trade.from)
          ? cmdBtn(
              'Отменить предложение',
              'CANCEL_TRADE',
              `data-actor="${esc(trade.from)}"`,
              'secondary'
            )
          : ''}
      </div>
    `;
  } else if (!mine) {
    content = `
      <p class="action-info">
        ${s.phase === 'auction'
          ? 'Ставку делает'
          : 'Ожидаем действие игрока'}
        <b>${esc(p.name)}</b>.
      </p>

      <div class="notice">
        ${session?.role === 'player'
          ? 'Ваша собственность — в разделе «Мои активы».'
          : 'Игрок управляет со своего телефона.'}
      </div>
    `;
  } else if (s.phase === 'roll') {
    content = `
      ${p.jailed ? `
        <p class="action-info">
          В тюрьме: попытка ${p.jailTurns + 1} из 3.
          Для выхода нужен дубль, плата 50 или карточка.
        </p>

        <div class="row" style="margin-bottom:10px">
          ${cmdBtn(
            'Заплатить 50',
            'JAIL_PAY',
            '',
            'secondary',
            p.money < 50
          )}

          ${p.jailCards.length
            ? cmdBtn(
                'Карточка',
                'JAIL_CARD',
                '',
                'secondary'
              )
            : ''}
        </div>
      ` : `
        <p class="action-info">
          Город ждёт вашего следующего шага.
        </p>
      `}

      ${cmdBtn(
        'Бросить кубики ↗',
        'ROLL',
        '',
        'primary wide'
      )}
    `;
  } else if (s.phase === 'buy') {
    const cell = BOARD[p.position];

    content = `
      <p class="action-info">
        <b>${esc(cell.name)}</b><br>
        Свободная собственность · ${money(cell.price)}
      </p>

      <div class="turn-actions">
        ${cmdBtn(
          'Купить за ' + money(cell.price),
          'BUY',
          '',
          'primary',
          p.money < cell.price
        )}

        ${cmdBtn(
          'Отправить на аукцион',
          'AUCTION',
          '',
          'secondary'
        )}
      </div>
    `;
  } else if (s.phase === 'auction') {
    const auction = s.auction;
    const high = s.players.find(
      item => item.id === auction.high
    );

    content = `
      <p class="action-info">
        Аукцион: <b>${esc(BOARD[auction.index].name)}</b><br>
        ${high
          ? esc(high.name) + ' предлагает ' + money(auction.bid)
          : 'Начальная ставка — от 1.'}
      </p>

      <form id="bid-form" class="stack">
        <input
          name="amount"
          aria-label="Сумма ставки"
          type="number"
          min="${auction.bid + 1}"
          max="${p.money}"
          value="${Math.min(p.money, auction.bid + 10)}"
          step="1"
          required
        >

        <button
          class="primary"
          type="submit"
          ${p.money <= auction.bid ? 'disabled' : ''}
        >Сделать ставку</button>

        ${cmdBtn(
          'Выйти из аукциона',
          'PASS',
          '',
          'secondary'
        )}
      </form>
    `;
  } else if (s.phase === 'debt') {
    const debt = s.debt;

    content = `
      <p class="action-info">
        Необходимо выплатить <b>${money(debt.amount)}</b>.<br>
        ${esc(debt.note)}. У вас ${money(p.money)}.
      </p>

      <div class="turn-actions">
        ${cmdBtn(
          'Выплатить долг',
          'PAY_DEBT',
          '',
          'primary',
          p.money < debt.amount
        )}

        <button class="secondary" data-action="assets">
          Продать здания / заложить
        </button>

        <button class="secondary" data-action="trade">
          Предложить обмен
        </button>

        <button class="danger" data-action="bankrupt-confirm">
          Объявить банкротство
        </button>
      </div>
    `;
  } else if (s.phase === 'end') {
    content = `
      <p class="action-info">
        ${p.jailed
          ? 'Следующий ход начнётся в тюрьме.'
          : s.extra
            ? 'Дубль! У вас будет дополнительный бросок.'
            : 'Можно управлять собственностью или передать ход.'}
      </p>

      ${cmdBtn(
        s.extra
          ? 'Дополнительный бросок →'
          : 'Завершить ход →',
        'END',
        '',
        'primary wide'
      )}
    `;
  }

  return `
    <div class="card turn-card ${busy ? 'rolling' : ''}">
      <span class="turn-number">РАУНД ${s.round}</span>

      <div class="eyebrow">
        ${s.phase === 'auction'
          ? 'АУКЦИОН · СТАВКА'
          : s.debt
            ? 'ПОГАШЕНИЕ ДОЛГА'
            : 'СЕЙЧАС ХОДИТ'}
      </div>

      <div class="turn-player">
        <h2>${esc(p.name)}</h2>
        <span
          class="mini-token"
          style="--c:${COLORS[p.token]};margin-left:auto"
        >${TOKENS[p.token]}</span>
      </div>

      <div class="muted">
        ${money(p.money)} на счёте ·
        ${esc(BOARD[p.position].name)}
      </div>

      ${diceHTML()}

      ${s.card ? `
        <p
          class="small"
          style="
            line-height:1.6;
            border-top:1px solid #ffffff20;
            padding-top:12px
          "
        >
          ${s.card.kind === 'chance' ? 'ШАНС' : 'КАЗНА'}
          · ${esc(s.card.text)}
        </p>
      ` : ''}

      ${content}
    </div>
  `;
}

function playersCard() {
  const players = s.players.map(p => `
    <div
      class="player-row
        ${p.id === current(s).id ? 'current' : ''}
        ${p.bankrupt ? 'bankrupt' : ''}
      "
      style="--c:${COLORS[p.token]}"
    >
      <span class="avatar">${TOKENS[p.token]}</span>

      <div>
        <div class="player-name">
          ${esc(p.name)}

          ${mode === 'online' && p.controller === 'phone' ? `
            <span
              class="dot"
              style="--c:${
                online.includes(p.id) ? '#7ba884' : '#d1b08c'
              }"
              title="${
                online.includes(p.id) ? 'В сети' : 'Не в сети'
              }"
            ></span>
          ` : ''}
        </div>

        <div class="player-detail">
          ${p.bankrupt
            ? 'Банкрот'
            : s.properties.filter(
                property => property.owner === p.id
              ).length + ' участков' +
              (p.jailed ? ' · в тюрьме' : '')}
        </div>
      </div>

      <span class="player-money">
        ${p.bankrupt ? '—' : money(p.money)}
      </span>
    </div>
  `).join('');

  const tradeDisabled =
    !controls(actor(s)?.id) ||
    !['roll', 'buy', 'end', 'debt'].includes(s.phase) ||
    s.trade ||
    s.paused;

  return `
    <div class="card">
      <div class="player-line">
        <span class="eyebrow">ЗА СТОЛОМ</span>
        <span class="tag">
          ${s.players.filter(p => !p.bankrupt).length} игроков
        </span>
      </div>

      <div class="player-list">${players}</div>

      <div class="under-actions">
        <button class="secondary" data-action="assets">
          ${session?.role === 'player'
            ? 'Мои активы'
            : 'Собственность'}
        </button>

        <button
          class="secondary"
          data-action="trade"
          ${tradeDisabled ? 'disabled' : ''}
        >Обмен ⇄</button>
      </div>
    </div>
  `;
}

function game() {
  const stock = bankStock(s);

  const heading = `
    <div class="table-head">
      <div>
        <div class="eyebrow">
          ${session
            ? 'КОМНАТА ' + session.code
            : 'ВЕЧЕР ЗА ОДНИМ СТОЛОМ'}
        </div>
        <h2>Город начинается с вас.</h2>
      </div>

      <div class="view-controls" aria-label="Камера">
        ${[
          ['angle', '3D'],
          ['flat', 'Сверху'],
          ['follow', 'Ближе']
        ].map(([value, text]) => `
          <button
            class="${camera === value ? 'chosen' : ''}"
            data-action="camera"
            data-camera="${value}"
          >${text}</button>
        `).join('')}
      </div>
    </div>
  `;

  if (session?.role === 'player') {
    return `
      <div class="phone-screen">
        <div class="row between">
          <div class="eyebrow">
            ВАШ ПУЛЬТ · ${esc(me()?.name || 'Игрок')}
          </div>

          <button
            class="secondary"
            data-action="room"
            style="padding:7px"
          >${session.code}</button>
        </div>

        ${board(s)}
        ${turnCard()}
        ${playersCard()}
      </div>
    `;
  }

  return `
    <div class="layout">
      <section>
        ${heading}
        ${board(s)}

        <div class="board-footer">
          <div class="legend">
            <span>
              <i
                class="dot"
                style="--c:${COLORS[current(s).token]}"
              ></i>
              Подсвечена активная фигурка
            </span>
          </div>

          <span>
            Банк: ${stock.houses} домов ·
            ${stock.hotels} отелей
          </span>
        </div>
      </section>

      <aside class="sidebar">
        ${turnCard()}
        ${playersCard()}
      </aside>

      <section class="activity">
        <div>
          <div class="activity-label">ХРОНИКА ИГРЫ</div>

          <button
            class="icon-btn"
            data-action="log"
            aria-label="Вся история"
            style="margin-top:10px"
          >↗</button>
        </div>

        <div class="activity-list">
          ${s.log.slice(-3).reverse().map(text => `
            <div class="activity-item">${esc(text)}</div>
          `).join('')}
        </div>
      </section>
    </div>
  `;
}

function render() {
  if (!s) return;

  const focused = document.activeElement;
  const key =
    focused?.dataset?.command || focused?.dataset?.action;

  const previousPositions = new Map(
    [...document.querySelectorAll('[data-token]')].map(node => [
      node.dataset.token,
      node.getBoundingClientRect()
    ])
  );

  if (s.status === 'lobby') {
    app.innerHTML = lobby();
  } else if (s.status === 'finished') {
    const winner = s.players.find(p => p.id === s.winner);

    app.innerHTML = `
      <div class="phone-screen">
        <div class="card winner">
          <div class="trophy">♛</div>
          <div class="eyebrow">ПОБЕДИТЕЛЬ ПАРТИИ</div>
          <h1>${esc(winner?.name || '')}</h1>

          <p class="muted">
            Последний игрок на поле. Город принадлежит вам.
          </p>

          <button class="primary" data-action="home">
            На главную
          </button>

          <button class="secondary" data-action="log">
            История партии
          </button>
        </div>

        ${playersCard()}
      </div>
    `;
  } else {
    app.innerHTML = game();
  }

  fillQR();
  connection();

  if (key && !$('#modal').open) {
    const element = [...app.querySelectorAll('button')].find(
      button =>
        button.dataset.command === key ||
        button.dataset.action === key
    );

    element?.focus({ preventScroll: true });
  }

  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
    for (const node of app.querySelectorAll('[data-token]')) {
      const before = previousPositions.get(node.dataset.token);
      const after = node.getBoundingClientRect();

      if (
        before &&
        (
          Math.abs(before.x - after.x) > 4 ||
          Math.abs(before.y - after.y) > 4
        )
      ) {
        node.animate([
          {
            translate:
              `${before.x - after.x}px ${before.y - after.y}px`
          },
          { translate: '0 0' }
        ], {
          duration: 650,
          easing: 'ease-in-out'
        });
      }
    }
  }

  if (modalKind === 'property' && selected !== null) {
    property(selected);
  }

  if (modalKind === 'assets') {
    assets();
  }
}

async function command(type, extra = {}, id) {
  if (busy) return;

  id ??= actor(s)?.id;

  if (mode === 'online' && ws?.readyState !== 1) {
    toast('Связь восстанавливается. Подождите.');
    return;
  }

  try {
    if (type === 'ROLL') {
      busy = true;
      render();
      beep();

      await new Promise(resolve => setTimeout(resolve, 450));
    }

    if (mode === 'local') {
      s = applyCommand(s, { type, ...extra }, id, rand);
      invariant(s);
      saveLocal();
      busy = false;
      render();
    } else {
      ws.send(JSON.stringify({
        type: 'command',
        rev: s.rev,
        actor: id,
        command: { type, ...extra }
      }));

      busy = false;
    }
  } catch (error) {
    busy = false;
    render();
    toast(error.message);
  }
}

function property(index) {
  selected = index;

  const cell = BOARD[index];
  const item = s.properties[index];
  const owner = s.players.find(p => p.id === item.owner);
  const active = actor(s);

  const canManage =
    active &&
    item.owner === active.id &&
    controls(active.id) &&
    !s.paused &&
    !s.trade &&
    ['roll', 'buy', 'end', 'debt'].includes(s.phase);

  let html = `
    <div
      class="property-banner"
      style="--group:${GROUP_COLORS[cell.group] || '#7e9c83'}"
    >${esc(cell.name)}</div>
  `;

  if (!cell.price) {
    const descriptions = {
      start:
        'При прохождении или остановке получите 200. ' +
        'Двойной выплаты за остановку нет.',
      chance:
        'Возьмите карточку «Шанс» и выполните указание.',
      chest:
        'Возьмите карточку «Общественная казна».',
      tax:
        'Обязательный платёж в банк: ' + cell.amount + '.',
      jail:
        'Посещение бесплатно. Заключённый выходит ' +
        'с дублем, карточкой или за 50.',
      parking:
        'Отдых. Никаких выплат и штрафов.',
      gotojail:
        'Сразу отправляйтесь в тюрьму. ' +
        'За прохождение Старта выплаты нет.'
    };

    html += `
      <p class="rules-text">${descriptions[cell.type]}</p>
    `;
  } else {
    html += `
      <p class="muted">
        ${owner
          ? 'Владелец: ' + esc(owner.name)
          : 'Свободная собственность'}
        ${item.mortgaged ? ' · В залоге' : ''}
      </p>

      <table class="rent-table">
        <tr>
          <td>Цена покупки</td>
          <td>${money(cell.price)}</td>
        </tr>
    `;

    if (cell.rents) {
      const labels = [
        'Аренда участка',
        'С 1 домом',
        'С 2 домами',
        'С 3 домами',
        'С 4 домами',
        'С отелем'
      ];

      html += cell.rents.map((amount, number) => `
        <tr>
          <td>${labels[number]}</td>
          <td>${money(amount)}</td>
        </tr>
      `).join('');

      html += `
        <tr>
          <td>Дом / отель (замена 4 домов)</td>
          <td>${cell.build}</td>
        </tr>
      `;
    } else {
      html += `
        <tr>
          <td>Аренда</td>
          <td>
            ${cell.type === 'rail'
              ? '25 / 50 / 100 / 200'
              : '4 × кубики / 10 × кубики'}
          </td>
        </tr>
      `;
    }

    html += `
        <tr>
          <td>Залог / выкуп с процентами</td>
          <td>
            ${cell.price / 2} /
            ${cell.price / 2 + Math.ceil(cell.price * 0.05)}
          </td>
        </tr>
      </table>

      ${cell.rents ? `
        <p class="muted small">
          Полная группа без зданий удваивает базовую аренду.
          Заложенные участки аренду не приносят.
        </p>
      ` : ''}
    `;

    if (canManage) {
      html += `
        <div class="property-actions">
          ${item.mortgaged
            ? cmdBtn(
                'Выкупить',
                'REDEEM',
                `data-index="${index}"`,
                'secondary'
              )
            : cmdBtn(
                'Заложить',
                'MORTGAGE',
                `data-index="${index}"`,
                'secondary'
              )}

          ${cell.type === 'street'
            ? cmdBtn(
                'Построить',
                'BUILD',
                `data-index="${index}"`,
                'secondary'
              ) + cmdBtn(
                'Продать здание',
                'SELL',
                `data-index="${index}"`,
                'secondary'
              )
            : ''}
        </div>
      `;
    }
  }

  openModal(cell.name, html, 'property');
}

function assets() {
  if (!s) return;

  const p = session?.role === 'player' ? me() : actor(s);
  if (!p) return;

  const own = s.properties
    .map((item, index) => item.owner === p.id ? index : -1)
    .filter(index => index >= 0);

  openModal('Активы · ' + p.name, `
    <div class="row between">
      <p class="muted">
        На счёте: <b>${money(p.money)}</b>
      </p>
      <span class="tag">
        Карточек выхода: ${p.jailCards.length}
      </span>
    </div>

    ${own.length ? `
      <div class="asset-grid">
        ${own.map(index => `
          <button
            class="asset-btn"
            style="--group:${
              GROUP_COLORS[BOARD[index].group] || '#97a991'
            }"
            data-action="property"
            data-index="${index}"
          >
            <b>${esc(BOARD[index].name)}</b><br>
            ${s.properties[index].mortgaged
              ? 'В залоге'
              : s.properties[index].houses === 5
                ? 'Отель'
                : s.properties[index].houses + ' домов'}
            · ${BOARD[index].price}
          </button>
        `).join('')}
      </div>
    ` : `
      <p class="notice">
        Собственности пока нет. Покупайте свободные участки
        или участвуйте в аукционах.
      </p>
    `}

    <p class="muted small">
      Нажмите на участок, чтобы управлять им.
      Строительство, продажа и залог доступны
      управляющему игроку в его действие.
    </p>
  `, 'assets');
}

function trade() {
  const active = actor(s);

  if (
    !active ||
    !controls(active.id) ||
    s.trade ||
    s.paused ||
    !['roll', 'buy', 'end', 'debt'].includes(s.phase)
  ) {
    toast('Обмен сейчас недоступен');
    return;
  }

  const others = s.players.filter(
    p => p.id !== active.id && !p.bankrupt
  );

  openModal('Предложить обмен', `
    <form id="trade-form" class="stack">
      <label class="input-label">
        С кем договориться?

        <select
          name="to"
          id="trade-to"
          style="display:block;width:100%;margin-top:8px"
        >
          ${others.map(p => `
            <option value="${esc(p.id)}">${esc(p.name)}</option>
          `).join('')}
        </select>
      </label>

      <div id="trade-fields"></div>

      <p class="notice">
        Участки с застроенной цветовой группой обменять нельзя.
        За полученный залог сразу уплачиваются 10% его
        залоговой стоимости; сам залог сохраняется.
      </p>

      <button class="primary" type="submit">
        Отправить предложение
      </button>
    </form>
  `, 'trade');

  tradeFields();
}

function tradeFields() {
  const from = actor(s);
  const to = s.players.find(
    p => p.id === $('#trade-to').value
  );

  const options = (p, name) => s.properties.map(
    (item, index) => item.owner === p.id ? `
      <label class="check-row">
        <input
          type="checkbox"
          name="${name}"
          value="${index}"
        >
        ${esc(BOARD[index].name)}
        ${item.mortgaged ? ' (залог)' : ''}
      </label>
    ` : ''
  ).join('');

  const columns = [
    [from, 'give', 'pay', 'giveCards', 'Вы отдаёте'],
    [to, 'take', 'receive', 'takeCards', 'Вы получаете']
  ];

  $('#trade-fields').innerHTML = `
    <div class="trade-columns">
      ${columns.map(([p, list, cash, cards, label]) => `
        <div>
          <h3>${label}</h3>

          <label class="input-label">
            Деньги
            <input
              name="${cash}"
              type="number"
              min="0"
              max="${p.money}"
              value="0"
              step="1"
              required
            >
          </label>

          <div class="trade-options">
            ${options(p, list) ||
              '<span class="muted small">Нет участков</span>'}
          </div>

          <label class="input-label">
            Карточки выхода
            <input
              name="${cards}"
              type="number"
              min="0"
              max="${p.jailCards.length}"
              value="0"
              step="1"
              required
            >
          </label>
        </div>
      `).join('')}
    </div>
  `;
}

function showRules() {
  openModal('Правила партии', `
    <div class="rules-text">
      <p>
        Классическая экономическая игра с фиксированными
        налогами и собственными названиями улиц.
        2–10 игроков; 9–10 — расширенный состав.
        Начальный капитал — 1 500.
      </p>

      <ul>
        <li>
          Два кубика. За Старт — 200.
          Дубль даёт повторный бросок после завершения действий.
          Третий дубль подряд отправляет в тюрьму.
        </li>

        <li>
          Свободную собственность можно купить.
          Отказ запускает аукцион для всех, включая
          отказавшегося игрока. Ставки по очереди, от 1;
          пас выводит из текущего аукциона.
        </li>

        <li>
          Аренда оплачивается автоматически.
          Владелец в тюрьме продолжает получать аренду.
          Залог не приносит аренды.
          За полную цветовую группу базовая аренда удваивается,
          в том числе если другой участок группы заложен.
        </li>

        <li>
          Для строительства нужна вся группа без залогов.
          Стройте и продавайте равномерно.
          После 4 домов — отель за цену ещё одного дома.
          В банке 32 дома и 12 отелей.
          Отель при обычной продаже заменяется
          4 домами из банка.
        </li>

        <li>
          Здания продаются за половину стоимости.
          Залог — половина цены участка;
          выкуп — залог плюс 10%.
          Перед залогом или обменом продайте
          все здания группы.
        </li>

        <li>
          В тюрьме: до броска заплатите 50
          или используйте карточку.
          Либо пробуйте выбросить дубль.
          Дубль освобождает и перемещает,
          без повторного броска.
          После третьей неудачи обязательно заплатите 50
          и переместитесь на выпавшее число.
        </li>

        <li>
          При долге продайте здания, заложите участки
          или предложите обмен.
          Если не можете расплатиться, объявите банкротство.
          Кредитору переходят деньги, участки и карточки выхода;
          за полученные залоги он платит банку 10%.
          При долге банку участки разыгрываются на аукционах.
        </li>

        <li>
          Парковка бесплатна. Налоги и штрафы идут в банк.
          Банк не выдаёт частных займов.
        </li>

        <li>
          Управление активами и предложение обмена
          доступны во время действия игрока,
          включая погашение долга.
          Это явное упрощение порядка действий цифровой версии.
          На аукционах и при ответе на обмен
          действуют другие игроки.
        </li>

        <li>
          Побеждает последний оставшийся игрок.
          Ограничения по времени нет.
        </li>
      </ul>

      <p>
        <b>ТВ:</b> стрелки переключают кнопки,
        OK / Enter подтверждает,
        Back / Escape закрывает окно.
        На старых ТВ доступность зависит от браузера.
      </p>

      <p class="small">
        Клавиши: R — бросить кубики,
        E — завершить ход (вне полей ввода).
        Локальная партия сохраняется в этом браузере.
        Онлайн-партия хранится сервером до 7 дней без действий,
        если хранилище сервера постоянно.
      </p>
    </div>
  `, 'rules');
}

async function request(path, body) {
  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, 15000);

  try {
    const response = await fetch(apiBase() + path, {
      method: body ? 'POST' : 'GET',
      headers: body ? {
        'Content-Type': 'application/json'
      } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Ошибка сервера');
    }

    return data;
  } catch (error) {
    throw new Error(
      error.name === 'AbortError'
        ? 'Сервер не ответил. Подождите и попробуйте ещё раз.'
        : error instanceof TypeError
          ? 'Сервер недоступен. Проверьте адрес и подключение.'
          : error.message
    );
  } finally {
    clearTimeout(timer);
  }
}

function serverSetup(message = '') {
  openModal('Подключение сервера', `
    <p class="muted">
      Локальная игра работает сразу.
      Для телефонов нужен сервер из папки server
      в архиве игры.
    </p>

    ${message
      ? `<p class="notice">${esc(message)}</p>`
      : ''}

    <form id="server-form" class="stack">
      <label class="input-label">
        HTTPS-адрес сервера
        <input
          style="width:100%;margin-top:8px"
          name="url"
          type="url"
          placeholder="https://ваш-сервер.example.com"
          value="${esc(endpoint)}"
          required
        >
      </label>

      <button class="primary" type="submit">
        Сохранить адрес и проверить
      </button>
    </form>

    <p class="muted small">
      Постоянный адрес задаётся в config.js.
      Подробная инструкция есть в README.md.
    </p>
  `, 'server');
}

async function host() {
  try {
    const data = await request('/api/rooms', {});
    session = { ...data, endpoint };
    store('mtv-session', session);
    closeModal();
    connect();
  } catch (error) {
    serverSetup(error.message);
  }
}

function closeConnection() {
  manualClose = true;
  clearTimeout(retry);

  if (ws) {
    ws.close();
  }

  ws = null;
  session = null;
  online = [];
}

function connect() {
  manualClose = false;
  mode = 'online';
  s = null;

  app.innerHTML = `
    <div class="phone-screen">
      <div class="card">
        <h2>Подключаемся к столу…</h2>
        <p class="muted">
          Восстанавливаем состояние партии.
        </p>
      </div>
    </div>
  `;

  connectSocket();
}

function connectSocket() {
  if (!session || (ws && ws.readyState < 2)) return;

  const url = new URL('/socket', apiBase());
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';

  const socket = new WebSocket(url);
  ws = socket;

  let authenticated = false;
  connection();

  socket.onopen = () => {
    socket.send(JSON.stringify({
      type: 'auth',
      code: session.code,
      token: session.token
    }));
  };

  socket.onmessage = event => {
    if (ws !== socket) return;

    try {
      const data = JSON.parse(event.data);

      if (data.type === 'ready') {
        authenticated = true;
        connection();
      }

      if (data.type === 'error') {
        toast(data.message);

        if (!authenticated) {
          manualClose = true;
          socket.close();

          openModal('Не удалось вернуться', `
            <p class="muted">${esc(data.message)}</p>
            <button class="primary" data-action="home">
              На главную
            </button>
          `);
        }

        return;
      }

      if (data.type === 'state') {
        s = data.state;
        online = data.online;
        busy = false;
        render();
      }
    } catch {
      toast('Получены некорректные данные сервера');
    }
  };

  socket.onclose = () => {
    if (ws !== socket) return;

    connection();

    if (!manualClose && session) {
      retry = setTimeout(connectSocket, 2500);
      toast('Связь прервалась. Восстанавливаем подключение…');
    }
  };

  socket.onerror = () => {};
}

async function join(code) {
  code = code.trim().toUpperCase();

  if (!/^[A-F0-9]{8}$/.test(code)) {
    toast('Введите код из 8 символов');
    return;
  }

  const saved = read('mtv-session');

  if (
    saved?.code === code &&
    saved.endpoint === endpoint
  ) {
    session = saved;
    connect();
    return;
  }

  try {
    const data = await request('/api/rooms/' + code);

    if (data.status !== 'lobby') {
      throw new Error(
        'Партия уже началась. ' +
        'Новые игроки смогут войти в следующую.'
      );
    }

    openModal('Ваше место за столом', `
      <form
        id="join-player"
        data-code="${code}"
        class="stack"
      >
        <label class="input-label">
          Ваше имя
          <input
            name="name"
            style="display:block;width:100%;margin-top:8px"
            maxlength="20"
            required
            autocomplete="nickname"
          >
        </label>

        <label class="input-label">
          Свободная фигурка
          <select
            name="token"
            style="display:block;width:100%;margin-top:8px"
          >
            ${TOKENS.map((token, index) =>
              data.players.some(p => p.token === index)
                ? ''
                : `<option value="${index}">${token}</option>`
            ).join('')}
          </select>
        </label>

        <button class="primary" type="submit">
          Присоединиться →
        </button>
      </form>
    `, 'join');
  } catch (error) {
    serverSetup(error.message);
  }
}

async function pause() {
  if (mode === 'local') {
    s.paused = !s.paused;
    s.rev++;
    saveLocal();
    closeModal();
    render();
  } else {
    ws?.send(JSON.stringify({ type: 'pause' }));
    closeModal();
  }
}

async function action(name, element) {
  switch (name) {
    case 'local':
      newLocal();
      break;

    case 'resume':
      try {
        const saved = read('mtv-local');

        if (!saved || saved.version !== 1) {
          throw new Error();
        }

        invariant(saved);
        closeConnection();
        s = saved;
        mode = 'local';
        render();
      } catch {
        toast('Сохранение повреждено или создано другой версией');
      }
      break;

    case 'host':
      await host();
      break;

    case 'reconnect':
      session = read('mtv-session');

      if (session) {
        endpoint = session.endpoint;
        connect();
      }
      break;

    case 'remove':
      if (mode === 'local') {
        s.players = s.players.filter(
          p => p.id !== element.dataset.id
        );

        s.rev++;
        saveLocal();
        render();
      } else {
        ws?.send(JSON.stringify({
          type: 'remove',
          id: element.dataset.id
        }));
      }
      break;

    case 'property':
      if (s) {
        property(Number(element.dataset.index));
      }
      break;

    case 'assets':
      assets();
      break;

    case 'trade':
      trade();
      break;

    case 'rules':
      showRules();
      break;

    case 'log':
      openModal('Хроника партии', `
        <div class="full-log">
          ${s.log.slice().reverse().map(text => `
            <div>${esc(text)}</div>
          `).join('')}
        </div>
      `, 'log');
      break;

    case 'camera':
      camera = element.dataset.camera;
      store('mtv-camera', camera);
      render();
      break;

    case 'pause':
      await pause();
      break;

    case 'room':
      openModal(
        'Пригласить за стол',
        inviteHTML(),
        'room'
      );
      fillQR();
      break;

    case 'copy-invite':
      try {
        await navigator.clipboard.writeText(joinURL());
        toast('Приглашение скопировано');
      } catch {
        openModal('Ссылка-приглашение', `
          <input
            readonly
            value="${esc(joinURL())}"
            style="width:100%"
          >
          <p class="muted">
            Нажмите на ссылку и скопируйте её.
          </p>
        `);
      }
      break;

    case 'home':
      closeModal();
      closeConnection();
      home();
      break;

    case 'new-confirm':
      openModal('Начать заново?', `
        <p class="muted">
          Текущая локальная партия будет заменена.
        </p>
        <button class="danger" data-action="new-yes">
          Начать новую партию
        </button>
      `);
      break;

    case 'new-yes':
      closeModal();
      newLocal();
      break;

    case 'bankrupt-confirm':
      openModal('Объявить банкротство?', `
        <p class="muted">
          Здания будут проданы банку.
          Если денег всё ещё не хватит на долг,
          ваша собственность перейдёт кредитору,
          а вы выйдете из партии.
        </p>
        <button class="danger" data-command="BANKRUPT">
          Подтвердить банкротство
        </button>
      `, 'bankrupt');
      break;
  }
}

document.addEventListener('click', async event => {
  const element = event.target.closest('button');

  if (!element || element.disabled) return;

  if (element.dataset.command) {
    const type = element.dataset.command;
    const extra = {};

    if (element.dataset.index !== undefined) {
      extra.index = Number(element.dataset.index);
    }

    if (type === 'TRADE_REPLY') {
      extra.accept = element.dataset.accept === 'true';
    }

    if (type === 'BANKRUPT') {
      closeModal();
    }

    await command(type, extra, element.dataset.actor);
  } else if (element.dataset.action) {
    element.disabled = true;

    try {
      await action(element.dataset.action, element);
    } catch (error) {
      toast(error.message);
    } finally {
      if (element.isConnected) {
        element.disabled = false;
      }
    }
  }
});

document.addEventListener('change', event => {
  if (event.target.id === 'trade-to') {
    tradeFields();
  }
});

document.addEventListener('submit', async event => {
  const form = event.target;

  if (!(form instanceof HTMLFormElement)) return;

  event.preventDefault();

  const data = new FormData(form);
  const button = form.querySelector('button[type="submit"]');

  if (button) {
    button.disabled = true;
  }

  try {
    if (form.id === 'add-player') {
      if (mode === 'local') {
        s = addPlayer(s, {
          id: uid(),
          name: data.get('name'),
          token: Number(data.get('token'))
        });

        saveLocal();
        render();
      } else {
        ws?.send(JSON.stringify({
          type: 'add',
          name: data.get('name'),
          token: Number(data.get('token'))
        }));
      }
    }

    if (form.id === 'join-code') {
      await join(String(data.get('code')));
    }

    if (form.id === 'bid-form') {
      await command('BID', {
        amount: Number(data.get('amount'))
      });
    }

    if (form.id === 'trade-form') {
      const extra = {
        to: data.get('to'),
        pay: Number(data.get('pay')),
        receive: Number(data.get('receive')),
        giveCards: Number(data.get('giveCards')),
        takeCards: Number(data.get('takeCards')),
        give: data.getAll('give').map(Number),
        take: data.getAll('take').map(Number)
      };

      if (mode === 'local') {
        const next = applyCommand(
          s,
          { type: 'TRADE', ...extra },
          actor(s).id,
          rand
        );

        invariant(next);
        s = next;
        saveLocal();
        closeModal();
        render();
      } else {
        closeModal();
        await command('TRADE', extra);
      }
    }

    if (form.id === 'server-form') {
      const url = new URL(data.get('url'));

      if (
        url.protocol !== 'https:' &&
        !(
          url.protocol === 'http:' &&
          location.protocol === 'http:'
        )
      ) {
        throw new Error('Используйте HTTPS-адрес сервера');
      }

      endpoint = url.origin;
      await request('/api/health');
      store('mtv-endpoint', endpoint);
      closeModal();

      toast(
        'Сервер доступен. Теперь можно создать комнату ' +
        'или войти по коду.'
      );
    }

    if (form.id === 'join-player') {
      const result = await request(
        '/api/rooms/' + form.dataset.code + '/join',
        {
          name: data.get('name'),
          token: Number(data.get('token'))
        }
      );

      session = { ...result, endpoint };
      store('mtv-session', session);
      closeModal();
      connect();
    }
  } catch (error) {
    toast(error.message);

    if (
      form.id === 'join-player' &&
      error.message.includes('занята')
    ) {
      const name = String(data.get('name'));
      await join(form.dataset.code);

      const input = $('#join-player input[name=name]');

      if (input) {
        input.value = name;
      }
    }
  } finally {
    if (button?.isConnected) {
      button.disabled = false;
    }
  }
});

document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    closeModal();
    return;
  }

  if (
    ['INPUT', 'SELECT', 'TEXTAREA'].includes(
      document.activeElement?.tagName
    )
  ) {
    return;
  }

  if (
    ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']
      .includes(event.key)
  ) {
    const root = $('#modal').open ? $('#modal') : document;

    const items = [...root.querySelectorAll(
      'button:not(:disabled),a[href],' +
      'input:not(:disabled),select:not(:disabled)'
    )].filter(node => node.getClientRects().length);

    if (!items.length) return;

    event.preventDefault();

    const focused = document.activeElement;
    const rect = focused?.getBoundingClientRect();

    if (!items.includes(focused)) {
      items[0].focus();
      return;
    }

    let best = null;
    let score = Infinity;

    for (const node of items) {
      if (node === focused) continue;

      const target = node.getBoundingClientRect();

      const dx =
        target.x + target.width / 2 -
        rect.x - rect.width / 2;

      const dy =
        target.y + target.height / 2 -
        rect.y - rect.height / 2;

      const horizontal =
        event.key.includes('Left') ||
        event.key.includes('Right');

      const main = horizontal ? dx : dy;
      const cross = horizontal ? dy : dx;

      const sign =
        event.key === 'ArrowLeft' ||
        event.key === 'ArrowUp'
          ? -1
          : 1;

      if (main * sign <= 3) continue;

      const candidateScore =
        Math.abs(main) + Math.abs(cross) * 2.5;

      if (candidateScore < score) {
        score = candidateScore;
        best = node;
      }
    }

    best?.focus();
  }

  if (!$('#modal').open && s?.status === 'playing') {
    if (
      event.key.toLowerCase() === 'r' &&
      s.phase === 'roll'
    ) {
      command('ROLL');
    }

    if (
      event.key.toLowerCase() === 'e' &&
      s.phase === 'end'
    ) {
      command('END');
    }
  }
});

window.addEventListener('online', () => {
  if (mode === 'online' && ws?.readyState !== 1) {
    clearTimeout(retry);
    connectSocket();
  }
});

document.addEventListener('visibilitychange', () => {
  if (
    !document.hidden &&
    mode === 'online' &&
    ws?.readyState === 1
  ) {
    ws.send(JSON.stringify({ type: 'sync' }));
  }
});

if (!params.has('server') && !endpoint) {
  endpoint = read('mtv-endpoint', '');
}

home();

if (params.has('room')) {
  join(params.get('room'));
}