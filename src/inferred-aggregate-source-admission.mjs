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
