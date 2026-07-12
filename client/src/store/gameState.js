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
          // 如果填入的值和原来一样，不执行任何操作（避免重复触发）
          if (state.board[index] === value) break; 
          
          state.board[index] = value;

          // 核心机制：记录盘面贡献者
          if (state.phase === 'PLAYING') {
            state.cellOwners[index] = value !== null ? fromPlayerId : null;
          }

          // 移除填入数字时对关联单元格 notes 数组的物理删除。
          // 改在前端 renderBoard 时动态计算冲突来临时隐藏，从而实现当数字被删除时，原笔记会自动恢复。
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
          break;
        }
        case 'CLEAR_BOARD': {
          if (state.phase === 'SETUP') {
            state.board.fill(null);
            state.notes.forEach(note => note.length = 0);
          }
          break;
        }
        case 'SET_BOARD': {
          // 用于批量将算法生成的题目载入状态
          if (state.phase === 'SETUP') {
            const { newBoard } = action.payload;
            state.board = [...newBoard];
            state.notes.forEach(note => note.length = 0);
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
      }
      onStateChange(state);
      return state;
    }
  };
};