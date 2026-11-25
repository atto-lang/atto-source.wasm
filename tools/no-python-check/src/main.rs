use std::{
    env, fs,
    path::Path,
    process::{self, Command},
};

fn forbidden_path(path: &str) -> bool {
    let p = path.to_ascii_lowercase();
    let file = p.rsplit('/').next().unwrap_or(&p);
    p.ends_with(".py")
        || p.ends_with(".pyi")
        || p.ends_with(".pyw")
        || p.ends_with(".ipynb")
        || file == "pipfile"
        || file == "pipfile.lock"
        || file == "poetry.lock"
        || file == "pyproject.toml"
        || file == "uv.lock"
        || file == "setup.py"
        || file == "tox.ini"
        || file == ".python-version"
        || file == "pdm.lock"
        || (file.starts_with("requirements") && file.ends_with(".txt"))
}

fn is_execution_surface(path: &str) -> bool {
    let p = path.to_ascii_lowercase();
    let file = p.rsplit('/').next().unwrap_or(&p);
    (p.starts_with(".github/workflows/") && (p.ends_with(".yaml") || p.ends_with(".yml")))
        || (p.starts_with(".github/actions/") && (p.ends_with(".yaml") || p.ends_with(".yml")))
        || file == "makefile"
        || file == "justfile"
        || p.ends_with(".sh")
        || p.ends_with(".bash")
        || p.ends_with(".zsh")
}

fn forbidden_execution_line(line: &str) -> bool {
    let l = line.trim().to_ascii_lowercase();
    if l.starts_with('#') {
        return false;
    }
    [
        "actions/setup-python@",
        "python -m ",
        "python3 -m ",
        "python -c ",
        "python3 -c ",
        "python ",
        "python2 ",
        "python3 ",
        "python2.",
        "python3.",
        "pypy ",
        "pypy3 ",
        "pip ",
        "pip3 ",
        "pipenv ",
        "uv run ",
        "uv pip ",
        "pytest ",
        "poetry run ",
        "pdm run ",
    ]
    .iter()
    .any(|needle| l.contains(needle))
}

fn python_shebang(body: &str) -> bool {
    let first = body
        .lines()
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    first.starts_with("#!")
        && (first.contains("/python")
            || first.contains("env python")
            || first.contains("env -s python")
            || first.contains("/pypy")
            || first.contains("env pypy"))
}

fn violations(path: &str, body: &str) -> Vec<String> {
    let mut messages = Vec::new();
    if forbidden_path(path) {
        messages
            .push("Python source, notebook, dependency manifest, or environment file".to_string());
    }
    if python_shebang(body) {
        messages.push("Python/PyPy shebang".to_string());
    }
    if is_execution_surface(path) {
        for (index, line) in body.lines().enumerate() {
            if forbidden_execution_line(line) {
                messages.push(format!("Python tooling invocation at line {}", index + 1));
            }
        }
    }
    messages
}

// An unreadable or symlinked execution surface cannot be certified Python-free.
// Non-executable binary assets still receive their path-only policy checks.
fn read_policy_body(file: &Path, execution_surface: bool) -> Result<String, String> {
    let meta = fs::symlink_metadata(file)
        .map_err(|e| format!("cannot inspect tracked path: {e}"))?;
    if meta.file_type().is_symlink() {
        if execution_surface {
            return Err("tracked execution surface must not be a symlink".to_string());
        }
        return Ok(String::new());
    }
    if execution_surface && !meta.is_file() {
        return Err("tracked execution surface must be a regular file".to_string());
    }
    match fs::read_to_string(file) {
        Ok(body) => Ok(body),
        Err(e) if execution_surface => Err(format!("cannot inspect execution surface as UTF-8: {e}")),
        Err(_) => Ok(String::new()),
    }
}

