import {
  BOARD,
  CHANCE,
  CHEST,
  RULES_VERSION
} from './data.js';

const copy = value => structuredClone(value);

const assert = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};

const player = (state, id) =>
  state.players.find(p => p.id === id);

export const current = state =>
  state.players[state.turn];

export const actor = state =>
  state.debt
    ? player(state, state.debt.payer)
    : state.phase === 'auction'
      ? player(state, state.auction.next)
      : current(state);

export const groupIndices = index =>
  BOARD
    .map((cell, i) =>
      cell.type === 'street' &&
      cell.group === BOARD[index].group
        ? i
        : -1
    )
    .filter(i => i >= 0);

export const ownsGroup = (state, id, index) =>
  BOARD[index].type === 'street' &&
  groupIndices(index).every(i =>
    state.properties[i].owner === id
  );

export const bankStock = state => ({
  houses: 32 - state.properties.reduce(
    (sum, property) =>
      sum + (property.houses < 5 ? property.houses : 0),
    0
  ),
  hotels: 12 - state.properties.filter(
    property => property.houses === 5
  ).length
});

function log(state, text) {
  state.log.push(text);
  state.log = state.log.slice(-150);
}

function shuffle(length, rng) {
  const result = Array.from(
    { length },
    (_, index) => index
  );

  for (let i = length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }

  return result;
}

export function newGame() {
  return {
    version: 1,
    rules: RULES_VERSION,
    rev: 0,
    status: 'lobby',
    phase: 'lobby',
    players: [],
    properties: BOARD.map(() => ({
      owner: null,
      houses: 0,
      mortgaged: false
    })),
    turn: 0,
    round: 1,
    dice: [1, 1],
    doubles: 0,
    extra: false,
    log: [],
    chance: [],
    chest: [],
    payments: [],
    debt: null,
    trade: null,
    auction: null,
    auctionQueue: [],
    card: null,
    paused: false
  };
}

export function addPlayer(
  state,
  { id, name, token, controller = 'local' }
) {
  const s = copy(state);

  assert(s.status === 'lobby', 'Партия уже началась');
  assert(s.players.length < 10, 'В комнате уже 10 игроков');

  name = String(name || '').trim().slice(0, 20);

  assert(name.length > 0, 'Введите имя');

  assert(
    !s.players.some(p => p.id === id),
    'Игрок уже добавлен'
  );

  assert(
    Number.isInteger(token) &&
    token >= 0 &&
    token < 10 &&
    !s.players.some(p => p.token === token),
    'Фигурка уже занята'
  );

  s.players.push({
    id,
    name,
    token,
    controller,
    money: 1500,
    position: 0,
    jailed: false,
    jailTurns: 0,
    jailCards: [],
    bankrupt: false
  });

  s.rev++;
  return s;
}

function die(rng) {
  return 1 + Math.floor(rng() * 6);
}

function jail(s, p) {
  p.position = 10;
  p.jailed = true;
  p.jailTurns = 0;

  s.extra = false;
  s.doubles = 0;
  s.phase = 'end';

  log(s, `${p.name} отправляется в тюрьму.`);
}

function moved(s, p, target, collect = true) {
  if (collect && target < p.position) {
    p.money += 200;
    log(s, `${p.name}: +200 за Старт.`);
  }

  p.position = target;
}

function payQueue(s, list, after = { type: 'end' }) {
  s.payments.push(
    ...list.filter(payment => payment.amount > 0)
  );

  s.afterPayments = after;
  settle(s);
}

function finishAfter(s, after) {
  if (after?.type === 'move') {
    const p = player(s, after.id);

    if (!p.bankrupt) {
      moved(s, p, (p.position + after.steps) % 40);
      land(s, p, after.rngDice);
      return;
    }
  }

  if (after?.type === 'bankAuctions') {
    s.auctionQueue = after.properties.slice();
    s.afterAuctions = after.resume;
    nextBankAuction(s);
    return;
  }

  if (after?.type === 'resumePayments') {
    s.payments = after.payments;
    s.afterPayments = after.after;
    settle(s);
    return;
  }

  s.phase = 'end';

  if (current(s)?.bankrupt) {
    nextTurn(s);
  }
}

