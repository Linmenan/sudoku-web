/*
 * @Author: yanyu yanyu1@xcmg.com
 * @Date: 2026-07-09 09:12:09
 * @LastEditors: yanyu yanyu1@xcmg.com
 * @LastEditTime: 2026-07-09 10:38:16
 * @FilePath: /sudoku-webrtc/signaling-server/server.js
 * @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
 */
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const localtunnel = require('localtunnel');
const path = require('path');
const twilio = require('twilio');

// 从环境变量中安全读取凭证
const TWILIO_SID = process.env.TWILIO_SID;
const TWILIO_TOKEN = process.env.TWILIO_TOKEN;

if (!TWILIO_SID || !TWILIO_TOKEN) {
  console.warn('⚠️ 警告: 未检测到 Twilio 环境变量，将导致 TURN 穿透降级！');
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// 关键点：让 Node.js 直接提供前端的打包页面
app.use(express.static(path.join(__dirname, '../client/dist')));

io.on('connection', (socket) => {
  // 新增：给前端下发 Twilio 动态 TURN 穿透凭证的接口
  socket.on('get-turn-credentials', async (callback) => {
    try {
      const client = twilio(TWILIO_SID, TWILIO_TOKEN);
      const token = await client.tokens.create();
      callback(token.iceServers); // 返回包含了动态账密的专属打洞节点数组
    } catch (err) {
      console.error('获取 Twilio TURN 凭证失败:', err);
      callback([{ urls: 'stun:stun.miwifi.com:3478' }, { urls: 'stun:stun.qq.com:3478' }]); // 降级方案
    }
  });

  socket.on('create-room', ({ roomId, nickname }) => {
    socket.join(roomId);
    socket.nickname = nickname; 
    socket.emit('room-created', socket.id);
  });

  socket.on('check-room', ({ roomId, nickname }, callback) => {
    const room = io.sockets.adapter.rooms.get(roomId);
    if (room && room.size > 0) {
      let isDuplicate = false;
      for (const socketId of room) {
        const s = io.sockets.sockets.get(socketId);
        if (s && s.nickname === nickname) {
          isDuplicate = true;
          break;
        }
      }
      callback({ exists: true, duplicate: isDuplicate });
    } else {
      callback({ exists: false, duplicate: false });
    }
  });

  socket.on('join-room', ({ roomId, nickname }) => {
    socket.join(roomId);
    socket.nickname = nickname; 
    socket.to(roomId).emit('player-joined', { id: socket.id, nickname });
  });

  socket.on('signal', ({ to, targetId, data }) => {
    io.to(to).emit('signal', { from: socket.id, data });
  });

  socket.on('disconnect', () => {
    io.emit('player-disconnected', socket.id);
  });
});

// 优先使用云平台注入的环境变量端口，本地运行则回退到 3000
const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  console.log(`💻 本地服务已启动: http://localhost:${PORT}`);
  
  // try {
  //   // 自动化无感穿透的核心代码
  //   console.log('⏳ 正在向外太空发射穿透信号，请求公网地址...');
  //   const tunnel = await localtunnel({ port: PORT });
    
  //   console.log('\n======================================================');
  //   console.log('🚀 互联网联机就绪！请将下方网址发给你的朋友：');
  //   console.log(`👉  ${tunnel.url}`);
  //   console.log('======================================================\n');
    
  //   tunnel.on('close', () => {
  //     console.log('⚠️ 穿透通道已关闭');
  //   });
  // } catch (err) {
  //   console.error('❌ 穿透失败，请检查网络或稍后重试:', err);
  // }
});