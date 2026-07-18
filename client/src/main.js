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
const gameTimer = document.getElementById('gameTimer');
const nicknameInput = document.getElementById('nicknameInput');
const btnLeave = document.getElementById('btnLeave');
const winModal = document.getElementById('winModal');
const scoreBoard = document.getElementById('scoreBoard');

// 分支与冲突弹窗节点映射
const branchUIContainer = document.getElementById('branchUIContainer');
const gitGraphContainer = document.getElementById('gitGraphContainer');
const branchControls = document.getElementById('branchControls');
const btnBranch = document.getElementById('btnBranch');
const btnMerge = document.getElementById('btnMerge');
const btnRevert = document.getElementById('btnRevert');
const conflictModal = document.getElementById('conflictModal');

// 为 Git Graph 容器注册鼠标横向拖拽滑动事件（提升 PC 端体验）
if (gitGraphContainer) {
  let isDown = false;
  let startX;
  let scrollLeft;
  gitGraphContainer.style.cursor = 'grab';
  gitGraphContainer.addEventListener('mousedown', (e) => {
    isDown = true;
    gitGraphContainer.style.cursor = 'grabbing';
    startX = e.pageX - gitGraphContainer.offsetLeft;
    scrollLeft = gitGraphContainer.scrollLeft;
  });
  gitGraphContainer.addEventListener('mouseleave', () => {
    isDown = false;
    gitGraphContainer.style.cursor = 'grab';
  });
  gitGraphContainer.addEventListener('mouseup', () => {
    isDown = false;
    gitGraphContainer.style.cursor = 'grab';
  });
  gitGraphContainer.addEventListener('mousemove', (e) => {
    if (!isDown) return;
    e.preventDefault();
    const x = e.pageX - gitGraphContainer.offsetLeft;
    gitGraphContainer.scrollLeft = scrollLeft - (x - startX) * 1.5;
  });
}
const conflictList = document.getElementById('conflictList');
const btnCancelMerge = document.getElementById('btnCancelMerge');
const btnConfirmMerge = document.getElementById('btnConfirmMerge');

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
  if (vkModeToggle) {
    vkModeToggle.innerText = isNoteMode ? '📝 备注 (On)' : '📝 备注 (Off)';
    if (isNoteMode) vkModeToggle.classList.add('active'); else vkModeToggle.classList.remove('active');
  }
  // 核心修改：切换模式时，强制立即刷新整个盘面和键盘高亮状态
  renderBoard(store.getState());
}
if (vkModeToggle) {
  vkModeToggle.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation(); isNoteMode = !isNoteMode; updateModeToggleUI();
  });
}

// 游戏计时器更新逻辑
setInterval(() => {
  const state = store.getState();
  if (state.phase === 'PLAYING' && state.gameStartTime) {
    const now = state.gameEndTime || Date.now();
    const diff = Math.floor((now - state.gameStartTime) / 1000);
    const h = String(Math.floor(diff / 3600)).padStart(2, '0');
    const m = String(Math.floor((diff % 3600) / 60)).padStart(2, '0');
    const s = String(diff % 60).padStart(2, '0');
    if (gameTimer) gameTimer.innerText = `⏱️ ${h}:${m}:${s}`;
  }
}, 1000);

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
    // 核心修复 1：【乐观预测】非房主玩家点击格子时，强制立即同步本地 Focus，消灭网络延迟造成的焦点断层
    store.getState().focuses[localPlayerId] = i; 
    executeAction({ type: 'UPDATE_FOCUS', payload: { index: i } });
    ensureCellVisible(i); // 点击格子时动态推拉视口防遮挡
    renderBoard(store.getState()); // 强制触发一次本地重绘，使得高亮即刻响应
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
      // 核心修复 2：键盘方向键也加入乐观预测机制，保障连续高亮不闪断
      store.getState().focuses[localPlayerId] = newIndex; 
      executeAction({ type: 'UPDATE_FOCUS', payload: { index: newIndex } });
      ensureCellVisible(newIndex); // 键盘方向键移动时同样进行防遮挡跟踪
      renderBoard(store.getState());
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