function settle(s) {
  while (s.payments.length) {
    const debt = s.payments.shift();
    const payer = player(s, debt.payer);

    if (!payer || payer.bankrupt) {
      continue;
    }

    const recipient = debt.creditor
      ? player(s, debt.creditor)
      : null;

    if (
      debt.creditor &&
      (!recipient || recipient.bankrupt)
    ) {
      continue;
    }

    if (payer.money < debt.amount) {
      s.debt = debt;
      s.phase = 'debt';

      log(
        s,
        `${payer.name}: нужно выплатить ${debt.amount}. ` +
        'Продайте здания, заложите участки ' +
        'или договоритесь об обмене.'
      );

      return;
    }

    payer.money -= debt.amount;

    if (recipient) {
      recipient.money += debt.amount;
    }

    log(
      s,
      `${payer.name} платит ${debt.amount}` +
      (recipient ? ` → ${recipient.name}` : ' в банк') +
      ` (${debt.note}).`
    );
  }

  s.debt = null;

  const after = s.afterPayments;
  s.afterPayments = null;

  finishAfter(s, after);
}

export function rent(
  s,
  index,
  total = s.dice[0] + s.dice[1],
  special = null
) {
  const cell = BOARD[index];
  const property = s.properties[index];

  if (!property.owner || property.mortgaged) {
    return 0;
  }

  if (cell.type === 'street') {
    const multiplier =
      property.houses === 0 &&
      ownsGroup(s, property.owner, index)
        ? 2
        : 1;

    return cell.rents[property.houses] * multiplier;
  }

  if (cell.type === 'rail') {
    const count = s.properties.filter(
      (item, i) =>
        item.owner === property.owner &&
        BOARD[i].type === 'rail'
    ).length;

    return (
      25 *
      2 ** (count - 1) *
      (special === 'rail' ? 2 : 1)
    );
  }

  if (cell.type === 'utility') {
    const count = s.properties.filter(
      (item, i) =>
        item.owner === property.owner &&
        BOARD[i].type === 'utility'
    ).length;

    const multiplier =
      special === 'utility'
        ? 10
        : count === 2
          ? 10
          : 4;

    return total * multiplier;
  }

  return 0;
}

function draw(s, p, kind, rngDice) {
  const deck = s[kind];
  const cards = kind === 'chance' ? CHANCE : CHEST;
  const index = deck.shift();
  const card = cards[index];

  if (!card.jailCard) {
    deck.push(index);
  } else {
    p.jailCards.push(kind);
  }

  s.card = {
    kind,
    text: card.text,
    serial: (s.card?.serial || 0) + 1
  };

  log(
    s,
    `${p.name} — ` +
    `${kind === 'chance' ? 'Шанс' : 'Казна'}: ` +
    card.text
  );

  if (card.jail) {
    jail(s, p);
    return;
  }

  if (card.move !== undefined) {
    moved(s, p, card.move);
    land(s, p, rngDice);
    return;
  }

  if (card.back) {
    p.position = (p.position - card.back + 40) % 40;
    land(s, p, rngDice);
    return;
  }

  if (card.nearest) {
    let position = (p.position + 1) % 40;

    while (BOARD[position].type !== card.nearest) {
      position = (position + 1) % 40;
    }

    moved(s, p, position);
    land(s, p, rngDice, card.nearest);
    return;
  }

  if (card.gain) {
    p.money += card.gain;
  }

  if (card.pay) {
    payQueue(s, [{
      payer: p.id,
      creditor: null,
      amount: card.pay,
      note: 'карточка'
    }]);

    return;
  }

  if (card.repair) {
    const properties = s.properties.filter(
      item => item.owner === p.id
    );

    const amount = properties.reduce(
      (sum, item) =>
        sum + (
          item.houses === 5
            ? card.repair[1]
            : item.houses * card.repair[0]
        ),
      0
    );

    payQueue(s, [{
      payer: p.id,
      creditor: null,
      amount,
      note: 'ремонт'
    }]);

    return;
  }

  if (card.each) {
    const payments = s.players
      .filter(other =>
        other.id !== p.id && !other.bankrupt
      )
      .map(other => ({
        payer: card.each > 0 ? other.id : p.id,
        creditor: card.each > 0 ? p.id : other.id,
        amount: Math.abs(card.each),
        note: 'карточка'
      }));

    payQueue(s, payments);
    return;
  }

  s.phase = 'end';
}

