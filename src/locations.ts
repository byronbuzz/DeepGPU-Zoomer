import { validateView, type SavedView } from './state';
import defaultLocationsJson from './default-locations.json?raw';

type Choice={kind:'saved';name:string;view:SavedView};
export type LocationIdentity=Pick<Choice,'kind'|'name'>;
export type SavedLocation={name:string;view:SavedView};
const STORAGE_KEY='gpu-zoomer-locations';
const DEFAULT_LOCATIONS_KEY='gpu-zoomer-default-locations-2026-10-03-v1';
const BACKUP_FORMAT='deepgpu-zoomer-locations';
const nameKey=(name:string)=>name.toLocaleLowerCase();

/** Validate every entry before either importing it or treating stored data as writable. */
export function validateSavedLocations(value:unknown,allowDuplicateNames=false):SavedLocation[]{
  if(!Array.isArray(value))throw new Error('Invalid locations');
  const names=new Set<string>();
  return value.map(item=>{
    if(!item||typeof item.name!=='string'||!item.name.trim())throw new Error('Invalid location');
    const key=nameKey(item.name);
    if(!allowDuplicateNames&&names.has(key))throw new Error('Duplicate location name');
    names.add(key);return {name:item.name,view:validateView(item.view)};
  });
}
export function parseLocationBackup(value:unknown):SavedLocation[]{
  if(Array.isArray(value))return validateSavedLocations(value,true);
  const backup=value as {format?:unknown;version?:unknown;locations?:unknown}|null;
  if(!backup||backup.format!==BACKUP_FORMAT||backup.version!==1)throw new Error('Unsupported location backup');
  return validateSavedLocations(backup.locations,true);
}
/** Repeated imports are safe, including entries previously renamed after a conflict. */
export function mergeSavedLocations(current:SavedLocation[],incoming:SavedLocation[]){
  const locations=[...current],names=new Map(current.map(item=>[nameKey(item.name),JSON.stringify(item.view)]));
  let added=0,duplicates=0,renamed=0;
  for(const item of incoming){
    const view=JSON.stringify(item.view);let name=item.name,suffix=2;
    while(names.has(nameKey(name))&&names.get(nameKey(name))!==view)name=`${item.name} (${suffix++})`;
    if(names.has(nameKey(name))){duplicates++;continue;}
    locations.push({name,view:item.view});names.set(nameKey(name),view);added++;if(name!==item.name)renamed++;
  }
  return {locations,added,duplicates,renamed};
}
const readSavedLocations=()=>validateSavedLocations(JSON.parse(localStorage.getItem(STORAGE_KEY)??'[]'));