// 渲染结算用时
  const winTimeDisplay = document.getElementById('winTimeDisplay');
  if (winTimeDisplay && state.gameStartTime) {
    const now = state.gameEndTime || Date.now();
    const diff = Math.floor((now - state.gameStartTime) / 1000);
    const h = String(Math.floor(diff / 3600)).padStart(2, '0');
    const m = String(Math.floor((diff % 3600) / 60)).padStart(2, '0');
    const s = String(diff % 60).padStart(2, '0');
    winTimeDisplay.innerHTML = `<strong>游戏用时：</strong> ${h}:${m}:${s}`;
  }

  // 动态生成通关最终盘面
  const finalBoardDiv = document.getElementById('finalBoard');
  if (finalBoardDiv) {
    finalBoardDiv.innerHTML = '';
    for (let i = 0; i < 81; i++) {
      const cell = document.createElement('div');
      cell.className = 'final-cell';
      if (i % 9 === 2 || i % 9 === 5) cell.classList.add('border-right-thick');
      if (Math.floor(i / 9) === 2 || Math.floor(i / 9) === 5) cell.classList.add('border-bottom-thick');
      
      if (state.locked[i]) {
        cell.classList.add('locked');
        cell.innerHTML = state.board[i];
      } else {
        cell.innerHTML = state.board[i] !== null ? state.board[i] : '';
        const ownerId = state.cellOwners[i];
        if (ownerId && state.players[ownerId]) {
          // 非题面数字按照贡献该格子的玩家颜色进行背景填充，字体颜色设为白色以保持高对比度
          cell.style.backgroundColor = state.players[ownerId].color;
          cell.style.color = '#ffffff';
        }
      }
      finalBoardDiv.appendChild(cell);
    }
  }

  winModal.style.display = 'flex';
}

document.addEventListener('click', (e) => {
  if (!document.contains(e.target)) return;
  if (!e.target.closest('.cell') && !e.target.closest('#virtualKeyboard')) {
    executeAction({ type: 'UPDATE_FOCUS', payload: { index: null } });
  }
});

btnClear.addEventListener('click', () => {
  if (confirm('🚨 确定要清空当前盘面的所有数字吗？')) {
    executeAction({ type: 'CLEAR_BOARD' });
  }
});

// --- Git-like 多级嵌套分支控制流与冲突裁决逻辑 ---
let pendingSafeMerges = []; 
let pendingConflicts = [];

btnBranch.addEventListener('click', () => {
  if (btnBranch.disabled) return; // 拦截被禁用的点击
  executeAction({ type: 'CREATE_BRANCH' });
});

btnRevert.addEventListener('click', () => {
  const stack = store.getState().branchStacks[localPlayerId];
  const depth = stack ? stack.length : 0;
  if (confirm(`🗑️ 确定要拔旗，并丢弃您在第 ${depth} 层局部分支中探索的所有数据吗？`)) {
    executeAction({ type: 'REVERT_BRANCH' });
  }
});

btnMerge.addEventListener('click', () => {
  const state = store.getState();
  const stack = state.branchStacks[localPlayerId];
  if (!stack || stack.length === 0) return;

  // 如果处于多级嵌套深处，执行无感向下压缩合并（Squash），由于是玩家私有沙盒层级融合，绝对不会产生多人冲突
  if (stack.length > 1) {
    executeAction({ type: 'SQUASH_BRANCH' });
    return;
  }

  // 如果已经是最后一层（直接对接主干），则触发真实的多人 Diff 对比与冲突捕捉机制
  const myBranch = stack[0];
  const mainBoard = state.board;

  pendingSafeMerges = [];
  pendingConflicts = [];

  // 基础 Diff 检索引擎：提取变化矩阵并过滤逻辑冲突
  for (let i = 0; i < 81; i++) {
    if (myBranch[i] !== null) {
      if (mainBoard[i] !== null && mainBoard[i] !== myBranch[i]) {
        pendingConflicts.push({ index: i, myVal: myBranch[i], mainVal: mainBoard[i] });
      } else {
        pendingSafeMerges.push({ index: i, value: myBranch[i] });
      }
    }
  }

  // 存在冲突矩阵则进入 UI 挂起状态等待裁决
  if (pendingConflicts.length > 0) {
    renderConflictBoard(mainBoard, pendingConflicts);
    conflictModal.style.display = 'flex';
  } else {
    executeAction({ type: 'COMMIT_MERGE', payload: { diffs: pendingSafeMerges } });
  }
});

