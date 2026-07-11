/*
 * @FilePath: /client/src/webrtc/HostPeer.js
 */
export class HostPeerManager {
  constructor(roomId, socket, store, nickname, iceConfig = { 
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun.miwifi.com:3478' },
      { urls: 'stun:stun.qq.com:3478' },
      { urls: 'stun:stun.chat.bilibili.com:3478' },
      { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' }
    ] 
  }, hostPlayerId, password) { // 新增 password 鉴权参数
    this.roomId = roomId;
    this.socket = socket;
    this.store = store;
    this.nickname = nickname;
    this.iceConfig = iceConfig;
    this.hostPlayerId = hostPlayerId;
    this.password = password; // 可能为 null (公开), string (私密), 或 undefined (迁移时)
    this.peers = {};

    // 核心修复：清除由于角色转换或断线重连导致的旧监听器
    this.socket.off('relay-action');
    this.socket.off('player-joined');
    this.socket.off('signal');
    this.socket.off('player-disconnected');

    console.log(`[WebRTC-Host] 👑 房主网络管理器已启动，房间号: ${this.roomId}`);
    this.initSignaling();
  }

  initSignaling() {
    const payload = { roomId: this.roomId, nickname: this.nickname };
    if (this.password !== undefined) payload.password = this.password;
    this.socket.emit('create-room', payload);

    // 监听来自降级 Guest 的中继请求
    this.socket.on('relay-action', ({ from, action }) => {
      if (this.peers[from]) {
        // 核心修复：强制放行！只要收到 Guest 被迫发送的中继请求，立刻为其激活服务器中继，解决玩家无法操作的 Bug！
        this.peers[from].isRelayMode = true; 
        const realPlayerId = this.peers[from].playerId || from; 
        const updatedState = this.store.dispatch(action, realPlayerId);
        this.broadcast({ type: 'SYNC', payload: updatedState });
      }
    });

    this.socket.on('player-joined', async ({ socketId, playerId, nickname }) => {
      console.log(`[WebRTC-Host] 🔔 收到玩家加入通知! 玩家: ${nickname} (SocketID: ${socketId}, PlayerID: ${playerId})`);
      
      // 核心修改：使用固化的业务身份 playerId，即使重连，之前 gameState 里的颜色和积分也会无缝继承！
      this.store.dispatch({ type: 'ADD_PLAYER', payload: { id: playerId, name: nickname, isHost: false } });
      this.broadcast({ type: 'SYNC', payload: this.store.getState() });
      
      try {
        const pc = new RTCPeerConnection(this.iceConfig);
        console.log(`[WebRTC-Host] 🛠️ 已为玩家 ${nickname} 创建 RTCPeerConnection`);
        
        const iceQueue = []; 
        
        // 核心修复：设置 5 秒强制降级超时。避免 WebRTC 卡在 checking 状态导致玩家无法操作
        const fallbackTimer = setTimeout(() => {
          if (pc.iceConnectionState !== 'connected' && pc.iceConnectionState !== 'completed') {
            console.warn(`[WebRTC-Host] ⏳ 与玩家 ${nickname} 的 P2P 穿透耗时过长，强制启用 WebSocket 服务器中继模式！`);
            if (this.peers[socketId] && !this.peers[socketId].isRelayMode) {
              this.peers[socketId].isRelayMode = true;
              this.socket.emit('relay-action', { to: socketId, action: { type: 'SYNC', payload: this.store.getState() } });
            }
          }
        }, 5000);
        
        pc.oniceconnectionstatechange = () => {
          console.log(`[WebRTC-Host] 📡 与玩家 ${nickname} 的底层连接状态改变为: ✨ ${pc.iceConnectionState} ✨`);
          
          if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
            clearTimeout(fallbackTimer);
          }

          if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
            console.error(`[WebRTC-Host] ❌ 与玩家 ${nickname} 的 P2P 穿透中断或失败！直连已被阻断。`);
            
            if (this.peers[socketId] && !this.peers[socketId].isRelayMode) {
              console.warn(`[WebRTC-Host] 🛡️ 正在针对该玩家启用 WebSocket 服务器中继模式...`);
              this.peers[socketId].isRelayMode = true;
              this.socket.emit('relay-action', { to: socketId, action: { type: 'SYNC', payload: this.store.getState() } });
            }
          }
        };

        const channel = pc.createDataChannel('game-data', { ordered: true });
        console.log(`[WebRTC-Host] 🛤️ 已创建 DataChannel 通道: game-data`);
        
        // 传入 playerId 以便在通道收到游戏操作时，精确分发到该身份
        this.setupChannel(socketId, playerId, channel, nickname);

        // 网络拓扑上依然用 socketId 寻找对应连接，但挂载真实 playerId
        this.peers[socketId] = { pc, channel, iceQueue, isRelayMode: false, playerId };

        pc.onicecandidate = (event) => {
          if (event.candidate) {
            const type = event.candidate.type;
            console.log(`[WebRTC-Host] 🧊 探测到房主网络节点: [${type.toUpperCase()}] ${event.candidate.address}:${event.candidate.port}`);
            if (type === 'relay') console.log(`[WebRTC-Host] 💡 检测到云端 TURN 中继节点就绪，尝试辅助穿透...`);
            this.socket.emit('signal', { to: socketId, data: { candidate: event.candidate } });
          }
        };

        console.log(`[WebRTC-Host] 📝 正在生成 WebRTC Offer...`);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        console.log(`[WebRTC-Host] 📤 Offer 生成完毕并设置为本地描述，正在发送给玩家 ${nickname}...`);
        this.socket.emit('signal', { to: socketId, data: { sdp: pc.localDescription } });

      } catch (err) {
        console.error(`[WebRTC-Host] ❌ 初始化玩家连接时发生严重错误:`, err);
      }
    });

    this.socket.on('signal', async ({ from, data }) => {
      const peer = this.peers[from];
      if (!peer) {
        console.warn(`[WebRTC-Host] ⚠️ 收到未知来源的信令数据: ${from}`);
        return;
      }

      try {
        if (data.sdp && data.sdp.type === 'answer') {
          console.log(`[WebRTC-Host] 📥 收到玩家发来的 Answer，正在设置为远程描述...`);
          await peer.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
          console.log(`[WebRTC-Host] ✅ 成功设置远程描述 (Answer)！握手逻辑完成，等待通道建立...`);
          
          // 核心修复：处理队列中积压的 ICE 候选者
          while (peer.iceQueue.length > 0) {
            const candidate = peer.iceQueue.shift();
            console.log(`[WebRTC-Host] 🧊 处理队列中的 ICE 候选者...`);
            await peer.pc.addIceCandidate(new RTCIceCandidate(candidate));
          }
        } else if (data.candidate) {
          if (peer.pc.remoteDescription) {
            console.log(`[WebRTC-Host] 🧊 收到玩家发来的 ICE 候选者，正在添加...`);
            await peer.pc.addIceCandidate(new RTCIceCandidate(data.candidate));
          } else {
            console.log(`[WebRTC-Host] ⏳ 远程描述尚未就绪，将 ICE 候选者加入缓冲队列...`);
            peer.iceQueue.push(data.candidate);
          }
        }
      } catch (err) {
        console.error(`[WebRTC-Host] ❌ 处理玩家信令数据时发生错误:`, err);
      }
    });

    this.socket.on('player-disconnected', ({ socketId, playerId }) => {
      if (this.peers[socketId]) {
        console.log(`[WebRTC-Host] 💔 玩家网络已断开: ${playerId} (Socket: ${socketId})`);
        
        // 核心修改：绝对不物理删除玩家数据，实现 Session 固化！
        // 将其标记为离线状态并清除屏幕焦点框，完美保留其积分、格子占有权和专属颜色
        this.store.dispatch({ type: 'PLAYER_OFFLINE', payload: { id: playerId } });
        this.broadcast({ type: 'SYNC', payload: this.store.getState() });
        
        delete this.peers[socketId]; // 清理网络层的陈旧连接
      }
    });
  }

  setupChannel(socketId, playerId, channel, nickname) {
    channel.onopen = () => {
      console.log(`[WebRTC-Host] 🎉 与玩家 ${nickname} 的数据通道已成功开启！马上同步初始盘面。`);
      channel.send(JSON.stringify({ type: 'SYNC', payload: this.store.getState() }));
    };

    channel.onclose = () => console.log(`[WebRTC-Host] 🔌 与玩家 ${nickname} 的数据通道已关闭。`);
    channel.onerror = (err) => console.error(`[WebRTC-Host] ❌ 数据通道发生异常:`, err);

    channel.onmessage = (event) => {
      const action = JSON.parse(event.data);
      // 核心：使用 playerId 代替原本转瞬即逝的 socketId 进行业务操作分发
      const updatedState = this.store.dispatch(action, playerId);
      this.broadcast({ type: 'SYNC', payload: updatedState });
    };
  }

  broadcast(message) {
    const data = JSON.stringify(message);
    Object.entries(this.peers).forEach(([guestId, peer]) => {
      if (peer.isRelayMode) {
        // 如果该玩家 P2P 失败，则智能路由到信令服务器去代发
        this.socket.emit('relay-action', { to: guestId, action: message });
      } else if (peer.channel && peer.channel.readyState === 'open') {
        // 如果是优质网络玩家，直接通过 DataChannel 发送
        peer.channel.send(data);
      }
    });
  }
}