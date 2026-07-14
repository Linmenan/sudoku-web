import { io } from 'socket.io-client';
import { createStore } from './store/gameState.js';
import { HostPeerManager } from './webrtc/HostPeer.js';
import { GuestPeerManager } from './webrtc/GuestPeer.js';
import { countSolutions, isBoardSolved, generateSudoku } from './sudoku/solver.js';

const boardDiv = document.getElementById('board');
const roomIdInput = document.getElementById('roomIdInput');
const btnVerify = document.getElementById('btnVerify');
const btnJoin = document.getElementById('btnJoin');
const btnClear = document.getElementById('btnClear');
const statusText = document.getElementById('statusText');
const setupPanel = document.getElementById('setupPanel');
const playerListDiv = document.getElementById('playerList');
const mainTitle = document.getElementById('mainTitle');
const nicknameArea = document.getElementById('nicknameArea');
const modeToggle = document.getElementById('modeToggle');
const nicknameInput = document.getElementById('nicknameInput');
const btnLeave = document.getElementById('btnLeave');
const winModal = document.getElementById('winModal');
const scoreBoard = document.getElementById('scoreBoard');

const virtualKeyboard = document.getElementById('virtualKeyboard');
const vkModeToggle = document.getElementById('vkModeToggle');
const isPrivateCheck = document.getElementById('isPrivateCheck');
const passwordInput = document.getElementById('passwordInput');
const btnGenerate = document.getElementById('btnGenerate');
const difficultySelect = document.getElementById('difficultySelect');

const chatPanel = document.getElementById('chatPanel');
const chatMessagesDiv = document.getElementById('chatMessages');
const chatInput = document.getElementById('chatInput');
const btnSendChat = document.getElementById('btnSendChat');
const joinPasswordInput = document.getElementById('joinPasswordInput');
const roomListBody = document.getElementById('roomListBody');

// 持久化业务身份 UUID 凭证
const getPersistentPlayerId = () => {
  let id = localStorage.getItem('sudoku_player_id');
  if (!id) {
    id = 'player_' + Math.random().toString(36).substring(2, 10);
    localStorage.setItem('sudoku_player_id', id);
  }
  return id;
};

let networkManager = null;
let store = createStore((s) => renderBoard(s)); 
let localPlayerId = getPersistentPlayerId();
let isNoteMode = false;
let selectedRoom = null; // 当前选中的活跃房间数据

// 记录当前房间凭证，用于切屏或后台掉线时智能静默重连
let currentRoomId = '';
let currentNickname = '';
let currentPassword = null;

store.dispatch({ type: 'ADD_PLAYER', payload: { id: localPlayerId, name: '我', isHost: false } });

// 全局唯一的网络信令通道
function createSocketConnection() {
  let serverUrl = 'http://localhost:3000';
  const host = window.location.hostname;
  if ((host !== 'localhost' && host !== '127.0.0.1') || window.location.port !== '5173') {
    const isPublicNetwork = host.includes('.') && !host.match(/^\d+\.\d+\.\d+\.\d+$/) && host !== 'localhost' && host !== '127.0.0.1';
    const protocol = isPublicNetwork ? 'https:' : window.location.protocol;
    serverUrl = `${protocol}//${window.location.host}`;
  }
  console.log(`[Socket] 初始化全局连线中心: ${serverUrl}`);
  return io(serverUrl, { reconnectionAttempts: 5, timeout: 5000, transports: ['websocket'] });
}

const socket = createSocketConnection();

// 监听全服活跃房间刷新
socket.on('rooms-updated', (rooms) => {
  renderActiveRoomsTable(rooms);
});

