export function confirmAction(message:string):Promise<boolean>{
  if(document.querySelector('.action-confirmation'))return Promise.resolve(false);
  const dialog=document.createElement('dialog');dialog.className='action-confirmation';
  const title=document.createElement('h2');title.id='action-confirmation-title';title.textContent='确认操作';dialog.setAttribute('aria-labelledby',title.id);
  const description=document.createElement('p');description.textContent=message;
  const cancel=document.createElement('button'),accept=document.createElement('button');cancel.type=accept.type='button';cancel.textContent='取消';accept.textContent='确认执行';
  const controls=document.createElement('div');controls.append(cancel,accept);dialog.append(title,description,controls);document.body.append(dialog);
  return new Promise(resolve=>{dialog.addEventListener('close',()=>{const confirmed=dialog.returnValue==='confirm';dialog.remove();resolve(confirmed);},{once:true});
    cancel.addEventListener('click',()=>dialog.close('cancel'));accept.addEventListener('click',()=>dialog.close('confirm'));dialog.showModal();cancel.focus();});
}
