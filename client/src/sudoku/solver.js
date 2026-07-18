/*
 * @Author: yanyu yanyu1@xcmg.com
 * @Date: 2026-07-08 15:23:30
 * @LastEditors: yanyu yanyu1@xcmg.com
 * @LastEditTime: 2026-07-11 14:55:09
 * @FilePath: /sudoku-webrtc/client/src/sudoku/solver.js
 * @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
 */
// client/src/sudoku/solver.js

/**
 * 验证当前盘面是否有唯一解 (极速版：位运算 + MRV启发式搜索)
 * @param {Array} boardArr 长度为 81 的一维数组 (null 表示空)
 * @returns {number} 0(无解), 1(唯一解), 2(多解)
 */
export function countSolutions(boardArr) {
  let solutions = 0;
  let board = [];
  for (let i = 0; i < 9; i++) {
    board.push(boardArr.slice(i * 9, i * 9 + 9));
  }

  // 预处理行、列、宫的二进制位图掩码 (用于极速判断合法性)
  let rowMask = new Array(9).fill(0);
  let colMask = new Array(9).fill(0);
  let boxMask = new Array(9).fill(0);
  let emptyCells = 0;

  // 1. 初始化状态并检测初始盘面是否本身就冲突
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      let val = board[r][c];
      if (val !== null) {
        let bit = 1 << val;
        let boxIdx = Math.floor(r / 3) * 3 + Math.floor(c / 3);
        
        // 如果当前数字与同行、同列或同宫已有数字冲突
        if ((rowMask[r] & bit) || (colMask[c] & bit) || (boxMask[boxIdx] & bit)) {
          return 0; 
        }
        // 记录该数字已被使用
        rowMask[r] |= bit;
        colMask[c] |= bit;
        boxMask[boxIdx] |= bit;
      } else {
        emptyCells++;
      }
    }
  }

  // 2. 核心求解：MRV 启发式搜索
  function solve(remains) {
    if (remains === 0) {
      solutions++;
      return;
    }
    if (solutions > 1) return; // 剪枝：超过 1 个解立刻停止

    let minOptions = 10;
    let bestR = -1, bestC = -1, bestBox = -1;
    let bestMask = 0;

    // 每次都找出当前剩余可选数字最少的格子 (Minimum Remaining Values)
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        if (board[r][c] === null) {
          let boxIdx = Math.floor(r / 3) * 3 + Math.floor(c / 3);
          // 计算当前格子已经被占用的数字掩码 (1表示不可用)
          let used = rowMask[r] | colMask[c] | boxMask[boxIdx];
          
          // 统计这个格子还能填几个数字
          let options = 0;
          for (let v = 1; v <= 9; v++) {
            if ((used & (1 << v)) === 0) options++;
          }

          if (options === 0) return; // 遇到死胡同，此路不通，立刻回溯

          if (options < minOptions) {
            minOptions = options;
            bestR = r;
            bestC = c;
            bestBox = boxIdx;
            bestMask = used;
            // 极致剪枝：如果只有1个选择，不用再找其他格子了，直接锁定它
            if (options === 1) break; 
          }
        }
      }
      if (minOptions === 1) break; 
    }

    // 在找到的“最紧迫”的格子上尝试填数
    for (let v = 1; v <= 9; v++) {
      let bit = 1 << v;
      if ((bestMask & bit) === 0) { // 如果该数字可用
        // 填入状态
        board[bestR][bestC] = v;
        rowMask[bestR] |= bit;
        colMask[bestC] |= bit;
        boxMask[bestBox] |= bit;

        solve(remains - 1);

        // 回溯恢复状态
        board[bestR][bestC] = null;
        rowMask[bestR] &= ~bit;
        colMask[bestC] &= ~bit;
        boxMask[bestBox] &= ~bit;
      }
    }
  }

  solve(emptyCells);
  return solutions;
}

/**
 * 验证 81 宫格是否已经全部填满且正确无冲突
 * @param {Array} boardArr 长度为 81 的一维数组
 */
export function isBoardSolved(boardArr) {
  if (boardArr.includes(null)) return false; // 还有空没填完

  for (let i = 0; i < 9; i++) {
    let row = new Set(), col = new Set(), grid = new Set();
    for (let j = 0; j < 9; j++) {
      row.add(boardArr[i * 9 + j]);
      col.add(boardArr[j * 9 + i]);
      const r = Math.floor(i / 3) * 3 + Math.floor(j / 3);
      const c = (i % 3) * 3 + (j % 3);
      grid.add(boardArr[r * 9 + c]);
    }
    // 如果任意行列宫去重后不足9个，说明有重复数字，填错了
    if (row.size !== 9 || col.size !== 9 || grid.size !== 9) return false;
  }
  return true;
}

/**
 * 随机生成数独谜题
 * @param {string} difficulty 'easy', 'medium', 'hard'
 * @returns {Array} 长度为 81 的一维数组
 */