function land(s, p, rngDice, special = null) {
  const index = p.position;
  const cell = BOARD[index];
  const property = s.properties[index];

  log(s, `${p.name} → ${cell.name}.`);

  if (cell.price) {
    if (!property.owner) {
      s.phase = 'buy';
      return;
    }

    if (property.owner !== p.id) {
      const total = special === 'utility'
        ? rngDice
        : s.dice[0] + s.dice[1];

      const amount = rent(s, index, total, special);

      if (
        special === 'utility' &&
        !property.mortgaged
      ) {
        log(
          s,
          `Новый бросок для предприятия: ${rngDice}, ` +
          `аренда ${amount}.`
        );
      }

      payQueue(s, [{
        payer: p.id,
        creditor: property.owner,
        amount,
        note: `аренда: ${cell.name}`
      }]);

      return;
    }
  }

  if (cell.type === 'tax') {
    payQueue(s, [{
      payer: p.id,
      creditor: null,
      amount: cell.amount,
      note: cell.name
    }]);

    return;
  }

  if (cell.type === 'gotojail') {
    jail(s, p);
    return;
  }

  if (
    cell.type === 'chance' ||
    cell.type === 'chest'
  ) {
    draw(s, p, cell.type, rngDice);
    return;
  }

  s.phase = 'end';
}

function nextTurn(s) {
  if (checkWin(s)) {
    return;
  }

  const previous = s.turn;

  do {
    s.turn = (s.turn + 1) % s.players.length;
  } while (current(s).bankrupt);

  if (s.turn <= previous) {
    s.round++;
  }

  s.phase = 'roll';
  s.extra = false;
  s.doubles = 0;
  s.card = null;
  s.trade = null;

  log(s, `Ходит ${current(s).name}.`);
}

function checkWin(s) {
  const alive = s.players.filter(p => !p.bankrupt);

  if (
    alive.length === 1 &&
    s.status === 'playing'
  ) {
    s.status = 'finished';
    s.phase = 'finished';
    s.winner = alive[0].id;
    s.debt = null;
    s.payments = [];
    s.trade = null;
    s.auction = null;

    log(
      s,
      `Победа! ${alive[0].name} — последний игрок в игре.`
    );

    return true;
  }

  return false;
}

function startAuction(s, index) {
  const eligible = s.players
    .filter(p => !p.bankrupt && p.money > 0)
    .map(p => p.id);

  s.auction = {
    index,
    active: eligible,
    high: null,
    bid: 0,
    next: eligible.includes(current(s).id)
      ? current(s).id
      : eligible[0]
  };

  s.phase = 'auction';

  log(s, `Аукцион: ${BOARD[index].name}.`);

  if (!eligible.length) {
    closeAuction(s);
  }
}

function closeAuction(s) {
  const auction = s.auction;

  if (auction.high) {
    const buyer = player(s, auction.high);

    buyer.money -= auction.bid;
    s.properties[auction.index].owner = buyer.id;

    log(
      s,
      `${buyer.name} покупает ` +
      `${BOARD[auction.index].name} за ${auction.bid}.`
    );
  } else {
    log(s, 'Аукцион завершён без покупателя.');
  }

  s.auction = null;

  if (s.auctionQueue.length || s.afterAuctions) {
    nextBankAuction(s);
  } else {
    s.phase = 'end';
  }
}

function nextBankAuction(s) {
  if (s.auctionQueue.length) {
    startAuction(s, s.auctionQueue.shift());
    return;
  }

  const after = s.afterAuctions;
  s.afterAuctions = null;

  finishAfter(s, after);
}

function auctionNext(s, previousId) {
  const auction = s.auction;

  const candidates = auction.active.filter(
    id => id !== auction.high
  );

  if (!candidates.length) {
    closeAuction(s);
    return;
  }

  let index = s.players.findIndex(
    p => p.id === previousId
  );

  do {
    index = (index + 1) % s.players.length;
  } while (
    !candidates.includes(s.players[index].id)
  );

  auction.next = s.players[index].id;
}

