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

    this.socket.on('player-joined', async ({ id: guestId, nickname }) => {
      console.log(`[WebRTC-Host] 🔔 收到玩家加入通知! 玩家: ${nickname} (ID: ${guestId})`);
      
      this.store.dispatch({ type: 'ADD_PLAYER', payload: { id: guestId, name: nickname, isHost: false } });
      this.broadcast({ type: 'SYNC', payload: this.store.getState() });
      
      try {
        const pc = new RTCPeerConnection(this.iceConfig);
        console.log(`[WebRTC-Host] 🛠️ 已为玩家 ${nickname} 创建 RTCPeerConnection`);
        
        pc.oniceconnectionstatechange = () => {
          console.log(`[WebRTC-Host] 📡 与玩家 ${nickname} 的底层连接状态改变为: ✨ ${pc.iceConnectionState} ✨`);
          if (pc.iceConnectionState === 'failed') {
            console.error(`[WebRTC-Host] ❌ 警告：与玩家 ${nickname} 的 P2P 穿透失败！很可能是对方处于严格的 NAT 网络(如手机 4G/5G)，需要 TURN 服务器中继。`);
          }
        };

        const channel = pc.createDataChannel('game-data', { ordered: true });
        console.log(`[WebRTC-Host] 🛤️ 已创建 DataChannel 通道: game-data`);
        this.setupChannel(guestId, channel, nickname);

        this.peers[guestId] = { pc, channel };

        pc.onicecandidate = (event) => {
          if (event.candidate) {
            console.log(`[WebRTC-Host] 🧊 收集到房主本地 ICE 候选者，发送给玩家...`);
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
        } else if (data.candidate) {
          console.log(`[WebRTC-Host] 🧊 收到玩家发来的 ICE 候选者，正在添加...`);
          await peer.pc.addIceCandidate(new RTCIceCandidate(data.candidate));
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
    Object.values(this.peers).forEach(peer => {
      if (peer.channel && peer.channel.readyState === 'open') {
        peer.channel.send(data);
      }
    });
  }
}