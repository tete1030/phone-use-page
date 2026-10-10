export function selectAndroidDevice(list:string,configured?:string){
  if(configured){
    if(/[\s\x00]/.test(configured))throw new Error('ANDROID_SERIAL must be a single ADB device identifier');
    return configured;
  }
  const devices=list.split('\n').flatMap(line=>{
    const match=/^(\S+)\t(device|offline|unauthorized|no permissions)(?:\s|$)/.exec(line);
    return match?[{serial:match[1]!,state:match[2]!}]:[];
  });
  const connected=devices.filter(d=>d.state==='device');
  if(connected.length===1)return connected[0]!.serial;
  if(connected.length>1||devices.length>1)throw new Error('Multiple Android devices found; set ANDROID_SERIAL to choose the intended device.');
  if(devices.length===1)return devices[0]!.serial;
  throw new Error('No Android device found. Connect one or set ANDROID_SERIAL to keep the console available while disconnected.');
}