function mortgageFee(index) {
  return Math.ceil(BOARD[index].price / 2 * 0.1);
}

function transferFee(s, id, indices) {
  return indices.reduce(
    (sum, index) =>
      sum + (
        s.properties[index].mortgaged
          ? mortgageFee(index)
          : 0
      ),
    0
  );
}

function returnJailCards(s, p) {
  for (const kind of p.jailCards) {
    const cards = kind === 'chance' ? CHANCE : CHEST;

    s[kind].push(
      cards.findIndex(card => card.jailCard)
    );
  }

  p.jailCards = [];
}

function bankrupt(s, p) {
  const debt = s.debt;

  assert(
    debt && debt.payer === p.id,
    'Банкротство доступно при неоплаченном долге'
  );

  const recipient = debt.creditor
    ? player(s, debt.creditor)
    : null;

  const indices = s.properties
    .map((property, index) =>
      property.owner === p.id ? index : -1
    )
    .filter(index => index >= 0);

  // Сначала продаём здания банку.
  for (const index of indices) {
    const property = s.properties[index];

    p.money += (
      property.houses * BOARD[index].build / 2
    ) || 0;

    property.houses = 0;
  }

  if (p.money >= debt.amount) {
    s.debt = null;
    s.payments.unshift(debt);
    settle(s);
    return;
  }

  p.bankrupt = true;
  p.jailed = false;
  s.trade = null;

  log(s, `${p.name} объявлен банкротом.`);

  const resume = {
    type: 'resumePayments',
    payments: s.payments,
    after: s.afterPayments
  };

  s.debt = null;
  s.payments = [];
  s.afterPayments = null;

  if (recipient && !recipient.bankrupt) {
    recipient.money += p.money;

    for (const index of indices) {
      s.properties[index].owner = recipient.id;
    }

    recipient.jailCards.push(...p.jailCards);
    p.jailCards = [];
    p.money = 0;

    if (checkWin(s)) {
      return;
    }

    payQueue(s, [{
      payer: recipient.id,
      creditor: null,
      amount: transferFee(s, recipient.id, indices),
      note: '10% за полученные залоги'
    }], resume);
  } else {
    p.money = 0;
    returnJailCards(s, p);

    for (const index of indices) {
      s.properties[index] = {
        owner: null,
        houses: 0,
        mortgaged: false
      };
    }

    if (checkWin(s)) {
      return;
    }

    finishAfter(s, {
      type: 'bankAuctions',
      properties: indices,
      resume
    });
  }
}

