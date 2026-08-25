# Shared dependency check — sourced by all linear-cli wrapper scripts
if ! command -v linear-cli &>/dev/null; then
  echo "ERROR: linear-cli is not installed." >&2
  echo "Install it with: cargo install linear-cli" >&2
  echo "If cargo is not available, install Rust first: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh" >&2
  echo "After installing, authenticate with: linear-cli auth" >&2
  exit 1
fi
