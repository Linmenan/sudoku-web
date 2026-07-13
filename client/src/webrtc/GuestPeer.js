/*
 * @FilePath: /client/src/webrtc/GuestPeer.js
 */
export class GuestPeerManager {
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
  }, playerId) { // 新增 playerId
    this.roomId = roomId;
    this.socket = socket;
    this.store = store;
    this.nickname = nickname; 
    this.iceConfig = iceConfig;
    this.playerId = playerId; // 绑定固化身份
    this.pc = new RTCPeerConnection(this.iceConfig);
    this.channel = null;
    this.hostId = null;
    this.isRelayMode = false; // 降级标志位

    // 核心修复：清除由于断线重连可能遗留的旧监听器，防止事件重复触发导致 InvalidStateError
    this.socket.off('relay-action');
    this.socket.off('signal');

    console.log(`[WebRTC-Guest] 👤 玩家网络管理器已启动，准备连接房间: ${this.roomId}`);
    
    // 核心修复：设置 5 秒强制降级超时。如果 WebRTC 一直卡在 checking，直接激活 WebSocket 中继，保证 100% 能玩
    const fallbackTimer = setTimeout(() => {
      if (this.pc.iceConnectionState !== 'connected' && this.pc.iceConnectionState !== 'completed') {
        console.warn(`[WebRTC-Guest] ⏳ P2P 穿透耗时过长，强制无缝降级为 WebSocket 服务器中继模式！`);
        this.isRelayMode = true;
      }
    }, 5000);

    this.pc.oniceconnectionstatechange = () => {
      console.log(`[WebRTC-Guest] 📡 底层 P2P 连接状态改变为: ✨ ${this.pc.iceConnectionState} ✨`);
      
      if (this.pc.iceConnectionState === 'connected' || this.pc.iceConnectionState === 'completed') {
        clearTimeout(fallbackTimer); // 连接成功，取消强制降级
      }

      if (this.pc.iceConnectionState === 'failed' || this.pc.iceConnectionState === 'disconnected') {
        console.error(`[WebRTC-Guest] ❌ P2P 直连断开或打洞失败！极高难度 NAT 阻断了连接。`);
        if (!this.isRelayMode) {
          console.warn(`[WebRTC-Guest] 🛡️ 启动备用预案：正在自动无缝降级为 WebSocket 服务器中继模式...`);
          this.isRelayMode = true;
        }
      }
    };

    this.initSignaling();
  }

  initSignaling() {
    console.log(`[WebRTC-Guest] 📣 向信令服务器发送 join-room 请求...`);
    // 在信令握手时携带固化身份 playerId
    this.socket.emit('join-room', { roomId: this.roomId, nickname: this.nickname, playerId: this.playerId });
    this.iceQueue = []; // 新增：ICE 候选者缓冲队列

    // 监听中继信道，当打洞失败时使用
    this.socket.on('relay-action', ({ from, action }) => {
      if (action.type === 'SYNC') {
        console.log(`[WebRTC-Guest] 🔄 收到中继服务器转发的全量同步数据！来自: ${from}`);
        this.hostId = from; // 核心修复：即使底层信令全部失败，也能从中继包中直接捕获并绑定房主ID！
        this.store.setState(action.payload);
        // 核心加固：防止因为房主端状态延迟导致自己从列表中消失（移动端切后台极易发生）
        this.store.dispatch({ type: 'ADD_PLAYER', payload: { id: this.playerId, name: this.nickname, isHost: false } });
      }
    });

    this.socket.on('signal', async ({ from, data }) => {
      this.hostId = from; // 动态捕获房主的 socketId，用于打洞失败后发中继消息
      try {
        if (data.sdp && data.sdp.type === 'offer') {
          console.log(`[WebRTC-Guest] 📥 收到房主发来的 Offer! 准备设置为远程描述...`);
          await this.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
          console.log(`[WebRTC-Guest] ✅ 远程描述设置成功!`);
          
          // 核心修复：处理之前因为等待 SDP 而积压的 ICE 候选者
          while (this.iceQueue.length > 0) {
            const candidate = this.iceQueue.shift();
            console.log(`[WebRTC-Guest] 🧊 处理队列中的 ICE 候选者...`);
            await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
          }
          
          this.pc.onicecandidate = (event) => {
            if (event.candidate) {
              const type = event.candidate.type; // host, srflx (STUN), relay (TURN)
              console.log(`[WebRTC-Guest] 🧊 探测到本地网络节点: [${type.toUpperCase()}] ${event.candidate.address}:${event.candidate.port}`);
              if (type === 'relay') console.log(`[WebRTC-Guest] 💡 检测到云端 TURN 中继节点就绪，尝试辅助穿透...`);
              if (type === 'srflx') console.log(`[WebRTC-Guest] 🔍 NAT 外网映射地址收集完毕！`);
              this.socket.emit('signal', { to: from, data: { candidate: event.candidate } });
            }
          };

          console.log(`[WebRTC-Guest] 📝 正在生成 WebRTC Answer...`);
          const answer = await this.pc.createAnswer();
          await this.pc.setLocalDescription(answer);
          console.log(`[WebRTC-Guest] 📤 Answer 生成完毕并设置为本地描述，发送回给房主...`);
          
          this.socket.emit('signal', { to: from, data: { sdp: this.pc.localDescription } });

        } else if (data.candidate) {
          if (this.pc.remoteDescription) {
            console.log(`[WebRTC-Guest] 🧊 收到房主发来的 ICE 候选者，正在添加...`);
            await this.pc.addIceCandidate(new RTCIceCandidate(data.candidate));
          } else {
            console.log(`[WebRTC-Guest] ⏳ 远程描述尚未就绪，将 ICE 候选者加入缓冲队列...`);
            this.iceQueue.push(data.candidate);
          }
        }
      } catch (err) {
        console.error(`[WebRTC-Guest] ❌ 处理房主信令时发生错误:`, err);
      }
    });

    this.pc.ondatachannel = (event) => {
      console.log(`[WebRTC-Guest] 🎉 成功拦截到房主建立的数据通道: ${event.channel.label}`);
      this.channel = event.channel;
      
      this.channel.onopen = () => console.log(`[WebRTC-Guest] 🟢 数据通道状态: OPEN，可以开始同步游戏了！`);
      this.channel.onclose = () => console.log(`[WebRTC-Guest] 🔌 数据通道已关闭。`);
      this.channel.onerror = (err) => console.error(`[WebRTC-Guest] ❌ 数据通道异常:`, err);

      this.channel.onmessage = (e) => {
        const message = JSON.parse(e.data);
        if (message.type === 'SYNC') {
          console.log(`[WebRTC-Guest] 🔄 收到盘面全量同步数据`);
          this.store.setState(message.payload);
          // 核心加固：防止全局状态同步包抹杀掉自己本地的物理在线状态
          this.store.dispatch({ type: 'ADD_PLAYER', payload: { id: this.playerId, name: this.nickname, isHost: false } });
        }
      };
    };
  }

  sendAction(action) {
    if (this.isRelayMode && this.hostId) {
      // 降级模式下，将游戏操作打包给信令服务器进行物理转发，强制携带playerId供房主溯源
      this.socket.emit('relay-action', { to: this.hostId, playerId: this.playerId, action });
    } else if (this.channel && this.channel.readyState === 'open') {
      this.channel.send(JSON.stringify(action));
    } else {
      console.warn(`[WebRTC-Guest] ⚠️ 底层通道尚未就绪！主动尝试通过信令中继进行操作抢发...`);
      // 体验极致优化：在 P2P 尚未建立的 0~5 秒内，玩家的任何操作直接强行走服务器中继，拒绝死锁卡顿！
      if (this.hostId) {
        this.socket.emit('relay-action', { to: this.hostId, playerId: this.playerId, action });
      }
    }
  }
}