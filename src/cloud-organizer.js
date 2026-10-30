'use strict';
const fs = require('node:fs/promises'), path = require('node:path');
const { cloudRelative } = require('./storage-layout');
async function hashFile(file){const hash=require('node:crypto').createHash('sha256');for await(const chunk of require('node:fs').createReadStream(file)){hash.update(chunk);await new Promise(resolve=>setImmediate(resolve));}return hash.digest('hex');}
function createOrganizer({cfg,store,backup,settings}) {
  const journal = path.join(cfg.DATA_DIR,'cloud-folder-moves.ndjson');
  let state = {running:false,done:0,total:0,failed:0,cancelled:false,message:'',canUndo:false}, cancel = false;
  fs.access(journal).then(()=>{state.canUndo=true;},()=>{});
  const inside = (root,file) => { const rel=path.relative(root.toLowerCase(),file.toLowerCase()); return !!rel&&!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel); };
  const stat = file => fs.lstat(file).catch(()=>null);
  async function safeParent(root,file){let parent=path.dirname(file);while(!await stat(parent)){const next=path.dirname(parent);if(next===parent)throw Error('No accessible destination parent.');parent=next;}const real=await fs.realpath(parent);if(real.toLowerCase()!==root.toLowerCase()&&!inside(root,real))throw Error('Destination leaves the selected cloud folder.');}
  async function moveWithoutReplacement(from,to,expected){
    const before=await fs.stat(from);
    await fs.copyFile(from,to,require('node:fs').constants.COPYFILE_EXCL);
    if(await hashFile(to)!==expected)throw Error('The copied file did not pass its content check. Original left in place.');
    if(await hashFile(from)!==expected)throw Error('The source changed during organization. Both copies were left in place.');
    await fs.utimes(to,before.atime,before.mtime);
    await fs.unlink(from);
  }
  async function plan() {
    if(!cfg.CLOUD_ROOT)throw Error('Choose a cloud folder first.');
    const root=await fs.realpath(cfg.CLOUD_ROOT), bySource=new Map();
    for(const rec of store.listRecords({}).filter(r=>!r.sample)) {
      const from=path.join(cfg.CLOUD_ROOT,cloudRelative(rec,'flat')),to=path.join(cfg.CLOUD_ROOT,cloudRelative(rec,'source-date'));
      if(!bySource.has(from))bySource.set(from,new Set());bySource.get(from).add(to);
    }
    const rows=[];let conflicts=0;
    for(const [from,targets] of bySource) {
      if(targets.size!==1){conflicts++;continue;}
      const to=[...targets][0], info=await stat(from);
      if(!info?.isFile()||info.isSymbolicLink())continue;
      if(!inside(root,await fs.realpath(from))||!inside(path.resolve(cfg.CLOUD_ROOT),path.resolve(to))){conflicts++;continue;}
      if(await stat(to)){conflicts++;continue;}
      rows.push({from,to,size:info.size,mtime:info.mtimeMs});
    }
    return {root,rows,conflicts};
  }
  async function preview(){const p=await plan();return {count:p.rows.length,bytes:p.rows.reduce((n,r)=>n+r.size,0),conflicts:p.conflicts,examples:p.rows.slice(0,5).map(r=>({from:r.from,to:r.to}))};}
  function start(undo=false) {
    if(state.running||backup.statusBusy?.())return {ok:false,error:'A storage operation is already running.'};
    if(!undo&&!cfg.CLOUD_ROOT)return {ok:false,error:'Choose a cloud folder first.'};
    state={...state,running:true,done:0,total:0,failed:0,cancelled:false,message:undo?'Restoring previous folders…':'Organizing existing cloud files…'};cancel=false;cfg.CLOUD_ORGANIZING=true;
    (async()=>{
      try {
        let root,rows;
        if(undo){root=await fs.realpath(cfg.CLOUD_ROOT);rows=(await fs.readFile(journal,'utf8')).split('\n').filter(Boolean).map(line=>JSON.parse(line)).reverse();}
        else {const p=await plan();root=p.root;rows=p.rows;settings.write({cloudLayout:'source-date'});cfg.CLOUD_LAYOUT='source-date';}
        state.total=rows.length;
        await fs.mkdir(cfg.DATA_DIR,{recursive:true});
        const retained=[];
        for(const row of rows) {
          if(cancel){state.cancelled=true;break;}
          const from=undo?row.to:row.from,to=undo?row.from:row.to;
          try {
            if(!inside(path.resolve(cfg.CLOUD_ROOT),path.resolve(from))||!inside(path.resolve(cfg.CLOUD_ROOT),path.resolve(to)))throw Error('The configured cloud folder changed; previous moves cannot be restored here.');
            const info=await stat(from);
            if(!info){
              if(undo&&row.hash&&await stat(to)&&inside(root,await fs.realpath(to))&&await hashFile(to)===row.hash){state.done++;continue;}
              throw Error('A file is no longer available. Reconnect its drive and retry.');
            }
            if(!inside(root,await fs.realpath(from)))throw Error('File leaves the selected cloud folder.');
            await safeParent(root,to);
            if(!info.isFile()||info.isSymbolicLink()||info.size!==row.size||(Math.abs(info.mtimeMs-row.mtime)>2&&!(undo&&row.hash&&await hashFile(from)===row.hash)))throw Error('File changed after preview; left in place.');
            const destination=await stat(to);
            if(destination){
              if(!destination.isFile()||destination.isSymbolicLink()||!inside(root,await fs.realpath(to)))throw Error('Destination leaves the selected cloud folder.');
              if(undo&&row.hash&&await hashFile(from)===row.hash&&await hashFile(to)===row.hash){await fs.unlink(from);state.done++;continue;}
              throw Error('Destination already exists; left both files in place.');
            }
            await fs.mkdir(path.dirname(to),{recursive:true});
            if(!inside(root,await fs.realpath(path.dirname(to))))throw Error('Destination leaves the selected cloud folder.');
            const hash=row.hash||await hashFile(from);
            if(!undo){row.hash=hash;await fs.appendFile(journal,JSON.stringify(row)+'\n');state.canUndo=true;}
            await moveWithoutReplacement(from,to,hash);state.done++;
          } catch(e){state.failed++;state.message=e.message;if(undo)retained.push(row);}
          await new Promise(resolve=>setImmediate(resolve));
        }
        if(undo&&!state.cancelled){if(retained.length)await fs.writeFile(journal,retained.reverse().map(r=>JSON.stringify(r)).join('\n')+'\n');else{await fs.rm(journal,{force:true});state.canUndo=false;}}
        state.message=`${state.done} file${state.done===1?'':'s'} ${undo?'restored':'organized'}${state.failed?' · '+state.failed+' left in place':''}${state.cancelled?' · stopped':''}.`;
      }catch(error){state.message=error.message;state.failed++;}
      finally{state.running=false;cfg.CLOUD_ORGANIZING=false;}
    })();
    return {ok:true,started:true};
  }
  return {preview,start:()=>start(false),undo:()=>start(true),stop:()=>{cancel=true;return {ok:true};},status:()=>({...state})};
}
let instance;
const get=()=>instance ||= createOrganizer({cfg:require('./config'),store:require('./store'),backup:require('./backup'),settings:require('./settings')});
module.exports={createOrganizer,preview:()=>get().preview(),start:()=>get().start(),undo:()=>get().undo(),stop:()=>get().stop(),status:()=>get().status()};