// 新增：被动房主接管（解决老房主网络异常断开、死机、拔网线，没发交接信令就蒸发的问题）
socket.on('player-disconnected', ({ socketId, playerId }) => {
  const state = store.getState();
  const droppedPlayer = state.players[playerId];
  // 探测到掉线玩家是房主，且我自己目前是普通玩家
  if (droppedPlayer && droppedPlayer.name.includes('⭐') && networkManager instanceof GuestPeerManager) {
    if (confirm(`🚨 监测到房主 [${droppedPlayer.name}] 意外掉线！\n网络已失去主节点，对局随时可能中断。\n\n是否由您挺身而出接管房间，成为新房主？`)) {
      console.log(`[Migration] 👑 玩家主动接管断线房间，变身新房主！`);
      store.dispatch({ type: 'ADD_PLAYER', payload: { id: localPlayerId, name: currentNickname, isHost: true } });
      
      if (networkManager.pc) networkManager.pc.close();
      // 无缝转职为 Host，携带原有的房间状态继续充当主服务器
      networkManager = new HostPeerManager(currentRoomId, socket, store, currentNickname, networkManager.iceConfig, localPlayerId, currentPassword);
      showRoomInfoUI(currentRoomId, currentNickname, currentPassword, true);
    }
  }
});

socket.on('connect', () => {
  console.log('[Socket] ✅ 已成功锚定到信令服务器！ID:', socket.id);
  // 连上后，立刻拉取一次最新的活跃房间
  socket.emit('get-active-rooms', (rooms) => {
    renderActiveRoomsTable(rooms);
  });

  // 核心修复：智能处理切屏/后台唤醒导致的 Socket 重连，杜绝 LOCK_PUZZLE 二次死锁
  if (networkManager) {
    statusText.style.color = '#f57c00';
    statusText.innerText = '🔄 网络发生瞬断，正在为您自动恢复盘面中...';
    if (networkManager instanceof HostPeerManager) {
      const payload = { roomId: networkManager.roomId || currentRoomId, nickname: currentNickname };
      if (currentPassword !== null) payload.password = currentPassword;
      socket.emit('create-room', payload);
    } else if (networkManager instanceof GuestPeerManager) {
      // 核心修复：拦截断线重连死循环！必须彻底销毁旧实例并重建 GuestPeerManager 重新走完整的打洞流程
      socket.emit('get-turn-credentials', (iceServers) => {
        if (networkManager.pc) networkManager.pc.close();
        // 实例化 GuestPeerManager 会在其内部自动发射 join-room 信号
        networkManager = new GuestPeerManager(currentRoomId, socket, store, currentNickname, { iceServers }, localPlayerId);
      });
    }
  }
});

// 监听房主主动迁移广播
socket.on('host-migrated', ({ newHostSocketId, gameState }) => {
  console.log(`[Migration] 🔄 收到房主变更广播！新房主 Socket ID: ${newHostSocketId}`);
  if (networkManager) {
    try {
      if (networkManager.pc) networkManager.pc.close();
      if (networkManager.channel) networkManager.channel.close();
    } catch (err) {
      console.warn(`[Migration] ⚠️ 清理旧网络实体异常:`, err);
    }
  }
  socket.off('signal');
  socket.off('relay-action');

  Object.keys(gameState.players).forEach(pId => {
    if (gameState.players[pId].name.includes('⭐')) {
      delete gameState.players[pId];
      delete gameState.focuses[pId];
    }
  });

  if (socket.id === newHostSocketId) {
    console.log(`[Migration] 👑 临危受命！我已被提升为新房主！`);
    store.setState(gameState);
    store.dispatch({ type: 'ADD_PLAYER', payload: { id: localPlayerId, name: currentNickname, isHost: true } });
    networkManager = new HostPeerManager(currentRoomId, socket, store, currentNickname, networkManager.iceConfig, localPlayerId);
    showRoomInfoUI(currentRoomId, currentNickname, currentPassword, true);
  } else {
    console.log(`[Migration] 🔌 房主已易主，正在无感重新建立 P2P 穿透...`);
    store.setState(gameState);
    setTimeout(() => {
      networkManager = new GuestPeerManager(currentRoomId, socket, store, currentNickname, networkManager.iceConfig, localPlayerId);
      showRoomInfoUI(currentRoomId, currentNickname, currentPassword, false);
    }, 1500);
  }
});

