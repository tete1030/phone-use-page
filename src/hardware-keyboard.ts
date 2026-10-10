export const keyboardName='Android Console Keyboard';
export const keyboardDescriptor=Uint8Array.of(5,1,9,6,161,1,5,7,25,224,41,231,21,0,37,1,117,1,149,8,129,2,149,1,117,8,129,1,149,5,117,1,5,8,25,1,41,5,145,2,149,1,117,3,145,1,149,6,117,8,21,0,37,101,5,7,25,0,41,101,129,0,192);
const usages:Record<number,number>={66:40,111:41,67:42,61:43,62:44,69:45,70:46,71:47,72:48,73:49,74:51,75:52,68:53,55:54,56:55,76:56,115:57,112:76,122:74,123:77,92:75,93:78,22:79,21:80,20:81,19:82};
const modifiers:Record<number,number>={113:1,59:2,57:4,117:8,114:16,60:32,58:64,118:128};
export interface HidWriter {uHidCreate:(message:any)=>Promise<unknown>;uHidInput:(message:any)=>Promise<unknown>;uHidDestroy:(id:number)=>Promise<unknown>}
export class HardwareKeyboard {
  private down=new Set<number>();private modifierKeys=new Set<number>();
  constructor(private writer:HidWriter,readonly id=41){}
  async create(){await this.writer.uHidCreate({id:this.id,vendorId:0x18d1,productId:0x4ee7,name:keyboardName,data:keyboardDescriptor});}
  async key(action:number,code:number,meta:number){
    const usage=code>=29&&code<=54?code-25:code>=7&&code<=16?(code===7?39:code+22):usages[code];
    if(!usage&&!modifiers[code])return false;
    if(modifiers[code]){if(action===0)this.modifierKeys.add(code);else this.modifierKeys.delete(code);}
    else if(action===0){if(!this.down.has(usage!)&&this.down.size>=6)throw new Error('HID supports at most six simultaneous keys');this.down.add(usage!);}else this.down.delete(usage!);
    let mask=(meta&4096?1:0)|(meta&1?2:0)|(meta&2?4:0)|(meta&65536?8:0);for(const held of this.modifierKeys)mask|=modifiers[held]!;
    const data=new Uint8Array(8);data[0]=mask;data.set([...this.down],2);await this.writer.uHidInput({id:this.id,data});return true;
  }
  async release(){this.down.clear();this.modifierKeys.clear();await this.writer.uHidInput({id:this.id,data:new Uint8Array(8)});}
  async close(){try{await this.release();}finally{await this.writer.uHidDestroy(this.id);}}
}