fn main() {
    let root = env::args().nth(1).unwrap_or_else(|| ".".to_string());
    let output = Command::new("git")
        .args(["-C", &root, "ls-files", "-z"])
        .output()
        .expect("git must be installed");
    if !output.status.success() {
        eprintln!("git ls-files failed");
        process::exit(2);
    }

    let mut found = 0usize;
    for raw in output
        .stdout
        .split(|byte| *byte == 0)
        .filter(|v| !v.is_empty())
    {
        let name = String::from_utf8_lossy(raw);
        let file = Path::new(&root).join(name.as_ref());

        // Only non-execution binary assets may skip content inspection.
        // Never certify unreadable/symlinked workflow or shell sources as clean.
        let body = match read_policy_body(&file, is_execution_surface(&name)) {
            Ok(body) => body,
            Err(e) => {
                eprintln!("{name}: {e}");
                found += 1;
                continue;
            }
        };
        for problem in violations(&name, &body) {
            eprintln!("{name}: {problem}");
            found += 1;
        }
    }

    if found > 0 {
        eprintln!("{found} Python policy violation(s)");
        process::exit(1);
    }
    println!("Rust-only tooling policy check passed");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_python_assets_and_manifests() {
        for path in [
            "tool/doit.py",
            "tool/doit.pyw",
            "types/x.pyi",
            "tests/a.ipynb",
            "pyproject.toml",
            "requirements-dev.txt",
            "Pipfile.lock",
            ".python-version",
            "tox.ini",
        ] {
            assert!(forbidden_path(path), "must reject {path}");
        }
        assert!(!forbidden_path("README.md"));
        assert!(!forbidden_path("src/main.rs"));
    }

    #[test]
    fn recognizes_execution_surfaces() {
        assert!(is_execution_surface(".github/workflows/ci.yml"));
        assert!(is_execution_surface(".github/actions/check/action.yaml"));
        assert!(is_execution_surface("scripts/check.sh"));
        assert!(is_execution_surface("Makefile"));
        assert!(is_execution_surface("justfile"));
        assert!(!is_execution_surface("docs/policy.md"));
    }

    #[test]
    fn blocks_python_ci_invocations() {
        assert!(forbidden_execution_line("- uses: actions/setup-python@v5"));
        assert!(forbidden_execution_line("- run: python3 -m pytest"));
        assert!(forbidden_execution_line("pip install -r requirements.txt"));
        assert!(forbidden_execution_line("uv run tool.py"));
        assert!(forbidden_execution_line("- run: pip3 --version"));
        assert!(forbidden_execution_line("- run: pipenv run tool"));
        assert!(forbidden_execution_line("- run: python3.12 -m unittest"));
        assert!(forbidden_execution_line("- run: python2 -c 'print(1)'"));
        assert!(forbidden_execution_line("uv pip install foo"));
        assert!(!forbidden_execution_line("- run: cargo test"));
    }

    #[test]
    fn blocks_extensionless_python_scripts() {
        assert!(python_shebang("#!/usr/bin/env python3\nprint('x')"));
        assert!(python_shebang("#!/usr/bin/python\nprint('x')"));
        assert!(python_shebang("#!/usr/bin/env pypy3\nprint('x')"));
        assert!(!python_shebang("#!/usr/bin/env bash\necho ok"));
    }


    #[test]
    fn unreadable_or_invalid_utf8_execution_surface_fails_closed() {
        let absent = std::env::temp_dir().join(format!(
            "no-python-absent-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
                .unwrap().as_nanos()
        ));
        assert!(read_policy_body(&absent, true).is_err());
        let path = absent.with_extension("sh");
        fs::write(&path, [0xff]).unwrap();
        assert!(read_policy_body(&path, true).is_err());
        assert!(read_policy_body(&path, false).is_ok());
        fs::remove_file(path).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_execution_surface_fails_closed() {
        use std::os::unix::fs::symlink;
        let path = std::env::temp_dir().join(format!(
            "no-python-link-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
                .unwrap().as_nanos()
        ));
        let target = path.with_extension("target");
        fs::write(&target, b"#!/usr/bin/env python3\n").unwrap();
        symlink(&target, &path).unwrap();
        let rejected = read_policy_body(&path, true);
        assert!(rejected.is_err());
        assert!(rejected.unwrap_err().contains("symlink"));
        fs::remove_file(path).unwrap();
        fs::remove_file(target).unwrap();
    }

    #[test]
    fn prose_is_not_treated_as_execution() {
        let body = "Python is prohibited; replace Python tooling with Rust.";
        assert!(violations("README.md", body).is_empty());
    }
}
