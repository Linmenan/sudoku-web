/*
 * @FilePath: /client/src/main.js
 */
import { io } from 'socket.io-client';
import { createStore } from './store/gameState.js';
import { HostPeerManager } from './webrtc/HostPeer.js';
import { GuestPeerManager } from './webrtc/GuestPeer.js';
import { countSolutions, isBoardSolved } from './sudoku/solver.js';

const boardDiv = document.getElementById('board');
const roomIdInput = document.getElementById('roomIdInput');
const btnVerify = document.getElementById('btnVerify');
const btnCreate = document.getElementById('btnCreate');
const btnJoin = document.getElementById('btnJoin');
const btnClear = document.getElementById('btnClear');
const statusText = document.getElementById('statusText');
const setupPanel = document.getElementById('setupPanel');
const playerListDiv = document.getElementById('playerList');
const modeToggle = document.getElementById('modeToggle');
const nicknameInput = document.getElementById('nicknameInput');
const btnLeave = document.getElementById('btnLeave');
const winModal = document.getElementById('winModal');
const scoreBoard = document.getElementById('scoreBoard');
const serverUrlInput = document.getElementById('serverUrlInput');

// 智能检测局域网 IP
if (window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
  if (window.location.hostname.match(/^\d+\.\d+\.\d+\.\d+$/)) {
    if (serverUrlInput) serverUrlInput.value = `http://${window.location.hostname}:3000`;
  }
}

const virtualKeyboard = document.getElementById('virtualKeyboard');
const vkModeToggle = document.getElementById('vkModeToggle');

let networkManager = null;
let store = createStore(true, (s) => renderBoard(s)); 
let localPlayerId = 'local';
let isNoteMode = false;

function updateModeToggleUI() {
  const modeText = isNoteMode ? '📝 备注模式 (On)' : '📝 备注模式 (Off)';
  const vkModeText = isNoteMode ? '📝 备注 (On)' : '📝 备注 (Off)';

  modeToggle.innerText = modeText;
  if (isNoteMode) modeToggle.classList.add('active');
  else modeToggle.classList.remove('active');

  if (vkModeToggle) {
    vkModeToggle.innerText = vkModeText;
    if (isNoteMode) vkModeToggle.classList.add('active');
    else vkModeToggle.classList.remove('active');
  }
}

modeToggle.addEventListener('click', () => {
  isNoteMode = !isNoteMode;
  updateModeToggleUI();
});

if (vkModeToggle) {
  vkModeToggle.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation(); 
    isNoteMode = !isNoteMode;
    updateModeToggleUI();
  });
}

for (let i = 0; i < 81; i++) {
  const cell = document.createElement('div');
  cell.className = 'cell';
  cell.dataset.index = i;
  if (i % 9 === 2 || i % 9 === 5) cell.classList.add('border-right-thick');
  if (Math.floor(i / 9) === 2 || Math.floor(i / 9) === 5) cell.classList.add('border-bottom-thick');

  cell.addEventListener('click', (e) => {
    e.stopPropagation(); // 核心修复：阻止冒泡，防止触发 document 的全局失焦事件
    executeAction({ type: 'UPDATE_FOCUS', payload: { index: i } });
  });
  boardDiv.appendChild(cell);
}

function executeAction(action) {
  if (networkManager instanceof HostPeerManager) {
    const state = store.dispatch(action, localPlayerId);
    networkManager.broadcast({ type: 'SYNC', payload: state });
  } else if (networkManager instanceof GuestPeerManager) {
    networkManager.sendAction(action);
  } else {
    store.dispatch(action, localPlayerId);
  }
}

function handleInput(key) {
  const state = store.getState();
  const focusedIndex = state.focuses[localPlayerId];
  if (focusedIndex === undefined || focusedIndex === null) return;

  const num = parseInt(key);
  const isValidNum = num >= 1 && num <= 9;
  const isDelete = key === 'Backspace' || key === 'Delete' || key === 'Del';
  
  if (!isValidNum && !isDelete) return;

  if (isNoteMode && isValidNum) {
    executeAction({ type: 'TOGGLE_NOTE', payload: { index: focusedIndex, value: num } });
  } else {
    const valToFill = isDelete ? null : num;
    const oldVal = state.board[focusedIndex];
    executeAction({ type: 'FILL_NUM', payload: { index: focusedIndex, value: valToFill } });
    
    if (state.phase === 'SETUP' && oldVal !== valToFill) {
      statusText.innerText = '';
      btnCreate.disabled = true;
    }

    if (store.getState().phase === 'PLAYING') {
      const currentBoard = store.getState().board;
      if (isBoardSolved(currentBoard)) {
        triggerWinSequence(store.getState());
      }
    }
  }
}

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  const state = store.getState();
  const focusedIndex = state.focuses[localPlayerId];

  if (focusedIndex !== undefined && focusedIndex !== null) {
    let row = Math.floor(focusedIndex / 9);
    let col = focusedIndex % 9;
    let moved = false;

    if (e.key === 'ArrowUp') { row = (row - 1 + 9) % 9; moved = true; }
    else if (e.key === 'ArrowDown') { row = (row + 1) % 9; moved = true; }
    else if (e.key === 'ArrowLeft') { col = (col - 1 + 9) % 9; moved = true; }
    else if (e.key === 'ArrowRight') { col = (col + 1) % 9; moved = true; }

    if (moved) {
      e.preventDefault();
      const newIndex = row * 9 + col;
      executeAction({ type: 'UPDATE_FOCUS', payload: { index: newIndex } });
      return;
    }
  }
  handleInput(e.key);
});

