//! The only native artifact/source-file read entry point.
//! Fail closed on symlinks, FIFOs, sockets and concurrent replacement.
#[cfg(not(unix))]
compile_error!("AOT host currently requires Unix O_NOFOLLOW/O_NONBLOCK file opens");
use std::{error::Error,fs::OpenOptions,io::Read};
#[cfg(unix)]
use std::os::unix::fs::{MetadataExt,OpenOptionsExt};
pub fn bounded_regular_file(path:&str,max:u64)->Result<Vec<u8>,Box<dyn Error>>{
 let mut options=OpenOptions::new();
 options.read(true).custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC);
 let file=options.open(path)?;
 let before=file.metadata()?;
 if !before.is_file() || before.len()>max{
  return Err("input must be a bounded regular file".into());
 }
 // The opened handle, not the mutable pathname, is the only read source.
 let mut reader=file.take(max+1);
 let mut bytes=Vec::with_capacity(before.len() as usize);
 reader.read_to_end(&mut bytes)?;
 let after=reader.into_inner().metadata()?;
 if bytes.len() as u64!=before.len() || after.len()!=before.len() ||
   after.dev()!=before.dev() || after.ino()!=before.ino() ||
   after.mtime()!=before.mtime() || after.mtime_nsec()!=before.mtime_nsec() ||
   after.ctime()!=before.ctime() || after.ctime_nsec()!=before.ctime_nsec(){
  return Err("input changed during bounded snapshot".into());
 }
 Ok(bytes)
}
