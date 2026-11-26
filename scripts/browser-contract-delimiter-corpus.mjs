// Reuse the real Chrome Worker gate's 24-case typed corpus adapter.
// These are bounded scalar contracts, not arbitrary annotations/methods.
const cases=[];
const forms=[['brace-inline',' {','}'],['brace-next','\n{','}'],['begin','\nbegin','end'],['colon-inline',' ::','end'],['colon-next','\n::','end']];
const program=(open,close,a,b)=>'fnc divide(int a, int b) -> int\n    requires b != 0'+open+'\n    return a / b;\n'+close+'\npub fnc main() -> int { return divide('+a+', '+b+'); }\n';
const add=(id,text,expected)=>cases.push({source:'generated-binding-'+id+'.atto',text,expected});
for(const [id,open,close] of forms){
 add(id+'-positive',program(open,close,84,2),{kind:'value',decimal:'42'});
 add(id+'-negative',program(open,close,-85,2),{kind:'value',decimal:'-42'});
 add(id+'-overflow',program(open,close,'-9223372036854775808',-1),{kind:'arithmeticFailure',category:'integerOverflow'});
 add(id+'-zero',program(open,close,84,0),{kind:'diagnostic',category:'E_REFINEMENT_PRECONDITION'});
}
for(const [id,open,close] of [['inline-begin',' begin','end'],['wrong-closer',' ::','}'],['missing-end',' ::',''],['combined-openers',' :: begin','end']])
 add(id,program(open,close,84,2),{kind:'diagnostic',category:'E_SYNTAX'});
if(cases.length!==24||new Set(cases.map(c=>c.source)).size!==24)throw Error('contract corpus identity');
export const typedBindingCases=Object.freeze(cases.map(c=>Object.freeze({...c,expected:Object.freeze(c.expected)})));
