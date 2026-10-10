import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { AuthStore,type AuthSession } from './auth.js';
import { ConsoleError } from './types.js';
import { escape } from './presentation.js';
import { normalizeBasePath,consolePath,internalPath } from './paths.js';

export interface AuthHttpOptions {secure:boolean;cookiePath?:string;basePath?:string;publicOrigin?:string;assetVersion?:string;onLogout?:(session:AuthSession)=>void|Promise<void>}
export function installAuth(app:FastifyInstance,store:AuthStore,options:AuthHttpOptions){
  const basePath=normalizeBasePath(options.basePath),endpoint=(path:string)=>consolePath(basePath,path);
  const asset=(path:string)=>endpoint(path)+(options.assetVersion?'?v='+encodeURIComponent(options.assetVersion):'');
  const path=options.cookiePath??basePath;if(!path.startsWith('/')||!path.endsWith('/')||/[\s;\r\n]/.test(path))throw new Error('CONSOLE_COOKIE_PATH must start and end with /');
  if(options.secure&&path!==basePath)throw new Error('CONSOLE_COOKIE_PATH must match CONSOLE_BASE_PATH for HTTPS publication');
  const name=options.secure?'__Secure-android_console_v2':'android_console_v2',challengeName=options.secure?'__Secure-android_console_login':'android_console_login';
  const base={path,httpOnly:true,secure:options.secure,sameSite:'strict' as const};
  app.addHook('onRequest',async req=>{
    const route=internalPath(req.url,basePath);if(route==='/health'||route.startsWith('/assets/'))return;
    if(options.secure&&req.protocol!=='https')throw new ConsoleError('HTTPS_REQUIRED','请通过 HTTPS 地址访问控制台',403);
    if(route==='/api/login'||route==='/api/logout'){
      let valid=false;try{const origin=req.headers.origin,u=new URL(origin!);valid=options.publicOrigin?origin===options.publicOrigin:u.origin===new URL(req.protocol+'://'+req.headers.host).origin;}catch{}
      if(!valid)throw new ConsoleError('ORIGIN_REJECTED','请求来源不属于控制台',403);
    }
  });
  const authenticate=(req:FastifyRequest,mutating=false)=>{const s=store.get(req.cookies[name]);if(!s)throw new ConsoleError('LOGIN_REQUIRED','请先输入密码登录',401);if(mutating)store.checkCsrf(s,req.headers['x-console-csrf']);return s;};
  app.get(endpoint('/api/auth/status'),async req=>({authenticated:!!store.get(req.cookies[name])}));
  app.post(endpoint('/api/login'),async(req,reply)=>{
    const body=req.body as any,token=body?.loginToken,cookie=req.cookies[challengeName];
    if(typeof token!=='string'||!(/^[a-f0-9]{64}$/).test(token)||!cookie||!(/^[a-f0-9]{64}$/).test(cookie)||!timingSafeEqual(Buffer.from(token,'hex'),Buffer.from(cookie,'hex')))throw new ConsoleError('LOGIN_CSRF','登录页已失效，请刷新后再试',403);
    if(typeof body.password!=='string'||body.password.length>512||body.remember!==undefined&&typeof body.remember!=='boolean')throw new ConsoleError('LOGIN_FAILED','密码不正确',401);
    try{const result=await store.login(body.password,req.ip,body.remember!==false);reply.setCookie(name,result.token,{...base,...(body.remember===false?{}:{maxAge:result.seconds})});reply.clearCookie(challengeName,{...base});return {ok:true};}
    catch(error){if(error instanceof ConsoleError&&error.status===429)reply.header('Retry-After','600');throw error;}
  });
  app.post(endpoint('/api/logout'),async req=>{const s=authenticate(req,true);await store.revoke(s.id);await options.onLogout?.(s);return {ok:true};});
  app.addHook('onSend',async(req,reply,payload)=>{if(internalPath(req.url,basePath)==='/api/logout'&&reply.statusCode<400)reply.clearCookie(name,{...base});return payload;});
  function loginPage(reply:FastifyReply){
    const challenge=randomBytes(32).toString('hex');reply.setCookie(challengeName,challenge,{...base,maxAge:600});
    return '<!doctype html><html lang="zh-CN" data-console-base="'+escape(basePath)+'"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>登录安卓控制台</title><link rel="icon" href="data:,"><link rel="stylesheet" href="'+asset('/assets/style.css')+'"></head><body class="login-page"><main class="login-card"><h1>登录安卓控制台</h1><p>登录后可以查看和操作连接的手机。</p><form id="login-form"><input name="loginToken" type="hidden" value="'+escape(challenge)+'"><label for="console-password">访问密码</label><input id="console-password" name="password" type="password" autocomplete="current-password" required maxlength="512" autofocus><label class="remember-label"><input name="remember" type="checkbox" checked>在此设备保持登录 '+Math.floor(store.rememberSeconds/86400)+' 天</label><p class="login-note">共享电脑请取消保持登录；使用完毕后退出登录。</p><button type="submit">登录</button><output role="status" aria-live="polite"></output></form></main><script type="module" src="'+asset('/assets/client.js')+'"></script></body></html>';
  }
  return {authenticate,loginPage,cookieName:name};
}
