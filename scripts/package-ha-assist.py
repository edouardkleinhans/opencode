"""Build a deterministic companion ZIP for the selected release channel."""

import argparse
import hashlib
import json
from pathlib import Path
import zipfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path, help="Destination ZIP path")
    parser.add_argument("--channel", choices=("stable", "beta"), default="beta")
    args = parser.parse_args()
    addon = "ha_opencode" if args.channel == "stable" else "ha_opencode_beta"
    source = Path(__file__).resolve().parent.parent / addon / "rootfs/opt/opencode-assist/custom_components/opencode_assist"
    manifest = json.loads((source / "manifest.json").read_text())
    if manifest["domain"] != "opencode_assist" or not manifest.get("version"):
        raise ValueError("Invalid companion manifest")
    files = sorted([*source.glob("*.py"), *source.glob("*.json"), *source.glob("translations/*.json"),
                    *source.glob("brand/*.png"), source / "README.md"])
    for path in files:
        if path.is_symlink() or not path.is_file():
            raise ValueError("Companion assets must be ordinary files")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(args.output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path in files:
            info = zipfile.ZipInfo("custom_components/opencode_assist/" + path.relative_to(source).as_posix())
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, path.read_bytes())
    with zipfile.ZipFile(args.output) as archive:
        if archive.testzip() is not None:
            raise ValueError("Invalid companion archive")
    print(f"OpenCode Assist {manifest['version']}: {args.output}")
    print(f"SHA256: {hashlib.sha256(args.output.read_bytes()).hexdigest()}")


if __name__ == "__main__":
    main()