document.querySelectorAll('.vk-key:not(#vkModeToggle)').forEach(btn => {
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation(); 
    handleInput(btn.dataset.key);
  });
});

function triggerWinSequence(state) {
  const scores = {};
  Object.keys(state.players).forEach(id => scores[id] = 0);

  state.cellOwners.forEach((ownerId, index) => {
    if (!state.locked[index] && ownerId && state.players[ownerId]) {
      scores[ownerId]++;
    }
  });

  scoreBoard.innerHTML = '';
  Object.keys(scores)
    .sort((a, b) => scores[b] - scores[a])
    .forEach(id => {
      const p = state.players[id];
      scoreBoard.innerHTML += `
        <div class="score-item" style="color: ${p.color}">
          <span>${p.name}</span>
          <span>${scores[id]} 步</span>
        </div>`;
    });

  winModal.style.display = 'flex';
}

document.addEventListener('click', (e) => {
  // 双保险：如果点击的目标元素在冒泡期间被重新渲染清除了（成为孤儿节点），则直接忽略
  if (!document.contains(e.target)) return;

  if (!e.target.closest('.cell') && !e.target.closest('#virtualKeyboard') && !e.target.closest('.mode-toggle')) {
    executeAction({ type: 'UPDATE_FOCUS', payload: { index: null } });
  }
});

btnClear.addEventListener('click', () => {
  if (confirm('🚨 确定要清空当前盘面的所有数字吗？')) {
    executeAction({ type: 'CLEAR_BOARD' });
    statusText.innerText = '盘面已清空';
    statusText.style.color = 'black';
    btnCreate.disabled = true;
  }
});

const getRowColGrid = (index) => {
  const row = Math.floor(index / 9);
  const col = index % 9;
  const grid = Math.floor(row / 3) * 3 + Math.floor(col / 3);
  return { row, col, grid };
};

function renderBoard(state) {
  playerListDiv.innerHTML = '';
  Object.values(state.players).forEach(player => {
    const tag = document.createElement('div');
    tag.className = 'player-tag';
    tag.style.backgroundColor = player.color;
    tag.innerText = player.name;
    playerListDiv.appendChild(tag);
  });

  const conflicts = Array(81).fill().map(() => new Set());
  for (let i = 0; i < 81; i++) {
    if (state.board[i] !== null) {
      const val = state.board[i];
      const target = getRowColGrid(i);
      for (let j = 0; j < 81; j++) {
        const current = getRowColGrid(j);
        if (current.row === target.row || current.col === target.col || current.grid === target.grid) {
          conflicts[j].add(val);
        }
      }
    }
  }

  const cells = document.querySelectorAll('.cell');
  cells.forEach((cell, index) => {
    let className = 'cell';
    if (index % 9 === 2 || index % 9 === 5) className += ' border-right-thick';
    if (Math.floor(index / 9) === 2 || Math.floor(index / 9) === 5) className += ' border-bottom-thick';
    if (state.locked[index]) className += ' locked';
    cell.className = className;
    
    let boxShadows = [];
    Object.entries(state.focuses).forEach(([playerId, focusedIndex]) => {
      if (focusedIndex === index && state.players[playerId]) {
        const color = state.players[playerId].color;
        boxShadows.push(`inset 0 0 0 4px ${color}`); 
      }
    });
    cell.style.boxShadow = boxShadows.length > 0 ? boxShadows.join(', ') : 'none';

    if (state.board[index] !== null) {
      cell.innerHTML = state.board[index];
    } else {
      const visibleNotes = state.notes[index].filter(n => !conflicts[index].has(n));
      if (visibleNotes.length > 0) {
        let gridHtml = '<div class="notes-grid">';
        for (let n = 1; n <= 9; n++) {
          gridHtml += `<div class="note-item">${visibleNotes.includes(n) ? n : ''}</div>`;
        }
        gridHtml += '</div>';
        cell.innerHTML = gridHtml;
      } else {
        cell.innerHTML = '';
      }
    }
  });

  if (virtualKeyboard) {
    const hasFocus = state.focuses[localPlayerId] !== null && state.focuses[localPlayerId] !== undefined;
    virtualKeyboard.style.display = hasFocus ? 'grid' : 'none';
  }
}

