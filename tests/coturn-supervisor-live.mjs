import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,writeFile,mkdir,chmod} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHmac} from 'node:crypto';
import tls from 'node:tls';
import assert from 'node:assert/strict';
import {createTurnClient} from 'werift';

const exec=promisify(execFile),root=resolve('.local/coturn-supervisor-validation');
const image=process.env.COTURN_SUPERVISOR_IMAGE||(await readFile('.local/coturn-supervisor-image','utf8')).trim();
const ca=root+'/ca.pem',secret='fixture-supervisor-relay-secret';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const containers=[],clients=[],checks=[];
const record=name=>{checks.push(name);console.log('PASS',name);};
async function until(read,predicate){for(let i=0;i<45;i++){try{const value=await read();if(predicate(value))return value;}catch{}await wait(300);}throw Error('Isolated validation condition did not complete');}
async function openssl(...args){await exec('openssl',args,{cwd:root,timeout:10000});}
async function installCertificate(name){await writeFile(root+'/source/fullchain.pem',Buffer.concat([await readFile(root+'/'+name+'.pem'),await readFile(ca)]),{mode:0o600});await writeFile(root+'/source/privkey.pem',await readFile(root+'/'+name+'.key'),{mode:0o600});}
const config=port=>`listening-ip=127.0.0.1\nrelay-ip=127.0.0.1\nlistening-port=${port-1}\ntls-listening-port=${port}\nmin-port=${port+100}\nmax-port=${port+131}\nrealm=turn.example.test\nfingerprint\nuse-auth-secret\nstatic-auth-secret=${secret}\nallow-loopback-peers\nno-multicast-peers\nno-tcp\nno-udp\nno-dtls\nno-cli\nno-tcp-relay\nuser-quota=8\ntotal-quota=32\nlog-file=stdout\nsimple-log\nno-stdout-log\n`;
async function start(name,state,port,ip=false){await mkdir(state,{recursive:true,mode:0o700});await writeFile(root+'/'+name+'.conf',config(port),{mode:0o600});const args=['run','-d','--name',name,'--network','host','--user',`${process.getuid()}:${process.getgid()}`,'--read-only','--cap-drop=ALL','--cap-add=NET_BIND_SERVICE','--security-opt=no-new-privileges','--tmpfs','/tmp:rw,noexec,nosuid,size=32m',
  '-v',state+':/state','-v',root+'/source:/source:ro','-v',root+'/'+name+'.conf:/etc/coturn/base.conf:ro','-v',ca+':/fixture-ca.pem:ro',
  '-e','TURN_STATE_DIR=/state','-e','TURN_CERT_SOURCE=/source','-e','TURN_CERT_HOSTNAME=turn.example.test','-e','TURN_CA_FILE=/fixture-ca.pem','-e','TURN_CERT_INTERVAL_SECONDS=1','-e','TURN_IP_INTERVAL_SECONDS=1'];
 if(ip)args.push('-v',root+'/hosts:/etc/hosts:ro','-e','TURN_PUBLIC_HOSTNAME=wan.example.test','-e','TURN_PRIVATE_IP=127.0.0.1');
 await exec('docker',[...args,image]);containers.push(name);const s=await until(()=>readFile(state+'/status.json','utf8').then(JSON.parse),s=>s.ready);return s;}
const status=state=>()=>readFile(state+'/status.json','utf8').then(JSON.parse);
async function certificateSerial(port){const certificate=await readFile(ca);return new Promise((done,reject)=>{const socket=tls.connect({host:'127.0.0.1',port,servername:'turn.example.test',ca:certificate,rejectUnauthorized:true});socket.setTimeout(5000,()=>socket.destroy(Error('TLS timeout')));socket.once('error',reject);socket.once('secureConnect',()=>{const serial=socket.getPeerCertificate().serialNumber;socket.end();done(serial);});});}
async function client(name,port){const username=Math.floor(Date.now()/1000+600)+':'+name,password=createHmac('sha1',secret).update(username).digest('base64');const p=await createTurnClient({address:['127.0.0.1',port],username,password},{transport:'tls',tlsOptions:{servername:'turn.example.test',ca:await readFile(ca),rejectUnauthorized:true},connectTimeoutMs:5000});clients.push(p);return p;}
async function transfer(a,b,value){const received=b.onData.asPromise();await b.getPermission(a.relayedAddress);await a.sendData(Buffer.from(value),b.relayedAddress);let timeout;try{const [data]=await Promise.race([received,new Promise((_,j)=>timeout=setTimeout(()=>j(Error('Relay delivery timed out')),4000))]);assert.equal(data.toString(),value);}finally{clearTimeout(timeout);}}

