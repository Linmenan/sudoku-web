const io = require('socket.io')(3000, { cors: { origin: '*' } });

io.on('connection', (socket) => {
  socket.on('create-room', ({ roomId, nickname }) => {
    socket.join(roomId);
    socket.nickname = nickname; // 将昵称绑定到房主的 socket 实例上
    socket.emit('room-created', socket.id);
  });

  // 1. 新增：提供给加入者验证房间是否存在的接口
  socket.on('check-room', ({ roomId, nickname }, callback) => {
    const room = io.sockets.adapter.rooms.get(roomId);
    // 如果房间存在且至少有一个人（房主），则返回 true
    if (room && room.size > 0) {
      let isDuplicate = false;
      // 遍历当前房间内的所有 socket 客户端
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

  // 2. 修改：加入房间时携带昵称，并转发给房主
  socket.on('join-room', ({ roomId, nickname }) => {
    socket.join(roomId);
    socket.nickname = nickname; // 将昵称绑定到玩家的 socket 实例上
    socket.to(roomId).emit('player-joined', { id: socket.id, nickname });
  });

  socket.on('signal', ({ to, targetId, data }) => {
    io.to(to).emit('signal', { from: socket.id, data });
  });

  socket.on('disconnect', () => {
    io.emit('player-disconnected', socket.id);
  });
});