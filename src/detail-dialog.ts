export function openDetailDialog(title:string,content:HTMLElement,onClose?:()=>void,host:HTMLElement=document.body){
  const dialog=document.createElement('dialog');dialog.className='console-detail-dialog';dialog.setAttribute('aria-label',title);
  const heading=document.createElement('h2');heading.textContent=title;
  const close=document.createElement('button');close.type='button';close.textContent='关闭';
  const header=document.createElement('div');header.className='detail-dialog-head';header.append(heading,close);
  dialog.append(header,content);host.append(dialog);
  close.addEventListener('click',()=>dialog.close());
  dialog.addEventListener('close',()=>{dialog.remove();onClose?.();},{once:true});dialog.showModal();close.focus();
  return dialog;
}

export function openJsonDetails(title:string,value:unknown,host?:HTMLElement){
  const content=document.createElement('div');content.className='detail-dialog-content';
  const toolbar=document.createElement('div');toolbar.className='detail-dialog-toolbar';
  const copy=document.createElement('button');copy.type='button';copy.textContent='复制';
  const status=document.createElement('output');status.setAttribute('aria-live','polite');toolbar.append(copy,status);
  const pre=document.createElement('pre');pre.textContent=JSON.stringify(value,null,2);content.append(toolbar,pre);
  copy.addEventListener('click',()=>void navigator.clipboard.writeText(pre.textContent||'').then(()=>status.textContent='已复制').catch(()=>status.textContent='复制失败，请选择文字复制'));
  return openDetailDialog(title,content,undefined,host);
}