export function applyCommand(
  state,
  cmd,
  id,
  rng = Math.random
) {
  const s = copy(state);

  assert(
    cmd && typeof cmd.type === 'string',
    'Неизвестная команда'
  );

  if (cmd.type === 'START') {
    assert(
      s.status === 'lobby' &&
      s.players.length >= 2,
      'Добавьте от 2 до 10 игроков'
    );

    s.status = 'playing';
    s.phase = 'roll';
    s.chance = shuffle(CHANCE.length, rng);
    s.chest = shuffle(CHEST.length, rng);

    log(
      s,
      `Партия началась. Ходит ${current(s).name}.`
    );

    s.rev++;
    return s;
  }

  assert(
    s.status === 'playing',
    'Нет активной партии'
  );

  assert(!s.paused, 'Игра на паузе');

  const p = player(s, id);

  assert(
    p && !p.bankrupt,
    'Игрок не участвует в партии'
  );

  if (cmd.type === 'TRADE_REPLY') {
    const trade = s.trade;

    assert(
      trade && trade.to === id,
      'Нет предложения для вас'
    );

    if (cmd.accept) {
      validateTrade(s, trade);

      const from = player(s, trade.from);
      const to = player(s, trade.to);

      const feeFrom = transferFee(
        s,
        from.id,
        trade.take
      );

      const feeTo = transferFee(
        s,
        to.id,
        trade.give
      );

      from.money +=
        trade.receive - trade.pay - feeFrom;

      to.money +=
        trade.pay - trade.receive - feeTo;

      for (const index of trade.give) {
        s.properties[index].owner = to.id;
      }

      for (const index of trade.take) {
        s.properties[index].owner = from.id;
      }

      for (let i = 0; i < trade.giveCards; i++) {
        to.jailCards.push(from.jailCards.shift());
      }

      for (let i = 0; i < trade.takeCards; i++) {
        from.jailCards.push(to.jailCards.shift());
      }

      log(
        s,
        `${from.name} и ${to.name} заключили обмен.`
      );
    } else {
      log(s, `${p.name} отклонил обмен.`);
    }

    s.trade = null;
    s.rev++;
    return s;
  }

  assert(
    actor(s)?.id === id,
    'Сейчас действие другого игрока'
  );

  if (cmd.type === 'CANCEL_TRADE') {
    assert(
      s.trade?.from === id,
      'Нет вашего предложения'
    );

    s.trade = null;
    s.rev++;
    return s;
  }

  assert(!s.trade, 'Сначала завершите обмен');

  switch (cmd.type) {
    case 'ROLL': {
      assert(
        s.phase === 'roll',
        'Сейчас нельзя бросать кубики'
      );

      const first = die(rng);
      const second = die(rng);
      const steps = first + second;

      s.dice = [first, second];
      s.card = null;

      log(
        s,
        `${p.name}: выпало ${first} + ${second}.`
      );

      const specialDice = die(rng) + die(rng);

      if (p.jailed) {
        s.extra = false;

        if (first === second) {
          p.jailed = false;
          p.jailTurns = 0;

          moved(s, p, (p.position + steps) % 40);
          land(s, p, specialDice);
        } else {
          p.jailTurns++;

          if (p.jailTurns === 3) {
            payQueue(s, [{
              payer: id,
              creditor: null,
              amount: 50,
              note: 'выход из тюрьмы'
            }], {
              type: 'move',
              id,
              steps,
              rngDice: specialDice
            });

            p.jailed = false;
            p.jailTurns = 0;
          } else {
            s.phase = 'end';
          }
        }

        break;
      }

      s.extra = first === second;
      s.doubles = s.extra ? s.doubles + 1 : 0;

      if (s.doubles === 3) {
        jail(s, p);
        break;
      }

      moved(s, p, (p.position + steps) % 40);
      land(s, p, specialDice);
      break;
    }

    case 'BUY': {
      assert(
        s.phase === 'buy',
        'Нет участка для покупки'
      );

      const index = p.position;
      const cell = BOARD[index];

      assert(
        p.money >= cell.price,
        'Недостаточно денег. Можно заложить ' +
        'собственность или отправить участок на аукцион'
      );

      p.money -= cell.price;
      s.properties[index].owner = id;
      s.phase = 'end';

      log(
        s,
        `${p.name} покупает ${cell.name} за ${cell.price}.`
      );

      break;
    }

    case 'AUCTION': {
      assert(
        s.phase === 'buy',
        'Аукцион сейчас недоступен'
      );

      startAuction(s, p.position);
      break;
    }

    case 'BID': {
      assert(
        s.phase === 'auction',
        'Нет аукциона'
      );

      const amount = Number(cmd.amount);

      assert(
        Number.isSafeInteger(amount) &&
        amount > s.auction.bid &&
        amount <= p.money,
        'Ставка должна быть целой, выше текущей ' +
        'и не больше ваших денег'
      );

      s.auction.bid = amount;
      s.auction.high = id;

      log(s, `${p.name}: ставка ${amount}.`);
      auctionNext(s, id);
      break;
    }

    case 'PASS': {
      assert(
        s.phase === 'auction',
        'Нет аукциона'
      );

      s.auction.active = s.auction.active.filter(
        participantId => participantId !== id
      );

      auctionNext(s, id);
      break;
    }

    case 'END': {
      assert(
        s.phase === 'end' && !s.debt,
        'Сначала завершите действие'
      );

      if (s.extra && !p.jailed) {
        s.phase = 'roll';
        s.extra = false;

        log(
          s,
          `${p.name}: дополнительный бросок за дубль.`
        );
      } else {
        nextTurn(s);
      }

      break;
    }

    case 'JAIL_PAY': {
      assert(
        s.phase === 'roll' && p.jailed,
        'Плата до броска в тюрьме'
      );

      assert(
        p.money >= 50,
        'Недостаточно денег'
      );

      p.money -= 50;
      p.jailed = false;
      p.jailTurns = 0;

      log(s, `${p.name} платит 50 за выход.`);
      break;
    }

    case 'JAIL_CARD': {
      assert(
        s.phase === 'roll' &&
        p.jailed &&
        p.jailCards.length,
        'Нет карточки освобождения'
      );

      const kind = p.jailCards.shift();
      const cards = kind === 'chance' ? CHANCE : CHEST;

      s[kind].push(
        cards.findIndex(card => card.jailCard)
      );

      p.jailed = false;
      p.jailTurns = 0;

      log(
        s,
        `${p.name} использует карточку освобождения.`
      );

      break;
    }

    case 'MORTGAGE':
    case 'REDEEM':
    case 'BUILD':
    case 'SELL': {
      assert(
        ['roll', 'buy', 'end', 'debt'].includes(s.phase),
        'Управление собственностью сейчас недоступно'
      );

      const index = Number(cmd.index);
      const property = s.properties[index];
      const cell = BOARD[index];

      assert(
        property?.owner === id && cell.price,
        'Это не ваша собственность'
      );

      if (cmd.type === 'MORTGAGE') {
        assert(
          !property.mortgaged,
          'Уже в залоге'
        );

        assert(
          cell.type !== 'street' ||
          groupIndices(index).every(
            i => s.properties[i].houses === 0
          ),
          'Сначала продайте все здания этой группы'
        );

        property.mortgaged = true;
        p.money += cell.price / 2;

        log(
          s,
          `${p.name} закладывает ${cell.name}: ` +
          `+${cell.price / 2}.`
        );
      }

      if (cmd.type === 'REDEEM') {
        const cost =
          cell.price / 2 + mortgageFee(index);

        assert(
          property.mortgaged && p.money >= cost,
          'Нужен заложенный участок и деньги на выкуп'
        );

        property.mortgaged = false;
        p.money -= cost;

        log(
          s,
          `${p.name} выкупает ${cell.name} за ${cost}.`
        );
      }

      if (cmd.type === 'BUILD') {
        assert(
          !s.debt,
          'Сначала погасите долг'
        );

        assert(
          ownsGroup(s, id, index) &&
          groupIndices(index).every(
            i => !s.properties[i].mortgaged
          ),
          'Нужна полная группа без залогов'
        );

        assert(
          property.houses < 5 &&
          p.money >= cell.build,
          'Недостаточно денег или уже построен отель'
        );

        const smallest = Math.min(
          ...groupIndices(index).map(
            i => s.properties[i].houses
          )
        );

        assert(
          property.houses === smallest,
          'Стройте равномерно'
        );

        const stock = bankStock(s);

        assert(
          property.houses === 4
            ? stock.hotels > 0
            : stock.houses > 0,
          'В банке закончились здания'
        );

        property.houses++;
        p.money -= cell.build;

        log(
          s,
          `${p.name} строит ` +
          `${property.houses === 5 ? 'отель' : 'дом'}: ` +
          `${cell.name}.`
        );
      }

      if (cmd.type === 'SELL') {
        assert(
          cell.type === 'street' &&
          property.houses > 0,
          'На участке нет зданий'
        );

        const largest = Math.max(
          ...groupIndices(index).map(
            i => s.properties[i].houses
          )
        );

        assert(
          property.houses === largest,
          'Продавайте здания равномерно'
        );

        assert(
          property.houses !== 5 ||
          bankStock(s).houses >= 4,
          'Для обмена отеля нужны 4 дома в банке. ' +
          'Сначала продайте дома на других участках'
        );

        property.houses--;
        p.money += cell.build / 2;

        log(
          s,
          `${p.name} продаёт здание: ${cell.name}.`
        );
      }

      break;
    }

    case 'PAY_DEBT': {
      assert(
        s.debt && p.money >= s.debt.amount,
        'Недостаточно денег для выплаты долга'
      );

      const debt = s.debt;
      s.debt = null;
      s.payments.unshift(debt);

      settle(s);
      break;
    }

    case 'BANKRUPT': {
      bankrupt(s, p);
      break;
    }

    case 'TRADE': {
      assert(
        ['roll', 'buy', 'end', 'debt'].includes(s.phase),
        'Обмен сейчас недоступен'
      );

      const trade = {
        from: id,
        to: cmd.to,
        pay: Number(cmd.pay || 0),
        receive: Number(cmd.receive || 0),
        give: cmd.give || [],
        take: cmd.take || [],
        giveCards: Number(cmd.giveCards || 0),
        takeCards: Number(cmd.takeCards || 0)
      };

      validateTrade(s, trade);
      s.trade = trade;

      log(
        s,
        `${p.name} предлагает обмен игроку ` +
        `${player(s, trade.to).name}.`
      );

      break;
    }

    default:
      throw new Error('Неизвестное действие');
  }

  s.rev++;
  return s;
}

