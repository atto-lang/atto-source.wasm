//! Publish a complete trusted native module with no overwrite and no
//! partially written final pathname. Caller must select a trusted directory.
use std::{error::Error,fs::File,io::Write,path::Path};
use tempfile::NamedTempFile;

pub fn publish_no_clobber(output:&str, code:&[u8]) -> Result<(),Box<dyn Error>> {
 let path=Path::new(output);
 let parent=path.parent()
  .filter(|p| !p.as_os_str().is_empty())
  .unwrap_or_else(||Path::new("."));
 // tempfile creates randomized, owner-only temporary files in the same
 // filesystem, and removes a staging file on an ordinary error path.
 let mut staged=NamedTempFile::new_in(parent)?;
 staged.write_all(code)?;
 staged.as_file().sync_all()?;
 // Atomic no-overwrite final-name publication on supported Unix filesystems.
 // On a crash the private staging name might remain; the final name only
 // appears AFTER a completed, synced write. No rename-over-existing races.
 let final_file=staged.persist_noclobber(path)?;
 final_file.sync_all()?;
 File::open(parent)?.sync_all()?;
 Ok(())
}

#[cfg(test)]
mod tests {
 use super::*;
 use std::fs;
 #[test]
 fn successful_publication_and_existing_path_denial() {
  let dir=tempfile::tempdir().unwrap();
  let path=dir.path().join("guest.cwasm");
  let name=path.to_str().unwrap();
  publish_no_clobber(name,b"verified-native-payload").unwrap();
  assert_eq!(fs::read(&path).unwrap(),b"verified-native-payload");
  assert!(publish_no_clobber(name,b"second-payload").is_err());
  assert_eq!(fs::read(&path).unwrap(),b"verified-native-payload");
 }
 #[cfg(unix)]
 #[test]
 fn never_follow_a_symlinked_destination() {
  use std::os::unix::fs::symlink;
  let dir=tempfile::tempdir().unwrap();
  let target=dir.path().join("protected");
  fs::write(&target,b"protected").unwrap();
  let link=dir.path().join("guest.cwasm");
  symlink(&target,&link).unwrap();
  assert!(publish_no_clobber(link.to_str().unwrap(),b"bad").is_err());
  assert_eq!(fs::read(&target).unwrap(),b"protected");
  assert!(fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
 }
}
