/*
 * @FilePath: /client/src/webrtc/HostPeer.js
 */
export class HostPeerManager {
  constructor(roomId, socket, store, nickname, iceConfig = { 
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun.miwifi.com:3478' },       // 小米
      { urls: 'stun:stun.qq.com:3478' },           // 腾讯
      { urls: 'stun:stun.chat.bilibili.com:3478' }, // B站
      {
        urls: 'turn:openrelay.metered.ca:80',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      },
      {
        urls: 'turn:openrelay.metered.ca:443',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      }
    ] 
  }) {
    this.roomId = roomId;
    this.socket = socket;
    this.store = store;
    this.nickname = nickname;
    this.iceConfig = iceConfig;
    this.peers = {}; 

    console.log(`[WebRTC-Host] 👑 房主网络管理器已启动，房间号: ${this.roomId}`);
    this.initSignaling();
  }

  initSignaling() {
    this.socket.emit('create-room', { roomId: this.roomId, nickname: this.nickname });

    // 监听来自降级 Guest 的中继请求
    this.socket.on('relay-action', ({ from, action }) => {
      if (this.peers[from] && this.peers[from].isRelayMode) {
        const updatedState = this.store.dispatch(action, from);
        this.broadcast({ type: 'SYNC', payload: updatedState });
      }
    });

    this.socket.on('player-joined', async ({ id: guestId, nickname }) => {
      console.log(`[WebRTC-Host] 🔔 收到玩家加入通知! 玩家: ${nickname} (ID: ${guestId})`);
      
      this.store.dispatch({ type: 'ADD_PLAYER', payload: { id: guestId, name: nickname, isHost: false } });
      this.broadcast({ type: 'SYNC', payload: this.store.getState() });
      
      try {
        const pc = new RTCPeerConnection(this.iceConfig);
        console.log(`[WebRTC-Host] 🛠️ 已为玩家 ${nickname} 创建 RTCPeerConnection`);
        
        const iceQueue = []; // 新增：为每个玩家独立创建一个 ICE 缓冲队列
        
        pc.oniceconnectionstatechange = () => {
          console.log(`[WebRTC-Host] 📡 与玩家 ${nickname} 的底层连接状态改变为: ✨ ${pc.iceConnectionState} ✨`);
          if (pc.iceConnectionState === 'failed') {
            console.error(`[WebRTC-Host] ❌ 与玩家 ${nickname} 的 P2P 穿透失败！检测到高难度 NAT，直连已被阻断。`);
            console.warn(`[WebRTC-Host] 🛡️ 正在针对该玩家启用 WebSocket 服务器中继模式...`);
            
            if (this.peers[guestId]) {
              this.peers[guestId].isRelayMode = true;
              // 关键操作：切换中继后，主动通过信令服务器全量推送一次盘面，拉齐数据状态
              this.socket.emit('relay-action', { to: guestId, action: { type: 'SYNC', payload: this.store.getState() } });
            }
          }
        };

        const channel = pc.createDataChannel('game-data', { ordered: true });
        console.log(`[WebRTC-Host] 🛤️ 已创建 DataChannel 通道: game-data`);
        this.setupChannel(guestId, channel, nickname);

        // 维护标志位 isRelayMode
        this.peers[guestId] = { pc, channel, iceQueue, isRelayMode: false };

        pc.onicecandidate = (event) => {
          if (event.candidate) {
            const type = event.candidate.type;
            console.log(`[WebRTC-Host] 🧊 探测到房主网络节点: [${type.toUpperCase()}] ${event.candidate.address}:${event.candidate.port}`);
            if (type === 'relay') console.log(`[WebRTC-Host] 💡 检测到云端 TURN 中继节点就绪，尝试辅助穿透...`);
            this.socket.emit('signal', { to: guestId, data: { candidate: event.candidate } });
          }
        };

        console.log(`[WebRTC-Host] 📝 正在生成 WebRTC Offer...`);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        console.log(`[WebRTC-Host] 📤 Offer 生成完毕并设置为本地描述，正在发送给玩家 ${nickname}...`);
        this.socket.emit('signal', { to: guestId, data: { sdp: pc.localDescription } });

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

    this.socket.on('player-disconnected', (guestId) => {
      if (this.peers[guestId]) {
        console.log(`[WebRTC-Host] 💔 玩家已断开连接: ${guestId}`);
        this.store.dispatch({ type: 'REMOVE_PLAYER', payload: { id: guestId } });
        this.broadcast({ type: 'SYNC', payload: this.store.getState() });
        delete this.peers[guestId];
      }
    });
  }

  setupChannel(guestId, channel, nickname) {
    channel.onopen = () => {
      console.log(`[WebRTC-Host] 🎉 与玩家 ${nickname} 的数据通道已成功开启！马上同步初始盘面。`);
      channel.send(JSON.stringify({ type: 'SYNC', payload: this.store.getState() }));
    };

    channel.onclose = () => console.log(`[WebRTC-Host] 🔌 与玩家 ${nickname} 的数据通道已关闭。`);
    channel.onerror = (err) => console.error(`[WebRTC-Host] ❌ 数据通道发生异常:`, err);

    channel.onmessage = (event) => {
      const action = JSON.parse(event.data);
      const updatedState = this.store.dispatch(action, guestId);
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