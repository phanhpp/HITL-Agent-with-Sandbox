"""`_contained` is the sandbox's security boundary. These are its rules, pinned.

`filePath` arrives from the browser, so it is attacker-controlled. Everything that
reaches a shell is `shlex.quote`d as well, but quoting is the second line — this is the
first, and it had been verified by hand exactly once before these tests existed.
"""

import pytest

from routes.sandbox_files import WORKDIR, _contained


@pytest.mark.parametrize(
    "path",
    [
        WORKDIR,
        f"{WORKDIR}/src/router.js",
        f"{WORKDIR}/a/b/c.txt",
        # A dotfile is not a traversal attempt.
        f"{WORKDIR}/.gitignore",
        # "..": only a whole segment is a traversal; a filename may contain dots.
        f"{WORKDIR}/..hidden",
        f"{WORKDIR}/file..txt",
    ],
)
def test_accepts_paths_inside_the_workspace(path):
    assert _contained(path) == path


@pytest.mark.parametrize(
    ("path", "why"),
    [
        ("/etc/passwd", "absolute, outside the workspace"),
        ("/etc/shadow", "absolute, outside the workspace"),
        (f"{WORKDIR}/../etc/passwd", "escapes via a .. segment"),
        (f"{WORKDIR}/a/../../etc", "escapes via nested .. segments"),
        ("..", "bare traversal"),
        ("src/router.js", "relative"),
        ("", "empty"),
        # Prefix match must not be enough: /workspace-evil is not inside /workspace.
        (f"{WORKDIR}-evil/x", "sibling directory sharing the prefix"),
        (f"{WORKDIR}evil", "no separator after the workspace prefix"),
    ],
)
def test_rejects_paths_outside_the_workspace(path, why):
    assert _contained(path) is None, why


def test_rejects_a_nul_byte():
    """A real NUL byte, not the literal text backslash-x-0-0.

    This failed when written: the guard read `"\\\\x00" in path`, which is the
    four-character sequence, so an actual NUL passed straight through and the literal
    text was rejected instead — exactly backwards.
    """
    assert _contained(f"{WORKDIR}/a\x00b") is None


def test_shell_injection_is_contained_textually():
    """A path carrying a second command is *accepted* here, and that is correct.

    Containment is a textual check; it has no opinion on shell metacharacters. The
    defence is `shlex.quote` at the call site, which turns this into one filename that
    does not exist. Pinned so nobody "fixes" one layer by weakening the other.
    """
    injected = f"{WORKDIR}/x; cat /etc/passwd"
    assert _contained(injected) == injected