let currentResolutions = {};

function renderConflictBoard(mainBoard, conflicts) {
  currentResolutions = {};
  const conflictMap = {};
  conflicts.forEach(c => {
    conflictMap[c.index] = c;
    currentResolutions[c.index] = null; // 初始化为未裁决
  });

  const boardDiv = document.getElementById('conflictBoard');
  boardDiv.innerHTML = '';

  for (let i = 0; i < 81; i++) {
    const wrap = document.createElement('div');
    wrap.className = 'cf-cell-wrap';
    if (i % 9 === 2 || i % 9 === 5) wrap.classList.add('border-right-thick');
    if (Math.floor(i / 9) === 2 || Math.floor(i / 9) === 5) wrap.classList.add('border-bottom-thick');

    if (conflictMap[i]) {
      const c = conflictMap[i];
      // 对于抹除操作 (-1 或 null)，用视觉显眼的符号 'Ø' 占位代替空白
      const myStr = c.myVal === null || c.myVal === -1 ? 'Ø' : c.myVal;
      const mainStr = c.mainVal === null || c.mainVal === -1 ? 'Ø' : c.mainVal;

      const content = document.createElement('div');
      content.className = 'cf-content cf-interactive';
      content.dataset.index = i;

      // 组装传入侧 (Mine) 的几何碰撞块
      const minePart = document.createElement('div');
      minePart.className = 'cf-part cf-mine';
      minePart.innerHTML = `<span>${myStr}</span>`;
      minePart.addEventListener('click', (e) => {
        e.stopPropagation();
        resolveConflict(i, 'mine');
      });

      // 组装主干侧 (Main) 的几何碰撞块
      const mainPart = document.createElement('div');
      mainPart.className = 'cf-part cf-main';
      mainPart.innerHTML = `<span>${mainStr}</span>`;
      mainPart.addEventListener('click', (e) => {
        e.stopPropagation();
        resolveConflict(i, 'main');
      });

      content.appendChild(minePart);
      content.appendChild(mainPart);
      wrap.appendChild(content);
    } else {
      const content = document.createElement('div');
      content.className = 'cf-content cf-no-conflict';
      content.innerText = mainBoard[i] !== null ? mainBoard[i] : '';
      wrap.appendChild(content);
    }

    boardDiv.appendChild(wrap);
  }
  checkAllResolved();
}

function resolveConflict(index, choice) {
  currentResolutions[index] = choice;
  const content = document.querySelector(`.cf-interactive[data-index="${index}"]`);
  if (content) {
    // 触发纯 CSS 硬件加速过渡动画
    content.classList.remove('cf-resolved-mine', 'cf-resolved-main');
    content.classList.add(choice === 'mine' ? 'cf-resolved-mine' : 'cf-resolved-main');
  }
  checkAllResolved();
}

function checkAllResolved() {
  const total = Object.keys(currentResolutions).length;
  const resolvedCount = Object.values(currentResolutions).filter(v => v !== null).length;
  const allResolved = resolvedCount === total;
  
  if (allResolved) {
    btnConfirmMerge.disabled = false;
    btnConfirmMerge.style.opacity = '1';
    btnConfirmMerge.style.cursor = 'pointer';
    btnConfirmMerge.innerText = '确认裁决并提交';
  } else {
    btnConfirmMerge.disabled = true;
    btnConfirmMerge.style.opacity = '0.5';
    btnConfirmMerge.style.cursor = 'not-allowed';
    btnConfirmMerge.innerText = `需解决所有冲突 (${resolvedCount}/${total})`;
  }
}

const btnAllMine = document.getElementById('btnAllMine');
const btnAllMain = document.getElementById('btnAllMain');
if (btnAllMine) {
  btnAllMine.addEventListener('click', () => {
    Object.keys(currentResolutions).forEach(idx => resolveConflict(parseInt(idx), 'mine'));
  });
}
if (btnAllMain) {
  btnAllMain.addEventListener('click', () => {
    Object.keys(currentResolutions).forEach(idx => resolveConflict(parseInt(idx), 'main'));
  });
}

