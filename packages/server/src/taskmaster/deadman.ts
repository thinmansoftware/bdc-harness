let lastHeartbeat:number|null=null;
export function recordTickHeartbeat(now=Date.now()):void{lastHeartbeat=now;}
export function isTickStale(intervalMs:number,now=Date.now()):boolean{return lastHeartbeat!==null&&now-lastHeartbeat>=intervalMs*3;}
export function resetTickHeartbeat():void{lastHeartbeat=null;}
