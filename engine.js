// ============================================================
// Дурак Online — движок правил для 2-6 игроков ("по кругу")
// Pure functions only — без DOM, без сети. Общий источник истины
// для всех клиентов: каждый браузер выполняет те же действия над
// тем же state и должен получить идентичный результат.
// ============================================================
"use strict";

const SUITS = ["♠","♥","♦","♣"];
const SUIT_COLOR = { "♠":"black", "♣":"black", "♥":"red", "♦":"red" };
const RANKS = ["6","7","8","9","10","J","Q","K","A"];
const RANK_VALUE = {}; RANKS.forEach((r,i)=> RANK_VALUE[r] = i+6);

function makeDeck(){
  const deck = [];
  for(const s of SUITS){
    for(const r of RANKS){
      deck.push({ suit:s, rank:r, value:RANK_VALUE[r], id: s+r });
    }
  }
  return deck;
}
function shuffle(arr){
  for(let i=arr.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [arr[i],arr[j]] = [arr[j],arr[i]];
  }
  return arr;
}
function canBeat(attackCard, defendCard, trumpSuit){
  if(defendCard.suit === attackCard.suit) return defendCard.value > attackCard.value;
  if(defendCard.suit === trumpSuit && attackCard.suit !== trumpSuit) return true;
  return false;
}

/* ============================================================
   SEAT HELPERS
   Seats are identified by small integer ids: 0, 1, 2, ... (as
   strings, e.g. 'seat0') in the order players joined. state.seatOrder
   holds the *play order* (clockwise turn order), which is fixed at
   game start and doesn't change even as players drop out (we just
   skip empty/finished seats when walking the circle).
============================================================ */
function nextSeat(state, fromSeatId){
  // Walks state.seatOrder starting after fromSeatId, returns the next
  // seat that is still "in the game" (has cards, or deck isn't empty yet —
  // i.e. hasn't been eliminated). Returns null if no such seat exists
  // (shouldn't normally happen while status is 'playing').
  const order = state.seatOrder;
  const idx = order.indexOf(fromSeatId);
  if(idx === -1) return null;
  for(let step=1; step<=order.length; step++){
    const candidate = order[(idx+step) % order.length];
    if(isActiveSeat(state, candidate)) return candidate;
  }
  return null;
}
function isActiveSeat(state, seatId){
  return !state.eliminated.includes(seatId);
}
function activeSeats(state){
  return state.seatOrder.filter(s=>isActiveSeat(state, s));
}

/* ============================================================
   GAME SETUP
============================================================ */
function createInitialState(players){
  // players: array of { seatId, name } in join order, length 2-6
  const deck = shuffle(makeDeck());

  // Reserve the trump card BEFORE dealing hands. In real play the dealer
  // flips the next card after dealing to reveal trump, then slides it back
  // under the deck — but with 6 players * 6 cards = 36 the deck would have
  // nothing left over to reveal. Pulling it out first and dealing from the
  // remainder avoids that edge case for every player count from 2 to 6,
  // and still leaves the trump card sitting visibly "under" the draw pile.
  const trumpCard = deck.pop();
  const trumpSuit = trumpCard.suit;

  const hands = {};
  const seatOrder = players.map(p=>p.seatId);

  seatOrder.forEach(seatId=>{ hands[seatId] = deck.splice(0,6); });

  // Put the trump card back at the very end of the draw pile — since cards
  // are drawn from the front (see drawUpToSix using deck.shift()), placing
  // it at the end means it's the last card anyone will ever draw, matching
  // the "trump card sits face-up under the deck" convention at the table.
  deck.push(trumpCard);

  // first attacker: lowest trump card across all hands; if nobody has
  // a trump, pick randomly.
  let firstAttacker = null;
  let bestValue = Infinity;
  seatOrder.forEach(seatId=>{
    const trumps = hands[seatId].filter(c=>c.suit===trumpSuit);
    if(trumps.length){
      const minV = Math.min(...trumps.map(c=>c.value));
      if(minV < bestValue){ bestValue = minV; firstAttacker = seatId; }
    }
  });
  if(firstAttacker === null){
    firstAttacker = seatOrder[Math.floor(Math.random()*seatOrder.length)];
  }

  const playersMap = {};
  players.forEach(p=>{ playersMap[p.seatId] = { name: p.name, joined: true }; });

  const state = {
    deck, trumpCard, trumpSuit,
    hands,
    seatOrder,
    players: playersMap,
    eliminated: [],
    table: [], // {attack, defend|null}
    discard: [],
    attacker: firstAttacker,
    defender: nextSeat({ seatOrder, eliminated: [] }, firstAttacker),
    // tracks which active seats still have a chance to throw in this round;
    // reset every time the table is cleared (discard or take). The attacker
    // and defender don't throw in via this queue (attacker plays via the
    // normal "attack" action any time it's legal; defender never throws in).
    passedThrowIn: [],
    status: 'playing',
    winner: null, // seatId of the single remaining player, or 'draw', or null
    lastAction: null,
    version: 1
  };
  return state;
}

