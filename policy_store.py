"""User-owned, versioned browser policy shared by native hosts and agent CLIs."""
import contextlib
import hashlib
import json
import os
import re
from pathlib import Path
import tempfile
from urllib.parse import urlsplit

DEFAULT_PREFERENCES = {"background": True, "showCursor": True}
MAX_BYTES = 65536
MAX_SITES = 200
PROTECTED_HOSTS = json.loads((Path(__file__).parent / "extension/protected-hosts.json").read_text())


def default_path():
    override = os.environ.get("MEHTAGENT_BROWSER_POLICY")
    if override:
        return Path(override).expanduser().absolute()
    if os.environ.get("XDG_CONFIG_HOME"):
        base = Path(os.environ["XDG_CONFIG_HOME"])
    elif os.name == "nt":
        base = Path(os.environ.get("APPDATA", Path.home() / "AppData/Roaming"))
    else:
        base = Path.home() / ".config"
    return base / "mehtagent" / "browser-policy.json"


def origin(value):
    if not isinstance(value, str) or not value or len(value) > 2048 or any(ord(c) <= 32 or ord(c) == 127 for c in value):
        raise ValueError("Each site must be an exact HTTPS origin")
    parsed = urlsplit(value)
    host = parsed.hostname
    if not host or "*" in host or host.endswith(".") or parsed.username or parsed.password:
        raise ValueError("Wildcard, credential and trailing-dot origins are not allowed")
    if parsed.scheme != "https" and not (parsed.scheme == "http" and host in ("localhost", "127.0.0.1")):
        raise ValueError("Use HTTPS, or HTTP localhost for testing")
    if parsed.path or parsed.query or parsed.fragment:
        raise ValueError("Policy sites must be origins without paths, queries or fragments")
    host = host.encode("idna").decode("ascii")
    if ":" in host:
        host = "[" + host + "]"
    port = parsed.port
    suffix = ":" + str(port) if port is not None and port != (443 if parsed.scheme == "https" else 80) else ""
    normalized = parsed.scheme + "://" + host + suffix
    if normalized != value:
        raise ValueError("Use the canonical lower-case origin without a default port")
    return value


def validate(document):
    if not isinstance(document, dict) or set(document) - {"version", "sites", "preferences"}:
        raise ValueError("Unknown policy fields")
    if type(document.get("version")) is not int or document["version"] != 1:
        raise ValueError("Unsupported policy version; expected 1")
    sites = document.get("sites")
    if not isinstance(sites, dict) or len(sites) > MAX_SITES:
        raise ValueError("Policy must contain at most 200 exact sites")
    for site, mode in sites.items():
        origin(site)
        if mode not in ("allow", "ask", "block"):
            raise ValueError("Site access must be allow, ask or block")
        host = urlsplit(site).hostname
        if mode != "block" and (any(host == h or host.endswith("." + h) for h in PROTECTED_HOSTS)
                                or re.search(r"(^|[.-])(bank|banking|payment|payments|checkout)([.-]|$)", host, re.I)):
            raise ValueError("Banking, payment and account-security origins must stay blocked")
    preferences = document.get("preferences", {})
    if not isinstance(preferences, dict) or set(preferences) - set(DEFAULT_PREFERENCES):
        raise ValueError("Unknown policy preferences")
    if any(type(v) is not bool for v in preferences.values()):
        raise ValueError("Policy preferences must be booleans")
    return {"version": 1, "sites": dict(sorted(sites.items())),
            "preferences": {**DEFAULT_PREFERENCES, **preferences}}


def _unique_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate policy field")
        result[key] = value
    return result


def decode(data):
    if len(data) > MAX_BYTES:
        raise ValueError("Policy exceeds 64 KB")
    return validate(json.loads(data, object_pairs_hook=_unique_pairs))


def revision(document):
    return hashlib.sha256(json.dumps(document, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def _check_file(path):
    if path.is_symlink():
        raise PermissionError("Policy file must not be a symbolic link")
    if path.exists() and hasattr(os, "getuid") and path.stat().st_uid != os.getuid():
        raise PermissionError("Policy file must be owned by the current user")


def snapshot(path):
    path = Path(path)
    _check_file(path)
    if not path.exists():
        return {"path": str(path), "policy": None, "revision": None}
    with path.open("rb") as stream:
        data = stream.read(MAX_BYTES + 1)
    document = decode(data)
    return {"path": str(path), "policy": document, "revision": revision(document)}


@contextlib.contextmanager
def _locked(path):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock = path.with_name(path.name + ".lock")
    _check_file(lock)
    flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(lock, flags, 0o600)
    try:
        if os.name == "nt":
            import msvcrt
            if os.fstat(fd).st_size == 0:
                os.write(fd, b"\0")
            os.lseek(fd, 0, os.SEEK_SET)
            msvcrt.locking(fd, msvcrt.LK_LOCK, 1)
        else:
            import fcntl
            fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        os.close(fd)


def update(path, expected_revision, operation):
    """Compare-and-swap one UI edit. An obsolete profile cannot overwrite another."""
    path = Path(path)
    with _locked(path):
        current = snapshot(path)
        if current["revision"] != expected_revision:
            raise ValueError("Local policy changed; refresh and review before applying")
        if not isinstance(operation, dict) or len(operation) != 1:
            raise ValueError("Choose one policy operation")
        document = current["policy"] or {"version": 1, "sites": {}, "preferences": dict(DEFAULT_PREFERENCES)}
        document = json.loads(json.dumps(document))
        if "migrate" in operation:
            if current["policy"] is not None:
                raise ValueError("Existing policy must not be replaced by migration")
            document = validate(operation["migrate"])
        elif "replace" in operation:
            document = validate(operation["replace"])
        elif "site" in operation:
            site = operation["site"]
            if not isinstance(site, dict) or set(site) != {"origin", "mode"}:
                raise ValueError("Invalid site edit")
            key = origin(site["origin"])
            if site["mode"] is None:
                document["sites"].pop(key, None)
            else:
                document["sites"][key] = site["mode"]
        elif "preferences" in operation:
            if not isinstance(operation["preferences"], dict):
                raise ValueError("Invalid preferences")
            document["preferences"].update(operation["preferences"])
        else:
            raise ValueError("Unknown policy operation")
        document = validate(document)
        data = (json.dumps(document, indent=2, ensure_ascii=False) + "\n").encode()
        if len(data) > MAX_BYTES:
            raise ValueError("Policy exceeds 64 KB")
        _check_file(path)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=path.parent, prefix=".browser-policy-", delete=False) as stream:
                temporary = Path(stream.name)
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            temporary.chmod(0o600)
            os.replace(temporary, path)
        finally:
            if temporary:
                temporary.unlink(missing_ok=True)
        return {"path": str(path), "policy": document, "revision": revision(document)}