await mkdir(root,{recursive:true,mode:0o700});await mkdir(root+'/source',{recursive:true,mode:0o700});
try{
 await openssl('req','-x509','-newkey','rsa:2048','-nodes','-keyout','ca.key','-out','ca.pem','-days','7','-subj','/CN=Fixture CA','-addext','basicConstraints=critical,CA:TRUE');
 await writeFile(root+'/extensions','subjectAltName=DNS:turn.example.test\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n');
 for(const [name,serial]of [['one','101'],['two','202']]){await openssl('req','-newkey','rsa:2048','-nodes','-keyout',name+'.key','-out',name+'.csr','-subj','/CN=turn.example.test');await openssl('x509','-req','-in',name+'.csr','-CA','ca.pem','-CAkey','ca.key','-set_serial',serial,'-out',name+'.pem','-days','5','-extfile','extensions');}
 await installCertificate('one');const state=root+'/state',name='coturn-supervisor-validation';const initial=await start(name,state,15349);
 await assert.rejects(exec('docker',['exec',name,'python3','/opt/coturn-supervisor/supervisor.py','run']),error=>error.stderr.includes('Resource temporarily unavailable'));record('second supervisor cannot share the state directory');
 const serial=await certificateSerial(15349),a=await client('a',15349),b=await client('b',15349);
 await transfer(a,b,'before-renewal');record('authenticated TLS TURN allocations relay synthetic data');
 await installCertificate('two');const rotated=await until(status(state),s=>s.certificateReloads===1);assert.equal(rotated.pid,initial.pid);assert.equal(rotated.childRestarts,0);await until(()=>certificateSerial(15349),value=>value!==serial);await transfer(a,b,'after-renewal');record('SIGUSR2 reload changes TLS certificate while old allocation and PID survive');
 await writeFile(root+'/source/privkey.pem',await readFile(root+'/one.key'));await until(status(state),s=>!!s.certificateError);await transfer(a,b,'invalid-source-retained');assert.equal((await status(state)()).pid,initial.pid);record('invalid source key preserves serving certificate and allocation');
 await installCertificate('two');await until(status(state),s=>!s.certificateError);for(const p of clients.splice(0))await p.close();
 await writeFile(state+'/diagnostic.json',JSON.stringify({enabled:true,expiresAt:Math.floor(Date.now()/1000)+4}),{mode:0o600});await until(status(state),s=>s.diagnosticEnabled);await until(status(state),s=>!s.diagnosticEnabled&&s.childRestarts>=2);record('bounded diagnostic logging expires and only restarts child');
 const before=(await exec('docker',['inspect',name,'--format','{{.State.StartedAt}}'])).stdout;assert.ok(before);await exec('docker',['stop','--time','15',name]);const stopped=JSON.parse(await readFile(state+'/status.json','utf8'));assert.equal(stopped.ready,false);record('PID1 forwards shutdown and writes non-ready status');
 await writeFile(root+'/hosts','127.0.0.1 localhost\n1.1.1.1 wan.example.test\n');const ipState=root+'/ip-state',ipName='coturn-supervisor-ip-validation';const first=await start(ipName,ipState,15449,true);assert.equal(first.publicIp,'1.1.1.1');
 await writeFile(root+'/hosts','127.0.0.1 localhost\n8.8.8.8 wan.example.test\n');const changed=await until(status(ipState),s=>s.publicIp==='8.8.8.8'&&s.childRestarts===1);assert.notEqual(changed.pid,first.pid);assert.match(await readFile(ipState+'/turnserver.conf','utf8'),/external-ip=8\.8\.8\.8\/127\.0\.0\.1/);record('changed mocked DNS mapping restarts child with new external IP');
 await writeFile(root+'/hosts','127.0.0.1 localhost\n192.168.1.1 wan.example.test\n');await until(status(ipState),s=>!!s.publicIpError);assert.equal((await status(ipState)()).publicIp,'8.8.8.8');assert.equal((await status(ipState)()).pid,changed.pid);record('invalid DNS mapping keeps prior public IP and PID');
 await writeFile(root+'/result.json',JSON.stringify({passed:true,checks,phoneAccessed:false,productionChanged:false},null,2)+'\n',{mode:0o600});
}finally{for(const p of clients)await p.close().catch(()=>{});for(const name of containers){await exec('docker',['stop','--time','15',name]).catch(()=>{});await exec('docker',['rm',name]).catch(()=>{});}}
