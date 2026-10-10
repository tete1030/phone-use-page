import {readFile} from 'node:fs/promises';
import {AdbServerClient} from '@yume-chan/adb';
import {AdbServerNodeTcpConnector} from '@yume-chan/adb-server-node-tcp';
import {AdbScrcpyClient,AdbScrcpyOptions3_3_3} from '@yume-chan/adb-scrcpy';
import {ReadableStream} from '@yume-chan/stream-extra';
const server=new AdbServerClient(new AdbServerNodeTcpConnector({host:'127.0.0.1',port:5037}));
const devices=await server.getDevices();const serial=process.env.ANDROID_SERIAL||devices.find(d=>d.state==='device')?.serial;
const adb=await server.createAdb({serial});const file=await readFile('vendor/scrcpy-server-v3.3.3');
await AdbScrcpyClient.pushServer(adb,new ReadableStream({start(c){c.enqueue(file);c.close();}}));
const client=await AdbScrcpyClient.start(adb,'/data/local/tmp/scrcpy-server.jar',new AdbScrcpyOptions3_3_3({video:true,audio:false,control:true,tunnelForward:true,maxSize:1920,maxFps:30,powerOn:false,clipboardAutosync:false}));
void client.output.pipeTo(new WritableStream({write(line){console.log('server:',line);}}));
const video=await client.videoStream;console.log('metadata',video.metadata);
const reader=video.stream.getReader();const timer=setTimeout(()=>{void client.close();},5000);let count=0;
try{while(true){const p=await reader.read();if(p.done)break;if(count++<4)console.log('packet',p.value.type,p.value.data.length,p.value.type==='data'?String(p.value.pts):'');}}catch(error){console.log(String(error));}
clearTimeout(timer);await client.close();console.log('packets',count);
