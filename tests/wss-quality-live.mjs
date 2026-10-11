import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium} from 'playwright';
import {serveQualityDemo} from '../scripts/wss-quality-demo.mjs';

const out=resolve(process.env.WSS_DEMO_OUTPUT||'.local/wss-quality-demo');
const report=JSON.parse(await readFile(out+'/results.json','utf8'));
const demo=await serveQualityDemo(out,report);
let browser;
try{
  browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/opt/google/chrome/chrome',headless:true,args:['--no-sandbox']});
  const page=await browser.newPage({viewport:{width:1600,height:900}}),errors=[];
  page.on('pageerror',error=>errors.push(String(error)));
  await page.goto(demo.url);
  await page.waitForFunction(()=>window.wssQualityDemo?.().every(p=>p.decodedAndDrawnFrames>=32)&&window.wssQualityDemo().length===2,{},{timeout:15000});
  const stats=await page.evaluate(()=>window.wssQualityDemo());
  for(const p of stats){assert.equal(p.width,864);assert.equal(p.height,1920);assert.equal(p.state,'connected');}
  await page.screenshot({path:out+'/browser-comparison.png'});
  await page.getByRole('button',{name:'暂停保留末帧'}).click();
  await page.waitForFunction(()=>window.wssQualityDemo().length===0);
  await page.getByRole('button',{name:'重新播放'}).click();
  await page.waitForFunction(()=>window.wssQualityDemo().length===2&&window.wssQualityDemo().every(p=>p.decodedAndDrawnFrames>=8));
  assert.deepEqual(errors,[]);
  const result={passed:true,phoneAccessed:false,productionAccessed:false,checks:['both recorded streams decoded by production WSS player','original full resolution','pause closes streams and keeps frame','restart decodes a new keyframe','no browser errors'],stats};
  await writeFile(out+'/browser-validation.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
}finally{await browser?.close();await demo.close();}
