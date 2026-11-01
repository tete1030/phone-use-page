import {escape,taskResultPreview} from './presentation.js';

const statusNames:Record<string,string>={running:'执行中',completed:'已完成',failed:'失败',cancelled:'已停止',timeout:'超时',interrupted:'已中断'};

/** A task's readable page: status, logs and a short result, with the raw record one toggle away. */
export function renderTaskPage(task:any,options:{backHref:string}):string {
  const status=statusNames[String(task?.status)]||String(task?.status||'');
  const duration=typeof task?.finishedAt==='number'&&typeof task?.startedAt==='number'
    ?((task.finishedAt-task.startedAt)/1000).toFixed(1)+' 秒':null;
  const logs:string[]=Array.isArray(task?.logs)?task.logs:[];
  const error=task?.error?`<p class="error">${escape(String(task.error))}</p>`:'';
  let result='';
  if(task?.result!==undefined&&task?.result!==null){
    const raw=JSON.stringify(task.result);
    result=`<h2>返回</h2><pre>${escape(taskResultPreview(task.result)||(raw.length>400?raw.slice(0,400)+'…':raw))}</pre>`;
  }
  const logBlock=logs.length?`<h2>日志（${logs.length} 条）</h2><pre>${escape(logs.join('\n'))}</pre>`:'';
  return '<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'+
    `<title>脚本任务 · ${escape(status)}</title>`+
    '<style>body{font:14px/1.6 system-ui,-apple-system,"PingFang SC",sans-serif;margin:24px auto;max-width:920px;padding:0 16px;color:#111}h1{font-size:20px;margin:0 0 6px}h2{font-size:15px;margin:22px 0 6px}.meta{color:#555;margin:0 0 4px}.error{color:#b3261e;white-space:pre-wrap}pre{white-space:pre-wrap;word-break:break-word;background:#f5f5f5;padding:10px 12px;border-radius:6px;margin:0}details{margin-top:20px}summary{cursor:pointer;color:#333}a{color:#0b57d0}</style>'+
    `<body><p><a href="${escape(options.backHref)}">返回控制台</a></p>`+
    `<h1>脚本任务 · ${escape(status)}</h1>`+
    `<p class="meta">${escape(String(task?.steps??0))} 步 · ${duration?escape(duration)+' · ':''}${escape(String(task?.id||''))}</p>`+
    error+result+logBlock+
    `<details><summary>原始记录（JSON）</summary><pre>${escape(JSON.stringify(task,null,2))}</pre></details></body></html>`;
}
