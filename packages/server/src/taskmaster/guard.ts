import type { Proposal } from './rules';
const RECIPIENTS=new Set(['john','xo','major-build','captain-ci']);
const FORBIDDEN=/\b(charge|bill|invoice|refund|pay|wire|transfer funds|purchase|discount|email the customer|text the customer|deploy|merge (?:to|into)|push to prod|publish the listing)\b/i;
export function validateProposal(p:Proposal):{allowed:boolean;reason?:string}{if(!['deliver_ruling','nudge','escalate_p0','digest'].includes(p.actionType))return{allowed:false,reason:'effect_not_allowlisted'};if(!RECIPIENTS.has(p.recipient.trim().toLowerCase()))return{allowed:false,reason:'recipient_not_allowlisted'};const match=p.body.replace(/\s+/g,' ').match(FORBIDDEN);return match?{allowed:false,reason:`forbidden_effect:${match[0]}`}:{allowed:true};}