function validateTrade(s, trade) {
  const from = player(s, trade.from);
  const to = player(s, trade.to);

  assert(
    from &&
    to &&
    !from.bankrupt &&
    !to.bankrupt &&
    from.id !== to.id,
    'Выберите другого действующего игрока'
  );

  const amounts = [
    trade.pay,
    trade.receive,
    trade.giveCards,
    trade.takeCards
  ];

  for (const amount of amounts) {
    assert(
      Number.isSafeInteger(amount) && amount >= 0,
      'Суммы и количество карточек должны ' +
      'быть целыми и неотрицательными'
    );
  }

  assert(
    trade.giveCards <= from.jailCards.length &&
    trade.takeCards <= to.jailCards.length,
    'Недостаточно карточек освобождения'
  );

  const transfers = [
    [trade.give, from.id],
    [trade.take, to.id]
  ];

  for (const [list, owner] of transfers) {
    assert(
      Array.isArray(list) &&
      list.length <= 28 &&
      new Set(list).size === list.length,
      'Некорректный список собственности'
    );

    for (const index of list) {
      assert(
        Number.isInteger(index) &&
        s.properties[index]?.owner === owner &&
        BOARD[index].price,
        'Собственность не принадлежит участнику'
      );

      assert(
        BOARD[index].type !== 'street' ||
        groupIndices(index).every(
          i => s.properties[i].houses === 0
        ),
        'Перед обменом продайте здания всей группы'
      );
    }
  }

  assert(
    from.money >=
      trade.pay + transferFee(s, from.id, trade.take) &&
    to.money >=
      trade.receive + transferFee(s, to.id, trade.give),
    'Недостаточно денег на обмен и проценты за залоги'
  );

  assert(
    trade.give.length +
    trade.take.length +
    trade.pay +
    trade.receive +
    trade.giveCards +
    trade.takeCards > 0,
    'Пустой обмен'
  );
}

