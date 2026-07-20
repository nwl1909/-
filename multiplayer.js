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
     RULES ENGINE — loaded from engine.js as a browser global (window.DurakEngine)
  ============================================================ */
  const Engine = window.DurakEngine;
  const { SUIT_COLOR, canBeat, nextSeat, isActiveSeat, activeSeats,
    createInitialState, unresolvedCount, countDefended, tableRanksInPlay,
    eligibleThrowInSeats, throwInCapacity,
    actionPlayAttack, actionPlayDefend, actionTake, actionPass } = Engine;

  /* ============================================================
     ROOM / IDENTITY HELPERS
  ============================================================ */
  function genRoomCode(){
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I to avoid confusion
    let code = '';
    for(let i=0;i<6;i++) code += chars[Math.floor(Math.random()*chars.length)];
    return code;
  }
  function genSeatId(){
    return 'p' + Math.random().toString(36).slice(2,10);
  }

  function myKey(roomCode){ return 'durak_seat_' + roomCode; }
  function saveMySeat(roomCode, seatId){
    try{ localStorage.setItem(myKey(roomCode), seatId); }catch(e){}
  }
  function getMySeat(roomCode){
    try{ return localStorage.getItem(myKey(roomCode)); }catch(e){ return null; }
  }

  const NAME_STORAGE_KEY = 'durak_player_name';
  function saveMyName(name){
    try{ localStorage.setItem(NAME_STORAGE_KEY, name); }catch(e){}
  }
  function loadMyName(){
    try{ return localStorage.getItem(NAME_STORAGE_KEY) || ''; }catch(e){ return ''; }
  }

  /* ============================================================
     APP STATE
  ============================================================ */
  let currentRoomCode = null;
  let mySeatId = null;
  let gameState = null; // the full DB row's `state` JSON
  let channel = null;
  let pollTimer = null;
  let prevTableIds = new Set();
  let prevHandIds = new Set();
  let prevOppHandCounts = {}; // seatId -> last known hand length, for deal-in animation
  let lastSeenVersion = 0;

  const els = {};
  function cacheEls(){
    ['lobbyScreen','waitingScreen','gameScreen','lobbyError','nameInput','maxPlayersSelect','createBtn',
     'joinCodeInput','joinBtn','roomCodeDisplay','copyCodeBtn','copyLinkBtn','seatList','startGameBtn','waitingHostHint',
     'statusText','trumpChip','opponentsStrip',
     'trumpUnderCard','deckPile','deckCount','battlefield','discardPile',
     'youLabel','playerHand','takeBtn','passBtn','doneBtn','endModal','endIcon','endTitle',
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
    els.connDot.className = 'conn-dot' + (state==='live' ? ' live' : state==='gone' ? ' gone' : '');
    els.connLabel.textContent = state==='live' ? 'онлайн' : state==='gone' ? 'нет связи' : 'подключение…';
  }

  /* ============================================================
     ERROR REPORTING HELPERS
  ============================================================ */
  function showLobbyError(msg){
    if(!msg){ els.lobbyError.innerHTML=''; return; }
    els.lobbyError.innerHTML = `<div class="error-banner">${msg}</div>`;
  }
  function describeError(e){
    if(!e) return '';
    const parts = [];
    if(e.message) parts.push(e.message);
    if(e.details) parts.push(e.details);
    if(e.hint) parts.push('Подсказка: ' + e.hint);
    if(e.code) parts.push('код: ' + e.code);
    if(parts.length === 0){
      try{ parts.push(String(e)); }catch(_){ parts.push('неизвестная ошибка'); }
    }
    return parts.join(' — ');
  }
  function friendlyHintForError(e){
    const msg = (e && e.message) || '';
    if(/relation .* does not exist/i.test(msg) || (e && e.code === '42P01')){
      return 'Похоже, таблица durak_games ещё не создана — выполните supabase_setup.sql в SQL Editor вашего проекта.';
    }
    if(/JWT|api key|apikey/i.test(msg)){
      return 'Похоже, неверный SUPABASE_ANON_KEY в config.js — проверьте, что скопирован ключ anon/public целиком.';
    }
    if(/fetch|network|Failed to fetch/i.test(msg)){
      return 'Не получилось достучаться до Supabase — проверьте SUPABASE_URL в config.js (без лишних /rest/v1 на конце) и подключение к интернету.';
    }
    if(/row-level security|permission denied/i.test(msg) || (e && e.code === '42501')){
      return 'База данных заблокировала запрос политикой безопасности — заново выполните supabase_setup.sql целиком (там создаются нужные политики).';
    }
    return '';
  }
  function showLobbyErrorWithDetail(mainMsg, e){
    const hint = friendlyHintForError(e);
    const detail = describeError(e);
    const detailHtml = detail ? `<div style="margin-top:6px; font-size:.78rem; opacity:.75; font-family:monospace; word-break:break-word;">${detail}</div>` : '';
    const hintHtml = hint ? `<div style="margin-top:6px;">${hint}</div>` : '';
    els.lobbyError.innerHTML = `<div class="error-banner">${mainMsg}${hintHtml}${detailHtml}</div>`;
  }

  /* ============================================================
     LOBBY (PRE-GAME ROOM) ACTIONS
  ============================================================ */
  function makeLobbyState(hostSeatId, hostName, maxPlayers){
    return {
      phase: 'lobby',
      maxPlayers,
      hostSeatId,
      seatOrder: [hostSeatId],
      players: { [hostSeatId]: { name: hostName } },
      version: 1
    };
  }

  async function createRoom(){
    if(!sbReady){ showLobbyError('Мультиплеер не настроен: откройте config.js и впишите данные вашего проекта Supabase.'); return; }
    const name = (els.nameInput.value || '').trim().slice(0,20) || 'Игрок 1';
    saveMyName(name);
    const maxPlayers = parseInt(els.maxPlayersSelect.value, 10) || 4;
    els.createBtn.disabled = true;
    try{
      let code, insertError;
      const hostSeatId = genSeatId();
      for(let attempt=0; attempt<3; attempt++){
        code = genRoomCode();
        const state = makeLobbyState(hostSeatId, name, maxPlayers);
        const { error } = await sb.from(TABLE).insert({ code, state });
        insertError = error;
        if(!error) break;
        if(error.code !== '23505') break; // only retry on room-code collision
      }
      if(insertError) throw insertError;
      currentRoomCode = code;
      mySeatId = hostSeatId;
      saveMySeat(code, hostSeatId);
      els.roomCodeDisplay.textContent = code;
      showScreen('waiting');
      subscribeToRoom(code);
    }catch(e){
      console.error(e);
      showLobbyErrorWithDetail('Не удалось создать комнату.', e);
    }finally{
      els.createBtn.disabled = false;
    }
  }

  async function joinRoom(codeArg){
    if(!sbReady){ showLobbyError('Мультиплеер не настроен: откройте config.js и впишите данные вашего проекта Supabase.'); return; }
    const code = (codeArg || els.joinCodeInput.value || '').trim().toUpperCase();
    if(!code){ showLobbyError('Введите код комнаты.'); return; }
    const name = (els.nameInput.value || '').trim().slice(0,20) || 'Игрок';
    saveMyName(name);
    els.joinBtn.disabled = true;
    try{
      const { data, error } = await sb.from(TABLE).select('*').eq('code', code).maybeSingle();
      if(error) throw error;
      if(!data){ showLobbyError('Комната с таким кодом не найдена.'); els.joinBtn.disabled=false; return; }

      const existingSeat = getMySeat(code);
      if(existingSeat && data.state.seatOrder && data.state.seatOrder.includes(existingSeat)){
        currentRoomCode = code;
        mySeatId = existingSeat;
        subscribeToRoom(code);
        return;
      }

      const state = data.state;
      if(state.phase !== 'lobby'){
        showLobbyError('Игра в этой комнате уже началась.');
        els.joinBtn.disabled = false;
        return;
      }
      if(state.seatOrder.length >= state.maxPlayers){
        showLobbyError('Комната уже заполнена.');
        els.joinBtn.disabled = false;
        return;
      }

      const seatId = genSeatId();
      state.seatOrder.push(seatId);
      state.players[seatId] = { name };
      state.version = (state.version||1) + 1;
      const { error: updErr } = await sb.from(TABLE).update({ state }).eq('code', code);
      if(updErr) throw updErr;

      currentRoomCode = code;
      mySeatId = seatId;
      saveMySeat(code, seatId);
      subscribeToRoom(code);
    }catch(e){
      console.error(e);
      showLobbyErrorWithDetail('Не удалось присоединиться.', e);
    }finally{
      els.joinBtn.disabled = false;
    }
  }

  async function startGame(){
    if(!gameState || gameState.phase !== 'lobby') return;
    if(gameState.hostSeatId !== mySeatId){ toast('Только хост может начать игру.'); return; }
    if(gameState.seatOrder.length < 2){ toast('Нужно минимум 2 игрока.'); return; }
    els.startGameBtn.disabled = true;
    try{
      const players = gameState.seatOrder.map(seatId=>({ seatId, name: gameState.players[seatId].name }));
      const fresh = createInitialState(players);
      fresh.phase = 'playing';
      fresh.maxPlayers = gameState.maxPlayers;
      fresh.hostSeatId = gameState.hostSeatId;
      fresh.version = (gameState.version||1) + 1;
      const { error } = await sb.from(TABLE).update({ state: fresh }).eq('code', currentRoomCode);
      if(error) throw error;
    }catch(e){
      console.error(e);
      toast('Не удалось начать игру: ' + describeError(e));
    }finally{
      els.startGameBtn.disabled = false;
    }
  }

  function leaveRoom(){
    if(channel){ sb.removeChannel(channel); channel = null; }
    if(pollTimer){ clearInterval(pollTimer); pollTimer = null; }
    currentRoomCode = null;
    mySeatId = null;
    gameState = null;
    prevTableIds = new Set();
    prevHandIds = new Set();
    prevOppHandCounts = {};
    els.endModal.classList.remove('open');
    showLobbyError('');
    showScreen('lobby');
  }

  /* ============================================================
     SYNC LAYER
  ============================================================ */
  function subscribeToRoom(code){
    setConn('connecting');
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

    if(state.phase === 'lobby'){
      renderWaitingRoom();
      showScreen('waiting');
      return;
    }

    showScreen('game');
    renderGame();

    if(state.phase === 'finished'){
      showEndModal(state.winner);
    }
  }

  // Reads current DB row, applies `mutator(state, mySeatId)`, writes it back.
  async function performAction(mutator){
    if(!sb || !currentRoomCode) return;
    for(let attempt=0; attempt<2; attempt++){
      try{
        const { data, error } = await sb.from(TABLE).select('state').eq('code', currentRoomCode).maybeSingle();
        if(error) throw error;
        if(!data){ toast('Комната больше не существует.'); return; }
        const state = data.state;
        try{
          mutator(state, mySeatId);
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
     WAITING ROOM RENDERING
  ============================================================ */
  function renderWaitingRoom(){
    const state = gameState;
    els.roomCodeDisplay.textContent = currentRoomCode || '------';

    const rows = [];
    for(let i=0; i<state.maxPlayers; i++){
      const seatId = state.seatOrder[i];
      if(seatId){
        const p = state.players[seatId];
        const isHost = seatId === state.hostSeatId;
        const isMe = seatId === mySeatId;
        rows.push(`<div class="seat-row">
          <span class="seat-name">${escapeHtml(p.name)} ${isMe ? '<span class="you-tag">(вы)</span>' : ''}</span>
          ${isHost ? '<span class="host-tag">Хост</span>' : ''}
        </div>`);
      } else {
        rows.push(`<div class="seat-row empty">Ждём игрока…</div>`);
      }
    }
    els.seatList.innerHTML = rows.join('');

    const amHost = state.hostSeatId === mySeatId;
    const enoughPlayers = state.seatOrder.length >= 2;
    if(amHost){
      els.startGameBtn.style.display = 'block';
      els.startGameBtn.disabled = !enoughPlayers;
      els.waitingHostHint.textContent = enoughPlayers
        ? 'Можно начинать, как только будете готовы — необязательно дожидаться всех мест.'
        : 'Нужно как минимум 2 игрока, чтобы начать.';
    } else {
      els.startGameBtn.style.display = 'none';
      els.waitingHostHint.textContent = 'Ждём, пока хост комнаты начнёт игру…';
    }
  }

  function escapeHtml(s){
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  /* ============================================================
     GAME RENDERING
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
    const me = mySeatId;
    const opponents = state.seatOrder.filter(s=>s!==me);

    els.youLabel.textContent = (state.players[me] && state.players[me].name) || 'Вы';

    const amEliminated = state.eliminated && state.eliminated.includes(me);
    if(state.phase === 'finished'){
      setStatus('Игра окончена.');
    } else if(amEliminated){
      setStatus('Вы выбыли — у вас закончились карты. Наблюдайте за игрой.');
    } else if(state.attacker === me && unresolvedCount(state) === 0){
      setStatus(state.table.length===0 ? 'Ваш ход — атакуйте.' : 'Подкиньте карту или нажмите «Бито», когда закончите.');
    } else if(state.defender === me && unresolvedCount(state) > 0){
      setStatus('Отбейтесь или возьмите карты.');
    } else if(state.defender === me && unresolvedCount(state) === 0 && state.table.length>0){
      setStatus('Вы отбились. Остальные решают, подкинуть ли ещё…');
    } else if(state.table.length>0 && eligibleThrowInSeats(state).includes(me)){
      setStatus('Можете подкинуть карту того же достоинства, либо нажмите «Пас».');
    } else {
      const attackerName = (state.players[state.attacker]||{}).name || '?';
      const defenderName = (state.players[state.defender]||{}).name || '?';
      setStatus(`Ходят: ${attackerName} → ${defenderName}`);
    }

    const tc = state.trumpCard;
    els.trumpChip.innerHTML = `Козырь: <span class="mini-card ${SUIT_COLOR[tc.suit]}">${tc.rank}${tc.suit}</span>`;

    // opponents strip
    els.opponentsStrip.innerHTML = opponents.map(seatId=>{
      const p = state.players[seatId] || { name: '?' };
      const hand = state.hands[seatId] || [];
      const isElim = state.eliminated && state.eliminated.includes(seatId);
      const isAttacker = state.attacker === seatId;
      const isDefender = state.defender === seatId;
      const prevCount = prevOppHandCounts[seatId] || 0;
      const grew = hand.length > prevCount;

      const cls = ['opponent-pod'];
      if(isElim) cls.push('eliminated');
      if(isAttacker) cls.push('is-attacker');
      if(isDefender) cls.push('is-defender');

      const badge = isAttacker ? '<span class="role-badge">атака</span>' : isDefender ? '<span class="role-badge defend">защита</span>' : '';
      const fanHtml = hand.map((c,i)=>{
        const isNew = grew && i >= prevCount;
        return `<div class="card-back${isNew?' deal-in':''}"></div>`;
      }).join('');

      return `<div class="${cls.join(' ')}" data-seat="${seatId}">
        <div class="pod-name">${escapeHtml(p.name)} ${badge}</div>
        <div class="pod-fan">${isElim ? '' : fanHtml}</div>
        <div class="pod-count">${isElim ? 'выбыл' : hand.length + ' карт'}</div>
      </div>`;
    }).join('');
    opponents.forEach(seatId=>{ prevOppHandCounts[seatId] = (state.hands[seatId]||[]).length; });

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
    const myHand = amEliminated ? [] : (state.hands[me]||[]).slice().sort((a,b)=>{
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
    const isFirstMove = state.table.length===0;
    // Throwing in is only a thing once the round has been opened by the
    // attacker's first card — before that, only the attacker can act at all.
    const canThrowInNow = !isFirstMove && !isMeDefending && me!==state.defender && unresolvedCount(state)===0
      && eligibleThrowInSeats(state).includes(me) && !amEliminated;
    const pendingPair = isMeDefending ? state.table.find(p=>!p.defend) : null;

    els.playerHand.innerHTML = myHand.map(card=>{
      let disabled = false;
      if(state.phase !== 'playing') disabled = true;
      else if(isMeDefending && pendingPair){
        if(!canBeat(pendingPair.attack, card, state.trumpSuit)) disabled = true;
      } else if(isMeAttacking && isFirstMove && unresolvedCount(state)===0 && state.defender!==me){
        // opening the round — any card allowed, disabled stays false
      } else if(canThrowInNow){
        const ranks = tableRanksInPlay(state);
        if(!ranks.has(card.rank)) disabled = true;
        const capacity = throwInCapacity(state);
        if(state.table.length >= capacity) disabled = true;
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

    // action buttons
    const canTake = state.defender===me && state.table.length>0 && unresolvedCount(state)>0 && state.phase==='playing';
    els.takeBtn.disabled = !canTake;

    const canPass = canThrowInNow;
    els.passBtn.disabled = !canPass;
    // "Бито" lets the attacker force-close the round once the defender has
    // cleared all current cards, without waiting for everyone else to pass.
    const canDone = isMeAttacking && state.table.length>0 && unresolvedCount(state)===0
      && eligibleThrowInSeats(state).includes(me) && state.phase==='playing';
    els.doneBtn.disabled = !canDone;
  }

  function onMyCardClick(cardId){
    if(!gameState) return;
    const state = gameState;
    if(state.defender === mySeatId && unresolvedCount(state) > 0){
      performAction((s, seatId)=> actionPlayDefend(s, seatId, cardId));
    } else {
      performAction((s, seatId)=> actionPlayAttack(s, seatId, cardId));
    }
  }

  function showEndModal(winner){
    const modal = els.endModal;
    const state = gameState;
    if(winner === 'draw'){
      els.endIcon.textContent = '♦';
      els.endTitle.textContent = 'Ничья!';
      els.endText.textContent = 'Все руки опустели одновременно. Никто не остался в дураках.';
    } else if(winner === mySeatId){
      els.endIcon.textContent = '♠';
      els.endTitle.textContent = 'Победа!';
      els.endText.textContent = 'Вы избавились от всех карт первым.';
    } else {
      const name = (state.players[winner]||{}).name || 'Другой игрок';
      els.endIcon.textContent = '♣';
      els.endTitle.textContent = 'Игра окончена';
      els.endText.textContent = `Победил${winner ? ' ' + name : ''}. Кто-то остался в дураках — проверьте, не вы ли.`;
    }
    modal.classList.add('open');
  }

  async function playAgain(){
    if(!currentRoomCode || !gameState) return;
    els.endModal.classList.remove('open');
    try{
      // Go back to the lobby phase with the same seats, so everyone can
      // start a fresh game (or someone can leave first).
      const state = gameState;
      const lobbyState = {
        phase: 'lobby',
        maxPlayers: state.maxPlayers,
        hostSeatId: state.hostSeatId,
        seatOrder: state.seatOrder.slice(),
        players: JSON.parse(JSON.stringify(state.players)),
        version: (state.version||1) + 1
      };
      prevTableIds = new Set();
      prevHandIds = new Set();
      prevOppHandCounts = {};
      await sb.from(TABLE).update({ state: lobbyState }).eq('code', currentRoomCode);
    }catch(e){
      console.error(e);
      toast('Не удалось вернуться в лобби.');
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

    els.nameInput.addEventListener('input', ()=>{
      saveMyName(els.nameInput.value.slice(0,20));
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

    els.startGameBtn.addEventListener('click', startGame);

    els.takeBtn.addEventListener('click', ()=> performAction((s,seatId)=> actionTake(s,seatId)));
    els.passBtn.addEventListener('click', ()=> performAction((s,seatId)=> actionPass(s,seatId)));
    els.doneBtn.addEventListener('click', ()=> performAction((s,seatId)=> actionPass(s,seatId)));

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
  async function runPreflightCheck(){
    if(!sbReady) return;
    try{
      const { error } = await sb.from(TABLE).select('code').limit(1);
      if(error) throw error;
    }catch(e){
      console.error('Supabase preflight check failed:', e);
      showLobbyErrorWithDetail(friendlyHintForError(e) || 'Не удалось подключиться к базе данных.', e);
    }
  }

  function init(){
    cacheEls();
    wireEvents();
    setConn('connecting');
    if(!sbReady){
      setConn('gone');
      showLobbyError('Мультиплеер не настроен. Откройте <code>config.js</code> и впишите URL и ключ вашего проекта Supabase (см. README).');
    } else {
      setConn('gone');
    }
    showScreen('lobby');

    const savedName = loadMyName();
    if(savedName) els.nameInput.value = savedName;

    if(sbReady) runPreflightCheck();

    const params = new URLSearchParams(location.search);
    const roomParam = params.get('room');
    if(roomParam){
      els.joinCodeInput.value = roomParam.toUpperCase();
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
