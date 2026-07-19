(function(){
  "use strict";

  /* ============================================================
     SUPABASE CLIENT
  ============================================================ */
  let sb = null;
  let sbReady = false;
  try{
    if(window.supabase && typeof SUPABASE_URL === 'string' && SUPABASE_URL.indexOf('YOUR_PROJECT') === -1){
      sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
      sbReady = true;
    }
  }catch(e){
    console.error('Supabase init failed', e);
  }

  const TABLE = 'durak_games';

  /* ============================================================
     CARD / RULES ENGINE (pure functions, mirrors single-player logic
     so both players' browsers always compute identical results)
  ============================================================ */
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
  function other(who){ return who==='p1' ? 'p2' : 'p1'; }

  function tableRanksInPlay(state){
    const ranks = new Set();
    state.table.forEach(pair=>{
      ranks.add(pair.attack.rank);
      if(pair.defend) ranks.add(pair.defend.rank);
    });
    return ranks;
  }
  function unresolvedCount(state){ return state.table.filter(p=>!p.defend).length; }
  function countDefended(state){ return state.table.filter(p=>p.defend).length; }

  function createInitialState(p1Name, p2Name){
    const deck = shuffle(makeDeck());
    const p1Hand = deck.splice(0,6);
    const p2Hand = deck.splice(0,6);
    const trumpCard = deck[deck.length-1];
    const trumpSuit = trumpCard.suit;

    const p1Trumps = p1Hand.filter(c=>c.suit===trumpSuit);
    const p2Trumps = p2Hand.filter(c=>c.suit===trumpSuit);
    let firstAttacker = 'p1';
    if(p1Trumps.length && p2Trumps.length){
      const p1Min = Math.min(...p1Trumps.map(c=>c.value));
      const p2Min = Math.min(...p2Trumps.map(c=>c.value));
      firstAttacker = p1Min <= p2Min ? 'p1' : 'p2';
    } else if(p2Trumps.length && !p1Trumps.length){
      firstAttacker = 'p2';
    } else if(p1Trumps.length && !p2Trumps.length){
      firstAttacker = 'p1';
    } else {
      firstAttacker = Math.random() < 0.5 ? 'p1' : 'p2';
    }

    return {
      deck, trumpCard, trumpSuit,
      hands: { p1: p1Hand, p2: p2Hand },
      table: [],
      discard: [],
      attacker: firstAttacker,
      defender: other(firstAttacker),
      players: { p1: { name: p1Name || 'Игрок 1' }, p2: { name: p2Name || 'Игрок 2' } },
      status: 'playing',
      winner: null,
      lastAction: null,
      version: 1
    };
  }

  function drawUpTo6(state, order){
    for(const who of order){
      const hand = state.hands[who];
      while(hand.length < 6 && state.deck.length > 0){
        hand.push(state.deck.shift());
      }
    }
  }

  function checkGameOver(state){
    if(state.deck.length > 0) return false;
    const p1Empty = state.hands.p1.length === 0;
    const p2Empty = state.hands.p2.length === 0;
    if(p1Empty && p2Empty){ state.status='finished'; state.winner='draw'; return true; }
    if(p1Empty){ state.status='finished'; state.winner='p1'; return true; }
    if(p2Empty){ state.status='finished'; state.winner='p2'; return true; }
    return false;
  }

  function takeCardsFromTable(state, who){
    const hand = state.hands[who];
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

  function afterRoundResolved(state, nextAttacker){
    const drawOrder = state.attacker === 'p1' ? ['p1','p2'] : ['p2','p1'];
    drawUpTo6(state, drawOrder);
    if(checkGameOver(state)) return;
    state.attacker = nextAttacker;
    state.defender = other(nextAttacker);
  }

  // ---- Actions. Each takes the full state + acting player id ('p1'/'p2')
  // and either mutates+returns state, or throws a user-facing message.

  function actionPlayAttack(state, who, cardId){
    if(state.status !== 'playing') throw 'Игра ещё не началась.';
    if(state.attacker !== who) throw 'Сейчас не ваш ход атаки.';
    const hand = state.hands[who];
    const card = hand.find(c=>c.id===cardId);
    if(!card) throw 'Этой карты нет у вас на руках.';

    const ranks = tableRanksInPlay(state);
    const isFirstMove = state.table.length === 0;
    if(!isFirstMove && !ranks.has(card.rank)) throw 'Можно подкинуть только карту того же достоинства.';
    if(unresolvedCount(state) > 0) throw 'Соперник ещё не отбился.';

    const defenderHand = state.hands[other(who)];
    if(state.table.length >= defenderHand.length + countDefended(state)) throw 'Больше нельзя подкидывать — не хватит карт у соперника.';

    state.hands[who] = hand.filter(c=>c.id!==cardId);
    state.table.push({attack:card, defend:null});
    state.lastAction = { type:'attack', by: who };
    return state;
  }

  function actionPlayDefend(state, who, cardId){
    if(state.status !== 'playing') throw 'Игра ещё не началась.';
    if(state.defender !== who) throw 'Сейчас не ваш ход защиты.';
    const pair = state.table.find(p=>!p.defend);
    if(!pair) throw 'Нечего отбивать.';
    const hand = state.hands[who];
    const card = hand.find(c=>c.id===cardId);
    if(!card) throw 'Этой карты нет у вас на руках.';
    if(!canBeat(pair.attack, card, state.trumpSuit)) throw 'Этой картой нельзя побить.';

    state.hands[who] = hand.filter(c=>c.id!==cardId);
    pair.defend = card;
    state.lastAction = { type:'defend', by: who };
    return state;
  }

  function actionTake(state, who){
    if(state.status !== 'playing') throw 'Игра ещё не началась.';
    if(state.defender !== who) throw 'Сейчас не ваша очередь брать карты.';
    if(state.table.length === 0) throw 'На столе нет карт.';
    const nextAttacker = state.attacker;
    takeCardsFromTable(state, who);
    afterRoundResolved(state, nextAttacker);
    state.lastAction = { type:'take', by: who };
    return state;
  }

  function actionDone(state, who){
    if(state.status !== 'playing') throw 'Игра ещё не началась.';
    if(state.attacker !== who) throw 'Сейчас не ваш ход атаки.';
    if(state.table.length === 0) throw 'Сначала нужно сходить.';
    if(unresolvedCount(state) > 0) throw 'Соперник ещё не отбился.';
    const nextAttacker = state.defender;
    discardTable(state);
    afterRoundResolved(state, nextAttacker);
    state.lastAction = { type:'done', by: who };
    return state;
  }

  /* ============================================================
     ROOM / IDENTITY MANAGEMENT
  ============================================================ */
  function genRoomCode(){
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I to avoid confusion
    let code = '';
    for(let i=0;i<6;i++) code += chars[Math.floor(Math.random()*chars.length)];
    return code;
  }

  function myKey(roomCode){ return 'durak_role_' + roomCode; }
  function saveMyRole(roomCode, role){
    try{ localStorage.setItem(myKey(roomCode), role); }catch(e){}
  }
  function getMyRole(roomCode){
    try{ return localStorage.getItem(myKey(roomCode)); }catch(e){ return null; }
  }

  /* ============================================================
     APP STATE
  ============================================================ */
  let currentRoomCode = null;
  let myRole = null; // 'p1' | 'p2'
  let gameState = null;
  let channel = null;
  let pollTimer = null;
  let prevTableIds = new Set();
  let prevHandIds = new Set();
  let prevOppHandCount = 0;
  let lastSeenVersion = 0;

  const els = {};
  function cacheEls(){
    ['lobbyScreen','waitingScreen','gameScreen','lobbyError','nameInput','createBtn',
     'joinCodeInput','joinBtn','roomCodeDisplay','copyCodeBtn','copyLinkBtn',
     'statusText','trumpChip','opponentLabel','opponentRow','opponentFan',
     'trumpUnderCard','deckPile','deckCount','battlefield','discardPile',
     'youLabel','playerHand','takeBtn','doneBtn','endModal','endIcon','endTitle',
     'endText','playAgainBtn','backToLobbyBtn','rulesBtn','rulesModal','closeRulesBtn',
     'rulesLink2','leaveBtn','connDot','connLabel'
    ].forEach(id => els[id] = document.getElementById(id));
  }

  function showScreen(name){
    els.lobbyScreen.style.display = name==='lobby' ? 'flex' : 'none';
    els.waitingScreen.style.display = name==='waiting' ? 'flex' : 'none';
    els.gameScreen.style.display = name==='game' ? 'flex' : 'none';
    els.leaveBtn.style.display = (name==='waiting' || name==='game') ? 'flex' : 'none';
  }

  let toastTimer = null;
  function toast(msg){
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(()=> el.classList.remove('show'), 2400);
  }
  function setStatus(msg){ els.statusText.textContent = msg; }
  function setConn(state){
    // state: 'live' | 'gone' | 'connecting'
    els.connDot.className = 'conn-dot' + (state==='live' ? ' live' : state==='gone' ? ' gone' : '');
    els.connLabel.textContent = state==='live' ? 'онлайн' : state==='gone' ? 'нет связи' : 'подключение…';
  }

  /* ============================================================
     LOBBY ACTIONS
  ============================================================ */
  function showLobbyError(msg){
    if(!msg){ els.lobbyError.innerHTML=''; return; }
    els.lobbyError.innerHTML = `<div class="error-banner">${msg}</div>`;
  }

  async function createRoom(){
    if(!sbReady){ showLobbyError('Мультиплеер не настроен: откройте config.js и впишите данные вашего проекта Supabase.'); return; }
    const name = (els.nameInput.value || '').trim().slice(0,20) || 'Игрок 1';
    els.createBtn.disabled = true;
    try{
      let code, insertError;
      // Room codes are short, so on the off chance of a collision with an
      // existing room, retry a couple of times with a fresh code.
      for(let attempt=0; attempt<3; attempt++){
        code = genRoomCode();
        const state = createInitialState(name, null);
        state.status = 'waiting'; // waiting for second player before dealing is "official"
        // We still deal cards immediately so the moment player 2 joins the game can start instantly;
        // status flips to 'playing' once p2 has joined and set their name.
        const { error } = await sb.from(TABLE).insert({ code, state });
        insertError = error;
        if(!error) break;
        // 23505 = unique_violation in Postgres; anything else, stop retrying immediately
        if(error.code !== '23505') break;
      }
      if(insertError) throw insertError;
      currentRoomCode = code;
      myRole = 'p1';
      saveMyRole(code, 'p1');
      els.roomCodeDisplay.textContent = code;
      showScreen('waiting');
      subscribeToRoom(code);
    }catch(e){
      console.error(e);
      showLobbyError('Не удалось создать комнату. Проверьте настройки Supabase (config.js) и подключение к интернету.');
    }finally{
      els.createBtn.disabled = false;
    }
  }

  async function joinRoom(codeArg){
    if(!sbReady){ showLobbyError('Мультиплеер не настроен: откройте config.js и впишите данные вашего проекта Supabase.'); return; }
    const code = (codeArg || els.joinCodeInput.value || '').trim().toUpperCase();
    if(!code){ showLobbyError('Введите код комнаты.'); return; }
    const name = (els.nameInput.value || '').trim().slice(0,20) || 'Игрок 2';
    els.joinBtn.disabled = true;
    try{
      const { data, error } = await sb.from(TABLE).select('*').eq('code', code).maybeSingle();
      if(error) throw error;
      if(!data){ showLobbyError('Комната с таким кодом не найдена.'); els.joinBtn.disabled=false; return; }

      const existingRole = getMyRole(code);
      if(existingRole){
        // rejoining a room we were already part of
        currentRoomCode = code;
        myRole = existingRole;
        subscribeToRoom(code);
        return;
      }

      const state = data.state;
      if(state.status === 'playing' && state.players.p2 && state.players.p2.joined){
        showLobbyError('В этой комнате уже два игрока.');
        els.joinBtn.disabled = false;
        return;
      }

      state.players.p2 = { name, joined: true };
      state.status = 'playing';
      state.version = (state.version||1) + 1;
      const { error: updErr } = await sb.from(TABLE).update({ state }).eq('code', code);
      if(updErr) throw updErr;

      currentRoomCode = code;
      myRole = 'p2';
      saveMyRole(code, 'p2');
      subscribeToRoom(code);
    }catch(e){
      console.error(e);
      showLobbyError('Не удалось присоединиться. Проверьте код и подключение к интернету.');
    }finally{
      els.joinBtn.disabled = false;
    }
  }

  function leaveRoom(){
    if(channel){ sb.removeChannel(channel); channel = null; }
    if(pollTimer){ clearInterval(pollTimer); pollTimer = null; }
    currentRoomCode = null;
    myRole = null;
    gameState = null;
    prevTableIds = new Set();
    prevHandIds = new Set();
    prevOppHandCount = 0;
    els.endModal.classList.remove('open');
    showLobbyError('');
    showScreen('lobby');
  }

  /* ============================================================
     SYNC LAYER
  ============================================================ */
  function subscribeToRoom(code){
    setConn('connecting');
    // Initial fetch
    fetchRoomState(code, true);

    if(channel){ sb.removeChannel(channel); }
    channel = sb.channel('room-'+code)
      .on('postgres_changes', { event:'UPDATE', schema:'public', table:TABLE, filter:`code=eq.${code}` }, (payload)=>{
        if(payload.new && payload.new.state){
          applyIncomingState(payload.new.state);
        }
      })
      .subscribe((status)=>{
        if(status === 'SUBSCRIBED'){ setConn('live'); }
        else if(status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED'){ setConn('gone'); }
      });

    // Backup polling in case realtime silently drops (known long-session issue);
    // cheap, infrequent, just keeps things eventually-consistent.
    if(pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(()=> fetchRoomState(code, false), 4000);
  }

  async function fetchRoomState(code, isInitial){
    try{
      const { data, error } = await sb.from(TABLE).select('*').eq('code', code).maybeSingle();
      if(error) throw error;
      if(!data){
        if(isInitial){ showLobbyError('Комната не найдена.'); showScreen('lobby'); }
        return;
      }
      applyIncomingState(data.state);
      setConn('live');
    }catch(e){
      console.error(e);
      setConn('gone');
    }
  }

  function applyIncomingState(state){
    if(!state) return;
    if(lastSeenVersion && state.version && state.version < lastSeenVersion) return; // stale, ignore
    lastSeenVersion = state.version || lastSeenVersion;
    gameState = state;

    if(state.status === 'waiting'){
      showScreen('waiting');
      return;
    }

    showScreen('game');
    renderGame();

    if(state.status === 'finished'){
      showEndModal(state.winner);
    }
  }

  // Reads current DB row, applies `mutator(state, myRole)`, writes it back.
  // Retries once on version conflict (someone else wrote in between).
  async function performAction(mutator){
    if(!sb || !currentRoomCode) return;
    for(let attempt=0; attempt<2; attempt++){
      try{
        const { data, error } = await sb.from(TABLE).select('state').eq('code', currentRoomCode).maybeSingle();
        if(error) throw error;
        if(!data){ toast('Комната больше не существует.'); return; }
        const state = data.state;
        try{
          mutator(state, myRole);
        }catch(userMsg){
          if(typeof userMsg === 'string'){ toast(userMsg); return; }
          throw userMsg;
        }
        state.version = (state.version||1) + 1;
        const { error: updErr } = await sb.from(TABLE).update({ state }).eq('code', currentRoomCode);
        if(updErr) throw updErr;
        applyIncomingState(state); // optimistic local apply; realtime echo will be a no-op due to version check
        return;
      }catch(e){
        console.error('performAction failed, attempt', attempt, e);
        if(attempt === 1){ toast('Не удалось отправить ход — проверьте соединение.'); }
      }
    }
  }

  /* ============================================================
     RENDERING (mirrors single-player renderer, adapted for p1/p2)
  ============================================================ */
  function cardHTML(card, extraClass, clickable){
    const color = SUIT_COLOR[card.suit];
    const isTrump = gameState && card.suit === gameState.trumpSuit;
    const cls = ['card', color];
    if(isTrump) cls.push('trump-suit');
    if(extraClass) cls.push(extraClass);
    return `<div class="${cls.join(' ')}" data-id="${card.id}" ${clickable? 'role="button" tabindex="0"':''}>
      <div class="corner">${card.rank}<br>${card.suit}</div>
      <div class="pip">${card.suit}</div>
      <div class="corner bottom">${card.rank}<br>${card.suit}</div>
    </div>`;
  }

  function renderGame(){
    if(!gameState) return;
    const state = gameState;
    const me = myRole;
    const opp = other(me);

    els.youLabel.textContent = (state.players[me] && state.players[me].name) || 'Вы';
    els.opponentLabel.textContent = (state.players[opp] && state.players[opp].name) || 'Соперник';

    // status text
    if(state.attacker === me && unresolvedCount(state) === 0){
      setStatus(state.table.length===0 ? 'Ваш ход — атакуйте.' : 'Подкиньте карту или нажмите «Бито».');
    } else if(state.defender === me && unresolvedCount(state) > 0){
      setStatus('Отбейтесь или возьмите карты.');
    } else if(state.attacker === me && unresolvedCount(state) > 0){
      setStatus('Соперник защищается…');
    } else if(state.defender === me && unresolvedCount(state) === 0 && state.table.length>0){
      setStatus('Вы отбились. Соперник решает, подкинуть ли ещё…');
    } else {
      setStatus('Ход соперника…');
    }

    // trump chip
    const tc = state.trumpCard;
    els.trumpChip.innerHTML = `Козырь: <span class="mini-card ${SUIT_COLOR[tc.suit]}">${tc.rank}${tc.suit}</span>`;

    // opponent fan
    const oppHand = state.hands[opp];
    const oppGrew = oppHand.length > prevOppHandCount;
    els.opponentFan.innerHTML = oppHand.map((c,i)=>{
      const isNew = oppGrew && i >= prevOppHandCount;
      return `<div class="card-back${isNew?' deal-in':''}"></div>`;
    }).join('');
    prevOppHandCount = oppHand.length;

    // deck / trump card
    const remaining = state.deck.length;
    if(remaining <= 0){
      els.trumpUnderCard.style.display = 'none';
      els.deckPile.style.display = 'none';
    } else {
      els.trumpUnderCard.style.display = 'flex';
      els.trumpUnderCard.className = 'trump-under ' + SUIT_COLOR[state.trumpCard.suit];
      els.trumpUnderCard.textContent = state.trumpCard.rank + state.trumpCard.suit;
      if(remaining > 1){
        els.deckPile.style.display = 'block';
        els.deckCount.textContent = remaining + ' карт';
      } else {
        els.deckPile.style.display = 'none';
      }
    }

    // battlefield
    if(state.table.length === 0){
      els.battlefield.innerHTML = `<div style="opacity:.35; font-size:.85rem;">стол пуст</div>`;
    } else {
      els.battlefield.innerHTML = state.table.map(pair=>{
        const attackIsNew = !prevTableIds.has('A:'+pair.attack.id);
        const attackClass = 'attack-card' + (attackIsNew ? ' just-played' : '');
        let html = `<div class="pair-slot">`;
        html += cardHTML(pair.attack, attackClass, false);
        if(pair.defend){
          const defendIsNew = !prevTableIds.has('D:'+pair.defend.id);
          const defendClass = 'defend-card' + (defendIsNew ? ' just-played' : '');
          html += cardHTML(pair.defend, defendClass, false);
        }
        html += `</div>`;
        return html;
      }).join('');
    }
    prevTableIds = new Set();
    state.table.forEach(pair=>{
      prevTableIds.add('A:'+pair.attack.id);
      if(pair.defend) prevTableIds.add('D:'+pair.defend.id);
    });

    els.discardPile.textContent = state.discard.length>0 ? `бито\n${state.discard.length}` : 'бито';

    // my hand
    const myHand = state.hands[me].slice().sort((a,b)=>{
      if(a.suit!==b.suit){
        const aT = a.suit===state.trumpSuit?1:0;
        const bT = b.suit===state.trumpSuit?1:0;
        if(aT!==bT) return aT-bT;
        return a.suit.localeCompare(b.suit);
      }
      return a.value-b.value;
    });

    const isMeDefending = state.defender===me && unresolvedCount(state)>0;
    const isMeAttacking = state.attacker===me;
    const pendingPair = isMeDefending ? state.table.find(p=>!p.defend) : null;

    els.playerHand.innerHTML = myHand.map(card=>{
      let disabled = false;
      if(state.status !== 'playing') disabled = true;
      else if(isMeAttacking){
        const ranks = tableRanksInPlay(state);
        const isFirstMove = state.table.length===0;
        if(!isFirstMove && !ranks.has(card.rank)) disabled = true;
        if(unresolvedCount(state)>0) disabled = true;
        const oppLen = state.hands[opp].length;
        if(state.table.length >= oppLen + countDefended(state)) disabled = true;
      } else if(isMeDefending && pendingPair){
        if(!canBeat(pendingPair.attack, card, state.trumpSuit)) disabled = true;
      } else {
        disabled = true;
      }
      const isNewCard = !prevHandIds.has(card.id);
      let cls = disabled ? 'disabled' : '';
      if(isNewCard) cls = (cls + ' deal-in').trim();
      return cardHTML(card, cls, true);
    }).join('');
    prevHandIds = new Set(myHand.map(c=>c.id));

    els.playerHand.querySelectorAll('.card').forEach(el=>{
      if(el.classList.contains('disabled')) return;
      el.addEventListener('click', ()=>{
        const id = el.getAttribute('data-id');
        onMyCardClick(id);
      });
    });

    const canTake = state.defender===me && state.table.length>0 && unresolvedCount(state)>0 && state.status==='playing';
    els.takeBtn.disabled = !canTake;
    const canDone = state.attacker===me && state.table.length>0 && unresolvedCount(state)===0 && state.status==='playing';
    els.doneBtn.disabled = !canDone;
  }

  function onMyCardClick(cardId){
    if(!gameState) return;
    const state = gameState;
    if(state.attacker === myRole){
      performAction((s, who)=> actionPlayAttack(s, who, cardId));
    } else if(state.defender === myRole){
      performAction((s, who)=> actionPlayDefend(s, who, cardId));
    }
  }

  function showEndModal(winner){
    const modal = els.endModal;
    if(winner === 'draw'){
      els.endIcon.textContent = '♦';
      els.endTitle.textContent = 'Ничья!';
      els.endText.textContent = 'Обе руки опустели одновременно. Никто не остался в дураках.';
    } else if(winner === myRole){
      els.endIcon.textContent = '♠';
      els.endTitle.textContent = 'Победа!';
      els.endText.textContent = 'Вы избавились от всех карт первым.';
    } else {
      els.endIcon.textContent = '♣';
      els.endTitle.textContent = 'Вы проиграли';
      els.endText.textContent = 'На этот раз в дураках остались вы.';
    }
    modal.classList.add('open');
  }

  async function playAgain(){
    if(!currentRoomCode || !gameState) return;
    els.endModal.classList.remove('open');
    try{
      const p1Name = gameState.players.p1.name;
      const p2Name = gameState.players.p2.name;
      const fresh = createInitialState(p1Name, p2Name);
      fresh.players.p1.joined = true;
      fresh.players.p2.joined = true;
      const { data } = await sb.from(TABLE).select('state').eq('code', currentRoomCode).maybeSingle();
      fresh.version = ((data && data.state && data.state.version) || 1) + 1;
      prevTableIds = new Set();
      prevHandIds = new Set();
      prevOppHandCount = 0;
      await sb.from(TABLE).update({ state: fresh }).eq('code', currentRoomCode);
    }catch(e){
      console.error(e);
      toast('Не удалось начать новую игру.');
    }
  }

  /* ============================================================
     EVENTS
  ============================================================ */
  function wireEvents(){
    els.createBtn.addEventListener('click', createRoom);
    els.joinBtn.addEventListener('click', ()=>joinRoom());
    els.joinCodeInput.addEventListener('keydown', (e)=>{ if(e.key==='Enter') joinRoom(); });
    els.joinCodeInput.addEventListener('input', ()=>{
      els.joinCodeInput.value = els.joinCodeInput.value.toUpperCase();
    });

    els.copyCodeBtn.addEventListener('click', ()=>{
      if(!currentRoomCode) return;
      navigator.clipboard && navigator.clipboard.writeText(currentRoomCode).then(()=> toast('Код скопирован!'));
    });
    els.copyLinkBtn.addEventListener('click', ()=>{
      if(!currentRoomCode) return;
      const url = location.origin + location.pathname + '?room=' + currentRoomCode;
      navigator.clipboard && navigator.clipboard.writeText(url).then(()=> toast('Ссылка скопирована!'));
    });

    els.takeBtn.addEventListener('click', ()=> performAction((s,who)=> actionTake(s,who)));
    els.doneBtn.addEventListener('click', ()=> performAction((s,who)=> actionDone(s,who)));

    els.leaveBtn.addEventListener('click', leaveRoom);
    els.playAgainBtn.addEventListener('click', playAgain);
    els.backToLobbyBtn.addEventListener('click', ()=>{ els.endModal.classList.remove('open'); leaveRoom(); });

    function openRules(){ els.rulesModal.classList.add('open'); }
    function closeRules(){ els.rulesModal.classList.remove('open'); }
    els.rulesBtn.addEventListener('click', openRules);
    els.rulesLink2.addEventListener('click', (e)=>{ e.preventDefault(); openRules(); });
    els.closeRulesBtn.addEventListener('click', closeRules);
    els.rulesModal.addEventListener('click', (e)=>{ if(e.target.id==='rulesModal') closeRules(); });
  }

  /* ============================================================
     INIT
  ============================================================ */
  function init(){
    cacheEls();
    wireEvents();
    setConn('connecting');
    if(!sbReady){
      setConn('gone');
      showLobbyError('Мультиплеер не настроен. Откройте <code>config.js</code> и впишите URL и ключ вашего проекта Supabase (см. README).');
    } else {
      setConn('gone'); // will flip to live once actually subscribed to a room
    }
    showScreen('lobby');

    // auto-fill join code from ?room= link
    const params = new URLSearchParams(location.search);
    const roomParam = params.get('room');
    if(roomParam){
      els.joinCodeInput.value = roomParam.toUpperCase();
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