// 前端 Tab 标签页切换渲染控制
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    
    btn.classList.add('active');
    const targetTab = btn.dataset.tab;
    document.getElementById(targetTab).classList.add('active');

    // 核心修复：切换标签时强制取消单元格聚焦，防止虚拟键盘在无盘面状态下残留
    executeAction({ type: 'UPDATE_FOCUS', payload: { index: null } });

    if (targetTab === 'joinTab') {
      boardDiv.style.display = 'none'; // 加入房间标签页中不应该显示盘面信息
      socket.emit('get-active-rooms', (rooms) => renderActiveRoomsTable(rooms));
    } else {
      boardDiv.style.display = 'grid'; // 创建房间标签页恢复显示盘面
    }
  });
});

// 动态填充和渲染活跃房间 Table 元素
function renderActiveRoomsTable(rooms) {
  if (!roomListBody) return;
  if (!rooms || rooms.length === 0) {
    roomListBody.innerHTML = `<tr><td colspan="3" style="text-align:center; color:#999; padding:15px;">当前暂无活跃房间，请自己创建房间或点击刷新</td></tr>`;
    selectedRoom = null;
    joinPasswordInput.style.display = 'none';
    return;
  }

  roomListBody.innerHTML = '';
  rooms.forEach(room => {
    const tr = document.createElement('tr');
    if (selectedRoom && selectedRoom.roomId === room.roomId) {
      tr.className = 'selected';
    }
    tr.innerHTML = `<td>${room.hostNickname}</td><td>${room.roomId}</td><td>${room.isPrivate ? '🔒 私密' : '🔓 公开'}</td>`;
    
    tr.addEventListener('click', () => {
      roomListBody.querySelectorAll('tr').forEach(r => r.classList.remove('selected'));
      tr.classList.add('selected');
      selectedRoom = room;
      joinPasswordInput.style.display = room.isPrivate ? 'inline-block' : 'none';
      if (room.isPrivate) joinPasswordInput.focus();
    });
    roomListBody.appendChild(tr);
  });
}

// 私密勾选显示隐藏密码框
isPrivateCheck.addEventListener('change', (e) => {
  passwordInput.style.display = e.target.checked ? 'inline-block' : 'none';
});

// 核心整合：【验证建房】一键集成逻辑
btnVerify.addEventListener('click', () => {
  const roomId = roomIdInput.value.trim() || 'test-room';
  const nickname = nicknameInput.value.trim() || '匿名的数独大师';
  const password = isPrivateCheck.checked ? passwordInput.value : null;

  if (isPrivateCheck.checked && !password) {
    statusText.style.color = '#d32f2f';
    statusText.innerText = '⚠️ 既然开启了私密模式，请在旁边输入框填写进入房间的密码！';
    return;
  }

  statusText.style.color = '#1565c0';
  statusText.innerText = '🕵️ 正在对盘面执行高阶回溯剪枝，验证题目可解性...';

  setTimeout(() => {
    const solutionCount = countSolutions(store.getState().board);
    if (solutionCount === 0) {
      statusText.style.color = '#d32f2f';
      statusText.innerText = '❌ 验证失败：当前盘面存在逻辑冲突或无解，请修改盘面。';
    } else if (solutionCount > 1) {
      statusText.style.color = '#f57c00';
      statusText.innerText = '⚠️ 验证失败：线索不够，当前谜题存在多组解。请继续点击格子补充数字。';
    } else {
      statusText.style.color = '#2e7d32';
      statusText.innerText = '✅ 题目校验通过！唯一解路径锁定。正在为您向公网开启专属对局房间...';
      
      currentRoomId = roomId;
      currentNickname = nickname;
      currentPassword = password;

      socket.emit('get-turn-credentials', (iceServers) => {
        console.log('[WebRTC] 🔑 云端下发的 ICE 凭证内容:', iceServers);
        store.dispatch({ type: 'LOCK_PUZZLE' }); 
        store.dispatch({ type: 'ADD_PLAYER', payload: { id: localPlayerId, name: nickname, isHost: true } });
        
        networkManager = new HostPeerManager(roomId, socket, store, nickname, { iceServers }, localPlayerId, password);
        setupPanel.style.display = 'none';
        showRoomInfoUI(roomId, nickname, password, true);
      });
    }
  }, 15);
});