function createSocketConnection() {
  const serverUrl = serverUrlInput ? serverUrlInput.value.trim() : 'http://localhost:3000';
  console.log(`[Socket] 尝试连接信令服务器: ${serverUrl}`);
  const socket = io(serverUrl, {
    reconnectionAttempts: 3,
    timeout: 5000,
  });

  socket.on('connect', () => {
    console.log('[Socket] ✅ 成功连接到信令服务器！Socket ID:', socket.id);
  });

  socket.on('connect_error', (err) => {
    console.error('[Socket] ❌ 连接信令服务器失败:', err.message);
    alert('❌ 无法连接到服务器，请检查信令服务器是否已启动，或地址是否正确。详细信息请查看 VConsole。');
  });

  socket.on('disconnect', (reason) => {
    console.warn('[Socket] ⚠️ 与信令服务器断开连接，原因:', reason);
  });

  return socket;
}

btnVerify.addEventListener('click', () => {
  statusText.style.color = 'blue';
  statusText.innerText = '验证中...';
  setTimeout(() => {
    const solutionCount = countSolutions(store.getState().board);
    if (solutionCount === 0) {
      statusText.style.color = 'red'; statusText.innerText = '❌ 无解（或者本身有冲突），请修改。';
    } else if (solutionCount > 1) {
      statusText.style.color = '#f57c00'; statusText.innerText = '⚠️ 多解（线索不够），请添加更多数字。';
    } else {
      statusText.style.color = 'green'; statusText.innerText = '✅ 解唯一！可以创建房间了。';
      btnCreate.disabled = false;
    }
  }, 10); 
});

btnCreate.addEventListener('click', () => {
  const roomId = roomIdInput.value || 'test-room';
  const nickname = nicknameInput.value || '房主';
  
  console.log(`[Host] 正在创建房间... 房间号: ${roomId}, 昵称: ${nickname}`);
  const socket = createSocketConnection();
  
  store.dispatch({ type: 'LOCK_PUZZLE' }); 
  store.dispatch({ type: 'ADD_PLAYER', payload: { id: 'local', name: nickname, isHost: true } });
  networkManager = new HostPeerManager(roomId, socket, store, nickname);
  
  setupPanel.style.display = 'none';
  roomIdInput.disabled = true;
  nicknameInput.disabled = true;
  btnCreate.style.display = 'none';
  btnJoin.style.display = 'none';
  btnLeave.style.display = 'inline-block';
  btnLeave.innerText = '解散房间';
});

btnJoin.addEventListener('click', () => {
  const roomId = roomIdInput.value || 'test-room';
  const nickname = nicknameInput.value || '玩家';
  
  console.log(`[Guest] 尝试加入房间... 房间号: ${roomId}, 昵称: ${nickname}`);
  const socket = createSocketConnection();
  
  socket.on('connect', () => {
    console.log(`[Guest] 开始校验房间状态...`);
    socket.emit('check-room', { roomId, nickname }, (response) => {
      console.log(`[Guest] 收到的房间校验结果:`, response);
      
      if (!response.exists) {
        console.error(`[Guest] ❌ 房间校验失败: 房间不存在！`);
        alert('❌ 房间不存在或房主已离开，请检查房间号！');
        socket.disconnect();
        return;
      }
      if (response.duplicate) {
        console.error(`[Guest] ❌ 房间校验失败: 昵称重复！`);
        alert('❌ 该昵称已被房间内的玩家使用，请换一个昵称！');
        socket.disconnect();
        return;
      }

      console.log(`[Guest] ✅ 房间校验通过，正在初始化 P2P 核心模块...`);
      store = createStore(false, (s) => renderBoard(s)); 
      networkManager = new GuestPeerManager(roomId, socket, store, nickname); 
      localPlayerId = socket.id; 
      store.dispatch({ type: 'ADD_PLAYER', payload: { id: localPlayerId, name: nickname, isHost: false } });

      setupPanel.style.display = 'none';
      roomIdInput.disabled = true;
      nicknameInput.disabled = true;
      btnJoin.style.display = 'none';
      btnCreate.style.display = 'none';
      btnLeave.style.display = 'inline-block';
    });
  });
});

btnLeave.addEventListener('click', () => {
  if (confirm('确定要退出当前房间吗？')) {
    window.location.reload(); 
  }
});

renderBoard(store.getState());