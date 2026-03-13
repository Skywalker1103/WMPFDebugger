__wxConfig.debug = true;     
const originSocket = wx.connectSocket;
let g_sid = ~~(Date.now() / 2000) * 2;

class SocketWxCodeTask {
  sockekTask = null
  connected = false
  cacheData = [];
	onConnected = ()=>{};
  flush() {
    if (this.cacheData.length) {
      this.cacheData.slice().forEach(
        v => this.send(v.data, v.callback)
      )
      this.cacheData.length = 0;
    }
  }

  send(data, callback) {
    if (this.connected) {
      this.sockekTask.send({ data: JSON.stringify(data) })
    } else {
      this.cacheData.push({ data: data, callback: callback });
    }
  }

	processLogin(processCallback)
	{
		wx.login({
			complete(res){
				console.log('try wx.login get code ${res}');
				processCallback(res)
			}
		});
	}

  processGetLatestUserKey(processCallback) {

    const userCryptoManager = wx.getUserCryptoManager()
    userCryptoManager.getLatestUserKey({
      success: res => {
        console.log('getLatestUserKey success', res)
        processCallback(res)
      }
    })
  }

  constructor(sockekTask, onConnected) {
    this.sockekTask = sockekTask;
		this.onConnected = onConnected
    sockekTask.onOpen(
      () => {
        // debugger
        console.log("proxy mock ws svr connected")
        this.connected = true;
        this.flush();
				this.onConnected()
      }
    );
    sockekTask.onClose(
      () => {
        console.log("proxy mock ws svr closed")
        this.connected = false;
      }
    );

    sockekTask.onMessage(
      (message) => {
        // debugger
        if (typeof message.data === "string") {
          // debugger
          if (message.data.startsWith("#ALERT ")) {
            let msg = message.data.substr(7);
            wx.showModal({
              title: msg.split("#")[0],
              content: msg.split("#")[1],
              showCancel: false,
            })

          } else if (message.data.startsWith("#TOAST ")) {
            let msg = message.data.substr(7);
            wx.showToast({
              title: msg,
              icon: "none"
            });
          } else if (message.data[0] === "{") {
            let obj = JSON.parse(message.data)
						let command = obj.opt
            if (command === 'wx.login')
						{
							this.processLogin((processRes) => {
								obj.data = processRes
								this.send(obj, ()=>{})
							})
						} else if (command === 'getLatestUserKey') {
                this.processGetLatestUserKey((processRes) => {
                  obj.data = processRes
                  this.send(obj, ()=>{})
              })
            }
          } else {
            debugger
          }
          return;
        }
      }
    )
	}
	
}

function mockWxLogin(gameName, wxid) {
  let info = wx.getAccountInfoSync();
  console.log("!!!!!!!info %O", gameName)
  console.log("mock wx.login wx.getUserCryptoManager");

  const socketTask = originSocket({
      url:
        "wss://minihost-automation.tuanjie.cn/?ishost=false&gamename=" + gameName + "&wxid=" + wxid,
		  // "wss://demo.piesocket.com/v3/channel_123?api_key=YOUR_API_KEY&notify_self=1",
      header: {
        "content-type": "application/json",
      },
      success(res) {
        console.log("connectSocket success", JSON.stringify(res));
      },
      fail(err) {
        console.log("connectSocket fail", JSON.stringify(err));
      },
      complete(res) {
        console.log("connectSocket complete", JSON.stringify(res));
      },
    });
  socketTask.onError((err) => {
    console.log("socketTask onError", JSON.stringify(err));
  });

  const swct = new SocketWxCodeTask(socketTask);
  globalThis.__swct = swct;
  globalThis.__socketTask = socketTask;

	swct.onConnected = () => {
		console.log("websocket conented")
	}
  return true;
}

mockWxLogin(__wxConfig.accountInfo.nickname, __wxConfig.accountInfo.appId);

    
