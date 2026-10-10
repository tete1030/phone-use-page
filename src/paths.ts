export function normalizeBasePath(value='/'){
  if(value==='/'||/^\/(?:[A-Za-z0-9_-]+\/)+$/.test(value))return value;
  throw new Error('CONSOLE_BASE_PATH must be / or slash-delimited path segments ending with /');
}
export function consolePath(base:string,path:string){
  if(!path.startsWith('/')||path.startsWith('//'))throw new Error('Expected a local console path');
  return base==='/'?path:base.slice(0,-1)+path;
}
export function internalPath(url:string,base:string){
  const path=url.split('?')[0]!;
  if(base==='/')return path;
  const prefix=base.slice(0,-1);
  return path===prefix?'/':path.startsWith(base)?path.slice(prefix.length):path;
}
export function permittedHost(authority:string,publicOrigin?:string){
  const host=authority.replace(/:\d+$/,'').replace(/^\[|\]$/g,'');
  if(['127.0.0.1','localhost','::1'].includes(host))return true;
  if(!publicOrigin)return false;
  const url=new URL(publicOrigin);
  // A reverse proxy may omit the external TLS port; write origins still match exactly.
  return authority===url.host||authority===url.hostname;
}