function unresolvedCount(state){ return state.table.filter(p=>!p.defend).length; }
function countDefended(state){ return state.table.filter(p=>p.defend).length; }
function tableRanksInPlay(state){
  const ranks = new Set();
  state.table.forEach(pair=>{
    ranks.add(pair.attack.rank);
    if(pair.defend) ranks.add(pair.defend.rank);
  });
  return ranks;
}

// Seats allowed to throw in right now: every active seat except the
// defender, that hasn't already explicitly passed this round, and that
// hasn't been eliminated. (The attacker is included — after the first
// attack card, the original attacker can still throw in more, same as
// everyone else in the throw-in queue, capped by the shared card limit.)
function eligibleThrowInSeats(state){
  return activeSeats(state).filter(s=> s !== state.defender && !state.passedThrowIn.includes(s));
}

function throwInCapacity(state){
  // Max total attack cards allowed this round = defender's hand size
  // at the moment the round started, but simplest correct rule used
  // widely: cards on table (unresolved+resolved) can't exceed defender's
  // current hand length + number already defended (mirrors 2-player logic).
  const defenderHand = state.hands[state.defender] || [];
  return defenderHand.length + countDefended(state);
}

/* ============================================================
   ROUND TRANSITIONS
============================================================ */
function drawUpToSix(state, order){
  for(const seatId of order){
    if(!isActiveSeat(state, seatId)) continue;
    const hand = state.hands[seatId];
    while(hand.length < 6 && state.deck.length > 0){
      hand.push(state.deck.shift());
    }
  }
}

function checkEliminationsAndGameOver(state){
  // A seat is eliminated once the deck is empty and their hand is empty.
  if(state.deck.length === 0){
    state.seatOrder.forEach(seatId=>{
      if(!isActiveSeat(state, seatId)) return;
      if(state.hands[seatId].length === 0){
        state.eliminated.push(seatId);
      }
    });
  }
  const remaining = activeSeats(state);
  if(remaining.length <= 1){
    state.status = 'finished';
    state.winner = remaining.length === 1 ? remaining[0] : 'draw';
    return true;
  }
  return false;
}

function takeCardsFromTable(state, seatId){
  const hand = state.hands[seatId];
  state.table.forEach(pair=>{
    hand.push(pair.attack);
    if(pair.defend) hand.push(pair.defend);
  });
  state.table = [];
}
function discardTable(state){
  state.table.forEach(pair=>{
    state.discard.push(pair.attack);
    if(pair.defend) state.discard.push(pair.defend);
  });
  state.table = [];
}

// Called once a round is fully over (either discarded or taken).
// nextAttackerSeat: the seat that will attack next.
function beginNextRound(state, nextAttackerSeat){
  // Draw order: current attacker first, then around the circle, defender last —
  // standard rule so the attacker/throw-in players refill before the defender.
  const order = [];
  const startIdx = state.seatOrder.indexOf(state.attacker);
  for(let step=0; step<state.seatOrder.length; step++){
    order.push(state.seatOrder[(startIdx+step) % state.seatOrder.length]);
  }
  drawUpToSix(state, order);

  if(checkEliminationsAndGameOver(state)) return;

  // nextAttackerSeat might have just been eliminated (emptied hand with
  // empty deck) — if so, walk forward to the next still-active seat.
  let attacker = nextAttackerSeat;
  if(!isActiveSeat(state, attacker)){
    attacker = nextSeat(state, attacker) || attacker;
  }
  const defender = nextSeat(state, attacker);

  state.attacker = attacker;
  state.defender = defender;
  state.passedThrowIn = [];
}

/* ============================================================
   ACTIONS
   Each action takes (state, seatId, ...) and either mutates+returns
   state, or throws a short user-facing Russian string.
============================================================ */