// 🎲 随机生成数独谜题事件绑定
btnGenerate.addEventListener('click', () => {
  btnGenerate.disabled = true;
  const originalText = btnGenerate.innerText;
  btnGenerate.innerText = '⏳ 正在死磕生成中...';
  statusText.style.color = '#1565c0';
  statusText.innerText = '正在随机抽取合法解并执行逆向路径破缺，请稍等片刻...';
  
  setTimeout(() => {
    const difficulty = difficultySelect.value;
    const newBoard = generateSudoku(difficulty);
    
    store.dispatch({ type: 'SET_BOARD', payload: { newBoard } });
    btnGenerate.innerText = originalText;
    btnGenerate.disabled = false;
    
    statusText.style.color = '#2e7d32';
    statusText.innerText = '✅ 谜题生成完毕！您可以直接点击“验证建房”一键启动联网对局啦。';
  }, 50);
});

// 【加入房间】动作执行
btnJoin.addEventListener('click', () => {
  if (!selectedRoom) {
    statusText.style.color = '#d32f2f';
    statusText.innerText = '⚠️ 请先在活跃列表中点击选择一行您想加入的房间！';
    return;
  }
  const nickname = nicknameInput.value.trim() || '新玩家';
  const password = selectedRoom.isPrivate ? joinPasswordInput.value : null;

  if (selectedRoom.isPrivate && !password) {
    statusText.style.color = '#d32f2f';
    statusText.innerText = '🔒 该房间是私密的，请输入密码后再尝试点加入！';
    return;
  }

  const roomId = selectedRoom.roomId;
  statusText.style.color = '#1565c0';
  statusText.innerText = `正在向服务器请求对房间 [${roomId}] 的入场签证...`;

  socket.emit('check-room', { roomId, nickname, playerId: localPlayerId, password }, (response) => {
    if (!response.exists) {
      alert('❌ 该房间已被房主解散或不存在，请刷新列表！');
      return;
    }
    if (response.authFailed) {
      alert('🔒 进房失败：房间密码错误！');
      return;
    }
    if (response.duplicate) {
      alert('❌ 房间内已有同名玩家，请在顶部修改您的昵称后再加入！');
      return;
    }

    statusText.style.color = '#2e7d32';
    statusText.innerText = '✅ 签证通过！正在构建 P2P 直连打洞数据矩阵...';
    
    currentRoomId = roomId;
    currentNickname = nickname;
    currentPassword = password;

    socket.emit('get-turn-credentials', (iceServers) => {
      if (networkManager && networkManager.pc) networkManager.pc.close();
      
      store = createStore((s) => renderBoard(s)); 
      networkManager = new GuestPeerManager(roomId, socket, store, nickname, { iceServers }, localPlayerId); 
      store.dispatch({ type: 'ADD_PLAYER', payload: { id: localPlayerId, name: nickname, isHost: false } });

      setupPanel.style.display = 'none';
      boardDiv.style.display = 'grid'; // 核心修复：玩家成功加入对局后，强制让游戏盘面显现
      showRoomInfoUI(roomId, nickname, password, false);
    });
  });
});

// 动态创建并显现进房后的纯文本状态面板
function showRoomInfoUI(roomId, nickname, password, isHost) {
  const infoDiv = document.getElementById('roomInfoDisplay');
  infoDiv.style.display = 'block';
  const role = isHost ? '👑 房主' : '👤 玩家';
  const pwdText = password ? `<span style="color:#d32f2f">🔒 密码: ${password}</span>` : `<span style="color:#2e7d32">🔓 公开</span>`;
  infoDiv.innerHTML = `<div><strong>${role}:</strong> ${nickname} &nbsp;|&nbsp; <strong>房间:</strong> ${roomId} &nbsp;|&nbsp; ${pwdText}</div>`;
  
  statusText.style.display = 'none'; // 隐藏首页提示信息框
  if (mainTitle) mainTitle.style.display = 'none'; // 隐藏主标题
  if (nicknameArea) nicknameArea.style.display = 'none'; // 隐藏设置昵称控件
  
  btnLeave.style.display = 'inline-block';
  if (isHost) btnLeave.innerText = '解散房间';
}