btnCancelMerge.addEventListener('click', () => {
  conflictModal.style.display = 'none'; 
});

btnConfirmMerge.addEventListener('click', () => {
  if (btnConfirmMerge.disabled) return;
  
  pendingConflicts.forEach((conflict) => {
    const choice = currentResolutions[conflict.index];
    if (choice === 'mine') {
      // 还原墓碑值为实际需要提交的内容
      const finalVal = conflict.myVal === null ? -1 : conflict.myVal;
      pendingSafeMerges.push({ index: conflict.index, value: finalVal });
    }
  });
  executeAction({ type: 'COMMIT_MERGE', payload: { diffs: pendingSafeMerges } });
  conflictModal.style.display = 'none';
});

const getRowColGrid = (index) => {
  const row = Math.floor(index / 9); const col = index % 9;
  return { row, col, grid: Math.floor(row / 3) * 3 + Math.floor(col / 3) };
};

function renderBoard(state) {
  // 核心控制：当且仅当游戏正式开始（PLAYING阶段），才渲染玩家面板及分支沙盒组件
  const isPlaying = state.phase === 'PLAYING';
  document.getElementById('inGameInfoBar').style.display = isPlaying ? 'flex' : 'none';
  if (branchUIContainer) branchUIContainer.style.display = isPlaying ? 'flex' : 'none';

  let newPlayerHtml = '';
  Object.values(state.players).forEach(player => {
    if (player.isOnline === false) return;
    newPlayerHtml += `<div class="player-tag" style="background-color: ${player.color}">${player.name}</div>`;
  });
  // 核心修复：使用 HTML 字符串比对，如果相同则不更新 DOM，彻底解决移动端高频点击和软键盘弹起时的列表闪烁消失问题
  if (playerListDiv.innerHTML !== newPlayerHtml) {
    playerListDiv.innerHTML = newPlayerHtml;
  }

  // 提取多级图层扁平化渲染引擎到最外部
  function getFlattenedBranch(playerId) {
    const stack = state.branchStacks ? state.branchStacks[playerId] : null;
    if (!stack || stack.length === 0) return null;
    const flat = Array(81).fill(null);
    for (let layer of stack) {
      for (let i = 0; i < 81; i++) {
        // -1 作为墓碑标记时，需要被解析回 null，屏蔽下方图层
        if (layer[i] !== null) flat[i] = layer[i] === -1 ? null : layer[i];
      }
    }
    return flat;
  }

  const myFlat = getFlattenedBranch(localPlayerId);
  
  // 核心修复 3：绝对加固有效盘面（Effective Board），即使网络包存在细微的时序误差，也能从本地强制提取合并态
  const effectiveBoard = Array(81).fill(null);
  for (let i = 0; i < 81; i++) {
    // 优先读取本地多级分支顶层映射结果，如果为空，才回退读取主干板数据
    effectiveBoard[i] = (myFlat && myFlat[i] !== null) ? myFlat[i] : state.board[i];
  }

  const conflicts = Array(81).fill().map(() => new Set());
  for (let i = 0; i < 81; i++) {
    if (effectiveBoard[i] !== null) { // 将主干数据替换为结合了自己分支的有效盘面数据
      const val = effectiveBoard[i]; const target = getRowColGrid(i);
      for (let j = 0; j < 81; j++) {
        const current = getRowColGrid(j);
        if (current.row === target.row || current.col === target.col || current.grid === target.grid) conflicts[j].add(val);
      }
    }
  }

  const localFocusedIndex = state.focuses[localPlayerId];
  // 基于有效盘面提取当前高亮的数字（确保探索分支里的数字点击后也能跨层高亮）
  const highlightedNum = (localFocusedIndex !== undefined && localFocusedIndex !== null) ? effectiveBoard[localFocusedIndex] : null;

  const cells = document.querySelectorAll('.cell');
  cells.forEach((cell, index) => {
    let className = 'cell';
    if (index % 9 === 2 || index % 9 === 5) className += ' border-right-thick';
    if (Math.floor(index / 9) === 2 || Math.floor(index / 9) === 5) className += ' border-bottom-thick';
    if (state.locked[index]) className += ' locked';
    if (state.checkedCells && state.checkedCells[index]) className += ' checked';
    // 基于有效盘面做相同数字的高亮响应
    if (highlightedNum !== null && effectiveBoard[index] === highlightedNum) className += ' number-highlight';
    cell.className = className;
    cell.style.color = ''; // 重置字体颜色，防止沙盒模式的样式遗留污染主干
    
    let boxShadows = [];
    Object.entries(state.focuses).forEach(([playerId, focusedIndex]) => {
      if (focusedIndex === index && state.players[playerId]) {
        boxShadows.push(`inset 0 0 0 4px ${state.players[playerId].color}`); 
      }
    });
    cell.style.boxShadow = boxShadows.length > 0 ? boxShadows.join(', ') : 'none';

    let displayVal = state.board[index];
    
    // 自身多级分支视图覆盖
    if (myFlat && myFlat[index] !== null) {
      displayVal = myFlat[index];
      cell.style.color = '#f57c00'; // 沙盒状态下的暂存数字使用显眼橙色警告标示
    }

    // 幽灵投影机制：如果是主干中的空位，扫描是否正有他人在自己的多级沙盒内对其进行操作
    let ghostHtml = '';
    if (displayVal === null) {
       for (const pId of Object.keys(state.players)) {
          if (pId === localPlayerId) continue;
          const otherFlat = getFlattenedBranch(pId);
          // 渲染他人的非空记录，右上角打上思考标识
          if (otherFlat && otherFlat[index] !== null) {
             const pColor = state.players[pId] ? state.players[pId].color : '#ccc';
             ghostHtml = `<div class="ghost-num" style="color: ${pColor}">🤔${otherFlat[index]}</div>`;
             break; // 防止重叠，只捕获第一个扫描到的动作投影
          }
       }
    }

    if (displayVal !== null) {
      cell.innerHTML = displayVal;
    } else if (ghostHtml) {
      cell.innerHTML = ghostHtml;
    } else {
      const visibleNotes = state.notes[index].filter(n => !conflicts[index].has(n));
      if (visibleNotes.length > 0) {
        let gridHtml = '<div class="notes-grid">';
        for (let n = 1; n <= 9; n++) {
          // 仅当玩家确实填入了该备注，且该数字等于当前全局高亮数字时，才触发备注高亮
          const isHighlight = (highlightedNum !== null && n === highlightedNum && visibleNotes.includes(n));
          const className = isHighlight ? 'note-item note-highlight' : 'note-item';
          gridHtml += `<div class="${className}">${visibleNotes.includes(n) ? n : ''}</div>`;
        }
        cell.innerHTML = gridHtml + '</div>';
      } else cell.innerHTML = '';
    }
  });

  if (virtualKeyboard) {
    const hasFocus = (localFocusedIndex !== null && localFocusedIndex !== undefined);
    virtualKeyboard.style.display = hasFocus ? 'grid' : 'none';
    
    // 核心体验修复：当键盘弹起时，给整个页面底部强制留出 260px 的空白缓冲，防止无法向下滚动
    document.body.style.paddingBottom = hasFocus ? '260px' : '60px';

    if (isNoteMode) {
      // 📝 备注模式逻辑：隐藏电量条，高亮当前行列宫中没有的候选数字
      for (let i = 1; i <= 9; i++) {
        const batFill = document.getElementById(`vk-bat-${i}`);
        const keyBtn = document.querySelector(`.vk-key[data-key="${i}"]`);
        
        if (batFill && keyBtn) {
          batFill.style.height = '0%'; // 恢复无电量格式
          batFill.style.backgroundColor = 'transparent';
          keyBtn.classList.remove('over-limit'); // 备注状态不显示紫色超限效果

          const hasActiveFocus = (localFocusedIndex !== null && localFocusedIndex !== undefined);
          // 判定聚焦的格子及其关联九宫格中，是否缺失当前数字 i (即 conflicts 冲突集中不包含 i)
          if (hasActiveFocus && conflicts[localFocusedIndex] && !conflicts[localFocusedIndex].has(i)) {
            keyBtn.classList.add('candidate-highlight');
          } else {
            keyBtn.classList.remove('candidate-highlight');
          }
        }
      }
    } else {
      // 🔢 数字模式逻辑：展现平滑电量进度，移除高亮
      const numCounts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0, 9: 0 };
      // 核心修复：基于玩家当前的有效盘面（叠加了自己所在所有分支层的试错数据）进行进度条统计
      effectiveBoard.forEach(val => {
        if (val !== null && numCounts[val] !== undefined) {
          numCounts[val]++;
        }
      });

      for (let i = 1; i <= 9; i++) {
        const count = numCounts[i];
        const batFill = document.getElementById(`vk-bat-${i}`);
        const keyBtn = document.querySelector(`.vk-key[data-key="${i}"]`);
        
        if (batFill && keyBtn) {
          keyBtn.classList.remove('candidate-highlight'); // 数字输入模式下禁用候选高亮

          // 将整个按键区域作为电量条，按1到9数量进行比例高度填充，最多填充至100%
          const heightPct = Math.min(count, 9) / 9 * 100;
          batFill.style.height = `${heightPct}%`;
          
          // 提前采样 9 阶平滑渐进过渡色，在保证低饱和度、高文字对比度的同时，呈现温润平滑的过渡
          const gradientColors = [
            'transparent', // 0 个（未填入）
            '#ffcdd2',     // 1 个: 柔和浅红 (Pink Red)
            '#ffd8b8',     // 2 个: 柔和浅粉橙 (Peach-Orange)
            '#ffe0b2',     // 3 个: 柔和浅橙 (Soft Orange)
            '#fff1b8',     // 4 个: 柔和黄橙 (Warm Yellow-Orange)
            '#fff59d',     // 5 个: 柔和淡黄 (Pastel Yellow)
            '#f0f4c3',     // 6 个: 柔和黄绿 (Soft Lime)
            '#dbf2db',     // 7 个: 柔和淡薄荷绿 (Mint Leaf)
            '#c8e6c9',     // 8 个: 柔和淡绿 (Fresh Green)
            '#a5d6a7'      // 9 个: 柔和满绿 (Perfect Green)
          ];
          
          const color = count > 9 ? gradientColors[9] : (gradientColors[count] || 'transparent');
          batFill.style.backgroundColor = color;

          // 溢出 9 个时的紫色警告特效
          if (count > 9) {
            keyBtn.classList.add('over-limit');
          } else {
            keyBtn.classList.remove('over-limit');
          }
        }
      }
    }
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
  
  // 核心修复：将通关判定下沉至全局渲染流中。
  // 这样不仅解决了其他玩家收不到弹窗的 Bug，同时也顺带修复了通过“分支合并”填满盘面时不触发通关的 Bug。
  if (state.phase === 'PLAYING' && isBoardSolved(state.board)) {
    if (!state.gameEndTime) {
      executeAction({ type: 'SET_END_TIME', payload: { time: Date.now() } });
    }
    // 增加防御性判断，防止 Reactivity 导致弹窗重复触发闪烁
    if (winModal.style.display !== 'flex') {
      triggerWinSequence(state);
    }
  }

  // 触发 UI 渲染时一并更新多级分支面板信息
  updateBranchUI(state);
}

