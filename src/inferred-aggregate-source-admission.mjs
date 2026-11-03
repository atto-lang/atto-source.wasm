/**
 * AttoLang source admission for a Wasm bridge without a typed aggregate ABI.
 * This is a lexical denial gate, not an aggregate parser or positive compiler.
 * The real backend must revalidate all source in its own lexer/type checker.
 */
const MAX_COMMENT_NESTING = 64;
const MAX_GENERIC_NESTING = 32;
const MAX_TOKENS = 100_000;

function tokenize(input) {
  const text = new TextDecoder('utf-8', {fatal:true}).decode(input);
  const tokens = [];
  const idStart = c => c !== undefined && /[A-Za-z_]/.test(c);
  const idPart = c => c !== undefined && /[A-Za-z0-9_]/.test(c);
  for (let i = 0; i < text.length;) {
    const c = text[i];
    if (/\s/.test(c)) {i++;continue;}
    if (c==='/' && text[i+1]==='/') {
      i+=2;
      while (i<text.length && !'\r\n\u0085\u2028\u2029'.includes(text[i])) i++;
      continue;
    }
    if (c==='/' && text[i+1]==='*') {
      const start=i;
      i+=2;
      let depth=1;
      while(i<text.length && depth>0) {
        if (text[i]==='/'&&text[i+1]==='*') {
          if(++depth>MAX_COMMENT_NESTING) throw new SyntaxError('aggregate admission comment nesting exceeded at '+i);
          i+=2;
        } else if(text[i]==='*'&&text[i+1]==='/') {depth--;i+=2;}
        else i++;
      }
      if(depth) throw new SyntaxError('unterminated aggregate admission comment at '+start);
      continue;
    }
    if (c==='"'||c==="'"||c===String.fromCharCode(96)) {
      const start=i++, delimiter=c;
      let closed=false;
      while(i<text.length) {
        const ch=text[i++];
        if(ch==='\\') {if(i>=text.length)break;i++;continue;}
        if(ch===delimiter){closed=true;break;}
      }
      if(!closed)throw new SyntaxError('unterminated aggregate admission string at '+start);
      continue;
    }
    if (idStart(c)) {
      const start=i++;
      while(idPart(text[i]))i++;
      tokens.push({value:text.slice(start,i),at:start,identifier:true});
    } else { tokens.push({value:c,at:i++,identifier:false}); }
    if(tokens.length>MAX_TOKENS)throw new SyntaxError('aggregate admission token budget exceeded');
  }
  return tokens;
}

function aggregateTypeAfterInfer(tokens,index) {
  let i=index+1;
  if(tokens[i]?.value==='<'){
    let depth=0;
    do {
      const token=tokens[i];
      if(!token)return -1;
      if(token.value==='<'){
        if(++depth>MAX_GENERIC_NESTING)throw new SyntaxError('aggregate inference type nesting exceeded at '+token.at);
      }else if(token.value==='>')depth--;
      i++;
    }while(depth>0);
    if(depth!==0)return -1;
  }
  if(!['struct','record'].includes(tokens[i]?.value))return -1;
  return i;
}

export function rejectUnsupportedInferredAggregateSource(sourceBytes) {
  const tokens=tokenize(sourceBytes);
  for(let i=0;i<tokens.length;i++){
    const token=tokens[i];
    if(!token.identifier)continue;
    if(token.value==='infer') {
      const after=aggregateTypeAfterInfer(tokens,i);
      if(after!==-1)
        throw new Error('wasm inferred aggregate lowering unsupported at character '+token.at);
    }
    if((token.value==='struct'||token.value==='record')&&tokens[i+1]?.value==='{')
      throw new Error('wasm inferred aggregate lowering unsupported at character '+token.at);
  }
}
/**
 * The scalar Wasm bridge has no typed ABI for structural parameter/return
 * loans. The older tuple-v2 preflight checked only the first parameter.
 * Track callable parameter lists, rather than treating arbitrary function
 * calls as type syntax: `foo(structural(42))` is a contextual function call.
 * The native compiler remains the grammar/type-system authority.
 */
export function rejectUnsupportedStructuralLoanSource(sourceBytes) {
  const tokens=tokenize(sourceBytes);
  const inParams=new Uint8Array(tokens.length);
  for(let i=0;i<tokens.length;i++){
    if(!tokens[i].identifier||!['fnc','routine','method'].includes(tokens[i].value)||
       !tokens[i+1]?.identifier)continue;
    let cursor=i+2;
    if(tokens[cursor]?.value==='<'){
      let depth=0;
      for(;cursor<tokens.length;cursor++){
        if(tokens[cursor].value==='<')depth++;
        else if(tokens[cursor].value==='>'&&--depth===0){cursor++;break;}
      }
      if(depth!==0)continue;
    }
    if(tokens[cursor]?.value!=='(')continue;
    let nesting=0;
    const first=cursor;
    for(;cursor<tokens.length;cursor++){
      if(tokens[cursor].value==='(')nesting++;
      else if(tokens[cursor].value===')'){
        if(--nesting===0)break;
      }
      if(cursor>first&&nesting>0)inParams[cursor]=1;
    }
  }
  for(let i=0;i<tokens.length;i++){
    const token=tokens[i];
    if(!token.identifier||token.value!=='structural')continue;
    const prior=tokens[i-1]?.value;
    const next=tokens[i+1];
    const shapeStart=next?.identifier||next?.value==='{'||next?.value==='(';
    if(prior==='infer'&&shapeStart)
      throw new Error('wasm invalid infer structural constructor at character '+token.at);
    const typePosition=inParams[i]===1||prior===':'||
      (prior==='>'&&tokens[i-2]?.value==='-');
    if(typePosition&&shapeStart)
      throw new Error('wasm structural readonly-view ABI unsupported at character '+token.at);
  }
}
