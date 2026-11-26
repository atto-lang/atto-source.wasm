// Strict, source-only interpreter for a tiny Atto expression subset.
// No eval/new Function/vm/dynamic imports and no access to host globals
// from Atto source text. Unsupported syntax fails closed.
export function atto_pure(source, name, deps={}) {
  if (!/^[a-z][a-z0-9_]*$/.test(name)) throw Error('bad function name');
  const pattern=new RegExp('pub fnc '+name+'\\(([^)]*)\\) -> (bool|String|int) \\{([\\s\\S]*?)\\n\\}');
  const found=source.match(pattern);
  if(!found)throw Error('missing pure Atto function '+name);
  const params=found[1].trim()===''?[]:found[1].split(',').map(part=>{
    const match=part.trim().match(/^(int|bool|String)\s+([a-z_][a-z0-9_]*)$/);
    if(!match)throw Error('unsupported parameter');
    return {type:match[1],name:match[2]};
  });
  if(params.length>8)throw Error('too many parameters');
  const body=found[3].trim();
  if(body.length>8192)throw Error('pure subset body too long');
  const re=/\s*("(?:[^"\\]|\\.)*"|==|!=|<=|>=|\|\||&&|[()!,;+\-*<>]|[A-Za-z_][A-Za-z_0-9]*|[0-9]+)\s*/y;
  const tokens=[];
  let offset=0;
  while(offset<body.length){
    re.lastIndex=offset;
    const match=re.exec(body);
    if(!match || re.lastIndex<=offset)throw Error('unsupported Atto token at '+offset);
    tokens.push(match[1]);
    offset=re.lastIndex;
    if(tokens.length>512)throw Error('too many tokens');
  }
  let cursor=0;
  const peek=()=>tokens[cursor];
  const consume=()=>tokens[cursor++];
  function expect(word){
    if(consume()!==word)throw Error('expected '+word);
  }
  const prec={'||':1,'&&':2,'==':3,'!=':3,'<':3,'>':3,'<=':3,'>=':3,'+':4,'-':4,'*':5};
  function primary(){
    const token=consume();
    if(token===undefined)throw Error('unexpected EOF in expression');
    if(token==='!')return {kind:'not',value:primary()};
    if(token==='('){
      const node=expression(0);
      expect(')');
      return node;
    }
    if(token==='true'||token==='false')return {kind:'lit',value:token==='true'};
    if(token.startsWith('"'))return {kind:'lit',value:JSON.parse(token)};
    if(/^\d+$/.test(token)){
      const num=Number(token);
      if(!Number.isSafeInteger(num))throw Error('unsafe number literal');
      return {kind:'lit',value:num};
    }
    if(!/^[A-Za-z_][A-Za-z_0-9]*$/.test(token))throw Error('bad identifier');
    if(peek()==='('){
      consume();
      const args=[];
      if(peek()!==')'){
        args.push(expression(0));
        while(peek()===','){consume();args.push(expression(0));}
      }
      expect(')');
      if(args.length>8)throw Error('too many call arguments');
      return {kind:'call',name:token,args};
    }
    return {kind:'var',name:token};
  }
  function expression(minPrec){
    let left=primary();
    while(Object.hasOwn(prec,peek())&&prec[peek()]>=minPrec){
      const op=consume();
      const right=expression(prec[op]+1);
      left={kind:'binary',op,left,right};
    }
    return left;
  }
  function statements(stop){
    const nodes=[];
    while(cursor<tokens.length && peek()!==stop){
      if(peek()==='if'){
        consume();
        const condition=expression(0);
        expect(';');
        expect('do');
        const then=statements('fi');
        expect('fi');
        nodes.push({kind:'if',condition,then});
      }else if(peek()==='return'){
        consume();
        const value=expression(0);
        expect(';');
        nodes.push({kind:'return',value});
      }else{
        throw Error('unsupported Atto statement: '+peek());
      }
    }
    return nodes;
  }
  const program=statements(null);
  if(cursor!==tokens.length)throw Error('trailing source');
  function value(node, env, depth){
    if(depth>32)throw Error('Atto interpreter depth exceeded');
    if(node.kind==='lit')return node.value;
    if(node.kind==='var'){
      if(!Object.hasOwn(env,node.name))throw Error('unknown variable '+node.name);
      return env[node.name];
    }
    if(node.kind==='not')return !value(node.value,env,depth+1);
    if(node.kind==='call'){
      if(!Object.hasOwn(deps,node.name)||typeof deps[node.name]!=='function')
        throw Error('unbound call '+node.name);
      return deps[node.name](...node.args.map(x=>value(x,env,depth+1)));
    }
    if(node.kind==='binary'){
      const l=value(node.left,env,depth+1);
      if(node.op==='||')return Boolean(l)||Boolean(value(node.right,env,depth+1));
      if(node.op==='&&')return Boolean(l)&&Boolean(value(node.right,env,depth+1));
      const r=value(node.right,env,depth+1);
      switch(node.op){
        case '==':return l===r;
        case '!=':return l!==r;
        case '<':return l<r;
        case '>':return l>r;
        case '<=':return l<=r;
        case '>=':return l>=r;
        case '+':return l+r;
        case '-':return l-r;
        case '*':return l*r;
        default:throw Error('unknown operator');
      }
    }
    throw Error('unknown expression node');
  }
  function execute(nodes,env){
    for(const stmt of nodes){
      if(stmt.kind==='if'){
        if(value(stmt.condition,env,0)){
          const output=execute(stmt.then,env);
          if(output.returned)return output;
        }
      }else if(stmt.kind==='return'){
        return {returned:true,answer:value(stmt.value,env,0)};
      }else throw Error('unknown Atto statement');
    }
    return {returned:false};
  }
  return (...args)=>{
    if(args.length!==params.length)throw Error('arity mismatch');
    const env=Object.create(null);
    params.forEach((param,index)=>{
      const arg=args[index];
      if(param.type==='int'&&!Number.isSafeInteger(arg))throw Error('unsafe int argument');
      if(param.type==='bool'&&typeof arg!=='boolean')throw Error('non-bool argument');
      if(param.type==='String'&&typeof arg!=='string')throw Error('non-string argument');
      env[param.name]=arg;
    });
    const result=execute(program,env);
    if(!result.returned)throw Error('pure function fell through');
    if(found[2]==='bool'&&typeof result.answer!=='boolean')throw Error('non-bool result');
    if(found[2]==='String'&&typeof result.answer!=='string')throw Error('non-string result');
    return result.answer;
  };
}
