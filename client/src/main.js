import { io } from 'socket.io-client';
import { createStore } from './store/gameState.js';
import { HostPeerManager } from './webrtc/HostPeer.js';
import { GuestPeerManager } from './webrtc/GuestPeer.js';
import { countSolutions, isBoardSolved } from './sudoku/solver.js'; // 补充引入 isBoardSolved

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

let networkManager = null;
let store = createStore(true, (s) => renderBoard(s)); 
let localPlayerId = 'local';
let isNoteMode = false; // 新增备注模式开关

// 备注模式切换
modeToggle.addEventListener('click', () => {
  isNoteMode = !isNoteMode;
  if (isNoteMode) {
    modeToggle.classList.add('active');
    modeToggle.innerText = '📝 备注模式 (On)';
  } else {
    modeToggle.classList.remove('active');
    modeToggle.innerText = '📝 备注模式 (Off)';
  }
});

for (let i = 0; i < 81; i++) {
  const cell = document.createElement('div');
  cell.className = 'cell';
  cell.dataset.index = i;
  if (i % 9 === 2 || i % 9 === 5) cell.classList.add('border-right-thick');
  if (Math.floor(i / 9) === 2 || Math.floor(i / 9) === 5) cell.classList.add('border-bottom-thick');

  cell.addEventListener('click', () => executeAction({ type: 'UPDATE_FOCUS', payload: { index: i } }));
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

// 键盘事件 (解耦验证)
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  const state = store.getState();
  const focusedIndex = state.focuses[localPlayerId];
  if (focusedIndex === undefined || focusedIndex === null) return;

  const num = parseInt(e.key);
  const isValidNum = num >= 1 && num <= 9;
  const isDelete = e.key === 'Backspace' || e.key === 'Delete';
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

    // 【新增】：如果在游玩阶段，每次填入后检查是否完成
    if (store.getState().phase === 'PLAYING') {
      const currentBoard = store.getState().board;
      if (isBoardSolved(currentBoard)) {
        triggerWinSequence(store.getState());
      }
    }
  }
});

function triggerWinSequence(state) {
  // 计算每个玩家最后拥有的格子数量
  const scores = {};
  Object.keys(state.players).forEach(id => scores[id] = 0);

  state.cellOwners.forEach((ownerId, index) => {
    // 只统计非锁定的格子 (锁定的格子是题目本身)
    if (!state.locked[index] && ownerId && state.players[ownerId]) {
      scores[ownerId]++;
    }
  });

  // 渲染排行榜
  scoreBoard.innerHTML = '';
  Object.keys(scores)
    .sort((a, b) => scores[b] - scores[a]) // 按贡献降序
    .forEach(id => {
      const p = state.players[id];
      scoreBoard.innerHTML += `
        <div class="score-item" style="color: ${p.color}">
          <span>${p.name}</span>
          <span>${scores[id]} 步</span>
        </div>`;
    });

  winModal.style.display = 'flex'; // 弹出面板
}

// 核心修复：点击盘面以外的区域，解除聚焦
document.addEventListener('click', (e) => {
  // 如果点击的目标元素不是单元格（.cell 及其子元素）
  if (!e.target.closest('.cell')) {
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

function renderBoard(state) {
  // 1. 渲染玩家列表
  playerListDiv.innerHTML = '';
  Object.values(state.players).forEach(player => {
    const tag = document.createElement('div');
    tag.className = 'player-tag';
    tag.style.backgroundColor = player.color;
    tag.innerText = player.name;
    playerListDiv.appendChild(tag);
  });

  // 2. 渲染盘面
  const cells = document.querySelectorAll('.cell');
  cells.forEach((cell, index) => {
    let className = 'cell';
    if (index % 9 === 2 || index % 9 === 5) className += ' border-right-thick';
    if (Math.floor(index / 9) === 2 || Math.floor(index / 9) === 5) className += ' border-bottom-thick';
    if (state.locked[index]) className += ' locked';
    cell.className = className;
    
    // 【彩色内边框聚焦效果】
    let boxShadows = [];
    Object.entries(state.focuses).forEach(([playerId, focusedIndex]) => {
      if (focusedIndex === index && state.players[playerId]) {
        const color = state.players[playerId].color;
        // 使用多重 inset shadow 实现边框嵌套感
        boxShadows.push(`inset 0 0 0 4px ${color}`); 
      }
    });
    cell.style.boxShadow = boxShadows.length > 0 ? boxShadows.join(', ') : 'none';

    // 渲染内容（大数字 or 3x3 备注）
    if (state.board[index] !== null) {
      cell.innerHTML = state.board[index];
    } else {
      const notes = state.notes[index];
      if (notes.length > 0) {
        // 构建 3x3 网格
        let gridHtml = '<div class="notes-grid">';
        for (let n = 1; n <= 9; n++) {
          gridHtml += `<div class="note-item">${notes.includes(n) ? n : ''}</div>`;
        }
        gridHtml += '</div>';
        cell.innerHTML = gridHtml;
      } else {
        cell.innerHTML = '';
      }
    }
  });
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
  // 核心修改：留空 io()，它会自动连接到当前网页的域名，实现环境无感！
  const socket = io();
  
  store.dispatch({ type: 'LOCK_PUZZLE' });
  // 房主将自己加入玩家列表并标记 isHost
  store.dispatch({ type: 'ADD_PLAYER', payload: { id: 'local', name: nickname, isHost: true } });
  
  // 传入 nickname 给 HostPeerManager
  networkManager = new HostPeerManager(roomId, socket, store, nickname);
  
  setupPanel.style.display = 'none';
  roomIdInput.disabled = true;
  nicknameInput.disabled = true;
  
  btnCreate.style.display = 'none'; // 隐藏创建按钮
  btnJoin.style.display = 'none';
  btnLeave.style.display = 'inline-block'; // 显示退出按钮
  btnLeave.innerText = '解散房间'; // 房主的退出按钮叫解散
});

btnJoin.addEventListener('click', () => {
  const roomId = roomIdInput.value || 'test-room';
  const nickname = nicknameInput.value || '玩家';
  // 核心修改：留空 io()，它会自动连接到当前网页的域名，实现环境无感！
  const socket = io();
  
  // 校验房间是否存在以及昵称是否重复
  socket.emit('check-room', { roomId, nickname }, (response) => {
    if (!response.exists) {
      alert('❌ 房间不存在或房主已离开，请检查房间号！');
      socket.disconnect();
      return;
    }
    
    if (response.duplicate) {
      alert('❌ 该昵称已被房间内的玩家使用，请换一个昵称！');
      socket.disconnect();
      return;
    }

    // 校验成功，正常加入
    store = createStore(false, (s) => renderBoard(s)); 
    networkManager = new GuestPeerManager(roomId, socket, store, nickname); 
    
    // 修复：由于 check-room 回调已触发，Socket 此时必定已是 connected 状态
    // 直接获取 socket.id 即可，无需也无法再等待 connect 事件
    localPlayerId = socket.id; 
    store.dispatch({ type: 'ADD_PLAYER', payload: { id: localPlayerId, name: nickname, isHost: false } });

    setupPanel.style.display = 'none';
    roomIdInput.disabled = true;
    nicknameInput.disabled = true;

    btnJoin.style.display = 'none';
    btnCreate.style.display = 'none';
    btnLeave.style.display = 'inline-block'; // 显示退出按钮
  });
});

btnLeave.addEventListener('click', () => {
  if (confirm('确定要退出当前房间吗？')) {
    // 最干净、最无残留的退出方式：直接重载页面回到初始状态
    window.location.reload(); 
  }
});


renderBoard(store.getState());