// 监听切屏后台返回，确保结算画面能够弹出同步
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    const state = store.getState();
    if (state.phase === 'PLAYING' && isBoardSolved(state.board)) {
      if (winModal.style.display !== 'flex') {
        triggerWinSequence(state);
      }
    }
  }
});

// 渲染类似于 GitGraph 的全局拓扑时间轴
function renderGitGraph(state) {
  if (!gitGraphContainer) return;
  let html = '';
  const colorMain = '#1976d2';
  
  // 第1行：渲染粗壮的主干线路
  html += `
    <div style="display: flex; align-items: center; flex-shrink: 0; position: relative;">
      <div style="width: 20px; height: 20px; border-radius: 50%; background: ${colorMain}; border: 3px solid #0d47a1; z-index: 2;"></div>
      <div style="font-size: 13px; margin-left: 8px; font-weight: bold; color: ${colorMain}; white-space: nowrap;">🎯 主干盘面</div>
      <div style="flex-grow: 1; height: 4px; background: ${colorMain}; min-width: 200px; margin-left: 10px; border-radius: 2px;"></div>
    </div>
  `;
  
  // 第2-N行：渲染全房间所有正在探索的分支栈
  const activeBranches = Object.entries(state.branchStacks || {}).filter(([_, stack]) => stack && stack.length > 0);
  
  activeBranches.forEach(([pId, stack]) => {
    const pInfo = state.players[pId] || { name: '已离开玩家', color: '#999' };
    const pColor = pInfo.color;
    const isMe = pId === localPlayerId;

    html += `
      <div style="display: flex; align-items: center; position: relative; padding-left: 10px; flex-shrink: 0; margin-top: -10px;">
        <div style="position: absolute; left: 10px; top: -20px; width: 24px; height: 30px; border-left: 3px solid ${pColor}; border-bottom: 3px solid ${pColor}; border-bottom-left-radius: 8px; z-index: 1;"></div>
        <div style="display: flex; align-items: center; margin-left: 28px;">
    `;
    
    stack.forEach((layer, index) => {
      if (index > 0) {
        html += `<div style="width: 35px; height: 3px; background: ${pColor}; flex-shrink: 0;"></div>`;
      }
      const isLatest = index === stack.length - 1;
      html += `
        <div style="display: flex; flex-direction: column; align-items: center; position: relative; flex-shrink: 0; pointer-events: none;">
          <div style="width: 14px; height: 14px; border-radius: 50%; background: #fff; border: 3px solid ${pColor}; z-index: 2; box-shadow: 0 0 0 2px #fff;"></div>
          <div style="position: absolute; top: 22px; font-size: 11px; color: ${pColor}; white-space: nowrap; font-weight: ${isLatest ? 'bold' : 'normal'};">
            ${isLatest ? `👤${pInfo.name} (层${index + 1})` : `层${index + 1}`}
          </div>
        </div>
      `;
    });
    html += `</div></div>`;
  });
  
  gitGraphContainer.innerHTML = html;
  // 节点渲染完成后，平滑滚动让整体结构尽收眼底
  setTimeout(() => {
    gitGraphContainer.scrollTo({ left: 0, top: gitGraphContainer.scrollHeight, behavior: 'smooth' });
  }, 50);
}