export function generateSudoku(difficulty) {
  let board = Array(81).fill(null);

  // 内部验证函数（基于一维数组）
  function isValidForGen(r, c, val) {
    for (let i = 0; i < 9; i++) {
      if (board[r * 9 + i] === val || board[i * 9 + c] === val) return false;
    }
    let startRow = Math.floor(r / 3) * 3;
    let startCol = Math.floor(c / 3) * 3;
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        if (board[(startRow + i) * 9 + (startCol + j)] === val) return false;
      }
    }
    return true;
  }

  // 深度优先回溯填充一个完整的合法终盘
  function fillBoard(index) {
    if (index === 81) return true;
    let r = Math.floor(index / 9);
    let c = index % 9;
    
    // 随机打乱 1-9 的尝试顺序，保证每次生成的终盘都不同
    let nums = [1, 2, 3, 4, 5, 6, 7, 8, 9].sort(() => Math.random() - 0.5);
    for (let v of nums) {
      if (isValidForGen(r, c, v)) {
        board[index] = v;
        if (fillBoard(index + 1)) return true;
        board[index] = null;
      }
    }
    return false;
  }

  // 1. 生成完整合法终盘
  fillBoard(0);

  // 2. 拦截噩梦难度：使用等价态同构变换（Isomorphic Transformation）秒级生成 64 空唯一解
  if (difficulty === 'nightmare') {
    // 西澳大学 Gordon Royle 教授收集的 17 提示数经典种子库中抽样几个不同构型
    const seedLibrary = [
      [ // 构型 A
        0,0,0, 0,0,0, 0,1,0,
        4,0,0, 0,0,0, 0,0,0,
        0,2,0, 0,0,0, 0,0,0,
        0,0,0, 0,5,0, 4,0,7,
        0,0,8, 0,0,0, 3,0,0,
        0,0,1, 0,9,0, 0,0,0,
        3,0,0, 4,0,0, 2,0,0,
        0,5,0, 1,0,0, 0,0,0,
        0,0,0, 8,0,6, 0,0,0
      ],
      [ // 构型 B
        0,0,0, 0,0,0, 0,1,0,
        0,0,0, 0,0,2, 0,0,3,
        0,0,0, 4,0,0, 0,0,0,
        0,0,0, 0,0,0, 5,0,0,
        4,0,1, 6,0,0, 0,0,0,
        0,0,7, 1,0,0, 0,0,0,
        0,5,0, 0,0,0, 2,0,0,
        0,0,0, 0,8,0, 0,4,0,
        0,3,0, 9,1,0, 0,0,0
      ],
      [ // 构型 C
        0,0,0, 7,0,0, 0,0,0,
        1,0,0, 0,0,0, 0,0,0,
        0,0,0, 4,3,0, 2,0,0,
        0,0,0, 0,0,0, 0,0,6,
        0,0,0, 5,0,9, 0,0,0,
        0,0,0, 0,0,0, 4,1,8,
        0,0,0, 0,8,1, 0,0,0,
        0,0,2, 0,0,0, 0,5,0,
        0,4,0, 0,0,0, 3,0,0
      ],
      [ // 构型 D
        0,0,0, 0,0,0, 0,1,2,
        0,0,0, 0,3,5, 0,0,0,
        0,0,0, 6,0,0, 0,7,0,
        7,0,0, 0,0,0, 3,0,0,
        0,0,0, 4,0,0, 8,0,0,
        1,0,0, 0,0,0, 0,0,0,
        0,0,0, 1,2,0, 0,0,0,
        0,8,0, 0,0,0, 0,4,0,
        0,5,0, 0,0,0, 6,0,0
      ]
    ];
    
    // 从种子库中随机抽取一个构型作为母版
    const seed17 = seedLibrary[Math.floor(Math.random() * seedLibrary.length)];
    
    // 2.1 代数映射：打乱 1-9 的数字分配
    const nums = [1, 2, 3, 4, 5, 6, 7, 8, 9].sort(() => Math.random() - 0.5);
    const numMap = [0, ...nums]; 
    
    // 2.2 几何变换：随机旋转角度与镜像翻转
    const rotate = Math.floor(Math.random() * 4); // 0, 1(90°), 2(180°), 3(270°)
    const flip = Math.random() > 0.5;
    
    const nightmareBoard = Array(81).fill(null);
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        const val = seed17[r * 9 + c];
        if (val !== 0) {
          let newR = r;
          let newC = c;
          // 旋转坐标计算
          for(let k = 0; k < rotate; k++) {
            const temp = newR;
            newR = newC;
            newC = 8 - temp;
          }
          // 镜像坐标计算
          if (flip) newC = 8 - newC;
          
          nightmareBoard[newR * 9 + newC] = numMap[val];
        }
      }
    }
    return nightmareBoard;
  }

  // 3. 常规难度：动态划定需要挖空的格子数量
  let removeCount;
  if (difficulty === 'easy') {
    removeCount = Math.floor(Math.random() * (40 - 35 + 1)) + 35; // [35, 40]
  } else if (difficulty === 'hard') {
    removeCount = Math.floor(Math.random() * (60 - 55 + 1)) + 55; // [55, 60]
  } else {
    removeCount = Math.floor(Math.random() * (50 - 45 + 1)) + 45; // [45, 50]
  }

  // 4. 随机挖空并验证唯一解 (常规回溯挖坑法)
  let indices = Array.from({ length: 81 }, (_, i) => i).sort(() => Math.random() - 0.5);
  for (let i of indices) {
    if (removeCount <= 0) break;
    
    let temp = board[i];
    board[i] = null; // 尝试挖空
    
    // 验证挖空后是否有唯一解
    if (countSolutions(board) !== 1) {
      board[i] = temp; // 出现多解，说明该线索不可省略，将其恢复
    } else {
      removeCount--; // 成功挖空且保证唯一解
    }
  }
  
  return board;
}