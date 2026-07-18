// client/src/store/gameState.js

// 预设玩家颜色池
const PLAYER_COLORS = ['#1976d2', '#d32f2f', '#388e3c', '#f57c00', '#7b1fa2', '#c2185b'];

export const createStore = (onStateChange = () => {}) => {
  let state = {
    phase: 'SETUP',
    board: Array(81).fill(null),
    locked: Array(81).fill(false),
    notes: Array(81).fill().map(() => []),
    focuses: {},
    players: {},
    cellOwners: Array(81).fill(null),
    chatMessages: [], // 新增：保存房间聊天记录
    checkedCells: Array(81).fill(false), // 新增：保存单元格检查标记
    branchStacks: {}, // 新增：支持多级嵌套分支的栈架构 { playerId: [layer1, layer2, ...] }
    gameStartTime: null, // 新增：游戏开始时间戳
    gameEndTime: null, // 新增：游戏结束时间戳
  };

  const getRowColGrid = (index) => {
    const row = Math.floor(index / 9);
    const col = index % 9;
    const grid = Math.floor(row / 3) * 3 + Math.floor(col / 3);
    return { row, col, grid };
  };

  return {
    getState: () => state,
    setState: (newState) => {
      state = newState;
      onStateChange(state);
    },
    dispatch: (action, fromPlayerId = 'local') => {
      switch (action.type) {
        case 'FILL_NUM': {
          const { index, value } = action.payload;
          if (state.phase === 'PLAYING' && state.locked[index]) break;
          
          // 多级分支拦截引擎：若存在分支栈，则将操作压入最顶层的私有图层
          if (state.branchStacks[fromPlayerId] && state.branchStacks[fromPlayerId].length > 0) {
             const stack = state.branchStacks[fromPlayerId];
             const topLayer = stack[stack.length - 1];
             const branchVal = value === null ? -1 : value; // 用 -1 作为删除的墓碑标记，以遮蔽父层数据
             if (topLayer[index] === branchVal) break;
             topLayer[index] = branchVal;
             break;
          }

          if (state.board[index] === value) break; 
          
          state.board[index] = value;
          state.checkedCells[index] = false;
          if (state.phase === 'PLAYING') {
            state.cellOwners[index] = value !== null ? fromPlayerId : null;
          }
          break;
        }
        case 'CREATE_BRANCH': {
          // 插旗：推入一个新的透明图层
          if (!state.branchStacks[fromPlayerId]) state.branchStacks[fromPlayerId] = [];
          state.branchStacks[fromPlayerId].push(Array(81).fill(null));
          break;
        }
        case 'REVERT_BRANCH': {
          // 拔旗：弹出最顶层的图层，丢弃当层尝试
          if (state.branchStacks[fromPlayerId] && state.branchStacks[fromPlayerId].length > 0) {
            state.branchStacks[fromPlayerId].pop();
            if (state.branchStacks[fromPlayerId].length === 0) {
              delete state.branchStacks[fromPlayerId];
            }
          }
          break;
        }
        case 'SQUASH_BRANCH': {
          // 向下合并：将最顶层图层压缩合并到它的父图层中（无冲突合并）
          const stack = state.branchStacks[fromPlayerId];
          if (stack && stack.length > 1) {
            const topLayer = stack.pop();
            const parentLayer = stack[stack.length - 1];
            for (let i = 0; i < 81; i++) {
              if (topLayer[i] !== null) parentLayer[i] = topLayer[i];
            }
          }
          break;
        }
        case 'COMMIT_MERGE': {
          // 最终合并至主干
          const { diffs } = action.payload;
          diffs.forEach(({ index, value }) => {
            if (!state.locked[index]) {
              const finalVal = value === -1 ? null : value;
              state.board[index] = finalVal;
              state.checkedCells[index] = false;
              state.cellOwners[index] = finalVal !== null ? fromPlayerId : null;
            }
          });
          // 并入主干后，销毁仅存的最后一层分支
          if (state.branchStacks[fromPlayerId]) {
            state.branchStacks[fromPlayerId].pop();
            if (state.branchStacks[fromPlayerId].length === 0) {
              delete state.branchStacks[fromPlayerId];
            }
          }
          break;
        }
        case 'TOGGLE_NOTE': {
          const { index, value } = action.payload;
          if (state.board[index] !== null) break; // 已填入大数字，不能加备注
          const noteArr = state.notes[index];
          state.notes[index] = noteArr.includes(value) 
            ? noteArr.filter(n => n !== value) 
            : [...noteArr, value].sort();
          break;
        }
        case 'CLEAR_CELL_NOTES': {
          const { index } = action.payload;
          // 只有在没有大数字的情况下，才允许清空其底层维护的备注数组
          if (state.board[index] === null) {
            state.notes[index] = [];
          }
          break;
        }
        case 'TOGGLE_CHECK_CELL': {
          const { index } = action.payload;
          // 仅允许在游戏中、非锁定谜题初始格子，且该格子内部有填入大数字时进行标记翻转
          if (state.phase === 'PLAYING' && !state.locked[index] && state.board[index] !== null) {
            state.checkedCells[index] = !state.checkedCells[index];
          }
          break;
        }
        case 'UPDATE_FOCUS': {
          const { index } = action.payload;
          if (index === null) {
            delete state.focuses[fromPlayerId]; // 如果传入 null，移除该玩家的焦点
          } else {
            state.focuses[fromPlayerId] = index;
          }
          break;
        }
        case 'LOCK_PUZZLE': {
          state.board.forEach((val, i) => { if (val !== null) state.locked[i] = true; });
          state.phase = 'PLAYING';
          state.gameStartTime = Date.now();
          state.gameEndTime = null;
          break;
        }
        case 'SET_END_TIME': {
          if (!state.gameEndTime) {
            state.gameEndTime = action.payload.time;
          }
          break;
        }
        case 'CLEAR_BOARD': {
          if (state.phase === 'SETUP') {
            state.board.fill(null);
            state.notes.forEach(note => note.length = 0);
            state.checkedCells.fill(false);
            state.branchStacks = {};
          }
          break;
        }
        case 'SET_BOARD': {
          // 用于批量将算法生成的题目载入状态
          if (state.phase === 'SETUP') {
            const { newBoard } = action.payload;
            state.board = [...newBoard];
            state.notes.forEach(note => note.length = 0);
            state.checkedCells.fill(false);
            state.branchStacks = {};
          }
          break;
        }
        case 'ADD_PLAYER': {
          const { id, name, isHost } = action.payload;
          const displayName = isHost ? `⭐ ${name}` : name;
          // 修复：如果玩家已存在，只更新名字（例如加星星），不重新计算并覆盖颜色
          if (!state.players[id]) {
            // 核心修复：动态分配未被使用的颜色，防止人员退出重进导致 length 变化而发生颜色撞车冲突
            const usedColors = Object.values(state.players).map(p => p.color);
            let assignedColor = PLAYER_COLORS.find(color => !usedColors.includes(color));
            
            // 兜底：如果房间人数超过了预设颜色池的上限（全部被占用），则回退使用人数取模方案
            if (!assignedColor) {
              const colorCount = Object.keys(state.players).length;
              assignedColor = PLAYER_COLORS[colorCount % PLAYER_COLORS.length];
            }
            
            state.players[id] = { 
              name: displayName, 
              color: assignedColor,
              isOnline: true // 新增：标记玩家为在线状态
            };
          } else {
            state.players[id].name = displayName;
            state.players[id].isOnline = true; // 新增：断线重连时恢复在线状态
          }
          break;
        }
        case 'REMOVE_PLAYER': {
          const { id } = action.payload;
          delete state.players[id];
          delete state.focuses[id];
          break;
        }
        case 'PLAYER_OFFLINE': {
          const { id } = action.payload;
          if (state.players[id]) {
            state.players[id].isOnline = false; // 软删除：标记为离线
          }
          delete state.focuses[id]; // 物理清除其在棋盘上的焦点框
          break;
        }
        case 'SEND_CHAT': {
          const { id, text } = action.payload;
          if (state.players[id] && text.trim()) {
            state.chatMessages.push({
              playerId: id,
              text: text.trim().substring(0, 50),
              id: Math.random().toString(36).substr(2, 9) // 唯一标识符，方便前端查重渲染
            });
            // 限制最大消息数，防止内存泄漏和同步包过大
            if (state.chatMessages.length > 50) {
              state.chatMessages.shift();
            }
          }
          break;
        }
      }
      onStateChange(state);
      return state;
    }
  };
};