/** Editable location picker. Its floating list never moves the action buttons. */
export function setupLocations(snapshot:()=>SavedView,navigate:(view:SavedView)=>void,message:(text:string)=>void){
  const el=<T extends HTMLElement>(id:string)=>document.getElementById(id) as T;
  const entry=el<HTMLInputElement>('location-entry'),list=el('location-options'),toggle=el<HTMLButtonElement>('location-toggle');
  const save=el<HTMLButtonElement>('save'),remove=el<HTMLButtonElement>('delete-location');
  const backup=el<HTMLButtonElement>('backup-locations'),restoreBackup=el<HTMLButtonElement>('restore-locations'),restoreFile=el<HTMLInputElement>('restore-locations-file');
  const confirmation=el('replace-location'),confirm=el<HTMLButtonElement>('replace-confirm'),cancel=el<HTMLButtonElement>('replace-cancel');
  let saved:SavedLocation[]=[],writable=true,restoring=false,recoveryError=false,selected:Choice|null=null,choices:Choice[]=[],active=-1;
  let pending:(()=>void)|null=null,confirmationSource=save;
  try{saved=readSavedLocations();}catch{writable=false;}
  if(writable)try{
    if(localStorage.getItem(DEFAULT_LOCATIONS_KEY)!=='1'){
      const defaults=parseLocationBackup(JSON.parse(defaultLocationsJson));
      const merged=mergeSavedLocations(saved,defaults);
      localStorage.setItem(STORAGE_KEY,JSON.stringify(merged.locations));saved=merged.locations;
      localStorage.setItem(DEFAULT_LOCATIONS_KEY,'1');
    }
  }catch{recoveryError=true;}
  const sync=()=>{remove.disabled=selected?.kind!=='saved'||!writable||restoring;save.disabled=!writable||restoring;backup.disabled=!writable;restoreBackup.disabled=!writable||restoring;restoreBackup.textContent=restoring?'Restoring…':'Restore locations';};
  const close=()=>{list.hidden=true;active=-1;entry.setAttribute('aria-expanded','false');toggle.setAttribute('aria-expanded','false');entry.removeAttribute('aria-activedescendant');};
  const dismiss=()=>{pending=null;confirmation.hidden=true;};
  const clear=()=>{dismiss();close();selected=null;entry.value='';sync();};
  const position=()=>{
    const anchor=entry.getBoundingClientRect(),actions=remove.getBoundingClientRect();
    const above=anchor.top-14,below=innerHeight-actions.bottom-14;
    const upward=above>=Math.min(220,list.scrollHeight+2)||above>=below;
    list.style.width=anchor.width+'px';list.style.left=anchor.left+'px';
    list.style.maxHeight=Math.max(24,Math.min(220,upward?above:below))+'px';
    list.style.top=(upward?anchor.top-list.getBoundingClientRect().height-6:actions.bottom+6)+'px';
  };
  const highlight=()=>{
    list.querySelectorAll<HTMLElement>('[role=option]').forEach((option,index)=>option.setAttribute('aria-selected',String(index===active)));
    const option=active>=0?list.children[active] as HTMLElement:undefined;
    if(option){entry.setAttribute('aria-activedescendant',option.id);option.scrollIntoView({block:'nearest'});}else entry.removeAttribute('aria-activedescendant');
  };
  const choose=(choice:Choice)=>{navigate(choice.view);selected=choice;entry.value=choice.name;dismiss();close();sync();};
  const open=(filter=false)=>{
    dismiss();active=-1;const query=filter?entry.value.trim().toLocaleLowerCase():'';
    choices=saved.map(item=>({...item,kind:'saved' as const})).reverse().filter(item=>item.name.toLocaleLowerCase().includes(query));
    list.replaceChildren();
    choices.forEach((choice,index)=>{
      const option=document.createElement('div');option.id=`location-option-${index}`;option.className='location-option';option.setAttribute('role','option');option.textContent=choice.name;
      option.dataset.locationKind=choice.kind;option.onpointerdown=event=>event.preventDefault();option.onclick=()=>choose(choice);list.append(option);
    });
    if(!choices.length){const empty=document.createElement('div');empty.className='location-empty';empty.textContent='No matching location. Save to create one.';list.append(empty);}
    list.hidden=false;entry.setAttribute('aria-expanded','true');toggle.setAttribute('aria-expanded','true');highlight();position();
  };
  // Body placement avoids clipping by the controls panel's scroll container.
  document.body.append(list);
  entry.onfocus=()=>open();entry.onclick=()=>{if(list.hidden)open();};
  entry.oninput=()=>{selected=null;sync();open(true);};
  entry.onblur=close;
  entry.onkeydown=event=>{
    if(event.key==='ArrowDown'||event.key==='ArrowUp'){
      event.preventDefault();if(list.hidden)open();
      if(choices.length){active=event.key==='ArrowDown'?(active+1)%choices.length:active<0?choices.length-1:(active-1+choices.length)%choices.length;highlight();}
    }else if(event.key==='Enter'&&!list.hidden&&active>=0){event.preventDefault();choose(choices[active]);}
    else if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();dismiss();}
    else if(event.key==='Tab')close();
  };
  toggle.onpointerdown=event=>event.preventDefault();toggle.onclick=()=>{if(list.hidden){entry.focus();open();}else close();};
  document.addEventListener('pointerdown',event=>{if(!list.contains(event.target as Node)&&!el('location-field').contains(event.target as Node))close();},true);
  el('controls').addEventListener('scroll',close,true);window.addEventListener('resize',close);
  el('toggle').addEventListener('click',close);el('controls').addEventListener('click',event=>{if((event.target as HTMLElement).closest('[role=tab]'))close();});
  const commit=(next:typeof saved,success:()=>void,failure='Local storage is unavailable. Copy a share link instead.')=>{
    try{localStorage.setItem(STORAGE_KEY,JSON.stringify(next));saved=next;success();dismiss();close();sync();}
    catch{dismiss();message(failure);}
  };
  const currentSaved=()=>{
    try{return readSavedLocations();}
    catch{writable=false;sync();throw new Error('Stored locations could not be read.');}
  };
  backup.onclick=()=>{
    if(!writable)return;
    let current:SavedLocation[];
    try{current=currentSaved();}catch{message('Stored locations could not be read. Backup and restore are disabled to preserve the data.');return;}
    try{
      const date=new Date(),data={format:BACKUP_FORMAT,version:1,createdAt:date.toISOString(),locations:current};
      const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)+'\n'],{type:'application/json'})),link=document.createElement('a');
      link.href=url;link.download=`deepgpu-zoomer-locations-${date.toISOString().replace(/[:.]/g,'-')}.json`;
      document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),60_000);
      message(`Backup download started for ${current.length} saved location${current.length===1?'':'s'}.`);
    }catch{message('The backup download could not be started. Saved locations were kept.');}
  };
  restoreBackup.onclick=()=>{if(!writable||restoring)return;dismiss();close();restoreFile.value='';restoreFile.click();};
  restoreFile.onchange=async()=>{
    const file=restoreFile.files?.[0];if(!file||!writable||restoring)return;
    restoring=true;sync();
    try{
      let incoming:SavedLocation[];
      try{incoming=parseLocationBackup(JSON.parse((await file.text()).replace(/^\uFEFF/,'')));}
      catch{message('This file is not a valid location backup. No locations were changed.');return;}
      let current:SavedLocation[];
      try{current=currentSaved();}catch{message('Stored locations could not be read. Restore was cancelled to preserve the data.');return;}
      const merged=mergeSavedLocations(current,incoming);
      if(!merged.added){message(incoming.length?'All locations in this backup are already saved.':'This backup contains no saved locations.');return;}
      commit(merged.locations,()=>{
        if(selected?.kind==='saved'&&!saved.some(item=>item.name===selected!.name)){selected=null;entry.value='';}
        message(`${merged.added} location${merged.added===1?'':'s'} restored.${merged.renamed?` ${merged.renamed} renamed to keep both versions.`:''}`);
      },'Locations could not be restored. The existing saved collection was kept.');
    }finally{restoring=false;restoreFile.value='';sync();}
  };
  const store=(name:string,index:number,nextView:SavedView)=>{
    const next=saved.filter((_,i)=>i!==index);next.push({name,view:nextView});
    commit(next,()=>{selected={kind:'saved',name,view:nextView};entry.value=name;message(index<0?'Location saved on this browser.':'Location updated on this browser.');});
  };
  const ask=(text:string,label:string,source:HTMLButtonElement,action:()=>void)=>{
    close();pending=action;confirmationSource=source;el('replace-location-text').textContent=text;confirm.textContent=label;confirmation.hidden=false;cancel.focus();
  };
  save.onclick=()=>{
    if(!writable||restoring)return;
    const name=entry.value.trim()||`${snapshot().family} ${saved.length+1}`,next=snapshot();
    const index=saved.findIndex(item=>item.name.toLocaleLowerCase()===name.toLocaleLowerCase());
    if(index<0){store(name,-1,next);return;}
    if(selected?.kind==='saved'&&selected.name===saved[index].name){store(saved[index].name,index,next);return;}
    ask(`Replace saved location “${saved[index].name}” with this view?`,'Replace location',save,()=>store(name,index,next));
  };
  remove.onclick=()=>{
    if(selected?.kind!=='saved'||!writable||restoring)return;
    const name=selected.name;
    ask('Delete saved location?','Delete location',remove,()=>commit(saved.filter(item=>item.name!==name),()=>{clear();message('Saved location deleted. The current view was kept.');}));
  };
  cancel.onclick=()=>{dismiss();confirmationSource.focus();};
  confirm.onclick=()=>{const action=pending;action?.();(confirmationSource.disabled?save:confirmationSource).focus();};
  confirmation.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();dismiss();confirmationSource.focus();}});
  sync();
  return {clear,dismiss,identity:():LocationIdentity|null=>selected?{kind:selected.kind,name:selected.name}:null,
    restore(identity:LocationIdentity|null){clear();if(identity){const choice=saved.find(item=>item.name===identity.name);if(choice)selected={...choice,kind:'saved'};}entry.value=selected?.name??'';sync();},storageError:!writable,recoveryError};
}
