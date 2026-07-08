/*
 * @Author: yanyu yanyu1@xcmg.com
 * @Date: 2026-07-08 15:16:44
 * @LastEditors: yanyu yanyu1@xcmg.com
 * @LastEditTime: 2026-07-08 16:58:10
 * @FilePath: /sudoku-webrtc/client/src/webrtc/GuestPeer.js
 * @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
 */
export class GuestPeerManager {
  constructor(roomId, socket, store, nickname, iceConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }) {
    this.roomId = roomId;
    this.socket = socket;
    this.store = store;
    this.nickname = nickname; 
    this.iceConfig = iceConfig;
    this.pc = new RTCPeerConnection(this.iceConfig);
    this.channel = null;

    this.initSignaling();
  }

  initSignaling() {
    // 携带昵称加入房间
    this.socket.emit('join-room', { roomId: this.roomId, nickname: this.nickname });

    // 监听来自房主的信令
    this.socket.on('signal', async ({ from, data }) => {
      if (data.sdp && data.sdp.type === 'offer') {
        await this.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        
        // 收集自己的 ICE 候选者发送给房主
        this.pc.onicecandidate = (event) => {
          if (event.candidate) {
            this.socket.emit('signal', { to: from, data: { candidate: event.candidate } });
          }
        };

        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        this.socket.emit('signal', { to: from, data: { sdp: this.pc.localDescription } });
      } else if (data.candidate) {
        await this.pc.addIceCandidate(new RTCIceCandidate(data.candidate));
      }
    });

    // 核心：被动接收房主建立的通道
    this.pc.ondatachannel = (event) => {
      this.channel = event.channel;
      this.channel.onmessage = (e) => {
        const message = JSON.parse(e.data);
        if (message.type === 'SYNC') {
          // 强制覆盖本地状态，解决并发冲突
          this.store.setState(message.payload);
        }
      };
    };
  }

  // 玩家的所有本地操作通过这个方法向房主申请
  sendAction(action) {
    if (this.channel && this.channel.readyState === 'open') {
      this.channel.send(JSON.stringify(action));
    }
  }
}