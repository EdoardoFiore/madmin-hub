"""
Ubuntu's own verdict on a CVE, from the Canonical VEX documents (one per CVE,
https://github.com/canonical/ubuntu-security-notices/tree/main/vex/cve).

OSV says only "affected, no fixed version" for everything Ubuntu has not
fixed yet, which mixes very different cases. The VEX statements carry the
Ubuntu CVE tracker status of each source package in each release:

    fixed         a fixed version is published (version = the fixed one)
    pending       the fix is prepared and about to be published (kernels: the next SRU)
    needed        affected, no fix yet
    triage        not evaluated yet by the Ubuntu Security Team
    deferred      affected, fix postponed
    ignored       affected, Ubuntu decided not to fix it
    eol           the package is no longer supported in this release
    not-affected  the code is not present / not used in this build
    esm           fixed only in Ubuntu Pro (esm-infra / esm-apps)

The manager adds two of its own:

    release       a Python package of the MADMIN venv with a fixed version on
                  PyPI: fixed by a MADMIN release with the newer package, not
                  by the OS updates of the instance
    stale         Ubuntu assessed an older version than the installed one: the
                  data lag behind a security update (the finding is probably fixed)

Both OSV and VEX lag a few days behind the tracker: a 'fixed' version that is
not newer than the installed one drops the finding.

Pure functions only: fetching and caching are in osv.py.
"""
import re
from typing import Dict, List, Optional, Tuple

VEX_URL = "https://raw.githubusercontent.com/canonical/ubuntu-security-notices/main/vex/cve/{year}/{cve}.json"

# os_id version -> codename used in the VEX purls (distro=<codename>)
CODENAMES = {
    "18.04": "bionic", "20.04": "focal", "22.04": "jammy", "24.04": "noble",
    "24.10": "oracular", "25.04": "plucky", "25.10": "questing", "26.04": "resolute",
}

# Order of the statuses of a finding ("" = no Ubuntu data, e.g. Python packages).
# not-affected never reaches a finding.
STATUSES = ("fixed", "release", "pending", "stale", "needed", "triage", "deferred", "esm", "ignored", "eol", "")

_PURL_RE = re.compile(r"^pkg:deb/ubuntu/([^@]+)@([^?]+)\?arch=source&distro=(?:(esm-infra|esm-apps)/)?([a-z]+)$")
_CVE_RE = re.compile(r"^CVE-(\d{4})-\d+$")


def codename(os_id: str) -> Optional[str]:
    """ubuntu-24.04 -> noble."""
    if not os_id.startswith("ubuntu-"):
        return None
    return CODENAMES.get(".".join(os_id[len("ubuntu-"):].split(".")[:2]))


def vex_url(cve: str) -> Optional[str]:
    m = _CVE_RE.match(cve)
    return VEX_URL.format(year=m.group(1), cve=cve) if m else None


def _status(statement: dict) -> str:
    status = statement.get("status", "")
    text = (statement.get("action_statement") or statement.get("status_notes") or "").lower()
    if status == "not_affected":
        return "not-affected"
    if status == "fixed":
        return "fixed"
    if status == "affected":
        if "decided to not fix" in text:
            return "ignored"
        if "actively worked on" in text:
            return "pending"
        if "no longer supported" in text:
            return "eol"
        return "needed"
    if status == "under_investigation":
        return "deferred" if "deferred" in text else "triage"
    return ""


def parse(doc: dict) -> Dict[str, Dict[str, List[str]]]:
    """{codename: {source package: [status, version]}} for the releases in
    CODENAMES. The version is the fixed one for 'fixed'/'esm', otherwise the
    version Ubuntu assessed. A Pro-only fix counts only when the normal
    archive has no statement for the package."""
    wanted = set(CODENAMES.values())
    main: Dict[str, Dict[str, List[str]]] = {}
    pro: Dict[str, Dict[str, List[str]]] = {}
    for st in doc.get("statements") or []:
        status = _status(st)
        if not status:
            continue
        for product in st.get("products") or []:
            m = _PURL_RE.match(str(product.get("@id", "")))
            if not m or m.group(4) not in wanted:
                continue
            name, version, esm, rel = m.groups()
            if esm:
                pro.setdefault(rel, {})[name] = ["esm" if status == "fixed" else status, version]
            else:
                main.setdefault(rel, {})[name] = [status, version]
    for rel, pkgs in pro.items():
        for name, value in pkgs.items():
            main.setdefault(rel, {}).setdefault(name, value)
    return main


_HWE_RE = re.compile(r"^linux-hwe-(\d+)\.(\d+)$")


def kernel_alternative(statuses: Dict[str, List[str]], source: str) -> Optional[Tuple[str, str, str]]:
    """For a finding on the GA kernel ('linux'): the newest HWE kernel series
    of the same release, as (source, status, version), when the CVE is already
    fixed there or does not affect it. Older HWE series are not suggested
    (they reach end of life when the next one is published)."""
    if source != "linux":
        return None
    hwe = [((int(m.group(1)), int(m.group(2))), name) for name in statuses if (m := _HWE_RE.match(name))]
    if not hwe:
        return None
    name = max(hwe)[1]
    status, version = statuses[name]
    return (name, status, version) if status in ("fixed", "not-affected") else None


# --- Debian version comparison (dpkg semantics) ---

_EPOCH_RE = re.compile(r"^(\d+):")


def _split(version: str) -> Tuple[int, str, str]:
    epoch = 0
    m = _EPOCH_RE.match(version)
    if m:
        epoch, version = int(m.group(1)), version[m.end():]
    upstream, _, revision = version.rpartition("-") if "-" in version else (version, "", "0")
    return epoch, upstream, revision or "0"


def _order(c: str) -> int:
    if c == "~":
        return -1
    if c.isdigit():
        return 0
    if c.isalpha():
        return ord(c)
    return ord(c) + 256


def _cmp_part(a: str, b: str) -> int:
    """dpkg's verrevcmp: alternating non-digit runs (~ before everything,
    letters before other symbols) and numeric runs."""
    i = j = 0
    while i < len(a) or j < len(b):
        while (i < len(a) and not a[i].isdigit()) or (j < len(b) and not b[j].isdigit()):
            ac = _order(a[i]) if i < len(a) else 0
            bc = _order(b[j]) if j < len(b) else 0
            if ac != bc:
                return -1 if ac < bc else 1
            i += 1
            j += 1
        si = i
        while i < len(a) and a[i].isdigit():
            i += 1
        sj = j
        while j < len(b) and b[j].isdigit():
            j += 1
        na, nb = int(a[si:i] or 0), int(b[sj:j] or 0)
        if na != nb:
            return -1 if na < nb else 1
    return 0


def compare(a: str, b: str) -> int:
    """dpkg --compare-versions: -1, 0, 1."""
    ea, ua, ra = _split(a)
    eb, ub, rb = _split(b)
    if ea != eb:
        return -1 if ea < eb else 1
    return _cmp_part(ua, ub) or _cmp_part(ra, rb)
