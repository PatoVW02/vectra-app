use std::env;
use std::fs::{self, Metadata};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

fn write_line(stdout: &mut io::BufWriter<io::StdoutLock<'_>>, size_bytes: u64, is_dir: bool, path: &Path) {
    let kind = if is_dir { "d" } else { "f" };
    let _ = writeln!(stdout, "{}\t{}\t{}", size_bytes, kind, path.display());
}

fn file_size(metadata: &Metadata) -> u64 {
    metadata.len()
}

fn walk_dir(path: &Path, root: &Path, stdout: &mut io::BufWriter<io::StdoutLock<'_>>) -> u64 {
    let mut total = 0u64;

    let entries = match fs::read_dir(path) {
        Ok(entries) => entries,
        Err(_) => return 0,
    };

    for entry_result in entries {
        let entry = match entry_result {
            Ok(entry) => entry,
            Err(_) => continue,
        };

        let child_path: PathBuf = entry.path();
        let metadata = match fs::symlink_metadata(&child_path) {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };

        let file_type = metadata.file_type();
        if file_type.is_symlink() {
            continue;
        }

        if metadata.is_dir() {
            let dir_size = walk_dir(&child_path, root, stdout);
            total = total.saturating_add(dir_size);
            if child_path != root {
              write_line(stdout, dir_size, true, &child_path);
            }
        } else if metadata.is_file() {
            let size = file_size(&metadata);
            total = total.saturating_add(size);
            if child_path != root {
              write_line(stdout, size, false, &child_path);
            }
        }
    }

    total
}

fn main() {
    let target = match env::args().nth(1) {
        Some(path) => PathBuf::from(path),
        None => {
            eprintln!("Usage: scanner-bin <path>");
            std::process::exit(1);
        }
    };

    let metadata = match fs::symlink_metadata(&target) {
        Ok(metadata) => metadata,
        Err(err) => {
            eprintln!("Could not access scan root {}: {}", target.display(), err);
            std::process::exit(2);
        }
    };

    if !metadata.is_dir() {
        eprintln!("Scan root is not a directory: {}", target.display());
        std::process::exit(2);
    }

    if let Err(err) = fs::read_dir(&target) {
        eprintln!("Could not read scan root {}: {}", target.display(), err);
        std::process::exit(2);
    }

    let stdout = io::stdout();
    let mut writer = io::BufWriter::new(stdout.lock());
    let _ = walk_dir(&target, &target, &mut writer);
    let _ = writer.flush();
}