// 将 Git 控制台的状态更新抽离
function updateBranchUI(state) {
  const stack = state.branchStacks[localPlayerId];
  const depth = stack ? stack.length : 0;
  
  // 分支有效性查重引擎：如果当前层的差异数组中完全没有内容，说明玩家还没探索，禁止套娃插旗
  let canBranch = true;
  if (depth > 0) {
    const topLayer = stack[depth - 1];
    // 只要不是全空（填入或删除-1），就代表局面发生了变动
    canBranch = topLayer.some(v => v !== null); 
  }
  
  if (depth === 0) {
    if(btnBranch) {
      btnBranch.innerText = '🚩 插旗';
      btnBranch.disabled = false;
      btnBranch.style.opacity = '1';
      btnBranch.style.cursor = 'pointer';
    }
    if(btnMerge) btnMerge.style.display = 'none';
    if(btnRevert) btnRevert.style.display = 'none';
    document.body.style.boxShadow = 'none';
  } else {
    if(btnBranch) {
      btnBranch.innerText = `🚩 嵌套插旗 (第 ${depth} 层)`;
      btnBranch.disabled = !canBranch;
      btnBranch.style.opacity = canBranch ? '1' : '0.4';
      btnBranch.style.cursor = canBranch ? 'pointer' : 'not-allowed';
      btnBranch.title = canBranch ? '在当前状态上再分化一层沙盒' : '禁止空操作：请先在当前层改变盘面再插旗';
    }
    if(btnMerge) btnMerge.style.display = 'block';
    if(btnRevert) btnRevert.style.display = 'block';
    if(btnMerge) btnMerge.innerText = depth > 1 ? '🚀 向下层合并' : '🚀 合并至主干';
    if(btnRevert) btnRevert.innerText = `🗑️ 拔旗 (层 ${depth})`;
    document.body.style.boxShadow = `inset 0 0 ${10 + depth * 8}px rgba(25, 118, 210, 0.5)`;
  }
  renderGitGraph(state); // 驱动全局动画时间轴
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