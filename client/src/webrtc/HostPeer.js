/*
 * @Author: yanyu yanyu1@xcmg.com
 * @Date: 2026-07-08 15:16:20
 * @LastEditors: yanyu yanyu1@xcmg.com
 * @LastEditTime: 2026-07-09 10:57:50
 * @FilePath: /sudoku-webrtc/client/src/webrtc/HostPeer.js
 * @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
 */
export class HostPeerManager {
  constructor(roomId, socket, store, nickname, iceConfig = { 
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      // 免费公共 TURN 服务器（中继防掉线）
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
    this.peers = {}; // { guestSocketId: { pc, channel } }

    this.initSignaling();
  }

  initSignaling() {
    this.socket.emit('create-room', { roomId: this.roomId, nickname: this.nickname });

    // 1. 监听新玩家加入
    this.socket.on('player-joined', async ({ id: guestId, nickname }) => {
      // ---> 新增：更新全局状态，添加玩家
      // 记录玩家时将传来的昵称加入状态
      this.store.dispatch({ type: 'ADD_PLAYER', payload: { id: guestId, name: nickname, isHost: false } });
      this.broadcast({ type: 'SYNC', payload: this.store.getState() });
      const pc = new RTCPeerConnection(this.iceConfig);
      
      // 2. 房主主动创建可靠有序的数据通道
      const channel = pc.createDataChannel('game-data', { ordered: true });
      this.setupChannel(guestId, channel);

      this.peers[guestId] = { pc, channel };

      // 3. 收集 ICE 候选者并发送
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          this.socket.emit('signal', { to: guestId, data: { candidate: event.candidate } });
        }
      };

      // 4. 创建 Offer 并发送
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.socket.emit('signal', { to: guestId, data: { sdp: pc.localDescription } });
    });

    // 5. 处理来自玩家的 Answer 或 ICE
    this.socket.on('signal', async ({ from, data }) => {
      const peer = this.peers[from];
      if (!peer) return;

      if (data.sdp && data.sdp.type === 'answer') {
        await peer.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      } else if (data.candidate) {
        await peer.pc.addIceCandidate(new RTCIceCandidate(data.candidate));
      }
    });

    // 监听玩家掉线
    this.socket.on('player-disconnected', (guestId) => {
      if (this.peers[guestId]) {
        this.store.dispatch({ type: 'REMOVE_PLAYER', payload: { id: guestId } });
        this.broadcast({ type: 'SYNC', payload: this.store.getState() });
        delete this.peers[guestId];
      }
    });

  }

  setupChannel(guestId, channel) {
    channel.onopen = () => {
      // 玩家连入后，立即同步一次完整的初始盘面
      channel.send(JSON.stringify({ type: 'SYNC', payload: this.store.getState() }));
    };

    channel.onmessage = (event) => {
      const action = JSON.parse(event.data);
      // 权威中心处理状态
      const updatedState = this.store.dispatch(action, guestId);
      // 广播给所有人 (实现 LWW 覆盖)
      this.broadcast({ type: 'SYNC', payload: updatedState });
    };
  }

  broadcast(message) {
    const data = JSON.stringify(message);
    Object.values(this.peers).forEach(peer => {
      if (peer.channel.readyState === 'open') {
        peer.channel.send(data);
      }
    });
  }
}