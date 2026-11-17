use std::{collections::BTreeMap, env, fs, path::{Component, Path}, process::Command};

fn git(repo: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git").current_dir(repo).args(args).output()
        .map_err(|e| format!("git {:?}: {e}", args))?;
    if !out.status.success() {
        return Err(format!("git {:?} failed: {}", args, String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_owned())
}
fn hex(s: &str, n: usize) -> bool { s.len() == n && s.bytes().all(|b| b.is_ascii_hexdigit()) }
fn safe_path(s: &str) -> bool {
    !s.is_empty() && !s.starts_with('-') && !s.contains('\0') && !s.contains('\\')
        && !Path::new(s).is_absolute()
        && Path::new(s).components().all(|c| matches!(c, Component::Normal(_)))
}
fn json_escape(s: &str) -> String {
    let mut out = String::new();
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c.is_control() => out.push(' '),
            c => out.push(c),
        }
    }
    out
}
fn parse_kv(path: &Path) -> Result<BTreeMap<String,String>,String> {
    let m=fs::symlink_metadata(path).map_err(|e|format!("receipt metadata: {e}"))?;
    if !m.file_type().is_file() || m.len()==0 || m.len()>16*1024 { return Err("receipt must be a bounded regular file".into()); }
    let b=fs::read(path).map_err(|e|format!("receipt read: {e}"))?;
    if b.len() as u64 != m.len() { return Err("receipt changed during read".into()); }
    let s=std::str::from_utf8(&b).map_err(|_|"receipt is not UTF-8")?;
    let mut map=BTreeMap::new();
    for (i,line) in s.lines().enumerate() {
        if line.is_empty() || line.starts_with('#') { continue; }
        let (k,v)=line.split_once('=').ok_or_else(||format!("receipt line {} lacks '='",i+1))?;
        if k.is_empty() || v.is_empty() || map.insert(k.to_owned(),v.to_owned()).is_some() {
            return Err(format!("receipt line {} has empty or duplicate key/value",i+1));
        }
    }
    Ok(map)
}
fn verify(repo:&Path,head:&str,manifest:&str,manifest_sha:&str,class:&str,receipt:Option<&str>)->Result<String,String>{
    if !hex(head,40)||!hex(manifest_sha,40){return Err("expected commit and manifest must be full Git SHA-1 values".into());}
    if !safe_path(manifest){return Err("manifest path must be safe and repository-relative".into());}
    if !["host-only","source-only","guest-executed"].contains(&class){return Err("invalid evidence class".into());}
    let actual_head=git(repo,&["rev-parse","HEAD"])?;
    if actual_head!=head{return Err(format!("commit mismatch: expected {head}, observed {actual_head}"));}
    let tree=git(repo,&["rev-parse","HEAD^{tree}"])?;
    if !git(repo,&["status","--porcelain","--untracked-files=all"])?.is_empty(){return Err("working tree is not clean".into());}
    let actual_manifest=git(repo,&["rev-parse",&format!("HEAD:{manifest}")])?;
    if actual_manifest!=manifest_sha{return Err("manifest itself does not match its pinned Git blob SHA".into());}
    let path=repo.join(manifest);
    let meta=fs::symlink_metadata(&path).map_err(|e|format!("manifest metadata: {e}"))?;
    if !meta.file_type().is_file() || meta.len()==0 || meta.len()>1024*1024 {
        return Err("manifest must be a bounded regular, non-symlink file".into());
    }
    #[cfg(unix)] {
        use std::os::unix::fs::MetadataExt;
        if meta.nlink()!=1 { return Err("manifest hardlinks are refused".into()); }
    }
    let b=fs::read(&path).map_err(|e|format!("manifest read: {e}"))?;
    if b.len() as u64 != meta.len(){return Err("manifest changed during read".into());}
    let s=std::str::from_utf8(&b).map_err(|_|"manifest is not UTF-8")?;
    let mut pins=BTreeMap::new();
    for (i,raw) in s.lines().enumerate(){
        let line=raw.trim_end_matches('\r');
        if line.is_empty()||line.starts_with('#'){continue;}
        let (sha,file)=line.split_once('\t').ok_or_else(||format!("manifest line {} must be SHA<TAB>path",i+1))?;
        if !hex(sha,40)||!safe_path(file)||file==manifest{return Err(format!("invalid manifest entry at line {}",i+1));}
        if pins.insert(file.to_owned(),sha.to_ascii_lowercase()).is_some(){return Err(format!("duplicate manifest path: {file}"));}
    }
    if pins.is_empty(){return Err("manifest contains no blob pins".into());}
    for (file,sha) in &pins{
        let disk=repo.join(file);
        let meta=fs::symlink_metadata(&disk).map_err(|e|format!("{file} metadata: {e}"))?;
        if !meta.file_type().is_file(){return Err(format!("{file} must be a regular non-symlink file"));}
        #[cfg(unix)] {
            use std::os::unix::fs::MetadataExt;
            if meta.nlink()!=1{return Err(format!("{file} hardlinks are refused"));}
        }
        let got=git(repo,&["rev-parse",&format!("HEAD:{file}")]).map_err(|e|format!("{file}: {e}"))?;
        if &got!=sha{return Err(format!("Git blob mismatch for {file}: expected {sha}, got {got}"));}
    }
    let (guest,claim)=match (class,receipt){
        ("guest-executed",Some(file))=>{
            let r=parse_kv(Path::new(file))?;
            let get=|k:&str|r.get(k).map(String::as_str).ok_or_else(||format!("guest receipt missing {k}"));
            if get("schema")?!="oreslang-guest-execution-receipt-v1"{return Err("guest receipt schema mismatch".into());}
            if get("source_commit")?!=actual_head||get("source_tree")?!=tree{return Err("guest receipt does not bind exact checked-out commit/tree".into());}
            for k in ["compiler_source_commit","compiler_source_tree"]{if !hex(get(k)?,40){return Err(format!("invalid {k}"));}}
            for k in ["compiler_sha256","wasm_sha256"]{if !hex(get(k)?,64){return Err(format!("invalid {k}"));}}
            let executed:u64=get("executed_cases")?.parse().map_err(|_|"invalid executed_cases")?;
            if executed==0{return Err("guest receipt must report executed_cases > 0".into());}
            let rejected:u64=get("rejected_cases")?.parse().map_err(|_|"invalid rejected_cases")?;
            (format!(",\"compiler_source_commit\":\"{}\",\"compiler_source_tree\":\"{}\",\"compiler_sha256\":\"{}\",\"wasm_sha256\":\"{}\",\"executed_cases\":{},\"rejected_cases\":{}",get("compiler_source_commit")?,get("compiler_source_tree")?,get("compiler_sha256")?,get("wasm_sha256")?,executed,rejected),true)
        },
        ("guest-executed",None)=>return Err("guest-executed requires a runtime receipt".into()),
        (_,Some(_))=>return Err("host/source-only evidence cannot include guest receipt".into()),
        (_,None)=>(String::new(),false)
    };
    let repo_name=env::var("GITHUB_REPOSITORY").unwrap_or_default();
    let run=env::var("GITHUB_RUN_ID").unwrap_or_default();
    let attempt=env::var("GITHUB_RUN_ATTEMPT").unwrap_or_default();
    let runner=env::var("RUNNER_NAME").unwrap_or_default();
    if repo_name.is_empty()||run.is_empty()||attempt.is_empty()||runner.is_empty(){return Err("must run inside a GitHub Actions job with repository/run/runner identity".into());}
    Ok(format!("{{\"schema\":\"oreslang-exact-head-evidence-v1\",\"repository\":\"{}\",\"run_id\":\"{}\",\"run_attempt\":\"{}\",\"runner_name\":\"{}\",\"expected_commit\":\"{}\",\"observed_commit\":\"{}\",\"observed_tree\":\"{}\",\"manifest_path\":\"{}\",\"manifest_blob_sha\":\"{}\",\"pinned_blob_count\":{},\"classification\":\"{}\",\"guest_receipt_validated\":{}{}}}\n",json_escape(&repo_name),json_escape(&run),json_escape(&attempt),json_escape(&runner),head,actual_head,tree,json_escape(manifest),manifest_sha,pins.len(),class,claim,guest))
}
fn main(){
    let a:Vec<String>=env::args().collect();
    if a.len()!=6&&a.len()!=7{eprintln!("usage: exact-head-evidence <repo> <expected-head> <manifest-path> <manifest-sha> <host-only|source-only|guest-executed> [guest-receipt]");std::process::exit(2);}
    let receipt=a.get(6).map(String::as_str);
    match verify(Path::new(&a[1]),&a[2],&a[3],&a[4],&a[5],receipt){
        Ok(json)=>{let dir=env::var("RUNNER_TEMP").unwrap_or_else(|_|env::temp_dir().to_string_lossy().into_owned());let p=Path::new(&dir).join("oreslang-exact-head-evidence.json");if let Err(e)=fs::write(&p,json){eprintln!("evidence write failed: {e}");std::process::exit(1);}println!("EXACT_HEAD_EVIDENCE_PASS={}",p.display());}
        Err(e)=>{eprintln!("EXACT_HEAD_EVIDENCE_FAIL: {e}");std::process::exit(1);}
    }
}
#[cfg(test)]
mod tests{
 use super::*;use std::path::PathBuf;use std::sync::atomic::{AtomicU64,Ordering};static N:AtomicU64=AtomicU64::new(1);
 struct R(PathBuf);
 impl R{
  fn new()->Self{let p=env::temp_dir().join(format!("exact-head-{}-{}",std::process::id(),N.fetch_add(1,Ordering::Relaxed)));fs::create_dir_all(&p).unwrap();git(&p,&["init","-q"]).unwrap();git(&p,&["config","user.email","ci@example.invalid"]).unwrap();git(&p,&["config","user.name","CI"]).unwrap();fs::write(p.join("fixture.txt"),"fixture\n").unwrap();let sha=git(&p,&["hash-object","fixture.txt"]).unwrap();fs::write(p.join("manifest.tsv"),format!("{sha}\tfixture.txt\n")).unwrap();git(&p,&["add","."]).unwrap();git(&p,&["commit","-qm","fixture"]).unwrap();Self(p)}
  fn head(&self)->String{git(&self.0,&["rev-parse","HEAD"]).unwrap()}fn tree(&self)->String{git(&self.0,&["rev-parse","HEAD^{tree}"]).unwrap()}fn msha(&self)->String{git(&self.0,&["rev-parse","HEAD:manifest.tsv"]).unwrap()}
  fn receipt(&self)->PathBuf{let p=env::temp_dir().join(format!("exact-head-receipt-{}-{}",std::process::id(),N.fetch_add(1,Ordering::Relaxed)));fs::write(&p,format!("schema=oreslang-guest-execution-receipt-v1\nsource_commit={}\nsource_tree={}\ncompiler_source_commit={}\ncompiler_source_tree={}\ncompiler_sha256={}\nwasm_sha256={}\nexecuted_cases=5\nrejected_cases=1\n",self.head(),self.tree(),"a".repeat(40),"b".repeat(40),"c".repeat(64),"d".repeat(64))).unwrap();p}
 }
 impl Drop for R{fn drop(&mut self){let _=fs::remove_dir_all(&self.0);}}
 #[test]fn exact_head_and_blob_manifest_pass(){let r=R::new();let x=verify(&r.0,&r.head(),"manifest.tsv",&r.msha(),"source-only",None).unwrap();assert!(x.contains("\"classification\":\"source-only\""));assert!(x.contains("\"pinned_blob_count\":1"));}
 #[test]fn wrong_commit_is_rejected(){let r=R::new();assert!(verify(&r.0,&"0".repeat(40),"manifest.tsv",&r.msha(),"source-only",None).unwrap_err().contains("commit mismatch"));}
 #[test]fn unpinned_manifest_is_rejected(){let r=R::new();assert!(verify(&r.0,&r.head(),"manifest.tsv",&"0".repeat(40),"source-only",None).unwrap_err().contains("manifest itself"));}
 #[test]fn wrong_pinned_blob_is_rejected(){let r=R::new();fs::write(r.0.join("manifest.tsv"),format!("{}\tfixture.txt\n","0".repeat(40))).unwrap();git(&r.0,&["add","manifest.tsv"]).unwrap();git(&r.0,&["commit","-qm","tamper pin"]).unwrap();assert!(verify(&r.0,&r.head(),"manifest.tsv",&r.msha(),"source-only",None).unwrap_err().contains("blob mismatch"));}
 #[test]fn duplicate_and_traversal_paths_fail(){let r=R::new();for v in ["../x","/tmp/x","x/../../z"]{fs::write(r.0.join("manifest.tsv"),format!("{}\t{v}\n","0".repeat(40))).unwrap();git(&r.0,&["add","manifest.tsv"]).unwrap();git(&r.0,&["commit","-qm","bad path"]).unwrap();assert!(verify(&r.0,&r.head(),"manifest.tsv",&r.msha(),"source-only",None).is_err());}}
 #[test]fn guest_class_requires_pinned_runtime_receipt(){let r=R::new();assert!(verify(&r.0,&r.head(),"manifest.tsv",&r.msha(),"guest-executed",None).is_err());let p=r.receipt();let x=verify(&r.0,&r.head(),"manifest.tsv",&r.msha(),"guest-executed",Some(p.to_str().unwrap())).unwrap();assert!(x.contains("\"guest_receipt_validated\":true"));assert!(x.contains("\"executed_cases\":5"));let _=fs::remove_file(p);}
 #[test]fn guest_receipt_must_bind_same_checkout(){let r=R::new();let p=r.receipt();let s=fs::read_to_string(&p).unwrap().replace(&r.head(),&"0".repeat(40));fs::write(&p,s).unwrap();assert!(verify(&r.0,&r.head(),"manifest.tsv",&r.msha(),"guest-executed",Some(p.to_str().unwrap())).unwrap_err().contains("does not bind"));let _=fs::remove_file(p);}
 #[test]fn host_source_classes_cannot_claim_guest(){let r=R::new();let p=r.receipt();assert!(verify(&r.0,&r.head(),"manifest.tsv",&r.msha(),"host-only",Some(p.to_str().unwrap())).is_err());assert!(verify(&r.0,&r.head(),"manifest.tsv",&r.msha(),"unknown",None).is_err());}
}