// Проверка целостности игрового состояния.
export function invariant(s) {
  assert(
    s.players.length <= 10,
    'Больше 10 игроков'
  );

  assert(
    new Set(s.players.map(p => p.id)).size ===
      s.players.length,
    'Повтор ID'
  );

  assert(
    new Set(s.players.map(p => p.token)).size ===
      s.players.length,
    'Повтор фигурки'
  );

  for (const p of s.players) {
    assert(
      Number.isSafeInteger(p.money) && p.money >= 0,
      'Некорректный баланс'
    );

    assert(
      p.position >= 0 && p.position < 40,
      'Позиция вне поля'
    );
  }

  for (let index = 0; index < 40; index++) {
    const property = s.properties[index];

    assert(
      !property.owner || !!player(s, property.owner),
      'Неизвестный владелец'
    );

    assert(
      Number.isInteger(property.houses) &&
      property.houses >= 0 &&
      property.houses <= 5,
      'Некорректные здания'
    );

    if (property.houses) {
      assert(
        ownsGroup(s, property.owner, index),
        'Здание без монополии'
      );

      const group = groupIndices(index);

      assert(
        group.every(i => !s.properties[i].mortgaged),
        'Здание в заложенной группе'
      );

      const buildings = group.map(
        i => s.properties[i].houses
      );

      assert(
        Math.max(...buildings) -
        Math.min(...buildings) <= 1,
        'Неравномерная застройка'
      );
    }
  }

  const stock = bankStock(s);

  assert(
    stock.houses >= 0 && stock.hotels >= 0,
    'Отрицательный запас зданий'
  );

  return true;
}