// 绑定发送聊天逻辑
const sendChatMessage = () => {
  const text = chatInput.value.trim();
  if (!text) return;
  executeAction({ type: 'SEND_CHAT', payload: { id: localPlayerId, text } });
  chatInput.value = '';
};
btnSendChat.addEventListener('click', sendChatMessage);
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); sendChatMessage(); }
});

// 初始化画板元素与事件绑定
function updateModeToggleUI() {
  modeToggle.innerText = isNoteMode ? '📝 备注模式 (On)' : '📝 备注模式 (Off)';
  if (isNoteMode) modeToggle.classList.add('active'); else modeToggle.classList.remove('active');
  if (vkModeToggle) {
    vkModeToggle.innerText = isNoteMode ? '📝 备注 (On)' : '📝 备注 (Off)';
    if (isNoteMode) vkModeToggle.classList.add('active'); else vkModeToggle.classList.remove('active');
  }
}
modeToggle.addEventListener('click', () => { isNoteMode = !isNoteMode; updateModeToggleUI(); });
if (vkModeToggle) {
  vkModeToggle.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation(); isNoteMode = !isNoteMode; updateModeToggleUI();
  });
}

// 体验优化：智能防遮挡平滑滚动逻辑
function ensureCellVisible(index) {
  setTimeout(() => {
    const cellNode = document.querySelector(`.cell[data-index="${index}"]`);
    if (!cellNode) return;
    const rect = cellNode.getBoundingClientRect();
    // 虚拟键盘预估高度 + 缓冲距离 = 约 250px 危险区
    const safeBottom = window.innerHeight - 250; 
    
    if (rect.bottom > safeBottom) {
      // 被底部键盘遮挡，向上顶起页面
      window.scrollBy({ top: rect.bottom - safeBottom + 20, behavior: 'smooth' });
    } else if (rect.top < 60) {
      // 溢出屏幕顶部，向下拉回页面
      window.scrollBy({ top: rect.top - 80, behavior: 'smooth' });
    }
  }, 50); // 给键盘 UI 的渲染弹出预留微小延迟
}

for (let i = 0; i < 81; i++) {
  const cell = document.createElement('div');
  cell.className = 'cell';
  cell.dataset.index = i;
  if (i % 9 === 2 || i % 9 === 5) cell.classList.add('border-right-thick');
  if (Math.floor(i / 9) === 2 || Math.floor(i / 9) === 5) cell.classList.add('border-bottom-thick');
  cell.addEventListener('click', (e) => {
    e.stopPropagation(); 
    executeAction({ type: 'UPDATE_FOCUS', payload: { index: i } });
    ensureCellVisible(i); // 点击格子时动态推拉视口防遮挡
  });
  cell.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    const state = store.getState();
    // 验证是否已聚焦，且为非初始锁定位置并存在填入的数字
    if (state.focuses[localPlayerId] === i && !state.locked[i] && state.board[i] !== null) {
      executeAction({ type: 'TOGGLE_CHECK_CELL', payload: { index: i } });
    }
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

  if (isNoteMode) {
    if (isValidNum) executeAction({ type: 'TOGGLE_NOTE', payload: { index: focusedIndex, value: num } });
    else if (isDelete) executeAction({ type: 'CLEAR_CELL_NOTES', payload: { index: focusedIndex } });
  } else {
    const valToFill = isDelete ? null : num;
    executeAction({ type: 'FILL_NUM', payload: { index: focusedIndex, value: valToFill } });

    if (store.getState().phase === 'PLAYING' && isBoardSolved(store.getState().board)) {
      triggerWinSequence(store.getState());
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
      ensureCellVisible(newIndex); // 键盘方向键移动时同样进行防遮挡跟踪
      return;
    }
  }
  handleInput(e.key);
});

