/*
 * @FilePath: /client/src/webrtc/GuestPeer.js
 */
export class GuestPeerManager {
  constructor(roomId, socket, store, nickname, iceConfig = { 
    iceServers: [
      { urls: 'stun:stun.qq.com:3478' },
      { urls: 'stun:stun.miwifi.com:3478' },
      { urls: 'stun:stun.l.google.com:19302' },
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
    this.pc = new RTCPeerConnection(this.iceConfig);
    this.channel = null;

    console.log(`[WebRTC-Guest] 👤 玩家网络管理器已启动，准备连接房间: ${this.roomId}`);
    
    this.pc.oniceconnectionstatechange = () => {
      console.log(`[WebRTC-Guest] 📡 底层 P2P 连接状态改变为: ✨ ${this.pc.iceConnectionState} ✨`);
      if (this.pc.iceConnectionState === 'failed') {
        console.error(`[WebRTC-Guest] ❌ 致命错误：P2P 直连打洞失败！如果是手机网络，极大可能是因为运营商的 Symmetric NAT (对称型防火墙) 拦截了连接，这需要部署自建 TURN 服务器才能解决。`);
        alert('❌ 无法建立 P2P 直连！您当前的网络（可能是校园网或运营商移动网络）屏蔽了直接通信。请尝试切换到普通家庭 Wi-Fi。');
      }
    };

    this.initSignaling();
  }

  initSignaling() {
    console.log(`[WebRTC-Guest] 📣 向信令服务器发送 join-room 请求...`);
    this.socket.emit('join-room', { roomId: this.roomId, nickname: this.nickname });

    this.socket.on('signal', async ({ from, data }) => {
      try {
        if (data.sdp && data.sdp.type === 'offer') {
          console.log(`[WebRTC-Guest] 📥 收到房主发来的 Offer! 准备设置为远程描述...`);
          await this.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
          console.log(`[WebRTC-Guest] ✅ 远程描述设置成功!`);
          
          this.pc.onicecandidate = (event) => {
            if (event.candidate) {
              console.log(`[WebRTC-Guest] 🧊 收集到玩家本地 ICE 候选者，发送给房主...`);
              this.socket.emit('signal', { to: from, data: { candidate: event.candidate } });
            }
          };

          console.log(`[WebRTC-Guest] 📝 正在生成 WebRTC Answer...`);
          const answer = await this.pc.createAnswer();
          await this.pc.setLocalDescription(answer);
          console.log(`[WebRTC-Guest] 📤 Answer 生成完毕并设置为本地描述，发送回给房主...`);
          
          this.socket.emit('signal', { to: from, data: { sdp: this.pc.localDescription } });

        } else if (data.candidate) {
          console.log(`[WebRTC-Guest] 🧊 收到房主发来的 ICE 候选者，正在添加...`);
          await this.pc.addIceCandidate(new RTCIceCandidate(data.candidate));
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
        }
      };
    };
  }

  sendAction(action) {
    if (this.channel && this.channel.readyState === 'open') {
      this.channel.send(JSON.stringify(action));
    } else {
      console.warn(`[WebRTC-Guest] ⚠️ 尝试发送操作，但通道尚未准备好！`);
    }
  }
}