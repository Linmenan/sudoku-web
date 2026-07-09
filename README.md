# WebRTC 纯 Web 多人实时协作数独游戏

本项目是一个基于 WebRTC 和 Socket.io 实现的 P2P 多人联机数独游戏。玩家可以创建房间，邀请好友加入，并在纯前端的无中心化架构下实现毫秒级的盘面状态同步、冲突仲裁以及胜利结算。

## 📂 项目文件结构与说明

项目采用前后端分离架构，前端使用 Vite 构建，后端为一个轻量级的 Node.js 信令服务器。

```text
sudoku-web/
├── client/                     # 前端工程目录
│   ├── src/                    # 源代码目录
│   │   ├── store/              
│   │   │   └── gameState.js    # 全局状态机：管理盘面数据、玩家列表、游戏阶段、实现 LWW 状态覆盖逻辑
│   │   ├── sudoku/             
│   │   │   └── solver.js       # 核心算法：基于回溯算法验证数独唯一解、验证最终胜利条件
│   │   ├── webrtc/             
│   │   │   ├── HostPeer.js     # 房主网络管理器：维持 1 对 N 的 P2P 连接，作为状态权威广播数据
│   │   │   └── GuestPeer.js    # 玩家网络管理器：维持 1 对 1 连接，向房主发送操作并接受状态覆盖
│   │   └── main.js             # 业务入口：处理 DOM 渲染、键盘/鼠标交互绑定、游戏流程控制
│   ├── index.html              # 游戏前端主界面
│   ├── package.json            # 前端依赖配置 (Vite, socket.io-client)
│   └── package-lock.json       # 前端依赖版本锁定
├── signaling-server/           # WebRTC 信令服务器目录
│   ├── server.js               # 信令核心：使用 Socket.io 处理房间创建、加入校验、转发 SDP/ICE 信息
│   ├── package.json            # 服务端依赖配置 (socket.io)
│   └── package-lock.json       # 服务端依赖版本锁定
└── .gitignore                  # Git 忽略配置
```

# 🚀 快速开始
# 1. 克隆代码
```bash
git clone https://github.com/Linmenan/sudoku-web.git
cd sudoku-web
```

# 2. 环境要求
- Node.js (推荐 v18.0.0 或更高版本) windows 中官网下载 [Node.js 官方下载地址](https://nodejs.org/zh-cn/) 运行安装包，一路点“Next（下一步）”即可。 后续终端命令一定要再装好后启动，或者装好后重启终端。
- npm (Node 自带)

# 3. 安装与运行
本项目现已升级为集成托管运行模式。后端服务器集成了前端静态网页托管以及自动公网穿透（Localtunnel）功能，只需简单两步，即可生成公网链接实现“一键分享开黑”。

## 步骤一：编译打包前端代码
首先，需要将前端代码编译为后端可读取的静态网页产物。

```bash
# 进入前端目录
cd client

# 安装前端依赖
npm install

# 编译打包 (将在 client 目录下生成 dist 文件夹)
npm run build
```

## 步骤二：启动服务端并生成联机网址
前端打包完成后，就可以通过信令服务器一键提供网页访问和 WebRTC 信令服务。

```bash
# 切换到后端目录
cd ../signaling-server

# 安装后端依赖 (包含 express 和 localtunnel)
npm install express localtunnel

# 启动服务
node server.js
```

启动成功后，终端不仅会显示本地测试地址（http://localhost:3000），还会自动请求并在终端打印出一个公网穿透网址（例如：https://xxxx-xxxx.loca.lt）。

你只需将这个网址发给朋友，双方通过浏览器打开即可直接跨网联机！


(💡 提示：如果访问生成的公网链接时，出现 Localtunnel 的防滥用安全提示网页，只需根据页面上的提示，复制网页上显示的公网 IP 并填入输入框，点击继续即可进入游戏。)

# 🎮 游玩指南
## 出题阶段 (Setup Phase)
* 鼠标点击任意网格，使用键盘 1-9 填入数字，使用 Backspace 删除。

* 点击 "验证谜题可解性"。如果右侧提示“✅ 解唯一”，说明这是一道标准的数独题。

## 创建与联机阶段 (Playing Phase)
* 房主创建： 输入自己的昵称和预设房间号，点击 "创建房间"。此时题目将被锁定为黑色粗体，界面进入联机模式。

* 玩家加入： 另一位玩家在另一台设备（或另一个浏览器标签页）打开相同网址，输入相同的房间号和自己的昵称，点击 "加入房间"。

* 协作游玩： * 玩家点击格子会有自己颜色的独立光环。

支持通过按钮切换至 "📝 备注模式"，在格子内填入 3x3 的备选小数字。

当 81 个格子全部填满且正确无误时，系统会自动弹出胜利结算面板，展示每位玩家贡献的正确数字数量。