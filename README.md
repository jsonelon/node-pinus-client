### node-ts的pinus客户端

根据前端的pinus改成node的版本,可以在node上运行pinus的客户端

使用方式

```ts
import { PinusClient } from "./pinus";

const pinus = new PinusClient()

// 建立连接
pinus.init(ws:{
  host:'localhost'
  port:3010
}function(){
  console.log('连接成功');
})

// 监听事件
pinus.on('game',function(data){})

// 发送
pinus.request('connector.entryHandler.init',
 'Hello World',function(e){})
```
