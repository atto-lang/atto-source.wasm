const pre='type Bounded = int where self >= 1 and self <= 42; ';
const cases=[];
const add=(id,text,expected)=>cases.push({source:'generated-binding-'+id+'.atto',text,expected,verification:'strict'});
const src=(a,k,o,c,arg)=>pre+a+'fnc divide(int a, int b) -> int '+k+o+' return a / b; '+c+' pub fnc main() -> int { return divide(84, '+arg+'); }';
for(const [id,o,c] of [['brace',' {','}'],['begin','\nbegin','end'],['colon',' ::','end'],['next-colon','\n::','end']]){
 const a='@requires(b != 0)\n',k='requires b != -1';
 for(const [tag,ann,kw] of [['keyword','','requires b != 0 requires b != -1'],['annotation',a+'@requires(b != -1)\n',''],['mixed',a,k]])
   add(id+'-'+tag,src(ann,kw,o,c,2),{kind:'value',decimal:'42'});
 for(const [tag,arg] of [['zero',0],['minus-one',-1]])
   add(id+'-'+tag,src(a,k,o,c,arg),{kind:'diagnostic',category:'E_REFINEMENT_PRECONDITION'});
 add(id+'-invalid',src('@requires(b != 0 && b != -1)\n','',o,c,2),{kind:'diagnostic',category:'E_REFINEMENT_CONTRACT'});
}
if(cases.length!==24||new Set(cases.map(c=>c.source)).size!==24)throw Error('contract annotation corpus identity');
export const typedBindingCases=Object.freeze(cases.map(c=>Object.freeze({...c,expected:Object.freeze(c.expected)})));
