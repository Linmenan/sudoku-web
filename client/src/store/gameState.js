// client/src/store/gameState.js

// 预设玩家颜色池
const PLAYER_COLORS = ['#1976d2', '#d32f2f', '#388e3c', '#f57c00', '#7b1fa2', '#c2185b'];

export const createStore = (isHost = false, onStateChange = () => {}) => {
  let state = {
    phase: 'SETUP',
    board: Array(81).fill(null),
    locked: Array(81).fill(false),
    notes: Array(81).fill().map(() => []),
    focuses: {},
    players: {},
    cellOwners: Array(81).fill(null), // 新增：记录每个格子最后是谁填对的
  };

  // 如果是房主，初始化本地玩家
  if (isHost) {
    state.players['local'] = { name: '房主 (Host)', color: PLAYER_COLORS[0] };
  }

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

          if (value !== null && state.phase === 'PLAYING') {
            const target = getRowColGrid(index);
            for (let i = 0; i < 81; i++) {
              const current = getRowColGrid(i);
              if (current.row === target.row || current.col === target.col || current.grid === target.grid) {
                state.notes[i] = state.notes[i].filter(n => n !== value);
              }
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
        case 'ADD_PLAYER': {
          const { id } = action.payload;
          const colorCount = Object.keys(state.players).length;
          // 新增：房主名字前自动加星星
          const displayName = isHost ? `⭐ ${name}` : name;
          state.players[id] = { 
            name: displayName, 
            color: PLAYER_COLORS[colorCount % PLAYER_COLORS.length] 
          };
          break;
        }
        case 'REMOVE_PLAYER': {
          const { id } = action.payload;
          delete state.players[id];
          delete state.focuses[id];
          break;
        }
      }
      onStateChange(state);
      return state;
    }
  };
};