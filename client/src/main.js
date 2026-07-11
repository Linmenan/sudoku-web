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

const virtualKeyboard = document.getElementById('virtualKeyboard');
const vkModeToggle = document.getElementById('vkModeToggle');
const isPrivateCheck = document.getElementById('isPrivateCheck');
const passwordInput = document.getElementById('passwordInput');

// 绑定私密房间勾选框的显隐逻辑
isPrivateCheck.addEventListener('change', (e) => {
  passwordInput.style.display = e.target.checked ? 'inline-block' : 'none';
});

// 核心修改：生成并持久化本地的 UUID 作为永久身份凭证 (Session 固化)
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

// 核心修复：立即为本地玩家赋予合法席位，这样在 SETUP（出题）模式下才能分配专属颜色和渲染焦点框
store.dispatch({ type: 'ADD_PLAYER', payload: { id: localPlayerId, name: '我', isHost: false } });

// 核心修复：动态创建纯文本房间信息 UI，彻底替代冻结的冗余输入框，防止报找不到 DOM 的错
function showRoomInfoUI(roomId, nickname, password, isHost) {
  let infoDiv = document.getElementById('roomInfoDisplay');
  if (!infoDiv) {
    infoDiv = document.createElement('div');
    infoDiv.id = 'roomInfoDisplay';
    infoDiv.style.cssText = 'padding: 10px; background: #e3f2fd; border-radius: 8px; width: 100%; max-width: 600px; box-sizing: border-box; font-size: 15px; color: #1565c0; margin-bottom: 10px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px;';
    document.getElementById('controls').insertBefore(infoDiv, document.getElementById('winModal'));
  }
  
  // 核心修复：无论该节点是新建的还是 HTML 页面静态自带的，都必须强制将其显现出来
  infoDiv.style.display = 'flex';

  const role = isHost ? '👑 房主' : '👤 玩家';
  const pwdText = password ? `<span style="color:#d32f2f">🔒 密码: ${password}</span>` : `<span style="color:#388e3c">🔓 公开房间</span>`;
  infoDiv.innerHTML = `<div><strong>${role}:</strong> ${nickname} &nbsp;&nbsp; <strong>🏠 房间号:</strong> ${roomId} &nbsp;&nbsp; ${pwdText}</div>`;
  
  // 大扫除：隐藏所有碍眼的交互控件
  document.getElementById('nicknameInput').style.display = 'none';
  document.getElementById('roomIdInput').style.display = 'none';
  const isPrivateCheck = document.getElementById('isPrivateCheck');
  if (isPrivateCheck) isPrivateCheck.parentElement.style.display = 'none';
  const pwdInput = document.getElementById('passwordInput');
  if (pwdInput) pwdInput.style.display = 'none';
  document.getElementById('btnCreate').style.display = 'none';
  document.getElementById('btnJoin').style.display = 'none';
  document.getElementById('btnLeave').style.display = 'inline-block';
  if (isHost) document.getElementById('btnLeave').innerText = '解散房间';
}

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

  if (isNoteMode) {
    if (isValidNum) {
      // 备注模式下：如果输入数字，利用底层的 Toggle 机制，已存在则物理删除，不存在则添加
      executeAction({ type: 'TOGGLE_NOTE', payload: { index: focusedIndex, value: num } });
    } else if (isDelete) {
      // 备注模式下：按删除键仅物理清空该格子的所有备注
      executeAction({ type: 'CLEAR_CELL_NOTES', payload: { index: focusedIndex } });
    }
  } else {
    // 正常模式（大数字填入模式）
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

  // 新增：提取当前本地客户端玩家所聚焦的单元格数字（用于纯本地的高亮，不影响他人）
  const localFocusedIndex = state.focuses[localPlayerId];
  const highlightedNum = (localFocusedIndex !== undefined && localFocusedIndex !== null) ? state.board[localFocusedIndex] : null;

  const cells = document.querySelectorAll('.cell');
  cells.forEach((cell, index) => {
    let className = 'cell';
    if (index % 9 === 2 || index % 9 === 5) className += ' border-right-thick';
    if (Math.floor(index / 9) === 2 || Math.floor(index / 9) === 5) className += ' border-bottom-thick';
    if (state.locked[index]) className += ' locked';
    
    // 如果当前单元格内填写的数字与本地玩家正在聚焦的数字相同（排除空置格子），则挂载光效类名
    if (highlightedNum !== null && state.board[index] === highlightedNum) {
      className += ' number-highlight';
    }
    
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
  let serverUrl = 'http://localhost:3000';
  const host = window.location.hostname;
  
  // 完全脱离 UI，通过当前域名智能推断 WebSocket 地址
  if ((host !== 'localhost' && host !== '127.0.0.1') || window.location.port !== '5173') {
    const isPublicNetwork = host.includes('.') && !host.match(/^\d+\.\d+\.\d+\.\d+$/) && host !== 'localhost' && host !== '127.0.0.1';
    const protocol = isPublicNetwork ? 'https:' : window.location.protocol;
    serverUrl = `${protocol}//${window.location.host}`;
  }

  console.log(`[Socket] 尝试连接信令服务器: ${serverUrl}`);
  const socket = io(serverUrl, {
    reconnectionAttempts: 3,
    timeout: 5000,
    transports: ['websocket'],
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
  const password = isPrivateCheck.checked ? passwordInput.value : null;

  if (isPrivateCheck.checked && !password) {
    alert('⚠️ 既然勾选了私密房间，请在旁边输入框中填写房间密码！');
    return;
  }
  
  console.log(`[Host] 正在创建房间... 房间号: ${roomId}, 昵称: ${nickname}`);
  const socket = createSocketConnection();
  
  socket.on('connect', () => {
    socket.emit('get-turn-credentials', (iceServers) => {
      console.log('[WebRTC] 🔑 云端下发的 ICE 凭证内容:', iceServers);
      
      store.dispatch({ type: 'LOCK_PUZZLE' }); 
      store.dispatch({ type: 'ADD_PLAYER', payload: { id: localPlayerId, name: nickname, isHost: true } });
      
      // 将动态凭证、身份凭证以及鉴权密码一并注入底层 (公开房 password 为 null)
      networkManager = new HostPeerManager(roomId, socket, store, nickname, { iceServers }, localPlayerId, password);
      
      setupPanel.style.display = 'none';
      showRoomInfoUI(roomId, nickname, password, true);
    });
  });
});

btnJoin.addEventListener('click', () => {
  const roomId = roomIdInput.value || 'test-room';
  const nickname = nicknameInput.value || '玩家';
  const password = isPrivateCheck.checked ? passwordInput.value : null;
  
  console.log(`[Guest] 尝试加入房间... 房间号: ${roomId}, 昵称: ${nickname}`);
  const socket = createSocketConnection();

  // 新增：监听房主迁移广播
  socket.on('host-migrated', ({ newHostSocketId, gameState }) => {
    console.log(`[Migration] 🔄 收到房主变更广播！新房主 Socket ID: ${newHostSocketId}`);
    
    // 1. 增加 try-catch 护城河：防止由于底层连接状态不匹配抛错导致整个 JS 线程挂掉
    if (networkManager) {
      try {
        if (networkManager.pc) networkManager.pc.close();
        if (networkManager.channel) networkManager.channel.close();
      } catch (err) {
        console.warn(`[Migration] ⚠️ 清理旧底层连接时忽略异常:`, err);
      }
    }

    // 核心修复：立即强行卸载掉 Socket 上的旧 WebRTC 业务监听器（signal 和 relay-action），
    // 避免在重新建立 P2P 物理连接的 1.5 秒缓冲期内，旧的回调函数还在并发响应导致串台或报状态错误。
    socket.off('signal');
    socket.off('relay-action');

    // 2. 核心清洗：从玩家列表中【彻底物理删除】已经退出的老房主（即名字中包含 ⭐ 的旧用户数据），
    // 同时清理焦点框。这样彻底杜绝了“幽灵玩家残留”和“双星共存”的界面崩坏现象！
    Object.keys(gameState.players).forEach(pId => {
      if (gameState.players[pId].name.includes('⭐')) {
        delete gameState.players[pId];
        delete gameState.focuses[pId];
      }
    });

    const currentPwd = isPrivateCheck.checked ? passwordInput.value : null;

    if (socket.id === newHostSocketId) {
      console.log(`[Migration] 👑 临危受命！我已被提拔为新房主！接管整个盘面...`);
      // 同步最终盘面，防止房主退出时的微小数据差
      store.setState(gameState);
      store.dispatch({ type: 'ADD_PLAYER', payload: { id: localPlayerId, name: nickname, isHost: true } });
      
      // 华丽转身，重新实例化为房主网络管理器 (无缝继承原有的 TURN 凭证和固化身份)
      networkManager = new HostPeerManager(roomId, socket, store, nickname, networkManager.iceConfig, localPlayerId);
      
      // 核心修复：身份转变后，必须重新调用渲染更新，确保顶部房间状态 UI 为最新且可见
      showRoomInfoUI(roomId, nickname, currentPwd, true);
    } else {
      console.log(`[Migration] 🔌 房主已易主，准备向新房主重新发起连接...`);
      // 提前应用洗净的盘面，避免等待的 1.5 秒内画面闪烁
      store.setState(gameState);
      
      // 延迟 1.5 秒，给新房主创建 RTCPeerConnection 容器的缓冲时间
      setTimeout(() => {
        networkManager = new GuestPeerManager(roomId, socket, store, nickname, networkManager.iceConfig, localPlayerId);
        // 核心修复：确保玩家在重新建立连接期间，其顶部的房间及密码信息依然挂载显示
        showRoomInfoUI(roomId, nickname, currentPwd, false);
      }, 1500);
    }
  });
  
  socket.on('connect', () => {
    console.log(`[Guest] 开始校验房间状态...`);
    // 附带本地固化的身份，并带上输入框中的密码进行鉴权请求
    socket.emit('check-room', { roomId, nickname, playerId: localPlayerId, password }, (response) => {
      console.log(`[Guest] 收到的房间校验结果:`, response);
      
      if (!response.exists) {
        console.error(`[Guest] ❌ 房间校验失败: 房间不存在！`);
        alert('❌ 房间不存在或房主已离开，请检查房间号！');
        socket.disconnect();
        return;
      }
      if (response.authFailed) {
        console.error(`[Guest] ❌ 房间鉴权失败: 密码错误或未提供密码！`);
        alert('🔒 加入失败：房间密码错误，或该房间为私密房间！\n如果这是私密房间，请勾选"私密"并输入正确密码。');
        socket.disconnect();
        return;
      }
      if (response.duplicate) {
        console.error(`[Guest] ❌ 房间校验失败: 昵称重复！`);
        alert('❌ 该昵称已被房间内的玩家使用，请换一个昵称！');
        socket.disconnect();
        return;
      }

      console.log(`[Guest] ✅ 房间校验通过，正在请求动态 TURN 凭证...`);
      socket.emit('get-turn-credentials', (iceServers) => {
        console.log('[WebRTC] 🔑 云端下发的 ICE 凭证内容:', iceServers);
        
        // 核心修复：如果是断线重连触发的 connect，彻底断开旧的底层 WebRTC 防止 InvalidStateError
        if (networkManager && networkManager.pc) {
          networkManager.pc.close();
        }
        
        // 如果是初次加入，则重置 store；若是断线重连，千万不要重置（保留之前的盘面状态）
        if (!networkManager) {
          store = createStore((s) => renderBoard(s)); // 移除了废弃的 isHost 参数
        }

        // 不再使用转瞬即逝的 socket.id，而是注入本地固化的 localPlayerId
        networkManager = new GuestPeerManager(roomId, socket, store, nickname, { iceServers }, localPlayerId); 
        store.dispatch({ type: 'ADD_PLAYER', payload: { id: localPlayerId, name: nickname, isHost: false } });
  
        setupPanel.style.display = 'none';
        showRoomInfoUI(roomId, nickname, password, false);
      });
    });
  });
});

btnLeave.addEventListener('click', () => {
  if (confirm('确定要退出当前房间吗？')) {
    // 房主迁移逻辑
    if (networkManager && networkManager.peers) {
      const peers = Object.keys(networkManager.peers);
      if (peers.length > 0) {
        // 挑选网络最好的玩家接盘（优先选择直连、没有走降级中继的玩家）
        let newHostSocketId = peers[0];
        for (const socketId of peers) {
          if (!networkManager.peers[socketId].isRelayMode) {
            newHostSocketId = socketId;
            break;
          }
        }
        console.log(`[Migration] 👑 房主主动退出，正在移交权限给玩家 Socket: ${newHostSocketId}`);
        
        // 核心修复：改用服务器安全Ack回调。只有当服务器明确回复“已接收迁移数据并转发”后，老房主才执行 reload 刷新。
        // 这彻底消除了固定 300ms 盲目延迟导致的信令还没发完网络就断开的“随机卡死”惊悚 Bug！
        networkManager.socket.emit('migrate-host', {
          roomId: roomIdInput.value || 'test-room',
          newHostSocketId: newHostSocketId,
          gameState: store.getState()
        }, () => {
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