document.querySelectorAll('.vk-key:not(#vkModeToggle)').forEach(btn => {
  btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); handleInput(btn.dataset.key); });
});

function triggerWinSequence(state) {
  const scores = {};
  Object.keys(state.players).forEach(id => scores[id] = 0);
  state.cellOwners.forEach((ownerId, index) => {
    if (!state.locked[index] && ownerId && state.players[ownerId]) scores[ownerId]++;
  });
  scoreBoard.innerHTML = '';
  Object.keys(scores).sort((a, b) => scores[b] - scores[a]).forEach(id => {
    const p = state.players[id];
    scoreBoard.innerHTML += `<div class="score-item" style="color: ${p.color}"><span>${p.name}</span><span>${scores[id]} 格</span></div>`;
  });
  winModal.style.display = 'flex';
}

document.addEventListener('click', (e) => {
  if (!document.contains(e.target)) return;
  if (!e.target.closest('.cell') && !e.target.closest('#virtualKeyboard') && !e.target.closest('.mode-toggle')) {
    executeAction({ type: 'UPDATE_FOCUS', payload: { index: null } });
  }
});

btnClear.addEventListener('click', () => {
  if (confirm('🚨 确定要清空当前盘面的所有数字吗？')) {
    executeAction({ type: 'CLEAR_BOARD' });
  }
});

const getRowColGrid = (index) => {
  const row = Math.floor(index / 9); const col = index % 9;
  return { row, col, grid: Math.floor(row / 3) * 3 + Math.floor(col / 3) };
};