function actionPlayAttack(state, seatId, cardId){
  if(state.status !== 'playing') throw 'Игра ещё не началась.';
  if(!isActiveSeat(state, seatId)) throw 'Вы уже выбыли из игры.';
  if(seatId === state.defender) throw 'Защищающийся не может подкидывать карты.';

  const isFirstMove = state.table.length === 0;
  if(isFirstMove && seatId !== state.attacker) throw 'Первым ходит атакующий игрок.';
  if(!isFirstMove){
    if(!eligibleThrowInSeats(state).includes(seatId)) throw 'Сейчас не ваша очередь подкидывать, либо вы уже пропустили этот раунд.';
  }

  const hand = state.hands[seatId];
  const card = hand.find(c=>c.id===cardId);
  if(!card) throw 'Этой карты нет у вас на руках.';

  const ranks = tableRanksInPlay(state);
  if(!isFirstMove && !ranks.has(card.rank)) throw 'Можно подкинуть только карту того же достоинства, что уже на столе.';
  if(unresolvedCount(state) > 0) throw 'Защищающийся ещё не отбился от текущих карт.';

  const capacity = throwInCapacity(state);
  if(state.table.length >= capacity) throw 'Больше нельзя подкидывать — у защищающегося не хватит карт.';

  state.hands[seatId] = hand.filter(c=>c.id!==cardId);
  state.table.push({attack:card, defend:null});
  // A fresh attack card re-opens the throw-in window for everyone
  // (their earlier "pass" no longer applies to this new card).
  state.passedThrowIn = [];
  state.lastAction = { type:'attack', by: seatId };
  return state;
}

function actionPlayDefend(state, seatId, cardId){
  if(state.status !== 'playing') throw 'Игра ещё не началась.';
  if(state.defender !== seatId) throw 'Сейчас не ваш ход защиты.';
  const pair = state.table.find(p=>!p.defend);
  if(!pair) throw 'Нечего отбивать.';
  const hand = state.hands[seatId];
  const card = hand.find(c=>c.id===cardId);
  if(!card) throw 'Этой карты нет у вас на руках.';
  if(!canBeat(pair.attack, card, state.trumpSuit)) throw 'Этой картой нельзя побить.';

  state.hands[seatId] = hand.filter(c=>c.id!==cardId);
  pair.defend = card;
  state.lastAction = { type:'defend', by: seatId };
  return state;
}

// Defender gives up and takes all cards on the table.
function actionTake(state, seatId){
  if(state.status !== 'playing') throw 'Игра ещё не началась.';
  if(state.defender !== seatId) throw 'Сейчас не ваша очередь брать карты.';
  if(state.table.length === 0) throw 'На столе нет карт.';

  const takenBy = seatId;
  takeCardsFromTable(state, takenBy);
  // attack continues to the seat after the defender who just took (skip them)
  const nextAttacker = nextSeat(state, takenBy);
  beginNextRound(state, nextAttacker);
  state.lastAction = { type:'take', by: seatId };
  return state;
}

// A seat other than defender declares "I have nothing more to throw in".
// Once every eligible seat has passed (or there's only the attacker left
// and they pass too), the round resolves as "бито" if the table has no
// unresolved cards.
function actionPass(state, seatId){
  if(state.status !== 'playing') throw 'Игра ещё не началась.';
  if(seatId === state.defender) throw 'Защищающийся не пасует — он либо отбивается, либо берёт карты.';
  if(state.table.length === 0) throw 'Раунд ещё не начался.';
  if(!eligibleThrowInSeats(state).includes(seatId)) throw 'Вы уже пропустили этот раунд.';
  if(unresolvedCount(state) > 0) throw 'Дождитесь, пока защищающийся отобьётся или возьмёт карты.';

  if(!state.passedThrowIn.includes(seatId)) state.passedThrowIn.push(seatId);
  state.lastAction = { type:'pass', by: seatId };

  maybeResolveRound(state);
  return state;
}

// Internal: if every eligible throw-in seat has passed and there's
// nothing left unresolved, the round auto-resolves to discard.
function maybeResolveRound(state){
  if(unresolvedCount(state) > 0) return;
  if(state.table.length === 0) return;
  const stillEligible = eligibleThrowInSeats(state);
  if(stillEligible.length === 0){
    const nextAttacker = state.defender; // successful defense -> defender attacks next
    discardTable(state);
    beginNextRound(state, nextAttacker);
    state.lastAction = { type:'auto-done', by: null };
  }
}

const DurakEngine = {
  SUITS, SUIT_COLOR, RANKS, RANK_VALUE,
  makeDeck, shuffle, canBeat,
  nextSeat, isActiveSeat, activeSeats,
  createInitialState,
  unresolvedCount, countDefended, tableRanksInPlay,
  eligibleThrowInSeats, throwInCapacity,
  drawUpToSix, checkEliminationsAndGameOver,
  takeCardsFromTable, discardTable, beginNextRound,
  actionPlayAttack, actionPlayDefend, actionTake, actionPass,
  maybeResolveRound
};

// Works as a Node module (`require('./engine.js')`) for testing, and as a
// plain browser <script> (exposes `window.DurakEngine`) for multiplayer.js.
if(typeof module !== 'undefined' && module.exports){
  module.exports = DurakEngine;
}
if(typeof window !== 'undefined'){
  window.DurakEngine = DurakEngine;
}

