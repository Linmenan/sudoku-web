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
 * 验证当前盘面是否有唯一解
 * @param {Array} boardArr 长度为 81 的一维数组 (null 表示空)
 * @returns {number} 0(无解), 1(唯一解), 2(多解)
 */
export function countSolutions(boardArr) {
  // return 1;
  let solutions = 0;
  // 将一维数组转换为 9x9 二维数组，方便逻辑判断
  let board = [];
  for (let i = 0; i < 9; i++) {
    board.push(boardArr.slice(i * 9, i * 9 + 9));
  }

  // 检查在 (r, c) 填入 val 是否合法 (同行列宫无重复)
  function isValid(r, c, val) {
    for (let i = 0; i < 9; i++) {
      if (board[r][i] === val || board[i][c] === val) return false;
    }
    let startRow = Math.floor(r / 3) * 3;
    let startCol = Math.floor(c / 3) * 3;
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        if (board[startRow + i][startCol + j] === val) return false;
      }
    }
    return true;
  }

  // 回溯求解核心函数
  function solve(r, c) {
    if (r === 9) {
      solutions++;
      return;
    }
    // 剪枝：如果已经找到 2 个解，说明不唯一，直接终止
    if (solutions > 1) return; 

    let nextR = c === 8 ? r + 1 : r;
    let nextC = c === 8 ? 0 : c + 1;

    if (board[r][c] !== null) {
      solve(nextR, nextC);
    } else {
      for (let v = 1; v <= 9; v++) {
        if (isValid(r, c, v)) {
          board[r][c] = v;
          solve(nextR, nextC);
          board[r][c] = null; // 回溯恢复状态
        }
      }
    }
  }

  // 首先检查当前已有数字是否冲突 (防止房主出题本身就是错的)
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      let val = board[r][c];
      if (val !== null) {
        board[r][c] = null;
        if (!isValid(r, c, val)) return 0; // 初始盘面就冲突，必然无解
        board[r][c] = val;
      }
    }
  }

  solve(0, 0);
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

  // 2. 根据难度确定需要挖空的格子数量（从指定区间内随机抽取）
  let removeCount;
  if (difficulty === 'easy') {
    removeCount = Math.floor(Math.random() * (40 - 35 + 1)) + 35; // [35, 40]
  } else if (difficulty === 'hard') {
    removeCount = Math.floor(Math.random() * (60 - 55 + 1)) + 55; // [55, 60]
  } else if (difficulty === 'nightmare') {
    removeCount = 64; // [64] 人类已知的数独极限，只留17个数字且具备唯一解
  } else {
    removeCount = Math.floor(Math.random() * (50 - 45 + 1)) + 45; // 默认 medium [45, 50]
  }

  // 3. 随机挖空并验证唯一解
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