function renderBoard(state) {
  // 核心控制：当且仅当游戏正式开始（PLAYING阶段），才渲染玩家面板及备注控制条
  document.getElementById('inGameInfoBar').style.display = state.phase === 'PLAYING' ? 'flex' : 'none';

  let newPlayerHtml = '';
  Object.values(state.players).forEach(player => {
    if (player.isOnline === false) return;
    newPlayerHtml += `<div class="player-tag" style="background-color: ${player.color}">${player.name}</div>`;
  });
  // 核心修复：使用 HTML 字符串比对，如果相同则不更新 DOM，彻底解决移动端高频点击和软键盘弹起时的列表闪烁消失问题
  if (playerListDiv.innerHTML !== newPlayerHtml) {
    playerListDiv.innerHTML = newPlayerHtml;
  }

  const conflicts = Array(81).fill().map(() => new Set());
  for (let i = 0; i < 81; i++) {
    if (state.board[i] !== null) {
      const val = state.board[i]; const target = getRowColGrid(i);
      for (let j = 0; j < 81; j++) {
        const current = getRowColGrid(j);
        if (current.row === target.row || current.col === target.col || current.grid === target.grid) conflicts[j].add(val);
      }
    }
  }

  const localFocusedIndex = state.focuses[localPlayerId];
  const highlightedNum = (localFocusedIndex !== undefined && localFocusedIndex !== null) ? state.board[localFocusedIndex] : null;

  const cells = document.querySelectorAll('.cell');
  cells.forEach((cell, index) => {
    let className = 'cell';
    if (index % 9 === 2 || index % 9 === 5) className += ' border-right-thick';
    if (Math.floor(index / 9) === 2 || Math.floor(index / 9) === 5) className += ' border-bottom-thick';
    if (state.locked[index]) className += ' locked';
    if (state.checkedCells && state.checkedCells[index]) className += ' checked';
    if (highlightedNum !== null && state.board[index] === highlightedNum) className += ' number-highlight';
    cell.className = className;
    
    let boxShadows = [];
    Object.entries(state.focuses).forEach(([playerId, focusedIndex]) => {
      if (focusedIndex === index && state.players[playerId]) {
        boxShadows.push(`inset 0 0 0 4px ${state.players[playerId].color}`); 
      }
    });
    cell.style.boxShadow = boxShadows.length > 0 ? boxShadows.join(', ') : 'none';

    if (state.board[index] !== null) {
      cell.innerHTML = state.board[index];
    } else {
      const visibleNotes = state.notes[index].filter(n => !conflicts[index].has(n));
      if (visibleNotes.length > 0) {
        let gridHtml = '<div class="notes-grid">';
        for (let n = 1; n <= 9; n++) gridHtml += `<div class="note-item">${visibleNotes.includes(n) ? n : ''}</div>`;
        cell.innerHTML = gridHtml + '</div>';
      } else cell.innerHTML = '';
    }
  });

  if (virtualKeyboard) {
    const hasFocus = (localFocusedIndex !== null && localFocusedIndex !== undefined);
    virtualKeyboard.style.display = hasFocus ? 'grid' : 'none';
    
    // 核心体验修复：当键盘弹起时，给整个页面底部强制留出 260px 的空白缓冲，防止无法向下滚动
    document.body.style.paddingBottom = hasFocus ? '260px' : '60px';
  }

  // 渲染公屏聊天区域
  if (state.phase === 'PLAYING') {
    chatPanel.style.display = 'flex';
    const escapeHTML = (str) => str.replace(/[&<>'"]/g, tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag]));
    const currentLastMsg = state.chatMessages.length > 0 ? state.chatMessages[state.chatMessages.length - 1] : null;
    if (currentLastMsg && currentLastMsg.id !== chatMessagesDiv.dataset.lastMsgId) {
      chatMessagesDiv.innerHTML = '';
      state.chatMessages.forEach(msg => {
        const p = state.players[msg.playerId]; if (!p) return;
        const msgDiv = document.createElement('div'); msgDiv.className = 'chat-msg';
        msgDiv.innerHTML = `<span class="chat-name" style="color: ${p.color}">${p.name}:</span><span>${escapeHTML(msg.text)}</span>`;
        chatMessagesDiv.appendChild(msgDiv);
      });
      chatMessagesDiv.dataset.lastMsgId = currentLastMsg.id;
      chatMessagesDiv.scrollTop = chatMessagesDiv.scrollHeight;
    } else if (state.chatMessages.length === 0) {
      chatMessagesDiv.innerHTML = ''; chatMessagesDiv.dataset.lastMsgId = '';
    }
  } else { chatPanel.style.display = 'none'; }
}

btnLeave.addEventListener('click', () => {
  if (confirm('确定要退出当前房间吗？')) {
    if (networkManager && networkManager.peers) {
      const peers = Object.keys(networkManager.peers);
      if (peers.length > 0) {
        let newHostSocketId = peers[0];
        for (const socketId of peers) { if (!networkManager.peers[socketId].isRelayMode) { newHostSocketId = socketId; break; } }
        // 核心修复：改用服务器安全 Ack 回调，并确保 roomId 从网络管理器中精确获取
        networkManager.socket.emit('migrate-host', { roomId: networkManager.roomId || currentRoomId, newHostSocketId: newHostSocketId, gameState: store.getState() }, () => {
          console.log('[Migration] ✅ 房主迁移信令服务器已确认接收并转发，老房主现在安全退出...');
          window.location.reload();
        });
        return;
      }
    }
    window.location.reload(); 
  }
});

renderBoard(store.getState());

// 优化：重新调整 vConsole 按钮到右下角，并适配全面屏底部安全区
const vcStyle = document.createElement('style');
vcStyle.innerHTML = `
  #__vconsole .vc-switch { 
    /* 使用 calc 和 env() 动态计算，确保贴底但不被手机系统小白条遮挡 */
    bottom: calc(20px + env(safe-area-inset-bottom)) !important; 
    right: 1px !important; 
    z-index: 999999 !important; 
    box-shadow: 0 4px 15px rgba(0,0,0,0.5) !important; 
    /* 稍微缩小一点，避免在右下角太突兀 */
    transform: scale(0.5) !important; 
  }
`;
document.head.appendChild(vcStyle);